-- Manual sprint-list snooze: deal is excluded from ALL list generation until
-- this date (rep-set from the deal page Actions card). Null = not snoozed.
alter table crm_deals add column if not exists sprint_snooze_until date;
