-- Stage 4ב — the double-entry books, the core (migration 7100) on a real Postgres (tests/sql/run.sh):
--   1. the migration over existing rows (documents, payments, a deposit of two businesses, written before it runs) and again:
--      every row stays as it was; nothing posts before a business's start date
--   2. the owner moves the start to the 1st of this month → the documents since then post, in time order (gl_replay)
--   3. the posting matrix: 300 / 305 / 320 / 320 paying a 300 / 330 / 330's refund / 400 (withholding, cheque, Bit, card in
--      installments) / exempt 300, 400 paying it, 400 alone, refund receipt / cancellation of a 300 / deposit and its cancellation /
--      a register refund — every entry balances; the customer's card and 1310 close to 0
--   4. never blocks: a posting that fails leaves the document issued, is recorded and listed, and posts again (gl_replay)
--   5. append-only, the balance at commit, the RLS (cashier, another business, a location-limited member, anon), the opening
--      balances (once, the owner), the installments check, the reserved keys
-- Fixtures only, fictional: dealer numbers 000000059 / 000000083 / 000000091 (valid check digit), phones 050-00000NN, mails
-- *.example.test, cheque account 000….
--   "Lic"  L: l1 owner, l2 cashier, l3 editor limited to L2; locations main (= the business) and L2
--   "Ex"   E: e1 owner (exempt dealer)
--   "Late" S: s1 owner (licensed; keeps the default start — next month)
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
-- a document the way the app sends it: p_lines [{name, totalExVat, kind}], VAT at p_rate, payments p_pay (a receipt; default cash)
create or replace function pg_temp.doc(p_user text, p_type int, p_lines jsonb, p_key text, p_extra jsonb default '{}', p_pay jsonb default null,
                                       p_rate numeric default 18, p_discount numeric default 0)
returns jsonb language plpgsql as $$
declare bef numeric; aft numeric; vat numeric; ls jsonb;
begin
  select coalesce(sum((e->>'totalExVat')::numeric), 0), jsonb_agg(e || jsonb_build_object('qty', 1, 'unitPriceExVat', (e->>'totalExVat')::numeric, 'discountExVat', 0, 'vatRate', p_rate))
    into bef, ls from jsonb_array_elements(p_lines) e;
  aft := bef - p_discount; vat := case when p_type = 400 then 0 else round(aft * p_rate / 100, 2) end;
  return jsonb_build_object('user_id', p_user, 'doc_type', p_type, 'doc_number', 0, 'doc_date', public.il_today(),
    'customer_name', 'דנה לדוגמה', 'customer_phone', '050-0000071', 'before_discount', bef, 'discount', p_discount, 'after_discount', aft,
    'vat_amount', vat, 'total', aft + vat, 'vat_rate', case when p_type = 400 then 0 else p_rate end, 'idempotency_key', p_key,
    'lines', coalesce(ls, '[]'::jsonb),
    'payments', case when p_type in (320, 400) then coalesce(p_pay, jsonb_build_array(jsonb_build_object('method', 1, 'm', 'cash', 'amount', aft + vat, 'date', public.il_today())))
                     else '[]'::jsonb end) || p_extra;
end $$;
create or replace function pg_temp.svc(p numeric) returns jsonb language sql as $$ select jsonb_build_array(jsonb_build_object('name', 'שירות', 'totalExVat', p, 'kind', 1)) $$;
create or replace function pg_temp.issue(r jsonb) returns uuid language plpgsql as $$
declare cols text; id uuid;
begin
  select string_agg(quote_ident(k), ', ') into cols from jsonb_object_keys(r) k;
  execute format('insert into public.documents (%s) select %s from jsonb_populate_record(null::public.documents, $1) returning id', cols, cols) using r into id;
  return id;
end $$;
create or replace function pg_temp.d(p_key text) returns public.documents language sql as $$ select * from public.documents where idempotency_key = p_key $$;
create or replace function pg_temp.tx(p_kind text, p_id uuid) returns public.gl_transactions language sql as $$
  select * from public.gl_transactions where idempotency_key = p_kind || ':' || p_id $$;
create or replace function pg_temp.txd(p_key text) returns public.gl_transactions language sql as $$ select pg_temp.tx('document', (pg_temp.d(p_key)).id) $$;
-- the lines of an entry, as text: "<account key> <D|C> <amount>" in line order
create or replace function pg_temp.lines(p_tx uuid) returns text language sql as $$
  select string_agg(a.key || ' ' || l.side || ' ' || l.amount, ', ' order by l.line_no)
    from public.gl_lines l join public.gl_accounts a on a.id = l.account_id where l.transaction_id = p_tx $$;
-- an account's balance (debit positive), by key, in a business; optionally only the lines matched to p_match
create or replace function pg_temp.bal(p_business text, p_key text, p_match text default null) returns numeric language sql as $$
  select coalesce(sum(case l.side when 'D' then l.amount else -l.amount end), 0) from public.gl_lines l join public.gl_accounts a on a.id = l.account_id
   where a.business_id = p_business::uuid and a.key = p_key and (p_match is null or l.match1 = p_match) $$;
