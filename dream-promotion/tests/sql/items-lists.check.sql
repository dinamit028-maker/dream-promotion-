-- Advanced items and reports by location (migration 20261011004800, docs/FINANCE_ADDITIONS_HE.md T12ג + T12ד) on a real Postgres
-- (tests/sql/run.sh). The screens' calls run as the signed-in roles. Fixtures only, with ids of their own:
--   Shop IA (company)   owner OA; manager MA (full access, every location); manager ML (full access, limited to the branch L2);
--                       cashier KA (the main location); cashier KB (L2, register R2); viewer VA. Locations: the main one (its own
--                       id), the branch L2 (a store), the warehouse L3. Products: PHONE (serial numbers), SHIRT (S, M — serial
--                       numbers per variant), CREAM (no numbers), BAG (units in stock before it had numbers), SVC (a service),
--                       ONLINE (on the site).
--   Shop IB             owner OB, one location, product IBX.
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
create or replace function pg_temp.at(p_loc text, p_item text, p_variant text default null) returns int language sql as $$
  select public.stock_at(p_loc::uuid, p_item::uuid, p_variant::uuid) $$;
create or replace function pg_temp.total(p_item text) returns int language sql as $$
  select stock_qty from public.catalog_items where id = p_item::uuid $$;
-- a serial number's state: "<status>@<location>" (the location's first 8 characters are the same for every id here — the last 4)
create or replace function pg_temp.sn(p_item text, p_serial text) returns text language sql as $$
  select s.status || '@' || right(s.location_id::text, 4) from public.catalog_serials s where s.item_id = p_item::uuid and s.serial = p_serial $$;
create or replace function pg_temp.sn_id(p_item text, p_serial text) returns uuid language sql as $$
  select s.id from public.catalog_serials s where s.item_id = p_item::uuid and s.serial = p_serial $$;
-- the kinds of a serial number's history, in order
create or replace function pg_temp.history(p_item text, p_serial text) returns text language sql as $$
  select string_agg(e.kind, ',' order by e.id) from public.catalog_serial_events e join public.catalog_serials s on s.id = e.serial_id
   where s.item_id = p_item::uuid and s.serial = p_serial $$;
-- a sale of the register with its numbers (as the register writes it): one line, as many units as numbers unless p_qty says
create or replace function pg_temp.ssale(p_id text, p_user text, p_register text, p_item text, p_serials text[], p_variant text default null,
                                         p_qty int default null) returns uuid
language plpgsql as $$
declare r jsonb; cols text; id uuid; q int := coalesce(p_qty, cardinality(p_serials));
begin
  r := jsonb_build_object('id', p_id, 'user_id', p_user, 'subtotal', 10 * q, 'total', 10 * q, 'vat_rate', 18, 'vat_amount', 1,
    'method', 'cash', 'status', 'paid', 'paid_at', now(),
    'items', jsonb_build_array(jsonb_build_object('name', 'פריט', 'price', 10, 'qty', q, 'itemId', p_item, 'kind', 'product', 'serials', to_jsonb(p_serials))
                               || case when p_variant is not null then jsonb_build_object('variantId', p_variant) else '{}'::jsonb end));
  if p_register is not null then r := r || jsonb_build_object('register_id', p_register); end if;
  select string_agg(quote_ident(k), ', ') into cols from jsonb_object_keys(r) k;
  execute format('insert into public.sales (%s) select %s from jsonb_populate_record(null::public.sales, $1) returning id', cols, cols) using r into id;
  return id;
end $$;
-- a refund of a sale's units by number (₪1 each — the sales here are small)
create or replace function pg_temp.refund(p_id text, p_user text, p_sale text, p_item text, p_serials text[], p_restock boolean, p_qty int default null)
returns uuid language plpgsql as $$
declare id uuid; q int := coalesce(p_qty, cardinality(p_serials));
begin
  insert into public.sale_refunds (id, user_id, sale_id, amount, vat_amount, method, items, restock, reason)
  values (p_id::uuid, p_user::uuid, p_sale::uuid, 1, 0, 'cash',
          jsonb_build_array(jsonb_build_object('name', 'פריט', 'price', 1, 'qty', q, 'itemId', p_item, 'kind', 'product', 'serials', to_jsonb(p_serials))),
          p_restock, 'החזרה')
  returning sale_refunds.id into id;
  return id;
end $$;
-- a document with one line of a product (as the app sends it); its business follows its user
create or replace function pg_temp.doc(p_user text, p_type int, p_key text, p_item text, p_qty int, p_net numeric, p_extra jsonb default '{}')
returns uuid language plpgsql as $$
declare r jsonb; cols text; id uuid; net numeric := p_net * p_qty;
begin
  r := jsonb_build_object('user_id', p_user, 'doc_type', p_type, 'doc_number', 0, 'doc_date', public.il_today(), 'customer_name', 'לקוחה',
    'before_discount', net, 'discount', 0, 'after_discount', net, 'vat_amount', round(net * 0.18, 2), 'total', round(net * 1.18, 2), 'vat_rate', 18,
    'idempotency_key', p_key,
    'lines', jsonb_build_array(jsonb_build_object('name', 'פריט', 'qty', p_qty, 'unitPriceExVat', p_net, 'discountExVat', 0, 'totalExVat', net,
                                                   'vatRate', 18, 'kind', 1) || case when p_item is not null then jsonb_build_object('itemId', p_item) else '{}'::jsonb end
                                                   || coalesce(p_extra->'line', '{}'::jsonb)),
    'payments', case when p_type in (320, 400) then jsonb_build_array(jsonb_build_object('method', 1, 'amount', round(net * 1.18, 2), 'date', public.il_today()))
                     else '[]'::jsonb end) || (p_extra - 'line');
  select string_agg(quote_ident(k), ', ') into cols from jsonb_object_keys(r) k;
  execute format('insert into public.documents (%s) select %s from jsonb_populate_record(null::public.documents, $1) returning id', cols, cols) using r into id;
  return id;
end $$;

-- ---- the world ------------------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000e49a01', 'oa@items-a.test'), ('00000000-0000-0000-0000-000000e49a02', 'ma@items-a.test'), ('00000000-0000-0000-0000-000000e49a03', 'ml@items-a.test'), ('00000000-0000-0000-0000-000000e49a04', 'ka@items-a.test'),
  ('00000000-0000-0000-0000-000000e49a05', 'kb@items-a.test'), ('00000000-0000-0000-0000-000000e49a06', 'va@items-a.test'), ('00000000-0000-0000-0000-000000e49a07', 'ob@items-b.test');
insert into public.businesses (id, name, slug) values ('00000000-0000-0000-0000-000000e49b01', 'Shop IA', 'items-shop-a'), ('00000000-0000-0000-0000-000000e49b02', 'Shop IB', 'items-shop-b');
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-000000e49b01', '00000000-0000-0000-0000-000000e49a01', 'owner', 'full'), ('00000000-0000-0000-0000-000000e49b01', '00000000-0000-0000-0000-000000e49a02', 'editor', 'full'), ('00000000-0000-0000-0000-000000e49b01', '00000000-0000-0000-0000-000000e49a03', 'editor', 'full'), ('00000000-0000-0000-0000-000000e49b01', '00000000-0000-0000-0000-000000e49a04', 'editor', 'register'),
  ('00000000-0000-0000-0000-000000e49b01', '00000000-0000-0000-0000-000000e49a05', 'editor', 'register'), ('00000000-0000-0000-0000-000000e49b01', '00000000-0000-0000-0000-000000e49a06', 'viewer', 'full'), ('00000000-0000-0000-0000-000000e49b02', '00000000-0000-0000-0000-000000e49a07', 'owner', 'full');
update public.profiles set current_business_id = '00000000-0000-0000-0000-000000e49b01' where id in ('00000000-0000-0000-0000-000000e49a01', '00000000-0000-0000-0000-000000e49a02', '00000000-0000-0000-0000-000000e49a03', '00000000-0000-0000-0000-000000e49a04', '00000000-0000-0000-0000-000000e49a05', '00000000-0000-0000-0000-000000e49a06');
update public.profiles set current_business_id = '00000000-0000-0000-0000-000000e49b02' where id = '00000000-0000-0000-0000-000000e49a07';
insert into public.register_settings (user_id, business_id, business_type, vat_rate, dealer_number, legal_name, street, city, entity_type) values
  ('00000000-0000-0000-0000-000000e49a01', '00000000-0000-0000-0000-000000e49b01', 'licensed', 18, '514000020', 'חנות פריטים בע"מ', 'הרצל', 'תל אביב', 'company'),
  ('00000000-0000-0000-0000-000000e49a07', '00000000-0000-0000-0000-000000e49b02', 'licensed', 18, '514000038', 'חנות אחת בע"מ', 'הגפן', 'חיפה', 'company');
