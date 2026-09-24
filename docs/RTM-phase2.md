# Requirement Traceability Matrix — Phase 2

**Phase 2** = this project (`repair-bot-worker`, the A'aisyah WhatsApp assistant for iFix Express), the second project in iFix Express's digital transformation programme. Phase 1 (the business website) and Phase 3 (not yet started) are separate projects and out of scope here.

## How this file works

- **This file is the source of truth.** A stakeholder-facing copy (Notion or similar) may exist as a periodic manual export, clearly marked "last synced: [date], source: this file," and is never edited independently. If the two ever disagree, this file wins by definition.
- **Mined from evidence, not memory.** Every row is backed by a real commit, a real file/function, and a real test name — checked directly against the repository, not reconstructed from conversation history.
- **One row per requirement, not per test assertion.** Where a test file has a `describe()` block that fully covers a requirement, that block is cited; the test itself holds the detailed cases.
- **Implementation is cited as `file — function/section`, never `file:line`.** Line numbers shift on every unrelated edit and silently go stale with no signal; a function or section name stays locatable via search regardless of what else in the file changes.
- **File citations are clickable, relative links** (e.g. `[src/index.js](../src/index.js)`) — they open the right file directly in GitHub, VS Code, or any markdown viewer that resolves relative links. The function/section name stays as plain text next to the link rather than part of the URL: there is no stable way to link straight to a specific function without embedding a line number, which is exactly the fragility the rule above avoids. One click gets you to the right file; searching that file for the named function is fast and never silently breaks.
- **Superseded rows are kept, not deleted.** Several requirements in this project were reversed, not just extended, after being confirmed wrong. The old row stays with `Status: Superseded` and a note pointing at what replaced it — that history has real value.
- **Update discipline:** a change to behavior rides in the same commit/PR as the row that describes it, so this file cannot silently drift out of sync with the code.

### Status vocabulary (fixed — do not invent new values)

| Status | Meaning |
|---|---|
| `Live` | Implemented, deployed, currently in effect |
| `Deferred` | Explicitly raised and postponed by deliberate decision, not forgotten |
| `Known Gap` | Identified as missing or incomplete; not yet scheduled |
| `Superseded` | Was implemented, later deliberately replaced — kept for history |
| `Planned` | Scaffolded (code exists) but intentionally not activated |

### Requirement ID prefixes

`CORE` bot/runtime scaffolding · `ONBOARD` Embedded Signup & Coexistence setup · `KILL` kill switches · `PRICE` pricing lookup & brand matching · `TIER` part-quality tier data · `BRANCH` branch data & routing · `INTAKE` repair booking capture · `ESCALATE` staff handoff & mute logic · `STAFFCMD` manager chat commands · `MEDIA` image/video/audio/voice handling · `IDENTITY` phone/BSUID/allowlist/delist matching · `PROMPT` persona, tone, and knowledge-base rules · `DATA` D1 schema & retention · `COST` API spend management · `INFRA` testing, CI, and documentation tooling

---

## CORE — bot runtime and provider abstraction

| ID | Requirement | Source | Implementation | Verification | Status | Notes |
|---|---|---|---|---|---|---|
| CORE-001 | Worker receives WhatsApp Cloud API webhooks and routes by field/message type | `d0e7597`, `990739f` (2026-05-06) | [`src/index.js`](../src/index.js) — `handlePostMessage()` | [`test/webhook.spec.js`](../test/webhook.spec.js) — all describe blocks (integration-level) | Live | Foundational routing; every other requirement below sits on top of this |
| CORE-002 | LLM provider is swappable (Gemini or Claude) via one env var, no code change to switch | `172dcda` (2026-08-05), `e08c29c`, `9c211c3` | [`src/llm.js`](../src/llm.js) — `generateReply()` | [`test/llm.spec.js`](../test/llm.spec.js) — both `describe` blocks | Live | Currently defaults to Claude (`9c211c3`); Gemini path kept live and tested, not just vestigial |
| CORE-003 | Multi-part replies sent with human-paced delays instead of one instant block | `b9bc915` (2026-05-16), `5b03f5d` | [`src/bot.js`](../src/bot.js) — `sendInParts()` | Manual/prompt-only — no dedicated unit test for pacing timings | Live | Delay budget trimmed later (`3b213b2`) to fit inside Cloudflare's 30s `waitUntil()` ceiling — see COST section |
| CORE-004 | Replies read as natural conversation, not verbatim canned/hardcoded text | `b2b0605` (2026-06-25), `8a0c49f` | [`src/prompt.js`](../src/prompt.js) — `STATIC_SYSTEM_PROMPT` (tone rules) | Manual/prompt-only | Live | Ongoing tuning target rather than a single fixed requirement — see PROMPT section for the specific rules that followed |

## ONBOARD — Embedded Signup and Coexistence setup

| ID | Requirement | Source | Implementation | Verification | Status | Notes |
|---|---|---|---|---|---|---|
| ONBOARD-001 | `/onboard` serves the Embedded Signup landing page | `395e51f` (2026-07-20), `b2ba662` | [`src/index.js`](../src/index.js) — `onboardPage()` | Manual/prompt-only | Live | — |
| ONBOARD-002 | `account_update` webhook (PARTNER_ADDED) is the real onboarding-completion signal, not the originally-planned OAuth redirect | `cae6fe7`, `1d8b5d4` (2026-08-03/04) | [`src/index.js`](../src/index.js) — `account_update` branch in `handlePostMessage()` | [`test/webhook.spec.js`](../test/webhook.spec.js) — `describe("onboarding and history sync")` | Live | The `/oauth/callback` code path this superseded is `Superseded` — see ONBOARD-002S |
| ONBOARD-002S | OAuth `code`+`redirect_uri` exchange for Embedded Signup completion | `395e51f` | [`src/index.js`](../src/index.js) — `handleOAuthCallback()` | None (dead code) | Superseded | Confirmed never fires under Hosted Embedded Signup's real delivery mechanism; route commented out, function body (~224 lines) left in place rather than deleted. Superseded by ONBOARD-002. |
| ONBOARD-003 | WABA id / phone-number-id correctly extracted from the real payload shape (not the initially assumed field) | `110ddfb` (2026-08-04) | [`src/index.js`](../src/index.js) — `account_update` branch | [`test/webhook.spec.js`](../test/webhook.spec.js) — `describe("onboarding and history sync")` | Live | — |
| ONBOARD-004 | Staff self-chat commands during Coexistence onboarding don't get misrouted as customer messages | `bb5f9e8` (2026-08-04) | [`src/index.js`](../src/index.js) — `smb_message_echoes` self-chat branch | [`test/webhook.spec.js`](../test/webhook.spec.js) — `describe("staff echoes")` | Live | — |
| ONBOARD-005 | One-time WhatsApp Business App chat history backfill after onboarding | `bb5f9e8`, later BSUID-aware fix `092c028` | [`src/index.js`](../src/index.js) — `history` field branch | [`test/webhook.spec.js`](../test/webhook.spec.js) — `describe("onboarding and history sync")` | Live | Role attribution bug for username (BSUID) customers fixed in `092c028` — see IDENTITY-004 |

## KILL — kill switches and access gating

| ID | Requirement | Source | Implementation | Verification | Status | Notes |
|---|---|---|---|---|---|---|
| KILL-001 | `BOT_ENABLED` env var — developer-level emergency stop, requires redeploy | `2f1082c`, `a4e3443` (2026-08-03) | [`src/index.js`](../src/index.js) — `handlePostMessage()` kill-switch block | [`test/webhook.spec.js`](../test/webhook.spec.js) — `describe("who gets served")` | Live | Scoping bug (too broad, silenced `/onboard`) fixed same day in `a4e3443` |
| KILL-002 | `bot_settings.bot_enabled` — manager-level instant global toggle via `!pauseall`/`!resumeall`, no redeploy | `654453e` (2026-08-05) | [`src/db.js`](../src/db.js) — `getSetting`/`setSetting`; [`src/bot.js`](../src/bot.js) — `handleStaffCommand()` | [`test/webhook.spec.js`](../test/webhook.spec.js) — `describe("who gets served")`, [`test/bot.spec.js`](../test/bot.spec.js) staff-command describes | Live | — |
| KILL-003 | `TEST_ALLOWLIST` — restrict replies to specific numbers during testing, `*` to open to all | `1e29e7f`, `c245b95` (2026-08-05/07) | [`src/index.js`](../src/index.js) — allowlist gate | [`test/webhook.spec.js`](../test/webhook.spec.js) — `describe("who gets served")` | Live | Moved from a committed [`wrangler.jsonc`](../wrangler.jsonc) var to a Cloudflare secret in `d73205b` (numbers are real customer data, shouldn't be in git) |
| KILL-004 | `DELISTED_NUMBERS` — numbers the bot must never process at all, absolute, staff-bypass excluded | `6681333`–`c262607` (2026-08-18) | [`src/index.js`](../src/index.js) — delisted gate; [`src/phone.js`](../src/phone.js) — `phoneList()`/`normalizeId()` | [`test/webhook.spec.js`](../test/webhook.spec.js) — `describe("who gets served")` | Live | Real production miss: a `+`-formatted number in the dashboard silently defeated plain-substring matching — see IDENTITY-002 |
| KILL-005 | Staff (`STAFF_WA_NUMBER`) bypass every kill switch and the allowlist, so `!resumeall` is always reachable | `654453e` | [`src/index.js`](../src/index.js) — staff bypass checks (both kill-switch layers, allowlist) | [`test/webhook.spec.js`](../test/webhook.spec.js) — `describe("who gets served")` | Live | — |

## PRICE — live pricing lookup and brand matching

| ID | Requirement | Source | Implementation | Verification | Status | Notes |
|---|---|---|---|---|---|---|
| PRICE-001 | Pricing comes from a live Google Sheet, not a static price list baked into the prompt | `2e8c10b`, `0f53491` (2026-08-06), `787063a` | [`src/googleSheets.js`](../src/googleSheets.js) — `getSheetTabs()`, `getPricingRows()` | **None** — no dedicated test file exists for `googleSheets.js` | Live | Genuine gap: this module is only ever exercised through mocks in other tests, never directly |
| PRICE-002 | Brand tab resolved by fuzzy-matching the customer's actual wording against real (not hardcoded) tab titles | `24ed190` (2026-08-07), `09f3124` | [`src/pricing.js`](../src/pricing.js) — `matchBrandTab()` | [`test/pricing.spec.js`](../test/pricing.spec.js) — `describe("matchBrandTab — direct tab-name matches")` | Live | — |
| PRICE-003 | Combined tabs ("Infinix / Tecno") match on either brand name alone | `24ed190` | [`src/pricing.js`](../src/pricing.js) — `tabMatchTokens()` | [`test/pricing.spec.js`](../test/pricing.spec.js) — combined-tab case | Live | — |
| PRICE-004 | "Apple" and "1+" recognized as iPhone / OnePlus even though those exact words never appear in the sheet | `24ed190`, later hardened `8141044` | [`src/pricing.js`](../src/pricing.js) — `BRAND_ALIASES`, `SYMBOL_ALIASES` | [`test/pricing.spec.js`](../test/pricing.spec.js) — Apple-alias regression case | Live | — |
| PRICE-005 | Huawei-family product lines (Honor, Nova, Mate) resolved to the Huawei tab even though the customer never says "Huawei" | `8141044` (2026-09-09) | [`src/pricing.js`](../src/pricing.js) — `BRAND_ALIASES` (`HONOR`/`NOVA`/`MATE`), word-boundary matching | [`test/pricing.spec.js`](../test/pricing.spec.js) — `describe("matchBrandTab — Huawei-family product lines")`, `describe("...whole-word aliasing, not bare substring")` | Live | Naive substring matching would have false-positived on "estimate" (MATE) and "innovation" (NOVA) — caught before shipping, fixed by requiring word boundaries |
| PRICE-006 | "ip" + a model number ("ip11", "ip 13 pro") recognized as iPhone shorthand | `a5352a6` (2026-09-12) | [`src/pricing.js`](../src/pricing.js) — `PATTERN_ALIASES` | [`test/pricing.spec.js`](../test/pricing.spec.js) — `describe("matchBrandTab — 'ip' + model number resolves to iPhone")` | Live | Deliberately requires an adjacent digit — bare "ip" alone is too generic (2 letters) to alias safely on its own |
| PRICE-007 | A brand mentioned earlier in the conversation still applies pricing context to a later brand-less follow-up message | `a0648f6` (2026-08-12) | [`src/pricing.js`](../src/pricing.js) — `matchBrandFromHistory()` | [`test/pricing.spec.js`](../test/pricing.spec.js) — `describe("matchBrandFromHistory")` | Live | An earlier word-count heuristic gate (`looksLikeFollowUp`) was built, then deliberately removed entirely — rule-based gating judged unreliable and likely to cause unnecessary escalations. See PRICE-007S. |
| PRICE-007S | Follow-up brand carry-over gated by a word-count heuristic before firing | `a0648f6` (initial) | (removed) | — | Superseded | Superseded by PRICE-007's unconditional version, same day, by explicit decision |
| PRICE-008 | Device-agnostic enquiries (cables, chargers, protectors with no brand) still get the Services & Accessories price list | `ed6207b` (2026-08-07) | [`src/pricing.js`](../src/pricing.js) — `looksLikeDeviceAgnosticEnquiry()`, `findFallbackTab()` | **None** — no direct unit test for `looksLikeDeviceAgnosticEnquiry` | Known Gap | A broader keyword set (generic repair words) was tried and deliberately narrowed — see PRICE-008S |
| PRICE-008S | Fallback tab also triggered by generic repair words (harga/repair/rosak) with no brand | `ed6207b` (initial) | (removed) | — | Superseded | Caused irrelevant accessories data to be injected for brand-less device-repair questions; replaced by the LLM asking for missing brand/model/damage details instead (see PROMPT-004) |
| PRICE-009 | RM0 in the price sheet means "not yet priced," never quoted to the customer as free or final | `002c8a1` (2026-08-10) | [`src/pricing.js`](../src/pricing.js) — `formatPricingContext()` | **None** — no direct unit test for `formatPricingContext` | Known Gap | — |

## TIER — part-quality tier data (business facts, not code logic)

| ID | Requirement | Source | Implementation | Verification | Status | Notes |
|---|---|---|---|---|---|---|
| TIER-001 | iPhone 12+ battery tiers: GAP / UAP / OWBH / OEM / AAA, in that price order | `002c8a1`, corrected `cd3ac22` | [`src/prompt.js`](../src/prompt.js) — `### Part quality tiers` | Manual/prompt-only | Live | Corrected twice from an initially-guessed simpler hierarchy after direct confirmation from a real business source |
| TIER-002 | iPhone 11 battery tiers include an additional UAP tier below GAP, not offered on other models | `cd3ac22` | [`src/prompt.js`](../src/prompt.js) — `### Part quality tiers` | Manual/prompt-only | Live | — |
| TIER-003 | iPhone screen tiers: GAP → 1:1 COPY ORI → OLED → INCELL AA (four tiers) | `cd3ac22` (2026-09-09) | [`src/prompt.js`](../src/prompt.js) — `### Part quality tiers` | Manual/prompt-only | Live | Supersedes an earlier five-tier structure — see TIER-003S |
| TIER-003S | iPhone screen tiers: Genuine Apple/GAP → Original OEM/ORI OEM → OLED → AA → AAA (five tiers), with "1:1 copy ori" treated as informal chatter, not a real tier | `002c8a1` (initial) | (replaced text) | — | Superseded | Directly contradicted by later business confirmation: 1:1 COPY ORI is a real, distinct second-highest tier, and the real structure has four tiers, not five |
| TIER-004 | Tier vocabulary (GAP/UAP/OWBH/OEM/AAA, GAP/1:1 COPY ORI/OLED/INCELL AA) is iPhone-specific; other brands use whatever the live price list itself says | `cd3ac22` | [`src/prompt.js`](../src/prompt.js) — `### Part quality tiers` (opening scoping note) | Manual/prompt-only | Live | — |
| TIER-005 | Charging port repair has fixed pricing (not live-lookup), Android-only, Samsung S/Note-series priced higher | `24f5317` (2026-08-10), refined `8773e3c`, `bfbdcdf` | [`src/prompt.js`](../src/prompt.js) — `### Charging port repair` | Manual/prompt-only | Live | — |

## BRANCH — branch data and routing

| ID | Requirement | Source | Implementation | Verification | Status | Notes |
|---|---|---|---|---|---|---|
| BRANCH-001 | 6 branches (5 Kedah, 1 Penang) with address/maps data, narrow to nearest rather than listing all | 2026-08-10 finetuning, `dbc4a43` (Kuala Nerang added), `cd3ac22` (maps link filled in) | [`src/prompt.js`](../src/prompt.js) — `## iFIX EXPRESS BRANCHES` | Manual/prompt-only | Live | — |
| BRANCH-002 | Alor Setar (the only branch inside a plaza) gets a directions video sent, no other branch does | `cc4f367` (2026-08-24) | [`src/prompt.js`](../src/prompt.js) — `### Alor Setar — always send the directions video` | Manual/prompt-only | Live | — |
| BRANCH-003 | A confirmed booking is routed to the branch's own WhatsApp number, in addition to the staff alert | `7179627`–`1b2a047` (2026-08-25 to 08-27) | [`src/branches.js`](../src/branches.js) — `resolveBranch()`, `parseBranchNumbers()`; [`src/bot.js`](../src/bot.js) — `notifyBranch()` | [`test/branches.spec.js`](../test/branches.spec.js) — `describe("booking is forwarded to the branch")` | Live | — |
| BRANCH-004 | Outside WhatsApp's 24-hour customer-service window, branch notification falls back to an approved message template instead of silently failing | `1b2a047` | [`src/bot.js`](../src/bot.js) — `notifyBranch()`; [`src/whatsapp.js`](../src/whatsapp.js) — `sendTemplateMessage()` | [`test/branches.spec.js`](../test/branches.spec.js) — `describe("the 24-hour window")` | Live | Template parameter count/placement went through two revisions to satisfy Meta's variable-density and no-edge-variable rules — final: 3 params (details / time / contact) |
| BRANCH-005 | `BRANCH_NUMBERS` config tolerant of comma, newline, or semicolon separators and `=`/`:` | `1b2a047`, hardened later | [`src/branches.js`](../src/branches.js) — `parseBranchNumbers()` | [`test/branches.spec.js`](../test/branches.spec.js) — `describe("REGRESSION: config format tolerance")` | Live | A correctly-set secret still failed to route a real booking in production because the parser only split on commas; root-caused and fixed |
| BRANCH-006 | A branch keeping its WhatsApp window open (messaging head office) is never mistaken for a customer | (raised in review) | [`src/index.js`](../src/index.js) — `delisted` set folds in `BRANCH_NUMBERS` | [`test/branches.spec.js`](../test/branches.spec.js) — `describe("branch numbers are not treated as customers")` | Live | — |

## INTAKE — repair booking capture

| ID | Requirement | Source | Implementation | Verification | Status | Notes |
|---|---|---|---|---|---|---|
| INTAKE-001 | A'aisyah collects booking details conversationally (device, fault, branch, name, contact, time) | `dab7ae6` (2026-08-08) | [`src/prompt.js`](../src/prompt.js) — `## COLLECTING REPAIR INTAKE` | Manual/prompt-only | Live | — |
| INTAKE-002 | A completed booking is recorded as a structured `intakes` row and alerts staff, not just left as chat text | `f73c98d` (2026-08-17) | [`src/bot.js`](../src/bot.js) — `parseIntakeBlock()`, `formatIntakeAlert()`; [`src/db.js`](../src/db.js) — `saveIntake()` | [`test/bot.spec.js`](../test/bot.spec.js) — `describe("parseIntakeBlock")`, `describe("intake capture")` | Live | The `[INTAKE]` marker block is stripped before the customer or D1 history ever sees it, including malformed/unterminated blocks |
| INTAKE-003 | A DB save failure never silently swallows the staff alert | `54f59c7` (2026-08-18) | [`src/bot.js`](../src/bot.js) — booking-handling block (save and alert now independent) | [`test/bot.spec.js`](../test/bot.spec.js) — `describe("intake capture")` REGRESSION case | Live | Production incident: schema mismatch on `intakes.branch` aborted before the alert ran; customer was told "booked," nobody at the shop heard about it |
| INTAKE-004 | The manager's own name is never mistaken for the customer's name during intake | `abd0584` (2026-08-28) | [`src/prompt.js`](../src/prompt.js) — `## WHO YOU ARE`, intake name-collection note | Manual/prompt-only | Live | — |

## ESCALATE — staff handoff and mute logic

| ID | Requirement | Source | Implementation | Verification | Status | Notes |
|---|---|---|---|---|---|---|
| ESCALATE-001 | Bot pauses and alerts staff when it can't answer, using a detectable trigger phrase in its own reply | 2026-08-08 handoff work | [`src/bot.js`](../src/bot.js) — `shouldEscalate()` | [`test/bot.spec.js`](../test/bot.spec.js) — `describe("escalation")` | Live | Trigger phrase changed from an original "connecting you" framing to "biar saya check dan update balik," since the bot runs on the manager's own number, not a separate line — no real "connecting" happens |
| ESCALATE-002 | An AI-triggered escalation (unknown price, ambiguous question) auto-resolves after a timeout instead of staying muted forever | `f5ac322` (2026-08-08), fixed `bed3c15` | [`src/db.js`](../src/db.js) — `refreshAutoMute()`, `isEscalated()` | [`test/bot.spec.js`](../test/bot.spec.js) — `describe("escalation")`; indirectly via [`test/webhook.spec.js`](../test/webhook.spec.js) staff-echo tests | Live | A stale `mute_type='manual'` bug let one customer stay permanently muted after being resumed — root-caused via a live D1 query, fixed by requiring the mute be currently active before treating it as manual |
| ESCALATE-003 | A manual `!pause` stays off indefinitely — only `!resume` clears it, never a timeout | `654453e`, redesigned `f5ac322` | [`src/db.js`](../src/db.js) — `setManualMute()` | [`test/bot.spec.js`](../test/bot.spec.js) — `describe("staff commands — BSUID customers")` | Live | — |
| ESCALATE-004 | The escalation mute + staff alert complete even if the human-paced multi-part reply after it gets cut off by Cloudflare's `waitUntil()` ceiling | `3b213b2` (2026-08-12) | [`src/bot.js`](../src/bot.js) — mute+alert moved before `sendInParts()`, `bypassEscalationGuard` flag | Manual/prompt-only (timing-dependent, not asserted in tests) | Live | — |

## STAFFCMD — manager chat commands

| ID | Requirement | Source | Implementation | Verification | Status | Notes |
|---|---|---|---|---|---|---|
| STAFFCMD-001 | `!pause`/`!resume`/`!pauseall`/`!resumeall`/`!status`/`!muted`/`!help` command set | `dab7ae6`, renamed from `!take`/`!done` | [`src/bot.js`](../src/bot.js) — `handleStaffCommand()` | [`test/bot.spec.js`](../test/bot.spec.js) — staff-command describes; [`test/webhook.spec.js`](../test/webhook.spec.js) — `describe("who gets served")` | Live | — |
| STAFFCMD-002 | Missing a target number on `!pause`/`!resume` gives a usage message instead of failing silently | `aea4c86` (2026-08-08) | [`src/bot.js`](../src/bot.js) — `handleStaffCommand()` | Covered implicitly by staff-command tests | Live | — |
| STAFFCMD-003 | A command copy-pasted straight out of a bolded alert (`*!pause X*`) still parses correctly | (raised in review, 2026-09) | [`src/bot.js`](../src/bot.js) — leading/trailing `*` stripped before parsing | [`test/bot.spec.js`](../test/bot.spec.js) — `describe("staff commands — pasted bold command still parses")` | Live | More likely to matter now that BSUID targets are too long to retype reliably |
| STAFFCMD-004 | Staff-facing identifiers never render as `+MY.<bsuid>` or `+undefined` | (raised in review, 2026-09) | [`src/phone.js`](../src/phone.js) — `displayId()`, used throughout `bot.js` alerts | [`test/bot.spec.js`](../test/bot.spec.js) — `describe("staff commands — BSUID customers")` | Live | — |

## MEDIA — image, video, document, and voice-note handling

| ID | Requirement | Source | Implementation | Verification | Status | Notes |
|---|---|---|---|---|---|---|
| MEDIA-001 | Media with a caption is answered via the caption text as if it were a normal message | `85df1bc` (2026-06-25) | [`src/index.js`](../src/index.js) — caption branch | [`test/webhook.spec.js`](../test/webhook.spec.js) — `describe("media")` | Live | — |
| MEDIA-002 | Media without a caption gets no auto-reply to the customer — the bot stays silent rather than ending the conversation | `e3adf08` (2026-08-21) | [`src/index.js`](../src/index.js) — no-caption media branch | [`test/webhook.spec.js`](../test/webhook.spec.js) — `describe("media")` | Live | A'aisyah routinely *asks* for a photo before diagnosing; auto-replying "thanks, team will get back to you" ended the conversation at exactly the moment the customer complied |
| MEDIA-003 | An edited customer message is recovered and handled normally when Meta delivers the new text (Coexistence-only) | `6015c7f`, `d9d5868` (2026-08-11) | [`src/index.js`](../src/index.js) — `edit`/`unsupported+edit` branch | Manual/prompt-only | Live | Contentless edits (non-Coexistence numbers) are silently ignored by explicit decision — bot continues flowing rather than attempting a fallback |
| MEDIA-004 | A burst of several media items in a row (3-5 images at once) alerts staff once, not once per item | `03ba048` (2026-09-10) | [`src/db.js`](../src/db.js) — `isContinuingUnalertedMediaRun()`; [`src/index.js`](../src/index.js) — media branches | [`test/webhook.spec.js`](../test/webhook.spec.js) — `describe("media")`, burst/mixed-type/interleaving cases | Live | Every item is still recorded to D1; any interleaving message (customer text, AI reply, staff reply) resets the run so the next item alerts again |

## IDENTITY — phone numbers, BSUIDs, and matching

| ID | Requirement | Source | Implementation | Verification | Status | Notes |
|---|---|---|---|---|---|---|
| IDENTITY-001 | Phone numbers matched regardless of formatting (`+`, spaces, dashes) across allowlist/delist/staff checks | `c262607` (2026-08-18) | [`src/phone.js`](../src/phone.js) — `digitsOnly()`, `samePhone()` | [`test/phone.spec.js`](../test/phone.spec.js) — all describes | Live | A `+`-formatted delisted number kept receiving replies in production before this |
| IDENTITY-002 | Same normalization applied consistently to every number comparison site (staff, allowlist, delist), not just one | `c262607` | [`src/index.js`](../src/index.js), [`src/bot.js`](../src/bot.js) — all `samePhone`/`normalizeId` call sites | [`test/webhook.spec.js`](../test/webhook.spec.js), [`test/bot.spec.js`](../test/bot.spec.js) | Live | — |
| IDENTITY-003 | WhatsApp username customers (BSUID, no phone number in the payload) are served, not silently dropped | `0e2045a` (2026-08-24) | [`src/phone.js`](../src/phone.js) — `isBsuid()`, `normalizeId()`, `displayId()`; [`src/index.js`](../src/index.js) — sender resolution fallback chain | [`test/phone.spec.js`](../test/phone.spec.js); [`test/webhook.spec.js`](../test/webhook.spec.js) — `describe("sender resolution")` | Live | `digitsOnly()` alone would mangle a BSUID into a fake phone number — `normalizeId` branches on `isBsuid` specifically to prevent this |
| IDENTITY-004 | History-sync role attribution doesn't mislabel a BSUID customer's own messages as staff | `092c028` (2026-08-27) | [`src/index.js`](../src/index.js) — history-sync role attribution | [`test/webhook.spec.js`](../test/webhook.spec.js) — `describe("onboarding and history sync")` | Live | `msg.from === customerId` is always false for a BSUID customer (no `from` field), which previously mislabeled their entire thread as staff |
| IDENTITY-005 | A message with genuinely no sender identifier is ignored cleanly, not thrown on | (raised in review, 2026-08) | [`src/index.js`](../src/index.js) — sender-resolution guard | [`test/webhook.spec.js`](../test/webhook.spec.js) — `describe("sender resolution")` | Live | Root cause of a real `D1_TYPE_ERROR` in production; `saveMessage` also now names which field was missing instead of a bare D1 error |
| IDENTITY-006 | Self-send diagnostic: warn when `STAFF_WA_NUMBER` equals the Coexistence-connected number (alerts would silently fail to deliver) | `e506d10` (2026-08-10) | [`src/index.js`](../src/index.js) — `smb_message_echoes` self-chat diagnostic | Manual/prompt-only | Live | Platform limitation, not something code can route around — diagnostic only |

## PROMPT — persona, tone, and knowledge-base rules

| ID | Requirement | Source | Implementation | Verification | Status | Notes |
|---|---|---|---|---|---|---|
| PROMPT-001 | Assistant persona named A'aisyah | `f1b923f`, `bbb419a` (2026-08-03/06) | [`src/prompt.js`](../src/prompt.js) — throughout | Manual/prompt-only | Live | Supersedes the original "Alia" name |
| PROMPT-001S | Assistant persona named Alia | (initial build) | (renamed) | — | Superseded | — |
| PROMPT-002 | No em dash in any reply — comma or full stop instead | `57a13f9` (2026-08-11) | [`src/prompt.js`](../src/prompt.js) — `## TONE` | Manual/prompt-only | Live | — |
| PROMPT-003 | Respectful pronouns only (Cik/Puan/Tuan/Kak/etc.), never "awak" | `d2e1a8c` (2026-08-12), `fe62ed2` | [`src/prompt.js`](../src/prompt.js) — `## TONE` | Manual/prompt-only | Live | Caught in real testing: "awak" used against explicit instruction; default form corrected again in `fe62ed2` |
| PROMPT-004 | Shorthand/abbreviated brand names prompt a request to spell out in full, rather than silently guessed | `45b5b4d` (2026-08-12) | [`src/prompt.js`](../src/prompt.js) — `## SHORTHAND OR ABBREVIATED BRAND NAMES` | Manual/prompt-only | Live | Narrowed for the "ip"+number case specifically once PRICE-006 made that case actually resolvable — see PROMPT-004 note in that row |
| PROMPT-005 | Live business-hours awareness — bot never claims to be open when it isn't | `60c40cd` (2026-08-12) | [`src/businessHours.js`](../src/businessHours.js); [`src/prompt.js`](../src/prompt.js) — dynamic context injection | [`test/businessHours.spec.js`](../test/businessHours.spec.js) — all describes | Live | — |
| PROMPT-006 | Off-topic / non-repair messages (the number is the manager's personal line too) are acknowledged and escalated gracefully, never told "wrong number" | `5a22c55` (2026-08-28) | [`src/prompt.js`](../src/prompt.js) — `## ESCALATION`, `## WHAT YOU MUST NOT DO` | Manual/prompt-only | Live | Root line was a rigid "gently redirect back to how you can help" instruction, replaced |
| PROMPT-007 | Water damage treated as urgent/same-visit, not a multi-day repair by default | `afd20c0` (2026-08-28) | [`src/prompt.js`](../src/prompt.js) — `### Water damage`, `## TURNAROUND TIMES` | Manual/prompt-only | Live | Corrected a pre-existing flat "1-3 working days" estimate that had been silently wrong |
| PROMPT-008 | Media (photo/video/voice note) never pauses the conversation or triggers escalation on its own | (part of MEDIA-002 work) | [`src/prompt.js`](../src/prompt.js) — `## WHEN THE CUSTOMER SENDS A PHOTO...` | Manual/prompt-only | Live | — |
| PROMPT-009 | Staff replies mid-conversation (`[Staff replied]` marker) are read as committed fact, never contradicted or re-offered | `d61c985` (2026-08-13) | [`src/prompt.js`](../src/prompt.js) — `## STAFF REPLIES IN THIS CONVERSATION`; [`src/llm.js`](../src/llm.js) — `toApiText()` marker | [`test/llm.spec.js`](../test/llm.spec.js) — marker-placement cases | Live | — |

## DATA — schema and retention

| ID | Requirement | Source | Implementation | Verification | Status | Notes |
|---|---|---|---|---|---|---|
| DATA-001 | Conversation roles distinguish customer / ai-assistant / staff, not a flattened user/assistant pair | `d61c985` (2026-08-13) | [`src/db.js`](../src/db.js) — `conversations` schema; [`src/llm.js`](../src/llm.js) — `toApiRole()` | [`test/db.spec.js`](../test/db.spec.js) — `describe("conversations.role vocabulary")` | Live | Required a full-table-rebuild migration since SQLite has no `ALTER` for `CHECK` constraints |
| DATA-002 | A one-time AI-disclosure (transparency) notice sent to new/returning customers, linking the privacy policy | `490a712` (2026-08-17), fixed `267fcd7`, synced `2606434` | [`src/bot.js`](../src/bot.js) — `maybeSendAiNotice()`; [`src/db.js`](../src/db.js) — `getLastEngagementAt()` | [`test/bot.spec.js`](../test/bot.spec.js) — `describe("AI disclosure notice")` | Live | Originally keyed off "any prior message," which a customer's own opening burst could suppress; fixed to key off iFix Express's own last reply instead |
| DATA-003 | Conversation logs older than 12 months are purged, backing the privacy policy's retention claim | `f73c98d` (2026-08-17) | [`src/db.js`](../src/db.js) — `purgeOldConversations()`; [`src/index.js`](../src/index.js) — `scheduled()` | [`test/db.spec.js`](../test/db.spec.js) — `describe("purgeOldConversations (12-month retention)")`; [`test/webhook.spec.js`](../test/webhook.spec.js) — `describe("cron dispatch")` | Live | Cron slot is shared with a reserved, not-yet-built daily-summary job — dispatched by `controller.cron`, see INFRA-004 |
| DATA-004 | History ordering stays correct even when multiple messages share the same second-granularity timestamp | (raised in review) | [`src/db.js`](../src/db.js) — `getRecentMessages()` (id as tiebreaker) | [`test/db.spec.js`](../test/db.spec.js) — `describe("getRecentMessages ordering")` | Live | — |

## COST — API spend management

| ID | Requirement | Source | Implementation | Verification | Status | Notes |
|---|---|---|---|---|---|---|
| COST-001 | The ~44K-character static system prompt is cached (Claude prompt caching) instead of reprocessed at full price on every message | `70c4fbc` (2026-09-01) | [`src/prompt.js`](../src/prompt.js) — `STATIC_SYSTEM_PROMPT`; [`src/llm.js`](../src/llm.js) — `callClaude()` cache_control | [`test/llm.spec.js`](../test/llm.spec.js) — `describe("callClaude — prompt caching request shape")` | Live | Confirmed effective against real Console usage data — the ~16,315-token static block shows as a cache read on repeat requests within the TTL window |
| COST-002 | The per-customer history cache breakpoint is placed explicitly at the end of history, never on Anthropic's top-level "automatic caching" field, so no cache-write premium is paid on the always-unique per-request tail (live time/pricing/newest message) | 2026-09-23 (this commit) | [`src/llm.js`](../src/llm.js) — `callClaude()`, explicit `cache_control` on the last history message | [`test/llm.spec.js`](../test/llm.spec.js) — `describe("callClaude — prompt caching request shape")`, esp. "no top-level cache_control" and "breakpoint is placed explicitly on the LAST HISTORY message" cases | Live | Confirmed against Anthropic's own docs: top-level `cache_control` auto-places its breakpoint on the last block of the request, which here was always the dynamicContext+newMessage tail — named in their docs as the standard mistake, since that content never repeats and the write can never be read back |
| COST-003 | Reduce overall `sendTextMessage` call volume ahead of Meta's Oct 1, 2026 per-message service-message billing | Meta email, 2026-09-10 | [`src/db.js`](../src/db.js)/[`src/index.js`](../src/index.js) — `isContinuingUnalertedMediaRun()` (MEDIA-004) is the only piece done so far | — | Known Gap | Payment method added in Meta Billing Hub (immediate cutoff risk handled); the larger lever — A'aisyah's own reply fragmentation into 3-5 messages per exchange — is untouched |
| COST-004 | BSUID regeneration (customer changes phone number) doesn't silently orphan conversation history/mute state | Meta docs review, 2026-08 | — (not built) | — | Known Gap | Meta fires a system-messages webhook on this event; nothing here listens for it |

## INFRA — testing, CI, and documentation

| ID | Requirement | Source | Implementation | Verification | Status | Notes |
|---|---|---|---|---|---|---|
| INFRA-001 | A permanent, real test suite exists and is safe to run freely (local D1, no remote calls) | `c9de29f` (2026-08-25), grown throughout | `test/*.spec.js` (8 files, 178 tests as of `a5352a6`) | Self-referential — the suite is its own verification | Live | Replaced the original create-cloudflare "Hello World" scaffold test, which had gone permanently red |
| INFRA-002 | Tests run automatically before any push, since a push deploys to production | `886eb0c` (2026-08-25) | [`.githooks/pre-push`](../.githooks/pre-push) | Manually verified by injecting a failing regression and confirming the push was blocked | Live | — |
| INFRA-003 | Schema drift (code expects a column production doesn't have) is caught before it causes a production failure | `01bd2f9` (2026-08-25) | [`scripts/check-schema-drift.mjs`](../scripts/check-schema-drift.mjs) | Manually verified by injecting a fake column and confirming detection | Live | Built in direct response to the `intakes.branch` production incident (INTAKE-003) |
| INFRA-004 | A daily enquiry-summary cron job (customer counts, notable enquiries) to staff | (raised in review, not yet requested as a build) | [`src/index.js`](../src/index.js) — `scheduled()` has a stub case; [`src/db.js`](../src/db.js) — `getTodaysConversations()` (live), `getTodayConversationList()`/`getActiveEscalations()`/`getDashboardStats()` (Phase B, suspended) | None | Planned | Cron string deliberately not registered in [`wrangler.jsonc`](../wrangler.jsonc) yet — registering it before the case is filled in would wake the worker nightly to do nothing |
| INFRA-005 | `README.md` documents setup, secrets, architecture, and known gaps for anyone else picking up this repo | (written mid-project) | `README.md` | Self-referential | Live | Should be revisited for currency against this RTM's Known Gap / Deferred rows |

---

## Confirmed dead code (exported, zero callers — not the same as Superseded)

These are live, exported functions with no requirement currently pointing at them. Not a defect — flagged here so they're not mistaken for untracked work, and so a future cleanup pass has a starting list.

| Function | File | Why it's dead |
|---|---|---|
| `parseStructuredDeviceReply` | [`src/pricing.js`](../src/pricing.js) | Superseded when pricing lookup moved to letting the LLM search a whole matched brand tab itself |
| `handleOAuthCallback` | [`src/index.js`](../src/index.js) | See ONBOARD-002S — confirmed never fires, route commented out |
| `markAlertSent`, `markAlertFailed`, `getStuckEscalations` | [`src/db.js`](../src/db.js) | Inside the block-commented "SUSPENDED — Phase A" section |
| `getDashboardStats`, `getActiveEscalations`, `getTodayConversationList`, `getConversationThread` | [`src/db.js`](../src/db.js) | Inside the block-commented "SUSPENDED — Phase B" section — groundwork for INFRA-004 |
