# LPO Sales Engine — Application Framework

**Lone Peak Overland · Internal sales tooling · Draft v1 — July 20, 2026**

A three-module internal application for the sales team (Parker, Jackson), built on the systems already in place: **Pipedrive** (leads/deals, system of record), **Quo** (calls/SMS), **Klaviyo** (marketing email), **Shopify** (orders/payments). The native Quo↔Pipedrive integration (already connected) handles call initiation from Pipedrive and auto-logging of calls/texts back to deals — the app builds on top of that surface rather than replacing it.

---

## System overview

**Confirmed stack:** cloud side runs on **Vercel** (Next.js dashboard + serverless webhook endpoints + Vercel Cron for the 15-min hot-list sweep and nightly reconciliation) with **Supabase** as the Postgres database and secrets home. **This is a fully standalone system — its own Supabase project and Vercel app, zero shared tables, config, or code paths with Trailhead.** The ambassador program is irrelevant here; its logic doc served only as a reference for journey/refund patterns worth borrowing. This fits the design well — every cloud job is either webhook-triggered or cron-triggered, so serverless is fine; nothing needs a long-lived process except the rep-desktop companion, which is local anyway. Supabase Realtime can push queue updates (e.g., a deal going Hot) to the companion live.

```
┌─────────────────────────────  CLOUD WORKER (always on)  ─────────────────────────────┐
│                                                                                      │
│   Pipedrive API ◄──────────┐        ┌──► Quo API (calls, webhooks)                   │
│   Klaviyo API  ◄───────────┼────────┼──► Shopify API (orders, webhooks)              │
│                            │        │                                                │
│                     ┌──────┴────────┴──────┐                                         │
│                     │   Postgres (small)    │   ← events, rollups, commission ledger │
│                     └──────┬────────┬──────┘                                         │
│                            │        │                                                │
│         Module 2: Hot List engine   Module 3: Scoreboard & Commissions               │
│         (every 15 min)              (webhooks + nightly reconciliation)              │
└──────────────────────────────────────────────────────────────────────────────────────┘

┌───────────────────────  REP DESKTOP (Parker / Jackson machines)  ────────────────────┐
│   Module 1: Dialer companion app ("Queue Runner")                                    │
│   Pulls queue from cloud worker → fires Quo click-to-call → advances on call-end     │
│   webhook → VM drop (see tiers below). Runs beside the Quo desktop app.              │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

**Why this split:** call placement physically requires the Quo desktop app on the rep's machine, so the dialer is a lightweight local companion. Everything that watches, scores, counts, and pays runs in the cloud on schedules and webhooks, independent of whether anyone's laptop is open.

---

## Module 1 — Auto Dialer ("Queue Runner")

**Goal:** Pipedrive stages become call queues; reps burn through them with zero between-call friction; voicemail drop removes the 30–45 seconds of talking to machines that currently dominates dial sessions (in last week's transcripts, roughly half of outbound dials ended in voicemail).

### Queue building
- Each queue = a **Pipedrive filter on pipeline stage** (+ optional conditions: owner, last-activity age, label). Stage → queue mapping is config, editable without code.

**Proposed mapping from your live stages** (pipelines: 6 = Intake, 7 = Sales/Nurture, 8 = Order):

| Queue | Stages (id) | Cadence / priority |
|---|---|---|
| **PRIMARY: Intake / first touch** | Intake- Needs Qualification (44) | The main dialer workload — same-day on entry, then day 2 / day 4. Sessions default to this queue |
| **Deposit → paid-in-full push** | Deposit Placed p7 (50), Deposit Placed p8 (51) | Small list, daily until Confirmation Scheduled — highest $ per dial |
| **Hot follow-up** | Hot (56) + Module 2 flagged deals | Daily; auto-sorted to top of every session |
| **Warm follow-up** | Warm (55), Qualified p7 (48) | Every 3–4 days |
| **Cold / long nurture** | Cold (54), Qualified p6 (46) | Weekly |
| **Recovery** | Recovery (45) | Weekly batch, VM-drop-heavy |
| *Not queued* | Waiting on Timing (47) — callback activities only; Confirmation Scheduled (52), Confirmed (53) — out of dialer scope | |
- Queue ordering rules: Hot-list deals first (Module 2 feeds this), then oldest-untouched first. Configurable per queue.
- Hygiene guards: skip deals with no phone, phone-format normalization (E.164), do-not-call window (e.g., before 9am / after 7pm in the **lead's** timezone inferred from area code), max attempts per lead per week, auto-skip if an inbound call/text from the lead arrived since queue build.

### Call flow (per lead)
1. Companion app shows the next lead card: name, vehicle/build context from the deal, last activity, notes — 5-second read.
2. Rep hits **Dial** (or auto-advance mode dials after an N-second countdown). App triggers Quo click-to-call (same handoff the Pipedrive integration uses); Quo desktop places the call from the rep's number.
3. Call ends → Quo **call.completed webhook** hits the cloud worker → companion advances to the next card. No manual logging: the native integration writes the Activity to Pipedrive.
4. Quick-disposition hotkeys (optional but recommended): `1` connected, `2` VM dropped, `3` bad number, `4` callback scheduled — written to the deal as a note/field for cleaner reporting than duration heuristics alone.

### Voicemail drop — the honest engineering picture
You want fully automatic. Quo exposes no way to inject audio into a call or detect an answering machine, so full automation inside Quo means the companion app has to do the machine's job locally. Tiered plan:

| Tier | What happens | Reliability | Effort |
|---|---|---|---|
| **T1 — One-click drop** | Rep hears voicemail greeting, clicks **Drop VM** (or hotkey): app plays the pre-recorded file through a virtual audio device into the call, then auto-ends the call and advances. Rep can already be reading the next card. | High | Days. Ship first. |
| **T2 — Auto beep detection** | App monitors the call audio locally (loopback capture). Classifier detects voicemail greeting/beep → plays the drop file → hangs up → advances, no click. Rep only intervenes when a human answers. | Medium-high after tuning (greetings vary; carrier "the person you're trying to reach…" messages are actually easy; personal greetings are the noisy case) | 1–2 weeks on top of T1, iterate with real call audio |
| **T3 — True AMD** | Answering-machine detection server-side with multi-line dialing — requires a Twilio-class telephony layer; calls leave Quo numbers. | High | Months. Only if T2 disappoints and volume targets grow past what sequential dialing supports. |

**Recommendation:** build T1 and T2 together — T1 is the fallback UI for T2's misses, so T2 failing gracefully = T1. This gets you effectively automatic VM drop on Quo numbers without a second phone system. Revisit T3 only with data from Module 3.

Per-rep, per-queue voicemail recordings (Parker's voice for his queues), stored in the app; easy re-record.

---

## Module 2 — Engagement "Hot List"

**Goal:** surface deals showing buying signals **right now** and put them in front of the owner the same day, inside Pipedrive.

### Signal ingestion (cloud worker, every 15 min)
- **Klaviyo:** Events API — `Opened Email`, `Clicked Email` per profile. Klaviyo profile ↔ Pipedrive person matched on normalized email.
- **Pipedrive emails:** mail-thread open/click tracking flags via Pipedrive API (requires reps to send tracked email through Pipedrive — worth confirming their habit; if they send from Gmail directly, Pipedrive's email sync + tracking needs to be on).
- **Extensible signals (later):** Shopify — 3D-builder saved build / abandoned checkout / store session for a known customer email; Quo — inbound text or missed inbound call with no follow-up.

### Scoring & flagging (v1 rule, tunable)
- A deal goes **Hot** when, within a rolling window: **≥3 email opens in 7 days**, or **any click in 72h**, or **≥2 distinct signal types in 72h** (e.g., Klaviyo open + saved build). All thresholds config, not code.
- On flag: apply **"🔥 Hot" label** to the deal, create a **due-today Activity** ("Hot: 4 opens in 3 days — call today") assigned to the deal owner, and pin the deal to the top of that owner's dialer queue (Module 1 integration).
- **Cooldowns:** once flagged, don't re-flag for 7 days unless a *stronger* signal arrives; auto-remove label after 7 quiet days. Prevents alert fatigue — a hot list nobody trusts is worse than none.

---

## Module 3 — Scoreboard & Commissions

**Goal:** per-rep activity and outcome metrics with daily/weekly/monthly rollups, plus an auditable commission ledger.

### Data capture
- **Primary:** Quo **webhooks** (call events incl. ringing/answered/completed, transcripts) streamed into Postgres as they happen.
- **Reconciliation:** nightly pull of `GET /v1/calls` per number from the Quo REST API (has real timestamps, direction, duration — this replaces the unreliable per-day counting we fought with through the MCP tooling) to catch anything webhooks missed.

### Metrics (per rep, per day → rolled up weekly/monthly)
| Metric | Definition |
|---|---|
| Outbound dials | Outgoing calls placed |
| Voicemails left | Outgoing call classified VM **and** drop/message occurred (dialer disposition when available; transcript classifier as fallback — the greeting-phrase heuristic we validated on last week's transcripts) |
| Answered (conversations) | Outgoing call where a human engaged (two-way transcript) + inbound calls handled |
| Talk time | Sum of durations on human-answered calls (excludes VM drops) |
| Connect rate | Answered ÷ dials |
| Conversion rate | Definition to confirm: deals **won ÷ unique leads dialed** in period, and/or stage-to-stage funnel (dialed → deposit → paid-in-full). Ledger supports both. |

### Commissions — standalone journey engine, $100 flat per journey
Fully independent system with its own tables (`sales_journeys`, `sales_orders`, `sales_payouts`, `sales_config`). It borrows *patterns* proven in the ambassador engine — the journey state machine, recompute-from-scratch refund handling, idempotent webhook ingestion, oldest-first backfill, audited admin overrides — but shares no code, tables, or config with it. Ambassadors play no role in this system.

**The rules:**

| Event | Trigger | Result |
|---|---|---|
| **Deposit** | Shopify `orders/paid`, subtotal ≈ $500, customer matched to a Pipedrive person/deal | Journey opens (`deposit_only`), $0 held, expires in 180 days |
| **Confirmation** | Same customer's later orders push cumulative subtotal ≥ threshold within the window | Journey → `confirmed`; **$100 to the attributed rep** |
| **Walk-in** | Customer skips the deposit and pays in full (subtotal ≥ threshold, no open journey) | Journey → `walk_in`; **$100 immediately**. These customers are usually in Pipedrive already, so normal owner attribution applies |
| **Orphan deposit** | No confirmation within 180 days | Journey expires, nothing paid |
| **Refund** | `orders/refunded` — recompute the journey from scratch | If the journey falls below threshold (or was paid): claw back the $100 |

**Attribution — Shopify is the source of truth, Pipedrive is the cross-check:**
1. **Primary: discount code on the order.** Deposit and confirmation orders typically carry a code prefixed with the rep's first name (PARKER…, JACKSON…). A `rep_codes` registry maps known codes → reps, with first-name prefix matching as the fallback for codes not yet registered (registry-first avoids the renamed-code trap; prefix-only matching breaks silently when codes change).
2. **Cross-reference: Pipedrive deal owner.** Shopify customer ↔ Pipedrive person (normalized email, phone/name fallback) → owner of the matched deal. Recorded on the journey alongside code attribution.
3. **Agreement logic:** code and deal owner agree → clean attribution. They disagree (or deposit code says Parker while confirmation code says Jackson) → journey flagged `is_conflict` for an admin resolution queue; commission held until resolved. Code present but no deal → attribute by code, note the missing deal. No code but a matched deal → attribute to deal owner, flagged for review. Neither → **Unattributed queue**.

The **$100 is earned at confirmation/paid-in-full** — never at deposit — regardless of which order carried the attributing code.

**Manual add — sales team and admin:** a "Log a sale" flow backed by a Shopify order lookup (search by order #, email, or name → pull the real order data, never hand-typed amounts). Reps can attach a found order to themselves/a journey; entries are flagged `is_manual` with rep, timestamp, and source order id. Admin gets the full override set on top (reassign, edit eligible amount, remove, backdate confirmation month) — every override requires a reason and writes an audit row. This covers walk-ins that never made it into Pipedrive and any webhook misses.

**Commission base:** flat $100 means eligible-subtotal math only matters for *threshold checks* — but still compute it properly (subtotal after all discounts, minus excluded product types like Merch, no tax/shipping) so a big merch order can't fake a confirmation.

**Pipedrive sync:** journey events drive stage moves (deposit detected → "Deposit Placed"; journey confirmed → "Confirmed (Won)"), keeping pipeline truth aligned with money truth.

**Payouts — via payroll (unlike Trailhead's Stripe transfers):** no money moves through this system. Confirmed commissions accrue on each rep's statement; the admin dashboard exports a per-payroll-period statement (period boundaries configured to match your payroll calendar), admin approves it, and the amount is added to that payroll run. Clawbacks appear as negative line items on the next statement. Every statement line traces back to a journey → orders → Shopify order IDs for audit.

### Surfaces
- **Dashboard** (web page, phone-friendly): today's numbers per rep, week/month trends, leaderboard, commission MTD.
- **Weekly digest** posted Monday morning (email or, later, auto-generated report here).

---

## Cross-cutting concerns

- **Identity matching:** one shared matching service — E.164 phone + lowercased email — used by all three modules. Most integration bugs in systems like this are matching bugs; centralize it.
- **Secrets:** Pipedrive API token, Quo API key, Klaviyo private key, Shopify access token — stored in Supabase (Vault) / Vercel env vars, never in the desktop companion (companion authenticates to your worker via Supabase auth and talks only to it).
- **Rate limits:** Quo 10 req/s, Pipedrive & Klaviyo token-bucket limits — the worker queues and paces; webhooks carry most of the load anyway.
- **PII caution:** Quo transcripts occasionally contain payment card numbers read aloud (observed in last week's calls). The tracker stores **classifications and durations, not transcript text**, except flagged QA snippets with card-pattern redaction. Also worth a rep policy: never take card numbers verbally — send the Shopify invoice link instead (one of last week's calls did exactly this the right way after two failed card reads).
- **Fair use:** sequential, rep-attended dialing of warm lists at 2-seat volume — well inside normal use of Quo. No parallel lines, no robocalling; VM drop only after a human-initiated call reaches voicemail.

## Build order & rough effort

| Phase | What ships | Why first | Effort |
|---|---|---|---|
| 0 | Cloud worker skeleton, Postgres, Quo webhook receiver, identity matcher | Everything depends on it | 2–3 days |
| 1 | **Module 3 tracker + dashboard** | Baseline metrics *before* the dialer, so you can measure its lift; also answers your original per-day dials question permanently | 3–5 days |
| 2 | **Module 2 hot list** (Klaviyo + Pipedrive opens → label + task) | Immediate rep value, no desktop install needed | 3–4 days |
| 3 | **Module 1 dialer, T1 VM drop** | The big workflow change; queue config from your stage list | 1–2 weeks |
| 4 | T2 auto VM drop, commission ledger (needs your doc), digest reports | Polish and payout | 1–2 weeks |

---

# Implementation handoff (read this if you are the Claude instance building it)

This section makes the doc self-contained for development in a fresh environment (VS Code / Claude Code). Everything above is the *what*; this is the *how* plus every constant discovered during discovery sessions.

## Stack & repo shape
- **Web app:** Next.js (App Router) on **Vercel** — dashboard UI, API routes for webhooks, Vercel Cron.
- **DB/auth/secrets:** **Supabase** (dedicated project — do NOT reuse the Trailhead project). Postgres + Supabase Auth (reps + admin roles) + Vault for third-party keys. Business logic that must be atomic/idempotent → Supabase Edge Functions or Next API routes with service-role key; either is fine, pick one and stay consistent.
- **Rep desktop companion (Module 1):** start as a page in the same Next app (queue UI + `tel:`/click-to-call launch). Voicemail-drop tiers T1/T2 need local audio routing → package the same UI in **Tauri** (preferred over Electron for size) when that phase starts. Companion talks ONLY to our backend, never directly to third-party APIs.
- **UI starting point:** `lpo-sales-engine-ui.html` (in this folder) — a single-file clickable prototype (v0.3) of all **four** views, approved by Kyle as the design source of truth for v1. Port its structure and tokens to React components. What it contains, per view:
  - **Dialer:** queue list with PRIMARY badge on Intake; **queue filter builder** (Pipeline → Stage cascade seeded with real stages, Owner = owned-by-me / no-owner / both / anyone, "deal name includes"); lead card with facts + notes; Dial → live call state → **End call** (hotkey E) with a deliberate rule: ending never advances until a disposition (1–4) is logged; Drop VM instant-logs; **voicemail panel with Preview / Record-new flow** (record → timer → name → saved to the rep's drop list); session stats; auto-advance toggle; up-next list.
  - **🔥 Hot List (Module 2 surface):** tiles (flagged now, new today, signals 24h, avg flag→first-touch); flagged-deals table with per-source signal chips (Klaviyo/Pipedrive/Shopify), owner, status (task due / called / cooldown); per-row Call (jumps to dialer Hot queue) and Dismiss (starts cooldown); live signal feed; **flag rules as editable config fields** — thresholds are config, not code.
  - **Scoreboard:** per-rep stat tiles (dials, conversations, VMs, talk time, connect rate, commission MTD), Today/Week/Month toggle, two grouped bar charts (dials/day, conversations/day) with hover tooltips, legend, CVD-validated series colors.
  - **Commissions (admin):** summary tiles, conflict strip with Resolve, journeys table — **each journey shows its Shopify order #s (DEP + CONF, or single WALK-IN #)** — rep/state chips, Log-a-sale modal (Shopify order lookup, attach-as, required reason), payroll statements with clawback negative line, unattributed-orders queue.
  Keyboard map: Enter dial · E end · V drop VM · 1–4 disposition · S skip.

## Design tokens (validated dark theme)
- Surface `#1c1a18` (warm charcoal), raised surface `#252220`, borders `#3a3530`
- Text: primary `#f2efe9`, secondary `#b5aca0`, muted `#7d766c`
- Brand accent (LPO rust, from lonepeakoverland.com `#bd472a`): interactive/dark-surface step **`#c9502e`**, hover `#d95926`
- Chart series (validated, CVD-safe on `#1c1a18`): Parker `#c9502e`, Jackson `#3987e5`; status good `#0ca30c` / warning `#fab219` / critical `#d03b3b` (icons + labels, never color alone)

