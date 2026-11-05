-- 2.113.0 — "יומן בלבד": a member who works in the appointments calendar only (tests/sql/agenda-access.check.sql).
-- The owner of the system (05.11.2026, SaGabot): Karin sees the calendar and nothing else — not the clients' screen, not the
-- client's card. She adds, moves and cancels appointments as Gal ("יומן ולידים", 6000) does.
--   business_members.access = 'agenda'  (beside 'full', 'register' and 'calendar'); only the super admin sets it.
-- How it is enforced: every rule of a calendar member is theirs (calendar_member() answers true for them — 6000, 6100), and the
-- client file stays closed (client_files_allowed_for() of 6200 opens it to 'calendar' only, so 6200's restrictive
-- "<table>_calendar_only" refuses them the photos, treatments, declarations and the messages). The leads stay readable: an
-- appointment shows its client's name and phone, and a returning client is found by her phone — the app shows them no
-- clients' screen and no card (the server refuses their routes: agenda_only).
-- Additions only: no row changes. Runs after 6000 and 6200.

do $$ begin
  if to_regprocedure('public.calendar_member()') is null or to_regprocedure('public.client_files_allowed_for(uuid, uuid)') is null then
    raise exception 'run migrations 20261028006000 (calendar access) and 20261031006200 (calendar client file) first';
  end if;
end $$;

-- ---- the access ---------------------------------------------------------------------------------------------------------------
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'business_members_access_check' and conrelid = 'public.business_members'::regclass
              and pg_get_constraintdef(oid) not like '%agenda%') then
    alter table public.business_members drop constraint business_members_access_check;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'business_members_access_check' and conrelid = 'public.business_members'::regclass) then
    alter table public.business_members add constraint business_members_access_check
      check (access in ('full', 'register', 'calendar', 'agenda'));
  end if;
end $$;

-- 6000's, and an agenda member too: every rule of the calendar is theirs
create or replace function public.calendar_member() returns boolean
language sql stable security definer set search_path = public as $$
  select not public.is_super_admin() and exists (
    select 1 from public.business_members m
     where m.user_id = auth.uid() and m.business_id = public.current_business_id() and m.access in ('calendar', 'agenda'));
$$;
revoke execute on function public.calendar_member() from public, anon;
grant execute on function public.calendar_member() to authenticated, service_role;

-- 6000's: 'calendar' and 'agenda' answered as 'register' — everything a cashier may not do, they may not do either
create or replace function public.my_access() returns text
language sql stable security definer set search_path = public as $$
  select case when public.is_super_admin() then 'full'
    else coalesce((select case when m.access in ('calendar', 'agenda') then 'register' else m.access end from public.business_members m
                    where m.user_id = auth.uid() and m.business_id = public.current_business_id()), 'full') end;
$$;
revoke execute on function public.my_access() from public, anon;
grant execute on function public.my_access() to authenticated, service_role;

-- 6000's: no part in attendance
create or replace function public.att_role() returns text
language sql stable security definer set search_path = public as $$
  select case when public.is_super_admin() then 'admin' else coalesce((
    select case when m.access in ('register', 'calendar', 'agenda') then 'none'
                when m.attendance_role is not null then m.attendance_role
                when m.role in ('owner', 'editor') then 'admin'
                else 'viewer' end
      from public.business_members m
     where m.user_id = auth.uid() and m.business_id = public.current_business_id()
       and public.business_is_active(m.business_id)), 'none') end;
$$;
revoke execute on function public.att_role() from public, anon;
grant execute on function public.att_role() to authenticated, service_role;

-- ---- rollback (by hand, only to undo it) ---------------------------------------------------------------------------------------
--   update public.business_members set access = 'calendar' where access = 'agenda';   -- first: nobody is an agenda member
--   then run 6000 again (calendar_member(), my_access(), att_role()); the constraint may stay.
