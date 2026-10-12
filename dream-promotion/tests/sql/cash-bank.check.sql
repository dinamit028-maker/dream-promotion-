-- The money desks, deposits, cheques and the bank's reconciliation (T9); an order, a delivery note and a return note (T10) —
-- migration 20261011005000, docs/FINANCE_ADDITIONS_HE.md — on a real Postgres (tests/sql/run.sh). The screens' calls run as the
-- signed-in roles. Fixtures only, with ids of their own:
--   Shop CA (a company, VAT)    owner OA, cashier KA; a branch L2; CREAM (a counted product, 10 in stock), SVC (a service).
--   Shop CB (an exempt dealer)  owner OB — a second business: its own series, nothing of the others.
--   Clinic CD (an exempt dealer) owner OD, cashier KD, viewer VD, manager MD (full access, limited to the branch L2) — the desks,
--                               the deposits, the cheques' reminders and the bank.
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
-- a document as the screens send it: lines [{item, name, qty, price}] before VAT, the VAT by the rate (none on a receipt or at 0%);
-- a receipt paid as p_pay says ([{m, amount, cheque}]) — else in cash, all of it. Its business follows its user.
create or replace function pg_temp.issue(p_user text, p_type int, p_key text, p_who jsonb, p_lines jsonb, p_vat numeric default 18,
                                         p_pay jsonb default null, p_extra jsonb default '{}')
returns uuid language plpgsql as $$
declare r jsonb; cols text; id uuid; ls jsonb; bd numeric; v numeric; t numeric; pays jsonb; dd date := public.il_today();
begin
  select coalesce(jsonb_agg(jsonb_build_object('name', coalesce(e->>'name', 'פריט'), 'qty', (e->>'qty')::numeric, 'unitPriceExVat', (e->>'price')::numeric,
           'discountExVat', 0, 'totalExVat', (e->>'qty')::numeric * (e->>'price')::numeric, 'vatRate', p_vat, 'kind', 1)
           || case when e ? 'item' then jsonb_build_object('itemId', e->>'item') else '{}'::jsonb end order by o), '[]'::jsonb),
         coalesce(sum((e->>'qty')::numeric * (e->>'price')::numeric), 0)
    into ls, bd from jsonb_array_elements(p_lines) with ordinality x(e, o);
  if jsonb_array_length(ls) = 0 then bd := (p_extra->>'amount')::numeric; end if;
  v := case when p_type = 400 or p_vat = 0 then 0 else round(bd * p_vat / 100, 2) end;
  t := bd + v;
  pays := case when p_type not in (320, 400) then '[]'::jsonb
               when p_pay is null then jsonb_build_array(jsonb_build_object('method', 1, 'amount', t, 'date', dd, 'm', 'cash'))
               else (select jsonb_agg(jsonb_build_object('method', case e->>'m' when 'cash' then 1 when 'cheque' then 2 when 'card' then 3 when 'transfer' then 4 else 9 end,
                                                         'amount', (e->>'amount')::numeric, 'date', dd, 'm', e->>'m')
                                      || case when e ? 'cheque' then jsonb_build_object('cheque', e->'cheque') else '{}'::jsonb end order by o)
                       from jsonb_array_elements(p_pay) with ordinality x(e, o)) end;
  r := jsonb_build_object('user_id', p_user, 'doc_type', p_type, 'doc_number', 0, 'doc_date', dd, 'customer_name', '',
    'before_discount', bd, 'discount', 0, 'after_discount', bd, 'vat_amount', v, 'total', t, 'vat_rate', p_vat,
    'idempotency_key', p_key, 'lines', ls, 'payments', pays) || p_who || (p_extra - 'amount');
  select string_agg(quote_ident(k), ', ') into cols from jsonb_object_keys(r) k;
  execute format('insert into public.documents (%s) select %s from jsonb_populate_record(null::public.documents, $1) returning id', cols, cols) using r into id;
  return id;
end $$;
create or replace function pg_temp.d(p_key text) returns uuid language sql as $$ select id from public.documents where idempotency_key = p_key $$;
create or replace function pg_temp.num(p_key text) returns text language sql as $$ select doc_type || '-' || doc_number from public.documents where idempotency_key = p_key $$;
create or replace function pg_temp.no(p_key text) returns bigint language sql as $$ select doc_number from public.documents where idempotency_key = p_key $$;
create or replace function pg_temp.cream() returns int language sql as $$ select stock_qty from public.catalog_items where id = '00000000-0000-0000-0000-000000e50f01' $$;
create or replace function pg_temp.pay(p_key text, p_m text) returns uuid language sql as $$
  select p.id from public.payments p where p.document_id = pg_temp.d(p_key) and p.method = p_m and p.direction = 'in' $$;
-- the reference day of the cheques' timer: today, or Sunday when today is Saturday (no reminder goes out on Saturday)
create or replace function pg_temp.rday() returns date language sql as $$
  select case when extract(isodow from public.il_today()) = 6 then public.il_today() + 1 else public.il_today() end $$;
create or replace function pg_temp.at(p_day date, p_time time) returns timestamptz language sql as $$ select (p_day + p_time) at time zone 'Asia/Jerusalem' $$;

-- ---- the world ------------------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000e50a01', 'oa@cash-a.test'), ('00000000-0000-0000-0000-000000e50a02', 'ka@cash-a.test'),
  ('00000000-0000-0000-0000-000000e50a03', 'ob@cash-b.test'), ('00000000-0000-0000-0000-000000e50a04', 'od@cash-d.test'),
  ('00000000-0000-0000-0000-000000e50a05', 'kd@cash-d.test'), ('00000000-0000-0000-0000-000000e50a06', 'vd@cash-d.test'),
  ('00000000-0000-0000-0000-000000e50a07', 'md@cash-d.test');
insert into public.businesses (id, name, slug) values ('00000000-0000-0000-0000-000000e50b01', 'Shop CA', 'cash-shop-a'),
  ('00000000-0000-0000-0000-000000e50b02', 'Shop CB', 'cash-shop-b'), ('00000000-0000-0000-0000-000000e50b04', 'Clinic CD', 'cash-clinic-d');
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-000000e50b01', '00000000-0000-0000-0000-000000e50a01', 'owner', 'full'),
  ('00000000-0000-0000-0000-000000e50b01', '00000000-0000-0000-0000-000000e50a02', 'editor', 'register'),
  ('00000000-0000-0000-0000-000000e50b02', '00000000-0000-0000-0000-000000e50a03', 'owner', 'full'),
  ('00000000-0000-0000-0000-000000e50b04', '00000000-0000-0000-0000-000000e50a04', 'owner', 'full'),
  ('00000000-0000-0000-0000-000000e50b04', '00000000-0000-0000-0000-000000e50a05', 'editor', 'register'),
  ('00000000-0000-0000-0000-000000e50b04', '00000000-0000-0000-0000-000000e50a06', 'viewer', 'full'),
  ('00000000-0000-0000-0000-000000e50b04', '00000000-0000-0000-0000-000000e50a07', 'editor', 'full');
update public.profiles set current_business_id = '00000000-0000-0000-0000-000000e50b01' where id in ('00000000-0000-0000-0000-000000e50a01', '00000000-0000-0000-0000-000000e50a02');
update public.profiles set current_business_id = '00000000-0000-0000-0000-000000e50b02' where id = '00000000-0000-0000-0000-000000e50a03';
update public.profiles set current_business_id = '00000000-0000-0000-0000-000000e50b04'
 where id in ('00000000-0000-0000-0000-000000e50a04', '00000000-0000-0000-0000-000000e50a05', '00000000-0000-0000-0000-000000e50a06', '00000000-0000-0000-0000-000000e50a07');
insert into public.register_settings (user_id, business_id, business_type, vat_rate, dealer_number, legal_name, street, city, entity_type) values
  ('00000000-0000-0000-0000-000000e50a01', '00000000-0000-0000-0000-000000e50b01', 'licensed', 18, '514000004', 'חנות א׳ בע"מ', 'הרצל', 'תל אביב', 'company'),
  ('00000000-0000-0000-0000-000000e50a03', '00000000-0000-0000-0000-000000e50b02', 'exempt', 0, '123456782', 'חנות ב׳', 'הגפן', 'חיפה', 'exempt_dealer'),
  ('00000000-0000-0000-0000-000000e50a04', '00000000-0000-0000-0000-000000e50b04', 'exempt', 0, '000000018', 'קליניקה ד׳', 'הדקל', 'באר שבע', 'exempt_dealer');
insert into public.business_locations (id, business_id, name, kind, sort) values
  ('00000000-0000-0000-0000-000000e50c01', '00000000-0000-0000-0000-000000e50b01', 'סניף צפון', 'store', 1),
  ('00000000-0000-0000-0000-000000e50c04', '00000000-0000-0000-0000-000000e50b04', 'סניף דרום', 'clinic', 1);
update public.business_members set locations = array['00000000-0000-0000-0000-000000e50c04'::uuid]
 where business_id = '00000000-0000-0000-0000-000000e50b04' and user_id = '00000000-0000-0000-0000-000000e50a07';
