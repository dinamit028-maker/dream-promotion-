-- The world of the storefront's browser tests (tests/e2e/storefront.e2e.ts), on a local Postgres with every migration.
--   followme.test (+ www)  FollowMe Collection — on the air: bags with sizes and colours, collections, policies, a published
--                          theme and a newer draft, Google Analytics and Search Console codes, one moved address
--   shoes.test             another business on the air — the same product address, another product
--   draft.test             a store that is not on the air yet ("בקרוב"), seen only through a preview token
-- Built by the superuser; the storefront then reads it only through sf_* as service_role.
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-4000-8000-0000000000f1', 'owner@followme.test'), ('bbbbbbbb-0000-4000-8000-0000000000f1', 'owner@shoes.test'),
  ('cccccccc-0000-4000-8000-0000000000f1', 'owner@draft.test');
insert into public.businesses (id, name, slug) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'FollowMe', 'followme-e2e'), ('bbbbbbbb-0000-4000-8000-00000000000b', 'Shoes', 'shoes-e2e'),
  ('cccccccc-0000-4000-8000-00000000000c', 'Draft', 'draft-e2e');
insert into public.business_members (business_id, user_id, role, access) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-0000000000f1', 'owner', 'full'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'bbbbbbbb-0000-4000-8000-0000000000f1', 'owner', 'full'),
  ('cccccccc-0000-4000-8000-00000000000c', 'cccccccc-0000-4000-8000-0000000000f1', 'owner', 'full');
insert into public.register_settings (user_id, business_id, business_type, vat_rate, dealer_number, company_number, legal_name, street, house_no, city, entity_type) values
  ('aaaaaaaa-0000-4000-8000-0000000000f1', 'aaaaaaaa-0000-4000-8000-00000000000a', 'licensed', 18, '', '516000001', 'פולואו מי בע"מ', 'הרצל', '10', 'תל אביב', 'company'),
  ('bbbbbbbb-0000-4000-8000-0000000000f1', 'bbbbbbbb-0000-4000-8000-00000000000b', 'licensed', 18, '200000002', '', 'נעליים', 'יפו', '2', 'ירושלים', null),
  ('cccccccc-0000-4000-8000-0000000000f1', 'cccccccc-0000-4000-8000-00000000000c', 'licensed', 18, '300000003', '', 'טיוטה', 'הים', '3', 'חיפה', null);

insert into public.catalog_items (id, user_id, business_id, name, price, kind, track_stock, stock_qty, low_stock, slug, publish_online,
                                  description, tags, online_price, compare_at_price, sku, active, custom_fields, manufacturer, country_of_origin) values
  ('aaaaaaaa-0000-4000-8000-000000000101', 'aaaaaaaa-0000-4000-8000-0000000000f1', 'aaaaaaaa-0000-4000-8000-00000000000a', 'שקית בד', 20, 'product', true, 7, 0,
   'tote-bag', true, E'שקית בד חזקה עם ידיות ארוכות.\n\n## מה מקבלים\n- הדפסת לוגו\n- ידיות ארוכות', '{בד,אקולוגי}', null, null, 'TOTE', true,
   '{"material": "כותנה", "cost_note": "סוד-מסחרי"}', 'FollowMe', 'ישראל'),
  ('aaaaaaaa-0000-4000-8000-000000000102', 'aaaaaaaa-0000-4000-8000-0000000000f1', 'aaaaaaaa-0000-4000-8000-00000000000a', 'שקית נייר', 3.5, 'product', true, 0, 0,
   'paper-bag', true, 'שקית נייר חומה.', '{נייר}', 3, 4, '', true, '{}', '', ''),
  ('aaaaaaaa-0000-4000-8000-000000000103', 'aaaaaaaa-0000-4000-8000-0000000000f1', 'aaaaaaaa-0000-4000-8000-00000000000a', 'שקית קרפט', 5, 'product', false, 0, 0,
   'kraft-bag', true, 'שקית קרפט טבעית.', '{נייר}', null, null, '', true, '{}', '', ''),
  ('aaaaaaaa-0000-4000-8000-000000000104', 'aaaaaaaa-0000-4000-8000-0000000000f1', 'aaaaaaaa-0000-4000-8000-00000000000a', 'שקית סודית', 9, 'product', false, 0, 0,
   'secret-bag', false, '', '{בד}', null, null, '', true, '{}', '', ''),
  ('bbbbbbbb-0000-4000-8000-000000000201', 'bbbbbbbb-0000-4000-8000-0000000000f1', 'bbbbbbbb-0000-4000-8000-00000000000b', 'מגף', 300, 'product', false, 0, 0,
   'tote-bag', true, 'מגף עור.', '{עור}', null, null, '', true, '{}', '', ''),
  ('cccccccc-0000-4000-8000-000000000301', 'cccccccc-0000-4000-8000-0000000000f1', 'cccccccc-0000-4000-8000-00000000000c', 'מוצר טיוטה', 10, 'product', false, 0, 0,
   'draft-item', true, '', '{}', null, null, '', true, '{}', '', '');
