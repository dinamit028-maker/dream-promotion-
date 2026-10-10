-- ============================================================================
-- Migration 20261010004200 — packages and series of treatments paid in advance (docs/FINANCE ADDITIONS HE.md, T1).
-- Prepared only: NOT applied to the live database (needs the owner's explicit approval). Tested on a local Postgres:
-- tests/sql/client-packages.check.sql and tests/sql/concurrency.sh §13.
--
--   1. the catalog        a package is an item of the one catalog — catalog_items, kind 'package' (the register's "🎁 חבילות"),
--                         created and edited only in the product editor. New on it: package_sessions (how many treatments),
--                         package_type_id (a treatment type of the business; null = any treatment), package_valid_months
--                         (null = no expiry). No second catalog.
--   2. sold packages      client_packages: the customer and the terms COPIED at the sale — a later change in the catalog
--                         changes nothing that was sold. Never deleted, its terms never change (a mistake is cancelled and
--                         sold again). Its document is an ordinary document of the existing engine, issued with the key
--                         "package:<id>" and linked here in the same transaction (one document per package, for its price).
--                         Its money is that document's money in payments — never a column here.
--   3. deductions         client_package_uses: one row per treatment taken from a package, for one session. Given back =
--                         returned_at (who, why), never deleted. One active deduction per session (a unique index), never
--                         beyond the package (under the package's lock), never from a cancelled package, never for a
--                         cancelled session, never for a treatment of another type.
--   4. sessions           client_sessions + cancelled_at / cancelled_by / cancel_reason: a session is still never deleted
--                         (4100); cancelling it is final and gives its treatment back to the package in the same statement.
--                         client_session_add(): a session and its deduction in one transaction, with the caller's own rights.
--   5. status             client_package_status (security invoker): used / returned / remaining, the document, what was paid
--                         (the ledger: in − out of the document and of what pays it or pays it back) and credited — the one
--                         place the screens and the report read their numbers from.
--   6. privacy            client_packages and client_package_uses are money tables (3100 + 3200): the business worked in now,
--                         its money open to the caller, never a cashier, a viewer reads only, a_gate_caller before the checks.
--                         Recording or cancelling a session stays with the client file's people (4100: client_files_allowed()).
--   7. audit              package.sold / package.changed / package.cancelled / package.used / package.returned in the
--                         business's audit log (finance_log).
-- Idempotent (if not exists / create or replace). Additive: three columns on catalog_items, three on client_sessions, one trigger
-- on documents (it links a package's document; every other document is untouched); nothing removed, no data changed.
-- No statement removes a row or an object: the MCP can apply the file — without the rollback note at its end.
-- ============================================================================

-- ---- 1. the catalog: a package's terms on its item ----------------------------------------------------------------------
alter table public.catalog_items add column if not exists package_sessions     int;
alter table public.catalog_items add column if not exists package_type_id      uuid;
alter table public.catalog_items add column if not exists package_valid_months int;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'catalog_items_package_check') then
    alter table public.catalog_items add constraint catalog_items_package_check
      check ((package_sessions is null or package_sessions between 1 and 500)
         and (package_valid_months is null or package_valid_months between 1 and 120));
  end if;
  -- the treatment type is the business's own (treatment_types, 4100)
  if not exists (select 1 from pg_constraint where conname = 'catalog_items_package_type_fk') then
    alter table public.catalog_items add constraint catalog_items_package_type_fk
      foreign key (package_type_id, business_id) references public.treatment_types (id, business_id);
  end if;
end $$;

-- ---- 2. a package sold to a customer --------------------------------------------------------------------------------------
create table if not exists public.client_packages (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references public.businesses on delete restrict,
  user_id           uuid references auth.users on delete set null default auth.uid(),   -- who sold it
  lead_id           uuid not null,
  item_id           uuid references public.catalog_items on delete set null,            -- the catalog's package (its terms were copied)
  name              text not null check (length(btrim(name)) between 1 and 120),
  treatment_type_id uuid,                                                                -- null: any treatment
  sessions_total    int not null check (sessions_total between 1 and 500),
  price             numeric(14,2) not null check (price >= 0),
  sold_on           date not null default public.il_today(),
  valid_until       date,                                                                -- null: no expiry
  notes             text not null default '' check (length(notes) <= 500),
  status            text not null default 'active' check (status in ('active', 'cancelled')),
  document_id       uuid references public.documents on delete restrict,                 -- its document (key "package:<id>")
  cancelled_at      timestamptz,
  cancelled_by      uuid,
  cancel_reason     text not null default '' check (length(cancel_reason) <= 300),
  created_at        timestamptz not null default now(),
  -- the customer and the type are the business's own; a customer with a package is not deleted (the money stays known)
  foreign key (lead_id, business_id) references public.leads (id, business_id),
  foreign key (treatment_type_id, business_id) references public.treatment_types (id, business_id),
  constraint client_packages_valid_check check (valid_until is null or valid_until >= sold_on),
  constraint client_packages_cancel_check check ((status = 'cancelled') = (cancelled_at is not null)
                                                  and (status <> 'cancelled' or length(btrim(cancel_reason)) >= 2))
);
create unique index if not exists client_packages_key_uq on public.client_packages (id, business_id, lead_id);
create unique index if not exists client_packages_document_uq on public.client_packages (document_id) where document_id is not null;
create index if not exists client_packages_lead_idx on public.client_packages (business_id, lead_id, created_at desc);
create index if not exists client_packages_business_idx on public.client_packages (business_id, status, created_at desc);

-- ---- 3. a treatment taken from a package (one session each) ---------------------------------------------------------------
create table if not exists public.client_package_uses (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses on delete restrict,
  package_id    uuid not null,
  lead_id       uuid not null,
  session_id    uuid,                          -- null only after the owner deleted the client file (the deduction stays)
  user_id       uuid references auth.users on delete set null default auth.uid(),       -- who deducted
  used_at       timestamptz not null default now(),
  returned_at   timestamptz,                   -- given back (the session was cancelled, or a deduction by mistake)
  returned_by   uuid,
  return_reason text not null default '' check (length(return_reason) <= 300),
  foreign key (package_id, business_id, lead_id) references public.client_packages (id, business_id, lead_id),
  -- a purged client file takes only the link to its session away (Postgres 15+: set null of one column)
  foreign key (session_id, business_id, lead_id) references public.client_sessions (id, business_id, lead_id) on delete set null (session_id)
);
-- one active deduction per session, whatever the package: a second one is refused by the index itself
create unique index if not exists client_package_uses_session_uq on public.client_package_uses (session_id) where returned_at is null;
create index if not exists client_package_uses_package_idx on public.client_package_uses (package_id, used_at desc);
create index if not exists client_package_uses_lead_idx on public.client_package_uses (business_id, lead_id);

-- ---- 4. a session can be cancelled (never deleted) ------------------------------------------------------------------------
alter table public.client_sessions add column if not exists cancelled_at  timestamptz;
alter table public.client_sessions add column if not exists cancelled_by  uuid;
alter table public.client_sessions add column if not exists cancel_reason text not null default '';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'client_sessions_cancel_check') then
    alter table public.client_sessions add constraint client_sessions_cancel_check
      check (length(cancel_reason) <= 300 and (cancelled_at is not null or cancel_reason = ''));
  end if;
end $$;

-- ---- 6. privacy: the money tables' rules (3100 + 3200) ----------------------------------------------------------------------
do $$
declare
  t text; op text;
  gate        constant text := 'business_id = (select public.current_business_id()) and business_id in (select public.accessible_business_ids())';
  fin         constant text := 'business_id in (select public.finance_business_ids())';
  full_access constant text := '(select public.my_access()) <> ''register''';
  -- reading is always allowed; inserting and updating go through the checks below; nothing is deleted
  cmds constant jsonb := '{"client_packages": ["insert", "update"], "client_package_uses": ["insert", "update"]}';
begin
  for t in select jsonb_object_keys(cmds) loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate on public.%I from authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_business_gate') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)', t || '_business_gate', t, gate, gate);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_finance_privacy') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)', t || '_finance_privacy', t, fin, fin);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_cashier_none') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)', t || '_cashier_none', t, full_access, full_access);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_business_read') then
      execute format('create policy %I on public.%I for select to authenticated using (%s)', t || '_business_read', t, gate);
    end if;
    for op in select jsonb_array_elements_text(cmds -> t) loop
      execute format('grant %s on public.%I to authenticated', op, t);
      if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_business_' || op) then
        execute format('create policy %I on public.%I for %s to authenticated %s', t || '_business_' || op, t, op,
          case op when 'insert' then format('with check (%s and user_id = auth.uid())', gate)
                  else format('using (%s) with check (%s)', gate, gate) end);
      end if;
    end loop;
    -- a viewer reads, never writes (3200)
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_viewer_insert') then
      execute format('create policy %I on public.%I as restrictive for insert to authenticated with check ((select public.can_write()))', t || '_viewer_insert', t);
      execute format('create policy %I on public.%I as restrictive for update to authenticated using ((select public.can_write())) with check ((select public.can_write()))', t || '_viewer_update', t);
      execute format('create policy %I on public.%I as restrictive for delete to authenticated using ((select public.can_write()))', t || '_viewer_delete', t);
    end if;
    -- "a_": the business from the seller / deducter, then the caller's own business before any check reads a row (3200)
    execute format('create or replace trigger a_fill_business_id before insert on public.%I for each row execute function public.fill_business_id()', t);
    execute format('create or replace trigger a_gate_caller before insert or update on public.%I for each row execute function public.gate_caller()', t);
    -- never deleted: a mistake is cancelled (a package) or given back (a deduction)
    execute format('create or replace trigger %I before delete on public.%I for each row execute function public.finance_append_only()', t || '_no_delete', t);
  end loop;
