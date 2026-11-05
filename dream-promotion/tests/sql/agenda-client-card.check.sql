-- "יומן בלבד" opens the card of a calendar client (2.115, migration 6600) on a real Postgres (tests/sql/run.sh): Karin (agenda)
-- reads and writes the client file and the history of Miriam, who has an appointment; never of Dana, who has none; never the
-- messages. Gal (calendar) sees both, as before.
--   "Salon" A: owner a1, Gal a2 (calendar), Karin a3 (agenda); Miriam f001 (an appointment — booked by the owner), Dana f002 (none).
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
  ('00000000-0000-0000-0000-0000000660a1', 'owner@salon-66.test'), ('00000000-0000-0000-0000-0000000660a2', 'gal@salon-66.test'),
  ('00000000-0000-0000-0000-0000000660a3', 'karin@salon-66.test');
insert into public.businesses (id, name, slug) values ('00000000-0000-0000-0000-00000066b001', 'Salon', 'salon-66');
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-00000066b001', '00000000-0000-0000-0000-0000000660a1', 'owner', 'full'),
  ('00000000-0000-0000-0000-00000066b001', '00000000-0000-0000-0000-0000000660a2', 'editor', 'calendar'),
  ('00000000-0000-0000-0000-00000066b001', '00000000-0000-0000-0000-0000000660a3', 'editor', 'agenda');
insert into public.leads (id, user_id, business_id, name, phone) values
  ('00000000-0000-0000-0000-00000066f001', '00000000-0000-0000-0000-0000000660a1', '00000000-0000-0000-0000-00000066b001', 'מרים', '0501234567'),
  ('00000000-0000-0000-0000-00000066f002', '00000000-0000-0000-0000-0000000660a1', '00000000-0000-0000-0000-00000066b001', 'דנה', '0507654321');
insert into public.appointments (user_id, business_id, lead_id, name, start_at, end_at) values
  ('00000000-0000-0000-0000-0000000660a1', '00000000-0000-0000-0000-00000066b001', '00000000-0000-0000-0000-00000066f001', 'מרים',
   now() + interval '1 day', now() + interval '1 day 1 hour');
insert into public.client_treatments (id, business_id, lead_id, title) values
  ('00000000-0000-0000-0000-00000066c001', '00000000-0000-0000-0000-00000066b001', '00000000-0000-0000-0000-00000066f001', 'לייזר פנים'),
  ('00000000-0000-0000-0000-00000066c002', '00000000-0000-0000-0000-00000066b001', '00000000-0000-0000-0000-00000066f002', 'לייזר רגליים');
insert into public.lead_activities (user_id, business_id, lead_id, kind, body) values
  ('00000000-0000-0000-0000-0000000660a1', '00000000-0000-0000-0000-00000066b001', '00000000-0000-0000-0000-00000066f001', 'note', 'של מרים'),
  ('00000000-0000-0000-0000-0000000660a1', '00000000-0000-0000-0000-00000066b001', '00000000-0000-0000-0000-00000066f002', 'note', 'של דנה');
insert into public.social_messages (business_id, channel, external_id, lead_id, body) values
  ('00000000-0000-0000-0000-00000066b001', 'ig_comment', 'c-66-1', '00000000-0000-0000-0000-00000066f001', 'כמה עולה?');

select pg_temp.check(public.client_files_allowed_for('00000000-0000-0000-0000-0000000660a3', '00000000-0000-0000-0000-00000066b001'), 'Karin: the card (per client — below)');

begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000660a3');
select pg_temp.check(public.agenda_member() and public.calendar_member(), 'an agenda member, every calendar rule');
select pg_temp.check(public.calendar_lead('00000000-0000-0000-0000-00000066f001') and not public.calendar_lead('00000000-0000-0000-0000-00000066f002'), 'Miriam is in the calendar, Dana is not');
select pg_temp.check((select array_agg(title) from public.client_treatments) = array['לייזר פנים'], 'Miriam''s treatment only');
select pg_temp.check((select array_agg(body) from public.lead_activities) = array['של מרים'], 'Miriam''s history only');
insert into public.client_sessions (business_id, treatment_id, lead_id, at, notes) values
  ('00000000-0000-0000-0000-00000066b001', '00000000-0000-0000-0000-00000066c001', '00000000-0000-0000-0000-00000066f001', now() - interval '1 hour', 'טיפול');
select pg_temp.check(pg_temp.seen('client_sessions') = 1, 'she records Miriam''s session');
do $$ begin
  insert into public.client_sessions (business_id, treatment_id, lead_id, at, notes) values
    ('00000000-0000-0000-0000-00000066b001', '00000000-0000-0000-0000-00000066c002', '00000000-0000-0000-0000-00000066f002', now() - interval '1 hour', 'x');
  raise exception 'CHECK FAILED: a session for Dana';
exception when insufficient_privilege then null; end $$;
select pg_temp.check(pg_temp.seen('social_messages') = 0, 'never the messages');
select pg_temp.check(pg_temp.seen('documents') = 0 and pg_temp.seen('payments') = 0 and pg_temp.seen('client_packages') = 0, 'never money');
commit;

begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000660a2');
select pg_temp.check(pg_temp.seen('client_treatments') = 2 and pg_temp.seen('lead_activities') = 2 and pg_temp.seen('social_messages') = 1, 'Gal as before');
commit;

\i supabase/migrations/20261105006600_agenda_client_card.sql
select pg_temp.check(public.client_files_allowed_for('00000000-0000-0000-0000-0000000660a3', '00000000-0000-0000-0000-00000066b001'), 'idempotent');