insert into public.business_locations (id, business_id, name, kind, sort) values
  ('00000000-0000-0000-0000-000000e49c02', '00000000-0000-0000-0000-000000e49b01', 'סניף דיזנגוף', 'store', 1), ('00000000-0000-0000-0000-000000e49c03', '00000000-0000-0000-0000-000000e49b01', 'מחסן', 'warehouse', 2);
insert into public.registers (id, business_id, location_id, name) values ('00000000-0000-0000-0000-000000e49d02', '00000000-0000-0000-0000-000000e49b01', '00000000-0000-0000-0000-000000e49c02', 'קופה 1');
update public.business_members set locations = array['00000000-0000-0000-0000-000000e49c02'::uuid] where business_id = '00000000-0000-0000-0000-000000e49b01' and user_id in ('00000000-0000-0000-0000-000000e49a03', '00000000-0000-0000-0000-000000e49a05');
update public.business_members set locations = array['00000000-0000-0000-0000-000000e49b01'::uuid] where business_id = '00000000-0000-0000-0000-000000e49b01' and user_id = '00000000-0000-0000-0000-000000e49a04';
insert into public.catalog_items (id, user_id, business_id, name, price, kind, track_stock, stock_qty, low_stock, slug, publish_online) values
  ('00000000-0000-0000-0000-000000e49f01', '00000000-0000-0000-0000-000000e49a01', '00000000-0000-0000-0000-000000e49b01', 'טלפון', 1000, 'product', true, 0, 1, 'phone', false),
  ('00000000-0000-0000-0000-000000e49f02', '00000000-0000-0000-0000-000000e49a01', '00000000-0000-0000-0000-000000e49b01', 'שרשרת', 100, 'product', true, 0, 1, 'necklace', false),
  ('00000000-0000-0000-0000-000000e49f03', '00000000-0000-0000-0000-000000e49a01', '00000000-0000-0000-0000-000000e49b01', 'קרם', 50, 'product', true, 0, 2, 'cream', false),
  ('00000000-0000-0000-0000-000000e49f04', '00000000-0000-0000-0000-000000e49a01', '00000000-0000-0000-0000-000000e49b01', 'תיק', 300, 'product', true, 0, 1, 'bag', false),
  ('00000000-0000-0000-0000-000000e49f05', '00000000-0000-0000-0000-000000e49a01', '00000000-0000-0000-0000-000000e49b01', 'תיקון', 200, 'service', false, 0, 0, 'repair', false),
  ('00000000-0000-0000-0000-000000e49f06', '00000000-0000-0000-0000-000000e49a01', '00000000-0000-0000-0000-000000e49b01', 'באתר', 80, 'product', true, 0, 1, 'online', true),
  ('00000000-0000-0000-0000-000000e49f07', '00000000-0000-0000-0000-000000e49a07', '00000000-0000-0000-0000-000000e49b02', 'מסכה', 90, 'product', true, 0, 1, 'mask', false);
insert into public.catalog_variants (id, item_id, business_id, option1) values ('00000000-0000-0000-0000-000000e49f21', '00000000-0000-0000-0000-000000e49f02', '00000000-0000-0000-0000-000000e49b01', 'זהב'), ('00000000-0000-0000-0000-000000e49f22', '00000000-0000-0000-0000-000000e49f02', '00000000-0000-0000-0000-000000e49b01', 'כסף');

-- ======================================================================================================================
-- 1. serial numbers on and off: a product of the shop, not on the site — and not while its units move in another way
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a01');
select pg_temp.refused_with($$select public.serial_tracking('00000000-0000-0000-0000-000000e49f05', true)$$, 'serial_kind', 'a service has no serial numbers');
select pg_temp.refused_with($$select public.serial_tracking('00000000-0000-0000-0000-000000e49f06', true)$$, 'serial_online', 'a product on the site gets no serial numbers (yet)');
select pg_temp.check((public.serial_tracking('00000000-0000-0000-0000-000000e49f01', true)->>'changed')::boolean, 'serial numbers on');
select pg_temp.check(not (public.serial_tracking('00000000-0000-0000-0000-000000e49f01', true)->>'changed')::boolean, 'on again changes nothing');
select pg_temp.check((select track_serials and track_stock from public.catalog_items where id = '00000000-0000-0000-0000-000000e49f01'), 'its stock is counted');
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a04');
select pg_temp.refused_with($$select public.serial_tracking('00000000-0000-0000-0000-000000e49f03', true)$$, 'not allowed', 'a cashier does not turn them on');
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a06');
select pg_temp.refused_with($$select public.serial_tracking('00000000-0000-0000-0000-000000e49f03', true)$$, 'not allowed', 'a viewer does not');
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a07');
select pg_temp.refused_with($$select public.serial_tracking('00000000-0000-0000-0000-000000e49f03', true)$$, 'not allowed', 'another business does not');
commit;
-- a product with numbers stays a product, counted, off the site
select pg_temp.refused_with($$update public.catalog_items set publish_online = true where id = '00000000-0000-0000-0000-000000e49f01'$$, 'catalog_items_serials_check', 'not published on the site');
select pg_temp.refused_with($$update public.catalog_items set kind = 'service' where id = '00000000-0000-0000-0000-000000e49f01'$$, 'catalog_items_serials_check', 'not a service');
select pg_temp.refused_with($$update public.catalog_items set track_stock = false where id = '00000000-0000-0000-0000-000000e49f01'$$, 'catalog_items_serials_check', 'its stock counted');
-- not while its units are counted in an open count, on the way, or held for an order of the site
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a01');
select public.stock_adjust('00000000-0000-0000-0000-000000e49b01', '00000000-0000-0000-0000-000000e49f03', null, 'add', 10);
select public.stock_count_start('00000000-0000-0000-0000-000000e49e11', '00000000-0000-0000-0000-000000e49b01');
select public.stock_count_set('00000000-0000-0000-0000-000000e49e11', '00000000-0000-0000-0000-000000e49f03', null, 10);
select pg_temp.refused_with($$select public.serial_tracking('00000000-0000-0000-0000-000000e49f03', true)$$, 'serial_counting', 'a product in an open stock count');
select public.stock_count_cancel('00000000-0000-0000-0000-000000e49e11');
select public.stock_transfer_send('00000000-0000-0000-0000-000000e49e01', '00000000-0000-0000-0000-000000e49b01', '00000000-0000-0000-0000-000000e49c02', '[{"itemId":"00000000-0000-0000-0000-000000e49f03","qty":2}]');
select pg_temp.refused_with($$select public.serial_tracking('00000000-0000-0000-0000-000000e49f03', true)$$, 'serial_on_the_way', 'a product on the way');
select public.stock_transfer_receive('00000000-0000-0000-0000-000000e49e01');
commit;
insert into public.stores (id, user_id, business_id, name, slug) values ('00000000-0000-0000-0000-000000e49801', '00000000-0000-0000-0000-000000e49a01', '00000000-0000-0000-0000-000000e49b01', 'החנות', 'items-shop-a-store');
insert into public.orders (id, business_id, store_id, number, token_hash, subtotal, total, customer_name, customer_phone, customer_email, delivery_method,
                           terms_accepted_at, provider, expires_at)
values ('00000000-0000-0000-0000-000000e49802', '00000000-0000-0000-0000-000000e49b01', '00000000-0000-0000-0000-000000e49801', 1, repeat('e', 64), 50, 50, 'קונה', '0501234567', 'buyer@items.test', 'pickup', now(), 'mock', now() + interval '15 minutes');
insert into public.stock_reservations (business_id, order_id, item_id, variant_id, qty, expires_at)
values ('00000000-0000-0000-0000-000000e49b01', '00000000-0000-0000-0000-000000e49802', '00000000-0000-0000-0000-000000e49f03', null, 1, now() + interval '15 minutes');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a01');
select pg_temp.refused_with($$select public.serial_tracking('00000000-0000-0000-0000-000000e49f03', true)$$, 'serial_reserved', 'units held for an order of the site');
commit;
update public.stock_reservations set status = 'released' where order_id = '00000000-0000-0000-0000-000000e49802';
select pg_temp.check(pg_temp.at('00000000-0000-0000-0000-000000e49b01', '00000000-0000-0000-0000-000000e49f03') = 8 and pg_temp.at('00000000-0000-0000-0000-000000e49c02', '00000000-0000-0000-0000-000000e49f03') = 2 and not (select track_serials from public.catalog_items where id = '00000000-0000-0000-0000-000000e49f03'),
  'the cream: 8 at the main location, 2 at the branch, no numbers');

