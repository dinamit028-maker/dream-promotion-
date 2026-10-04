-- Register 2.50 on a real Postgres (tests/sql/run.sh): stock triggers, refunds inside a lock, adjust_stock,
-- and the cashier's restrictive policies — tried as the signed-in roles, not as the superuser.
-- Every check raises "CHECK FAILED: …" when the database does not behave.
\set ON_ERROR_STOP 1
set client_min_messages = warning;

create or replace function pg_temp.check(ok boolean, msg text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'CHECK FAILED: %', msg; end if; end $$;
-- runs a statement that must be refused
create or replace function pg_temp.refused(stmt text, msg text) returns void language plpgsql as $$
begin
  execute stmt;
  raise exception 'CHECK FAILED: % (it was allowed)', msg;
exception when others then
  if sqlerrm like 'CHECK FAILED%' then raise; end if;
end $$;
create or replace function pg_temp.affected(stmt text) returns int language plpgsql as $$
declare n int; begin execute stmt; get diagnostics n = row_count; return n; end $$;

-- ---- the world: business B1 (owner O, cashier C), business B2 (owner X) ---------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@b1.test'),
  ('00000000-0000-0000-0000-0000000000c1', 'cashier@b1.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'owner@b2.test');
insert into public.businesses (id, name, slug) values
  ('00000000-0000-0000-0000-00000000b001', 'SaGabot', 'sagabot'), ('00000000-0000-0000-0000-00000000b002', 'FollowMe', 'followme');
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000000a1', 'owner', 'full'),
  ('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000000c1', 'editor', 'register'),
  ('00000000-0000-0000-0000-00000000b002', '00000000-0000-0000-0000-0000000000a2', 'owner', 'full');
insert into public.catalog_items (id, user_id, business_id, name, price, kind, track_stock, stock_qty, low_stock) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000b001', 'קרם', 100, 'product', true, 5, 2),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000b001', 'לייזר', 300, 'service', false, 0, 2);
insert into public.employees (id, user_id, business_id, name, token, commission_service_pct, commission_product_pct) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000b001', 'שגית', repeat('t', 32), 30, 10);
insert into public.leads (id, user_id, business_id, name) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000b001', 'דנה');

-- ---- the owner sells: stock goes out, logged ----------------------------------------------------
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
insert into public.sales (id, user_id, items, subtotal, discount, total, vat_rate, vat_amount, method, status, paid_at, employee_id)
values ('00000000-0000-0000-0000-000000005a01', '00000000-0000-0000-0000-0000000000a1',
  '[{"name":"קרם","price":100,"qty":2,"itemId":"00000000-0000-0000-0000-0000000000f1","kind":"product"},{"name":"לייזר","price":300,"qty":1,"itemId":"00000000-0000-0000-0000-0000000000f2","kind":"service"},{"name":"סכום חופשי","price":20,"qty":1},{"name":"x","qty":"junk","itemId":"00000000-0000-0000-0000-0000000000f1"}]',
  520, 0, 520, 18, 79.32, 'cash', 'paid', now(), '00000000-0000-0000-0000-0000000000e1');
select pg_temp.check((select stock_qty from public.catalog_items where id = '00000000-0000-0000-0000-0000000000f1') = 3, 'a sale of 2 creams leaves 3 (junk lines ignored)');
select pg_temp.check((select stock_qty from public.catalog_items where id = '00000000-0000-0000-0000-0000000000f2') = 0, 'an untracked service never moves');
select pg_temp.check((select count(*) from public.stock_movements where reason = 'sale' and delta = -2 and qty_after = 3) = 1, 'the sale is in the stock log');
select pg_temp.check((select business_id from public.sales where id = '00000000-0000-0000-0000-000000005a01') = '00000000-0000-0000-0000-00000000b001', 'the sale is filed under the business');
select pg_temp.refused($$update public.catalog_items set stock_qty = 99 where id = '00000000-0000-0000-0000-0000000000f1'$$, 'stock never changes by a bare update');
select pg_temp.check(public.adjust_stock('00000000-0000-0000-0000-0000000000f1', 'add', 10, 'משלוח') = 13, 'a delivery of 10');
select pg_temp.check(public.adjust_stock('00000000-0000-0000-0000-0000000000f1', 'set', 12, 'ספירה') = 12, 'a count of 12');
select pg_temp.check((select string_agg(reason || delta, ',' order by created_at, reason desc) from public.stock_movements) is not null
  and (select count(*) from public.stock_movements where reason in ('receive', 'count')) = 2, 'deliveries and counts are logged');
select pg_temp.refused($$select public.adjust_stock('00000000-0000-0000-0000-0000000000f1', 'add', 0)$$, 'a delivery of nothing');
select pg_temp.refused($$select public.adjust_stock('00000000-0000-0000-0000-0000000000f1', 'set', -1)$$, 'a negative count');

-- ---- refunds: inside the paid amount, stock back when asked, never cancelled afterwards ------------------
insert into public.sale_refunds (user_id, sale_id, amount, vat_amount, method, items, restock, reason)
values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000005a01', 100, 15.25, 'cash',
  '[{"name":"קרם","price":100,"qty":1,"itemId":"00000000-0000-0000-0000-0000000000f1","kind":"product"}]', true, 'פגום');
