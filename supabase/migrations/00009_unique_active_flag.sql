-- Concurrent sweeps (overlapping crons, manual triggers) raced and produced
-- duplicate active flags + duplicate Pipedrive tasks. Dedupe, then enforce
-- one active flag per deal at the database level.

delete from hot_flags a
using hot_flags b
where a.deal_id = b.deal_id
  and a.cleared_at is null
  and b.cleared_at is null
  and a.flagged_at > b.flagged_at;

create unique index uniq_hot_flags_active on hot_flags (deal_id) where cleared_at is null;