end $$;

-- ---- 2 (cont.). a sold package: the terms are copied once and kept --------------------------------------------------------
create or replace function public.client_packages_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare it record; d record;
begin
  if tg_op = 'INSERT' then
    if new.item_id is not null then
      select c.id, c.kind into it from public.catalog_items c where c.id = new.item_id and c.business_id = new.business_id;
      if not found or it.kind <> 'package' then
        raise exception 'the package is not in this business''s catalog' using errcode = '23503';
      end if;
    end if;
    if new.status <> 'active' or new.cancelled_at is not null or new.cancelled_by is not null or new.cancel_reason <> '' then
      raise exception 'a package is sold active' using errcode = '23514';
    end if;
    new.name := btrim(new.name);
    new.sold_on := coalesce(new.sold_on, public.il_today());
    if new.sold_on > public.il_today() then raise exception 'a package is not sold in the future' using errcode = '23514'; end if;
    new.user_id := coalesce(auth.uid(), new.user_id);
    new.created_at := now();
    -- its document may already exist (issued before the package was saved, or a retry): linked now, checked below
    new.document_id := (select x.id from public.documents x where x.business_id = new.business_id and x.idempotency_key = 'package:' || new.id::text);
  else
    -- the terms of a sold package never change (a mistake is cancelled and sold again). The catalog item or the seller
    -- may only disappear (their own deletion sets them to null)
    if (new.id, new.business_id, new.lead_id, new.name, new.treatment_type_id, new.sessions_total, new.price, new.sold_on, new.created_at)
       is distinct from (old.id, old.business_id, old.lead_id, old.name, old.treatment_type_id, old.sessions_total, old.price, old.sold_on, old.created_at)
       or (new.item_id is distinct from old.item_id and new.item_id is not null)
       or (new.user_id is distinct from old.user_id and new.user_id is not null) then
      raise exception 'a sold package keeps its terms (cancel it and sell again)' using errcode = '23514';
    end if;
    if new.document_id is distinct from old.document_id and old.document_id is not null then
      raise exception 'a package keeps its document' using errcode = '23514';
    end if;
    if new.status <> old.status then
      if old.status <> 'active' or new.status <> 'cancelled' then
        raise exception 'a cancelled package stays cancelled' using errcode = '23514';
      end if;
      new.cancelled_at := now();
      new.cancelled_by := coalesce(auth.uid(), new.cancelled_by);
      new.cancel_reason := left(btrim(new.cancel_reason), 300);
      if length(new.cancel_reason) < 2 then raise exception 'a reason is required to cancel a package' using errcode = '23514'; end if;
    elsif (new.cancelled_at, new.cancelled_by, new.cancel_reason) is distinct from (old.cancelled_at, old.cancelled_by, old.cancel_reason) then
      raise exception 'a package is cancelled only by cancelling it' using errcode = '23514';
    elsif old.status = 'cancelled' and (new.valid_until, new.notes) is distinct from (old.valid_until, old.notes) then
      raise exception 'a cancelled package does not change' using errcode = '23514';
    end if;
  end if;
  -- the document: of this business, issued for THIS package (its key), for its customer and its price, a document of a sale
  if new.document_id is not null and (tg_op = 'INSERT' or new.document_id is distinct from old.document_id) then
    select x.business_id, x.lead_id, x.doc_type, x.total, x.idempotency_key into d from public.documents x where x.id = new.document_id;
    if not found or d.business_id <> new.business_id or d.idempotency_key is distinct from 'package:' || new.id::text then
      raise exception 'the document is not this package''s' using errcode = '23514';
    end if;
    if d.doc_type not in (300, 305, 320, 400) or d.lead_id is distinct from new.lead_id or d.total <> new.price then
      raise exception 'package_document: the document is not of this package''s customer and price' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.client_packages_check() from public, anon, authenticated;
