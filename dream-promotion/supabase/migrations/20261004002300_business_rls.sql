-- ============================================================================
-- Migration 20261004002300 — multi-business, stage 4: access by business (RLS). Additive only.
--   is_super_admin()            the caller is the platform owner
--   business_is_active(bid)     status 'active' AND (paid_until is null OR today in Israel <= paid_until + grace_days)
--   can_access_business(bid)    super admin (any business, locked or not), or a member of an ACTIVE business
--   accessible_business_ids()   the same as a set — evaluated once per query, so policies stay fast
-- Every one of the 23 tables with business_id gets:
--   * a permissive policy "<table>_business": members of the business may use rows of their business
--     (same commands the table already allowed — select-only tables stay select-only, documents keep
--     no delete, server-only tables get none);
--   * a RESTRICTIVE policy "<table>_business_gate": whatever other policy matches, the row's business
--     must be accessible. This is what locks a business — the old "user_id = auth.uid()" policies stay
--     (no drop) but can no longer open a locked business or another business's rows.
-- businesses / business_members: members read their own; only the super admin writes (owner too can not
-- change status, paid_until, lock or members). profiles: quotas and usage counters can no longer be
-- changed from the browser (same trigger that guards is_super_admin).
-- Policies are for the role "authenticated" only: anon (public pages) never evaluates them — those pages
-- go through the server, which checks business_is_active itself.
-- Idempotent. Rollback: drop the policies named *_business, *_business_gate, businesses_*, business_members_*,
-- and the four functions; restore profiles_guard_super_admin from 20261004001900.
-- ============================================================================

-- ---- access functions ----------------------------------------------------------
create or replace function public.is_super_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select p.is_super_admin from public.profiles p where p.id = auth.uid()), false);
$$;

create or replace function public.business_is_active(bid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select b.status = 'active'
       and (b.paid_until is null
            or (now() at time zone 'Asia/Jerusalem')::date <= b.paid_until + b.grace_days)
      from public.businesses b where b.id = bid), false);
$$;

create or replace function public.can_access_business(bid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select bid is not null and (
    public.is_super_admin()
    or (exists (select 1 from public.business_members m where m.business_id = bid and m.user_id = auth.uid())
        and public.business_is_active(bid)));
$$;

create or replace function public.accessible_business_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select b.id from public.businesses b where public.is_super_admin()
  union
  select m.business_id from public.business_members m
   where m.user_id = auth.uid() and public.business_is_active(m.business_id);
$$;

revoke execute on function public.is_super_admin(), public.business_is_active(uuid),
  public.can_access_business(uuid), public.accessible_business_ids() from public, anon;
grant execute on function public.is_super_admin(), public.business_is_active(uuid),
  public.can_access_business(uuid), public.accessible_business_ids() to authenticated, service_role;

-- ---- businesses / business_members: read own, write = super admin only ---------------
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'businesses' and policyname = 'businesses_member_read') then
    create policy businesses_member_read on public.businesses for select to authenticated
      using (id in (select m.business_id from public.business_members m where m.user_id = auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'businesses' and policyname = 'businesses_super_admin') then
    create policy businesses_super_admin on public.businesses for all to authenticated
      using ((select public.is_super_admin())) with check ((select public.is_super_admin()));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'business_members' and policyname = 'business_members_self_read') then
    create policy business_members_self_read on public.business_members for select to authenticated
      using (user_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'business_members' and policyname = 'business_members_super_admin') then
    create policy business_members_super_admin on public.business_members for all to authenticated
      using ((select public.is_super_admin())) with check ((select public.is_super_admin()));
  end if;
end $$;

-- ---- the 23 business tables ----------------------------------------------------------
do $$
declare
  t text; op text;
  rule constant text := 'business_id in (select public.accessible_business_ids())';
  -- unassigned assets (business_id null) are visible to the super admin only
  asset_rule constant text := '(business_id in (select public.accessible_business_ids()) or (business_id is null and (select public.is_super_admin())))';
  r text;
  tables constant text[] := array[
    'ad_drafts','ai_generations','appointments','booking_services','booking_settings','brands','catalog_items',
    'content','document_counters','documents','employees','lead_activities','leads','media','register_settings',
    'register_shifts','sales','scheduled_posts','social_accounts','social_posts','time_entries','timeclock_settings','usage'];
  all_cmds constant text[] := array[
    'ad_drafts','appointments','booking_services','booking_settings','brands','catalog_items','content','employees',
    'lead_activities','leads','media','register_settings','register_shifts','sales','time_entries','timeclock_settings'];
  read_only constant text[] := array['document_counters','social_posts','usage','social_accounts'];
begin
  foreach t in array tables loop
    if to_regclass('public.' || t) is null then continue; end if;
    r := case when t = 'social_accounts' then asset_rule else rule end;

    -- the gate: every row a signed-in user touches must belong to a business they may access
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_business_gate') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)',
        t || '_business_gate', t, r, r);
    end if;

    -- members of the business share its rows (same commands as before)
    if t = any (all_cmds) then
      if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_business') then
        execute format('create policy %I on public.%I for all to authenticated using (%s) with check (%s)', t || '_business', t, r, r);
      end if;
    elsif t = any (read_only) then
      if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_business') then
        execute format('create policy %I on public.%I for select to authenticated using (%s)', t || '_business', t, r);
      end if;
    elsif t = 'documents' then
      -- issued documents are never deleted (documents_immutable); members may read, issue and print
      foreach op in array array['select','insert','update'] loop
        if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_business_' || op) then
          execute format('create policy %I on public.%I for %s to authenticated %s', t || '_business_' || op, t, op,
            case op when 'select' then format('using (%s)', r)
                     when 'insert' then format('with check (%s)', r)
                     else format('using (%s) with check (%s)', r, r) end);
        end if;
      end loop;
    end if;
    -- ai_generations, scheduled_posts: server only (no client policy, as before) — the gate still applies
  end loop;
end $$;

-- ---- profiles: quotas and usage are not the user's to change --------------------------
create or replace function public.profiles_guard_super_admin() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user in ('anon', 'authenticated') then
    if (tg_op = 'INSERT' and new.is_super_admin)
       or (tg_op = 'UPDATE' and new.is_super_admin is distinct from old.is_super_admin) then
      raise exception 'is_super_admin can only be changed by the platform administrator' using errcode = '42501';
    end if;
    if (tg_op = 'INSERT' and (new.clip_quota > 20 or new.image_quota > 200 or new.clips_used <> 0 or new.images_used <> 0))
       or (tg_op = 'UPDATE' and (new.clip_quota is distinct from old.clip_quota
                              or new.image_quota is distinct from old.image_quota
                              or new.clips_used is distinct from old.clips_used
                              or new.images_used is distinct from old.images_used
                              or new.quota_reset_at is distinct from old.quota_reset_at)) then
      raise exception 'quotas can only be changed by the platform administrator' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.profiles_guard_super_admin() from public, anon, authenticated;
