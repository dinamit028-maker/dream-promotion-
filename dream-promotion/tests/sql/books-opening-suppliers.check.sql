-- Stage 4ד — the opening balances of suppliers (migration 7300) on a real Postgres (tests/sql/run.sh):
--   1. the migration again, twice (idempotent)
--   2. a supplier's line: refused when malformed (a dealer number of 9 digits or none, a name, never with "account"); a raw new key
--      "S-…" is still refused (a supplier's key is never typed — it is opened by the supplier's dealer number / name)
--   3. the opening: suppliers by dealer number and by name, a customer and BANK, the rest against 3100 — once
--   4. an expense of the same supplier afterwards posts to the very account the opening opened (by dealer number — whatever the
--      name; by the normalized name)
--   5. answer 13: the books' screens hidden by default; only the owner turns them on / off (audit log); gl_books_state says it
--      (every key of 7100 kept); the books post either way
-- Fixtures only, fictional: dealer numbers 000000059 / 000000067 (valid check digit), phones 050-00000NN, mails *.example.test.
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
create or replace function pg_temp.bal(p_key text) returns numeric language sql as $$
  select coalesce(sum(case l.side when 'D' then l.amount else -l.amount end), 0) from public.gl_lines l join public.gl_accounts a on a.id = l.account_id
   where a.business_id = '00000000-0000-0000-0000-0000007300b1' and a.key = p_key $$;
create temp table out73 (k text, j jsonb);
grant all on out73 to authenticated;
create or replace function pg_temp.o(p_k text) returns jsonb language sql as $$ select j from out73 where k = p_k $$;

-- ---- 1. the migration again, twice ---------------------------------------------------------------------------------------------
\ir ../../supabase/migrations/20261130007300_books_opening_suppliers.sql
\ir ../../supabase/migrations/20261130007300_books_opening_suppliers.sql
select pg_temp.check(has_function_privilege('authenticated', 'public.gl_opening_balances(jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.gl_opening_balances(jsonb)', 'execute'), 'the owner''s function, never anon');

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000007300a1', 'owner@open-73.example.test'),
  ('00000000-0000-0000-0000-0000007300a2', 'editor@open-73.example.test');
insert into public.businesses (id, name, slug) values ('00000000-0000-0000-0000-0000007300b1', 'Open 73', 'open-73');
insert into public.business_members (business_id, user_id, role, access, locations) values
  ('00000000-0000-0000-0000-0000007300b1', '00000000-0000-0000-0000-0000007300a1', 'owner', 'full', null),
  ('00000000-0000-0000-0000-0000007300b1', '00000000-0000-0000-0000-0000007300a2', 'editor', 'full', null);
update public.profiles set current_business_id = '00000000-0000-0000-0000-0000007300b1'
 where id in ('00000000-0000-0000-0000-0000007300a1', '00000000-0000-0000-0000-0000007300a2');
insert into public.register_settings (user_id, business_id, business_type, vat_rate, dealer_number, legal_name, street, city, entity_type) values
  ('00000000-0000-0000-0000-0000007300a1', '00000000-0000-0000-0000-0000007300b1', 'licensed', 18, '000000059', 'עסק פתיחה לדוגמה', 'הדוגמה', 'עיר דוגמה', 'licensed_dealer');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007300a1');
select public.gl_books_start_set(date_trunc('month', public.il_today())::date);
commit;

-- ---- 2. what a supplier's line may not be -----------------------------------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007300a1');
select pg_temp.refused_with($$select public.gl_opening_balances('[{"supplier": {"dealer": "12345", "name": "ספק"}, "side": "C", "amount": 10}]')$$,
  'opening_supplier', 'a dealer number of 9 digits');
select pg_temp.refused_with($$select public.gl_opening_balances('[{"supplier": {"dealer": "000000067", "name": " "}, "side": "C", "amount": 10}]')$$,
  'opening_supplier', 'a name');
