-- Dream Finance 2.51 on a real Postgres (tests/sql/run.sh): the accounting rules, the ledger, the audit chain and the
-- privacy rules — tried as the signed-in roles (authenticated + a JWT subject), never as the superuser.
-- Fixtures only (no production data): two businesses modelled on the real pair —
--   FollowMe  (company, VAT)  owner A — who is also the platform's super admin
--   SaGabot   (exempt dealer) owner S, cashier C
-- Every check raises "CHECK FAILED: …" when the database does not behave.
\set ON_ERROR_STOP 1
set client_min_messages = warning;

create or replace function pg_temp.check(ok boolean, msg text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'CHECK FAILED: %', msg; end if; end $$;
create or replace function pg_temp.refused(stmt text, msg text) returns void language plpgsql as $$
begin
  execute stmt;
  raise exception 'CHECK FAILED: % (it was allowed)', msg;
exception when others then
  if sqlerrm like 'CHECK FAILED%' then raise; end if;
end $$;
-- refused with a message that contains the expected words
create or replace function pg_temp.refused_with(stmt text, expect text, msg text) returns void language plpgsql as $$
begin
  execute stmt;
  raise exception 'CHECK FAILED: % (it was allowed)', msg;
exception when others then
  if sqlerrm like 'CHECK FAILED%' then raise; end if;
  if position(expect in sqlerrm) = 0 then raise exception 'CHECK FAILED: % (refused, but with "%")', msg, sqlerrm; end if;
end $$;
create or replace function pg_temp.affected(stmt text) returns int language plpgsql as $$
declare n int; begin execute stmt; get diagnostics n = row_count; return n; end $$;
create or replace function pg_temp.as_user(uid text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', uid, true), set_config('request.jwt.claim.role', 'authenticated', true);
$$;
-- a document row the way the app sends it (amounts in shekels; one line; payments for receipts)
create or replace function pg_temp.doc(p_user text, p_type int, p_before numeric, p_vat numeric, p_rate numeric, p_extra jsonb default '{}')
returns jsonb language sql as $$
  select jsonb_build_object('user_id', p_user, 'doc_type', p_type, 'doc_number', 0, 'doc_date', public.il_today(),
    'customer_name', 'לקוח בדיקה', 'before_discount', p_before, 'discount', 0, 'after_discount', p_before, 'vat_amount', p_vat,
    'total', p_before + p_vat, 'vat_rate', p_rate,
    'lines', jsonb_build_array(jsonb_build_object('name', 'שירות', 'qty', 1, 'unitPriceExVat', p_before, 'discountExVat', 0, 'totalExVat', p_before, 'vatRate', p_rate, 'kind', 1)),
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

-- ---- the world --------------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'aviv@followme.test'),
  ('00000000-0000-0000-0000-00000000000b', 'sagit@sagabot.test'),
  ('00000000-0000-0000-0000-00000000000c', 'cashier@sagabot.test');
update public.profiles set is_super_admin = true where id = '00000000-0000-0000-0000-00000000000a';
insert into public.businesses (id, name, slug) values
  ('00000000-0000-0000-0000-0000000f0001', 'FollowMe', 'followme-t'), ('00000000-0000-0000-0000-0000000f0002', 'SaGabot', 'sagabot-t');
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-00000000000a', 'owner', 'full'),
  ('00000000-0000-0000-0000-0000000f0002', '00000000-0000-0000-0000-00000000000b', 'owner', 'full'),
  ('00000000-0000-0000-0000-0000000f0002', '00000000-0000-0000-0000-00000000000c', 'editor', 'register');
update public.profiles set current_business_id = '00000000-0000-0000-0000-0000000f0001' where id = '00000000-0000-0000-0000-00000000000a';
insert into public.register_settings (user_id, business_id, business_type, vat_rate, dealer_number, legal_name, street, city, entity_type) values
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000f0001', 'licensed', 18, '514000004', 'פולו מי אופנה בע"מ', 'הרצל', 'תל אביב', 'company'),
  ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000f0002', 'licensed', 18, '123456782', 'שגית', 'הגפן', 'חיפה', 'exempt_dealer');
insert into public.catalog_items (id, user_id, business_id, name, price, kind, track_stock, stock_qty) values
  ('00000000-0000-0000-0000-0000000c0001', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000f0001', 'חולצה', 118, 'product', true, 10),
  ('00000000-0000-0000-0000-0000000c0002', '00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000f0002', 'קרם', 50, 'product', false, 0),
  ('00000000-0000-0000-0000-0000000c0003', '00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000f0002', 'שמפו', 40, 'product', true, 5);
insert into public.leads (id, user_id, business_id, name) values
  ('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000f0001', 'חנות לקוחה בע"מ'),
  ('00000000-0000-0000-0000-0000000d0002', '00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000f0002', 'דנה');

-- the entity keeps the register's switch in line: SaGabot asked for "licensed" but is an exempt dealer
select pg_temp.check((select business_type from public.register_settings where business_id = '00000000-0000-0000-0000-0000000f0002') = 'exempt',
  'an exempt dealer''s register switch follows the entity');

-- ======================================================================================================================
-- FollowMe (company, VAT): documents, rules, credits, receipts, receivables
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');

-- a tax invoice (305) to a business customer, due in 30 days
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000a', 305, 1000, 180, 18,
  jsonb_build_object('id', '00000000-0000-0000-0000-0000000a1001', 'customer_dealer', '514000012', 'lead_id', '00000000-0000-0000-0000-0000000d0001', 'due_date', public.il_today() + 30,
                     'idempotency_key', 'direct:inv-1', 'issuer', jsonb_build_object('name', 'זיוף'))));
select pg_temp.check((select doc_number from public.documents where idempotency_key = 'direct:inv-1') = 1, 'the first 305 is number 1');
select pg_temp.check((select issuer->>'name' from public.documents where idempotency_key = 'direct:inv-1') = 'פולו מי אופנה בע"מ', 'the issuer is the business, whatever the client sent');
select pg_temp.check((select issuer->>'entityType' from public.documents where idempotency_key = 'direct:inv-1') = 'company', 'the issuer snapshot keeps the entity');
select pg_temp.check((select source from public.documents where idempotency_key = 'direct:inv-1') = 'direct', 'a document from the document center is "direct"');
-- the same key again: refused, and the number it would have taken is not lost
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000a', 305, 1000, 180, 18, '{"idempotency_key":"direct:inv-1"}'))$$,
  'documents_idempotency_uq', 'one document per idempotency key');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000a', 305, 500, 90, 18, '{"idempotency_key":"direct:inv-2","id":"00000000-0000-0000-0000-0000000a1002"}'));
