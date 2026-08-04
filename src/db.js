/**
 * db.js — Cloudflare D1 database helpers
 *
 * Tables:
 *   conversations — every message in and out, per customer
 *   intakes       — completed repair booking details
 *   escalations   — tracks which customers have been escalated to staff
 *   wa_contacts   — Coexistence: contacts synced from the WhatsApp Business app
 *
 * Phase A (alert retry tracking) and Phase B (dashboard query functions) are
 * SUSPENDED — block-commented below rather than deleted, so they can be
 * reactivated later without reconstructing them from scratch. Do not import
 * markAlertSent / markAlertFailed / getStuckEscalations / getDashboardStats /
 * getActiveEscalations / getTodayConversationList / getConversationThread
 * anywhere while suspended — none of them currently execute.
 */


// ─────────────────────────────────────────────────────────────────────────────
// initDb — create tables if they don't exist
//
// Safe to call on every request — CREATE TABLE IF NOT EXISTS is idempotent.
// ─────────────────────────────────────────────────────────────────────────────
export async function initDb(db) {
  await db.batch([

    // Every message — customer and bot — stored here
    db.prepare(`
      CREATE TABLE IF NOT EXISTS conversations (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_id   TEXT    NOT NULL,
        role        TEXT    NOT NULL CHECK(role IN ('user', 'assistant')),
        text        TEXT    NOT NULL,
        timestamp   INTEGER NOT NULL DEFAULT (unixepoch()),
        escalated   INTEGER NOT NULL DEFAULT 0
      )
    `),

    // Completed repair intake records
    db.prepare(`
      CREATE TABLE IF NOT EXISTS intakes (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_id      TEXT    NOT NULL,
        customer_name  TEXT,
        device_model   TEXT,
        fault          TEXT,
        contact        TEXT,
        preferred_time TEXT,
        timestamp      INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `),

    // Escalation state per customer
    // When escalated = 1, the bot stays silent for that sender_id
    // (Phase A would have added alert_sent, alert_sent_at, alert_retries here
    // — see suspended block near the bottom of this file)
    db.prepare(`
      CREATE TABLE IF NOT EXISTS escalations (
        sender_id    TEXT    PRIMARY KEY,
        escalated    INTEGER NOT NULL DEFAULT 0,
        escalated_at INTEGER,
        resolved_at  INTEGER
      )
    `),

    // Contacts synced from the business customer's WhatsApp Business app
    // (Coexistence — smb_app_state_sync webhook). Base table for Phase 4 CRM.
    db.prepare(`
      CREATE TABLE IF NOT EXISTS wa_contacts (
        phone_number TEXT PRIMARY KEY,
        full_name    TEXT,
        first_name   TEXT,
        updated_at   INTEGER DEFAULT (unixepoch())
      )
    `),

  ]);

  /* ── SUSPENDED — Phase A escalations ALTER TABLE migration ────────────────
  const alterQueries = [
    `ALTER TABLE escalations ADD COLUMN alert_sent INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE escalations ADD COLUMN alert_sent_at INTEGER`,
    `ALTER TABLE escalations ADD COLUMN alert_retries INTEGER NOT NULL DEFAULT 0`,
  ];

  for (const query of alterQueries) {
    try {
      await db.prepare(query).run();
    } catch {
      // Column already exists — safe to ignore
    }
  }
  ── END SUSPENDED ────────────────────────────────────────────────────────── */
}


