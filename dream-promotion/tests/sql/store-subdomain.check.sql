-- Every store's own address and password (2.57.1, migration 3700) on a real Postgres (tests/sql/run.sh): the address made
-- from the business's name, unique in the system, reserved names refused; the storefront finds a store by it; the password
-- opens a store before publishing (or a locked one) and nothing else; its own domain, once working, becomes the primary.
--   "חנות פרחים" owner A, cashier K        "חנות פרחים" (another business) owner B        "Shop" owner C
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
create or replace function pg_temp.affected(stmt text) returns int language plpgsql as $$
declare n int; begin execute stmt; get diagnostics n = row_count; return n; end $$;
create or replace function pg_temp.as_user(uid text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', uid, true), set_config('request.jwt.claim.role', 'authenticated', true);
$$;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000370a1', 'a@flowers.test'), ('00000000-0000-0000-0000-0000000370c1', 'k@flowers.test'),
  ('00000000-0000-0000-0000-0000000370b1', 'b@flowers2.test'), ('00000000-0000-0000-0000-0000000370d1', 'c@shop.test');
insert into public.businesses (id, name, slug) values
  ('00000000-0000-0000-0000-00000037b001', 'חנות פרחים', 'flowers-37'), ('00000000-0000-0000-0000-00000037b002', 'חנות פרחים', 'flowers-37b'),
  ('00000000-0000-0000-0000-00000037b003', 'Shop', 'shop-37');
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-00000037b001', '00000000-0000-0000-0000-0000000370a1', 'owner', 'full'),
  ('00000000-0000-0000-0000-00000037b001', '00000000-0000-0000-0000-0000000370c1', 'editor', 'register'),
  ('00000000-0000-0000-0000-00000037b002', '00000000-0000-0000-0000-0000000370b1', 'owner', 'full'),
  ('00000000-0000-0000-0000-00000037b003', '00000000-0000-0000-0000-0000000370d1', 'owner', 'full');

-- ---- 1. opening a store: an address from the business's name, and a password ---------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000370a1');
insert into public.stores (id, name) values ('00000000-0000-0000-0000-000000375001', 'Flowers by A');
select pg_temp.check((select slug = 'hnvt-prhym' and length(storefront_password) = 10 and not password_lock and subdomain_seen_at is null
                      from public.stores where id = '00000000-0000-0000-0000-000000375001'),
  'the address comes from the business''s name (Hebrew transliterated); a password of 10');
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000370b1');
insert into public.stores (id, name) values ('00000000-0000-0000-0000-000000375002', 'Flowers by B');
select pg_temp.check((select slug from public.stores where id = '00000000-0000-0000-0000-000000375002') = 'hnvt-prhym-2', 'the same name in another business: the next free address');
select pg_temp.check((select count(*) from public.stores) = 1, 'and it sees only its own store');
commit;
select pg_temp.check((select storefront_password from public.stores where id = '00000000-0000-0000-0000-000000375002')
  <> (select storefront_password from public.stores where id = '00000000-0000-0000-0000-000000375001'), 'each store its own password');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000370d1');
insert into public.stores (id, name) values ('00000000-0000-0000-0000-000000375003', 'Shop');
select pg_temp.check((select slug ~ '^shop-[0-9]+$' from public.stores where id = '00000000-0000-0000-0000-000000375003'), 'a reserved name is never an address ("shop" → shop-2, or the next free)');
commit;

