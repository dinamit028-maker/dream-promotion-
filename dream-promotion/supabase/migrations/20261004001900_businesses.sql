-- ============================================================================
-- Migration 20261004001900 — multi-business, stage 1: the "business" entity (additive only)
--   businesses        one row per business: status (manual lock), paid_until + grace_days (automatic lock)
--   business_members  who belongs to which business, with a role — ready for real users later
--   profiles.is_super_admin  the platform owner; can NEVER be set from the browser (trigger below)
--   meta_connections  one Meta (Facebook user) connection per app user — tokens are server-only
-- RLS is enabled on every new table with NO client policies yet: until stage 4 (access functions +
-- policies) only the service role and SQL can read or write them. Idempotent.
-- Rollback: drop table meta_connections, business_members, businesses; alter table profiles drop column is_super_admin.
-- ============================================================================
create table if not exists public.businesses (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) between 1 and 80),
  slug        text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  status      text not null default 'active' check (status in ('active', 'locked')),
  paid_until  date,                                   -- null = no time limit
  grace_days  int  not null default 0 check (grace_days between 0 and 60),
  lock_reason text not null default '',
  notes       text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create or replace trigger touch_businesses before update on public.businesses for each row execute function public.touch_updated_at();

create table if not exists public.business_members (
  business_id uuid not null references public.businesses on delete cascade,
  user_id     uuid not null references auth.users on delete cascade,
  role        text not null default 'owner' check (role in ('owner', 'editor', 'viewer')),
  created_at  timestamptz not null default now(),
  primary key (business_id, user_id)
);
create index if not exists business_members_user_idx on public.business_members (user_id);

-- ---- super admin -----------------------------------------------------------
alter table public.profiles add column if not exists is_super_admin boolean not null default false;

-- profiles_self lets a user write their own row, so a column grant is not enough: this trigger refuses
-- any change of is_super_admin made through the API (roles anon / authenticated). SQL and the service
-- role (server code) are not affected.
create or replace function public.profiles_guard_super_admin() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user in ('anon', 'authenticated') and (
       (tg_op = 'INSERT' and new.is_super_admin)
    or (tg_op = 'UPDATE' and new.is_super_admin is distinct from old.is_super_admin)) then
    raise exception 'is_super_admin can only be changed by the platform administrator' using errcode = '42501';
  end if;
  return new;
end $$;
revoke execute on function public.profiles_guard_super_admin() from public, anon, authenticated;
create or replace trigger guard_super_admin before insert or update on public.profiles for each row execute function public.profiles_guard_super_admin();

-- ---- one Meta connection per Facebook user -------------------------------------
create table if not exists public.meta_connections (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users on delete cascade,
  fb_user_id     text not null,
  fb_user_name   text not null default '',
  access_token   text not null,                      -- long-lived user token: server only
  scopes         text[] not null default '{}',
  expires_at     timestamptz,
  last_synced_at timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (user_id, fb_user_id)
);
create or replace trigger touch_meta_connections before update on public.meta_connections for each row execute function public.touch_updated_at();

-- ---- locked down until stage 4 -------------------------------------------------
alter table public.businesses       enable row level security;
alter table public.business_members enable row level security;
alter table public.meta_connections enable row level security;
-- the token table is never readable from the browser, not even after stage 4 (a token-free view will serve the client)
revoke all on public.meta_connections from anon, authenticated;
