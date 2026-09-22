-- Reps manage their own booking availability (Kyle 9/22): per-rep override of
-- the team defaults — weekdays, start/end (Pacific) and days off — stored as
-- {days?, start?, end?, blocked?: ['YYYY-MM-DD', …]}. Null = team default.
alter table reps add column if not exists booking_hours jsonb;