-- ======================================================================================================================
-- 2. units come in with their numbers — new ones, and units that were in stock before
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a02');
select pg_temp.check(public.serial_receive('00000000-0000-0000-0000-000000e49f01', null, '00000000-0000-0000-0000-000000e49b01', array['P-001', ' P-002 ', 'P-003', ''], false, 'משלוח') = '{"count": 3, "stock": 3}'::jsonb,
  'three new units by number at the main location (trimmed, the empty line skipped)');
select pg_temp.refused_with($$select public.serial_receive('00000000-0000-0000-0000-000000e49f01', null, '00000000-0000-0000-0000-000000e49b01', array['p-001'])$$, 'serial_taken: p-001', 'a number the product has (any case)');
select pg_temp.refused_with($$select public.serial_receive('00000000-0000-0000-0000-000000e49f01', null, '00000000-0000-0000-0000-000000e49b01', array['X-1', 'x-1'])$$, 'serial_twice', 'the same number twice in one list');
select pg_temp.refused_with($$select public.serial_receive('00000000-0000-0000-0000-000000e49f01', null, '00000000-0000-0000-0000-000000e49b01', array[' '])$$, 'serial_list', 'no number');
select pg_temp.refused_with($$select public.serial_receive('00000000-0000-0000-0000-000000e49f01', null, '00000000-0000-0000-0000-000000e49b01', (select array_agg('N-' || g) from generate_series(1, 201) g))$$, 'serial_list', 'more than 200 at once');
select pg_temp.refused_with($$select public.serial_receive('00000000-0000-0000-0000-000000e49f01', null, '00000000-0000-0000-0000-000000e49b01', array[repeat('9', 65)])$$, 'serial_long', 'a number longer than 64');
select pg_temp.refused_with($$select public.serial_receive('00000000-0000-0000-0000-000000e49f03', null, '00000000-0000-0000-0000-000000e49b01', array['C-1'])$$, 'serial_untracked', 'a product without numbers');
select pg_temp.refused_with($$select public.serial_receive('00000000-0000-0000-0000-000000e49f01', '00000000-0000-0000-0000-000000e49f21', '00000000-0000-0000-0000-000000e49b01', array['V-1'])$$, 'variant_not_found', 'a variant of another product');
select pg_temp.refused_with($$select public.serial_receive('00000000-0000-0000-0000-000000e49f01', null, '00000000-0000-0000-0000-000000e49b02', array['V-1'])$$, 'stock_location', 'another business''s location');
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a03');
select pg_temp.refused_with($$select public.serial_receive('00000000-0000-0000-0000-000000e49f01', null, '00000000-0000-0000-0000-000000e49b01', array['P-100'])$$, 'not allowed', 'a manager of the branch, at the main location');
select pg_temp.check((public.serial_receive('00000000-0000-0000-0000-000000e49f01', null, '00000000-0000-0000-0000-000000e49c02', array['P-201', 'P-202'])->>'stock')::int = 2, 'a manager of the branch, at the branch');
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a04');
select pg_temp.refused_with($$select public.serial_receive('00000000-0000-0000-0000-000000e49f01', null, '00000000-0000-0000-0000-000000e49b01', array['P-100'])$$, 'not allowed', 'a cashier receives nothing');
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a06');
select pg_temp.refused_with($$select public.serial_receive('00000000-0000-0000-0000-000000e49f01', null, '00000000-0000-0000-0000-000000e49b01', array['P-100'])$$, 'not allowed', 'a viewer receives nothing');
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a01');
select public.serial_tracking('00000000-0000-0000-0000-000000e49f02', true);
select pg_temp.refused_with($$select public.serial_receive('00000000-0000-0000-0000-000000e49f02', null, '00000000-0000-0000-0000-000000e49c02', array['S-0'])$$, 'variant_required', 'a product with variants: by variant');
select public.serial_receive('00000000-0000-0000-0000-000000e49f02', '00000000-0000-0000-0000-000000e49f21', '00000000-0000-0000-0000-000000e49c02', array['S-1', 'S-2']);
select public.serial_receive('00000000-0000-0000-0000-000000e49f02', '00000000-0000-0000-0000-000000e49f22', '00000000-0000-0000-0000-000000e49b01', array['M-1']);
-- units already in stock get their numbers: no move, never more than the units without one
select public.stock_adjust('00000000-0000-0000-0000-000000e49b01', '00000000-0000-0000-0000-000000e49f04', null, 'add', 5);
select public.serial_tracking('00000000-0000-0000-0000-000000e49f04', true);
select pg_temp.check(public.serial_receive('00000000-0000-0000-0000-000000e49f04', null, '00000000-0000-0000-0000-000000e49b01', array['B-1', 'B-2'], true) = '{"count": 2, "stock": 5}'::jsonb, 'two units in stock get numbers; the stock stays');
select pg_temp.refused_with($$select public.serial_receive('00000000-0000-0000-0000-000000e49f04', null, '00000000-0000-0000-0000-000000e49b01', array['B-3', 'B-4', 'B-5', 'B-6'], true)$$, 'serial_more_than_stock: 3', 'more numbers than units without one');
select public.serial_receive('00000000-0000-0000-0000-000000e49f04', null, '00000000-0000-0000-0000-000000e49b01', array['B-3', 'B-4', 'B-5'], true);
select pg_temp.refused_with($$select public.serial_receive('00000000-0000-0000-0000-000000e49f04', null, '00000000-0000-0000-0000-000000e49b01', array['B-6'], true)$$, 'serial_more_than_stock: 0', 'every unit has its number');
commit;
select pg_temp.check(pg_temp.total('00000000-0000-0000-0000-000000e49f01') = 5 and pg_temp.at('00000000-0000-0000-0000-000000e49b01', '00000000-0000-0000-0000-000000e49f01') = 3 and pg_temp.at('00000000-0000-0000-0000-000000e49c02', '00000000-0000-0000-0000-000000e49f01') = 2, 'the phones: 3 at the main location, 2 at the branch');
select pg_temp.check(pg_temp.sn('00000000-0000-0000-0000-000000e49f01', 'P-002') = 'in_stock@' || right('00000000-0000-0000-0000-000000e49b01', 4) and pg_temp.history('00000000-0000-0000-0000-000000e49f01', 'P-002') = 'received'
  and (select received_by = '00000000-0000-0000-0000-000000e49a02' from public.catalog_serials where item_id = '00000000-0000-0000-0000-000000e49f01' and serial = 'P-002'), 'each unit in stock where it came in, its history, who received it');
select pg_temp.check((select count(*) = 1 and min(note) = 'קליטה · P-001, P-002, P-003 · משלוח' and min(delta) = 3 and min(reason) = 'receive'
                        from public.stock_movements where item_id = '00000000-0000-0000-0000-000000e49f01' and location_id = '00000000-0000-0000-0000-000000e49b01'), 'one delivery move, its numbers in the note');
select pg_temp.check(pg_temp.total('00000000-0000-0000-0000-000000e49f04') = 5 and (select count(*) = 1 from public.stock_movements where item_id = '00000000-0000-0000-0000-000000e49f04')
  and pg_temp.history('00000000-0000-0000-0000-000000e49f04', 'B-1') = 'registered', 'registering numbers moved nothing');
select pg_temp.check(pg_temp.at('00000000-0000-0000-0000-000000e49c02', '00000000-0000-0000-0000-000000e49f02', '00000000-0000-0000-0000-000000e49f21') = 2 and pg_temp.at('00000000-0000-0000-0000-000000e49b01', '00000000-0000-0000-0000-000000e49f02', '00000000-0000-0000-0000-000000e49f22') = 1 and pg_temp.total('00000000-0000-0000-0000-000000e49f02') = 3, 'the necklace by variant and location');