select pg_temp.check((select doc_number from public.documents where idempotency_key = 'direct:inv-2') = 2, 'a refused duplicate leaves no gap in the numbering');

-- the database checks every amount
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000a', 305, 1000, 170, 18))$$, 'VAT does not match', 'VAT of a different rate');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000a', 305, 1000, 180, 18, '{"total": 1200}'))$$, 'the total must equal', 'a total that does not add up');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000a', 305, 1000, 180, 18, '{"after_discount": 900}'))$$, 'after discount', 'after discount that does not add up');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000a', 305, 1000, 180, 18,
  '{"lines":[{"name":"a","qty":1,"totalExVat":999}]}'))$$, 'lines add up', 'lines that do not add up');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000a', 305, 1000, 180, 18, '{"lines":[]}'))$$, 'at least one line', 'an invoice without lines');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000a', 320, 100, 18, 18,
  '{"payments":[{"method":1,"amount":100}]}'))$$, 'paid but the document says', 'a receipt whose payments do not cover it');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000a', 305, 100, 18, 18,
  '{"payments":[{"method":1,"amount":118}]}'))$$, 'only a receipt', 'an invoice that lists payments');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000a', 400, 100, 18, 18))$$, 'no VAT', 'VAT on a receipt');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000a', 305, 100, 18, 18,
  jsonb_build_object('doc_date', public.il_today() + 5)))$$, 'future', 'a document dated next week');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000a', 320, 100, 18, 18,
  jsonb_build_object('doc_date', public.il_today() + 1, 'idempotency_key', 'clock-ahead')));
select pg_temp.check((select doc_date from public.documents where idempotency_key = 'clock-ahead') = public.il_today(), 'a client clock a little ahead is brought back to today');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000a', 305, 100, 18, 18,
  '{"due_date":"2000-01-01"}'))$$, 'due date is before', 'a due date before the document');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000a', 320, 100, 18, 18,
  '{"base_doc_type":305,"base_doc_number":1}'))$$, 'only a credit invoice', 'a base document on a non-credit');

-- a receipt (400) pays the 305 in two parts; the ledger and the receivables follow
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000a', 400, 700, 0, 0, jsonb_build_object(
  'paid_document_id', (select id from public.documents where idempotency_key = 'direct:inv-1'), 'lines', '[]'::jsonb, 'idempotency_key', 'rcpt-1',
  'payments', jsonb_build_array(jsonb_build_object('method', 4, 'amount', 500, 'date', public.il_today()),
                                jsonb_build_object('method', 2, 'amount', 200, 'date', public.il_today(), 'm', 'cheque',
                                  'cheque', jsonb_build_object('bank', '12', 'branch', '345', 'account', '678901', 'number', '1001', 'dueDate', public.il_today() + 30))))));
select pg_temp.check((select count(*) from public.payments where document_id = (select id from public.documents where idempotency_key = 'rcpt-1')) = 2, 'one ledger row per payment');
select pg_temp.check((select reference->>'number' from public.payments where method = 'cheque') = '1001', 'the cheque details are in the ledger');
select pg_temp.check((select source from public.documents where idempotency_key = 'rcpt-1') = 'receipt', 'a receipt for an invoice is a "receipt"');
select pg_temp.check((select paid from public.receivables where id = (select id from public.documents where idempotency_key = 'direct:inv-1')) = 700
  and (select balance from public.receivables where id = (select id from public.documents where idempotency_key = 'direct:inv-1')) = 480, 'the invoice owes 1180 − 700 = 480');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000a', 320, 100, 18, 18, jsonb_build_object(
  'paid_document_id', (select id from public.documents where idempotency_key = 'direct:inv-1'))))$$, 'pays a 300', 'a 320 never pays a 305');

-- a credit invoice (330): partial, then never beyond what is left
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000a', 330, 200, 36, 18, '{"base_doc_type":305,"base_doc_number":1,"idempotency_key":"cr-1"}'));
select pg_temp.check((select credited from public.receivables where id = (select id from public.documents where idempotency_key = 'direct:inv-1')) = 236
  and (select balance from public.receivables where id = (select id from public.documents where idempotency_key = 'direct:inv-1')) = 244, 'a credit lowers the balance');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000a', 330, 801, 144.18, 18, '{"base_doc_type":305,"base_doc_number":1}'))$$,
  'credit_exceeds_original', 'a credit beyond what is left (1180 − 236 = 944 < 945.18)');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000a', 330, 10, 1.8, 18, '{"base_doc_type":305,"base_doc_number":99}'))$$,
  'not found', 'a credit for an invoice that does not exist');
-- money paid back on that credit invoice
select pg_temp.check(public.record_credit_refund((select id from public.documents where idempotency_key = 'cr-1'), 'transfer', 236) is not null, 'money back on a credit invoice');
select pg_temp.refused_with($$select public.record_credit_refund((select id from public.documents where idempotency_key = 'cr-1'), 'cash', 1)$$,
  'more than the credit invoice', 'never more back than the credit invoice');
