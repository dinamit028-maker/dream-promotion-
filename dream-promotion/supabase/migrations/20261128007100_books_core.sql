-- 2.121.0 — stage 4ב: double-entry books, the core (tests/sql/books-core.check.sql, tests/sql/books-core-concurrency.sh).
-- docs/ita-registration/STAGE4_PLAN_HE.md (the owner's approval of 26.11.2026 and the answers 1–17 of 26–27.11.2026, with the
-- accountant). The accountant's answer 9 (25.11.2026): field 1013 = 2 — the software keeps double-entry books.
-- Sources (the official 1.31 instructions, "הוראות להפקת קבצים במבנה אחיד" 1.31, 01/05/2009):
--   * §4.6 (p. 15) B100 "תנועות בהנהלת חשבונות": a transaction (1353 "מספר תנועה" — clarification 7, p. 21: the field that links
--     every line of the journal entry) and its lines (1354), 1356 type, 1357–1360 two references (document type + number — the same
--     number as C100 1204), 1361 details X(50), 1362 date, 1363 value date, 1364 the account (a B110 key), 1366 1 = debit / 2 = credit,
--     1368 the amount, 1371 / 1372 matching ids X(10), 1374 the branch, 1375 the entry date ("given by the system, not changeable" —
--     clarification 12, p. 22), 1376 who did it. The example of p. 15: one entry = several B100 records with the same 1353.
--   * §4.7 (p. 16) B110 "חשבון בהנהלת חשבונות": 1403 the key X(15) ("חד חד ערכי"), 1404 name, 1405 / 1406 the trial-balance code and
--     its description, 1407–1412 the customer's / supplier's address, 1413 the parent account, 1417 the 6111 code, 1419 the dealer
--     number of the supplier / customer ("חובה אם … 1013 = 2"), 1421 the branch.
--   * clarification 12 (p. 22): 1362 the date of the entry, 1363 the day it enters the books (the example: a card deal in 6
--     installments — a line per installment, each with its own value date, the customer credited once), 1375 the day it was entered.
--   * §2.4יא (p. 6): debit and credit movements are positive; §2.4יב / clarification 1: a document's meaning is its type, not its sign.
-- What it does:
--   1. gl_accounts (the chart, per business — B110), gl_transactions (an entry — 1353, 1356–1363, 1375, 1376) and gl_lines (its lines —
--      1354, 1364, 1366, 1368, 1371, 1372, a value date per line). An entry always balances (Σ debit = Σ credit, checked at commit by
--      a DEFERRABLE INITIALLY DEFERRED constraint trigger) and is never changed or removed (append-only): a correction is a reversing
--      entry (gl_transactions.reverses, once). Read by a finance member of the business (never a cashier, never the calendar-only
--      member, never another business; the lines of a location — the locations the person sees); NO browser role writes them — only
--      the functions and triggers below.
--   2. gl_books — the books of a business: since when (start_date), the running entry number, whether the opening balances were
--      entered. Answers 13 / 14: every business keeps double-entry books from the 1st of the month after this migration runs (the
--      businesses that exist now get that date here; a business created later gets the same date, or the 1st of its first month
--      if that is later). Before its start date nothing posts. The owner may move the start date to the 1st of another month while
--      nothing was posted yet (gl_books_start_set — then the documents since then are posted, in time order).
--   3. The default chart (answer 1) — created per business on first need (gl_chart_ensure): cash per location 1100 / 1100-n
--      (answer 6), cheques per location 1150 / 1150-n, BANK (the key the unified file already gives the bank — 420, openformat.ts
--      DEPOSIT_KEY), card clearing 1250, customers 1300 (the parent; a sub-account per customer — its key = field 1225 of its
--      documents), open transaction invoices 1310, tax withheld at source 1350, VAT input 1400, suppliers 2100 (parent), VAT output
--      2200, VAT account 2250, the business's card 2300, opening balances 3100, owner 3200, income — services 4100, goods 4110,
--      exempt 4200 — an expense account per Dream expense category 6101–6117 (expenses.ts, in the same order), cash differences 6900,
--      suspense 9100. A system key never collides with a customer's: system keys are 4 digits (with "-n" for a location's) or BANK;
--      a customer key that looks like one gets the prefix "C-" (gl_customer_key — the TS must write the same 1225: see the report).
--   4. Posting (automatic): DEFERRABLE INITIALLY DEFERRED constraint triggers — at commit, when every row of the transaction is
--      there (the receipt's payments, the deposit's cheques) — on documents (300 / 305 / 320 / 330 / 400), payments (the money of a
--      refund — the register's 'refund', a credit invoice's 'credit', a document's 'reversal'), document_cancellations and
--      bank_deposits (a deposit; its cancellation) → gl_post(source, id): one entry per source, idempotent by its key
--      (<source>:<id>, unique). Amounts are the stored fields of the document / payment / deposit — never computed again; the income
--      line is split by D110's kind (1258: a line of kind 2 → goods 4110, every other → services 4100; the rounding on the last line); VAT
--      on 2200. Money by payment method: cash → the location's cash, cheque → the location's cheques, card → card clearing (a card in
--      installments — answer 8 — a line per installment, monthly value dates), transfer / Bit / PayBox → BANK (answer 7), tax withheld
--      → 1350, other → suspense 9100. Anything without an account → suspense 9100. A posting NEVER blocks a sale: a failure is caught,
--      recorded (gl_post_failures) and listed (gl_unposted) — the document is issued as before; gl_replay posts it again later.
--   5. Answer 8: a card payment in installments (cardKind 2) may say how many ("installments": 2–36) and when the first is due
--      ("firstDue": YYYY-MM-DD, from the payment's day to a year after it; none = the payment's day) — checked by a new trigger
--      (d_documents_installments); nothing else about a document changes.
--   6. gl_opening_balances(lines) — the owner, once: the opening balances the accountant gives, dated the start date, balanced
--      against 3100. gl_replay(business, from) — the sources since a date, in time order, posted if they were not (idempotent).
--      gl_unposted (view) — what should have posted and did not (with the last error). gl_books_state(), gl_trial_balance(from, to).
-- Replaces NOTHING (no function of an earlier migration is changed). New tables, types, functions, triggers and policies only; the
-- existing tables get four deferred triggers that only read them and one BEFORE INSERT check on documents (installments).
-- md5 of prosrc after running (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = '<function>'::regprocedure): in the
-- report of the db-agent (STATUS.md), for the live check after the run.
-- No existing row changes: nothing here updates or removes a row of an existing table (the only rows written are new gl_books rows,
-- one per business, and the one gl_defaults row). The word "delete" appears only in "before update or delete", the policies
-- "_viewer_delete" and the rollback notes — run it in the SQL Editor (the MCP stops on it).
-- Runs after 4600 (locations), 5000 (deposits), 5100 (manual journal — journal_writer), 6800 (stage 1 — cardKind) and 7000 (stage 3
-- — the deposit document, document_numbering) — it stops at the top without them, changing nothing.
-- Deploy order: this migration may run before the code (the screens do not read the books yet; posting starts on the start date).

-- RUN IT AS ONE SCRIPT IN THE SQL EDITOR (one transaction: all of it or nothing). A busy moment never holds the issuing of
-- documents behind it: a table it changes that stays locked for more than 5 seconds stops it ("lock_timeout: … nothing was changed
-- — run it again in a quiet moment"); the triggers on documents, payments, document_cancellations and bank_deposits come last.
set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.documents') is null or to_regclass('public.payments') is null or to_regclass('public.document_cancellations') is null
     or to_regprocedure('public.finance_log(uuid, text, text, text, jsonb)') is null or to_regprocedure('public.finance_append_only()') is null
     or to_regprocedure('public.finance_guard()') is null or to_regprocedure('public.can_write()') is null then
    raise exception 'migration 20261128007100 runs after 20261004003100 (Dream Finance) and 20261005003200 (pilot hardening) — run them first; nothing was changed';
  end if;
  if to_regclass('public.business_locations') is null or to_regprocedure('public.location_filter()') is null then
    raise exception 'migration 20261128007100 runs after 20261010004600 (locations) — run it first; nothing was changed';
  end if;
  if to_regclass('public.bank_deposits') is null or to_regclass('public.bank_deposit_cheques') is null then
    raise exception 'migration 20261128007100 runs after 20261011005000 (deposits) — run it first; nothing was changed';
  end if;
  if to_regprocedure('public.journal_writer()') is null then
    raise exception 'migration 20261128007100 runs after 20261011005100 (manual journal entries) — run it first; nothing was changed';
  end if;
  if to_regprocedure('public.calendar_member()') is null then
    raise exception 'migration 20261128007100 runs after 20261028006000 (calendar access) — run it first; nothing was changed';
  end if;
  if to_regprocedure('public.documents_issue_day()') is null then
    raise exception 'migration 20261128007100 runs after 20261125006800 (the accountant''s answers, stage 1) — run it first; nothing was changed';
  end if;
  if to_regclass('public.document_numbering') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'documents' and column_name = 'deposit_id') then
    raise exception 'migration 20261128007100 runs after 20261127007000 (the accountant''s answers, stage 3) — run it first; nothing was changed';
  end if;
end $$;

-- ============================================================================================================================
-- 1. the tables
-- ============================================================================================================================
-- the date every business's books start from (answer 14: the 1st of the month after this migration runs) — one row, written
-- once (running this again keeps the first date). The server's only.
create table if not exists public.gl_defaults (
  id          boolean primary key default true check (id),
  books_start date not null check (extract(day from books_start) = 1),
  created_at  timestamptz not null default now()
);
insert into public.gl_defaults (id, books_start)
values (true, (date_trunc('month', (now() at time zone 'Asia/Jerusalem')::date) + interval '1 month')::date)
on conflict (id) do nothing;

-- the books of a business: since when, the last entry number (1353 runs per business), the chart's version
create table if not exists public.gl_books (
  business_id   uuid primary key references public.businesses on delete restrict,
  start_date    date not null check (extract(day from start_date) = 1),
  last_tx_no    bigint not null default 0 check (last_tx_no >= 0),
  chart_version int not null default 0,
  opening_tx    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- an account (B110): its key is unique in the business (1403); role = what the system posts to it (one account per role)
create table if not exists public.gl_accounts (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.gl_books (business_id) on delete restrict,
  key           text not null check (length(key) between 1 and 15 and key = rtrim(key)),
  name          text not null check (length(btrim(name)) between 1 and 50),
  kind          text not null check (kind in ('asset', 'liability', 'equity', 'income', 'expense')),
  tb_code       text not null check (length(tb_code) between 1 and 15),
  tb_name       text not null check (length(tb_name) between 1 and 30),
  code_6111     int check (code_6111 is null or code_6111 between 0 and 9999),
  parent_key    text check (parent_key is null or length(parent_key) between 1 and 15),
  role          text check (role is null or length(role) between 1 and 80),
  lead_id       uuid,
  dealer_number text check (dealer_number is null or dealer_number ~ '^[0-9]{9}$'),
  street        text not null default '' check (length(street) <= 50),
  city          text not null default '' check (length(city) <= 30),
  location_id   uuid,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (business_id, key),
  unique (id, business_id),
  foreign key (location_id, business_id) references public.business_locations (id, business_id) on delete restrict
);
create unique index if not exists gl_accounts_role_uq on public.gl_accounts (business_id, role) where role is not null;

-- an entry (the B100 lines with one 1353): what made it (source_kind + source_id, its key unique), the reference documents
create table if not exists public.gl_transactions (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.gl_books (business_id) on delete restrict,
  number          bigint not null check (number > 0),
  tx_date         date not null,
  value_date      date not null,
  entered_at      timestamptz not null default now(),
  entered_on      date not null default ((now() at time zone 'Asia/Jerusalem')::date),
  source_kind     text not null check (source_kind in ('document', 'cancellation', 'payment', 'deposit', 'deposit_cancel', 'opening')),
  source_id       uuid,
  idempotency_key text not null check (length(idempotency_key) between 1 and 120),
  reverses        uuid references public.gl_transactions on delete restrict,
  ref1_type       int,
  ref1_number     text check (ref1_number is null or length(ref1_number) <= 20),
  ref2_type       int,
  ref2_number     text check (ref2_number is null or length(ref2_number) <= 20),
  details         text not null default '' check (length(details) <= 50),
  location_id     uuid not null,
  user_id         uuid,
  unique (business_id, number),
  unique (idempotency_key),
  unique (reverses),
  unique (id, business_id),
  foreign key (location_id, business_id) references public.business_locations (id, business_id) on delete restrict
);
create index if not exists gl_transactions_source_idx on public.gl_transactions (source_kind, source_id);
create index if not exists gl_transactions_date_idx on public.gl_transactions (business_id, tx_date);

-- a line of an entry: one account, one side, an amount above zero to the agora; its own value date (an installment's)
create table if not exists public.gl_lines (
  id             uuid primary key default gen_random_uuid(),
  transaction_id uuid not null,
  business_id    uuid not null,
  line_no        int not null check (line_no between 1 and 99999),
  account_id     uuid not null,
  side           text not null check (side in ('D', 'C')),
  amount         numeric(14,2) not null check (amount > 0),
  value_date     date not null,
  match1         text check (match1 is null or length(match1) between 1 and 10),
  match2         text check (match2 is null or length(match2) between 1 and 10),
  location_id    uuid not null,
  unique (transaction_id, line_no),
  foreign key (transaction_id, business_id) references public.gl_transactions (id, business_id) on delete restrict,
  foreign key (account_id, business_id) references public.gl_accounts (id, business_id) on delete restrict
);
create index if not exists gl_lines_account_idx on public.gl_lines (account_id);
create index if not exists gl_lines_business_idx on public.gl_lines (business_id);

-- a posting that failed (the source was kept; the error is here, and gl_unposted lists the source until it posts)
create table if not exists public.gl_post_failures (
  id          bigint generated always as identity primary key,
  business_id uuid not null references public.gl_books (business_id) on delete restrict,
  source_kind text not null,
  source_id   uuid not null,
  error       text not null default '' check (length(error) <= 600),
  at          timestamptz not null default now()
);
create index if not exists gl_post_failures_source_idx on public.gl_post_failures (source_kind, source_id);

-- the books: every business that exists now, from the default start date (a new business — on first need, gl_books_ensure)
insert into public.gl_books (business_id, start_date)
select b.id, (select d.books_start from public.gl_defaults d) from public.businesses b
on conflict (business_id) do nothing;

-- never changed, never removed (a correction is a reversing entry); the accounts and the books are never removed
do $$
declare t text;
begin
  foreach t in array array['gl_transactions', 'gl_lines', 'gl_post_failures'] loop
    if not exists (select 1 from pg_trigger where tgname = t || '_append_only' and tgrelid = ('public.' || t)::regclass) then
      execute format('create trigger %I before update or delete on public.%I for each row execute function public.finance_append_only()', t || '_append_only', t);
    end if;
  end loop;
  foreach t in array array['gl_accounts', 'gl_books', 'gl_defaults'] loop
    if not exists (select 1 from pg_trigger where tgname = t || '_no_delete' and tgrelid = ('public.' || t)::regclass) then
      execute format('create trigger %I before delete on public.%I for each row execute function public.finance_append_only()', t || '_no_delete', t);
    end if;
  end loop;
  foreach t in array array['gl_transactions', 'gl_lines', 'gl_post_failures', 'gl_accounts', 'gl_books', 'gl_defaults'] loop
    if not exists (select 1 from pg_trigger where tgname = t || '_no_truncate' and tgrelid = ('public.' || t)::regclass) then
      execute format('create trigger %I before truncate on public.%I for each statement execute function public.finance_append_only()', t || '_no_truncate', t);
    end if;
  end loop;
end $$;

-- read by a finance member of the business (never a cashier, never the calendar-only member, never another business; an entry /
-- a line / a location's account — the locations the person sees); NO browser role writes them — only the functions below
do $$
declare
  t text;
  gate        constant text := 'business_id = (select public.current_business_id()) and business_id in (select public.accessible_business_ids())';
  fin         constant text := 'business_id in (select public.finance_business_ids())';
  full_access constant text := '(select public.my_access()) <> ''register''';
  locs        constant text := '(select public.location_filter()) is null or location_id = any ((select public.location_filter())::uuid[])';
  locs_null   constant text := '(select public.location_filter()) is null or location_id is null or location_id = any ((select public.location_filter())::uuid[])';
begin
  foreach t in array array['gl_books', 'gl_accounts', 'gl_transactions', 'gl_lines', 'gl_post_failures'] loop
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
    if t in ('gl_transactions', 'gl_lines') and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_location_gate') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)', t || '_location_gate', t, locs, locs);
    end if;
    if t = 'gl_accounts' and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_location_gate') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)', t || '_location_gate', t, locs_null, locs_null);
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
  -- the server's only: RLS on, no policy, no grant
  alter table public.gl_defaults enable row level security;
  revoke all on public.gl_defaults from public, anon, authenticated;
end $$;

-- ============================================================================================================================
-- 2. the balance: an entry balances at commit (Σ debit = Σ credit, at least two lines) — deferred, so the lines of an entry are
--    written one by one inside the same transaction
-- ============================================================================================================================
create or replace function public.gl_check_balanced() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare tx uuid := (to_jsonb(new)->>(case when tg_table_name = 'gl_lines' then 'transaction_id' else 'id' end))::uuid; d numeric; c numeric; n int;
begin
  select coalesce(sum(amount) filter (where side = 'D'), 0), coalesce(sum(amount) filter (where side = 'C'), 0), count(*)
    into d, c, n from public.gl_lines where transaction_id = tx;
  if n < 2 or d <> c then
    raise exception 'gl_unbalanced: an entry balances — debit % , credit % , % lines', d, c, n using errcode = '23514';
  end if;
  return null;
end $$;
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'gl_lines_balanced' and tgrelid = 'public.gl_lines'::regclass) then
    create constraint trigger gl_lines_balanced after insert on public.gl_lines
      deferrable initially deferred for each row execute function public.gl_check_balanced();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'gl_transactions_balanced' and tgrelid = 'public.gl_transactions'::regclass) then
    create constraint trigger gl_transactions_balanced after insert on public.gl_transactions
      deferrable initially deferred for each row execute function public.gl_check_balanced();
  end if;
