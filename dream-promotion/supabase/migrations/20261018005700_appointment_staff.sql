-- ============================================================================================================================
-- Migration 20261018005700 — the appointments calendar: a practitioner for every appointment, her colour, and its history
-- (2.105.0).
-- Prepared only: NOT applied to the live database (needs the owner's explicit approval; the SQL Editor). Runs after 20261012005300
-- (the team — lead_staff) and 20261010004600 (locations): it stops at the top without them, changing nothing.
-- A practitioner is a person of the business's team (lead_staff — the same list the leads go to), marked as one, with a colour:
--   lead_staff          + practitioner (a column of the calendar), + color (one of a fixed list; '' = by her place in the list —
--                         the same list as CALENDAR_COLORS in src/features/booking/calendar.ts). The WhatsApp number may now be
--                         empty (null): a practitioner who gets no messages. A number that is there keeps its format check.
--   appointments        + staff_id: a practitioner of the same business, on the team (b_appointment_staff, when it is set or
--                         changed). No two active appointments of one practitioner overlap; an appointment with no practitioner
--                         keeps 4600's rule (per location, among themselves) — a business without practitioners books as before.
--   appointment_events  every change of an appointment, written by a trigger only: who (the account, and her name then), when
--                         and what — created / moved / staff / status / edited. Read through the appointment itself (its own
--                         gates: the business, the location). Nobody writes, changes or removes a row.
--   appointment_staff() the team for the calendar: names, colours, who is a practitioner, the linked account — never a number.
-- It replaces 4600's appointments_location_no_overlap with the two rules above. Running 4600 again after it adds the old rule
-- back (one appointment per location at a time, practitioners or not) — then this one must run again.
-- Tested on a local Postgres: tests/sql/appointment-staff.check.sql. The rollback is at the end.
-- ============================================================================================================================

-- ---- 0. after 5300 (the team) and 4600 (locations) ----------------------------------------------------------------------------
do $$ begin
  if to_regclass('public.lead_staff') is null
     or not exists (select 1 from pg_constraint where conname = 'appointments_location_fkey') then
    raise exception 'migration 20261018005700 runs after 20261012005300 (the team) and 20261010004600 (locations) — run them first; nothing was changed';
  end if;
end $$;

-- ---- 1. the team: who is a practitioner, her colour; a number only for one who gets WhatsApp -----------------------------------
alter table public.lead_staff alter column phone drop not null;
alter table public.lead_staff add column if not exists practitioner boolean not null default false;
alter table public.lead_staff add column if not exists color text not null default '';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'lead_staff_color_check' and conrelid = 'public.lead_staff'::regclass) then
    alter table public.lead_staff add constraint lead_staff_color_check
      check (color in ('', 'pink', 'turquoise', 'yellow', 'violet', 'orange', 'blue', 'green', 'red', 'gray'));
  end if;
end $$;

-- ---- 2. an appointment's practitioner -------------------------------------------------------------------------------------------
alter table public.appointments add column if not exists staff_id uuid;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'appointments_staff_fkey') then
    alter table public.appointments add constraint appointments_staff_fkey
      foreign key (staff_id, business_id) references public.lead_staff (id, business_id);
  end if;
end $$;
create index if not exists appointments_staff_idx on public.appointments (business_id, staff_id, start_at) where staff_id is not null;

-- the practitioner: of the appointment's business, on the team, marked as one — checked when she is set or changed (an
-- appointment of one who left later keeps her). An app user's own business first (as a_gate_caller): nothing is said about the
-- team of another business.
create or replace function public.appointment_staff_check() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.staff_id is null or (tg_op = 'UPDATE' and new.staff_id is not distinct from old.staff_id) then
    return new;
  end if;
  if auth.uid() is not null and (new.business_id is distinct from public.current_business_id()
      or new.business_id not in (select public.accessible_business_ids())) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from public.lead_staff s
                  where s.id = new.staff_id and s.business_id = new.business_id and s.active and s.practitioner) then
    raise exception 'appointment_staff: not an active practitioner of this business' using errcode = '23514';
  end if;
  return new;
end $$;
revoke execute on function public.appointment_staff_check() from public, anon, authenticated;
-- "b_": after a_fill_business_id and a_location_fill (the business and the location are known)
create or replace trigger b_appointment_staff before insert or update of staff_id on public.appointments
  for each row execute function public.appointment_staff_check();