## Known constants (discovered from live systems — hardcode as seed data, keep editable)
**Quo workspace** (users: `US…`, inboxes/phone-numbers: `PN…`):
| Person | userId | Inbox | inboxId | Number |
|---|---|---|---|---|
| Parker Kiesz | `USlRvDLVOp` | Parker | `PN4tAddEF7` | +1 509-661-6948 |
| Jackson Faerber | `USSvY8hkeK` | Jackson | `PNQvoLc6PO` | +1 509-300-5629 |
| Briar Wood | `USkRGQ5lOo` | Customer Service (shared: Briar, Parker, Kecia, Jackson) | `PN2nRozOQb` | +1 509-300-1277 |
| Gabi Maciel | `USk5E8eUGe` | Primary | `PNZuEepf4x` | +1 509-350-8901 |
| Kecia Ice (owner) | `USNLigZ9Gn` | Kecia | `PNvMf6Ib4K` | +1 509-300-5522 |

**Pipedrive** (pipeline 6 = Intake, 7 = Sales/Nurture, 8 = Order): stage IDs — Recovery 45, Intake- Needs Qualification 44 (**primary dialer queue**), Qualified(p6) 46, Waiting on Timing 47, Qualified(p7) 48, Cold 54, Warm 55, Hot 56, Deposit Placed(p7) 50, Deposit Placed(p8) 51, Confirmation Scheduled 52, Confirmed (Won) 53.