create temp table out71 (k text, j jsonb);
grant all on out71 to authenticated;
create or replace function pg_temp.o(p_k text) returns jsonb language sql as $$ select j from out71 where k = p_k $$;
create or replace function pg_temp.snapshot() returns text language sql as $$
  select md5(coalesce((select string_agg(d::text, '|' order by d.id) from public.documents d where d.business_id::text like '00000000-0000-0000-0000-0000007100b%'), '')
      || coalesce((select string_agg(p::text, '|' order by p.id) from public.payments p where p.business_id::text like '00000000-0000-0000-0000-0000007100b%'), '')
      || coalesce((select string_agg(c::text, '|' order by c.document_id) from public.document_cancellations c where c.business_id::text like '00000000-0000-0000-0000-0000007100b%'), '')
      || coalesce((select string_agg(x::text, '|' order by x.id) from public.bank_deposits x where x.business_id::text like '00000000-0000-0000-0000-0000007100b%'), '')
      || coalesce((select string_agg(x::text, '|' order by x.deposit_id, x.payment_id) from public.bank_deposit_cheques x where x.business_id::text like '00000000-0000-0000-0000-0000007100b%'), '')
      || coalesce((select string_agg(x::text, '|' order by x.id) from public.sale_refunds x where x.business_id::text like '00000000-0000-0000-0000-0000007100b%'), '')
      || coalesce((select string_agg(x::text, '|' order by x.id) from public.sales x where x.business_id::text like '00000000-0000-0000-0000-0000007100b%'), ''));
$$;

-- ---- "before" --------------------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000007100a1', 'owner@lic-71.example.test'), ('00000000-0000-0000-0000-0000007100a2', 'cashier@lic-71.example.test'),
  ('00000000-0000-0000-0000-0000007100a3', 'branch@lic-71.example.test'), ('00000000-0000-0000-0000-0000007100a4', 'owner@ex-71.example.test'),
  ('00000000-0000-0000-0000-0000007100a5', 'owner@late-71.example.test');
insert into public.businesses (id, name, slug) values
  ('00000000-0000-0000-0000-0000007100b1', 'Lic 71', 'lic-71'), ('00000000-0000-0000-0000-0000007100b2', 'Ex 71', 'ex-71'),
  ('00000000-0000-0000-0000-0000007100b3', 'Late 71', 'late-71');
insert into public.business_locations (id, business_id, name, kind, sort) values
  ('00000000-0000-0000-0000-0000007100c2', '00000000-0000-0000-0000-0000007100b1', 'סניף שני לדוגמה', 'branch', 1);
insert into public.business_members (business_id, user_id, role, access, locations) values
  ('00000000-0000-0000-0000-0000007100b1', '00000000-0000-0000-0000-0000007100a1', 'owner', 'full', null),
  ('00000000-0000-0000-0000-0000007100b1', '00000000-0000-0000-0000-0000007100a2', 'editor', 'register', null),
  ('00000000-0000-0000-0000-0000007100b1', '00000000-0000-0000-0000-0000007100a3', 'editor', 'full', array['00000000-0000-0000-0000-0000007100c2']::uuid[]),
  ('00000000-0000-0000-0000-0000007100b2', '00000000-0000-0000-0000-0000007100a4', 'owner', 'full', null),
  ('00000000-0000-0000-0000-0000007100b3', '00000000-0000-0000-0000-0000007100a5', 'owner', 'full', null);
update public.profiles set current_business_id = '00000000-0000-0000-0000-0000007100b1'
 where id in ('00000000-0000-0000-0000-0000007100a1', '00000000-0000-0000-0000-0000007100a2', '00000000-0000-0000-0000-0000007100a3');
update public.profiles set current_business_id = '00000000-0000-0000-0000-0000007100b2' where id = '00000000-0000-0000-0000-0000007100a4';
update public.profiles set current_business_id = '00000000-0000-0000-0000-0000007100b3' where id = '00000000-0000-0000-0000-0000007100a5';
insert into public.register_settings (user_id, business_id, business_type, vat_rate, dealer_number, legal_name, street, city, entity_type) values
  ('00000000-0000-0000-0000-0000007100a1', '00000000-0000-0000-0000-0000007100b1', 'licensed', 18, '000000059', 'עסק מורשה לדוגמה', 'הדוגמה', 'עיר דוגמה', 'licensed_dealer'),
  ('00000000-0000-0000-0000-0000007100a4', '00000000-0000-0000-0000-0000007100b2', 'exempt', 0, '000000083', 'עוסקת פטורה לדוגמה', 'הדוגמה', 'עיר דוגמה', 'exempt_dealer'),
  ('00000000-0000-0000-0000-0000007100a5', '00000000-0000-0000-0000-0000007100b3', 'licensed', 18, '000000091', 'עסק מאוחר לדוגמה', 'הדוגמה', 'עיר דוגמה', 'licensed_dealer');
insert into public.business_finance_profile (business_id, user_id, cash_drawers) values
  ('00000000-0000-0000-0000-0000007100b1', '00000000-0000-0000-0000-0000007100a1', true),
  ('00000000-0000-0000-0000-0000007100b2', '00000000-0000-0000-0000-0000007100a4', true);
