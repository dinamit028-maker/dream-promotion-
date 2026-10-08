-- A kit applied in one transaction (2.73, migration 3900) on a real Postgres (tests/sql/run.sh): store_apply_kit writes
-- what applyKit wrote step by step — collections, pages, replaced pages, menus, the theme draft, the first publish — as the
-- caller, through the tables' row-level security; and a failure anywhere leaves nothing, with the step in the message.
--   "Apply" owner A        "Stranger" owner B
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

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000390a1', 'a@apply.test'), ('00000000-0000-0000-0000-0000000390b1', 'b@stranger.test');
insert into public.businesses (id, name, slug) values
  ('00000000-0000-0000-0000-00000039b001', 'Apply', 'apply-39'), ('00000000-0000-0000-0000-00000039b002', 'Stranger', 'stranger-39');
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-00000039b001', '00000000-0000-0000-0000-0000000390a1', 'owner', 'full'),
  ('00000000-0000-0000-0000-00000039b002', '00000000-0000-0000-0000-0000000390b1', 'owner', 'full');

-- the plan of a kit for a new store (the dashboard's kitPayload)
create or replace function pg_temp.plan(page_slug text, draft uuid, publish boolean) returns jsonb language sql as $$
  select jsonb_build_object(
    'collections', '[{"title":"חדש","slug":"new","kind":"auto","rules":{"tags":["חדש"]},"sort":"newest","publish_online":true,"position":0},
                     {"title":"נשים","slug":"women","kind":"auto","rules":{"tags":["נשים"]},"sort":"newest","publish_online":true,"position":0}]'::jsonb,
    'pages', jsonb_build_array(
      jsonb_build_object('kind','page','policy',null,'slug',page_slug,'title','אודות','body','## מי אנחנו','seo_title','','seo_description','','published',false),
      '{"kind":"policy","policy":"returns","slug":"policy-returns","title":"ביטולים והחזרות","body":"[לבדוק עם עורך דין]","seo_title":"","seo_description":"","published":false}'::jsonb),
    'replace', '[]'::jsonb,
    'menus', '[{"kind":"main","items":[{"label":"חדש","href":"/collections/new"},{"label":"אודות","href":"/pages/about"}]},
               {"kind":"footer","items":[{"label":"החזרות","href":"/policies/returns"}]}]'::jsonb,
    'draft', jsonb_build_object('id', draft, 'template', 'kit', 'settings', '{"kit":"fashion","sections":[]}'::jsonb, 'note', 'ערכה: אופנה'),
    'publish', publish)
$$;

begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000390a1');
insert into public.stores (id, name, template) values ('00000000-0000-0000-0000-000000395001', 'Apply', 'bags');
commit;

-- ---- 1. a failure in the middle leaves nothing: a page that the table refuses (its address) after two collections ----------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000390a1');
select pg_temp.refused_with($q$ select public.store_apply_kit('00000000-0000-0000-0000-000000395001', pg_temp.plan('Not A Slug!', null, true)) $q$,
  'העמוד "אודות" — ', 'a page the table refuses: the step is named');
select pg_temp.check((select count(*) from public.catalog_collections) = 0, 'the collections written before it are gone too');
select pg_temp.check((select count(*) from public.store_pages) = 0, 'no page');
select pg_temp.check((select count(*) from public.store_menus) = 0, 'no menu');
select pg_temp.check((select count(*) from public.store_theme_versions) = 0, 'no draft, nothing published');
commit;

-- ---- 2. the whole kit, at once: counted as KitApplied; the first theme is published (the store never published one) -------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000390a1');
select pg_temp.check(public.store_apply_kit('00000000-0000-0000-0000-000000395001', pg_temp.plan('about', null, true))
  = '{"collections":2,"pages":2,"replacedPages":0,"menus":2,"version":1,"published":true}'::jsonb, 'what was written');
select pg_temp.check((select string_agg(slug || ':' || position, ',' order by position) from public.catalog_collections) = 'new:0,women:1', 'each new collection last, in order');
select pg_temp.check((select bool_and(business_id = '00000000-0000-0000-0000-00000039b001') from public.catalog_collections), 'in the caller''s business (its trigger)');
select pg_temp.check((select count(*) from public.store_pages where not published) = 2, 'pages are drafts');
select pg_temp.check((select status || ':' || template from public.store_theme_versions) = 'published:kit', 'the first theme, published');
select pg_temp.check((select count(*) from public.catalog_items) = 0, 'a kit adds no product');
commit;

