-- Payment plans, scheduled debt reminders and a duplicate expense (migration 20261010004400, docs/FINANCE_ADDITIONS_HE.md T3 + T5 + T6)
-- on a real Postgres (tests/sql/run.sh). The screens' calls run as the signed-in roles; the timer's as service_role (the dashboard's
-- server). Fixtures only, with ids of their own:
--   Clinic A (company, VAT 18%)  owner OA, staff SA (editor, money open), cashier KA, viewer VA
--                                customers NOA (phone + email), DANA (phone only), RONI (neither)
--   Clinic B (exempt dealer)     owner OB, customer MICHAL
--   super admin ZZ (a member of neither)
-- The Definition of Done: a payment stops a reminder; without the owner's approval nothing is sent; a file uploaded twice is
-- found, and the owner can say it is another expense. Every check raises "CHECK FAILED: …" when the database does not behave.
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
-- a tax invoice of clinic A (305), dated p_doc days from today, due p_due days from today
create or replace function pg_temp.inv(p_id text, p_lead text, p_name text, p_phone text, p_email text, p_before numeric, p_vat numeric, p_total numeric,
                                       p_doc int, p_due int) returns uuid language sql as $$
  select pg_temp.issue(jsonb_build_object('id', p_id, 'user_id', '00000000-0000-0000-0000-00000000f401', 'business_id', '00000000-0000-0000-0000-00000000fb01',
    'doc_type', 305, 'doc_number', 0, 'doc_date', public.il_today() + p_doc, 'due_date', public.il_today() + p_due, 'customer_name', p_name,
    'customer_phone', p_phone, 'customer_email', p_email, 'lead_id', p_lead,
    'lines', jsonb_build_array(jsonb_build_object('name', 'טיפול', 'qty', 1, 'unitPriceExVat', p_before, 'discountExVat', 0, 'totalExVat', p_before, 'vatRate', 18, 'kind', 1)),
    'payments', '[]'::jsonb, 'before_discount', p_before, 'discount', 0, 'after_discount', p_before, 'vat_amount', p_vat, 'total', p_total, 'vat_rate', 18,
    'idempotency_key', 'direct:pr-' || p_id))
$$;
-- a receipt (400) on an invoice of clinic A
create or replace function pg_temp.receipt(p_invoice text, p_amount numeric, p_key text) returns uuid language sql as $$
  select pg_temp.issue(jsonb_build_object('user_id', '00000000-0000-0000-0000-00000000f401', 'business_id', '00000000-0000-0000-0000-00000000fb01',
    'doc_type', 400, 'doc_number', 0, 'doc_date', public.il_today(), 'customer_name', 'לקוח', 'paid_document_id', p_invoice, 'source', 'receipt',
    'lines', jsonb_build_array(jsonb_build_object('name', 'תשלום', 'qty', 1, 'unitPriceExVat', p_amount, 'discountExVat', 0, 'totalExVat', p_amount, 'vatRate', 0, 'kind', 1)),
    'payments', jsonb_build_array(jsonb_build_object('method', 4, 'm', 'transfer', 'amount', p_amount, 'date', public.il_today())),
    'before_discount', p_amount, 'discount', 0, 'after_discount', p_amount, 'vat_amount', 0, 'total', p_amount, 'vat_rate', 0, 'idempotency_key', p_key))
