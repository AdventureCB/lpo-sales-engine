# Ops ↔ LPO Sales Engine integration contract (v1)

Two apps, same company, different codebases and databases:

- **Ops** — https://lone-peak-ops.vercel.app, Next.js on Neon Postgres. Builds quotes, takes deposits and payments, sends customer emails, tracks production.
- **Sales Engine** — https://lpo-sales-engine.vercel.app, Next.js on Supabase. The sales CRM: deals, contacts, reps, call/text/email timeline, notifications.

This document is the full contract between them. Ops implements the "Ops side" sections; the Sales Engine implements the rest. Neither app reads the other's database.

## 1. Overview

Direction of data is almost entirely **Ops → Sales Engine**:

1. Ops **pushes events** (quote created, customer viewed the quote, paid, email sent, production status) to a signed webhook on the Sales Engine, as they happen.
2. Ops exposes a **pull endpoint** returning the same events by cursor, which the Sales Engine polls nightly to catch anything a webhook delivery missed, and once to backfill history.
3. The Sales Engine **deep-links into Ops** from a deal page ("Create quote") with the customer prefilled and a `crm_deal_id`. That id is the correlation key: Ops stores it on the quote and includes it on every event about that quote.

The shared secret `OPS_WEBHOOK_SECRET` (a random 32+ byte string) is set as an environment variable in **both** Vercel projects by the LPO admin. It is never committed, logged, or pasted into chat.

## 2. Correlation: how a quote maps to a deal

- A quote started from the Sales Engine button arrives with `crm_deal_id` on the deep link. **Store it on the quote** and send it on every event for that quote.
- A quote created inside Ops without that id (a rep starts one directly, or the website 3D builder auto-generates one after a self-serve deposit) has no `crm_deal_id`. Send `null`. The Sales Engine matches by customer email to an open deal; when there is none it creates a deal through its own "Quote Created" intake engine (owner assignment and pipeline stage are configured on the Sales Engine side). Ops does nothing special here beyond always sending the customer's email.
- `customer.email` is therefore **required** on `quote.created` and strongly expected on every other event. Lowercase it. Phone is optional but valuable; any format is fine.
- `created_by` on `quote.created` is the Ops user's email. Ops users sign in with `@lonepeakoverland.com` addresses, and the Sales Engine maps that to the rep. For builder-generated quotes send `created_by: "builder"`.

## 3. Deep link into Ops (Ops side)

The Sales Engine opens, in a new tab:

```
https://lone-peak-ops.vercel.app/builds/sales?tab=quote
  &source=sales-engine
  &crm_deal_id=<uuid>
  &crm_deal_url=https://lpo-sales-engine.vercel.app/crm/deal/<uuid>
  &name=<url-encoded full name>
  &first_name=<…>&last_name=<…>
  &email=<url-encoded email>
  &phone=<E.164 or empty>
```

Ops must:

1. Prefill the new-quote form from `name`/`first_name`/`last_name`, `email`, `phone` when `source=sales-engine` is present. Any of them may be empty.
2. Keep `crm_deal_id` with the draft and persist it on the quote record when the quote is saved. Treat it as an opaque string up to 64 characters; it is a UUID today.
3. Optionally show a small "Opened from Sales Engine" indicator with a link to `crm_deal_url`.

If the Ops user is not signed in, redirect to sign-in and return to the same URL with the parameters intact.

## 4. Webhook delivery (Ops side)

```
POST https://lpo-sales-engine.vercel.app/api/webhooks/ops
Content-Type: application/json
X-Ops-Signature: sha256=<base64 HMAC-SHA256 of the raw request body, keyed with OPS_WEBHOOK_SECRET>
X-Ops-Timestamp: <unix seconds when the request was signed>
```

Body:

```json
{ "events": [ { ...event }, { ...event } ] }
```

