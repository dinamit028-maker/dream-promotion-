-- Dream Commerce stage 2 (2.55.0, migration 3400) on a real Postgres (tests/sql/run.sh): the store and its storefront.
-- The storefront's server is service_role and reads only through sf_*; the dashboard's users are authenticated + a JWT subject.
-- The superuser only builds the world. Fixtures only:
--   Bags (company, VAT)  owner O, cashier K, viewer V        Shoes  owner P — another business, another store, the same slugs
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
-- the slugs of a list (in order)
create or replace function pg_temp.slugs(j jsonb) returns text language sql as $$
  select coalesce(string_agg(e->>'slug', ',' order by o), '') from jsonb_array_elements(coalesce(j, '[]'::jsonb)) with ordinality as x(e, o)
$$;

-- ---- the world --------------------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000340a1', 'owner@bags.test'), ('00000000-0000-0000-0000-0000000340c1', 'cashier@bags.test'),
  ('00000000-0000-0000-0000-0000000340f1', 'viewer@bags.test'), ('00000000-0000-0000-0000-0000000340a2', 'owner@shoes.test');
insert into public.businesses (id, name, slug) values
  ('00000000-0000-0000-0000-00000034b001', 'Bags', 'bags-cs'), ('00000000-0000-0000-0000-00000034b002', 'Shoes', 'shoes-cs');
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-00000034b001', '00000000-0000-0000-0000-0000000340a1', 'owner', 'full'),
  ('00000000-0000-0000-0000-00000034b001', '00000000-0000-0000-0000-0000000340c1', 'editor', 'register'),
  ('00000000-0000-0000-0000-00000034b001', '00000000-0000-0000-0000-0000000340f1', 'viewer', 'full'),
  ('00000000-0000-0000-0000-00000034b002', '00000000-0000-0000-0000-0000000340a2', 'owner', 'full');
insert into public.register_settings (user_id, business_id, business_type, vat_rate, dealer_number, company_number, legal_name, street, house_no, city, entity_type) values
  ('00000000-0000-0000-0000-0000000340a1', '00000000-0000-0000-0000-00000034b001', 'licensed', 18, '', '514000004', 'שקיות בע"מ', 'הרצל', '1', 'תל אביב', 'company');
insert into public.catalog_items (id, user_id, business_id, name, price, kind, track_stock, stock_qty, low_stock, slug, publish_online,
                                  description, tags, online_price, compare_at_price, sku, active, custom_fields) values
  ('00000000-0000-0000-0000-000000341001', '00000000-0000-0000-0000-0000000340a1', '00000000-0000-0000-0000-00000034b001', 'שקית בד', 20, 'product', true, 0, 0,
   'tote-bag', true, 'שקית בד חזקה', '{בד,אקולוגי}', null, null, 'TOTE', true, '{"material": "כותנה", "cost_note": "סוד-מסחרי"}'),
  ('00000000-0000-0000-0000-000000341002', '00000000-0000-0000-0000-0000000340a1', '00000000-0000-0000-0000-00000034b001', 'שקית נייר', 3.5, 'product', true, 0, 0,
   'paper-bag', true, 'שקית נייר חומה', '{נייר}', 3, 4, '', true, '{}'),
  ('00000000-0000-0000-0000-000000341003', '00000000-0000-0000-0000-0000000340a1', '00000000-0000-0000-0000-00000034b001', 'שקית סודית', 9, 'product', false, 0, 0,
   'secret-bag', false, '', '{בד}', null, null, '', true, '{}'),
  ('00000000-0000-0000-0000-000000341004', '00000000-0000-0000-0000-0000000340a1', '00000000-0000-0000-0000-00000034b001', 'שקית בלי כתובת', 5, 'product', false, 0, 0,
   null, true, '', '{}', null, null, '', true, '{}'),
  ('00000000-0000-0000-0000-000000341005', '00000000-0000-0000-0000-0000000340a1', '00000000-0000-0000-0000-00000034b001', 'שקית ישנה', 5, 'product', false, 0, 0,
   'old-bag', true, '', '{}', null, null, '', false, '{}'),
  ('00000000-0000-0000-0000-000000342001', '00000000-0000-0000-0000-0000000340a2', '00000000-0000-0000-0000-00000034b002', 'מגף', 300, 'product', false, 0, 0,
   'tote-bag', true, 'מגף עור', '{עור}', null, null, '', true, '{}');
-- a hidden product is in the collection by hand, and in a search by its tag: neither may show it
insert into public.catalog_options (item_id, position, name, choices) values
  ('00000000-0000-0000-0000-000000341001', 1, 'מידה', '{S,M}'), ('00000000-0000-0000-0000-000000341001', 2, 'צבע', '{שחור,לבן}');
