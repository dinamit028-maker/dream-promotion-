-- Packages (migration 20261010004200, docs/FINANCE ADDITIONS HE.md T1) on a real Postgres (tests/sql/run.sh), tried as the
-- signed-in roles — never as the superuser, except to build the world and to run the owner's purge as the server does.
-- Fixtures only, with ids of their own:
--   Clinic A (company, VAT 18%)  owner OA, practitioner PA (marked by OA), staff SA (editor, not marked), cashier KA,
--                                viewer VA (marked: reads only)       customers NOA (נועה), DANA (דנה)
--   Clinic B (exempt dealer)     owner OB                              customer MICHAL (מיכל)
--   super admin ZZ (a member of neither)
-- The Definition of Done of T1: a package is sold, paid in two payments, two treatments are taken from it — what is left is
-- right and the income is counted once. Every check raises "CHECK FAILED: …" when the database does not behave.
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
create or replace function pg_temp.refused_with(stmt text, expect text, msg text) returns void language plpgsql as $$
begin
  execute stmt;
  raise exception 'CHECK FAILED: % (it was allowed)', msg;
exception when others then
  if sqlerrm like 'CHECK FAILED%' then raise; end if;
  if position(expect in sqlerrm) = 0 then raise exception 'CHECK FAILED: % (refused, but with "%")', msg, sqlerrm; end if;
