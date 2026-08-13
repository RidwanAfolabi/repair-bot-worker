-- ─────────────────────────────────────────────────────────────────────────────
-- One-time migration: expand conversations.role
--   from ('user', 'assistant')
--   to   ('customer', 'ai-assistant', 'staff')
--
-- WHY A FULL TABLE REBUILD: SQLite has no ALTER for CHECK constraints. The
-- only way to change one is create-new / copy / drop-old / rename, which is
-- what this file does. That is also exactly why this is a MANUAL one-time
-- script rather than something initDb() does — initDb runs on every single
-- request, and a rebuild on that path would mean repeated rebuilds, races
-- between concurrent requests, and a partial failure leaving the table
-- broken. Running it once, deliberately, contains the risk to a single act.
--
-- ── HOW TO RUN ───────────────────────────────────────────────────────────────
-- 1. BACK UP FIRST. This script drops a table holding live conversation
--    history; there is no undo:
--       npx wrangler d1 export repair-bot-db --remote --output backup.sql
--
-- 2. Then run this migration:
--       npx wrangler d1 execute repair-bot-db --remote --file=migrate_role.sql
--
-- 3. Verify — this should return only the three new role values:
--       npx wrangler d1 execute repair-bot-db --remote \
--         --command "SELECT role, COUNT(*) n FROM conversations GROUP BY role"
--
-- 4. ONLY THEN deploy the code:
--       npx wrangler deploy
--
-- Order matters. The deployed code writes 'customer'/'ai-assistant'/'staff',
-- which the OLD CHECK constraint rejects — so deploying before migrating
-- breaks every write. Migrating before deploying is safe in the other
-- direction only for as long as it takes to deploy: the old code writes
-- 'user'/'assistant', which the NEW constraint rejects. Keep the gap short
-- and run this at a quiet hour.
--
-- ── ON THE HISTORICAL ROWS ───────────────────────────────────────────────────
-- Existing 'assistant' rows cannot be retroactively split into ai-assistant
-- vs staff — that distinction did not exist until now, and nothing in the
-- stored data records who authored them. They all become 'ai-assistant',
-- the majority case. Every row written from the deploy onward is labeled
-- accurately by the updated write sites in index.js / bot.js.
--
-- ── NOTES ────────────────────────────────────────────────────────────────────
-- - id is copied explicitly, preserving both message identity and insertion
--   order (getRecentMessages uses id to break same-second timestamp ties).
-- - The live conversations table has no indexes and no foreign keys
--   referencing it, so DROP TABLE loses nothing beyond the table itself.
-- - Column list below matches the live schema exactly; nothing is dropped.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE conversations_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id   TEXT    NOT NULL,
  role        TEXT    NOT NULL CHECK(role IN ('customer', 'ai-assistant', 'staff')),
  text        TEXT    NOT NULL,
  timestamp   INTEGER NOT NULL DEFAULT (unixepoch()),
  escalated   INTEGER NOT NULL DEFAULT 0
);

INSERT INTO conversations_new (id, sender_id, role, text, timestamp, escalated)
SELECT
  id,
  sender_id,
  CASE role
    WHEN 'user'      THEN 'customer'
    WHEN 'assistant' THEN 'ai-assistant'
    ELSE role
  END,
  text,
  timestamp,
  escalated
FROM conversations;

DROP TABLE conversations;

ALTER TABLE conversations_new RENAME TO conversations;