-- the defaults as the migration left them: every business's books start next month
select pg_temp.check((select books_start from public.gl_defaults) = (date_trunc('month', public.il_today()) + interval '1 month')::date,
  'the default start: the 1st of next month');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007100a1');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007100a1', 305, pg_temp.svc(1000), 'b71:old305'));
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007100a1', 320, pg_temp.svc(100), 'b71:oldchq', '{}',
  jsonb_build_array(jsonb_build_object('method', 2, 'm', 'cheque', 'amount', 118, 'date', public.il_today(),
    'cheque', jsonb_build_object('number', '7101', 'bank', '12', 'branch', '600', 'account', '000123456', 'dueDate', (public.il_today() + 10)::text)))));
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007100a4');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007100a4', 400, pg_temp.svc(200), 'b71:ex:old400', '{}', null, 0));
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007100a5');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007100a5', 305, pg_temp.svc(300), 'b71:late:305'));
-- before the start nothing is even queued: an ALTER TABLE later in the same transaction (the tests' "as before 6800") runs as before
reset role;
alter table public.documents enable trigger d_documents_issue_day;
commit;
select pg_temp.check((select count(*) from public.gl_transactions where business_id::text like '00000000-0000-0000-0000-0000007100b%') = 0,
  'before the start date nothing posts');
select pg_temp.check((select count(*) from public.gl_unposted where business_id::text like '00000000-0000-0000-0000-0000007100b%') = 0,
  'and nothing is "unposted" before the start date');

-- ---- the migration again over these rows, twice ----------------------------------------------------------------------------
create temp table before_7100 as select pg_temp.snapshot() as s;
\ir ../../supabase/migrations/20261128007100_books_core.sql
select pg_temp.check((select s from before_7100) = pg_temp.snapshot(), 'the migration over existing rows: every row stays as it was');
\ir ../../supabase/migrations/20261128007100_books_core.sql
select pg_temp.check((select s from before_7100) = pg_temp.snapshot(), 'the migration again: every row stays as it was');
select pg_temp.check((select count(*) from pg_trigger where tgname in ('zz_gl_post', 'zz_gl_post_cancel', 'd_documents_installments', 'gl_lines_balanced', 'gl_transactions_balanced')) = 8,
  'each trigger once after running twice');
select pg_temp.check((select count(*) from public.gl_books where business_id::text like '00000000-0000-0000-0000-0000007100b%') = 3
  and (select bool_and(start_date = (date_trunc('month', public.il_today()) + interval '1 month')::date) from public.gl_books where business_id::text like '00000000-0000-0000-0000-0000007100b%'),
  'every business has its books, from next month');
select pg_temp.check(not has_function_privilege('authenticated', 'public.gl_post(text, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.gl_post_safe(text, uuid)', 'execute')
  and not has_function_privilege('anon', 'public.gl_opening_balances(jsonb)', 'execute')
  and has_function_privilege('authenticated', 'public.gl_opening_balances(jsonb)', 'execute')
  and not has_table_privilege('authenticated', 'public.gl_lines', 'insert') and not has_table_privilege('authenticated', 'public.gl_transactions', 'update')
  and not has_table_privilege('anon', 'public.gl_accounts', 'select') and not has_table_privilege('authenticated', 'public.gl_defaults', 'select'),
  'who may call what: posting only by the database, the tables read-only to the browser');

-- ---- 2. the owner moves the start to this month: the earlier documents post, in time order -----------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007100a3');
select pg_temp.refused_with($$select public.gl_books_start_set(date_trunc('month', public.il_today())::date)$$, 'not allowed', 'only the owner moves the start');
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007100a1');
select pg_temp.refused_with($$select public.gl_books_start_set(public.il_today() - extract(day from public.il_today())::int + 2)$$, 'books_start_date', 'the 1st of a month');
insert into out71 select 'start L', public.gl_books_start_set(date_trunc('month', public.il_today())::date);
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007100a4');
insert into out71 select 'start E', public.gl_books_start_set(date_trunc('month', public.il_today())::date);
commit;
select pg_temp.check((pg_temp.o('start L')->>'posted')::int = 2 and (pg_temp.o('start E')->>'posted')::int = 1, 'the replay posted the documents since the start');
select pg_temp.check((pg_temp.txd('b71:old305')).number = 1 and (pg_temp.txd('b71:oldchq')).number = 2, 'in time order: 1, 2');
select pg_temp.check(pg_temp.lines((pg_temp.txd('b71:old305')).id) = '050-0000071 D 1180.00, 4100 C 1000.00, 2200 C 180.00', '305: the customer / income + VAT');
select pg_temp.check(pg_temp.lines((pg_temp.txd('b71:oldchq')).id) = '050-0000071 D 118.00, 4100 C 100.00, 2200 C 18.00, 1150 D 118.00, 050-0000071 C 118.00',
  '320 by cheque: the charge and the cheque in the main location''s drawer');
select pg_temp.check((select l.value_date = public.il_today() + 10 and l.match1 = '7101' from public.gl_lines l join public.gl_accounts a on a.id = l.account_id
                       where l.transaction_id = (pg_temp.txd('b71:oldchq')).id and a.key = '1150'), 'the cheque: its due date, matched by its number');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007100a1');
select pg_temp.refused_with($$select public.gl_books_start_set(date_trunc('month', public.il_today())::date)$$, 'books_started', 'the start does not move once posted');
insert into out71 select 'replay again', public.gl_replay('00000000-0000-0000-0000-0000007100b1', null);
commit;
select pg_temp.check((pg_temp.o('replay again')->>'posted')::int = 0, 'replay is idempotent');
select pg_temp.check(pg_temp.txd('b71:late:305') is null or (pg_temp.txd('b71:late:305')).id is null, 'S keeps next month: its document does not post');
select pg_temp.check((select a.key = 'BANK' and a.tb_code = 'BANK' from public.gl_accounts a where a.business_id = '00000000-0000-0000-0000-0000007100b1' and a.role = 'bank')
  and (select count(*) from public.gl_accounts a where a.business_id = '00000000-0000-0000-0000-0000007100b1' and a.role like 'expense:%') = 17
  and (select a.parent_key = '1300' and a.tb_code = 'CUSTOMERS' from public.gl_accounts a where a.business_id = '00000000-0000-0000-0000-0000007100b1' and a.key = '050-0000071'),
  'the default chart: BANK, 17 expense accounts, a customer under 1300');

-- ---- 3. the posting matrix (licensed) -----------------------------------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007100a1');
-- A: services and goods, with a discount: 600 + 400 − 100 = 900 → goods 360, services 540; VAT 162
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007100a1', 305,
  '[{"name": "טיפול", "totalExVat": 600, "kind": 1}, {"name": "קרם", "totalExVat": 400, "kind": 2}]', 'b71:A', '{}', null, 18, 100));
