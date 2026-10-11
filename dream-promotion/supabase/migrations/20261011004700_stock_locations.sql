-- ============================================================================================================================
-- Stock by location (docs/FINANCE_ADDITIONS_HE.md T12ב) — 2.92.0. Runs after 20261010004600 (locations): it stops at the top
-- without it, changing nothing. No row that is there is removed or changed — only where the stock is counted.
--   1. tables      stock_levels — the count of each tracked item (and variant) at every location but the main one. The main
--                  location's count is the total less the others, so the total (catalog_items / catalog_variants.stock_qty) stays
--                  the one number the screens and the store read, and is always the sum of the locations. stock_transfers (an
--                  internal transfer note between two locations — not a tax document) and stock_counts (a count of one location).
--   2. movements   stock_movements.location_id (none = the main location, as every row before this file), location_after (the
--                  location's count after the move), transfer_id / count_id, and the reason "transfer".
--   3. moving      stock_move_at — THE one place stock moves now: the total, the variant, and the location's count, in one go,
--                  under the item's lock. The movers before it keep their signatures and move at the main location. A sale, a
--                  refund, a document and an expense move at their own location (4600: a sale's is its register's); cancelling
--                  a document and voiding an expense move back where it moved.
--   4. counting    stock_adjust (a delivery or a count at a location); adjust_stock / adjust_variant_stock count where the user
--                  works (with one location: as before); reconcile_variant_stock reconciles every location. A count on the spot
--                  ("ספירה" next to a product, "סיום ספירה") is the owner's only — anyone else counts in a count the owner approves.
--   5. reading     the view stock_by_location — every location's count of every tracked item and variant, for the locations the
--                  user may use (a cashier: their own — the register shows it).
--   6. transfers   sent (out of the source at once; the units are on the way) → received (into the destination; a difference
--                  is an "adjust" move with its reason), or cancelled (back to the source).
--   7. counts      a count of one location, line by line (from the phone); the owner approves, and only then the differences
--                  become "count" moves — each line as of the moment it was counted (sales after it are not lost).
--   8. the store   what the site sells is what is at the store's shipping location (stores.location_id, 4600; none = the main
--                  one); the register does not sell units held for an order of the site at that location.
-- With one location every number stays what it was: the main location's count is the total.
-- The rollback is a comment at the end.
-- ============================================================================================================================

do $$ begin
  if to_regclass('public.business_locations') is null or to_regclass('public.registers') is null then
    raise exception '20261011004700 needs 20261010004600 (locations) first';
  end if;
end $$;

-- ---- 1. tables -------------------------------------------------------------------------------------------------------------------
create table if not exists public.stock_levels (
  business_id uuid not null references public.businesses on delete restrict,
  location_id uuid not null,
  item_id     uuid not null references public.catalog_items on delete cascade,
  variant_id  uuid references public.catalog_variants on delete cascade,   -- none: the item's own count there (all its units)
  qty         int  not null default 0,
  updated_at  timestamptz not null default now(),
  foreign key (location_id, business_id) references public.business_locations (id, business_id) on delete restrict,
  check (location_id <> business_id)   -- the main location's count is the total less these
);
create unique index if not exists stock_levels_uq on public.stock_levels (location_id, item_id, coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists stock_levels_item_idx on public.stock_levels (item_id, variant_id);

create table if not exists public.stock_transfers (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses on delete restrict,
  number        int  not null check (number > 0),
  from_location uuid not null,
  to_location   uuid not null,
  status        text not null default 'sent' check (status in ('sent', 'received', 'cancelled')),
  -- [{itemId, variantId, name, variant, qty, received?, reason?}] — the names as they were when it was sent
  lines         jsonb not null check (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) between 1 and 200),
  note          text not null default '' check (length(note) <= 300),
  sent_by       uuid references auth.users on delete set null,
  sent_at       timestamptz not null default now(),
  received_by   uuid references auth.users on delete set null,
  received_at   timestamptz,
  received_note text not null default '' check (length(received_note) <= 300),
  cancelled_by  uuid references auth.users on delete set null,
  cancelled_at  timestamptz,
  cancel_reason text not null default '' check (length(cancel_reason) <= 300),
  unique (business_id, number),
  foreign key (from_location, business_id) references public.business_locations (id, business_id) on delete restrict,
  foreign key (to_location, business_id) references public.business_locations (id, business_id) on delete restrict,
  check (from_location <> to_location)
);
create index if not exists stock_transfers_business_idx on public.stock_transfers (business_id, sent_at desc);

create table if not exists public.stock_counts (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses on delete restrict,
  number       int  not null check (number > 0),
  location_id  uuid not null,
  status       text not null default 'open' check (status in ('open', 'approved', 'cancelled')),
  -- what was counted: {"<item>:<variant>": {itemId, variantId, counted, at, by}} — a line as of the moment it was counted
  lines        jsonb not null default '{}' check (jsonb_typeof(lines) = 'object'),
  note         text not null default '' check (length(note) <= 300),
  result       jsonb,                    -- what the owner approved: [{itemId, variantId, counted, expected, gap}]
  created_by   uuid references auth.users on delete set null,
  created_at   timestamptz not null default now(),
  approved_by  uuid references auth.users on delete set null,
  approved_at  timestamptz,
  cancelled_by uuid references auth.users on delete set null,
  cancelled_at timestamptz,
  unique (business_id, number),
  foreign key (location_id, business_id) references public.business_locations (id, business_id) on delete restrict
);
create unique index if not exists stock_counts_one_open on public.stock_counts (location_id) where status = 'open';
create index if not exists stock_counts_business_idx on public.stock_counts (business_id, created_at desc);

-- ---- 2. a movement names its location ------------------------------------------------------------------------------------------
alter table public.stock_movements add column if not exists location_id    uuid;
alter table public.stock_movements add column if not exists location_after int;
alter table public.stock_movements add column if not exists transfer_id    uuid references public.stock_transfers on delete restrict;
alter table public.stock_movements add column if not exists count_id       uuid references public.stock_counts on delete restrict;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'stock_movements_location_fk') then
    alter table public.stock_movements add constraint stock_movements_location_fk
      foreign key (location_id, business_id) references public.business_locations (id, business_id) on delete restrict;
  end if;
end $$;
alter table public.stock_movements drop constraint if exists stock_movements_reason_check;
alter table public.stock_movements add constraint stock_movements_reason_check
  check (reason in ('sale', 'cancel', 'refund', 'receive', 'count', 'adjust', 'transfer'));
create index if not exists stock_movements_transfer_idx on public.stock_movements (transfer_id) where transfer_id is not null;
create index if not exists stock_movements_count_idx on public.stock_movements (count_id) where count_id is not null;

