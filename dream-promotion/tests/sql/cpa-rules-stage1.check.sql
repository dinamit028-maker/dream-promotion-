-- The accountant's answers of 25.11.2026, stage 1 (2.118, migration 6800) on a real Postgres (tests/sql/run.sh):
--   1. a document is dated the day it is issued (Israel time) — any other date refused (doc_date_not_today, 22008)
--   2. a receipt (400) is no longer cancelled by marking "בוטל" — 300 still is; receipts cancelled before stay cancelled
--   3. an exempt dealer's refund = a receipt below zero, on the receipt it refunds, never beyond it; the money out once
--   4. register_settings.deductions_file — 9 digits or empty, saved by the owner like the other details, logged
--   5. a card payment names its credit transaction kind (cardKind 1–5, field 1315); no other payment does
-- "Before": rows of two businesses written as before 6800 (its column and its date trigger taken off first; a card payment
-- without its kind, documents of past days, a receipt cancelled then), and then the migration — once (as on the live database,
-- over rows that exist) and again (it runs twice): every row that was there stays exactly as it was.
-- Fixtures only, fictional: dealer numbers 000000NNN (valid check digit), phones 050-00000NN, mails *.example.test.
--   "Exempt"   E: e1 owner, e2 cashier (exempt dealer, 000000018)
--   "Licensed" L: l1 owner (licensed dealer, 000000026)
\set ON_ERROR_STOP 1
set client_min_messages = warning;

