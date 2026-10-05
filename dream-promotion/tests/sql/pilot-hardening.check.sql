-- Pilot hardening 2.52.1 (migration 20261005003200) on a real Postgres (tests/sql/run.sh), tried as the signed-in roles.
-- Attacks of business A on business B, a viewer, a cashier, a super admin — and the owners' own work, which must not change.
-- Fixtures only, with ids of their own (other check files use other businesses):
--   Alpha  (company, VAT)  owner E1, viewer V, cashier K        Beta (company, VAT)  owner E2 — the target
--   super admin X (member of neither)
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
create or replace function pg_temp.refused_with(stmt text, expect text, msg text) returns void language plpgsql as $$
begin
  execute stmt;
  raise exception 'CHECK FAILED: % (it was allowed)', msg;
exception when others then
  if sqlerrm like 'CHECK FAILED%' then raise; end if;
  if position(expect in sqlerrm) = 0 then raise exception 'CHECK FAILED: % (refused, but with "%")', msg, sqlerrm; end if;
end $$;
-- refused, and the message says nothing of the other business (no amount, no date, no type of business)
create or replace function pg_temp.refused_quietly(stmt text, msg text) returns void language plpgsql as $$
begin
  execute stmt;
  raise exception 'CHECK FAILED: % (it was allowed)', msg;
exception when others then
  if sqlerrm like 'CHECK FAILED%' then raise; end if;
  if sqlerrm <> 'not allowed' then raise exception 'CHECK FAILED: % (refused, but the answer says "%")', msg, sqlerrm; end if;
end $$;
create or replace function pg_temp.affected(stmt text) returns int language plpgsql as $$
declare n int; begin execute stmt; get diagnostics n = row_count; return n; end $$;
create or replace function pg_temp.as_user(uid text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', uid, true), set_config('request.jwt.claim.role', 'authenticated', true);
$$;
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
  ('00000000-0000-0000-0000-0000000e0e01', 'e1@alpha.test'), ('00000000-0000-0000-0000-0000000e0e02', 'e2@beta.test'),
  ('00000000-0000-0000-0000-0000000e0e0f', 'viewer@alpha.test'), ('00000000-0000-0000-0000-0000000e0e0c', 'cashier@alpha.test'),
  ('00000000-0000-0000-0000-0000000e0e0a', 'x@platform.test');
update public.profiles set is_super_admin = true where id = '00000000-0000-0000-0000-0000000e0e0a';
insert into public.businesses (id, name, slug) values
  ('00000000-0000-0000-0000-0000000eb001', 'Alpha', 'alpha-t'), ('00000000-0000-0000-0000-0000000eb002', 'Beta', 'beta-t');
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-0000000eb001', '00000000-0000-0000-0000-0000000e0e01', 'owner', 'full'),
  ('00000000-0000-0000-0000-0000000eb001', '00000000-0000-0000-0000-0000000e0e0f', 'viewer', 'full'),
  ('00000000-0000-0000-0000-0000000eb001', '00000000-0000-0000-0000-0000000e0e0c', 'editor', 'register'),
  ('00000000-0000-0000-0000-0000000eb002', '00000000-0000-0000-0000-0000000e0e02', 'owner', 'full');
update public.profiles set current_business_id = '00000000-0000-0000-0000-0000000eb001'
 where id in ('00000000-0000-0000-0000-0000000e0e01', '00000000-0000-0000-0000-0000000e0e0f', '00000000-0000-0000-0000-0000000e0e0c');
update public.profiles set current_business_id = '00000000-0000-0000-0000-0000000eb002' where id in ('00000000-0000-0000-0000-0000000e0e02', '00000000-0000-0000-0000-0000000e0e0a');
insert into public.register_settings (user_id, business_id, business_type, vat_rate, dealer_number, legal_name, street, city, entity_type) values
  ('00000000-0000-0000-0000-0000000e0e01', '00000000-0000-0000-0000-0000000eb001', 'licensed', 18, '514000020', 'אלפא בע"מ', 'הרצל', 'תל אביב', 'company'),
  ('00000000-0000-0000-0000-0000000e0e02', '00000000-0000-0000-0000-0000000eb002', 'licensed', 18, '514000038', 'בטא בע"מ', 'יפו', 'ירושלים', 'company');
insert into public.catalog_items (id, user_id, business_id, name, price, kind, track_stock, stock_qty) values
  ('00000000-0000-0000-0000-0000000ec001', '00000000-0000-0000-0000-0000000e0e01', '00000000-0000-0000-0000-0000000eb001', 'מוצר אלפא', 118, 'product', true, 10);
insert into public.leads (id, user_id, business_id, name) values
  ('00000000-0000-0000-0000-0000000ed001', '00000000-0000-0000-0000-0000000e0e01', '00000000-0000-0000-0000-0000000eb001', 'לקוחה של אלפא');

-- Beta's money: an invoice of ₪1,180 and books closed ten days ago
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000e0e02');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000e0e02', 305, 1000, 180, 18, '{"id":"00000000-0000-0000-0000-0000000ef305","idempotency_key":"beta-305"}'));
select public.lock_finance_period(public.il_today() - 10, 'בדיקה');
insert into public.sales (id, user_id, items, subtotal, total, method, status, paid_at)
values ('00000000-0000-0000-0000-0000000e5b01', '00000000-0000-0000-0000-0000000e0e02', '[{"name":"x","price":118,"qty":1}]', 118, 118, 'cash', 'paid', now());
commit;