create or replace trigger b_client_packages_check before insert or update on public.client_packages
  for each row execute function public.client_packages_check();

create or replace function public.client_packages_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public.finance_log(new.business_id, 'package.sold', 'client_packages', new.id::text,
      jsonb_build_object('name', new.name, 'sessions', new.sessions_total, 'price', new.price, 'lead', new.lead_id, 'validUntil', new.valid_until));
  elsif new.status <> old.status then
    perform public.finance_log(new.business_id, 'package.cancelled', 'client_packages', new.id::text,
      jsonb_build_object('name', new.name, 'reason', new.cancel_reason));
  elsif (new.valid_until, new.notes) is distinct from (old.valid_until, old.notes) then
    perform public.finance_log(new.business_id, 'package.changed', 'client_packages', new.id::text,
      jsonb_build_object('validUntil', new.valid_until, 'was', old.valid_until, 'notes', new.notes is distinct from old.notes));
  end if;   -- the document's link: its own line is document.issued
  return null;
end $$;
revoke execute on function public.client_packages_audit() from public, anon, authenticated;
create or replace trigger client_packages_audit after insert or update on public.client_packages
  for each row execute function public.client_packages_audit();

-- the document of a package ("package:<id>") is linked to it in the transaction that issues it — whoever issues it, however
-- many times (a retry returns the same document: the key is unique in the business). Any other document is not touched.
create or replace function public.documents_package_link() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.idempotency_key ~ '^package:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    update public.client_packages set document_id = new.id
     where id = substr(new.idempotency_key, 9)::uuid and business_id = new.business_id and document_id is null;
  end if;
  return null;
