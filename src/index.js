/**
 * index.js — Cloudflare Worker entry point
 *
 * Handles:
 *   GET  /              — Health check
 *   GET  /webhook       — Meta webhook verification handshake
 *   POST /webhook       — Incoming WhatsApp messages
 *   GET  /oauth/callback — Embedded Signup OAuth callback (Coexistence onboarding)
 *   GET  /oauth/success  — Success page shown after onboarding completes
 *
 * Media handling summary:
 *   reaction        → silently ignored, no reply
 *   text            → handled by bot as normal
 *   image/video/doc with caption → caption handled as text, staff alerted
 *   image/video/doc without caption → customer notified, staff alerted
 *   audio           → customer notified, staff alerted
 *   sticker         → silently ignored (like a reaction)
 *   unknown         → silently ignored with a log
 *
 * Secrets required (set via `npx wrangler secret put <NAME>`):
 *   WA_TOKEN           — Permanent System User access token from Meta
 *   WA_VERIFY_TOKEN    — Secret string set when registering webhook in Meta portal
 *   WA_PHONE_NUMBER_ID — Phone Number ID from Meta Developer → WhatsApp → API Setup
 *   GEMINI_API_KEY     — Google Gemini API key (aistudio.google.com)
 *   STAFF_WA_NUMBER    — Manager's personal WhatsApp for escalation alerts
 *   META_APP_ID        — Your Meta App ID (from App Dashboard → Settings → Basic)
 *   META_APP_SECRET    — Your Meta App Secret (from App Dashboard → Settings → Basic)
 */

import { handleIncomingMessage } from './bot.js';
import { initDb, saveMessage }   from './db.js';
import { sendTextMessage, sendReadReceipt, sendStaffAlert } from './whatsapp.js';