end $$;
create or replace function pg_temp.affected(stmt text) returns int language plpgsql as $$
declare n int; begin execute stmt; get diagnostics n = row_count; return n; end $$;
create or replace function pg_temp.as_user(uid text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', uid, true), set_config('request.jwt.claim.role', 'authenticated', true);
$$;
-- a document row the way the app sends it (amounts in shekels; one line; payments for receipts) — as finance.check.sql
create or replace function pg_temp.doc(p_user text, p_type int, p_before numeric, p_vat numeric, p_rate numeric, p_extra jsonb default '{}')
returns jsonb language sql as $$
  select jsonb_build_object('user_id', p_user, 'doc_type', p_type, 'doc_number', 0, 'doc_date', public.il_today(),
    'customer_name', 'לקוחה', 'before_discount', p_before, 'discount', 0, 'after_discount', p_before, 'vat_amount', p_vat,
    'total', p_before + p_vat, 'vat_rate', p_rate,
    'lines', jsonb_build_array(jsonb_build_object('name', 'חבילה', 'qty', 1, 'unitPriceExVat', p_before, 'discountExVat', 0, 'totalExVat', p_before, 'vatRate', p_rate, 'kind', 1)),
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
-- a package's numbers, as the screens read them
create or replace function pg_temp.pk(p uuid) returns public.client_package_status language sql as $$
  select * from public.client_package_status where id = p;
$$;
create or replace function pg_temp.session(p_notes text) returns uuid language sql as $$
  select id from public.client_sessions where notes = p_notes;
$$;

-- ---- the world --------------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000d401', 'oa@pk-a.test'), ('00000000-0000-0000-0000-00000000d402', 'pa@pk-a.test'),
  ('00000000-0000-0000-0000-00000000d403', 'sa@pk-a.test'), ('00000000-0000-0000-0000-00000000d404', 'ka@pk-a.test'),
  ('00000000-0000-0000-0000-00000000d405', 'va@pk-a.test'), ('00000000-0000-0000-0000-00000000d406', 'ob@pk-b.test'),
  ('00000000-0000-0000-0000-00000000d407', 'zz@platform.test');
update public.profiles set is_super_admin = true where id = '00000000-0000-0000-0000-00000000d407';
insert into public.businesses (id, name, slug) values
  ('00000000-0000-0000-0000-00000000db01', 'Clinic A', 'pk-clinic-a'), ('00000000-0000-0000-0000-00000000db02', 'Clinic B', 'pk-clinic-b');
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-00000000db01', '00000000-0000-0000-0000-00000000d401', 'owner', 'full'),
  ('00000000-0000-0000-0000-00000000db01', '00000000-0000-0000-0000-00000000d402', 'editor', 'full'),
  ('00000000-0000-0000-0000-00000000db01', '00000000-0000-0000-0000-00000000d403', 'editor', 'full'),
  ('00000000-0000-0000-0000-00000000db01', '00000000-0000-0000-0000-00000000d404', 'editor', 'register'),
  ('00000000-0000-0000-0000-00000000db01', '00000000-0000-0000-0000-00000000d405', 'viewer', 'full'),
  ('00000000-0000-0000-0000-00000000db02', '00000000-0000-0000-0000-00000000d406', 'owner', 'full');
update public.profiles set current_business_id = '00000000-0000-0000-0000-00000000db01'
 where id in ('00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-00000000d402', '00000000-0000-0000-0000-00000000d403',
              '00000000-0000-0000-0000-00000000d404', '00000000-0000-0000-0000-00000000d405', '00000000-0000-0000-0000-00000000d407');
update public.profiles set current_business_id = '00000000-0000-0000-0000-00000000db02' where id = '00000000-0000-0000-0000-00000000d406';
insert into public.register_settings (user_id, business_id, business_type, vat_rate, dealer_number, legal_name, street, city, entity_type) values
  ('00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-00000000db01', 'licensed', 18, '514000004', 'קליניקה א בע"מ', 'הרצל', 'תל אביב', 'company'),
  ('00000000-0000-0000-0000-00000000d406', '00000000-0000-0000-0000-00000000db02', 'licensed', 18, '123456782', 'קליניקה ב', 'הגפן', 'חיפה', 'exempt_dealer');
insert into public.leads (id, user_id, business_id, name, phone) values
  ('00000000-0000-0000-0000-00000000dc01', '00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-00000000db01', 'נועה', '0501111111'),
  ('00000000-0000-0000-0000-00000000dc02', '00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-00000000db01', 'דנה', '0502222222'),
  ('00000000-0000-0000-0000-00000000dc03', '00000000-0000-0000-0000-00000000d406', '00000000-0000-0000-0000-00000000db02', 'מיכל', '0503333333');
insert into public.treatment_types (id, business_id, name) values
  ('00000000-0000-0000-0000-00000000dd01', '00000000-0000-0000-0000-00000000db01', 'לייזר'),
  ('00000000-0000-0000-0000-00000000dd02', '00000000-0000-0000-0000-00000000db01', 'מיצוק'),
  ('00000000-0000-0000-0000-00000000dd03', '00000000-0000-0000-0000-00000000db02', 'לייזר');
insert into public.client_treatments (id, business_id, lead_id, treatment_type_id, title) values
  ('00000000-0000-0000-0000-00000000de01', '00000000-0000-0000-0000-00000000db01', '00000000-0000-0000-0000-00000000dc01', '00000000-0000-0000-0000-00000000dd01', 'הסרת שיער'),
  ('00000000-0000-0000-0000-00000000de02', '00000000-0000-0000-0000-00000000db01', '00000000-0000-0000-0000-00000000dc01', '00000000-0000-0000-0000-00000000dd02', 'מיצוק פנים'),
  ('00000000-0000-0000-0000-00000000de03', '00000000-0000-0000-0000-00000000db01', '00000000-0000-0000-0000-00000000dc02', '00000000-0000-0000-0000-00000000dd01', 'לייזר רגליים'),
  ('00000000-0000-0000-0000-00000000de05', '00000000-0000-0000-0000-00000000db01', '00000000-0000-0000-0000-00000000dc01', null, 'ייעוץ');
insert into public.catalog_items (id, user_id, business_id, name, price, kind, package_sessions, package_type_id, package_valid_months) values
  ('00000000-0000-0000-0000-00000000df01', '00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-00000000db01', '6 טיפולי לייזר', 1200, 'package', 6, '00000000-0000-0000-0000-00000000dd01', 6),
  ('00000000-0000-0000-0000-00000000df02', '00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-00000000db01', 'טיפול לייזר', 250, 'service', null, null, null),
  ('00000000-0000-0000-0000-00000000df03', '00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-00000000db01', 'זוג טיפולים', 300, 'package', 2, null, null),
  ('00000000-0000-0000-0000-00000000df04', '00000000-0000-0000-0000-00000000d406', '00000000-0000-0000-0000-00000000db02', '4 טיפולים', 400, 'package', 4, null, 3);

-- the practitioner and the viewer are marked for the client file by the owner (4100)
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000d401');
select public.client_file_set_access('00000000-0000-0000-0000-00000000d402', true);
select public.client_file_set_access('00000000-0000-0000-0000-00000000d405', true);
commit;

-- ======================================================================================================================
-- 1. the catalog: a package's terms on its item of the one catalog
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000d401');
select pg_temp.check((select package_sessions = 6 and package_valid_months = 6 from public.catalog_items where id = '00000000-0000-0000-0000-00000000df01'),
  'a package of the catalog keeps its terms');
select pg_temp.refused_with($$update public.catalog_items set package_sessions = 0 where id = '00000000-0000-0000-0000-00000000df01'$$,
  'catalog_items_package_check', 'a package has at least one treatment');
select pg_temp.refused_with($$update public.catalog_items set package_sessions = 501 where id = '00000000-0000-0000-0000-00000000df01'$$,
  'catalog_items_package_check', 'up to 500 treatments');
select pg_temp.refused_with($$update public.catalog_items set package_valid_months = 121 where id = '00000000-0000-0000-0000-00000000df01'$$,
  'catalog_items_package_check', 'valid up to 120 months');
select pg_temp.refused_with($$update public.catalog_items set package_type_id = '00000000-0000-0000-0000-00000000dd03' where id = '00000000-0000-0000-0000-00000000df01'$$,
  'catalog_items_package_type_fk', 'the treatment type is the business''s own');
commit;

-- ======================================================================================================================
-- 2. a package is sold to Noa: the terms copied, its tax invoice (305) issued by the existing engine with its key
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000d401');
insert into public.client_packages (id, user_id, lead_id, item_id, name, treatment_type_id, sessions_total, price, valid_until) values
  ('00000000-0000-0000-0000-00000000da01', '00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-00000000dc01', '00000000-0000-0000-0000-00000000df01',
   ' 6 טיפולי לייזר ', '00000000-0000-0000-0000-00000000dd01', 6, 1200, (public.il_today() + interval '6 months')::date);
select pg_temp.check((select business_id = '00000000-0000-0000-0000-00000000db01' and name = '6 טיפולי לייזר' and status = 'active' and document_id is null
  and sold_on = public.il_today() from public.client_packages where id = '00000000-0000-0000-0000-00000000da01'), 'sold in the business worked in, today, active');
-- a price change in the catalog changes nothing that was sold
update public.catalog_items set price = 1500, package_sessions = 8 where id = '00000000-0000-0000-0000-00000000df01';
select pg_temp.check((select price = 1200 and sessions_total = 6 from public.client_packages where id = '00000000-0000-0000-0000-00000000da01'),
  'the catalog changed; the sold package did not');
-- its document: a tax invoice of ₪1,200 (VAT inside), due in 30 days, to be paid in two payments
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000d401', 305, 1016.95, 183.05, 18, jsonb_build_object(
  'id', '00000000-0000-0000-0000-00000000d305', 'lead_id', '00000000-0000-0000-0000-00000000dc01', 'customer_name', 'נועה',
  'due_date', public.il_today() + 30, 'idempotency_key', 'package:00000000-0000-0000-0000-00000000da01')));
