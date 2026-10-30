-- "יומן ולידים" (2.109, migration 6000) on a real Postgres (tests/sql/run.sh): a calendar member adds, moves and cancels any
-- appointment (with its history), reads and adds leads — a new one only with a phone — and nothing else: no money, marketing,
-- attendance, settings or store; never another business. The owner and the cashier are as before.
--   "Salon" A: owner a1, calendar members a2 (Gal) and a3 (Karin), cashier a4. "Other" B: owner b1.
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
-- rows visible to the caller (a restrictive policy hides, it does not raise on select)
create or replace function pg_temp.seen(t text) returns bigint language plpgsql as $$
declare n bigint; begin execute format('select count(*) from public.%I', t) into n; return n; end $$;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000600a1', 'owner@salon-60.test'), ('00000000-0000-0000-0000-0000000600a2', 'gal@salon-60.test'),
  ('00000000-0000-0000-0000-0000000600a3', 'karin@salon-60.test'), ('00000000-0000-0000-0000-0000000600a4', 'cashier@salon-60.test'),
  ('00000000-0000-0000-0000-0000000600b1', 'owner@other-60.test');
insert into public.businesses (id, name, slug) values
  ('00000000-0000-0000-0000-00000060b001', 'Salon', 'salon-60'), ('00000000-0000-0000-0000-00000060b002', 'Other', 'other-60');
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-00000060b001', '00000000-0000-0000-0000-0000000600a1', 'owner', 'full'),
  ('00000000-0000-0000-0000-00000060b001', '00000000-0000-0000-0000-0000000600a2', 'editor', 'calendar'),
  ('00000000-0000-0000-0000-00000060b001', '00000000-0000-0000-0000-0000000600a3', 'editor', 'calendar'),
  ('00000000-0000-0000-0000-00000060b001', '00000000-0000-0000-0000-0000000600a4', 'editor', 'register'),
  ('00000000-0000-0000-0000-00000060b002', '00000000-0000-0000-0000-0000000600b1', 'owner', 'full');
select pg_temp.refused_with($$update public.business_members set access = 'kiosk' where user_id = '00000000-0000-0000-0000-0000000600a2'$$,
  'business_members_access_check', 'only the three accesses');

-- the business's rows (by the server): the team, a service, an appointment of the owner, a lead, a payment, content, an employee
insert into public.lead_staff (id, business_id, name, phone, practitioner, color) values
  ('00000000-0000-0000-0000-00000060c001', '00000000-0000-0000-0000-00000060b001', 'שגית', '972501112222', true, 'yellow'),
  ('00000000-0000-0000-0000-00000060c002', '00000000-0000-0000-0000-00000060b001', 'קרין בניזרי', null, true, 'pink'),
  ('00000000-0000-0000-0000-00000060c003', '00000000-0000-0000-0000-00000060b001', 'גל שחר', null, true, 'turquoise');
insert into public.booking_services (id, user_id, business_id, name, minutes) values
  ('00000000-0000-0000-0000-00000060d001', '00000000-0000-0000-0000-0000000600a1', '00000000-0000-0000-0000-00000060b001', 'מניקור', 60);
insert into public.leads (id, user_id, business_id, name, phone) values
  ('00000000-0000-0000-0000-00000060f001', '00000000-0000-0000-0000-0000000600a1', '00000000-0000-0000-0000-00000060b001', 'מרים', '0501234567'),
  ('00000000-0000-0000-0000-00000060f002', '00000000-0000-0000-0000-0000000600a1', '00000000-0000-0000-0000-00000060b001', 'מפייסבוק', ''),
  ('00000000-0000-0000-0000-00000060f009', '00000000-0000-0000-0000-0000000600b1', '00000000-0000-0000-0000-00000060b002', 'של אחר', '0509999999');
insert into public.appointments (id, user_id, business_id, name, start_at, end_at, staff_id, status) values
  ('00000000-0000-0000-0000-00000060e001', '00000000-0000-0000-0000-0000000600a1', '00000000-0000-0000-0000-00000060b001', 'מרים',
   '2030-02-03 10:00+02', '2030-02-03 11:00+02', '00000000-0000-0000-0000-00000060c001', 'booked');
insert into public.content (user_id, business_id, kind) values ('00000000-0000-0000-0000-0000000600a1', '00000000-0000-0000-0000-00000060b001', 'post');
insert into public.employees (id, user_id, business_id, name, phone, token) values
  ('00000000-0000-0000-0000-00000060a901', '00000000-0000-0000-0000-0000000600a1', '00000000-0000-0000-0000-00000060b001', 'עובדת', '0501111111', 'tok60-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');

-- ---- 1. who they are ---------------------------------------------------------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000600a2');
select pg_temp.check(public.calendar_member(), 'Gal is a calendar member');
select pg_temp.check(public.my_access() = 'register', 'every cashier rule applies to her');
select pg_temp.check(public.att_role() = 'none', 'no part in attendance (by her role she would be its admin)');
select pg_temp.check((select count(*) = 3 from public.appointment_staff()), 'the calendar''s team — names and colours');
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000600a4');
select pg_temp.check(not public.calendar_member() and public.my_access() = 'register', 'the cashier is a cashier');
select pg_temp.check((select count(*) = 0 from public.appointment_staff()), 'the cashier still has no team');
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000600a1');
select pg_temp.check(not public.calendar_member() and public.my_access() = 'full' and public.att_role() = 'admin', 'the owner as before');
select pg_temp.check(pg_temp.seen('content') = 1 and pg_temp.seen('employees') = 1, 'the owner sees everything');
commit;

