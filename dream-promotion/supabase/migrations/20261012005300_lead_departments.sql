-- ============================================================================================================================
-- Migration 20261012005300 — lead departments, and every new lead from a Meta form to its person on WhatsApp (2.99.0).
-- Prepared only: NOT applied to the live database (needs the owner's explicit approval; the SQL Editor). Runs after 20261009004100
-- (the client file — already in the live database: leads (id, business_id) is unique there): it stops at the top without it,
-- changing nothing. Additions only and idempotent: no drop and no delete statement (the word "delete" is in the foreign keys'
-- "on delete" only). Tested on a local Postgres: tests/sql/lead-routing.check.sql.
--
--   lead_staff              the team that gets leads: a name, a WhatsApp number (digits, international, no "+"), and the member
--                           of the business who is this person in Dream (optional — it drives "הלידים שלי"). Never deleted:
--                           removed = active false, so the history keeps its name.
--   lead_departments        a department (מיקרובליידינג, לייזר…) and the one person responsible for it. Removed = active false.
--   lead_department_rules   how a lead is recognised as the department's: a Meta form (its id), a campaign (its name contains
--                           the text, or its id), or a question of the form and its answer.
--   lead_routing            per business: the default recipient of a lead with no department (none = nobody gets it).
--   lead_notifications      one row per WhatsApp message about a lead: to whom, the five values of the template, its state
--                           (queued → sending → sent | failed; skipped when WhatsApp is not connected or the lead is old), the
--                           attempts, Meta's message id, and Meta's whole error. unique (business_id, dedupe_key): the same Meta
--                           lead is never sent twice to the same person ('lead:<Meta lead id>:<person>'), nor a move by the
--                           owner ('move:<contact>:<person>').
--   leads                   + department_id, assigned_staff_id ("אחראי"), routed_at (when the routing ran — with no department:
--                           "ללא מחלקה"), routed_by (why: the form / the campaign / the question and answer).
-- The five tables are the server's only: the browser neither reads nor writes them (the team's phones, Meta's errors) — the
-- screens go through /api/leads/departments and /api/leads/assignment, which check the member and, for every change, the owner.
-- On leads, the four new columns are changed by the server only (leads_guard_routing refuses the API roles): moving a lead to
-- another person is the owner's, through the server. The rollback is at the end.
-- ============================================================================================================================

-- ---- 0. after 20261009004100 -----------------------------------------------------------------------------------------------------
do $$ begin
  if to_regclass('public.leads_id_business_uq') is null or to_regclass('public.businesses') is null then
    raise exception 'migration 20261012005300 runs after 20261009004100 (the client file) — run that one first; nothing was changed';
  end if;
end $$;

-- ---- 1. the team ---------------------------------------------------------------------------------------------------------------
create table if not exists public.lead_staff (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references public.businesses on delete cascade,
  name           text not null check (length(btrim(name)) between 1 and 60),
  phone          text not null check (phone ~ '^[1-9][0-9]{7,14}$'),
  member_user_id uuid references auth.users on delete set null,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (id, business_id)
);
create index if not exists lead_staff_business_idx on public.lead_staff (business_id, created_at);
-- one active person per WhatsApp number, and per member of the business
create unique index if not exists lead_staff_phone_uq on public.lead_staff (business_id, phone) where active;
create unique index if not exists lead_staff_member_uq on public.lead_staff (business_id, member_user_id) where active and member_user_id is not null;

-- ---- 2. the departments and how a lead is recognised ------------------------------------------------------------------------------
create table if not exists public.lead_departments (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses on delete cascade,
  name        text not null check (length(btrim(name)) between 1 and 60),
  staff_id    uuid not null,
  position    int  not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (id, business_id),
  constraint lead_departments_staff_fk foreign key (staff_id, business_id) references public.lead_staff (id, business_id)
);
create index if not exists lead_departments_business_idx on public.lead_departments (business_id, position);
create unique index if not exists lead_departments_name_uq on public.lead_departments (business_id, lower(btrim(name))) where active;

create table if not exists public.lead_department_rules (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses on delete cascade,
  department_id uuid not null,
  kind          text not null check (kind in ('form', 'campaign', 'answer')),
  form_id       text not null default '',
  form_name     text not null default '',
  campaign      text not null default '',
  question      text not null default '',
  answer        text not null default '',
  created_at    timestamptz not null default now(),
  constraint lead_department_rules_department_fk foreign key (department_id, business_id)
    references public.lead_departments (id, business_id) on delete cascade,
  constraint lead_department_rules_shape check (case kind
    when 'form' then form_id ~ '^[0-9]{1,30}$' and length(form_name) <= 200
    when 'campaign' then length(btrim(campaign)) between 1 and 200
    else length(btrim(question)) between 1 and 300 and length(btrim(answer)) between 1 and 300 end)
);
create index if not exists lead_department_rules_department_idx on public.lead_department_rules (department_id);
create index if not exists lead_department_rules_business_idx on public.lead_department_rules (business_id);

