-- 2.120.0 — the accountant's answers of 25.11.2026, stage 3: the database (tests/sql/cpa-rules-stage3.check.sql).
-- docs/ita-registration/CPA_ANSWERS_HE.md row 5 ("סדרת מספור לכל סניף") and row 18 ("הפקדות (420) נכנסות לקובץ, עם D120").
-- For NEW rows only: no issued document, payment, deposit or cancellation changes (nothing here updates or deletes a row of a
-- business — the columns added come empty; the one update is of business_locations.branch_code, empty, and only when the owner
-- switches — section 4).
-- Sources (the official 1.31 instructions, "הוראות להפקת קבצים במבנה אחיד" 1.31, 01/05/2009):
--   * clarification 3 (appendix 5.5, p. 21): a business with branches fills the branch id (fields 1231 C100, 1270 / 1272 D110,
--     1320 D120, 1374 B100, 1421 B110 — X(7), "כפי שמופיע ברישומי בית העסק") and field 1034 = 1 (A100 p. 10). Field 1272 is "the
--     branch of the BASE document" — a document is identified by type + number + branch: numbers may repeat between branches.
--   * §2.4ד (p. 6): a document number may carry series letters (up to 5) — allowed, not required. 1.31 says nothing about where a
--     series starts or how a branch's series is built; that is the owner's / the accountant's (open question in the report).
--   * appendix 1 (§5.1, p. 18): 420 "הפקדת בנק" is a document type of the software, as 300 / 400; §4.5 (p. 14) D120 is
--     "פרטי קבלה / הפקדה" — a line per payment means (cash, each cheque with bank / branch / account / number / due date);
--     §2.6ב (p. 9): the software reports, for every document type of appendix 1, how many and how much; C100 1228 "מסמך מבוטל".
--   1. (answer 5) numbering per location — ONE-WAY, by the owner: document_numbering_per_location() (a business with more than one
--      active location). From then on every new document is numbered in a series of its location and type (document_series),
--      and carries documents.series_location_id (null = the business's one series, every document before the switch). The
--      business's own series (document_counters) stops; a location's series starts after the last number the business's series
--      gave of that type (never a number that already exists), or at a higher number the owner sets before the series' first
--      document (document_series_start). Unique: (business, type, number) among the documents of the business's series,
--      (business, location, type, number) among a location's — replacing documents_business_number_uq (the same rows: every
--      document there is today is of the business's series). A business that never switches: the same numbers, the same way.
--      Each location gets a branch code (business_locations.branch_code, fields 1231 …) when the owner switches (the main
--      location 1, then 2, 3 … by their order) or when it is opened later; the owner may change a code (location_branch_code_set)
--      until the location's first document of its series.
--      Every place that finds a document by its type and number (the base of a credit / a refund receipt / a document made from an
--      order or a delivery note, and the documents made from it) now also says "of the business's series, or of this location":
--      location_fill (the base, never a guess — base_location_ambiguous), documents_validate, documents_more_checks,
--      documents_goods, document_cancellations_check, record_credit_refund, sale_refunds_receipts, paylink_create,
--      payment_plan_create, sf_paylink_page, and the views receivables and client_package_status. For a business that never
--      switches the condition is always true (series_location_id is null everywhere): the same answers.
--   2. (answer 18) a bank deposit is a document: bank_deposit_create also issues a 420 "הפקדת בנק" (documents, numbered, immutable,
--      documents.deposit_id = the deposit; no customer, no lines, no VAT; its payments = the D120 lines: the cash — method 1 — and
--      each cheque — method 2 — with its details from the receipt's payment), only when the business has its dealer number (a
--      deposit without one is recorded as before, with no document). bank_deposit_cancel cancels it (document_cancellations, the
--      same reason) — it is never cancelled any other way, and never issued any other way (dp.deposit_doc, local to the
--      transaction). It moves no money (not 320 / 400: no payments row) and no stock, and is not income. Deposits recorded before
--      this migration keep no document (not filled in).
-- Replaces (same signatures; md5 of prosrc — compare with the live database before running:
--   select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = '<function>'::regprocedure):
--   documents_before_insert()          of 20261004002000_business_id.sql        — old a359c23999aa55af4caed03c6c54490e
--   location_fill()                    of 20261010004600_locations.sql          — old 22c55035af64c141afcb7d8eadfe7aaf
--   documents_validate()               of 20261125006800_cpa_rules_stage1.sql   — old e5548d72677674ac2dabce186a7b479d
--   documents_more_checks()            of 20261005003200_pilot_hardening.sql    — old 1523ec252074219f805903d91252cda5
--   documents_goods()                  of 20261011005000_cash_bank_goods.sql    — old 0976839e50b7e53b54d49c6ddb9c9821
--   document_cancellations_check()     of 20261125006800_cpa_rules_stage1.sql   — old b53c444e7da9734db600da34097e13f3
--   record_credit_refund(uuid, text, numeric, date, text) of 20261005003200    — old b8dd29e2f253345846ea05489f297d53
--   sale_refunds_receipts()            of 20261125006800_cpa_rules_stage1.sql   — old 51d712c3663245ee727e26b78f05b257
--   paylink_create(uuid, uuid, text, uuid, numeric, int, text, text, uuid) of 20261010004300 — old e070b05711f04bf97a269483861cc012
--   sf_paylink_page(uuid, text, text)  of 20261010004300_payment_links.sql      — old 9a939834dc26b4140ab7f49efadda490
--   payment_plan_create(uuid, uuid, jsonb, text, boolean) of 20261010004400    — old 0b547d0854bef6f445efbb2fa1316a4a
--   bank_deposit_create(uuid, date, uuid, numeric, uuid[], text) of 20261011005000 — old 70d1de91696e64e7b9b444c6a30f52e2
--   bank_deposit_cancel(uuid, text)    of 20261011005000_cash_bank_goods.sql    — old 3ea735f01acc605d88036cdfce316a33
--   deposit_book(date, date)           of 20261011005000_cash_bank_goods.sql    — old 41dcaa7ad4711e6e5a3680d19b73cdf9
--   and the views receivables (3100) and client_package_status (4200) — the same columns.
-- Running 2000, 3200, 4200, 4300, 4400, 4600, 5000 or 6800 again after this one brings back an old function (numbering of one
-- series, a base found by its number only, a deposit without its document) — then run this one again.
-- Deploy order: THE CODE FIRST, then this migration: after it, a deposit issues a 420 that the old screens do not know (a list
-- would show a document with no name), and a business that switches needs the screens that send the base document's location.
-- It drops and adds again the checks documents_doc_type_check (+ 420) and documents_source_check (+ 'deposit'), and drops the
-- index documents_business_number_uq after the two that replace it are built — run it in the SQL Editor (the MCP stops on the
-- word drop). No `delete` statement (the word is in "on delete restrict", the triggers "before update or delete" and the
-- policies "_viewer_delete"; `drop` / `delete` otherwise only in the rollback notes at the end).
-- Runs after 4600 (locations), 5000 (deposits, the goods documents), 6800 (stage 1) and 6900 (stage 2) — it stops at the top
-- without them, changing nothing.

do $$
begin
  if to_regclass('public.documents') is null or to_regclass('public.document_counters') is null
     or to_regprocedure('public.documents_before_insert()') is null or to_regprocedure('public.finance_log(uuid, text, text, text, jsonb)') is null
     or to_regprocedure('public.finance_append_only()') is null or to_regprocedure('public.finance_guard()') is null
     or to_regprocedure('public.record_credit_refund(uuid, text, numeric, date, text)') is null or to_regprocedure('public.documents_more_checks()') is null then
    raise exception 'migration 20261127007000 runs after 20261004003100 (Dream Finance) and 20261005003200 (pilot hardening) — run them first; nothing was changed';
  end if;
  if to_regclass('public.client_package_status') is null
     or to_regprocedure('public.paylink_create(uuid, uuid, text, uuid, numeric, integer, text, text, uuid)') is null
     or to_regprocedure('public.sf_paylink_page(uuid, text, text)') is null
     or to_regprocedure('public.payment_plan_create(uuid, uuid, jsonb, text, boolean)') is null then
    raise exception 'migration 20261127007000 runs after 20261010004200, 4300 and 4400 (packages, payment links, plans) — run them first; nothing was changed';
  end if;
  if to_regclass('public.business_locations') is null or to_regprocedure('public.location_fill()') is null
     or to_regprocedure('public.location_owner()') is null or to_regprocedure('public.location_allowed(uuid, uuid)') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'documents' and column_name = 'location_id') then
    raise exception 'migration 20261127007000 runs after 20261010004600 (locations) — run it first; nothing was changed';
  end if;
  if to_regclass('public.bank_deposits') is null or to_regprocedure('public.documents_goods()') is null
     or to_regprocedure('public.bank_deposit_create(uuid, date, uuid, numeric, uuid[], text)') is null
     or to_regprocedure('public.bank_deposit_cancel(uuid, text)') is null or to_regprocedure('public.deposit_book(date, date)') is null then
    raise exception 'migration 20261127007000 runs after 20261011005000 (deposits, goods documents) — run it first; nothing was changed';
  end if;
  if to_regprocedure('public.documents_issue_day()') is null or to_regprocedure('public.sale_refunds_receipts()') is null then
    raise exception 'migration 20261127007000 runs after 20261125006800 (the accountant''s answers, stage 1) — run it first; nothing was changed';
  end if;
  if to_regprocedure('public.document_share_open(text, text)') is null or to_regprocedure('public.allocation_required(public.documents)') is null
     or to_regclass('public.document_deliveries') is null then
    raise exception 'migration 20261127007000 runs after 20261126006900 (the accountant''s answers, stage 2) — run it first; nothing was changed';
  end if;
end $$;

-- ============================================================================================================================
-- 1. the columns, the checks and the unique keys of documents
-- ============================================================================================================================
-- the location whose series numbered the document (7000); null = the business's one series — every document issued before
-- the business switched, and every document of a business that never does. Set by documents_number only.
alter table public.documents add column if not exists series_location_id uuid;
-- the deposit a 420 "הפקדת בנק" mirrors (7000); null on every other document
alter table public.documents add column if not exists deposit_id uuid references public.bank_deposits (id) on delete restrict;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'documents_series_location_fkey' and conrelid = 'public.documents'::regclass) then
    alter table public.documents add constraint documents_series_location_fkey
      foreign key (series_location_id, business_id) references public.business_locations (id, business_id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'documents_deposit_type_check' and conrelid = 'public.documents'::regclass) then
    alter table public.documents add constraint documents_deposit_type_check check ((deposit_id is not null) = (doc_type = 420));
  end if;
end $$;
-- 420 "הפקדת בנק" (1.31 appendix 1); source 'deposit'
alter table public.documents drop constraint if exists documents_doc_type_check;
alter table public.documents add constraint documents_doc_type_check check (doc_type in (100, 200, 210, 300, 305, 320, 330, 400, 420));
alter table public.documents drop constraint if exists documents_source_check;
alter table public.documents add constraint documents_source_check
  check (source is null or source in ('pos', 'direct', 'quote', 'refund', 'credit', 'receipt', 'deposit'));