end $$;

-- ============================================================================================================================
-- 3. small helpers: a line, the keys, a reference number
-- ============================================================================================================================
do $$
begin
  if to_regtype('public.gl_line_in') is null then
    create type public.gl_line_in as (account_id uuid, side text, amount numeric(14,2), value_date date, match1 text, match2 text);
  end if;
end $$;

-- one line (none when the amount is 0; a negative amount goes on the other side — movements are positive, §2.4יא)
create or replace function public.gl_ln(p_account uuid, p_side text, p_amount numeric, p_value_date date, p_match1 text default null, p_match2 text default null)
returns public.gl_line_in[] language sql immutable set search_path = public, pg_temp as $$
  select case when p_amount is null or round(p_amount, 2) = 0 then '{}'::public.gl_line_in[]
    else array[row(p_account, case when p_amount > 0 then p_side when p_side = 'D' then 'C' else 'D' end, abs(round(p_amount, 2)), p_value_date,
                   left(nullif(btrim(coalesce(p_match1, '')), ''), 10), left(nullif(btrim(coalesce(p_match2, '')), ''), 10))::public.gl_line_in] end
$$;

-- the other side of every line (a reversing entry), each dated p_date (null — as it was)
create or replace function public.gl_swap(p_lines public.gl_line_in[], p_date date default null)
returns public.gl_line_in[] language sql immutable set search_path = public, pg_temp as $$
  select coalesce(array_agg(row(l.account_id, case l.side when 'D' then 'C' else 'D' end, l.amount, coalesce(p_date, l.value_date), l.match1, l.match2)::public.gl_line_in
                            order by o), '{}'::public.gl_line_in[])
    from unnest(p_lines) with ordinality as l(account_id, side, amount, value_date, match1, match2, o)
