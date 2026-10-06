-- Dream Commerce stage 4 (2.57.0, migration 3600) on a real Postgres (tests/sql/run.sh): the platform's switch, a live
-- payment, the sale and its stock, the customer (one per phone / email), the document issued by the server (service role),
-- a refund, fulfillment, a customer's request, the email queue and the owner's alerts. Fixtures only:
--   Shop (company, 18%)  owner O, cashier K, viewer V        Other  owner P — another business, no details for documents
-- Every check raises "CHECK FAILED: …" when the database does not behave.
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
create or replace function pg_temp.as_user(uid text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', uid, true), set_config('request.jwt.claim.role', 'authenticated', true);
$$;
create or replace function pg_temp.h(t text) returns text language sql as $$ select encode(sha256(convert_to(t, 'UTF8')), 'hex') $$;
create or replace function pg_temp.qty(p uuid) returns int language sql as $$
  select coalesce((select stock_qty from public.catalog_variants where id = p), (select stock_qty from public.catalog_items where id = p))
$$;
create or replace function pg_temp.issue(r jsonb) returns uuid language plpgsql as $$
declare cols text; id uuid;
begin
  select string_agg(quote_ident(k), ', ') into cols from jsonb_object_keys(r) k;
  execute format('insert into public.documents (%s) select %s from jsonb_populate_record(null::public.documents, $1) returning id', cols, cols) using r into id;
  return id;
end $$;
-- a cart of the shop with one line, then "לתשלום": the order's id
create or replace function pg_temp.order_of(p_cart text, p_item uuid, p_variant uuid, p_qty int, p_customer jsonb) returns uuid language plpgsql as $$
declare r jsonb;
begin
  r := public.sf_cart_set('00000000-0000-0000-0000-000000365001', pg_temp.h('c4-' || p_cart), p_item, p_variant, p_qty, 'add', true);
  if r->>'ok' <> 'true' then raise exception 'CHECK FAILED: cart %', r; end if;
  r := public.sf_checkout_start('00000000-0000-0000-0000-000000365001', pg_temp.h('c4-' || p_cart), pg_temp.h('c4-order-' || p_cart),
         p_customer || '{"terms": "true"}', '', true);
  if r->>'ok' <> 'true' then raise exception 'CHECK FAILED: checkout %', r; end if;
  return (r#>>'{order,id}')::uuid;
end $$;

-- ---- the phone key: the one table of examples ------------------------------------------------------------------------------
-- tests/commerce-finance.test.ts reads the rows between the two marks below and runs them through crm.ts phoneDigits
create temp table phone_examples (raw text, key text);
insert into phone_examples (raw, key) values
-- phone examples: begin
  ('050-123-4567', '972501234567'),
  ('+972 50 123 4567', '972501234567'),
  ('00972501234567', '972501234567'),
  (' 972-50-1234567 ', '972501234567'),
  ('(03) 555-5555', '97235555555'),
  ('+1 (212) 555-0100', '12125550100'),
  ('0000123', '9720123'),
  ('05+0123', '97250123'),
  ('٠٥٠١٢٣٤٥٦٧', ''),
  ('abc', ''),
  ('', '')
-- phone examples: end
;
select pg_temp.check(not exists (select 1 from phone_examples where public.phone_key(raw) is distinct from key),
  'phone_key = phoneDigits on every example: ' || coalesce((select string_agg(raw || ' → ' || public.phone_key(raw), ', ') from phone_examples where public.phone_key(raw) is distinct from key), ''));
select pg_temp.check(public.phone_key(null) = '', 'no phone: an empty key');

-- ---- the world --------------------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000360a1', 'owner@shop4.test'), ('00000000-0000-0000-0000-0000000360c1', 'cashier@shop4.test'),
  ('00000000-0000-0000-0000-0000000360f1', 'viewer@shop4.test'), ('00000000-0000-0000-0000-0000000360a2', 'owner@other4.test');
insert into public.businesses (id, name, slug) values
  ('00000000-0000-0000-0000-00000036b001', 'Shop', 'shop-c4'), ('00000000-0000-0000-0000-00000036b002', 'Other', 'other-c4');
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-00000036b001', '00000000-0000-0000-0000-0000000360a1', 'owner', 'full'),
  ('00000000-0000-0000-0000-00000036b001', '00000000-0000-0000-0000-0000000360c1', 'editor', 'register'),
  ('00000000-0000-0000-0000-00000036b001', '00000000-0000-0000-0000-0000000360f1', 'viewer', 'full'),
  ('00000000-0000-0000-0000-00000036b002', '00000000-0000-0000-0000-0000000360a2', 'owner', 'full');
insert into public.register_settings (user_id, business_id, business_type, vat_rate, dealer_number, legal_name, street, city, entity_type) values
  ('00000000-0000-0000-0000-0000000360a1', '00000000-0000-0000-0000-00000036b001', 'licensed', 18, '514000004', 'חנות בע"מ', 'הרצל', 'תל אביב', 'company');
-- a tote (5 in stock, 40 online) and a shirt with M (3, 90 online)
insert into public.catalog_items (id, user_id, business_id, name, price, kind, track_stock, stock_qty, slug, publish_online, online_price, sku, active, has_variants) values
  ('00000000-0000-0000-0000-000000361001', '00000000-0000-0000-0000-0000000360a1', '00000000-0000-0000-0000-00000036b001', 'שקית בד', 50, 'product', true, 5, 'tote', true, 40, 'TOTE', true, false),
  ('00000000-0000-0000-0000-000000361002', '00000000-0000-0000-0000-0000000360a1', '00000000-0000-0000-0000-00000036b001', 'חולצה', 100, 'product', true, 3, 'shirt', true, null, 'SHIRT', true, true);
insert into public.catalog_options (item_id, position, name, choices) values ('00000000-0000-0000-0000-000000361002', 1, 'מידה', '{M}');
insert into public.catalog_variants (id, item_id, option1, stock_qty, active, position, online_price) values
  ('00000000-0000-0000-0000-000000362002', '00000000-0000-0000-0000-000000361002', 'M', 3, true, 1, 90);
insert into public.stores (id, business_id, name, phone) values
  ('00000000-0000-0000-0000-000000365001', '00000000-0000-0000-0000-00000036b001', 'Shop', '03-5555555');
-- the dashboard's server connected a LIVE terminal
insert into public.payment_accounts (business_id, provider, mode, sealed, page_uid, hint) values
  ('00000000-0000-0000-0000-00000036b001', 'mock', 'live', 'v1.iv.tag.enc', 'page-1', 'ab12');
update public.stores set checkout_enabled = true, pickup_enabled = true, delivery_enabled = true, delivery_price = 30, free_delivery_over = 500
 where id = '00000000-0000-0000-0000-000000365001';
-- a customer the shop already knows: her phone in another spelling, no email, her own name
insert into public.leads (id, user_id, business_id, name, phone, status, source) values
  ('00000000-0000-0000-0000-000000366001', '00000000-0000-0000-0000-0000000360a1', '00000000-0000-0000-0000-00000036b001', 'דנה כהן', '+972-50-123-4567', 'חדש', 'ידני');

-- ---- 1. the switch -----------------------------------------------------------------------------------------------------------
begin;
set local role service_role;
select public.sf_cart_set('00000000-0000-0000-0000-000000365001', pg_temp.h('c4-Z'), '00000000-0000-0000-0000-000000361001', null, 1, 'add', true);
select pg_temp.check((public.sf_checkout_start('00000000-0000-0000-0000-000000365001', pg_temp.h('c4-Z'), pg_temp.h('c4-order-Z'),
  '{"name": "דנה", "phone": "0501234567", "email": "d@x.co", "method": "pickup", "terms": "true"}', '', true)) @> '{"ok": false, "error": "live_not_yet"}',
  'a live terminal sells nothing while the platform''s switch is off');
select pg_temp.check(public.commerce_live() = false, 'the switch starts off');
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000360a1');
select pg_temp.check(public.commerce_live() = false, 'the screen may ask whether real sales are open');
select pg_temp.refused($$select * from public.platform_flags$$, 'the switch is not a table of the app');
select pg_temp.refused($$update public.platform_flags set enabled = true$$, 'an owner does not open real sales');
commit;
begin;
set local role service_role;
select pg_temp.refused($$update public.platform_flags set enabled = true$$, 'nor does a server');
commit;
-- the platform's owner, in the SQL Editor
update public.platform_flags set enabled = true, updated_at = now() where key = 'commerce_live';

-- ---- 2. a live order is paid ----------------------------------------------------------------------------------------------
begin;
set local role service_role;
create temp table o1 as select pg_temp.order_of('A', '00000000-0000-0000-0000-000000361001', null, 2,
  '{"name": "Dana Cohen", "phone": "050-1234567", "email": "Dana@X.co", "method": "delivery", "city": "תל אביב", "street": "הרצל", "house": "1"}') as id;
grant select on o1 to public;
select pg_temp.check((select not is_test and total = 110 and shipping = 30 from public.orders where id = (select id from o1)),
  'with the switch on and a live terminal the order is real: 2 × 40 + delivery 30');
select pg_temp.check((public.sf_order_paid('00000000-0000-0000-0000-000000365001', (select id from o1), 'mock', 'TX-1', 110, 'ILS'))->>'status' = 'paid', 'paid');
select pg_temp.check((select payment_status = 'paid' and document_status = 'pending' and sale_id is null from public.orders where id = (select id from o1)),
  'paid, a document to issue, no sale yet (the dashboard records it)');
select pg_temp.check((select array_agg(status) = '{paid}' from public.stock_reservations where order_id = (select id from o1)), 'the units stay held until the sale takes them');
select pg_temp.check(pg_temp.qty('00000000-0000-0000-0000-000000361001') = 5, 'no stock moved yet');
select pg_temp.check((select count(*) = 1 from public.store_alerts where order_id = (select id from o1) and kind = 'new_order' and pushed_at is null), 'the owner is told');
select pg_temp.check((select count(*) = 1 from public.email_outbox where order_id = (select id from o1) and kind = 'order_confirmation' and to_email = 'dana@x.co' and status = 'queued'),
  'a confirmation email waits');
select pg_temp.check((public.sf_order_paid('00000000-0000-0000-0000-000000365001', (select id from o1), 'mock', 'TX-1', 110, 'ILS'))->>'result' = 'already'
  and (select count(*) = 1 from public.email_outbox where order_id = (select id from o1)), 'the same payment again: nothing new');
select pg_temp.check((public.commerce_pending(50)) @> to_jsonb(array[(select id from o1)]), 'the cron sees what is left to do');
commit;

-- the register cannot sell the 2 held totes: 5 in stock, 2 held → 4 are refused, 3 are fine
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000360a1');
select pg_temp.refused_with($$insert into public.sales (user_id, business_id, items, subtotal, total, method, status) values
  ('00000000-0000-0000-0000-0000000360a1', '00000000-0000-0000-0000-00000036b001',
   '[{"name": "שקית בד", "price": 50, "qty": 4, "itemId": "00000000-0000-0000-0000-000000361001"}]', 200, 200, 'cash', 'paid')$$,
  'שמור להזמנה באתר', 'paid units are still held for the site');
commit;

-- ---- 3. the sale --------------------------------------------------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000360a1');
select pg_temp.refused($$select public.commerce_record_sale((select id from o1), 18, 16.78)$$, 'an app user does not record a sale of the site');
commit;
begin;
set local role service_role;
select pg_temp.refused_with($$select public.commerce_record_sale((select id from o1), 18, 10)$$, 'vat_mismatch', 'a VAT that is not the total''s');
select pg_temp.refused_with($$select public.commerce_record_sale((select id from o1), -1, 0)$$, 'vat_invalid', 'a negative rate');
select pg_temp.check((public.commerce_record_sale((select id from o1), 18, 16.78))->>'result' = 'ok', 'the sale is recorded');
select pg_temp.check((select channel = 'online' and status = 'paid' and method = 'card' and total = 110 and subtotal = 110 and discount = 0 and vat_rate = 18 and vat_amount = 16.78
                        and user_id = '00000000-0000-0000-0000-0000000360a1' and business_id = '00000000-0000-0000-0000-00000036b001'
                        and jsonb_array_length(items) = 2 and items->1->>'name' = 'משלוח' and items->0->>'itemId' = '00000000-0000-0000-0000-000000361001'
                        and note = 'הזמנה באתר #' || (select number from public.orders where id = (select id from o1))
                      from public.sales where id = (select id from o1)), 'one sale, id = the order''s, online, the owner''s, the lines + delivery');
select pg_temp.check(pg_temp.qty('00000000-0000-0000-0000-000000361001') = 3, 'the sale moved the stock (the existing trigger): 5 − 2');
select pg_temp.check((select array_agg(status) = '{used}' from public.stock_reservations where order_id = (select id from o1)), 'the held units were used by the sale');
select pg_temp.check((select count(*) = 1 from public.stock_movements where sale_id = (select id from o1) and delta = -2), 'one movement of the stock');
select pg_temp.check((public.commerce_record_sale((select id from o1), 18, 16.78))->>'result' = 'already'
  and (select count(*) = 1 from public.sales where id = (select id from o1)) and pg_temp.qty('00000000-0000-0000-0000-000000361001') = 3,
  'again: nothing new (no second sale, no second movement)');
-- the customer: the lead she already was (phone in another spelling); her email filled in, her name kept
select pg_temp.check((select lead_id = '00000000-0000-0000-0000-000000366001' and sale_id = id from public.orders where id = (select id from o1)), 'the order knows its customer');
select pg_temp.check((select lead_id = '00000000-0000-0000-0000-000000366001' from public.sales where id = (select id from o1)), 'so does the sale');
select pg_temp.check((select name = 'דנה כהן' and phone = '+972-50-123-4567' and email = 'dana@x.co' and status = 'חדש' and value = 110
                      from public.leads where id = '00000000-0000-0000-0000-000000366001'), 'only empty fields are filled; the value grows');
select pg_temp.check((select count(*) = 1 from public.lead_activities where lead_id = '00000000-0000-0000-0000-000000366001' and kind = 'purchase' and body like 'הזמנה באתר #% · ₪110 · 2 פריטים'),
  'a purchase on her card');
select pg_temp.check((select count(*) = 1 from public.leads where business_id = '00000000-0000-0000-0000-00000036b001'), 'no second lead');
commit;

-- the register sells the rest: the units are no longer held
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000360a1');
insert into public.sales (id, user_id, business_id, items, subtotal, total, method, status, channel) values
  ('00000000-0000-0000-0000-000000367001', '00000000-0000-0000-0000-0000000360a1', '00000000-0000-0000-0000-00000036b001',
   '[{"name": "שקית בד", "price": 50, "qty": 1, "itemId": "00000000-0000-0000-0000-000000361001"}]', 50, 50, 'cash', 'paid', 'online');
select pg_temp.check((select channel = 'pos' from public.sales where id = '00000000-0000-0000-0000-000000367001'), 'a user of the app always writes a register sale');
update public.sales set channel = 'pos' where id = (select id from o1);
select pg_temp.check((select channel = 'online' from public.sales where id = (select id from o1)), 'and never changes a sale''s channel');
select pg_temp.check((select count(*) = 1 from public.sales where channel = 'online'), 'the screens can tell the site''s sales from the register''s');
commit;

-- ---- 4. the document, issued by the server ---------------------------------------------------------------------------------
-- licensed, 18%: 2 × 40 + 30 gross → 33.90 × 2 + 25.42 before VAT, VAT 16.78 (docFromSale), paid by card (3)
begin;
set local role service_role;
create temp table d1 as select pg_temp.issue(jsonb_build_object(
  'user_id', '00000000-0000-0000-0000-0000000360a1', 'business_id', '00000000-0000-0000-0000-00000036b001', 'doc_type', 320, 'doc_number', 0,
  'doc_date', public.il_today(), 'customer_name', 'Dana Cohen', 'customer_phone', '0501234567', 'customer_email', 'dana@x.co',
  'lines', '[{"name": "שקית בד", "qty": 2, "unitPriceExVat": 33.9, "discountExVat": 0, "totalExVat": 67.8, "vatRate": 18, "kind": 1},
             {"name": "משלוח", "qty": 1, "unitPriceExVat": 25.42, "discountExVat": 0, "totalExVat": 25.42, "vatRate": 18, "kind": 1}]'::jsonb,
  'payments', jsonb_build_array(jsonb_build_object('method', 3, 'amount', 110, 'date', public.il_today(), 'm', 'card')),
  'before_discount', 93.22, 'discount', 0, 'after_discount', 93.22, 'vat_amount', 16.78, 'total', 110, 'vat_rate', 18,
  'sale_id', (select id from o1), 'lead_id', '00000000-0000-0000-0000-000000366001', 'idempotency_key', 'sale:' || (select id from o1))) as id;
grant select on d1 to public;
select pg_temp.check((select doc_type = 320 and doc_number > 0 and source = 'pos' and business_id = '00000000-0000-0000-0000-00000036b001'
                      from public.documents where id = (select id from d1)), 'the service role issues the document: numbered, the order''s business');
select pg_temp.check((select count(*) = 1 from public.payments where document_id = (select id from d1)), 'the payment is in the ledger once (the existing trigger)');
select pg_temp.refused_with($$select pg_temp.issue(jsonb_build_object(
  'user_id', '00000000-0000-0000-0000-0000000360a1', 'business_id', '00000000-0000-0000-0000-00000036b001', 'doc_type', 320, 'doc_number', 0,
  'doc_date', public.il_today(), 'customer_name', 'Dana', 'lines', '[{"name": "x", "qty": 1, "unitPriceExVat": 93.22, "discountExVat": 0, "totalExVat": 93.22, "vatRate": 18, "kind": 1}]'::jsonb,
  'payments', jsonb_build_array(jsonb_build_object('method', 3, 'amount', 110, 'date', public.il_today())),
  'before_discount', 93.22, 'discount', 0, 'after_discount', 93.22, 'vat_amount', 16.78, 'total', 110, 'vat_rate', 18,
  'sale_id', (select id from o1), 'idempotency_key', 'sale:' || (select id from o1)))$$, 'idempotency', 'the manual "paid sale without a document" cannot issue a second one');
select pg_temp.refused_with($$select pg_temp.issue(jsonb_build_object(
  'user_id', '00000000-0000-0000-0000-0000000360a2', 'business_id', '00000000-0000-0000-0000-00000036b002', 'doc_type', 320, 'doc_number', 0,
  'doc_date', public.il_today(), 'customer_name', 'X', 'lines', '[{"name": "x", "qty": 1, "unitPriceExVat": 100, "discountExVat": 0, "totalExVat": 100, "vatRate": 18, "kind": 1}]'::jsonb,
  'payments', jsonb_build_array(jsonb_build_object('method', 3, 'amount', 118, 'date', public.il_today())),
  'before_discount', 100, 'discount', 0, 'after_discount', 100, 'vat_amount', 18, 'total', 118, 'vat_rate', 18, 'idempotency_key', 'direct:x4'))$$,
  'business_details_missing', 'the service role meets the same checks: a business without details issues nothing');
select pg_temp.refused_with($$select public.order_document_done((select id from o1), gen_random_uuid(), '')$$, 'not of this order', 'only a document of the order''s sale');
select pg_temp.check((public.order_document_done((select id from o1), (select id from d1), ''))->>'status' = 'issued', 'the order: document issued');
select pg_temp.check((select document_status = 'issued' and document_id = (select id from d1) from public.orders where id = (select id from o1)), 'issued, with its id');
select pg_temp.check((public.order_document_done((select id from o1), null, 'late'))->>'result' = 'already', 'an issued document is never "blocked" after');
select pg_temp.check((public.sf_order('00000000-0000-0000-0000-000000365001', pg_temp.h('c4-order-A')))->>'doc_token' = (select share_token from public.documents where id = (select id from d1))
  and (public.sf_order('00000000-0000-0000-0000-000000365001', pg_temp.h('c4-order-A')))->>'document' = 'issued', 'the customer''s page has her document');
select pg_temp.check(not ((public.commerce_pending(50)) @> to_jsonb(array[(select id from o1)])), 'nothing left to do on it');
commit;

-- ---- 5. a second customer: same email in other letters, a new phone; then a new person -----------------------------------
begin;
set local role service_role;
create temp table o2 as select pg_temp.order_of('B', '00000000-0000-0000-0000-000000361002', '00000000-0000-0000-0000-000000362002', 1,
  '{"name": "D. Cohen", "phone": "052-9999999", "email": " DANA@x.CO", "method": "pickup"}') as id;
grant select on o2 to public;
select public.sf_order_paid('00000000-0000-0000-0000-000000365001', (select id from o2), 'mock', 'TX-2', 90, 'ILS');
select pg_temp.check((public.commerce_record_sale((select id from o2), 18, 13.73))->>'lead' = '00000000-0000-0000-0000-000000366001', 'the same email is the same customer');
select pg_temp.check((select phone = '+972-50-123-4567' and value = 200 from public.leads where id = '00000000-0000-0000-0000-000000366001'), 'her phone is kept, the value grows');
select pg_temp.check(pg_temp.qty('00000000-0000-0000-0000-000000362002') = 2 and pg_temp.qty('00000000-0000-0000-0000-000000361002') = 2,
  'the variant''s stock and the item''s moved');
select pg_temp.check((select items->0->>'variantId' = '00000000-0000-0000-0000-000000362002' and items->0->>'name' = 'חולצה — M' from public.sales where id = (select id from o2)),
  'a line of a variant carries its variant');
-- the business cannot issue it now: blocked, with the reason, and the owner is told; tried again only after a fix
select pg_temp.check((public.order_document_done((select id from o2), null, 'חסרים פרטי העסק למסמכים'))->>'status' = 'blocked', 'blocked');
select pg_temp.check((select document_status = 'blocked' and document_error = 'חסרים פרטי העסק למסמכים' from public.orders where id = (select id from o2)), 'the reason is on the order');
select pg_temp.check((select count(*) = 1 from public.store_alerts where order_id = (select id from o2) and kind = 'document_blocked'), 'the owner is told');
select pg_temp.check(not ((public.commerce_pending(50)) @> to_jsonb(array[(select id from o2)])), 'the cron does not retry a blocked document by itself');
select pg_temp.check((public.order_document_retry((select id from o2)))->>'result' = 'ok', '"נסו שוב"');
select pg_temp.check((public.commerce_pending(50)) @> to_jsonb(array[(select id from o2)]), 'pending again');
-- a new person: a new lead, from the site, a customer
create temp table o3 as select pg_temp.order_of('C', '00000000-0000-0000-0000-000000361001', null, 1,
  '{"name": "Noa", "phone": "054-7777777", "email": "noa@y.co", "method": "pickup"}') as id;
grant select on o3 to public;
select public.sf_order_paid('00000000-0000-0000-0000-000000365001', (select id from o3), 'mock', 'TX-3', 40, 'ILS');
select public.commerce_record_sale((select id from o3), 18, 6.10);
select pg_temp.check((select l.source = 'אתר' and l.status = 'נסגר' and l.name = 'Noa' and l.phone = '0547777777' and l.email = 'noa@y.co' and l.value = 40
                        and l.user_id = '00000000-0000-0000-0000-0000000360a1'
                      from public.leads l join public.orders o on o.lead_id = l.id where o.id = (select id from o3)), 'a new customer: from the site, a customer, the owner''s');
-- another business, the same phone: its own lead
select pg_temp.check(public.commerce_upsert_customer('00000000-0000-0000-0000-00000036b002', '00000000-0000-0000-0000-0000000360a2', 'Dana', '0501234567', 'dana@x.co')
  <> '00000000-0000-0000-0000-000000366001', 'a customer of another business is not this one''s');
commit;

-- ---- 6. a refund of the online sale --------------------------------------------------------------------------------------
begin;
set local role service_role;
insert into public.sale_refunds (id, user_id, business_id, sale_id, amount, vat_amount, method, items, restock, reason)
values ('00000000-0000-0000-0000-000000368001', '00000000-0000-0000-0000-0000000360a1', '00000000-0000-0000-0000-00000036b001', (select id from o1), 40, 6.10, 'card',
        '[{"name": "שקית בד", "price": 40, "qty": 1, "itemId": "00000000-0000-0000-0000-000000361001"}]', true, 'גדול מדי');
select pg_temp.check((select payment_status = 'partially_refunded' and refunded_total = 40 from public.orders where id = (select id from o1)), 'the order: partly refunded');
select pg_temp.check(pg_temp.qty('00000000-0000-0000-0000-000000361001') = 2, 'back on the shelf (the existing trigger): 1 + 1');
select pg_temp.check((select count(*) = 1 from public.email_outbox where order_id = (select id from o1) and kind = 'order_refunded' and ref = '00000000-0000-0000-0000-000000368001'),
  'the customer is told about this refund');
select pg_temp.check((select count(*) = 1 from public.payments where refund_id = '00000000-0000-0000-0000-000000368001' and direction = 'out'), 'money out in the ledger');
select pg_temp.refused_with($$insert into public.sale_refunds (user_id, business_id, sale_id, amount, method) values
  ('00000000-0000-0000-0000-0000000360a1', '00000000-0000-0000-0000-00000036b001', (select id from o1), 71, 'card')$$, 'refund_exceeds_paid', 'not more than was paid');
insert into public.sale_refunds (user_id, business_id, sale_id, amount, vat_amount, method) values
  ('00000000-0000-0000-0000-0000000360a1', '00000000-0000-0000-0000-00000036b001', (select id from o1), 70, 10.68, 'card');
select pg_temp.check((select payment_status = 'refunded' and refunded_total = 110 from public.orders where id = (select id from o1)), 'all of it: refunded');
-- the credit invoice of the first refund, by the server, on its own key
create temp table d2 as select pg_temp.issue(jsonb_build_object(
  'user_id', '00000000-0000-0000-0000-0000000360a1', 'business_id', '00000000-0000-0000-0000-00000036b001', 'doc_type', 330, 'doc_number', 0,
  'doc_date', public.il_today(), 'customer_name', 'Dana Cohen',
  'lines', '[{"name": "שקית בד", "qty": 1, "unitPriceExVat": 33.9, "discountExVat": 0, "totalExVat": 33.9, "vatRate": 18, "kind": 1}]'::jsonb,
  'payments', '[]'::jsonb, 'before_discount', 33.9, 'discount', 0, 'after_discount', 33.9, 'vat_amount', 6.10, 'total', 40, 'vat_rate', 18,
  'base_doc_type', 320, 'base_doc_number', (select doc_number from public.documents where id = (select id from d1)),
  'sale_id', (select id from o1), 'refund_id', '00000000-0000-0000-0000-000000368001', 'idempotency_key', 'refund:00000000-0000-0000-0000-000000368001')) as id;
grant select on d2 to public;
select pg_temp.check((select doc_type = 330 from public.documents where id = (select id from d2)), 'a credit invoice for the refund');
commit;

-- ---- 7. the goods, a customer's request ----------------------------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000360c1');
select pg_temp.refused($$select public.order_set_fulfillment((select id from o3), 'ready')$$, 'a cashier does not touch orders');
select pg_temp.check((select count(*) from public.email_outbox) = 0 and (select count(*) from public.store_alerts) = 0, 'a cashier sees no email and no alert');
select pg_temp.as_user('00000000-0000-0000-0000-0000000360f1');
select pg_temp.refused($$select public.order_set_fulfillment((select id from o3), 'ready')$$, 'a viewer only reads');
select pg_temp.check((select count(*) from public.email_outbox) > 0, 'a viewer sees the emails of the business');
select pg_temp.as_user('00000000-0000-0000-0000-0000000360a2');
select pg_temp.refused($$select public.order_set_fulfillment((select id from o3), 'ready')$$, 'another business''s owner');
select pg_temp.check((select count(*) from public.email_outbox) = 0 and (select count(*) from public.store_alerts) = 0, 'nothing of another business');
select pg_temp.as_user('00000000-0000-0000-0000-0000000360a1');
select pg_temp.check((public.order_set_fulfillment((select id from o3), 'ready'))->>'ok' = 'true', 'pickup: ready');
select pg_temp.check((select count(*) = 1 from public.email_outbox where order_id = (select id from o3) and kind = 'order_ready'), 'the customer is told it is ready');
select pg_temp.check((public.order_set_fulfillment((select id from o1), 'shipped', 'RR123IL', 'http://track'))->>'error' = 'url', 'a tracking link is https');
select pg_temp.check((public.order_set_fulfillment((select id from o1), 'shipped', 'RR123IL', 'https://track.example/RR123IL'))->>'ok' = 'true', 'shipped');
select pg_temp.check((select fulfillment_status = 'shipped' and tracking_number = 'RR123IL' and shipped_at is not null from public.orders where id = (select id from o1)), 'with its tracking');
select pg_temp.check((public.order_set_fulfillment((select id from o1), 'shipped', 'RR123IL', 'https://track.example/RR123IL'))->>'same' = 'true'
  and (select count(*) = 1 from public.email_outbox where order_id = (select id from o1) and kind = 'order_shipped'), 'shipped twice: one email');
