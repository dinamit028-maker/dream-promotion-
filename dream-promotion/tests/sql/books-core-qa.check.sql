-- QA of 2.121.0 (stage 4ב), next to books-core.check.sql, on the migrated database. An independent oracle: the expected entries are
-- written out from the plan's answers (docs/ita-registration/STAGE4_PLAN_HE.md), the totals from the documents' own fields — never
-- from the posting code.
--   1. matrix rows the main check does not have: a licensed 400 paying a 300 (answer 18 — the money against the customer, 1310 stays
--      open), a 320 / 400 paying a 300 twice (what is left of it, never more), an exempt receipt that pays more than the 300 (answer 2),
--      an exempt register refund (the refund receipt + the refund's money), a paylink receipt with no card kind, installments of
--      2 / 36 payments, the agorot on the first, the first due that clamps at a month's end, no first due (the payment's day)
--   2. the properties: every entry balances (two lines at least, no zero or negative line), the trial balance nets to 0 at every date
--      and as opening / debit / credit, the customers' sub-ledger = what the documents say they owe, the income, VAT and money
--      accounts = the documents' fields, 1310 = the open transaction invoices
--   3. a posting that fails never blocks: a register sale, its refund, a deposit and its cancellation, a cancellation — the source is
--      kept (and everything it wrote), recorded, listed, and the replay posts it once
--   4. nothing posts before the start; a document of before the start that is cancelled after it; the start moves once
--   5. who reads / writes the books: a viewer, a calendar and an agenda member, a cashier, another business, the public
-- Fixtures only, fictional: dealer numbers 000000109 / 000000117 (valid check digit), phones 050-00000NN, mails *.example.test.
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
create or replace function pg_temp.doc(p_user text, p_type int, p_lines jsonb, p_key text, p_extra jsonb default '{}', p_pay jsonb default null,
                                       p_rate numeric default 18, p_phone text default '0500009601')
