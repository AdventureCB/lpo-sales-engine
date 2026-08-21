-- NATIVE-FIRST (Kyle, 8/21): the phone ledger gains native crm_deals keys.
-- PD ids remain for mirror/outbox sync, but nothing may GATE on them —
-- native deals (pipedrive_deal_id null) were escaping attempts, cooldowns,
-- and inbound call→deal linking.

alter table call_events add column crm_deal_id uuid;
alter table dial_attempts add column crm_deal_id uuid;
alter table dial_attempts alter column deal_id drop not null;

create index idx_call_events_crm_deal on call_events (crm_deal_id, started_at desc);
create index idx_dial_attempts_crm_deal on dial_attempts (crm_deal_id, attempted_at desc);

-- Backfill from the mirror mapping.
update call_events ce
   set crm_deal_id = d.id
  from crm_deals d
 where ce.crm_deal_id is null
   and ce.deal_id is not null
   and d.pipedrive_deal_id = ce.deal_id;

update dial_attempts da
   set crm_deal_id = d.id
  from crm_deals d
 where da.crm_deal_id is null
   and d.pipedrive_deal_id = da.deal_id;
