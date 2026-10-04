-- ============================================================================
-- Migration 20261004002700 — leads from Meta Lead Ads forms into the CRM. Additive only, idempotent.
--   social_accounts.leads_enabled   a switch per Facebook Page: only switched-on Pages are imported
--   leads.external_source / external_id   where an imported lead came from ('meta_lead_ads', the Meta lead id);
--                                   unique per business, so the same Meta lead is never imported twice
--   meta_lead_sync                  per Page: when it was last synced and the last error (shown on screen)
-- A lead always lands in the business its Page is assigned to (the server sets business_id explicitly);
-- the separation between businesses comes from that assignment, not from who connected Meta.
-- Writes are server-only (service role); a member of the business may read its sync state.
-- Rollback: drop table meta_lead_sync; drop index leads_external_uq; the new columns can stay.
-- ============================================================================
alter table public.social_accounts add column if not exists leads_enabled boolean not null default false;
-- the browser may read the switch (tokens stay closed: column grants, stage 3)
grant select (leads_enabled) on public.social_accounts to authenticated;
create or replace view public.social_accounts_public with (security_invoker = true) as
  select id, business_id, user_id, provider, external_id, display_name, avatar_url, status, missing_since,
         scope, connection_id, created_at, updated_at, leads_enabled
    from public.social_accounts;

alter table public.leads add column if not exists external_source text;
alter table public.leads add column if not exists external_id text;
create unique index if not exists leads_external_uq on public.leads (business_id, external_source, external_id);

create table if not exists public.meta_lead_sync (
  social_account_id uuid primary key references public.social_accounts on delete cascade,
  business_id       uuid not null references public.businesses on delete cascade,
  last_synced_at    timestamptz,
  last_error        text not null default '',
  imported_total    int  not null default 0,
  updated_at        timestamptz not null default now()
);
create index if not exists meta_lead_sync_business_idx on public.meta_lead_sync (business_id);
create or replace trigger touch_meta_lead_sync before update on public.meta_lead_sync for each row execute function public.touch_updated_at();

alter table public.meta_lead_sync enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'meta_lead_sync' and policyname = 'meta_lead_sync_read') then
    create policy meta_lead_sync_read on public.meta_lead_sync for select to authenticated
      using (public.can_access_business(business_id));
  end if;
end $$;
revoke insert, update, delete on public.meta_lead_sync from anon, authenticated;
grant select on public.meta_lead_sync to authenticated;