-- ======================================================================================================================
-- 3. a product with numbers moves only with them — undoing a move of before it had numbers still works
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a01');
select pg_temp.refused_with($$select public.stock_adjust('00000000-0000-0000-0000-000000e49b01', '00000000-0000-0000-0000-000000e49f01', null, 'add', 1)$$, 'serial_item', 'a delivery without numbers');
select pg_temp.refused_with($$select public.stock_adjust('00000000-0000-0000-0000-000000e49b01', '00000000-0000-0000-0000-000000e49f01', null, 'set', 1)$$, 'serial_item', 'a count on the spot');
select pg_temp.refused_with($$select public.adjust_stock('00000000-0000-0000-0000-000000e49f01', 'add', 1)$$, 'serial_item', 'the screens of before 2.92');
select pg_temp.refused_with($$select public.adjust_variant_stock('00000000-0000-0000-0000-000000e49f21', 'add', 1)$$, 'serial_item', 'a variant''s delivery');
select public.stock_count_start('00000000-0000-0000-0000-000000e49e12', '00000000-0000-0000-0000-000000e49b01');
select pg_temp.refused_with($$select public.stock_count_set('00000000-0000-0000-0000-000000e49e12', '00000000-0000-0000-0000-000000e49f01', null, 3)$$, 'count_serial', 'a stock count does not count it');
select pg_temp.check(public.stock_count_set('00000000-0000-0000-0000-000000e49e12', '00000000-0000-0000-0000-000000e49f01', null, null) is not null, 'taking its line off is fine');
select public.stock_count_cancel('00000000-0000-0000-0000-000000e49e12');
select pg_temp.refused_with($$select public.stock_transfer_send('00000000-0000-0000-0000-000000e49e09', '00000000-0000-0000-0000-000000e49b01', '00000000-0000-0000-0000-000000e49c02', '[{"itemId":"00000000-0000-0000-0000-000000e49f01","qty":1}]')$$, 'transfer_serials', 'a transfer without its numbers');
commit;
select pg_temp.refused_with($$select pg_temp.doc('00000000-0000-0000-0000-000000e49a01', 300, 'il-300-phone', '00000000-0000-0000-0000-000000e49f01', 1, 1000)$$, 'serial_item', 'a document of it');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a01');
insert into public.expenses (id, user_id, supplier_name, doc_date, category, amount_before_vat, vat_amount, total, paid_on, payment_method, stock_lines)
values ('00000000-0000-0000-0000-000000e49701', '00000000-0000-0000-0000-000000e49a01', 'ספק', public.il_today(), 'inventory', 100, 18, 118, public.il_today(), 'transfer', '[{"itemId":"00000000-0000-0000-0000-000000e49f01","qty":1}]');
select pg_temp.refused_with($$select public.receive_expense_stock('00000000-0000-0000-0000-000000e49701')$$, 'serial_item', 'a delivery with an expense');
rollback;
-- the cream: a document and an expense move it, then it gets numbers, then they are undone — the units come back (without numbers)
select pg_temp.doc('00000000-0000-0000-0000-000000e49a01', 300, 'il-300-cream', '00000000-0000-0000-0000-000000e49f03', 1, 50, jsonb_build_object('location_id', '00000000-0000-0000-0000-000000e49b01'));
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a01');
insert into public.expenses (id, user_id, supplier_name, doc_date, category, amount_before_vat, vat_amount, total, paid_on, payment_method, stock_lines, location_id)
values ('00000000-0000-0000-0000-000000e49702', '00000000-0000-0000-0000-000000e49a01', 'ספק קרמים', public.il_today(), 'inventory', 60, 0, 60, public.il_today(), 'transfer', '[{"itemId":"00000000-0000-0000-0000-000000e49f03","qty":2}]', '00000000-0000-0000-0000-000000e49b01');
select public.receive_expense_stock('00000000-0000-0000-0000-000000e49702');
select public.serial_tracking('00000000-0000-0000-0000-000000e49f03', true);
commit;
select pg_temp.check(pg_temp.at('00000000-0000-0000-0000-000000e49b01', '00000000-0000-0000-0000-000000e49f03') = 9, 'the cream: 8 − 1 (the document) + 2 (the expense)');
insert into public.document_cancellations (document_id, user_id, reason)
values ((select id from public.documents where idempotency_key = 'il-300-cream'), '00000000-0000-0000-0000-000000e49a01', 'הופקה בטעות');
update public.expenses set status = 'void', void_reason = 'נרשם פעמיים' where id = '00000000-0000-0000-0000-000000e49702';
select pg_temp.check(pg_temp.at('00000000-0000-0000-0000-000000e49b01', '00000000-0000-0000-0000-000000e49f03') = 8, 'its document''s cancellation and its expense''s void moved it back');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a01');
select pg_temp.check((public.serial_tracking('00000000-0000-0000-0000-000000e49f03', false)->>'changed')::boolean, 'off again — no unit of it had a number');
commit;

-- ======================================================================================================================
-- 4. the register sells by number: in stock at its location, and once (the DoD)
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a04');
select pg_temp.ssale('00000000-0000-0000-0000-000000e49501', '00000000-0000-0000-0000-000000e49a04', null, '00000000-0000-0000-0000-000000e49f01', array['P-001']);
commit;
select pg_temp.check(pg_temp.sn('00000000-0000-0000-0000-000000e49f01', 'P-001') = 'sold@' || right('00000000-0000-0000-0000-000000e49b01', 4) and (select sale_id = '00000000-0000-0000-0000-000000e49501' from public.catalog_serials where serial = 'P-001')
  and pg_temp.at('00000000-0000-0000-0000-000000e49b01', '00000000-0000-0000-0000-000000e49f01') = 2 and pg_temp.history('00000000-0000-0000-0000-000000e49f01', 'P-001') = 'received,sold', 'P-001 sold: the sale holds it, the main location has 2');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a04');
select pg_temp.refused_with($$select pg_temp.ssale('00000000-0000-0000-0000-000000e49502', '00000000-0000-0000-0000-000000e49a04', null, '00000000-0000-0000-0000-000000e49f01', array['p-001'])$$, 'serial_sold: p-001', 'a number sold is not sold again (DoD)');
select pg_temp.refused_with($$select pg_temp.ssale('00000000-0000-0000-0000-000000e49502', '00000000-0000-0000-0000-000000e49a04', null, '00000000-0000-0000-0000-000000e49f01', array['P-002', 'P-002'])$$, 'serial_sold: P-002', 'nor twice in one sale');
select pg_temp.refused_with($$select pg_temp.ssale('00000000-0000-0000-0000-000000e49502', '00000000-0000-0000-0000-000000e49a04', null, '00000000-0000-0000-0000-000000e49f01', array[]::text[], null, 1)$$, 'serial_required', 'a unit with no number');
select pg_temp.refused_with($$select pg_temp.ssale('00000000-0000-0000-0000-000000e49502', '00000000-0000-0000-0000-000000e49a04', null, '00000000-0000-0000-0000-000000e49f01', array['P-002'], null, 2)$$, 'serial_required', 'two units, one number');
select pg_temp.refused_with($$select pg_temp.ssale('00000000-0000-0000-0000-000000e49502', '00000000-0000-0000-0000-000000e49a04', null, '00000000-0000-0000-0000-000000e49f01', array['NOPE'])$$, 'serial_not_found: NOPE', 'a number the product does not have');
select pg_temp.refused_with($$select pg_temp.ssale('00000000-0000-0000-0000-000000e49502', '00000000-0000-0000-0000-000000e49a04', null, '00000000-0000-0000-0000-000000e49f02', array['M-1'], '00000000-0000-0000-0000-000000e49f21')$$, 'serial_variant: M-1', 'a number of another variant');
select pg_temp.refused_with($$select pg_temp.ssale('00000000-0000-0000-0000-000000e49502', '00000000-0000-0000-0000-000000e49a04', null, '00000000-0000-0000-0000-000000e49f01', array['P-201'])$$, 'serial_elsewhere: P-201', 'a number in stock at another location');
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a05');
select pg_temp.ssale('00000000-0000-0000-0000-000000e49504', '00000000-0000-0000-0000-000000e49a05', '00000000-0000-0000-0000-000000e49d02', '00000000-0000-0000-0000-000000e49f01', array['P-201']);
commit;
select pg_temp.check(pg_temp.sn('00000000-0000-0000-0000-000000e49f01', 'P-002') = 'in_stock@' || right('00000000-0000-0000-0000-000000e49b01', 4) and pg_temp.at('00000000-0000-0000-0000-000000e49c02', '00000000-0000-0000-0000-000000e49f01') = 1 and pg_temp.sn('00000000-0000-0000-0000-000000e49f01', 'P-201') = 'sold@' || right('00000000-0000-0000-0000-000000e49c02', 4),
  'what was refused moved nothing; the branch sold its own P-201');
-- the site names no number (its products have none; an order is never refused once paid): the units go, the numbers stay
begin;
insert into public.sales (id, user_id, business_id, location_id, items, subtotal, total, vat_rate, vat_amount, method, status, paid_at, channel)
values ('00000000-0000-0000-0000-000000e49509', '00000000-0000-0000-0000-000000e49a01', '00000000-0000-0000-0000-000000e49b01', '00000000-0000-0000-0000-000000e49b01', '[{"name":"טלפון","price":10,"qty":1,"itemId":"00000000-0000-0000-0000-000000e49f01","kind":"product"}]', 10, 10, 18, 1.53, 'card', 'paid', now(), 'online');
select pg_temp.check(pg_temp.at('00000000-0000-0000-0000-000000e49b01', '00000000-0000-0000-0000-000000e49f01') = 1 and (select count(*) = 0 from public.catalog_serials where sale_id = '00000000-0000-0000-0000-000000e49509'), 'an order of the site: no number taken');
rollback;

