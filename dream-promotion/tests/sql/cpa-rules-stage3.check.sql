-- The accountant's answers of 25.11.2026, stage 3 (migration 7000) on a real Postgres (tests/sql/run.sh):
--   1. (answer 5) numbering per location — one-way, by the owner, a business with more than one active location: each new
--      document in its location's series (after the business's last number, or at the owner's start); the same number in two
--      locations; a document's base found in its own location (credit, goods), never a guess; a business that never switches —
--      numbered and answered as before
--   2. (answer 18) a deposit issues a 420 "הפקדת בנק" (its cash and cheques as its lines), cancelled with it, never otherwise;
--      it moves no money, is not income, and its retry is the same document
-- "Before": rows of two businesses written with the unique key of before 7000 (its two new keys taken off, the old one back) —
-- then the migration, once (over rows that exist, as on the live database) and again: every row that was there stays as it was.
-- Fixtures only, fictional: dealer numbers 000000034 / 000000042 (valid check digit), mails *.example.test, bank account 000….
--   "Multi"  M: m1 owner, m2 cashier, m3 editor (full access, not the owner); locations: main (= the business), L2, later L3
--   "Single" S: s1 owner (one location; never switches)
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
-- a document of a licensed dealer (18%) the way the app sends it: one line of p_before; a receipt (320) paid in cash, or as p_pay
create or replace function pg_temp.doc(p_user text, p_type int, p_before numeric, p_key text, p_extra jsonb default '{}', p_pay jsonb default null)
returns jsonb language sql as $$
  select jsonb_build_object('user_id', p_user, 'doc_type', p_type, 'doc_number', 0, 'doc_date', public.il_today(),
    'customer_name', 'לקוחה לדוגמה', 'before_discount', p_before, 'discount', 0, 'after_discount', p_before,
    'vat_amount', round(p_before * 18 / 100, 2), 'total', p_before + round(p_before * 18 / 100, 2), 'vat_rate', 18, 'idempotency_key', p_key,
    'lines', jsonb_build_array(jsonb_build_object('name', 'שירות', 'qty', 1, 'unitPriceExVat', p_before, 'discountExVat', 0, 'totalExVat', p_before, 'vatRate', 18, 'kind', 1)),
    'payments', case when p_type in (320, 400) then coalesce(p_pay, jsonb_build_array(jsonb_build_object('method', 1, 'm', 'cash',
                       'amount', p_before + round(p_before * 18 / 100, 2), 'date', public.il_today()))) else '[]'::jsonb end)
    || p_extra;
$$;
create or replace function pg_temp.issue(r jsonb) returns uuid language plpgsql as $$
declare cols text; id uuid;
begin
  select string_agg(quote_ident(k), ', ') into cols from jsonb_object_keys(r) k;
  execute format('insert into public.documents (%s) select %s from jsonb_populate_record(null::public.documents, $1) returning id', cols, cols) using r into id;
  return id;
end $$;
create or replace function pg_temp.d(p_key text) returns public.documents language sql as $$ select * from public.documents where idempotency_key = p_key $$;
create or replace function pg_temp.num(p_key text) returns bigint language sql as $$ select doc_number from public.documents where idempotency_key = p_key $$;
-- what a signed-in role's call answered, kept for the checks
create temp table out70 (k text, j jsonb);
grant all on out70 to authenticated;
create or replace function pg_temp.o(p_k text) returns jsonb language sql as $$ select j from out70 where k = p_k $$;
-- every row of the tables 7000 touches, as text, in a fixed order — "nothing that was there changed"
create or replace function pg_temp.snapshot() returns text language sql as $$
  select md5(coalesce((select string_agg(d::text, '|' order by d.id) from public.documents d
                        where d.business_id in ('00000000-0000-0000-0000-0000007000b1', '00000000-0000-0000-0000-0000007000b2')), '')
      || coalesce((select string_agg(p::text, '|' order by p.id) from public.payments p
                    where p.business_id in ('00000000-0000-0000-0000-0000007000b1', '00000000-0000-0000-0000-0000007000b2')), '')
      || coalesce((select string_agg(c::text, '|' order by c.document_id) from public.document_cancellations c
                    where c.business_id in ('00000000-0000-0000-0000-0000007000b1', '00000000-0000-0000-0000-0000007000b2')), '')
      || coalesce((select string_agg(c::text, '|' order by c.business_id, c.doc_type) from public.document_counters c
                    where c.business_id in ('00000000-0000-0000-0000-0000007000b1', '00000000-0000-0000-0000-0000007000b2')), '')
      || coalesce((select string_agg(l::text, '|' order by l.id) from public.business_locations l
                    where l.business_id in ('00000000-0000-0000-0000-0000007000b1', '00000000-0000-0000-0000-0000007000b2')), '')
      || coalesce((select string_agg(x::text, '|' order by x.id) from public.bank_deposits x
                    where x.business_id in ('00000000-0000-0000-0000-0000007000b1', '00000000-0000-0000-0000-0000007000b2')), '')
      || coalesce((select string_agg(s::text, '|' order by s.business_id, s.location_id, s.doc_type) from public.document_series s
                    where s.business_id in ('00000000-0000-0000-0000-0000007000b1', '00000000-0000-0000-0000-0000007000b2')), '')
      || coalesce((select string_agg(n::text, '|' order by n.business_id) from public.document_numbering n
                    where n.business_id in ('00000000-0000-0000-0000-0000007000b1', '00000000-0000-0000-0000-0000007000b2')), ''));