**Business constants:** deposit ≈ $500 (±1¢), confirmation/walk-in threshold ≥ $5,000 cumulative subtotal, pairing window 180 days, commission **$100 flat per confirmed journey**, excluded product types `['Merch']`, timezone `America/Los_Angeles`, rep discount codes are first-name-prefixed (PARKER…, JACKSON…) but maintain a `rep_codes` registry — never rely on prefix alone.

## Supabase schema draft
```
reps(id, name, email, quo_user_id, pipedrive_user_id, active)
rep_codes(id, rep_id, code, active, note)                      -- registry-first attribution
sales_orders(id, shopify_order_id UNIQUE, customer_email, customer_shopify_id,
             customer_name_norm, subtotal, eligible_subtotal, discount_codes jsonb,
             classification, journey_id, is_manual, added_by, created_at)
sales_journeys(id, rep_id, code_rep_id, deal_owner_rep_id, pipedrive_deal_id,
               state,            -- deposit_only|confirmed|walk_in|paid|clawed_back|expired
               is_conflict, deposit_started_at, confirmed_at, expires_at,
               eligible_total, commission_amount)
payroll_statements(id, rep_id, period_start, period_end, status, approved_by, exported_at)
statement_lines(id, statement_id, journey_id, amount)          -- clawbacks = negative lines
call_events(id, quo_call_id UNIQUE, rep_id, direction, status, started_at, duration_s,
            classification,      -- conversation|voicemail|no_answer|screening
            disposition, deal_id, raw jsonb)
engagement_events(id, source,    -- klaviyo|pipedrive|shopify
                  type, person_email, pipedrive_deal_id, occurred_at, meta jsonb)
hot_flags(id, deal_id, reason, flagged_at, cleared_at, cooldown_until)
queue_config(id, name, stage_ids int[], priority, cadence_days, is_primary)
app_config(single row: thresholds, windows, excluded_types, rep_flat_commission=100)
admin_corrections(id, actor, action, target, reason NOT NULL, created_at)
```

