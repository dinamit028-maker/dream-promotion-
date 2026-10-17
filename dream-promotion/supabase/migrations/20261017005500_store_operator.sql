-- ============================================================================================================================
-- Migration 20261017005500 — the company that runs the site (2.103.0).
-- Prepared only: NOT applied to the live database (needs the owner's explicit approval; the SQL Editor). Runs after 20261006003800
-- (the store with its menus): it stops at the top without it, changing nothing. Additions only and idempotent: no drop and no
-- delete statement.
-- Until now the line at the bottom of every page of the site (and the Organization that search engines read) showed the business's
-- details for its documents — register_settings: its legal name, its ע.מ. / ח.פ. and address. A store may now name the company
-- that runs the site instead (FollowMe: an American company, while the shop's invoices stay those of the Israeli one):
--   stores        + legal_name (the company's name; '' = as before: the business's details), legal_number (shown only when
--                   filled), legal_number_kind ('company' ח.פ. / 'dealer' ע.מ. / 'ein' EIN), legal_address, legal_country (two
--                   letters, '' = the store's country). The documents, the register and the checkout's readiness still read
--                   register_settings only — nothing here changes what is issued, or by whom.
--   sf_store      'legal' = the store's company when legal_name is filled — all of it, never mixed with the business's number —
--                   else the business's details as before; + 'country' (the company's, else the store's).
-- It replaces sf_store (3800's) with the same signature: running 20261006003800 again after it brings the old text back — then
-- run this one again. Tested on a local Postgres: tests/sql/store-operator.check.sql.
-- The rollback is at the end.
-- ============================================================================================================================

-- ---- 0. after 20261006003800 -------------------------------------------------------------------------------------------------
do $$ begin
  if to_regprocedure('public.sf_menu_visible(uuid, jsonb, boolean)') is null then
    raise exception 'migration 20261017005500 runs after 20261006003800 (the store with its menus) — run it first; nothing was changed';
  end if;
end $$;

-- ---- 1. the company that runs the site -----------------------------------------------------------------------------------------
alter table public.stores add column if not exists legal_name        text not null default '';
alter table public.stores add column if not exists legal_number      text not null default '';
alter table public.stores add column if not exists legal_number_kind text not null default '';
alter table public.stores add column if not exists legal_address     text not null default '';
alter table public.stores add column if not exists legal_country     text not null default '';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'stores_legal_check' and conrelid = 'public.stores'::regclass) then
    alter table public.stores add constraint stores_legal_check check (
      char_length(legal_name) <= 120 and char_length(legal_address) <= 200
      and legal_number ~ '^[0-9][0-9 -]{0,18}[0-9]$|^$'
      and legal_number_kind in ('', 'company', 'dealer', 'ein')
      and legal_country ~ '^([A-Z]{2})?$'
      -- a number belongs to a company, with its kind
      and (legal_number = '' or (btrim(legal_name) <> '' and legal_number_kind <> '')));
  end if;
end $$;

-- ---- 2. the store, with the company that runs it (the rest is migration 3800's, unchanged) -----------------------------------
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
    'slug', s.slug, 'access', acc);
end $$;
revoke execute on function public.sf_store(uuid, boolean) from public, anon, authenticated;
grant execute on function public.sf_store(uuid, boolean) to service_role;

-- ---- rollback (by hand, only to undo it) -------------------------------------------------------------------------------------
--   run 20261006003800's sf_store again (the site shows the business's details again);
--   alter table public.stores drop constraint if exists stores_legal_check;
--   (the five columns can stay — empty, nothing reads them without the function)
