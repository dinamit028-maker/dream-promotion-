-- Payment links and deposits (migration 20261010004300, docs/FINANCE_ADDITIONS_HE.md T2) on a real Postgres (tests/sql/run.sh).
-- The servers' functions run as service_role (what the dashboard's and the storefront's servers are); the screens' reads as the
-- signed-in roles. Fixtures only, with ids of their own:
--   Clinic A (company, VAT 18%)  owner OA, staff SA (editor, money open), cashier KA, viewer VA   customers NOA (נועה), DANA (דנה)
--                                a test terminal (the pretend provider), services: laser (₪400, deposit ₪100), consult (no deposit)
--   Clinic B (exempt dealer)     owner OB                                                      customer MICHAL (מיכל)
--   super admin ZZ (a member of neither)
-- The Definition of Done of T2: the same webhook twice makes one payment and one receipt; a failed payment shows as failed.
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
create or replace function pg_temp.as_user(uid text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', uid, true), set_config('request.jwt.claim.role', 'authenticated', true);
$$;
create or replace function pg_temp.issue(r jsonb) returns uuid language plpgsql as $$
declare cols text; id uuid;
begin
  select string_agg(quote_ident(k), ', ') into cols from jsonb_object_keys(r) k;
  execute format('insert into public.documents (%s) select %s from jsonb_populate_record(null::public.documents, $1) returning id', cols, cols) using r into id;
  return id;
end $$;
-- a link sent as the dashboard's server does it (service role), its id
create or replace function pg_temp.link(p_business text, p_kind text, p_target text, p_amount numeric, p_days int default 7) returns uuid
language sql as $$
  select (public.paylink_create(p_business::uuid, '00000000-0000-0000-0000-00000000e401', p_kind, p_target::uuid, p_amount, p_days,
                                'https://app.dream.test', 'whatsapp')->>'id')::uuid
$$;
create or replace function pg_temp.req(p uuid) returns public.payment_requests language sql as $$
  select * from public.payment_requests where id = p;
$$;
-- the invoice's balance, as the screens read it
create or replace function pg_temp.balance(p uuid) returns numeric language sql as $$
  select balance from public.receivables where id = p;
$$;

-- ---- the world --------------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000e401', 'oa@pl-a.test'), ('00000000-0000-0000-0000-00000000e402', 'sa@pl-a.test'),
  ('00000000-0000-0000-0000-00000000e403', 'ka@pl-a.test'), ('00000000-0000-0000-0000-00000000e404', 'va@pl-a.test'),
  ('00000000-0000-0000-0000-00000000e405', 'ob@pl-b.test'), ('00000000-0000-0000-0000-00000000e406', 'zz@platform.test');
update public.profiles set is_super_admin = true where id = '00000000-0000-0000-0000-00000000e406';
insert into public.businesses (id, name, slug) values
  ('00000000-0000-0000-0000-00000000eb01', 'Clinic A', 'pl-clinic-a'), ('00000000-0000-0000-0000-00000000eb02', 'Clinic B', 'pl-clinic-b');
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-00000000eb01', '00000000-0000-0000-0000-00000000e401', 'owner', 'full'),
  ('00000000-0000-0000-0000-00000000eb01', '00000000-0000-0000-0000-00000000e402', 'editor', 'full'),
  ('00000000-0000-0000-0000-00000000eb01', '00000000-0000-0000-0000-00000000e403', 'editor', 'register'),
  ('00000000-0000-0000-0000-00000000eb01', '00000000-0000-0000-0000-00000000e404', 'viewer', 'full'),
  ('00000000-0000-0000-0000-00000000eb02', '00000000-0000-0000-0000-00000000e405', 'owner', 'full');
update public.profiles set current_business_id = '00000000-0000-0000-0000-00000000eb01'
 where id in ('00000000-0000-0000-0000-00000000e401', '00000000-0000-0000-0000-00000000e402', '00000000-0000-0000-0000-00000000e403',
              '00000000-0000-0000-0000-00000000e404', '00000000-0000-0000-0000-00000000e406');
update public.profiles set current_business_id = '00000000-0000-0000-0000-00000000eb02' where id = '00000000-0000-0000-0000-00000000e405';
insert into public.register_settings (user_id, business_id, business_type, vat_rate, dealer_number, legal_name, street, city, entity_type) values
  ('00000000-0000-0000-0000-00000000e401', '00000000-0000-0000-0000-00000000eb01', 'licensed', 18, '514000004', 'קליניקה א בע"מ', 'הרצל', 'תל אביב', 'company'),
  ('00000000-0000-0000-0000-00000000e405', '00000000-0000-0000-0000-00000000eb02', 'licensed', 18, '123456782', 'קליניקה ב', 'הגפן', 'חיפה', 'exempt_dealer');
insert into public.business_finance_profile (business_id, trading_name) values ('00000000-0000-0000-0000-00000000eb01', 'לייזר א');
insert into public.leads (id, user_id, business_id, name, phone, email) values
  ('00000000-0000-0000-0000-00000000ec01', '00000000-0000-0000-0000-00000000e401', '00000000-0000-0000-0000-00000000eb01', 'נועה', '0501111111', 'noa@x.test'),
  ('00000000-0000-0000-0000-00000000ec02', '00000000-0000-0000-0000-00000000e401', '00000000-0000-0000-0000-00000000eb01', 'דנה', '0502222222', ''),
  ('00000000-0000-0000-0000-00000000ec03', '00000000-0000-0000-0000-00000000e405', '00000000-0000-0000-0000-00000000eb02', 'מיכל', '0503333333', '');
insert into public.booking_services (id, user_id, business_id, name, minutes, price, deposit) values
  ('00000000-0000-0000-0000-00000000e501', '00000000-0000-0000-0000-00000000e401', '00000000-0000-0000-0000-00000000eb01', 'לייזר רגליים', 45, 400, 100),
  ('00000000-0000-0000-0000-00000000e502', '00000000-0000-0000-0000-00000000e401', '00000000-0000-0000-0000-00000000eb01', 'ייעוץ', 20, null, null);
insert into public.appointments (id, user_id, business_id, service_id, lead_id, service_name, name, phone, email, start_at, end_at, source) values
  ('00000000-0000-0000-0000-00000000ea01', '00000000-0000-0000-0000-00000000e401', '00000000-0000-0000-0000-00000000eb01', '00000000-0000-0000-0000-00000000e501',
   '00000000-0000-0000-0000-00000000ec01', 'לייזר רגליים', 'נועה', '0501111111', 'noa@x.test', now() + interval '1 day', now() + interval '1 day 45 minutes', 'public'),
  ('00000000-0000-0000-0000-00000000ea02', '00000000-0000-0000-0000-00000000e401', '00000000-0000-0000-0000-00000000eb01', '00000000-0000-0000-0000-00000000e502',
   '00000000-0000-0000-0000-00000000ec02', 'ייעוץ', 'דנה', '0502222222', '', now() + interval '2 days', now() + interval '2 days 20 minutes', 'manual'),
  ('00000000-0000-0000-0000-00000000ea03', '00000000-0000-0000-0000-00000000e401', '00000000-0000-0000-0000-00000000eb01', '00000000-0000-0000-0000-00000000e501',
   '00000000-0000-0000-0000-00000000ec02', 'לייזר רגליים', 'דנה', '0502222222', '', now() - interval '2 days', now() - interval '2 days' + interval '45 minutes', 'manual'),
  ('00000000-0000-0000-0000-00000000ea04', '00000000-0000-0000-0000-00000000e401', '00000000-0000-0000-0000-00000000eb01', '00000000-0000-0000-0000-00000000e501',
   '00000000-0000-0000-0000-00000000ec02', 'לייזר רגליים', 'דנה', '0502222222', '', now() + interval '3 days', now() + interval '3 days 45 minutes', 'manual');
-- the terminals: A a test one of the pretend provider, not verified yet; B a test one, verified
insert into public.payment_accounts (business_id, provider, mode, sealed, page_uid, hint) values
  ('00000000-0000-0000-0000-00000000eb01', 'mock', 'test', 'v1.a.b.c', 'page-uid-a', 'c-12'),
  ('00000000-0000-0000-0000-00000000eb02', 'payplus', 'test', 'v1.d.e.f', 'page-uid-b', 'f-34');
update public.payment_accounts set verified_at = now() where business_id = '00000000-0000-0000-0000-00000000eb02';
-- documents: A's tax invoice to Noa (₪1,000 + VAT = ₪1,180), a tax invoice-receipt (paid at once); B's transaction invoice
-- to Michal (₪400, exempt); A's quotes to Dana (accepted: ₪590; sent: ₪118)
do $$
begin
  perform pg_temp.issue(jsonb_build_object('id', '00000000-0000-0000-0000-00000000e305', 'user_id', '00000000-0000-0000-0000-00000000e401',
    'business_id', '00000000-0000-0000-0000-00000000eb01', 'doc_type', 305, 'doc_number', 0, 'doc_date', public.il_today(), 'customer_name', 'נועה',
    'customer_phone', '0501111111', 'customer_email', 'noa@x.test', 'lead_id', '00000000-0000-0000-0000-00000000ec01',
    'lines', '[{"name": "לייזר", "qty": 1, "unitPriceExVat": 1000, "discountExVat": 0, "totalExVat": 1000, "vatRate": 18, "kind": 1}]'::jsonb,
    'payments', '[]'::jsonb, 'before_discount', 1000, 'discount', 0, 'after_discount', 1000, 'vat_amount', 180, 'total', 1180, 'vat_rate', 18,
    'idempotency_key', 'direct:pl-1'));
  perform pg_temp.issue(jsonb_build_object('id', '00000000-0000-0000-0000-00000000e320', 'user_id', '00000000-0000-0000-0000-00000000e401',
    'business_id', '00000000-0000-0000-0000-00000000eb01', 'doc_type', 320, 'doc_number', 0, 'doc_date', public.il_today(), 'customer_name', 'נועה',
    'lines', '[{"name": "ייעוץ", "qty": 1, "unitPriceExVat": 100, "discountExVat": 0, "totalExVat": 100, "vatRate": 18, "kind": 1}]'::jsonb,
    'payments', jsonb_build_array(jsonb_build_object('method', 1, 'amount', 118, 'date', public.il_today())),
    'before_discount', 100, 'discount', 0, 'after_discount', 100, 'vat_amount', 18, 'total', 118, 'vat_rate', 18, 'idempotency_key', 'direct:pl-2'));
  perform pg_temp.issue(jsonb_build_object('id', '00000000-0000-0000-0000-00000000e300', 'user_id', '00000000-0000-0000-0000-00000000e405',
    'business_id', '00000000-0000-0000-0000-00000000eb02', 'doc_type', 300, 'doc_number', 0, 'doc_date', public.il_today(), 'customer_name', 'מיכל',
    'lead_id', '00000000-0000-0000-0000-00000000ec03',
    'lines', '[{"name": "טיפול", "qty": 1, "unitPriceExVat": 400, "discountExVat": 0, "totalExVat": 400, "vatRate": 0, "kind": 1}]'::jsonb,
    'payments', '[]'::jsonb, 'before_discount', 400, 'discount', 0, 'after_discount', 400, 'vat_amount', 0, 'total', 400, 'vat_rate', 0,
    'idempotency_key', 'direct:pl-3'));
end $$;
insert into public.quotes (id, user_id, business_id, status, customer_name, customer_phone, lead_id, before_discount, after_discount, vat_rate, vat_amount, total) values
  ('00000000-0000-0000-0000-00000000e601', '00000000-0000-0000-0000-00000000e401', '00000000-0000-0000-0000-00000000eb01', 'sent', 'דנה', '0502222222',
   '00000000-0000-0000-0000-00000000ec02', 500, 500, 18, 90, 590),
  ('00000000-0000-0000-0000-00000000e602', '00000000-0000-0000-0000-00000000e401', '00000000-0000-0000-0000-00000000eb01', 'sent', 'דנה', '0502222222',
   '00000000-0000-0000-0000-00000000ec02', 100, 100, 18, 18, 118);
update public.quotes set status = 'accepted' where id = '00000000-0000-0000-0000-00000000e601';

-- ======================================================================================================================
-- 1. the switch and the terminal: off; a link only on a connected and verified terminal; new keys are checked again
-- ======================================================================================================================
begin;
set local role service_role;
select pg_temp.check(not public.payment_links_live(), 'the platform''s switch is off');
select pg_temp.refused_with($$select pg_temp.link('00000000-0000-0000-0000-00000000eb01', 'document', '00000000-0000-0000-0000-00000000e305', 100)$$,
  'paylink_not_verified', 'a terminal that was not checked sends no link');
select pg_temp.check(not public.sf_paylink_verified('00000000-0000-0000-0000-00000000eb01', 'v1.other'), 'other keys than the ones checked: not verified');
select pg_temp.check(public.sf_paylink_verified('00000000-0000-0000-0000-00000000eb01', 'v1.a.b.c'), 'the keys the provider accepted: verified');
select pg_temp.check((select (a->>'provider') = 'mock' and (a->>'sealed') = 'v1.a.b.c' and (a->>'business_name') = 'לייזר א'
                      from public.sf_paylink_account('00000000-0000-0000-0000-00000000eb01') a), 'the storefront gets the terminal (sealed) and the trading name');
update public.payment_accounts set sealed = 'v1.a.b.d' where business_id = '00000000-0000-0000-0000-00000000eb01';
select pg_temp.check((select verified_at is null from public.payment_accounts where business_id = '00000000-0000-0000-0000-00000000eb01'),
  'new keys: not verified any more');
update public.payment_accounts set sealed = 'v1.a.b.c' where business_id = '00000000-0000-0000-0000-00000000eb01';
select public.sf_paylink_verified('00000000-0000-0000-0000-00000000eb01', 'v1.a.b.c');
-- a live terminal, while the switch is off: no link (B's, for a moment)
update public.payment_accounts set mode = 'live' where business_id = '00000000-0000-0000-0000-00000000eb02';
update public.payment_accounts set verified_at = now() where business_id = '00000000-0000-0000-0000-00000000eb02';
select pg_temp.refused_with($$select pg_temp.link('00000000-0000-0000-0000-00000000eb02', 'document', '00000000-0000-0000-0000-00000000e300', 100)$$,
  'paylink_live_closed', 'a live terminal sends no link while the platform''s switch is off');
update public.payment_accounts set mode = 'test' where business_id = '00000000-0000-0000-0000-00000000eb02';
update public.payment_accounts set verified_at = now() where business_id = '00000000-0000-0000-0000-00000000eb02';
commit;

-- ======================================================================================================================
-- 2. a link for an open invoice: a part of the balance; never more than what is left after the other open links
-- ======================================================================================================================
begin;
set local role service_role;
create temp table l1 as select pg_temp.link('00000000-0000-0000-0000-00000000eb01', 'document', '00000000-0000-0000-0000-00000000e305', 500) as id;
grant select on l1 to public;
select pg_temp.check((select status = 'sent' and is_test and amount = 500 and provider = 'mock' and kind = 'document' and label like 'חשבונית מס מס׳ %'
                      and customer_name = 'נועה' and customer_email = 'noa@x.test' and lead_id = '00000000-0000-0000-0000-00000000ec01'
                      and expires_at > now() + interval '6 days' and link_origin = 'https://app.dream.test' and receipt_status = 'none'
                      from pg_temp.req((select id from l1))), 'a test link of ₪500 of the ₪1,180 invoice: sent, the customer''s details copied');
select pg_temp.refused_with($$select pg_temp.link('00000000-0000-0000-0000-00000000eb01', 'document', '00000000-0000-0000-0000-00000000e305', 700)$$,
  'paylink_over_balance: 680', 'with ₪500 open on it, ₪680 is left to ask for');
create temp table l2 as select pg_temp.link('00000000-0000-0000-0000-00000000eb01', 'document', '00000000-0000-0000-0000-00000000e305', 680) as id;
grant select on l2 to public;
select pg_temp.refused_with($$select pg_temp.link('00000000-0000-0000-0000-00000000eb01', 'document', '00000000-0000-0000-0000-00000000e305', 1)$$,
  'paylink_over_balance: 0', 'nothing is left to ask for');
select pg_temp.refused_with($$select pg_temp.link('00000000-0000-0000-0000-00000000eb01', 'document', '00000000-0000-0000-0000-00000000e320', 50)$$,
  'paylink_not_invoice', 'a tax invoice-receipt is paid already: no link');
select pg_temp.refused_with($$select pg_temp.link('00000000-0000-0000-0000-00000000eb01', 'document', '00000000-0000-0000-0000-00000000e300', 50)$$,
  'paylink_not_found', 'another business''s invoice is not found');
select pg_temp.refused_with($$select pg_temp.link('00000000-0000-0000-0000-00000000eb01', 'document', '00000000-0000-0000-0000-00000000e305', 0)$$,
  'paylink_amount', 'more than zero');
select pg_temp.refused_with($$select pg_temp.link('00000000-0000-0000-0000-00000000eb01', 'document', '00000000-0000-0000-0000-00000000e305', 10, 31)$$,
  'paylink_days', 'a link lives up to 30 days');
select pg_temp.refused_with($$select public.paylink_create('00000000-0000-0000-0000-00000000eb01', null, 'document', '00000000-0000-0000-0000-00000000e305',
  10, 7, 'javascript:alert(1)', 'link')$$, 'the address', 'the dashboard''s address is an address');
-- a cancelled link frees its amount
select pg_temp.check((select public.paylink_cancel('00000000-0000-0000-0000-00000000eb01', (select id from l2), '00000000-0000-0000-0000-00000000e401', 'טעות')->>'status') = 'cancelled',
  'the owner cancels a link not paid yet');
select pg_temp.check((select public.paylink_cancel('00000000-0000-0000-0000-00000000eb01', (select id from l2), null, '')->>'result') = 'ignored',
  'cancelled once');
create temp table l3 as select pg_temp.link('00000000-0000-0000-0000-00000000eb01', 'document', '00000000-0000-0000-0000-00000000e305', 680) as id;
grant select on l3 to public;
select pg_temp.check(public.paylink_sent('00000000-0000-0000-0000-00000000eb01', (select id from l3), 'email'), 'sent again — counted');
select pg_temp.check((select sends = 2 and sent_via = 'email' from pg_temp.req((select id from l3))), 'how it went last, how many times');
-- B (an exempt dealer): a part of a transaction invoice (the rest is for the links of sections 5 and 6)
create temp table lb as select pg_temp.link('00000000-0000-0000-0000-00000000eb02', 'document', '00000000-0000-0000-0000-00000000e300', 100) as id;
grant select on lb to public;
select pg_temp.check((select label like 'חשבונית עסקה מס׳ %' and provider = 'payplus' from pg_temp.req((select id from lb))), 'B''s link, its own terminal');
commit;

-- ======================================================================================================================
-- 3. a quote: only an accepted one; a deposit: the service's amount, one link per appointment, an open future appointment
-- ======================================================================================================================
begin;
set local role service_role;
select pg_temp.refused_with($$select pg_temp.link('00000000-0000-0000-0000-00000000eb01', 'quote', '00000000-0000-0000-0000-00000000e602', 118)$$,
  'paylink_quote', 'a quote not accepted yet has no link');
create temp table lq as select pg_temp.link('00000000-0000-0000-0000-00000000eb01', 'quote', '00000000-0000-0000-0000-00000000e601', 590) as id;
grant select on lq to public;
select pg_temp.check((select label like 'הצעת מחיר מס׳ %' and customer_name = 'דנה' and quote_id = '00000000-0000-0000-0000-00000000e601'
                      from pg_temp.req((select id from lq))), 'the accepted quote''s link');
select pg_temp.refused_with($$select pg_temp.link('00000000-0000-0000-0000-00000000eb01', 'quote', '00000000-0000-0000-0000-00000000e601', 1)$$,
  'paylink_over_balance', 'the quote''s whole amount is asked for already');
create temp table ld as select pg_temp.link('00000000-0000-0000-0000-00000000eb01', 'deposit', '00000000-0000-0000-0000-00000000ea01', 999) as id;
grant select on ld to public;
select pg_temp.check((select amount = 100 and label like 'מקדמה לתור: לייזר רגליים · %' and customer_email = 'noa@x.test'
                      from pg_temp.req((select id from ld))), 'a deposit is the service''s ₪100 — not what was typed');
select pg_temp.refused_with($$select pg_temp.link('00000000-0000-0000-0000-00000000eb01', 'deposit', '00000000-0000-0000-0000-00000000ea01', 100)$$,
  'paylink_deposit_exists', 'one deposit link per appointment');
select pg_temp.refused_with($$select pg_temp.link('00000000-0000-0000-0000-00000000eb01', 'deposit', '00000000-0000-0000-0000-00000000ea02', 100)$$,
  'paylink_no_deposit', 'a service without a deposit asks none');
select pg_temp.refused_with($$select pg_temp.link('00000000-0000-0000-0000-00000000eb01', 'deposit', '00000000-0000-0000-0000-00000000ea03', 100)$$,
  'paylink_appointment', 'an appointment that is over asks no deposit');
select pg_temp.refused_with($$update public.booking_services set deposit = 500 where id = '00000000-0000-0000-0000-00000000e501'$$,
  'booking_services_deposit_check', 'a deposit is not more than the price');
commit;

-- ======================================================================================================================
-- 4. a test link paid on the storefront: a page, the notice once, "paid" only from the provider's answer — paid (test):
--    no money in the ledger, no receipt. The same answer again changes nothing; another transaction is logged, not paid twice.
-- ======================================================================================================================
begin;
set local role service_role;
select pg_temp.check((select (r->>'status') = 'sent' and (r->>'test')::boolean and (r->>'amount')::numeric = 500 and (r->'account'->>'sealed') = 'v1.a.b.c'
                      and (r->>'business_name') = 'לייזר א' and (r->'customer'->>'name') = 'נועה'
                      from public.sf_paylink((select id from l1)) r), 'the storefront reads the link, its terminal and the name the customer knows');
select pg_temp.check(public.sf_paylink_page((select id from l1), 'mp_1', 'https://pay.test/mp_1') = 'ok', 'a page of the provider for the link');
select pg_temp.check(public.sf_paylink_page((select id from l1), 'mp_1', 'https://pay.test/mp_1') = 'ok', 'the same page again: nothing new');
select pg_temp.check((select jsonb_array_length(pages) = 1 and pages->0->>'state' = 'pending' from pg_temp.req((select id from l1))), 'one page, open');
select pg_temp.check(public.sf_paylink_event((select id from l1), 'mock', 'mock:link-callback:aaa', 'callback', true, '{}'), 'a notice is logged');
select pg_temp.check(not public.sf_paylink_event((select id from l1), 'mock', 'mock:link-callback:aaa', 'callback', true, '{}'),
  'the same notice again is not new (nothing is asked twice)');
select pg_temp.check((public.sf_paylink_paid((select id from l1), 'mp_other', 'mock', 'txn-1', 500, 'ILS')->>'result') = 'rejected',
  'a page that is not the link''s pays nothing');
select pg_temp.check((public.sf_paylink_paid((select id from l1), 'mp_1', 'mock', 'txn-1', 499, 'ILS')->>'result') = 'mismatch',
  'another amount pays nothing');
select pg_temp.check((select status = 'sent' from pg_temp.req((select id from l1))), 'still open');
select pg_temp.check((public.sf_paylink_paid((select id from l1), 'mp_1', 'mock', 'txn-1', 500, 'ILS')->>'result') = 'ok', 'paid — the provider said so');
select pg_temp.check((select status = 'paid' and paid_amount = 500 and provider_txn = 'txn-1' and receipt_status = 'none' and not paid_late
                      and pages->0->>'state' = 'approved' from pg_temp.req((select id from l1))), 'paid (test): no receipt to issue');
select pg_temp.check((public.sf_paylink_paid((select id from l1), 'mp_1', 'mock', 'txn-1', 500, 'ILS')->>'result') = 'already',
  'the same answer again (a second webhook): already');
select pg_temp.check((public.sf_paylink_paid((select id from l1), 'mp_1', 'mock', 'txn-2', 500, 'ILS')->>'result') = 'double',
  'another transaction for a paid link: logged for the owner, not paid twice');
select pg_temp.check((select provider_txn = 'txn-1' from pg_temp.req((select id from l1))), 'the first payment stays the payment');
select pg_temp.check((select count(*) = 0 from public.payments where applies_to = '00000000-0000-0000-0000-00000000e305'), 'a test payment: nothing in the ledger');
select pg_temp.check(pg_temp.balance('00000000-0000-0000-0000-00000000e305') = 1180, 'the invoice still owes all of it');
select pg_temp.check((select count(*) = 1 from public.lead_activities where lead_id = '00000000-0000-0000-0000-00000000ec01' and body like 'שולם בלינק:%(בדיקה — לא כסף אמיתי)'),
  'the customer''s card says it was a test');
select pg_temp.check(public.sf_paylink_page((select id from l1), 'mp_9', 'https://pay.test/mp_9') = 'closed', 'a paid link opens no new page');
commit;

-- ======================================================================================================================
-- 5. a failed payment shows as failed; the customer tries again with the same link
-- ======================================================================================================================
begin;
set local role service_role;
select public.sf_paylink_page((select id from l3), 'mp_3a', 'https://pay.test/mp_3a');
select pg_temp.check((public.sf_paylink_failed((select id from l3), 'mp_3a', '001 declined')->>'status') = 'failed', 'the card was declined: failed');
select pg_temp.check((select status = 'failed' and failed_at is not null and fail_reason = '001 declined' and pages->0->>'state' = 'declined'
                      from pg_temp.req((select id from l3))), 'failed, with the provider''s reason, never as paid');
select pg_temp.check((public.sf_paylink_failed((select id from l3), 'mp_3a', 'again')->>'result') = 'ignored', 'a closed page is closed once');
select pg_temp.check((public.sf_paylink_paid((select id from l3), 'mp_3a', 'mock', 'txn-3x', 680, 'ILS')->>'result') = 'ok',
  'still, if the provider says that page was paid after all — the money is recorded');
commit;
-- (again on a fresh link, the other way round: declined, then a new page that is paid)
begin;
set local role service_role;
create temp table l4 as select pg_temp.link('00000000-0000-0000-0000-00000000eb02', 'document', '00000000-0000-0000-0000-00000000e300', 0.01) as id;
grant select on l4 to public;
select public.sf_paylink_page((select id from l4), 'pp_1', 'https://payments.payplus.test/pp_1');
select public.sf_paylink_failed((select id from l4), 'pp_1', 'declined');
select pg_temp.check(public.sf_paylink_page((select id from l4), 'pp_2', 'https://payments.payplus.test/pp_2') = 'ok', 'a failed link takes a new try');
select pg_temp.check((select status = 'sent' and jsonb_array_length(pages) = 2 from pg_temp.req((select id from l4))), 'open again, two pages');
select pg_temp.check((public.sf_paylink_paid((select id from l4), 'pp_2', 'payplus', 'txn-4', 0.01, 'ILS')->>'result') = 'ok', 'the second try paid');
commit;

-- ======================================================================================================================
-- 6. late: a payment after the link expired or was cancelled is recorded (the money was taken) and marked late
-- ======================================================================================================================
begin;
set local role service_role;
create temp table l5 as select pg_temp.link('00000000-0000-0000-0000-00000000eb02', 'document', '00000000-0000-0000-0000-00000000e300', 100) as id;
create temp table l6 as select pg_temp.link('00000000-0000-0000-0000-00000000eb02', 'document', '00000000-0000-0000-0000-00000000e300', 100) as id;
grant select on l5 to public; grant select on l6 to public;
select public.sf_paylink_page((select id from l5), 'pp_5', 'https://payments.payplus.test/pp_5');
select public.sf_paylink_page((select id from l6), 'pp_6', 'https://payments.payplus.test/pp_6');
select public.paylink_cancel('00000000-0000-0000-0000-00000000eb02', (select id from l5), '00000000-0000-0000-0000-00000000e405', '');
update public.payment_requests set expires_at = now() - interval '1 minute' where id = (select id from l6);
select pg_temp.check(public.paylinks_expire() >= 1, 'links past their time: expired');
select pg_temp.check((select status = 'expired' from pg_temp.req((select id from l6))), 'expired');
select pg_temp.check(public.sf_paylink_page((select id from l6), 'pp_6b', 'https://payments.payplus.test/pp_6b') = 'closed', 'an expired link opens no page');
select pg_temp.check((select (r->>'expired')::boolean from public.sf_paylink((select id from l6)) r), 'the storefront sees it expired');
select pg_temp.check((public.sf_paylink_paid((select id from l5), 'pp_5', 'payplus', 'txn-5', 100, 'ILS')->>'late')::boolean, 'paid after it was cancelled: late');
select pg_temp.check((public.sf_paylink_paid((select id from l6), 'pp_6', 'payplus', 'txn-6', 100, 'ILS')->>'late')::boolean, 'paid after it expired: late');
select pg_temp.check((select bool_and(status = 'paid' and paid_late) from public.payment_requests where id in ((select id from l5), (select id from l6))),
  'both recorded as paid, late — for the owner to see');
commit;
-- the cron's list: a page nobody confirmed for 10 minutes (also of a closed link), not a fresh one
begin;
set local role service_role;
create temp table l7 as select pg_temp.link('00000000-0000-0000-0000-00000000eb02', 'document', '00000000-0000-0000-0000-00000000e300', 50) as id;
grant select on l7 to public;
select public.sf_paylink_page((select id from l7), 'pp_7', 'https://payments.payplus.test/pp_7');
select pg_temp.check(not (public.sf_paylinks_unconfirmed(50) ? (select id::text from l7)), 'a page of a minute ago is not asked about yet');
update public.payment_requests set pages = jsonb_set(pages, '{0,at}', to_jsonb(now() - interval '20 minutes')) where id = (select id from l7);
select pg_temp.check(public.sf_paylinks_unconfirmed(50) ? (select id::text from l7), 'after 10 minutes the cron asks the provider');
select public.paylink_cancel('00000000-0000-0000-0000-00000000eb02', (select id from l7), null, '');
select pg_temp.check(public.sf_paylinks_unconfirmed(50) ? (select id::text from l7), 'also when the link was cancelled meanwhile');
commit;

-- ======================================================================================================================
-- 7. a real link (the switch on, a live terminal — here only): paid → its receipt by the existing engine, once.
--    THE SAME WEBHOOK TWICE → ONE PAYMENT AND ONE RECEIPT.
-- ======================================================================================================================
update public.platform_flags set enabled = true where key = 'payment_links_live';
update public.payment_accounts set mode = 'live' where business_id = '00000000-0000-0000-0000-00000000eb01';
update public.payment_accounts set verified_at = now() where business_id = '00000000-0000-0000-0000-00000000eb01';
begin;
set local role service_role;
select public.paylink_cancel('00000000-0000-0000-0000-00000000eb01', (select id from l3), null, '');
create temp table r1 as select pg_temp.link('00000000-0000-0000-0000-00000000eb01', 'document', '00000000-0000-0000-0000-00000000e305', 300) as id;
grant select on r1 to public;
select pg_temp.check((select not is_test from pg_temp.req((select id from r1))), 'a live terminal with the switch on: a real link');
select public.sf_paylink_page((select id from r1), 'mp_r1', 'https://pay.test/mp_r1');
-- the webhook, twice: the notice once; the provider's answer twice — paid once
select pg_temp.check(public.sf_paylink_event((select id from r1), 'mock', 'mock:link-callback:r1', 'callback', true, '{}'), 'the first notice is new');
select pg_temp.check(not public.sf_paylink_event((select id from r1), 'mock', 'mock:link-callback:r1', 'callback', true, '{}'), 'the second is not');
select pg_temp.check((public.sf_paylink_paid((select id from r1), 'mp_r1', 'mock', 'txn-r1', 300, 'ILS')->>'result') = 'ok', 'paid');
select pg_temp.check((public.sf_paylink_paid((select id from r1), 'mp_r1', 'mock', 'txn-r1', 300, 'ILS')->>'result') = 'already', 'paid once');
select pg_temp.check((select receipt_status = 'pending' from pg_temp.req((select id from r1))), 'the receipt waits for the server (at once: the business''s setting)');
select pg_temp.check(public.paylinks_receipts_pending(20) ? (select id::text from r1), 'the server''s list has it');
-- the server issues the receipt (400 on the 305) with the link's own key — twice, as a second webhook would make it try
create temp table rc as select pg_temp.issue(jsonb_build_object('user_id', '00000000-0000-0000-0000-00000000e401',
  'business_id', '00000000-0000-0000-0000-00000000eb01', 'doc_type', 400, 'doc_number', 0, 'doc_date', public.il_today(), 'customer_name', 'נועה',
  'lead_id', '00000000-0000-0000-0000-00000000ec01', 'paid_document_id', '00000000-0000-0000-0000-00000000e305', 'source', 'receipt',
  'lines', '[{"name": "תשלום עבור חשבונית מס מס׳ 1", "qty": 1, "unitPriceExVat": 300, "discountExVat": 0, "totalExVat": 300, "vatRate": 0, "kind": 1}]'::jsonb,
  'payments', jsonb_build_array(jsonb_build_object('method', 3, 'm', 'card', 'amount', 300, 'date', public.il_today())),
  'before_discount', 300, 'discount', 0, 'after_discount', 300, 'vat_amount', 0, 'total', 300, 'vat_rate', 0,
  'idempotency_key', 'paylink:' || (select id from r1))) as id;
grant select on rc to public;
select pg_temp.refused_with(format($$select pg_temp.issue(jsonb_build_object('user_id', '00000000-0000-0000-0000-00000000e401',
  'business_id', '00000000-0000-0000-0000-00000000eb01', 'doc_type', 400, 'doc_number', 0, 'doc_date', public.il_today(), 'customer_name', 'נועה',
  'paid_document_id', '00000000-0000-0000-0000-00000000e305', 'source', 'receipt',
  'lines', '[{"name": "x", "qty": 1, "unitPriceExVat": 300, "discountExVat": 0, "totalExVat": 300, "vatRate": 0, "kind": 1}]'::jsonb,
  'payments', jsonb_build_array(jsonb_build_object('method', 3, 'm', 'card', 'amount', 300, 'date', public.il_today())),
  'before_discount', 300, 'discount', 0, 'after_discount', 300, 'vat_amount', 0, 'total', 300, 'vat_rate', 0,
  'idempotency_key', 'paylink:%s'))$$, (select id from r1)), 'idempotency', 'a second receipt with the link''s key is refused');
select pg_temp.check((public.paylink_receipt_done((select id from r1), (select id from rc), '')->>'receipt') = 'issued', 'the receipt is the link''s');
select pg_temp.check((public.paylink_receipt_done((select id from r1), (select id from rc), '')->>'result') = 'already', 'once');
select pg_temp.check((select count(*) = 1 from public.documents where idempotency_key = 'paylink:' || (select id from r1)), 'ONE receipt');
select pg_temp.check((select count(*) = 1 and sum(amount) = 300 from public.payments where applies_to = '00000000-0000-0000-0000-00000000e305' and direction = 'in'),
  'ONE payment in the ledger — from the receipt, as always');
select pg_temp.check(pg_temp.balance('00000000-0000-0000-0000-00000000e305') = 880, 'the invoice owes ₪880');
select pg_temp.check(not (public.paylinks_receipts_pending(20) ? (select id::text from r1)), 'nothing left for the server');
select pg_temp.refused_with($$select public.paylink_receipt_done((select id from r1), '00000000-0000-0000-0000-00000000e320', '')$$,
  'not this link', 'only the link''s own receipt');
commit;
-- the owner approves first (the business's setting): awaiting, then pending; a blocked one is tried again on approval
update public.business_finance_profile set paylink_receipt = 'approve' where business_id = '00000000-0000-0000-0000-00000000eb01';
begin;
set local role service_role;
create temp table r2 as select pg_temp.link('00000000-0000-0000-0000-00000000eb01', 'document', '00000000-0000-0000-0000-00000000e305', 200) as id;
grant select on r2 to public;
select public.sf_paylink_page((select id from r2), 'mp_r2', 'https://pay.test/mp_r2');
select public.sf_paylink_paid((select id from r2), 'mp_r2', 'mock', 'txn-r2', 200, 'ILS');
select pg_temp.check((select receipt_status = 'awaiting' from pg_temp.req((select id from r2))), 'paid — the receipt waits for the owner''s approval');
select pg_temp.check(not (public.paylinks_receipts_pending(20) ? (select id::text from r2)), 'the server does not issue it alone');
select pg_temp.refused_with($$select pg_temp.link('00000000-0000-0000-0000-00000000eb01', 'document', '00000000-0000-0000-0000-00000000e305', 681)$$,
  'paylink_over_balance: 680', 'a paid link whose receipt waits still holds its amount');
select pg_temp.check((public.paylink_receipt_approve('00000000-0000-0000-0000-00000000eb02', (select id from r2), null)->>'result') = 'not_found',
  'another business approves nothing');
select pg_temp.check((public.paylink_receipt_approve('00000000-0000-0000-0000-00000000eb01', (select id from r2), '00000000-0000-0000-0000-00000000e401')->>'receipt') = 'pending',
  'approved: the server issues it');
select pg_temp.check((public.paylink_receipt_done((select id from r2), null, 'חסרים פרטי העסק')->>'receipt') = 'blocked', 'blocked, with the reason');
select pg_temp.check((select receipt_error = 'חסרים פרטי העסק' from pg_temp.req((select id from r2))), 'the reason is kept for the owner');
select pg_temp.check((public.paylink_receipt_approve('00000000-0000-0000-0000-00000000eb01', (select id from r2), null)->>'receipt') = 'pending',
  'tried again after the owner fixed it');
commit;
update public.business_finance_profile set paylink_receipt = 'auto' where business_id = '00000000-0000-0000-0000-00000000eb01';

-- ======================================================================================================================
-- 8. a deposit, offset at the register: what was really paid for an appointment — also the cashier sees the amount
-- ======================================================================================================================
begin;
set local role service_role;
-- the test deposit of section 3 (sent on a test terminal) is still a test when paid
select public.sf_paylink_page((select id from ld), 'mp_d1', 'https://pay.test/mp_d1');
select public.sf_paylink_paid((select id from ld), 'mp_d1', 'mock', 'txn-d1', 100, 'ILS');
create temp table rd as select pg_temp.link('00000000-0000-0000-0000-00000000eb01', 'deposit', '00000000-0000-0000-0000-00000000ea04', 0) as id;
grant select on rd to public;
select public.sf_paylink_page((select id from rd), 'mp_d4', 'https://pay.test/mp_d4');
select public.sf_paylink_paid((select id from rd), 'mp_d4', 'mock', 'txn-d4', 100, 'ILS');
select pg_temp.check((select not is_test and status = 'paid' and receipt_status = 'pending' from pg_temp.req((select id from rd))), 'a real deposit, paid');
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000e401');
select pg_temp.check((select coalesce(sum(amount), 0) = 100 from public.appointment_deposits(array['00000000-0000-0000-0000-00000000ea04'::uuid])),
  'the appointment''s deposit: ₪100 to offset');
select pg_temp.check((select count(*) = 0 from public.appointment_deposits(array['00000000-0000-0000-0000-00000000ea01'::uuid])),
  'a test deposit is never offset (no real money came)');
select pg_temp.as_user('00000000-0000-0000-0000-00000000e403');
select pg_temp.check((select coalesce(sum(amount), 0) = 100 from public.appointment_deposits(array['00000000-0000-0000-0000-00000000ea04'::uuid])),
  'the register''s cashier gets the amount to offset (nothing else)');
select pg_temp.as_user('00000000-0000-0000-0000-00000000e405');
select pg_temp.check((select count(*) = 0 from public.appointment_deposits(array['00000000-0000-0000-0000-00000000ea04'::uuid])),
  'another business gets nothing');
commit;

-- ======================================================================================================================
-- 9. who sees and who writes: the money screens read; the cashier, another business and the super admin see nothing;
--    nobody writes a link but the servers' functions
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000e401');
select pg_temp.check((select count(*) >= 8 from public.payment_requests), 'the owner reads the business''s links');
select pg_temp.check((select count(*) = 0 from public.payment_requests where business_id <> '00000000-0000-0000-0000-00000000eb01'), 'only the business''s own');
select pg_temp.refused($$update public.payment_requests set amount = 1 where id = (select id from l1)$$, 'the owner does not change a link');
select pg_temp.refused($$insert into public.payment_requests (business_id, kind, document_id, label, amount, is_test, provider, expires_at, link_origin)
  values ('00000000-0000-0000-0000-00000000eb01', 'document', '00000000-0000-0000-0000-00000000e305', 'x', 1, true, 'mock', now() + interval '1 day', 'https://x.test')$$,
  'nor writes one by hand');
select pg_temp.refused_with($$select public.paylink_create('00000000-0000-0000-0000-00000000eb01', null, 'document', '00000000-0000-0000-0000-00000000e305', 1, 7, 'https://x.test', 'link')$$,
  'permission denied', 'the servers'' function is not the screen''s');
select pg_temp.refused_with($$select public.sf_paylink_paid((select id from l2), 'x', 'mock', 'x', 1, 'ILS')$$, 'permission denied', 'nor the storefront''s');
select pg_temp.as_user('00000000-0000-0000-0000-00000000e402');
select pg_temp.check((select count(*) >= 8 from public.payment_requests), 'staff with the money open read them');
select pg_temp.as_user('00000000-0000-0000-0000-00000000e404');
select pg_temp.check((select count(*) >= 8 from public.payment_requests), 'a viewer reads');
select pg_temp.as_user('00000000-0000-0000-0000-00000000e403');
select pg_temp.check((select count(*) = 0 from public.payment_requests), 'a cashier sees no link');
select pg_temp.as_user('00000000-0000-0000-0000-00000000e405');
select pg_temp.check((select count(*) = 0 from public.payment_requests where business_id = '00000000-0000-0000-0000-00000000eb01'), 'another business sees none of A''s');
select pg_temp.as_user('00000000-0000-0000-0000-00000000e406');
select pg_temp.check((select count(*) = 0 from public.payment_requests), 'the super admin sees none before opening access with a reason');
commit;
-- what never changes, and a link is never deleted (even by the server)
begin;
set local role service_role;
select pg_temp.refused_with($$update public.payment_requests set amount = 1 where id = (select id from l1)$$, 'keeps what it asks for', 'the amount stays');
select pg_temp.refused_with($$update public.payment_requests set status = 'sent' where id = (select id from l1)$$, 'stays paid', 'a paid link stays paid');
select pg_temp.refused_with($$update public.payment_requests set status = 'sent' where id = (select id from l2)$$, 'only becomes paid', 'a cancelled link does not open again');
select pg_temp.refused_with($$delete from public.payment_requests where id = (select id from l2)$$, 'append-only', 'never deleted');
commit;

-- ======================================================================================================================
-- 10. the email of a link: in the one outbox, once per send; without an email nothing is queued
-- ======================================================================================================================
begin;
set local role service_role;
select pg_temp.check(public.paylink_email((select id from l1), '1'), 'Noa has an email: queued');
select pg_temp.check(not public.paylink_email((select id from l1), '1'), 'the same send once');
select pg_temp.check(public.paylink_email((select id from l1), '2'), 'a second send is a second email');
select pg_temp.check(not public.paylink_email((select id from lq), '1'), 'Dana has no email: nothing queued');
select pg_temp.check((select count(*) = 2 and bool_and(kind = 'payment_link' and order_id is null and request_id = (select id from l1) and to_email = 'noa@x.test')
                      from public.email_outbox where request_id = (select id from l1)), 'a link''s email: no order, the link');
select pg_temp.refused_with($$insert into public.email_outbox (business_id, kind, to_email) values ('00000000-0000-0000-0000-00000000eb01', 'order_ready', 'a@b.co')$$,
  'email_outbox_about_check', 'an order''s email still needs its order');
create temp table em as select id from public.email_outbox where request_id = (select id from l1) order by ref limit 1;
grant select on em to public;
select pg_temp.check(public.email_outbox_done((select id from em), 're_123', '', false) = 'sent', 'sent with the provider''s id (no order to tell)');
select pg_temp.check(public.email_outbox_done((select id from email_outbox where request_id = (select id from l1) and ref = '2'), '', 'bounce', true) = 'failed',
  'failed: no order, no store alert — the link''s screen shows it');
commit;

-- ======================================================================================================================
-- 11. the audit log: every step of a link, in the business's own chain (still intact)
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000e401');
select pg_temp.check((select count(distinct action) = 9 from public.finance_audit_log
  where business_id = '00000000-0000-0000-0000-00000000eb01' and action in ('paylink.created', 'paylink.cancelled', 'paylink.test_paid', 'paylink.paid',
    'paylink.double', 'paylink.mismatch', 'paylink.receipt', 'paylink.receipt_approved', 'paylink.receipt_blocked')),
  'sent, cancelled, paid (test and real), double, mismatch, the receipt, approved and blocked are in the audit log');
select pg_temp.check((select (r->>'ok')::boolean from public.finance_audit_verify() r), 'the audit chain is intact');
commit;

-- ======================================================================================================================
-- 12. what a link pays changed after it was sent: no new page — the invoice cancelled or paid meanwhile, the quote cancelled,
--     the appointment cancelled (a payment already on its way is still recorded, as in section 6)
-- ======================================================================================================================
do $$
begin
  perform pg_temp.issue(jsonb_build_object('id', '00000000-0000-0000-0000-00000000e301', 'user_id', '00000000-0000-0000-0000-00000000e405',
    'business_id', '00000000-0000-0000-0000-00000000eb02', 'doc_type', 300, 'doc_number', 0, 'doc_date', public.il_today(), 'customer_name', 'מיכל',
    'lines', '[{"name": "טיפול", "qty": 1, "unitPriceExVat": 50, "discountExVat": 0, "totalExVat": 50, "vatRate": 0, "kind": 1}]'::jsonb,
    'payments', '[]'::jsonb, 'before_discount', 50, 'discount', 0, 'after_discount', 50, 'vat_amount', 0, 'total', 50, 'vat_rate', 0, 'idempotency_key', 'direct:pl-4'));
  perform pg_temp.issue(jsonb_build_object('id', '00000000-0000-0000-0000-00000000e302', 'user_id', '00000000-0000-0000-0000-00000000e405',
    'business_id', '00000000-0000-0000-0000-00000000eb02', 'doc_type', 300, 'doc_number', 0, 'doc_date', public.il_today(), 'customer_name', 'מיכל',
    'lines', '[{"name": "טיפול", "qty": 1, "unitPriceExVat": 100, "discountExVat": 0, "totalExVat": 100, "vatRate": 0, "kind": 1}]'::jsonb,
    'payments', '[]'::jsonb, 'before_discount', 100, 'discount', 0, 'after_discount', 100, 'vat_amount', 0, 'total', 100, 'vat_rate', 0, 'idempotency_key', 'direct:pl-5'));
end $$;
begin;
set local role service_role;
create temp table c1 as select pg_temp.link('00000000-0000-0000-0000-00000000eb02', 'document', '00000000-0000-0000-0000-00000000e301', 50) as id;
create temp table c2 as select pg_temp.link('00000000-0000-0000-0000-00000000eb02', 'document', '00000000-0000-0000-0000-00000000e302', 100) as id;
grant select on c1 to public; grant select on c2 to public;
commit;
-- the invoice cancelled (a transaction invoice issued by mistake), and ₪60 of the other one paid by hand meanwhile
insert into public.document_cancellations (document_id, user_id, reason) values ('00000000-0000-0000-0000-00000000e301', '00000000-0000-0000-0000-00000000e405', 'הופקה בטעות');
do $$
begin
  perform pg_temp.issue(jsonb_build_object('user_id', '00000000-0000-0000-0000-00000000e405', 'business_id', '00000000-0000-0000-0000-00000000eb02',
    'doc_type', 400, 'doc_number', 0, 'doc_date', public.il_today(), 'customer_name', 'מיכל', 'paid_document_id', '00000000-0000-0000-0000-00000000e302',
    'lines', '[{"name": "תשלום", "qty": 1, "unitPriceExVat": 60, "discountExVat": 0, "totalExVat": 60, "vatRate": 0, "kind": 1}]'::jsonb,
    'payments', jsonb_build_array(jsonb_build_object('method', 1, 'amount', 60, 'date', public.il_today())),
    'before_discount', 60, 'discount', 0, 'after_discount', 60, 'vat_amount', 0, 'total', 60, 'vat_rate', 0, 'idempotency_key', 'direct:pl-6'));
end $$;
begin;
set local role service_role;
select pg_temp.check(public.sf_paylink_page((select id from c1), 'pp_c1', 'https://payments.payplus.test/pp_c1') = 'closed', 'a cancelled invoice: no page');
select pg_temp.check(public.sf_paylink_page((select id from c2), 'pp_c2', 'https://payments.payplus.test/pp_c2') = 'closed',
  'paid by hand meanwhile (₪40 left, the link asks ₪100): no page');
select pg_temp.check((select jsonb_array_length(pages) = 0 from pg_temp.req((select id from c2))), 'nothing kept');
commit;
-- the accepted quote cancelled; an appointment cancelled
begin;
set local role service_role;
insert into public.quotes (id, user_id, business_id, status, customer_name, before_discount, after_discount, vat_rate, vat_amount, total) values
  ('00000000-0000-0000-0000-00000000e603', '00000000-0000-0000-0000-00000000e401', '00000000-0000-0000-0000-00000000eb01', 'sent', 'דנה', 100, 100, 18, 18, 118);
update public.quotes set status = 'accepted' where id = '00000000-0000-0000-0000-00000000e603';
create temp table c3 as select pg_temp.link('00000000-0000-0000-0000-00000000eb01', 'quote', '00000000-0000-0000-0000-00000000e603', 118) as id;
grant select on c3 to public;
update public.quotes set status = 'cancelled' where id = '00000000-0000-0000-0000-00000000e603';
select pg_temp.check(public.sf_paylink_page((select id from c3), 'mp_c3', 'https://pay.test/mp_c3') = 'closed', 'a cancelled quote: no page');
insert into public.appointments (id, user_id, business_id, service_id, lead_id, service_name, name, phone, email, start_at, end_at, source) values
  ('00000000-0000-0000-0000-00000000ea05', '00000000-0000-0000-0000-00000000e401', '00000000-0000-0000-0000-00000000eb01', '00000000-0000-0000-0000-00000000e501',
   '00000000-0000-0000-0000-00000000ec01', 'לייזר רגליים', 'נועה', '0501111111', '', now() + interval '5 days', now() + interval '5 days 45 minutes', 'manual');
create temp table c4 as select pg_temp.link('00000000-0000-0000-0000-00000000eb01', 'deposit', '00000000-0000-0000-0000-00000000ea05', 0) as id;
grant select on c4 to public;
select pg_temp.check(public.sf_paylink_page((select id from c4), 'mp_c4', 'https://pay.test/mp_c4') = 'ok', 'an open appointment: a page');
update public.appointments set status = 'cancelled' where id = '00000000-0000-0000-0000-00000000ea05';
select pg_temp.check(public.sf_paylink_page((select id from c4), 'mp_c4b', 'https://pay.test/mp_c4b') = 'closed', 'a cancelled appointment: no new page');
select pg_temp.check((public.sf_paylink_paid((select id from c4), 'mp_c4', 'mock', 'txn-c4', 100, 'ILS')->>'result') = 'ok',
  'a payment already on its way is still recorded (the money was taken)');
commit;

