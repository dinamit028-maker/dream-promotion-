-- The codes of field 1233 (2.117, migration 6700) on a real Postgres (tests/sql/run.sh): every person of a business gets a short
-- code (U01, U02 …), running per business, stable — never changed, removed or moved, also after the person left the business.
-- The people of "before": rows written with the triggers off (as if before 6700), then the migration again — its section 4.
-- Fixtures only (fictional people, *.example.test):
--   "Salon"  A: a1 owner (3 days ago), a2 editor (2 days ago), ax — left already, issued documents (first 40 hours ago),
--              a3 cashier (1 day ago)
--   "Studio" B: b1 owner (5 days ago), a1 editor too (3 days ago), b2 calendar (1 day ago)
\set ON_ERROR_STOP 1
set client_min_messages = warning;

create or replace function pg_temp.check(ok boolean, msg text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'CHECK FAILED: %', msg; end if; end $$;
create or replace function pg_temp.refused(stmt text, msg text) returns void language plpgsql as $$
begin
  execute stmt;
  raise exception 'CHECK FAILED: % (it was allowed)', msg;
exception when others then
  if sqlerrm like 'CHECK FAILED%' then raise; end if;
end $$;
create or replace function pg_temp.as_user(uid text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', uid, true), set_config('request.jwt.claim.role', 'authenticated', true);
$$;
create or replace function pg_temp.code(b text, u text) returns text language sql as $$
  select code from public.member_doc_codes where business_id = b::uuid and user_id = u::uuid;
$$;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000670a1', 'a1@salon-67.example.test'), ('00000000-0000-0000-0000-0000000670a2', 'a2@salon-67.example.test'),
  ('00000000-0000-0000-0000-0000000670a3', 'a3@salon-67.example.test'), ('00000000-0000-0000-0000-0000000670a4', 'a4@salon-67.example.test'),
  ('00000000-0000-0000-0000-0000000670a5', 'a5@salon-67.example.test'), ('00000000-0000-0000-0000-0000000670a6', 'a6@salon-67.example.test'),
  ('00000000-0000-0000-0000-0000000670af', 'ax@salon-67.example.test'),
  ('00000000-0000-0000-0000-0000000670b1', 'b1@studio-67.example.test'), ('00000000-0000-0000-0000-0000000670b2', 'b2@studio-67.example.test'),
  ('00000000-0000-0000-0000-0000000670e1', 'admin@platform-67.example.test');
update public.profiles set is_super_admin = true where id = '00000000-0000-0000-0000-0000000670e1';
insert into public.businesses (id, name, slug) values
  ('00000000-0000-0000-0000-00000067b001', 'Salon', 'salon-67'), ('00000000-0000-0000-0000-00000067b002', 'Studio', 'studio-67'),
  ('00000000-0000-0000-0000-00000067b003', 'Big', 'big-67');

-- ---- before 6700: members and documents, no code (every trigger off, as on the live database today) ------------------------
set session_replication_role = replica;
insert into public.business_members (business_id, user_id, role, access, created_at) values
  ('00000000-0000-0000-0000-00000067b001', '00000000-0000-0000-0000-0000000670a1', 'owner',  'full',     now() - interval '3 days'),
  ('00000000-0000-0000-0000-00000067b001', '00000000-0000-0000-0000-0000000670a2', 'editor', 'full',     now() - interval '2 days'),
  ('00000000-0000-0000-0000-00000067b001', '00000000-0000-0000-0000-0000000670a3', 'editor', 'register', now() - interval '1 day'),
  ('00000000-0000-0000-0000-00000067b002', '00000000-0000-0000-0000-0000000670b1', 'owner',  'full',     now() - interval '5 days'),
  ('00000000-0000-0000-0000-00000067b002', '00000000-0000-0000-0000-0000000670a1', 'editor', 'full',     now() - interval '3 days'),
  ('00000000-0000-0000-0000-00000067b002', '00000000-0000-0000-0000-0000000670b2', 'editor', 'calendar', now() - interval '1 day');
insert into public.documents (id, user_id, business_id, doc_type, doc_number, doc_date, issued_at, before_discount, after_discount, vat_amount, total, vat_rate) values
  ('00000000-0000-0000-0000-00000067d001', '00000000-0000-0000-0000-0000000670af', '00000000-0000-0000-0000-00000067b001', 320, 1,
   current_date - 2, now() - interval '40 hours', 100, 100, 18, 118, 18),
  ('00000000-0000-0000-0000-00000067d002', '00000000-0000-0000-0000-0000000670af', '00000000-0000-0000-0000-00000067b001', 320, 2,
   current_date - 2, now() - interval '30 hours', 100, 100, 18, 118, 18),
  ('00000000-0000-0000-0000-00000067d003', '00000000-0000-0000-0000-0000000670b1', '00000000-0000-0000-0000-00000067b002', 320, 1,
   current_date - 4, now() - interval '4 days', 100, 100, 18, 118, 18);
reset session_replication_role;
select pg_temp.check((select count(*) from public.member_doc_codes where business_id in
  ('00000000-0000-0000-0000-00000067b001', '00000000-0000-0000-0000-00000067b002')) = 0, 'before: no code yet');
create temp table docs_before as select * from public.documents where business_id in
  ('00000000-0000-0000-0000-00000067b001', '00000000-0000-0000-0000-00000067b002');
create temp table members_before as select * from public.business_members where business_id in
  ('00000000-0000-0000-0000-00000067b001', '00000000-0000-0000-0000-00000067b002');
create temp table codes_others as select * from public.member_doc_codes;

-- ---- the migration: everyone of today, in the order they came, per business ---------------------------------------------------
\i supabase/migrations/20261122006700_member_doc_codes.sql
select pg_temp.check(pg_temp.code('00000000-0000-0000-0000-00000067b001', '00000000-0000-0000-0000-0000000670a1') = 'U01', 'A: a1 first');
select pg_temp.check(pg_temp.code('00000000-0000-0000-0000-00000067b001', '00000000-0000-0000-0000-0000000670a2') = 'U02', 'A: a2 second');
select pg_temp.check(pg_temp.code('00000000-0000-0000-0000-00000067b001', '00000000-0000-0000-0000-0000000670af') = 'U03', 'A: ax (documents only, not a member) — by the first document');
select pg_temp.check(pg_temp.code('00000000-0000-0000-0000-00000067b001', '00000000-0000-0000-0000-0000000670a3') = 'U04', 'A: the cashier too');
select pg_temp.check(pg_temp.code('00000000-0000-0000-0000-00000067b002', '00000000-0000-0000-0000-0000000670b1') = 'U01', 'B runs by itself: b1 first');
select pg_temp.check(pg_temp.code('00000000-0000-0000-0000-00000067b002', '00000000-0000-0000-0000-0000000670a1') = 'U02', 'B: a1 has another code there');
select pg_temp.check(pg_temp.code('00000000-0000-0000-0000-00000067b002', '00000000-0000-0000-0000-0000000670b2') = 'U03', 'B: the calendar member too');
select pg_temp.check((select count(*) from public.member_doc_codes where business_id = '00000000-0000-0000-0000-00000067b001') = 4
  and (select count(*) from public.member_doc_codes where business_id = '00000000-0000-0000-0000-00000067b002') = 3, 'nobody else');
select pg_temp.check(not exists (select * from docs_before except select * from public.documents)
  and not exists (select * from public.documents where business_id in ('00000000-0000-0000-0000-00000067b001', '00000000-0000-0000-0000-00000067b002')
                  except select * from docs_before), 'the documents as they were');
select pg_temp.check(not exists (select * from members_before except select * from public.business_members)
  and not exists (select * from public.business_members where business_id in ('00000000-0000-0000-0000-00000067b001', '00000000-0000-0000-0000-00000067b002')
                  except select * from members_before), 'the members as they were');
select pg_temp.check(not exists (select * from codes_others except select * from public.member_doc_codes), 'the codes of the other businesses as they were');

-- running it again changes nothing
create temp table codes_once as select * from public.member_doc_codes;
\i supabase/migrations/20261122006700_member_doc_codes.sql
select pg_temp.check(not exists (select * from codes_once except select * from public.member_doc_codes)
  and not exists (select * from public.member_doc_codes except select * from codes_once), 'idempotent: the same codes');
select pg_temp.check((select count(*) from pg_policies where tablename = 'member_doc_codes') = 5, 'idempotent: five policies');

-- ---- a new member gets the next one; a person who left keeps theirs; back again — the same one -------------------------------
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-00000067b001', '00000000-0000-0000-0000-0000000670a4', 'editor', 'full');
select pg_temp.check(pg_temp.code('00000000-0000-0000-0000-00000067b001', '00000000-0000-0000-0000-0000000670a4') = 'U05', 'a new member: the next');
delete from public.business_members where business_id = '00000000-0000-0000-0000-00000067b001' and user_id = '00000000-0000-0000-0000-0000000670a2';
select pg_temp.check(pg_temp.code('00000000-0000-0000-0000-00000067b001', '00000000-0000-0000-0000-0000000670a2') = 'U02', 'removed: the code stays');
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-00000067b001', '00000000-0000-0000-0000-0000000670a2', 'editor', 'full');
select pg_temp.check(pg_temp.code('00000000-0000-0000-0000-00000067b001', '00000000-0000-0000-0000-0000000670a2') = 'U02'
  and (select count(*) from public.member_doc_codes where business_id = '00000000-0000-0000-0000-00000067b001') = 5, 'back again: the same code, no new one');
-- the same in an upsert (the super admin's route)
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-00000067b001', '00000000-0000-0000-0000-0000000670a2', 'editor', 'register')
  on conflict (business_id, user_id) do update set access = excluded.access;
select pg_temp.check((select count(*) from public.member_doc_codes where business_id = '00000000-0000-0000-0000-00000067b001') = 5, 'an upsert: nothing new');
update public.business_members set access = 'full' where business_id = '00000000-0000-0000-0000-00000067b001' and user_id = '00000000-0000-0000-0000-0000000670a2';

-- ---- a document of someone who is not a member (the super admin) — a code in that business ------------------------------------
begin;
alter table public.documents disable trigger user;
alter table public.documents enable trigger member_doc_codes_on_document;
insert into public.documents (id, user_id, business_id, doc_type, doc_number, doc_date, before_discount, after_discount, vat_amount, total, vat_rate) values
  ('00000000-0000-0000-0000-00000067d004', '00000000-0000-0000-0000-0000000670e1', '00000000-0000-0000-0000-00000067b002', 320, 2,
   current_date, 100, 100, 18, 118, 18);
select pg_temp.check(pg_temp.code('00000000-0000-0000-0000-00000067b002', '00000000-0000-0000-0000-0000000670e1') = 'U04', 'a document by a non-member: the next code there');
insert into public.documents (id, user_id, business_id, doc_type, doc_number, doc_date, before_discount, after_discount, vat_amount, total, vat_rate) values
  ('00000000-0000-0000-0000-00000067d005', '00000000-0000-0000-0000-0000000670b1', '00000000-0000-0000-0000-00000067b002', 320, 3,
   current_date, 100, 100, 18, 118, 18);
select pg_temp.check((select count(*) from public.member_doc_codes where business_id = '00000000-0000-0000-0000-00000067b002') = 4, 'a member''s document: no new code');
rollback;

-- ---- never changed, removed or emptied — whoever asks ----------------------------------------------------------------------
select pg_temp.refused($$update public.member_doc_codes set code = 'U99' where business_id = '00000000-0000-0000-0000-00000067b001'
  and user_id = '00000000-0000-0000-0000-0000000670a1'$$, 'update (SQL Editor)');
select pg_temp.refused($$update public.member_doc_codes set user_id = '00000000-0000-0000-0000-0000000670a4' where business_id = '00000000-0000-0000-0000-00000067b001'
  and user_id = '00000000-0000-0000-0000-0000000670a2'$$, 'moved to another person');
select pg_temp.refused($$delete from public.member_doc_codes where business_id = '00000000-0000-0000-0000-00000067b001'$$, 'delete (SQL Editor)');
select pg_temp.refused($$truncate public.member_doc_codes$$, 'truncate (SQL Editor)');
select pg_temp.refused($$insert into public.member_doc_codes (business_id, user_id, code) values
  ('00000000-0000-0000-0000-00000067b001', '00000000-0000-0000-0000-0000000670a5', 'U05')$$, 'a code twice in a business');
select pg_temp.refused($$insert into public.member_doc_codes (business_id, user_id, code) values
  ('00000000-0000-0000-0000-00000067b001', '00000000-0000-0000-0000-0000000670a5', 'U1')$$, 'one digit');
select pg_temp.refused($$insert into public.member_doc_codes (business_id, user_id, code) values
  ('00000000-0000-0000-0000-00000067b001', '00000000-0000-0000-0000-0000000670a5', 'U123456789')$$, 'more than 9 characters');
select pg_temp.refused($$insert into public.member_doc_codes (business_id, user_id, code) values
  ('00000000-0000-0000-0000-00000067b001', '00000000-0000-0000-0000-0000000670a5', 'Dana')$$, 'a name');
begin;
set local role service_role;
select pg_temp.refused($$update public.member_doc_codes set code = 'U98'$$, 'update (the server)');
select pg_temp.refused($$delete from public.member_doc_codes$$, 'delete (the server)');
select pg_temp.refused($$truncate public.member_doc_codes$$, 'truncate (the server)');
select pg_temp.refused($$insert into public.member_doc_codes (business_id, user_id, code) values
  ('00000000-0000-0000-0000-00000067b001', '00000000-0000-0000-0000-0000000670a5', 'U77')$$, 'insert by hand (the server)');
select pg_temp.check(public.member_doc_code_assign('00000000-0000-0000-0000-00000067b001', '00000000-0000-0000-0000-0000000670a1') = 'U01', 'the server asks: the existing code');
commit;
select pg_temp.check((select count(*) from public.member_doc_codes where business_id = '00000000-0000-0000-0000-00000067b001') = 5, 'still 5');

-- ---- the format: U01 … U09, U10 … U99, U100 ----------------------------------------------------------------------------------
select public.member_doc_code_assign('00000000-0000-0000-0000-00000067b003', gen_random_uuid()) from generate_series(1, 100);
select pg_temp.check((select array_agg(code order by created_at, substr(code, 2)::int) from public.member_doc_codes
  where business_id = '00000000-0000-0000-0000-00000067b003' and code in ('U01', 'U09', 'U10', 'U99', 'U100')) = array['U01', 'U09', 'U10', 'U99', 'U100'], 'U01 … U100');
select pg_temp.check((select count(distinct code) from public.member_doc_codes where business_id = '00000000-0000-0000-0000-00000067b003') = 100
  and (select max(length(code)) from public.member_doc_codes where business_id = '00000000-0000-0000-0000-00000067b003') = 4, '100 codes, none twice');

-- ---- two people added at the same moment, from two connections: two numbers -----------------------------------------------------
create extension if not exists dblink;
select dblink_connect('c67a', 'dbname=' || current_database());
select dblink_connect('c67b', 'dbname=' || current_database());
select dblink_exec('c67a', 'begin');
select dblink_exec('c67a', $$insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-00000067b001', '00000000-0000-0000-0000-0000000670a5', 'editor', 'full')$$);
select dblink_send_query('c67b', $$insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-00000067b001', '00000000-0000-0000-0000-0000000670a6', 'editor', 'full')$$);
select pg_sleep(0.5);
select pg_temp.check(dblink_is_busy('c67b') = 1, 'the second waits for the first');
select dblink_exec('c67a', 'commit');
select * from dblink_get_result('c67b') as r(status text);
select * from dblink_get_result('c67b') as r(status text);
select pg_temp.check(pg_temp.code('00000000-0000-0000-0000-00000067b001', '00000000-0000-0000-0000-0000000670a5') = 'U06'
  and pg_temp.code('00000000-0000-0000-0000-00000067b001', '00000000-0000-0000-0000-0000000670a6') = 'U07', 'at once: U06 and U07');
-- the same with the assigner itself (business_members_audit already orders the members' inserts; this is the code's own lock:
-- without it the second takes the same number and fails on unique (business_id, code))
select dblink_exec('c67a', 'begin');
select * from dblink('c67a', $$select public.member_doc_code_assign('00000000-0000-0000-0000-00000067b003', '00000000-0000-0000-0000-0000000670c1')$$) as r(code text);
select dblink_send_query('c67b', $$select public.member_doc_code_assign('00000000-0000-0000-0000-00000067b003', '00000000-0000-0000-0000-0000000670c2')$$);
select pg_sleep(0.5);
select pg_temp.check(dblink_is_busy('c67b') = 1, 'the assigner: the second waits for the business''s lock');
select dblink_exec('c67a', 'commit');
create temp table second_code as select * from dblink_get_result('c67b', false) as r(code text);
select pg_temp.check(dblink_error_message('c67b') = 'OK', 'the assigner: the second does not fail');
select * from dblink_get_result('c67b', false) as r(code text);
select dblink_disconnect('c67a');
select dblink_disconnect('c67b');
drop extension dblink;
select pg_temp.check(pg_temp.code('00000000-0000-0000-0000-00000067b003', '00000000-0000-0000-0000-0000000670c1') = 'U101'
  and pg_temp.code('00000000-0000-0000-0000-00000067b003', '00000000-0000-0000-0000-0000000670c2') = 'U102'
  and (select code from second_code) = 'U102', 'the assigner at once: U101 and U102');

-- ---- who reads them: the business's finance members only; nobody writes ----------------------------------------------------------
update public.profiles set current_business_id = '00000000-0000-0000-0000-00000067b001' where id = '00000000-0000-0000-0000-0000000670a1';
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000670a1');
select pg_temp.check((select count(*) from public.member_doc_codes) = 7
  and (select count(*) from public.member_doc_codes where business_id <> '00000000-0000-0000-0000-00000067b001') = 0, 'a1 in A: A''s 7 codes, nothing of B');
select pg_temp.check((select code from public.member_doc_codes where user_id = '00000000-0000-0000-0000-0000000670af') = 'U03', 'the one who left — readable for the file');
select pg_temp.refused($$insert into public.member_doc_codes (business_id, user_id, code) values
  ('00000000-0000-0000-0000-00000067b001', '00000000-0000-0000-0000-0000000670b1', 'U50')$$, 'the owner writes a code');
select pg_temp.refused($$update public.member_doc_codes set code = 'U50'$$, 'the owner changes a code');
select pg_temp.refused($$delete from public.member_doc_codes$$, 'the owner removes a code');
select pg_temp.refused($$select public.member_doc_code_assign('00000000-0000-0000-0000-00000067b001', '00000000-0000-0000-0000-0000000670b1')$$, 'the browser calls the assigner');
commit;
update public.profiles set current_business_id = '00000000-0000-0000-0000-00000067b002' where id = '00000000-0000-0000-0000-0000000670a1';
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000670a1');
select pg_temp.check((select array_agg(code order by code) from public.member_doc_codes) = array['U01', 'U02', 'U03'], 'a1 switched to B: B''s codes only');
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000670a3');
select pg_temp.check((select count(*) from public.member_doc_codes) = 0, 'the cashier: nothing');
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000670b2');
select pg_temp.check((select count(*) from public.member_doc_codes) = 0, 'the calendar member: nothing');
commit;
begin;
set local role anon;
select pg_temp.refused($$select count(*) from public.member_doc_codes$$, 'anon reads');
commit;
