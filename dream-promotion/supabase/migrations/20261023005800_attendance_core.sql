-- ============================================================================================================================
-- Migration 20261023005800 — "נוכחות ועובדים" as a module of its own, stage 1 (docs/ATTENDANCE_PLAN_HE.md; 2.107.0).
-- Prepared only: NOT applied to the live database (needs the owner's explicit approval; the SQL Editor). Additions only — no
-- existing row is changed. Runs after 20261003001100 / 1300 (the clock), 20261004003000 (access) and 20261005003200 (can_write):
-- it stops at the top without them, changing nothing.
--
-- The rules this file makes the database keep (not only the screens):
--   1. a time entry is never deleted, and never rewritten. The only two moves an entry may make: an open shift gets its clock-out
--      (once), or the entry is voided (once, with a reason). A manager's correction = the old entry voided + a NEW entry that
--      says which one it replaces (time_entries.replaces). Every insert / clock-out / void is in time_entry_events (a trigger —
--      who, when, before, after, the reason). An app user writes entries only through the att_* functions (the reason required);
--      the employee's clock (the server, /api/clock/<token>) clocks in and out exactly as before.
--   2. a closed month is locked: no entry, absence or request of that employee in that month is written until a manager reopens
--      it, with a reason (attendance_month_events). A month closes only after it has ended, and only without an open shift or a
--      pending request / absence in it.
--   3. nothing of the attendance tables is deleted (att_no_delete — also on a cascade); people are archived (employees.active,
--      end_date), the rest is cancelled / voided.
--   4. who sees what (att_role): the owner and the editors (and the super admin) = admin; a member marked by the super admin as
--      'approver' sees and approves only the employees given to them (attendance_approvers); 'payroll' (the accountant) reads
--      everything, writes nothing; a viewer reads; a cashier — nothing (as before). The ID number and the pay of an employee are
--      in employee_private — admin and payroll only.
--   5. modules: businesses.modules ('dream', 'attendance'). Every business keeps both (the default) — nothing changes for anyone.
--      A business that bought only attendance = {attendance}: the app shows it the attendance module only. Only the super admin
--      changes it (the businesses table — as before).
-- Tested on a local Postgres: tests/sql/attendance-core.check.sql. The rollback is at the end.
-- ============================================================================================================================

-- ---- 0. after the clock, access and can_write ---------------------------------------------------------------------------------
do $$ begin
  if to_regclass('public.time_entries') is null or to_regclass('public.timeclock_settings') is null
     or to_regprocedure('public.my_access()') is null or to_regprocedure('public.can_write()') is null
     or to_regprocedure('public.current_business_id()') is null then
    raise exception 'migration 20261023005800 runs after 20261003001100, 20261003001300, 20261004003000 and 20261005003200 — run them first; nothing was changed';
  end if;
end $$;

-- ---- 1. modules -----------------------------------------------------------------------------------------------------------------
alter table public.businesses add column if not exists modules text[] not null default array['dream', 'attendance'];
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'businesses_modules_check') then
    alter table public.businesses add constraint businesses_modules_check
      check (cardinality(modules) between 1 and 2 and modules <@ array['dream', 'attendance']);
  end if;
end $$;

-- does the business worked in now have this module?
create or replace function public.has_module(p_module text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select p_module = any (b.modules) from public.businesses b where b.id = public.current_business_id()), false);
$$;
revoke execute on function public.has_module(text) from public, anon;
grant execute on function public.has_module(text) to authenticated, service_role;

-- ---- 2. who is who in attendance ------------------------------------------------------------------------------------------------
alter table public.business_members add column if not exists attendance_role text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'business_members_attendance_role_check') then
    alter table public.business_members add constraint business_members_attendance_role_check
      check (attendance_role is null or attendance_role in ('admin', 'approver', 'payroll'));
  end if;
end $$;

-- the caller's part in the attendance of the business worked in now: admin | approver | payroll | viewer | none
create or replace function public.att_role() returns text
language sql stable security definer set search_path = public as $$
  select case when public.is_super_admin() then 'admin' else coalesce((
    select case when m.access = 'register' then 'none'
                when m.attendance_role is not null then m.attendance_role
                when m.role in ('owner', 'editor') then 'admin'
                else 'viewer' end
      from public.business_members m
     where m.user_id = auth.uid() and m.business_id = public.current_business_id()
       and public.business_is_active(m.business_id)), 'none') end;
$$;
revoke execute on function public.att_role() from public, anon;
grant execute on function public.att_role() to authenticated, service_role;

-- ---- 3. departments, hour tracks, approvers -------------------------------------------------------------------------------------
create table if not exists public.departments (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses on delete restrict,
  name        text not null check (length(btrim(name)) between 1 and 60),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (id, business_id)
);
create unique index if not exists departments_name_uq on public.departments (business_id, lower(btrim(name))) where active;

-- an hour track ("מסלול שעות תקן"): the standard minutes of each weekday, Sunday first (516 = 8.6 hours; 0 = not a work day)
create table if not exists public.work_tracks (
  id                   uuid primary key default gen_random_uuid(),
  business_id          uuid not null references public.businesses on delete restrict,
  name                 text not null check (length(btrim(name)) between 1 and 60),
  day_minutes          int[] not null default array[516, 516, 516, 516, 516, 0, 0]
                         check (array_length(day_minutes, 1) = 7 and 0 <= all (day_minutes) and 1440 >= all (day_minutes)),
  start_time           time,                                   -- the expected start (for "late"); null = not tracked
  late_grace_min       int not null default 0 check (late_grace_min between 0 and 240),
  -- an unpaid break taken off a day that is at least auto_break_after_min long (0 / 0 = none — the default; the employer's button)
  auto_break_min       int not null default 0 check (auto_break_min between 0 and 180),
  auto_break_after_min int not null default 0 check (auto_break_after_min between 0 and 1440),
  active               boolean not null default true,
  created_at           timestamptz not null default now(),
  unique (id, business_id)
);
-- the contract's overtime rules (the owner of the system, 23.10.2026: every employer sets their own; the defaults are the law's
-- and the owner's): the threshold — by day (the day's standard above) or by month; then tier 1 (125% for 2 hours), then tier 2
-- (150%); the weekly rest day, a festival, Independence Day and the eve of a festival. The employer confirms the rules
-- (rules_confirmed_at) — any change of a rule takes the confirmation away (b_att_track_rules); until then overtime is a draft and
-- a month of the track's employees does not close. src/features/attendance/overtime-rules.ts reads the same columns (rulesOf).
alter table public.work_tracks add column if not exists ot_mode text not null default 'daily';
alter table public.work_tracks add column if not exists monthly_minutes int;
alter table public.work_tracks add column if not exists monthly_tier1_minutes int;
alter table public.work_tracks add column if not exists tier1_minutes int not null default 120;
alter table public.work_tracks add column if not exists tier1_pct int not null default 125;
alter table public.work_tracks add column if not exists tier2_pct int not null default 150;
alter table public.work_tracks add column if not exists rest_weekday int not null default 6;
alter table public.work_tracks add column if not exists rest_pct int not null default 150;
alter table public.work_tracks add column if not exists rest_tier1_pct int not null default 175;
alter table public.work_tracks add column if not exists rest_tier2_pct int not null default 200;
alter table public.work_tracks add column if not exists festival_pct int not null default 150;
alter table public.work_tracks add column if not exists independence_rest boolean not null default true;
alter table public.work_tracks add column if not exists independence_pct int not null default 200;
alter table public.work_tracks add column if not exists eve_minutes int;
alter table public.work_tracks add column if not exists rules_confirmed_at timestamptz;
alter table public.work_tracks add column if not exists rules_confirmed_by uuid references auth.users on delete set null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'work_tracks_rules_check') then
    alter table public.work_tracks add constraint work_tracks_rules_check check (
      ot_mode in ('daily', 'monthly')
      and (ot_mode = 'daily' or (monthly_minutes is not null and monthly_tier1_minutes is not null
                               and monthly_minutes between 60 and 44640 and monthly_tier1_minutes between 0 and 44640))
      and tier1_minutes between 0 and 1440 and rest_weekday between 0 and 6 and (eve_minutes is null or eve_minutes between 0 and 1440)
      and 100 <= all (array[tier1_pct, tier2_pct, rest_pct, rest_tier1_pct, rest_tier2_pct, festival_pct, independence_pct])
      and 400 >= all (array[tier1_pct, tier2_pct, rest_pct, rest_tier1_pct, rest_tier2_pct, festival_pct, independence_pct]));
  end if;
