-- Store the full webhook/API payload per Typeform submission. The slim
-- columns proved too slim: when the form's contact block changed shape
-- (opt-in edit 8/8) we had no way to see what actually arrived.
alter table typeform_submissions add column if not exists raw jsonb;
