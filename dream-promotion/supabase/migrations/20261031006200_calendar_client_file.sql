-- 2.111.0 — the client file for a calendar member ("יומן ולידים", 6000) (tests/sql/calendar-client-file.check.sql).
-- The owner of the system (31.10.2026, SaGabot): Gal and Karin see and work in the client's card like Sagit — photos before and
-- after, health declarations, treatments and the timeline, and the messages from Facebook / Instagram — everything but money.
--   client_files_allowed_for: a calendar member of the business is allowed (as a practitioner the owner marked). The owner's
--   parts stay the owner's (client_file_owner_for — approving templates, marking practitioners, the views log, purging).
--   The client-file tables and the messages are opened for them (alter policy on 6000's "<table>_calendar_only" — no drop);
--   money stays closed: packages and their uses, documents, payments — every finance table, as before.
-- Replaces client_files_allowed_for() of 4100 — running 4100 again brings the old one back: run 6200 again.
-- Additions only: no row changes. Runs after 6000 and 4100.

do $$ begin
  if to_regprocedure('public.calendar_member()') is null or to_regprocedure('public.client_files_allowed_for(uuid, uuid)') is null then
    raise exception 'run migrations 20261009004100 (client file) and 20261028006000 (calendar access) first';
  end if;
end $$;

-- 4100's, and a calendar member of the business too (never a cashier)
create or replace function public.client_files_allowed_for(p_user uuid, p_business uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select p_user is not null and p_business is not null and public.business_is_active(p_business)
     and exists (select 1 from public.business_members m
                  where m.business_id = p_business and m.user_id = p_user
                    and (m.access = 'calendar'
                         or (m.access = 'full'
                             and (m.role = 'owner'
                                  or exists (select 1 from public.client_file_access a
                                              where a.business_id = p_business and a.user_id = p_user and a.revoked_at is null)))));
$$;
revoke execute on function public.client_files_allowed_for(uuid, uuid) from public, anon, authenticated;
grant execute on function public.client_files_allowed_for(uuid, uuid) to service_role;

-- the client file and the messages: 6000's rule for a calendar member opened — their own rules (client_files_allowed(), the
-- business, no delete of a declaration …) still apply
do $$
declare t text;
begin
  foreach t in array array['client_photos', 'client_sessions', 'client_treatments', 'treatment_types', 'declarations',
                           'declaration_requests', 'declaration_templates', 'social_messages'] loop
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_calendar_only') then
      execute format('alter policy %I on public.%I using (not (select public.calendar_member()) or (select public.client_files_allowed())) '
                     'with check (not (select public.calendar_member()) or (select public.client_files_allowed()))', t || '_calendar_only', t);
    end if;
  end loop;
  -- the messages: 3000's cashier rule — a calendar member reads them (the reply goes through the server)
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'social_messages' and policyname = 'social_messages_cashier_none') then
    alter policy social_messages_cashier_none on public.social_messages
      using ((select public.my_access()) <> 'register' or (select public.calendar_member()))
      with check ((select public.my_access()) <> 'register' or (select public.calendar_member()));
  end if;
end $$;

-- ---- rollback (by hand, only to undo it) ---------------------------------------------------------------------------------------
--   run 4100's client_files_allowed_for() again, and for each table above:
--   alter policy <t>_calendar_only on public.<t> using (not (select public.calendar_member())) with check (not (select public.calendar_member()));
--   alter policy social_messages_cashier_none on public.social_messages using ((select public.my_access()) <> 'register')
--     with check ((select public.my_access()) <> 'register');