select pg_temp.check((select document_id = '00000000-0000-0000-0000-00000000d305' from public.client_packages where id = '00000000-0000-0000-0000-00000000da01'),
  'the document is linked to its package when it is issued');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000d401', 305, 1016.95, 183.05, 18, jsonb_build_object(
  'lead_id', '00000000-0000-0000-0000-00000000dc01', 'idempotency_key', 'package:00000000-0000-0000-0000-00000000da01')))$$,
  'documents_idempotency_uq', 'one document per package (a retry returns the first)');
select pg_temp.check((select (x.used, x.remaining, x.paid, x.credited, x.doc_type, x.doc_total) = (0, 6, 0::numeric, 0::numeric, 305, 1200::numeric)
  from pg_temp.pk('00000000-0000-0000-0000-00000000da01') x), 'sold: 6 left, nothing paid yet');

-- a document for another price or another customer is not a package's document — the issue itself is refused
insert into public.client_packages (id, user_id, lead_id, name, sessions_total, price) values
  ('00000000-0000-0000-0000-00000000da02', '00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-00000000dc01', 'חבילה', 3, 500);
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000d401', 320, 100, 18, 18, jsonb_build_object(
  'lead_id', '00000000-0000-0000-0000-00000000dc01', 'idempotency_key', 'package:00000000-0000-0000-0000-00000000da02')))$$,
  'package_document', 'a document of another price is not the package''s');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000d401', 320, 423.73, 76.27, 18, jsonb_build_object(
  'lead_id', '00000000-0000-0000-0000-00000000dc02', 'idempotency_key', 'package:00000000-0000-0000-0000-00000000da02')))$$,
  'package_document', 'a document of another customer is not the package''s');
-- the other order (the document first, e.g. a retry after the package's answer was lost): linked when the package is saved
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000d401', 320, 423.73, 76.27, 18, jsonb_build_object(
  'id', '00000000-0000-0000-0000-00000000d320', 'lead_id', '00000000-0000-0000-0000-00000000dc02',
  'idempotency_key', 'package:00000000-0000-0000-0000-00000000da06')));
insert into public.client_packages (id, user_id, lead_id, name, sessions_total, price) values
  ('00000000-0000-0000-0000-00000000da06', '00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-00000000dc02', '3 טיפולים', 3, 500);
select pg_temp.check((select document_id = '00000000-0000-0000-0000-00000000d320' from public.client_packages where id = '00000000-0000-0000-0000-00000000da06'),
  'a document issued before its package is linked when the package is saved');
select pg_temp.check((select paid = 500 from pg_temp.pk('00000000-0000-0000-0000-00000000da06')), 'a tax invoice-receipt (320) pays the package at once');

-- what is refused at the sale
select pg_temp.refused_with($$insert into public.client_packages (user_id, lead_id, item_id, name, sessions_total, price) values
  ('00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-00000000dc01', '00000000-0000-0000-0000-00000000df02', 'שירות', 1, 250)$$,
  'not in this business''s catalog', 'only a package of the catalog is sold as a package');
select pg_temp.refused_with($$insert into public.client_packages (user_id, lead_id, name, sessions_total, price, status, cancelled_at, cancel_reason) values
  ('00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-00000000dc01', 'x', 1, 1, 'cancelled', now(), 'xx')$$,
  'sold active', 'a package is sold active');
select pg_temp.refused_with($$insert into public.client_packages (user_id, lead_id, name, sessions_total, price, sold_on) values
  ('00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-00000000dc01', 'x', 1, 1, public.il_today() + 3)$$,
  'not sold in the future', 'not sold in the future');
select pg_temp.refused_with($$insert into public.client_packages (user_id, lead_id, name, sessions_total, price, valid_until) values
  ('00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-00000000dc01', 'x', 1, 1, public.il_today() - 1)$$,
  'client_packages_valid_check', 'valid until a day after the sale');
select pg_temp.refused_with($$insert into public.client_packages (user_id, lead_id, name, sessions_total, price) values
  ('00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-00000000dc03', 'x', 1, 1)$$,
  'violates foreign key', 'a customer of another business');
