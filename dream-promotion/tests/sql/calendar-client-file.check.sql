-- The client file for a calendar member (2.111, migration 6200) on a real Postgres (tests/sql/run.sh): Gal ("יומן ולידים") opens
-- the client file — treatments, sessions, the messages — as the owner does; money stays closed (packages, documents); a cashier
-- and a full member the owner did not mark — as before; the owner's parts (the practitioners, the views log) stay the owner's.
--   "Salon" A: owner a1, Gal a2 (calendar), cashier a3, editor a4 (full, not marked).
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
  ('00000000-0000-0000-0000-0000000620a1', 'owner@salon-62.test'), ('00000000-0000-0000-0000-0000000620a2', 'gal@salon-62.test'),
  ('00000000-0000-0000-0000-0000000620a3', 'cashier@salon-62.test'), ('00000000-0000-0000-0000-0000000620a4', 'editor@salon-62.test');
insert into public.businesses (id, name, slug) values ('00000000-0000-0000-0000-00000062b001', 'Salon', 'salon-62');
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-00000062b001', '00000000-0000-0000-0000-0000000620a1', 'owner', 'full'),
  ('00000000-0000-0000-0000-00000062b001', '00000000-0000-0000-0000-0000000620a2', 'editor', 'calendar'),
  ('00000000-0000-0000-0000-00000062b001', '00000000-0000-0000-0000-0000000620a3', 'editor', 'register'),
  ('00000000-0000-0000-0000-00000062b001', '00000000-0000-0000-0000-0000000620a4', 'editor', 'full');
insert into public.leads (id, user_id, business_id, name, phone) values
  ('00000000-0000-0000-0000-00000062f001', '00000000-0000-0000-0000-0000000620a1', '00000000-0000-0000-0000-00000062b001', 'מרים', '0501234567');
insert into public.client_treatments (id, business_id, lead_id, title) values
  ('00000000-0000-0000-0000-00000062c001', '00000000-0000-0000-0000-00000062b001', '00000000-0000-0000-0000-00000062f001', 'לייזר פנים');
insert into public.social_messages (business_id, channel, external_id, lead_id, body) values
  ('00000000-0000-0000-0000-00000062b001', 'ig_comment', 'c-62-1', '00000000-0000-0000-0000-00000062f001', 'כמה עולה?');

select pg_temp.check(public.client_files_allowed_for('00000000-0000-0000-0000-0000000620a2', '00000000-0000-0000-0000-00000062b001'), 'Gal: the client file');
select pg_temp.check(public.client_files_allowed_for('00000000-0000-0000-0000-0000000620a1', '00000000-0000-0000-0000-00000062b001'), 'the owner as before');
select pg_temp.check(not public.client_files_allowed_for('00000000-0000-0000-0000-0000000620a3', '00000000-0000-0000-0000-00000062b001'), 'never a cashier');
select pg_temp.check(not public.client_files_allowed_for('00000000-0000-0000-0000-0000000620a4', '00000000-0000-0000-0000-00000062b001'), 'a full member not marked — as before');

begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000620a2');
select pg_temp.check(public.client_files_allowed(), 'in her session');
select pg_temp.check(pg_temp.seen('client_treatments') = 1, 'she sees the treatment');
insert into public.client_sessions (business_id, treatment_id, lead_id, at, notes) values
  ('00000000-0000-0000-0000-00000062b001', '00000000-0000-0000-0000-00000062c001', '00000000-0000-0000-0000-00000062f001', now() - interval '1 hour', 'טיפול ראשון');
select pg_temp.check(pg_temp.seen('client_sessions') = 1, 'and records a session');
select pg_temp.check(pg_temp.seen('social_messages') = 1, 'the messages of the contact');
select pg_temp.check(pg_temp.seen('client_packages') = 0 and pg_temp.seen('documents') = 0 and pg_temp.seen('payments') = 0, 'money: never');
select pg_temp.check(pg_temp.seen('client_file_access') = 0 and pg_temp.seen('client_file_views') = 0, 'the owner''s parts stay the owner''s');
select pg_temp.check(pg_temp.seen('content') = 0 and pg_temp.seen('employees') = 0, 'nothing else opened');
commit;

begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000620a3');
select pg_temp.check(pg_temp.seen('client_treatments') = 0 and pg_temp.seen('social_messages') = 0, 'the cashier as before');
commit;

\i supabase/migrations/20261031006200_calendar_client_file.sql
select pg_temp.check(public.client_files_allowed_for('00000000-0000-0000-0000-0000000620a2', '00000000-0000-0000-0000-00000062b001'), 'idempotent');