-- ---- 3. moving ---------------------------------------------------------------------------------------------------------------------
-- where the business's store ships from: its location, else the main one (a business has one store)
create or replace function public.stock_ship_location(p_business uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce((select s.location_id from public.stores s where s.business_id = p_business limit 1), p_business)
$$;

-- the count at a location of an item (p_variant null: all its units there) or of one of its variants. The main location's (its id
-- is the business's) is the total less the other locations'.
create or replace function public.stock_at(p_location uuid, p_item uuid, p_variant uuid) returns int
language sql stable security definer set search_path = public as $$
  select case when p_location = i.business_id then
           coalesce(case when p_variant is null then i.stock_qty
                         else (select v.stock_qty from public.catalog_variants v where v.id = p_variant and v.item_id = i.id) end, 0)
           - coalesce((select sum(s.qty) from public.stock_levels s where s.item_id = i.id and s.variant_id is not distinct from p_variant), 0)::int
         else coalesce((select s.qty from public.stock_levels s
                         where s.location_id = p_location and s.item_id = i.id and s.variant_id is not distinct from p_variant), 0) end
    from public.catalog_items i where i.id = p_item
$$;

-- what the site may sell of an item / a variant: what is at the store's shipping location
create or replace function public.sf_stock(p_item uuid, p_variant uuid) returns int
language sql stable security definer set search_path = public as $$
  select public.stock_at(public.stock_ship_location(i.business_id), i.id, p_variant) from public.catalog_items i where i.id = p_item
$$;

-- THE one place stock moves (instead of stock_move_v, 3300). The item's total (tracked items of that business only), the
-- variant's when the line named one of this item, and the location's count — in one go, the item's row first: every move of an
-- item waits for the one before it, so a location's count is never written twice at once. qty_after is the variant's total on a
-- variant's row, otherwise the item's (as before); location_after is the location's count of the same.
create or replace function public.stock_move_at(p_business uuid, p_location uuid, p_item uuid, p_variant uuid, p_delta int, p_reason text,
    p_note text, p_sale uuid, p_refund uuid, p_document uuid, p_expense uuid, p_transfer uuid, p_count uuid)
returns void language plpgsql security definer set search_path = public as $$
declare q int; vq int; v uuid; hv boolean; n text := coalesce(p_note, ''); loc uuid := coalesce(p_location, p_business); la int;
begin
  if coalesce(p_delta, 0) = 0 then return; end if;
  if loc <> p_business and not exists (select 1 from public.business_locations l where l.id = loc and l.business_id = p_business) then
    raise exception 'stock_location: a location of the business' using errcode = '23503';
  end if;
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

-- a document's / an expense's move at a location (as stock_move_ref_v): a delivery of a product not counted yet starts its count
create or replace function public.stock_move_ref_at(p_business uuid, p_location uuid, p_item uuid, p_variant uuid, p_delta int, p_reason text,
    p_note text, p_document uuid, p_expense uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if coalesce(p_delta, 0) = 0 then return; end if;
  if p_reason = 'receive' then
    update public.catalog_items set track_stock = true where id = p_item and business_id = p_business and not track_stock;
  end if;
  perform public.stock_move_at(p_business, p_location, p_item, p_variant, p_delta, p_reason, p_note, null, null, p_document, p_expense, null, null);
end $$;

-- the movers before this file keep their signatures (nothing calls them any more) and move at the main location
create or replace function public.stock_move_v(p_business uuid, p_item uuid, p_variant uuid, p_delta int, p_reason text, p_note text,
                                               p_sale uuid, p_refund uuid, p_document uuid, p_expense uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.stock_move_at(p_business, p_business, p_item, p_variant, p_delta, p_reason, p_note, p_sale, p_refund, p_document, p_expense, null, null);
end $$;
create or replace function public.stock_move_ref_v(p_business uuid, p_item uuid, p_variant uuid, p_delta int, p_reason text, p_note text, p_document uuid, p_expense uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.stock_move_ref_at(p_business, p_business, p_item, p_variant, p_delta, p_reason, p_note, p_document, p_expense);
end $$;
revoke execute on function public.stock_ship_location(uuid), public.stock_at(uuid, uuid, uuid), public.sf_stock(uuid, uuid),
  public.stock_move_at(uuid, uuid, uuid, uuid, int, text, text, uuid, uuid, uuid, uuid, uuid, uuid),
  public.stock_move_ref_at(uuid, uuid, uuid, uuid, int, text, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.stock_at(uuid, uuid, uuid), public.stock_ship_location(uuid) to service_role;

-- the rows that move stock — at their own location (each function as it was, only the mover changes)
-- as 20261005003300_commerce_catalog: a sale takes its units out at its location (its register's), a cancel puts them back there
create or replace function public.sales_stock() returns trigger
language plpgsql security definer set search_path = public as $$
declare l record;
begin
  if tg_op = 'INSERT' and new.status in ('paid', 'pending') then
    for l in select * from public.stock_lines_v(new.items) loop
      perform public.stock_move_at(new.business_id, coalesce(new.location_id, new.business_id), l.item_id, l.variant_id, -l.qty, 'sale', '', new.id, null, null, null, null, null);
    end loop;
  elsif tg_op = 'UPDATE' and new.status = 'cancelled' and old.status in ('paid', 'pending') then
    for l in select * from public.stock_lines_v(old.items) loop
      perform public.stock_move_at(new.business_id, coalesce(new.location_id, new.business_id), l.item_id, l.variant_id, l.qty, 'cancel', '', new.id, null, null, null, null, null);
    end loop;
  end if;
  return null;
end $$;

-- as 20261005003300_commerce_catalog: a refund puts its units back at its location
create or replace function public.sale_refunds_restock() returns trigger
language plpgsql security definer set search_path = public as $$
declare l record;
begin
  if new.restock then
    for l in select * from public.stock_lines_v(new.items) loop
      perform public.stock_move_at(new.business_id, coalesce(new.location_id, new.business_id), l.item_id, l.variant_id, l.qty, 'refund', '', new.sale_id, new.id, null, null, null, null);
    end loop;
  end if;
  return null;
end $$;

-- as 20261005003300_commerce_catalog: a document's products move at the document's location; nothing else changes
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
        perform public.stock_move_ref_at(new.business_id, coalesce(new.location_id, new.business_id), l.item_id, l.variant_id, -l.qty, 'sale', format('%s-%s', new.doc_type, new.doc_number), new.id, null);
      end loop;
    elsif new.doc_type = 330 then
      select coalesce(jsonb_agg(e), '[]'::jsonb) into rest from jsonb_array_elements(new.lines) e where (e->>'restock') = 'true';
      for l in select * from public.stock_lines_v(rest) loop
        perform public.stock_move_ref_at(new.business_id, coalesce(new.location_id, new.business_id), l.item_id, l.variant_id, l.qty, 'refund', format('%s-%s', new.doc_type, new.doc_number), new.id, null);
      end loop;
    end if;
  end if;
  -- 4. the audit log
  perform public.finance_log(new.business_id, 'document.issued', 'documents', new.id::text,
    jsonb_build_object('type', new.doc_type, 'number', new.doc_number, 'total', new.total, 'date', new.doc_date, 'source', new.source));
  return null;
end $$;

-- as 20261005003300_commerce_catalog: what moved for the document moves back where it moved; nothing else changes
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
  for l in select coalesce(m.location_id, m.business_id) as loc, m.item_id, m.variant_id, sum(m.delta)::int as qty from public.stock_movements m
            where m.document_id = new.document_id
            group by 1, m.item_id, m.variant_id having sum(m.delta) <> 0 order by m.item_id, m.variant_id, 1 loop
    perform public.stock_move_ref_at(new.business_id, l.loc, l.item_id, l.variant_id, -l.qty, 'cancel', format('ביטול %s-%s', d.doc_type, d.doc_number), new.document_id, null);
  end loop;
  perform public.finance_log(new.business_id, 'document.cancelled', 'documents', new.document_id::text,
    jsonb_build_object('type', d.doc_type, 'number', d.doc_number, 'reason', new.reason));
  return null;
end $$;

-- as 20261005003300_commerce_catalog: what moved for a voided expense moves back where it moved; nothing else changes
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
    for l in select coalesce(m.location_id, m.business_id) as loc, m.item_id, m.variant_id, sum(m.delta)::int as qty from public.stock_movements m
              where m.expense_id = new.id
              group by 1, m.item_id, m.variant_id having sum(m.delta) <> 0 order by m.item_id, m.variant_id, 1 loop
      perform public.stock_move_ref_at(new.business_id, l.loc, l.item_id, l.variant_id, -l.qty, 'adjust', format('ביטול הוצאה %s', new.expense_number), null, new.id);
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

-- as 20261005003300_commerce_catalog: the goods come in at the expense's location; nothing else changes
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
      perform public.stock_move_ref_at(b, coalesce(e.location_id, e.business_id), l.item_id, l.variant_id, l.qty, 'receive', format('הוצאה %s · %s', e.expense_number, e.supplier_name), null, e.id);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- ---- 4. counting ---------------------------------------------------------------------------------------------------------------------
-- "+ קבלת סחורה" (add) or "ספירה" (set the counted number) of an item — or of one of its variants — at a location; returns the
-- location's count after. Counting = tracking (as adjust_stock). Members with full access who may write, at a location they may use.
-- A count on the spot ("set") is the owner's (location_owner — the owner's decision, 11.10.2026): it moves stock with no approval,
-- so anyone else counts in a stock count (section 7), which the owner approves. A delivery ("add") — as before.
create or replace function public.stock_adjust(p_location uuid, p_item uuid, p_variant uuid, p_mode text, p_qty int, p_note text default '')
returns int language plpgsql security definer set search_path = public as $$
declare b uuid; hv boolean; cur int; d int; loc uuid;
begin
  select business_id, has_variants into b, hv from public.catalog_items where id = p_item;
  if b is null or b is distinct from public.current_business_id() or not public.can_access_business(b) or public.my_access() = 'register'
     or not public.can_write() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  loc := coalesce(p_location, b);
  if not exists (select 1 from public.business_locations l where l.id = loc and l.business_id = b) then
    raise exception 'stock_location: a location of the business' using errcode = '22023';
  end if;
  if not public.location_allowed(b, loc) then raise exception 'not allowed: this location is not yours' using errcode = '42501'; end if;
  if p_mode = 'set' and not public.location_owner() then
    raise exception 'not allowed: the owner counts on the spot (others count in a stock count the owner approves)' using errcode = '42501';
  end if;
  if p_variant is null and hv then raise exception 'variant_required: an item with variants is counted per variant' using errcode = '22023'; end if;
  if p_variant is not null and not exists (select 1 from public.catalog_variants v where v.id = p_variant and v.item_id = p_item) then
    raise exception 'variant_not_found: a variant of this item' using errcode = '22023';
  end if;
  perform 1 from public.catalog_items where id = p_item for update;          -- the item first, as every move
  update public.catalog_items set track_stock = true where id = p_item and not track_stock;   -- counting = tracking
  cur := public.stock_at(loc, p_item, p_variant);
  if p_mode = 'add' then
    if coalesce(p_qty, 0) <= 0 then raise exception 'a delivery adds at least one unit' using errcode = '22023'; end if;
    d := p_qty;
  elsif p_mode = 'set' then
    if coalesce(p_qty, -1) < 0 then raise exception 'a count is zero or more' using errcode = '22023'; end if;
    d := p_qty - cur;
  else
    raise exception 'mode is add or set' using errcode = '22023';
  end if;
  perform public.stock_move_at(b, loc, p_item, p_variant, d, case when p_mode = 'add' then 'receive' else 'count' end, p_note,
                               null, null, null, null, null, null);
  return public.stock_at(loc, p_item, p_variant);
end $$;
revoke execute on function public.stock_adjust(uuid, uuid, uuid, text, int, text) from public, anon;
grant execute on function public.stock_adjust(uuid, uuid, uuid, text, int, text) to authenticated;

-- the screens before 2.92 (same signatures): where the user works — the location picked, their only one, else the main one.
-- With one location: as before (its count is the total).
create or replace function public.adjust_stock(p_item uuid, p_mode text, p_qty int, p_note text default '')
returns int language plpgsql security definer set search_path = public as $$
declare b uuid;
begin
  select business_id into b from public.catalog_items where id = p_item;
  if b is null or b is distinct from public.current_business_id() or not public.can_access_business(b) or public.my_access() = 'register'
     or not public.can_write() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return public.stock_adjust(coalesce(public.location_pick(b), b), p_item, null, p_mode, p_qty, p_note);
end $$;
create or replace function public.adjust_variant_stock(p_variant uuid, p_mode text, p_qty int, p_note text default '')
returns int language plpgsql security definer set search_path = public as $$
declare b uuid; it uuid;
begin
  select business_id, item_id into b, it from public.catalog_variants where id = p_variant;
  if b is null or b is distinct from public.current_business_id() or not public.can_access_business(b) or public.my_access() = 'register'
     or not public.can_write() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return public.stock_adjust(coalesce(public.location_pick(b), b), it, p_variant, p_mode, p_qty, p_note);
end $$;

-- after counting every variant: the units still on the item alone ("לא משויך") are taken off — at every location, the item's
-- count becomes the sum of its variants' counts there (as 3300, which did it for the total), logged as a count. A count with no
-- approval: the owner's only (as a count on the spot in stock_adjust) — and the owner may use every location
create or replace function public.reconcile_variant_stock(p_item uuid, p_note text default '')
returns int language plpgsql security definer set search_path = public as $$
declare b uuid; cur int; hv boolean; tracked boolean; l record; d int; n text := coalesce(nullif(p_note, ''), 'התאמה לסכום הווריאנטים');
begin
  select business_id, stock_qty, has_variants, track_stock into b, cur, hv, tracked from public.catalog_items where id = p_item for update;
  if b is null or b is distinct from public.current_business_id() or not public.can_access_business(b) or public.my_access() = 'register'
     or not public.can_write() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not hv then raise exception 'the item has no variants' using errcode = '22023'; end if;
  if not public.location_owner() then
    raise exception 'not allowed: the owner counts on the spot (others count in a stock count the owner approves)' using errcode = '42501';
  end if;
  if not tracked then return cur; end if;
  for l in select s.location_id, s.qty,
                  coalesce((select sum(x.qty) from public.stock_levels x where x.location_id = s.location_id and x.item_id = p_item and x.variant_id is not null), 0)::int as vsum
             from public.stock_levels s where s.item_id = p_item and s.variant_id is null order by s.location_id loop
    d := l.vsum - l.qty;
    if d <> 0 then perform public.stock_move_at(b, l.location_id, p_item, null, d, 'count', n, null, null, null, null, null, null); end if;
  end loop;
  -- the main location: the rest
  d := (select coalesce(sum(v.stock_qty), 0)::int from public.catalog_variants v where v.item_id = p_item)
       - (select i.stock_qty from public.catalog_items i where i.id = p_item);
  if d <> 0 then perform public.stock_move_at(b, b, p_item, null, d, 'count', n, null, null, null, null, null, null); end if;
  return (select stock_qty from public.catalog_items where id = p_item);
end $$;

-- ---- 5. reading -----------------------------------------------------------------------------------------------------------------------
-- every location's count of every tracked item (variant null) and of each of its variants — for the locations the user may use
-- (the location picked at the top does not hide the others: where the stock is, is what a transfer needs). A cashier reads it
-- too (the register shows the count of its own location).
create or replace function public.stock_by_location_rows() returns table (location_id uuid, item_id uuid, variant_id uuid, qty int)
language sql stable security definer set search_path = public as $$
  with biz as (
    select public.current_business_id() as id where public.current_business_id() in (select public.accessible_business_ids())
  ), mine as (
    select l.id from public.business_locations l join biz on l.business_id = biz.id where public.location_allowed(biz.id, l.id)
  ), lv as (
    select s.* from public.stock_levels s join biz on s.business_id = biz.id join public.catalog_items i on i.id = s.item_id and i.track_stock
  )
  select s.location_id, s.item_id, s.variant_id, s.qty from lv s where s.location_id in (select id from mine)
  union all
  select biz.id, i.id, null::uuid, (i.stock_qty - coalesce((select sum(s.qty) from lv s where s.item_id = i.id and s.variant_id is null), 0))::int
    from public.catalog_items i join biz on i.business_id = biz.id where i.track_stock and biz.id in (select id from mine)
  union all
  select biz.id, v.item_id, v.id, (v.stock_qty - coalesce((select sum(s.qty) from lv s where s.variant_id = v.id), 0))::int
    from public.catalog_variants v join public.catalog_items i on i.id = v.item_id and i.track_stock join biz on v.business_id = biz.id
   where biz.id in (select id from mine)
$$;
revoke execute on function public.stock_by_location_rows() from public, anon;
grant execute on function public.stock_by_location_rows() to authenticated;
create or replace view public.stock_by_location with (security_invoker = true) as
  select location_id, item_id, variant_id, qty from public.stock_by_location_rows();
revoke all on public.stock_by_location from anon;
grant select on public.stock_by_location to authenticated;

-- ---- 6. transfers between locations ----------------------------------------------------------------------------------------------
-- who may move and count stock: a member of the business worked in now, with full access, who may write (not a cashier, not a
-- viewer), in a business that is open
create or replace function public.stock_writer() returns uuid
language plpgsql stable security definer set search_path = public as $$
declare b uuid := public.current_business_id();
begin
  if auth.uid() is null or b is null or b not in (select public.accessible_business_ids()) or public.my_access() = 'register'
     or not public.can_write() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not public.business_is_active(b) then raise exception 'business_locked' using errcode = '42501'; end if;
  return b;
end $$;
revoke execute on function public.stock_writer() from public, anon, authenticated;

-- lines as the screens send them: [{itemId, variantId?, qty}] — a product and a whole number of units on every line, or nothing
create or replace function public.stock_lines_strict(p_lines jsonb, p_max int) returns boolean
language sql immutable set search_path = public as $$
  select jsonb_typeof(p_lines) = 'array' and jsonb_array_length(p_lines) between 1 and p_max
     and not exists (
       select 1 from jsonb_array_elements(p_lines) e
        where jsonb_typeof(e) <> 'object'
           or coalesce(e->>'itemId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           or (e->>'variantId' is not null and e->>'variantId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
           or coalesce(e->>'qty', '') !~ '^[1-9][0-9]{0,5}$')
$$;

-- send: the units leave the source at once (they are on the way until received). The id is chosen by the screen: the same id
-- again is the same transfer. The sender works at the source; units held for an order of the site do not leave the store's
-- shipping location (as the register). A product whose stock is not counted, or a product with variants without one, is refused.
create or replace function public.stock_transfer_send(p_id uuid, p_from uuid, p_to uuid, p_lines jsonb, p_note text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare b uuid := public.stock_writer(); t record; l record; i record; v record; num int; held int; label text; out jsonb := '[]';
        fname text; tname text;
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
    select c.id, c.name, c.track_stock, c.has_variants into i from public.catalog_items c where c.id = l.item_id and c.business_id = b;
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
      select coalesce(sum(r.qty), 0)::int into held from public.stock_reservations r
       where r.business_id = b and r.item_id = i.id and (l.variant_id is null or r.variant_id = l.variant_id)
         and (r.status = 'paid' or (r.status = 'held' and r.expires_at > now()));
      if held > 0 and l.qty > public.stock_at(p_from, i.id, l.variant_id) - held then
        raise exception 'reserved_for_online: %', i.name || case when label <> '' then ' — ' || label else '' end using errcode = 'P0001';
      end if;
    end if;
    out := out || jsonb_build_object('itemId', i.id, 'variantId', l.variant_id, 'name', i.name, 'variant', label, 'qty', l.qty);
  end loop;
  select coalesce(max(x.number), 0) + 1 into num from public.stock_transfers x where x.business_id = b;
  insert into public.stock_transfers (id, business_id, number, from_location, to_location, lines, note, sent_by)
  values (p_id, b, num, p_from, p_to, out, left(btrim(coalesce(p_note, '')), 300), auth.uid());
  for l in select * from public.stock_lines_v(out) loop
    perform public.stock_move_at(b, p_from, l.item_id, l.variant_id, -l.qty, 'transfer', format('העברה %s אל %s', num, tname),
                                 null, null, null, null, p_id, null);
  end loop;
  return jsonb_build_object('id', p_id, 'number', num, 'created', true);
end $$;

-- receive: every line comes in at the destination as it was sent; what arrived otherwise ([{itemId, variantId, received, reason}])
-- is a difference — an "adjust" move there, with its reason (a reason is required). Once: a second receive changes nothing.
create or replace function public.stock_transfer_receive(p_id uuid, p_lines jsonb default '[]', p_note text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare b uuid := public.stock_writer(); t record; e jsonb; got jsonb; rec int; gap int; why text; outl jsonb := '[]'; gaps int := 0;
        fname text; it uuid; va uuid;
begin
  select * into t from public.stock_transfers where id = p_id for update;
  if t.id is null or t.business_id <> b then raise exception 'not allowed' using errcode = '42501'; end if;
  if t.status = 'received' then return jsonb_build_object('result', 'already', 'number', t.number); end if;
  if t.status <> 'sent' then raise exception 'transfer_cancelled: this transfer was cancelled' using errcode = '23514'; end if;
  if not public.location_allowed(b, t.to_location) then raise exception 'not allowed: this location is not yours' using errcode = '42501'; end if;
  if p_lines is not null and jsonb_typeof(p_lines) <> 'array' then raise exception 'transfer_lines: a list of lines' using errcode = '22023'; end if;
  select name into fname from public.business_locations where id = t.from_location;
  perform 1 from public.catalog_items c where c.id in (select (x->>'itemId')::uuid from jsonb_array_elements(t.lines) x) order by c.id for update;
  for e in select x from jsonb_array_elements(t.lines) x order by x->>'itemId', coalesce(x->>'variantId', '') loop
    it := (e->>'itemId')::uuid; va := nullif(e->>'variantId', '')::uuid;
    got := null;
    select x into got from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) x
     where x->>'itemId' = e->>'itemId' and coalesce(x->>'variantId', '') = coalesce(e->>'variantId', '') limit 1;
    rec := (e->>'qty')::int; why := '';
    if got is not null and got->>'received' is not null then
      if (got->>'received') !~ '^[0-9]{1,6}$' then
        raise exception 'transfer_received: a whole number of units, zero or more' using errcode = '22023';
      end if;
      rec := (got->>'received')::int;
      why := left(btrim(coalesce(got->>'reason', '')), 200);
    end if;
    gap := rec - (e->>'qty')::int;
    if gap <> 0 and why = '' then raise exception 'transfer_gap_reason: %', e->>'name' using errcode = '22023'; end if;
    perform public.stock_move_at(b, t.to_location, it, va, (e->>'qty')::int, 'transfer', format('קבלת העברה %s מ%s', t.number, fname),
                                 null, null, null, null, t.id, null);
    if gap <> 0 then
      perform public.stock_move_at(b, t.to_location, it, va, gap, 'adjust', format('פער בהעברה %s: %s', t.number, why),
                                   null, null, null, null, t.id, null);
      gaps := gaps + 1;
    end if;
    outl := outl || (e || jsonb_build_object('received', rec, 'reason', why));
  end loop;
  update public.stock_transfers set status = 'received', lines = outl, received_by = auth.uid(), received_at = now(),
         received_note = left(btrim(coalesce(p_note, '')), 300)
   where id = t.id;
  return jsonb_build_object('result', 'ok', 'number', t.number, 'gaps', gaps);
end $$;

-- cancel a transfer that was not received: the units go back to the source. Whoever works at the source, or the owner; a reason.
create or replace function public.stock_transfer_cancel(p_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare b uuid := public.stock_writer(); t record; e jsonb;
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
  for e in select x from jsonb_array_elements(t.lines) x order by x->>'itemId', coalesce(x->>'variantId', '') loop
    perform public.stock_move_at(b, t.from_location, (e->>'itemId')::uuid, nullif(e->>'variantId', '')::uuid, (e->>'qty')::int, 'transfer',
                                 format('ביטול העברה %s', t.number), null, null, null, null, t.id, null);
  end loop;
  update public.stock_transfers set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(), cancel_reason = left(btrim(p_reason), 300)
   where id = t.id;
  return jsonb_build_object('result', 'ok', 'number', t.number);
end $$;
revoke execute on function public.stock_lines_strict(jsonb, int) from public, anon, authenticated;
revoke execute on function public.stock_transfer_send(uuid, uuid, uuid, jsonb, text), public.stock_transfer_receive(uuid, jsonb, text),
  public.stock_transfer_cancel(uuid, text) from public, anon;
grant execute on function public.stock_transfer_send(uuid, uuid, uuid, jsonb, text), public.stock_transfer_receive(uuid, jsonb, text),
  public.stock_transfer_cancel(uuid, text) to authenticated;

-- ---- 7. counts ---------------------------------------------------------------------------------------------------------------------
-- a new count of a location (one open count a location at a time); the id is chosen by the screen
create or replace function public.stock_count_start(p_id uuid, p_location uuid, p_note text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare b uuid := public.stock_writer(); c record; num int; loc uuid;
begin
  if p_id is null then raise exception 'count_id: a new count has an id' using errcode = '22023'; end if;
  perform 1 from public.businesses where id = b for no key update;    -- one new count at a time (as a transfer)
  select * into c from public.stock_counts where id = p_id;
  if c.id is not null then
    if c.business_id <> b then raise exception 'not allowed' using errcode = '42501'; end if;
    return jsonb_build_object('id', c.id, 'number', c.number, 'created', false);
  end if;
  loc := coalesce(p_location, b);
  if not exists (select 1 from public.business_locations l where l.id = loc and l.business_id = b) then
    raise exception 'stock_location: a location of the business' using errcode = '22023';
  end if;
  if not public.location_allowed(b, loc) then raise exception 'not allowed: this location is not yours' using errcode = '42501'; end if;
  select * into c from public.stock_counts where location_id = loc and status = 'open';
  if c.id is not null then raise exception 'count_open: count % of this location is open', c.number using errcode = '23505'; end if;
  select coalesce(max(x.number), 0) + 1 into num from public.stock_counts x where x.business_id = b;
  insert into public.stock_counts (id, business_id, number, location_id, note, created_by)
  values (p_id, b, num, loc, left(btrim(coalesce(p_note, '')), 300), auth.uid());
  return jsonb_build_object('id', p_id, 'number', num, 'created', true);
end $$;

-- one line of an open count: what was counted of an item (or of one of its variants) — as of now; null takes the line off
create or replace function public.stock_count_set(p_count uuid, p_item uuid, p_variant uuid, p_counted int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare b uuid := public.stock_writer(); c record; i record; k text;
begin
  select * into c from public.stock_counts where id = p_count for update;
  if c.id is null or c.business_id <> b then raise exception 'not allowed' using errcode = '42501'; end if;
  if c.status <> 'open' then raise exception 'count_closed: this count is %', c.status using errcode = '23514'; end if;
  if not public.location_allowed(b, c.location_id) then raise exception 'not allowed: this location is not yours' using errcode = '42501'; end if;
  select x.id, x.has_variants into i from public.catalog_items x where x.id = p_item and x.business_id = b;
  if i.id is null then raise exception 'count_item: a product of the business' using errcode = '22023'; end if;
  if p_variant is null and i.has_variants then raise exception 'variant_required: an item with variants is counted per variant' using errcode = '22023'; end if;
  if p_variant is not null and (not i.has_variants
     or not exists (select 1 from public.catalog_variants v where v.id = p_variant and v.item_id = p_item)) then
    raise exception 'variant_not_found: a variant of this item' using errcode = '22023';
  end if;
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

-- an open count's lines: what the system expected at the moment each line was counted (the location's count now, less what moved
-- there since), and the difference. A cashier, and anyone not at the location, gets nothing.
create or replace function public.stock_count_lines(p_count uuid)
returns table (item_id uuid, variant_id uuid, counted int, expected int, gap int, counted_at timestamptz)
language sql stable security definer set search_path = public as $$
  with c as (
    select x.* from public.stock_counts x
     where x.id = p_count and x.business_id = public.current_business_id() and x.business_id in (select public.accessible_business_ids())
       and public.my_access() <> 'register' and public.location_allowed(x.business_id, x.location_id)
  ), l as (
    select (e.value->>'itemId')::uuid as item_id, nullif(e.value->>'variantId', '')::uuid as variant_id, (e.value->>'counted')::int as counted,
           (e.value->>'at')::timestamptz as at, c.location_id, c.business_id, c.id as count_id
      from c, jsonb_each(c.lines) e
  )
  select l.item_id, l.variant_id, l.counted, x.expected, l.counted - x.expected, l.at
    from l cross join lateral (
      select (public.stock_at(l.location_id, l.item_id, l.variant_id)
              - coalesce((select sum(m.delta) from public.stock_movements m
                           where m.business_id = l.business_id and m.item_id = l.item_id
                             and coalesce(m.location_id, m.business_id) = l.location_id
                             and (l.variant_id is null or m.variant_id = l.variant_id)
                             and m.created_at > l.at and m.count_id is distinct from l.count_id), 0))::int as expected) x
$$;

-- the owner approves: each difference becomes a "count" move at the location — once (a second approval changes nothing)
create or replace function public.stock_count_approve(p_count uuid, p_note text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare b uuid := public.stock_writer(); c record; r record; res jsonb := '[]'; n int := 0;
begin
  if not public.location_owner() then raise exception 'not allowed: the owner approves a count' using errcode = '42501'; end if;
  select * into c from public.stock_counts where id = p_count for update;
  if c.id is null or c.business_id <> b then raise exception 'not allowed' using errcode = '42501'; end if;
  if c.status = 'approved' then return jsonb_build_object('result', 'already', 'number', c.number); end if;
  if c.status <> 'open' then raise exception 'count_closed: this count is %', c.status using errcode = '23514'; end if;
  if c.lines = '{}'::jsonb then raise exception 'count_empty: nothing was counted' using errcode = '23514'; end if;
  perform 1 from public.catalog_items x where x.id in (select (e.value->>'itemId')::uuid from jsonb_each(c.lines) e) order by x.id for update;
  update public.catalog_items set track_stock = true
   where id in (select (e.value->>'itemId')::uuid from jsonb_each(c.lines) e) and business_id = b and not track_stock;   -- counting = tracking
  for r in select * from public.stock_count_lines(c.id) order by 1, 2 loop
    if r.gap <> 0 then
      perform public.stock_move_at(b, c.location_id, r.item_id, r.variant_id, r.gap, 'count', format('ספירה %s', c.number),
                                   null, null, null, null, null, c.id);
      n := n + 1;
    end if;
    res := res || jsonb_build_object('itemId', r.item_id, 'variantId', r.variant_id, 'counted', r.counted, 'expected', r.expected, 'gap', r.gap);
  end loop;
  update public.stock_counts set status = 'approved', result = res, approved_by = auth.uid(), approved_at = now(),
         note = case when btrim(coalesce(p_note, '')) <> '' then left(btrim(p_note), 300) else note end
   where id = c.id;
  return jsonb_build_object('result', 'ok', 'number', c.number, 'moved', n);
end $$;

-- a count is dropped (nothing moves): by whoever opened it, or the owner
create or replace function public.stock_count_cancel(p_count uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare b uuid := public.stock_writer(); c record;
begin
  select * into c from public.stock_counts where id = p_count for update;
  if c.id is null or c.business_id <> b then raise exception 'not allowed' using errcode = '42501'; end if;
  if c.status = 'cancelled' then return jsonb_build_object('result', 'already', 'number', c.number); end if;
  if c.status <> 'open' then raise exception 'count_closed: this count is %', c.status using errcode = '23514'; end if;
  if not (c.created_by = auth.uid() or public.location_owner()) then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.stock_counts set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now() where id = c.id;
  return jsonb_build_object('result', 'ok', 'number', c.number);
end $$;
revoke execute on function public.stock_count_start(uuid, uuid, text), public.stock_count_set(uuid, uuid, uuid, int), public.stock_count_lines(uuid),
  public.stock_count_approve(uuid, text), public.stock_count_cancel(uuid) from public, anon;
grant execute on function public.stock_count_start(uuid, uuid, text), public.stock_count_set(uuid, uuid, uuid, int), public.stock_count_lines(uuid),
  public.stock_count_approve(uuid, text), public.stock_count_cancel(uuid) to authenticated;

-- ---- 8. the online store and the register ---------------------------------------------------------------------------------------------
-- a sale of the register at a location that would take units held for an order of the site: the first such product, else null.
-- Held units are at the store's shipping location — a sale elsewhere takes none of them. As stock_reserved_conflict (3500).
create or replace function public.stock_reserved_conflict_at(p_items jsonb, p_sale uuid, p_location uuid) returns text
language plpgsql security definer set search_path = public as $$
declare b uuid := public.current_business_id(); l record; i public.catalog_items; v public.catalog_variants; held int; have int;
        loc uuid;
begin
  if b is null or b not in (select public.accessible_business_ids()) then return null; end if;
  loc := coalesce(p_location, b);
  if loc <> public.stock_ship_location(b) then return null; end if;
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
    have := public.stock_at(loc, i.id, v.id);
    if l.qty > have - held then
      return i.name || case when v.id is not null then ' — ' || concat_ws(' / ', nullif(v.option1, ''), nullif(v.option2, ''), nullif(v.option3, '')) else '' end;
    end if;
  end loop;
  return null;
end $$;
revoke execute on function public.stock_reserved_conflict_at(jsonb, uuid, uuid) from public, anon;
grant execute on function public.stock_reserved_conflict_at(jsonb, uuid, uuid) to authenticated;

-- the one of 3500 (same signature): where the user works
create or replace function public.stock_reserved_conflict(p_items jsonb, p_sale uuid) returns text
language plpgsql security definer set search_path = public as $$
declare b uuid := public.current_business_id();
begin
  if b is null then return null; end if;
  return public.stock_reserved_conflict_at(p_items, p_sale, coalesce(public.location_pick(b), b));
end $$;

-- the register's guard (as 3500): the sale's own location — a_location_fill (4600) filled it before this runs
create or replace function public.sales_reserved_guard() returns trigger
language plpgsql set search_path = public as $$
declare bad text;
begin
  if new.status not in ('paid', 'pending') or current_user not in ('anon', 'authenticated') then return new; end if;
  if new.business_id is null or new.business_id is distinct from public.current_business_id() then return new; end if;
  bad := public.stock_reserved_conflict_at(new.items, new.id, coalesce(new.location_id, new.business_id));
  if bad is not null then
    raise exception 'שמור להזמנה באתר: %', bad using errcode = 'P0001', hint = 'reserved_for_online';
  end if;
  return new;
end $$;

-- the register shows "שמור להזמנה באתר" (as 3500), and now where the held units are: the store's shipping location
create or replace function public.reserved_stock() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('item_id', x.item_id, 'variant_id', x.variant_id, 'qty', x.qty,
                                               'location', public.stock_ship_location(public.current_business_id()))), '[]'::jsonb) from (
    select r.item_id, r.variant_id, sum(r.qty)::int as qty from public.stock_reservations r
     where r.business_id = public.current_business_id() and r.business_id in (select public.accessible_business_ids())
       and (r.status = 'paid' or (r.status = 'held' and r.expires_at > now()))
     group by r.item_id, r.variant_id) x
$$;

-- what the site sells — counted at the shipping location (each function as it was, only where it counts stock changes)
-- as 20261006003500_commerce_checkout: what is free is counted at the store's shipping location (sf_stock); nothing else changes
create or replace function public.sf_prices(i public.catalog_items) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare lo numeric; hi numeric; cmp numeric; avail boolean; n int; free int;
begin
  if i.has_variants then
    select min(x.p), max(x.p), bool_or(x.ok), sum(x.q) into lo, hi, avail, n from (
      select coalesce(v.online_price, i.online_price, v.price, i.price) as p,
             (not i.track_stock or public.sf_stock(i.id, v.id) - public.sf_reserved(i.id, v.id) > 0) as ok,
             greatest(public.sf_stock(i.id, v.id) - public.sf_reserved(i.id, v.id), 0) as q
        from public.catalog_variants v where v.item_id = i.id and v.active) x;
    select coalesce(v.compare_at_price, i.compare_at_price) into cmp from public.catalog_variants v
     where v.item_id = i.id and v.active
     order by coalesce(v.online_price, i.online_price, v.price, i.price), v.position, v.id limit 1;
  else
    lo := coalesce(i.online_price, i.price); hi := lo; cmp := i.compare_at_price;
    free := public.sf_stock(i.id, null) - case when i.track_stock then public.sf_reserved(i.id, null) else 0 end;
    avail := not i.track_stock or free > 0; n := greatest(free, 0);
  end if;
  return jsonb_build_object('price', trim_scale(lo), 'price_max', trim_scale(hi), 'compare_at', case when cmp > lo then trim_scale(cmp) end,
                            'in_stock', coalesce(avail, false), 'stock', case when i.track_stock then coalesce(n, 0) end);
end $$;

-- as 20261006003500_commerce_checkout: each variant's free units counted at the shipping location; nothing else changes
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
    'can_buy', public.sf_can_buy(s));
end $$;

-- as 20261005003400_commerce_store: the "in stock" filter of options counted at the shipping location; nothing else changes
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

-- as 20261006003500_commerce_checkout: a line's free units counted at the shipping location; nothing else changes
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
        free := public.sf_stock((l.itm).id, (l.var).id)
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

-- as 20261006003500_commerce_checkout: the units one may add counted at the shipping location; nothing else changes
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
    free := public.sf_stock(i.id, v.id) - public.sf_reserved(i.id, v.id);
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

-- as 20261006003600_commerce_finance: the stock check counted at the shipping location; nothing else changes
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
  if a.mode <> 'test' and not public.commerce_live() then return jsonb_build_object('ok', false, 'error', 'live_not_yet'); end if;
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
      free := public.sf_stock((l.itm).id, (l.var).id) - public.sf_reserved((l.itm).id, (l.var).id);
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
  values (s.business_id, s.id, num, p_order_token, c.id, a.mode = 'test', s.currency, sub, disc, ship, sub - disc + ship,
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

-- as 20261009004000_late_payment_stock: what a late order is short of, counted at the shipping location; nothing else changes
create or replace function public.sf_order_paid(p_store uuid, p_order uuid, p_provider text, p_txn text, p_amount numeric, p_currency text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o public.orders; was text; late boolean; short jsonb;
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
  was := o.payment_status;
  -- late: the order expired, or one of its holds was released — or ran out and the cron has not come yet
  late := was <> 'pending' or exists (select 1 from public.stock_reservations r where r.order_id = o.id
            and (r.status = 'released' or (r.status = 'held' and r.expires_at <= now())));
  if o.is_test then
    update public.orders set payment_status = 'test_paid', provider_txn = p_txn, paid_at = now(), updated_at = now() where id = o.id;
    update public.stock_reservations set status = 'released', updated_at = now() where order_id = o.id and status in ('held', 'paid');
  else
    if late then
      -- what is free for this order now: the stock, less what is held for other orders (paid, or held and still in time)
      select jsonb_agg(jsonb_build_object('name', x.name, 'variant', x.variant_label, 'qty', x.qty, 'available', greatest(x.free, 0))
                       order by x.name, x.variant_label)
        into short
        from (select l.name, l.variant_label, sum(l.qty)::int as qty,
                     public.sf_stock(i.id, v.id) - coalesce((select sum(r.qty) from public.stock_reservations r
                        where r.order_id <> o.id and r.item_id = l.item_id
                          and (l.variant_id is null or r.variant_id = l.variant_id)
                          and (r.status = 'paid' or (r.status = 'held' and r.expires_at > now()))), 0)::int as free
                from public.order_lines l
                join public.catalog_items i on i.id = l.item_id and i.track_stock
                left join public.catalog_variants v on v.id = l.variant_id
               where l.order_id = o.id
               group by l.item_id, l.variant_id, l.name, l.variant_label, i.id, v.id) x
       where x.qty > x.free;
    end if;
    update public.orders set payment_status = 'paid', provider_txn = p_txn, paid_at = now(), document_status = 'pending',
           stock_short = short, updated_at = now()
     where id = o.id;
    -- every hold of the order is the order's now (a hold that ran out too), until the sale takes the units
    update public.stock_reservations set status = 'paid', updated_at = now() where order_id = o.id and status in ('held', 'released');
    perform public.store_alert(o.id, 'new_order', '');
    if late then
      perform public.store_alert(o.id, 'late_payment', case when short is null
        then 'התשלום הגיע אחרי שהשמירה על המלאי פגה — המלאי הספיק לכל הפריטים.'
        else 'התשלום הגיע אחרי שהשמירה על המלאי פגה. חסר במלאי: ' || (
          select string_agg(e->>'name' || case when e->>'variant' <> '' then ' (' || (e->>'variant') || ')' else '' end
                            || ' — הוזמנו ' || (e->>'qty') || ', יש ' || (e->>'available'), '; ')
            from jsonb_array_elements(short) e) || '. להשלים מלאי או להחזיר כסף על החסר.'
        end);
    end if;
  end if;
  if o.coupon_code <> '' then
    update public.store_coupons set used_count = used_count + 1 where store_id = o.store_id and code = o.coupon_code;
  end if;
  if o.cart_id is not null then update public.store_cart_lines set qty = 0, updated_at = now() where cart_id = o.cart_id and qty > 0; end if;
  perform public.order_email(o.id, 'order_confirmation', '');
  perform public.order_event(o.id, case when o.is_test then 'test_paid' else 'paid' end,
                             jsonb_build_object('txn', p_txn, 'amount', p_amount, 'late', late, 'short', short is not null));
  return jsonb_build_object('result', 'ok', 'status', case when o.is_test then 'test_paid' else 'paid' end);
end $$;

-- ---- 9. who sees what ---------------------------------------------------------------------------------------------------------------
do $$
declare
  t text;
  gate constant text := 'business_id = (select public.current_business_id()) and business_id in (select public.accessible_business_ids())';
begin
  foreach t in array array['stock_levels', 'stock_transfers', 'stock_counts'] loop
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
  -- the counts of the locations: a member limited to some locations reads only theirs (the location picked does not hide the rest)
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'stock_levels' and policyname = 'stock_levels_member_limit') then
    create policy stock_levels_member_limit on public.stock_levels as restrictive for all to authenticated
      using ((select public.my_locations()) is null or location_id = any ((select public.my_locations())::uuid[]));
  end if;
  -- transfers and counts: not the cashier's; the locations seen now (the location picked, or the member's own)
  foreach t in array array['stock_transfers', 'stock_counts'] loop
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_cashier_none') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using ((select public.my_access()) <> ''register'') with check ((select public.my_access()) <> ''register'')',
        t || '_cashier_none', t);
    end if;
  end loop;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'stock_transfers' and policyname = 'stock_transfers_location_gate') then
    create policy stock_transfers_location_gate on public.stock_transfers as restrictive for all to authenticated
      using ((select public.location_filter()) is null or from_location = any ((select public.location_filter())::uuid[])
             or to_location = any ((select public.location_filter())::uuid[]));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'stock_counts' and policyname = 'stock_counts_location_gate') then
    create policy stock_counts_location_gate on public.stock_counts as restrictive for all to authenticated
      using ((select public.location_filter()) is null or location_id = any ((select public.location_filter())::uuid[]));
  end if;
  -- the movements: the locations seen now, as the nine tables of 4600 (a movement with no location is the main one's)
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'stock_movements' and policyname = 'stock_movements_location_gate') then
    create policy stock_movements_location_gate on public.stock_movements as restrictive for all to authenticated
      using ((select public.location_filter()) is null or coalesce(location_id, business_id) = any ((select public.location_filter())::uuid[]))
      with check ((select public.location_filter()) is null or coalesce(location_id, business_id) = any ((select public.location_filter())::uuid[]));
  end if;
end $$;

-- ============================================================================================================================
-- Rollback (by hand, if ever needed): drop the policies stock_movements_location_gate, the view stock_by_location and the new
-- functions (stock_at, stock_ship_location, sf_stock, stock_move_at, stock_move_ref_at, stock_adjust, stock_by_location_rows,
-- stock_writer, stock_lines_strict, stock_transfer_*, stock_count_*, stock_reserved_conflict_at); run again the definitions of
-- stock_move_v, stock_move_ref_v, sales_stock, sale_refunds_restock, documents_after_insert, document_cancellations_after,
-- expenses_after, receive_expense_stock, adjust_stock, adjust_variant_stock, reconcile_variant_stock (20261005003300),
-- stock_reserved_conflict, sales_reserved_guard, reserved_stock, sf_prices, sf_product, sf_cart_view, sf_cart_set (20261006003500),
-- sf_products (20261005003400), sf_checkout_start (20261006003600) and sf_order_paid (20261009004000). The totals are right as
-- they are (every move moved them); the counts of the locations other than the main one are lost — only with nothing in them
-- (no transfers or sales there), or after counting them back into the main location. Then: alter table stock_movements drop
-- column count_id, transfer_id, location_after, location_id; the reason check without 'transfer' (only with no such rows);
-- drop table stock_counts, stock_transfers, stock_levels.
-- ============================================================================================================================