$$;

-- ---- "before": the unique key of before 7000 ---------------------------------------------------------------------------------
drop index if exists public.documents_number_business_uq;
drop index if exists public.documents_number_location_uq;
create unique index if not exists documents_business_number_uq on public.documents (business_id, doc_type, doc_number);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000007000a1', 'owner@multi-70.example.test'), ('00000000-0000-0000-0000-0000007000a2', 'cashier@multi-70.example.test'),
  ('00000000-0000-0000-0000-0000007000a3', 'editor@multi-70.example.test'), ('00000000-0000-0000-0000-0000007000a4', 'owner@single-70.example.test');
insert into public.businesses (id, name, slug) values
  ('00000000-0000-0000-0000-0000007000b1', 'Multi 70', 'multi-70'), ('00000000-0000-0000-0000-0000007000b2', 'Single 70', 'single-70');
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-0000007000b1', '00000000-0000-0000-0000-0000007000a1', 'owner', 'full'),
  ('00000000-0000-0000-0000-0000007000b1', '00000000-0000-0000-0000-0000007000a2', 'editor', 'register'),
  ('00000000-0000-0000-0000-0000007000b1', '00000000-0000-0000-0000-0000007000a3', 'editor', 'full'),
  ('00000000-0000-0000-0000-0000007000b2', '00000000-0000-0000-0000-0000007000a4', 'owner', 'full');
update public.profiles set current_business_id = '00000000-0000-0000-0000-0000007000b1'
 where id in ('00000000-0000-0000-0000-0000007000a1', '00000000-0000-0000-0000-0000007000a2', '00000000-0000-0000-0000-0000007000a3');
update public.profiles set current_business_id = '00000000-0000-0000-0000-0000007000b2' where id = '00000000-0000-0000-0000-0000007000a4';
insert into public.register_settings (user_id, business_id, business_type, vat_rate, dealer_number, legal_name, street, city, entity_type) values
  ('00000000-0000-0000-0000-0000007000a1', '00000000-0000-0000-0000-0000007000b1', 'licensed', 18, '000000034', 'עסק סניפים לדוגמה', 'הדוגמה', 'עיר דוגמה', 'licensed_dealer'),
  ('00000000-0000-0000-0000-0000007000a4', '00000000-0000-0000-0000-0000007000b2', 'licensed', 18, '000000042', 'עסק יחיד לדוגמה', 'הדוגמה', 'עיר דוגמה', 'licensed_dealer');
insert into public.business_finance_profile (business_id, user_id, sells_products, cash_drawers) values
  ('00000000-0000-0000-0000-0000007000b1', '00000000-0000-0000-0000-0000007000a1', true, true),
  ('00000000-0000-0000-0000-0000007000b2', '00000000-0000-0000-0000-0000007000a4', false, true);
insert into public.business_locations (id, business_id, name, kind, sort) values
  ('00000000-0000-0000-0000-0000007000c2', '00000000-0000-0000-0000-0000007000b1', 'סניף שני לדוגמה', 'branch', 1);
select pg_temp.check((select count(*) from public.business_locations where business_id = '00000000-0000-0000-0000-0000007000b1' and active) = 2
  and (select count(*) from public.business_locations where business_id = '00000000-0000-0000-0000-0000007000b2' and active) = 1,
  'M has two active locations (the main one and L2), S one');

-- documents of before 7000, in both businesses (M: an invoice at each location, a credit on the one of L2; S: an invoice)
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007000a1');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007000a1', 305, 1000, 'c70m:old:main'));
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007000a1', 305, 500, 'c70m:old:l2', '{"location_id": "00000000-0000-0000-0000-0000007000c2"}'));
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007000a1', 330, 100, 'c70m:old:credit',
  jsonb_build_object('base_doc_type', 305, 'base_doc_number', pg_temp.num('c70m:old:l2'))));
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007000a4');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007000a4', 305, 200, 'c70s:old:1'));
commit;
select pg_temp.check(pg_temp.num('c70m:old:main') = 1 and pg_temp.num('c70m:old:l2') = 2 and pg_temp.num('c70m:old:credit') = 1 and pg_temp.num('c70s:old:1') = 1,
  'before: one series per business and type');
select pg_temp.check((pg_temp.d('c70m:old:credit')).location_id = '00000000-0000-0000-0000-0000007000c2', 'before: the credit went where its invoice is');