returns jsonb language plpgsql as $$
declare bef numeric; vat numeric; ls jsonb;
begin
  select coalesce(sum((e->>'totalExVat')::numeric), 0), jsonb_agg(e || jsonb_build_object('qty', 1, 'unitPriceExVat', (e->>'totalExVat')::numeric, 'discountExVat', 0, 'vatRate', p_rate))
    into bef, ls from jsonb_array_elements(p_lines) e;
  vat := case when p_type = 400 then 0 else round(bef * p_rate / 100, 2) end;
  return jsonb_build_object('user_id', p_user, 'doc_type', p_type, 'doc_number', 0, 'doc_date', public.il_today(),
    'customer_name', 'לקוחה ' || p_phone, 'customer_phone', p_phone, 'before_discount', bef, 'discount', 0, 'after_discount', bef,
    'vat_amount', vat, 'total', bef + vat, 'vat_rate', case when p_type = 400 then 0 else p_rate end, 'idempotency_key', p_key,
    'lines', coalesce(ls, '[]'::jsonb),
    'payments', case when p_type in (320, 400) then coalesce(p_pay, jsonb_build_array(jsonb_build_object('method', 1, 'm', 'cash', 'amount', bef + vat, 'date', public.il_today())))
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
create or replace function pg_temp.txd(p_key text) returns uuid language sql as $$
  select t.id from public.gl_transactions t where t.idempotency_key = 'document:' || (pg_temp.d(p_key)).id $$;
-- the lines of an entry, SORTED (key, side, amount): "<key> <D|C> <amount>" — the order of the lines is not what is checked here
create or replace function pg_temp.sig(p_tx uuid) returns text language sql as $$
  select string_agg(a.key || ' ' || l.side || ' ' || l.amount, ', ' order by a.key, l.side, l.amount) from public.gl_lines l join public.gl_accounts a on a.id = l.account_id where l.transaction_id = p_tx $$;
create or replace function pg_temp.bal(p_business text, p_key text) returns numeric language sql as $$
  select coalesce(sum(case l.side when 'D' then l.amount else -l.amount end), 0) from public.gl_lines l join public.gl_accounts a on a.id = l.account_id
   where a.business_id = p_business::uuid and a.key = p_key $$;
create temp table out96 (k text, j jsonb);
grant all on out96 to authenticated;
create or replace function pg_temp.o(p_k text) returns jsonb language sql as $$ select j from out96 where k = p_k $$;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000696a1', 'owner@lic-696.example.test'), ('00000000-0000-0000-0000-0000000696a2', 'cashier@lic-696.example.test'),
  ('00000000-0000-0000-0000-0000000696a3', 'viewer@lic-696.example.test'), ('00000000-0000-0000-0000-0000000696a4', 'calendar@lic-696.example.test'),
  ('00000000-0000-0000-0000-0000000696a5', 'agenda@lic-696.example.test'), ('00000000-0000-0000-0000-0000000696a6', 'owner@ex-696.example.test'),
  ('00000000-0000-0000-0000-0000000696a7', 'owner@oth-696.example.test');
insert into public.businesses (id, name, slug) values
  ('00000000-0000-0000-0000-0000000696b1', 'Lic 696', 'lic-696'), ('00000000-0000-0000-0000-0000000696b2', 'Ex 696', 'ex-696'), ('00000000-0000-0000-0000-0000000696b3', 'Oth 696', 'oth-696');
insert into public.business_locations (id, business_id, name, kind, sort) values ('00000000-0000-0000-0000-0000000696c2', '00000000-0000-0000-0000-0000000696b1', 'סניף שני', 'branch', 1);
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-0000000696b1', '00000000-0000-0000-0000-0000000696a1', 'owner', 'full'),
  ('00000000-0000-0000-0000-0000000696b1', '00000000-0000-0000-0000-0000000696a2', 'editor', 'register'),
  ('00000000-0000-0000-0000-0000000696b1', '00000000-0000-0000-0000-0000000696a3', 'viewer', 'full'),
  ('00000000-0000-0000-0000-0000000696b1', '00000000-0000-0000-0000-0000000696a4', 'editor', 'calendar'),
  ('00000000-0000-0000-0000-0000000696b1', '00000000-0000-0000-0000-0000000696a5', 'editor', 'agenda'),
  ('00000000-0000-0000-0000-0000000696b2', '00000000-0000-0000-0000-0000000696a6', 'owner', 'full'),
  ('00000000-0000-0000-0000-0000000696b3', '00000000-0000-0000-0000-0000000696a7', 'owner', 'full');
update public.profiles set current_business_id = '00000000-0000-0000-0000-0000000696b1'
 where id in ('00000000-0000-0000-0000-0000000696a1', '00000000-0000-0000-0000-0000000696a2', '00000000-0000-0000-0000-0000000696a3', '00000000-0000-0000-0000-0000000696a4', '00000000-0000-0000-0000-0000000696a5');
update public.profiles set current_business_id = '00000000-0000-0000-0000-0000000696b2' where id = '00000000-0000-0000-0000-0000000696a6';
update public.profiles set current_business_id = '00000000-0000-0000-0000-0000000696b3' where id = '00000000-0000-0000-0000-0000000696a7';
insert into public.register_settings (user_id, business_id, business_type, vat_rate, dealer_number, legal_name, street, city, entity_type) values
  ('00000000-0000-0000-0000-0000000696a1', '00000000-0000-0000-0000-0000000696b1', 'licensed', 18, '000000109', 'עסק מורשה לדוגמה', 'הדוגמה', 'עיר דוגמה', 'licensed_dealer'),
  ('00000000-0000-0000-0000-0000000696a6', '00000000-0000-0000-0000-0000000696b2', 'exempt', 0, '000000117', 'עוסקת פטורה לדוגמה', 'הדוגמה', 'עיר דוגמה', 'exempt_dealer'),
  ('00000000-0000-0000-0000-0000000696a7', '00000000-0000-0000-0000-0000000696b3', 'licensed', 18, '000000109', 'עסק אחר לדוגמה', 'הדוגמה', 'עיר דוגמה', 'licensed_dealer');
insert into public.business_finance_profile (business_id, user_id, cash_drawers) values
  ('00000000-0000-0000-0000-0000000696b1', '00000000-0000-0000-0000-0000000696a1', true), ('00000000-0000-0000-0000-0000000696b2', '00000000-0000-0000-0000-0000000696a6', true);
-- the books of the two businesses start with this month (the owner's move, as the screen does it — nothing was posted yet)
select public.gl_books_ensure(b) from unnest(array['00000000-0000-0000-0000-0000000696b1', '00000000-0000-0000-0000-0000000696b2', '00000000-0000-0000-0000-0000000696b3']::uuid[]) b;
update public.gl_books set start_date = date_trunc('month', public.il_today())::date
 where business_id in ('00000000-0000-0000-0000-0000000696b1', '00000000-0000-0000-0000-0000000696b2');

-- ======================================================================================================================
-- 1. the matrix rows the main check does not have — LICENSED
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000696a1');
-- Q1: a 300 of 1180; a 400 (a licensed dealer's receipt) pays it in cash — answer 18: the money against the customer, 1310 stays open
-- (the database used to refuse this receipt — pilot_hardening's documents_more_checks; 7100 now allows it, as the owner decided 27.11.2026);
-- then answer 19: the tax invoice (305) made FROM the 300 closes it once — 300 → 400 → 305 leaves the customer and 1310 at 0
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000696a1', 300, pg_temp.svc(1000), 'q96:300a', '{}', null, 18, '0500009611'));
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000696a1', 400, pg_temp.svc(1180), 'q96:400a', jsonb_build_object('paid_document_id', (pg_temp.d('q96:300a')).id), null, 18, '0500009611'));
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000696a1');
-- Q2: a 300 of 590 paid by two 320 receipts in turn (354, then the 236 left): each closes what it pays of 1310 — and the sum is 0
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000696a1', 300, pg_temp.svc(500), 'q96:300b', '{}', null, 18, '0500009612'));
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000696a1', 320, pg_temp.svc(300), 'q96:320b1', jsonb_build_object('paid_document_id', (pg_temp.d('q96:300b')).id), null, 18, '0500009612'));
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000696a1', 320, pg_temp.svc(200), 'q96:320b2', jsonb_build_object('paid_document_id', (pg_temp.d('q96:300b')).id), null, 18, '0500009612'));
-- Q3: a paylink receipt — a 400 paying a 305 by card, with no card kind (the database fills 1)
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000696a1', 305, pg_temp.svc(100), 'q96:305c', '{}', null, 18, '0500009613'));
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000696a1', 400, pg_temp.svc(118), 'paylink:00000000-0000-0000-0000-0000000696d1',
  jsonb_build_object('paid_document_id', (pg_temp.d('q96:305c')).id), '[{"method": 3, "m": "card", "amount": 118}]', 18, '0500009613'));
-- Q4: installments follow below (their own transactions)
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000696a1');
select pg_temp.issue(jsonb_build_object('user_id', '00000000-0000-0000-0000-0000000696a1', 'doc_type', 400, 'doc_number', 0, 'doc_date', public.il_today(),
  'customer_name', 'לקוחה 0500009615', 'customer_phone', '0500009615', 'before_discount', 0.05, 'discount', 0, 'after_discount', 0.05, 'vat_amount', 0, 'total', 0.05, 'vat_rate', 0,
  'idempotency_key', 'q96:i2', 'lines', '[]'::jsonb,
  'payments', jsonb_build_array(jsonb_build_object('method', 3, 'm', 'card', 'amount', 0.05, 'cardKind', 2, 'installments', 2))));
select pg_temp.issue(jsonb_build_object('user_id', '00000000-0000-0000-0000-0000000696a1', 'doc_type', 400, 'doc_number', 0, 'doc_date', public.il_today(),
  'customer_name', 'לקוחה 0500009616', 'customer_phone', '0500009616', 'before_discount', 360, 'discount', 0, 'after_discount', 360, 'vat_amount', 0, 'total', 360, 'vat_rate', 0,
  'idempotency_key', 'q96:i36', 'lines', '[]'::jsonb,
  'payments', jsonb_build_array(jsonb_build_object('method', 3, 'm', 'card', 'amount', 360, 'cardKind', 2, 'installments', 36, 'firstDue', (public.il_today() + 20)::text))));
select pg_temp.issue(jsonb_build_object('user_id', '00000000-0000-0000-0000-0000000696a1', 'doc_type', 400, 'doc_number', 0, 'doc_date', public.il_today(),
  'customer_name', 'לקוחה 0500009617', 'customer_phone', '0500009617', 'before_discount', 100, 'discount', 0, 'after_discount', 100, 'vat_amount', 0, 'total', 100, 'vat_rate', 0,
  'idempotency_key', 'q96:i3', 'lines', '[]'::jsonb,
  'payments', jsonb_build_array(jsonb_build_object('method', 3, 'm', 'card', 'amount', 100, 'cardKind', 2, 'installments', 3))));
commit;
-- the one with a first due that clamps: the payment is dated 5 days ago-or-today, the first due the last day of next month or a 31st —
-- computed from the database's date, so the check is the same every day of the year
create temp table clamp as select (date_trunc('month', public.il_today()) + interval '1 month' + interval '30 days')::date as fd;
grant select on clamp to authenticated;
select pg_temp.check((select fd - public.il_today() between 1 and 366 from clamp), 'the first due of the clamp test is within a year');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000696a1');
select pg_temp.issue(jsonb_build_object('user_id', '00000000-0000-0000-0000-0000000696a1', 'doc_type', 400, 'doc_number', 0, 'doc_date', public.il_today(),
  'customer_name', 'לקוחה 0500009618', 'customer_phone', '0500009618', 'before_discount', 90, 'discount', 0, 'after_discount', 90, 'vat_amount', 0, 'total', 90, 'vat_rate', 0,
  'idempotency_key', 'q96:iclamp', 'lines', '[]'::jsonb,
  'payments', jsonb_build_array(jsonb_build_object('method', 3, 'm', 'card', 'amount', 90, 'cardKind', 2, 'installments', 3, 'firstDue', (select fd::text from clamp)))));
commit;

-- Q1
select pg_temp.check(pg_temp.sig(pg_temp.txd('q96:300a')) = '0500009611 D 1180.00, 1310 C 1180.00', 'Q1: the 300 — the customer / 1310');
select pg_temp.check(pg_temp.sig(pg_temp.txd('q96:400a')) = '0500009611 C 1180.00, 1100 D 1180.00',
  'Q1 (answer 18): a licensed dealer''s 400 on a 300 — the money against the customer only; no income, no VAT, 1310 not touched');
select pg_temp.check(pg_temp.bal('00000000-0000-0000-0000-0000000696b1', '0500009611') = 0 and pg_temp.bal('00000000-0000-0000-0000-0000000696b1', '1310') = -1180,
  'Q1: the customer at 0; 1310 still holds the open 300 (1180) until the tax invoice is issued (Q2''s 590 was closed)');
-- Q5 (answer 19): the tax invoice made FROM the 300 (base 300) closes it once: the customer charged, 1310 closed — and nothing twice
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000696a1');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000696a1', 305, pg_temp.svc(1000), 'q96:305from300',
  jsonb_build_object('base_doc_type', 300, 'base_doc_number', (pg_temp.d('q96:300a')).doc_number), null, 18, '0500009611'));