select pg_temp.refused_with($$insert into public.client_packages (user_id, lead_id, name, sessions_total, price, treatment_type_id) values
  ('00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-00000000dc01', 'x', 1, 1, '00000000-0000-0000-0000-00000000dd03')$$,
  'violates foreign key', 'a treatment type of another business');
select pg_temp.refused_with($$insert into public.client_packages (user_id, lead_id, name, sessions_total, price) values
  ('00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-00000000dc01', 'x', 0, 1)$$,
  'sessions_total', 'at least one treatment');
commit;

-- ======================================================================================================================
-- 3. paid in two payments (two receipts on the invoice): fully paid — and the income is the invoice's, once
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000d401');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000d401', 400, 600, 0, 0, jsonb_build_object(
  'lead_id', '00000000-0000-0000-0000-00000000dc01', 'paid_document_id', '00000000-0000-0000-0000-00000000d305',
  'idempotency_key', 'receipt:00000000-0000-0000-0000-00000000d305:1')));
select pg_temp.check((select (paid, doc_total) = (600::numeric, 1200::numeric) from pg_temp.pk('00000000-0000-0000-0000-00000000da01')), 'the first payment: ₪600 of ₪1,200');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000d401', 400, 600, 0, 0, jsonb_build_object(
  'lead_id', '00000000-0000-0000-0000-00000000dc01', 'paid_document_id', '00000000-0000-0000-0000-00000000d305',
  'idempotency_key', 'receipt:00000000-0000-0000-0000-00000000d305:2',
  'payments', jsonb_build_array(jsonb_build_object('method', 4, 'amount', 600, 'date', public.il_today(), 'm', 'transfer')))));
