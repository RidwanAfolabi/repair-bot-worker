/**
 * branches.js — routing a confirmed booking to the branch that will do the work
 *
 * A'aisyah writes the branch into the [INTAKE] block in the customer's own
 * words: "Alor Setar", "alor setar", "cawangan AS", "kedai Balik Pulau". This
 * turns that free text into the branch's WhatsApp number.
 *
 * CONFIG — BRANCH_NUMBERS, a comma-separated list of name=number pairs:
 *
 *   "Alor Setar=60123456789,Changlun=60123456790,Pendang=60123456791,
 *    Pokok Sena=60123456792,Balik Pulau=60123456793"
 *
 * Set it as a secret (it is a list of real staff numbers):
 *   npx wrangler secret put BRANCH_NUMBERS
 *
 * Unset or unparseable means no branch routing happens at all and the staff
 * alert still goes out exactly as before, so the feature fails soft.
 */

import { digitsOnly } from './phone.js';


// ─────────────────────────────────────────────────────────────────────────────
// normalizeBranch — collapse a branch name to something comparable.
// "Cawangan Alor Setar!" -> "cawanganalorsetar"
// ─────────────────────────────────────────────────────────────────────────────
function normalizeBranch(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}


// ─────────────────────────────────────────────────────────────────────────────
// parseBranchNumbers — read BRANCH_NUMBERS into [{ name, key, number }].
//
// Malformed entries are skipped rather than throwing: a typo in one branch's
// config must not stop the other four from being notified.
// ─────────────────────────────────────────────────────────────────────────────
export function parseBranchNumbers(raw) {
  return String(raw ?? '')
    .split(',')
    .map(pair => {
      const idx = pair.indexOf('=');
      if (idx < 0) return null;

      const name   = pair.slice(0, idx).trim();
      const number = digitsOnly(pair.slice(idx + 1));
      if (!name || !number) return null;

      return { name, key: normalizeBranch(name), number };
    })
    .filter(Boolean);
}


// ─────────────────────────────────────────────────────────────────────────────
// resolveBranch — match the branch text from an intake to a configured branch.
//
// Matches in both directions, because the LLM's wording sits on either side of
// the configured name: "Alor Setar" is contained in "cawangan alor setar", and
// a configured "Alor Setar (City Plaza)" contains a customer's "alor setar".
//
// Longest configured name wins, so "Pokok Sena" is preferred over a shorter
// name that happens to be a substring of the same text.
//
// Returns null when there is no branch text, no config, or no confident
// match — the caller then skips branch routing rather than guessing, since
// sending a booking to the wrong shop is worse than sending it to none.
// ─────────────────────────────────────────────────────────────────────────────
export function resolveBranch(branchText, raw) {
  const target = normalizeBranch(branchText);
  if (!target) return null;

  const candidates = parseBranchNumbers(raw)
    .filter(b => b.key && (target.includes(b.key) || b.key.includes(target)))
    .sort((a, b) => b.key.length - a.key.length);

  return candidates[0] ?? null;
}
