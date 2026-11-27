-- Stage 4ג — the double-entry books, the rest of the sources (migration 7200) on a real Postgres (tests/sql/run.sh):
--   1. the migration over existing rows (expenses, their payments, a register's day, a bank file and a match, journal entries — of
--      three businesses, written while their books have not started) and again: every row stays as it was, nothing posts
--   2. the owner moves the start to the 1st of this month → the expense, its payment, the day's difference and the card match are
--      pending and post (gl_replay); again — nothing
--   3. the posting matrix: an expense (VAT deducted in part; unknown category; exempt dealer), its payment by cash / card / transfer /
--      cheque / other, a supplier's credit note and its money back, a draft confirmed, a confirmed expense edited (reversed and posted
--      again), a void (both reversed), the register's difference (short / over / changed), the bank (card / transfer / deposit / the
--      business's card / a cheque cleared directly / unmatching), a bank line to an account (answer 17) and opened again
--   4. never blocks: a posting that fails leaves the expense saved, is recorded and listed, and posts again (gl_replay)
--   5. the manual double entry (balanced only, the owner, the dates, once, reversal once), the old one-sided journal refused from
--      the start (answer 15), the chart (add / rename / key / deactivate), the reports (trial balance, ledger, journal, profit and
--      loss, balance sheet) and gl_reconcile (every row the same), the RLS (cashier, another business, a location-limited member)
-- Fixtures only, fictional: dealer numbers 000000059 / 000000083 / 000000091 / 000000067 / 000000075 (valid check digit), phones
-- 050-00000NN, mails *.example.test, bank account 000-0000001.
--   "Lic"   L: l1 owner, l2 cashier, l3 editor limited to L2, l4 editor (full); locations main (= the business) and L2 (register R2)
--   "Ex"    E: e1 owner (exempt dealer)
--   "Late"  S: s1 owner (licensed; keeps the default start — next month)
\set ON_ERROR_STOP 1
set client_min_messages = warning;

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
-- a receipt the way the app sends it (320 by default, cash)
create or replace function pg_temp.doc(p_user text, p_type int, p_net numeric, p_key text, p_pay jsonb default null, p_extra jsonb default '{}', p_rate numeric default 18)
returns uuid language plpgsql as $$
declare vat numeric := case when p_type = 400 then 0 else round(p_net * p_rate / 100, 2) end; r jsonb; cols text; id uuid;
begin
  r := jsonb_build_object('user_id', p_user, 'doc_type', p_type, 'doc_number', 0, 'doc_date', public.il_today(),
    'customer_name', 'דנה לדוגמה', 'customer_phone', '050-0000072', 'before_discount', p_net, 'discount', 0, 'after_discount', p_net,
    'vat_amount', vat, 'total', p_net + vat, 'vat_rate', case when p_type = 400 then 0 else p_rate end, 'idempotency_key', p_key,
    'lines', jsonb_build_array(jsonb_build_object('name', 'שירות', 'totalExVat', p_net, 'kind', 1, 'qty', 1, 'unitPriceExVat', p_net, 'discountExVat', 0, 'vatRate', p_rate)),
    'payments', case when p_type in (320, 400) then coalesce(p_pay, jsonb_build_array(jsonb_build_object('method', 1, 'm', 'cash', 'amount', p_net + vat, 'date', public.il_today())))
                     else '[]'::jsonb end) || p_extra;
  select string_agg(quote_ident(k), ', ') into cols from jsonb_object_keys(r) k;
  execute format('insert into public.documents (%s) select %s from jsonb_populate_record(null::public.documents, $1) returning id', cols, cols) using r into id;
  return id;
end $$;
-- an expense the way the app writes it (as the signed-in member — the RLS and the triggers)
create or replace function pg_temp.exp(p_id text, p_user text, p_supplier text, p_dealer text, p_net numeric, p_vat numeric, p_pct numeric,
                                       p_category text, p_method text default null, p_status text default 'confirmed', p_type text default 'tax_invoice',
                                       p_date date default null)
returns uuid language sql as $$
  insert into public.expenses (id, user_id, supplier_name, supplier_dealer, supplier_doc_type, supplier_doc_number, doc_date, category,
                               amount_before_vat, vat_amount, total, vat_deductible_pct, paid_on, payment_method, status)
  values (p_id::uuid, p_user::uuid, p_supplier, coalesce(p_dealer, ''), p_type, 'INV-' || right(p_id, 4), coalesce(p_date, public.il_today()), p_category,
          p_net, p_vat, p_net + p_vat, p_pct, case when p_method is not null then coalesce(p_date, public.il_today()) end, p_method, p_status)
  returning id
$$;
create or replace function pg_temp.lines(p_tx uuid) returns text language sql as $$
  select string_agg(a.key || ' ' || l.side || ' ' || l.amount, ', ' order by l.line_no)
    from public.gl_lines l join public.gl_accounts a on a.id = l.account_id where l.transaction_id = p_tx $$;
-- the standing entry of a source in sync / the entry of a source posted once
create or replace function pg_temp.st(p_kind text, p_id text) returns public.gl_transactions language sql as $$
  select * from public.gl_standing(p_kind, p_id::uuid) $$;
create or replace function pg_temp.tx(p_kind text, p_id uuid) returns public.gl_transactions language sql as $$
  select * from public.gl_transactions where idempotency_key = p_kind || ':' || p_id $$;
create or replace function pg_temp.pay_of(p_expense text, p_source text default 'expense') returns uuid language sql as $$
  select id from public.payments where expense_id = p_expense::uuid and source = p_source order by created_at desc limit 1 $$;
create or replace function pg_temp.bal(p_business text, p_key text) returns numeric language sql as $$
  select coalesce(sum(case l.side when 'D' then l.amount else -l.amount end), 0) from public.gl_lines l join public.gl_accounts a on a.id = l.account_id
   where a.business_id = p_business::uuid and a.key = p_key $$;
create or replace function pg_temp.n(p_business text) returns bigint language sql as $$
  select count(*) from public.gl_transactions where business_id = p_business::uuid $$;
create temp table out72 (k text, j jsonb);
grant all on out72 to authenticated;
create or replace function pg_temp.o(p_k text) returns jsonb language sql as $$ select j from out72 where k = p_k $$;
create or replace function pg_temp.row(p_j jsonb, p_area text) returns jsonb language sql as $$
  select e from jsonb_array_elements(p_j->'rows') e where e->>'area' = p_area $$;
create or replace function pg_temp.snapshot() returns text language sql as $$
  select md5(coalesce((select string_agg(x::text, '|' order by x.id) from public.expenses x where x.business_id::text like '00000000-0000-0000-0000-0000007200b%'), '')
      || coalesce((select string_agg(x::text, '|' order by x.id) from public.payments x where x.business_id::text like '00000000-0000-0000-0000-0000007200b%'), '')
      || coalesce((select string_agg(x::text, '|' order by x.id) from public.documents x where x.business_id::text like '00000000-0000-0000-0000-0000007200b%'), '')
      || coalesce((select string_agg(x::text, '|' order by x.id) from public.register_shifts x where x.business_id::text like '00000000-0000-0000-0000-0000007200b%'), '')
      || coalesce((select string_agg(x::text, '|' order by x.id) from public.bank_lines x where x.business_id::text like '00000000-0000-0000-0000-0000007200b%'), '')
      || coalesce((select string_agg(x::text, '|' order by x.id) from public.bank_matches x where x.business_id::text like '00000000-0000-0000-0000-0000007200b%'), '')
      || coalesce((select string_agg(x::text, '|' order by x.id) from public.journal_entries x where x.business_id::text like '00000000-0000-0000-0000-0000007200b%'), '')
      || coalesce((select string_agg(x::text, '|' order by x.id) from public.gl_accounts x where x.business_id::text like '00000000-0000-0000-0000-0000007200b%'), '')
      || coalesce((select string_agg(x::text, '|' order by x.business_id) from public.gl_books x where x.business_id::text like '00000000-0000-0000-0000-0000007200b%'), ''));
$$;