-- ======================================================================================================================
-- 1. Alpha's owner attacks Beta: every write that names Beta is refused with nothing about Beta in the answer
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000e0e01');
select pg_temp.refused_quietly($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000e0e01', 330, 5000, 900, 18,
  '{"business_id":"00000000-0000-0000-0000-0000000eb002","base_doc_type":305,"base_doc_number":1}'))$$,
  'a credit invoice against Beta''s invoice (would tell how much is left to credit)');
select pg_temp.refused_quietly($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000e0e01', 305, 100, 18, 18,
  jsonb_build_object('business_id', '00000000-0000-0000-0000-0000000eb002', 'doc_date', public.il_today() - 20)))$$,
  'a document in Beta''s closed books (would tell the closing date)');
select pg_temp.refused_quietly($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000e0e02', 305, 100, 18, 18, '{"business_id":null}'))$$,
  'no business and Beta''s owner as the author (the fill would pick Beta)');
select pg_temp.refused_quietly($$insert into public.expenses (user_id, business_id, supplier_name, doc_date, amount_before_vat, vat_amount, total)
  values ('00000000-0000-0000-0000-0000000e0e01', '00000000-0000-0000-0000-0000000eb002', 'x', public.il_today() - 20, 1, 0, 1)$$, 'an expense in Beta');
select pg_temp.refused_quietly($$insert into public.document_cancellations (business_id, document_id, user_id, reason)
  values ('00000000-0000-0000-0000-0000000eb002', '00000000-0000-0000-0000-0000000ef305', '00000000-0000-0000-0000-0000000e0e01', 'x')$$,
  'cancelling Beta''s invoice (would tell its type)');
select pg_temp.refused_quietly($$insert into public.sale_refunds (user_id, business_id, sale_id, amount, method)
  values ('00000000-0000-0000-0000-0000000e0e01', '00000000-0000-0000-0000-0000000eb002', '00000000-0000-0000-0000-0000000e5b01', 9999, 'cash')$$,
  'a refund on Beta''s sale (would tell what was paid)');
select pg_temp.refused_quietly($$insert into public.quotes (user_id, business_id, customer_name) values ('00000000-0000-0000-0000-0000000e0e01', '00000000-0000-0000-0000-0000000eb002', 'x')$$,
  'a quote in Beta (would take Beta''s next number)');