-- ---- 3. again, on the store's draft: the draft is updated, a page the owner chose is replaced, nothing published ----------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000390a1');
insert into public.store_theme_versions (store_id, template, settings) values ('00000000-0000-0000-0000-000000395001', 'kit', '{"kit":"fashion"}');
select pg_temp.check(public.store_apply_kit('00000000-0000-0000-0000-000000395001', jsonb_build_object(
    'collections', '[]'::jsonb, 'pages', '[]'::jsonb, 'menus', '[]'::jsonb,
    'replace', jsonb_build_array(jsonb_build_object('id', (select id from public.store_pages where slug = 'about'),
      'row', '{"kind":"page","policy":null,"slug":"about","title":"עלינו","body":"טקסט חדש","seo_title":"","seo_description":"","published":false}'::jsonb)),
    'draft', jsonb_build_object('id', (select id from public.store_theme_versions where status = 'draft'), 'template', 'kit', 'settings', '{"kit":"beauty"}'::jsonb, 'note', 'עיצוב: ביוטי'),
    'publish', false)) = '{"collections":0,"pages":0,"replacedPages":1,"menus":0,"version":2,"published":false}'::jsonb, 'a design switch with one page replaced');
select pg_temp.check((select title from public.store_pages where slug = 'about') = 'עלינו', 'the page the owner chose');
select pg_temp.check((select settings->>'kit' || ':' || note from public.store_theme_versions where status = 'draft') = 'beauty:עיצוב: ביוטי', 'the one draft');
select pg_temp.check((select settings->>'kit' from public.store_theme_versions where status = 'published') = 'fashion', 'the site keeps what is published');
-- a draft that is not this store's draft (the published version's id): refused, and the page replaced before it stays as it was
select pg_temp.refused_with(format($q$ select public.store_apply_kit('00000000-0000-0000-0000-000000395001', jsonb_build_object(
    'replace', jsonb_build_array(jsonb_build_object('id', %L, 'row', '{"kind":"page","policy":null,"slug":"about","title":"לא נשמר","body":"","published":false}'::jsonb)),
    'draft', jsonb_build_object('id', %L, 'template', 'kit', 'settings', '{}'::jsonb))) $q$,
    (select id from public.store_pages where slug = 'about'), (select id from public.store_theme_versions where status = 'published')),
  'העיצוב — draft not found', 'only the draft is written');
select pg_temp.check((select title from public.store_pages where slug = 'about') = 'עלינו', 'nothing of that call stayed');
commit;

-- ---- 4. another business: not its store, not its page; anon may not call it at all --------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000390b1');
select pg_temp.refused_with($q$ select public.store_apply_kit('00000000-0000-0000-0000-000000395001', pg_temp.plan('about2', null, false)) $q$,
  'store not found', 'a store of another business');
insert into public.stores (id, name, template) values ('00000000-0000-0000-0000-000000395002', 'Stranger', 'kit');
select pg_temp.refused_with(format($q$ select public.store_apply_kit('00000000-0000-0000-0000-000000395002', jsonb_build_object(
    'replace', jsonb_build_array(jsonb_build_object('id', %L, 'row', '{"kind":"page","policy":null,"slug":"x","title":"נלקח","body":"","published":false}'::jsonb)),
    'draft', jsonb_build_object('template', 'kit', 'settings', '{}'::jsonb))) $q$,
    '00000000-0000-0000-0000-000000000000'),
  'page not found', 'a page that is not in its store');
commit;
select pg_temp.check((select title from public.store_pages where slug = 'about') = 'עלינו', 'A''s page as it was');
select pg_temp.check(not has_function_privilege('anon', 'public.store_apply_kit(uuid, jsonb)', 'execute'), 'anon may not call it');
select pg_temp.check(has_function_privilege('authenticated', 'public.store_apply_kit(uuid, jsonb)', 'execute'), 'a signed-in owner may');
select pg_temp.check((select prosecdef from pg_proc where proname = 'store_apply_kit') = false, 'security invoker: the caller''s row-level security');
