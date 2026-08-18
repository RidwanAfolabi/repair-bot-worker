/**
 * phone.js — tolerant phone-number matching for the number lists in config
 *
 * WhatsApp always delivers a sender as bare digits in international format
 * ("601155241769"): no plus, no spaces, no dashes. The lists it gets compared
 * against — TEST_ALLOWLIST, DELISTED_NUMBERS, STAFF_WA_NUMBER — are typed by
 * a person into wrangler.jsonc or the Cloudflare dashboard, where writing
 * "+60 11-5524 1769" is the natural thing to do.
 *
 * Comparing those two strings literally fails silently, and fails OPEN: a
 * delisted customer keeps receiving AI replies, a staff number stops being
 * recognised as staff, and nothing in the logs explains why, because from the
 * code's point of view the number simply was not in the list. That exact bug
 * reached production with a delisted number that kept getting replies.
 *
 * Reducing both sides to digits before comparing makes the configuration
 * format-agnostic, so however the number is written it still matches.
 */


// ─────────────────────────────────────────────────────────────────────────────
// digitsOnly — reduce any phone-number-ish string to bare digits.
// "+60 11-5524 1769" -> "601155241769"
// ─────────────────────────────────────────────────────────────────────────────
export function digitsOnly(value) {
  return String(value ?? '').replace(/\D/g, '');
}


// ─────────────────────────────────────────────────────────────────────────────
// phoneList — parse a comma-separated config value into comparable numbers.
// Empty/undefined yields an empty list, so an unset variable blocks nobody
// and allows nobody, exactly as before.
// ─────────────────────────────────────────────────────────────────────────────
export function phoneList(raw) {
  return String(raw ?? '')
    .split(',')
    .map(digitsOnly)
    .filter(Boolean);
}


// ─────────────────────────────────────────────────────────────────────────────
// samePhone — compare two individual numbers regardless of how each is
// written. Returns false if either side is empty, so an unset STAFF_WA_NUMBER
// never accidentally matches a customer whose id also normalises to "".
// ─────────────────────────────────────────────────────────────────────────────
export function samePhone(a, b) {
  const left  = digitsOnly(a);
  const right = digitsOnly(b);
  return left !== '' && left === right;
}
