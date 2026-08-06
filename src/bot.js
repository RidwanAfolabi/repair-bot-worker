/**
 * bot.js — AI bot handler
 *
 * For each incoming message:
 *   1. Checks for staff commands (!take, !done)
 *   2. Checks if sender is escalated — stays silent if so
 *   3. Fetches recent conversation history from D1
 *   4. Pricing lookup — if the message matches the structured device-details
 *      template, fetches the live price sheet and builds pricing context
 *   5. Calls the configured LLM (see llm.js) with history + new message +
 *      pricing context
 *   6. Detects escalation trigger in reply
 *   7. Saves reply to D1
 *   8. Sends reply in natural parts with human-paced delays
 *
 * NOTE: Media handling (images, audio, reactions, video) is now handled
 * entirely in index.js before this function is called. By the time
 * handleIncomingMessage() is invoked, the message is always text.
 */

import {
  getRecentMessages,
  saveMessage,
  isEscalated,
  setManualMute,
  resolveEscalation,
} from './db.js';

import {
  sendTextMessage,
  sendStaffAlert,
} from './whatsapp.js';

import { generateReply } from './llm.js';

import {
  parseStructuredDeviceReply,
  findPricing,
  formatPricingContext,
} from './pricing.js';

import { getPricingRows } from './googleSheets.js';


// ─────────────────────────────────────────────────────────────────────────────
// handleIncomingMessage — main entry point called from index.js
//
// Only called with clean text at this point — all media routing happens
// upstream in index.js before this is invoked.
// ─────────────────────────────────────────────────────────────────────────────
export async function handleIncomingMessage({ senderId, incomingText, env }) {

  // ── 1. Staff commands — from manager's personal number ───────────────────
  if (senderId === env.STAFF_WA_NUMBER) {
    await handleStaffCommand(incomingText, env, senderId);
    return;
  }

  // ── 2. Check escalation state ─────────────────────────────────────────────
  // Bot stays completely silent — staff are handling via WhatsApp Business App
  const escalated = await isEscalated(env.DB, senderId, env);
  if (escalated) {
    console.log(`[Bot] ${senderId} is escalated — staying silent`);
    return;
  }

  // ── 3. Fetch recent conversation history ──────────────────────────────────
  // Last 6 messages (3 exchanges) — enough context without ballooning token cost.
  // History includes D1 records of [Customer sent image] events so Gemini
  // is aware that media was sent even if it couldn't read it.
  const history = await getRecentMessages(env.DB, senderId, 6);

  // ── 4. Pricing lookup — structured device-detail replies only ────────────
  // If this message matches the manager's brand/model/damage template (see
  // prompt.js "ASKING FOR DEVICE DETAILS"), look up the live price sheet and
  // feed matched rows to the LLM as extra context. Any failure here (sheet
  // unreachable, no match, bad auth) falls back to an empty pricingContext —
  // the LLM still replies from its own prompt/history, just without live
  // pricing to reference for this particular message.
  let pricingContext = '';
  const deviceDetails = parseStructuredDeviceReply(incomingText);
  if (deviceDetails) {
    try {
      const rows  = await getPricingRows(env);
      const match = findPricing(deviceDetails, rows);
      pricingContext = formatPricingContext(match);
      console.log(`[Bot] Pricing lookup for ${senderId} — tier: ${match.tier}, rows: ${match.rows.length}`);
    } catch (err) {
      console.error('[Bot] Pricing lookup failed:', err.message);
    }
  }

  // ── 5. Call the LLM (provider set via LLM_PROVIDER — see llm.js) ─────────
  let aiReply;
  try {
    aiReply = await generateReply(history, incomingText, env, pricingContext);
  } catch (err) {
    console.error(`[Bot] LLM error (${env.LLM_PROVIDER ?? 'gemini'}):`, err.message);
    aiReply = 'Maaf, ada gangguan teknikal sebentar. Team kami akan balas anda tidak lama lagi! 🙏';
  }

  // ── 6. Detect escalation trigger in reply ────────────────────────────────
  if (shouldEscalate(aiReply)) {
    await setManualMute(env.DB, senderId);
    await sendStaffAlert(
      `🚨 *Customer needs attention*\n\n` +
      `*Number:* +${senderId}\n` +
      `*Last message:* "${incomingText}"\n\n` +
      `👉 Open *WhatsApp Business App* and reply to this customer directly.\n\n` +
      `🤖 Bot is now *paused* — they will only see your replies.\n\n` +
      `When done, send:\n*!done ${senderId}*\n...and the bot will resume.`,
      env
    );
    console.log(`[Bot] Escalated ${senderId} to staff`);
  }

  // ── 7. Save bot reply ─────────────────────────────────────────────────────
  await saveMessage(env.DB, { senderId, role: 'assistant', text: aiReply });

  // ── 8. Send in natural parts with human-paced delays ─────────────────────
  await sendInParts(senderId, aiReply, env);
}