-- ======================================================================================================================
-- 5. a cancelled sale: its numbers back in stock where it was sold
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a01');
update public.sales set status = 'cancelled' where id = '00000000-0000-0000-0000-000000e49501';
commit;
select pg_temp.check(pg_temp.sn('00000000-0000-0000-0000-000000e49f01', 'P-001') = 'in_stock@' || right('00000000-0000-0000-0000-000000e49b01', 4) and (select sale_id is null from public.catalog_serials where serial = 'P-001')
  and pg_temp.at('00000000-0000-0000-0000-000000e49b01', '00000000-0000-0000-0000-000000e49f01') = 3 and pg_temp.history('00000000-0000-0000-0000-000000e49f01', 'P-001') = 'received,sold,cancelled', 'P-001 back in stock at the main location');

-- ======================================================================================================================
-- 6. a refund names the numbers that came back — each one of that sale
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a04');
select pg_temp.ssale('00000000-0000-0000-0000-000000e49503', '00000000-0000-0000-0000-000000e49a04', null, '00000000-0000-0000-0000-000000e49f01', array['P-001', 'P-002']);
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a01');
select pg_temp.refused_with($$select pg_temp.refund('00000000-0000-0000-0000-000000e49511', '00000000-0000-0000-0000-000000e49a01', '00000000-0000-0000-0000-000000e49503', '00000000-0000-0000-0000-000000e49f01', array[]::text[], true, 1)$$, 'serial_required', 'which unit came back');
select pg_temp.refused_with($$select pg_temp.refund('00000000-0000-0000-0000-000000e49511', '00000000-0000-0000-0000-000000e49a01', '00000000-0000-0000-0000-000000e49503', '00000000-0000-0000-0000-000000e49f01', array['P-003'], true)$$, 'serial_not_in_sale: P-003', 'a number not of that sale');
select pg_temp.refund('00000000-0000-0000-0000-000000e49511', '00000000-0000-0000-0000-000000e49a01', '00000000-0000-0000-0000-000000e49503', '00000000-0000-0000-0000-000000e49f01', array['p-002'], true);
select pg_temp.refund('00000000-0000-0000-0000-000000e49512', '00000000-0000-0000-0000-000000e49a01', '00000000-0000-0000-0000-000000e49503', '00000000-0000-0000-0000-000000e49f01', array['P-001'], false);
select pg_temp.refused_with($$select pg_temp.refund('00000000-0000-0000-0000-000000e49513', '00000000-0000-0000-0000-000000e49a01', '00000000-0000-0000-0000-000000e49503', '00000000-0000-0000-0000-000000e49f01', array['P-001'], true)$$, 'serial_not_in_sale: P-001', 'a number that came back already');
commit;
select pg_temp.check(pg_temp.sn('00000000-0000-0000-0000-000000e49f01', 'P-002') = 'in_stock@' || right('00000000-0000-0000-0000-000000e49b01', 4) and pg_temp.sn('00000000-0000-0000-0000-000000e49f01', 'P-001') = 'returned@' || right('00000000-0000-0000-0000-000000e49b01', 4)
  and pg_temp.at('00000000-0000-0000-0000-000000e49b01', '00000000-0000-0000-0000-000000e49f01') = 2, 'P-002 back in stock; P-001 returned, not in stock (2 at the main location: P-002, P-003)');
select pg_temp.check((select string_agg(e.kind || ':' || coalesce(e.refund_id::text, '-') || ':' || e.note, ' | ' order by e.id) from public.catalog_serial_events e
                       join public.catalog_serials s on s.id = e.serial_id where s.item_id = '00000000-0000-0000-0000-000000e49f01' and s.serial = 'P-001' and e.kind = 'returned')
  = 'returned:00000000-0000-0000-0000-000000e49512:לא חזר למלאי',
  'the history says which refund, and that it did not go back to stock');

-- ======================================================================================================================
-- 7. writing a unit off: the owner only, with a reason
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a02');
select pg_temp.refused_with(format('select public.serial_remove(%L, %L)', pg_temp.sn_id('00000000-0000-0000-0000-000000e49f01', 'P-002'), 'נשבר'), 'the owner counts', 'a manager does not write a unit off');
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a01');
select pg_temp.refused_with(format('select public.serial_remove(%L, %L)', pg_temp.sn_id('00000000-0000-0000-0000-000000e49f01', 'P-002'), ' '), 'serial_reason', 'a reason');
select public.serial_remove(pg_temp.sn_id('00000000-0000-0000-0000-000000e49f01', 'P-002'), 'נשבר');
select pg_temp.refused_with(format('select public.serial_remove(%L, %L)', pg_temp.sn_id('00000000-0000-0000-0000-000000e49f01', 'P-002'), 'שוב'), 'serial_not_in_stock', 'once');
select pg_temp.refused_with($$select public.serial_tracking('00000000-0000-0000-0000-000000e49f01', false)$$, 'serial_in_stock', 'off only with no unit in stock by number');
commit;
select pg_temp.check(pg_temp.sn('00000000-0000-0000-0000-000000e49f01', 'P-002') = 'removed@' || right('00000000-0000-0000-0000-000000e49b01', 4) and pg_temp.at('00000000-0000-0000-0000-000000e49b01', '00000000-0000-0000-0000-000000e49f01') = 1
  and (select count(*) = 1 from public.stock_movements where item_id = '00000000-0000-0000-0000-000000e49f01' and reason = 'adjust' and delta = -1 and note = 'הוצאה · P-002 · נשבר'),
  'written off: one move with its number and reason');

-- ======================================================================================================================
-- 8. transfers by number: on the way, received (a number missing — with its reason), cancelled
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a01');
select public.stock_transfer_send('00000000-0000-0000-0000-000000e49e02', '00000000-0000-0000-0000-000000e49b01', '00000000-0000-0000-0000-000000e49c02', '[{"itemId":"00000000-0000-0000-0000-000000e49f01","qty":1,"serials":["P-003"]}]');
select pg_temp.refused_with($$select public.stock_transfer_send('00000000-0000-0000-0000-000000e49e03', '00000000-0000-0000-0000-000000e49b01', '00000000-0000-0000-0000-000000e49c02', '[{"itemId":"00000000-0000-0000-0000-000000e49f01","qty":2,"serials":["P-003"]}]')$$, 'transfer_serials', 'as many numbers as units');
select pg_temp.refused_with($$select public.stock_transfer_send('00000000-0000-0000-0000-000000e49e03', '00000000-0000-0000-0000-000000e49b01', '00000000-0000-0000-0000-000000e49c02', '[{"itemId":"00000000-0000-0000-0000-000000e49f01","qty":1,"serials":["P-202"]}]')$$, 'serial_elsewhere: P-202', 'a number at another location');
select pg_temp.refused_with($$select public.stock_transfer_send('00000000-0000-0000-0000-000000e49e03', '00000000-0000-0000-0000-000000e49c02', '00000000-0000-0000-0000-000000e49b01', '[{"itemId":"00000000-0000-0000-0000-000000e49f01","qty":1,"serials":["P-201"]}]')$$, 'serial_sold: P-201', 'a number sold');
select pg_temp.refused_with($$select public.stock_transfer_send('00000000-0000-0000-0000-000000e49e03', '00000000-0000-0000-0000-000000e49b01', '00000000-0000-0000-0000-000000e49c02', '[{"itemId":"00000000-0000-0000-0000-000000e49f01","qty":1,"serials":["ZZZ"]}]')$$, 'serial_not_found: ZZZ', 'a number the product does not have');
select pg_temp.refused_with($$select public.stock_transfer_send('00000000-0000-0000-0000-000000e49e03', '00000000-0000-0000-0000-000000e49b01', '00000000-0000-0000-0000-000000e49c02', '[{"itemId":"00000000-0000-0000-0000-000000e49f01","qty":1,"serials":["P-001"]}]')$$, 'serial_not_in_stock: P-001', 'a number returned, not in stock');
select pg_temp.refused_with(format('select public.serial_remove(%L, %L)', pg_temp.sn_id('00000000-0000-0000-0000-000000e49f01', 'P-003'), 'אבד'), 'serial_not_in_stock', 'a unit on the way is not written off');
select pg_temp.refused_with($$select public.serial_tracking('00000000-0000-0000-0000-000000e49f01', false)$$, 'serial_in_stock', 'nor are the numbers turned off');
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a04');
select pg_temp.refused_with($$select pg_temp.ssale('00000000-0000-0000-0000-000000e49505', '00000000-0000-0000-0000-000000e49a04', null, '00000000-0000-0000-0000-000000e49f01', array['P-003'])$$, 'serial_not_in_stock: P-003', 'nor sold');
commit;
select pg_temp.check(pg_temp.sn('00000000-0000-0000-0000-000000e49f01', 'P-003') = 'in_transit@' || right('00000000-0000-0000-0000-000000e49b01', 4) and pg_temp.at('00000000-0000-0000-0000-000000e49b01', '00000000-0000-0000-0000-000000e49f01') = 0
  and (select lines->0->'serials' = '["P-003"]'::jsonb from public.stock_transfers where id = '00000000-0000-0000-0000-000000e49e02'), 'P-003 on the way; the transfer names it');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a03');
