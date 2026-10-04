-- ============================================================================
-- Migration 20261004003000 — register 2.50 (additive only: nothing is dropped, no column removed)
--   1. refunds        sale_refunds: money paid back on a sale — whole, items or a sum, never beyond what
--                     was paid (checked inside a row lock), recorded once and never edited;
--                     documents.refund_id ties a credit invoice (330) to its refund at issue time
--   2. stock          catalog_items.track_stock / stock_qty / low_stock; stock_movements logs every move;
--                     a sale takes units out, a cancel or a refund "back to stock" puts them back (triggers);
--                     counts and deliveries go through adjust_stock() — never a bare update of stock_qty
--   3. commissions    employees.commission_service_pct / commission_product_pct
--   4. business bills sales.billing_name / customer_dealer / customer_street / customer_city (the document's
--                     "לכבוד"), leads.billing_* (filled in again next time)
--   5. cashier        business_members.access: 'full' | 'register'. A register-only member ("קופאי/ת") sells:
--                     reads the price list, settings and contacts, records sales and their documents — and sees
--                     only the sales and documents they made today. No reports, refunds, stock, shifts,
--                     employees, marketing or deletions. Enforced here by RESTRICTIVE policies, not only on screen.
--                     pos_employees(): the sellers' names for the register (the employees table holds clock links).
-- Idempotent. Rollback: drop the new tables / functions / policies (*_cashier_*), the added columns can stay.
-- ============================================================================

-- ---- helpers ------------------------------------------------------------------------
-- midnight in Israel today, as a timestamp ("today's sales")
create or replace function public.il_day_start() returns timestamptz
language sql stable set search_path = public as $$
  select date_trunc('day', now() at time zone 'Asia/Jerusalem') at time zone 'Asia/Jerusalem';
$$;

-- ---- 5a. access level of a member ----------------------------------------------------------
alter table public.business_members add column if not exists access text not null default 'full';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'business_members_access_check') then
    alter table public.business_members add constraint business_members_access_check check (access in ('full', 'register'));
  end if;
end $$;

-- the caller's access in the business they work in now; the super admin always has full access
create or replace function public.my_access() returns text
language sql stable security definer set search_path = public as $$
  select case when public.is_super_admin() then 'full'
    else coalesce((select m.access from public.business_members m
                    where m.user_id = auth.uid() and m.business_id = public.current_business_id()), 'full') end;
$$;
revoke execute on function public.my_access() from public, anon;
grant execute on function public.my_access() to authenticated, service_role;

-- ---- 4. invoice to a business ------------------------------------------------------------
alter table public.sales add column if not exists billing_name    text not null default '';
alter table public.sales add column if not exists customer_dealer text not null default '';
alter table public.sales add column if not exists customer_street text not null default '';
alter table public.sales add column if not exists customer_city   text not null default '';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'sales_customer_dealer_check') then
    alter table public.sales add constraint sales_customer_dealer_check check (customer_dealer = '' or customer_dealer ~ '^[0-9]{9}$');
  end if;
end $$;
alter table public.leads add column if not exists billing_name   text not null default '';
alter table public.leads add column if not exists billing_dealer text not null default '';
alter table public.leads add column if not exists billing_street text not null default '';
alter table public.leads add column if not exists billing_city   text not null default '';

-- ---- 3. commissions ----------------------------------------------------------------------
alter table public.employees add column if not exists commission_service_pct numeric(5,2) not null default 0;
alter table public.employees add column if not exists commission_product_pct numeric(5,2) not null default 0;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'employees_commission_pct_check') then
    alter table public.employees add constraint employees_commission_pct_check
      check (commission_service_pct between 0 and 100 and commission_product_pct between 0 and 100);
  end if;
end $$;

