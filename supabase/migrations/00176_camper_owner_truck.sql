-- Demo Finder shows the truck the camper rides on (Kyle 10/16). Derived at
-- sync time from the camper line's Shopify variant title (V2: "Ford / F150
-- 2021+ 6'5") or, for V1 / older orders, the build-form answers in the order
-- note ("Truck Make … Toyota / Truck Model … Tacoma / Model Year … 2016-2023 / Bed 6'").
alter table camper_owners add column if not exists truck text;
