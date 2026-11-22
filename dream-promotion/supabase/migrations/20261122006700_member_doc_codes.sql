-- 2.117.0 — a short code for every person of a business, for field 1233 of the uniform file (tests/sql/member-doc-codes.check.sql).
-- The owner of the system (22.11.2026): field 1233 ("the user name of who performed the action", X(9)) carries a short code per
-- person in the business (U01, U02 … U99, U100 …) — never a personal detail. A code is stable: it never changes, is never deleted,
-- never moves to another person — also after the person was removed from the business.
--   member_doc_codes: one row per (business, person); the code = 'U' + a running number of the business, at least 2 digits.
--   Only added: update, delete and truncate are refused (member_doc_codes_locked), for every role.
--   Given by the database only (security definer, in the business's lock — two people added at once get two numbers):
--     * a new member (AFTER INSERT on business_members), * whoever issues a document in a business (AFTER INSERT on documents —
--       e.g. the super admin, who is not a member), * the people of today, below (section 4): every member and everyone who issued
--       a document in the business, in the order they came (joined, or their first document), then by user_id.
--     member_doc_code_assign(business, person) — the code (the existing one, or a new one); the server's only (service_role).
--   The browser reads (a finance member of the business — like the money tables: _business_gate, _finance_privacy, _cashier_none,
--   _calendar_only) and never writes.
-- New table, functions and triggers only: no existing row of another table changes; no function is replaced.
-- Runs after 1900 (business_members), 2000 (documents.business_id), 3100 (finance_business_ids) and 6000 (calendar_member, my_access).

do $$
begin
  if to_regclass('public.business_members') is null or to_regclass('public.documents') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'documents' and column_name = 'business_id')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'business_members' and column_name = 'created_at') then
    raise exception 'migration 20261122006700 runs after 20261004001900 and 20261004002000 (businesses, documents by business) — run them first; nothing was changed';
  end if;
  if to_regprocedure('public.finance_business_ids()') is null or to_regprocedure('public.accessible_business_ids()') is null
     or to_regprocedure('public.current_business_id()') is null then
    raise exception 'migration 20261122006700 runs after 20261004003100 (Dream Finance) — run that one first; nothing was changed';
  end if;
  if to_regprocedure('public.calendar_member()') is null or to_regprocedure('public.my_access()') is null then
    raise exception 'migration 20261122006700 runs after 20261028006000 (calendar access) — run that one first; nothing was changed';
  end if;
end $$;

-- ---- 1. the codes --------------------------------------------------------------------------------------------------------------
create table if not exists public.member_doc_codes (
  business_id uuid not null references public.businesses on delete restrict,
  user_id     uuid not null,                 -- no foreign key: the code stays after the person (or their account) is gone
  code        text not null check (length(code) <= 9 and code ~ '^U(0[1-9]|[1-9][0-9]{1,7})$'),
  created_at  timestamptz not null default now(),
  primary key (business_id, user_id),
  unique (business_id, code)
);

-- only added: never changed, never removed, never emptied — whoever asks (the server and the SQL Editor too)
create or replace function public.member_doc_codes_locked() returns trigger
language plpgsql set search_path = public as $$
begin
  raise exception 'member_doc_codes is append-only: a code never changes, moves or goes away' using errcode = '42501';
end $$;
revoke execute on function public.member_doc_codes_locked() from public, anon, authenticated;
create or replace trigger member_doc_codes_append_only before update or delete on public.member_doc_codes
  for each row execute function public.member_doc_codes_locked();
create or replace trigger member_doc_codes_no_truncate before truncate on public.member_doc_codes
  for each statement execute function public.member_doc_codes_locked();