// ─────────────────────────────────────────────────────────────────────────────
// shouldEscalate — detect escalation phrase in A'aisyah's reply
// Must match the exact phrase defined in prompt.js buildSystemPrompt()
// ─────────────────────────────────────────────────────────────────────────────
function shouldEscalate(reply) {
  return reply.toLowerCase().includes('biar saya connectkan');
}


// ─────────────────────────────────────────────────────────────────────────────
// handleStaffCommand — shared parser for staff commands, called from both
// STAFF_WA_NUMBER text messages (bot.js) and smb_message_echoes self-chat
// notes (index.js). replyTo defaults to STAFF_WA_NUMBER but is decoupled
// from the command's source so both channels can confirm to the same place.
//
// !take 60123456789  — manually pause bot for a customer
// !done 60123456789  — resume bot for a customer after staff handled them
//
// Returns true if the text was a recognised command, false otherwise.
// ─────────────────────────────────────────────────────────────────────────────
export async function handleStaffCommand(text, env, replyTo = env.STAFF_WA_NUMBER) {
  const parts  = text.trim().split(/\s+/);
  const cmd    = parts[0]?.toLowerCase();
  const target = parts[1];

  if (cmd === '!take' && target) {
    await setManualMute(env.DB, target);
    await sendTextMessage(
      replyTo,
      `✅ Bot paused for +${target} (stays off until !done — no auto-resume).\nOpen WhatsApp Business App to reply to them directly.`,
      env
    );
    return true;
  }

  if (cmd === '!done' && target) {
    await resolveEscalation(env.DB, target);
    await sendTextMessage(replyTo, `✅ Bot resumed for +${target}.`, env);
    await sendTextMessage(
      target,
      'Terima kasih kerana menghubungi iFix Express! Ada lagi yang boleh kami bantu? 😊',
      env
    );
    return true;
  }

  console.log(`[Bot] Unrecognised staff command: "${text}"`);
  return false;
}


// ─────────────────────────────────────────────────────────────────────────────
// sendInParts — split AI reply on double newline and send as separate messages
//
// A'aisyah formats multi-part replies with blank lines (\n\n) as signals.
// Each chunk is sent separately with human-paced delays — feels exactly
// like a person reading your message, thinking, then typing a response.
//
// Delay strategy:
//   First message  — 3–5 seconds (simulates reading the customer's message
//                    and starting to compose a reply)
//   Between parts  — scales with the length of the NEXT chunk
//                    (~55ms per character, capped between 2s and 5s)
//                    longer message = took longer to type
//
// A small random jitter (±500ms) is added to each delay so the timing
// never feels mechanical or perfectly consistent — real humans aren't.
// ─────────────────────────────────────────────────────────────────────────────
async function sendInParts(to, text, env) {
  const parts = text
    .split(/\n\n+/)
    .map(p => p.trim())
    .filter(p => p.length > 0);

  // Guards against the customer getting muted (staff took over) mid-send —
  // e.g. staff replies via WhatsApp Business App while A'aisyah is still
  // drip-feeding a multi-part reply. Re-checks escalation state right
  // before each part goes out and drops anything still queued.
  const sendIfStillActive = async (part) => {
    if (await isEscalated(env.DB, to, env)) {
      console.log(`[Bot] ${to} got muted mid-send — dropping remaining reply`);
      return false;
    }
    await sendTextMessage(to, part, env);
    return true;
  };

  // Single part — pause as if reading + composing, then send
  if (parts.length === 1) {
    await delay(jitter(3500));   // ~3–4 seconds before first reply
    await sendIfStillActive(parts[0]);
    return;
  }

  // Multiple parts — stagger with typing-speed delays between each
  for (let i = 0; i < parts.length; i++) {
    if (i === 0) {
      // First message — longer pause (read customer message → start typing)
      await delay(jitter(3500));  // ~3–4 seconds
    } else {
      // Subsequent messages — scale with the length of this part
      // ~55ms per character, capped between 2000ms and 5000ms
      // Then add random jitter so it never feels robotic
      const base = Math.min(5000, Math.max(2000, parts[i].length * 55));
      await delay(jitter(base));
    }

    const stillActive = await sendIfStillActive(parts[i]);
    if (!stillActive) break;
  }
}
 
 
// ─────────────────────────────────────────────────────────────────────────────
// jitter — add ±500ms random variation to a base delay
//
// Makes timing feel natural rather than perfectly consistent.
// Real humans don't type at a perfectly fixed pace every time.
// ─────────────────────────────────────────────────────────────────────────────
function jitter(baseMs) {
  const variation = Math.floor(Math.random() * 1000) - 500; // -500 to +500ms
  return Math.max(1500, baseMs + variation); // never go below 1500ms
}
 
 
// ─────────────────────────────────────────────────────────────────────────────
// delay — Promise-based sleep utility
// ─────────────────────────────────────────────────────────────────────────────
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}