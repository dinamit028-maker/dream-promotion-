-- ============================================================================
-- Migration 20261003001600 — register extras (additive only)
--   sales.cash_received / change_given — the cash the customer handed over and the change returned
--   documents.share_token — a private link for sending the document to the customer (WhatsApp).
--     Set once at issue time (column default) — the "issued documents never change" lock stays intact.
--   push_subscriptions — devices of the business owner that get a notification on every sale
-- Idempotent. Rollback: drop table push_subscriptions; drop the added columns.
-- ============================================================================
alter table public.sales add column if not exists cash_received numeric(12,2);
alter table public.sales add column if not exists change_given  numeric(12,2);

alter table public.documents add column if not exists share_token text not null
  default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''));
create unique index if not exists documents_share_token_idx on public.documents (share_token);

create table if not exists public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users on delete cascade,
  endpoint   text not null unique check (endpoint ~ '^https://'),
  keys       jsonb not null,
  label      text not null default '',
  created_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
drop policy if exists push_subscriptions_own on public.push_subscriptions;
create policy push_subscriptions_own on public.push_subscriptions for all using (user_id = auth.uid()) with check (user_id = auth.uid());
