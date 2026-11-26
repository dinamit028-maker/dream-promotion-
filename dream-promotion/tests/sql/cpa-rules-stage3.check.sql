-- The accountant's answers of 25.11.2026, stage 3 (migration 7000) on a real Postgres (tests/sql/run.sh):
--   1. (answer 5; the owner, 26.11.2026) numbering per location — one-way, by the owner, a business with more than one active
--      location: each new document's number = its location's two-digit branch code, then the location's running number (six
--      digits): 01000001 …, 05000001 … — never twice in the business; a credit / a refund receipt of the location that issues
--      it; a business that never switches — numbered and answered as before
--   2. (answer 18) a deposit issues a 420 "הפקדת בנק" (its cash and cheques as its lines), cancelled with it, never otherwise;
--      it moves no money, is not income, and its retry is the same document
-- "Before": rows of two businesses (and an exempt one) written before the switch — then the migration twice over them: every row
-- that was there stays as it was.
-- Fixtures only, fictional: dealer numbers 000000034 / 000000042 / 000000067 (valid check digit), mails *.example.test, bank
-- account 000….
--   "Multi"  M: m1 owner, m2 cashier, m3 editor (full access, not the owner); locations: main (= the business), L2, later L3
--   "Single" S: s1 owner (one location; never switches)
--   "Exempt" E: e5 owner (exempt dealer; main + L5)
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

-- ---- "before" --------------------------------------------------------------------------------------------------------------
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
select pg_temp.check(to_regclass('public.documents_business_number_uq') is not null and to_regclass('public.documents_deposit_uq') is not null,
  'the unique key stays one number per business and type; one document per deposit');
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
select pg_temp.refused_with($$select public.location_branch_code_set('00000000-0000-0000-0000-0000007000c2', '09')$$, 'not allowed', 'nor sets a branch code', '42501');
select pg_temp.as_user('00000000-0000-0000-0000-0000007000a2');
select pg_temp.refused_with('select public.document_numbering_per_location()', 'not allowed', 'a cashier does not switch', '42501');
select pg_temp.refused_with('select public.document_numbering_state()', 'not allowed', 'nor reads the numbering', '42501');
commit;

-- ======================================================================================================================
-- 2. the owner of M: a branch code before the switch, then the switch (once)
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007000a1');
select pg_temp.check(public.location_branch_code_set('00000000-0000-0000-0000-0000007000c2', '5') ->> 'branchCode' = '05', 'the owner names L2 05 (5 → 05)');
select pg_temp.refused_with($$select public.location_branch_code_set('00000000-0000-0000-0000-0000007000b1', '05')$$, 'branch_code_taken', 'one code per business');
select pg_temp.refused_with($$select public.location_branch_code_set('00000000-0000-0000-0000-0000007000b1', '00')$$, 'branch_code_format', 'not 00');
select pg_temp.refused_with($$select public.location_branch_code_set('00000000-0000-0000-0000-0000007000b1', '100')$$, 'branch_code_format', 'two digits');
select pg_temp.refused_with($$select public.location_branch_code_set('00000000-0000-0000-0000-0000007000b1', 'AB')$$, 'branch_code_format', 'digits only');
select pg_temp.check((select count(*) from public.document_numbering where business_id = '00000000-0000-0000-0000-0000007000b1') = 0,
  'a branch code does not switch the business');
select pg_temp.check((public.document_numbering_per_location() ->> 'perLocation')::boolean, 'the owner switches M to numbering per location');
select pg_temp.check((public.document_numbering_per_location() ->> 'perLocation')::boolean
  and (select count(*) from public.document_numbering where business_id = '00000000-0000-0000-0000-0000007000b1') = 1, 'a second switch changes nothing');
commit;
select pg_temp.check((select branch_code from public.business_locations where id = '00000000-0000-0000-0000-0000007000b1') = '01'
  and (select branch_code from public.business_locations where id = '00000000-0000-0000-0000-0000007000c2') = '05',
  'the switch gave the main location 01; L2 keeps the 05 its owner chose');
select pg_temp.refused_with($$update public.document_numbering set per_location_since = now() where business_id = '00000000-0000-0000-0000-0000007000b1'$$,
  'append', 'the switch is never changed (even by the server)');