create or replace function pg_temp.check(ok boolean, msg text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'CHECK FAILED: %', msg; end if; end $$;
-- refused with a message that contains the expected words (and, when given, the expected sqlstate)
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
-- the message of a refused statement (null when it was allowed)
create or replace function pg_temp.refusal(stmt text) returns text language plpgsql as $$
begin execute stmt; return null; exception when others then return sqlerrm; end $$;
-- a document row the way the app sends it: one line; a receipt's payment in cash (the amount = the total)
create or replace function pg_temp.doc(p_user text, p_type int, p_before numeric, p_vat numeric, p_rate numeric, p_extra jsonb default '{}')
returns jsonb language sql as $$
  select jsonb_build_object('user_id', p_user, 'doc_type', p_type, 'doc_number', 0, 'doc_date', public.il_today(),
    'customer_name', 'לקוחה לדוגמה', 'before_discount', p_before, 'discount', 0, 'after_discount', p_before, 'vat_amount', p_vat,
    'total', p_before + p_vat, 'vat_rate', p_rate,
    'lines', jsonb_build_array(jsonb_build_object('name', 'טיפול', 'qty', 1, 'unitPriceExVat', p_before, 'discountExVat', 0, 'totalExVat', p_before, 'vatRate', p_rate, 'kind', 1)),
    'payments', case when p_type in (320, 400) then jsonb_build_array(jsonb_build_object('method', 1, 'amount', p_before + p_vat, 'date', public.il_today())) else '[]'::jsonb end)
    || p_extra;
$$;
create or replace function pg_temp.issue(r jsonb) returns uuid language plpgsql as $$
declare cols text; id uuid;
begin
  select string_agg(quote_ident(k), ', ') into cols from jsonb_object_keys(r) k;
  execute format('insert into public.documents (%s) select %s from jsonb_populate_record(null::public.documents, $1) returning id', cols, cols) using r into id;
  return id;
end $$;
create or replace function pg_temp.d(p_key text) returns uuid language sql as $$ select id from public.documents where idempotency_key = p_key $$;
create or replace function pg_temp.num(p_key text) returns int language sql as $$ select doc_number from public.documents where idempotency_key = p_key $$;
-- a refund receipt of E on the receipt p_base: one line, payments as given (default: cash, the whole amount)
create or replace function pg_temp.back(p_amount numeric, p_base text, p_extra jsonb default '{}') returns jsonb language sql as $$
  select pg_temp.doc('00000000-0000-0000-0000-0000000680e1', 400, -p_amount, 0, 0, jsonb_build_object(
    'base_doc_type', 400, 'base_doc_number', pg_temp.num(p_base),
    'lines', jsonb_build_array(jsonb_build_object('name', 'החזר', 'qty', 1, 'unitPriceExVat', -p_amount, 'discountExVat', 0, 'totalExVat', -p_amount, 'vatRate', 0, 'kind', 1)),
    'payments', jsonb_build_array(jsonb_build_object('method', 1, 'amount', -p_amount, 'date', public.il_today())))) || p_extra;
$$;
-- every row of the tables 6800 touches, as text, in a fixed order — "nothing that was there changed"
create or replace function pg_temp.snapshot() returns text language sql as $$
  select md5(coalesce((select string_agg(d::text, '|' order by d.id) from public.documents d), '')
      || coalesce((select string_agg(p::text, '|' order by p.id) from public.payments p), '')
      || coalesce((select string_agg(c::text, '|' order by c.document_id) from public.document_cancellations c), '')
      -- (the business's settings without the new column: it is the one thing the migration adds to their rows — empty)
      || coalesce((select string_agg((to_jsonb(r) - 'deductions_file')::text, '|' order by r.business_id) from public.register_settings r), '')
      || coalesce((select string_agg(m::text, '|' order by m.id) from public.stock_movements m), '')
      || coalesce((select string_agg(a::text, '|' order by a.id) from public.finance_audit_log a), ''));
$$;

-- ---- "before": the date trigger and the column are not there yet ----------------------------------------------------------
drop trigger if exists d_documents_issue_day on public.documents;
drop function if exists public.documents_issue_day();
alter table public.register_settings drop constraint if exists register_settings_deductions_file_check;
alter table public.register_settings drop column if exists deductions_file;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000680e1', 'owner@exempt-68.example.test'), ('00000000-0000-0000-0000-0000000680e2', 'cashier@exempt-68.example.test'),
  ('00000000-0000-0000-0000-0000000680f1', 'owner@licensed-68.example.test');
insert into public.businesses (id, name, slug) values
  ('00000000-0000-0000-0000-0000000680b1', 'Exempt 68', 'exempt-68'), ('00000000-0000-0000-0000-0000000680b2', 'Licensed 68', 'licensed-68');
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-0000000680b1', '00000000-0000-0000-0000-0000000680e1', 'owner', 'full'),
  ('00000000-0000-0000-0000-0000000680b1', '00000000-0000-0000-0000-0000000680e2', 'editor', 'register'),
  ('00000000-0000-0000-0000-0000000680b2', '00000000-0000-0000-0000-0000000680f1', 'owner', 'full');
update public.profiles set current_business_id = '00000000-0000-0000-0000-0000000680b1'
 where id in ('00000000-0000-0000-0000-0000000680e1', '00000000-0000-0000-0000-0000000680e2');
update public.profiles set current_business_id = '00000000-0000-0000-0000-0000000680b2' where id = '00000000-0000-0000-0000-0000000680f1';
insert into public.register_settings (user_id, business_id, business_type, vat_rate, dealer_number, legal_name, street, city, entity_type) values
  ('00000000-0000-0000-0000-0000000680e1', '00000000-0000-0000-0000-0000000680b1', 'exempt', 0, '000000018', 'עוסקת פטורה לדוגמה', 'הדוגמה', 'עיר דוגמה', 'exempt_dealer'),
  ('00000000-0000-0000-0000-0000000680f1', '00000000-0000-0000-0000-0000000680b2', 'licensed', 18, '000000026', 'עוסק מורשה לדוגמה', 'הדוגמה', 'עיר דוגמה', 'licensed_dealer');
insert into public.catalog_items (id, user_id, business_id, name, price, kind, track_stock, stock_qty) values
  ('00000000-0000-0000-0000-0000000680c1', '00000000-0000-0000-0000-0000000680e1', '00000000-0000-0000-0000-0000000680b1', 'קרם לדוגמה', 60, 'product', true, 10);
insert into public.leads (id, user_id, business_id, name, phone, email) values
  ('00000000-0000-0000-0000-0000000680d1', '00000000-0000-0000-0000-0000000680e1', '00000000-0000-0000-0000-0000000680b1', 'לקוחה לדוגמה', '050-0000001', 'client@exempt-68.example.test');
insert into public.leads (id, user_id, business_id, name, phone, email) values
  ('00000000-0000-0000-0000-0000000680d2', '00000000-0000-0000-0000-0000000680e1', '00000000-0000-0000-0000-0000000680b1', 'לקוחה שנייה לדוגמה', '050-0000002', 'client2@exempt-68.example.test');

-- documents as issued before 6800, in both businesses: days ago, a card payment without its kind, a receipt cancelled then
-- (documents_validate of 6800 asks for the kind, so it is set aside for these rows only — as the old one let them in)
alter table public.documents disable trigger c_documents_validate;
alter table public.document_cancellations disable trigger b_document_cancellations_check;
insert into public.documents (id, user_id, business_id, doc_type, doc_number, doc_date, customer_name, before_discount, discount, after_discount,
                              vat_amount, total, vat_rate, lines, payments, idempotency_key, source) values
  ('00000000-0000-0000-0000-0000000680a1', '00000000-0000-0000-0000-0000000680e1', '00000000-0000-0000-0000-0000000680b1', 400, 0, public.il_today() - 10,
   'לקוחה לדוגמה', 200, 0, 200, 0, 200, 0, '[{"name":"טיפול","qty":1,"unitPriceExVat":200,"discountExVat":0,"totalExVat":200,"vatRate":0,"kind":1}]',
   jsonb_build_array(jsonb_build_object('method', 3, 'amount', 200, 'date', public.il_today() - 10, 'm', 'card')), 'old:e:card', 'direct'),
  ('00000000-0000-0000-0000-0000000680a2', '00000000-0000-0000-0000-0000000680e1', '00000000-0000-0000-0000-0000000680b1', 400, 0, public.il_today() - 9,
   'לקוחה לדוגמה', 90, 0, 90, 0, 90, 0, '[{"name":"טיפול","qty":1,"unitPriceExVat":90,"discountExVat":0,"totalExVat":90,"vatRate":0,"kind":1}]',
   jsonb_build_array(jsonb_build_object('method', 1, 'amount', 90, 'date', public.il_today() - 9)), 'old:e:cancelled', 'direct'),
  ('00000000-0000-0000-0000-0000000680a3', '00000000-0000-0000-0000-0000000680f1', '00000000-0000-0000-0000-0000000680b2', 320, 0, public.il_today() - 8,
   'לקוח לדוגמה', 100, 0, 100, 18, 118, 18, '[{"name":"שירות","qty":1,"unitPriceExVat":100,"discountExVat":0,"totalExVat":100,"vatRate":18,"kind":1}]',
   jsonb_build_array(jsonb_build_object('method', 3, 'amount', 118, 'date', public.il_today() - 8, 'm', 'card')), 'old:l:card', 'direct');
insert into public.document_cancellations (document_id, business_id, user_id, reason)
  values ('00000000-0000-0000-0000-0000000680a2', '00000000-0000-0000-0000-0000000680b1', '00000000-0000-0000-0000-0000000680e1', 'הופקה בטעות');
alter table public.document_cancellations enable trigger b_document_cancellations_check;
alter table public.documents enable trigger c_documents_validate;
select pg_temp.check((select count(*) from public.payments where document_id in ('00000000-0000-0000-0000-0000000680a1', '00000000-0000-0000-0000-0000000680a3')) = 2,
  'the old receipts wrote their money');

-- ---- the migration: over these rows (the first time), and again ------------------------------------------------------------
create temp table before_6800 as select pg_temp.snapshot() as s;
\ir ../../supabase/migrations/20261125006800_cpa_rules_stage1.sql
select pg_temp.check((select s from before_6800) = pg_temp.snapshot(), 'the migration over existing rows: every row stays as it was');
select pg_temp.check((select count(*) from public.register_settings where deductions_file is not null) = 0, 'the new column is empty in every business');
\ir ../../supabase/migrations/20261125006800_cpa_rules_stage1.sql
select pg_temp.check((select s from before_6800) = pg_temp.snapshot(), 'the migration again: every row stays as it was');
select pg_temp.check((select count(*) from pg_trigger where tgname = 'd_documents_issue_day' and tgrelid = 'public.documents'::regclass) = 1,
  'one date trigger after running twice');
select pg_temp.check((select doc_date from public.documents where id = '00000000-0000-0000-0000-0000000680a1') = public.il_today() - 10
  and (select payments from public.documents where id = '00000000-0000-0000-0000-0000000680a1') = jsonb_build_array(jsonb_build_object('method', 3, 'amount', 200, 'date', public.il_today() - 10, 'm', 'card')),
  'an old document keeps its date and its card payment without a kind');
select pg_temp.check(exists (select 1 from public.document_cancellations where document_id = '00000000-0000-0000-0000-0000000680a2'),
  'a receipt cancelled before 6800 stays cancelled');
-- the functions: no browser role runs them
select pg_temp.check(not has_function_privilege('authenticated', 'public.documents_issue_day()', 'execute')
  and not has_function_privilege('anon', 'public.documents_issue_day()', 'execute')
  and not has_function_privilege('authenticated', 'public.documents_validate()', 'execute')
  and not has_function_privilege('authenticated', 'public.documents_after_insert()', 'execute')
  and not has_function_privilege('authenticated', 'public.document_cancellations_check()', 'execute')
  and not has_function_privilege('authenticated', 'public.register_settings_audit()', 'execute'), 'the trigger functions are not callable by the browser roles');
-- the order of the documents' BEFORE INSERT triggers: the date's after the validation, before the numbering
select pg_temp.check((select array_agg(tgname::text order by tgname::text) from pg_trigger
                       where tgrelid = 'public.documents'::regclass and not tgisinternal and tgtype & 2 = 2 and tgtype & 4 = 4
                         and tgname in ('c_documents_validate', 'd_documents_issue_day', 'documents_number'))
  = array['c_documents_validate', 'd_documents_issue_day', 'documents_number'], 'the date is checked after the validation, before a number is taken');

-- ======================================================================================================================
-- 1. the date of a document is the day it is issued
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000680f1');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000680f1', 305, 100, 18, 18, '{"idempotency_key":"l:today"}'));
select pg_temp.check((select doc_date from public.documents where idempotency_key = 'l:today') = public.il_today(), 'a document of today');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000680f1', 305, 100, 18, 18,
  jsonb_build_object('doc_date', public.il_today() - 1, 'idempotency_key', 'l:yday')))$$, 'doc_date_not_today', 'a document dated yesterday', '22008');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000680f1', 305, 100, 18, 18,
  jsonb_build_object('doc_date', public.il_today() - 400)))$$, 'תאריך המסמך הוא תמיד יום ההפקה', 'a document dated last year — with the Hebrew reason');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000680f1', 400, 50, 0, 0,
  jsonb_build_object('doc_date', public.il_today() - 1)))$$, 'doc_date_not_today', 'a receipt dated yesterday', '22008');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000680f1', 305, 100, 18, 18,
  jsonb_build_object('doc_date', public.il_today() + 5)))$$, 'future', 'a document dated next week (as before)');