-- ---- the migration: over these rows (the first time), and again -----------------------------------------------------------
create temp table before_7000 as select pg_temp.snapshot() as s;
\ir ../../supabase/migrations/20261127007000_cpa_rules_stage3.sql
select pg_temp.check((select s from before_7000) = pg_temp.snapshot(), 'the migration over existing rows: every row stays as it was');
\ir ../../supabase/migrations/20261127007000_cpa_rules_stage3.sql
select pg_temp.check((select s from before_7000) = pg_temp.snapshot(), 'the migration again: every row stays as it was');
select pg_temp.check(to_regclass('public.documents_business_number_uq') is null and to_regclass('public.documents_number_business_uq') is not null
  and to_regclass('public.documents_number_location_uq') is not null and to_regclass('public.documents_deposit_uq') is not null,
  'the old unique key is replaced by the two of 7000');
select pg_temp.check((select count(*) from public.documents where series_location_id is not null or deposit_id is not null
                       and business_id in ('00000000-0000-0000-0000-0000007000b1', '00000000-0000-0000-0000-0000007000b2')) = 0
  and (select count(*) from public.business_locations where branch_code is not null
        and business_id in ('00000000-0000-0000-0000-0000007000b1', '00000000-0000-0000-0000-0000007000b2')) = 0,
  'the new columns are empty in every old row');
select pg_temp.check((select count(*) from pg_trigger where tgname = 'c_business_locations_branch_code' and tgrelid = 'public.business_locations'::regclass) = 1,
  'one branch-code trigger after running twice');
select pg_temp.check(not has_function_privilege('authenticated', 'public.documents_before_insert()', 'execute')
  and not has_function_privilege('authenticated', 'public.location_fill()', 'execute')
  and not has_function_privilege('authenticated', 'public.documents_validate()', 'execute')
  and not has_function_privilege('authenticated', 'public.business_locations_branch_code()', 'execute')
  and not has_function_privilege('authenticated', 'public.branch_code_next(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.document_numbering_per_location()', 'execute')
  and has_function_privilege('authenticated', 'public.document_numbering_per_location()', 'execute')
  and has_function_privilege('authenticated', 'public.document_series_start(uuid, integer, bigint)', 'execute')
  and has_function_privilege('authenticated', 'public.location_branch_code_set(uuid, text)', 'execute')
  and has_function_privilege('authenticated', 'public.document_numbering_state()', 'execute')
  and has_function_privilege('authenticated', 'public.bank_deposit_create(uuid, date, uuid, numeric, uuid[], text)', 'execute'),
  'the trigger functions: no browser role; the owner''s functions: authenticated (never anon)');
select pg_temp.check((select relrowsecurity from pg_class where oid = 'public.document_numbering'::regclass)
  and (select relrowsecurity from pg_class where oid = 'public.document_series'::regclass)
  and not has_table_privilege('authenticated', 'public.document_series', 'insert')
  and not has_table_privilege('authenticated', 'public.document_numbering', 'update')
  and not has_table_privilege('anon', 'public.document_series', 'select'),
  'the new tables: RLS on, read only for the browser, nothing for anon');

-- ======================================================================================================================
-- 1. a business that never switches (S, and M until it switches): the same numbers, the same way
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007000a4');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007000a4', 305, 300, 'c70s:new:2'));
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007000a4', 330, 50, 'c70s:new:credit', jsonb_build_object('base_doc_type', 305, 'base_doc_number', 2)));
commit;
select pg_temp.check(pg_temp.num('c70s:new:2') = 2 and pg_temp.num('c70s:new:credit') = 1 and (pg_temp.d('c70s:new:2')).series_location_id is null,
  'S: the business''s series goes on (305 #2, 330 #1), of no location');
select pg_temp.check((select credited from public.receivables where id = (pg_temp.d('c70s:new:2')).id) = 59
  and (select credited from public.receivables where id = (pg_temp.d('c70s:old:1')).id) = 0, 'S: the credit is on its invoice');
select pg_temp.check((select count(*) from public.document_series where business_id = '00000000-0000-0000-0000-0000007000b2') = 0,
  'S: no location series');
-- a business with one active location does not switch; nobody but the owner switches
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007000a4');
select pg_temp.refused_with('select public.document_numbering_per_location()', 'numbering_one_location', 'one active location: no numbering per location');
select pg_temp.as_user('00000000-0000-0000-0000-0000007000a3');
select pg_temp.refused_with('select public.document_numbering_per_location()', 'not allowed', 'an editor (full access, not the owner) does not switch', '42501');
select pg_temp.refused_with($$select public.document_series_start('00000000-0000-0000-0000-0000007000c2', 305, 50)$$, 'not allowed', 'nor sets a series', '42501');
select pg_temp.refused_with($$select public.location_branch_code_set('00000000-0000-0000-0000-0000007000c2', '9')$$, 'not allowed', 'nor a branch code', '42501');
select pg_temp.as_user('00000000-0000-0000-0000-0000007000a2');
select pg_temp.refused_with('select public.document_numbering_per_location()', 'not allowed', 'a cashier does not switch', '42501');
select pg_temp.refused_with('select public.document_numbering_state()', 'not allowed', 'nor reads the numbering', '42501');
commit;

