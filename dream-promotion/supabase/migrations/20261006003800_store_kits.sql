-- ============================================================================================================================
-- Dream Commerce 2.58 — starter kits ("ערכות הקמה"). Replaces two storefront functions (same signatures) and adds one.
--   1. A link of a menu that leads to a page, a policy or a collection that is not on the site is left out of the menu the
--      storefront gets — a shopper never meets a link to "not found". The owner's preview gets every link.
--   2. The owner's preview (p_preview) shows a page or a policy that is not published yet, so a kit applied as a draft can
--      be seen whole before anything is published. A shopper still gets published pages only.
-- The kits themselves (colours, sections, menus, pages, collections) are data the dashboard writes through the existing
-- tables and their row-level security — no new table, no new column. Only "create or replace" — nothing is removed.
-- Tested on a local Postgres 16: tests/sql/store-kits.check.sql (with every existing check).
-- Applied to the live database only after the owner's explicit approval.
-- ============================================================================================================================

-- ---- 1. the links of a menu that are on the site ---------------------------------------------------------------------------
-- /pages/<slug> → a published page of the store; /policies/<kind> → a published policy; /collections/<slug> → a collection of
-- the business on the site ("all" is every product). Any other link (the home page, /collections, /search, https://…, an
-- anchor) stays. The order is kept.
create or replace function public.sf_menu_visible(p_store uuid, p_items jsonb, p_preview boolean default false) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when p_preview then coalesce(p_items, '[]'::jsonb) else coalesce((
    select jsonb_agg(t.e order by t.n)
      from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) with ordinality as t(e, n)
     where case
             when t.e->>'href' ~ '^/pages/[^/?#]+$' then exists (
               select 1 from public.store_pages g
                where g.store_id = p_store and g.kind = 'page' and g.published and g.slug = substring(t.e->>'href' from '^/pages/([^/?#]+)$'))
             when t.e->>'href' ~ '^/policies/[a-z]+$' then exists (
               select 1 from public.store_pages g
                where g.store_id = p_store and g.kind = 'policy' and g.published and g.policy = substring(t.e->>'href' from '^/policies/([a-z]+)$'))
             when t.e->>'href' ~ '^/collections/[^/?#]+$' and t.e->>'href' <> '/collections/all' then exists (
               select 1 from public.catalog_collections c join public.stores s on s.business_id = c.business_id
                where s.id = p_store and c.publish_online and c.slug = substring(t.e->>'href' from '^/collections/([^/?#]+)$'))
             else true
           end), '[]'::jsonb) end
$$;

-- ---- 2. the store, with its menus as the visitor may see them (the rest is migration 3700's, unchanged) --------------------
create or replace function public.sf_store(p_store uuid, p_preview boolean default false) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s public.stores; r public.register_settings; th public.store_theme_versions; prim text; acc jsonb;
begin
  select * into s from public.stores where id = p_store;
  if s.id is null then return null; end if;
  select domain into prim from public.store_domains where store_id = s.id and is_primary;
  acc := jsonb_build_object('mode', public.store_access(s),
                            'key', case when public.store_access(s) = 'password' then public.store_access_key(s) end);
  if s.status <> 'published' and not p_preview then
    return jsonb_build_object('id', s.id, 'status', s.status, 'name', s.name, 'lang', s.lang, 'logo_url', s.logo_url, 'primary_domain', prim,
                              'slug', s.slug, 'access', acc);
  end if;
  if p_preview then select * into th from public.store_theme_versions where store_id = s.id and status = 'draft'; end if;
  if th.id is null then select * into th from public.store_theme_versions where store_id = s.id and status = 'published'; end if;
  select * into r from public.register_settings where business_id = s.business_id;
  return jsonb_build_object(
    'id', s.id, 'status', s.status, 'name', s.name, 'template', coalesce(th.template, s.template), 'lang', s.lang,
    'currency', s.currency, 'country', s.country, 'logo_url', s.logo_url, 'description', s.description,
    'contact', jsonb_build_object('phone', s.phone, 'whatsapp', s.whatsapp, 'email', s.email, 'address', s.address),
    'ga4_id', s.ga4_id, 'gsc_code', s.gsc_code, 'show_stock_count', s.show_stock_count, 'primary_domain', prim,
    'theme', jsonb_build_object('version', th.version, 'settings', coalesce(th.settings, '{}'::jsonb)),
    'legal', jsonb_build_object(
      'name', coalesce(nullif(btrim(r.legal_name), ''), s.name),
      'number', case when coalesce(r.entity_type, '') = 'company' and coalesce(r.company_number, '') <> '' then r.company_number
                     else coalesce(nullif(r.dealer_number, ''), nullif(r.company_number, ''), '') end,
      'number_kind', case when coalesce(r.entity_type, '') = 'company' or (coalesce(r.dealer_number, '') = '' and coalesce(r.company_number, '') <> '') then 'company' else 'dealer' end,
      'address', btrim(concat_ws(', ', nullif(btrim(concat_ws(' ', nullif(r.street, ''), nullif(r.house_no, ''))), ''), nullif(r.city, ''))) ),
    'menus', jsonb_build_object(
      'main',   public.sf_menu_visible(s.id, (select m.items from public.store_menus m where m.store_id = s.id and m.kind = 'main'), p_preview),
      'footer', public.sf_menu_visible(s.id, (select m.items from public.store_menus m where m.store_id = s.id and m.kind = 'footer'), p_preview)),
    'policies', coalesce((select jsonb_agg(jsonb_build_object('policy', g.policy, 'title', g.title) order by g.policy)
                            from public.store_pages g where g.store_id = s.id and g.kind = 'policy' and g.published), '[]'::jsonb),
    'collections', coalesce((select jsonb_agg(jsonb_build_object('slug', c.slug, 'title', c.title, 'image_url', c.image_url) order by c.position, c.title)
                               from public.catalog_collections c where c.business_id = s.business_id and c.publish_online), '[]'::jsonb),
    'can_buy', public.sf_can_buy(s),
    'slug', s.slug, 'access', acc);
end $$;

-- ---- 3. a page: the owner's preview also shows one that is not published yet ----------------------------------------------
create or replace function public.sf_page(p_store uuid, p_kind text, p_slug text, p_preview boolean default false) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s public.stores;
begin
  select * into s from public.stores where id = p_store;
  if s.id is null or (s.status <> 'published' and not p_preview) then return null; end if;
  return (select jsonb_build_object('slug', g.slug, 'kind', g.kind, 'policy', g.policy, 'title', g.title, 'body', g.body,
                   'seo_title', g.seo_title, 'seo_description', g.seo_description, 'updated_at', g.updated_at)
            from public.store_pages g
           where g.store_id = s.id and (g.published or p_preview)
             and ((p_kind = 'policy' and g.kind = 'policy' and g.policy = p_slug) or (p_kind = 'page' and g.kind = 'page' and g.slug = p_slug)));
end $$;

do $$
declare f text;
begin
  foreach f in array array['public.sf_menu_visible(uuid, jsonb, boolean)', 'public.sf_store(uuid, boolean)',
                           'public.sf_page(uuid, text, text, boolean)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