insert into public.catalog_variants (id, item_id, option1, option2, price, online_price, stock_qty, active, position, sku) values
  ('00000000-0000-0000-0000-000000343001', '00000000-0000-0000-0000-000000341001', 'S', 'שחור', null, null, 5, true, 1, 'TOTE-S-B'),
  ('00000000-0000-0000-0000-000000343002', '00000000-0000-0000-0000-000000341001', 'S', 'לבן',  null, null, 0, true, 2, ''),
  ('00000000-0000-0000-0000-000000343003', '00000000-0000-0000-0000-000000341001', 'M', 'שחור', 25,   24,   2, true, 3, ''),
  ('00000000-0000-0000-0000-000000343004', '00000000-0000-0000-0000-000000341001', 'M', 'לבן',  null, null, 1, false, 4, '');
update public.catalog_items set stock_qty = 8 where id = '00000000-0000-0000-0000-000000341001';
insert into public.catalog_media (id, item_id, path, url, sizes, alt, position) values
  ('00000000-0000-0000-0000-000000344001', '00000000-0000-0000-0000-000000341001', 'b/t/1', 'https://cdn.test/t1-800.webp',
   '{"400": "https://cdn.test/t1-400.webp", "800": "https://cdn.test/t1-800.webp"}', 'שקית בד שחורה', 0),
  ('00000000-0000-0000-0000-000000344002', '00000000-0000-0000-0000-000000341001', 'b/t/2', 'https://cdn.test/t2-800.webp', '{}', 'מהצד', 1);
insert into public.catalog_field_defs (user_id, business_id, field_key, label, kind, show_online, position) values
  ('00000000-0000-0000-0000-0000000340a1', '00000000-0000-0000-0000-00000034b001', 'material', 'חומר', 'text', true, 1),
  ('00000000-0000-0000-0000-0000000340a1', '00000000-0000-0000-0000-00000034b001', 'cost_note', 'הערת עלות', 'text', false, 2);

-- ---- 1. the owner opens the store (the dashboard's role) ----------------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000340a1');
insert into public.stores (id, name, phone) values ('00000000-0000-0000-0000-000000345001', 'Bags', '03-5555555');
select pg_temp.check((select business_id from public.stores where id = '00000000-0000-0000-0000-000000345001') = '00000000-0000-0000-0000-00000034b001',
  'a new store belongs to the business the owner works in');
select pg_temp.check((select status from public.stores where id = '00000000-0000-0000-0000-000000345001') = 'draft', 'a store is born a draft');
select pg_temp.refused_with($$insert into public.stores (name) values ('another')$$, 'stores_business_uq', 'one store per business');
insert into public.store_domains (store_id, domain, is_primary) values
  ('00000000-0000-0000-0000-000000345001', 'bags.test', true), ('00000000-0000-0000-0000-000000345001', 'www.bags.test', false);
select pg_temp.check((select string_agg(status, ',' order by domain) from public.store_domains where store_id = '00000000-0000-0000-0000-000000345001') = 'pending,pending',
  'a new domain waits (pending)');
select pg_temp.refused($$update public.store_domains set status = 'active' where domain = 'bags.test'$$, 'a screen never marks a domain active');
select pg_temp.refused($$insert into public.store_domains (store_id, domain, status) values ('00000000-0000-0000-0000-000000345001', 'x.bags.test', 'active')$$,
  'a screen never adds an active domain');
select pg_temp.refused($$insert into public.store_domains (store_id, domain) values ('00000000-0000-0000-0000-000000345001', 'Bad Domain.test')$$, 'a domain is lower case, without spaces');
select pg_temp.refused($$insert into public.store_domains (store_id, domain) values ('00000000-0000-0000-0000-000000345001', 'https://bags.test')$$, 'a domain is a name, not an address');
select pg_temp.refused_with($$insert into public.store_domains (store_id, domain, is_primary) values ('00000000-0000-0000-0000-000000345001', 'b2.test', true)$$,
  'store_domains_primary_uq', 'one primary domain per store');

-- pages, a menu, collections (by the owner)
insert into public.store_pages (store_id, kind, policy, slug, title, body, published) values
  ('00000000-0000-0000-0000-000000345001', 'policy', 'returns', 'returns', 'ביטולים והחזרות', 'ביטול תוך 14 יום', true),
  ('00000000-0000-0000-0000-000000345001', 'policy', 'privacy', 'privacy', 'פרטיות', 'מה נאסף', true),
  ('00000000-0000-0000-0000-000000345001', 'page', null, 'about', 'עלינו', 'שקיות ממותגות', true),
  ('00000000-0000-0000-0000-000000345001', 'page', null, 'secret', 'טיוטה', 'עוד לא', false);
select pg_temp.refused($$insert into public.store_pages (store_id, kind, policy, slug, title) values ('00000000-0000-0000-0000-000000345001', 'page', 'returns', 'r2', 'x')$$,
  'a content page has no policy kind');
