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
// BSUIDs — WhatsApp usernames
//
// Since mid-2026 a customer can adopt a WhatsApp username and hide their phone
// number from businesses. Meta then omits messages[].from and contacts[].wa_id
// entirely and identifies them by a Business-Scoped User ID instead: an ISO
// two-letter country code, a dot, then an alphanumeric string, e.g.
// "US.13491208655302741918" (or "US.ENT.…" for a parent id).
//
// These MUST NOT go through digitsOnly(). Stripping non-digits from
// "US.13491208655302741918" yields "13491208655302741918" — a plausible-looking
// 20-digit phone number that is not a phone number at all, which would make
// allowlist and delist matching quietly nonsensical. A BSUID is compared
// literally instead.
// ─────────────────────────────────────────────────────────────────────────────
const BSUID_PATTERN = /^[A-Z]{2}\.[A-Za-z0-9.]{1,125}$/i;

export function isBsuid(value) {
  return BSUID_PATTERN.test(String(value ?? '').trim());
}


// ─────────────────────────────────────────────────────────────────────────────
// digitsOnly — reduce any phone-number-ish string to bare digits.
// "+60 11-5524 1769" -> "601155241769"
// ─────────────────────────────────────────────────────────────────────────────
export function digitsOnly(value) {
  return String(value ?? '').replace(/\D/g, '');
}


// ─────────────────────────────────────────────────────────────────────────────
// normalizeId — the comparable form of any customer identifier, phone or
// BSUID. This is what every list/equality check below runs on, so a config
// entry and a live sender are always reduced the same way.
// ─────────────────────────────────────────────────────────────────────────────
export function normalizeId(value) {
  const raw = String(value ?? '').trim();
  return isBsuid(raw) ? raw.toUpperCase() : digitsOnly(raw);
}


// ─────────────────────────────────────────────────────────────────────────────
// phoneList — parse a comma-separated config value into comparable ids.
// Accepts phone numbers in any format AND BSUIDs, so a username-only customer
// can still be delisted by pasting their user_id into DELISTED_NUMBERS.
// Empty/undefined yields an empty list, so an unset variable blocks nobody
// and allows nobody, exactly as before.
// ─────────────────────────────────────────────────────────────────────────────
export function phoneList(raw) {
  return String(raw ?? '')
    .split(',')
    .map(normalizeId)
    .filter(Boolean);
}


// ─────────────────────────────────────────────────────────────────────────────
// samePhone — compare two individual identifiers regardless of how each is
// written. Returns false if either side is empty, so an unset STAFF_WA_NUMBER
// never accidentally matches a customer whose id also normalises to "".
// ─────────────────────────────────────────────────────────────────────────────
export function samePhone(a, b) {
  const left  = normalizeId(a);
  const right = normalizeId(b);
  return left !== '' && left === right;
}


// ─────────────────────────────────────────────────────────────────────────────
// displayId — how an identifier should be shown to STAFF in an alert.
//
// A phone number gets the familiar "+60…" treatment. A BSUID must not, since
// "+US.1349…" is meaningless and, when the id was missing entirely, the old
// `+${senderId}` produced the literal string "+undefined" in real alerts.
//
// username is passed through from contacts[].profile.username when present,
// because it is the only thing staff can actually search for in the WhatsApp
// Business App — they cannot look up a customer by BSUID.
// ─────────────────────────────────────────────────────────────────────────────
export function displayId(value, { username, name } = {}) {
  const raw = String(value ?? '').trim();

  if (!raw) return 'unknown sender';
  if (!isBsuid(raw)) return `+${digitsOnly(raw)}`;

  const label = [name, username && `@${username}`].filter(Boolean).join(' ');
  return label ? `${label} (${raw})` : raw;
}