// ─────────────────────────────────────────────────────────────────────────────
// saveMessage — persist a single message to the conversations table
// ─────────────────────────────────────────────────────────────────────────────
export async function saveMessage(db, { senderId, role, text, timestamp }) {
  // timestamp is optional — pass it when backfilling history sync so messages
  // keep their real device time instead of all landing at insert time.
  if (timestamp) {
    await db
      .prepare(`INSERT INTO conversations (sender_id, role, text, timestamp) VALUES (?, ?, ?, ?)`)
      .bind(senderId, role, text, timestamp)
      .run();
  } else {
    await db
      .prepare(`INSERT INTO conversations (sender_id, role, text) VALUES (?, ?, ?)`)
      .bind(senderId, role, text)
      .run();
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// getRecentMessages — fetch last N messages for a sender
//
// Returns them in chronological order (oldest first) so they can be
// passed directly to the LLM as conversation history.
// ─────────────────────────────────────────────────────────────────────────────
export async function getRecentMessages(db, senderId, limit = 6) {
  const { results } = await db
    .prepare(`
      SELECT role, text FROM conversations
      WHERE sender_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `)
    .bind(senderId, limit)
    .all();

  // Reverse so oldest is first — correct order for LLM context
  return results.reverse();
}


// ─────────────────────────────────────────────────────────────────────────────
// isEscalated — check if a sender has been escalated to a human
//
// Bot stays silent when this returns true.
// ─────────────────────────────────────────────────────────────────────────────
export async function isEscalated(db, senderId) {
  const row = await db
    .prepare(`SELECT escalated FROM escalations WHERE sender_id = ?`)
    .bind(senderId)
    .first();

  return row?.escalated === 1;
}


// ─────────────────────────────────────────────────────────────────────────────
// setEscalated — mark a sender as escalated (bot goes silent)
// ─────────────────────────────────────────────────────────────────────────────
export async function setEscalated(db, senderId) {
  await db
    .prepare(`
      INSERT INTO escalations (sender_id, escalated, escalated_at)
      VALUES (?, 1, unixepoch())
      ON CONFLICT(sender_id) DO UPDATE SET
        escalated    = 1,
        escalated_at = unixepoch(),
        resolved_at  = NULL
    `)
    .bind(senderId)
    .run();
}


/* ── SUSPENDED — Phase A alert retry tracking ────────────────────────────────
// markAlertSent — called after successfully sending the WhatsApp staff alert
// Prevents the cron from retrying an alert that already got through
export async function markAlertSent(db, senderId) {
  await db
    .prepare(`
      UPDATE escalations
      SET alert_sent = 1, alert_sent_at = unixepoch()
      WHERE sender_id = ?
    `)
    .bind(senderId)
    .run();
}

// markAlertFailed — called when WhatsApp alert fails to send
// Sets alert_sent = 0 so the cron knows to retry
export async function markAlertFailed(db, senderId) {
  await db
    .prepare(`
      UPDATE escalations
      SET alert_sent = 0, alert_retries = alert_retries + 1
      WHERE sender_id = ?
    `)
    .bind(senderId)
    .run();
}

// getStuckEscalations — find escalations where alert was not confirmed sent
// Used by the 30-minute cron to retry failed alerts
//
// "Stuck" means:
//   escalated = 1 (active)
//   AND alert_sent = 0 (alert not confirmed delivered)
//   AND escalated_at was more than 10 minutes ago (give first attempt time to work)
//   AND alert_retries < 5 (stop retrying after 5 attempts — something is seriously wrong)
export async function getStuckEscalations(db) {
  const { results } = await db
    .prepare(`
      SELECT sender_id, escalated_at, alert_retries
      FROM escalations
      WHERE escalated = 1
        AND alert_sent = 0
        AND escalated_at < unixepoch() - 600
        AND alert_retries < 5
      ORDER BY escalated_at ASC
    `)
    .all();

  return results;
}
── END SUSPENDED ────────────────────────────────────────────────────────────── */


// ─────────────────────────────────────────────────────────────────────────────
// resolveEscalation — staff types !done — bot resumes
// ─────────────────────────────────────────────────────────────────────────────
export async function resolveEscalation(db, senderId) {
  await db
    .prepare(`
      UPDATE escalations
      SET escalated = 0, resolved_at = unixepoch()
      WHERE sender_id = ?
    `)
    .bind(senderId)
    .run();
}


// ─────────────────────────────────────────────────────────────────────────────
// saveIntake — store a completed repair booking
// ─────────────────────────────────────────────────────────────────────────────
export async function saveIntake(db, { senderId, customerName, deviceModel, fault, contact, preferredTime }) {
  await db
    .prepare(`
      INSERT INTO intakes (sender_id, customer_name, device_model, fault, contact, preferred_time)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .bind(senderId, customerName, deviceModel, fault, contact, preferredTime)
    .run();
}


// ─────────────────────────────────────────────────────────────────────────────
// getTodaysConversations — used by the daily summary cron
// ─────────────────────────────────────────────────────────────────────────────
export async function getTodaysConversations(db) {
  const { results } = await db
    .prepare(`
      SELECT sender_id, role, text, timestamp
      FROM conversations
      WHERE timestamp >= unixepoch('now', 'start of day')
      ORDER BY timestamp ASC
    `)
    .all();

  return results;
}


// ─────────────────────────────────────────────────────────────────────────────
// upsertContact / removeContact — sync a WhatsApp Business app contact
// (smb_app_state_sync webhook, Coexistence only)
// ─────────────────────────────────────────────────────────────────────────────
export async function upsertContact(db, { phoneNumber, fullName, firstName }) {
  await db
    .prepare(`
      INSERT INTO wa_contacts (phone_number, full_name, first_name)
      VALUES (?, ?, ?)
      ON CONFLICT(phone_number) DO UPDATE SET
        full_name  = excluded.full_name,
        first_name = excluded.first_name,
        updated_at = unixepoch()
    `)
    .bind(phoneNumber, fullName ?? null, firstName ?? null)
    .run();
}

export async function removeContact(db, phoneNumber) {
  await db.prepare(`DELETE FROM wa_contacts WHERE phone_number = ?`).bind(phoneNumber).run();
}


/* ═════════════════════════════════════════════════════════════════════════════
   SUSPENDED — PHASE B — DASHBOARD QUERY FUNCTIONS
   Was called by /admin/* API routes in index.js — those routes must also be
   suspended/commented while this block is off, or they'll throw on import.
   ═════════════════════════════════════════════════════════════════════════════

// getDashboardStats — headline numbers for the dashboard top bar
export async function getDashboardStats(db) {
  const [totalToday, activeEscalations, totalMessages, intakesToday] = await Promise.all([

    // Unique customers who messaged today
    db.prepare(`
      SELECT COUNT(DISTINCT sender_id) as count
      FROM conversations
      WHERE timestamp >= unixepoch('now', 'start of day')
    `).first(),

    // Currently active escalations (unresolved)
    db.prepare(`
      SELECT COUNT(*) as count FROM escalations WHERE escalated = 1
    `).first(),

    // Total messages sent and received today
    db.prepare(`
      SELECT COUNT(*) as count
      FROM conversations
      WHERE timestamp >= unixepoch('now', 'start of day')
    `).first(),

    // Repair intakes collected today
    db.prepare(`
      SELECT COUNT(*) as count
      FROM intakes
      WHERE timestamp >= unixepoch('now', 'start of day')
    `).first(),

  ]);

  return {
    customersToday:    totalToday?.count     ?? 0,
    activeEscalations: activeEscalations?.count ?? 0,
    messagesToday:     totalMessages?.count  ?? 0,
    intakesToday:      intakesToday?.count   ?? 0,
  };
}

// getActiveEscalations — all unresolved escalations with last message and timing
// Shown at the top of the dashboard as "Needs Attention"
export async function getActiveEscalations(db) {
  const { results } = await db
    .prepare(`
      SELECT
        e.sender_id,
        e.escalated_at,
        e.alert_sent,
        e.alert_retries,
        c.text as last_message
      FROM escalations e
      LEFT JOIN conversations c ON c.id = (
        SELECT id FROM conversations
        WHERE sender_id = e.sender_id AND role = 'user'
        ORDER BY timestamp DESC LIMIT 1
      )
      WHERE e.escalated = 1
      ORDER BY e.escalated_at ASC
    `)
    .all();

  // Add human-readable elapsed time to each
  const now = Math.floor(Date.now() / 1000);
  return results.map(r => ({
    ...r,
    minutes_waiting: Math.floor((now - r.escalated_at) / 60),
    alert_status: r.alert_sent ? 'sent' : r.alert_retries > 0 ? 'failed' : 'pending',
  }));
}

// getTodayConversationList — list of unique customers active today
// Each entry shows sender, message count, last message text and time
export async function getTodayConversationList(db) {
  const { results } = await db
    .prepare(`
      SELECT
        c.sender_id,
        COUNT(*) as message_count,
        MAX(c.timestamp) as last_active,
        (SELECT text FROM conversations
         WHERE sender_id = c.sender_id
         ORDER BY timestamp DESC LIMIT 1) as last_message,
        (SELECT role FROM conversations
         WHERE sender_id = c.sender_id
         ORDER BY timestamp DESC LIMIT 1) as last_role,
        COALESCE(e.escalated, 0) as is_escalated
      FROM conversations c
      LEFT JOIN escalations e ON e.sender_id = c.sender_id
      WHERE c.timestamp >= unixepoch('now', 'start of day')
      GROUP BY c.sender_id
      ORDER BY last_active DESC
    `)
    .all();

  return results;
}

// getConversationThread — full message history for a specific sender
// Used when staff click "View" on a conversation in the dashboard
export async function getConversationThread(db, senderId, limit = 50) {
  const { results } = await db
    .prepare(`
      SELECT role, text, timestamp
      FROM conversations
      WHERE sender_id = ?
      ORDER BY timestamp ASC
      LIMIT ?
    `)
    .bind(senderId, limit)
    .all();

  return results;
}

   ═════════════════════════════════════════════════════════════════════════════
   END SUSPENDED — PHASE B
   ═════════════════════════════════════════════════════════════════════════════ */