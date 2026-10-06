-- ============================================================================================================================
-- Migration 20261006003700 — every store gets its own address, and a password (2.57.1)
-- Additive: new columns on stores, new functions; functions that change keep their signature (create or replace):
-- store_missing (an address that works: the subdomain or an own domain) and sf_store (the store's slug and its access).
--   1. slug       stores.slug: the store's address <slug>.<STORE_ROOT_DOMAIN> (the root is the storefront's env, never in the
--                 database). Made from the business's name when the store opens (Hebrew letters transliterated), editable,
--                 unique in the whole system, 3–40 of a–z, 0–9 and single hyphens, never a reserved name (www, app, admin…)
--                 and never xn-- (punycode). store_slug_reserved() holds the list; tests/store-subdomain.test.ts compares it
--                 with the dashboard's (store.ts RESERVED_SLUGS).
--   2. password   stores.storefront_password (shown to the owner, to copy — like Shopify's store password, not an account's)
--                 and stores.password_lock (a published store the owner chose to close). A store before publishing, or a
--                 locked one, opens to whoever has the link and the password; everyone else sees "בקרוב". The storefront
--                 never reads the password: it gets a key (sha-256 of the store and the password) to sign its cookie with,
--                 and asks sf_store_unlock whether a typed password is right. A new password signs everyone out.
--   3. the subdomain is "active" only when the storefront served it (sf_slug_seen), as a domain is (sf_domain_seen); either
--                 one completes "a working address" in the checklist (store_missing).
-- No statement here removes rows, so the MCP applies the whole file.
-- Tested on a local Postgres 16: tests/sql/store-subdomain.check.sql and the storefront's browser tests.
-- Applied to the live database only after explicit approval.
-- ============================================================================================================================