-- no date sent: the database's today; a client clock a little ahead: brought back to today (as before)
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000680f1', 305, 100, 18, 18, '{"idempotency_key":"l:nodate"}') - 'doc_date');
select pg_temp.check((select doc_date from public.documents where idempotency_key = 'l:nodate') = public.il_today(), 'no date sent = today');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000680f1', 305, 100, 18, 18, jsonb_build_object('doc_date', null, 'idempotency_key', 'l:nulldate')));
select pg_temp.check((select doc_date from public.documents where idempotency_key = 'l:nulldate') = public.il_today(), 'a null date = today');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000680f1', 305, 100, 18, 18, jsonb_build_object('doc_date', public.il_today() + 1, 'idempotency_key', 'l:ahead')));
select pg_temp.check((select doc_date from public.documents where idempotency_key = 'l:ahead') = public.il_today(), 'tomorrow (a clock ahead) is brought back to today');
-- a refused date burns no number
select pg_temp.check((select array_agg(doc_number order by doc_number) from public.documents where doc_type = 305) = array[1, 2, 3, 4]::bigint[],
  'the refused documents left no gap in the numbering');
commit;

-- ======================================================================================================================
-- 5. a card payment names its credit transaction kind
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000680f1');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000680f1', 320, 100, 18, 18,
  jsonb_build_object('payments', jsonb_build_array(jsonb_build_object('method', 3, 'amount', 118, 'date', public.il_today(), 'm', 'card')))))$$,
  'card_kind_missing', 'a card payment without its kind');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000680f1', 320, 100, 18, 18,
  jsonb_build_object('payments', jsonb_build_array(jsonb_build_object('method', 3, 'cardKind', 0, 'amount', 118, 'date', public.il_today())))))$$,
  'card_kind_missing', 'card kind 0');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000680f1', 320, 100, 18, 18,
  jsonb_build_object('payments', jsonb_build_array(jsonb_build_object('method', 3, 'cardKind', 6, 'amount', 118, 'date', public.il_today())))))$$,
  'card_kind_missing', 'card kind 6');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000680f1', 320, 100, 18, 18,
  jsonb_build_object('payments', jsonb_build_array(jsonb_build_object('method', 3, 'cardKind', '2', 'amount', 118, 'date', public.il_today())))))$$,
  'card_kind_missing', 'a card kind as text');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000680f1', 320, 100, 18, 18,
  jsonb_build_object('payments', jsonb_build_array(jsonb_build_object('method', 3, 'cardKind', 1.5, 'amount', 118, 'date', public.il_today())))))$$,
  'card_kind_missing', 'a card kind that is not whole');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000680f1', 320, 100, 18, 18,
  jsonb_build_object('payments', jsonb_build_array(jsonb_build_object('method', 1, 'cardKind', 1, 'amount', 118, 'date', public.il_today())))))$$,
  'card_kind_not_card', 'a card kind on cash');
-- one card payment in installments and one in cash: the kinds stay in the document as sent
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000680f1', 320, 100, 18, 18, jsonb_build_object('idempotency_key', 'l:card',
  'payments', jsonb_build_array(jsonb_build_object('method', 3, 'cardKind', 2, 'amount', 100, 'date', public.il_today(), 'm', 'card'),
                                jsonb_build_object('method', 1, 'amount', 18, 'date', public.il_today(), 'm', 'cash')))));