-- the sellers for the register screen: names only (the table also holds each employee's clock link)
create or replace function public.pos_employees() returns table (id uuid, name text)
language sql stable security definer set search_path = public as $$
  select e.id, e.name from public.employees e
   where e.active and e.business_id = public.current_business_id()
     and public.current_business_id() in (select public.accessible_business_ids())
   order by e.created_at;
$$;
revoke execute on function public.pos_employees() from public, anon;
grant execute on function public.pos_employees() to authenticated;

-- ---- 1. refunds ----------------------------------------------------------------------------
create table if not exists public.sale_refunds (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users on delete cascade,      -- who made the refund
  business_id   uuid references public.businesses on delete restrict,
  sale_id       uuid not null references public.sales on delete restrict,
  amount        numeric(12,2) not null check (amount > 0),                  -- VAT-inclusive, as paid
  vat_amount    numeric(12,2) not null default 0 check (vat_amount >= 0 and vat_amount <= amount),
  method        text not null check (method in ('cash', 'card', 'transfer', 'bit', 'other')),
  items         jsonb not null default '[]',                                -- what came back [{name, price, qty, itemId?, kind?}]
  restock       boolean not null default false,
  reason        text not null default '' check (length(reason) <= 200),
  employee_name text not null default '',
  created_at    timestamptz not null default now()
);
create index if not exists sale_refunds_business_created_idx on public.sale_refunds (business_id, created_at desc);
create index if not exists sale_refunds_sale_idx on public.sale_refunds (sale_id);
create or replace trigger a_fill_business_id before insert on public.sale_refunds for each row execute function public.fill_business_id();

-- a refund is checked against its sale inside a lock: same business, a paid sale, never beyond what was paid
create or replace function public.sale_refunds_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare s record; done numeric;
begin
  select id, business_id, status, total into s from public.sales where id = new.sale_id for update;
  if s.id is null then raise exception 'sale not found' using errcode = '23503'; end if;
  if new.business_id is distinct from s.business_id then raise exception 'a refund belongs to the business of its sale' using errcode = '42501'; end if;
  if s.status <> 'paid' then raise exception 'only a paid sale can be refunded' using errcode = '23514'; end if;
  select coalesce(sum(r.amount), 0) into done from public.sale_refunds r where r.sale_id = new.sale_id;
  if done + new.amount > s.total then
    raise exception 'refund_exceeds_paid: % left', s.total - done using errcode = '23514';
  end if;
  new.created_at := now();   -- the refund's day is the server's, like a document's issue time
  return new;
end $$;
revoke execute on function public.sale_refunds_check() from public, anon, authenticated;
create or replace trigger b_sale_refunds_check before insert on public.sale_refunds for each row execute function public.sale_refunds_check();

-- a refunded sale is never "cancelled" afterwards (its money and stock already moved through the refund)
create or replace function public.sales_guard_cancel() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'cancelled' and old.status <> 'cancelled' and exists (select 1 from public.sale_refunds r where r.sale_id = old.id) then
    raise exception 'a refunded sale can not be cancelled' using errcode = '23514';
  end if;
  return new;
end $$;
revoke execute on function public.sales_guard_cancel() from public, anon, authenticated;
create or replace trigger sales_guard_cancel before update of status on public.sales for each row execute function public.sales_guard_cancel();

-- a credit invoice names its refund when it is issued (documents stay immutable after that)
alter table public.documents add column if not exists refund_id uuid references public.sale_refunds on delete restrict;
create index if not exists documents_refund_idx on public.documents (refund_id) where refund_id is not null;

-- ---- 2. stock ------------------------------------------------------------------------------
alter table public.catalog_items add column if not exists track_stock boolean not null default false;
alter table public.catalog_items add column if not exists stock_qty   int not null default 0;
alter table public.catalog_items add column if not exists low_stock   int not null default 2;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'catalog_items_low_stock_check') then
    alter table public.catalog_items add constraint catalog_items_low_stock_check check (low_stock >= 0);
  end if;
end $$;

create table if not exists public.stock_movements (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users on delete set null,               -- who (null = automatic / server)
  business_id uuid not null references public.businesses on delete restrict,
  item_id     uuid not null references public.catalog_items on delete cascade,
  delta       int  not null check (delta <> 0),
  qty_after   int  not null,
  reason      text not null check (reason in ('sale', 'cancel', 'refund', 'receive', 'count', 'adjust')),
  sale_id     uuid references public.sales on delete set null,
  refund_id   uuid references public.sale_refunds on delete set null,
  note        text not null default '' check (length(note) <= 200),
  created_at  timestamptz not null default now()
);
create index if not exists stock_movements_item_idx on public.stock_movements (business_id, item_id, created_at desc);

