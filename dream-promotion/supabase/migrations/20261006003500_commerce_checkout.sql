-- ============================================================================================================================
-- Migration 20261006003500 — Dream Commerce stage 3: cart, checkout, stock reservations, test payments (2.56.0)
-- Additive: new tables, new columns on stores (a table of 3400), new functions. Existing functions that change keep their
-- signature (create or replace): sf_prices and sf_product now subtract what is reserved for an order.
--   1. settings     stores: selling on the site (on / off), how long stock is held, pickup, delivery (a fixed price, free
--                   above an amount); store_coupons (a basic coupon: percent or amount, dates, uses, a minimum)
--   2. tables       store_carts + store_cart_lines (a guest's cart; the database keeps only the hash of the cookie),
--                   orders, order_lines (a snapshot of each line), order_events (the timeline, added to only),
--                   stock_reservations, payment_accounts (the business's terminal, sealed), payment_events,
--                   store_order_counters, rate_limits
--   3. stock        "available" = stock − what is held for orders; a register sale that would take held units is refused
--                   (the owner's decision, 6.10.2026) — a sale that does not touch held units behaves as before
--   4. RLS          coupons: the store pattern of 3400; orders and their lines / events / reservations: + _finance_privacy
--                   (customers and money); carts, terminals, payment events, counters, rate limits: server only
--   5. storefront   sf_cart*, sf_checkout_start, sf_order*, sf_payment_*, sf_rate_hit — service_role only. The amount is
--                   computed here, never taken from the browser. Stage 3 is test only: a paid order becomes test_paid, its
--                   units are released — no sale, no stock movement, no document, no customer.
-- No statement here removes rows (an emptied cart line has qty 0; old carts and rate rows are cleared by
-- supabase/cron-commerce.sql), so the MCP applies the whole file.
-- Tested on a local Postgres 16: tests/sql/commerce-checkout.check.sql, tests/sql/concurrency.sh (the last unit, two
-- payment notices at once) and the storefront's browser tests. Applied to the live database only after explicit approval.
-- ============================================================================================================================

-- ---- 1. the store's checkout settings -------------------------------------------------------------------------------------
alter table public.stores add column if not exists checkout_enabled   boolean not null default false;   -- "מכירה באתר"
alter table public.stores add column if not exists reserve_minutes    int not null default 15;          -- stock held while paying
alter table public.stores add column if not exists pickup_enabled     boolean not null default false;
alter table public.stores add column if not exists pickup_note        text not null default '';         -- where and when
alter table public.stores add column if not exists delivery_enabled   boolean not null default false;
alter table public.stores add column if not exists delivery_price     numeric(10,2) not null default 0;
alter table public.stores add column if not exists free_delivery_over numeric(10,2);                    -- null: never free
alter table public.stores add column if not exists delivery_note      text not null default '';         -- areas, days
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'stores_checkout_settings_check') then
    alter table public.stores add constraint stores_checkout_settings_check check (
      reserve_minutes between 5 and 60 and length(pickup_note) <= 200 and length(delivery_note) <= 200
      and delivery_price between 0 and 10000 and (free_delivery_over is null or free_delivery_over between 1 and 100000));
  end if;
end $$;

-- a basic coupon (stage 7 brings every kind of discount): a percent or an amount off the products, once per order
create table if not exists public.store_coupons (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses on delete restrict,
  store_id     uuid not null references public.stores on delete cascade,
  code         text not null check (code ~ '^[A-Z0-9_-]{3,30}$'),
  kind         text not null check (kind in ('percent', 'amount')),
  value        numeric(10,2) not null check (value > 0 and (kind <> 'percent' or value <= 100)),
  min_subtotal numeric(10,2) not null default 0 check (min_subtotal >= 0),
  starts_at    timestamptz,
  ends_at      timestamptz,
  max_uses     int check (max_uses is null or max_uses > 0),
  used_count   int not null default 0 check (used_count >= 0),
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);
create unique index if not exists store_coupons_code_uq on public.store_coupons (store_id, code);
create or replace trigger a_fill_from_store before insert or update on public.store_coupons for each row execute function public.store_fill_from_store();

create or replace function public.store_coupons_touch() returns trigger
language plpgsql set search_path = public as $$
begin
  new.code := upper(btrim(new.code));
  if tg_op = 'UPDATE' then
    new.updated_at := now();
    if current_user in ('anon', 'authenticated') then new.used_count := old.used_count; end if;   -- counted by the database
  elsif current_user in ('anon', 'authenticated') then
    new.used_count := 0;
  end if;
  return new;
end $$;
revoke execute on function public.store_coupons_touch() from public, anon, authenticated;
create or replace trigger b_store_coupons_touch before insert or update on public.store_coupons for each row execute function public.store_coupons_touch();

-- ---- 2. carts, orders, reservations, payments -----------------------------------------------------------------------------
-- a guest's cart: the cookie holds a random token, the database only its sha-256
create table if not exists public.store_carts (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses on delete restrict,
  store_id    uuid not null references public.stores on delete cascade,
  token_hash  text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  coupon_code text not null default '' check (coupon_code = '' or coupon_code ~ '^[A-Z0-9_-]{3,30}$'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists store_carts_updated_idx on public.store_carts (updated_at);

-- a line: qty 0 is a removed line (nothing is deleted by the storefront)
create table if not exists public.store_cart_lines (
  cart_id    uuid not null references public.store_carts on delete cascade,
  item_id    uuid not null references public.catalog_items on delete cascade,
  variant_id uuid references public.catalog_variants on delete cascade,
  qty        int not null check (qty between 0 and 20),
  added_at   timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists store_cart_lines_uq on public.store_cart_lines (cart_id, item_id, variant_id) nulls not distinct;

-- the order numbers of each business (1001, 1002, …)
create table if not exists public.store_order_counters (
  business_id uuid primary key references public.businesses on delete restrict,
  last        int not null
);

create table if not exists public.orders (
  id                 uuid primary key default gen_random_uuid(),
  business_id        uuid not null references public.businesses on delete restrict,
  store_id           uuid not null references public.stores on delete restrict,
  number             int not null,
  token_hash         text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),   -- the customer's link: /checkout/return?o=<token>
  cart_id            uuid references public.store_carts on delete set null,
  is_test            boolean not null default true,
  payment_status     text not null default 'pending'
                     check (payment_status in ('pending', 'paid', 'failed', 'expired', 'refunded', 'partially_refunded', 'test_paid')),
  fulfillment_status text not null default 'unfulfilled'
                     check (fulfillment_status in ('unfulfilled', 'processing', 'ready', 'shipped', 'delivered', 'returned')),
  document_status    text not null default 'not_required' check (document_status in ('not_required', 'pending', 'issued', 'blocked')),
  state              text not null default 'open' check (state in ('open', 'cancelled', 'closed')),
  currency           text not null default 'ILS' check (currency ~ '^[A-Z]{3}$'),
  subtotal           numeric(12,2) not null check (subtotal >= 0),
  discount           numeric(12,2) not null default 0 check (discount >= 0),
  shipping           numeric(12,2) not null default 0 check (shipping >= 0),
  total              numeric(12,2) not null check (total > 0),
  coupon_code        text not null default '',
  customer_name      text not null check (length(customer_name) between 2 and 80),
  customer_phone     text not null check (customer_phone ~ '^[0-9+]{9,16}$'),
  customer_email     text not null check (length(customer_email) <= 120),
  delivery_method    text not null check (delivery_method in ('pickup', 'delivery')),
  address            jsonb not null default '{}',
  notes              text not null default '' check (length(notes) <= 500),
  terms_accepted_at  timestamptz not null,
  provider           text not null check (provider in ('payplus', 'mock')),
  provider_page      text not null default '',       -- the provider's id of the payment page (PayPlus: page_request_uid)
  provider_txn       text not null default '',       -- the provider's id of the transaction that paid it
  expires_at         timestamptz not null,           -- the stock is held until then
  paid_at            timestamptz,
  failed_at          timestamptz,
  sale_id            uuid,                           -- stage 4: the sale it became
  lead_id            uuid,                           -- stage 4: the customer in the CRM
  risk               jsonb not null default '{}',
  ip_hash            text not null default '',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (subtotal - discount + shipping = total)
);
create unique index if not exists orders_number_uq on public.orders (business_id, number);
create index if not exists orders_store_created_idx on public.orders (store_id, created_at desc);
create index if not exists orders_pending_idx on public.orders (created_at) where payment_status = 'pending';

create table if not exists public.order_lines (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.orders on delete cascade,
  business_id   uuid not null references public.businesses on delete restrict,
  item_id       uuid references public.catalog_items on delete set null,
  variant_id    uuid references public.catalog_variants on delete set null,
  name          text not null,
  variant_label text not null default '',
  sku           text not null default '',
  image_url     text not null default '',
  unit_price    numeric(12,2) not null check (unit_price >= 0),
  qty           int not null check (qty between 1 and 20),
  line_total    numeric(12,2) not null,
  position      int not null default 0
);
create index if not exists order_lines_order_idx on public.order_lines (order_id, position);

-- the order's timeline: rows are only added
create table if not exists public.order_events (
  id          bigint generated always as identity primary key,
  order_id    uuid not null references public.orders on delete cascade,
  business_id uuid not null references public.businesses on delete restrict,
  kind        text not null check (kind ~ '^[a-z_]{2,40}$'),
  data        jsonb not null default '{}',
  at          timestamptz not null default now()
);
create index if not exists order_events_order_idx on public.order_events (order_id, id);

-- units held for an order: 'held' until it expires, 'paid' (stage 4: until the sale is recorded), 'used' (the sale took
-- them), 'released' (expired, failed, or a test order that was paid)
create table if not exists public.stock_reservations (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses on delete restrict,
  order_id    uuid not null references public.orders on delete cascade,
  item_id     uuid not null references public.catalog_items on delete cascade,
  variant_id  uuid references public.catalog_variants on delete cascade,
  qty         int not null check (qty > 0),
  status      text not null default 'held' check (status in ('held', 'paid', 'used', 'released')),
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists stock_reservations_live_idx on public.stock_reservations (item_id, variant_id) where status in ('held', 'paid');
create index if not exists stock_reservations_order_idx on public.stock_reservations (order_id);

-- the business's terminal at the provider. The keys are sealed by the dashboard's server (PAYMENT_SEAL_KEY) and opened only
-- by the storefront's server; the screen sees "connected" and the last 4 characters. Stage 3: test (staging) only.
create table if not exists public.payment_accounts (
  business_id  uuid primary key references public.businesses on delete restrict,
  provider     text not null check (provider in ('payplus', 'mock')),
  mode         text not null default 'test' check (mode in ('test', 'live')),
  sealed       text not null check (sealed ~ '^v1[.]'),
  page_uid     text not null default '' check (length(page_uid) <= 80),
  hint         text not null default '' check (length(hint) <= 8),
  connected_at timestamptz not null default now(),
  updated_by   uuid
);

-- every notice and every check of a payment: unique key = a repeated or replayed notice changes nothing
create table if not exists public.payment_events (
  id           bigint generated always as identity primary key,
  business_id  uuid not null references public.businesses on delete restrict,
  order_id     uuid references public.orders on delete set null,
  provider     text not null,
  event_key    text not null unique check (length(event_key) between 8 and 200),
  kind         text not null check (kind in ('callback', 'return', 'verify', 'poll')),
  signature_ok boolean,                      -- null: the provider sent no signature
  payload      jsonb not null default '{}',
  received_at  timestamptz not null default now()
);
create index if not exists payment_events_order_idx on public.payment_events (order_id, id);

-- requests per key (ip + store + action) per window
create table if not exists public.rate_limits (
  key          text not null check (length(key) between 3 and 200),
  window_start timestamptz not null,
  hits         int not null default 1,
  primary key (key, window_start)
);

-- ---- 3. stock: held units, the register ----------------------------------------------------------------------------------
-- units held for orders now: of the variant, or of the whole item when p_variant is null
create or replace function public.sf_reserved(p_item uuid, p_variant uuid) returns int
language sql stable security definer set search_path = public as $$
  select coalesce(sum(r.qty), 0)::int from public.stock_reservations r
   where r.item_id = p_item and (p_variant is null or r.variant_id = p_variant)
     and (r.status = 'paid' or (r.status = 'held' and r.expires_at > now()))
$$;
revoke execute on function public.sf_reserved(uuid, uuid) from public, anon, authenticated;

-- the register shows "שמור להזמנה באתר" next to a product: the held units of the business worked in now (no customer data)
create or replace function public.reserved_stock() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('item_id', x.item_id, 'variant_id', x.variant_id, 'qty', x.qty)), '[]'::jsonb) from (
    select r.item_id, r.variant_id, sum(r.qty)::int as qty from public.stock_reservations r
     where r.business_id = public.current_business_id() and r.business_id in (select public.accessible_business_ids())
       and (r.status = 'paid' or (r.status = 'held' and r.expires_at > now()))
     group by r.item_id, r.variant_id) x
$$;
revoke execute on function public.reserved_stock() from public, anon;
grant execute on function public.reserved_stock() to authenticated;

-- a sale of the register that would take units held for an order: the first such product ("name — variant"), else null.
-- The business is the one worked in now (nothing about another business). Locks the products' rows in id order, as the
-- checkout does, so a sale and a reservation of the last unit never both succeed.
create or replace function public.stock_reserved_conflict(p_items jsonb, p_sale uuid) returns text
language plpgsql security definer set search_path = public as $$
declare b uuid := public.current_business_id(); l record; i public.catalog_items; v public.catalog_variants; held int; have int;
begin
  if b is null or b not in (select public.accessible_business_ids()) then return null; end if;
  perform 1 from public.catalog_items c
    where c.business_id = b and c.track_stock and c.id in (select x.item_id from public.stock_lines_v(p_items) x)
    order by c.id for update;
  for l in select * from public.stock_lines_v(p_items) loop
    select * into i from public.catalog_items where id = l.item_id and business_id = b and track_stock;
    continue when i.id is null;
    v := null;
    if l.variant_id is not null then select * into v from public.catalog_variants where id = l.variant_id and item_id = i.id; end if;
    select coalesce(sum(r.qty), 0)::int into held from public.stock_reservations r
     where r.item_id = i.id and (v.id is null or r.variant_id = v.id) and r.order_id is distinct from p_sale
       and (r.status = 'paid' or (r.status = 'held' and r.expires_at > now()));
    continue when held = 0;
    have := case when v.id is not null then v.stock_qty else i.stock_qty end;
    if l.qty > have - held then
      return i.name || case when v.id is not null then ' — ' || concat_ws(' / ', nullif(v.option1, ''), nullif(v.option2, ''), nullif(v.option3, '')) else '' end;
    end if;
  end loop;
  return null;
end $$;
revoke execute on function public.stock_reserved_conflict(jsonb, uuid) from public, anon;
grant execute on function public.stock_reserved_conflict(jsonb, uuid) to authenticated;

-- invoker: current_user is the caller. Only the app's users (the register) are checked; a sale of another business is left
-- to row-level security, which refuses it without saying anything about that business's stock
create or replace function public.sales_reserved_guard() returns trigger
language plpgsql set search_path = public as $$
declare bad text;
begin
  if new.status not in ('paid', 'pending') or current_user not in ('anon', 'authenticated') then return new; end if;
  if new.business_id is null or new.business_id is distinct from public.current_business_id() then return new; end if;
  bad := public.stock_reserved_conflict(new.items, new.id);
  if bad is not null then
    raise exception 'שמור להזמנה באתר: %', bad using errcode = 'P0001', hint = 'reserved_for_online';
  end if;
  return new;
end $$;
revoke execute on function public.sales_reserved_guard() from public, anon, authenticated;
create or replace trigger c_sales_reserved before insert on public.sales for each row execute function public.sales_reserved_guard();

-- selling on the site needs a way to pay and a way to get the goods. Invoker trigger + a helper that answers only about
-- the business worked in now (or for the server)
create or replace function public.store_payment_ready(p_business uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.payment_accounts a where a.business_id = p_business)
     and (auth.uid() is null or p_business = public.current_business_id())
$$;
revoke execute on function public.store_payment_ready(uuid) from public, anon;
grant execute on function public.store_payment_ready(uuid) to authenticated;

create or replace function public.stores_checkout_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.checkout_enabled and (tg_op = 'INSERT' or not old.checkout_enabled
                               or not (new.pickup_enabled or new.delivery_enabled)) then
    if not (new.pickup_enabled or new.delivery_enabled) then
      raise exception 'checkout_not_ready: shipping' using errcode = '23514';
    end if;
    if not public.store_payment_ready(new.business_id) then
      raise exception 'checkout_not_ready: payment' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.stores_checkout_guard() from public, anon, authenticated;
create or replace trigger c_stores_checkout_guard before insert or update on public.stores for each row execute function public.stores_checkout_guard();

-- ---- 4. row-level security ------------------------------------------------------------------------------------------------
do $$
declare
  t text; op text;
  gate        constant text := 'business_id = (select public.current_business_id()) and business_id in (select public.accessible_business_ids())';
  fin         constant text := 'business_id in (select public.finance_business_ids())';
  full_access constant text := '(select public.my_access()) <> ''register''';
  writer      constant text := '(select public.can_write())';
begin
  -- coupons: as the store's tables of 3400; orders and what hangs on them: + the finance privacy (customers and money)
  foreach t in array array['store_coupons', 'orders', 'order_lines', 'order_events', 'stock_reservations'] loop
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
    if t <> 'store_coupons' and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_finance_privacy') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)', t || '_finance_privacy', t, fin, fin);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_business_read') then
      execute format('create policy %I on public.%I for select to authenticated using (%s)', t || '_business_read', t, gate);
    end if;
    foreach op in array array['insert', 'update', 'delete'] loop
      if t = 'store_coupons' and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_business_' || op) then
        execute format('create policy %I on public.%I for %s to authenticated %s', t || '_business_' || op, t, op,
          case op when 'insert' then format('with check (%s)', gate) when 'update' then format('using (%s) with check (%s)', gate, gate) else format('using (%s)', gate) end);
      end if;
      if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_viewer_' || op) then
        execute format('create policy %I on public.%I as restrictive for %s to authenticated %s', t || '_viewer_' || op, t, op,
          case op when 'insert' then format('with check (%s)', writer) when 'update' then format('using (%s) with check (%s)', writer, writer) else format('using (%s)', writer) end);
      end if;
    end loop;
  end loop;
  -- server only: no policy, no grant (the storefront reaches them through sf_*, the dashboard's server with its service role)
  foreach t in array array['store_carts', 'store_cart_lines', 'payment_accounts', 'payment_events', 'store_order_counters', 'rate_limits'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
-- a coupon is written by the screen; how often it was used is counted by the database
grant insert (store_id, code, kind, value, min_subtotal, starts_at, ends_at, max_uses, active) on public.store_coupons to authenticated;
grant update (code, kind, value, min_subtotal, starts_at, ends_at, max_uses, active) on public.store_coupons to authenticated;
grant delete on public.store_coupons to authenticated;
-- the settings of selling on the site: the store's own columns (3400 already lets its writers update stores)

-- ---- 5. the storefront's door ----------------------------------------------------------------------------------------------
-- the price of a line, as catalog.ts (onlinePriceOf): the variant's online price → the item's online price → the variant's
-- register price → the item's
create or replace function public.sf_line_price(i public.catalog_items, v public.catalog_variants) returns numeric
language sql immutable set search_path = public as $$
  select case when v.id is null then coalesce(i.online_price, i.price) else coalesce(v.online_price, i.online_price, v.price, i.price) end
$$;
revoke execute on function public.sf_line_price(public.catalog_items, public.catalog_variants) from public, anon, authenticated;

-- 3400's prices, with what is held for orders taken off the stock (same signature)
create or replace function public.sf_prices(i public.catalog_items) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare lo numeric; hi numeric; cmp numeric; avail boolean; n int; free int;
begin
  if i.has_variants then
    select min(x.p), max(x.p), bool_or(x.ok), sum(x.q) into lo, hi, avail, n from (
      select coalesce(v.online_price, i.online_price, v.price, i.price) as p,
             (not i.track_stock or v.stock_qty - public.sf_reserved(i.id, v.id) > 0) as ok,
             greatest(v.stock_qty - public.sf_reserved(i.id, v.id), 0) as q
        from public.catalog_variants v where v.item_id = i.id and v.active) x;
    select coalesce(v.compare_at_price, i.compare_at_price) into cmp from public.catalog_variants v
     where v.item_id = i.id and v.active
     order by coalesce(v.online_price, i.online_price, v.price, i.price), v.position, v.id limit 1;
  else
    lo := coalesce(i.online_price, i.price); hi := lo; cmp := i.compare_at_price;
    free := i.stock_qty - case when i.track_stock then public.sf_reserved(i.id, null) else 0 end;
    avail := not i.track_stock or free > 0; n := greatest(free, 0);
  end if;
  return jsonb_build_object('price', trim_scale(lo), 'price_max', trim_scale(hi), 'compare_at', case when cmp > lo then trim_scale(cmp) end,
                            'in_stock', coalesce(avail, false), 'stock', case when i.track_stock then coalesce(n, 0) end);
end $$;
revoke execute on function public.sf_prices(public.catalog_items) from public, anon, authenticated;

-- 3400's product page, with each variant's held units taken off its stock (same signature; everything else unchanged)
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
                'in_stock', not i.track_stock or v.stock_qty - public.sf_reserved(i.id, v.id) > 0,
                'stock', case when s.show_stock_count and i.track_stock then greatest(v.stock_qty - public.sf_reserved(i.id, v.id), 0) end,
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
    'can_buy', public.sf_can_buy(s));
end $$;

-- the store sells on the site: switched on, a way to get the goods, a terminal connected
create or replace function public.sf_can_buy(s public.stores) returns boolean
language sql stable security definer set search_path = public as $$
  select s.checkout_enabled and (s.pickup_enabled or s.delivery_enabled)
     and exists (select 1 from public.payment_accounts a where a.business_id = s.business_id)
$$;
revoke execute on function public.sf_can_buy(public.stores) from public, anon, authenticated;

-- 3400's store, plus whether it sells on the site (the cart in the header) — same signature
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
                               from public.catalog_collections c where c.business_id = s.business_id and c.publish_online), '[]'::jsonb),
    'can_buy', public.sf_can_buy(s));
