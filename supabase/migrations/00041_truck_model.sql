-- Truck model per deal: mirrored from Pipedrive's custom field, suggested
-- from Klaviyo profiles, and manually editable when gathered on a call.
alter table crm_deals add column truck_model text;
alter table klaviyo_profiles add column truck_model text;