export default {
  async fetch(request, env, ctx) {

    if (env.DB) {
      await initDb(env.DB);
    } else {
      console.error('[Worker] env.DB undefined — check D1 binding in wrangler.jsonc');
    }

    const url = new URL(request.url);

    // ── Health check ──────────────────────────────────────────────────────────
    if (url.pathname === '/') {
      return new Response('iFix Express Bot is running ✅', { status: 200 });
    }

    // ── Embedded Signup OAuth callback ────────────────────────────────────────
    // Meta redirects here after a business completes the Embedded Signup flow.
    // Receives an authorisation code, exchanges it for a permanent access token,
    // then subscribes the new WABA to our webhook so messages flow through.
    if (url.pathname === '/oauth/callback' && request.method === 'GET') {
      return handleOAuthCallback(url, env);
    }

    // ── Onboarding success page ───────────────────────────────────────────────
    if (url.pathname === '/oauth/success' && request.method === 'GET') {
      return new Response(successPage(), {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // ── Webhook routes ────────────────────────────────────────────────────────
    if (url.pathname !== '/webhook') {
      return new Response('Not found', { status: 404 });
    }

    if (request.method === 'GET') {
      return handleVerification(request, env);
    }

    if (request.method === 'POST') {
      // Parse body BEFORE returning response — stream closes after response is sent
      let body;
      try {
        body = await request.json();
      } catch (err) {
        console.error('[Worker] Failed to parse request body:', err.message);
        return new Response('OK', { status: 200 });
      }

      ctx.waitUntil(handlePostMessage(body, env));
      return new Response('OK', { status: 200 });
    }

    return new Response('Method not allowed', { status: 405 });
  },
};


// ─────────────────────────────────────────────────────────────────────────────
// GET /oauth/callback — Embedded Signup OAuth callback
//
// Flow:
//   1. Meta redirects here with ?code=XXXX after business completes signup
//   2. Exchange code for a short-lived user access token
//   3. Exchange that for a long-lived System User token
//   4. Retrieve the WABA ID and Phone Number ID for the onboarded business
//   5. Subscribe the WABA to this Worker's webhook
//   6. Store credentials (log them — in production write to D1 or KV)
//   7. Alert staff that a new number is connected
//   8. Redirect to success page
//
// The ?code param is single-use and expires quickly — process immediately.
// ─────────────────────────────────────────────────────────────────────────────
async function handleOAuthCallback(url, env) {
  const code  = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  // ── Handle user cancellation or Meta error ────────────────────────────────
  if (error) {
    const desc = url.searchParams.get('error_description') ?? 'Unknown error';
    console.error(`[OAuth] Meta returned error: ${error} — ${desc}`);
    return new Response(errorPage(desc), {
      status: 400,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  if (!code) {
    console.error('[OAuth] No code received in callback');
    return new Response(errorPage('No authorisation code received.'), {
      status: 400,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  try {
    // ── Step 1: Exchange code for short-lived user access token ──────────────
    console.log('[OAuth] Exchanging code for access token...');
    const tokenRes = await fetch(
      `https://graph.facebook.com/v21.0/oauth/access_token?` +
      `client_id=${env.META_APP_ID}` +
      `&client_secret=${env.META_APP_SECRET}` +
      `&code=${code}` +
      `&redirect_uri=${encodeURIComponent('https://bot.ifixexpress.com.my/oauth/callback')}`,
      { method: 'GET' }
    );

    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      console.error('[OAuth] Token exchange failed:', JSON.stringify(tokenData));
      return new Response(errorPage('Failed to exchange authorisation code. Please try again.'), {
        status: 400,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    const userToken = tokenData.access_token;
    console.log('[OAuth] ✅ User access token received');

    // ── Step 2: Get the WABA and phone number details ─────────────────────────
    // The token's granular scopes contain the WABA ID granted by the business
    const debugRes = await fetch(
      `https://graph.facebook.com/v21.0/debug_token?input_token=${userToken}&access_token=${env.META_APP_ID}|${env.META_APP_SECRET}`
    );
    const debugData = await debugRes.json();

    // Extract WABA ID from granular scopes
    const wabaScope = debugData?.data?.granular_scopes?.find(
      s => s.scope === 'whatsapp_business_management'
    );
    const wabaId = wabaScope?.target_ids?.[0];

    console.log(`[OAuth] WABA ID: ${wabaId ?? 'not found in scopes'}`);

    // ── Step 3: Get phone numbers on this WABA ────────────────────────────────
    let phoneNumberId = null;
    let phoneNumber   = null;

    if (wabaId) {
      const phoneRes = await fetch(
        `https://graph.facebook.com/v21.0/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name`,
        { headers: { 'Authorization': `Bearer ${userToken}` } }
      );
      const phoneData = await phoneRes.json();
      const firstPhone = phoneData?.data?.[0];

      if (firstPhone) {
        phoneNumberId = firstPhone.id;
        phoneNumber   = firstPhone.display_phone_number;
        console.log(`[OAuth] Phone Number: ${phoneNumber} (ID: ${phoneNumberId})`);
      }
    }

    // ── Step 4: Subscribe WABA to this Worker's webhook ───────────────────────
    // This makes messages from the onboarded number flow to our /webhook endpoint
    if (wabaId) {
      const subRes = await fetch(
        `https://graph.facebook.com/v21.0/${wabaId}/subscribed_apps`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.WA_TOKEN}`, // System User token
            'Content-Type':  'application/json',
          },
        }
      );
      const subData = await subRes.json();

      if (subData.success) {
        console.log(`[OAuth] ✅ WABA ${wabaId} subscribed to webhook`);
      } else {
        console.warn(`[OAuth] Webhook subscription may have failed:`, JSON.stringify(subData));
      }
    }

    // ── Step 5: Log credentials for the developer to action ──────────────────
    // In production this should write to D1 or Cloudflare KV so credentials
    // are stored and can be used to update the Worker secrets programmatically.
    // For now, logging gives you everything needed to update secrets manually.
    console.log('[OAuth] ═══════════════════════════════════════════');
    console.log('[OAuth] NEW BUSINESS ONBOARDED — action required:');
    console.log(`[OAuth] WABA ID:          ${wabaId ?? 'unknown'}`);
    console.log(`[OAuth] Phone Number:     ${phoneNumber ?? 'unknown'}`);
    console.log(`[OAuth] Phone Number ID:  ${phoneNumberId ?? 'unknown'}`);
    console.log(`[OAuth] User Token:       ${userToken.substring(0, 20)}... (see full in wrangler tail)`);
    console.log('[OAuth] Update WA_PHONE_NUMBER_ID secret if this is a new number');
    console.log('[OAuth] ═══════════════════════════════════════════');

    // ── Step 6: Alert staff that new number is connected ─────────────────────
    await sendStaffAlert(
      `🎉 *New WhatsApp number connected via Embedded Signup*\n\n` +
      `*Phone Number:* ${phoneNumber ?? 'unknown'}\n` +
      `*Phone Number ID:* ${phoneNumberId ?? 'unknown'}\n` +
      `*WABA ID:* ${wabaId ?? 'unknown'}\n\n` +
      `The number is now connected to the bot platform.\n` +
      `Developer action needed: update WA_PHONE_NUMBER_ID secret if this is the primary bot number.`,
      env
    );

    // ── Step 7: Redirect to success page ─────────────────────────────────────
    return Response.redirect('https://bot.ifixexpress.com.my/oauth/success', 302);

  } catch (err) {
    console.error('[OAuth] Unexpected error:', err.message);
    return new Response(errorPage('An unexpected error occurred. Please try again.'), {
      status: 500,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// GET /webhook — Meta verification handshake
// ─────────────────────────────────────────────────────────────────────────────
function handleVerification(request, env) {
  const url       = new URL(request.url);
  const mode      = url.searchParams.get('hub.mode');
  const token     = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token === env.WA_VERIFY_TOKEN) {
    console.log('[Verify] ✅ Webhook verified');
    return new Response(challenge, { status: 200 });
  }

  console.error('[Verify] ❌ Token mismatch — WA_VERIFY_TOKEN must match Meta portal');
  return new Response('Forbidden', { status: 403 });
}


// ─────────────────────────────────────────────────────────────────────────────
// POST /webhook — Route incoming messages by type
// ─────────────────────────────────────────────────────────────────────────────
async function handlePostMessage(body, env) {

  if (!body) return;

  const entry    = body?.entry?.[0];
  const changes  = entry?.changes?.[0];
  const value    = changes?.value;
  const messages = value?.messages;

  // Ignore non-message webhooks (delivery receipts, read events, status updates)
  if (!messages || messages.length === 0) {
    console.log('[PostMessage] Status update — skipping');
    return;
  }

  const message   = messages[0];
  const senderId  = message.from;
  const msgType   = message.type;
  const messageId = message.id;

  console.log(`[PostMessage] '${msgType}' from ${senderId}`);

  // ── Silently ignored types ────────────────────────────────────────────────
  if (msgType === 'reaction' || msgType === 'sticker') {
    console.log(`[PostMessage] Ignoring '${msgType}' from ${senderId} — no reply`);
    return;
  }

  // ── Text messages ─────────────────────────────────────────────────────────
  if (msgType === 'text') {
    const incomingText = message.text?.body?.trim();
    if (!incomingText) return;

    await saveMessage(env.DB, { senderId, role: 'user', text: incomingText });
    await sendReadReceipt(messageId, env);
    await handleIncomingMessage({ senderId, incomingText, env });
    return;
  }

  // ── Image/video/document WITH caption ────────────────────────────────────
  const caption = message[msgType]?.caption?.trim();
  if ((msgType === 'image' || msgType === 'video' || msgType === 'document') && caption) {
    console.log(`[PostMessage] '${msgType}' with caption from ${senderId} — handling caption as text`);

    await sendReadReceipt(messageId, env);
    await saveMessage(env.DB, { senderId, role: 'user', text: `[Sent ${msgType}] ${caption}` });

    await sendStaffAlert(
      `📎 *Media received from customer*\n\n` +
      `*Number:* +${senderId}\n` +
      `*Type:* ${msgType}\n` +
      `*Caption:* "${caption}"\n\n` +
      `Please check WhatsApp Business App to view the ${msgType}.\n` +
      `The bot is handling the text reply — intervene with *!take ${senderId}* if needed.`,
      env
    );

    await handleIncomingMessage({ senderId, incomingText: caption, env });
    return;
  }

  // ── Image/video/document WITHOUT caption ──────────────────────────────────
  if (msgType === 'image' || msgType === 'video' || msgType === 'document') {
    await sendReadReceipt(messageId, env);

    const mediaLabel = msgType === 'image' ? 'gambar' : msgType === 'video' ? 'video' : 'fail';

    await sendTextMessage(
      senderId,
      `Terima kasih sebab hantar ${mediaLabel} tu! Team kami akan tengok dan get back to you shortly ya 😊`,
      env
    );

    await sendStaffAlert(
      `📎 *${msgType.charAt(0).toUpperCase() + msgType.slice(1)} received from customer*\n\n` +
      `*Number:* +${senderId}\n\n` +
      `Please open WhatsApp Business App to view the ${msgType} and reply directly.\n\n` +
      `Bot has informed the customer that team will get back to them.\n` +
      `Type *!take ${senderId}* to take over the conversation.`,
      env
    );

    await saveMessage(env.DB, {
      senderId,
      role: 'user',
      text: `[Customer sent a ${msgType} — staff alerted to view and respond]`,
    });

    return;
  }

  // ── Audio / voice notes ───────────────────────────────────────────────────
  if (msgType === 'audio') {
    await sendReadReceipt(messageId, env);

    await sendTextMessage(
      senderId,
      'Terima kasih! Voice note diterima. Buat masa ni saya belum boleh dengar audio, tapi team kami akan get back to you ya 😊\n\nKalau senang, boleh taip soalan you — lagi cepat Alia boleh bantu!',
      env
    );

    await sendStaffAlert(
      `🎤 *Voice note received from customer*\n\n` +
      `*Number:* +${senderId}\n\n` +
      `Please open WhatsApp Business App to listen and reply.\n` +
      `Bot has asked customer to type if possible.\n` +
      `Type *!take ${senderId}* to take over if needed.`,
      env
    );

    await saveMessage(env.DB, {
      senderId,
      role: 'user',
      text: '[Customer sent a voice note — staff alerted, customer asked to type]',
    });

    return;
  }

  // ── Catch-all ─────────────────────────────────────────────────────────────
  console.log(`[PostMessage] Unhandled message type '${msgType}' from ${senderId} — ignoring`);
}


// ─────────────────────────────────────────────────────────────────────────────
// successPage — HTML shown after successful Embedded Signup onboarding
// ─────────────────────────────────────────────────────────────────────────────
function successPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Connected — iFix Express</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #f0f9f4;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 2rem;
    }
    .card {
      background: white;
      border-radius: 16px;
      padding: 3rem 2.5rem;
      max-width: 480px;
      width: 100%;
      text-align: center;
      box-shadow: 0 4px 24px rgba(0,0,0,0.08);
    }
    .icon { font-size: 3.5rem; margin-bottom: 1.25rem; }
    h1 { font-size: 1.5rem; color: #111827; margin-bottom: 0.75rem; }
    p { color: #6b7280; line-height: 1.6; margin-bottom: 0.5rem; }
    .badge {
      display: inline-block;
      background: #ecfdf5;
      color: #065f46;
      border: 1px solid #a7f3d0;
      border-radius: 999px;
      padding: 4px 14px;
      font-size: 0.8125rem;
      font-weight: 500;
      margin-bottom: 1.5rem;
    }
    a {
      display: inline-block;
      margin-top: 1.5rem;
      color: #1d4ed8;
      font-size: 0.9rem;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✅</div>
    <span class="badge">WhatsApp Connected</span>
    <h1>You're all set!</h1>
    <p>Your WhatsApp Business number has been successfully connected to the iFix Express AI assistant.</p>
    <p>Alia will now handle customer enquiries on your behalf — 24/7.</p>
    <a href="https://ifixexpress.com.my">← Return to iFix Express</a>
  </div>
</body>
</html>`;
}


// ─────────────────────────────────────────────────────────────────────────────
// errorPage — HTML shown when OAuth callback fails
// ─────────────────────────────────────────────────────────────────────────────
function errorPage(message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Connection Failed — iFix Express</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #fff5f5;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 2rem;
    }
    .card {
      background: white;
      border-radius: 16px;
      padding: 3rem 2.5rem;
      max-width: 480px;
      width: 100%;
      text-align: center;
      box-shadow: 0 4px 24px rgba(0,0,0,0.08);
    }
    .icon { font-size: 3.5rem; margin-bottom: 1.25rem; }
    h1 { font-size: 1.5rem; color: #111827; margin-bottom: 0.75rem; }
    p { color: #6b7280; line-height: 1.6; }
    .error {
      background: #fef2f2;
      border: 1px solid #fecaca;
      border-radius: 8px;
      padding: 0.75rem 1rem;
      font-size: 0.875rem;
      color: #991b1b;
      margin: 1rem 0;
    }
    a {
      display: inline-block;
      margin-top: 1.5rem;
      color: #1d4ed8;
      font-size: 0.9rem;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">⚠️</div>
    <h1>Connection failed</h1>
    <p>Something went wrong while connecting your WhatsApp number.</p>
    <div class="error">${message}</div>
    <p>Please try again or contact the developer for assistance.</p>
    <a href="https://ifixexpress.com.my">← Return to iFix Express</a>
  </div>
</body>
</html>`;
}