-- Starter kits (2.58, migration 3800) on a real Postgres (tests/sql/run.sh). A kit is written by the owner through the
-- existing tables and their row-level security (the dashboard's applyKit): a theme draft on the open template "kit",
-- collections, pages, policies and menus — and no product. The storefront then gets only the menu links that lead to
-- something on the site; the owner's preview gets every link, and every page even before it is published. Another business
-- can neither write into the store nor make one of its links appear.
--   "Kits" owner A        "Other" owner B
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
create or replace function pg_temp.labels(j jsonb) returns text language sql as $$
  select coalesce(string_agg(e->>'label', ',' order by n), '') from jsonb_array_elements(j) with ordinality t(e, n)
$$;

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000380a1', 'a@kits.test'), ('00000000-0000-0000-0000-0000000380b1', 'b@other.test');
insert into public.businesses (id, name, slug) values
  ('00000000-0000-0000-0000-00000038b001', 'Kits', 'kits-38'), ('00000000-0000-0000-0000-00000038b002', 'Other', 'other-38');
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-00000038b001', '00000000-0000-0000-0000-0000000380a1', 'owner', 'full'),
  ('00000000-0000-0000-0000-00000038b002', '00000000-0000-0000-0000-0000000380b1', 'owner', 'full');

-- ---- 1. the owner opens a store on the open template and applies a kit (applyKit's writes) --------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000380a1');
insert into public.stores (id, name, template) values ('00000000-0000-0000-0000-000000385001', 'Kits', 'kit');
insert into public.catalog_collections (title, slug, kind, rules, sort, publish_online) values
  ('חדש', 'new', 'auto', '{"tags": ["חדש"]}', 'newest', true),
  ('נשים', 'women', 'auto', '{"tags": ["נשים"]}', 'newest', false);
insert into public.store_pages (store_id, kind, policy, slug, title, body, published) values
  ('00000000-0000-0000-0000-000000385001', 'page', null, 'about', 'אודות', '## מי אנחנו\n\n[להשלים]', false),
  ('00000000-0000-0000-0000-000000385001', 'page', null, 'faq', 'שאלות נפוצות', 'שאלה ותשובה.', true),
  ('00000000-0000-0000-0000-000000385001', 'policy', 'returns', 'policy-returns', 'ביטולים והחזרות', '[לבדוק עם עורך דין]', false);
insert into public.store_menus (store_id, kind, items) values
  ('00000000-0000-0000-0000-000000385001', 'main', '[{"label":"חדש","href":"/collections/new"},{"label":"נשים","href":"/collections/women"},
    {"label":"אודות","href":"/pages/about"},{"label":"שאלות","href":"/pages/faq"},{"label":"הכל","href":"/collections/all"},
    {"label":"קטגוריות","href":"/collections"},{"label":"אינסטגרם","href":"https://instagram.com/kits"},{"label":"לפני ואחרי","href":"/#before-after"}]'),
  ('00000000-0000-0000-0000-000000385001', 'footer', '[{"label":"החזרות","href":"/policies/returns"},{"label":"אין כזה","href":"/pages/nope"}]');
insert into public.store_theme_versions (store_id, template, settings, note) values
  ('00000000-0000-0000-0000-000000385001', 'kit', '{"kit":"fashion","font":"assistant","art":"plain","sections":[{"id":"instagram","type":"gallery","hidden":false,"settings":{"title":"אינסטגרם"}}]}', 'ערכה: אופנה');
select pg_temp.check((select count(*) from public.catalog_items) = 0, 'a kit adds no product: the catalog is the register''s and finance''s too');
select pg_temp.check((select template from public.store_theme_versions where store_id = '00000000-0000-0000-0000-000000385001') = 'kit', 'the draft is on the open template');
commit;

-- a draft that came from another template moves to "kit" (a draft may change its template; a published version never does)
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000380a1');
update public.store_theme_versions set template = 'bags' where store_id = '00000000-0000-0000-0000-000000385001' and status = 'draft';
update public.store_theme_versions set template = 'kit' where store_id = '00000000-0000-0000-0000-000000385001' and status = 'draft';
select pg_temp.check((select template from public.store_theme_versions where store_id = '00000000-0000-0000-0000-000000385001' and status = 'draft') = 'kit', 'a draft changes its template');
commit;

-- ---- 2. another business: no write into the store; its own collection does not open a link of the store ---------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000380b1');
select pg_temp.refused_with($$insert into public.store_pages (store_id, kind, slug, title, body, published)
  values ('00000000-0000-0000-0000-000000385001', 'page', 'x', 'x', 'x', true)$$, 'store not found', 'another business does not add a page to the store (it does not even learn the store exists)');
select pg_temp.check((select count(*) from public.store_menus) = 0, 'and does not see its menus');
insert into public.catalog_collections (title, slug, kind, rules, sort, publish_online) values ('נשים', 'women', 'auto', '{"tags": ["נשים"]}', 'newest', true);
commit;

-- ---- 3. the storefront: the owner's preview gets everything; a shopper only what is on the site -----------------------------
begin;
set local role service_role;
select pg_temp.check(pg_temp.labels((public.sf_store('00000000-0000-0000-0000-000000385001', true))#>'{menus,main}') = 'חדש,נשים,אודות,שאלות,הכל,קטגוריות,אינסטגרם,לפני ואחרי',
  'the preview gets every link of the menu');
select pg_temp.check((public.sf_store('00000000-0000-0000-0000-000000385001', true))#>>'{template}' = 'kit'
  and (public.sf_store('00000000-0000-0000-0000-000000385001', true))#>>'{theme,settings,sections,0,type}' = 'gallery', 'the preview gets the kit''s draft (its own sections)');
select pg_temp.check(pg_temp.labels(public.sf_menu_visible('00000000-0000-0000-0000-000000385001',
  (select items from public.store_menus where store_id = '00000000-0000-0000-0000-000000385001' and kind = 'main'), false)) = 'חדש,שאלות,הכל,קטגוריות,אינסטגרם,לפני ואחרי',
  'a shopper: no link to a page not published, nor to a collection not on the site (another business''s "women" does not count)');
select pg_temp.check(pg_temp.labels(public.sf_menu_visible('00000000-0000-0000-0000-000000385001',
  (select items from public.store_menus where store_id = '00000000-0000-0000-0000-000000385001' and kind = 'footer'), false)) = '', 'a policy not published and a page that does not exist are left out');
select pg_temp.check(public.sf_menu_visible('00000000-0000-0000-0000-000000385001', null, false) = '[]'::jsonb
  and public.sf_menu_visible('00000000-0000-0000-0000-000000385001', '{"x":1}', false) = '[]'::jsonb, 'no menu, or not a list: an empty menu');
select pg_temp.check((public.sf_page('00000000-0000-0000-0000-000000385001', 'page', 'about', true))->>'title' = 'אודות'
  and (public.sf_page('00000000-0000-0000-0000-000000385001', 'policy', 'returns', true))->>'title' = 'ביטולים והחזרות',
  'the preview shows a page and a policy before they are published');
select pg_temp.check(public.sf_page('00000000-0000-0000-0000-000000385001', 'page', 'about') is null, 'a store not on the air shows no page to a shopper');
commit;

-- on the air (the checklist is the subject of commerce-store.check.sql; here the status is set directly)
set session_replication_role = replica;
update public.stores set status = 'published', published_at = now() where id = '00000000-0000-0000-0000-000000385001';
set session_replication_role = origin;
begin;
set local role service_role;
select pg_temp.check(pg_temp.labels((public.sf_store('00000000-0000-0000-0000-000000385001'))#>'{menus,main}') = 'חדש,שאלות,הכל,קטגוריות,אינסטגרם,לפני ואחרי',
  'on the air: the menu without the links to what is not on the site');
select pg_temp.check(pg_temp.labels((public.sf_store('00000000-0000-0000-0000-000000385001'))#>'{menus,footer}') = '', 'and the footer too');
select pg_temp.check(public.sf_page('00000000-0000-0000-0000-000000385001', 'page', 'about') is null
  and (public.sf_page('00000000-0000-0000-0000-000000385001', 'page', 'faq'))->>'title' = 'שאלות נפוצות', 'a shopper: published pages only');
select pg_temp.check(public.sf_page('00000000-0000-0000-0000-000000385001', 'policy', 'returns') is null, 'a policy not published is not shown');
commit;

-- the owner publishes the page and the policy: their links come back
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000380a1');
update public.store_pages set published = true, body = 'אודות העסק.' where store_id = '00000000-0000-0000-0000-000000385001' and slug = 'about';
update public.store_pages set published = true, body = 'הנוסח המאושר.' where store_id = '00000000-0000-0000-0000-000000385001' and policy = 'returns';
update public.catalog_collections set publish_online = true where slug = 'women';
commit;
begin;
set local role service_role;
select pg_temp.check(pg_temp.labels((public.sf_store('00000000-0000-0000-0000-000000385001'))#>'{menus,main}') = 'חדש,נשים,אודות,שאלות,הכל,קטגוריות,אינסטגרם,לפני ואחרי',
  'published: every link is back, in its order');
select pg_temp.check(pg_temp.labels((public.sf_store('00000000-0000-0000-0000-000000385001'))#>'{menus,footer}') = 'החזרות', 'the policy too; a page that does not exist stays out');
commit;

-- ---- 4. the new function is the server's only --------------------------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000380a1');
select pg_temp.refused_with($$select public.sf_menu_visible('00000000-0000-0000-0000-000000385001', '[]', false)$$, 'permission denied', 'a signed-in user never calls sf_*');
commit;
begin;
set local role anon;
select pg_temp.refused_with($$select public.sf_page('00000000-0000-0000-0000-000000385001', 'page', 'about', true)$$, 'permission denied', 'nor a visitor (the preview is the server''s)');
commit;
