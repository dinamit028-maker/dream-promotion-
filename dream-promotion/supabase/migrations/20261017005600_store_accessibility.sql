-- ============================================================================================================================
-- Migration 20261017005600 — the accessibility menu of every site (2.104.0).
-- Prepared only: NOT applied to the live database (needs the owner's explicit approval; the SQL Editor). Runs after 20261017005500
-- (the company that runs the site): it stops at the top without it, changing nothing. Additions only and idempotent: no drop and
-- no delete statement.
-- Every site shows an accessibility button (the storefront's own code — no plugin, nothing sent anywhere). The owner may turn it
-- off for the store:
--   stores        + a11y_widget (true = the button is shown — every store, from the start; false = the owner turned it off).
--   sf_store      + 'a11y_widget'. The rest is 5500's, unchanged. Before it runs, the storefront shows the button in every store.
-- It replaces sf_store (5500's) with the same signature: running 20261017005500 again after it brings the old text back — then
-- run this one again. Tested on a local Postgres: tests/sql/store-accessibility.check.sql.
-- The rollback is at the end.
-- ============================================================================================================================

-- ---- 0. after 20261017005500 -------------------------------------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'stores' and column_name = 'legal_country') then
    raise exception 'migration 20261017005600 runs after 20261017005500 (the company that runs the site) — run it first; nothing was changed';
  end if;
end $$;

-- ---- 1. the button, on or off --------------------------------------------------------------------------------------------------
alter table public.stores add column if not exists a11y_widget boolean not null default true;

-- ---- 2. the store, with its button (the rest is migration 5500's, unchanged) ---------------------------------------------------
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
    'legal', case when btrim(s.legal_name) <> '' then jsonb_build_object(
      'name', btrim(s.legal_name),
      'number', s.legal_number,
      'number_kind', case when s.legal_number = '' then '' else s.legal_number_kind end,
      'address', btrim(s.legal_address),
      'country', coalesce(nullif(s.legal_country, ''), s.country))
    else jsonb_build_object(
      'name', coalesce(nullif(btrim(r.legal_name), ''), s.name),
      'number', case when coalesce(r.entity_type, '') = 'company' and coalesce(r.company_number, '') <> '' then r.company_number
                     else coalesce(nullif(r.dealer_number, ''), nullif(r.company_number, ''), '') end,
      'number_kind', case when coalesce(r.entity_type, '') = 'company' or (coalesce(r.dealer_number, '') = '' and coalesce(r.company_number, '') <> '') then 'company' else 'dealer' end,
      'address', btrim(concat_ws(', ', nullif(btrim(concat_ws(' ', nullif(r.street, ''), nullif(r.house_no, ''))), ''), nullif(r.city, ''))),
      'country', s.country) end,
    'menus', jsonb_build_object(
      'main',   public.sf_menu_visible(s.id, (select m.items from public.store_menus m where m.store_id = s.id and m.kind = 'main'), p_preview),
      'footer', public.sf_menu_visible(s.id, (select m.items from public.store_menus m where m.store_id = s.id and m.kind = 'footer'), p_preview)),
    'policies', coalesce((select jsonb_agg(jsonb_build_object('policy', g.policy, 'title', g.title) order by g.policy)
                            from public.store_pages g where g.store_id = s.id and g.kind = 'policy' and g.published), '[]'::jsonb),
    'collections', coalesce((select jsonb_agg(jsonb_build_object('slug', c.slug, 'title', c.title, 'image_url', c.image_url) order by c.position, c.title)
                               from public.catalog_collections c where c.business_id = s.business_id and c.publish_online), '[]'::jsonb),
    'can_buy', public.sf_can_buy(s),
    'a11y_widget', s.a11y_widget,
    'slug', s.slug, 'access', acc);
end $$;
revoke execute on function public.sf_store(uuid, boolean) from public, anon, authenticated;
grant execute on function public.sf_store(uuid, boolean) to service_role;

-- ---- rollback (by hand, only to undo it) -------------------------------------------------------------------------------------
--   run 20261017005500's sf_store again (the storefront then shows the button in every store, as before this migration);
--   (the column can stay — nothing reads it without the function)