end $$;

-- the store of a cart: published, or previewed by its owner (stage 3 is test only, so the owner can try the checkout first)
create or replace function public.sf_selling_store(p_store uuid, p_preview boolean) returns public.stores
language sql stable security definer set search_path = public as $$
  select s.* from public.stores s
   where s.id = p_store and (s.status = 'published' or p_preview)
$$;
revoke execute on function public.sf_selling_store(uuid, boolean) from public, anon, authenticated;

-- a coupon's discount on these products: {code, discount} or {code, error[, min]}
create or replace function public.sf_coupon_eval(s public.stores, p_code text, p_subtotal numeric) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare c public.store_coupons; d numeric;
begin
  if coalesce(p_code, '') = '' then return null; end if;
  select * into c from public.store_coupons where store_id = s.id and code = upper(btrim(p_code)) and active;
  if c.id is null then return jsonb_build_object('code', upper(btrim(p_code)), 'error', 'not_found'); end if;
  if c.starts_at is not null and c.starts_at > now() then return jsonb_build_object('code', c.code, 'error', 'not_started'); end if;
  if c.ends_at is not null and c.ends_at <= now() then return jsonb_build_object('code', c.code, 'error', 'ended'); end if;
  if c.max_uses is not null and c.used_count >= c.max_uses then return jsonb_build_object('code', c.code, 'error', 'used_up'); end if;
  if p_subtotal < c.min_subtotal then return jsonb_build_object('code', c.code, 'error', 'min_subtotal', 'min', trim_scale(c.min_subtotal)); end if;
  d := case c.kind when 'percent' then round(p_subtotal * c.value / 100, 2) else least(c.value, p_subtotal) end;
  return jsonb_build_object('code', c.code, 'discount', trim_scale(d), 'kind', c.kind, 'value', trim_scale(c.value));