select pg_temp.refused_with($$select public.gl_opening_balances('[{"supplier": "ספק", "side": "C", "amount": 10}]')$$,
  'opening_supplier', 'an object');
select pg_temp.refused_with($$select public.gl_opening_balances('[{"supplier": {"name": "ספק"}, "account": "BANK", "side": "C", "amount": 10}]')$$,
  'opening_supplier', 'never with "account"');
select pg_temp.refused_with($$select public.gl_opening_balances('[{"supplier": {"name": "ספק"}, "side": "X", "amount": 10}]')$$,
  'opening_line', 'a side');
select pg_temp.refused_with($$select public.gl_opening_balances('[{"account": "S-ספקחדש", "name": "ספק חדש", "side": "C", "amount": 10}]')$$,
  'opening_account', 'a raw new "S-…" key — reserved (a supplier is opened by its dealer number / name)');
select pg_temp.as_user('00000000-0000-0000-0000-0000007300a2');
select pg_temp.refused_with($$select public.gl_opening_balances('[{"supplier": {"name": "ספק"}, "side": "C", "amount": 10}]')$$,
  'not allowed', 'the owner only');
commit;
select pg_temp.check(not exists (select 1 from public.gl_accounts where business_id = '00000000-0000-0000-0000-0000007300b1' and role like 'supplier:%')
  and not exists (select 1 from public.gl_transactions where business_id = '00000000-0000-0000-0000-0000007300b1'), 'nothing refused was kept');

-- ---- 3. the opening -------------------------------------------------------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007300a1');
insert into out73 select 'open', public.gl_opening_balances('[
  {"supplier": {"dealer": "000000067", "name": "ספק פתיחה לדוגמה"}, "side": "C", "amount": 500},
  {"supplier": {"dealer": "", "name": "ספק בלי מספר"}, "side": "C", "amount": 200},
  {"account": "BANK", "side": "D", "amount": 1000},
  {"account": "050-0000081", "name": "לקוח פתיחה לדוגמה", "side": "D", "amount": 50}]');
select pg_temp.refused_with($$select public.gl_opening_balances('[{"supplier": {"name": "ספק אחר"}, "side": "C", "amount": 1}]')$$,
  'opening_done', 'once');
commit;
select pg_temp.check((pg_temp.o('open')->>'debit')::numeric = 1050 and (pg_temp.o('open')->>'credit')::numeric = 700
  and pg_temp.bal('S-000000067') = -500 and pg_temp.bal('S-ספקבלימספר') = -200 and pg_temp.bal('BANK') = 1000 and pg_temp.bal('050-0000081') = 50
  and pg_temp.bal('3100') = -350,
  'the opening: suppliers in credit, BANK and a customer in debit, the rest (350) on 3100');
select pg_temp.check((select role = public.gl_supplier_role('000000067', 'x') and parent_key = '2100' and dealer_number = '000000067' and name = 'ספק פתיחה לדוגמה'
                        from public.gl_accounts where business_id = '00000000-0000-0000-0000-0000007300b1' and key = 'S-000000067')
  and (select role = public.gl_supplier_role('', 'ספק בלי מספר') and dealer_number is null
         from public.gl_accounts where business_id = '00000000-0000-0000-0000-0000007300b1' and key = 'S-ספקבלימספר'),
  'the supplier accounts: under 2100, by dealer number (1419) or by name — the role of their expenses');

-- ---- 4. an expense of the same supplier afterwards: the same account ---------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007300a1');
insert into public.expenses (id, user_id, supplier_name, supplier_dealer, supplier_doc_type, doc_date, category, amount_before_vat, vat_amount, total, paid_on, payment_method)
values ('00000000-0000-0000-0000-0000007300e1', '00000000-0000-0000-0000-0000007300a1', 'שם אחר לגמרי בע״מ', '000000067', 'tax_invoice', public.il_today(), 'rent', 100, 18, 118, null, null),
       ('00000000-0000-0000-0000-0000007300e2', '00000000-0000-0000-0000-0000007300a1', 'ספק  בלי-מספר', '', 'receipt', public.il_today(), 'office', 30, 0, 30,
        public.il_today(), 'transfer');
