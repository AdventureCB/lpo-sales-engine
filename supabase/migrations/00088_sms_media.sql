-- MMS: attached media (urls + content types) per message, outbound and inbound.
alter table sms_messages add column if not exists media jsonb;
