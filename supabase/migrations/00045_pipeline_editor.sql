-- Helpers for the pipeline/stage editor's delete-safety checks.
create or replace function stage_deal_counts()
returns table(stage_id uuid, n bigint)
language sql stable as $$
  select stage_id, count(*) from crm_deals where stage_id is not null group by stage_id
$$;

create or replace function pipeline_deal_count(p_pipeline uuid)
returns bigint
language sql stable as $$
  select count(*)
  from crm_deals d
  join crm_stages s on s.id = d.stage_id
  where s.pipeline_id = p_pipeline
$$;
