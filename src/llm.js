/**
 * llm.js — LLM provider abstraction
 *
 * Swap providers via the LLM_PROVIDER var in wrangler.jsonc — no code
 * changes needed to switch, just redeploy:
 *
 *   "LLM_PROVIDER": "gemini"   (default if unset — current production model)
 *   "LLM_PROVIDER": "claude"   (requires ANTHROPIC_API_KEY secret)
 *
 * Every provider adapter shares the same contract:
 *   input:  (history, newMessage, env, pricingContext)
 *     history         — array of { role: 'customer' | 'ai-assistant' | 'staff',
 *                        text } from D1, oldest first (see db.js
 *                        getRecentMessages). Both Gemini and Claude's APIs
 *                        only support two structural roles — see
 *                        toApiRole/toApiText below for how the third value
 *                        (staff) is preserved as a content-level signal
 *                        instead, since the API itself has no slot for it.
 *     pricingContext   — optional block of live price-lookup text (see
 *                        pricing.js formatPricingContext), appended to the
 *                        system prompt for this reply only. Defaults to ''.
 *   output: a single trimmed string reply
 *
 * bot.js calls generateReply() only — it never needs to know which
 * provider is actually answering, or handle provider-specific request/
 * response shapes itself. Add a new provider by writing one more adapter
 * below and one more case in the dispatcher.
 */

import { buildSystemPrompt, STATIC_SYSTEM_PROMPT, buildDynamicContext } from './prompt.js';