$$;

-- a date in a document's JSON (YYYY-MM-DD) — null when it is not one
create or replace function public.gl_date(p text) returns date language plpgsql immutable set search_path = public, pg_temp as $$
begin
  if p is null or p !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return null; end if;
  return p::date;
exception when others then return null;
end $$;

-- a system key: four digits (a location's: "-n") or BANK — never a customer's (gl_customer_key)
create or replace function public.gl_key_reserved(p_key text) returns boolean language sql immutable set search_path = public, pg_temp as $$
  select coalesce(p_key ~ '^[0-9]{4}(-[0-9]{1,2})?$' or upper(btrim(p_key)) = 'BANK', false)
$$;

-- a customer's key = field 1225 of its documents as openformat.ts writes it (customerKeyField: the phone, else the name, else
-- 'CASH'; the first 15 characters — the file pads it with spaces, the key here is without them); a key that looks like a system
-- key gets "C-" in front (the TS must write the same 1225 — see the report of 4ב)
create or replace function public.gl_customer_key(p_phone text, p_name text) returns text language sql immutable set search_path = public, pg_temp as $$
  select case when public.gl_key_reserved(k) then rtrim(left('C-' || k, 15)) else k end
    from (select coalesce(nullif(rtrim(left(coalesce(nullif(p_phone, ''), nullif(p_name, ''), 'CASH'), 15)), ''), 'CASH') as k) x
$$;

-- a document's number as C100 1204 writes it (seriesNumber): eight digits for a number of a location's series, else as it is
create or replace function public.gl_doc_ref(p_number bigint) returns text language sql immutable set search_path = public, pg_temp as $$
  select case when p_number is null then null when p_number between 1000000 and 99999999 then lpad(p_number::text, 8, '0') else p_number::text end
$$;

create or replace function public.gl_doc_name(p_type int) returns text language sql immutable set search_path = public, pg_temp as $$
  select case p_type when 300 then 'חשבון עסקה' when 305 then 'חשבונית מס' when 320 then 'חשבונית מס קבלה' when 330 then 'חשבונית מס זיכוי'
                     when 400 then 'קבלה' when 420 then 'הפקדת בנק' else 'מסמך ' || p_type end
$$;

-- ============================================================================================================================
-- 4. the books of a business and its chart
-- ============================================================================================================================
-- the row of a business (created on first need: the default start date, or the 1st of the current month if that is later)
create or replace function public.gl_books_ensure(p_business uuid) returns public.gl_books
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.gl_books;
begin
  select * into r from public.gl_books where business_id = p_business;
  if found then return r; end if;
  insert into public.gl_books (business_id, start_date)
  values (p_business, greatest(coalesce((select d.books_start from public.gl_defaults d),
                                        (date_trunc('month', public.il_today()) + interval '1 month')::date),
                               date_trunc('month', public.il_today())::date))
  on conflict (business_id) do nothing;
  select * into r from public.gl_books where business_id = p_business;
  return r;
end $$;

-- the default chart (answer 1). The main location's cash and cheques are here; another location's — on first need (gl_account)
create or replace function public.gl_chart_default(p_business uuid)
returns table (key text, name text, kind text, tb_code text, tb_name text, parent_key text, role text, location_id uuid)
language sql immutable set search_path = public, pg_temp as $$
  select * from (values
    ('1100', 'קופת מזומן — ראשי', 'asset', '1100', 'קופות מזומן', null::text, 'cash:' || p_business, p_business),
    ('1150', 'צ׳קים בקופה — ראשי', 'asset', '1150', 'צ׳קים לגבייה', null, 'cheques:' || p_business, p_business),
    ('BANK', 'בנק', 'asset', 'BANK', 'בנק', null, 'bank', null::uuid),
    ('1250', 'חברות כרטיסי אשראי (סליקה)', 'asset', '1250', 'חברות כרטיסי אשראי', null, 'card_clearing', null),
    ('1300', 'לקוחות', 'asset', 'CUSTOMERS', 'לקוחות', null, 'customers', null),
    ('1310', 'חשבונות עסקה פתוחים', 'liability', '1310', 'חשבונות עסקה פתוחים', null, 'open_tx_invoices', null),
    ('1350', 'ניכוי במקור מלקוחות', 'asset', '1350', 'ניכוי במקור', null, 'withholding', null),
    ('1400', 'מע״מ תשומות', 'asset', '1400', 'מע״מ תשומות', null, 'vat_input', null),
    ('2100', 'ספקים', 'liability', 'SUPPLIERS', 'ספקים', null, 'suppliers', null),
    ('2200', 'מע״מ עסקאות', 'liability', '2200', 'מע״מ עסקאות', null, 'vat_output', null),
    ('2250', 'חשבון מע״מ', 'liability', '2250', 'חשבון מע״מ', null, 'vat_account', null),
    ('2300', 'כרטיס אשראי של העסק', 'liability', '2300', 'כרטיס אשראי של העסק', null, 'business_card', null),
    ('3100', 'יתרות פתיחה', 'equity', '3100', 'יתרות פתיחה', null, 'opening', null),
    ('3200', 'בעלים', 'equity', '3200', 'בעלים', null, 'owner', null),
    ('4100', 'הכנסות משירותים', 'income', '4000', 'הכנסות', null, 'income_services', null),
    ('4110', 'הכנסות ממכירת סחורה', 'income', '4000', 'הכנסות', null, 'income_goods', null),
    ('4200', 'הכנסות פטורות ממע״מ', 'income', '4000', 'הכנסות', null, 'income_exempt', null),
    ('6101', 'סחורה ומלאי', 'expense', '6100', 'הוצאות', null, 'expense:inventory', null),
    ('6102', 'חומרי עבודה', 'expense', '6100', 'הוצאות', null, 'expense:materials', null),
    ('6103', 'שכירות', 'expense', '6100', 'הוצאות', null, 'expense:rent', null),
    ('6104', 'חשמל, מים וארנונה', 'expense', '6100', 'הוצאות', null, 'expense:utilities', null),
    ('6105', 'טלפון ואינטרנט', 'expense', '6100', 'הוצאות', null, 'expense:communication', null),
    ('6106', 'פרסום ושיווק', 'expense', '6100', 'הוצאות', null, 'expense:marketing', null),
    ('6107', 'תוכנה ומנויים', 'expense', '6100', 'הוצאות', null, 'expense:software', null),
    ('6108', 'שירותים מקצועיים (רו״ח, עו״ד)', 'expense', '6100', 'הוצאות', null, 'expense:professional', null),
    ('6109', 'ציוד', 'expense', '6100', 'הוצאות', null, 'expense:equipment', null),
    ('6110', 'משרד', 'expense', '6100', 'הוצאות', null, 'expense:office', null),
    ('6111', 'רכב ודלק', 'expense', '6100', 'הוצאות', null, 'expense:vehicle', null),
    ('6112', 'עמלות בנק וסליקה', 'expense', '6100', 'הוצאות', null, 'expense:fees', null),
    ('6113', 'כיבוד', 'expense', '6100', 'הוצאות', null, 'expense:refreshments', null),
    ('6114', 'עמלות עובדים', 'expense', '6100', 'הוצאות', null, 'expense:commissions', null),
    ('6115', 'ביטוח', 'expense', '6100', 'הוצאות', null, 'expense:insurance', null),
    ('6116', 'מיסים ואגרות', 'expense', '6100', 'הוצאות', null, 'expense:taxes', null),
    ('6117', 'אחר', 'expense', '6100', 'הוצאות', null, 'expense:other', null),
    ('6900', 'הפרשי קופה', 'expense', '6900', 'הפרשי קופה', null, 'cash_diff', null),
    ('9100', 'חשבון מעבר — לבירור', 'asset', '9100', 'חשבון מעבר', null, 'suspense', null)
  ) as c(key, name, kind, tb_code, tb_name, parent_key, role, location_id)
$$;