-- ---- 2. the calendar: every appointment, add / move / cancel for anyone, the history; never delete ---------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000600a2');
select pg_temp.check(pg_temp.seen('appointments') = 1, 'Gal sees Sagit''s appointment');
select pg_temp.check(pg_temp.seen('booking_services') = 1, 'and the services');
insert into public.appointments (id, user_id, business_id, name, phone, start_at, end_at, staff_id, status, lead_id) values
  ('00000000-0000-0000-0000-00000060e002', '00000000-0000-0000-0000-0000000600a2', '00000000-0000-0000-0000-00000060b001', 'מרים', '0501234567',
   '2030-02-03 12:00+02', '2030-02-03 13:00+02', '00000000-0000-0000-0000-00000060c002', 'booked', '00000000-0000-0000-0000-00000060f001');
update public.appointments set start_at = '2030-02-03 14:00+02', end_at = '2030-02-03 15:00+02'
 where id = '00000000-0000-0000-0000-00000060e001';
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000600a3');
update public.appointments set status = 'cancelled' where id = '00000000-0000-0000-0000-00000060e002';
select pg_temp.check((select status = 'cancelled' from public.appointments where id = '00000000-0000-0000-0000-00000060e002'), 'Karin cancels Gal''s appointment');
select pg_temp.check(pg_temp.seen('appointment_events') >= 3, 'the history of every change is there');
delete from public.appointments where id = '00000000-0000-0000-0000-00000060e001';
select pg_temp.check(pg_temp.seen('appointments') = 2, 'deleting an appointment does nothing — cancel only');
-- the services: 6100 (2.110) lets her add and change them, never their price (calendar-services.check.sql)
select pg_temp.refused_with($$insert into public.booking_services (user_id, business_id, name, minutes, price) values
  ('00000000-0000-0000-0000-0000000600a3', '00000000-0000-0000-0000-00000060b001', 'x', 30, 100)$$, 'רק בעלי העסק', 'a service''s price is not hers');
update public.booking_settings set phone = '1' where business_id = '00000000-0000-0000-0000-00000060b001';
commit;

-- ---- 3. the leads: read, change, add — a new one only with a phone -----------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000600a2');
select pg_temp.check(pg_temp.seen('leads') = 2, 'the business''s leads, never another''s');
insert into public.leads (id, user_id, business_id, name, phone) values
  ('00000000-0000-0000-0000-00000060f003', '00000000-0000-0000-0000-0000000600a2', '00000000-0000-0000-0000-00000060b001', 'חדשה', '0527654321');
select pg_temp.refused_with($$insert into public.leads (user_id, business_id, name, phone) values
  ('00000000-0000-0000-0000-0000000600a2', '00000000-0000-0000-0000-00000060b001', 'בלי טלפון', '  ')$$, 'רק עם מספר טלפון', 'no phone — not opened');
select pg_temp.refused_with($$update public.leads set phone = '' where id = '00000000-0000-0000-0000-00000060f001'$$,
  'רק עם מספר טלפון', 'a phone is not taken away');
update public.leads set status = 'נקבע תור' where id = '00000000-0000-0000-0000-00000060f002';
select pg_temp.check((select status = 'נקבע תור' from public.leads where id = '00000000-0000-0000-0000-00000060f002'), 'a lead from Meta with no phone still changes');
insert into public.lead_activities (user_id, business_id, lead_id, kind, body) values
  ('00000000-0000-0000-0000-0000000600a2', '00000000-0000-0000-0000-00000060b001', '00000000-0000-0000-0000-00000060f003', 'meeting', 'תור');
delete from public.leads where id = '00000000-0000-0000-0000-00000060f003';
select pg_temp.check(pg_temp.seen('leads') = 3, 'deleting a lead does nothing');
commit;

-- ---- 4. nothing else ---------------------------------------------------------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000600a3');
select pg_temp.check(pg_temp.seen('content') = 0 and pg_temp.seen('employees') = 0 and pg_temp.seen('payments') = 0
  and pg_temp.seen('documents') = 0 and pg_temp.seen('sales') = 0 and pg_temp.seen('catalog_items') = 0
  and pg_temp.seen('register_settings') = 0 and pg_temp.seen('timeclock_settings') = 0 and pg_temp.seen('client_packages') = 0
  and pg_temp.seen('stores') = 0 and pg_temp.seen('expenses') = 0, 'no money, marketing, attendance, register or store');
select pg_temp.refused_with($$insert into public.content (user_id, business_id, kind) values
  ('00000000-0000-0000-0000-0000000600a3', '00000000-0000-0000-0000-00000060b001', 'x')$$, 'policy', 'no writing elsewhere');
select pg_temp.refused_with($$select public.finance_summary('2030-01-01', '2030-12-31')$$, '', 'the money summary refuses');
commit;

-- the rows nothing of theirs touched
select pg_temp.check((select phone = '' from public.booking_settings where business_id = '00000000-0000-0000-0000-00000060b001') is not false,
  'the booking settings did not change');
select pg_temp.check((select count(*) = 2 from public.appointments where business_id = '00000000-0000-0000-0000-00000060b001'), 'both appointments kept');

-- running the migration again changes nothing (idempotent) — and a table added after it gets the rule by running it again
\i supabase/migrations/20261028006000_calendar_access.sql
select pg_temp.check((select count(*) = 1 from pg_policies where tablename = 'content' and policyname = 'content_calendar_only'), 'one policy per table');

-- clean up
delete from public.appointments where business_id in ('00000000-0000-0000-0000-00000060b001', '00000000-0000-0000-0000-00000060b002');
delete from public.lead_activities where business_id = '00000000-0000-0000-0000-00000060b001';
delete from public.leads where business_id in ('00000000-0000-0000-0000-00000060b001', '00000000-0000-0000-0000-00000060b002');
