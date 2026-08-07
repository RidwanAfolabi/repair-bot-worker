/**
 * googleSheets.js — fetch the live price list from Google Sheets
 *
 * Uses a Google service account (JWT Bearer OAuth2 flow — no user consent
 * screen, no refresh token to manage) to read the iFix Express pricing
 * spreadsheet, organized as one tab per brand plus a "Services & Accessories"
 * tab for everything else. Three things are cached in D1 (see db.js
 * getCache/setCache) to avoid re-authenticating and re-fetching on every
 * single customer message:
 *
 *   'google_access_token'        — the OAuth2 access token, ~1hr lifespan.
 *                                   Refreshed when within TOKEN_REFRESH_SKEW
 *                                   seconds of expiry.
 *   'pricing_sheet_tabs'         — the spreadsheet's actual current tab
 *                                   titles (see getSheetTabs) — a new brand
 *                                   tab added later is picked up automatically
 *                                   on the next refresh, no code change needed.
 *   'pricing_sheet_rows_<TAB>'   — one cache entry PER TAB, so asking about
 *                                   Vivo doesn't invalidate or need a fresh
 *                                   fetch for Samsung's already-cached rows.
 *
 * Requires secrets (set via `npx wrangler secret put <NAME>`):
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL — the service account's client_email
 *   GOOGLE_PRIVATE_KEY           — the service account's PEM private key
 *     (real newlines are fine; a literal "\n"-escaped single-line paste is
 *     also handled — see importPrivateKey below)
 *
 * Requires vars (plain, non-sensitive — set in wrangler.jsonc):
 *   GOOGLE_SHEET_ID    — the spreadsheet ID from its URL
 *   (GOOGLE_SHEET_RANGE is no longer used — tabs are fetched by name,
 *   determined dynamically per enquiry by pricing.js's matchBrandTab)
 *
 * The service account must have at least Viewer access to the spreadsheet
 * — share the sheet with GOOGLE_SERVICE_ACCOUNT_EMAIL like any other user.
 */

import { getCache, setCache } from './db.js';
import { rowsFromApiValues } from './pricing.js';

const TOKEN_URL          = 'https://oauth2.googleapis.com/token';
const SCOPE              = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const TOKEN_REFRESH_SKEW = 300; // refresh 5 min before actual expiry
const SHEET_CACHE_TTL    = 300; // re-fetch sheet at most every 5 minutes


// ─────────────────────────────────────────────────────────────────────────────
// getSheetTabs — cached list of the spreadsheet's ACTUAL current tab titles.
// This is what pricing.js's matchBrandTab fuzzy-matches a customer's message
// against — not a hardcoded brand list — so a new brand tab added to the
// spreadsheet later just works on the next cache refresh, no code change.
// ─────────────────────────────────────────────────────────────────────────────
export async function getSheetTabs(env) {
  const cacheKey = 'pricing_sheet_tabs';
  const cached = await getCache(env.DB, cacheKey);
  const nowSeconds = Math.floor(Date.now() / 1000);

  if (cached && (nowSeconds - cached.cachedAt) < SHEET_CACHE_TTL) {
    return JSON.parse(cached.value);
  }

  try {
    const accessToken = await getAccessToken(env);
    const titles = await fetchSheetTabTitles(env, accessToken);

    await setCache(env.DB, cacheKey, JSON.stringify(titles));
    console.log(`[GoogleSheets] ✅ Fetched ${titles.length} worksheet tab(s): ${titles.join(', ')}`);
    return titles;
  } catch (err) {
    console.error('[GoogleSheets] Tab list fetch failed:', err.message);

    if (cached) {
      console.log('[GoogleSheets] Falling back to stale cached tab list');
      return JSON.parse(cached.value);
    }

    return [];
  }
}

async function fetchSheetTabTitles(env, accessToken) {
  const sheetId = env.GOOGLE_SHEET_ID;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties.title`;

  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Google Sheets API (tab list) ${response.status}: ${err}`);
  }

  const data = await response.json();
  return (data.sheets ?? []).map(s => s.properties?.title).filter(Boolean);
}


