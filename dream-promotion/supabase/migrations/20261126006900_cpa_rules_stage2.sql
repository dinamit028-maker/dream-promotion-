-- 2.119.0 — the accountant's answers of 25.11.2026, stage 2: the database (tests/sql/cpa-rules-stage2.check.sql).
-- docs/ita-registration/CPA_ANSWERS_HE.md rows 1, 2, 3א, 4, 6, 6 נוסף and 20; the owner's decisions of 26.11.2026 (no Tax
-- Authority API yet: the rules, the blocking and the manual number now — the automatic request later; the monthly / yearly
-- backups in a private Storage bucket). For NEW rows only: no issued document, allocation, payment or setting changes (nothing
-- here updates or deletes a row of the business; the two columns added to tax_allocation_rules come with their default).
--   1. (answers 1, 2, 3א) when a document needs an allocation number — ONE rule, in the database: allocation_required(documents)
--      — a tax invoice 305 / 320 or a credit invoice 330 (new column tax_allocation_rules.required_doc_types, default
--      {305,320,330}), of a business that charges VAT, to a customer with a dealer number (customer_dealer, 9 digits — a private
--      customer never needs one), whose amount before VAT (after_discount) is the threshold of the document's date OR MORE (new
--      column threshold_inclusive, default true: "5,000 ומעלה"; before — "more than"). The thresholds stay the four rows of 3100
--      / 5200 (25,000 from 5.5.2024, 20,000 from 1.1.2025, 10,000 from 1.1.2026, 5,000 from 1.6.2026). The old column doc_types
--      ({305,320}) is left as it was and no longer read by the database.
--      allocation_awaiting(documents) = required and no real number (tax_allocations approved / manual, not a test).
--      The document is issued without the number; it is NOT delivered to the customer until it has one:
--        * document_share_open(token, channel) — the customer's link (/d/<token>, its PDF, the storefront's copy): the one way the
--          server opens a document by its token; 'awaiting_allocation' (nothing recorded) until the number is there;
--        * document_delivery_record(document, channel) — print / email / WhatsApp / PDF from the app: refused
--          ('awaiting_allocation', 55000);
--        * a print counted the old way (documents.print_count + 1) — new trigger f_documents_print_allocation refuses it too.
--      finance_summary's "allocationMissing" counts allocation_awaiting() (replaces 5100's finance_summary — same signature).
--      View document_allocation_status (security invoker — the RLS of documents / tax_allocations) for the lists.
--      The storefront's order page (sf_order_view, the object sf_order / the order's page return): also "doc_awaiting"
--      (boolean, false without a document) — the store shows "ממתין למספר הקצאה" instead of the document's link.
--   2. (answer 4) an allocation number, once recorded, never changes: tax_allocations is append-only (3100,
--      tax_allocations_append_only), one real number per document (tax_allocations_one_real_uq), record_manual_allocation
--      refuses a second one. Nothing to add: a wrong number is corrected by a credit invoice (330) and a new invoice.
--   3. (answer 6) document_deliveries (append-only): every time the document reaches the customer — the link opened, the PDF
--      downloaded, printed, sent by mail / WhatsApp. The first one is the original ("מקור", is_original — one per document,
--      unique); every later one "העתק נאמן למקור". A document printed before this migration (print_count > 0) was already
--      delivered: its next delivery is a copy. RLS: _business_gate, _finance_privacy, _cashier_none, _location_gate; no write from
--      the browser — only the functions.
--   4. (answer 6 נוסף) the delivered PDF is kept: private bucket delivered-documents, <business_id>/<document_id>/<delivery_id>.pdf
--      (written by the server only; read by a finance member of the business; never replaced or removed), and
--      document_delivery_files (append-only: the delivery → the file + its sha256), written by document_delivery_file_add.
--   5. (answer 20) backups: daily — Supabase's own; monthly (kept 12 months) and yearly (kept 7 years) — private bucket backups
--      (no browser role at all), table backup_runs (the server only; a run goes running → ok / failed, ok → expired, nothing
--      else), backup_tables / backup_export (what to write, per business and table, in pages), backup_run_start / _finish /
--      _fail, backup_expirable / backup_expire (refuses a copy younger than its retention, and a monthly copy without a later
--      yearly copy). A backup file is removed from Storage only after backup_expire (or when its run failed).
-- Replaces two functions (same signatures; md5 of prosrc — compare with the live database before running:
--   md5(replace(prosrc, E'\r', '')) from pg_proc where oid = '<function>'::regprocedure):
--   finance_summary(date, date)  of 20261011005100_journal_entries.sql  — old 060b20715ec06fdc9bfa3094b9be78d0 ("allocationMissing")
--   sf_order_view(public.orders) of 20261006003600_commerce_finance.sql — old 45b913e37b7757de6e56b6a8d0549d3c (adds "doc_awaiting")
-- Running 5100 again after this one brings the old count back ("more than", 305 / 320 only), and 3600 the order's page without
-- "doc_awaiting" — then run this one again.
-- On Storage: the buckets, their policies, and a trigger on storage.objects (storage_objects_keep — nothing in the two new
-- buckets is replaced or removed, even by the server, but an expired / failed backup). If the database refuses the trigger
-- (the role is not the owner of storage.objects) the migration says so in a NOTICE and goes on: the policies still keep every
-- browser role out; check with  select tgname from pg_trigger where tgrelid = 'storage.objects'::regclass.
-- Deploy order: THE CODE FIRST, then this migration. The new app falls back to the 2.118 behaviour while these functions are
-- missing; this migration under the old app would block a print of a document awaiting its number without explaining why, and
-- the old link (/d/<token>, which reads documents directly) would still show a document awaiting its number.
-- Runs after 3100 (Dream Finance), 3600 (commerce finance), 4600 (locations), 5100 (journal entries) and 6800 (stage 1) — it stops at the top without them.
-- The word `delete` is in it (triggers "before update or delete" and the Storage guard; no `delete` statement, no `drop` but in
-- the rollback notes at the end).

do $$
begin
  if to_regclass('public.documents') is null or to_regclass('public.tax_allocation_rules') is null or to_regclass('public.tax_allocations') is null
     or to_regprocedure('public.finance_log(uuid, text, text, text, jsonb)') is null or to_regprocedure('public.finance_append_only()') is null
     or to_regprocedure('public.finance_business_ids()') is null or to_regprocedure('public.entity_charges_vat(text)') is null then
    raise exception 'migration 20261126006900 runs after 20261004003100 (Dream Finance) — run it first; nothing was changed';
  end if;
  if to_regprocedure('public.can_write()') is null or to_regprocedure('public.my_access()') is null
     or to_regprocedure('public.business_is_active(uuid)') is null or to_regprocedure('public.calendar_member()') is null then
    raise exception 'migration 20261126006900 runs after 20261005003200 (pilot hardening) and 20261028006000 (calendar access) — run them first; nothing was changed';
  end if;
  if to_regprocedure('public.location_filter()') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'documents' and column_name = 'location_id') then
    raise exception 'migration 20261126006900 runs after 20261010004600 (locations) — run it first; nothing was changed';
  end if;
  if to_regclass('public.journal_entries') is null or to_regprocedure('public.finance_summary(date, date)') is null then
    raise exception 'migration 20261126006900 runs after 20261011005100 (journal entries) — run it first; nothing was changed';
  end if;
  if to_regprocedure('public.documents_issue_day()') is null then
    raise exception 'migration 20261126006900 runs after 20261125006800 (the accountant''s answers, stage 1) — run it first; nothing was changed';
  end if;
  if to_regprocedure('public.sf_order_view(public.orders)') is null then
    raise exception 'migration 20261126006900 runs after 20261006003600 (commerce finance) — run it first; nothing was changed';
  end if;
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null or to_regprocedure('storage.foldername(text)') is null then
    raise exception 'migration 20261126006900 needs Supabase Storage (storage.buckets, storage.objects) — nothing was changed';
  end if;