-- A2: goods 1/3 → rounding on the last line
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007100a1', 305,
  '[{"name": "א", "totalExVat": 100, "kind": 1}, {"name": "ב", "totalExVat": 100, "kind": 1}, {"name": "ג", "totalExVat": 100, "kind": 2}]', 'b71:A2', '{}', null, 18, 0.01));
-- B: a 320 in cash at L2
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007100a1', 320, pg_temp.svc(100), 'b71:B', '{"location_id": "00000000-0000-0000-0000-0000007100c2"}'));
-- C: a 300, then a 320 that pays it by transfer
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007100a1', 300, pg_temp.svc(500), 'b71:C300', '{"customer_phone": "050-0000072", "customer_name": "רון לדוגמה"}'));
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007100a1');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007100a1', 320, pg_temp.svc(500), 'b71:C320',
  jsonb_build_object('paid_document_id', (pg_temp.d('b71:C300')).id, 'customer_phone', '050-0000072', 'customer_name', 'רון לדוגמה'),
  '[{"method": 4, "m": "transfer", "amount": 590}]'));
-- D: a credit of 100 on A (a 305), and its money back in cash
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007100a1', 330, pg_temp.svc(100), 'b71:D',
  jsonb_build_object('base_doc_type', 305, 'base_doc_number', (pg_temp.d('b71:A')).doc_number)));
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007100a1');
insert into out71 select 'credit refund', to_jsonb(public.record_credit_refund((pg_temp.d('b71:D')).id, 'cash', 118, null, 'החזר'));
-- E: a receipt on the old 305 (1180): tax withheld 100, a cheque 300, Bit 180, a card in 3 installments 600 (the first in 10 days)
select pg_temp.issue(jsonb_build_object('user_id', '00000000-0000-0000-0000-0000007100a1', 'doc_type', 400, 'doc_number', 0, 'doc_date', public.il_today(),
  'customer_name', 'דנה לדוגמה', 'customer_phone', '050-0000071', 'before_discount', 1180, 'discount', 0, 'after_discount', 1180, 'vat_amount', 0,
  'total', 1180, 'vat_rate', 0, 'idempotency_key', 'b71:E', 'lines', '[]'::jsonb, 'paid_document_id', (pg_temp.d('b71:old305')).id,
  'payments', jsonb_build_array(
    jsonb_build_object('method', 9, 'm', 'withholding', 'amount', 100, 'pct', 5),
    jsonb_build_object('method', 2, 'm', 'cheque', 'amount', 300, 'cheque', jsonb_build_object('number', '7102', 'bank', '12', 'branch', '600', 'account', '000123456', 'dueDate', (public.il_today() + 30)::text)),
    jsonb_build_object('method', 4, 'm', 'bit', 'amount', 179.99),
    jsonb_build_object('method', 3, 'm', 'card', 'amount', 600.01, 'cardKind', 2, 'installments', 3, 'firstDue', (public.il_today() + 10)::text))
   ));
commit;
select pg_temp.check(pg_temp.lines((pg_temp.txd('b71:A')).id) = '050-0000071 D 1062.00, 4100 C 540.00, 4110 C 360.00, 2200 C 162.00', 'A: income split by kind, after the discount');
select pg_temp.check(pg_temp.lines((pg_temp.txd('b71:A2')).id) = '050-0000071 D 353.99, 4100 C 199.99, 4110 C 100.00, 2200 C 54.00',
  'A2: the goods share rounded, the services the rest');
select pg_temp.check(pg_temp.lines((pg_temp.txd('b71:B')).id) = '050-0000071 D 118.00, 4100 C 100.00, 2200 C 18.00, 1100-1 D 118.00, 050-0000071 C 118.00'
  and (pg_temp.txd('b71:B')).location_id = '00000000-0000-0000-0000-0000007100c2'
  and (select location_id = '00000000-0000-0000-0000-0000007100c2' and name like '%סניף שני%' from public.gl_accounts where business_id = '00000000-0000-0000-0000-0000007100b1' and key = '1100-1'),
  'B: the cash of L2 — its own account (1100-1), the entry of L2');
select pg_temp.check(pg_temp.lines((pg_temp.txd('b71:C300')).id) = '050-0000072 D 590.00, 1310 C 590.00', 'C: a 300 — the customer / 1310');
select pg_temp.check(pg_temp.lines((pg_temp.txd('b71:C320')).id) = '050-0000072 D 590.00, 4100 C 500.00, 2200 C 90.00, BANK D 590.00, 050-0000072 C 590.00, 1310 D 590.00, 050-0000072 C 590.00'
  and pg_temp.bal('00000000-0000-0000-0000-0000007100b1', '1310') = 0 and pg_temp.bal('00000000-0000-0000-0000-0000007100b1', '050-0000072') = 0
  and (pg_temp.txd('b71:C320')).ref2_type = 300,
  'C: the 320 that pays the 300 — income, the bank, and 1310 closed; the customer at 0');
select pg_temp.check(pg_temp.lines((pg_temp.txd('b71:D')).id) = '4100 D 100.00, 2200 D 18.00, 050-0000071 C 118.00'
  and (select l.match1 from public.gl_lines l where l.transaction_id = (pg_temp.txd('b71:D')).id and l.side = 'C') = (pg_temp.d('b71:A')).link_no::text,
  'D: the credit — income and VAT back, the customer credited, matched to the invoice');
