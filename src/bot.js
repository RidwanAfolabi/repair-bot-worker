/**
 * bot.js — AI bot handler
 *
 * For each incoming message:
 *   1. Checks for staff commands (!pause, !resume)
 *   2. Checks if sender is escalated — stays silent if so
 *   3. Debounce — waits MESSAGE_DEBOUNCE_MS, then bails if a newer message
 *      from this sender has since arrived (see the comment at that step)
 *   4. AI disclosure notice — sends a fixed-string transparency notice if
 *      this customer is brand new or returning after AI_NOTICE_DAYS (14) of
 *      silence, mirroring the WhatsApp Business App greeting's own timing.
 *      See the AI DISCLOSURE NOTICE block below for why it is sent from
 *      here rather than by the app's built-in greeting feature
 *   5. Fetches recent conversation history from D1
 *   6. Pricing lookup — matches a brand tab (falling back unconditionally
 *      to a brand mentioned earlier in history if the current message has
 *      none of its own), or the fallback tab for a device-agnostic
 *      enquiry, and builds pricing context (see pricing.js matchBrandTab /
 *      matchBrandFromHistory / findFallbackTab / looksLikeDeviceAgnosticEnquiry)
 *   7. Calls the configured LLM (see llm.js) with history + new message +
 *      pricing context
 *   8. Extracts a completed repair booking from the reply if A'aisyah just
 *      closed one out, and strips its [INTAKE] marker block so the marker
 *      reaches neither D1 nor the customer (see parseIntakeBlock)
 *   9. Saves reply to D1
 *  10. Records the booking in the intakes table and alerts staff, same as
 *      an escalation alert. Runs early for the same budget reason as below
 *  11. Detects escalation trigger in reply — auto-mutes (self-resolving
 *      after MUTE_WINDOW_MINUTES, not permanent) and alerts staff if found.
 *      Runs BEFORE the human-paced sends below, while the invocation still
 *      has most of Cloudflare's 30s waitUntil() budget left, rather than
 *      risking cancellation after ~16s of pacing delays
 *  12. Sends reply in natural parts with human-paced delays — told to
 *      bypass its own escalation guard when this exact reply is the one
 *      that just triggered step 11, so the escalation notice always reaches
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
  getLastEngagementAt,
  getSetting,
  setSetting,
  getActiveMutes,
  saveIntake,
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

import { samePhone } from './phone.js';


// ─────────────────────────────────────────────────────────────────────────────
// AI DISCLOSURE NOTICE
//
// Sent once to a customer who is either brand new or returning after a long
// gap, before anything else in the conversation. Mirrors the timing of the
// WhatsApp Business App's own built-in greeting (new contact, or no activity
// for 14 days) but is sent server-side from here instead.
//
// WHY NOT THE BUILT-IN GREETING: that one is sent by the phone, which is why
// it silently does nothing when the phone is offline. Worse, being a
// device-sent message it arrives back as an smb_message_echoes webhook, and
// index.js calls refreshAutoMute() on every echo — so an auto-greeting would
// mute this bot for MUTE_WINDOW_MINUTES at the exact moment a new customer
// starts talking.
//
// These are FIXED STRINGS on purpose, never LLM-generated. A disclosure that
// can be re-worded by the model is a disclosure that can drift, hedge, or be
// dropped entirely on a bad generation.
//
// Deliberately NOT saved to conversations: it is boilerplate the customer
// never wrote and never replied to, and leaving it out keeps it from eating
// history slots and from tempting the LLM to echo it back later. It also
// keeps the "has this customer been here before" check below honest, since
// that check reads the same table.
// ─────────────────────────────────────────────────────────────────────────────
const PRIVACY_POLICY_URL = 'https://ifixexpress.com.my/privacy-policy';

const AI_NOTICE_EN =
  `Hi! Welcome to iFix Express 👋\n\n` +
  `Quick heads up, replies here may come from our AI assistant, A'aisyah. Our team reads every chat and can step in anytime.\n\n` +
  `We keep your messages to handle your enquiry and follow up on your repair. Please don't send IC numbers, bank card details or passwords here.\n\n` +
  `More on how we handle your info: ${PRIVACY_POLICY_URL}`;

const AI_NOTICE_BM =
  `Salam, selamat datang ke iFix Express 👋\n\n` +
  `Just nak bagitahu, balasan di sini mungkin datang dari AI assistant kami, A'aisyah. Team kami baca semua chat dan boleh masuk bila-bila masa.\n\n` +
  `Mesej Cik kami simpan untuk urus pertanyaan dan follow up repair. Jangan hantar no IC, detail kad bank atau password di sini ya.\n\n` +
  `Maklumat lanjut tentang data Cik: ${PRIVACY_POLICY_URL}`;

// Words that clearly signal one language and are unlikely to appear in the
// other. Deliberately small and high-precision rather than exhaustive —
// this only picks which of two fixed notices to send, and the AI reply that
// follows does its own proper language matching regardless (see prompt.js
// "## LANGUAGE"), so a wrong call here costs one slightly-off message, not
// a wrong-language conversation.
const BM_MARKERS = [
  'salam', 'assalam', 'berapa', 'harga', 'boleh', 'nak', 'saya', 'ada', 'tak',
  'macam', 'kena', 'buat', 'rosak', 'baiki', 'tukar', 'skrin', 'bateri',
  'bila', 'mana', 'camne', 'utk', 'dgn', 'je', 'ni', 'tu',
];

const EN_MARKERS = [
  'how much', 'price', 'the', 'is', 'my', 'you', 'can i', 'do you',
  'screen', 'battery', 'repair', 'fix', 'cost', 'available', 'change',
];

// Defaults to BM — the shop is in Kedah and Penang and most customers open
// in Malay or Manglish. English is chosen only on a clear English signal
// with no competing Malay one, so an ambiguous opener like "Hi" stays BM.
function pickNoticeLanguage(text) {
  const t = (text ?? '').toLowerCase();
  const bmHits = BM_MARKERS.filter(w => t.includes(w)).length;
  const enHits = EN_MARKERS.filter(w => t.includes(w)).length;
  return enHits > 0 && bmHits === 0 ? AI_NOTICE_EN : AI_NOTICE_BM;
}

// Sent as ONE message rather than through sendInParts. It is a notice, not
// conversation, so it should read as a single distinct block, and splitting
// it into four human-paced sends would burn ~10s of Cloudflare's 30s
// waitUntil() budget before the actual reply has even been generated.
async function maybeSendAiNotice({ senderId, incomingText, env }) {
  const windowDays   = Number(env.AI_NOTICE_DAYS ?? 14);
  const lastRepliedAt = await getLastEngagementAt(env.DB, senderId);

  const isNew       = lastRepliedAt == null;
  const isReturning = lastRepliedAt != null &&
                      (Math.floor(Date.now() / 1000) - lastRepliedAt) > windowDays * 86400;

  if (!isNew && !isReturning) return false;

  await sendTextMessage(senderId, pickNoticeLanguage(incomingText), env);
  console.log(`[Bot] Sent AI disclosure notice to ${senderId} (${isNew ? 'new customer' : `returning after ${windowDays}+ days`})`);
  return true;
}


// ─────────────────────────────────────────────────────────────────────────────
// handleIncomingMessage — main entry point called from index.js
//
// Only called with clean text at this point — all media routing happens
// upstream in index.js before this is invoked.
// ─────────────────────────────────────────────────────────────────────────────
export async function handleIncomingMessage({ senderId, incomingText, env, messageRowId }) {

  // ── 1. Staff commands — from manager's personal number ───────────────────
  if (samePhone(senderId, env.STAFF_WA_NUMBER)) {
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

  // ── 4. AI disclosure notice — new customer, or back after a long gap ─────
  // Placed after the debounce on purpose: a customer opening with three
  // rapid messages produces three invocations, and only the last one gets
  // past the debounce, so the notice goes out exactly once per burst rather
  // than three times. Failure here is non-fatal — a customer who misses the
  // notice should still get helped, so this never blocks the reply below.
  try {
    await maybeSendAiNotice({ senderId, incomingText, env });
  } catch (err) {
    console.error('[Bot] AI disclosure notice failed to send:', err.message);
  }

  // ── 5. Fetch recent conversation history ──────────────────────────────────
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

  // ── 6. Pricing lookup — brand detected anywhere in the message ───────────
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

  // ── 7. Call the LLM (provider set via LLM_PROVIDER — see llm.js) ─────────
  let aiReply;
  try {
    aiReply = await generateReply(history, incomingText, env, pricingContext);
  } catch (err) {
    console.error(`[Bot] LLM error (${env.LLM_PROVIDER ?? 'gemini'}):`, err.message);
    aiReply = 'Maaf, ada gangguan teknikal sebentar. Team kami akan balas anda tidak lama lagi! 🙏';
  }

  // ── 8. Extract a completed booking, and strip its marker from the reply ──
  // Runs before the save below so the [INTAKE] block never enters
  // conversation history — see parseIntakeBlock for why that matters.
  // aiReply is reassigned to the cleaned text from here on, so every
  // downstream step (save, escalation check, send) works on what the
  // customer will actually see.
  const { intake, cleanedReply } = parseIntakeBlock(aiReply);
  aiReply = cleanedReply;

  // ── 9. Save bot reply ─────────────────────────────────────────────────────
  await saveMessage(env.DB, { senderId, role: 'ai-assistant', text: aiReply });

  // ── 10. Record the booking and tell staff ────────────────────────────────
  // Placed here for the same reason as the escalation block below: the D1
  // write and the staff alert are the parts that must not be lost, so they
  // run while the invocation still has most of its waitUntil() budget rather
  // than after ~16s of human-paced sends. Wrapped so a failure here can
  // never cost the customer their reply — they were just told their booking
  // is confirmed, and going silent on them would be the worst outcome.
  if (intake) {
    // Save and alert are deliberately INDEPENDENT, not chained. They were
    // chained once, and a single schema mismatch inside saveIntake silently
    // took the staff alert down with it: the customer was told their booking
    // was confirmed and nobody at the shop ever heard about it. Of the two,
    // the alert is the half with a human on the end, so it goes out even
    // when persistence fails — and says so, see formatIntakeAlert.
    let saveFailed = false;

    try {
      const intakeId = await saveIntake(env.DB, { senderId, ...intake });
      console.log(`[Bot] Recorded intake #${intakeId} for ${senderId} — fields: ${Object.keys(intake).join(', ')}`);
    } catch (err) {
      saveFailed = true;
      console.error(`[Bot] Intake save failed for ${senderId} (alerting staff anyway):`, err.message);
    }

    try {
      await sendStaffAlert(formatIntakeAlert(senderId, intake, saveFailed), env);
    } catch (err) {
      console.error(`[Bot] Intake staff alert failed for ${senderId}:`, err.message);
    }
  }

  // ── 11. Detect escalation trigger and mute/alert EARLY ────────────────────
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
    const windowMinutes = Number(env.MUTE_WINDOW_MINUTES ?? 2); // default is 75 for now, just testing with short duration minutes
    await sendStaffAlert(
      `🚨 *Customer needs attention*\n\n` +
      `*Number:* +${senderId}\n` +
      `*Last message:* "${incomingText}"\n\n` +
      `👉 Open *WhatsApp Business App* and reply to this customer directly.\n\n` +
      `🤖 AI auto-reply is paused for this customer for ${windowMinutes} minutes, then resumes on its own if untouched.\n` +
      `Replying via the app resets that timer. To keep it off indefinitely instead, send *!pause ${senderId}* — or *!resume ${senderId}* to bring it back sooner.`,
      env
    );
    console.log(`[Bot] Escalated ${senderId} to staff (auto mute, ${windowMinutes}m)`);
  }

  // ── 12. Send in natural parts with human-paced delays ─────────────────────
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
// parseIntakeBlock — pull a completed repair booking out of A'aisyah's reply
//
// When she finishes taking a booking she appends a machine-readable block to
// her confirmation message (see prompt.js "## RECORDING A COMPLETED BOOKING"):
//
//   [INTAKE]
//   name: Amin
//   device: iPhone 12
//   fault: Skrin pecah
//   branch: Sungai Petani
//   contact: 0123456789
//   time: Esok pagi
//   [/INTAKE]
//
// Asking the model to emit structured fields and parsing them deterministically
// beats regexing a free-text confirmation, and costs nothing extra — the
// alternative, a second LLM call just to extract fields, would add latency to
// an invocation already sharing Cloudflare's 30s waitUntil() budget with the
// debounce and the human-paced sends.
//
// Returns { intake, cleanedReply }. intake is null when no block is present,
// which is the case for the overwhelming majority of replies. cleanedReply
// ALWAYS has the block stripped, whether or not parsing found usable fields —
// a malformed block must never reach the customer, and stripping is therefore
// deliberately more aggressive than parsing.
//
// The stripped reply is what gets saved to D1 and sent, so the block never
// enters conversation history. That also stops the model seeing its own past
// blocks and re-emitting one for a booking it already recorded.
// ─────────────────────────────────────────────────────────────────────────────
const INTAKE_BLOCK = /\[INTAKE\]([\s\S]*?)(?:\[\/INTAKE\]|$)/i;

const INTAKE_FIELDS = {
  name:    'customerName',
  device:  'deviceModel',
  fault:   'fault',
  branch:  'branch',
  contact: 'contact',
  time:    'preferredTime',
};

export function parseIntakeBlock(reply) {
  const text  = reply ?? '';
  const match = text.match(INTAKE_BLOCK);

  // Strip first and unconditionally — even an unterminated or garbled block
  // must not survive into the customer-facing message.
  const cleanedReply = text.replace(INTAKE_BLOCK, '').replace(/\n{3,}/g, '\n\n').trim();

  if (!match) return { intake: null, cleanedReply };

  const intake = {};
  for (const line of match[1].split('\n')) {
    const pair = line.match(/^\s*([a-z_]+)\s*:\s*(.+?)\s*$/i);
    if (!pair) continue;

    const field = INTAKE_FIELDS[pair[1].toLowerCase()];
    // Models sometimes fill a field it has no answer for with a dash or
    // "N/A" rather than omitting the line — treat those as absent.
    const value = pair[2].trim();
    if (field && value && !/^(-+|n\/?a|none|null|tbc)$/i.test(value)) {
      intake[field] = value;
    }
  }

  // A block with no usable field at all is noise, not a booking.
  return { intake: Object.keys(intake).length > 0 ? intake : null, cleanedReply };
}


// ─────────────────────────────────────────────────────────────────────────────
// formatIntakeAlert — the staff notification for a new booking
//
// Same shape as the escalation alert above so both read as one system in the
// manager's chat. Fields the customer never gave are simply left out rather
// than shown as empty, so the alert stays scannable on a phone.
// ─────────────────────────────────────────────────────────────────────────────
function formatIntakeAlert(senderId, intake, saveFailed = false) {
  const rows = [
    ['Customer',       intake.customerName],
    ['Device',         intake.deviceModel],
    ['Fault',          intake.fault],
    ['Branch',         intake.branch],
    ['Contact',        intake.contact],
    ['Preferred time', intake.preferredTime],
  ].filter(([, value]) => value);

  // When the row could not be persisted the alert becomes the ONLY record of
  // this booking, so it has to say so plainly rather than claiming it was
  // saved. The customer has already been told they are booked either way.
  const footer = saveFailed
    ? `\n\n⚠️ *Could not save this to the database.* This message is the only record, please write these details down.`
    : `\n\n🤖 Taken by A'aisyah and saved. Reply via *WhatsApp Business App* if anything needs confirming.`;

  return (
    `📋 *New repair booking*\n\n` +
    `*WhatsApp:* +${senderId}\n` +
    rows.map(([label, value]) => `*${label}:* ${value}`).join('\n') +
    footer
  );
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
      `✅ AI auto-reply paused for +${target} (stays off until !resume — no auto-resume).\nOpen WhatsApp Business App to reply to them directly.`,
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
    await sendTextMessage(replyTo, `✅ AI auto-reply resumed for +${target}.`, env);
    // No message sent to the customer here — resuming silently. A'aisyah
    // will only speak again once the customer sends their next message.
    return true;
  }

  if (cmd === '!pauseall') {
    await setSetting(env.DB, 'bot_enabled', 'false');
    await sendTextMessage(replyTo, `🔴 AI auto-reply paused for ALL customers.\nSend !resumeall to turn back on.`, env);
    return true;
  }

  if (cmd === '!resumeall') {
    await setSetting(env.DB, 'bot_enabled', 'true');
    await sendTextMessage(replyTo, `🟢 AI auto-reply resumed for all customers.`, env);
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
      `📊 *AI Auto-Reply Status*\n\n` +
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