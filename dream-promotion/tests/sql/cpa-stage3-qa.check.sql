-- QA of 2.120.0 (stage 3), next to cpa-rules-stage3.check.sql, on the migrated database:
--   1. nobody but the owner of the business switches to numbering per location or sets a branch code, and nobody else reads the numbering:
--      a viewer, a "calendar" and an "agenda" member, the owner of ANOTHER business, a cashier, the public — through the functions, and
--      by writing the tables directly (document_numbering, document_series, business_locations.branch_code)
--   2. the invariants of the series over every document of a business that switched — the number's first two digits are its series'
--      code, the series is the issuing location, a series number is never of the business's old series, and a business that never
--      switched has no series row at all
-- Fixtures only, fictional: dealer number 000000091, mails *.example.test.
\set ON_ERROR_STOP 1
set client_min_messages = warning;

create or replace function pg_temp.check(ok boolean, msg text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'CHECK FAILED: %', msg; end if; end $$;
create or replace function pg_temp.refused_with(stmt text, expect text, msg text, state text default null) returns void language plpgsql as $$
begin
  execute stmt;
  raise exception 'CHECK FAILED: % (it was allowed)', msg;
exception when others then
  if sqlerrm like 'CHECK FAILED%' then raise; end if;
  if position(expect in sqlerrm) = 0 then raise exception 'CHECK FAILED: % (refused, but with "%")', msg, sqlerrm; end if;
  if state is not null and sqlstate <> state then raise exception 'CHECK FAILED: % (refused, but with sqlstate % — "%")', msg, sqlstate, sqlerrm; end if;
end $$;
create or replace function pg_temp.as_user(uid text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', uid, true), set_config('request.jwt.claim.role', 'authenticated', true);
$$;
-- refused one way or another (a permission, a policy, a rule) — and nothing changed
create or replace function pg_temp.refused(stmt text, msg text) returns void language plpgsql as $$
begin
  execute stmt;
  raise exception 'CHECK FAILED: % (it was allowed)', msg;
exception when others then
  if sqlerrm like 'CHECK FAILED%' then raise; end if;
end $$;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000694a1', 'owner@qa-694.example.test'), ('00000000-0000-0000-0000-0000000694a2', 'viewer@qa-694.example.test'),
  ('00000000-0000-0000-0000-0000000694a3', 'calendar@qa-694.example.test'), ('00000000-0000-0000-0000-0000000694a4', 'agenda@qa-694.example.test'),
  ('00000000-0000-0000-0000-0000000694a5', 'cashier@qa-694.example.test'), ('00000000-0000-0000-0000-0000000694a6', 'other@qa-694.example.test');
insert into public.businesses (id, name, slug) values ('00000000-0000-0000-0000-0000000694b1', 'QA 694', 'qa-694'), ('00000000-0000-0000-0000-0000000694b2', 'QA 694 other', 'qa-694-other');
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-0000000694b1', '00000000-0000-0000-0000-0000000694a1', 'owner', 'full'),
  ('00000000-0000-0000-0000-0000000694b1', '00000000-0000-0000-0000-0000000694a2', 'viewer', 'full'),
  ('00000000-0000-0000-0000-0000000694b1', '00000000-0000-0000-0000-0000000694a3', 'editor', 'calendar'),
  ('00000000-0000-0000-0000-0000000694b1', '00000000-0000-0000-0000-0000000694a4', 'editor', 'agenda'),
  ('00000000-0000-0000-0000-0000000694b1', '00000000-0000-0000-0000-0000000694a5', 'editor', 'register'),
  ('00000000-0000-0000-0000-0000000694b2', '00000000-0000-0000-0000-0000000694a6', 'owner', 'full');
update public.profiles set current_business_id = '00000000-0000-0000-0000-0000000694b1' where id in
  ('00000000-0000-0000-0000-0000000694a1', '00000000-0000-0000-0000-0000000694a2', '00000000-0000-0000-0000-0000000694a3', '00000000-0000-0000-0000-0000000694a4', '00000000-0000-0000-0000-0000000694a5');
update public.profiles set current_business_id = '00000000-0000-0000-0000-0000000694b2' where id = '00000000-0000-0000-0000-0000000694a6';
insert into public.register_settings (user_id, business_id, business_type, vat_rate, dealer_number, legal_name, street, city, entity_type) values
  ('00000000-0000-0000-0000-0000000694a1', '00000000-0000-0000-0000-0000000694b1', 'licensed', 18, '000000091', 'עסק לדוגמה', 'הדוגמה', 'עיר דוגמה', 'licensed_dealer'),
  ('00000000-0000-0000-0000-0000000694a6', '00000000-0000-0000-0000-0000000694b2', 'licensed', 18, '000000091', 'עסק אחר לדוגמה', 'הדוגמה', 'עיר דוגמה', 'licensed_dealer');
insert into public.business_locations (id, business_id, name) values ('00000000-0000-0000-0000-0000000694c2', '00000000-0000-0000-0000-0000000694b1', 'סניף שני');
insert into public.business_locations (id, business_id, name) values ('00000000-0000-0000-0000-0000000694c3', '00000000-0000-0000-0000-0000000694b2', 'סניף שני אחר');

-- ---- 1. the people who may not switch -------------------------------------------------------------------------------------------
-- (the functions: each refused; the cashier and the calendar member are not even let to read)
create or replace function pg_temp.try_all(p_user text) returns void language plpgsql as $q$
begin
  perform pg_temp.as_user(p_user);
  perform pg_temp.refused($$select public.document_numbering_per_location()$$, 'switch by ' || p_user);
  perform pg_temp.refused($$select public.location_branch_code_set('00000000-0000-0000-0000-0000000694c2', '09')$$, 'a code by ' || p_user);
end $q$;
begin;
set local role authenticated;
select pg_temp.try_all('00000000-0000-0000-0000-0000000694a2');   -- a viewer (read-only)
select pg_temp.try_all('00000000-0000-0000-0000-0000000694a3');   -- calendar
select pg_temp.try_all('00000000-0000-0000-0000-0000000694a4');   -- agenda
select pg_temp.try_all('00000000-0000-0000-0000-0000000694a5');   -- a cashier
select pg_temp.as_user('00000000-0000-0000-0000-0000000694a3');
select pg_temp.refused('select public.document_numbering_state()', 'a calendar member reads the numbering');
select pg_temp.as_user('00000000-0000-0000-0000-0000000694a5');
select pg_temp.refused('select public.document_numbering_state()', 'a cashier reads the numbering');
-- the owner of ANOTHER business: it is their business they switch, not this one (a location of this business is "not found" to them)
select pg_temp.as_user('00000000-0000-0000-0000-0000000694a6');
select pg_temp.refused_with($$select public.location_branch_code_set('00000000-0000-0000-0000-0000000694c2', '09')$$, 'branch_code_location', 'another business''s location');
rollback;
-- the public
begin;
set local role anon;
select pg_temp.refused($$select public.document_numbering_per_location()$$, 'the public switches');
select pg_temp.refused($$select public.location_branch_code_set('00000000-0000-0000-0000-0000000694c2', '09')$$, 'the public sets a code');
select pg_temp.refused($$select public.document_numbering_state()$$, 'the public reads the numbering');
rollback;
-- nothing changed
select pg_temp.check((select count(*) from public.document_numbering where business_id = '00000000-0000-0000-0000-0000000694b1') = 0
  and (select count(*) from public.business_locations where business_id = '00000000-0000-0000-0000-0000000694b1' and branch_code is not null) = 0,
  'no switch, no code after all those attempts');

-- the tables themselves: no browser role writes them, whoever they are
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000694a1');   -- even the owner: only through the function
select pg_temp.refused($$update public.business_locations set branch_code = '56' where id = '00000000-0000-0000-0000-0000000694c2'$$, 'the owner writes the code directly');
select pg_temp.refused($$insert into public.document_numbering (business_id, switched_by) values ('00000000-0000-0000-0000-0000000694b1', '00000000-0000-0000-0000-0000000694a1')$$, 'the owner writes document_numbering directly');
select pg_temp.refused($$insert into public.document_series (business_id, location_id, doc_type, last_no) values ('00000000-0000-0000-0000-0000000694b1', '00000000-0000-0000-0000-0000000694b1', 305, 500000)$$, 'the owner writes document_series directly');
select pg_temp.refused($$update public.document_series set last_no = 0$$, 'nor resets a series');
rollback;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000694a2');   -- a viewer
select pg_temp.refused($$update public.business_locations set branch_code = '55' where id = '00000000-0000-0000-0000-0000000694c2'$$, 'a viewer writes a location row directly (no grant: only location_branch_code_set)');
rollback;
select pg_temp.check((select branch_code from public.business_locations where id = '00000000-0000-0000-0000-0000000694c2') is null, 'the location has no code after the viewer''s update');
-- the direct update of a location's code by a member who is not the owner: refused or no row
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000694a5');   -- a cashier
select pg_temp.refused($$update public.business_locations set branch_code = '55' where id = '00000000-0000-0000-0000-0000000694c2'$$, 'a cashier writes a location row directly (no grant: only location_branch_code_set)');
rollback;
select pg_temp.check((select branch_code from public.business_locations where id = '00000000-0000-0000-0000-0000000694c2') is null, 'still no code');

-- the owner (the control): switches, and then the others still cannot read or change the series
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000694a1');
select pg_temp.check((public.document_numbering_per_location() ->> 'perLocation')::boolean, 'the owner switches');
commit;
select pg_temp.check((select string_agg(branch_code, ',' order by branch_code) from public.business_locations where business_id = '00000000-0000-0000-0000-0000000694b1') = '01,02', 'codes 01, 02');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000694a5');
select pg_temp.check((select count(*) from public.document_numbering) = 0 and (select count(*) from public.document_series) = 0, 'a cashier reads no numbering row and no series');
select pg_temp.as_user('00000000-0000-0000-0000-0000000694a6');
select pg_temp.check((select count(*) from public.document_numbering where business_id = '00000000-0000-0000-0000-0000000694b1') = 0, 'the owner of another business reads none of it');
rollback;

-- ---- 2. the invariants over every document of every business ----------------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000694a1');
select public.document_numbering_per_location();
insert into public.documents (user_id, doc_type, doc_number, doc_date, before_discount, discount, after_discount, vat_amount, total, vat_rate, lines, idempotency_key, location_id)
select '00000000-0000-0000-0000-0000000694a1', 300, 0, public.il_today(), 100, 0, 100, 18, 118, 18, '[{"name":"x","qty":1,"totalExVat":100}]', 'q694:' || l, l::uuid
  from unnest(array['00000000-0000-0000-0000-0000000694b1', '00000000-0000-0000-0000-0000000694c2']) l;
commit;
select pg_temp.check((select string_agg(lpad(doc_number::text, 8, '0'), ',' order by doc_number) from public.documents where idempotency_key like 'q694:%') = '01000001,02000001', 'one document in each location: 01000001 and 02000001');
select pg_temp.check(not exists (select 1 from public.documents d join public.business_locations l on l.id = d.series_location_id
                                   where floor(d.doc_number / 1000000)::int <> l.branch_code::int),
  'EVERY document of the database: the first two digits of a series number are its series'' location''s code');
select pg_temp.check(not exists (select 1 from public.documents d where d.series_location_id is not null and (d.doc_number < 1000001 or d.doc_number > 99999999)),
  'a series number is 1,000,001 to 99,999,999 — never in the old series (below a million)');
select pg_temp.check(not exists (select 1 from public.documents d where d.series_location_id is null and d.doc_number >= 1000000
                                   and exists (select 1 from public.document_numbering n where n.business_id = d.business_id and d.issued_at > n.per_location_since)),
  'after a business switched, no new document is numbered in its old series');
select pg_temp.check(not exists (select 1 from public.documents d where d.series_location_id is not null
                                   and d.series_location_id is distinct from coalesce(d.location_id, d.business_id)
                                   and d.doc_type not in (200, 210, 305, 320, 300, 400, 100)),
  'a document is in the series of its own location (the types that follow their base aside)');
select pg_temp.check(not exists (select 1 from public.document_series s where not exists (select 1 from public.document_numbering n where n.business_id = s.business_id)),
  'a business that never switched has no series row');
select pg_temp.check(not exists (select 1 from public.document_series s join public.business_locations l on l.id = s.location_id
                                  where s.last_no <> (select count(*) from public.documents d where d.series_location_id = s.location_id and d.doc_type = s.doc_type)
                                    and exists (select 1 from public.documents d2 where d2.series_location_id = s.location_id and d2.doc_type = s.doc_type and d2.business_id = s.business_id)
                                    and s.business_id = '00000000-0000-0000-0000-0000000694b1'),
  'the series counter = how many documents the location issued of the type (QA 694)');
