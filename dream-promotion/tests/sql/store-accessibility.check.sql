-- The accessibility button of the site (2.104, migration 5600) on a real Postgres (tests/sql/run.sh). Every store shows it from
-- the start (true); the owner turns it off through the existing row-level security, another business cannot. The rest of sf_store
-- is 5500's (store-operator.check.sql still holds after it).
--   "Shop" owner A      "Other" owner B
\set ON_ERROR_STOP 1
set client_min_messages = warning;

create or replace function pg_temp.check(ok boolean, msg text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'CHECK FAILED: %', msg; end if; end $$;
create or replace function pg_temp.as_user(uid text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', uid, true), set_config('request.jwt.claim.role', 'authenticated', true);
$$;
create or replace function pg_temp.site() returns jsonb language sql as $$
  select public.sf_store('00000000-0000-0000-0000-000000566001', true)
$$;

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000560a1', 'a@shop-56.test'), ('00000000-0000-0000-0000-0000000560b1', 'b@other-56.test');
insert into public.businesses (id, name, slug) values
  ('00000000-0000-0000-0000-00000056b001', 'Shop', 'shop-56'), ('00000000-0000-0000-0000-00000056b002', 'Other', 'other-56');
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-00000056b001', '00000000-0000-0000-0000-0000000560a1', 'owner', 'full'),
  ('00000000-0000-0000-0000-00000056b002', '00000000-0000-0000-0000-0000000560b1', 'owner', 'full');
insert into public.stores (id, user_id, business_id, name, template, country) values
  ('00000000-0000-0000-0000-000000566001', '00000000-0000-0000-0000-0000000560a1', '00000000-0000-0000-0000-00000056b001', 'Shop', 'kit', 'IL');

-- ---- 1. every store, from the start: the button is shown ------------------------------------------------------------------------
select pg_temp.check((select a11y_widget from public.stores where id = '00000000-0000-0000-0000-000000566001'), 'a new store has the button');
select pg_temp.check(pg_temp.site()->'a11y_widget' = 'true'::jsonb, 'the site gets it: ' || coalesce(pg_temp.site()->>'a11y_widget', 'null'));
select pg_temp.check((select count(*) from public.stores where not a11y_widget) = 0, 'no store had it off when the column came');
-- a store that is not on the air shows a shopper only its name — nothing of the button either
select pg_temp.check(public.sf_store('00000000-0000-0000-0000-000000566001', false) ? 'a11y_widget' = false, 'not on the air: only the name');

-- ---- 2. the owner turns it off (and on again) -----------------------------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000560a1');
update public.stores set a11y_widget = false where id = '00000000-0000-0000-0000-000000566001';
commit;
select pg_temp.check(pg_temp.site()->'a11y_widget' = 'false'::jsonb, 'turned off by the owner: ' || (pg_temp.site()->>'a11y_widget'));

-- another business cannot touch it (row-level security: no row is even seen)
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000560b1');
update public.stores set a11y_widget = true where id = '00000000-0000-0000-0000-000000566001';
commit;
select pg_temp.check(pg_temp.site()->'a11y_widget' = 'false'::jsonb, 'another business cannot turn it on');

begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000560a1');
update public.stores set a11y_widget = true where id = '00000000-0000-0000-0000-000000566001';
commit;
select pg_temp.check(pg_temp.site()->'a11y_widget' = 'true'::jsonb, 'on again');

-- ---- 3. the rest of the store as before (5500's): the company, the contact, the menus ---------------------------------------------
select pg_temp.check(pg_temp.site() ?& array['legal', 'contact', 'menus', 'policies', 'collections', 'can_buy', 'slug', 'access'], 'the same keys as 5500, and one more');
select pg_temp.check((select count(*) from jsonb_object_keys(pg_temp.site())) = 23, 'one key more than 5500 (22): ' || (select string_agg(k, ',') from jsonb_object_keys(pg_temp.site()) k));

-- ---- 4. the function: the storefront's only ------------------------------------------------------------------------------------
select pg_temp.check(not has_function_privilege('authenticated', 'public.sf_store(uuid, boolean)', 'execute')
  and not has_function_privilege('anon', 'public.sf_store(uuid, boolean)', 'execute')
  and has_function_privilege('service_role', 'public.sf_store(uuid, boolean)', 'execute'), 'sf_store — the storefront''s server only');

select 'store-accessibility: ok';
