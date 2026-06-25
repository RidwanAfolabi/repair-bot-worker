/**
 * index.js — Cloudflare Worker entry point
 *
 * Handles:
 *   GET  /webhook — Meta webhook verification handshake
 *   POST /webhook — Incoming WhatsApp messages
 *   GET  /        — Health check
 *
 * Media handling summary:
 *   reaction        → silently ignored, no reply
 *   text            → handled by bot as normal
 *   text + caption  → extracted and handled as text
 *   image/video/doc → customer notified, staff alerted, media forwarded
 *   audio           → customer notified, staff alerted, escalated
 *   sticker         → silently ignored (like a reaction)
 *   unknown         → silently ignored with a log
 *
 * Secrets required (set via `npx wrangler secret put <NAME>`):
 *   WA_TOKEN           — Permanent System User access token from Meta
 *   WA_VERIFY_TOKEN    — Secret string set when registering webhook in Meta portal
 *   WA_PHONE_NUMBER_ID — Phone Number ID from Meta Developer → WhatsApp → API Setup
 *   GEMINI_API_KEY     — Google Gemini API key (aistudio.google.com)
 *   STAFF_WA_NUMBER    — Manager's personal WhatsApp for escalation alerts
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

    if (url.pathname === '/') {
      return new Response('iFix Express Bot is running ✅', { status: 200 });
    }

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
  // Reactions and stickers should never trigger a reply.
  // A reaction to Alia's message replying "I can only read text" is jarring.
  if (msgType === 'reaction' || msgType === 'sticker') {
    console.log(`[PostMessage] Ignoring '${msgType}' from ${senderId} — no reply`);
    return;
  }

  // ── Text messages (+ images/video with caption text) ─────────────────────
  // WhatsApp sometimes sends an image WITH a caption as a single message.
  // Extract the caption and treat it as a text message — this covers the
  // common real-world case of "customer sends photo of broken screen with
  // description in the caption."
  if (msgType === 'text') {
    const incomingText = message.text?.body?.trim();
    if (!incomingText) return;

    await saveMessage(env.DB, { senderId, role: 'user', text: incomingText });
    await sendReadReceipt(messageId, env);
    await handleIncomingMessage({ senderId, incomingText, env });
    return;
  }

  // ── Image/video/document WITH a caption ──────────────────────────────────
  // Customer sent media but also typed a description.
  // Handle the caption as a text message — this covers:
  //   "customer sends photo of cracked screen + types what happened"
  // Also escalate so staff can view the actual media.
  const caption = message[msgType]?.caption?.trim();
  if ((msgType === 'image' || msgType === 'video' || msgType === 'document') && caption) {
    console.log(`[PostMessage] '${msgType}' with caption from ${senderId} — handling caption as text`);

    // Send read receipt so customer knows it was received
    await sendReadReceipt(messageId, env);

    // Save caption as the customer's message
    await saveMessage(env.DB, { senderId, role: 'user', text: `[Sent ${msgType}] ${caption}` });

    // Alert staff that media was sent alongside the text
    await sendStaffAlert(
      `📎 *Media received from customer*\n\n` +
      `*Number:* +${senderId}\n` +
      `*Type:* ${msgType}\n` +
      `*Caption:* "${caption}"\n\n` +
      `Please check WhatsApp Business App to view the ${msgType}.\n` +
      `The bot is handling the text reply — intervene with *!take ${senderId}* if needed.`,
      env
    );

    // Let the bot handle the caption text as a normal message
    await handleIncomingMessage({ senderId, incomingText: caption, env });
    return;
  }

  // ── Image/video/document WITHOUT caption ─────────────────────────────────
  // Customer sent media only — no text. Bot cannot interpret it yet.
  // Acknowledge receipt, escalate to staff to view and respond.
  if (msgType === 'image' || msgType === 'video' || msgType === 'document') {
    await sendReadReceipt(messageId, env);

    // Friendly acknowledgement to customer
    const mediaLabel = msgType === 'image'
      ? 'gambar'
      : msgType === 'video'
        ? 'video'
        : 'fail';

    await sendTextMessage(
      senderId,
      `Terima kasih sebab hantar ${mediaLabel} tu! Team kami akan tengok dan get back to you shortly ya 😊`,
      env
    );

    // Alert staff with context
    await sendStaffAlert(
      `📎 *${msgType.charAt(0).toUpperCase() + msgType.slice(1)} received from customer*\n\n` +
      `*Number:* +${senderId}\n\n` +
      `Please open WhatsApp Business App to view the ${msgType} and reply directly.\n\n` +
      `Bot has informed the customer that team will get back to them.\n` +
      `Type *!take ${senderId}* to take over the conversation.`,
      env
    );

    // Save event to D1 so conversation history reflects this exchange
    await saveMessage(env.DB, {
      senderId,
      role: 'user',
      text: `[Customer sent a ${msgType} — staff alerted to view and respond]`,
    });

    return;
  }

  // ── Audio / voice notes ───────────────────────────────────────────────────
  // Customer sent a voice note. Bot cannot transcribe audio yet.
  // Acknowledge, escalate to staff.
  // TODO future: integrate Whisper STT to transcribe and reply in text + audio
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

  // ── Catch-all for unknown/unsupported types ───────────────────────────────
  // Log it but do nothing — avoids confusing the customer with an error message
  // for edge cases like location pins, contacts, polls etc.
  console.log(`[PostMessage] Unhandled message type '${msgType}' from ${senderId} — ignoring`);
}