end $$;

-- ============================================================================================================================
-- 1. the allocation-number rule — in the database only
-- ============================================================================================================================
-- the accountant (25.11.2026): a credit invoice too (answer 2), and from the threshold up — "5,000 ומעלה" (answer 3א). New
-- columns with their default (every rule, the four existing ones too); the old doc_types column stays as it was, unread.
alter table public.tax_allocation_rules add column if not exists required_doc_types int[] not null default '{305,320,330}';
alter table public.tax_allocation_rules add column if not exists threshold_inclusive boolean not null default true;
comment on column public.tax_allocation_rules.required_doc_types is
  'the document types that need an allocation number under this rule (2.119, the accountant 25.11.2026: 305, 320 and 330). doc_types is the reading before 2.119 — not read any more.';
comment on column public.tax_allocation_rules.threshold_inclusive is
  'true: from the threshold up (amount before VAT >= threshold — the accountant 25.11.2026, "5,000 ומעלה"); false: above it only.';

-- the rule in force on a day: the latest that started on or before it (no rule — all its fields null)
create or replace function public.allocation_rule_on(p_date date) returns public.tax_allocation_rules
language sql stable set search_path = public as $$
  select r.* from public.tax_allocation_rules r where r.effective_from <= p_date order by r.effective_from desc limit 1;
$$;

-- does this document need an allocation number? (the one place of the rule; the screens read it from here)
-- Security invoker: the business's settings (only when the document carries no issuer snapshot) are read under the caller's RLS.
create or replace function public.allocation_required(d public.documents) returns boolean
language plpgsql stable set search_path = public as $$
declare r public.tax_allocation_rules; ent text;
begin
  if d.id is null or d.doc_type is null or d.doc_date is null then return false; end if;
  -- a private customer never needs one (answer 1): only a customer with a dealer number
  if coalesce(d.customer_dealer, '') !~ '^[0-9]{9}$' then return false; end if;
  ent := coalesce(d.issuer->>'entityType',
                  (select public.entity_of(s.entity_type, s.business_type) from public.register_settings s where s.business_id = d.business_id),
                  'licensed_dealer');
  if not public.entity_charges_vat(ent) then return false; end if;
  r := public.allocation_rule_on(d.doc_date);
  if r.version is null or not (d.doc_type = any (coalesce(r.required_doc_types, '{}'))) then return false; end if;
  return case when coalesce(r.threshold_inclusive, true) then abs(d.after_discount) >= r.threshold_before_vat
              else abs(d.after_discount) > r.threshold_before_vat end;
end $$;

-- the document's real allocation number (approved by the gateway or entered by hand — never a test number), or null
create or replace function public.allocation_number_of(p_document uuid) returns text
language sql stable set search_path = public as $$
  select a.allocation_number from public.tax_allocations a
   where a.document_id = p_document and a.status in ('approved', 'manual') and not a.is_test
   order by a.created_at limit 1;
$$;

-- needs a number and has none yet: may not reach the customer
create or replace function public.allocation_awaiting(d public.documents) returns boolean
language sql stable set search_path = public as $$
  select public.allocation_required(d) and public.allocation_number_of(d.id) is null;
$$;

revoke execute on function public.allocation_rule_on(date), public.allocation_required(public.documents), public.allocation_number_of(uuid),
  public.allocation_awaiting(public.documents) from public, anon;
grant execute on function public.allocation_rule_on(date), public.allocation_required(public.documents), public.allocation_number_of(uuid),
  public.allocation_awaiting(public.documents) to authenticated, service_role;