-- ---- 2. who gets one -----------------------------------------------------------------------------------------------------------
-- the person's code in the business: the existing one, or the next number — in the business's lock, so two at once never take the
-- same number
create or replace function public.member_doc_code_assign(p_business uuid, p_user uuid) returns text
language plpgsql security definer set search_path = public as $$
declare c text; n int;
begin
  if p_business is null or p_user is null then return null; end if;
  select m.code into c from public.member_doc_codes m where m.business_id = p_business and m.user_id = p_user;
  if c is not null then return c; end if;
  perform pg_advisory_xact_lock(hashtextextended('member_doc_codes:' || p_business::text, 0));
  select m.code into c from public.member_doc_codes m where m.business_id = p_business and m.user_id = p_user;
  if c is not null then return c; end if;
  select coalesce(max(substr(m.code, 2)::int), 0) + 1 into n from public.member_doc_codes m where m.business_id = p_business;
  c := 'U' || case when n < 10 then '0' || n::text else n::text end;
  insert into public.member_doc_codes (business_id, user_id, code) values (p_business, p_user, c);
  return c;
end $$;
revoke execute on function public.member_doc_code_assign(uuid, uuid) from public, anon, authenticated;
grant execute on function public.member_doc_code_assign(uuid, uuid) to service_role;

create or replace function public.member_doc_codes_on_member() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.member_doc_code_assign(new.business_id, new.user_id);
  return null;
end $$;
revoke execute on function public.member_doc_codes_on_member() from public, anon, authenticated;
create or replace trigger member_doc_codes_on_member after insert on public.business_members
  for each row execute function public.member_doc_codes_on_member();

create or replace function public.member_doc_codes_on_document() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.member_doc_code_assign(new.business_id, new.user_id);
  return null;
end $$;
revoke execute on function public.member_doc_codes_on_document() from public, anon, authenticated;
create or replace trigger member_doc_codes_on_document after insert on public.documents
  for each row execute function public.member_doc_codes_on_document();

-- ---- 3. who reads them: a finance member of the business (never a cashier, never a calendar member); nobody writes them ---------
do $$
declare
  t constant text := 'member_doc_codes';
  gate        constant text := 'business_id = (select public.current_business_id()) and business_id in (select public.accessible_business_ids())';
  fin         constant text := 'business_id in (select public.finance_business_ids())';
  full_access constant text := '(select public.my_access()) <> ''register''';
  cal         constant text := 'not (select public.calendar_member())';
begin
  execute format('alter table public.%I enable row level security', t);
  execute format('revoke all on public.%I from public, anon', t);
  execute format('revoke insert, update, delete, truncate, references, trigger on public.%I from authenticated, service_role', t);
  execute format('grant select on public.%I to authenticated, service_role', t);
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_business_gate') then
    execute format('create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)', t || '_business_gate', t, gate, gate);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_finance_privacy') then
    execute format('create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)', t || '_finance_privacy', t, fin, fin);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_cashier_none') then
    execute format('create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)', t || '_cashier_none', t, full_access, full_access);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_calendar_only') then
    execute format('create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)', t || '_calendar_only', t, cal, cal);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_business_read') then
    execute format('create policy %I on public.%I for select to authenticated using (%s)', t || '_business_read', t, gate);
  end if;
end $$;

-- ---- 4. the people of today: every member, and everyone who issued a document in the business — in the order they came ----------
-- (only new rows; a person who already has a code keeps it — running this again changes nothing)
do $$
declare r record;
begin
  for r in
    select x.business_id, x.user_id
      from (select m.business_id, m.user_id, m.created_at as since from public.business_members m
            union all
            select d.business_id, d.user_id, min(d.issued_at) from public.documents d
             where d.business_id is not null and d.user_id is not null group by d.business_id, d.user_id) x
     where not exists (select 1 from public.member_doc_codes c where c.business_id = x.business_id and c.user_id = x.user_id)
     group by x.business_id, x.user_id
     order by x.business_id, min(x.since), x.user_id
  loop
    perform public.member_doc_code_assign(r.business_id, r.user_id);
  end loop;
end $$;

-- ---- rollback (by hand, only to undo it — the codes are on documents' files already sent; think twice) -------------------------
--   drop trigger if exists member_doc_codes_on_member on public.business_members;
--   drop trigger if exists member_doc_codes_on_document on public.documents;
--   drop function if exists public.member_doc_codes_on_member(), public.member_doc_codes_on_document(),
--     public.member_doc_code_assign(uuid, uuid);
--   drop table if exists public.member_doc_codes;   -- its triggers go with it (truncate/delete are refused, drop is not)
--   drop function if exists public.member_doc_codes_locked();
