-- Per-rep daily goals for the dialer momentum panel, editable in Settings.
alter table reps add column daily_dial_goal int not null default 50;
alter table reps add column daily_talk_goal_min int not null default 45;