select pg_temp.refused_quietly($$insert into public.document_drafts (user_id, business_id, doc_type) values ('00000000-0000-0000-0000-0000000e0e01', '00000000-0000-0000-0000-0000000eb002', 305)$$,
  'a draft in Beta');
-- the functions that answered about anyone
select pg_temp.refused_with($$select public.business_for_user('00000000-0000-0000-0000-0000000e0e02')$$, 'permission denied', 'which business another user works in');
select pg_temp.refused_with($$select public.business_is_active('00000000-0000-0000-0000-0000000eb002')$$, 'permission denied', 'whether another business is active');
select pg_temp.check(public.finance_locked_until('00000000-0000-0000-0000-0000000eb002') is null, 'Beta''s closing date is not Alpha''s to read');
-- nothing of Beta can be read, still
select pg_temp.check((select count(*) from public.documents where business_id = '00000000-0000-0000-0000-0000000eb002') = 0, 'no Beta documents');
select pg_temp.check((select count(*) from public.finance_period_locks where business_id = '00000000-0000-0000-0000-0000000eb002') = 0, 'no Beta locks');
select pg_temp.check(pg_temp.affected($$update public.documents set print_count = print_count + 1 where business_id = '00000000-0000-0000-0000-0000000eb002'$$) = 0,
  'no Beta document is printed by Alpha');
-- an Alpha row may not move to Beta either
insert into public.expenses (id, user_id, supplier_name, doc_date, amount_before_vat, vat_amount, total)
values ('00000000-0000-0000-0000-0000000ee001', '00000000-0000-0000-0000-0000000e0e01', 'ספק', public.il_today(), 100, 18, 118);
select pg_temp.refused_quietly($$update public.expenses set business_id = '00000000-0000-0000-0000-0000000eb002' where id = '00000000-0000-0000-0000-0000000ee001'$$,
  'moving Alpha''s expense to Beta');
-- TRUNCATE skips row-level security: not for the app's roles
select pg_temp.refused_with($$truncate public.documents$$, 'permission denied', 'truncating the documents');
select pg_temp.refused_with($$truncate public.sales$$, 'permission denied', 'truncating the sales');
select pg_temp.refused_with($$truncate public.document_counters$$, 'permission denied', 'truncating the numbering');
commit;

-- ======================================================================================================================
-- 2. Alpha's own work is unchanged (the owner, then the cashier)
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000e0e01');
select pg_temp.check(pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000e0e01', 305, 1000, 180, 18, '{"id":"00000000-0000-0000-0000-0000000ea305","idempotency_key":"alpha-305"}')) is not null,
  'Alpha issues its own invoice');
insert into public.leads (user_id, name) values ('00000000-0000-0000-0000-0000000e0e01', 'עוד לקוחה');
select pg_temp.check(pg_temp.affected($$update public.leads set notes = 'x' where id = '00000000-0000-0000-0000-0000000ed001'$$) = 1, 'the owner edits a contact');
select pg_temp.check(public.adjust_stock('00000000-0000-0000-0000-0000000ec001', 'add', 2, 'משלוח') = 12, 'the owner receives stock');
select pg_temp.check(public.lock_finance_period(public.il_today() - 30) = public.il_today() - 30, 'the owner closes old books');
select pg_temp.check(public.finance_locked_until('00000000-0000-0000-0000-0000000eb001') = public.il_today() - 30, 'and reads their own closing date');
select pg_temp.check((public.finance_summary(public.il_today() - 30, public.il_today()) ->> 'vat')::boolean, 'the summary still works');
commit;

begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000e0e0c');
insert into public.sales (id, user_id, items, subtotal, total, method, status, paid_at)
values ('00000000-0000-0000-0000-0000000e5a01', '00000000-0000-0000-0000-0000000e0e0c', '[{"name":"מוצר","price":118,"qty":1}]', 118, 118, 'cash', 'paid', now());
select pg_temp.check(pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000e0e0c', 320, 100, 18, 18,
  '{"sale_id":"00000000-0000-0000-0000-0000000e5a01","idempotency_key":"sale:alpha-1"}')) is not null, 'the cashier''s sale gets its tax invoice-receipt');
