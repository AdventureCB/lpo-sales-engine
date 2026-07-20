# LPO Sales Engine

Internal sales tooling for Lone Peak Overland: auto-dialer (Quo + Pipedrive),
engagement hot list (Klaviyo/Pipedrive/Shopify), activity tracking & $100/journey
commissions. Next.js on Vercel + Supabase (standalone project — NOT Trailhead's).

**Spec:** [docs/FRAMEWORK.md](docs/FRAMEWORK.md) — read first, top to bottom.
**Design source of truth:** [docs/ui-prototype.html](docs/ui-prototype.html) (v0.3, approved).

## Status

- [x] **Phase 0** — Next.js skeleton, Supabase schema + seeds, Shopify webhook
      (HMAC-verified), Quo webhook, identity matcher, cron wiring
- [ ] Phase 1 — call tracker + scoreboard (Quo webhooks live, nightly reconciliation)
- [ ] Phase 2 — hot list (15-min sweep, Klaviyo + Pipedrive signals)
- [ ] Phase 3 — dialer companion, T1 VM drop
- [ ] Phase 4 — journey engine + commissions, T2 auto VM drop

## Setup

1. Create the dedicated Supabase project; run `supabase/migrations/00001_init.sql`
   (via `supabase db push` or the SQL editor).
2. Copy `.env.example` → `.env.local` and fill keys (never commit them).
3. `npm install && npm run dev`
4. Deploy to Vercel; set the same env vars there. `vercel.json` registers the
   two cron jobs. Point Shopify webhooks (`orders/paid`, `orders/refunded`) at
   `/api/webhooks/shopify` and Quo webhooks at `/api/webhooks/quo`.
5. Check `/api/health` — it reports which env vars are present.

## Layout

- `app/api/webhooks/` — Shopify + Quo receivers (idempotent upserts)
- `app/api/cron/` — hot-list sweep + nightly call reconciliation (stubs until Phases 1–2)
- `lib/` — identity matcher, HMAC/signature verification, call classifier, Supabase client
- `supabase/migrations/` — schema + seed data (reps, queues, app config)
- `docs/` — handoff bundle: framework spec + UI prototype
