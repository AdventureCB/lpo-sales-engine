-- AI taxonomy review: the critic proposes changes; a human approves each one
-- (nothing self-applies). One batch per review run.
create table if not exists taxonomy_proposals (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null,
  kind text not null check (kind in (
    'archetype_edit','archetype_add','archetype_retire',
    'attribute_edit','attribute_add','attribute_retire'
  )),
  target_key text,
  current jsonb,
  proposed jsonb not null default '{}'::jsonb,
  rationale text not null,
  evidence text,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_taxonomy_proposals_pending on taxonomy_proposals (status, created_at desc);
alter table taxonomy_proposals enable row level security;

-- Approved taxonomy change → bust OPEN deals' profile input hashes so the
-- 20-min background refresh re-derives them under the new taxonomy (pace
-- still governed by budget + debounce; closed-deal profiles stay frozen).
create or replace function public.bust_open_profile_hashes()
returns void language sql as $$
  update deal_profiles p
     set watermark = jsonb_set(coalesce(p.watermark, '{}'::jsonb), '{input_hash}',
                               to_jsonb('taxonomy:' || extract(epoch from now())::bigint::text)),
         status = 'stale'
  from crm_deals d
  where d.id = p.deal_id and d.status = 'open';
$$;