end $$;
revoke execute on function public.sf_coupon_eval(public.stores, text, numeric) from public, anon, authenticated;

-- delivery: its price for these products (after the coupon), or free above the store's amount
create or replace function public.sf_delivery_price(s public.stores, p_net numeric) returns numeric
language sql immutable set search_path = public as $$
  select case when s.free_delivery_over is not null and p_net >= s.free_delivery_over then 0 else s.delivery_price end
$$;
revoke execute on function public.sf_delivery_price(public.stores, numeric) from public, anon, authenticated;

-- the cart as the shopper sees it: each line with today's price and whether it can still be bought, the sum, the coupon,
-- the ways to get the goods and whether the checkout is open
create or replace function public.sf_cart_view(s public.stores, c public.store_carts) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare lines jsonb := '[]'; sub numeric := 0; n int := 0; bad int := 0; cp jsonb; disc numeric := 0; l record; pr numeric; free int; problem text;
begin
  if c.id is not null then
    for l in
      select cl.qty, cl.item_id, cl.variant_id, i as itm, v as var
        from public.store_cart_lines cl
        join public.catalog_items i on i.id = cl.item_id
        left join public.catalog_variants v on v.id = cl.variant_id
       where cl.cart_id = c.id and cl.qty > 0
       order by cl.added_at, cl.item_id, cl.variant_id
    loop
      problem := null; free := null;
      if (l.itm).business_id <> s.business_id or not (l.itm).publish_online or not (l.itm).active or (l.itm).slug is null
         or ((l.itm).has_variants and ((l.var).id is null or not (l.var).active or (l.var).item_id <> (l.itm).id))
         or (not (l.itm).has_variants and l.variant_id is not null) then
        problem := 'gone';
      end if;
      pr := public.sf_line_price(l.itm, l.var);
      if pr is null then problem := 'gone'; end if;
      if problem is null and (l.itm).track_stock then
        free := case when (l.var).id is not null then (l.var).stock_qty else (l.itm).stock_qty end
                - public.sf_reserved((l.itm).id, (l.var).id);
        if free <= 0 then problem := 'out'; elsif free < l.qty then problem := 'short'; end if;
      end if;
      if problem is null then sub := sub + pr * l.qty; n := n + l.qty; else bad := bad + 1; end if;
      lines := lines || jsonb_build_object(
        'item', l.item_id, 'variant', l.variant_id, 'qty', l.qty, 'slug', (l.itm).slug, 'name', (l.itm).name,
        'variant_label', case when (l.var).id is not null then concat_ws(' / ', nullif((l.var).option1, ''), nullif((l.var).option2, ''), nullif((l.var).option3, '')) else '' end,
        'price', trim_scale(pr), 'line_total', case when problem is null then trim_scale(pr * l.qty) end,
        'image', public.sf_image((l.itm).id, (l.itm).image_url),
        'available', case when free is not null and s.show_stock_count then greatest(free, 0) end,
        'max', case when free is not null then least(greatest(free, 0), 20) else 20 end,
        'problem', problem);
    end loop;
    cp := public.sf_coupon_eval(s, c.coupon_code, sub);
    disc := coalesce((cp->>'discount')::numeric, 0);
  end if;
  return jsonb_build_object(
    'lines', lines, 'count', n, 'subtotal', trim_scale(sub), 'coupon', cp, 'discount', trim_scale(disc), 'currency', s.currency,
    'problems', bad,
    'shipping', jsonb_build_object(
      'pickup', case when s.pickup_enabled then jsonb_build_object('price', 0, 'note', s.pickup_note) end,
      'delivery', case when s.delivery_enabled then jsonb_build_object(
                    'price', trim_scale(public.sf_delivery_price(s, sub - disc)), 'base', trim_scale(s.delivery_price),
                    'free_over', trim_scale(s.free_delivery_over), 'note', s.delivery_note) end),
    'can_checkout', public.sf_can_buy(s) and n > 0 and bad = 0,
    'test', coalesce((select a.mode = 'test' from public.payment_accounts a where a.business_id = s.business_id), true));
