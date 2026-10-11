-- 2.93.0 — advanced items and reports by location (docs/FINANCE_ADDITIONS_HE.md T12ג + T12ד). Runs after 20261010004600_locations
-- and 20261011004700_stock_locations (it stops at the top without them, changing nothing). No row that is there is removed or
-- changed: every product is as it was (no serial numbers, no price list, no SKU series) until the business sets one.
--   1. serial numbers   a product marked "with a serial number" (catalog_items.track_serials — a product whose stock is counted,
--                       not sold on the site yet): every unit has its own number (catalog_serials) and its own history
--                       (catalog_serial_events). Units come in with their numbers (serial_receive — new units, or units already in
--                       stock), are sold at the register by number (each in stock at that location, sold once — the DoD), go
--                       between locations in a transfer by number, come back on a cancel or a refund by number, and only the owner
--                       writes one off. Its units move only that way: stock_move_at refuses any other move of such a product (a
--                       delivery or a count without numbers, a document or an expense of it); undoing a document or an expense that
--                       moved it before it had numbers still moves it back. A stock count does not count it (it is checked by number).
--   2. price lists      price_lists (a location's, or a customer group's — the customers with a tag of the CRM) and their prices
--                       (price_list_items, per item or per variant). The base price list is the catalog's own price. The screens
--                       pick the price: the customer's group, else the location's, else the base; changing it by hand stays
--                       with whoever may write the money (documents), as before.
--   3. SKU series       sku_series — a category of SKUs with its own prefix and counter ("JW" → JW-0001, JW-0002 …); sku_next hands
--                       out the next free code, under the catalog's code lock (never one that a product already has).
--   4. comparing        location_compare(from, to) — each location the member may use, side by side: revenue and estimated profit
--                       (finance_summary's own rules), sales and refunds, the best-selling products, and the stock (units and their
--                       value at the selling price). Every report of finance already follows the location picked at the top
--                       (finance_summary reads through the location gates of 4600).
-- Written only through the functions here (no table is written by the screens); read through policies (the business; a cashier
-- reads price lists and serial numbers — the register needs them — and nothing of the comparison, a money report).
-- Locks: every path that moves a product with serial numbers locks the products first (by id, as every mover) and then the numbers
-- (by id) — two sales, a sale and a transfer, never wait on each other in a circle.
-- Tests: tests/sql/items-lists.check.sql, tests/sql/concurrency.sh §19, tests/sql/stock-compare.sh (one location, without and with
-- this file: the same day). Rollback: see the end.

do $$
begin
  if to_regclass('public.stock_levels') is null or to_regclass('public.business_locations') is null then
    raise exception 'run 20261010004600_locations and 20261011004700_stock_locations first';
  end if;
end $$;

-- ---- 1. serial numbers ----------------------------------------------------------------------------------------------------------
alter table public.catalog_items add column if not exists track_serials boolean not null default false;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'catalog_items_serials_check' and conrelid = 'public.catalog_items'::regclass) then
    -- a product with serial numbers: a product, its stock counted, not sold on the site (its numbers are picked at the register)
    alter table public.catalog_items add constraint catalog_items_serials_check
      check (not track_serials or (kind = 'product' and track_stock and not publish_online));
  end if;
end $$;

create table if not exists public.catalog_serials (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses on delete restrict,
  item_id     uuid not null references public.catalog_items on delete restrict,
  variant_id  uuid references public.catalog_variants on delete restrict,
  serial      text not null check (length(serial) between 1 and 64 and serial = btrim(serial)),
  status      text not null default 'in_stock' check (status in ('in_stock', 'in_transit', 'sold', 'returned', 'removed')),
  location_id uuid not null,                     -- where it is (in_stock), left from (in_transit), was sold or came back
  sale_id     uuid,                              -- the sale that holds it (sold)
  received_at timestamptz not null default now(),
  received_by uuid references auth.users on delete set null,
  updated_at  timestamptz not null default now(),
  foreign key (location_id, business_id) references public.business_locations (id, business_id) on delete restrict
);
create unique index if not exists catalog_serials_uq on public.catalog_serials (business_id, item_id, lower(serial));
create index if not exists catalog_serials_search_idx on public.catalog_serials (business_id, lower(serial));
create index if not exists catalog_serials_item_idx on public.catalog_serials (item_id, variant_id, status);
create index if not exists catalog_serials_sale_idx on public.catalog_serials (sale_id) where sale_id is not null;

create table if not exists public.catalog_serial_events (
  id          bigint generated always as identity primary key,
  business_id uuid not null references public.businesses on delete restrict,
  serial_id   uuid not null references public.catalog_serials on delete restrict,
  kind        text not null check (kind in ('received', 'registered', 'sold', 'cancelled', 'returned', 'removed',
                                            'transfer_sent', 'transfer_received', 'transfer_missing', 'transfer_cancelled')),
  location_id uuid,
  sale_id     uuid,
  refund_id   uuid,
  transfer_id uuid references public.stock_transfers on delete restrict,
  note        text not null default '' check (length(note) <= 200),
  by_user     uuid references auth.users on delete set null default auth.uid(),
  at          timestamptz not null default now()
);
create index if not exists catalog_serial_events_serial_idx on public.catalog_serial_events (serial_id, at);
create index if not exists catalog_serial_events_sale_idx on public.catalog_serial_events (sale_id) where sale_id is not null;

-- a member who may write (not a cashier, not a viewer) of the business worked in now — as stock_writer (4700)
create or replace function public.items_writer() returns uuid
language sql stable security definer set search_path = public as $$ select public.stock_writer() $$;
revoke execute on function public.items_writer() from public, anon, authenticated;

-- the serial numbers of a list as the screens send them (one per line, typed or scanned): trimmed, not empty, each once
create or replace function public.serial_list(p_serials text[]) returns text[]
language plpgsql immutable set search_path = public as $$
declare out text[] := '{}'; s text; t text;
begin
  foreach s in array coalesce(p_serials, '{}') loop
    t := btrim(coalesce(s, ''));
    continue when t = '';
    if length(t) > 64 then raise exception 'serial_long: %', left(t, 64) using errcode = '22023'; end if;
    if exists (select 1 from unnest(out) x where lower(x) = lower(t)) then raise exception 'serial_twice: %', t using errcode = '22023'; end if;
    out := out || t;
  end loop;
  return out;
end $$;

-- the stock mover of 4700, with one rule more: a product with serial numbers moves only with them (the functions below allow it
-- for the moment of their move — dp.serial_move, local to the transaction; nothing a screen can set). Undoing what a document or
-- an expense moved (its cancellation, its void) still moves: such a product never moves forward on one (refused here), so what
-- comes back is units of before it had numbers — units without a number, as any unit counted before.
create or replace function public.stock_move_at(p_business uuid, p_location uuid, p_item uuid, p_variant uuid, p_delta int, p_reason text,
    p_note text, p_sale uuid, p_refund uuid, p_document uuid, p_expense uuid, p_transfer uuid, p_count uuid)
