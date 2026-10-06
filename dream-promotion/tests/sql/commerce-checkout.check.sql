-- Dream Commerce stage 3 (2.56.0, migration 3500) on a real Postgres (tests/sql/run.sh): cart, checkout, reservations,
-- test payments, the register and the held units. The storefront's server is service_role and reads only through sf_*;
-- the dashboard's users are authenticated + a JWT subject. The superuser only builds the world. Fixtures only:
--   Bags (company)  owner O, cashier K, viewer V        Shoes  owner P — another business, another store
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
-- a cookie's / an order link's hash (the storefront keeps the token, the database its sha-256)
create or replace function pg_temp.h(t text) returns text language sql as $$ select encode(sha256(convert_to(t, 'UTF8')), 'hex') $$;
create or replace function pg_temp.qty(p uuid) returns int language sql as $$
  select coalesce((select stock_qty from public.catalog_variants where id = p), (select stock_qty from public.catalog_items where id = p))
$$;

-- ---- the world --------------------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000350a1', 'owner@bags3.test'), ('00000000-0000-0000-0000-0000000350c1', 'cashier@bags3.test'),
  ('00000000-0000-0000-0000-0000000350f1', 'viewer@bags3.test'), ('00000000-0000-0000-0000-0000000350a2', 'owner@shoes3.test');
insert into public.businesses (id, name, slug) values
  ('00000000-0000-0000-0000-00000035b001', 'Bags', 'bags-co'), ('00000000-0000-0000-0000-00000035b002', 'Shoes', 'shoes-co');
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-00000035b001', '00000000-0000-0000-0000-0000000350a1', 'owner', 'full'),
  ('00000000-0000-0000-0000-00000035b001', '00000000-0000-0000-0000-0000000350c1', 'editor', 'register'),
  ('00000000-0000-0000-0000-00000035b001', '00000000-0000-0000-0000-0000000350f1', 'viewer', 'full'),
  ('00000000-0000-0000-0000-00000035b002', '00000000-0000-0000-0000-0000000350a2', 'owner', 'full');
-- a tote (2 in stock), a shirt with S (1) and M (3), a gift card that is not counted, another business's shoe
insert into public.catalog_items (id, user_id, business_id, name, price, kind, track_stock, stock_qty, slug, publish_online, online_price, sku, active, has_variants) values
  ('00000000-0000-0000-0000-000000351001', '00000000-0000-0000-0000-0000000350a1', '00000000-0000-0000-0000-00000035b001', 'שקית בד', 50, 'product', true, 2, 'tote', true, 40, 'TOTE', true, false),
  ('00000000-0000-0000-0000-000000351002', '00000000-0000-0000-0000-0000000350a1', '00000000-0000-0000-0000-00000035b001', 'חולצה', 100, 'product', true, 4, 'shirt', true, null, 'SHIRT', true, true),
  ('00000000-0000-0000-0000-000000351003', '00000000-0000-0000-0000-0000000350a1', '00000000-0000-0000-0000-00000035b001', 'כרטיס מתנה', 100, 'product', false, 0, 'gift', true, null, '', true, false),
  ('00000000-0000-0000-0000-000000351004', '00000000-0000-0000-0000-0000000350a1', '00000000-0000-0000-0000-00000035b001', 'שקית סודית', 9, 'product', true, 5, 'secret', false, null, '', true, false),
  ('00000000-0000-0000-0000-000000351009', '00000000-0000-0000-0000-0000000350a2', '00000000-0000-0000-0000-00000035b002', 'נעל', 200, 'product', true, 9, 'shoe', true, null, '', true, false);
insert into public.catalog_options (item_id, position, name, choices) values ('00000000-0000-0000-0000-000000351002', 1, 'מידה', '{S,M}');
insert into public.catalog_variants (id, item_id, option1, stock_qty, active, position, online_price) values
  ('00000000-0000-0000-0000-000000352001', '00000000-0000-0000-0000-000000351002', 'S', 1, true, 1, null),
  ('00000000-0000-0000-0000-000000352002', '00000000-0000-0000-0000-000000351002', 'M', 3, true, 2, 90);
insert into public.stores (id, business_id, name, phone) values
  ('00000000-0000-0000-0000-000000355001', '00000000-0000-0000-0000-00000035b001', 'Bags', '03-5555555'),
  ('00000000-0000-0000-0000-000000355002', '00000000-0000-0000-0000-00000035b002', 'Shoes', '03-6666666');

