/**
 * db.js — Cloudflare D1 database helpers
 *
 * Tables:
 *   conversations   — every message in and out, per customer
 *   intakes         — completed repair booking details
 *   escalations     — tracks which customers have been escalated to staff
 *   wa_contacts     — Coexistence: contacts synced from the WhatsApp Business app
 *   external_cache  — generic key/value cache for external API data (see googleSheets.js)
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
        role        TEXT    NOT NULL CHECK(role IN ('customer', 'ai-assistant', 'staff')),
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
    // escalated=1 means the bot stays silent for that sender_id.
    // mute_type distinguishes WHY:
    //   'auto'   — either staff replied via WhatsApp Business App (Coexistence
    //              smb_message_echoes), or the bot itself escalated (unknown
    //              price, ambiguous message, etc — see bot.js shouldEscalate).
    //              Expires after MUTE_WINDOW_MINUTES of inactivity — bot
    //              resumes on its own, no action needed. If it escalates
    //              again after resuming, this just refreshes the same timer.
    //   'manual' — staff explicitly sent !pause. Never expires — only !resume
    //              clears it. The one case that requires deliberate staff
    //              action to set; everything else self-resolves.
    // (Phase A would have added alert_sent, alert_sent_at, alert_retries here
    // — see suspended block near the bottom of this file)
    db.prepare(`
      CREATE TABLE IF NOT EXISTS escalations (
        sender_id    TEXT    PRIMARY KEY,
        escalated    INTEGER NOT NULL DEFAULT 0,
        escalated_at INTEGER,
        resolved_at  INTEGER,
        mute_type    TEXT    NOT NULL DEFAULT 'manual'
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

    // Generic external-data cache — used by googleSheets.js to avoid
    // re-authenticating with Google and re-fetching the price list on every
    // single customer message. Two keys currently: 'google_access_token'
    // (Google OAuth token, ~1hr lifespan) and 'pricing_sheet_rows' (the
    // parsed price list itself, shorter TTL). Generic enough to reuse for
    // any future external data source without a new table.
    db.prepare(`
      CREATE TABLE IF NOT EXISTS external_cache (
        cache_key   TEXT PRIMARY KEY,
        cache_value TEXT NOT NULL,
        cached_at   INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `),

    // Bot-wide settings the manager controls directly via WhatsApp commands
    // (!pauseall / !resumeall — see bot.js handleStaffCommand), separate
    // from BOT_ENABLED in wrangler.jsonc. Two independent layers: this one
    // is instant, no deploy needed; wrangler.jsonc's BOT_ENABLED remains a
    // developer-level emergency stop underneath it. Bot replies only if
    // both are enabled — see the kill switch in index.js.
    db.prepare(`
      CREATE TABLE IF NOT EXISTS bot_settings (
        setting_key   TEXT PRIMARY KEY,
        setting_value TEXT NOT NULL,
        updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `),

  ]);

  // Active migration — adds mute_type to escalations tables created before
  // this column existed. Safe to repeat; fails silently if already present.
  try {
    await db.prepare(`ALTER TABLE escalations ADD COLUMN mute_type TEXT NOT NULL DEFAULT 'manual'`).run();
  } catch {
    // Column already exists — safe to ignore
  }

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
//
// Returns the inserted row's id — used by bot.js's debounce check (see
// getLatestUserMessageId below) to tell whether a given customer message is
// still the newest one by the time its reply is about to be generated.
// ─────────────────────────────────────────────────────────────────────────────
export async function saveMessage(db, { senderId, role, text, timestamp }) {
  // timestamp is optional — pass it when backfilling history sync so messages
  // keep their real device time instead of all landing at insert time.
  let result;
  if (timestamp) {
    result = await db
      .prepare(`INSERT INTO conversations (sender_id, role, text, timestamp) VALUES (?, ?, ?, ?)`)
      .bind(senderId, role, text, timestamp)
      .run();
  } else {
    result = await db
      .prepare(`INSERT INTO conversations (sender_id, role, text) VALUES (?, ?, ?)`)
      .bind(senderId, role, text)
      .run();
  }
  return result.meta.last_row_id;
}


// ─────────────────────────────────────────────────────────────────────────────
// getLatestUserMessageId — highest conversations.id among a sender's
// 'customer'-role messages. Used by bot.js's debounce check: if a customer
// sends two messages in quick succession, each spawns its own independent
// webhook invocation (nothing serializes them) — this lets a given
// invocation tell whether a newer customer message has arrived since its
// own, so it can bail out and let only the LATEST message's invocation
// actually reply, with full context of everything in the burst.
// ─────────────────────────────────────────────────────────────────────────────
export async function getLatestUserMessageId(db, senderId) {
  const row = await db
    .prepare(`SELECT MAX(id) as maxId FROM conversations WHERE sender_id = ? AND role = 'customer'`)
    .bind(senderId)
    .first();

  return row?.maxId ?? null;
}


// ─────────────────────────────────────────────────────────────────────────────
// getRecentMessages — fetch last N messages for a sender
//
// Returns them in chronological order (oldest first) so they can be
// passed directly to the LLM as conversation history.
//
// Ordered by timestamp with id as a tiebreaker, NOT timestamp alone.
// timestamp is second-granularity (unixepoch()), and several messages
// routinely land in the same second — a customer's burst, or a reply saved
// moments after the message that prompted it. Among rows sharing a
// timestamp SQLite is free to return any order, which silently scrambled
// the history handed to the LLM. id is INTEGER PRIMARY KEY AUTOINCREMENT,
// so it strictly follows insertion order and breaks those ties correctly.
//
// timestamp stays the PRIMARY sort key on purpose: history-sync backfill
// (see index.js) inserts genuinely old messages with brand-new high ids,
// carrying their real Meta timestamps — sorting by id first would drag
// those to the wrong end of the conversation.
// ─────────────────────────────────────────────────────────────────────────────
export async function getRecentMessages(db, senderId, limit = 6) {
  const { results } = await db
    .prepare(`
      SELECT role, text FROM conversations
      WHERE sender_id = ?
      ORDER BY timestamp DESC, id DESC
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
// 'manual' mutes (staff sent !pause) never expire on their own — only !resume
// clears them. 'auto' mutes (staff replied via WhatsApp Business App, OR the
// bot's own escalation trigger fired) expire after MUTE_WINDOW_MINUTES of
// inactivity — bot resumes automatically, no staff action required.
// ─────────────────────────────────────────────────────────────────────────────
export async function isEscalated(db, senderId, env) {
  const row = await db
    .prepare(`SELECT escalated, escalated_at, mute_type FROM escalations WHERE sender_id = ?`)
    .bind(senderId)
    .first();

  if (!row || row.escalated !== 1) return false;
  if (row.mute_type === 'manual') return true;

  const windowMinutes = Number(env?.MUTE_WINDOW_MINUTES ?? 75);
  const windowSeconds = windowMinutes * 60;
  const nowSeconds     = Math.floor(Date.now() / 1000);

  return (nowSeconds - row.escalated_at) < windowSeconds;
}


// ─────────────────────────────────────────────────────────────────────────────
// setManualMute — staff explicitly sent !pause. This is the ONLY caller that
// should ever set 'manual' — everything else (staff app replies, the bot's
// own escalation trigger) goes through refreshAutoMute below instead, so it
// self-resolves after MUTE_WINDOW_MINUTES rather than needing !resume.
// Never expires — only resolveEscalation (!resume) clears it.
// ─────────────────────────────────────────────────────────────────────────────
export async function setManualMute(db, senderId) {
  await db
    .prepare(`
      INSERT INTO escalations (sender_id, escalated, escalated_at, mute_type)
      VALUES (?, 1, unixepoch(), 'manual')
      ON CONFLICT(sender_id) DO UPDATE SET
        escalated    = 1,
        escalated_at = unixepoch(),
        resolved_at  = NULL,
        mute_type    = 'manual'
    `)
    .bind(senderId)
    .run();
}


// ─────────────────────────────────────────────────────────────────────────────
// refreshAutoMute — either staff replied via WhatsApp Business App, or the
// bot's own escalation trigger fired (see bot.js shouldEscalate). Both cases
// are self-resolving, not permanent — resets the mute window, expiring after
// MUTE_WINDOW_MINUTES of inactivity, unless the customer is under a
// CURRENTLY ACTIVE 'manual' mute (explicit !pause not yet !resume'd), which
// always takes priority and must not be downgraded to 'auto'.
//
// Deliberately checks escalated = 1 alongside mute_type = 'manual' here, not
// mute_type alone — resolveEscalation (!resume) clears escalated but leaves
// mute_type on the row untouched, so a sender_id that was ever manually
// paused, even once, keeps that column set to 'manual' in D1 forever. Without
// the escalated = 1 check, that stale value would keep getting inherited by
// every future, unrelated escalation episode for that same sender — locking
// them into permanent manual mutes despite never being re-!pause'd. This
// only preserves 'manual' when there's an active mute in force right now.
// ─────────────────────────────────────────────────────────────────────────────
export async function refreshAutoMute(db, senderId) {
  await db
    .prepare(`
      INSERT INTO escalations (sender_id, escalated, escalated_at, mute_type)
      VALUES (?, 1, unixepoch(), 'auto')
      ON CONFLICT(sender_id) DO UPDATE SET
        escalated    = 1,
        escalated_at = unixepoch(),
        resolved_at  = NULL,
        mute_type    = CASE
                          WHEN escalations.mute_type = 'manual' AND escalations.escalated = 1
                          THEN 'manual'
                          ELSE 'auto'
                        END
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
// resolveEscalation — staff types !resume — bot resumes
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
      -- id tiebreaker: see getRecentMessages above for why timestamp alone
      -- is not a stable sort here
      ORDER BY timestamp ASC, id ASC
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


// ─────────────────────────────────────────────────────────────────────────────
// getCache / setCache — generic external-data cache (see googleSheets.js)
//
// cachedAt is unix seconds — callers decide their own freshness window by
// comparing it against the current time; this layer has no opinion on TTL.
// ─────────────────────────────────────────────────────────────────────────────
export async function getCache(db, key) {
  const row = await db
    .prepare(`SELECT cache_value, cached_at FROM external_cache WHERE cache_key = ?`)
    .bind(key)
    .first();

  if (!row) return null;
  return { value: row.cache_value, cachedAt: row.cached_at };
}

export async function setCache(db, key, value) {
  await db
    .prepare(`
      INSERT INTO external_cache (cache_key, cache_value, cached_at)
      VALUES (?, ?, unixepoch())
      ON CONFLICT(cache_key) DO UPDATE SET
        cache_value = excluded.cache_value,
        cached_at   = unixepoch()
    `)
    .bind(key, value)
    .run();
}


// ─────────────────────────────────────────────────────────────────────────────
// getSetting / setSetting — bot_settings key/value store, used by the
// manager's !pauseall / !resumeall commands (see bot.js handleStaffCommand)
// ─────────────────────────────────────────────────────────────────────────────
export async function getSetting(db, key) {
  const row = await db
    .prepare(`SELECT setting_value FROM bot_settings WHERE setting_key = ?`)
    .bind(key)
    .first();

  return row?.setting_value ?? null;
}

export async function setSetting(db, key, value) {
  await db
    .prepare(`
      INSERT INTO bot_settings (setting_key, setting_value, updated_at)
      VALUES (?, ?, unixepoch())
      ON CONFLICT(setting_key) DO UPDATE SET
        setting_value = excluded.setting_value,
        updated_at    = unixepoch()
    `)
    .bind(key, value)
    .run();
}


// ─────────────────────────────────────────────────────────────────────────────
// getActiveMutes — every sender currently muted, with mute type and when it
// started. Powers the manager's !status and !muted commands.
//
// 'auto' mutes expire lazily — isEscalated() computes the MUTE_WINDOW_MINUTES
// expiry live on every check rather than eagerly clearing the DB row, so a
// stale 'auto' row can sit at escalated=1 in the table long after the bot
// has already resumed replying to that customer. env is optional so callers
// that don't have it (or don't care about that distinction) still get raw
// results back, but !status/!muted always pass it so what staff sees matches
// what the bot is actually doing.
// ─────────────────────────────────────────────────────────────────────────────
export async function getActiveMutes(db, env) {
  const { results } = await db
    .prepare(`
      SELECT sender_id, mute_type, escalated_at
      FROM escalations
      WHERE escalated = 1
      ORDER BY escalated_at DESC
    `)
    .all();

  if (!env) return results;

  const windowMinutes = Number(env.MUTE_WINDOW_MINUTES ?? 75);
  const windowSeconds = windowMinutes * 60;
  const nowSeconds    = Math.floor(Date.now() / 1000);

  return results.filter(row => {
    if (row.mute_type === 'manual') return true;
    return (nowSeconds - row.escalated_at) < windowSeconds;
  });
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
        WHERE sender_id = e.sender_id AND role = 'customer'
        ORDER BY timestamp DESC, id DESC LIMIT 1
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
         ORDER BY timestamp DESC, id DESC LIMIT 1) as last_message,
        (SELECT role FROM conversations
         WHERE sender_id = c.sender_id
         ORDER BY timestamp DESC, id DESC LIMIT 1) as last_role,
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
      ORDER BY timestamp ASC, id ASC
      LIMIT ?
    `)
    .bind(senderId, limit)
    .all();

  return results;
}

   ═════════════════════════════════════════════════════════════════════════════
   END SUSPENDED — PHASE B
   ═════════════════════════════════════════════════════════════════════════════ */