select pg_temp.check(pg_temp.lines((pg_temp.tx('payment', (pg_temp.o('credit refund')#>>'{}')::uuid)).id) = '050-0000071 D 118.00, 1100 C 118.00',
  'D: the credit''s money back (answer 4) — the customer debited, the cash credited');
select pg_temp.check(pg_temp.bal('00000000-0000-0000-0000-0000007100b1', '050-0000071', (pg_temp.d('b71:A')).link_no::text) = 1062 - 118 + 118,
  'A''s lines on the customer''s card: charged, credited, the credit paid back');
select pg_temp.check(pg_temp.lines((pg_temp.txd('b71:E')).id) = '1350 D 100.00, 1150 D 300.00, BANK D 179.99, 1250 D 200.01, 1250 D 200.00, 1250 D 200.00, 050-0000071 C 1180.00',
  'E: the receipt — tax withheld 1350, the cheque, Bit to the bank, the card in 3 installments (the first carries the agora)');
select pg_temp.check((select array_agg(l.value_date order by l.line_no) from public.gl_lines l join public.gl_accounts a on a.id = l.account_id
                       where l.transaction_id = (pg_temp.txd('b71:E')).id and a.key = '1250')
                     = array[public.il_today() + 10, (public.il_today() + 10 + interval '1 month')::date, (public.il_today() + 10 + interval '2 month')::date],
  'E: each installment its own value date, a month apart');
select pg_temp.check(pg_temp.bal('00000000-0000-0000-0000-0000007100b1', '050-0000071', (pg_temp.d('b71:old305')).link_no::text) = 0,
  'the old 305 paid by E: its lines on the card close');
select pg_temp.check((pg_temp.txd('b71:E')).ref1_type = 400 and (pg_temp.txd('b71:E')).ref2_type = 305 and (pg_temp.txd('b71:E')).details like 'קבלה %',
  'the references: the receipt and the invoice it pays');

-- F: a 300 issued by mistake, cancelled → a reversing entry, once
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007100a1');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007100a1', 300, pg_temp.svc(50), 'b71:F'));
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007100a1');
insert into public.document_cancellations (document_id, user_id, reason) values ((pg_temp.d('b71:F')).id, '00000000-0000-0000-0000-0000007100a1', 'הופק בטעות');
commit;
select pg_temp.check(pg_temp.lines((pg_temp.tx('cancellation', (pg_temp.d('b71:F')).id)).id) = '050-0000071 C 59.00, 1310 D 59.00'
  and (pg_temp.tx('cancellation', (pg_temp.d('b71:F')).id)).reverses = (pg_temp.txd('b71:F')).id,
  'F: the cancellation reverses the 300''s entry');

-- G: deposits — the old cheque at the main location; L2's cash, then cancelled
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007100a1');
insert into out71 select 'dep1', public.bank_deposit_create('00000000-0000-0000-0000-0000007100e1', public.il_today(), null, 0,
  array[(select p.id from public.payments p where p.document_id = (pg_temp.d('b71:oldchq')).id)], 'הפקדה לדוגמה');
insert into out71 select 'dep2', public.bank_deposit_create('00000000-0000-0000-0000-0000007100e2', public.il_today(), '00000000-0000-0000-0000-0000007100c2', 100, '{}', '');
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007100a1');
select public.bank_deposit_cancel('00000000-0000-0000-0000-0000007100e2', 'נרשמה בטעות');
commit;
select pg_temp.check(pg_temp.lines((pg_temp.tx('deposit', '00000000-0000-0000-0000-0000007100e1')).id) = 'BANK D 118.00, 1150 C 118.00'
  and (select l.match1 from public.gl_lines l where l.transaction_id = (pg_temp.tx('deposit', '00000000-0000-0000-0000-0000007100e1')).id and l.side = 'C') = '7101'
  and (pg_temp.tx('deposit', '00000000-0000-0000-0000-0000007100e1')).ref1_type = 420,
  'G: a deposit — the bank / the cheque, matched by its number; its document 420 the reference');
select pg_temp.check(pg_temp.lines((pg_temp.tx('deposit', '00000000-0000-0000-0000-0000007100e2')).id) = 'BANK D 100.00, 1100-1 C 100.00'
  and pg_temp.lines((pg_temp.tx('deposit_cancel', '00000000-0000-0000-0000-0000007100e2')).id) = 'BANK C 100.00, 1100-1 D 100.00'
  and (pg_temp.tx('deposit_cancel', '00000000-0000-0000-0000-0000007100e2')).reverses = (pg_temp.tx('deposit', '00000000-0000-0000-0000-0000007100e2')).id,
  'G: L2''s cash deposited, the cancellation reverses it');
select pg_temp.check(pg_temp.bal('00000000-0000-0000-0000-0000007100b1', '1150', '7101') = 0, 'the cheque: received and deposited — 0 on its number');

-- H: a register sale (320 by card) and its refund at the register (card)
insert into public.sales (id, user_id, items, subtotal, total, vat_rate, vat_amount, method, status, paid_at)
values ('00000000-0000-0000-0000-0000007100f1', '00000000-0000-0000-0000-0000007100a2', '[{"name":"שירות","price":118,"qty":1,"kind":"other"}]', 118, 118, 18, 18, 'card', 'paid', now());
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007100a2');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007100a2', 320, pg_temp.svc(100), 'sale:00000000-0000-0000-0000-0000007100f1',
  '{"sale_id": "00000000-0000-0000-0000-0000007100f1", "source": "pos", "customer_phone": "", "customer_name": ""}', '[{"method": 3, "m": "card", "amount": 118}]'));
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007100a1');
insert into public.sale_refunds (id, user_id, sale_id, amount, vat_amount, method, items, restock, reason)
values ('00000000-0000-0000-0000-0000007100f2', '00000000-0000-0000-0000-0000007100a1', '00000000-0000-0000-0000-0000007100f1', 59, 9, 'card', '[]', false, 'ביקשה החזר');
commit;
select pg_temp.check(pg_temp.lines((pg_temp.txd('sale:00000000-0000-0000-0000-0000007100f1')).id) = 'CASH D 118.00, 4100 C 100.00, 2200 C 18.00, 1250 D 118.00, CASH C 118.00',
  'H: a cashier''s sale posts (a walk-in customer: CASH; the card to clearing; cardKind filled by the database)');