-- ======================================================================================================================
-- 2. the owner of M: a branch code and a first number before the switch, then the switch (once)
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007000a1');
select pg_temp.check(public.location_branch_code_set('00000000-0000-0000-0000-0000007000c2', 'TA2') ->> 'branchCode' = 'TA2', 'the owner names L2''s code');
select pg_temp.refused_with($$select public.location_branch_code_set('00000000-0000-0000-0000-0000007000b1', 'ta2')$$, 'branch_code_taken', 'one code per business (letters any case)');
select pg_temp.refused_with($$select public.location_branch_code_set('00000000-0000-0000-0000-0000007000b1', 'ABCDEFGH')$$, 'branch_code_format', 'up to 7 letters or digits');
select pg_temp.refused_with($$select public.document_series_start('00000000-0000-0000-0000-0000007000c2', 305, 2)$$, 'series_start_low',
  'a series starts after the business''s last number of the type (305 #2)');
select pg_temp.refused_with($$select public.document_series_start('00000000-0000-0000-0000-0000007000c2', 999, 50)$$, 'series_type', 'a document type');
-- L2's tax invoices from 3 — the same number the main location's series gives next: one number, in each location
select pg_temp.check(public.document_series_start('00000000-0000-0000-0000-0000007000c2', 305, 3) ->> 'start' = '3', 'L2''s tax invoices start at 3');
select pg_temp.check((select count(*) from public.document_numbering where business_id = '00000000-0000-0000-0000-0000007000b1') = 0,
  'a first number set does not switch the business');
select pg_temp.check((public.document_numbering_per_location() ->> 'perLocation')::boolean, 'the owner switches M to numbering per location');
select pg_temp.check((public.document_numbering_per_location() ->> 'perLocation')::boolean
  and (select count(*) from public.document_numbering where business_id = '00000000-0000-0000-0000-0000007000b1') = 1, 'a second switch changes nothing');
commit;
select pg_temp.check((select branch_code from public.business_locations where id = '00000000-0000-0000-0000-0000007000b1') = '1'
  and (select branch_code from public.business_locations where id = '00000000-0000-0000-0000-0000007000c2') = 'TA2',
  'the switch gave the main location code 1; L2 keeps the code its owner chose');
select pg_temp.refused_with($$update public.document_numbering set per_location_since = now() where business_id = '00000000-0000-0000-0000-0000007000b1'$$,
  'append', 'the switch is never changed (even by the server)');
select pg_temp.refused_with($$delete from public.document_numbering where business_id = '00000000-0000-0000-0000-0000007000b1'$$,
  'append', 'nor undone');

-- ======================================================================================================================
-- 3. M numbers per location: after the business's last number, or at the owner's start; the same number in two locations
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007000a1');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007000a1', 305, 1000, 'c70m:main:a'));
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007000a1', 305, 200, 'c70m:l2:a', '{"location_id": "00000000-0000-0000-0000-0000007000c2"}'));
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007000a1', 305, 300, 'c70m:l2:b', '{"location_id": "00000000-0000-0000-0000-0000007000c2"}'));
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007000a1', 305, 400, 'c70m:main:b'));
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007000a1', 320, 100, 'c70m:l2:r', '{"location_id": "00000000-0000-0000-0000-0000007000c2"}'));
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007000a1', 320, 100, 'c70m:main:r'));
commit;
select pg_temp.check(pg_temp.num('c70m:main:a') = 3 and pg_temp.num('c70m:main:b') = 4 and pg_temp.num('c70m:l2:a') = 3 and pg_temp.num('c70m:l2:b') = 4,
  'tax invoices: main 3, 4 (after the business''s 2); L2 3, 4 (its owner''s start) — 3 and 4 in each location');
select pg_temp.check(pg_temp.num('c70m:l2:r') = 1 and pg_temp.num('c70m:main:r') = 1, 'invoice-receipts: 1 in each location (the business had none)');
select pg_temp.check((pg_temp.d('c70m:main:a')).series_location_id = '00000000-0000-0000-0000-0000007000b1'
  and (pg_temp.d('c70m:l2:a')).series_location_id = '00000000-0000-0000-0000-0000007000c2', 'each document names the series that numbered it');
select pg_temp.check((select last_no from public.document_counters where business_id = '00000000-0000-0000-0000-0000007000b1' and doc_type = 305) = 2,
  'the business''s own series stopped at 2');
-- the state for the settings screen
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007000a1');
insert into out70 select 'state', public.document_numbering_state();
commit;
select pg_temp.check((select (s->>'perLocation')::boolean and (s->>'activeLocations')::int = 2 and s->'business'->>'305' = '2'
                        and jsonb_array_length(s->'locations') = 2 and s->'locations'->0->>'branchCode' = '1'
                        and (s->'locations'->1->'series') @> '[{"docType": 305, "start": 3, "last": 4, "next": 5}]'::jsonb
                        and (s->'locations'->0->>'codeFixed')::boolean from (select pg_temp.o('state') as s) x),
  'the state: per location, two locations with their codes, L2''s 305 series 3..4 next 5; the main code is fixed now');