-- ---- "before" ----------------------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000007200a1', 'owner@lic-72.example.test'), ('00000000-0000-0000-0000-0000007200a2', 'cashier@lic-72.example.test'),
  ('00000000-0000-0000-0000-0000007200a3', 'branch@lic-72.example.test'), ('00000000-0000-0000-0000-0000007200a4', 'owner@ex-72.example.test'),
  ('00000000-0000-0000-0000-0000007200a5', 'owner@late-72.example.test'), ('00000000-0000-0000-0000-0000007200a6', 'editor@lic-72.example.test');
insert into public.businesses (id, name, slug) values
  ('00000000-0000-0000-0000-0000007200b1', 'Lic 72', 'lic-72'), ('00000000-0000-0000-0000-0000007200b2', 'Ex 72', 'ex-72'),
  ('00000000-0000-0000-0000-0000007200b3', 'Late 72', 'late-72');
insert into public.business_locations (id, business_id, name, kind, sort) values
  ('00000000-0000-0000-0000-0000007200c2', '00000000-0000-0000-0000-0000007200b1', 'סניף שני לדוגמה', 'branch', 1);
insert into public.registers (id, business_id, location_id, name) values
  ('00000000-0000-0000-0000-0000007200d2', '00000000-0000-0000-0000-0000007200b1', '00000000-0000-0000-0000-0000007200c2', 'קופה בסניף השני');
insert into public.business_members (business_id, user_id, role, access, locations) values
  ('00000000-0000-0000-0000-0000007200b1', '00000000-0000-0000-0000-0000007200a1', 'owner', 'full', null),
  ('00000000-0000-0000-0000-0000007200b1', '00000000-0000-0000-0000-0000007200a2', 'editor', 'register', null),
  ('00000000-0000-0000-0000-0000007200b1', '00000000-0000-0000-0000-0000007200a3', 'editor', 'full', array['00000000-0000-0000-0000-0000007200c2']::uuid[]),
  ('00000000-0000-0000-0000-0000007200b1', '00000000-0000-0000-0000-0000007200a6', 'editor', 'full', null),
  ('00000000-0000-0000-0000-0000007200b2', '00000000-0000-0000-0000-0000007200a4', 'owner', 'full', null),
  ('00000000-0000-0000-0000-0000007200b3', '00000000-0000-0000-0000-0000007200a5', 'owner', 'full', null);
update public.profiles set current_business_id = '00000000-0000-0000-0000-0000007200b1'
 where id in ('00000000-0000-0000-0000-0000007200a1', '00000000-0000-0000-0000-0000007200a2', '00000000-0000-0000-0000-0000007200a3', '00000000-0000-0000-0000-0000007200a6');
update public.profiles set current_business_id = '00000000-0000-0000-0000-0000007200b2' where id = '00000000-0000-0000-0000-0000007200a4';
update public.profiles set current_business_id = '00000000-0000-0000-0000-0000007200b3' where id = '00000000-0000-0000-0000-0000007200a5';
insert into public.register_settings (user_id, business_id, business_type, vat_rate, dealer_number, legal_name, street, city, entity_type) values
  ('00000000-0000-0000-0000-0000007200a1', '00000000-0000-0000-0000-0000007200b1', 'licensed', 18, '000000059', 'עסק מורשה לדוגמה', 'הדוגמה', 'עיר דוגמה', 'licensed_dealer'),
  ('00000000-0000-0000-0000-0000007200a4', '00000000-0000-0000-0000-0000007200b2', 'exempt', 0, '000000083', 'עוסקת פטורה לדוגמה', 'הדוגמה', 'עיר דוגמה', 'exempt_dealer'),
  ('00000000-0000-0000-0000-0000007200a5', '00000000-0000-0000-0000-0000007200b3', 'licensed', 18, '000000091', 'עסק מאוחר לדוגמה', 'הדוגמה', 'עיר דוגמה', 'licensed_dealer');
insert into public.business_finance_profile (business_id, user_id, cash_drawers) values
  ('00000000-0000-0000-0000-0000007200b1', '00000000-0000-0000-0000-0000007200a1', true),
  ('00000000-0000-0000-0000-0000007200b3', '00000000-0000-0000-0000-0000007200a5', true);

-- every business's books start next month (the default): the rows below are written before any start
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007200a1');
-- a card receipt (to be matched at the bank), an expense paid in cash, a draft, the register's day short by 5, a bank file
select pg_temp.doc('00000000-0000-0000-0000-0000007200a1', 320, 100, 'b72:card1',
  '[{"method": 3, "m": "card", "amount": 118, "cardKind": 1}]'::jsonb);
select pg_temp.exp('00000000-0000-0000-0000-0000007200e1', '00000000-0000-0000-0000-0000007200a1', 'שכירות לדוגמה בע״מ', '000000067', 100, 18, 100, 'rent', 'cash');
select pg_temp.exp('00000000-0000-0000-0000-0000007200e2', '00000000-0000-0000-0000-0000007200a1', 'ספק לדוגמה', null, 100, 18, 50, 'communication', null, 'draft');
insert into public.register_shifts (id, user_id, opening_cash) values ('00000000-0000-0000-0000-0000007200f1', '00000000-0000-0000-0000-0000007200a1', 100);
update public.register_shifts set closed_at = now(), counted_cash = 95, expected_cash = 100, difference = -5 where id = '00000000-0000-0000-0000-0000007200f1';
insert into out72 select 'import', public.bank_import('00000000-0000-0000-0000-0000007200f9', '000-0000001', 'תנועות-לדוגמה.csv', jsonb_build_array(
  jsonb_build_object('date', public.il_today(), 'amount', 118, 'description', 'זיכוי כרטיסי אשראי'),
  jsonb_build_object('date', public.il_today(), 'amount', 236, 'description', 'העברה מלקוח'),
  jsonb_build_object('date', public.il_today(), 'amount', 118, 'description', 'הפקדה'),
  jsonb_build_object('date', public.il_today(), 'amount', -59, 'description', 'חיוב כרטיס העסק'),
  jsonb_build_object('date', public.il_today(), 'amount', 177, 'description', 'צ׳ק שנפרע'),
  jsonb_build_object('date', public.il_today(), 'amount', -30, 'description', 'עמלת ניהול חשבון', 'reference', '000777'),
  jsonb_build_object('date', public.il_today(), 'amount', 12.5, 'description', 'ריבית זכות'),
  jsonb_build_object('date', public.il_today() - 40, 'amount', -7, 'description', 'עמלה ישנה')));
select public.bank_match((select id from public.bank_lines where description = 'זיכוי כרטיסי אשראי' and business_id = '00000000-0000-0000-0000-0000007200b1'),
  array[(select p.id from public.payments p join public.documents d on d.id = p.document_id where d.idempotency_key = 'b72:card1')], null);
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007200a5');
select pg_temp.exp('00000000-0000-0000-0000-0000007200e9', '00000000-0000-0000-0000-0000007200a5', 'ספק מאוחר לדוגמה', null, 50, 9, 100, 'office', 'card');
insert into public.register_shifts (id, user_id, opening_cash) values ('00000000-0000-0000-0000-0000007200f5', '00000000-0000-0000-0000-0000007200a5', 0);
update public.register_shifts set closed_at = now(), counted_cash = 3, expected_cash = 0, difference = 3 where id = '00000000-0000-0000-0000-0000007200f5';
commit;
select pg_temp.check((select count(*) from public.gl_transactions where business_id::text like '00000000-0000-0000-0000-0000007200b%') = 0
  and (select count(*) from public.gl_unposted where business_id::text like '00000000-0000-0000-0000-0000007200b%') = 0,
  'before the start date nothing posts, and nothing is "unposted"');