select pg_temp.refused_with($$select public.stock_transfer_receive('00000000-0000-0000-0000-000000e49e02', '[{"itemId":"00000000-0000-0000-0000-000000e49f01","missing":["P-999"],"reason":"x"}]')$$, 'transfer_serial_missing', 'a missing number not on the line');
select pg_temp.refused_with($$select public.stock_transfer_receive('00000000-0000-0000-0000-000000e49e02', '[{"itemId":"00000000-0000-0000-0000-000000e49f01","received":0,"reason":"x"}]')$$, 'transfer_serial_missing', 'fewer by number: name the ones missing');
select public.stock_transfer_receive('00000000-0000-0000-0000-000000e49e02');
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a01');
select public.stock_transfer_send('00000000-0000-0000-0000-000000e49e04', '00000000-0000-0000-0000-000000e49c02', '00000000-0000-0000-0000-000000e49c03', '[{"itemId":"00000000-0000-0000-0000-000000e49f02","variantId":"00000000-0000-0000-0000-000000e49f21","qty":2,"serials":["S-1","s-2"]}]');
select pg_temp.refused_with($$select public.stock_transfer_receive('00000000-0000-0000-0000-000000e49e04', '[{"itemId":"00000000-0000-0000-0000-000000e49f02","variantId":"00000000-0000-0000-0000-000000e49f21","missing":["S-2"],"reason":" "}]')$$, 'transfer_gap_reason', 'a number missing needs its reason');
select public.stock_transfer_receive('00000000-0000-0000-0000-000000e49e04', '[{"itemId":"00000000-0000-0000-0000-000000e49f02","variantId":"00000000-0000-0000-0000-000000e49f21","missing":["s-2"],"reason":"נאבד בדרך"}]');
select public.stock_transfer_send('00000000-0000-0000-0000-000000e49e05', '00000000-0000-0000-0000-000000e49c02', '00000000-0000-0000-0000-000000e49b01', '[{"itemId":"00000000-0000-0000-0000-000000e49f01","qty":1,"serials":["P-003"]}]');
select public.stock_transfer_cancel('00000000-0000-0000-0000-000000e49e05', 'טעות');
commit;
select pg_temp.check(pg_temp.sn('00000000-0000-0000-0000-000000e49f01', 'P-003') = 'in_stock@' || right('00000000-0000-0000-0000-000000e49c02', 4) and pg_temp.at('00000000-0000-0000-0000-000000e49c02', '00000000-0000-0000-0000-000000e49f01') = 2
  and pg_temp.history('00000000-0000-0000-0000-000000e49f01', 'P-003') = 'received,transfer_sent,transfer_received,transfer_sent,transfer_cancelled',
  'P-003 arrived at the branch; sent on, cancelled — back at the branch');
select pg_temp.check(pg_temp.sn('00000000-0000-0000-0000-000000e49f02', 'S-1') = 'in_stock@' || right('00000000-0000-0000-0000-000000e49c03', 4) and pg_temp.sn('00000000-0000-0000-0000-000000e49f02', 'S-2') = 'removed@' || right('00000000-0000-0000-0000-000000e49c03', 4)
  and pg_temp.at('00000000-0000-0000-0000-000000e49c03', '00000000-0000-0000-0000-000000e49f02', '00000000-0000-0000-0000-000000e49f21') = 1 and pg_temp.at('00000000-0000-0000-0000-000000e49c02', '00000000-0000-0000-0000-000000e49f02', '00000000-0000-0000-0000-000000e49f21') = 0 and pg_temp.total('00000000-0000-0000-0000-000000e49f02') = 2,
  'S-1 at the warehouse; S-2 did not arrive — out of the stock');
select pg_temp.check((select string_agg(x, ' | ' order by x) from (select location_id::text || ':' || reason || ':' || delta as x from public.stock_movements
                                                                      where transfer_id = '00000000-0000-0000-0000-000000e49e04') m)
  = '00000000-0000-0000-0000-000000e49c02:transfer:-2 | 00000000-0000-0000-0000-000000e49c03:adjust:-1 | 00000000-0000-0000-0000-000000e49c03:transfer:2', 'its moves: out of the branch, into the warehouse, the difference with its reason');
select pg_temp.check((select lines->0->'serials' = '["S-1", "S-2"]'::jsonb and lines->0->>'received' = '1' and lines->0->'missing' = '["S-2"]'::jsonb
                             and lines->0->>'reason' = 'נאבד בדרך' from public.stock_transfers where id = '00000000-0000-0000-0000-000000e49e04'),
  'the transfer keeps its numbers as the product has them, what arrived and what did not');
select pg_temp.check((select note = 'לא הגיע בהעברה ' || (select number from public.stock_transfers where id = '00000000-0000-0000-0000-000000e49e04') || ': נאבד בדרך' from public.catalog_serial_events e
                       where e.serial_id = pg_temp.sn_id('00000000-0000-0000-0000-000000e49f02', 'S-2') and e.kind = 'transfer_missing'), 'the missing number''s history says why');

-- ======================================================================================================================
-- 9. who sees what: the business's own (a cashier too — the register needs them); written only through the functions
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a04');
select pg_temp.check((select count(*) from public.catalog_serials) = 13 and (select count(*) > 0 from public.catalog_serial_events), 'a cashier reads the numbers and their history');
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a07');
select pg_temp.check((select count(*) from public.catalog_serials) = 0 and (select count(*) from public.catalog_serial_events) = 0, 'another business reads none');
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a01');
select pg_temp.refused_with($$insert into public.catalog_serials (business_id, item_id, serial, location_id) values ('00000000-0000-0000-0000-000000e49b01', '00000000-0000-0000-0000-000000e49f01', 'X', '00000000-0000-0000-0000-000000e49b01')$$, 'permission denied', 'no number written directly');
select pg_temp.refused_with($$update public.catalog_serials set status = 'in_stock'$$, 'permission denied', 'no number changed directly');
select pg_temp.refused_with($$delete from public.catalog_serial_events$$, 'permission denied', 'no history deleted');
commit;

-- ======================================================================================================================
-- 10. price lists: a location's, a customer group's (a tag of the CRM); their prices per product or variant
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a01');
select pg_temp.check((public.price_list_save('00000000-0000-0000-0000-000000e49811', 'סניף דיזנגוף', 'location', '00000000-0000-0000-0000-000000e49c02', null, true, 1)->>'created')::boolean, 'a location''s list');
select pg_temp.check(not (public.price_list_save('00000000-0000-0000-0000-000000e49811', 'מחירון דיזנגוף', 'group', null, 'x', true, 1)->>'created')::boolean, 'the same id again: the same list, renamed');
select pg_temp.check((select name = 'מחירון דיזנגוף' and kind = 'location' and location_id = '00000000-0000-0000-0000-000000e49c02' and tag is null from public.price_lists where id = '00000000-0000-0000-0000-000000e49811'),
  'its kind and location never change');
