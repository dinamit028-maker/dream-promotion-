-- Dream Commerce stage 1 (2.54.0, migration 3300) on a real Postgres (tests/sql/run.sh): one catalog with variants, pictures and
-- the business's own fields — and stock per variant in every path that moves stock: a register sale, its cancellation, a refund
-- back to stock, a direct document, its cancellation, a credit invoice back to stock, a delivery of an expense and its void,
-- a delivery / a count of a variant, the reconcile. An item without variants must behave exactly as before.
-- Tried as the signed-in roles (authenticated + a JWT subject), never as the superuser, except where the server (service role)
-- is the one acting. Fixtures only:
--   Fashion (company, VAT)  owner O, cashier K, viewer V        Beauty  owner P — another business
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
create or replace function pg_temp.affected(stmt text) returns int language plpgsql as $$
declare n int; begin execute stmt; get diagnostics n = row_count; return n; end $$;
create or replace function pg_temp.as_user(uid text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', uid, true), set_config('request.jwt.claim.role', 'authenticated', true);
$$;
create or replace function pg_temp.issue(r jsonb) returns uuid language plpgsql as $$
declare cols text; id uuid;
begin
  select string_agg(quote_ident(k), ', ') into cols from jsonb_object_keys(r) k;
  execute format('insert into public.documents (%s) select %s from jsonb_populate_record(null::public.documents, $1) returning id', cols, cols) using r into id;
  return id;
end $$;
-- a direct document of one product line (amounts ex VAT, 18%)
create or replace function pg_temp.doc(p_type int, p_key text, p_line jsonb, p_extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('user_id', '00000000-0000-0000-0000-0000000330a1', 'doc_type', p_type, 'doc_number', 0, 'doc_date', public.il_today(),
    'customer_name', 'לקוחה', 'before_discount', (p_line->>'totalExVat')::numeric, 'discount', 0, 'after_discount', (p_line->>'totalExVat')::numeric,
    'vat_amount', round((p_line->>'totalExVat')::numeric * 0.18, 2), 'total', round((p_line->>'totalExVat')::numeric * 1.18, 2), 'vat_rate', 18,
    'idempotency_key', p_key, 'lines', jsonb_build_array(p_line),
    'payments', case when p_type in (320, 400) then jsonb_build_array(jsonb_build_object('method', 1, 'amount', round((p_line->>'totalExVat')::numeric * 1.18, 2), 'date', public.il_today())) else '[]'::jsonb end)
    || p_extra;
$$;
create or replace function pg_temp.qty(p_id uuid) returns int language sql as $$
  select coalesce((select stock_qty from public.catalog_variants where id = p_id), (select stock_qty from public.catalog_items where id = p_id));
$$;

-- ---- the world (ids: items …331f., variants …333a., pictures …334d.) ------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000330a1', 'owner@fashion.test'), ('00000000-0000-0000-0000-0000000330c1', 'cashier@fashion.test'),
  ('00000000-0000-0000-0000-0000000330f1', 'viewer@fashion.test'), ('00000000-0000-0000-0000-0000000330a2', 'owner@beauty.test');
insert into public.businesses (id, name, slug) values
  ('00000000-0000-0000-0000-00000033b001', 'Fashion', 'fashion-cc'), ('00000000-0000-0000-0000-00000033b002', 'Beauty', 'beauty-cc');
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-00000033b001', '00000000-0000-0000-0000-0000000330a1', 'owner', 'full'),
  ('00000000-0000-0000-0000-00000033b001', '00000000-0000-0000-0000-0000000330c1', 'editor', 'register'),
  ('00000000-0000-0000-0000-00000033b001', '00000000-0000-0000-0000-0000000330f1', 'viewer', 'full'),
  ('00000000-0000-0000-0000-00000033b002', '00000000-0000-0000-0000-0000000330a2', 'owner', 'full');
insert into public.register_settings (user_id, business_id, business_type, vat_rate, dealer_number, legal_name, street, city, entity_type) values
  ('00000000-0000-0000-0000-0000000330a1', '00000000-0000-0000-0000-00000033b001', 'licensed', 18, '514000004', 'אופנה בע"מ', 'הרצל', 'תל אביב', 'company');
insert into public.catalog_items (id, user_id, business_id, name, price, kind, track_stock, stock_qty, low_stock) values
  ('00000000-0000-0000-0000-0000000331f1', '00000000-0000-0000-0000-0000000330a1', '00000000-0000-0000-0000-00000033b001', 'חולצה', 100, 'product', true, 10, 2),
  ('00000000-0000-0000-0000-0000000331f2', '00000000-0000-0000-0000-0000000330a1', '00000000-0000-0000-0000-00000033b001', 'כובע', 50, 'product', true, 5, 1),
  ('00000000-0000-0000-0000-0000000331f3', '00000000-0000-0000-0000-0000000330a1', '00000000-0000-0000-0000-00000033b001', 'גרביים', 20, 'product', false, 0, 0),
  ('00000000-0000-0000-0000-0000000332f1', '00000000-0000-0000-0000-0000000330a2', '00000000-0000-0000-0000-00000033b002', 'מסכה', 80, 'product', true, 3, 0);
-- an old edit time, to see what moves it
update public.catalog_items set updated_at = '2020-01-01' where business_id = '00000000-0000-0000-0000-00000033b001';

-- the lines reader (pure)
select pg_temp.check((select count(*) from public.stock_lines_v('[
    {"itemId":"00000000-0000-0000-0000-0000000331f1","qty":1},
    {"itemId":"00000000-0000-0000-0000-0000000331f1","variantId":"00000000-0000-0000-0000-0000000333a1","qty":"2.7"},
    {"itemId":"00000000-0000-0000-0000-0000000331f1","variantId":"00000000-0000-0000-0000-0000000333a1","qty":1},
    {"itemId":"00000000-0000-0000-0000-0000000331f1","variantId":"nope","qty":1},
    {"itemId":"bad","qty":1}, {"itemId":"00000000-0000-0000-0000-0000000331f1","qty":-1}, {"name":"free","qty":1}]')) = 2,
  'lines per (item, variant): a bad variant id counts as no variant, junk is ignored');
select pg_temp.check((select qty from public.stock_lines_v('[{"itemId":"00000000-0000-0000-0000-0000000331f1","variantId":"00000000-0000-0000-0000-0000000333a1","qty":"2.7"},
    {"itemId":"00000000-0000-0000-0000-0000000331f1","variantId":"00000000-0000-0000-0000-0000000333a1","qty":1}]')) = 3, 'whole units, summed per variant');
select pg_temp.check((select count(*) from public.stock_lines_v('null')) = 0 and (select count(*) from public.stock_lines_v('{}')) = 0, 'not a list: nothing');
select pg_temp.check((select array_agg(variant_id is null order by item_id, variant_id) from public.stock_lines_v('[
    {"itemId":"00000000-0000-0000-0000-0000000331f1","qty":1},
    {"itemId":"00000000-0000-0000-0000-0000000331f1","variantId":"00000000-0000-0000-0000-0000000333a1","qty":1}]')) = array[false, true],
  'always in the same order (item, then variant), so two sales lock rows in the same order');

-- ======================================================================================================================
-- the owner: product fields, options, variants, codes
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000330a1');

select pg_temp.check((select not publish_online and not has_variants and description = '' and slug is null and online_price is null
  from public.catalog_items where id = '00000000-0000-0000-0000-0000000331f1'), 'an existing item: not published, no variants, nothing new filled');
update public.catalog_items set slug = 'חולצה-כותנה', description = 'כותנה סרוקה', seo_title = 'חולצת כותנה', sku = 'SH', barcode = '7290000000004',
  online_price = 95, compare_at_price = 120, tags = '{קיץ,כותנה}', manufacturer = 'אופנה', country_of_origin = 'ישראל',
  custom_fields = '{"washing":"30 מעלות"}'
 where id = '00000000-0000-0000-0000-0000000331f1';
select pg_temp.check((select updated_at > '2020-01-02' from public.catalog_items where id = '00000000-0000-0000-0000-0000000331f1'), 'an edit of the product is its edit time');
select pg_temp.refused_with($$update public.catalog_items set slug = 'Bad Slug' where id = '00000000-0000-0000-0000-0000000331f2'$$, 'slug', 'a slug with capitals and a space');
select pg_temp.refused($$update public.catalog_items set slug = 'a--b' where id = '00000000-0000-0000-0000-0000000331f2'$$, 'a slug with a double dash');
select pg_temp.refused_with($$update public.catalog_items set slug = 'חולצה-כותנה' where id = '00000000-0000-0000-0000-0000000331f2'$$, 'catalog_items_slug_uq', 'one slug per business');
select pg_temp.refused($$update public.catalog_items set barcode = 'ab' where id = '00000000-0000-0000-0000-0000000331f2'$$, 'a barcode of two characters');
select pg_temp.refused($$update public.catalog_items set online_price = -1 where id = '00000000-0000-0000-0000-0000000331f2'$$, 'a negative online price');
select pg_temp.refused($$update public.catalog_items set custom_fields = '[]' where id = '00000000-0000-0000-0000-0000000331f2'$$, 'custom fields that are not an object');
select pg_temp.refused_with($$update public.catalog_items set sku = 'sh' where id = '00000000-0000-0000-0000-0000000331f2'$$, 'code_taken', 'a SKU taken by another item (any case)');
-- publishing stamps the first time; a stock move is not an edit
update public.catalog_items set publish_online = true where id = '00000000-0000-0000-0000-0000000331f1';
select pg_temp.check((select published_at is not null from public.catalog_items where id = '00000000-0000-0000-0000-0000000331f1'), 'publishing stamps published_at');
select pg_temp.check(public.adjust_stock('00000000-0000-0000-0000-0000000331f2', 'add', 1, 'משלוח') = 6, 'an item without variants: a delivery, as before');
select pg_temp.check((select updated_at = '2020-01-01' from public.catalog_items where id = '00000000-0000-0000-0000-0000000331f2'), 'a stock move does not change the edit time');

-- the business's own fields
insert into public.catalog_field_defs (field_key, label, kind) values ('size_chart', 'טבלת מידות', 'multiline');
select pg_temp.check((select business_id from public.catalog_field_defs where field_key = 'size_chart') = '00000000-0000-0000-0000-00000033b001', 'a field belongs to the business');
select pg_temp.refused($$insert into public.catalog_field_defs (field_key, label) values ('Size Chart', 'x')$$, 'a field key with capitals');
select pg_temp.refused_with($$insert into public.catalog_field_defs (field_key, label) values ('size_chart', 'שוב')$$, 'catalog_field_defs_key_uq', 'the same field twice');

-- options and variants
insert into public.catalog_options (item_id, position, name, choices, business_id)
values ('00000000-0000-0000-0000-0000000331f1', 1, 'מידה', '{S,M}', '00000000-0000-0000-0000-00000033b002');
select pg_temp.check((select business_id from public.catalog_options where item_id = '00000000-0000-0000-0000-0000000331f1') = '00000000-0000-0000-0000-00000033b001',
  'an option takes its item''s business, whatever was sent');
select pg_temp.refused($$insert into public.catalog_options (item_id, position, name, choices) values ('00000000-0000-0000-0000-0000000331f1', 4, 'x', '{a}')$$, 'a fourth option');
select pg_temp.refused($$insert into public.catalog_options (item_id, position, name, choices) values ('00000000-0000-0000-0000-0000000331f1', 1, 'צבע', '{a}')$$, 'two options in one place');
insert into public.catalog_variants (id, item_id, option1, sku, barcode, position) values
  ('00000000-0000-0000-0000-0000000333a1', '00000000-0000-0000-0000-0000000331f1', 'S', 'SH-S', '7290000000011', 1),
  ('00000000-0000-0000-0000-0000000333a2', '00000000-0000-0000-0000-0000000331f1', 'M', 'SH-M', '', 2);
select pg_temp.check((select has_variants from public.catalog_items where id = '00000000-0000-0000-0000-0000000331f1'), 'the item has variants now');
select pg_temp.check(pg_temp.qty('00000000-0000-0000-0000-0000000331f1') = 10 and pg_temp.qty('00000000-0000-0000-0000-0000000333a1') = 0,
  'its 10 units stay on the item (not assigned to a variant), never moved to a variant at random');
select pg_temp.check((select bool_and(business_id = '00000000-0000-0000-0000-00000033b001') from public.catalog_variants), 'variants belong to the business');
select pg_temp.refused_with($$insert into public.catalog_variants (item_id, option1, stock_qty) values ('00000000-0000-0000-0000-0000000331f1', 'L', 5)$$,
  'stock changes only', 'a new variant that brings its own stock');
select pg_temp.refused_with($$update public.catalog_variants set stock_qty = 99 where id = '00000000-0000-0000-0000-0000000333a1'$$, 'stock changes only', 'variant stock by a bare update');
select pg_temp.refused($$insert into public.catalog_variants (item_id, option1) values ('00000000-0000-0000-0000-0000000331f1', 'S')$$, 'the same variant twice');
select pg_temp.refused_with($$insert into public.catalog_variants (item_id, option1, sku) values ('00000000-0000-0000-0000-0000000331f1', 'L', 'sh')$$, 'code_taken',
  'a variant with the SKU of an item');
select pg_temp.refused_with($$insert into public.catalog_variants (item_id, option1, barcode) values ('00000000-0000-0000-0000-0000000331f1', 'L', '7290000000004')$$, 'code_taken',
  'a variant with the barcode of an item');
select pg_temp.refused_with($$update public.catalog_items set barcode = '7290000000011' where id = '00000000-0000-0000-0000-0000000331f2'$$, 'code_taken', 'an item with the barcode of a variant');
select pg_temp.refused_with($$insert into public.catalog_items (user_id, name, price, sku) values ('00000000-0000-0000-0000-0000000330a1', 'חדש', 1, 'sh-m')$$, 'code_taken',
  'a new item with the SKU of a variant (the business is known before the check)');
select pg_temp.refused($$update public.catalog_variants set item_id = '00000000-0000-0000-0000-0000000331f2' where id = '00000000-0000-0000-0000-0000000333a1'$$, 'a variant moves to another item');
update public.catalog_variants set business_id = '00000000-0000-0000-0000-00000033b002', price = 110 where id = '00000000-0000-0000-0000-0000000333a1';
select pg_temp.check((select business_id = '00000000-0000-0000-0000-00000033b001' and price = 110 from public.catalog_variants where id = '00000000-0000-0000-0000-0000000333a1'),
  'a variant never moves to another business');

-- counting per variant
select pg_temp.refused_with($$select public.adjust_stock('00000000-0000-0000-0000-0000000331f1', 'add', 1)$$, 'variant_required', 'an item with variants is counted per variant');
select pg_temp.check(public.adjust_variant_stock('00000000-0000-0000-0000-0000000333a1', 'set', 4, 'ספירה') = 4, 'a count of S');
select pg_temp.check(public.adjust_variant_stock('00000000-0000-0000-0000-0000000333a2', 'add', 6, 'משלוח') = 6, 'a delivery of M');
select pg_temp.check(pg_temp.qty('00000000-0000-0000-0000-0000000331f1') = 20, 'the item moves with its variants (10 not assigned + 4 + 6)');
select pg_temp.check((select count(*) from public.stock_movements where variant_id = '00000000-0000-0000-0000-0000000333a1' and reason = 'count' and delta = 4 and qty_after = 4) = 1,
  'a variant''s move is logged with the variant''s count');
select pg_temp.refused($$select public.adjust_variant_stock('00000000-0000-0000-0000-0000000333a1', 'add', 0)$$, 'a delivery of nothing');
select pg_temp.refused($$select public.adjust_variant_stock('00000000-0000-0000-0000-0000000333a1', 'set', -1)$$, 'a negative count');
select pg_temp.refused($$select public.adjust_variant_stock('00000000-0000-0000-0000-0000000333a1', 'x', 1)$$, 'an unknown mode');
select pg_temp.check(public.reconcile_variant_stock('00000000-0000-0000-0000-0000000331f1') = 10, 'after counting every variant: the item = the sum of its variants');
select pg_temp.check((select count(*) from public.stock_movements where item_id = '00000000-0000-0000-0000-0000000331f1' and reason = 'count' and delta = -10
  and variant_id is null and note like '%לא משויך לווריאנט%') = 1, 'the units that were not assigned are dropped as a logged count');
select pg_temp.refused_with($$select public.reconcile_variant_stock('00000000-0000-0000-0000-0000000331f2')$$, 'no variants', 'reconcile an item without variants');
commit;

-- ======================================================================================================================
-- every stock path, per variant (S = 4, M = 6, item = 10; the hat = 6)
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000330a1');

-- a register sale: S × 2, the hat × 1, a shirt without a variant, a shirt with a broken variant id, a junk line
insert into public.sales (id, user_id, items, subtotal, discount, total, vat_rate, vat_amount, method, status, paid_at)
values ('00000000-0000-0000-0000-0000000335a1', '00000000-0000-0000-0000-0000000330a1', '[
  {"name":"חולצה · S","price":100,"qty":2,"itemId":"00000000-0000-0000-0000-0000000331f1","variantId":"00000000-0000-0000-0000-0000000333a1","kind":"product"},
  {"name":"כובע","price":50,"qty":1,"itemId":"00000000-0000-0000-0000-0000000331f2","kind":"product"},
  {"name":"חולצה","price":100,"qty":1,"itemId":"00000000-0000-0000-0000-0000000331f1","kind":"product"},
  {"name":"חולצה ?","price":100,"qty":1,"itemId":"00000000-0000-0000-0000-0000000331f1","variantId":"nope","kind":"product"},
  {"name":"x","price":0,"qty":"junk","itemId":"00000000-0000-0000-0000-0000000331f1","variantId":"00000000-0000-0000-0000-0000000333a1"}]',
  450, 0, 450, 18, 68.64, 'cash', 'paid', now());
select pg_temp.check(pg_temp.qty('00000000-0000-0000-0000-0000000333a1') = 2, 'S: 4 − 2');
select pg_temp.check(pg_temp.qty('00000000-0000-0000-0000-0000000333a2') = 6, 'M did not move');
select pg_temp.check(pg_temp.qty('00000000-0000-0000-0000-0000000331f1') = 6, 'the shirt: 10 − 4 (two of S, two without a variant)');
select pg_temp.check(pg_temp.qty('00000000-0000-0000-0000-0000000331f2') = 5, 'the hat (no variants): 6 − 1, as before');
select pg_temp.check((select count(*) from public.stock_movements where sale_id = '00000000-0000-0000-0000-0000000335a1' and variant_id = '00000000-0000-0000-0000-0000000333a1'
  and delta = -2 and qty_after = 2 and reason = 'sale') = 1, 'the sale of S is logged on S');
select pg_temp.check((select count(*) from public.stock_movements where sale_id = '00000000-0000-0000-0000-0000000335a1' and item_id = '00000000-0000-0000-0000-0000000331f1'
  and variant_id is null and delta = -2 and qty_after = 6 and note = 'לא משויך לווריאנט') = 1, 'the shirts without a variant are logged "not assigned"');
select pg_temp.check((select note from public.stock_movements where sale_id = '00000000-0000-0000-0000-0000000335a1' and item_id = '00000000-0000-0000-0000-0000000331f2') = '',
  'an item without variants is logged as before');
-- a line whose variant belongs to another item moves the item only
insert into public.sales (id, user_id, items, subtotal, total, vat_rate, vat_amount, method, status, paid_at)
values ('00000000-0000-0000-0000-0000000335a2', '00000000-0000-0000-0000-0000000330a1',
  '[{"name":"כובע","price":50,"qty":1,"itemId":"00000000-0000-0000-0000-0000000331f2","variantId":"00000000-0000-0000-0000-0000000333a2"}]', 50, 50, 18, 7.63, 'cash', 'paid', now());
select pg_temp.check(pg_temp.qty('00000000-0000-0000-0000-0000000331f2') = 4 and pg_temp.qty('00000000-0000-0000-0000-0000000333a2') = 6,
  'a variant of another item never moves');
-- a payment request takes M; cancelling it puts M back
insert into public.sales (id, user_id, items, subtotal, total, method, status)
values ('00000000-0000-0000-0000-0000000335a3', '00000000-0000-0000-0000-0000000330a1',
  '[{"name":"חולצה · M","price":100,"qty":1,"itemId":"00000000-0000-0000-0000-0000000331f1","variantId":"00000000-0000-0000-0000-0000000333a2"}]', 100, 100, 'link', 'pending');
select pg_temp.check(pg_temp.qty('00000000-0000-0000-0000-0000000333a2') = 5 and pg_temp.qty('00000000-0000-0000-0000-0000000331f1') = 5, 'a payment request takes M');
update public.sales set status = 'cancelled' where id = '00000000-0000-0000-0000-0000000335a3';
select pg_temp.check(pg_temp.qty('00000000-0000-0000-0000-0000000333a2') = 6 and pg_temp.qty('00000000-0000-0000-0000-0000000331f1') = 6, 'cancelling puts M back');
select pg_temp.check((select count(*) from public.stock_movements where sale_id = '00000000-0000-0000-0000-0000000335a3' and reason = 'cancel'
  and variant_id = '00000000-0000-0000-0000-0000000333a2' and delta = 1) = 1, 'the cancellation is logged on M');
-- a refund back to stock
insert into public.sale_refunds (user_id, sale_id, amount, vat_amount, method, items, restock, reason)
values ('00000000-0000-0000-0000-0000000330a1', '00000000-0000-0000-0000-0000000335a1', 100, 15.25, 'cash',
  '[{"name":"חולצה · S","price":100,"qty":1,"itemId":"00000000-0000-0000-0000-0000000331f1","variantId":"00000000-0000-0000-0000-0000000333a1","kind":"product"}]', true, 'מידה לא מתאימה');
select pg_temp.check(pg_temp.qty('00000000-0000-0000-0000-0000000333a1') = 3 and pg_temp.qty('00000000-0000-0000-0000-0000000331f1') = 7, 'the returned S is back on S');
select pg_temp.check((select count(*) from public.stock_movements where reason = 'refund' and refund_id is not null and variant_id = '00000000-0000-0000-0000-0000000333a1') = 1,
  'the return is logged on S');

-- a transaction invoice (300) for M × 2; cancelled as issued by mistake
select pg_temp.issue(pg_temp.doc(300, 'cc-300', jsonb_build_object('name', 'חולצה · M', 'qty', 2, 'unitPriceExVat', 100, 'discountExVat', 0, 'totalExVat', 200,
  'vatRate', 18, 'kind', 1, 'itemId', '00000000-0000-0000-0000-0000000331f1', 'variantId', '00000000-0000-0000-0000-0000000333a2')));
select pg_temp.check(pg_temp.qty('00000000-0000-0000-0000-0000000333a2') = 4 and pg_temp.qty('00000000-0000-0000-0000-0000000331f1') = 5, 'two of M out on the 300');
select pg_temp.check((select count(*) from public.stock_movements m join public.documents d on d.id = m.document_id
  where d.idempotency_key = 'cc-300' and m.variant_id = '00000000-0000-0000-0000-0000000333a2' and m.delta = -2) = 1, 'logged on M, with its document');
insert into public.document_cancellations (document_id, user_id, reason)
values ((select id from public.documents where idempotency_key = 'cc-300'), '00000000-0000-0000-0000-0000000330a1', 'הופקה בטעות');
select pg_temp.check(pg_temp.qty('00000000-0000-0000-0000-0000000333a2') = 6 and pg_temp.qty('00000000-0000-0000-0000-0000000331f1') = 7, 'cancelling the 300 brings M back');
select pg_temp.check((select count(*) from public.stock_movements where reason = 'cancel' and variant_id = '00000000-0000-0000-0000-0000000333a2' and delta = 2
  and document_id = (select id from public.documents where idempotency_key = 'cc-300')) = 1, 'logged as a cancellation on M');
-- a receipt that stands alone (320) for S × 1, then a credit invoice (330) that takes it back to stock
select pg_temp.issue(pg_temp.doc(320, 'cc-320', jsonb_build_object('name', 'חולצה · S', 'qty', 1, 'unitPriceExVat', 100, 'discountExVat', 0, 'totalExVat', 100,
  'vatRate', 18, 'kind', 1, 'itemId', '00000000-0000-0000-0000-0000000331f1', 'variantId', '00000000-0000-0000-0000-0000000333a1')));
select pg_temp.check(pg_temp.qty('00000000-0000-0000-0000-0000000333a1') = 2 and pg_temp.qty('00000000-0000-0000-0000-0000000331f1') = 6, 'one S out on the receipt');
select pg_temp.issue(pg_temp.doc(330, 'cc-330', jsonb_build_object('name', 'חולצה · S', 'qty', 1, 'unitPriceExVat', 100, 'discountExVat', 0, 'totalExVat', 100,
  'vatRate', 18, 'kind', 1, 'itemId', '00000000-0000-0000-0000-0000000331f1', 'variantId', '00000000-0000-0000-0000-0000000333a1', 'restock', true),
  jsonb_build_object('base_doc_type', 320, 'base_doc_number', (select doc_number from public.documents where idempotency_key = 'cc-320'))));
select pg_temp.check(pg_temp.qty('00000000-0000-0000-0000-0000000333a1') = 3 and pg_temp.qty('00000000-0000-0000-0000-0000000331f1') = 7, 'the credit invoice brings S back');

-- a delivery with an expense: M × 3 and one shirt without a variant; the void takes both out again
insert into public.expenses (id, user_id, supplier_name, doc_date, category, amount_before_vat, vat_amount, total, paid_on, payment_method, stock_lines)
values ('00000000-0000-0000-0000-0000000336e1', '00000000-0000-0000-0000-0000000330a1', 'ספק חולצות', public.il_today(), 'inventory', 300, 54, 354, public.il_today(), 'transfer',
  '[{"itemId":"00000000-0000-0000-0000-0000000331f1","variantId":"00000000-0000-0000-0000-0000000333a2","qty":3},{"itemId":"00000000-0000-0000-0000-0000000331f1","qty":1}]');
select pg_temp.check(public.receive_expense_stock('00000000-0000-0000-0000-0000000336e1') = 2, 'two stock lines came in');
select pg_temp.check(pg_temp.qty('00000000-0000-0000-0000-0000000333a2') = 9 and pg_temp.qty('00000000-0000-0000-0000-0000000331f1') = 11, 'M + 3, the shirt + 4');
select pg_temp.check(public.receive_expense_stock('00000000-0000-0000-0000-0000000336e1') = 0 and pg_temp.qty('00000000-0000-0000-0000-0000000331f1') = 11, 'and only once');
update public.expenses set status = 'void', void_reason = 'נרשם פעמיים' where id = '00000000-0000-0000-0000-0000000336e1';
select pg_temp.check(pg_temp.qty('00000000-0000-0000-0000-0000000333a2') = 6 and pg_temp.qty('00000000-0000-0000-0000-0000000331f1') = 7, 'the void takes M and the shirt out again');
select pg_temp.check((select count(*) from public.stock_movements where expense_id = '00000000-0000-0000-0000-0000000336e1' and reason = 'adjust') = 2, 'per variant and per "not assigned"');

-- an item that is not tracked: its variant moves nothing until it is counted
insert into public.catalog_variants (id, item_id, option1) values ('00000000-0000-0000-0000-0000000333a3', '00000000-0000-0000-0000-0000000331f3', 'L');
insert into public.sales (user_id, items, subtotal, total, vat_rate, vat_amount, method, status, paid_at)
values ('00000000-0000-0000-0000-0000000330a1', '[{"name":"גרביים · L","price":20,"qty":1,"itemId":"00000000-0000-0000-0000-0000000331f3","variantId":"00000000-0000-0000-0000-0000000333a3"}]',
  20, 20, 18, 3.05, 'cash', 'paid', now());
select pg_temp.check(pg_temp.qty('00000000-0000-0000-0000-0000000333a3') = 0 and (select count(*) from public.stock_movements where item_id = '00000000-0000-0000-0000-0000000331f3') = 0,
  'an item that is not tracked never moves, nor do its variants');
select pg_temp.check(public.adjust_variant_stock('00000000-0000-0000-0000-0000000333a3', 'add', 2) = 2, 'a delivery of L');
select pg_temp.check((select track_stock and stock_qty = 2 from public.catalog_items where id = '00000000-0000-0000-0000-0000000331f3'), 'counting a variant starts tracking the item');

-- the old movers keep working (an item without variants)
select pg_temp.check(public.adjust_stock('00000000-0000-0000-0000-0000000331f2', 'set', 10, 'ספירה') = 10, 'a count of the hat, as before');
select pg_temp.check((select variant_id is null and qty_after = 10 from public.stock_movements where item_id = '00000000-0000-0000-0000-0000000331f2' and reason = 'count'),
  'logged without a variant');
commit;

-- the sum of the movements is the stock — of the item and of every variant
select pg_temp.check((select bool_and(i.stock_qty = 0 + coalesce((select sum(m.delta) from public.stock_movements m where m.item_id = i.id), 0) + i.base)
  from (select id, stock_qty, case id when '00000000-0000-0000-0000-0000000331f1' then 10 when '00000000-0000-0000-0000-0000000331f2' then 5 else 0 end as base
          from public.catalog_items where business_id = '00000000-0000-0000-0000-00000033b001') i), 'every item: its first count + its log = its stock');
select pg_temp.check((select bool_and(v.stock_qty = coalesce((select sum(m.delta) from public.stock_movements m where m.variant_id = v.id), 0))
  from public.catalog_variants v where v.business_id = '00000000-0000-0000-0000-00000033b001'), 'every variant: its log = its stock');

-- ======================================================================================================================
-- pictures: inserted by the server only; the screen changes the alt text, the order, the variant — or deletes
-- ======================================================================================================================
-- the server (here: the superuser, as the service role would) registers two pictures after the upload
insert into public.catalog_media (id, item_id, path, url, sizes, width, height, position) values
  ('00000000-0000-0000-0000-0000000334d1', '00000000-0000-0000-0000-0000000331f1', '00000000-0000-0000-0000-00000033b001/p1', 'https://cdn.test/p1-1600.webp',
   '{"400":"https://cdn.test/p1-400.webp","1600":"https://cdn.test/p1-1600.webp"}', 1600, 1600, 0),
  ('00000000-0000-0000-0000-0000000334d2', '00000000-0000-0000-0000-0000000331f2', '00000000-0000-0000-0000-00000033b001/p2', 'https://cdn.test/p2.webp', '{}', 800, 800, 0);
select pg_temp.check((select bool_and(business_id = '00000000-0000-0000-0000-00000033b001') from public.catalog_media), 'a picture takes its item''s business');
select pg_temp.check((select image_url from public.catalog_items where id = '00000000-0000-0000-0000-0000000331f1') = 'https://cdn.test/p1-400.webp',
  'the first picture is the item''s main picture, in the 400 size (the register''s tile)');
select pg_temp.check((select image_url from public.catalog_items where id = '00000000-0000-0000-0000-0000000331f2') = 'https://cdn.test/p2.webp', 'without a 400 size: the main size');
select pg_temp.refused($$insert into public.catalog_media (item_id, path, url) values ('00000000-0000-0000-0000-0000000331f1', 'x', 'http://cdn.test/x.webp')$$, 'a picture that is not https');

begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000330a1');
select pg_temp.refused_with($$insert into public.catalog_media (item_id, path, url) values ('00000000-0000-0000-0000-0000000331f1', 'x', 'https://evil.test/x.webp')$$,
  'permission denied', 'a picture inserted from the browser');
select pg_temp.check(pg_temp.affected($$update public.catalog_media set alt = 'חולצה לבנה', position = 1 where id = '00000000-0000-0000-0000-0000000334d1'$$) = 1, 'alt text and order');
commit;
-- a second picture of the shirt (the server), moved before the first by the owner: it becomes the main picture
insert into public.catalog_media (id, item_id, path, url, position) values
  ('00000000-0000-0000-0000-0000000334d3', '00000000-0000-0000-0000-0000000331f1', '00000000-0000-0000-0000-00000033b001/p3', 'https://cdn.test/p3.webp', 2);
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000330a1');
select pg_temp.check((select image_url from public.catalog_items where id = '00000000-0000-0000-0000-0000000331f1') = 'https://cdn.test/p1-400.webp', 'a picture added last is not the main one');
update public.catalog_media set position = 0 where id = '00000000-0000-0000-0000-0000000334d3';
select pg_temp.check((select image_url from public.catalog_items where id = '00000000-0000-0000-0000-0000000331f1') = 'https://cdn.test/p3.webp', 'moved first: it is the main picture');
select pg_temp.check(pg_temp.affected($$delete from public.catalog_media where id = '00000000-0000-0000-0000-0000000334d3'$$) = 1, 'a picture is deleted');
select pg_temp.check((select image_url from public.catalog_items where id = '00000000-0000-0000-0000-0000000331f1') = 'https://cdn.test/p1-400.webp', 'the next picture is the main one again');
select pg_temp.refused_with($$update public.catalog_media set url = 'https://evil.test/x.webp' where id = '00000000-0000-0000-0000-0000000334d1'$$, 'permission denied',
  'the browser changes a picture''s address');
update public.catalog_media set variant_id = '00000000-0000-0000-0000-0000000333a1' where id = '00000000-0000-0000-0000-0000000334d1';
select pg_temp.refused_with($$update public.catalog_media set variant_id = '00000000-0000-0000-0000-0000000333a1' where id = '00000000-0000-0000-0000-0000000334d2'$$,
  'not of this item', 'a picture of the hat on a variant of the shirt');
select pg_temp.refused_with($$update public.catalog_variants set media_id = '00000000-0000-0000-0000-0000000334d2' where id = '00000000-0000-0000-0000-0000000333a1'$$,
  'not of this item', 'a variant of the shirt with a picture of the hat');
update public.catalog_variants set media_id = '00000000-0000-0000-0000-0000000334d1' where id = '00000000-0000-0000-0000-0000000333a1';
select pg_temp.check((select media_id from public.catalog_variants where id = '00000000-0000-0000-0000-0000000333a1') = '00000000-0000-0000-0000-0000000334d1', 'S has its picture');
-- an item with a variant and a picture linked both ways is deleted whole
insert into public.catalog_items (id, user_id, name, price, kind) values ('00000000-0000-0000-0000-0000000331f4', '00000000-0000-0000-0000-0000000330a1', 'זמני', 10, 'product');
insert into public.catalog_variants (id, item_id, option1) values ('00000000-0000-0000-0000-0000000333a4', '00000000-0000-0000-0000-0000000331f4', 'X');
commit;
insert into public.catalog_media (id, item_id, path, url) values ('00000000-0000-0000-0000-0000000334d4', '00000000-0000-0000-0000-0000000331f4', 'p4', 'https://cdn.test/p4.webp');

begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000330a1');
update public.catalog_media set variant_id = '00000000-0000-0000-0000-0000000333a4' where id = '00000000-0000-0000-0000-0000000334d4';
update public.catalog_variants set media_id = '00000000-0000-0000-0000-0000000334d4' where id = '00000000-0000-0000-0000-0000000333a4';
select pg_temp.check(pg_temp.affected($$delete from public.catalog_items where id = '00000000-0000-0000-0000-0000000331f4'$$) = 1, 'an item with variants and pictures is deleted');
select pg_temp.check(not exists (select 1 from public.catalog_variants where item_id = '00000000-0000-0000-0000-0000000331f4')
  and not exists (select 1 from public.catalog_media where item_id = '00000000-0000-0000-0000-0000000331f4'), 'with its variants and pictures');
-- deleting a picture clears it from its variant; deleting a variant keeps the stock log (without the link)
select pg_temp.check(pg_temp.affected($$delete from public.catalog_media where id = '00000000-0000-0000-0000-0000000334d1'$$) = 1, 'a picture is deleted');
select pg_temp.check((select media_id is null from public.catalog_variants where id = '00000000-0000-0000-0000-0000000333a1'), 'and its variant has no picture');
select pg_temp.check((select image_url from public.catalog_items where id = '00000000-0000-0000-0000-0000000331f1') = '', 'no picture left: no main picture');
select pg_temp.check(pg_temp.affected($$delete from public.catalog_variants where id = '00000000-0000-0000-0000-0000000333a3'$$) = 1, 'a variant is deleted');
select pg_temp.check(not (select has_variants from public.catalog_items where id = '00000000-0000-0000-0000-0000000331f3')
  and pg_temp.qty('00000000-0000-0000-0000-0000000331f3') = 2, 'its item has no variants now, and keeps its units');
select pg_temp.check((select count(*) from public.stock_movements where item_id = '00000000-0000-0000-0000-0000000331f3') = 1, 'the stock log of the item stays');
commit;

-- ======================================================================================================================
-- the cashier: reads the catalog (the register needs the variants and the pictures) and never writes it
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000330c1');
select pg_temp.check((select count(*) from public.catalog_variants) = 2 and (select count(*) from public.catalog_options) = 1
  and (select count(*) from public.catalog_media) = 1 and (select count(*) from public.catalog_field_defs) = 1, 'the cashier reads variants, options, pictures and fields');
select pg_temp.refused($$insert into public.catalog_variants (item_id, option1) values ('00000000-0000-0000-0000-0000000331f1', 'XL')$$, 'a cashier adds a variant');
select pg_temp.check(pg_temp.affected($$update public.catalog_variants set price = 1$$) = 0, 'a cashier changes no variant');
select pg_temp.check(pg_temp.affected($$delete from public.catalog_variants$$) = 0, 'a cashier deletes no variant');
select pg_temp.refused($$insert into public.catalog_options (item_id, position, name, choices) values ('00000000-0000-0000-0000-0000000331f2', 1, 'x', '{a}')$$, 'a cashier adds an option');
select pg_temp.refused($$insert into public.catalog_field_defs (field_key, label) values ('cashier_field', 'x')$$, 'a cashier adds a field');
select pg_temp.check(pg_temp.affected($$update public.catalog_media set alt = 'x'$$) = 0, 'a cashier changes no picture');
select pg_temp.check(pg_temp.affected($$update public.catalog_items set publish_online = false$$) = 0, 'a cashier unpublishes nothing');
select pg_temp.refused_with($$select public.adjust_variant_stock('00000000-0000-0000-0000-0000000333a1', 'add', 5)$$, 'not allowed', 'a cashier counts a variant');
select pg_temp.refused_with($$select public.reconcile_variant_stock('00000000-0000-0000-0000-0000000331f1')$$, 'not allowed', 'a cashier reconciles');
-- the cashier's sale of S moves S
insert into public.sales (user_id, items, subtotal, total, vat_rate, vat_amount, method, status, paid_at)
values ('00000000-0000-0000-0000-0000000330c1', '[{"name":"חולצה · S","price":110,"qty":1,"itemId":"00000000-0000-0000-0000-0000000331f1","variantId":"00000000-0000-0000-0000-0000000333a1"}]',
  110, 110, 18, 16.78, 'card', 'paid', now());
select pg_temp.check((select stock_qty from public.catalog_variants where id = '00000000-0000-0000-0000-0000000333a1') = 2, 'the cashier''s sale takes S');
commit;

-- ======================================================================================================================
-- the viewer reads and changes nothing
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000330f1');
select pg_temp.check((select count(*) from public.catalog_variants) = 2, 'the viewer reads the variants');
select pg_temp.refused($$insert into public.catalog_variants (item_id, option1) values ('00000000-0000-0000-0000-0000000331f1', 'XL')$$, 'a viewer adds a variant');
select pg_temp.check(pg_temp.affected($$update public.catalog_variants set price = 1$$) = 0, 'a viewer changes no variant');
select pg_temp.check(pg_temp.affected($$delete from public.catalog_options$$) = 0, 'a viewer deletes no option');
select pg_temp.check(pg_temp.affected($$delete from public.catalog_media$$) = 0, 'a viewer deletes no picture');
select pg_temp.refused($$insert into public.catalog_field_defs (field_key, label) values ('viewer_field', 'x')$$, 'a viewer adds a field');
select pg_temp.refused_with($$select public.adjust_variant_stock('00000000-0000-0000-0000-0000000333a1', 'add', 5)$$, 'not allowed', 'a viewer counts a variant');
commit;

-- ======================================================================================================================
-- another business: sees nothing, attaches nothing, moves nothing — and has its own codes
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000330a2');
select pg_temp.check((select count(*) from public.catalog_variants) = 0 and (select count(*) from public.catalog_options) = 0
  and (select count(*) from public.catalog_media) = 0 and (select count(*) from public.catalog_field_defs) = 0, 'Beauty sees nothing of Fashion''s catalog');
select pg_temp.refused_with($$insert into public.catalog_variants (item_id, option1) values ('00000000-0000-0000-0000-0000000331f1', 'XL')$$, 'item not found',
  'Beauty adds a variant to Fashion''s item');
select pg_temp.refused($$insert into public.catalog_options (item_id, position, name, choices) values ('00000000-0000-0000-0000-0000000331f1', 2, 'x', '{a}')$$,
  'Beauty adds an option to Fashion''s item');
select pg_temp.check(pg_temp.affected($$update public.catalog_variants set price = 1$$) = 0, 'Beauty changes no Fashion variant');
select pg_temp.refused_with($$select public.adjust_variant_stock('00000000-0000-0000-0000-0000000333a1', 'add', 5)$$, 'not allowed', 'Beauty counts Fashion''s variant');
select pg_temp.refused_with($$select public.reconcile_variant_stock('00000000-0000-0000-0000-0000000331f1')$$, 'not allowed', 'Beauty reconciles Fashion''s item');
-- the same slug, SKU and barcode are Beauty's own business
update public.catalog_items set slug = 'חולצה-כותנה', sku = 'SH-S' where id = '00000000-0000-0000-0000-0000000332f1';
insert into public.catalog_variants (item_id, option1, barcode) values ('00000000-0000-0000-0000-0000000332f1', 'ורוד', '7290000000011');
select pg_temp.check((select count(*) from public.catalog_variants) = 1, 'Beauty has its own variant with the same barcode');
-- a sale of Beauty that names Fashion's variant moves only Beauty's item
insert into public.sales (user_id, items, subtotal, total, vat_rate, vat_amount, method, status, paid_at)
values ('00000000-0000-0000-0000-0000000330a2', '[{"name":"x","price":80,"qty":1,"itemId":"00000000-0000-0000-0000-0000000331f1","variantId":"00000000-0000-0000-0000-0000000333a1"}]',
  80, 80, 18, 12.20, 'cash', 'paid', now());
commit;
select pg_temp.check(pg_temp.qty('00000000-0000-0000-0000-0000000333a1') = 2 and pg_temp.qty('00000000-0000-0000-0000-0000000331f1') = 6,
  'a sale of another business never moves Fashion''s stock');

-- ======================================================================================================================
-- anon: nothing
-- ======================================================================================================================
begin;
set local role anon;
select pg_temp.refused_with($$select count(*) from public.catalog_variants$$, 'permission denied', 'anon reads variants');
select pg_temp.refused_with($$select count(*) from public.catalog_media$$, 'permission denied', 'anon reads pictures');
select pg_temp.refused($$select public.adjust_variant_stock('00000000-0000-0000-0000-0000000333a1', 'add', 5)$$, 'anon counts a variant');
commit;

-- the bucket of the store's pictures: public, small, pictures only
select pg_temp.check((select public and file_size_limit = 5242880 and allowed_mime_types = array['image/webp', 'image/jpeg'] from storage.buckets where id = 'store-media'),
  'store-media: public pictures (webp / jpeg) of up to 5 MB');
select pg_temp.check(not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and (coalesce(qual, '') || coalesce(with_check, '')) like '%store-media%'),
  'no browser policy on store-media: uploads go through the server');