select pg_temp.check((select count(*) = 0 from public.order_events where kind = 'fulfillment' and order_id = (select id from o2)), 'nothing else moved');
select pg_temp.refused($$update public.orders set payment_status = 'paid'$$, 'the screen never writes an order itself');
select pg_temp.refused($$insert into public.email_outbox (business_id, store_id, order_id, kind, to_email) values
  ('00000000-0000-0000-0000-00000036b001', '00000000-0000-0000-0000-000000365001', (select id from o1), 'order_shipped', 'a@b.co')$$, 'nor an email');
select pg_temp.refused($$select public.email_outbox_claim(5)$$, 'nor sends one');
select public.store_alerts_seen((select id from o2));
select pg_temp.check((select bool_and(seen_at is not null) from public.store_alerts where order_id = (select id from o2)), 'the owner saw the order''s alerts');
commit;

begin;
set local role service_role;
select pg_temp.check((public.sf_order_request('00000000-0000-0000-0000-000000365001', pg_temp.h('c4-order-C'), 'return', 'לא מתאים'))->>'ok' = 'true', 'the customer asks to return');
select pg_temp.check((public.sf_order_request('00000000-0000-0000-0000-000000365001', pg_temp.h('c4-order-C'), 'cancel', ''))->>'error' = 'already', 'once');
select pg_temp.check((public.sf_order_request('00000000-0000-0000-0000-000000365001', pg_temp.h('nobody'), 'cancel', ''))->>'error' = 'not_found', 'only with the link');
select pg_temp.check((select request_kind = 'return' and request_note = 'לא מתאים' and payment_status = 'paid' from public.orders where id = (select id from o3)),
  'recorded on the order; no money moved');