-- ---- 1. the migration again over these rows, twice ----------------------------------------------------------------------------
create temp table before_7200 as select pg_temp.snapshot() as s;
\ir ../../supabase/migrations/20261129007200_books_more.sql
select pg_temp.check((select s from before_7200) = pg_temp.snapshot(), 'the migration over existing rows: every row stays as it was');
\ir ../../supabase/migrations/20261129007200_books_more.sql
select pg_temp.check((select s from before_7200) = pg_temp.snapshot(), 'the migration again: every row stays as it was');
select pg_temp.check((select count(*) from pg_trigger where tgname like 'zz_gl_post_more%') = 9
  and (select count(*) from pg_trigger where tgname in ('gl_accounts_guard', 'gl_bank_line_accounts_guard', 'gl_bank_line_accounts_no_delete')) = 3
  and (select count(*) from pg_policies where tablename = 'gl_bank_line_accounts') = 9,
  'each trigger and policy once after running twice');
select pg_temp.check(pg_get_constraintdef((select oid from pg_constraint where conname = 'gl_transactions_source_kind_check')) like '%''manual''%',
  'the wider source_kind check');
select pg_temp.check(not has_function_privilege('authenticated', 'public.gl_post_more(text, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.gl_post_safe(text, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.gl_write(uuid, text, uuid, text, date, public.gl_line_in[], text, uuid, uuid, uuid, text, int, text, int, text, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.gl_supplier_account(uuid, text, text)', 'execute')
  and not has_function_privilege('anon', 'public.gl_manual_create(uuid, date, text, jsonb, uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.gl_manual_create(uuid, date, text, jsonb, uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.report_trial_balance(date, date)', 'execute')
  and not has_function_privilege('anon', 'public.gl_reconcile(date, date)', 'execute')
  and has_function_privilege('authenticated', 'public.gl_expense_hash(public.expenses)', 'execute')
  and not has_table_privilege('authenticated', 'public.gl_bank_line_accounts', 'insert') and not has_table_privilege('service_role', 'public.gl_bank_line_accounts', 'update')
  and not has_table_privilege('anon', 'public.gl_bank_line_accounts', 'select'),
  'who may call what: posting only by the database, the new table read-only to the browser');

-- ---- 2. the owners move the start to this month: what is since then posts ------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007200a1');
insert into out72 select 'start L', public.gl_books_start_set(date_trunc('month', public.il_today())::date);
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007200a4');
select public.gl_books_start_set(date_trunc('month', public.il_today())::date);
commit;
-- pending in L: the receipt, the expense, its payment, the day's difference, the card match (the draft — nothing)
select pg_temp.check((pg_temp.o('start L')->>'pending')::int = 5, format('5 pending in L (got %s: %s)', pg_temp.o('start L')->>'pending',
  (select string_agg(source_kind, ',' order by ord) from public.gl_unposted where business_id = '00000000-0000-0000-0000-0000007200b1')));
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007200a1');
insert into out72 select 'replay L', public.gl_replay('00000000-0000-0000-0000-0000007200b1', null);
insert into out72 select 'replay L again', public.gl_replay('00000000-0000-0000-0000-0000007200b1', null);
commit;
select pg_temp.check((pg_temp.o('replay L')->>'posted')::int = 5 and (pg_temp.o('replay L')->>'left')::int = 0
  and (pg_temp.o('replay L again')->>'posted')::int = 0, 'gl_replay posts the five; again — nothing');
select pg_temp.check(pg_temp.lines((pg_temp.st('expense', '00000000-0000-0000-0000-0000007200e1')).id) = '6103 D 100.00, 1400 D 18.00, S000000067 C 118.00',
  'an expense: rent + VAT input / the supplier (by its dealer number)');
select pg_temp.check(pg_temp.lines((pg_temp.tx('expense_payment', pg_temp.pay_of('00000000-0000-0000-0000-0000007200e1'))).id) = 'S000000067 D 118.00, 1100 C 118.00',
  'its payment in cash: the supplier / the cash');
select pg_temp.check(pg_temp.lines((pg_temp.st('shift', '00000000-0000-0000-0000-0000007200f1')).id) = '6900 D 5.00, 1100 C 5.00', 'the day short by 5: 6900 / the cash');
select pg_temp.check(pg_temp.lines((select t.id from public.gl_transactions t where t.business_id = '00000000-0000-0000-0000-0000007200b1' and t.source_kind = 'bank_match')) = 'BANK D 118.00, 1250 C 118.00',
  'the card receipt matched at the bank: BANK / card clearing');
select pg_temp.check(pg_temp.bal('00000000-0000-0000-0000-0000007200b1', '1250') = 0, 'card clearing back to 0');
select pg_temp.check((select a.parent_key = '2100' and a.tb_code = 'SUPPLIERS' and a.dealer_number = '000000067' and a.kind = 'liability'
                        from public.gl_accounts a where a.business_id = '00000000-0000-0000-0000-0000007200b1' and a.key = 'S000000067'),
  'the supplier''s account: under 2100, its dealer number (1419)');
select pg_temp.check((select count(*) from public.gl_transactions where business_id = '00000000-0000-0000-0000-0000007200b3') = 0,
  'S keeps next month: nothing of it posts');

-- ---- 3. the posting matrix: expenses and their money -------------------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007200a1');
-- half the VAT deducted, paid by the business's card; an unknown category; transfer; cheque; other
select pg_temp.exp('00000000-0000-0000-0000-0000007200e3', '00000000-0000-0000-0000-0000007200a1', 'ספק לדוגמה', null, 100, 18, 50, 'communication', 'card');
select pg_temp.exp('00000000-0000-0000-0000-0000007200e4', '00000000-0000-0000-0000-0000007200a1', 'ספק לדוגמה', null, 40, 0, 100, 'zz_unknown', 'transfer', 'confirmed', 'receipt');
select pg_temp.exp('00000000-0000-0000-0000-0000007200e5', '00000000-0000-0000-0000-0000007200a1', 'ציוד לדוגמה', '000000075', 1000, 180, 100, 'equipment', 'cheque');
select pg_temp.exp('00000000-0000-0000-0000-0000007200e6', '00000000-0000-0000-0000-0000007200a1', 'ציוד לדוגמה', '000000075', 20, 0, 100, 'office', 'other', 'confirmed', 'receipt');
-- a supplier's credit note, its money back by transfer
select pg_temp.exp('00000000-0000-0000-0000-0000007200e7', '00000000-0000-0000-0000-0000007200a1', 'שכירות לדוגמה בע״מ', '000000067', 50, 9, 100, 'rent', 'transfer', 'confirmed', 'credit');
-- the draft of before: confirmed now (still unpaid)
update public.expenses set status = 'confirmed' where id = '00000000-0000-0000-0000-0000007200e2';
commit;
select pg_temp.check(pg_temp.lines((pg_temp.st('expense', '00000000-0000-0000-0000-0000007200e3')).id) = '6105 D 109.00, 1400 D 9.00, S-ספקלדוגמה C 118.00',
  'VAT deducted in part: the rest of it is the expense; the supplier by its normalized name');
select pg_temp.check(pg_temp.lines((pg_temp.tx('expense_payment', pg_temp.pay_of('00000000-0000-0000-0000-0000007200e3'))).id) = 'S-ספקלדוגמה D 118.00, 2300 C 118.00',
  'paid by the business''s card: 2300');
select pg_temp.check(pg_temp.lines((pg_temp.st('expense', '00000000-0000-0000-0000-0000007200e4')).id) = '6117 D 40.00, S-ספקלדוגמה C 40.00'
  and pg_temp.lines((pg_temp.tx('expense_payment', pg_temp.pay_of('00000000-0000-0000-0000-0000007200e4'))).id) = 'S-ספקלדוגמה D 40.00, BANK C 40.00',
  'an unknown category → 6117 "other"; no VAT; a transfer → BANK');
select pg_temp.check(pg_temp.lines((pg_temp.st('expense', '00000000-0000-0000-0000-0000007200e5')).id) = '6109 D 1000.00, 1400 D 180.00, S000000075 C 1180.00'
  and pg_temp.lines((pg_temp.tx('expense_payment', pg_temp.pay_of('00000000-0000-0000-0000-0000007200e5'))).id) = 'S000000075 D 1180.00, 2150 C 1180.00',
  'equipment (answer 12) is an expense; a cheque the business wrote → 2150 cheques to pay');