select pg_temp.refused($$insert into public.store_pages (store_id, kind, slug, title) values ('00000000-0000-0000-0000-000000345001', 'page', 'Bad Slug', 'x')$$, 'a page slug is a slug');
insert into public.store_menus (store_id, kind, items) values
  ('00000000-0000-0000-0000-000000345001', 'main', '[{"label": "כל השקיות", "href": "/collections/all"}, {"label": "אינסטגרם", "href": "https://instagram.com/bags"}]');
select pg_temp.refused($$update public.store_menus set items = '[{"label": "x", "href": "javascript:alert(1)"}]' where kind = 'main'$$, 'a menu link is never javascript:');
select pg_temp.refused($$update public.store_menus set items = '[{"label": "x", "href": "//evil.test/a"}]' where kind = 'main'$$, 'a menu link never leaves by //');
select pg_temp.refused($$update public.store_menus set items = '[{"label": "x", "href": "http://plain.test"}]' where kind = 'main'$$, 'an outside link is https');
select pg_temp.refused($$update public.store_menus set items = '[{"label": "", "href": "/"}]' where kind = 'main'$$, 'a link has a label');
insert into public.catalog_collections (id, title, slug, kind, rules, sort, publish_online, position) values
  ('00000000-0000-0000-0000-000000347001', 'שקיות אקולוגיות', 'eco', 'manual', '{}', 'manual', true, 1),
  ('00000000-0000-0000-0000-000000347002', 'שקיות נייר', 'paper', 'auto', '{"tags": ["נייר"]}', 'price_asc', true, 2),
  ('00000000-0000-0000-0000-000000347003', 'בקרוב', 'soon', 'manual', '{}', 'manual', false, 3);
select pg_temp.refused($$insert into public.catalog_collections (title, slug) values ('הכל', 'all')$$, '"all" is the address of every product');
insert into public.catalog_collection_items (collection_id, item_id, position) values
  ('00000000-0000-0000-0000-000000347001', '00000000-0000-0000-0000-000000341001', 1),
  ('00000000-0000-0000-0000-000000347001', '00000000-0000-0000-0000-000000341003', 2);
select pg_temp.check((select count(*) from public.catalog_collection_items where business_id = '00000000-0000-0000-0000-00000034b001') = 2,
  'a product in a collection takes the collection''s business');
select pg_temp.refused_with($$insert into public.catalog_collection_items (collection_id, item_id) values ('00000000-0000-0000-0000-000000347001', '00000000-0000-0000-0000-000000342001')$$,
  'not of this business', 'another business''s product never joins a collection');

-- the theme: a draft, published; a second draft
insert into public.store_theme_versions (id, store_id, template, settings) values
  ('00000000-0000-0000-0000-000000346001', '00000000-0000-0000-0000-000000345001', 'bags', '{"hero": {"title": "A"}}');
select pg_temp.refused_with($$insert into public.store_theme_versions (store_id, template) values ('00000000-0000-0000-0000-000000345001', 'bags')$$,
  'store_theme_versions_draft_uq', 'one draft at a time');
select public.store_publish_theme('00000000-0000-0000-0000-000000346001');
select pg_temp.check((select status || ':' || version from public.store_theme_versions where id = '00000000-0000-0000-0000-000000346001') = 'published:1',
  'the draft is published, version 1');
select pg_temp.refused_with($$update public.store_theme_versions set settings = '{"hero": {"title": "X"}}' where id = '00000000-0000-0000-0000-000000346001'$$,
  'only the draft is edited', 'a published version never changes');
select pg_temp.refused_with($$delete from public.store_theme_versions where id = '00000000-0000-0000-0000-000000346001'$$, 'not deleted', 'the published version is kept');
insert into public.store_theme_versions (id, store_id, template, settings) values
  ('00000000-0000-0000-0000-000000346002', '00000000-0000-0000-0000-000000345001', 'bags', '{"hero": {"title": "B"}}');
select pg_temp.check((select version from public.store_theme_versions where id = '00000000-0000-0000-0000-000000346002') = 2, 'versions are numbered');
update public.store_theme_versions set settings = '{"hero": {"title": "B2"}}' where id = '00000000-0000-0000-0000-000000346002';
select pg_temp.refused_with($$update public.store_theme_versions set status = 'draft' where id = '00000000-0000-0000-0000-000000346001'$$, '', 'a version never goes back to draft');

-- the checklist: not yet
select pg_temp.check((select (public.store_checklist('00000000-0000-0000-0000-000000345001'))->'missing') = '["accessibility", "domain"]'::jsonb,
  'the checklist names what is missing: ' || (public.store_checklist('00000000-0000-0000-0000-000000345001'))::text);
select pg_temp.refused_with($$update public.stores set status = 'published' where id = '00000000-0000-0000-0000-000000345001'$$,
  'store_not_ready: accessibility,domain', 'a store without its checklist does not go on the air');
insert into public.store_pages (store_id, kind, policy, slug, title, body, published) values
  ('00000000-0000-0000-0000-000000345001', 'policy', 'accessibility', 'accessibility', 'הצהרת נגישות', 'פרטי קשר לנגישות', true);