select pg_temp.refused_with($$delete from public.document_numbering where business_id = '00000000-0000-0000-0000-0000007000b1'$$,
  'append', 'nor undone');

-- ======================================================================================================================
-- 3. M numbers per location: the branch code, then the location's running number — never twice in the business
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
select pg_temp.check(pg_temp.num('c70m:main:a') = 1000001 and pg_temp.num('c70m:main:b') = 1000002
  and pg_temp.num('c70m:l2:a') = 5000001 and pg_temp.num('c70m:l2:b') = 5000002,
  'tax invoices: main 01000001, 01000002; L2 05000001, 05000002');
select pg_temp.check(pg_temp.num('c70m:l2:r') = 5000001 and pg_temp.num('c70m:main:r') = 1000001, 'invoice-receipts: each location from 1 of its own');
select pg_temp.check((pg_temp.d('c70m:main:a')).series_location_id = '00000000-0000-0000-0000-0000007000b1'
  and (pg_temp.d('c70m:l2:a')).series_location_id = '00000000-0000-0000-0000-0000007000c2', 'each document names the series that numbered it');
select pg_temp.check((select last_no from public.document_counters where business_id = '00000000-0000-0000-0000-0000007000b1' and doc_type = 305) = 2,
  'the business''s own series stopped at 2');
select pg_temp.check((select count(*) = count(distinct (doc_type, doc_number)) from public.documents where business_id = '00000000-0000-0000-0000-0000007000b1'),
  'no number twice in the business');
-- the state for the settings screen
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007000a1');
insert into out70 select 'state', public.document_numbering_state();
commit;
select pg_temp.check((select (s->>'perLocation')::boolean and (s->>'activeLocations')::int = 2 and s->'business'->>'305' = '2'
                        and jsonb_array_length(s->'locations') = 2 and s->'locations'->0->>'branchCode' = '01'
                        and (s->'locations'->1->'series') @> '[{"docType": 305, "count": 2, "last": "05000002", "next": "05000003"}]'::jsonb
                        and (s->'locations'->0->>'codeFixed')::boolean from (select pg_temp.o('state') as s) x),
  'the state: per location, two locations with their codes, L2''s tax invoices 05000002, next 05000003 (eight digits); the main code fixed');
-- a code stays once the location numbered a document
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007000a1');
select pg_temp.refused_with($$select public.location_branch_code_set('00000000-0000-0000-0000-0000007000c2', '09')$$, 'branch_code_fixed', 'L2 numbered documents: its code stays');
commit;
-- a location opened after the switch gets the next free code
insert into public.business_locations (id, business_id, name, kind, sort)
  values ('00000000-0000-0000-0000-0000007000c3', '00000000-0000-0000-0000-0000007000b1', 'סניף שלישי לדוגמה', 'branch', 2);
select pg_temp.check((select branch_code from public.business_locations where id = '00000000-0000-0000-0000-0000007000c3') = '02',
  'a location opened after the switch: the next free code (02)');

-- ======================================================================================================================
-- 4. a document's base — by its number in the business, as before; a credit is of the location that issues it
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007000a1');
-- L2 credits the main location's 01000001 (1000 before VAT): in L2's series, never beyond the invoice
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007000a1', 330, 1200, 'c70m:cr:over',
  '{"base_doc_type": 305, "base_doc_number": 1000001, "location_id": "00000000-0000-0000-0000-0000007000c2"}'))$$,
  'credit_exceeds_original', 'a credit is within its invoice');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007000a1', 330, 150, 'c70m:cr:l2',
  '{"base_doc_type": 305, "base_doc_number": 1000001, "location_id": "00000000-0000-0000-0000-0000007000c2"}'));
-- no location sent: the location the person works in (the main one), not the invoice's (L2's 05000001)
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007000a1', 330, 100, 'c70m:cr:main', '{"base_doc_type": 305, "base_doc_number": 5000001}'));
-- an invoice of before the switch (#2, of L2) credited at the main location
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007000a1', 330, 10, 'c70m:cr:old',
  '{"base_doc_type": 305, "base_doc_number": 2, "location_id": "00000000-0000-0000-0000-0000007000b1"}'));
