/**
 * businessHours.js — server-side "is the shop open right now" calculation
 *
 * LLMs have no built-in awareness of the actual current time unless it's
 * explicitly given to them, and are unreliable at precise time-window
 * arithmetic even when it is. Without this, the bot could confidently claim
 * "we're open now" at 8am simply because nothing in its prompt said
 * otherwise — it would be pattern-completing a plausible-sounding answer,
 * not checking anything real. Computing the actual answer here, in code,
 * and handing the LLM a plain fact to read (open/closed, current local
 * time) removes that guesswork entirely — consistent with how pricing and
 * escalation decisions are also computed in code rather than left to the
 * LLM to work out on its own.
 *
 * OPERATING_HOURS_LABEL below is the single source of truth for the actual
 * hours — prompt.js interpolates it rather than stating "10:00am - 9:30pm"
 * as separate free-standing text, so the two can't silently drift apart if
 * hours ever change.
 */

const TIMEZONE = 'Asia/Kuala_Lumpur'; // Malaysia, UTC+8, no DST
const OPEN_MINUTES  = 10 * 60;        // 10:00am
const CLOSE_MINUTES = 21 * 60 + 30;   // 9:30pm
const CLOSING_SOON_WINDOW_MINUTES = 30;

export const OPERATING_HOURS_LABEL = '10:00am to 9:30pm, every day including Sundays';


// ─────────────────────────────────────────────────────────────────────────────
// getBusinessTimeContext — the actual open/closed calculation
//
// now defaults to the real current time — accepts an explicit Date so tests
// can check specific moments (midnight, exact opening/closing boundaries,
// a UTC date-line crossing) deterministically rather than depending on
// whatever time it happens to be when the test runs.
// ─────────────────────────────────────────────────────────────────────────────
export function getBusinessTimeContext(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const get = (type) => parts.find(p => p.type === type)?.value;
  const weekday = get('weekday');
  const minutesSinceMidnight = Number(get('hour')) * 60 + Number(get('minute'));

  const isOpen = minutesSinceMidnight >= OPEN_MINUTES && minutesSinceMidnight < CLOSE_MINUTES;
  const minutesUntilClose = isOpen ? CLOSE_MINUTES - minutesSinceMidnight : null;
  const isClosingSoon = isOpen && minutesUntilClose <= CLOSING_SOON_WINDOW_MINUTES;

  const displayTime = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(now);

  return { weekday, displayTime, isOpen, isClosingSoon, minutesUntilClose };
}


// ─────────────────────────────────────────────────────────────────────────────
// formatBusinessTimeContext — turn the calculation into a block of prompt
// text. Framed as a live fact the LLM must defer to, not something it can
// override with its own reasoning — mirrors how formatPricingContext (see
// pricing.js) states its "don't guess" rule directly alongside the data
// rather than relying on a rule stated once, far away, elsewhere in the
// prompt.
// ─────────────────────────────────────────────────────────────────────────────
export function formatBusinessTimeContext(now = new Date()) {
  const ctx = getBusinessTimeContext(now);

  let status;
  if (!ctx.isOpen) {
    status = 'CLOSED right now';
  } else if (ctx.isClosingSoon) {
    status = `OPEN right now, but closing soon (in about ${ctx.minutesUntilClose} minutes)`;
  } else {
    status = 'OPEN right now';
  }

  return `## CURRENT TIME — LIVE, DO NOT GUESS OR OVERRIDE THIS

It is currently ${ctx.weekday}, ${ctx.displayTime} (Malaysia time). The shop is ${status}. Operating hours are ${OPERATING_HOURS_LABEL}.

Trust this over any assumption you might otherwise make. If the shop is closed, do not say "we're open" or invite the customer to come in right now — let them know normal hours and that the team will follow up, or that they're welcome once the shop reopens. If closing soon, mention that plainly if it's relevant to what they're asking (e.g. before telling them to come in today).`;
}