select pg_temp.check((select payments->0->>'cardKind' from public.documents where idempotency_key = 'l:card') = '2'
  and not ((select payments->1 from public.documents where idempotency_key = 'l:card') ? 'cardKind'), 'the card''s kind is kept with its payment');
select pg_temp.check((select count(*) from public.payments where document_id = pg_temp.d('l:card') and method = 'card' and amount = 100) = 1,
  'the ledger as before (one row per payment)');
-- every kind of field 1315
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000680f1', 320, 100, 18, 18, jsonb_build_object('idempotency_key', 'l:kind:' || k,
  'payments', jsonb_build_array(jsonb_build_object('method', 3, 'cardKind', k, 'amount', 118, 'date', public.il_today())))))
  from generate_series(1, 5) k;
select pg_temp.check((select count(*) from public.documents where idempotency_key like 'l:kind:%') = 5, 'the kinds 1–5: regular, installments, credit, deferred, other');
-- the register / a server path on the code before 2.118 (no kind sent): a sale's document and a payment link's receipt get 1;
-- the rest of the payment and a kind that is sent stay as they are; a wrong kind is refused there too
insert into public.sales (id, user_id, items, subtotal, total, vat_rate, vat_amount, method, status, paid_at)
values ('00000000-0000-0000-0000-00000006805b', '00000000-0000-0000-0000-0000000680f1', '[{"name":"שירות","price":118,"qty":1,"kind":"other"}]', 118, 118, 18, 18, 'card', 'paid', now());
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000680f1', 320, 100, 18, 18, jsonb_build_object('idempotency_key', 'sale:00000000-0000-0000-0000-00000006805b',
  'sale_id', '00000000-0000-0000-0000-00000006805b', 'source', 'pos',
  'payments', jsonb_build_array(jsonb_build_object('method', 3, 'amount', 118, 'date', public.il_today(), 'm', 'card')))));
select pg_temp.check((select payments from public.documents where idempotency_key = 'sale:00000000-0000-0000-0000-00000006805b')
  = jsonb_build_array(jsonb_build_object('method', 3, 'amount', 118, 'date', public.il_today(), 'm', 'card', 'cardKind', 1)), 'a register sale''s card without a kind: 1 (regular)');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000680f1', 320, 100, 18, 18, jsonb_build_object('idempotency_key', 'paylink:00000000-0000-0000-0000-00000006805c',
  'payments', jsonb_build_array(jsonb_build_object('method', 3, 'amount', 100, 'date', public.il_today(), 'm', 'card'),
                                jsonb_build_object('method', 3, 'cardKind', 2, 'amount', 18, 'date', public.il_today(), 'm', 'card')))));
select pg_temp.check((select array_agg(p->>'cardKind' order by o) from public.documents, jsonb_array_elements(payments) with ordinality x(p, o)
                       where idempotency_key = 'paylink:00000000-0000-0000-0000-00000006805c') = array['1', '2'], 'a payment link''s receipt: 1 where missing, the sent kind kept');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000680f1', 320, 100, 18, 18, jsonb_build_object('idempotency_key', 'paylink:00000000-0000-0000-0000-00000006805d',
  'payments', jsonb_build_array(jsonb_build_object('method', 3, 'cardKind', 7, 'amount', 118, 'date', public.il_today())))))$$,
  'card_kind_missing', 'a wrong kind on a server path');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000680f1', 320, 100, 18, 18, jsonb_build_object('idempotency_key', 'direct:00000000-0000-0000-0000-00000006805e',
  'payments', jsonb_build_array(jsonb_build_object('method', 3, 'amount', 118, 'date', public.il_today())))))$$,
  'card_kind_missing', 'a document composed by hand: the kind is required');
commit;

-- ======================================================================================================================
-- 2. a receipt is not cancelled by marking; a transaction invoice still is
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000680e1');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000680e1', 400, 300, 0, 0, '{"idempotency_key":"e:r1","id":"00000000-0000-0000-0000-0000000680a4","lead_id":"00000000-0000-0000-0000-0000000680d1"}'));
select pg_temp.refused_with($$insert into public.document_cancellations (document_id, user_id, reason) values (pg_temp.d('e:r1'), '00000000-0000-0000-0000-0000000680e1', 'הופקה בטעות')$$,
  'cancel_receipt_not_allowed', 'a receipt is not cancelled by marking');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000680e1', 300, 120, 0, 0, '{"idempotency_key":"e:t1"}'));
insert into public.document_cancellations (document_id, user_id, reason) values (pg_temp.d('e:t1'), '00000000-0000-0000-0000-0000000680e1', 'הופקה בטעות');
select pg_temp.check(exists (select 1 from public.document_cancellations where document_id = pg_temp.d('e:t1')), 'a transaction invoice (300) is still cancelled');
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000680f1');
select pg_temp.refused_with($$insert into public.document_cancellations (document_id, user_id, reason) values (pg_temp.d('l:card'), '00000000-0000-0000-0000-0000000680f1', 'טעות')$$,
  'cancel_not_allowed', 'a tax invoice-receipt (320) is not cancelled (as before)');
-- another business's receipt: not found (the message of a refusal tells nothing of it)
select pg_temp.refused_with($$insert into public.document_cancellations (document_id, user_id, reason) values ('00000000-0000-0000-0000-0000000680a4', '00000000-0000-0000-0000-0000000680f1', 'טעות')$$,
  'not found', 'another business''s receipt');
commit;

-- ======================================================================================================================
-- 3. an exempt dealer's refund: a receipt below zero
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000680e1');
create temp table rev0 on commit drop as select (public.finance_summary(public.il_today() - 30, public.il_today()) -> 'revenue' ->> 'net')::numeric as net;
-- from the money screens (no refund of a sale): the money out on the refund receipt itself
select pg_temp.issue(pg_temp.back(100, 'e:r1', '{"idempotency_key":"e:back1","lead_id":"00000000-0000-0000-0000-0000000680d1"}'));
select pg_temp.check((select (doc_type, total, base_doc_type, base_doc_number, source) = (400, -100::numeric, 400, pg_temp.num('e:r1'), 'refund')
                        from public.documents where idempotency_key = 'e:back1'), 'a refund receipt: 400, below zero, on the receipt, "refund"');
