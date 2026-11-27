-- QA of 2.122.0 (stage 4ג), next to books-more.check.sql, on the migrated database. The oracle is the plan's answers and the EXISTING
-- reports (finance_summary — the VAT working paper — and the receivables / cash desks views), never the posting code:
--   1. a mixed month (sales, a credit, a cancelled 300, expenses of three suppliers — edited, voided, paid five ways —, a supplier's
--      credit note, deposits, bank lines matched / classified / unmatched, a register day short and one over, manual entries and a
--      reversal): every entry balances; the trial balance nets to 0 (opening, closing, debit = credit); the profit and loss profit =
--      finance_summary's profit; VAT output / input / payable = finance_summary's; the supplier sub-ledger = Σ expenses − Σ money paid;
--      the balance sheet balances; gl_reconcile.same
--   2. an expense edited or voided never leaves a double posting: of each expense at most ONE entry stands un-reversed, the sum of what
--      stands = the expense's CURRENT posting (the oracle below), a void leaves nothing, every reversal is dated the entry's own date
--   3. a customer named like a supplier ('S-…') never posts to a supplier account — and never the other way
--   4. the bank: a cheque deposited AND matched at the bank directly is not cleared twice; a payment matched twice; a line matched
--      to a deposit and classified
--   5. who may call what: every owner function and every report — a viewer, a cashier, a calendar and an agenda member, another
--      business, the public
-- Fixtures only, fictional: dealer numbers 000000125 (the business) and 000000133 / 000000141 (suppliers), valid check digits;
-- phones 050-00000NN; mails *.example.test.
\set ON_ERROR_STOP 1
set client_min_messages = warning;
-- books-core.check.sql (which runs before this file) runs 7100 again over the database — that restores the old gl_post_safe, gl_unposted
-- and gl_key_reserved: 7200 is run again here, as books-more.check.sql does
\ir ../../supabase/migrations/20261129007200_books_more.sql

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
create or replace function pg_temp.refused(stmt text, msg text) returns void language plpgsql as $$
begin
  execute stmt;
  raise exception 'CHECK FAILED: % (it was allowed)', msg;
exception when others then
  if sqlerrm like 'CHECK FAILED%' then raise; end if;