-- a code stays once the location numbered a document; a series' first number too
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007000a1');
select pg_temp.refused_with($$select public.location_branch_code_set('00000000-0000-0000-0000-0000007000c2', 'X9')$$, 'branch_code_fixed', 'L2 numbered documents: its code stays');
select pg_temp.refused_with($$select public.document_series_start('00000000-0000-0000-0000-0000007000c2', 305, 900)$$, 'series_started', 'L2''s 305 series started: its start stays');
select pg_temp.check(public.document_series_start('00000000-0000-0000-0000-0000007000c2', 330, 7) ->> 'start' = '7', 'L2''s credits will start at 7 (none yet)');
commit;
-- a location opened after the switch gets the next code
insert into public.business_locations (id, business_id, name, kind, sort)
  values ('00000000-0000-0000-0000-0000007000c3', '00000000-0000-0000-0000-0000007000b1', 'סניף שלישי לדוגמה', 'branch', 2);
select pg_temp.check((select branch_code from public.business_locations where id = '00000000-0000-0000-0000-0000007000c3') = '2',
  'a location opened after the switch: the next free code (2)');

-- ======================================================================================================================
-- 4. the base of a document: in its location — never a guess between two
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007000a1');
-- tax invoice #3 is in two locations: without a location the credit is refused (and takes no number)
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007000a1', 330, 50, 'c70m:cr:guess', '{"base_doc_type": 305, "base_doc_number": 3}'))$$,
  'base_location_ambiguous', 'a base number of two locations, no location: refused');
-- with L2: L2's #3 (200 before VAT) — never beyond it, though the main #3 is of 1000
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007000a1', 330, 300, 'c70m:cr:over',
  '{"base_doc_type": 305, "base_doc_number": 3, "location_id": "00000000-0000-0000-0000-0000007000c2"}'))$$,
  'credit_exceeds_original', 'a credit of L2''s #3 is within L2''s #3');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007000a1', 330, 150, 'c70m:cr:l2',
  '{"base_doc_type": 305, "base_doc_number": 3, "location_id": "00000000-0000-0000-0000-0000007000c2"}'));
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007000a1', 330, 100, 'c70m:cr:main',
  '{"base_doc_type": 305, "base_doc_number": 3, "location_id": "00000000-0000-0000-0000-0000007000b1"}'));
-- a base of the business's series (before the switch, #1 of the main location): found without a location, as before
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007000a1', 330, 10, 'c70m:cr:old', '{"base_doc_type": 305, "base_doc_number": 1}'));
-- … and from another location, refused as before (location_mismatch)
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007000a1', 330, 10, 'c70m:cr:old2',
  '{"base_doc_type": 305, "base_doc_number": 1, "location_id": "00000000-0000-0000-0000-0000007000c2"}'))$$,
  'location_mismatch', 'a credit goes where its invoice is');
commit;
select pg_temp.check(pg_temp.num('c70m:cr:main') = 2 and pg_temp.num('c70m:cr:old') = 3 and pg_temp.num('c70m:cr:l2') = 7,
  'credits: main 2, 3 (after the business''s credit #1); L2 7 (its owner''s start); no number lost to the refusals');
select pg_temp.check((select credited from public.receivables where id = (pg_temp.d('c70m:l2:a')).id) = 177
  and (select credited from public.receivables where id = (pg_temp.d('c70m:main:a')).id) = 118
  and (select credited from public.receivables where id = (pg_temp.d('c70m:old:main')).id) = 11.8
  and (select credited from public.receivables where id = (pg_temp.d('c70m:old:l2')).id) = 118
  and (select credited from public.receivables where id = (pg_temp.d('c70m:l2:b')).id) = 0,
  'receivables: each credit on its own invoice — L2 #3 177, main #3 118, the old ones as before');
-- a receipt on L2's #3: never beyond what is left of L2's #3 (its own credits, not the main one's)
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007000a1');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007000a1', 400, 70, 'c70m:pay:over',
  jsonb_build_object('paid_document_id', (pg_temp.d('c70m:l2:a')).id, 'vat_amount', 0, 'total', 70, 'vat_rate', 0,
    'lines', '[{"name":"תשלום","qty":1,"unitPriceExVat":70,"discountExVat":0,"totalExVat":70,"vatRate":0,"kind":1}]'::jsonb,
    'payments', jsonb_build_array(jsonb_build_object('method', 1, 'm', 'cash', 'amount', 70, 'date', public.il_today())))))$$,
  'receipt_exceeds_balance', 'L2 #3 (236 − 177 credited): 59 left');
commit;
-- what a payment link / a plan sees is the same balance
select pg_temp.check((select balance from public.receivables where id = (pg_temp.d('c70m:l2:a')).id) = 59, 'L2 #3: 59 left to pay');