select pg_temp.check((select balance from public.receivables where id = (select id from public.documents where idempotency_key = 'direct:inv-1')) = 480,
  'a credit with the money paid back leaves the open balance where it was (1180 − 236 − (700 − 236))');

-- a tax invoice is corrected by a credit invoice, never cancelled
select pg_temp.refused_with($$insert into public.document_cancellations (document_id, user_id, reason)
  values ((select id from public.documents where idempotency_key = 'direct:inv-2'), '00000000-0000-0000-0000-00000000000a', 'טעות')$$, 'cancel_not_allowed', 'cancelling a tax invoice');
-- an issued document never changes and is never deleted
select pg_temp.refused($$update public.documents set total = 1 where idempotency_key = 'direct:inv-2'$$, 'an issued document changes');
select pg_temp.refused($$update public.documents set issuer = '{}' where idempotency_key = 'direct:inv-2'$$, 'the issuer snapshot changes');
select pg_temp.check(pg_temp.affected($$delete from public.documents where idempotency_key = 'direct:inv-2'$$) = 0, 'an issued document is never deleted');
-- printing is the one change, and it is logged
update public.documents set print_count = 1 where idempotency_key = 'direct:inv-2';
select pg_temp.check((select count(*) from public.finance_audit_log where action = 'document.printed') = 1, 'a print is logged');

-- the ledger never changes
select pg_temp.refused($$update public.payments set amount = 1$$, 'a ledger row changes');
select pg_temp.refused($$delete from public.payments$$, 'a ledger row is deleted');
select pg_temp.refused($$insert into public.payments (business_id, direction, amount, method, paid_on, source) values
  ('00000000-0000-0000-0000-0000000f0001', 'in', 1, 'cash', current_date, 'document')$$, 'the app writes to the ledger itself');

-- direct sales move stock; a credit line marked "restock" brings it back
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000a', 320, 200, 36, 18, jsonb_build_object('idempotency_key', 'shirts',
  'lines', jsonb_build_array(jsonb_build_object('name', 'חולצה', 'qty', 2, 'unitPriceExVat', 100, 'totalExVat', 200, 'vatRate', 18, 'kind', 1, 'itemId', '00000000-0000-0000-0000-0000000c0001')))));
select pg_temp.check((select stock_qty from public.catalog_items where id = '00000000-0000-0000-0000-0000000c0001') = 8, 'two shirts sold on a direct document');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000a', 330, 100, 18, 18, jsonb_build_object('base_doc_type', 320,
  'base_doc_number', (select doc_number from public.documents where idempotency_key = 'shirts'),
  'lines', jsonb_build_array(jsonb_build_object('name', 'חולצה', 'qty', 1, 'unitPriceExVat', 100, 'totalExVat', 100, 'vatRate', 18, 'kind', 1,
                                                'itemId', '00000000-0000-0000-0000-0000000c0001', 'restock', true)))));
select pg_temp.check((select stock_qty from public.catalog_items where id = '00000000-0000-0000-0000-0000000c0001') = 9, 'a returned shirt is back in stock');
select pg_temp.check((select count(*) from public.stock_movements where document_id is not null) = 2, 'the stock moves point to their documents');

-- drafts: no number; issued only by issuing the document (same transaction)
insert into public.document_drafts (id, user_id, doc_type, customer_name, total, body)
values ('00000000-0000-0000-0000-0000000a0001', '00000000-0000-0000-0000-00000000000a', 305, 'טיוטה', 118, '{"lines":[]}');
select pg_temp.refused($$update public.document_drafts set status = 'finalized' where id = '00000000-0000-0000-0000-0000000a0001'$$, 'a draft marked issued by hand');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000a', 305, 100, 18, 18, '{"draft_id":"00000000-0000-0000-0000-0000000a0001","idempotency_key":"draft:1"}'));
select pg_temp.check((select status from public.document_drafts where id = '00000000-0000-0000-0000-0000000a0001') = 'finalized'
  and (select document_id from public.document_drafts where id = '00000000-0000-0000-0000-0000000a0001') = (select id from public.documents where idempotency_key = 'draft:1'),
  'issuing the document marks its draft');
select pg_temp.refused($$delete from public.document_drafts where id = '00000000-0000-0000-0000-0000000a0001'$$, 'an issued draft is deleted');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000a', 305, 100, 18, 18, '{"draft_id":"00000000-0000-0000-0000-0000000a0001"}'))$$,
  'already issued', 'a draft issued twice');
insert into public.document_drafts (id, user_id, doc_type, body) values ('00000000-0000-0000-0000-0000000a0002', '00000000-0000-0000-0000-00000000000a', 300, '{}');
select pg_temp.check(pg_temp.affected($$delete from public.document_drafts where id = '00000000-0000-0000-0000-0000000a0002'$$) = 1, 'an open draft can be removed');

-- quotes: numbered, statuses forward only, converted by issuing the document
insert into public.quotes (id, user_id, customer_name, before_discount, after_discount, vat_rate, vat_amount, total, status)
values ('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-00000000000a', 'לקוחה', 1000, 1000, 18, 180, 1180, 'draft'),
       ('00000000-0000-0000-0000-0000000e0002', '00000000-0000-0000-0000-00000000000a', 'לקוח', 100, 100, 18, 18, 118, 'sent');