- 1 to 100 events per request. Batch `quote.activity` events freely; send `quote.paid` promptly on its own.
- Sign the **exact bytes** you send. Node: `crypto.createHmac("sha256", secret).update(rawBody).digest("base64")`.
- Requests older than 5 minutes by `X-Ops-Timestamp` are rejected (replay protection), so sign immediately before sending.
- The Sales Engine answers `200 {"ok":true,"accepted":n,"duplicates":m}` when it has stored the batch. Treat any 2xx as acknowledged. Duplicate `event_id`s are silently ignored, so retrying a whole batch is always safe.
- Error responses: `401` bad signature or stale timestamp, `400` malformed body with `{"ok":false,"error":"…","event_id":"…"}` naming the first bad event, `429` back off, `5xx` retry.
- **Retry policy:** on network failure, timeout (use 10 s), 429 or 5xx, retry with exponential backoff: 1 min, 5 min, 30 min, 2 h, 12 h, then give up and leave the event for the pull endpoint. Do not retry 400 or 401; log them.
- Preserve per-quote order where you can (send activity for one quote in chronological order), but the Sales Engine orders by `occurred_at` and tolerates out-of-order delivery.

**Dry run:** `POST …/api/webhooks/ops?dry=1` validates signature and schema and returns what it would have done, without writing anything. Use it to test the signing code.

## 5. Event envelope

Every event is an object with these fields:

| Field | Type | Required | Notes |
|---|---|---|---|
| `event_id` | string ≤ 64 | yes | Globally unique, stable across retries. A UUID per event, or `<quote_id>:<type>:<n>`. |
| `type` | string | yes | One of the types in §6. |
| `occurred_at` | ISO-8601 UTC | yes | When it happened, not when it was sent. |
| `quote_id` | string ≤ 64 | yes | Ops' stable internal id for the quote. |
| `quote_number` | string | no | Human-readable, e.g. `LPQ-0176`. Send on every event if cheap. |
| `crm_deal_id` | string \| null | yes | From the deep link, else `null`. |
| `customer` | object | yes on `quote.created`, recommended elsewhere | `{ "name", "first_name", "last_name", "email", "phone" }`, any may be null except `email` on `quote.created`. |
| `data` | object | yes | Type-specific payload (§6). |

Unknown extra fields are ignored, so Ops may add fields without a contract change. New event `type`s are stored but not acted on until this document lists them.

## 6. Event types

### `quote.created`

```json
{
  "event_id": "9d7c…",
  "type": "quote.created",
  "occurred_at": "2026-10-07T17:02:11Z",
  "quote_id": "q_01HX…",
  "quote_number": "LPQ-0201",
  "crm_deal_id": "a1bca4ed-e0f5-41c8-b0b2-15dd6bedc37c",
  "customer": { "name": "Jordan Lee", "first_name": "Jordan", "last_name": "Lee", "email": "jordan@example.com", "phone": "+15095550142" },
  "data": {
    "link": "https://lone-peak-ops.vercel.app/q/LPQ-0201?t=…",
    "total_cents": 4875000,
    "deposit_cents": 50000,
    "currency": "USD",
    "status": "sent",
    "origin": "rep",
    "created_by": "jackson@lonepeakoverland.com",
    "truck": "2023 Toyota Tacoma",
    "summary": "Lone Peak Camper V2, Expedition package, …"
  }
}
```

- `link` is the customer-facing quote URL (whatever the customer receives by email). Must stay valid for the life of the quote.
- `origin`: `"rep"` or `"builder"` (website 3D builder self-serve).
- `status`: `"draft" | "sent" | "viewed" | "accepted" | "paid" | "expired" | "void"`. Send `quote.created` when the quote exists; it's fine if the status is still `draft`.
- `truck` and `summary` are free text shown to the rep.

### `quote.updated`

Same `data` shape as `quote.created`, sent whenever total, status, link or summary changes (new version, expiry, void). Include the full current values, not a diff. Add `"version": 2` if Ops versions quotes.

### `quote.activity`

One event per customer action on the quote page.