select pg_temp.check(pg_temp.lines((pg_temp.tx('expense_payment', pg_temp.pay_of('00000000-0000-0000-0000-0000007200e6'))).id) = 'S000000075 D 20.00, 9100 C 20.00',
  'paid "other" → suspense');
select pg_temp.check(pg_temp.lines((pg_temp.st('expense', '00000000-0000-0000-0000-0000007200e7')).id) = '6103 C 50.00, 1400 C 9.00, S000000067 D 59.00'
  and pg_temp.lines((pg_temp.tx('expense_payment', pg_temp.pay_of('00000000-0000-0000-0000-0000007200e7'))).id) = 'BANK D 59.00, S000000067 C 59.00',
  'a supplier''s credit note: the mirror; its money back: the bank / the supplier');
select pg_temp.check(pg_temp.lines((pg_temp.st('expense', '00000000-0000-0000-0000-0000007200e2')).id) = '6105 D 109.00, 1400 D 9.00, S-ספקלדוגמה C 118.00'
  and pg_temp.bal('00000000-0000-0000-0000-0000007200b1', 'S-ספקלדוגמה') = -118 and pg_temp.bal('00000000-0000-0000-0000-0000007200b1', 'S000000067') = 0,
  'a draft posts when confirmed (unpaid: the supplier is owed); a paid supplier at 0');
select pg_temp.check((select count(*) from public.gl_accounts where business_id = '00000000-0000-0000-0000-0000007200b1' and parent_key = '2100') = 3
  and (select count(*) from public.gl_accounts where business_id = '00000000-0000-0000-0000-0000007200b1' and key = '2150' and role = 'cheques_out') = 1,
  'one account per supplier (three suppliers); 2150 opened on first need');

-- a confirmed expense edited before it is paid: reversed (on its date) and posted again; a change of what it does not post — nothing
create temp table n_before as select pg_temp.n('00000000-0000-0000-0000-0000007200b1') as n;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007200a1');
update public.expenses set description = 'רק תיאור' where id = '00000000-0000-0000-0000-0000007200e2';
update public.expenses set supplier_name = 'ספק  לדוגמה!' where id = '00000000-0000-0000-0000-0000007200e2';   -- the same supplier (normalized)
commit;
select pg_temp.check(pg_temp.n('00000000-0000-0000-0000-0000007200b1') = (select n from n_before), 'a description or the same supplier''s name — no new entry');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007200a1');
update public.expenses set amount_before_vat = 200, vat_amount = 36, total = 236, vat_deductible_pct = 100 where id = '00000000-0000-0000-0000-0000007200e2';
commit;
select pg_temp.check(pg_temp.n('00000000-0000-0000-0000-0000007200b1') = (select n from n_before) + 2
  and pg_temp.lines((pg_temp.st('expense', '00000000-0000-0000-0000-0000007200e2')).id) = '6105 D 200.00, 1400 D 36.00, S-ספקלדוגמה C 236.00'
  and (select count(*) from public.gl_transactions t where t.source_kind = 'expense' and t.source_id = '00000000-0000-0000-0000-0000007200e2' and t.reverses is not null) = 1
  and pg_temp.bal('00000000-0000-0000-0000-0000007200b1', 'S-ספקלדוגמה') = -236
  and not exists (select 1 from public.gl_unposted where source_id = '00000000-0000-0000-0000-0000007200e2'),
  'edited amounts: the old entry reversed, the new one posted (and the supplier owed the new total)');
-- a void of a paid expense: the expense and its payment reversed — the supplier, the cheques to pay and the expense back to 0
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007200a1');
update public.expenses set status = 'void', void_reason = 'נרשמה בטעות' where id = '00000000-0000-0000-0000-0000007200e5';
commit;
select pg_temp.check(pg_temp.st('expense', '00000000-0000-0000-0000-0000007200e5') is null or (pg_temp.st('expense', '00000000-0000-0000-0000-0000007200e5')).id is null,
  'a void: no entry of the expense stands');
select pg_temp.check(pg_temp.bal('00000000-0000-0000-0000-0000007200b1', 'S000000075') = 0 and pg_temp.bal('00000000-0000-0000-0000-0000007200b1', '2150') = 0
  and pg_temp.bal('00000000-0000-0000-0000-0000007200b1', '6109') = 0
  and (pg_temp.tx('expense_payment', pg_temp.pay_of('00000000-0000-0000-0000-0000007200e5', 'reversal'))).reverses
      = (pg_temp.tx('expense_payment', pg_temp.pay_of('00000000-0000-0000-0000-0000007200e5'))).id
  and (pg_temp.tx('expense_payment', pg_temp.pay_of('00000000-0000-0000-0000-0000007200e5', 'reversal'))).source_id = pg_temp.pay_of('00000000-0000-0000-0000-0000007200e5', 'reversal'),
  'a void: the expense and its payment reversed (the payment''s reversal points at it), the accounts back to 0');
-- the exempt dealer deducts no VAT: the whole of it is the expense
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007200a4');
select pg_temp.exp('00000000-0000-0000-0000-0000007200ea', '00000000-0000-0000-0000-0000007200a4', 'ספק לדוגמה', null, 100, 18, 100, 'materials', 'cash');
commit;
select pg_temp.check(pg_temp.lines((pg_temp.st('expense', '00000000-0000-0000-0000-0000007200ea')).id) = '6102 D 118.00, S-ספקלדוגמה C 118.00',
  'an exempt dealer: no VAT input — the total is the expense');
-- S (next month): nothing of its rows is pending or posted
select pg_temp.check(not exists (select 1 from public.gl_unposted where business_id = '00000000-0000-0000-0000-0000007200b3'), 'S: nothing pending');

-- ---- the register's day --------------------------------------------------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007200a1');
insert into public.register_shifts (id, user_id, opening_cash, register_id) values ('00000000-0000-0000-0000-0000007200f3', '00000000-0000-0000-0000-0000007200a1', 0, '00000000-0000-0000-0000-0000007200d2');
commit;
select pg_temp.check(pg_temp.st('shift', '00000000-0000-0000-0000-0000007200f3') is null or (pg_temp.st('shift', '00000000-0000-0000-0000-0000007200f3')).id is null,
  'an open day posts nothing');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007200a1');
update public.register_shifts set closed_at = now(), counted_cash = 3, expected_cash = 0, difference = 3 where id = '00000000-0000-0000-0000-0000007200f3';
commit;
select pg_temp.check(pg_temp.lines((pg_temp.st('shift', '00000000-0000-0000-0000-0000007200f3')).id) = '1100-1 D 3.00, 6900 C 3.00'
  and (pg_temp.st('shift', '00000000-0000-0000-0000-0000007200f3')).location_id = '00000000-0000-0000-0000-0000007200c2',
  'over by 3 in L2: L2''s cash / 6900, the entry of L2');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007200a1');
update public.register_shifts set note = 'הערה' where id = '00000000-0000-0000-0000-0000007200f3';
update public.register_shifts set counted_cash = 2, difference = 2 where id = '00000000-0000-0000-0000-0000007200f3';
commit;
select pg_temp.check(pg_temp.lines((pg_temp.st('shift', '00000000-0000-0000-0000-0000007200f3')).id) = '1100-1 D 2.00, 6900 C 2.00'
  and pg_temp.bal('00000000-0000-0000-0000-0000007200b1', '6900') = 5 - 2,
  'a closed day changed: reversed and posted again (6900: short 5, over 2)');

-- ---- the bank ------------------------------------------------------------------------------------------------------------------
create or replace function pg_temp.line(p_desc text) returns uuid language sql as $$
  select id from public.bank_lines where business_id = '00000000-0000-0000-0000-0000007200b1' and description = p_desc $$;
create or replace function pg_temp.dpay(p_key text) returns uuid language sql as $$
  select p.id from public.payments p join public.documents d on d.id = p.document_id where d.idempotency_key = p_key $$;