create table if not exists public.lead_routing (
  business_id      uuid primary key references public.businesses on delete cascade,
  default_staff_id uuid,
  updated_at       timestamptz not null default now(),
  constraint lead_routing_default_fk foreign key (default_staff_id, business_id) references public.lead_staff (id, business_id)
);

-- ---- 3. the messages -------------------------------------------------------------------------------------------------------------
create table if not exists public.lead_notifications (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses on delete cascade,
  lead_id       uuid not null,
  staff_id      uuid not null,
  kind          text not null check (kind in ('lead', 'move')),
  dedupe_key    text not null check (length(dedupe_key) between 1 and 200),
  external_id   text not null default '',
  staff_name    text not null default '',
  to_phone      text not null default '',
  params        jsonb not null default '[]'::jsonb,
  status        text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed', 'skipped')),
  reason        text not null default '',
  attempts      int  not null default 0 check (attempts >= 0),
  wa_message_id text not null default '',
  error_code    text not null default '',
  error         jsonb,
  claimed_at    timestamptz,
  sent_at       timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint lead_notifications_once unique (business_id, dedupe_key),
  constraint lead_notifications_lead_fk foreign key (lead_id, business_id) references public.leads (id, business_id) on delete cascade,
  constraint lead_notifications_staff_fk foreign key (staff_id, business_id) references public.lead_staff (id, business_id)
);
create index if not exists lead_notifications_lead_idx on public.lead_notifications (lead_id, created_at);
create index if not exists lead_notifications_business_idx on public.lead_notifications (business_id, created_at desc);
create index if not exists lead_notifications_queued_idx on public.lead_notifications (created_at) where status = 'queued';
create index if not exists lead_notifications_staff_idx on public.lead_notifications (staff_id);

do $$
declare t text;
begin
  foreach t in array array['lead_staff', 'lead_departments', 'lead_routing', 'lead_notifications'] loop
    execute format('create or replace trigger touch_%1$s before update on public.%1$s for each row execute function public.touch_updated_at()', t);
  end loop;
end $$;

-- the server's only: no policy, no grant for the browser (row-level security on, so even a grant given by mistake shows nothing)
do $$
declare t text;
begin
  foreach t in array array['lead_staff', 'lead_departments', 'lead_department_rules', 'lead_routing', 'lead_notifications'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end $$;

-- ---- 4. the contact: its department and the person responsible ---------------------------------------------------------------------
alter table public.leads add column if not exists department_id uuid;
alter table public.leads add column if not exists assigned_staff_id uuid;
alter table public.leads add column if not exists routed_at timestamptz;
alter table public.leads add column if not exists routed_by text not null default '';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'leads_department_fk' and conrelid = 'public.leads'::regclass) then
    alter table public.leads add constraint leads_department_fk foreign key (department_id, business_id)
      references public.lead_departments (id, business_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'leads_assignee_fk' and conrelid = 'public.leads'::regclass) then
    alter table public.leads add constraint leads_assignee_fk foreign key (assigned_staff_id, business_id)
      references public.lead_staff (id, business_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'leads_routed_by_len' and conrelid = 'public.leads'::regclass) then
    alter table public.leads add constraint leads_routed_by_len check (length(routed_by) <= 300);
  end if;
end $$;
create index if not exists leads_assignee_idx on public.leads (business_id, assigned_staff_id) where assigned_staff_id is not null;

-- the four columns are the server's: the browser (anon / authenticated) neither sets them on a new contact nor changes them —
-- every other column stays as it was (a contact's details, stage, notes…), and so does an upsert that leaves them out
create or replace function public.leads_guard_routing() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      if new.department_id is not null or new.assigned_staff_id is not null or new.routed_at is not null or coalesce(new.routed_by, '') <> '' then
        raise exception 'lead_routing_server_only: the department and the person responsible are set by the server' using errcode = '42501';
      end if;
    elsif (new.department_id, new.assigned_staff_id, new.routed_at, new.routed_by)
          is distinct from (old.department_id, old.assigned_staff_id, old.routed_at, old.routed_by) then
      raise exception 'lead_routing_server_only: only the owner moves a lead to another person (through the server)' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.leads_guard_routing() from public, anon, authenticated;
create or replace trigger leads_guard_routing before insert or update on public.leads
  for each row execute function public.leads_guard_routing();

-- ---- rollback (by hand, only to undo it — it removes the team, the departments and the record of messages) ------------------------
--   drop trigger if exists leads_guard_routing on public.leads;  drop function if exists public.leads_guard_routing();
--   alter table public.leads drop constraint if exists leads_department_fk, drop constraint if exists leads_assignee_fk,
--     drop constraint if exists leads_routed_by_len;  drop index if exists public.leads_assignee_idx;
--   drop table if exists public.lead_notifications, public.lead_routing, public.lead_department_rules, public.lead_departments,
--     public.lead_staff;
--   (the four columns of leads can stay — empty, nothing reads them without the tables)
