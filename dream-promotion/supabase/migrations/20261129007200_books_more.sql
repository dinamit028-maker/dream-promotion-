-- 2.122.0 — stage 4ג: double-entry books, the rest of the sources, the manual double entry, the reports
-- (tests/sql/books-more.check.sql, tests/sql/books-more-concurrency.sh). docs/ita-registration/STAGE4_PLAN_HE.md (the owner's
-- approval of 26.11.2026 and the answers 1–20 of 26–27.11.2026, with the accountant); 7100 (books core) runs before it.
-- Sources (the official 1.31 instructions, 01/05/2009): §4.6 (p. 15) B100 — an entry = several lines with one 1353, 1366 debit /
-- credit, 1368 the amount (positive, §2.4יא), 1361 details X(50), 1363 the value date, 1371 / 1372 matching; §4.7 (p. 16) B110 —
-- the account key 1403 X(15) unique, 1405 / 1406 the trial-balance code, 1413 the parent account, 1419 the supplier's dealer number.
-- What it does (all of it from each business's books start date — gl_books.start_date — and never before it):
--   1. Expenses (answers 5, 12: goods bought and equipment are expenses). A confirmed expense → its category's account (6101–6117:
--      the amount before VAT + the VAT that is not deducted) + VAT input 1400 (round(vat × deductible % / 100, 2) — only a VAT
--      business deducts, as finance_summary) / the supplier (a sub-account under 2100: key "S" + the dealer number, else "S-" +
--      the normalized name — the same supplier as report_suppliers / party_key). A supplier's credit note — the mirror. A paid
--      expense whose supplier changes moves what was paid to the new supplier in the same entry. An expense
--      is "kept in sync": a change of what it posts (a confirmed expense edited before it is paid, or voided) reverses its entry
--      (dated the entry's own date — the books of the period then say what finance_summary says) and posts it again if it is
--      still confirmed. Its money (payments.source 'expense' and the void's 'reversal'): paid — the supplier / the money (cash →
--      the location's cash, card → the business's card 2300, transfer / Bit → BANK, cheque → 2150 cheques to pay, other →
--      suspense 9100); money back (a credit note) — the mirror.
--   2. The bank. A matched line posts nothing twice: a transfer / Bit / deposit is in BANK already. A card payment matched →
--      BANK / 1250 (money out: 1250 / BANK); the business's card paid (an expense by card matched) → 2300 / BANK; a cheque cleared
--      directly → BANK / the location's cheques (an expense's cheque: 2150 / BANK); "other" → BANK / suspense. Unmatching reverses
--      it. Answer 17: a line of the books' time handled without a document is posted to an account (bank_line_classify —
--      whoever handles the bank, as bank_line_handle: the account / BANK); the old "handled without a match" (bank_line_handle) refuses such a line;
--      bank_line_reopen of a classified line reverses its entry.
--   3. The register's day: register_shifts.difference (counted − expected) ≠ 0 at closing → 6900 / the location's cash (short) or
--      the cash / 6900 (over) — in sync like an expense (a changed closed day is reversed and posted again).
--   4. The manual double entry (answer 15): gl_manual_create — the owner, a balanced entry of any lines (accounts by key, D / C,
--      amounts), dated from the books' start to today, not in closed books; gl_manual_reverse — a reversing entry, once. Once the
--      books have started, the old one-sided journal_entry_create / journal_entry_reverse refuse (the old entries stay, read-only).
--   5. Reports (security invoker — the business and the locations of the person, never a cashier; report_business's guard):
--      report_trial_balance, report_ledger, report_journal, report_profit_loss, report_balance_sheet (answer 16), and gl_reconcile —
--      the books against finance_summary (income, expenses, profit, VAT), the receivables, the cash desks and the cash differences.
--   6. The chart (the owner): gl_account_add (a key of four digits, "-n" allowed — never a customer's key), gl_account_update
--      (name, trial-balance code; the key only of an account the owner added, before its first movement), gl_account_set_active
--      (system accounts are never deactivated; an account with a balance is not deactivated). Nothing is ever removed.
-- Posting never blocks the source (as 7100): a failure is recorded (gl_post_failures) and listed (gl_unposted), gl_replay posts it.
-- Replaces (same signatures) — md5 of prosrc. BEFORE running, compare the old one with the live database; AFTER, the new one:
--   select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = '<function>'::regprocedure
--   function                                                          of     old                               new
--   gl_post_safe(text, uuid)                                          7100   07dc3e5b6b16618c844d4194166024ca  2b357f5884b58dfaab93c094e11b45de
--   journal_entry_create(uuid, date, text, numeric, numeric, text, text, text, uuid, jsonb)
--                                                                     5100   bd86c4b468622631e62d97cee45a2024  2d8ff26f70e05d1e11b73df4068e9de7
--   journal_entry_reverse(uuid, uuid, date, text)                     5100   812aa37a4e6e1a07602dde179a590404  c47435a61aa92a51ecaf1e426d009134
--   bank_line_handle(uuid, text)                                      5000   d427b10d56b3009b657edfb9e4790e03  84d19d8e5aa92364a854e9490a8e06e2
--   bank_line_reopen(uuid)                                            5000   fab202148af12b0a96e797261d0b2499  25bbcb053ab1788fd39db80fbf707bf1
--   gl_key_reserved(text)                                             7100   8c13361c82be9fb00504da119cd4cd3a  4aae5a733c41a197d474ec27d6b3d31d
--   gl_customer_account(uuid, text, text, text, uuid, text, text)     7100   f5098d61fcaf7cfb8ebb9f01b7b06b0c  3dbd3be79a1180dce191d80bf80c8b7d
--   view gl_unposted — md5(pg_get_viewdef('public.gl_unposted'::regclass)) (the text may differ between Postgres versions — local
--   16 here; if the old one differs live, compare the definition itself)
--                                                                     7100   fdcbae58f3e50d1032de1a37546886dd  6fbdb9f6629d1ddafef39cb1bc3db636
-- Running 5000, 5100 or 7100 again after this one brings back an old version (7100: gl_post_safe and gl_unposted — the new sources
-- then stop posting and are not listed; gl_key_reserved / gl_customer_account — the supplier keys' guard) — then run this one again.
-- The keys (before any posting — the books start 1.12.2026): a supplier's key is "S-" + the dealer number, else "S-" + the
-- normalized name; gl_key_reserved now also reserves every key that starts with "S-", so a customer whose phone / name gives
-- such a key gets "C-" in front (as a system-looking key) — the TS (customer-key.ts glKeyReserved) changes with it, the same day.
-- Existing tables: gl_transactions gets a nullable column (source_hash) and a wider source_kind check (dropped and added again in
-- one ALTER — the only "drop" here; run it in the SQL Editor, the MCP stops on it); expenses, payments, register_shifts and
-- bank_matches get deferred triggers that only read them. No existing row changes: nothing here updates or removes a row of an
-- existing table. No DELETE statement: the word "delete" appears only in "on delete restrict", the no-delete trigger ("before
-- delete"), the revoke of it, the "_viewer_delete" policy and the rollback notes — run it in the SQL Editor (the MCP stops on it).
-- Runs after 7100 (books core) — it stops at the top without it, changing nothing. Deploy order: the code first (it must not call
-- the new functions before they exist — PGRST202 is "not yet"), then this migration.

-- RUN IT AS ONE SCRIPT IN THE SQL EDITOR (one transaction: all of it or nothing). A busy moment never holds the issuing of
-- documents behind it: a table it changes that stays locked for more than 5 seconds stops it ("lock_timeout: … nothing was changed
-- — run it again in a quiet moment"); the triggers on expenses, payments, register_shifts and bank_matches come last.
set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.gl_transactions') is null or to_regclass('public.gl_lines') is null or to_regclass('public.gl_accounts') is null
     or to_regprocedure('public.gl_post_safe(text, uuid)') is null or to_regprocedure('public.gl_post(text, uuid)') is null
     or to_regprocedure('public.gl_books_active(uuid, date)') is null or to_regclass('public.gl_unposted') is null
     or to_regtype('public.gl_line_in') is null then
    raise exception 'migration 20261129007200 runs after 20261128007100 (books core) — run it first; nothing was changed';
  end if;
  if to_regclass('public.bank_lines') is null or to_regprocedure('public.bank_line_handle(uuid, text)') is null
     or to_regprocedure('public.journal_entry_create(uuid, date, text, numeric, numeric, text, text, text, uuid, jsonb)') is null
     or to_regprocedure('public.expense_norm_supplier(text)') is null or to_regprocedure('public.party_key(uuid, text, text)') is null
     or to_regprocedure('public.report_business(date, date)') is null then
    raise exception 'migration 20261129007200 runs after 20261011005000 / 5100 / 4900 (bank, journal, reports) — run them first; nothing was changed';
  end if;
end $$;

-- ============================================================================================================================
-- 1. the tables
-- ============================================================================================================================
-- a source kept "in sync" (an expense, a register's day): the fingerprint of what its entry posted
alter table public.gl_transactions add column if not exists source_hash text check (source_hash is null or source_hash ~ '^[0-9a-f]{32}$');
-- the new kinds of entries
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.gl_transactions'::regclass and conname = 'gl_transactions_source_kind_check'
                   and pg_get_constraintdef(oid) like '%bank_unclass%') then
    alter table public.gl_transactions drop constraint if exists gl_transactions_source_kind_check,
      add constraint gl_transactions_source_kind_check check (source_kind in ('document', 'cancellation', 'payment', 'deposit', 'deposit_cancel', 'opening',
        'expense', 'expense_payment', 'shift', 'bank_match', 'bank_unmatch', 'bank_class', 'bank_unclass', 'manual'));
  end if;
end $$;

-- answer 17: a bank line handled without a document, posted to an account (the owner). Never removed; "opened again" = active
-- false (once), and its entry is reversed
create table if not exists public.gl_bank_line_accounts (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses on delete restrict,
  bank_line_id uuid not null,
  account_id   uuid not null,
  note         text not null default '' check (length(note) <= 300),
  active       boolean not null default true,
  user_id      uuid,
  created_at   timestamptz not null default now(),
  undone_by    uuid,
  undone_at    timestamptz,
  check (active = (undone_at is null)),
  foreign key (bank_line_id, business_id) references public.bank_lines (id, business_id) on delete restrict,
  foreign key (account_id, business_id) references public.gl_accounts (id, business_id) on delete restrict
);
create unique index if not exists gl_bank_line_accounts_once on public.gl_bank_line_accounts (bank_line_id) where active;
create index if not exists gl_bank_line_accounts_business_idx on public.gl_bank_line_accounts (business_id);

-- only "opened again" (active → false, once) changes a row; nothing is removed
create or replace function public.gl_bank_line_accounts_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if not old.active or new.active or new.id <> old.id or new.business_id <> old.business_id or new.bank_line_id <> old.bank_line_id
     or new.account_id <> old.account_id or new.note <> old.note or new.user_id is distinct from old.user_id or new.created_at <> old.created_at then
    raise exception 'append_only: a bank line''s account is only undone, once' using errcode = '42501'; end if;
  return new;
end $$;
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'gl_bank_line_accounts_guard' and tgrelid = 'public.gl_bank_line_accounts'::regclass) then
    create trigger gl_bank_line_accounts_guard before update on public.gl_bank_line_accounts for each row execute function public.gl_bank_line_accounts_guard();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'gl_bank_line_accounts_no_delete' and tgrelid = 'public.gl_bank_line_accounts'::regclass) then
    create trigger gl_bank_line_accounts_no_delete before delete on public.gl_bank_line_accounts for each row execute function public.finance_append_only();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'gl_bank_line_accounts_no_truncate' and tgrelid = 'public.gl_bank_line_accounts'::regclass) then
    create trigger gl_bank_line_accounts_no_truncate before truncate on public.gl_bank_line_accounts for each statement execute function public.finance_append_only();
  end if;
end $$;

-- read by a finance member of the business who sees the whole business (as the bank's tables); NO browser role writes it
do $$
declare
  t constant text := 'gl_bank_line_accounts';
  gate        constant text := 'business_id = (select public.current_business_id()) and business_id in (select public.accessible_business_ids())';
  fin         constant text := 'business_id in (select public.finance_business_ids())';
  full_access constant text := '(select public.my_access()) <> ''register''';
begin
  execute format('alter table public.%I enable row level security', t);
  execute format('revoke all on public.%I from anon', t);
  execute format('revoke insert, update, delete, truncate on public.%I from public, authenticated, service_role', t);
  execute format('grant select on public.%I to authenticated, service_role', t);
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
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_whole_business') then
    execute format('create policy %I on public.%I as restrictive for all to authenticated using ((select public.my_locations()) is null) with check ((select public.my_locations()) is null)', t || '_whole_business', t);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_business_read') then
    execute format('create policy %I on public.%I for select to authenticated using (%s)', t || '_business_read', t, gate);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_viewer_insert') then
    execute format('create policy %I on public.%I as restrictive for insert to authenticated with check ((select public.can_write()))', t || '_viewer_insert', t);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_viewer_update') then
    execute format('create policy %I on public.%I as restrictive for update to authenticated using ((select public.can_write())) with check ((select public.can_write()))', t || '_viewer_update', t);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_viewer_delete') then
    execute format('create policy %I on public.%I as restrictive for delete to authenticated using ((select public.can_write()))', t || '_viewer_delete', t);
  end if;
end $$;

-- an account's key is fixed from its first movement; its business and its role (what the system posts to it) never change
create or replace function public.gl_accounts_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.business_id <> old.business_id or new.role is distinct from old.role or new.id <> old.id then
    raise exception 'account_fixed: an account keeps its business and its role' using errcode = '23514'; end if;
  if new.key <> old.key and exists (select 1 from public.gl_lines l where l.account_id = old.id) then
    raise exception 'account_key_fixed: למפתח של חשבון שיש בו תנועות אין שינוי' using errcode = '23514'; end if;
  return new;
end $$;
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'gl_accounts_guard' and tgrelid = 'public.gl_accounts'::regclass) then
    create trigger gl_accounts_guard before update on public.gl_accounts for each row execute function public.gl_accounts_guard();
  end if;
end $$;

-- ============================================================================================================================
-- 1a. the keys: a supplier's key ("S-…") is never a customer's
-- ============================================================================================================================
-- replaces gl_key_reserved(text) of 20261128007100 — a system key (four digits, "-n" for a location's; BANK) or a supplier's
-- ("S-" + its dealer number or its name): never a customer's (gl_customer_key gives such a one "C-"). The TS: customer-key.ts
-- glKeyReserved = /^[0-9]{4}(-[0-9]{1,2})?$/.test(k) || btrim(k).toUpperCase() === 'BANK' || k.startsWith('S-')
create or replace function public.gl_key_reserved(p_key text) returns boolean language sql immutable set search_path = public, pg_temp as $$
  select coalesce(p_key ~ '^[0-9]{4}(-[0-9]{1,2})?$' or upper(btrim(p_key)) = 'BANK' or p_key like 'S-%', false)
$$;

-- replaces gl_customer_account(uuid, text, text, text, uuid, text, text) of 20261128007100 — a customer's key that is already
-- another kind of account's (never expected: gl_key_reserved) is refused (the posting fails, is recorded and listed), never
-- posted into that account
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
  if a is null then
    select id into a from public.gl_accounts where business_id = p_business and key = k and role = r;
    if a is null then
      raise exception 'gl_key_taken: the customer''s key % is another account''s', k using errcode = '23505'; end if;
  end if;
  return a;
end $$;

-- ============================================================================================================================
-- 2. helpers: the accounts of the new sources, the fingerprints, the open date, writing an entry
-- ============================================================================================================================
-- a system account of a role not in 7100's default chart (2150 cheques to pay) — created on first need; its key taken → refused
create or replace function public.gl_system_account(p_business uuid, p_role text, p_key text, p_name text, p_kind text, p_tb_code text, p_tb_name text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare a uuid;
begin
  select id into a from public.gl_accounts where business_id = p_business and role = p_role;
  if a is not null then return a; end if;
  perform public.gl_chart_ensure(p_business);
  insert into public.gl_accounts (business_id, key, name, kind, tb_code, tb_name, role)
  values (p_business, p_key, p_name, p_kind, p_tb_code, p_tb_name, p_role)
  on conflict (business_id, key) do nothing returning id into a;
  a := coalesce(a, (select id from public.gl_accounts where business_id = p_business and role = p_role));
  -- its key taken by another account (gl_account_add refuses the system's keys — never expected): the posting fails, is recorded
  -- and listed — never into suspense without a word
  if a is null then raise exception 'gl_key_taken: the key % of the system''s account % is another account''s', p_key, p_role using errcode = '23505'; end if;
  return a;
end $$;

-- a supplier's identity (gl_accounts.role, up to 80): party_key (the dealer number, else the normalized name — report_suppliers');
-- a name that normalizes to nothing (no Hebrew / Latin letter or digit) — by the md5 of the name itself, so such suppliers never
-- merge; a long one (above 70) — by its md5
create or replace function public.gl_supplier_role(p_dealer text, p_name text) returns text
language sql stable set search_path = public, pg_temp as $$
  select 'supplier:' || case when pk = 'n:' then 'r:' || md5(btrim(coalesce(p_name, ''))) when length(pk) > 70 then 'h:' || md5(pk) else pk end
    from (select public.party_key(null, p_dealer, p_name) as pk) x
$$;

-- a supplier's account (under 2100) — the same supplier as report_suppliers (party_key: the dealer number, else the normalized
-- name). Its key: "S-" + the dealer number, else "S-" + the normalized name (13 characters; an empty one — of the name's md5); a
-- key already taken by another account → "-2", "-3", … (15 characters). A customer's key never starts with "S-" (gl_key_reserved,
-- below — it gets "C-"), and the owner's keys are four digits: a supplier's account is never a customer's or the owner's
create or replace function public.gl_supplier_account(p_business uuid, p_dealer text, p_name text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare r text := public.gl_supplier_role(p_dealer, p_name); a uuid; base text; k text; n int := 1; nm text;
begin
  select id into a from public.gl_accounts where business_id = p_business and role = r;
  if a is not null then return a; end if;
  perform public.gl_chart_ensure(p_business);
  if coalesce(p_dealer, '') ~ '^[0-9]{9}$' then base := 'S-' || p_dealer;
  else
    nm := public.expense_norm_supplier(p_name);
    base := 'S-' || left(case when nm = '' then left(md5(coalesce(p_name, '')), 8) else nm end, 13);
  end if;
  k := base;
  while exists (select 1 from public.gl_accounts x where x.business_id = p_business and x.key = k) loop
    n := n + 1;
    if n > 999 then raise exception 'gl_key_taken: no free key for the supplier %', base using errcode = '23505'; end if;
    k := left(base, 15 - length(n::text) - 1) || '-' || n;
  end loop;
  insert into public.gl_accounts (business_id, key, name, kind, tb_code, tb_name, parent_key, role, dealer_number)
  values (p_business, k, left(coalesce(nullif(btrim(coalesce(p_name, '')), ''), 'ספק'), 50), 'liability', 'SUPPLIERS', 'ספקים', '2100', r,
          case when coalesce(p_dealer, '') ~ '^[0-9]{9}$' then p_dealer end)
  returning id into a;
  return a;
end $$;

-- the money account of an expense's payment: cash — the location's; card — the business's card (2300); transfer / Bit — BANK;
-- a cheque the business wrote — 2150 cheques to pay (until it clears at the bank); other — suspense
create or replace function public.gl_expense_money_account(p_business uuid, p_method text, p_location uuid) returns uuid
language sql security definer set search_path = public, pg_temp as $$
  select case p_method
    when 'cash' then public.gl_account(p_business, 'cash:' || coalesce(p_location, p_business))
    when 'card' then public.gl_account(p_business, 'business_card')
    when 'transfer' then public.gl_account(p_business, 'bank')
    when 'bit' then public.gl_account(p_business, 'bank')
    when 'cheque' then public.gl_system_account(p_business, 'cheques_out', '2150', 'צ׳קים לפירעון', 'liability', '2150', 'צ׳קים לפירעון')
    else public.gl_account(p_business, 'suspense') end
$$;

-- the account a payment's money was posted to (what a bank match moves to BANK)
create or replace function public.gl_payment_money_account(p public.payments) returns uuid
language sql security definer set search_path = public, pg_temp as $$
  select case when p.expense_id is not null and p.source = 'expense'
              then public.gl_expense_money_account(p.business_id, p.method, coalesce(p.location_id, p.business_id))
              else public.gl_money_account(p.business_id, p.method, coalesce(p.location_id, p.business_id)) end
$$;

-- the fingerprint of what an expense posts (null — nothing: not confirmed). The supplier by its party key, so a typo fixed in the
-- name of the same supplier does not post it again
create or replace function public.gl_expense_hash(e public.expenses) returns text
language sql stable set search_path = public, pg_temp as $$
  select case when e.status = 'confirmed' then md5(concat_ws('|', to_char(e.doc_date, 'YYYY-MM-DD'), e.category, e.amount_before_vat, e.vat_amount, e.total, e.vat_deductible_pct,
           e.supplier_doc_type, public.gl_supplier_role(e.supplier_dealer, e.supplier_name), coalesce(e.location_id, e.business_id), e.expense_number)) end
$$;

-- the day a register's day closed (Israel time) and the fingerprint of what it posts (null — nothing: open, or no difference)
create or replace function public.gl_shift_date(s public.register_shifts) returns date
language sql stable set search_path = public, pg_temp as $$ select (s.closed_at at time zone 'Asia/Jerusalem')::date $$;
create or replace function public.gl_shift_hash(s public.register_shifts) returns text
language sql stable set search_path = public, pg_temp as $$
  select case when s.closed_at is not null and coalesce(s.difference, 0) <> 0
              then md5(concat_ws('|', to_char(public.gl_shift_date(s), 'YYYY-MM-DD'), s.difference, coalesce(s.location_id, s.business_id))) end
$$;

-- the first day an entry of the business may be dated on: p_date, or the day after closed books (finance_period_locks)
create or replace function public.gl_open_date(p_business uuid, p_date date) returns date
language sql stable security definer set search_path = public, pg_temp as $$
  select greatest(p_date, coalesce((select max(l.period_end) from public.finance_period_locks l where l.business_id = p_business) + 1, p_date))
$$;

-- whether the business charges VAT (finance_summary's rule for expenses: the business as it is now)
create or replace function public.gl_business_vat(p_business uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public.entity_charges_vat(coalesce((select public.entity_of(s.entity_type, s.business_type) from public.register_settings s where s.business_id = p_business),
                                            'licensed_dealer'))
$$;

-- the books of a business, locked for one writer (as gl_post: never waited for more than 2 seconds — 55P03, recorded, posted
-- again later), with its chart
create or replace function public.gl_books_lock(p_business uuid) returns public.gl_books
language plpgsql security definer set search_path = public, pg_temp as $$
declare bk public.gl_books; lt text := current_setting('lock_timeout');
begin
  perform public.gl_books_ensure(p_business);
  perform set_config('lock_timeout', '2s', true);
  select * into bk from public.gl_books where business_id = p_business for update;
  perform set_config('lock_timeout', lt, true);
  if bk.chart_version < 1 then perform public.gl_chart_ensure(p_business); end if;
  return bk;
end $$;

-- write an entry (the books are locked by the caller): the next number, the lines; never unbalanced (the deferred check says so
-- too), never a line without an account
create or replace function public.gl_write(p_business uuid, p_kind text, p_source uuid, p_key text, p_date date, p_lines public.gl_line_in[],
                                           p_details text, p_location uuid, p_user uuid, p_reverses uuid default null, p_hash text default null,
                                           p_ref1_type int default null, p_ref1 text default null, p_ref2_type int default null, p_ref2 text default null,
                                           p_id uuid default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare tx uuid; num bigint; dsum numeric; csum numeric; loc uuid := p_location;
begin
  if coalesce(cardinality(p_lines), 0) < 2 then raise exception 'gl_unbalanced: an entry has two lines at least' using errcode = '23514'; end if;
  select coalesce(sum(l.amount) filter (where l.side = 'D'), 0), coalesce(sum(l.amount) filter (where l.side = 'C'), 0) into dsum, csum
    from unnest(p_lines) as l(account_id, side, amount, value_date, match1, match2);
  if dsum <> csum then raise exception 'gl_unbalanced: debit % , credit %', dsum, csum using errcode = '23514'; end if;
  if exists (select 1 from unnest(p_lines) as l(account_id, side, amount, value_date, match1, match2) where l.account_id is null) then
    raise exception 'gl_account_missing: a line with no account' using errcode = '23514'; end if;
  if loc is null or not exists (select 1 from public.business_locations bl where bl.id = loc and bl.business_id = p_business) then loc := p_business; end if;
  update public.gl_books set last_tx_no = last_tx_no + 1, updated_at = now() where business_id = p_business returning last_tx_no into num;
  insert into public.gl_transactions (id, business_id, number, tx_date, value_date, source_kind, source_id, idempotency_key, reverses, source_hash,
                                      ref1_type, ref1_number, ref2_type, ref2_number, details, location_id, user_id)
  values (coalesce(p_id, gen_random_uuid()), p_business, num, p_date, p_date, p_kind, p_source, p_key, p_reverses, p_hash,
          p_ref1_type, left(p_ref1, 20), p_ref2_type, left(p_ref2, 20), left(coalesce(p_details, ''), 50), loc, p_user)
  returning id into tx;
  insert into public.gl_lines (transaction_id, business_id, line_no, account_id, side, amount, value_date, match1, match2, location_id)
  select tx, p_business, l.o, l.account_id, l.side, l.amount, coalesce(l.value_date, p_date), l.match1, l.match2, loc
    from unnest(p_lines) with ordinality as l(account_id, side, amount, value_date, match1, match2, o);
  return tx;
end $$;

-- the reversing entry of an entry (each line on the other side), dated p_date; once (gl_transactions.reverses is unique)
create or replace function public.gl_write_reversal(p_tx uuid, p_kind text, p_key text, p_date date, p_details text, p_user uuid,
                                                    p_id uuid default null, p_source uuid default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.gl_transactions; r public.gl_line_in[];
begin
  select * into o from public.gl_transactions where id = p_tx;
  select coalesce(array_agg(row(l.account_id, case l.side when 'D' then 'C' else 'D' end, l.amount, p_date, l.match1, l.match2)::public.gl_line_in order by l.line_no), '{}')
    into r from public.gl_lines l where l.transaction_id = o.id;
  return public.gl_write(o.business_id, p_kind, coalesce(p_source, o.source_id), p_key, p_date, r, p_details, o.location_id, p_user, o.id, null,
                         o.ref1_type, o.ref1_number, o.ref2_type, o.ref2_number, p_id);
end $$;

-- the entry of a source "in sync" that stands now (posted, not reversed), if any
create or replace function public.gl_standing(p_kind text, p_id uuid) returns public.gl_transactions
language sql stable security definer set search_path = public, pg_temp as $$
  select t.* from public.gl_transactions t
   where t.source_kind = p_kind and t.source_id = p_id and t.reverses is null
     and not exists (select 1 from public.gl_transactions r where r.reverses = t.id)
   order by t.number desc limit 1
$$;

-- ============================================================================================================================
-- 3. what an entry is: the lines of each new source
-- ============================================================================================================================
-- a confirmed expense: its category's account (the amount before VAT + the VAT not deducted) + VAT input 1400 (deducted: a VAT
-- business, round(vat × % / 100, 2) — finance_summary's) / the supplier (the total, matched "E<number>"); a credit note — the
-- mirror. An unknown category → 6117 "other"
create or replace function public.gl_lines_expense(p_expense uuid) returns public.gl_line_in[]
language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.expenses; vin numeric; s text; o text; r text; m text;
begin
  select * into e from public.expenses where id = p_expense;
  if e.id is null or e.status <> 'confirmed' then return '{}'; end if;
  vin := case when public.gl_business_vat(e.business_id) then round(e.vat_amount * e.vat_deductible_pct / 100, 2) else 0 end;
  s := case when e.supplier_doc_type = 'credit' then 'C' else 'D' end;
  o := case s when 'D' then 'C' else 'D' end;
  r := 'expense:' || e.category;
  if not exists (select 1 from public.gl_chart_default(e.business_id) c where c.role = r)
     and not exists (select 1 from public.gl_accounts a where a.business_id = e.business_id and a.role = r) then r := 'expense:other'; end if;
  m := left('E' || e.expense_number, 10);
  return public.gl_ln(public.gl_account(e.business_id, r), s, e.amount_before_vat + e.vat_amount - vin, e.doc_date, m)
      || public.gl_ln(public.gl_account(e.business_id, 'vat_input'), s, vin, e.doc_date, m)
      || public.gl_ln(public.gl_supplier_account(e.business_id, e.supplier_dealer, e.supplier_name), o, e.total, e.doc_date, m);
end $$;

-- a register's day closed with a difference (counted − expected): short — 6900 / the location's cash; over — the cash / 6900
create or replace function public.gl_lines_shift(p_shift uuid) returns public.gl_line_in[]
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.register_shifts; dt date;
begin
  select * into s from public.register_shifts where id = p_shift;
  if s.id is null or s.closed_at is null or coalesce(s.difference, 0) = 0 then return '{}'; end if;
  dt := public.gl_shift_date(s);
  if s.difference < 0 then
    return public.gl_ln(public.gl_account(s.business_id, 'cash_diff'), 'D', -s.difference, dt)
        || public.gl_ln(public.gl_money_account(s.business_id, 'cash', coalesce(s.location_id, s.business_id)), 'C', -s.difference, dt);
  end if;
  return public.gl_ln(public.gl_money_account(s.business_id, 'cash', coalesce(s.location_id, s.business_id)), 'D', s.difference, dt)
      || public.gl_ln(public.gl_account(s.business_id, 'cash_diff'), 'C', s.difference, dt);
end $$;

-- ============================================================================================================================
-- 4. posting the new sources: one entry per source (its key), from the books' start date; never blocks (gl_post_safe)
-- ============================================================================================================================
-- the business and the accounting date of a new source (null — not one)
create or replace function public.gl_source_more(p_source text, p_id uuid, out business_id uuid, out source_date date)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  case p_source
    when 'expense' then
      select e.business_id, coalesce((public.gl_standing('expense', e.id)).tx_date, e.doc_date) into business_id, source_date
        from public.expenses e where e.id = p_id;
    when 'shift' then
      select s.business_id, coalesce((public.gl_standing('shift', s.id)).tx_date, public.gl_shift_date(s)) into business_id, source_date
        from public.register_shifts s where s.id = p_id;
    when 'expense_payment' then
      select p.business_id, p.paid_on into business_id, source_date from public.payments p
       where p.id = p_id and p.expense_id is not null and p.source in ('expense', 'reversal');
    when 'bank_match' then
      select m.business_id, l.line_date into business_id, source_date
        from public.bank_matches m join public.bank_lines l on l.id = m.bank_line_id where m.id = p_id;
    when 'bank_unmatch' then
      select m.business_id, l.line_date into business_id, source_date
        from public.bank_matches m join public.bank_lines l on l.id = m.bank_line_id where m.id = p_id and not m.active;
    when 'bank_class' then
      select c.business_id, l.line_date into business_id, source_date
        from public.gl_bank_line_accounts c join public.bank_lines l on l.id = c.bank_line_id where c.id = p_id;
    when 'bank_unclass' then
      select c.business_id, l.line_date into business_id, source_date
        from public.gl_bank_line_accounts c join public.bank_lines l on l.id = c.bank_line_id where c.id = p_id and not c.active;
    else null;
  end case;
end $$;

create or replace function public.gl_post_more(p_source text, p_id uuid) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare src record; bk public.gl_books; b uuid; tx uuid; st public.gl_transactions; want text; n int; ln public.gl_line_in[];
  e public.expenses; s public.register_shifts; p public.payments; o public.payments; m public.bank_matches; c public.gl_bank_line_accounts;
  l public.bank_lines; d public.documents; acc uuid; bank uuid; dt date; usr uuid; k text; ot public.gl_transactions; num text; sup uuid; mv record;
begin
  if p_source not in ('expense', 'shift', 'expense_payment', 'bank_match', 'bank_unmatch', 'bank_class', 'bank_unclass') then
    raise exception 'gl_source_unknown: %', p_source using errcode = '22023'; end if;
  src := public.gl_source_more(p_source, p_id);
  b := src.business_id;
  if b is null then return null; end if;

  -- ---- in sync: an expense, a register's day — what stands is reversed when it is not what the source posts now ----------------
  if p_source in ('expense', 'shift') then
    bk := public.gl_books_lock(b);
    st := public.gl_standing(p_source, p_id);
    if p_source = 'expense' then
      select * into e from public.expenses where id = p_id;
      want := case when e.doc_date >= bk.start_date then public.gl_expense_hash(e) end;
    else
      select * into s from public.register_shifts where id = p_id;
      want := case when public.gl_shift_date(s) >= bk.start_date then public.gl_shift_hash(s) end;
    end if;
    if st.id is not null and st.source_hash is not distinct from want then return st.id; end if;
    if st.id is null and want is null then return null; end if;
    usr := coalesce(auth.uid(), e.confirmed_by, e.user_id, s.user_id);
    if st.id is not null then
      tx := public.gl_write_reversal(st.id, p_source, 'reverse:' || st.id, public.gl_open_date(b, st.tx_date), 'ביטול רישום — ' || st.details, usr);
    end if;
    if want is null then return tx; end if;
    select count(*) + 1 into n from public.gl_transactions t where t.source_kind = p_source and t.source_id = p_id and t.reverses is null;
    k := p_source || ':' || p_id || ':' || n;
    if p_source = 'expense' then
      ln := public.gl_lines_expense(p_id);
      -- its supplier changed after it was paid: what was paid (on the old supplier's account) moves to the new one in the same
      -- entry, so each supplier's balance is right (and a later reversal of this entry moves it back)
      sup := public.gl_supplier_account(b, e.supplier_dealer, e.supplier_name);
      for mv in select gl.account_id, sum(case gl.side when 'D' then gl.amount else -gl.amount end) as v
                  from public.gl_lines gl join public.gl_transactions gt on gt.id = gl.transaction_id join public.gl_accounts ga on ga.id = gl.account_id
                 where gt.source_kind = 'expense_payment' and gt.source_id in (select x.id from public.payments x where x.expense_id = p_id)
                   and ga.role like 'supplier:%' and gl.account_id <> sup
                 group by gl.account_id having sum(case gl.side when 'D' then gl.amount else -gl.amount end) <> 0 order by gl.account_id loop
        ln := ln || public.gl_ln(sup, 'D', mv.v, e.doc_date, left('E' || e.expense_number, 10))
                 || public.gl_ln(mv.account_id, 'C', mv.v, e.doc_date, left('E' || e.expense_number, 10));
      end loop;
      return public.gl_write(b, 'expense', p_id, k, public.gl_open_date(b, e.doc_date), ln,
        case when e.supplier_doc_type = 'credit' then 'זיכוי ספק ' else 'הוצאה ' end || e.expense_number || ' — ' || btrim(e.supplier_name),
        coalesce(e.location_id, b), usr, null, want, null, nullif(btrim(e.supplier_doc_number), ''), null, e.expense_number::text);
    end if;
    ln := public.gl_lines_shift(p_id);
    return public.gl_write(b, 'shift', p_id, k, public.gl_open_date(b, public.gl_shift_date(s)), ln,
      'הפרש קופה ' || to_char(public.gl_shift_date(s), 'DD.MM.YYYY') || case when btrim(s.employee_name) <> '' then ' — ' || btrim(s.employee_name) else '' end,
      coalesce(s.location_id, b), usr, null, want);
  end if;

  -- ---- once: its key ------------------------------------------------------------------------------------------------------------
  k := p_source || ':' || p_id;
  bk := public.gl_books_lock(b);
  select id into tx from public.gl_transactions where idempotency_key = k;
  if tx is not null then return tx; end if;
  bank := public.gl_account(b, 'bank');

  if p_source = 'expense_payment' then
    select * into p from public.payments where id = p_id;
    if p.paid_on < bk.start_date then return null; end if;
    select * into e from public.expenses where id = p.expense_id;
    if p.source = 'reversal' then
      -- a void's money back: the reversing entry of the payment it reverses; of the books' time and not posted yet — wait for it; of
      -- before the start (not in the books) — the money back posts by its own day, money / the supplier (as 7100's document payments)
      select * into o from public.payments x where x.expense_id = p.expense_id and x.source = 'expense' and x.direction <> p.direction
       order by x.created_at, x.id limit 1;
      if o.id is not null then
        select * into ot from public.gl_transactions where idempotency_key = 'expense_payment:' || o.id;
        if ot.id is null then
          if o.paid_on >= bk.start_date then raise exception 'gl_wait: the expense''s payment is not posted yet' using errcode = '55000'; end if;
        elsif not exists (select 1 from public.gl_transactions r where r.reverses = ot.id) then
          return public.gl_write_reversal(ot.id, 'expense_payment', k, public.gl_open_date(b, p.paid_on),
                                          'ביטול תשלום — הוצאה ' || e.expense_number, coalesce(p.user_id, auth.uid()), null, p_id);
        end if;
      end if;
    end if;
    acc := public.gl_expense_money_account(b, p.method, coalesce(p.location_id, b));
    num := left('E' || e.expense_number, 10);
    if p.direction = 'out' then
      ln := public.gl_ln(public.gl_supplier_account(b, e.supplier_dealer, e.supplier_name), 'D', p.amount, p.paid_on, num) || public.gl_ln(acc, 'C', p.amount, p.paid_on);
    else
      ln := public.gl_ln(acc, 'D', p.amount, p.paid_on) || public.gl_ln(public.gl_supplier_account(b, e.supplier_dealer, e.supplier_name), 'C', p.amount, p.paid_on, num);
    end if;
    return public.gl_write(b, 'expense_payment', p_id, k, public.gl_open_date(b, p.paid_on), ln,
      case when p.source = 'reversal' then 'ביטול תשלום — הוצאה ' when p.direction = 'in' then 'החזר מספק — הוצאה ' else 'תשלום לספק — הוצאה ' end
        || e.expense_number || ' — ' || btrim(e.supplier_name),
      coalesce(p.location_id, b), coalesce(p.user_id, auth.uid()), null, null, null, nullif(btrim(e.supplier_doc_number), ''), null, e.expense_number::text);
  end if;

  if p_source in ('bank_match', 'bank_unmatch') then
    select * into m from public.bank_matches where id = p_id;
    select * into l from public.bank_lines where id = m.bank_line_id;
    if m.payment_id is null or l.line_date < bk.start_date then return null; end if;   -- a deposit: in BANK already
    select * into p from public.payments where id = m.payment_id;
    if p.method not in ('card', 'cheque', 'other') then return null; end if;           -- a transfer / Bit: in BANK already
    acc := public.gl_payment_money_account(p);
    if acc = bank then return null; end if;
    if p_source = 'bank_unmatch' then
      select * into ot from public.gl_transactions where idempotency_key = 'bank_match:' || m.id;
      if ot.id is null then raise exception 'gl_wait: the match is not posted yet' using errcode = '55000'; end if;
      return public.gl_write_reversal(ot.id, 'bank_unmatch', k, public.gl_open_date(b, ot.tx_date),
                                      'ביטול התאמת בנק — ' || left(btrim(l.description), 30), coalesce(m.undone_by, auth.uid()));
    end if;
    num := case when p.method = 'cheque' then p.reference->>'number' end;
    if p.direction = 'in' then
      ln := public.gl_ln(bank, 'D', m.amount, l.line_date, null, 'L' || left(replace(l.id::text, '-', ''), 9))
         || public.gl_ln(acc, 'C', m.amount, l.line_date, num, 'L' || left(replace(l.id::text, '-', ''), 9));
    else
      ln := public.gl_ln(acc, 'D', m.amount, l.line_date, num, 'L' || left(replace(l.id::text, '-', ''), 9))
         || public.gl_ln(bank, 'C', m.amount, l.line_date, null, 'L' || left(replace(l.id::text, '-', ''), 9));
    end if;
    if p.document_id is not null then select * into d from public.documents where id = p.document_id; end if;
    return public.gl_write(b, 'bank_match', p_id, k, public.gl_open_date(b, l.line_date), ln,
      'התאמת בנק — ' || left(btrim(l.description), 30), coalesce(p.location_id, b), coalesce(m.approved_by, auth.uid()), null, null,
      d.doc_type, public.gl_doc_ref(d.doc_number), null, null);
  end if;

  -- bank_class / bank_unclass (answer 17): the bank line / the account the owner picked
  select * into c from public.gl_bank_line_accounts where id = p_id;
  select * into l from public.bank_lines where id = c.bank_line_id;
  if l.line_date < bk.start_date then return null; end if;
  if p_source = 'bank_unclass' then
    select * into ot from public.gl_transactions where idempotency_key = 'bank_class:' || c.id;
    if ot.id is null then raise exception 'gl_wait: the bank line''s entry is not posted yet' using errcode = '55000'; end if;
    return public.gl_write_reversal(ot.id, 'bank_unclass', k, public.gl_open_date(b, ot.tx_date),
                                    'ביטול רישום שורת בנק — ' || left(btrim(l.description), 25), coalesce(c.undone_by, auth.uid()));
  end if;
  if c.account_id = bank then raise exception 'bank_class_account: a bank line is not posted to the bank itself' using errcode = '23514'; end if;
  if l.amount > 0 then
    ln := public.gl_ln(bank, 'D', abs(l.amount), l.line_date, null, 'L' || left(replace(l.id::text, '-', ''), 9))
       || public.gl_ln(c.account_id, 'C', abs(l.amount), l.line_date, null, 'L' || left(replace(l.id::text, '-', ''), 9));
  else
    ln := public.gl_ln(c.account_id, 'D', abs(l.amount), l.line_date, null, 'L' || left(replace(l.id::text, '-', ''), 9))
       || public.gl_ln(bank, 'C', abs(l.amount), l.line_date, null, 'L' || left(replace(l.id::text, '-', ''), 9));
  end if;
  return public.gl_write(b, 'bank_class', p_id, k, public.gl_open_date(b, l.line_date), ln,
    'בנק — ' || left(btrim(coalesce(nullif(btrim(c.note), ''), l.description)), 40), b, coalesce(c.user_id, auth.uid()), null, null,
    null, nullif(left(btrim(l.reference), 20), ''), null, null);
end $$;

-- replaces gl_post_safe(text, uuid) of 20261128007100 — the new sources go to gl_post_more; everything else as before
create or replace function public.gl_post_safe(p_source text, p_id uuid) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare b uuid; e text;
begin
  if p_source in ('expense', 'shift', 'expense_payment', 'bank_match', 'bank_unmatch', 'bank_class', 'bank_unclass') then
    return public.gl_post_more(p_source, p_id);
  end if;
  return public.gl_post(p_source, p_id);
exception when others then
  e := left(sqlstate || ' ' || sqlerrm, 600);
  begin
    if p_source in ('expense', 'shift', 'expense_payment', 'bank_match', 'bank_unmatch', 'bank_class', 'bank_unclass') then
      b := (public.gl_source_more(p_source, p_id)).business_id;
    else
      b := (public.gl_source_of(p_source, p_id)).business_id;
    end if;
    if b is not null then
      perform public.gl_books_ensure(b);
      -- one row per source, error and day (a source the cron retries every few minutes does not fill the table)
      insert into public.gl_post_failures (business_id, source_kind, source_id, error)
      select b, p_source, p_id, e
       where not exists (select 1 from public.gl_post_failures f where f.source_kind = p_source and f.source_id = p_id and f.error = e
                            and (f.at at time zone 'Asia/Jerusalem')::date = public.il_today());
    end if;
  exception when others then null;
  end;
  return null;
end $$;

-- the triggers' call (deferred — at commit, when every row of the transaction is there): the kind is the trigger's argument
create or replace function public.gl_on_more() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin perform public.gl_post_safe(tg_argv[0], new.id); return null; end $$;

-- ============================================================================================================================
-- 5. what should have posted and did not — replaces the view gl_unposted of 20261128007100 (the same columns, in the same order;
--    the new sources added): an expense / a register's day whose entry is not what it posts now; an expense's payment; a bank
--    match (card / cheque / other) and its undoing; a bank line posted to an account and its undoing
-- ============================================================================================================================
create or replace view public.gl_unposted with (security_invoker = true) as
select s.business_id, s.source_kind, s.source_id, s.source_date, s.label,
       (select f.error from public.gl_post_failures f where f.source_kind = s.source_kind and f.source_id = s.source_id order by f.at desc limit 1) as error,
       s.source_at, s.ord, s.seq
  from (
    select d.business_id, 'document'::text as source_kind, d.id as source_id, d.doc_date as source_date,
           public.gl_doc_name(d.doc_type) || ' ' || public.gl_doc_ref(d.doc_number) as label, d.doc_date as base_date,
           d.issued_at as source_at, 1 as ord, d.link_no as seq
      from public.documents d where d.doc_type in (300, 305, 320, 330, 400)
    union all
    -- a cancellation / a deposit's cancellation: only of what is of the books' time (one of before the start reverses nothing)
    select c.business_id, 'cancellation', c.document_id, (c.created_at at time zone 'Asia/Jerusalem')::date,
           'ביטול ' || public.gl_doc_name(d.doc_type) || ' ' || public.gl_doc_ref(d.doc_number), d.doc_date, c.created_at, 4, d.link_no
      from public.document_cancellations c join public.documents d on d.id = c.document_id where d.doc_type in (300, 305, 320, 330, 400)
    union all
    select p.business_id, 'payment', p.id, p.paid_on, case p.source when 'refund' then 'החזר כספי בקופה' when 'credit' then 'החזר כספי על זיכוי' else 'החזרת תשלום' end,
           p.paid_on, p.created_at, 2, 0::bigint
      from public.payments p where p.source in ('refund', 'credit') or (p.source = 'reversal' and p.expense_id is null and p.document_id is not null)
    union all
    select x.business_id, 'deposit', x.id, x.deposited_on, 'הפקדה ' || x.number, x.deposited_on, x.created_at, 3, x.number::bigint
      from public.bank_deposits x
    union all
    select x.business_id, 'deposit_cancel', x.id, (x.cancelled_at at time zone 'Asia/Jerusalem')::date, 'ביטול הפקדה ' || x.number,
           x.deposited_on, x.cancelled_at, 5, x.number::bigint
      from public.bank_deposits x where x.status = 'cancelled'
    union all
    -- 7200: an expense whose standing entry is not what it posts now (confirmed of the books' time — its fingerprint; else nothing)
    select e.business_id, 'expense', e.id, coalesce(st.tx_date, e.doc_date), 'הוצאה ' || e.expense_number || ' — ' || btrim(e.supplier_name),
           coalesce(st.tx_date, e.doc_date), e.updated_at, 6, e.expense_number
      from public.expenses e
      join public.gl_books bk on bk.business_id = e.business_id
       and (e.doc_date >= bk.start_date or exists (select 1 from public.gl_transactions t0 where t0.source_kind = 'expense' and t0.source_id = e.id))
      left join lateral (select t.tx_date, t.source_hash from public.gl_transactions t
                          where t.source_kind = 'expense' and t.source_id = e.id and t.reverses is null
                            and not exists (select 1 from public.gl_transactions r where r.reverses = t.id)
                          order by t.number desc limit 1) st on true
     where (case when e.doc_date >= bk.start_date then public.gl_expense_hash(e) end) is distinct from st.source_hash
    union all
    -- 7200: an expense's money (paid, money back, a void's reversal — each by its own day)
    select p.business_id, 'expense_payment', p.id, p.paid_on, 'תשלום הוצאה', p.paid_on, p.created_at, 7, 0::bigint
      from public.payments p where p.expense_id is not null and p.source in ('expense', 'reversal')
    union all
    -- 7200: a register's day with a difference
    select s2.business_id, 'shift', s2.id, coalesce(st.tx_date, public.gl_shift_date(s2)), 'הפרש קופה',
           coalesce(st.tx_date, public.gl_shift_date(s2)), coalesce(s2.closed_at, s2.opened_at), 8, 0::bigint
      from public.register_shifts s2
      join public.gl_books bk on bk.business_id = s2.business_id
       and (public.gl_shift_date(s2) >= bk.start_date or exists (select 1 from public.gl_transactions t0 where t0.source_kind = 'shift' and t0.source_id = s2.id))
      left join lateral (select t.tx_date, t.source_hash from public.gl_transactions t
                          where t.source_kind = 'shift' and t.source_id = s2.id and t.reverses is null
                            and not exists (select 1 from public.gl_transactions r where r.reverses = t.id)
                          order by t.number desc limit 1) st on true
     where (case when public.gl_shift_date(s2) >= bk.start_date then public.gl_shift_hash(s2) end) is distinct from st.source_hash
    union all
    -- 7200: a bank match of money not in BANK yet (card, cheque, other) — and its undoing
    select m.business_id, 'bank_match', m.id, l.line_date, 'התאמת בנק', l.line_date, m.approved_at, 9, 0::bigint
      from public.bank_matches m join public.bank_lines l on l.id = m.bank_line_id join public.payments p on p.id = m.payment_id
     where p.method in ('card', 'cheque', 'other')
    union all
    select m.business_id, 'bank_unmatch', m.id, (m.undone_at at time zone 'Asia/Jerusalem')::date, 'ביטול התאמת בנק', l.line_date, m.undone_at, 10, 0::bigint
      from public.bank_matches m join public.bank_lines l on l.id = m.bank_line_id join public.payments p on p.id = m.payment_id
     where not m.active and p.method in ('card', 'cheque', 'other')
    union all
    -- 7200 (answer 17): a bank line posted to an account — and its undoing
    select c.business_id, 'bank_class', c.id, l.line_date, 'שורת בנק לחשבון', l.line_date, c.created_at, 11, 0::bigint
      from public.gl_bank_line_accounts c join public.bank_lines l on l.id = c.bank_line_id
    union all
    select c.business_id, 'bank_unclass', c.id, (c.undone_at at time zone 'Asia/Jerusalem')::date, 'ביטול רישום שורת בנק', l.line_date, c.undone_at, 12, 0::bigint
      from public.gl_bank_line_accounts c join public.bank_lines l on l.id = c.bank_line_id where not c.active
  ) s
  join public.gl_books b on b.business_id = s.business_id and s.source_date >= b.start_date and s.base_date >= b.start_date
 where not exists (select 1 from public.gl_transactions t where t.idempotency_key = s.source_kind || ':' || s.source_id);
revoke all on public.gl_unposted from anon, public;
grant select on public.gl_unposted to authenticated;

-- ============================================================================================================================
-- 6. the owner: the manual double entry (answer 15), a bank line to an account (answer 17), the chart
-- ============================================================================================================================
-- the owner of the current business who writes (journal_writer: owner, full, every location), the business active. Takes
-- finance_log's lock of the business first — the order a document's issue takes its locks (finance_log's, then the books' at
-- commit), so the owner's writes never deadlock with a sale
create or replace function public.gl_owner_guard() returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare b uuid := public.finance_guard();
begin
  if not public.can_write() or not public.journal_writer() then
    raise exception 'books_not_allowed: רק הבעלים רושמים בספרים' using errcode = '42501'; end if;
  if not public.business_is_active(b) then raise exception 'business_locked' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('finance_audit:' || b::text, 0));
  return b;
end $$;

-- the chart of a business opened once, under the books' lock (as the posting opens it) — only when it is not there yet; the
-- caller holds finance_log's lock already
create or replace function public.gl_chart_ready(p_business uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if coalesce((select g.chart_version from public.gl_books g where g.business_id = p_business), 0) < 1 then
    perform public.gl_books_lock(p_business);
  end if;
end $$;

-- a manual entry: p_lines [{ "account": "<key>", "side": "D" | "C", "amount": n, "match": "<up to 10>"? }, …] — 2 to 500 lines,
-- each an active account of the chart, an amount above 0 to the agora; Σ debit = Σ credit exactly (never balanced for you);
-- dated from the books' start to today, not in closed books; the details (B100 1361) 2–50 letters. The id is the screen's (a
-- retry returns the same entry). Returns { id, number, date, debit, credit, created }
create or replace function public.gl_manual_create(p_id uuid, p_date date, p_details text, p_lines jsonb, p_location uuid default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare b uuid := public.gl_owner_guard(); bk public.gl_books; t public.gl_transactions; e jsonb; k text; s text; amt numeric; a uuid;
  r public.gl_line_in[] := '{}'; dsum numeric := 0; csum numeric := 0; lock_end date; loc uuid; det text := btrim(coalesce(p_details, '')); mt text;
begin
  if p_id is null then raise exception 'manual_id: a new entry has an id' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('finance_audit:' || b::text, 0));   -- finance_log's lock first, as a document's issue
  bk := public.gl_books_lock(b);
  select * into t from public.gl_transactions where id = p_id;
  if t.id is not null then
    if t.business_id <> b or t.source_kind <> 'manual' or t.reverses is not null then raise exception 'not allowed' using errcode = '42501'; end if;
    return jsonb_build_object('id', t.id, 'number', t.number, 'date', t.tx_date, 'created', false);
  end if;
  if p_date is null or p_date > public.il_today() then raise exception 'manual_date: פקודה — בתאריך של היום או לפניו' using errcode = '22023'; end if;
  if p_date < bk.start_date then
    raise exception 'manual_before_start: פקודה בספרים — מתאריך תחילת הספרים (%)', bk.start_date using errcode = '22023'; end if;
  lock_end := public.finance_locked_until(b);
  if lock_end is not null and p_date <= lock_end then raise exception 'period_locked: the books are closed until %', lock_end using errcode = '23514'; end if;
  if length(det) < 2 or length(det) > 50 then raise exception 'manual_details: פרטי הפקודה — 2 עד 50 תווים' using errcode = '22023'; end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) < 2 or jsonb_array_length(p_lines) > 500 then
    raise exception 'manual_lines: פקודה — 2 עד 500 שורות' using errcode = '22023'; end if;
  for e in select value from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(e) is distinct from 'object' then raise exception 'manual_line: כל שורה — חשבון, חובה / זכות וסכום' using errcode = '22023'; end if;
    k := btrim(coalesce(e->>'account', '')); s := e->>'side';
    if jsonb_typeof(e->'amount') is distinct from 'number' then raise exception 'manual_amount: סכום — מספר' using errcode = '22023'; end if;
    amt := (e->>'amount')::numeric;
    if s is null or s not in ('D', 'C') or amt <= 0 or amt <> round(amt, 2) or amt > 999999999999 then
      raise exception 'manual_line: כל שורה — חשבון, חובה / זכות (D / C) וסכום מעל 0, עד אגורות' using errcode = '22023'; end if;
    select id into a from public.gl_accounts where business_id = b and key = k and active;
    if a is null then raise exception 'manual_account: החשבון % לא נמצא בלוח החשבונות (או שאינו פעיל)', k using errcode = '22023'; end if;
    mt := nullif(btrim(coalesce(e->>'match', '')), '');
    if mt is not null and length(mt) > 10 then raise exception 'manual_match: אסמכתת התאמה — עד 10 תווים' using errcode = '22023'; end if;
    r := r || public.gl_ln(a, s, amt, p_date, mt);
    if s = 'D' then dsum := dsum + amt; else csum := csum + amt; end if;
  end loop;
  if dsum <> csum then
    raise exception 'manual_unbalanced: הפקודה לא מאוזנת — חובה % , זכות %', dsum, csum using errcode = '23514'; end if;
  loc := coalesce(p_location, public.location_pick(b));
  if loc is null or not exists (select 1 from public.business_locations l where l.id = loc and l.business_id = b and l.active) then
    raise exception 'manual_location: an active location of the business' using errcode = '22023'; end if;
  t.id := public.gl_write(b, 'manual', p_id, 'manual:' || p_id, p_date, r, det, loc, auth.uid(), null, null, null, null, null, null, p_id);
  select * into t from public.gl_transactions where id = t.id;
  perform public.finance_log(b, 'books.manual', 'gl_transactions', p_id::text,
    jsonb_build_object('number', t.number, 'date', p_date, 'debit', dsum, 'lines', jsonb_array_length(p_lines), 'details', det));
  return jsonb_build_object('id', t.id, 'number', t.number, 'date', p_date, 'debit', dsum, 'credit', csum, 'created', true);
end $$;

-- the reversing entry of a manual entry (once; not of a reversal), dated from its date to today, not in closed books
create or replace function public.gl_manual_reverse(p_id uuid, p_entry uuid, p_date date default null, p_details text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare b uuid := public.gl_owner_guard(); bk public.gl_books; t public.gl_transactions; o public.gl_transactions; d date := coalesce(p_date, public.il_today());
  lock_end date; det text;
begin
  if p_id is null then raise exception 'manual_id: a new entry has an id' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('finance_audit:' || b::text, 0));
  bk := public.gl_books_lock(b);
  select * into t from public.gl_transactions where id = p_id;
  if t.id is not null then
    if t.business_id <> b or t.source_kind <> 'manual' or t.reverses is distinct from p_entry then raise exception 'not allowed' using errcode = '42501'; end if;
    return jsonb_build_object('id', t.id, 'number', t.number, 'date', t.tx_date, 'created', false);
  end if;
  select * into o from public.gl_transactions where id = p_entry and business_id = b;
  if o.id is null or o.source_kind <> 'manual' then
    raise exception 'manual_entry: פקודה ידנית של העסק — רק אותה מבטלים כאן (רישום אוטומטי מתוקן במקור שלו)' using errcode = '22023'; end if;
  if o.reverses is not null then raise exception 'manual_reverse: פקודה הפוכה לא מבטלים — רושמים פקודה חדשה' using errcode = '23514'; end if;
  if exists (select 1 from public.gl_transactions x where x.reverses = o.id) then
    raise exception 'manual_reversed: הפקודה כבר בוטלה' using errcode = '23514'; end if;
  if d > public.il_today() or d < o.tx_date then
    raise exception 'manual_date: ביטול — מתאריך הפקודה ועד היום' using errcode = '22023'; end if;
  lock_end := public.finance_locked_until(b);
  if lock_end is not null and d <= lock_end then raise exception 'period_locked: the books are closed until %', lock_end using errcode = '23514'; end if;
  det := btrim(coalesce(p_details, ''));
  if det = '' then det := 'ביטול פקודה ' || o.number; end if;
  if length(det) < 2 or length(det) > 50 then raise exception 'manual_details: פרטי הפקודה — 2 עד 50 תווים' using errcode = '22023'; end if;
  t.id := public.gl_write_reversal(o.id, 'manual', 'manual:' || p_id, d, det, auth.uid(), p_id, p_id);
  select * into t from public.gl_transactions where id = t.id;
  perform public.finance_log(b, 'books.manual_reversed', 'gl_transactions', p_id::text,
    jsonb_build_object('number', t.number, 'reverses', o.number, 'date', d, 'details', det));
  return jsonb_build_object('id', t.id, 'number', t.number, 'date', d, 'reverses', o.number, 'created', true);
end $$;

-- answer 17: a bank line handled without a document → an account (whoever handles the bank — bank_guard(true), as
-- bank_line_handle; the owner's decision, 27.11.2026). Posted at commit (zz_gl_post on this table):
-- money in — BANK / the account; out — the account / BANK. Opened again by bank_line_reopen (its entry reversed)
create or replace function public.bank_line_classify(p_line uuid, p_account text, p_note text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare b uuid := public.bank_guard(true); l record; a public.gl_accounts; c uuid; v_note text := btrim(coalesce(p_note, ''));
begin
  select * into l from public.bank_lines where id = p_line for update;
  if l.id is null or l.business_id <> b then raise exception 'not allowed' using errcode = '42501'; end if;
  if l.status <> 'open' then raise exception 'bank_line_closed: the line is already matched or handled' using errcode = '23514'; end if;
  if length(v_note) < 2 then raise exception 'reason_required: a reason or a note, two letters at least' using errcode = '22023'; end if;
  -- the line first (as bank_match), then finance_log's lock, then the books' (the chart, if it is not there yet)
  perform pg_advisory_xact_lock(hashtextextended('finance_audit:' || b::text, 0));
  perform public.gl_chart_ready(b);
  select * into a from public.gl_accounts where business_id = b and key = btrim(coalesce(p_account, '')) and active;
  if a.id is null then raise exception 'bank_class_account: החשבון % לא נמצא בלוח החשבונות (או שאינו פעיל)', p_account using errcode = '22023'; end if;
  if a.role = 'bank' then raise exception 'bank_class_account: שורת בנק לא נרשמת לחשבון הבנק עצמו' using errcode = '22023'; end if;
  insert into public.gl_bank_line_accounts (business_id, bank_line_id, account_id, note, user_id)
  values (b, l.id, a.id, left(v_note, 300), auth.uid()) returning id into c;
  update public.bank_lines set status = 'handled', note = left(v_note, 300), handled_by = auth.uid(), handled_at = now() where id = l.id;
  perform public.finance_log(b, 'bank.classified', 'bank_lines', l.id::text,
    jsonb_build_object('date', l.line_date, 'amount', l.amount, 'account', a.key, 'note', left(v_note, 300)));
  return jsonb_build_object('line', l.id, 'status', 'handled', 'account', a.key, 'id', c, 'posts', public.gl_books_active(b, l.line_date));
end $$;

-- a key of the system's own accounts — never the owner's: the default chart's, 2150 and a location's cash / cheques (1100-n /
-- 1150-n)
create or replace function public.gl_key_system(p_key text) returns boolean
language sql stable set search_path = public, pg_temp as $$
  select p_key in (select c.key from public.gl_chart_default(null) c) or p_key = '2150' or p_key ~ '^(1100|1150)-[0-9]{1,2}$'
$$;

-- the chart (the owner): an account the owner adds — a key of four digits ("-n" allowed: the form of the system's keys, which a
-- customer's key never has — gl_customer_key gives such a one "C-"), a name, a kind; its trial-balance code / name (default:
-- its key / its name); a parent that exists
create or replace function public.gl_account_add(p_key text, p_name text, p_kind text, p_tb_code text default null, p_tb_name text default null,
                                                 p_parent_key text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare b uuid := public.gl_owner_guard(); k text := btrim(coalesce(p_key, '')); nm text := btrim(coalesce(p_name, ''));
  tc text := btrim(coalesce(p_tb_code, '')); tn text := btrim(coalesce(p_tb_name, '')); pk text := nullif(btrim(coalesce(p_parent_key, '')), ''); a uuid;
begin
  perform public.gl_books_lock(b);   -- after the guard's finance_log lock; the chart is there
  if k !~ '^[0-9]{4}(-[0-9]{1,2})?$' then
    raise exception 'account_key: מפתח חשבון — 4 ספרות (אפשר גם "-" ועוד ספרה או שתיים)' using errcode = '22023'; end if;
  if public.gl_key_system(k) then raise exception 'account_reserved: המפתח % שמור לחשבון של המערכת', k using errcode = '23505'; end if;
  if exists (select 1 from public.gl_accounts x where x.business_id = b and x.key = k) then
    raise exception 'account_exists: כבר יש חשבון עם המפתח %', k using errcode = '23505'; end if;
  if length(nm) < 1 or length(nm) > 50 then raise exception 'account_name: שם החשבון — עד 50 תווים' using errcode = '22023'; end if;
  if p_kind is null or p_kind not in ('asset', 'liability', 'equity', 'income', 'expense') then
    raise exception 'account_kind: נכס, התחייבות, הון, הכנסה או הוצאה' using errcode = '22023'; end if;
  if tc = '' then tc := k; end if;
  if tn = '' then tn := left(nm, 30); end if;
  if length(tc) > 15 or length(tn) > 30 then raise exception 'account_tb: קוד מאזן בוחן — עד 15 תווים, ושמו — עד 30' using errcode = '22023'; end if;
  if pk is not null and not exists (select 1 from public.gl_accounts x where x.business_id = b and x.key = pk) then
    raise exception 'account_parent: חשבון האב % לא נמצא', pk using errcode = '22023'; end if;
  -- under a parent of the same kind; never under the customers (1300) or the suppliers (2100) — those are the system's
  if pk is not null and (pk in ('1300', '2100') or not exists (select 1 from public.gl_accounts x where x.business_id = b and x.key = pk and x.kind = p_kind)) then
    raise exception 'account_parent: חשבון אב מאותו סוג, ולא לקוחות (1300) או ספקים (2100)' using errcode = '22023'; end if;
  insert into public.gl_accounts (business_id, key, name, kind, tb_code, tb_name, parent_key)
  values (b, k, nm, p_kind, tc, tn, pk) returning id into a;
  perform public.finance_log(b, 'books.account_added', 'gl_accounts', a::text,
    jsonb_build_object('key', k, 'name', nm, 'kind', p_kind, 'tbCode', tc, 'tbName', tn, 'parent', pk));
  return jsonb_build_object('id', a, 'key', k);
end $$;

-- rename / the trial-balance code and name (any account); a new key — only of an account the owner added (no role), before its
-- first movement, with no account under it
create or replace function public.gl_account_update(p_key text, p_name text default null, p_tb_code text default null, p_tb_name text default null,
                                                    p_new_key text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare b uuid := public.gl_owner_guard(); a public.gl_accounts; nm text; tc text; tn text; nk text;
begin
  perform public.gl_books_lock(b);   -- after the guard's finance_log lock
  select * into a from public.gl_accounts where business_id = b and key = btrim(coalesce(p_key, '')) for update;
  if a.id is null then raise exception 'account_missing: החשבון % לא נמצא', p_key using errcode = '22023'; end if;
  nm := coalesce(nullif(btrim(coalesce(p_name, '')), ''), a.name);
  tc := coalesce(nullif(btrim(coalesce(p_tb_code, '')), ''), a.tb_code);
  tn := coalesce(nullif(btrim(coalesce(p_tb_name, '')), ''), a.tb_name);
  nk := coalesce(nullif(btrim(coalesce(p_new_key, '')), ''), a.key);
  if length(nm) > 50 then raise exception 'account_name: שם החשבון — עד 50 תווים' using errcode = '22023'; end if;
  if length(tc) > 15 or length(tn) > 30 then raise exception 'account_tb: קוד מאזן בוחן — עד 15 תווים, ושמו — עד 30' using errcode = '22023'; end if;
  if nk <> a.key then
    if a.role is not null then raise exception 'account_key_fixed: למפתח של חשבון של המערכת (או של לקוח / ספק) אין שינוי' using errcode = '23514'; end if;
    if exists (select 1 from public.gl_lines l where l.account_id = a.id) then
      raise exception 'account_key_fixed: למפתח של חשבון שיש בו תנועות אין שינוי' using errcode = '23514'; end if;
    if exists (select 1 from public.gl_accounts x where x.business_id = b and x.parent_key = a.key) then
      raise exception 'account_key_fixed: יש חשבונות תחת החשבון הזה' using errcode = '23514'; end if;
    if nk !~ '^[0-9]{4}(-[0-9]{1,2})?$' then
      raise exception 'account_key: מפתח חשבון — 4 ספרות (אפשר גם "-" ועוד ספרה או שתיים)' using errcode = '22023'; end if;
    if public.gl_key_system(nk) then raise exception 'account_reserved: המפתח % שמור לחשבון של המערכת', nk using errcode = '23505'; end if;
    if exists (select 1 from public.gl_accounts x where x.business_id = b and x.key = nk) then
      raise exception 'account_exists: כבר יש חשבון עם המפתח %', nk using errcode = '23505'; end if;
  end if;
  update public.gl_accounts set name = nm, tb_code = tc, tb_name = tn, key = nk where id = a.id;
  perform public.finance_log(b, 'books.account_updated', 'gl_accounts', a.id::text,
    jsonb_build_object('key', a.key, 'newKey', nk, 'name', nm, 'tbCode', tc, 'tbName', tn,
                       'before', jsonb_build_object('name', a.name, 'tbCode', a.tb_code, 'tbName', a.tb_name)));
  return jsonb_build_object('id', a.id, 'key', nk);
end $$;

-- deactivate (no manual entry and no bank line goes to it any more; nothing is removed) / activate again. A system account is never
-- deactivated (a customer's / a supplier's may be); an account with a balance is not deactivated
create or replace function public.gl_account_set_active(p_key text, p_active boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare b uuid := public.gl_owner_guard(); a public.gl_accounts; bal numeric;
begin
  perform public.gl_books_lock(b);   -- after the guard's finance_log lock
  select * into a from public.gl_accounts where business_id = b and key = btrim(coalesce(p_key, '')) for update;
  if a.id is null then raise exception 'account_missing: החשבון % לא נמצא', p_key using errcode = '22023'; end if;
  if p_active is null then raise exception 'account_active: פעיל או לא' using errcode = '22023'; end if;
  if not p_active then
    if a.role is not null and a.role not like 'customer:%' and a.role not like 'supplier:%' then
      raise exception 'account_system: חשבון של המערכת לא מוסר' using errcode = '23514'; end if;
    select coalesce(sum(case l.side when 'D' then l.amount else -l.amount end), 0) into bal from public.gl_lines l where l.account_id = a.id;
    if bal <> 0 then raise exception 'account_balance: בחשבון יש יתרה (%) — מאפסים אותה בפקודה לפני שמסירים', bal using errcode = '23514'; end if;
  end if;
  update public.gl_accounts set active = p_active where id = a.id;
  perform public.finance_log(b, case when p_active then 'books.account_activated' else 'books.account_deactivated' end, 'gl_accounts', a.id::text,
    jsonb_build_object('key', a.key));
  return jsonb_build_object('id', a.id, 'key', a.key, 'active', p_active);
end $$;

-- ============================================================================================================================
-- 7. the reports from the books (answer 16) — security invoker: the RLS of gl_* (the current business, the locations the person
--    sees — an entry's lines carry its location, so a location's books balance too), report_business's guard (never a cashier).
--    By the entry's date (1362). Amounts: debit positive in "opening" / "closing" / "balance".
-- ============================================================================================================================
-- the trial balance: every account with a movement up to p_to — the balance before p_from, the debits and credits of the period,
-- the balance at its end; by the trial-balance code (B110 1405 / 1406); the totals (opening and closing sum to 0, debit = credit)
create or replace function public.report_trial_balance(p_from date, p_to date) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare b uuid := public.report_business(p_from, p_to); res jsonb;
begin
  with x as (
    -- an account the person may not see (another location's cash / cheques, in an entry of a location the person sees — never
    -- expected) is still a line of the entry: shown without its name, so the trial balance always balances
    select coalesce(a.key, '?') as key, coalesce(a.name, 'חשבון של סניף אחר') as name, coalesce(a.kind, 'asset') as kind,
           coalesce(a.tb_code, '?') as tb_code, coalesce(a.tb_name, 'חשבון של סניף אחר') as tb_name, a.parent_key,
           coalesce(sum(case when t.tx_date < p_from then case l.side when 'D' then l.amount else -l.amount end end), 0) as opening,
           coalesce(sum(l.amount) filter (where l.side = 'D' and t.tx_date >= p_from), 0) as debit,
           coalesce(sum(l.amount) filter (where l.side = 'C' and t.tx_date >= p_from), 0) as credit
      from public.gl_lines l
      join public.gl_transactions t on t.id = l.transaction_id
      left join public.gl_accounts a on a.id = l.account_id
     where l.business_id = b and t.tx_date <= p_to
     group by l.account_id, a.key, a.name, a.kind, a.tb_code, a.tb_name, a.parent_key
  ), g as (
    select tb_code, (array_agg(tb_name order by key))[1] as tb_name, sum(opening) as opening, sum(debit) as debit, sum(credit) as credit, count(*) as n
      from x group by tb_code
  )
  select jsonb_build_object('from', p_from, 'to', p_to,
    'accounts', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'name', name, 'kind', kind, 'tbCode', tb_code, 'tbName', tb_name,
                  'parentKey', parent_key, 'opening', opening, 'debit', debit, 'credit', credit, 'closing', opening + debit - credit)
                  order by tb_code, key) from x), '[]'::jsonb),
    'groups', coalesce((select jsonb_agg(jsonb_build_object('tbCode', tb_code, 'tbName', tb_name, 'accounts', n, 'opening', opening,
                  'debit', debit, 'credit', credit, 'closing', opening + debit - credit) order by tb_code) from g), '[]'::jsonb),
    'total', jsonb_build_object('opening', coalesce((select sum(opening) from x), 0), 'debit', coalesce((select sum(debit) from x), 0),
                                'credit', coalesce((select sum(credit) from x), 0), 'closing', coalesce((select sum(opening + debit - credit) from x), 0)))
    into res;
  return res;
end $$;

-- an account's ledger (כרטסת): its lines (and of the accounts under it — 1300 = every customer, 2100 = every supplier), the
-- running balance from the balance before p_from, the references of each entry
create or replace function public.report_ledger(p_account text, p_from date, p_to date) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare b uuid := public.report_business(p_from, p_to); acc public.gl_accounts; res jsonb;
begin
  select * into acc from public.gl_accounts where business_id = b and key = btrim(coalesce(p_account, ''));
  if acc.id is null then raise exception 'ledger_account: החשבון % לא נמצא', p_account using errcode = '22023'; end if;
  with a as (
    select x.id, x.key, x.name from public.gl_accounts x where x.business_id = b and (x.id = acc.id or x.parent_key = acc.key)
  ), ln as (
    select l.line_no, l.side, l.amount, l.value_date, l.match1, l.match2, t.id as tx, t.number, t.tx_date, t.details, t.source_kind, t.reverses,
           t.ref1_type, t.ref1_number, t.ref2_type, t.ref2_number, a.key, a.name,
           case l.side when 'D' then l.amount else -l.amount end as v
      from public.gl_lines l join public.gl_transactions t on t.id = l.transaction_id join a on a.id = l.account_id
     where l.business_id = b and t.tx_date <= p_to
  ), op as (
    select coalesce(sum(v), 0) as v from ln where tx_date < p_from
  ), per as (
    select ln.*, (select v from op) + sum(ln.v) over (order by ln.tx_date, ln.number, ln.line_no rows between unbounded preceding and current row) as bal
      from ln where ln.tx_date >= p_from
  )
  select jsonb_build_object('account', jsonb_build_object('key', acc.key, 'name', acc.name, 'kind', acc.kind, 'tbCode', acc.tb_code, 'tbName', acc.tb_name,
                                                          'parentKey', acc.parent_key, 'dealer', acc.dealer_number, 'active', acc.active),
    'from', p_from, 'to', p_to, 'opening', (select v from op),
    'debit', coalesce((select sum(amount) filter (where side = 'D') from per), 0), 'credit', coalesce((select sum(amount) filter (where side = 'C') from per), 0),
    'closing', (select v from op) + coalesce((select sum(v) from per), 0),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('date', tx_date, 'valueDate', value_date, 'number', number, 'transactionId', tx,
                         'lineNo', line_no, 'account', key, 'accountName', name, 'details', details, 'sourceKind', source_kind, 'reverses', reverses,
                         'ref1Type', ref1_type, 'ref1Number', ref1_number, 'ref2Type', ref2_type, 'ref2Number', ref2_number,
                         'side', side, 'debit', case when side = 'D' then amount else 0 end, 'credit', case when side = 'C' then amount else 0 end,
                         'balance', bal, 'match1', match1, 'match2', match2) order by tx_date, number, line_no) from per), '[]'::jsonb))
    into res;
  return res;
end $$;

-- the journal (יומן): every entry of the period, in date and number order, with its lines
create or replace function public.report_journal(p_from date, p_to date) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare b uuid := public.report_business(p_from, p_to); res jsonb;
begin
  with t as (
    select x.* from public.gl_transactions x where x.business_id = b and x.tx_date between p_from and p_to
  ), e as (
    select t.*, (select y.id from public.gl_transactions y where y.reverses = t.id) as reversed_by,
           (select jsonb_agg(jsonb_build_object('lineNo', l.line_no, 'account', coalesce(a.key, '?'), 'accountName', coalesce(a.name, 'חשבון של סניף אחר'),
                                                'side', l.side, 'amount', l.amount, 'valueDate', l.value_date, 'match1', l.match1, 'match2', l.match2) order by l.line_no)
              from public.gl_lines l left join public.gl_accounts a on a.id = l.account_id where l.transaction_id = t.id) as lines,
           (select coalesce(sum(l.amount) filter (where l.side = 'D'), 0) from public.gl_lines l where l.transaction_id = t.id) as debit,
           (select coalesce(sum(l.amount) filter (where l.side = 'C'), 0) from public.gl_lines l where l.transaction_id = t.id) as credit
      from t
  )
  select jsonb_build_object('from', p_from, 'to', p_to, 'count', (select count(*) from e), 'debit', coalesce((select sum(debit) from e), 0),
    'credit', coalesce((select sum(credit) from e), 0),
    'entries', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'number', number, 'date', tx_date, 'valueDate', value_date, 'enteredOn', entered_on,
                 'sourceKind', source_kind, 'sourceId', source_id, 'details', details, 'reverses', reverses, 'reversedBy', reversed_by,
                 'ref1Type', ref1_type, 'ref1Number', ref1_number, 'ref2Type', ref2_type, 'ref2Number', ref2_number,
                 'locationId', location_id, 'debit', debit, 'credit', credit, 'lines', coalesce(lines, '[]'::jsonb)) order by tx_date, number) from e), '[]'::jsonb))
    into res;
  return res;
end $$;

-- profit and loss (answer 16): the income (credit − debit) and the expenses (debit − credit) of the period, by account (an account
-- under a parent — in its parent) and by trial-balance code; the profit
create or replace function public.report_profit_loss(p_from date, p_to date) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare b uuid := public.report_business(p_from, p_to); res jsonb;
begin
  with x as (
    select a.kind, coalesce(pa.key, a.key) as key, coalesce(pa.name, a.name) as name, coalesce(pa.tb_code, a.tb_code) as tb_code,
           coalesce(pa.tb_name, a.tb_name) as tb_name,
           sum(case when (l.side = 'C') = (a.kind = 'income') then l.amount else -l.amount end) as amount
      from public.gl_lines l
      join public.gl_transactions t on t.id = l.transaction_id
      join public.gl_accounts a on a.id = l.account_id
      left join public.gl_accounts pa on pa.business_id = a.business_id and pa.key = a.parent_key
     where l.business_id = b and a.kind in ('income', 'expense') and t.tx_date between p_from and p_to
     group by 1, 2, 3, 4, 5
  )
  select jsonb_build_object('from', p_from, 'to', p_to,
    'income', jsonb_build_object('total', coalesce((select sum(amount) from x where kind = 'income'), 0),
      'accounts', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'name', name, 'tbCode', tb_code, 'tbName', tb_name, 'amount', amount) order by tb_code, key)
                              from x where kind = 'income'), '[]'::jsonb),
      'groups', coalesce((select jsonb_agg(jsonb_build_object('tbCode', tb_code, 'tbName', tb_name, 'amount', amount) order by tb_code)
                            from (select tb_code, min(tb_name) as tb_name, sum(amount) as amount from x where kind = 'income' group by tb_code) g), '[]'::jsonb)),
    'expenses', jsonb_build_object('total', coalesce((select sum(amount) from x where kind = 'expense'), 0),
      'accounts', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'name', name, 'tbCode', tb_code, 'tbName', tb_name, 'amount', amount) order by tb_code, key)
                              from x where kind = 'expense'), '[]'::jsonb),
      'groups', coalesce((select jsonb_agg(jsonb_build_object('tbCode', tb_code, 'tbName', tb_name, 'amount', amount) order by tb_code)
                            from (select tb_code, min(tb_name) as tb_name, sum(amount) as amount from x where kind = 'expense' group by tb_code) g), '[]'::jsonb)),
    'profit', coalesce((select sum(case kind when 'income' then amount else -amount end) from x), 0))
    into res;
  return res;
