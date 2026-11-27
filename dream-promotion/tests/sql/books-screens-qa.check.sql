-- QA 2.123 (stage 4ד) on a real Postgres: 7200 + 7300 again, then
--   1. a seeded month (opening balances with a customer and suppliers, expenses of those suppliers, manual entries, one reversed) —
--      the real report_* functions' answers are written to /tmp/dp-books-real-db.json, which tests/sql/books-screens-real-db.ts (run by tests/sql/run.sh)
--      compares with what the screens' pure helpers (ledger.ts) show: the screens must show exactly the database's numbers
--   2. a manual entry off by one agora is refused (nothing kept); the same id twice = one entry (a double tap)
--   3. the customer's account key = what glCustomerKey writes for the CRM card (the key the test file also computes in TypeScript)
--   4. permissions: cashier / calendar / viewer / another business / anon never run the owner functions; a non-owner with access
--      'full' reads the reports but runs no owner function
-- Fixtures only, fictional (dealer numbers 000000059 / 000000067, phones 050-00000NN, mails *.example.test).
\set ON_ERROR_STOP 1
set client_min_messages = warning;
\ir ../../supabase/migrations/20261129007200_books_more.sql
\ir ../../supabase/migrations/20261130007300_books_opening_suppliers.sql

create or replace function pg_temp.check(ok boolean, msg text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'CHECK FAILED: %', msg; end if; end $$;
create or replace function pg_temp.refused_with(stmt text, expect text, msg text) returns void language plpgsql as $$
begin
  execute stmt;
  raise exception 'CHECK FAILED: % (it was allowed)', msg;
exception when others then
  if sqlerrm like 'CHECK FAILED%' then raise; end if;
  if position(expect in sqlerrm) = 0 then raise exception 'CHECK FAILED: % (refused, but with "%")', msg, sqlerrm; end if;
end $$;
create or replace function pg_temp.as_user(uid text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', uid, true), set_config('request.jwt.claim.role', 'authenticated', true);
$$;
create temp table outq (k text, j jsonb);
grant all on outq to authenticated, anon;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000a0a1', 'owner@qa-scr.example.test'), ('00000000-0000-0000-0000-00000000a0a2', 'fullmember@qa-scr.example.test'),
  ('00000000-0000-0000-0000-00000000a0a3', 'cashier@qa-scr.example.test'), ('00000000-0000-0000-0000-00000000a0a4', 'calendar@qa-scr.example.test'),
  ('00000000-0000-0000-0000-00000000a0a5', 'viewer@qa-scr.example.test'), ('00000000-0000-0000-0000-00000000a0a6', 'other@qa-scr.example.test');
insert into public.businesses (id, name, slug) values ('00000000-0000-0000-0000-00000000a0b1', 'QA Screens', 'qa-screens'), ('00000000-0000-0000-0000-00000000a0b2', 'QA Other', 'qa-other');
insert into public.business_members (business_id, user_id, role, access, locations) values
  ('00000000-0000-0000-0000-00000000a0b1', '00000000-0000-0000-0000-00000000a0a1', 'owner', 'full', null),
  ('00000000-0000-0000-0000-00000000a0b1', '00000000-0000-0000-0000-00000000a0a2', 'editor', 'full', null),
  ('00000000-0000-0000-0000-00000000a0b1', '00000000-0000-0000-0000-00000000a0a3', 'editor', 'register', null),
  ('00000000-0000-0000-0000-00000000a0b1', '00000000-0000-0000-0000-00000000a0a4', 'editor', 'calendar', null),
  ('00000000-0000-0000-0000-00000000a0b1', '00000000-0000-0000-0000-00000000a0a5', 'viewer', 'full', null),
  ('00000000-0000-0000-0000-00000000a0b2', '00000000-0000-0000-0000-00000000a0a6', 'owner', 'full', null);
update public.profiles set current_business_id = '00000000-0000-0000-0000-00000000a0b1'
 where id in ('00000000-0000-0000-0000-00000000a0a1','00000000-0000-0000-0000-00000000a0a2','00000000-0000-0000-0000-00000000a0a3','00000000-0000-0000-0000-00000000a0a4','00000000-0000-0000-0000-00000000a0a5');
update public.profiles set current_business_id = '00000000-0000-0000-0000-00000000a0b2' where id = '00000000-0000-0000-0000-00000000a0a6';
insert into public.register_settings (user_id, business_id, business_type, vat_rate, dealer_number, legal_name, street, city, entity_type) values
  ('00000000-0000-0000-0000-00000000a0a1', '00000000-0000-0000-0000-00000000a0b1', 'licensed', 18, '000000059', 'עסק בדיקה לדוגמה', 'הדוגמה', 'עיר דוגמה', 'licensed_dealer'),
  ('00000000-0000-0000-0000-00000000a0a6', '00000000-0000-0000-0000-00000000a0b2', 'licensed', 18, '000000067', 'עסק אחר לדוגמה', 'הדוגמה', 'עיר דוגמה', 'licensed_dealer');

begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000a0a1');
select public.gl_books_start_set(date_trunc('month', public.il_today())::date);
commit;

-- ---- 4a. before any entry: who may do what ---------------------------------------------------------------------------------------
do $$
declare u text; stmt text; n int := 0;
begin
  -- owner functions refused to everyone but the owner (and anon, and a member of another business who is not in this business)
  foreach u in array array['a0a2','a0a3','a0a4','a0a5'] loop
    perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000' || u, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    set local role authenticated;
    foreach stmt in array array[
      $q$select public.gl_opening_balances('[{"account":"BANK","side":"D","amount":5}]')$q$,
      $q$select public.gl_account_add('7777','x','expense','7777','x',null)$q$,
      $q$select public.gl_manual_create(gen_random_uuid(), public.il_today(), 'בדיקה', '[{"account":"BANK","side":"D","amount":1},{"account":"3100","side":"C","amount":1}]', null)$q$,
      $q$select public.gl_books_start_set(public.il_today())$q$] loop
      begin
        execute stmt;
        raise exception 'CHECK FAILED: % ran % (should be refused)', u, stmt;
      exception when others then
        if sqlerrm like 'CHECK FAILED%' then raise; end if;
        n := n + 1;
      end;
    end loop;
    reset role;
  end loop;
  if n <> 16 then raise exception 'CHECK FAILED: refusals counted %, expected 16', n; end if;
end $$;
-- anon
begin;
set local role anon;
select pg_temp.refused_with($$select public.gl_opening_balances('[]')$$, '', 'anon: owner function');
select pg_temp.refused_with($$select public.report_trial_balance(public.il_today(), public.il_today())$$, '', 'anon: reports');
rollback;
select pg_temp.check(not exists (select 1 from public.gl_transactions where business_id = '00000000-0000-0000-0000-00000000a0b1'), 'nothing was kept by the refused calls');

-- ---- 1. the seeded month ---------------------------------------------------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000a0a1');
insert into outq select 'open', public.gl_opening_balances('[
  {"supplier": {"dealer": "000000067", "name": "ספק בדיקה לדוגמה"}, "side": "C", "amount": 500.5},
  {"account": "BANK", "side": "D", "amount": 1000},
  {"account": "050-0000081", "name": "לקוח בדיקה לדוגמה", "side": "D", "amount": 50.25}]');
select pg_temp.refused_with($$select public.gl_opening_balances('[{"account":"BANK","side":"D","amount":1}]')$$, 'opening_done', 'opening balances only once');
commit;
-- 3. the customer's account key is the one glCustomerKey writes (TS side: tests/sql/books-screens-real-db.ts (run by tests/sql/run.sh))
select pg_temp.check(exists (select 1 from public.gl_accounts where business_id = '00000000-0000-0000-0000-00000000a0b1' and key = '050-0000081' and parent_key = '1300'),
  'the customer line opens an account under 1300 by the key it was given');

begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000a0a1');
insert into public.expenses (id, user_id, supplier_name, supplier_dealer, supplier_doc_type, doc_date, category, amount_before_vat, vat_amount, total, paid_on, payment_method) values
  ('00000000-0000-0000-0000-00000000a0e1', '00000000-0000-0000-0000-00000000a0a1', 'שם אחר בע״מ', '000000067', 'tax_invoice', public.il_today(), 'rent', 100.10, 18.02, 118.12, null, null);
-- 2. a manual entry off by one agora: refused, and nothing is kept
select pg_temp.refused_with($$select public.gl_manual_create('00000000-0000-0000-0000-00000000a0c0', public.il_today(), 'לא מאוזן',
  '[{"account":"BANK","side":"D","amount":10.01},{"account":"3100","side":"C","amount":10.00}]', null)$$, 'manual_unbalanced', 'off by one agora');
commit;
select pg_temp.check(not exists (select 1 from public.gl_transactions where id = '00000000-0000-0000-0000-00000000a0c0'), 'the unbalanced entry left nothing');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000a0a1');
insert into outq select 'm1', public.gl_manual_create('00000000-0000-0000-0000-00000000a0c1', public.il_today(), 'פקודת בדיקה',
  '[{"account":"BANK","side":"D","amount":10.01},{"account":"3100","side":"C","amount":10.01}]', null);
-- a double tap with the same id: the same entry, once
insert into outq select 'm1again', public.gl_manual_create('00000000-0000-0000-0000-00000000a0c1', public.il_today(), 'פקודת בדיקה',
  '[{"account":"BANK","side":"D","amount":10.01},{"account":"3100","side":"C","amount":10.01}]', null);
insert into outq select 'm2', public.gl_manual_create('00000000-0000-0000-0000-00000000a0c2', public.il_today(), 'פקודה לביטול',
  '[{"account":"BANK","side":"C","amount":3},{"account":"3100","side":"D","amount":3}]', null);
commit;
select pg_temp.check((select count(*) from public.gl_transactions where id = '00000000-0000-0000-0000-00000000a0c1') = 1
  and (select count(*) from public.gl_transactions where business_id = '00000000-0000-0000-0000-00000000a0b1' and source_kind = 'manual' and details = 'פקודת בדיקה') = 1,
  'a double tap = one entry');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000a0a1');
select public.gl_manual_reverse(gen_random_uuid(), '00000000-0000-0000-0000-00000000a0c2', public.il_today(), 'ביטול בדיקה');
commit;

-- 4b. a non-owner with access 'full' reads the reports
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000a0a2');
select pg_temp.check((public.report_trial_balance(date_trunc('month', public.il_today())::date, public.il_today())->'total') is not null, 'a full-finance non-owner reads the trial balance');
select pg_temp.check(public.report_journal(date_trunc('month', public.il_today())::date, public.il_today()) is not null, 'a full-finance non-owner reads the journal');
commit;
-- the cashier / calendar member reads nothing of the books
do $$
declare u text; stmt text;
begin
  foreach u in array array['a0a3','a0a4','a0a6'] loop
    perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000' || u, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    set local role authenticated;
    if u <> 'a0a6' then
      begin
        perform public.report_journal(date_trunc('month', public.il_today())::date, public.il_today());
        raise exception 'CHECK FAILED: % read the journal', u;
      exception when others then if sqlerrm like 'CHECK FAILED%' then raise; end if; end;
    else
      -- another business: sees its own (empty) books, never this business' entries
      if (public.report_journal(date_trunc('month', public.il_today())::date, public.il_today())->>'count')::int <> 0 then
        raise exception 'CHECK FAILED: another business saw entries'; end if;
    end if;
    reset role;
  end loop;
end $$;

-- the dump the TS test compares with the screens
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000a0a1');
insert into outq select 'tb', public.report_trial_balance(date_trunc('month', public.il_today())::date, public.il_today());
insert into outq select 'journal', public.report_journal(date_trunc('month', public.il_today())::date, public.il_today());
insert into outq select 'pnl', public.report_profit_loss(date_trunc('month', public.il_today())::date, public.il_today());
insert into outq select 'bs', public.report_balance_sheet(public.il_today());
insert into outq select 'recon', public.gl_reconcile(date_trunc('month', public.il_today())::date, public.il_today());
insert into outq select 'ledger:' || a.key, public.report_ledger(a.key, date_trunc('month', public.il_today())::date, public.il_today())
  from public.gl_accounts a where a.business_id = '00000000-0000-0000-0000-00000000a0b1' and a.key in ('BANK', '3100', '050-0000081', 'S-000000067');
commit;
select pg_temp.check((select count(*) from outq where k like 'ledger:%') = 4, 'four ledgers dumped');
-- independent sums straight from gl_lines, to compare with the reports
insert into outq select 'raw', (select jsonb_object_agg(a.key, coalesce(s.net, 0)) from public.gl_accounts a
  left join (select l.account_id, sum(case l.side when 'D' then l.amount else -l.amount end) net from public.gl_lines l group by 1) s on s.account_id = a.id
  where a.business_id = '00000000-0000-0000-0000-00000000a0b1');
\o /tmp/dp-books-real-db.json
\t on
\a
select jsonb_object_agg(k, j) from outq;
\o
\t off
\a
