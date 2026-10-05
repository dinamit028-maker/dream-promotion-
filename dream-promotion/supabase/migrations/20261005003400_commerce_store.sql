-- ============================================================================================================================
-- Migration 20261005003400 — Dream Commerce stage 2: the store and its storefront, view only (2.55.0)
-- Additive: no existing table, column, policy or row changes (catalog_items gets an index and a trigger that leaves 301s).
--   1. tables       stores (one per business), store_domains (a domain belongs to one store, in the whole system),
--                   store_theme_versions (the template's settings: one draft, one published, the archive), store_pages
--                   (content and policy pages), store_menus (main / footer), catalog_collections + catalog_collection_items,
--                   store_redirects (301)
--   2. rules        a store is published only with its checklist complete (the business's legal details, a way to reach
--                   it, returns / privacy / accessibility pages, an active domain, a product on the site); a published theme
--                   version never changes; a domain is "active" only after the storefront really served it
--   3. 301          a product / collection / page that was on the site and changes its address leaves a redirect (no chains)
--   4. RLS          the 3100 pattern + the viewer (3200) + _cashier_none: a cashier has nothing to do with the store
--   5. storefront   sf_* — the storefront's only way into the database: service_role only; the store is the one its server
--                   found by the Host (or by a signed preview token); only what is published, through an allow-list of fields
-- The prices follow catalog.ts (onlinePriceOf): the variant's online price → the item's online price → the variant's register
-- price → the item's. VAT, stock movements and documents are not touched: the storefront of this stage sells nothing.
-- Tested on a local Postgres 16: tests/sql/commerce-store.check.sql (with every existing check) and the storefront's browser
-- tests, which call these same functions. Applied to the live database only after the owner's explicit approval.
-- ============================================================================================================================

-- ---- 1. the tables --------------------------------------------------------------------------------------------------------
create table if not exists public.stores (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid references auth.users on delete set null default auth.uid(),   -- who opened it (fills business_id)
  business_id      uuid references public.businesses on delete restrict,
  name             text not null check (length(name) between 1 and 80),
  status           text not null default 'draft' check (status in ('draft', 'published', 'paused')),
  template         text not null default 'bags' check (template ~ '^[a-z][a-z0-9-]{1,30}$'),
  lang             text not null default 'he' check (lang in ('he', 'en')),
  currency         text not null default 'ILS' check (currency ~ '^[A-Z]{3}$'),
  country          text not null default 'IL' check (country ~ '^[A-Z]{2}$'),
  logo_url         text not null default '' check (logo_url = '' or (logo_url ~ '^https://' and length(logo_url) <= 500)),
  description      text not null default '' check (length(description) <= 320),       -- the home page's description (SEO)
  phone            text not null default '' check (phone = '' or phone ~ '^[0-9+() -]{7,20}$'),
  whatsapp         text not null default '' check (whatsapp = '' or whatsapp ~ '^[0-9]{9,15}$'),   -- international digits: 9725…
  email            text not null default '' check (email = '' or (length(email) <= 120 and email ~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$')),
  address          text not null default '' check (length(address) <= 200),
  ga4_id           text not null default '' check (ga4_id = '' or ga4_id ~ '^G-[A-Z0-9]{4,16}$'),
  gsc_code         text not null default '' check (gsc_code = '' or gsc_code ~ '^[A-Za-z0-9_-]{10,100}$'),   -- Search Console's meta code
  show_stock_count boolean not null default false,                                      -- "נשארו X" instead of "במלאי"
  published_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index if not exists stores_business_uq on public.stores (business_id);
create or replace trigger a_fill_business_id before insert on public.stores for each row execute function public.fill_business_id();
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'stores_business_required') then
    alter table public.stores add constraint stores_business_required check (business_id is not null);
  end if;
end $$;

-- a domain, lower case (an IDN in punycode), is one store's in the whole system; www and the bare name are two rows, one primary
create table if not exists public.store_domains (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses on delete restrict,
  store_id        uuid not null references public.stores on delete cascade,
  domain          text not null check (length(domain) between 4 and 253
                                       and domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?[.])+[a-z]([a-z0-9-]{0,61}[a-z0-9])$'),
  is_primary      boolean not null default false,
  status          text not null default 'pending' check (status in ('pending', 'verifying', 'active', 'error')),
  vercel          jsonb not null default '{}' check (jsonb_typeof(vercel) = 'object'),  -- Vercel's last answer (the records to show)
  last_checked_at timestamptz,
  last_seen_at    timestamptz,                                                        -- the storefront served it (DNS + TLS work)
  created_by      uuid references auth.users on delete set null default auth.uid(),
  created_at      timestamptz not null default now()
);
create unique index if not exists store_domains_domain_uq  on public.store_domains (domain);
create unique index if not exists store_domains_primary_uq on public.store_domains (store_id) where is_primary;
create index if not exists store_domains_business_idx on public.store_domains (business_id);

-- the template's settings: edited as the one draft, shown as the one published version; an old version is published again
create table if not exists public.store_theme_versions (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses on delete restrict,
  store_id     uuid not null references public.stores on delete cascade,
  version      int  not null default 0,
  status       text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  template     text not null check (template ~ '^[a-z][a-z0-9-]{1,30}$'),
  settings     jsonb not null default '{}' check (jsonb_typeof(settings) = 'object' and octet_length(settings::text) <= 200000),
  note         text not null default '' check (length(note) <= 200),
  created_by   uuid references auth.users on delete set null default auth.uid(),
  created_at   timestamptz not null default now(),
  published_at timestamptz,
  unique (store_id, version)
);
create unique index if not exists store_theme_versions_draft_uq     on public.store_theme_versions (store_id) where status = 'draft';
create unique index if not exists store_theme_versions_published_uq on public.store_theme_versions (store_id) where status = 'published';
create index if not exists store_theme_versions_business_idx on public.store_theme_versions (business_id);

create table if not exists public.store_pages (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses on delete restrict,
  store_id        uuid not null references public.stores on delete cascade,
  kind            text not null default 'page' check (kind in ('page', 'policy')),
  policy          text check (policy in ('returns', 'privacy', 'accessibility', 'terms', 'shipping')),
  slug            text not null check (length(slug) between 1 and 80 and slug ~ '^[a-z0-9א-ת]+(-[a-z0-9א-ת]+)*$'),
  title           text not null check (length(title) between 1 and 120),
  body            text not null default '' check (length(body) <= 30000),            -- plain text: paragraphs, "## " titles, "- " lists
  seo_title       text not null default '' check (length(seo_title) <= 120),
  seo_description text not null default '' check (length(seo_description) <= 320),
  published       boolean not null default false,
  published_at    timestamptz,
  created_by      uuid references auth.users on delete set null default auth.uid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check ((kind = 'policy') = (policy is not null)),
  unique (store_id, slug)
);
create unique index if not exists store_pages_policy_uq on public.store_pages (store_id, policy) where policy is not null;
create index if not exists store_pages_business_idx on public.store_pages (business_id);

-- a menu's links: a label and either a path of the store or an https address — nothing else
create or replace function public.store_links_ok(p jsonb) returns boolean language sql immutable set search_path = public as $$
  select jsonb_typeof(p) = 'array' and jsonb_array_length(p) <= 30 and not exists (
    select 1 from jsonb_array_elements(p) e
     where jsonb_typeof(e) <> 'object'
        or length(coalesce(e->>'label', '')) not between 1 and 40
        or length(coalesce(e->>'href', '')) not between 1 and 300
        or not (coalesce(e->>'href', '') ~ '^/([^/[:space:]<>"''\\][^[:space:]<>"''\\]*)?$'
                or coalesce(e->>'href', '') ~ '^https://[^[:space:]<>"''\\]+$'))
$$;
revoke execute on function public.store_links_ok(jsonb) from public, anon;

create table if not exists public.store_menus (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses on delete restrict,
  store_id    uuid not null references public.stores on delete cascade,
  kind        text not null check (kind in ('main', 'footer')),
  items       jsonb not null default '[]' check (public.store_links_ok(items)),
  updated_at  timestamptz not null default now(),
  unique (store_id, kind)
);
create index if not exists store_menus_business_idx on public.store_menus (business_id);

-- a collection: hand-picked products (manual) or every product with one of its tags (auto)
create table if not exists public.catalog_collections (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references auth.users on delete set null default auth.uid(),
  business_id     uuid references public.businesses on delete restrict,
  title           text not null check (length(title) between 1 and 80),
  slug            text not null check (length(slug) between 1 and 80 and slug ~ '^[a-z0-9א-ת]+(-[a-z0-9א-ת]+)*$' and slug <> 'all'),
  description     text not null default '' check (length(description) <= 2000),
  image_url       text not null default '' check (image_url = '' or (image_url ~ '^https://' and length(image_url) <= 500)),
  kind            text not null default 'manual' check (kind in ('manual', 'auto')),
  rules           jsonb not null default '{}' check (jsonb_typeof(rules) = 'object'),   -- auto: {"tags": ["נייר", …]}
  sort            text not null default 'manual' check (sort in ('manual', 'newest', 'price_asc', 'price_desc', 'name')),
  publish_online  boolean not null default false,
  seo_title       text not null default '' check (length(seo_title) <= 120),
  seo_description text not null default '' check (length(seo_description) <= 320),
  position        int  not null default 0,
  published_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists catalog_collections_slug_uq on public.catalog_collections (business_id, slug);
create or replace trigger a_fill_business_id before insert on public.catalog_collections for each row execute function public.fill_business_id();
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'catalog_collections_business_required') then
    alter table public.catalog_collections add constraint catalog_collections_business_required check (business_id is not null);
  end if;
end $$;

create table if not exists public.catalog_collection_items (
  collection_id uuid not null references public.catalog_collections on delete cascade,
  item_id       uuid not null references public.catalog_items on delete cascade,
  business_id   uuid not null references public.businesses on delete restrict,
  position      int  not null default 0,
  primary key (collection_id, item_id)
);
create index if not exists catalog_collection_items_item_idx     on public.catalog_collection_items (item_id);
create index if not exists catalog_collection_items_business_idx on public.catalog_collection_items (business_id);

create table if not exists public.store_redirects (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses on delete restrict,
  store_id    uuid not null references public.stores on delete cascade,
  from_path   text not null check (length(from_path) between 2 and 300 and from_path ~ '^/[^/[:space:]<>"''\\][^[:space:]<>"''\\]*$'),
  to_path     text not null check (length(to_path) between 1 and 300 and to_path ~ '^/([^/[:space:]<>"''\\][^[:space:]<>"''\\]*)?$'),
  auto        boolean not null default false,                                       -- left by an address change, not by hand
  created_by  uuid references auth.users on delete set null default auth.uid(),
  created_at  timestamptz not null default now(),
  check (from_path <> to_path),
  unique (store_id, from_path)
);
create index if not exists store_redirects_business_idx on public.store_redirects (business_id);

-- the storefront lists what is on the site
create index if not exists catalog_items_online_idx on public.catalog_items (business_id) where publish_online;

-- ---- 2. the rules ---------------------------------------------------------------------------------------------------------
-- a row of the store belongs to the business of its store, and stays with it. Invoker: an app user sees only the store of the
-- business they work in, so nothing can be attached to another business's store.
create or replace function public.store_fill_from_store() returns trigger
language plpgsql set search_path = public as $$
declare b uuid;
begin
  if tg_op = 'UPDATE' then
    if new.store_id is distinct from old.store_id then raise exception 'a row stays with its store' using errcode = '23514'; end if;
    new.business_id := old.business_id;
  else
    select business_id into b from public.stores where id = new.store_id;
    if b is null then raise exception 'store not found' using errcode = '23503'; end if;
    new.business_id := b;
  end if;
  return new;
end $$;
revoke execute on function public.store_fill_from_store() from public, anon, authenticated;
create or replace trigger a_fill_from_store before insert or update on public.store_domains        for each row execute function public.store_fill_from_store();
create or replace trigger a_fill_from_store before insert or update on public.store_theme_versions for each row execute function public.store_fill_from_store();
create or replace trigger a_fill_from_store before insert or update on public.store_pages          for each row execute function public.store_fill_from_store();
create or replace trigger a_fill_from_store before insert or update on public.store_menus          for each row execute function public.store_fill_from_store();
create or replace trigger a_fill_from_store before insert or update on public.store_redirects      for each row execute function public.store_fill_from_store();

-- a product in a collection: of the collection's business only (invoker — RLS shows only the current business's items)
create or replace function public.catalog_collection_items_fill() returns trigger
language plpgsql set search_path = public as $$
declare b uuid;
begin
  if tg_op = 'UPDATE' and (new.collection_id is distinct from old.collection_id or new.item_id is distinct from old.item_id) then
    raise exception 'move a product by removing and adding it' using errcode = '23514';
  end if;
  select business_id into b from public.catalog_collections where id = new.collection_id;
  if b is null then raise exception 'collection not found' using errcode = '23503'; end if;
  if not exists (select 1 from public.catalog_items i where i.id = new.item_id and i.business_id = b) then
    raise exception 'the product is not of this business' using errcode = '23514';
  end if;
  new.business_id := b;
  return new;
end $$;
revoke execute on function public.catalog_collection_items_fill() from public, anon, authenticated;
create or replace trigger a_fill_from_collection before insert or update on public.catalog_collection_items
  for each row execute function public.catalog_collection_items_fill();

-- edits stamp updated_at; the first publishing stamps published_at (it stays: "was on the site" for the 301s)
create or replace function public.store_touch() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' then new.updated_at := now(); end if;
  -- one branch per table: PL/pgSQL resolves a field of NEW even behind a false "and"
  if tg_table_name = 'catalog_collections' then
    if tg_op = 'UPDATE' then new.business_id := old.business_id; end if;
    if new.publish_online and new.published_at is null then new.published_at := now(); end if;
  elsif tg_table_name = 'store_pages' then
    if new.published and new.published_at is null then new.published_at := now(); end if;
  end if;
  return new;
end $$;
revoke execute on function public.store_touch() from public, anon, authenticated;
create or replace trigger b_store_touch before insert or update on public.catalog_collections for each row execute function public.store_touch();
create or replace trigger b_store_touch before insert or update on public.store_pages         for each row execute function public.store_touch();
create or replace trigger b_store_touch before update on public.store_menus                   for each row execute function public.store_touch();

-- what a store still needs before it goes on the air (the checklist of DREAM_COMMERCE_ARCHITECTURE §7.7). The legal details
-- are the ones of the documents (register_settings) — what the law requires on a distance sale is NEEDS_LEGAL_VERIFICATION.
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
  if not exists (select 1 from public.store_domains d where d.store_id = s.id and d.is_primary and d.status = 'active') then out := array_append(out, 'domain'); end if;
  if not exists (select 1 from public.catalog_items i where i.business_id = s.business_id and i.publish_online and i.active and i.slug is not null) then
    out := array_append(out, 'product');
  end if;
  return out;
end $$;
revoke execute on function public.store_missing(public.stores) from public, anon, authenticated;

-- a store goes on the air only with its checklist complete; it stays with its business
create or replace function public.stores_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare missing text[];
begin
  if tg_op = 'UPDATE' then
    new.business_id := old.business_id;
    new.updated_at := now();
    new.published_at := old.published_at;
  else
    new.published_at := null;
  end if;
  if new.status = 'published' and (tg_op = 'INSERT' or old.status is distinct from 'published') then
    missing := public.store_missing(new);
    if cardinality(missing) > 0 then
      raise exception 'store_not_ready: %', array_to_string(missing, ',') using errcode = '23514';
    end if;
    new.published_at := now();
  end if;
  return new;
end $$;
revoke execute on function public.stores_guard() from public, anon, authenticated;
create or replace trigger b_stores_guard before insert or update on public.stores for each row execute function public.stores_guard();

-- the checklist, for the screen: the store of the business the caller works in, not for a cashier
create or replace function public.store_checklist(p_store uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s public.stores; missing text[];
begin
  select * into s from public.stores where id = p_store;
  if s.id is null or s.business_id is distinct from public.current_business_id()
     or s.business_id not in (select public.accessible_business_ids()) or public.my_access() = 'register' then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  missing := public.store_missing(s);
  return jsonb_build_object('ready', cardinality(missing) = 0, 'missing', to_jsonb(missing));
end $$;
revoke execute on function public.store_checklist(uuid) from public, anon;
grant execute on function public.store_checklist(uuid) to authenticated;

-- theme versions: numbered per store; only the draft is edited; a published or archived version never changes its settings;
-- the published one is never deleted
create or replace function public.store_theme_versions_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform 1 from public.stores where id = new.store_id for update;
    new.version := coalesce((select max(v.version) from public.store_theme_versions v where v.store_id = new.store_id), 0) + 1;
    if new.status <> 'draft' then raise exception 'a new version is a draft' using errcode = '23514'; end if;
    new.published_at := null;
    return new;
  elsif tg_op = 'UPDATE' then
    if new.version <> old.version or new.template <> old.template and old.status <> 'draft' then
      raise exception 'a version keeps its number and its template' using errcode = '23514';
    end if;
    if old.status <> 'draft' and (new.settings is distinct from old.settings or new.note is distinct from old.note) then
      raise exception 'only the draft is edited' using errcode = '23514';
    end if;
    if new.status = 'draft' and old.status <> 'draft' then raise exception 'a version never goes back to draft' using errcode = '23514'; end if;
    if new.status = 'published' and old.status <> 'published' then new.published_at := now(); end if;
    return new;
  else
    if old.status = 'published' then raise exception 'the published version is not deleted' using errcode = '23514'; end if;
    return old;
  end if;
end $$;
revoke execute on function public.store_theme_versions_guard() from public, anon, authenticated;
create or replace trigger b_store_theme_versions_guard before insert or update or delete on public.store_theme_versions
  for each row execute function public.store_theme_versions_guard();

-- "פרסום" of a version (a draft, or an old one: "חזרה לגרסה קודמת"): the published one is archived, in one transaction.
-- Invoker: row-level security decides who may (the store's writers).
create or replace function public.store_publish_theme(p_version uuid) returns void
language plpgsql set search_path = public as $$
declare st uuid; cur text;
begin
  select store_id, status into st, cur from public.store_theme_versions where id = p_version;
  if st is null then raise exception 'version not found' using errcode = '42501'; end if;
  if cur = 'published' then return; end if;
  update public.store_theme_versions set status = 'archived' where store_id = st and status = 'published';
  update public.store_theme_versions set status = 'published' where id = p_version;
  if not found then raise exception 'not allowed' using errcode = '42501'; end if;
end $$;
revoke execute on function public.store_publish_theme(uuid) from public, anon;
grant execute on function public.store_publish_theme(uuid) to authenticated;

-- ---- 3. 301: an address that was on the site keeps working ------------------------------------------------------------------
-- a product (it was published once: published_at), a collection or a content page that changes its slug leaves a redirect
-- from the old address; whatever pointed to the old address now points to the new one (no chains); an address that comes
-- back to life loses its redirect
create or replace function public.store_redirect_on_slug() returns trigger
language plpgsql security definer set search_path = public as $$
declare st uuid; base text; was_public boolean; old_path text; new_path text;
begin
  if new.slug is not distinct from old.slug or old.slug is null or new.slug is null then return null; end if;
  if tg_table_name = 'catalog_items' then
    base := '/products/'; was_public := old.published_at is not null;
  elsif tg_table_name = 'catalog_collections' then
    base := '/collections/'; was_public := old.published_at is not null;
  else
    if old.kind <> 'page' then return null; end if;
    base := '/pages/'; was_public := old.published_at is not null;
  end if;
  if not was_public then return null; end if;
  if tg_table_name = 'store_pages' then st := old.store_id;
  else select id into st from public.stores where business_id = old.business_id;
  end if;
  if st is null then return null; end if;
  old_path := base || old.slug; new_path := base || new.slug;
  delete from public.store_redirects where store_id = st and from_path = new_path;   -- first: else a chain could loop to itself
  update public.store_redirects set to_path = new_path where store_id = st and to_path = old_path;
  insert into public.store_redirects (business_id, store_id, from_path, to_path, auto, created_by)
  values (old.business_id, st, old_path, new_path, true, auth.uid())
  on conflict (store_id, from_path) do update set to_path = excluded.to_path, auto = true;
  return null;
end $$;
revoke execute on function public.store_redirect_on_slug() from public, anon, authenticated;
create or replace trigger z_store_redirect after update of slug on public.catalog_items       for each row execute function public.store_redirect_on_slug();
create or replace trigger z_store_redirect after update of slug on public.catalog_collections for each row execute function public.store_redirect_on_slug();
create or replace trigger z_store_redirect after update of slug on public.store_pages         for each row execute function public.store_redirect_on_slug();

-- ---- 4. row-level security (the 3100 pattern + the viewer of 3200 + no cashier) ------------------------------------------
do $$
declare
  t text; op text;
  gate        constant text := 'business_id = (select public.current_business_id()) and business_id in (select public.accessible_business_ids())';
  full_access constant text := '(select public.my_access()) <> ''register''';
  writer      constant text := '(select public.can_write())';
begin
  foreach t in array array['stores', 'store_domains', 'store_theme_versions', 'store_pages', 'store_menus', 'catalog_collections',
                           'catalog_collection_items', 'store_redirects'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate on public.%I from authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_business_gate') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)', t || '_business_gate', t, gate, gate);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_cashier_none') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)', t || '_cashier_none', t, full_access, full_access);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_business_read') then
      execute format('create policy %I on public.%I for select to authenticated using (%s)', t || '_business_read', t, gate);
    end if;
    foreach op in array array['insert', 'update', 'delete'] loop
      if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_business_' || op) then
        execute format('create policy %I on public.%I for %s to authenticated %s', t || '_business_' || op, t, op,
          case op when 'insert' then format('with check (%s)', gate) when 'update' then format('using (%s) with check (%s)', gate, gate) else format('using (%s)', gate) end);
      end if;
      if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_viewer_' || op) then
        execute format('create policy %I on public.%I as restrictive for %s to authenticated %s', t || '_viewer_' || op, t, op,
          case op when 'insert' then format('with check (%s)', writer) when 'update' then format('using (%s) with check (%s)', writer, writer) else format('using (%s)', writer) end);
      end if;
    end loop;
  end loop;
end $$;
-- a store is opened and edited, never deleted from a screen
grant insert, update on public.stores to authenticated;
-- a domain: the screen adds it, chooses the primary one, removes it; its status comes from the server (Vercel) and the storefront
grant insert (store_id, domain, is_primary) on public.store_domains to authenticated;
grant update (is_primary) on public.store_domains to authenticated;
grant delete on public.store_domains to authenticated;
grant insert, update, delete on public.store_theme_versions, public.store_pages, public.store_menus, public.catalog_collections,
  public.catalog_collection_items, public.store_redirects to authenticated;

-- ---- 5. the storefront's door: sf_* (service_role only) -------------------------------------------------------------------
-- a number from the storefront's query string, or null
create or replace function public.sf_num(p text) returns numeric language sql immutable set search_path = public as $$
  select case when p ~ '^[0-9]{1,9}([.][0-9]{1,2})?$' then p::numeric end
$$;
revoke execute on function public.sf_num(text) from public, anon, authenticated;

-- the store's price of an item, and whether it can be had: its active variants (cheapest / dearest), else the item itself
create or replace function public.sf_prices(i public.catalog_items) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare lo numeric; hi numeric; cmp numeric; avail boolean; n int;
begin
  if i.has_variants then
    select min(x.p), max(x.p), bool_or(x.ok), sum(x.q) into lo, hi, avail, n from (
      select coalesce(v.online_price, i.online_price, v.price, i.price) as p,
             (not i.track_stock or v.stock_qty > 0) as ok, greatest(v.stock_qty, 0) as q
        from public.catalog_variants v where v.item_id = i.id and v.active) x;
    select coalesce(v.compare_at_price, i.compare_at_price) into cmp from public.catalog_variants v
     where v.item_id = i.id and v.active
     order by coalesce(v.online_price, i.online_price, v.price, i.price), v.position, v.id limit 1;
  else
    lo := coalesce(i.online_price, i.price); hi := lo; cmp := i.compare_at_price;
    avail := not i.track_stock or i.stock_qty > 0; n := greatest(i.stock_qty, 0);
  end if;
  return jsonb_build_object('price', trim_scale(lo), 'price_max', trim_scale(hi), 'compare_at', case when cmp > lo then trim_scale(cmp) end,
                            'in_stock', coalesce(avail, false), 'stock', case when i.track_stock then coalesce(n, 0) end);
end $$;
revoke execute on function public.sf_prices(public.catalog_items) from public, anon, authenticated;

-- an item's main picture: its first picture, else its image_url
create or replace function public.sf_image(p_item uuid, p_fallback text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select jsonb_build_object('url', m.url, 'sizes', m.sizes, 'alt', m.alt, 'width', m.width, 'height', m.height)
       from public.catalog_media m where m.item_id = p_item order by m.position, m.created_at, m.id limit 1),
    case when p_fallback ~ '^https://' then jsonb_build_object('url', p_fallback, 'sizes', '{}'::jsonb, 'alt', '', 'width', null, 'height', null) end)
$$;
revoke execute on function public.sf_image(uuid, text) from public, anon, authenticated;

-- a product's card: what a grid shows
create or replace function public.sf_card(i public.catalog_items, p_show_stock boolean) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('slug', i.slug, 'name', i.name, 'price', pr->'price', 'price_max', pr->'price_max',
           'compare_at', pr->'compare_at', 'in_stock', pr->'in_stock', 'stock', case when p_show_stock then pr->'stock' end,
           'image', public.sf_image(i.id, i.image_url))
    from (select public.sf_prices(i) as pr) x
$$;
revoke execute on function public.sf_card(public.catalog_items, boolean) from public, anon, authenticated;

-- the tags of an automatic collection
create or replace function public.sf_rule_tags(p_rules jsonb) returns text[] language sql immutable set search_path = public as $$
  select coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(p_rules->'tags') = 'array' then p_rules->'tags' else '[]'::jsonb end)), '{}')
