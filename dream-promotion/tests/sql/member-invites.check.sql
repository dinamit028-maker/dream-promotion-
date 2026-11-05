-- The invitations by link (2.114, migration 6500) on a real Postgres (tests/sql/run.sh): the server's table only — a signed-in
-- member and an anonymous visitor read and write nothing; a token is kept as its hash; a link is used once.
\set ON_ERROR_STOP 1
set client_min_messages = warning;

create or replace function pg_temp.check(ok boolean, msg text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'CHECK FAILED: %', msg; end if; end $$;
create or replace function pg_temp.as_user(uid text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', uid, true), set_config('request.jwt.claim.role', 'authenticated', true);
$$;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000650a1', 'owner@salon-65.test'), ('00000000-0000-0000-0000-0000000650a2', 'karin@salon-65.test');
insert into public.businesses (id, name, slug) values ('00000000-0000-0000-0000-00000065b001', 'Salon', 'salon-65');
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-00000065b001', '00000000-0000-0000-0000-0000000650a1', 'owner', 'full'),
  ('00000000-0000-0000-0000-00000065b001', '00000000-0000-0000-0000-0000000650a2', 'editor', 'agenda');
insert into public.member_invites (business_id, user_id, token_hash, access, expires_at) values
  ('00000000-0000-0000-0000-00000065b001', '00000000-0000-0000-0000-0000000650a2', repeat('ab', 32), 'agenda', now() + interval '48 hours');

-- only a hash, never the token
do $$ begin
  insert into public.member_invites (business_id, user_id, token_hash, access, expires_at) values
    ('00000000-0000-0000-0000-00000065b001', '00000000-0000-0000-0000-0000000650a2', 'not-a-hash', 'agenda', now() + interval '1 hour');
  raise exception 'CHECK FAILED: a token that is not a hash';
exception when check_violation then null; end $$;

-- used once: the conditional update takes it the first time only
create temp table taps (n int);
with u as (update public.member_invites set used_at = now() where token_hash = repeat('ab', 32) and used_at is null
  and revoked_at is null and expires_at > now() returning 1) insert into taps select count(*) from u;
with u as (update public.member_invites set used_at = now() where token_hash = repeat('ab', 32) and used_at is null
  and revoked_at is null and expires_at > now() returning 1) insert into taps select count(*) from u;
select pg_temp.check((select array_agg(n) from taps) = array[1, 0], 'the first tap takes it; a second — nothing');

-- the browser: nothing (the owner of the business too)
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000650a1');
do $$ begin
  perform count(*) from public.member_invites;
  raise exception 'CHECK FAILED: a member read the invitations';
exception when insufficient_privilege then null; end $$;
commit;
begin;
set local role anon;
do $$ begin
  perform count(*) from public.member_invites;
  raise exception 'CHECK FAILED: anon read the invitations';
exception when insufficient_privilege then null; end $$;
commit;

\i supabase/migrations/20261105006500_member_invites.sql
select pg_temp.check((select count(*) from public.member_invites) = 1, 'idempotent');