end $$;
revoke execute on function public.documents_package_link() from public, anon, authenticated;
create or replace trigger z_documents_package_link after insert on public.documents
  for each row execute function public.documents_package_link();

-- ---- 3 (cont.). a deduction: one per session, never beyond the package -----------------------------------------------------
create or replace function public.client_package_uses_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare s record; p record; n int; t_type uuid;
begin
  if tg_op = 'INSERT' then
    if new.session_id is null then raise exception 'a deduction is for a session' using errcode = '23502'; end if;
    -- the session first, then the package — the order cancelling a session takes too, so they never wait on each other
    select x.id, x.treatment_id, x.cancelled_at into s from public.client_sessions x
     where x.id = new.session_id and x.business_id = new.business_id and x.lead_id = new.lead_id for update;
    if not found then raise exception 'the session was not found for this customer' using errcode = '23503'; end if;
    if s.cancelled_at is not null then raise exception 'session_cancelled: a cancelled session is not deducted' using errcode = '23514'; end if;
    -- the package, locked: two deductions of its last treatment at once leave exactly one
    select x.id, x.status, x.sessions_total, x.treatment_type_id into p from public.client_packages x
     where x.id = new.package_id and x.business_id = new.business_id and x.lead_id = new.lead_id for update;
    if not found then raise exception 'the package was not found for this customer' using errcode = '23503'; end if;
    if p.status <> 'active' then raise exception 'package_cancelled: a cancelled package is not used' using errcode = '23514'; end if;
    if exists (select 1 from public.client_package_uses u where u.session_id = new.session_id and u.returned_at is null) then
      raise exception 'session_deducted: this session was already deducted' using errcode = '23505';
    end if;
    select count(*) into n from public.client_package_uses u where u.package_id = p.id and u.returned_at is null;
    if n >= p.sessions_total then raise exception 'package_used_up: no treatments are left in this package' using errcode = '23514'; end if;
    select y.treatment_type_id into t_type from public.client_treatments y where y.id = s.treatment_id and y.business_id = new.business_id;
    if p.treatment_type_id is not null and t_type is not null and t_type <> p.treatment_type_id then
      raise exception 'package_other_type: the package is for another type of treatment' using errcode = '23514';
    end if;
    new.user_id := coalesce(auth.uid(), new.user_id);
    new.used_at := now();
    new.returned_at := null; new.returned_by := null; new.return_reason := '';
    return new;
  end if;
  -- UPDATE: a deduction is only given back, once
  if old.returned_at is null and new.returned_at is not null
     and (new.id, new.business_id, new.package_id, new.lead_id, new.session_id, new.user_id, new.used_at)
         is not distinct from (old.id, old.business_id, old.package_id, old.lead_id, old.session_id, old.user_id, old.used_at) then
    new.returned_at := now();
    new.returned_by := coalesce(auth.uid(), new.returned_by);
    new.return_reason := left(btrim(new.return_reason), 300);
    return new;
  end if;
  -- the session's link (the client file was deleted) or the deducter (their user was deleted) may only disappear
  if (new.id, new.business_id, new.package_id, new.lead_id, new.used_at, new.returned_at, new.returned_by, new.return_reason)
       is not distinct from (old.id, old.business_id, old.package_id, old.lead_id, old.used_at, old.returned_at, old.returned_by, old.return_reason)
     and (new.session_id is not distinct from old.session_id or new.session_id is null)
     and (new.user_id is not distinct from old.user_id or new.user_id is null) then
    return new;
  end if;
  raise exception 'a deduction does not change — it is given back' using errcode = '23514';