select pg_temp.check((select array_agg(quote_number order by quote_number) from public.quotes) = array[1, 2]::bigint[], 'quotes are numbered 1, 2');
select pg_temp.check((select sent_at is not null from public.quotes where id = '00000000-0000-0000-0000-0000000e0002'), 'a sent quote has a send time');
select pg_temp.refused($$update public.quotes set quote_number = 7 where id = '00000000-0000-0000-0000-0000000e0001'$$, 'a quote number changes');
select pg_temp.refused_with($$update public.quotes set status = 'accepted' where id = '00000000-0000-0000-0000-0000000e0001'$$, 'quote_status', 'a draft is accepted before it was sent');
update public.quotes set status = 'sent' where id = '00000000-0000-0000-0000-0000000e0001';
update public.quotes set status = 'accepted' where id = '00000000-0000-0000-0000-0000000e0001';
select pg_temp.refused_with($$update public.quotes set total = 1, after_discount = 1, before_discount = 1, vat_amount = 0 where id = '00000000-0000-0000-0000-0000000e0001'$$,
  'does not change', 'an accepted quote changes its price');
select pg_temp.refused($$update public.quotes set converted_document_id = (select id from public.documents limit 1) where id = '00000000-0000-0000-0000-0000000e0001'$$,
  'a quote marked converted by hand');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000a', 305, 1000, 180, 18, '{"quote_id":"00000000-0000-0000-0000-0000000e0001","idempotency_key":"from-quote"}'));
select pg_temp.check((select status from public.quotes where id = '00000000-0000-0000-0000-0000000e0001') = 'converted'
  and (select converted_document_id from public.quotes where id = '00000000-0000-0000-0000-0000000e0001') = (select id from public.documents where idempotency_key = 'from-quote'),
  'issuing the document converts the quote');
select pg_temp.check((select source from public.documents where idempotency_key = 'from-quote') = 'quote', 'the document says it came from a quote');
select pg_temp.refused($$delete from public.quotes$$, 'quotes are never deleted');

-- expenses: numbered, paid = money out, never deleted, void puts back money and stock
insert into public.expenses (id, user_id, supplier_name, supplier_dealer, doc_date, category, amount_before_vat, vat_amount, total, paid_on, payment_method, stock_lines)
values ('00000000-0000-0000-0000-0000000b0001', '00000000-0000-0000-0000-00000000000a', 'ספק בדים', '514000020', public.il_today(), 'inventory', 1000, 180, 1180,
        public.il_today(), 'transfer', '[{"itemId":"00000000-0000-0000-0000-0000000c0001","qty":5}]');
select pg_temp.check((select expense_number from public.expenses where id = '00000000-0000-0000-0000-0000000b0001') = 1, 'the first expense is number 1');
select pg_temp.check((select confirmed_by from public.expenses where id = '00000000-0000-0000-0000-0000000b0001') = '00000000-0000-0000-0000-00000000000a', 'who confirmed it');
select pg_temp.check((select count(*) from public.payments where expense_id = '00000000-0000-0000-0000-0000000b0001' and direction = 'out') = 1, 'a paid expense is money out');
select pg_temp.check(public.receive_expense_stock('00000000-0000-0000-0000-0000000b0001') = 1, 'the expense brings one product line in');
select pg_temp.check((select stock_qty from public.catalog_items where id = '00000000-0000-0000-0000-0000000c0001') = 14, '5 shirts came in with the expense');
select pg_temp.check(public.receive_expense_stock('00000000-0000-0000-0000-0000000b0001') = 0, 'a second time brings nothing');
select pg_temp.check((select stock_qty from public.catalog_items where id = '00000000-0000-0000-0000-0000000c0001') = 14, 'and only once');
select pg_temp.refused_with($$update public.expenses set total = 1, amount_before_vat = 1, vat_amount = 0 where id = '00000000-0000-0000-0000-0000000b0001'$$,
  'keeps its amounts', 'a paid expense changes its amount');
select pg_temp.refused($$delete from public.expenses where id = '00000000-0000-0000-0000-0000000b0001'$$, 'an expense is deleted');
select pg_temp.refused($$insert into public.expenses (user_id, supplier_name, doc_date, amount_before_vat, vat_amount, total)
  values ('00000000-0000-0000-0000-00000000000a', 'x', public.il_today() + 3, 1, 0, 1)$$, 'an expense dated in the future');
select pg_temp.refused($$insert into public.expenses (user_id, supplier_name, doc_date, amount_before_vat, vat_amount, total)
  values ('00000000-0000-0000-0000-00000000000a', 'x', public.il_today(), 1, 0, 2)$$, 'an expense whose total does not add up');
update public.expenses set status = 'void', void_reason = 'נרשם פעמיים' where id = '00000000-0000-0000-0000-0000000b0001';
select pg_temp.check((select count(*) from public.payments where expense_id = '00000000-0000-0000-0000-0000000b0001' and source = 'reversal' and direction = 'in') = 1,
  'a void expense brings its money back on the books');
select pg_temp.check((select stock_qty from public.catalog_items where id = '00000000-0000-0000-0000-0000000c0001') = 9, 'and takes its stock out again');
select pg_temp.refused($$update public.expenses set description = 'x' where id = '00000000-0000-0000-0000-0000000b0001'$$, 'a void expense changes');
-- a confirmed, unpaid expense for the summary below
insert into public.expenses (user_id, supplier_name, doc_date, category, amount_before_vat, vat_amount, total, vat_deductible_pct)
values ('00000000-0000-0000-0000-00000000000a', 'דלק', public.il_today(), 'vehicle', 300, 54, 354, 66.67);

-- allocation numbers: the app never writes them; a manual one is digits only, once per document
select pg_temp.refused($$insert into public.tax_allocations (business_id, document_id, status, gateway, allocation_number)
  values ('00000000-0000-0000-0000-0000000f0001', (select id from public.documents where idempotency_key = 'direct:inv-1'), 'approved', 'live', '123456789')$$,
  'the app writes an allocation number itself');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000a', 305, 6000, 1080, 18, '{"customer_dealer":"514000012","idempotency_key":"big","id":"00000000-0000-0000-0000-0000000a1003"}'));