-- every document with what the rule says, for the lists (security invoker: the caller's RLS of documents and tax_allocations)
create or replace view public.document_allocation_status with (security_invoker = true) as
  select d.id as document_id, d.business_id, d.doc_type, d.doc_number, d.doc_date, d.customer_dealer, d.after_discount,
         public.allocation_required(d) as required, public.allocation_number_of(d.id) as allocation_number,
         public.allocation_required(d) and public.allocation_number_of(d.id) is null as awaiting,
         (public.allocation_rule_on(d.doc_date)).version as rule_version,
         (public.allocation_rule_on(d.doc_date)).threshold_before_vat as threshold_before_vat
    from public.documents d;
revoke all on public.document_allocation_status from anon;
revoke insert, update, delete, truncate on public.document_allocation_status from authenticated;
grant select on public.document_allocation_status to authenticated, service_role;

-- a print counted the old way (the screens' update of print_count) — not while the document waits for its number
-- (security definer: the allocation is read whoever prints — a cashier sees no tax_allocations; f_ runs after a_gate_caller)
create or replace function public.documents_print_allocation() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.print_count > old.print_count and public.allocation_awaiting(new) then
    raise exception 'awaiting_allocation: המסמך דורש מספר הקצאה — הוא נמסר ללקוח (הדפסה, קישור, שליחה) רק אחרי שהמספר התקבל'
      using errcode = '55000';
  end if;
  return new;
end $$;
revoke execute on function public.documents_print_allocation() from public, anon, authenticated;
create or replace trigger f_documents_print_allocation before update of print_count on public.documents
  for each row execute function public.documents_print_allocation();

-- ============================================================================================================================
-- 3. the deliveries: the first is the original, every later one a true copy
-- ============================================================================================================================
create table if not exists public.document_deliveries (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses on delete restrict,
  document_id uuid not null references public.documents on delete restrict,
  location_id uuid,                                   -- the document's (null = the main location, as on documents)
  channel     text not null check (channel in ('link', 'pdf', 'storefront', 'print', 'email', 'whatsapp')),
  is_original boolean not null,                       -- the first delivery of the document ("מקור")
  user_id     uuid references auth.users on delete set null,   -- who in the business delivered it (null: the customer's link)
  created_at  timestamptz not null default now()
);
create index if not exists document_deliveries_document_idx on public.document_deliveries (document_id, created_at);
create index if not exists document_deliveries_business_idx on public.document_deliveries (business_id, created_at desc);
create unique index if not exists document_deliveries_one_original_uq on public.document_deliveries (document_id) where is_original;

-- the delivered PDF, as it was delivered (answer 6 נוסף): one file per delivery, in the bucket delivered-documents
create table if not exists public.document_delivery_files (
  delivery_id uuid primary key references public.document_deliveries on delete restrict,
  business_id uuid not null references public.businesses on delete restrict,
  document_id uuid not null references public.documents on delete restrict,
  location_id uuid,
  bucket      text not null default 'delivered-documents' check (bucket = 'delivered-documents'),
  object_path text not null unique check (length(object_path) <= 200),
  sha256      text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  bytes       bigint not null check (bytes > 0),
  created_at  timestamptz not null default now()
);
create index if not exists document_delivery_files_document_idx on public.document_delivery_files (document_id);

-- never changed, never removed (a row of the history of the document)
create or replace trigger document_deliveries_append_only before update or delete on public.document_deliveries
  for each row execute function public.finance_append_only();
create or replace trigger document_delivery_files_append_only before update or delete on public.document_delivery_files
  for each row execute function public.finance_append_only();
create or replace trigger document_deliveries_no_truncate before truncate on public.document_deliveries
  for each statement execute function public.finance_append_only();
create or replace trigger document_delivery_files_no_truncate before truncate on public.document_delivery_files
  for each statement execute function public.finance_append_only();

-- read by a finance member of the business (never a cashier, never another business, the location picked at the top); no
-- browser role writes them — only the functions below
do $$
declare
  t text;
  gate        constant text := 'business_id = (select public.current_business_id()) and business_id in (select public.accessible_business_ids())';
  fin         constant text := 'business_id in (select public.finance_business_ids())';
  full_access constant text := '(select public.my_access()) <> ''register''';
  locs        constant text := '(select public.location_filter()) is null or coalesce(location_id, business_id) = any ((select public.location_filter())::uuid[])';
begin
  foreach t in array array['document_deliveries', 'document_delivery_files'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate on public.%I from public, authenticated', t);
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
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_calendar_only') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (not (select public.calendar_member())) with check (not (select public.calendar_member()))', t || '_calendar_only', t);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_location_gate') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)', t || '_location_gate', t, locs, locs);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_business_read') then
      execute format('create policy %I on public.%I for select to authenticated using (%s)', t || '_business_read', t, gate);
    end if;
  end loop;
end $$;

-- may the signed-in caller see this document? The same as the RLS of documents (the business worked in, its money open to the
-- caller, not "calendar only", the location picked at the top; a cashier — their own documents of today). Internal.
create or replace function public.document_visible(d public.documents) returns boolean
language sql stable security definer set search_path = public as $$
  select d.id is not null and auth.uid() is not null
     and d.business_id = public.current_business_id()
     and d.business_id in (select public.accessible_business_ids())
     and d.business_id in (select public.finance_business_ids())
     and not public.calendar_member()
     and (public.my_access() <> 'register' or (d.user_id = auth.uid() and d.issued_at >= public.il_day_start()))
     and (public.location_filter() is null or coalesce(d.location_id, d.business_id) = any (public.location_filter()));
$$;

-- record one delivery of a locked document row (the caller holds "for update" on it). Internal.
create or replace function public.document_delivery_add(d public.documents, p_channel text, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare original boolean; new_id uuid := gen_random_uuid(); at timestamptz := now(); pc int := d.print_count;
begin
  -- the first delivery is the original; a document printed before 2.119 (print_count > 0) was already delivered once
  original := d.print_count = 0 and not exists (select 1 from public.document_deliveries v where v.document_id = d.id);
  insert into public.document_deliveries (id, business_id, document_id, location_id, channel, is_original, user_id, created_at)
  values (new_id, d.business_id, d.id, d.location_id, p_channel, original, p_user, at);
  if p_channel = 'print' then
    -- the print counter moves with it (documents_after_print logs "document.printed", as before)
    update public.documents set print_count = print_count + 1 where id = d.id returning print_count into pc;
  else
    perform public.finance_log(d.business_id, 'document.delivered', 'documents', d.id::text,
      jsonb_build_object('type', d.doc_type, 'number', d.doc_number, 'channel', p_channel, 'original', original, 'delivery', new_id));
  end if;
  return jsonb_build_object('ok', true, 'delivery_id', new_id, 'document_id', d.id, 'business_id', d.business_id, 'channel', p_channel,
    'original', original, 'mark', case when original then 'מקור' else 'העתק נאמן למקור' end, 'at', at, 'print_count', pc,
    'file_path', d.business_id::text || '/' || d.id::text || '/' || new_id::text || '.pdf');
end $$;

-- THE customer's way to a document by its link (/d/<token>, its PDF, the storefront's copy) — the server only (service_role).
-- Answers: not_found (no such link) / unavailable (the business is locked) / awaiting_allocation (it needs an allocation number
-- and has none yet — nothing is recorded, and nothing of the document is told) / ok, with the delivery recorded and whether it is
-- the original. The server then reads the document by the returned id and prints the returned mark.
create or replace function public.document_share_open(p_token text, p_channel text default 'link') returns jsonb
language plpgsql security definer set search_path = public as $$
declare d public.documents;
begin
  if coalesce(p_channel, '') not in ('link', 'pdf', 'storefront') then raise exception 'delivery_channel: link, pdf or storefront' using errcode = '22023'; end if;
  if coalesce(p_token, '') !~ '^[a-f0-9]{64}$' then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  select * into d from public.documents where share_token = p_token for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  if not public.business_is_active(d.business_id) then return jsonb_build_object('ok', false, 'code', 'unavailable'); end if;
  if public.allocation_awaiting(d) then return jsonb_build_object('ok', false, 'code', 'awaiting_allocation'); end if;
  return public.document_delivery_add(d, p_channel, null);
end $$;

-- a delivery from the app: printed, sent by mail / WhatsApp, its PDF handed over — whoever may print the document (a cashier:
-- their own of today), never a viewer. Refused while it waits for its allocation number.
create or replace function public.document_delivery_record(p_document uuid, p_channel text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d public.documents;
begin
  if coalesce(p_channel, '') not in ('print', 'email', 'whatsapp', 'pdf') then raise exception 'delivery_channel: print, email, whatsapp or pdf' using errcode = '22023'; end if;
  select * into d from public.documents where id = p_document for update;
  if not found or not public.document_visible(d) then raise exception 'not allowed' using errcode = '42501'; end if;
  if not public.can_write() then raise exception 'not allowed: read-only role' using errcode = '42501'; end if;
  if public.allocation_awaiting(d) then
    raise exception 'awaiting_allocation: המסמך דורש מספר הקצאה — הוא נמסר ללקוח (הדפסה, קישור, שליחה) רק אחרי שהמספר התקבל'
      using errcode = '55000';
  end if;
  return public.document_delivery_add(d, p_channel, auth.uid());
end $$;

-- what a screen needs before it delivers (a window opens on the tap — ask before): the allocation rule's answer and the
-- deliveries so far. Whoever may see the document.
create or replace function public.document_delivery_state(p_document uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare d public.documents; r public.tax_allocation_rules; num text; manual boolean; req boolean; o public.document_deliveries;
begin
  select * into d from public.documents where id = p_document;
  if not found or not public.document_visible(d) then raise exception 'not allowed' using errcode = '42501'; end if;
  r := public.allocation_rule_on(d.doc_date);
  req := public.allocation_required(d);
  select a.allocation_number, a.status = 'manual' into num, manual from public.tax_allocations a
   where a.document_id = d.id and a.status in ('approved', 'manual') and not a.is_test order by a.created_at limit 1;
  select * into o from public.document_deliveries v where v.document_id = d.id and v.is_original;
  return jsonb_build_object(
    'allocation', jsonb_build_object('required', req, 'awaiting', req and num is null, 'number', num, 'manual', coalesce(manual, false),
      'rule', case when r.version is null then null else jsonb_build_object('version', r.version, 'effectiveFrom', r.effective_from,
        'threshold', r.threshold_before_vat, 'inclusive', r.threshold_inclusive, 'docTypes', to_jsonb(r.required_doc_types), 'verified', r.verified) end),
    'delivered', o.id is not null or d.print_count > 0,
    'original', case when o.id is null then null else jsonb_build_object('at', o.created_at, 'channel', o.channel) end,
    'deliveries', (select count(*) from public.document_deliveries v where v.document_id = d.id),
    'printCount', d.print_count);
end $$;

-- the delivered PDF, after the server uploaded it to <business>/<document>/<delivery>.pdf in delivered-documents — the server only
create or replace function public.document_delivery_file_add(p_delivery uuid, p_sha256 text, p_bytes bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v public.document_deliveries; path text;
begin
  select * into v from public.document_deliveries where id = p_delivery;
  if not found then raise exception 'delivery_not_found' using errcode = 'P0002'; end if;
  if coalesce(p_sha256, '') !~ '^[0-9a-f]{64}$' or coalesce(p_bytes, 0) <= 0 then raise exception 'delivery_file: sha256 (64 hex) and the size' using errcode = '22023'; end if;
  path := v.business_id::text || '/' || v.document_id::text || '/' || v.id::text || '.pdf';
  if exists (select 1 from public.document_delivery_files f where f.delivery_id = v.id) then
    if exists (select 1 from public.document_delivery_files f where f.delivery_id = v.id and f.sha256 = p_sha256) then
      return jsonb_build_object('ok', true, 'object_path', path, 'created', false);
    end if;
    raise exception 'delivery_file_exists: the delivered file is kept as it was' using errcode = '23505';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'delivered-documents' and o.name = path) then
    raise exception 'delivery_file_missing: upload % first', path using errcode = 'P0002';
  end if;
  insert into public.document_delivery_files (delivery_id, business_id, document_id, location_id, object_path, sha256, bytes)
  values (v.id, v.business_id, v.document_id, v.location_id, path, p_sha256, p_bytes);
  return jsonb_build_object('ok', true, 'object_path', path, 'created', true);
end $$;

revoke execute on function public.document_visible(public.documents), public.document_delivery_add(public.documents, text, uuid),
  public.document_share_open(text, text), public.document_delivery_record(uuid, text), public.document_delivery_state(uuid),
  public.document_delivery_file_add(uuid, text, bigint) from public, anon, authenticated;
grant execute on function public.document_share_open(text, text), public.document_delivery_file_add(uuid, text, bigint) to service_role;
grant execute on function public.document_delivery_record(uuid, text), public.document_delivery_state(uuid) to authenticated;

-- ============================================================================================================================
-- 5. backups: monthly (12 months) and yearly (7 years) — the server only
-- ============================================================================================================================
create table if not exists public.backup_runs (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('monthly', 'yearly')),
  period      text not null,                                   -- monthly 'YYYY-MM', yearly 'YYYY' (a period that is over)
  business_id uuid references public.businesses on delete restrict,   -- null: every business in one file
  status      text not null default 'running' check (status in ('running', 'ok', 'failed', 'expired')),
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  object_path text not null unique check (length(object_path) <= 200),   -- in the bucket backups
  sha256      text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  bytes       bigint check (bytes is null or bytes > 0),
  row_counts  jsonb check (row_counts is null or jsonb_typeof(row_counts) = 'object'),   -- {"documents": 725, …}
  error       text not null default '' check (length(error) <= 500),
  keep_until  date,                                            -- set when it is ok: 12 months (monthly) / 7 years (yearly)
  expired_at  timestamptz,
  check ((kind = 'monthly' and period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$') or (kind = 'yearly' and period ~ '^[0-9]{4}$')),
  check (status <> 'ok' or (finished_at is not null and sha256 is not null and bytes is not null and row_counts is not null and keep_until is not null)),
  check (status <> 'expired' or (expired_at is not null and keep_until is not null)),
  check (status <> 'failed' or finished_at is not null)
);
-- one copy of a period per scope (a failed or expired run does not count — the period is tried again)
create unique index if not exists backup_runs_period_uq on public.backup_runs
  (kind, period, coalesce(business_id, '00000000-0000-0000-0000-000000000000'::uuid)) where status in ('running', 'ok');
create index if not exists backup_runs_status_idx on public.backup_runs (status, keep_until);

-- a run only moves forward: running → ok / failed; ok → expired (only after its keep_until). Nothing else changes, nothing is removed.
create or replace function public.backup_runs_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then raise exception 'backup_runs is append-only' using errcode = '42501'; end if;
  if (new.id, new.kind, new.period, new.business_id, new.started_at, new.object_path)
     is distinct from (old.id, old.kind, old.period, old.business_id, old.started_at, old.object_path) then
    raise exception 'backup_runs: a run keeps what it is' using errcode = '42501';
  end if;
  if old.status = 'running' and new.status in ('ok', 'failed') and new.expired_at is null then return new; end if;
  if old.status = 'ok' and new.status = 'expired'
     and (new.finished_at, new.sha256, new.bytes, new.row_counts, new.error, new.keep_until)
         is not distinct from (old.finished_at, old.sha256, old.bytes, old.row_counts, old.error, old.keep_until)
     and old.keep_until <= public.il_today() then
    return new;
  end if;
  raise exception 'backup_runs: % → % is not allowed', old.status, new.status using errcode = '42501';
end $$;
revoke execute on function public.backup_runs_guard() from public, anon, authenticated;
create or replace trigger backup_runs_guard before update or delete on public.backup_runs for each row execute function public.backup_runs_guard();
create or replace trigger backup_runs_no_truncate before truncate on public.backup_runs for each statement execute function public.finance_append_only();

-- the server's table: RLS on, no policy, no browser role at all
alter table public.backup_runs enable row level security;
revoke all on public.backup_runs from public, anon, authenticated;

-- the tables in a backup: every financial / legal record of a business (and the allocation rules, the same for all). Never a
-- secret: no payment_accounts (terminal keys), no tax_authority_connections (tokens), no member or login data.
create or replace function public.backup_tables() returns text[]
language sql immutable set search_path = public as $$
  select array['businesses', 'register_settings', 'business_finance_profile', 'business_locations', 'registers',
               'documents', 'document_cancellations', 'tax_allocations', 'tax_allocation_rules', 'document_deliveries', 'document_delivery_files',
               'payments', 'sales', 'sale_refunds', 'register_shifts', 'expenses', 'quotes', 'journal_entries',
               'finance_period_locks', 'finance_counters', 'finance_audit_log',
               'payment_plans', 'payment_plan_items', 'payment_requests', 'recurring_plans', 'recurring_charges',
               'client_packages', 'client_package_uses',
               'bank_statements', 'bank_lines', 'bank_matches', 'bank_deposits', 'bank_deposit_cheques']::text[];
$$;

-- the businesses to back up (every one — a locked business still keeps its books)
create or replace function public.backup_businesses() returns setof uuid
language sql stable security definer set search_path = public as $$
  select b.id from public.businesses b order by b.created_at, b.id;
$$;

-- one page of one table of one business, in a fixed order (its primary key): {table, offset, count, total, more, rows}
create or replace function public.backup_export(p_business uuid, p_table text, p_offset int default 0, p_limit int default 5000) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare ord text; filt text; res jsonb; n int; total bigint;
begin
  if p_table is null or not (p_table = any (public.backup_tables())) then raise exception 'backup_table: not a table of the backup' using errcode = '22023'; end if;
  if p_offset is null or p_offset < 0 or p_limit is null or p_limit < 1 or p_limit > 10000 then
    raise exception 'backup_page: offset >= 0, limit 1 to 10000' using errcode = '22023'; end if;
  if p_table <> 'tax_allocation_rules' and (p_business is null or not exists (select 1 from public.businesses b where b.id = p_business)) then
    raise exception 'backup_business: no such business' using errcode = 'P0002'; end if;
  if to_regclass('public.' || p_table) is null then
    return jsonb_build_object('table', p_table, 'offset', p_offset, 'count', 0, 'total', 0, 'more', false, 'missing', true, 'rows', '[]'::jsonb);
  end if;
  select string_agg(format('x.%I', a.attname), ', ' order by array_position(i.indkey::int2[], a.attnum)) into ord
    from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey::int2[])
   where i.indrelid = ('public.' || p_table)::regclass and i.indisprimary;
  ord := coalesce(ord, 'x::text');
  filt := case p_table when 'businesses' then 'x.id = $1' when 'tax_allocation_rules' then 'true' else 'x.business_id = $1' end;
  execute format('select count(*) from public.%I x where %s', p_table, filt) into total using p_business;
  execute format('select coalesce(jsonb_agg(to_jsonb(x) order by %s), ''[]''::jsonb), count(*) from (select x.* from public.%I x where %s order by %s offset $2 limit $3) x',
                 ord, p_table, filt, ord) into res, n using p_business, p_offset, p_limit;
  return jsonb_build_object('table', p_table, 'offset', p_offset, 'count', n, 'total', total, 'more', p_offset + n < total, 'rows', res);
end $$;

-- the end of a period (the first day after it)
create or replace function public.backup_period_end(p_kind text, p_period text) returns date
language sql immutable set search_path = public as $$
  select case p_kind when 'monthly' then ((p_period || '-01')::date + interval '1 month')::date
                     when 'yearly'  then ((p_period || '-01-01')::date + interval '1 year')::date end;
$$;

-- start a run: {id, object_path, created}. The same period and scope again — the run there is (a stuck one, 6 hours old, failed)
create or replace function public.backup_run_start(p_kind text, p_period text, p_business uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.backup_runs; new_id uuid := gen_random_uuid(); path text;
begin
  if coalesce(p_kind, '') not in ('monthly', 'yearly')
     or (p_kind = 'monthly' and coalesce(p_period, '') !~ '^[0-9]{4}-(0[1-9]|1[0-2])$') or (p_kind = 'yearly' and coalesce(p_period, '') !~ '^[0-9]{4}$') then
    raise exception 'backup_period: monthly YYYY-MM, yearly YYYY' using errcode = '22023'; end if;
  if public.backup_period_end(p_kind, p_period) > public.il_today() then
    raise exception 'backup_period_open: % % is not over yet', p_kind, p_period using errcode = '22023'; end if;
  if p_business is not null and not exists (select 1 from public.businesses b where b.id = p_business) then
    raise exception 'backup_business: no such business' using errcode = 'P0002'; end if;
  perform pg_advisory_xact_lock(hashtextextended('backup:' || p_kind || ':' || p_period || ':' || coalesce(p_business::text, 'all'), 0));
  update public.backup_runs set status = 'failed', finished_at = now(), error = 'timeout: no answer within 6 hours'
   where kind = p_kind and period = p_period and business_id is not distinct from p_business and status = 'running' and started_at < now() - interval '6 hours';
  select * into r from public.backup_runs
   where kind = p_kind and period = p_period and business_id is not distinct from p_business and status in ('running', 'ok');
  if found then return jsonb_build_object('id', r.id, 'object_path', r.object_path, 'status', r.status, 'created', false); end if;
  path := coalesce(p_business::text, 'all') || '/' || p_kind || '/' || p_period || '/' || new_id::text || '.json.gz';
  insert into public.backup_runs (id, kind, period, business_id, object_path) values (new_id, p_kind, p_period, p_business, path);
  return jsonb_build_object('id', new_id, 'object_path', path, 'status', 'running', 'created', true);
end $$;

-- the file is in the bucket: the run is ok, kept until 12 months / 7 years after the later of the period's end and today
create or replace function public.backup_run_finish(p_run uuid, p_sha256 text, p_bytes bigint, p_counts jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.backup_runs; keep date;
begin
  select * into r from public.backup_runs where id = p_run for update;
  if not found then raise exception 'backup_run_not_found' using errcode = 'P0002'; end if;
  if r.status <> 'running' then raise exception 'backup_run_not_running: %', r.status using errcode = '55000'; end if;
  if coalesce(p_sha256, '') !~ '^[0-9a-f]{64}$' or coalesce(p_bytes, 0) <= 0 or p_counts is null or jsonb_typeof(p_counts) <> 'object' then
    raise exception 'backup_run_finish: sha256 (64 hex), the size and the row counts' using errcode = '22023'; end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'backups' and o.name = r.object_path) then
    raise exception 'backup_file_missing: upload % first', r.object_path using errcode = 'P0002'; end if;
  keep := (greatest(public.backup_period_end(r.kind, r.period), public.il_today())
           + case r.kind when 'monthly' then interval '12 months' else interval '7 years' end)::date;
  update public.backup_runs set status = 'ok', finished_at = now(), sha256 = p_sha256, bytes = p_bytes, row_counts = p_counts, keep_until = keep
   where id = r.id;
  return jsonb_build_object('id', r.id, 'status', 'ok', 'keep_until', keep, 'object_path', r.object_path);
end $$;

create or replace function public.backup_run_fail(p_run uuid, p_error text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.backup_runs;
begin
  select * into r from public.backup_runs where id = p_run for update;
  if not found then raise exception 'backup_run_not_found' using errcode = 'P0002'; end if;
  if r.status <> 'running' then return jsonb_build_object('id', r.id, 'status', r.status, 'changed', false); end if;
  update public.backup_runs set status = 'failed', finished_at = now(), error = left(coalesce(nullif(btrim(p_error), ''), 'failed'), 500) where id = r.id;
  return jsonb_build_object('id', r.id, 'status', 'failed', 'changed', true, 'object_path', r.object_path);
end $$;

-- may this copy go? ok, past its keep_until, and (monthly) a later yearly copy of the same scope is ok — never a gap
create or replace function public.backup_may_expire(r public.backup_runs) returns boolean
language sql stable set search_path = public as $$
  select r.status = 'ok' and r.keep_until is not null and r.keep_until <= public.il_today()
     and (r.kind = 'yearly' or exists (select 1 from public.backup_runs y
            where y.kind = 'yearly' and y.status = 'ok' and y.business_id is not distinct from r.business_id
              and y.period >= left(r.period, 4) and y.finished_at > r.finished_at));
$$;

-- the copies that may go now: [{id, kind, period, business_id, object_path, keep_until}]
create or replace function public.backup_expirable() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'kind', r.kind, 'period', r.period, 'business_id', r.business_id,
           'object_path', r.object_path, 'keep_until', r.keep_until) order by r.keep_until, r.id), '[]'::jsonb)
    from public.backup_runs r where public.backup_may_expire(r);
$$;

-- the one way a copy goes: refuses anything younger than its retention. Then (only then) the server removes the file from Storage.
create or replace function public.backup_expire(p_run uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.backup_runs;
begin
  select * into r from public.backup_runs where id = p_run for update;
  if not found then raise exception 'backup_run_not_found' using errcode = 'P0002'; end if;
  if r.status = 'expired' then return jsonb_build_object('id', r.id, 'object_path', r.object_path, 'changed', false); end if;
  if not public.backup_may_expire(r) then
    raise exception 'backup_retention: % % is kept until % (and a monthly copy until a later yearly copy is there)', r.kind, r.period, r.keep_until
      using errcode = '55000';
  end if;
  update public.backup_runs set status = 'expired', expired_at = now() where id = r.id;
  return jsonb_build_object('id', r.id, 'object_path', r.object_path, 'changed', true);
end $$;

revoke execute on function public.backup_tables(), public.backup_businesses(), public.backup_export(uuid, text, int, int),
  public.backup_period_end(text, text), public.backup_run_start(text, text, uuid), public.backup_run_finish(uuid, text, bigint, jsonb),
  public.backup_run_fail(uuid, text), public.backup_may_expire(public.backup_runs), public.backup_expirable(), public.backup_expire(uuid)
  from public, anon, authenticated;
grant execute on function public.backup_tables(), public.backup_businesses(), public.backup_export(uuid, text, int, int),
  public.backup_period_end(text, text), public.backup_run_start(text, text, uuid), public.backup_run_finish(uuid, text, bigint, jsonb),
  public.backup_run_fail(uuid, text), public.backup_expirable(), public.backup_expire(uuid) to service_role;
-- internal helpers: not even the server calls them directly
revoke execute on function public.document_visible(public.documents), public.document_delivery_add(public.documents, text, uuid),
  public.backup_may_expire(public.backup_runs) from service_role;

-- ============================================================================================================================
-- 4 + 5. Storage: delivered-documents (finance members read their own; the server writes) and backups (the server only)
-- ============================================================================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('delivered-documents', 'delivered-documents', false, 10485760, array['application/pdf'])
on conflict (id) do nothing;
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('backups', 'backups', false, null, array['application/gzip', 'application/json', 'application/octet-stream'])
on conflict (id) do nothing;
do $$
declare
  rule constant text := 'bucket_id = ''delivered-documents'' and (storage.foldername(name))[1] = (select public.current_business_id())::text'
    || ' and (select public.current_business_id()) in (select public.accessible_business_ids())'
    || ' and (select public.current_business_id()) in (select public.finance_business_ids())'
    || ' and (select public.my_access()) <> ''register'' and not (select public.calendar_member())';
begin
  -- a finance member of the business reads its delivered files (a short signed link from the server works as well)
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'delivered_documents_read') then
    execute format('create policy delivered_documents_read on storage.objects for select to authenticated using (%s)', rule);
  end if;
  -- whatever other policy says: nobody else reads them, and no browser role writes, replaces or removes them
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'delivered_documents_read_gate') then
    execute format('create policy delivered_documents_read_gate on storage.objects as restrictive for select to authenticated using (bucket_id <> ''delivered-documents'' or (%s))', rule);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'delivered_documents_anon_none') then
    create policy delivered_documents_anon_none on storage.objects as restrictive for all to anon
      using (bucket_id <> 'delivered-documents') with check (bucket_id <> 'delivered-documents');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'delivered_documents_no_insert') then
    create policy delivered_documents_no_insert on storage.objects as restrictive for insert to authenticated with check (bucket_id <> 'delivered-documents');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'delivered_documents_no_update') then
    create policy delivered_documents_no_update on storage.objects as restrictive for update to authenticated
      using (bucket_id <> 'delivered-documents') with check (bucket_id <> 'delivered-documents');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'delivered_documents_no_delete') then
    create policy delivered_documents_no_delete on storage.objects as restrictive for delete to authenticated using (bucket_id <> 'delivered-documents');
  end if;
  -- backups: no browser role at all (the server — service role — uploads and reads)
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'backups_server_only') then
    create policy backups_server_only on storage.objects as restrictive for all to anon, authenticated
      using (bucket_id <> 'backups') with check (bucket_id <> 'backups');
  end if;