-- ---- 2. editing the address -----------------------------------------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000370a1');
select pg_temp.refused_with($$update public.stores set slug = 'admin' where id = '00000000-0000-0000-0000-000000375001'$$, 'store_slug_reserved', 'admin is reserved');
select pg_temp.refused_with($$update public.stores set slug = 'www' where id = '00000000-0000-0000-0000-000000375001'$$, 'store_slug_reserved', 'www is reserved');
select pg_temp.refused_with($$update public.stores set slug = 'xn--abc' where id = '00000000-0000-0000-0000-000000375001'$$, 'store_slug_', 'punycode is not an address');
select pg_temp.refused_with($$update public.stores set slug = 'two words' where id = '00000000-0000-0000-0000-000000375001'$$, 'store_slug_invalid', 'a space');
select pg_temp.refused_with($$update public.stores set slug = 'ab' where id = '00000000-0000-0000-0000-000000375001'$$, 'store_slug_invalid', 'too short');
select pg_temp.refused_with($$update public.stores set slug = 'a--b' where id = '00000000-0000-0000-0000-000000375001'$$, 'store_slug_invalid', 'a double hyphen');
select pg_temp.refused_with($$update public.stores set slug = 'hnvt-prhym-2' where id = '00000000-0000-0000-0000-000000375001'$$, 'stores_slug_uq', 'another store''s address');
select pg_temp.check((public.store_slug_available('hnvt-prhym-2')) @> '{"ok": false, "error": "taken", "suggestion": "hnvt-prhym-2-2"}', 'the screen hears "taken" and a free one');
select pg_temp.check((public.store_slug_available('API')) @> '{"ok": false, "error": "reserved"}', 'and "reserved" (case does not matter)');
select pg_temp.check((public.store_slug_available('-x-')) @> '{"ok": false, "error": "invalid"}', 'and "invalid"');
select pg_temp.check((public.store_slug_available('hnvt-prhym')) @> '{"ok": true}', 'its own address is free for it');
update public.stores set slug = ' Flowers-TLV ' where id = '00000000-0000-0000-0000-000000375001';
select pg_temp.check((select slug from public.stores where id = '00000000-0000-0000-0000-000000375001') = 'flowers-tlv', 'kept clean: lower case, no spaces');
-- another business's owner changes nothing here
select pg_temp.as_user('00000000-0000-0000-0000-0000000370b1');
select pg_temp.check(pg_temp.affected($$update public.stores set slug = 'mine-now' where id = '00000000-0000-0000-0000-000000375001'$$) = 0, 'never another business''s store');
-- a cashier: not the store's settings
select pg_temp.as_user('00000000-0000-0000-0000-0000000370c1');
select pg_temp.refused_with($$select public.store_slug_available('x-y-z')$$, 'not allowed', 'a cashier does not ask about addresses');
commit;

-- ---- 3. the storefront finds a store by its address -------------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000370a1');
select pg_temp.refused_with($$select public.sf_resolve_slug('flowers-tlv')$$, 'permission denied', 'only the storefront''s server');
select pg_temp.refused_with($$select public.sf_store_unlock('00000000-0000-0000-0000-000000375001', 'x')$$, 'permission denied', 'only the storefront''s server unlocks');
commit;
begin;
set local role service_role;
select pg_temp.check((public.sf_resolve_slug('FLOWERS-TLV')) @> '{"store": "00000000-0000-0000-0000-000000375001", "status": "draft", "primary": true, "primary_domain": null}',
  'the address finds its store (any case); it is the primary address while there is no working domain');
select pg_temp.check(public.sf_resolve_slug('hnvt-prhym') is null and public.sf_resolve_slug('') is null and public.sf_resolve_slug(null) is null,
  'an old or unknown address finds nothing');
select pg_temp.check((public.sf_resolve_slug('hnvt-prhym-2'))->>'store' = '00000000-0000-0000-0000-000000375002', 'and never another store');
-- served → a working address for the checklist
select public.sf_slug_seen('flowers-tlv');
select pg_temp.check((select subdomain_seen_at is not null from public.stores where id = '00000000-0000-0000-0000-000000375001'), 'seen');
commit;
select pg_temp.check(not ('domain' = any (public.store_missing((select s from public.stores s where s.id = '00000000-0000-0000-0000-000000375001')))),
  'the subdomain completes "a working address"');
select pg_temp.check('domain' = any (public.store_missing((select s from public.stores s where s.id = '00000000-0000-0000-0000-000000375002'))),
  'not before it was served');