end $$;
revoke execute on function public.client_package_uses_check() from public, anon, authenticated;
create or replace trigger b_client_package_uses_check before insert or update on public.client_package_uses
  for each row execute function public.client_package_uses_check();

create or replace function public.client_package_uses_audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if tg_op = 'INSERT' then
    select p.sessions_total - (select count(*) from public.client_package_uses u where u.package_id = p.id and u.returned_at is null)
      into n from public.client_packages p where p.id = new.package_id;
    perform public.finance_log(new.business_id, 'package.used', 'client_packages', new.package_id::text,
      jsonb_build_object('session', new.session_id, 'remaining', n));
  elsif old.returned_at is null and new.returned_at is not null then
    perform public.finance_log(new.business_id, 'package.returned', 'client_packages', new.package_id::text,
      jsonb_build_object('session', new.session_id, 'reason', new.return_reason));
  end if;
  return null;
end $$;
revoke execute on function public.client_package_uses_audit() from public, anon, authenticated;
create or replace trigger client_package_uses_audit after insert or update on public.client_package_uses
  for each row execute function public.client_package_uses_audit();

-- ---- 4 (cont.). cancelling a session: final, and its treatment goes back to the package -----------------------------------
create or replace function public.client_sessions_cancel() returns trigger
language plpgsql set search_path = public as $$
begin
  if old.cancelled_at is not null then
    if new is distinct from old then raise exception 'a cancelled session does not change' using errcode = '23514'; end if;
    return new;
  end if;
  if new.cancelled_at is not null then
    new.cancelled_at := now();                       -- the server's clock
    new.cancelled_by := coalesce(auth.uid(), new.cancelled_by);
    new.cancel_reason := left(btrim(new.cancel_reason), 300);
  else
    new.cancelled_by := null; new.cancel_reason := '';
  end if;
  return new;