select pg_temp.check((public.finance_summary(public.il_today() - 1, public.il_today()) ->> 'allocationMissing')::int = 1,
  'a 305 of ₪6,000 before VAT to a dealer, above the ₪5,000 rule, has no allocation number');
select pg_temp.refused_with($$select public.record_manual_allocation('00000000-0000-0000-0000-0000000a1003', 'TEST-1')$$,
  'digits only', 'a manual allocation number with letters');
select pg_temp.check(public.record_manual_allocation('00000000-0000-0000-0000-0000000a1003', '987654321') is not null, 'a manual allocation number');
select pg_temp.refused_with($$select public.record_manual_allocation('00000000-0000-0000-0000-0000000a1003', '111111111')$$,
  'already has', 'a second allocation number for the same document');
select pg_temp.refused($$insert into public.tax_allocations (business_id, document_id, status, gateway, is_test, allocation_number)
  values ('00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000a1003', 'approved', 'mock', true, '123456789')$$, 'a test number that looks real');
select pg_temp.check((select count(*) from public.tax_allocation_rules where not verified) = 4, 'the four thresholds are marked unverified');
select pg_temp.refused($$update public.tax_allocation_rules set threshold_before_vat = 1$$, 'a rule changes from the app');
select pg_temp.refused($$select * from public.tax_authority_connections$$, 'the Tax Authority tokens are readable');
select pg_temp.refused($$select * from public.finance_counters$$, 'the counters are readable');

-- the summary: one place for the numbers
select pg_temp.check((public.finance_summary(public.il_today() - 1, public.il_today()) -> 'revenue' ->> 'net')::numeric
  = 1000 + 500 + 100 + 200 + 100 + 1000 + 6000 - 200 - 100, 'income = tax invoices − credit invoices, before VAT');
select pg_temp.check((public.finance_summary(public.il_today() - 1, public.il_today()) -> 'revenue' ->> 'vat')::numeric
  = 180 + 90 + 18 + 36 + 18 + 180 + 1080 - 36 - 18, 'output VAT');
select pg_temp.check((public.finance_summary(public.il_today() - 1, public.il_today()) -> 'expenses' ->> 'net')::numeric = 300, 'only confirmed expenses count (the void one does not)');
select pg_temp.check((public.finance_summary(public.il_today() - 1, public.il_today()) -> 'expenses' ->> 'vatDeductible')::numeric = 36, 'vehicle VAT: two thirds deductible (54 × 66.67%)');
select pg_temp.check((public.finance_summary(public.il_today() - 1, public.il_today()) ->> 'vatPayable')::numeric = 1548 - 36, 'VAT to pay = output − deductible input');
select pg_temp.check((public.finance_summary(public.il_today() - 1, public.il_today()) ->> 'profit')::numeric = 8600 - (300 + 18), 'profit = income − (expenses + VAT that is not deductible)');
select pg_temp.check((public.finance_summary(public.il_today() - 1, public.il_today()) -> 'receivables' ->> 'open')::numeric
  = 480 + 590 + 118 + 1180 + 7080, 'open receivables: 480 + 590 + 118 + 1180 + 7080');
select pg_temp.check((public.finance_summary(public.il_today() - 1, public.il_today()) ->> 'allocationMissing')::int = 0, 'with its number entered, nothing is missing');
select pg_temp.refused_with($$select public.finance_summary(public.il_today(), public.il_today() - 1)$$, 'bad range', 'a range that ends before it starts');

-- the audit chain: written by the database, intact, append-only
select pg_temp.check((select count(*) from public.finance_audit_log where action = 'document.issued') >= 8, 'every issued document is logged');
select pg_temp.check((select count(*) from public.finance_audit_log where action in ('quote.created', 'quote.status')) >= 4, 'quotes are logged');
select pg_temp.check((select count(*) from public.finance_audit_log where action = 'expense.voided') = 1, 'a void expense is logged');
select pg_temp.check((public.finance_audit_verify() ->> 'ok')::boolean, 'the audit chain is intact');
select pg_temp.refused($$update public.finance_audit_log set details = '{}'$$, 'the audit log changes');
select pg_temp.refused($$delete from public.finance_audit_log$$, 'the audit log is deleted');
select pg_temp.refused($$select public.log_finance_event('document.issued', 'documents', 'x')$$, 'a client writes any event it likes');
select public.log_finance_event('export.csv', 'documents', '', '{"rows": 9}');
select pg_temp.check((select count(*) from public.finance_audit_log where action = 'export.csv') = 1, 'an export is logged');
-- a transaction invoice (300) for products: they go out on the 300 — never again on the 320s that pay it, in parts or
-- with the same lines
select pg_temp.check((select stock_qty from public.catalog_items where id = '00000000-0000-0000-0000-0000000c0001') = 9, 'nine shirts before the 300');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000a', 300, 200, 36, 18, jsonb_build_object('idempotency_key', 'shirts-300',
  'lines', jsonb_build_array(jsonb_build_object('name', 'חולצה', 'qty', 2, 'unitPriceExVat', 100, 'totalExVat', 200, 'vatRate', 18, 'kind', 1, 'itemId', '00000000-0000-0000-0000-0000000c0001')))));
select pg_temp.check((select stock_qty from public.catalog_items where id = '00000000-0000-0000-0000-0000000c0001') = 7, 'two shirts out on the transaction invoice');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000a', 320, 100, 18, 18, jsonb_build_object('idempotency_key', 'shirts-320a',
  'paid_document_id', (select id from public.documents where idempotency_key = 'shirts-300'))));
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000a', 320, 100, 18, 18, jsonb_build_object('idempotency_key', 'shirts-320b',
  'paid_document_id', (select id from public.documents where idempotency_key = 'shirts-300'),
  'lines', jsonb_build_array(jsonb_build_object('name', 'חולצה', 'qty', 1, 'unitPriceExVat', 100, 'totalExVat', 100, 'vatRate', 18, 'kind', 1, 'itemId', '00000000-0000-0000-0000-0000000c0001')))));