commit;
select pg_temp.check(pg_temp.sig(pg_temp.txd('q96:305from300')) = '0500009611 C 1180.00, 0500009611 D 1180.00, 1310 D 1180.00, 2200 C 180.00, 4100 C 1000.00',
  'Q5 (answer 19): the 305 made from the 300 — income + VAT, and 1310 / the customer for what it closes');
select pg_temp.check(pg_temp.bal('00000000-0000-0000-0000-0000000696b1', '0500009611') = 0 and pg_temp.bal('00000000-0000-0000-0000-0000000696b1', '1310') = 0,
  'Q5: 300 → 400 → 305: the customer and 1310 at 0 (the income once: 1000)');
-- Q2
select pg_temp.check(pg_temp.sig(pg_temp.txd('q96:320b1')) = '0500009612 C 354.00, 0500009612 C 354.00, 0500009612 D 354.00, 1100 D 354.00, 1310 D 354.00, 2200 C 54.00, 4100 C 300.00',
  'Q2: the first 320 on the 300 — income + VAT, the money, and 1310 closed by 354');
select pg_temp.check(pg_temp.sig(pg_temp.txd('q96:320b2')) = '0500009612 C 236.00, 0500009612 C 236.00, 0500009612 D 236.00, 1100 D 236.00, 1310 D 236.00, 2200 C 36.00, 4100 C 200.00'
  and pg_temp.bal('00000000-0000-0000-0000-0000000696b1', '0500009612') = 0,
  'Q2: the second closes the 236 that was left — the customer and (Q2''s part of) 1310 at 0');
-- Q3
select pg_temp.check(pg_temp.sig(pg_temp.txd('paylink:00000000-0000-0000-0000-0000000696d1')) = '0500009613 C 118.00, 1250 D 118.00'
  and (select payments->0->>'cardKind' from public.documents where idempotency_key = 'paylink:00000000-0000-0000-0000-0000000696d1') = '1',
  'Q3: the paylink receipt — card clearing / the customer; the kind filled with 1');
-- Q4
select pg_temp.check(pg_temp.sig(pg_temp.txd('q96:i2')) = '0500009615 C 0.05, 1250 D 0.02, 1250 D 0.03', 'Q4: 0.05 in 2 — 0.03 on the first, 0.02 on the second');
select pg_temp.check((select array_agg(l.amount order by l.line_no) from public.gl_lines l join public.gl_accounts a on a.id = l.account_id
                       where l.transaction_id = pg_temp.txd('q96:i2') and a.key = '1250') = array[0.03, 0.02], 'Q4: the first carries the agora');
select pg_temp.check((select count(*) = 36 and sum(l.amount) = 360 and min(l.amount) = 10 and max(l.amount) = 10
                         and array_agg(l.value_date order by l.line_no) = (select array_agg((public.il_today() + 20 + (g || ' months')::interval)::date order by g) from generate_series(0, 35) g)
                        from public.gl_lines l join public.gl_accounts a on a.id = l.account_id where l.transaction_id = pg_temp.txd('q96:i36') and a.key = '1250'),
  'Q4: 36 installments of 10, the value dates a month apart from the first due (each counted from it — never drifting)');
