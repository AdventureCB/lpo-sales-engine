-- Booking types (Kyle 9/22): Gravel Guide call / confirm your order / showroom
-- appointment. Each type gets its own confirmation template (team default +
-- per-guide override, stored as a {kind: template} map in booking_email /
-- booking_config.confirmations).
alter table bookings add column if not exists kind text not null default 'call';
alter table bookings drop constraint if exists bookings_kind_check;
alter table bookings add constraint bookings_kind_check check (kind in ('call', 'confirm', 'showroom'));
