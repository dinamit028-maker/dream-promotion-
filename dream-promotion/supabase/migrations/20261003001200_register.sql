-- ============================================================================
-- Migration 20261003001200 — digital register (toolbox stage 3, part 1)
--   register_settings  per business: exempt / licensed dealer, VAT rate, a payment link to send
--   catalog_items      the price list (services and products; shared later with the store)
--   sales              each sale: customer, lines, discount, total, VAT, method, paid / pending
-- These are SALE RECORDS, not tax documents. Receipts / invoices come from a licensed invoicing
-- service (a later part). Amounts are numeric(12,2) and are computed by tested code. RLS: own rows.
-- Idempotent. Rollback: drop table sales, catalog_items, register_settings.
-- ============================================================================
create table if not exists public.register_settings (
  user_id       uuid primary key references auth.users on delete cascade,
  business_type text not null default 'licensed' check (business_type in ('exempt','licensed')),
  vat_rate      numeric(5,2) not null default 18 check (vat_rate between 0 and 30),
  pay_link      text not null default '' check (pay_link = '' or pay_link ~ '^https://'),
  updated_at    timestamptz not null default now()
);

create table if not exists public.catalog_items (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users on delete cascade,
  name       text not null check (length(name) between 1 and 80),
  price      numeric(10,2) not null check (price >= 0),
  kind       text not null default 'service' check (kind in ('service','product')),
  active     boolean not null default true,
  sort       int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists catalog_items_user_idx on public.catalog_items (user_id, sort);

create table if not exists public.sales (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users on delete cascade,
  lead_id        uuid references public.leads on delete set null,
  appointment_id uuid references public.appointments on delete set null,
  customer_name  text not null default '',
  customer_phone text not null default '',
  items          jsonb not null default '[]',      -- [{name, price, qty}]
  subtotal       numeric(12,2) not null check (subtotal >= 0),
  discount       numeric(12,2) not null default 0 check (discount >= 0),
  total          numeric(12,2) not null check (total >= 0),
  vat_rate       numeric(5,2) not null default 0,
  vat_amount     numeric(12,2) not null default 0,
  method         text not null check (method in ('cash','transfer','bit','card','link','other')),
  status         text not null default 'paid' check (status in ('paid','pending','cancelled')),
  note           text not null default '',
  paid_at        timestamptz,
  created_at     timestamptz not null default now(),
  check (total <= subtotal and discount <= subtotal)
);
create index if not exists sales_user_created_idx on public.sales (user_id, created_at desc);
create index if not exists sales_user_pending_idx on public.sales (user_id) where status = 'pending';

alter table public.register_settings enable row level security;
alter table public.catalog_items     enable row level security;
alter table public.sales             enable row level security;
drop policy if exists register_settings_own on public.register_settings;
create policy register_settings_own on public.register_settings for all using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists catalog_items_own on public.catalog_items;
create policy catalog_items_own on public.catalog_items for all using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists sales_own on public.sales;
create policy sales_own on public.sales for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop trigger if exists touch_register_settings on public.register_settings;
create trigger touch_register_settings before update on public.register_settings
  for each row execute function public.touch_updated_at();