select pg_temp.check(pg_temp.lines((select t.id from public.gl_transactions t join public.payments p on p.id = t.source_id
                                     where t.source_kind = 'payment' and p.refund_id = '00000000-0000-0000-0000-0000007100f2')) = 'CASH D 59.00, 1250 C 59.00',
  'H: the register''s refund money — the customer / the card clearing');

-- ---- exempt dealer (answer 2: cash basis) ------------------------------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007100a4');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007100a4', 300, pg_temp.svc(400), 'b71:ex:300', '{}', null, 0));
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007100a4');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007100a4', 400, pg_temp.svc(150), 'b71:ex:pay', jsonb_build_object('paid_document_id', (pg_temp.d('b71:ex:300')).id), null, 0));
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007100a4', 400, '[]', 'b71:ex:back',
  jsonb_build_object('base_doc_type', 400, 'base_doc_number', (pg_temp.d('b71:ex:old400')).doc_number, 'before_discount', -50, 'after_discount', -50, 'total', -50),
  '[{"method": 1, "m": "cash", "amount": -50}]', 0));
commit;
select pg_temp.check(pg_temp.lines((pg_temp.txd('b71:ex:old400')).id) = '1100 D 200.00, 050-0000071 C 200.00, 050-0000071 D 200.00, 4200 C 200.00',
  'exempt 400 alone: the money / the customer, the customer / exempt income');
select pg_temp.check(pg_temp.lines((pg_temp.txd('b71:ex:300')).id) = '050-0000071 D 400.00, 1310 C 400.00', 'exempt 300: the customer / 1310, no VAT');
select pg_temp.check(pg_temp.lines((pg_temp.txd('b71:ex:pay')).id) = '1100 D 150.00, 050-0000071 C 150.00, 1310 D 150.00, 4200 C 150.00'
  and pg_temp.bal('00000000-0000-0000-0000-0000007100b2', '1310') = -250,
  'exempt 400 paying a 300: income when paid, out of 1310 (250 still open)');
select pg_temp.check(pg_temp.lines((pg_temp.txd('b71:ex:back')).id) = '4200 D 50.00, 050-0000071 C 50.00, 050-0000071 D 50.00, 1100 C 50.00',
  'exempt refund receipt: the mirror — income back, the money out');
select pg_temp.check(pg_temp.bal('00000000-0000-0000-0000-0000007100b2', '4200') = -300 and pg_temp.bal('00000000-0000-0000-0000-0000007100b2', '2200') = 0,
  'exempt income = 200 + 150 − 50, no VAT');

-- ---- every entry balances; the trial balance --------------------------------------------------------------------------------
select pg_temp.check(not exists (select 1 from public.gl_transactions t where t.business_id::text like '00000000-0000-0000-0000-0000007100b%'
                                   and (select coalesce(sum(case side when 'D' then amount else -amount end), 0) from public.gl_lines l where l.transaction_id = t.id) <> 0),
  'every entry balances');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007100a1');
insert into out71 select 'tb', (select jsonb_build_object('d', sum(debit), 'c', sum(credit), 'closing', sum(closing), 'vat', sum(closing) filter (where key = '2200'),
                                                   'n', count(*)) from public.gl_trial_balance(date_trunc('month', public.il_today())::date, public.il_today()));
commit;
select pg_temp.check((pg_temp.o('tb')->>'d')::numeric = (pg_temp.o('tb')->>'c')::numeric and (pg_temp.o('tb')->>'closing')::numeric = 0,
  'the trial balance: debits = credits');
select pg_temp.check(-(pg_temp.o('tb')->>'vat')::numeric = (select sum(case doc_type when 330 then -vat_amount else vat_amount end) from public.documents
                                                             where business_id = '00000000-0000-0000-0000-0000007100b1' and doc_type in (305, 320, 330)),
  'VAT output = the VAT of the invoices less the credits');

-- ---- 4. never blocks: a posting that fails ----------------------------------------------------------------------------------
update public.gl_books set last_tx_no = 0 where business_id = '00000000-0000-0000-0000-0000007100b1';   -- the next number is taken
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007100a1');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007100a1', 305, pg_temp.svc(10), 'b71:I'));
commit;
select pg_temp.check((pg_temp.d('b71:I')).id is not null and (pg_temp.txd('b71:I')).id is null, 'a posting that fails: the document is issued, no entry');
select pg_temp.check((select error like '23505%' from public.gl_unposted where source_id = (pg_temp.d('b71:I')).id), 'listed in gl_unposted, with its error');
update public.gl_books set last_tx_no = (select max(number) from public.gl_transactions where business_id = '00000000-0000-0000-0000-0000007100b1')
 where business_id = '00000000-0000-0000-0000-0000007100b1';
