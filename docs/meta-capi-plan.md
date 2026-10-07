# Meta Conversions API (and Google offline conversions) — plan

**Status: parked (Oct 7, 2026).** Resume once the Ops integration delivers `quote.paid` events, because real deposit and quote amounts are what make the purchase events worth sending. Everything upstream is already in place.

## Why

Meta's browser pixel only sees what happens on the site. The Sales Engine knows which leads a rep actually reached, which qualified, which placed a deposit, and for how much. Sending those back as server events teaches Meta's bidding which kind of clicker becomes a buyer, so campaigns can optimize for qualified leads or deposits instead of raw form fills. Google Ads gets the same data through offline conversion import.

## What is already in place

- `attr.js` captures `fbclid`, `gclid` and friends on every ad click (`web_touches`), plus Meta's `_fbp` / `_fbc` cookies per visitor (`web_visitors.fbp/fbc`, `web_touches.fbp/fbc`). In the first hours of v2, 7 of 8 visitors carried `_fbp`.
- Visitors link to contacts on identify (`web_visitor_links`); about a third of new deals have a linked visitor with click ids.
- Deal state is maintained on `crm_deals`: `attempt_count`, `contact_count`, `first_contact_at`, stage, `won_at`, value.
- `lib/campaign-roas.ts` already resolves a deal's originating paid click (`attributeDeals`), which is the same lookup CAPI needs.

## Event design

| Sales Engine moment | Meta event | Google conversion action | Value |
|---|---|---|---|
| Deal created from a paid touch (or any deal with a matched click) | `Lead` | `Lead (CRM)` | none |
| First real conversation (`first_contact_at` set) | custom `ContactedLead` | `Contacted lead` | none |
| Deal enters a Qualified-pipeline stage | custom `QualifiedLead` | `Qualified lead` | none |
| `quote.paid` kind=deposit (from Ops) | `Purchase` with `content_name: "Deposit"` | `Deposit` | deposit amount |
| Deal confirmed / `quote.paid` kind=full or balance | `Purchase` with `content_name: "Camper"` | `Purchase` | quote total |

Rules:

- **Never send `crm_deals.value_cents` as a value.** It is a template number present on 89% of deals; it would teach Meta every lead is worth $48k. Values come only from Ops payment events (and, until Ops is live, nothing).
- `event_id` = `<deal id>:<event name>` so retries and re-runs dedupe on Meta's side, and so a later browser pixel event with the same id (if we ever add one) merges rather than double counts.
- `event_time` = when the moment happened (deal created / contact / stage change / paid), not when we send. Meta accepts up to 7 days back; the nightly job catches up anything within that window.
- `action_source: "system_generated"` for CRM-derived events (`"website"` only for events that happened on the site with a click id).
- User data, all SHA-256 hashed and normalized per Meta's spec: `em` (lowercase email), `ph` (E.164 digits), `fn`/`ln`, `ct`/`st`/`zp` when the contact has them. Unhashed: `fbc` (built from fbclid as `fb.1.<click ts ms>.<fbclid>` when the cookie itself is missing), `fbp`, `client_user_agent` from `web_visitors`.
- Test with Meta's `test_event_code` first (Events Manager → Test events) and watch the match-quality score; aim for 6+ out of 10. Then remove the test code.

## Implementation sketch

1. **Table `conversion_sends`** (`deal_id`, `platform` meta|google, `event`, `event_id` unique, `value_cents`, `sent_at`, `response`, `error`). One row per event ever sent; the job never resends a row that succeeded.
2. **`lib/conversions.ts`**: `collectPending(db)` walks deals changed in the last 7 days, derives which rows should exist (Lead / ContactedLead / QualifiedLead / Purchase) and diffs against `conversion_sends`; `sendMeta(events)` posts batches of ≤1000 to `https://graph.facebook.com/v21.0/<pixel id>/events` with `META_CAPI_TOKEN`; `sendGoogle(events)` uploads click conversions via the existing Google Ads OAuth (`lib/google-ads.ts`), using `gclid` + hashed user identifiers (Enhanced Conversions for Leads), one conversion action per event type.
3. **Cron `/api/cron/conversions`** nightly, pg_cron job, plus a `?dry=1` that prints what would be sent and the match-key coverage.
4. **Ops hook**: the Ops webhook receiver (`/api/webhooks/ops`, `quote.paid`) writes the deposit/total onto the deal (or `ops_quotes`); the conversions job reads it from there. No direct coupling.
5. **Admin visibility**: a small card on the Meta analytics page: events sent last 7/30 days by type, match-key coverage (% with fbclid / fbp / email / phone), last error. Later: compare Meta-reported conversions with ours.

## What Kyle needs to provide

- Meta **Pixel (Dataset) ID** — Events Manager → the pixel → Settings. Public; fine in chat.
- Meta **Conversions API access token** — same Settings page → "Generate access token" (requires Business Manager admin). Store in Vercel as `META_CAPI_TOKEN`, never in chat or the repo.
- Google: confirm the existing Google Ads OAuth connection has the conversion upload scope; create the conversion actions (Lead (CRM), Contacted lead, Qualified lead, Deposit, Purchase) with "Import — from clicks" type, or let the job create them via API.
- Decide which Qualified-pipeline stages count as "qualified" for the `QualifiedLead` event (probably Warm + Hot, not Cold).

## Known data-quality items (from the Oct 7 audit)

- 835 of ~5,600 Meta clicks in 30 days carried an fbclid but **no UTMs** (untagged ads or placements). Doesn't block CAPI (fbclid is enough) but breaks per-campaign attribution on our side. Fix the URL parameters on every active ad in Ads Manager.
- UTM spelling drift: `meta/ads`, `facebook/paid`, `fb/paid`. Standardize on `utm_source=facebook&utm_medium=paid&utm_campaign={{campaign.id}}&utm_content={{ad.id}}` via a saved URL-parameter template.

## After launch

- Give Meta 2–3 weeks of events, then switch lead campaigns' optimization goal to `QualifiedLead` (or `Purchase` once volume allows; Meta wants ~50 events a week per ad set for stable learning).
- Watch Events Manager "Event match quality" and our coverage card; the lever for a low score is more hashed fields (phone, city/zip) and the `fbp` cookie.
- Consider value-based bidding with a predicted value from the AI profiler once there are enough paid events to calibrate it.