-- ---- 4. the password -----------------------------------------------------------------------------------------------------
begin;
set local role service_role;
create temp table k1 as select (public.sf_store('00000000-0000-0000-0000-000000375001'))->'access' as a;
grant select on k1 to public;
select pg_temp.check((select a->>'mode' = 'password' and length(a->>'key') = 64 from k1), 'a draft with a password: open with it');
select pg_temp.check((select array_agg(k order by k) from jsonb_object_keys(public.sf_store('00000000-0000-0000-0000-000000375001')) k)
  = '{access,id,lang,logo_url,name,primary_domain,slug,status}', 'without the preview, still only the name — the storefront gates the rest');
select pg_temp.check(public.sf_store_unlock('00000000-0000-0000-0000-000000375001', 'wrong') is null, 'a wrong password opens nothing');
select pg_temp.check(public.sf_store_unlock('00000000-0000-0000-0000-000000375002',
  (select storefront_password from public.stores where id = '00000000-0000-0000-0000-000000375001')) is null, 'one store''s password never opens another');
select pg_temp.check(public.sf_store_unlock('00000000-0000-0000-0000-000000375001',
  ' ' || (select storefront_password from public.stores where id = '00000000-0000-0000-0000-000000375001') || ' ') = (select a->>'key' from k1),
  'the right one gives the key (spaces around it do not matter)');
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000370a1');
update public.stores set storefront_password = 'new-pass-1' where id = '00000000-0000-0000-0000-000000375001';
select pg_temp.refused_with($$update public.stores set storefront_password = 'abc' where id = '00000000-0000-0000-0000-000000375001'$$, 'stores_password_check', 'too short');
commit;
begin;
set local role service_role;
select pg_temp.check((public.sf_store('00000000-0000-0000-0000-000000375001'))#>>'{access,key}' <> (select a->>'key' from k1), 'a new password: a new key (everyone is signed out)');
select pg_temp.check(public.sf_store_unlock('00000000-0000-0000-0000-000000375001', 'new-pass-1') is not null, 'the new one opens');
commit;
-- no password: closed to everyone but the preview link
update public.stores set storefront_password = '' where id = '00000000-0000-0000-0000-000000375002';
begin;
set local role service_role;
select pg_temp.check((public.sf_store('00000000-0000-0000-0000-000000375002'))->'access' = '{"mode": "closed", "key": null}', 'no password: closed');
select pg_temp.check(public.sf_store_unlock('00000000-0000-0000-0000-000000375002', '') is null, 'an empty password opens nothing');
commit;
select pg_temp.refused_with($$update public.stores set password_lock = true where id = '00000000-0000-0000-0000-000000375002'$$,
  'store_lock_needs_password', 'a lock without a password would close it to everyone');
-- on the air (the checklist is the stores tests'; here the fixture puts it there directly): public, no key; locked: password
set session_replication_role = replica;
update public.stores set status = 'published' where id = '00000000-0000-0000-0000-000000375001';
set session_replication_role = origin;
begin;
set local role service_role;
select pg_temp.check((public.sf_store('00000000-0000-0000-0000-000000375001'))->'access' = '{"mode": "public", "key": null}', 'on the air: public');
select pg_temp.check(public.sf_store_unlock('00000000-0000-0000-0000-000000375001', 'new-pass-1') is null, 'nothing to unlock');
commit;
update public.stores set password_lock = true where id = '00000000-0000-0000-0000-000000375001';
begin;
set local role service_role;
select pg_temp.check((public.sf_store('00000000-0000-0000-0000-000000375001'))#>>'{access,mode}' = 'password', 'locked by the owner: the password again');
commit;

-- ---- 5. its own domain, once working, is the primary address -------------------------------------------------------------
insert into public.store_domains (business_id, store_id, domain, is_primary, status) values
  ('00000000-0000-0000-0000-00000037b001', '00000000-0000-0000-0000-000000375001', 'flowers-own.test', true, 'pending');
begin;
set local role service_role;
select pg_temp.check((public.sf_resolve_slug('flowers-tlv')) @> '{"primary": true, "primary_domain": null}', 'a domain not yet working: the subdomain stays primary');
select public.sf_domain_seen('flowers-own.test');
select pg_temp.check((public.sf_resolve_slug('flowers-tlv')) @> '{"primary": false, "primary_domain": "flowers-own.test"}', 'working: the subdomain points to it');
commit;