select pg_temp.check((select stock_qty from public.catalog_items where id = '00000000-0000-0000-0000-0000000c0001') = 7, 'the 320s that pay it move nothing');
select pg_temp.check((select balance from public.receivables where id = (select id from public.documents where idempotency_key = 'shirts-300')) = 0, 'and it is paid');
commit;

-- the audit chain notices a changed row (the superuser switches the guard off to tamper, as an attacker with the database would)
begin;
set local session_replication_role = replica;
update public.finance_audit_log set details = '{"total": 1}' where id = (select min(id) from public.finance_audit_log where business_id = '00000000-0000-0000-0000-0000000f0001');
set local session_replication_role = origin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select pg_temp.check(not (public.finance_audit_verify() ->> 'ok')::boolean, 'a tampered audit row is found');
rollback;

-- ======================================================================================================================
-- SaGabot (exempt dealer): only 300 / 400, no VAT; its cashier sells and sees nothing of the money
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
insert into public.business_finance_profile (user_id, bank_name, bank_branch, bank_account, payment_terms) values ('00000000-0000-0000-0000-00000000000b', 'הפועלים', '123', '456789', 'net_30');
select pg_temp.check((select count(*) from public.business_finance_profile) = 1, 'the owner sees the bank details');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000b', 320, 100, 0, 0))$$, 'doc_type_not_allowed', 'an exempt dealer issues a tax invoice');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000b', 305, 100, 0, 0))$$, 'doc_type_not_allowed', 'an exempt dealer issues a 305');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000b', 300, 100, 18, 18))$$, 'no VAT', 'VAT from an exempt dealer');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000b', 300, 400, 0, 0, '{"idempotency_key":"sg-300","lead_id":"00000000-0000-0000-0000-0000000d0002","id":"00000000-0000-0000-0000-0000000b3001"}'));
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000b', 400, 150, 0, 0, '{"idempotency_key":"sg-400"}'));
select pg_temp.check((select doc_number from public.documents where idempotency_key = 'sg-300') = 1 and (select doc_number from public.documents where idempotency_key = 'sg-400') = 1,
  'SaGabot numbers its own documents from 1');
select pg_temp.check((select issuer->>'entityType' from public.documents where idempotency_key = 'sg-400') = 'exempt_dealer', 'the receipt says "exempt dealer"');
-- a receipt issued by mistake is cancelled: the money goes off the books, the receipt stays as it was
insert into public.document_cancellations (document_id, user_id, reason) values ((select id from public.documents where idempotency_key = 'sg-400'), '00000000-0000-0000-0000-00000000000b', 'הופקה בטעות');
select pg_temp.check((select count(*) from public.payments where source = 'cancel' and direction = 'out' and amount = 150) = 1, 'a cancelled receipt reverses its money');
select pg_temp.refused($$insert into public.document_cancellations (document_id, user_id, reason) values ((select id from public.documents where idempotency_key = 'sg-400'), '00000000-0000-0000-0000-00000000000b', 'שוב')$$,
  'a receipt cancelled twice');
select pg_temp.check((public.finance_summary(public.il_today() - 1, public.il_today()) -> 'revenue' ->> 'net')::numeric = 0, 'a cancelled receipt is not income');
-- a 300 paid by a receipt can not be cancelled
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000b', 400, 400, 0, 0, jsonb_build_object('paid_document_id',
  (select id from public.documents where idempotency_key = 'sg-300'), 'idempotency_key', 'sg-400-b')));
select pg_temp.refused_with($$insert into public.document_cancellations (document_id, user_id, reason) values ((select id from public.documents where idempotency_key = 'sg-300'), '00000000-0000-0000-0000-00000000000b', 'טעות')$$,
  'paid transaction invoice', 'cancelling a paid 300');
select pg_temp.check((public.finance_summary(public.il_today() - 1, public.il_today()) -> 'revenue' ->> 'net')::numeric = 400, 'an exempt dealer''s income = its receipts');
select pg_temp.check((public.finance_summary(public.il_today() - 1, public.il_today()) ->> 'vatPayable')::numeric = 0, 'an exempt dealer pays no VAT');
-- products on an exempt dealer's documents: out on the 300 and not again on the receipt that pays it; a document
-- cancelled as issued by mistake puts them back
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000b', 300, 80, 0, 0, jsonb_build_object('idempotency_key', 'sg-300-shampoo',
  'lines', jsonb_build_array(jsonb_build_object('name', 'שמפו', 'qty', 2, 'unitPriceExVat', 40, 'totalExVat', 80, 'vatRate', 0, 'kind', 1, 'itemId', '00000000-0000-0000-0000-0000000c0003')))));
select pg_temp.check((select stock_qty from public.catalog_items where id = '00000000-0000-0000-0000-0000000c0003') = 3, 'two out on the exempt dealer''s 300');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000b', 400, 80, 0, 0, jsonb_build_object('idempotency_key', 'sg-400-shampoo',
  'paid_document_id', (select id from public.documents where idempotency_key = 'sg-300-shampoo'))));
select pg_temp.check((select stock_qty from public.catalog_items where id = '00000000-0000-0000-0000-0000000c0003') = 3, 'the receipt that pays it moves nothing');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000b', 400, 40, 0, 0, jsonb_build_object('idempotency_key', 'sg-400-oops',
  'lines', jsonb_build_array(jsonb_build_object('name', 'שמפו', 'qty', 1, 'unitPriceExVat', 40, 'totalExVat', 40, 'vatRate', 0, 'kind', 1, 'itemId', '00000000-0000-0000-0000-0000000c0003')))));
