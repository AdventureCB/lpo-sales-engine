-- Booking self-service (Kyle 9/22): a per-booking token backs the public
-- cancel / reschedule link in the customer's confirmation email.
alter table bookings add column if not exists cancel_token text;
alter table bookings add column if not exists cancelled_at timestamptz;
alter table bookings add column if not exists cancel_reason text;
alter table bookings add column if not exists rescheduled_to uuid;
create unique index if not exists bookings_cancel_token_uniq on bookings (cancel_token) where cancel_token is not null;