-- ---- 1. selling needs a way to pay and a way to get the goods (the owner, in the dashboard) ----------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000350a1');
select pg_temp.refused_with($$update public.stores set checkout_enabled = true, pickup_enabled = true where id = '00000000-0000-0000-0000-000000355001'$$,
  'checkout_not_ready: payment', 'no selling without a connected terminal');
select pg_temp.refused_with($$update public.stores set checkout_enabled = true where id = '00000000-0000-0000-0000-000000355001'$$,
  'checkout_not_ready: shipping', 'no selling without pickup or delivery');
select pg_temp.refused($$select * from public.payment_accounts$$, 'the terminal is the server''s only');
select pg_temp.check(public.store_payment_ready('00000000-0000-0000-0000-00000035b002') = false, 'nothing is said about another business''s terminal');
commit;

-- the dashboard's server connects the terminal (sealed keys); the shoe shop has one too
insert into public.payment_accounts (business_id, provider, mode, sealed, page_uid, hint) values
  ('00000000-0000-0000-0000-00000035b001', 'mock', 'test', 'v1.iv.tag.enc', 'page-1', 'ab12'),
  ('00000000-0000-0000-0000-00000035b002', 'mock', 'test', 'v1.iv.tag.enc', 'page-2', 'cd34');

begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000350a1');
update public.stores set checkout_enabled = true, pickup_enabled = true, pickup_note = 'הרצל 1, א׳–ה׳ 10–18', delivery_enabled = true,
                         delivery_price = 30, free_delivery_over = 150 where id = '00000000-0000-0000-0000-000000355001';
select pg_temp.refused_with($$update public.stores set pickup_enabled = false, delivery_enabled = false where id = '00000000-0000-0000-0000-000000355001'$$,
  'checkout_not_ready: shipping', 'selling stays with a way to get the goods');
select pg_temp.refused($$update public.stores set reserve_minutes = 2 where id = '00000000-0000-0000-0000-000000355001'$$, 'a hold of 2 minutes');
-- coupons: the owner writes them, the database counts their uses
insert into public.store_coupons (store_id, code, kind, value) values ('00000000-0000-0000-0000-000000355001', 'save10', 'percent', 10);
insert into public.store_coupons (store_id, code, kind, value, min_subtotal, max_uses) values ('00000000-0000-0000-0000-000000355001', 'TWENTY', 'amount', 20, 100, 1);
select pg_temp.check((select business_id = '00000000-0000-0000-0000-00000035b001' and code = 'SAVE10' and used_count = 0 from public.store_coupons where code = 'SAVE10'),
  'a coupon belongs to the store''s business, its code in capitals');
select pg_temp.refused($$update public.store_coupons set used_count = 0$$, 'the screen does not reset how often a coupon was used');
select pg_temp.refused($$insert into public.store_coupons (store_id, code, kind, value) values ('00000000-0000-0000-0000-000000355001', 'HALF', 'percent', 150)$$, '150 percent');
select pg_temp.refused($$insert into public.store_coupons (store_id, code, kind, value) values ('00000000-0000-0000-0000-000000355002', 'STEAL', 'amount', 10)$$,
  'a coupon on another business''s store');
commit;
update public.stores set checkout_enabled = true, pickup_enabled = true where id = '00000000-0000-0000-0000-000000355002';

begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000350c1');
select pg_temp.check((select count(*) from public.store_coupons) = 0, 'a cashier sees no coupon');
select pg_temp.refused($$insert into public.store_coupons (store_id, code, kind, value) values ('00000000-0000-0000-0000-000000355001', 'CASH', 'amount', 10)$$, 'a cashier writes no coupon');
select pg_temp.as_user('00000000-0000-0000-0000-0000000350f1');
select pg_temp.check((select count(*) from public.store_coupons) = 2, 'a viewer sees the coupons');
select pg_temp.refused($$insert into public.store_coupons (store_id, code, kind, value) values ('00000000-0000-0000-0000-000000355001', 'VIEW', 'amount', 10)$$, 'a viewer writes no coupon');
commit;

-- ---- 2. the door: only the storefront's server -------------------------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000350a1');
select pg_temp.refused($$select public.sf_cart('00000000-0000-0000-0000-000000355001', 'x', true)$$, 'an app user does not run sf_cart');
select pg_temp.refused($$select public.sf_order_paid('00000000-0000-0000-0000-000000355001', gen_random_uuid(), 'mock', 't', 1, 'ILS')$$, 'an app user does not mark an order paid');
select pg_temp.refused($$select * from public.store_carts$$, 'carts are the server''s only');
select pg_temp.refused($$select * from public.payment_events$$, 'payment events are the server''s only');
select pg_temp.refused($$select public.sf_rate_hit('k', 60, 1)$$, 'an app user does not count requests');
commit;
begin;
set local role anon;
select pg_temp.refused($$select public.sf_checkout_start('00000000-0000-0000-0000-000000355001', 'x', 'y', '{}', '', true)$$, 'anon does not start a checkout');
select pg_temp.refused($$select public.reserved_stock()$$, 'anon reads no reservation');
commit;