select pg_temp.check((select paid = 1200 from pg_temp.pk('00000000-0000-0000-0000-00000000da01')), 'two payments: fully paid');
select pg_temp.check((select balance = 0 from public.receivables where id = '00000000-0000-0000-0000-00000000d305'), 'nothing left to collect on the invoice');
-- income: the tax invoices (305 + the other package's 320) — the receipts are money, not income, and the package itself is not
-- counted anywhere
select pg_temp.check((select (s->'revenue'->>'net')::numeric = 1016.95 + 423.73 and (s->'revenue'->>'vat')::numeric = 183.05 + 76.27
                         and (s->'cash'->>'in')::numeric = 1200 + 500
                        from public.finance_summary(public.il_today(), public.il_today()) s), 'income counted once (the invoices), the money in once');
commit;

-- ======================================================================================================================
-- 4. treatments taken: a session and its deduction in one step (the practitioner); one per session; the right type
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000d402');
select public.client_session_add('00000000-0000-0000-0000-00000000dc01', '00000000-0000-0000-0000-00000000de01', now() - interval '2 days', 'S1', '00000000-0000-0000-0000-00000000da01');
select public.client_session_add('00000000-0000-0000-0000-00000000dc01', '00000000-0000-0000-0000-00000000de01', now() - interval '1 day', 'S2', '00000000-0000-0000-0000-00000000da01');
select pg_temp.check((select (used, remaining) = (2, 4) from pg_temp.pk('00000000-0000-0000-0000-00000000da01')), 'two treatments taken: 4 of 6 left');
select pg_temp.check((select by_user = '00000000-0000-0000-0000-00000000d402' from public.client_sessions where notes = 'S1'), 'who gave the treatment is kept');
select pg_temp.check((select user_id = '00000000-0000-0000-0000-00000000d402' from public.client_package_uses where session_id = pg_temp.session('S1')), 'who deducted is kept');
select pg_temp.refused_with(format($$insert into public.client_package_uses (business_id, package_id, lead_id, session_id) values
  ('00000000-0000-0000-0000-00000000db01', '00000000-0000-0000-0000-00000000da01', '00000000-0000-0000-0000-00000000dc01', %L)$$, pg_temp.session('S1')),
  'session_deducted', 'a session is deducted once');
-- a session without a package, deducted afterwards
select public.client_session_add('00000000-0000-0000-0000-00000000dc01', '00000000-0000-0000-0000-00000000de01', null, 'S3', null);
select pg_temp.check((select remaining = 4 from pg_temp.pk('00000000-0000-0000-0000-00000000da01')), 'a session without a package takes nothing');
insert into public.client_package_uses (business_id, package_id, lead_id, session_id)
  values ('00000000-0000-0000-0000-00000000db01', '00000000-0000-0000-0000-00000000da01', '00000000-0000-0000-0000-00000000dc01', pg_temp.session('S3'));
select pg_temp.check((select remaining = 3 from pg_temp.pk('00000000-0000-0000-0000-00000000da01')), 'deducted afterwards: 3 left');
-- another type of treatment, another customer's package, a time to come — refused, and nothing is left behind
select pg_temp.refused_with($$select public.client_session_add('00000000-0000-0000-0000-00000000dc01', '00000000-0000-0000-0000-00000000de02', null, 'X1',
  '00000000-0000-0000-0000-00000000da01')$$, 'package_other_type', 'a laser package is not used for firming');
select pg_temp.check((select count(*) = 0 from public.client_sessions where notes = 'X1'), 'the refused deduction left no session behind');
-- a treatment without a type: any package may be used for it (here it is not, to keep the count)
select pg_temp.refused_with($$select public.client_session_add('00000000-0000-0000-0000-00000000dc02', '00000000-0000-0000-0000-00000000de03', null, 'X2',
  '00000000-0000-0000-0000-00000000da01')$$, 'not found for this customer', 'Noa''s package is not used for Dana');
select pg_temp.refused_with($$select public.client_session_add('00000000-0000-0000-0000-00000000dc01', '00000000-0000-0000-0000-00000000de03', null, 'X3', null)$$,
  'violates foreign key', 'a session belongs to its own customer''s treatment');
select pg_temp.refused_with($$select public.client_session_add('00000000-0000-0000-0000-00000000dc01', '00000000-0000-0000-0000-00000000de01', now() + interval '3 days', 'X4', null)$$,
  'session_time', 'a session that took place, not one to come');
commit;

-- the id fixed on the device: a retry of the same call (its answer was lost) is the same session — not a second treatment
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000d402');
select pg_temp.check(public.client_session_add('00000000-0000-0000-0000-00000000dc01', '00000000-0000-0000-0000-00000000de01', null, 'R1',
  '00000000-0000-0000-0000-00000000da01', '00000000-0000-0000-0000-00000000d5e1') = '00000000-0000-0000-0000-00000000d5e1', 'the session has the device''s id');
select pg_temp.check(public.client_session_add('00000000-0000-0000-0000-00000000dc01', '00000000-0000-0000-0000-00000000de01', null, 'R1',
  '00000000-0000-0000-0000-00000000da01', '00000000-0000-0000-0000-00000000d5e1') = '00000000-0000-0000-0000-00000000d5e1', 'a retry answers the same session');
select pg_temp.check((select count(*) = 1 from public.client_sessions where notes = 'R1'), 'one session');
select pg_temp.check((select count(*) = 1 from public.client_package_uses where session_id = '00000000-0000-0000-0000-00000000d5e1'), 'one deduction');
select pg_temp.check((select remaining = 2 from pg_temp.pk('00000000-0000-0000-0000-00000000da01')), 'one treatment taken: 2 left');
select pg_temp.refused_with($$select public.client_session_add('00000000-0000-0000-0000-00000000dc02', '00000000-0000-0000-0000-00000000de03', null, 'X7', null,
  '00000000-0000-0000-0000-00000000d5e1')$$, 'duplicate key', 'the id of another customer''s session is not taken over');
rollback;

-- ======================================================================================================================
-- 5. a session cancelled: final, and its treatment goes back to the package at once
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000d402');
update public.client_sessions set cancelled_at = now(), cancel_reason = ' לא הגיעה ' where id = pg_temp.session('S2');
select pg_temp.check((select cancelled_by = '00000000-0000-0000-0000-00000000d402' and cancel_reason = 'לא הגיעה' from public.client_sessions where notes = 'S2'),
  'who cancelled and why');
select pg_temp.check((select returned_at is not null and return_reason = 'הטיפול בוטל: לא הגיעה' and returned_by = '00000000-0000-0000-0000-00000000d402'
  from public.client_package_uses where session_id = pg_temp.session('S2')), 'its deduction is given back, with the reason');
select pg_temp.check((select (used, returned, remaining) = (2, 1, 4) from pg_temp.pk('00000000-0000-0000-0000-00000000da01')), 'the treatment is back: 4 left');
select pg_temp.refused_with(format($$insert into public.client_package_uses (business_id, package_id, lead_id, session_id) values
  ('00000000-0000-0000-0000-00000000db01', '00000000-0000-0000-0000-00000000da01', '00000000-0000-0000-0000-00000000dc01', %L)$$, pg_temp.session('S2')),
  'session_cancelled', 'a cancelled session is not deducted');
select pg_temp.refused_with(format($$update public.client_sessions set cancelled_at = null where id = %L$$, pg_temp.session('S2')),
  'does not change', 'a cancelled session is not brought back');
select pg_temp.refused_with(format($$update public.client_sessions set params = '{"j": 1}' where id = %L$$, pg_temp.session('S2')),
  'does not change', 'a cancelled session does not change');
-- the staff member who is not marked does not cancel (the client file's rule)
select pg_temp.as_user('00000000-0000-0000-0000-00000000d403');
select pg_temp.check((select count(*) = 0 from public.client_sessions), 'an unmarked member sees no session');
commit;

-- ======================================================================================================================
-- 6. a deduction given back by mistake, and taken again — the package's count follows
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000d401');
update public.client_package_uses set returned_at = now(), return_reason = 'נוכה בטעות' where session_id = pg_temp.session('S1') and returned_at is null;
select pg_temp.check((select (used, remaining) = (1, 5) from pg_temp.pk('00000000-0000-0000-0000-00000000da01')), 'given back: 5 left');
select pg_temp.refused_with(format($$update public.client_package_uses set return_reason = 'אחר' where session_id = %L$$, pg_temp.session('S1')),
  'does not change', 'a deduction given back is not changed again');
select pg_temp.refused_with(format($$update public.client_package_uses set used_at = now() - interval '9 days' where session_id = %L$$, pg_temp.session('S3')),
  'does not change', 'a deduction does not change — it is given back');
insert into public.client_package_uses (business_id, package_id, lead_id, session_id)
  values ('00000000-0000-0000-0000-00000000db01', '00000000-0000-0000-0000-00000000da01', '00000000-0000-0000-0000-00000000dc01', pg_temp.session('S1'));
-- the Definition of Done: sold, paid in two payments, two treatments taken (S1, S3) — 4 left, nothing owed, the income once
select pg_temp.check((select (used, returned, remaining, paid, credited) = (2, 2, 4, 1200::numeric, 0::numeric)
  from pg_temp.pk('00000000-0000-0000-0000-00000000da01')), 'DoD: 2 taken, 4 left, paid in full');
select pg_temp.refused($$delete from public.client_package_uses where package_id = '00000000-0000-0000-0000-00000000da01'$$, 'a deduction is never deleted');
select pg_temp.refused($$delete from public.client_packages where id = '00000000-0000-0000-0000-00000000da01'$$, 'a package is never deleted');
commit;

-- ======================================================================================================================
-- 7. never beyond the package (a package of any treatment, without a document — price 0)
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000d401');
insert into public.client_packages (id, user_id, lead_id, item_id, name, sessions_total, price) values
  ('00000000-0000-0000-0000-00000000da03', '00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-00000000dc02', '00000000-0000-0000-0000-00000000df03', 'זוג טיפולים', 2, 0);
select public.client_session_add('00000000-0000-0000-0000-00000000dc02', '00000000-0000-0000-0000-00000000de03', null, 'S4', '00000000-0000-0000-0000-00000000da03');
select public.client_session_add('00000000-0000-0000-0000-00000000dc02', '00000000-0000-0000-0000-00000000de03', null, 'S5', '00000000-0000-0000-0000-00000000da03');
select pg_temp.check((select remaining = 0 from pg_temp.pk('00000000-0000-0000-0000-00000000da03')), 'a package of any treatment: a laser session is taken from it');
select pg_temp.refused_with($$select public.client_session_add('00000000-0000-0000-0000-00000000dc02', '00000000-0000-0000-0000-00000000de03', null, 'S6',
  '00000000-0000-0000-0000-00000000da03')$$, 'package_used_up', 'never beyond the package');
commit;

-- ======================================================================================================================
-- 8. a sold package keeps its terms; its validity may move; cancelling it is final and stops every deduction
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000d401');
select pg_temp.refused_with($$update public.client_packages set price = 1 where id = '00000000-0000-0000-0000-00000000da01'$$, 'keeps its terms', 'the price stays');
select pg_temp.refused_with($$update public.client_packages set sessions_total = 9 where id = '00000000-0000-0000-0000-00000000da01'$$, 'keeps its terms', 'the treatments stay');
select pg_temp.refused_with($$update public.client_packages set lead_id = '00000000-0000-0000-0000-00000000dc02' where id = '00000000-0000-0000-0000-00000000da01'$$,
  'keeps its terms', 'the customer stays');
select pg_temp.refused_with($$update public.client_packages set document_id = '00000000-0000-0000-0000-00000000d320' where id = '00000000-0000-0000-0000-00000000da01'$$,
  'keeps its document', 'the document stays');
select pg_temp.refused_with($$update public.client_packages set document_id = '00000000-0000-0000-0000-00000000d305' where id = '00000000-0000-0000-0000-00000000da02'$$,
  'not this package''s', 'another package''s document is not taken');
update public.client_packages set valid_until = valid_until + 30 where id = '00000000-0000-0000-0000-00000000da01';
select pg_temp.check((select valid_until = (public.il_today() + interval '6 months')::date + 30 from public.client_packages where id = '00000000-0000-0000-0000-00000000da01'),
  'the owner extends the validity');
select pg_temp.refused_with($$update public.client_packages set status = 'cancelled' where id = '00000000-0000-0000-0000-00000000da03'$$,
  'reason is required', 'a package is cancelled with a reason');
update public.client_packages set status = 'cancelled', cancel_reason = 'החליטה לוותר' where id = '00000000-0000-0000-0000-00000000da03';
select pg_temp.check((select cancelled_at is not null and cancelled_by = '00000000-0000-0000-0000-00000000d401' from public.client_packages
  where id = '00000000-0000-0000-0000-00000000da03'), 'who cancelled and when');
-- a deduction of a cancelled package may still be given back (cancelling its session must never be blocked)
update public.client_package_uses set returned_at = now(), return_reason = 'בדיקה' where session_id = pg_temp.session('S4');
select pg_temp.refused_with(format($$insert into public.client_package_uses (business_id, package_id, lead_id, session_id) values
  ('00000000-0000-0000-0000-00000000db01', '00000000-0000-0000-0000-00000000da03', '00000000-0000-0000-0000-00000000dc02', %L)$$, pg_temp.session('S4')),
  'package_cancelled', 'a cancelled package is not used');
select pg_temp.refused_with($$update public.client_packages set status = 'active' where id = '00000000-0000-0000-0000-00000000da03'$$,
  'stays cancelled', 'a cancelled package stays cancelled');
select pg_temp.refused_with($$update public.client_packages set valid_until = public.il_today() + 9 where id = '00000000-0000-0000-0000-00000000da03'$$,
  'does not change', 'a cancelled package does not change');
select pg_temp.refused_with($$update public.client_packages set cancel_reason = 'אחר' where id = '00000000-0000-0000-0000-00000000da01'$$,
  'only by cancelling', 'the cancellation fields move only with the cancellation');
commit;

-- ======================================================================================================================
-- 9. who sees and who writes: a cashier nothing, a viewer reads, an unmarked member sells but records no session,
--    another business and the super admin (no access opened) — nothing
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000d404');
select pg_temp.check((select count(*) from public.client_packages) = 0 and (select count(*) from public.client_package_uses) = 0
                     and (select count(*) from public.client_package_status) = 0, 'a cashier sees no package');
select pg_temp.refused($$insert into public.client_packages (user_id, lead_id, name, sessions_total, price) values
  ('00000000-0000-0000-0000-00000000d404', '00000000-0000-0000-0000-00000000dc01', 'x', 1, 1)$$, 'a cashier sells no package here');

select pg_temp.as_user('00000000-0000-0000-0000-00000000d405');
select pg_temp.check((select count(*) from public.client_package_status) >= 3, 'a viewer reads the packages');
select pg_temp.refused($$insert into public.client_packages (user_id, lead_id, name, sessions_total, price) values
  ('00000000-0000-0000-0000-00000000d405', '00000000-0000-0000-0000-00000000dc01', 'x', 1, 1)$$, 'a viewer sells nothing');
select pg_temp.check(pg_temp.affected($$update public.client_packages set valid_until = null where id = '00000000-0000-0000-0000-00000000da01'$$) = 0,
  'a viewer changes nothing');
select pg_temp.refused($$select public.client_session_add('00000000-0000-0000-0000-00000000dc01', '00000000-0000-0000-0000-00000000de01', null, 'X5', null)$$,
  'a viewer records no session');

select pg_temp.as_user('00000000-0000-0000-0000-00000000d403');
select pg_temp.check((select count(*) from public.client_package_status) >= 3, 'an unmarked member sees the packages (money, not the client file)');
insert into public.client_packages (id, user_id, lead_id, name, sessions_total, price) values
  ('00000000-0000-0000-0000-00000000da07', '00000000-0000-0000-0000-00000000d403', '00000000-0000-0000-0000-00000000dc02', 'חבילה', 2, 0);
select pg_temp.refused($$select public.client_session_add('00000000-0000-0000-0000-00000000dc02', '00000000-0000-0000-0000-00000000de03', null, 'X6',
  '00000000-0000-0000-0000-00000000da07')$$, 'an unmarked member records no session');

select pg_temp.as_user('00000000-0000-0000-0000-00000000d406');
select pg_temp.check((select count(*) from public.client_package_status where business_id = '00000000-0000-0000-0000-00000000db01') = 0
                     and (select count(*) from public.client_package_uses where business_id = '00000000-0000-0000-0000-00000000db01') = 0,
  'another business sees nothing of Clinic A');
select pg_temp.refused_with($$insert into public.client_packages (business_id, user_id, lead_id, name, sessions_total, price) values
  ('00000000-0000-0000-0000-00000000db01', '00000000-0000-0000-0000-00000000d406', '00000000-0000-0000-0000-00000000dc01', 'x', 1, 1)$$,
  'not allowed', 'another business writes nothing into Clinic A (refused before any check reads a row)');
select pg_temp.refused_with($$insert into public.client_package_uses (business_id, user_id, package_id, lead_id, session_id) values
  ('00000000-0000-0000-0000-00000000db01', '00000000-0000-0000-0000-00000000d406', '00000000-0000-0000-0000-00000000da01', '00000000-0000-0000-0000-00000000dc01',
   '00000000-0000-0000-0000-00000000dc01')$$, 'not allowed', 'another business deducts nothing in Clinic A');

select pg_temp.as_user('00000000-0000-0000-0000-00000000d407');
select pg_temp.check((select count(*) from public.client_package_status) = 0 and (select count(*) from public.client_packages) = 0,
  'the super admin sees no package before opening access with a reason');
commit;

-- ======================================================================================================================
-- 10. cancelling a package paid in advance (VAT): a credit invoice for what was not used, the money back for it
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000d401');
insert into public.client_packages (id, user_id, lead_id, item_id, name, treatment_type_id, sessions_total, price) values
  ('00000000-0000-0000-0000-00000000da04', '00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-00000000dc02', '00000000-0000-0000-0000-00000000df01',
   '6 טיפולי לייזר', '00000000-0000-0000-0000-00000000dd01', 6, 1200);
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000d401', 320, 1016.95, 183.05, 18, jsonb_build_object(
  'id', '00000000-0000-0000-0000-00000000d321', 'lead_id', '00000000-0000-0000-0000-00000000dc02',
  'idempotency_key', 'package:00000000-0000-0000-0000-00000000da04')));
