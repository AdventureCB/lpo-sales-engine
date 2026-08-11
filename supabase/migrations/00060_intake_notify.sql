-- Intake→notifications join needs a real FK for the embed; deal deletions
-- null it rather than dropping the audit row.
alter table intake_events
  add constraint intake_events_deal_fk foreign key (deal_id) references crm_deals (id) on delete set null;
