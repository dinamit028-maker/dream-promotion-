-- ============================================================================
-- Migration 20261001000600 — scheduled publishing
-- Purpose: a post planned for a time, with its destinations (Instagram reel/post/story,
--          Facebook Page, TikTok drafts). A server timer (/api/cron/publish-due, every 5 minutes
--          from pg_cron — see supabase/cron-publish.sql) publishes what is due and records the
--          result per destination.
-- status: scheduled → publishing → done | partial | failed   (or cancelled)
-- results: { "<accountId>": { state, containerId?, externalId?, error?, at } }
-- locked_until: a run claims a row for a few minutes, so two timer runs never publish twice.
-- Server-only (RLS on, no policies). Idempotent.
-- Rollback: drop table public.scheduled_posts.
-- ============================================================================
create table if not exists public.scheduled_posts (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users on delete cascade,
  content_id   uuid references public.content on delete cascade,
  media_id     uuid not null references public.media on delete cascade,
  caption      text not null default '',
  destinations jsonb not null default '[]'::jsonb,
  run_at       timestamptz not null,
  status       text not null default 'scheduled'
               check (status in ('scheduled','publishing','done','partial','failed','cancelled')),
  results      jsonb not null default '{}'::jsonb,
  attempts     int not null default 0,
  locked_until timestamptz,
  last_run_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists scheduled_due_idx on public.scheduled_posts (run_at) where status in ('scheduled','publishing');
create index if not exists scheduled_user_idx on public.scheduled_posts (user_id, run_at desc);
create index if not exists scheduled_content_idx on public.scheduled_posts (content_id) where content_id is not null;

drop trigger if exists touch_scheduled_posts on public.scheduled_posts;
create trigger touch_scheduled_posts before update on public.scheduled_posts
  for each row execute function public.touch_updated_at();

alter table public.scheduled_posts enable row level security;
