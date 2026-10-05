-- ============================================================================================================================
-- Migration 20261005003300 — Dream Commerce stage 1: one catalog for the register, finance and the online store (2.54.0)
-- Additive: no table, column, policy or row is removed, and no existing row changes. An item without variants keeps
-- working exactly as before — same columns, same stock, same functions (their signatures do not change).
--   1. catalog_items      the online fields: slug, description, SEO, "פרסם באתר" (off by default), online price, compare-at
--                         price, SKU, barcode, tags, custom fields, manufacturer and country of origin (distance-sale
--                         disclosure — NEEDS_LEGAL_VERIFICATION), has_variants, published_at, updated_at
--   2. new tables         catalog_options (size / colour / material: up to 3 per item), catalog_variants (SKU, barcode,
--                         price, online price, picture, stock), catalog_media (pictures of the store-media bucket, alt;
--                         the first one is the item's image_url — the register's tiles), catalog_field_defs (the
--                         business's own fields: size chart, ingredients, washing)
--   3. stock per variant  stock_movements.variant_id; stock_lines_v / stock_move_v / stock_move_ref_v; the existing movers
--                         (stock_move, stock_move_ref) and every stock trigger (sales, refunds, documents, cancellations,
--                         expenses) now read a line's "variantId". An item with variants keeps the sum of its variants in
--                         catalog_items.stock_qty (the register's badges and alerts keep working); a line without a
--                         variant of such an item moves only that sum and is logged "לא משויך לווריאנט" — never a variant
--                         picked at random. adjust_variant_stock / reconcile_variant_stock; adjust_stock refuses an item
--                         with variants.
--   4. codes              a SKU / barcode is unique in the business, across items and variants
--   5. row-level security the 3100 pattern + the viewer (3200); a cashier reads the catalog and never writes it
--   6. bucket             store-media (public pictures; written by the server only)
-- Every rule is tested on a local Postgres 16: tests/sql/commerce-catalog.check.sql (with every existing check).
-- Applied to the live database only after the owner's explicit approval. Rollback: at the end of this file.
-- ============================================================================================================================

-- ---- 1. catalog_items: the online fields ------------------------------------------------------------------------------------
alter table public.catalog_items add column if not exists slug              text;
alter table public.catalog_items add column if not exists description       text not null default '';
alter table public.catalog_items add column if not exists seo_title         text not null default '';
alter table public.catalog_items add column if not exists seo_description   text not null default '';
alter table public.catalog_items add column if not exists publish_online    boolean not null default false;
alter table public.catalog_items add column if not exists online_price      numeric(10,2);
alter table public.catalog_items add column if not exists compare_at_price  numeric(10,2);
alter table public.catalog_items add column if not exists sku               text not null default '';
alter table public.catalog_items add column if not exists barcode           text not null default '';
alter table public.catalog_items add column if not exists has_variants      boolean not null default false;
alter table public.catalog_items add column if not exists tags              text[] not null default '{}';
alter table public.catalog_items add column if not exists custom_fields     jsonb not null default '{}';
alter table public.catalog_items add column if not exists manufacturer      text not null default '';
alter table public.catalog_items add column if not exists country_of_origin text not null default '';
alter table public.catalog_items add column if not exists published_at      timestamptz;
alter table public.catalog_items add column if not exists updated_at        timestamptz not null default now();

do $$
declare c record;
begin
  for c in select * from (values
    ('catalog_items_slug_check',         $c$check (slug is null or (length(slug) between 1 and 80 and slug ~ '^[a-z0-9א-ת]+(-[a-z0-9א-ת]+)*$'))$c$),
    ('catalog_items_description_check',  $c$check (length(description) <= 5000)$c$),
    ('catalog_items_seo_check',          $c$check (length(seo_title) <= 120 and length(seo_description) <= 320)$c$),
    ('catalog_items_online_price_check', $c$check (online_price is null or online_price >= 0)$c$),
    ('catalog_items_compare_price_check',$c$check (compare_at_price is null or compare_at_price >= 0)$c$),
    ('catalog_items_codes_check',        $c$check (length(sku) <= 64 and (barcode = '' or barcode ~ '^[0-9A-Za-z.-]{3,40}$'))$c$),
    ('catalog_items_tags_check',         $c$check (cardinality(tags) <= 30)$c$),
    ('catalog_items_custom_fields_check',$c$check (jsonb_typeof(custom_fields) = 'object')$c$),
    ('catalog_items_origin_check',       $c$check (length(manufacturer) <= 120 and length(country_of_origin) <= 60)$c$)
  ) as x(name, def) loop
    if not exists (select 1 from pg_constraint where conname = c.name) then
      execute format('alter table public.catalog_items add constraint %I %s', c.name, c.def);
    end if;
  end loop;
end $$;
create unique index if not exists catalog_items_slug_uq    on public.catalog_items (business_id, slug) where slug is not null;
create unique index if not exists catalog_items_sku_uq     on public.catalog_items (business_id, lower(sku)) where sku <> '';
create unique index if not exists catalog_items_barcode_uq on public.catalog_items (business_id, barcode) where barcode <> '';

-- an edit of the product (not a stock move — every sale changes stock_qty) is its updated_at; publishing stamps published_at
create or replace function public.catalog_items_touch() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE'
     and (to_jsonb(new) - 'stock_qty' - 'updated_at' - 'has_variants') is distinct from (to_jsonb(old) - 'stock_qty' - 'updated_at' - 'has_variants') then
    new.updated_at := now();
  end if;
  if new.publish_online and new.published_at is null then new.published_at := now(); end if;
  return new;
end $$;
revoke execute on function public.catalog_items_touch() from public, anon, authenticated;
create or replace trigger b_catalog_items_touch before insert or update on public.catalog_items for each row execute function public.catalog_items_touch();

-- ---- 2. the new catalog tables ----------------------------------------------------------------------------------------------
create table if not exists public.catalog_options (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses on delete restrict,
  item_id     uuid not null references public.catalog_items on delete cascade,
  position    int  not null check (position between 1 and 3),
  name        text not null check (length(name) between 1 and 30),
  choices     text[] not null check (cardinality(choices) between 1 and 50),
  created_by  uuid references auth.users on delete set null default auth.uid(),
  created_at  timestamptz not null default now(),
  unique (item_id, position)
);
create index if not exists catalog_options_business_idx on public.catalog_options (business_id);

create table if not exists public.catalog_variants (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references public.businesses on delete restrict,
  item_id          uuid not null references public.catalog_items on delete cascade,
  option1          text not null default '' check (length(option1) <= 40),
  option2          text not null default '' check (length(option2) <= 40),
  option3          text not null default '' check (length(option3) <= 40),
  sku              text not null default '' check (length(sku) <= 64),
  barcode          text not null default '' check (barcode = '' or barcode ~ '^[0-9A-Za-z.-]{3,40}$'),
  price            numeric(10,2) check (price >= 0),              -- null: the item's price
  online_price     numeric(10,2) check (online_price >= 0),       -- null: the item's online price, then the price
  compare_at_price numeric(10,2) check (compare_at_price >= 0),
  stock_qty        int  not null default 0,                       -- moves only through the stock functions
  low_stock        int  check (low_stock >= 0),                   -- null: the item's alert level
  media_id         uuid,
  active           boolean not null default true,
  position         int  not null default 0,
  created_by       uuid references auth.users on delete set null default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (item_id, option1, option2, option3)
);
create index if not exists catalog_variants_item_idx     on public.catalog_variants (item_id, position);
create index if not exists catalog_variants_business_idx on public.catalog_variants (business_id);
create unique index if not exists catalog_variants_sku_uq     on public.catalog_variants (business_id, lower(sku)) where sku <> '';
create unique index if not exists catalog_variants_barcode_uq on public.catalog_variants (business_id, barcode) where barcode <> '';

create table if not exists public.catalog_media (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses on delete restrict,
  item_id     uuid not null references public.catalog_items on delete cascade,
  variant_id  uuid references public.catalog_variants on delete set null,
  kind        text not null default 'image' check (kind in ('image')),
  path        text not null check (length(path) between 1 and 300),                -- the picture's folder in store-media
  url         text not null check (url ~ '^https://'),                             -- the main size
  sizes       jsonb not null default '{}' check (jsonb_typeof(sizes) = 'object'),  -- {"320": url, "640": url, …}
  width       int check (width > 0),
  height      int check (height > 0),
  alt         text not null default '' check (length(alt) <= 250),
  position    int  not null default 0,
  created_by  uuid references auth.users on delete set null default auth.uid(),
  created_at  timestamptz not null default now()
);
create index if not exists catalog_media_item_idx     on public.catalog_media (item_id, position);
create index if not exists catalog_media_business_idx on public.catalog_media (business_id);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'catalog_variants_media_fk') then
    alter table public.catalog_variants add constraint catalog_variants_media_fk foreign key (media_id) references public.catalog_media on delete set null;
  end if;
end $$;

create table if not exists public.catalog_field_defs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users on delete set null default auth.uid(),   -- who created it (fills business_id)
  business_id uuid references public.businesses on delete restrict,
  field_key   text not null check (field_key ~ '^[a-z][a-z0-9_]{1,30}$'),
  label       text not null check (length(label) between 1 and 40),
  kind        text not null default 'text' check (kind in ('text', 'multiline')),
  show_online boolean not null default true,
  position    int  not null default 0,
  created_at  timestamptz not null default now()
);
create unique index if not exists catalog_field_defs_key_uq on public.catalog_field_defs (business_id, field_key);
create or replace trigger a_fill_business_id before insert on public.catalog_field_defs for each row execute function public.fill_business_id();
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'catalog_field_defs_business_required') then
    alter table public.catalog_field_defs add constraint catalog_field_defs_business_required check (business_id is not null);
  end if;
