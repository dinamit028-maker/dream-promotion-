-- ============================================================================
-- Migration 20261003001000 — appointment booking (toolbox stage 2)
--   booking_settings  one row per business: public page slug, opening hours, rules
--   booking_services  what can be booked (name, duration, price)
--   appointments      the bookings; a database constraint makes double-booking impossible,
--                     even when two customers press "book" at the same second
-- Owners manage their own rows (RLS). The public booking page never touches these tables from the
-- browser: it goes through /api/book/*, which validates every request on the server.
-- Idempotent. Rollback: drop table appointments, booking_services, booking_settings.
-- ============================================================================
create extension if not exists btree_gist;

create table if not exists public.booking_settings (
  user_id            uuid primary key references auth.users on delete cascade,
  slug               text unique check (slug ~ '^[a-z0-9][a-z0-9-]{2,40}$'),
  enabled            boolean not null default false,
  title              text not null default '',
  address            text not null default '',
  phone              text not null default '',
  message            text not null default '',
  slot_minutes       int  not null default 30 check (slot_minutes in (10,15,20,30,45,60)),
  min_notice_minutes int  not null default 120 check (min_notice_minutes between 0 and 10080),
  max_days_ahead     int  not null default 30 check (max_days_ahead between 1 and 180),
  -- {"0":[["09:00","19:00"]], "5":[["09:00","13:00"]], …}   0 = Sunday; missing day = closed
  hours              jsonb not null default '{"0":[["09:00","19:00"]],"1":[["09:00","19:00"]],"2":[["09:00","19:00"]],"3":[["09:00","19:00"]],"4":[["09:00","19:00"]]}'::jsonb,
  closed_dates       date[] not null default '{}',
  updated_at         timestamptz not null default now()
);

create table if not exists public.booking_services (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users on delete cascade,
  name       text not null check (length(name) between 1 and 80),
  minutes    int  not null default 30 check (minutes between 5 and 480),
  price      numeric(10,2),
  active     boolean not null default true,
  sort       int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists booking_services_user_idx on public.booking_services (user_id, sort);

create table if not exists public.appointments (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users on delete cascade,
  service_id  uuid references public.booking_services on delete set null,
  lead_id     uuid references public.leads on delete set null,
  service_name text not null default '',
  name        text not null check (length(name) between 1 and 80),
  phone       text not null default '',
  email       text not null default '',
  note        text not null default '',
  start_at    timestamptz not null,
  end_at      timestamptz not null check (end_at > start_at),
  status      text not null default 'booked' check (status in ('booked','confirmed','done','no_show','cancelled')),
  source      text not null default 'manual' check (source in ('public','manual')),
  created_at  timestamptz not null default now(),
  -- no two active appointments of the same business may overlap
  constraint appointments_no_overlap exclude using gist (
    user_id with =, tstzrange(start_at, end_at, '[)') with &&
  ) where (status in ('booked','confirmed'))
);
create index if not exists appointments_user_start_idx on public.appointments (user_id, start_at);

alter table public.booking_settings enable row level security;
alter table public.booking_services enable row level security;
alter table public.appointments     enable row level security;
drop policy if exists booking_settings_own on public.booking_settings;
create policy booking_settings_own on public.booking_settings for all using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists booking_services_own on public.booking_services;
create policy booking_services_own on public.booking_services for all using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists appointments_own on public.appointments;
create policy appointments_own on public.appointments for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop trigger if exists touch_booking_settings on public.booking_settings;
create trigger touch_booking_settings before update on public.booking_settings
  for each row execute function public.touch_updated_at();
