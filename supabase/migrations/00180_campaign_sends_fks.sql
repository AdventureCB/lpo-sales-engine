-- campaign_sends had no FKs to crm_deals / crm_contacts, so the Outbox's
-- PostgREST embeds (crm_deals(...), crm_contacts(...)) failed → HTTP 500.
alter table campaign_sends drop constraint if exists campaign_sends_deal_id_fkey;
alter table campaign_sends add constraint campaign_sends_deal_id_fkey foreign key (deal_id) references crm_deals(id) on delete cascade;
alter table campaign_sends drop constraint if exists campaign_sends_contact_id_fkey;
alter table campaign_sends add constraint campaign_sends_contact_id_fkey foreign key (contact_id) references crm_contacts(id) on delete set null;
notify pgrst, 'reload schema';
