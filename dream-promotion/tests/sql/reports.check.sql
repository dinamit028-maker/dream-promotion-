-- The missing reports and tax withheld at source (migration 20261011004900, docs/FINANCE_ADDITIONS_HE.md T8) on a real Postgres
-- (tests/sql/run.sh). The screens' calls run as the signed-in roles. Fixtures only, with ids of their own:
--   Clinic RA (a company, VAT)  owner OA; cashier KA; viewer VA; manager ML (full access, limited to the branch L2). The customer
--                               Dana (a CRM card), Yossi (by name only), a company (by its dealer number). Treatment types laser and
--                               face; LASER (a service of type laser), CREAM (a product), FACE3 (a package of type face), ADVICE (a
--                               service with no type). Suppliers: a supplier of goods (by dealer number) and the electric company
--                               (by name, written two ways).
--   Clinic RB (an exempt dealer) owner OB; the customer Noa; TREAT (a service).
-- The period of every report is 1.1.2026 – today; a few documents and expenses are from December 2025 (the opening balances).
-- Every check raises "CHECK FAILED: …" when the database does not behave.
\set ON_ERROR_STOP 1
set client_min_messages = warning;

create or replace function pg_temp.check(ok boolean, msg text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'CHECK FAILED: %', msg; end if; end $$;
create or replace function pg_temp.refused_with(stmt text, expect text, msg text) returns void language plpgsql as $$
begin
  execute stmt;
  raise exception 'CHECK FAILED: % (it was allowed)', msg;
exception when others then
  if sqlerrm like 'CHECK FAILED%' then raise; end if;
  if position(expect in sqlerrm) = 0 then raise exception 'CHECK FAILED: % (refused, but with "%")', msg, sqlerrm; end if;
end $$;
create or replace function pg_temp.as_user(uid text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', uid, true), set_config('request.jwt.claim.role', 'authenticated', true);
$$;
-- a document as the screens send it: its lines [{item, name, qty, price}] before VAT, a discount, the VAT by the rate (none on a
-- receipt); a receipt is paid as p_pay says ([{m, amount, pct}]) — else in cash, all of it. A receipt without lines of its own
-- (paying an invoice) takes its amount from p_extra.amount. Its business follows its user.
create or replace function pg_temp.issue(p_user text, p_type int, p_key text, p_date date, p_who jsonb, p_lines jsonb,
                                         p_discount numeric default 0, p_vat numeric default 18, p_pay jsonb default null, p_extra jsonb default '{}')
returns uuid language plpgsql as $$
declare r jsonb; cols text; id uuid; ls jsonb; bd numeric; ad numeric; v numeric; t numeric; pays jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('name', coalesce(e->>'name', 'פריט'), 'qty', (e->>'qty')::numeric, 'unitPriceExVat', (e->>'price')::numeric,
           'discountExVat', 0, 'totalExVat', (e->>'qty')::numeric * (e->>'price')::numeric, 'vatRate', p_vat, 'kind', 1)
           || case when e ? 'item' then jsonb_build_object('itemId', e->>'item') else '{}'::jsonb end order by o), '[]'::jsonb),
         coalesce(sum((e->>'qty')::numeric * (e->>'price')::numeric), 0)
    into ls, bd from jsonb_array_elements(p_lines) with ordinality x(e, o);
  if jsonb_array_length(ls) = 0 then bd := (p_extra->>'amount')::numeric; end if;
  ad := bd - p_discount;
  v := case when p_type = 400 then 0 else round(ad * p_vat / 100, 2) end;
  t := ad + v;
  pays := case when p_type not in (320, 400) then '[]'::jsonb
               when p_pay is null then jsonb_build_array(jsonb_build_object('method', 1, 'amount', t, 'date', p_date, 'm', 'cash'))
               else (select jsonb_agg(jsonb_build_object('method', case e->>'m' when 'cash' then 1 when 'cheque' then 2 when 'card' then 3 when 'transfer' then 4 else 9 end,
                                                         'amount', (e->>'amount')::numeric, 'date', p_date, 'm', e->>'m')
                                      || case when e ? 'pct' then jsonb_build_object('pct', e->'pct') else '{}'::jsonb end order by o)
                       from jsonb_array_elements(p_pay) with ordinality x(e, o)) end;
  r := jsonb_build_object('user_id', p_user, 'doc_type', p_type, 'doc_number', 0, 'doc_date', p_date, 'customer_name', '',
    'before_discount', bd, 'discount', p_discount, 'after_discount', ad, 'vat_amount', v, 'total', t, 'vat_rate', p_vat,
    'idempotency_key', p_key, 'lines', ls, 'payments', pays) || p_who || (p_extra - 'amount');
  select string_agg(quote_ident(k), ', ') into cols from jsonb_object_keys(r) k;
  execute format('insert into public.documents (%s) select %s from jsonb_populate_record(null::public.documents, $1) returning id', cols, cols) using r into id;
  return id;
end $$;
create or replace function pg_temp.d(p_key text) returns uuid language sql as $$ select id from public.documents where idempotency_key = p_key $$;
create or replace function pg_temp.num(p_key text) returns text language sql as $$ select doc_type || '-' || doc_number from public.documents where idempotency_key = p_key $$;
create or replace function pg_temp.bal(p_key text) returns numeric language sql as $$ select balance from public.receivables where id = pg_temp.d(p_key) $$;

-- ---- the world ------------------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000e4a001', 'oa@rep-a.test'), ('00000000-0000-0000-0000-000000e4a002', 'ka@rep-a.test'),
  ('00000000-0000-0000-0000-000000e4a003', 'va@rep-a.test'), ('00000000-0000-0000-0000-000000e4a004', 'ml@rep-a.test'),
  ('00000000-0000-0000-0000-000000e4a005', 'ob@rep-b.test');
insert into public.businesses (id, name, slug) values ('00000000-0000-0000-0000-000000e4ab01', 'Clinic RA', 'rep-clinic-a'), ('00000000-0000-0000-0000-000000e4ab02', 'Clinic RB', 'rep-clinic-b');
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-000000e4ab01', '00000000-0000-0000-0000-000000e4a001', 'owner', 'full'), ('00000000-0000-0000-0000-000000e4ab01', '00000000-0000-0000-0000-000000e4a002', 'editor', 'register'),
  ('00000000-0000-0000-0000-000000e4ab01', '00000000-0000-0000-0000-000000e4a003', 'viewer', 'full'), ('00000000-0000-0000-0000-000000e4ab01', '00000000-0000-0000-0000-000000e4a004', 'editor', 'full'),
  ('00000000-0000-0000-0000-000000e4ab02', '00000000-0000-0000-0000-000000e4a005', 'owner', 'full');
update public.profiles set current_business_id = '00000000-0000-0000-0000-000000e4ab01' where id in ('00000000-0000-0000-0000-000000e4a001', '00000000-0000-0000-0000-000000e4a002', '00000000-0000-0000-0000-000000e4a003', '00000000-0000-0000-0000-000000e4a004');
update public.profiles set current_business_id = '00000000-0000-0000-0000-000000e4ab02' where id = '00000000-0000-0000-0000-000000e4a005';
insert into public.register_settings (user_id, business_id, business_type, vat_rate, dealer_number, legal_name, street, city, entity_type) values
  ('00000000-0000-0000-0000-000000e4a001', '00000000-0000-0000-0000-000000e4ab01', 'licensed', 18, '514000046', 'קליניקה דוחות בע"מ', 'הרצל', 'תל אביב', 'company'),
  ('00000000-0000-0000-0000-000000e4a005', '00000000-0000-0000-0000-000000e4ab02', 'licensed', 18, '123456782', 'קליניקה פטורה', 'הגפן', 'חיפה', 'exempt_dealer');