-- ---- 3. no double booking: per practitioner; without one — per location, as in 4600 ------------------------------------------
alter table public.appointments drop constraint if exists appointments_location_no_overlap;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'appointments_staff_no_overlap') then
    alter table public.appointments add constraint appointments_staff_no_overlap
      exclude using gist (business_id with =, staff_id with =, tstzrange(start_at, end_at, '[)') with &&)
      where (staff_id is not null and status in ('booked', 'confirmed'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'appointments_unassigned_no_overlap') then
    alter table public.appointments add constraint appointments_unassigned_no_overlap
      exclude using gist (business_id with =, (coalesce(location_id, business_id)) with =, tstzrange(start_at, end_at, '[)') with &&)
      where (staff_id is null and status in ('booked', 'confirmed'));
  end if;
end $$;

-- ---- 4. the history of every appointment ----------------------------------------------------------------------------------------
create table if not exists public.appointment_events (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references public.businesses on delete cascade,
  appointment_id uuid not null references public.appointments on delete cascade,
  at             timestamptz not null default clock_timestamp(),   -- the moment of each change (two in one save keep their order)
  actor          uuid references auth.users on delete set null,   -- who: the account (null — the server or the booking page)
  actor_name     text not null default '',                        -- her name then: on the team, else the account's
  kind           text not null check (kind in ('created', 'moved', 'staff', 'status', 'edited')),
  before         jsonb not null default '{}'::jsonb,
  after          jsonb not null default '{}'::jsonb
);
create index if not exists appointment_events_appt_idx on public.appointment_events (appointment_id, at);
alter table public.appointment_events enable row level security;
drop policy if exists appointment_events_business_gate on public.appointment_events;
create policy appointment_events_business_gate on public.appointment_events as restrictive for all
  using (business_id = (select public.current_business_id()) and business_id in (select public.accessible_business_ids()))
  with check (business_id = (select public.current_business_id()) and business_id in (select public.accessible_business_ids()));
-- read: the history of an appointment one may see (the appointment's own gates — the business, the location)
drop policy if exists appointment_events_read on public.appointment_events;
create policy appointment_events_read on public.appointment_events for select
  using (exists (select 1 from public.appointments a where a.id = appointment_id));
revoke insert, update, delete, truncate on public.appointment_events from public, anon, authenticated;

create or replace function public.appointment_log() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  who constant uuid := auth.uid();
  who_name text := '';
  fields constant text[] := array['name', 'phone', 'email', 'note', 'service_id', 'service_name', 'lead_id', 'location_id'];
  o jsonb; n jsonb; b jsonb := '{}'::jsonb; a jsonb := '{}'::jsonb; f text;
begin
  if who is not null then
    who_name := coalesce(
      (select s.name from public.lead_staff s where s.business_id = new.business_id and s.member_user_id = who and s.active
        order by s.created_at limit 1),
      (select nullif(btrim(p.full_name), '') from public.profiles p where p.id = who),
      (select nullif(btrim(p.email), '') from public.profiles p where p.id = who),
      '');
  end if;
  if tg_op = 'INSERT' then
    insert into public.appointment_events (business_id, appointment_id, actor, actor_name, kind, after)
    values (new.business_id, new.id, who, who_name, 'created', jsonb_build_object(
      'start', new.start_at, 'end', new.end_at, 'status', new.status, 'source', new.source,
      'staff_id', new.staff_id, 'staff', (select s.name from public.lead_staff s where s.id = new.staff_id)));
    return null;
  end if;
  if new.start_at is distinct from old.start_at or new.end_at is distinct from old.end_at then
    insert into public.appointment_events (business_id, appointment_id, actor, actor_name, kind, before, after)
    values (new.business_id, new.id, who, who_name, 'moved',
      jsonb_build_object('start', old.start_at, 'end', old.end_at), jsonb_build_object('start', new.start_at, 'end', new.end_at));
  end if;
  if new.staff_id is distinct from old.staff_id then
    insert into public.appointment_events (business_id, appointment_id, actor, actor_name, kind, before, after)
    values (new.business_id, new.id, who, who_name, 'staff',
      jsonb_build_object('staff_id', old.staff_id, 'staff', (select s.name from public.lead_staff s where s.id = old.staff_id)),
      jsonb_build_object('staff_id', new.staff_id, 'staff', (select s.name from public.lead_staff s where s.id = new.staff_id)));
  end if;
  if new.status is distinct from old.status then
    insert into public.appointment_events (business_id, appointment_id, actor, actor_name, kind, before, after)
    values (new.business_id, new.id, who, who_name, 'status', jsonb_build_object('status', old.status), jsonb_build_object('status', new.status));
  end if;
  o := to_jsonb(old); n := to_jsonb(new);
  foreach f in array fields loop
    if (o -> f) is distinct from (n -> f) then
      b := b || jsonb_build_object(f, o -> f);
      a := a || jsonb_build_object(f, n -> f);
    end if;
  end loop;
  if a <> '{}'::jsonb then
    insert into public.appointment_events (business_id, appointment_id, actor, actor_name, kind, before, after)
    values (new.business_id, new.id, who, who_name, 'edited', b, a);
  end if;
  return null;
end $$;
revoke execute on function public.appointment_log() from public, anon, authenticated;
create or replace trigger z_appointment_log after insert or update on public.appointments
  for each row execute function public.appointment_log();

-- ---- 5. the team for the calendar (any member but a cashier — never a number) ----------------------------------------------------
create or replace function public.appointment_staff()
returns table (id uuid, name text, color text, practitioner boolean, member_user_id uuid, active boolean)
language sql stable security definer set search_path = public as $$
  select s.id, s.name, s.color, s.practitioner, s.member_user_id, s.active
    from public.lead_staff s
   where s.business_id = public.current_business_id()
     and s.business_id in (select public.accessible_business_ids())
     and public.my_access() <> 'register'
   order by s.created_at, s.id;
$$;
revoke execute on function public.appointment_staff() from public, anon;
grant execute on function public.appointment_staff() to authenticated;

-- ---- rollback (by hand, only to undo it) ---------------------------------------------------------------------------------------
--   the two overlap rules out, 4600's back (it refuses while two practitioners have appointments at one hour in one location):
--     alter table public.appointments drop constraint if exists appointments_staff_no_overlap;
--     alter table public.appointments drop constraint if exists appointments_unassigned_no_overlap;
--     then 4600's "appointments_location_no_overlap" block again;
--   drop trigger if exists z_appointment_log on public.appointments; drop trigger if exists b_appointment_staff on public.appointments;
--   (the columns, the colours and the history can stay — nothing reads them without the screens)
