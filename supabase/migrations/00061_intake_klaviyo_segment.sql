-- Klaviyo SEGMENT intake adapter (Engaged CAI engines): same membership
-- watcher as lists, different Klaviyo endpoint.
alter table intake_sources drop constraint if exists intake_sources_adapter_check;
alter table intake_sources add constraint intake_sources_adapter_check
  check (adapter in ('shopify_abandoned_checkout', 'typeform', 'klaviyo_metric', 'klaviyo_list', 'klaviyo_segment', 'webhook'));
