-- The calendar's phone notifications (2.112, migration 6300) on a real Postgres (tests/sql/run.sh): each notification is
-- claimed once per business (a second claim of the same key is refused); the table is the server's only — no browser reads it.
\set ON_ERROR_STOP 1
set client_min_messages = warning;

create or replace function pg_temp.check(ok boolean, msg text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'CHECK FAILED: %', msg; end if; end $$;
create or replace function pg_temp.as_user(uid text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', uid, true), set_config('request.jwt.claim.role', 'authenticated', true);
$$;

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000630a1', 'owner@salon-63.test');
insert into public.businesses (id, name, slug) values
  ('00000000-0000-0000-0000-00000063b001', 'Salon', 'salon-63'), ('00000000-0000-0000-0000-00000063b002', 'Other', 'other-63');
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-00000063b001', '00000000-0000-0000-0000-0000000630a1', 'owner', 'full');

insert into public.appointment_alerts (business_id, dedupe_key, user_id) values
  ('00000000-0000-0000-0000-00000063b001', 'soon:a1:u1', '00000000-0000-0000-0000-0000000630a1');
do $$ begin
  insert into public.appointment_alerts (business_id, dedupe_key, user_id) values
    ('00000000-0000-0000-0000-00000063b001', 'soon:a1:u1', '00000000-0000-0000-0000-0000000630a1');
  raise exception 'CHECK FAILED: the same notification claimed twice';
exception when unique_violation then null;
end $$;
-- the same key in another business is another notification
insert into public.appointment_alerts (business_id, dedupe_key, user_id) values
  ('00000000-0000-0000-0000-00000063b002', 'soon:a1:u1', '00000000-0000-0000-0000-0000000630a1');

begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000630a1');
do $$ begin
  perform 1 from public.appointment_alerts;
  raise exception 'CHECK FAILED: the browser read the server''s table';
exception when insufficient_privilege then null;
end $$;
commit;

\i supabase/migrations/20261031006300_appointment_alerts.sql
select pg_temp.check((select count(*) = 2 from public.appointment_alerts where dedupe_key = 'soon:a1:u1'), 'idempotent — nothing lost');
