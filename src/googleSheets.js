/**
 * googleSheets.js — fetch the live price list from Google Sheets
 *
 * Uses a Google service account (JWT Bearer OAuth2 flow — no user consent
 * screen, no refresh token to manage) to read a read-only range from the
 * iFix Express pricing sheet. Two things are cached in D1 (see db.js
 * getCache/setCache) to avoid re-authenticating and re-fetching on every
 * single customer message:
 *
 *   'google_access_token'  — the OAuth2 access token, ~1hr lifespan.
 *                             Refreshed when within TOKEN_REFRESH_SKEW
 *                             seconds of expiry.
 *   'pricing_sheet_rows'   — the parsed price list rows themselves.
 *                             Refreshed every SHEET_CACHE_TTL seconds so a
 *                             manager editing the sheet shows up reasonably
 *                             fast without hitting the Sheets API on every
 *                             single WhatsApp message.
 *
 * Requires secrets (set via `npx wrangler secret put <NAME>`):
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL — the service account's client_email
 *   GOOGLE_PRIVATE_KEY           — the service account's PEM private key
 *     (real newlines are fine; a literal "\n"-escaped single-line paste is
 *     also handled — see importPrivateKey below)
 *
 * Requires vars (plain, non-sensitive — set in wrangler.jsonc):
 *   GOOGLE_SHEET_ID    — the spreadsheet ID from its URL
 *   GOOGLE_SHEET_RANGE — e.g. "Sheet1" or "Sheet1!A:D"
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
// getPricingRows — cached, end-to-end: auth + fetch + parse
//
// Never throws — any failure (auth, network, malformed response) falls back
// to the last cached rows if any exist, or an empty array if not. Callers
// should treat [] as "no live pricing data available right now," not a
// crash — findPricing() on an empty array just returns tier 'none'.
// ─────────────────────────────────────────────────────────────────────────────
export async function getPricingRows(env) {
  const cached = await getCache(env.DB, 'pricing_sheet_rows');
  const nowSeconds = Math.floor(Date.now() / 1000);

  if (cached && (nowSeconds - cached.cachedAt) < SHEET_CACHE_TTL) {
    return JSON.parse(cached.value);
  }

  try {
    const accessToken = await getAccessToken(env);
    const values = await fetchSheetValues(env, accessToken);
    const rows = rowsFromApiValues(values);

    await setCache(env.DB, 'pricing_sheet_rows', JSON.stringify(rows));
    console.log(`[GoogleSheets] ✅ Fetched ${rows.length} pricing row(s)`);
    return rows;
  } catch (err) {
    console.error('[GoogleSheets] Fetch failed:', err.message);

    if (cached) {
      console.log('[GoogleSheets] Falling back to stale cached pricing data');
      return JSON.parse(cached.value);
    }

    return [];
  }
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
// fetchSheetValues — GET the configured range from the Sheets API
// ─────────────────────────────────────────────────────────────────────────────
async function fetchSheetValues(env, accessToken) {
  const sheetId = env.GOOGLE_SHEET_ID;
  const range   = encodeURIComponent(env.GOOGLE_SHEET_RANGE ?? 'Sheet1');
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