select pg_temp.check(pg_temp.num('e:back1') = pg_temp.num('e:r1') + 1, 'it is numbered with the receipts');
select pg_temp.check((select count(*) from public.payments where document_id = pg_temp.d('e:back1')) = 1
  and (select (direction, amount, method, source) = ('out', 100::numeric, 'cash', 'document') from public.payments where document_id = pg_temp.d('e:back1')),
  'the money out: one ledger row, out, above zero');
select pg_temp.check((public.finance_summary(public.il_today() - 30, public.il_today()) -> 'revenue' ->> 'net')::numeric = (select net from rev0) - 100,
  'an exempt dealer''s income is lowered by the refund');
select pg_temp.check(public.doc_revenue(400, false, -100, -100, false) = -100, 'doc_revenue of a refund receipt');
-- never beyond the receipt (300): 100 refunded, 200 left
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.back(250, 'e:r1'))$$, 'refund_receipt_over', 'beyond what is left on the receipt');
select pg_temp.issue(pg_temp.back(200, 'e:r1', '{"idempotency_key":"e:back2"}'));
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.back(0.01, 'e:r1'))$$, 'refund_receipt_over', 'a receipt refunded in full takes no more');
-- what a refund receipt is not
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000680e1', 400, 150, 0, 0, '{"idempotency_key":"e:r2"}'));
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.back(10, 'e:r2') - 'base_doc_type' - 'base_doc_number')$$, 'refund_receipt_base', 'without the receipt it refunds');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.back(10, 'e:r2') || '{"base_doc_number": 9999}')$$, 'refund_receipt_base', 'a receipt that does not exist');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.back(10, 'e:r2') || jsonb_build_object('base_doc_number', pg_temp.num('e:back1')))$$,
  'refund_receipt_base', 'on a refund receipt');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.back(10, 'e:r2') || jsonb_build_object('base_doc_number', pg_temp.num('old:e:cancelled')))$$,
  'בוטלה', 'on a cancelled receipt');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.back(10, 'e:r2') || jsonb_build_object('base_doc_type', 300, 'base_doc_number', pg_temp.num('e:t1')))$$,
  'refund_receipt_base', 'on a transaction invoice');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.back(10, 'e:r2', jsonb_build_object('payments', jsonb_build_array(jsonb_build_object('method', 1, 'amount', 10, 'date', public.il_today())))))$$,
  'refund_receipt_payments', 'money in on a refund receipt');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.back(10, 'e:r2', jsonb_build_object('payments', jsonb_build_array(jsonb_build_object('method', 1, 'amount', -6, 'date', public.il_today())))))$$,
  'paid but the document says', 'payments that do not add up to the refund');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.back(10, 'e:r2', jsonb_build_object('payments', jsonb_build_array(
  jsonb_build_object('method', 1, 'amount', -8, 'date', public.il_today()), jsonb_build_object('method', 9, 'amount', -2, 'm', 'withholding', 'pct', 20)))))$$,
  'refund_receipt_payments', 'tax withheld at source on a refund');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.back(10, 'e:r2', '{"discount": 1, "after_discount": -11}'))$$, 'totals:', 'a discount on a refund receipt');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.back(10, 'e:r2', jsonb_build_object('lines', jsonb_build_array(jsonb_build_object('name', 'x', 'qty', 1, 'totalExVat', -7)))))$$,
  'lines add up', 'lines that do not add up');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.back(10, 'e:r2', jsonb_build_object('paid_document_id', pg_temp.d('e:t1'))))$$, 'refund_receipt_alone', 'a refund receipt paying an invoice');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.back(10, 'e:r2', jsonb_build_object('doc_date', public.il_today() - 1)))$$, 'doc_date_not_today', 'a refund receipt of yesterday');
-- to a card: its kind, as any card payment
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.back(10, 'e:r2', jsonb_build_object('payments', jsonb_build_array(jsonb_build_object('method', 3, 'amount', -10, 'date', public.il_today())))))$$,
  'card_kind_missing', 'a refund to a card without its kind');
select pg_temp.issue(pg_temp.back(10, 'e:r2', jsonb_build_object('idempotency_key', 'e:back-card',
  'payments', jsonb_build_array(jsonb_build_object('method', 3, 'cardKind', 1, 'amount', -10, 'date', public.il_today(), 'm', 'card')))));
select pg_temp.check((select (direction, amount, method) = ('out', 10::numeric, 'card') from public.payments where document_id = pg_temp.d('e:back-card')), 'a refund to a card: out, by card');
-- products: the lines marked "restock" come back; a refund receipt never takes stock out
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000680e1', 400, 120, 0, 0, jsonb_build_object('idempotency_key', 'e:cream',
  'lines', jsonb_build_array(jsonb_build_object('name', 'קרם לדוגמה', 'qty', 2, 'unitPriceExVat', 60, 'totalExVat', 120, 'vatRate', 0, 'kind', 1, 'itemId', '00000000-0000-0000-0000-0000000680c1')))));
select pg_temp.check((select stock_qty from public.catalog_items where id = '00000000-0000-0000-0000-0000000680c1') = 8, 'two out on the receipt');
select pg_temp.issue(pg_temp.back(120, 'e:cream', jsonb_build_object('idempotency_key', 'e:cream-back',
  'lines', jsonb_build_array(jsonb_build_object('name', 'קרם לדוגמה', 'qty', 1, 'unitPriceExVat', -60, 'totalExVat', -60, 'vatRate', 0, 'kind', 1, 'restock', true, 'itemId', '00000000-0000-0000-0000-0000000680c1'),
                             jsonb_build_object('name', 'קרם לדוגמה (נפתח)', 'qty', 1, 'unitPriceExVat', -60, 'totalExVat', -60, 'vatRate', 0, 'kind', 1, 'itemId', '00000000-0000-0000-0000-0000000680c1')))));