select public.client_session_add('00000000-0000-0000-0000-00000000dc02', '00000000-0000-0000-0000-00000000de03', null, 'S7', '00000000-0000-0000-0000-00000000da04');
select public.client_session_add('00000000-0000-0000-0000-00000000dc02', '00000000-0000-0000-0000-00000000de03', null, 'S8', '00000000-0000-0000-0000-00000000da04');
-- 2 of 6 used = ₪400; the owner approves the suggestion: a credit of ₪800 and ₪800 back
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000d401', 330, 677.97, 122.03, 18, jsonb_build_object(
  'id', '00000000-0000-0000-0000-00000000d330', 'lead_id', '00000000-0000-0000-0000-00000000dc02', 'base_doc_type', 320,
  'base_doc_number', (select doc_number from public.documents where id = '00000000-0000-0000-0000-00000000d321'),
  'idempotency_key', 'credit:00000000-0000-0000-0000-00000000d321:1')));
select public.record_credit_refund('00000000-0000-0000-0000-00000000d330', 'cash', 800, public.il_today(), 'ביטול חבילה');
update public.client_packages set status = 'cancelled', cancel_reason = 'ביטול לבקשת הלקוחה' where id = '00000000-0000-0000-0000-00000000da04';
select pg_temp.check((select (status, used, remaining, paid, credited) = ('cancelled', 2, 4, 400::numeric, 800::numeric)
  from pg_temp.pk('00000000-0000-0000-0000-00000000da04')), 'cancelled: ₪800 credited and returned, ₪400 kept for the 2 treatments');