create or replace function pg_temp.mtx(p_desc text) returns public.gl_transactions language sql as $$
  select t.* from public.gl_transactions t join public.bank_matches m on m.id = t.source_id
   where t.source_kind = 'bank_match' and m.bank_line_id = pg_temp.line(p_desc) order by t.number desc limit 1 $$;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007200a1');
select pg_temp.doc('00000000-0000-0000-0000-0000007200a1', 320, 200, 'b72:transfer', '[{"method": 4, "m": "transfer", "amount": 236}]'::jsonb);
select pg_temp.doc('00000000-0000-0000-0000-0000007200a1', 320, 100, 'b72:cash1');
select pg_temp.doc('00000000-0000-0000-0000-0000007200a1', 320, 100, 'b72:cash2');
select pg_temp.doc('00000000-0000-0000-0000-0000007200a1', 320, 150, 'b72:cheque', jsonb_build_array(jsonb_build_object('method', 2, 'm', 'cheque', 'amount', 177,
  'cheque', jsonb_build_object('number', '7201', 'bank', '12', 'branch', '600', 'account', '000000001', 'dueDate', public.il_today()::text))));
select pg_temp.exp('00000000-0000-0000-0000-0000007200e8', '00000000-0000-0000-0000-0000007200a1', 'ספק לדוגמה', null, 50, 9, 100, 'software', 'card');
insert into out72 select 'deposit', public.bank_deposit_create('00000000-0000-0000-0000-0000007200f6', public.il_today(), '00000000-0000-0000-0000-0000007200b1', 118, '{}', '');
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007200a1');
select public.bank_match(pg_temp.line('העברה מלקוח'), array[pg_temp.dpay('b72:transfer')], null);
select public.bank_match(pg_temp.line('הפקדה'), null, array['00000000-0000-0000-0000-0000007200f6'::uuid]);
select public.bank_match(pg_temp.line('חיוב כרטיס העסק'), array[pg_temp.pay_of('00000000-0000-0000-0000-0000007200e8')], null);
select public.bank_match(pg_temp.line('צ׳ק שנפרע'), array[pg_temp.dpay('b72:cheque')], null);
commit;
select pg_temp.check(pg_temp.mtx('העברה מלקוח') is null or (pg_temp.mtx('העברה מלקוח')).id is null, 'a transfer matched: in BANK already — nothing posts twice');
select pg_temp.check(not exists (select 1 from public.gl_transactions t where t.source_kind = 'bank_match' and t.source_id in
                       (select m.id from public.bank_matches m where m.bank_line_id = pg_temp.line('הפקדה'))), 'a deposit matched: in BANK already');
select pg_temp.check(pg_temp.lines((pg_temp.mtx('חיוב כרטיס העסק')).id) = '2300 D 59.00, BANK C 59.00', 'the business''s card paid from the bank: 2300 / BANK');
select pg_temp.check(pg_temp.lines((pg_temp.mtx('צ׳ק שנפרע')).id) = 'BANK D 177.00, 1150 C 177.00'
  and pg_temp.bal('00000000-0000-0000-0000-0000007200b1', '1150') = 0
  and (select l.match1 from public.gl_lines l where l.transaction_id = (pg_temp.mtx('צ׳ק שנפרע')).id and l.side = 'C') = '7201',
  'a cheque cleared directly: BANK / the cheques (matched by its number)');
-- unmatching reverses; matching again posts again
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007200a1');
select public.bank_unmatch(pg_temp.line('זיכוי כרטיסי אשראי'), 'לא השורה הנכונה');
commit;
select pg_temp.check(pg_temp.bal('00000000-0000-0000-0000-0000007200b1', '1250') = 118
  and (select t.reverses from public.gl_transactions t where t.source_kind = 'bank_unmatch') is not null, 'unmatched: the card money back in 1250 (a reversing entry)');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007200a1');
select public.bank_match(pg_temp.line('זיכוי כרטיסי אשראי'), array[pg_temp.dpay('b72:card1')], null);
commit;
select pg_temp.check(pg_temp.bal('00000000-0000-0000-0000-0000007200b1', '1250') = 0
  and (select count(*) from public.gl_transactions t where t.business_id = '00000000-0000-0000-0000-0000007200b1' and t.source_kind = 'bank_match') = 4,
  'matched again: posted again');
-- answer 17: a line of the books' time handled without a document needs an account; the owner only; not BANK itself
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007200a1');
select pg_temp.refused_with($$select public.bank_line_handle(pg_temp.line('עמלת ניהול חשבון'), 'עמלה')$$, 'bank_line_account_required',
  'handled with a note only — refused from the start');
select pg_temp.refused_with($$select public.bank_line_classify(pg_temp.line('עמלת ניהול חשבון'), 'BANK', 'עמלה')$$, 'bank_class_account', 'not to BANK itself');
select pg_temp.refused_with($$select public.bank_line_classify(pg_temp.line('עמלת ניהול חשבון'), '7777', 'עמלה')$$, 'bank_class_account', 'an account of the chart');
select public.bank_line_handle(pg_temp.line('עמלה ישנה'), 'עמלה מלפני הספרים');
select pg_temp.as_user('00000000-0000-0000-0000-0000007200a6');
select pg_temp.refused_with($$select public.bank_line_classify(pg_temp.line('עמלת ניהול חשבון'), '6112', 'עמלה')$$, 'books_not_allowed', 'an editor does not post a line');
select pg_temp.as_user('00000000-0000-0000-0000-0000007200a1');
insert into out72 select 'classify', public.bank_line_classify(pg_temp.line('עמלת ניהול חשבון'), '6112', 'עמלת ניהול חשבון');
commit;
create or replace function pg_temp.ctx(p_desc text) returns public.gl_transactions language sql as $$
  select t.* from public.gl_transactions t join public.gl_bank_line_accounts c on c.id = t.source_id
   where t.source_kind = 'bank_class' and c.bank_line_id = pg_temp.line(p_desc) order by t.number desc limit 1 $$;
select pg_temp.check(pg_temp.lines((pg_temp.ctx('עמלת ניהול חשבון')).id) = '6112 D 30.00, BANK C 30.00' and (pg_temp.o('classify')->>'posts')::boolean
  and (pg_temp.ctx('עמלת ניהול חשבון')).ref1_number = '000777'
  and (select status from public.bank_lines where id = pg_temp.line('עמלת ניהול חשבון')) = 'handled'
  and (select status from public.bank_lines where id = pg_temp.line('עמלה ישנה')) = 'handled'
  and not exists (select 1 from public.gl_transactions t where t.details like '%עמלה ישנה%'),
  'money out to 6112: the account / BANK (its reference); a line of before the start — a note, no entry');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007200a6');
select pg_temp.refused_with($$select public.bank_line_reopen(pg_temp.line('עמלת ניהול חשבון'))$$, 'not allowed', 'an editor does not open a posted line again');
select public.bank_line_reopen(pg_temp.line('עמלה ישנה'));
select pg_temp.as_user('00000000-0000-0000-0000-0000007200a1');
select public.bank_line_reopen(pg_temp.line('עמלת ניהול חשבון'));
commit;
select pg_temp.check(pg_temp.bal('00000000-0000-0000-0000-0000007200b1', '6112') = 0
  and (select status from public.bank_lines where id = pg_temp.line('עמלת ניהול חשבון')) = 'open'
  and not exists (select 1 from public.gl_bank_line_accounts c where c.bank_line_id = pg_temp.line('עמלת ניהול חשבון') and c.active),
  'opened again by the owner: reversed, the line open (a note-only line — any writer, as before)');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007200a1');
select public.bank_line_classify(pg_temp.line('עמלת ניהול חשבון'), '6112', 'עמלת ניהול חשבון');
commit;
select pg_temp.check(pg_temp.bal('00000000-0000-0000-0000-0000007200b1', '6112') = 30
  and (select count(*) from public.gl_bank_line_accounts c where c.bank_line_id = pg_temp.line('עמלת ניהול חשבון')) = 2, 'posted again (the first kept, undone)');