$$;
-- the lines of an invoice, as the screens read them: "n:open" in order (the invoice's own line: "-:open")
create or replace function pg_temp.lines(p text) returns text language sql as $$
  select string_agg(coalesce(n::text, '-') || ':' || trim_scale(open_amount), ' ' order by n nulls last) from public.receivable_lines where document_id = p::uuid;
$$;
-- an hour on an Israeli date (the timer's clock); a weekday at or after today (the timer queues nothing on Saturday)
create or replace function pg_temp.il_at(d date, h int) returns timestamptz language sql as $$ select (d + make_time(h, 0, 0)) at time zone 'Asia/Jerusalem' $$;
create or replace function pg_temp.workday(p int default 0) returns date language sql as $$
  select public.il_today() + p + case when extract(isodow from public.il_today() + p) = 6 then 1 else 0 end
$$;
create or replace function pg_temp.reminder(p_doc text, p_step int, p_item_n int default null) returns public.debt_reminders language sql as $$
  select q.* from public.debt_reminders q left join public.payment_plan_items it on it.id = q.item_id
   where q.document_id = p_doc::uuid and q.step = p_step and (p_item_n is null and q.item_id is null or it.n = p_item_n)
$$;

-- ---- the world --------------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000f401', 'oa@pr-a.test'), ('00000000-0000-0000-0000-00000000f402', 'sa@pr-a.test'),
  ('00000000-0000-0000-0000-00000000f403', 'ka@pr-a.test'), ('00000000-0000-0000-0000-00000000f404', 'va@pr-a.test'),
  ('00000000-0000-0000-0000-00000000f405', 'ob@pr-b.test'), ('00000000-0000-0000-0000-00000000f406', 'zz@platform.test');
update public.profiles set is_super_admin = true where id = '00000000-0000-0000-0000-00000000f406';
insert into public.businesses (id, name, slug) values
  ('00000000-0000-0000-0000-00000000fb01', 'Clinic A', 'pr-clinic-a'), ('00000000-0000-0000-0000-00000000fb02', 'Clinic B', 'pr-clinic-b');
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-00000000fb01', '00000000-0000-0000-0000-00000000f401', 'owner', 'full'),
  ('00000000-0000-0000-0000-00000000fb01', '00000000-0000-0000-0000-00000000f402', 'editor', 'full'),
  ('00000000-0000-0000-0000-00000000fb01', '00000000-0000-0000-0000-00000000f403', 'editor', 'register'),
  ('00000000-0000-0000-0000-00000000fb01', '00000000-0000-0000-0000-00000000f404', 'viewer', 'full'),
  ('00000000-0000-0000-0000-00000000fb02', '00000000-0000-0000-0000-00000000f405', 'owner', 'full');
update public.profiles set current_business_id = '00000000-0000-0000-0000-00000000fb01'
 where id in ('00000000-0000-0000-0000-00000000f401', '00000000-0000-0000-0000-00000000f402', '00000000-0000-0000-0000-00000000f403',
              '00000000-0000-0000-0000-00000000f404', '00000000-0000-0000-0000-00000000f406');
update public.profiles set current_business_id = '00000000-0000-0000-0000-00000000fb02' where id = '00000000-0000-0000-0000-00000000f405';
insert into public.register_settings (user_id, business_id, business_type, vat_rate, dealer_number, legal_name, street, city, entity_type) values
  ('00000000-0000-0000-0000-00000000f401', '00000000-0000-0000-0000-00000000fb01', 'licensed', 18, '514000004', 'קליניקה א בע"מ', 'הרצל', 'תל אביב', 'company'),
  ('00000000-0000-0000-0000-00000000f405', '00000000-0000-0000-0000-00000000fb02', 'licensed', 18, '123456782', 'קליניקה ב', 'הגפן', 'חיפה', 'exempt_dealer');
insert into public.leads (id, user_id, business_id, name, phone, email) values
  ('00000000-0000-0000-0000-00000000fc01', '00000000-0000-0000-0000-00000000f401', '00000000-0000-0000-0000-00000000fb01', 'נועה', '0501111111', 'noa@x.test'),
  ('00000000-0000-0000-0000-00000000fc02', '00000000-0000-0000-0000-00000000f401', '00000000-0000-0000-0000-00000000fb01', 'דנה', '0502222222', ''),
  ('00000000-0000-0000-0000-00000000fc03', '00000000-0000-0000-0000-00000000f401', '00000000-0000-0000-0000-00000000fb01', 'רוני', '', ''),
  ('00000000-0000-0000-0000-00000000fc04', '00000000-0000-0000-0000-00000000f405', '00000000-0000-0000-0000-00000000fb02', 'מיכל', '0503333333', '');
-- A's invoices (305):             to      total   dated     due
--   f001  late 30 days            נועה    1,180   −40       −30     an email reminder, the last step
--   f002  not due yet             דנה       590     0       +30
--   f003  late 10 days            רוני      118   −20       −10     no phone, no email: nothing automatic
--   f004  for a plan              נועה    2,950     0         0
--   f005  a plan (made earlier)   דנה     1,180     0       +60     its first payment (₪590) was due 5 days ago
--   f006  late 10 days            נועה      590   −15       −10     an email, step 2
--   f007  late 8 days             דנה       118   −10        −8     WhatsApp, step 2
--   f008  late 60 days            דנה       236   −70       −60     too old for an automatic reminder (14 + 30 days)
--   f010  paid, then refunded     נועה    1,180     0         0
--   f011  late 4 days             דנה       118    −6        −4     WhatsApp, step 1 (skipped by the owner)
--   f012  late 3 days             דנה       118    −5        −3     WhatsApp, step 1 → step 2 four days later
do $$
begin
  perform pg_temp.inv('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000fc01', 'נועה', '0501111111', 'noa@x.test', 1000, 180, 1180, -40, -30);
  perform pg_temp.inv('00000000-0000-0000-0000-00000000f002', '00000000-0000-0000-0000-00000000fc02', 'דנה', '0502222222', '', 500, 90, 590, 0, 30);
  perform pg_temp.inv('00000000-0000-0000-0000-00000000f003', '00000000-0000-0000-0000-00000000fc03', 'רוני', '', '', 100, 18, 118, -20, -10);
  perform pg_temp.inv('00000000-0000-0000-0000-00000000f004', '00000000-0000-0000-0000-00000000fc01', 'נועה', '0501111111', 'noa@x.test', 2500, 450, 2950, 0, 0);
  perform pg_temp.inv('00000000-0000-0000-0000-00000000f005', '00000000-0000-0000-0000-00000000fc02', 'דנה', '0502222222', '', 1000, 180, 1180, 0, 60);
  perform pg_temp.inv('00000000-0000-0000-0000-00000000f006', '00000000-0000-0000-0000-00000000fc01', 'נועה', '0501111111', 'noa@x.test', 500, 90, 590, -15, -10);
  perform pg_temp.inv('00000000-0000-0000-0000-00000000f007', '00000000-0000-0000-0000-00000000fc02', 'דנה', '0502222222', '', 100, 18, 118, -10, -8);
  perform pg_temp.inv('00000000-0000-0000-0000-00000000f008', '00000000-0000-0000-0000-00000000fc02', 'דנה', '0502222222', '', 200, 36, 236, -70, -60);
  perform pg_temp.inv('00000000-0000-0000-0000-00000000f010', '00000000-0000-0000-0000-00000000fc01', 'נועה', '0501111111', 'noa@x.test', 1000, 180, 1180, 0, 0);
  perform pg_temp.inv('00000000-0000-0000-0000-00000000f011', '00000000-0000-0000-0000-00000000fc02', 'דנה', '0502222222', '', 100, 18, 118, -6, -4);
  perform pg_temp.inv('00000000-0000-0000-0000-00000000f012', '00000000-0000-0000-0000-00000000fc02', 'דנה', '0502222222', '', 100, 18, 118, -5, -3);
  -- a tax invoice-receipt (paid at once): not a plan's
  perform pg_temp.issue(jsonb_build_object('id', '00000000-0000-0000-0000-00000000f009', 'user_id', '00000000-0000-0000-0000-00000000f401',
    'business_id', '00000000-0000-0000-0000-00000000fb01', 'doc_type', 320, 'doc_number', 0, 'doc_date', public.il_today(), 'customer_name', 'נועה',
    'lines', '[{"name": "ייעוץ", "qty": 1, "unitPriceExVat": 100, "discountExVat": 0, "totalExVat": 100, "vatRate": 18, "kind": 1}]'::jsonb,
    'payments', jsonb_build_array(jsonb_build_object('method', 1, 'amount', 118, 'date', public.il_today())),
    'before_discount', 100, 'discount', 0, 'after_discount', 100, 'vat_amount', 18, 'total', 118, 'vat_rate', 18, 'idempotency_key', 'direct:pr-320'));
  -- B's transaction invoice to Michal, late
  perform pg_temp.issue(jsonb_build_object('id', '00000000-0000-0000-0000-00000000f0b1', 'user_id', '00000000-0000-0000-0000-00000000f405',
    'business_id', '00000000-0000-0000-0000-00000000fb02', 'doc_type', 300, 'doc_number', 0, 'doc_date', public.il_today() - 20,
    'due_date', public.il_today() - 10, 'customer_name', 'מיכל', 'customer_phone', '0503333333', 'lead_id', '00000000-0000-0000-0000-00000000fc04',
    'lines', '[{"name": "טיפול", "qty": 1, "unitPriceExVat": 400, "discountExVat": 0, "totalExVat": 400, "vatRate": 0, "kind": 1}]'::jsonb,
    'payments', '[]'::jsonb, 'before_discount', 400, 'discount', 0, 'after_discount', 400, 'vat_amount', 0, 'total', 400, 'vat_rate', 0,
    'idempotency_key', 'direct:pr-b1'));
end $$;
-- f005's plan was made before today (its first payment's date has passed): written as it would be, without the function's
-- "no date in the past" (which holds only when a plan is made)
insert into public.payment_plans (id, business_id, user_id, document_id, lead_id, total, payments) values
  ('00000000-0000-0000-0000-00000000f705', '00000000-0000-0000-0000-00000000fb01', '00000000-0000-0000-0000-00000000f401',
   '00000000-0000-0000-0000-00000000f005', '00000000-0000-0000-0000-00000000fc02', 1180, 2);
insert into public.payment_plan_items (plan_id, business_id, n, due_date, amount) values
  ('00000000-0000-0000-0000-00000000f705', '00000000-0000-0000-0000-00000000fb01', 1, public.il_today() - 5, 590),
  ('00000000-0000-0000-0000-00000000f705', '00000000-0000-0000-0000-00000000fb01', 2, public.il_today() + 25, 590);

-- ======================================================================================================================
-- 1. making a plan: the money's writers only, the payments add up to the balance to the agora, dates ahead and in order
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000f401');
create temp table pi (j jsonb);
grant all on pi to public;
insert into pi values (jsonb_build_array(jsonb_build_object('amount', 1000, 'due', public.il_today()), jsonb_build_object('amount', 1000, 'due', public.il_today() + 30),
                                         jsonb_build_object('amount', 950, 'due', public.il_today() + 60)));
select pg_temp.refused_with($$select public.payment_plan_create('00000000-0000-0000-0000-00000000f701', '00000000-0000-0000-0000-00000000f004',
  jsonb_build_array(jsonb_build_object('amount', 1000, 'due', public.il_today()), jsonb_build_object('amount', 1949.99, 'due', public.il_today() + 30)))$$,
  'plan_sum', 'payments that miss the balance by an agora are refused');
select pg_temp.refused_with($$select public.payment_plan_create('00000000-0000-0000-0000-00000000f701', '00000000-0000-0000-0000-00000000f004',
  jsonb_build_array(jsonb_build_object('amount', 2950, 'due', public.il_today())))$$, 'plan_count', 'one payment is not a plan');
select pg_temp.refused_with($$select public.payment_plan_create('00000000-0000-0000-0000-00000000f701', '00000000-0000-0000-0000-00000000f004',
  (select jsonb_agg(jsonb_build_object('amount', 0.01, 'due', public.il_today() + g)) from generate_series(1, 37) g))$$, 'plan_count', '37 payments are too many');
select pg_temp.refused_with($$select public.payment_plan_create('00000000-0000-0000-0000-00000000f701', '00000000-0000-0000-0000-00000000f004',
  jsonb_build_array(jsonb_build_object('amount', 1000, 'due', public.il_today() - 1), jsonb_build_object('amount', 1950, 'due', public.il_today() + 30)))$$,
  'plan_date', 'a payment dated in the past');
select pg_temp.refused_with($$select public.payment_plan_create('00000000-0000-0000-0000-00000000f701', '00000000-0000-0000-0000-00000000f004',
  jsonb_build_array(jsonb_build_object('amount', 1000, 'due', public.il_today() + 30), jsonb_build_object('amount', 1950, 'due', public.il_today() + 30)))$$,
  'plan_date', 'two payments on the same day (each after the one before)');
select pg_temp.refused_with($$select public.payment_plan_create('00000000-0000-0000-0000-00000000f701', '00000000-0000-0000-0000-00000000f004',
  jsonb_build_array(jsonb_build_object('amount', 1000, 'due', public.il_today()), jsonb_build_object('amount', 1950, 'due', public.il_today() + 1900)))$$,
  'plan_date', 'more than 5 years ahead');
select pg_temp.refused_with($$select public.payment_plan_create('00000000-0000-0000-0000-00000000f701', '00000000-0000-0000-0000-00000000f004',
  jsonb_build_array(jsonb_build_object('amount', 1000.005, 'due', public.il_today()), jsonb_build_object('amount', 1949.995, 'due', public.il_today() + 30)))$$,
  'plan_amount', 'less than an agora');
select pg_temp.refused_with($$select public.payment_plan_create('00000000-0000-0000-0000-00000000f701', '00000000-0000-0000-0000-00000000f004',
  jsonb_build_array(jsonb_build_object('amount', 0, 'due', public.il_today()), jsonb_build_object('amount', 2950, 'due', public.il_today() + 30)))$$,
  'plan_amount', 'a payment of nothing');
select pg_temp.refused_with($$select public.payment_plan_create('00000000-0000-0000-0000-00000000f701', '00000000-0000-0000-0000-00000000f004',
  jsonb_build_array(jsonb_build_object('amount', 'x', 'due', public.il_today()), jsonb_build_object('amount', 2950, 'due', public.il_today() + 30)))$$,
  'plan_items', 'a payment that is not a number');
select pg_temp.refused_with($$select public.payment_plan_create('00000000-0000-0000-0000-00000000f701', '00000000-0000-0000-0000-00000000f009', (select j from pi))$$,
  'plan_not_invoice', 'a tax invoice-receipt (paid) has no plan');
select pg_temp.refused_with($$select public.payment_plan_create('00000000-0000-0000-0000-00000000f701', '00000000-0000-0000-0000-00000000f0b1', (select j from pi))$$,
  'plan_not_found', 'another business''s invoice');
select pg_temp.check((public.payment_plan_create('00000000-0000-0000-0000-00000000f701', '00000000-0000-0000-0000-00000000f004', (select j from pi), 'בהסכמה')->>'result') = 'ok',
  'three payments that add up to ₪2,950: made');
select pg_temp.check((public.payment_plan_create('00000000-0000-0000-0000-00000000f701', '00000000-0000-0000-0000-00000000f004', (select j from pi))->>'result') = 'already',
  'the same call again (its answer was lost): the same plan');
select pg_temp.refused_with($$select public.payment_plan_create('00000000-0000-0000-0000-00000000f702', '00000000-0000-0000-0000-00000000f004', (select j from pi))$$,
  'plan_exists', 'a second plan on the invoice is not made by the way');
select pg_temp.check((select count(*) = 1 from public.payment_plans where document_id = '00000000-0000-0000-0000-00000000f004'), 'one plan on the invoice');
select pg_temp.check((select string_agg(n || ':' || trim_scale(amount) || '@' || (due_date - public.il_today()), ' ' order by n) = '1:1000@0 2:1000@30 3:950@60'
                      from public.payment_plan_items where plan_id = '00000000-0000-0000-0000-00000000f701'), 'its payments, in order');
select pg_temp.check((select (total, payments, status, user_id, lead_id, note) = (2950::numeric, 3, 'active', '00000000-0000-0000-0000-00000000f401'::uuid,
                              '00000000-0000-0000-0000-00000000fc01'::uuid, 'בהסכמה')
                      from public.payment_plans where id = '00000000-0000-0000-0000-00000000f701'), 'the plan keeps the balance, who made it and the customer');
commit;
select pg_temp.check((select count(*) = 1 from public.finance_audit_log where action = 'plan.created' and entity_id = '00000000-0000-0000-0000-00000000f004'),
  'making it is in the log');
select pg_temp.check((select count(*) = 1 from public.lead_activities where lead_id = '00000000-0000-0000-0000-00000000fc01' and body like 'פריסה לתשלומים:%3 תשלומים · ₪2950'),
  'and on the customer''s card');

-- who may not: a cashier, a viewer, a super admin whose access was not opened, nobody signed in
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000f403');
select pg_temp.refused_with($$select public.payment_plan_create('00000000-0000-0000-0000-00000000f703', '00000000-0000-0000-0000-00000000f010',
  jsonb_build_array(jsonb_build_object('amount', 590, 'due', public.il_today()), jsonb_build_object('amount', 590, 'due', public.il_today() + 30)))$$,
  'not allowed', 'a cashier makes no plan');
select pg_temp.check((select count(*) = 0 from public.payment_plans), 'a cashier sees no plan');
select pg_temp.check((select count(*) = 0 from public.receivable_lines), 'nor what is owed');
select pg_temp.as_user('00000000-0000-0000-0000-00000000f404');
select pg_temp.refused_with($$select public.payment_plan_create('00000000-0000-0000-0000-00000000f703', '00000000-0000-0000-0000-00000000f010',
  jsonb_build_array(jsonb_build_object('amount', 590, 'due', public.il_today()), jsonb_build_object('amount', 590, 'due', public.il_today() + 30)))$$,
  'not allowed', 'a viewer makes no plan');
select pg_temp.refused_with($$select public.payment_plan_cancel('00000000-0000-0000-0000-00000000f701', 'x')$$, 'not allowed', 'nor cancels one');
select pg_temp.check((select count(*) = 2 from public.payment_plans), 'a viewer reads the plans');
select pg_temp.as_user('00000000-0000-0000-0000-00000000f406');
select pg_temp.refused_with($$select public.payment_plan_create('00000000-0000-0000-0000-00000000f703', '00000000-0000-0000-0000-00000000f010',
  jsonb_build_array(jsonb_build_object('amount', 590, 'due', public.il_today()), jsonb_build_object('amount', 590, 'due', public.il_today() + 30)))$$,
  'not allowed', 'a super admin without an opened access makes no plan');
select pg_temp.check((select count(*) = 0 from public.payment_plans), 'and sees none');
select pg_temp.as_user('00000000-0000-0000-0000-00000000f405');
select pg_temp.check((select count(*) = 0 from public.payment_plans) and (select count(*) = 1 from public.receivable_lines), 'clinic B sees only its own');
commit;
begin;
set local role anon;
select pg_temp.refused($$select public.payment_plan_create(gen_random_uuid(), '00000000-0000-0000-0000-00000000f010', '[]'::jsonb)$$, 'nobody signed in');
select pg_temp.refused($$select count(*) from public.payment_plans$$, 'anon reads no plan');
commit;

-- ======================================================================================================================
-- 2. what is owed, by date: a payment covers the first payments of the plan; cancelled — the invoice's own line again
-- ======================================================================================================================
select pg_temp.check(pg_temp.lines('00000000-0000-0000-0000-00000000f004') = '1:1000 2:1000 3:950', 'three open payments');
select pg_temp.check(pg_temp.lines('00000000-0000-0000-0000-00000000f001') = '-:1180', 'an invoice without a plan: one line, its balance');
select pg_temp.receipt('00000000-0000-0000-0000-00000000f004', 1500, 'receipt:pr-1');
select pg_temp.check(pg_temp.lines('00000000-0000-0000-0000-00000000f004') = '1:0 2:500 3:950', '₪1,500 paid: the first payment and half the second');
select pg_temp.check((select sum(open_amount) = 1450 from public.receivable_lines where document_id = '00000000-0000-0000-0000-00000000f004'),
  'the lines add up to the balance');
select pg_temp.receipt('00000000-0000-0000-0000-00000000f004', 1450, 'receipt:pr-2');
select pg_temp.check(pg_temp.lines('00000000-0000-0000-0000-00000000f004') = '1:0 2:0 3:0', 'all paid: every payment closed');

-- f010: ₪180 paid, a plan of the ₪1,000 left — then the receipt is cancelled (money given back): ₪180 owed beyond the plan
select pg_temp.issue(jsonb_build_object('id', '00000000-0000-0000-0000-00000000f410', 'user_id', '00000000-0000-0000-0000-00000000f401',
  'business_id', '00000000-0000-0000-0000-00000000fb01', 'doc_type', 400, 'doc_number', 0, 'doc_date', public.il_today(), 'customer_name', 'נועה',
  'paid_document_id', '00000000-0000-0000-0000-00000000f010', 'source', 'receipt',
  'lines', '[{"name": "תשלום", "qty": 1, "unitPriceExVat": 180, "discountExVat": 0, "totalExVat": 180, "vatRate": 0, "kind": 1}]'::jsonb,
  'payments', jsonb_build_array(jsonb_build_object('method', 1, 'amount', 180, 'date', public.il_today())),
  'before_discount', 180, 'discount', 0, 'after_discount', 180, 'vat_amount', 0, 'total', 180, 'vat_rate', 0, 'idempotency_key', 'receipt:pr-3'));
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000f402');
select pg_temp.check((public.payment_plan_create('00000000-0000-0000-0000-00000000f710', '00000000-0000-0000-0000-00000000f010',
  jsonb_build_array(jsonb_build_object('amount', 500, 'due', public.il_today() + 10), jsonb_build_object('amount', 500, 'due', public.il_today() + 40)))->>'result') = 'ok',
  'the staff (money open) make a plan of what is left (₪1,000)');
commit;
insert into public.document_cancellations (document_id, user_id, reason) values ('00000000-0000-0000-0000-00000000f410', '00000000-0000-0000-0000-00000000f401', 'הופקה בטעות');
select pg_temp.check(pg_temp.lines('00000000-0000-0000-0000-00000000f010') = '1:500 2:500 -:180', 'more owed than the plan: a line of its own');
select pg_temp.check((select due_date = public.il_today() from public.receivable_lines where document_id = '00000000-0000-0000-0000-00000000f010' and n is null),
  'due at the invoice''s date');

-- cancelled, made again (replacing), and the rules of what never changes
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000f401');
select pg_temp.check((public.payment_plan_create('00000000-0000-0000-0000-00000000f711', '00000000-0000-0000-0000-00000000f010',
  jsonb_build_array(jsonb_build_object('amount', 590, 'due', public.il_today() + 5), jsonb_build_object('amount', 590, 'due', public.il_today() + 35)), '', true)->>'result') = 'ok',
  'a new plan replaces the old one when asked');
select pg_temp.check((select status = 'cancelled' and cancel_reason = 'הוחלפה בפריסה חדשה' from public.payment_plans where id = '00000000-0000-0000-0000-00000000f710'),
  'the old one: cancelled, with why');
select pg_temp.check(pg_temp.lines('00000000-0000-0000-0000-00000000f010') = '1:590 2:590', 'the new payments are what is owed');
select pg_temp.check((public.payment_plan_cancel('00000000-0000-0000-0000-00000000f711', 'הלקוחה שילמה במזומן')->>'result') = 'ok', 'cancelled');
select pg_temp.check((public.payment_plan_cancel('00000000-0000-0000-0000-00000000f711', 'שוב')->>'result') = 'already', 'once');
select pg_temp.check(pg_temp.lines('00000000-0000-0000-0000-00000000f010') = '-:1180', 'no plan: the invoice''s own line again');
commit;
select pg_temp.check((select count(*) = 2 from public.finance_audit_log where action = 'plan.cancelled' and entity_id = '00000000-0000-0000-0000-00000000f010'),
  'both cancellations are in the log');
select pg_temp.refused($$update public.payment_plan_items set amount = 1 where plan_id = '00000000-0000-0000-0000-00000000f701'$$, 'a payment of a plan never changes');
select pg_temp.refused($$update public.payment_plans set total = 1 where id = '00000000-0000-0000-0000-00000000f701'$$, 'nor the plan''s total');
select pg_temp.refused($$update public.payment_plans set status = 'active', cancelled_at = null where id = '00000000-0000-0000-0000-00000000f711'$$, 'a cancelled plan stays cancelled');
select pg_temp.refused($$delete from public.payment_plans where id = '00000000-0000-0000-0000-00000000f711'$$, 'a plan is never deleted');
select pg_temp.refused($$delete from public.payment_plan_items where plan_id = '00000000-0000-0000-0000-00000000f711'$$, 'nor its payments');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000f401');
select pg_temp.refused($$insert into public.payment_plans (business_id, document_id, total, payments) values ('00000000-0000-0000-0000-00000000fb01',
  '00000000-0000-0000-0000-00000000f002', 590, 2)$$, 'the screens do not write plans themselves (only the functions)');
commit;

-- ======================================================================================================================
-- 3. the money screens' "overdue": by the lines (f005's first payment is late; as an invoice it is due in 60 days)
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000f401');
create temp table fs as select public.finance_summary(public.il_today() - 365, public.il_today())->'receivables' as r;
grant select on fs to public;
-- open: f001 1,180 + f002 590 + f003 118 + f005 1,180 + f006 590 + f007 118 + f008 236 + f010 1,180 + f011 118 + f012 118 (f004 paid)
select pg_temp.check((select (r->>'open')::numeric = 5428 and (r->>'count')::int = 10 from fs), 'open: every invoice''s balance (' || (select r::text from fs) || ')');
-- overdue: f001 1,180 + f003 118 + f005's first payment 590 + f006 590 + f007 118 + f008 236 + f011 118 + f012 118 — not f005's second
select pg_temp.check((select (r->>'overdue')::numeric = 3068 and (r->>'overdueCount')::int = 8 from fs), 'overdue: by the plan''s dates (' || (select r::text from fs) || ')');
commit;

