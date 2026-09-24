-- ============================================================================
-- Dream Promotion — database schema
-- Run this once in Supabase → SQL Editor → New query → paste → Run.
-- Safe to run again: everything is "if not exists" or "drop policy if exists".
--
-- The rule behind every policy below: a row belongs to exactly one user, and
-- Postgres itself enforces it. Even with the public key in hand, nobody can
-- read another account's content.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- helpers --
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------- profile --
-- One row per signed-up user, created automatically on sign-up.
create table if not exists public.profiles (
  id          uuid primary key references auth.users on delete cascade,
  email       text,
  full_name   text,
  -- monthly allowances, so one heavy user cannot drain the shared API budget
  clip_quota      int  not null default 20,
  image_quota     int  not null default 200,
  clips_used      int  not null default 0,
  images_used     int  not null default 0,
  quota_reset_at  date not null default (date_trunc('month', now()) + interval '1 month')::date,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------------ brand --
create table if not exists public.brands (
  user_id     uuid primary key references auth.users on delete cascade,
  name        text default '',
  industry    text default '',
  description text default '',
  website     text default '',
  city        text default '',
  audience    text default '',
  goals       text[] default '{}',
  tone        text default '',
  cta         text default 'קבעו תור',
  colors      text[] default '{"#6B3BF5","#FF7FA8"}',
  analysis    jsonb,
  onboarded   boolean not null default false,
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------- content --
create table if not exists public.content (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users on delete cascade,
  kind        text not null check (kind in ('post','reel','story','ad')),
  platform    text not null default 'Instagram',
  goal        text default '',
  headline    text default '',
  caption     text default '',
  hashtags    text[] default '{}',
  cta         text default '',
  palette     text[] default '{"#6B3BF5","#A96BF8"}',
  visual_direction text,
  media_id    uuid,
  scenes      jsonb,
  status      text not null default 'draft' check (status in ('draft','scheduled','published')),
  date        date,
  time        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists content_user_date_idx on public.content (user_id, date);

-- ------------------------------------------------------------------ media --
-- Generated clips and images are copied into Supabase Storage, so a provider
-- link expiring can never take the user's work with it.
create table if not exists public.media (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users on delete cascade,
  url         text not null,
  storage_path text,
  name        text default '',
  kind        text not null default 'image' check (kind in ('image','video','audio')),
  tags        text[] default '{}',
  source      text default 'upload',
  created_at  timestamptz not null default now()
);
create index if not exists media_user_idx on public.media (user_id, created_at desc);

-- ------------------------------------------------------------------ leads --
create table if not exists public.leads (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users on delete cascade,
  name        text not null,
  phone       text default '',
  source      text default 'ידני',
  campaign_id uuid,
  status      text not null default 'חדש',
  notes       text default '',
  date        date not null default current_date,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists leads_user_idx on public.leads (user_id, created_at desc);

-- --------------------------------------------------------------- campaigns --
create table if not exists public.ad_drafts (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users on delete cascade,
  goal         text default '',
  audience     text default '',
  budget_per_day numeric default 0,
  days         int default 7,
  headline     text default '',
  primary_text text default '',
  description  text default '',
  cta          text default '',
  content_id   uuid,
  status       text not null default 'draft',
  created_at   timestamptz not null default now()
);

-- ----------------------------------------------------------- pronunciation --
-- How brand names should be SPOKEN. Captions keep the original spelling.
create table if not exists public.pronunciations (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null references auth.users on delete cascade,
  term      text not null,
  say       text not null,
  created_at timestamptz not null default now(),
  unique (user_id, term)
);

-- ----------------------------------------------------------- usage ledger --
-- Every paid generation is written here, so spend can be explained per user.
create table if not exists public.usage_events (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users on delete cascade,
  kind       text not null check (kind in ('clip','image','voice','text')),
  provider   text default '',
  units      numeric not null default 1,
  cost_usd   numeric not null default 0,
  meta       jsonb,
  created_at timestamptz not null default now()
);
create index if not exists usage_user_idx on public.usage_events (user_id, created_at desc);

-- ------------------------------------------------------ updated_at triggers --
do $$
declare t text;
begin
  foreach t in array array['profiles','brands','content','leads'] loop
    execute format('drop trigger if exists touch_%1$s on public.%1$s', t);
    execute format(
      'create trigger touch_%1$s before update on public.%1$s
       for each row execute function public.touch_updated_at()', t);
  end loop;
end $$;

-- ================================ ROW LEVEL SECURITY =======================
alter table public.profiles       enable row level security;
alter table public.brands         enable row level security;
alter table public.content        enable row level security;
alter table public.media          enable row level security;
alter table public.leads          enable row level security;
alter table public.ad_drafts      enable row level security;
alter table public.pronunciations enable row level security;
alter table public.usage_events   enable row level security;

-- profiles: a user reads and edits only their own row
drop policy if exists profiles_self on public.profiles;
create policy profiles_self on public.profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

-- everything else keys off user_id
do $$
declare t text;
begin
  foreach t in array array['brands','content','media','leads','ad_drafts','pronunciations','usage_events'] loop
    execute format('drop policy if exists %1$s_own on public.%1$s', t);
    execute format(
      'create policy %1$s_own on public.%1$s
       for all using (auth.uid() = user_id) with check (auth.uid() = user_id)', t);
  end loop;
end $$;

-- ==================================== STORAGE ==============================
-- Private bucket for generated clips, images and narration.
insert into storage.buckets (id, name, public)
values ('assets', 'assets', false)
on conflict (id) do nothing;

-- Files live under assets/<user-id>/..., and the first path segment is the gate.
drop policy if exists assets_read on storage.objects;
create policy assets_read on storage.objects for select
  using (bucket_id = 'assets' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists assets_write on storage.objects;
create policy assets_write on storage.objects for insert
  with check (bucket_id = 'assets' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists assets_update on storage.objects;
create policy assets_update on storage.objects for update
  using (bucket_id = 'assets' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists assets_delete on storage.objects;
create policy assets_delete on storage.objects for delete
  using (bucket_id = 'assets' and (storage.foldername(name))[1] = auth.uid()::text);