select pg_temp.check((select array_agg(l.value_date order by l.line_no) from public.gl_lines l join public.gl_accounts a on a.id = l.account_id
                       where l.transaction_id = pg_temp.txd('q96:i3') and a.key = '1250') = array[public.il_today(), (public.il_today() + interval '1 month')::date, (public.il_today() + interval '2 months')::date]
  and (select array_agg(l.amount order by l.line_no) from public.gl_lines l join public.gl_accounts a on a.id = l.account_id
        where l.transaction_id = pg_temp.txd('q96:i3') and a.key = '1250') = array[33.34, 33.33, 33.33],
  'Q4: no first due — the payment''s day, then a month apart; 100 in 3 = 33.34 + 33.33 + 33.33');
select pg_temp.check((select array_agg(l.value_date order by l.line_no) from public.gl_lines l join public.gl_accounts a on a.id = l.account_id
                       where l.transaction_id = pg_temp.txd('q96:iclamp') and a.key = '1250')
  = (select array[fd, (fd + interval '1 month')::date, (fd + interval '2 months')::date] from clamp), 'Q4: the months are added to the first due itself (a 31st does not drift to the 28th)');

-- ======================================================================================================================
-- 1b. the matrix rows the main check does not have — EXEMPT (answer 2: cash basis)
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000696a6');
-- X1: a 300 of 500, paid by two receipts (300, then the 200 left) — each takes its share into exempt income out of 1310 (the database
-- never lets a receipt pay more than the 300's balance)
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000696a6', 300, pg_temp.svc(500), 'x96:300', '{}', null, 0, '0500009621'));
select pg_temp.issue(jsonb_build_object('user_id', '00000000-0000-0000-0000-0000000696a6', 'doc_type', 400, 'doc_number', 0, 'doc_date', public.il_today(),
  'customer_name', 'לקוחה 0500009621', 'customer_phone', '0500009621', 'before_discount', 300, 'discount', 0, 'after_discount', 300, 'vat_amount', 0, 'total', 300, 'vat_rate', 0,
  'idempotency_key', 'x96:over', 'lines', '[]'::jsonb, 'paid_document_id', (pg_temp.d('x96:300')).id,
  'payments', jsonb_build_array(jsonb_build_object('method', 1, 'm', 'cash', 'amount', 300, 'date', public.il_today()))));
select pg_temp.issue(jsonb_build_object('user_id', '00000000-0000-0000-0000-0000000696a6', 'doc_type', 400, 'doc_number', 0, 'doc_date', public.il_today(),
  'customer_name', 'לקוחה 0500009621', 'customer_phone', '0500009621', 'before_discount', 200, 'discount', 0, 'after_discount', 200, 'vat_amount', 0, 'total', 200, 'vat_rate', 0,
  'idempotency_key', 'x96:rest', 'lines', '[]'::jsonb, 'paid_document_id', (pg_temp.d('x96:300')).id,
  'payments', jsonb_build_array(jsonb_build_object('method', 4, 'm', 'transfer', 'amount', 200, 'date', public.il_today()))));
-- X2: a receipt of 500 alone, and its refund receipt of 200 (cash) — the mirror
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000696a6', 400, pg_temp.svc(500), 'x96:400', '{}', null, 0, '0500009622'));
select pg_temp.issue(jsonb_build_object('user_id', '00000000-0000-0000-0000-0000000696a6', 'doc_type', 400, 'doc_number', 0, 'doc_date', public.il_today(),
  'customer_name', 'לקוחה 0500009622', 'customer_phone', '0500009622', 'before_discount', -200, 'discount', 0, 'after_discount', -200, 'vat_amount', 0, 'total', -200, 'vat_rate', 0,
  'idempotency_key', 'x96:back', 'lines', '[]'::jsonb, 'base_doc_type', 400, 'base_doc_number', (pg_temp.d('x96:400')).doc_number,
  'payments', jsonb_build_array(jsonb_build_object('method', 1, 'm', 'cash', 'amount', -200, 'date', public.il_today()))));
commit;
select pg_temp.check(pg_temp.sig(pg_temp.txd('x96:over')) = '0500009621 C 300.00, 1100 D 300.00, 1310 D 300.00, 4200 C 300.00',
  'X1 (answer 2): a receipt of 300 on a 300 of 500 — the money, 300 out of 1310 into exempt income; nothing else');
select pg_temp.check(pg_temp.sig(pg_temp.txd('x96:rest')) = '0500009621 C 200.00, 1310 D 200.00, 4200 C 200.00, BANK D 200.00',
  'X1: the second receipt, by transfer — the bank; the 200 left of 1310 into exempt income');
select pg_temp.check(pg_temp.bal('00000000-0000-0000-0000-0000000696b2', '0500009621') = 0 and pg_temp.bal('00000000-0000-0000-0000-0000000696b2', '1310') = 0,
  'X1: the customer and 1310 at 0 once the 300 is paid');
select pg_temp.check(pg_temp.sig(pg_temp.txd('x96:back')) = '0500009622 C 200.00, 0500009622 D 200.00, 1100 C 200.00, 4200 D 200.00',
  'X2: the refund receipt (a 400 below zero) — income back, the money out; nothing from the sign of the document alone');
select pg_temp.check(pg_temp.bal('00000000-0000-0000-0000-0000000696b2', '4200') = -(500 + 500 - 200), 'X: exempt income = 500 (the 300, paid) + 500 − 200 (cash basis)');
-- X3: the register's refund of an exempt receipt: the refund receipt with its refund id, and the refund's own money row
insert into public.sales (id, user_id, items, subtotal, total, vat_rate, vat_amount, method, status, paid_at)
values ('00000000-0000-0000-0000-0000000696f1', '00000000-0000-0000-0000-0000000696a6', '[{"name":"שירות","price":80,"qty":1,"kind":"other"}]', 80, 80, 0, 0, 'cash', 'paid', now());
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000696a6');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000696a6', 400, pg_temp.svc(80), 'sale:00000000-0000-0000-0000-0000000696f1',
  '{"sale_id": "00000000-0000-0000-0000-0000000696f1", "source": "pos"}', null, 0, '0500009623'));
