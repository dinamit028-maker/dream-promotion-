-- ============================================================================
-- Migration 20261003001800 — close of day in the register (additive only)
--   register_shifts  one row per business day: cash in the drawer at opening, and at closing
--                    the counted cash, the expected cash (computed by tested code) and the difference
-- RLS: own rows only. Idempotent. Rollback: drop table register_shifts.
-- ============================================================================
create table if not exists public.register_shifts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users on delete cascade,
  opened_at     timestamptz not null default now(),
  opening_cash  numeric(12,2) not null default 0 check (opening_cash >= 0),
  closed_at     timestamptz,
  counted_cash  numeric(12,2) check (counted_cash >= 0),
  expected_cash numeric(12,2),
  difference    numeric(12,2),
  note          text not null default '',
  employee_name text not null default '',
  check (closed_at is null or (closed_at >= opened_at and counted_cash is not null and expected_cash is not null and difference is not null))
);
create index if not exists register_shifts_user_opened_idx on public.register_shifts (user_id, opened_at desc);
-- at most one open day per business
create unique index if not exists register_shifts_one_open_idx on public.register_shifts (user_id) where closed_at is null;

alter table public.register_shifts enable row level security;
drop policy if exists register_shifts_own on public.register_shifts;
create policy register_shifts_own on public.register_shifts for all using (user_id = auth.uid()) with check (user_id = auth.uid());
