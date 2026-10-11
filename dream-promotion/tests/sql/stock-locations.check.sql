-- Stock by location (migration 20261011004700, docs/FINANCE_ADDITIONS_HE.md T12ב) on a real Postgres (tests/sql/run.sh).
-- The screens' calls run as the signed-in roles. Fixtures only, with ids of their own:
--   Shop SA (company)   owner OA; manager MA (full access, limited to the branch L2); cashier KA (the main location); cashier KB
--                       (L2, register R2); viewer VA. Locations: the main one (its own id), the branch L2 (a store), the warehouse
--                       L3, and LX (closed). Products: CREAM (no variants), SHIRT (S, M), SVC (a service — stock not counted).
--   Clinic SB           one location — everything as before.
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
-- the count at a location (the database's own answer), and the total
create or replace function pg_temp.at(p_loc text, p_item text, p_variant text default null) returns int language sql as $$
  select public.stock_at(p_loc::uuid, p_item::uuid, p_variant::uuid) $$;
create or replace function pg_temp.total(p_item text) returns int language sql as $$
  select stock_qty from public.catalog_items where id = p_item::uuid $$;
create or replace function pg_temp.vtotal(p_variant text) returns int language sql as $$
  select stock_qty from public.catalog_variants where id = p_variant::uuid $$;
-- a sale of the register, as its screen writes it (a line of a product, or of a variant)
create or replace function pg_temp.sale(p_id text, p_user text, p_register text, p_item text, p_qty int, p_variant text default null) returns uuid
language plpgsql as $$
declare r jsonb; cols text; id uuid;
begin
  r := jsonb_build_object('id', p_id, 'user_id', p_user, 'subtotal', 10 * p_qty, 'total', 10 * p_qty, 'vat_rate', 18, 'vat_amount', 1,
    'method', 'cash', 'status', 'paid', 'paid_at', now(),
    'items', jsonb_build_array(jsonb_build_object('name', 'פריט', 'price', 10, 'qty', p_qty, 'itemId', p_item, 'kind', 'product')
                               || case when p_variant is not null then jsonb_build_object('variantId', p_variant) else '{}'::jsonb end));
  if p_register is not null then r := r || jsonb_build_object('register_id', p_register); end if;
  select string_agg(quote_ident(k), ', ') into cols from jsonb_object_keys(r) k;
  execute format('insert into public.sales (%s) select %s from jsonb_populate_record(null::public.sales, $1) returning id', cols, cols) using r into id;
  return id;
end $$;
-- a document with one line of a product (as the app sends it)
create or replace function pg_temp.doc(p_type int, p_key text, p_item text, p_qty int, p_extra jsonb default '{}') returns uuid language plpgsql as $$
declare r jsonb; cols text; id uuid; net numeric := 100 * p_qty;
begin
  r := jsonb_build_object('user_id', '00000000-0000-0000-0000-000000e47a01', 'doc_type', p_type, 'doc_number', 0, 'doc_date', public.il_today(), 'customer_name', 'לקוחה',
    'before_discount', net, 'discount', 0, 'after_discount', net, 'vat_amount', round(net * 0.18, 2), 'total', round(net * 1.18, 2), 'vat_rate', 18,
    'idempotency_key', p_key,
    'lines', jsonb_build_array(jsonb_build_object('name', 'קרם', 'qty', p_qty, 'unitPriceExVat', 100, 'discountExVat', 0, 'totalExVat', net,
                                                   'vatRate', 18, 'kind', 1, 'itemId', p_item) || coalesce(p_extra->'line', '{}'::jsonb)),
    'payments', case when p_type in (320, 400) then jsonb_build_array(jsonb_build_object('method', 1, 'amount', round(net * 1.18, 2), 'date', public.il_today()))
                     else '[]'::jsonb end) || (p_extra - 'line');
  select string_agg(quote_ident(k), ', ') into cols from jsonb_object_keys(r) k;
  execute format('insert into public.documents (%s) select %s from jsonb_populate_record(null::public.documents, $1) returning id', cols, cols) using r into id;
  return id;
end $$;

-- ---- the world ------------------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000e47a01', 'oa@stock-a.test'), ('00000000-0000-0000-0000-000000e47a02', 'ma@stock-a.test'), ('00000000-0000-0000-0000-000000e47a03', 'ka@stock-a.test'), ('00000000-0000-0000-0000-000000e47a04', 'kb@stock-a.test'),
  ('00000000-0000-0000-0000-000000e47a05', 'va@stock-a.test'), ('00000000-0000-0000-0000-000000e47a06', 'ob@stock-b.test');
insert into public.businesses (id, name, slug) values ('00000000-0000-0000-0000-000000e47b01', 'Shop SA', 'stock-shop-a'), ('00000000-0000-0000-0000-000000e47b02', 'Clinic SB', 'stock-clinic-b');
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-000000e47b01', '00000000-0000-0000-0000-000000e47a01', 'owner', 'full'), ('00000000-0000-0000-0000-000000e47b01', '00000000-0000-0000-0000-000000e47a02', 'editor', 'full'), ('00000000-0000-0000-0000-000000e47b01', '00000000-0000-0000-0000-000000e47a03', 'editor', 'register'),
  ('00000000-0000-0000-0000-000000e47b01', '00000000-0000-0000-0000-000000e47a04', 'editor', 'register'), ('00000000-0000-0000-0000-000000e47b01', '00000000-0000-0000-0000-000000e47a05', 'viewer', 'full'), ('00000000-0000-0000-0000-000000e47b02', '00000000-0000-0000-0000-000000e47a06', 'owner', 'full');
update public.profiles set current_business_id = '00000000-0000-0000-0000-000000e47b01' where id in ('00000000-0000-0000-0000-000000e47a01', '00000000-0000-0000-0000-000000e47a02', '00000000-0000-0000-0000-000000e47a03', '00000000-0000-0000-0000-000000e47a04', '00000000-0000-0000-0000-000000e47a05');
update public.profiles set current_business_id = '00000000-0000-0000-0000-000000e47b02' where id = '00000000-0000-0000-0000-000000e47a06';
insert into public.register_settings (user_id, business_id, business_type, vat_rate, dealer_number, legal_name, street, city, entity_type) values
  ('00000000-0000-0000-0000-000000e47a01', '00000000-0000-0000-0000-000000e47b01', 'licensed', 18, '514000004', 'חנות מלאי בע"מ', 'הרצל', 'תל אביב', 'company'),
  ('00000000-0000-0000-0000-000000e47a06', '00000000-0000-0000-0000-000000e47b02', 'licensed', 18, '514000012', 'קליניקה מלאי בע"מ', 'הגפן', 'חיפה', 'company');
insert into public.business_locations (id, business_id, name, kind, sort) values
  ('00000000-0000-0000-0000-000000e47c02', '00000000-0000-0000-0000-000000e47b01', 'סניף דיזנגוף', 'store', 1), ('00000000-0000-0000-0000-000000e47c03', '00000000-0000-0000-0000-000000e47b01', 'מחסן', 'warehouse', 2), ('00000000-0000-0000-0000-000000e47c04', '00000000-0000-0000-0000-000000e47b01', 'סניף שנסגר', 'store', 3);
update public.business_locations set active = false where id = '00000000-0000-0000-0000-000000e47c04';
insert into public.registers (id, business_id, location_id, name) values ('00000000-0000-0000-0000-000000e47d02', '00000000-0000-0000-0000-000000e47b01', '00000000-0000-0000-0000-000000e47c02', 'קופה 1');
update public.business_members set locations = array['00000000-0000-0000-0000-000000e47c02'::uuid] where business_id = '00000000-0000-0000-0000-000000e47b01' and user_id in ('00000000-0000-0000-0000-000000e47a02', '00000000-0000-0000-0000-000000e47a04');
update public.business_members set locations = array['00000000-0000-0000-0000-000000e47b01'::uuid] where business_id = '00000000-0000-0000-0000-000000e47b01' and user_id = '00000000-0000-0000-0000-000000e47a03';
insert into public.catalog_items (id, user_id, business_id, name, price, kind, track_stock, stock_qty, low_stock) values
  ('00000000-0000-0000-0000-000000e47f01', '00000000-0000-0000-0000-000000e47a01', '00000000-0000-0000-0000-000000e47b01', 'קרם', 100, 'product', true, 0, 2),
  ('00000000-0000-0000-0000-000000e47f02', '00000000-0000-0000-0000-000000e47a01', '00000000-0000-0000-0000-000000e47b01', 'חולצה', 100, 'product', true, 0, 1),
  ('00000000-0000-0000-0000-000000e47f03', '00000000-0000-0000-0000-000000e47a01', '00000000-0000-0000-0000-000000e47b01', 'טיפול', 300, 'service', false, 0, 2),
  ('00000000-0000-0000-0000-000000e47f04', '00000000-0000-0000-0000-000000e47a06', '00000000-0000-0000-0000-000000e47b02', 'מסכה', 80, 'product', true, 0, 1);
insert into public.catalog_variants (id, item_id, business_id, option1) values ('00000000-0000-0000-0000-000000e47f21', '00000000-0000-0000-0000-000000e47f02', '00000000-0000-0000-0000-000000e47b01', 'S'), ('00000000-0000-0000-0000-000000e47f22', '00000000-0000-0000-0000-000000e47f02', '00000000-0000-0000-0000-000000e47b01', 'M');

-- ======================================================================================================================
-- 1. one location: everything as before — its count is the total, nothing is kept elsewhere
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e47a06');
select pg_temp.check(public.adjust_stock('00000000-0000-0000-0000-000000e47f04', 'add', 5, 'משלוח') = 5, 'a delivery, as before');
select pg_temp.sale('00000000-0000-0000-0000-000000e47501', '00000000-0000-0000-0000-000000e47a06', null, '00000000-0000-0000-0000-000000e47f04', 2);
select pg_temp.check((select array_agg(location_id::text || '/' || item_id::text || '/' || coalesce(variant_id::text, '') || '/' || qty) from public.stock_by_location)
  = array['00000000-0000-0000-0000-000000e47b02/00000000-0000-0000-0000-000000e47f04//3'], 'stock_by_location: the one location, the total');
commit;
select pg_temp.check(pg_temp.total('00000000-0000-0000-0000-000000e47f04') = 3 and pg_temp.at('00000000-0000-0000-0000-000000e47b02', '00000000-0000-0000-0000-000000e47f04') = 3, 'the main location''s count is the total');
select pg_temp.check((select count(*) = 0 from public.stock_levels where business_id = '00000000-0000-0000-0000-000000e47b02'), 'nothing is kept for a business with one location');
select pg_temp.check((select bool_and(location_id = '00000000-0000-0000-0000-000000e47b02' and location_after = qty_after) and count(*) = 2 from public.stock_movements where item_id = '00000000-0000-0000-0000-000000e47f04'),
  'every move is at the one location, its count after = the total after');

-- ======================================================================================================================
-- 2. deliveries and counts at a location; the main location's count is the total less the others
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e47a01');
select pg_temp.check(public.stock_adjust('00000000-0000-0000-0000-000000e47b01', '00000000-0000-0000-0000-000000e47f01', null, 'set', 10, 'ספירה') = 10, 'a count at the main location');
select pg_temp.check(public.stock_adjust('00000000-0000-0000-0000-000000e47c02', '00000000-0000-0000-0000-000000e47f01', null, 'add', 4, 'משלוח') = 4, 'a delivery at the branch');
select pg_temp.check(public.stock_adjust('00000000-0000-0000-0000-000000e47c03', '00000000-0000-0000-0000-000000e47f01', null, 'add', 6) = 6, 'a delivery at the warehouse');
-- the screens before 2.92 count where the user works: "all" picked → the main location
select pg_temp.check(public.adjust_stock('00000000-0000-0000-0000-000000e47f01', 'set', 9) = 9, 'adjust_stock counts at the main location');
select pg_temp.check(public.adjust_variant_stock('00000000-0000-0000-0000-000000e47f21', 'set', 5) = 5 and public.adjust_variant_stock('00000000-0000-0000-0000-000000e47f22', 'set', 3) = 3, 'the variants at the main location');
select pg_temp.check(public.stock_adjust('00000000-0000-0000-0000-000000e47c02', '00000000-0000-0000-0000-000000e47f02', '00000000-0000-0000-0000-000000e47f21', 'add', 2) = 2, 'S at the branch');
select pg_temp.refused_with($$select public.stock_adjust('00000000-0000-0000-0000-000000e47c02', '00000000-0000-0000-0000-000000e47f02', null, 'add', 1)$$, 'variant_required', 'an item with variants is counted per variant');
select pg_temp.refused_with($$select public.stock_adjust('00000000-0000-0000-0000-000000e47b02', '00000000-0000-0000-0000-000000e47f01', null, 'add', 1)$$, 'stock_location', 'another business''s location');
select pg_temp.refused_with($$select public.stock_adjust('00000000-0000-0000-0000-000000e47c02', '00000000-0000-0000-0000-000000e47f01', null, 'set', -1)$$, 'zero or more', 'a negative count');
select pg_temp.refused_with($$select public.stock_adjust('00000000-0000-0000-0000-000000e47c02', '00000000-0000-0000-0000-000000e47f02', '00000000-0000-0000-0000-000000e47f04', 'add', 1)$$, 'variant_not_found', 'a variant of another item');
select pg_temp.as_user('00000000-0000-0000-0000-000000e47a02');
select pg_temp.refused_with($$select public.stock_adjust('00000000-0000-0000-0000-000000e47b01', '00000000-0000-0000-0000-000000e47f01', null, 'add', 1)$$, 'not allowed', 'a manager of the branch at the main location');
select pg_temp.check(public.stock_adjust('00000000-0000-0000-0000-000000e47c02', '00000000-0000-0000-0000-000000e47f01', null, 'add', 1) = 5, 'a manager of the branch at the branch');
select pg_temp.check(public.adjust_stock('00000000-0000-0000-0000-000000e47f01', 'add', 1) = 6, 'adjust_stock of a member limited to the branch: at the branch');
-- a count on the spot ("ספירה" next to a product) is the owner's: a manager counts in a stock count, which the owner approves
select pg_temp.refused_with($$select public.stock_adjust('00000000-0000-0000-0000-000000e47c02', '00000000-0000-0000-0000-000000e47f01', null, 'set', 3)$$, 'the owner counts', 'a manager''s count on the spot, at the branch');
select pg_temp.refused_with($$select public.adjust_stock('00000000-0000-0000-0000-000000e47f01', 'set', 3)$$, 'the owner counts', 'the same through the screens of before 2.92');
select pg_temp.refused_with($$select public.adjust_variant_stock('00000000-0000-0000-0000-000000e47f21', 'set', 3)$$, 'the owner counts', 'a variant''s too');
select pg_temp.as_user('00000000-0000-0000-0000-000000e47a03');
select pg_temp.refused_with($$select public.stock_adjust('00000000-0000-0000-0000-000000e47b01', '00000000-0000-0000-0000-000000e47f01', null, 'add', 1)$$, 'not allowed', 'a cashier counts nothing');
select pg_temp.as_user('00000000-0000-0000-0000-000000e47a05');
select pg_temp.refused_with($$select public.stock_adjust('00000000-0000-0000-0000-000000e47b01', '00000000-0000-0000-0000-000000e47f01', null, 'add', 1)$$, 'not allowed', 'a viewer counts nothing');
commit;
-- a manager of every location (no limit) is still not the owner: no count on the spot; a delivery — yes (nothing kept: rolled back)
update public.business_members set locations = null where business_id = '00000000-0000-0000-0000-000000e47b01' and user_id = '00000000-0000-0000-0000-000000e47a02';
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e47a02');
select pg_temp.refused_with($$select public.stock_adjust('00000000-0000-0000-0000-000000e47b01', '00000000-0000-0000-0000-000000e47f01', null, 'set', 3)$$, 'the owner counts', 'a manager of every location counts on the spot');
select pg_temp.check(public.stock_adjust('00000000-0000-0000-0000-000000e47b01', '00000000-0000-0000-0000-000000e47f01', null, 'add', 1) = 10, 'a manager of every location receives at the main location');
rollback;
update public.business_members set locations = array['00000000-0000-0000-0000-000000e47c02'::uuid] where business_id = '00000000-0000-0000-0000-000000e47b01' and user_id = '00000000-0000-0000-0000-000000e47a02';
select pg_temp.check(pg_temp.total('00000000-0000-0000-0000-000000e47f01') = 21 and pg_temp.at('00000000-0000-0000-0000-000000e47b01', '00000000-0000-0000-0000-000000e47f01') = 9 and pg_temp.at('00000000-0000-0000-0000-000000e47c02', '00000000-0000-0000-0000-000000e47f01') = 6
  and pg_temp.at('00000000-0000-0000-0000-000000e47c03', '00000000-0000-0000-0000-000000e47f01') = 6, 'the total is the sum of the locations (9 + 6 + 6)');
select pg_temp.check(pg_temp.vtotal('00000000-0000-0000-0000-000000e47f21') = 7 and pg_temp.at('00000000-0000-0000-0000-000000e47b01', '00000000-0000-0000-0000-000000e47f02', '00000000-0000-0000-0000-000000e47f21') = 5 and pg_temp.at('00000000-0000-0000-0000-000000e47c02', '00000000-0000-0000-0000-000000e47f02', '00000000-0000-0000-0000-000000e47f21') = 2
  and pg_temp.at('00000000-0000-0000-0000-000000e47c02', '00000000-0000-0000-0000-000000e47f02') = 2 and pg_temp.total('00000000-0000-0000-0000-000000e47f02') = 10, 'a variant''s count at a location; the item''s there');
select pg_temp.check((select location_id = '00000000-0000-0000-0000-000000e47c02' and location_after = 2 and qty_after = 7 and reason = 'receive' from public.stock_movements
                       where item_id = '00000000-0000-0000-0000-000000e47f02' and variant_id = '00000000-0000-0000-0000-000000e47f21' and location_id = '00000000-0000-0000-0000-000000e47c02'), 'the move names its location and the count there after');

-- ======================================================================================================================
-- 3. a sale at its register's location; a cancel puts it back there; a refund comes in where it is returned
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e47a04');
select pg_temp.sale('00000000-0000-0000-0000-000000e47502', '00000000-0000-0000-0000-000000e47a04', '00000000-0000-0000-0000-000000e47d02', '00000000-0000-0000-0000-000000e47f01', 1);
select pg_temp.as_user('00000000-0000-0000-0000-000000e47a03');
select pg_temp.sale('00000000-0000-0000-0000-000000e47503', '00000000-0000-0000-0000-000000e47a03', '00000000-0000-0000-0000-000000e47b01', '00000000-0000-0000-0000-000000e47f01', 2);
commit;
select pg_temp.check(pg_temp.at('00000000-0000-0000-0000-000000e47c02', '00000000-0000-0000-0000-000000e47f01') = 5 and pg_temp.at('00000000-0000-0000-0000-000000e47b01', '00000000-0000-0000-0000-000000e47f01') = 7 and pg_temp.total('00000000-0000-0000-0000-000000e47f01') = 18,
  'each register''s sale takes from its own location');
select pg_temp.check((select location_id = '00000000-0000-0000-0000-000000e47c02' and location_after = 5 from public.stock_movements where sale_id = '00000000-0000-0000-0000-000000e47502'),
  'the branch''s sale is logged at the branch');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e47a01');
update public.sales set status = 'cancelled' where id = '00000000-0000-0000-0000-000000e47502';
insert into public.sale_refunds (id, user_id, sale_id, amount, vat_amount, method, items, restock, reason, register_id)
values ('00000000-0000-0000-0000-000000e47511', '00000000-0000-0000-0000-000000e47a01', '00000000-0000-0000-0000-000000e47503', 10, 1, 'cash',
  '[{"name":"קרם","price":10,"qty":1,"itemId":"00000000-0000-0000-0000-000000e47f01","kind":"product"}]', true, 'הוחזר בסניף', '00000000-0000-0000-0000-000000e47d02');
commit;
select pg_temp.check(pg_temp.at('00000000-0000-0000-0000-000000e47c02', '00000000-0000-0000-0000-000000e47f01') = 7 and pg_temp.at('00000000-0000-0000-0000-000000e47b01', '00000000-0000-0000-0000-000000e47f01') = 7,
  'the cancel puts it back at the branch; the main location''s sale, returned at the branch, comes in at the branch');
select pg_temp.check((select location_id = '00000000-0000-0000-0000-000000e47c02' and delta = 1 from public.stock_movements where refund_id = '00000000-0000-0000-0000-000000e47511'),
  'the return is logged where it came in');
-- variants at the branch: S sold there, and a shirt sold with no variant ("לא משויך")
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e47a04');
select pg_temp.sale('00000000-0000-0000-0000-000000e47504', '00000000-0000-0000-0000-000000e47a04', '00000000-0000-0000-0000-000000e47d02', '00000000-0000-0000-0000-000000e47f02', 1, '00000000-0000-0000-0000-000000e47f21');
select pg_temp.sale('00000000-0000-0000-0000-000000e47505', '00000000-0000-0000-0000-000000e47a04', '00000000-0000-0000-0000-000000e47d02', '00000000-0000-0000-0000-000000e47f02', 1);
commit;
select pg_temp.check(pg_temp.at('00000000-0000-0000-0000-000000e47c02', '00000000-0000-0000-0000-000000e47f02', '00000000-0000-0000-0000-000000e47f21') = 1 and pg_temp.at('00000000-0000-0000-0000-000000e47c02', '00000000-0000-0000-0000-000000e47f02') = 0 and pg_temp.at('00000000-0000-0000-0000-000000e47b01', '00000000-0000-0000-0000-000000e47f02', '00000000-0000-0000-0000-000000e47f21') = 5
  and pg_temp.vtotal('00000000-0000-0000-0000-000000e47f21') = 6 and pg_temp.total('00000000-0000-0000-0000-000000e47f02') = 8, 'S out at the branch; the unassigned shirt too');

-- ======================================================================================================================
-- 4. documents and expenses at their location; a cancel / a void moves back where it moved
-- ======================================================================================================================
select pg_temp.doc(300, 'st-300', '00000000-0000-0000-0000-000000e47f01', 2, jsonb_build_object('location_id', '00000000-0000-0000-0000-000000e47c02'));
select pg_temp.check(pg_temp.at('00000000-0000-0000-0000-000000e47c02', '00000000-0000-0000-0000-000000e47f01') = 5, 'a direct document of the branch takes from the branch');
insert into public.document_cancellations (document_id, user_id, reason)
values ((select id from public.documents where idempotency_key = 'st-300'), '00000000-0000-0000-0000-000000e47a01', 'הופקה בטעות');
select pg_temp.check(pg_temp.at('00000000-0000-0000-0000-000000e47c02', '00000000-0000-0000-0000-000000e47f01') = 7 and (select location_id = '00000000-0000-0000-0000-000000e47c02' and delta = 2 from public.stock_movements
  where reason = 'cancel' and document_id = (select id from public.documents where idempotency_key = 'st-300')), 'its cancellation brings it back at the branch');
select pg_temp.doc(320, 'st-320', '00000000-0000-0000-0000-000000e47f01', 1, jsonb_build_object('location_id', '00000000-0000-0000-0000-000000e47c03'));
select pg_temp.doc(330, 'st-330', '00000000-0000-0000-0000-000000e47f01', 1, jsonb_build_object('line', jsonb_build_object('restock', true), 'base_doc_type', 320,
  'base_doc_number', (select doc_number from public.documents where idempotency_key = 'st-320')));
select pg_temp.check(pg_temp.at('00000000-0000-0000-0000-000000e47c03', '00000000-0000-0000-0000-000000e47f01') = 6 and (select location_id = '00000000-0000-0000-0000-000000e47c03' from public.documents where idempotency_key = 'st-330'),
  'a receipt at the warehouse, and its credit invoice (the receipt''s location) back to stock there');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e47a01');
insert into public.expenses (id, user_id, supplier_name, doc_date, category, amount_before_vat, vat_amount, total, paid_on, payment_method, stock_lines, location_id)
values ('00000000-0000-0000-0000-000000e47701', '00000000-0000-0000-0000-000000e47a01', 'ספק קרמים', public.il_today(), 'inventory', 300, 54, 354, public.il_today(), 'transfer',
  '[{"itemId":"00000000-0000-0000-0000-000000e47f01","qty":3}]', '00000000-0000-0000-0000-000000e47c02');
select pg_temp.check(public.receive_expense_stock('00000000-0000-0000-0000-000000e47701') = 1, 'a delivery with an expense of the branch');
commit;
select pg_temp.check(pg_temp.at('00000000-0000-0000-0000-000000e47c02', '00000000-0000-0000-0000-000000e47f01') = 10, 'it comes in at the branch');
update public.expenses set status = 'void', void_reason = 'נרשם פעמיים' where id = '00000000-0000-0000-0000-000000e47701';
select pg_temp.check(pg_temp.at('00000000-0000-0000-0000-000000e47c02', '00000000-0000-0000-0000-000000e47f01') = 7 and (select location_id = '00000000-0000-0000-0000-000000e47c02' and delta = -3 from public.stock_movements
  where expense_id = '00000000-0000-0000-0000-000000e47701' and reason = 'adjust'), 'the void takes it out at the branch');

-- ======================================================================================================================
-- 5. reconciling the variants: at every location
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e47a02');
select pg_temp.refused_with($$select public.reconcile_variant_stock('00000000-0000-0000-0000-000000e47f02')$$, 'not allowed', 'a member limited to the branch reconciles every location — no');
select pg_temp.as_user('00000000-0000-0000-0000-000000e47a01');
select pg_temp.check(public.reconcile_variant_stock('00000000-0000-0000-0000-000000e47f02') = 9, 'the total becomes the sum of the variants (6 + 3)');
commit;
select pg_temp.check(pg_temp.at('00000000-0000-0000-0000-000000e47c02', '00000000-0000-0000-0000-000000e47f02') = 1 and pg_temp.at('00000000-0000-0000-0000-000000e47b01', '00000000-0000-0000-0000-000000e47f02') = 8 and pg_temp.at('00000000-0000-0000-0000-000000e47b01', '00000000-0000-0000-0000-000000e47f02', '00000000-0000-0000-0000-000000e47f21') = 5
  and pg_temp.at('00000000-0000-0000-0000-000000e47b01', '00000000-0000-0000-0000-000000e47f02', '00000000-0000-0000-0000-000000e47f22') = 3, 'at the branch the shirt is its S again; the main location''s is its S and M');

-- ======================================================================================================================
-- 6. stock_by_location: every location the user may use
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e47a01');
select pg_temp.check((select count(distinct location_id) = 3 from public.stock_by_location), 'the owner: the main location, the branch and the warehouse');
select pg_temp.check((select bool_and(x.sum = i.stock_qty) from (select item_id, sum(qty) from public.stock_by_location where variant_id is null group by item_id) x
                        join public.catalog_items i on i.id = x.item_id), 'each item: the sum of its locations is its total');
select pg_temp.check((select bool_and(x.sum = v.stock_qty) from (select variant_id, sum(qty) from public.stock_by_location where variant_id is not null group by variant_id) x
                        join public.catalog_variants v on v.id = x.variant_id), 'each variant: the sum of its locations is its total');
select pg_temp.check((select count(*) = 0 from public.stock_by_location where item_id = '00000000-0000-0000-0000-000000e47f03'), 'a service whose stock is not counted: not listed');
select pg_temp.as_user('00000000-0000-0000-0000-000000e47a02');
select pg_temp.check((select bool_and(location_id = '00000000-0000-0000-0000-000000e47c02') and count(*) > 0 from public.stock_by_location), 'a member limited to the branch: the branch only');
select pg_temp.as_user('00000000-0000-0000-0000-000000e47a03');
select pg_temp.check((select bool_and(location_id = '00000000-0000-0000-0000-000000e47b01') and count(*) > 0 from public.stock_by_location), 'a cashier of the main location: its counts (the register shows them)');
select pg_temp.as_user('00000000-0000-0000-0000-000000e47a06');
select pg_temp.check((select count(*) = 1 from public.stock_by_location), 'another business: its own only');
commit;

-- ======================================================================================================================
-- 7. transfers: sent (the units leave at once), received (a difference is an adjust with its reason), or cancelled
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e47a01');
select pg_temp.check((public.stock_transfer_send('00000000-0000-0000-0000-000000e47e01', '00000000-0000-0000-0000-000000e47b01', '00000000-0000-0000-0000-000000e47c02',
  '[{"itemId":"00000000-0000-0000-0000-000000e47f01","qty":3},{"itemId":"00000000-0000-0000-0000-000000e47f02","variantId":"00000000-0000-0000-0000-000000e47f22","qty":1}]', 'למילוי המדף')->>'number')::int = 1, 'transfer 1: main → branch');
select pg_temp.check(not (public.stock_transfer_send('00000000-0000-0000-0000-000000e47e01', '00000000-0000-0000-0000-000000e47b01', '00000000-0000-0000-0000-000000e47c02', '[{"itemId":"00000000-0000-0000-0000-000000e47f01","qty":3}]')->>'created')::boolean,
  'the same transfer again (its answer was lost): nothing more');
select pg_temp.refused_with($$select public.stock_transfer_send(gen_random_uuid(), '00000000-0000-0000-0000-000000e47b01', '00000000-0000-0000-0000-000000e47b01', '[{"itemId":"00000000-0000-0000-0000-000000e47f01","qty":1}]')$$, 'transfer_same', 'to the same location');
select pg_temp.refused_with($$select public.stock_transfer_send(gen_random_uuid(), '00000000-0000-0000-0000-000000e47b01', '00000000-0000-0000-0000-000000e47c04', '[{"itemId":"00000000-0000-0000-0000-000000e47f01","qty":1}]')$$, 'transfer_location', 'to a closed location');
select pg_temp.refused_with($$select public.stock_transfer_send(gen_random_uuid(), '00000000-0000-0000-0000-000000e47b01', '00000000-0000-0000-0000-000000e47b02', '[{"itemId":"00000000-0000-0000-0000-000000e47f01","qty":1}]')$$, 'transfer_location', 'to another business');
select pg_temp.refused_with($$select public.stock_transfer_send(gen_random_uuid(), '00000000-0000-0000-0000-000000e47b01', '00000000-0000-0000-0000-000000e47c02', '[{"itemId":"00000000-0000-0000-0000-000000e47f01","qty":2.5}]')$$, 'transfer_lines', 'half a unit');
select pg_temp.refused_with($$select public.stock_transfer_send(gen_random_uuid(), '00000000-0000-0000-0000-000000e47b01', '00000000-0000-0000-0000-000000e47c02', '[{"itemId":"00000000-0000-0000-0000-000000e47f01","qty":0}]')$$, 'transfer_lines', 'no units');
select pg_temp.refused_with($$select public.stock_transfer_send(gen_random_uuid(), '00000000-0000-0000-0000-000000e47b01', '00000000-0000-0000-0000-000000e47c02', '[]')$$, 'transfer_lines', 'no lines');
select pg_temp.refused_with($$select public.stock_transfer_send(gen_random_uuid(), '00000000-0000-0000-0000-000000e47b01', '00000000-0000-0000-0000-000000e47c02', '[{"itemId":"00000000-0000-0000-0000-000000e47f03","qty":1}]')$$, 'transfer_untracked', 'a product whose stock is not counted');
select pg_temp.refused_with($$select public.stock_transfer_send(gen_random_uuid(), '00000000-0000-0000-0000-000000e47b01', '00000000-0000-0000-0000-000000e47c02', '[{"itemId":"00000000-0000-0000-0000-000000e47f02","qty":1}]')$$, 'transfer_variant_required', 'a shirt with no variant');
select pg_temp.refused_with($$select public.stock_transfer_send(gen_random_uuid(), '00000000-0000-0000-0000-000000e47b01', '00000000-0000-0000-0000-000000e47c02', '[{"itemId":"00000000-0000-0000-0000-000000e47f04","qty":1}]')$$, 'transfer_item', 'another business''s product');
commit;
select pg_temp.check(pg_temp.at('00000000-0000-0000-0000-000000e47b01', '00000000-0000-0000-0000-000000e47f01') = 4 and pg_temp.at('00000000-0000-0000-0000-000000e47c02', '00000000-0000-0000-0000-000000e47f01') = 7 and pg_temp.total('00000000-0000-0000-0000-000000e47f01') = 17,
  'sent: out of the main location, not yet at the branch (3 on the way)');
select pg_temp.check((select count(*) = 2 and bool_and(reason = 'transfer' and location_id = '00000000-0000-0000-0000-000000e47b01' and delta < 0) from public.stock_movements where transfer_id = '00000000-0000-0000-0000-000000e47e01'),
  'two moves out, at the source, with the transfer');
select pg_temp.check((select status = 'sent' and jsonb_array_length(lines) = 2 and lines->0->>'name' is not null from public.stock_transfers where id = '00000000-0000-0000-0000-000000e47e01'),
  'the transfer note keeps its lines with their names');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e47a02');
select pg_temp.refused_with($$select public.stock_transfer_send(gen_random_uuid(), '00000000-0000-0000-0000-000000e47b01', '00000000-0000-0000-0000-000000e47c02', '[{"itemId":"00000000-0000-0000-0000-000000e47f01","qty":1}]')$$, 'not allowed',
  'a member limited to the branch sends from the main location');
select pg_temp.check((public.stock_transfer_send('00000000-0000-0000-0000-000000e47e02', '00000000-0000-0000-0000-000000e47c02', '00000000-0000-0000-0000-000000e47b01', '[{"itemId":"00000000-0000-0000-0000-000000e47f01","qty":1}]')->>'number')::int = 2, 'transfer 2: branch → main');
select pg_temp.refused_with($$select public.stock_transfer_receive('00000000-0000-0000-0000-000000e47e01', '[{"itemId":"00000000-0000-0000-0000-000000e47f01","received":2}]')$$, 'transfer_gap_reason',
  'a difference with no reason');
select pg_temp.check((public.stock_transfer_receive('00000000-0000-0000-0000-000000e47e01', '[{"itemId":"00000000-0000-0000-0000-000000e47f01","received":2,"reason":"אחד נשבר בדרך"}]', 'הגיע')->>'gaps')::int = 1,
  'transfer 1 received at the branch: one cream short');
select pg_temp.check(public.stock_transfer_receive('00000000-0000-0000-0000-000000e47e01', '[]')->>'result' = 'already', 'received twice: once');
select pg_temp.refused_with($$select public.stock_transfer_receive('00000000-0000-0000-0000-000000e47e02', '[]')$$, 'not allowed', 'transfer 2 is received at the main location — not by the branch''s');
select pg_temp.as_user('00000000-0000-0000-0000-000000e47a03');
select pg_temp.refused_with($$select public.stock_transfer_receive('00000000-0000-0000-0000-000000e47e02', '[]')$$, 'not allowed', 'a cashier receives nothing');
select pg_temp.as_user('00000000-0000-0000-0000-000000e47a05');
select pg_temp.refused_with($$select public.stock_transfer_send(gen_random_uuid(), '00000000-0000-0000-0000-000000e47b01', '00000000-0000-0000-0000-000000e47c02', '[{"itemId":"00000000-0000-0000-0000-000000e47f01","qty":1}]')$$, 'not allowed', 'a viewer sends nothing');
select pg_temp.as_user('00000000-0000-0000-0000-000000e47a01');
select pg_temp.refused_with($$select public.stock_transfer_cancel('00000000-0000-0000-0000-000000e47e02', ' ')$$, 'transfer_cancel_reason', 'a cancel needs a reason');
select pg_temp.check(public.stock_transfer_cancel('00000000-0000-0000-0000-000000e47e02', 'נשלח בטעות')->>'result' = 'ok', 'the owner cancels transfer 2');
select pg_temp.check(public.stock_transfer_cancel('00000000-0000-0000-0000-000000e47e02', 'שוב')->>'result' = 'already', 'cancelled twice: once');
select pg_temp.refused_with($$select public.stock_transfer_receive('00000000-0000-0000-0000-000000e47e02', '[]')$$, 'transfer_cancelled', 'a cancelled transfer is not received');
select pg_temp.refused_with($$select public.stock_transfer_cancel('00000000-0000-0000-0000-000000e47e01', 'טעות')$$, 'transfer_received', 'a received transfer is not cancelled');
commit;
select pg_temp.check(pg_temp.at('00000000-0000-0000-0000-000000e47c02', '00000000-0000-0000-0000-000000e47f01') = 9 and pg_temp.at('00000000-0000-0000-0000-000000e47c02', '00000000-0000-0000-0000-000000e47f02', '00000000-0000-0000-0000-000000e47f22') = 1 and pg_temp.at('00000000-0000-0000-0000-000000e47c02', '00000000-0000-0000-0000-000000e47f02') = 2
  and pg_temp.total('00000000-0000-0000-0000-000000e47f01') = 19, 'received: 3 in and 1 short at the branch (and transfer 2 back where it was); the total lost the broken one');
select pg_temp.check((select reason = 'adjust' and delta = -1 and location_id = '00000000-0000-0000-0000-000000e47c02' and note like '%אחד נשבר בדרך%' from public.stock_movements
                       where transfer_id = '00000000-0000-0000-0000-000000e47e01' and delta < 0 and location_id = '00000000-0000-0000-0000-000000e47c02'), 'the difference is an adjust at the branch, with its reason');
select pg_temp.check((select status = 'received' and received_by = '00000000-0000-0000-0000-000000e47a02' and (lines->0->>'received')::int = 2 and lines->0->>'reason' = 'אחד נשבר בדרך'
                       from public.stock_transfers where id = '00000000-0000-0000-0000-000000e47e01'), 'the note: received, by whom, what arrived and why not');
select pg_temp.check((select status = 'cancelled' and cancel_reason = 'נשלח בטעות' from public.stock_transfers where id = '00000000-0000-0000-0000-000000e47e02')
  and (select sum(delta) = 0 from public.stock_movements where transfer_id = '00000000-0000-0000-0000-000000e47e02'), 'transfer 2: cancelled, its units back');

-- ======================================================================================================================
-- 8. counts: line by line, as of the moment each was counted; the owner approves, then the differences move
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e47a02');
select pg_temp.check((public.stock_count_start('00000000-0000-0000-0000-000000e47e11', '00000000-0000-0000-0000-000000e47c02', 'ספירת סוף חודש')->>'number')::int = 1, 'count 1 of the branch');
select pg_temp.check(not (public.stock_count_start('00000000-0000-0000-0000-000000e47e11', '00000000-0000-0000-0000-000000e47c02')->>'created')::boolean, 'the same count again: the same count');
select pg_temp.refused_with($$select public.stock_count_start(gen_random_uuid(), '00000000-0000-0000-0000-000000e47c02')$$, 'count_open', 'one open count a location');
select pg_temp.refused_with($$select public.stock_count_start(gen_random_uuid(), '00000000-0000-0000-0000-000000e47b01')$$, 'not allowed', 'a manager of the branch counts the main location');
select public.stock_count_set('00000000-0000-0000-0000-000000e47e11', '00000000-0000-0000-0000-000000e47f01', null, 8);                      -- 9 expected: one missing
select public.stock_count_set('00000000-0000-0000-0000-000000e47e11', '00000000-0000-0000-0000-000000e47f02', '00000000-0000-0000-0000-000000e47f21', 3);
select public.stock_count_set('00000000-0000-0000-0000-000000e47e11', '00000000-0000-0000-0000-000000e47f02', '00000000-0000-0000-0000-000000e47f21', null);                  -- taken off
select public.stock_count_set('00000000-0000-0000-0000-000000e47e11', '00000000-0000-0000-0000-000000e47f02', '00000000-0000-0000-0000-000000e47f21', 1);                     -- counted again: as expected
select pg_temp.refused_with($$select public.stock_count_set('00000000-0000-0000-0000-000000e47e11', '00000000-0000-0000-0000-000000e47f02', null, 1)$$, 'variant_required', 'a shirt is counted per variant');
select pg_temp.refused_with($$select public.stock_count_set('00000000-0000-0000-0000-000000e47e11', '00000000-0000-0000-0000-000000e47f01', null, -1)$$, 'zero or more', 'a negative count');
select pg_temp.as_user('00000000-0000-0000-0000-000000e47a04');
select pg_temp.refused_with($$select public.stock_count_set('00000000-0000-0000-0000-000000e47e11', '00000000-0000-0000-0000-000000e47f01', null, 1)$$, 'not allowed', 'a cashier counts nothing');
commit;
-- a sale after the cream was counted (each call is its own transaction, as in the app): the count stays right
select pg_sleep(0.01);
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e47a04');
select pg_temp.sale('00000000-0000-0000-0000-000000e47506', '00000000-0000-0000-0000-000000e47a04', '00000000-0000-0000-0000-000000e47d02', '00000000-0000-0000-0000-000000e47f01', 1);
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e47a02');
select pg_temp.check((select expected = 9 and counted = 8 and gap = -1 from public.stock_count_lines('00000000-0000-0000-0000-000000e47e11') where item_id = '00000000-0000-0000-0000-000000e47f01'),
  'the cream: 9 expected when it was counted (8 now + the 1 sold since), 8 counted');
select pg_temp.check((select gap = 0 from public.stock_count_lines('00000000-0000-0000-0000-000000e47e11') where variant_id = '00000000-0000-0000-0000-000000e47f21'), 'S as expected');
select pg_temp.refused_with($$select public.stock_count_approve('00000000-0000-0000-0000-000000e47e11')$$, 'the owner approves', 'a manager approves no count');
select pg_temp.as_user('00000000-0000-0000-0000-000000e47a01');
select pg_temp.check((public.stock_count_approve('00000000-0000-0000-0000-000000e47e11', 'אושר')->>'moved')::int = 1, 'the owner approves: one difference moves');
select pg_temp.check(public.stock_count_approve('00000000-0000-0000-0000-000000e47e11')->>'result' = 'already', 'approved twice: once');
select pg_temp.refused_with($$select public.stock_count_set('00000000-0000-0000-0000-000000e47e11', '00000000-0000-0000-0000-000000e47f01', null, 3)$$, 'count_closed', 'an approved count is closed');
-- a count that is dropped; a count with nothing in it
select public.stock_count_start('00000000-0000-0000-0000-000000e47e12', '00000000-0000-0000-0000-000000e47b01');
select pg_temp.check(public.stock_count_cancel('00000000-0000-0000-0000-000000e47e12')->>'result' = 'ok', 'a count is dropped — nothing moves');
select public.stock_count_start('00000000-0000-0000-0000-000000e47e13', '00000000-0000-0000-0000-000000e47c03');
select pg_temp.refused_with($$select public.stock_count_approve('00000000-0000-0000-0000-000000e47e13')$$, 'count_empty', 'nothing was counted');
select public.stock_count_cancel('00000000-0000-0000-0000-000000e47e13');
commit;
select pg_temp.check(pg_temp.at('00000000-0000-0000-0000-000000e47c02', '00000000-0000-0000-0000-000000e47f01') = 7, 'the branch: 8 counted, less the 1 sold after counting');
select pg_temp.check((select count(*) = 1 and bool_and(reason = 'count' and delta = -1 and location_id = '00000000-0000-0000-0000-000000e47c02') from public.stock_movements where count_id = '00000000-0000-0000-0000-000000e47e11'),
  'one count move, at the branch, with the count');
select pg_temp.check((select status = 'approved' and approved_by = '00000000-0000-0000-0000-000000e47a01' and jsonb_array_length(result) = 2 from public.stock_counts where id = '00000000-0000-0000-0000-000000e47e11'),
  'the approved count keeps what it found');
select pg_temp.check((select count(*) = 0 from public.stock_movements where count_id in ('00000000-0000-0000-0000-000000e47e12', '00000000-0000-0000-0000-000000e47e13')), 'the dropped counts moved nothing');

-- ======================================================================================================================
-- 9. the store sells what is at its shipping location; a held unit is not sold at the register there
-- ======================================================================================================================
insert into public.stores (id, user_id, business_id, name, slug) values ('00000000-0000-0000-0000-000000e47801', '00000000-0000-0000-0000-000000e47a01', '00000000-0000-0000-0000-000000e47b01', 'החנות', 'stock-shop-a-store');
update public.stores set location_id = '00000000-0000-0000-0000-000000e47c02' where id = '00000000-0000-0000-0000-000000e47801';
select pg_temp.check(public.sf_stock('00000000-0000-0000-0000-000000e47f01', null) = 7 and (select (public.sf_prices(i)->>'stock')::int = 7 from public.catalog_items i where i.id = '00000000-0000-0000-0000-000000e47f01'),
  'the site: the branch''s 7 creams');
insert into public.orders (id, business_id, store_id, number, token_hash, subtotal, total, customer_name, customer_phone, customer_email, delivery_method,
                           terms_accepted_at, provider, expires_at)
values ('00000000-0000-0000-0000-000000e47802', '00000000-0000-0000-0000-000000e47b01', '00000000-0000-0000-0000-000000e47801', 1, repeat('c', 64), 500, 500, 'קונה', '0501234567', 'buyer@stock.test', 'pickup', now(), 'mock', now() + interval '15 minutes');
insert into public.stock_reservations (business_id, order_id, item_id, variant_id, qty, expires_at)
values ('00000000-0000-0000-0000-000000e47b01', '00000000-0000-0000-0000-000000e47802', '00000000-0000-0000-0000-000000e47f01', null, 5, now() + interval '15 minutes');
select pg_temp.check((select location_id = '00000000-0000-0000-0000-000000e47c02' from public.orders where id = '00000000-0000-0000-0000-000000e47802'), 'the order is the shipping location''s');
select pg_temp.check((select (public.sf_prices(i)->>'stock')::int = 2 from public.catalog_items i where i.id = '00000000-0000-0000-0000-000000e47f01'), 'the site: 7 less the 5 held');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e47a04');
select pg_temp.refused_with($$select pg_temp.sale('00000000-0000-0000-0000-000000e47507', '00000000-0000-0000-0000-000000e47a04', '00000000-0000-0000-0000-000000e47d02', '00000000-0000-0000-0000-000000e47f01', 3)$$, 'שמור להזמנה באתר',
  'the branch''s register does not sell units held for the site');
select pg_temp.as_user('00000000-0000-0000-0000-000000e47a03');
select pg_temp.sale('00000000-0000-0000-0000-000000e47508', '00000000-0000-0000-0000-000000e47a03', '00000000-0000-0000-0000-000000e47b01', '00000000-0000-0000-0000-000000e47f01', 2);
select pg_temp.as_user('00000000-0000-0000-0000-000000e47a01');
select pg_temp.check((select bool_and(x->>'location' = '00000000-0000-0000-0000-000000e47c02') and count(*) = 1 from jsonb_array_elements(public.reserved_stock()) x),
  'the register is told where the held units are');
select pg_temp.as_user('00000000-0000-0000-0000-000000e47a02');
select pg_temp.refused_with($$select public.stock_transfer_send(gen_random_uuid(), '00000000-0000-0000-0000-000000e47c02', '00000000-0000-0000-0000-000000e47b01', '[{"itemId":"00000000-0000-0000-0000-000000e47f01","qty":3}]')$$, 'reserved_for_online',
  'held units do not leave the shipping location');
commit;
select pg_temp.check(pg_temp.at('00000000-0000-0000-0000-000000e47b01', '00000000-0000-0000-0000-000000e47f01') = 2 and pg_temp.at('00000000-0000-0000-0000-000000e47c02', '00000000-0000-0000-0000-000000e47f01') = 7, 'the main location''s register sold — the held units are elsewhere');
-- the order is paid and becomes an online sale: it takes from the shipping location
insert into public.sales (id, user_id, business_id, channel, items, subtotal, total, vat_rate, vat_amount, method, status, paid_at)
values ('00000000-0000-0000-0000-000000e47802', '00000000-0000-0000-0000-000000e47a01', '00000000-0000-0000-0000-000000e47b01', 'online', '[{"name":"קרם","price":100,"qty":5,"itemId":"00000000-0000-0000-0000-000000e47f01","kind":"product"}]', 500, 500, 18, 76.27, 'card', 'paid', now());
select pg_temp.check(pg_temp.at('00000000-0000-0000-0000-000000e47c02', '00000000-0000-0000-0000-000000e47f01') = 2 and (select location_id = '00000000-0000-0000-0000-000000e47c02' from public.sales where id = '00000000-0000-0000-0000-000000e47802'),
  'the online sale takes from the shipping location');

-- ======================================================================================================================
-- 10. who sees what
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e47a01');
select pg_temp.check((select count(distinct location_id) = 2 from public.stock_levels), 'the owner reads the counts of the branch and the warehouse');
select pg_temp.refused_with($$insert into public.stock_levels (business_id, location_id, item_id, qty) values ('00000000-0000-0000-0000-000000e47b01', '00000000-0000-0000-0000-000000e47c03', '00000000-0000-0000-0000-000000e47f01', 100)$$, 'permission denied',
  'nobody writes a count by hand');
select pg_temp.refused_with($$update public.stock_transfers set status = 'received' where id = '00000000-0000-0000-0000-000000e47e02'$$, 'permission denied', 'nor a transfer');
select pg_temp.check((select count(*) = 2 from public.stock_transfers) and (select count(*) = 3 from public.stock_counts), 'the owner: every transfer and count');
select public.location_select('00000000-0000-0000-0000-000000e47c03');
select pg_temp.check((select count(*) = 0 from public.stock_transfers) and (select count(*) = 1 from public.stock_counts)
  and (select bool_and(coalesce(location_id, business_id) = '00000000-0000-0000-0000-000000e47c03') from public.stock_movements), 'working in the warehouse: its transfers, counts and moves only');
select public.location_select(null);
select pg_temp.as_user('00000000-0000-0000-0000-000000e47a02');
select pg_temp.check((select bool_and(location_id = '00000000-0000-0000-0000-000000e47c02') from public.stock_levels), 'a member limited to the branch: its counts');
select pg_temp.check((select count(*) = 2 from public.stock_transfers) and (select count(*) = 1 from public.stock_counts), 'its transfers (both touch the branch) and its count');
select pg_temp.as_user('00000000-0000-0000-0000-000000e47a03');
select pg_temp.check((select count(*) = 0 from public.stock_transfers) and (select count(*) = 0 from public.stock_counts)
  and (select count(*) = 0 from public.stock_movements), 'a cashier: no transfer, no count, no stock log');
select pg_temp.as_user('00000000-0000-0000-0000-000000e47a06');
select pg_temp.check((select count(*) = 0 from public.stock_transfers) and (select count(*) = 0 from public.stock_levels), 'another business: nothing of SA');
commit;

-- ======================================================================================================================
-- 11. every location's count is the sum of its moves (nothing moved it otherwise), and the main one's is the rest
-- ======================================================================================================================
select pg_temp.check((select bool_and(s.qty = (select coalesce(sum(m.delta), 0) from public.stock_movements m
                                                where m.location_id = s.location_id and m.item_id = s.item_id
                                                  and (s.variant_id is null or m.variant_id = s.variant_id)))
                      from public.stock_levels s where s.business_id = '00000000-0000-0000-0000-000000e47b01'), 'every kept count = the sum of the moves there');
select pg_temp.check((select bool_and(m.location_after is not null) from public.stock_movements m where m.business_id = '00000000-0000-0000-0000-000000e47b01' and m.location_id is not null),
  'every move since 4700 says the count where it moved');
