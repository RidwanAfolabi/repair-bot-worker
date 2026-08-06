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
 *   input:  (history, newMessage, env)
 *     history — array of { role: 'user' | 'assistant', text } from D1,
 *               oldest first (see db.js getRecentMessages)
 *   output: a single trimmed string reply
 *
 * bot.js calls generateReply() only — it never needs to know which
 * provider is actually answering, or handle provider-specific request/
 * response shapes itself. Add a new provider by writing one more adapter
 * below and one more case in the dispatcher.
 */

import { SYSTEM_PROMPT } from './prompt.js';

export async function generateReply(history, newMessage, env) {
  const provider = (env.LLM_PROVIDER ?? 'gemini').toLowerCase();

  switch (provider) {
    case 'gemini':
      return callGemini(history, newMessage, env);
    case 'claude':
      return callClaude(history, newMessage, env);
    default:
      throw new Error(`Unknown LLM_PROVIDER "${provider}" — expected "gemini" or "claude"`);
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// callGemini — call Google Gemini
//
// Key differences from Claude/OpenAI format:
//   - 'assistant' role must be sent as 'model'
//   - System prompt goes in systemInstruction, not in messages array
//   - Response text is nested at candidates[0].content.parts[0].text
// ─────────────────────────────────────────────────────────────────────────────
async function callGemini(history, newMessage, env) {

  // Convert history to Gemini format — 'assistant' → 'model'
  const geminiHistory = history.map(m => ({
    role:  m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.text }],
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
        parts: [{ text: SYSTEM_PROMPT }],
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
//   - 'assistant' role stays as-is (D1 already stores it this way — no
//     mapping needed, unlike Gemini's 'model' rename)
//   - max_tokens is required, not optional
//   - Response text is at content[0].text (content is an array of blocks)
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
async function callClaude(history, newMessage, env) {
  const messages = [
    ...history.map(m => ({ role: m.role, content: m.text })),
    { role: 'user', content: newMessage },
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
      system:     SYSTEM_PROMPT,
      messages,
      max_tokens: 500,
      thinking:   { type: 'disabled' },
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
