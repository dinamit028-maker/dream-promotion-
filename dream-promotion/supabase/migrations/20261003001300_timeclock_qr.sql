-- ============================================================================
-- Migration 20261003001300 — time clock by QR at the business (toolbox stage 6, improvement)
--   timeclock_settings  per business: the QR site code (printed at the business), whether a scan is
--                       required, and an optional location lock (center + radius in meters)
--   time_entries.source  + 'qr'  (a shift stamped after scanning the business's code)
-- Owners manage their own settings (RLS); the employee page only reaches them through
-- /api/clock/<token>, which checks the code (and the location, when locked) on the server.
-- Idempotent. Rollback: drop table timeclock_settings (and restore the old source check).
-- ============================================================================
create table if not exists public.timeclock_settings (
  user_id      uuid primary key references auth.users on delete cascade,
  site_code    text unique check (site_code ~ '^[A-Za-z0-9_-]{16,64}$'),
  require_qr   boolean not null default true,
  geo_lat      double precision check (geo_lat between -90 and 90),
  geo_lng      double precision check (geo_lng between -180 and 180),
  geo_radius_m int not null default 150 check (geo_radius_m between 30 and 2000),
  updated_at   timestamptz not null default now()
);
alter table public.timeclock_settings enable row level security;
drop policy if exists timeclock_settings_own on public.timeclock_settings;
create policy timeclock_settings_own on public.timeclock_settings for all using (user_id = auth.uid()) with check (user_id = auth.uid());
drop trigger if exists touch_timeclock_settings on public.timeclock_settings;
create trigger touch_timeclock_settings before update on public.timeclock_settings
  for each row execute function public.touch_updated_at();

alter table public.time_entries drop constraint if exists time_entries_source_check;
alter table public.time_entries add constraint time_entries_source_check check (source in ('self','manual','qr'));