-- the one place stock moves: tracked items of that business only, logged with the quantity after
create or replace function public.stock_move(p_business uuid, p_item uuid, p_delta int, p_reason text, p_sale uuid, p_refund uuid, p_note text default '')
returns void language plpgsql security definer set search_path = public as $$
declare q int;
begin
  if coalesce(p_delta, 0) = 0 then return; end if;
  update public.catalog_items set stock_qty = stock_qty + p_delta
   where id = p_item and business_id = p_business and track_stock
   returning stock_qty into q;
  if not found then return; end if;            -- not tracked, another business's item, or deleted
  insert into public.stock_movements (user_id, business_id, item_id, delta, qty_after, reason, sale_id, refund_id, note)
  values (auth.uid(), p_business, p_item, p_delta, q, p_reason, p_sale, p_refund, left(coalesce(p_note, ''), 200));
end $$;
revoke execute on function public.stock_move(uuid, uuid, int, text, uuid, uuid, text) from public, anon, authenticated;

-- units per price-list item in a sale's / refund's lines (junk is ignored, never fails the sale)
create or replace function public.stock_lines(p_items jsonb) returns table (item_id uuid, qty int)
language sql immutable set search_path = public as $$
  select (e->>'itemId')::uuid, sum(floor((e->>'qty')::numeric))::int
    from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) e
   where coalesce(e->>'itemId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     and coalesce(e->>'qty', '') ~ '^[0-9]+(\.[0-9]+)?$'
   group by 1
  having sum(floor((e->>'qty')::numeric)) > 0;
$$;

-- a sale (paid or awaiting payment) takes its units out; cancelling it puts them back
create or replace function public.sales_stock() returns trigger
language plpgsql security definer set search_path = public as $$
declare l record;
begin
  if tg_op = 'INSERT' and new.status in ('paid', 'pending') then
    for l in select * from public.stock_lines(new.items) loop
      perform public.stock_move(new.business_id, l.item_id, -l.qty, 'sale', new.id, null);
    end loop;
  elsif tg_op = 'UPDATE' and new.status = 'cancelled' and old.status in ('paid', 'pending') then
    for l in select * from public.stock_lines(old.items) loop
      perform public.stock_move(new.business_id, l.item_id, l.qty, 'cancel', new.id, null);
    end loop;
  end if;
  return null;
end $$;
revoke execute on function public.sales_stock() from public, anon, authenticated;
create or replace trigger sales_stock after insert or update of status on public.sales for each row execute function public.sales_stock();

-- a refund marked "back to stock" puts the returned units back
create or replace function public.sale_refunds_restock() returns trigger
language plpgsql security definer set search_path = public as $$
declare l record;
begin
  if new.restock then
    for l in select * from public.stock_lines(new.items) loop
      perform public.stock_move(new.business_id, l.item_id, l.qty, 'refund', new.sale_id, new.id);
    end loop;
  end if;
  return null;
end $$;
revoke execute on function public.sale_refunds_restock() from public, anon, authenticated;
create or replace trigger sale_refunds_restock after insert on public.sale_refunds for each row execute function public.sale_refunds_restock();

-- the quantity changes only through stock_move (sales, refunds, adjust_stock) — so every unit is in the log
create or replace function public.catalog_items_guard_stock() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user in ('anon', 'authenticated') and new.stock_qty is distinct from old.stock_qty then
    raise exception 'stock changes only through a delivery or a count (adjust_stock)' using errcode = '42501';
  end if;
  return new;
end $$;
revoke execute on function public.catalog_items_guard_stock() from public, anon, authenticated;
create or replace trigger catalog_items_guard_stock before update on public.catalog_items for each row execute function public.catalog_items_guard_stock();

-- "+ קבלת סחורה" (add) or "ספירת מלאי" (set the counted number) — owners only, their current business only
create or replace function public.adjust_stock(p_item uuid, p_mode text, p_qty int, p_note text default '')
returns int language plpgsql security definer set search_path = public as $$
declare b uuid; cur int; d int;
begin
  select business_id, stock_qty into b, cur from public.catalog_items where id = p_item for update;
  if b is null or b is distinct from public.current_business_id() or not public.can_access_business(b) or public.my_access() = 'register' then
    raise exception 'not allowed' using errcode = '42501';
  end if;
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

-- ---- row-level security of the new tables (same shape as every business table) ---------------
alter table public.sale_refunds    enable row level security;
alter table public.stock_movements enable row level security;
revoke all on public.sale_refunds, public.stock_movements from anon;
revoke update, delete, truncate on public.sale_refunds, public.stock_movements from authenticated;
revoke insert on public.stock_movements from authenticated;   -- written by the triggers / adjust_stock only
grant select, insert on public.sale_refunds to authenticated;
grant select on public.stock_movements to authenticated;
do $$
declare
  t text;
  rule constant text := 'business_id = (select public.current_business_id()) and business_id in (select public.accessible_business_ids())';
begin
  foreach t in array array['sale_refunds', 'stock_movements'] loop
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_business_gate') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)', t || '_business_gate', t, rule, rule);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_business_read') then
      execute format('create policy %I on public.%I for select to authenticated using (%s)', t || '_business_read', t, rule);
    end if;
  end loop;
  -- a refund is recorded by the signed-in user, in their business (no update / delete policy: refunds are final)
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sale_refunds' and policyname = 'sale_refunds_business_insert') then
    execute format('create policy sale_refunds_business_insert on public.sale_refunds for insert to authenticated with check (%s and user_id = auth.uid())', rule);
  end if;