-- ---- 3. the cart ----------------------------------------------------------------------------------------------------------------
begin;
set local role service_role;
select pg_temp.check(public.sf_cart('00000000-0000-0000-0000-000000355001', pg_temp.h('nobody'), false) is null, 'a store that is not on the air has no cart (without a preview)');
select pg_temp.check((public.sf_cart('00000000-0000-0000-0000-000000355001', pg_temp.h('nobody'), true))->>'count' = '0', 'no cookie: an empty cart');
select pg_temp.check((public.sf_product('00000000-0000-0000-0000-000000355001', 'tote', true))->>'can_buy' = 'true'
  and (public.sf_store('00000000-0000-0000-0000-000000355001', true))->>'can_buy' = 'true', 'the store sells: the product page and the header know');
select pg_temp.check((public.sf_cart_set('00000000-0000-0000-0000-000000355001', pg_temp.h('A'), '00000000-0000-0000-0000-000000351001', null, 1, 'add', true))->>'ok' = 'true',
  'a tote into A''s cart');
select pg_temp.check((public.sf_cart_set('00000000-0000-0000-0000-000000355001', pg_temp.h('A'), '00000000-0000-0000-0000-000000351001', null, 1, 'add', true))#>>'{cart,lines,0,qty}' = '2',
  'add again: 2');
select pg_temp.check((public.sf_cart_set('00000000-0000-0000-0000-000000355001', pg_temp.h('A'), '00000000-0000-0000-0000-000000351001', null, 1, 'add', true)) @>
  '{"ok": false, "error": "not_enough", "available": 2}', 'not more than is in stock');
select pg_temp.check((public.sf_cart_set('00000000-0000-0000-0000-000000355001', pg_temp.h('A'), '00000000-0000-0000-0000-000000351002', null, 1, 'add', true)) @>
  '{"ok": false, "error": "variant"}', 'a shirt needs its size');
select pg_temp.check((public.sf_cart_set('00000000-0000-0000-0000-000000355001', pg_temp.h('A'), '00000000-0000-0000-0000-000000351001', '00000000-0000-0000-0000-000000352001', 1, 'add', true)) @>
  '{"ok": false, "error": "variant"}', 'another product''s variant');
select pg_temp.check((public.sf_cart_set('00000000-0000-0000-0000-000000355001', pg_temp.h('A'), '00000000-0000-0000-0000-000000351009', null, 1, 'add', true)) @>
  '{"ok": false, "error": "gone"}', 'another business''s product is not in this store');
select pg_temp.check((public.sf_cart_set('00000000-0000-0000-0000-000000355001', pg_temp.h('A'), '00000000-0000-0000-0000-000000351004', null, 1, 'add', true)) @>
  '{"ok": false, "error": "gone"}', 'a product that is not on the site');
select pg_temp.check((public.sf_cart_set('00000000-0000-0000-0000-000000355001', pg_temp.h('A'), '00000000-0000-0000-0000-000000351003', null, 21, 'set', true)) @>
  '{"ok": false, "error": "max_qty"}', 'not more than 20 of a line');
select pg_temp.check((public.sf_cart_set('00000000-0000-0000-0000-000000355001', pg_temp.h('A'), '00000000-0000-0000-0000-000000351002', '00000000-0000-0000-0000-000000352002', 1, 'add', true))->>'ok' = 'true',
  'a shirt M');
select pg_temp.check((public.sf_cart_set('00000000-0000-0000-0000-000000355002', pg_temp.h('A'), '00000000-0000-0000-0000-000000351009', null, 1, 'add', true)) @>
  '{"ok": false, "error": "cart"}', 'a cart is of one store');
select pg_temp.check((public.sf_cart_set('00000000-0000-0000-0000-000000355001', 'not-a-hash', '00000000-0000-0000-0000-000000351001', null, 1, 'add', true)) @>
  '{"ok": false, "error": "bad_request"}', 'a cart is named by a hash');
