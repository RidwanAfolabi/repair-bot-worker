# repair-bot-worker

WhatsApp AI assistant for **iFix Express**, a phone repair and mobile accessories chain with branches in Kedah and Penang, Malaysia. The assistant is named **A'aisyah**. It runs as a single Cloudflare Worker on the shop's real WhatsApp Business number, using [WhatsApp Business Coexistence](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/) so the AI and the human staff share one number and one conversation history.

## What it does

- Answers customer enquiries in Bahasa Malaysia, English, or Manglish — matching whichever the customer used
- Looks up live repair pricing from a Google Sheet (per-brand tabs), not a static price list
- Collects repair bookings conversationally and records them as structured intake records
- Routes a confirmed booking to the correct branch's own WhatsApp, with an automatic fallback to an approved message template when that branch is outside WhatsApp's 24-hour messaging window
- Escalates to staff (auto-mute, self-resolving) when it doesn't know the answer, and lets staff take manual control per-customer or globally via chat commands
- Is aware of real time — won't tell a customer the shop is open at 8am when it isn't
- Sends a one-time AI-disclosure notice to new or long-absent customers, linking the privacy policy
- Deletes conversation history older than 12 months on a daily cron, to back the privacy policy's retention promise

## Architecture

```
WhatsApp Cloud API  ──webhook──▶  Cloudflare Worker (src/index.js)
                                        │
                    ┌───────────────────┼────────────────────┐
                    ▼                   ▼                    ▼
              src/bot.js          src/db.js (D1)       src/googleSheets.js
           (conversation                 │              (live pricing,
            pipeline)             conversations,          cached in D1)
                    │              escalations,
                    ▼              intakes, etc.
              src/llm.js
        (Gemini or Claude,
         provider-swappable)
                    │
                    ▼
              src/prompt.js
        (A'aisyah's system prompt
         and knowledge base)
```

Everything runs in one Worker, one D1 database, no queues or Durable Objects. State that needs to survive a request (mute status, conversation history, cached pricing, bookings) lives in D1; everything else is computed per-request.

## Project structure

| File | Responsibility |
|---|---|
| `src/index.js` | Worker entry point — HTTP routes, webhook dispatch by Meta field type, cron (`scheduled()`) |
| `src/bot.js` | The conversation pipeline: staff commands, debounce, AI notice, pricing lookup, LLM call, intake capture, escalation, human-paced sending |
| `src/db.js` | All D1 schema and queries |
| `src/llm.js` | Gemini/Claude provider abstraction, switched via `LLM_PROVIDER` |
| `src/prompt.js` | A'aisyah's system prompt — persona, tone rules, branch info, pricing/intake instructions, real conversation examples |
| `src/pricing.js` | Matches customer text to a Google Sheet brand tab; formats pricing context for the LLM |
| `src/googleSheets.js` | Google Sheets API v4 client (JWT service-account auth), D1-backed caching |
| `src/businessHours.js` | Computes live open/closed status for `Asia/Kuala_Lumpur`, injected into the prompt |
| `src/branches.js` | Parses `BRANCH_NUMBERS`, matches a booking's branch text to a branch's WhatsApp number |
| `src/phone.js` | Identifier normalisation and matching — phone numbers *and* WhatsApp Business-Scoped User IDs (BSUIDs, for customers using a WhatsApp username) |
| `src/whatsapp.js` | All outbound Meta Graph API calls (text, read receipts, templates) |

## Setup