```json
{
  "type": "quote.activity",
  "data": {
    "action": "viewed",
    "session_id": "s_8f3…",
    "duration_s": 94,
    "detail": null,
    "user_agent": "Mozilla/5.0 …",
    "ip": "73.11.22.33",
    "referrer": "https://mail.google.com/"
  }
}
```

`action` values and when to send them:

| action | when | `detail` |
|---|---|---|
| `viewed` | page load (one per load) | null |
| `dwell` | on page hide/unload, with `duration_s` since load | null |
| `section_opened` | customer expands/opens a section or tab | section name |
| `pdf_downloaded` | download/print clicked | null |
| `pay_clicked` | customer clicked Pay deposit / Pay in full | `"deposit"` or `"full"` |
| `accepted` | customer accepted/signed without paying yet | null |
| `declined` | customer declined, if the page offers it | reason text |
| `shared` | copy-link/forward clicked | null |

Send `ip` when available; the Sales Engine uses it only to infer approximate location. `session_id` groups actions from one visit (random id in `sessionStorage`).

See §9 if the quote page does not record this today.

### `quote.paid`

```json
{
  "type": "quote.paid",
  "data": {
    "amount_cents": 50000,
    "kind": "deposit",
    "method": "card",
    "processor": "stripe",
    "processor_ref": "pi_3Q…",
    "total_cents": 4875000,
    "balance_cents": 4825000,
    "paid_at": "2026-10-07T17:40:02Z"
  }
}
```

