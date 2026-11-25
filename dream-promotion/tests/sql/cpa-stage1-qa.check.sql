-- QA of 2.118.0 (stage 1 of the accountant's answers): gaps next to cpa-rules-stage1.check.sql, on the migrated database.
--   1. a cashier can not issue a refund receipt of a receipt that is not from the sale he refunds (another sale's receipt, with his sale_id)
--      — and the refusal tells no number, amount or state
--   2. the register's / the money screens' "complete the missing refund receipt" (DocView) can never make a second one: the same key
--      twice (cancel:<sale>, refund:<refund id>) is one document, one money-out, one number; a second tab with a stale view too
-- Fixtures only, fictional: dealer number 000000018, mails *.example.test.
\set ON_ERROR_STOP 1
set client_min_messages = warning;

create or replace function pg_temp.check(ok boolean, msg text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'CHECK FAILED: %', msg; end if; end $$;
-- refused with a message that contains the expected words (and, when given, the expected sqlstate)
create or replace function pg_temp.refused_with(stmt text, expect text, msg text, state text default null) returns void language plpgsql as $$
begin
  execute stmt;
  raise exception 'CHECK FAILED: % (it was allowed)', msg;
exception when others then
  if sqlerrm like 'CHECK FAILED%' then raise; end if;
  if position(expect in sqlerrm) = 0 then raise exception 'CHECK FAILED: % (refused, but with "%")', msg, sqlerrm; end if;
  if state is not null and sqlstate <> state then raise exception 'CHECK FAILED: % (refused, but with sqlstate % — "%")', msg, sqlstate, sqlerrm; end if;
end $$;
create or replace function pg_temp.as_user(uid text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', uid, true), set_config('request.jwt.claim.role', 'authenticated', true);
$$;
-- the message of a refused statement (null when it was allowed)
create or replace function pg_temp.refusal(stmt text) returns text language plpgsql as $$
begin execute stmt; return null; exception when others then return sqlerrm; end $$;
-- a document row the way the app sends it: one line; a receipt's payment in cash (the amount = the total)
create or replace function pg_temp.doc(p_user text, p_type int, p_before numeric, p_vat numeric, p_rate numeric, p_extra jsonb default '{}')
returns jsonb language sql as $$
  select jsonb_build_object('user_id', p_user, 'doc_type', p_type, 'doc_number', 0, 'doc_date', public.il_today(),
    'customer_name', 'לקוחה לדוגמה', 'before_discount', p_before, 'discount', 0, 'after_discount', p_before, 'vat_amount', p_vat,
    'total', p_before + p_vat, 'vat_rate', p_rate,
    'lines', jsonb_build_array(jsonb_build_object('name', 'טיפול', 'qty', 1, 'unitPriceExVat', p_before, 'discountExVat', 0, 'totalExVat', p_before, 'vatRate', p_rate, 'kind', 1)),
    'payments', case when p_type in (320, 400) then jsonb_build_array(jsonb_build_object('method', 1, 'amount', p_before + p_vat, 'date', public.il_today())) else '[]'::jsonb end)
    || p_extra;
$$;
create or replace function pg_temp.issue(r jsonb) returns uuid language plpgsql as $$
declare cols text; id uuid;
begin
  select string_agg(quote_ident(k), ', ') into cols from jsonb_object_keys(r) k;
  execute format('insert into public.documents (%s) select %s from jsonb_populate_record(null::public.documents, $1) returning id', cols, cols) using r into id;
  return id;
end $$;
create or replace function pg_temp.d(p_key text) returns uuid language sql as $$ select id from public.documents where idempotency_key = p_key $$;
create or replace function pg_temp.num(p_key text) returns int language sql as $$ select doc_number from public.documents where idempotency_key = p_key $$;
-- a refund receipt of E on the receipt p_base: one line, payments as given (default: cash, the whole amount)
create or replace function pg_temp.back(p_amount numeric, p_base text, p_extra jsonb default '{}') returns jsonb language sql as $$
  select pg_temp.doc('00000000-0000-0000-0000-0000000681e1', 400, -p_amount, 0, 0, jsonb_build_object(
    'base_doc_type', 400, 'base_doc_number', pg_temp.num(p_base),
    'lines', jsonb_build_array(jsonb_build_object('name', 'החזר', 'qty', 1, 'unitPriceExVat', -p_amount, 'discountExVat', 0, 'totalExVat', -p_amount, 'vatRate', 0, 'kind', 1)),
    'payments', jsonb_build_array(jsonb_build_object('method', 1, 'amount', -p_amount, 'date', public.il_today())))) || p_extra;
$$;
-- refused as a repeat of the same key: only by the unique key itself (documents_idempotency_uq, 23505) — documents_validate lets a
-- refund receipt whose key is already issued through unchecked (6800), so issueDocumentRow sees the duplicate and reads back the
-- receipt it issued; no rule (the ceiling, "one refund, one refund receipt") may answer first. Nothing is issued.
create or replace function pg_temp.refused_as_repeat(stmt text, msg text) returns void language plpgsql as $$
begin
  execute stmt;
  raise exception 'CHECK FAILED: % (it was allowed)', msg;
exception when others then
  if sqlerrm like 'CHECK FAILED%' then raise; end if;
  if sqlstate <> '23505' or position('documents_idempotency_uq' in sqlerrm) = 0 then
    raise exception 'CHECK FAILED: % (refused, but with % "%")', msg, sqlstate, sqlerrm; end if;
end $$;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000681e1', 'owner@exempt-681.example.test'), ('00000000-0000-0000-0000-0000000681e2', 'cashier@exempt-681.example.test');
insert into public.businesses (id, name, slug) values ('00000000-0000-0000-0000-0000000681b1', 'Exempt 681', 'exempt-681');
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-0000000681b1', '00000000-0000-0000-0000-0000000681e1', 'owner', 'full'),
  ('00000000-0000-0000-0000-0000000681b1', '00000000-0000-0000-0000-0000000681e2', 'editor', 'register');
update public.profiles set current_business_id = '00000000-0000-0000-0000-0000000681b1'
 where id in ('00000000-0000-0000-0000-0000000681e1', '00000000-0000-0000-0000-0000000681e2');
insert into public.register_settings (user_id, business_id, business_type, vat_rate, dealer_number, legal_name, street, city, entity_type) values
  ('00000000-0000-0000-0000-0000000681e1', '00000000-0000-0000-0000-0000000681b1', 'exempt', 0, '000000018', 'עוסקת פטורה לדוגמה', 'הדוגמה', 'עיר דוגמה', 'exempt_dealer');

-- two cancelled sales of the register (A, B), each with its receipt of 100, and a paid sale C with a refund of 30
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000681e1');
insert into public.sales (id, user_id, items, subtotal, total, vat_rate, vat_amount, method, status, paid_at)
select x, '00000000-0000-0000-0000-0000000681e1', '[{"name":"חבילה","price":100,"qty":1,"kind":"other"}]', 100, 100, 0, 0, 'cash', 'paid', now()
  from unnest(array['00000000-0000-0000-0000-00000006815a', '00000000-0000-0000-0000-00000006815b', '00000000-0000-0000-0000-00000006815c']::uuid[]) x;
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000681e1', 400, 100, 0, 0, jsonb_build_object('idempotency_key', 'sale:' || x, 'sale_id', x, 'source', 'pos')))
  from unnest(array['00000000-0000-0000-0000-00000006815a', '00000000-0000-0000-0000-00000006815b', '00000000-0000-0000-0000-00000006815c']) x;
update public.sales set status = 'cancelled' where id in ('00000000-0000-0000-0000-00000006815a', '00000000-0000-0000-0000-00000006815b');
insert into public.sale_refunds (id, user_id, sale_id, amount, vat_amount, method, items, restock, reason)
values ('00000000-0000-0000-0000-00000006816c', '00000000-0000-0000-0000-0000000681e1', '00000000-0000-0000-0000-00000006815c', 30, 0, 'cash', '[]', false, 'החזר חלקי');
commit;
create temp table n681 as select idempotency_key as k, doc_number as n from public.documents where business_id = '00000000-0000-0000-0000-0000000681b1';
grant select on n681 to authenticated;
create or replace function pg_temp.cb(p_amount numeric, p_base text, p_extra jsonb) returns jsonb language sql as $$
  select pg_temp.back(p_amount, p_base) || jsonb_build_object('user_id', '00000000-0000-0000-0000-0000000681e2', 'base_doc_number', (select n from n681 where k = p_base)) || p_extra;
$$;
-- (pg_temp.back above is E's of the other file: rebuilt here for this business)
create or replace function pg_temp.back(p_amount numeric, p_base text, p_extra jsonb default '{}') returns jsonb language sql as $$
  select pg_temp.doc('00000000-0000-0000-0000-0000000681e1', 400, -p_amount, 0, 0, jsonb_build_object(
    'base_doc_type', 400, 'base_doc_number', (select doc_number from public.documents where idempotency_key = p_base),
    'lines', jsonb_build_array(jsonb_build_object('name', 'החזר', 'qty', 1, 'unitPriceExVat', -p_amount, 'discountExVat', 0, 'totalExVat', -p_amount, 'vatRate', 0, 'kind', 1)),
    'payments', jsonb_build_array(jsonb_build_object('method', 1, 'amount', -p_amount, 'date', public.il_today())))) || p_extra;
$$;

-- 1. a cashier, sale A's id on the receipt of sale B (and the refund of C on the receipt of A): refused, telling nothing
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000681e2');
select pg_temp.check(public.my_access() = 'register', 'e2 is a cashier');
select pg_temp.check(pg_temp.refusal($$select pg_temp.issue(pg_temp.cb(100, 'sale:00000000-0000-0000-0000-00000006815b', '{"sale_id": "00000000-0000-0000-0000-00000006815a"}'))$$)
  ~ '^cashier_refund: [^0-9]*$', 'sale A''s id on the receipt of sale B: refused with no number');
select pg_temp.check(pg_temp.refusal($$select pg_temp.issue(pg_temp.cb(30, 'sale:00000000-0000-0000-0000-00000006815a', '{"refund_id": "00000000-0000-0000-0000-00000006816c", "sale_id": "00000000-0000-0000-0000-00000006815c"}'))$$)
  like 'cashier_refund:%', 'the refund of sale C on the receipt of sale A: refused');
select pg_temp.check(pg_temp.refusal($$select pg_temp.issue(pg_temp.cb(30, 'sale:00000000-0000-0000-0000-00000006815a', '{"refund_id": "00000000-0000-0000-0000-00000006816c"}'))$$)
  like 'cashier_refund:%', 'the refund of sale C (refund_id only) on the receipt of sale A: refused');
commit;
select pg_temp.check((select count(*) from public.documents where doc_type = 400 and total < 0 and business_id = '00000000-0000-0000-0000-0000000681b1') = 0,
  'nothing was issued by the refused attempts');
select pg_temp.check((select count(*) from public.payments where direction = 'out' and business_id = '00000000-0000-0000-0000-0000000681b1') = 1, 'only the refund of C moved money (30)');

-- 2. the same key twice: one document. The cancelled sale A: the cancel's refund receipt, twice (a double click / a second tab)
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000681e1');
select pg_temp.issue(pg_temp.back(100, 'sale:00000000-0000-0000-0000-00000006815a', '{"idempotency_key": "cancel:00000000-0000-0000-0000-00000006815a", "sale_id": "00000000-0000-0000-0000-00000006815a", "source": "refund"}'));
commit;
-- a second tab, stale view: the same document again — refused as a duplicate of the key (the app reads the first one back), and every
-- other try at the same sale is refused by the ceiling: 100 already went back
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000681e1');
select pg_temp.refused_as_repeat($$select pg_temp.issue(pg_temp.back(100, 'sale:00000000-0000-0000-0000-00000006815a', '{"idempotency_key": "cancel:00000000-0000-0000-0000-00000006815a", "sale_id": "00000000-0000-0000-0000-00000006815a", "source": "refund"}'))$$, 'the cancel receipt of sale A, twice (same key)');
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000681e1');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.back(100, 'sale:00000000-0000-0000-0000-00000006815a', '{"idempotency_key": "cancel:other-key", "sale_id": "00000000-0000-0000-0000-00000006815a", "source": "refund"}'))$$,
  'refund_receipt_over', 'a different key after the cancel: beyond the receipt');
commit;
select pg_temp.check((select count(*) from public.documents where idempotency_key = 'cancel:00000000-0000-0000-0000-00000006815a') = 1, 'one cancel receipt for sale A');
select pg_temp.check((select coalesce(sum(amount), 0) from public.payments where direction = 'out' and document_id = pg_temp.d('cancel:00000000-0000-0000-0000-00000006815a')) = 100, 'its money went out once');

-- the refund of sale C (30, no refund receipt yet): its refund receipt twice → one; the sale then cancelled: the cancel gets 70 only
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000681e1');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000681e1', 400, -30, 0, 0, jsonb_build_object('idempotency_key', 'refund:00000000-0000-0000-0000-00000006816c',
  'base_doc_type', 400, 'base_doc_number', (select doc_number from public.documents where idempotency_key = 'sale:00000000-0000-0000-0000-00000006815c'),
  'sale_id', '00000000-0000-0000-0000-00000006815c', 'refund_id', '00000000-0000-0000-0000-00000006816c', 'source', 'refund')));
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000681e1');
select pg_temp.refused_as_repeat($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000681e1', 400, -30, 0, 0, jsonb_build_object('idempotency_key', 'refund:00000000-0000-0000-0000-00000006816c',
  'base_doc_type', 400, 'base_doc_number', (select doc_number from public.documents where idempotency_key = 'sale:00000000-0000-0000-0000-00000006815c'),
  'sale_id', '00000000-0000-0000-0000-00000006815c', 'refund_id', '00000000-0000-0000-0000-00000006816c', 'source', 'refund')))$$, 'the refund receipt of a refund, twice (same key)');
commit;
-- the same refund with ANOTHER key (a client bug): never a second refund receipt for one refund
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000681e1');
select pg_temp.check(pg_temp.refusal($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000681e1', 400, -30, 0, 0, jsonb_build_object('idempotency_key', 'refund:again-' || gen_random_uuid(),
  'base_doc_type', 400, 'base_doc_number', (select doc_number from public.documents where idempotency_key = 'sale:00000000-0000-0000-0000-00000006815c'),
  'sale_id', '00000000-0000-0000-0000-00000006815c', 'refund_id', '00000000-0000-0000-0000-00000006816c', 'source', 'refund')))$$) is not null,
  'a second refund receipt for the same refund (another key) is refused');
commit;
select pg_temp.check((select count(*) from public.documents where refund_id = '00000000-0000-0000-0000-00000006816c') = 1, 'one refund receipt for the refund');
select pg_temp.check((select coalesce(sum(amount), 0) from public.payments where direction = 'out' and sale_id = '00000000-0000-0000-0000-00000006815c') = 30, 'the refund''s money out: 30, once');