select pg_temp.check((select stock_qty from public.catalog_items where id = '00000000-0000-0000-0000-0000000000f1') = 13, 'the returned cream is back in stock');
select pg_temp.check((select count(*) from public.stock_movements where reason = 'refund' and refund_id is not null) = 1, 'the return is logged with its refund');
select pg_temp.refused($$insert into public.sale_refunds (user_id, sale_id, amount, method) values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000005a01', 420.01, 'cash')$$,
  'a refund beyond what was paid (520 − 100 = 420 left)');
insert into public.sale_refunds (user_id, sale_id, amount, method) values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000005a01', 420, 'card');
select pg_temp.check((select sum(amount) from public.sale_refunds where sale_id = '00000000-0000-0000-0000-000000005a01') = 520, 'exactly what was paid, in two refunds');
select pg_temp.refused($$update public.sale_refunds set amount = 1$$, 'a refund is final');
select pg_temp.refused($$delete from public.sale_refunds$$, 'a refund is never deleted');
select pg_temp.refused($$update public.sales set status = 'cancelled' where id = '00000000-0000-0000-0000-000000005a01'$$, 'a refunded sale is not cancelled');
-- an unpaid sale: no refund; cancelling it puts its units back
insert into public.sales (id, user_id, items, subtotal, total, method, status)
values ('00000000-0000-0000-0000-000000005a02', '00000000-0000-0000-0000-0000000000a1',
  '[{"name":"קרם","price":100,"qty":3,"itemId":"00000000-0000-0000-0000-0000000000f1","kind":"product"}]', 300, 300, 'link', 'pending');
select pg_temp.check((select stock_qty from public.catalog_items where id = '00000000-0000-0000-0000-0000000000f1') = 10, 'a payment request also takes the units');
select pg_temp.refused($$insert into public.sale_refunds (user_id, sale_id, amount, method) values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000005a02', 10, 'cash')$$,
  'no refund on an unpaid sale');
update public.sales set status = 'cancelled' where id = '00000000-0000-0000-0000-000000005a02';
select pg_temp.check((select stock_qty from public.catalog_items where id = '00000000-0000-0000-0000-0000000000f1') = 13, 'cancelling puts the units back');
commit;

-- ---- another business sees nothing and refunds nothing of B1 ---------------------------------------
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
select pg_temp.check((select count(*) from public.sale_refunds) = 0, 'B2 sees no B1 refunds');
select pg_temp.check((select count(*) from public.stock_movements) = 0, 'B2 sees no B1 stock log');
select pg_temp.refused($$insert into public.sale_refunds (user_id, sale_id, amount, method) values ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000005a01', 1, 'cash')$$,
  'B2 can not refund a B1 sale');
select pg_temp.refused($$select public.adjust_stock('00000000-0000-0000-0000-0000000000f1', 'add', 5)$$, 'B2 can not move B1 stock');
commit;

