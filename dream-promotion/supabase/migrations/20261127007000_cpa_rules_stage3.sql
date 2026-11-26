-- 2.120.0 — the accountant's answers of 25.11.2026, stage 3: the database (tests/sql/cpa-rules-stage3.check.sql).
-- docs/ita-registration/CPA_ANSWERS_HE.md row 5 ("סדרת מספור לכל סניף") and row 18 ("הפקדות (420) נכנסות לקובץ, עם D120"); the
-- owner's decisions of 26.11.2026 (the number of a location's document: its two-digit branch number, then its running number; a
-- credit / a refund receipt is of the location that issues it). For NEW rows only: no issued document, payment, deposit or
-- cancellation changes (nothing here updates or deletes a row of a business; the columns added come empty; business_locations.
-- branch_code is filled only when the owner switches — section 7).
-- Sources (the official 1.31 instructions, "הוראות להפקת קבצים במבנה אחיד" 1.31, 01/05/2009):
--   * clarification 3 (appendix 5.5, p. 21): a business with branches fills the branch id (fields 1231 C100, 1270 / 1272 D110,
--     1320 D120, 1374 B100, 1421 B110 — X(7), "כפי שמופיע ברישומי בית העסק") and field 1034 = 1 (A100, p. 10).
--   * §2.4ד (p. 6): the document number (1204, X(20)) — digits only may be written as they are or with leading zeros
--     (00000000000000001234 or 1234), the same way in every field that carries it (1204, 1257, 1304, 1357, 1359).
--   * appendix 1 (§5.1, p. 18): 420 "הפקדת בנק" is a document type of the software, as 300 / 400; §4.5 (p. 14) D120 is
--     "פרטי קבלה / הפקדה" — a line per payment means (cash, each cheque with bank / branch / account / number / due date);
--     §2.6ב (p. 9): the software reports, for every document type of appendix 1, how many and how much; C100 1228 "מסמך מבוטל".
--   1. (answer 5) numbering per location — ONE-WAY, by the owner: document_numbering_per_location() (more than one active
--      location; the business's own series all below 1,000,000). Every location gets a branch code, two digits 01–99
--      (business_locations.branch_code; the main location 01, then 02, 03 … by their order; the owner may change one —
--      location_branch_code_set — until the location's first document of its series). From then on a new document's number is
--      the branch code and then the location's running number of that type, six digits (document_series): 01000001, 01000002 …
--      02000001 … — stored as the number (doc_number bigint: 1000001), printed with eight digits (the leading zero). A number
--      therefore never repeats in the business: the unique key stays (business, type, number), and a document's base (fields
--      1256 / 1257) is found by its type and number in the business, as before. documents.series_location_id = the location whose
--      series numbered it (null = the business's one series: every document before the switch, every document of a business that
--      never switches — numbered exactly as before). After the switch a credit invoice (330) and a refund receipt (400) are of the
--      location that issues them — their base no longer decides it, and a register's / an order's refund's document is of the refund's
--      location, not its sale's (location_fill); everything else as before.
--   2. (answer 18) a bank deposit is a document: bank_deposit_create also issues a 420 "הפקדת בנק" (documents, numbered — per
--      location after the switch — immutable, documents.deposit_id = the deposit; no customer, no lines, no VAT; its payments = the
--      D120 lines: the cash — method 1 — and each cheque — method 2 — with its details from the receipt's payment), only when the
--      business has its dealer number (a deposit without one is recorded as before, with no document). bank_deposit_cancel cancels
--      it (document_cancellations, the same reason) — it is never cancelled any other way, and never issued any other way
--      (dp.deposit_doc, local to the transaction). It moves no money (not 320 / 400: no payments row) and no stock, and is not
--      income. Deposits recorded before this migration keep no document (not filled in).
-- Replaces (same signatures). md5 of prosrc — BEFORE running, compare the old one with the live database; AFTER running, the new one:
--   select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = '<function>'::regprocedure
--   function                                                       of     old                               new
--   documents_before_insert()                                      2000   a359c23999aa55af4caed03c6c54490e  c8f587e9e8a6684d097a5ae476088f13
--   location_fill()                                                4600   22c55035af64c141afcb7d8eadfe7aaf  9452e2f2b2e9b4b8517b8ea37fbff667
--   documents_validate()                                           6800   e5548d72677674ac2dabce186a7b479d  3e87d64ca55746aa6d1370386c5687f4
--   document_cancellations_check()                                 6800   b53c444e7da9734db600da34097e13f3  625b00ea9a1d98e58f0f2b6f580655e8
--   bank_deposit_create(uuid, date, uuid, numeric, uuid[], text)   5000   70d1de91696e64e7b9b444c6a30f52e2  aba23f2946ee19eac9f407ee2bbb9c01
--   bank_deposit_cancel(uuid, text)                                5000   3ea735f01acc605d88036cdfce316a33  bf2d8b5f0565f08c8206d219c7bbfa48
--   deposit_book(date, date)                                       5000   41dcaa7ad4711e6e5a3680d19b73cdf9  00ee0edead4aca0dd5303a1b92cfa06a
--   document_share_open(text, text)                                6900   2429d169e4f89e4bd605efea4f5e4d4e  069c9f0affc97db9fb1e5a04c557c5ff
--   document_delivery_record(uuid, text)                           6900   44f9741cad327061fa405b8fbeac8de5  84cbf0b906146016e825b49ad16f7756
-- New (md5 after running): document_numbering_state() ce968273890d4a4023113859fb1030f3, document_numbering_per_location()
--   22e474acf47c02da78aaf4b32d42087f, location_branch_code_set(uuid, text) 400aef8db50e679d5b5254b177eb9f6b,
--   business_locations_branch_code() 6fdb0d05ef7a8503f5675801f537fa77, branch_code_next(uuid) f973460e39c21b30722c3675e6e941f2.
-- Running 2000, 4600, 5000, 6800 or 6900 again after this one brings back an old function (one series per business, a credit where its
-- invoice is, a deposit without its document, a deposit's link that records a delivery) — then run this one again.
-- Deploy order: THE CODE FIRST, then this migration: after it, a deposit issues a 420 that the old screens do not know (a list
-- would show a document with no name), and the numbers of a business that switches are printed with their leading zero only by
-- the new screens.
-- It drops and adds again the checks documents_doc_type_check (+ 420) and documents_source_check (+ 'deposit') — run it in the
-- SQL Editor (the MCP stops on the word drop). No `delete` statement (the word is in "on delete restrict", the triggers "before
-- update or delete" and the policies "_viewer_delete"; `drop` / `delete` otherwise only in the rollback notes at the end).
-- Runs after 4600 (locations), 5000 (deposits, the goods documents), 6800 (stage 1) and 6900 (stage 2) — it stops at the top
-- without them, changing nothing.

-- a busy moment never holds the issuing of documents behind this migration: a table it changes that is locked for more than 5
-- seconds stops it (its steps on documents and on business_locations are each all-or-nothing, with the message "lock_timeout …"
-- — nothing of that step changed); it runs again safely: run it again in a quiet moment
set lock_timeout = '5s';

do $$
begin
  if to_regclass('public.documents') is null or to_regclass('public.document_counters') is null
     or to_regprocedure('public.documents_before_insert()') is null or to_regprocedure('public.finance_log(uuid, text, text, text, jsonb)') is null
     or to_regprocedure('public.finance_append_only()') is null or to_regprocedure('public.finance_guard()') is null
     or to_regprocedure('public.can_write()') is null or to_regprocedure('public.business_is_active(uuid)') is null then
    raise exception 'migration 20261127007000 runs after 20261004003100 (Dream Finance) and 20261005003200 (pilot hardening) — run them first; nothing was changed';
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
-- 1. the columns and the checks of documents (the unique key stays: one number per business and type)
-- ============================================================================================================================
-- the location whose series numbered the document (7000); null = the business's one series — every document issued before
-- the business switched, and every document of a business that never does. Set by documents_number only. (The number itself
-- carries the location: its branch code and then its running number — see section 4.)
-- one statement on documents, in a block: either all of it or none of it. lock_timeout (top of the file): a busy moment (documents
-- being issued) stops it after 5 seconds instead of holding every issue behind it — run the migration again in a quiet moment.
do $$
begin
  alter table public.documents
    add column if not exists series_location_id uuid,
    add column if not exists deposit_id uuid references public.bank_deposits (id) on delete restrict,
    -- 420 "הפקדת בנק" (1.31 appendix 1); source 'deposit'
    drop constraint if exists documents_doc_type_check,
    add constraint documents_doc_type_check check (doc_type in (100, 200, 210, 300, 305, 320, 330, 400, 420)),
    drop constraint if exists documents_source_check,
    add constraint documents_source_check check (source is null or source in ('pos', 'direct', 'quote', 'refund', 'credit', 'receipt', 'deposit'));
  if not exists (select 1 from pg_constraint where conname = 'documents_series_location_fkey' and conrelid = 'public.documents'::regclass) then
    alter table public.documents add constraint documents_series_location_fkey
      foreign key (series_location_id, business_id) references public.business_locations (id, business_id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'documents_deposit_type_check' and conrelid = 'public.documents'::regclass) then
    alter table public.documents add constraint documents_deposit_type_check check ((deposit_id is not null) = (doc_type = 420));
  end if;
  create unique index if not exists documents_deposit_uq on public.documents (deposit_id) where deposit_id is not null;
exception when lock_not_available then
  raise exception 'lock_timeout: the documents table is busy right now (documents being issued) — nothing of this step changed; run the migration again in a quiet moment';
end $$;

-- ============================================================================================================================
-- 2. numbering per location: the switch (one-way) and the series
-- ============================================================================================================================
-- a row = the business numbers per location, since then. Never changed, never removed.
create table if not exists public.document_numbering (
  business_id        uuid primary key references public.businesses on delete restrict,
  per_location_since timestamptz not null default now(),
  switched_by        uuid references auth.users on delete set null
);
-- a location's series of a document type: its last running number (1 … 999,999 — the document's number is the branch code
-- and then this number, six digits)
create table if not exists public.document_series (
  business_id uuid not null references public.businesses on delete restrict,
  location_id uuid not null,
  doc_type    int  not null check (doc_type in (100, 200, 210, 300, 305, 320, 330, 400, 420)),
  last_no     bigint not null check (last_no between 0 and 999999),
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
-- 3. the branch code of a location: two digits, 01–99 (the owner, 26.11.2026: "the first two digits are the branch number") —
--    the first two digits of its documents' numbers, and the branch id of the unified file (fields 1231, 1270, 1272, 1320, 1374,
--    1421 — X(7))
-- ============================================================================================================================
do $$
begin
  alter table public.business_locations add column if not exists branch_code text
    check (branch_code is null or branch_code ~ '^(0[1-9]|[1-9][0-9])$');
  create unique index if not exists business_locations_branch_code_uq on public.business_locations (business_id, branch_code)
    where branch_code is not null;
exception when lock_not_available then
  raise exception 'lock_timeout: the locations table is busy right now — nothing of this step changed; run the migration again in a quiet moment';
end $$;

-- the next free code of a business: the smallest of 01–99 no location of it carries (a business has 10 locations at most)
create or replace function public.branch_code_next(p_business uuid) returns text
language sql stable security definer set search_path = public as $$
  select lpad(min(g)::text, 2, '0') from generate_series(1, 99) g
   where not exists (select 1 from public.business_locations l where l.business_id = p_business and l.branch_code = lpad(g::text, 2, '0'));
$$;
revoke execute on function public.branch_code_next(uuid) from public, anon, authenticated;

-- a location opened after the business switched gets the next code; a code stays once the location numbered a document in its
-- series, and a business that numbers per location never loses one
create or replace function public.business_locations_branch_code() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    if new.branch_code is distinct from old.branch_code then
      if exists (select 1 from public.document_series s where s.business_id = old.business_id and s.location_id = old.id and s.last_no > 0) then
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
do $$
begin
  create or replace trigger c_business_locations_branch_code before insert or update on public.business_locations
    for each row execute function public.business_locations_branch_code();
exception when lock_not_available then
  raise exception 'lock_timeout: the locations table is busy right now — run the migration again in a quiet moment (it runs again safely)';
end $$;

-- ============================================================================================================================
-- 4. the numbering (documents_number) — replaces documents_before_insert() of 20261004002000
-- ============================================================================================================================
create or replace function public.documents_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare n bigint; loc uuid; code text;
begin
  if new.business_id is null then raise exception 'a document must belong to a business'; end if;
  new.series_location_id := null;
  if exists (select 1 from public.document_numbering x where x.business_id = new.business_id) then
    -- 7000 (the accountant, answer 5; the owner, 26.11.2026): a series per location and type — the branch code (two digits),
    -- then the location's running number (six digits): 01000001, 01000002 … / 02000001 … Never the number of another location
    -- (its code differs) or of the business's series of before (below 1,000,000 — document_numbering_per_location). The
    -- location is locked for share: its code does not change while its document is numbered (business_locations_branch_code)
    loc := coalesce(new.location_id, new.business_id);
    select l.branch_code into code from public.business_locations l where l.id = loc and l.business_id = new.business_id for share;
    if code is null or code !~ '^(0[1-9]|[1-9][0-9])$' then
      raise exception 'branch_code_missing: לסניף אין קוד סניף (01–99)' using errcode = '23514'; end if;
    insert into public.document_series (business_id, location_id, doc_type, last_no) values (new.business_id, loc, new.doc_type, 0)
      on conflict (business_id, location_id, doc_type) do nothing;
    update public.document_series set last_no = last_no + 1, updated_at = now()
     where business_id = new.business_id and location_id = loc and doc_type = new.doc_type and last_no < 999999 returning last_no into n;
    if n is null then
      raise exception 'series_full: הסדרה של הסניף הגיעה ל-999,999 מסמכים מהסוג הזה' using errcode = '23514'; end if;
    n := code::int * 1000000 + n;
    new.series_location_id := loc;
  else
    insert into public.document_counters(user_id, business_id, doc_type, last_no) values (new.user_id, new.business_id, new.doc_type, 0)
      on conflict (business_id, doc_type) do nothing;
    update public.document_counters set last_no = last_no + 1
      where business_id = new.business_id and doc_type = new.doc_type returning last_no into n;
  end if;
  new.doc_number := n;
  new.issued_at := now();
  new.print_count := 0;
  return new;
end $$;

-- ============================================================================================================================
-- 5. after the switch, a credit invoice / a refund receipt is of the location that issues it — replaces location_fill() of
--    20261010004600 (only its "documents" part changed: a business that never switches — as before); the 420 in
--    documents_validate() and document_cancellations_check() of 20261125006800
-- ============================================================================================================================
CREATE OR REPLACE FUNCTION public.location_fill()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare loc uuid; rloc uuid; rb uuid; ractive boolean;
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
        -- 7000 (the owner, 26.11.2026): in a business that numbers per location, the document of a refund (a credit invoice 330,
        -- a refund receipt 400 — the register's or an order's refund) is of the refund's location (the register that paid it
        -- out), not of its sale's
        if new.refund_id is not null and new.doc_type in (330, 400)
           and exists (select 1 from public.document_numbering n where n.business_id = new.business_id) then
          select coalesce(r.location_id, r.business_id) into loc from public.sale_refunds r
           where r.id = new.refund_id and r.business_id = new.business_id;
        end if;
        if loc is null then
        select coalesce(
          (select coalesce(s.location_id, s.business_id) from public.sales s where s.id = new.sale_id),
          (select coalesce(r.location_id, r.business_id) from public.sale_refunds r where r.id = new.refund_id),
          (select coalesce(d.location_id, d.business_id) from public.documents d where d.id = new.paid_document_id),
          (select coalesce(d.location_id, d.business_id) from public.document_drafts d where d.id = new.draft_id),
          -- 7000 (the owner, 26.11.2026): in a business that numbers per location, a credit invoice (330) and a refund receipt
          -- (400) are of the location that issues them (its series) — their base no longer decides where they go
          (select coalesce(d.location_id, d.business_id) from public.documents d
            where new.base_doc_number is not null and d.business_id = new.business_id and d.doc_type = new.base_doc_type
              and d.doc_number = new.base_doc_number
              and not (new.doc_type in (330, 400) and exists (select 1 from public.document_numbering n where n.business_id = new.business_id))
            limit 1)) into loc;
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

-- replaces documents_validate() of 20261125006800 (the 420 part)
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
    select id, total, sale_id into base from public.documents
     where business_id = new.business_id and doc_type = 400 and doc_number = new.base_doc_number for update;
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
     where c.business_id = new.business_id and c.doc_type = 400 and c.total < 0 and c.base_doc_type = 400 and c.base_doc_number = new.base_doc_number;
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
    select id, total, before_discount, discount, after_discount, vat_amount into base from public.documents
     where business_id = new.business_id and doc_type = new.base_doc_type and doc_number = new.base_doc_number for update;
    if not found then raise exception 'the credited invoice was not found in this business' using errcode = '23514'; end if;
    select coalesce(sum(c.total), 0) into done from public.documents c
     where c.business_id = new.business_id and c.doc_type = 330 and c.base_doc_type = new.base_doc_type and c.base_doc_number = new.base_doc_number;
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

-- replaces document_cancellations_check() of 20261125006800 (a 420 only with its deposit)
CREATE OR REPLACE FUNCTION public.document_cancellations_check()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare d record; lock_end date;
begin
  select id, business_id, doc_type, doc_number, doc_date, base_doc_number, deposit_id into d from public.documents where id = new.document_id for update;
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
                                              and not exists (select 1 from public.document_cancellations c where c.document_id = x.id)) then
    raise exception 'cancel_has_followers: a document was made from it — cancel that one first' using errcode = '23514'; end if;
  -- a return note stays once its delivery note was invoiced (the invoice counted what came back)
  if d.doc_type = 210 and exists (select 1 from public.documents x
                                    where x.business_id = d.business_id and x.base_doc_type = 200 and x.base_doc_number = d.base_doc_number
                                      and x.doc_type in (300, 305, 320)
                                      and not exists (select 1 from public.document_cancellations c where c.document_id = x.id)) then
    raise exception 'cancel_has_followers: its delivery note was invoiced' using errcode = '23514'; end if;
  new.created_at := now();
  return new;
end $function$;

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

-- ---- a deposit document is never the customer's: its link opens nothing and records nothing — replaces document_share_open()
--      of 20261126006900 (one line added: a 420 is "not_found", before any delivery is recorded)
create or replace function public.document_share_open(p_token text, p_channel text default 'link') returns jsonb
language plpgsql security definer set search_path = public as $$
declare d public.documents;
begin
  if coalesce(p_channel, '') not in ('link', 'pdf', 'storefront') then raise exception 'delivery_channel: link, pdf or storefront' using errcode = '22023'; end if;
  if coalesce(p_token, '') !~ '^[a-f0-9]{64}$' then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  select * into d from public.documents where share_token = p_token for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  if d.doc_type = 420 then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;   -- 7000: a deposit, not a customer's document
  if not public.business_is_active(d.business_id) then return jsonb_build_object('ok', false, 'code', 'unavailable'); end if;
  if public.allocation_awaiting(d) then return jsonb_build_object('ok', false, 'code', 'awaiting_allocation'); end if;
  return public.document_delivery_add(d, p_channel, null);
end $$;
-- (create or replace keeps its grants: service_role only, as 6900 set them)

-- … and from the app (print / mail / WhatsApp / PDF): a deposit document is never delivered — replaces document_delivery_record()
--    of 20261126006900 (one line added: a 420 is refused before anything is recorded)
create or replace function public.document_delivery_record(p_document uuid, p_channel text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d public.documents;
begin
  if coalesce(p_channel, '') not in ('print', 'email', 'whatsapp', 'pdf') then raise exception 'delivery_channel: print, email, whatsapp or pdf' using errcode = '22023'; end if;
  select * into d from public.documents where id = p_document for update;
  if not found or not public.document_visible(d) then raise exception 'not allowed' using errcode = '42501'; end if;
  if d.doc_type = 420 then raise exception 'deposit_not_delivered: מסמך הפקדה לא נמסר ללקוח' using errcode = '55000'; end if;   -- 7000
  if not public.can_write() then raise exception 'not allowed: read-only role' using errcode = '42501'; end if;
  if public.allocation_awaiting(d) then
    raise exception 'awaiting_allocation: המסמך דורש מספר הקצאה — הוא נמסר ללקוח (הדפסה, קישור, שליחה) רק אחרי שהמספר התקבל'
      using errcode = '55000';
  end if;
  return public.document_delivery_add(d, p_channel, auth.uid());
end $$;
-- (create or replace keeps its grants: authenticated, as 6900 set them)

-- ============================================================================================================================
-- 7. the owner's switch, the branch codes, and what the settings screen reads
-- ============================================================================================================================
-- the numbering of the business, for the settings screen: per location or not, and each location with its code and series (the
-- last and the next number of each type it numbered, as printed — eight digits); the business's series — the last number of each type
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
        'codeFixed', exists (select 1 from public.document_series s where s.business_id = b and s.location_id = l.id and s.last_no > 0),
        'series', coalesce((select jsonb_agg(jsonb_build_object('docType', s.doc_type, 'count', s.last_no,
                              'last', lpad((l.branch_code::int * 1000000 + s.last_no)::text, 8, '0'),
                              'next', lpad((l.branch_code::int * 1000000 + s.last_no + 1)::text, 8, '0')) order by s.doc_type)
                              from public.document_series s
                             where s.business_id = b and s.location_id = l.id and l.branch_code is not null), '[]'::jsonb))
        order by (l.id = b) desc, l.sort, l.created_at)
      from public.business_locations l where l.business_id = b and public.location_allowed(b, l.id)), '[]'::jsonb))
    into res;
  return res;