select pg_temp.check((select count(*) = 1 from public.store_alerts where order_id = (select id from o3) and kind = 'request'), 'the owner is told');
commit;

-- ---- 8. the email queue and the alerts -----------------------------------------------------------------------------------
begin;
set local role service_role;
create temp table claimed as select * from public.email_outbox_claim(100);
select pg_temp.check((select count(*) from claimed) = (select count(*) from public.email_outbox) and (select bool_and(status = 'sending' and attempts = 1) from claimed),
  'the sender takes every waiting email');
select pg_temp.check((select count(*) from public.email_outbox_claim(100)) = 0, 'not twice');
select pg_temp.check(public.email_outbox_done((select id from claimed where kind = 'order_confirmation' and order_id = (select id from o1)), '', 'timeout') = 'queued', 'no id: again later');
select pg_temp.check(public.email_outbox_done((select id from claimed where kind = 'order_confirmation' and order_id = (select id from o1)), 're_123', '') = 'sent', 'an id: sent');
select pg_temp.check((select status = 'sent' and provider_id = 're_123' and sent_at is not null from public.email_outbox
                      where kind = 'order_confirmation' and order_id = (select id from o1)), 'sent, with the provider''s id');
select pg_temp.check(public.email_outbox_done((select id from claimed where kind = 'order_confirmation' and order_id = (select id from o2)), '', 'domain not verified', true) = 'failed',
  'a final error: failed at once');