-- ======================================================================================================================
-- 4. reminders: off until the owner approves; queued by the timer on the hours customers expect; a payment stops them
-- ======================================================================================================================
-- nothing is queued while reminders are off
begin;
set local role service_role;
select pg_temp.check((select (r->>'emails')::int = 0 and (r->>'whatsapp')::int = 0 from public.debt_reminders_queue(pg_temp.il_at(pg_temp.workday(), 10)) r),
  'reminders off: the timer queues nothing');
commit;
select pg_temp.check((select count(*) = 0 from public.debt_reminders), 'no reminder exists');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000f402');
select pg_temp.refused_with($$select public.debt_reminders_configure(true, '{3,7,14}', 'email')$$, 'reminders_owner', 'the staff do not turn reminders on');
select pg_temp.check((select (p->>'email')::int = 2 and (p->>'whatsapp')::int = 4 from public.debt_reminders_preview('{3,7,14}', 'email') p),
  'the approval screen: 2 emails (נועה) and 4 WhatsApp (דנה) would go now — not רוני (no address), not f008 (too old)');
select pg_temp.as_user('00000000-0000-0000-0000-00000000f403');
select pg_temp.refused_with($$select public.debt_reminders_configure(false, '{3}', 'email')$$, 'not allowed', 'a cashier does not touch reminders');
select pg_temp.as_user('00000000-0000-0000-0000-00000000f404');
select pg_temp.refused_with($$select public.debt_reminders_configure(false, '{3}', 'email')$$, 'not allowed', 'nor a viewer');
select pg_temp.as_user('00000000-0000-0000-0000-00000000f406');
select pg_temp.refused_with($$select public.debt_reminders_configure(true, '{3}', 'email')$$, 'not allowed', 'nor a super admin');
select pg_temp.as_user('00000000-0000-0000-0000-00000000f401');
select pg_temp.refused_with($$select public.debt_reminders_configure(true, '{}', 'email')$$, 'reminders_days', 'no day');
select pg_temp.refused_with($$select public.debt_reminders_configure(true, '{0}', 'email')$$, 'reminders_days', 'day 0');
select pg_temp.refused_with($$select public.debt_reminders_configure(true, '{121}', 'email')$$, 'reminders_days', 'more than 120 days');
select pg_temp.refused_with($$select public.debt_reminders_configure(true, '{1,2,3,4,5,6}', 'email')$$, 'reminders_days', 'six days');
select pg_temp.refused_with($$select public.debt_reminders_configure(true, '{3}', 'sms')$$, 'reminders_channel', 'a channel that does not exist');
select pg_temp.check((select (s->>'enabled')::boolean and s->>'days' = '[3, 7, 14]' and s->>'approved_by' = '00000000-0000-0000-0000-00000000f401'
                      from public.debt_reminders_configure(true, '{14,3,7,7}', 'email') s), 'the owner turns them on: sorted, once each, approved by the owner');
