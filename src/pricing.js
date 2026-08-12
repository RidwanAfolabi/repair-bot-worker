/**
 * pricing.js — connects a customer enquiry to the right worksheet in the
 * live Google Sheets price list, and formats that worksheet's full contents
 * for the LLM to search itself.
 *
 * DESIGN CHANGE from the original tier-based matcher: rather than having
 * code narrow down to a single row (which was fragile — a wrong keyword
 * match or an unrecognized model phrasing meant the LLM never even saw the
 * right data), this hands over the WHOLE matched brand's rows and lets the
 * LLM find the specific item itself. The LLM is better suited to fuzzy
 * matching against a labelled list than a keyword dictionary is, and the
 * token cost is bounded — a brand's full sheet is ~100-200 rows, not the
 * whole 1500+ item catalog.
 *
 * The spreadsheet is organized as one tab per brand (e.g. "iPhone",
 * "Samsung", "Vivo"), plus one non-brand tab, "Services & Accessories",
 * for items that don't belong to any specific device (cables, screen
 * protectors, general service charges, deposits).
 *
 * matchBrandTab() fuzzy-matches a customer's message against the
 * spreadsheet's ACTUAL current tab titles (fetched live via
 * googleSheets.js's getSheetTabs) — not a hardcoded brand list — so a new
 * brand tab added later just works with no code change.
 *
 * Sheet columns (confirmed from real export): Code, Category, Description, Price
 * A price of 0 means "not yet priced," not "free" — every row in this
 * category still needs manual confirmation, see formatPricingContext below.
 */