commit;

-- ======================================================================================================================
-- 11. an exempt dealer: a receipt (400) for a package paid now; a receipt issued by mistake is cancelled — its money goes back
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000d406');
insert into public.client_packages (id, user_id, lead_id, item_id, name, sessions_total, price, valid_until) values
  ('00000000-0000-0000-0000-00000000da05', '00000000-0000-0000-0000-00000000d406', '00000000-0000-0000-0000-00000000dc03', '00000000-0000-0000-0000-00000000df04',
   '4 טיפולים', 4, 400, (public.il_today() + interval '3 months')::date);
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000d406', 400, 400, 0, 0, jsonb_build_object(
  'id', '00000000-0000-0000-0000-00000000d400', 'lead_id', '00000000-0000-0000-0000-00000000dc03',
  'idempotency_key', 'package:00000000-0000-0000-0000-00000000da05')));
select pg_temp.check((select (doc_type, paid, doc_cancelled) = (400, 400::numeric, false) from pg_temp.pk('00000000-0000-0000-0000-00000000da05')),
  'an exempt dealer: a receipt pays the package');
insert into public.document_cancellations (document_id, user_id, reason) values ('00000000-0000-0000-0000-00000000d400', '00000000-0000-0000-0000-00000000d406', 'הופקה בטעות');
update public.client_packages set status = 'cancelled', cancel_reason = 'נמכרה בטעות' where id = '00000000-0000-0000-0000-00000000da05';
select pg_temp.check((select (status, paid, doc_cancelled) = ('cancelled', 0::numeric, true) from pg_temp.pk('00000000-0000-0000-0000-00000000da05')),
  'the receipt cancelled: its money went back off the books');
