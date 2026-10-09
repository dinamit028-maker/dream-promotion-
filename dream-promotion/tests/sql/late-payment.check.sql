-- A payment after the order's hold ran out (2.79, migration 4000) on a real Postgres (tests/sql/run.sh): still taken; seen as
-- late also before the minute cron; what is missing is counted (stock less the units held for OTHER orders), kept on the
-- order and written in the owner's alert; the sale takes all its units — the stock goes below 0 by what is owed, and no more.
--   Late (company, 18%) owner L — a tote with 2 in stock, a cap with 5; a live terminal; the platform's switch on
\set ON_ERROR_STOP 1
set client_min_messages = warning;

create or replace function pg_temp.check(ok boolean, msg text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'CHECK FAILED: %', msg; end if; end $$;
create or replace function pg_temp.h(t text) returns text language sql as $$ select encode(sha256(convert_to(t, 'UTF8')), 'hex') $$;
create or replace function pg_temp.qty(p uuid) returns int language sql as $$ select stock_qty from public.catalog_items where id = p $$;
-- a cart with one line, then "לתשלום" (pickup): the order's id
create or replace function pg_temp.order_of(p_cart text, p_item uuid, p_qty int) returns uuid language plpgsql as $$
declare r jsonb;
begin
  r := public.sf_cart_set('00000000-0000-0000-0000-000000405001', pg_temp.h('lp-' || p_cart), p_item, null, p_qty, 'add', true);
  if r->>'ok' <> 'true' then raise exception 'CHECK FAILED: cart %', r; end if;
  r := public.sf_checkout_start('00000000-0000-0000-0000-000000405001', pg_temp.h('lp-' || p_cart), pg_temp.h('lp-order-' || p_cart),
         '{"name": "דנה", "phone": "0501234567", "email": "d@late.test", "method": "pickup", "terms": "true"}', '', true);
  if r->>'ok' <> 'true' then raise exception 'CHECK FAILED: checkout %', r; end if;
  return (r#>>'{order,id}')::uuid;
end $$;
create or replace function pg_temp.pay(p_order uuid, p_txn text) returns jsonb language sql as $$
  select public.sf_order_paid('00000000-0000-0000-0000-000000405001', p_order, 'mock', p_txn,
                              (select total from public.orders where id = p_order), 'ILS')
$$;
create or replace function pg_temp.sale(p_order uuid) returns jsonb language sql as $$
  select public.commerce_record_sale(p_order, 18, round((select total from public.orders where id = p_order) * 18 / 118, 2))
$$;
-- the hold runs out (the clock moves on): the order and its holds, a minute in the past
create or replace function pg_temp.run_out(p_order uuid) returns void language sql as $$
  update public.orders set expires_at = now() - interval '1 minute' where id = p_order;
  update public.stock_reservations set expires_at = now() - interval '1 minute' where order_id = p_order;
$$;

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000400a1', 'owner@late.test');
insert into public.businesses (id, name, slug) values ('00000000-0000-0000-0000-00000040b001', 'Late', 'late-40');
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-00000040b001', '00000000-0000-0000-0000-0000000400a1', 'owner', 'full');
insert into public.register_settings (user_id, business_id, business_type, vat_rate, dealer_number, legal_name, street, city, entity_type) values
  ('00000000-0000-0000-0000-0000000400a1', '00000000-0000-0000-0000-00000040b001', 'licensed', 18, '514000040', 'מאוחר בע"מ', 'הרצל', 'תל אביב', 'company');
insert into public.catalog_items (id, user_id, business_id, name, price, kind, track_stock, stock_qty, slug, publish_online, online_price, sku, active, has_variants) values
  ('00000000-0000-0000-0000-000000401001', '00000000-0000-0000-0000-0000000400a1', '00000000-0000-0000-0000-00000040b001', 'שקית בד', 50, 'product', true, 2, 'tote', true, 40, 'TOTE', true, false),
  ('00000000-0000-0000-0000-000000401002', '00000000-0000-0000-0000-0000000400a1', '00000000-0000-0000-0000-00000040b001', 'כובע', 60, 'product', true, 5, 'cap', true, 50, 'CAP', true, false);
insert into public.stores (id, business_id, name, phone) values
  ('00000000-0000-0000-0000-000000405001', '00000000-0000-0000-0000-00000040b001', 'Late', '03-5555555');
insert into public.payment_accounts (business_id, provider, mode, sealed, page_uid, hint) values
  ('00000000-0000-0000-0000-00000040b001', 'mock', 'live', 'v1.iv.tag.enc', 'page-40', 'cd34');
update public.stores set checkout_enabled = true, pickup_enabled = true where id = '00000000-0000-0000-0000-000000405001';
update public.platform_flags set enabled = true, updated_at = now() where key = 'commerce_live';

begin;
set local role service_role;
-- ---- 1. A holds both totes; its hold runs out before it pays; B buys one meanwhile and pays in time --------------------------
create temp table a as select pg_temp.order_of('A', '00000000-0000-0000-0000-000000401001', 2) as id;
select pg_temp.run_out((select id from a));
create temp table b as select pg_temp.order_of('B', '00000000-0000-0000-0000-000000401001', 1) as id;
select pg_temp.check((pg_temp.pay((select id from b), 'TX-B'))->>'status' = 'paid', 'B pays in time');
select pg_temp.check((select status from public.stock_reservations where order_id = (select id from a)) = 'held',
  'the cron has not come yet: A''s hold is still "held", past its time');

-- ---- 2. A pays now: taken; late (before the cron too); one tote missing, on the order and in the alert ----------------------
select pg_temp.check((pg_temp.pay((select id from a), 'TX-A'))->>'status' = 'paid', 'a payment after the hold is still taken');
select pg_temp.check((select stock_short from public.orders where id = (select id from a))
  = '[{"name": "שקית בד", "variant": "", "qty": 2, "available": 1}]'::jsonb, 'missing: 2 ordered, 1 free (B holds the other)');
select pg_temp.check((select body from public.store_alerts where order_id = (select id from a) and kind = 'late_payment')
  = 'התשלום הגיע אחרי שהשמירה על המלאי פגה. חסר במלאי: שקית בד — הוזמנו 2, יש 1. להשלים מלאי או להחזיר כסף על החסר.',
  'the owner is told what is missing');
select pg_temp.check((select data->>'late' = 'true' and data->>'short' = 'true' from public.order_events
  where order_id = (select id from a) and kind = 'paid'), 'the timeline says late — the same as the alert');
select pg_temp.check((select stock_short is null from public.orders where id = (select id from b)), 'B: nothing missing');
select pg_temp.check(not exists (select 1 from public.store_alerts where order_id = (select id from b) and kind = 'late_payment'), 'B: no late alert');
select pg_temp.check((select array_agg(status) = '{paid}' from public.stock_reservations where order_id = (select id from a)),
  'A''s hold is the order''s again, until its sale');

-- ---- 3. both sales: all their units — the stock is -1, the one tote owed to A ----------------------------------------------
select pg_temp.check((pg_temp.sale((select id from b)))->>'result' = 'ok', 'B''s sale');
select pg_temp.check((pg_temp.sale((select id from a)))->>'result' = 'ok', 'A''s sale');
select pg_temp.check(pg_temp.qty('00000000-0000-0000-0000-000000401001') = -1, 'stock -1: what A is owed, and no more');
select pg_temp.check(not exists (select 1 from public.stock_reservations where order_id in ((select id from a), (select id from b)) and status <> 'used'),
  'the holds are used by the sales');

-- ---- 4. late, after the cron, with enough stock: taken, nothing missing, and the alert says so ------------------------------
create temp table c as select pg_temp.order_of('C', '00000000-0000-0000-0000-000000401002', 2) as id;
select pg_temp.run_out((select id from c));
select pg_temp.check(public.store_release_expired() >= 1, 'the cron releases C''s hold');
select pg_temp.check((pg_temp.pay((select id from c), 'TX-C'))->>'status' = 'paid', 'C pays late');
select pg_temp.check((select stock_short is null from public.orders where id = (select id from c)), 'C: nothing missing (5 caps)');
select pg_temp.check((select body from public.store_alerts where order_id = (select id from c) and kind = 'late_payment')
  = 'התשלום הגיע אחרי שהשמירה על המלאי פגה — המלאי הספיק לכל הפריטים.', 'C: the alert says the stock was enough');
select pg_temp.check((select data->>'late' = 'true' and data->>'short' = 'false' from public.order_events
  where order_id = (select id from c) and kind = 'paid'), 'C: late, not short');
select pg_temp.check((pg_temp.sale((select id from c)))->>'result' = 'ok' and pg_temp.qty('00000000-0000-0000-0000-000000401002') = 3, 'C''s sale: 5 → 3');

-- ---- 5. in time: not late, no alert, nothing kept ---------------------------------------------------------------------------
create temp table d as select pg_temp.order_of('D', '00000000-0000-0000-0000-000000401002', 1) as id;
select pg_temp.check((pg_temp.pay((select id from d), 'TX-D'))->>'status' = 'paid', 'D pays in time');
select pg_temp.check((select stock_short is null from public.orders where id = (select id from d))
  and not exists (select 1 from public.store_alerts where order_id = (select id from d) and kind = 'late_payment')
  and (select data->>'late' = 'false' from public.order_events where order_id = (select id from d) and kind = 'paid'), 'D: on time');
commit;

select pg_temp.check(not has_function_privilege('anon', 'public.sf_order_paid(uuid, uuid, text, text, numeric, text)', 'execute'), 'anon may not call it');
select pg_temp.check(not has_function_privilege('authenticated', 'public.sf_order_paid(uuid, uuid, text, text, numeric, text)', 'execute'), 'nor an app user');
