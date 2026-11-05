-- 2.115.0 — "יומן בלבד" opens the card of a client who is in the calendar (tests/sql/agenda-client-card.check.sql).
-- The owner of the system (05.11.2026, SaGabot): Karin ("יומן בלבד") works on the clients of the calendar — whoever booked them —
-- their treatments, photos before / after and health declarations, as Gal does; never the clients' screen (the leads), and never
-- the card of anyone who has no appointment.
--   agenda_member()       the caller works now in a business where they are an agenda member
--   calendar_lead(lead)   the lead has an appointment in the business the caller works in (any status, anyone's)
--   client_files_allowed_for() — 6200's, and an agenda member too; the server asks calendar_lead itself for each client
--   "<table>_agenda_lead" — restrictive, on the client file's tables and the card's history: an agenda member reads and writes
--   only the rows of a calendar client. The messages (social_messages) stay closed to them ("<…>_agenda_none").
-- Replaces 6200's client_files_allowed_for() — running 6200 again brings the old one back: run 6600 again.
-- Additions only: no row changes. Runs after 6200 and 6400.

do $$ begin
  if to_regprocedure('public.client_files_allowed_for(uuid, uuid)') is null
     or not exists (select 1 from pg_constraint where conname = 'business_members_access_check' and pg_get_constraintdef(oid) like '%agenda%') then
    raise exception 'run migrations 20261031006200 (calendar client file) and 20261105006400 (agenda access) first';
  end if;
end $$;

create or replace function public.agenda_member() returns boolean
language sql stable security definer set search_path = public as $$
  select not public.is_super_admin() and exists (
    select 1 from public.business_members m
     where m.user_id = auth.uid() and m.business_id = public.current_business_id() and m.access = 'agenda');
$$;
revoke execute on function public.agenda_member() from public, anon;
grant execute on function public.agenda_member() to authenticated, service_role;

create or replace function public.calendar_lead(p_lead uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select p_lead is not null and exists (
    select 1 from public.appointments a where a.lead_id = p_lead and a.business_id = public.current_business_id());
$$;
revoke execute on function public.calendar_lead(uuid) from public, anon;
grant execute on function public.calendar_lead(uuid) to authenticated, service_role;

-- 6200's, and an agenda member of the business too (never a cashier)
create or replace function public.client_files_allowed_for(p_user uuid, p_business uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select p_user is not null and p_business is not null and public.business_is_active(p_business)
     and exists (select 1 from public.business_members m
                  where m.business_id = p_business and m.user_id = p_user
                    and (m.access in ('calendar', 'agenda')
                         or (m.access = 'full'
                             and (m.role = 'owner'
                                  or exists (select 1 from public.client_file_access a
                                              where a.business_id = p_business and a.user_id = p_user and a.revoked_at is null)))));
$$;
revoke execute on function public.client_files_allowed_for(uuid, uuid) from public, anon, authenticated;
grant execute on function public.client_files_allowed_for(uuid, uuid) to service_role;

-- an agenda member: only the rows of a client who is in the calendar
do $$
declare t text;
begin
  foreach t in array array['client_photos', 'client_sessions', 'client_treatments', 'declarations', 'declaration_requests',
                           'lead_activities'] loop
    if to_regclass('public.' || t) is not null
       and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_agenda_lead') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated '
                     'using (not (select public.agenda_member()) or public.calendar_lead(lead_id)) '
                     'with check (not (select public.agenda_member()) or public.calendar_lead(lead_id))', t || '_agenda_lead', t);
    end if;
  end loop;
  -- the messages from Facebook / Instagram: never theirs
  if to_regclass('public.social_messages') is not null
     and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'social_messages' and policyname = 'social_messages_agenda_none') then
    create policy social_messages_agenda_none on public.social_messages as restrictive for all to authenticated
      using (not (select public.agenda_member())) with check (not (select public.agenda_member()));
  end if;
end $$;

-- ---- rollback (by hand, only to undo it) ---------------------------------------------------------------------------------------
--   run 6200's client_files_allowed_for() again (the agenda members lose the card; the policies above then change nothing).