end $$;

-- a rule changed = not confirmed any more; a confirmation is the caller's, now
create or replace function public.att_track_rules() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' and (new.day_minutes, new.auto_break_min, new.auto_break_after_min, new.ot_mode, new.monthly_minutes, new.monthly_tier1_minutes,
      new.tier1_minutes, new.tier1_pct, new.tier2_pct, new.rest_weekday, new.rest_pct, new.rest_tier1_pct, new.rest_tier2_pct, new.festival_pct,
      new.independence_rest, new.independence_pct, new.eve_minutes)
     is distinct from (old.day_minutes, old.auto_break_min, old.auto_break_after_min, old.ot_mode, old.monthly_minutes, old.monthly_tier1_minutes,
      old.tier1_minutes, old.tier1_pct, old.tier2_pct, old.rest_weekday, old.rest_pct, old.rest_tier1_pct, old.rest_tier2_pct, old.festival_pct,
      old.independence_rest, old.independence_pct, old.eve_minutes)
     and new.rules_confirmed_at is not distinct from old.rules_confirmed_at then
    new.rules_confirmed_at := null; new.rules_confirmed_by := null;
  end if;
  if new.rules_confirmed_at is not null and (tg_op = 'INSERT' or new.rules_confirmed_at is distinct from old.rules_confirmed_at) then
    new.rules_confirmed_at := now(); new.rules_confirmed_by := auth.uid();
  end if;
  return new;
end $$;
revoke execute on function public.att_track_rules() from public, anon, authenticated;
drop trigger if exists b_att_track_rules on public.work_tracks;
create trigger b_att_track_rules before insert or update on public.work_tracks for each row execute function public.att_track_rules();

-- exports of hours as PDF only (the owner of the system, 23.10.2026: nobody changes hours outside the documented correction)
alter table public.timeclock_settings add column if not exists exports_pdf_only boolean not null default true;

-- ---- 4. employees: the reference's fields (all optional — existing rows stay as they are) -----------------------------------------
alter table public.employees add column if not exists employee_code text not null default '';
alter table public.employees add column if not exists department_id uuid;
alter table public.employees add column if not exists title text not null default '';
alter table public.employees add column if not exists track_id uuid;
alter table public.employees add column if not exists start_date date;
alter table public.employees add column if not exists end_date date;
alter table public.employees add column if not exists last_active_at timestamptz;
alter table public.employees add column if not exists invited_at timestamptz;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'employees_code_check') then
    alter table public.employees add constraint employees_code_check check (length(employee_code) <= 20 and employee_code = btrim(employee_code));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'employees_title_check') then
    alter table public.employees add constraint employees_title_check check (length(title) <= 60);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'employees_dates_check') then
    alter table public.employees add constraint employees_dates_check check (end_date is null or start_date is null or end_date >= start_date);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'employees_department_fkey') then
    alter table public.employees add constraint employees_department_fkey foreign key (department_id, business_id) references public.departments (id, business_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'employees_track_fkey') then
    alter table public.employees add constraint employees_track_fkey foreign key (track_id, business_id) references public.work_tracks (id, business_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'employees_id_business_key') then
    alter table public.employees add constraint employees_id_business_key unique (id, business_id);
  end if;
end $$;
create unique index if not exists employees_code_uq on public.employees (business_id, employee_code) where employee_code <> '';

-- the private part: ID number and pay — the admin and payroll only (never in the employees table, which the team reads)
create table if not exists public.employee_private (
  employee_id    uuid primary key,
  business_id    uuid not null references public.businesses on delete restrict,
  id_number      text not null default '' check (id_number = '' or id_number ~ '^[0-9]{9}$'),
  pay_kind       text not null default '' check (pay_kind in ('', 'hourly', 'monthly')),
  hourly_agorot  int check (hourly_agorot is null or hourly_agorot between 0 and 100000000),
  monthly_agorot int check (monthly_agorot is null or monthly_agorot between 0 and 1000000000),
  updated_at     timestamptz not null default now(),
  updated_by     uuid references auth.users on delete set null,
  foreign key (employee_id, business_id) references public.employees (id, business_id)
);

-- who approves whom: a department or one employee → a member of the business
create table if not exists public.attendance_approvers (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references public.businesses on delete restrict,
  approver_user_id uuid not null references auth.users on delete restrict,
  department_id    uuid,
  employee_id      uuid,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users on delete set null,
  check (num_nonnulls(department_id, employee_id) = 1),
  foreign key (department_id, business_id) references public.departments (id, business_id),
  foreign key (employee_id, business_id) references public.employees (id, business_id)
);
create unique index if not exists attendance_approvers_uq on public.attendance_approvers
  (business_id, approver_user_id, coalesce(department_id, employee_id)) where active;

-- does the caller approve this employee (directly, or by the department)?
create or replace function public.att_approves(p_employee uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.attendance_approvers a join public.employees e on e.id = p_employee and e.business_id = a.business_id
                  where a.active and a.approver_user_id = auth.uid() and a.business_id = public.current_business_id()
                    and (a.employee_id = e.id or (a.department_id is not null and a.department_id = e.department_id)));
$$;
-- may the caller see this employee's attendance? manage it (correct, approve)?
create or replace function public.att_sees(p_employee uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select case public.att_role() when 'admin' then true when 'payroll' then true when 'viewer' then true
                                 when 'approver' then public.att_approves(p_employee) else false end;
$$;
create or replace function public.att_manages(p_employee uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select case public.att_role() when 'admin' then true when 'approver' then public.att_approves(p_employee) else false end;
$$;
revoke execute on function public.att_approves(uuid), public.att_sees(uuid), public.att_manages(uuid) from public, anon;
grant execute on function public.att_approves(uuid), public.att_sees(uuid), public.att_manages(uuid) to authenticated, service_role;

-- ---- 5. time entries: how, what it replaces, voided -------------------------------------------------------------------------------
alter table public.time_entries add column if not exists method text;
alter table public.time_entries add column if not exists out_method text;
alter table public.time_entries add column if not exists replaces uuid references public.time_entries on delete restrict;
alter table public.time_entries add column if not exists voided_at timestamptz;
alter table public.time_entries add column if not exists voided_by uuid references auth.users on delete set null;
alter table public.time_entries add column if not exists void_reason text not null default '';
alter table public.time_entries add column if not exists created_by uuid references auth.users on delete set null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'time_entries_method_check') then
    alter table public.time_entries add constraint time_entries_method_check
      check ((method is null or method in ('link', 'qr', 'nfc', 'gps', 'manual', 'request', 'import'))
         and (out_method is null or out_method in ('link', 'qr', 'nfc', 'gps', 'manual', 'request', 'import')));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'time_entries_void_check') then
    alter table public.time_entries add constraint time_entries_void_check
      check (voided_at is null or (length(btrim(void_reason)) between 2 and 300));
  end if;