commit;
select pg_temp.check(pg_temp.bal('S-000000067') = -618 and pg_temp.bal('S-ספקבלימספר') = -200
  and (select count(*) from public.gl_accounts where business_id = '00000000-0000-0000-0000-0000007300b1' and parent_key = '2100') = 2
  and not exists (select 1 from public.gl_unposted where business_id = '00000000-0000-0000-0000-0000007300b1'),
  'the expenses post to the opening''s accounts: by dealer number whatever the name; by the normalized name (paid — back to its opening)');
select pg_temp.check(not exists (select 1 from public.gl_transactions t where t.business_id = '00000000-0000-0000-0000-0000007300b1'
                       and (select sum(case side when 'D' then amount else -amount end) from public.gl_lines l where l.transaction_id = t.id) <> 0),
  'every entry balanced');

-- ---- 5. answer 13: the books' screens — hidden until the owner turns them on ------------------------------------------------------
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000007300a3', 'cashier@open-73.example.test');
insert into public.business_members (business_id, user_id, role, access, locations) values
  ('00000000-0000-0000-0000-0000007300b1', '00000000-0000-0000-0000-0000007300a3', 'editor', 'register', null);
update public.profiles set current_business_id = '00000000-0000-0000-0000-0000007300b1' where id = '00000000-0000-0000-0000-0000007300a3';
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007300a1');
insert into out73 select 'state before', public.gl_books_state();
select pg_temp.as_user('00000000-0000-0000-0000-0000007300a2');
select pg_temp.refused_with($$select public.gl_books_screens_set(true)$$, 'books_not_allowed', 'an editor does not turn them on');
select pg_temp.as_user('00000000-0000-0000-0000-0000007300a3');
select pg_temp.refused_with($$select public.gl_books_screens_set(true)$$, 'not allowed', 'never a cashier');
select pg_temp.as_user('00000000-0000-0000-0000-0000007300a1');
select pg_temp.refused_with($$select public.gl_books_screens_set(null)$$, 'books_screens', 'on or off');
insert into out73 select 'on', public.gl_books_screens_set(true);
insert into out73 select 'on again', public.gl_books_screens_set(true);
insert into out73 select 'state on', public.gl_books_state();
commit;
select pg_temp.check((pg_temp.o('state before')->>'showScreens')::boolean = false
  and (select array_agg(k order by k) from jsonb_object_keys(pg_temp.o('state before')) k)
      = array['canMoveStart', 'openingEntered', 'owner', 'showScreens', 'startDate', 'started', 'transactions']
  and (pg_temp.o('on')->>'changed')::boolean and not (pg_temp.o('on again')->>'changed')::boolean
  and (pg_temp.o('state on')->>'showScreens')::boolean
  and (select count(*) from public.finance_audit_log where business_id = '00000000-0000-0000-0000-0000007300b1' and action = 'books.screens_on') = 1,
  'hidden by default; the owner turns them on (once in the audit log); every key of gl_books_state kept');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000007300a1');
insert into out73 select 'off', public.gl_books_screens_set(false);
insert into public.expenses (id, user_id, supplier_name, supplier_dealer, supplier_doc_type, doc_date, category, amount_before_vat, vat_amount, total)
values ('00000000-0000-0000-0000-0000007300e3', '00000000-0000-0000-0000-0000007300a1', 'ספק פתיחה לדוגמה', '000000067', 'receipt', public.il_today(), 'office', 7, 0, 7);
commit;
select pg_temp.check((pg_temp.o('off')->>'showScreens')::boolean = false
  and (select show_screens from public.gl_books where business_id = '00000000-0000-0000-0000-0000007300b1') = false
  and pg_temp.bal('S-000000067') = -625,
  'turned off again — and the books post either way');
