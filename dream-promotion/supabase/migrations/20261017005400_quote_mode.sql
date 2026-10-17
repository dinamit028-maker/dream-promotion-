-- ============================================================================================================================
-- Migration 20261017005400 — products sold by a quote, and the site's requests into the leads (2.102.0).
-- Prepared only: NOT applied to the live database (needs the owner's explicit approval; the SQL Editor). Runs after 20261012005300
-- (lead departments) and 20261011004700 (stock by location): it stops at the top without them, changing nothing. Additions only and
-- idempotent: no drop and no delete statement (the word "delete" is in the foreign keys' "on delete" only).
-- It replaces four functions of the storefront — sf_line_price, sf_card, sf_product, sf_products — each as it was, with the quote
-- added: running 20261005003400, 20261006003500 or 20261011004700 again after it brings their old text back; then run this one again.
-- Tested on a local Postgres: tests/sql/quote-mode.check.sql.
--
--   catalog_items      + quote_mode ("בהצעת מחיר": on the site no cart and no payment — a request instead), quote_from (the
--                        "החל מ-" price of one unit, shown only), quote_currency (its currency, e.g. USD; '' = the store's — shown
--                        only, never converted, never charged), quote_min_qty (the minimum order, shown). The register's price is
--                        still `price`, in shekels, as before; a package is never sold by a quote.
--   sf_line_price      a product by a quote has no price on the site: the cart refuses it ('gone'), and so does the checkout.
--   sf_card, sf_product   + quote {from, currency, min} — null for a product sold as before.
--   sf_products        a product by a quote is left out of the price filter and of the price range, and goes last when sorting by price.
--   site_requests      one row per request sent from the site ("בקשת הצעת מחיר" of a product, the contact form): who, what, the
--                        contact it went to, and when the dashboard routed it (department, person, WhatsApp). The server's only.
--   sf_lead_request    the storefront's door: a request → a new contact in the leads (source "אתר", status "חדש"), or a note on the
--                        card of the contact with the same phone (else the same email). The same request id twice = one request.
--   lead_routing       + site_department_id: the department that gets the site's requests (none = the default recipient).
-- The rollback is at the end.
-- ============================================================================================================================

-- ---- 0. after 20261012005300 and 20261011004700 -------------------------------------------------------------------------------
do $$ begin
  if to_regclass('public.lead_routing') is null or to_regprocedure('public.sf_stock(uuid, uuid)') is null then
    raise exception 'migration 20261017005400 runs after 20261012005300 (lead departments) and 20261011004700 (stock by location) — run them first; nothing was changed';
  end if;
end $$;

-- ---- 1. a product sold by a quote -----------------------------------------------------------------------------------------------
alter table public.catalog_items add column if not exists quote_mode boolean not null default false;
alter table public.catalog_items add column if not exists quote_from numeric(12,2);
alter table public.catalog_items add column if not exists quote_currency text not null default '';
alter table public.catalog_items add column if not exists quote_min_qty int;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'catalog_items_quote_check' and conrelid = 'public.catalog_items'::regclass) then
    alter table public.catalog_items add constraint catalog_items_quote_check check (
      (quote_from is null or quote_from between 0 and 10000000)
      and (quote_currency = '' or quote_currency ~ '^[A-Z]{3}$')
      and (quote_min_qty is null or quote_min_qty between 1 and 10000000)
      and (not quote_mode or kind <> 'package'));
  end if;
end $$;

-- the quote of a product as the site shows it — null when it is sold as before
create or replace function public.sf_quote(i public.catalog_items) returns jsonb
language sql immutable set search_path = public as $$
  select case when i.quote_mode then jsonb_build_object('from', trim_scale(i.quote_from), 'currency', i.quote_currency, 'min', i.quote_min_qty) end
$$;
revoke execute on function public.sf_quote(public.catalog_items) from public, anon, authenticated;

-- as 20261006003500_commerce_checkout, and null for a product sold by a quote: the cart (sf_cart_set, sf_cart_view) and the
-- checkout (sf_checkout_start) already refuse a line without a price
create or replace function public.sf_line_price(i public.catalog_items, v public.catalog_variants) returns numeric
language sql immutable set search_path = public as $$
  select case when i.quote_mode then null
              when v.id is null then coalesce(i.online_price, i.price)
              else coalesce(v.online_price, i.online_price, v.price, i.price) end
$$;
revoke execute on function public.sf_line_price(public.catalog_items, public.catalog_variants) from public, anon, authenticated;

-- as 20261005003400_commerce_store, with the quote
create or replace function public.sf_card(i public.catalog_items, p_show_stock boolean) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('slug', i.slug, 'name', i.name, 'price', pr->'price', 'price_max', pr->'price_max',
           'compare_at', pr->'compare_at', 'in_stock', pr->'in_stock', 'stock', case when p_show_stock then pr->'stock' end,
           'image', public.sf_image(i.id, i.image_url), 'quote', public.sf_quote(i))
    from (select public.sf_prices(i) as pr) x
$$;
revoke execute on function public.sf_card(public.catalog_items, boolean) from public, anon, authenticated;

-- as 20261011004700_stock_locations, with the quote
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
                'in_stock', not i.track_stock or public.sf_stock(i.id, v.id) - public.sf_reserved(i.id, v.id) > 0,
                'stock', case when s.show_stock_count and i.track_stock then greatest(public.sf_stock(i.id, v.id) - public.sf_reserved(i.id, v.id), 0) end,
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
          order by x.name, x.id limit 4) r), '[]'::jsonb),
    'can_buy', public.sf_can_buy(s),
    'quote', public.sf_quote(i));