end $$;
create unique index if not exists time_entries_replaces_uq on public.time_entries (replaces) where replaces is not null;
create index if not exists time_entries_business_in_idx on public.time_entries (business_id, clock_in);

-- ---- 6. requests, absences, months ----------------------------------------------------------------------------------------------
-- an employee's request to complete a report (the clock — stage 2 — or the server): waits for a manager
create table if not exists public.time_requests (
  id             uuid primary key,                                   -- set by the caller: a retry is the same request
  business_id    uuid not null references public.businesses on delete restrict,
  employee_id    uuid not null,
  kind           text not null check (kind in ('missing_in', 'missing_out', 'shift', 'fix')),
  entry_id       uuid references public.time_entries on delete restrict,
  clock_in       timestamptz,
  clock_out      timestamptz,
  note           text not null default '' check (length(note) <= 300),
  status         text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by     uuid references auth.users on delete set null,
  decided_at     timestamptz,
  decision_note  text not null default '' check (length(decision_note) <= 300),
  result_entry_id uuid references public.time_entries on delete restrict,
  created_at     timestamptz not null default now(),
  foreign key (employee_id, business_id) references public.employees (id, business_id),
  check (clock_out is null or clock_in is null or clock_out > clock_in),
  check ((kind = 'missing_out' and entry_id is not null and clock_out is not null)
      or (kind in ('missing_in', 'shift') and entry_id is null and clock_in is not null and clock_out is not null)
      or (kind = 'fix' and entry_id is not null and clock_in is not null and clock_out is not null))
);
create index if not exists time_requests_business_idx on public.time_requests (business_id, status, created_at);

create table if not exists public.absences (
  id            uuid primary key,                                    -- set by the caller
  business_id   uuid not null references public.businesses on delete restrict,
  employee_id   uuid not null,
  kind          text not null check (kind in ('vacation', 'sick', 'reserve', 'other')),
  from_day      date not null,
  to_day        date not null,
  minutes       int check (minutes is null or minutes between 1 and 1440),   -- null = whole days; else part of one day
  note          text not null default '' check (length(note) <= 300),
  file_path     text not null default '' check (length(file_path) <= 300),  -- a sick note in the private attendance-files bucket
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  requested_by  text not null default 'manager' check (requested_by in ('employee', 'manager')),
  decided_by    uuid references auth.users on delete set null,
  decided_at    timestamptz,
  decision_note text not null default '' check (length(decision_note) <= 300),
  created_by    uuid references auth.users on delete set null,
  created_at    timestamptz not null default now(),
  foreign key (employee_id, business_id) references public.employees (id, business_id),
  check (to_day >= from_day and to_day - from_day <= 366),
  check (minutes is null or from_day = to_day)
);
create index if not exists absences_business_idx on public.absences (business_id, from_day);
create index if not exists absences_employee_idx on public.absences (employee_id, from_day);

create table if not exists public.attendance_months (
  employee_id  uuid not null,
  month        text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  business_id  uuid not null references public.businesses on delete restrict,
  status       text not null default 'open' check (status in ('open', 'approved', 'closed')),
  approved_by  uuid references auth.users on delete set null,
  approved_at  timestamptz,
  closed_by    uuid references auth.users on delete set null,
  closed_at    timestamptz,
  -- the hours track the month was closed with (a later change of the track does not change a closed month)
  rules_snapshot jsonb,
  updated_at   timestamptz not null default now(),
  primary key (employee_id, month),
  foreign key (employee_id, business_id) references public.employees (id, business_id)
);
alter table public.attendance_months add column if not exists rules_snapshot jsonb;
create index if not exists attendance_months_business_idx on public.attendance_months (business_id, month);

create table if not exists public.attendance_month_events (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses on delete restrict,
  employee_id uuid not null,
  month       text not null,
  kind        text not null check (kind in ('approved', 'closed', 'reopened')),
  reason      text not null default '',
  actor       uuid references auth.users on delete set null,
  actor_name  text not null default '',
  at          timestamptz not null default clock_timestamp()
);
create index if not exists attendance_month_events_idx on public.attendance_month_events (employee_id, month, at);

-- the history of every entry (trigger only)
create table if not exists public.time_entry_events (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses on delete restrict,
  employee_id uuid not null,
  entry_id    uuid not null references public.time_entries on delete restrict,
  at          timestamptz not null default clock_timestamp(),
  actor       uuid references auth.users on delete set null,          -- null = the employee's clock (the server)
  actor_name  text not null default '',
  channel     text not null check (channel in ('clock', 'app', 'server')),
  kind        text not null check (kind in ('created', 'replacement', 'clock_out', 'voided')),
  before      jsonb not null default '{}'::jsonb,
  after       jsonb not null default '{}'::jsonb,
  reason      text not null default ''
);
create index if not exists time_entry_events_entry_idx on public.time_entry_events (entry_id, at);
create index if not exists time_entry_events_employee_idx on public.time_entry_events (employee_id, at);

-- ---- 7. helpers ---------------------------------------------------------------------------------------------------------------
-- the Israeli calendar day of a moment, and its month
create or replace function public.att_day(p_at timestamptz) returns date
language sql immutable set search_path = public as $$ select (p_at at time zone 'Asia/Jerusalem')::date $$;
create or replace function public.att_month_of(p_day date) returns text
language sql immutable set search_path = public as $$ select to_char(p_day, 'YYYY-MM') $$;

-- is this employee's month (of a day) closed?
create or replace function public.att_month_closed(p_employee uuid, p_day date) returns boolean
language sql stable security definer set search_path = public as $$
  select p_day is not null and exists (select 1 from public.attendance_months m
                                        where m.employee_id = p_employee and m.month = public.att_month_of(p_day) and m.status = 'closed');
$$;
revoke execute on function public.att_month_closed(uuid, date) from public, anon;
grant execute on function public.att_month_closed(uuid, date) to authenticated, service_role;

-- the name of an app user, for the history
create or replace function public.att_actor_name(p_user uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select coalesce(nullif(btrim(p.full_name), ''), nullif(btrim(p.email), '')) from public.profiles p where p.id = p_user), '');
$$;
revoke execute on function public.att_actor_name(uuid) from public, anon, authenticated;

-- the business the caller works in, if they may use attendance there; with an employee — of that business, and what is needed
create or replace function public.att_guard(p_employee uuid, p_need text) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare b uuid := public.current_business_id(); r text := public.att_role();
begin
  if b is null or not public.can_access_business(b) or r = 'none' or not public.has_module('attendance') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_need in ('manage', 'admin') and not public.can_write() then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_employee is not null and not exists (select 1 from public.employees e where e.id = p_employee and e.business_id = b) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_need = 'admin' and r <> 'admin' then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_need = 'manage' and (p_employee is null or not public.att_manages(p_employee)) and r <> 'admin' then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return b;
