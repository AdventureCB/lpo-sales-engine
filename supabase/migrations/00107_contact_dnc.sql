-- Do-Not-Contact flag (lost-flow category "DNC — asked not to contact").
-- Respected system-wide: intake engines skip DNC contacts entirely, sprint
-- list generation and dialer queues exclude their deals.

alter table crm_contacts add column dnc boolean not null default false;
