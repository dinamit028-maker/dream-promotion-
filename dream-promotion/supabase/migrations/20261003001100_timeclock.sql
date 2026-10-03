-- ============================================================================
-- Migration 20261003001100 — employee time clock (toolbox stage 6)
--   employees     the business's employees; each has a private clock link (random token)
--   time_entries  one row per shift: clock_in, clock_out (null while working), optional location
-- An employee can have only one open shift (partial unique index). Times always come from the
-- server. Owners manage their own rows (RLS); employees reach their page only through
-- /api/clock/<token>, validated on the server. Idempotent.
-- Rollback: drop table time_entries, employees.
-- ============================================================================
create table if not exists public.employees (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users on delete cascade,
  name        text not null check (length(name) between 1 and 80),
  phone       text not null default '',
  hourly_rate numeric(8,2),
  active      boolean not null default true,
  token       text not null unique check (length(token) >= 20),
  created_at  timestamptz not null default now()
);
create index if not exists employees_user_idx on public.employees (user_id, created_at);

create table if not exists public.time_entries (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users on delete cascade,
  employee_id uuid not null references public.employees on delete cascade,
  clock_in    timestamptz not null,
  clock_out   timestamptz check (clock_out is null or clock_out > clock_in),
  in_lat double precision, in_lng double precision, out_lat double precision, out_lng double precision,
  note        text not null default '',
  source      text not null default 'self' check (source in ('self','manual')),
  edited      boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists time_entries_user_in_idx on public.time_entries (user_id, clock_in desc);
create index if not exists time_entries_emp_in_idx on public.time_entries (employee_id, clock_in desc);
-- at most one open shift per employee
create unique index if not exists time_entries_one_open on public.time_entries (employee_id) where clock_out is null;

alter table public.employees    enable row level security;
alter table public.time_entries enable row level security;
drop policy if exists employees_own on public.employees;
create policy employees_own on public.employees for all using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists time_entries_own on public.time_entries;
create policy time_entries_own on public.time_entries for all using (user_id = auth.uid()) with check (user_id = auth.uid());