Requires Node.js and a Cloudflare account with:
- A [D1 database](https://developers.cloudflare.com/d1/) bound as `DB` (see `wrangler.jsonc`)
- A WhatsApp Business Cloud API app with Coexistence enabled
- A Google Cloud service account with read access to the pricing spreadsheet
- A Gemini or Anthropic API key

```bash
npm install
```

### Configuration

`wrangler.jsonc`'s `vars` block holds non-sensitive config. **Never put a secret there** — it is committed to git, and every `wrangler deploy` resets it to the file's value, silently overwriting anything set differently in the dashboard.

| Var | Purpose | Default |
|---|---|---|
| `BOT_ENABLED` | Global developer kill switch (code-level, needs a deploy to flip) | `true` |
| `MUTE_WINDOW_MINUTES` | How long an auto-escalation mute lasts before self-resolving | — |
| `LLM_PROVIDER` | `gemini` or `claude` | — |
| `GEMINI_MODEL` / `CLAUDE_MODEL` | Model id for the active provider | see `llm.js` |
| `GOOGLE_SHEET_ID` | The pricing spreadsheet | — |
| `MESSAGE_DEBOUNCE_MS` | Wait before replying, to catch a burst of messages as one | `4000` |
| `HISTORY_MESSAGE_LIMIT` | Messages of history sent to the LLM per reply | `32` |
| `AI_NOTICE_DAYS` | Days of inactivity before the AI-disclosure notice repeats | `14` |
| `CONVERSATION_RETENTION_DAYS` | Retention window for the daily purge cron | `365` |
| `BRANCH_TEMPLATE_LANG` | Language code for the branch-notification template | `en` |

Secrets (`npx wrangler secret put <NAME>`, real business data — never in `wrangler.jsonc`):

| Secret | Purpose |
|---|---|
| `WA_TOKEN`, `WA_PHONE_NUMBER_ID`, `WA_VERIFY_TOKEN` | WhatsApp Cloud API credentials |
| `STAFF_WA_NUMBER` | Manager's WhatsApp for staff commands and alerts. **Must differ from the Coexistence-connected number** — the Cloud API cannot send a message to the same number it sends from; setting this wrong makes every alert silently fail to deliver |
| `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` | Whichever `LLM_PROVIDER` is active |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY` | Google Sheets service account |
| `TEST_ALLOWLIST` | Comma-separated numbers/BSUIDs the bot will reply to; `*` for everyone. **Fails closed** — unset means nobody is served |
| `DELISTED_NUMBERS` | Comma-separated numbers/BSUIDs the bot must never process, in any form, at all |
| `BRANCH_NUMBERS` | `Name=number` pairs (comma, newline, or semicolon separated — see `src/branches.js`) routing a confirmed booking to each branch's own WhatsApp |
| `BRANCH_TEMPLATE_NAME` | Approved Meta template name used when a branch is outside the 24-hour window (optional — booking still reaches staff without it, just not the branch) |
| `META_APP_SECRET`, `EMBEDDED_SIGNUP_URL` | Embedded Signup onboarding |

`TEST_ALLOWLIST` and `DELISTED_NUMBERS` accept both phone numbers (any formatting — normalised internally) and BSUIDs (`CC.alphanumeric`, for customers who have adopted a WhatsApp username and hidden their number).

## Local development

```bash
npm run dev          # wrangler dev
npm test              # run the suite once
npm run test:watch    # watch mode
npm run check:schema  # compare live D1 against what the code expects (read-only, needs Cloudflare auth)
```

**`npm run dev` is not currently in use with real credentials.** No `.dev.vars` file exists in this project — all local development so far has happened through `npm test`, which mocks WhatsApp, the LLM, and Google Sheets entirely and needs no real secrets at all. That covers the actual bot logic; it does not exercise real Cloud API calls.

If you do want to run `wrangler dev` against real services: copy `.dev.vars.example` to `.dev.vars` (gitignored) and fill in each value. Secret **values** can't be read back from Cloudflare once set — `npx wrangler secret list` shows names only — so pull them from wherever your own copies are kept (password manager, the Meta/Google consoles, etc.), not from the dashboard. `vars` declared in `wrangler.jsonc` (`BOT_ENABLED`, `LLM_PROVIDER`, …) are already available locally and don't need to be duplicated in `.dev.vars`.

## Testing

`npm test` runs entirely against **local** state — [`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/) spins up a local Miniflare runtime with a local SQLite-backed D1, gitignored under `.wrangler/`. Nothing touches remote Cloudflare resources; it is safe to run freely, including tests that `DELETE FROM conversations`.

124 tests across 6 files, WhatsApp/LLM/Google Sheets mocked at the boundary:

| File | Covers |
|---|---|
| `test/phone.spec.js` | Identifier normalisation and matching, including BSUIDs |
| `test/businessHours.spec.js` | Open/closed boundary conditions |
| `test/db.spec.js` | Schema, history ordering, retention purge, intake storage |
| `test/bot.spec.js` | AI notice, intake capture, escalation |
| `test/webhook.spec.js` | Full `worker.fetch()` — allowlist/delist precedence, media handling, sender resolution, cron dispatch |
| `test/branches.spec.js` | Branch routing and the 24-hour-window template fallback |

**`npm run check:schema` is the one thing local tests structurally cannot cover.** Local D1 is always created fresh with the current schema by `initDb()`, so a missing column never shows up locally — it only surfaces against the real, accumulated production database (`CREATE TABLE IF NOT EXISTS` never alters an existing table). Run it whenever a change touches a `CREATE TABLE` in `db.js`, ideally before deploying.

## Deployment

**This repository is connected to [Cloudflare Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) — pushing to GitHub triggers an automatic build and deploy on Cloudflare's side.** There is no GitHub Actions workflow; the connection is configured in the Cloudflare dashboard, not in this repo. `git push` **is** the deploy.