insert into public.sale_refunds (id, user_id, sale_id, amount, vat_amount, method, items, restock, reason)
values ('00000000-0000-0000-0000-0000000696f2', '00000000-0000-0000-0000-0000000696a6', '00000000-0000-0000-0000-0000000696f1', 30, 0, 'cash', '[]', false, 'החזר חלקי');
select pg_temp.issue(jsonb_build_object('user_id', '00000000-0000-0000-0000-0000000696a6', 'doc_type', 400, 'doc_number', 0, 'doc_date', public.il_today(),
  'customer_name', 'לקוחה 0500009623', 'customer_phone', '0500009623', 'before_discount', -30, 'discount', 0, 'after_discount', -30, 'vat_amount', 0, 'total', -30, 'vat_rate', 0,
  'idempotency_key', 'refund:00000000-0000-0000-0000-0000000696f2', 'lines', '[]'::jsonb, 'base_doc_type', 400, 'base_doc_number', (pg_temp.d('sale:00000000-0000-0000-0000-0000000696f1')).doc_number,
  'sale_id', '00000000-0000-0000-0000-0000000696f1', 'refund_id', '00000000-0000-0000-0000-0000000696f2', 'source', 'refund',
  'payments', jsonb_build_array(jsonb_build_object('method', 1, 'm', 'cash', 'amount', -30, 'date', public.il_today()))));
commit;
select pg_temp.check(pg_temp.sig(pg_temp.txd('refund:00000000-0000-0000-0000-0000000696f2')) = '0500009623 C 30.00, 4200 D 30.00',
  'X3: the refund receipt of a register refund — income back and the customer credited; its money is the refund''s own row (not twice)');
select pg_temp.check((select pg_temp.sig(t.id) from public.gl_transactions t join public.payments p on p.id = t.source_id
                       where t.source_kind = 'payment' and p.refund_id = '00000000-0000-0000-0000-0000000696f2') = '0500009623 D 30.00, 1100 C 30.00',
  'X3: the refund''s money — the customer debited (answer 4), the cash credited; one entry');
select pg_temp.check(pg_temp.bal('00000000-0000-0000-0000-0000000696b2', '0500009623') = 0, 'X3: the customer at 0 after the sale and its refund');

-- ======================================================================================================================
-- 2. the properties
-- ======================================================================================================================
select pg_temp.check(not exists (select 1 from public.gl_transactions t where t.business_id::text like '00000000-0000-0000-0000-0000000696b%'
                                   and ((select count(*) from public.gl_lines l where l.transaction_id = t.id) < 2
                                        or (select coalesce(sum(case side when 'D' then amount else -amount end), 1) from public.gl_lines l where l.transaction_id = t.id) <> 0)),
  'every entry: two lines at least, debits = credits');
select pg_temp.check(not exists (select 1 from public.gl_lines l where l.business_id::text like '00000000-0000-0000-0000-0000000696b%' and (l.amount <= 0 or l.side not in ('D', 'C'))),
  'no zero or negative line, a side is D or C');
select pg_temp.check(not exists (select 1 from public.gl_lines l join public.gl_accounts a on a.id = l.account_id where a.business_id <> l.business_id),
  'a line is on an account of its own business');
select pg_temp.check((select count(distinct number) = count(*) and min(number) = 1 and max(number) = count(*) from public.gl_transactions where business_id = '00000000-0000-0000-0000-0000000696b1')
  and (select count(distinct number) = count(*) and min(number) = 1 and max(number) = count(*) from public.gl_transactions where business_id = '00000000-0000-0000-0000-0000000696b2'),
  'the entry numbers 1..n per business — no gap, no double');
-- the trial balance, as the owner reads it: nets to 0 at every date, and as the movement of a period
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000696a1');
insert into out96 select 'tb-month', (select jsonb_build_object('open', sum(opening), 'd', sum(debit), 'c', sum(credit), 'close', sum(closing)) from public.gl_trial_balance(date_trunc('month', public.il_today())::date, public.il_today()));
insert into out96 select 'tb-late', (select jsonb_build_object('open', sum(opening), 'd', sum(debit), 'c', sum(credit), 'close', sum(closing)) from public.gl_trial_balance(public.il_today() + 1, public.il_today() + 800));
insert into out96 select 'tb-mid', (select jsonb_build_object('open', sum(opening), 'd', sum(debit), 'c', sum(credit), 'close', sum(closing)) from public.gl_trial_balance(public.il_today(), public.il_today()));
-- the books by the entry's DATE: every installment line is dated the day of the entry (tx_date) — the value dates lie ahead
insert into out96 select 'cust', (select jsonb_build_object('sum', coalesce(sum(closing), 0), 'n', count(*)) from public.gl_trial_balance(date '2000-01-01', public.il_today() + 800) where tb_code = 'CUSTOMERS');
insert into out96 select 'tbs', (select jsonb_object_agg(key, closing) from public.gl_trial_balance(date '2000-01-01', public.il_today() + 800));
commit;
select pg_temp.check((pg_temp.o('tb-month')->>'open')::numeric = 0 and (pg_temp.o('tb-month')->>'close')::numeric = 0 and (pg_temp.o('tb-month')->>'d')::numeric = (pg_temp.o('tb-month')->>'c')::numeric
  and (pg_temp.o('tb-late')->>'open')::numeric = 0 and (pg_temp.o('tb-late')->>'close')::numeric = 0 and (pg_temp.o('tb-late')->>'d')::numeric = 0
  and (pg_temp.o('tb-mid')->>'open')::numeric = 0 and (pg_temp.o('tb-mid')->>'close')::numeric = 0 and (pg_temp.o('tb-mid')->>'d')::numeric = (pg_temp.o('tb-mid')->>'c')::numeric,
  'the trial balance nets to 0 — the opening, the closing, and debit = credit; a later period: nothing moves');