$$;
revoke execute on function public.sf_rule_tags(jsonb) from public, anon, authenticated;

-- is the product in the collection
create or replace function public.sf_in_collection(c public.catalog_collections, i public.catalog_items) returns boolean
language sql stable security definer set search_path = public as $$
  select case when c.kind = 'manual' then exists (select 1 from public.catalog_collection_items ci where ci.collection_id = c.id and ci.item_id = i.id)
              else i.tags && public.sf_rule_tags(c.rules) end
$$;
revoke execute on function public.sf_in_collection(public.catalog_collections, public.catalog_items) from public, anon, authenticated;

-- which store is this host: {store, status, primary, primary_domain} — the storefront's server asks, by the request's Host
create or replace function public.sf_resolve_host(p_host text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('store', s.id, 'status', s.status, 'primary', d.is_primary,
           'primary_domain', (select p.domain from public.store_domains p where p.store_id = s.id and p.is_primary))
    from public.store_domains d join public.stores s on s.id = d.store_id
   where d.domain = lower(btrim(coalesce(p_host, '')))
$$;

-- the storefront served this host: its DNS and its certificate work — the only way a domain becomes "active"
create or replace function public.sf_domain_seen(p_host text) returns void
language sql security definer set search_path = public as $$
  update public.store_domains set status = 'active', last_seen_at = now()
   where domain = lower(btrim(coalesce(p_host, '')))
     and (status <> 'active' or last_seen_at is null or last_seen_at < now() - interval '1 hour')
$$;

-- the store: its face (name, logo, contact, the theme), its menus, policies and collections, the business's legal details.
-- A store that is not published shows only its name ("בקרוב"), unless the storefront verified a preview token.
create or replace function public.sf_store(p_store uuid, p_preview boolean default false) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s public.stores; r public.register_settings; th public.store_theme_versions; prim text;
begin
  select * into s from public.stores where id = p_store;
  if s.id is null then return null; end if;
  select domain into prim from public.store_domains where store_id = s.id and is_primary;
  if s.status <> 'published' and not p_preview then
    return jsonb_build_object('id', s.id, 'status', s.status, 'name', s.name, 'lang', s.lang, 'logo_url', s.logo_url, 'primary_domain', prim);
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
                               from public.catalog_collections c where c.business_id = s.business_id and c.publish_online), '[]'::jsonb));