select pg_temp.refused_with($$update public.gl_bank_line_accounts set note = 'x' where active$$, 'append_only', 'a bank line''s account is not edited');
select pg_temp.refused_with($$delete from public.gl_bank_line_accounts$$, 'append', 'nor removed');

-- ---- 4. never blocks: a posting that fails — the expense is saved, the failure listed, posted again later ----------------------
alter table public.gl_accounts add constraint tmp_block_72 check (key <> 'S-חדשלדוגמה') not valid;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007200a1');
select pg_temp.exp('00000000-0000-0000-0000-0000007200eb', '00000000-0000-0000-0000-0000007200a1', 'חדש לדוגמה', null, 10, 0, 100, 'office', null, 'confirmed', 'receipt');
commit;
select pg_temp.check(exists (select 1 from public.expenses where id = '00000000-0000-0000-0000-0000007200eb')
  and (select error from public.gl_unposted where source_id = '00000000-0000-0000-0000-0000007200eb') like '%tmp_block_72%',
  'the expense is saved; its posting failed, recorded and listed');
alter table public.gl_accounts drop constraint tmp_block_72;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007200a1');
insert into out72 select 'replay fail', public.gl_replay('00000000-0000-0000-0000-0000007200b1', null, 200, true);
commit;
select pg_temp.check((pg_temp.o('replay fail')->>'posted')::int = 1 and (pg_temp.o('replay fail')->>'left')::int = 0
  and pg_temp.lines((pg_temp.st('expense', '00000000-0000-0000-0000-0000007200eb')).id) = '6110 D 10.00, S-חדשלדוגמה C 10.00',
  'gl_replay posts it');

-- ---- 5. the manual double entry (answer 15) -----------------------------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007200a1');
insert into out72 select 'm1', public.gl_manual_create('00000000-0000-0000-0000-000000720101', public.il_today(), 'הכנסת בעלים לבנק',
  '[{"account": "BANK", "side": "D", "amount": 1000}, {"account": "3200", "side": "C", "amount": 600}, {"account": "3200", "side": "C", "amount": 400, "match": "M1"}]');
insert into out72 select 'm1 again', public.gl_manual_create('00000000-0000-0000-0000-000000720101', public.il_today(), 'אחר', '[]');
select pg_temp.refused_with($$select public.gl_manual_create(gen_random_uuid(), public.il_today(), 'לא מאוזנת',
  '[{"account": "BANK", "side": "D", "amount": 100}, {"account": "3200", "side": "C", "amount": 99.99}]')$$, 'manual_unbalanced', 'never unbalanced');
select pg_temp.refused_with($$select public.gl_manual_create(gen_random_uuid(), public.il_today(), 'שורה אחת', '[{"account": "BANK", "side": "D", "amount": 100}]')$$,
  'manual_lines', 'two lines at least');
select pg_temp.refused_with($$select public.gl_manual_create(gen_random_uuid(), public.il_today(), 'חשבון לא קיים',
  '[{"account": "BANK", "side": "D", "amount": 100}, {"account": "7777", "side": "C", "amount": 100}]')$$, 'manual_account', 'an account of the chart');
select pg_temp.refused_with($$select public.gl_manual_create(gen_random_uuid(), public.il_today(), 'אפס',
  '[{"account": "BANK", "side": "D", "amount": 0}, {"account": "3200", "side": "C", "amount": 0}]')$$, 'manual_line', 'an amount above 0');
select pg_temp.refused_with($$select public.gl_manual_create(gen_random_uuid(), public.il_today(), 'אגורות',
  '[{"account": "BANK", "side": "D", "amount": 1.005}, {"account": "3200", "side": "C", "amount": 1.005}]')$$, 'manual_line', 'to the agora');
select pg_temp.refused_with($$select public.gl_manual_create(gen_random_uuid(), date_trunc('month', public.il_today())::date - 1, 'לפני ההתחלה',
  '[{"account": "BANK", "side": "D", "amount": 1}, {"account": "3200", "side": "C", "amount": 1}]')$$, 'manual_before_start', 'not before the books'' start');
select pg_temp.refused_with($$select public.gl_manual_create(gen_random_uuid(), public.il_today() + 1, 'מחר',
  '[{"account": "BANK", "side": "D", "amount": 1}, {"account": "3200", "side": "C", "amount": 1}]')$$, 'manual_date', 'not ahead of today');
select pg_temp.refused_with($$select public.gl_manual_create(gen_random_uuid(), public.il_today(), 'x',
  '[{"account": "BANK", "side": "D", "amount": 1}, {"account": "3200", "side": "C", "amount": 1}]')$$, 'manual_details', 'details of 2 letters at least');
select pg_temp.as_user('00000000-0000-0000-0000-0000007200a6');
select pg_temp.refused_with($$select public.gl_manual_create(gen_random_uuid(), public.il_today(), 'עורך',
  '[{"account": "BANK", "side": "D", "amount": 1}, {"account": "3200", "side": "C", "amount": 1}]')$$, 'books_not_allowed', 'the owner only');
select pg_temp.as_user('00000000-0000-0000-0000-0000007200a2');
select pg_temp.refused_with($$select public.gl_manual_create(gen_random_uuid(), public.il_today(), 'קופאית',
  '[{"account": "BANK", "side": "D", "amount": 1}, {"account": "3200", "side": "C", "amount": 1}]')$$, 'not allowed', 'never a cashier');
commit;
select pg_temp.check((pg_temp.o('m1')->>'created')::boolean and not (pg_temp.o('m1 again')->>'created')::boolean
  and (pg_temp.o('m1')->>'number')::int = (pg_temp.o('m1 again')->>'number')::int
  and pg_temp.lines('00000000-0000-0000-0000-000000720101') = 'BANK D 1000.00, 3200 C 600.00, 3200 C 400.00'
  and (select l.match1 from public.gl_lines l where l.transaction_id = '00000000-0000-0000-0000-000000720101' and l.line_no = 3) = 'M1'
  and (select source_kind = 'manual' and details = 'הכנסת בעלים לבנק' from public.gl_transactions where id = '00000000-0000-0000-0000-000000720101'),
  'a balanced manual entry, its lines as given; the same id again — the same entry');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007200a1');
insert into out72 select 'm2', public.gl_manual_reverse('00000000-0000-0000-0000-000000720102', '00000000-0000-0000-0000-000000720101');
select pg_temp.refused_with($$select public.gl_manual_reverse(gen_random_uuid(), '00000000-0000-0000-0000-000000720101')$$, 'manual_reversed', 'once');
select pg_temp.refused_with($$select public.gl_manual_reverse(gen_random_uuid(), '00000000-0000-0000-0000-000000720102')$$, 'manual_reverse', 'a reversal is not reversed');
select pg_temp.refused_with(format('select public.gl_manual_reverse(gen_random_uuid(), %L)', (select t.id from public.gl_transactions t where t.source_kind = 'expense' and t.source_id = '00000000-0000-0000-0000-0000007200e1' limit 1)),
  'manual_entry', 'an automatic entry is corrected at its source');
commit;
select pg_temp.check(pg_temp.lines('00000000-0000-0000-0000-000000720102') = 'BANK C 1000.00, 3200 D 600.00, 3200 D 400.00'
  and (select reverses from public.gl_transactions where id = '00000000-0000-0000-0000-000000720102') = '00000000-0000-0000-0000-000000720101'
  and pg_temp.bal('00000000-0000-0000-0000-0000007200b1', '3200') = 0, 'the reversing entry: every line on the other side');
-- answer 15: the one-sided journal — read-only from the start (before it, as before). journal.check.sql expects no journal entry
-- in the database: every entry here is rolled back
begin;
insert into public.journal_entries (id, business_id, location_id, number, entry_date, kind, amount, vat, explanation)
values ('00000000-0000-0000-0000-0000007200f2', '00000000-0000-0000-0000-0000007200b1', '00000000-0000-0000-0000-0000007200b1', 1,
        date_trunc('month', public.il_today())::date - 1, 'other', 10, 0, 'פקודה ישנה לדוגמה');
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007200a1');
select pg_temp.refused_with($$select public.journal_entry_create(gen_random_uuid(), public.il_today(), 'other', 5, 0, null, null, 'פקודה חד צדדית')$$,
  'journal_books_started', 'a one-sided entry from the start — refused');