insert into public.catalog_options (item_id, position, name, choices) values
  ('aaaaaaaa-0000-4000-8000-000000000101', 1, 'מידה', '{S,M}'), ('aaaaaaaa-0000-4000-8000-000000000101', 2, 'צבע', '{שחור,לבן}');
insert into public.catalog_variants (id, item_id, option1, option2, price, online_price, stock_qty, active, position, sku) values
  ('aaaaaaaa-0000-4000-8000-000000000111', 'aaaaaaaa-0000-4000-8000-000000000101', 'S', 'שחור', null, null, 5, true, 1, 'TOTE-S-B'),
  ('aaaaaaaa-0000-4000-8000-000000000112', 'aaaaaaaa-0000-4000-8000-000000000101', 'S', 'לבן', null, null, 0, true, 2, ''),
  ('aaaaaaaa-0000-4000-8000-000000000113', 'aaaaaaaa-0000-4000-8000-000000000101', 'M', 'שחור', 25, 24, 2, true, 3, ''),
  ('aaaaaaaa-0000-4000-8000-000000000114', 'aaaaaaaa-0000-4000-8000-000000000101', 'M', 'לבן', null, null, 1, false, 4, '');
insert into public.catalog_media (id, item_id, path, url, sizes, alt, position, width, height) values
  ('aaaaaaaa-0000-4000-8000-000000000121', 'aaaaaaaa-0000-4000-8000-000000000101', 'a/1', 'https://cdn.test/tote-1-800.webp',
   '{"400": "https://cdn.test/tote-1-400.webp", "800": "https://cdn.test/tote-1-800.webp", "1600": "https://cdn.test/tote-1-1600.webp"}', 'שקית בד שחורה', 0, 800, 1000),
  ('aaaaaaaa-0000-4000-8000-000000000122', 'aaaaaaaa-0000-4000-8000-000000000101', 'a/2', 'https://cdn.test/tote-2-800.webp', '{}', '', 1, 800, 1000);
update public.catalog_variants set media_id = 'aaaaaaaa-0000-4000-8000-000000000122' where id = 'aaaaaaaa-0000-4000-8000-000000000113';
insert into public.catalog_field_defs (user_id, business_id, field_key, label, kind, show_online, position) values
  ('aaaaaaaa-0000-4000-8000-0000000000f1', 'aaaaaaaa-0000-4000-8000-00000000000a', 'material', 'חומר', 'text', true, 1),
  ('aaaaaaaa-0000-4000-8000-0000000000f1', 'aaaaaaaa-0000-4000-8000-00000000000a', 'cost_note', 'הערת עלות', 'text', false, 2);

-- the stores
insert into public.stores (id, user_id, business_id, name, description, phone, whatsapp, email, ga4_id, gsc_code) values
  ('aaaaaaaa-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-0000000000f1', 'aaaaaaaa-0000-4000-8000-00000000000a', 'FollowMe Collection',
   'שקיות ממותגות לעסקים', '03-5550000', '972501234567', 'hello@followme.test', 'G-TEST1234', 'gsc-verification-code-1'),
  ('bbbbbbbb-0000-4000-8000-0000000000b1', 'bbbbbbbb-0000-4000-8000-0000000000f1', 'bbbbbbbb-0000-4000-8000-00000000000b', 'Shoes',
   '', '02-5550000', '', '', '', ''),
  ('cccccccc-0000-4000-8000-0000000000c1', 'cccccccc-0000-4000-8000-0000000000f1', 'cccccccc-0000-4000-8000-00000000000c', 'Draft Store',
   '', '04-5550000', '', '', '', '');
insert into public.store_domains (store_id, domain, is_primary) values
  ('aaaaaaaa-0000-4000-8000-0000000000a1', 'followme.test', true), ('aaaaaaaa-0000-4000-8000-0000000000a1', 'www.followme.test', false),
  ('bbbbbbbb-0000-4000-8000-0000000000b1', 'shoes.test', true), ('cccccccc-0000-4000-8000-0000000000c1', 'draft.test', true);