end $$;

-- a variant, an option and a picture belong to the business of their item, and stay with it. Invoker: an app user sees only
-- the items of the business they work in, so nothing can be attached to — or learnt about — another business's item.
-- An update keeps the row's business without reading the item: deleting an item clears the links of its pictures and
-- variants (on delete set null) after the item row is gone.
create or replace function public.catalog_fill_from_item() returns trigger
language plpgsql set search_path = public as $$
declare b uuid; v_new uuid; v_old uuid;
begin
  if tg_op = 'UPDATE' then
    if new.item_id is distinct from old.item_id then
      raise exception 'a variant, an option or a picture stays with its item' using errcode = '23514';
    end if;
    new.business_id := old.business_id;
  else
    select business_id into b from public.catalog_items where id = new.item_id;
    if b is null then raise exception 'item not found' using errcode = '23503'; end if;
    new.business_id := b;
  end if;
  if tg_table_name = 'catalog_media' then
    v_new := new.variant_id;
    if tg_op = 'UPDATE' then v_old := old.variant_id; end if;
    if v_new is not null and v_new is distinct from v_old
       and not exists (select 1 from public.catalog_variants v where v.id = v_new and v.item_id = new.item_id) then
      raise exception 'the variant is not of this item' using errcode = '23514';
    end if;
  elsif tg_table_name = 'catalog_variants' then
    v_new := new.media_id;
    if tg_op = 'UPDATE' then v_old := old.media_id; end if;
    if v_new is not null and v_new is distinct from v_old
       and not exists (select 1 from public.catalog_media m where m.id = v_new and m.item_id = new.item_id) then
      raise exception 'the picture is not of this item' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.catalog_fill_from_item() from public, anon, authenticated;