commit;

-- ======================================================================================================================
-- 3. the viewer reads everything of Alpha and changes nothing
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000e0e0f');
select pg_temp.check(not public.can_write(), 'a viewer does not write');
select pg_temp.check((select count(*) from public.leads) >= 2, 'the viewer reads the contacts');
select pg_temp.check((select count(*) from public.documents) >= 2, 'the viewer reads the documents');
select pg_temp.check((public.finance_summary(public.il_today() - 30, public.il_today()) ->> 'vat')::boolean, 'the viewer reads the summary');
select pg_temp.refused($$insert into public.leads (user_id, name) values ('00000000-0000-0000-0000-0000000e0e0f', 'x')$$, 'a viewer adds a contact');
select pg_temp.check(pg_temp.affected($$update public.leads set notes = 'viewer' where id = '00000000-0000-0000-0000-0000000ed001'$$) = 0, 'a viewer edits a contact');
select pg_temp.check(pg_temp.affected($$delete from public.leads where id = '00000000-0000-0000-0000-0000000ed001'$$) = 0, 'a viewer deletes a contact');
select pg_temp.refused($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000e0e0f', 305, 10, 1.8, 18))$$, 'a viewer issues a document');
select pg_temp.refused($$insert into public.expenses (user_id, supplier_name, doc_date, amount_before_vat, vat_amount, total) values ('00000000-0000-0000-0000-0000000e0e0f', 'x', public.il_today(), 1, 0, 1)$$,
  'a viewer records an expense');
select pg_temp.refused($$insert into public.sales (user_id, items, subtotal, total, method) values ('00000000-0000-0000-0000-0000000e0e0f', '[]', 1, 1, 'cash')$$, 'a viewer sells');
select pg_temp.refused_with($$select public.adjust_stock('00000000-0000-0000-0000-0000000ec001', 'add', 1, '')$$, 'not allowed', 'a viewer moves stock');
select pg_temp.refused_with($$select public.lock_finance_period(public.il_today() - 2)$$, 'not allowed', 'a viewer closes the books');
select pg_temp.refused_with($$select public.record_manual_allocation('00000000-0000-0000-0000-0000000ea305', '123456789')$$, 'not allowed', 'a viewer enters an allocation number');
select pg_temp.refused($$insert into storage.objects (bucket_id, name) values ('finance-files', '00000000-0000-0000-0000-0000000eb001/v.pdf')$$, 'a viewer uploads an expense file');
select pg_temp.check((select notes from public.leads where id = '00000000-0000-0000-0000-0000000ed001') = 'x', 'the contact is as the owner left it');
commit;

-- ======================================================================================================================
-- 4. memberships: nobody adds themselves from the browser — the super admin neither; every change is in the log
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000e0e0a');
select pg_temp.refused($$insert into public.business_members (business_id, user_id, role, access) values ('00000000-0000-0000-0000-0000000eb002', '00000000-0000-0000-0000-0000000e0e0a', 'owner', 'full')$$,
  'the super admin makes themselves a member (Beta''s money would open with no reason and no log)');
select pg_temp.check((select count(*) from public.documents) = 0, 'Beta''s money stays closed to the super admin');
-- adding someone else is the super admin's job — and Beta's log says so
insert into public.business_members (business_id, user_id, role, access) values ('00000000-0000-0000-0000-0000000eb002', '00000000-0000-0000-0000-0000000e0e0c', 'editor', 'register');
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000e0e01');
select pg_temp.check(pg_temp.affected($$update public.business_members set access = 'register' where user_id = '00000000-0000-0000-0000-0000000e0e01'$$) = 0, 'an owner changes their own membership');
select pg_temp.refused($$insert into public.business_members (business_id, user_id) values ('00000000-0000-0000-0000-0000000eb002', '00000000-0000-0000-0000-0000000e0e01')$$,
  'an owner joins another business');
commit;
select pg_temp.check((select count(*) from public.finance_audit_log where business_id = '00000000-0000-0000-0000-0000000eb002' and action = 'member.added'
  and details->>'email' = 'cashier@alpha.test' and details->>'access' = 'register') = 1, 'Beta''s audit log shows the person who was added');
-- the server (service role) still adds members; the log says "server"
set role service_role;
delete from public.business_members where business_id = '00000000-0000-0000-0000-0000000eb002' and user_id = '00000000-0000-0000-0000-0000000e0e0c';
reset role;
select pg_temp.check((select actor_kind from public.finance_audit_log where business_id = '00000000-0000-0000-0000-0000000eb002' and action = 'member.removed') = 'server',
  'a removal by the server is logged as the system');

-- ======================================================================================================================
-- 5. profiles: the email is the sign-in system's
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000e0e01');
select pg_temp.refused_with($$update public.profiles set email = 'e2@beta.test' where id = '00000000-0000-0000-0000-0000000e0e01'$$, 'sign-in system',
  'a user writes another person''s address into their profile');
select pg_temp.check(pg_temp.affected($$update public.profiles set full_name = 'אלפא' where id = '00000000-0000-0000-0000-0000000e0e01'$$) = 1, 'the name is still theirs to change');
commit;

-- ======================================================================================================================
-- 6. receipts on an invoice: never beyond its balance; a VAT business pays a 300 with a 320
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000e0e01');
-- the ₪1,180 invoice: ₪1,000 now, then ₪500 is too much, ₪180 closes it
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000e0e01', 400, 1000, 0, 0, '{"paid_document_id":"00000000-0000-0000-0000-0000000ea305","idempotency_key":"receipt:alpha:1"}'));
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000e0e01', 400, 500, 0, 0, '{"paid_document_id":"00000000-0000-0000-0000-0000000ea305"}'))$$,
  'receipt_exceeds_balance: 180.00 left', 'a receipt beyond the balance');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000e0e01', 400, 180, 0, 0, '{"paid_document_id":"00000000-0000-0000-0000-0000000ea305","idempotency_key":"receipt:alpha:2"}'));
