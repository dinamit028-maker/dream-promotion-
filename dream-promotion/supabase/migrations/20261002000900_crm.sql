-- ============================================================================
-- Migration 20261002000900 — CRM (toolbox stage 1)
-- Purpose: the leads table becomes the business's contact book — leads AND customers — and every
--          contact gets a timeline of what happened (notes, calls, WhatsApp, meetings, stage changes,
--          purchases). The table keeps its name so nothing existing breaks.
--   leads: + email, tags, value (what the customer brought in), last_contact_at, next_followup_at
--   lead_activities: one row per event on a contact
-- Each user sees only their own rows (RLS), like every other table. Idempotent.
-- Rollback: drop table public.lead_activities; the new leads columns can stay (all have defaults).
-- ============================================================================
alter table public.leads add column if not exists email            text not null default '';
alter table public.leads add column if not exists tags             text[] not null default '{}';
alter table public.leads add column if not exists value            numeric(12,2) not null default 0;
alter table public.leads add column if not exists last_contact_at  timestamptz;
alter table public.leads add column if not exists next_followup_at timestamptz;
create index if not exists leads_followup_idx on public.leads (user_id, next_followup_at) where next_followup_at is not null;

create table if not exists public.lead_activities (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users on delete cascade,
  lead_id    uuid not null references public.leads on delete cascade,
  kind       text not null check (kind in ('note','call','whatsapp','email','meeting','status','purchase')),
  body       text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists lead_activities_lead_idx on public.lead_activities (lead_id, created_at desc);
create index if not exists lead_activities_user_idx on public.lead_activities (user_id, created_at desc);

alter table public.lead_activities enable row level security;
drop policy if exists lead_activities_own on public.lead_activities;
create policy lead_activities_own on public.lead_activities
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