select pg_temp.check((select count(*) = 1 from public.store_alerts where order_id = (select id from o2) and kind = 'email_failed'), 'and the owner is told');
commit;
select pg_temp.refused($$update public.email_outbox set status = 'sent' where provider_id = ''$$, '"sent" without the provider''s id');

begin;
set local role service_role;
create temp table pushed as select x from jsonb_array_elements(public.store_alerts_claim(100)) x;
select pg_temp.check((select count(*) from pushed) >= 4 and exists (select 1 from pushed where x->>'kind' = 'new_order' and x->>'total' = '110'), 'the alerts go to the phones');
select pg_temp.check(jsonb_array_length(public.store_alerts_claim(100)) = 0, 'once');
commit;

-- ---- 9. the switch off again ------------------------------------------------------------------------------------------------
update public.platform_flags set enabled = false where key = 'commerce_live';
begin;
set local role service_role;
select public.sf_cart_set('00000000-0000-0000-0000-000000365001', pg_temp.h('c4-Y'), '00000000-0000-0000-0000-000000361001', null, 1, 'add', true);
select pg_temp.check((public.sf_checkout_start('00000000-0000-0000-0000-000000365001', pg_temp.h('c4-Y'), pg_temp.h('c4-order-Y'),
  '{"name": "דנה", "phone": "0501234567", "email": "d@x.co", "method": "pickup", "terms": "true"}', '', true)) @> '{"ok": false, "error": "live_not_yet"}',
  'off again: no real order');
select pg_temp.check((public.sf_order_paid('00000000-0000-0000-0000-000000365001', (select id from o1), 'mock', 'TX-1', 110, 'ILS'))->>'result' = 'already',
  'an order that was paid stays paid');
commit;
