-- Ops contract v2 (Ops reply 11/16 + Kyle's decisions): Ops' own quote
-- vocabulary and the enrichments they offered, plus credit review at first
-- payment and the owner-mismatch flag.
alter table ops_quotes add column if not exists ops_stage text;            -- started|sent|invoice_out|deposit_paid|paid|additions_owed|expired|deleted|cancelled
alter table ops_quotes add column if not exists subtotal_cents bigint;
alter table ops_quotes add column if not exists balance_cents bigint;
alter table ops_quotes add column if not exists refunded_cents bigint not null default 0;
alter table ops_quotes add column if not exists expires_at date;
alter table ops_quotes add column if not exists balance_due_on date;
alter table ops_quotes add column if not exists eta_label text;
alter table ops_quotes add column if not exists build jsonb;             -- {truck, handover{name,kind}, options[{sku,name,qty}], revision}
alter table ops_quotes add column if not exists rep jsonb;               -- Ops' rep on the quote {name, email}
alter table ops_quotes add column if not exists owner_mismatch jsonb;    -- {ops_rep, deal_owner, at} while they disagree before payment
alter table ops_quotes add column if not exists credit_review jsonb;     -- {status: pending|approved|flagged, ops_rep, deal_owner, at, by, note}
alter table ops_quotes add column if not exists attention jsonb;         -- {kind: {open, detail, at}}
alter table ops_quotes add column if not exists install jsonb;           -- {day, time, booked_by, moved}
alter table ops_quotes add column if not exists website_submission_id text;
alter table ops_quotes add column if not exists sent_at timestamptz;     -- first time the quote was emailed (Ops owns follow-up from here)
alter table ops_quotes add column if not exists cancelled_at timestamptz;