end $$;
revoke execute on function public.att_guard(uuid, text) from public, anon, authenticated;

-- an app user's insert / update of these tables: only rows of the business worked in now (before any check that reads data)
create or replace function public.att_gate_caller() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user in ('anon', 'authenticated') then
    if new.business_id is null or new.business_id is distinct from public.current_business_id()
       or new.business_id not in (select public.accessible_business_ids()) then
      raise exception 'not allowed' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.att_gate_caller() from public, anon, authenticated;

-- nothing of attendance is deleted — not by a person, not by a cascade
create or replace function public.att_no_delete() returns trigger
language plpgsql set search_path = public as $$
begin
  raise exception 'attendance records are never deleted (%): void, cancel or archive instead', tg_table_name using errcode = '42501';
end $$;
revoke execute on function public.att_no_delete() from public, anon, authenticated;

-- ---- 8. the entry's rules (before) and its history (after) ------------------------------------------------------------------------
-- invoker on purpose: an app user's own write runs as 'authenticated' and is refused; the att_* functions (security definer) run as
-- their owner, and the clock as service_role — so "only through the functions" can not be bypassed
create or replace function public.att_entry_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user in ('anon', 'authenticated') then
    raise exception 'time entries are written only through the attendance functions' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.voided_at is not null then raise exception 'a new entry is not voided' using errcode = '23514'; end if;
    new.method := coalesce(new.method, case new.source when 'qr' then 'qr' when 'manual' then 'manual' else 'link' end);
    if public.att_month_closed(new.employee_id, public.att_day(new.clock_in))
       or public.att_month_closed(new.employee_id, public.att_day(new.clock_out)) then
      raise exception 'att: the month is closed' using errcode = '23514';
    end if;
    -- one open shift per employee: the same answer as before (the clock reads 23505 as "כבר במשמרת")
    if new.clock_out is null and exists (select 1 from public.time_entries t
                                          where t.employee_id = new.employee_id and t.clock_out is null and t.id <> new.id) then
      raise exception 'duplicate key value violates unique constraint "time_entries_one_open"' using errcode = '23505';
    end if;
    -- never two entries of one employee at the same time (an open one runs until now)
    if exists (select 1 from public.time_entries t
                where t.employee_id = new.employee_id and t.voided_at is null and t.id <> new.id
                  and tstzrange(t.clock_in, coalesce(t.clock_out, greatest(now(), t.clock_in + interval '1 second')), '[)')
                   && tstzrange(new.clock_in, coalesce(new.clock_out, 'infinity'::timestamptz), '[)')) then
      raise exception 'att: overlaps another entry of this employee (an open shift runs until it is closed)' using errcode = '23P01';
    end if;
    return new;
  end if;
  -- UPDATE: a clock-out on an open shift, or a void — nothing else ever changes
  if (new.id, new.business_id, new.user_id, new.employee_id, new.clock_in, new.in_lat, new.in_lng, new.source, new.method,
      new.replaces, new.created_at, new.created_by)
     is distinct from
     (old.id, old.business_id, old.user_id, old.employee_id, old.clock_in, old.in_lat, old.in_lng, old.source, old.method,
      old.replaces, old.created_at, old.created_by) then
    raise exception 'att: an entry is not rewritten — a correction is a new entry' using errcode = '42501';
  end if;
  if old.voided_at is not null then raise exception 'att: a voided entry does not change' using errcode = '42501'; end if;
  if (new.clock_out is distinct from old.clock_out or new.out_lat is distinct from old.out_lat or new.out_lng is distinct from old.out_lng
      or new.out_method is distinct from old.out_method) and old.clock_out is not null then
    raise exception 'att: the clock-out of an entry is set once' using errcode = '42501';
  end if;
  if new.voided_at is null and (new.voided_by is not null or new.void_reason <> '') then
    raise exception 'att: a void has its moment' using errcode = '23514';
  end if;
  if new.voided_at is null and new.clock_out is not distinct from old.clock_out
     and (new.note is distinct from old.note or new.edited is distinct from old.edited) then
    raise exception 'att: an entry is not rewritten — a correction is a new entry' using errcode = '42501';
  end if;
  if public.att_month_closed(old.employee_id, public.att_day(old.clock_in))
     or public.att_month_closed(old.employee_id, public.att_day(new.clock_out)) then
    raise exception 'att: the month is closed' using errcode = '23514';
  end if;
  if new.clock_out is not null and old.clock_out is null then
    new.out_method := coalesce(new.out_method, new.method);
  end if;
  return new;
end $$;
revoke execute on function public.att_entry_guard() from public, anon, authenticated;
drop trigger if exists a_att_gate on public.time_entries;
create trigger a_att_gate before insert or update on public.time_entries for each row execute function public.att_gate_caller();
drop trigger if exists b_att_entry_guard on public.time_entries;
create trigger b_att_entry_guard before insert or update on public.time_entries for each row execute function public.att_entry_guard();
drop trigger if exists att_no_delete on public.time_entries;
create trigger att_no_delete before delete on public.time_entries for each row execute function public.att_no_delete();

create or replace function public.att_entry_view(e public.time_entries) returns jsonb
language sql immutable set search_path = public as $$
  select jsonb_build_object('clock_in', e.clock_in, 'clock_out', e.clock_out, 'method', e.method, 'out_method', e.out_method,
    'in_lat', e.in_lat, 'in_lng', e.in_lng, 'out_lat', e.out_lat, 'out_lng', e.out_lng, 'replaces', e.replaces, 'note', e.note,
    'voided_at', e.voided_at, 'void_reason', e.void_reason);
$$;

