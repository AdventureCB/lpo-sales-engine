-- Inbound texts carry no userId; attribute them to the receiving line so
-- personal-line texts credit their rep. Shared-line inbound stays unattributed.

alter table message_events add column phone_number_id text;