insert into public.business_locations (id, business_id, name, kind, sort) values ('00000000-0000-0000-0000-000000e4ac02', '00000000-0000-0000-0000-000000e4ab01', 'סניף רמת גן', 'store', 1);
update public.business_members set locations = array['00000000-0000-0000-0000-000000e4ac02'::uuid] where business_id = '00000000-0000-0000-0000-000000e4ab01' and user_id = '00000000-0000-0000-0000-000000e4a004';
insert into public.leads (id, user_id, business_id, name, phone) values
  ('00000000-0000-0000-0000-000000e4ad01', '00000000-0000-0000-0000-000000e4a001', '00000000-0000-0000-0000-000000e4ab01', 'דנה', '0501234567'),
  ('00000000-0000-0000-0000-000000e4ad02', '00000000-0000-0000-0000-000000e4a005', '00000000-0000-0000-0000-000000e4ab02', 'נועה', '0507654321');
insert into public.treatment_types (id, business_id, name) values
  ('00000000-0000-0000-0000-000000e4ae01', '00000000-0000-0000-0000-000000e4ab01', 'לייזר'), ('00000000-0000-0000-0000-000000e4ae02', '00000000-0000-0000-0000-000000e4ab01', 'פנים'),
  ('00000000-0000-0000-0000-000000e4ae04', '00000000-0000-0000-0000-000000e4ab02', 'לייזר');
insert into public.catalog_items (id, user_id, business_id, name, price, kind, track_stock, treatment_type_id, package_sessions, package_type_id) values
  ('00000000-0000-0000-0000-000000e4af01', '00000000-0000-0000-0000-000000e4a001', '00000000-0000-0000-0000-000000e4ab01', 'טיפול לייזר', 500, 'service', false, '00000000-0000-0000-0000-000000e4ae01', null, null),
  ('00000000-0000-0000-0000-000000e4af02', '00000000-0000-0000-0000-000000e4a001', '00000000-0000-0000-0000-000000e4ab01', 'קרם', 100, 'product', false, null, null, null),
  ('00000000-0000-0000-0000-000000e4af03', '00000000-0000-0000-0000-000000e4a001', '00000000-0000-0000-0000-000000e4ab01', '3 טיפולי פנים', 900, 'package', false, null, 3, '00000000-0000-0000-0000-000000e4ae02'),
  ('00000000-0000-0000-0000-000000e4af04', '00000000-0000-0000-0000-000000e4a001', '00000000-0000-0000-0000-000000e4ab01', 'ייעוץ', 2000, 'service', false, null, null, null),
  ('00000000-0000-0000-0000-000000e4af05', '00000000-0000-0000-0000-000000e4a005', '00000000-0000-0000-0000-000000e4ab02', 'טיפול', 150, 'service', false, null, null, null);

-- ======================================================================================================================
-- 1. a service has a treatment type (a package keeps its own); the business's own; deleting the type leaves the service without one
-- ======================================================================================================================
select pg_temp.refused_with($$update public.catalog_items set treatment_type_id = '00000000-0000-0000-0000-000000e4ae01' where id = '00000000-0000-0000-0000-000000e4af02'$$,
  'catalog_items_treatment_type_check', 'a product has no treatment type');
select pg_temp.refused_with($$update public.catalog_items set treatment_type_id = '00000000-0000-0000-0000-000000e4ae01' where id = '00000000-0000-0000-0000-000000e4af03'$$,
  'catalog_items_treatment_type_check', 'a package keeps its own (package_type_id)');
select pg_temp.refused_with($$update public.catalog_items set treatment_type_id = '00000000-0000-0000-0000-000000e4ae04' where id = '00000000-0000-0000-0000-000000e4af04'$$,
  'catalog_items_treatment_type_fk', 'a type of another business');
insert into public.treatment_types (id, business_id, name) values ('00000000-0000-0000-0000-000000e4ae03', '00000000-0000-0000-0000-000000e4ab01', 'זמני');
update public.catalog_items set treatment_type_id = '00000000-0000-0000-0000-000000e4ae03' where id = '00000000-0000-0000-0000-000000e4af04';
delete from public.treatment_types where id = '00000000-0000-0000-0000-000000e4ae03';
select pg_temp.check((select treatment_type_id is null and name = 'ייעוץ' from public.catalog_items where id = '00000000-0000-0000-0000-000000e4af04'),
  'a deleted type: the service stays, with no type');