create or replace function public.att_entry_log() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  who constant uuid := auth.uid();
  -- (security definer: current_user is the owner here — the caller is told by the request's token)
  ch constant text := case when who is not null then 'app' when auth.role() = 'service_role' then 'clock' else 'server' end;
  why constant text := coalesce(current_setting('dp.att_reason', true), '');
  k text;
begin
  if tg_op = 'INSERT' then
    k := case when new.replaces is not null then 'replacement' else 'created' end;
    insert into public.time_entry_events (business_id, employee_id, entry_id, actor, actor_name, channel, kind, after, reason)
    values (new.business_id, new.employee_id, new.id, who, public.att_actor_name(who), ch, k, public.att_entry_view(new), why);
  else
    if new.voided_at is not null and old.voided_at is null then k := 'voided';
    elsif new.clock_out is distinct from old.clock_out then k := 'clock_out';
    else return null; end if;
    insert into public.time_entry_events (business_id, employee_id, entry_id, actor, actor_name, channel, kind, before, after, reason)
    values (new.business_id, new.employee_id, new.id, who, public.att_actor_name(who), ch, k, public.att_entry_view(old), public.att_entry_view(new),
            case when k = 'voided' then new.void_reason else why end);
  end if;
  -- "פעיל לאחרונה": the last clock-in or clock-out the employee made
  if ch = 'clock' then
    update public.employees set last_active_at = greatest(coalesce(last_active_at, '-infinity'::timestamptz), coalesce(new.clock_out, new.clock_in))
     where id = new.employee_id;
  end if;
  return null;
end $$;
revoke execute on function public.att_entry_log() from public, anon, authenticated;
drop trigger if exists z_att_entry_log on public.time_entries;
create trigger z_att_entry_log after insert or update on public.time_entries for each row execute function public.att_entry_log();

-- ---- 9. absences and requests in a closed month; the no-delete rule everywhere ----------------------------------------------------------
create or replace function public.att_absence_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user in ('anon', 'authenticated') then
    raise exception 'absences are written only through the attendance functions' using errcode = '42501';
  end if;
  if exists (select 1 from public.attendance_months m
              where m.employee_id = new.employee_id and m.status = 'closed'
                and m.month between public.att_month_of(new.from_day) and public.att_month_of(new.to_day)) then
    raise exception 'att: the month is closed' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and (new.employee_id, new.business_id, new.kind, new.from_day, new.to_day, new.minutes, new.created_at, new.created_by, new.requested_by)
                          is distinct from (old.employee_id, old.business_id, old.kind, old.from_day, old.to_day, old.minutes, old.created_at, old.created_by, old.requested_by) then
    raise exception 'att: an absence is not rewritten — cancel it and record a new one' using errcode = '42501';
  end if;
  return new;
end $$;
revoke execute on function public.att_absence_guard() from public, anon, authenticated;
drop trigger if exists a_att_gate on public.absences;
create trigger a_att_gate before insert or update on public.absences for each row execute function public.att_gate_caller();
drop trigger if exists b_att_absence_guard on public.absences;
create trigger b_att_absence_guard before insert or update on public.absences for each row execute function public.att_absence_guard();

create or replace function public.att_write_only() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user in ('anon', 'authenticated') then
    raise exception '% is written only through the attendance functions', tg_table_name using errcode = '42501';
  end if;
  return new;
end $$;
revoke execute on function public.att_write_only() from public, anon, authenticated;
do $$
declare t text;
begin
  foreach t in array array['time_requests', 'attendance_months', 'attendance_month_events', 'time_entry_events'] loop
    execute format('drop trigger if exists b_att_write_only on public.%I', t);
    execute format('create trigger b_att_write_only before insert or update on public.%I for each row execute function public.att_write_only()', t);
  end loop;
  foreach t in array array['employees', 'time_entries', 'time_entry_events', 'time_requests', 'absences', 'attendance_months',
                           'attendance_month_events', 'departments', 'work_tracks', 'employee_private', 'attendance_approvers'] loop
    execute format('drop trigger if exists att_no_delete on public.%I', t);
    execute format('create trigger att_no_delete before delete on public.%I for each row execute function public.att_no_delete()', t);
  end loop;
  foreach t in array array['departments', 'work_tracks', 'employee_private', 'attendance_approvers'] loop
    execute format('drop trigger if exists a_att_gate on public.%I', t);
    execute format('create trigger a_att_gate before insert or update on public.%I for each row execute function public.att_gate_caller()', t);
  end loop;
end $$;

-- an approver: a member of the same business (said only about the caller's own business — a_att_gate runs first)
create or replace function public.att_approver_check() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.business_members m where m.business_id = new.business_id and m.user_id = new.approver_user_id) then
    raise exception 'att: the approver is not a member of this business' using errcode = '23514';
  end if;
  return new;
end $$;
revoke execute on function public.att_approver_check() from public, anon, authenticated;
drop trigger if exists b_att_approver_check on public.attendance_approvers;
create trigger b_att_approver_check before insert or update on public.attendance_approvers for each row execute function public.att_approver_check();

create or replace function public.att_private_touch() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end $$;
revoke execute on function public.att_private_touch() from public, anon, authenticated;
drop trigger if exists b_att_private_touch on public.employee_private;
create trigger b_att_private_touch before insert or update on public.employee_private for each row execute function public.att_private_touch();

-- ---- 10. row-level security ----------------------------------------------------------------------------------------------------
do $$
declare
  t text;
  gate constant text := 'business_id = (select public.current_business_id()) and business_id in (select public.accessible_business_ids())';
  full_access constant text := '(select public.my_access()) <> ''register''';
  module constant text := '(select public.has_module(''attendance''))';
begin
  foreach t in array array['departments', 'work_tracks', 'employee_private', 'attendance_approvers', 'time_requests', 'absences',
                           'attendance_months', 'attendance_month_events', 'time_entry_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_business_gate', t);
    execute format('create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)', t || '_business_gate', t, gate, gate);
    execute format('drop policy if exists %I on public.%I', t || '_cashier_none', t);
    execute format('create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)', t || '_cashier_none', t, full_access, full_access);
    execute format('drop policy if exists %I on public.%I', t || '_module', t);
    execute format('create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)', t || '_module', t, module, module);
    execute format('drop policy if exists %I on public.%I', t || '_viewer_insert', t);
    execute format('create policy %I on public.%I as restrictive for insert to authenticated with check ((select public.can_write()))', t || '_viewer_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_viewer_update', t);
    execute format('create policy %I on public.%I as restrictive for update to authenticated using ((select public.can_write())) with check ((select public.can_write()))', t || '_viewer_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_viewer_delete', t);
    execute format('create policy %I on public.%I as restrictive for delete to authenticated using ((select public.can_write()))', t || '_viewer_delete', t);
    execute format('revoke delete, truncate on public.%I from public, anon, authenticated', t);
  end loop;
  revoke delete, truncate on public.time_entries from anon, authenticated;
  revoke delete, truncate on public.employees from anon, authenticated;
end $$;

-- departments and tracks: the team reads them; the admin writes
drop policy if exists departments_read on public.departments;
create policy departments_read on public.departments for select to authenticated using ((select public.att_role()) <> 'none');
drop policy if exists departments_admin_write on public.departments;
create policy departments_admin_write on public.departments for insert to authenticated with check ((select public.att_role()) = 'admin');
drop policy if exists departments_admin_update on public.departments;
create policy departments_admin_update on public.departments for update to authenticated
  using ((select public.att_role()) = 'admin') with check ((select public.att_role()) = 'admin');
drop policy if exists work_tracks_read on public.work_tracks;
create policy work_tracks_read on public.work_tracks for select to authenticated using ((select public.att_role()) <> 'none');
drop policy if exists work_tracks_admin_write on public.work_tracks;
create policy work_tracks_admin_write on public.work_tracks for insert to authenticated with check ((select public.att_role()) = 'admin');
drop policy if exists work_tracks_admin_update on public.work_tracks;
create policy work_tracks_admin_update on public.work_tracks for update to authenticated
  using ((select public.att_role()) = 'admin') with check ((select public.att_role()) = 'admin');
-- approvers: the admin writes; the admin and the approver themself read
drop policy if exists attendance_approvers_read on public.attendance_approvers;
create policy attendance_approvers_read on public.attendance_approvers for select to authenticated
  using ((select public.att_role()) in ('admin', 'payroll', 'viewer') or approver_user_id = auth.uid());
drop policy if exists attendance_approvers_admin_write on public.attendance_approvers;
create policy attendance_approvers_admin_write on public.attendance_approvers for insert to authenticated with check ((select public.att_role()) = 'admin');
drop policy if exists attendance_approvers_admin_update on public.attendance_approvers;
create policy attendance_approvers_admin_update on public.attendance_approvers for update to authenticated
  using ((select public.att_role()) = 'admin') with check ((select public.att_role()) = 'admin');
-- the private part: admin and payroll read; the admin writes
drop policy if exists employee_private_read on public.employee_private;
create policy employee_private_read on public.employee_private for select to authenticated using ((select public.att_role()) in ('admin', 'payroll'));
drop policy if exists employee_private_admin_write on public.employee_private;
create policy employee_private_admin_write on public.employee_private for insert to authenticated with check ((select public.att_role()) = 'admin');
drop policy if exists employee_private_admin_update on public.employee_private;
create policy employee_private_admin_update on public.employee_private for update to authenticated
  using ((select public.att_role()) = 'admin') with check ((select public.att_role()) = 'admin');
-- requests, absences, months and both histories: read for whoever sees the employee; written through the functions only
drop policy if exists time_requests_read on public.time_requests;
create policy time_requests_read on public.time_requests for select to authenticated using (public.att_sees(employee_id));
drop policy if exists absences_read on public.absences;
create policy absences_read on public.absences for select to authenticated using (public.att_sees(employee_id));
drop policy if exists attendance_months_read on public.attendance_months;
create policy attendance_months_read on public.attendance_months for select to authenticated using (public.att_sees(employee_id));
drop policy if exists attendance_month_events_read on public.attendance_month_events;
create policy attendance_month_events_read on public.attendance_month_events for select to authenticated using (public.att_sees(employee_id));
drop policy if exists time_entry_events_read on public.time_entry_events;
create policy time_entry_events_read on public.time_entry_events for select to authenticated using (public.att_sees(employee_id));
revoke insert, update on public.time_requests, public.attendance_months, public.attendance_month_events, public.time_entry_events from anon, authenticated;
revoke insert, update on public.absences from anon, authenticated;

-- the employees and their entries (existing tables — their policies stay): an approver sees only their own people; the
-- employees are written by the admin (the register's commissions are written by the same people as before: owner / editor)
drop policy if exists employees_att_scope on public.employees;
create policy employees_att_scope on public.employees as restrictive for select to authenticated
  using (public.att_sees(id));
drop policy if exists employees_att_insert on public.employees;
create policy employees_att_insert on public.employees as restrictive for insert to authenticated with check ((select public.att_role()) = 'admin');
drop policy if exists employees_att_update on public.employees;
create policy employees_att_update on public.employees as restrictive for update to authenticated
  using ((select public.att_role()) = 'admin') with check ((select public.att_role()) = 'admin');
drop policy if exists time_entries_att_scope on public.time_entries;
create policy time_entries_att_scope on public.time_entries as restrictive for select to authenticated using (public.att_sees(employee_id));

-- the sick notes: a private bucket, a folder per business; the admin and approvers add, whoever manages reads; never deleted
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('attendance-files', 'attendance-files', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'])
on conflict (id) do nothing;
drop policy if exists attendance_files_read on storage.objects;
create policy attendance_files_read on storage.objects for select to authenticated
  using (bucket_id = 'attendance-files' and (storage.foldername(name))[1] = (select public.current_business_id())::text
         and (select public.att_role()) in ('admin', 'approver', 'payroll'));
drop policy if exists attendance_files_add on storage.objects;
create policy attendance_files_add on storage.objects for insert to authenticated
  with check (bucket_id = 'attendance-files' and (storage.foldername(name))[1] = (select public.current_business_id())::text
              and (select public.att_role()) in ('admin', 'approver') and (select public.can_write()));

-- ---- 11. the write functions of the app (security definer: each checks who, the business and the reason) --------------------------------
-- a reason: 2–300 characters, never empty
create or replace function public.att_reason(p_reason text) returns text
language plpgsql immutable set search_path = public as $$
begin
  if p_reason is null or length(btrim(p_reason)) < 2 then raise exception 'att: a reason is required' using errcode = '22023'; end if;
  return left(btrim(p_reason), 300);
end $$;

-- a manager records a whole shift that was not reported (a new entry; the reason is its note and in the history)
create or replace function public.att_entry_add(p_id uuid, p_employee uuid, p_in timestamptz, p_out timestamptz, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare b uuid := public.att_guard(p_employee, 'manage'); why text := public.att_reason(p_reason); e public.time_entries;
begin
  if p_id is null or p_in is null or p_out is null or p_out <= p_in then raise exception 'att: a shift has its clock-in and its clock-out' using errcode = '22023'; end if;
  if p_out > now() + interval '5 minutes' then raise exception 'att: a shift in the future' using errcode = '22023'; end if;
  select * into e from public.time_entries where id = p_id;
  if found then
    if e.employee_id <> p_employee then raise exception 'not allowed' using errcode = '42501'; end if;
    return e.id;                                                  -- a retry
  end if;
  perform set_config('dp.att_reason', why, true);
  insert into public.time_entries (id, user_id, business_id, employee_id, clock_in, clock_out, source, method, out_method, edited, note, created_by)
  values (p_id, auth.uid(), b, p_employee, p_in, p_out, 'manual', 'manual', 'manual', true, why, auth.uid());
  perform set_config('dp.att_reason', '', true);
  return p_id;
end $$;

-- a manager corrects an entry: it is voided, and a new one takes its place (p_new_id — a retry is the same correction)
create or replace function public.att_entry_fix(p_entry uuid, p_new_id uuid, p_in timestamptz, p_out timestamptz, p_reason text, p_method text default 'manual')
returns uuid language plpgsql security definer set search_path = public as $$
declare e public.time_entries; b uuid; why text := public.att_reason(p_reason); same_in boolean; same_out boolean;
begin
  select * into e from public.time_entries where id = p_entry for update;
  if not found then raise exception 'not allowed' using errcode = '42501'; end if;
  b := public.att_guard(e.employee_id, 'manage');
  if exists (select 1 from public.time_entries where id = p_new_id and replaces = p_entry) then return p_new_id; end if;  -- a retry
  if e.voided_at is not null then raise exception 'att: the entry was already corrected or voided' using errcode = '23514'; end if;
  if p_new_id is null or p_in is null or p_out is null or p_out <= p_in then raise exception 'att: a shift has its clock-in and its clock-out' using errcode = '22023'; end if;
  if p_out > now() + interval '5 minutes' then raise exception 'att: a shift in the future' using errcode = '22023'; end if;
  if p_method not in ('manual', 'request') then raise exception 'att: method' using errcode = '22023'; end if;
  same_in := p_in = e.clock_in; same_out := e.clock_out is not null and p_out = e.clock_out;
  perform set_config('dp.att_reason', why, true);
  -- an open shift is closed by its void (one open shift per employee): the void keeps the moment it was voided
  update public.time_entries set voided_at = now(), voided_by = auth.uid(), void_reason = why,
         clock_out = coalesce(clock_out, greatest(now(), clock_in + interval '1 second'))
   where id = p_entry;
  insert into public.time_entries (id, user_id, business_id, employee_id, clock_in, clock_out, source, method, out_method, edited, note, replaces, created_by,
                                   in_lat, in_lng, out_lat, out_lng)
  values (p_new_id, auth.uid(), b, e.employee_id, p_in, p_out, 'manual',
          case when same_in then e.method else p_method end, case when same_out then coalesce(e.out_method, e.method) else p_method end,
          true, why, p_entry, auth.uid(),
          case when same_in then e.in_lat end, case when same_in then e.in_lng end, case when same_out then e.out_lat end, case when same_out then e.out_lng end);
  perform set_config('dp.att_reason', '', true);
  return p_new_id;
end $$;

-- a manager closes a shift the employee forgot to close (the clock-out, once)
create or replace function public.att_entry_close(p_entry uuid, p_out timestamptz, p_reason text, p_method text default 'manual')
returns uuid language plpgsql security definer set search_path = public as $$
declare e public.time_entries; why text := public.att_reason(p_reason);
begin
  select * into e from public.time_entries where id = p_entry for update;
  if not found then raise exception 'not allowed' using errcode = '42501'; end if;
  perform public.att_guard(e.employee_id, 'manage');
  if e.voided_at is not null or e.clock_out is not null then raise exception 'att: the shift is not open' using errcode = '23514'; end if;
  if p_out is null or p_out <= e.clock_in or p_out > now() + interval '5 minutes' then raise exception 'att: the clock-out is after the clock-in, not in the future' using errcode = '22023'; end if;
  if p_method not in ('manual', 'request') then raise exception 'att: method' using errcode = '22023'; end if;
  perform set_config('dp.att_reason', why, true);
  update public.time_entries set clock_out = p_out, out_method = p_method, edited = true,
         note = case when note = '' then why else left(note || ' · ' || why, 600) end
   where id = p_entry;
  perform set_config('dp.att_reason', '', true);
  return p_entry;
end $$;

-- a manager voids an entry that should not be there (a duplicate, a test) — it stays, marked, out of every sum
create or replace function public.att_entry_void(p_entry uuid, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare e public.time_entries; why text := public.att_reason(p_reason);
begin
  select * into e from public.time_entries where id = p_entry for update;
  if not found then raise exception 'not allowed' using errcode = '42501'; end if;
  perform public.att_guard(e.employee_id, 'manage');
  if e.voided_at is not null then return p_entry; end if;
  perform set_config('dp.att_reason', why, true);
  update public.time_entries set voided_at = now(), voided_by = auth.uid(), void_reason = why,
         clock_out = coalesce(clock_out, greatest(now(), clock_in + interval '1 second'))
   where id = p_entry;
  perform set_config('dp.att_reason', '', true);
  return p_entry;
end $$;

-- an employee's request (the server only: the clock link is checked there). A retry with the same id is the same request.
create or replace function public.att_request_create(p_id uuid, p_employee uuid, p_kind text, p_entry uuid, p_in timestamptz, p_out timestamptz, p_note text)
returns uuid language plpgsql security definer set search_path = public as $$
declare b uuid; e public.time_entries;
begin
  select business_id into b from public.employees where id = p_employee and active;
  if b is null then raise exception 'not allowed' using errcode = '42501'; end if;
  if exists (select 1 from public.time_requests where id = p_id) then
    if not exists (select 1 from public.time_requests where id = p_id and employee_id = p_employee) then raise exception 'not allowed' using errcode = '42501'; end if;
    return p_id;
  end if;
  if p_entry is not null then
    select * into e from public.time_entries where id = p_entry and employee_id = p_employee and voided_at is null;
    if not found then raise exception 'att: no such entry' using errcode = '22023'; end if;
    if p_kind = 'missing_out' and e.clock_out is not null then raise exception 'att: the shift is not open' using errcode = '23514'; end if;
  end if;
  if coalesce(p_out, p_in) > now() + interval '5 minutes' then raise exception 'att: a shift in the future' using errcode = '22023'; end if;
  if public.att_month_closed(p_employee, public.att_day(coalesce(p_in, e.clock_in))) then raise exception 'att: the month is closed' using errcode = '23514'; end if;
  if exists (select 1 from public.time_requests where employee_id = p_employee and status = 'pending' and p_entry is not null and entry_id = p_entry) then
    raise exception 'att: a request for this entry is already waiting' using errcode = '23505';
  end if;
  insert into public.time_requests (id, business_id, employee_id, kind, entry_id, clock_in, clock_out, note)
  values (p_id, b, p_employee, p_kind, p_entry, case when p_kind = 'missing_out' then null else p_in end, p_out, left(btrim(coalesce(p_note, '')), 300));
  return p_id;
end $$;

-- a manager decides a request: approved = the entry it asks for (a new one, the clock-out, or a correction); rejected = a note
create or replace function public.att_request_decide(p_request uuid, p_approve boolean, p_note text)
returns uuid language plpgsql security definer set search_path = public as $$
declare r public.time_requests; res uuid; why text;
begin
  select * into r from public.time_requests where id = p_request for update;
  if not found then raise exception 'not allowed' using errcode = '42501'; end if;
  perform public.att_guard(r.employee_id, 'manage');
  if r.status <> 'pending' then raise exception 'att: the request was already decided' using errcode = '23514'; end if;
  if p_approve then
    why := 'בקשת העובד/ת' || case when r.note <> '' then ': ' || r.note else '' end
        || case when coalesce(btrim(p_note), '') <> '' then ' · ' || btrim(p_note) else '' end;
    if r.kind = 'missing_out' then res := public.att_entry_close(r.entry_id, r.clock_out, why, 'request');
    elsif r.kind = 'fix' then res := public.att_entry_fix(r.entry_id, gen_random_uuid(), r.clock_in, r.clock_out, why, 'request');
    else
      res := gen_random_uuid();
      perform set_config('dp.att_reason', why, true);
      insert into public.time_entries (id, user_id, business_id, employee_id, clock_in, clock_out, source, method, out_method, edited, note, created_by)
      values (res, auth.uid(), r.business_id, r.employee_id, r.clock_in, r.clock_out, 'manual', 'request', 'request', true, left(why, 300), auth.uid());
    end if;
  else
    perform public.att_reason(p_note);                                   -- a rejection says why
  end if;
  update public.time_requests set status = case when p_approve then 'approved' else 'rejected' end, decided_by = auth.uid(), decided_at = now(),
         decision_note = left(btrim(coalesce(p_note, '')), 300), result_entry_id = res
   where id = p_request;
  perform set_config('dp.att_reason', '', true);
  return res;
end $$;

-- an absence: by a manager = approved at once; by the employee (the server) = waits
create or replace function public.att_absence_add(p_id uuid, p_employee uuid, p_kind text, p_from date, p_to date, p_minutes int, p_note text, p_file text)
returns uuid language plpgsql security definer set search_path = public as $$
declare b uuid; by_employee constant boolean := auth.uid() is null;
begin
  if by_employee then
    select business_id into b from public.employees where id = p_employee and active;
    if b is null then raise exception 'not allowed' using errcode = '42501'; end if;
  else
    b := public.att_guard(p_employee, 'manage');
  end if;
  if exists (select 1 from public.absences where id = p_id) then
    if not exists (select 1 from public.absences where id = p_id and employee_id = p_employee) then raise exception 'not allowed' using errcode = '42501'; end if;
    return p_id;
  end if;
  if p_file is not null and p_file <> '' and p_file not like b::text || '/%' then raise exception 'not allowed' using errcode = '42501'; end if;
  insert into public.absences (id, business_id, employee_id, kind, from_day, to_day, minutes, note, file_path, status, requested_by, decided_by, decided_at, created_by)
  values (p_id, b, p_employee, p_kind, p_from, coalesce(p_to, p_from), p_minutes, left(btrim(coalesce(p_note, '')), 300), coalesce(p_file, ''),
          case when by_employee then 'pending' else 'approved' end, case when by_employee then 'employee' else 'manager' end,
          case when by_employee then null else auth.uid() end, case when by_employee then null else now() end, auth.uid());
  return p_id;
end $$;

-- a manager approves / rejects a waiting absence, or cancels one (with a reason) — it stays, out of the report
create or replace function public.att_absence_decide(p_id uuid, p_status text, p_note text)
returns uuid language plpgsql security definer set search_path = public as $$
declare a public.absences;
begin
  select * into a from public.absences where id = p_id for update;
  if not found then raise exception 'not allowed' using errcode = '42501'; end if;
  perform public.att_guard(a.employee_id, 'manage');
  if p_status not in ('approved', 'rejected', 'cancelled') then raise exception 'att: status' using errcode = '22023'; end if;
  if p_status in ('approved', 'rejected') and a.status <> 'pending' then raise exception 'att: the absence was already decided' using errcode = '23514'; end if;
  if p_status = 'cancelled' and a.status = 'cancelled' then return p_id; end if;
  if p_status = 'cancelled' and a.status = 'rejected' then raise exception 'att: a rejected absence is not cancelled' using errcode = '23514'; end if;
  if p_status in ('rejected', 'cancelled') then perform public.att_reason(p_note); end if;
  update public.absences set status = p_status, decided_by = auth.uid(), decided_at = now(), decision_note = left(btrim(coalesce(p_note, '')), 300) where id = p_id;
  return p_id;
end $$;

-- months: an approver (or the admin) approves an employee's month; the admin closes it (refused with an open shift or anything
-- waiting in it, and before it ended) and reopens it with a reason
create or replace function public.att_month_mark(p_employee uuid, p_month text, p_kind text, p_reason text default '')
returns text language plpgsql security definer set search_path = public as $$
declare
  b uuid := public.att_guard(p_employee, case when p_kind = 'approved' then 'manage' else 'admin' end);
  cur text; first_day date; last_day date; why text := ''; snap jsonb;
begin
  if p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then raise exception 'att: month' using errcode = '22023'; end if;
  first_day := (p_month || '-01')::date; last_day := (first_day + interval '1 month')::date - 1;
  -- one month of one employee at a time (two managers closing together)
  perform pg_advisory_xact_lock(hashtextextended('att_month:' || p_employee::text || ':' || p_month, 0));
  select status into cur from public.attendance_months where employee_id = p_employee and month = p_month for update;
  cur := coalesce(cur, 'open');
  if p_kind = 'approved' then
    if cur = 'closed' then raise exception 'att: the month is closed' using errcode = '23514'; end if;
    if cur = 'approved' then return cur; end if;
  elsif p_kind = 'closed' then
    if cur = 'closed' then return cur; end if;
    if last_day >= public.att_day(now()) then raise exception 'att: a month closes after it ended' using errcode = '23514'; end if;
    if exists (select 1 from public.time_entries t where t.employee_id = p_employee and t.voided_at is null and t.clock_out is null
                and public.att_day(t.clock_in) <= last_day) then
      raise exception 'att: an open shift (no clock-out) — close it first' using errcode = '23514';
    end if;
    if exists (select 1 from public.time_requests q left join public.time_entries t on t.id = q.entry_id
                where q.employee_id = p_employee and q.status = 'pending'
                  and public.att_day(coalesce(q.clock_in, t.clock_in)) between first_day and last_day) then
      raise exception 'att: a request is waiting in this month' using errcode = '23514';
    end if;
    if exists (select 1 from public.absences a where a.employee_id = p_employee and a.status = 'pending'
                and a.from_day <= last_day and a.to_day >= first_day) then
      raise exception 'att: an absence is waiting in this month' using errcode = '23514';
    end if;
    -- the hours are computed by the employee's track: its rules confirmed by the employer, and kept with the month
    select to_jsonb(t) into snap from public.employees e join public.work_tracks t on t.id = e.track_id and t.business_id = e.business_id
     where e.id = p_employee;
    if snap is null or snap->>'rules_confirmed_at' is null then
      raise exception 'att: the hours track of the employee is not set or its rules are not confirmed' using errcode = '23514';
    end if;
  elsif p_kind = 'reopened' then
    why := public.att_reason(p_reason);
    if cur <> 'closed' then return cur; end if;
  else
    raise exception 'att: kind' using errcode = '22023';
  end if;
  insert into public.attendance_months as m (employee_id, month, business_id, status, approved_by, approved_at, closed_by, closed_at, rules_snapshot)
  values (p_employee, p_month, b, case p_kind when 'reopened' then 'open' else p_kind end,
          case when p_kind = 'approved' then auth.uid() end, case when p_kind = 'approved' then now() end,
          case when p_kind = 'closed' then auth.uid() end, case when p_kind = 'closed' then now() end, snap)
  on conflict (employee_id, month) do update set
    status = excluded.status,
    rules_snapshot = case when p_kind = 'closed' then snap when p_kind = 'reopened' then null else m.rules_snapshot end,
    approved_by = case when p_kind = 'approved' then auth.uid() else m.approved_by end,
    approved_at = case when p_kind = 'approved' then now() else m.approved_at end,
    closed_by = case when p_kind = 'closed' then auth.uid() else m.closed_by end,
    closed_at = case when p_kind = 'closed' then now() else m.closed_at end,
    updated_at = now();
  insert into public.attendance_month_events (business_id, employee_id, month, kind, reason, actor, actor_name)
  values (b, p_employee, p_month, p_kind, why, auth.uid(), public.att_actor_name(auth.uid()));
  return case p_kind when 'reopened' then 'open' else p_kind end;
end $$;

do $$ begin
  revoke execute on function public.att_reason(text) from public, anon, authenticated;
  revoke execute on function public.att_entry_add(uuid, uuid, timestamptz, timestamptz, text), public.att_entry_fix(uuid, uuid, timestamptz, timestamptz, text, text),
    public.att_entry_close(uuid, timestamptz, text, text), public.att_entry_void(uuid, text), public.att_request_decide(uuid, boolean, text),
    public.att_absence_decide(uuid, text, text), public.att_month_mark(uuid, text, text, text), public.att_absence_add(uuid, uuid, text, date, date, int, text, text)
    from public, anon;
  grant execute on function public.att_entry_add(uuid, uuid, timestamptz, timestamptz, text), public.att_entry_fix(uuid, uuid, timestamptz, timestamptz, text, text),
    public.att_entry_close(uuid, timestamptz, text, text), public.att_entry_void(uuid, text), public.att_request_decide(uuid, boolean, text),
    public.att_absence_decide(uuid, text, text), public.att_month_mark(uuid, text, text, text), public.att_absence_add(uuid, uuid, text, date, date, int, text, text)
    to authenticated, service_role;
  -- the employee's requests: the server only (it checked the personal link)
  revoke execute on function public.att_request_create(uuid, uuid, text, uuid, timestamptz, timestamptz, text) from public, anon, authenticated;
  grant execute on function public.att_request_create(uuid, uuid, text, uuid, timestamptz, timestamptz, text) to service_role;
  revoke execute on function public.att_day(timestamptz), public.att_month_of(date), public.att_entry_view(public.time_entries) from public, anon;
end $$;

-- ============================================================================================================================
-- Rollback (by hand, in the SQL Editor — only before any attendance data was recorded):
--   drop the triggers a_att_gate / b_att_entry_guard / z_att_entry_log / att_no_delete / b_att_* on the tables above;
--   drop the policies *_att_scope / employees_att_insert / employees_att_update and the storage policies attendance_files_*;
--   drop the att_* functions and has_module; drop the tables time_entry_events, attendance_month_events, attendance_months,
--   absences, time_requests, attendance_approvers, employee_private, work_tracks, departments; the added columns can stay.
-- ============================================================================================================================