select pg_temp.check((select stock_qty from public.catalog_items where id = '00000000-0000-0000-0000-0000000680c1') = 9, 'one back (restock), the opened one not');
select pg_temp.check((select count(*) from public.stock_movements where document_id = pg_temp.d('e:cream-back') and reason = 'refund' and delta = 1) = 1, 'logged as a refund');
commit;

-- the register's refund: the refund's own ledger row is the money out — the refund receipt adds no second one
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000680e2');
insert into public.sales (id, user_id, lead_id, items, subtotal, total, vat_rate, vat_amount, method, status, paid_at)
values ('00000000-0000-0000-0000-00000006805a', '00000000-0000-0000-0000-0000000680e2', '00000000-0000-0000-0000-0000000680d1',
  '[{"name":"טיפול","price":80,"qty":1,"kind":"other"}]', 80, 80, 0, 0, 'cash', 'paid', now());
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000680e2', 400, 80, 0, 0, jsonb_build_object('idempotency_key', 'sale:00000000-0000-0000-0000-00000006805a',
  'sale_id', '00000000-0000-0000-0000-00000006805a', 'source', 'pos')));
commit;
-- the refund — by the owner (a cashier records none: sale_refunds_cashier_none)
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000680e1');
insert into public.sale_refunds (id, user_id, sale_id, amount, vat_amount, method, items, restock, reason)
values ('00000000-0000-0000-0000-00000006806a', '00000000-0000-0000-0000-0000000680e1', '00000000-0000-0000-0000-00000006805a', 50, 0, 'cash', '[]', false, 'ביקשה החזר');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000680e1', 400, -40, 0, 0, jsonb_build_object(
  'base_doc_type', 400, 'base_doc_number', pg_temp.num('sale:00000000-0000-0000-0000-00000006805a'),
  'sale_id', '00000000-0000-0000-0000-00000006805a', 'refund_id', '00000000-0000-0000-0000-00000006806a')))$$,
  'refund_receipt_refund', 'a refund receipt of another sum than the refund');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000680e1', 400, -50, 0, 0, jsonb_build_object(
  'base_doc_type', 400, 'base_doc_number', pg_temp.num('e:r2'), 'refund_id', '00000000-0000-0000-0000-00000006806a')))$$,
  'refund_receipt_refund', 'a refund of one sale on the receipt of another');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000680e1', 400, -50, 0, 0, jsonb_build_object('idempotency_key', 'refund:00000000-0000-0000-0000-00000006806a',
  'base_doc_type', 400, 'base_doc_number', pg_temp.num('sale:00000000-0000-0000-0000-00000006805a'),
  'sale_id', '00000000-0000-0000-0000-00000006805a', 'refund_id', '00000000-0000-0000-0000-00000006806a')));
select pg_temp.check((select source from public.documents where idempotency_key = 'refund:00000000-0000-0000-0000-00000006806a') = 'refund', 'the refund receipt of the register''s refund');
commit;
-- (the owner reads the ledger)
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000680e1');
select pg_temp.check((select count(*) from public.payments where document_id = pg_temp.d('refund:00000000-0000-0000-0000-00000006806a')) = 0
  and (select count(*) from public.payments where sale_id = '00000000-0000-0000-0000-00000006805a' and direction = 'out') = 1
  and (select amount from public.payments where sale_id = '00000000-0000-0000-0000-00000006805a' and direction = 'out') = 50, 'the money out of the register''s refund: once');
commit;

-- a sale refunded twice? Never: what went back on a receipt — its refund receipts and its sale's refunds — never passes it,
-- whichever comes first. And a refund receipt of a sale without its refund only once the sale was cancelled.
--   5c: 100, refunded 40 from the money screens (a package sold at the register, refunded from its screen), then cancelled:
--       the cancel's refund receipt — only the 60 left
--   5d: 100, a register refund of 30 (no refund receipt yet), then 80 from the money screens: only 70; then the refund's own
--       refund receipt (30) still passes — 30 + 70 = 100, the money out once
--   5e: 100, 80 back from the money screens first, then a register refund of 30: only 20
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000680e1');
insert into public.sales (id, user_id, items, subtotal, total, vat_rate, vat_amount, method, status, paid_at) values
  ('00000000-0000-0000-0000-00000006805c', '00000000-0000-0000-0000-0000000680e1', '[{"name":"חבילה","price":100,"qty":1,"kind":"other"}]', 100, 100, 0, 0, 'cash', 'paid', now()),
  ('00000000-0000-0000-0000-00000006805d', '00000000-0000-0000-0000-0000000680e1', '[{"name":"חבילה","price":100,"qty":1,"kind":"other"}]', 100, 100, 0, 0, 'cash', 'paid', now()),
  ('00000000-0000-0000-0000-00000006805e', '00000000-0000-0000-0000-0000000680e1', '[{"name":"חבילה","price":100,"qty":1,"kind":"other"}]', 100, 100, 0, 0, 'cash', 'paid', now());
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000680e1', 400, 100, 0, 0, jsonb_build_object('idempotency_key', 'sale:' || x, 'sale_id', x, 'source', 'pos')))
  from unnest(array['00000000-0000-0000-0000-00000006805c', '00000000-0000-0000-0000-00000006805d', '00000000-0000-0000-0000-00000006805e']) x;
-- on a sale that was not cancelled: never without its refund (the owner too)
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.back(10, 'sale:00000000-0000-0000-0000-00000006805d', '{"sale_id": "00000000-0000-0000-0000-00000006805d"}'))$$,
  'refund_receipt_sale', 'a refund receipt of a sale that was not cancelled, without its refund');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.back(10, 'sale:00000000-0000-0000-0000-00000006805d', '{"sale_id": "00000000-0000-0000-0000-00000006805e"}'))$$,
  'refund_receipt_sale', 'a refund receipt of one sale on the receipt of another');