commit;
select pg_temp.check((select count(*) = 1 from public.finance_audit_log where action = 'reminders.enabled' and business_id = '00000000-0000-0000-0000-00000000fb01'),
  'the approval is in the log');

-- the hours: Saturday and the early morning queue nothing
begin;
set local role service_role;
select pg_temp.check((select (r->>'quiet')::boolean and (r->>'emails')::int = 0 from public.debt_reminders_queue(
  pg_temp.il_at(public.il_today() + ((6 - extract(isodow from public.il_today())::int + 7) % 7), 12)) r), 'Saturday: nothing');
select pg_temp.check((select (r->>'quiet')::boolean from public.debt_reminders_queue(pg_temp.il_at(pg_temp.workday(), 7)) r), '07:00: nothing');
select pg_temp.check((select count(*) = 0 from public.debt_reminders), 'still no reminder');
-- a weekday at 10:00
create temp table q1 as select public.debt_reminders_queue(pg_temp.il_at(pg_temp.workday(), 10)) as r;
grant select on q1 to public;
select pg_temp.check((select (r->>'emails')::int = 2 and (r->>'whatsapp')::int = 4 and (r->'businesses'->>'00000000-0000-0000-0000-00000000fb01')::int = 4 from q1),
  'the timer: 2 emails and 4 in the WhatsApp queue, as the approval screen said (' || (select r::text from q1) || ')');