select pg_temp.refused_with($$select public.journal_entry_reverse(gen_random_uuid(), '00000000-0000-0000-0000-0000007200f2', public.il_today(), 'ביטול')$$,
  'journal_books_started', 'nor a reversal dated from the start');
select pg_temp.check((public.journal_entry_reverse(gen_random_uuid(), '00000000-0000-0000-0000-0000007200f2', date_trunc('month', public.il_today())::date - 1, 'ביטול')->>'created')::boolean,
  'an old entry reversed before the start — as before');
select pg_temp.as_user('00000000-0000-0000-0000-0000007200a5');
select pg_temp.check((public.journal_entry_create(gen_random_uuid(), public.il_today(), 'other', 5, 0, null, null, 'לפני הספרים')->>'created')::boolean,
  'a business whose books have not started — as before');
rollback;

-- ---- the chart (the owner) ----------------------------------------------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007200a1');
select public.gl_account_add('4300', 'הכנסות ריבית', 'income', '4000', 'הכנסות');
select public.gl_account_add('6118', 'הוצאה חדשה', 'expense');
select pg_temp.refused_with($$select public.gl_account_add('ABC', 'x', 'asset')$$, 'account_key', 'a key of four digits');
select pg_temp.refused_with($$select public.gl_account_add('050-0000072', 'x', 'asset')$$, 'account_key', 'never a customer''s key');
select pg_temp.refused_with($$select public.gl_account_add('4300', 'x', 'income')$$, 'account_exists', 'a key once');
select pg_temp.refused_with($$select public.gl_account_add('4301', 'x', 'income', null, null, '9999')$$, 'account_parent', 'a parent that exists');
select pg_temp.refused_with($$select public.gl_account_add('4302', 'x', 'other')$$, 'account_kind', 'a kind');
select public.bank_line_classify(pg_temp.line('ריבית זכות'), '4300', 'ריבית');
select public.gl_account_update('4300', 'ריבית מהבנק', null, 'הכנסות אחרות');
select public.gl_account_update('6118', null, null, null, '6119');
select pg_temp.refused_with($$select public.gl_account_update('1100', null, null, null, '1199')$$, 'account_key_fixed', 'a system account keeps its key');
select pg_temp.refused_with($$select public.gl_account_set_active('1100', false)$$, 'account_system', 'a system account is never removed');
select public.gl_account_set_active('6119', false);
select pg_temp.as_user('00000000-0000-0000-0000-0000007200a6');
select pg_temp.refused_with($$select public.gl_account_add('6120', 'x', 'expense')$$, 'books_not_allowed', 'the owner only');
commit;
select pg_temp.check(pg_temp.lines((pg_temp.ctx('ריבית זכות')).id) = 'BANK D 12.50, 4300 C 12.50', 'money in to an account: BANK / the account');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007200a1');
select pg_temp.refused_with($$select public.gl_account_update('4300', null, null, null, '4399')$$, 'account_key_fixed', 'a key is fixed from the first movement');
select pg_temp.refused_with($$select public.gl_account_set_active('4300', false)$$, 'account_balance', 'an account with a balance stays');
select pg_temp.refused_with($$select public.gl_manual_create(gen_random_uuid(), public.il_today(), 'לחשבון לא פעיל',
  '[{"account": "6119", "side": "D", "amount": 1}, {"account": "BANK", "side": "C", "amount": 1}]')$$, 'manual_account', 'no entry to an inactive account');
select public.gl_account_set_active('6119', true);
commit;
select pg_temp.check((select name = 'ריבית מהבנק' and tb_name = 'הכנסות אחרות' and tb_code = '4000' from public.gl_accounts where business_id = '00000000-0000-0000-0000-0000007200b1' and key = '4300')
  and exists (select 1 from public.gl_accounts where business_id = '00000000-0000-0000-0000-0000007200b1' and key = '6119' and active and role is null)
  and not exists (select 1 from public.gl_accounts where business_id = '00000000-0000-0000-0000-0000007200b1' and key = '6118'),
  'renamed, a new trial-balance name; a key changed before a movement; deactivated and activated again');
select pg_temp.refused_with($$update public.gl_accounts set key = '4398' where business_id = '00000000-0000-0000-0000-0000007200b1' and key = '4300'$$,
  'account_key_fixed', 'the key of an account with movements — not even directly');
select pg_temp.refused_with($$update public.gl_accounts set role = 'bank' where business_id = '00000000-0000-0000-0000-0000007200b1' and key = '6119'$$,
  'account_fixed', 'nor its role');
select pg_temp.check((select count(*) from public.finance_audit_log where business_id = '00000000-0000-0000-0000-0000007200b1' and action like 'books.account%') = 6
  and (select count(*) from public.finance_audit_log where business_id = '00000000-0000-0000-0000-0000007200b1' and action in ('books.manual', 'books.manual_reversed')) = 2
  and (select count(*) from public.finance_audit_log where business_id = '00000000-0000-0000-0000-0000007200b1' and action = 'bank.classified') = 3,
  'every change of the chart, every manual entry and every bank line posted — in the audit log');

-- ---- the reports (answer 16) and gl_reconcile ----------------------------------------------------------------------------------
-- an invoice still open (the receivables), and half of it paid
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007200a1');
select pg_temp.doc('00000000-0000-0000-0000-0000007200a1', 305, 100, 'b72:305');
select pg_temp.doc('00000000-0000-0000-0000-0000007200a1', 400, 59, 'b72:400', null,
  jsonb_build_object('paid_document_id', (select id from public.documents where idempotency_key = 'b72:305')));
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007200a1');
insert into out72 select 'tb', public.report_trial_balance(date_trunc('month', public.il_today())::date, public.il_today());
insert into out72 select 'tb later', public.report_trial_balance(public.il_today() + 1, public.il_today() + 1);
insert into out72 select 'ledger cash', public.report_ledger('1100', date_trunc('month', public.il_today())::date, public.il_today());
insert into out72 select 'ledger suppliers', public.report_ledger('2100', date_trunc('month', public.il_today())::date, public.il_today());
insert into out72 select 'journal', public.report_journal(date_trunc('month', public.il_today())::date, public.il_today());
insert into out72 select 'pl', public.report_profit_loss(date_trunc('month', public.il_today())::date, public.il_today());
insert into out72 select 'bs', public.report_balance_sheet(public.il_today());
insert into out72 select 'reconcile', public.gl_reconcile(date_trunc('month', public.il_today())::date - 40, public.il_today());
select pg_temp.refused_with($$select public.report_ledger('7777', public.il_today(), public.il_today())$$, 'ledger_account', 'a ledger of an account of the chart');
select pg_temp.as_user('00000000-0000-0000-0000-0000007200a2');
select pg_temp.refused_with($$select public.report_trial_balance(public.il_today(), public.il_today())$$, 'not allowed', 'a cashier — no report');
select pg_temp.refused_with($$select public.gl_reconcile(public.il_today(), public.il_today())$$, 'not allowed', 'nor the reconciliation');
select pg_temp.as_user('00000000-0000-0000-0000-0000007200a3');
insert into out72 select 'tb L2', public.report_trial_balance(date_trunc('month', public.il_today())::date, public.il_today());
select pg_temp.as_user('00000000-0000-0000-0000-0000007200a5');
insert into out72 select 'tb S', public.report_trial_balance(date_trunc('month', public.il_today())::date, public.il_today());
commit;
select pg_temp.check((pg_temp.o('tb')->'total'->>'debit')::numeric = (pg_temp.o('tb')->'total'->>'credit')::numeric
  and (pg_temp.o('tb')->'total'->>'debit')::numeric > 0
  and (pg_temp.o('tb')->'total'->>'opening')::numeric = 0 and (pg_temp.o('tb')->'total'->>'closing')::numeric = 0
  and (pg_temp.o('tb')->'total'->>'debit')::numeric = (select sum(l.amount) from public.gl_lines l where l.business_id = '00000000-0000-0000-0000-0000007200b1' and l.side = 'D')
  and not exists (select 1 from jsonb_array_elements(pg_temp.o('tb')->'accounts') a where (a->>'closing')::numeric <> pg_temp.bal('00000000-0000-0000-0000-0000007200b1', a->>'key'))
  and jsonb_array_length(pg_temp.o('tb')->'accounts') = (select count(distinct l.account_id) from public.gl_lines l where l.business_id = '00000000-0000-0000-0000-0000007200b1')
  and (select sum((g->>'closing')::numeric) from jsonb_array_elements(pg_temp.o('tb')->'groups') g) = 0
  and exists (select 1 from jsonb_array_elements(pg_temp.o('tb')->'groups') g where g->>'tbCode' = 'SUPPLIERS' and (g->>'accounts')::int = 4),
  'the trial balance: debit = credit, closing sums to 0, every account''s balance, by trial-balance code');