select pg_temp.check((select stock_qty from public.catalog_items where id = '00000000-0000-0000-0000-0000000c0003') = 2, 'one out on a receipt that stands alone');
insert into public.document_cancellations (document_id, user_id, reason) values ((select id from public.documents where idempotency_key = 'sg-400-oops'), '00000000-0000-0000-0000-00000000000b', 'הופקה בטעות');
select pg_temp.check((select stock_qty from public.catalog_items where id = '00000000-0000-0000-0000-0000000c0003') = 3, 'cancelling it brings the product back');
select pg_temp.check(exists (select 1 from public.stock_movements where item_id = '00000000-0000-0000-0000-0000000c0003' and reason = 'cancel' and delta = 1
  and document_id = (select id from public.documents where idempotency_key = 'sg-400-oops')), 'logged as a cancellation of that receipt');
select pg_temp.check((public.finance_summary(public.il_today() - 1, public.il_today()) -> 'revenue' ->> 'net')::numeric = 400 + 80, 'the cancelled receipt is not income; the paid one is');
-- closing the books: yesterday's documents and expenses are frozen
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000b', 400, 50, 0, 0, jsonb_build_object('doc_date', public.il_today() - 1, 'idempotency_key', 'sg-yday')));
select pg_temp.refused_with($$select public.lock_finance_period(public.il_today())$$, 'has ended', 'closing today');
select pg_temp.check(public.lock_finance_period(public.il_today() - 1, 'דוח דו-חודשי') = public.il_today() - 1, 'the books are closed until yesterday');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000b', 400, 50, 0, 0, jsonb_build_object('doc_date', public.il_today() - 1)))$$,
  'period_locked', 'a document dated in a closed period');
select pg_temp.refused_with($$insert into public.document_cancellations (document_id, user_id, reason) values ((select id from public.documents where idempotency_key = 'sg-yday'), '00000000-0000-0000-0000-00000000000b', 'טעות')$$,
  'period_locked', 'cancelling a receipt of a closed period');
select pg_temp.refused_with($$insert into public.expenses (user_id, supplier_name, doc_date, amount_before_vat, vat_amount, total) values ('00000000-0000-0000-0000-00000000000b', 'x', public.il_today() - 1, 10, 0, 10)$$,
  'period_locked', 'an expense dated in a closed period');
select pg_temp.refused($$update public.finance_period_locks set period_end = '2000-01-01'$$, 'closed books reopen');
select pg_temp.check(pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000b', 400, 50, 0, 0)) is not null, 'today is still open');
commit;

begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
select pg_temp.check(public.my_access() = 'register', 'C is a cashier');
select pg_temp.check((select count(*) from public.payments) = 0, 'a cashier sees no ledger');
select pg_temp.check((select count(*) from public.expenses) = 0, 'a cashier sees no expenses');
select pg_temp.check((select count(*) from public.quotes) = 0, 'a cashier sees no quotes');
select pg_temp.check((select count(*) from public.document_drafts) = 0, 'a cashier sees no drafts');
select pg_temp.check((select count(*) from public.finance_audit_log) = 0, 'a cashier sees no audit log');
select pg_temp.check((select count(*) from public.receivables) = 0, 'a cashier sees no receivables');
select pg_temp.check((select count(*) from public.business_finance_profile) = 0, 'a cashier sees no bank details');
select pg_temp.check((select count(*) from public.finance_period_locks) = 0, 'a cashier sees no closed periods');
select pg_temp.refused($$select public.finance_summary(public.il_today() - 30, public.il_today())$$, 'a cashier reads the money summary');
select pg_temp.refused($$select public.lock_finance_period(public.il_today() - 1)$$, 'a cashier closes the books');
select pg_temp.refused($$select public.log_finance_event('export.csv')$$, 'a cashier writes to the audit log');
select pg_temp.refused($$insert into public.expenses (user_id, supplier_name, doc_date, amount_before_vat, vat_amount, total) values ('00000000-0000-0000-0000-00000000000c', 'x', public.il_today(), 1, 0, 1)$$,
  'a cashier records an expense');
select pg_temp.refused($$insert into public.quotes (user_id, customer_name) values ('00000000-0000-0000-0000-00000000000c', 'x')$$, 'a cashier makes a quote');
select pg_temp.refused($$insert into public.document_drafts (user_id, doc_type) values ('00000000-0000-0000-0000-00000000000c', 400)$$, 'a cashier makes a draft');
-- the cashier's sale and its receipt still work
insert into public.sales (id, user_id, items, subtotal, total, method, status, paid_at)
values ('00000000-0000-0000-0000-000000005c02', '00000000-0000-0000-0000-00000000000c', '[{"name":"קרם","price":50,"qty":1}]', 50, 50, 'cash', 'paid', now());
select pg_temp.check(pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000c', 400, 50, 0, 0, '{"sale_id":"00000000-0000-0000-0000-000000005c02","idempotency_key":"sale:c"}')) is not null,
  'the cashier''s sale gets its receipt');
select pg_temp.check((select source from public.documents where idempotency_key = 'sale:c') = 'pos', 'a sale''s document is "pos"');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000c', 400, 400, 0, 0, '{"paid_document_id":"00000000-0000-0000-0000-0000000b3001"}'))$$,
  'not allowed', 'a cashier issues a receipt for an invoice');
commit;