insert into public.leads (id, user_id, business_id, name, phone) values
  ('00000000-0000-0000-0000-000000e50d01', '00000000-0000-0000-0000-000000e50a01', '00000000-0000-0000-0000-000000e50b01', 'דנה', '0501234567');
insert into public.catalog_items (id, user_id, business_id, name, price, kind, track_stock, stock_qty) values
  ('00000000-0000-0000-0000-000000e50f01', '00000000-0000-0000-0000-000000e50a01', '00000000-0000-0000-0000-000000e50b01', 'קרם', 100, 'product', true, 10),
  ('00000000-0000-0000-0000-000000e50f02', '00000000-0000-0000-0000-000000e50a01', '00000000-0000-0000-0000-000000e50b01', 'התקנה', 200, 'service', false, 0),
  ('00000000-0000-0000-0000-000000e50f03', '00000000-0000-0000-0000-000000e50a03', '00000000-0000-0000-0000-000000e50b02', 'חלוק', 80, 'product', false, 0);

-- ======================================================================================================================
-- 1. the switches: off until the owner turns them on; who turned them on is in the log
-- ======================================================================================================================
insert into public.business_finance_profile (business_id, user_id) values
  ('00000000-0000-0000-0000-000000e50b01', '00000000-0000-0000-0000-000000e50a01'), ('00000000-0000-0000-0000-000000e50b02', '00000000-0000-0000-0000-000000e50a03'),
  ('00000000-0000-0000-0000-000000e50b04', '00000000-0000-0000-0000-000000e50a04');
select pg_temp.check((select bool_and(not cash_drawers and not sells_products and cheque_remind_days = 3) from public.business_finance_profile
                       where business_id in ('00000000-0000-0000-0000-000000e50b01', '00000000-0000-0000-0000-000000e50b02', '00000000-0000-0000-0000-000000e50b04')),
  'the desks and the goods documents start off; a cheque is reminded 3 days before');
select pg_temp.refused_with($$update public.business_finance_profile set cheque_remind_days = 31 where business_id = '00000000-0000-0000-0000-000000e50b04'$$,
  'cheque_remind_days', 'a reminder at most 30 days before');
select pg_temp.refused_with($$select pg_temp.issue('00000000-0000-0000-0000-000000e50a01', 100, 'g-off', '{"customer_name": "דנה"}',
  '[{"item": "00000000-0000-0000-0000-000000e50f01", "name": "קרם", "qty": 1, "price": 100}]')$$, 'goods_off', 'no order before "selling products" is on');
update public.business_finance_profile set sells_products = true where business_id in ('00000000-0000-0000-0000-000000e50b01', '00000000-0000-0000-0000-000000e50b02');
select pg_temp.check((select count(*) from public.finance_audit_log where business_id = '00000000-0000-0000-0000-000000e50b01' and action = 'settings.finance_profile'
                        and details->>'sellsProducts' = 'true') = 1, 'turning on "selling products" is in the log of the business');
select pg_temp.check((select count(*) from public.finance_audit_log where business_id = '00000000-0000-0000-0000-000000e50b02' and action = 'settings.finance_profile'
                        and details ? 'sellsProducts') = 2, 'the log names the switches when the row is made and when they change');

-- ======================================================================================================================
-- 2. an order, a delivery note and a return note (shop CA, VAT)
-- ======================================================================================================================
-- a cashier never issues them (the register issues the sale's own document only)
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e50a02');
select pg_temp.refused_with($$select pg_temp.issue('00000000-0000-0000-0000-000000e50a02', 200, 'g-cashier', '{"customer_name": "דנה"}',
  '[{"name": "קרם", "qty": 1, "price": 100}]')$$, 'not allowed', 'a cashier issues no delivery note');
commit;

-- the order: a cream ×3 and an installation — no stock moves, a series of its own
select pg_temp.issue('00000000-0000-0000-0000-000000e50a01', 100, 'g-o1', '{"customer_name": "דנה", "lead_id": "00000000-0000-0000-0000-000000e50d01"}',
  '[{"item": "00000000-0000-0000-0000-000000e50f01", "name": "קרם", "qty": 3, "price": 100}, {"item": "00000000-0000-0000-0000-000000e50f02", "name": "התקנה", "qty": 1, "price": 200}]');
select pg_temp.check(pg_temp.num('g-o1') = '100-1', 'the first order is 100-1');
select pg_temp.check(pg_temp.cream() = 10 and not exists (select 1 from public.stock_movements where document_id = pg_temp.d('g-o1')), 'an order moves nothing');
select pg_temp.check((select vat_amount = 90 and total = 590 and payments = '[]'::jsonb and due_date is null from public.documents where id = pg_temp.d('g-o1')),
  'an order carries VAT as a tax invoice would, and no payments');
-- its delivery note: two creams go out (base: the order — fields 1256/1257)
select pg_temp.issue('00000000-0000-0000-0000-000000e50a01', 200, 'g-n1', '{"customer_name": "דנה", "lead_id": "00000000-0000-0000-0000-000000e50d01"}',
  '[{"item": "00000000-0000-0000-0000-000000e50f01", "name": "קרם", "qty": 2, "price": 100}]',
  p_extra => jsonb_build_object('base_doc_type', 100, 'base_doc_number', pg_temp.no('g-o1')));
select pg_temp.check(pg_temp.num('g-n1') = '200-1', 'the first delivery note is 200-1');
select pg_temp.check(pg_temp.cream() = 8, 'the delivery note took the two creams out');
select pg_temp.check((select count(*) = 1 and bool_and(reason = 'sale' and delta = -2 and note = '200-1') from public.stock_movements where document_id = pg_temp.d('g-n1')),
  'its move: a sale of 2, named 200-1');
-- a return note on it: one comes back; never more than left; only from a delivery note
select pg_temp.issue('00000000-0000-0000-0000-000000e50a01', 210, 'g-r1', '{"customer_name": "דנה"}',
  '[{"item": "00000000-0000-0000-0000-000000e50f01", "name": "קרם", "qty": 1, "price": 100}]',
  p_extra => jsonb_build_object('base_doc_type', 200, 'base_doc_number', pg_temp.no('g-n1')));
select pg_temp.check(pg_temp.num('g-r1') = '210-1' and pg_temp.cream() = 9, 'the return note 210-1 brought one back');
select pg_temp.check((select bool_and(reason = 'refund' and delta = 1) from public.stock_movements where document_id = pg_temp.d('g-r1')), 'its move: a return of 1');
select pg_temp.refused_with($$select pg_temp.issue('00000000-0000-0000-0000-000000e50a01', 210, 'g-r-over', '{"customer_name": "דנה"}',
  '[{"item": "00000000-0000-0000-0000-000000e50f01", "name": "קרם", "qty": 2, "price": 100}]',
  p_extra => jsonb_build_object('base_doc_type', 200, 'base_doc_number', pg_temp.no('g-n1')))$$, 'goods_over_delivery', 'two more back of two out, one back already');
select pg_temp.refused_with($$select pg_temp.issue('00000000-0000-0000-0000-000000e50a01', 210, 'g-r-free', '{"customer_name": "דנה"}',
  '[{"item": "00000000-0000-0000-0000-000000e50f01", "name": "קרם", "qty": 1, "price": 100}]')$$, 'goods_return_base', 'a return note stands on a delivery note');
select pg_temp.refused_with($$select pg_temp.issue('00000000-0000-0000-0000-000000e50a01', 210, 'g-r-order', '{"customer_name": "דנה"}',
  '[{"item": "00000000-0000-0000-0000-000000e50f01", "name": "קרם", "qty": 1, "price": 100}]',
  p_extra => jsonb_build_object('base_doc_type', 100, 'base_doc_number', pg_temp.no('g-o1')))$$, 'only a credit invoice points to a base document',
  'a return note is not made from an order');
select pg_temp.refused_with($$select pg_temp.issue('00000000-0000-0000-0000-000000e50a01', 300, 'g-300-305', '{"customer_name": "דנה"}',
  '[{"name": "שירות", "qty": 1, "price": 100}]', p_extra => '{"base_doc_type": 305, "base_doc_number": 1}')$$, 'only a credit invoice points to a base document',
  'an invoice is made from an order or a delivery note, not from an invoice');
-- the invoice in one click: what is left on the delivery note; nothing moves again; it is owed like any invoice
select pg_temp.issue('00000000-0000-0000-0000-000000e50a01', 305, 'g-i1', '{"customer_name": "דנה", "lead_id": "00000000-0000-0000-0000-000000e50d01"}',
  '[{"item": "00000000-0000-0000-0000-000000e50f01", "name": "קרם", "qty": 1, "price": 100}]',
  p_extra => jsonb_build_object('base_doc_type', 200, 'base_doc_number', pg_temp.no('g-n1')));
select pg_temp.check(pg_temp.cream() = 9 and not exists (select 1 from public.stock_movements where document_id = pg_temp.d('g-i1')),
  'the invoice made from the delivery note moved nothing (the note did)');
select pg_temp.check((select base_doc_type = 200 and base_doc_number = pg_temp.no('g-n1') from public.documents where id = pg_temp.d('g-i1')),
  'the invoice names its delivery note (fields 1256/1257 of the unified file)');
select pg_temp.check((select balance = 118 from public.receivables where id = pg_temp.d('g-i1')), 'it is owed: ₪118');
select pg_temp.refused_with($$select pg_temp.issue('00000000-0000-0000-0000-000000e50a01', 305, 'g-i1b', '{"customer_name": "דנה"}',
  '[{"name": "שירות", "qty": 1, "price": 10}]', p_extra => jsonb_build_object('base_doc_type', 200, 'base_doc_number', pg_temp.no('g-n1')))$$,
  'goods_invoiced', 'a delivery note is invoiced once');
select pg_temp.refused_with($$select pg_temp.issue('00000000-0000-0000-0000-000000e50a01', 210, 'g-r-late', '{"customer_name": "דנה"}',
  '[{"item": "00000000-0000-0000-0000-000000e50f01", "name": "קרם", "qty": 1, "price": 100}]',
  p_extra => jsonb_build_object('base_doc_type', 200, 'base_doc_number', pg_temp.no('g-n1')))$$,
  'goods_invoiced', 'after the invoice, goods come back on a credit invoice — not on a return note');
-- a delivery note of its own, invoiced with a receipt: never more of a product than it took out; a service and a free line are fine
select pg_temp.issue('00000000-0000-0000-0000-000000e50a01', 200, 'g-n2', '{"customer_name": "יוסי"}',
  '[{"item": "00000000-0000-0000-0000-000000e50f01", "name": "קרם", "qty": 1, "price": 100}]');
select pg_temp.check(pg_temp.num('g-n2') = '200-2' and pg_temp.cream() = 8, 'a delivery note with no order: 200-2, one cream out');
select pg_temp.refused_with($$select pg_temp.issue('00000000-0000-0000-0000-000000e50a01', 320, 'g-i2-over', '{"customer_name": "יוסי"}',
  '[{"item": "00000000-0000-0000-0000-000000e50f01", "name": "קרם", "qty": 2, "price": 100}]',
  p_extra => jsonb_build_object('base_doc_type', 200, 'base_doc_number', pg_temp.no('g-n2')))$$, 'goods_over_delivery', 'two creams on a note of one');
select pg_temp.issue('00000000-0000-0000-0000-000000e50a01', 320, 'g-i2', '{"customer_name": "יוסי"}',
  '[{"item": "00000000-0000-0000-0000-000000e50f01", "name": "קרם", "qty": 1, "price": 100}, {"item": "00000000-0000-0000-0000-000000e50f02", "name": "התקנה", "qty": 1, "price": 200},
    {"name": "משלוח", "qty": 1, "price": 30}]',
  p_extra => jsonb_build_object('base_doc_type', 200, 'base_doc_number', pg_temp.no('g-n2')));