-- ---- 1. the columns --------------------------------------------------------------------------------------------------------
alter table public.stores add column if not exists slug                text;
alter table public.stores add column if not exists storefront_password text not null default '';
alter table public.stores add column if not exists password_lock       boolean not null default false;
alter table public.stores add column if not exists subdomain_seen_at   timestamptz;
create unique index if not exists stores_slug_uq on public.stores (slug);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'stores_slug_check' and conrelid = 'public.stores'::regclass) then
    alter table public.stores add constraint stores_slug_check
      check (slug is null or (length(slug) between 3 and 40 and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'stores_password_check' and conrelid = 'public.stores'::regclass) then
    alter table public.stores add constraint stores_password_check
      check (storefront_password = '' or length(storefront_password) between 4 and 40);
  end if;
end $$;

-- ---- 2. the rules ------------------------------------------------------------------------------------------------------------
-- names that are never a store: the platform's own addresses, mail, and words a shopper would trust
create or replace function public.store_slug_reserved(p_slug text) returns boolean
language sql immutable parallel safe set search_path = public as $$
  select p_slug like 'xn--%' or p_slug = any (array[
    -- reserved slugs: begin
    'www', 'app', 'apps', 'admin', 'administrator', 'api', 'mail', 'email', 'smtp', 'imap', 'pop', 'mx', 'ftp', 'ns1', 'ns2', 'dns',
    'shop', 'shops', 'store', 'stores', 'my', 'dashboard', 'login', 'logout', 'signin', 'signup', 'auth', 'account', 'accounts',
    'billing', 'pay', 'payment', 'payments', 'checkout', 'cart', 'orders', 'help', 'support', 'status', 'docs', 'blog', 'news',
    'cdn', 'static', 'assets', 'media', 'img', 'images', 'files', 'download', 'downloads', 'preview', 'staging', 'dev', 'test',
    'beta', 'demo', 'secure', 'security', 'root', 'system', 'internal', 'webmail', 'portal', 'dream', 'platform', 'official'
    -- reserved slugs: end
  ])
$$;

-- a business's name → an address: Hebrew letters transliterated, anything else becomes a hyphen; at least "store"
create or replace function public.store_slug_base(p_name text) returns text
language sql immutable parallel safe set search_path = public as $$
  select case when length(x) >= 3 then x else 'store' || case when x <> '' then '-' || x else '' end end
    from (select left(btrim(regexp_replace(regexp_replace(lower(translate(coalesce(p_name, ''),
                   'אבגדהוזחטיכךלמםנןסעפףצץקרשת', 'abgdhvzhtykklmmnnsapfzzkrst')), '[^a-z0-9]+', '-', 'g'), '-+', '-', 'g'), '-'), 34) as x) y
$$;

-- the first free address for a store: base, base-2, base-3… (never reserved, never another store's)
create or replace function public.store_slug_free(p_base text, p_store uuid) returns text
language plpgsql stable security definer set search_path = public as $$
declare b text := btrim(left(coalesce(nullif(p_base, ''), 'store'), 34), '-'); c text; n int := 1;
begin
  if length(b) < 3 then b := 'store'; end if;
  c := b;
  while public.store_slug_reserved(c) or exists (select 1 from public.stores s where s.slug = c and s.id is distinct from p_store) loop
    n := n + 1;
    c := b || '-' || n;
  end loop;
  return c;
end $$;
revoke execute on function public.store_slug_free(text, uuid) from public, anon, authenticated;

-- a new store's password: 10 letters and digits (shown to the owner, who sends it to whoever should see the store)
create or replace function public.store_password_new() returns text
language sql volatile set search_path = public as $$
  select translate(left(replace(gen_random_uuid()::text, '-', ''), 10), '0o1l', '2k3m')
$$;
revoke execute on function public.store_password_new() from public, anon, authenticated;

-- the address is checked and kept clean; a new store gets an address and a password; a new address is "seen" again. Definer:
-- it looks at every store's address (to find a free one), and says nothing about them but "taken" (the unique index)
create or replace function public.stores_slug_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare biz text;
begin
  if tg_op = 'INSERT' and coalesce(new.slug, '') = '' then
    select b.name into biz from public.businesses b where b.id = new.business_id;
    new.slug := public.store_slug_free(public.store_slug_base(coalesce(nullif(btrim(biz), ''), new.name)), new.id);
  end if;
  if tg_op = 'INSERT' and new.storefront_password = '' then new.storefront_password := public.store_password_new(); end if;
  new.slug := lower(btrim(new.slug));
  if tg_op = 'UPDATE' and new.slug is distinct from old.slug then
    if new.slug is null or length(new.slug) not between 3 and 40 or new.slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
      raise exception 'store_slug_invalid' using errcode = '23514';
    end if;
    new.subdomain_seen_at := null;
  end if;
  if public.store_slug_reserved(new.slug) then raise exception 'store_slug_reserved' using errcode = '23514'; end if;
  new.storefront_password := btrim(new.storefront_password);
  if new.password_lock and new.storefront_password = '' then raise exception 'store_lock_needs_password' using errcode = '23514'; end if;
  return new;
end $$;
revoke execute on function public.stores_slug_guard() from public, anon, authenticated;
create or replace trigger b_stores_slug before insert or update on public.stores for each row execute function public.stores_slug_guard();

-- the stores that are open already: an address from the business's name, and a password
-- one at a time, so two stores of the same name get two addresses
do $$
declare r record;
begin
  for r in select s.id, coalesce(nullif(btrim(b.name), ''), s.name) as base from public.stores s
             left join public.businesses b on b.id = s.business_id where s.slug is null order by s.created_at, s.id loop
    update public.stores set slug = public.store_slug_free(public.store_slug_base(r.base), r.id),
           storefront_password = case when storefront_password = '' then public.store_password_new() else storefront_password end
     where id = r.id;
  end loop;
end $$;
alter table public.stores alter column slug set not null;

-- who may see the store now: 'public' (on the air), 'password' (before publishing or locked, with a password), 'closed'
create or replace function public.store_access(s public.stores) returns text
language sql stable set search_path = public as $$
  select case when s.status = 'published' and not s.password_lock then 'public'
              when s.storefront_password <> '' then 'password' else 'closed' end
$$;
revoke execute on function public.store_access(public.stores) from public, anon, authenticated;
-- the key the storefront signs its cookie with: changes with the password (a new password signs everyone out)
create or replace function public.store_access_key(s public.stores) returns text
language sql stable set search_path = public as $$
  select case when s.storefront_password = '' then null
              else encode(sha256(convert_to('store-access:' || s.id::text || ':' || s.storefront_password, 'UTF8')), 'hex') end
$$;
revoke execute on function public.store_access_key(public.stores) from public, anon, authenticated;

-- "a working address" in the checklist: the store's own domain, or its subdomain, served by the storefront
create or replace function public.store_missing(s public.stores) returns text[]
language plpgsql stable security definer set search_path = public as $$
declare r public.register_settings; out text[] := '{}';
begin
  select * into r from public.register_settings where business_id = s.business_id;
  if r.business_id is null or btrim(coalesce(r.legal_name, '')) = '' or btrim(coalesce(r.city, '')) = ''
     or not (coalesce(r.dealer_number, '') ~ '^[0-9]{9}$' or coalesce(r.company_number, '') ~ '^[0-9]{9}$') then
    out := array_append(out, 'legal');
  end if;
  if s.phone = '' and s.email = '' and s.whatsapp = '' then out := array_append(out, 'contact'); end if;
  if not exists (select 1 from public.store_pages g where g.store_id = s.id and g.policy = 'returns' and g.published) then out := array_append(out, 'returns'); end if;
  if not exists (select 1 from public.store_pages g where g.store_id = s.id and g.policy = 'privacy' and g.published) then out := array_append(out, 'privacy'); end if;
  if not exists (select 1 from public.store_pages g where g.store_id = s.id and g.policy = 'accessibility' and g.published) then out := array_append(out, 'accessibility'); end if;
  if s.subdomain_seen_at is null
     and not exists (select 1 from public.store_domains d where d.store_id = s.id and d.is_primary and d.status = 'active') then
    out := array_append(out, 'domain');
  end if;
  if not exists (select 1 from public.catalog_items i where i.business_id = s.business_id and i.publish_online and i.active and i.slug is not null) then
    out := array_append(out, 'product');
  end if;
  return out;
end $$;
revoke execute on function public.store_missing(public.stores) from public, anon, authenticated;

-- ---- 3. the storefront ---------------------------------------------------------------------------------------------------------
-- which store is <slug>.<root>: {store, status, primary, primary_domain}. primary_domain = its own domain only once that works
-- (the storefront served it): then the subdomain is not the primary address, and redirects there.
create or replace function public.sf_resolve_slug(p_slug text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('store', s.id, 'status', s.status, 'primary', p.domain is null, 'primary_domain', p.domain)
    from public.stores s
    left join public.store_domains p on p.store_id = s.id and p.is_primary and p.status = 'active'
   where s.slug = lower(btrim(coalesce(p_slug, '')))
$$;

-- the storefront served <slug>.<root>: the wildcard's DNS and certificate work
create or replace function public.sf_slug_seen(p_slug text) returns void
language sql security definer set search_path = public as $$
  update public.stores set subdomain_seen_at = now()
   where slug = lower(btrim(coalesce(p_slug, ''))) and (subdomain_seen_at is null or subdomain_seen_at < now() - interval '1 hour')
$$;

-- a password typed on the "בקרוב" page: the key to sign the cookie with when it is right, else null
create or replace function public.sf_store_unlock(p_store uuid, p_password text) returns text
language sql stable security definer set search_path = public as $$
  select public.store_access_key(s) from public.stores s
   where s.id = p_store and public.store_access(s) = 'password' and s.storefront_password = btrim(coalesce(p_password, ''))
$$;

-- the store (3400, 3500) + its address and who may see it ('access': public / password / closed, and the cookie's key)
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
      'main',   coalesce((select m.items from public.store_menus m where m.store_id = s.id and m.kind = 'main'), '[]'::jsonb),
      'footer', coalesce((select m.items from public.store_menus m where m.store_id = s.id and m.kind = 'footer'), '[]'::jsonb)),
    'policies', coalesce((select jsonb_agg(jsonb_build_object('policy', g.policy, 'title', g.title) order by g.policy)
                            from public.store_pages g where g.store_id = s.id and g.kind = 'policy' and g.published), '[]'::jsonb),
    'collections', coalesce((select jsonb_agg(jsonb_build_object('slug', c.slug, 'title', c.title, 'image_url', c.image_url) order by c.position, c.title)
                               from public.catalog_collections c where c.business_id = s.business_id and c.publish_online), '[]'::jsonb),
    'can_buy', public.sf_can_buy(s),
    'slug', s.slug, 'access', acc);
end $$;

-- the dashboard: is an address free (the store worked in now may keep its own) — the screen says so before saving
create or replace function public.store_slug_available(p_slug text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare c text := lower(btrim(coalesce(p_slug, ''))); mine uuid;
begin
  if public.current_business_id() is null or public.current_business_id() not in (select public.accessible_business_ids())
     or public.my_access() = 'register' then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select id into mine from public.stores where business_id = public.current_business_id();
  if length(c) not between 3 and 40 or c !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then return jsonb_build_object('ok', false, 'error', 'invalid'); end if;
  if public.store_slug_reserved(c) then return jsonb_build_object('ok', false, 'error', 'reserved'); end if;
  if exists (select 1 from public.stores s where s.slug = c and s.id is distinct from mine) then
    return jsonb_build_object('ok', false, 'error', 'taken', 'suggestion', public.store_slug_free(c, mine));
  end if;
  return jsonb_build_object('ok', true);
end $$;

do $$
declare f text;
begin
  foreach f in array array['public.sf_resolve_slug(text)', 'public.sf_slug_seen(text)', 'public.sf_store_unlock(uuid, text)',
                           'public.sf_store(uuid, boolean)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  revoke execute on function public.store_slug_available(text) from public, anon;
  grant execute on function public.store_slug_available(text) to authenticated;
end $$;