end $$;
revoke execute on function public.client_sessions_cancel() from public, anon, authenticated;
-- "b_": after a_client_files_gate (only the client file's people change a session)
create or replace trigger b_client_sessions_cancel before update on public.client_sessions
  for each row execute function public.client_sessions_cancel();

create or replace function public.client_sessions_cancelled() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.cancelled_at is null and new.cancelled_at is not null then
    update public.client_package_uses
       set returned_at = now(), returned_by = new.cancelled_by,
           return_reason = left('הטיפול בוטל' || case when new.cancel_reason <> '' then ': ' || new.cancel_reason else '' end, 300)
     where session_id = new.id and business_id = new.business_id and returned_at is null;
  end if;
  return null;
end $$;
revoke execute on function public.client_sessions_cancelled() from public, anon, authenticated;
create or replace trigger client_sessions_cancelled after update of cancelled_at on public.client_sessions
  for each row execute function public.client_sessions_cancelled();

-- a session and its deduction in one transaction — with the caller's own rights (security invoker): the client file's rules
-- decide on the session (4100), the money tables' rules on the deduction (above); a refusal of either leaves nothing
create or replace function public.client_session_add(p_lead uuid, p_treatment uuid, p_at timestamptz default null, p_notes text default '',
  p_package uuid default null, p_id uuid default null) returns uuid
language plpgsql security invoker set search_path = public as $$
declare b uuid := public.current_business_id(); sid uuid := coalesce(p_id, gen_random_uuid()); t timestamptz := coalesce(p_at, now());
begin
  -- the id is fixed on the device: a retry of the same call (its answer was lost) is the same session, not a second treatment
  if p_id is not null and exists (select 1 from public.client_sessions s where s.id = p_id and s.lead_id = p_lead) then return p_id; end if;
  if t > now() + interval '1 day' or t < timestamptz '2000-01-01 00:00:00+00' then
    raise exception 'session_time: a session that took place (not in the future)' using errcode = '22023';
  end if;
  insert into public.client_sessions (id, business_id, treatment_id, lead_id, at, by_user, notes)
  values (sid, b, p_treatment, p_lead, t, auth.uid(), left(btrim(coalesce(p_notes, '')), 5000));
  if p_package is not null then
    insert into public.client_package_uses (business_id, package_id, lead_id, session_id, user_id)
    values (b, p_package, p_lead, sid, auth.uid());
  end if;
  return sid;
end $$;
revoke execute on function public.client_session_add(uuid, uuid, timestamptz, text, uuid, uuid) from public, anon;
grant execute on function public.client_session_add(uuid, uuid, timestamptz, text, uuid, uuid) to authenticated;

-- ---- 5. the numbers of a package, from one place (the caller's row-level security applies: security invoker) -------------
--   used      treatments taken and not given back; remaining = sessions_total − used
--   paid      the ledger of its document: in − out of the document itself (a 320 / 400) and of what pays it or pays it back
--             (receipts on a 305 / 300, their cancellations, money returned on a credit invoice)
--   credited  credit invoices (330) on its document
create or replace view public.client_package_status with (security_invoker = true) as
select p.id, p.business_id, p.lead_id, l.name as customer_name, p.item_id, p.name, p.treatment_type_id, p.sessions_total, p.price,
       p.sold_on, p.valid_until, p.notes, p.status, p.document_id, p.cancelled_at, p.cancel_reason, p.user_id, p.created_at,
       coalesce(u.used, 0)::int as used, coalesce(u.returned, 0)::int as returned,
       (p.sessions_total - coalesce(u.used, 0))::int as remaining, u.last_used_at,
       d.doc_type, d.doc_number, d.doc_date, d.total as doc_total, (x.document_id is not null) as doc_cancelled,
       coalesce(m.paid, 0)::numeric(14,2) as paid, coalesce(cr.credited, 0)::numeric(14,2) as credited
  from public.client_packages p
  left join public.leads l on l.id = p.lead_id
  left join lateral (select count(*) filter (where c.returned_at is null) as used, count(*) filter (where c.returned_at is not null) as returned,
                            max(c.used_at) filter (where c.returned_at is null) as last_used_at
                       from public.client_package_uses c where c.package_id = p.id) u on true
  left join public.documents d on d.id = p.document_id
  left join public.document_cancellations x on x.document_id = p.document_id
  left join lateral (select sum(case y.direction when 'in' then y.amount else -y.amount end) as paid from public.payments y
                      where p.document_id is not null and (y.document_id = p.document_id or y.applies_to = p.document_id)) m on true
  left join lateral (select sum(c.total) as credited from public.documents c
                      where d.id is not null and c.business_id = d.business_id and c.doc_type = 330
                        and c.base_doc_type = d.doc_type and c.base_doc_number = d.doc_number) cr on true
 where (select public.my_access()) <> 'register';
revoke all on public.client_package_status from anon;
grant select on public.client_package_status to authenticated;

-- ============================================================================================================================
-- Rollback (by hand, if ever needed — it deletes the packages that were sold):
--   drop trigger z_documents_package_link on documents; drop function documents_package_link();
--   drop trigger client_sessions_cancelled, b_client_sessions_cancel on client_sessions;
--   drop function client_session_add(uuid, uuid, timestamptz, text, uuid, uuid), client_sessions_cancelled(), client_sessions_cancel();
--   drop view client_package_status; drop table client_package_uses, client_packages;
--   drop function client_package_uses_check(), client_package_uses_audit(), client_packages_check(), client_packages_audit();
--   the added columns can stay (nothing before 2.87 reads them), or: alter table catalog_items drop constraint
--   catalog_items_package_type_fk, drop constraint catalog_items_package_check, drop column package_sessions, drop column
--   package_type_id, drop column package_valid_months; alter table client_sessions drop constraint client_sessions_cancel_check,
--   drop column cancelled_at, drop column cancelled_by, drop column cancel_reason.
-- ============================================================================================================================