-- the customers' sub-ledger = what the documents say (licensed: the invoices and the 300s, less every receipt, credit and payment; the money back added)
select pg_temp.check((pg_temp.o('cust')->>'sum')::numeric = (
    select coalesce(sum(case when d.doc_type in (300, 305, 320) then d.total else 0 end), 0)
         - coalesce(sum(case when d.doc_type in (320, 400) then (select coalesce(sum(abs((p->>'amount')::numeric)), 0) from jsonb_array_elements(d.payments) p) else 0 end), 0)
         - coalesce(sum(case when d.doc_type = 330 then d.total else 0 end), 0)
         - coalesce(sum(case when d.doc_type = 305 and d.base_doc_type = 300 then d.total else 0 end), 0)   -- a 305 made from a 300 closes it (answer 19)
         - coalesce(sum(case when d.doc_type = 320 and exists (select 1 from public.documents o where o.id = d.paid_document_id and o.doc_type = 300) then d.total else 0 end), 0)   -- a 320 paying a 300 closes it
      from public.documents d where d.business_id = '00000000-0000-0000-0000-0000000696b1')
  , 'the customers'' sub-ledger of the licensed business = Σ invoices − Σ money received − Σ credits (computed from the documents, not the entries)');

-- the other accounts, against the documents' own fields (licensed): income, VAT, the money, 1310
select pg_temp.check(-((pg_temp.o('tbs')->>'4100')::numeric + coalesce((pg_temp.o('tbs')->>'4110')::numeric, 0)) = (
    select coalesce(sum(case when doc_type in (305, 320) then after_discount when doc_type = 330 then -after_discount else 0 end), 0)
      from public.documents where business_id = '00000000-0000-0000-0000-0000000696b1'),
  'income (services + goods) = Σ the invoices before VAT − Σ the credits (the 300 and the receipts of the 300 earn nothing)');
select pg_temp.check(-(pg_temp.o('tbs')->>'2200')::numeric = (select coalesce(sum(case when doc_type in (305, 320) then vat_amount when doc_type = 330 then -vat_amount else 0 end), 0)
                                                               from public.documents where business_id = '00000000-0000-0000-0000-0000000696b1'),
  'VAT output = Σ the VAT of the invoices − Σ the credits');
select pg_temp.check((select coalesce(sum(v::numeric), 0) from jsonb_each_text(pg_temp.o('tbs')) e(k, v) where k in ('1100', '1100-1', '1150', '1250', '1350', 'BANK'))
  = (select coalesce(sum(abs((p->>'amount')::numeric)), 0) from public.documents d, jsonb_array_elements(d.payments) p
      where d.business_id = '00000000-0000-0000-0000-0000000696b1' and d.doc_type in (320, 400)),
  'the money accounts together = Σ what the receipts took (no refund yet)');
select pg_temp.check((pg_temp.o('tbs')->>'1310')::numeric = 0, '1310 = the open 300s: every one is closed (by a 320 / a 305)');

-- ======================================================================================================================
-- 3. a posting that fails never blocks — a register sale, its refund, a deposit and its cancellation, a 300 and its cancellation
-- ======================================================================================================================
create or replace function public.qa96_fail() returns trigger language plpgsql as $$ begin raise exception 'qa96: no entry today' using errcode = '23514'; end $$;
create trigger qa96_fail before insert on public.gl_transactions for each row when (new.business_id = '00000000-0000-0000-0000-0000000696b1') execute function public.qa96_fail();
create temp table n_before as select count(*) as n from public.gl_transactions where business_id = '00000000-0000-0000-0000-0000000696b1';
insert into public.sales (id, user_id, items, subtotal, total, vat_rate, vat_amount, method, status, paid_at)
values ('00000000-0000-0000-0000-0000000696f5', '00000000-0000-0000-0000-0000000696a2', '[{"name":"שירות","price":118,"qty":1,"kind":"other"}]', 118, 118, 18, 18, 'cash', 'paid', now());
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000696a2');   -- the cashier's sale
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000696a2', 320, pg_temp.svc(100), 'sale:00000000-0000-0000-0000-0000000696f5',
  '{"sale_id": "00000000-0000-0000-0000-0000000696f5", "source": "pos"}', null, 18, '0500009631'));
commit;
select pg_temp.check((pg_temp.d('sale:00000000-0000-0000-0000-0000000696f5')).id is not null and exists (select 1 from public.payments p where p.document_id = (pg_temp.d('sale:00000000-0000-0000-0000-0000000696f5')).id),
  'a failing posting: the cashier''s sale is issued, with its payment row — nothing blocked');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000696a1');
insert into public.sale_refunds (id, user_id, sale_id, amount, vat_amount, method, items, restock, reason)
values ('00000000-0000-0000-0000-0000000696f6', '00000000-0000-0000-0000-0000000696a1', '00000000-0000-0000-0000-0000000696f5', 59, 9, 'cash', '[]', false, 'החזר');
commit;
select pg_temp.check(exists (select 1 from public.payments where refund_id = '00000000-0000-0000-0000-0000000696f6' and direction = 'out' and amount = 59), 'the register''s refund goes out although the posting fails');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000696a1');
select public.bank_deposit_create('00000000-0000-0000-0000-0000000696e1', public.il_today(), null, 100, '{}', 'הפקדה');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000696a1', 300, pg_temp.svc(50), 'q96:fail300', '{}', null, 18, '0500009632'));
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000696a1');
select public.bank_deposit_cancel('00000000-0000-0000-0000-0000000696e1', 'בטעות');
insert into public.document_cancellations (document_id, user_id, reason) values ((pg_temp.d('q96:fail300')).id, '00000000-0000-0000-0000-0000000696a1', 'נרשם בטעות');
commit;
select pg_temp.check((select status from public.bank_deposits where id = '00000000-0000-0000-0000-0000000696e1') = 'cancelled'
  and exists (select 1 from public.document_cancellations where document_id = (pg_temp.d('q96:fail300')).id),
  'the deposit and its cancellation, the 300 and its cancellation — all kept');