select public.price_list_save('00000000-0000-0000-0000-000000e49812', 'סיטונאי', 'group', null, ' סיטונאי ', true, 2);
select pg_temp.check((select tag = 'סיטונאי' from public.price_lists where id = '00000000-0000-0000-0000-000000e49812'), 'a group''s list by its tag (trimmed)');
select pg_temp.refused_with($$select public.price_list_save('00000000-0000-0000-0000-000000e49813', 'סיטונאי 2', 'group', null, 'סיטונאי', true, 3)$$, 'price_lists_tag_uq', 'one active list a tag');
select pg_temp.refused_with($$select public.price_list_save('00000000-0000-0000-0000-000000e49813', 'עוד אחד', 'location', '00000000-0000-0000-0000-000000e49c02', null, true, 3)$$, 'price_lists_location_uq', 'one active list a location');
select pg_temp.refused_with($$select public.price_list_save('00000000-0000-0000-0000-000000e49813', 'סיטונאי', 'group', null, 'vip', true, 3)$$, 'price_lists_name_uq', 'a name once');
select pg_temp.refused_with($$select public.price_list_save('00000000-0000-0000-0000-000000e49813', 'x', 'group', null, ' ', true, 3)$$, 'price_list_tag', 'a group needs its tag');
select pg_temp.refused_with($$select public.price_list_save('00000000-0000-0000-0000-000000e49813', ' ', 'group', null, 'vip', true, 3)$$, 'price_list_name', 'a name');
select pg_temp.refused_with($$select public.price_list_save('00000000-0000-0000-0000-000000e49813', 'x', 'vip', null, 'vip', true, 3)$$, 'price_list_kind', 'a location''s or a group''s');
select pg_temp.refused_with($$select public.price_list_save('00000000-0000-0000-0000-000000e49813', 'x', 'location', '00000000-0000-0000-0000-000000e49b02', null, true, 3)$$, 'stock_location', 'a location of the business');
select pg_temp.refused_with($$select public.price_list_save(null, 'x', 'group', null, 'vip', true, 3)$$, 'price_list_id', 'an id from the screen');
select pg_temp.check((public.price_list_set('00000000-0000-0000-0000-000000e49812', '[{"itemId":"00000000-0000-0000-0000-000000e49f03","price":"40"},{"itemId":"00000000-0000-0000-0000-000000e49f02","variantId":"00000000-0000-0000-0000-000000e49f21","price":90.5}]')->>'lines')::int = 2, 'two prices');
select pg_temp.check((public.price_list_set('00000000-0000-0000-0000-000000e49812', '[{"itemId":"00000000-0000-0000-0000-000000e49f03","price":38}]')->>'lines')::int = 1, 'a price changed');
select pg_temp.check((select string_agg(coalesce(variant_id::text, '-') || '=' || price, ' ' order by price) from public.price_list_items where list_id = '00000000-0000-0000-0000-000000e49812')
  = '-=38.00 00000000-0000-0000-0000-000000e49f21=90.50', 'one row a product / variant');
select public.price_list_set('00000000-0000-0000-0000-000000e49812', '[{"itemId":"00000000-0000-0000-0000-000000e49f03","price":null}]');
select pg_temp.check((select count(*) = 1 from public.price_list_items where list_id = '00000000-0000-0000-0000-000000e49812'), 'null takes a price off (the base price again)');
select pg_temp.refused_with($$select public.price_list_set('00000000-0000-0000-0000-000000e49812', '[{"itemId":"00000000-0000-0000-0000-000000e49f03","price":-1}]')$$, 'price_list_price', 'not below zero');
select pg_temp.refused_with($$select public.price_list_set('00000000-0000-0000-0000-000000e49812', '[{"itemId":"00000000-0000-0000-0000-000000e49f03","price":"1.234"}]')$$, 'price_list_price', 'shekels and agorot');
select pg_temp.refused_with($$select public.price_list_set('00000000-0000-0000-0000-000000e49812', '[{"itemId":"00000000-0000-0000-0000-000000e49f03","price":"abc"}]')$$, 'price_list_price', 'a number');
select pg_temp.refused_with($$select public.price_list_set('00000000-0000-0000-0000-000000e49812', '[{"itemId":"00000000-0000-0000-0000-000000e49f07","price":1}]')$$, 'price_list_item', 'a product of the business');
select pg_temp.refused_with($$select public.price_list_set('00000000-0000-0000-0000-000000e49812', '[{"itemId":"00000000-0000-0000-0000-000000e49f03","variantId":"00000000-0000-0000-0000-000000e49f21","price":1}]')$$, 'variant_not_found', 'a variant of that product');
select pg_temp.refused_with($$select public.price_list_set('00000000-0000-0000-0000-000000e49812', '[]')$$, 'price_list_lines', 'at least one line');
select pg_temp.refused_with($$select public.price_list_set('00000000-0000-0000-0000-000000e49812', '[{"price":1}]')$$, 'price_list_lines', 'a product on every line');
-- a list closed: its tag is free for a new one
select public.price_list_save('00000000-0000-0000-0000-000000e49812', 'סיטונאי', 'group', null, null, false, 2);
select pg_temp.check((public.price_list_save('00000000-0000-0000-0000-000000e49813', 'סיטונאי חדש', 'group', null, 'סיטונאי', true, 3)->>'created')::boolean, 'a closed list''s tag is free');
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a04');
select pg_temp.check((select count(*) from public.price_lists) = 3 and (select count(*) from public.price_list_items) = 1, 'a cashier reads the lists (the register prices by them)');
select pg_temp.refused_with($$select public.price_list_set('00000000-0000-0000-0000-000000e49811', '[{"itemId":"00000000-0000-0000-0000-000000e49f03","price":1}]')$$, 'not allowed', 'a cashier sets no price');
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a06');
select pg_temp.refused_with($$select public.price_list_save('00000000-0000-0000-0000-000000e49814', 'x', 'group', null, 'vip', true, 3)$$, 'not allowed', 'a viewer makes no list');
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a07');
select pg_temp.check((select count(*) from public.price_lists) = 0, 'another business sees no list');
select pg_temp.refused_with($$select public.price_list_set('00000000-0000-0000-0000-000000e49811', '[{"itemId":"00000000-0000-0000-0000-000000e49f07","price":1}]')$$, 'not allowed', 'nor changes one');
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a01');
select pg_temp.refused_with($$insert into public.price_list_items (list_id, business_id, item_id, price) values ('00000000-0000-0000-0000-000000e49811', '00000000-0000-0000-0000-000000e49b01', '00000000-0000-0000-0000-000000e49f03', 1)$$, 'permission denied', 'no price written directly');
commit;

-- ======================================================================================================================
-- 11. SKU series ("מק״ט מונה"): a prefix a category, the next free code — never one a product has
-- ======================================================================================================================
update public.catalog_items set sku = 'JW-0003' where id = '00000000-0000-0000-0000-000000e49f03';
update public.catalog_variants set sku = 'jw-0005' where id = '00000000-0000-0000-0000-000000e49f22';
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a01');
select pg_temp.check((public.sku_series_save('00000000-0000-0000-0000-000000e49821', 'תכשיטים', ' jw ', 4, 1, true)->>'created')::boolean, 'a series');
select pg_temp.check((select prefix = 'JW' from public.sku_series where id = '00000000-0000-0000-0000-000000e49821'), 'its prefix in capitals');
select pg_temp.check(public.sku_next('00000000-0000-0000-0000-000000e49821') = 'JW-0001' and public.sku_next('00000000-0000-0000-0000-000000e49821') = 'JW-0002', 'one after the other');
select pg_temp.check(public.sku_next('00000000-0000-0000-0000-000000e49821') = 'JW-0004', 'JW-0003 is a product''s: skipped');
select pg_temp.check(public.sku_next('00000000-0000-0000-0000-000000e49821') = 'JW-0006', 'jw-0005 is a variant''s (any case): skipped');
select pg_temp.check((select next_no = 7 from public.sku_series where id = '00000000-0000-0000-0000-000000e49821'), 'the counter is after the last code handed out');
select pg_temp.refused_with($$select public.sku_series_save('00000000-0000-0000-0000-000000e49822', 'אחר', 'JW', 4, 1, true)$$, 'sku_series_prefix_uq', 'a prefix once');
select pg_temp.refused_with($$select public.sku_series_save('00000000-0000-0000-0000-000000e49822', 'תכשיטים', 'AB', 4, 1, true)$$, 'sku_series_name_uq', 'a name once');
select pg_temp.refused_with($$select public.sku_series_save('00000000-0000-0000-0000-000000e49822', 'x', 'J-W', 4, 1, true)$$, 'sku_series_prefix', 'letters and digits');
select pg_temp.refused_with($$select public.sku_series_save('00000000-0000-0000-0000-000000e49822', 'x', 'ABCDEFG', 4, 1, true)$$, 'sku_series_prefix', 'up to 6');
select pg_temp.refused_with($$select public.sku_series_save('00000000-0000-0000-0000-000000e49822', 'x', 'AB', 2, 1, true)$$, 'sku_series_digits', '3 to 6 digits');
select pg_temp.refused_with($$select public.sku_series_save('00000000-0000-0000-0000-000000e49822', 'x', 'AB', 4, 0, true)$$, 'sku_series_next', 'from 1');
select pg_temp.refused_with($$select public.sku_series_save('00000000-0000-0000-0000-000000e49822', ' ', 'AB', 4, 1, true)$$, 'sku_series_name', 'a name');
select pg_temp.refused_with($$select public.sku_series_save(null, 'x', 'AB', 4, 1, true)$$, 'sku_series_id', 'an id from the screen');
select public.sku_series_save('00000000-0000-0000-0000-000000e49822', 'קטן', 'X', 3, 999, true);
select pg_temp.check(public.sku_next('00000000-0000-0000-0000-000000e49822') = 'X-999', 'the last code of a series');
select pg_temp.refused_with($$select public.sku_next('00000000-0000-0000-0000-000000e49822')$$, 'sku_series_full', 'then none');
select public.sku_series_save('00000000-0000-0000-0000-000000e49822', 'קטן', 'X', 3, null, false);
select pg_temp.refused_with($$select public.sku_next('00000000-0000-0000-0000-000000e49822')$$, 'sku_series_closed', 'a closed series hands out nothing');
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a04');
select pg_temp.refused_with($$select public.sku_next('00000000-0000-0000-0000-000000e49821')$$, 'not allowed', 'a cashier gets no code');
select pg_temp.check((select count(*) from public.sku_series) = 2, 'a cashier reads the series');
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a07');
select pg_temp.refused_with($$select public.sku_next('00000000-0000-0000-0000-000000e49821')$$, 'not allowed', 'another business gets none of them');
select pg_temp.check((select count(*) from public.sku_series) = 0, 'nor sees them');
commit;

