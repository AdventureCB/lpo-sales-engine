-- Supabase advisor 10/11: google_click_map had RLS off. Same posture as every
-- public table: RLS on, no policies → service role only (anon key is auth-only).
alter table google_click_map enable row level security;