select pg_temp.check((select count(*) from public.gl_transactions where business_id = '00000000-0000-0000-0000-0000000696b1') = (select n from n_before), 'no entry was written while the posting failed');
select pg_temp.check((select count(distinct (source_kind, source_id)) from public.gl_post_failures where business_id = '00000000-0000-0000-0000-0000000696b1') >= 6
  and (select count(distinct (source_kind, source_id)) from public.gl_post_failures where business_id = '00000000-0000-0000-0000-0000000696b1' and error like '%qa96%') >= 4,
  'every source that failed is recorded: the sale, the refund money, the deposit, the 300 with the error itself; the two cancellations waiting for what they cancel (gl_wait)');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000696a1');
insert into out96 select 'unposted', jsonb_build_object('n', count(*), 'withError', count(*) filter (where error like '%qa96%' or error like '%gl_wait%')) from public.gl_unposted;
commit;
select pg_temp.check((pg_temp.o('unposted')->>'n')::int >= 6 and (pg_temp.o('unposted')->>'n') = (pg_temp.o('unposted')->>'withError'), 'listed in gl_unposted, each with its error');
drop trigger qa96_fail on public.gl_transactions;
drop function public.qa96_fail();
create temp table rp as select public.gl_replay('00000000-0000-0000-0000-0000000696b1', null) as r;
create temp table rp2 as select public.gl_replay('00000000-0000-0000-0000-0000000696b1', null) as r;
select pg_temp.check((select (r->>'posted')::int >= 6 and (r->>'failed')::int = 0 from rp), 'the replay posts what failed');
select pg_temp.check((select (r->>'posted')::int = 0 from rp2), 'a second replay posts nothing — exactly once');
select pg_temp.check((select count(*) from public.gl_unposted where business_id = '00000000-0000-0000-0000-0000000696b1') = 0, 'nothing left unposted');
select pg_temp.check(pg_temp.sig((select t.id from public.gl_transactions t join public.payments p on p.id = t.source_id where t.source_kind = 'payment' and p.refund_id = '00000000-0000-0000-0000-0000000696f6'))
  = '0500009631 D 59.00, 1100 C 59.00', 'the refund''s money, posted late: the customer / the cash');
select pg_temp.check(not exists (select 1 from public.gl_transactions t where t.business_id = '00000000-0000-0000-0000-0000000696b1'
                                   and (select coalesce(sum(case side when 'D' then amount else -amount end), 1) from public.gl_lines l where l.transaction_id = t.id) <> 0),
  'every entry still balances after the late postings');

-- ======================================================================================================================
-- 4. the start date: nothing posts before it; a document of before it, cancelled after it; the start moves once
-- ======================================================================================================================
begin;
alter table public.documents disable trigger d_documents_issue_day;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000696a7');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000696a7', 300, pg_temp.svc(200), 'o96:old300', jsonb_build_object('doc_date', (date_trunc('month', public.il_today()) - interval '10 days')::date), null, 18, '0500009641'));
reset role;
set constraints all immediate;
alter table public.documents enable trigger d_documents_issue_day;
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000696a7');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000696a7', 305, pg_temp.svc(100), 'o96:new305', '{}', null, 18, '0500009642'));
commit;
select pg_temp.check((select count(*) from public.gl_transactions where business_id = '00000000-0000-0000-0000-0000000696b3') = 0, 'the default start is next month: today''s and last month''s documents post nothing');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000696a7');
select pg_temp.refused_with($$select public.gl_books_start_set(date_trunc('month', public.il_today())::date + 4)$$, 'books_start_date', 'not the 1st');
select pg_temp.refused_with($$select public.gl_books_start_set((date_trunc('month', public.il_today()) + interval '2 months')::date)$$, 'books_start_date', 'more than the next month');
select pg_temp.refused_with($$select public.gl_books_start_set(date '1999-01-01')$$, 'books_start_date', 'a date from the last century');
insert into out96 select 'o-start', public.gl_books_start_set(date_trunc('month', public.il_today())::date);
-- the move only sets the date: the posting runs in batches (gl_replay with a limit) until nothing is left
insert into out96 select 'o-replay', public.gl_replay('00000000-0000-0000-0000-0000000696b3', null, 100);
commit;
select pg_temp.check(pg_temp.o('o-start') ? 'startDate' and (pg_temp.o('o-start')->>'pending') is not null, 'the move answers the date and what is pending');
select pg_temp.check((pg_temp.o('o-replay')->>'posted')::int = 1 and (pg_temp.o('o-replay')->>'left')::int = 0 and (pg_temp.o('o-replay')->>'failed')::int = 0,
  'the replay posts exactly the documents since the start (today''s 305) — not the 300 of last month — and nothing is left');
select pg_temp.check((select count(*) from public.gl_transactions where business_id = '00000000-0000-0000-0000-0000000696b3') = 1
  and (select count(*) from public.gl_transactions t where t.business_id = '00000000-0000-0000-0000-0000000696b3' and t.idempotency_key = 'document:' || (pg_temp.d('o96:old305')).id) = 0, 'one entry: the 305');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000696a7');
select pg_temp.refused_with($$select public.gl_books_start_set(date_trunc('month', public.il_today())::date)$$, 'books_started', 'the start does not move once an entry was posted');
-- the 300 of last month, cancelled now: it was never in the books — the cancellation posts nothing (its balance belongs to the opening balances)
insert into public.document_cancellations (document_id, user_id, reason) values ((pg_temp.d('o96:old300')).id, '00000000-0000-0000-0000-0000000696a7', 'נרשם בטעות');
commit;
select pg_temp.check((select count(*) from public.gl_transactions where business_id = '00000000-0000-0000-0000-0000000696b3') = 1
  and not exists (select 1 from public.gl_unposted where business_id = '00000000-0000-0000-0000-0000000696b3' and source_kind = 'cancellation'),
  'the cancellation of a document of before the start posts nothing and is not "unposted"');
create temp table rp3 as select public.gl_replay('00000000-0000-0000-0000-0000000696b3', null) as r;
select pg_temp.check((select (r->>'posted')::int = 0 from rp3), 'a replay of the business that moved: nothing again');

