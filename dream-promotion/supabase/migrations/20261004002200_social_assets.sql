-- ============================================================================
-- Migration 20261004002200 — multi-business, stage 3: pages / Instagram / TikTok as business assets
--   social_accounts.connection_id  which Meta connection (Facebook user) the page token came from
--   social_accounts.status         'active' | 'missing' — a page that fell out of the latest approval is
--                                  marked, never deleted; it comes back to 'active' on reconnect
--   business_id may be null here only: a new page is "unassigned" until the super admin assigns it,
--   so the auto-fill trigger skips social_accounts (the server sets business_id explicitly)
--   unique (provider, external_id): every page / Instagram / TikTok belongs to ONE business
--   social_accounts_public: the columns the browser may ever read — no access_token / refresh_token
-- PRODUCTION NOTE (2026-10-04): the two statements marked [OWNER] contain drop/delete, which the
-- Supabase MCP holds for approval — the owner ran them in the SQL Editor; the rest ran via MCP.
-- Idempotent.
-- ============================================================================
alter table public.social_accounts add column if not exists connection_id uuid references public.meta_connections on delete set null;
alter table public.social_accounts add column if not exists status text not null default 'active';
alter table public.social_accounts add column if not exists missing_since timestamptz;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'social_accounts_status_check') then
    alter table public.social_accounts add constraint social_accounts_status_check check (status in ('active', 'missing'));
  end if;
end $$;
create index if not exists social_accounts_connection_idx on public.social_accounts (connection_id);

-- new rows of social_accounts keep business_id null (unassigned); every other table is still auto-filled
create or replace function public.fill_business_id() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'social_accounts' then return new; end if;
  if new.business_id is null and new.user_id is not null then new.business_id := public.business_for_user(new.user_id); end if;
  return new;
end $$;

-- [OWNER] an asset may be unassigned
alter table public.social_accounts alter column business_id drop not null;

-- [OWNER] one row per asset: keep the most recently updated copy (a backup exists in backup_20261004)
delete from public.social_accounts s using public.social_accounts t
  where s.provider = t.provider and s.external_id = t.external_id and s.id <> t.id
    and (s.updated_at, s.id) < (t.updated_at, t.id);
create unique index if not exists social_accounts_asset_uq on public.social_accounts (provider, external_id);

-- what the browser may ever read (tokens stay server-side; RLS of the table still applies — security_invoker)
create or replace view public.social_accounts_public with (security_invoker = true) as
  select id, business_id, user_id, provider, external_id, display_name, avatar_url, status, missing_since, scope, connection_id, created_at, updated_at
  from public.social_accounts;
revoke all on public.social_accounts from anon, authenticated;
-- column-level: the browser may select every column EXCEPT the tokens (the view needs this; RLS still filters rows)
grant select (id, business_id, user_id, provider, external_id, display_name, avatar_url, status, missing_since, scope, connection_id, created_at, updated_at)
  on public.social_accounts to authenticated;
revoke all on public.social_accounts_public from anon;
grant select on public.social_accounts_public to authenticated;
