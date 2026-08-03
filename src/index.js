/**
 * index.js — Cloudflare Worker entry point
 *
 * Handles:
 *   GET  /              — Health check
 *   GET  /webhook       — Meta webhook verification handshake
 *   POST /webhook       — Incoming WhatsApp messages
 *   GET  /oauth/callback — Embedded Signup OAuth callback (Coexistence onboarding)
 *   GET  /oauth/success  — Success page shown after onboarding completes
 *   GET  /onboard        — Landing page with Connect WhatsApp button (share this instead of raw Meta link)
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
 *   STAFF_WA_NUMBER       — Manager's personal WhatsApp for escalation alerts
 *   META_APP_ID            — Your Meta App ID (App Dashboard → Settings → Basic)
 *   META_APP_SECRET        — Your Meta App Secret (same page, click Show)
 *   EMBEDDED_SIGNUP_URL    — The Meta-hosted Embedded Signup link (from Meta portal)
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

    // ── Onboarding page ─────────────────────────────────────────────────────
    // Serves a clean landing page with the Embedded Signup button.
    // Share https://bot.ifixexpress.com.my/onboard instead of the raw Meta link.
    if (url.pathname === '/onboard' && request.method === 'GET') {
      return new Response(onboardPage(env), {
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

    // ── Step 4: Subscribe WABA to this Worker's webhook ─────────────────────
    // CRITICAL: Use userToken (manager's own token) — NOT env.WA_TOKEN.
    // The manager's token has authority over their own WABA.
    // env.WA_TOKEN cannot access another business's WABA until after subscription.
    if (wabaId) {
      const subRes = await fetch(
        `https://graph.facebook.com/v21.0/${wabaId}/subscribed_apps`,
        {
          method:  'POST',
          headers: {
            'Authorization': `Bearer ${userToken}`,
            'Content-Type':  'application/json',
          },
        }
      );
      const subData = await subRes.json();

      if (subData.success) {
        console.log(`[OAuth] ✅ WABA ${wabaId} subscribed to webhook`);
      } else {
        console.warn(`[OAuth] Webhook subscription failed:`, JSON.stringify(subData));
      }
    }

    // ── Step 5: Store connected number in D1 ─────────────────────────────────
    // Creates a connected_numbers table if it doesn't exist and stores the
    // new business's Phone Number ID so the Worker has a persistent record.
    if (phoneNumberId && env.DB) {
      try {
        await env.DB.prepare(`
          CREATE TABLE IF NOT EXISTS connected_numbers (
            phone_number_id  TEXT PRIMARY KEY,
            phone_number     TEXT,
            waba_id          TEXT,
            connected_at     INTEGER DEFAULT (unixepoch()),
            active           INTEGER DEFAULT 1
          )
        `).run();

        await env.DB.prepare(`
          INSERT INTO connected_numbers (phone_number_id, phone_number, waba_id, active)
          VALUES (?, ?, ?, 1)
          ON CONFLICT(phone_number_id) DO UPDATE SET
            phone_number = excluded.phone_number,
            waba_id      = excluded.waba_id,
            active       = 1,
            connected_at = unixepoch()
        `).bind(phoneNumberId, phoneNumber ?? '', wabaId ?? '').run();

        console.log(`[OAuth] ✅ Stored in D1: ${phoneNumber} (${phoneNumberId})`);
      } catch (dbErr) {
        console.error('[OAuth] D1 store failed:', dbErr.message);
      }
    }

    // ── Step 6: Log clearly for developer action ──────────────────────────────
    console.log('[OAuth] ═══════════════════════════════════════════');
    console.log('[OAuth] ✅ ONBOARDING COMPLETE — developer action needed:');
    console.log(`[OAuth] Business Number:  ${phoneNumber ?? 'unknown'}`);
    console.log(`[OAuth] Phone Number ID:  ${phoneNumberId ?? 'unknown'}`);
    console.log(`[OAuth] WABA ID:          ${wabaId ?? 'unknown'}`);
    console.log('[OAuth] Run:');
    console.log(`[OAuth]   npx wrangler secret put WA_PHONE_NUMBER_ID`);
    console.log(`[OAuth]   paste: ${phoneNumberId ?? 'see above'}`);
    console.log('[OAuth]   npx wrangler deploy');
    console.log('[OAuth] ═══════════════════════════════════════════');

    // ── Step 7: Alert staff and developer via WhatsApp ────────────────────────
    await sendStaffAlert(
      `✅ *WhatsApp number connected!*\n\n` +
      `*Number:* ${phoneNumber ?? 'unknown'}\n` +
      `*Phone Number ID:* ${phoneNumberId ?? 'unknown'}\n` +
      `*WABA ID:* ${wabaId ?? 'unknown'}\n\n` +
      `*Developer action required:*\n` +
      `npx wrangler secret put WA_PHONE_NUMBER_ID\n` +
      `paste: ${phoneNumberId ?? 'see logs'}\n` +
      `npx wrangler deploy`,
      env
    );

    // ── Step 8: Redirect to success page ─────────────────────────────────────
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
// onboardPage — landing page with the Embedded Signup button
//
// Served at GET /onboard — share https://bot.ifixexpress.com.my/onboard
// instead of the raw Meta-hosted Embedded Signup URL.
//
// Requires secret: EMBEDDED_SIGNUP_URL
//   npx wrangler secret put EMBEDDED_SIGNUP_URL
//   (paste the full Meta-hosted Embedded Signup link as value)
// ─────────────────────────────────────────────────────────────────────────────
function onboardPage(env) {
  const signupUrl = env.EMBEDDED_SIGNUP_URL ?? '#';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Connect WhatsApp — iFix Express</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: linear-gradient(160deg, #f8faff 0%, #eef3ff 100%);
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; padding: 2rem;
    }
    .card {
      background: white; border-radius: 20px; padding: 3rem 2.5rem;
      max-width: 520px; width: 100%; text-align: center;
      box-shadow: 0 8px 32px rgba(16,24,40,0.10);
    }
    .logo { font-size: 1.25rem; font-weight: 700; color: #1a3699; margin-bottom: 2rem; }
    .logo span { color: #e11d2f; }
    .icon {
      width: 64px; height: 64px;
      background: linear-gradient(135deg, #1a3699, #0f204f);
      border-radius: 16px; display: flex; align-items: center;
      justify-content: center; margin: 0 auto 1.5rem; font-size: 1.75rem;
    }
    h1 { font-size: 1.5rem; color: #111827; margin-bottom: 0.75rem; font-weight: 700; }
    .subtitle { color: #6b7280; line-height: 1.6; margin-bottom: 2rem; font-size: 0.9375rem; }
    .features {
      list-style: none; text-align: left;
      background: #f9fafb; border-radius: 12px;
      padding: 1.25rem 1.5rem; margin-bottom: 2rem;
    }
    .features li {
      display: flex; align-items: flex-start; gap: 10px;
      font-size: 0.875rem; color: #374151; padding: 0.4rem 0;
    }
    .features li::before { content: "✓"; color: #059669; font-weight: 700; flex-shrink: 0; margin-top: 1px; }
    .btn {
      display: inline-flex; align-items: center; justify-content: center;
      gap: 10px; background: #25D366; color: white;
      font-size: 1rem; font-weight: 600; padding: 0.875rem 2rem;
      border-radius: 12px; text-decoration: none; width: 100%;
      transition: background 0.2s; box-shadow: 0 4px 12px rgba(37,211,102,0.35);
    }
    .btn:hover { background: #1ebe5d; }
    .note { margin-top: 1.25rem; font-size: 0.8125rem; color: #9ca3af; line-height: 1.5; }
    .divider { border: none; border-top: 1px solid #f3f4f6; margin: 2rem 0; }
    .powered { font-size: 0.75rem; color: #d1d5db; }
    .powered a { color: #9ca3af; text-decoration: none; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">iFix<span>Express</span></div>
    <div class="icon">🤖</div>
    <h1>Connect Your WhatsApp</h1>
    <p class="subtitle">
      Link your WhatsApp Business number to A'aisyah - our AI customer service assistant.
      Your existing WhatsApp Business App keeps working normally.
    </p>
    <ul class="features">
      <li>A'aisyah handles customer enquiries 24/7 automatically</li>
      <li>You keep using WhatsApp Business App as normal</li>
      <li>Escalate to your team with one tap when needed</li>
      <li>No messages lost — full conversation history maintained</li>
    </ul>
    <a href="\${signupUrl}" class="btn">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="white" xmlns="http://www.w3.org/2000/svg">
        <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
        <path d="M12 0C5.373 0 0 5.373 0 12c0 2.123.554 4.116 1.523 5.847L0 24l6.335-1.507A11.934 11.934 0 0 0 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.792 9.792 0 0 1-5.017-1.381l-.36-.214-3.732.978.996-3.638-.235-.374A9.786 9.786 0 0 1 2.182 12C2.182 6.57 6.57 2.182 12 2.182c5.43 0 9.818 4.388 9.818 9.818 0 5.43-4.388 9.818-9.818 9.818z"/>
      </svg>
      Connect with WhatsApp
    </a>
    <p class="note">
      You will be guided through a secure Meta verification process.<br>
      This takes about 2 minutes and requires access to your WhatsApp Business App.
    </p>
    <hr class="divider">
    <p class="powered">Powered by iFix Express AI Platform · <a href="https://ifixexpress.com.my">ifixexpress.com.my</a></p>
  </div>
</body>
</html>`;
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
    <p>A'aisyah will now handle customer enquiries on your behalf — 24/7.</p>
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