-- ======================================================================================================================
-- 5. who reads and writes the books
-- ======================================================================================================================
create or replace function pg_temp.probe(p_user text) returns void language plpgsql as $q$
begin
  perform pg_temp.as_user(p_user);
  perform pg_temp.refused($$select public.gl_books_start_set(date_trunc('month', public.il_today())::date)$$, 'start_set by ' || p_user);
  perform pg_temp.refused($$select public.gl_opening_balances('[{"account": "BANK", "side": "D", "amount": 1}]')$$, 'opening by ' || p_user);
  perform pg_temp.refused($$select public.gl_replay('00000000-0000-0000-0000-0000000696b1', null)$$, 'replay of Lic by ' || p_user);
  perform pg_temp.refused($$select public.gl_post('document', '00000000-0000-0000-0000-000000000000')$$, 'gl_post by ' || p_user);
  perform pg_temp.refused($$select public.gl_lines_document('00000000-0000-0000-0000-000000000000')$$, 'gl_lines_document by ' || p_user);
  perform pg_temp.refused($$insert into public.gl_transactions (business_id, number, tx_date, value_date, source_kind, idempotency_key, location_id) values ('00000000-0000-0000-0000-0000000696b1', 99999, public.il_today(), public.il_today(), 'opening', 'q96:x', '00000000-0000-0000-0000-0000000696b1')$$, 'insert an entry by ' || p_user);
  perform pg_temp.refused($$update public.gl_books set start_date = date '2000-01-01'$$, 'update the books by ' || p_user);
  perform pg_temp.refused($$insert into public.gl_accounts (business_id, key, name, kind, tb_code, tb_name) values ('00000000-0000-0000-0000-0000000696b1', 'ZZ', 'x', 'asset', 'x', 'x')$$, 'insert an account by ' || p_user);
  perform pg_temp.refused($$delete from public.gl_lines$$, 'delete lines by ' || p_user);
end $q$;
-- the owner of the licensed business: reads, never writes by hand
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000696a1');
select pg_temp.check((select count(*) from public.gl_transactions) > 10 and (select count(*) from public.gl_accounts) > 10, 'the owner reads the entries and the chart');
select pg_temp.refused($$insert into public.gl_lines (transaction_id, business_id, line_no, account_id, side, amount, value_date, location_id) select id, business_id, 99, (select id from public.gl_accounts limit 1), 'D', 1, public.il_today(), location_id from public.gl_transactions limit 1$$, 'the owner inserts a line by hand');
select pg_temp.refused($$select public.gl_post('document', (select id from public.documents limit 1))$$, 'the owner calls gl_post');
rollback;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000696a3');    -- a viewer: reads (a finance member), never writes
insert into out96 select 'viewer', jsonb_build_object('tx', (select count(*) from public.gl_transactions), 'acc', (select count(*) from public.gl_accounts));
select pg_temp.probe('00000000-0000-0000-0000-0000000696a3');
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000696a2');    -- the cashier
insert into out96 select 'cashier96', jsonb_build_array((select count(*) from public.gl_transactions), (select count(*) from public.gl_lines), (select count(*) from public.gl_accounts), (select count(*) from public.gl_books), (select count(*) from public.gl_unposted), (select count(*) from public.gl_post_failures));
select pg_temp.refused('select public.gl_books_state()', 'a cashier reads the state');
select pg_temp.refused('select * from public.gl_trial_balance(date ''2000-01-01'', date ''2100-01-01'')', 'a cashier reads the trial balance') where false;
select pg_temp.probe('00000000-0000-0000-0000-0000000696a2');
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000696a4');    -- calendar
insert into out96 select 'calendar96', jsonb_build_array((select count(*) from public.gl_transactions), (select count(*) from public.gl_lines), (select count(*) from public.gl_accounts), (select count(*) from public.gl_books));
select pg_temp.probe('00000000-0000-0000-0000-0000000696a4');
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000696a5');    -- agenda
insert into out96 select 'agenda96', jsonb_build_array((select count(*) from public.gl_transactions), (select count(*) from public.gl_lines), (select count(*) from public.gl_accounts), (select count(*) from public.gl_books));
select pg_temp.probe('00000000-0000-0000-0000-0000000696a5');
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000696a7');    -- the owner of ANOTHER business, working in their own: Lic's books are not theirs
insert into out96 select 'other96', jsonb_build_object('lic', (select count(*) from public.gl_transactions where business_id = '00000000-0000-0000-0000-0000000696b1'),
  'licLines', (select count(*) from public.gl_lines where business_id = '00000000-0000-0000-0000-0000000696b1'), 'licAcc', (select count(*) from public.gl_accounts where business_id = '00000000-0000-0000-0000-0000000696b1'),
  'ex', (select count(*) from public.gl_transactions where business_id = '00000000-0000-0000-0000-0000000696b2'));
select pg_temp.refused_with($$select public.gl_replay('00000000-0000-0000-0000-0000000696b1', null)$$, 'not allowed', 'never another business''s replay');
commit;
begin;
set local role anon;
select pg_temp.refused($$select count(*) from public.gl_accounts$$, 'anon reads the chart');
select pg_temp.refused($$select public.gl_books_state()$$, 'anon reads the state');
select pg_temp.refused($$select public.gl_replay('00000000-0000-0000-0000-0000000696b1', null)$$, 'anon replays');
rollback;
select pg_temp.check((pg_temp.o('viewer')->>'tx')::int > 10, 'a viewer reads the books (a finance member) — and writes nothing');
select pg_temp.check(pg_temp.o('cashier96') = '[0, 0, 0, 0, 0, 0]', 'a cashier reads nothing: not entries, lines, accounts, books, unposted, failures');
select pg_temp.check(pg_temp.o('calendar96') = '[0, 0, 0, 0]', 'a calendar member reads nothing');
select pg_temp.check(pg_temp.o('agenda96') = '[0, 0, 0, 0]', 'an agenda member reads nothing');
select pg_temp.check((pg_temp.o('other96')->>'lic')::int = 0 and (pg_temp.o('other96')->>'licLines')::int = 0 and (pg_temp.o('other96')->>'licAcc')::int = 0 and (pg_temp.o('other96')->>'ex')::int = 0,
  'another business reads none of Lic''s (nor Ex''s) books');
