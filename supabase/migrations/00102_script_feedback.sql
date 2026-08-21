-- Script feedback joins the draft loop: call-script generations + 👎 land in
-- the same draft_events ledger, and style rules gain a 'call' channel so the
-- one existing critic/approval queue can tune call outlines too.

alter table draft_events drop constraint draft_events_kind_check;
alter table draft_events add constraint draft_events_kind_check
  check (kind in ('email','sms','call'));

alter table draft_style_rules drop constraint draft_style_rules_channel_check;
alter table draft_style_rules add constraint draft_style_rules_channel_check
  check (channel in ('all','email','sms','call'));