commit;
select pg_temp.check(pg_temp.num('c70m:cr:l2') = 5000001 and (pg_temp.d('c70m:cr:l2')).location_id = '00000000-0000-0000-0000-0000007000c2'
  and pg_temp.num('c70m:cr:main') = 1000001 and (pg_temp.d('c70m:cr:main')).location_id = '00000000-0000-0000-0000-0000007000b1'
  and pg_temp.num('c70m:cr:old') = 1000002,
  'credits: in the series of the location that issues them (05000001; 01000001, 01000002) — no number lost to the refusal');
select pg_temp.check((select credited from public.receivables where id = (pg_temp.d('c70m:main:a')).id) = 177
  and (select credited from public.receivables where id = (pg_temp.d('c70m:l2:a')).id) = 118
  and (select credited from public.receivables where id = (pg_temp.d('c70m:old:l2')).id) = 129.8
  and (select credited from public.receivables where id = (pg_temp.d('c70m:old:main')).id) = 0
  and (select credited from public.receivables where id = (pg_temp.d('c70m:l2:b')).id) = 0,
  'receivables: each credit on its own invoice, wherever it was issued');
-- a receipt on L2's 05000001 (236 − 118 credited): 118 left
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007000a1');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007000a1', 400, 120, 'c70m:pay:over',
  jsonb_build_object('paid_document_id', (pg_temp.d('c70m:l2:a')).id, 'vat_amount', 0, 'total', 120, 'vat_rate', 0,
    'lines', '[{"name":"תשלום","qty":1,"unitPriceExVat":120,"discountExVat":0,"totalExVat":120,"vatRate":0,"kind":1}]'::jsonb,
    'payments', jsonb_build_array(jsonb_build_object('method', 1, 'm', 'cash', 'amount', 120, 'date', public.il_today())))))$$,
  'receipt_exceeds_balance', 'L2''s 05000001: 118 left');
commit;

-- ---- goods (not a credit): a document made from a delivery note still goes where the note is --------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007000a1');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007000a1', 200, 100, 'c70m:dn:l2', '{"location_id": "00000000-0000-0000-0000-0000007000c2"}'));
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007000a1', 305, 100, 'c70m:dn:inv:main',
  '{"base_doc_type": 200, "base_doc_number": 5000001, "location_id": "00000000-0000-0000-0000-0000007000b1"}'))$$,
  'location_mismatch', 'an invoice of L2''s delivery note is not issued at the main location');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007000a1', 305, 100, 'c70m:dn:inv', '{"base_doc_type": 200, "base_doc_number": 5000001}'));
commit;
select pg_temp.check(pg_temp.num('c70m:dn:l2') = 5000001 and (pg_temp.d('c70m:dn:inv')).location_id = '00000000-0000-0000-0000-0000007000c2'
  and pg_temp.num('c70m:dn:inv') = 5000003, 'L2''s delivery note 05000001; its invoice at L2 (05000003)');

-- ---- an exempt dealer: before the switch a refund receipt goes where its receipt is; after it, where it is issued -----------
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000007000a5', 'owner@exempt-70.example.test');
insert into public.businesses (id, name, slug) values ('00000000-0000-0000-0000-0000007000b3', 'Exempt 70', 'exempt-70');
insert into public.business_members (business_id, user_id, role, access)
  values ('00000000-0000-0000-0000-0000007000b3', '00000000-0000-0000-0000-0000007000a5', 'owner', 'full');
update public.profiles set current_business_id = '00000000-0000-0000-0000-0000007000b3' where id = '00000000-0000-0000-0000-0000007000a5';
insert into public.register_settings (user_id, business_id, business_type, vat_rate, dealer_number, legal_name, street, city, entity_type) values
  ('00000000-0000-0000-0000-0000007000a5', '00000000-0000-0000-0000-0000007000b3', 'exempt', 0, '000000067', 'עוסקת פטורה לדוגמה', 'הדוגמה', 'עיר דוגמה', 'exempt_dealer');
insert into public.business_locations (id, business_id, name, kind, sort)
  values ('00000000-0000-0000-0000-0000007000c5', '00000000-0000-0000-0000-0000007000b3', 'סניף פטור לדוגמה', 'clinic', 1);
