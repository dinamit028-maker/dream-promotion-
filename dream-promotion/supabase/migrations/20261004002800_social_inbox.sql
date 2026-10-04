-- ============================================================================
-- Migration 20261004002800 — comments and messages from Meta into the leads board ("תגובות" column).
-- Additive only, idempotent.
--   social_messages      every comment (Facebook / Instagram) and message (Messenger / Instagram Direct), in and out,
--                        per business — the conversation shown on the contact card
--   meta_inbox_sync      per Page / Instagram account: when it was last read and the last error
--   social_accounts.inbox_enabled   a switch per account (like leads_enabled): only switched-on accounts are read
-- A person who writes becomes ONE contact in the business (leads.status 'פנייה', external_source 'meta_social',
-- external_id '<platform>:<their id>'), so the same person is never two cards; "🔥 ליד חם" moves them to 'חדש'.
-- Writes are server-only (service role). Members of the business read their business's messages and may mark
-- them read / handled (column grants). Rollback: drop table social_messages, meta_inbox_sync; columns can stay.
-- ============================================================================
alter table public.social_accounts add column if not exists inbox_enabled boolean not null default false;
grant select (inbox_enabled) on public.social_accounts to authenticated;
create or replace view public.social_accounts_public with (security_invoker = true) as
  select id, business_id, user_id, provider, external_id, display_name, avatar_url, status, missing_since,
         scope, connection_id, created_at, updated_at, leads_enabled, inbox_enabled
    from public.social_accounts;

create table if not exists public.social_messages (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references public.businesses on delete cascade,
  social_account_id uuid references public.social_accounts on delete set null,
  lead_id           uuid references public.leads on delete set null,
  channel           text not null check (channel in ('fb_comment', 'ig_comment', 'messenger', 'ig_dm')),
  external_id       text not null,                 -- Meta's comment / message id
  thread_id         text not null default '',      -- the post (comments) or the conversation (messages)
  parent_id         text not null default '',      -- a reply's parent comment
  post_url          text not null default '',
  post_text         text not null default '',      -- the post's caption, shortened — "תגובה על הפוסט: …"
  author_id         text not null default '',      -- the person's id on that platform
  author_name       text not null default '',
  direction         text not null default 'in' check (direction in ('in', 'out')),
  body              text not null default '',
  sent_at           timestamptz not null default now(),
  read_at           timestamptz,
  created_at        timestamptz not null default now(),
  unique (business_id, channel, external_id)
);
create index if not exists social_messages_business_idx on public.social_messages (business_id, sent_at desc);
create index if not exists social_messages_lead_idx on public.social_messages (lead_id);

create table if not exists public.meta_inbox_sync (
  social_account_id uuid primary key references public.social_accounts on delete cascade,
  business_id       uuid not null references public.businesses on delete cascade,
  last_synced_at    timestamptz,
  last_error        text not null default '',
  updated_at        timestamptz not null default now()
);
create or replace trigger touch_meta_inbox_sync before update on public.meta_inbox_sync for each row execute function public.touch_updated_at();

alter table public.social_messages enable row level security;
alter table public.meta_inbox_sync enable row level security;
do $$
declare r constant text := 'business_id = (select public.current_business_id()) and business_id in (select public.accessible_business_ids())';
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'social_messages' and policyname = 'social_messages_read') then
    execute format('create policy social_messages_read on public.social_messages for select to authenticated using (%s)', r);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'social_messages' and policyname = 'social_messages_mark') then
    execute format('create policy social_messages_mark on public.social_messages for update to authenticated using (%s) with check (%s)', r, r);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'meta_inbox_sync' and policyname = 'meta_inbox_sync_read') then
    create policy meta_inbox_sync_read on public.meta_inbox_sync for select to authenticated using (public.can_access_business(business_id));
  end if;
end $$;
revoke all on public.social_messages, public.meta_inbox_sync from anon, authenticated;
grant select on public.social_messages, public.meta_inbox_sync to authenticated;
grant update (read_at) on public.social_messages to authenticated;   -- "נקרא" only; everything else server-side