select pg_temp.check(pg_temp.cream() = 8 and (select count(*) from public.payments where document_id = pg_temp.d('g-i2') and direction = 'in' and amount = 389.40) = 1,
  'the tax invoice-receipt made from it: nothing moved, ₪389.40 in the ledger');
-- a receipt paying an invoice is not made from a delivery note; a note that is not there; a cancelled note
select pg_temp.issue('00000000-0000-0000-0000-000000e50a01', 200, 'g-n3', '{"customer_name": "יוסי"}', '[{"name": "אריזה", "qty": 1, "price": 10}]');
select pg_temp.issue('00000000-0000-0000-0000-000000e50a01', 300, 'g-t1', '{"customer_name": "יוסי"}', '[{"name": "שירות", "qty": 1, "price": 10}]');
select pg_temp.refused_with($$select pg_temp.issue('00000000-0000-0000-0000-000000e50a01', 320, 'g-t1-pay', '{"customer_name": "יוסי"}',
  '[{"name": "שירות", "qty": 1, "price": 10}]', p_extra => jsonb_build_object('paid_document_id', pg_temp.d('g-t1'), 'base_doc_type', 200, 'base_doc_number', pg_temp.no('g-n3')))$$,
  'goods_base_receipt', 'a receipt for an invoice is not made from a delivery note');
select pg_temp.refused_with($$select pg_temp.issue('00000000-0000-0000-0000-000000e50a01', 305, 'g-i-none', '{"customer_name": "יוסי"}',
  '[{"name": "שירות", "qty": 1, "price": 10}]', p_extra => '{"base_doc_type": 200, "base_doc_number": 99}')$$, 'goods_base_missing', 'a delivery note that is not there');

-- cancelling: an order a note was made from stays; one without is cancelled; a delivery note's goods come back; nothing is made from
-- a cancelled note; a return note stays once its note was invoiced, else it is cancelled (its goods go out again)
select pg_temp.refused_with($$insert into public.document_cancellations (document_id, user_id, reason)
  values (pg_temp.d('g-o1'), '00000000-0000-0000-0000-000000e50a01', 'בטעות')$$, 'cancel_has_followers', 'the order its delivery note was made from');
select pg_temp.issue('00000000-0000-0000-0000-000000e50a01', 100, 'g-o2', '{"customer_name": "רונית"}', '[{"name": "הזמנה כללית", "qty": 1, "price": 50}]');
insert into public.document_cancellations (document_id, user_id, reason) values (pg_temp.d('g-o2'), '00000000-0000-0000-0000-000000e50a01', 'הלקוחה ביטלה');
select pg_temp.check(pg_temp.num('g-o2') = '100-2' and exists (select 1 from public.document_cancellations where document_id = pg_temp.d('g-o2')), 'an order with nothing made from it is cancelled');
select pg_temp.issue('00000000-0000-0000-0000-000000e50a01', 200, 'g-n4', '{"customer_name": "רונית"}', '[{"item": "00000000-0000-0000-0000-000000e50f01", "name": "קרם", "qty": 1, "price": 100}]');
select pg_temp.check(pg_temp.cream() = 7, 'the delivery note took one out');
insert into public.document_cancellations (document_id, user_id, reason) values (pg_temp.d('g-n4'), '00000000-0000-0000-0000-000000e50a01', 'הופקה בטעות');
select pg_temp.check(pg_temp.cream() = 8 and exists (select 1 from public.stock_movements where document_id = pg_temp.d('g-n4') and reason = 'cancel' and delta = 1),
  'cancelling the delivery note brought it back');
select pg_temp.refused_with($$select pg_temp.issue('00000000-0000-0000-0000-000000e50a01', 305, 'g-i4', '{"customer_name": "רונית"}',
  '[{"item": "00000000-0000-0000-0000-000000e50f01", "name": "קרם", "qty": 1, "price": 100}]',
  p_extra => jsonb_build_object('base_doc_type', 200, 'base_doc_number', pg_temp.no('g-n4')))$$, 'goods_base_cancelled', 'nothing is made from a cancelled note');
select pg_temp.refused_with($$insert into public.document_cancellations (document_id, user_id, reason)
  values (pg_temp.d('g-r1'), '00000000-0000-0000-0000-000000e50a01', 'בטעות')$$, 'cancel_has_followers', 'a return note whose delivery note was invoiced');
select pg_temp.issue('00000000-0000-0000-0000-000000e50a01', 200, 'g-n5', '{"customer_name": "רונית"}', '[{"item": "00000000-0000-0000-0000-000000e50f01", "name": "קרם", "qty": 2, "price": 100}]');
select pg_temp.issue('00000000-0000-0000-0000-000000e50a01', 210, 'g-r5', '{"customer_name": "רונית"}', '[{"item": "00000000-0000-0000-0000-000000e50f01", "name": "קרם", "qty": 1, "price": 100}]',
  p_extra => jsonb_build_object('base_doc_type', 200, 'base_doc_number', pg_temp.no('g-n5')));
select pg_temp.check(pg_temp.cream() = 7, 'two out, one back');
insert into public.document_cancellations (document_id, user_id, reason) values (pg_temp.d('g-r5'), '00000000-0000-0000-0000-000000e50a01', 'לא הוחזר בפועל');
select pg_temp.check(pg_temp.cream() = 6, 'the cancelled return note took it out again');
select pg_temp.issue('00000000-0000-0000-0000-000000e50a01', 305, 'g-i5', '{"customer_name": "רונית"}', '[{"item": "00000000-0000-0000-0000-000000e50f01", "name": "קרם", "qty": 2, "price": 100}]',
  p_extra => jsonb_build_object('base_doc_type', 200, 'base_doc_number', pg_temp.no('g-n5')));
select pg_temp.check(pg_temp.cream() = 6, 'the invoice of both (the return was cancelled) moved nothing');
select pg_temp.refused_with($$insert into public.document_cancellations (document_id, user_id, reason)
  values (pg_temp.d('g-i1'), '00000000-0000-0000-0000-000000e50a01', 'בטעות')$$, 'cancel_not_allowed', 'a tax invoice made from a note is corrected by a credit invoice, as any');
-- a credit invoice on the invoice made from a note brings the goods back (as on any invoice)
select pg_temp.issue('00000000-0000-0000-0000-000000e50a01', 330, 'g-c1', '{"customer_name": "דנה"}', '[]',
  p_extra => jsonb_build_object('amount', 100, 'base_doc_type', 305, 'base_doc_number', pg_temp.no('g-i1'),
    'lines', '[{"name": "קרם", "qty": 1, "unitPriceExVat": 100, "discountExVat": 0, "totalExVat": 100, "vatRate": 18, "kind": 1, "itemId": "00000000-0000-0000-0000-000000e50f01", "restock": true}]'::jsonb));
