-- Recurring charges (migration 20261010004500, docs/FINANCE_ADDITIONS_HE.md T4) on a real Postgres (tests/sql/run.sh). The screens'
-- calls run as the signed-in roles; the timer and the server's answers as service_role (the dashboard's server). Fixtures only,
-- with ids of their own:
--   Clinic RA (company, VAT 18%)  owner OA, staff SA (editor, money open), cashier KA, viewer VA; customers נועה, דנה; an item
--   Clinic RB (exempt dealer)     owner OB, customer מיכל; an item
-- Every plan starts today on the same day of the month (d1: today's, at most the 28th), so its first charge is on n1 (today, or
-- within a month); the timer runs at chosen moments (its clock is its p_now). The Definition of Done: a run again never makes a
-- second charge; a paused plan charges nothing. Every check raises "CHECK FAILED: …" when the database does not behave.
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
-- an hour on an Israeli date (the timer's clock); a date, or the Sunday after it when it is a Saturday (no charge on Saturday)
create or replace function pg_temp.il_at(d date, h int, m int default 0) returns timestamptz language sql as $$
  select (d + make_time(h, m, 0)) at time zone 'Asia/Jerusalem' $$;
create or replace function pg_temp.wd(d date) returns date language sql as $$
  select d + case when extract(isodow from d) = 6 then 1 else 0 end $$;

-- the plans' day of the month and their first date (n1, set below); the first run of the timer, and minutes after it
create temp table k (d1 int, n1 date);
insert into k values (least(extract(day from public.il_today())::int, 28), null);
grant all on k to public;
create or replace function pg_temp.r1(p_minutes int default 0) returns timestamptz language sql as $$
  select pg_temp.il_at(pg_temp.wd((select n1 from k)), 10) + make_interval(mins => p_minutes) $$;
-- one run of the timer: what it handed to the server
create temp table got (id uuid);
grant all on got to public;
create or replace function pg_temp.run(p_at timestamptz) returns int language plpgsql as $$
declare n int;
begin
  delete from got;
  insert into got select x from public.recurring_due(p_at) x;
  get diagnostics n = row_count;
  return n;
end $$;
-- a plan's charges by period: their statuses, and the k-th one
create or replace function pg_temp.statuses(p_plan text) returns text language sql as $$
  select coalesce(string_agg(c.status, ' ' order by c.period_date), '') from public.recurring_charges c where c.plan_id = p_plan::uuid $$;
create or replace function pg_temp.charge(p_plan text, p_n int default 0) returns uuid language sql as $$
  select c.id from public.recurring_charges c where c.plan_id = p_plan::uuid order by c.period_date offset p_n limit 1 $$;
-- a plan as the screens save it: one line of ₪1,180 (VAT included), every month on d1 from today
create or replace function pg_temp.save(p_id text, p_lead text, p_name text, p_mode text default 'issue', p_link boolean default true,
                                        p_end date default null, p_every int default 1, p_day int default null, p_start date default null,
                                        p_amount numeric default 1180, p_lines jsonb default null) returns jsonb language sql as $$
  select public.recurring_plan_save(p_id::uuid, p_lead::uuid, p_name,
    coalesce(p_lines, '[{"name": "ריטיינר חודשי", "qty": 1, "unitPrice": 1180}]'::jsonb), true, p_amount, p_every,
    coalesce(p_day, (select d1 from k)), coalesce(p_start, public.il_today()), p_end, p_mode, p_link, '') $$;
-- an invoice of clinic RA (305, ₪1,180) to נועה, with a key — as the timer's server issues a charge's (recurring:<plan>:<period>)
create or replace function pg_temp.inv(p_id text, p_key text, p_extra jsonb default '{}') returns uuid language sql as $$
  select pg_temp.issue(jsonb_build_object('id', p_id, 'user_id', '00000000-0000-0000-0000-000000e45a01', 'business_id', '00000000-0000-0000-0000-000000e45b01',
    'doc_type', 305, 'doc_number', 0, 'doc_date', public.il_today(), 'due_date', public.il_today() + 30, 'customer_name', 'נועה',
    'lead_id', '00000000-0000-0000-0000-000000e45c01',
    'lines', '[{"name": "ריטיינר חודשי", "qty": 1, "unitPriceExVat": 1000, "discountExVat": 0, "totalExVat": 1000, "vatRate": 18, "kind": 1}]'::jsonb,
    'payments', '[]'::jsonb, 'before_discount', 1000, 'discount', 0, 'after_discount', 1000, 'vat_amount', 180, 'total', 1180, 'vat_rate', 18,
    'idempotency_key', p_key) || p_extra) $$;

-- ---- the world --------------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000e45a01', 'oa@rc-a.test'), ('00000000-0000-0000-0000-000000e45a02', 'sa@rc-a.test'),
  ('00000000-0000-0000-0000-000000e45a03', 'ka@rc-a.test'), ('00000000-0000-0000-0000-000000e45a04', 'va@rc-a.test'),
  ('00000000-0000-0000-0000-000000e45a05', 'ob@rc-b.test');
insert into public.businesses (id, name, slug) values
  ('00000000-0000-0000-0000-000000e45b01', 'Clinic RA', 'rc-clinic-a'), ('00000000-0000-0000-0000-000000e45b02', 'Clinic RB', 'rc-clinic-b');
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-000000e45b01', '00000000-0000-0000-0000-000000e45a01', 'owner', 'full'),
  ('00000000-0000-0000-0000-000000e45b01', '00000000-0000-0000-0000-000000e45a02', 'editor', 'full'),
  ('00000000-0000-0000-0000-000000e45b01', '00000000-0000-0000-0000-000000e45a03', 'editor', 'register'),
  ('00000000-0000-0000-0000-000000e45b01', '00000000-0000-0000-0000-000000e45a04', 'viewer', 'full'),
  ('00000000-0000-0000-0000-000000e45b02', '00000000-0000-0000-0000-000000e45a05', 'owner', 'full');
update public.profiles set current_business_id = '00000000-0000-0000-0000-000000e45b01'
 where id in ('00000000-0000-0000-0000-000000e45a01', '00000000-0000-0000-0000-000000e45a02', '00000000-0000-0000-0000-000000e45a03',
              '00000000-0000-0000-0000-000000e45a04');
update public.profiles set current_business_id = '00000000-0000-0000-0000-000000e45b02' where id = '00000000-0000-0000-0000-000000e45a05';
insert into public.register_settings (user_id, business_id, business_type, vat_rate, dealer_number, legal_name, street, city, entity_type) values
  ('00000000-0000-0000-0000-000000e45a01', '00000000-0000-0000-0000-000000e45b01', 'licensed', 18, '514000004', 'קליניקה רא בע"מ', 'הרצל', 'תל אביב', 'company'),
  ('00000000-0000-0000-0000-000000e45a05', '00000000-0000-0000-0000-000000e45b02', 'licensed', 18, '123456782', 'קליניקה רב', 'הגפן', 'חיפה', 'exempt_dealer');
insert into public.leads (id, user_id, business_id, name, phone, email) values
  ('00000000-0000-0000-0000-000000e45c01', '00000000-0000-0000-0000-000000e45a01', '00000000-0000-0000-0000-000000e45b01', 'נועה', '0501111111', 'noa@rc.test'),
  ('00000000-0000-0000-0000-000000e45c02', '00000000-0000-0000-0000-000000e45a01', '00000000-0000-0000-0000-000000e45b01', 'דנה', '0502222222', ''),
  ('00000000-0000-0000-0000-000000e45c03', '00000000-0000-0000-0000-000000e45a05', '00000000-0000-0000-0000-000000e45b02', 'מיכל', '0503333333', '');
insert into public.catalog_items (id, user_id, business_id, name, price, kind) values
  ('00000000-0000-0000-0000-000000e45d01', '00000000-0000-0000-0000-000000e45a01', '00000000-0000-0000-0000-000000e45b01', 'ריטיינר', 1180, 'service'),
  ('00000000-0000-0000-0000-000000e45d02', '00000000-0000-0000-0000-000000e45a05', '00000000-0000-0000-0000-000000e45b02', 'טיפול', 400, 'service');

-- ======================================================================================================================
-- 1. the schedule: the anchor's month, every N months on the day; never before the start; calendar days in any time zone
--    (the same examples as tests/recurring.test.ts)
-- ======================================================================================================================
select pg_temp.check(public.recurring_date('2026-01-31', 1, 5, 0) = '2026-01-05' and public.recurring_date('2026-01-31', 1, 5, 1) = '2026-02-05'
  and public.recurring_date('2026-11-10', 3, 28, 1) = '2027-02-28' and public.recurring_date('2026-03-01', 12, 1, 2) = '2028-03-01', 'the k-th date of a schedule');
select pg_temp.check(public.recurring_on_or_after('2026-01-15', 1, 5, '2026-01-15') = '2026-02-05', 'the first date is never before the start');
select pg_temp.check(public.recurring_on_or_after('2026-01-05', 1, 5, '2026-01-05') = '2026-01-05', 'a start on the day is the first date');
select pg_temp.check(public.recurring_on_or_after('2026-11-10', 3, 28, '2027-01-01') = '2027-02-28', 'every 3 months');
select pg_temp.check(public.recurring_on_or_after('2026-03-01', 12, 1, '2026-03-02') = '2027-03-01', 'every year');
select pg_temp.check(public.recurring_on_or_after('2026-12-20', 2, 10, '2027-01-11') = '2027-02-10', 'every 2 months, across a year');
select pg_temp.check(public.recurring_on_or_after('2026-01-31', 1, 28, '2026-02-01') = '2026-02-28', 'the 28th is in every month (February too)');
select pg_temp.check(public.recurring_on_or_after('2026-01-15', 1, 5, '2027-01-06') = '2027-02-05', 'a year later: the first date on or after the day');
select pg_temp.check(public.recurring_on_or_after('2026-01-15', 1, 29, '2026-01-15') is null, 'no day past the 28th');
set timezone = 'Pacific/Kiritimati';
select pg_temp.check(public.recurring_on_or_after('2026-03-31', 1, 28, '2026-03-30') = '2026-04-28' and public.recurring_date('2026-10-25', 1, 1, 0) = '2026-10-01',
  'the same dates at UTC+14');
set timezone = 'America/Los_Angeles';
select pg_temp.check(public.recurring_on_or_after('2026-03-31', 1, 28, '2026-03-30') = '2026-04-28' and public.recurring_date('2026-10-25', 1, 1, 0) = '2026-10-01',
  'the same dates at UTC−7 (a summer-time change in between)');
reset timezone;

-- ======================================================================================================================
-- 2. making a plan: the money's writers only; the customer and the items are the business's own; a sane schedule
-- ======================================================================================================================
begin;
set local role anon;
select pg_temp.refused($$select public.recurring_plan_save('00000000-0000-0000-0000-000000e45e01', '00000000-0000-0000-0000-000000e45c01', 'x',
  '[{"name": "x", "qty": 1, "unitPrice": 1}]', true, 1, 1, 1, public.il_today(), null, 'issue', true, '')$$, 'a visitor makes a plan');
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e45a04');
select pg_temp.refused_with($$select pg_temp.save('00000000-0000-0000-0000-000000e45e01', '00000000-0000-0000-0000-000000e45c01', 'ריטיינר')$$,
  'not allowed', 'a viewer makes no plan');
select pg_temp.as_user('00000000-0000-0000-0000-000000e45a03');
select pg_temp.refused_with($$select pg_temp.save('00000000-0000-0000-0000-000000e45e01', '00000000-0000-0000-0000-000000e45c01', 'ריטיינר')$$,
  'not allowed', 'a cashier makes no plan');
select pg_temp.as_user('00000000-0000-0000-0000-000000e45a05');
select pg_temp.refused_with($$select pg_temp.save('00000000-0000-0000-0000-000000e45e01', '00000000-0000-0000-0000-000000e45c01', 'ריטיינר')$$,
  'recurring_customer', 'another business''s customer');
select pg_temp.as_user('00000000-0000-0000-0000-000000e45a02');
select pg_temp.refused_with($$select pg_temp.save('00000000-0000-0000-0000-000000e45e01', '00000000-0000-0000-0000-000000e45c01', '  ')$$,
  'recurring_name', 'a plan without a name');
select pg_temp.refused_with($$select pg_temp.save('00000000-0000-0000-0000-000000e45e01', '00000000-0000-0000-0000-000000e45c01', 'x', p_lines => '[]')$$,
  'recurring_lines', 'a plan without lines');
select pg_temp.refused_with($$select pg_temp.save('00000000-0000-0000-0000-000000e45e01', '00000000-0000-0000-0000-000000e45c01', 'x',
  p_lines => '[{"name": "x", "qty": 0, "unitPrice": 10}]')$$, 'recurring_lines: line 1', 'a line of no quantity');
select pg_temp.refused_with($$select pg_temp.save('00000000-0000-0000-0000-000000e45e01', '00000000-0000-0000-0000-000000e45c01', 'x',
  p_lines => '[{"name": "x", "qty": 1, "unitPrice": 10}, {"name": "y", "qty": 1, "unitPrice": "abc"}]')$$, 'recurring_lines: line 2', 'a price that is not a number');
select pg_temp.refused_with($$select pg_temp.save('00000000-0000-0000-0000-000000e45e01', '00000000-0000-0000-0000-000000e45c01', 'x',
  p_lines => '[{"name": "x", "qty": 1, "unitPrice": 10, "itemId": "00000000-0000-0000-0000-000000e45d02"}]')$$, 'the item', 'another business''s item');
select pg_temp.refused_with($$select pg_temp.save('00000000-0000-0000-0000-000000e45e01', '00000000-0000-0000-0000-000000e45c01', 'x',
  p_lines => '[{"name": "x", "qty": 1, "unitPrice": 10, "itemId": "not-an-id"}]')$$, 'the item', 'an item that is not an id');
select pg_temp.refused_with($$select pg_temp.save('00000000-0000-0000-0000-000000e45e01', '00000000-0000-0000-0000-000000e45c01', 'x',
  p_lines => '[{"name": "x", "qty": 1, "unitPrice": 10, "variantId": "00000000-0000-0000-0000-000000e45d01"}]')$$, 'the variant', 'a variant without its item');
select pg_temp.refused_with($$select pg_temp.save('00000000-0000-0000-0000-000000e45e01', '00000000-0000-0000-0000-000000e45c01', 'x', p_amount => 0)$$,
  'recurring_amount', 'an amount of nothing');
select pg_temp.refused_with($$select pg_temp.save('00000000-0000-0000-0000-000000e45e01', '00000000-0000-0000-0000-000000e45c01', 'x', p_amount => 1.005)$$,
  'recurring_amount', 'less than an agora');
select pg_temp.refused_with($$select pg_temp.save('00000000-0000-0000-0000-000000e45e01', '00000000-0000-0000-0000-000000e45c01', 'x', p_every => 4)$$,
  'recurring_every', 'every 4 months is not a choice');
select pg_temp.refused_with($$select pg_temp.save('00000000-0000-0000-0000-000000e45e01', '00000000-0000-0000-0000-000000e45c01', 'x', p_day => 29)$$,
  'recurring_day', 'the 29th is not in every month');
select pg_temp.refused_with($$select pg_temp.save('00000000-0000-0000-0000-000000e45e01', '00000000-0000-0000-0000-000000e45c01', 'x', p_start => public.il_today() - 400)$$,
  'recurring_start', 'a start more than a year ago');
select pg_temp.refused_with($$select pg_temp.save('00000000-0000-0000-0000-000000e45e01', '00000000-0000-0000-0000-000000e45c01', 'x', p_end => public.il_today() - 1)$$,
  'recurring_end', 'an end before the start');
select pg_temp.refused_with($$select pg_temp.save('00000000-0000-0000-0000-000000e45e01', '00000000-0000-0000-0000-000000e45c01', 'x', p_end => public.il_today(),
  p_day => (select d1 % 28 + 1 from k))$$, 'no charge before the end date', 'an end before the first charge');
select pg_temp.refused_with($$select pg_temp.save('00000000-0000-0000-0000-000000e45e01', '00000000-0000-0000-0000-000000e45c01', 'x', p_mode => 'card')$$,
  'recurring_mode', 'charging a card is not a mode');
-- P1: a monthly retainer for נועה, an invoice with a payment link each month
select pg_temp.check((pg_temp.save('00000000-0000-0000-0000-000000e45e01', '00000000-0000-0000-0000-000000e45c01', 'ריטיינר שיווק',
  p_lines => '[{"name": "ריטיינר שיווק", "qty": 1, "unitPrice": 1180, "itemId": "00000000-0000-0000-0000-000000e45d01"}]')->>'result') = 'created', 'a plan is made');
select pg_temp.check((pg_temp.save('00000000-0000-0000-0000-000000e45e01', '00000000-0000-0000-0000-000000e45c01', 'ריטיינר שיווק',
  p_lines => '[{"name": "ריטיינר שיווק", "qty": 1, "unitPrice": 1180, "itemId": "00000000-0000-0000-0000-000000e45d01"}]')->>'result') = 'changed',
  'the same save again (its answer was lost): the same plan');
commit;
update k set n1 = (select next_date from public.recurring_plans where id = '00000000-0000-0000-0000-000000e45e01');
select pg_temp.check((select count(*) = 1 from public.recurring_plans where lead_id = '00000000-0000-0000-0000-000000e45c01'), 'one plan');
select pg_temp.check((select (status, user_id, amount, every_months, day_of_month, start_date, mode, send_link) =
                             ('active', '00000000-0000-0000-0000-000000e45a02'::uuid, 1180::numeric, 1, (select d1 from k), public.il_today(), 'issue', true)
                        and next_date = public.recurring_on_or_after(public.il_today(), 1, (select d1 from k), public.il_today())
                        and next_date between public.il_today() and public.il_today() + 31
                      from public.recurring_plans where id = '00000000-0000-0000-0000-000000e45e01'), 'its terms, who made it, its first date (never in the past)');
select pg_temp.check((select count(*) = 1 from public.lead_activities where lead_id = '00000000-0000-0000-0000-000000e45c01'
                      and body like 'חיוב חוזר: ריטיינר שיווק · ₪1180 כל חודש · ראשון ב-%'), 'it is on the customer''s card, once');
select pg_temp.check((select count(*) filter (where action = 'recurring.created') = 1 and count(*) filter (where action = 'recurring.changed') = 1
                      from public.finance_audit_log where entity_id = '00000000-0000-0000-0000-000000e45e01'), 'making it (and the save again) is in the log');

begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e45a02');
-- P2 for דנה (paused below); P3 for נועה as a draft each time, no link; P4 for דנה, a standing order (no link); P5 for נועה,
-- ending on its first date (one charge); P6 for נועה (paused after its charge waits); P8 for דנה (its terms change)
select pg_temp.save('00000000-0000-0000-0000-000000e45e02', '00000000-0000-0000-0000-000000e45c02', 'מנוי חודשי');
select pg_temp.save('00000000-0000-0000-0000-000000e45e03', '00000000-0000-0000-0000-000000e45c01', 'ליווי — טיוטה', p_mode => 'draft', p_link => false);
select pg_temp.save('00000000-0000-0000-0000-000000e45e04', '00000000-0000-0000-0000-000000e45c02', 'הוראת קבע', p_link => false);
select pg_temp.save('00000000-0000-0000-0000-000000e45e05', '00000000-0000-0000-0000-000000e45c01', 'חודש אחד', p_end => (select n1 from k));
select pg_temp.save('00000000-0000-0000-0000-000000e45e06', '00000000-0000-0000-0000-000000e45c01', 'מושהה אחרי');
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e45a05');
-- P9: clinic RB's plan for מיכל
select pg_temp.save('00000000-0000-0000-0000-000000e45e09', '00000000-0000-0000-0000-000000e45c03', 'טיפול חודשי', p_amount => 400,
  p_lines => '[{"name": "טיפול", "qty": 1, "unitPrice": 400, "itemId": "00000000-0000-0000-0000-000000e45d02"}]');
select pg_temp.check((select count(*) = 1 from public.recurring_plans), 'clinic RB sees its own plan only');
select pg_temp.refused_with($$select public.recurring_plan_set('00000000-0000-0000-0000-000000e45e01', 'pause')$$, 'recurring_not_found', 'pausing another business''s plan');
commit;

-- who reads them: the money's people (a viewer too), never a cashier; nobody writes them but the functions
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e45a04');
select pg_temp.check((select count(*) = 6 from public.recurring_plans), 'a viewer reads the plans');
select pg_temp.refused_with($$select public.recurring_plan_set('00000000-0000-0000-0000-000000e45e02', 'pause')$$, 'not allowed', 'a viewer pauses nothing');
select pg_temp.as_user('00000000-0000-0000-0000-000000e45a03');
select pg_temp.check((select count(*) = 0 from public.recurring_plans), 'a cashier reads no plan');
select pg_temp.as_user('00000000-0000-0000-0000-000000e45a01');
select pg_temp.refused($$insert into public.recurring_plans (business_id, lead_id, name, lines, amount, every_months, day_of_month, start_date, next_date)
  values ('00000000-0000-0000-0000-000000e45b01', '00000000-0000-0000-0000-000000e45c01', 'x', '[{}]', 1, 1, 1, public.il_today(), public.il_today())$$,
  'the owner writes a plan by hand');
select pg_temp.refused($$update public.recurring_plans set amount = 1$$, 'the owner changes a plan by hand');
select pg_temp.refused($$delete from public.recurring_plans$$, 'the owner deletes a plan');
select pg_temp.refused($$select public.recurring_due()$$, 'the owner runs the timer');
select pg_temp.refused($$select public.recurring_charge_done('00000000-0000-0000-0000-000000e45e01', 'blocked', p_error => 'x')$$, 'the owner answers for the server');
-- DoD: P2 paused before its date
select pg_temp.check((public.recurring_plan_set('00000000-0000-0000-0000-000000e45e02', 'pause')->>'status') = 'paused', 'a plan is paused');
select pg_temp.check((public.recurring_plan_set('00000000-0000-0000-0000-000000e45e02', 'pause')->>'result') = 'already', 'paused twice: once');
select pg_temp.refused_with($$select public.recurring_plan_set('00000000-0000-0000-0000-000000e45e02', 'stop')$$, 'recurring_request', 'an action that is not one');
commit;
select pg_temp.check((select (status, paused_at is not null) = ('paused', true) from public.recurring_plans where id = '00000000-0000-0000-0000-000000e45e02'),
  'it is paused, and when');

-- ======================================================================================================================
-- 3. the timer: on the day, 08:00–20:00, not on Saturday — one charge per plan and period, however many times it runs (DoD)
-- ======================================================================================================================
begin;
set local role service_role;
select pg_temp.check(pg_temp.run(pg_temp.il_at(pg_temp.wd((select n1 from k)), 7, 59)) = 0, 'nothing before 08:00');
select pg_temp.check(pg_temp.run(pg_temp.il_at(pg_temp.wd((select n1 from k)), 20, 0)) = 0, 'nothing from 20:00');
select pg_temp.check(pg_temp.run(pg_temp.il_at((select n1 + (13 - extract(isodow from n1)::int) % 7 from k), 12)) = 0, 'nothing on a Saturday');
select pg_temp.check((select count(*) = 0 from public.recurring_charges), 'no charge was made');
select pg_temp.check(pg_temp.run(pg_temp.r1()) = 6, 'on the day: a charge for each of the 6 active plans, handed to the server');
select pg_temp.check(pg_temp.run(pg_temp.r1()) = 0 and pg_temp.run(pg_temp.r1(5)) = 0, 'run again: nothing new, and what was handed out is not handed out again');
commit;
select pg_temp.check((select count(*) = 6 and count(distinct plan_id) = 6 and bool_and(period_date = (select n1 from k)) and bool_and(status = 'pending')
                             and bool_and(attempts = 1 and claimed_at = pg_temp.r1())
                      from public.recurring_charges), 'one charge per plan, for its period');
select pg_temp.check(pg_temp.statuses('00000000-0000-0000-0000-000000e45e02') = '', 'a paused plan charges nothing (DoD)');
select pg_temp.check((select next_date = public.recurring_on_or_after(public.il_today(), 1, (select d1 from k), (select n1 + 1 from k)) and next_date > (select n1 from k)
                      from public.recurring_plans where id = '00000000-0000-0000-0000-000000e45e01'), 'the next date moved on a period');
select pg_temp.check((select (status, end_reason) = ('ended', 'הגיע תאריך הסיום') and next_date > end_date
                      from public.recurring_plans where id = '00000000-0000-0000-0000-000000e45e05'), 'the last period charged: the plan ended by its date');
select pg_temp.check((select next_date = (select n1 from k) from public.recurring_plans where id = '00000000-0000-0000-0000-000000e45e02'),
  'a paused plan keeps its date');

-- the server answers: P1 issued (and the same answer again, and a late failure, change nothing); P5 blocked; P3 a draft; RB's held
select pg_temp.inv('00000000-0000-0000-0000-000000e45f01', 'recurring:00000000-0000-0000-0000-000000e45e01:' || (select n1 from k));
begin;
set local role service_role;
select pg_temp.check(public.recurring_charge_done(pg_temp.charge('00000000-0000-0000-0000-000000e45e01'), 'issued', '00000000-0000-0000-0000-000000e45f01') = 'issued',
  'issued');
select pg_temp.check(public.recurring_charge_done(pg_temp.charge('00000000-0000-0000-0000-000000e45e01'), 'issued', '00000000-0000-0000-0000-000000e45f01') = 'issued',
  'the same answer again');
select pg_temp.check(public.recurring_charge_done(pg_temp.charge('00000000-0000-0000-0000-000000e45e01'), 'blocked', p_error => 'מאוחר') = 'issued',
  'a late failure: still issued');
select pg_temp.check(public.recurring_charge_done('00000000-0000-0000-0000-000000e45e01', 'blocked', p_error => 'x') = 'not_found', 'a charge that is not one');
select pg_temp.refused_with($$select public.recurring_charge_done(pg_temp.charge('00000000-0000-0000-0000-000000e45e05'), 'issued')$$,
  'has its document', 'issued without its document');
select pg_temp.refused_with($$select public.recurring_charge_done(pg_temp.charge('00000000-0000-0000-0000-000000e45e05'), 'paid')$$,
  'recurring_request', 'an answer that is not one');
select pg_temp.refused_with($$select public.recurring_charge_done(pg_temp.charge('00000000-0000-0000-0000-000000e45e09'), 'issued', '00000000-0000-0000-0000-000000e45f01')$$,
  'not this business', 'clinic RB''s charge with clinic RA''s invoice');
select pg_temp.refused_with($$select public.recurring_charge_done(pg_temp.charge('00000000-0000-0000-0000-000000e45e05'), 'issued', '00000000-0000-0000-0000-000000e45f01',
  p_paylink => gen_random_uuid())$$, 'the link is not this document''s', 'a link that is not the invoice''s');
select pg_temp.check(public.recurring_charge_done(pg_temp.charge('00000000-0000-0000-0000-000000e45e05'), 'blocked', p_error => 'חסר מספר עוסק') = 'blocked', 'blocked');
select pg_temp.check(public.recurring_charge_done(pg_temp.charge('00000000-0000-0000-0000-000000e45e09'), 'blocked', p_error => 'בדיקה') = 'blocked', 'RB: blocked');
-- P3's draft: the server writes it with the charge's own id (a second try finds it)
insert into public.document_drafts (id, user_id, business_id, doc_type, customer_name, lead_id, total, body)
values (pg_temp.charge('00000000-0000-0000-0000-000000e45e03'), '00000000-0000-0000-0000-000000e45a02', '00000000-0000-0000-0000-000000e45b01', 305, 'נועה',
        '00000000-0000-0000-0000-000000e45c01', 1180, '{"lines": [{"name": "ליווי", "qty": 1, "unitPrice": 1180}], "pricesIncludeVat": true}');
select pg_temp.check(public.recurring_charge_done(pg_temp.charge('00000000-0000-0000-0000-000000e45e03'), 'draft', p_draft => pg_temp.charge('00000000-0000-0000-0000-000000e45e03')) = 'draft',
  'a draft for the owner');
select pg_temp.check(public.recurring_charge_done(pg_temp.charge('00000000-0000-0000-0000-000000e45e03'), 'draft', p_draft => pg_temp.charge('00000000-0000-0000-0000-000000e45e03')) = 'draft',
  'the same draft again');
commit;
select pg_temp.check(pg_temp.statuses('00000000-0000-0000-0000-000000e45e01') = 'issued' and pg_temp.statuses('00000000-0000-0000-0000-000000e45e05') = 'blocked'
  and pg_temp.statuses('00000000-0000-0000-0000-000000e45e03') = 'draft', 'what each charge is');
select pg_temp.check((select (document_id, error, claimed_at) is not distinct from ('00000000-0000-0000-0000-000000e45f01'::uuid, '', null::timestamptz)
                      from public.recurring_charges where plan_id = '00000000-0000-0000-0000-000000e45e01'), 'the issued charge points to its invoice');
select pg_temp.check((select error = 'חסר מספר עוסק' from public.recurring_charges where plan_id = '00000000-0000-0000-0000-000000e45e05'), 'the blocked one says why');
select pg_temp.check((select count(*) = 1 from public.lead_activities where lead_id = '00000000-0000-0000-0000-000000e45c01' and kind = 'purchase'
                      and body like 'חיוב חוזר "ריטיינר שיווק" (%): חשבונית מס מס׳ % · ₪1180'), 'the invoice is on the customer''s card, once');
select pg_temp.check((select count(*) = 1 from public.finance_audit_log where action = 'recurring.issued'
                      and entity_id = pg_temp.charge('00000000-0000-0000-0000-000000e45e01')::text), 'issuing it is in the log, once');
select pg_temp.check((select count(*) = 1 from public.documents where idempotency_key like 'recurring:00000000-0000-0000-0000-000000e45e01:%'), 'one invoice for the period');

-- the link the server sent with P1's invoice: kept with the charge, and only that one
insert into public.payment_requests (id, business_id, kind, document_id, lead_id, label, amount, is_test, provider, expires_at, link_origin)
values ('00000000-0000-0000-0000-000000e45f81', '00000000-0000-0000-0000-000000e45b01', 'document', '00000000-0000-0000-0000-000000e45f01',
        '00000000-0000-0000-0000-000000e45c01', 'חשבונית מס', 1180, true, 'mock', now() + interval '14 days', 'https://dash.rc.test'),
       ('00000000-0000-0000-0000-000000e45f82', '00000000-0000-0000-0000-000000e45b01', 'document', '00000000-0000-0000-0000-000000e45f01',
        '00000000-0000-0000-0000-000000e45c01', 'חשבונית מס', 1180, true, 'mock', now() + interval '14 days', 'https://dash.rc.test');
begin;
set local role service_role;
select pg_temp.check(public.recurring_charge_done(pg_temp.charge('00000000-0000-0000-0000-000000e45e01'), 'issued', '00000000-0000-0000-0000-000000e45f01',
  p_paylink => '00000000-0000-0000-0000-000000e45f81', p_note => 'לינק בדיקה — לא נשלח ללקוח') = 'issued', 'the link is added');
select pg_temp.check(public.recurring_charge_done(pg_temp.charge('00000000-0000-0000-0000-000000e45e01'), 'issued', '00000000-0000-0000-0000-000000e45f01',
  p_paylink => '00000000-0000-0000-0000-000000e45f82') = 'issued', 'a second link is not taken');
commit;
select pg_temp.check((select (paylink_id, note) = ('00000000-0000-0000-0000-000000e45f81'::uuid, 'לינק בדיקה — לא נשלח ללקוח')
                      from public.recurring_charges where plan_id = '00000000-0000-0000-0000-000000e45e01'), 'the charge keeps its first link and the note');

-- not answered: claimed again after 10 minutes, at most 5 times — then held for the owner. A pause holds what waits.
begin;
set local role service_role;
select pg_temp.check(pg_temp.run(pg_temp.r1(11)) = 2, 'after 10 minutes: the unanswered charges again');
select pg_temp.check((select count(*) = 2 from got where id in (pg_temp.charge('00000000-0000-0000-0000-000000e45e04'), pg_temp.charge('00000000-0000-0000-0000-000000e45e06'))),
  'the 2 that were not answered');
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e45a01');
select pg_temp.check((public.recurring_plan_set('00000000-0000-0000-0000-000000e45e06', 'pause')->>'held')::int = 1, 'pausing holds the charge that waited');
commit;
select pg_temp.check((select (status, error) = ('blocked', 'התוכנית הושהתה לפני שהחיוב הופק') from public.recurring_charges
                      where plan_id = '00000000-0000-0000-0000-000000e45e06'), 'it says why');
begin;
set local role service_role;
select pg_temp.check(pg_temp.run(pg_temp.r1(22)) = 1 and pg_temp.run(pg_temp.r1(33)) = 1 and pg_temp.run(pg_temp.r1(44)) = 1, 'P4 claimed again, alone');
select pg_temp.check((select attempts = 5 from public.recurring_charges where plan_id = '00000000-0000-0000-0000-000000e45e04'), 'five times');
select pg_temp.check(pg_temp.run(pg_temp.r1(55)) = 0, 'not a sixth time');
commit;
select pg_temp.check((select (status, error) = ('blocked', 'לא הופק אחרי 5 ניסיונות. "נסו שוב" ינסה שוב.') from public.recurring_charges
                      where plan_id = '00000000-0000-0000-0000-000000e45e04'), 'held for the owner, with why');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e45a05');
select pg_temp.check(public.recurring_charge_retry(pg_temp.charge('00000000-0000-0000-0000-000000e45e04')) is false, 'another business''s charge is not retried');
select pg_temp.as_user('00000000-0000-0000-0000-000000e45a02');
select pg_temp.check(public.recurring_charge_retry(pg_temp.charge('00000000-0000-0000-0000-000000e45e04')), '"נסו שוב"');
select pg_temp.check(public.recurring_charge_retry(pg_temp.charge('00000000-0000-0000-0000-000000e45e04')) is false, 'a charge that waits is not retried');
select pg_temp.check(public.recurring_charge_retry(pg_temp.charge('00000000-0000-0000-0000-000000e45e05')), 'a blocked charge of an ended plan: by choice');
select pg_temp.check(public.recurring_charge_retry(pg_temp.charge('00000000-0000-0000-0000-000000e45e01')) is false, 'an issued charge is not retried');
commit;
begin;
set local role service_role;
select pg_temp.check(pg_temp.run(pg_temp.r1(56)) = 2, 'what was retried goes to the server');
select pg_temp.check((select count(*) = 2 from got where id in (pg_temp.charge('00000000-0000-0000-0000-000000e45e04'), pg_temp.charge('00000000-0000-0000-0000-000000e45e05'))),
  'the 2 that were retried');
commit;
select pg_temp.check((select count(*) = 2 from public.finance_audit_log where action = 'recurring.retry'), 'retrying is in the log');

-- the owner issues P3's draft from the document center: the charge is issued with it, in the same transaction
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e45a01');
select pg_temp.inv('00000000-0000-0000-0000-000000e45f03', 'draft:' || pg_temp.charge('00000000-0000-0000-0000-000000e45e03'),
  jsonb_build_object('draft_id', pg_temp.charge('00000000-0000-0000-0000-000000e45e03'), 'user_id', '00000000-0000-0000-0000-000000e45a01'));
select pg_temp.check((select (status, document_id) = ('issued', '00000000-0000-0000-0000-000000e45f03'::uuid) from public.recurring_charges
                      where plan_id = '00000000-0000-0000-0000-000000e45e03'), 'the draft issued: the charge is issued with its document');
commit;
begin;
set local role service_role;
select pg_temp.check(public.recurring_charge_done(pg_temp.charge('00000000-0000-0000-0000-000000e45e03'), 'draft', p_draft => pg_temp.charge('00000000-0000-0000-0000-000000e45e03')) = 'issued',
  'the server''s late answer changes nothing');
commit;
select pg_temp.check((select count(*) = 1 from public.finance_audit_log where action = 'recurring.issued'
                      and entity_id = pg_temp.charge('00000000-0000-0000-0000-000000e45e03')::text), 'issued from the draft: in the log');

-- ======================================================================================================================
-- 4. later: a period missed by up to 35 days is charged; an older one is held (never charged by itself); "נסו שוב" charges it
-- ======================================================================================================================
begin;
set local role service_role;
select pg_temp.run(pg_temp.il_at(pg_temp.wd((select n1 + 70 from k)), 10));
commit;
select pg_temp.check(pg_temp.statuses('00000000-0000-0000-0000-000000e45e01') = 'issued blocked pending', '70 days on: the period 40 days old is held, the one of 10 days charged');
select pg_temp.check((select error like 'התאריך עבר לפני יותר מ-35 יום%' from public.recurring_charges where id = pg_temp.charge('00000000-0000-0000-0000-000000e45e01', 1)),
  'the held period says why');
select pg_temp.check((select next_date = public.recurring_on_or_after(public.il_today(), 1, (select d1 from k), (select period_date + 1 from public.recurring_charges
                             where id = pg_temp.charge('00000000-0000-0000-0000-000000e45e01', 2)))
                      from public.recurring_plans where id = '00000000-0000-0000-0000-000000e45e01'), 'the next date is after the last period charged');
select pg_temp.check(pg_temp.statuses('00000000-0000-0000-0000-000000e45e02') = '' and pg_temp.statuses('00000000-0000-0000-0000-000000e45e06') = 'blocked'
  and pg_temp.statuses('00000000-0000-0000-0000-000000e45e05') = 'pending', 'paused and ended plans: nothing new (DoD)');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e45a01');
select pg_temp.check(public.recurring_charge_retry(pg_temp.charge('00000000-0000-0000-0000-000000e45e01', 1)), 'the held period: "נסו שוב"');
commit;
begin;
set local role service_role;
select pg_temp.run(pg_temp.il_at(pg_temp.wd((select n1 + 70 from k)), 10, 1));
select pg_temp.check(exists (select 1 from got where id = pg_temp.charge('00000000-0000-0000-0000-000000e45e01', 1)), 'it goes to the server now');
-- P3's second period as a draft, which the owner deletes ("not this period"): the charge stays a draft without it
insert into public.document_drafts (id, user_id, business_id, doc_type, customer_name, lead_id, total, body)
values (pg_temp.charge('00000000-0000-0000-0000-000000e45e03', 2), '00000000-0000-0000-0000-000000e45a02', '00000000-0000-0000-0000-000000e45b01', 305, 'נועה',
        '00000000-0000-0000-0000-000000e45c01', 1180, '{}');
select public.recurring_charge_done(pg_temp.charge('00000000-0000-0000-0000-000000e45e03', 2), 'draft', p_draft => pg_temp.charge('00000000-0000-0000-0000-000000e45e03', 2));
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e45a01');
delete from public.document_drafts where id = pg_temp.charge('00000000-0000-0000-0000-000000e45e03', 2);
commit;
select pg_temp.check((select status = 'draft' and draft_id is null from public.recurring_charges where id = pg_temp.charge('00000000-0000-0000-0000-000000e45e03', 2)),
  'a deleted draft: the charge stays a draft, without it');

-- resume skips what passed while paused: P2, paused when its date was 40 days ago (written as it would be), resumes from today
update public.recurring_plans set start_date = public.il_today() - 100,
       next_date = public.recurring_on_or_after(public.il_today() - 100, 1, (select d1 from k), public.il_today() - 40)
 where id = '00000000-0000-0000-0000-000000e45e02';
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e45a01');
select pg_temp.check((public.recurring_plan_set('00000000-0000-0000-0000-000000e45e02', 'resume')->>'status') = 'active', 'resumed');
select pg_temp.check((public.recurring_plan_set('00000000-0000-0000-0000-000000e45e02', 'resume')->>'result') = 'already', 'resumed twice: once');
commit;
select pg_temp.check((select next_date = public.recurring_on_or_after(public.il_today() - 100, 1, (select d1 from k), public.il_today()) and next_date >= public.il_today()
                      from public.recurring_plans where id = '00000000-0000-0000-0000-000000e45e02'), 'its next date: on or after today');
begin;
set local role service_role;
select pg_temp.run(pg_temp.il_at(pg_temp.wd(public.il_today()), 12));
commit;
select pg_temp.check((select count(*) = 0 from public.recurring_charges where plan_id = '00000000-0000-0000-0000-000000e45e02' and period_date < public.il_today()),
  'the paused periods were not charged late (DoD)');
select pg_temp.check((select count(*) = 1 and bool_and(body like 'חיוב חוזר "מנוי חודשי": חזר לפעול — החיוב הבא ב-%') from public.lead_activities
                      where lead_id = '00000000-0000-0000-0000-000000e45c02' and body like 'חיוב חוזר "מנוי חודשי": חזר%'), 'resuming is on the card');

-- ======================================================================================================================
-- 5. the owner ends a plan: nothing more is charged, what was issued stays; an ended plan does not change
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e45a01');
select pg_temp.check((public.recurring_plan_set('00000000-0000-0000-0000-000000e45e01', 'end', 'הלקוחה עברה לספק אחר')->>'held')::int = 2,
  'ended: the 2 charges that waited are held');
select pg_temp.check((public.recurring_plan_set('00000000-0000-0000-0000-000000e45e01', 'resume')->>'result') = 'already', 'an ended plan does not resume');
select pg_temp.refused_with($$select pg_temp.save('00000000-0000-0000-0000-000000e45e01', '00000000-0000-0000-0000-000000e45c01', 'ריטיינר שיווק')$$,
  'recurring_ended', 'an ended plan does not change');
commit;
select pg_temp.check((select (status, end_reason) = ('ended', 'הלקוחה עברה לספק אחר') from public.recurring_plans where id = '00000000-0000-0000-0000-000000e45e01'),
  'ended, and why');
select pg_temp.check(pg_temp.statuses('00000000-0000-0000-0000-000000e45e01') = 'issued blocked blocked'
  and (select document_id = '00000000-0000-0000-0000-000000e45f01' from public.recurring_charges where id = pg_temp.charge('00000000-0000-0000-0000-000000e45e01'))
  and exists (select 1 from public.documents where id = '00000000-0000-0000-0000-000000e45f01' and total = 1180), 'what was issued stays as it was');
select pg_temp.refused_with($$update public.recurring_plans set amount = 1 where id = '00000000-0000-0000-0000-000000e45e01'$$, 'an ended plan stays', 'an ended plan changed by hand');
begin;
set local role service_role;
select pg_temp.run(pg_temp.il_at(pg_temp.wd((select n1 + 200 from k)), 10));
commit;
select pg_temp.check(pg_temp.statuses('00000000-0000-0000-0000-000000e45e01') = 'issued blocked blocked', 'an ended plan charges nothing more');

-- ======================================================================================================================
-- 6. new terms: from the next charge on; the schedule only before the first charge; the customer never
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e45a02');
select pg_temp.refused_with($$select pg_temp.save('00000000-0000-0000-0000-000000e45e04', '00000000-0000-0000-0000-000000e45c02', 'הוראת קבע', p_link => false, p_every => 2)$$,
  'recurring_schedule', 'a plan that charged keeps its schedule');
select pg_temp.refused_with($$select pg_temp.save('00000000-0000-0000-0000-000000e45e04', '00000000-0000-0000-0000-000000e45c01', 'הוראת קבע', p_link => false)$$,
  'recurring_customer', 'a plan keeps its customer');
select pg_temp.check((pg_temp.save('00000000-0000-0000-0000-000000e45e04', '00000000-0000-0000-0000-000000e45c02', 'הוראת קבע — מורחב', p_link => false, p_amount => 2360,
  p_lines => '[{"name": "ריטיינר", "qty": 1, "unitPrice": 1180}, {"name": "קמפיין", "qty": 2, "unitPrice": 590}]')->>'result') = 'changed', 'new terms');
select pg_temp.save('00000000-0000-0000-0000-000000e45e08', '00000000-0000-0000-0000-000000e45c02', 'עוד לא חויב');
select pg_temp.check((pg_temp.save('00000000-0000-0000-0000-000000e45e08', '00000000-0000-0000-0000-000000e45c02', 'עוד לא חויב', p_day => (select d1 % 28 + 1 from k))->>'next')::date
  = public.recurring_on_or_after(public.il_today(), 1, (select d1 % 28 + 1 from k), public.il_today()), 'before its first charge: a new day, a new first date');
commit;
select pg_temp.check((select (name, amount, jsonb_array_length(lines), every_months) = ('הוראת קבע — מורחב', 2360::numeric, 2, 1)
                             and next_date > (select n1 from k) from public.recurring_plans where id = '00000000-0000-0000-0000-000000e45e04'),
  'the new terms, the same schedule and next date');
select pg_temp.check((select bool_and(c.document_id is null or d.total = 1180) from public.recurring_charges c left join public.documents d on d.id = c.document_id
                      where c.plan_id = '00000000-0000-0000-0000-000000e45e04'), 'what was charged stays as it was');
-- an end before the next charge, on a plan that charged: it ends
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e45a02');
select pg_temp.check((pg_temp.save('00000000-0000-0000-0000-000000e45e04', '00000000-0000-0000-0000-000000e45c02', 'הוראת קבע — מורחב', p_link => false, p_amount => 2360,
  p_lines => '[{"name": "ריטיינר", "qty": 1, "unitPrice": 1180}, {"name": "קמפיין", "qty": 2, "unitPrice": 590}]', p_end => public.il_today())->>'status') = 'ended',
  'an end date before the next charge ends it');
commit;

-- ======================================================================================================================
-- 7. what never changes: a charge's plan, period, document and link, and its way forward; a plan's customer; nothing is deleted
-- ======================================================================================================================
select pg_temp.refused_with($$update public.recurring_charges set status = 'pending' where id = pg_temp.charge('00000000-0000-0000-0000-000000e45e01')$$,
  'only moves forward', 'an issued charge goes back');
select pg_temp.refused_with($$update public.recurring_charges set status = 'pending' where id = pg_temp.charge('00000000-0000-0000-0000-000000e45e03', 2)$$,
  'only moves forward', 'a draft goes back to the timer');
select pg_temp.refused_with($$update public.recurring_charges set period_date = period_date + 1 where id = pg_temp.charge('00000000-0000-0000-0000-000000e45e04')$$,
  'keeps its plan and period', 'a charge moves to another period');
select pg_temp.refused_with($$update public.recurring_charges set document_id = '00000000-0000-0000-0000-000000e45f03' where id = pg_temp.charge('00000000-0000-0000-0000-000000e45e01')$$,
  'keeps its document', 'a charge takes another document');
select pg_temp.refused_with($$update public.recurring_charges set paylink_id = '00000000-0000-0000-0000-000000e45f82' where id = pg_temp.charge('00000000-0000-0000-0000-000000e45e01')$$,
  'keeps its payment link', 'a charge takes another link');
select pg_temp.refused($$insert into public.recurring_charges (business_id, plan_id, period_date) values ('00000000-0000-0000-0000-000000e45b01',
  '00000000-0000-0000-0000-000000e45e01', (select n1 from k))$$, 'a second charge for a period');
select pg_temp.refused($$insert into public.recurring_charges (business_id, plan_id, period_date) values ('00000000-0000-0000-0000-000000e45b02',
  '00000000-0000-0000-0000-000000e45e01', public.il_today() + 999)$$, 'a charge of a plan of another business');
select pg_temp.refused_with($$update public.recurring_plans set lead_id = '00000000-0000-0000-0000-000000e45c02' where id = '00000000-0000-0000-0000-000000e45e03'$$,
  'keeps its customer', 'a plan moves to another customer');
select pg_temp.refused_with($$update public.recurring_plans set day_of_month = day_of_month % 28 + 1 where id = '00000000-0000-0000-0000-000000e45e03'$$,
  'recurring_schedule', 'a plan that charged changes its day by hand');
select pg_temp.refused($$delete from public.recurring_charges where plan_id = '00000000-0000-0000-0000-000000e45e01'$$, 'a charge is deleted');
select pg_temp.refused($$delete from public.recurring_plans where id = '00000000-0000-0000-0000-000000e45e08'$$, 'a plan is deleted');
select pg_temp.refused($$delete from public.leads where id = '00000000-0000-0000-0000-000000e45c02'$$, 'a customer with a plan is deleted');

-- ======================================================================================================================
-- 8. a locked business: the timer makes nothing for it (and nothing is lost: its plans wait)
-- ======================================================================================================================
begin;
update public.businesses set status = 'locked' where id = '00000000-0000-0000-0000-000000e45b01';
set local role service_role;
select pg_temp.run(pg_temp.il_at(pg_temp.wd((select n1 + 400 from k)), 10));
select pg_temp.check((select count(*) = 0 from public.recurring_charges where business_id = '00000000-0000-0000-0000-000000e45b01'
                      and period_date > (select n1 + 300 from k)), 'a locked business: no charge');
rollback;

-- ======================================================================================================================
-- 9. clinic RB sees its own only; the log of both businesses is intact
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e45a05');
select pg_temp.check((select count(*) > 0 and bool_and(business_id = '00000000-0000-0000-0000-000000e45b02') from public.recurring_charges)
  and (select count(*) = 1 from public.recurring_plans), 'clinic RB sees its own charges only');
select pg_temp.check((public.finance_audit_verify()->>'ok')::boolean, 'the audit chain of clinic RB is intact');
select pg_temp.as_user('00000000-0000-0000-0000-000000e45a01');
select pg_temp.check((public.finance_audit_verify()->>'ok')::boolean, 'the audit chain of clinic RA is intact');
commit;