select pg_temp.check((pg_temp.o('tb later')->'total'->>'debit')::numeric = 0
  and not exists (select 1 from jsonb_array_elements(pg_temp.o('tb later')->'accounts') a where (a->>'opening')::numeric <> (a->>'closing')::numeric),
  'a later period: everything is in the opening balance');
select pg_temp.check((pg_temp.o('ledger cash')->>'closing')::numeric = pg_temp.bal('00000000-0000-0000-0000-0000007200b1', '1100')
  and (pg_temp.o('ledger cash')->'lines'->-1->>'balance')::numeric = (pg_temp.o('ledger cash')->>'closing')::numeric
  and (pg_temp.o('ledger suppliers')->>'closing')::numeric = (select sum(pg_temp.bal('00000000-0000-0000-0000-0000007200b1', a.key)) from public.gl_accounts a
                                                               where a.business_id = '00000000-0000-0000-0000-0000007200b1' and (a.key = '2100' or a.parent_key = '2100'))
  and exists (select 1 from jsonb_array_elements(pg_temp.o('ledger suppliers')->'lines') x where x->>'account' = 'S000000067' and x->>'ref2Number' is not null),
  'the ledger: the running balance ends at the balance; 2100 — every supplier, with the references');
select pg_temp.check((pg_temp.o('journal')->>'count')::int = pg_temp.n('00000000-0000-0000-0000-0000007200b1')
  and (pg_temp.o('journal')->>'debit')::numeric = (pg_temp.o('tb')->'total'->>'debit')::numeric
  and (select bool_and((e->>'number')::int > 0 and jsonb_array_length(e->'lines') >= 2) from jsonb_array_elements(pg_temp.o('journal')->'entries') e)
  and exists (select 1 from jsonb_array_elements(pg_temp.o('journal')->'entries') e where e->>'id' = '00000000-0000-0000-0000-000000720101'
                and e->>'reversedBy' = '00000000-0000-0000-0000-000000720102'),
  'the journal: every entry with its lines; a reversed one says by what');
select pg_temp.check((pg_temp.o('pl')->>'profit')::numeric = (pg_temp.o('pl')->'income'->>'total')::numeric - (pg_temp.o('pl')->'expenses'->>'total')::numeric
  and (pg_temp.o('pl')->'income'->>'total')::numeric = (select -sum(case l.side when 'D' then l.amount else -l.amount end) from public.gl_lines l
                                                          join public.gl_accounts a on a.id = l.account_id where a.business_id = '00000000-0000-0000-0000-0000007200b1' and a.kind = 'income')
  and exists (select 1 from jsonb_array_elements(pg_temp.o('pl')->'expenses'->'accounts') x where x->>'key' = '6900' and (x->>'amount')::numeric = 3),
  'profit and loss: income − expenses, from the books');
select pg_temp.check((pg_temp.o('bs')->>'balanced')::boolean
  and (pg_temp.o('bs')->>'earnings')::numeric = (pg_temp.o('pl')->>'profit')::numeric
  and exists (select 1 from jsonb_array_elements(pg_temp.o('bs')->'liabilities'->'accounts') x where x->>'key' = '2100'
                and (x->>'amount')::numeric = -(pg_temp.o('ledger suppliers')->>'closing')::numeric),
  'the balance sheet: assets = liabilities + equity + the profit; the suppliers in 2100');
select pg_temp.check((pg_temp.o('reconcile')->>'same')::boolean and pg_temp.o('reconcile')->>'from' = date_trunc('month', public.il_today())::date::text
  and (pg_temp.row(pg_temp.o('reconcile'), 'income')->>'books')::numeric > 0
  and (pg_temp.row(pg_temp.o('reconcile'), 'receivables')->>'books')::numeric = 59
  and (pg_temp.row(pg_temp.o('reconcile'), 'expenses')->>'explained')::numeric = 3 + 30
  and (pg_temp.row(pg_temp.o('reconcile'), 'cash_differences')->>'source')::numeric = 3
  and (pg_temp.row(pg_temp.o('reconcile'), 'vat_input')->>'books')::numeric = (pg_temp.row(pg_temp.o('reconcile'), 'vat_input')->>'source')::numeric,
  format('gl_reconcile: the books = the existing reports, every row (%s)', pg_temp.o('reconcile')->'rows'));
select pg_temp.check((pg_temp.o('tb L2')->'total'->>'debit')::numeric = (pg_temp.o('tb L2')->'total'->>'credit')::numeric
  and (select count(*) from jsonb_array_elements(pg_temp.o('tb L2')->'accounts')) = 2
  and exists (select 1 from jsonb_array_elements(pg_temp.o('tb L2')->'accounts') a where a->>'key' = '1100-1' and (a->>'closing')::numeric = 2),
  'a member limited to L2: the books of L2 only (its day''s difference), balanced');
select pg_temp.check(jsonb_array_length(pg_temp.o('tb S')->'accounts') = 0, 'another business: nothing of L');

-- the RLS of the new table; every entry balanced, numbered 1..n; nothing left unposted
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007200a1');
insert into out72 select 'rls owner', to_jsonb((select count(*) from public.gl_bank_line_accounts));
select pg_temp.as_user('00000000-0000-0000-0000-0000007200a2');
insert into out72 select 'rls cashier', to_jsonb((select count(*) from public.gl_bank_line_accounts));
select pg_temp.as_user('00000000-0000-0000-0000-0000007200a3');
insert into out72 select 'rls branch', to_jsonb((select count(*) from public.gl_bank_line_accounts));
select pg_temp.as_user('00000000-0000-0000-0000-0000007200a5');
insert into out72 select 'rls other', to_jsonb((select count(*) from public.gl_bank_line_accounts));
insert into out72 select 'unposted other', to_jsonb((select count(*) from public.gl_unposted));
commit;
select pg_temp.check(pg_temp.o('rls owner')::int = 3 and pg_temp.o('rls cashier')::int = 0 and pg_temp.o('rls branch')::int = 0 and pg_temp.o('rls other')::int = 0
  and pg_temp.o('unposted other')::int = 0,
  'a bank line''s account: the owner sees it; a cashier, a location-limited member, another business — not');
select pg_temp.check(not exists (select 1 from public.gl_transactions t where t.business_id::text like '00000000-0000-0000-0000-0000007200b%'
                       and (select coalesce(sum(case side when 'D' then amount else -amount end), 0) from public.gl_lines l where l.transaction_id = t.id) <> 0)
  and (select count(*) = max(number) and count(distinct number) = count(*) from public.gl_transactions where business_id = '00000000-0000-0000-0000-0000007200b1')
  and not exists (select 1 from public.gl_unposted where business_id::text like '00000000-0000-0000-0000-0000007200b%'),
  'every entry balanced, numbered 1..n with no gap; nothing unposted');
-- the business that keeps next month: its rows never posted
select pg_temp.check((select count(*) from public.gl_transactions where business_id = '00000000-0000-0000-0000-0000007200b3') = 0, 'S: nothing posted');
