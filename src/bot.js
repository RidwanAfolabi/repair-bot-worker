/**
 * bot.js — AI bot handler
 *
 * For each incoming message:
 *   1. Checks for staff commands (!pause, !resume)
 *   2. Checks if sender is escalated — stays silent if so
 *   3. Debounce — waits MESSAGE_DEBOUNCE_MS, then bails if a newer message
 *      from this sender has since arrived (see the comment at that step)
 *   4. Fetches recent conversation history from D1
 *   5. Pricing lookup — matches a brand tab (falling back unconditionally
 *      to a brand mentioned earlier in history if the current message has
 *      none of its own), or the fallback tab for a device-agnostic
 *      enquiry, and builds pricing context (see pricing.js matchBrandTab /
 *      matchBrandFromHistory / findFallbackTab / looksLikeDeviceAgnosticEnquiry)
 *   6. Calls the configured LLM (see llm.js) with history + new message +
 *      pricing context
 *   7. Saves reply to D1
 *   8. Detects escalation trigger in reply — auto-mutes (self-resolving
 *      after MUTE_WINDOW_MINUTES, not permanent) and alerts staff if found.
 *      Runs BEFORE the human-paced sends below, while the invocation still
 *      has most of Cloudflare's 30s waitUntil() budget left, rather than
 *      risking cancellation after ~16s of pacing delays
 *   9. Sends reply in natural parts with human-paced delays — told to
 *      bypass its own escalation guard when this exact reply is the one
 *      that just triggered step 8, so the escalation notice always reaches
 *      the customer instead of getting caught by its own just-set mute
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
  refreshAutoMute,
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
  matchBrandFromHistory,
  findFallbackTab,
  looksLikeDeviceAgnosticEnquiry,
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
  //
  // Default trimmed from 5000ms to 4000ms — this delay, plus sendInParts'
  // human-paced sends further down, all share Cloudflare's 30-second
  // waitUntil() ceiling (counted from webhook receipt, not from here) —
  // see the sendInParts comment for the full budget breakdown. Shrinking
  // this loses a little burst-catching margin for rapid-fire messages sent
  // further apart than 4s, in exchange for headroom against that ceiling.
  if (messageRowId != null) {
    await delay(Number(env.MESSAGE_DEBOUNCE_MS ?? 4000));

    const latestId = await getLatestUserMessageId(env.DB, senderId);
    if (latestId != null && latestId > messageRowId) {
      console.log(`[Bot] ${senderId} sent a newer message during debounce — skipping, latest invocation will reply for the whole burst`);
      return;
    }
  }

  // ── 4. Fetch recent conversation history ──────────────────────────────────
  // Default 32 messages (16 exchanges) — raised from 16 after a real
  // conversation confirmed the failure mode directly: a customer stated
  // their branch in their very first message, and much later in a long
  // conversation asked about location again, the LLM had no memory of it
  // and asked which area they were in, having already scrolled past the
  // 16-message window. This is a plain SQL LIMIT — a conversation shorter
  // than the limit just returns what exists, so this only costs anything
  // (more tokens, slightly higher LLM latency) for conversations that
  // actually run this long; short ones are unaffected either way. Tune via
  // HISTORY_MESSAGE_LIMIT if that cost becomes a concern, or if
  // conversations regularly run even longer than this.
  // History includes D1 records of [Customer sent image] events so Gemini
  // is aware that media was sent even if it couldn't read it. Thanks to the
  // debounce above, this also naturally covers every message in a rapid
  // burst — not just the latest one.
  const history = await getRecentMessages(env.DB, senderId, Number(env.HISTORY_MESSAGE_LIMIT ?? 32));

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
  // No brand in the current message → check recent history for the last
  // brand mentioned and reuse that tab, unconditionally (no length/keyword
  // gate on when to try this). Fixes a real gap: a brand named at the start
  // of a conversation used to become unreachable the moment a later message
  // didn't repeat it, even though the conversation was still clearly about
  // that device — the LLM would lose the ability to quote a price it could
  // see moments earlier. Bounded by the same history window already
  // fetched above (HISTORY_MESSAGE_LIMIT) — once the mention scrolls out,
  // this naturally stops finding it too, no separate expiry needed.
  //
  // Deliberately not gated by message length or a "does this look like a
  // follow-up" heuristic — a rule-based gate here risks under-triggering on
  // a genuine continuation, and a missed continuation means no pricing data
  // reaches the LLM, which is a worse failure mode (it may escalate
  // unnecessarily, thinking it has nothing to offer) than the cost of an
  // occasional irrelevant price list on an unrelated message. That cost is
  // already covered by formatPricingContext's "if nothing here clearly
  // matches, treat as unknown" instruction, which keeps the LLM from
  // actually answering with mismatched data.
  //
  // No brand match (current or history), but the message only needs a
  // device-agnostic answer (see looksLikeDeviceAgnosticEnquiry in
  // pricing.js — cables, protectors, deposits, chargers) → fetch just the
  // fallback tab, same as before.
  //
  // No brand match AND not device-agnostic (e.g. "berapa harga tukar
  // skrin" — a real repair question, just missing which device) →
  // pricingContext stays empty on purpose. Fetching the fallback tab here
  // would only hand the LLM irrelevant accessories data and risk it trying
  // to answer from that instead of asking for the device — see the
  // "## ASKING FOR DEVICE DETAILS" prompt section, which is what actually
  // handles this case now.
  //
  // Any failure here (sheet unreachable, no match, bad auth) falls back to
  // an empty pricingContext — the LLM still replies from its own prompt/
  // history, just without live pricing to reference for this message.
  let pricingContext = '';
  try {
    const tabs = await getSheetTabs(env);
    let brandTab = matchBrandTab(incomingText, tabs);

    if (!brandTab) {
      brandTab = matchBrandFromHistory(history, tabs);
      if (brandTab) {
        console.log(`[Bot] ${senderId} — no brand in current message, reusing "${brandTab}" from earlier in the conversation`);
      }
    }

    const fallbackTab = findFallbackTab(tabs);

    let targetTabs = [];
    if (brandTab) {
      targetTabs = fallbackTab ? [brandTab, fallbackTab] : [brandTab];
    } else if (looksLikeDeviceAgnosticEnquiry(incomingText)) {
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
  await saveMessage(env.DB, { senderId, role: 'ai-assistant', text: aiReply });

  // ── 8. Detect escalation trigger and mute/alert EARLY ────────────────────
  // Moved ahead of sendInParts (used to run after it) so the actual mute D1
  // write and staff alert happen while the invocation still has nearly the
  // full 30s waitUntil() budget available, rather than being squeezed in
  // after ~16s of human-paced sends plus a variable-length LLM call. A slow
  // reply used to risk Cloudflare cancelling this step entirely — the bot
  // would tell the customer it's escalating, but never actually mute or
  // notify staff. See the sendInParts comment for the full budget picture.
  //
  // Auto mute, not manual — the bot decided this on its own (unknown price,
  // ambiguous message, etc.), so it should be able to try again once
  // MUTE_WINDOW_MINUTES passes, rather than staying silent for that customer
  // forever unless staff remembers to type !resume. If staff genuinely wants
  // it to stay off, that's what !pause is for — refreshAutoMute already
  // preserves an existing, currently-active 'manual' mute rather than
  // downgrading it (see db.js), so a !pause always wins over this. If the
  // bot escalates again after resuming (still can't help), this fires again
  // and simply resets the same timer — see the ## ESCALATION prompt note
  // about not repeating the exact same message verbatim on a repeat.
  const willEscalate = shouldEscalate(aiReply);
  if (willEscalate) {
    await refreshAutoMute(env.DB, senderId);
    const windowMinutes = Number(env.MUTE_WINDOW_MINUTES ?? 1); // default is 75 for now, just testing with 1 minute
    await sendStaffAlert(
      `🚨 *Customer needs attention*\n\n` +
      `*Number:* +${senderId}\n` +
      `*Last message:* "${incomingText}"\n\n` +
      `👉 Open *WhatsApp Business App* and reply to this customer directly.\n\n` +
      `🤖 Bot is paused for this customer for ${windowMinutes} minutes, then resumes on its own if untouched.\n` +
      `Replying via the app resets that timer. To keep it off indefinitely instead, send *!pause ${senderId}* — or *!resume ${senderId}* to bring it back sooner.`,
      env
    );
    console.log(`[Bot] Escalated ${senderId} to staff (auto mute, ${windowMinutes}m)`);
  }

  // ── 9. Send in natural parts with human-paced delays ─────────────────────
  // willEscalate is passed through so sendInParts can bypass its own
  // isEscalated guard for THIS specific send — otherwise, now that the mute
  // above runs first, that guard would see its own just-set mute and
  // silently drop the very message announcing it (the bug this ordering
  // originally avoided). Bypassing only when this reply is the one that
  // caused the mute guarantees the escalation notice always reaches the
  // customer; for an ordinary reply the guard stays fully active, still
  // protecting against a genuinely concurrent, unrelated mute (e.g. staff
  // replying via the app mid-send).
  await sendInParts(senderId, aiReply, env, willEscalate);
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
//   First message  — 2–3 seconds (simulates reading the customer's message
//                    and starting to compose a reply)
//   Between parts  — scales with the length of the NEXT chunk
//                    (~55ms per character, capped between 1s and 4s)
//                    longer message = took longer to type
//
// A small random jitter (±500ms) is added to each delay so the timing
// never feels mechanical or perfectly consistent — real humans aren't.
//
// Trimmed 1s off every step of this budget (was 3-5s first message, 2-5s
// between parts) specifically to buy back margin against Cloudflare's 30s
// waitUntil() ceiling — see the MESSAGE_DEBOUNCE_MS comment in
// handleIncomingMessage for the full picture of what shares that budget.
//
// bypassEscalationGuard — true only when this exact reply is the one that
// just triggered escalation (see step 8/9 in handleIncomingMessage, which
// mutes BEFORE calling this). Without it, the guard below would see its
// own just-set mute and drop the very message announcing the escalation.
// For an ordinary reply this stays false and the guard behaves exactly as
// before — still protecting against a genuinely concurrent, unrelated mute
// (e.g. staff replying via the app mid-send).
// ─────────────────────────────────────────────────────────────────────────────
async function sendInParts(to, text, env, bypassEscalationGuard = false) {
  const parts = text
    .split(/\n\n+/)
    .map(p => p.trim())
    .filter(p => p.length > 0);

  // Guards against the customer getting muted (staff took over) mid-send —
  // e.g. staff replies via WhatsApp Business App while A'aisyah is still
  // drip-feeding a multi-part reply. Re-checks escalation state right
  // before each part goes out and drops anything still queued. Skipped
  // entirely when bypassEscalationGuard is true — see above.
  const sendIfStillActive = async (part) => {
    if (!bypassEscalationGuard && await isEscalated(env.DB, to, env)) {
      console.log(`[Bot] ${to} got muted mid-send — dropping remaining reply`);
      return false;
    }
    await sendTextMessage(to, part, env);
    return true;
  };

  // Single part — pause as if reading + composing, then send
  if (parts.length === 1) {
    await delay(jitter(2500));   // ~2–3 seconds before first reply
    await sendIfStillActive(parts[0]);
    return;
  }

  // Multiple parts — stagger with typing-speed delays between each
  for (let i = 0; i < parts.length; i++) {
    if (i === 0) {
      // First message — longer pause (read customer message → start typing)
      await delay(jitter(2500));  // ~2–3 seconds
    } else {
      // Subsequent messages — scale with the length of this part
      // ~55ms per character, capped between 1000ms and 4000ms
      // Then add random jitter so it never feels robotic
      const base = Math.min(4000, Math.max(1000, parts[i].length * 55));
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