-- 5c: 40 back from the money screens, then the sale cancelled
select pg_temp.issue(pg_temp.back(40, 'sale:00000000-0000-0000-0000-00000006805c', jsonb_build_object('idempotency_key', 'refund:' || pg_temp.d('sale:00000000-0000-0000-0000-00000006805c') || ':1')));
update public.sales set status = 'cancelled' where id = '00000000-0000-0000-0000-00000006805c';
-- 5d: a register refund of 30, then the money screens — 70 left, not 100
insert into public.sale_refunds (id, user_id, sale_id, amount, vat_amount, method, items, restock, reason)
values ('00000000-0000-0000-0000-00000006806d', '00000000-0000-0000-0000-0000000680e1', '00000000-0000-0000-0000-00000006805d', 30, 0, 'cash', '[]', false, 'החזר בקופה');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.back(80, 'sale:00000000-0000-0000-0000-00000006805d'))$$, 'נשארו להחזר 70', 'a sale''s refund counts on its receipt');
select pg_temp.issue(pg_temp.back(70, 'sale:00000000-0000-0000-0000-00000006805d', '{"idempotency_key": "e:5d-back"}'));
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000680e1', 400, -30, 0, 0, jsonb_build_object('idempotency_key', 'refund:00000000-0000-0000-0000-00000006806d',
  'base_doc_type', 400, 'base_doc_number', pg_temp.num('sale:00000000-0000-0000-0000-00000006805d'), 'sale_id', '00000000-0000-0000-0000-00000006805d', 'refund_id', '00000000-0000-0000-0000-00000006806d')));
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.back(0.01, 'sale:00000000-0000-0000-0000-00000006805d'))$$, 'refund_receipt_over', 'nothing left on 5d');
-- 5e: 80 from the money screens first; a register refund after it — only 20
select pg_temp.issue(pg_temp.back(80, 'sale:00000000-0000-0000-0000-00000006805e', '{"idempotency_key": "e:5e-back"}'));
select pg_temp.refused_with($$insert into public.sale_refunds (user_id, sale_id, amount, vat_amount, method, items, restock, reason)
  values ('00000000-0000-0000-0000-0000000680e1', '00000000-0000-0000-0000-00000006805e', 30, 0, 'cash', '[]', false, 'x')$$, 'refund_exceeds_paid', 'a register refund counts the refund receipts of its sale');
insert into public.sale_refunds (id, user_id, sale_id, amount, vat_amount, method, items, restock, reason)
values ('00000000-0000-0000-0000-00000006806e', '00000000-0000-0000-0000-0000000680e1', '00000000-0000-0000-0000-00000006805e', 20, 0, 'cash', '[]', false, 'השאר');
commit;
select pg_temp.check((select sum(case direction when 'out' then amount else -amount end) from public.payments where direction = 'out'
                        and (sale_id = '00000000-0000-0000-0000-00000006805d' or document_id in (select id from public.documents where base_doc_type = 400 and base_doc_number = pg_temp.num('sale:00000000-0000-0000-0000-00000006805d')
                                                                       and business_id = '00000000-0000-0000-0000-0000000680b1'))) = 100, '5d: 100 out in all (30 at the register + 70), never 130');
select pg_temp.check((select sum(amount) from public.payments where direction = 'out'
                        and (sale_id = '00000000-0000-0000-0000-00000006805e' or document_id = pg_temp.d('e:5e-back'))) = 100, '5e: 100 out in all (80 + 20)');

-- a cashier: only the refund of a sale, on that sale's receipt; no restock without the refund; no amounts in a refusal
-- (the receipts' numbers read here, by the superuser — a cashier sees only the documents of their own sales)
create temp table n68 as select idempotency_key as k, doc_number as n from public.documents where business_id = '00000000-0000-0000-0000-0000000680b1';
grant select on n68 to authenticated;
create or replace function pg_temp.cb(p_amount numeric, p_base text, p_extra jsonb) returns jsonb language sql as $$
  select pg_temp.back(p_amount, p_base) || jsonb_build_object('user_id', '00000000-0000-0000-0000-0000000680e2', 'base_doc_number', (select n from n68 where k = p_base)) || p_extra;
$$;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000680e2');
select pg_temp.check(public.my_access() = 'register', 'e2 is a cashier');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.cb(10, 'e:r2', '{}'))$$,
  'cashier_refund', 'a cashier''s refund receipt that is not of a sale');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.cb(10, 'e:r2', '{"sale_id": "00000000-0000-0000-0000-00000006805a"}'))$$,
  'cashier_refund', 'a cashier''s refund of a sale on another receipt');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.cb(10, 'sale:00000000-0000-0000-0000-00000006805c', jsonb_build_object(
  'sale_id', '00000000-0000-0000-0000-00000006805c',
  'lines', jsonb_build_array(jsonb_build_object('name', 'קרם', 'qty', 1, 'totalExVat', -10, 'restock', true, 'itemId', '00000000-0000-0000-0000-0000000680c1')))))$$,
  'cashier_refund', 'a cashier''s restock without the refund');
select pg_temp.check(pg_temp.refusal($$select pg_temp.issue(pg_temp.cb(10, 'old:e:cancelled', '{"sale_id": "00000000-0000-0000-0000-00000006805a"}'))$$)
  like 'cashier_refund:%', 'a receipt that is not the sale''s: not told it was cancelled');
-- 5a (not cancelled; 80, 50 refunded at the register): a cashier never refunds it without the register's refund
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.cb(10, 'sale:00000000-0000-0000-0000-00000006805a', '{"sale_id": "00000000-0000-0000-0000-00000006805a"}'))$$,
  'refund_receipt_sale', 'a cashier''s refund receipt of a sale that was not cancelled');
-- 5c (cancelled; 100, 40 back): the cancel's refund receipt — the 60 left only, and the cashier is told no number
select pg_temp.check(pg_temp.refusal($$select pg_temp.issue(pg_temp.cb(70, 'sale:00000000-0000-0000-0000-00000006805c', '{"sale_id": "00000000-0000-0000-0000-00000006805c"}'))$$)
  ~ '^refund_receipt_over: [^0-9]*$', 'beyond what is left: refused, without the amount left');