select pg_temp.check((select (r->>'emails')::int = 0 and (r->>'whatsapp')::int = 0 from public.debt_reminders_queue(pg_temp.il_at(pg_temp.workday(), 11)) r),
  'the next run queues nothing again (once per line and step)');
commit;
select pg_temp.check((select (tone, channel, to_address, amount, days) = ('final', 'email', 'noa@x.test', 1180::numeric, 14)
                      from pg_temp.reminder('00000000-0000-0000-0000-00000000f001', 3)), 'f001 (a month late): the last step, by email, the full balance');
select pg_temp.check((select count(*) = 0 from public.debt_reminders where document_id = '00000000-0000-0000-0000-00000000f001' and step < 3),
  'the steps that were missed are not sent late');
select pg_temp.check((select (tone, channel) = ('firm', 'email') from pg_temp.reminder('00000000-0000-0000-0000-00000000f006', 2)), 'f006: step 2');
select pg_temp.check((select (tone, channel, to_address, amount) = ('friendly', 'whatsapp', '0502222222', 590::numeric)
                      from pg_temp.reminder('00000000-0000-0000-0000-00000000f005', 1, 1)), 'f005''s first payment (a plan): step 1, WhatsApp, its own ₪590');
select pg_temp.check((select count(*) = 0 from public.debt_reminders where document_id in ('00000000-0000-0000-0000-00000000f003', '00000000-0000-0000-0000-00000000f008',
                      '00000000-0000-0000-0000-00000000f002', '00000000-0000-0000-0000-00000000f0b1')), 'not רוני (no address), not f008 (too old), not f002 (not due), not clinic B (off)');
