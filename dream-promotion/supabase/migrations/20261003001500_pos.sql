-- ============================================================================
-- Migration 20261003001500 — POS redesign support (additive only; nothing removed)
--   catalog_items: + categories 'package' and 'other', favorites with an order, optional image
--   sales: + split payments ([{method, amount}], method = 'split'), + the employee who made the sale
--          (ready for commissions later — no commission logic here)
-- Idempotent. Rollback: drop the added columns and restore the two check constraints.
-- ============================================================================
alter table public.catalog_items drop constraint if exists catalog_items_kind_check;
alter table public.catalog_items add constraint catalog_items_kind_check check (kind in ('service','product','package','other'));
alter table public.catalog_items add column if not exists favorite  boolean not null default false;
alter table public.catalog_items add column if not exists fav_order int not null default 0;
alter table public.catalog_items add column if not exists image_url text not null default '' check (image_url = '' or image_url ~ '^https://');

alter table public.sales drop constraint if exists sales_method_check;
alter table public.sales add constraint sales_method_check check (method in ('cash','transfer','bit','card','link','other','split'));
alter table public.sales add column if not exists payments      jsonb not null default '[]';
alter table public.sales add column if not exists employee_id   uuid references public.employees on delete set null;
alter table public.sales add column if not exists employee_name text not null default '';
create index if not exists sales_user_employee_idx on public.sales (user_id, employee_id) where employee_id is not null;