end $$;

-- as 20261011004700_stock_locations: a product by a quote is not in the price filter or the price range, and is last by price
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
    select i as itm, i.id, i.name, i.track_stock, i.quote_mode as quote, coalesce(i.published_at, i.created_at) as since, public.sf_prices(i) as pr,
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
     where (lo is null or (not p.quote and (p.pr->>'price')::numeric >= lo))
       and (hi is null or (not p.quote and (p.pr->>'price')::numeric <= hi))
       and (not only_stock or (p.pr->>'in_stock')::boolean)
       and (opts = '{}'::jsonb or exists (
             select 1 from public.catalog_variants v
              where v.item_id = p.id and v.active and (not only_stock or not p.track_stock or public.sf_stock(p.id, v.id) > 0)
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
             case when srt = 'price_asc' and not h.quote then (h.pr->>'price')::numeric end asc nulls last,
             case when srt = 'price_desc' and not h.quote then (h.pr->>'price')::numeric end desc nulls last,
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
      'price', jsonb_build_object('min', (select min((p.pr->>'price')::numeric) from priced p where not p.quote),
                                  'max', (select max((p.pr->>'price_max')::numeric) from priced p where not p.quote))),
    'collection', case when col.id is not null then jsonb_build_object('slug', col.slug, 'title', col.title, 'description', col.description,
      'image_url', col.image_url, 'seo_title', col.seo_title, 'seo_description', col.seo_description, 'updated_at', col.updated_at) end)
  into result;
  return result;
end $$;

do $$
declare f text;
begin
  foreach f in array array['public.sf_product(uuid, text, boolean)', 'public.sf_products(uuid, jsonb, boolean)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- ---- 2. the site's requests ------------------------------------------------------------------------------------------------------
create table if not exists public.site_requests (
  id          uuid primary key,                       -- made by the shopper's browser: a retry is the same request
  business_id uuid not null references public.businesses on delete cascade,
  store_id    uuid not null references public.stores on delete cascade,
  kind        text not null check (kind in ('quote', 'contact')),
  item_id     uuid references public.catalog_items on delete set null,
  model       text not null default '' check (length(model) <= 80),
  item_name   text not null default '' check (length(item_name) <= 200),
  lead_id     uuid,
  new_contact boolean not null default false,
  name        text not null check (length(btrim(name)) between 2 and 80),
  phone       text not null check (length(phone) between 9 and 16),
  email       text not null default '' check (length(email) <= 120),
  qty         int check (qty is null or qty between 1 and 10000000),
  topic       text not null default '' check (length(topic) <= 60),
  notes       text not null default '' check (length(notes) <= 1000),
  page        text not null default '' check (length(page) <= 300),
  preview     boolean not null default false,         -- sent from the owner's preview of a store not yet on the air
  routed_at   timestamptz,                            -- the dashboard routed it: department, person, WhatsApp (or nobody to tell)
  created_at  timestamptz not null default now(),
  constraint site_requests_lead_fk foreign key (lead_id, business_id) references public.leads (id, business_id) on delete set null (lead_id)
);
create index if not exists site_requests_business_idx on public.site_requests (business_id, created_at desc);
create index if not exists site_requests_unrouted_idx on public.site_requests (created_at) where routed_at is null;
create index if not exists site_requests_phone_idx on public.site_requests (store_id, public.phone_key(phone), created_at desc);
-- the server's only: no policy, no grant for the browser (row-level security on, so even a grant given by mistake shows nothing)
alter table public.site_requests enable row level security;
revoke all on public.site_requests from anon, authenticated;
grant select, insert, update on public.site_requests to service_role;

-- the department that gets the site's requests (a department of the same business; inactive = as if none)
alter table public.lead_routing add column if not exists site_department_id uuid;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'lead_routing_site_department_fk' and conrelid = 'public.lead_routing'::regclass) then
    alter table public.lead_routing add constraint lead_routing_site_department_fk foreign key (site_department_id, business_id)
      references public.lead_departments (id, business_id);
  end if;
