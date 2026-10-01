-- ============================================================================
-- Migration 20261001000200 — social accounts, publishing log, usage counter
-- Purpose: three tables the application already uses in production but that were never
--          in source control: social_accounts (Meta / TikTok connections and their tokens),
--          social_posts (TikTok upload log), usage (monthly quota counter).
-- Idempotent: "create table if not exists" — on the existing project the tables are kept
--          as they are; missing columns and indexes are added. No data is touched.
-- Security: RLS on, and NO policy for browsers — only the server (service role) reads or
--          writes these rows. Access tokens therefore never reach a browser.
-- Rollback: drop table public.social_posts, public.social_accounts, public.usage
--          (only on a project where they were created by this migration — destroys data).
-- ============================================================================

-- ------------------------------------------------------------ social_accounts --
create table if not exists public.social_accounts (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users on delete cascade,
  provider           text not null check (provider in ('facebook','instagram','tiktok')),
  external_id        text not null,
  display_name       text,
  avatar_url         text,
  access_token       text not null,          -- encrypted with TOKEN_ENCRYPTION_KEY (lib/server/secrets.ts)
  refresh_token      text,
  expires_at         timestamptz,
  refresh_expires_at timestamptz,
  scope              text,                   -- Meta: 'full' | 'read' · TikTok: granted scopes
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
alter table public.social_accounts add column if not exists display_name text;
alter table public.social_accounts add column if not exists avatar_url text;
alter table public.social_accounts add column if not exists refresh_token text;
alter table public.social_accounts add column if not exists expires_at timestamptz;
alter table public.social_accounts add column if not exists refresh_expires_at timestamptz;
alter table public.social_accounts add column if not exists scope text;
alter table public.social_accounts add column if not exists updated_at timestamptz not null default now();
-- the upsert key used by lib/server/meta.ts and lib/server/tiktok.ts
create unique index if not exists social_accounts_owner_key on public.social_accounts (user_id, provider, external_id);
create index if not exists social_accounts_provider_idx on public.social_accounts (provider);

-- --------------------------------------------------------------- social_posts --
create table if not exists public.social_posts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users on delete cascade,
  account_id  uuid references public.social_accounts on delete set null,
  provider    text not null,
  content_id  uuid references public.content on delete set null,
  media_id    uuid references public.media on delete set null,
  mode        text not null default 'draft',   -- TikTok: 'draft' = sent to the TikTok inbox, not published
  status      text not null default 'sending',
  external_id text,
  error       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists social_posts_user_idx on public.social_posts (user_id, created_at desc);

-- ---------------------------------------------------------------------- usage --
-- One row per paid generation. user_id is null for access-code callers (one shared bucket).
create table if not exists public.usage (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users on delete cascade,
  kind       text not null check (kind in ('video','image','voice')),
  units      numeric not null default 0,
  cost_usd   numeric not null default 0,
  meta       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists usage_user_kind_month_idx on public.usage (user_id, kind, created_at desc);

-- --------------------------------------------------------------------- triggers --
drop trigger if exists touch_social_accounts on public.social_accounts;
create trigger touch_social_accounts before update on public.social_accounts
  for each row execute function public.touch_updated_at();
drop trigger if exists touch_social_posts on public.social_posts;
create trigger touch_social_posts before update on public.social_posts
  for each row execute function public.touch_updated_at();

-- -------------------------------------------------------------------------- RLS --
-- server-only tables: RLS on and no policies = browsers get nothing, the service role everything
alter table public.social_accounts enable row level security;
alter table public.social_posts    enable row level security;
alter table public.usage           enable row level security;