## External API integration notes (hard-won details)
**Shopify** — webhooks `orders/paid` + `orders/refunded`. Verify HMAC: SHA-256 of the **raw body** with the client secret, constant-time compare vs `X-Shopify-Hmac-Sha256`; bad → 401. Duplicate deliveries are routine → idempotent insert on `shopify_order_id` (`resolution=ignore-duplicates`), empty return = skip downstream. Commission base = `subtotal_price` (already net of ALL discounts incl. order-level) minus post-discount value of excluded-type lines — do NOT sum `line_items[].discountedTotalSet` (misses order-level discounts). Refund handler: Shopify sends the full order with every refund → recompute the whole journey from scratch each time (idempotent by construction). Backfill via GraphQL runs **oldest-first** so deposits precede confirmations; GraphQL `discount_code:` filter is case-sensitive and native-codes-only.

**Quo** — REST API (docs: quo.com/docs; API keys in workspace settings, Business plan required for transcripts). `GET /v1/calls` per phoneNumberId has real timestamps/direction/duration — use it for nightly reconciliation. Webhooks: call lifecycle events (ringing/answered/completed; transcript events) → primary live ingestion. Rate limit **10 req/s**. ⚠️ Do NOT build metrics on the Quo *MCP server's* fetch tools — their conversation-discovery windows drop calls (verified: two 1-day queries returned 15 calls where the 2-day window returned 54) and per-call `startedAt` comes back blank. The REST API + webhooks are the reliable path. No call-placement API exists — dialing goes through the desktop app's click-to-call (tel/deep-link), which the Pipedrive integration already exercises.

