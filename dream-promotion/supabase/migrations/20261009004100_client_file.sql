-- ============================================================================
-- Migration 20261009004100 — client file (תיק לקוח), task 1: the data model of docs/CLIENT FILE ENGINEERING HE.md §3.
-- Prepared only: NOT applied to the live database (needs the owner's explicit approval). Tested on a local Postgres:
-- tests/sql/client-file.check.sql.
--
-- Health declarations and body / face photos are sensitive information (privacy law, amendment 13). So:
--   1. who sees it         client_files_allowed(): a member of the business worked in now, with full access (never a cashier),
--                          who is its owner or a practitioner the owner marked (client_file_access). Not the super admin
--                          either, unless they are such a member. Every table: "_business_gate" (the current business, as
--                          every business table), "_viewer_*" (can_write()) and a RESTRICTIVE "_client_files".
--   2. tables              treatment_types, client_treatments, client_sessions, client_photos, declaration_templates,
--                          declaration_requests, declarations, client_file_views (+ client_file_access: who the owner marked).
--                          A row's lead / treatment / template / request is of the same business (composite foreign keys).
--   3. append-only         declarations: never updated (by anyone); deleted only by client_file_purge (the owner deletes a
--                          whole client file). Written by the server only (service role) when the customer signs.
--   4. templates           draft → approved (owner only) → archived. Approved content never changes: an edit is a new
--                          version (family_id, version + 1, a draft); approving it archives the version before it.
--   5. requests            the token is kept as a sha-256 hash only; only approved templates of the business; their
--                          versions are copied from the templates (a later version does not change a request or a declaration).
--   6. view log            client_file_views: every opening of a photo or a declaration (who, when, what) — written only by
--                          client_file_view / client_file_log_view, read only by the owner, never changed. A purge is
--                          logged there too, without the content.
--   7. marketing           a photo is marketing_ok only when the customer agreed in a signed declaration (default no).
--   8. storage             private bucket "client-files" (<business>/<lead>/<file>). No browser policy at all: files go in and
--                          out through the server only (EXIF removed; a signed URL for 5 minutes after the view is logged).
-- client_file_purge contains DELETE: through the MCP it stalls (CLAUDE.md) — the owner of the system runs this file in the
-- SQL Editor, then it is checked through the MCP read-only.
-- Idempotent (if not exists / create or replace). Additive: the only change to an existing table is a unique index on
-- leads (id, business_id), which the composite keys need (id is already unique, so it cannot fail). Rollback: at the end.
-- ============================================================================

-- ---- the leads key the client file hangs on (the file's foreign keys are "no action": a customer with a file is not deleted
-- alone, while a business deleted by the platform takes both in one statement) ------------------------------------------------------------------------------
create unique index if not exists leads_id_business_uq on public.leads (id, business_id);

-- ---- 1. who sees client files ---------------------------------------------------------------------------------------------
-- practitioners the owner marked; revoked = revoked_at set (never deleted: who had access stays known)
create table if not exists public.client_file_access (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses on delete cascade,
  user_id     uuid not null references auth.users on delete cascade,
  granted_by  uuid,
  granted_at  timestamptz not null default now(),
  revoked_by  uuid,
  revoked_at  timestamptz
);
create unique index if not exists client_file_access_active_uq on public.client_file_access (business_id, user_id) where revoked_at is null;
alter table public.client_file_access enable row level security;

-- may this user see the client files of this business? (server: the user from the request, the business from workBusiness)
create or replace function public.client_files_allowed_for(p_user uuid, p_business uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select p_user is not null and p_business is not null and public.business_is_active(p_business)
     and exists (select 1 from public.business_members m
                  where m.business_id = p_business and m.user_id = p_user and m.access = 'full'
                    and (m.role = 'owner'
                         or exists (select 1 from public.client_file_access a
                                     where a.business_id = p_business and a.user_id = p_user and a.revoked_at is null)));
$$;
revoke execute on function public.client_files_allowed_for(uuid, uuid) from public, anon, authenticated;
grant execute on function public.client_files_allowed_for(uuid, uuid) to service_role;

-- the signed-in caller, in the business they work in now
create or replace function public.client_files_allowed() returns boolean
language sql stable security definer set search_path = public as $$
  select public.client_files_allowed_for(auth.uid(), public.current_business_id());
$$;
revoke execute on function public.client_files_allowed() from public, anon;
grant execute on function public.client_files_allowed() to authenticated, service_role;

-- is this user the owner of this business (approves templates, marks practitioners, reads the view log, purges)?
create or replace function public.client_file_owner_for(p_user uuid, p_business uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select p_user is not null and p_business is not null and public.business_is_active(p_business)
     and exists (select 1 from public.business_members m
                  where m.business_id = p_business and m.user_id = p_user and m.access = 'full' and m.role = 'owner');
$$;
revoke execute on function public.client_file_owner_for(uuid, uuid) from public, anon, authenticated;
grant execute on function public.client_file_owner_for(uuid, uuid) to service_role;

create or replace function public.client_file_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select public.client_file_owner_for(auth.uid(), public.current_business_id());
$$;
revoke execute on function public.client_file_owner() from public, anon;
grant execute on function public.client_file_owner() to authenticated, service_role;

-- ---- 2. tables ---------------------------------------------------------------------------------------------------------------
-- the clinic's own list of treatment types (free text, not a list in code)
create table if not exists public.treatment_types (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses on delete cascade,
  name        text not null check (length(btrim(name)) between 1 and 80),
  active      boolean not null default true,
  sort        int not null default 0,
  created_at  timestamptz not null default now()
);
create unique index if not exists treatment_types_id_business_uq on public.treatment_types (id, business_id);
create unique index if not exists treatment_types_name_uq on public.treatment_types (business_id, lower(btrim(name)));

create table if not exists public.client_treatments (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references public.businesses on delete cascade,
  lead_id           uuid not null,
  treatment_type_id uuid,
  area              text not null default '' check (length(area) <= 200),
  title             text not null default '' check (length(title) <= 200),
  started_at        date not null default public.il_today(),
  status            text not null default 'active' check (status in ('active', 'done', 'paused', 'cancelled')),
  notes             text not null default '' check (length(notes) <= 5000),
  created_by        uuid default auth.uid(),
  created_at        timestamptz not null default now(),
  foreign key (lead_id, business_id) references public.leads (id, business_id),
  foreign key (treatment_type_id, business_id) references public.treatment_types (id, business_id)
);
create unique index if not exists client_treatments_key_uq on public.client_treatments (id, business_id, lead_id);
create index if not exists client_treatments_lead_idx on public.client_treatments (business_id, lead_id, started_at desc);

create table if not exists public.client_sessions (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses on delete cascade,
  treatment_id uuid not null,
  lead_id      uuid not null,
  at           timestamptz not null default now(),
  by_user      uuid default auth.uid(),
  params       jsonb not null default '{}' check (jsonb_typeof(params) = 'object'),
  notes        text not null default '' check (length(notes) <= 5000),
  created_at   timestamptz not null default now(),
  foreign key (treatment_id, business_id, lead_id) references public.client_treatments (id, business_id, lead_id)
);
create unique index if not exists client_sessions_key_uq on public.client_sessions (id, business_id, lead_id);
create index if not exists client_sessions_treatment_idx on public.client_sessions (treatment_id, at desc);

create table if not exists public.client_photos (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses on delete cascade,
  lead_id      uuid not null,
  treatment_id uuid,
  session_id   uuid,
  stage        text not null check (stage in ('before', 'after', 'process')),
  path         text not null unique,
  width        int check (width between 1 and 10000),
  height       int check (height between 1 and 10000),
  taken_at     timestamptz not null default now(),
  by_user      uuid default auth.uid(),
  marketing_ok boolean not null default false,
  created_at   timestamptz not null default now(),
  -- the file is the business's and the customer's: client-files/<business>/<lead>/<file>
  constraint client_photos_path_check check (path like business_id::text || '/' || lead_id::text || '/%' and path !~ '\.\.'),
  foreign key (lead_id, business_id) references public.leads (id, business_id),
  foreign key (treatment_id, business_id, lead_id) references public.client_treatments (id, business_id, lead_id),
  foreign key (session_id, business_id, lead_id) references public.client_sessions (id, business_id, lead_id)
);
create index if not exists client_photos_lead_idx on public.client_photos (business_id, lead_id, taken_at desc);
create index if not exists client_photos_treatment_idx on public.client_photos (treatment_id, taken_at desc);

-- a template is kept once, at the business; family_id = the first version's id; each version its own row
create table if not exists public.declaration_templates (
  id                 uuid primary key default gen_random_uuid(),
  business_id        uuid not null references public.businesses on delete cascade,
  family_id          uuid,
  title              text not null check (length(btrim(title)) between 1 and 200),
  treatment_type_ids uuid[] not null default '{}',   -- empty: a general declaration, for every treatment
  version            int not null default 1 check (version >= 1),
  status             text not null default 'draft' check (status in ('draft', 'approved', 'archived')),
  fields             jsonb not null default '[]' check (jsonb_typeof(fields) = 'array'),
  acks               jsonb not null default '[]' check (jsonb_typeof(acks) = 'array'),
  valid_days         int check (valid_days between 1 and 3650),   -- null: no expiry
  source_file_path   text,
  created_by         uuid default auth.uid(),
  created_at         timestamptz not null default now(),
  approved_by        uuid,
  approved_at        timestamptz,
  archived_at        timestamptz,
  constraint declaration_templates_source_check
    check (source_file_path is null or (source_file_path like business_id::text || '/templates/%' and source_file_path !~ '\.\.')),
  constraint declaration_templates_approved_check
    check ((status = 'draft') = (approved_at is null) and (approved_at is null) = (approved_by is null))
);
create unique index if not exists declaration_templates_id_business_uq on public.declaration_templates (id, business_id);
create unique index if not exists declaration_templates_version_uq on public.declaration_templates (family_id, version);
create unique index if not exists declaration_templates_one_draft_uq on public.declaration_templates (family_id) where status = 'draft';
create unique index if not exists declaration_templates_one_approved_uq on public.declaration_templates (family_id) where status = 'approved';
create index if not exists declaration_templates_business_idx on public.declaration_templates (business_id, status);

create table if not exists public.declaration_requests (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references public.businesses on delete cascade,
  lead_id           uuid not null,
  template_ids      uuid[] not null check (cardinality(template_ids) between 1 and 20),
  template_versions int[] not null default '{}',
  token_hash        text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),   -- sha-256 of the token; never the token
  status            text not null default 'sent' check (status in ('sent', 'opened', 'signed', 'expired', 'cancelled')),
  sent_by           uuid default auth.uid(),
  sent_at           timestamptz not null default now(),
  opened_at         timestamptz,
  signed_at         timestamptz,
  cancelled_at      timestamptz,
  expires_at        timestamptz not null default now() + interval '7 days',
  foreign key (lead_id, business_id) references public.leads (id, business_id)
);
create unique index if not exists declaration_requests_key_uq on public.declaration_requests (id, business_id, lead_id);
create index if not exists declaration_requests_lead_idx on public.declaration_requests (business_id, lead_id, sent_at desc);

create table if not exists public.declarations (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references public.businesses on delete cascade,
  lead_id          uuid not null,
  request_id       uuid not null,
  template_id      uuid not null,
  template_version int not null,
  answers          jsonb not null default '{}' check (jsonb_typeof(answers) = 'object'),
  acks             jsonb not null default '[]' check (jsonb_typeof(acks) = 'array'),
  signer_name      text not null check (length(btrim(signer_name)) between 2 and 200),
  signature_path   text not null,
  pdf_path         text not null,
  pdf_sha256       text not null check (pdf_sha256 ~ '^[0-9a-f]{64}$'),
  signed_at        timestamptz not null default now(),
  valid_until      date,   -- from the template's valid_days; null: no expiry
  ip               inet,
  user_agent       text not null default '' check (length(user_agent) <= 1000),
  marketing_ok     boolean not null default false,
  constraint declarations_paths_check check (
    signature_path like business_id::text || '/' || lead_id::text || '/%' and signature_path !~ '\.\.'
    and pdf_path like business_id::text || '/' || lead_id::text || '/%' and pdf_path !~ '\.\.'),
  foreign key (request_id, business_id, lead_id) references public.declaration_requests (id, business_id, lead_id),
  foreign key (template_id, business_id) references public.declaration_templates (id, business_id),
  unique (request_id, template_id)   -- one signature per template per link: a second one is refused
);
create index if not exists declarations_lead_idx on public.declarations (business_id, lead_id, signed_at desc);

-- the log: who opened what and when (no foreign keys — it outlives a purged file, and holds no content)
create table if not exists public.client_file_views (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses on delete cascade,
  user_id     uuid not null,
  lead_id     uuid not null,
  object      text not null check (object in ('photo', 'declaration', 'client_file')),
  object_id   uuid not null,
  action      text not null default 'view' check (action in ('view', 'purge')),
  at          timestamptz not null default now()
);
create index if not exists client_file_views_lead_idx on public.client_file_views (business_id, lead_id, at desc);
create index if not exists client_file_views_user_idx on public.client_file_views (business_id, user_id, at desc);

-- ---- 1 (cont.). row-level security -----------------------------------------------------------------------------------------
do $$
declare
  t text;
  gate constant text := 'business_id = (select public.current_business_id()) and business_id in (select public.accessible_business_ids())';
  files constant text := '(select public.client_files_allowed())';
  owner constant text := '(select public.client_file_owner())';
begin
  foreach t in array array['treatment_types', 'client_treatments', 'client_sessions', 'client_photos', 'declaration_templates',
                           'declaration_requests', 'declarations', 'client_file_views', 'client_file_access'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke truncate on public.%I from authenticated', t);
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_business_gate') then
      execute format('create policy %I on public.%I for all to authenticated using (%s) with check (%s)', t || '_business_gate', t, gate, gate);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_viewer_insert') then
      execute format('create policy %I on public.%I as restrictive for insert to authenticated with check ((select public.can_write()))', t || '_viewer_insert', t);
      execute format('create policy %I on public.%I as restrictive for update to authenticated using ((select public.can_write())) with check ((select public.can_write()))', t || '_viewer_update', t);
      execute format('create policy %I on public.%I as restrictive for delete to authenticated using ((select public.can_write()))', t || '_viewer_delete', t);
    end if;
  end loop;

  -- the sensitive tables: the owner and marked practitioners only — reading and writing
  foreach t in array array['client_treatments', 'client_sessions', 'client_photos', 'declaration_templates', 'declaration_requests', 'declarations'] loop
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_client_files') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)', t || '_client_files', t, files, files);
    end if;
  end loop;

  -- treatment types are only names: every member reads them (the booking warning); only the client-file people write them
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'treatment_types' and policyname = 'treatment_types_client_files_insert') then
    execute format('create policy treatment_types_client_files_insert on public.treatment_types as restrictive for insert to authenticated with check (%s)', files);
    execute format('create policy treatment_types_client_files_update on public.treatment_types as restrictive for update to authenticated using (%s) with check (%s)', files, files);
    execute format('create policy treatment_types_client_files_delete on public.treatment_types as restrictive for delete to authenticated using (%s)', files);
  end if;

  -- declarations: written by the server only (the customer's signature), never from the browser
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'declarations' and policyname = 'declarations_read_only') then
    create policy declarations_read_only on public.declarations as restrictive for insert to authenticated with check (false);
    create policy declarations_no_update on public.declarations as restrictive for update to authenticated using (false);
    create policy declarations_no_delete on public.declarations as restrictive for delete to authenticated using (false);
  end if;

  -- the view log and the marked practitioners: the owner reads; written only through the functions below
  foreach t in array array['client_file_views', 'client_file_access'] loop
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_owner_read') then
      execute format('create policy %I on public.%I as restrictive for select to authenticated using (%s)', t || '_owner_read', t, owner);
      execute format('create policy %I on public.%I as restrictive for insert to authenticated with check (false)', t || '_no_insert', t);
      execute format('create policy %I on public.%I as restrictive for update to authenticated using (false)', t || '_no_update', t);
      execute format('create policy %I on public.%I as restrictive for delete to authenticated using (false)', t || '_no_delete', t);
    end if;
  end loop;
end $$;

-- ---- triggers -----------------------------------------------------------------------------------------------------------------
-- "a_": the caller's own business and the right to the client file, before any other check reads a row (as a_gate_caller)
create or replace function public.client_files_gate() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user in ('anon', 'authenticated') then
    if new.business_id is null
       or new.business_id is distinct from public.current_business_id()
       or new.business_id not in (select public.accessible_business_ids())
       or not public.client_files_allowed() then
      raise exception 'not allowed' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.client_files_gate() from public, anon, authenticated;
do $$
declare t text;
begin
  foreach t in array array['treatment_types', 'client_treatments', 'client_sessions', 'client_photos', 'declaration_templates',
                           'declaration_requests', 'declarations'] loop
    execute format('create or replace trigger a_client_files_gate before insert or update on public.%I for each row execute function public.client_files_gate()', t);
  end loop;
end $$;

-- deletion: never one row of the file from the app or the server — only a whole file, through client_file_purge
-- (it runs as the database owner and marks the transaction; the app's roles and the server's never get here)
create or replace function public.client_file_no_delete() returns trigger
language plpgsql set search_path = public as $$
begin
  -- a business the platform deletes takes its client file with it (on delete cascade)
  if not exists (select 1 from public.businesses b where b.id = old.business_id) then return old; end if;
  if current_user in ('anon', 'authenticated', 'service_role') or coalesce(current_setting('dream.client_file_purge', true), '') <> 'on' then
    raise exception 'client file rows are not deleted one by one — the owner deletes a whole client file' using errcode = '42501';
  end if;
  return old;
end $$;
revoke execute on function public.client_file_no_delete() from public, anon, authenticated;
do $$
declare t text;
begin
  foreach t in array array['client_treatments', 'client_sessions', 'client_photos', 'declaration_requests', 'declarations'] loop
    execute format('create or replace trigger b_client_file_no_delete before delete on public.%I for each row execute function public.client_file_no_delete()', t);
  end loop;
end $$;

-- 3. declarations: append-only
create or replace function public.declarations_check() returns trigger
language plpgsql set search_path = public as $$
declare r public.declaration_requests; t public.declaration_templates; i int;
begin
  if tg_op = 'UPDATE' then
    raise exception 'a signed declaration is never changed' using errcode = '42501';
  end if;
  if current_user in ('anon', 'authenticated') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into r from public.declaration_requests where id = new.request_id and business_id = new.business_id and lead_id = new.lead_id for update;
  if r.id is null then raise exception 'the request was not found' using errcode = '23503'; end if;
  if r.status not in ('sent', 'opened') or r.expires_at <= now() then
    raise exception 'the link is no longer valid (%)', case when r.expires_at <= now() and r.status in ('sent', 'opened') then 'expired' else r.status end
      using errcode = '23514';
  end if;
  i := array_position(r.template_ids, new.template_id);
  if i is null then raise exception 'the template was not sent in this link' using errcode = '23514'; end if;
  select * into t from public.declaration_templates where id = new.template_id and business_id = new.business_id;
  if t.version is distinct from r.template_versions[i] then raise exception 'not the version that was sent' using errcode = '23514'; end if;
  new.template_version := t.version;
  new.signed_at := now();   -- the server's clock, never the phone's
  new.valid_until := case when t.valid_days is null then null else (public.il_today() + t.valid_days) end;
  return new;
end $$;
revoke execute on function public.declarations_check() from public, anon, authenticated;
create or replace trigger b_declarations_check before insert or update on public.declarations
  for each row execute function public.declarations_check();

-- 4. templates: versions, approval by the owner, approved content frozen
create or replace function public.declaration_templates_check() returns trigger
language plpgsql set search_path = public as $$
declare app constant boolean := current_user in ('anon', 'authenticated'); n int;
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then raise exception 'an approved template is archived, never deleted' using errcode = '23514'; end if;
    return old;
  end if;
  -- the treatment types are the business's own
  if new.treatment_type_ids is distinct from (case when tg_op = 'UPDATE' then old.treatment_type_ids end) then
    select count(*) into n from public.treatment_types y where y.business_id = new.business_id and y.id = any (new.treatment_type_ids);
    if n <> cardinality(array(select distinct unnest(new.treatment_type_ids))) then
      raise exception 'unknown treatment type' using errcode = '23503';
    end if;
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then raise exception 'a template starts as a draft' using errcode = '23514'; end if;
    new.approved_by := null; new.approved_at := null; new.archived_at := null;
    if new.family_id is null or new.family_id = new.id then
      new.family_id := new.id; new.version := 1;
    else
      -- a new version of an approved template of the same business
      select max(version) into n from public.declaration_templates where family_id = new.family_id and business_id = new.business_id;
      if n is null then raise exception 'unknown template' using errcode = '23503'; end if;
      new.version := n + 1;
    end if;
    return new;
  end if;
  -- UPDATE
  if new.business_id <> old.business_id or new.family_id is distinct from old.family_id or new.version <> old.version then
    raise exception 'a template stays in its business, family and version' using errcode = '23514';
  end if;
  if old.status = 'draft' and new.status = 'approved' then
    if app and not public.client_file_owner() then raise exception 'only the owner approves a declaration' using errcode = '42501'; end if;
    if jsonb_array_length(new.fields) + jsonb_array_length(new.acks) = 0 then
      raise exception 'an empty declaration is not approved' using errcode = '23514';
    end if;
    new.approved_by := coalesce(auth.uid(), new.approved_by);
    new.approved_at := now();
    -- the version before it stops being sent from now
    update public.declaration_templates set status = 'archived'
     where family_id = new.family_id and status = 'approved' and id <> new.id;
    return new;
  end if;
  if old.status = 'draft' and new.status = 'draft' then
    new.approved_by := null; new.approved_at := null;
    return new;
  end if;
  if old.status = 'approved' and new.status = 'archived' then
    if (new.title, new.treatment_type_ids, new.fields, new.acks, new.valid_days, new.source_file_path, new.approved_by, new.approved_at)
       is distinct from (old.title, old.treatment_type_ids, old.fields, old.acks, old.valid_days, old.source_file_path, old.approved_by, old.approved_at) then
      raise exception 'an approved template does not change — edit makes a new version' using errcode = '23514';
    end if;
    new.archived_at := now();
    return new;
  end if;
  if old.status = new.status then
    raise exception 'an approved template does not change — edit makes a new version' using errcode = '23514';
  end if;
  raise exception 'a template goes draft → approved → archived' using errcode = '23514';
end $$;
revoke execute on function public.declaration_templates_check() from public, anon, authenticated;
create or replace trigger b_declaration_templates_check before insert or update or delete on public.declaration_templates
  for each row execute function public.declaration_templates_check();

-- 5. requests: approved templates of the business, their versions copied; the link itself never changes
create or replace function public.declaration_requests_check() returns trigger
language plpgsql set search_path = public as $$
declare v int[]; n int;
begin
  if tg_op = 'INSERT' then
    if cardinality(array(select distinct unnest(new.template_ids))) <> cardinality(new.template_ids) then
      raise exception 'a template once per link' using errcode = '23514';
    end if;
    select array_agg(t.version order by k.i), count(*) into v, n
      from unnest(new.template_ids) with ordinality k(id, i)
      join public.declaration_templates t on t.id = k.id and t.business_id = new.business_id and t.status = 'approved';
    if n <> cardinality(new.template_ids) then raise exception 'only approved declarations are sent' using errcode = '23514'; end if;
    new.template_versions := v;
    new.status := 'sent'; new.sent_at := now(); new.opened_at := null; new.signed_at := null; new.cancelled_at := null;
    if new.expires_at <= now() or new.expires_at > now() + interval '30 days' then new.expires_at := now() + interval '7 days'; end if;
    return new;
  end if;
  if (new.business_id, new.lead_id, new.template_ids, new.template_versions, new.token_hash, new.sent_at, new.sent_by, new.expires_at)
     is distinct from (old.business_id, old.lead_id, old.template_ids, old.template_versions, old.token_hash, old.sent_at, old.sent_by, old.expires_at) then
    raise exception 'a sent link does not change — send a new one' using errcode = '23514';
  end if;
  if new.status = old.status then return new; end if;
  if old.status not in ('sent', 'opened') then raise exception 'the link is already %', old.status using errcode = '23514'; end if;
  -- the business may only cancel; opened / signed / expired come from the server (the customer's page)
  if current_user in ('anon', 'authenticated') and new.status <> 'cancelled' then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if new.status = 'opened' and old.status <> 'sent' then raise exception 'already opened' using errcode = '23514'; end if;
  if new.status = 'signed' then
    if old.expires_at <= now() then raise exception 'the link expired' using errcode = '23514'; end if;
    if (select count(*) from public.declarations d where d.request_id = new.id) <> cardinality(new.template_ids) then
      raise exception 'not every declaration of the link is signed' using errcode = '23514';
    end if;
  end if;
  case new.status
    when 'opened' then new.opened_at := now();
    when 'signed' then new.signed_at := now();
    when 'cancelled' then new.cancelled_at := now();
    else null;
  end case;
  return new;
end $$;
revoke execute on function public.declaration_requests_check() from public, anon, authenticated;
create or replace trigger b_declaration_requests_check before insert or update on public.declaration_requests
  for each row execute function public.declaration_requests_check();

-- 7. photos: the file stays where it is; marketing only with the customer's signed consent
create or replace function public.client_photos_check() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' and (new.path, new.lead_id, new.business_id) is distinct from (old.path, old.lead_id, old.business_id) then
    raise exception 'a photo stays with its file and customer' using errcode = '23514';
  end if;
  if new.marketing_ok and (tg_op = 'INSERT' or not old.marketing_ok)
     and not exists (select 1 from public.declarations d where d.business_id = new.business_id and d.lead_id = new.lead_id and d.marketing_ok) then
    raise exception 'the customer did not agree to marketing use of photos' using errcode = '23514';
  end if;
  return new;
end $$;
revoke execute on function public.client_photos_check() from public, anon, authenticated;
create or replace trigger b_client_photos_check before insert or update on public.client_photos
  for each row execute function public.client_photos_check();

-- 6. the view log never changes (a purge of the whole business — businesses on delete cascade — still goes through)
create or replace function public.client_file_views_frozen() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.businesses b where b.id = old.business_id) then return old; end if;
  raise exception 'the view log is never changed' using errcode = '42501';
end $$;
revoke execute on function public.client_file_views_frozen() from public, anon, authenticated;
create or replace trigger b_client_file_views_frozen before update or delete on public.client_file_views
  for each row execute function public.client_file_views_frozen();

-- ---- functions the app and the server call -------------------------------------------------------------------------------------
-- log one opening and return the customer (lead) it belongs to; refused ('not allowed') for anyone else and for another
-- business's object — the same answer, so nothing is told about it
create or replace function public.client_file_log_view(p_user uuid, p_business uuid, p_object text, p_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare lead uuid;
begin
  if not public.client_files_allowed_for(p_user, p_business) then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_object = 'photo' then
    select lead_id into lead from public.client_photos where id = p_id and business_id = p_business;
  elsif p_object = 'declaration' then
    select lead_id into lead from public.declarations where id = p_id and business_id = p_business;
  end if;
  if lead is null then raise exception 'not allowed' using errcode = '42501'; end if;
  insert into public.client_file_views (business_id, user_id, lead_id, object, object_id, action)
  values (p_business, p_user, lead, p_object, p_id, 'view');
  return lead;
end $$;
revoke execute on function public.client_file_log_view(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.client_file_log_view(uuid, uuid, text, uuid) to service_role;

create or replace function public.client_file_view(p_object text, p_id uuid) returns uuid
language sql security definer set search_path = public as $$
  select public.client_file_log_view(auth.uid(), public.current_business_id(), p_object, p_id);
$$;
revoke execute on function public.client_file_view(text, uuid) from public, anon;
grant execute on function public.client_file_view(text, uuid) to authenticated, service_role;

-- the owner marks / unmarks a practitioner (a full-access member of the business; never a cashier)
create or replace function public.client_file_set_access(p_user uuid, p_on boolean) returns boolean
language plpgsql security definer set search_path = public as $$
declare b uuid := public.current_business_id();
begin
  if not public.client_file_owner() or not public.can_write() then raise exception 'not allowed' using errcode = '42501'; end if;
  if not exists (select 1 from public.business_members m where m.business_id = b and m.user_id = p_user and m.access = 'full') then
    raise exception 'only a member of the business with full access (not a cashier)' using errcode = '23514';
  end if;
  if p_on then
    insert into public.client_file_access (business_id, user_id, granted_by) values (b, p_user, auth.uid())
    on conflict (business_id, user_id) where revoked_at is null do nothing;
  else
    update public.client_file_access set revoked_at = now(), revoked_by = auth.uid()
     where business_id = b and user_id = p_user and revoked_at is null;
  end if;
  return p_on;
end $$;
revoke execute on function public.client_file_set_access(uuid, boolean) from public, anon;
grant execute on function public.client_file_set_access(uuid, boolean) to authenticated;

-- the owner deletes a customer's whole client file, on request. Returns the storage paths for the server to remove from
-- "client-files". The log keeps who, when and which customer — not the content. Server only (the route checks the user).
create or replace function public.client_file_purge(p_user uuid, p_business uuid, p_lead uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare paths text[]; n jsonb;
begin
  if not public.client_file_owner_for(p_user, p_business) then raise exception 'not allowed' using errcode = '42501'; end if;
  if not exists (select 1 from public.leads l where l.id = p_lead and l.business_id = p_business) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select coalesce(array_agg(p), '{}') into paths from (
    select path as p from public.client_photos where business_id = p_business and lead_id = p_lead
    union all select signature_path from public.declarations where business_id = p_business and lead_id = p_lead
    union all select pdf_path from public.declarations where business_id = p_business and lead_id = p_lead) x;
  n := jsonb_build_object(
    'photos', (select count(*) from public.client_photos where business_id = p_business and lead_id = p_lead),
    'declarations', (select count(*) from public.declarations where business_id = p_business and lead_id = p_lead),
    'treatments', (select count(*) from public.client_treatments where business_id = p_business and lead_id = p_lead));
  perform set_config('dream.client_file_purge', 'on', true);
  delete from public.client_photos where business_id = p_business and lead_id = p_lead;
  delete from public.declarations where business_id = p_business and lead_id = p_lead;
  delete from public.declaration_requests where business_id = p_business and lead_id = p_lead;
  delete from public.client_sessions where business_id = p_business and lead_id = p_lead;
  delete from public.client_treatments where business_id = p_business and lead_id = p_lead;
  perform set_config('dream.client_file_purge', '', true);
  insert into public.client_file_views (business_id, user_id, lead_id, object, object_id, action)
  values (p_business, p_user, p_lead, 'client_file', p_lead, 'purge');
  return jsonb_build_object('paths', to_jsonb(paths), 'counts', n);
end $$;
revoke execute on function public.client_file_purge(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.client_file_purge(uuid, uuid, uuid) to service_role;

-- ---- 8. the private bucket: <business>/<lead>/<file> and <business>/templates/<file>; the server only ---------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('client-files', 'client-files', false, 15728640, array['image/webp', 'image/png', 'application/pdf',
  'image/jpeg', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do nothing;
-- RESTRICTIVE: whatever other policy a bucket has, no browser (signed-in or not) reads, lists, uploads, replaces or removes
-- anything in client-files. The server (service role) uploads after removing EXIF and hands out 5-minute signed URLs.
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'client_files_server_only') then
    create policy client_files_server_only on storage.objects as restrictive for all to anon, authenticated
      using (bucket_id <> 'client-files') with check (bucket_id <> 'client-files');
  end if;
end $$;

-- ============================================================================================================================
-- Rollback (by hand, if ever needed — it deletes the client files' data):
--   drop policy client_files_server_only on storage.objects; (the bucket: empty it from the dashboard, then delete it)
--   drop function client_file_purge(uuid, uuid, uuid), client_file_set_access(uuid, boolean), client_file_view(text, uuid),
--     client_file_log_view(uuid, uuid, text, uuid);
--   drop table client_file_views, declarations, declaration_requests, declaration_templates, client_photos, client_sessions,
--     client_treatments, treatment_types, client_file_access;
--   drop function client_files_gate(), client_file_no_delete(), declarations_check(), declaration_templates_check(),
--     declaration_requests_check(), client_photos_check(), client_file_views_frozen(), client_file_owner(),
--     client_file_owner_for(uuid, uuid), client_files_allowed(), client_files_allowed_for(uuid, uuid);
--   drop index leads_id_business_uq;
-- ============================================================================================================================