-- one number per type in the business's series; one number per type in each location's series. Built before the old key goes
-- (every document there is today is of the business's series: the first index holds the same rows as the old one)
create unique index if not exists documents_number_business_uq on public.documents (business_id, doc_type, doc_number)
  where series_location_id is null;
create unique index if not exists documents_number_location_uq on public.documents (business_id, series_location_id, doc_type, doc_number)
  where series_location_id is not null;
drop index if exists public.documents_business_number_uq;
create unique index if not exists documents_deposit_uq on public.documents (deposit_id) where deposit_id is not null;

-- ============================================================================================================================
-- 2. numbering per location: the switch (one-way) and the series
-- ============================================================================================================================
-- a row = the business numbers per location, since then. Never changed, never removed.
create table if not exists public.document_numbering (
  business_id        uuid primary key references public.businesses on delete restrict,
  per_location_since timestamptz not null default now(),
  switched_by        uuid references auth.users on delete set null
);
-- a location's series of a document type: the first number (the owner's, or right after the business's series) and the last
create table if not exists public.document_series (
  business_id uuid not null references public.businesses on delete restrict,
  location_id uuid not null,
  doc_type    int  not null check (doc_type in (100, 200, 210, 300, 305, 320, 330, 400, 420)),
  start_no    bigint not null check (start_no between 1 and 999999999999),
  last_no     bigint not null check (last_no >= 0),
  updated_at  timestamptz not null default now(),
  primary key (business_id, location_id, doc_type),
  foreign key (location_id, business_id) references public.business_locations (id, business_id) on delete restrict
);
create or replace trigger document_numbering_append_only before update or delete on public.document_numbering
  for each row execute function public.finance_append_only();
create or replace trigger document_numbering_no_truncate before truncate on public.document_numbering
  for each statement execute function public.finance_append_only();
create or replace trigger document_series_no_delete before delete on public.document_series
  for each row execute function public.finance_append_only();
create or replace trigger document_series_no_truncate before truncate on public.document_series
  for each statement execute function public.finance_append_only();

-- read by a finance member of the business (never a cashier, never another business; a location's series — the locations the
-- person sees); no browser role writes them — only the functions below
do $$
declare
  t text;
  gate        constant text := 'business_id = (select public.current_business_id()) and business_id in (select public.accessible_business_ids())';
  fin         constant text := 'business_id in (select public.finance_business_ids())';
  full_access constant text := '(select public.my_access()) <> ''register''';
  locs        constant text := '(select public.location_filter()) is null or location_id = any ((select public.location_filter())::uuid[])';
begin
  foreach t in array array['document_numbering', 'document_series'] loop
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
    if t = 'document_series' and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_location_gate') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)', t || '_location_gate', t, locs, locs);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_business_read') then
      execute format('create policy %I on public.%I for select to authenticated using (%s)', t || '_business_read', t, gate);
    end if;
    -- 3200's rule for every business table (no browser role may write these at all — the grants above; this guards the same)
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_viewer_insert') then
      execute format('create policy %I on public.%I as restrictive for insert to authenticated with check ((select public.can_write()))', t || '_viewer_insert', t);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_viewer_update') then
      execute format('create policy %I on public.%I as restrictive for update to authenticated using ((select public.can_write())) with check ((select public.can_write()))', t || '_viewer_update', t);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_viewer_delete') then
      execute format('create policy %I on public.%I as restrictive for delete to authenticated using ((select public.can_write()))', t || '_viewer_delete', t);
    end if;
  end loop;
end $$;

-- ============================================================================================================================
-- 3. the branch code of a location (fields 1231, 1270, 1272, 1320, 1374, 1421 — X(7))
-- ============================================================================================================================
alter table public.business_locations add column if not exists branch_code text
  check (branch_code is null or branch_code ~ '^[0-9A-Za-z]{1,7}$');
create unique index if not exists business_locations_branch_code_uq on public.business_locations (business_id, upper(branch_code))
  where branch_code is not null;

-- the next free code of a business: the smallest number no location of it carries
create or replace function public.branch_code_next(p_business uuid) returns text
language sql stable security definer set search_path = public as $$
  select min(g)::text from generate_series(1, 10000) g
   where not exists (select 1 from public.business_locations l where l.business_id = p_business and upper(l.branch_code) = g::text);
$$;
revoke execute on function public.branch_code_next(uuid) from public, anon, authenticated;

-- a location opened after the business switched gets the next code; a code stays once the location numbered a document in its
-- series, and a business that numbers per location never loses one
create or replace function public.business_locations_branch_code() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    if new.branch_code is distinct from old.branch_code then
      if exists (select 1 from public.documents x where x.business_id = old.business_id and x.series_location_id = old.id) then
        raise exception 'branch_code_fixed: קוד הסניף נקבע — לסניף כבר יש מסמכים בסדרה שלו' using errcode = '23514'; end if;
      if new.branch_code is null and exists (select 1 from public.document_numbering n where n.business_id = new.business_id) then
        raise exception 'branch_code_required: בעסק שממספר לפי סניף לכל סניף יש קוד' using errcode = '23514'; end if;
    end if;
    return new;
  end if;
  if new.branch_code is null and exists (select 1 from public.document_numbering n where n.business_id = new.business_id) then
    new.branch_code := public.branch_code_next(new.business_id);
  end if;
  return new;
end $$;
revoke execute on function public.business_locations_branch_code() from public, anon, authenticated;
-- after b_business_locations_guard (which locks the business on insert: two locations at once never take the same code)
create or replace trigger c_business_locations_branch_code before insert or update on public.business_locations
  for each row execute function public.business_locations_branch_code();

-- ============================================================================================================================
-- 4. the numbering (documents_number) — replaces documents_before_insert() of 20261004002000
-- ============================================================================================================================
create or replace function public.documents_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare n bigint; loc uuid; floor_no bigint;
begin
  if new.business_id is null then raise exception 'a document must belong to a business'; end if;
  new.series_location_id := null;
  if exists (select 1 from public.document_numbering x where x.business_id = new.business_id) then
    -- 7000 (the accountant, answer 5): a series per location and type. The business's series stopped when it switched (no
    -- document of it is issued after — below): a location's numbers come after every number it gave of this type
    loc := coalesce(new.location_id, new.business_id);
    select c.last_no into floor_no from public.document_counters c where c.business_id = new.business_id and c.doc_type = new.doc_type;
    floor_no := coalesce(floor_no, 0);
    insert into public.document_series (business_id, location_id, doc_type, start_no, last_no)
    values (new.business_id, loc, new.doc_type, floor_no + 1, floor_no)
    on conflict (business_id, location_id, doc_type) do nothing;
    update public.document_series set last_no = greatest(last_no, start_no - 1, floor_no) + 1, updated_at = now()
     where business_id = new.business_id and location_id = loc and doc_type = new.doc_type returning last_no into n;
    new.series_location_id := loc;
  else
    insert into public.document_counters(user_id, business_id, doc_type, last_no) values (new.user_id, new.business_id, new.doc_type, 0)
      on conflict (business_id, doc_type) do nothing;
    update public.document_counters set last_no = last_no + 1
      where business_id = new.business_id and doc_type = new.doc_type returning last_no into n;
    -- the owner switched to a series per location while this document waited for the business's series (the switch holds every
    -- counter of the business): this number is not given — the whole statement goes back, nothing is lost; try again
    if exists (select 1 from public.document_numbering x where x.business_id = new.business_id) then
      raise exception 'numbering_switched: העסק עבר עכשיו למספור לפי סניף — מפיקים שוב' using errcode = '40001';
    end if;
  end if;
  new.doc_number := n;
  new.issued_at := now();
  new.print_count := 0;
  return new;
end $$;

