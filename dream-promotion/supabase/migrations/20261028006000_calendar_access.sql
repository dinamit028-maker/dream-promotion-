-- 2.109.0 — "יומן ולידים": a member who works only in the appointments calendar and the leads (tests/sql/calendar-access.check.sql).
-- The owner of the system (28.10.2026, SaGabot): the staff fill the calendar for each other — add, move and cancel any appointment,
-- with its history as today — and see the leads; nothing else in Dream. A new client is never opened without a phone.
--   business_members.access = 'calendar'  (beside 'full' and 'register'); only the super admin sets it, as every member change.
-- How it is enforced, deny by default:
--   1. my_access() answers 'register' for such a member — every cashier restriction since 3000 applies to them as well (the money,
--      marketing, attendance, store and stock tables and functions refuse a cashier). Only two cashier rules are opened for them:
--      writing appointments (insert / update — never delete) and the calendar's team (appointment_staff()).
--   2. calendar_member() — and a restrictive "<table>_calendar_only" on every table with RLS but the calendar's and the leads':
--      leads, lead_activities, appointments, appointment_events; read only: booking_services, booking_settings, brands,
--      business_locations, businesses, business_members, profiles. A table added later gets the policy by running this file again.
--   3. att_role() — 'none' for them (as a cashier), not 'admin' by their role.
--   4. a lead they add, or change, always keeps a phone (a_leads_calendar_phone).
-- Additions only: no row changes. Runs after 5700 (the calendar's team) and 5800 (attendance).

do $$ begin
  if to_regprocedure('public.appointment_staff()') is null or to_regprocedure('public.att_role()') is null then
    raise exception 'run migrations 20261018005700 (calendar) and 20261023005800 (attendance) first';
  end if;
end $$;

-- ---- 1. the access ------------------------------------------------------------------------------------------------------------
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'business_members_access_check' and conrelid = 'public.business_members'::regclass
              and pg_get_constraintdef(oid) not like '%calendar%') then
    alter table public.business_members drop constraint business_members_access_check;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'business_members_access_check' and conrelid = 'public.business_members'::regclass) then
    alter table public.business_members add constraint business_members_access_check check (access in ('full', 'register', 'calendar'));
  end if;
end $$;

-- the caller works now in a business where they are a calendar member (the super admin never is)
create or replace function public.calendar_member() returns boolean
language sql stable security definer set search_path = public as $$
  select not public.is_super_admin() and exists (
    select 1 from public.business_members m
     where m.user_id = auth.uid() and m.business_id = public.current_business_id() and m.access = 'calendar');
$$;
revoke execute on function public.calendar_member() from public, anon;
grant execute on function public.calendar_member() to authenticated, service_role;

-- 3000's, with 'calendar' answered as 'register': everything a cashier may not do, a calendar member may not do either
create or replace function public.my_access() returns text
language sql stable security definer set search_path = public as $$
  select case when public.is_super_admin() then 'full'
    else coalesce((select case when m.access = 'calendar' then 'register' else m.access end from public.business_members m
                    where m.user_id = auth.uid() and m.business_id = public.current_business_id()), 'full') end;
$$;
revoke execute on function public.my_access() from public, anon;
grant execute on function public.my_access() to authenticated, service_role;

-- ---- 2. what the cashier rules close and the calendar needs ----------------------------------------------------------------------
-- appointments: a cashier only reads; a calendar member adds and changes (moves, cancels). Deleting stays closed to both.
do $$ begin
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'appointments' and policyname = 'appointments_cashier_insert') then
    alter policy appointments_cashier_insert on public.appointments
      with check ((select public.my_access()) <> 'register' or (select public.calendar_member()));
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'appointments' and policyname = 'appointments_cashier_update') then
    alter policy appointments_cashier_update on public.appointments
      using ((select public.my_access()) <> 'register' or (select public.calendar_member()))
      with check ((select public.my_access()) <> 'register' or (select public.calendar_member()));
  end if;
end $$;

-- 5700's, and a calendar member too (the names and colours of the team — never a number)
create or replace function public.appointment_staff()
returns table (id uuid, name text, color text, practitioner boolean, member_user_id uuid, active boolean)
language sql stable security definer set search_path = public as $$
  select s.id, s.name, s.color, s.practitioner, s.member_user_id, s.active
    from public.lead_staff s
   where s.business_id = public.current_business_id()
     and s.business_id in (select public.accessible_business_ids())
     and (public.my_access() <> 'register' or public.calendar_member())
   order by s.created_at, s.id;
$$;
revoke execute on function public.appointment_staff() from public, anon;
grant execute on function public.appointment_staff() to authenticated;

-- 5800's: a calendar member has no part in attendance (by their role they would be its admin)
create or replace function public.att_role() returns text
language sql stable security definer set search_path = public as $$
  select case when public.is_super_admin() then 'admin' else coalesce((
    select case when m.access in ('register', 'calendar') then 'none'
                when m.attendance_role is not null then m.attendance_role
                when m.role in ('owner', 'editor') then 'admin'
                else 'viewer' end
      from public.business_members m
     where m.user_id = auth.uid() and m.business_id = public.current_business_id()
       and public.business_is_active(m.business_id)), 'none') end;
$$;
revoke execute on function public.att_role() from public, anon;
grant execute on function public.att_role() to authenticated, service_role;

-- ---- 3. nothing else: every table with RLS but the calendar's and the leads' -------------------------------------------------------
do $$
declare
  t text; op text;
  open_all  constant text[] := array['leads', 'lead_activities', 'appointments', 'appointment_events'];
  read_only constant text[] := array['booking_services', 'booking_settings', 'brands', 'business_locations', 'businesses',
                                     'business_members', 'profiles'];
  rule constant text := 'not (select public.calendar_member())';
begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relrowsecurity loop
    if t = any(open_all) then continue; end if;
    if t = any(read_only) then
      foreach op in array array['insert', 'update', 'delete'] loop
        if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_calendar_' || op) then
          execute format('create policy %I on public.%I as restrictive for %s to authenticated %s', t || '_calendar_' || op, t, op,
            case op when 'insert' then format('with check (%s)', rule)
                    when 'update' then format('using (%s) with check (%s)', rule, rule)
                    else format('using (%s)', rule) end);
        end if;
      end loop;
    elsif not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_calendar_only') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)',
        t || '_calendar_only', t, rule, rule);
    end if;
  end loop;
end $$;

-- ---- 4. a client they open always has a phone ---------------------------------------------------------------------------------------
create or replace function public.leads_calendar_phone() returns trigger
language plpgsql set search_path = public as $$
begin
  if public.calendar_member() and btrim(coalesce(new.phone, '')) = ''
     and (tg_op = 'INSERT' or btrim(coalesce(old.phone, '')) <> '') then
    raise exception 'לקוח חדש נשמר רק עם מספר טלפון.' using errcode = 'P0001', hint = 'phone_required';
  end if;
  return new;
end $$;
revoke execute on function public.leads_calendar_phone() from public, anon;
create or replace trigger a_leads_calendar_phone before insert or update of phone on public.leads
  for each row execute function public.leads_calendar_phone();

-- ---- rollback (by hand, only to undo it) ---------------------------------------------------------------------------------------
--   update public.business_members set access = 'full' where access = 'calendar';   -- first: nobody is a calendar member
--   then run again 3000's my_access(), 5700's appointment_staff() and 5800's att_role(); the "_calendar_*" policies and the trigger
--   do nothing once nobody is a calendar member.