-- the chart of a business — every account of the default chart that is not there yet (an account is never changed here)
create or replace function public.gl_chart_ensure(p_business uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.gl_books_ensure(p_business);
  insert into public.gl_accounts (business_id, key, name, kind, tb_code, tb_name, parent_key, role, location_id)
  select p_business, c.key, c.name, c.kind, c.tb_code, c.tb_name, c.parent_key, c.role,
         case when c.location_id is not null and exists (select 1 from public.business_locations l where l.id = c.location_id and l.business_id = p_business)
              then c.location_id end
    from public.gl_chart_default(p_business) c
   where not exists (select 1 from public.gl_accounts a where a.business_id = p_business and (a.key = c.key or a.role = c.role))
  on conflict (business_id, key) do nothing;
  update public.gl_books set chart_version = 1, updated_at = now() where business_id = p_business and chart_version < 1;
end $$;

-- the account of a role (the default chart's; a location's cash / cheques — created on first need: 1100-n / 1150-n); a role
-- with no account → suspense
create or replace function public.gl_account(p_business uuid, p_role text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare a uuid; pre text; loc uuid; l record; base text; k text; n int := 1;
begin
  select id into a from public.gl_accounts where business_id = p_business and role = p_role;
  if a is not null then return a; end if;
  if p_role ~ '^(cash|cheques):[0-9a-f-]{36}$' then
    pre := split_part(p_role, ':', 1);
    loc := split_part(p_role, ':', 2)::uuid;
    select x.id, x.name into l from public.business_locations x where x.id = loc and x.business_id = p_business;
    if l.id is null then
      if loc = p_business then
        perform public.gl_chart_ensure(p_business);
        select id into a from public.gl_accounts where business_id = p_business and role = p_role;
        return coalesce(a, public.gl_account(p_business, 'suspense'));
      end if;
      return public.gl_account(p_business, pre || ':' || p_business);   -- not a location of the business: the main one's
    end if;
    if loc = p_business then perform public.gl_chart_ensure(p_business);
      select id into a from public.gl_accounts where business_id = p_business and role = p_role;
      if a is not null then return a; end if;
    end if;
    base := case pre when 'cash' then '1100' else '1150' end;
    k := base;
    while exists (select 1 from public.gl_accounts x where x.business_id = p_business and x.key = k) loop
      k := base || '-' || n; n := n + 1;
      if n > 99 then return public.gl_account(p_business, 'suspense'); end if;
    end loop;
    insert into public.gl_accounts (business_id, key, name, kind, tb_code, tb_name, role, location_id)
    values (p_business, k, left(case pre when 'cash' then 'קופת מזומן — ' else 'צ׳קים בקופה — ' end || l.name, 50), 'asset', base,
            case pre when 'cash' then 'קופות מזומן' else 'צ׳קים לגבייה' end, p_role, l.id)
    returning id into a;
    return a;
  end if;
  perform public.gl_chart_ensure(p_business);
  select id into a from public.gl_accounts where business_id = p_business and role = p_role;
  if a is null and p_role <> 'suspense' then return public.gl_account(p_business, 'suspense'); end if;
  return a;
end $$;

-- a customer's account (under 1300): by its key (gl_customer_key); its name, address, dealer number (1419) and card — of the
-- first document that opened it
create or replace function public.gl_customer_account(p_business uuid, p_phone text, p_name text, p_dealer text, p_lead uuid, p_street text, p_city text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare k text := public.gl_customer_key(p_phone, p_name); r text; a uuid;
begin
  r := 'customer:' || k;
  select id into a from public.gl_accounts where business_id = p_business and role = r;
  if a is not null then return a; end if;
  perform public.gl_chart_ensure(p_business);
  insert into public.gl_accounts (business_id, key, name, kind, tb_code, tb_name, parent_key, role, lead_id, dealer_number, street, city)
  values (p_business, k, left(coalesce(nullif(btrim(coalesce(p_name, '')), ''), 'לקוח מזדמן'), 50), 'asset', 'CUSTOMERS', 'לקוחות', '1300', r, p_lead,
          case when coalesce(p_dealer, '') ~ '^[0-9]{9}$' then p_dealer end, left(coalesce(p_street, ''), 50), left(coalesce(p_city, ''), 30))
  on conflict (business_id, key) do nothing
  returning id into a;
  if a is null then select id into a from public.gl_accounts where business_id = p_business and key = k; end if;
  return a;
end $$;

create or replace function public.gl_customer_of(d public.documents) returns uuid
language sql security definer set search_path = public, pg_temp as $$
  select public.gl_customer_account(d.business_id, d.customer_phone, d.customer_name, d.customer_dealer, d.lead_id, d.customer_street, d.customer_city)
$$;

-- the account money of a method goes to (answer 7: Bit / PayBox — the bank)
create or replace function public.gl_money_account(p_business uuid, p_method text, p_location uuid) returns uuid
language sql security definer set search_path = public, pg_temp as $$
  select public.gl_account(p_business, case p_method
    when 'cash' then 'cash:' || coalesce(p_location, p_business)
    when 'cheque' then 'cheques:' || coalesce(p_location, p_business)
    when 'card' then 'card_clearing'
    when 'transfer' then 'bank'
    when 'bit' then 'bank'
    when 'withholding' then 'withholding'
    else 'suspense' end)
$$;

-- ============================================================================================================================
-- 5. answer 8: a card payment in installments says how many (optional) — checked when the document is issued
-- ============================================================================================================================
create or replace function public.documents_installments() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare p jsonb; pd date; fd date;
begin
  if jsonb_typeof(new.payments) is distinct from 'array' then return new; end if;
  for p in select value from jsonb_array_elements(new.payments) loop
    if p ? 'installments' or p ? 'firstDue' then
      if p->>'method' is distinct from '3' or coalesce(p->>'cardKind', '') <> '2' then
        raise exception 'installments_card_only: מספר תשלומים — רק בתשלום בכרטיס אשראי מסוג "תשלומים" (cardKind 2)' using errcode = '23514'; end if;
      if not (p ? 'installments') or jsonb_typeof(p->'installments') is distinct from 'number' or coalesce(p->>'installments', '') !~ '^[0-9]{1,2}$'
         or (p->>'installments')::int not between 2 and 36 then
        raise exception 'installments_count: מספר התשלומים — 2 עד 36' using errcode = '23514'; end if;
      if coalesce((p->>'amount')::numeric, 0) <= 0 then
        raise exception 'installments_refund: החזר לא מחולק לתשלומים' using errcode = '23514'; end if;
      if p ? 'firstDue' then
        pd := coalesce(public.gl_date(p->>'date'), new.doc_date, public.il_today());
        fd := public.gl_date(p->>'firstDue');
        if fd is null or fd < pd or fd > pd + 366 then
          raise exception 'installments_first_due: מועד התשלום הראשון — תאריך מיום התשלום ועד שנה אחריו' using errcode = '23514'; end if;
      end if;
    end if;
  end loop;
  return new;
end $$;
create or replace trigger d_documents_installments before insert on public.documents
  for each row execute function public.documents_installments();

-- ============================================================================================================================
-- 6. what an entry is: the lines of each source
-- ============================================================================================================================
-- the income of a document (after its discount, before VAT) on one side: an exempt dealer / a nonprofit — 4200; else by D110's
-- kind (field 1258, the line's "kind" — txKind in openformat.ts: 2 = a sale of goods) — the kind-2 lines on goods 4110, every
-- other (1 service, 3 service and sale, none) on services 4100 (the goods' share rounded, the services take the rest)
create or replace function public.gl_income_lines(p_business uuid, p_side text, p_amount numeric, p_lines jsonb, p_vat boolean, p_date date, p_match text)
returns public.gl_line_in[] language plpgsql security definer set search_path = public, pg_temp as $$
declare g numeric := 0; s numeric := 0; goods numeric;
begin
  if not p_vat then return public.gl_ln(public.gl_account(p_business, 'income_exempt'), p_side, p_amount, p_date, p_match); end if;
  if jsonb_typeof(p_lines) = 'array' then
    select coalesce(sum(coalesce((e->>'totalExVat')::numeric, 0)) filter (where e->>'kind' = '2'), 0),
           coalesce(sum(coalesce((e->>'totalExVat')::numeric, 0)), 0)
      into g, s from jsonb_array_elements(p_lines) e;
  end if;
  if g = 0 or s = 0 then return public.gl_ln(public.gl_account(p_business, 'income_services'), p_side, p_amount, p_date, p_match); end if;
  if g = s then return public.gl_ln(public.gl_account(p_business, 'income_goods'), p_side, p_amount, p_date, p_match); end if;
  goods := round(p_amount * g / s, 2);
  return public.gl_ln(public.gl_account(p_business, 'income_services'), p_side, p_amount - goods, p_date, p_match)
      || public.gl_ln(public.gl_account(p_business, 'income_goods'), p_side, goods, p_date, p_match);
end $$;

-- the money of a document's own payments (its JSON — the rows documents_after_insert writes to payments, one by one, with the
-- same method), on p_side: each on its account; a cheque on its due date, matched by its number; a card in installments — a line
-- per installment, a month apart (the first carries the agorot left over). Returns the lines and their sum.
create or replace function public.gl_money_lines(p_doc public.documents, p_side text, out lines public.gl_line_in[], out total numeric)
language plpgsql security definer set search_path = public, pg_temp as $$
declare p jsonb; m text; amt numeric; pd date; loc uuid := coalesce(p_doc.location_id, p_doc.business_id); n int; ag bigint; each bigint; i int; fd date;
begin
  lines := '{}'; total := 0;
  if jsonb_typeof(p_doc.payments) is distinct from 'array' then return; end if;
  for p in select value from jsonb_array_elements(p_doc.payments) loop
    m := coalesce(nullif(p->>'m', ''), case p->>'method' when '1' then 'cash' when '2' then 'cheque' when '3' then 'card' when '4' then 'transfer' else 'other' end);
    if m not in ('cash', 'card', 'transfer', 'bit', 'cheque', 'other', 'withholding') then m := 'other'; end if;
    amt := abs(coalesce((p->>'amount')::numeric, 0));
    pd := coalesce(public.gl_date(p->>'date'), p_doc.doc_date);
    total := total + amt;
    if m = 'cheque' then
      lines := lines || public.gl_ln(public.gl_money_account(p_doc.business_id, m, loc), p_side, amt,
                                     coalesce(public.gl_date(p->'cheque'->>'dueDate'), pd), p->'cheque'->>'number');
    elsif m = 'card' and coalesce(p->>'installments', '') ~ '^[0-9]{1,2}$' and (p->>'installments')::int between 2 and 36 and amt > 0 then
      n := (p->>'installments')::int; ag := round(amt * 100)::bigint; each := ag / n;
      fd := coalesce(public.gl_date(p->>'firstDue'), pd);
      for i in 0 .. n - 1 loop
        lines := lines || public.gl_ln(public.gl_money_account(p_doc.business_id, m, loc), p_side,
                                       (case when i = 0 then ag - each * (n - 1) else each end)::numeric / 100, (fd + make_interval(months => i))::date);
      end loop;
    else
      lines := lines || public.gl_ln(public.gl_money_account(p_doc.business_id, m, loc), p_side, amt, pd);
    end if;
  end loop;
end $$;

-- a document (the plan, section 3; answers 2 and 4):
--   300 — the customer (debit) / open transaction invoices 1310 (credit), its total
--   305 — the customer / income (after the discount) + VAT output 2200
--   320 — the customer / income + VAT, and the money / the customer; paying a 300 — also 1310 / the customer, what it closes of it
--   330 — income + VAT (debit) / the customer of the credited invoice
--   400 — the money (+ tax withheld 1350) / the customer (of the paid invoice, if it pays one); an exempt dealer (answer 2, cash
--         basis) — also its income 4200: from 1310 for what it closes of a 300, from the customer for the rest
--   400 below zero (an exempt dealer's refund receipt) — the mirror: 4200 / the customer, and the money back: the customer / the
--         money (a register refund's money is its own payment row — posted on its own, below)
-- the customer's lines are matched (1371) by the document they belong to (its link number): an invoice, what paid it and its credits
create or replace function public.gl_lines_document(p_doc uuid) returns public.gl_line_in[]
language plpgsql security definer set search_path = public, pg_temp as $$
declare d public.documents; paid public.documents; base public.documents; vat boolean; refund_receipt boolean; own_money boolean;
  cust uuid; m_own text; m_cust text; r public.gl_line_in[] := '{}'; mon record; clear numeric := 0; open_amt numeric; t numeric;
begin
  select * into d from public.documents where id = p_doc;
  if d.id is null or d.doc_type not in (300, 305, 320, 330, 400) then return r; end if;
  vat := public.entity_charges_vat(coalesce(d.issuer->>'entityType',
           (select public.entity_of(rs.entity_type, rs.business_type) from public.register_settings rs where rs.business_id = d.business_id)));
  refund_receipt := d.doc_type = 400 and d.total < 0;
  own_money := d.doc_type in (320, 400) and not (refund_receipt and d.refund_id is not null);
  m_own := d.link_no::text;
  if d.paid_document_id is not null then select * into paid from public.documents where id = d.paid_document_id; end if;
  if (d.doc_type = 330 or refund_receipt) and d.base_doc_number is not null then
    select * into base from public.documents where business_id = d.business_id and doc_type = d.base_doc_type and doc_number = d.base_doc_number;
  end if;
  if paid.id is not null then cust := public.gl_customer_of(paid); m_cust := paid.link_no::text;
  elsif base.id is not null then cust := public.gl_customer_of(base); m_cust := base.link_no::text;
  else cust := public.gl_customer_of(d); m_cust := m_own; end if;
  t := d.total;

  -- what a receipt closes of the transaction invoice (300) it pays: the 300 less the receipts on it before this one that closed
  -- it too (a 320; an exempt dealer's 400), never below 0 and never more than this receipt
  if paid.id is not null and paid.doc_type = 300 and (d.doc_type = 320 or (d.doc_type = 400 and not vat)) then
    select paid.total - coalesce(sum(x.total), 0) into open_amt from public.documents x
     where x.business_id = d.business_id and x.paid_document_id = paid.id and x.link_no < d.link_no
       and (x.doc_type = 320 or (x.doc_type = 400 and not public.entity_charges_vat(coalesce(x.issuer->>'entityType', 'licensed_dealer'))))
       and not exists (select 1 from public.document_cancellations c where c.document_id = x.id);
    clear := least(t, greatest(coalesce(open_amt, 0), 0));
  end if;

  if d.doc_type = 300 then
    r := public.gl_ln(cust, 'D', t, d.doc_date, m_own) || public.gl_ln(public.gl_account(d.business_id, 'open_tx_invoices'), 'C', t, d.doc_date, m_own);
  elsif d.doc_type = 305 then
    r := public.gl_ln(cust, 'D', t, d.doc_date, m_own)
      || public.gl_income_lines(d.business_id, 'C', d.after_discount, d.lines, vat, d.doc_date, m_own)
      || public.gl_ln(public.gl_account(d.business_id, 'vat_output'), 'C', d.vat_amount, d.doc_date, m_own);
  elsif d.doc_type = 330 then
    r := public.gl_income_lines(d.business_id, 'D', d.after_discount, d.lines, vat, d.doc_date, m_cust)
      || public.gl_ln(public.gl_account(d.business_id, 'vat_output'), 'D', d.vat_amount, d.doc_date, m_cust)
      || public.gl_ln(cust, 'C', t, d.doc_date, m_cust);
  elsif d.doc_type = 320 then
    mon := public.gl_money_lines(d, 'D');
    r := public.gl_ln(cust, 'D', t, d.doc_date, m_own)
      || public.gl_income_lines(d.business_id, 'C', d.after_discount, d.lines, vat, d.doc_date, m_own)
      || public.gl_ln(public.gl_account(d.business_id, 'vat_output'), 'C', d.vat_amount, d.doc_date, m_own)
      || mon.lines || public.gl_ln(cust, 'C', mon.total, d.doc_date, m_own)
      || public.gl_ln(public.gl_account(d.business_id, 'open_tx_invoices'), 'D', clear, d.doc_date, m_cust)
      || public.gl_ln(cust, 'C', clear, d.doc_date, m_cust);
  elsif not refund_receipt then
    mon := public.gl_money_lines(d, 'D');
    r := mon.lines || public.gl_ln(cust, 'C', mon.total, d.doc_date, m_cust);
    if not vat then
      r := r || public.gl_ln(public.gl_account(d.business_id, 'open_tx_invoices'), 'D', clear, d.doc_date, m_cust)
             || public.gl_ln(public.gl_account(d.business_id, 'income_exempt'), 'C', clear, d.doc_date, m_cust)
             || public.gl_ln(cust, 'D', t - clear, d.doc_date, m_cust)
             || public.gl_ln(public.gl_account(d.business_id, 'income_exempt'), 'C', t - clear, d.doc_date, m_cust);
    end if;
  else
    if not vat then
      r := public.gl_ln(public.gl_account(d.business_id, 'income_exempt'), 'D', -t, d.doc_date, m_cust) || public.gl_ln(cust, 'C', -t, d.doc_date, m_cust);
    end if;
    if own_money then
      mon := public.gl_money_lines(d, 'C');
      r := r || public.gl_ln(cust, 'D', mon.total, d.doc_date, m_cust) || mon.lines;
    end if;
  end if;
  return r;
end $$;

-- a payment row of its own (not a document's — those are in the document's entry): money back to the customer — a register
-- refund ('refund'), a credit invoice's refund ('credit' — answer 4: the customer debited, the card back to 0), a document's
-- 'reversal': out — the customer / the money; in — the money / the customer. The customer: of the credit invoice's invoice, of
-- the sale's document; a register refund of a sale with no document — suspense (there is no income of it to give back)
create or replace function public.gl_lines_payment(p_payment uuid) returns public.gl_line_in[]
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.payments; d public.documents; base public.documents; cust uuid; m text; money uuid;
begin
  select * into p from public.payments where id = p_payment;
  if p.id is null or not (p.source in ('refund', 'credit') or (p.source = 'reversal' and p.expense_id is null and p.document_id is not null)) then
    return '{}';
  end if;
  if p.source = 'refund' then
    select * into d from public.documents x
     where x.business_id = p.business_id and p.sale_id is not null and x.sale_id = p.sale_id and x.doc_type in (305, 320, 400) and x.total > 0
     order by x.link_no limit 1;
    if d.id is null then
      select * into d from public.documents x where x.business_id = p.business_id and p.refund_id is not null and x.refund_id = p.refund_id
       order by x.link_no limit 1;
      if d.id is not null and d.base_doc_number is not null then
        select * into base from public.documents x where x.business_id = d.business_id and x.doc_type = d.base_doc_type and x.doc_number = d.base_doc_number;
        if base.id is not null then d := base; end if;
      end if;
    end if;
  else
    select * into d from public.documents x where x.id = p.document_id;
    if d.id is not null and d.doc_type = 330 and d.base_doc_number is not null then
      select * into base from public.documents x where x.business_id = d.business_id and x.doc_type = d.base_doc_type and x.doc_number = d.base_doc_number;
      if base.id is not null then d := base; end if;
    elsif d.id is not null and d.paid_document_id is not null then
      select * into base from public.documents x where x.id = d.paid_document_id;
      if base.id is not null then d := base; end if;
    end if;
  end if;
  if d.id is null then cust := public.gl_account(p.business_id, 'suspense'); m := null;
  else cust := public.gl_customer_of(d); m := d.link_no::text; end if;
  money := public.gl_money_account(p.business_id, p.method, coalesce(p.location_id, p.business_id));
  if p.direction = 'out' then
    return public.gl_ln(cust, 'D', p.amount, p.paid_on, m) || public.gl_ln(money, 'C', p.amount, p.paid_on);
  end if;
  return public.gl_ln(money, 'D', p.amount, p.paid_on) || public.gl_ln(cust, 'C', p.amount, p.paid_on, m);
end $$;

-- a deposit: the bank (debit) / the location's cash and each cheque (credit, matched by the cheque's number — as its receipt's line)
create or replace function public.gl_lines_deposit(p_deposit uuid) returns public.gl_line_in[]
language plpgsql security definer set search_path = public, pg_temp as $$
declare x public.bank_deposits; r public.gl_line_in[]; c record; chq numeric := 0;
begin
  select * into x from public.bank_deposits where id = p_deposit;
  if x.id is null then return '{}'; end if;
  r := public.gl_ln(public.gl_account(x.business_id, 'bank'), 'D', x.cash + x.cheques, x.deposited_on, null, 'D' || x.number)
    || public.gl_ln(public.gl_money_account(x.business_id, 'cash', x.location_id), 'C', x.cash, x.deposited_on, null, 'D' || x.number);
  for c in select q.amount, p.reference->>'number' as num from public.bank_deposit_cheques q left join public.payments p on p.id = q.payment_id
            where q.deposit_id = x.id order by q.payment_id loop
    r := r || public.gl_ln(public.gl_money_account(x.business_id, 'cheque', x.location_id), 'C', c.amount, x.deposited_on, c.num, 'D' || x.number);
    chq := chq + c.amount;
  end loop;
  -- the deposit's cheque total without its rows (never expected): the rest from the cheques account all the same
  r := r || public.gl_ln(public.gl_money_account(x.business_id, 'cheque', x.location_id), 'C', x.cheques - chq, x.deposited_on, null, 'D' || x.number);
  return r;
end $$;

-- ============================================================================================================================
-- 7. posting: one entry per source, once (its key), from the books' start date; never blocks the source (gl_post_safe)
-- ============================================================================================================================
-- the business and the accounting date of a source (null — not a source that posts)
create or replace function public.gl_source_of(p_source text, p_id uuid, out business_id uuid, out source_date date)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  case p_source
    when 'document' then
      select d.business_id, d.doc_date into business_id, source_date from public.documents d where d.id = p_id and d.doc_type in (300, 305, 320, 330, 400);
    when 'cancellation' then
      select c.business_id, (c.created_at at time zone 'Asia/Jerusalem')::date into business_id, source_date
        from public.document_cancellations c join public.documents d on d.id = c.document_id
       where c.document_id = p_id and d.doc_type in (300, 305, 320, 330, 400);
    when 'payment' then
      select p.business_id, p.paid_on into business_id, source_date from public.payments p
       where p.id = p_id and (p.source in ('refund', 'credit') or (p.source = 'reversal' and p.expense_id is null and p.document_id is not null));
    when 'deposit' then
      select x.business_id, x.deposited_on into business_id, source_date from public.bank_deposits x where x.id = p_id;
    when 'deposit_cancel' then
      select x.business_id, (x.cancelled_at at time zone 'Asia/Jerusalem')::date into business_id, source_date
        from public.bank_deposits x where x.id = p_id and x.status = 'cancelled';
    else null;
  end case;
end $$;

create or replace function public.gl_post(p_source text, p_id uuid) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare src record; bk public.gl_books; k text := p_source || ':' || p_id; tx uuid; r public.gl_line_in[] := '{}'; dsum numeric; csum numeric;
  d public.documents; x public.bank_deposits; p public.payments; dt date; loc uuid; usr uuid; rev uuid; det text := '';
  r1t int; r1n text; r2t int; r2n text; dep_doc public.documents; c record;
begin
  if p_source not in ('document', 'cancellation', 'payment', 'deposit', 'deposit_cancel') then
    raise exception 'gl_source_unknown: %', p_source using errcode = '22023'; end if;
  src := public.gl_source_of(p_source, p_id);
  if src.business_id is null then return null; end if;
  bk := public.gl_books_ensure(src.business_id);
  if src.source_date < bk.start_date then return null; end if;          -- before the books start: nothing posts
  -- one writer of a business's books at a time (the entry number, the accounts it opens) — taken first, held to commit
  select * into bk from public.gl_books where business_id = src.business_id for update;
  select id into tx from public.gl_transactions where idempotency_key = k;
  if tx is not null then return tx; end if;
  if bk.chart_version < 1 then perform public.gl_chart_ensure(src.business_id); end if;
  dt := src.source_date;

  if p_source = 'document' then
    select * into d from public.documents where id = p_id;
    r := public.gl_lines_document(p_id);
    loc := coalesce(d.location_id, d.business_id); usr := d.user_id;
    r1t := d.doc_type; r1n := public.gl_doc_ref(d.doc_number);
    if d.paid_document_id is not null then
      select doc_type, public.gl_doc_ref(doc_number) into r2t, r2n from public.documents where id = d.paid_document_id;
    elsif d.base_doc_number is not null then
      r2t := d.base_doc_type; r2n := public.gl_doc_ref(d.base_doc_number);
    end if;
    det := public.gl_doc_name(d.doc_type) || ' ' || r1n || case when btrim(d.customer_name) <> '' then ' — ' || btrim(d.customer_name) else '' end;
  elsif p_source = 'cancellation' then
    select * into d from public.documents where id = p_id;
    select * into c from public.document_cancellations where document_id = p_id;
    select id into rev from public.gl_transactions where idempotency_key = 'document:' || p_id;
    if rev is not null then
      select coalesce(array_agg(row(l.account_id, case l.side when 'D' then 'C' else 'D' end, l.amount, dt, l.match1, l.match2)::public.gl_line_in order by l.line_no), '{}')
        into r from public.gl_lines l where l.transaction_id = rev;
    else
      r := public.gl_swap(public.gl_lines_document(p_id), dt);            -- a document of before the books: its effect, reversed
    end if;
    loc := coalesce(d.location_id, d.business_id); usr := c.user_id;
    r1t := d.doc_type; r1n := public.gl_doc_ref(d.doc_number);
    det := 'ביטול ' || public.gl_doc_name(d.doc_type) || ' ' || r1n;
  elsif p_source = 'payment' then
    select * into p from public.payments where id = p_id;
    r := public.gl_lines_payment(p_id);
    loc := coalesce(p.location_id, p.business_id); usr := p.user_id;
    select * into d from public.documents where id = coalesce(p.document_id, (select x2.id from public.documents x2 where p.refund_id is not null and x2.refund_id = p.refund_id
                                                                                order by x2.link_no limit 1));
    if d.id is not null then r1t := d.doc_type; r1n := public.gl_doc_ref(d.doc_number); end if;
    det := case p.source when 'refund' then 'החזר כספי בקופה' when 'credit' then 'החזר כספי על זיכוי' else 'החזרת תשלום' end
        || case when r1n is not null then ' ' || r1n else '' end;
  elsif p_source = 'deposit' then
    select * into x from public.bank_deposits where id = p_id;
    r := public.gl_lines_deposit(p_id);
    loc := x.location_id; usr := x.user_id;
    select * into dep_doc from public.documents where deposit_id = x.id;
    if dep_doc.id is not null then r1t := 420; r1n := public.gl_doc_ref(dep_doc.doc_number); end if;
    det := 'הפקדה ' || x.number;
  else
    select * into x from public.bank_deposits where id = p_id;
    select id into rev from public.gl_transactions where idempotency_key = 'deposit:' || p_id;
    if rev is not null then
      select coalesce(array_agg(row(l.account_id, case l.side when 'D' then 'C' else 'D' end, l.amount, dt, l.match1, l.match2)::public.gl_line_in order by l.line_no), '{}')
        into r from public.gl_lines l where l.transaction_id = rev;
    else
      r := public.gl_swap(public.gl_lines_deposit(p_id), dt);
    end if;
    loc := x.location_id; usr := x.cancelled_by;
    select * into dep_doc from public.documents where deposit_id = x.id;
    if dep_doc.id is not null then r1t := 420; r1n := public.gl_doc_ref(dep_doc.doc_number); end if;
    det := 'ביטול הפקדה ' || x.number;
  end if;

  if coalesce(cardinality(r), 0) = 0 then return null; end if;           -- nothing to post (never expected)
  -- the balance (never expected to differ: the amounts are the source's own): a difference goes to suspense, never lost
  select coalesce(sum(l.amount) filter (where l.side = 'D'), 0), coalesce(sum(l.amount) filter (where l.side = 'C'), 0) into dsum, csum
    from unnest(r) as l(account_id, side, amount, value_date, match1, match2);
  if dsum <> csum then r := r || public.gl_ln(public.gl_account(src.business_id, 'suspense'), 'C', dsum - csum, dt); end if;
  if exists (select 1 from unnest(r) as l(account_id, side, amount, value_date, match1, match2) where l.account_id is null) then
    raise exception 'gl_account_missing: a line with no account' using errcode = '23514'; end if;
  if not exists (select 1 from public.business_locations bl where bl.id = loc and bl.business_id = src.business_id) then loc := src.business_id; end if;

  insert into public.gl_transactions (business_id, number, tx_date, value_date, source_kind, source_id, idempotency_key, reverses,
                                      ref1_type, ref1_number, ref2_type, ref2_number, details, location_id, user_id)
  values (src.business_id, bk.last_tx_no + 1, dt, dt, p_source, p_id, k, rev, r1t, r1n, r2t, r2n, left(det, 50), loc, usr)
  returning id into tx;
  insert into public.gl_lines (transaction_id, business_id, line_no, account_id, side, amount, value_date, match1, match2, location_id)
  select tx, src.business_id, l.o, l.account_id, l.side, l.amount, coalesce(l.value_date, dt), l.match1, l.match2, loc
    from unnest(r) with ordinality as l(account_id, side, amount, value_date, match1, match2, o);
  update public.gl_books set last_tx_no = last_tx_no + 1, updated_at = now() where business_id = src.business_id;
  return tx;
end $$;

-- the trigger's call: a failure never blocks the source — it is recorded, and the source stays in gl_unposted
create or replace function public.gl_post_safe(p_source text, p_id uuid) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare b uuid;
begin
  return public.gl_post(p_source, p_id);
exception when others then
  begin
    b := (public.gl_source_of(p_source, p_id)).business_id;
    if b is not null then
      perform public.gl_books_ensure(b);
      insert into public.gl_post_failures (business_id, source_kind, source_id, error) values (b, p_source, p_id, left(sqlstate || ' ' || sqlerrm, 600));
    end if;
  exception when others then null;
  end;
  return null;
end $$;

-- whether a source of this date posts (the books of the business have started by then) — the triggers' WHEN: before the start
-- nothing is even queued, so a transaction that writes these tables before the start date runs exactly as before
create or replace function public.gl_books_active(p_business uuid, p_date date) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select p_business is not null and p_date is not null
     and p_date >= coalesce((select b.start_date from public.gl_books b where b.business_id = p_business),
                            greatest(coalesce((select d.books_start from public.gl_defaults d), (date_trunc('month', public.il_today()) + interval '1 month')::date),
                                     date_trunc('month', public.il_today())::date))
$$;

create or replace function public.gl_on_document() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin perform public.gl_post_safe('document', new.id); return null; end $$;
create or replace function public.gl_on_cancellation() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin perform public.gl_post_safe('cancellation', new.document_id); return null; end $$;
create or replace function public.gl_on_payment() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin perform public.gl_post_safe('payment', new.id); return null; end $$;
create or replace function public.gl_on_deposit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then perform public.gl_post_safe('deposit', new.id);
  elsif new.status = 'cancelled' and old.status is distinct from 'cancelled' then perform public.gl_post_safe('deposit_cancel', new.id); end if;
  return null;
end $$;

-- ============================================================================================================================
-- 8. the owner: the start date, the opening balances; the server / the owner: replay
-- ============================================================================================================================
-- every source of a business since a date (and the books' start), in time order, posted if it was not (idempotent)
create or replace function public.gl_replay(p_business uuid, p_from date default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare bk public.gl_books; f date; s record; before_n bigint; failed int := 0; tx uuid;
begin
  if auth.uid() is not null then
    if p_business is distinct from public.finance_guard() or not public.journal_writer() or not public.can_write() then
      raise exception 'not allowed' using errcode = '42501'; end if;
  end if;
  if p_business is null or not exists (select 1 from public.businesses where id = p_business) then
    raise exception 'gl_business: a business' using errcode = '22023'; end if;
  perform public.gl_books_ensure(p_business);
  select * into bk from public.gl_books where business_id = p_business for update;
  f := greatest(coalesce(p_from, bk.start_date), bk.start_date);
  select count(*) into before_n from public.gl_transactions where business_id = p_business;
  for s in
    select * from (
      select 'document'::text as k, d.id, d.doc_date as dt, d.issued_at as ts, 1 as o, d.link_no as seq from public.documents d
       where d.business_id = p_business and d.doc_type in (300, 305, 320, 330, 400) and d.doc_date >= f
      union all
      select 'payment', p.id, p.paid_on, p.created_at, 2, 0::bigint from public.payments p
       where p.business_id = p_business and p.paid_on >= f
         and (p.source in ('refund', 'credit') or (p.source = 'reversal' and p.expense_id is null and p.document_id is not null))
      union all
      select 'deposit', x.id, x.deposited_on, x.created_at, 3, x.number::bigint from public.bank_deposits x where x.business_id = p_business and x.deposited_on >= f
      union all
      select 'cancellation', c.document_id, (c.created_at at time zone 'Asia/Jerusalem')::date, c.created_at, 4, d.link_no
        from public.document_cancellations c join public.documents d on d.id = c.document_id
       where c.business_id = p_business and d.doc_type in (300, 305, 320, 330, 400) and (c.created_at at time zone 'Asia/Jerusalem')::date >= f
      union all
      select 'deposit_cancel', x.id, (x.cancelled_at at time zone 'Asia/Jerusalem')::date, x.cancelled_at, 5, x.number::bigint from public.bank_deposits x
       where x.business_id = p_business and x.status = 'cancelled' and (x.cancelled_at at time zone 'Asia/Jerusalem')::date >= f
    ) q
    where not exists (select 1 from public.gl_transactions t where t.idempotency_key = q.k || ':' || q.id)
    order by q.dt, q.ts, q.o, q.seq, q.id
  loop
    tx := public.gl_post_safe(s.k, s.id);
    if tx is null and exists (select 1 from public.gl_post_failures pf where pf.source_kind = s.k and pf.source_id = s.id and pf.at >= now()) then
      failed := failed + 1; end if;
  end loop;
  return jsonb_build_object('business', p_business, 'from', f,
    'posted', (select count(*) from public.gl_transactions where business_id = p_business) - before_n, 'failed', failed);
end $$;

-- the owner moves the start of the books to the 1st of a month (answer 13 — a business switching mid-year; the demo) while nothing
-- was posted yet; then every source since then posts, in time order
create or replace function public.gl_books_start_set(p_start date) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare b uuid := public.finance_guard(); bk public.gl_books; lock_end date; res jsonb;
begin
  if not public.can_write() or not public.journal_writer() then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_start is null or extract(day from p_start) <> 1 or p_start > (date_trunc('month', public.il_today()) + interval '1 month')::date
     or p_start < date '2000-01-01' then
    raise exception 'books_start_date: תחילת הספרים — ה-1 בחודש, עד החודש הבא' using errcode = '22023'; end if;
  perform public.gl_books_ensure(b);
  select * into bk from public.gl_books where business_id = b for update;
  if exists (select 1 from public.gl_transactions t where t.business_id = b) then
    raise exception 'books_started: כבר נרשמו פקודות בספרים — אי אפשר להזיז את תאריך ההתחלה' using errcode = '23514'; end if;
  lock_end := public.finance_locked_until(b);
  if lock_end is not null and p_start <= lock_end then
    raise exception 'period_locked: the books are closed until %', lock_end using errcode = '23514'; end if;
  update public.gl_books set start_date = p_start, updated_at = now() where business_id = b;
  perform public.finance_log(b, 'books.start', 'gl_books', b::text, jsonb_build_object('from', bk.start_date, 'to', p_start));
  res := public.gl_replay(b, p_start);
  return jsonb_build_object('startDate', p_start) || res;
end $$;

-- the opening balances (answer 14 — the owner, from the accountant), once: [{ "account": "<key>", "side": "D" | "C", "amount": n },
-- …] — an account of the chart (a customer's new one: also "name"), dated the start date; what does not balance goes to 3100
create or replace function public.gl_opening_balances(p_lines jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare b uuid := public.finance_guard(); bk public.gl_books; e jsonb; a uuid; k text; s text; amt numeric; r public.gl_line_in[] := '{}';
  dsum numeric := 0; csum numeric := 0; tx uuid; lock_end date; nm text;
begin
  if not public.can_write() or not public.journal_writer() then raise exception 'not allowed' using errcode = '42501'; end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 or jsonb_array_length(p_lines) > 2000 then
    raise exception 'opening_lines: רשימת יתרות (1 עד 2000 שורות)' using errcode = '22023'; end if;
  perform public.gl_chart_ensure(b);
  select * into bk from public.gl_books where business_id = b for update;
  if bk.opening_tx is not null or exists (select 1 from public.gl_transactions where idempotency_key = 'opening:' || b) then
    raise exception 'opening_done: יתרות הפתיחה כבר נרשמו (תיקון — בפקודה)' using errcode = '23514'; end if;
  lock_end := public.finance_locked_until(b);
  if lock_end is not null and bk.start_date <= lock_end then
    raise exception 'period_locked: the books are closed until %', lock_end using errcode = '23514'; end if;
  for e in select value from jsonb_array_elements(p_lines) loop
    k := btrim(coalesce(e->>'account', '')); s := e->>'side';
    if jsonb_typeof(e->'amount') is distinct from 'number' then raise exception 'opening_amount: סכום — מספר' using errcode = '22023'; end if;
    amt := (e->>'amount')::numeric;
    if s not in ('D', 'C') or amt is null or amt <= 0 or amt <> round(amt, 2) or amt > 999999999999 then
      raise exception 'opening_line: כל שורה — חשבון, חובה / זכות (D / C) וסכום מעל 0, עד אגורות' using errcode = '22023'; end if;
    select id into a from public.gl_accounts where business_id = b and key = k;
    if a is null then
      nm := btrim(coalesce(e->>'name', ''));
      if k = '' or length(k) > 15 or nm = '' or public.gl_key_reserved(k) then
        raise exception 'opening_account: חשבון % לא נמצא (לקוח חדש — עם שם, ומפתח שאינו של המערכת)', k using errcode = '22023'; end if;
      insert into public.gl_accounts (business_id, key, name, kind, tb_code, tb_name, parent_key, role)
      values (b, k, left(nm, 50), 'asset', 'CUSTOMERS', 'לקוחות', '1300', 'customer:' || k) returning id into a;
    end if;
    if a = public.gl_account(b, 'opening') then raise exception 'opening_account: חשבון יתרות הפתיחה מתאזן לבד' using errcode = '22023'; end if;
    r := r || public.gl_ln(a, s, amt, bk.start_date);
    if s = 'D' then dsum := dsum + amt; else csum := csum + amt; end if;
  end loop;
  r := r || public.gl_ln(public.gl_account(b, 'opening'), 'C', dsum - csum, bk.start_date);
  if coalesce(cardinality(r), 0) < 2 then raise exception 'opening_lines: לפחות שורה אחת עם סכום' using errcode = '22023'; end if;
  insert into public.gl_transactions (business_id, number, tx_date, value_date, source_kind, source_id, idempotency_key, details, location_id, user_id)
  values (b, bk.last_tx_no + 1, bk.start_date, bk.start_date, 'opening', b, 'opening:' || b, 'יתרות פתיחה', b, auth.uid())
  returning id into tx;
  insert into public.gl_lines (transaction_id, business_id, line_no, account_id, side, amount, value_date, match1, match2, location_id)
  select tx, b, l.o, l.account_id, l.side, l.amount, l.value_date, l.match1, l.match2, b
    from unnest(r) with ordinality as l(account_id, side, amount, value_date, match1, match2, o);
  update public.gl_books set last_tx_no = last_tx_no + 1, opening_tx = tx, updated_at = now() where business_id = b;
  perform public.finance_log(b, 'books.opening', 'gl_transactions', tx::text, jsonb_build_object('debit', dsum, 'credit', csum, 'lines', jsonb_array_length(p_lines)));
  return jsonb_build_object('id', tx, 'number', bk.last_tx_no + 1, 'date', bk.start_date, 'debit', dsum, 'credit', csum, 'opening', dsum - csum);
end $$;

-- ============================================================================================================================
-- 9. reading (the TS): the state, what did not post, a minimal trial balance (4ג builds the reports)
-- ============================================================================================================================
-- what should have posted and did not: a source of the books' time, with no entry (and its last error)
create or replace view public.gl_unposted with (security_invoker = true) as
select s.business_id, s.source_kind, s.source_id, s.source_date, s.label,
       (select f.error from public.gl_post_failures f where f.source_kind = s.source_kind and f.source_id = s.source_id order by f.at desc limit 1) as error
  from (
    select d.business_id, 'document'::text as source_kind, d.id as source_id, d.doc_date as source_date,
           public.gl_doc_name(d.doc_type) || ' ' || public.gl_doc_ref(d.doc_number) as label
      from public.documents d where d.doc_type in (300, 305, 320, 330, 400)
    union all
    select c.business_id, 'cancellation', c.document_id, (c.created_at at time zone 'Asia/Jerusalem')::date,
           'ביטול ' || public.gl_doc_name(d.doc_type) || ' ' || public.gl_doc_ref(d.doc_number)
      from public.document_cancellations c join public.documents d on d.id = c.document_id where d.doc_type in (300, 305, 320, 330, 400)
    union all
    select p.business_id, 'payment', p.id, p.paid_on, case p.source when 'refund' then 'החזר כספי בקופה' when 'credit' then 'החזר כספי על זיכוי' else 'החזרת תשלום' end
      from public.payments p where p.source in ('refund', 'credit') or (p.source = 'reversal' and p.expense_id is null and p.document_id is not null)
    union all
    select x.business_id, 'deposit', x.id, x.deposited_on, 'הפקדה ' || x.number from public.bank_deposits x
    union all
    select x.business_id, 'deposit_cancel', x.id, (x.cancelled_at at time zone 'Asia/Jerusalem')::date, 'ביטול הפקדה ' || x.number
      from public.bank_deposits x where x.status = 'cancelled'
  ) s
  join public.gl_books b on b.business_id = s.business_id and s.source_date >= b.start_date
 where not exists (select 1 from public.gl_transactions t where t.idempotency_key = s.source_kind || ':' || s.source_id);
revoke all on public.gl_unposted from anon, public;
grant select on public.gl_unposted to authenticated;

-- the state of the books of the current business (a finance member)
create or replace function public.gl_books_state() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare b uuid := public.finance_guard(); bk public.gl_books;
begin
  bk := public.gl_books_ensure(b);
  return jsonb_build_object('startDate', bk.start_date, 'started', public.il_today() >= bk.start_date,
    'transactions', bk.last_tx_no, 'openingEntered', bk.opening_tx is not null,
    'canMoveStart', not exists (select 1 from public.gl_transactions t where t.business_id = b),
    'owner', public.journal_writer());
end $$;

-- a minimal trial balance (by the entry's date): per account — the balance before p_from, the debits and credits of the period,
-- the balance at its end (debit positive). Through RLS (the business, the locations the person sees; a cashier — nothing)
create or replace function public.gl_trial_balance(p_from date, p_to date)
returns table (account_id uuid, key text, name text, kind text, tb_code text, tb_name text, parent_key text,
               opening numeric, debit numeric, credit numeric, closing numeric)
language sql stable security invoker set search_path = public, pg_temp as $$
  select a.id, a.key, a.name, a.kind, a.tb_code, a.tb_name, a.parent_key,
         coalesce(sum(case when t.tx_date < p_from then case l.side when 'D' then l.amount else -l.amount end end), 0) as opening,
         coalesce(sum(l.amount) filter (where l.side = 'D' and t.tx_date >= p_from), 0) as debit,
         coalesce(sum(l.amount) filter (where l.side = 'C' and t.tx_date >= p_from), 0) as credit,
         coalesce(sum(case l.side when 'D' then l.amount else -l.amount end), 0) as closing
    from public.gl_lines l
    join public.gl_transactions t on t.id = l.transaction_id
    join public.gl_accounts a on a.id = l.account_id
   where t.tx_date <= p_to
   group by a.id, a.key, a.name, a.kind, a.tb_code, a.tb_name, a.parent_key
   order by a.key
$$;

-- ============================================================================================================================
-- 10. the triggers on the sources — last (they take a short lock on documents, payments, document_cancellations, bank_deposits)
-- ============================================================================================================================
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'zz_gl_post' and tgrelid = 'public.documents'::regclass) then
    create constraint trigger zz_gl_post after insert on public.documents deferrable initially deferred
      for each row when (new.doc_type in (300, 305, 320, 330, 400) and public.gl_books_active(new.business_id, new.doc_date)) execute function public.gl_on_document();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'zz_gl_post' and tgrelid = 'public.payments'::regclass) then
    create constraint trigger zz_gl_post after insert on public.payments deferrable initially deferred
      for each row when ((new.source in ('refund', 'credit') or (new.source = 'reversal' and new.expense_id is null and new.document_id is not null))
                         and public.gl_books_active(new.business_id, new.paid_on))
      execute function public.gl_on_payment();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'zz_gl_post' and tgrelid = 'public.document_cancellations'::regclass) then
    create constraint trigger zz_gl_post after insert on public.document_cancellations deferrable initially deferred
      for each row when (public.gl_books_active(new.business_id, (new.created_at at time zone 'Asia/Jerusalem')::date)) execute function public.gl_on_cancellation();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'zz_gl_post' and tgrelid = 'public.bank_deposits'::regclass) then
    create constraint trigger zz_gl_post after insert on public.bank_deposits deferrable initially deferred
      for each row when (public.gl_books_active(new.business_id, new.deposited_on)) execute function public.gl_on_deposit();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'zz_gl_post_cancel' and tgrelid = 'public.bank_deposits'::regclass) then
    create constraint trigger zz_gl_post_cancel after update of status on public.bank_deposits deferrable initially deferred
      for each row when (new.status = 'cancelled' and old.status is distinct from 'cancelled'
                         and public.gl_books_active(new.business_id, (new.cancelled_at at time zone 'Asia/Jerusalem')::date)) execute function public.gl_on_deposit();
  end if;
end $$;

-- ============================================================================================================================
-- 11. who may call what
-- ============================================================================================================================
revoke execute on function public.gl_check_balanced(), public.gl_books_ensure(uuid), public.gl_chart_ensure(uuid), public.gl_account(uuid, text),
  public.gl_customer_account(uuid, text, text, text, uuid, text, text), public.gl_customer_of(public.documents), public.gl_money_account(uuid, text, uuid),
  public.documents_installments(), public.gl_income_lines(uuid, text, numeric, jsonb, boolean, date, text), public.gl_money_lines(public.documents, text),
  public.gl_lines_document(uuid), public.gl_lines_payment(uuid), public.gl_lines_deposit(uuid), public.gl_source_of(text, uuid),
  public.gl_post(text, uuid), public.gl_post_safe(text, uuid), public.gl_on_document(), public.gl_on_cancellation(), public.gl_on_payment(),
  public.gl_on_deposit() from public, anon, authenticated;
grant execute on function public.gl_post(text, uuid), public.gl_lines_document(uuid) to service_role;
revoke execute on function public.gl_replay(uuid, date), public.gl_books_start_set(date), public.gl_opening_balances(jsonb), public.gl_books_state(),
  public.gl_trial_balance(date, date), public.gl_chart_default(uuid) from public, anon;
grant execute on function public.gl_replay(uuid, date), public.gl_books_start_set(date), public.gl_opening_balances(jsonb), public.gl_books_state(),
  public.gl_trial_balance(date, date) to authenticated, service_role;
grant execute on function public.gl_customer_key(text, text), public.gl_key_reserved(text), public.gl_doc_ref(bigint), public.gl_doc_name(int)
  to authenticated, service_role;
-- the triggers' WHEN runs as whoever writes the source (a cashier's sale, the server, a function of any role) — it must never be
-- refused, or the sale would be: open to every role (a yes / no on a business's start date, nothing else)
grant execute on function public.gl_books_active(uuid, date) to public;

-- ============================================================================================================================
-- Rollback (by hand, if ever needed — nothing of an earlier migration was changed, so nothing comes back):
--   * stop the posting first (the sources work as before without it):
--       drop trigger zz_gl_post on documents; drop trigger zz_gl_post on payments; drop trigger zz_gl_post on document_cancellations;
--       drop trigger zz_gl_post on bank_deposits; drop trigger zz_gl_post_cancel on bank_deposits;
--       drop trigger d_documents_installments on documents;   -- a card payment's "installments" / "firstDue" then stay unchecked
--   * only while nothing was posted (select count(*) from gl_transactions = 0) — else the entries are the books: keep them, fix forward:
--       drop view gl_unposted;
--       drop function gl_trial_balance(date, date), gl_books_state(), gl_opening_balances(jsonb), gl_books_start_set(date),
--         gl_replay(uuid, date), gl_books_active(uuid, date), gl_on_deposit(), gl_on_payment(), gl_on_cancellation(), gl_on_document(), gl_post_safe(text, uuid),
--         gl_post(text, uuid), gl_source_of(text, uuid), gl_lines_deposit(uuid), gl_lines_payment(uuid), gl_lines_document(uuid),
--         gl_money_lines(documents, text), gl_income_lines(uuid, text, numeric, jsonb, boolean, date, text), documents_installments(),
--         gl_money_account(uuid, text, uuid), gl_customer_of(documents), gl_customer_account(uuid, text, text, text, uuid, text, text),
--         gl_account(uuid, text), gl_chart_ensure(uuid), gl_chart_default(uuid), gl_books_ensure(uuid), gl_doc_name(int),
--         gl_doc_ref(bigint), gl_customer_key(text, text), gl_key_reserved(text), gl_date(text), gl_swap(gl_line_in[], date),
--         gl_ln(uuid, text, numeric, date, text, text), gl_check_balanced();
--       drop table gl_lines, gl_transactions, gl_post_failures, gl_accounts, gl_books, gl_defaults;
--       drop type gl_line_in;
-- ============================================================================================================================