end $$;

-- the files themselves, whoever asks (the service role too): a delivered PDF goes only to the path of a delivery recorded, a
-- backup only to the path of a running run; neither is replaced or moved; a delivered PDF is never removed, a backup only after
-- backup_expire (or when its run failed). Other buckets — untouched.
create or replace function public.storage_objects_keep() returns trigger
language plpgsql security definer set search_path = public as $$
declare same boolean;
begin
  if tg_op = 'INSERT' then
    if new.bucket_id = 'delivered-documents' and not exists (select 1 from public.document_deliveries v
         where new.name = v.business_id::text || '/' || v.document_id::text || '/' || v.id::text || '.pdf') then
      raise exception 'stored_file_path: a delivered document goes to <business>/<document>/<delivery>.pdf of a recorded delivery' using errcode = '42501';
    end if;
    if new.bucket_id = 'backups' and not exists (select 1 from public.backup_runs r where r.object_path = new.name and r.status = 'running') then
      raise exception 'stored_file_path: a backup goes to the path of a running backup run' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if old.bucket_id not in ('delivered-documents', 'backups') and new.bucket_id not in ('delivered-documents', 'backups') then return new; end if;
    -- only Storage's own bookkeeping of a file just written (its metadata filled once, the access time)
    same := (to_jsonb(new) - 'metadata' - 'user_metadata' - 'updated_at' - 'last_accessed_at' - 'path_tokens')
          = (to_jsonb(old) - 'metadata' - 'user_metadata' - 'updated_at' - 'last_accessed_at' - 'path_tokens');
    if same and (old.metadata is null or new.metadata is not distinct from old.metadata) then return new; end if;
    raise exception 'stored_file_locked: a delivered document or a backup is never replaced' using errcode = '42501';
  end if;
  -- DELETE
  if old.bucket_id = 'delivered-documents' then
    raise exception 'stored_file_locked: a delivered document is kept as it was delivered' using errcode = '42501';
  end if;
  if old.bucket_id = 'backups' and not exists (select 1 from public.backup_runs r where r.object_path = old.name and r.status in ('expired', 'failed')) then
    raise exception 'stored_file_locked: a backup is removed only after backup_expire' using errcode = '42501';
  end if;
  return old;