// ─────────────────────────────────────────────────────────────────────────────
// getPricingRows — cached, end-to-end: auth + fetch + parse, for ONE tab
//
// Cache key includes the tab name, so asking about Vivo doesn't invalidate
// or need a fresh fetch for Samsung's already-cached rows — each brand (and
// the Services & Accessories fallback) refreshes independently.
//
// Never throws — any failure (auth, network, malformed response) falls back
// to the last cached rows if any exist, or an empty array if not. Callers
// should treat [] as "no live pricing data available right now," not a crash.
// ─────────────────────────────────────────────────────────────────────────────
export async function getPricingRows(env, tabName) {
  const cacheKey = `pricing_sheet_rows_${cacheKeySafe(tabName)}`;
  const cached = await getCache(env.DB, cacheKey);
  const nowSeconds = Math.floor(Date.now() / 1000);

  if (cached && (nowSeconds - cached.cachedAt) < SHEET_CACHE_TTL) {
    return JSON.parse(cached.value);
  }

  try {
    const accessToken = await getAccessToken(env);
    const values = await fetchSheetValues(env, accessToken, tabName);
    const rows = rowsFromApiValues(values);

    await setCache(env.DB, cacheKey, JSON.stringify(rows));
    console.log(`[GoogleSheets] ✅ Fetched ${rows.length} row(s) from "${tabName}"`);
    return rows;
  } catch (err) {
    console.error(`[GoogleSheets] Fetch failed for tab "${tabName}":`, err.message);

    if (cached) {
      console.log('[GoogleSheets] Falling back to stale cached pricing data');
      return JSON.parse(cached.value);
    }

    return [];
  }
}

function cacheKeySafe(tabName) {
  return (tabName ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '_');
}


// ─────────────────────────────────────────────────────────────────────────────
// getAccessToken — cached OAuth2 access token via the JWT Bearer flow
// ─────────────────────────────────────────────────────────────────────────────
async function getAccessToken(env) {
  const cached = await getCache(env.DB, 'google_access_token');
  const nowSeconds = Math.floor(Date.now() / 1000);

  if (cached) {
    const { token, expiresAt } = JSON.parse(cached.value);
    if (nowSeconds < expiresAt - TOKEN_REFRESH_SKEW) {
      return token;
    }
  }

  const jwt = await buildSignedJwt(env);

  const response = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion:  jwt,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Google OAuth2 token exchange ${response.status}: ${err}`);
  }

  const data = await response.json();
  if (!data.access_token) {
    throw new Error('Google OAuth2 response had no access_token');
  }

  const expiresAt = nowSeconds + (data.expires_in ?? 3600);
  await setCache(
    env.DB,
    'google_access_token',
    JSON.stringify({ token: data.access_token, expiresAt })
  );

  console.log(`[GoogleSheets] ✅ New access token acquired, expires in ${data.expires_in ?? 3600}s`);
  return data.access_token;
}


// ─────────────────────────────────────────────────────────────────────────────
// buildSignedJwt — RS256-sign a Google service account JWT assertion
// ─────────────────────────────────────────────────────────────────────────────
async function buildSignedJwt(env) {
  const nowSeconds = Math.floor(Date.now() / 1000);

  const header = { alg: 'RS256', typ: 'JWT' };
  const claimSet = {
    iss:   env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: SCOPE,
    aud:   TOKEN_URL,
    iat:   nowSeconds,
    exp:   nowSeconds + 3600,
  };

  const unsignedToken =
    `${base64UrlEncodeString(JSON.stringify(header))}.${base64UrlEncodeString(JSON.stringify(claimSet))}`;

  const privateKey = await importPrivateKey(env.GOOGLE_PRIVATE_KEY);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(unsignedToken)
  );

  return `${unsignedToken}.${base64UrlEncode(new Uint8Array(signature))}`;
}


// ─────────────────────────────────────────────────────────────────────────────
// fetchSheetValues — GET one tab's full contents from the Sheets API
// ─────────────────────────────────────────────────────────────────────────────
async function fetchSheetValues(env, accessToken, tabName) {
  const sheetId = env.GOOGLE_SHEET_ID;
  const range   = encodeURIComponent(tabName);
  const url     = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`;

  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Google Sheets API ${response.status}: ${err}`);
  }

  const data = await response.json();
  return data.values ?? [];
}


// ─────────────────────────────────────────────────────────────────────────────
// importPrivateKey — parse a PEM PKCS8 private key for Web Crypto signing
//
// wrangler secrets are plain strings — if the PEM was pasted as a single
// line, its newlines survive as literal "\n" (backslash-n) rather than real
// line breaks. Both forms are normalised before stripping the PEM
// header/footer and base64-decoding the DER body.
// ─────────────────────────────────────────────────────────────────────────────
async function importPrivateKey(pem) {
  const normalized = pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem;

  const base64 = normalized
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');

  const binary = atob(base64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  return crypto.subtle.importKey(
    'pkcs8',
    bytes.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// base64Url helpers — JWT segments use base64url, not standard base64
// ─────────────────────────────────────────────────────────────────────────────
function base64UrlEncode(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlEncodeString(str) {
  return base64UrlEncode(new TextEncoder().encode(str));
}