**Call classification heuristic** (validated against a week of real transcripts): a call is a *conversation* iff the contact has ≥2 utterances containing none of: "voice mail", "voicemail", "record your message", "record your name", "leave a message", "leave your message", "can't take your call", "at the tone", "please stay on the line", "is not available", "press pound", "forwarded", "please leave", "reached" — AND the rep also speaks. Otherwise voicemail/screening. Store classifications + durations, never raw transcript text (transcripts have contained spoken credit-card numbers; if QA snippets are ever stored, redact card patterns first).

**Pipedrive** — API v2. Native Quo↔Pipedrive integration is live: click-to-call opens the Quo desktop app; calls auto-log as Activities, texts as Notes — the app must NOT double-log. Email opens: reps send tracked email through Pipedrive (confirmed habit) → mail-thread open/click flags via API. Deal webhooks (stage moves) optional for keeping queues fresh between cron runs.

**Klaviyo** — Events API, metrics `Opened Email` / `Clicked Email`, match profile→person by normalized email. Private key scope: read events/profiles.

## Environment variables
```
SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY
SHOPIFY_WEBHOOK_SECRET  SHOPIFY_ADMIN_TOKEN  SHOPIFY_STORE_DOMAIN
QUO_API_KEY  QUO_WEBHOOK_SECRET
PIPEDRIVE_API_TOKEN  PIPEDRIVE_WEBHOOK_SECRET (if deal webhooks used)
KLAVIYO_PRIVATE_KEY
APP_TIMEZONE=America/Los_Angeles
```

