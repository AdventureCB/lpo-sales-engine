-- Staged goals: optional bonus (stretch) dial goal per rep. NULL = derived
-- as 1.5× the min goal. The streak stays tied to the MIN goal.
alter table reps add column bonus_dial_goal int;