end $$;

-- the balance sheet (answer 16) at a date: the assets (debit − credit), the liabilities and the equity (credit − debit), and the
-- profit not closed yet (the income less the expenses up to the date — the books keep no closing entry) — assets = liabilities
-- + equity + that profit ("balanced")
create or replace function public.report_balance_sheet(p_as_of date) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare b uuid := public.report_business(p_as_of, p_as_of); res jsonb;
begin
  with x as (
    -- an account the person may not see — only another location's cash / cheques can be one: an asset, without its name
    select coalesce(a.kind, 'asset') as kind, coalesce(pa.key, a.key, '?') as key, coalesce(pa.name, a.name, 'חשבון של סניף אחר') as name,
           coalesce(pa.tb_code, a.tb_code, '?') as tb_code, coalesce(pa.tb_name, a.tb_name, 'חשבון של סניף אחר') as tb_name,
           sum(case when (l.side = 'D') = (coalesce(a.kind, 'asset') in ('asset', 'expense')) then l.amount else -l.amount end) as amount
      from public.gl_lines l
      join public.gl_transactions t on t.id = l.transaction_id
      left join public.gl_accounts a on a.id = l.account_id
      left join public.gl_accounts pa on pa.business_id = a.business_id and pa.key = a.parent_key
     where l.business_id = b and t.tx_date <= p_as_of
     group by 1, 2, 3, 4, 5
  ), part as (
    select k.kind, jsonb_build_object('total', coalesce((select sum(amount) from x where x.kind = k.kind), 0),
      'accounts', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'name', name, 'tbCode', tb_code, 'tbName', tb_name, 'amount', amount) order by tb_code, key)
                              from x where x.kind = k.kind), '[]'::jsonb),
      'groups', coalesce((select jsonb_agg(jsonb_build_object('tbCode', tb_code, 'tbName', tb_name, 'amount', amount) order by tb_code)
                            from (select tb_code, min(tb_name) as tb_name, sum(amount) as amount from x where x.kind = k.kind group by tb_code) g), '[]'::jsonb)) as j
      from unnest(array['asset', 'liability', 'equity']) k(kind)
  ), tot as (
    select coalesce(sum(amount) filter (where kind = 'asset'), 0) as assets, coalesce(sum(amount) filter (where kind = 'liability'), 0) as liabilities,
           coalesce(sum(amount) filter (where kind = 'equity'), 0) as equity,
           coalesce(sum(amount) filter (where kind = 'income'), 0) - coalesce(sum(amount) filter (where kind = 'expense'), 0) as earnings
      from x
  )
  select jsonb_build_object('asOf', p_as_of,
    'assets', (select j from part where kind = 'asset'), 'liabilities', (select j from part where kind = 'liability'),
    'equity', (select j from part where kind = 'equity'), 'earnings', tot.earnings,
    'liabilitiesAndEquity', tot.liabilities + tot.equity + tot.earnings,
    'balanced', tot.assets = tot.liabilities + tot.equity + tot.earnings)
    into res from tot;
  return res;
