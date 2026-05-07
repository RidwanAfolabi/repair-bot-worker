/**
 * iFix Express — WhatsApp AI Bot
 * Cloudflare Worker — main entry point
 *
 * Secrets (set via `npx wrangler secret put <NAME>`):
 *   WA_TOKEN           — Permanent System User access token from Meta
 *   WA_VERIFY_TOKEN    — Secret string you set when registering webhook in Meta portal
 *   WA_PHONE_NUMBER_ID — Phone Number ID from Meta Developer → WhatsApp → API Setup
 *   CLAUDE_API_KEY     — Anthropic API key //Could also use Gemini or OpenAI
 *   STAFF_WA_NUMBER    — Staff WhatsApp number for escalation alerts e.g. 60123456789
 *
 * D1 binding (wrangler.toml):
 *   [[d1_databases]]
 *   binding = "DB"
 *   database_name = "repair-bot-db"
 *   database_id = "YOUR_D1_DATABASE_ID"
 */

import { handleIncomingMessage }            from './bot.js';
import { initDb, saveMessage }              from './db.js';
import { sendTextMessage, sendReadReceipt } from './whatsapp.js';

export default {
  async fetch(request, env, ctx) {

    // Ensure DB tables exist — safe on every request (uses CREATE TABLE IF NOT EXISTS)
    await initDb(env.DB);

    const url = new URL(request.url);

    // Health check — useful to confirm the Worker is alive
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
      // Return 200 to Meta IMMEDIATELY — must respond within 5 seconds
      // or Meta marks your webhook as failed and retries the message.
      // All real work runs asynchronously inside ctx.waitUntil().
      ctx.waitUntil(handlePostMessage(request.clone(), env));
      return new Response('OK', { status: 200 });
    }

    return new Response('Method not allowed', { status: 405 });
  },
};


// ─────────────────────────────────────────────────────────────────────────────
// GET /webhook — Meta verification handshake
//
// Meta sends this once when you register (or update) your webhook URL.
// It passes three query params — you must echo hub.challenge back to pass.
// Fails silently if WA_VERIFY_TOKEN doesn't match what you set in Meta portal.
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
// Meta wraps every event in a nested structure. This function:
//   1. Unpacks the envelope to find the actual message
//   2. Filters out non-message events (read receipts, delivery status, etc.)
//   3. Handles non-text messages gracefully
//   4. Saves the message to D1
//   5. Sends a read receipt (human-paced feel)
//   6. Passes the message to the bot handler
// ─────────────────────────────────────────────────────────────────────────────
async function handlePostMessage(request, env) {
  let body;

  try {
    body = await request.json();
  } catch (err) {
    console.error('[PostMessage] Failed to parse JSON body:', err.message);
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
  const senderId  = message.from;  // Customer's full WhatsApp number e.g. 60123456789
  const msgType   = message.type;  // 'text' | 'image' | 'audio' | 'document' | etc.
  const messageId = message.id;    // Unique message ID — needed for read receipt

  console.log(`[PostMessage] '${msgType}' from ${senderId}`);

  // ── Non-text messages ────────────────────────────────────────────────────
  // Politely redirect for now.
  // TODO: handle 'image' (customer sends photo of cracked screen)
  // TODO: handle 'audio' (voice note — transcribe with Whisper)
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
    role:      'user',
    text:      incomingText,
  });

  // ── Read receipt — shows customer their message was seen ─────────────────
  await sendReadReceipt(messageId, env);

  // ── Hand off to bot ──────────────────────────────────────────────────────
  await handleIncomingMessage({ senderId, incomingText, env });
}