commit;

-- ---- 2. another business, the cashier and the viewer ----------------------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000340a2');
select pg_temp.check((select count(*) from public.stores) = 0, 'another business does not see the store');
select pg_temp.check((select count(*) from public.store_domains) = 0 and (select count(*) from public.store_pages) = 0
  and (select count(*) from public.catalog_collections) = 0 and (select count(*) from public.store_theme_versions) = 0, 'nor its domains, pages, collections, theme');
select pg_temp.refused_with($$insert into public.store_domains (store_id, domain) values ('00000000-0000-0000-0000-000000345001', 'steal.test')$$,
  'store not found', 'nothing is added to another business''s store');
select pg_temp.refused($$select public.store_checklist('00000000-0000-0000-0000-000000345001')$$, 'nor its checklist read');
select pg_temp.check(pg_temp.affected($$update public.stores set name = 'stolen' where id = '00000000-0000-0000-0000-000000345001'$$) = 0, 'nor its store changed');
select pg_temp.refused_with($$insert into public.stores (name, status) values ('Shoes', 'published')$$, 'store_not_ready', 'a store is not born on the air');
insert into public.stores (id, name) values ('00000000-0000-0000-0000-000000345002', 'Shoes');
select pg_temp.refused_with($$insert into public.store_domains (store_id, domain, is_primary) values ('00000000-0000-0000-0000-000000345002', 'bags.test', true)$$,
  'store_domains_domain_uq', 'a domain is one store''s in the whole system');
insert into public.store_domains (store_id, domain, is_primary) values ('00000000-0000-0000-0000-000000345002', 'shoes.test', true);
insert into public.catalog_collections (id, title, slug, publish_online) values ('00000000-0000-0000-0000-000000347101', 'אקולוגי', 'eco', true);
insert into public.catalog_collection_items (collection_id, item_id) values ('00000000-0000-0000-0000-000000347101', '00000000-0000-0000-0000-000000342001');
commit;

begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000340c1');
select pg_temp.check((select count(*) from public.stores) = 0 and (select count(*) from public.catalog_collections) = 0
  and (select count(*) from public.store_pages) = 0, 'a cashier has nothing to do with the store');
select pg_temp.refused($$insert into public.catalog_collections (title, slug) values ('x', 'x-k')$$, 'a cashier adds no collection');
select pg_temp.refused($$select public.store_checklist('00000000-0000-0000-0000-000000345001')$$, 'a cashier reads no checklist');
commit;

begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000340f1');
select pg_temp.check((select count(*) from public.stores) = 1 and (select count(*) from public.store_pages) = 5, 'a viewer reads the store');
select pg_temp.check(pg_temp.affected($$update public.stores set name = 'v' where id = '00000000-0000-0000-0000-000000345001'$$) = 0, 'a viewer changes nothing');
select pg_temp.refused($$insert into public.store_pages (store_id, slug, title) values ('00000000-0000-0000-0000-000000345001', 'v', 'v')$$, 'a viewer adds no page');
select pg_temp.refused_with($$select public.store_publish_theme('00000000-0000-0000-0000-000000346002')$$, 'not allowed', 'a viewer publishes no theme');
select pg_temp.check((select status from public.store_theme_versions where id = '00000000-0000-0000-0000-000000346001') = 'published', '…and it stays as it was');
commit;

-- ---- 3. the storefront's door: sf_* is the server's only ------------------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000340a1');
select pg_temp.refused_with($$select public.sf_store('00000000-0000-0000-0000-000000345001', true)$$, 'permission denied', 'a signed-in user never calls sf_*');
select pg_temp.refused_with($$select public.sf_products('00000000-0000-0000-0000-000000345001', '{}', true)$$, 'permission denied', 'not sf_products either');
select pg_temp.refused_with($$select public.sf_domain_seen('bags.test')$$, 'permission denied', 'nor marks a domain seen');
commit;
begin;
set local role anon;
select pg_temp.refused_with($$select public.sf_resolve_host('bags.test')$$, 'permission denied', 'the public never calls sf_*');
select pg_temp.refused($$select count(*) from public.stores$$, 'nor reads the stores');
commit;

begin;
set local role service_role;
-- the host
select pg_temp.check((public.sf_resolve_host('bags.test'))->>'store' = '00000000-0000-0000-0000-000000345001'
  and ((public.sf_resolve_host('bags.test'))->>'primary')::boolean, 'a host finds its store');
select pg_temp.check((public.sf_resolve_host(' WWW.Bags.Test '))->>'primary_domain' = 'bags.test'
  and not ((public.sf_resolve_host('WWW.BAGS.TEST'))->>'primary')::boolean, 'www finds the store and its primary domain (normalised)');
