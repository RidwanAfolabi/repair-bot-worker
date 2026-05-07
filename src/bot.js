/**
 * bot.js — AI bot handler
 *
 * For each incoming message:
 *   1. Checks for staff commands (!take, !done)
 *   2. Checks if sender is escalated — stays silent if so
 *   3. Fetches recent conversation history from D1
 *   4. Calls Gemini with system prompt + history + new message
 *   5. Detects escalation trigger in reply
 *   6. Saves reply to D1
 *   7. Sends reply to customer via WhatsApp
 */

import {
  getRecentMessages,
  saveMessage,
  isEscalated,
  setEscalated,
  resolveEscalation,
} from './db.js';

import {
  sendTextMessage,
  sendStaffAlert,
} from './whatsapp.js';

import { SYSTEM_PROMPT } from './prompt.js';


// ─────────────────────────────────────────────────────────────────────────────
// handleIncomingMessage — main entry point called from index.js
// ─────────────────────────────────────────────────────────────────────────────
export async function handleIncomingMessage({ senderId, incomingText, env }) {

  // ── 1. Staff commands — from manager's personal number ───────────────────
  if (senderId === env.STAFF_WA_NUMBER) {
    await handleStaffCommand(senderId, incomingText, env);
    return;
  }

  // ── 2. Check escalation state ─────────────────────────────────────────────
  // Bot stays completely silent — staff are handling via WhatsApp Business App
  const escalated = await isEscalated(env.DB, senderId);
  if (escalated) {
    console.log(`[Bot] ${senderId} is escalated — staying silent`);
    return;
  }

  // ── 3. Fetch recent conversation history ──────────────────────────────────
  const history = await getRecentMessages(env.DB, senderId, 6);

  // ── 4. Call Gemini ────────────────────────────────────────────────────────
  let aiReply;
  try {
    aiReply = await callGemini(history, incomingText, env);
  } catch (err) {
    console.error('[Bot] Gemini error:', err.message);
    aiReply = 'Maaf, ada gangguan teknikal sebentar. Team kami akan balas anda tidak lama lagi! 🙏';
  }

  // ── 5. Detect escalation trigger in reply ────────────────────────────────
  if (shouldEscalate(aiReply)) {
    await setEscalated(env.DB, senderId);
    await sendStaffAlert(
      `🚨 *Customer needs attention*\n\n` +
      `*Number:* +${senderId}\n` +
      `*Last message:* "${incomingText}"\n\n` +
      `👉 Open *WhatsApp Business App* and reply to this customer directly.\n\n` +
      `🤖 Bot is now *paused* — they will only see your replies.\n\n` +
      `When done, send:\n*!done ${senderId}*\n...and the bot will resume.`,
      env
    );
    console.log(`[Bot] Escalated ${senderId} to staff`);
  }

  // ── 6. Save bot reply ─────────────────────────────────────────────────────
  await saveMessage(env.DB, { senderId, role: 'assistant', text: aiReply });

  // ── 7. Human-paced delay — instant replies feel robotic ──────────────────
  await delay(700);

  // ── 8. Send reply to customer ─────────────────────────────────────────────
  await sendTextMessage(senderId, aiReply, env);
}


// ─────────────────────────────────────────────────────────────────────────────
// callGemini — call Google Gemini 1.5 Flash
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

  // gemini-3-flash — fast and cheap, ideal for live chat
  // Upgrade to gemini-3-pro for the daily summary cron (better long-context)
  const model = 'gemini-3-flash-preview';
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
        maxOutputTokens: 400,  // WhatsApp — keep it concise
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
// shouldEscalate — detect escalation phrase in Alia's reply
// Must match the exact phrase defined in SYSTEM_PROMPT
// ─────────────────────────────────────────────────────────────────────────────
function shouldEscalate(reply) {
  return reply.toLowerCase().includes('biar saya connectkan');
}


// ─────────────────────────────────────────────────────────────────────────────
// handleStaffCommand — commands received from STAFF_WA_NUMBER
//
// !take 60123456789  — manually pause bot for a customer
// !done 60123456789  — resume bot for a customer after staff handled them
// ─────────────────────────────────────────────────────────────────────────────
async function handleStaffCommand(staffId, text, env) {
  const parts  = text.trim().split(/\s+/);
  const cmd    = parts[0]?.toLowerCase();
  const target = parts[1];

  if (cmd === '!take' && target) {
    await setEscalated(env.DB, target);
    await sendTextMessage(
      staffId,
      `✅ Bot paused for +${target}.\nOpen WhatsApp Business App to reply to them directly.`,
      env
    );
    return;
  }

  if (cmd === '!done' && target) {
    await resolveEscalation(env.DB, target);
    await sendTextMessage(staffId, `✅ Bot resumed for +${target}.`, env);
    await sendTextMessage(
      target,
      'Terima kasih kerana menghubungi iFix Express! Ada lagi yang boleh kami bantu? 😊',
      env
    );
    return;
  }

  console.log(`[Bot] Unrecognised staff command from ${staffId}: ${text}`);
}


// ─────────────────────────────────────────────────────────────────────────────
// delay — human-paced pause before sending reply
// ─────────────────────────────────────────────────────────────────────────────
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}