end $$;

-- the owner switches the business to a series per location — once, never back. A business with more than one active location,
-- whose own series are all below 1,000,000 (a location's numbers start at 01000001). Every location gets a branch code (the main
-- one 01, then by their order; a code the owner chose stays).
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
  if exists (select 1 from public.document_counters c where c.business_id = b and c.last_no >= 1000000) then
    raise exception 'numbering_long_series: לעסק כבר יש מספר מסמך של 7 ספרות — מספור לפי סניף מתחיל ב-01000001' using errcode = '23514'; end if;
  -- (a document being numbered in the business's series right now still takes the business's next number: below 1,000,000,
  -- never the number of a location — nothing to wait for)
  for l in select x.id from public.business_locations x where x.business_id = b and x.branch_code is null
            order by (x.id = b) desc, x.sort, x.created_at, x.id loop
    update public.business_locations set branch_code = public.branch_code_next(b) where id = l.id;
  end loop;
  insert into public.document_numbering (business_id, switched_by) values (b, auth.uid());
  perform public.finance_log(b, 'numbering.per_location', 'document_numbering', b::text,
    jsonb_build_object('locations', n, 'business', coalesce((select jsonb_object_agg(c.doc_type::text, c.last_no) from public.document_counters c where c.business_id = b), '{}'::jsonb)));
  return public.document_numbering_state();
