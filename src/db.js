/**
 * db.js — Cloudflare D1 database helpers
 *
 * Tables:
 *   conversations — every message in and out, per customer
 *   intakes       — completed repair booking details
 *   escalations   — tracks which customers have been escalated to staff
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
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_id    TEXT    NOT NULL,
        customer_name TEXT,
        device_model  TEXT,
        fault         TEXT,
        contact       TEXT,
        preferred_time TEXT,
        timestamp     INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `),

    // Escalation state per customer
    // When escalated = 1, the bot stays silent for that sender_id
    db.prepare(`
      CREATE TABLE IF NOT EXISTS escalations (
        sender_id    TEXT    PRIMARY KEY,
        escalated    INTEGER NOT NULL DEFAULT 0,
        escalated_at INTEGER,
        resolved_at  INTEGER
      )
    `),

  ]);
}


// ─────────────────────────────────────────────────────────────────────────────
// saveMessage — persist a single message to the conversations table
// ─────────────────────────────────────────────────────────────────────────────
export async function saveMessage(db, { senderId, role, text }) {
  await db
    .prepare(`INSERT INTO conversations (sender_id, role, text) VALUES (?, ?, ?)`)
    .bind(senderId, role, text)
    .run();
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