-- ---- goods: a delivery note of each location (#1 and #1); the invoice of L2's; the main one's still cancelled ----------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007000a1');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007000a1', 200, 100, 'c70m:dn:main'));
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007000a1', 200, 100, 'c70m:dn:l2', '{"location_id": "00000000-0000-0000-0000-0000007000c2"}'));
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007000a1', 305, 100, 'c70m:dn:l2:inv',
  '{"base_doc_type": 200, "base_doc_number": 1, "location_id": "00000000-0000-0000-0000-0000007000c2"}'));
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007000a1', 305, 100, 'c70m:dn:l2:inv2',
  '{"base_doc_type": 200, "base_doc_number": 1, "location_id": "00000000-0000-0000-0000-0000007000c2"}'))$$,
  'goods_invoiced', 'L2''s delivery note is invoiced once');
insert into public.document_cancellations (document_id, business_id, user_id, reason)
  values ((pg_temp.d('c70m:dn:main')).id, '00000000-0000-0000-0000-0000007000b1', '00000000-0000-0000-0000-0000007000a1', 'הופקה בטעות');
commit;
select pg_temp.check(pg_temp.num('c70m:dn:main') = 1 and pg_temp.num('c70m:dn:l2') = 1 and (pg_temp.d('c70m:dn:l2:inv')).base_doc_number = 1
  and (pg_temp.d('c70m:dn:l2:inv')).location_id = '00000000-0000-0000-0000-0000007000c2'
  and exists (select 1 from public.document_cancellations where document_id = (pg_temp.d('c70m:dn:main')).id),
  'two delivery notes #1; L2''s invoiced; the main one (nothing made from it) cancelled');

-- ---- an exempt dealer that numbers per location: a refund receipt on the receipt of its own location ------------------------
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000007000a5', 'owner@exempt-70.example.test');
insert into public.businesses (id, name, slug) values ('00000000-0000-0000-0000-0000007000b3', 'Exempt 70', 'exempt-70');
insert into public.business_members (business_id, user_id, role, access)
  values ('00000000-0000-0000-0000-0000007000b3', '00000000-0000-0000-0000-0000007000a5', 'owner', 'full');
update public.profiles set current_business_id = '00000000-0000-0000-0000-0000007000b3' where id = '00000000-0000-0000-0000-0000007000a5';
insert into public.register_settings (user_id, business_id, business_type, vat_rate, dealer_number, legal_name, street, city, entity_type) values
  ('00000000-0000-0000-0000-0000007000a5', '00000000-0000-0000-0000-0000007000b3', 'exempt', 0, '000000067', 'עוסקת פטורה לדוגמה', 'הדוגמה', 'עיר דוגמה', 'exempt_dealer');
insert into public.business_locations (id, business_id, name, kind, sort)
  values ('00000000-0000-0000-0000-0000007000c5', '00000000-0000-0000-0000-0000007000b3', 'סניף פטור לדוגמה', 'clinic', 1);
-- a receipt of the exempt dealer (no VAT); a refund receipt (below zero) on the receipt #p_base
create or replace function pg_temp.rcpt(p_amount numeric, p_key text, p_extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('user_id', '00000000-0000-0000-0000-0000007000a5', 'doc_type', 400, 'doc_number', 0, 'doc_date', public.il_today(),
    'customer_name', 'לקוחה לדוגמה', 'before_discount', p_amount, 'discount', 0, 'after_discount', p_amount, 'vat_amount', 0, 'total', p_amount,
    'vat_rate', 0, 'idempotency_key', p_key,
    'lines', jsonb_build_array(jsonb_build_object('name', case when p_amount < 0 then 'החזר' else 'טיפול' end, 'qty', 1, 'unitPriceExVat', p_amount,
                                                  'discountExVat', 0, 'totalExVat', p_amount, 'vatRate', 0, 'kind', 1)),
    'payments', jsonb_build_array(jsonb_build_object('method', 1, 'amount', p_amount, 'date', public.il_today()))) || p_extra;
$$;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007000a5');
select (public.document_numbering_per_location() ->> 'perLocation');
select pg_temp.issue(pg_temp.rcpt(100, 'c70e:main'));
select pg_temp.issue(pg_temp.rcpt(300, 'c70e:l5', '{"location_id": "00000000-0000-0000-0000-0000007000c5"}'));
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.rcpt(-50, 'c70e:back:guess', '{"base_doc_type": 400, "base_doc_number": 1}'))$$,
  'base_location_ambiguous', 'exempt: receipt #1 of two locations, no location — refused');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.rcpt(-200, 'c70e:back:over',
  '{"base_doc_type": 400, "base_doc_number": 1, "location_id": "00000000-0000-0000-0000-0000007000b3"}'))$$,
  'refund_receipt_over', 'exempt: the main receipt #1 (100) refunds 100 at most — not the 300 of the other #1');