returns void language plpgsql security definer set search_path = public as $$
declare q int; vq int; v uuid; hv boolean; ts boolean; n text := coalesce(p_note, ''); loc uuid := coalesce(p_location, p_business); la int;
begin
  if coalesce(p_delta, 0) = 0 then return; end if;
  if loc <> p_business and not exists (select 1 from public.business_locations l where l.id = loc and l.business_id = p_business) then
    raise exception 'stock_location: a location of the business' using errcode = '23503';
  end if;
  update public.catalog_items set stock_qty = stock_qty + p_delta
   where id = p_item and business_id = p_business and track_stock
   returning stock_qty, has_variants, track_serials into q, hv, ts;
  if not found then return; end if;            -- not tracked, another business's item, or deleted
  if ts and coalesce(current_setting('dp.serial_move', true), '') <> 'on'
     and not (p_document is not null and p_reason = 'cancel') and not (p_expense is not null and p_reason = 'adjust') then
    raise exception 'serial_item: a product with serial numbers moves with its numbers (received, sold, returned)' using errcode = '22023';
  end if;
  if p_variant is not null then
    update public.catalog_variants set stock_qty = stock_qty + p_delta
     where id = p_variant and item_id = p_item and business_id = p_business
     returning stock_qty into vq;
    if found then v := p_variant; end if;
  end if;
  if loc <> p_business then
    update public.stock_levels set qty = qty + p_delta, updated_at = now()
     where location_id = loc and item_id = p_item and variant_id is null returning qty into la;
    if not found then
      insert into public.stock_levels (business_id, location_id, item_id, variant_id, qty) values (p_business, loc, p_item, null, p_delta)
      returning qty into la;
    end if;
    if v is not null then
      update public.stock_levels set qty = qty + p_delta, updated_at = now()
       where location_id = loc and item_id = p_item and variant_id = v returning qty into la;
      if not found then
        insert into public.stock_levels (business_id, location_id, item_id, variant_id, qty) values (p_business, loc, p_item, v, p_delta)
        returning qty into la;
      end if;
    end if;
  else
    la := public.stock_at(loc, p_item, v);
  end if;
  if v is null and hv then n := 'לא משויך לווריאנט' || case when n <> '' then ' · ' || n else '' end; end if;
  insert into public.stock_movements (user_id, business_id, item_id, variant_id, delta, qty_after, reason, sale_id, refund_id, document_id,
                                      expense_id, note, location_id, location_after, transfer_id, count_id)
  values (auth.uid(), p_business, p_item, v, p_delta, coalesce(vq, q), p_reason, p_sale, p_refund, p_document, p_expense, left(n, 200),
          loc, la, p_transfer, p_count);
