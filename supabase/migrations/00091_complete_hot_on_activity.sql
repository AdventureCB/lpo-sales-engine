-- Hot-signal tasks ("Hot: <reason> — call today", created by the hot-list
-- sweep) auto-complete the moment the rep works the deal — any new activity
-- authored by a human (manual log, dialer note/next-step, sent email/text,
-- Quo/PD-mirrored call) on that deal marks pending Hot: tasks done and queues
-- the Pipedrive-side completion via the outbox.
--
-- Guards: automation/engine rows (actor without '@') don't count, inbound
-- messages don't count, a Hot: task can't complete itself, and only fresh
-- activity (occurred_at within 2 days) counts so historic backfills can't
-- mass-complete open tasks.

create or replace function public.trg_complete_hot_on_activity()
returns trigger language plpgsql as $$
declare
  r record;
begin
  if new.actor is null or position('@' in new.actor) = 0 then return new; end if;
  if coalesce(new.meta->>'direction', '') = 'inbound' then return new; end if;
  if new.subject ilike 'hot:%' then return new; end if;
  if new.occurred_at is null or new.occurred_at < now() - interval '2 days' then return new; end if;

  for r in
    update crm_activities a
       set done_at = now()
     where a.done_at is null
       and a.due_at is not null
       and a.subject ilike 'hot:%'
       and a.id <> new.id
       and (
         (new.deal_id is not null and a.deal_id = new.deal_id)
         or (new.deal_id is null and new.contact_id is not null
             and a.deal_id in (select id from crm_deals where contact_id = new.contact_id))
       )
    returning a.pipedrive_activity_id
  loop
    if r.pipedrive_activity_id is not null then
      insert into pd_sync_queue (kind, payload)
      values ('activity_done', jsonb_build_object('pipedriveActivityId', r.pipedrive_activity_id));
    end if;
  end loop;
  return new;
end $$;

drop trigger if exists complete_hot_on_activity on crm_activities;
create trigger complete_hot_on_activity
  after insert on crm_activities
  for each row execute function public.trg_complete_hot_on_activity();