end $$;
revoke execute on function public.storage_objects_keep() from public, anon, authenticated, service_role;
do $$ begin
  begin
    create or replace trigger dp_storage_objects_keep before insert or update or delete on storage.objects
      for each row execute function public.storage_objects_keep();
  exception when insufficient_privilege then
    raise notice 'storage.objects: no trigger (the role is not its owner) — the policies still keep every browser role out of the two buckets; the server must never replace or remove their files';
  end;
end $$;

-- ============================================================================================================================
-- 1 (store). the order's page: whether its document waits for the allocation number
-- ============================================================================================================================
-- sf_order_view (20261006003600's): the same object, plus "doc_awaiting" (boolean; false when there is no document)
create or replace function public.sf_order_view(o public.orders) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', o.id, 'number', o.number, 'status', o.payment_status, 'test', o.is_test, 'currency', o.currency,
    'subtotal', trim_scale(o.subtotal), 'discount', trim_scale(o.discount), 'shipping', trim_scale(o.shipping), 'total', trim_scale(o.total),
    'coupon', o.coupon_code, 'method', o.delivery_method, 'name', o.customer_name, 'provider', o.provider, 'page', o.provider_page,
    'created_at', o.created_at, 'expires_at', o.expires_at, 'paid_at', o.paid_at,
    'fulfillment', o.fulfillment_status, 'tracking', o.tracking_number, 'tracking_url', o.tracking_url,
    'document', o.document_status, 'request', o.request_kind, 'refunded', trim_scale(o.refunded_total), 'state', o.state,
    'doc_token', (select d.share_token from public.documents d where d.id = o.document_id and d.business_id = o.business_id),
    -- 2.119: the document waits for its allocation number — the store shows "ממתין למספר הקצאה" instead of the link
    'doc_awaiting', coalesce((select public.allocation_awaiting(d) from public.documents d where d.id = o.document_id and d.business_id = o.business_id), false),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('name', x.name, 'variant', x.variant_label, 'qty', x.qty,
                                                           'price', trim_scale(x.unit_price), 'total', trim_scale(x.line_total), 'image', x.image_url)
                                        order by x.position) from public.order_lines x where x.order_id = o.id), '[]'::jsonb))