end $$;
revoke execute on function public.stock_move_at(uuid, uuid, uuid, uuid, int, text, text, uuid, uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;

-- on / off: a product of the business (not on the site). On: not while its units are in an open stock count, on the way in a
-- transfer or held for an order of the site (each of those would move it without numbers). Off: only with no unit of it in stock
-- or on the way by number. The same again changes nothing.
create or replace function public.serial_tracking(p_item uuid, p_on boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b uuid := public.items_writer(); i record; n int;
begin
  select * into i from public.catalog_items where id = p_item for update;
  if i.id is null or i.business_id <> b then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_on is null then raise exception 'serial_tracking: on or off' using errcode = '22023'; end if;
  if i.track_serials = p_on then return jsonb_build_object('item', i.id, 'on', p_on, 'changed', false); end if;
  if p_on then
    if i.kind <> 'product' then raise exception 'serial_kind: only a product has serial numbers' using errcode = '22023'; end if;
    if i.publish_online then raise exception 'serial_online: a product with serial numbers is not sold on the site yet' using errcode = '22023'; end if;
    if exists (select 1 from public.stock_counts c where c.business_id = b and c.status = 'open'
                and exists (select 1 from jsonb_each(c.lines) e where e.value->>'itemId' = i.id::text)) then
      raise exception 'serial_counting: the product is in an open stock count' using errcode = '23514';
    end if;
    if exists (select 1 from public.stock_transfers t where t.business_id = b and t.status = 'sent'
                and exists (select 1 from jsonb_array_elements(t.lines) e where e->>'itemId' = i.id::text)) then
      raise exception 'serial_on_the_way: the product is on the way in a transfer' using errcode = '23514';
    end if;
    if exists (select 1 from public.stock_reservations r where r.business_id = b and r.item_id = i.id
                and (r.status = 'paid' or (r.status = 'held' and r.expires_at > now()))) then
      raise exception 'serial_reserved: units of it are held for an order of the site' using errcode = '23514';
    end if;
    update public.catalog_items set track_serials = true, track_stock = true where id = i.id;
  else
    select count(*) into n from public.catalog_serials s where s.item_id = i.id and s.status in ('in_stock', 'in_transit');
    if n > 0 then raise exception 'serial_in_stock: % units with serial numbers are in stock', n using errcode = '23514'; end if;
    update public.catalog_items set track_serials = false where id = i.id;
  end if;
  return jsonb_build_object('item', i.id, 'on', p_on, 'changed', true);
end $$;

-- the products of these lines, locked first (by id, as every mover locks them) — then their numbers may be locked
create or replace function public.serial_lock_items(p_business uuid, p_items jsonb) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.catalog_items c where c.business_id = p_business and c.track_serials
                  and c.id in (select x.item_id from public.stock_lines_v(p_items) x)) then
    return false;                                                -- no product with numbers: nothing else changes
  end if;
  perform 1 from public.catalog_items c where c.business_id = p_business and c.id in (select x.item_id from public.stock_lines_v(p_items) x)
   order by c.id for update;
  return true;
end $$;
revoke execute on function public.serial_lock_items(uuid, jsonb) from public, anon, authenticated;

-- units come in with their numbers: new units (the stock goes up, a "receive" move) or units already in stock (p_existing — no
-- move; not more than the location's count has without a number). Each number is new for the product.
create or replace function public.serial_receive(p_item uuid, p_variant uuid, p_location uuid, p_serials text[], p_existing boolean default false,
    p_note text default '') returns jsonb
language plpgsql security definer set search_path = public as $$
declare b uuid := public.items_writer(); i record; loc uuid; list text[] := public.serial_list(p_serials); n int; s text; sid uuid;
        free int; nm text := left(btrim(coalesce(p_note, '')), 200);
begin
  select * into i from public.catalog_items where id = p_item for update;      -- the item first, as every move
  if i.id is null or i.business_id <> b then raise exception 'not allowed' using errcode = '42501'; end if;
  if not i.track_serials then raise exception 'serial_untracked: the product has no serial numbers' using errcode = '22023'; end if;
  if p_variant is null and i.has_variants then raise exception 'variant_required: an item with variants is counted per variant' using errcode = '22023'; end if;
  if p_variant is not null and not exists (select 1 from public.catalog_variants v where v.id = p_variant and v.item_id = i.id) then
    raise exception 'variant_not_found: a variant of this item' using errcode = '22023';
  end if;
  loc := coalesce(p_location, b);
  if not exists (select 1 from public.business_locations l where l.id = loc and l.business_id = b) then
    raise exception 'stock_location: a location of the business' using errcode = '22023';
  end if;
  if not public.location_allowed(b, loc) then raise exception 'not allowed: this location is not yours' using errcode = '42501'; end if;
  n := coalesce(array_length(list, 1), 0);
  if n = 0 or n > 200 then raise exception 'serial_list: 1 to 200 serial numbers' using errcode = '22023'; end if;
  select s2 into s from unnest(list) s2
   where exists (select 1 from public.catalog_serials x where x.business_id = b and x.item_id = i.id and lower(x.serial) = lower(s2)) limit 1;
  if s is not null then raise exception 'serial_taken: %', s using errcode = '23505'; end if;
  if p_existing then
    free := public.stock_at(loc, i.id, p_variant)
            - (select count(*) from public.catalog_serials x where x.item_id = i.id and x.variant_id is not distinct from p_variant
                                                               and x.location_id = loc and x.status = 'in_stock')::int;
    if n > free then raise exception 'serial_more_than_stock: % units here have no number', greatest(free, 0) using errcode = '23514'; end if;
  end if;
  foreach s in array list loop
    insert into public.catalog_serials (business_id, item_id, variant_id, serial, location_id, received_by)
    values (b, i.id, p_variant, s, loc, auth.uid()) returning id into sid;
    insert into public.catalog_serial_events (business_id, serial_id, kind, location_id, note)
    values (b, sid, case when p_existing then 'registered' else 'received' end, loc, nm);
  end loop;
  if not p_existing then
    perform set_config('dp.serial_move', 'on', true);
    perform public.stock_move_at(b, loc, i.id, p_variant, n, 'receive',
      left('קליטה · ' || array_to_string(list, ', ') || case when nm <> '' then ' · ' || nm else '' end, 200), null, null, null, null, null, null);
    perform set_config('dp.serial_move', '', true);
  end if;
  return jsonb_build_object('count', n, 'stock', public.stock_at(loc, i.id, p_variant));
end $$;

-- a unit written off (lost, broken, a sample): the owner only — the stock goes down with no approval, as a count on the spot
create or replace function public.serial_remove(p_serial uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b uuid := public.items_writer(); r record; it uuid; why text := left(btrim(coalesce(p_reason, '')), 200);
begin
  if not public.location_owner() then
    raise exception 'not allowed: the owner counts on the spot (others count in a stock count the owner approves)' using errcode = '42501';
  end if;
  select item_id into it from public.catalog_serials where id = p_serial and business_id = b;
  if it is null then raise exception 'not allowed' using errcode = '42501'; end if;
  perform 1 from public.catalog_items where id = it for update;                  -- the product first, then its number
  select * into r from public.catalog_serials where id = p_serial for update;
  if r.status <> 'in_stock' then raise exception 'serial_not_in_stock: %', r.serial using errcode = '23514'; end if;
  if why = '' then raise exception 'serial_reason: why it leaves the stock' using errcode = '22023'; end if;
  update public.catalog_serials set status = 'removed', updated_at = now() where id = r.id;
  insert into public.catalog_serial_events (business_id, serial_id, kind, location_id, note) values (b, r.id, 'removed', r.location_id, why);
  perform set_config('dp.serial_move', 'on', true);
  perform public.stock_move_at(b, r.location_id, r.item_id, r.variant_id, -1, 'adjust', left('הוצאה · ' || r.serial || ' · ' || why, 200),
                               null, null, null, null, null, null);
  perform set_config('dp.serial_move', '', true);
  return jsonb_build_object('serial', r.serial, 'status', 'removed');
end $$;

-- a sale's units with numbers: at the register each one named — in stock at the sale's location, and sold once (the sale holds
-- it); the site names none (its products have no numbers — catalog_items_serials_check — and an order is never refused when it is
-- paid). The products first, then the numbers (by id).
create or replace function public.sale_serials_take(p_sale uuid, p_business uuid, p_location uuid, p_items jsonb, p_channel text)
returns void language plpgsql security definer set search_path = public as $$
declare e jsonb; it uuid; v uuid; q int; nm text; ts boolean; arr jsonb; s text; r record;
        lines jsonb := case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end;
begin
  if not public.serial_lock_items(p_business, lines) then return; end if;      -- no product with numbers: nothing to take
  perform 1 from public.catalog_serials x
   where x.business_id = p_business
     and (x.item_id, lower(x.serial)) in (
           select (e2->>'itemId')::uuid, lower(btrim(n #>> '{}'))
             from jsonb_array_elements(lines) e2
             cross join lateral jsonb_array_elements(case when jsonb_typeof(e2->'serials') = 'array' then e2->'serials' else '[]'::jsonb end) n
            where coalesce(e2->>'itemId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
   order by x.id for update;
  for e in select x from jsonb_array_elements(lines) x loop
    continue when coalesce(e->>'itemId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               or coalesce(e->>'qty', '') !~ '^[0-9]+(\.[0-9]+)?$';
    it := (e->>'itemId')::uuid;
    select c.track_serials, c.name into ts, nm from public.catalog_items c where c.id = it and c.business_id = p_business;
    continue when not coalesce(ts, false);
    q := floor((e->>'qty')::numeric)::int;
    continue when q <= 0;
    arr := case when jsonb_typeof(e->'serials') = 'array' then e->'serials' else '[]'::jsonb end;
    if jsonb_array_length(arr) = 0 and coalesce(p_channel, 'pos') <> 'pos' then continue; end if;
    if jsonb_array_length(arr) <> q then raise exception 'serial_required: %', nm using errcode = '22023'; end if;
    v := case when coalesce(e->>'variantId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (e->>'variantId')::uuid end;
    for s in select btrim(x #>> '{}') from jsonb_array_elements(arr) x loop
      r := null;
      select * into r from public.catalog_serials x where x.business_id = p_business and x.item_id = it and lower(x.serial) = lower(s);
      if r.id is null then raise exception 'serial_not_found: %', s using errcode = '22023'; end if;
      if r.variant_id is distinct from v then raise exception 'serial_variant: %', s using errcode = '22023'; end if;
      if r.status = 'sold' then raise exception 'serial_sold: %', s using errcode = '23514'; end if;
      if r.status <> 'in_stock' then raise exception 'serial_not_in_stock: %', s using errcode = '23514'; end if;
      if r.location_id <> p_location then raise exception 'serial_elsewhere: %', s using errcode = '23514'; end if;
      update public.catalog_serials set status = 'sold', sale_id = p_sale, updated_at = now() where id = r.id;
      insert into public.catalog_serial_events (business_id, serial_id, kind, location_id, sale_id) values (p_business, r.id, 'sold', p_location, p_sale);
    end loop;
  end loop;
end $$;
revoke execute on function public.sale_serials_take(uuid, uuid, uuid, jsonb, text) from public, anon, authenticated;

-- a sale cancelled: its units with numbers are back in stock where it was sold (the products first, then the numbers)
create or replace function public.sale_serials_back(p_sale uuid, p_business uuid, p_location uuid, p_items jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if not exists (select 1 from public.catalog_serials where sale_id = p_sale and business_id = p_business and status = 'sold') then return; end if;
  perform 1 from public.catalog_items c
   where c.business_id = p_business
     and c.id in (select x.item_id from public.stock_lines_v(p_items) x
                  union select s.item_id from public.catalog_serials s where s.sale_id = p_sale and s.business_id = p_business)
   order by c.id for update;
  for r in select * from public.catalog_serials where sale_id = p_sale and business_id = p_business and status = 'sold' order by id for update loop
    update public.catalog_serials set status = 'in_stock', sale_id = null, location_id = p_location, updated_at = now() where id = r.id;
    insert into public.catalog_serial_events (business_id, serial_id, kind, location_id, sale_id) values (p_business, r.id, 'cancelled', p_location, p_sale);
  end loop;
end $$;
revoke execute on function public.sale_serials_back(uuid, uuid, uuid, jsonb) from public, anon, authenticated;

-- a refund: the units named on its lines come back — into stock with "back to stock", else marked returned. A line of a product
-- that its sale sold by number (its history says so) names the ones that came back (as many as its quantity), each one of that
-- sale and not back yet; a line that names numbers is held to the same. The products first, then the numbers.
create or replace function public.refund_serials(p_refund uuid, p_sale uuid, p_business uuid, p_location uuid, p_items jsonb, p_restock boolean)
returns void language plpgsql security definer set search_path = public as $$
declare e jsonb; it uuid; q int; nm text; arr jsonb; s text; r record;
        lines jsonb := case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end;
begin
  if p_sale is null then return; end if;
  if not exists (select 1 from public.catalog_serial_events v where v.sale_id = p_sale and v.kind = 'sold' and v.business_id = p_business)
     and not exists (select 1 from jsonb_array_elements(lines) x where jsonb_typeof(x->'serials') = 'array' and jsonb_array_length(x->'serials') > 0) then
    return;                                                       -- nothing of it sold or named by number
  end if;
  perform 1 from public.catalog_items c where c.business_id = p_business and c.id in (select x.item_id from public.stock_lines_v(lines) x)
   order by c.id for update;
  perform 1 from public.catalog_serials x where x.sale_id = p_sale and x.business_id = p_business order by x.id for update;
  for e in select x from jsonb_array_elements(lines) x loop
    continue when coalesce(e->>'itemId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               or coalesce(e->>'qty', '') !~ '^[0-9]+(\.[0-9]+)?$';
    it := (e->>'itemId')::uuid;
    arr := case when jsonb_typeof(e->'serials') = 'array' then e->'serials' else '[]'::jsonb end;
    continue when jsonb_array_length(arr) = 0
              and not exists (select 1 from public.catalog_serial_events v join public.catalog_serials x on x.id = v.serial_id
                               where v.sale_id = p_sale and v.kind = 'sold' and x.item_id = it);
    q := floor((e->>'qty')::numeric)::int;
    continue when q <= 0;
    nm := coalesce((select c.name from public.catalog_items c where c.id = it), e->>'name', '');
    if jsonb_array_length(arr) <> q then raise exception 'serial_required: %', nm using errcode = '22023'; end if;
    for s in select btrim(x #>> '{}') from jsonb_array_elements(arr) x loop
      r := null;
      select * into r from public.catalog_serials x where x.business_id = p_business and x.item_id = it and lower(x.serial) = lower(s);
      if r.id is null or r.sale_id is distinct from p_sale or r.status <> 'sold' then
        raise exception 'serial_not_in_sale: %', s using errcode = '23514';
      end if;
      update public.catalog_serials set status = case when p_restock then 'in_stock' else 'returned' end, sale_id = null,
             location_id = p_location, updated_at = now() where id = r.id;
      insert into public.catalog_serial_events (business_id, serial_id, kind, location_id, sale_id, refund_id, note)
      values (p_business, r.id, 'returned', p_location, p_sale, p_refund, case when p_restock then '' else 'לא חזר למלאי' end);
    end loop;
  end loop;
end $$;
revoke execute on function public.refund_serials(uuid, uuid, uuid, uuid, jsonb, boolean) from public, anon, authenticated;

-- the movers of 4700 (each as it was) — and the units with numbers first
create or replace function public.sales_stock() returns trigger
language plpgsql security definer set search_path = public as $$
declare l record; loc uuid := coalesce(new.location_id, new.business_id);
begin
  if tg_op = 'INSERT' and new.status in ('paid', 'pending') then
    perform public.sale_serials_take(new.id, new.business_id, loc, new.items, new.channel);
    perform set_config('dp.serial_move', 'on', true);
    for l in select * from public.stock_lines_v(new.items) loop
      perform public.stock_move_at(new.business_id, loc, l.item_id, l.variant_id, -l.qty, 'sale', '', new.id, null, null, null, null, null);
    end loop;
    perform set_config('dp.serial_move', '', true);
  elsif tg_op = 'UPDATE' and new.status = 'cancelled' and old.status in ('paid', 'pending') then
    perform public.sale_serials_back(new.id, new.business_id, loc, old.items);
    perform set_config('dp.serial_move', 'on', true);
    for l in select * from public.stock_lines_v(old.items) loop
      perform public.stock_move_at(new.business_id, loc, l.item_id, l.variant_id, l.qty, 'cancel', '', new.id, null, null, null, null, null);
    end loop;
    perform set_config('dp.serial_move', '', true);
  end if;
  return null;
end $$;

create or replace function public.sale_refunds_restock() returns trigger
language plpgsql security definer set search_path = public as $$
declare l record; loc uuid := coalesce(new.location_id, new.business_id);
begin
  perform public.refund_serials(new.id, new.sale_id, new.business_id, loc, new.items, new.restock);
  if new.restock then
    perform set_config('dp.serial_move', 'on', true);
    for l in select * from public.stock_lines_v(new.items) loop
      perform public.stock_move_at(new.business_id, loc, l.item_id, l.variant_id, l.qty, 'refund', '', new.sale_id, new.id, null, null, null, null);
    end loop;
    perform set_config('dp.serial_move', '', true);
  end if;
  return null;
end $$;

-- 4700's transfers (each as it was) — a product with serial numbers goes by its numbers: each named on the line when it is sent
-- (as many as its quantity, in stock at the source), on the way until it arrives; at the receiving end the numbers that did not
-- arrive are named (with the reason, as any difference) and leave the stock; a cancel brings them back to the source.
create or replace function public.stock_transfer_send(p_id uuid, p_from uuid, p_to uuid, p_lines jsonb, p_note text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare b uuid := public.stock_writer(); t record; l record; i record; v record; num int; held int; label text; out jsonb := '[]';
        fname text; tname text; arr text[]; names text[]; ids uuid[] := '{}'; s text; r record;
begin
  if p_id is null then raise exception 'transfer_id: a new transfer has an id' using errcode = '22023'; end if;
  -- one transfer of the business at a time (its number, the same id twice) — "no key update": a sale's or a document's check of
  -- its business (a foreign key, "key share") never waits on it, so a sale holding its products and a transfer never wait in a circle
  perform 1 from public.businesses where id = b for no key update;
  select * into t from public.stock_transfers where id = p_id;
  if t.id is not null then
    if t.business_id <> b then raise exception 'not allowed' using errcode = '42501'; end if;
    return jsonb_build_object('id', t.id, 'number', t.number, 'created', false);
  end if;
  if p_from is not distinct from p_to then raise exception 'transfer_same: from one location to another' using errcode = '22023'; end if;
  select name into fname from public.business_locations where id = p_from and business_id = b and active;
  select name into tname from public.business_locations where id = p_to and business_id = b and active;
  if fname is null or tname is null then raise exception 'transfer_location: two open locations of the business' using errcode = '22023'; end if;
  if not public.location_allowed(b, p_from) then raise exception 'not allowed: this location is not yours' using errcode = '42501'; end if;
  if not public.stock_lines_strict(p_lines, 200) then
    raise exception 'transfer_lines: a product and a whole number of units on every line' using errcode = '22023';
  end if;
  perform 1 from public.catalog_items c where c.id in (select x.item_id from public.stock_lines_v(p_lines) x) order by c.id for update;
  for l in select * from public.stock_lines_v(p_lines) loop
    select c.id, c.name, c.track_stock, c.has_variants, c.track_serials into i from public.catalog_items c where c.id = l.item_id and c.business_id = b;
    if i.id is null then raise exception 'transfer_item: a product of the business' using errcode = '22023'; end if;
    if not i.track_stock then raise exception 'transfer_untracked: %', i.name using errcode = '22023'; end if;
    label := '';
    if l.variant_id is not null then
      select x.id, x.option1, x.option2, x.option3 into v from public.catalog_variants x where x.id = l.variant_id and x.item_id = i.id;
      if v.id is null then raise exception 'transfer_variant: %', i.name using errcode = '22023'; end if;
      label := concat_ws(' / ', nullif(v.option1, ''), nullif(v.option2, ''), nullif(v.option3, ''));
    elsif i.has_variants then
      raise exception 'transfer_variant_required: %', i.name using errcode = '22023';
    end if;
    if p_from = public.stock_ship_location(b) then
      select coalesce(sum(r2.qty), 0)::int into held from public.stock_reservations r2
       where r2.business_id = b and r2.item_id = i.id and (l.variant_id is null or r2.variant_id = l.variant_id)
         and (r2.status = 'paid' or (r2.status = 'held' and r2.expires_at > now()));
      if held > 0 and l.qty > public.stock_at(p_from, i.id, l.variant_id) - held then
        raise exception 'reserved_for_online: %', i.name || case when label <> '' then ' — ' || label else '' end using errcode = 'P0001';
      end if;
    end if;
    names := null;
    if i.track_serials then
      -- the numbers of its lines (the screen sends one line a product, a variant): each in stock at the source — locked now,
      -- after the products (every path locks a product before its numbers); the line keeps them as the product has them
      arr := public.serial_list(array(
        select n #>> '{}' from jsonb_array_elements(p_lines) e2
         cross join lateral jsonb_array_elements(case when jsonb_typeof(e2->'serials') = 'array' then e2->'serials' else '[]'::jsonb end) n
         where (e2->>'itemId')::uuid = i.id and (e2->>'variantId')::uuid is not distinct from l.variant_id));
      if coalesce(array_length(arr, 1), 0) <> l.qty then
        raise exception 'transfer_serials: %', i.name || case when label <> '' then ' — ' || label else '' end using errcode = '22023';
      end if;
      names := '{}';
      foreach s in array arr loop
        r := null;
        select * into r from public.catalog_serials x where x.business_id = b and x.item_id = i.id and lower(x.serial) = lower(s) for update;
        if r.id is null then raise exception 'serial_not_found: %', s using errcode = '22023'; end if;
        if r.variant_id is distinct from l.variant_id then raise exception 'serial_variant: %', s using errcode = '22023'; end if;
        if r.status = 'sold' then raise exception 'serial_sold: %', s using errcode = '23514'; end if;
        if r.status <> 'in_stock' then raise exception 'serial_not_in_stock: %', s using errcode = '23514'; end if;
        if r.location_id <> p_from then raise exception 'serial_elsewhere: %', s using errcode = '23514'; end if;
        names := names || r.serial; ids := ids || r.id;
      end loop;
    end if;
    out := out || (jsonb_build_object('itemId', i.id, 'variantId', l.variant_id, 'name', i.name, 'variant', label, 'qty', l.qty)
                   || case when names is not null then jsonb_build_object('serials', to_jsonb(names)) else '{}'::jsonb end);
  end loop;
  select coalesce(max(x.number), 0) + 1 into num from public.stock_transfers x where x.business_id = b;
  insert into public.stock_transfers (id, business_id, number, from_location, to_location, lines, note, sent_by)
  values (p_id, b, num, p_from, p_to, out, left(btrim(coalesce(p_note, '')), 300), auth.uid());
  -- the numbers are on the way
  update public.catalog_serials set status = 'in_transit', updated_at = now() where id = any (ids);
  insert into public.catalog_serial_events (business_id, serial_id, kind, location_id, transfer_id, note)
  select b, x, 'transfer_sent', p_from, p_id, left(format('העברה %s אל %s', num, tname), 200) from unnest(ids) with ordinality u(x, k) order by k;
  perform set_config('dp.serial_move', 'on', true);
  for l in select * from public.stock_lines_v(out) loop
    perform public.stock_move_at(b, p_from, l.item_id, l.variant_id, -l.qty, 'transfer', format('העברה %s אל %s', num, tname),
                                 null, null, null, null, p_id, null);
  end loop;
  perform set_config('dp.serial_move', '', true);
  return jsonb_build_object('id', p_id, 'number', num, 'created', true);
end $$;

-- receive: every line comes in at the destination as it was sent; what arrived otherwise is a difference — an "adjust" move there,
-- with its reason (required): [{itemId, variantId, received, reason}], and for a line with numbers [{itemId, variantId, missing:
-- [the numbers that did not arrive], reason}] — those leave the stock, the others are in stock at the destination. Once.
create or replace function public.stock_transfer_receive(p_id uuid, p_lines jsonb default '[]', p_note text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare b uuid := public.stock_writer(); t record; e jsonb; got jsonb; rec int; gap int; why text; outl jsonb := '[]'; gaps int := 0;
        fname text; it uuid; va uuid; miss text[]; s text;
begin
  select * into t from public.stock_transfers where id = p_id for update;
  if t.id is null or t.business_id <> b then raise exception 'not allowed' using errcode = '42501'; end if;
  if t.status = 'received' then return jsonb_build_object('result', 'already', 'number', t.number); end if;
  if t.status <> 'sent' then raise exception 'transfer_cancelled: this transfer was cancelled' using errcode = '23514'; end if;
  if not public.location_allowed(b, t.to_location) then raise exception 'not allowed: this location is not yours' using errcode = '42501'; end if;
  if p_lines is not null and jsonb_typeof(p_lines) <> 'array' then raise exception 'transfer_lines: a list of lines' using errcode = '22023'; end if;
  select name into fname from public.business_locations where id = t.from_location;
  perform 1 from public.catalog_items c where c.id in (select (x->>'itemId')::uuid from jsonb_array_elements(t.lines) x) order by c.id for update;
  perform 1 from public.catalog_serials x where x.business_id = b and x.status = 'in_transit'
     and exists (select 1 from public.catalog_serial_events v where v.serial_id = x.id and v.transfer_id = t.id)
   order by x.id for update;
  for e in select x from jsonb_array_elements(t.lines) x order by x->>'itemId', coalesce(x->>'variantId', '') loop
    it := (e->>'itemId')::uuid; va := nullif(e->>'variantId', '')::uuid;
    got := null;
    select x into got from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) x
     where x->>'itemId' = e->>'itemId' and coalesce(x->>'variantId', '') = coalesce(e->>'variantId', '') limit 1;
    rec := (e->>'qty')::int; why := ''; miss := '{}';
    if jsonb_typeof(e->'serials') = 'array' then
      if got is not null then
        miss := public.serial_list(array(select y #>> '{}' from jsonb_array_elements(
                  case when jsonb_typeof(got->'missing') = 'array' then got->'missing' else '[]'::jsonb end) y));
        if exists (select 1 from unnest(miss) m where not exists (select 1 from jsonb_array_elements_text(e->'serials') z where lower(z) = lower(m))) then
          raise exception 'transfer_serial_missing: %', e->>'name' using errcode = '22023';     -- a number that is not on this line
        end if;
        miss := array(select z from jsonb_array_elements_text(e->'serials') with ordinality q(z, k)          -- as the line has them
                       where exists (select 1 from unnest(miss) m where lower(m) = lower(z)) order by k);
        why := left(btrim(coalesce(got->>'reason', '')), 200);
      end if;
      rec := (e->>'qty')::int - coalesce(array_length(miss, 1), 0);
      if got is not null and got->>'received' is not null and got->>'received' <> rec::text then
        raise exception 'transfer_serial_missing: %', e->>'name' using errcode = '22023';     -- fewer by number: name the ones that did not arrive
      end if;
    elsif got is not null and got->>'received' is not null then
      if (got->>'received') !~ '^[0-9]{1,6}$' then
        raise exception 'transfer_received: a whole number of units, zero or more' using errcode = '22023';
      end if;
      rec := (got->>'received')::int;
      why := left(btrim(coalesce(got->>'reason', '')), 200);
    end if;
    gap := rec - (e->>'qty')::int;
    if gap <> 0 and why = '' then raise exception 'transfer_gap_reason: %', e->>'name' using errcode = '22023'; end if;
    perform set_config('dp.serial_move', 'on', true);
    perform public.stock_move_at(b, t.to_location, it, va, (e->>'qty')::int, 'transfer', format('קבלת העברה %s מ%s', t.number, fname),
                                 null, null, null, null, t.id, null);
    if gap <> 0 then
      perform public.stock_move_at(b, t.to_location, it, va, gap, 'adjust', format('פער בהעברה %s: %s', t.number, why),
                                   null, null, null, null, t.id, null);
      gaps := gaps + 1;
    end if;
    perform set_config('dp.serial_move', '', true);
    if jsonb_typeof(e->'serials') = 'array' then
      for s in select z from jsonb_array_elements_text(e->'serials') z loop
        if exists (select 1 from unnest(miss) m where lower(m) = lower(s)) then
          update public.catalog_serials x set status = 'removed', location_id = t.to_location, updated_at = now()
           where x.business_id = b and x.item_id = it and lower(x.serial) = lower(s) and x.status = 'in_transit';
          insert into public.catalog_serial_events (business_id, serial_id, kind, location_id, transfer_id, note)
          select b, x.id, 'transfer_missing', t.to_location, t.id, left(format('לא הגיע בהעברה %s: %s', t.number, why), 200)
            from public.catalog_serials x where x.business_id = b and x.item_id = it and lower(x.serial) = lower(s);
        else
          update public.catalog_serials x set status = 'in_stock', location_id = t.to_location, updated_at = now()
           where x.business_id = b and x.item_id = it and lower(x.serial) = lower(s) and x.status = 'in_transit';
          insert into public.catalog_serial_events (business_id, serial_id, kind, location_id, transfer_id, note)
          select b, x.id, 'transfer_received', t.to_location, t.id, left(format('קבלת העברה %s מ%s', t.number, fname), 200)
            from public.catalog_serials x where x.business_id = b and x.item_id = it and lower(x.serial) = lower(s);
        end if;
      end loop;
    end if;
    outl := outl || (e || jsonb_build_object('received', rec, 'reason', why)
                      || case when jsonb_typeof(e->'serials') = 'array' then jsonb_build_object('missing', to_jsonb(miss)) else '{}'::jsonb end);
  end loop;
  update public.stock_transfers set status = 'received', lines = outl, received_by = auth.uid(), received_at = now(),
         received_note = left(btrim(coalesce(p_note, '')), 300)
   where id = t.id;
  return jsonb_build_object('result', 'ok', 'number', t.number, 'gaps', gaps);
end $$;

-- cancel a transfer that was not received: the units go back to the source — the numbers too. Whoever works at the source, or
-- the owner; a reason.
create or replace function public.stock_transfer_cancel(p_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare b uuid := public.stock_writer(); t record; e jsonb; s text;
begin
  select * into t from public.stock_transfers where id = p_id for update;
  if t.id is null or t.business_id <> b then raise exception 'not allowed' using errcode = '42501'; end if;
  if t.status = 'cancelled' then return jsonb_build_object('result', 'already', 'number', t.number); end if;
  if t.status <> 'sent' then raise exception 'transfer_received: a received transfer is not cancelled' using errcode = '23514'; end if;
  if not (public.location_allowed(b, t.from_location) or public.location_owner()) then
    raise exception 'not allowed: this location is not yours' using errcode = '42501';
  end if;
  if btrim(coalesce(p_reason, '')) = '' then raise exception 'transfer_cancel_reason: why it is cancelled' using errcode = '22023'; end if;
  perform 1 from public.catalog_items c where c.id in (select (x->>'itemId')::uuid from jsonb_array_elements(t.lines) x) order by c.id for update;
  perform 1 from public.catalog_serials x where x.business_id = b and x.status = 'in_transit'
     and exists (select 1 from public.catalog_serial_events v where v.serial_id = x.id and v.transfer_id = t.id)
   order by x.id for update;
  perform set_config('dp.serial_move', 'on', true);
  for e in select x from jsonb_array_elements(t.lines) x order by x->>'itemId', coalesce(x->>'variantId', '') loop
    perform public.stock_move_at(b, t.from_location, (e->>'itemId')::uuid, nullif(e->>'variantId', '')::uuid, (e->>'qty')::int, 'transfer',
                                 format('ביטול העברה %s', t.number), null, null, null, null, t.id, null);
    if jsonb_typeof(e->'serials') = 'array' then
      for s in select z from jsonb_array_elements_text(e->'serials') z loop
        update public.catalog_serials x set status = 'in_stock', location_id = t.from_location, updated_at = now()
         where x.business_id = b and x.item_id = (e->>'itemId')::uuid and lower(x.serial) = lower(s) and x.status = 'in_transit';
        insert into public.catalog_serial_events (business_id, serial_id, kind, location_id, transfer_id, note)
        select b, x.id, 'transfer_cancelled', t.from_location, t.id, left(format('ביטול העברה %s', t.number), 200)
          from public.catalog_serials x where x.business_id = b and x.item_id = (e->>'itemId')::uuid and lower(x.serial) = lower(s);
      end loop;
    end if;
  end loop;
  perform set_config('dp.serial_move', '', true);
  update public.stock_transfers set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(), cancel_reason = left(btrim(p_reason), 300)
   where id = t.id;
  return jsonb_build_object('result', 'ok', 'number', t.number);
end $$;

-- 4700's count line (as it was) — a product with serial numbers is not counted here: its units are checked by number. Its row is
-- read under a share lock, so turning the numbers on (which locks it) and counting it do not cross.
create or replace function public.stock_count_set(p_count uuid, p_item uuid, p_variant uuid, p_counted int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare b uuid := public.stock_writer(); c record; i record; k text;
begin
  select * into c from public.stock_counts where id = p_count for update;
  if c.id is null or c.business_id <> b then raise exception 'not allowed' using errcode = '42501'; end if;
  if c.status <> 'open' then raise exception 'count_closed: this count is %', c.status using errcode = '23514'; end if;
  if not public.location_allowed(b, c.location_id) then raise exception 'not allowed: this location is not yours' using errcode = '42501'; end if;
  select x.id, x.has_variants, x.track_serials, x.name into i from public.catalog_items x where x.id = p_item and x.business_id = b for share;
  if i.id is null then raise exception 'count_item: a product of the business' using errcode = '22023'; end if;
  if p_variant is null and i.has_variants then raise exception 'variant_required: an item with variants is counted per variant' using errcode = '22023'; end if;
  if p_variant is not null and (not i.has_variants
     or not exists (select 1 from public.catalog_variants v where v.id = p_variant and v.item_id = p_item)) then
    raise exception 'variant_not_found: a variant of this item' using errcode = '22023';
  end if;
  if p_counted is not null and i.track_serials then raise exception 'count_serial: %', i.name using errcode = '22023'; end if;
  if p_counted is not null and (p_counted < 0 or p_counted > 1000000) then raise exception 'a count is zero or more' using errcode = '22023'; end if;
  k := p_item::text || ':' || coalesce(p_variant::text, '');
  if p_counted is null then
    update public.stock_counts set lines = lines - k where id = c.id;
  else
    update public.stock_counts set lines = lines || jsonb_build_object(k, jsonb_build_object('itemId', p_item, 'variantId', p_variant,
             'counted', p_counted, 'at', now(), 'by', auth.uid()))
     where id = c.id;
  end if;
  return jsonb_build_object('key', k, 'counted', p_counted);
end $$;

-- ---- 2. price lists -------------------------------------------------------------------------------------------------------------
create table if not exists public.price_lists (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses on delete restrict,
  name        text not null check (length(name) between 1 and 40 and name = btrim(name)),
  kind        text not null check (kind in ('location', 'group')),
  location_id uuid,                              -- a location's list: the sales and documents of that location
  tag         text,                              -- a group's list: the customers with this tag (CRM)
  active      boolean not null default true,
  sort        int not null default 0,
  created_at  timestamptz not null default now(),
  check ((kind = 'location') = (location_id is not null)),
  check ((kind = 'group') = (tag is not null)),
  check (tag is null or (length(tag) between 1 and 40 and tag = btrim(tag))),
  foreign key (location_id, business_id) references public.business_locations (id, business_id) on delete restrict
);
create unique index if not exists price_lists_name_uq on public.price_lists (business_id, lower(name));
create unique index if not exists price_lists_location_uq on public.price_lists (location_id) where kind = 'location' and active;
create unique index if not exists price_lists_tag_uq on public.price_lists (business_id, lower(tag)) where kind = 'group' and active;

create table if not exists public.price_list_items (
  list_id     uuid not null references public.price_lists on delete cascade,
  business_id uuid not null references public.businesses on delete restrict,
  item_id     uuid not null references public.catalog_items on delete cascade,
  variant_id  uuid references public.catalog_variants on delete cascade,
  price       numeric(10,2) not null check (price >= 0 and price <= 9999999),
  updated_at  timestamptz not null default now()
);
create unique index if not exists price_list_items_uq on public.price_list_items (list_id, item_id, coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists price_list_items_item_idx on public.price_list_items (item_id);

-- a list, new (its id chosen by the screen: a second try is the same list) or changed — its kind and location never change
create or replace function public.price_list_save(p_id uuid, p_name text, p_kind text, p_location uuid, p_tag text, p_active boolean, p_sort int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare b uuid := public.items_writer(); cur record; nm text := btrim(coalesce(p_name, '')); tg text := nullif(btrim(coalesce(p_tag, '')), '');
begin
  if p_id is null then raise exception 'price_list_id: a new list has an id' using errcode = '22023'; end if;
  if length(nm) not between 1 and 40 then raise exception 'price_list_name: a name of 1 to 40 characters' using errcode = '22023'; end if;
  select * into cur from public.price_lists where id = p_id;
  if cur.id is not null then
    if cur.business_id <> b then raise exception 'not allowed' using errcode = '42501'; end if;
    update public.price_lists set name = nm, tag = case when kind = 'group' then coalesce(tg, tag) else null end,
           active = coalesce(p_active, active), sort = coalesce(p_sort, sort)
     where id = p_id;
    return jsonb_build_object('id', p_id, 'created', false);
  end if;
  if p_kind = 'location' then
    if p_location is null or not exists (select 1 from public.business_locations l where l.id = p_location and l.business_id = b) then
      raise exception 'stock_location: a location of the business' using errcode = '22023';
    end if;
    insert into public.price_lists (id, business_id, name, kind, location_id, active, sort) values (p_id, b, nm, 'location', p_location, coalesce(p_active, true), coalesce(p_sort, 0));
  elsif p_kind = 'group' then
    if tg is null then raise exception 'price_list_tag: the customers'' tag' using errcode = '22023'; end if;
    insert into public.price_lists (id, business_id, name, kind, tag, active, sort) values (p_id, b, nm, 'group', tg, coalesce(p_active, true), coalesce(p_sort, 0));
  else
    raise exception 'price_list_kind: a location''s list or a group''s' using errcode = '22023';
  end if;
  return jsonb_build_object('id', p_id, 'created', true);
end $$;

-- a list's prices: [{itemId, variantId?, price}] — a number sets it, null takes it off (the base price again); up to 500 lines
create or replace function public.price_list_set(p_list uuid, p_lines jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b uuid := public.items_writer(); pl record; e jsonb; it uuid; v uuid; pr numeric; n int := 0;
begin
  select * into pl from public.price_lists where id = p_list;
  if pl.id is null or pl.business_id <> b then raise exception 'not allowed' using errcode = '42501'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) not between 1 and 500 then
    raise exception 'price_list_lines: 1 to 500 lines' using errcode = '22023';
  end if;
  for e in select x from jsonb_array_elements(p_lines) x loop
    if coalesce(e->>'itemId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or (e->>'variantId' is not null and e->>'variantId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
      raise exception 'price_list_lines: a product on every line' using errcode = '22023';
    end if;
    it := (e->>'itemId')::uuid; v := nullif(e->>'variantId', '')::uuid;
    if not exists (select 1 from public.catalog_items c where c.id = it and c.business_id = b) then
      raise exception 'price_list_item: a product of the business' using errcode = '22023';
    end if;
    if v is not null and not exists (select 1 from public.catalog_variants x where x.id = v and x.item_id = it) then
      raise exception 'variant_not_found: a variant of this item' using errcode = '22023';
    end if;
    if e->'price' is null or jsonb_typeof(e->'price') = 'null' then
      delete from public.price_list_items where list_id = pl.id and item_id = it and variant_id is not distinct from v;
    else
      if coalesce(e->>'price', '') !~ '^[0-9]{1,7}(\.[0-9]{1,2})?$' then raise exception 'price_list_price: a price of 0 or more, in shekels and agorot' using errcode = '22023'; end if;
      pr := (e->>'price')::numeric;
      update public.price_list_items set price = pr, updated_at = now() where list_id = pl.id and item_id = it and variant_id is not distinct from v;
      if not found then
        insert into public.price_list_items (list_id, business_id, item_id, variant_id, price) values (pl.id, b, it, v, pr);
      end if;
    end if;
    n := n + 1;
  end loop;
  return jsonb_build_object('list', pl.id, 'lines', n);
end $$;

-- ---- 3. SKU series ("מק״ט מונה") ---------------------------------------------------------------------------------------------------
create table if not exists public.sku_series (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses on delete restrict,
  name        text not null check (length(name) between 1 and 40 and name = btrim(name)),   -- the category: "תכשיטים"
  prefix      text not null check (prefix ~ '^[A-Z0-9]{1,6}$'),                            -- "JW"
  digits      int  not null default 4 check (digits between 3 and 6),
  next_no     int  not null default 1 check (next_no between 1 and 999999),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create unique index if not exists sku_series_prefix_uq on public.sku_series (business_id, prefix);
create unique index if not exists sku_series_name_uq on public.sku_series (business_id, lower(name));

create or replace function public.sku_series_save(p_id uuid, p_name text, p_prefix text, p_digits int, p_next int, p_active boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare b uuid := public.items_writer(); cur record; nm text := btrim(coalesce(p_name, '')); px text := upper(btrim(coalesce(p_prefix, '')));
begin
  if p_id is null then raise exception 'sku_series_id: a new series has an id' using errcode = '22023'; end if;
  if length(nm) not between 1 and 40 then raise exception 'sku_series_name: a name of 1 to 40 characters' using errcode = '22023'; end if;
  if px !~ '^[A-Z0-9]{1,6}$' then raise exception 'sku_series_prefix: 1 to 6 letters (A-Z) or digits' using errcode = '22023'; end if;
  if coalesce(p_digits, 4) not between 3 and 6 then raise exception 'sku_series_digits: 3 to 6 digits' using errcode = '22023'; end if;
  if coalesce(p_next, 1) not between 1 and 999999 then raise exception 'sku_series_next: from 1' using errcode = '22023'; end if;
  select * into cur from public.sku_series where id = p_id;
  if cur.id is not null then
    if cur.business_id <> b then raise exception 'not allowed' using errcode = '42501'; end if;
    update public.sku_series set name = nm, prefix = px, digits = coalesce(p_digits, digits), next_no = coalesce(p_next, next_no),
           active = coalesce(p_active, active) where id = p_id;
    return jsonb_build_object('id', p_id, 'created', false);
  end if;
  insert into public.sku_series (id, business_id, name, prefix, digits, next_no, active)
  values (p_id, b, nm, px, coalesce(p_digits, 4), coalesce(p_next, 1), coalesce(p_active, true));
  return jsonb_build_object('id', p_id, 'created', true);
end $$;

-- the next free SKU of a series — under the catalog's code lock (as catalog_codes_check), never one a product or variant has
create or replace function public.sku_next(p_series uuid) returns text
language plpgsql security definer set search_path = public as $$
declare b uuid := public.items_writer(); s record; code text; k int := 0;
begin
  select * into s from public.sku_series where id = p_series for update;
  if s.id is null or s.business_id <> b then raise exception 'not allowed' using errcode = '42501'; end if;
  if not s.active then raise exception 'sku_series_closed: the series is not active' using errcode = '23514'; end if;
  perform pg_advisory_xact_lock(hashtextextended('catalog_codes:' || b::text, 0));
  loop
    if s.next_no > (10 ^ s.digits)::int - 1 then raise exception 'sku_series_full: the series has no number left' using errcode = '23514'; end if;
    code := s.prefix || '-' || lpad(s.next_no::text, s.digits, '0');
    s.next_no := s.next_no + 1;
    exit when not exists (select 1 from public.catalog_items c where c.business_id = b and lower(c.sku) = lower(code))
          and not exists (select 1 from public.catalog_variants v where v.business_id = b and lower(v.sku) = lower(code));
    k := k + 1;
    if k > 10000 then raise exception 'sku_series_full: the series has no number left' using errcode = '23514'; end if;
  end loop;
  update public.sku_series set next_no = s.next_no where id = s.id;
  return code;
end $$;

-- ---- 4. comparing locations ("השוואת סניפים") ----------------------------------------------------------------------------------------
-- Each location the member may use (the location picked at the top does not hide the others — this compares them), in a period:
-- revenue and estimated profit by finance_summary's own rules, the register's and the site's sales and refunds, the products that
-- sold the most, and the stock now (units, and their value at the selling price). A money report: not a cashier's, and the super
-- admin only through a finance grant (finance_business_ids).
create or replace function public.location_compare(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare b uuid := public.current_business_id(); ent text; vat_on boolean; res jsonb;
begin
  if b is null or b not in (select public.accessible_business_ids()) or b not in (select public.finance_business_ids())
     or public.my_access() = 'register' then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 3700 then raise exception 'bad range' using errcode = '22023'; end if;
  select public.entity_of(s.entity_type, s.business_type) into ent from public.register_settings s where s.business_id = b;
  ent := coalesce(ent, 'licensed_dealer');
  vat_on := public.entity_charges_vat(ent);
  with locs as (
    select l.id, l.name, l.active, l.sort, l.created_at, (l.id = b) as main from public.business_locations l
     where l.business_id = b and public.location_allowed(b, l.id)
  ), d as (
    select coalesce(doc.location_id, doc.business_id) as loc, doc.doc_type, doc.after_discount, doc.vat_amount, doc.total,
           public.entity_charges_vat(coalesce(doc.issuer->>'entityType', ent)) as vat_doc,
           exists (select 1 from public.document_cancellations c where c.document_id = doc.id) as cancelled
      from public.documents doc where doc.business_id = b and doc.doc_date between p_from and p_to
  ), rev as (
    select loc,
           sum(case when vat_doc and doc_type in (305, 320) then after_discount when vat_doc and doc_type = 330 then -after_discount
                    when not vat_doc and doc_type = 400 and not cancelled then total else 0 end) as net,
           sum(case when vat_doc and doc_type in (305, 320) then vat_amount when vat_doc and doc_type = 330 then -vat_amount else 0 end) as vat
      from d group by loc
  ), ex as (
    select coalesce(x.location_id, x.business_id) as loc,
           sum(case when x.supplier_doc_type = 'credit' then -x.amount_before_vat else x.amount_before_vat end) as net,
           sum((case when x.supplier_doc_type = 'credit' then -1 else 1 end)
               * (x.amount_before_vat + x.vat_amount - case when vat_on then round(x.vat_amount * x.vat_deductible_pct / 100, 2) else 0 end)) as cost
      from public.expenses x where x.business_id = b and x.status = 'confirmed' and x.doc_date between p_from and p_to group by 1
  ), sl as (
    select coalesce(s.location_id, s.business_id) as loc, s.id, s.total, s.items, s.channel
      from public.sales s
     where s.business_id = b and s.status = 'paid'
       and (coalesce(s.paid_at, s.created_at) at time zone 'Asia/Jerusalem')::date between p_from and p_to
  ), st as (
    select loc, count(*) as n, sum(total) as total, count(*) filter (where channel = 'online') as online from sl group by loc
  ), rf as (
    select coalesce(r.location_id, r.business_id) as loc, sum(r.amount) as amount, count(*) as n from public.sale_refunds r
     where r.business_id = b and (r.created_at at time zone 'Asia/Jerusalem')::date between p_from and p_to group by 1
  ), lines as (
    -- a product (a variant on its own), or a line with no product by its name
    select sl.loc, coalesce(nullif(e->>'itemId', '') || '|' || coalesce(e->>'variantId', ''), 'name:' || coalesce(e->>'name', '')) as k,
           max(coalesce(e->>'name', '')) as name,
           max(case when coalesce(e->>'itemId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then e->>'itemId' end) as item_id,
           sum(case when coalesce(e->>'qty', '') ~ '^[0-9]+(\.[0-9]+)?$' then (e->>'qty')::numeric else 0 end) as qty,
           sum(case when coalesce(e->>'qty', '') ~ '^[0-9]+(\.[0-9]+)?$' and coalesce(e->>'price', '') ~ '^-?[0-9]+(\.[0-9]+)?$'
                    then (e->>'qty')::numeric * (e->>'price')::numeric else 0 end) as total
      from sl cross join lateral jsonb_array_elements(case when jsonb_typeof(sl.items) = 'array' then sl.items else '[]'::jsonb end) e
     group by 1, 2
  ), top as (
    select loc, jsonb_agg(jsonb_build_object('itemId', item_id, 'name', name, 'qty', qty, 'total', round(total, 2)) order by total desc, name) as j
      from (select l.*, row_number() over (partition by loc order by total desc, name) as k2 from lines l) x
     where k2 <= 10 group by loc
  ), sk as (
    -- the stock now: units (an item's own count holds its variants'), and their value at the selling price (a variant's own)
    select r.location_id as loc,
           sum(case when r.variant_id is null then r.qty else 0 end) as units,
           sum(case when r.variant_id is null and not i.has_variants then greatest(r.qty, 0) * i.price
                    when r.variant_id is not null then greatest(r.qty, 0) * coalesce(v.price, i.price) else 0 end) as value
      from public.stock_by_location_rows() r
      join public.catalog_items i on i.id = r.item_id
      left join public.catalog_variants v on v.id = r.variant_id
     group by 1
  )
  select jsonb_build_object('from', p_from, 'to', p_to, 'vat', vat_on, 'locations', coalesce(jsonb_agg(jsonb_build_object(
           'id', locs.id, 'name', locs.name, 'active', locs.active, 'main', locs.main,
           'revenue', jsonb_build_object('net', coalesce(rev.net, 0), 'vat', coalesce(rev.vat, 0)),
           'expenses', jsonb_build_object('net', coalesce(ex.net, 0), 'cost', coalesce(ex.cost, 0)),
           'profit', coalesce(rev.net, 0) - coalesce(ex.cost, 0),
           'sales', jsonb_build_object('count', coalesce(st.n, 0), 'total', coalesce(st.total, 0), 'online', coalesce(st.online, 0),
                                       'refunds', coalesce(rf.amount, 0), 'refundCount', coalesce(rf.n, 0)),
           'items', coalesce(top.j, '[]'::jsonb),
           'stock', jsonb_build_object('units', coalesce(sk.units, 0), 'value', round(coalesce(sk.value, 0), 2)))
         order by locs.main desc, locs.sort, locs.created_at), '[]'::jsonb))
    into res
    from locs left join rev on rev.loc = locs.id left join ex on ex.loc = locs.id left join st on st.loc = locs.id
         left join rf on rf.loc = locs.id left join top on top.loc = locs.id left join sk on sk.loc = locs.id;
  return res;
end $$;

-- ---- 5. who may call what, and who sees what -------------------------------------------------------------------------------------
revoke execute on function public.serial_tracking(uuid, boolean), public.serial_receive(uuid, uuid, uuid, text[], boolean, text),
  public.serial_remove(uuid, text), public.price_list_save(uuid, text, text, uuid, text, boolean, int), public.price_list_set(uuid, jsonb),
  public.sku_series_save(uuid, text, text, int, int, boolean), public.sku_next(uuid), public.location_compare(date, date) from public, anon;
grant execute on function public.serial_tracking(uuid, boolean), public.serial_receive(uuid, uuid, uuid, text[], boolean, text),
  public.serial_remove(uuid, text), public.price_list_save(uuid, text, text, uuid, text, boolean, int), public.price_list_set(uuid, jsonb),
  public.sku_series_save(uuid, text, text, int, int, boolean), public.sku_next(uuid), public.location_compare(date, date) to authenticated;

do $$
declare
  t text;
  gate constant text := 'business_id = (select public.current_business_id()) and business_id in (select public.accessible_business_ids())';
begin
  foreach t in array array['catalog_serials', 'catalog_serial_events', 'price_lists', 'price_list_items', 'sku_series'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate on public.%I from authenticated', t);   -- written by the functions above only
    execute format('grant select on public.%I to authenticated', t);
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_business_gate') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)', t || '_business_gate', t, gate, gate);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_business_read') then
      execute format('create policy %I on public.%I for select to authenticated using (%s)', t || '_business_read', t, gate);
    end if;
  end loop;
end $$;

-- ============================================================================================================================
-- Rollback (by hand, if ever needed): only while no product has serial numbers, no price list and no SKU series is in use —
-- drop the functions location_compare, sku_next, sku_series_save, price_list_set, price_list_save; put sales_stock,
-- sale_refunds_restock, stock_move_at, stock_transfer_send / _receive / _cancel and stock_count_set back as 20261011004700 has them;
-- drop refund_serials, sale_serials_back, sale_serials_take, serial_lock_items, serial_remove, serial_receive, serial_tracking,
-- serial_list, items_writer; drop the tables sku_series, price_list_items, price_lists, catalog_serial_events, catalog_serials;
-- alter table catalog_items drop constraint catalog_items_serials_check, drop column track_serials.
-- ============================================================================================================================