end $$;

-- A request from the site → the leads of the store's business. p_customer {name, phone, email}; p_details {qty, topic, notes,
-- model, page}. Answers {ok: true, request} or {ok: false, error: store | bad_request | details (+ fields) | item | too_many}.
-- The contact: the oldest one with the same phone (phone_key), else the same email — it gets a note on its card and keeps every
-- value it has; else a new contact (source "אתר", status "חדש", the request in its notes). One lock per business, as
-- commerce_upsert_customer: two requests of one new person at once make one contact, not two.
create or replace function public.sf_lead_request(p_store uuid, p_request uuid, p_kind text, p_item uuid, p_customer jsonb,
                                                  p_details jsonb, p_preview boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s public.stores; i public.catalog_items; r public.site_requests; who uuid; found uuid; fresh boolean := false; pk text;
  fields text[] := '{}'; body text; tags text[];
  nm text := btrim(regexp_replace(coalesce(p_customer->>'name', ''), '\s+', ' ', 'g'));
  ph text := regexp_replace(coalesce(p_customer->>'phone', ''), '[^0-9+]', '', 'g');
  em text := lower(btrim(coalesce(p_customer->>'email', '')));
  qty_text text := btrim(coalesce(p_details->>'qty', ''));
  qty int;
  topic text := btrim(regexp_replace(coalesce(p_details->>'topic', ''), '\s+', ' ', 'g'));
  notes text := btrim(coalesce(p_details->>'notes', ''));
  model text := btrim(coalesce(p_details->>'model', ''));
  page text := btrim(coalesce(p_details->>'page', ''));
  is_preview boolean;
begin
  select * into s from public.stores where id = p_store;
  if s.id is null or (s.status <> 'published' and not p_preview) then return jsonb_build_object('ok', false, 'error', 'store'); end if;
  is_preview := s.status <> 'published';
  if p_request is null or coalesce(p_kind, '') not in ('quote', 'contact') then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  select * into r from public.site_requests where id = p_request;
  if r.id is not null then
    if r.store_id <> s.id then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
    return jsonb_build_object('ok', true, 'request', r.id, 'already', true);
  end if;

  -- the details, as the checkout checks them
  if length(nm) not between 2 and 80 then fields := array_append(fields, 'name'); end if;
  if ph ~ '^\+?972[0-9]{8,9}$' then ph := regexp_replace(ph, '^\+?972', '0'); end if;   -- +972 50… → 050…
  if ph !~ '^0[0-9]{8,9}$' and ph !~ '^\+[0-9]{9,15}$' then fields := array_append(fields, 'phone'); end if;
  if em <> '' and (length(em) > 120 or em !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$') then fields := array_append(fields, 'email'); end if;
  if qty_text <> '' then
    if qty_text ~ '^[0-9]{1,8}$' and qty_text::int between 1 and 10000000 then qty := qty_text::int; else fields := array_append(fields, 'qty'); end if;
  end if;
  if length(topic) > 60 then fields := array_append(fields, 'topic'); end if;
  if length(notes) > 1000 then fields := array_append(fields, 'notes'); end if;
  if model <> '' and model !~ '^[A-Za-z0-9א-ת][A-Za-z0-9א-ת ._/-]{0,79}$' then fields := array_append(fields, 'model'); end if;
  if cardinality(fields) > 0 then return jsonb_build_object('ok', false, 'error', 'details', 'fields', to_jsonb(fields)); end if;
  if length(page) > 300 or page !~ '^/[^[:space:]]*$' then page := ''; end if;

  -- a request of a product: one sold by a quote, shown on this store
  if p_kind = 'quote' then
    select * into i from public.catalog_items c
     where c.id = p_item and c.business_id = s.business_id and c.publish_online and c.active and c.slug is not null and c.quote_mode;
    if i.id is null then return jsonb_build_object('ok', false, 'error', 'item'); end if;
    model := left(coalesce(nullif(btrim(i.sku), ''), i.slug), 80);
  end if;

  who := public.commerce_owner(s.business_id);
  if who is null then return jsonb_build_object('ok', false, 'error', 'store'); end if;
  perform pg_advisory_xact_lock(hashtextextended('dp-lead:' || s.business_id::text, 0));
  -- the same request once more, now that this is the only writer of the business
  select * into r from public.site_requests where id = p_request;
  if r.id is not null then return jsonb_build_object('ok', true, 'request', r.id, 'already', true); end if;
  -- the same person asked many times within minutes: a guard, not a gate (the storefront also counts per shopper)
  if (select count(*) from public.site_requests x
       where x.store_id = s.id and public.phone_key(x.phone) = public.phone_key(ph) and x.created_at > now() - interval '10 minutes') >= 5 then
    return jsonb_build_object('ok', false, 'error', 'too_many');
  end if;

  body := concat_ws(E'\n',
    case when p_kind = 'quote' then 'בקשת הצעת מחיר מהאתר' else 'פנייה מהאתר' end
      || case when is_preview then ' (נשלחה מהתצוגה המקדימה — בדיקה)' else '' end,
    case when p_kind = 'quote' then format('דגם: %s — %s', model, i.name) when model <> '' then format('דגם: %s', model) end,
    case when qty is not null then format('כמות משוערת: %s', qty) end,
    case when topic <> '' then format('נושא: %s', topic) end,
    case when em <> '' then format('אימייל: %s', em) end,
    case when notes <> '' then format('הערות: %s', notes) end,
    case when page <> '' then format('מהעמוד: %s', page) end);
  tags := array['פנייה מהאתר'] || case when p_kind = 'quote' then array['הצעת מחיר'] else array[]::text[] end
          || case when is_preview then array['בדיקה'] else array[]::text[] end;

  pk := public.phone_key(ph);
  select l.id into found from public.leads l
   where l.business_id = s.business_id and coalesce(l.phone, '') <> '' and public.phone_key(l.phone) = pk
   order by l.created_at, l.id limit 1;
  if found is null and em <> '' then
    select l.id into found from public.leads l
     where l.business_id = s.business_id and l.email <> '' and lower(btrim(l.email)) = em
     order by l.created_at, l.id limit 1;
  end if;
  if found is null then
    insert into public.leads (user_id, business_id, name, phone, email, source, status, notes, tags, date, external_source, external_id)
    values (who, s.business_id, nm, ph, em, 'אתר', 'חדש', body, tags, (now() at time zone 'Asia/Jerusalem')::date, 'site', p_request::text)
    returning id into found;
    fresh := true;
  else
    insert into public.lead_activities (user_id, business_id, lead_id, kind, body) values (who, s.business_id, found, 'note', body);
  end if;

  insert into public.site_requests (id, business_id, store_id, kind, item_id, model, item_name, lead_id, new_contact, name, phone, email,
                                    qty, topic, notes, page, preview)
  values (p_request, s.business_id, s.id, p_kind, i.id, model, coalesce(i.name, ''), found, fresh, nm, ph, em,
          qty, topic, notes, page, is_preview);
  return jsonb_build_object('ok', true, 'request', p_request);
end $$;
revoke execute on function public.sf_lead_request(uuid, uuid, text, uuid, jsonb, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.sf_lead_request(uuid, uuid, text, uuid, jsonb, jsonb, boolean) to service_role;

-- ---- rollback (by hand, only to undo it — it removes the record of the site's requests; the contacts and their notes stay) ------
--   run 20261005003400's sf_card, 20261006003500's sf_line_price and 20261011004700's sf_product and sf_products again;
--   drop function if exists public.sf_lead_request(uuid, uuid, text, uuid, jsonb, jsonb, boolean);
--   drop function if exists public.sf_quote(public.catalog_items);
--   alter table public.lead_routing drop constraint if exists lead_routing_site_department_fk, drop column if exists site_department_id;
--   drop table if exists public.site_requests;
--   alter table public.catalog_items drop constraint if exists catalog_items_quote_check;
--   (the four columns of catalog_items can stay — false and empty, nothing reads them without the functions)