**`main` is the production branch** — it's what's actually live at the real WhatsApp number. Other branches also trigger their own Cloudflare Workers Builds deploy on push, but those are separate, not-for-production builds; day-to-day work should stay off `main` until it's ready to go live.

A git hook runs the test suite before every push, since that push will go live:

```bash
git config core.hooksPath .githooks   # once per clone
```

`.githooks/pre-push` blocks the push if any test fails (`git push --no-verify` overrides deliberately). It does **not** run the schema-drift check, since that needs live Cloudflare credentials — run `npm run check:schema` by hand for schema changes.

`npm run deploy` (`predeploy` → `npm test && npm run check:schema`, then `wrangler deploy`) is the equivalent gate for deploying directly from the terminal.

## Data model (D1)

| Table | Holds |
|---|---|
| `conversations` | Every message, `role` in `customer` / `ai-assistant` / `staff`; purged past `CONVERSATION_RETENTION_DAYS` |
| `escalations` | Per-customer mute state — `manual` (staff `!pause`, never expires on its own) vs `auto` (self-resolving after `MUTE_WINDOW_MINUTES`) |
| `intakes` | Completed repair bookings — name, device, fault, branch, contact, preferred time |
| `wa_contacts` | Contact names synced from the shop's WhatsApp Business App address book |
| `external_cache` | Generic cache (Google OAuth token, pricing sheet rows) |
| `bot_settings` | Key/value store — currently just the `!pauseall` / `!resumeall` global switch |
| `connected_numbers` | Coexistence onboarding records (WABA id, phone number id) — created in `index.js`, not `db.js` |

## WhatsApp integration notes

- **Coexistence-specific webhooks**: `smb_message_echoes` (staff replied via the Business App — auto-mutes the bot for that customer), `smb_app_state_sync` (contact sync), `history` (one-time chat backfill after onboarding), `account_update` (Embedded Signup completion).
- **Media** (image/video/document/audio): no auto-reply to the customer, staff alerted, event logged as context so the LLM can pick the conversation back up from the customer's next message. This matters because A'aisyah routinely *asks* for a photo before diagnosing — auto-replying to every arriving image used to end the conversation at exactly the moment the customer complied.
- **Message edits**: recovered and treated as a normal message when Meta includes the new text (Coexistence numbers only); silently ignored otherwise.
- **WhatsApp usernames / BSUIDs**: since mid-2026 a customer can hide their phone number behind a username. Meta then omits `from`/`wa_id` and identifies them by a Business-Scoped User ID instead. Handled throughout — matching, display in staff alerts, history sync attribution — see `src/phone.js`.

## Manager commands

Sent from `STAFF_WA_NUMBER`, either directly or via a self-chat note in the WhatsApp Business App:

| Command | Effect |
|---|---|
| `!pause <number>` | Mute the bot for one customer until `!resume` (manual, never auto-expires) |
| `!resume <number>` | Unmute one customer |
| `!pauseall` / `!resumeall` | Global switch, instant |
| `!status` | Global state + counts of muted customers |
| `!muted` | List currently muted customers with mute type and age |
| `!help` | This list |

## Operational scripts

- **`scripts/wipe_for_number_swap.sql`** — clears all customer-facing data (`conversations`, `wa_contacts`, `connected_numbers`, etc.) before onboarding a new WhatsApp number, so old and new number data never mix. Destructive; the file's own header documents the exact backup → deploy → wipe order and why it matters. Run via `npx wrangler d1 execute repair-bot-db --remote --file=scripts/wipe_for_number_swap.sql`.
- **`scripts/check-schema-drift.mjs`** — see Testing above.

## Known gaps

- `handleOAuthCallback` in `index.js` (~220 lines) is dead code — the route is commented out, confirmed never to fire under Hosted Embedded Signup's actual delivery mechanism (`account_update` webhook, which is what's actually used). Kept for now, not deleted.
- `parseStructuredDeviceReply` in `pricing.js` is unused — superseded when pricing lookup moved to letting the LLM search a whole matched brand tab itself.
- The raw `account_update` payload dump in `index.js` (`[Webhook] RAW account_update payload:`) was added temporarily to find a field during onboarding debugging; safe to remove now that onboarding is stable.
- A daily enquiry-summary cron slot is reserved (`0 13 * * *`, 9pm Malaysia) but deliberately not registered in `wrangler.jsonc` — the `scheduled()` dispatcher has a stub case for it, and some of the D1 query functions it would use (`getTodaysConversations`) already exist. Not built.
