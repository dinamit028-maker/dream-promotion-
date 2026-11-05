-- "יומן בלבד" (2.113, migration 6400) on a real Postgres (tests/sql/run.sh): Karin (agenda) works in the calendar as Gal
-- (calendar) does — adds and moves appointments, sees the leads' names for them — and never the client file or the messages;
-- every cashier rule is hers; no part in attendance.
--   "Salon" A: owner a1, Gal a2 (calendar), Karin a3 (agenda).
\set ON_ERROR_STOP 1
set client_min_messages = warning;

create or replace function pg_temp.check(ok boolean, msg text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'CHECK FAILED: %', msg; end if; end $$;
create or replace function pg_temp.as_user(uid text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', uid, true), set_config('request.jwt.claim.role', 'authenticated', true);
$$;
create or replace function pg_temp.seen(t text) returns bigint language plpgsql as $$
declare n bigint; begin execute format('select count(*) from public.%I', t) into n; return n; end $$;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000640a1', 'owner@salon-64.test'), ('00000000-0000-0000-0000-0000000640a2', 'gal@salon-64.test'),
  ('00000000-0000-0000-0000-0000000640a3', 'karin@salon-64.test');
insert into public.businesses (id, name, slug) values ('00000000-0000-0000-0000-00000064b001', 'Salon', 'salon-64');
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-00000064b001', '00000000-0000-0000-0000-0000000640a1', 'owner', 'full'),
  ('00000000-0000-0000-0000-00000064b001', '00000000-0000-0000-0000-0000000640a2', 'editor', 'calendar'),
  ('00000000-0000-0000-0000-00000064b001', '00000000-0000-0000-0000-0000000640a3', 'editor', 'agenda');
insert into public.leads (id, user_id, business_id, name, phone) values
  ('00000000-0000-0000-0000-00000064f001', '00000000-0000-0000-0000-0000000640a1', '00000000-0000-0000-0000-00000064b001', 'מרים', '0501234567');
insert into public.client_treatments (id, business_id, lead_id, title) values
  ('00000000-0000-0000-0000-00000064c001', '00000000-0000-0000-0000-00000064b001', '00000000-0000-0000-0000-00000064f001', 'לייזר פנים');
insert into public.social_messages (business_id, channel, external_id, lead_id, body) values
  ('00000000-0000-0000-0000-00000064b001', 'ig_comment', 'c-64-1', '00000000-0000-0000-0000-00000064f001', 'כמה עולה?');

select pg_temp.check(not public.client_files_allowed_for('00000000-0000-0000-0000-0000000640a3', '00000000-0000-0000-0000-00000064b001'), 'Karin: no client file');
select pg_temp.check(public.client_files_allowed_for('00000000-0000-0000-0000-0000000640a2', '00000000-0000-0000-0000-00000064b001'), 'Gal: as before');

begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000640a3');
select pg_temp.check(public.calendar_member(), 'every rule of the calendar is hers');
select pg_temp.check(public.my_access() = 'register', 'and every cashier rule');
select pg_temp.check(public.att_role() = 'none', 'no part in attendance');
select pg_temp.check(pg_temp.seen('leads') = 1, 'the client''s name for the appointment');
insert into public.appointments (user_id, business_id, lead_id, name, start_at, end_at)
  values ('00000000-0000-0000-0000-0000000640a3', '00000000-0000-0000-0000-00000064b001', '00000000-0000-0000-0000-00000064f001',
          'מרים', now() + interval '1 day', now() + interval '1 day 1 hour');
select pg_temp.check(pg_temp.seen('appointments') = 1, 'she adds an appointment');
update public.appointments set start_at = start_at + interval '2 hours', end_at = end_at + interval '2 hours';
select pg_temp.check(pg_temp.seen('client_treatments') = 0 and pg_temp.seen('client_photos') = 0 and pg_temp.seen('declarations') = 0, 'never the client file');
select pg_temp.check(pg_temp.seen('social_messages') = 0, 'never the messages');
select pg_temp.check(pg_temp.seen('documents') = 0 and pg_temp.seen('payments') = 0 and pg_temp.seen('content') = 0, 'nothing else');
commit;

begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000640a3');
do $$ begin
  insert into public.leads (user_id, business_id, name, phone) values
    ('00000000-0000-0000-0000-0000000640a3', '00000000-0000-0000-0000-00000064b001', 'בלי טלפון', '');
  raise exception 'CHECK FAILED: a client without a phone';
exception when sqlstate 'P0001' then null; end $$;
commit;

begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000640a2');
select pg_temp.check(pg_temp.seen('client_treatments') = 1 and pg_temp.seen('social_messages') = 1, 'Gal sees the card as before');
commit;

\i supabase/migrations/20261105006400_agenda_access.sql
select pg_temp.check((select pg_get_constraintdef(oid) like '%agenda%' from pg_constraint where conname = 'business_members_access_check'), 'idempotent');