-- ======================================================================================================================
-- 12. comparing locations: each location's revenue and profit by finance_summary's own rules, its sales, its best products,
--     its stock — the member's locations only; a money report (not a cashier's)
-- ======================================================================================================================
select pg_temp.doc('00000000-0000-0000-0000-000000e49a01', 320, 'il-320-main', null, 1, 100, jsonb_build_object('location_id', '00000000-0000-0000-0000-000000e49b01'));
select pg_temp.doc('00000000-0000-0000-0000-000000e49a01', 320, 'il-320-l2', null, 1, 200, jsonb_build_object('location_id', '00000000-0000-0000-0000-000000e49c02'));
select pg_temp.doc('00000000-0000-0000-0000-000000e49a01', 330, 'il-330-l2', null, 1, 50, jsonb_build_object('location_id', '00000000-0000-0000-0000-000000e49c02', 'base_doc_type', 320,
  'base_doc_number', (select doc_number from public.documents where idempotency_key = 'il-320-l2')));
select pg_temp.doc('00000000-0000-0000-0000-000000e49a07', 320, 'il-320-ib', null, 1, 300);
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a01');
insert into public.expenses (id, user_id, supplier_name, doc_date, category, amount_before_vat, vat_amount, total, paid_on, payment_method, location_id) values
  ('00000000-0000-0000-0000-000000e49703', '00000000-0000-0000-0000-000000e49a01', 'שכירות', public.il_today(), 'rent', 100, 18, 118, public.il_today(), 'transfer', '00000000-0000-0000-0000-000000e49b01'),
  ('00000000-0000-0000-0000-000000e49704', '00000000-0000-0000-0000-000000e49a01', 'ניקיון', public.il_today(), 'other', 40, 0, 40, public.il_today(), 'transfer', '00000000-0000-0000-0000-000000e49c02');
commit;
create temp table cmp_out (who text, j jsonb);
grant all on cmp_out to authenticated;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a01');
insert into cmp_out select 'oa', public.location_compare(public.il_today(), public.il_today());
select public.location_select('00000000-0000-0000-0000-000000e49b01');
insert into cmp_out select 'fs:main', public.finance_summary(public.il_today(), public.il_today());
select public.location_select('00000000-0000-0000-0000-000000e49c02');
insert into cmp_out select 'fs:l2', public.finance_summary(public.il_today(), public.il_today());
select public.location_select('00000000-0000-0000-0000-000000e49c03');
insert into cmp_out select 'fs:l3', public.finance_summary(public.il_today(), public.il_today());
select public.location_select(null);
insert into cmp_out select 'fs:all', public.finance_summary(public.il_today(), public.il_today());
insert into cmp_out select 'rows', jsonb_agg(to_jsonb(r)) from public.stock_by_location r;
select pg_temp.refused_with($$select public.location_compare(public.il_today(), public.il_today() - 1)$$, 'bad range', 'a period from before to after');
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a03');
insert into cmp_out select 'ml', public.location_compare(public.il_today(), public.il_today());
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a06');
insert into cmp_out select 'va', public.location_compare(public.il_today(), public.il_today());
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a04');
select pg_temp.refused_with($$select public.location_compare(public.il_today(), public.il_today())$$, 'not allowed', 'a cashier sees no money report');
select pg_temp.as_user('00000000-0000-0000-0000-000000e49a07');
insert into cmp_out select 'ob', public.location_compare(public.il_today(), public.il_today());
insert into cmp_out select 'fs:ob', public.finance_summary(public.il_today(), public.il_today());
commit;
create temp view cmp_loc as
  select o.who, x.value as l, x.value->>'id' as id, x.ord from cmp_out o, jsonb_array_elements(o.j->'locations') with ordinality x(value, ord)
   where o.who in ('oa', 'ml', 'va', 'ob');
select pg_temp.check((select string_agg(id, ',' order by ord) from cmp_loc where who = 'oa') = '00000000-0000-0000-0000-000000e49b01,00000000-0000-0000-0000-000000e49c02,00000000-0000-0000-0000-000000e49c03', 'every location, the main one first');
select pg_temp.check((select (l->'revenue'->>'net')::numeric = 100 and (l->>'profit')::numeric = 0 from cmp_loc where who = 'oa' and id = '00000000-0000-0000-0000-000000e49b01')
  and (select (l->'revenue'->>'net')::numeric = 150 and (l->'revenue'->>'vat')::numeric = 27 and (l->>'profit')::numeric = 110 from cmp_loc where who = 'oa' and id = '00000000-0000-0000-0000-000000e49c02')
  and (select (l->'revenue'->>'net')::numeric = 0 and (l->>'profit')::numeric = 0 from cmp_loc where who = 'oa' and id = '00000000-0000-0000-0000-000000e49c03'),
  'revenue: 100 at the main location, 200 − 50 (a credit) at the branch; profit after each one''s expenses');
select pg_temp.check((select bool_and((c.l->'revenue'->>'net')::numeric = (f.j->'revenue'->>'net')::numeric and (c.l->>'profit')::numeric = (f.j->>'profit')::numeric)
                        from cmp_loc c join cmp_out f on f.who = case c.id when '00000000-0000-0000-0000-000000e49b01' then 'fs:main' when '00000000-0000-0000-0000-000000e49c02' then 'fs:l2' else 'fs:l3' end where c.who = 'oa'),
  'each location: the same revenue and profit as the money screens with that location picked at the top');
select pg_temp.check((select sum((l->'revenue'->>'net')::numeric) = (select (j->'revenue'->>'net')::numeric from cmp_out where who = 'fs:all')
                        and sum((l->>'profit')::numeric) = (select (j->>'profit')::numeric from cmp_out where who = 'fs:all') from cmp_loc where who = 'oa'),
  'and together: the business''s');
select pg_temp.check((select bool_and((c.l->'sales'->>'count')::int = s.n and (c.l->'sales'->>'total')::numeric = s.t)
                        from cmp_loc c cross join lateral (select count(*) as n, coalesce(sum(x.total), 0) as t from public.sales x
                          where x.business_id = '00000000-0000-0000-0000-000000e49b01' and x.status = 'paid' and coalesce(x.location_id, x.business_id)::text = c.id) s where c.who = 'oa')
  and (select (l->'sales'->>'refunds')::numeric = 2 and (l->'sales'->>'refundCount')::int = 2 from cmp_loc where who = 'oa' and id = '00000000-0000-0000-0000-000000e49b01'),
  'each location''s paid sales, and its refunds');
select pg_temp.check((select bool_and((c.l->'stock'->>'units')::int = coalesce((select sum((r->>'qty')::int) from cmp_out o, jsonb_array_elements(o.j) r
                                                                                   where o.who = 'rows' and r->>'location_id' = c.id and r->>'variant_id' is null), 0))
                        from cmp_loc c where c.who = 'oa')
  and (select (l->'stock'->>'units')::int = 1 and (l->'stock'->>'value')::numeric = 100 from cmp_loc where who = 'oa' and id = '00000000-0000-0000-0000-000000e49c03'),
  'each location''s units now (as "לפי סניף"); the warehouse: one necklace, worth its price');
select pg_temp.check((select l->'items'->0->>'itemId' = '00000000-0000-0000-0000-000000e49f01' and (l->'items'->0->>'qty')::numeric = 1 from cmp_loc where who = 'oa' and id = '00000000-0000-0000-0000-000000e49c02'),
  'the branch''s best seller');
select pg_temp.check((select string_agg(id, ',') from cmp_loc where who = 'ml') = '00000000-0000-0000-0000-000000e49c02', 'a manager of the branch compares the branch only');
select pg_temp.check((select j from cmp_out where who = 'va') = (select j from cmp_out where who = 'oa'), 'a viewer reads the same report');
select pg_temp.check((select string_agg(id, ',') from cmp_loc where who = 'ob') = '00000000-0000-0000-0000-000000e49b02'
  and (select (l->'revenue'->>'net')::numeric = (select (j->'revenue'->>'net')::numeric from cmp_out where who = 'fs:ob') from cmp_loc where who = 'ob'),
  'a business with one location: its one location, the same as its money screens');
