-- Per-rep confirmation email template (Kyle 9/22): the confirmation sends from
-- the guide, so it reads in first person and each guide can make it their own.
-- {subject, body} with {{placeholders}}; null = team default (booking_config).
alter table reps add column if not exists booking_email jsonb;
