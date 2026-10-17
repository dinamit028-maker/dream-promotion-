-- Products sold by a quote, and the site's requests into the leads (migration 20261017005400, 2.102.0) on a real Postgres
-- (tests/sql/run.sh). The storefront's server is service_role and reads only through sf_*; the dashboard's users are
-- authenticated + a JWT subject. The superuser only builds the world. Fixtures only:
--   Packs (company)  owner O, editor E — a store on the air, a store not yet on the air      Other  owner P — another business
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
create or replace function pg_temp.as_user(uid text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', uid, true), set_config('request.jwt.claim.role', 'authenticated', true);
$$;

-- ---- the world --------------------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000540a1', 'owner@packs.test'), ('00000000-0000-0000-0000-0000000540e1', 'editor@packs.test'),
  ('00000000-0000-0000-0000-0000000540a2', 'owner@other54.test');
insert into public.businesses (id, name, slug) values
  ('00000000-0000-0000-0000-00000054b001', 'Packs', 'packs-co'), ('00000000-0000-0000-0000-00000054b002', 'Other', 'other-54');
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-00000054b001', '00000000-0000-0000-0000-0000000540a1', 'owner', 'full'),
  ('00000000-0000-0000-0000-00000054b001', '00000000-0000-0000-0000-0000000540e1', 'editor', 'full'),
  ('00000000-0000-0000-0000-00000054b002', '00000000-0000-0000-0000-0000000540a2', 'owner', 'full');
update public.profiles set current_business_id = '00000000-0000-0000-0000-00000054b001'
 where id in ('00000000-0000-0000-0000-0000000540a1', '00000000-0000-0000-0000-0000000540e1');
-- a tote sold as before (₪40 on the site), a rope bag and a box sold by a quote (from $3.50 / $6), a hidden quote bag, another
-- business's quote bag
insert into public.catalog_items (id, user_id, business_id, name, price, kind, track_stock, stock_qty, slug, publish_online, online_price, sku,
                                  active, has_variants, tags, quote_mode, quote_from, quote_currency, quote_min_qty) values
  ('00000000-0000-0000-0000-000000541001', '00000000-0000-0000-0000-0000000540a1', '00000000-0000-0000-0000-00000054b001', 'שקית בד', 50, 'product', false, 0, 'tote', true, 40, 'TOTE', true, false, '{בד}', false, null, '', null),
  ('00000000-0000-0000-0000-000000541002', '00000000-0000-0000-0000-0000000540a1', '00000000-0000-0000-0000-00000054b001', 'שקית נייר עם ידית חבל – דגם 001', 0, 'product', false, 0, 'bag-001', true, null, 'bag-001', true, false, '{חבל וסרט}', true, 3.5, 'USD', null),
  ('00000000-0000-0000-0000-000000541003', '00000000-0000-0000-0000-0000000540a1', '00000000-0000-0000-0000-00000054b001', 'קופסה קשיחה מגנטית – דגם 031', 0, 'product', false, 0, 'bag-031', true, null, 'bag-031', true, false, '{קופסאות}', true, 6, 'USD', 300),
  ('00000000-0000-0000-0000-000000541004', '00000000-0000-0000-0000-0000000540a1', '00000000-0000-0000-0000-00000054b001', 'שקית סודית', 0, 'product', false, 0, 'secret', false, null, 'secret', true, false, '{}', true, 2, 'USD', null),
  ('00000000-0000-0000-0000-000000541009', '00000000-0000-0000-0000-0000000540a2', '00000000-0000-0000-0000-00000054b002', 'שקית של אחר', 0, 'product', false, 0, 'other-bag', true, null, 'OB', true, false, '{}', true, 1, 'USD', null);
insert into public.stores (id, business_id, name, phone, slug) values
  ('00000000-0000-0000-0000-000000545001', '00000000-0000-0000-0000-00000054b001', 'Packs', '03-5555555', 'packs-54'),
  ('00000000-0000-0000-0000-000000545002', '00000000-0000-0000-0000-00000054b002', 'Other', '03-6666666', 'other-54');
-- on the air (the checklist is the subject of commerce-store.check.sql; here the status is set directly)
set session_replication_role = replica;
update public.stores set status = 'published', published_at = now() where id = '00000000-0000-0000-0000-000000545001';
set session_replication_role = origin;
-- a customer the business already knows (the same phone in another format)
insert into public.leads (id, user_id, business_id, name, phone, source, status) values
  ('00000000-0000-0000-0000-000000546001', '00000000-0000-0000-0000-0000000540a1', '00000000-0000-0000-0000-00000054b001', 'רינה ותיקה', '+972 52-777-8888', 'ידני', 'נסגר');

-- ---- 1. what a product by a quote may be ---------------------------------------------------------------------------------------
select pg_temp.refused($$update public.catalog_items set quote_currency = 'usd' where id = '00000000-0000-0000-0000-000000541002'$$, 'a currency is three capital letters');
select pg_temp.refused($$update public.catalog_items set quote_from = -1 where id = '00000000-0000-0000-0000-000000541002'$$, 'no price below zero');
select pg_temp.refused($$update public.catalog_items set quote_min_qty = 0 where id = '00000000-0000-0000-0000-000000541002'$$, 'a minimum is at least 1');
select pg_temp.refused($$insert into public.catalog_items (user_id, business_id, name, price, kind, quote_mode)
  values ('00000000-0000-0000-0000-0000000540a1', '00000000-0000-0000-0000-00000054b001', 'חבילה', 100, 'package', true)$$, 'a package is never sold by a quote');

-- the owner turns it on and off in the dashboard (the table's own policies — nothing new for the browser)
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000540a1');
update public.catalog_items set quote_min_qty = 500 where id = '00000000-0000-0000-0000-000000541002';
select pg_temp.check((select quote_min_qty from public.catalog_items where id = '00000000-0000-0000-0000-000000541002') = 500, 'the owner sets the minimum');
select pg_temp.check((select count(*) from public.catalog_items where id = '00000000-0000-0000-0000-000000541009') = 0, 'another business''s product stays unseen');
rollback;

-- ---- 2. what the site shows ---------------------------------------------------------------------------------------------------
begin;
set local role service_role;
select pg_temp.check(public.sf_product('00000000-0000-0000-0000-000000545001', 'bag-001')->'quote' = '{"from": 3.5, "currency": "USD", "min": null}'::jsonb,
  'a product by a quote carries its "from" price, currency and minimum');
select pg_temp.check(public.sf_product('00000000-0000-0000-0000-000000545001', 'bag-031')->'quote'->>'min' = '300', 'the minimum is shown');
select pg_temp.check(jsonb_typeof(public.sf_product('00000000-0000-0000-0000-000000545001', 'tote')->'quote') = 'null', 'a product sold as before has no quote');
select pg_temp.check(public.sf_product('00000000-0000-0000-0000-000000545001', 'secret') is null, 'a hidden product stays hidden');
select pg_temp.check((select count(*) from jsonb_array_elements(public.sf_products('00000000-0000-0000-0000-000000545001', '{}')->'items') c
                        where c->'quote' is not null and jsonb_typeof(c->'quote') = 'object') = 2, 'the cards of the list carry the quote');
select pg_temp.check((public.sf_products('00000000-0000-0000-0000-000000545001', '{}')->>'total')::int = 3, 'every product of the store is listed');
-- the price filter, the price range and the price order are the products sold as before only
select pg_temp.check((public.sf_products('00000000-0000-0000-0000-000000545001', '{"min_price": "0"}')->>'total')::int = 1, 'a price filter leaves out the quotes');
select pg_temp.check(public.sf_products('00000000-0000-0000-0000-000000545001', '{}')->'facets'->'price' = '{"min": 40, "max": 40}'::jsonb, 'the price range is of priced products');
select pg_temp.check(public.sf_products('00000000-0000-0000-0000-000000545001', '{"sort": "price_asc"}')->'items'->0->>'slug' = 'tote', 'by price (low first): priced first');
select pg_temp.check(public.sf_products('00000000-0000-0000-0000-000000545001', '{"sort": "price_desc"}')->'items'->0->>'slug' = 'tote', 'by price (high first): priced first');
-- no cart and no payment for a product by a quote
select pg_temp.check(public.sf_cart_set('00000000-0000-0000-0000-000000545001', repeat('a', 64), '00000000-0000-0000-0000-000000541002', null, 1, 'add')->>'error' = 'gone',
  'a product by a quote never goes into a cart');
select pg_temp.check((public.sf_cart_set('00000000-0000-0000-0000-000000545001', repeat('a', 64), '00000000-0000-0000-0000-000000541001', null, 1, 'add')->>'ok')::boolean,
  'a product sold as before still does');
rollback;

-- a product turned into a quote while in a cart: the line is "gone", the cart can not check out
begin;
set local role service_role;
select public.sf_cart_set('00000000-0000-0000-0000-000000545001', repeat('b', 64), '00000000-0000-0000-0000-000000541001', null, 1, 'add');
reset role;
update public.catalog_items set quote_mode = true where id = '00000000-0000-0000-0000-000000541001';
set local role service_role;
select pg_temp.check(public.sf_cart('00000000-0000-0000-0000-000000545001', repeat('b', 64))->'lines'->0->>'problem' = 'gone', 'the line of a quote is gone');
rollback;

-- ---- 3. a request from the site → the leads ----------------------------------------------------------------------------------
begin;
set local role service_role;
-- a new person asks for a quote: a new contact (source "אתר", status "חדש"), the model in its notes
select pg_temp.check((public.sf_lead_request('00000000-0000-0000-0000-000000545001', '00000000-0000-0000-0000-000000547001', 'quote',
  '00000000-0000-0000-0000-000000541002', '{"name": "דנה כהן", "phone": "050-123 4567", "email": "Dana@Example.com"}',
  '{"qty": "1000", "notes": "לוגו בזהב", "page": "/products/bag-001"}')->>'ok')::boolean, 'a quote request is recorded');
reset role;
select pg_temp.check((select count(*) from public.leads where business_id = '00000000-0000-0000-0000-00000054b001' and source = 'אתר') = 1, 'one new contact');
select pg_temp.check((select status = 'חדש' and phone = '0501234567' and email = 'dana@example.com' and external_source = 'site'
                             and tags @> '{פנייה מהאתר,הצעת מחיר}' and notes like '%דגם: bag-001 — שקית נייר עם ידית חבל – דגם 001%'
                             and notes like '%כמות משוערת: 1000%' and notes like '%הערות: לוגו בזהב%' and department_id is null
                        from public.leads where external_id = '00000000-0000-0000-0000-000000547001'), 'the contact has the request and no department yet');
select pg_temp.check((select new_contact and qty = 1000 and model = 'bag-001' and routed_at is null and not preview
                        from public.site_requests where id = '00000000-0000-0000-0000-000000547001'), 'the request waits for the dashboard to route it');
set local role service_role;
-- the same request again (a retry): one request, one contact
select pg_temp.check((public.sf_lead_request('00000000-0000-0000-0000-000000545001', '00000000-0000-0000-0000-000000547001', 'quote',
  '00000000-0000-0000-0000-000000541002', '{"name": "דנה כהן", "phone": "0501234567"}', '{}')->>'already')::boolean, 'a retry is the same request');
-- a person the business knows (the same phone, written differently): a note on their card, nothing of theirs changes
select pg_temp.check((public.sf_lead_request('00000000-0000-0000-0000-000000545001', '00000000-0000-0000-0000-000000547002', 'contact', null,
  '{"name": "רינה", "phone": "052-7778888"}', '{"topic": "סורסינג", "model": "bag-032", "notes": "מוצר חדש"}')->>'ok')::boolean, 'a contact request is recorded');
reset role;
select pg_temp.check((select count(*) from public.leads where business_id = '00000000-0000-0000-0000-00000054b001') = 2, 'no second contact for a known phone');
select pg_temp.check((select name = 'רינה ותיקה' and status = 'נסגר' from public.leads where id = '00000000-0000-0000-0000-000000546001'), 'the known contact keeps its values');
select pg_temp.check((select count(*) from public.lead_activities where lead_id = '00000000-0000-0000-0000-000000546001'
                        and body like 'פנייה מהאתר%' and body like '%נושא: סורסינג%' and body like '%דגם: bag-032%') = 1, 'the request is a note on their card');
select pg_temp.check((select lead_id = '00000000-0000-0000-0000-000000546001' and not new_contact from public.site_requests
                        where id = '00000000-0000-0000-0000-000000547002'), 'the request points at the known contact');
set local role service_role;
-- what is refused, and why
select pg_temp.check(public.sf_lead_request('00000000-0000-0000-0000-000000545001', '00000000-0000-0000-0000-000000547003', 'quote',
  '00000000-0000-0000-0000-000000541002', '{"name": "א", "phone": "123"}', '{"qty": "0"}')->'fields' = '["name", "phone", "qty"]'::jsonb,
  'the details are checked: name, phone, quantity');
select pg_temp.check(public.sf_lead_request('00000000-0000-0000-0000-000000545001', '00000000-0000-0000-0000-000000547004', 'quote',
  '00000000-0000-0000-0000-000000541001', '{"name": "דנה", "phone": "0501234567"}', '{}')->>'error' = 'item', 'only a product sold by a quote');
select pg_temp.check(public.sf_lead_request('00000000-0000-0000-0000-000000545001', '00000000-0000-0000-0000-000000547005', 'quote',
  '00000000-0000-0000-0000-000000541009', '{"name": "דנה", "phone": "0501234567"}', '{}')->>'error' = 'item', 'never another business''s product');
select pg_temp.check(public.sf_lead_request('00000000-0000-0000-0000-000000545001', '00000000-0000-0000-0000-000000547006', 'quote',
  '00000000-0000-0000-0000-000000541004', '{"name": "דנה", "phone": "0501234567"}', '{}')->>'error' = 'item', 'never a hidden product');
select pg_temp.check(public.sf_lead_request('00000000-0000-0000-0000-000000545001', '00000000-0000-0000-0000-000000547007', 'order',
  null, '{"name": "דנה", "phone": "0501234567"}', '{}')->>'error' = 'bad_request', 'only a quote or a contact request');
select pg_temp.check(public.sf_lead_request('00000000-0000-0000-0000-000000545002', '00000000-0000-0000-0000-000000547008', 'contact',
  null, '{"name": "דנה", "phone": "0501234567"}', '{}')->>'error' = 'store', 'a store not on the air takes no request');
select pg_temp.check(public.sf_lead_request('00000000-0000-0000-0000-000000545001', '00000000-0000-0000-0000-000000547001', 'contact',
  null, '{"name": "דנה", "phone": "0501234567"}', '{}')->>'already' = 'true', 'a request id is never reused for something else');
rollback;

-- the owner's preview of a store not yet on the air: recorded, and marked a test
begin;
set local role service_role;
select pg_temp.check((public.sf_lead_request('00000000-0000-0000-0000-000000545002', '00000000-0000-0000-0000-000000547010', 'contact',
  null, '{"name": "בודק", "phone": "+972501112222"}', '{}', true)->>'ok')::boolean, 'a preview request is recorded');
reset role;
select pg_temp.check((select preview from public.site_requests where id = '00000000-0000-0000-0000-000000547010'), 'marked as the preview''s');
select pg_temp.check((select tags @> '{בדיקה}' and notes like '%התצוגה המקדימה%' and phone = '0501112222' from public.leads
                        where external_id = '00000000-0000-0000-0000-000000547010'), 'the contact says it was a test');
rollback;

-- many requests of the same phone within minutes: the sixth is refused
begin;
set local role service_role;
select public.sf_lead_request('00000000-0000-0000-0000-000000545001', ('00000000-0000-0000-0000-0000005480' || lpad(n::text, 2, '0'))::uuid, 'contact',
  null, '{"name": "חוזר", "phone": "0509990000"}', '{}') from generate_series(1, 5) n;
select pg_temp.check(public.sf_lead_request('00000000-0000-0000-0000-000000545001', '00000000-0000-0000-0000-000000548099', 'contact',
  null, '{"name": "חוזר", "phone": "0509990000"}', '{}')->>'error' = 'too_many', 'the sixth within ten minutes is refused');
rollback;

-- ---- 4. the browser never reaches the requests ----------------------------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000540a1');
select pg_temp.refused($$select * from public.site_requests$$, 'the requests are the server''s only');
select pg_temp.refused($$select public.sf_lead_request('00000000-0000-0000-0000-000000545001', gen_random_uuid(), 'contact', null, '{"name": "x", "phone": "0501234567"}', '{}')$$,
  'the browser can not send a request through the database');
rollback;
begin;
set local role anon;
select pg_temp.refused($$select public.sf_lead_request('00000000-0000-0000-0000-000000545001', gen_random_uuid(), 'contact', null, '{"name": "x", "phone": "0501234567"}', '{}')$$,
  'nor can anyone without a login');
rollback;

-- ---- 5. the department of the site's requests is of the same business ---------------------------------------------------------
begin;
set local role service_role;
insert into public.lead_staff (id, business_id, name, phone) values
  ('00000000-0000-0000-0000-000000549001', '00000000-0000-0000-0000-00000054b001', 'גל', '972501234500'),
  ('00000000-0000-0000-0000-000000549002', '00000000-0000-0000-0000-00000054b002', 'פז', '972501234501');
insert into public.lead_departments (id, business_id, name, staff_id) values
  ('00000000-0000-0000-0000-000000549101', '00000000-0000-0000-0000-00000054b001', 'אריזות וסורסינג', '00000000-0000-0000-0000-000000549001'),
  ('00000000-0000-0000-0000-000000549102', '00000000-0000-0000-0000-00000054b002', 'אחר', '00000000-0000-0000-0000-000000549002');
insert into public.lead_routing (business_id, site_department_id) values ('00000000-0000-0000-0000-00000054b001', '00000000-0000-0000-0000-000000549101');
select pg_temp.check((select site_department_id = '00000000-0000-0000-0000-000000549101' from public.lead_routing
                        where business_id = '00000000-0000-0000-0000-00000054b001'), 'the site''s requests go to a department of the business');
select pg_temp.refused($$update public.lead_routing set site_department_id = '00000000-0000-0000-0000-000000549102'
                         where business_id = '00000000-0000-0000-0000-00000054b001'$$, 'never to another business''s department');
rollback;