end $$;

-- the products of the store — of a collection, of a search — filtered (an option's values, price, in stock), sorted and
-- paged, with the filters' facets. Only published products with an address and a price; never another business's.
create or replace function public.sf_products(p_store uuid, p_opts jsonb default '{}', p_preview boolean default false) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  s public.stores;
  col public.catalog_collections;
  col_slug text := nullif(btrim(coalesce(p_opts->>'collection', '')), '');
  q text := nullif(left(btrim(coalesce(p_opts->>'q', '')), 80), '');
  lim int := least(greatest(coalesce(public.sf_num(p_opts->>'limit')::int, 24), 1), 48);
  off int := least(coalesce(public.sf_num(p_opts->>'offset')::int, 0), 5000);
  srt text := coalesce(p_opts->>'sort', '');
  only_stock boolean := coalesce(p_opts->>'in_stock', '') in ('1', 'true');
  lo numeric := public.sf_num(p_opts->>'min_price');
  hi numeric := public.sf_num(p_opts->>'max_price');
  opts jsonb := case when jsonb_typeof(p_opts->'options') = 'object' then p_opts->'options' else '{}'::jsonb end;
  result jsonb;
begin
  select * into s from public.stores where id = p_store;
  if s.id is null or (s.status <> 'published' and not p_preview) then return null; end if;
  if col_slug is not null and col_slug <> 'all' then
    select * into col from public.catalog_collections c where c.business_id = s.business_id and c.slug = col_slug and c.publish_online;
    if col.id is null then return null; end if;
  end if;
  if srt not in ('manual', 'newest', 'price_asc', 'price_desc', 'name') then srt := coalesce(col.sort, 'newest'); end if;
  if srt = 'manual' and (col.id is null or col.kind <> 'manual') then srt := 'newest'; end if;

  with scope as (
    select i as itm, i.id, i.name, i.track_stock, coalesce(i.published_at, i.created_at) as since, public.sf_prices(i) as pr,
           (select ci.position from public.catalog_collection_items ci where ci.collection_id = col.id and ci.item_id = i.id) as pos
      from public.catalog_items i
     where i.business_id = s.business_id and i.publish_online and i.active and i.slug is not null
       and (col.id is null or public.sf_in_collection(col, i))
       and (q is null or strpos(lower(i.name), lower(q)) > 0 or strpos(lower(i.description), lower(q)) > 0
            or exists (select 1 from unnest(i.tags) t where strpos(lower(t), lower(q)) > 0)
            or (i.sku <> '' and lower(i.sku) = lower(q)))
  ), priced as (
    select * from scope where scope.pr->>'price' is not null
  ), hit as (
    select p.* from priced p
     where (lo is null or (p.pr->>'price')::numeric >= lo)
       and (hi is null or (p.pr->>'price')::numeric <= hi)
       and (not only_stock or (p.pr->>'in_stock')::boolean)
       and (opts = '{}'::jsonb or exists (
             select 1 from public.catalog_variants v
              where v.item_id = p.id and v.active and (not only_stock or not p.track_stock or v.stock_qty > 0)
                and not exists (
                  select 1 from jsonb_each(opts) f
                   where jsonb_typeof(f.value) <> 'array' or not exists (
                     select 1 from public.catalog_options o
                      where o.item_id = p.id and o.name = f.key
                        and (case o.position when 1 then v.option1 when 2 then v.option2 else v.option3 end)
                            in (select jsonb_array_elements_text(f.value))))))
  ), page as (
    select h.*, row_number() over (order by
             case when srt = 'manual' then h.pos end asc nulls last,
             case when srt = 'price_asc' then (h.pr->>'price')::numeric end asc,
             case when srt = 'price_desc' then (h.pr->>'price')::numeric end desc,
             case when srt = 'newest' then h.since end desc,
             h.name, h.id) as rn
      from hit h
  )
  select jsonb_build_object(
    'total', (select count(*) from hit),
    'sort', srt,
    'items', coalesce((select jsonb_agg(public.sf_card(pg.itm, s.show_stock_count) order by pg.rn)
                         from page pg where pg.rn > off and pg.rn <= off + lim), '[]'::jsonb),
    'facets', jsonb_build_object(
      'options', coalesce((select jsonb_object_agg(b.name, b.vals) from (
          select a.name, jsonb_agg(a.val order by a.rk, a.val) as vals from (
            select o.name, x.val, min(coalesce(array_position(o.choices, x.val), 999)) as rk
              from priced p
              join public.catalog_options o on o.item_id = p.id
              join public.catalog_variants v on v.item_id = p.id and v.active
              cross join lateral (select case o.position when 1 then v.option1 when 2 then v.option2 else v.option3 end as val) x
             where x.val <> ''
             group by o.name, x.val) a
          group by a.name) b), '{}'::jsonb),
      'price', jsonb_build_object('min', (select min((p.pr->>'price')::numeric) from priced p), 'max', (select max((p.pr->>'price_max')::numeric) from priced p))),
    'collection', case when col.id is not null then jsonb_build_object('slug', col.slug, 'title', col.title, 'description', col.description,
      'image_url', col.image_url, 'seo_title', col.seo_title, 'seo_description', col.seo_description, 'updated_at', col.updated_at) end)
  into result;
  return result;
end $$;

-- one product, by its address: pictures, options and variants (price and "in stock" each), the business's fields that are
-- shown on the site, its collection (breadcrumbs) and up to 4 related products
create or replace function public.sf_product(p_store uuid, p_slug text, p_preview boolean default false) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s public.stores; i public.catalog_items; pr jsonb; col jsonb;
begin
  select * into s from public.stores where id = p_store;
  if s.id is null or (s.status <> 'published' and not p_preview) then return null; end if;
  select * into i from public.catalog_items c where c.business_id = s.business_id and c.slug = p_slug and c.publish_online and c.active;
  if i.id is null then return null; end if;
  pr := public.sf_prices(i);
  if pr->>'price' is null then return null; end if;
  select jsonb_build_object('slug', c.slug, 'title', c.title) into col from public.catalog_collections c
   where c.business_id = s.business_id and c.publish_online and public.sf_in_collection(c, i)
   order by c.position, c.title limit 1;
  return jsonb_build_object(
    'id', i.id, 'slug', i.slug, 'name', i.name, 'kind', i.kind, 'description', i.description,
    'seo_title', i.seo_title, 'seo_description', i.seo_description,
    'price', pr->'price', 'price_max', pr->'price_max', 'compare_at', pr->'compare_at', 'in_stock', pr->'in_stock',
    'stock', case when s.show_stock_count then pr->'stock' end,
    'sku', i.sku, 'barcode', i.barcode, 'tags', to_jsonb(i.tags), 'manufacturer', i.manufacturer, 'country_of_origin', i.country_of_origin,
    'updated_at', i.updated_at,
    'images', coalesce(
      (select jsonb_agg(jsonb_build_object('id', m.id, 'url', m.url, 'sizes', m.sizes, 'alt', m.alt, 'width', m.width, 'height', m.height,
                                           'variant', m.variant_id) order by m.position, m.created_at, m.id)
         from public.catalog_media m where m.item_id = i.id),
      case when i.image_url ~ '^https://' then jsonb_build_array(jsonb_build_object('url', i.image_url, 'sizes', '{}'::jsonb, 'alt', '')) else '[]'::jsonb end),
    'options', case when i.has_variants then coalesce(
      (select jsonb_agg(jsonb_build_object('name', o.name, 'position', o.position, 'values', coalesce(
                 (select jsonb_agg(z.val order by array_position(o.choices, z.val) nulls last, z.val) from (
                    select distinct case o.position when 1 then v.option1 when 2 then v.option2 else v.option3 end as val
                      from public.catalog_variants v where v.item_id = i.id and v.active) z where z.val <> ''), '[]'::jsonb))
              order by o.position)
         from public.catalog_options o where o.item_id = i.id), '[]'::jsonb) else '[]'::jsonb end,
    'variants', case when i.has_variants then coalesce(
      (select jsonb_agg(jsonb_build_object(
                'id', v.id, 'options', jsonb_build_array(v.option1, v.option2, v.option3),
                'price', trim_scale(coalesce(v.online_price, i.online_price, v.price, i.price)),
                'compare_at', case when coalesce(v.compare_at_price, i.compare_at_price) > coalesce(v.online_price, i.online_price, v.price, i.price)
                                   then trim_scale(coalesce(v.compare_at_price, i.compare_at_price)) end,
                'in_stock', not i.track_stock or v.stock_qty > 0,
                'stock', case when s.show_stock_count and i.track_stock then greatest(v.stock_qty, 0) end,
                'sku', v.sku, 'barcode', v.barcode, 'image', v.media_id) order by v.position, v.id)
         from public.catalog_variants v where v.item_id = i.id and v.active), '[]'::jsonb) else '[]'::jsonb end,
    'fields', coalesce(
      (select jsonb_agg(jsonb_build_object('label', d.label, 'value', i.custom_fields->>d.field_key, 'kind', d.kind) order by d.position, d.label)
         from public.catalog_field_defs d
        where d.business_id = s.business_id and d.show_online and coalesce(btrim(i.custom_fields->>d.field_key), '') <> ''), '[]'::jsonb),
    'collection', col,
    'related', coalesce(
      (select jsonb_agg(public.sf_card(r.x, s.show_stock_count) order by (r.x).name, (r.x).id) from (
         select x from public.catalog_items x
          where x.business_id = s.business_id and x.publish_online and x.active and x.slug is not null and x.id <> i.id
            and (x.tags && i.tags or exists (select 1 from public.catalog_collection_items a join public.catalog_collection_items b
                                              on b.collection_id = a.collection_id where a.item_id = i.id and b.item_id = x.id))
            and public.sf_prices(x)->>'price' is not null
          order by x.name, x.id limit 4) r), '[]'::jsonb));
end $$;

-- the published collections, with how many products each shows
create or replace function public.sf_collections(p_store uuid, p_preview boolean default false) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s public.stores;
begin
  select * into s from public.stores where id = p_store;
  if s.id is null or (s.status <> 'published' and not p_preview) then return null; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('slug', c.slug, 'title', c.title, 'description', c.description,
                     'image_url', coalesce(nullif(c.image_url, ''), (
                        select public.sf_image(i.id, i.image_url)->>'url' from public.catalog_items i
                         where i.business_id = s.business_id and i.publish_online and i.active and i.slug is not null and public.sf_in_collection(c, i)
                         order by i.name, i.id limit 1), ''),
                     'count', (select count(*) from public.catalog_items i
                                where i.business_id = s.business_id and i.publish_online and i.active and i.slug is not null and public.sf_in_collection(c, i)))
                   order by c.position, c.title)
                     from public.catalog_collections c where c.business_id = s.business_id and c.publish_online), '[]'::jsonb);
