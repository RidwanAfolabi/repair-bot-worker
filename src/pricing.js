/**
 * pricing.js — matches customer enquiries against the iFix Express price list
 *
 * Independent of however the sheet data actually gets fetched — parseSheet()
 * for a raw CSV export, rowsFromApiValues() for the live Google Sheets API
 * response used by googleSheets.js. Either way this module only cares about:
 * given rows in the shape { code, category, description, price } and a
 * customer's brand/model/damage type, find the right ones.
 *
 * parseStructuredDeviceReply() extracts that brand/model/damage type from a
 * customer's reply to the prompt's structured device-details template, and
 * formatPricingContext() turns a match back into prompt text — together
 * these are the glue between an incoming WhatsApp message and what gets fed
 * to the LLM (see bot.js step 4).
 *
 * Three-tier lookup, most to least specific:
 *   1. exact     — Category (brand + part-type) AND Description (model) both
 *                  match. Safe to quote as a confirmed price.
 *   2. category  — Category matches (brand + part-type), but no specific
 *                  model match in Description. Returns everything in that
 *                  category as CONTEXT ONLY — per the system prompt's
 *                  "when you are not sure" rule, none of these should be
 *                  quoted as the customer's price. Useful for A'aisyah to
 *                  say something like "we have pricing for related Samsung
 *                  screens, let me confirm the exact one for your model"
 *                  rather than a bare "let me check."
 *   3. none      — nothing matched at all. Genuinely unknown, escalate.
 *
 * Sheet columns (confirmed from real export): Code, Category, Description, Price
 * Category format: "NN.0 [TYPE] [BRAND]" e.g. "01.0 LCD IPHONE", "25.0 SERVICES"
 * Description sometimes lists multiple models separated by "/"
 *   e.g. "13.2 LCD OPPO A78 5G/A58 5G" matches either A78 or A58 enquiries
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
// customer's reply to the "ASKING FOR DEVICE DETAILS" template in prompt.js:
//
//   1. Jenama handphone: Samsung
//   2. Model handphone: Note 20 Ultra
//   3. Jenis kerosakkan: Screen
//
// Only reliably parses the BM template — it's the one fixed format everyone
// (manager and A'aisyah) actually uses verbatim. The English adaptation is
// deliberately NOT a fixed string in the prompt (customers phrase it however
// they like), so it can't be pattern-matched here; a customer replying in
// English simply won't match and pricing lookup is skipped for that message
// — the LLM still replies normally, just without live pricing context.
//
// Line-by-line matching means extra text before/after the three lines (a
// greeting, a follow-up question) is harmless — those lines just don't match
// any pattern and are ignored. Returns null unless all three fields are
// found; a partial match is treated as "not enough to look up" rather than
// guessing at what's missing.
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
// formatPricingContext — turn a findPricing() result into a block of text
// appended to the system prompt (see prompt.js buildSystemPrompt).
//
// Ties directly to the "## WHEN YOU ARE NOT SURE" prompt rule: 'exact' rows
// are explicitly safe to quote, 'category' rows are explicitly NOT — they're
// framed as context for a more informed hand-off, never as a price. 'none'
// (or no match object at all) produces no block; the LLM falls back to its
// normal "don't guess, escalate" behaviour with no live data to lean on.
// ─────────────────────────────────────────────────────────────────────────────
export function formatPricingContext(matchResult) {
  if (!matchResult || matchResult.tier === 'none' || matchResult.rows.length === 0) {
    return '';
  }

  const lines = matchResult.rows.map(
    row => `- ${row.description} (${row.category}): RM${row.price}`
  );

  if (matchResult.tier === 'exact') {
    return [
      '## LIVE PRICE LOOKUP RESULT — CONFIRMED MATCH',
      '',
      "The following price was found in the live price list for this customer's exact device and damage type. You may quote this price directly.",
      '',
      ...lines,
    ].join('\n');
  }

  // tier === 'category'
  return [
    '## LIVE PRICE LOOKUP RESULT — RELATED ITEMS ONLY, NOT A CONFIRMED MATCH',
    '',
    "No exact match was found for this customer's specific model. The items below are from the same brand and repair category and are for CONTEXT ONLY — do not quote any of these as the customer's price. Let them know you have related pricing and will confirm the exact figure for their model, following the escalation approach for anything uncertain.",
    '',
    ...lines,
  ].join('\n');
}


export function findPricing({ brand, model, damageType }, rows) {
  const brandNorm = normalize(brand);
  const typeNorm  = normalize(damageType);
  const modelNorm = normalize(model);

  const categoryMatches = rows.filter(row => {
    const catNorm = normalize(row.category);
    return catNorm.includes(brandNorm) && categoryMentionsType(catNorm, typeNorm);
  });

  const exact = categoryMatches.find(row => {
    const descNorm = normalize(row.description);
    return descNorm.split('/').some(part => part.includes(modelNorm)) || descNorm.includes(modelNorm);
  });

  if (exact) {
    return { tier: 'exact', rows: [exact] };
  }

  if (categoryMatches.length > 0) {
    return { tier: 'category', rows: categoryMatches };
  }

  return { tier: 'none', rows: [] };
}

function normalize(text) {
  return (text ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const TYPE_KEYWORDS = {
  SCREEN:  ['LCD'],
  LCD:     ['LCD'],
  BATTERY: ['BATTERY'],
  BATT:    ['BATTERY'],
  SERVICE: ['SERVICES', 'SVC'],
};

function categoryMentionsType(catNorm, typeNorm) {
  const keywords = TYPE_KEYWORDS[typeNorm] ?? [typeNorm];
  return keywords.some(kw => catNorm.includes(kw));
}