-- the cart's sum is the database's: 2 × 40 (the online price) + 90 (M's online price)
select pg_temp.check((public.sf_cart('00000000-0000-0000-0000-000000355001', pg_temp.h('A'), true)) @> '{"count": 3, "subtotal": 170, "can_checkout": true}',
  'the sum: 2 × 40 + 90');
select pg_temp.check((public.sf_cart('00000000-0000-0000-0000-000000355001', pg_temp.h('A'), true))#>>'{shipping,delivery,price}' = '0',
  'delivery is free above 150');
-- a coupon
select pg_temp.check((public.sf_cart_coupon('00000000-0000-0000-0000-000000355001', pg_temp.h('A'), 'nope', true)) @> '{"ok": false, "error": "not_found"}', 'an unknown coupon');
select pg_temp.check((public.sf_cart_coupon('00000000-0000-0000-0000-000000355001', pg_temp.h('A'), ' save10 ', true)) @> '{"ok": true, "cart": {"discount": 17}}', '10% of 170');
select pg_temp.check((public.sf_cart('00000000-0000-0000-0000-000000355001', pg_temp.h('A'), true))#>>'{shipping,delivery,price}' = '0', '153 after the coupon: still free');
-- remove a line: qty 0 (nothing is deleted)
select pg_temp.check((public.sf_cart_set('00000000-0000-0000-0000-000000355001', pg_temp.h('A'), '00000000-0000-0000-0000-000000351002', '00000000-0000-0000-0000-000000352002', 0, 'set', true))
  @> '{"ok": true, "cart": {"count": 2, "subtotal": 80, "discount": 8}}', 'the shirt is out: 80, 10% = 8');
select pg_temp.check((public.sf_cart('00000000-0000-0000-0000-000000355001', pg_temp.h('A'), true))#>>'{shipping,delivery,price}' = '30', '72: delivery costs 30');
commit;

-- ---- 4. the checkout: details, the amount from the database, the hold ------------------------------------------------------------
begin;
set local role service_role;
select pg_temp.check((public.sf_checkout_start('00000000-0000-0000-0000-000000355001', pg_temp.h('A'), pg_temp.h('order-1'),
  '{"name":"x","phone":"123","email":"nope","method":"ship","terms":"false"}', 'ip1', true)) @>
  '{"ok": false, "error": "details", "fields": ["name", "phone", "email", "method", "terms"]}', 'every wrong detail is named');
select pg_temp.check((public.sf_checkout_start('00000000-0000-0000-0000-000000355001', pg_temp.h('A'), pg_temp.h('order-1'),
  '{"name":"דנה כהן","phone":"050-1234567","email":"dana@example.com","method":"delivery","city":"","street":"הרצל","house":"","terms":"true"}', 'ip1', true)) @>
  '{"ok": false, "error": "details", "fields": ["city", "house"]}', 'a delivery needs its address');
select pg_temp.check((public.sf_checkout_start('00000000-0000-0000-0000-000000355001', pg_temp.h('nothing'), pg_temp.h('order-1'),
  '{"name":"דנה כהן","phone":"0501234567","email":"dana@example.com","method":"pickup","terms":"true"}', 'ip1', true)) @> '{"ok": false, "error": "empty"}', 'an empty cart');
commit;

-- the owner raises the tote's price after it went into the cart: the order takes today's price, never the browser's
update public.catalog_items set online_price = 45 where id = '00000000-0000-0000-0000-000000351001';
begin;
set local role service_role;
create temp table o1 on commit drop as
  select public.sf_checkout_start('00000000-0000-0000-0000-000000355001', pg_temp.h('A'), pg_temp.h('order-1'),
    '{"name":"דנה כהן","phone":"+972 50-123-4567","email":"Dana@Example.com","method":"delivery","city":"תל אביב","street":"הרצל","house":"5","terms":"true","price":1,"total":1}',
    'ip1', true) as r;
select pg_temp.check((select r @> '{"ok": true, "order": {"number": 1001, "total": 111, "shipping": 30, "discount": 9}}' from o1),
  '2 × 45 = 90, 10% off = 81, delivery 30: 111 (the price the browser sent is ignored)');
select pg_temp.check((select customer_phone = '0501234567' and customer_email = 'dana@example.com' and is_test and payment_status = 'pending'
                        and expires_at between now() + interval '14 minutes' and now() + interval '16 minutes'
                        and address @> '{"city": "תל אביב", "street": "הרצל", "house": "5"}' from public.orders where token_hash = pg_temp.h('order-1')),
  'the order: a test order, its phone and email cleaned, held for 15 minutes');
select pg_temp.check((select r#>>'{account,provider}' = 'mock' and r#>>'{account,page_uid}' = 'page-1' from o1), 'the storefront gets the terminal (sealed) with it');
select pg_temp.check((select count(*) from public.stock_reservations where order_id = (select (r#>>'{order,id}')::uuid from o1) and qty = 2 and status = 'held') = 1,
  'both totes are held');
select pg_temp.check(pg_temp.qty('00000000-0000-0000-0000-000000351001') = 2, 'holding moves no stock');
select pg_temp.check((public.sf_product('00000000-0000-0000-0000-000000355001', 'tote', true))->>'in_stock' = 'false', 'the site shows the tote sold out while it is held');
select pg_temp.check((public.sf_cart_set('00000000-0000-0000-0000-000000355001', pg_temp.h('B'), '00000000-0000-0000-0000-000000351001', null, 1, 'add', true)) @>
  '{"ok": false, "error": "not_enough", "available": 0}', 'another shopper cannot add a held tote');
select pg_temp.check((select count(*) from public.order_events where order_id = (select (r#>>'{order,id}')::uuid from o1) and kind = 'created') = 1, 'the timeline starts');
commit;

-- the last unit (the same race runs with 8 connections at once in concurrency.sh): B and C both want the one S shirt
begin;
set local role service_role;
select pg_temp.check((public.sf_cart_set('00000000-0000-0000-0000-000000355001', pg_temp.h('B'), '00000000-0000-0000-0000-000000351002', '00000000-0000-0000-0000-000000352001', 1, 'add', true))->>'ok' = 'true',
  'B: the one S shirt');
select pg_temp.check((public.sf_cart_set('00000000-0000-0000-0000-000000355001', pg_temp.h('C'), '00000000-0000-0000-0000-000000351002', '00000000-0000-0000-0000-000000352001', 1, 'add', true))->>'ok' = 'true',
  'C: the same S shirt (nothing is held by a cart)');
select pg_temp.check((public.sf_checkout_start('00000000-0000-0000-0000-000000355001', pg_temp.h('B'), pg_temp.h('order-2'),
  '{"name":"בני","phone":"0521111111","email":"b@example.com","method":"pickup","terms":"true"}', 'ip2', true))->>'ok' = 'true', 'B pays first: the S is held');
select pg_temp.check((public.sf_checkout_start('00000000-0000-0000-0000-000000355001', pg_temp.h('C'), pg_temp.h('order-3'),
  '{"name":"כרמל","phone":"0532222222","email":"c@example.com","method":"pickup","terms":"true"}', 'ip3', true)) @>
  '{"ok": false, "error": "stock", "lines": [{"name": "חולצה", "available": 0}]}', 'C is told the S is gone — nothing is held for C');
select pg_temp.check((select count(*) from public.orders where token_hash = pg_temp.h('order-3')) = 0, 'no order for C');
select pg_temp.check((public.sf_cart('00000000-0000-0000-0000-000000355001', pg_temp.h('C'), true))#>>'{lines,0,problem}' = 'out', 'C''s cart marks the line');
commit;

-- a coupon used up; a minimum; a coupon of a pickup order
begin;
set local role service_role;
select pg_temp.check((public.sf_cart_set('00000000-0000-0000-0000-000000355001', pg_temp.h('D'), '00000000-0000-0000-0000-000000351003', null, 1, 'add', true))->>'ok' = 'true', 'D: a gift card (not counted)');
select pg_temp.check((public.sf_cart_coupon('00000000-0000-0000-0000-000000355001', pg_temp.h('D'), 'TWENTY', true)) @> '{"ok": true, "cart": {"discount": 20}}', '20 off');
create temp table o4 on commit drop as select public.sf_checkout_start('00000000-0000-0000-0000-000000355001', pg_temp.h('D'), pg_temp.h('order-4'),
  '{"name":"דור","phone":"0543333333","email":"d@example.com","method":"pickup","terms":"true"}', 'ip4', true) as r;
select pg_temp.check((select r @> '{"ok": true, "order": {"total": 80, "discount": 20, "shipping": 0}}' from o4), 'pickup: 100 − 20');
select pg_temp.check((select count(*) from public.stock_reservations where order_id = (select (r#>>'{order,id}')::uuid from o4)) = 0, 'nothing is held of an uncounted product');
commit;

-- ---- 5. payment: only what the provider confirmed, once --------------------------------------------------------------------------
begin;
set local role service_role;
select pg_temp.check(public.sf_payment_event('00000000-0000-0000-0000-000000355001', (select id from public.orders where number = 1001 and business_id = '00000000-0000-0000-0000-00000035b001'),
  'mock', 'mock:callback:txn-1', 'callback', true, '{"status":"approved"}') = true, 'a notice is logged');
select pg_temp.check(public.sf_payment_event('00000000-0000-0000-0000-000000355001', (select id from public.orders where number = 1001 and business_id = '00000000-0000-0000-0000-00000035b001'),
  'mock', 'mock:callback:txn-1', 'callback', true, '{"status":"approved"}') = false, 'the same notice again: nothing new');
select pg_temp.check((public.sf_order_paid('00000000-0000-0000-0000-000000355001', (select id from public.orders where token_hash = pg_temp.h('order-1')), 'mock', 'txn-1', 110, 'ILS'))
  @> '{"result": "mismatch", "status": "pending"}', 'a different amount changes nothing');
select pg_temp.check((public.sf_order_paid('00000000-0000-0000-0000-000000355002', (select id from public.orders where token_hash = pg_temp.h('order-1')), 'mock', 'txn-1', 111, 'ILS'))
  @> '{"result": "not_found"}', 'another store cannot mark this order');
select pg_temp.check((public.sf_order_paid('00000000-0000-0000-0000-000000355001', (select id from public.orders where token_hash = pg_temp.h('order-1')), 'payplus', 'txn-1', 111, 'ILS'))
  @> '{"result": "rejected"}', 'another provider cannot mark it');
select pg_temp.check((public.sf_order_paid('00000000-0000-0000-0000-000000355001', (select id from public.orders where token_hash = pg_temp.h('order-1')), 'mock', 'txn-1', 111, 'ils'))
  @> '{"result": "ok", "status": "test_paid"}', 'the confirmed amount: test_paid');
select pg_temp.check((public.sf_order_paid('00000000-0000-0000-0000-000000355001', (select id from public.orders where token_hash = pg_temp.h('order-1')), 'mock', 'txn-1', 111, 'ILS'))
  @> '{"result": "already"}', 'the same transaction again: nothing');
select pg_temp.check((public.sf_order_paid('00000000-0000-0000-0000-000000355001', (select id from public.orders where token_hash = pg_temp.h('order-1')), 'mock', 'txn-2', 111, 'ILS'))
  @> '{"result": "double"}', 'another transaction for a paid order: "double", logged');
select pg_temp.check((select count(*) from public.order_events e join public.orders o on o.id = e.order_id where o.token_hash = pg_temp.h('order-1') and e.kind in ('amount_mismatch', 'double_payment', 'test_paid', 'payment_rejected')) = 4,
  'every one of them is on the timeline');
-- a test order: no sale, no stock movement, no document, the hold released, the coupon counted, the cart emptied
select pg_temp.check((select count(*) from public.sales where business_id = '00000000-0000-0000-0000-00000035b001') = 0, 'a test order makes no sale');
select pg_temp.check((select count(*) from public.stock_movements where business_id = '00000000-0000-0000-0000-00000035b001') = 0, 'and moves no stock');
select pg_temp.check((select count(*) from public.documents where business_id = '00000000-0000-0000-0000-00000035b001') = 0, 'and issues no document');
select pg_temp.check(pg_temp.qty('00000000-0000-0000-0000-000000351001') = 2, 'the totes are still 2');
select pg_temp.check((select bool_and(status = 'released') from public.stock_reservations where order_id = (select id from public.orders where token_hash = pg_temp.h('order-1'))),
  'its hold is released');
select pg_temp.check((public.sf_product('00000000-0000-0000-0000-000000355001', 'tote', true))->>'in_stock' = 'true', 'the totes are on sale again');
select pg_temp.check((select used_count from public.store_coupons where code = 'SAVE10') = 1, 'the coupon counts one use');
select pg_temp.check((public.sf_cart('00000000-0000-0000-0000-000000355001', pg_temp.h('A'), true))->>'count' = '0', 'A''s cart is empty');
select pg_temp.check((public.sf_order('00000000-0000-0000-0000-000000355001', pg_temp.h('order-1'))) @> '{"status": "test_paid", "test": true, "total": 111}',
  'the customer''s link shows it');
select pg_temp.check(public.sf_order('00000000-0000-0000-0000-000000355002', pg_temp.h('order-1')) is null, 'not through another store');
select pg_temp.check((select array_agg(k order by k collate "C") from jsonb_object_keys(public.sf_order('00000000-0000-0000-0000-000000355001', pg_temp.h('order-1'))) k)
  = '{coupon,created_at,currency,discount,expires_at,id,lines,method,name,number,page,paid_at,provider,shipping,status,subtotal,test,total}',
  'the order page''s allow-list (no phone, no email, no address)');
-- the TWENTY coupon has 1 use: D's order uses it, then nobody else can
select pg_temp.check((public.sf_order_paid('00000000-0000-0000-0000-000000355001', (select id from public.orders where token_hash = pg_temp.h('order-4')), 'mock', 'txn-4', 80, 'ILS'))->>'result' = 'ok', 'D paid');
select pg_temp.check((public.sf_cart_set('00000000-0000-0000-0000-000000355001', pg_temp.h('E'), '00000000-0000-0000-0000-000000351003', null, 2, 'add', true))->>'ok' = 'true', 'E: two cards');
select pg_temp.check((public.sf_cart_coupon('00000000-0000-0000-0000-000000355001', pg_temp.h('E'), 'TWENTY', true)) @> '{"ok": false, "error": "used_up"}', 'the coupon is used up');
-- a payment that failed: the S shirt goes back on sale
select pg_temp.check((public.sf_order_failed('00000000-0000-0000-0000-000000355001', (select id from public.orders where token_hash = pg_temp.h('order-2')), 'declined'))->>'result' = 'ok', 'B''s payment failed');
select pg_temp.check((public.sf_cart('00000000-0000-0000-0000-000000355001', pg_temp.h('C'), true))#>>'{lines,0,problem}' is null, 'C can have the S now');
select pg_temp.check((public.sf_order_failed('00000000-0000-0000-0000-000000355001', (select id from public.orders where token_hash = pg_temp.h('order-1')), 'late'))->>'result' = 'ignored',
  'a paid order does not fail');
commit;

-- ---- 6. a hold runs out; a payment that comes after it is still taken ------------------------------------------------------------
begin;
set local role service_role;
create temp table o5 on commit drop as select public.sf_checkout_start('00000000-0000-0000-0000-000000355001', pg_temp.h('C'), pg_temp.h('order-5'),
  '{"name":"כרמל","phone":"0532222222","email":"c@example.com","method":"pickup","terms":"true"}', 'ip3', true) as r;
select pg_temp.check((select r->>'ok' = 'true' from o5), 'C holds the S');
commit;
update public.orders set expires_at = now() - interval '20 minutes' where token_hash = pg_temp.h('order-5');
update public.stock_reservations set expires_at = now() - interval '20 minutes' where order_id = (select id from public.orders where token_hash = pg_temp.h('order-5'));
begin;
set local role service_role;
select pg_temp.check((public.sf_product('00000000-0000-0000-0000-000000355001', 'shirt', true))#>>'{variants,0,in_stock}' = 'true', 'an expired hold holds nothing, even before the cron');
select pg_temp.check(public.store_release_expired() >= 1, 'the cron releases it');
select pg_temp.check((select payment_status from public.orders where token_hash = pg_temp.h('order-5')) = 'expired', 'and the unpaid order expires');
select pg_temp.check((public.sf_order_paid('00000000-0000-0000-0000-000000355001', (select id from public.orders where token_hash = pg_temp.h('order-5')), 'mock', 'txn-5', 100, 'ILS'))
  @> '{"result": "ok", "status": "test_paid"}', 'a payment after the hold ran out is not lost');
select pg_temp.check((select data->>'late' from public.order_events where kind = 'test_paid' and order_id = (select id from public.orders where token_hash = pg_temp.h('order-5'))) = 'true',
  'and the timeline says it came late');
-- too many open orders from one shopper
select public.sf_cart_set('00000000-0000-0000-0000-000000355001', pg_temp.h('F'), '00000000-0000-0000-0000-000000351003', null, 1, 'add', true);
select public.sf_checkout_start('00000000-0000-0000-0000-000000355001', pg_temp.h('F'), pg_temp.h('f-' || n), '{"name":"פלג","phone":"0544444444","email":"f@example.com","method":"pickup","terms":"true"}', 'ipF', true)
  from generate_series(1, 3) n;
select pg_temp.check((public.sf_checkout_start('00000000-0000-0000-0000-000000355001', pg_temp.h('F'), pg_temp.h('f-4'),
  '{"name":"פלג","phone":"0544444444","email":"f@example.com","method":"pickup","terms":"true"}', 'ipF', true)) @> '{"ok": false, "error": "too_many_open"}',
  'three open orders per shopper');
-- rate limits
select pg_temp.check((select bool_and(public.sf_rate_hit('cart:ip9', 60, 3)) from generate_series(1, 3)), 'three requests pass');
select pg_temp.check(public.sf_rate_hit('cart:ip9', 60, 3) = false, 'the fourth does not');
-- the cron's list of orders nobody confirmed
update public.orders set provider_page = 'pg-x', created_at = now() - interval '11 minutes' where token_hash = pg_temp.h('f-1');
select pg_temp.check((public.sf_orders_unconfirmed(50)) @> jsonb_build_array(jsonb_build_object('id', (select id from public.orders where token_hash = pg_temp.h('f-1')))),
  'an order unconfirmed for 10 minutes is asked about');
commit;

-- ---- 7. the register and the held units (the owner's decision: a held unit is not sold at the register) ------------------------
-- G holds both totes
begin;
set local role service_role;
select pg_temp.check((public.sf_cart_set('00000000-0000-0000-0000-000000355001', pg_temp.h('G'), '00000000-0000-0000-0000-000000351001', null, 2, 'set', true))->>'ok' = 'true', 'G: two totes');
select pg_temp.check((public.sf_checkout_start('00000000-0000-0000-0000-000000355001', pg_temp.h('G'), pg_temp.h('order-g'),
  '{"name":"גל","phone":"0545555555","email":"g@example.com","method":"pickup","terms":"true"}', 'ipG', true))->>'ok' = 'true', 'G holds both');
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000350c1');
select pg_temp.check((public.reserved_stock()) @> '[{"item_id": "00000000-0000-0000-0000-000000351001", "qty": 2}]', 'the cashier sees "2 held for the site" (no customer)');
select pg_temp.check((select count(*) from public.orders) = 0 and (select count(*) from public.stock_reservations) = 0, 'a cashier sees no order and no hold row');
select pg_temp.refused_with($$insert into public.sales (user_id, items, subtotal, total, method, status, paid_at)
  values ('00000000-0000-0000-0000-0000000350c1', '[{"name":"שקית בד","price":50,"qty":1,"itemId":"00000000-0000-0000-0000-000000351001"}]', 50, 50, 'cash', 'paid', now())$$,
  'שמור להזמנה באתר: שקית בד', 'the register does not sell a held tote');
select pg_temp.check(pg_temp.qty('00000000-0000-0000-0000-000000351001') = 2, 'the totes did not move');
-- the M shirt is not held: sold as before
insert into public.sales (user_id, items, subtotal, total, method, status, paid_at)
  values ('00000000-0000-0000-0000-0000000350c1', '[{"name":"חולצה · M","price":100,"qty":1,"itemId":"00000000-0000-0000-0000-000000351002","variantId":"00000000-0000-0000-0000-000000352002"}]', 100, 100, 'cash', 'paid', now());
select pg_temp.check(pg_temp.qty('00000000-0000-0000-0000-000000352002') = 2, 'a sale of what is not held: as before (M: 3 − 1)');
commit;
-- G's payment fails: the totes are the register's again
begin;
set local role service_role;
select public.sf_order_failed('00000000-0000-0000-0000-000000355001', (select id from public.orders where token_hash = pg_temp.h('order-g')), 'cancelled');
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000350c1');
insert into public.sales (user_id, items, subtotal, total, method, status, paid_at)
  values ('00000000-0000-0000-0000-0000000350c1', '[{"name":"שקית בד","price":50,"qty":1,"itemId":"00000000-0000-0000-0000-000000351001"}]', 50, 50, 'cash', 'paid', now());
select pg_temp.check(pg_temp.qty('00000000-0000-0000-0000-000000351001') = 1, 'released: the register sells the tote');
commit;
-- another business learns nothing about Bags's holds
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000350a2');
select pg_temp.check(public.reserved_stock() = '[]', 'Shoes sees no hold of Bags');
select pg_temp.check(public.stock_reserved_conflict('[{"itemId":"00000000-0000-0000-0000-000000351001","qty":5}]', null) is null, 'nor through the register''s check');
select pg_temp.check((select count(*) from public.orders) = 0, 'nor any order of Bags');
commit;

-- ---- 8. orders in the dashboard: read only; the viewer reads, the cashier does not ---------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000350a1');
select pg_temp.check((select count(*) from public.orders) >= 5 and (select count(*) from public.order_lines) >= 5 and (select count(*) from public.order_events) >= 5,
  'the owner reads the orders, their lines and timelines');
select pg_temp.refused($$update public.orders set payment_status = 'paid'$$, 'nobody marks an order paid from a screen');
select pg_temp.refused($$insert into public.order_events (order_id, business_id, kind) select id, business_id, 'x' from public.orders limit 1$$, 'nor writes its timeline');
select pg_temp.refused($$update public.stock_reservations set status = 'released'$$, 'nor releases a hold');
select pg_temp.as_user('00000000-0000-0000-0000-0000000350f1');
select pg_temp.check((select count(*) from public.orders) >= 5, 'the viewer reads the orders');
select pg_temp.as_user('00000000-0000-0000-0000-0000000350c1');
select pg_temp.check((select count(*) from public.order_lines) = 0 and (select count(*) from public.order_events) = 0, 'the cashier reads nothing of them');
commit;