select pg_temp.check((select count(*) = 2 from public.email_outbox o join public.debt_reminders q on q.id = o.reminder_id
                      where o.kind = 'debt_reminder' and o.order_id is null and o.store_id is null and o.to_email = 'noa@x.test' and q.email_id = o.id),
  'the two emails wait in the one outbox');

-- an email is sent: kept on the customer's card and in the log
begin;
set local role service_role;
select pg_temp.check((public.debt_reminder_check((pg_temp.reminder('00000000-0000-0000-0000-00000000f001', 3)).id)->>'state') = 'ok', 'still owed: it may go');
select pg_temp.check(public.email_outbox_done((pg_temp.reminder('00000000-0000-0000-0000-00000000f001', 3)).email_id, 're_123', '', false) = 'sent', 'Resend took it');
select pg_temp.check(public.email_outbox_done((pg_temp.reminder('00000000-0000-0000-0000-00000000f001', 3)).email_id, 're_123', '', false) = 'sent', 'twice: still once');
commit;
select pg_temp.check((select status = 'sent' and sent_at is not null from pg_temp.reminder('00000000-0000-0000-0000-00000000f001', 3)), 'the reminder: sent');
select pg_temp.check((select count(*) = 1 from public.lead_activities where lead_id = '00000000-0000-0000-0000-00000000fc01' and kind = 'email'
                      and body like 'תזכורת תשלום אוטומטית במייל: חשבונית מס מס׳ % · ₪1180'), 'on Noa''s card, once');
select pg_temp.check((select count(*) = 1 from public.finance_audit_log where action = 'reminder.sent' and entity_id = '00000000-0000-0000-0000-00000000f001'
                      and details->>'channel' = 'email' and (details->>'auto')::boolean), 'in the log, once');

-- a payment stops an email that has not gone yet
select pg_temp.receipt('00000000-0000-0000-0000-00000000f006', 590, 'receipt:pr-6');
begin;
set local role service_role;
select pg_temp.check((public.debt_reminder_check((pg_temp.reminder('00000000-0000-0000-0000-00000000f006', 2)).id)->>'state') = 'paid', 'paid meanwhile: it does not go');
commit;
select pg_temp.check((select (status, cancel_reason) = ('cancelled', 'paid') from pg_temp.reminder('00000000-0000-0000-0000-00000000f006', 2)), 'cancelled, because it was paid');
select pg_temp.check((select count(*) = 0 from public.lead_activities where lead_id = '00000000-0000-0000-0000-00000000fc01' and body like '%₪590%'), 'nothing on the card');

-- the WhatsApp queue: the staff send one; a payment stops another; the owner lets one go
select pg_temp.receipt('00000000-0000-0000-0000-00000000f005', 590, 'receipt:pr-5');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000f402');
select pg_temp.check((select count(*) = 4 from public.debt_reminders where channel = 'whatsapp' and status = 'queued'), 'the staff see the queue (4)');
create temp table w1 as select public.debt_reminder_whatsapp((pg_temp.reminder('00000000-0000-0000-0000-00000000f007', 2)).id) as r;
grant select on w1 to public;
select pg_temp.check((select r->>'result' = 'ok' and (r->>'open')::numeric = 118 and r->>'tone' = 'firm' and r->>'shareToken' <> '' from w1),
  'sent: the values of the text come from the invoice as it is now (' || (select r::text from w1) || ')');
select pg_temp.check((public.debt_reminder_whatsapp((pg_temp.reminder('00000000-0000-0000-0000-00000000f007', 2)).id)->>'result') = 'sent', 'twice: already sent');
select pg_temp.check((public.debt_reminder_whatsapp((pg_temp.reminder('00000000-0000-0000-0000-00000000f005', 1, 1)).id)->>'result') = 'paid',
  'f005''s first payment was paid meanwhile: not sent');
select pg_temp.check(public.debt_reminder_skip((pg_temp.reminder('00000000-0000-0000-0000-00000000f011', 1)).id), '"לא עכשיו": the owner lets one go');
select pg_temp.check(not public.debt_reminder_skip((pg_temp.reminder('00000000-0000-0000-0000-00000000f011', 1)).id), 'once');
commit;
select pg_temp.check((select (status, sent_by) = ('sent', '00000000-0000-0000-0000-00000000f402'::uuid) from pg_temp.reminder('00000000-0000-0000-0000-00000000f007', 2)),
  'sent, by whom');
select pg_temp.check((select count(*) = 1 from public.lead_activities where lead_id = '00000000-0000-0000-0000-00000000fc02' and kind = 'whatsapp'
                      and body like 'תזכורת תשלום בוואטסאפ: חשבונית מס מס׳ % · ₪118'), 'on Dana''s card, once');
