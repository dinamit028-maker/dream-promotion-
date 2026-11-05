-- 2.115.0 — "יומן בלבד": everything Gal ("יומן ולידים") has, but only of the clients in the calendar (tests/sql/agenda-client-card.check.sql).
-- The owner of the system (05.11.2026, SaGabot): Karin works on every client who is in the calendar — whoever booked them — the
-- whole card as Gal (treatments, photos before / after, health declarations, the history, the messages); she never sees a lead
-- that is not in the calendar (a new lead from Facebook, a contact with no appointment). A phone she types for a new appointment
-- that is a lead's makes that lead the appointment's client (calendar_find_client) — from then on it is in the calendar.
--   agenda_member()            the caller works now in a business where they are an agenda member
--   calendar_lead(lead)        the lead has an appointment in the business the caller works in (any status, anyone's)
--   calendar_find_client(phone) the lead of this business with this phone (the newest), for a new appointment — its id only
--   client_files_allowed_for() — 6200's, and an agenda member too; the server asks calendar_lead itself for each client
--   restrictive "<table>_agenda_lead": an agenda member reads and writes only the rows of a calendar client — the leads
--   themselves (and one she just opened herself, before its appointment), the client file, the history and the messages.
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

-- a new appointment by phone: the lead with this phone, though she does not see it — its id only (a member of the business, not a cashier)
create or replace function public.calendar_find_client(p_phone text) returns uuid
language sql stable security definer set search_path = public as $$
  select l.id from public.leads l
   where l.business_id = public.current_business_id()
     and l.business_id in (select public.accessible_business_ids())
     and (public.my_access() <> 'register' or public.calendar_member())
     and length(public.phone_key(coalesce(p_phone, ''))) >= 9
     and coalesce(l.phone, '') <> '' and public.phone_key(l.phone) = public.phone_key(p_phone)
   order by l.created_at desc limit 1;
$$;
revoke execute on function public.calendar_find_client(text) from public, anon;
grant execute on function public.calendar_find_client(text) to authenticated;

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
declare t text; op text;
begin
  foreach t in array array['client_photos', 'client_sessions', 'client_treatments', 'declarations', 'declaration_requests',
                           'lead_activities', 'social_messages'] loop
    if to_regclass('public.' || t) is not null
       and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_agenda_lead') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated '
                     'using (not (select public.agenda_member()) or public.calendar_lead(lead_id)) '
                     'with check (not (select public.agenda_member()) or public.calendar_lead(lead_id))', t || '_agenda_lead', t);
    end if;
  end loop;
  -- a first draft of this file (run on the live database on 5.11.2026) closed the messages to them altogether — it is opened to
  -- the same rule (the policy stays, its rule changes)
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'social_messages' and policyname = 'social_messages_agenda_none') then
    alter policy social_messages_agenda_none on public.social_messages
      using (not (select public.agenda_member()) or public.calendar_lead(lead_id))
      with check (not (select public.agenda_member()) or public.calendar_lead(lead_id));
  end if;
  -- the leads: a calendar client, or one she opened herself (a new client is saved before its appointment); a new one — hers
  foreach op in array array['select', 'update', 'delete'] loop
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'leads' and policyname = 'leads_agenda_' || op) then
      execute format('create policy %I on public.leads as restrictive for %s to authenticated %s', 'leads_agenda_' || op, op,
        case op when 'update' then 'using (not (select public.agenda_member()) or public.calendar_lead(id) or user_id = (select auth.uid())) '
                                   'with check (not (select public.agenda_member()) or public.calendar_lead(id) or user_id = (select auth.uid()))'
                else 'using (not (select public.agenda_member()) or public.calendar_lead(id) or user_id = (select auth.uid()))' end);
    end if;
  end loop;
end $$;

-- ---- rollback (by hand, only to undo it) ---------------------------------------------------------------------------------------
--   run 6200's client_files_allowed_for() again (the agenda members lose the card); the policies above change nothing for anyone
--   who is not an agenda member.