select public.gl_replay('00000000-0000-0000-0000-0000007100b1', null);   -- the server (no user)
select pg_temp.check((pg_temp.txd('b71:I')).id is not null and not exists (select 1 from public.gl_unposted where business_id = '00000000-0000-0000-0000-0000007100b1'),
  'the replay posts it; nothing unposted');
select pg_temp.check(public.gl_post('document', (pg_temp.d('b71:I')).id) = (pg_temp.txd('b71:I')).id, 'gl_post again: the same entry');
select pg_temp.check((select min(number) = 1 and max(number) = count(*) and count(distinct number) = count(*)
                        from public.gl_transactions where business_id = '00000000-0000-0000-0000-0000007100b1'), 'the entry numbers run 1, 2, 3 … with no gap');

-- ---- 5. append-only, the balance at commit -----------------------------------------------------------------------------------
select pg_temp.refused_with($$update public.gl_lines set amount = 1 where business_id = '00000000-0000-0000-0000-0000007100b1'$$, 'append-only', 'a line is never changed');
select pg_temp.refused_with($$delete from public.gl_transactions where business_id = '00000000-0000-0000-0000-0000007100b1'$$, 'append-only', 'an entry is never removed');
select pg_temp.refused_with($$truncate public.gl_lines$$, 'append-only', 'nor truncated');
select pg_temp.refused_with($$delete from public.gl_accounts where business_id = '00000000-0000-0000-0000-0000007100b1'$$, 'append-only', 'an account is never removed');
create or replace function pg_temp.unbalanced() returns void language plpgsql as $$
declare t uuid; a uuid := (select id from public.gl_accounts where business_id = '00000000-0000-0000-0000-0000007100b1' and key = 'BANK');
begin
  insert into public.gl_transactions (business_id, number, tx_date, value_date, source_kind, idempotency_key, location_id)
  values ('00000000-0000-0000-0000-0000007100b1', 9999, public.il_today(), public.il_today(), 'opening', 'b71:unbalanced', '00000000-0000-0000-0000-0000007100b1') returning id into t;
  insert into public.gl_lines (transaction_id, business_id, line_no, account_id, side, amount, value_date, location_id)
  values (t, '00000000-0000-0000-0000-0000007100b1', 1, a, 'D', 10, public.il_today(), '00000000-0000-0000-0000-0000007100b1'),
         (t, '00000000-0000-0000-0000-0000007100b1', 2, a, 'C', 9, public.il_today(), '00000000-0000-0000-0000-0000007100b1');
  set constraints all immediate;
end $$;
select pg_temp.refused_with($$select pg_temp.unbalanced()$$, 'gl_unbalanced', 'an entry that does not balance is refused (at commit)');

-- ---- RLS ----------------------------------------------------------------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007100a2');
insert into out71 select 'cashier', jsonb_build_array((select count(*) from public.gl_transactions), (select count(*) from public.gl_lines),
  (select count(*) from public.gl_accounts), (select count(*) from public.gl_books), (select count(*) from public.gl_unposted));
select pg_temp.refused_with($$select public.gl_books_state()$$, 'not allowed', 'a cashier has no books');
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007100a3');
insert into out71 select 'branch', jsonb_build_array((select count(*) from public.gl_transactions), (select count(*) from public.gl_transactions where location_id <> '00000000-0000-0000-0000-0000007100c2'),
  (select count(*) from public.gl_lines where location_id <> '00000000-0000-0000-0000-0000007100c2'),
  (select count(*) from public.gl_accounts where location_id = '00000000-0000-0000-0000-0000007100b1'));
select pg_temp.refused_with($$insert into public.gl_books (business_id, start_date) values ('00000000-0000-0000-0000-0000007100b1', '2026-01-01')$$, 'permission denied', 'no browser writes');
select pg_temp.refused_with($$select public.gl_opening_balances('[{"account": "BANK", "side": "D", "amount": 1}]')$$, 'not allowed', 'only the owner enters the opening');
select pg_temp.refused_with($$select public.gl_replay('00000000-0000-0000-0000-0000007100b1', null)$$, 'not allowed', 'only the owner replays');
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007100a5');
insert into out71 select 'other', jsonb_build_array((select count(*) from public.gl_transactions where business_id <> '00000000-0000-0000-0000-0000007100b3'),
  (select count(*) from public.gl_accounts where business_id <> '00000000-0000-0000-0000-0000007100b3'));
select pg_temp.refused_with($$select public.gl_replay('00000000-0000-0000-0000-0000007100b1', null)$$, 'not allowed', 'never another business''s');
commit;
begin;
set local role anon;
select pg_temp.refused_with($$select count(*) from public.gl_lines$$, 'permission denied', 'anon reads nothing');
commit;
select pg_temp.check(pg_temp.o('cashier') = '[0, 0, 0, 0, 0]', 'a cashier sees nothing of the books');
select pg_temp.check((pg_temp.o('branch')->>0)::int > 0 and (pg_temp.o('branch')->>1)::int = 0 and (pg_temp.o('branch')->>2)::int = 0 and (pg_temp.o('branch')->>3)::int = 0,
  'a member of L2 sees only L2''s entries, lines and location accounts');
select pg_temp.check(pg_temp.o('other') = '[0, 0]', 'another business sees nothing');

-- ---- the opening balances (answer 14) ---------------------------------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007100a1');
select pg_temp.refused_with($$select public.gl_opening_balances('[{"account": "4999", "side": "D", "amount": 1}]')$$, 'opening_account', 'an unknown system key');
select pg_temp.refused_with($$select public.gl_opening_balances('[{"account": "BANK", "side": "D", "amount": 1.001}]')$$, 'opening_line', 'to the agora');
insert into out71 select 'opening', public.gl_opening_balances('[{"account": "BANK", "side": "D", "amount": 5000}, {"account": "2100", "side": "C", "amount": 1200},
  {"account": "050-0000079", "name": "לקוח ותיק לדוגמה", "side": "D", "amount": 300}]');