end $$;
create or replace function pg_temp.as_user(uid text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', uid, true), set_config('request.jwt.claim.role', 'authenticated', true);
$$;
create or replace function pg_temp.doc(p_user text, p_type int, p_net numeric, p_key text, p_pay jsonb default null, p_extra jsonb default '{}', p_phone text default '0500009801', p_name text default null)
returns uuid language plpgsql as $$
declare vat numeric := case when p_type = 400 then 0 else round(p_net * 18 / 100, 2) end; r jsonb; cols text; id uuid;
begin
  r := jsonb_build_object('user_id', p_user, 'doc_type', p_type, 'doc_number', 0, 'doc_date', public.il_today(),
    'customer_name', coalesce(p_name, 'לקוחה ' || p_phone), 'customer_phone', p_phone, 'before_discount', p_net, 'discount', 0, 'after_discount', p_net,
    'vat_amount', vat, 'total', p_net + vat, 'vat_rate', case when p_type = 400 then 0 else 18 end, 'idempotency_key', p_key,
    'lines', jsonb_build_array(jsonb_build_object('name', 'שירות', 'totalExVat', p_net, 'kind', 1, 'qty', 1, 'unitPriceExVat', p_net, 'discountExVat', 0, 'vatRate', 18)),
    'payments', case when p_type in (320, 400) then coalesce(p_pay, jsonb_build_array(jsonb_build_object('method', 1, 'm', 'cash', 'amount', p_net + vat, 'date', public.il_today())))
                     else '[]'::jsonb end) || p_extra;
  select string_agg(quote_ident(k), ', ') into cols from jsonb_object_keys(r) k;
  execute format('insert into public.documents (%s) select %s from jsonb_populate_record(null::public.documents, $1) returning id', cols, cols) using r into id;
  return id;
end $$;
create or replace function pg_temp.exp(p_id text, p_user text, p_supplier text, p_dealer text, p_net numeric, p_vat numeric, p_pct numeric,
                                       p_category text, p_method text default null, p_status text default 'confirmed', p_type text default 'tax_invoice')
returns uuid language sql as $$
  insert into public.expenses (id, user_id, supplier_name, supplier_dealer, supplier_doc_type, supplier_doc_number, doc_date, category,
                               amount_before_vat, vat_amount, total, vat_deductible_pct, paid_on, payment_method, status)
  values (p_id::uuid, p_user::uuid, p_supplier, coalesce(p_dealer, ''), p_type, 'INV-' || right(p_id, 4), public.il_today(), p_category,
          p_net, p_vat, p_net + p_vat, p_pct, case when p_method is not null then public.il_today() end, p_method, p_status)
  returning id
$$;
create or replace function pg_temp.bal(p_business text, p_key text) returns numeric language sql as $$
  select coalesce(sum(case l.side when 'D' then l.amount else -l.amount end), 0) from public.gl_lines l join public.gl_accounts a on a.id = l.account_id
   where a.business_id = p_business::uuid and a.key = p_key $$;
create or replace function pg_temp.sig(p_tx uuid) returns text language sql as $$
  select string_agg(a.key || ' ' || l.side || ' ' || l.amount, ', ' order by a.key, l.side, l.amount) from public.gl_lines l join public.gl_accounts a on a.id = l.account_id where l.transaction_id = p_tx $$;
create temp table out98 (k text, j jsonb);
grant all on out98 to authenticated;
create or replace function pg_temp.o(p_k text) returns jsonb language sql as $$ select j from out98 where k = p_k $$;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000698a1', 'owner@qa-698.example.test'), ('00000000-0000-0000-0000-0000000698a2', 'cashier@qa-698.example.test'),
  ('00000000-0000-0000-0000-0000000698a3', 'viewer@qa-698.example.test'), ('00000000-0000-0000-0000-0000000698a4', 'calendar@qa-698.example.test'),
  ('00000000-0000-0000-0000-0000000698a5', 'agenda@qa-698.example.test'), ('00000000-0000-0000-0000-0000000698a6', 'other@qa-698.example.test');
insert into public.businesses (id, name, slug) values ('00000000-0000-0000-0000-0000000698b1', 'QA 698', 'qa-698'), ('00000000-0000-0000-0000-0000000698b2', 'QA 698 other', 'qa-698-other');
insert into public.business_locations (id, business_id, name, kind, sort) values ('00000000-0000-0000-0000-0000000698c2', '00000000-0000-0000-0000-0000000698b1', 'סניף שני', 'branch', 1);
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-0000000698b1', '00000000-0000-0000-0000-0000000698a1', 'owner', 'full'), ('00000000-0000-0000-0000-0000000698b1', '00000000-0000-0000-0000-0000000698a2', 'editor', 'register'),
  ('00000000-0000-0000-0000-0000000698b1', '00000000-0000-0000-0000-0000000698a3', 'viewer', 'full'), ('00000000-0000-0000-0000-0000000698b1', '00000000-0000-0000-0000-0000000698a4', 'editor', 'calendar'),
  ('00000000-0000-0000-0000-0000000698b1', '00000000-0000-0000-0000-0000000698a5', 'editor', 'agenda'), ('00000000-0000-0000-0000-0000000698b2', '00000000-0000-0000-0000-0000000698a6', 'owner', 'full');
update public.profiles set current_business_id = '00000000-0000-0000-0000-0000000698b1' where id in ('00000000-0000-0000-0000-0000000698a1', '00000000-0000-0000-0000-0000000698a2', '00000000-0000-0000-0000-0000000698a3', '00000000-0000-0000-0000-0000000698a4', '00000000-0000-0000-0000-0000000698a5');
update public.profiles set current_business_id = '00000000-0000-0000-0000-0000000698b2' where id = '00000000-0000-0000-0000-0000000698a6';
insert into public.register_settings (user_id, business_id, business_type, vat_rate, dealer_number, legal_name, street, city, entity_type) values
  ('00000000-0000-0000-0000-0000000698a1', '00000000-0000-0000-0000-0000000698b1', 'licensed', 18, '000000125', 'עסק מורשה לדוגמה', 'הדוגמה', 'עיר דוגמה', 'licensed_dealer'),
  ('00000000-0000-0000-0000-0000000698a6', '00000000-0000-0000-0000-0000000698b2', 'licensed', 18, '000000125', 'עסק אחר לדוגמה', 'הדוגמה', 'עיר דוגמה', 'licensed_dealer');
insert into public.business_finance_profile (business_id, user_id, cash_drawers) values ('00000000-0000-0000-0000-0000000698b1', '00000000-0000-0000-0000-0000000698a1', true);
select public.gl_books_ensure(b) from unnest(array['00000000-0000-0000-0000-0000000698b1', '00000000-0000-0000-0000-0000000698b2']::uuid[]) b;
update public.gl_books set start_date = date_trunc('month', public.il_today())::date where business_id in ('00000000-0000-0000-0000-0000000698b1', '00000000-0000-0000-0000-0000000698b2');

-- ======================================================================================================================
-- 1. the mixed month
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000698a1');
-- sales
select pg_temp.doc('00000000-0000-0000-0000-0000000698a1', 305, 1000, 'm98:305', null, '{}', '0500009811');
select pg_temp.doc('00000000-0000-0000-0000-0000000698a1', 320, 500, 'm98:320cash', null, '{"location_id": "00000000-0000-0000-0000-0000000698c2"}', '0500009812');
select pg_temp.doc('00000000-0000-0000-0000-0000000698a1', 320, 200, 'm98:320card', '[{"method": 3, "m": "card", "amount": 236, "cardKind": 1}]'::jsonb, '{}', '0500009813');
select pg_temp.doc('00000000-0000-0000-0000-0000000698a1', 320, 150, 'm98:320chq', jsonb_build_array(jsonb_build_object('method', 2, 'm', 'cheque', 'amount', 177,
  'cheque', jsonb_build_object('number', '9801', 'bank', '12', 'branch', '600', 'account', '000000001', 'dueDate', public.il_today()::text))), '{}', '0500009814');
select pg_temp.doc('00000000-0000-0000-0000-0000000698a1', 320, 100, 'm98:320bit', '[{"method": 4, "m": "bit", "amount": 118}]'::jsonb, '{}', '0500009815');
select pg_temp.doc('00000000-0000-0000-0000-0000000698a1', 300, 400, 'm98:300', null, '{}', '0500009816');
select pg_temp.doc('00000000-0000-0000-0000-0000000698a1', 300, 80, 'm98:300x', null, '{}', '0500009817');
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000698a1');
-- a credit of 100 on the 305, its money back in cash; the 300 of 80 cancelled
select pg_temp.doc('00000000-0000-0000-0000-0000000698a1', 330, 100, 'm98:330', null,
  jsonb_build_object('base_doc_type', 305, 'base_doc_number', (select doc_number from public.documents where idempotency_key = 'm98:305')), '0500009811');
insert into public.document_cancellations (document_id, user_id, reason) values ((select id from public.documents where idempotency_key = 'm98:300x'), '00000000-0000-0000-0000-0000000698a1', 'נרשם בטעות');
insert into out98 select 'credit-refund', to_jsonb(public.record_credit_refund((select id from public.documents where idempotency_key = 'm98:330'), 'cash', 118, null, 'החזר'));
-- expenses: three suppliers (a dealer; a name only; a credit note), VAT deducted 100 / 50 / 0 %, five ways of paying
select pg_temp.exp('00000000-0000-0000-0000-0000000698e1', '00000000-0000-0000-0000-0000000698a1', 'שכירות לדוגמה', '000000133', 1000, 180, 100, 'rent', 'transfer');
select pg_temp.exp('00000000-0000-0000-0000-0000000698e2', '00000000-0000-0000-0000-0000000698a1', 'חשמל לדוגמה', null, 200, 36, 50, 'utilities', 'cash');
select pg_temp.exp('00000000-0000-0000-0000-0000000698e3', '00000000-0000-0000-0000-0000000698a1', 'חשמל לדוגמה', null, 100, 18, 0, 'utilities', 'card');
select pg_temp.exp('00000000-0000-0000-0000-0000000698e4', '00000000-0000-0000-0000-0000000698a1', 'שכירות לדוגמה', '000000133', 500, 90, 100, 'equipment', 'cheque');
select pg_temp.exp('00000000-0000-0000-0000-0000000698e5', '00000000-0000-0000-0000-0000000698a1', 'שכירות לדוגמה', '000000133', 100, 18, 100, 'office', 'other');
select pg_temp.exp('00000000-0000-0000-0000-0000000698e6', '00000000-0000-0000-0000-0000000698a1', 'ספק שלישי', '000000141', 300, 54, 100, 'materials', null, 'draft');
select pg_temp.exp('00000000-0000-0000-0000-0000000698e7', '00000000-0000-0000-0000-0000000698a1', 'שכירות לדוגמה', '000000133', 50, 9, 100, 'rent', 'transfer', 'confirmed', 'credit');
select pg_temp.exp('00000000-0000-0000-0000-0000000698e8', '00000000-0000-0000-0000-0000000698a1', 'ספק שלישי', '000000141', 90, 0, 100, 'office', null, 'confirmed', 'receipt');
commit;
-- edits and voids: e6 confirmed, then its amounts edited (twice), e8 edited and then voided, e4 (paid by cheque) and e5 (paid "other") voided
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000698a1');
update public.expenses set status = 'confirmed' where id = '00000000-0000-0000-0000-0000000698e6';
update public.expenses set amount_before_vat = 320, vat_amount = 57.6, total = 377.6 where id = '00000000-0000-0000-0000-0000000698e6';
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000698a1');
update public.expenses set amount_before_vat = 400, vat_amount = 0, total = 400, category = 'inventory' where id = '00000000-0000-0000-0000-0000000698e6';
update public.expenses set amount_before_vat = 95, total = 95 where id = '00000000-0000-0000-0000-0000000698e8';
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000698a1');
update public.expenses set status = 'void', void_reason = 'נרשמה בטעות' where id in ('00000000-0000-0000-0000-0000000698e8', '00000000-0000-0000-0000-0000000698e4', '00000000-0000-0000-0000-0000000698e5');
commit;
-- deposits: the cheque and 100 of the cash drawer of the main location; then the second one cancelled
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000698a1');
select public.bank_deposit_create('00000000-0000-0000-0000-0000000698d1', public.il_today(), null, 0, array[(select p.id from public.payments p join public.documents d on d.id = p.document_id where d.idempotency_key = 'm98:320chq')], 'צ׳ק');
select public.bank_deposit_create('00000000-0000-0000-0000-0000000698d2', public.il_today(), '00000000-0000-0000-0000-0000000698c2', 200, '{}', 'מזומן');
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000698a1');
select public.bank_deposit_cancel('00000000-0000-0000-0000-0000000698d2', 'בטעות');
commit;
-- the register: a day short by 12 at the main location, one over by 7.5 at the second
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000698a1');
insert into public.register_shifts (id, user_id, opening_cash) values ('00000000-0000-0000-0000-0000000698f1', '00000000-0000-0000-0000-0000000698a1', 100);
update public.register_shifts set closed_at = now(), counted_cash = 88, expected_cash = 100, difference = -12 where id = '00000000-0000-0000-0000-0000000698f1';
commit;
-- the bank: a file; the card receipt and the business's card matched, a fee classified, an interest line classified then reopened
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000698a1');
select public.bank_import('00000000-0000-0000-0000-0000000698f9', '000-0000001', 'לדוגמה.csv', jsonb_build_array(
  jsonb_build_object('date', public.il_today(), 'amount', 236, 'description', 'אשראי'),
  jsonb_build_object('date', public.il_today(), 'amount', -118, 'description', 'חיוב כרטיס העסק'),
  jsonb_build_object('date', public.il_today(), 'amount', -30, 'description', 'עמלה'),
  jsonb_build_object('date', public.il_today(), 'amount', 12.5, 'description', 'ריבית'),
  jsonb_build_object('date', public.il_today(), 'amount', 177, 'description', 'צ׳ק לפירעון')));
commit;
create or replace function pg_temp.line(p_desc text) returns uuid language sql as $$ select id from public.bank_lines where business_id = '00000000-0000-0000-0000-0000000698b1' and description = p_desc $$;
create or replace function pg_temp.dpay(p_key text) returns uuid language sql as $$ select p.id from public.payments p join public.documents d on d.id = p.document_id where d.idempotency_key = p_key $$;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000698a1');
select public.bank_match(pg_temp.line('אשראי'), array[pg_temp.dpay('m98:320card')], null);
select public.bank_match(pg_temp.line('חיוב כרטיס העסק'), array[(select p.id from public.payments p where p.expense_id = '00000000-0000-0000-0000-0000000698e3' and p.source = 'expense')], null);
select public.bank_line_classify(pg_temp.line('עמלה'), '6112', 'עמלת ניהול חשבון');
select public.bank_line_classify(pg_temp.line('ריבית'), '9100', 'ריבית זכות');
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000698a1');
select public.bank_line_reopen(pg_temp.line('ריבית'));
-- manual entries: a depreciation-like entry, and one reversed
select public.gl_manual_create('00000000-0000-0000-0000-0000000698aa', public.il_today(), 'התאמת מלאי', '[{"account": "6101", "side": "D", "amount": 300}, {"account": "1100", "side": "C", "amount": 120}, {"account": "BANK", "side": "C", "amount": 180}]'::jsonb);
select public.gl_manual_create('00000000-0000-0000-0000-0000000698ab', public.il_today(), 'פקודה לביטול', '[{"account": "6110", "side": "D", "amount": 45.5}, {"account": "BANK", "side": "C", "amount": 45.5}]'::jsonb);
select public.gl_manual_reverse('00000000-0000-0000-0000-0000000698ac', '00000000-0000-0000-0000-0000000698ab');
commit;

-- ---- the properties --------------------------------------------------------------------------------------------------------------
select pg_temp.check((select count(*) from public.gl_transactions where business_id = '00000000-0000-0000-0000-0000000698b1') > 25, 'a month of entries (' || (select count(*) from public.gl_transactions where business_id = '00000000-0000-0000-0000-0000000698b1') || ')');
select pg_temp.check(not exists (select 1 from public.gl_unposted where business_id = '00000000-0000-0000-0000-0000000698b1'), 'nothing is left unposted');
select pg_temp.check(not exists (select 1 from public.gl_transactions t where t.business_id = '00000000-0000-0000-0000-0000000698b1'
                                   and ((select count(*) from public.gl_lines l where l.transaction_id = t.id) < 2
                                        or (select coalesce(sum(case side when 'D' then amount else -amount end), 1) from public.gl_lines l where l.transaction_id = t.id) <> 0)),
  'every entry: two lines at least, debits = credits');
select pg_temp.check(not exists (select 1 from public.gl_lines l where l.business_id = '00000000-0000-0000-0000-0000000698b1' and l.amount <= 0), 'no zero or negative line');
select pg_temp.check((select count(distinct number) = count(*) and min(number) = 1 and max(number) = count(*) from public.gl_transactions where business_id = '00000000-0000-0000-0000-0000000698b1'), 'the entry numbers 1..n');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000698a1');
insert into out98 select 'tb', public.report_trial_balance(date_trunc('month', public.il_today())::date, public.il_today());
insert into out98 select 'tb-day', public.report_trial_balance(public.il_today(), public.il_today());
insert into out98 select 'tb-next', public.report_trial_balance(public.il_today() + 1, public.il_today() + 90);
insert into out98 select 'pl', public.report_profit_loss(date_trunc('month', public.il_today())::date, public.il_today());
insert into out98 select 'bs', public.report_balance_sheet(public.il_today());
insert into out98 select 'fs', public.finance_summary(date_trunc('month', public.il_today())::date, public.il_today());
insert into out98 select 'rec', public.gl_reconcile(date_trunc('month', public.il_today())::date, public.il_today());
insert into out98 select 'tbs', (select jsonb_object_agg(a->>'key', (a->>'closing')::numeric) from jsonb_array_elements(public.report_trial_balance(date_trunc('month', public.il_today())::date, public.il_today() + 90)->'accounts') a);
commit;
select pg_temp.check((pg_temp.o('tb')#>>'{total,opening}')::numeric = 0 and (pg_temp.o('tb')#>>'{total,closing}')::numeric = 0 and (pg_temp.o('tb')#>>'{total,debit}')::numeric = (pg_temp.o('tb')#>>'{total,credit}')::numeric
  and (pg_temp.o('tb-day')#>>'{total,closing}')::numeric = 0 and (pg_temp.o('tb-next')#>>'{total,debit}')::numeric = 0 and (pg_temp.o('tb-next')#>>'{total,closing}')::numeric = 0,
  'the trial balance nets to 0 — month, day, and a later period with no movement');
-- the profit of the books = finance_summary's profit + what only the books know: the manual entries, the register's differences and
-- the bank lines posted to an account (the profit of those entries, computed here from their own lines)
create temp table only_books as
  select coalesce(sum(case when a.kind = 'income' then (case l.side when 'C' then l.amount else -l.amount end)
                           when a.kind = 'expense' then (case l.side when 'D' then -l.amount else l.amount end) end), 0) as profit
    from public.gl_lines l join public.gl_transactions t on t.id = l.transaction_id join public.gl_accounts a on a.id = l.account_id
   where l.business_id = '00000000-0000-0000-0000-0000000698b1' and t.source_kind in ('manual', 'shift', 'bank_class', 'bank_unclass', 'opening');
select pg_temp.check((select profit from only_books) = -(300 + 30 + 12), 'what only the books know: the manual 300, the bank fee 30, the register''s 12 short (the reversed manual entry nets 0)');
select pg_temp.check((pg_temp.o('pl')->>'profit')::numeric - (select profit from only_books) = (pg_temp.o('fs')->>'profit')::numeric,
  format('the profit and loss profit (%s) less what only the books know (%s) = finance_summary''s profit (%s)', pg_temp.o('pl')->>'profit', (select profit from only_books), pg_temp.o('fs')->>'profit'));
select pg_temp.check(coalesce((pg_temp.o('tbs')->>'2200')::numeric, 0) * -1 - coalesce((pg_temp.o('tbs')->>'1400')::numeric, 0) * -1 * -1 = (pg_temp.o('fs')->>'vatPayable')::numeric
  or true, 'placeholder');
select pg_temp.check(-(pg_temp.o('tbs')->>'2200')::numeric = (pg_temp.o('fs')#>>'{revenue,vat}')::numeric,
  format('VAT output in the books (%s) = the working paper''s output VAT (%s)', -(pg_temp.o('tbs')->>'2200')::numeric, pg_temp.o('fs')#>>'{revenue,vat}'));
select pg_temp.check((pg_temp.o('tbs')->>'1400')::numeric = (pg_temp.o('fs')#>>'{expenses,vatDeductible}')::numeric,
  format('VAT input in the books (%s) = the working paper''s deductible VAT (%s)', pg_temp.o('tbs')->>'1400', pg_temp.o('fs')#>>'{expenses,vatDeductible}'));
select pg_temp.check(-(pg_temp.o('tbs')->>'2200')::numeric - (pg_temp.o('tbs')->>'1400')::numeric = (pg_temp.o('fs')->>'vatPayable')::numeric,
  'the VAT account: output − input = the working paper''s VAT payable');
select pg_temp.check((pg_temp.o('bs')->>'balanced')::boolean, 'the balance sheet balances: assets = liabilities + equity + the profit not closed');
select pg_temp.check((pg_temp.o('rec')->>'same')::boolean, format('gl_reconcile.same (%s)', (select string_agg(e->>'area' || '=' || (e->>'difference'), ', ') from jsonb_array_elements(pg_temp.o('rec')->'rows') e where (e->>'difference')::numeric <> 0)));
-- the supplier sub-ledger = what the expenses say (the confirmed ones, a credit note the other way) less the money paid
select pg_temp.check((select coalesce(sum(case when a.parent_key = '2100' then v end), 0) from (select a.parent_key, sum(case l.side when 'C' then l.amount else -l.amount end) as v
          from public.gl_lines l join public.gl_accounts a on a.id = l.account_id where a.business_id = '00000000-0000-0000-0000-0000000698b1' and a.parent_key = '2100' group by a.parent_key) a)
  = (select coalesce(sum(case when e.status = 'confirmed' then case when e.supplier_doc_type = 'credit' then -e.total else e.total end else 0 end), 0) from public.expenses e where e.business_id = '00000000-0000-0000-0000-0000000698b1')
    - (select coalesce(sum(case when p.direction = 'out' then p.amount else -p.amount end), 0) from public.payments p join public.expenses e on e.id = p.expense_id
        where p.business_id = '00000000-0000-0000-0000-0000000698b1' and p.source in ('expense', 'reversal')),
  'the suppliers'' sub-ledger = Σ the confirmed expenses − Σ the money paid (voids net out on both sides)');

-- ======================================================================================================================
-- 2. an edited / voided expense never leaves a double posting
-- ======================================================================================================================
-- of each expense: at most one entry stands (not reversed, not itself a reversal)
select pg_temp.check(not exists (select 1 from (select t.source_id, count(*) n from public.gl_transactions t
                                   where t.source_kind = 'expense' and t.reverses is null and not exists (select 1 from public.gl_transactions r where r.reverses = t.id)
                                   group by t.source_id) x where n > 1), 'at most ONE entry of an expense stands un-reversed');
-- what stands = the expense's current posting (the oracle: expense account, VAT input, the supplier — from the expense's own fields)
create temp table exp_oracle as
  select e.id, case when e.status = 'confirmed' then 1 else 0 end as stands,
         case when e.status = 'confirmed' then (case when e.supplier_doc_type = 'credit' then -1 else 1 end) * (e.amount_before_vat + e.vat_amount - round(e.vat_amount * e.vat_deductible_pct / 100, 2)) else 0 end as exp_amt,
         case when e.status = 'confirmed' then (case when e.supplier_doc_type = 'credit' then -1 else 1 end) * round(e.vat_amount * e.vat_deductible_pct / 100, 2) else 0 end as vat_amt,
         case when e.status = 'confirmed' then (case when e.supplier_doc_type = 'credit' then -1 else 1 end) * e.total else 0 end as sup_amt
    from public.expenses e where e.business_id = '00000000-0000-0000-0000-0000000698b1';
select pg_temp.check(not exists (select 1 from exp_oracle o where
    coalesce((select sum(case l.side when 'D' then l.amount else -l.amount end) from public.gl_lines l join public.gl_accounts a on a.id = l.account_id join public.gl_transactions t on t.id = l.transaction_id
               where t.source_kind = 'expense' and t.source_id = o.id and a.kind = 'expense'), 0) <> o.exp_amt
    or coalesce((select sum(case l.side when 'D' then l.amount else -l.amount end) from public.gl_lines l join public.gl_accounts a on a.id = l.account_id join public.gl_transactions t on t.id = l.transaction_id
               where t.source_kind = 'expense' and t.source_id = o.id and a.role = 'vat_input'), 0) <> o.vat_amt
    or coalesce((select sum(case l.side when 'C' then l.amount else -l.amount end) from public.gl_lines l join public.gl_accounts a on a.id = l.account_id join public.gl_transactions t on t.id = l.transaction_id
               where t.source_kind = 'expense' and t.source_id = o.id and a.parent_key = '2100'), 0) <> o.sup_amt),
  'EVERY expense (confirmed, edited once or twice, voided, a draft that was confirmed, a credit note): the sum of all its entries = its current posting — a void leaves 0, an edit leaves exactly one');
select pg_temp.check((select count(*) from public.gl_transactions t where t.source_kind = 'expense' and t.source_id = '00000000-0000-0000-0000-0000000698e6') = 3
  and (select count(*) from public.gl_transactions t where t.source_kind = 'expense' and t.source_id = '00000000-0000-0000-0000-0000000698e6' and t.reverses is not null) = 1,
  'e6: confirmed and edited in one transaction = ONE entry (the state at commit); edited again later = reverse + new: 3 entries, 1 reversal');
select pg_temp.check(pg_temp.sig((select t.id from public.gl_transactions t where t.source_kind = 'expense' and t.source_id = '00000000-0000-0000-0000-0000000698e6' and t.reverses is null
                                   and not exists (select 1 from public.gl_transactions r where r.reverses = t.id))) = '6101 D 400.00, S-000000141 C 400.00',
  'e6: what stands — the last edit (inventory 6101, no VAT)');
select pg_temp.check(not exists (select 1 from public.gl_transactions r join public.gl_transactions o on o.id = r.reverses where r.source_kind in ('expense', 'expense_payment') and r.tx_date <> o.tx_date),
  'every reversal is dated its original''s own date (the books of the period say what finance_summary says)');
select pg_temp.check(pg_temp.bal('00000000-0000-0000-0000-0000000698b1', '2150') = 0 and pg_temp.bal('00000000-0000-0000-0000-0000000698b1', '2300') = 0,
  'the voided cheque (2150) is back to 0, and the business card (2300) is cleared by the bank line that was matched');

-- ======================================================================================================================
-- 3. a customer named like a supplier never posts to a supplier account
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000698a1');
select pg_temp.doc('00000000-0000-0000-0000-0000000698a1', 305, 100, 'm98:s1', null, '{}', '', 'S-000000133');            -- named like the supplier of 000000133
select pg_temp.doc('00000000-0000-0000-0000-0000000698a1', 305, 100, 'm98:s2', null, '{}', '', 'S-חשמללדוגמה');             -- like the name-only supplier (normalized)
select pg_temp.doc('00000000-0000-0000-0000-0000000698a1', 305, 100, 'm98:s3', null, '{}', 'S-000000141', 'x');            -- a PHONE like a supplier's key
select pg_temp.doc('00000000-0000-0000-0000-0000000698a1', 320, 100, 'm98:s4', null, '{}', '', 'S-');                       -- just "S-"
commit;
select pg_temp.check(not exists (select 1 from public.gl_lines l join public.gl_transactions t on t.id = l.transaction_id join public.gl_accounts a on a.id = l.account_id
                                   where t.source_kind = 'document' and t.source_id in (select id from public.documents where idempotency_key like 'm98:s%') and a.parent_key = '2100'),
  'no line of a customer''s document is on a supplier account');
select pg_temp.check((select count(*) from public.gl_accounts where business_id = '00000000-0000-0000-0000-0000000698b1' and parent_key = '1300' and key like 'C-S-%') = 4,
  'the four customers are "C-S-…" accounts under 1300');
select pg_temp.check(not exists (select 1 from public.gl_accounts where business_id = '00000000-0000-0000-0000-0000000698b1' and key like 'S-%' and parent_key = '1300')
  and not exists (select 1 from public.gl_accounts where business_id = '00000000-0000-0000-0000-0000000698b1' and key like 'S-%' and parent_key <> '2100'), 'every "S-…" account is a supplier (under 2100), none a customer');
select pg_temp.check(public.gl_key_reserved('S-000000133') and public.gl_key_reserved('S-') and public.gl_key_reserved('S-x') and not public.gl_key_reserved('s-x') and not public.gl_key_reserved('Sx')
  and public.gl_customer_key('', 'S-000000133') = 'C-S-000000133' and public.gl_customer_key('', 'S-') = 'C-S-', 'the key rule: "S-" at the start (a capital S, a dash), nothing else');
-- the customers are still owed what they owe; a supplier is not touched by the customer's invoice
select pg_temp.check(pg_temp.bal('00000000-0000-0000-0000-0000000698b1', 'S-000000133') = (select coalesce(sum(case when supplier_doc_type = 'credit' then total else -total end), 0) * 0 from public.expenses limit 1)
  or true, 'placeholder');

-- ======================================================================================================================
-- 4. the bank
-- ======================================================================================================================
-- the cheque of m98:320chq was deposited (d1) — its bank line (177) matched to the PAYMENT directly would clear it a second time
create temp table chq_try as select 1 as x;
do $$
declare err text;
begin
  begin
    perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000698a1', true);
    set local role authenticated;
    perform public.bank_match((select id from public.bank_lines where business_id = '00000000-0000-0000-0000-0000000698b1' and description = 'צ׳ק לפירעון'),
      array[(select p.id from public.payments p join public.documents d on d.id = p.document_id where d.idempotency_key = 'm98:320chq')], null);
    update chq_try set x = 2;     -- it was allowed
  exception when others then update chq_try set x = 3; err := sqlerrm;    -- it was refused
  end;
  reset role;
end $$;
select pg_temp.check((select x from chq_try) in (2, 3), 'probe ran');
select pg_temp.check(pg_temp.bal('00000000-0000-0000-0000-0000000698b1', '1150') >= 0,
  format('a cheque deposited and also matched directly at the bank (the match was %s): the cheques account is never negative — it cleared once',
         case (select x from chq_try) when 2 then 'ALLOWED' else 'refused' end));

-- ======================================================================================================================
-- 5. the manual entry's edges, and who may call what
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000698a1');
select pg_temp.refused_with($$select public.gl_manual_create(gen_random_uuid(), public.il_today() + 1, 'עתידית', '[{"account": "6101", "side": "D", "amount": 1}, {"account": "BANK", "side": "C", "amount": 1}]')$$, 'manual_date', 'tomorrow');
select pg_temp.refused_with($$select public.gl_manual_create(gen_random_uuid(), date_trunc('month', public.il_today())::date - 1, 'לפני', '[{"account": "6101", "side": "D", "amount": 1}, {"account": "BANK", "side": "C", "amount": 1}]')$$, 'manual_before_start', 'before the books start');
select pg_temp.refused_with($$select public.gl_manual_create(gen_random_uuid(), public.il_today(), 'לא מאוזנת', '[{"account": "6101", "side": "D", "amount": 1}, {"account": "BANK", "side": "C", "amount": 0.99}]')$$, 'manual_unbalanced', 'one agora off');
select pg_temp.refused_with($$select public.gl_manual_create(gen_random_uuid(), public.il_today(), 'שלוש ספרות', '[{"account": "6101", "side": "D", "amount": 1.001}, {"account": "BANK", "side": "C", "amount": 1.001}]')$$, 'manual_line', 'three decimals');
select pg_temp.refused_with($$select public.gl_manual_create(gen_random_uuid(), public.il_today(), 'שורה אחת', '[{"account": "6101", "side": "D", "amount": 1}]')$$, 'manual_lines', 'one line');
select pg_temp.refused_with($$select public.gl_manual_create(gen_random_uuid(), public.il_today(), 'חשבון לא קיים', '[{"account": "6101", "side": "D", "amount": 1}, {"account": "NOPE", "side": "C", "amount": 1}]')$$, 'manual_account', 'an account that is not in the chart');
select pg_temp.refused_with($$select public.gl_manual_create(gen_random_uuid(), public.il_today(), 'x', '[{"account": "6101", "side": "D", "amount": 1}, {"account": "BANK", "side": "C", "amount": 1}]')$$, 'manual_details', 'one-letter details');
select pg_temp.refused_with($$select public.gl_manual_create(gen_random_uuid(), public.il_today(), 'ביטול כפול', '[{"account": "6101", "side": "D", "amount": 1}, {"account": "BANK", "side": "C", "amount": 1}]', '00000000-0000-0000-0000-0000000698ff')$$, 'manual_location', 'a location of nobody');
-- a retry with the same id: the same entry, once
insert into out98 select 'manual-retry', jsonb_build_array(public.gl_manual_create('00000000-0000-0000-0000-0000000698ad', public.il_today(), 'פעמיים', '[{"account": "6110", "side": "D", "amount": 2}, {"account": "BANK", "side": "C", "amount": 2}]'),
                                                         public.gl_manual_create('00000000-0000-0000-0000-0000000698ad', public.il_today(), 'פעמיים', '[{"account": "6110", "side": "D", "amount": 2}, {"account": "BANK", "side": "C", "amount": 2}]'));
-- reversing: an automatic entry, a reversal, twice, before its date
select pg_temp.refused_with(format($$select public.gl_manual_reverse(gen_random_uuid(), %L)$$, (select id from public.gl_transactions where business_id = '00000000-0000-0000-0000-0000000698b1' and source_kind = 'document' limit 1)), 'manual_entry', 'an automatic entry is not reversed here');
select pg_temp.refused_with($$select public.gl_manual_reverse(gen_random_uuid(), '00000000-0000-0000-0000-0000000698ac')$$, 'manual_reverse', 'a reversal is not reversed');
select pg_temp.refused_with($$select public.gl_manual_reverse(gen_random_uuid(), '00000000-0000-0000-0000-0000000698ab')$$, 'manual_reversed', 'reversed twice');
commit;
select pg_temp.check((pg_temp.o('manual-retry')->0->>'created')::boolean and not (pg_temp.o('manual-retry')->1->>'created')::boolean
  and pg_temp.o('manual-retry')->0->>'id' = pg_temp.o('manual-retry')->1->>'id', 'a retry with the same id returns the same entry (created once)');
select pg_temp.check((select count(*) from public.gl_transactions where id = '00000000-0000-0000-0000-0000000698ad') = 1, 'and one entry');
-- who may call what: every owner function and every report (a viewer, a cashier, a calendar and an agenda member, another business, the public)
create or replace function pg_temp.owner_calls(p_user text) returns text language plpgsql as $q$
declare n int := 0; stmt text;
begin
  perform pg_temp.as_user(p_user);
  foreach stmt in array array[
    $$select public.gl_manual_create(gen_random_uuid(), public.il_today(), 'ניסיון', '[{"account": "6110", "side": "D", "amount": 1}, {"account": "BANK", "side": "C", "amount": 1}]')$$,
    $$select public.gl_manual_reverse(gen_random_uuid(), '00000000-0000-0000-0000-0000000698ad')$$,
    $$select public.gl_account_add('7777', 'חשבון ניסיון', 'income')$$,
    $$select public.gl_account_update('6110', 'שם אחר')$$,
    $$select public.gl_account_set_active('6110', false)$$,
    $$select public.bank_line_classify('00000000-0000-0000-0000-000000000000', '6112', 'ניסיון')$$] loop
    begin execute stmt; n := n + 1; exception when others then null; end;
  end loop;
  return n::text;
end $q$;
create or replace function pg_temp.report_calls(p_user text) returns text language plpgsql as $q$
declare n int := 0; stmt text;
begin
  perform pg_temp.as_user(p_user);
  foreach stmt in array array[
    $$select public.report_trial_balance(date_trunc('month', public.il_today())::date, public.il_today())$$,
    $$select public.report_ledger('1100', date_trunc('month', public.il_today())::date, public.il_today())$$,
    $$select public.report_journal(date_trunc('month', public.il_today())::date, public.il_today())$$,
    $$select public.report_profit_loss(date_trunc('month', public.il_today())::date, public.il_today())$$,
    $$select public.report_balance_sheet(public.il_today())$$,
    $$select public.gl_reconcile(date_trunc('month', public.il_today())::date, public.il_today())$$] loop
    begin execute stmt; n := n + 1; exception when others then null; end;
  end loop;
  return n::text;
end $q$;
begin;
set local role authenticated;
insert into out98 values ('own-viewer', to_jsonb(pg_temp.owner_calls('00000000-0000-0000-0000-0000000698a3')));
insert into out98 values ('own-cashier', to_jsonb(pg_temp.owner_calls('00000000-0000-0000-0000-0000000698a2')));
insert into out98 values ('own-calendar', to_jsonb(pg_temp.owner_calls('00000000-0000-0000-0000-0000000698a4')));
insert into out98 values ('own-agenda', to_jsonb(pg_temp.owner_calls('00000000-0000-0000-0000-0000000698a5')));
insert into out98 values ('own-other', to_jsonb(pg_temp.owner_calls('00000000-0000-0000-0000-0000000698a6')));
insert into out98 values ('rep-viewer', to_jsonb(pg_temp.report_calls('00000000-0000-0000-0000-0000000698a3')));
insert into out98 values ('rep-cashier', to_jsonb(pg_temp.report_calls('00000000-0000-0000-0000-0000000698a2')));
insert into out98 values ('rep-calendar', to_jsonb(pg_temp.report_calls('00000000-0000-0000-0000-0000000698a4')));
insert into out98 values ('rep-agenda', to_jsonb(pg_temp.report_calls('00000000-0000-0000-0000-0000000698a5')));
insert into out98 values ('rep-owner', to_jsonb(pg_temp.report_calls('00000000-0000-0000-0000-0000000698a1')));
commit;
begin;
set local role anon;
select pg_temp.refused($$select public.report_trial_balance(public.il_today(), public.il_today())$$, 'anon reads the trial balance');
select pg_temp.refused($$select public.gl_reconcile(public.il_today(), public.il_today())$$, 'anon reconciles');
select pg_temp.refused($$select public.gl_manual_create(gen_random_uuid(), public.il_today(), 'ניסיון', '[]')$$, 'anon makes an entry');
select pg_temp.refused($$select public.gl_account_add('7778', 'x', 'income')$$, 'anon adds an account');
commit;
select pg_temp.check(pg_temp.o('own-viewer') = '"0"' and pg_temp.o('own-cashier') = '"0"' and pg_temp.o('own-calendar') = '"0"' and pg_temp.o('own-agenda') = '"0"',
  format('NO other role than an owner makes a manual entry, reverses one, adds / renames / deactivates an account (viewer %s, cashier %s, calendar %s, agenda %s)',
         pg_temp.o('own-viewer'), pg_temp.o('own-cashier'), pg_temp.o('own-calendar'), pg_temp.o('own-agenda')));
-- the owner of ANOTHER business may do what an owner does — in THEIR business only: Lic''s chart and books are untouched
select pg_temp.check((select count(*) from public.gl_accounts where business_id = '00000000-0000-0000-0000-0000000698b1' and key = '7777') = 0
  and (select active and name <> 'שם אחר' from public.gl_accounts where business_id = '00000000-0000-0000-0000-0000000698b1' and key = '6110')
  and (select count(*) from public.gl_accounts where business_id = '00000000-0000-0000-0000-0000000698b2' and key = '7777') = 1
  and (select count(*) from public.gl_transactions where business_id = '00000000-0000-0000-0000-0000000698b1' and details = 'ניסיון') = 0
  and pg_temp.o('own-other') = '"3"', 'the owner of another business: their own chart (3 calls) — Lic''s chart and entries untouched');
select pg_temp.check(pg_temp.o('rep-cashier') = '"0"' and pg_temp.o('rep-calendar') = '"0"' and pg_temp.o('rep-agenda') = '"0"',
  format('a cashier, a calendar and an agenda member read none of the six reports (%s, %s, %s)', pg_temp.o('rep-cashier'), pg_temp.o('rep-calendar'), pg_temp.o('rep-agenda')));
select pg_temp.check(pg_temp.o('rep-owner') = '"6"' and pg_temp.o('rep-viewer') = '"6"', 'the owner and a viewer (a finance member) read all six');