select pg_temp.check((select balance from public.receivables where id = '00000000-0000-0000-0000-0000000ea305') = 0, 'the invoice is paid');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000e0e01', 400, 1, 0, 0, '{"paid_document_id":"00000000-0000-0000-0000-0000000ea305"}'))$$,
  'receipt_exceeds_balance: 0.00 left', 'a receipt on a paid invoice');
-- a transaction invoice (300) of a VAT business: a 400 is refused, a 320 pays it
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000e0e01', 300, 200, 36, 18, '{"id":"00000000-0000-0000-0000-0000000ea300","idempotency_key":"alpha-300"}'));
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000e0e01', 400, 236, 0, 0, '{"paid_document_id":"00000000-0000-0000-0000-0000000ea300"}'))$$,
  'tax invoice-receipt (320)', 'a VAT business pays a 300 with a plain receipt');
select pg_temp.check(pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000e0e01', 320, 200, 36, 18, '{"paid_document_id":"00000000-0000-0000-0000-0000000ea300","idempotency_key":"receipt:alpha300:1"}')) is not null,
  'a 320 pays the 300');
commit;

-- ======================================================================================================================
-- 7. what a document holds: numbers are numbers, dates are dates (the customer's page shows these)
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000e0e01');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000e0e01', 305, 100, 18, 18,
  '{"lines":[{"name":"שירות","qty":"1<img src=x onerror=alert(1)>","unitPriceExVat":100,"totalExVat":100,"vatRate":18,"kind":1}]}'))$$,
  'are numbers', 'a quantity that is not a number');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000e0e01', 305, 100, 18, 18,
  '{"lines":[{"name":"שירות","qty":1,"unitPriceExVat":100,"totalExVat":100,"vatRate":"18<script>","kind":1}]}'))$$,
  'are numbers', 'a VAT rate that is not a number');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000e0e01', 320, 100, 18, 18,
  jsonb_build_object('payments', jsonb_build_array(jsonb_build_object('method', 2, 'amount', 118, 'date', public.il_today(),
    'cheque', jsonb_build_object('number', '123', 'dueDate', '<script>alert(1)</script>'))))))$$,
  'a cheque''s details are digits', 'a cheque due date that is not a date');
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000e0e01', 320, 100, 18, 18,
  jsonb_build_object('payments', jsonb_build_array(jsonb_build_object('method', '1', 'amount', 118)))))$$,
  'are numbers', 'a payment method as text');