select pg_temp.check(pg_temp.cream() = 7, 'the credit invoice brought the cream back');
-- an order at the branch: its delivery note is the branch's
select pg_temp.issue('00000000-0000-0000-0000-000000e50a01', 100, 'g-o3', '{"customer_name": "צפון"}', '[{"name": "אריזת מתנה", "qty": 1, "price": 20}]',
  p_extra => '{"location_id": "00000000-0000-0000-0000-000000e50c01"}');
select pg_temp.issue('00000000-0000-0000-0000-000000e50a01', 200, 'g-n6', '{"customer_name": "צפון"}', '[{"name": "אריזת מתנה", "qty": 1, "price": 20}]',
  p_extra => jsonb_build_object('base_doc_type', 100, 'base_doc_number', pg_temp.no('g-o3')));
select pg_temp.check((select location_id = '00000000-0000-0000-0000-000000e50c01' from public.documents where id = pg_temp.d('g-n6')), 'a delivery note goes where its order is');
-- the series: one per type, one per business; the exempt shop issues them too, without VAT
select pg_temp.check((select string_agg(doc_type || ':' || n, ' ' order by doc_type) from (select doc_type, count(*) n from public.documents
                        where business_id = '00000000-0000-0000-0000-000000e50b01' and doc_type in (100, 200, 210) group by doc_type) x) = '100:3 200:6 210:2',
  'three orders, six delivery notes, two return notes');
select pg_temp.issue('00000000-0000-0000-0000-000000e50a03', 200, 'g-b1', '{"customer_name": "שירה"}',
  '[{"item": "00000000-0000-0000-0000-000000e50f03", "name": "חלוק", "qty": 1, "price": 80}]', p_vat => 0);
select pg_temp.check(pg_temp.num('g-b1') = '200-1' and (select vat_amount = 0 and total = 80 from public.documents where id = pg_temp.d('g-b1')),
  'the exempt shop: its own 200-1, no VAT');
select pg_temp.refused_with($$select pg_temp.issue('00000000-0000-0000-0000-000000e50a03', 305, 'g-b-305', '{"customer_name": "שירה"}',
  '[{"name": "חלוק", "qty": 1, "price": 80}]', p_vat => 0, p_extra => jsonb_build_object('base_doc_type', 200, 'base_doc_number', pg_temp.no('g-b1')))$$,
  'doc_type_not_allowed', 'an exempt dealer still issues no tax invoice');
select pg_temp.issue('00000000-0000-0000-0000-000000e50a03', 300, 'g-b-300', '{"customer_name": "שירה"}',
  '[{"item": "00000000-0000-0000-0000-000000e50f03", "name": "חלוק", "qty": 1, "price": 80}]', p_vat => 0,
  p_extra => jsonb_build_object('base_doc_type', 200, 'base_doc_number', pg_temp.no('g-b1')));
select pg_temp.check(pg_temp.num('g-b-300') = '300-1', 'it invoices its delivery note with a transaction invoice');
select pg_temp.refused_with($$select pg_temp.issue('00000000-0000-0000-0000-000000e50a03', 305, 'g-b-cross', '{"customer_name": "שירה"}',
  '[{"name": "x", "qty": 1, "price": 10}]', p_vat => 0, p_extra => jsonb_build_object('base_doc_type', 100, 'base_doc_number', pg_temp.no('g-o1')))$$,
  'doc_type_not_allowed', 'and nothing of another business');
select pg_temp.refused_with($$select pg_temp.issue('00000000-0000-0000-0000-000000e50a03', 300, 'g-b-cross2', '{"customer_name": "שירה"}',
  '[{"name": "x", "qty": 1, "price": 10}]', p_vat => 0, p_extra => '{"base_doc_type": 100, "base_doc_number": 3}')$$,
  'goods_base_missing', 'another business''s order number is not found here');
-- drafts: an order and a delivery note may wait as a draft; a return note never
insert into public.document_drafts (user_id, business_id, doc_type, customer_name, total, body)
values ('00000000-0000-0000-0000-000000e50a01', '00000000-0000-0000-0000-000000e50b01', 200, 'טיוטה', 10, '{}');
select pg_temp.refused_with($$insert into public.document_drafts (user_id, business_id, doc_type, customer_name, total, body)
  values ('00000000-0000-0000-0000-000000e50a01', '00000000-0000-0000-0000-000000e50b01', 210, 'טיוטה', 10, '{}')$$, 'document_drafts_doc_type_check', 'no draft of a return note');
-- the money: goods documents are not income
begin;
select pg_temp.as_user('00000000-0000-0000-0000-000000e50a01');
select pg_temp.check((public.finance_summary(public.il_today() - 1, public.il_today())->'revenue'->>'net')::numeric = 100 + 330 + 200 - 100,
  'the income: the tax invoices only (100 + 330 + 200 − the credited 100) — orders, notes and returns add nothing');
commit;

-- ======================================================================================================================
-- 3. the desks (clinic CD, an exempt dealer): the ledger by method — this month, the main location and the branch
-- ======================================================================================================================
select pg_temp.issue('00000000-0000-0000-0000-000000e50a04', 400, 'd-r1', '{"customer_name": "אורי"}', '[{"name": "טיפול", "qty": 1, "price": 590}]', p_vat => 0);
select pg_temp.issue('00000000-0000-0000-0000-000000e50a04', 400, 'd-r2', '{"customer_name": "בני"}', '[{"name": "טיפול", "qty": 1, "price": 1000}]', p_vat => 0,
  p_pay => jsonb_build_array(jsonb_build_object('m', 'cheque', 'amount', 1000, 'cheque', jsonb_build_object('number', '1001', 'bank', '12', 'branch', '600', 'dueDate', pg_temp.rday() + 2))));
select pg_temp.issue('00000000-0000-0000-0000-000000e50a04', 400, 'd-r3', '{"customer_name": "גלית"}', '[{"name": "טיפול", "qty": 1, "price": 500}]', p_vat => 0,
  p_pay => jsonb_build_array(jsonb_build_object('m', 'cheque', 'amount', 500, 'cheque', jsonb_build_object('number', '1002', 'bank', '10', 'dueDate', pg_temp.rday() + 20))));
select pg_temp.issue('00000000-0000-0000-0000-000000e50a04', 400, 'd-r4', '{"customer_name": "דורית"}', '[{"name": "טיפול", "qty": 1, "price": 300}]', p_vat => 0, p_pay => '[{"m": "card", "amount": 300}]');
select pg_temp.issue('00000000-0000-0000-0000-000000e50a04', 400, 'd-r5', '{"customer_name": "דנה"}', '[{"name": "טיפול", "qty": 1, "price": 236}]', p_vat => 0, p_pay => '[{"m": "transfer", "amount": 236}]');
select pg_temp.issue('00000000-0000-0000-0000-000000e50a04', 400, 'd-r6', '{"customer_name": "הדר"}', '[{"name": "טיפול", "qty": 1, "price": 118}]', p_vat => 0, p_pay => '[{"m": "bit", "amount": 118}]');
select pg_temp.issue('00000000-0000-0000-0000-000000e50a04', 400, 'd-r7', '{"customer_name": "ורד"}', '[{"name": "טיפול", "qty": 1, "price": 200}]', p_vat => 0,
  p_extra => '{"location_id": "00000000-0000-0000-0000-000000e50c04"}');
select pg_temp.issue('00000000-0000-0000-0000-000000e50a04', 400, 'd-r8', '{"customer_name": "זיו"}', '[{"name": "טיפול", "qty": 1, "price": 700}]', p_vat => 0,
  p_pay => jsonb_build_array(jsonb_build_object('m', 'cheque', 'amount', 700, 'cheque', jsonb_build_object('number', '2001', 'bank', '11', 'dueDate', pg_temp.rday() + 1))),
  p_extra => '{"location_id": "00000000-0000-0000-0000-000000e50c04"}');
select pg_temp.issue('00000000-0000-0000-0000-000000e50a04', 400, 'd-r9', '{"customer_name": "חנה"}', '[{"name": "טיפול", "qty": 1, "price": 300}]', p_vat => 0,
  p_pay => jsonb_build_array(jsonb_build_object('m', 'cheque', 'amount', 300, 'cheque', jsonb_build_object('number', '1003', 'bank', '12', 'dueDate', pg_temp.rday() + 2))));
insert into public.document_cancellations (document_id, user_id, reason) values (pg_temp.d('d-r9'), '00000000-0000-0000-0000-000000e50a04', 'הצ׳ק הוחזר ללקוחה');
insert into public.expenses (id, user_id, supplier_name, doc_date, supplier_doc_type, amount_before_vat, vat_amount, total, paid_on, payment_method) values
  ('00000000-0000-0000-0000-000000e50e71', '00000000-0000-0000-0000-000000e50a04', 'קפה למטופלים', public.il_today(), 'receipt', 118, 0, 118, public.il_today(), 'cash'),
  ('00000000-0000-0000-0000-000000e50e72', '00000000-0000-0000-0000-000000e50a04', 'ספק ציוד', public.il_today(), 'receipt', 354, 0, 354, public.il_today(), 'transfer'),
  ('00000000-0000-0000-0000-000000e50e73', '00000000-0000-0000-0000-000000e50a04', 'שכירות', public.il_today(), 'receipt', 1170, 0, 1170, public.il_today(), 'cheque');