select pg_temp.check((select (status, cancel_reason) = ('cancelled', 'paid') from pg_temp.reminder('00000000-0000-0000-0000-00000000f005', 1, 1)), 'the paid one: cancelled');
select pg_temp.check((select (status, cancel_reason) = ('cancelled', 'skipped') from pg_temp.reminder('00000000-0000-0000-0000-00000000f011', 1)), 'the skipped one');
select pg_temp.check((select count(*) = 1 from public.finance_audit_log where action = 'reminder.skipped'), 'skipping is in the log');

-- four days later: f012 reaches step 2 — it takes the place of step 1 still waiting in the queue
begin;
set local role service_role;
select public.debt_reminders_queue(pg_temp.il_at(pg_temp.workday(4), 10));
commit;
select pg_temp.check((select (status, tone) = ('queued', 'firm') from pg_temp.reminder('00000000-0000-0000-0000-00000000f012', 2)), 'f012: step 2 queued');
select pg_temp.check((select (status, cancel_reason) = ('cancelled', 'superseded') from pg_temp.reminder('00000000-0000-0000-0000-00000000f012', 1)),
  'its step 1 (never sent) leaves the queue');
select pg_temp.check((select (status, tone) = ('queued', 'firm') from pg_temp.reminder('00000000-0000-0000-0000-00000000f011', 2)),
  'f011 (its step 1 was let go): step 2 comes on its own day');

-- "לא לשלוח" on Dana: what waits for her is cancelled, and nothing new is queued for her; lifted: back
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000f402');
select pg_temp.check(public.debt_reminders_stop('00000000-0000-0000-0000-00000000fc02', true), 'Dana: do not send');
select pg_temp.check(public.debt_reminders_stop('00000000-0000-0000-0000-00000000fc02', true), 'twice: the same');
select pg_temp.refused_with($$select public.debt_reminders_stop('00000000-0000-0000-0000-00000000fc04', true)$$, 'reminder_not_found', 'another business''s customer');
commit;
select pg_temp.check((select count(*) = 0 from public.debt_reminders where lead_id = '00000000-0000-0000-0000-00000000fc02' and status = 'queued'), 'nothing waits for her');
select pg_temp.check((select (status, cancel_reason) = ('cancelled', 'stopped') from pg_temp.reminder('00000000-0000-0000-0000-00000000f012', 2)), 'f012''s step 2: stopped');
select pg_temp.check((select count(*) = 1 from public.debt_reminder_stops where lead_id = '00000000-0000-0000-0000-00000000fc02' and lifted_at is null), 'one mark');
begin;
set local role service_role;
select pg_temp.check((select count(*) = 0 from public.debt_reminders_due('00000000-0000-0000-0000-00000000fb01', '{3,7,14}', 'email', pg_temp.workday(10)) d
                      where d.lead_id = '00000000-0000-0000-0000-00000000fc02'), 'the timer skips her');
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000f401');
select pg_temp.check(not public.debt_reminders_stop('00000000-0000-0000-0000-00000000fc02', false), 'lifted');
commit;
select pg_temp.check((select count(*) = 0 from public.debt_reminder_stops where lead_id = '00000000-0000-0000-0000-00000000fc02' and lifted_at is null)
                     and (select count(*) = 1 from public.debt_reminder_stops where lead_id = '00000000-0000-0000-0000-00000000fc02'), 'kept, as lifted');
select pg_temp.check((select count(*) = 2 from public.lead_activities where lead_id = '00000000-0000-0000-0000-00000000fc02' and kind = 'note'
                      and (body like '%"לא לשלוח"%' or body like 'תזכורות חוב — חזרו לפעול')), 'both on her card');

-- off (the staff may turn them off): what waits is cancelled at once, and the timer queues nothing
begin;
set local role service_role;
select public.debt_reminders_queue(pg_temp.il_at(pg_temp.workday(10), 10));
commit;
select pg_temp.check((select count(*) > 0 from public.debt_reminders where status = 'queued'), 'something waits');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000f402');
select pg_temp.check((select not (s->>'enabled')::boolean from public.debt_reminders_configure(false, '{3,7,14}', 'email') s), 'the staff turn them off');
commit;
select pg_temp.check((select count(*) = 0 from public.debt_reminders where status = 'queued' and (channel = 'whatsapp' or email_id is null
                      or exists (select 1 from public.email_outbox o where o.id = email_id and o.status = 'queued'))), 'nothing waits any more');
select pg_temp.check((select count(*) > 0 from public.debt_reminders where cancel_reason = 'off'), 'cancelled: off');
begin;
set local role service_role;
select pg_temp.check((select (r->>'emails')::int = 0 and (r->>'whatsapp')::int = 0 from public.debt_reminders_queue(pg_temp.il_at(pg_temp.workday(20), 10)) r),
  'off: the timer queues nothing');
commit;
select pg_temp.check((select count(*) = 1 from public.finance_audit_log where action = 'reminders.disabled'), 'turning off is in the log');

-- who sees what, and what never changes
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000f403');
select pg_temp.check((select count(*) = 0 from public.debt_reminders) and (select count(*) = 0 from public.debt_reminder_settings), 'a cashier sees no reminder');
select pg_temp.refused_with($$select public.debt_reminder_whatsapp((select id from public.debt_reminders limit 1))$$, 'not allowed', 'nor sends one');
select pg_temp.as_user('00000000-0000-0000-0000-00000000f405');
select pg_temp.check((select count(*) = 0 from public.debt_reminders), 'clinic B sees none of A''s');
select pg_temp.refused($$select public.debt_reminders_queue(now(), 10)$$, 'the timer''s function is not a member''s');
select pg_temp.refused($$select public.debt_reminder_check(gen_random_uuid())$$, 'nor the email''s check');
commit;
select pg_temp.refused($$update public.debt_reminders set status = 'queued', sent_at = null where status = 'sent'$$, 'a sent reminder stays sent');
select pg_temp.refused($$update public.debt_reminders set step = 5 where document_id = '00000000-0000-0000-0000-00000000f001'$$, 'a reminder keeps what it is about');
select pg_temp.refused($$update public.debt_reminders set cancel_reason = 'paid' where status = 'sent'$$, 'nor why it ended');
select pg_temp.refused($$delete from public.debt_reminders$$, 'a reminder is never deleted');

-- ======================================================================================================================
-- 5. a duplicate expense: the same file, the same supplier and number, or supplier + amount + date — a warning only
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000f401');
insert into public.expenses (id, user_id, supplier_name, supplier_dealer, supplier_doc_type, supplier_doc_number, doc_date, category, amount_before_vat, vat_amount, total, file_sha256) values
  ('00000000-0000-0000-0000-00000000fe01', '00000000-0000-0000-0000-00000000f401', 'אור ספקים בע"מ', '123456782', 'tax_invoice', 'A-0012', public.il_today() - 3, 'materials', 100, 18, 118, repeat('a', 64)),
  ('00000000-0000-0000-0000-00000000fe02', '00000000-0000-0000-0000-00000000f401', 'ספקי הצפון בע"מ', '', 'receipt', '77', public.il_today() - 2, 'office', 236, 0, 236, null),
  ('00000000-0000-0000-0000-00000000fe03', '00000000-0000-0000-0000-00000000f401', 'דפוס הכרמל', '', 'receipt', '000345', public.il_today() - 1, 'office', 50, 0, 50, null);
