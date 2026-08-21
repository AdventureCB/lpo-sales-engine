-- Native-first pool leases: dial_leases re-keys on crm_deals.id (every
-- QueueLead carries crmDealId since the mirror flip; PD deal_id becomes an
-- informational rider). Leases are minutes-lived, so restructuring in place
-- after pruning is safe.

delete from dial_leases where expires_at < now();

alter table dial_leases drop constraint dial_leases_pkey;
alter table dial_leases alter column deal_id drop not null;
alter table dial_leases add column crm_deal_id uuid;

update dial_leases dl
   set crm_deal_id = d.id
  from crm_deals d
 where d.pipedrive_deal_id = dl.deal_id;

-- Live leases that no longer map to a mirror deal are unprotectable — drop.
delete from dial_leases where crm_deal_id is null;

alter table dial_leases add primary key (crm_deal_id);