insert into public.store_pages (store_id, kind, policy, slug, title, body, published) values
  ('aaaaaaaa-0000-4000-8000-0000000000a1', 'policy', 'returns', 'returns', 'ביטולים והחזרות', E'## ביטול עסקה\nאפשר לבטל עסקה לפי החוק.', true),
  ('aaaaaaaa-0000-4000-8000-0000000000a1', 'policy', 'privacy', 'privacy', 'מדיניות פרטיות', 'מה נאסף ולמה.', true),
  ('aaaaaaaa-0000-4000-8000-0000000000a1', 'policy', 'accessibility', 'accessibility', 'הצהרת נגישות', 'פנו אלינו בכל בעיה של נגישות.', true),
  ('aaaaaaaa-0000-4000-8000-0000000000a1', 'page', null, 'about', 'אודות', E'אנחנו מדפיסים שקיות.\n\n- לעסקים קטנים\n- ולגדולים', true),
  ('bbbbbbbb-0000-4000-8000-0000000000b1', 'policy', 'returns', 'returns', 'החזרות', 'x', true),
  ('bbbbbbbb-0000-4000-8000-0000000000b1', 'policy', 'privacy', 'privacy', 'פרטיות', 'x', true),
  ('bbbbbbbb-0000-4000-8000-0000000000b1', 'policy', 'accessibility', 'accessibility', 'נגישות', 'x', true);
insert into public.store_menus (store_id, kind, items) values
  ('aaaaaaaa-0000-4000-8000-0000000000a1', 'main', '[{"label": "כל השקיות", "href": "/collections/all"}, {"label": "אקולוגיות", "href": "/collections/eco"}, {"label": "אודות", "href": "/pages/about"}]');
insert into public.catalog_collections (id, user_id, business_id, title, slug, description, kind, rules, sort, publish_online, position) values
  ('aaaaaaaa-0000-4000-8000-000000000131', 'aaaaaaaa-0000-4000-8000-0000000000f1', 'aaaaaaaa-0000-4000-8000-00000000000a', 'שקיות אקולוגיות', 'eco',
   'שקיות שאפשר להשתמש בהן שוב ושוב.', 'manual', '{}', 'manual', true, 1),
  ('aaaaaaaa-0000-4000-8000-000000000132', 'aaaaaaaa-0000-4000-8000-0000000000f1', 'aaaaaaaa-0000-4000-8000-00000000000a', 'שקיות נייר', 'paper',
   '', 'auto', '{"tags": ["נייר"]}', 'price_asc', true, 2);
insert into public.catalog_collection_items (collection_id, item_id, position) values
  ('aaaaaaaa-0000-4000-8000-000000000131', 'aaaaaaaa-0000-4000-8000-000000000101', 1),
  ('aaaaaaaa-0000-4000-8000-000000000131', 'aaaaaaaa-0000-4000-8000-000000000104', 2);
insert into public.store_redirects (store_id, from_path, to_path) values
  ('aaaaaaaa-0000-4000-8000-0000000000a1', '/products/old-tote', '/products/tote-bag');
-- the theme: version 1 published, version 2 a draft
insert into public.store_theme_versions (id, store_id, template, settings) values
  ('aaaaaaaa-0000-4000-8000-000000000141', 'aaaaaaaa-0000-4000-8000-0000000000a1', 'bags',
   '{"colors": {"primary": "#0a3d62"}, "sections": [{"id": "hero", "settings": {"title": "שקיות FollowMe"}}, {"id": "faq", "hidden": false, "settings": {"items": [{"q": "יש מינימום?", "a": "כן — כתבו לנו."}]}}]}');
select public.store_publish_theme('aaaaaaaa-0000-4000-8000-000000000141');
insert into public.store_theme_versions (id, store_id, template, settings) values
  ('aaaaaaaa-0000-4000-8000-000000000142', 'aaaaaaaa-0000-4000-8000-0000000000a1', 'bags', '{"sections": [{"id": "hero", "settings": {"title": "טיוטה חדשה"}}]}');

-- on the air: the domain worked once (here, set by hand), then the checklist lets the store go up
update public.store_domains set status = 'active' where domain in ('followme.test', 'www.followme.test', 'shoes.test');
update public.stores set status = 'published' where id in ('aaaaaaaa-0000-4000-8000-0000000000a1', 'bbbbbbbb-0000-4000-8000-0000000000b1');