end $$;

-- ---- 5b. the cashier ("קופאי/ת"): restrictive policies — they narrow whatever the other policies allow -------
do $$
declare
  t text; op text;
  full_access constant text := '(select public.my_access()) <> ''register''';
  mine_today  constant text := '(user_id = auth.uid() and %I >= public.il_day_start())';
begin
  -- nothing at all: reports, refunds, stock log, shifts, employees and their clock, marketing, notifications
  foreach t in array array['sale_refunds', 'stock_movements', 'register_shifts', 'employees', 'time_entries', 'timeclock_settings',
      'content', 'media', 'scheduled_posts', 'ad_drafts', 'social_accounts', 'social_posts', 'social_messages', 'meta_lead_sync',
      'meta_inbox_sync', 'usage', 'document_counters', 'push_subscriptions'] loop
    if to_regclass('public.' || t) is not null
       and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_cashier_none') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)', t || '_cashier_none', t, full_access, full_access);
    end if;
  end loop;

  -- read only: the price list, the business's settings and brand, services and appointments
  foreach t in array array['catalog_items', 'register_settings', 'brands', 'booking_services', 'booking_settings', 'appointments'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    foreach op in array array['insert', 'update', 'delete'] loop
      if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_cashier_' || op) then
        execute format('create policy %I on public.%I as restrictive for %s to authenticated %s', t || '_cashier_' || op, t, op,
          case op when 'insert' then format('with check (%s)', full_access)
                  when 'update' then format('using (%s) with check (%s)', full_access, full_access)
                  else format('using (%s)', full_access) end);
      end if;
    end loop;
  end loop;

  -- contacts: a cashier picks and adds customers, never deletes one or its history
  foreach t in array array['leads', 'lead_activities'] loop
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_cashier_delete') then
      execute format('create policy %I on public.%I as restrictive for delete to authenticated using (%s)', t || '_cashier_delete', t, full_access);
    end if;
  end loop;

  -- sales: a cashier records sales and sees only their own sales of today; no changes, no deletions
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sales' and policyname = 'sales_cashier_read') then
    execute format('create policy sales_cashier_read on public.sales as restrictive for select to authenticated using (%s or %s)',
      full_access, format(mine_today, 'created_at'));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sales' and policyname = 'sales_cashier_insert') then
    execute format('create policy sales_cashier_insert on public.sales as restrictive for insert to authenticated with check (%s or user_id = auth.uid())', full_access);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sales' and policyname = 'sales_cashier_update') then
    execute format('create policy sales_cashier_update on public.sales as restrictive for update to authenticated using (%s) with check (%s)', full_access, full_access);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sales' and policyname = 'sales_cashier_delete') then
    execute format('create policy sales_cashier_delete on public.sales as restrictive for delete to authenticated using (%s)', full_access);
  end if;

  -- documents: the sale's own document (320 / 400) — never a credit invoice; reads and prints only today's own
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'documents' and policyname = 'documents_cashier_read') then
    execute format('create policy documents_cashier_read on public.documents as restrictive for select to authenticated using (%s or %s)',
      full_access, format(mine_today, 'issued_at'));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'documents' and policyname = 'documents_cashier_insert') then
    execute format('create policy documents_cashier_insert on public.documents as restrictive for insert to authenticated with check (%s or (user_id = auth.uid() and doc_type in (320, 400)))', full_access);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'documents' and policyname = 'documents_cashier_print') then
    execute format('create policy documents_cashier_print on public.documents as restrictive for update to authenticated using (%s or %s) with check (%s or %s)',
      full_access, format(mine_today, 'issued_at'), full_access, format(mine_today, 'issued_at'));
  end if;
end $$;
