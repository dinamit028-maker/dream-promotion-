-- The company that runs the site (2.103, migration 5500) on a real Postgres (tests/sql/run.sh). Without it the site shows the
-- business's details for its documents (register_settings) — as before; with it, the store's own company, all of it: never the
-- business's number beside another company's name. The owner writes it through the existing row-level security; another
-- business cannot. The documents' details (register_settings) never change.
--   "Shop" owner A (an Israeli company, its documents)      "Other" owner B
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
create or replace function pg_temp.legal() returns jsonb language sql as $$
  select public.sf_store('00000000-0000-0000-0000-000000555001', true)->'legal'
$$;

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000550a1', 'a@shop.test'), ('00000000-0000-0000-0000-0000000550b1', 'b@other.test');
insert into public.businesses (id, name, slug) values
  ('00000000-0000-0000-0000-00000055b001', 'Shop', 'shop-55'), ('00000000-0000-0000-0000-00000055b002', 'Other', 'other-55');
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-00000055b001', '00000000-0000-0000-0000-0000000550a1', 'owner', 'full'),
  ('00000000-0000-0000-0000-00000055b002', '00000000-0000-0000-0000-0000000550b1', 'owner', 'full');
insert into public.register_settings (user_id, business_id, business_type, vat_rate, dealer_number, company_number, legal_name, street, house_no, city, entity_type) values
  ('00000000-0000-0000-0000-0000000550a1', '00000000-0000-0000-0000-00000055b001', 'licensed', 18, '512345678', '', 'החנות בע"מ', 'המגנים', '56', 'גן יבנה', null);
insert into public.stores (id, user_id, business_id, name, template, country) values
  ('00000000-0000-0000-0000-000000555001', '00000000-0000-0000-0000-0000000550a1', '00000000-0000-0000-0000-00000055b001', 'Shop', 'kit', 'IL');

-- ---- 1. no company of its own: the business's details, as before ---------------------------------------------------------------
select pg_temp.check(pg_temp.legal() = '{"name": "החנות בע\"מ", "number": "512345678", "number_kind": "dealer", "address": "המגנים 56, גן יבנה", "country": "IL"}'::jsonb,
  'without a company of its own, the site shows the business''s details (as before): ' || pg_temp.legal()::text);
select pg_temp.check(public.sf_store('00000000-0000-0000-0000-000000555001', false) ? 'legal' = false, 'a store that is not on the air shows a shopper nothing of it');

-- ---- 2. the owner names the company that runs the site --------------------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000550a1');
update public.stores set legal_name = 'Good Luck Forever Inc.', legal_address = '221 Rutgers St, Maplewood, NJ 07040', legal_country = 'US'
 where id = '00000000-0000-0000-0000-000000555001';
commit;
select pg_temp.check(pg_temp.legal() = '{"name": "Good Luck Forever Inc.", "number": "", "number_kind": "", "address": "221 Rutgers St, Maplewood, NJ 07040", "country": "US"}'::jsonb,
  'the store''s company, all of it — never the business''s number beside it: ' || pg_temp.legal()::text);
select pg_temp.check((select legal_name || '|' || dealer_number || '|' || city from public.register_settings where business_id = '00000000-0000-0000-0000-00000055b001')
  = 'החנות בע"מ|512345678|גן יבנה', 'the documents'' details do not change');

-- with its number (an EIN), shown with its kind; without a country of its own — the store's
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000550a1');
update public.stores set legal_number = '12-3456789', legal_number_kind = 'ein', legal_country = '' where id = '00000000-0000-0000-0000-000000555001';
commit;
select pg_temp.check(pg_temp.legal()->>'number' = '12-3456789' and pg_temp.legal()->>'number_kind' = 'ein' and pg_temp.legal()->>'country' = 'IL',
  'its number with its kind; no country of its own = the store''s: ' || pg_temp.legal()::text);

-- ---- 3. what is refused --------------------------------------------------------------------------------------------------------
select pg_temp.refused_with($$update public.stores set legal_number_kind = '' where id = '00000000-0000-0000-0000-000000555001'$$, 'stores_legal_check', 'a number without its kind');
select pg_temp.refused_with($$update public.stores set legal_name = '' where id = '00000000-0000-0000-0000-000000555001'$$, 'stores_legal_check', 'a number without a company');
select pg_temp.refused_with($$update public.stores set legal_number = 'abc' where id = '00000000-0000-0000-0000-000000555001'$$, 'stores_legal_check', 'a number that is not digits');
select pg_temp.refused_with($$update public.stores set legal_number_kind = 'vat' where id = '00000000-0000-0000-0000-000000555001'$$, 'stores_legal_check', 'an unknown kind of number');
select pg_temp.refused_with($$update public.stores set legal_country = 'usa' where id = '00000000-0000-0000-0000-000000555001'$$, 'stores_legal_check', 'a country of two capital letters only');
select pg_temp.refused_with($$update public.stores set legal_name = repeat('x', 121) where id = '00000000-0000-0000-0000-000000555001'$$, 'stores_legal_check', 'a name of up to 120');
select pg_temp.refused_with($$update public.stores set legal_address = repeat('x', 201) where id = '00000000-0000-0000-0000-000000555001'$$, 'stores_legal_check', 'an address of up to 200');

-- another business cannot touch it (row-level security: no row is even seen)
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000550b1');
update public.stores set legal_name = 'Someone Else' where id = '00000000-0000-0000-0000-000000555001';
commit;
select pg_temp.check(pg_temp.legal()->>'name' = 'Good Luck Forever Inc.', 'another business cannot name the company of this store');

-- ---- 4. emptied: the business's details again ----------------------------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000550a1');
update public.stores set legal_name = '', legal_number = '', legal_number_kind = '', legal_address = '', legal_country = '' where id = '00000000-0000-0000-0000-000000555001';
commit;
select pg_temp.check(pg_temp.legal()->>'name' = 'החנות בע"מ' and pg_temp.legal()->>'number' = '512345678', 'emptied — the business''s details again');

-- ---- 5. the function: the storefront's only ------------------------------------------------------------------------------------
select pg_temp.check(not has_function_privilege('authenticated', 'public.sf_store(uuid, boolean)', 'execute')
  and not has_function_privilege('anon', 'public.sf_store(uuid, boolean)', 'execute')
  and has_function_privilege('service_role', 'public.sf_store(uuid, boolean)', 'execute'), 'sf_store — the storefront''s server only');

select 'store-operator: ok';