create or replace trigger a_fill_from_item before insert or update on public.catalog_options  for each row execute function public.catalog_fill_from_item();
create or replace trigger a_fill_from_item before insert or update on public.catalog_variants for each row execute function public.catalog_fill_from_item();
create or replace trigger a_fill_from_item before insert or update on public.catalog_media    for each row execute function public.catalog_fill_from_item();

-- the item's main picture (catalog_items.image_url: the register's tiles) is its first picture, in the 400 size — whoever
-- added, moved or deleted a picture (the server, a screen, a cascade); no picture → ''
create or replace function public.catalog_media_main() returns trigger
language plpgsql security definer set search_path = public as $$
declare it uuid := coalesce(new.item_id, old.item_id); main text;
begin
  select coalesce(nullif(m.sizes->>'400', ''), m.url) into main from public.catalog_media m
   where m.item_id = it order by m.position, m.created_at, m.id limit 1;
  main := case when main ~ '^https://' then main else '' end;
  update public.catalog_items set image_url = main where id = it and image_url is distinct from main;
  return null;
end $$;
revoke execute on function public.catalog_media_main() from public, anon, authenticated;
create or replace trigger catalog_media_main after insert or delete or update of position, url, sizes on public.catalog_media
  for each row execute function public.catalog_media_main();

create or replace function public.catalog_variants_touch() returns trigger
language plpgsql set search_path = public as $$
begin
  if (to_jsonb(new) - 'stock_qty' - 'updated_at') is distinct from (to_jsonb(old) - 'stock_qty' - 'updated_at') then new.updated_at := now(); end if;
  return new;
end $$;
revoke execute on function public.catalog_variants_touch() from public, anon, authenticated;
create or replace trigger b_catalog_variants_touch before update on public.catalog_variants for each row execute function public.catalog_variants_touch();

-- an item "has variants" while one exists. Its existing units stay on the item ("לא משויך") until counted per variant.
create or replace function public.catalog_variants_after() returns trigger
language plpgsql security definer set search_path = public as $$
declare it uuid := coalesce(new.item_id, old.item_id); has boolean;
begin
  has := exists (select 1 from public.catalog_variants v where v.item_id = it);
  update public.catalog_items set has_variants = has where id = it and has_variants is distinct from has;
  return null;
end $$;
revoke execute on function public.catalog_variants_after() from public, anon, authenticated;
create or replace trigger catalog_variants_after after insert or delete on public.catalog_variants for each row execute function public.catalog_variants_after();

-- ---- 3. stock per variant ---------------------------------------------------------------------------------------------------
alter table public.stock_movements add column if not exists variant_id uuid references public.catalog_variants on delete set null;
create index if not exists stock_movements_variant_idx on public.stock_movements (variant_id, created_at desc) where variant_id is not null;