end $$;

-- the books against the existing reports, for a period (from the books' start: an earlier from is moved to it):
--   income / expenses / profit / vat_output / vat_input / vat_payable — the period's movements vs finance_summary(from, to)
--   cash_differences — 6900 vs the register's days closed in the period (register_shifts.difference)
--   receivables — the customers (1300 and under it) at p_to vs the receivables' open balance now (receivables view)
--   cash — the cash accounts at p_to vs the cash received − paid in cash − deposited up to p_to (cash_desks' rule)
--   cheques — the cheques accounts at p_to vs the cheques in the drawer now (cash_desks' rule)
-- Each row: books, explained (the part of the books no source report knows: manual entries, register differences, bank lines
-- posted to an account — and for the period rows the opening balances), source, difference = books − explained − source
-- (0 = the same). The balance rows (receivables, cash, cheques) compare today's sources: call it with p_to = today for them.
create or replace function public.gl_reconcile(p_from date, p_to date) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare b uuid := public.report_business(p_from, p_to); st date; f date; fs jsonb; rows jsonb := '[]'; r record;
  ex_flow text[] := array['manual', 'opening', 'shift', 'bank_class', 'bank_unclass']; ex_bal text[] := array['manual', 'shift', 'bank_class', 'bank_unclass'];
  src_inc numeric := 0; src_profit numeric := 0; src_vout numeric := 0; src_vin numeric := 0; src_vpay numeric := 0; src numeric;
begin
  st := (public.gl_books_state()->>'startDate')::date;    -- the current business's (= b — report_business checked it)
  f := greatest(p_from, st);
  if f <= p_to then
    fs := public.finance_summary(f, p_to);
    src_inc := (fs->'revenue'->>'net')::numeric; src_profit := (fs->>'profit')::numeric; src_vout := (fs->'revenue'->>'vat')::numeric;
    src_vin := (fs->'expenses'->>'vatDeductible')::numeric; src_vpay := (fs->>'vatPayable')::numeric;
  end if;
  select coalesce(-sum(v) filter (where kind = 'income'), 0) as inc, coalesce(-sum(v) filter (where kind = 'income' and source_kind = any (ex_flow)), 0) as inc_x,
         coalesce(sum(v) filter (where kind = 'expense'), 0) as exp, coalesce(sum(v) filter (where kind = 'expense' and source_kind = any (ex_flow)), 0) as exp_x,
         coalesce(-sum(v) filter (where role = 'vat_output'), 0) as vout, coalesce(-sum(v) filter (where role = 'vat_output' and source_kind = any (ex_flow)), 0) as vout_x,
         coalesce(sum(v) filter (where role = 'vat_input'), 0) as vin, coalesce(sum(v) filter (where role = 'vat_input' and source_kind = any (ex_flow)), 0) as vin_x,
         coalesce(sum(v) filter (where role = 'cash_diff'), 0) as cd
    into r
    from (select a.kind, a.role, t.source_kind, case l.side when 'D' then l.amount else -l.amount end as v
            from public.gl_lines l join public.gl_transactions t on t.id = l.transaction_id join public.gl_accounts a on a.id = l.account_id
           where l.business_id = b and t.tx_date between f and p_to) q;
  rows := rows
    || jsonb_build_object('area', 'income', 'books', r.inc, 'explained', r.inc_x, 'source', src_inc, 'difference', r.inc - r.inc_x - src_inc)
    || jsonb_build_object('area', 'expenses', 'books', r.exp, 'explained', r.exp_x, 'source', src_inc - src_profit, 'difference', r.exp - r.exp_x - (src_inc - src_profit))
    || jsonb_build_object('area', 'profit', 'books', r.inc - r.exp, 'explained', r.inc_x - r.exp_x, 'source', src_profit,
                          'difference', (r.inc - r.exp) - (r.inc_x - r.exp_x) - src_profit)
    || jsonb_build_object('area', 'vat_output', 'books', r.vout, 'explained', r.vout_x, 'source', src_vout, 'difference', r.vout - r.vout_x - src_vout)
    || jsonb_build_object('area', 'vat_input', 'books', r.vin, 'explained', r.vin_x, 'source', src_vin, 'difference', r.vin - r.vin_x - src_vin)
    || jsonb_build_object('area', 'vat_payable', 'books', r.vout - r.vin, 'explained', r.vout_x - r.vin_x, 'source', src_vpay,
                          'difference', (r.vout - r.vin) - (r.vout_x - r.vin_x) - src_vpay);
  select coalesce(sum(-s.difference), 0) into src from public.register_shifts s
   where s.business_id = b and s.closed_at is not null and coalesce(s.difference, 0) <> 0 and public.gl_shift_date(s) between f and p_to;
  rows := rows || jsonb_build_object('area', 'cash_differences', 'books', r.cd, 'explained', 0, 'source', src, 'difference', r.cd - src);
  -- the balances at p_to (all of the books: the opening balances are the sources' history before the start)
  select coalesce(sum(v) filter (where cust), 0) as rc, coalesce(sum(v) filter (where cust and source_kind = any (ex_bal)), 0) as rc_x,
         coalesce(sum(v) filter (where role like 'cash:%'), 0) as cash, coalesce(sum(v) filter (where role like 'cash:%' and source_kind = any (ex_bal)), 0) as cash_x,
         coalesce(sum(v) filter (where role like 'cheques:%'), 0) as chq, coalesce(sum(v) filter (where role like 'cheques:%' and source_kind = any (ex_bal)), 0) as chq_x
    into r
    from (select a.role, (a.key = '1300' or a.parent_key = '1300') as cust, t.source_kind, case l.side when 'D' then l.amount else -l.amount end as v
            from public.gl_lines l join public.gl_transactions t on t.id = l.transaction_id join public.gl_accounts a on a.id = l.account_id
           where l.business_id = b and t.tx_date <= p_to) q;
  select coalesce(sum(x.balance), 0) into src from public.receivables x where x.business_id = b and not x.cancelled;
  rows := rows || jsonb_build_object('area', 'receivables', 'books', r.rc, 'explained', r.rc_x, 'source', src, 'difference', r.rc - r.rc_x - src);
  select coalesce((select sum(case p.direction when 'in' then p.amount else -p.amount end) from public.payments p
                    where p.business_id = b and p.method = 'cash' and p.paid_on <= p_to), 0)
       - coalesce((select sum(d.cash) from public.bank_deposits d where d.business_id = b and d.status = 'active' and d.deposited_on <= p_to), 0)
    into src;
  rows := rows || jsonb_build_object('area', 'cash', 'books', r.cash, 'explained', r.cash_x, 'source', src, 'difference', r.cash - r.cash_x - src);
  select coalesce(sum(p.amount), 0) into src from public.payments p
   where p.business_id = b and p.direction = 'in' and p.method = 'cheque' and p.source = 'document'      -- cheque_in_drawer's rule
     and not exists (select 1 from public.document_cancellations c where c.document_id = p.document_id)
     and not exists (select 1 from public.bank_deposit_cheques x where x.payment_id = p.id and x.active)
     and not exists (select 1 from public.bank_matches m where m.payment_id = p.id and m.active);
  rows := rows || jsonb_build_object('area', 'cheques', 'books', r.chq, 'explained', r.chq_x, 'source', src, 'difference', r.chq - r.chq_x - src);
  return jsonb_build_object('from', f, 'to', p_to, 'start', st, 'rows', rows,
    'same', not exists (select 1 from jsonb_array_elements(rows) e where (e->>'difference')::numeric <> 0));
end $$;

-- ============================================================================================================================
-- 8. replaced (same signatures): the old one-sided journal (answer 15), "handled without a match" (answer 17)
-- ============================================================================================================================
-- replaces journal_entry_create() of 20261011005100 — refuses a date from the books' start
CREATE OR REPLACE FUNCTION public.journal_entry_create(p_id uuid, p_date date, p_kind text, p_amount numeric, p_vat numeric, p_vat_side text, p_category text, p_explanation text, p_location uuid DEFAULT NULL::uuid, p_party jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  b uuid := public.finance_guard(); e record; ent text; vat_on boolean; lock_end date; loc uuid; num int;
  amt numeric := coalesce(p_amount, 0); v numeric := coalesce(p_vat, 0); side text; cat text; expl text := btrim(coalesce(p_explanation, ''));
  pk text; lead uuid; pname text := ''; pdealer text := '';
begin
  if not public.can_write() or not public.journal_writer() then
    raise exception 'journal_not_allowed: only the business''s owners record a manual entry' using errcode = '42501'; end if;
  if not public.business_is_active(b) then raise exception 'business_locked' using errcode = '42501'; end if;
  if p_id is null then raise exception 'journal_id: a new entry has an id' using errcode = '22023'; end if;
  -- one entry of the business at a time: its number, the same id twice
  perform pg_advisory_xact_lock(hashtextextended('journal:' || b::text, 0));
  select * into e from public.journal_entries where id = p_id;
  if e.id is not null then
    if e.business_id <> b then raise exception 'not allowed' using errcode = '42501'; end if;
    return jsonb_build_object('id', e.id, 'number', e.number, 'created', false);
  end if;
  if p_date is null or p_date > public.il_today() or p_date < date '2000-01-01' then
    raise exception 'journal_date: an entry is dated today or before' using errcode = '22023'; end if;
  -- 7200 (the owner's answer 15, 27.11.2026): from the books' start an entry is a double one (gl_manual_create); once the books
  -- have started, the one-sided entries are read-only — no new one, whatever its date
  if public.il_today() >= (public.gl_books_ensure(b)).start_date or p_date >= (public.gl_books_ensure(b)).start_date then
    raise exception 'journal_books_started: מתאריך תחילת הספרים (%) פקודה ידנית נרשמת רק כפקודה כפולה (חובה וזכות)', (public.gl_books_ensure(b)).start_date
      using errcode = '23514'; end if;
  lock_end := public.finance_locked_until(b);
  if lock_end is not null and p_date <= lock_end then raise exception 'period_locked: the books are closed until %', lock_end using errcode = '23514'; end if;
  if p_kind is null or p_kind not in ('income', 'expense', 'vat', 'other') then
    raise exception 'journal_kind: income, expense, VAT or other' using errcode = '22023'; end if;
  if amt <> round(amt, 2) or v <> round(v, 2) or abs(amt) > 100000000 or abs(v) > 100000000 then
    raise exception 'journal_amount: an amount of money (agorot)' using errcode = '22023'; end if;
  if amt = 0 and v = 0 then raise exception 'journal_amount: an amount or VAT' using errcode = '22023'; end if;
  select public.entity_of(s.entity_type, s.business_type) into ent from public.register_settings s where s.business_id = b;
  vat_on := public.entity_charges_vat(coalesce(ent, 'licensed_dealer'));
  if v <> 0 and not vat_on then raise exception 'journal_vat: an exempt dealer records no VAT' using errcode = '22023'; end if;
  side := case p_kind when 'income' then 'output' when 'expense' then 'input' when 'vat' then p_vat_side end;
  if p_kind = 'vat' and (side is null or side not in ('output', 'input')) then
    raise exception 'journal_vat_side: VAT on sales or on inputs' using errcode = '22023'; end if;
  if p_kind = 'vat' and (amt <> 0 or v = 0) then raise exception 'journal_vat: a VAT entry is VAT only' using errcode = '22023'; end if;
  if p_kind = 'other' and v <> 0 then raise exception 'journal_vat: an "other" entry carries no VAT' using errcode = '22023'; end if;
  cat := case when p_kind = 'expense' then coalesce(nullif(btrim(coalesce(p_category, '')), ''), 'other') end;
  if cat is not null and cat !~ '^[a-z_]{2,30}$' then raise exception 'journal_category: a kind of expense' using errcode = '22023'; end if;
  if length(expl) < 2 or length(expl) > 500 then raise exception 'journal_explanation: an explanation, 2 to 500 letters' using errcode = '22023'; end if;
  -- whom it belongs to (none is fine): a customer — a CRM card of the business or a name; a supplier — a name; a dealer number
  if p_party is not null and jsonb_typeof(p_party) = 'object' and p_party <> '{}'::jsonb then
    pk := p_party->>'kind';
    if p_kind = 'vat' or pk is null or pk not in ('customer', 'supplier') or (pk = 'customer' and p_kind = 'expense') or (pk = 'supplier' and p_kind = 'income') then
      raise exception 'journal_party: a customer on income, a supplier on an expense, either on "other" — none on VAT' using errcode = '22023'; end if;
    if pk = 'customer' and coalesce(p_party->>'leadId', '') <> '' then
      if (p_party->>'leadId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'journal_party: a customer card of the business' using errcode = '22023'; end if;
      lead := (p_party->>'leadId')::uuid;
      select left(coalesce(l.name, ''), 120) into pname from public.leads l where l.id = lead and l.business_id = b;
      if not found then raise exception 'journal_party: a customer card of the business' using errcode = '22023'; end if;
    else
      pname := left(btrim(coalesce(p_party->>'name', '')), 120);
    end if;
    pdealer := btrim(coalesce(p_party->>'dealer', ''));
    if pdealer <> '' and pdealer !~ '^[0-9]{9}$' then raise exception 'journal_party: a dealer number is 9 digits' using errcode = '22023'; end if;
    if lead is null and length(coalesce(pname, '')) < 2 and pdealer = '' then
      raise exception 'journal_party: a name or a dealer number' using errcode = '22023'; end if;
  end if;
  -- where: the location chosen, else the one picked at the top (else the main one) — an active location of the business
  loc := coalesce(p_location, public.location_pick(b));
  if loc is null or not exists (select 1 from public.business_locations l where l.id = loc and l.business_id = b and l.active) then
    raise exception 'journal_location: an active location of the business' using errcode = '22023'; end if;
  select coalesce(max(j.number), 0) + 1 into num from public.journal_entries j where j.business_id = b;
  insert into public.journal_entries (id, business_id, location_id, number, entry_date, kind, amount, vat, vat_side, category, explanation,
                                      party_kind, lead_id, party_name, party_dealer, user_id)
  values (p_id, b, loc, num, p_date, p_kind, amt, v, side, cat, expl, pk, lead, coalesce(pname, ''), pdealer, auth.uid());
  perform public.finance_log(b, 'journal.created', 'journal_entries', p_id::text, jsonb_build_object(
    'number', num, 'date', p_date, 'kind', p_kind, 'amount', amt, 'vat', v, 'vatSide', side, 'category', cat, 'location', loc,
    'party', case when pk is null then null else jsonb_build_object('kind', pk, 'leadId', lead, 'name', coalesce(pname, ''), 'dealer', pdealer) end,
    'explanation', expl));
  return jsonb_build_object('id', p_id, 'number', num, 'created', true);
end $function$;

-- replaces journal_entry_reverse() of 20261011005100 — refuses a date from the books' start
CREATE OR REPLACE FUNCTION public.journal_entry_reverse(p_id uuid, p_entry uuid, p_date date, p_explanation text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  b uuid := public.finance_guard(); e record; o record; lock_end date; num int; d date := coalesce(p_date, public.il_today());
  expl text := btrim(coalesce(p_explanation, ''));
begin
  if not public.can_write() or not public.journal_writer() then
    raise exception 'journal_not_allowed: only the business''s owners record a manual entry' using errcode = '42501'; end if;
  if not public.business_is_active(b) then raise exception 'business_locked' using errcode = '42501'; end if;
  if p_id is null then raise exception 'journal_id: a new entry has an id' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('journal:' || b::text, 0));
  select * into e from public.journal_entries where id = p_id;
  if e.id is not null then
    if e.business_id <> b or e.reverses is distinct from p_entry then raise exception 'not allowed' using errcode = '42501'; end if;
    return jsonb_build_object('id', e.id, 'number', e.number, 'created', false);
  end if;
  select * into o from public.journal_entries where id = p_entry and business_id = b;
  if o.id is null then raise exception 'journal_entry: the entry was not found in this business' using errcode = '22023'; end if;
  if o.reverses is not null then
    raise exception 'journal_reverse: a reversing entry is not reversed — record a new entry instead' using errcode = '23514'; end if;
  if exists (select 1 from public.journal_entries x where x.reverses = o.id) then
    raise exception 'journal_reversed: the entry was already reversed' using errcode = '23514'; end if;
  if d > public.il_today() or d < o.entry_date then raise exception 'journal_date: a reversal is dated on or after its entry, today or before' using errcode = '22023'; end if;
  -- 7200 (answer 15): a one-sided entry is reversed only while the books have not started (then — a double entry, gl_manual_create)
  if public.il_today() >= (public.gl_books_ensure(b)).start_date or d >= (public.gl_books_ensure(b)).start_date then
    raise exception 'journal_books_started: מתאריך תחילת הספרים (%) פקודה ידנית נרשמת רק כפקודה כפולה (חובה וזכות)', (public.gl_books_ensure(b)).start_date
      using errcode = '23514'; end if;
  lock_end := public.finance_locked_until(b);
  if lock_end is not null and d <= lock_end then raise exception 'period_locked: the books are closed until %', lock_end using errcode = '23514'; end if;
  if length(expl) < 2 or length(expl) > 500 then raise exception 'journal_explanation: an explanation, 2 to 500 letters' using errcode = '22023'; end if;
  if not exists (select 1 from public.business_locations l where l.id = o.location_id and l.business_id = b) then
    raise exception 'journal_location: an active location of the business' using errcode = '22023'; end if;
  select coalesce(max(j.number), 0) + 1 into num from public.journal_entries j where j.business_id = b;
  insert into public.journal_entries (id, business_id, location_id, number, entry_date, kind, amount, vat, vat_side, category, explanation,
                                      party_kind, lead_id, party_name, party_dealer, reverses, user_id)
  values (p_id, b, o.location_id, num, d, o.kind, -o.amount, -o.vat, o.vat_side, o.category, expl,
          o.party_kind, o.lead_id, o.party_name, o.party_dealer, o.id, auth.uid());
  perform public.finance_log(b, 'journal.reversed', 'journal_entries', p_id::text, jsonb_build_object(
    'number', num, 'reverses', o.number, 'date', d, 'kind', o.kind, 'amount', -o.amount, 'vat', -o.vat, 'explanation', expl));
  return jsonb_build_object('id', p_id, 'number', num, 'created', true, 'reverses', o.number);
end $function$;

-- replaces bank_line_handle() of 20261011005000 — a line of the books' time needs an account (bank_line_classify)
CREATE OR REPLACE FUNCTION public.bank_line_handle(p_line uuid, p_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare b uuid := public.bank_guard(true); l record;
begin
  select * into l from public.bank_lines where id = p_line for update;
  if l.id is null or l.business_id <> b then raise exception 'not allowed' using errcode = '42501'; end if;
  if l.status <> 'open' then raise exception 'bank_line_closed: the line is already matched or handled' using errcode = '23514'; end if;
  -- 7200 (the owner's answer 17, 27.11.2026): a line of the books' time handled without a document is posted to an account —
  -- bank_line_classify (the owner); a note alone only for a line of before the start
  if public.gl_books_active(b, l.line_date) then
    raise exception 'bank_line_account_required: שורת בנק מתאריך תחילת הספרים נרשמת לחשבון (bank_line_classify) — לא רק בהערה' using errcode = '23514'; end if;
  if length(btrim(coalesce(p_note, ''))) < 2 then raise exception 'reason_required: a reason or a note, two letters at least' using errcode = '22023'; end if;
  update public.bank_lines set status = 'handled', note = left(btrim(p_note), 300), handled_by = auth.uid(), handled_at = now() where id = l.id;
  perform public.finance_log(b, 'bank.handled', 'bank_lines', l.id::text,
    jsonb_build_object('date', l.line_date, 'amount', l.amount, 'note', left(btrim(p_note), 300)));
  return jsonb_build_object('line', l.id, 'status', 'handled');
end $function$;

-- replaces bank_line_reopen() of 20261011005000 — a line posted to an account: its entry reversed
CREATE OR REPLACE FUNCTION public.bank_line_reopen(p_line uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare b uuid := public.bank_guard(true); l record;
begin
  select * into l from public.bank_lines where id = p_line for update;
  if l.id is null or l.business_id <> b then raise exception 'not allowed' using errcode = '42501'; end if;
  if l.status <> 'handled' then raise exception 'bank_line_not_handled: the line is not marked handled' using errcode = '23514'; end if;
  -- 7200 (answer 17): a line posted to an account (bank_line_classify) — its entry is reversed (at commit — zz_gl_post_more_undo
  -- on gl_bank_line_accounts)
  if exists (select 1 from public.gl_bank_line_accounts c where c.bank_line_id = l.id and c.active) then
    update public.gl_bank_line_accounts set active = false, undone_at = now(), undone_by = auth.uid() where bank_line_id = l.id and active;
  end if;
  update public.bank_lines set status = 'open', note = '', handled_by = null, handled_at = null where id = l.id;
  perform public.finance_log(b, 'bank.reopened', 'bank_lines', l.id::text, jsonb_build_object('date', l.line_date, 'amount', l.amount, 'note', l.note));
  return jsonb_build_object('line', l.id, 'status', 'open');
end $function$;


-- ============================================================================================================================
-- 9. who may call what
-- ============================================================================================================================
revoke execute on function public.gl_customer_account(uuid, text, text, text, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.gl_key_reserved(text) from public, anon;
grant execute on function public.gl_key_reserved(text) to authenticated, service_role;
revoke execute on function public.gl_bank_line_accounts_guard(), public.gl_accounts_guard(),
  public.gl_system_account(uuid, text, text, text, text, text, text), public.gl_supplier_account(uuid, text, text),
  public.gl_expense_money_account(uuid, text, uuid), public.gl_payment_money_account(public.payments), public.gl_open_date(uuid, date),
  public.gl_business_vat(uuid), public.gl_books_lock(uuid),
  public.gl_write(uuid, text, uuid, text, date, public.gl_line_in[], text, uuid, uuid, uuid, text, int, text, int, text, uuid),
  public.gl_write_reversal(uuid, text, text, date, text, uuid, uuid, uuid), public.gl_standing(text, uuid),
  public.gl_lines_expense(uuid), public.gl_lines_shift(uuid), public.gl_source_more(text, uuid), public.gl_post_more(text, uuid),
  public.gl_post_safe(text, uuid), public.gl_on_more(), public.gl_owner_guard(), public.gl_chart_ready(uuid), public.gl_key_system(text) from public, anon, authenticated;
-- the triggers' WHEN and the view gl_unposted run as whoever writes / reads: a fingerprint of a row, a day
revoke execute on function public.gl_expense_hash(public.expenses), public.gl_shift_hash(public.register_shifts), public.gl_shift_date(public.register_shifts),
  public.gl_supplier_role(text, text)
  from public, anon;
grant execute on function public.gl_expense_hash(public.expenses), public.gl_shift_hash(public.register_shifts), public.gl_shift_date(public.register_shifts),
  public.gl_supplier_role(text, text)
  to authenticated, service_role;
revoke execute on function public.gl_manual_create(uuid, date, text, jsonb, uuid), public.gl_manual_reverse(uuid, uuid, date, text),
  public.bank_line_classify(uuid, text, text), public.gl_account_add(text, text, text, text, text, text),
  public.gl_account_update(text, text, text, text, text), public.gl_account_set_active(text, boolean),
  public.report_trial_balance(date, date), public.report_ledger(text, date, date), public.report_journal(date, date),
  public.report_profit_loss(date, date), public.report_balance_sheet(date), public.gl_reconcile(date, date) from public, anon;
grant execute on function public.gl_manual_create(uuid, date, text, jsonb, uuid), public.gl_manual_reverse(uuid, uuid, date, text),
  public.bank_line_classify(uuid, text, text), public.gl_account_add(text, text, text, text, text, text),
  public.gl_account_update(text, text, text, text, text), public.gl_account_set_active(text, boolean),
  public.report_trial_balance(date, date), public.report_ledger(text, date, date), public.report_journal(date, date),
  public.report_profit_loss(date, date), public.report_balance_sheet(date), public.gl_reconcile(date, date) to authenticated;
grant execute on function public.gl_post_more(text, uuid) to service_role;

-- ============================================================================================================================
-- 10. the triggers on the sources — last (they take a short lock on expenses, payments, register_shifts, bank_matches). Before a
--     business's start nothing is even queued (the WHEN), so a transaction before the start runs exactly as before
-- ============================================================================================================================
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'zz_gl_post_more' and tgrelid = 'public.gl_bank_line_accounts'::regclass) then
    create constraint trigger zz_gl_post_more after insert on public.gl_bank_line_accounts deferrable initially deferred
      for each row when (public.gl_books_active(new.business_id, public.il_today())) execute function public.gl_on_more('bank_class');
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'zz_gl_post_more_undo' and tgrelid = 'public.gl_bank_line_accounts'::regclass) then
    create constraint trigger zz_gl_post_more_undo after update of active on public.gl_bank_line_accounts deferrable initially deferred
      for each row when (old.active and not new.active and public.gl_books_active(new.business_id, public.il_today()))
      execute function public.gl_on_more('bank_unclass');
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'zz_gl_post_more' and tgrelid = 'public.expenses'::regclass) then
    create constraint trigger zz_gl_post_more after insert on public.expenses deferrable initially deferred
      for each row when (new.status = 'confirmed' and public.gl_books_active(new.business_id, new.doc_date)) execute function public.gl_on_more('expense');
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'zz_gl_post_more_change' and tgrelid = 'public.expenses'::regclass) then
    create constraint trigger zz_gl_post_more_change after update on public.expenses deferrable initially deferred
      for each row when (public.gl_expense_hash(new) is distinct from public.gl_expense_hash(old)
                         and (public.gl_books_active(new.business_id, new.doc_date) or public.gl_books_active(old.business_id, old.doc_date)))
      execute function public.gl_on_more('expense');
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'zz_gl_post_more' and tgrelid = 'public.payments'::regclass) then
    create constraint trigger zz_gl_post_more after insert on public.payments deferrable initially deferred
      for each row when (new.expense_id is not null and new.source in ('expense', 'reversal') and public.gl_books_active(new.business_id, new.paid_on))
      execute function public.gl_on_more('expense_payment');
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'zz_gl_post_more' and tgrelid = 'public.register_shifts'::regclass) then
    create constraint trigger zz_gl_post_more after insert on public.register_shifts deferrable initially deferred
      for each row when (new.closed_at is not null and coalesce(new.difference, 0) <> 0
                         and public.gl_books_active(new.business_id, public.gl_shift_date(new))) execute function public.gl_on_more('shift');
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'zz_gl_post_more_change' and tgrelid = 'public.register_shifts'::regclass) then
    create constraint trigger zz_gl_post_more_change after update on public.register_shifts deferrable initially deferred
      for each row when (public.gl_shift_hash(new) is distinct from public.gl_shift_hash(old)
                         and (public.gl_books_active(new.business_id, public.gl_shift_date(new)) or public.gl_books_active(old.business_id, public.gl_shift_date(old))))
      execute function public.gl_on_more('shift');
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'zz_gl_post_more' and tgrelid = 'public.bank_matches'::regclass) then
    create constraint trigger zz_gl_post_more after insert on public.bank_matches deferrable initially deferred
      for each row when (new.payment_id is not null and public.gl_books_active(new.business_id, public.il_today()))
      execute function public.gl_on_more('bank_match');
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'zz_gl_post_more_undo' and tgrelid = 'public.bank_matches'::regclass) then
    create constraint trigger zz_gl_post_more_undo after update of active on public.bank_matches deferrable initially deferred
      for each row when (old.active and not new.active and new.payment_id is not null and public.gl_books_active(new.business_id, public.il_today()))
      execute function public.gl_on_more('bank_unmatch');
  end if;
end $$;

-- ============================================================================================================================
-- Rollback (by hand, if ever needed):
--   * stop the new posting first (the sources work as before without it):
--       drop trigger zz_gl_post_more on expenses; drop trigger zz_gl_post_more_change on expenses;
--       drop trigger zz_gl_post_more on payments; drop trigger zz_gl_post_more on register_shifts;
--       drop trigger zz_gl_post_more_change on register_shifts; drop trigger zz_gl_post_more on bank_matches;
--       drop trigger zz_gl_post_more_undo on bank_matches;
--   * the replaced functions: run again their old versions — gl_post_safe(), gl_key_reserved(), gl_customer_account() and the view
--     gl_unposted of 20261128007100 (only while no supplier account was opened: select count(*) from gl_accounts where role like
--     'supplier:%' = 0 — else a customer could take a supplier's key; the TS's glKeyReserved goes back with them), journal_entry_create() / journal_entry_reverse() of 20261011005100, bank_line_handle() / bank_line_reopen() of
--     20261011005000 (bank_line_reopen of 5000 does not undo a line's account — only while no line was posted to an account:
--     select count(*) from gl_bank_line_accounts = 0);
--   * only while none of the new entries exists (select count(*) from gl_transactions where source_kind in ('expense',
--     'expense_payment', 'shift', 'bank_match', 'bank_unmatch', 'bank_class', 'bank_unclass', 'manual') = 0) — else the entries are
--     the books: keep them, fix forward:
--       drop function gl_reconcile(date, date), report_balance_sheet(date), report_profit_loss(date, date), report_journal(date, date),
--         report_ledger(text, date, date), report_trial_balance(date, date), gl_account_set_active(text, boolean),
--         gl_account_update(text, text, text, text, text), gl_account_add(text, text, text, text, text, text),
--         bank_line_classify(uuid, text, text), gl_manual_reverse(uuid, uuid, date, text), gl_manual_create(uuid, date, text, jsonb, uuid),
--         gl_owner_guard(), gl_chart_ready(uuid), gl_on_more(), gl_post_more(text, uuid), gl_source_more(text, uuid), gl_lines_shift(uuid), gl_lines_expense(uuid),
--         gl_standing(text, uuid), gl_write_reversal(uuid, text, text, date, text, uuid, uuid, uuid),
--         gl_write(uuid, text, uuid, text, date, gl_line_in[], text, uuid, uuid, uuid, text, int, text, int, text, uuid), gl_books_lock(uuid),
--         gl_business_vat(uuid), gl_open_date(uuid, date), gl_shift_hash(register_shifts), gl_shift_date(register_shifts),
--         gl_expense_hash(expenses), gl_payment_money_account(payments), gl_expense_money_account(uuid, text, uuid),
--         gl_supplier_account(uuid, text, text), gl_supplier_role(text, text), gl_key_system(text), gl_system_account(uuid, text, text, text, text, text, text);
--       drop trigger gl_accounts_guard on gl_accounts; drop function gl_accounts_guard();
--       drop table gl_bank_line_accounts; drop function gl_bank_line_accounts_guard();
--       alter table gl_transactions drop constraint gl_transactions_source_kind_check, add constraint gl_transactions_source_kind_check
--         check (source_kind in ('document', 'cancellation', 'payment', 'deposit', 'deposit_cancel', 'opening'));
--       alter table gl_transactions drop column source_hash;
--     (the accounts the new sources opened — suppliers under 2100, 2150 — stay: gl_accounts are never removed)
-- ============================================================================================================================