export async function generateReply(history, newMessage, env, pricingContext = '') {
  const provider = (env.LLM_PROVIDER ?? 'gemini').toLowerCase();

  switch (provider) {
    case 'gemini':
      return callGemini(history, newMessage, env, pricingContext);
    case 'claude':
      return callClaude(history, newMessage, env, pricingContext);
    default:
      throw new Error(`Unknown LLM_PROVIDER "${provider}" — expected "gemini" or "claude"`);
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// toApiRole / toApiText — shared by both adapters below.
//
// Neither Gemini's nor Claude's API has a structural third role — both only
// support exactly two (user/model, user/assistant). 'ai-assistant' and
// 'staff' both collapse to the non-customer API role. To keep the LLM able
// to actually tell them apart — the whole point of the DB having three
// values now — a staff-authored turn gets a plain text marker prepended to
// its content instead. See the "## STAFF REPLIES" prompt section for what
// the LLM is told to do with that marker; it must never surface to the
// customer, since it's purely an internal signal for the model's own reasoning.
// ─────────────────────────────────────────────────────────────────────────────
function toApiRole(dbRole) {
  return dbRole === 'customer' ? 'user' : 'assistant';
}

function toApiText(dbRole, text) {
  return dbRole === 'staff' ? `[Staff replied] ${text}` : text;
}


// ─────────────────────────────────────────────────────────────────────────────
// callGemini — call Google Gemini
//
// Key differences from Claude/OpenAI format:
//   - non-customer role must be sent as 'model'
//   - System prompt goes in systemInstruction, not in messages array
//   - Response text is nested at candidates[0].content.parts[0].text
// ─────────────────────────────────────────────────────────────────────────────
async function callGemini(history, newMessage, env, pricingContext) {

  // Convert history to Gemini format — see toApiRole/toApiText above
  const geminiHistory = history.map(m => ({
    role:  toApiRole(m.role) === 'assistant' ? 'model' : 'user',
    parts: [{ text: toApiText(m.role, m.text) }],
  }));

  const contents = [
    ...geminiHistory,
    { role: 'user', parts: [{ text: newMessage }] },
  ];

  // gemini-3.1-flash-lite — has more Peak RPD (500) than gemini-3-flash
  const model = env.GEMINI_MODEL ?? 'gemini-3.1-flash-lite';
  const url   = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;

  const response = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: buildSystemPrompt(pricingContext) }],
      },
      contents,
      generationConfig: {
        maxOutputTokens: 500,  // Slightly higher to allow for multi-part responses, previously 400
        temperature:     0.7,  // Natural but not unpredictable
      },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini API ${response.status}: ${err}`);
  }

  const data = await response.json();

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error('Gemini returned empty response — check API key and quota');
  }

  return text.trim();
}


// ─────────────────────────────────────────────────────────────────────────────
// callClaude — Anthropic Claude
//
// Key differences from Gemini's format, handled here so the rest of the
// codebase doesn't need to care:
//   - System prompt is a top-level `system` param, not part of `messages`
//   - Role must be translated (see toApiRole above) — Claude's API hard-
//     rejects anything other than the literal strings "user"/"assistant",
//     so D1's three role values ('customer'/'ai-assistant'/'staff') cannot
//     be passed through directly
//   - max_tokens is required, not optional
//   - Response text is at content[0].text (content is an array of blocks)
//
// PROMPT CACHING — see prompt.js's file header for the split this depends on.
// `system` is STATIC_SYSTEM_PROMPT alone (never changes) with an explicit
// `cache_control` breakpoint on it, so Claude reprocesses it at ~1/10th price
// instead of paying full price for the same ~44K chars on every single
// customer message. The two genuinely dynamic pieces (live time, live
// pricing) go through buildDynamicContext() and are attached as their own
// block on the NEWEST user turn instead — after the cached prefix, never
// inside it, so they can change every request without invalidating the cache.
// (Sonnet 5 does not support mid-conversation `role: "system"` messages,
// which is the officially recommended place for this on models that do — see
// prompt-caching docs § Mid-conversation system messages — so this uses the
// documented fallback for models without that: text in a user turn.)
//
// A second, independent cache layer: top-level `cache_control` below asks
// Claude to also auto-cache the growing MESSAGE history for this specific
// customer, on top of the system-prompt cache shared across all customers.
// Each reply to the same customer resends their whole prior conversation
// (bot.js re-fetches it fresh from D1 every time) — with this on, only the
// newest turn is billed at full price; everything already seen is a cache
// read. Works fully while a conversation stays under HISTORY_MESSAGE_LIMIT
// (32) messages; past that the sliding window drops the oldest message each
// time, which shifts the whole array and costs that customer's next reply a
// cache miss on the history portion specifically — the system-prompt cache
// is unaffected either way, since it's shared across every customer, not
// per-conversation.
//
// NOTE — Claude Sonnet 5 (and Opus 4.7+) no longer accept temperature/top_p/
// top_k at all; sending any of them, even at "default" values, returns a 400.
// Deliberately not sent here. Tone is controlled entirely through the system
// prompt instead.
//
// NOTE — Sonnet 5 runs with adaptive thinking ON by default, and max_tokens
// caps thinking + reply combined. Explicitly disabled below — this bot is
// straightforward instruction-following (branch routing, pricing, escalation
// trigger), not a task that benefits from extended reasoning, and leaving
// thinking on risks eating into the 500-token reply budget unpredictably.
//
// Requires the ANTHROPIC_API_KEY secret:
//   npx wrangler secret put ANTHROPIC_API_KEY
//
// Model default is claude-sonnet-5 — a quality-first pick for comparing
// against Gemini's output. Cheaper/faster alternative: claude-haiku-4-5-20251001.
// Override via env.CLAUDE_MODEL without touching this file.
// ─────────────────────────────────────────────────────────────────────────────
async function callClaude(history, newMessage, env, pricingContext) {
  const dynamicContext = buildDynamicContext(pricingContext);

  const messages = [
    ...history.map(m => ({ role: toApiRole(m.role), content: toApiText(m.role, m.text) })),
    {
      role: 'user',
      content: [
        // Live time + live pricing — always changes, never cached. Its own
        // block (rather than concatenated into the customer's own text) so
        // it stays visually distinct from what the customer actually typed;
        // both pieces already carry their own "## CURRENT ..." headers (see
        // businessHours.js / pricing.js), so there is no ambiguity either way.
        { type: 'text', text: dynamicContext },
        { type: 'text', text: newMessage },
      ],
    },
  ];

  const model = env.CLAUDE_MODEL ?? 'claude-sonnet-5';

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      system: [
        { type: 'text', text: STATIC_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ],
      messages,
      max_tokens:    500,
      thinking:      { type: 'disabled' },
      cache_control: { type: 'ephemeral' },   // auto-caches the growing per-customer history tail
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API ${response.status}: ${err}`);
  }

  const data = await response.json();
  const text = data?.content?.[0]?.text;

  if (!text) {
    throw new Error('Claude returned empty response — check API key and quota');
  }

  return text.trim();
}