select pg_temp.issue(pg_temp.cb(60, 'sale:00000000-0000-0000-0000-00000006805c', '{"sale_id": "00000000-0000-0000-0000-00000006805c", "idempotency_key": "e:cashier-back"}'));
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.cb(0.01, 'sale:00000000-0000-0000-0000-00000006805c', '{"sale_id": "00000000-0000-0000-0000-00000006805c"}'))$$, 'refund_receipt_over', 'nothing left on 5c');
commit;
select pg_temp.check((select (direction, amount) = ('out', 60::numeric) from public.payments where document_id = (select id from public.documents where idempotency_key = 'e:cashier-back')),
  'the cancelled sale''s rest goes back on the cashier''s refund receipt');

-- the customer's card: a sale of 100, refunded in full at the register with its refund receipt — owes 0 (as with a 330)
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000680e1');
insert into public.sales (id, user_id, lead_id, items, subtotal, total, vat_rate, vat_amount, method, status, paid_at)
values ('00000000-0000-0000-0000-00000006805f', '00000000-0000-0000-0000-0000000680e1', '00000000-0000-0000-0000-0000000680d2',
  '[{"name":"טיפול","price":100,"qty":1,"kind":"other"}]', 100, 100, 0, 0, 'cash', 'paid', now());
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000680e1', 400, 100, 0, 0, jsonb_build_object('idempotency_key', 'sale:00000000-0000-0000-0000-00000006805f',
  'sale_id', '00000000-0000-0000-0000-00000006805f', 'lead_id', '00000000-0000-0000-0000-0000000680d2', 'source', 'pos')));
select pg_temp.check((public.report_customer_ledger('l:00000000-0000-0000-0000-0000000680d2', public.il_today() - 30, public.il_today())->>'closing')::numeric = 0,
  'the card after the sale: paid, owes 0');
insert into public.sale_refunds (id, user_id, sale_id, amount, vat_amount, method, items, restock, reason)
values ('00000000-0000-0000-0000-00000006806b', '00000000-0000-0000-0000-0000000680e1', '00000000-0000-0000-0000-00000006805f', 100, 0, 'cash', '[]', false, 'ביקשה החזר');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000680e1', 400, -100, 0, 0, jsonb_build_object('idempotency_key', 'refund:00000000-0000-0000-0000-00000006806b',
  'base_doc_type', 400, 'base_doc_number', pg_temp.num('sale:00000000-0000-0000-0000-00000006805f'), 'lead_id', '00000000-0000-0000-0000-0000000680d2',
  'sale_id', '00000000-0000-0000-0000-00000006805f', 'refund_id', '00000000-0000-0000-0000-00000006806b')));
select pg_temp.check((public.report_customer_ledger('l:00000000-0000-0000-0000-0000000680d2', public.il_today() - 30, public.il_today())->>'closing')::numeric = 0,
  'the card after the full refund with its refund receipt: owes 0 (the refund''s money out is the refund receipt''s)');
select pg_temp.check((select count(*) from jsonb_array_elements(public.report_customer_ledger('l:00000000-0000-0000-0000-0000000680d2', public.il_today() - 30, public.il_today())->'rows') r
                       where r->>'kind' = 'payment_refund' and (r->>'debit')::numeric = 100) = 1, 'the refund''s money out is on the card, once');
commit;

-- a licensed business: never a receipt below zero (a credit invoice)
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000680f1');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000680f1', 400, 100, 0, 0, '{"idempotency_key":"l:r1"}'));
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000680f1', 400, -50, 0, 0,
  jsonb_build_object('base_doc_type', 400, 'base_doc_number', pg_temp.num('l:r1'))))$$, 'refund_receipt_not_exempt', 'a licensed dealer''s receipt below zero');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000680f1', 320, -100, -18, 18))$$, 'totals:', 'any other document below zero (as before)');
commit;

-- ======================================================================================================================
-- 4. the deductions file number
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000680e1');
select pg_temp.refused_with($$update public.register_settings set deductions_file = '12345' where business_id = '00000000-0000-0000-0000-0000000680b1'$$,
  'register_settings_deductions_file_check', 'a deductions file of 5 digits');
select pg_temp.refused_with($$update public.register_settings set deductions_file = '' where business_id = '00000000-0000-0000-0000-0000000680b1'$$,
  'register_settings_deductions_file_check', 'an empty text (empty = null)');
-- the owner's way to save the business details: the upsert of register_settings (FinanceSettings)
insert into public.register_settings (user_id, entity_type, business_type, vat_rate, dealer_number, legal_name, deductions_file)
values ('00000000-0000-0000-0000-0000000680e1', 'exempt_dealer', 'exempt', 0, '000000018', 'עוסקת פטורה לדוגמה', '000000075')
on conflict (business_id) do update set deductions_file = excluded.deductions_file;
select pg_temp.check((select deductions_file from public.register_settings where business_id = '00000000-0000-0000-0000-0000000680b1') = '000000075', 'the owner saves it');
select pg_temp.check(exists (select 1 from public.finance_audit_log where business_id = '00000000-0000-0000-0000-0000000680b1' and action = 'settings.business'
  and details->'fields' ? 'deductions_file'), 'its change is in the business''s log');
update public.register_settings set deductions_file = null where business_id = '00000000-0000-0000-0000-0000000680b1';
select pg_temp.check((select deductions_file from public.register_settings where business_id = '00000000-0000-0000-0000-0000000680b1') is null, 'and clears it');
update public.register_settings set deductions_file = '000000075' where business_id = '00000000-0000-0000-0000-0000000680b1';
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000680f1');
select pg_temp.check((select count(*) from public.register_settings where business_id = '00000000-0000-0000-0000-0000000680b1') = 0, 'another business does not see it');
update public.register_settings set deductions_file = '000000083' where business_id = '00000000-0000-0000-0000-0000000680b1';
commit;
select pg_temp.check((select deductions_file from public.register_settings where business_id = '00000000-0000-0000-0000-0000000680b1') = '000000075', 'nor changes it');

-- ---- the old rows, once more: nothing of "before" changed through all of the above -------------------------------------------
select pg_temp.check((select (doc_date, total, payments) from public.documents where id = '00000000-0000-0000-0000-0000000680a3')
  = (public.il_today() - 8, 118::numeric, jsonb_build_array(jsonb_build_object('method', 3, 'amount', 118, 'date', public.il_today() - 8, 'm', 'card'))),
  'the licensed business''s old receipt is as it was');