-- ============================================================================================================================
-- 5. a document found by its type and number: of the business's series, or of the location (7000) — a business that never
--    switches: series_location_id is null on every document, every condition below is true, the same answers as before
-- ============================================================================================================================
-- the base document's location — replaces location_fill() of 20261010004600 (only its "documents" part changed)
CREATE OR REPLACE FUNCTION public.location_fill()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare loc uuid; rloc uuid; rb uuid; ractive boolean; nbase int; lbase text;
begin
  if tg_op = 'UPDATE' then
    if new.location_id is distinct from old.location_id then
      raise exception 'location_fixed: a row keeps its location' using errcode = '23514';
    end if;
    if tg_table_name in ('sales', 'register_shifts', 'sale_refunds') and to_jsonb(new) ->> 'register_id' is distinct from to_jsonb(old) ->> 'register_id' then
      raise exception 'location_fixed: a row keeps its register' using errcode = '23514';
    end if;
    return new;
  end if;
  if new.business_id is null then return new; end if;   -- the business's own checks refuse it

  -- a register decides its location (sales, shifts, refunds)
  if tg_table_name in ('sales', 'register_shifts', 'sale_refunds') then
    if tg_table_name = 'register_shifts' and new.register_id is null then
      -- a day opened before registers (an older screen): the location's first register, else the main one
      select r.id into new.register_id from public.registers r
       where r.business_id = new.business_id and r.active
         and r.location_id = coalesce(new.location_id, public.location_pick(new.business_id))
       order by (r.id = new.business_id) desc, r.sort, r.created_at limit 1;
    end if;
    if new.register_id is not null then
      select r.location_id, r.business_id, r.active and l.active into rloc, rb, ractive
        from public.registers r join public.business_locations l on l.id = r.location_id where r.id = new.register_id;
      if rloc is null or rb <> new.business_id then raise exception 'register_not_found' using errcode = '23503'; end if;
      -- a register closed down (or in a closed location) sells and opens no day; a refund of its old sale still goes there
      if not ractive and tg_table_name <> 'sale_refunds' then
        raise exception 'register_inactive: this register is closed down' using errcode = '23514';
      end if;
      if new.location_id is not null and new.location_id <> rloc then
        raise exception 'location_mismatch: a register stands in one location' using errcode = '23514';
      end if;
      loc := rloc;
    end if;
  end if;

  if loc is null then
    case tg_table_name
      when 'sale_refunds' then
        -- a refund is its sale's; the register that paid it out is the one given, else the sale's
        select coalesce(s.location_id, s.business_id), coalesce(new.register_id, s.register_id) into loc, new.register_id
          from public.sales s where s.id = new.sale_id;
      when 'sales' then
        -- an online sale has its order's id: the order's location (the store's)
        select coalesce(o.location_id, o.business_id) into loc from public.orders o where o.id = new.id and o.business_id = new.business_id;
      when 'documents' then
        select coalesce(
          (select coalesce(s.location_id, s.business_id) from public.sales s where s.id = new.sale_id),
          (select coalesce(r.location_id, r.business_id) from public.sale_refunds r where r.id = new.refund_id),
          (select coalesce(d.location_id, d.business_id) from public.documents d where d.id = new.paid_document_id),
          (select coalesce(d.location_id, d.business_id) from public.document_drafts d where d.id = new.draft_id)) into loc;
        -- the base document (fields 1256/1257). 7000: a business that numbers per location has the same number in each location
        -- (documents.series_location_id) — the base is the one of the location given (or the business's one series, before the
        -- switch); without a location, the only one there is; never a guess between two
        if loc is null and new.base_doc_number is not null then
          select count(*), min(coalesce(d.location_id, d.business_id)::text) into nbase, lbase from public.documents d
           where d.business_id = new.business_id and d.doc_type = new.base_doc_type and d.doc_number = new.base_doc_number
             and (new.location_id is null or d.series_location_id is null or d.series_location_id = new.location_id);
          if nbase > 1 then
            raise exception 'base_location_ambiguous: מסמך % מס׳ % קיים ביותר מסניף אחד — שולחים את הסניף של מסמך הבסיס (location_id)',
              new.base_doc_type, new.base_doc_number using errcode = '23514';
          end if;
          loc := lbase::uuid;
        end if;
      when 'payments' then
        select coalesce(
          (select coalesce(d.location_id, d.business_id) from public.documents d where d.id = new.document_id),
          (select coalesce(d.location_id, d.business_id) from public.documents d where d.id = new.applies_to),
          (select coalesce(r.location_id, r.business_id) from public.sale_refunds r where r.id = new.refund_id),
          (select coalesce(s.location_id, s.business_id) from public.sales s where s.id = new.sale_id),
          (select coalesce(e.location_id, e.business_id) from public.expenses e where e.id = new.expense_id)) into loc;
      when 'orders' then
        select s.location_id into loc from public.stores s where s.id = new.store_id;
      else null;
    end case;
  end if;

  -- what the row was given, else what it belongs to, else where the user works, else the main location
  new.location_id := coalesce(new.location_id, loc, public.location_pick(new.business_id));
  if new.location_id is not null and loc is not null and new.location_id <> loc then
    raise exception 'location_mismatch: a row goes where what it belongs to is' using errcode = '23514';
  end if;
  -- a member limited to some locations writes only there — also through a function that writes on their behalf
  if not public.location_allowed(new.business_id, new.location_id) then
    raise exception 'not allowed: this location is not yours' using errcode = '42501';
  end if;
  return new;
end $function$;

-- replaces documents_validate() of 20261125006800 (the 420 part; the base of a refund receipt / a credit invoice)
CREATE OR REPLACE FUNCTION public.documents_validate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  rs record; ent text; n int; bad int; s numeric; lock_end date; base record; done numeric; tgt record; mirror boolean := false;
  refund_receipt boolean; rf record; cashier boolean := public.my_access() = 'register'; dep record; dcash numeric; dchq numeric;
begin
  if new.business_id is null then raise exception 'a document must belong to a business' using errcode = '23502'; end if;
  select * into rs from public.register_settings where business_id = new.business_id;
  if not found or coalesce(rs.dealer_number, '') !~ '^[0-9]{9}$' then
    raise exception 'business_details_missing: a document needs the business''s dealer number (9 digits)' using errcode = '23514';
  end if;
  ent := public.entity_of(rs.entity_type, rs.business_type);
  -- 7000 (the accountant, answer 18): a bank deposit is a document of the books — 420 "הפקדת בנק" (1.31, appendix 1), its lines
  -- the cash and each cheque (D120 "פרטי קבלה / הפקדה"). Issued only by bank_deposit_create, in the same transaction as the deposit
  -- (dp.deposit_doc = its id), a mirror of it: no customer, no lines, no VAT, the total = the deposit's.
  if new.deposit_id is not null and new.doc_type <> 420 then
    raise exception 'deposit_document_only: רק מסמך הפקדה (420) שייך להפקדה' using errcode = '23514'; end if;
  if new.doc_type = 420 then
    if new.deposit_id is null or coalesce(current_setting('dp.deposit_doc', true), '') <> new.deposit_id::text then
      raise exception 'deposit_document_only: מסמך הפקדה (420) מופק רק יחד עם ההפקדה (bank_deposit_create)' using errcode = '42501'; end if;
    select * into dep from public.bank_deposits x where x.id = new.deposit_id and x.business_id = new.business_id;
    if dep.id is null or dep.status <> 'active' then
      raise exception 'deposit_document_only: ההפקדה לא נמצאה בעסק הזה' using errcode = '42501'; end if;
    if coalesce(new.location_id, new.business_id) <> dep.location_id then
      raise exception 'deposit_document_location: מסמך ההפקדה הוא של הסניף של ההפקדה' using errcode = '23514'; end if;
    if new.sale_id is not null or new.lead_id is not null or new.refund_id is not null or new.paid_document_id is not null
       or new.quote_id is not null or new.draft_id is not null or new.base_doc_type is not null or new.base_doc_number is not null then
      raise exception 'deposit_document_alone: מסמך הפקדה לא שייך ללקוח, למכירה או למסמך אחר' using errcode = '23514'; end if;
    if new.before_discount <> dep.cash + dep.cheques or new.discount <> 0 or new.after_discount <> new.before_discount
       or new.vat_amount <> 0 or new.total <> new.before_discount or new.vat_rate <> 0 then
      raise exception 'totals: a deposit document is the deposit''s total, with no discount and no VAT' using errcode = '23514'; end if;
    if jsonb_typeof(new.lines) is distinct from 'array' or jsonb_array_length(new.lines) <> 0 then
      raise exception 'lines: a deposit document has no lines — its cash and cheques are its payments' using errcode = '23514'; end if;
    if jsonb_typeof(new.payments) is distinct from 'array' or jsonb_array_length(new.payments) = 0 then
      raise exception 'payments: a deposit document lists its cash and cheques' using errcode = '23514'; end if;
    select coalesce(sum((p->>'amount')::numeric) filter (where p->>'method' = '1'), 0),
           coalesce(sum((p->>'amount')::numeric) filter (where p->>'method' = '2'), 0),
           count(*) filter (where coalesce(p->>'method', '') not in ('1', '2') or coalesce((p->>'amount')::numeric, 0) <= 0
                              or (p ? 'date' and coalesce(p->>'date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'))
      into dcash, dchq, bad from jsonb_array_elements(new.payments) p;
    if bad > 0 or dcash <> dep.cash or dchq <> dep.cheques then
      raise exception 'payments: a deposit document lists the deposit''s cash (1) and cheques (2), each above zero' using errcode = '23514'; end if;
    new.customer_name := ''; new.customer_phone := ''; new.customer_dealer := ''; new.customer_street := ''; new.customer_city := '';
    new.customer_email := '';
    if new.doc_date is null then new.doc_date := public.il_today(); end if;
    lock_end := public.finance_locked_until(new.business_id);
    if lock_end is not null and new.doc_date <= lock_end then
      raise exception 'period_locked: the books are closed until %', lock_end using errcode = '23514'; end if;
    new.due_date := null;
    new.source := 'deposit';
    new.issuer := public.issuer_snapshot(new.business_id);
    return new;
  end if;
  if not (new.doc_type = any (public.entity_doc_types(ent))) then
    raise exception 'doc_type_not_allowed: % does not issue document type %', ent, new.doc_type using errcode = '23514';
  end if;
  -- a cashier issues the sale's own document, nothing more
  if public.my_access() = 'register' and (new.paid_document_id is not null or new.quote_id is not null or new.draft_id is not null) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  -- references stay inside the business
  if new.sale_id is not null and not exists (select 1 from public.sales x where x.id = new.sale_id and x.business_id = new.business_id) then
    raise exception 'the sale belongs to another business' using errcode = '42501'; end if;
  if new.lead_id is not null and not exists (select 1 from public.leads x where x.id = new.lead_id and x.business_id = new.business_id) then
    raise exception 'the customer belongs to another business' using errcode = '42501'; end if;
  if new.refund_id is not null and not exists (select 1 from public.sale_refunds x where x.id = new.refund_id and x.business_id = new.business_id) then
    raise exception 'the refund belongs to another business' using errcode = '42501'; end if;
  if new.quote_id is not null and not exists (select 1 from public.quotes x where x.id = new.quote_id and x.business_id = new.business_id
                                                and x.status in ('draft', 'sent', 'accepted')) then
    raise exception 'the quote was not found in this business (or was already used)' using errcode = '23514'; end if;
  if new.draft_id is not null and not exists (select 1 from public.document_drafts x where x.id = new.draft_id and x.business_id = new.business_id
                                                and x.status = 'open' and x.doc_type = new.doc_type) then
    raise exception 'the draft was not found in this business (or was already issued)' using errcode = '23514'; end if;

  -- 2.118 (the accountant, answer 15): an exempt dealer refunds with a receipt of a negative total, pointing to the receipt it
  -- refunds — never more than that receipt less the refund receipts already on it (in a lock)
  refund_receipt := new.doc_type = 400 and new.total < 0;
  -- a retry of a refund receipt already issued (the same key — a double tap, a lost answer, a second tab): no check of it here;
  -- the insert reaches the unique key (documents_idempotency_uq, 23505) and the app reads back the receipt it issued
  if refund_receipt and new.idempotency_key is not null
     and exists (select 1 from public.documents c where c.business_id = new.business_id and c.idempotency_key = new.idempotency_key) then
    new.doc_date := coalesce(new.doc_date, public.il_today());
    return new;
  end if;
  if refund_receipt then
    if ent is distinct from 'exempt_dealer' then
      raise exception 'refund_receipt_not_exempt: קבלה במינוס (החזר כספי) — רק לעוסק פטור. עוסק מורשה וחברה מפיקים חשבונית מס זיכוי (330)'
        using errcode = '23514'; end if;
    if new.paid_document_id is not null or new.quote_id is not null or new.draft_id is not null then
      raise exception 'refund_receipt_alone: קבלה במינוס לא משלמת חשבונית ולא מופקת מהצעה או מטיוטה' using errcode = '23514'; end if;
    if new.base_doc_type is distinct from 400 or new.base_doc_number is null then
      raise exception 'refund_receipt_base: קבלה במינוס מציינת את הקבלה שעליה ההחזר (base_doc_type 400 ומספר הקבלה)' using errcode = '23514'; end if;
    -- a cashier (who reads no money): only the refund of a sale — its refund (refund_id), or the sale itself (sale_id) — never
    -- products back without the refund, and no message that tells a receipt's amounts or state (cashier_refund)
    if cashier then
      if new.refund_id is null and new.sale_id is null then
        raise exception 'cashier_refund: קופאי/ת מחזיר/ה כסף רק על מכירה (החזר מהקופה)' using errcode = '42501'; end if;
      if new.refund_id is null and exists (select 1 from jsonb_array_elements(case when jsonb_typeof(new.lines) = 'array' then new.lines else '[]'::jsonb end) e
                                            where (e->>'restock') = 'true') then
        raise exception 'cashier_refund: החזרת מוצרים למלאי — רק בהחזר מהקופה' using errcode = '42501'; end if;
    end if;
    -- 7000: of the business's one series, or of this document's location (a business that numbers per location)
    select id, total, sale_id, series_location_id into base from public.documents x
     where x.business_id = new.business_id and x.doc_type = 400 and x.doc_number = new.base_doc_number
       and (x.series_location_id is null or x.series_location_id = coalesce(new.location_id, new.business_id)) for update;
    if cashier and (not found or base.sale_id is null
                    or base.sale_id is distinct from coalesce(new.sale_id, (select x.sale_id from public.sale_refunds x where x.id = new.refund_id))) then
      raise exception 'cashier_refund: הקבלה הזו לא שייכת למכירה של ההחזר' using errcode = '42501'; end if;
    if not found or base.total <= 0 then
      raise exception 'refund_receipt_base: הקבלה שעליה ההחזר לא נמצאה בעסק הזה' using errcode = '23514'; end if;
    if exists (select 1 from public.document_cancellations c where c.document_id = base.id) then
      if cashier then raise exception 'cashier_refund: אי אפשר להפיק את ההחזר הזה מהקופה' using errcode = '42501'; end if;
      raise exception 'refund_receipt_base: הקבלה שעליה ההחזר בוטלה' using errcode = '23514'; end if;
    -- a refund receipt of a sale without its refund (sale_refunds) is the cancelled sale's — cancelling it at the register is
    -- the only way to refund a sale without recording the refund; on the sale's own receipt
    if new.sale_id is not null then
      if base.sale_id is distinct from new.sale_id then
        if cashier then raise exception 'cashier_refund: הקבלה הזו לא שייכת למכירה של ההחזר' using errcode = '42501'; end if;
        raise exception 'refund_receipt_sale: הקבלה שעליה ההחזר לא שייכת למכירה הזו' using errcode = '23514'; end if;
      if new.refund_id is null and not exists (select 1 from public.sales x where x.id = new.sale_id and x.status = 'cancelled') then
        raise exception 'refund_receipt_sale: החזר על מכירה שלא בוטלה — רושמים "החזר כספי" בקופה (ההחזר מפיק את הקבלה במינוס)'
          using errcode = '23514'; end if;
    end if;
    -- what already went back on this receipt: its refund receipts, and the refunds of its sale (sale_refunds) that have no refund
    -- receipt of their own (yet) — this one's own refund aside. The sale is locked too, as sale_refunds_check locks it: a refund at
    -- the register and a refund receipt of the same sale never pass at once.
    if base.sale_id is not null then perform 1 from public.sales x where x.id = base.sale_id for update; end if;
    select coalesce(sum(-c.total), 0) into done from public.documents c
     where c.business_id = new.business_id and c.doc_type = 400 and c.total < 0 and c.base_doc_type = 400 and c.base_doc_number = new.base_doc_number
       and (base.series_location_id is null or coalesce(c.location_id, c.business_id) = base.series_location_id);
    if base.sale_id is not null then
      done := done + coalesce((select sum(x.amount) from public.sale_refunds x
                                where x.sale_id = base.sale_id and x.id is distinct from new.refund_id
                                  and not exists (select 1 from public.documents c where c.business_id = new.business_id and c.refund_id = x.id)), 0);
    end if;
    if done - new.total > base.total then
      if cashier then raise exception 'refund_receipt_over: ההחזר גדול ממה שנשאר להחזיר על הקבלה' using errcode = '23514'; end if;
      raise exception 'refund_receipt_over: על הקבלה נשארו להחזר % ש״ח', base.total - done using errcode = '23514'; end if;
    -- the register's / an order's refund: the same money, of the same sale
    if new.refund_id is not null then
      select id, sale_id, amount into rf from public.sale_refunds where id = new.refund_id;
      -- one refund, one refund receipt, whatever its key (a retry with the same key never gets here — above)
      if exists (select 1 from public.documents c where c.business_id = new.business_id and c.refund_id = new.refund_id) then
        raise exception 'refund_receipt_refund: להחזר הזה כבר הופקה קבלה במינוס' using errcode = '23514'; end if;
      if rf.amount is distinct from -new.total then
        if cashier then raise exception 'refund_receipt_refund: סכום הקבלה במינוס שונה מסכום ההחזר' using errcode = '23514'; end if;
        raise exception 'refund_receipt_refund: סכום הקבלה במינוס (%) שונה מסכום ההחזר (%)', new.total, rf.amount using errcode = '23514'; end if;
      if base.sale_id is distinct from rf.sale_id or (new.sale_id is not null and new.sale_id is distinct from rf.sale_id) then
        raise exception 'refund_receipt_refund: ההחזר שייך למכירה אחרת מהקבלה' using errcode = '23514'; end if;
    end if;
  -- a credit invoice: points to a tax invoice of this business, never beyond what is left to credit (in a lock)
  elsif new.doc_type = 330 then
    if new.base_doc_type is null or new.base_doc_type not in (305, 320) or new.base_doc_number is null then
      raise exception 'a credit invoice points to a tax invoice (305 / 320)' using errcode = '23514'; end if;
    select id, total, before_discount, discount, after_discount, vat_amount, series_location_id into base from public.documents x
     where x.business_id = new.business_id and x.doc_type = new.base_doc_type and x.doc_number = new.base_doc_number
       and (x.series_location_id is null or x.series_location_id = coalesce(new.location_id, new.business_id)) for update;
    if not found then raise exception 'the credited invoice was not found in this business' using errcode = '23514'; end if;
    select coalesce(sum(c.total), 0) into done from public.documents c
     where c.business_id = new.business_id and c.doc_type = 330 and c.base_doc_type = new.base_doc_type and c.base_doc_number = new.base_doc_number
       and (base.series_location_id is null or coalesce(c.location_id, c.business_id) = base.series_location_id);
    if done + new.total > base.total then
      raise exception 'credit_exceeds_original: % left to credit', base.total - done using errcode = '23514'; end if;
    -- a full mirror of an invoice issued before these checks existed is accepted as it is
    mirror := new.total = base.total and new.before_discount = base.before_discount and new.discount = base.discount
              and new.after_discount = base.after_discount and new.vat_amount = base.vat_amount;
  elsif new.base_doc_type is not null or new.base_doc_number is not null then
    -- 2.95 (T10): a document made from an order or a delivery note names it (fields 1256/1257) — d_documents_goods checks which
    if new.base_doc_number is null or not ((new.doc_type = 200 and new.base_doc_type = 100) or (new.doc_type = 210 and new.base_doc_type = 200)
                                            or (new.doc_type in (300, 305, 320) and new.base_doc_type in (100, 200))) then
      raise exception 'only a credit invoice points to a base document (or a document made from an order or a delivery note)' using errcode = '23514';
    end if;
  end if;

  -- totals, to the agora
  if not mirror then
    if refund_receipt then
      -- a refund receipt: no discount and no VAT — before = after = the total, below zero
      if new.discount <> 0 or new.vat_amount <> 0 or new.before_discount >= 0 then
        raise exception 'totals: a refund receipt has no discount and no VAT, and its amounts are below zero' using errcode = '23514'; end if;
    elsif new.before_discount < 0 or new.discount < 0 or new.vat_amount < 0 or new.total <= 0 then
      raise exception 'totals: amounts are positive and the total is above zero' using errcode = '23514'; end if;
    if new.after_discount <> new.before_discount - new.discount then
      raise exception 'totals: after discount must equal before discount minus the discount' using errcode = '23514'; end if;
    if new.total <> new.after_discount + new.vat_amount then
      raise exception 'totals: the total must equal the amount before VAT plus the VAT' using errcode = '23514'; end if;
    if new.vat_rate < 0 or new.vat_rate > 30 then raise exception 'totals: VAT rate out of range' using errcode = '23514'; end if;
    if not public.entity_charges_vat(ent) or new.doc_type = 400 then
      if new.vat_amount <> 0 then raise exception 'totals: this document carries no VAT' using errcode = '23514'; end if;
    elsif abs(new.vat_amount - round(new.after_discount * new.vat_rate / 100, 2)) > 0.01 then
      raise exception 'totals: the VAT does not match the rate' using errcode = '23514';
    end if;
    if jsonb_typeof(new.lines) is distinct from 'array' then raise exception 'lines: a list is expected' using errcode = '23514'; end if;
    n := jsonb_array_length(new.lines);
    if n = 0 and new.doc_type <> 400 then raise exception 'lines: a document needs at least one line' using errcode = '23514'; end if;
    if n > 0 then
      select coalesce(sum((e->>'totalExVat')::numeric), 0), count(*) filter (where coalesce(e->>'name', '') = '' or e->>'totalExVat' is null)
        into s, bad from jsonb_array_elements(new.lines) e;
      if bad > 0 then raise exception 'lines: every line needs a name and a total' using errcode = '23514'; end if;
      if s <> new.before_discount then
        raise exception 'lines: the lines add up to % but the document says %', s, new.before_discount using errcode = '23514'; end if;
    end if;
  end if;

  -- payments: a receipt (320 / 400) lists how it was paid, exactly the total; other documents list none
  if jsonb_typeof(new.payments) is distinct from 'array' then raise exception 'payments: a list is expected' using errcode = '23514'; end if;
  if new.doc_type in (320, 400) then
    if jsonb_array_length(new.payments) = 0 then raise exception 'payments: a receipt says how it was paid' using errcode = '23514'; end if;
    if refund_receipt then
      -- the money that went back: each payment below zero, never tax withheld at source
      select coalesce(sum((p->>'amount')::numeric), 0),
             count(*) filter (where coalesce((p->>'amount')::numeric, 0) >= 0 or coalesce(p->>'method', '') !~ '^[1-9]$'
                                or p->>'m' = 'withholding' or p ? 'pct'
                                or (p ? 'date' and coalesce(p->>'date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'))
        into s, bad from jsonb_array_elements(new.payments) p;
      if bad > 0 then
        raise exception 'refund_receipt_payments: בקבלה במינוס כל תשלום הוא החזר — סכום מתחת לאפס, אמצעי תשלום 1–9, בלי ניכוי במקור'
          using errcode = '23514'; end if;
    else
      select coalesce(sum((p->>'amount')::numeric), 0),
             count(*) filter (where coalesce((p->>'amount')::numeric, 0) <= 0 or coalesce(p->>'method', '') !~ '^[1-9]$'
                                or (p ? 'date' and coalesce(p->>'date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'))
        into s, bad from jsonb_array_elements(new.payments) p;
      if bad > 0 then raise exception 'payments: each payment needs a method (1–9), an amount above zero and a valid date' using errcode = '23514'; end if;
    end if;
    if abs(s - new.total) > 0.01 then raise exception 'payments: % paid but the document says %', s, new.total using errcode = '23514'; end if;
    -- 2.118 (the accountant, answer 13): a card payment names its credit transaction kind (field 1315): 1 regular, 2 installments,
    -- 3 credit, 4 deferred charge, 5 other — asked when the document is issued; no other payment carries one
    -- a document the register or a server path makes (a sale's: sale_id — the register, its re-issue from "הכנסות", an online
    -- order; a payment link's receipt: paylink:<id>) whose card payment names no kind — an app still open on the code before
    -- 2.118 — gets 1 (regular); a kind that is there is checked as any. Everything else (composed by hand) must name it.
    if (new.sale_id is not null or coalesce(new.idempotency_key, '') like 'paylink:%')
       and exists (select 1 from jsonb_array_elements(new.payments) p where p->>'method' = '3' and not (p ? 'cardKind')) then
      select jsonb_agg(case when p->>'method' = '3' and not (p ? 'cardKind') then p || '{"cardKind": 1}'::jsonb else p end order by o)
        into new.payments from jsonb_array_elements(new.payments) with ordinality x(p, o);
    end if;
    if exists (select 1 from jsonb_array_elements(new.payments) p
                where p->>'method' = '3' and (jsonb_typeof(p->'cardKind') is distinct from 'number' or coalesce(p->>'cardKind', '') !~ '^[1-5]$')) then
      raise exception 'card_kind_missing: בתשלום בכרטיס אשראי בוחרים את סוג העסקה — רגיל, תשלומים, קרדיט, חיוב נדחה או אחר (cardKind 1–5)'
        using errcode = '23514'; end if;
    if exists (select 1 from jsonb_array_elements(new.payments) p where p->>'method' is distinct from '3' and p ? 'cardKind') then
      raise exception 'card_kind_not_card: סוג עסקת אשראי (cardKind) — רק בתשלום בכרטיס אשראי' using errcode = '23514'; end if;
  elsif jsonb_array_length(new.payments) > 0 then
    raise exception 'payments: only a receipt (320 / 400) lists payments' using errcode = '23514';
  end if;

  -- a receipt paying an invoice of this business: 400 pays a 305 / 300, a 320 pays a 300 (in a lock)
  if new.paid_document_id is not null then
    select id, doc_type, business_id into tgt from public.documents where id = new.paid_document_id for update;
    if not found or tgt.business_id is distinct from new.business_id then
      raise exception 'the paid document was not found in this business' using errcode = '42501'; end if;
    if not ((new.doc_type = 400 and tgt.doc_type in (300, 305)) or (new.doc_type = 320 and tgt.doc_type = 300)) then
      raise exception 'a receipt (400) pays a 305 / 300; a tax invoice-receipt (320) pays a 300' using errcode = '23514'; end if;
    if exists (select 1 from public.document_cancellations x where x.document_id = tgt.id) then
      raise exception 'the paid document was cancelled' using errcode = '23514'; end if;
  end if;

  -- dates: the day it is issued (2.118 — d_documents_issue_day refuses any other); no date sent = today; never ahead of today
  -- (a client clock a little ahead is brought back), never in closed books
  if new.doc_date is null then new.doc_date := public.il_today(); end if;
  if new.doc_date > public.il_today() + 1 then raise exception 'a document can not be dated in the future' using errcode = '23514'; end if;
  if new.doc_date > public.il_today() then new.doc_date := public.il_today(); end if;
  lock_end := public.finance_locked_until(new.business_id);
  if lock_end is not null and new.doc_date <= lock_end then
    raise exception 'period_locked: the books are closed until %', lock_end using errcode = '23514'; end if;
  if new.doc_type in (300, 305) then
    if new.due_date is not null and new.due_date < new.doc_date then raise exception 'the due date is before the document date' using errcode = '23514'; end if;
  else
    new.due_date := null;
  end if;

  new.source := coalesce(new.source, case when new.refund_id is not null or refund_receipt then 'refund' when new.sale_id is not null then 'pos'
                                          when new.paid_document_id is not null then 'receipt'
                                          when new.quote_id is not null then 'quote' when new.doc_type = 330 then 'credit' else 'direct' end);
  new.issuer := public.issuer_snapshot(new.business_id);   -- whatever the client sent: the business as it is now
  return new;
end $function$;

-- replaces documents_more_checks() of 20261005003200 (the credits on the invoice a receipt pays)
CREATE OR REPLACE FUNCTION public.documents_more_checks()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare bad int; tgt record; ent text; credited numeric; paid numeric;
begin
  -- 7. lines: an object each; a name (text); amounts, quantity, rate and kind are numbers
  select count(*) into bad from jsonb_array_elements(new.lines) e
   where jsonb_typeof(e) <> 'object'
      or jsonb_typeof(e->'name') is distinct from 'string' or length(e->>'name') > 300
      or (e ? 'qty' and jsonb_typeof(e->'qty') <> 'number')
      or (e ? 'unitPriceExVat' and jsonb_typeof(e->'unitPriceExVat') <> 'number')
      or (e ? 'discountExVat' and jsonb_typeof(e->'discountExVat') <> 'number')
      or (e ? 'totalExVat' and jsonb_typeof(e->'totalExVat') <> 'number')
      or (e ? 'vatRate' and jsonb_typeof(e->'vatRate') <> 'number')
      or (e ? 'kind' and jsonb_typeof(e->'kind') <> 'number')
      or (e ? 'restock' and jsonb_typeof(e->'restock') <> 'boolean');
  if bad > 0 then raise exception 'lines: names are text; quantities, prices, totals and rates are numbers' using errcode = '23514'; end if;
  -- 7. payments: an object each; method and amount are numbers, the date a date; a cheque's fields are digits
  select count(*) into bad from jsonb_array_elements(new.payments) p
   where jsonb_typeof(p) <> 'object'
      or jsonb_typeof(p->'method') is distinct from 'number' or jsonb_typeof(p->'amount') is distinct from 'number'
      or (p ? 'date' and coalesce(p->>'date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
      or (p ? 'm' and coalesce(p->>'m', '') !~ '^[a-z]{1,20}$')
      or (p ? 'cheque' and (jsonb_typeof(p->'cheque') <> 'object'
            or coalesce(p->'cheque'->>'number', '') !~ '^[0-9]{1,10}$'
            or coalesce(p->'cheque'->>'bank', '') !~ '^[0-9]{0,3}$'
            or coalesce(p->'cheque'->>'branch', '') !~ '^[0-9]{0,5}$'
            or coalesce(p->'cheque'->>'account', '') !~ '^[0-9]{0,15}$'
            or coalesce(p->'cheque'->>'dueDate', '') !~ '^([0-9]{4}-[0-9]{2}-[0-9]{2})?$'));
  if bad > 0 then raise exception 'payments: method and amount are numbers, dates are dates, a cheque''s details are digits' using errcode = '23514'; end if;

  -- 6. a receipt paying an invoice: never beyond its balance; a 400 pays a 300 only without VAT
  if new.paid_document_id is not null then
    select id, doc_type, doc_number, total, business_id, series_location_id into tgt from public.documents where id = new.paid_document_id for update;
    if not found or tgt.business_id is distinct from new.business_id then
      raise exception 'the paid document was not found in this business' using errcode = '42501'; end if;
    select public.entity_of(s.entity_type, s.business_type) into ent from public.register_settings s where s.business_id = new.business_id;
    if new.doc_type = 400 and tgt.doc_type = 300 and public.entity_charges_vat(coalesce(ent, 'licensed_dealer')) then
      raise exception 'a VAT business pays a transaction invoice (300) with a tax invoice-receipt (320), not a receipt (400)' using errcode = '23514';
    end if;
    select coalesce(sum(c.total), 0) into credited from public.documents c
     where c.business_id = new.business_id and c.doc_type = 330 and c.base_doc_type = tgt.doc_type and c.base_doc_number = tgt.doc_number
       and (tgt.series_location_id is null or coalesce(c.location_id, c.business_id) = tgt.series_location_id);
    select coalesce(sum(case p.direction when 'in' then p.amount else -p.amount end), 0) into paid from public.payments p where p.applies_to = tgt.id;
    if new.total > tgt.total - credited - paid then
      raise exception 'receipt_exceeds_balance: % left to pay on this invoice', greatest(tgt.total - credited - paid, 0) using errcode = '23514';
    end if;
  end if;
  return new;
end $function$;

-- replaces documents_goods() of 20261011005000 (the order / delivery note a document is made from, and what was made from it)
CREATE OR REPLACE FUNCTION public.documents_goods()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare base record; over text;
begin
  if new.doc_type in (100, 200, 210) or new.base_doc_type in (100, 200) then
    if public.my_access() = 'register' then raise exception 'not allowed' using errcode = '42501'; end if;
  end if;
  if new.doc_type in (100, 200, 210) then
    if not coalesce((select fp.sells_products from public.business_finance_profile fp where fp.business_id = new.business_id), false) then
      raise exception 'goods_off: orders, delivery notes and return notes are for a business that sells products (turned on in the settings)'
        using errcode = '23514';
    end if;
    if new.doc_type = 210 and new.base_doc_type is distinct from 200 then
      raise exception 'goods_return_base: a return note is made from a delivery note' using errcode = '23514';
    end if;
  end if;
  if new.base_doc_type in (100, 200) then
    if new.paid_document_id is not null then
      raise exception 'goods_base_receipt: a receipt for an invoice is not made from an order or a delivery note' using errcode = '23514';
    end if;
    select d.id, d.doc_number, d.lines, d.series_location_id into base from public.documents d
     where d.business_id = new.business_id and d.doc_type = new.base_doc_type and d.doc_number = new.base_doc_number
       and (d.series_location_id is null or d.series_location_id = coalesce(new.location_id, new.business_id)) for update;
    if base.id is null then raise exception 'goods_base_missing: the order / delivery note was not found in this business' using errcode = '23514'; end if;
    if exists (select 1 from public.document_cancellations c where c.document_id = base.id) then
      raise exception 'goods_base_cancelled: the order / delivery note was cancelled' using errcode = '23514';
    end if;
    if new.base_doc_type = 200 then
      if exists (select 1 from public.documents x
                  where x.business_id = new.business_id and x.base_doc_type = 200 and x.base_doc_number = base.doc_number
                    and (base.series_location_id is null or coalesce(x.location_id, x.business_id) = base.series_location_id)
                    and x.doc_type in (300, 305, 320) and not exists (select 1 from public.document_cancellations c where c.document_id = x.id)) then
        raise exception 'goods_invoiced: the delivery note was already invoiced' using errcode = '23514';
      end if;
      select string_agg(ci.name, ', ' order by ci.name) into over
        from public.stock_lines_v(new.lines) n
        join public.catalog_items ci on ci.id = n.item_id and ci.business_id = new.business_id and ci.kind = 'product'
        left join public.stock_lines_v(base.lines) o on o.item_id = n.item_id and o.variant_id is not distinct from n.variant_id
        left join lateral (select coalesce(sum(r.qty), 0) as qty
                             from public.documents x cross join lateral public.stock_lines_v(x.lines) r
                            where x.business_id = new.business_id and x.doc_type = 210 and x.base_doc_type = 200 and x.base_doc_number = base.doc_number
                              and (base.series_location_id is null or coalesce(x.location_id, x.business_id) = base.series_location_id)
                              and not exists (select 1 from public.document_cancellations c where c.document_id = x.id)
                              and r.item_id = n.item_id and r.variant_id is not distinct from n.variant_id) back on true
       where n.qty > coalesce(o.qty, 0) - back.qty;
      if over is not null then
        raise exception 'goods_over_delivery: more than the delivery note left (%)', over using errcode = '23514';
      end if;
    end if;
  end if;
  return new;
end $function$;

-- replaces document_cancellations_check() of 20261125006800 (what was made from it; a 420 only with its deposit)
CREATE OR REPLACE FUNCTION public.document_cancellations_check()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare d record; lock_end date;
begin
  select id, business_id, doc_type, doc_number, doc_date, base_doc_number, location_id, series_location_id, deposit_id into d
    from public.documents where id = new.document_id for update;
  if not found or d.business_id is distinct from new.business_id then
    raise exception 'the document was not found in this business' using errcode = '42501'; end if;
  -- 7000: a deposit document (420) is cancelled with its deposit — only by bank_deposit_cancel, in the same transaction
  if d.doc_type = 420 and (coalesce(current_setting('dp.deposit_doc', true), '') <> coalesce(d.deposit_id::text, '-')
                           or not exists (select 1 from public.bank_deposits x where x.id = d.deposit_id and x.status = 'cancelled')) then
    raise exception 'cancel_deposit_document: מסמך הפקדה מבוטל רק יחד עם ההפקדה (ביטול הפקדה)' using errcode = '23514'; end if;
  if d.doc_type = 400 then
    raise exception 'cancel_receipt_not_allowed: קבלה לא מבטלים בסימון "בוטל". מחזירים כסף בקבלה במינוס (עוסק פטור) או בחשבונית זיכוי'
      using errcode = '23514'; end if;
  if d.doc_type not in (300, 100, 200, 210, 420) then
    raise exception 'cancel_not_allowed: a tax invoice is corrected by a credit invoice (330)' using errcode = '23514'; end if;
  lock_end := public.finance_locked_until(d.business_id);
  if lock_end is not null and d.doc_date <= lock_end then
    raise exception 'period_locked: the books are closed until %', lock_end using errcode = '23514'; end if;
  if d.doc_type = 300 and exists (select 1 from public.documents p where p.paid_document_id = d.id
                                    and not exists (select 1 from public.document_cancellations c where c.document_id = p.id)) then
    raise exception 'a paid transaction invoice is not cancelled (cancel its receipt first)' using errcode = '23514'; end if;
  -- 2.95 (T10): an order / a delivery note a document was made from stays (cancel that one first, if it may be)
  if d.doc_type in (100, 200) and exists (select 1 from public.documents x
                                            where x.business_id = d.business_id and x.base_doc_type = d.doc_type and x.base_doc_number = d.doc_number
                                              and (d.series_location_id is null or coalesce(x.location_id, x.business_id) = d.series_location_id)
                                              and not exists (select 1 from public.document_cancellations c where c.document_id = x.id)) then
    raise exception 'cancel_has_followers: a document was made from it — cancel that one first' using errcode = '23514'; end if;
  -- a return note stays once its delivery note was invoiced (the invoice counted what came back)
  if d.doc_type = 210 and exists (select 1 from public.documents x
                                    where x.business_id = d.business_id and x.base_doc_type = 200 and x.base_doc_number = d.base_doc_number
                                      -- 7000: the same delivery note — of the business's one series, or of this note's location
                                      and (exists (select 1 from public.documents n where n.business_id = d.business_id and n.doc_type = 200
                                                     and n.doc_number = d.base_doc_number and n.series_location_id is null)
                                           or coalesce(x.location_id, x.business_id) = coalesce(d.location_id, d.business_id))
                                      and x.doc_type in (300, 305, 320)
                                      and not exists (select 1 from public.document_cancellations c where c.document_id = x.id)) then
    raise exception 'cancel_has_followers: its delivery note was invoiced' using errcode = '23514'; end if;
  new.created_at := now();
  return new;
end $function$;

-- replaces record_credit_refund() of 20261005003200 (the invoice of the credit invoice)
CREATE OR REPLACE FUNCTION public.record_credit_refund(p_document uuid, p_method text, p_amount numeric, p_paid_on date DEFAULT NULL::date, p_note text DEFAULT ''::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare b uuid := public.finance_guard(); d record; base_id uuid; base_sale uuid; sale_ref uuid; sale_total numeric; reg_out numeric; cred_out numeric;
  done numeric; day date := coalesce(p_paid_on, public.il_today()); lock_end date; new_id uuid;
begin
  if not public.can_write() then raise exception 'not allowed' using errcode = '42501'; end if;
  select x.id, x.business_id, x.doc_type, x.total, x.base_doc_type, x.base_doc_number, x.lead_id, x.sale_id, x.refund_id, x.location_id
    into d from public.documents x where x.id = p_document for update;
  if not found or d.business_id <> b or d.doc_type <> 330 then raise exception 'a refund is recorded on a credit invoice of this business' using errcode = '23514'; end if;
  if d.refund_id is not null then raise exception 'this credit invoice belongs to a register refund (already recorded)' using errcode = '23514'; end if;
  if p_method is null or p_method not in ('cash', 'card', 'transfer', 'bit', 'cheque', 'other') then raise exception 'unknown payment method' using errcode = '22023'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'an amount above zero' using errcode = '22023'; end if;
  if day > public.il_today() then raise exception 'not in the future' using errcode = '22023'; end if;
  lock_end := public.finance_locked_until(b);
  if lock_end is not null and day <= lock_end then raise exception 'period_locked: the books are closed until %', lock_end using errcode = '23514'; end if;
  select coalesce(sum(p.amount), 0) into done from public.payments p where p.document_id = d.id and p.source = 'credit';
  if done + p_amount > d.total then raise exception 'more than the credit invoice (% left)', d.total - done using errcode = '23514'; end if;
  select x.id, x.sale_id into base_id, base_sale from public.documents x where x.business_id = b and x.doc_type = d.base_doc_type and x.doc_number = d.base_doc_number
     and (x.series_location_id is null or x.series_location_id = coalesce(d.location_id, b));
  -- 2.52.1: an invoice of a register sale — what the register already refunded counts (in the sale's lock, as sale_refunds_check)
  sale_ref := coalesce(d.sale_id, base_sale);
  if sale_ref is not null then
    select s.total into sale_total from public.sales s where s.id = sale_ref and s.business_id = b for update;
    if found then
      select coalesce(sum(r.amount), 0) into reg_out from public.sale_refunds r where r.sale_id = sale_ref;
      select coalesce(sum(p.amount), 0) into cred_out from public.payments p
       where p.source = 'credit' and p.direction = 'out'
         and (p.sale_id = sale_ref or p.applies_to in (select x.id from public.documents x where x.sale_id = sale_ref and x.business_id = b));
      if reg_out + cred_out + p_amount > sale_total then
        raise exception 'refund_exceeds_paid: % left (part of the sale was already returned at the register)', greatest(sale_total - reg_out - cred_out, 0)
          using errcode = '23514';
      end if;
    end if;
  end if;
  insert into public.payments (business_id, user_id, direction, amount, method, paid_on, source, document_id, applies_to, sale_id, lead_id, note)
  values (b, auth.uid(), 'out', round(p_amount, 2), p_method, day, 'credit', d.id, base_id, d.sale_id, d.lead_id, left(coalesce(p_note, ''), 300))
  returning payments.id into new_id;
  return new_id;
end $function$;

-- replaces sale_refunds_receipts() of 20261125006800 (the refund receipts on the sale's receipts)
CREATE OR REPLACE FUNCTION public.sale_refunds_receipts()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare s record; done numeric; back numeric;
begin
  select id, business_id, total into s from public.sales where id = new.sale_id;
  select coalesce(sum(r.amount), 0) into done from public.sale_refunds r where r.sale_id = new.sale_id and r.id <> new.id;
  select coalesce(sum(-c.total), 0) into back from public.documents c
   where c.business_id = s.business_id and c.doc_type = 400 and c.total < 0 and c.base_doc_type = 400 and c.refund_id is null
     and exists (select 1 from public.documents x where x.business_id = s.business_id and x.doc_type = 400
                    and x.total > 0 and x.sale_id = new.sale_id and x.doc_number = c.base_doc_number
                    and (x.series_location_id is null or coalesce(c.location_id, c.business_id) = x.series_location_id));
  if back > 0 and done + back + new.amount > s.total then
    raise exception 'refund_exceeds_paid: % left', greatest(s.total - done - back, 0) using errcode = '23514';
  end if;
  return new;
end $function$;

-- replaces paylink_create() of 20261010004300, sf_paylink_page() of 20261010004300 and payment_plan_create() of 20261010004400
-- (the credits on the invoice: what is left to pay)
CREATE OR REPLACE FUNCTION public.paylink_create(p_business uuid, p_user uuid, p_kind text, p_target uuid, p_amount numeric, p_days integer, p_origin text, p_via text DEFAULT 'link'::text, p_package uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  a public.payment_accounts; d public.documents; q public.quotes; ap public.appointments; sv public.booking_services;
  r public.payment_requests; bal numeric; held numeric; amt numeric := round(coalesce(p_amount, 0), 2);
  lbl text; cname text := ''; cphone text := ''; cemail text := ''; lead uuid; pkg_name text;
begin
  if p_business is null or p_kind not in ('document', 'quote', 'deposit') or p_target is null then
    raise exception 'paylink_request: what is paid' using errcode = '22023'; end if;
  if coalesce(p_via, '') not in ('whatsapp', 'email', 'link') then raise exception 'paylink_request: how it is sent' using errcode = '22023'; end if;
  if p_days is null or p_days < 1 or p_days > 30 then raise exception 'paylink_days: 1 to 30 days' using errcode = '22023'; end if;
  if coalesce(p_origin, '') !~ '^https?://[^/?#[:space:]]+$' then raise exception 'paylink_request: the address' using errcode = '22023'; end if;
  if not public.business_is_active(p_business) then raise exception 'business_locked' using errcode = '42501'; end if;
  -- the terminal: connected and verified; a live one only with the platform's switch
  select * into a from public.payment_accounts where business_id = p_business;
  if a.business_id is null then raise exception 'paylink_no_terminal: no payment provider is connected' using errcode = '55000'; end if;
  if a.verified_at is null then raise exception 'paylink_not_verified: the terminal was not checked yet' using errcode = '55000'; end if;
  if a.mode = 'live' and not public.payment_links_live() then raise exception 'paylink_live_closed' using errcode = '55000'; end if;

  if p_kind = 'document' then
    select * into d from public.documents where id = p_target and business_id = p_business for update;
    if d.id is null then raise exception 'paylink_not_found' using errcode = '42501'; end if;
    if d.doc_type not in (300, 305) then raise exception 'paylink_not_invoice: a link pays an open invoice' using errcode = '23514'; end if;
    if exists (select 1 from public.document_cancellations x where x.document_id = d.id) then
      raise exception 'paylink_not_invoice: the invoice was cancelled' using errcode = '23514'; end if;
    select d.total - coalesce((select sum(c.total) from public.documents c where c.business_id = d.business_id and c.doc_type = 330
                                 and c.base_doc_type = d.doc_type and c.base_doc_number = d.doc_number
                                 and (d.series_location_id is null or coalesce(c.location_id, c.business_id) = d.series_location_id)), 0)
                   - coalesce((select sum(case p.direction when 'in' then p.amount else -p.amount end) from public.payments p where p.applies_to = d.id), 0)
      into bal;
    select coalesce(sum(x.amount), 0) into held from public.payment_requests x
     where x.document_id = d.id and ((x.status in ('sent', 'failed') and x.expires_at > now())
                                     or (x.status = 'paid' and x.receipt_status in ('pending', 'awaiting', 'blocked')));
    lbl := case d.doc_type when 305 then 'חשבונית מס' else 'חשבונית עסקה' end || ' מס׳ ' || d.doc_number;
    if p_package is not null then
      select p.name into pkg_name from public.client_packages p where p.id = p_package and p.business_id = p_business and p.document_id = d.id;
      if pkg_name is null then raise exception 'paylink_not_found: the package' using errcode = '42501'; end if;
      lbl := left(pkg_name, 100) || ' (' || lbl || ')';
    end if;
    cname := d.customer_name; cphone := coalesce(d.customer_phone, ''); cemail := coalesce(d.customer_email, ''); lead := d.lead_id;
  elsif p_kind = 'quote' then
    if p_package is not null then raise exception 'paylink_request: a package is paid on its invoice' using errcode = '22023'; end if;
    select * into q from public.quotes where id = p_target and business_id = p_business for update;
    if q.id is null then raise exception 'paylink_not_found' using errcode = '42501'; end if;
    if q.status <> 'accepted' then raise exception 'paylink_quote: a link pays an accepted quote' using errcode = '23514'; end if;
    bal := q.total;
    select coalesce(sum(x.amount), 0) into held from public.payment_requests x
     where x.quote_id = q.id and ((x.status in ('sent', 'failed') and x.expires_at > now())
                                  or (x.status = 'paid' and not x.is_test and x.receipt_status in ('pending', 'awaiting', 'blocked')));
    lbl := 'הצעת מחיר מס׳ ' || q.quote_number;
    cname := q.customer_name; cphone := q.customer_phone; cemail := q.customer_email; lead := q.lead_id;
  else
    if p_package is not null then raise exception 'paylink_request: a package is paid on its invoice' using errcode = '22023'; end if;
    select * into ap from public.appointments where id = p_target and business_id = p_business for update;
    if ap.id is null then raise exception 'paylink_not_found' using errcode = '42501'; end if;
    if ap.status not in ('booked', 'confirmed') then raise exception 'paylink_appointment: the appointment is not open' using errcode = '23514'; end if;
    if ap.end_at <= now() then raise exception 'paylink_appointment: the appointment is over' using errcode = '23514'; end if;
    select * into sv from public.booking_services where id = ap.service_id and business_id = p_business;
    if coalesce(sv.deposit, 0) <= 0 then raise exception 'paylink_no_deposit: the service asks no deposit' using errcode = '23514'; end if;
    if exists (select 1 from public.payment_requests x where x.appointment_id = ap.id and x.kind = 'deposit' and x.status in ('sent', 'failed', 'paid')) then
      raise exception 'paylink_deposit_exists: the appointment already has a deposit link' using errcode = '23505'; end if;
    amt := sv.deposit; bal := sv.deposit; held := 0;
    lbl := 'מקדמה לתור: ' || left(coalesce(nullif(btrim(ap.service_name), ''), sv.name), 80) || ' · '
           || to_char(ap.start_at at time zone 'Asia/Jerusalem', 'DD/MM HH24:MI');
    cname := ap.name; cphone := ap.phone; cemail := ap.email; lead := ap.lead_id;
  end if;

  if amt <= 0 then raise exception 'paylink_amount: more than zero' using errcode = '22023'; end if;
  if amt > bal - held then
    raise exception 'paylink_over_balance: % left to ask for', greatest(bal - held, 0) using errcode = '23514'; end if;
  insert into public.payment_requests (business_id, user_id, kind, document_id, package_id, quote_id, appointment_id, lead_id, label,
                                       customer_name, customer_phone, customer_email, amount, is_test, provider, expires_at, link_origin, sent_via)
  values (p_business, p_user, p_kind, case when p_kind = 'document' then p_target end, case when p_kind = 'document' then p_package end,
          case when p_kind = 'quote' then p_target end, case when p_kind = 'deposit' then p_target end, lead, lbl,
          left(coalesce(cname, ''), 120), left(coalesce(cphone, ''), 30), left(coalesce(cemail, ''), 120), amt, a.mode = 'test', a.provider,
          now() + make_interval(days => p_days), p_origin, p_via)
  returning * into r;
  perform public.finance_log(p_business, 'paylink.created', 'payment_requests', r.id::text,
    jsonb_build_object('kind', r.kind, 'amount', r.amount, 'test', r.is_test, 'by', p_user, 'via', p_via));
  return to_jsonb(r);
end $function$;

CREATE OR REPLACE FUNCTION public.sf_paylink_page(p_request uuid, p_page text, p_url text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r public.payment_requests; d public.documents; left_now numeric;
begin
  select * into r from public.payment_requests where id = p_request for update;
  if r.id is null then return 'not_found'; end if;
  if r.status not in ('sent', 'failed') or r.expires_at <= now() then return 'closed'; end if;
  if r.kind = 'document' then
    select * into d from public.documents where id = r.document_id;
    if exists (select 1 from public.document_cancellations x where x.document_id = r.document_id) then return 'closed'; end if;
    left_now := d.total - coalesce((select sum(c.total) from public.documents c where c.business_id = d.business_id and c.doc_type = 330
                                     and c.base_doc_type = d.doc_type and c.base_doc_number = d.doc_number
                                     and (d.series_location_id is null or coalesce(c.location_id, c.business_id) = d.series_location_id)), 0)
                        - coalesce((select sum(case p.direction when 'in' then p.amount else -p.amount end) from public.payments p where p.applies_to = d.id), 0);
    if left_now < r.amount then return 'closed'; end if;
  elsif r.kind = 'quote' then
    if not exists (select 1 from public.quotes q where q.id = r.quote_id and q.status in ('accepted', 'converted')) then return 'closed'; end if;
  elsif not exists (select 1 from public.appointments a where a.id = r.appointment_id and a.status in ('booked', 'confirmed')) then
    return 'closed';
  end if;
  if jsonb_array_length(r.pages) >= 5 then return 'too_many'; end if;
  if coalesce(btrim(p_page), '') = '' or length(p_page) > 120 or coalesce(p_url, '') !~ '^https?://' or length(p_url) > 500 then return 'bad'; end if;
  if exists (select 1 from jsonb_array_elements(r.pages) e where e->>'page' = p_page) then return 'ok'; end if;
  update public.payment_requests
     set pages = pages || jsonb_build_array(jsonb_build_object('page', p_page, 'url', p_url, 'at', now(), 'state', 'pending')),
         status = 'sent'
   where id = r.id;
  return 'ok';
end $function$;

CREATE OR REPLACE FUNCTION public.payment_plan_create(p_id uuid, p_document uuid, p_items jsonb, p_note text DEFAULT ''::text, p_replace boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  b uuid := public.finance_guard(); d public.documents; pl public.payment_plans; old_id uuid; bal numeric; it jsonb;
  k int := 0; cnt int; amt numeric; dd date; prev date; first_d date; s numeric := 0; today date := public.il_today(); lbl text;
begin
  if not public.can_write() then raise exception 'not allowed' using errcode = '42501'; end if;
  if not public.business_is_active(b) then raise exception 'business_locked' using errcode = '42501'; end if;
  if p_id is null or p_document is null then raise exception 'plan_request: which invoice' using errcode = '22023'; end if;
  select * into d from public.documents where id = p_document and business_id = b for update;
  if d.id is null then raise exception 'plan_not_found' using errcode = '42501'; end if;
  -- the same call again (its answer was lost): the plan it made
  select * into pl from public.payment_plans where id = p_id;
  if pl.id is not null then
    if pl.business_id <> b or pl.document_id <> d.id then raise exception 'plan_request: another plan has this id' using errcode = '22023'; end if;
    return jsonb_build_object('result', 'already', 'plan', pl.id);
  end if;
  if d.doc_type not in (300, 305) then raise exception 'plan_not_invoice: a plan splits an open invoice' using errcode = '23514'; end if;
  if exists (select 1 from public.document_cancellations x where x.document_id = d.id) then
    raise exception 'plan_not_invoice: the invoice was cancelled' using errcode = '23514'; end if;
  select d.total - coalesce((select sum(c.total) from public.documents c where c.business_id = d.business_id and c.doc_type = 330
                               and c.base_doc_type = d.doc_type and c.base_doc_number = d.doc_number
                               and (d.series_location_id is null or coalesce(c.location_id, c.business_id) = d.series_location_id)), 0)
                 - coalesce((select sum(case p.direction when 'in' then p.amount else -p.amount end) from public.payments p where p.applies_to = d.id), 0)
    into bal;
  if bal <= 0 then raise exception 'plan_paid: nothing is owed on this invoice' using errcode = '23514'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then raise exception 'plan_items: the payments' using errcode = '22023'; end if;
  cnt := jsonb_array_length(p_items);
  if cnt < 2 or cnt > 36 then raise exception 'plan_count: 2 to 36 payments' using errcode = '22023'; end if;
  for it in select e from jsonb_array_elements(p_items) e loop
    k := k + 1;
    begin
      amt := (it->>'amount')::numeric; dd := (it->>'due')::date;
    exception when others then
      raise exception 'plan_items: payment %', k using errcode = '22023';
    end;
    if amt is null or dd is null then raise exception 'plan_items: payment %', k using errcode = '22023'; end if;
    if amt <= 0 or amt <> round(amt, 2) then raise exception 'plan_amount: payment % — more than zero, in agorot', k using errcode = '22023'; end if;
    if dd < today then raise exception 'plan_date: payment % is in the past', k using errcode = '22023'; end if;
    if dd > today + 1830 then raise exception 'plan_date: payment % is more than 5 years ahead', k using errcode = '22023'; end if;
    if prev is not null and dd <= prev then raise exception 'plan_date: payment % is not after the one before it', k using errcode = '22023'; end if;
    if first_d is null then first_d := dd; end if;
    prev := dd; s := s + amt;
  end loop;
  if s <> bal then raise exception 'plan_sum: the payments add up to %, the balance is %', s, bal using errcode = '23514'; end if;
  select x.id into old_id from public.payment_plans x where x.document_id = d.id and x.status = 'active' for update;
  if old_id is not null then
    if not coalesce(p_replace, false) then raise exception 'plan_exists: the invoice already has a plan' using errcode = '23505'; end if;
    update public.payment_plans set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = 'הוחלפה בפריסה חדשה'
     where id = old_id;
    perform public.finance_log(b, 'plan.cancelled', 'documents', d.id::text, jsonb_build_object('plan', old_id, 'reason', 'replaced'));
  end if;
  insert into public.payment_plans (id, business_id, user_id, document_id, lead_id, total, payments, note)
  values (p_id, b, auth.uid(), d.id, d.lead_id, bal, cnt, left(btrim(coalesce(p_note, '')), 300))
  returning * into pl;
  insert into public.payment_plan_items (plan_id, business_id, n, due_date, amount)
  select pl.id, b, x.n::int, (x.e->>'due')::date, (x.e->>'amount')::numeric from jsonb_array_elements(p_items) with ordinality as x(e, n);
  lbl := case d.doc_type when 305 then 'חשבונית מס' else 'חשבונית עסקה' end || ' מס׳ ' || d.doc_number;
  perform public.finance_log(b, 'plan.created', 'documents', d.id::text,
    jsonb_build_object('plan', pl.id, 'total', bal, 'payments', cnt, 'first', first_d, 'last', prev, 'replaced', old_id));
  if d.lead_id is not null and auth.uid() is not null then
    insert into public.lead_activities (user_id, business_id, lead_id, kind, body)
    values (auth.uid(), b, d.lead_id, 'note', format('פריסה לתשלומים: %s · %s תשלומים · ₪%s', lbl, cnt, trim_scale(bal)));
  end if;
  return jsonb_build_object('result', 'ok', 'plan', pl.id);
end $function$;

-- ---- the views: a credit invoice of an invoice — of the business's series, or of the invoice's location ----------------------
create or replace view public.receivables with (security_invoker = true) as
select d.id, d.business_id, d.doc_type, d.doc_number, d.doc_date, d.due_date, d.customer_name, d.customer_phone, d.customer_email, d.lead_id,
       d.total, d.share_token,
       coalesce(cr.amount, 0)::numeric(14,2) as credited,
       coalesce(pa.amount, 0)::numeric(14,2) as paid,
       (d.total - coalesce(cr.amount, 0) - coalesce(pa.amount, 0))::numeric(14,2) as balance,
       (x.document_id is not null) as cancelled
  from public.documents d
  left join lateral (select sum(c.total) as amount from public.documents c
                      where c.business_id = d.business_id and c.doc_type = 330 and c.base_doc_type = d.doc_type and c.base_doc_number = d.doc_number
                        and (d.series_location_id is null or coalesce(c.location_id, c.business_id) = d.series_location_id)) cr on true
  left join lateral (select sum(case p.direction when 'in' then p.amount else -p.amount end) as amount
                       from public.payments p where p.applies_to = d.id) pa on true
  left join public.document_cancellations x on x.document_id = d.id
 where d.doc_type in (300, 305) and (select public.my_access()) <> 'register';

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
                        and c.base_doc_type = d.doc_type and c.base_doc_number = d.doc_number
                        and (d.series_location_id is null or coalesce(c.location_id, c.business_id) = d.series_location_id)) cr on true
 where (select public.my_access()) <> 'register';
-- (create or replace keeps their grants: select for authenticated, nothing for anon — as 3100 / 4200 set them)

-- ============================================================================================================================
-- 6. a deposit issues its document 420, and cancels it — replaces bank_deposit_create(), bank_deposit_cancel() and
--    deposit_book() of 20261011005000
-- ============================================================================================================================
CREATE OR REPLACE FUNCTION public.bank_deposit_create(p_id uuid, p_date date, p_location uuid, p_cash numeric, p_cheques uuid[], p_note text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare b uuid := public.finance_guard(); d record; loc uuid; lock_end date; have numeric; cash numeric := coalesce(p_cash, 0);
        ids uuid[]; n int; chq numeric; num int; bad text; pays jsonb; doc_id uuid; doc_no bigint;
begin
  if not public.can_write() then raise exception 'not allowed' using errcode = '42501'; end if;
  if not public.business_is_active(b) then raise exception 'business_locked' using errcode = '42501'; end if;
  if p_id is null then raise exception 'deposit_id: a new deposit has an id' using errcode = '22023'; end if;
  -- one deposit of the business at a time: its number, the cash the desk holds, the same id twice — "no key update", as the stock
  -- transfers: a document's or a payment's check of its business (key share) never waits on it
  perform 1 from public.businesses where id = b for no key update;
  select * into d from public.bank_deposits where id = p_id;
  if d.id is not null then
    if d.business_id <> b then raise exception 'not allowed' using errcode = '42501'; end if;
    select x.id, x.doc_number into doc_id, doc_no from public.documents x where x.deposit_id = d.id;
    return jsonb_build_object('id', d.id, 'number', d.number, 'created', false)
           || case when doc_id is not null then jsonb_build_object('document', jsonb_build_object('id', doc_id, 'number', doc_no)) else '{}'::jsonb end;
  end if;
  if p_date is null or p_date > public.il_today() or p_date < public.il_today() - 3650 then
    raise exception 'deposit_date: a deposit is dated today or before' using errcode = '22023'; end if;
  lock_end := public.finance_locked_until(b);
  if lock_end is not null and p_date <= lock_end then
    raise exception 'period_locked: the books are closed until %', lock_end using errcode = '23514'; end if;
  loc := coalesce(p_location, public.location_pick(b));
  if loc is null or not exists (select 1 from public.business_locations l where l.id = loc and l.business_id = b) then
    raise exception 'deposit_location: a location of the business' using errcode = '22023'; end if;
  if not public.location_allowed(b, loc) then raise exception 'not allowed: this location is not yours' using errcode = '42501'; end if;
  if cash < 0 or cash >= 1e10 or round(cash, 2) <> cash then raise exception 'deposit_cash: an amount of money' using errcode = '22023'; end if;
  select coalesce(array_agg(distinct x), '{}') into ids from unnest(coalesce(p_cheques, '{}'::uuid[])) x where x is not null;
  n := cardinality(ids);
  if n > 200 then raise exception 'deposit_cheques: up to 200 cheques in a deposit' using errcode = '22023'; end if;
  if cash = 0 and n = 0 then raise exception 'deposit_empty: cash or cheques to deposit' using errcode = '22023'; end if;
  -- every cheque: received on a receipt of the business, of this location, in the drawer now
  select string_agg(x::text, ', ') into bad from unnest(ids) x
   where not exists (select 1 from public.payments p where p.id = x and p.business_id = b and p.direction = 'in' and p.method = 'cheque' and p.source = 'document');
  if bad is not null then raise exception 'deposit_cheque: a cheque received on a receipt of the business' using errcode = '22023'; end if;
  if exists (select 1 from public.payments p where p.id = any (ids) and coalesce(p.location_id, p.business_id) <> loc) then
    raise exception 'deposit_cheque_location: the cheques of the deposit''s location' using errcode = '22023'; end if;
  if exists (select 1 from unnest(ids) x where not public.cheque_in_drawer(x)) then
    raise exception 'deposit_cheque_taken: a cheque is no longer in the drawer (deposited, matched to the bank or its receipt cancelled)' using errcode = '23514'; end if;
  if cash > 0 then
    have := public.cash_desk_cash(b, loc);
    if cash > have then raise exception 'deposit_cash_over: the cash desk holds %', greatest(have, 0) using errcode = '23514'; end if;
  end if;
  select coalesce(sum(p.amount), 0) into chq from public.payments p where p.id = any (ids);
  select coalesce(max(x.number), 0) + 1 into num from public.bank_deposits x where x.business_id = b;
  insert into public.bank_deposits (id, business_id, location_id, number, deposited_on, cash, cheques, note, user_id)
  values (p_id, b, loc, num, p_date, cash, chq, left(btrim(coalesce(p_note, '')), 300), auth.uid());
  insert into public.bank_deposit_cheques (deposit_id, business_id, location_id, payment_id, amount)
  select p_id, b, loc, p.id, p.amount from public.payments p where p.id = any (ids);
  -- 7000 (the accountant, answer 18): the deposit is a document of the books — 420 "הפקדת בנק" (1.31, appendix 1), numbered in
  -- its own series (per location when the business numbers per location), its lines the cash and each cheque with its details
  -- (D120 "פרטי קבלה / הפקדה"). Only when the business has its dealer number (every document needs it): without one the deposit
  -- is recorded as before, with no document.
  if exists (select 1 from public.register_settings s where s.business_id = b and coalesce(s.dealer_number, '') ~ '^[0-9]{9}$') then
    select jsonb_agg(x.line order by x.ord) into pays from (
      select 0::bigint as ord, jsonb_build_object('method', 1, 'm', 'cash', 'amount', cash, 'date', p_date) as line where cash > 0
      union all
      select row_number() over (order by p.paid_on, p.id),
             jsonb_build_object('method', 2, 'm', 'cheque', 'amount', p.amount, 'date', p_date)
             || case when coalesce(p.reference->>'number', '') ~ '^[0-9]{1,10}$' then jsonb_build_object('cheque', jsonb_strip_nulls(jsonb_build_object(
                  'number', p.reference->>'number',
                  'bank', case when coalesce(p.reference->>'bank', '') ~ '^[0-9]{1,3}$' then p.reference->>'bank' end,
                  'branch', case when coalesce(p.reference->>'branch', '') ~ '^[0-9]{1,5}$' then p.reference->>'branch' end,
                  'account', case when coalesce(p.reference->>'account', '') ~ '^[0-9]{1,15}$' then p.reference->>'account' end,
                  'dueDate', case when coalesce(p.reference->>'dueDate', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then p.reference->>'dueDate' end)))
                  else '{}'::jsonb end
        from public.payments p where p.id = any (ids)) x;
    perform set_config('dp.deposit_doc', p_id::text, true);
    insert into public.documents (user_id, business_id, location_id, doc_type, doc_number, doc_date, lines, payments, before_discount, discount,
                                  after_discount, vat_amount, total, vat_rate, idempotency_key, deposit_id, issued_by)
    values (auth.uid(), b, loc, 420, 0, public.il_today(), '[]'::jsonb, pays, cash + chq, 0, cash + chq, 0, cash + chq, 0,
            'deposit:' || p_id::text, p_id, '')
    returning id, doc_number into doc_id, doc_no;
    perform set_config('dp.deposit_doc', '', true);
  end if;
  perform public.finance_log(b, 'deposit.created', 'bank_deposits', p_id::text,
    jsonb_build_object('number', num, 'date', p_date, 'cash', cash, 'cheques', n, 'total', cash + chq, 'location', loc, 'document', doc_no));
  return jsonb_build_object('id', p_id, 'number', num, 'created', true)
         || case when doc_id is not null then jsonb_build_object('document', jsonb_build_object('id', doc_id, 'number', doc_no)) else '{}'::jsonb end;
exception when unique_violation then
  raise exception 'deposit_cheque_taken: a cheque is no longer in the drawer (deposited, matched to the bank or its receipt cancelled)' using errcode = '23505';
end $function$;

CREATE OR REPLACE FUNCTION public.bank_deposit_cancel(p_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare b uuid := public.finance_guard(); d record; lock_end date; doc_id uuid;
begin
  if not public.can_write() then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into d from public.bank_deposits where id = p_id for update;
  if d.id is null or d.business_id <> b then raise exception 'not allowed' using errcode = '42501'; end if;
  if not public.location_allowed(b, d.location_id) then raise exception 'not allowed: this location is not yours' using errcode = '42501'; end if;
  if d.status = 'cancelled' then return jsonb_build_object('id', d.id, 'result', 'already'); end if;
  if length(btrim(coalesce(p_reason, ''))) < 2 then raise exception 'reason_required: a reason or a note, two letters at least' using errcode = '22023'; end if;
  lock_end := public.finance_locked_until(b);
  if lock_end is not null and d.deposited_on <= lock_end then
    raise exception 'period_locked: the books are closed until %', lock_end using errcode = '23514'; end if;
  if exists (select 1 from public.bank_matches m where m.deposit_id = d.id and m.active) then
    raise exception 'deposit_matched: the bank already matched this deposit — undo that match first' using errcode = '23514'; end if;
  update public.bank_deposits set status = 'cancelled', cancel_reason = left(btrim(p_reason), 300), cancelled_at = now(), cancelled_by = auth.uid()
   where id = d.id;
  update public.bank_deposit_cheques set active = false where deposit_id = d.id and active;
  -- 7000: its deposit document (420) is cancelled with it (a deposit recorded before 7000 has none)
  select x.id into doc_id from public.documents x where x.deposit_id = d.id;
  if doc_id is not null and not exists (select 1 from public.document_cancellations c where c.document_id = doc_id) then
    perform set_config('dp.deposit_doc', d.id::text, true);
    insert into public.document_cancellations (document_id, business_id, user_id, reason) values (doc_id, b, auth.uid(), left(btrim(p_reason), 300));
    perform set_config('dp.deposit_doc', '', true);
  end if;
  perform public.finance_log(b, 'deposit.cancelled', 'bank_deposits', d.id::text,
    jsonb_build_object('number', d.number, 'total', d.cash + d.cheques, 'reason', left(btrim(p_reason), 300)));
  return jsonb_build_object('id', d.id, 'result', 'cancelled');
end $function$;

CREATE OR REPLACE FUNCTION public.deposit_book(p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare b uuid := public.report_business(p_from, p_to); f uuid[] := public.location_filter(); res jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'number', d.number, 'date', d.deposited_on, 'location', d.location_id, 'cash', d.cash,
           'cheques', d.cheques, 'total', d.cash + d.cheques, 'note', d.note, 'status', d.status, 'cancelReason', d.cancel_reason,
           'matched', exists (select 1 from public.bank_matches m where m.deposit_id = d.id and m.active),
           'items', coalesce((select jsonb_agg(jsonb_build_object('payment', x.payment_id, 'amount', x.amount, 'number', coalesce(p.reference->>'number', ''),
                                  'bank', coalesce(p.reference->>'bank', ''), 'dueDate', public.iso_date(p.reference->>'dueDate'),
                                  'customer', coalesce(doc.customer_name, ''), 'docType', doc.doc_type, 'docNumber', doc.doc_number) order by p.paid_on, p.id)
                                from public.bank_deposit_cheques x join public.payments p on p.id = x.payment_id
                                left join public.documents doc on doc.id = p.document_id
                               where x.deposit_id = d.id and (x.active or d.status = 'cancelled')), '[]'::jsonb))
           -- 7000: its deposit document (420), when it has one (a deposit recorded before 7000 has none: no key)
           || coalesce((select jsonb_build_object('document', jsonb_build_object('id', x.id, 'number', x.doc_number))
                          from public.documents x where x.deposit_id = d.id), '{}'::jsonb)
         order by d.deposited_on desc, d.number desc), '[]'::jsonb)
    into res
    from public.bank_deposits d
   where d.business_id = b and d.deposited_on between p_from and p_to and (f is null or d.location_id = any (f));
  return res;
end $function$;

-- ============================================================================================================================
-- 7. the owner's switch, the series' first numbers, the branch codes, and what the settings screen reads
-- ============================================================================================================================
-- the numbering of the business, for the settings screen: per location or not, and each location with its code and series (the
-- next number of each type it has a series of); the business's series — the last number of each type
create or replace function public.document_numbering_state() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare b uuid := public.finance_guard(); res jsonb;
begin
  select jsonb_build_object(
    'perLocation', exists (select 1 from public.document_numbering n where n.business_id = b),
    'since', (select n.per_location_since from public.document_numbering n where n.business_id = b),
    'activeLocations', (select count(*) from public.business_locations l where l.business_id = b and l.active),
    'business', coalesce((select jsonb_object_agg(c.doc_type::text, c.last_no) from public.document_counters c where c.business_id = b), '{}'::jsonb),
    'locations', coalesce((select jsonb_agg(jsonb_build_object(
        'id', l.id, 'name', l.name, 'active', l.active, 'branchCode', l.branch_code,
        'codeFixed', exists (select 1 from public.documents x where x.business_id = b and x.series_location_id = l.id),
        'series', coalesce((select jsonb_agg(jsonb_build_object('docType', s.doc_type, 'start', s.start_no, 'last', s.last_no,
                              'next', greatest(s.last_no, s.start_no - 1, coalesce(c.last_no, 0)) + 1) order by s.doc_type)
                              from public.document_series s
                              left join public.document_counters c on c.business_id = s.business_id and c.doc_type = s.doc_type
                             where s.business_id = b and s.location_id = l.id), '[]'::jsonb))
        order by (l.id = b) desc, l.sort, l.created_at)
      from public.business_locations l where l.business_id = b and public.location_allowed(b, l.id)), '[]'::jsonb))
    into res;
  return res;
end $$;

-- the owner switches the business to a series per location — once, never back. A business with more than one active location.
-- Every location gets a branch code (the main one first, then by their order; a code the owner chose stays).
create or replace function public.document_numbering_per_location() returns jsonb
language plpgsql security definer set search_path = public as $$
declare b uuid := public.finance_guard(); n int; l record;
begin
  if not public.can_write() or not public.location_owner() then raise exception 'not allowed' using errcode = '42501'; end if;
  if not public.business_is_active(b) then raise exception 'business_locked' using errcode = '42501'; end if;
  -- one writer at a time (a second tap, a deposit) — "no key update", as the deposits: a document's check of its business never waits
  perform 1 from public.businesses where id = b for no key update;
  if exists (select 1 from public.document_numbering x where x.business_id = b) then return public.document_numbering_state(); end if;
  select count(*) into n from public.business_locations x where x.business_id = b and x.active;
  if n < 2 then
    raise exception 'numbering_one_location: מספור לפי סניף — לעסק עם יותר מסניף פעיל אחד' using errcode = '23514'; end if;
  -- every document being numbered in the business's series right now ends first; one that waits for it after this is refused and
  -- tried again (numbering_switched) — so a location's series always starts after the business's last number
  perform 1 from public.document_counters c where c.business_id = b for update;
  for l in select x.id from public.business_locations x where x.business_id = b and x.branch_code is null
            order by (x.id = b) desc, x.sort, x.created_at, x.id loop
    update public.business_locations set branch_code = public.branch_code_next(b) where id = l.id;
  end loop;
  insert into public.document_numbering (business_id, switched_by) values (b, auth.uid());
  perform public.finance_log(b, 'numbering.per_location', 'document_numbering', b::text,
    jsonb_build_object('locations', n, 'business', coalesce((select jsonb_object_agg(c.doc_type::text, c.last_no) from public.document_counters c where c.business_id = b), '{}'::jsonb)));
  return public.document_numbering_state();
end $$;

-- the first number of a location's series of a type — the owner's, before that series' first document (also before the switch);
-- always after the last number the business's series gave of that type
create or replace function public.document_series_start(p_location uuid, p_doc_type int, p_start bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b uuid := public.finance_guard(); s record; floor_no bigint;
begin
  if not public.can_write() or not public.location_owner() then raise exception 'not allowed' using errcode = '42501'; end if;
  if not public.business_is_active(b) then raise exception 'business_locked' using errcode = '42501'; end if;
  if p_location is null or not exists (select 1 from public.business_locations l where l.id = p_location and l.business_id = b) then
    raise exception 'series_location: a location of the business' using errcode = '22023'; end if;
  if p_doc_type is null or p_doc_type not in (100, 200, 210, 300, 305, 320, 330, 400, 420) then
    raise exception 'series_type: a document type (100, 200, 210, 300, 305, 320, 330, 400, 420)' using errcode = '22023'; end if;
  if p_start is null or p_start < 1 or p_start > 999999999 then
    raise exception 'series_start: a number from 1 to 999,999,999' using errcode = '22023'; end if;
  perform 1 from public.businesses where id = b for no key update;
  select c.last_no into floor_no from public.document_counters c where c.business_id = b and c.doc_type = p_doc_type;
  floor_no := coalesce(floor_no, 0);
  if p_start <= floor_no then
    raise exception 'series_start_low: הסדרה מתחילה אחרי % — המספר האחרון שהעסק כבר הפיק מהסוג הזה', floor_no using errcode = '23514'; end if;
  select * into s from public.document_series x where x.business_id = b and x.location_id = p_location and x.doc_type = p_doc_type for update;
  if (s.business_id is not null and s.last_no >= s.start_no)
     or exists (select 1 from public.documents x where x.business_id = b and x.series_location_id = p_location and x.doc_type = p_doc_type) then
    raise exception 'series_started: לסדרה הזו כבר יש מסמכים — המספר הראשון שלה נקבע' using errcode = '23514'; end if;
  insert into public.document_series (business_id, location_id, doc_type, start_no, last_no)
  values (b, p_location, p_doc_type, p_start, p_start - 1)
  on conflict (business_id, location_id, doc_type) do update set start_no = excluded.start_no, last_no = excluded.last_no, updated_at = now();
  perform public.finance_log(b, 'numbering.series_start', 'document_series', p_location::text,
    jsonb_build_object('type', p_doc_type, 'start', p_start));
  return jsonb_build_object('location', p_location, 'docType', p_doc_type, 'start', p_start);
end $$;

-- the owner sets a location's branch code (1–7 letters or digits, one per business) — until its first document of its series
create or replace function public.location_branch_code_set(p_location uuid, p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b uuid := public.finance_guard(); code text := nullif(btrim(coalesce(p_code, '')), '');
begin
  if not public.can_write() or not public.location_owner() then raise exception 'not allowed' using errcode = '42501'; end if;
  if not public.business_is_active(b) then raise exception 'business_locked' using errcode = '42501'; end if;
  if p_location is null or not exists (select 1 from public.business_locations l where l.id = p_location and l.business_id = b) then
    raise exception 'branch_code_location: a location of the business' using errcode = '22023'; end if;
  if code is not null and code !~ '^[0-9A-Za-z]{1,7}$' then
    raise exception 'branch_code_format: קוד סניף — עד 7 ספרות או אותיות באנגלית' using errcode = '22023'; end if;
  perform 1 from public.businesses where id = b for no key update;
  if exists (select 1 from public.business_locations l where l.business_id = b and l.id <> p_location and upper(l.branch_code) = upper(code)) then
    raise exception 'branch_code_taken: הקוד הזה כבר של סניף אחר' using errcode = '23505'; end if;
  update public.business_locations set branch_code = code where id = p_location and branch_code is distinct from code;
  perform public.finance_log(b, 'location.branch_code', 'business_locations', p_location::text, jsonb_build_object('code', code));
  return jsonb_build_object('location', p_location, 'branchCode', code);
end $$;

revoke execute on function public.document_numbering_state(), public.document_numbering_per_location(),
  public.document_series_start(uuid, int, bigint), public.location_branch_code_set(uuid, text) from public, anon;
grant execute on function public.document_numbering_state(), public.document_numbering_per_location(),
  public.document_series_start(uuid, int, bigint), public.location_branch_code_set(uuid, text) to authenticated, service_role;
-- the trigger functions this migration replaces stay out of every browser role's reach (as before)
revoke execute on function public.documents_before_insert(), public.location_fill(), public.documents_validate(), public.documents_more_checks(),
  public.documents_goods(), public.document_cancellations_check(), public.sale_refunds_receipts() from public, anon, authenticated;

-- ============================================================================================================================
-- Rollback (by hand, if ever needed — the documents issued after this one stay, as every document does):
--   * only while NO business switched (select count(*) from document_numbering = 0) and no 420 was issued
--     (select count(*) from documents where doc_type = 420 = 0): run again, in this order, the old versions of the functions
--     above (from the migrations named in the header: 2000, 4600, 6800, 3200, 5000, 6800, 3200, 6800, 4300, 4300, 4400, 5000,
--     5000, 5000) and the two views of 3100 / 4200; then
--       create unique index documents_business_number_uq on documents (business_id, doc_type, doc_number);
--       drop index documents_number_business_uq, documents_number_location_uq, documents_deposit_uq;
--       drop trigger c_business_locations_branch_code on business_locations;
--       drop function document_numbering_state(), document_numbering_per_location(), document_series_start(uuid, int, bigint),
--         location_branch_code_set(uuid, text), business_locations_branch_code(), branch_code_next(uuid);
--       drop table document_series, document_numbering;
--       alter table documents drop constraint documents_deposit_type_check, drop constraint documents_series_location_fkey;
--       documents_doc_type_check and documents_source_check back to the lists of 5000 / 3100 (without 420 / 'deposit');
--       the columns documents.series_location_id, documents.deposit_id and business_locations.branch_code may stay (empty).
--   * after a business switched or a 420 was issued: no rollback — the numbers given per location and the deposit documents are
--     documents of the books (they are never changed or removed); fix forward.
-- ============================================================================================================================