-- ======================================================================================================================
-- 2. tax withheld at source on a receipt: a receipt only, a customer who withheld it, a percent that is a percent, and money too
-- ======================================================================================================================
-- (December 2025: the opening balance — Dana's invoice for a laser treatment)
select pg_temp.issue('00000000-0000-0000-0000-000000e4a001', 305, 'rp-d0', '2025-12-10', '{"lead_id": "00000000-0000-0000-0000-000000e4ad01", "customer_name": "דנה"}',
  '[{"item": "00000000-0000-0000-0000-000000e4af01", "name": "טיפול לייזר", "qty": 1, "price": 500}]');
select pg_temp.refused_with($$select pg_temp.issue('00000000-0000-0000-0000-000000e4a001', 400, 'rp-bad1', '2026-01-20', '{"customer_name": ""}',
  '[{"name": "מקדמה", "qty": 1, "price": 60}]', p_pay => '[{"m": "cash", "amount": 50}, {"m": "withholding", "amount": 10, "pct": 5}]')$$,
  'withholding_customer', 'tax withheld at source names the customer who withheld it');
select pg_temp.refused_with($$select pg_temp.issue('00000000-0000-0000-0000-000000e4a001', 400, 'rp-bad2', '2026-01-20', '{"customer_name": "דנה"}',
  '[{"name": "מקדמה", "qty": 1, "price": 60}]', p_pay => '[{"m": "cash", "amount": 50}, {"m": "withholding", "amount": 10, "pct": 120}]')$$,
  'withholding_pct', 'a percent above 100');
select pg_temp.refused_with($$select pg_temp.issue('00000000-0000-0000-0000-000000e4a001', 400, 'rp-bad3', '2026-01-20', '{"customer_name": "דנה"}',
  '[{"name": "מקדמה", "qty": 1, "price": 60}]', p_pay => '[{"m": "cash", "amount": 50}, {"m": "withholding", "amount": 10, "pct": "5.555"}]')$$,
  'withholding_pct', 'a percent with three decimals');
select pg_temp.refused_with($$select pg_temp.issue('00000000-0000-0000-0000-000000e4a001', 400, 'rp-bad4', '2026-01-20', '{"customer_name": "דנה"}',
  '[{"name": "מקדמה", "qty": 1, "price": 60}]', p_pay => '[{"m": "cash", "amount": 50}, {"m": "withholding", "amount": 10, "pct": "חמישה"}]')$$,
  'withholding_pct', 'a percent that is not a number');
select pg_temp.refused_with($$select pg_temp.issue('00000000-0000-0000-0000-000000e4a001', 400, 'rp-bad5', '2026-01-20', '{"customer_name": "דנה"}',
  '[{"name": "מקדמה", "qty": 1, "price": 60}]', p_pay => '[{"m": "withholding", "amount": 60, "pct": 5}]')$$,
  'withholding_all', 'a receipt paid by tax withheld only');
select pg_temp.refused_with($$select pg_temp.issue('00000000-0000-0000-0000-000000e4a001', 305, 'rp-bad6', '2026-01-20', '{"customer_name": "דנה"}',
  '[{"name": "טיפול", "qty": 1, "price": 60}]', p_extra => '{"payments": [{"method": 9, "amount": 70.8, "m": "withholding"}]}')$$,
  'only a receipt', 'an invoice lists no payments, tax withheld neither');
select pg_temp.check((select count(*) from public.documents where idempotency_key like 'rp-bad%') = 0, 'none of them was issued');

-- the receipts: Dana pays the December invoice (5% withheld); the February invoice (laser ×2, cream ×3, a 10% discount) in part
select pg_temp.issue('00000000-0000-0000-0000-000000e4a001', 400, 'rp-r0', '2026-02-01', '{"lead_id": "00000000-0000-0000-0000-000000e4ad01", "customer_name": "דנה"}', '[]',
  p_pay => '[{"m": "transfer", "amount": 565}, {"m": "withholding", "amount": 25, "pct": 5}]',
  p_extra => jsonb_build_object('amount', 590, 'paid_document_id', pg_temp.d('rp-d0')));
select pg_temp.issue('00000000-0000-0000-0000-000000e4a001', 305, 'rp-d1', '2026-02-10', '{"lead_id": "00000000-0000-0000-0000-000000e4ad01", "customer_name": "דנה"}',
  '[{"item": "00000000-0000-0000-0000-000000e4af01", "name": "טיפול לייזר", "qty": 2, "price": 500}, {"item": "00000000-0000-0000-0000-000000e4af02", "name": "קרם", "qty": 3, "price": 100}]',
  p_discount => 130);
select pg_temp.issue('00000000-0000-0000-0000-000000e4a001', 400, 'rp-r1', '2026-03-01', '{"lead_id": "00000000-0000-0000-0000-000000e4ad01", "customer_name": "דנה"}', '[]',
  p_pay => '[{"m": "cash", "amount": 1000}, {"m": "withholding", "amount": 58.5, "pct": 5}]',
  p_extra => jsonb_build_object('amount', 1058.5, 'paid_document_id', pg_temp.d('rp-d1')));
-- Yossi (by name) buys the face package; a credit invoice gives Dana back one cream
select pg_temp.issue('00000000-0000-0000-0000-000000e4a001', 320, 'rp-d2', '2026-03-05', '{"customer_name": "יוסי כהן"}',
  '[{"item": "00000000-0000-0000-0000-000000e4af03", "name": "3 טיפולי פנים", "qty": 1, "price": 900}]', p_pay => '[{"m": "card", "amount": 1062}]');
select pg_temp.issue('00000000-0000-0000-0000-000000e4a001', 330, 'rp-d3', '2026-03-10', '{"lead_id": "00000000-0000-0000-0000-000000e4ad01", "customer_name": "דנה"}',
  '[{"item": "00000000-0000-0000-0000-000000e4af02", "name": "קרם", "qty": 1, "price": 100}]',
  p_extra => jsonb_build_object('base_doc_type', 305, 'base_doc_number', (select doc_number from public.documents where idempotency_key = 'rp-d1')));
-- a company (by its dealer number) at the branch: advice; two receipts, each with tax withheld (the first without a percent)
select pg_temp.issue('00000000-0000-0000-0000-000000e4a001', 305, 'rp-d4', '2026-04-01', '{"customer_name": "חברה בע\"מ", "customer_dealer": "514000012"}',
  '[{"item": "00000000-0000-0000-0000-000000e4af04", "name": "ייעוץ", "qty": 1, "price": 2000}]', p_extra => '{"location_id": "00000000-0000-0000-0000-000000e4ac02"}');
select pg_temp.issue('00000000-0000-0000-0000-000000e4a001', 400, 'rp-r4', '2026-04-15', '{"customer_name": "חברה בע\"מ", "customer_dealer": "514000012"}', '[]',
  p_pay => '[{"m": "transfer", "amount": 1000}, {"m": "withholding", "amount": 100}]',
  p_extra => jsonb_build_object('amount', 1100, 'paid_document_id', pg_temp.d('rp-d4')));
select pg_temp.issue('00000000-0000-0000-0000-000000e4a001', 400, 'rp-r5', '2026-05-01', '{"customer_name": "חברה בע\"מ", "customer_dealer": "514000012"}', '[]',
  p_pay => '[{"m": "transfer", "amount": 1160}, {"m": "withholding", "amount": 100, "pct": 5}]',
  p_extra => jsonb_build_object('amount', 1260, 'paid_document_id', pg_temp.d('rp-d4')));
-- three equal lines and a discount (the agora left by rounding); an invoice (300) paid by a tax invoice-receipt (320);
-- an invoice cancelled; a sale at the branch
select pg_temp.issue('00000000-0000-0000-0000-000000e4a001', 320, 'rp-d5', '2026-05-10', '{"lead_id": "00000000-0000-0000-0000-000000e4ad01", "customer_name": "דנה"}',
  '[{"item": "00000000-0000-0000-0000-000000e4af04", "name": "ייעוץ קצר", "qty": 1, "price": 100}, {"item": "00000000-0000-0000-0000-000000e4af02", "name": "קרם", "qty": 1, "price": 100},
    {"item": "00000000-0000-0000-0000-000000e4af01", "name": "טיפול לייזר", "qty": 1, "price": 100}]', p_discount => 100);
select pg_temp.issue('00000000-0000-0000-0000-000000e4a001', 300, 'rp-d6', '2026-06-01', '{"lead_id": "00000000-0000-0000-0000-000000e4ad01", "customer_name": "דנה"}',
  '[{"item": "00000000-0000-0000-0000-000000e4af01", "name": "טיפול לייזר", "qty": 1, "price": 400}]');
select pg_temp.issue('00000000-0000-0000-0000-000000e4a001', 320, 'rp-p6', '2026-06-05', '{"lead_id": "00000000-0000-0000-0000-000000e4ad01", "customer_name": "דנה"}',
  '[{"item": "00000000-0000-0000-0000-000000e4af01", "name": "טיפול לייזר", "qty": 1, "price": 400}]', p_extra => jsonb_build_object('paid_document_id', pg_temp.d('rp-d6')));
select pg_temp.issue('00000000-0000-0000-0000-000000e4a001', 300, 'rp-d7', '2026-06-10', '{"lead_id": "00000000-0000-0000-0000-000000e4ad01", "customer_name": "דנה"}',
  '[{"item": "00000000-0000-0000-0000-000000e4af04", "name": "ייעוץ", "qty": 1, "price": 50}]');
select pg_temp.issue('00000000-0000-0000-0000-000000e4a001', 320, 'rp-d8', '2026-07-01', '{"lead_id": "00000000-0000-0000-0000-000000e4ad01", "customer_name": "דנה"}',
  '[{"item": "00000000-0000-0000-0000-000000e4af02", "name": "קרם", "qty": 2, "price": 100}]', p_extra => '{"location_id": "00000000-0000-0000-0000-000000e4ac02"}');
insert into public.document_cancellations (document_id, user_id, reason) values (pg_temp.d('rp-d7'), '00000000-0000-0000-0000-000000e4a001', 'הופקה בטעות');
insert into public.document_cancellations (document_id, user_id, reason) values (pg_temp.d('rp-r5'), '00000000-0000-0000-0000-000000e4a001', 'ההעברה חזרה');
-- (December 2025) a sale at the register: a laser treatment and two creams; its document names them only (as the register writes
-- its lines) — and a cream comes back (a refund and its credit invoice)
insert into public.sales (id, user_id, items, subtotal, total, vat_rate, vat_amount, method, status, paid_at) values
  ('00000000-0000-0000-0000-000000e4a501', '00000000-0000-0000-0000-000000e4a001',
   '[{"name": "טיפול לייזר", "price": 590, "qty": 1, "itemId": "00000000-0000-0000-0000-000000e4af01", "kind": "service"},
     {"name": "קרם", "price": 118, "qty": 2, "itemId": "00000000-0000-0000-0000-000000e4af02", "kind": "product"}]', 826, 826, 18, 126, 'cash', 'paid', '2025-12-20 10:00+02');
select pg_temp.issue('00000000-0000-0000-0000-000000e4a001', 320, 'rp-s1', '2025-12-20', '{"customer_name": ""}',
  '[{"name": "טיפול לייזר", "qty": 1, "price": 500}, {"name": "קרם", "qty": 2, "price": 100}]', p_extra => '{"sale_id": "00000000-0000-0000-0000-000000e4a501"}');
insert into public.sale_refunds (id, user_id, sale_id, amount, vat_amount, method, items, restock, reason) values
  ('00000000-0000-0000-0000-000000e4a502', '00000000-0000-0000-0000-000000e4a001', '00000000-0000-0000-0000-000000e4a501', 118, 18, 'cash',
   '[{"name": "קרם", "price": 118, "qty": 1, "itemId": "00000000-0000-0000-0000-000000e4af02", "kind": "product"}]', false, 'החזרה');
select pg_temp.issue('00000000-0000-0000-0000-000000e4a001', 330, 'rp-s2', '2025-12-21', '{"customer_name": ""}', '[{"name": "קרם", "qty": 1, "price": 100}]',
  p_extra => jsonb_build_object('refund_id', '00000000-0000-0000-0000-000000e4a502', 'base_doc_type', 320,
    'base_doc_number', (select doc_number from public.documents where idempotency_key = 'rp-s1')));

select pg_temp.check((select string_agg(method || ':' || amount || ':' || coalesce(reference->>'pct', '-'), ',' order by amount) from public.payments
                       where document_id = pg_temp.d('rp-r0')) = 'withholding:25.00:5,transfer:565.00:-',
  'the ledger: tax withheld at source is its own row, with the percent on the certificate');
select pg_temp.check((select reference = '{}'::jsonb from public.payments where document_id = pg_temp.d('rp-r4') and method = 'withholding'), 'no percent: none kept');
select pg_temp.check((select applies_to = pg_temp.d('rp-d1') and lead_id = '00000000-0000-0000-0000-000000e4ad01' and source = 'document' and direction = 'in'
                        from public.payments where document_id = pg_temp.d('rp-r1') and method = 'withholding'), 'it pays the invoice, the customer''s');
select pg_temp.check((select string_agg(method || ':' || direction || ':' || amount, ',' order by method) from public.payments
                       where document_id = pg_temp.d('rp-r5') and source = 'cancel') = 'transfer:out:1160.00,withholding:out:100.00',
  'a cancelled receipt reverses its tax withheld too');
select pg_temp.check(pg_temp.bal('rp-d0') = 0 and pg_temp.bal('rp-d1') = 204.10 and pg_temp.bal('rp-d4') = 1260 and pg_temp.bal('rp-d6') = 0,
  'invoices: tax withheld pays them (590 − 565 − 25; 1380.60 − 118 − 1058.50; 2360 − 1100 after the cancel; the 300 paid by its 320)');

-- ---- the expenses ---------------------------------------------------------------------------------------------------------
insert into public.expenses (id, user_id, supplier_name, supplier_dealer, supplier_doc_type, supplier_doc_number, doc_date, category, amount_before_vat, vat_amount, total, paid_on, payment_method, location_id) values
  ('00000000-0000-0000-0000-000000e4a707', '00000000-0000-0000-0000-000000e4a001', 'ספק ציוד', '516000017', 'tax_invoice', '7001', '2025-12-15', 'supplies', 200, 36, 236, null, null, null),
  ('00000000-0000-0000-0000-000000e4a701', '00000000-0000-0000-0000-000000e4a001', 'ספק ציוד', '516000017', 'tax_invoice', '7101', '2026-02-05', 'supplies', 1000, 180, 1180, null, null, null),
  ('00000000-0000-0000-0000-000000e4a706', '00000000-0000-0000-0000-000000e4a001', 'ספק ציוד', '516000017', 'tax_invoice', '7102', '2026-02-20', 'supplies', 50, 9, 59, '2026-02-21', 'cash', null),
  ('00000000-0000-0000-0000-000000e4a702', '00000000-0000-0000-0000-000000e4a001', 'ספק ציוד בע"מ', '516000017', 'tax_invoice', '7103', '2026-03-05', 'supplies', 500, 90, 590, '2026-03-20', 'transfer', null),
  ('00000000-0000-0000-0000-000000e4a703', '00000000-0000-0000-0000-000000e4a001', 'ספק ציוד בע"מ', '516000017', 'credit', 'Z-9', '2026-04-05', 'supplies', 100, 18, 118, '2026-04-10', 'transfer', null),
  ('00000000-0000-0000-0000-000000e4a704', '00000000-0000-0000-0000-000000e4a001', 'חברת החשמל', '', 'tax_invoice', '', '2026-05-01', 'utilities', 300, 54, 354, '2026-05-01', 'card', '00000000-0000-0000-0000-000000e4ac02'),
  ('00000000-0000-0000-0000-000000e4a705', '00000000-0000-0000-0000-000000e4a001', 'חברת  החשמל', '', 'tax_invoice', '', '2026-06-01', 'utilities', 200, 36, 236, null, null, null);
insert into public.expenses (id, user_id, status, supplier_name, doc_date, category, amount_before_vat, vat_amount, total) values
  ('00000000-0000-0000-0000-000000e4a708', '00000000-0000-0000-0000-000000e4a001', 'draft', 'ספק ציוד', '2026-06-02', 'supplies', 999, 0, 999);
update public.expenses set status = 'void', void_reason = 'נרשמה פעמיים' where id = '00000000-0000-0000-0000-000000e4a706';
select pg_temp.refused_with($$insert into public.payments (business_id, direction, amount, method, paid_on, source, expense_id)
  values ('00000000-0000-0000-0000-000000e4ab01', 'out', 1, 'withholding', '2026-02-06', 'expense', '00000000-0000-0000-0000-000000e4a701')$$,
  'payments_withholding_source', 'tax withheld is never money of an expense (nor of a refund)');

-- ---- Clinic RB (exempt): an invoice (300) paid in part by a receipt with tax withheld; a receipt on its own; one cancelled; one with no lines
select pg_temp.issue('00000000-0000-0000-0000-000000e4a005', 300, 'rp-b1', '2026-03-01', '{"lead_id": "00000000-0000-0000-0000-000000e4ad02", "customer_name": "נועה"}',
  '[{"item": "00000000-0000-0000-0000-000000e4af05", "name": "טיפול", "qty": 2, "price": 150}]', p_vat => 0);
select pg_temp.issue('00000000-0000-0000-0000-000000e4a005', 400, 'rp-b2', '2026-03-10', '{"lead_id": "00000000-0000-0000-0000-000000e4ad02", "customer_name": "נועה"}', '[]',
  p_vat => 0, p_pay => '[{"m": "transfer", "amount": 100}, {"m": "withholding", "amount": 50, "pct": 2.5}]',
  p_extra => jsonb_build_object('amount', 150, 'paid_document_id', pg_temp.d('rp-b1')));
select pg_temp.issue('00000000-0000-0000-0000-000000e4a005', 400, 'rp-b3', '2026-04-01', '{"lead_id": "00000000-0000-0000-0000-000000e4ad02", "customer_name": "נועה"}',
  '[{"item": "00000000-0000-0000-0000-000000e4af05", "name": "טיפול", "qty": 1, "price": 150}]', p_vat => 0);
select pg_temp.issue('00000000-0000-0000-0000-000000e4a005', 400, 'rp-b4', '2026-04-05', '{"customer_name": "אורח"}',
  '[{"item": "00000000-0000-0000-0000-000000e4af05", "name": "טיפול", "qty": 1, "price": 80}]', p_vat => 0);
select pg_temp.issue('00000000-0000-0000-0000-000000e4a005', 400, 'rp-b5', '2026-04-10', '{"customer_name": "אורחת"}', '[]', p_vat => 0, p_extra => '{"amount": 40}');
insert into public.document_cancellations (document_id, user_id, reason) values (pg_temp.d('rp-b4'), '00000000-0000-0000-0000-000000e4a005', 'הופקה בטעות');

-- ======================================================================================================================
-- 3. the reports, as the screens call them
-- ======================================================================================================================
create temp table rep_out (who text, j jsonb);
grant all on rep_out to authenticated;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e4a001');
insert into rep_out select 'fs', public.finance_summary('2026-01-01', public.il_today());
insert into rep_out select 'inc', public.report_income_by_customer('2026-01-01', public.il_today());
insert into rep_out select 'items', public.report_sales_by_item('2026-01-01', public.il_today());
insert into rep_out select 'led:dana', public.report_customer_ledger('l:00000000-0000-0000-0000-000000e4ad01', '2026-01-01', public.il_today());
insert into rep_out select 'led:co', public.report_customer_ledger('d:514000012', '2026-01-01', public.il_today());
insert into rep_out select 'led:yossi', public.report_customer_ledger(public.party_key(null, '', 'יוסי כהן'), '2026-01-01', public.il_today());
insert into rep_out select 'led:none', public.report_customer_ledger('n:אףאחד', '2026-01-01', public.il_today());
insert into rep_out select 'sup', public.report_suppliers('2026-01-01', public.il_today());
insert into rep_out select 'sled:goods', public.report_supplier_ledger('d:516000017', '2026-01-01', public.il_today());
insert into rep_out select 'sled:power', public.report_supplier_ledger(public.party_key(null, '', 'חברת החשמל'), '2026-01-01', public.il_today());
insert into rep_out select 'wh', public.report_withholding('2026-01-01', public.il_today());
insert into rep_out select 'fs:2025', public.finance_summary('2025-01-01', '2025-12-31');
insert into rep_out select 'inc:2025', public.report_income_by_customer('2025-01-01', '2025-12-31');
insert into rep_out select 'items:2025', public.report_sales_by_item('2025-12-01', '2025-12-31');
select pg_temp.refused_with($$select public.report_income_by_customer('2026-02-01', '2026-01-01')$$, 'bad range', 'a period from after to before');
select pg_temp.refused_with($$select public.report_withholding('2010-01-01', '2026-01-01')$$, 'bad range', 'more than ten years at once');
select pg_temp.refused_with($$select public.report_customer_ledger('x:1', '2026-01-01', '2026-02-01')$$, 'customer: a key', 'a ledger of a customer key');
select pg_temp.refused_with($$select public.report_supplier_ledger('l:00000000-0000-0000-0000-000000e4ad01', '2026-01-01', '2026-02-01')$$, 'supplier: a key',
  'a supplier is by dealer number or name');
-- the location picked at the top: the branch only
select public.location_select('00000000-0000-0000-0000-000000e4ac02');
insert into rep_out select 'inc:l2', public.report_income_by_customer('2026-01-01', public.il_today());
insert into rep_out select 'fs:l2', public.finance_summary('2026-01-01', public.il_today());
select public.location_select(null);
-- the viewer reads the same; a manager of the branch reads the branch; the cashier reads none of it
select pg_temp.as_user('00000000-0000-0000-0000-000000e4a003');
insert into rep_out select 'va:inc', public.report_income_by_customer('2026-01-01', public.il_today());
insert into rep_out select 'va:led', public.report_customer_ledger('l:00000000-0000-0000-0000-000000e4ad01', '2026-01-01', public.il_today());
insert into rep_out select 'va:sup', public.report_suppliers('2026-01-01', public.il_today());
select pg_temp.as_user('00000000-0000-0000-0000-000000e4a004');
insert into rep_out select 'ml:fs', public.finance_summary('2026-01-01', public.il_today());
insert into rep_out select 'ml:inc', public.report_income_by_customer('2026-01-01', public.il_today());
insert into rep_out select 'ml:items', public.report_sales_by_item('2026-01-01', public.il_today());
insert into rep_out select 'ml:led:dana', public.report_customer_ledger('l:00000000-0000-0000-0000-000000e4ad01', '2026-01-01', public.il_today());
insert into rep_out select 'ml:led:co', public.report_customer_ledger('d:514000012', '2026-01-01', public.il_today());
insert into rep_out select 'ml:sup', public.report_suppliers('2026-01-01', public.il_today());
insert into rep_out select 'ml:wh', public.report_withholding('2026-01-01', public.il_today());
select pg_temp.as_user('00000000-0000-0000-0000-000000e4a002');
select pg_temp.refused_with($$select public.report_income_by_customer('2026-01-01', '2026-02-01')$$, 'not allowed', 'a cashier: no income report');
select pg_temp.refused_with($$select public.report_sales_by_item('2026-01-01', '2026-02-01')$$, 'not allowed', 'nor sales by item');
select pg_temp.refused_with($$select public.report_customer_ledger('l:00000000-0000-0000-0000-000000e4ad01', '2026-01-01', '2026-02-01')$$, 'not allowed', 'nor a customer''s card');
select pg_temp.refused_with($$select public.report_suppliers('2026-01-01', '2026-02-01')$$, 'not allowed', 'nor suppliers');
select pg_temp.refused_with($$select public.report_supplier_ledger('d:516000017', '2026-01-01', '2026-02-01')$$, 'not allowed', 'nor a supplier''s card');
select pg_temp.refused_with($$select public.report_withholding('2026-01-01', '2026-02-01')$$, 'not allowed', 'nor tax withheld');
-- the exempt clinic: its own, nothing of the other
select pg_temp.as_user('00000000-0000-0000-0000-000000e4a005');
insert into rep_out select 'b:fs', public.finance_summary('2026-01-01', public.il_today());
insert into rep_out select 'b:inc', public.report_income_by_customer('2026-01-01', public.il_today());
insert into rep_out select 'b:items', public.report_sales_by_item('2026-01-01', public.il_today());
insert into rep_out select 'b:led:noa', public.report_customer_ledger('l:00000000-0000-0000-0000-000000e4ad02', '2026-01-01', public.il_today());
insert into rep_out select 'b:led:dana', public.report_customer_ledger('l:00000000-0000-0000-0000-000000e4ad01', '2026-01-01', public.il_today());
insert into rep_out select 'b:sup', public.report_suppliers('2026-01-01', public.il_today());
insert into rep_out select 'b:wh', public.report_withholding('2026-01-01', public.il_today());
commit;
begin;
set local role anon;
select pg_temp.refused_with($$select public.report_income_by_customer('2026-01-01', '2026-02-01')$$, 'permission denied', 'nobody signed out');
commit;
create or replace function pg_temp.r(p_who text) returns jsonb language sql as $$ select j from rep_out where who = p_who $$;
create or replace function pg_temp.n(p_j jsonb, variadic p_path text[]) returns numeric language sql as $$ select (p_j #>> p_path)::numeric $$;

-- ---- tax withheld at source: not money in the cash, its own line --------------------------------------------------------------
select pg_temp.check(pg_temp.n(pg_temp.r('fs'), 'withheld') = 183.50, 'withheld this year: 25 + 58.50 + 100 + 100 − 100 (the cancelled receipt)');
select pg_temp.check(pg_temp.n(pg_temp.r('fs'), 'cash', 'in') = (select sum(amount) from public.payments where business_id = '00000000-0000-0000-0000-000000e4ab01'
                       and direction = 'in' and method <> 'withholding' and paid_on between '2026-01-01' and public.il_today())
  and pg_temp.n(pg_temp.r('fs'), 'cash', 'out') = (select sum(amount) from public.payments where business_id = '00000000-0000-0000-0000-000000e4ab01'
                       and direction = 'out' and method <> 'withholding' and paid_on between '2026-01-01' and public.il_today()),
  'money in and out: without tax withheld');
select pg_temp.check(not exists (select 1 from jsonb_array_elements(pg_temp.r('fs')->'cash'->'byMethod') m where m->>'method' = 'withholding')
  and exists (select 1 from jsonb_array_elements(pg_temp.r('fs')->'cash'->'byMethod') m where m->>'method' = 'transfer' and (m->>'in')::numeric = 565 + 1000 + 1160 + 118),
  'by method: no "withholding" money (transfers in: the three receipts and the supplier''s money back)');

-- ---- income by customer: the revenue of finance_summary, customer by customer -------------------------------------------------
select pg_temp.check(pg_temp.n(pg_temp.r('inc'), 'total', 'net') = 4770 and pg_temp.n(pg_temp.r('inc'), 'total', 'vat') = 858.60
  and pg_temp.n(pg_temp.r('inc'), 'total', 'net') = pg_temp.n(pg_temp.r('fs'), 'revenue', 'net')
  and pg_temp.n(pg_temp.r('inc'), 'total', 'vat') = pg_temp.n(pg_temp.r('fs'), 'revenue', 'vat'),
  'income: 1170 + 900 − 100 + 2000 + 200 + 400 + 200 = 4770 before VAT (858.60 VAT) — the money screens'' revenue');
select pg_temp.check((select string_agg(c->>'key' || '=' || (c->>'net') || '/' || (c->>'count'), ',' order by o) from jsonb_array_elements(pg_temp.r('inc')->'customers') with ordinality x(c, o))
  = 'd:514000012=2000.00/1,l:00000000-0000-0000-0000-000000e4ad01=1870.00/5,n:יוסיכהן=900.00/1',
  'by customer, the biggest first: the company (by dealer number), Dana (her card: 1170 − 100 + 200 + 400 + 200), Yossi (by name)');
select pg_temp.check((select c->>'name' = 'דנה' and c->>'leadId' = '00000000-0000-0000-0000-000000e4ad01' and (c->>'gross')::numeric = 1870 + 336.60
                        from jsonb_array_elements(pg_temp.r('inc')->'customers') c where c->>'key' like 'l:%')
  and (select c->>'name' = 'חברה בע"מ' and c->>'dealer' = '514000012' from jsonb_array_elements(pg_temp.r('inc')->'customers') c where c->>'key' like 'd:%'),
  'her name from the card; the company''s name and number');
select pg_temp.check(pg_temp.n(pg_temp.r('inc:2025'), 'total', 'net') = 1100 and pg_temp.n(pg_temp.r('fs:2025'), 'revenue', 'net') = 1100
  and jsonb_array_length(pg_temp.r('inc:2025')->'customers') = 2, 'last year: the December invoice, and the register''s sale less its refund (700 − 100)');

-- ---- sales by item, service and treatment type: every agora of the revenue on an item ------------------------------------------
select pg_temp.check(pg_temp.n(pg_temp.r('items'), 'total') = 4770 and pg_temp.n(pg_temp.r('items'), 'unattributed', 'net') = 0
  and (select sum((i->>'net')::numeric) from jsonb_array_elements(pg_temp.r('items')->'items') i) = 4770
  and (select sum((t->>'net')::numeric) from jsonb_array_elements(pg_temp.r('items')->'types') t) = 4770,
  'items and types add up to the revenue exactly');
select pg_temp.check((select string_agg(i->>'name' || '=' || (i->>'net') || 'x' || (i->>'qty'), ',' order by o) from jsonb_array_elements(pg_temp.r('items')->'items') with ordinality x(i, o))
  = 'ייעוץ=2066.66x2.00,טיפול לייזר=1366.67x4.00,3 טיפולי פנים=900.00x1.00,קרם=436.67x5.00',
  'by item: advice 2000 + 66.66 (it took the agora rounding left); laser 900 + 66.67 + 400; the package; cream 270 − 100 + 66.67 + 200 (5 units: 3 − 1 + 1 + 2)');
select pg_temp.check((select i->>'kind' = 'service' and i->>'typeId' = '00000000-0000-0000-0000-000000e4ae01' from jsonb_array_elements(pg_temp.r('items')->'items') i where i->>'name' = 'טיפול לייזר')
  and (select i->>'kind' = 'package' and i->>'typeId' = '00000000-0000-0000-0000-000000e4ae02' from jsonb_array_elements(pg_temp.r('items')->'items') i where i->>'name' = '3 טיפולי פנים')
  and (select i->>'kind' = 'product' and i->'typeId' = 'null' from jsonb_array_elements(pg_temp.r('items')->'items') i where i->>'name' = 'קרם'),
  'a service by its type, a package by its own, a product without');
select pg_temp.check((select string_agg(coalesce(t->>'name', '?') || '=' || (t->>'net'), ',' order by o) from jsonb_array_elements(pg_temp.r('items')->'types') with ordinality x(t, o))
  = '=2503.33,לייזר=1366.67,פנים=900.00', 'by treatment type (and what has none)');

-- the register's sale: its document names the items only — the report reads the sale's lines (and the refund's), so the laser of
-- the register is the same item as the invoice's, with its treatment type
select pg_temp.check(pg_temp.n(pg_temp.r('items:2025'), 'total') = 1100
  and (select string_agg(i->>'name' || '=' || (i->>'net') || 'x' || (i->>'qty'), ',' order by o) from jsonb_array_elements(pg_temp.r('items:2025')->'items') with ordinality x(i, o))
      = 'טיפול לייזר=1000.00x2.00,קרם=100.00x1.00'
  and (select string_agg(coalesce(t->>'name', '?') || '=' || (t->>'net'), ',' order by o) from jsonb_array_elements(pg_temp.r('items:2025')->'types') with ordinality x(t, o))
      = 'לייזר=1000.00,=100.00',
  'December: the invoice''s laser 500 and the register''s 500 — one item; two creams sold, one back');

-- ---- a customer's card: the opening balance, every charge and payment, the balance as it runs = what the invoices still owe --------
select pg_temp.check(pg_temp.n(pg_temp.r('led:dana'), 'opening') = 590 and pg_temp.n(pg_temp.r('led:dana'), 'closing') = 204.10
  and pg_temp.r('led:dana')->>'name' = 'דנה'
  and pg_temp.n(pg_temp.r('led:dana'), 'closing') = (select sum(balance) from public.receivables where lead_id = '00000000-0000-0000-0000-000000e4ad01' and not cancelled),
  'Dana: 590 owed on 1.1 (December''s invoice); 204.10 now — what her invoices still owe');
select pg_temp.check(pg_temp.n(pg_temp.r('led:dana'), 'opening') + pg_temp.n(pg_temp.r('led:dana'), 'debit') - pg_temp.n(pg_temp.r('led:dana'), 'credit')
                       = pg_temp.n(pg_temp.r('led:dana'), 'closing')
  and (select (r->>'balance')::numeric from jsonb_array_elements(pg_temp.r('led:dana')->'rows') with ordinality x(r, o) order by o desc limit 1) = 204.10,
  'opening + charged − paid = closing, and the last row''s balance');
select pg_temp.check((select string_agg(r->>'kind' || ':' || coalesce(r->>'method', '') || ':' || (r->>'balance'), ',' order by o)
                        from jsonb_array_elements(pg_temp.r('led:dana')->'rows') with ordinality x(r, o) where r->>'date' < '2026-03-11')
  in ('payment_document:transfer:25.00,payment_document:withholding:0.00,charge::1380.60,payment_document:cash:380.60,payment_document:withholding:322.10,credit::204.10',
      'payment_document:withholding:565.00,payment_document:transfer:0.00,charge::1380.60,payment_document:cash:380.60,payment_document:withholding:322.10,credit::204.10',
      'payment_document:transfer:25.00,payment_document:withholding:0.00,charge::1380.60,payment_document:withholding:1322.10,payment_document:cash:322.10,credit::204.10',
      'payment_document:withholding:565.00,payment_document:transfer:0.00,charge::1380.60,payment_document:withholding:1322.10,payment_document:cash:322.10,credit::204.10'),
  'February–March: the receipt (tax withheld is a payment), the invoice, the receipt in part, the credit invoice');
select pg_temp.check((select count(*) from jsonb_array_elements(pg_temp.r('led:dana')->'rows') r where r->>'kind' = 'charge' and (r->>'docType')::int = 320 and (r->>'docNumber') =
                        (select doc_number::text from public.documents where idempotency_key = 'rp-p6')) = 0
  and (select count(*) from jsonb_array_elements(pg_temp.r('led:dana')->'rows') r where r->>'kind' = 'charge' and (r->>'docType')::int = 300) = 2
  and (select count(*) from jsonb_array_elements(pg_temp.r('led:dana')->'rows') r where r->>'kind' = 'cancelled' and (r->>'docType')::int = 300 and (r->>'credit')::numeric = 59) = 1,
  'the 320 that pays her 300 charges nothing again; the cancelled 300 comes off');
select pg_temp.check(pg_temp.n(pg_temp.r('led:co'), 'opening') = 0 and pg_temp.n(pg_temp.r('led:co'), 'closing') = 1260 and pg_temp.n(pg_temp.r('led:co'), 'closing') = pg_temp.bal('rp-d4')
  and (select count(*) from jsonb_array_elements(pg_temp.r('led:co')->'rows') r where r->>'kind' = 'payment_cancel' and (r->>'debit')::numeric > 0) = 2,
  'the company: 2360 − 1100; the cancelled receipt''s money and tax withheld back on its card');
select pg_temp.check(pg_temp.n(pg_temp.r('led:yossi'), 'closing') = 0 and jsonb_array_length(pg_temp.r('led:yossi')->'rows') = 2 and pg_temp.r('led:yossi')->>'name' = 'יוסי כהן',
  'Yossi (by name): charged and paid on the spot');
select pg_temp.check(pg_temp.n(pg_temp.r('led:none'), 'closing') = 0 and pg_temp.r('led:none')->'rows' = '[]'::jsonb and pg_temp.r('led:none')->>'name' = '', 'nobody: an empty card');

-- ---- suppliers and kinds of expense, paid and not yet; a supplier's card ------------------------------------------------------
select pg_temp.check(pg_temp.n(pg_temp.r('sup'), 'total', 'total') = 2242 and pg_temp.n(pg_temp.r('sup'), 'total', 'total') = pg_temp.n(pg_temp.r('fs'), 'expenses', 'total')
  and pg_temp.n(pg_temp.r('sup'), 'total', 'net') = pg_temp.n(pg_temp.r('fs'), 'expenses', 'net')
  and pg_temp.n(pg_temp.r('sup'), 'total', 'vat') = pg_temp.n(pg_temp.r('fs'), 'expenses', 'vat')
  and pg_temp.n(pg_temp.r('sup'), 'total', 'count') = pg_temp.n(pg_temp.r('fs'), 'expenses', 'count')
  and pg_temp.n(pg_temp.r('sup'), 'total', 'paid') = 826 and pg_temp.n(pg_temp.r('sup'), 'total', 'open') = 1416,
  'expenses: 1180 + 590 − 118 + 354 + 236 — the money screens'' (no draft, no voided one); 826 paid, 1416 not yet');
select pg_temp.check((select string_agg(s->>'key' || '=' || (s->>'total') || '/' || (s->>'paid') || '/' || (s->>'open') || '/' || (s->>'count'), ',' order by o)
                        from jsonb_array_elements(pg_temp.r('sup')->'suppliers') with ordinality x(s, o))
  = 'd:516000017=1652.00/472.00/1180.00/3,n:חברתהחשמל=590.00/354.00/236.00/2',
  'by supplier: the goods supplier by dealer number (its credit note takes off, money back too); the electric company by name, written two ways');
select pg_temp.check((select s->>'name' = 'ספק ציוד בע"מ' and s->>'dealer' = '516000017' from jsonb_array_elements(pg_temp.r('sup')->'suppliers') s where s->>'key' like 'd:%'),
  'its name as last written');
select pg_temp.check((select string_agg(c->>'category' || '=' || (c->>'total') || '/' || (c->>'open'), ',' order by o) from jsonb_array_elements(pg_temp.r('sup')->'categories') with ordinality x(c, o))
  = 'supplies=1652.00/1180.00,utilities=590.00/236.00', 'by kind');
select pg_temp.check(pg_temp.n(pg_temp.r('sled:goods'), 'opening') = 236 and pg_temp.n(pg_temp.r('sled:goods'), 'closing') = 1416
  and pg_temp.n(pg_temp.r('sled:goods'), 'debit') = 767 and pg_temp.n(pg_temp.r('sled:goods'), 'credit') = 1947,
  'the goods supplier''s card: 236 owed on 1.1; now 236 + 1180 (the voided one paid and paid back, the credit note paid back)');
select pg_temp.check((select string_agg(r->>'kind' || ':' || (r->>'balance'), ',' order by o) from jsonb_array_elements(pg_temp.r('sled:goods')->'rows') with ordinality x(r, o))
  = 'invoice:1416.00,payment_expense:1357.00,invoice:1947.00,payment_expense:1357.00,supplier_credit:1239.00,payment_expense:1357.00,payment_reversal:1416.00',
  'its rows, the balance as it runs');
select pg_temp.check(pg_temp.n(pg_temp.r('sled:power'), 'closing') = 236 and pg_temp.r('sled:power')->>'name' = 'חברת  החשמל', 'the electric company: one bill open');

-- ---- tax withheld at source, by customer (against the certificates) -------------------------------------------------------------
select pg_temp.check(pg_temp.n(pg_temp.r('wh'), 'total') = 183.50 and pg_temp.n(pg_temp.r('wh'), 'total') = pg_temp.n(pg_temp.r('fs'), 'withheld'),
  'tax withheld: the money screens'' number');
select pg_temp.check((select string_agg(c->>'key' || '=' || (c->>'amount') || '/' || (c->>'count'), ',' order by o) from jsonb_array_elements(pg_temp.r('wh')->'customers') with ordinality x(c, o))
  = 'd:514000012=100.00/1,l:00000000-0000-0000-0000-000000e4ad01=83.50/2', 'by customer: the company (one receipt left), Dana (two)');
select pg_temp.check((select string_agg((r->>'amount') || '@' || coalesce(r->>'pct', '-') || '@' || (r->>'invoice'), ',' order by o) from jsonb_array_elements(pg_temp.r('wh')->'rows') with ordinality x(r, o))
  = format('25.00@5@%s,58.50@5@%s,100.00@-@%s,100.00@5@%s,-100.00@-@%s', pg_temp.num('rp-d0'), pg_temp.num('rp-d1'), pg_temp.num('rp-d4'), pg_temp.num('rp-d4'), pg_temp.num('rp-d4')),
  'its rows: the amount, the percent and the invoice it paid; the cancelled receipt''s back');

-- ---- who reads what --------------------------------------------------------------------------------------------------------
select pg_temp.check(pg_temp.r('va:inc') = pg_temp.r('inc') and pg_temp.r('va:led') = pg_temp.r('led:dana') and pg_temp.r('va:sup') = pg_temp.r('sup'),
  'a viewer reads the same reports');
select pg_temp.check(pg_temp.n(pg_temp.r('inc:l2'), 'total', 'net') = 2200 and pg_temp.n(pg_temp.r('inc:l2'), 'total', 'net') = pg_temp.n(pg_temp.r('fs:l2'), 'revenue', 'net'),
  'the branch picked at the top: its income (the company''s 2000, Dana''s 200) — as the money screens');
select pg_temp.check(pg_temp.n(pg_temp.r('ml:inc'), 'total', 'net') = 2200 and pg_temp.n(pg_temp.r('ml:fs'), 'revenue', 'net') = 2200
  and pg_temp.n(pg_temp.r('ml:items'), 'total') = 2200 and pg_temp.n(pg_temp.r('ml:fs'), 'withheld') = 100 and pg_temp.n(pg_temp.r('ml:wh'), 'total') = 100
  and pg_temp.n(pg_temp.r('ml:sup'), 'total', 'total') = 354 and pg_temp.n(pg_temp.r('ml:sup'), 'total', 'total') = pg_temp.n(pg_temp.r('ml:fs'), 'expenses', 'total'),
  'a manager of the branch: the branch''s income, items, tax withheld and expenses — each as their money screens');
select pg_temp.check(pg_temp.n(pg_temp.r('ml:led:dana'), 'opening') = 0 and pg_temp.n(pg_temp.r('ml:led:dana'), 'closing') = 0 and jsonb_array_length(pg_temp.r('ml:led:dana')->'rows') = 2
  and pg_temp.n(pg_temp.r('ml:led:co'), 'closing') = 1260, 'and of a customer''s card, the branch''s part');
select pg_temp.check(pg_temp.n(pg_temp.r('b:inc'), 'total', 'net') = 340 and pg_temp.n(pg_temp.r('b:fs'), 'revenue', 'net') = 340
  and (select string_agg(c->>'name' || '=' || (c->>'net'), ',' order by o) from jsonb_array_elements(pg_temp.r('b:inc')->'customers') with ordinality x(c, o)) = 'נועה=300.00,אורחת=40.00',
  'an exempt dealer: income by its receipts (150 + 150 + 40; not the 300, not the cancelled one)');
select pg_temp.check(pg_temp.n(pg_temp.r('b:items'), 'total') = 340 and pg_temp.n(pg_temp.r('b:items'), 'unattributed', 'net') = 40 and pg_temp.n(pg_temp.r('b:items'), 'unattributed', 'count') = 1
  and (select string_agg(i->>'name' || '=' || (i->>'net') || 'x' || (i->>'qty'), ',') from jsonb_array_elements(pg_temp.r('b:items')->'items') i) = 'טיפול=300.00x2.00',
  'its items: a receipt for half the invoice takes half its lines (one of two treatments); a receipt with no lines is "not by item"');
select pg_temp.check(pg_temp.n(pg_temp.r('b:led:noa'), 'closing') = 150 and pg_temp.n(pg_temp.r('b:led:noa'), 'closing') = pg_temp.bal('rp-b1')
  and pg_temp.n(pg_temp.r('b:wh'), 'total') = 50 and pg_temp.n(pg_temp.r('b:fs'), 'withheld') = 50,
  'Noa''s card: 300 − 150 (tax withheld included); its tax withheld');
select pg_temp.check(pg_temp.r('b:led:dana')->'rows' = '[]'::jsonb and pg_temp.n(pg_temp.r('b:led:dana'), 'opening') = 0
  and pg_temp.r('b:sup')->'suppliers' = '[]'::jsonb and pg_temp.n(pg_temp.r('b:sup'), 'total', 'total') = 0
  and not exists (select 1 from jsonb_array_elements(pg_temp.r('b:inc')->'customers') c where c->>'key' like 'd:%'),
  'another business: nothing of the first one');

-- ======================================================================================================================
-- 4. the income tax advances: a percent the business sets (an estimate on the screen) — the owner's, 0–100
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e4a001');
insert into public.business_finance_profile (user_id, advance_pct) values ('00000000-0000-0000-0000-000000e4a001', 7.5);
select pg_temp.check((select advance_pct from public.business_finance_profile) = 7.5, 'the owner sets 7.5%');
select pg_temp.refused_with($$update public.business_finance_profile set advance_pct = 120$$, 'business_finance_profile_advance_pct_check', 'not above 100');
select pg_temp.refused_with($$update public.business_finance_profile set advance_pct = -1$$, 'business_finance_profile_advance_pct_check', 'not below 0');
select pg_temp.as_user('00000000-0000-0000-0000-000000e4a003');
update public.business_finance_profile set advance_pct = 50;
select pg_temp.check((select advance_pct from public.business_finance_profile) = 7.5, 'a viewer does not change it');
select pg_temp.as_user('00000000-0000-0000-0000-000000e4a002');
select pg_temp.check((select count(*) from public.business_finance_profile) = 0, 'a cashier does not see it');
commit;