-- a receipt of the exempt dealer (no VAT); below zero = a refund receipt
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
select pg_temp.issue(pg_temp.rcpt(100, 'c70e:old'));
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.rcpt(-10, 'c70e:back:before',
  '{"base_doc_type": 400, "base_doc_number": 1, "location_id": "00000000-0000-0000-0000-0000007000c5"}'))$$,
  'location_mismatch', 'before the switch: a refund receipt goes where its receipt is (as before)');
commit;
-- a business whose own series reached seven digits does not switch (its numbers would meet the locations'): set by hand here
insert into public.document_counters (user_id, business_id, doc_type, last_no)
  values ('00000000-0000-0000-0000-0000007000a5', '00000000-0000-0000-0000-0000007000b3', 100, 1000000);
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007000a5');
select pg_temp.refused_with('select public.document_numbering_per_location()', 'numbering_long_series', 'a series at 1,000,000: no switch');
commit;
update public.document_counters set last_no = 0 where business_id = '00000000-0000-0000-0000-0000007000b3' and doc_type = 100;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007000a5');
select (public.document_numbering_per_location() ->> 'perLocation');
select pg_temp.issue(pg_temp.rcpt(300, 'c70e:main'));
select pg_temp.issue(pg_temp.rcpt(200, 'c70e:l5', '{"location_id": "00000000-0000-0000-0000-0000007000c5"}'));
-- L5 refunds the main location's receipt 01000001 (300): in L5's series, never beyond the receipt
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.rcpt(-301, 'c70e:back:over',
  '{"base_doc_type": 400, "base_doc_number": 1000001, "location_id": "00000000-0000-0000-0000-0000007000c5"}'))$$,
  'refund_receipt_over', 'a refund receipt is within its receipt');
select pg_temp.issue(pg_temp.rcpt(-150, 'c70e:back:l5', '{"base_doc_type": 400, "base_doc_number": 1000001, "location_id": "00000000-0000-0000-0000-0000007000c5"}'));
select pg_temp.issue(pg_temp.rcpt(-40, 'c70e:back:old', '{"base_doc_type": 400, "base_doc_number": 1, "location_id": "00000000-0000-0000-0000-0000007000c5"}'));
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.rcpt(-160, 'c70e:back:l5b', '{"base_doc_type": 400, "base_doc_number": 1000001}'))$$,
  'refund_receipt_over', 'the receipt 01000001 has 150 left');
commit;
select pg_temp.check(pg_temp.num('c70e:old') = 1 and pg_temp.num('c70e:main') = 1000001 and pg_temp.num('c70e:l5') = 2000001
  and pg_temp.num('c70e:back:l5') = 2000002 and pg_temp.num('c70e:back:old') = 2000003
  and (pg_temp.d('c70e:back:l5')).location_id = '00000000-0000-0000-0000-0000007000c5',
  'exempt: receipts 1 (before), 01000001, 02000001; the refund receipts in L5''s series (02000002, 02000003), on receipts of the main location');

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
select pg_temp.check((select doc_number = 5000001 and series_location_id = '00000000-0000-0000-0000-0000007000c2' from public.documents where deposit_id = '00000000-0000-0000-0000-0000007000e2')
  and (select doc_number = 1000001 and series_location_id = '00000000-0000-0000-0000-0000007000b1' from public.documents where deposit_id = '00000000-0000-0000-0000-0000007000e3'),
  'M: a 420 of each location (05000001, 01000001)');
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
select pg_temp.check((select count(*) from public.document_series) >= 5 and (select count(*) from public.document_numbering) = 1, 'a finance member of M reads them');
commit;
select pg_temp.check((select doc_number from public.documents where idempotency_key = 'c70m:old:main') = 1
  and (select doc_number from public.documents where idempotency_key = 'c70m:old:l2') = 2
  and (select series_location_id is null from public.documents where idempotency_key = 'c70m:old:credit'), 'the documents of before keep their numbers, of the business''s series');
create temp table before_again as select pg_temp.snapshot() as s;
\ir ../../supabase/migrations/20261127007000_cpa_rules_stage3.sql
select pg_temp.check((select s from before_again) = pg_temp.snapshot(), 'running it again after the switch and the deposits: nothing changes');