-- ======================================================================================================================
-- isolation: FollowMe sees nothing of SaGabot, and the reverse; the super admin needs an explicit, logged opening
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.check((select count(*) from public.documents where business_id = '00000000-0000-0000-0000-0000000f0001') = 0, 'SaGabot sees no FollowMe documents');
select pg_temp.check((select count(*) from public.payments where business_id = '00000000-0000-0000-0000-0000000f0001') = 0, 'SaGabot sees no FollowMe ledger');
select pg_temp.check((select count(*) from public.quotes where business_id = '00000000-0000-0000-0000-0000000f0001') = 0, 'SaGabot sees no FollowMe quotes');
select pg_temp.check((select count(*) from public.receivables where business_id = '00000000-0000-0000-0000-0000000f0001') = 0, 'SaGabot sees no FollowMe receivables');
select pg_temp.check((select count(*) from public.finance_audit_log where business_id = '00000000-0000-0000-0000-0000000f0001') = 0, 'SaGabot sees no FollowMe audit log');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000b', 400, 590, 0, 0, '{"paid_document_id":"00000000-0000-0000-0000-0000000a1002"}'))$$,
  'not found in this business', 'SaGabot issues a receipt for a FollowMe invoice');
select pg_temp.refused($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-00000000000b', 400, 10, 0, 0, '{"lead_id":"00000000-0000-0000-0000-0000000d0001"}'))$$,
  'SaGabot attaches a FollowMe customer to its document');
select pg_temp.refused($$insert into public.expenses (user_id, business_id, supplier_name, doc_date, amount_before_vat, vat_amount, total)
  values ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000f0001', 'x', public.il_today(), 1, 0, 1)$$, 'SaGabot writes an expense into FollowMe');
select pg_temp.refused($$select public.record_manual_allocation('00000000-0000-0000-0000-0000000a1002', '123456789')$$,
  'SaGabot sets an allocation number on a FollowMe invoice');
select pg_temp.check(pg_temp.affected($$update public.quotes set notes = 'x' where business_id = '00000000-0000-0000-0000-0000000f0001'$$) = 0, 'SaGabot changes a FollowMe quote');
select pg_temp.refused($$select public.open_finance_access('00000000-0000-0000-0000-0000000f0001', 'סתם בדיקה של בעלת עסק')$$, 'a business owner opens another business''s money');
-- files: only under its own business folder
select pg_temp.refused($$insert into storage.objects (bucket_id, name) values ('finance-files', '00000000-0000-0000-0000-0000000f0001/x.pdf')$$, 'SaGabot uploads into FollowMe''s folder');
insert into storage.objects (bucket_id, name) values ('finance-files', '00000000-0000-0000-0000-0000000f0002/receipt.pdf');
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'finance-files') = 1, 'SaGabot sees its own file only');
select pg_temp.check(pg_temp.affected($$delete from storage.objects where bucket_id = 'finance-files'$$) = 0, 'an expense file is never removed');
commit;

begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
select pg_temp.refused($$insert into storage.objects (bucket_id, name) values ('finance-files', '00000000-0000-0000-0000-0000000f0002/c.pdf')$$, 'a cashier uploads an expense file');
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'finance-files') = 0, 'a cashier sees no expense files');
commit;

-- the super admin (A) works in SaGabot: its money is closed until access is opened with a reason
update public.profiles set current_business_id = '00000000-0000-0000-0000-0000000f0002' where id = '00000000-0000-0000-0000-00000000000a';
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select pg_temp.check(public.current_business_id() = '00000000-0000-0000-0000-0000000f0002', 'the super admin works in SaGabot');
select pg_temp.check((select count(*) from public.documents) = 0, 'SaGabot documents are closed to the super admin');
select pg_temp.check((select count(*) from public.sales) = 0, 'SaGabot sales are closed to the super admin');
select pg_temp.check((select count(*) from public.payments) = 0, 'the SaGabot ledger is closed to the super admin');
select pg_temp.check((select count(*) from public.business_finance_profile) = 0, 'SaGabot bank details are closed to the super admin');
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'finance-files') = 0, 'SaGabot expense files are closed to the super admin');
select pg_temp.check(not (public.finance_access_state() ->> 'open')::boolean and (public.finance_access_state() ->> 'superAdmin')::boolean, 'the screen knows it is closed');
select pg_temp.refused($$select public.finance_summary(public.il_today() - 30, public.il_today())$$, 'the summary needs the money to be open');
select pg_temp.refused_with($$select public.open_finance_access('00000000-0000-0000-0000-0000000f0002', 'x')$$, 'reason', 'opening without a reason');
select pg_temp.refused_with($$select public.open_finance_access('00000000-0000-0000-0000-0000000f0002', 'בדיקת תקלה בדוח', 600)$$, '8 hours', 'opening for ten hours');
select pg_temp.check(public.open_finance_access('00000000-0000-0000-0000-0000000f0002', 'בדיקת תקלה בדוח לבקשת שגית', 30) > now(), 'access opened for 30 minutes');
select pg_temp.check((select count(*) from public.documents) >= 4, 'now the super admin sees SaGabot documents');
select pg_temp.check((select actor_kind from public.finance_audit_log where action = 'support.access_opened') = 'super_admin', 'the opening is in SaGabot''s audit log, as the super admin');
select pg_temp.refused($$update public.finance_access_grants set expires_at = now() + interval '7 hours'$$, 'a grant is extended by hand');
select pg_temp.check(public.close_finance_access('00000000-0000-0000-0000-0000000f0002') = 1, 'access closed');
select pg_temp.check((select count(*) from public.documents) = 0, 'closed again');
commit;
-- SaGabot's owner sees who opened their books
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.check((select count(*) from public.finance_access_grants) = 1, 'the owner sees the super admin''s access');
select pg_temp.check((select count(*) from public.finance_audit_log where action in ('support.access_opened', 'support.access_closed')) = 2, 'and both events in the audit log');
select pg_temp.check((public.finance_audit_verify() ->> 'ok')::boolean, 'SaGabot''s audit chain is intact');
commit;
update public.profiles set current_business_id = '00000000-0000-0000-0000-0000000f0001' where id = '00000000-0000-0000-0000-00000000000a';