end $$;
revoke execute on function public.sf_cart_view(public.stores, public.store_carts) from public, anon, authenticated;

-- the shopper's cart (an empty one when the cookie names none)
create or replace function public.sf_cart(p_store uuid, p_cart text, p_preview boolean default false) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s public.stores; c public.store_carts;
begin
  s := public.sf_selling_store(p_store, p_preview);
  if s.id is null then return null; end if;
  select * into c from public.store_carts where token_hash = p_cart and store_id = s.id;
  return public.sf_cart_view(s, c);
end $$;

-- add / change / remove (qty 0) a product in the cart. The product must be on the site, of this store; a product with
-- variants needs one of its active variants; no more than is available, 20 of a line, 30 lines.
-- {ok, cart} or {ok: false, error: 'gone' | 'variant' | 'not_enough' | 'max_qty' | 'max_lines' | 'cart', available}
create or replace function public.sf_cart_set(p_store uuid, p_cart text, p_item uuid, p_variant uuid, p_qty int,
                                              p_mode text default 'set', p_preview boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.stores; c public.store_carts; i public.catalog_items; v public.catalog_variants; cur int; want int; free int;
begin
  s := public.sf_selling_store(p_store, p_preview);
  if s.id is null then return jsonb_build_object('ok', false, 'error', 'store'); end if;
  if coalesce(p_cart, '') !~ '^[0-9a-f]{64}$' or p_qty is null or p_qty < 0 or p_mode not in ('set', 'add') then
    return jsonb_build_object('ok', false, 'error', 'bad_request');
  end if;
  select * into i from public.catalog_items where id = p_item and business_id = s.business_id and publish_online and active and slug is not null;
  if i.id is null then return jsonb_build_object('ok', false, 'error', 'gone'); end if;
  if i.has_variants then
    select * into v from public.catalog_variants where id = p_variant and item_id = i.id and active;
    if v.id is null then return jsonb_build_object('ok', false, 'error', 'variant'); end if;
  elsif p_variant is not null then
    return jsonb_build_object('ok', false, 'error', 'variant');
  end if;
  if public.sf_line_price(i, v) is null then return jsonb_build_object('ok', false, 'error', 'gone'); end if;

  insert into public.store_carts (business_id, store_id, token_hash) values (s.business_id, s.id, p_cart)
  on conflict (token_hash) do nothing;
  select * into c from public.store_carts where token_hash = p_cart for update;
  if c.store_id <> s.id then return jsonb_build_object('ok', false, 'error', 'cart'); end if;

  select qty into cur from public.store_cart_lines where cart_id = c.id and item_id = i.id and variant_id is not distinct from v.id;
  want := case p_mode when 'add' then coalesce(cur, 0) + p_qty else p_qty end;
  if want > 20 then return jsonb_build_object('ok', false, 'error', 'max_qty', 'max', 20); end if;
  if want > 0 and coalesce(cur, 0) = 0
     and (select count(*) from public.store_cart_lines where cart_id = c.id and qty > 0) >= 30 then
    return jsonb_build_object('ok', false, 'error', 'max_lines');
  end if;
  if want > coalesce(cur, 0) and i.track_stock then
    free := case when v.id is not null then v.stock_qty else i.stock_qty end - public.sf_reserved(i.id, v.id);
    if want > free then
      return jsonb_build_object('ok', false, 'error', 'not_enough', 'available', greatest(free, 0));
    end if;
  end if;
  insert into public.store_cart_lines (cart_id, item_id, variant_id, qty) values (c.id, i.id, v.id, want)
  on conflict (cart_id, item_id, variant_id) do update
    set qty = excluded.qty, updated_at = now(),
        added_at = case when store_cart_lines.qty = 0 then now() else store_cart_lines.added_at end;
  update public.store_carts set updated_at = now() where id = c.id returning * into c;
  return jsonb_build_object('ok', true, 'cart', public.sf_cart_view(s, c));
end $$;

-- the cart's coupon ('' removes it): {ok, cart} or {ok: false, error, cart}
create or replace function public.sf_cart_coupon(p_store uuid, p_cart text, p_code text, p_preview boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.stores; c public.store_carts; code text := upper(btrim(coalesce(p_code, ''))); v jsonb; cp jsonb;
begin
  s := public.sf_selling_store(p_store, p_preview);
  if s.id is null then return jsonb_build_object('ok', false, 'error', 'store'); end if;
  select * into c from public.store_carts where token_hash = p_cart and store_id = s.id for update;
  if c.id is null then return jsonb_build_object('ok', false, 'error', 'empty'); end if;
  if code <> '' and code !~ '^[A-Z0-9_-]{3,30}$' then
    return jsonb_build_object('ok', false, 'error', 'not_found', 'cart', public.sf_cart_view(s, c));
  end if;
  if code <> '' then
    v := public.sf_cart_view(s, c);
    cp := public.sf_coupon_eval(s, code, (v->>'subtotal')::numeric);
    if cp ? 'error' then return jsonb_build_object('ok', false, 'error', cp->>'error', 'min', cp->'min', 'cart', v); end if;
  end if;
  update public.store_carts set coupon_code = code, updated_at = now() where id = c.id returning * into c;
  return jsonb_build_object('ok', true, 'cart', public.sf_cart_view(s, c));
end $$;

-- a line of the order's timeline
create or replace function public.order_event(p_order uuid, p_kind text, p_data jsonb default '{}') returns void
language sql security definer set search_path = public as $$
  insert into public.order_events (order_id, business_id, kind, data)
  select o.id, o.business_id, p_kind, coalesce(p_data, '{}'::jsonb) from public.orders o where o.id = p_order
$$;
revoke execute on function public.order_event(uuid, text, jsonb) from public, anon, authenticated;

-- "לתשלום": checks the customer's details, locks the products (in id order — the register's sales lock the same rows), checks
-- every line is available after what is already held, computes the amount here (prices, coupon, delivery), numbers the
-- order and holds its units until it expires. All lines or none.
-- {ok, order, account} or {ok: false, error: 'store' | 'checkout_off' | 'payment' | 'live_not_yet' | 'empty' | 'details'
--  (fields) | 'too_many_open' | 'stock' (lines) | 'coupon' (reason) | 'zero_total'}
create or replace function public.sf_checkout_start(p_store uuid, p_cart text, p_order_token text, p_customer jsonb,
                                                    p_ip_hash text default '', p_preview boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s public.stores; c public.store_carts; a public.payment_accounts; o public.orders; l record; cp jsonb;
  bad jsonb := '[]'; fields text[] := '{}'; free int; pr numeric; sub numeric := 0; disc numeric := 0; ship numeric := 0;
  name text := btrim(coalesce(p_customer->>'name', ''));
  phone text := regexp_replace(coalesce(p_customer->>'phone', ''), '[^0-9+]', '', 'g');
  email text := lower(btrim(coalesce(p_customer->>'email', '')));
  method text := coalesce(p_customer->>'method', '');
  addr jsonb := '{}'; num int; pos int := 0;
begin
  s := public.sf_selling_store(p_store, p_preview);
  if s.id is null then return jsonb_build_object('ok', false, 'error', 'store'); end if;
  if not s.checkout_enabled then return jsonb_build_object('ok', false, 'error', 'checkout_off'); end if;
  select * into a from public.payment_accounts where business_id = s.business_id;
  if a.business_id is null then return jsonb_build_object('ok', false, 'error', 'payment'); end if;
  if a.mode <> 'test' then return jsonb_build_object('ok', false, 'error', 'live_not_yet'); end if;   -- stage 4
  if coalesce(p_order_token, '') !~ '^[0-9a-f]{64}$' then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  select * into c from public.store_carts where token_hash = p_cart and store_id = s.id;
  if c.id is null or not exists (select 1 from public.store_cart_lines where cart_id = c.id and qty > 0) then
    return jsonb_build_object('ok', false, 'error', 'empty');
  end if;

  -- the customer's details
  if length(name) not between 2 and 80 then fields := array_append(fields, 'name'); end if;
  if phone ~ '^\+?972[0-9]{8,9}$' then phone := regexp_replace(phone, '^\+?972', '0'); end if;   -- +972 50… → 050…
  if phone !~ '^0[0-9]{8,9}$' and phone !~ '^\+[0-9]{9,15}$' then fields := array_append(fields, 'phone'); end if;
  if length(email) > 120 or email !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' then fields := array_append(fields, 'email'); end if;
  if method = 'pickup' and not s.pickup_enabled or method = 'delivery' and not s.delivery_enabled or method not in ('pickup', 'delivery') then
    fields := array_append(fields, 'method');
  end if;
  if method = 'delivery' then
    addr := jsonb_build_object('city', btrim(coalesce(p_customer->>'city', '')), 'street', btrim(coalesce(p_customer->>'street', '')),
                               'house', btrim(coalesce(p_customer->>'house', '')), 'apartment', btrim(coalesce(p_customer->>'apartment', '')));
    if length(addr->>'city') not between 2 and 60 then fields := array_append(fields, 'city'); end if;
    if length(addr->>'street') not between 2 and 80 then fields := array_append(fields, 'street'); end if;
    if length(addr->>'house') not between 1 and 10 then fields := array_append(fields, 'house'); end if;
    if length(addr->>'apartment') > 10 then fields := array_append(fields, 'apartment'); end if;
  end if;
  if length(coalesce(p_customer->>'notes', '')) > 500 then fields := array_append(fields, 'notes'); end if;
  if coalesce(p_customer->>'terms', '') <> 'true' then fields := array_append(fields, 'terms'); end if;
  if cardinality(fields) > 0 then return jsonb_build_object('ok', false, 'error', 'details', 'fields', to_jsonb(fields)); end if;

  -- a few open orders per shopper at a time: holding a store's stock is not a game
  if coalesce(p_ip_hash, '') <> '' and (select count(*) from public.orders x where x.store_id = s.id and x.ip_hash = p_ip_hash
                                          and x.payment_status = 'pending' and x.expires_at > now()) >= 3 then
    return jsonb_build_object('ok', false, 'error', 'too_many_open');
  end if;

  -- lock the products, then check what is left of each after what is held
  perform 1 from public.catalog_items i
    where i.id in (select cl.item_id from public.store_cart_lines cl where cl.cart_id = c.id and cl.qty > 0)
    order by i.id for update;
  for l in
    select cl.qty, cl.item_id, cl.variant_id, i as itm, v as var
      from public.store_cart_lines cl
      join public.catalog_items i on i.id = cl.item_id
      left join public.catalog_variants v on v.id = cl.variant_id
     where cl.cart_id = c.id and cl.qty > 0
     order by cl.added_at, cl.item_id, cl.variant_id
  loop
    pr := public.sf_line_price(l.itm, l.var);
    if (l.itm).business_id <> s.business_id or not (l.itm).publish_online or not (l.itm).active or (l.itm).slug is null or pr is null
       or ((l.itm).has_variants and ((l.var).id is null or not (l.var).active or (l.var).item_id <> (l.itm).id))
       or (not (l.itm).has_variants and l.variant_id is not null) then
      bad := bad || jsonb_build_object('item', l.item_id, 'variant', l.variant_id, 'name', (l.itm).name, 'available', 0);
      continue;
    end if;
    if (l.itm).track_stock then
      free := case when (l.var).id is not null then (l.var).stock_qty else (l.itm).stock_qty end - public.sf_reserved((l.itm).id, (l.var).id);
      if l.qty > free then
        bad := bad || jsonb_build_object('item', l.item_id, 'variant', l.variant_id, 'name', (l.itm).name, 'available', greatest(free, 0));
        continue;
      end if;
    end if;
    sub := sub + pr * l.qty;
  end loop;
  if jsonb_array_length(bad) > 0 then return jsonb_build_object('ok', false, 'error', 'stock', 'lines', bad); end if;

  cp := public.sf_coupon_eval(s, c.coupon_code, sub);
  if cp ? 'error' then return jsonb_build_object('ok', false, 'error', 'coupon', 'reason', cp->>'error', 'min', cp->'min'); end if;
  disc := coalesce((cp->>'discount')::numeric, 0);
  ship := case when method = 'delivery' then public.sf_delivery_price(s, sub - disc) else 0 end;
  if sub - disc + ship <= 0 then return jsonb_build_object('ok', false, 'error', 'zero_total'); end if;

  insert into public.store_order_counters (business_id, last) values (s.business_id, 1001)
  on conflict (business_id) do update set last = store_order_counters.last + 1 returning last into num;
  insert into public.orders (business_id, store_id, number, token_hash, cart_id, is_test, currency, subtotal, discount, shipping, total,
                             coupon_code, customer_name, customer_phone, customer_email, delivery_method, address, notes,
                             terms_accepted_at, provider, expires_at, ip_hash)
  values (s.business_id, s.id, num, p_order_token, c.id, true, s.currency, sub, disc, ship, sub - disc + ship,
          coalesce(cp->>'code', ''), name, phone, email, method, addr, btrim(coalesce(p_customer->>'notes', '')),
          now(), a.provider, now() + make_interval(mins => s.reserve_minutes), left(coalesce(p_ip_hash, ''), 64))
  returning * into o;

  for l in
    select cl.qty, cl.item_id, cl.variant_id, i as itm, v as var
      from public.store_cart_lines cl
      join public.catalog_items i on i.id = cl.item_id
      left join public.catalog_variants v on v.id = cl.variant_id
     where cl.cart_id = c.id and cl.qty > 0
     order by cl.added_at, cl.item_id, cl.variant_id
  loop
    pos := pos + 1;
    pr := public.sf_line_price(l.itm, l.var);
    insert into public.order_lines (order_id, business_id, item_id, variant_id, name, variant_label, sku, image_url, unit_price, qty, line_total, position)
    values (o.id, s.business_id, l.item_id, l.variant_id, (l.itm).name,
            case when (l.var).id is not null then concat_ws(' / ', nullif((l.var).option1, ''), nullif((l.var).option2, ''), nullif((l.var).option3, '')) else '' end,
            coalesce(nullif((l.var).sku, ''), (l.itm).sku, ''),
            coalesce(public.sf_image((l.itm).id, (l.itm).image_url)->>'url', ''),
            pr, l.qty, pr * l.qty, pos);
    if (l.itm).track_stock then
      insert into public.stock_reservations (business_id, order_id, item_id, variant_id, qty, expires_at)
      values (s.business_id, o.id, l.item_id, l.variant_id, l.qty, o.expires_at);
    end if;
  end loop;
  perform public.order_event(o.id, 'created', jsonb_build_object('total', o.total, 'test', o.is_test, 'expires_at', o.expires_at));

  return jsonb_build_object('ok', true,
    'order', jsonb_build_object('id', o.id, 'number', o.number, 'total', trim_scale(o.total), 'currency', o.currency,
               'name', o.customer_name, 'email', o.customer_email, 'phone', o.customer_phone, 'expires_at', o.expires_at,
               'lines', (select jsonb_agg(jsonb_build_object('name', x.name || case when x.variant_label <> '' then ' — ' || x.variant_label else '' end,
                                                            'qty', x.qty, 'price', trim_scale(x.unit_price)) order by x.position)
                           from public.order_lines x where x.order_id = o.id),
               'shipping', trim_scale(o.shipping), 'discount', trim_scale(o.discount)),
    'account', jsonb_build_object('provider', a.provider, 'mode', a.mode, 'sealed', a.sealed, 'page_uid', a.page_uid));
end $$;

-- the provider made the payment page: its id is kept (to ask the provider about it later)
create or replace function public.sf_order_page(p_store uuid, p_order uuid, p_page text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.orders set provider_page = left(coalesce(p_page, ''), 120), updated_at = now()
   where id = p_order and store_id = p_store and payment_status = 'pending' and provider_page = '';
  if found then perform public.order_event(p_order, 'payment_page', '{}'); end if;
end $$;

-- the business's terminal, for the storefront's server (sealed: only that server opens it)
create or replace function public.sf_payment_account(p_store uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('provider', a.provider, 'mode', a.mode, 'sealed', a.sealed, 'page_uid', a.page_uid)
    from public.stores s join public.payment_accounts a on a.business_id = s.business_id where s.id = p_store
$$;

-- a notice / a check of a payment, once: true when it is new (a repeated or replayed one returns false and changes nothing)
create or replace function public.sf_payment_event(p_store uuid, p_order uuid, p_provider text, p_key text, p_kind text,
                                                   p_signature_ok boolean, p_payload jsonb) returns boolean
language plpgsql security definer set search_path = public as $$
declare b uuid; o uuid; n int;
begin
  select business_id into b from public.stores where id = p_store;
  if b is null then return false; end if;
  select id into o from public.orders where id = p_order and store_id = p_store;
  insert into public.payment_events (business_id, order_id, provider, event_key, kind, signature_ok, payload)
  values (b, o, p_provider, left(p_key, 200), p_kind, p_signature_ok, coalesce(p_payload, '{}'::jsonb))
  on conflict (event_key) do nothing;
  get diagnostics n = row_count;
  return n = 1;
end $$;

-- the provider confirmed (by a direct question, never by a notice alone) that this transaction paid this order.
-- Locks the order: the same transaction again → 'already'; another transaction → 'double' (logged, nothing changes); a
-- different amount or currency → 'mismatch' (logged, nothing changes). Stage 3 (test): the order becomes test_paid, its units
-- are released, the coupon counts one use, the cart empties — no sale, no stock movement, no document, no customer.
create or replace function public.sf_order_paid(p_store uuid, p_order uuid, p_provider text, p_txn text, p_amount numeric, p_currency text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o public.orders; was text;
begin
  select * into o from public.orders where id = p_order and store_id = p_store for update;
  if o.id is null then return jsonb_build_object('result', 'not_found'); end if;
  if o.provider <> p_provider or coalesce(p_txn, '') = '' then
    perform public.order_event(o.id, 'payment_rejected', jsonb_build_object('reason', 'provider', 'provider', p_provider));
    return jsonb_build_object('result', 'rejected');
  end if;
  if o.payment_status in ('paid', 'test_paid', 'refunded', 'partially_refunded') then
    if o.provider_txn = p_txn then return jsonb_build_object('result', 'already', 'status', o.payment_status); end if;
    perform public.order_event(o.id, 'double_payment', jsonb_build_object('txn', p_txn, 'amount', p_amount));
    return jsonb_build_object('result', 'double', 'status', o.payment_status);
  end if;
  if p_amount is distinct from o.total or upper(coalesce(p_currency, '')) <> o.currency then
    perform public.order_event(o.id, 'amount_mismatch', jsonb_build_object('txn', p_txn, 'amount', p_amount, 'currency', p_currency));
    return jsonb_build_object('result', 'mismatch', 'status', o.payment_status);
  end if;
  if not o.is_test then raise exception 'live payments are recorded from stage 4' using errcode = '0A000'; end if;
  was := o.payment_status;
  update public.orders set payment_status = 'test_paid', provider_txn = p_txn, paid_at = now(), updated_at = now() where id = o.id;
  update public.stock_reservations set status = 'released', updated_at = now() where order_id = o.id and status in ('held', 'paid');
  if o.coupon_code <> '' then
    update public.store_coupons set used_count = used_count + 1 where store_id = o.store_id and code = o.coupon_code;
  end if;
  if o.cart_id is not null then update public.store_cart_lines set qty = 0, updated_at = now() where cart_id = o.cart_id and qty > 0; end if;
  perform public.order_event(o.id, 'test_paid', jsonb_build_object('txn', p_txn, 'amount', p_amount, 'late', was <> 'pending'));
  return jsonb_build_object('result', 'ok', 'status', 'test_paid');
end $$;

-- the provider said the payment failed or was cancelled: the order fails and its units go back on sale
create or replace function public.sf_order_failed(p_store uuid, p_order uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o public.orders;
begin
  select * into o from public.orders where id = p_order and store_id = p_store for update;
  if o.id is null then return jsonb_build_object('result', 'not_found'); end if;
  if o.payment_status <> 'pending' then return jsonb_build_object('result', 'ignored', 'status', o.payment_status); end if;
  update public.orders set payment_status = 'failed', failed_at = now(), updated_at = now() where id = o.id;
  update public.stock_reservations set status = 'released', updated_at = now() where order_id = o.id and status = 'held';
  perform public.order_event(o.id, 'failed', jsonb_build_object('reason', left(coalesce(p_reason, ''), 120)));
  return jsonb_build_object('result', 'ok', 'status', 'failed');
end $$;

-- an order as its page shows it (the customer's link, or the server by id)
create or replace function public.sf_order_view(o public.orders) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', o.id, 'number', o.number, 'status', o.payment_status, 'test', o.is_test, 'currency', o.currency,
    'subtotal', trim_scale(o.subtotal), 'discount', trim_scale(o.discount), 'shipping', trim_scale(o.shipping), 'total', trim_scale(o.total),
    'coupon', o.coupon_code, 'method', o.delivery_method, 'name', o.customer_name, 'provider', o.provider, 'page', o.provider_page,
    'created_at', o.created_at, 'expires_at', o.expires_at, 'paid_at', o.paid_at,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('name', x.name, 'variant', x.variant_label, 'qty', x.qty,
                                                           'price', trim_scale(x.unit_price), 'total', trim_scale(x.line_total), 'image', x.image_url)
                                        order by x.position) from public.order_lines x where x.order_id = o.id), '[]'::jsonb))
$$;
revoke execute on function public.sf_order_view(public.orders) from public, anon, authenticated;

create or replace function public.sf_order(p_store uuid, p_order_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select public.sf_order_view(o) from public.orders o where o.token_hash = p_order_token and o.store_id = p_store
$$;
create or replace function public.sf_order_by_id(p_store uuid, p_order uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select public.sf_order_view(o) from public.orders o where o.id = p_order and o.store_id = p_store
$$;

-- orders whose payment was not confirmed after 10 minutes (no notice came): the storefront's cron asks the provider
create or replace function public.sf_orders_unconfirmed(p_limit int default 50) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('store', x.store_id, 'id', x.id)), '[]'::jsonb) from (
    select o.store_id, o.id from public.orders o
     where o.payment_status in ('pending', 'expired') and o.provider_page <> ''
       and o.created_at < now() - interval '10 minutes' and o.created_at > now() - interval '2 days'
     order by o.created_at limit least(greatest(coalesce(p_limit, 50), 1), 200)) x
$$;

-- holds that ran out go back on sale; an order nobody paid 15 minutes after its hold ran out is "expired" (a payment that
-- still comes is accepted: a paid order is never lost). Every minute from pg_cron (supabase/cron-commerce.sql).
create or replace function public.store_release_expired() returns int
language plpgsql security definer set search_path = public as $$
declare n int; o record;
begin
  update public.stock_reservations set status = 'released', updated_at = now() where status = 'held' and expires_at <= now();
  get diagnostics n = row_count;
  for o in update public.orders set payment_status = 'expired', updated_at = now()
            where payment_status = 'pending' and expires_at < now() - interval '15 minutes' returning id loop
    perform public.order_event(o.id, 'expired', '{}');
  end loop;
  return n;
end $$;
revoke execute on function public.store_release_expired() from public, anon, authenticated;
grant execute on function public.store_release_expired() to service_role;

-- one request counted against a limit: true while within it (p_max per p_window seconds)
create or replace function public.sf_rate_hit(p_key text, p_window int, p_max int) returns boolean
language plpgsql security definer set search_path = public as $$
declare ws timestamptz; n int;
begin
  ws := to_timestamp(floor(extract(epoch from now()) / greatest(p_window, 1)) * greatest(p_window, 1));
  insert into public.rate_limits (key, window_start, hits) values (left(p_key, 200), ws, 1)
  on conflict (key, window_start) do update set hits = rate_limits.hits + 1 returning hits into n;
  return n <= p_max;
end $$;

do $$
declare f text;
begin
  foreach f in array array['public.sf_store(uuid, boolean)', 'public.sf_product(uuid, text, boolean)', 'public.sf_cart(uuid, text, boolean)',
    'public.sf_cart_set(uuid, text, uuid, uuid, int, text, boolean)', 'public.sf_cart_coupon(uuid, text, text, boolean)',
    'public.sf_checkout_start(uuid, text, text, jsonb, text, boolean)', 'public.sf_order_page(uuid, uuid, text)',
    'public.sf_payment_account(uuid)', 'public.sf_payment_event(uuid, uuid, text, text, text, boolean, jsonb)',
    'public.sf_order_paid(uuid, uuid, text, text, numeric, text)', 'public.sf_order_failed(uuid, uuid, text)',
    'public.sf_order(uuid, text)', 'public.sf_order_by_id(uuid, uuid)', 'public.sf_orders_unconfirmed(int)',
    'public.sf_rate_hit(text, int, int)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- ============================================================================================================================
-- Rollback (by hand, if ever needed): the triggers c_sales_reserved (sales), c_stores_checkout_guard (stores),
-- a_fill_from_store and b_store_coupons_touch (store_coupons); the functions of this file (sf_cart*, sf_checkout_start,
-- sf_order*, sf_payment_*, sf_rate_hit, sf_reserved, sf_line_price, sf_selling_store, sf_coupon_eval, sf_delivery_price,
-- sf_cart_view, order_event, reserved_stock, stock_reserved_conflict, sales_reserved_guard, store_payment_ready,
-- stores_checkout_guard, store_coupons_touch, store_release_expired) — and sf_prices / sf_product back to their text in
-- 20261005003400; the tables rate_limits, payment_events, payment_accounts, stock_reservations, order_events, order_lines,
-- orders, store_order_counters, store_cart_lines, store_carts, store_coupons; the new columns of stores and their check.
-- ============================================================================================================================
