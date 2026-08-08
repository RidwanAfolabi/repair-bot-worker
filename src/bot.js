/**
 * bot.js — AI bot handler
 *
 * For each incoming message:
 *   1. Checks for staff commands (!pause, !resume)
 *   2. Checks if sender is escalated — stays silent if so
 *   3. Debounce — waits MESSAGE_DEBOUNCE_MS, then bails if a newer message
 *      from this sender has since arrived (see the comment at that step)
 *   4. Fetches recent conversation history from D1
 *   5. Pricing lookup — matches a brand tab (or the fallback tab for a
 *      generic pricing/repair enquiry) and builds pricing context (see
 *      pricing.js matchBrandTab / findFallbackTab / looksLikePricingEnquiry)
 *   6. Calls the configured LLM (see llm.js) with history + new message +
 *      pricing context
 *   7. Saves reply to D1
 *   8. Sends reply in natural parts with human-paced delays — BEFORE the
 *      escalation mute below, so an escalation notice always reaches the
 *      customer instead of getting caught by its own just-set mute
 *   9. Detects escalation trigger in reply, mutes and alerts staff if found
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
  getLatestUserMessageId,
  getSetting,
  setSetting,
  getActiveMutes,
} from './db.js';

import {
  sendTextMessage,
  sendStaffAlert,
} from './whatsapp.js';

import { generateReply } from './llm.js';

import {
  matchBrandTab,
  findFallbackTab,
  looksLikePricingEnquiry,
  formatPricingContext,
} from './pricing.js';

import { getSheetTabs, getPricingRows } from './googleSheets.js';


// ─────────────────────────────────────────────────────────────────────────────
// handleIncomingMessage — main entry point called from index.js
//
// Only called with clean text at this point — all media routing happens
// upstream in index.js before this is invoked.
// ─────────────────────────────────────────────────────────────────────────────
export async function handleIncomingMessage({ senderId, incomingText, env, messageRowId }) {

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

  // ── 3. Debounce — wait, then bail if a newer message has since arrived ───
  // Each WhatsApp message is its own independent webhook call — nothing
  // otherwise serializes two messages sent seconds apart from the same
  // customer, so both would independently reach the LLM and both would
  // reply, producing two separate (often near-duplicate) replies to what
  // was really one burst of thought from the customer.
  //
  // messageRowId is this message's own conversations.id (see db.js
  // saveMessage / getLatestUserMessageId). After waiting, if a newer user
  // message for this sender now exists, this invocation quietly steps
  // aside — the newest message's own invocation will do the same check,
  // find itself still latest once nothing more arrives, and proceed with
  // getRecentMessages() already covering the whole burst — so the customer
  // gets exactly one reply that accounts for everything they sent.
  //
  // messageRowId may be absent (older callers, or a caption-derived message
  // — see index.js) — debounce is skipped in that case rather than crashing.
  if (messageRowId != null) {
    await delay(Number(env.MESSAGE_DEBOUNCE_MS ?? 5000));

    const latestId = await getLatestUserMessageId(env.DB, senderId);
    if (latestId != null && latestId > messageRowId) {
      console.log(`[Bot] ${senderId} sent a newer message during debounce — skipping, latest invocation will reply for the whole burst`);
      return;
    }
  }

  // ── 4. Fetch recent conversation history ──────────────────────────────────
  // Default 16 messages (8 exchanges) — a real support conversation (device
  // details -> pricing -> branch -> wrap-up) commonly runs 5-8 exchanges, so
  // the previous default of 6 (3 exchanges) was losing the opening context
  // partway through an ordinary conversation, causing the LLM to re-ask
  // things the customer already answered. Higher token cost per call is the
  // tradeoff — tune via HISTORY_MESSAGE_LIMIT if that becomes a concern.
  // History includes D1 records of [Customer sent image] events so Gemini
  // is aware that media was sent even if it couldn't read it. Thanks to the
  // debounce above, this also naturally covers every message in a rapid
  // burst — not just the latest one.
  const history = await getRecentMessages(env.DB, senderId, Number(env.HISTORY_MESSAGE_LIMIT ?? 16));

  // ── 5. Pricing lookup — brand detected anywhere in the message ───────────
  // Fuzzy-matches the message against the spreadsheet's ACTUAL current tab
  // titles (not a hardcoded brand list), so a new brand tab just works with
  // no code change. Triggers on any message mentioning a brand — not just
  // structured template replies — since the LLM now searches the whole
  // matched tab itself rather than relying on code to narrow to one row.
  //
  // ALWAYS includes the Services & Accessories fallback tab alongside a
  // matched brand tab (not only when no brand matches) — a customer asking
  // about, say, an iPhone screen protector or a generic repair charge that
  // hasn't been moved into a brand-specific tab yet still gets found this
  // way, without needing the LLM to ask for more data mid-reply (rejected
  // in favour of this simpler always-include approach — see prior design
  // discussion: the fallback tab is small enough that paying a small,
  // predictable, constant cost on every pricing enquiry beats a second,
  // probabilistic LLM round-trip).
  //
  // No brand AND no pricing/repair signal word (see ENQUIRY_SIGNAL_WORDS in
  // pricing.js) → skipped entirely, e.g. "hi", "what time do you close" —
  // no reason to inject fallback-tab contents into every single message.
  //
  // Any failure here (sheet unreachable, no match, bad auth) falls back to
  // an empty pricingContext — the LLM still replies from its own prompt/
  // history, just without live pricing to reference for this message.
  let pricingContext = '';
  try {
    const tabs = await getSheetTabs(env);
    const brandTab = matchBrandTab(incomingText, tabs);
    const fallbackTab = findFallbackTab(tabs);

    let targetTabs = [];
    if (brandTab) {
      targetTabs = fallbackTab ? [brandTab, fallbackTab] : [brandTab];
    } else if (looksLikePricingEnquiry(incomingText)) {
      targetTabs = fallbackTab ? [fallbackTab] : [];
    }

    if (targetTabs.length > 0) {
      const sections = await Promise.all(
        targetTabs.map(async (tabName) => ({
          tabName,
          rows: await getPricingRows(env, tabName),
        }))
      );

      pricingContext = formatPricingContext(sections);
      const totalRows = sections.reduce((sum, s) => sum + s.rows.length, 0);
      console.log(`[Bot] Pricing lookup for ${senderId} — tabs: ${targetTabs.join(', ')}, rows: ${totalRows}`);
    }
  } catch (err) {
    console.error('[Bot] Pricing lookup failed:', err.message);
  }

  // ── 6. Call the LLM (provider set via LLM_PROVIDER — see llm.js) ─────────
  let aiReply;
  try {
    aiReply = await generateReply(history, incomingText, env, pricingContext);
  } catch (err) {
    console.error(`[Bot] LLM error (${env.LLM_PROVIDER ?? 'gemini'}):`, err.message);
    aiReply = 'Maaf, ada gangguan teknikal sebentar. Team kami akan balas anda tidak lama lagi! 🙏';
  }

  // ── 7. Save bot reply ─────────────────────────────────────────────────────
  await saveMessage(env.DB, { senderId, role: 'assistant', text: aiReply });

  // ── 8. Send in natural parts with human-paced delays ─────────────────────
  // Must happen BEFORE step 9 sets the mute flag below. sendInParts checks
  // isEscalated() before every part it sends (see sendIfStillActive) — if
  // this reply is itself the one that triggers escalation, muting first
  // would make that check see its own just-set mute and silently drop the
  // very message that's supposed to tell the customer "connecting you now."
  // Sending first guarantees the escalation notice always reaches them; the
  // mute then only affects whatever comes after it.
  await sendInParts(senderId, aiReply, env);

  // ── 9. Detect escalation trigger in reply ────────────────────────────────
  if (shouldEscalate(aiReply)) {
    await setManualMute(env.DB, senderId);
    await sendStaffAlert(
      `🚨 *Customer needs attention*\n\n` +
      `*Number:* +${senderId}\n` +
      `*Last message:* "${incomingText}"\n\n` +
      `👉 Open *WhatsApp Business App* and reply to this customer directly.\n\n` +
      `🤖 Bot is now *paused* — they will only see your replies.\n\n` +
      `When done, send:\n*!resume ${senderId}*\n...and the bot will resume.`,
      env
    );
    console.log(`[Bot] Escalated ${senderId} to staff`);
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// shouldEscalate — detect escalation phrase in A'aisyah's reply
// Must match the exact phrase defined in prompt.js buildSystemPrompt()
// ─────────────────────────────────────────────────────────────────────────────
function shouldEscalate(reply) {
  return reply.toLowerCase().includes('biar saya check dan update balik');
}


// ─────────────────────────────────────────────────────────────────────────────
// handleStaffCommand — shared parser for staff commands, called from both
// STAFF_WA_NUMBER text messages (bot.js) and smb_message_echoes self-chat
// notes (index.js). replyTo defaults to STAFF_WA_NUMBER but is decoupled
// from the command's source so both channels can confirm to the same place.
//
// Per-customer:
//   !pause 60123456789   — manually pause bot for one customer, indefinite
//   !resume 60123456789  — resume bot for one customer
//
// Global (instant, no deploy needed — separate from BOT_ENABLED in
// wrangler.jsonc, which remains a developer-level emergency stop underneath
// this):
//   !pauseall   — pause bot for every customer at once
//   !resumeall  — resume bot for every customer
//
// Visibility:
//   !status  — global state, LLM provider, count of paused customers
//   !muted   — list of currently paused customers, with mute type and age
//   !help    — this command list
//
// Returns true if the text was a recognised command, false otherwise.
// ─────────────────────────────────────────────────────────────────────────────
export async function handleStaffCommand(text, env, replyTo = env.STAFF_WA_NUMBER) {
  const parts  = text.trim().split(/\s+/);
  const cmd    = parts[0]?.toLowerCase();
  const target = parts[1];

  if (cmd === '!pause') {
    if (!target) {
      await sendTextMessage(replyTo, `⚠️ Missing number. Usage: !pause <number>\nExample: !pause 60123456789`, env);
      return true;
    }
    await setManualMute(env.DB, target);
    await sendTextMessage(
      replyTo,
      `✅ Bot paused for +${target} (stays off until !resume — no auto-resume).\nOpen WhatsApp Business App to reply to them directly.`,
      env
    );
    return true;
  }

  if (cmd === '!resume') {
    if (!target) {
      await sendTextMessage(replyTo, `⚠️ Missing number. Usage: !resume <number>\nExample: !resume 60123456789`, env);
      return true;
    }
    await resolveEscalation(env.DB, target);
    await sendTextMessage(replyTo, `✅ Bot resumed for +${target}.`, env);
    // No message sent to the customer here — resuming silently. A'aisyah
    // will only speak again once the customer sends their next message.
    return true;
  }

  if (cmd === '!pauseall') {
    await setSetting(env.DB, 'bot_enabled', 'false');
    await sendTextMessage(replyTo, `🔴 Bot paused for ALL customers.\nSend !resumeall to turn back on.`, env);
    return true;
  }

  if (cmd === '!resumeall') {
    await setSetting(env.DB, 'bot_enabled', 'true');
    await sendTextMessage(replyTo, `🟢 Bot resumed for all customers.`, env);
    return true;
  }

  if (cmd === '!status') {
    const globalSetting = await getSetting(env.DB, 'bot_enabled');
    const globallyOn = globalSetting !== 'false' && env.BOT_ENABLED !== 'false';
    const mutes = await getActiveMutes(env.DB, env);
    const manualCount = mutes.filter(m => m.mute_type === 'manual').length;
    const autoCount   = mutes.filter(m => m.mute_type === 'auto').length;

    await sendTextMessage(
      replyTo,
      `📊 *Bot Status*\n\n` +
      `Global: ${globallyOn ? '🟢 ON' : '🔴 OFF'}\n` +
      `LLM: ${env.LLM_PROVIDER ?? 'gemini'}\n` +
      `Paused customers: ${mutes.length} (${manualCount} manual, ${autoCount} auto-timing-out)`,
      env
    );
    return true;
  }

  if (cmd === '!muted') {
    const mutes = await getActiveMutes(env.DB, env);

    if (mutes.length === 0) {
      await sendTextMessage(replyTo, `No customers currently paused.`, env);
      return true;
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const lines = mutes.map(m => {
      const minutesAgo = Math.floor((nowSeconds - m.escalated_at) / 60);
      const typeLabel  = m.mute_type === 'manual' ? 'manual' : 'auto';
      return `+${m.sender_id} — ${typeLabel}, ${minutesAgo}m ago`;
    });

    await sendTextMessage(replyTo, `🔇 *Paused customers*\n\n${lines.join('\n')}`, env);
    return true;
  }

  if (cmd === '!help') {
    await sendTextMessage(
      replyTo,
      `🤖 *A'aisyah Commands*\n\n` +
      `!pause <number> — pause bot for one customer (stays off until !resume)\n` +
      `!resume <number> — resume bot for one customer\n\n` +
      `!pauseall — pause bot for EVERYONE, instantly\n` +
      `!resumeall — resume bot for everyone\n\n` +
      `!status — quick overview\n` +
      `!muted — list currently paused customers\n` +
      `!help — this message`,
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