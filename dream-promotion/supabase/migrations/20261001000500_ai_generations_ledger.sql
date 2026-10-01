-- ============================================================================
-- Migration 20261001000500 — AI generation ledger, cost per reel, provider health
-- Purpose: one row per call to an AI provider (text, image, video, voice, transcription)
--          and per final render — who, which provider and model, quality mode, units,
--          estimated and actual cost, status, retries and fallbacks, timing.
--          Costs are computed on the server only (never taken from the browser).
--          Views:
--            reel_costs       — cost per reel project (content id), by generation type
--            provider_health  — success rate and speed per provider/model, last 7 days
-- Internal: RLS on with no policies (server-only). Customers never see supplier costs.
-- Idempotent. Rollback: drop view reel_costs, provider_health; drop table ai_generations.
-- ============================================================================

create table if not exists public.ai_generations (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid references auth.users on delete set null,
  content_id             uuid references public.content on delete set null,  -- the reel / post it was made for
  generation_type        text not null check (generation_type in ('text','image','video','voice','transcribe','render')),
  provider               text not null,
  model                  text not null default '',
  quality_mode           text,                        -- draft | standard | premium (video), economy | standard | premium (image)
  status                 text not null default 'running'
                         check (status in ('running','succeeded','failed','cancelled')),
  duration_seconds       numeric,                     -- video length / audio length / render time
  resolution             text,
  input_units            numeric,                     -- tokens in, characters, images requested…
  output_units           numeric,                     -- tokens out, images returned, seconds billed…
  estimated_cost_usd     numeric,                     -- from the price table when the job started
  actual_cost_usd        numeric,                     -- when the provider reports billable usage
  retry_count            int not null default 0,
  fallback_from          text,                        -- the provider that failed before this one
  error                  text,
  provider_generation_id text,                        -- the provider's job / request id
  latency_ms             int,
  meta                   jsonb not null default '{}'::jsonb,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index if not exists ai_gen_user_idx     on public.ai_generations (user_id, created_at desc);
create index if not exists ai_gen_content_idx  on public.ai_generations (content_id) where content_id is not null;
create index if not exists ai_gen_job_idx      on public.ai_generations (provider, provider_generation_id) where provider_generation_id is not null;
create index if not exists ai_gen_created_idx  on public.ai_generations (created_at desc);

drop trigger if exists touch_ai_generations on public.ai_generations;
create trigger touch_ai_generations before update on public.ai_generations
  for each row execute function public.touch_updated_at();

alter table public.ai_generations enable row level security;

-- the cost that counts: actual when known, otherwise the estimate
create or replace view public.reel_costs with (security_invoker = true) as
select
  g.content_id,
  max(g.user_id::text)::uuid                                                                      as user_id,
  coalesce(sum(coalesce(g.actual_cost_usd, g.estimated_cost_usd)) filter (where g.generation_type = 'video'), 0)      as video_usd,
  coalesce(sum(coalesce(g.actual_cost_usd, g.estimated_cost_usd)) filter (where g.generation_type = 'image'), 0)      as image_usd,
  coalesce(sum(coalesce(g.actual_cost_usd, g.estimated_cost_usd)) filter (where g.generation_type = 'voice'), 0)      as voice_usd,
  coalesce(sum(coalesce(g.actual_cost_usd, g.estimated_cost_usd)) filter (where g.generation_type = 'text'), 0)       as text_usd,
  coalesce(sum(coalesce(g.actual_cost_usd, g.estimated_cost_usd)) filter (where g.generation_type = 'transcribe'), 0) as transcribe_usd,
  coalesce(sum(coalesce(g.actual_cost_usd, g.estimated_cost_usd)) filter (where g.generation_type = 'render'), 0)     as render_usd,
  coalesce(sum(coalesce(g.actual_cost_usd, g.estimated_cost_usd)) filter (where g.retry_count > 0 or g.fallback_from is not null), 0) as retry_usd,
  coalesce(sum(coalesce(g.actual_cost_usd, g.estimated_cost_usd)) filter (where g.status = 'failed'), 0)               as failed_usd,
  coalesce(sum(coalesce(g.actual_cost_usd, g.estimated_cost_usd)) filter (where g.status <> 'cancelled'), 0)           as total_usd,
  count(*)                                                                                        as generations,
  min(g.created_at) as first_at, max(g.created_at) as last_at
from public.ai_generations g
where g.content_id is not null
group by g.content_id;

create or replace view public.provider_health with (security_invoker = true) as
select
  provider, model, generation_type,
  count(*)                                                    as calls,
  count(*) filter (where status = 'succeeded')                as succeeded,
  count(*) filter (where status = 'failed')                   as failed,
  round(100.0 * count(*) filter (where status = 'succeeded')
        / nullif(count(*) filter (where status in ('succeeded','failed')), 0), 1) as success_rate_pct,
  round(avg(latency_ms) filter (where status = 'succeeded'))  as avg_latency_ms,
  (array_agg(error order by created_at desc) filter (where error is not null))[1] as last_error,
  max(created_at)                                             as last_call_at
from public.ai_generations
where created_at > now() - interval '7 days'
group by provider, model, generation_type;

revoke all on public.reel_costs, public.provider_health from anon, authenticated;