select pg_temp.check(public.sf_resolve_host('nope.test') is null and public.sf_resolve_host('') is null and public.sf_resolve_host(null) is null,
  'an unknown host finds nothing');
-- a draft store: its name only, nothing else — unless previewed
select pg_temp.check((select array_agg(k order by k collate "C") from jsonb_object_keys(public.sf_store('00000000-0000-0000-0000-000000345001')) k)
  = '{id,lang,logo_url,name,primary_domain,status}', 'a draft store shows only its name ("בקרוב")');
select pg_temp.check(public.sf_products('00000000-0000-0000-0000-000000345001') is null and public.sf_product('00000000-0000-0000-0000-000000345001', 'tote-bag') is null
  and public.sf_page('00000000-0000-0000-0000-000000345001', 'page', 'about') is null and public.sf_collections('00000000-0000-0000-0000-000000345001') is null
  and public.sf_sitemap('00000000-0000-0000-0000-000000345001') is null, 'a draft store shows no product, page, collection or sitemap');
select pg_temp.check((public.sf_store('00000000-0000-0000-0000-000000345001', true))#>>'{theme,settings,hero,title}' = 'B2'
  and (public.sf_store('00000000-0000-0000-0000-000000345001', true))#>>'{theme,version}' = '2', 'a preview shows the draft theme');
select pg_temp.check(pg_temp.slugs((public.sf_products('00000000-0000-0000-0000-000000345001', '{}', true))->'items') <> '', 'a preview shows the products');
-- the domain becomes active only when the storefront served it
select public.sf_domain_seen('BAGS.test');
select pg_temp.check((select status from public.store_domains where domain = 'bags.test') = 'active'
  and (select last_seen_at from public.store_domains where domain = 'bags.test') is not null, 'the storefront served it: active');
select pg_temp.check((select status from public.store_domains where domain = 'www.bags.test') = 'pending', 'only that domain');
commit;

-- ---- 4. on the air ------------------------------------------------------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000340a1');
select pg_temp.check((public.store_checklist('00000000-0000-0000-0000-000000345001'))->>'ready' = 'true', 'the checklist is complete');
update public.stores set status = 'published' where id = '00000000-0000-0000-0000-000000345001';
select pg_temp.check((select published_at from public.stores where id = '00000000-0000-0000-0000-000000345001') is not null, 'published, stamped');
commit;

begin;
set local role service_role;
select pg_temp.check((public.sf_store('00000000-0000-0000-0000-000000345001'))#>>'{theme,settings,hero,title}' = 'A', 'the public sees the published theme, not the draft');
select pg_temp.check((public.sf_store('00000000-0000-0000-0000-000000345001'))#>>'{legal,name}' = 'שקיות בע"מ'
  and (public.sf_store('00000000-0000-0000-0000-000000345001'))#>>'{legal,number}' = '514000004'
  and (public.sf_store('00000000-0000-0000-0000-000000345001'))#>>'{legal,number_kind}' = 'company'
  and (public.sf_store('00000000-0000-0000-0000-000000345001'))#>>'{legal,address}' = 'הרצל 1, תל אביב', 'the business''s legal details for the footer');
select pg_temp.check((select array_agg(k order by k collate "C") from jsonb_object_keys(public.sf_store('00000000-0000-0000-0000-000000345001')) k)
  = '{collections,contact,country,currency,description,ga4_id,gsc_code,id,lang,legal,logo_url,menus,name,policies,primary_domain,show_stock_count,status,template,theme}',
  'sf_store returns its allow-list only');
select pg_temp.check(pg_temp.slugs((public.sf_store('00000000-0000-0000-0000-000000345001'))->'collections') = 'eco,paper', 'only the published collections');
select pg_temp.check((select string_agg(e->>'policy', ',') from jsonb_array_elements((public.sf_store('00000000-0000-0000-0000-000000345001'))->'policies') e)
  = 'accessibility,privacy,returns', 'the published policies');

-- the products: never another business's, never one that is hidden, inactive or without an address
select pg_temp.check(pg_temp.slugs((public.sf_products('00000000-0000-0000-0000-000000345001'))->'items') = 'tote-bag,paper-bag'
  or pg_temp.slugs((public.sf_products('00000000-0000-0000-0000-000000345001'))->'items') = 'paper-bag,tote-bag', 'only the published products of this store: '
  || pg_temp.slugs((public.sf_products('00000000-0000-0000-0000-000000345001'))->'items'));
select pg_temp.check((public.sf_products('00000000-0000-0000-0000-000000345001'))->>'total' = '2', 'two of them');
select pg_temp.check((public.sf_product('00000000-0000-0000-0000-000000345001', 'tote-bag'))->>'name' = 'שקית בד'
  and (public.sf_product('00000000-0000-0000-0000-000000345002', 'tote-bag')) is null, 'the same address in another store is never this product (Shoes is a draft)');
select pg_temp.check(public.sf_product('00000000-0000-0000-0000-000000345001', 'secret-bag') is null and public.sf_product('00000000-0000-0000-0000-000000345001', 'old-bag') is null,
  'a hidden or an inactive product is 404');
select pg_temp.check((public.sf_product('00000000-0000-0000-0000-000000345002', 'tote-bag', true))->>'name' = 'מגף', 'Shoes''s own product, by the same address, in its own (previewed) store');

-- prices and stock, by the rule of catalog.ts
select pg_temp.check((public.sf_product('00000000-0000-0000-0000-000000345001', 'tote-bag'))->>'price' = '20'
  and (public.sf_product('00000000-0000-0000-0000-000000345001', 'tote-bag'))->>'price_max' = '24', 'from 20 (the item''s price) to 24 (a variant''s online price)');
select pg_temp.check((select string_agg((e->>'price') || ':' || (e->>'in_stock'), ',' order by e->>'id') from jsonb_array_elements((public.sf_product('00000000-0000-0000-0000-000000345001', 'tote-bag'))->'variants') e)
  = '20:true,20:false,24:true', 'each active variant: its price and whether it is in stock (the inactive one is not shown)');
select pg_temp.check((public.sf_product('00000000-0000-0000-0000-000000345001', 'paper-bag'))->>'price' = '3'
  and (public.sf_product('00000000-0000-0000-0000-000000345001', 'paper-bag'))->>'compare_at' = '4'
  and (public.sf_product('00000000-0000-0000-0000-000000345001', 'paper-bag'))->>'in_stock' = 'false', 'the online price, the price before the discount, out of stock');
select pg_temp.check((public.sf_product('00000000-0000-0000-0000-000000345001', 'tote-bag'))->'stock' = 'null'::jsonb
  and not exists (select 1 from jsonb_array_elements((public.sf_product('00000000-0000-0000-0000-000000345001', 'tote-bag'))->'variants') e where e->'stock' <> 'null'::jsonb),
  'no count is shown unless the store chose "נשארו X"');
-- the options in their order, the fields shown on the site only, the pictures, the collection, the related
select pg_temp.check((public.sf_product('00000000-0000-0000-0000-000000345001', 'tote-bag'))->'options'
  = '[{"name": "מידה", "values": ["S", "M"], "position": 1}, {"name": "צבע", "values": ["שחור", "לבן"], "position": 2}]'::jsonb, 'the options, in their order');
select pg_temp.check((public.sf_product('00000000-0000-0000-0000-000000345001', 'tote-bag'))->'fields' = '[{"kind": "text", "label": "חומר", "value": "כותנה"}]'::jsonb,
  'only the fields that are shown on the site');
select pg_temp.check(position('סוד-מסחרי' in (public.sf_product('00000000-0000-0000-0000-000000345001', 'tote-bag'))::text) = 0, 'a hidden field''s value never leaves');
select pg_temp.check((select array_agg(k order by k collate "C") from jsonb_object_keys(public.sf_product('00000000-0000-0000-0000-000000345001', 'tote-bag')) k)
  = '{barcode,collection,compare_at,country_of_origin,description,fields,id,images,in_stock,kind,manufacturer,name,options,price,price_max,related,seo_description,seo_title,sku,slug,stock,tags,updated_at,variants}',
  'sf_product returns its allow-list only');
select pg_temp.check((select array_agg(k order by k collate "C") from jsonb_object_keys((public.sf_products('00000000-0000-0000-0000-000000345001'))->'items'->0) k)
  = '{compare_at,image,in_stock,name,price,price_max,slug,stock}', 'a card returns its allow-list only');
select pg_temp.check((public.sf_product('00000000-0000-0000-0000-000000345001', 'tote-bag'))#>>'{images,0,url}' = 'https://cdn.test/t1-800.webp'
  and jsonb_array_length((public.sf_product('00000000-0000-0000-0000-000000345001', 'tote-bag'))->'images') = 2, 'the pictures, the first one first');
select pg_temp.check((public.sf_product('00000000-0000-0000-0000-000000345001', 'tote-bag'))#>>'{collection,slug}' = 'eco', 'its collection (breadcrumbs)');
select pg_temp.check((public.sf_product('00000000-0000-0000-0000-000000345001', 'paper-bag'))#>>'{collection,slug}' = 'paper', 'an automatic collection by tag');

-- collections, search, filters, sort, pages
select pg_temp.check(pg_temp.slugs((public.sf_products('00000000-0000-0000-0000-000000345001', '{"collection": "eco"}'))->'items') = 'tote-bag',
  'a collection by hand: the hidden product in it is not shown');
select pg_temp.check(pg_temp.slugs((public.sf_products('00000000-0000-0000-0000-000000345001', '{"collection": "paper"}'))->'items') = 'paper-bag', 'an automatic collection');
select pg_temp.check(public.sf_products('00000000-0000-0000-0000-000000345001', '{"collection": "soon"}') is null
  and public.sf_products('00000000-0000-0000-0000-000000345001', '{"collection": "nope"}') is null, 'an unpublished or unknown collection is 404');
select pg_temp.check((public.sf_products('00000000-0000-0000-0000-000000345001', '{"collection": "eco"}'))#>>'{collection,title}' = 'שקיות אקולוגיות', 'the collection''s own details');
select pg_temp.check(pg_temp.slugs((public.sf_products('00000000-0000-0000-0000-000000345001', '{"q": "נייר"}'))->'items') = 'paper-bag'
  and pg_temp.slugs((public.sf_products('00000000-0000-0000-0000-000000345001', '{"q": "אקולוגי"}'))->'items') = 'tote-bag'
  and pg_temp.slugs((public.sf_products('00000000-0000-0000-0000-000000345001', '{"q": "סודית"}'))->'items') = ''
  and pg_temp.slugs((public.sf_products('00000000-0000-0000-0000-000000345001', '{"q": "tote"}'))->'items') = 'tote-bag', 'search: name, tag, SKU — never a hidden product');
select pg_temp.check(pg_temp.slugs((public.sf_products('00000000-0000-0000-0000-000000345001', '{"options": {"מידה": ["M"]}}'))->'items') = 'tote-bag'
  and pg_temp.slugs((public.sf_products('00000000-0000-0000-0000-000000345001', '{"options": {"מידה": ["M"], "צבע": ["לבן"]}}'))->'items') = ''
  and pg_temp.slugs((public.sf_products('00000000-0000-0000-0000-000000345001', '{"options": {"צבע": ["לבן"]}}'))->'items') = 'tote-bag'
  and pg_temp.slugs((public.sf_products('00000000-0000-0000-0000-000000345001', '{"options": {"צבע": ["לבן"]}, "in_stock": "1"}'))->'items') = ''
  and pg_temp.slugs((public.sf_products('00000000-0000-0000-0000-000000345001', '{"options": {"חומר": ["x"]}}'))->'items') = '',
  'a size / a colour: one active variant must have them all (and be in stock, when asked)');
select pg_temp.check(pg_temp.slugs((public.sf_products('00000000-0000-0000-0000-000000345001', '{"in_stock": "1"}'))->'items') = 'tote-bag'
  and pg_temp.slugs((public.sf_products('00000000-0000-0000-0000-000000345001', '{"max_price": "10"}'))->'items') = 'paper-bag'
  and pg_temp.slugs((public.sf_products('00000000-0000-0000-0000-000000345001', '{"min_price": "10"}'))->'items') = 'tote-bag'
  and pg_temp.slugs((public.sf_products('00000000-0000-0000-0000-000000345001', '{"min_price": "junk", "limit": "x"}'))->'items') <> '', 'in stock, price; junk is ignored');
select pg_temp.check(pg_temp.slugs((public.sf_products('00000000-0000-0000-0000-000000345001', '{"sort": "price_asc"}'))->'items') = 'paper-bag,tote-bag'
  and pg_temp.slugs((public.sf_products('00000000-0000-0000-0000-000000345001', '{"sort": "price_desc"}'))->'items') = 'tote-bag,paper-bag'
  and pg_temp.slugs((public.sf_products('00000000-0000-0000-0000-000000345001', '{"sort": "price_asc", "limit": "1", "offset": "1"}'))->'items') = 'tote-bag'
  and (public.sf_products('00000000-0000-0000-0000-000000345001', '{"sort": "price_asc", "limit": "1", "offset": "1"}'))->>'total' = '2', 'sort and pages');
select pg_temp.check((public.sf_products('00000000-0000-0000-0000-000000345001'))#>'{facets,options}' = '{"מידה": ["S", "M"], "צבע": ["שחור", "לבן"]}'::jsonb
  and (public.sf_products('00000000-0000-0000-0000-000000345001'))#>>'{facets,price,min}' = '3'
  and (public.sf_products('00000000-0000-0000-0000-000000345001'))#>>'{facets,price,max}' = '24', 'the filters'' values, in their order, and the price range');
select pg_temp.check((select string_agg((e->>'slug') || ':' || (e->>'count'), ',') from jsonb_array_elements(public.sf_collections('00000000-0000-0000-0000-000000345001')) e)
  = 'eco:1,paper:1', 'collections and what they show');
select pg_temp.check((public.sf_collections('00000000-0000-0000-0000-000000345001'))#>>'{0,image_url}' = 'https://cdn.test/t1-800.webp', 'a collection without a picture shows its first product''s');
select pg_temp.check((public.sf_page('00000000-0000-0000-0000-000000345001', 'policy', 'returns'))->>'title' = 'ביטולים והחזרות'
  and (public.sf_page('00000000-0000-0000-0000-000000345001', 'page', 'about'))->>'title' = 'עלינו'
  and public.sf_page('00000000-0000-0000-0000-000000345001', 'page', 'secret') is null
  and public.sf_page('00000000-0000-0000-0000-000000345001', 'page', 'returns') is null, 'pages and policies: published ones, by their kind');
select pg_temp.check(pg_temp.slugs((public.sf_sitemap('00000000-0000-0000-0000-000000345001'))->'products') = 'paper-bag,tote-bag'
  and pg_temp.slugs((public.sf_sitemap('00000000-0000-0000-0000-000000345001'))->'collections') = 'eco,paper'
  and jsonb_array_length((public.sf_sitemap('00000000-0000-0000-0000-000000345001'))->'pages') = 4, 'the sitemap: every published address');

-- the store chose "נשארו X"
commit;
update public.stores set show_stock_count = true where id = '00000000-0000-0000-0000-000000345001';
begin;
set local role service_role;
select pg_temp.check((public.sf_product('00000000-0000-0000-0000-000000345001', 'tote-bag'))->>'stock' = '7'
  and (select string_agg(e->>'stock', ',' order by e->>'id') from jsonb_array_elements((public.sf_product('00000000-0000-0000-0000-000000345001', 'tote-bag'))->'variants') e) = '5,0,2',
  '"נשארו X": the counts of the active variants');
commit;

-- the item's online price covers its variants (catalog.ts: onlinePriceOf)
update public.catalog_items set online_price = 18 where id = '00000000-0000-0000-0000-000000341001';
begin;
set local role service_role;
select pg_temp.check((select string_agg(e->>'price', ',' order by e->>'id') from jsonb_array_elements((public.sf_product('00000000-0000-0000-0000-000000345001', 'tote-bag'))->'variants') e)
  = '18,18,24', 'the item''s online price covers its variants; a variant''s own online price first');
commit;

-- ---- 5. 301: an address that was on the site keeps working --------------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000340a1');
update public.catalog_items set slug = 'cotton-tote' where id = '00000000-0000-0000-0000-000000341001';
update public.catalog_items set slug = 'canvas-tote' where id = '00000000-0000-0000-0000-000000341001';
select pg_temp.check((select string_agg(from_path || '>' || to_path, ',' order by from_path) from public.store_redirects)
  = '/products/cotton-tote>/products/canvas-tote,/products/tote-bag>/products/canvas-tote', 'two moves: both old addresses lead to the new one (no chain)');
update public.catalog_items set slug = 'tote-bag' where id = '00000000-0000-0000-0000-000000341001';
select pg_temp.check((select string_agg(from_path || '>' || to_path, ',' order by from_path) from public.store_redirects)
  = '/products/canvas-tote>/products/tote-bag,/products/cotton-tote>/products/tote-bag', 'back to the first address: it is live again, never a loop');
update public.catalog_items set slug = 'secret-2' where id = '00000000-0000-0000-0000-000000341003';
select pg_temp.check(not exists (select 1 from public.store_redirects where from_path like '%secret%'), 'a product that was never on the site leaves no redirect');
update public.catalog_collections set slug = 'green' where id = '00000000-0000-0000-0000-000000347001';
update public.store_pages set slug = 'about-us' where slug = 'about';
select pg_temp.check(exists (select 1 from public.store_redirects where from_path = '/collections/eco' and to_path = '/collections/green')
  and exists (select 1 from public.store_redirects where from_path = '/pages/about' and to_path = '/pages/about-us'), 'a collection and a page leave redirects too');
commit;
begin;
set local role service_role;
select pg_temp.check(public.sf_redirect('00000000-0000-0000-0000-000000345001', '/products/cotton-tote') = '/products/tote-bag'
  and public.sf_redirect('00000000-0000-0000-0000-000000345002', '/products/cotton-tote') is null, 'the storefront finds the 301 — of its own store only');
commit;

-- ---- 6. "חזרה לגרסה קודמת": an archived version is published again --------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000340a1');
select public.store_publish_theme('00000000-0000-0000-0000-000000346002');
select pg_temp.check((select string_agg(version || ':' || status, ',' order by version) from public.store_theme_versions) = '1:archived,2:published', 'the new one published, the old archived');
select public.store_publish_theme('00000000-0000-0000-0000-000000346001');
select pg_temp.check((select string_agg(version || ':' || status, ',' order by version) from public.store_theme_versions) = '1:published,2:archived', 'back to version 1');
commit;
begin;
set local role service_role;
select pg_temp.check((public.sf_store('00000000-0000-0000-0000-000000345001'))#>>'{theme,settings,hero,title}' = 'A', 'the storefront shows version 1 again');
commit;

-- a paused store goes back to "בקרוב"
update public.stores set status = 'paused' where id = '00000000-0000-0000-0000-000000345001';
begin;
set local role service_role;
select pg_temp.check(public.sf_products('00000000-0000-0000-0000-000000345001') is null and (public.sf_store('00000000-0000-0000-0000-000000345001'))->>'status' = 'paused',
  'a paused store sells nothing and shows only its name');
commit;
