/**
 * bot.js — AI bot handler
 *
 * This is the brain of the operation. For each incoming message it:
 *   1. Checks if the sender is escalated — if so, stays silent
 *   2. Checks for staff commands (!take, !done)
 *   3. Fetches recent conversation history from D1
 *   4. Calls Claude with the system prompt + history + new message
 *   5. Checks the reply for escalation triggers
 *   6. Saves the reply to D1
 *   7. Sends the reply to the customer via WhatsApp
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

  // ── 1. Staff command handling ─────────────────────────────────────────────
  // Staff reply from their own phone — not customer messages.
  // In practice, distinguish staff by checking if senderId === STAFF_WA_NUMBER.
  if (senderId === env.STAFF_WA_NUMBER) {
    await handleStaffCommand(senderId, incomingText, env);
    return;
  }

  // ── 2. Check escalation state ─────────────────────────────────────────────
  // If this customer has been escalated, bot stays completely silent.
  // Staff are handling them directly.
  const escalated = await isEscalated(env.DB, senderId);
  if (escalated) {
    console.log(`[Bot] ${senderId} is escalated — bot silent`);
    return;
  }

  // ── 3. Fetch recent conversation history ──────────────────────────────────
  // Last 6 messages (3 exchanges) — enough context without ballooning token cost
  const history = await getRecentMessages(env.DB, senderId, 6);

  // ── 4. Call Claude ────────────────────────────────────────────────────────
  let aiReply;
  try {
    aiReply = await callClaude(history, incomingText, env);
  } catch (err) {
    console.error('[Bot] Claude API error:', err.message);
    // Fallback — never leave the customer with silence
    aiReply = 'Maaf, ada gangguan teknikal sebentar. Team kami akan balas anda tidak lama lagi! 🙏';
  }

  // ── 5. Check if reply contains escalation trigger ─────────────────────────
  if (shouldEscalate(aiReply)) {
    await setEscalated(env.DB, senderId);
    await sendStaffAlert(
      `🚨 *Escalation needed*\nCustomer: ${senderId}\nLast message: "${incomingText}"\n\nReply to this number directly. Type *!done* when finished.`,
      env
    );
    console.log(`[Bot] Escalated ${senderId} to staff`);
  }

  // ── 6. Save bot reply to D1 ───────────────────────────────────────────────
  await saveMessage(env.DB, {
    senderId,
    role: 'assistant',
    text: aiReply,
  });

  // ── 7. Add a small human-paced delay before replying ─────────────────────
  // Instant replies feel robotic. 600–900ms feels like someone typed a response.
  await delay(700);

  // ── 8. Send reply to customer ─────────────────────────────────────────────
  await sendTextMessage(senderId, aiReply, env);
}


// ─────────────────────────────────────────────────────────────────────────────
// callClaude — build the prompt and call Anthropic API
// ─────────────────────────────────────────────────────────────────────────────
async function callClaude(history, newMessage, env) {

  // Build messages array — history + new message
  const messages = [
    ...history.map(m => ({
      role:    m.role,       // 'user' or 'assistant'
      content: m.text,
    })),
    {
      role:    'user',
      content: newMessage,
    },
  ];

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         env.CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type':      'application/json',
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5-20251001', // Fast + cheap — ideal for live chat
      max_tokens: 400,                          // Keep replies concise — WhatsApp, not essays
      system:     SYSTEM_PROMPT,
      messages,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  return data.content[0].text.trim();
}


// ─────────────────────────────────────────────────────────────────────────────
// shouldEscalate — detect escalation trigger phrase in AI reply
//
// The system prompt instructs Alia to include a specific phrase when escalating.
// We detect that phrase here and set the escalation flag in D1.
// ─────────────────────────────────────────────────────────────────────────────
function shouldEscalate(reply) {
  // This phrase is defined in the system prompt as Alia's escalation signal.
  // Keep it consistent between prompt.js and here.
  return reply.toLowerCase().includes('biar saya connectkan');
}


// ─────────────────────────────────────────────────────────────────────────────
// handleStaffCommand — process commands from the staff WhatsApp number
//
// !take <customerNumber>  — take over a conversation (bot goes silent)
// !done <customerNumber>  — finish conversation (bot resumes)
// !status                 — get a quick count of active conversations
// ─────────────────────────────────────────────────────────────────────────────
async function handleStaffCommand(staffId, text, env) {
  const parts  = text.trim().split(/\s+/);
  const cmd    = parts[0]?.toLowerCase();
  const target = parts[1]; // Customer's WhatsApp number

  if (cmd === '!take' && target) {
    await setEscalated(env.DB, target);
    await sendTextMessage(staffId, `✅ Bot paused for ${target}. You're now handling this customer directly.`, env);
    return;
  }

  if (cmd === '!done' && target) {
    await resolveEscalation(env.DB, target);
    await sendTextMessage(staffId, `✅ Bot resumed for ${target}.`, env);
    // Optionally: send a closing message to the customer
    await sendTextMessage(target, 'Terima kasih kerana menghubungi iFix Express! Ada lagi yang boleh kami bantu? 😊', env);
    return;
  }

  // Unknown command from staff number — treat as a normal message
  // (Staff might be testing or chatting with the bot directly)
  console.log(`[Bot] Unrecognised staff command: ${text}`);
}


// ─────────────────────────────────────────────────────────────────────────────
// delay — simple Promise-based sleep
// ─────────────────────────────────────────────────────────────────────────────
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}