- `kind`: `"deposit"` or `"full"`. Send one event per payment; a later balance payment is another `quote.paid` with `kind: "balance"`.
- Sales Engine behavior (for Ops' awareness, nothing to implement): on **any** `quote.paid` the deal is marked **Deposit Placed** for rep review, the amount goes on the timeline, the owner is notified. Full payments are not auto-won; a rep confirms.

### `email.sent`, `email.opened`, `email.clicked`

```json
{
  "type": "email.sent",
  "data": {
    "message_id": "msg_01…",
    "template": "quote_sent",
    "subject": "Your Lone Peak Overland build — Quote #LPQ-0201",
    "to": "jordan@example.com",
    "from": "team@lonepeakoverland.com",
    "url": null
  }
}
```

`email.opened` / `email.clicked` reuse `message_id` and, for clicks, put the target in `url`. Send these only if your email provider gives you opens/clicks; `email.sent` alone is already useful because it stops reps from double-sending.

### `production.status`

```json
{
  "type": "production.status",
  "data": {
    "order_id": "ord_01…",
    "status": "in_production",
    "label": "In production — frame",
    "eta": "2026-12-15",
    "note": null
  }
}
```

`status` is a stable snake_case key from a fixed set Ops owns (suggested: `queued`, `materials_ordered`, `in_production`, `qa`, `ready_for_pickup`, `shipped`, `delivered`, `on_hold`, `cancelled`); `label` is the human text to show. Send one event per status change.

## 7. Pull endpoint (Ops side)

```
GET https://lone-peak-ops.vercel.app/api/crm/events?since=<cursor>&limit=500
Authorization: Bearer <OPS_WEBHOOK_SECRET>
```

Response:

```json
{ "events": [ …same event objects as §5/§6, oldest first… ], "next": "<cursor>", "has_more": false }
```

- `cursor` is opaque to the caller. A monotonically increasing integer sequence assigned when the event is recorded is the easiest correct choice; `since` omitted means from the beginning.
- Every event ever sent (or that should have been sent) over the webhook must be reachable here. Keep at least 13 months.
- The Sales Engine calls this nightly with the last cursor it saw, and once at launch with no cursor to backfill existing quotes. For backfill, synthesize a `quote.created` (and `quote.paid`, `production.status` where applicable) for every historical quote with `occurred_at` set to the original timestamps.

Practical implementation: write every outgoing event to an `outbound_events` table (sequence, event_id unique, payload jsonb, delivered_at, attempts) and have both the webhook sender and this endpoint read from it. That gives retries, ordering and the pull endpoint from one table.

## 8. What the Sales Engine does with the events (for context)

- Deal page gets a **Quote card**: number, status chip, amount, Open quote button, last viewed, view count, production status, recent activity.
- Timeline entries: quote created/sent, each view session, pay clicked, paid, emails sent/opened, production changes.
- Owner notifications: first view, pay clicked, paid, and a view after 24+ quiet hours. Other views are recorded silently.
- `quote.paid` → stage **Deposit Placed**, note with amount and kind, rep reviews.
- Builder-origin quotes with no deal → deal created via the Quote Created intake engine (pool/stage/source configurable in Settings).
- Nothing flows back to Ops except the deep link.

## 9. If the Ops quote page does not track customer activity yet

Add a small client script to the customer-facing quote page. It needs no third-party service.

1. On load: create or read `sessionStorage.lpo_qs` (random id). `POST /api/q/<quote_id>/activity` with `{ action: "viewed", session_id, referrer: document.referrer }`.
2. Wire buttons: pay deposit/full → `pay_clicked` with `detail`; PDF/print → `pdf_downloaded`; accordion/tab opens → `section_opened` with the section name; accept → `accepted`.
3. On `visibilitychange` to hidden and on `pagehide`: `navigator.sendBeacon("/api/q/<quote_id>/activity", JSON.stringify({ action: "dwell", session_id, duration_s }))`.
4. The server route records `user_agent` and `ip` from the request, writes a row, and enqueues a `quote.activity` event (§6) into the outbound table. Rate-limit per session to something like 60 events per 10 minutes.

The quote page URL must contain a token that identifies the quote without authentication (it's what the customer gets by email), and the activity route must accept only that token, never a bare sequential id.

## 10. Test plan

Run in this order; the Sales Engine side confirms each step.

1. **Signing:** post one `quote.created` with a made-up quote to `…/api/webhooks/ops?dry=1`. Expect `200 {"ok":true,"dry":true,"accepted":1,…}`. A `401` means the signature or timestamp is wrong.
2. **Deep link:** open the §3 URL by hand with sample values; confirm the form prefills and the saved quote stores `crm_deal_id`.
3. **Live create:** create a quote from the deep link for a test contact (`<yourname>+opstest@lonepeakoverland.com`). Confirm the Quote card appears on that deal.
4. **Activity:** open the quote page as the customer, click around, close the tab. Confirm views and dwell appear on the deal timeline.
5. **Paid:** complete a deposit in test mode. Confirm the deal moves to Deposit Placed and the owner gets a notification.
6. **Pull:** call the §7 endpoint with no cursor and confirm the test events come back in order with a `next` cursor.
7. **Retry:** temporarily point the webhook at a wrong path, create an event, restore, and confirm the retry lands and the event is not duplicated.

Delete test quotes and deals afterward (the Sales Engine admin removes the deal side).

Signature helper for tests (Node):

```js
const crypto = require("crypto");
const body = JSON.stringify({ events: [evt] });
const ts = Math.floor(Date.now() / 1000).toString();
const sig = "sha256=" + crypto.createHmac("sha256", process.env.OPS_WEBHOOK_SECRET).update(body).digest("base64");
await fetch("https://lpo-sales-engine.vercel.app/api/webhooks/ops?dry=1", {
  method: "POST",
  headers: { "content-type": "application/json", "x-ops-signature": sig, "x-ops-timestamp": ts },
  body,
});
```

## 11. Questions for the Ops session to answer back

1. Does the customer quote page already record views/clicks? If not, is §9 acceptable as specified?
2. Which email provider sends Ops' customer emails, and does it provide open/click webhooks?
3. Confirm the production status keys you will use (§6 `production.status`).
4. Confirm `quote_id` and `quote_number` formats, and that the customer `link` is stable for the quote's lifetime.
5. Anything in the deep link (§3) that conflicts with the current `/builds/sales?tab=quote` page.
6. Expected timeline for emitting each event type, so the Sales Engine side can enable features in step with it.

Changes to this contract are made in this file; both sides work from the latest version.