select pg_temp.issue(pg_temp.rcpt(-150, 'c70e:back:l5', '{"base_doc_type": 400, "base_doc_number": 1, "location_id": "00000000-0000-0000-0000-0000007000c5"}'));
select pg_temp.issue(pg_temp.rcpt(-100, 'c70e:back:main', '{"base_doc_type": 400, "base_doc_number": 1, "location_id": "00000000-0000-0000-0000-0000007000b3"}'));
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.rcpt(-160, 'c70e:back:l5b', '{"base_doc_type": 400, "base_doc_number": 1, "location_id": "00000000-0000-0000-0000-0000007000c5"}'))$$,
  'refund_receipt_over', 'exempt: L5''s #1 has 150 left');
commit;
select pg_temp.check(pg_temp.num('c70e:main') = 1 and pg_temp.num('c70e:l5') = 1 and pg_temp.num('c70e:back:l5') = 2 and pg_temp.num('c70e:back:main') = 2
  and (pg_temp.d('c70e:back:l5')).location_id = '00000000-0000-0000-0000-0000007000c5',
  'exempt: receipts #1 in each location; each refund receipt (#2 of its location) on the receipt of its own location');

-- ======================================================================================================================
-- 5. a deposit is a document 420 — its cash and cheques; cancelled with it, never otherwise
-- ======================================================================================================================
-- S (one series): a receipt by cheque, deposited with cash
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007000a4');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007000a4', 320, 500, 'c70s:chq', '{}',
  jsonb_build_array(jsonb_build_object('method', 2, 'm', 'cheque', 'amount', 590, 'date', public.il_today(),
    'cheque', jsonb_build_object('number', '4401', 'bank', '12', 'branch', '600', 'account', '000123456', 'dueDate', (public.il_today() + 5)::text)))));
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007000a4', 320, 100, 'c70s:cash'));
commit;
insert into out70 select 'cash before', to_jsonb(public.cash_desk_cash('00000000-0000-0000-0000-0000007000b2', '00000000-0000-0000-0000-0000007000b2'));
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007000a4');
insert into out70 select 'fs before', public.finance_summary(public.il_today() - 1, public.il_today());
insert into out70 select 'dep', public.bank_deposit_create('00000000-0000-0000-0000-0000007000e1', public.il_today(), null, 100,
  array[(select p.id from public.payments p where p.document_id = (pg_temp.d('c70s:chq')).id)], 'הפקדה לדוגמה');
insert into out70 select 'dep again', public.bank_deposit_create('00000000-0000-0000-0000-0000007000e1', public.il_today(), null, 999, '{}', '');
insert into out70 select 'fs after', public.finance_summary(public.il_today() - 1, public.il_today());
insert into out70 select 'book', public.deposit_book(public.il_today() - 1, public.il_today());
commit;
insert into out70 select 'cash after', to_jsonb(public.cash_desk_cash('00000000-0000-0000-0000-0000007000b2', '00000000-0000-0000-0000-0000007000b2'));
select pg_temp.check((pg_temp.o('dep')->>'created')::boolean and pg_temp.o('dep')->'document'->>'number' = '1'
  and not (pg_temp.o('dep again')->>'created')::boolean and pg_temp.o('dep again')->'document' = pg_temp.o('dep')->'document',
  'the deposit answers with its 420 (#1); its retry is the same deposit and the same document');
select pg_temp.check((select count(*) from public.documents where deposit_id = '00000000-0000-0000-0000-0000007000e1') = 1, 'one document for the deposit');
select pg_temp.check((select doc_type = 420 and doc_number = 1 and series_location_id is null and total = 690 and before_discount = 690 and after_discount = 690
                        and vat_amount = 0 and vat_rate = 0 and lines = '[]'::jsonb and customer_name = '' and source = 'deposit' and doc_date = public.il_today()
                        and location_id = '00000000-0000-0000-0000-0000007000b2' and issuer->>'dealerNumber' = '000000042'
                        and payments = jsonb_build_array(
                          jsonb_build_object('method', 1, 'm', 'cash', 'amount', 100, 'date', public.il_today()),
                          jsonb_build_object('method', 2, 'm', 'cheque', 'amount', 590, 'date', public.il_today(),
                            'cheque', jsonb_build_object('number', '4401', 'bank', '12', 'branch', '600', 'account', '000123456', 'dueDate', (public.il_today() + 5)::text)))
                        from public.documents where deposit_id = '00000000-0000-0000-0000-0000007000e1'),
  'S''s 420 #1 (the business''s series): 690, no VAT, no lines, no customer; its lines the cash (1) and the cheque (2) with its details');
select pg_temp.check((select count(*) from public.payments where document_id = (select id from public.documents where deposit_id = '00000000-0000-0000-0000-0000007000e1')) = 0,
  'the 420 moves no money (no payments row)');
