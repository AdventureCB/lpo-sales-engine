# Ops ↔ LPO Sales Engine integration contract (v2)

*v2, 2026-11-16. Replaces v1 (11/5). Built from the Ops reply of 11/16 (`ops-integration-reply.md`) and the owner's decisions on it. Everything Ops asked for in its section 1 is accepted. The Sales Engine side of v2 is built and live; it is waiting on Ops' first events.*

Two apps, same company, different codebases and databases:

- **Ops**: staff at `https://ops.lonepeakoverland.com`, customers at `https://orders.lonepeakoverland.com`. Quotes, payments (through Shopify), customer emails (Resend), production.
- **Sales Engine**: `https://lpo-sales-engine.vercel.app`. The sales CRM: deals, contacts, reps, timeline, notifications, campaigns.

Neither app reads the other's database. Data flows Ops → Sales Engine as signed events, plus one server-to-server prefill call the other way.

## 1. What changed from v1

| Ops ask (reply §) | v2 |
|---|---|
| 1.1 No PII in the deep link | Accepted. Sales Engine calls `POST /api/crm/prefill` server-to-server, then opens a link with only `crm_deal_id`. `crm_deal_url` dropped. (§3) |
| 1.2 `link` = staff quote page | Accepted. The Sales Engine shows it as "Open in Ops". |
| 1.3 Hostnames | Accepted: `ops.` for staff/API, `orders.` for customers. |
| 1.4 Email can be null at creation | **Option (a):** send `quote.created` right away. Hold it only when there is no `crm_deal_id`, no email, no phone and no `website_submission_id`. |
| 1.5 `backfill` flag | Accepted, and stricter: backfill events only mirror the quote and add timeline lines to an **existing** deal. No new deals, stage moves, campaign exits, owner changes or notifications. |
| 1.6 Sign the timestamp; separate pull token | Accepted: HMAC over `<timestamp>.<raw body>`; pull uses `OPS_PULL_TOKEN`. (§4, §7) |
| 2.x Ops' model (ids, statuses, money, production, activity, email) | Adopted as written. See §6. |
| 4.x Enrichments | All accepted. See §6. |
| 4.7 Website submission id | **Yes, the Sales Engine is that CRM.** Website forms (including the Build Survey) store their `submission_id` on the lead. Send `data.website_submission_id`; it is the first match key after `crm_deal_id`. |

## 2. Owner decisions (reply §5)

**5.1 Whose deal is it.** Ops sends `data.rep` on every `quote.created`/`quote.updated`.
- Deal in the unassigned pool → the Sales Engine adopts Ops' rep as owner.
- Deal owned by someone else, before any payment → flagged on the deal and the owner is notified. The owner is **not** changed.
- **At first payment** (deposit or full) → the deal owner is asked to **approve** Ops' credit or **flag** it. A flag notifies the admins, who reassign credit in Ops if Ops is wrong. Commission follows Ops; the flag catches mistakes early.

**5.2 Who emails before the deposit.** Ops owns follow-up once a quote has been **emailed** (`ops_stage` becomes `sent`). From that moment the person leaves every Sales Engine drip and cannot be enrolled again; only manual rep emails go out from the Sales Engine. An `expired` or `deleted` quote releases them.

**5.3 Completion dates.** The Sales Engine shows `eta_label` (the window). `eta` (a day) only when the build is pinned.

**Demos.** `demo.completed` is a future feature. Ops doesn't need to build it now. The Sales Engine already accepts the event shape in §6 for when it exists.

## 3. Create quote: prefill + deep link

When a rep clicks **Create quote** on a deal, the Sales Engine:

1. Calls Ops server-to-server:
   ```
   POST https://ops.lonepeakoverland.com/api/crm/prefill
   Content-Type: application/json
   X-Ops-Signature: sha256=<base64 HMAC-SHA256 of "<timestamp>.<raw body>", keyed OPS_WEBHOOK_SECRET>
   X-Ops-Timestamp: <unix seconds>

   { "crm_deal_id": "<uuid>",
     "customer": { "name", "first_name", "last_name", "email", "phone" } }
   ```
   Ops answers `200 {"ok":true}` and keeps the details 24 hours keyed by `crm_deal_id`. Any field may be null.
2. Opens, in a new tab:
   ```
   https://ops.lonepeakoverland.com/builds/sales?tab=quote&source=sales-engine&crm_deal_id=<uuid>
   ```

If the prefill call fails, the link still opens and the rep types the details. Ops stores `crm_deal_id` on the quote (opaque, ≤ 64 chars), builds its own "back to the deal" link from it, and shows an existing quote first when the deal already has one. The rep picks the truck from Ops' list.

## 4. Webhook delivery (Ops → Sales Engine)

```
POST https://lpo-sales-engine.vercel.app/api/webhooks/ops
Content-Type: application/json
X-Ops-Signature: sha256=<base64 HMAC-SHA256 of "<timestamp>.<raw body>", keyed OPS_WEBHOOK_SECRET>
X-Ops-Timestamp: <unix seconds, within 5 minutes>

{ "events": [ … 1 to 100 events … ] }
```

```js
const ts = Math.floor(Date.now() / 1000).toString();
const body = JSON.stringify({ events });
const sig = "sha256=" + crypto.createHmac("sha256", process.env.OPS_WEBHOOK_SECRET).update(`${ts}.${body}`).digest("base64");
```

- `200 {"ok":true,"accepted":n,"duplicates":m,…}` = stored. Duplicate `event_id`s are ignored, so retrying a batch is always safe.
- `401` bad signature or stale timestamp; `400` malformed (names the first bad `event_id`); `5xx` retry.
- `?dry=1` validates and reports without writing. Use it to test signing.
- Retries per Ops' scheduler (reply 2.8) are fine. Production only; previews never send.

## 5. Event envelope

| Field | Required | Notes |
|---|---|---|
| `event_id` | yes | ≤ 64 chars, stable across retries. |
| `type` | yes | §6. Unknown types are stored and ignored. |
| `occurred_at` | yes | ISO-8601 UTC, when it happened. |
| `quote_id` | yes | The Ops reference, `LPQ-0201`. |
| `quote_number` | optional | Same value as `quote_id`. |
| `crm_deal_id` | yes (may be null) | From the deep link. One deal can have several quotes. |
| `customer` | recommended | `{name, first_name, last_name, email, phone}`; email may be null (§1, 1.4a). |
| `backfill` | only on replayed history | `true` on every synthesized historical event. |
| `data` | yes | Per type. Extra fields are always fine. |

**Matching when `crm_deal_id` is null:** `data.website_submission_id` → email → phone → else a new deal through the Sales Engine's "Quote Created" intake engine (never for backfill).

## 6. Event types

### `quote.created` / `quote.updated`
`data`:
- `link`: staff quote page `https://ops.lonepeakoverland.com/builds/quotes/LPQ-0201`.
- `status` (`draft|sent|paid|expired|void`) and `ops_stage` (`started|sent|invoice_out|deposit_paid|paid|additions_owed|expired|deleted|cancelled`) as in the reply's table 2.2. **The first `ops_stage: "sent"` is the signal that Ops owns follow-up.**
- `subtotal_cents` (always), `total_cents` (null until tax is known), `deposit_cents`, `paid_cents`, `balance_cents`.
- `origin` (`rep|builder`), `source` (for builder quotes, e.g. `build-survey`), `originator {name, email, organization, role}`.
- `rep {name, email}` or null: the Lone Peak rep Ops credits.
- `build {truck, handover{name, kind}, options[{sku, name, qty}], revision}`.
- `change {by, summary}` on `quote.updated` when items changed (batched per editing session).
- `expires_at` (date, null once money is on the quote), `balance_due_on` (date or null).
- `website_submission_id` on quotes opened from a website form or the Build Survey.