export function parseSheet(csvText) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const char = csvText[i];
    const next = csvText[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') { field += '"'; i++; }
      else if (char === '"') { inQuotes = false; }
      else { field += char; }
    } else {
      if (char === '"') { inQuotes = true; }
      else if (char === ',') { row.push(field); field = ''; }
      else if (char === '\n' || char === '\r') {
        if (char === '\r' && next === '\n') i++;
        row.push(field);
        if (row.some(f => f.trim() !== '')) rows.push(row);
        row = [];
        field = '';
      } else {
        field += char;
      }
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.some(f => f.trim() !== '')) rows.push(row);
  }

  const [, ...dataRows] = rows; // drop header row
  return dataRows.map(cols => ({
    code:        cols[0]?.trim(),
    category:    cols[1]?.trim(),
    description: cols[2]?.trim(),
    price:       Number(cols[3]?.trim() ?? 0),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// rowsFromApiValues — convert Google Sheets API `values` (array of arrays,
// from spreadsheets.values.get) into the same row shape parseSheet() builds
// from raw CSV. The API already splits cells for us — no CSV escaping to
// worry about — so this is just column mapping plus dropping the header row.
// ─────────────────────────────────────────────────────────────────────────────
export function rowsFromApiValues(values) {
  if (!Array.isArray(values) || values.length === 0) return [];

  const [, ...dataRows] = values; // drop header row
  return dataRows
    .filter(cols => Array.isArray(cols) && cols.some(c => String(c ?? '').trim() !== ''))
    .map(cols => ({
      code:        cols[0] != null ? String(cols[0]).trim() : undefined,
      category:    cols[1] != null ? String(cols[1]).trim() : undefined,
      description: cols[2] != null ? String(cols[2]).trim() : undefined,
      price:       Number(cols[3] ?? 0),
    }));
}


// ─────────────────────────────────────────────────────────────────────────────
// parseStructuredDeviceReply — extract brand/model/damageType from a
// customer's reply to the "ASKING FOR DEVICE DETAILS" template in prompt.js.
// Not used by the live pricing lookup anymore (see matchBrandTab below) —
// kept available for other potential uses (e.g. feeding a repair booking).
// ─────────────────────────────────────────────────────────────────────────────
const DEVICE_FIELD_PATTERNS = {
  brand:      /jenama\s*handphone\s*:\s*(.+)/i,
  model:      /model\s*handphone\s*:\s*(.+)/i,
  damageType: /jenis\s*kerosak?kan\s*:\s*(.+)/i,
};

export function parseStructuredDeviceReply(text) {
  if (!text) return null;

  const result = {};

  for (const line of text.split(/\r?\n/)) {
    for (const [field, pattern] of Object.entries(DEVICE_FIELD_PATTERNS)) {
      const match = line.match(pattern);
      if (match) {
        result[field] = match[1].trim();
      }
    }
  }

  if (result.brand && result.model && result.damageType) {
    return result;
  }

  return null;
}


// ─────────────────────────────────────────────────────────────────────────────
// normalize — shared text-cleaning helper used by all matching below
// ─────────────────────────────────────────────────────────────────────────────
function normalize(text) {
  return (text ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}


// ─────────────────────────────────────────────────────────────────────────────
// FALLBACK_TAB_NAME — the non-brand tab for cables, screen protectors,
// general service charges, deposits, anything not tied to a specific device
// ─────────────────────────────────────────────────────────────────────────────
// FALLBACK_TAB_NAME must already be in normalize()'s output format — the
// comparisons below use normalize(t) === FALLBACK_TAB_NAME directly, so this
// constant needs to match what normalize('Services & Accessories') actually
// produces (the & gets stripped as non-alphanumeric), not the raw tab title.
const FALLBACK_TAB_NAME = 'SERVICES ACCESSORIES';

// Words that appear as a different word than the brand's real tab name —
// "Apple" doesn't literally appear in the sheet anywhere (it's all "IPHONE"),
// so plain substring matching would never connect the two on its own.
// Add more here as real examples come up — deliberately starting small.
const BRAND_ALIASES = {
  APPLE: 'IPHONE',
};

// Symbol-based shorthand that can't go through BRAND_ALIASES — normalize()
// strips "+" as non-alphanumeric, so "1+" collapses to a bare "1" long
// before matching happens, and "1" alone is far too generic to alias (it
// would match model numbers, prices, note/version numbers, phone digits,
// anything). Checked directly against the RAW customer text instead, before
// normalization ever runs, so only this exact symbol shorthand is
// special-cased rather than loosening digit matching in general.
const SYMBOL_ALIASES = [
  { pattern: /1\s*\+/, canonical: 'ONEPLUS' },
];

// Signal that a message can be answered WITHOUT knowing the device brand —
// cables, protectors, deposits, chargers. Used ONLY to decide whether to
// check the Services & Accessories fallback tab when no brand was matched.
// Without this gate, every ordinary message ("hi", "what time do you
// close") would trigger a fallback-tab fetch and injection for no reason.
//
// Deliberately NOT included here: generic pricing/repair words ("harga",
// "repair", "rosak", "tukar", "service", etc.) on their own. A message like
// "berapa harga tukar skrin" with no brand can't actually be answered from
// the fallback tab anyway — screen/battery/etc. repairs are priced per
// brand and model, not something Services & Accessories covers. Fetching
// that tab in this case used to hand the LLM a pile of irrelevant
// accessories data instead of the brand it actually needs, and gave the
// (false) impression enough context had been provided. Now, with no brand
// match AND no device-agnostic word, pricingContext just stays empty — see
// bot.js step 5 — and the LLM's own "## ASKING FOR DEVICE DETAILS" prompt
// guidance asks for brand/model/damage type instead of guessing from data
// that doesn't apply. This is a judgment-call keyword list, not
// empirically tuned — worth adjusting once real traffic shows its gaps.
const DEVICE_AGNOSTIC_SIGNAL_WORDS = [
  'CABLE', 'KABEL', 'PROTECTOR', 'DEPOSIT', 'CHARGER', 'CAS',
];

export function looksLikeDeviceAgnosticEnquiry(text) {
  const norm = normalize(text);
  return DEVICE_AGNOSTIC_SIGNAL_WORDS.some(word => norm.includes(normalize(word)));
}


// ─────────────────────────────────────────────────────────────────────────────
// tabMatchTokens — a tab title split into its individual matchable brand
// tokens. Most tabs are a single brand ("iPhone", "Samsung") and produce one
// token. Combined tabs ("Infinix / Tecno") are split on "/" so a customer
// mentioning EITHER brand alone still matches — requiring the full
// "INFINIX TECNO" phrase verbatim, which is what naive whole-title matching
// required, essentially never occurs in real customer phrasing since a
// customer names one brand at a time, not both joined together.
// ─────────────────────────────────────────────────────────────────────────────
function tabMatchTokens(tabTitle) {
  return tabTitle
    .split('/')
    .map(part => normalize(part))
    .filter(Boolean);
}

// tokenAppearsIn — the normal spaced substring check, plus a space-collapsed
// fallback so a tab title with a space in it ("One Plus") still matches how
// customers actually type the brand ("OnePlus", no space). The fallback is
// additive — it never overrides a case where the spaced check already
// matched, and doesn't change matching for any single-word tab name.
function tokenAppearsIn(normText, token) {
  if (normText.includes(token)) return true;
  const collapsedToken = token.replace(/\s+/g, '');
  if (collapsedToken.length === 0) return false;
  return normText.replace(/\s+/g, '').includes(collapsedToken);
}


// ─────────────────────────────────────────────────────────────────────────────
// matchBrandTab — fuzzy-match a customer's message against the spreadsheet's
// REAL current tab titles (from googleSheets.js's getSheetTabs — always the
// live list, not a hardcoded brand array, so a new tab just works).
//
// Two passes:
//   1. Direct — a token from the tab's own name literally appears in what
//      the customer typed. Checked BEFORE alias expansion so an explicit
//      mention (e.g. "iPad") always wins, rather than risking getting
//      outvoted on the length tie-breaker by an alias-injected token (e.g.
//      "Apple" -> "iPhone", when the customer already said "iPad").
//   2. Alias — only tried if nothing matched directly. Handles brand names
//      that never appear verbatim in the sheet (e.g. "Apple" implies
//      "iPhone" when no specific Apple product was named) and symbol-based
//      shorthand normalize() would otherwise destroy (e.g. "1+" for
//      "OnePlus" — see SYMBOL_ALIASES).
//
// If more than one tab matches within a pass (shouldn't normally happen with
// distinct brand names), the longest/most specific tab name wins as a
// tie-breaker.
//
// Returns null if nothing matched — caller decides whether to check the
// fallback tab or skip the lookup entirely.
// ─────────────────────────────────────────────────────────────────────────────
export function matchBrandTab(customerText, tabTitles) {
  const normText  = normalize(customerText);
  const brandTabs = tabTitles.filter(t => normalize(t) !== FALLBACK_TAB_NAME);

  const direct = brandTabs.filter(tab =>
    tabMatchTokens(tab).some(tok => tokenAppearsIn(normText, tok))
  );
  if (direct.length > 0) {
    direct.sort((a, b) => b.length - a.length);
    return direct[0];
  }

  let aliasText = normText;
  for (const [alias, canonical] of Object.entries(BRAND_ALIASES)) {
    if (normText.includes(alias)) {
      aliasText += ' ' + canonical;
    }
  }
  for (const { pattern, canonical } of SYMBOL_ALIASES) {
    if (pattern.test(customerText)) {
      aliasText += ' ' + canonical;
    }
  }

  const aliasMatches = brandTabs.filter(tab =>
    tabMatchTokens(tab).some(tok => tokenAppearsIn(aliasText, tok))
  );
  if (aliasMatches.length === 0) return null;

  aliasMatches.sort((a, b) => b.length - a.length);
  return aliasMatches[0];
}


// ─────────────────────────────────────────────────────────────────────────────
// findFallbackTab — locate the Services & Accessories tab among the real
// tab titles (case-insensitive, tolerant of minor formatting differences)
// ─────────────────────────────────────────────────────────────────────────────
export function findFallbackTab(tabTitles) {
  return tabTitles.find(t => normalize(t) === FALLBACK_TAB_NAME) ?? null;
}


// ─────────────────────────────────────────────────────────────────────────────
// formatPricingContext — turn one or more matched tabs' full row sets into a
// block of text appended to the system prompt (see prompt.js
// buildSystemPrompt). Takes an ARRAY of { tabName, rows } sections — bot.js
// always looks up the matched brand tab together with the Services &
// Accessories fallback tab in one pass (see bot.js step 5), so this needs to
// combine both into a single block rather than handling one tab at a time.
//
// No tiers — the LLM gets everything for the matched tab(s) and finds the
// specific item itself. The "don't guess, don't state RM0" rule is stated
// directly alongside the data here, not just relied on from the distant
// system-prompt-level rule, since that's more reliable for
// instruction-following than a rule stated once, far away from the data it
// actually governs.
// ─────────────────────────────────────────────────────────────────────────────
export function formatPricingContext(sections) {
  const nonEmpty = (sections ?? []).filter(s => s?.rows?.length > 0);

  if (nonEmpty.length === 0) {
    return `## CURRENT PRICING (live lookup for this enquiry)\nNo pricing data available for this enquiry. Treat as unknown and follow the escalation approach.`;
  }

  const blocks = nonEmpty.map(({ tabName, rows }) => {
    const list = rows.map(r => `- ${r.description}: RM${r.price}`).join('\n');
    return `### ${tabName}\n${list}`;
  });

  return `## CURRENT PRICING (live lookup for this enquiry)
Below is the FULL current price list for the relevant section(s). Carefully find the specific item that matches what the customer is asking about — their wording may be informal or phrased differently than how items are listed here.

${blocks.join('\n\n')}

Rules for using this data:
- Only state a price if you find a clear, specific match for what the customer described.
- A price of RM0 means the item exists but has not been priced yet. Do NOT say RM0, and do NOT say we don't offer it — confirm we DO offer it, then follow the escalation approach to get the exact price.
- If nothing here clearly matches what the customer asked, do not guess or pick the closest item — treat it as unknown and follow the escalation approach.`;
}