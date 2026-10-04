-- ============================================================================
-- Migration 20261004002500 — multi-business, stage 7: every screen shows the CURRENT business only.
--   current_business_id()  the business the caller works in now (profiles.current_business_id when allowed,
--                          else their first membership) — same as business_for_user(auth.uid())
-- The 23 "<table>_business_gate" policies (stage 4) are narrowed with ALTER POLICY (nothing dropped):
-- a signed-in user reads and writes only rows of the business they work in now, and only while it is
-- accessible (super admin, or a member of an active business). Switching business = updating
-- profiles.current_business_id (POST /api/business/me), so the app needs no per-screen filter.
-- Also: appointments can not overlap within one business (the old rule was per user).
-- Idempotent. Rollback: re-run the gate loop of 20261004002300 (ALTER POLICY back to accessible_business_ids()).
-- ============================================================================
create or replace function public.current_business_id() returns uuid
language sql stable security definer set search_path = public as $$
  select public.business_for_user(auth.uid());
$$;
revoke execute on function public.current_business_id() from public, anon;
grant execute on function public.current_business_id() to authenticated, service_role;

do $$
declare
  t text;
  rule constant text := 'business_id = (select public.current_business_id()) and business_id in (select public.accessible_business_ids())';
  -- unassigned assets (business_id null) stay visible to the super admin
  asset_rule constant text := '(business_id = (select public.current_business_id()) and business_id in (select public.accessible_business_ids())) or (business_id is null and (select public.is_super_admin()))';
  r text;
begin
  for t in select tablename from pg_policies where schemaname = 'public' and policyname = tablename || '_business_gate' loop
    r := case when t = 'social_accounts' then asset_rule else rule end;
    execute format('alter policy %I on public.%I using (%s) with check (%s)', t || '_business_gate', t, r, r);
  end loop;
end $$;

-- no two active appointments of one business at the same time (whoever booked them)
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'appointments_business_no_overlap') then
    alter table public.appointments add constraint appointments_business_no_overlap
      exclude using gist (business_id with =, tstzrange(start_at, end_at, '[)') with &&)
      where (status in ('booked', 'confirmed'));
  end if;
end $$;