end $$;

-- a content page (/pages/<slug>) or a policy (/policies/<kind>) that is published
create or replace function public.sf_page(p_store uuid, p_kind text, p_slug text, p_preview boolean default false) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s public.stores;
begin
  select * into s from public.stores where id = p_store;
  if s.id is null or (s.status <> 'published' and not p_preview) then return null; end if;
  return (select jsonb_build_object('slug', g.slug, 'kind', g.kind, 'policy', g.policy, 'title', g.title, 'body', g.body,
                   'seo_title', g.seo_title, 'seo_description', g.seo_description, 'updated_at', g.updated_at)
            from public.store_pages g
           where g.store_id = s.id and g.published
             and ((p_kind = 'policy' and g.kind = 'policy' and g.policy = p_slug) or (p_kind = 'page' and g.kind = 'page' and g.slug = p_slug)));
end $$;

-- a 301 for an address that moved (or null)
create or replace function public.sf_redirect(p_store uuid, p_path text) returns text
language sql stable security definer set search_path = public as $$
  select r.to_path from public.store_redirects r where r.store_id = p_store and r.from_path = p_path
$$;

-- every address of a published store, with its last change (sitemap.xml)
create or replace function public.sf_sitemap(p_store uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s public.stores;
begin
  select * into s from public.stores where id = p_store;
  if s.id is null or s.status <> 'published' then return null; end if;
  return jsonb_build_object(
    'store', s.updated_at,
    'products', coalesce((select jsonb_agg(jsonb_build_object('slug', i.slug, 'updated_at', i.updated_at) order by i.slug)
                            from public.catalog_items i
                           where i.business_id = s.business_id and i.publish_online and i.active and i.slug is not null
                             and public.sf_prices(i)->>'price' is not null), '[]'::jsonb),
    'collections', coalesce((select jsonb_agg(jsonb_build_object('slug', c.slug, 'updated_at', c.updated_at) order by c.slug)
                               from public.catalog_collections c where c.business_id = s.business_id and c.publish_online), '[]'::jsonb),
    'pages', coalesce((select jsonb_agg(jsonb_build_object('kind', g.kind, 'slug', g.slug, 'policy', g.policy, 'updated_at', g.updated_at) order by g.kind, g.slug)
                         from public.store_pages g where g.store_id = s.id and g.published), '[]'::jsonb));
end $$;

do $$
declare f text;
begin
  foreach f in array array['public.sf_resolve_host(text)', 'public.sf_domain_seen(text)', 'public.sf_store(uuid, boolean)',
    'public.sf_products(uuid, jsonb, boolean)', 'public.sf_product(uuid, text, boolean)', 'public.sf_collections(uuid, boolean)',
    'public.sf_page(uuid, text, text, boolean)', 'public.sf_redirect(uuid, text)', 'public.sf_sitemap(uuid)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- ============================================================================================================================
-- Rollback (by hand, if ever needed): the triggers z_store_redirect (catalog_items, catalog_collections, store_pages),
-- b_store_touch, b_stores_guard, b_store_theme_versions_guard, a_fill_from_store, a_fill_from_collection and a_fill_business_id
-- of the new tables; the functions sf_*, store_* and catalog_collection_items_fill; the tables store_redirects,
-- catalog_collection_items, catalog_collections, store_menus, store_pages, store_theme_versions, store_domains, stores; the
-- index catalog_items_online_idx. Nothing else changes, so nothing else needs restoring.
-- ============================================================================================================================
