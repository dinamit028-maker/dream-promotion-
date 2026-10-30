-- The treatments of a calendar member (2.110, migration 6100) on a real Postgres (tests/sql/run.sh): Gal ("יומן ולידים") adds a
-- treatment and changes its name and length; never a price or a deposit, and never deletes one. The owner as before.
--   "Salon" A: owner a1, calendar member a2 (Gal), cashier a3.
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

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000610a1', 'owner@salon-61.test'), ('00000000-0000-0000-0000-0000000610a2', 'gal@salon-61.test'),
  ('00000000-0000-0000-0000-0000000610a3', 'cashier@salon-61.test');
insert into public.businesses (id, name, slug) values ('00000000-0000-0000-0000-00000061b001', 'Salon', 'salon-61');
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-00000061b001', '00000000-0000-0000-0000-0000000610a1', 'owner', 'full'),
  ('00000000-0000-0000-0000-00000061b001', '00000000-0000-0000-0000-0000000610a2', 'editor', 'calendar'),
  ('00000000-0000-0000-0000-00000061b001', '00000000-0000-0000-0000-0000000610a3', 'editor', 'register');
insert into public.booking_services (id, user_id, business_id, name, minutes, price, deposit) values
  ('00000000-0000-0000-0000-00000061d001', '00000000-0000-0000-0000-0000000610a1', '00000000-0000-0000-0000-00000061b001', 'לייזר', 30, 300, 50);

-- ---- Gal: adds, renames, changes the length, hides ----------------------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000610a2');
insert into public.booking_services (id, user_id, business_id, name, minutes) values
  ('00000000-0000-0000-0000-00000061d002', '00000000-0000-0000-0000-0000000610a2', '00000000-0000-0000-0000-00000061b001', 'לייזר — ידיים', 40);
update public.booking_services set name = 'לייזר — פנים', minutes = 30 where id = '00000000-0000-0000-0000-00000061d001';
update public.booking_services set active = false where id = '00000000-0000-0000-0000-00000061d002';
select pg_temp.check((select name = 'לייזר — פנים' and minutes = 30 and price = 300 and deposit = 50 from public.booking_services
  where id = '00000000-0000-0000-0000-00000061d001'), 'renamed and its length changed — the price and the deposit as they were');
select pg_temp.check((select minutes = 40 and price is null and deposit is null and not active from public.booking_services
  where id = '00000000-0000-0000-0000-00000061d002'), 'her treatment: 40 minutes, no money, hidden');
-- money: never
select pg_temp.refused_with($$insert into public.booking_services (user_id, business_id, name, minutes, price) values
  ('00000000-0000-0000-0000-0000000610a2', '00000000-0000-0000-0000-00000061b001', 'גב', 45, 200)$$, 'רק בעלי העסק', 'no price');
select pg_temp.refused_with($$insert into public.booking_services (user_id, business_id, name, minutes, deposit) values
  ('00000000-0000-0000-0000-0000000610a2', '00000000-0000-0000-0000-00000061b001', 'גב', 45, 20)$$, 'רק בעלי העסק', 'no deposit');
select pg_temp.refused_with($$update public.booking_services set price = 1 where id = '00000000-0000-0000-0000-00000061d001'$$,
  'רק בעלי העסק', 'the price is not hers');
select pg_temp.refused_with($$update public.booking_services set deposit = null where id = '00000000-0000-0000-0000-00000061d001'$$,
  'רק בעלי העסק', 'nor the deposit');
-- deleting does nothing
delete from public.booking_services where id = '00000000-0000-0000-0000-00000061d001';
select pg_temp.check((select count(*) = 2 from public.booking_services where business_id = '00000000-0000-0000-0000-00000061b001'), 'deleting does nothing');
commit;

-- ---- the cashier still only reads; the owner sets the money -----------------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000610a3');
select pg_temp.refused_with($$insert into public.booking_services (user_id, business_id, name, minutes) values
  ('00000000-0000-0000-0000-0000000610a3', '00000000-0000-0000-0000-00000061b001', 'x', 30)$$, 'policy', 'a cashier adds nothing');
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000610a1');
update public.booking_services set price = 250, deposit = null where id = '00000000-0000-0000-0000-00000061d002';
select pg_temp.check((select price = 250 from public.booking_services where id = '00000000-0000-0000-0000-00000061d002'), 'the owner prices Gal''s treatment');
commit;

\i supabase/migrations/20261030006100_calendar_services.sql
select pg_temp.check((select count(*) = 1 from pg_trigger where tgname = 'b_booking_services_calendar_money'), 'idempotent');
