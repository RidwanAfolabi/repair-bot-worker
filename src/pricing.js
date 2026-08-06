/**
 * pricing.js — matches customer enquiries against the iFix Express price list
 *
 * Independent of however the sheet data actually gets fetched (Google Sheets
 * API + service account — still pending account setup). This module only
 * cares about: given raw CSV text and a customer's brand/model/damage type,
 * find the right rows.
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
