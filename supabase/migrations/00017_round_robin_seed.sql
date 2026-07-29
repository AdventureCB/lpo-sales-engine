-- The flagship builder-save automation now distributes deals round-robin
-- between the sales reps (extend owner_pool to add reps later).

update crm_automations
set actions = '[{
  "type": "create_deal",
  "title_template": "Saved Build - {{contact.name}}",
  "pipedrive_stage_id": 44,
  "enrich_phone_from_klaviyo": true,
  "owner_strategy": "round_robin",
  "owner_pool": [24081760, 24391245]
}]'::jsonb
where name like '3D Builder save%';