## Build order (repeat of phases, with acceptance checks)
0. Schema + webhook receivers deployed; Shopify HMAC-verified test delivery lands a row. *(2–3 d)*
1. Tracker + scoreboard: Quo webhooks flowing, nightly `GET /v1/calls` reconciliation, dashboard shows per-rep daily dials/conversations/VM/talk-time matching a manual spot-check. *(3–5 d)*
2. Hot list: 15-min cron, Klaviyo+Pipedrive signals, "🔥 Hot" label + due-today Activity on threshold, cooldowns verified. *(3–4 d)*
3. Dialer companion: Intake queue (stage 44) default, click-to-call launch, call-end advance via webhook, dispositions, T1 VM drop. *(1–2 wk)*
4. Journey engine + commissions: order ingestion → journeys → conflict/unattributed queues → statements; then T2 auto VM drop. *(1–2 wk)*

## Open items — status
1. **Pipedrive stages**: ✅ pulled via MCP; proposed queue mapping in Module 1 (awaiting Kyle's sign-off on cadences).
2. **Commission logic**: ✅ specced in Module 3 as a fully standalone engine. Attribution locked: rep-name discount code on the Shopify order is primary, Pipedrive deal owner is the cross-check, disagreements go to a conflict queue; $100 earned at confirmation/paid-in-full only.
3. **API keys**: ✅ owner will provision securely (Supabase Vault / Vercel env).
4. **Hosting**: ✅ dedicated Vercel app + dedicated Supabase project, fully separate from Trailhead.
5. **Pipedrive email habit**: ✅ confirmed — Module 2 email-open coverage is solid.