select pg_temp.check((select string_agg(expense_number || ':' || array_to_string(reasons, ','), ' ') = '1:file'
                      from public.expense_duplicates(repeat('a', 64), '', 'ספק אחר', '', null, null)), 'the same file: found, whatever the form says');
select pg_temp.check((select string_agg(array_to_string(reasons, ','), ' ') = 'number'
                      from public.expense_duplicates(null, '123456782', 'שם אחר', 'a 0012', 50, public.il_today())), 'the same dealer and number (spaces and dashes aside)');
select pg_temp.check((select string_agg(array_to_string(reasons, ','), ' ') = 'number'
                      from public.expense_duplicates(null, '', 'דפוס  הכרמל', '345', null, null)), 'the same name and number (leading zeros aside)');
select pg_temp.check((select string_agg(array_to_string(reasons, ','), ' ') = 'amount_date'
                      from public.expense_duplicates(null, '', 'ספקי הצפון בע״מ', '78', 236, public.il_today() - 2)), 'the same supplier, total and date (another number)');
select pg_temp.check((select string_agg(array_to_string(reasons, ','), ' ') = 'file,number,amount_date'
                      from public.expense_duplicates(repeat('a', 64), '123456782', 'אור ספקים בע"מ', 'A-0012', 118, public.il_today() - 3)), 'all three at once');
select pg_temp.check((select count(*) = 0 from public.expense_duplicates(null, '514000004', 'אור ספקים בע"מ', 'A-0012', 118, public.il_today() - 3)),
  'two dealer numbers that differ: another supplier, even with the same name');
select pg_temp.check((select count(*) = 0 from public.expense_duplicates(null, '', 'ספקי הצפון', '77', 235, public.il_today() - 2)), 'another name, another total: nothing');
select pg_temp.check((select count(*) = 0 from public.expense_duplicates(repeat('a', 64), '', '', '', null, null, '00000000-0000-0000-0000-00000000fe01')),
  'an expense is not its own duplicate');
update public.expenses set status = 'void', void_reason = 'נרשמה פעמיים' where id = '00000000-0000-0000-0000-00000000fe02';
select pg_temp.check((select count(*) = 0 from public.expense_duplicates(null, '', 'ספקי הצפון בע״מ', '78', 236, public.il_today() - 2)), 'a void expense does not count');
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000f405');
select pg_temp.check((select count(*) = 0 from public.expense_duplicates(repeat('a', 64), '', '', '', null, null)), 'clinic B never sees A''s expenses');
select pg_temp.as_user('00000000-0000-0000-0000-00000000f403');
select pg_temp.check((select count(*) = 0 from public.expense_duplicates(repeat('a', 64), '', '', '', null, null)), 'nor a cashier');
commit;

-- "זו הוצאה אחרת": kept with who and when (from the database, not the browser) and logged; never taken back
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000f402');
insert into public.expenses (id, user_id, supplier_name, supplier_doc_type, doc_date, category, amount_before_vat, vat_amount, total, file_sha256, duplicate_ack) values
  ('00000000-0000-0000-0000-00000000fe04', '00000000-0000-0000-0000-00000000f402', 'אור ספקים בע"מ', 'receipt', public.il_today(), 'materials', 118, 0, 118, repeat('a', 64),
   jsonb_build_object('of', jsonb_build_array('00000000-0000-0000-0000-00000000fe01'), 'reasons', jsonb_build_array('file'),
                      'by', '00000000-0000-0000-0000-00000000f406', 'at', '2000-01-01'));
select pg_temp.check((select duplicate_ack->>'by' = '00000000-0000-0000-0000-00000000f402' and (duplicate_ack->>'at')::timestamptz > now() - interval '1 hour'
                             and duplicate_ack->'reasons' = '["file"]' and duplicate_ack->'of' = '["00000000-0000-0000-0000-00000000fe01"]'
                      from public.expenses where id = '00000000-0000-0000-0000-00000000fe04'), 'who and when: the database''s');
select pg_temp.refused_with($$insert into public.expenses (user_id, supplier_name, supplier_doc_type, doc_date, category, amount_before_vat, vat_amount, total, duplicate_ack)
  values ('00000000-0000-0000-0000-00000000f402', 'x', 'receipt', public.il_today(), 'other', 1, 0, 1, '{"of": ["00000000-0000-0000-0000-00000000fe01"], "reasons": ["nope"]}')$$,
  'duplicate_ack', 'a reason that does not exist');
select pg_temp.refused_with($$insert into public.expenses (user_id, supplier_name, supplier_doc_type, doc_date, category, amount_before_vat, vat_amount, total, duplicate_ack)
  values ('00000000-0000-0000-0000-00000000f402', 'x', 'receipt', public.il_today(), 'other', 1, 0, 1, '{"of": ["not-an-id"], "reasons": ["file"]}')$$,
  'duplicate_ack', 'an id that is not one');
select pg_temp.refused($$insert into public.expenses (user_id, supplier_name, supplier_doc_type, doc_date, category, amount_before_vat, vat_amount, total, file_sha256)
  values ('00000000-0000-0000-0000-00000000f402', 'x', 'receipt', public.il_today(), 'other', 1, 0, 1, 'xyz')$$, 'a fingerprint that is not a sha256');
update public.expenses set file_sha256 = repeat('b', 64), duplicate_ack = null where id in ('00000000-0000-0000-0000-00000000fe01', '00000000-0000-0000-0000-00000000fe04');
select pg_temp.check((select bool_and(file_sha256 = repeat('a', 64)) from public.expenses where id in ('00000000-0000-0000-0000-00000000fe01', '00000000-0000-0000-0000-00000000fe04')),
  'a file''s fingerprint stays');
select pg_temp.check((select duplicate_ack is not null from public.expenses where id = '00000000-0000-0000-0000-00000000fe04'), '"זו הוצאה אחרת" is not taken back');
commit;
select pg_temp.check((select count(*) = 1 from public.finance_audit_log where action = 'expense.not_duplicate' and entity_id = '00000000-0000-0000-0000-00000000fe04'
                      and details->'reasons' = '["file"]'), 'the decision is in the log');

-- the business's audit chain is intact after all of it
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000f401');
select pg_temp.check((public.finance_audit_verify()->>'ok')::boolean, 'the audit chain of clinic A is intact');
commit;