$$;
revoke execute on function public.sf_order_view(public.orders) from public, anon, authenticated;

-- ============================================================================================================================
-- 1 (end). the money summary: "allocationMissing" by the one rule
-- ============================================================================================================================
-- the money summary (20261011005100's): the same, but "allocationMissing" counts allocation_awaiting() — 305 / 320 / 330, from
-- the threshold up (the accountant, 25.11.2026)
create or replace function public.finance_summary(p_from date, p_to date) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  b uuid := public.current_business_id(); ent text; vat_on boolean; res jsonb; today date := public.il_today();
begin
  if b is null or (select public.my_access()) = 'register' or b not in (select public.finance_business_ids()) then
    raise exception 'not allowed' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 3700 then raise exception 'bad range' using errcode = '22023'; end if;
  select public.entity_of(s.entity_type, s.business_type) into ent from public.register_settings s where s.business_id = b;
  ent := coalesce(ent, 'licensed_dealer');
  vat_on := public.entity_charges_vat(ent);
  with d as (
    select doc.id, doc.doc_type, doc.doc_date, doc.after_discount, doc.vat_amount, doc.total, doc.customer_dealer,
           public.entity_charges_vat(coalesce(doc.issuer->>'entityType', ent)) as vat_doc,
           exists (select 1 from public.document_cancellations c where c.document_id = doc.id) as cancelled
      from public.documents doc where doc.business_id = b and doc.doc_date between p_from and p_to
  ), rev as (
    -- income: a VAT business by its tax invoices (305 / 320) less credit invoices (330); an exempt one by its receipts
    select coalesce(sum(case when vat_doc and doc_type in (305, 320) then after_discount when vat_doc and doc_type = 330 then -after_discount
                             when not vat_doc and doc_type = 400 and not cancelled then total else 0 end), 0) as net,
           coalesce(sum(case when vat_doc and doc_type in (305, 320) then vat_amount when vat_doc and doc_type = 330 then -vat_amount else 0 end), 0) as vat
      from d
  ), types as (
    select coalesce(jsonb_object_agg(doc_type::text, jsonb_build_object('count', n, 'total', t, 'cancelled', c)), '{}'::jsonb) as j
      from (select doc_type, count(*) n, sum(total) t, count(*) filter (where cancelled) c from d group by doc_type) x
  ), e as (
    -- 2.96 (T13א): a manual expense entry is in its kind of expense (its VAT on inputs, deductible as recorded) — not in the count
    select category, sum(net) as net, sum(vat) as vat, sum(deductible) as deductible, sum(total) as total, sum(n) as n from (
      select category,
             sum(case when supplier_doc_type = 'credit' then -amount_before_vat else amount_before_vat end) as net,
             sum(case when supplier_doc_type = 'credit' then -vat_amount else vat_amount end) as vat,
             sum((case when supplier_doc_type = 'credit' then -1 else 1 end) * (case when vat_on then round(vat_amount * vat_deductible_pct / 100, 2) else 0 end)) as deductible,
             sum(case when supplier_doc_type = 'credit' then -total else total end) as total, count(*) as n
        from public.expenses where business_id = b and status = 'confirmed' and doc_date between p_from and p_to group by category
      union all
      select je.category, sum(je.amount), sum(je.vat), sum(je.vat), sum(je.amount + je.vat), 0
        from public.journal_entries je where je.business_id = b and je.kind = 'expense' and je.entry_date between p_from and p_to group by je.category
    ) u group by category
  ), et as (
    select coalesce(sum(net), 0) net, coalesce(sum(vat), 0) vat, coalesce(sum(deductible), 0) deductible, coalesce(sum(total), 0) total, coalesce(sum(n), 0) n,
           coalesce(jsonb_agg(jsonb_build_object('category', category, 'net', net, 'vat', vat, 'total', total, 'count', n) order by total desc), '[]'::jsonb) as by_cat
      from e
  ), jr as (
    -- 2.96 (T13א): the manual entries of the period — income before VAT and its VAT on sales; VAT entries on sales or on inputs
    -- (the expenses are in "e" above); apart as "manual", so a screen can say how much of a number they are
    select coalesce(sum(amount) filter (where kind = 'income'), 0) as inc_net, coalesce(sum(vat) filter (where kind = 'income'), 0) as inc_vat,
           coalesce(sum(amount) filter (where kind = 'expense'), 0) as exp_net, coalesce(sum(vat) filter (where kind = 'expense'), 0) as exp_vat,
           coalesce(sum(vat) filter (where kind = 'vat' and vat_side = 'output'), 0) as vat_out,
           coalesce(sum(vat) filter (where kind = 'vat' and vat_side = 'input'), 0) as vat_in, count(*) as n
      from public.journal_entries where business_id = b and entry_date between p_from and p_to
  ), cash as (
    -- 2.94: tax withheld at source (a receipt's "ניכוי במקור") pays the invoice but is not money — out of in / out, on its own
    select coalesce(sum(amount) filter (where direction = 'in' and method <> 'withholding'), 0) as cin,
           coalesce(sum(amount) filter (where direction = 'out' and method <> 'withholding'), 0) as cout,
           coalesce(sum(case direction when 'in' then amount else -amount end) filter (where method = 'withholding'), 0) as withheld,
           coalesce((select jsonb_agg(jsonb_build_object('method', method, 'in', i, 'out', o) order by i desc)
                       from (select method, sum(amount) filter (where direction = 'in') i, sum(amount) filter (where direction = 'out') o
                               from public.payments where business_id = b and paid_on between p_from and p_to and method <> 'withholding'
                              group by method) m), '[]'::jsonb) as by_method
      from public.payments where business_id = b and paid_on between p_from and p_to
  ), recv as (
    -- open: every invoice's balance; overdue: the lines past their date (an invoice without a plan: its balance, as before)
    select coalesce(sum(balance) filter (where balance > 0), 0) as open, count(*) filter (where balance > 0) as n,
           coalesce((select sum(l.open_amount) from public.receivable_lines l where l.business_id = b and l.open_amount > 0 and l.due_date < today), 0) as overdue,
           (select count(distinct l.document_id) from public.receivable_lines l where l.business_id = b and l.open_amount > 0 and l.due_date < today) as overdue_n
      from public.receivables where business_id = b and not cancelled
  ), pend as (
    select count(*) n, coalesce(sum(total), 0) t from public.sales where business_id = b and status = 'pending'
  ), nodoc as (
    select count(*) n, coalesce(sum(s.total), 0) t from public.sales s
     where s.business_id = b and s.status = 'paid' and (coalesce(s.paid_at, s.created_at) at time zone 'Asia/Jerusalem')::date between p_from and p_to
       and not exists (select 1 from public.documents x where x.sale_id = s.id and x.doc_type in (305, 320, 400))
  ), alloc as (
    -- 2.119 (the accountant, answers 1, 2, 3א): one rule, in the database only — allocation_awaiting() (305 / 320 / 330 to a
    -- customer with a dealer number, from the threshold up, by the document's date, and no real number yet)
    select count(*) n from public.documents doc
     where doc.business_id = b and doc.doc_date between p_from and p_to and public.allocation_awaiting(doc)
  ), months as (
    select jsonb_agg(jsonb_build_object('month', to_char(m, 'YYYY-MM'),
             'revenue', (select coalesce(sum(case when vat_doc and doc_type in (305, 320) then after_discount when vat_doc and doc_type = 330 then -after_discount
                                                  when not vat_doc and doc_type = 400 and not cancelled then total else 0 end), 0)
                           from d where to_char(d.doc_date, 'YYYY-MM') = to_char(m, 'YYYY-MM'))
                        + (select coalesce(sum(je.amount), 0) from public.journal_entries je where je.business_id = b and je.kind = 'income'
                             and je.entry_date between p_from and p_to and to_char(je.entry_date, 'YYYY-MM') = to_char(m, 'YYYY-MM')),
             'expenses', (select coalesce(sum((case when supplier_doc_type = 'credit' then -1 else 1 end)
                                              * (amount_before_vat + vat_amount - case when vat_on then round(vat_amount * vat_deductible_pct / 100, 2) else 0 end)), 0)
                            from public.expenses x where x.business_id = b and x.status = 'confirmed' and x.doc_date between p_from and p_to
                              and to_char(x.doc_date, 'YYYY-MM') = to_char(m, 'YYYY-MM'))
                       + (select coalesce(sum(je.amount), 0) from public.journal_entries je where je.business_id = b and je.kind = 'expense'
                            and je.entry_date between p_from and p_to and to_char(je.entry_date, 'YYYY-MM') = to_char(m, 'YYYY-MM'))) order by m) as j
      from generate_series(date_trunc('month', p_from::timestamp), date_trunc('month', p_to::timestamp), interval '1 month') m
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'entity', ent, 'vat', vat_on,
    'revenue', jsonb_build_object('net', rev.net + jr.inc_net, 'vat', rev.vat + jr.inc_vat + jr.vat_out,
                                  'gross', rev.net + jr.inc_net + rev.vat + jr.inc_vat + jr.vat_out),
    'documents', types.j,
    'expenses', jsonb_build_object('net', et.net, 'vat', et.vat + jr.vat_in, 'vatDeductible', et.deductible + jr.vat_in, 'total', et.total,
                                   'count', et.n, 'byCategory', et.by_cat),
    'vatPayable', case when vat_on then (rev.vat + jr.inc_vat + jr.vat_out) - (et.deductible + jr.vat_in) else 0 end,
    'profit', (rev.net + jr.inc_net) - (et.net + et.vat - et.deductible),
    'manual', jsonb_build_object('count', jr.n, 'income', jsonb_build_object('net', jr.inc_net, 'vat', jr.inc_vat),
                                 'expense', jsonb_build_object('net', jr.exp_net, 'vat', jr.exp_vat),
                                 'vat', jsonb_build_object('output', jr.vat_out, 'input', jr.vat_in)),
    'cash', jsonb_build_object('in', cash.cin, 'out', cash.cout, 'net', cash.cin - cash.cout, 'byMethod', cash.by_method),
    'withheld', cash.withheld,
    'receivables', jsonb_build_object('open', recv.open, 'count', recv.n, 'overdue', recv.overdue, 'overdueCount', recv.overdue_n),
    'pending', jsonb_build_object('count', pend.n, 'total', pend.t),
    'posWithoutDocument', jsonb_build_object('count', nodoc.n, 'total', nodoc.t),
    'allocationMissing', alloc.n,
    'months', coalesce(months.j, '[]'::jsonb),
    'lockedUntil', public.finance_locked_until(b))
  into res from rev, types, et, jr, cash, recv, pend, nodoc, alloc, months;
  return res;
end $$;

-- (create or replace keeps its grants: authenticated and service_role, as before)

-- ============================================================================================================================
-- Rollback (by hand, in the SQL Editor, only if ever needed — the deliveries, their files and the backups are records: export
-- them first; a delivered file or a backup in Storage is removed from the dashboard, never by SQL):
--   drop trigger if exists dp_storage_objects_keep on storage.objects; drop function if exists public.storage_objects_keep();
--   drop policy delivered_documents_read, delivered_documents_read_gate, delivered_documents_anon_none, delivered_documents_no_insert,
--     delivered_documents_no_update, delivered_documents_no_delete, backups_server_only on storage.objects;
--     (the two buckets: empty them from the dashboard, then delete them)
--   drop function public.backup_expire(uuid), public.backup_expirable(), public.backup_may_expire(public.backup_runs),
--     public.backup_run_fail(uuid, text), public.backup_run_finish(uuid, text, bigint, jsonb), public.backup_run_start(text, text, uuid),
--     public.backup_period_end(text, text), public.backup_export(uuid, text, int, int), public.backup_businesses(), public.backup_tables();
--   drop table public.backup_runs;  (its trigger function: drop function public.backup_runs_guard();)
--   drop function public.document_delivery_file_add(uuid, text, bigint), public.document_delivery_state(uuid),
--     public.document_delivery_record(uuid, text), public.document_share_open(text, text),
--     public.document_delivery_add(public.documents, text, uuid), public.document_visible(public.documents);
--   drop table public.document_delivery_files, public.document_deliveries;
--   drop trigger f_documents_print_allocation on public.documents; drop function public.documents_print_allocation();
--   finance_summary: run section 3 of 20261011005100_journal_entries.sql again (its finance_summary only); sf_order_view: run
--   its definition in 20261006003600_commerce_finance.sql again (section 6); then
--   drop view public.document_allocation_status;
--   drop function public.allocation_awaiting(public.documents), public.allocation_number_of(uuid),
--     public.allocation_required(public.documents), public.allocation_rule_on(date);
--   alter table public.tax_allocation_rules drop column threshold_inclusive, drop column required_doc_types;
-- ============================================================================================================================