select pg_temp.check(pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000e0e01', 320, 100, 18, 18,
  jsonb_build_object('idempotency_key', 'cheque-ok', 'payments', jsonb_build_array(jsonb_build_object('method', 2, 'amount', 118, 'date', public.il_today(), 'm', 'cheque',
    'cheque', jsonb_build_object('number', '1001', 'bank', '12', 'branch', '345', 'account', '', 'dueDate', '2026-12-01')))))) is not null,
  'a cheque with its details is fine');
commit;

-- ======================================================================================================================
-- 8. money back once: the register's refund and a refund on a credit invoice together never pass what the sale was paid
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000e0e01');
insert into public.sales (id, user_id, items, subtotal, total, method, status, paid_at)
values ('00000000-0000-0000-0000-0000000e5a02', '00000000-0000-0000-0000-0000000e0e01', '[{"name":"שירות","price":118,"qty":1}]', 118, 118, 'cash', 'paid', now());
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000e0e01', 320, 100, 18, 18,
  '{"id":"00000000-0000-0000-0000-0000000ea320","sale_id":"00000000-0000-0000-0000-0000000e5a02","idempotency_key":"sale:alpha-2"}'));
-- ₪100 back at the register
insert into public.sale_refunds (user_id, sale_id, amount, vat_amount, method) values ('00000000-0000-0000-0000-0000000e0e01', '00000000-0000-0000-0000-0000000e5a02', 100, 15.25, 'cash');
-- a credit invoice on the same 320 from the finance screens, and money back on it: only the ₪18 the sale still has
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000e0e01', 330, 100, 18, 18, jsonb_build_object('id', '00000000-0000-0000-0000-0000000ea330',
  'base_doc_type', 320, 'base_doc_number', (select doc_number from public.documents where id = '00000000-0000-0000-0000-0000000ea320'), 'idempotency_key', 'credit:alpha-320:1')));
select pg_temp.refused_with($$select public.record_credit_refund('00000000-0000-0000-0000-0000000ea330', 'cash', 118)$$, 'refund_exceeds_paid: 18.00 left',
  'the whole sale back again on the credit invoice');
select pg_temp.check(public.record_credit_refund('00000000-0000-0000-0000-0000000ea330', 'cash', 18) is not null, 'what is left comes back');
select pg_temp.refused_with($$insert into public.sale_refunds (user_id, sale_id, amount, method) values ('00000000-0000-0000-0000-0000000e0e01', '00000000-0000-0000-0000-0000000e5a02', 1, 'cash')$$,
  'refund_exceeds_paid: 0.00 left', 'one more shekel at the register');
select pg_temp.check((select sum(amount) from public.payments where sale_id = '00000000-0000-0000-0000-0000000e5a02' and direction = 'out')
  + (select coalesce(sum(amount), 0) from public.payments where applies_to = '00000000-0000-0000-0000-0000000ea320' and direction = 'out' and sale_id is null) = 118,
  'exactly what was paid went back');
select pg_temp.check((public.finance_audit_verify() ->> 'ok')::boolean, 'Alpha''s audit chain is intact');
commit;