### `quote.activity`
`data.action`: `viewed`, `dwell` (`duration_s`), `pay_clicked` (`detail`: `deposit|full|additions`). Plus `session_id`, `user_agent`, `referrer`, `geo {city, region, country}`; no raw IP. Staff and dealer views excluded. The Sales Engine records these on the timeline only; they are not engagement signals.

### `quote.paid`
`data`: `amount_cents`, `kind` (`deposit|full|balance|additions|split`), `processor: "shopify"`, `processor_ref` (Shopify order name), `total_cents`, `balance_cents`, `paid_at`. Only the **first** `deposit` or `full` payment moves the deal to Deposit Placed and opens the credit review; later payments are timeline only and never move a won deal backwards.

### `quote.refunded`
`data`: `amount_cents`, `reason` (`line_removed|cancellation`), `processor`, `processor_ref`, `refunded_at`.

### `quote.cancelled`
`data`: `cancelled_at`, `refunded_cents`, `retained_cents`. The deal owner is notified; the deal itself is left for the rep.

### `quote.attention`
`data`: `kind` (`truck_answer_needed|refund_requested|…`), `open` (bool), `detail`. Owner notified while `open`; cleared when Ops sends `open: false`.

### `email.sent` / `email.delivered` / `email.bounced`
`data`: `message_id`, `template`, `subject`, `to`, `from`. `sent` goes on the timeline. `bounced` marks the address bad on the contact and notifies the owner. `delivered` is stored only. (No opens/clicks; agreed.)

### `production.status`
`data`: `status` (`scheduled|in_production|on_hold|ready|delivered|cancelled`), `label`, `area` (in production), `reason` (on hold), `eta_label` (always), `eta` (pinned builds only), `balance_due_on`.

### `install.booked`
`data`: `day`, `time`, `booked_by` (`customer|staff`), `moved` (bool).

### `demo.completed` (future)
`data`: `originator {name, email, organization, role}`, `demo_at`, `location`, `note`. Not needed until Ops records demos.

## 7. Pull endpoint (nightly reconcile + backfill)

```
GET https://ops.lonepeakoverland.com/api/crm/events?since=<cursor>&limit=500
Authorization: Bearer <OPS_PULL_TOKEN>
→ { "events": [ …oldest first… ], "next": "<cursor>", "has_more": bool }
```

Separate secret from the webhook secret (reply 1.6). Every event ever emitted must be reachable; keep at least 13 months. The Sales Engine calls it nightly, and once with no cursor at launch to backfill (`backfill: true` events, LPQ quotes from August 2026 on).

## 8. Secrets (set by the LPO admin in both Vercel projects; never in chat or a repo)

- `OPS_WEBHOOK_SECRET`: already set. Signs webhooks and the prefill call.
- `OPS_PULL_TOKEN`: **new**. Bearer token for the pull endpoint only.

## 9. Test plan

1. **Signing:** post one `quote.created` to `…/api/webhooks/ops?dry=1` → `200 {"dry":true,"accepted":1}`.
2. **Prefill + deep link:** click Create quote on a test deal; confirm Ops receives the prefill and the form opens prefilled with no PII in the URL.
3. **Live quote:** save it; the Quotes card appears on the deal. Email it (`ops_stage: sent`); the person leaves any Sales Engine drip.
4. **Activity:** open the build as the customer; a view appears on the timeline.
5. **Deposit (Shopify test order):** deal moves to Deposit Placed; the owner gets the approve/flag credit prompt.
6. **Pull:** call §7 with no cursor; events come back in order with `next`.
7. **Backfill dry run:** send one `backfill: true` event with `?dry=1`; the response says "backfill, silent".

Test quotes use `<name>+opstest@lonepeakoverland.com`; the Sales Engine admin deletes the deal side afterwards.