select pg_temp.check((pg_temp.o('cash after')::text::numeric) = (pg_temp.o('cash before')::text::numeric) - 100, 'the cash desk: less the deposit''s cash, once');
select pg_temp.check((pg_temp.o('fs after') - 'documents') = (pg_temp.o('fs before') - 'documents')
  and (pg_temp.o('fs after')->'documents') - '420' = pg_temp.o('fs before')->'documents'
  and pg_temp.o('fs after')->'documents'->'420'->>'count' = '1',
  'the money summary: the same revenue, VAT, cash and receivables — the 420 only counted among the documents');
select pg_temp.check((select x->'document'->>'number' = '1' from jsonb_array_elements(pg_temp.o('book')) x where x->>'id' = '00000000-0000-0000-0000-0000007000e1'),
  'the deposits'' book names its document');

-- M (per location): a deposit at each location — 420 #1 in each
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007000a1');
select public.bank_deposit_create('00000000-0000-0000-0000-0000007000e2', public.il_today(), '00000000-0000-0000-0000-0000007000c2', 100, '{}', '');
select public.bank_deposit_create('00000000-0000-0000-0000-0000007000e3', public.il_today(), '00000000-0000-0000-0000-0000007000b1', 100, '{}', '');
-- never issued by hand, never on another document
select pg_temp.refused_with($$select pg_temp.issue(jsonb_build_object('user_id', '00000000-0000-0000-0000-0000007000a1', 'doc_type', 420, 'doc_number', 0,
  'doc_date', public.il_today(), 'before_discount', 100, 'discount', 0, 'after_discount', 100, 'vat_amount', 0, 'total', 100, 'vat_rate', 0,
  'lines', '[]'::jsonb, 'payments', '[{"method": 1, "amount": 100}]'::jsonb, 'deposit_id', '00000000-0000-0000-0000-0000007000e2', 'idempotency_key', 'c70m:420:hand'))$$,
  'deposit_document_only', 'a 420 by hand: refused', '42501');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007000a1', 305, 10, 'c70m:305:dep', '{"deposit_id": "00000000-0000-0000-0000-0000007000e2"}'))$$,
  'deposit_document_only', 'a deposit on another document: refused');
-- cancelled only with its deposit
select pg_temp.refused_with($$insert into public.document_cancellations (document_id, business_id, user_id, reason)
  values ((select id from public.documents where deposit_id = '00000000-0000-0000-0000-0000007000e2'), '00000000-0000-0000-0000-0000007000b1',
          '00000000-0000-0000-0000-0000007000a1', 'בטעות')$$, 'cancel_deposit_document', 'a 420 is not cancelled on its own');
select public.bank_deposit_cancel('00000000-0000-0000-0000-0000007000e2', 'נרשמה פעמיים');
commit;
select pg_temp.check((select doc_number = 1 and series_location_id = '00000000-0000-0000-0000-0000007000c2' from public.documents where deposit_id = '00000000-0000-0000-0000-0000007000e2')
  and (select doc_number = 1 and series_location_id = '00000000-0000-0000-0000-0000007000b1' from public.documents where deposit_id = '00000000-0000-0000-0000-0000007000e3'),
  'M: a 420 #1 in each location (numbered per location)');
select pg_temp.check((select reason = 'נרשמה פעמיים' from public.document_cancellations where document_id = (select id from public.documents where deposit_id = '00000000-0000-0000-0000-0000007000e2'))
  and not exists (select 1 from public.document_cancellations where document_id = (select id from public.documents where deposit_id = '00000000-0000-0000-0000-0000007000e3')),
  'the cancelled deposit''s 420 is cancelled (its reason); the other stays');
select pg_temp.check(public.cash_desk_cash('00000000-0000-0000-0000-0000007000b1', '00000000-0000-0000-0000-0000007000c2') = 118,
  'L2''s desk: its cash back after the cancel (118)');

-- ======================================================================================================================
-- 6. who reads the series; the rows of before; running it again
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007000a2');
select pg_temp.check((select count(*) from public.document_series) = 0 and (select count(*) from public.document_numbering) = 0, 'a cashier reads no series');
select pg_temp.as_user('00000000-0000-0000-0000-0000007000a4');
select pg_temp.check((select count(*) from public.document_series) = 0 and (select count(*) from public.document_numbering) = 0, 'another business reads none of M''s');
select pg_temp.as_user('00000000-0000-0000-0000-0000007000a3');
select pg_temp.check((select count(*) from public.document_series) >= 4 and (select count(*) from public.document_numbering) = 1, 'a finance member of M reads them');
commit;
select pg_temp.check((select doc_number from public.documents where idempotency_key = 'c70m:old:main') = 1
  and (select doc_number from public.documents where idempotency_key = 'c70m:old:l2') = 2
  and (select series_location_id is null from public.documents where idempotency_key = 'c70m:old:credit'), 'the documents of before keep their numbers, of the business''s series');
create temp table before_again as select pg_temp.snapshot() as s;
\ir ../../supabase/migrations/20261127007000_cpa_rules_stage3.sql
select pg_temp.check((select s from before_again) = pg_temp.snapshot(), 'running it again after the switch and the deposits: nothing changes');