select pg_temp.refused_with($$select public.gl_opening_balances('[{"account": "BANK", "side": "D", "amount": 1}]')$$, 'opening_done', 'once');
insert into out71 select 'state', public.gl_books_state();
commit;
select pg_temp.check(pg_temp.lines((pg_temp.o('opening')->>'id')::uuid) = 'BANK D 5000.00, 2100 C 1200.00, 050-0000079 D 300.00, 3100 C 4100.00'
  and (select tx_date from public.gl_transactions where id = (pg_temp.o('opening')->>'id')::uuid) = date_trunc('month', public.il_today())::date,
  'the opening: balanced against 3100, dated the start');
select pg_temp.check((pg_temp.o('state')->>'openingEntered')::boolean and not (pg_temp.o('state')->>'canMoveStart')::boolean
  and pg_temp.o('state')->>'startDate' = date_trunc('month', public.il_today())::date::text, 'the state of the books');

-- ---- answer 8: the installments check; the reserved keys ---------------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007100a1');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007100a1', 320, pg_temp.svc(100), 'b71:inst1', '{}',
  '[{"method": 3, "m": "card", "amount": 118, "cardKind": 1, "installments": 3}]'))$$, 'installments_card_only', 'installments — only cardKind 2');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007100a1', 320, pg_temp.svc(100), 'b71:inst2', '{}',
  '[{"method": 1, "m": "cash", "amount": 118, "installments": 3}]'))$$, 'installments_card_only', 'not on cash');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007100a1', 320, pg_temp.svc(100), 'b71:inst3', '{}',
  '[{"method": 3, "m": "card", "amount": 118, "cardKind": 2, "installments": 1}]'))$$, 'installments_count', '2 to 36');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007100a1', 320, pg_temp.svc(100), 'b71:inst4', '{}',
  '[{"method": 3, "m": "card", "amount": 118, "cardKind": 2, "installments": "3"}]'))$$, 'installments_count', 'a JSON number');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007100a1', 320, pg_temp.svc(100), 'b71:inst5', '{}',
  jsonb_build_array(jsonb_build_object('method', 3, 'm', 'card', 'amount', 118, 'cardKind', 2, 'installments', 2, 'firstDue', (public.il_today() - 1)::text))))$$,
  'installments_first_due', 'the first not before the payment');
-- a cardKind 2 without a count — one line, as before
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000007100a1', 320, pg_temp.svc(100), 'b71:inst6', '{"customer_phone": "", "customer_name": "1300"}',
  '[{"method": 3, "m": "card", "amount": 118, "cardKind": 2}]'));
commit;
select pg_temp.check(pg_temp.lines((pg_temp.txd('b71:inst6')).id) = 'C-1300 D 118.00, 4100 C 100.00, 2200 C 18.00, 1250 D 118.00, C-1300 C 118.00',
  'a card in installments without a count — one line; a customer named like a system key gets "C-"');
select pg_temp.check(public.gl_customer_key('', '') = 'CASH' and public.gl_customer_key('050-0000071', 'x') = '050-0000071'
  and public.gl_customer_key('', 'bank') = 'C-bank' and public.gl_customer_key('', '1100-1') = 'C-1100-1'
  and public.gl_customer_key('', 'שם ארוך מאוד של לקוחה לדוגמה') = rtrim(left('שם ארוך מאוד של לקוחה לדוגמה', 15)),
  'the customer key = field 1225 (the phone, else the name, else CASH; 15 characters), never a system key');
-- the key is the text as the file writes it (isoText) BEFORE it is cut to 15: CR / LF runs → one space, direction marks, zero-width
-- characters, the BOM and Hebrew points dropped, spaces trimmed; the maqaf (U+05BE) and other characters stay
select pg_temp.check(public.gl_customer_key(chr(8207) || '050-0000071' || chr(8206), 'x') = '050-0000071', 'direction marks around a phone are dropped');
select pg_temp.check(public.gl_customer_key(chr(8206) || chr(65279), 'דנה') = 'דנה', 'a phone of marks only is no phone — the name');
select pg_temp.check(public.gl_customer_key('', 'שָׁלוֹם') = 'שלום', 'Hebrew points (niqqud, the shin dot) are dropped');
select pg_temp.check(public.gl_customer_key('', 'דנה' || chr(13) || chr(10) || chr(10) || 'כהן') = 'דנה כהן', 'a run of CR / LF is one space');
select pg_temp.check(public.gl_customer_key('', repeat(chr(8203), 20) || 'abcdefghijklmnopq') = 'abcdefghijklmno', 'dropped first, then cut to 15');
select pg_temp.check(public.gl_customer_key('', '   abc  ') = 'abc' and public.gl_customer_key(chr(8294) || ' ' || chr(8297), '') = 'CASH',
  'trimmed at both ends; nothing left → CASH');
select pg_temp.check(public.gl_customer_key('', chr(8206) || '1300') = 'C-1300' and public.gl_customer_key('', 'בית' || chr(1470) || 'קפה') = 'בית' || chr(1470) || 'קפה',
  'the system-key rule after the clean-up; a maqaf stays');
select pg_temp.check(public.gl_customer_key('', 'abcdefghijklm' || chr(13) || 'xyz') = 'abcdefghijklm x', 'the space of a line break counts in the 15');