-- the variant's count changes only through the stock functions (like the item's — catalog_items_guard_stock)
create or replace function public.catalog_variants_guard_stock() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' and new.stock_qty <> 0 then
      raise exception 'stock changes only through a delivery or a count (adjust_variant_stock)' using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' and new.stock_qty is distinct from old.stock_qty then
      raise exception 'stock changes only through a delivery or a count (adjust_variant_stock)' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.catalog_variants_guard_stock() from public, anon, authenticated;
create or replace trigger catalog_variants_guard_stock before insert or update on public.catalog_variants for each row execute function public.catalog_variants_guard_stock();

-- units per (item, variant) in a list of lines; junk is ignored and never fails the sale. Ordered: every stock move locks
-- rows in the same order (item, then variant), so two sales of the same products never wait on each other in a circle.
create or replace function public.stock_lines_v(p_items jsonb) returns table (item_id uuid, variant_id uuid, qty int)
language sql immutable set search_path = public as $$
  select (e->>'itemId')::uuid,
         case when coalesce(e->>'variantId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (e->>'variantId')::uuid end,
         sum(floor((e->>'qty')::numeric))::int
    from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) e
   where coalesce(e->>'itemId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     and coalesce(e->>'qty', '') ~ '^[0-9]+(\.[0-9]+)?$'
   group by 1, 2
  having sum(floor((e->>'qty')::numeric)) > 0
   order by 1, 2;
$$;

-- THE one place stock moves. The item's total moves (tracked items of that business only) and, when the line named a variant
-- of this item, that variant too — in one statement each, item first. qty_after is the variant's count on a variant's row,
-- otherwise the item's. A line without a variant of an item that has variants moves only the total: "לא משויך לווריאנט".
create or replace function public.stock_move_v(p_business uuid, p_item uuid, p_variant uuid, p_delta int, p_reason text, p_note text,
                                               p_sale uuid, p_refund uuid, p_document uuid, p_expense uuid)
returns void language plpgsql security definer set search_path = public as $$
declare q int; vq int; v uuid; hv boolean; n text := coalesce(p_note, '');
begin
  if coalesce(p_delta, 0) = 0 then return; end if;
  update public.catalog_items set stock_qty = stock_qty + p_delta
   where id = p_item and business_id = p_business and track_stock
   returning stock_qty, has_variants into q, hv;
  if not found then return; end if;            -- not tracked, another business's item, or deleted
  if p_variant is not null then
    update public.catalog_variants set stock_qty = stock_qty + p_delta
     where id = p_variant and item_id = p_item and business_id = p_business
     returning stock_qty into vq;
    if found then v := p_variant; end if;
  end if;
  if v is null and hv then n := 'לא משויך לווריאנט' || case when n <> '' then ' · ' || n else '' end; end if;
  insert into public.stock_movements (user_id, business_id, item_id, variant_id, delta, qty_after, reason, sale_id, refund_id, document_id, expense_id, note)
  values (auth.uid(), p_business, p_item, v, p_delta, coalesce(vq, q), p_reason, p_sale, p_refund, p_document, p_expense, left(n, 200));
end $$;
revoke execute on function public.stock_move_v(uuid, uuid, uuid, int, text, text, uuid, uuid, uuid, uuid) from public, anon, authenticated;

-- a document's / an expense's move (as stock_move_ref): a delivery of a product not counted yet starts its count
create or replace function public.stock_move_ref_v(p_business uuid, p_item uuid, p_variant uuid, p_delta int, p_reason text, p_note text, p_document uuid, p_expense uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if coalesce(p_delta, 0) = 0 then return; end if;
  if p_reason = 'receive' then
    update public.catalog_items set track_stock = true where id = p_item and business_id = p_business and not track_stock;
  end if;
  perform public.stock_move_v(p_business, p_item, p_variant, p_delta, p_reason, p_note, null, null, p_document, p_expense);
end $$;
revoke execute on function public.stock_move_ref_v(uuid, uuid, uuid, int, text, text, uuid, uuid) from public, anon, authenticated;

-- the existing movers keep their signatures (callers outside this file see no change) and go through the same path
create or replace function public.stock_move(p_business uuid, p_item uuid, p_delta int, p_reason text, p_sale uuid, p_refund uuid, p_note text default '')
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.stock_move_v(p_business, p_item, null, p_delta, p_reason, p_note, p_sale, p_refund, null, null);
end $$;
revoke execute on function public.stock_move(uuid, uuid, int, text, uuid, uuid, text) from public, anon, authenticated;

create or replace function public.stock_move_ref(p_business uuid, p_item uuid, p_delta int, p_reason text, p_note text, p_document uuid, p_expense uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.stock_move_ref_v(p_business, p_item, null, p_delta, p_reason, p_note, p_document, p_expense);
end $$;
revoke execute on function public.stock_move_ref(uuid, uuid, int, text, text, uuid, uuid) from public, anon, authenticated;

-- a sale (paid or awaiting payment) takes its units out; cancelling it puts them back (as 20261004003000, per variant)
create or replace function public.sales_stock() returns trigger
language plpgsql security definer set search_path = public as $$
declare l record;
begin
  if tg_op = 'INSERT' and new.status in ('paid', 'pending') then
    for l in select * from public.stock_lines_v(new.items) loop
      perform public.stock_move_v(new.business_id, l.item_id, l.variant_id, -l.qty, 'sale', '', new.id, null, null, null);
    end loop;
  elsif tg_op = 'UPDATE' and new.status = 'cancelled' and old.status in ('paid', 'pending') then
    for l in select * from public.stock_lines_v(old.items) loop
      perform public.stock_move_v(new.business_id, l.item_id, l.variant_id, l.qty, 'cancel', '', new.id, null, null, null);
    end loop;
  end if;
  return null;
end $$;
revoke execute on function public.sales_stock() from public, anon, authenticated;

-- a refund marked "back to stock" puts the returned units back (as 20261004003000, per variant)
create or replace function public.sale_refunds_restock() returns trigger
language plpgsql security definer set search_path = public as $$
declare l record;
begin
  if new.restock then
    for l in select * from public.stock_lines_v(new.items) loop
      perform public.stock_move_v(new.business_id, l.item_id, l.variant_id, l.qty, 'refund', '', new.sale_id, new.id, null, null);
    end loop;
  end if;
  return null;
end $$;
revoke execute on function public.sale_refunds_restock() from public, anon, authenticated;

-- a document (as 20261004003100 — the ledger, the draft / quote, the audit log are unchanged; stock moves per variant)
create or replace function public.documents_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare p jsonb; m text; l record; rest jsonb;
begin
  -- 1. the ledger: one row per payment of a receipt
  if new.doc_type in (320, 400) then
    for p in select value from jsonb_array_elements(new.payments) loop
      m := coalesce(nullif(p->>'m', ''), case p->>'method' when '1' then 'cash' when '2' then 'cheque' when '3' then 'card' when '4' then 'transfer' else 'other' end);
      if m not in ('cash', 'card', 'transfer', 'bit', 'cheque', 'other') then m := 'other'; end if;
      insert into public.payments (business_id, user_id, direction, amount, method, paid_on, source, document_id, applies_to, sale_id, lead_id, reference)
      values (new.business_id, new.user_id, 'in', (p->>'amount')::numeric, m, coalesce(nullif(p->>'date', '')::date, new.doc_date), 'document',
              new.id, new.paid_document_id, new.sale_id, new.lead_id,
              case when jsonb_typeof(p->'cheque') = 'object' then p->'cheque' else '{}'::jsonb end);
    end loop;
  end if;
  -- 2. the draft it came from is now issued; the quote it came from is converted
  if new.draft_id is not null then
    update public.document_drafts set status = 'finalized', document_id = new.id where id = new.draft_id and business_id = new.business_id;
  end if;
  if new.quote_id is not null then
    update public.quotes set status = 'converted', converted_document_id = new.id
     where id = new.quote_id and business_id = new.business_id and status in ('draft', 'sent', 'accepted');
  end if;
  -- 3. stock: products sold on a direct document go out on the document that makes the sale — a 300 / 305, or a
  --    320 / 400 that stands alone — and never again on the receipt that pays it (whole or in parts, exempt or not).
  --    Cancelling that document brings them back (document_cancellations_after). The register's sales move stock on
  --    their own. A direct credit invoice brings back the lines marked "restock". A line's variant moves with it (3300).
  if new.sale_id is null and new.refund_id is null then
    if new.doc_type in (300, 305, 320, 400) and new.paid_document_id is null then
      for l in select * from public.stock_lines_v(new.lines) loop
        perform public.stock_move_ref_v(new.business_id, l.item_id, l.variant_id, -l.qty, 'sale', format('%s-%s', new.doc_type, new.doc_number), new.id, null);
      end loop;
    elsif new.doc_type = 330 then
      select coalesce(jsonb_agg(e), '[]'::jsonb) into rest from jsonb_array_elements(new.lines) e where (e->>'restock') = 'true';
      for l in select * from public.stock_lines_v(rest) loop
        perform public.stock_move_ref_v(new.business_id, l.item_id, l.variant_id, l.qty, 'refund', format('%s-%s', new.doc_type, new.doc_number), new.id, null);
      end loop;
    end if;
  end if;
  -- 4. the audit log
  perform public.finance_log(new.business_id, 'document.issued', 'documents', new.id::text,
    jsonb_build_object('type', new.doc_type, 'number', new.doc_number, 'total', new.total, 'date', new.doc_date, 'source', new.source));
  return null;
end $$;
revoke execute on function public.documents_after_insert() from public, anon, authenticated;

-- a cancelled document (as 20261004003100): its money goes back off the books, its products come back — per variant
create or replace function public.document_cancellations_after() returns trigger
language plpgsql security definer set search_path = public as $$
declare d record; l record;
begin
  select doc_type, doc_number into d from public.documents where id = new.document_id;
  -- money of a cancelled receipt goes back off the books (a reversing row; the original row stays)
  insert into public.payments (business_id, user_id, direction, amount, method, paid_on, source, document_id, applies_to, sale_id, lead_id, note)
  select p.business_id, auth.uid(), 'out', p.amount, p.method, public.il_today(), 'cancel', p.document_id, p.applies_to, p.sale_id, p.lead_id, left(new.reason, 300)
    from public.payments p where p.document_id = new.document_id and p.direction = 'in' and p.source = 'document';
  -- the products that went out on it come back (a direct document; a register sale puts its stock back on its own)
  for l in select m.item_id, m.variant_id, sum(m.delta)::int as qty from public.stock_movements m where m.document_id = new.document_id
            group by m.item_id, m.variant_id having sum(m.delta) <> 0 order by m.item_id, m.variant_id loop
    perform public.stock_move_ref_v(new.business_id, l.item_id, l.variant_id, -l.qty, 'cancel', format('ביטול %s-%s', d.doc_type, d.doc_number), new.document_id, null);
  end loop;
  perform public.finance_log(new.business_id, 'document.cancelled', 'documents', new.document_id::text,
    jsonb_build_object('type', d.doc_type, 'number', d.doc_number, 'reason', new.reason));
  return null;
end $$;
revoke execute on function public.document_cancellations_after() from public, anon, authenticated;

-- an expense (as 20261004003100): money out once confirmed and paid; voided — money and stock move back, per variant
create or replace function public.expenses_after() returns trigger
language plpgsql security definer set search_path = public as $$
declare l record; credit boolean := new.supplier_doc_type = 'credit';
begin
  -- money out (a supplier's credit note: money back in) once the expense is confirmed and paid
  if new.status = 'confirmed' and new.paid_on is not null
     and (tg_op = 'INSERT' or old.status <> 'confirmed' or old.paid_on is null) then
    insert into public.payments (business_id, user_id, direction, amount, method, paid_on, source, expense_id, note)
    values (new.business_id, auth.uid(), case when credit then 'in' else 'out' end, new.total, new.payment_method, new.paid_on, 'expense', new.id,
            left(new.supplier_name, 300));
  end if;
  if tg_op = 'UPDATE' and new.status = 'void' and old.status <> 'void' then
    -- what moved for it moves back: money (a reversing row) and stock
    insert into public.payments (business_id, user_id, direction, amount, method, paid_on, source, expense_id, note)
    select p.business_id, auth.uid(), case p.direction when 'in' then 'out' else 'in' end, p.amount, p.method, public.il_today(), 'reversal', p.expense_id,
           left('ביטול: ' || new.void_reason, 300)
      from public.payments p where p.expense_id = new.id and p.source = 'expense';
    for l in select m.item_id, m.variant_id, sum(m.delta)::int as qty from public.stock_movements m where m.expense_id = new.id
              group by m.item_id, m.variant_id having sum(m.delta) <> 0 order by m.item_id, m.variant_id loop
      perform public.stock_move_ref_v(new.business_id, l.item_id, l.variant_id, -l.qty, 'adjust', format('ביטול הוצאה %s', new.expense_number), null, new.id);
    end loop;
  end if;
  perform public.finance_log(new.business_id,
    case when tg_op = 'INSERT' then 'expense.created'
         when new.status = 'void' and old.status <> 'void' then 'expense.voided'
         when new.status = 'confirmed' and old.status = 'draft' then 'expense.confirmed'
         when new.paid_on is not null and old.paid_on is null then 'expense.paid'
         else 'expense.updated' end,
    'expenses', new.id::text, jsonb_build_object('number', new.expense_number, 'total', new.total, 'status', new.status, 'date', new.doc_date));
  return null;
end $$;
revoke execute on function public.expenses_after() from public, anon, authenticated;

-- products bought with a confirmed expense come into stock — once (as 20261005003200, per variant)
create or replace function public.receive_expense_stock(p_expense uuid) returns int
language plpgsql security definer set search_path = public as $$
declare b uuid := public.finance_guard(); e record; l record; n int := 0;
begin
  if not public.can_write() then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into e from public.expenses where id = p_expense for update;
  if not found or e.business_id <> b then raise exception 'not allowed' using errcode = '42501'; end if;
  if e.status <> 'confirmed' then raise exception 'only a confirmed expense brings stock in' using errcode = '23514'; end if;
  if exists (select 1 from public.stock_movements m where m.expense_id = e.id and m.reason = 'receive') then return 0; end if;
  for l in select * from public.stock_lines_v(e.stock_lines) loop
    if exists (select 1 from public.catalog_items c where c.id = l.item_id and c.business_id = b) then
      perform public.stock_move_ref_v(b, l.item_id, l.variant_id, l.qty, 'receive', format('הוצאה %s · %s', e.expense_number, e.supplier_name), null, e.id);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- "+ קבלת סחורה" / "ספירת מלאי" of an item without variants (as 20261005003200). An item with variants is counted per variant.
create or replace function public.adjust_stock(p_item uuid, p_mode text, p_qty int, p_note text default '')
returns int language plpgsql security definer set search_path = public as $$
declare b uuid; cur int; d int; hv boolean;
begin
  select business_id, stock_qty, has_variants into b, cur, hv from public.catalog_items where id = p_item for update;
  if b is null or b is distinct from public.current_business_id() or not public.can_access_business(b) or public.my_access() = 'register'
     or not public.can_write() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if hv then raise exception 'variant_required: an item with variants is counted per variant' using errcode = '22023'; end if;
  if p_mode = 'add' then
    if coalesce(p_qty, 0) <= 0 then raise exception 'a delivery adds at least one unit' using errcode = '22023'; end if;
    d := p_qty;
  elsif p_mode = 'set' then
    if coalesce(p_qty, -1) < 0 then raise exception 'a count is zero or more' using errcode = '22023'; end if;
    d := p_qty - cur;
  else
    raise exception 'mode is add or set' using errcode = '22023';
  end if;
  update public.catalog_items set track_stock = true where id = p_item and not track_stock;  -- counting = tracking
  perform public.stock_move(b, p_item, d, case when p_mode = 'add' then 'receive' else 'count' end, null, null, p_note);
  return (select stock_qty from public.catalog_items where id = p_item);
end $$;
revoke execute on function public.adjust_stock(uuid, text, int, text) from public, anon;
grant execute on function public.adjust_stock(uuid, text, int, text) to authenticated;

-- the same for one variant: the variant's count and the item's sum move together (item locked first)
create or replace function public.adjust_variant_stock(p_variant uuid, p_mode text, p_qty int, p_note text default '')
returns int language plpgsql security definer set search_path = public as $$
declare b uuid; it uuid; cur int; d int;
begin
  select business_id, item_id into b, it from public.catalog_variants where id = p_variant;
  if b is null or b is distinct from public.current_business_id() or not public.can_access_business(b) or public.my_access() = 'register'
     or not public.can_write() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform 1 from public.catalog_items where id = it for update;
  select stock_qty into cur from public.catalog_variants where id = p_variant for update;
  if p_mode = 'add' then
    if coalesce(p_qty, 0) <= 0 then raise exception 'a delivery adds at least one unit' using errcode = '22023'; end if;
    d := p_qty;
  elsif p_mode = 'set' then
    if coalesce(p_qty, -1) < 0 then raise exception 'a count is zero or more' using errcode = '22023'; end if;
    d := p_qty - cur;
  else
    raise exception 'mode is add or set' using errcode = '22023';
  end if;
  update public.catalog_items set track_stock = true where id = it and not track_stock;  -- counting = tracking
  perform public.stock_move_v(b, it, p_variant, d, case when p_mode = 'add' then 'receive' else 'count' end, p_note, null, null, null, null);
  return (select stock_qty from public.catalog_variants where id = p_variant);
end $$;
revoke execute on function public.adjust_variant_stock(uuid, text, int, text) from public, anon;
grant execute on function public.adjust_variant_stock(uuid, text, int, text) to authenticated;

-- after counting every variant: the units still on the item alone ("לא משויך") are taken off — the item's sum becomes the sum
-- of its variants, logged as a count
create or replace function public.reconcile_variant_stock(p_item uuid, p_note text default '')
returns int language plpgsql security definer set search_path = public as $$
declare b uuid; cur int; hv boolean; tracked boolean; total int;
begin
  select business_id, stock_qty, has_variants, track_stock into b, cur, hv, tracked from public.catalog_items where id = p_item for update;
  if b is null or b is distinct from public.current_business_id() or not public.can_access_business(b) or public.my_access() = 'register'
     or not public.can_write() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not hv then raise exception 'the item has no variants' using errcode = '22023'; end if;
  if not tracked then return cur; end if;
  select coalesce(sum(stock_qty), 0)::int into total from public.catalog_variants where item_id = p_item;
  perform public.stock_move_v(b, p_item, null, total - cur, 'count', coalesce(nullif(p_note, ''), 'התאמה לסכום הווריאנטים'), null, null, null, null);
  return (select stock_qty from public.catalog_items where id = p_item);
end $$;
revoke execute on function public.reconcile_variant_stock(uuid, text) from public, anon;
grant execute on function public.reconcile_variant_stock(uuid, text) to authenticated;

-- ---- 4. a SKU / barcode is one product of the business: unique across items and variants -------------------------------------
-- Invoker: an app user sees only their business's rows, so the check can never tell them about another business's codes.
-- One code check of a business at a time (until commit): two screens saving the same new code can not both pass.
create or replace function public.catalog_codes_check() returns trigger
language plpgsql set search_path = public as $$
declare me uuid := new.id; b uuid := new.business_id;
begin
  if new.barcode = '' and new.sku = '' then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('catalog_codes:' || b::text, 0));
  if new.barcode <> '' and (
       exists (select 1 from public.catalog_items i where i.business_id = b and i.barcode = new.barcode and (tg_table_name <> 'catalog_items' or i.id <> me))
    or exists (select 1 from public.catalog_variants v where v.business_id = b and v.barcode = new.barcode and (tg_table_name <> 'catalog_variants' or v.id <> me))) then
    raise exception 'code_taken: the barcode is already used by another product' using errcode = '23505';
  end if;
  if new.sku <> '' and (
       exists (select 1 from public.catalog_items i where i.business_id = b and lower(i.sku) = lower(new.sku) and (tg_table_name <> 'catalog_items' or i.id <> me))
    or exists (select 1 from public.catalog_variants v where v.business_id = b and lower(v.sku) = lower(new.sku) and (tg_table_name <> 'catalog_variants' or v.id <> me))) then
    raise exception 'code_taken: the SKU is already used by another product' using errcode = '23505';
  end if;
  return new;
end $$;
revoke execute on function public.catalog_codes_check() from public, anon, authenticated;
create or replace trigger b_catalog_codes_check before insert or update of sku, barcode on public.catalog_items    for each row execute function public.catalog_codes_check();
create or replace trigger b_catalog_codes_check before insert or update of sku, barcode on public.catalog_variants for each row execute function public.catalog_codes_check();

-- ---- 5. row-level security (the 3100 pattern + the viewer of 3200). A cashier reads the catalog (the register needs variants
--         and pictures) and never writes it; pictures are inserted by the server only; the item of a picture never changes -----
do $$
declare
  t text; op text;
  gate        constant text := 'business_id = (select public.current_business_id()) and business_id in (select public.accessible_business_ids())';
  full_access constant text := '(select public.my_access()) <> ''register''';
  writer      constant text := '(select public.can_write())';
begin
  foreach t in array array['catalog_options', 'catalog_variants', 'catalog_media', 'catalog_field_defs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate on public.%I from authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_business_gate') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)', t || '_business_gate', t, gate, gate);
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
      if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_cashier_' || op) then
        execute format('create policy %I on public.%I as restrictive for %s to authenticated %s', t || '_cashier_' || op, t, op,
          case op when 'insert' then format('with check (%s)', full_access) when 'update' then format('using (%s) with check (%s)', full_access, full_access) else format('using (%s)', full_access) end);
      end if;
    end loop;
  end loop;
end $$;
grant insert, update, delete on public.catalog_options, public.catalog_variants, public.catalog_field_defs to authenticated;
-- a picture: the server inserts it (after the upload); the screen may change its alt text, its order, its variant — or delete it
grant update (alt, position, variant_id) on public.catalog_media to authenticated;
grant delete on public.catalog_media to authenticated;

-- ---- 6. store-media: the public pictures of products (sizes made in the browser, uploaded through the server's signed links) --
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('store-media', 'store-media', true, 5242880, array['image/webp', 'image/jpeg'])
on conflict (id) do nothing;
-- no storage policy for the app's roles: uploads and deletions go through the server (service role); reading is public

-- ============================================================================================================================
-- Rollback (by hand, if ever needed — not recommended once variants hold stock):
--   restore stock_move, stock_move_ref, sales_stock, sale_refunds_restock, documents_after_insert, document_cancellations_after,
--   expenses_after, receive_expense_stock and adjust_stock from 20261004003000 / 20261004003100 / 20261005003200;
--   drop the triggers a_fill_from_item, catalog_media_main, b_catalog_variants_touch, catalog_variants_after, catalog_variants_guard_stock,
--   b_catalog_codes_check, b_catalog_items_touch; drop the functions stock_move_v, stock_move_ref_v, stock_lines_v,
--   adjust_variant_stock, reconcile_variant_stock, catalog_fill_from_item, catalog_media_main, catalog_variants_touch, catalog_variants_after,
--   catalog_variants_guard_stock, catalog_codes_check, catalog_items_touch; drop table catalog_field_defs, catalog_media,
--   catalog_variants, catalog_options (cascade); alter table stock_movements drop column variant_id; drop the new
--   catalog_items columns and constraints; delete the bucket store-media (and its files).
-- ============================================================================================================================
