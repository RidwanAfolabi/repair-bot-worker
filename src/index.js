/**
 * iFix Express — WhatsApp AI Bot
 * Cloudflare Worker — main entry point
 *
 * Secrets (set via `npx wrangler secret put <NAME>`):
 *   WA_TOKEN           — Permanent System User access token from Meta
 *   WA_VERIFY_TOKEN    — Secret string you set when registering webhook in Meta portal
 *   WA_PHONE_NUMBER_ID — Phone Number ID from Meta Developer → WhatsApp → API Setup
 *   GEMINI_API_KEY     — Google Gemini API key (from aistudio.google.com)
 *   STAFF_WA_NUMBER    — Manager's personal WhatsApp number for escalation alerts e.g. 60123456789
 *
 * D1 binding (wrangler.jsonc):
 *   "d1_databases": [{ "binding": "DB", "database_name": "repair-bot-db", "database_id": "YOUR_ID" }]
 */

import { handleIncomingMessage }            from './bot.js';
import { initDb, saveMessage }              from './db.js';
import { sendTextMessage, sendReadReceipt } from './whatsapp.js';

export default {
  async fetch(request, env, ctx) {

    // Ensure DB tables exist — safe on every request (CREATE TABLE IF NOT EXISTS)
    if (env.DB) {
      await initDb(env.DB);
    } else {
      console.error('[Worker] env.DB is undefined — check D1 binding in wrangler.jsonc');
    }

    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/') {
      return new Response('iFix Express Bot is running ✅', { status: 200 });
    }

    if (url.pathname !== '/webhook') {
      return new Response('Not found', { status: 404 });
    }

    // ── GET /webhook — Meta verification handshake ──────────────────────────
    if (request.method === 'GET') {
      return handleVerification(request, env);
    }

    // ── POST /webhook — Incoming WhatsApp messages ───────────────────────────
    if (request.method === 'POST') {

      // CRITICAL FIX: Parse the request body BEFORE returning the response.
      // Cloudflare Workers closes the request stream once a response is sent —
      // so request.clone() followed by body parsing inside ctx.waitUntil() fails
      // with "Can't read from request stream after response has been sent."
      // Solution: read the body first, then pass the parsed object to the handler.
      let body;
      try {
        body = await request.json();
      } catch (err) {
        console.error('[Worker] Failed to parse request body:', err.message);
        // Still return 200 — Meta must not retry this
        return new Response('OK', { status: 200 });
      }

      // Return 200 to Meta immediately — Meta will retry if no response within 5s
      // All real work runs asynchronously inside ctx.waitUntil()
      ctx.waitUntil(handlePostMessage(body, env));
      return new Response('OK', { status: 200 });
    }

    return new Response('Method not allowed', { status: 405 });
  },
};


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

  console.error('[Verify] ❌ Token mismatch — check WA_VERIFY_TOKEN matches Meta portal');
  return new Response('Forbidden', { status: 403 });
}


// ─────────────────────────────────────────────────────────────────────────────
// POST /webhook — Incoming WhatsApp messages
//
// Receives the already-parsed body object (not the raw request).
// Meta wraps every event in a nested structure — this unpacks it,
// filters non-message events, and routes to the bot handler.
// ─────────────────────────────────────────────────────────────────────────────
async function handlePostMessage(body, env) {

  if (!body) {
    console.error('[PostMessage] No body received');
    return;
  }

  // Unpack Meta's nested event envelope
  const entry    = body?.entry?.[0];
  const changes  = entry?.changes?.[0];
  const value    = changes?.value;
  const messages = value?.messages;

  // Ignore status updates, delivery receipts, read events — only handle messages
  if (!messages || messages.length === 0) {
    console.log('[PostMessage] No messages in payload — status update, skipping');
    return;
  }

  const message   = messages[0];
  const senderId  = message.from;   // Customer's WhatsApp number e.g. 60123456789
  const msgType   = message.type;   // 'text' | 'image' | 'audio' | 'document' etc.
  const messageId = message.id;     // Unique message ID — needed for read receipt

  console.log(`[PostMessage] '${msgType}' from ${senderId}`);

  // ── Non-text messages — politely redirect ────────────────────────────────
  // TODO: handle 'image' (customer sends photo of cracked screen)
  // TODO: handle 'audio' (voice note)
  if (msgType !== 'text') {
    await sendTextMessage(
      senderId,
      'Hai! Buat masa ni saya hanya boleh baca mesej teks. Boleh taip soalan anda? 😊',
      env
    );
    return;
  }

  const incomingText = message.text.body.trim();

  // ── Save incoming message to D1 ──────────────────────────────────────────
  await saveMessage(env.DB, {
    senderId,
    role: 'user',
    text: incomingText,
  });

  // ── Read receipt — shows customer their message was seen ─────────────────
  await sendReadReceipt(messageId, env);

  // ── Hand off to bot ──────────────────────────────────────────────────────
  await handleIncomingMessage({ senderId, incomingText, env });
}