create or replace function pg_temp.exp(p_id text) returns uuid language sql as $$ select id from public.payments where expense_id = p_id::uuid and source = 'expense' $$;

create temp table cash_out (who text, j jsonb);
grant all on cash_out to authenticated;
-- ids the signed-in roles may not read themselves (another business's payment)
create temp table pid (k text primary key, id uuid);
grant select on pid to authenticated;
insert into pid values ('ca-cash', pg_temp.pay('g-i2', 'cash'));
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e50a04');
insert into cash_out select 'od', public.cash_desks(public.il_today() - 30, public.il_today());
select public.location_select('00000000-0000-0000-0000-000000e50c04');
insert into cash_out select 'od:l2', public.cash_desks(public.il_today() - 30, public.il_today());
select public.location_select(null);
select pg_temp.as_user('00000000-0000-0000-0000-000000e50a07');
insert into cash_out select 'md', public.cash_desks(public.il_today() - 30, public.il_today());
select pg_temp.as_user('00000000-0000-0000-0000-000000e50a06');
insert into cash_out select 'vd', public.cash_desks(public.il_today() - 30, public.il_today());
select pg_temp.as_user('00000000-0000-0000-0000-000000e50a05');
select pg_temp.refused_with($$select public.cash_desks(public.il_today() - 30, public.il_today())$$, 'not allowed', 'a cashier sees no desks');
select pg_temp.as_user('00000000-0000-0000-0000-000000e50a04');
select pg_temp.refused_with($$select public.cash_desks(public.il_today(), public.il_today() - 1)$$, 'bad range', 'a period from after to before');
commit;
create or replace function pg_temp.r(p_who text) returns jsonb language sql as $$ select j from cash_out where who = p_who $$;
create or replace function pg_temp.m(p_j jsonb, p_method text, p_key text) returns numeric language sql as $$
  select (x->>p_key)::numeric from jsonb_array_elements(p_j->'methods') x where x->>'method' = p_method $$;
select pg_temp.check((select string_agg(x->>'method', ',' order by o) from jsonb_array_elements(pg_temp.r('od')->'methods') with ordinality y(x, o)) = 'cash,cheque,card,transfer,bit,other',
  'a desk for every method: cash, cheques, card, transfers, Bit and other');
select pg_temp.check(pg_temp.m(pg_temp.r('od'), 'cash', 'in') = 790 and pg_temp.m(pg_temp.r('od'), 'cash', 'out') = 118, 'cash: 590 + 200 in, the coffee 118 out');
select pg_temp.check(pg_temp.m(pg_temp.r('od'), 'cheque', 'in') = 2500 and pg_temp.m(pg_temp.r('od'), 'cheque', 'out') = 1470,
  'cheques: 1000 + 500 + 700 + 300 in; out the cancelled receipt''s 300 and the rent''s 1170');
select pg_temp.check(pg_temp.m(pg_temp.r('od'), 'card', 'in') = 300 and pg_temp.m(pg_temp.r('od'), 'transfer', 'in') = 236 and pg_temp.m(pg_temp.r('od'), 'transfer', 'out') = 354
                     and pg_temp.m(pg_temp.r('od'), 'bit', 'in') = 118 and pg_temp.m(pg_temp.r('od'), 'other', 'count') = 0, 'card, transfers, Bit, other');
select pg_temp.check((pg_temp.r('od')->>'cash')::numeric = 672, 'the cash desk holds 672 (790 − 118)');
select pg_temp.check(pg_temp.r('od')->'cheques' = '{"count": 3, "total": 2200, "dueCount": 2, "dueTotal": 1700}'::jsonb,
  'three cheques in the drawer (the cancelled receipt''s is not), two due within 3 days');
select pg_temp.check((pg_temp.r('od')->'deposits'->>'count')::int = 0 and (pg_temp.r('od')->>'remindDays')::int = 3, 'no deposit yet; reminded 3 days before');
select pg_temp.check((pg_temp.r('md')->>'cash')::numeric = 200 and (pg_temp.r('md')->'cheques'->>'count')::int = 1 and pg_temp.m(pg_temp.r('md'), 'cash', 'in') = 200,
  'the manager of the branch: the branch''s desk only');
select pg_temp.check(pg_temp.r('od:l2') = pg_temp.r('md'), 'the owner with the branch picked at the top sees what its manager sees');
select pg_temp.check(pg_temp.r('vd') = pg_temp.r('od'), 'the viewer reads the desks');

-- ======================================================================================================================
-- 4. deposits: cash (never more than the desk holds) and chosen cheques of one location; a deposited cheque leaves the drawer
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e50a04');
select pg_temp.check((public.bank_deposit_create('00000000-0000-0000-0000-000000e50e01', public.il_today(), null, 400, array[pg_temp.pay('d-r2', 'cheque')], 'סניף הבנק ברחוב הדקל')
                      = '{"id": "00000000-0000-0000-0000-000000e50e01", "number": 1, "created": true}'::jsonb), 'the first deposit: 400 in cash and a cheque of 1000');
select pg_temp.check((public.bank_deposit_create('00000000-0000-0000-0000-000000e50e01', public.il_today(), null, 999, '{}', '')->>'created')::boolean = false,
  'the same id again is the same deposit (a second tap)');
select pg_temp.refused_with($$select public.bank_deposit_create('00000000-0000-0000-0000-000000e50e09', public.il_today(), null, 100, '{}', '')$$,
  'deposit_cash_over: the cash desk holds 72', 'never more cash than the desk holds (472 − 400)');
select pg_temp.refused_with($$select public.bank_deposit_create('00000000-0000-0000-0000-000000e50e09', public.il_today(), null, 0, array[pg_temp.pay('d-r2', 'cheque')], '')$$,
  'deposit_cheque_taken', 'a cheque deposited already');
select pg_temp.refused_with($$select public.bank_deposit_create('00000000-0000-0000-0000-000000e50e09', public.il_today(), null, 0, array[pg_temp.pay('d-r8', 'cheque')], '')$$,
  'deposit_cheque_location', 'a cheque of the branch in a deposit of the main location');
select pg_temp.refused_with($$select public.bank_deposit_create('00000000-0000-0000-0000-000000e50e09', public.il_today(), null, 0, array[pg_temp.pay('d-r9', 'cheque')], '')$$,
  'deposit_cheque_taken', 'the cheque of a cancelled receipt');
select pg_temp.refused_with($$select public.bank_deposit_create('00000000-0000-0000-0000-000000e50e09', public.il_today(), null, 0, array[pg_temp.pay('d-r4', 'card')], '')$$,
  'deposit_cheque:', 'a card payment is not a cheque');
select pg_temp.refused_with($$select public.bank_deposit_create('00000000-0000-0000-0000-000000e50e09', public.il_today(), null, 0, array[(select id from pid where k = 'ca-cash')], '')$$,
  'deposit_cheque:', 'nothing of another business');
select pg_temp.refused_with($$select public.bank_deposit_create('00000000-0000-0000-0000-000000e50e09', public.il_today(), null, 0, '{}', '')$$, 'deposit_empty', 'an empty deposit');
select pg_temp.refused_with($$select public.bank_deposit_create('00000000-0000-0000-0000-000000e50e09', public.il_today() + 1, null, 10, '{}', '')$$, 'deposit_date', 'a deposit of tomorrow');
select pg_temp.refused_with($$select public.bank_deposit_create('00000000-0000-0000-0000-000000e50e09', public.il_today(), null, 10.555, '{}', '')$$, 'deposit_cash', 'agorot only');
select pg_temp.refused_with($$select public.bank_deposit_create(null, public.il_today(), null, 10, '{}', '')$$, 'deposit_id', 'a deposit has an id');
select pg_temp.as_user('00000000-0000-0000-0000-000000e50a07');
select pg_temp.refused_with($$select public.bank_deposit_create('00000000-0000-0000-0000-000000e50e09', public.il_today(), '00000000-0000-0000-0000-000000e50b04', 10, '{}', '')$$,
  'not allowed: this location is not yours', 'the manager of the branch does not deposit for the main location');
select pg_temp.check((public.bank_deposit_create('00000000-0000-0000-0000-000000e50e02', public.il_today(), null, 200, array[pg_temp.pay('d-r8', 'cheque')], '')->>'number')::int = 2,
  'the manager deposits the branch''s cash and cheque (the location they work in)');
select pg_temp.as_user('00000000-0000-0000-0000-000000e50a06');
select pg_temp.refused_with($$select public.bank_deposit_create('00000000-0000-0000-0000-000000e50e09', public.il_today(), null, 10, '{}', '')$$, 'not allowed', 'a viewer deposits nothing');
select pg_temp.as_user('00000000-0000-0000-0000-000000e50a05');
select pg_temp.refused_with($$select public.bank_deposit_create('00000000-0000-0000-0000-000000e50e09', public.il_today(), null, 10, '{}', '')$$, 'not allowed', 'nor a cashier');
select pg_temp.as_user('00000000-0000-0000-0000-000000e50a04');
insert into cash_out select 'chq', public.cheque_book(public.il_today() - 30, public.il_today());
insert into cash_out select 'deps', public.deposit_book(public.il_today() - 30, public.il_today());
insert into cash_out select 'od2', public.cash_desks(public.il_today() - 30, public.il_today());
select pg_temp.as_user('00000000-0000-0000-0000-000000e50a07');
insert into cash_out select 'md:deps', public.deposit_book(public.il_today() - 30, public.il_today());
commit;
select pg_temp.check((select string_agg(x->>'number' || ':' || (x->>'amount')::numeric::int, ',') from jsonb_array_elements(pg_temp.r('chq')->'drawer') x) = '1002:500',
  'in the drawer: the cheque of 500 only');
select pg_temp.check((select string_agg(x->>'number' || ':' || (x->'deposit'->>'number'), ',' order by x->'deposit'->>'number') from jsonb_array_elements(pg_temp.r('chq')->'deposited') x)
                     = '1001:1,2001:2', 'the cheques deposited, each with its deposit');
select pg_temp.check((select x->>'customer' = 'בני' and x->>'bank' = '12' and x->>'branch' = '600' and (x->>'dueDate')::date = pg_temp.rday() + 2 and (x->>'docType')::int = 400
                        from jsonb_array_elements(pg_temp.r('chq')->'deposited') x where x->>'number' = '1001'), 'a cheque names its customer, bank, branch, due date and receipt');
select pg_temp.check((select string_agg((x->>'number') || ':' || (x->>'total')::numeric::int || ':' || jsonb_array_length(x->'items'), ',') from jsonb_array_elements(pg_temp.r('deps')) x)
                     = '2:900:1,1:1400:1', 'two deposits: 900 (200 + a cheque) and 1400 (400 + a cheque)');
select pg_temp.check((pg_temp.r('od2')->>'cash')::numeric = 72 and pg_temp.r('od2')->'cheques'->>'count' = '1' and pg_temp.r('od2')->'deposits' = '{"count": 2, "total": 2300}'::jsonb,
  'after them: 72 in the desk, one cheque in the drawer, two deposits of 2300');
select pg_temp.check(jsonb_array_length(pg_temp.r('md:deps')) = 1, 'the manager of the branch sees the branch''s deposit only');
-- a deposit recorded by mistake is cancelled with a reason: the cash and the cheque come back; the same cheque is deposited again
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e50a07');
select pg_temp.refused_with($$select public.bank_deposit_cancel('00000000-0000-0000-0000-000000e50e01', 'בטעות')$$, 'not allowed: this location is not yours',
  'the manager of the branch cancels nothing of the main location');
select pg_temp.as_user('00000000-0000-0000-0000-000000e50a04');
select pg_temp.refused_with($$select public.bank_deposit_cancel('00000000-0000-0000-0000-000000e50e02', ' ')$$, 'reason_required', 'a cancel says why');
select pg_temp.check(public.bank_deposit_cancel('00000000-0000-0000-0000-000000e50e01', 'נרשם פעמיים')->>'result' = 'cancelled', 'the first deposit is cancelled');
select pg_temp.check(public.bank_deposit_cancel('00000000-0000-0000-0000-000000e50e01', 'נרשם פעמיים')->>'result' = 'already', 'a second cancel changes nothing');
insert into cash_out select 'od3', public.cash_desks(public.il_today() - 30, public.il_today());
select pg_temp.check((public.bank_deposit_create('00000000-0000-0000-0000-000000e50e03', public.il_today(), null, 472, array[pg_temp.pay('d-r2', 'cheque')], '')->>'number')::int = 3,
  'all the cash and the cheque again: deposit 3');
insert into cash_out select 'od4', public.cash_desks(public.il_today() - 30, public.il_today());
select pg_temp.check((select count(*) from public.bank_deposits) = 3, 'the owner reads the three deposits');
select pg_temp.refused_with($$insert into public.bank_deposits (id, business_id, location_id, number, deposited_on, cash)
  values (gen_random_uuid(), '00000000-0000-0000-0000-000000e50b04', '00000000-0000-0000-0000-000000e50b04', 9, public.il_today(), 1)$$, 'permission denied',
  'a deposit is written by its function only');
select pg_temp.as_user('00000000-0000-0000-0000-000000e50a07');
select pg_temp.check((select count(*) from public.bank_deposits) = 1 and (select count(*) from public.bank_deposit_cheques) = 1, 'the manager reads the branch''s deposit and its cheque');
select pg_temp.as_user('00000000-0000-0000-0000-000000e50a05');
select pg_temp.check((select count(*) from public.bank_deposits) = 0, 'a cashier reads none');
commit;
select pg_temp.check((pg_temp.r('od3')->>'cash')::numeric = 472 and (pg_temp.r('od3')->'cheques'->>'count')::int = 2, 'the cancel put back the 400 and the cheque');
select pg_temp.check((pg_temp.r('od4')->>'cash')::numeric = 0 and (pg_temp.r('od4')->'cheques'->>'count')::int = 1, 'deposit 3 took them');
select pg_temp.check((select count(*) filter (where action = 'deposit.created') = 3 and count(*) filter (where action = 'deposit.cancelled') = 1
                        from public.finance_audit_log where business_id = '00000000-0000-0000-0000-000000e50b04'), 'every deposit and its cancel are in the log');

-- ======================================================================================================================
-- 5. a cheque is reminded once before it is due — by the timer, on working hours, only when the desks are on
-- ======================================================================================================================
select pg_temp.issue('00000000-0000-0000-0000-000000e50a04', 400, 'd-r11', '{"customer_name": "טל"}', '[{"name": "טיפול", "qty": 1, "price": 250}]', p_vat => 0,
  p_pay => jsonb_build_array(jsonb_build_object('m', 'cheque', 'amount', 250, 'cheque', jsonb_build_object('number', '1004', 'dueDate', pg_temp.rday() + 3))));
select pg_temp.issue('00000000-0000-0000-0000-000000e50a04', 400, 'd-r12', '{"customer_name": "יעל"}', '[{"name": "טיפול", "qty": 1, "price": 80}]', p_vat => 0,
  p_pay => jsonb_build_array(jsonb_build_object('m', 'cheque', 'amount', 80, 'cheque', jsonb_build_object('number', '1005', 'dueDate', pg_temp.rday() - 5))));
select pg_temp.issue('00000000-0000-0000-0000-000000e50a04', 400, 'd-r10', '{"customer_name": "כרמל"}', '[{"name": "טיפול", "qty": 1, "price": 90}]', p_vat => 0,
  p_pay => jsonb_build_array(jsonb_build_object('m', 'cheque', 'amount', 90, 'cheque', jsonb_build_object('number', '1007', 'dueDate', pg_temp.rday() - 40))));
select pg_temp.check(not exists (select 1 from jsonb_array_elements(public.cheque_reminders_claim(100, pg_temp.at(pg_temp.rday(), '10:00'))) x
                                  where x->>'business' = '00000000-0000-0000-0000-000000e50b04'), 'the desks are off: no reminder');
update public.business_finance_profile set cash_drawers = true where business_id = '00000000-0000-0000-0000-000000e50b04';
create temp table rem (n int, j jsonb);
insert into rem select 1, public.cheque_reminders_claim(100, pg_temp.at(pg_temp.rday(), '10:00'));
select pg_temp.check((select jsonb_array_length(j) = 1 and j->0->>'business' = '00000000-0000-0000-0000-000000e50b04' and (j->0->>'count')::int = 2
                             and (j->0->>'total')::numeric = 330 and (j->0->>'firstDue')::date = pg_temp.rday() - 5 from rem where n = 1),
  'the desks on: the cheque due in 3 days and the one overdue for 5 (not the one 40 days late, not those deposited or far ahead)');
select pg_temp.check((select string_agg(x->>'number', ',' order by o) from rem, jsonb_array_elements(j->0->'cheques') with ordinality y(x, o) where n = 1) = '1005,1004',
  'by due date, each with its number');
select pg_temp.check(public.cheque_reminders_claim(100, pg_temp.at(pg_temp.rday(), '10:05')) = '[]'::jsonb, 'each cheque once');
select pg_temp.issue('00000000-0000-0000-0000-000000e50a04', 400, 'd-r13', '{"customer_name": "לאה"}', '[{"name": "טיפול", "qty": 1, "price": 60}]', p_vat => 0,
  p_pay => jsonb_build_array(jsonb_build_object('m', 'cheque', 'amount', 60, 'cheque', jsonb_build_object('number', '1006', 'dueDate', pg_temp.rday() + 1))));
select pg_temp.check(public.cheque_reminders_claim(100, pg_temp.at((date_trunc('week', pg_temp.rday()::timestamp) + interval '5 days')::date, '10:00')) = '[]'::jsonb,
  'not on Saturday');
select pg_temp.check(public.cheque_reminders_claim(100, pg_temp.at(pg_temp.rday(), '20:30')) = '[]'::jsonb
                     and public.cheque_reminders_claim(100, pg_temp.at(pg_temp.rday(), '07:30')) = '[]'::jsonb, 'not before 08:00 or after 20:00');
update public.business_finance_profile set cheque_remind_days = 0 where business_id = '00000000-0000-0000-0000-000000e50b04';
select pg_temp.check(public.cheque_reminders_claim(100, pg_temp.at(pg_temp.rday(), '11:00')) = '[]'::jsonb, '0 days: never reminded');
update public.business_finance_profile set cheque_remind_days = 3 where business_id = '00000000-0000-0000-0000-000000e50b04';
select pg_temp.check((public.cheque_reminders_claim(100, pg_temp.at(pg_temp.rday(), '11:00'))->0->>'count')::int = 1, 'back to 3 days: the new cheque');
select pg_temp.check((select count(*) from public.cheque_reminders where business_id = '00000000-0000-0000-0000-000000e50b04') = 3, 'three cheques reminded, once each');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e50a04');
select pg_temp.refused_with($$select public.cheque_reminders_claim(100, now())$$, 'permission denied', 'only the timer claims the reminders');
select pg_temp.refused_with($$select count(*) from public.cheque_reminders$$, 'permission denied', 'and only it reads them');
commit;

-- ======================================================================================================================
-- 6. the bank: a file of lines (each kept once), suggestions approved one by one, "לטיפול" until matched or handled
-- ======================================================================================================================
create or replace function pg_temp.bl(p_day int, p_amount numeric, p_text text, p_ref text default '') returns jsonb language sql as $$
  select jsonb_build_object('date', public.il_today() + p_day, 'amount', p_amount, 'description', p_text, 'reference', p_ref) $$;
create or replace function pg_temp.line(p_text text) returns uuid language sql as $$
  select id from public.bank_lines where business_id = '00000000-0000-0000-0000-000000e50b04' and description = p_text order by created_at, id limit 1 $$;
create or replace function pg_temp.dep(p_id text) returns uuid language sql as $$ select p_id::uuid $$;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e50a04');
select pg_temp.check(public.bank_import('00000000-0000-0000-0000-000000e50e11', 'לאומי 800-12345', 'תנועות-אוקטובר.csv', jsonb_build_array(
    pg_temp.bl(-3, 236, 'העברה מדנה', '111'), pg_temp.bl(-2, 418, 'ביט ואשראי'), pg_temp.bl(-1, 1472, 'הפקדת מזומן וצ׳ק'), pg_temp.bl(-1, -354, 'העברה לספק'),
    pg_temp.bl(0, -12.5, 'עמלת ניהול'), pg_temp.bl(0, -10, 'עמלת שורה'), pg_temp.bl(0, -10, 'עמלת שורה'), pg_temp.bl(0, 900, 'הפקדה'),
    pg_temp.bl(0, 500, 'צ׳ק 1002'), pg_temp.bl(0, 236, 'העברה נוספת', '222')))
  = '{"id": "00000000-0000-0000-0000-000000e50e11", "total": 10, "added": 10, "created": true}'::jsonb, 'a file of 10 lines: all new (the two same fees too)');
select pg_temp.check((public.bank_import('00000000-0000-0000-0000-000000e50e11', 'x', 'x', '[]')->>'created')::boolean = false, 'the same id again is the same import');
select pg_temp.check((public.bank_import('00000000-0000-0000-0000-000000e50e12', 'לאומי 800-12345', 'תנועות-2.csv', jsonb_build_array(
    pg_temp.bl(-3, 236, 'העברה  מדנה', '111'), pg_temp.bl(0, -10, 'עמלת שורה'), pg_temp.bl(0, -10, 'עמלת שורה'), pg_temp.bl(0, 80, 'צ׳ק 1005')))->>'added')::int = 1,
  'a file that overlaps the last: only the new line (spaces aside, the same text is the same line)');
select pg_temp.check((public.bank_import('00000000-0000-0000-0000-000000e50e13', 'לאומי 800-12345', 'תנועות-3.csv', jsonb_build_array(
    pg_temp.bl(0, -10, 'עמלת שורה'), pg_temp.bl(0, -10, 'עמלת שורה'), pg_temp.bl(0, -10, 'עמלת שורה')))->>'added')::int = 1, 'a third fee of the same kind is a new line');
select pg_temp.refused_with($$select public.bank_import('00000000-0000-0000-0000-000000e50e14', '', 'x.csv', jsonb_build_array(pg_temp.bl(0, 0, 'אפס')))$$, 'bank_lines',
  'a line of zero');
select pg_temp.refused_with($$select public.bank_import('00000000-0000-0000-0000-000000e50e14', '', 'x.csv', '[{"date": "2026-02-30", "amount": 5}]')$$, 'bank_lines',
  'a day that is not a day');
select pg_temp.refused_with($$select public.bank_import('00000000-0000-0000-0000-000000e50e14', '', 'x.csv', '[{"date": "2026-02-01", "amount": 5.555}]')$$, 'bank_lines',
  'agorot only');
select pg_temp.refused_with($$select public.bank_import('00000000-0000-0000-0000-000000e50e14', '', 'x.csv', '{"date": "2026-02-01"}')$$, 'bank_lines: a list', 'not a list');
select pg_temp.refused_with($$select public.bank_import('00000000-0000-0000-0000-000000e50e14', '', 'x.csv',
  (select jsonb_agg(pg_temp.bl(0, g, 'שורה')) from generate_series(1, 5001) g))$$, '1 to 5,000', 'at most 5,000 lines');
select pg_temp.check(not exists (select 1 from public.bank_statements where id = '00000000-0000-0000-0000-000000e50e14'), 'a refused file leaves nothing');
insert into cash_out select 'cand', public.bank_candidates(public.il_today() - 30, public.il_today());
commit;
select pg_temp.check((select count(*) from public.bank_lines where business_id = '00000000-0000-0000-0000-000000e50b04') = 12
                     and (select count(*) from public.bank_lines where business_id = '00000000-0000-0000-0000-000000e50b04' and description = 'עמלת שורה') = 3
                     and (select bool_and(status = 'open') from public.bank_lines where business_id = '00000000-0000-0000-0000-000000e50b04'), '12 lines, all "לטיפול"');
select pg_temp.check((select array_agg(x->>'id' order by x->>'id') from jsonb_array_elements(pg_temp.r('cand')->'payments') x)
                     = (select array_agg(i::text order by i::text) from unnest(array[pg_temp.pay('d-r3', 'cheque'), pg_temp.pay('d-r4', 'card'), pg_temp.pay('d-r5', 'transfer'),
                          pg_temp.pay('d-r6', 'bit'), pg_temp.pay('d-r10', 'cheque'), pg_temp.pay('d-r11', 'cheque'), pg_temp.pay('d-r12', 'cheque'), pg_temp.pay('d-r13', 'cheque'),
                          pg_temp.exp('00000000-0000-0000-0000-000000e50e72'), pg_temp.exp('00000000-0000-0000-0000-000000e50e73')]) i),
  'what the bank may meet: card, transfers, Bit, cheques in the drawer and paid by cheque — not cash, not deposited cheques, not a cancelled receipt');
select pg_temp.check((select string_agg(x->>'number', ',' order by x->>'number') from jsonb_array_elements(pg_temp.r('cand')->'deposits') x) = '2,3', 'and the two active deposits');
select pg_temp.check((select x->>'docType' = '400' and x->>'customer' = 'דנה' and x->>'method' = 'transfer' from jsonb_array_elements(pg_temp.r('cand')->'payments') x
                       where x->>'id' = pg_temp.pay('d-r5', 'transfer')::text), 'a candidate names its receipt and customer');
select pg_temp.check((select x->>'supplier' = 'ספק ציוד' and x->>'direction' = 'out' from jsonb_array_elements(pg_temp.r('cand')->'payments') x
                       where x->>'id' = pg_temp.exp('00000000-0000-0000-0000-000000e50e72')::text), 'a payment out names its supplier');
create temp table bid (k text primary key, id uuid);
grant select on bid to authenticated;
insert into bid select 'ca-cash', pg_temp.pay('g-i2', 'cash');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e50a04');
select pg_temp.check((public.bank_match(pg_temp.line('העברה מדנה'), array[pg_temp.pay('d-r5', 'transfer')])->>'items')::int = 1, 'approved: the transfer of 236');
select pg_temp.refused_with($$select public.bank_match(pg_temp.line('העברה נוספת'), array[pg_temp.pay('d-r5', 'transfer')])$$, 'bank_match_taken', 'a receipt meets one line');
select pg_temp.refused_with($$select public.bank_match(pg_temp.line('ביט ואשראי'), array[pg_temp.pay('d-r6', 'bit')])$$, 'bank_match_sum: the chosen add up to 118.00 but the line is 418.00',
  'to the agora');
select pg_temp.check((public.bank_match(pg_temp.line('ביט ואשראי'), array[pg_temp.pay('d-r6', 'bit'), pg_temp.pay('d-r4', 'card')])->>'items')::int = 2, 'one line, two receipts');
select pg_temp.refused_with($$select public.bank_match(pg_temp.line('העברה לספק'), array[pg_temp.pay('d-r11', 'cheque')])$$, 'bank_match_sign', 'money in on a line of money out');
select pg_temp.refused_with($$select public.bank_match(pg_temp.line('העברה לספק'), '{}', array['00000000-0000-0000-0000-000000e50e02'::uuid])$$, 'bank_match_sign', 'a deposit on money out');
select pg_temp.check((public.bank_match(pg_temp.line('העברה לספק'), array[pg_temp.exp('00000000-0000-0000-0000-000000e50e72')])->>'items')::int = 1, 'the supplier''s transfer');
select pg_temp.refused_with($$select public.bank_match(pg_temp.line('הפקדה'), array[pg_temp.pay('d-r8', 'cheque'), pg_temp.pay('d-r7', 'cash')])$$, 'bank_match_item',
  'a deposited cheque and cash meet the bank in their deposit');
select pg_temp.check((public.bank_match(pg_temp.line('הפקדה'), '{}', array['00000000-0000-0000-0000-000000e50e02'::uuid])->>'items')::int = 1, 'the branch''s deposit');
select pg_temp.check((public.bank_match(pg_temp.line('הפקדת מזומן וצ׳ק'), '{}', array['00000000-0000-0000-0000-000000e50e03'::uuid])->>'items')::int = 1, 'deposit 3');
select pg_temp.refused_with($$select public.bank_deposit_cancel('00000000-0000-0000-0000-000000e50e03', 'בטעות')$$, 'deposit_matched', 'a matched deposit is not cancelled');
select pg_temp.refused_with($$select public.bank_match(pg_temp.line('צ׳ק 1005'), '{}', array['00000000-0000-0000-0000-000000e50e01'::uuid])$$, 'a cancelled deposit',
  'a cancelled deposit meets nothing');
select pg_temp.check((public.bank_match(pg_temp.line('צ׳ק 1002'), array[pg_temp.pay('d-r3', 'cheque')])->>'items')::int = 1, 'a cheque met the bank on its own');
select pg_temp.refused_with($$select public.bank_match(pg_temp.line('העברה מדנה'), array[pg_temp.pay('d-r5', 'transfer')])$$, 'bank_line_closed', 'a matched line');
select pg_temp.refused_with($$select public.bank_unmatch(pg_temp.line('העברה מדנה'), '')$$, 'reason_required', 'an undo says why');
select pg_temp.check((public.bank_unmatch(pg_temp.line('העברה מדנה'), 'אושר בטעות')->>'undone')::int = 1, 'the match is undone');
select pg_temp.check((public.bank_match(pg_temp.line('העברה מדנה'), array[pg_temp.pay('d-r5', 'transfer')])->>'items')::int = 1, 'and approved again');
select pg_temp.refused_with($$select public.bank_unmatch(pg_temp.line('עמלת ניהול'), 'x y')$$, 'bank_line_not_matched', 'an open line has nothing to undo');
select pg_temp.check(public.bank_line_handle(pg_temp.line('עמלת ניהול'), 'עמלת בנק חודשית')->>'status' = 'handled', 'a bank fee is marked handled, with a note');
select pg_temp.refused_with($$select public.bank_line_handle(pg_temp.line('עמלת ניהול'), 'שוב')$$, 'bank_line_closed', 'once');
select pg_temp.check(public.bank_line_reopen(pg_temp.line('עמלת ניהול'))->>'status' = 'open', 'back to "לטיפול"');
select pg_temp.refused_with($$select public.bank_line_reopen(pg_temp.line('עמלת ניהול'))$$, 'bank_line_not_handled', 'an open line is not reopened');
select pg_temp.refused_with($$select public.bank_line_handle(pg_temp.line('עמלת ניהול'), ' ')$$, 'reason_required', 'handled says why');
select pg_temp.check(public.bank_line_handle(pg_temp.line('עמלת ניהול'), 'עמלת בנק חודשית')->>'status' = 'handled', 'handled again');
select pg_temp.refused_with($$select public.bank_match(pg_temp.line('צ׳ק 1005'), '{}', '{}')$$, 'bank_match_items', 'nothing chosen');
select pg_temp.refused_with($$select public.bank_match(pg_temp.line('צ׳ק 1005'), (select array_agg(gen_random_uuid()) from generate_series(1, 51)))$$, 'bank_match_items',
  'at most 50 at once');
select pg_temp.refused_with($$select public.bank_match(pg_temp.line('צ׳ק 1005'), array[(select id from bid where k = 'ca-cash')])$$, 'not allowed', 'nothing of another business');
insert into cash_out select 'book', public.bank_book(public.il_today() - 30, public.il_today());
insert into cash_out select 'od5', public.cash_desks(public.il_today() - 30, public.il_today());
select pg_temp.refused_with($$update public.bank_lines set status = 'matched' where id = pg_temp.line('צ׳ק 1005')$$, 'permission denied', 'a line changes by the functions only');
select pg_temp.as_user('00000000-0000-0000-0000-000000e50a06');
insert into cash_out select 'vd:book', public.bank_book(public.il_today() - 30, public.il_today());
select pg_temp.refused_with($$select public.bank_match(pg_temp.line('צ׳ק 1005'), array[pg_temp.pay('d-r12', 'cheque')])$$, 'not allowed', 'a viewer approves nothing');
select pg_temp.as_user('00000000-0000-0000-0000-000000e50a07');
select pg_temp.refused_with($$select public.bank_book(public.il_today() - 30, public.il_today())$$, 'the bank is the whole business', 'a manager of one branch does not see the bank');
select pg_temp.check((select count(*) from public.bank_lines) = 0 and (select count(*) from public.bank_matches) = 0, 'not even by reading the tables');
select pg_temp.as_user('00000000-0000-0000-0000-000000e50a05');
select pg_temp.refused_with($$select public.bank_book(public.il_today() - 30, public.il_today())$$, 'not allowed', 'nor a cashier');
select pg_temp.as_user('00000000-0000-0000-0000-000000e50a03');
select pg_temp.refused_with($$select public.bank_match('00000000-0000-0000-0000-000000e50e11', '{}', '{}')$$, 'not allowed', 'another business');
commit;
begin;
set local role anon;
select pg_temp.refused_with($$select public.bank_book(public.il_today() - 30, public.il_today())$$, 'permission denied', 'nobody signed out');
commit;
select pg_temp.check(pg_temp.r('vd:book') = pg_temp.r('book'), 'the viewer reads the bank as the owner does');
select pg_temp.check((select count(*) from jsonb_array_elements(pg_temp.r('book')->'lines') x where x->>'status' = 'matched') = 6
                     and (select count(*) from jsonb_array_elements(pg_temp.r('book')->'lines') x where x->>'status' = 'handled') = 1
                     and jsonb_array_length(pg_temp.r('book')->'lines') = 12 and jsonb_array_length(pg_temp.r('book')->'statements') = 3,
  'the book: 12 lines — 6 matched, 1 handled, 5 "לטיפול"; three files');
select pg_temp.check((select jsonb_array_length(x->'matches') = 2 from jsonb_array_elements(pg_temp.r('book')->'lines') x where x->>'description' = 'ביט ואשראי')
                     and (select x->'matches'->0->'deposit'->>'number' = '3' from jsonb_array_elements(pg_temp.r('book')->'lines') x where x->>'description' = 'הפקדת מזומן וצ׳ק')
                     and (select x->>'note' = 'עמלת בנק חודשית' from jsonb_array_elements(pg_temp.r('book')->'lines') x where x->>'description' = 'עמלת ניהול'),
  'a line shows what it met, or the note it was handled with');
select pg_temp.check((select count(*) from public.bank_matches where bank_line_id = pg_temp.line('העברה מדנה')) = 2
                     and (select count(*) from public.bank_matches where bank_line_id = pg_temp.line('העברה מדנה') and not active and undo_reason = 'אושר בטעות') = 1,
  'the undone match stays in the history, with its reason');
select pg_temp.check((pg_temp.r('od5')->'cheques'->>'count')::int = 4 and (pg_temp.r('od5')->'cheques'->>'total')::numeric = 480,
  'the cheque met the bank on its own left the drawer: 250 + 80 + 90 + 60 remain');
select pg_temp.refused_with($$delete from public.bank_lines where id = pg_temp.line('עמלת שורה')$$, 'append-only', 'a line is never removed');
select pg_temp.check((select count(*) filter (where action = 'bank.imported') = 3 and count(*) filter (where action = 'bank.matched') = 7
                             and count(*) filter (where action = 'bank.unmatched') = 1 and count(*) filter (where action = 'bank.handled') = 2
                             and count(*) filter (where action = 'bank.reopened') = 1
                        from public.finance_audit_log where business_id = '00000000-0000-0000-0000-000000e50b04'), 'every import, approval, undo and note is in the log');

-- ======================================================================================================================
-- 7. closed books: no deposit dated in them
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e50a04');
select public.lock_finance_period(public.il_today() - 1, 'סגירת חודש');
select pg_temp.refused_with($$select public.bank_deposit_create('00000000-0000-0000-0000-000000e50e05', public.il_today() - 1, null, 0, array[pg_temp.pay('d-r11', 'cheque')], '')$$,
  'period_locked', 'a deposit dated in closed books');
select pg_temp.check((public.bank_deposit_create('00000000-0000-0000-0000-000000e50e05', public.il_today(), null, 0, array[pg_temp.pay('d-r11', 'cheque')], '')->>'number')::int = 4,
  'dated today: deposit 4');
commit;
