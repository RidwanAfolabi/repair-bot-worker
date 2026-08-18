-- ─────────────────────────────────────────────────────────────────────────────
-- Clean slate before onboarding a NEW WhatsApp number.
--
-- Clears every trace of the old number so its synced history, contacts and
-- conversation state cannot mix with the new number's data.
--
-- Run every command below from the PROJECT ROOT, not from scripts/.
--
-- RUN ONLY AFTER:
--   1. npx wrangler d1 export repair-bot-db --remote --output backup-YYYY-MM-DD.sql
--   2. Disconnect the old number in Meta Business Manager (stops all webhook
--      traffic, so step 3 has no live messages to lose)
--   3. npx wrangler deploy      <-- must be the NEW code, see note below
--
-- THEN RUN THIS FILE:
--   npx wrangler d1 execute repair-bot-db --remote --file=scripts/wipe_for_number_swap.sql
--
-- WHY DEPLOY FIRST: conversations is DROPPED rather than emptied, so that
-- initDb() recreates it from the CURRENT deployed schema. Deploying first
-- means it comes back with the new
--   CHECK(role IN ('customer','ai-assistant','staff'))
-- constraint already in place, so no separate role migration is needed at
-- all: there is no data left to migrate, and no window where the deployed
-- code and the live constraint disagree. If you drop this while the OLD code
-- is still deployed, the next request recreates the table with the OLD
-- constraint and you are back to needing a migration.
--
-- AFTER RUNNING, recreate the tables immediately by hitting the health
-- endpoint (initDb runs on every request, including this one):
--   curl https://bot.ifixexpress.com.my/
--
-- Then verify the new schema really is in place:
--   npx wrangler d1 execute repair-bot-db --remote \
--     --command "SELECT sql FROM sqlite_master WHERE name='conversations'"
-- ─────────────────────────────────────────────────────────────────────────────

-- Conversation history (1,383 rows) — dropped, not emptied, to pick up the
-- new role schema from initDb. Recreated by initDb on the next request.
DROP TABLE IF EXISTS conversations;

-- Per-customer mute / escalation state tied to old-number customers.
DELETE FROM escalations;

-- Contact names synced from the old number's WhatsApp Business App.
DELETE FROM wa_contacts;

-- Repair intake records from old-number customers. Dropped rather than
-- emptied for the same reason as conversations above: intakes gained a
-- `branch` column when booking capture was completed, and CREATE TABLE IF
-- NOT EXISTS will not add a column to a table that already exists. The
-- table is empty, so nothing is lost by letting initDb rebuild it.
--
-- If this wipe was already run BEFORE that change shipped, the table came
-- back without the branch column. Add it with:
--   npx wrangler d1 execute repair-bot-db --remote \
--     --command "ALTER TABLE intakes ADD COLUMN branch TEXT"
DROP TABLE IF EXISTS intakes;

-- Manager toggles, e.g. bot_enabled set by !pauseall (currently empty).
DELETE FROM bot_settings;

-- The old number's Coexistence connection records — waba_id and
-- phone_number_id from previous onboarding. THE MOST IMPORTANT ONE for a
-- number swap: leaving these behind means the new onboarding writes a third
-- active row alongside two stale ones, all marked active = 1.
DELETE FROM connected_numbers;

-- OPTIONAL — not old-number data at all. This is the Google Sheets pricing
-- cache plus the Google OAuth access token; nothing here is tied to
-- WhatsApp. Clearing it is harmless, it just re-fetches from Google on the
-- first message. Comment this line out if you would rather keep the cache
-- warm through the swap.
-- DELETE FROM external_cache;

-- ─────────────────────────────────────────────────────────────────────────────
-- NOT LISTED HERE ON PURPOSE: sqlite_sequence
--
-- SQLite's own AUTOINCREMENT bookkeeping, holding the highest id ever used
-- per table. It needs no action: dropping a table automatically removes its
-- sqlite_sequence row, so the DROP above clears the only entry that exists
-- (conversations). intakes also declares AUTOINCREMENT but has never had a
-- row inserted, so it has no entry to clear.
--
-- Do NOT add "DROP TABLE sqlite_sequence" — it is internal and dropping it
-- breaks AUTOINCREMENT. "DELETE FROM sqlite_sequence" is legal but pointless
-- here, and is actively unsafe on a table that still holds rows: ids would
-- restart from 1 and collide with existing ones.
-- ─────────────────────────────────────────────────────────────────────────────
