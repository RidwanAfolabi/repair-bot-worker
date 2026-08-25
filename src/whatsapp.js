/**
 * whatsapp.js — Meta Graph API outbound helpers
 *
 * All calls to Meta go through here. Centralising them means:
 *   - One place to update if Meta changes their API version
 *   - Consistent error logging across all outbound calls
 *   - Easy to mock in tests
 *
 * PLATFORM LIMIT: the Cloud API cannot send a message to the same phone
 * number it sends from (the number tied to WA_PHONE_NUMBER_ID) — self-sends
 * fail to deliver even though the call itself may not throw. This matters
 * most for STAFF_WA_NUMBER under Coexistence — see the note at the top of
 * index.js and the runtime warning in its smb_message_echoes handler.
 */

const GRAPH_API_VERSION = 'v21.0';

// Base URL builder — uses WA_PHONE_NUMBER_ID from secrets
function messagesUrl(env) {
  return `https://graph.facebook.com/${GRAPH_API_VERSION}/${env.WA_PHONE_NUMBER_ID}/messages`;
}

function authHeaders(env) {
  return {
    'Authorization': `Bearer ${env.WA_TOKEN}`,
    'Content-Type':  'application/json',
  };
}


// ─────────────────────────────────────────────────────────────────────────────
// sendTextMessage — send a plain text message to a customer
//
// This is the main function you'll call from bot.js for all AI replies.
// ─────────────────────────────────────────────────────────────────────────────
// Returns { ok, errorCode } so a caller that needs to react to a SPECIFIC
// failure can. Existing callers ignore the return value and are unaffected.
// The one that matters is 131047: outside the 24-hour customer service window,
// where a plain text message is refused and only an approved template will
// deliver (see sendTemplateMessage below).
export async function sendTextMessage(to, text, env) {
  const response = await fetch(messagesUrl(env), {
    method:  'POST',
    headers: authHeaders(env),
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error(`[WhatsApp] sendTextMessage failed to ${to}:`, err);

    let errorCode = null;
    try { errorCode = JSON.parse(err)?.error?.code ?? null; } catch { /* non-JSON body */ }
    return { ok: false, errorCode };
  }

  console.log(`[WhatsApp] ✅ Message sent to ${to}`);
  return { ok: true, errorCode: null };
}


// ─────────────────────────────────────────────────────────────────────────────
// sendTemplateMessage — send a pre-approved template
//
// The only way to reach a number that has NOT messaged this business in the
// last 24 hours. WhatsApp opens a "customer service window" when someone
// messages you; inside it any free-form text is allowed, outside it plain
// text is rejected with error 131047 and only an approved template delivers.
//
// That is precisely the branch-notification case: a branch's WhatsApp will
// often have said nothing to the business number all day, so a booking alert
// sent as plain text simply never arrives.
//
// params fill the template's {{1}}, {{2}}, … placeholders IN ORDER. Meta
// rejects newlines and tabs inside a parameter, so each value must be a
// single line — the caller is responsible for keeping them short.
// ─────────────────────────────────────────────────────────────────────────────
export async function sendTemplateMessage(to, { name, language = 'en', params = [] }, env) {
  const response = await fetch(messagesUrl(env), {
    method:  'POST',
    headers: authHeaders(env),
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name,
        language: { code: language },
        components: params.length
          ? [{
              type: 'body',
              parameters: params.map(p => ({
                type: 'text',
                // Newlines would be rejected outright; collapse defensively.
                text: String(p ?? '').replace(/\s+/g, ' ').trim(),
              })),
            }]
          : [],
      },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error(`[WhatsApp] sendTemplateMessage "${name}" failed to ${to}:`, err);
    return { ok: false };
  }

  console.log(`[WhatsApp] ✅ Template "${name}" sent to ${to}`);
  return { ok: true };
}


// ─────────────────────────────────────────────────────────────────────────────
// sendReadReceipt — mark a customer message as read
//
// Shows the customer the blue double-tick and signals to them that someone
// (or something) has seen their message. Call this before your AI reply
// to create a natural, human-paced feel.
// ─────────────────────────────────────────────────────────────────────────────
export async function sendReadReceipt(messageId, env) {
  const response = await fetch(messagesUrl(env), {
    method:  'POST',
    headers: authHeaders(env),
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      status:     'read',
      message_id: messageId,
    }),
  });

  if (!response.ok) {
    // Non-critical — log but don't throw. A failed read receipt shouldn't
    // stop the bot from replying.
    const err = await response.text();
    console.warn('[WhatsApp] sendReadReceipt failed:', err);
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// sendStaffAlert — send a WhatsApp message to the staff number
//
// Used for:
//   - Escalation alerts ("Customer 601234 needs help with a complaint")
//   - New repair intake summaries ("New repair booking from Amin")
//   - Daily briefing (called from cron trigger in index.js)
// ─────────────────────────────────────────────────────────────────────────────
export async function sendStaffAlert(text, env) {
  if (!env.STAFF_WA_NUMBER) {
    console.warn('[WhatsApp] STAFF_WA_NUMBER not set — alert not sent');
    return;
  }

  await sendTextMessage(env.STAFF_WA_NUMBER, text, env);
}