commit;

-- ======================================================================================================================
-- 12. what may disappear around a sold package: its catalog item; and the client file, deleted by the owner (4100)
-- ======================================================================================================================
delete from public.catalog_items where id = '00000000-0000-0000-0000-00000000df03';
select pg_temp.check((select item_id is null and name = 'זוג טיפולים' and sessions_total = 2 from public.client_packages
  where id = '00000000-0000-0000-0000-00000000da03'), 'the catalog item deleted: the sold package keeps its copy');
-- the owner deletes Noa's whole client file (the server runs it): her sessions go, the deductions stay — without the session
select public.client_file_purge('00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-00000000db01', '00000000-0000-0000-0000-00000000dc01');
select pg_temp.check((select count(*) = 0 from public.client_sessions where lead_id = '00000000-0000-0000-0000-00000000dc01'), 'the client file is gone');
select pg_temp.check((select count(*) = 4 and count(*) filter (where session_id is null) = 4 from public.client_package_uses
  where package_id = '00000000-0000-0000-0000-00000000da01'), 'the deductions stay, without their sessions');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000d401');
select pg_temp.check((select (used, returned, remaining, paid) = (2, 2, 4, 1200::numeric) from pg_temp.pk('00000000-0000-0000-0000-00000000da01')),
  'the package''s count is unchanged by the purge');
-- a customer with a package is not deleted: the money stays known (one without documents or payments, so the package decides)
insert into public.leads (id, user_id, name) values ('00000000-0000-0000-0000-00000000dc04', '00000000-0000-0000-0000-00000000d401', 'רותם');
insert into public.client_packages (id, user_id, lead_id, name, sessions_total, price) values
  ('00000000-0000-0000-0000-00000000da08', '00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-00000000dc04', 'מתנה', 1, 0);
select pg_temp.refused_with($$delete from public.leads where id = '00000000-0000-0000-0000-00000000dc04'$$, 'client_packages',
  'a customer with a package is not deleted');
commit;

-- ======================================================================================================================
-- 13. the audit log: every step of a package, in the business's own chain (still intact)
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000d401');
select pg_temp.check((select count(distinct action) = 5 from public.finance_audit_log
  where business_id = '00000000-0000-0000-0000-00000000db01' and action in ('package.sold', 'package.used', 'package.returned', 'package.cancelled', 'package.changed')),
  'sold, used, returned, cancelled and changed are in the audit log');
select pg_temp.check((select (r->>'ok')::boolean from public.finance_audit_verify() r), 'the audit chain is intact');
commit;