-- ---- the cashier: sells, sees only their own sales of today, nothing else ------------------------------
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
select pg_temp.check(public.my_access() = 'register', 'the cashier is register-only');
select pg_temp.check((select count(*) from public.sales) = 0, 'the owner''s sales are not visible to the cashier');
select pg_temp.check((select count(*) from public.catalog_items) = 2, 'the price list is visible');
select pg_temp.check((select count(*) from public.leads) = 1, 'customers are visible');
insert into public.sales (id, user_id, lead_id, items, subtotal, total, vat_rate, vat_amount, method, status, paid_at, employee_id)
values ('00000000-0000-0000-0000-000000005c01', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1',
  '[{"name":"קרם","price":100,"qty":1,"itemId":"00000000-0000-0000-0000-0000000000f1","kind":"product"}]', 100, 100, 18, 15.25, 'cash', 'paid', now(), '00000000-0000-0000-0000-0000000000e1');
select pg_temp.check((select count(*) from public.sales) = 1, 'the cashier sees the sale they just made');
select pg_temp.check((select stock_qty from public.catalog_items where id = '00000000-0000-0000-0000-0000000000f1') = 12, 'the cashier''s sale moves stock too');
insert into public.documents (user_id, doc_type, doc_number, doc_date, before_discount, after_discount, vat_amount, total, vat_rate, sale_id)
values ('00000000-0000-0000-0000-0000000000c1', 320, 0, current_date, 84.75, 84.75, 15.25, 100, 18, '00000000-0000-0000-0000-000000005c01');
select pg_temp.check((select count(*) from public.documents) = 1, 'the cashier sees the document of their sale');
select pg_temp.refused($$insert into public.documents (user_id, doc_type, doc_number, doc_date, before_discount, after_discount, vat_amount, total, vat_rate)
  values ('00000000-0000-0000-0000-0000000000c1', 330, 0, current_date, 1, 1, 0, 1, 18)$$, 'a cashier never issues a credit invoice');
select pg_temp.check(pg_temp.affected($$update public.sales set total = 1, subtotal = 1 where id = '00000000-0000-0000-0000-000000005c01'$$) = 0, 'a cashier changes no sale');
select pg_temp.check(pg_temp.affected($$update public.sales set status = 'cancelled'$$) = 0, 'a cashier cancels no sale');
select pg_temp.check(pg_temp.affected($$delete from public.sales$$) = 0, 'a cashier deletes no sale');
select pg_temp.refused($$insert into public.sale_refunds (user_id, sale_id, amount, method) values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000005c01', 10, 'cash')$$,
  'a cashier makes no refund');
select pg_temp.check((select count(*) from public.sale_refunds) = 0, 'refunds are not visible');
select pg_temp.check((select count(*) from public.stock_movements) = 0, 'the stock log is not visible');
select pg_temp.check((select count(*) from public.employees) = 0, 'the employees table (clock links) is not visible');
select pg_temp.check((select count(*) from public.pos_employees()) = 1, 'but the sellers'' names are, for the register');
select pg_temp.check(pg_temp.affected($$update public.catalog_items set price = 1$$) = 0, 'the price list is read-only');
select pg_temp.refused($$insert into public.catalog_items (user_id, name, price) values ('00000000-0000-0000-0000-0000000000c1', 'חדש', 1)$$, 'no new price-list items');
select pg_temp.refused($$select public.adjust_stock('00000000-0000-0000-0000-0000000000f1', 'add', 5)$$, 'no stock moves');
select pg_temp.check(pg_temp.affected($$update public.register_settings set vat_rate = 0$$) = 0, 'settings are read-only');
select pg_temp.refused($$insert into public.register_shifts (user_id, opening_cash) values ('00000000-0000-0000-0000-0000000000c1', 0)$$, 'no close of day');
select pg_temp.check(pg_temp.affected($$delete from public.leads$$) = 0, 'a cashier deletes no contact');
insert into public.leads (user_id, name) values ('00000000-0000-0000-0000-0000000000c1', 'לקוחה חדשה');
select pg_temp.check((select count(*) from public.leads) = 2, 'but adds new customers');
commit;

-- ---- back as the owner: everything the cashier did is there --------------------------------------------
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
select pg_temp.check(public.my_access() = 'full', 'the owner has full access');
select pg_temp.check((select count(*) from public.sales) = 3, 'the owner sees every sale, the cashier''s included');
select pg_temp.check((select count(*) from public.stock_movements where reason = 'sale') = 3, 'every sale is in the stock log');
select pg_temp.check((select count(*) from public.employees) = 1 and (select count(*) from public.pos_employees()) = 1, 'the owner sees employees');
commit;