end $$;

-- the owner sets a location's branch code (two digits, 01–99, one per business) — until its first document of its series
create or replace function public.location_branch_code_set(p_location uuid, p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b uuid := public.finance_guard(); code text := nullif(btrim(coalesce(p_code, '')), '');
begin
  if not public.can_write() or not public.location_owner() then raise exception 'not allowed' using errcode = '42501'; end if;
  if not public.business_is_active(b) then raise exception 'business_locked' using errcode = '42501'; end if;
  if p_location is null or not exists (select 1 from public.business_locations l where l.id = p_location and l.business_id = b) then
    raise exception 'branch_code_location: a location of the business' using errcode = '22023'; end if;
  if code ~ '^[1-9]$' then code := '0' || code; end if;   -- 1 → 01
  if code is not null and code !~ '^(0[1-9]|[1-9][0-9])$' then
    raise exception 'branch_code_format: קוד סניף — שתי ספרות, 01 עד 99' using errcode = '22023'; end if;
  perform 1 from public.businesses where id = b for no key update;
  if exists (select 1 from public.business_locations l where l.business_id = b and l.id <> p_location and l.branch_code = code) then
    raise exception 'branch_code_taken: הקוד הזה כבר של סניף אחר' using errcode = '23505'; end if;
  update public.business_locations set branch_code = code where id = p_location and branch_code is distinct from code;
  perform public.finance_log(b, 'location.branch_code', 'business_locations', p_location::text, jsonb_build_object('code', code));
  return jsonb_build_object('location', p_location, 'branchCode', code);
end $$;

revoke execute on function public.document_numbering_state(), public.document_numbering_per_location(),
  public.location_branch_code_set(uuid, text) from public, anon;
grant execute on function public.document_numbering_state(), public.document_numbering_per_location(),
  public.location_branch_code_set(uuid, text) to authenticated, service_role;
-- the trigger functions this migration replaces stay out of every browser role's reach (as before)
revoke execute on function public.documents_before_insert(), public.location_fill(), public.documents_validate(),
  public.document_cancellations_check() from public, anon, authenticated;

-- ============================================================================================================================
-- Rollback (by hand, if ever needed — the documents issued after this one stay, as every document does):
--   * only while NO business switched (select count(*) from document_numbering = 0) and no 420 was issued
--     (select count(*) from documents where doc_type = 420 = 0): run again the old versions of the functions above (from the
--     migrations named in the header: 2000, 4600, 6800, 6800, 5000, 5000, 5000, 6900); then
--       drop index documents_deposit_uq;
--       drop trigger c_business_locations_branch_code on business_locations;
--       drop function document_numbering_state(), document_numbering_per_location(), location_branch_code_set(uuid, text),
--         business_locations_branch_code(), branch_code_next(uuid);
--       drop table document_series, document_numbering;
--       alter table documents drop constraint documents_deposit_type_check, drop constraint documents_series_location_fkey;
--       documents_doc_type_check and documents_source_check back to the lists of 5000 / 3100 (without 420 / 'deposit');
--       the columns documents.series_location_id, documents.deposit_id and business_locations.branch_code may stay (empty).
--   * after a business switched or a 420 was issued: no rollback — the numbers given per location and the deposit documents are
--     documents of the books (they are never changed or removed); fix forward.
-- ============================================================================================================================
reset lock_timeout;
