-- Locations and registers (migration 20261010004600, docs/FINANCE_ADDITIONS_HE.md T12א) on a real Postgres (tests/sql/run.sh).
-- The screens' calls run as the signed-in roles. Fixtures only, with ids of their own:
--   Shop LA (company, VAT 18%)   owner OA; manager MA (full access, limited to the new branch L2); cashier KA (the main location);
--                                cashier KB (the branch L2); viewer VA. Its main location (its own id), a branch L2 and a warehouse L3.
--   Clinic LB (one location)     owner OB — everything as before.
-- The Definition of Done: a business with one location works as before; a cashier of one location does not see another location.
-- Every check raises "CHECK FAILED: …" when the database does not behave.
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
-- a document row the way the app sends it (one line, ₪100 + VAT; payments for a receipt)
create or replace function pg_temp.doc(p_user text, p_type int, p_extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('user_id', p_user, 'doc_type', p_type, 'doc_number', 0, 'doc_date', public.il_today(),
    'customer_name', 'לקוח בדיקה', 'before_discount', 100, 'discount', 0, 'after_discount', 100, 'vat_amount', 18, 'total', 118, 'vat_rate', 18,
    'lines', '[{"name": "שירות", "qty": 1, "unitPriceExVat": 100, "discountExVat": 0, "totalExVat": 100, "vatRate": 18, "kind": 1}]'::jsonb,
    'payments', case when p_type in (320, 400) then jsonb_build_array(jsonb_build_object('method', 1, 'amount', 118, 'date', public.il_today())) else '[]'::jsonb end)
    || p_extra $$;
create or replace function pg_temp.issue(r jsonb) returns uuid language plpgsql as $$
declare cols text; id uuid;
begin
  select string_agg(quote_ident(k), ', ') into cols from jsonb_object_keys(r) k;
  execute format('insert into public.documents (%s) select %s from jsonb_populate_record(null::public.documents, $1) returning id', cols, cols) using r into id;
  return id;
end $$;
-- a paid sale of ₪118 at a register (or none), as the register screen writes it
create or replace function pg_temp.sale(p_id text, p_user text, p_register text default null, p_extra jsonb default '{}') returns uuid language plpgsql as $$
declare r jsonb; cols text; id uuid;
begin
  r := jsonb_build_object('id', p_id, 'user_id', p_user, 'items', '[{"name": "שירות", "price": 118, "qty": 1}]'::jsonb, 'subtotal', 118, 'total', 118,
    'vat_rate', 18, 'vat_amount', 18, 'method', 'cash', 'status', 'paid', 'paid_at', now()) || p_extra;
  if p_register is not null then r := r || jsonb_build_object('register_id', p_register); end if;
  select string_agg(quote_ident(k), ', ') into cols from jsonb_object_keys(r) k;
  execute format('insert into public.sales (%s) select %s from jsonb_populate_record(null::public.sales, $1) returning id', cols, cols) using r into id;
  return id;
end $$;
-- the location of a row: no location is the main one
create or replace function pg_temp.loc_of(p_table text, p_id text) returns uuid language plpgsql as $$
declare l uuid;
begin execute format('select coalesce(location_id, business_id) from public.%I where id = $1', p_table) using p_id::uuid into l; return l; end $$;

-- ---- the world --------------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000e46a01', 'oa@loc-a.test'), ('00000000-0000-0000-0000-000000e46a02', 'ma@loc-a.test'),
  ('00000000-0000-0000-0000-000000e46a03', 'ka@loc-a.test'), ('00000000-0000-0000-0000-000000e46a04', 'kb@loc-a.test'),
  ('00000000-0000-0000-0000-000000e46a05', 'va@loc-a.test'), ('00000000-0000-0000-0000-000000e46a06', 'ob@loc-b.test');
insert into public.businesses (id, name, slug) values
  ('00000000-0000-0000-0000-000000e46b01', 'Shop LA', 'loc-shop-a'), ('00000000-0000-0000-0000-000000e46b02', 'Clinic LB', 'loc-clinic-b');
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-000000e46b01', '00000000-0000-0000-0000-000000e46a01', 'owner', 'full'),
  ('00000000-0000-0000-0000-000000e46b01', '00000000-0000-0000-0000-000000e46a02', 'editor', 'full'),
  ('00000000-0000-0000-0000-000000e46b01', '00000000-0000-0000-0000-000000e46a03', 'editor', 'register'),
  ('00000000-0000-0000-0000-000000e46b01', '00000000-0000-0000-0000-000000e46a04', 'editor', 'register'),
  ('00000000-0000-0000-0000-000000e46b01', '00000000-0000-0000-0000-000000e46a05', 'viewer', 'full'),
  ('00000000-0000-0000-0000-000000e46b02', '00000000-0000-0000-0000-000000e46a06', 'owner', 'full');
update public.profiles set current_business_id = '00000000-0000-0000-0000-000000e46b01'
 where id in ('00000000-0000-0000-0000-000000e46a01', '00000000-0000-0000-0000-000000e46a02', '00000000-0000-0000-0000-000000e46a03',
              '00000000-0000-0000-0000-000000e46a04', '00000000-0000-0000-0000-000000e46a05');
update public.profiles set current_business_id = '00000000-0000-0000-0000-000000e46b02' where id = '00000000-0000-0000-0000-000000e46a06';
insert into public.register_settings (user_id, business_id, business_type, vat_rate, dealer_number, legal_name, street, city, entity_type) values
  ('00000000-0000-0000-0000-000000e46a01', '00000000-0000-0000-0000-000000e46b01', 'licensed', 18, '514000004', 'חנות לוק בע"מ', 'הרצל', 'תל אביב', 'company'),
  ('00000000-0000-0000-0000-000000e46a06', '00000000-0000-0000-0000-000000e46b02', 'licensed', 18, '514000012', 'קליניקה לוק בע"מ', 'הגפן', 'חיפה', 'company');

-- ======================================================================================================================
-- 1. every business has its main location and its first register — with the business's own id
-- ======================================================================================================================
select pg_temp.check((select count(*) = 2 from public.business_locations
                       where id in ('00000000-0000-0000-0000-000000e46b01', '00000000-0000-0000-0000-000000e46b02') and id = business_id
                         and name = 'ראשי' and active), 'a new business gets its main location (the trigger)');
select pg_temp.check((select count(*) = 2 from public.registers
                       where id in ('00000000-0000-0000-0000-000000e46b01', '00000000-0000-0000-0000-000000e46b02') and id = business_id
                         and location_id = business_id and name = 'קופה 1' and active), 'and its first register');

-- ======================================================================================================================
-- 2. the owner shapes the locations and registers — no one else
-- ======================================================================================================================
begin;
set local role anon;
select pg_temp.refused_with($$select public.location_save(null, 'x', 'store', '', '', '', true, 0)$$, 'permission denied', 'a visitor makes a location');
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e46a02');
select pg_temp.refused_with($$select public.location_save(null, 'סניף', 'store', '', '', '', true, 0)$$, 'not allowed', 'a manager (an editor) makes no location');
select pg_temp.as_user('00000000-0000-0000-0000-000000e46a03');
select pg_temp.refused_with($$select public.location_save(null, 'סניף', 'store', '', '', '', true, 0)$$, 'not allowed', 'a cashier makes no location');
select pg_temp.refused_with($$select public.register_save(null, '00000000-0000-0000-0000-000000e46b01', 'קופה 2', '', true, 0)$$, 'not allowed', 'a cashier makes no register');
select pg_temp.as_user('00000000-0000-0000-0000-000000e46a05');
select pg_temp.refused_with($$select public.location_save(null, 'סניף', 'store', '', '', '', true, 0)$$, 'not allowed', 'a viewer makes no location');
select pg_temp.as_user('00000000-0000-0000-0000-000000e46a01');
-- L2: a branch (a store) — its first register comes with it; the same save again is the same location
select pg_temp.check((public.location_save('00000000-0000-0000-0000-000000e46c02', 'סניף דיזנגוף', 'store', 'דיזנגוף 100, תל אביב', '03-5551234',
  'א׳–ה׳ 9:00–20:00', true, 1)->>'created')::boolean, 'the owner opens a branch');
select pg_temp.check(not (public.location_save('00000000-0000-0000-0000-000000e46c02', 'סניף דיזנגוף', 'store', 'דיזנגוף 100, תל אביב', '03-5551234',
  'א׳–ה׳ 9:00–20:00', true, 1)->>'created')::boolean, 'the same save again (its answer was lost): the same branch');
select pg_temp.check((select count(*) = 1 from public.registers where location_id = '00000000-0000-0000-0000-000000e46c02' and name = 'קופה 1' and active),
  'a place that sells gets its first register');
-- L3: a warehouse — no register
select pg_temp.check((public.location_save('00000000-0000-0000-0000-000000e46c03', 'מחסן', 'warehouse', 'החרש 5, חולון', '', '', true, 2)->>'created')::boolean,
  'a warehouse');
select pg_temp.check((select count(*) = 0 from public.registers where location_id = '00000000-0000-0000-0000-000000e46c03'), 'a warehouse sells nothing: no register');
select pg_temp.refused_with($$select public.location_save(null, '  סניף דיזנגוף ', 'store', '', '', '', true, 0)$$, 'business_locations_name_uq',
  'two locations of one business, one name');
select pg_temp.refused_with($$select public.location_save(null, 'x', 'office', '', '', '', true, 0)$$, 'business_locations_kind_check', 'a kind that is not a choice');
select pg_temp.refused_with($$select public.location_save('00000000-0000-0000-0000-000000e46b02', 'גניבה', 'store', '', '', '', true, 0)$$, 'not allowed',
  'another business''s location');
-- R2: a second register in the branch
select pg_temp.check((public.register_save('00000000-0000-0000-0000-000000e46d02', '00000000-0000-0000-0000-000000e46c02', 'קופה 2', 'טאבלט בדלפק', true, 1)->>'created')::boolean,
  'a second register in the branch');
select pg_temp.refused_with($$select public.register_save(null, '00000000-0000-0000-0000-000000e46b02', 'קופה זרה', '', true, 0)$$, 'register_location',
  'a register in another business''s location');
select pg_temp.refused_with($$select public.register_save(null, '00000000-0000-0000-0000-000000e46c02', 'קופה 2', '', true, 0)$$, 'registers_name_uq',
  'two registers of one location, one name');
commit;
select pg_temp.check((select count(*) = 3 from public.business_locations where business_id = '00000000-0000-0000-0000-000000e46b01'), 'three locations');
select pg_temp.check((select count(*) filter (where action = 'location.created') = 2 and count(*) filter (where action = 'location.changed') = 1
                        and count(*) filter (where action = 'register.created') = 1
                      from public.finance_audit_log where business_id = '00000000-0000-0000-0000-000000e46b01'), 'every change of the locations is in the log');
-- the limits: 10 locations a business, 10 registers a location (tried, then rolled back)
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e46a01');
select public.location_save(null, 'סניף ' || n, 'warehouse', '', '', '', true, 10 + n) from generate_series(1, 7) n;
select pg_temp.refused_with($$select public.location_save(null, 'האחד-עשר', 'store', '', '', '', true, 20)$$, 'locations_limit', 'an 11th location');
select public.register_save(null, '00000000-0000-0000-0000-000000e46c02', 'קופה ' || n, '', true, n) from generate_series(3, 10) n;
select pg_temp.refused_with($$select public.register_save(null, '00000000-0000-0000-0000-000000e46c02', 'קופה 11', '', true, 11)$$, 'registers_limit', 'an 11th register');
rollback;

-- ======================================================================================================================
-- 3. who may use which location: set by the super admin (SQL here), checked, in the log
-- ======================================================================================================================
select pg_temp.refused_with($$update public.business_members set locations = array['00000000-0000-0000-0000-000000e46b02'::uuid]
  where user_id = '00000000-0000-0000-0000-000000e46a02'$$, 'member_locations', 'a location of another business');
select pg_temp.refused_with($$update public.business_members set locations = '{}'::uuid[] where user_id = '00000000-0000-0000-0000-000000e46a02'$$,
  'member_locations', 'an empty list (none = all is null)');
update public.business_members set locations = array['00000000-0000-0000-0000-000000e46c02'::uuid, '00000000-0000-0000-0000-000000e46c02'::uuid]
 where user_id in ('00000000-0000-0000-0000-000000e46a02', '00000000-0000-0000-0000-000000e46a04');
update public.business_members set locations = array['00000000-0000-0000-0000-000000e46b01'::uuid] where user_id = '00000000-0000-0000-0000-000000e46a03';
select pg_temp.check((select locations = array['00000000-0000-0000-0000-000000e46c02'::uuid] from public.business_members
                       where user_id = '00000000-0000-0000-0000-000000e46a02'), 'a location twice is once');
select pg_temp.check((select count(*) = 3 from public.finance_audit_log where action = 'member.locations'
                       and business_id = '00000000-0000-0000-0000-000000e46b01'), 'limiting a member is in the log');

-- ======================================================================================================================
-- 4. what each one sees of the locations; the switch
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e46a01');
select pg_temp.check((select jsonb_array_length(s->'locations') = 3 and jsonb_array_length(s->'registers') = 3 and (s->>'owner')::boolean
                        and not (s->>'limited')::boolean and s->'current' = 'null'::jsonb and (s->'locations'->0->>'main')::boolean
                      from public.location_state() s), 'the owner: three locations, three registers, the main one first, all of them shown');
select pg_temp.as_user('00000000-0000-0000-0000-000000e46a02');
select pg_temp.check((select jsonb_array_length(s->'locations') = 1 and s->'locations'->0->>'id' = '00000000-0000-0000-0000-000000e46c02'
                        and jsonb_array_length(s->'registers') = 2 and (s->>'limited')::boolean and not (s->>'owner')::boolean
                      from public.location_state() s), 'the branch''s manager: the branch and its two registers only');
select pg_temp.check((select count(*) = 1 from public.business_locations), 'the manager reads one location');
select pg_temp.check((select count(*) = 2 from public.registers), 'and its registers');
select pg_temp.refused_with($$select public.location_select('00000000-0000-0000-0000-000000e46b01')$$, 'not allowed', 'the manager picks the main location');
select pg_temp.as_user('00000000-0000-0000-0000-000000e46a01');
select pg_temp.refused_with($$select public.location_select('00000000-0000-0000-0000-000000e46b02')$$, 'location_not_found', 'a location of another business');
commit;

-- ======================================================================================================================
-- 5. where a new row goes: its register, its sale, the document it pays, its store — else where the user works
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e46a01');
-- a sale at the branch's second register; a sale with no register (the main one's); a register of the branch with the main location
select pg_temp.sale('00000000-0000-0000-0000-000000e46e01', '00000000-0000-0000-0000-000000e46a01', '00000000-0000-0000-0000-000000e46d02');
select pg_temp.sale('00000000-0000-0000-0000-000000e46e02', '00000000-0000-0000-0000-000000e46a01');
select pg_temp.refused_with($$select pg_temp.sale('00000000-0000-0000-0000-000000e46e09', '00000000-0000-0000-0000-000000e46a01',
  '00000000-0000-0000-0000-000000e46d02', '{"location_id": "00000000-0000-0000-0000-000000e46b01"}')$$, 'location_mismatch', 'a register stands in one location');
select pg_temp.refused_with($$select pg_temp.sale('00000000-0000-0000-0000-000000e46e09', '00000000-0000-0000-0000-000000e46a01',
  '00000000-0000-0000-0000-000000e46b02')$$, 'register_not_found', 'another business''s register');
commit;
select pg_temp.check(pg_temp.loc_of('sales', '00000000-0000-0000-0000-000000e46e01') = '00000000-0000-0000-0000-000000e46c02', 'a sale is its register''s location');
select pg_temp.check((select location_id = business_id and register_id is null from public.sales where id = '00000000-0000-0000-0000-000000e46e02'),
  'a sale with no register: the main location');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e46a01');
-- the sale's document (320, paid at the branch); an invoice at the branch and its receipt; an invoice at the main location
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-000000e46a01', 320, jsonb_build_object('id', '00000000-0000-0000-0000-000000e46f01',
  'sale_id', '00000000-0000-0000-0000-000000e46e01', 'idempotency_key', 'sale:00000000-0000-0000-0000-000000e46e01')));
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-000000e46a01', 305, jsonb_build_object('id', '00000000-0000-0000-0000-000000e46f02',
  'location_id', '00000000-0000-0000-0000-000000e46c02', 'due_date', public.il_today() + 30, 'idempotency_key', 'direct:loc-305-branch')));
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-000000e46a01', 400, jsonb_build_object('id', '00000000-0000-0000-0000-000000e46f03',
  'paid_document_id', '00000000-0000-0000-0000-000000e46f02', 'idempotency_key', 'receipt:00000000-0000-0000-0000-000000e46f02:1',
  'lines', '[]'::jsonb, 'before_discount', 118, 'after_discount', 118, 'vat_amount', 0, 'vat_rate', 0)));
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-000000e46a01', 305, jsonb_build_object('id', '00000000-0000-0000-0000-000000e46f04',
  'due_date', public.il_today() + 30, 'idempotency_key', 'direct:loc-305-main')));
select pg_temp.refused_with($$select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-000000e46a01', 320, jsonb_build_object(
  'sale_id', '00000000-0000-0000-0000-000000e46e01', 'location_id', '00000000-0000-0000-0000-000000e46b01', 'idempotency_key', 'x:mismatch')))$$,
  'location_mismatch', 'a sale''s document in another location');
commit;
select pg_temp.check(pg_temp.loc_of('documents', '00000000-0000-0000-0000-000000e46f01') = '00000000-0000-0000-0000-000000e46c02', 'a sale''s document is the sale''s location');
select pg_temp.check(pg_temp.loc_of('documents', '00000000-0000-0000-0000-000000e46f03') = '00000000-0000-0000-0000-000000e46c02', 'a receipt is the invoice''s location');
select pg_temp.check(pg_temp.loc_of('documents', '00000000-0000-0000-0000-000000e46f04') = '00000000-0000-0000-0000-000000e46b01', 'a document of nothing else: the main location');
select pg_temp.check((select bool_and(coalesce(location_id, business_id) = '00000000-0000-0000-0000-000000e46c02') and count(*) = 2 from public.payments
                       where document_id in ('00000000-0000-0000-0000-000000e46f01', '00000000-0000-0000-0000-000000e46f03')),
  'the payments of the branch''s documents are the branch''s (the database writes them)');
select pg_temp.check((select issuer->'location'->>'name' = 'סניף דיזנגוף' and issuer->'location'->>'address' = 'דיזנגוף 100, תל אביב'
                      from public.documents where id = '00000000-0000-0000-0000-000000e46f01'), 'a document of a business with several locations names its own');
select pg_temp.check((select issuer->'location'->>'name' = 'ראשי' from public.documents where id = '00000000-0000-0000-0000-000000e46f04'),
  'the main location''s too');
select pg_temp.check((select array_agg(doc_number order by doc_number) = array[1, 2]::bigint[] from public.documents
                       where business_id = '00000000-0000-0000-0000-000000e46b01' and doc_type = 305),
  'one series of numbers for the whole business, whatever the location (the law)');
-- a refund of the branch's sale: the sale's location and register; the money out with it
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e46a01');
insert into public.sale_refunds (id, user_id, sale_id, amount, vat_amount, method, reason)
values ('00000000-0000-0000-0000-000000e46e11', '00000000-0000-0000-0000-000000e46a01', '00000000-0000-0000-0000-000000e46e01', 50, 0, 'cash', 'החזר');
-- an expense, an appointment: where the user works — all locations: the main one; or the one given
insert into public.expenses (id, user_id, supplier_name, doc_date, amount_before_vat, total)
values ('00000000-0000-0000-0000-000000e46e21', '00000000-0000-0000-0000-000000e46a01', 'ספק', public.il_today(), 100, 100);
insert into public.expenses (id, user_id, supplier_name, doc_date, amount_before_vat, total, location_id)
values ('00000000-0000-0000-0000-000000e46e22', '00000000-0000-0000-0000-000000e46a01', 'ספק סניף', public.il_today(), 100, 100, '00000000-0000-0000-0000-000000e46c02');
commit;
select pg_temp.check((select coalesce(location_id, business_id) = '00000000-0000-0000-0000-000000e46c02' and register_id = '00000000-0000-0000-0000-000000e46d02'
                      from public.sale_refunds where id = '00000000-0000-0000-0000-000000e46e11'), 'a refund: its sale''s location and register');
select pg_temp.check((select coalesce(location_id, business_id) = '00000000-0000-0000-0000-000000e46c02' from public.payments
                       where refund_id = '00000000-0000-0000-0000-000000e46e11'), 'the money of the refund: the same location');
select pg_temp.check(pg_temp.loc_of('expenses', '00000000-0000-0000-0000-000000e46e21') = '00000000-0000-0000-0000-000000e46b01'
                 and pg_temp.loc_of('expenses', '00000000-0000-0000-0000-000000e46e22') = '00000000-0000-0000-0000-000000e46c02', 'an expense: given, else the main location');
-- the store sends its orders from the branch: an order there, and its sale (the order's id)
insert into public.stores (id, user_id, business_id, name, slug, location_id)
values ('00000000-0000-0000-0000-000000e46e31', '00000000-0000-0000-0000-000000e46a01', '00000000-0000-0000-0000-000000e46b01', 'החנות', 'loc-shop-a-store',
        '00000000-0000-0000-0000-000000e46c02');
insert into public.orders (id, business_id, store_id, number, token_hash, subtotal, total, customer_name, customer_phone, customer_email, delivery_method,
                           terms_accepted_at, provider, expires_at)
values ('00000000-0000-0000-0000-000000e46e32', '00000000-0000-0000-0000-000000e46b01', '00000000-0000-0000-0000-000000e46e31', 1, repeat('a', 64), 118, 118,
        'קונה', '0501234567', 'buyer@loc.test', 'pickup', now(), 'mock', now() + interval '15 minutes');
insert into public.sales (id, user_id, business_id, items, subtotal, total, vat_rate, vat_amount, method, status, paid_at, channel)
values ('00000000-0000-0000-0000-000000e46e32', '00000000-0000-0000-0000-000000e46a01', '00000000-0000-0000-0000-000000e46b01',
        '[{"name": "מוצר", "price": 118, "qty": 1}]', 118, 118, 18, 18, 'card', 'paid', now(), 'online');
select pg_temp.check(pg_temp.loc_of('orders', '00000000-0000-0000-0000-000000e46e32') = '00000000-0000-0000-0000-000000e46c02', 'an order: its store''s location');
select pg_temp.check(pg_temp.loc_of('sales', '00000000-0000-0000-0000-000000e46e32') = '00000000-0000-0000-0000-000000e46c02', 'an online sale: its order''s location');

-- ======================================================================================================================
-- 6. reading: each one sees only the locations they may use — the Definition of Done (a cashier of one location, not another)
-- ======================================================================================================================
-- appointments today: one at the main location, one at the branch, at the same hour (two clinics, one hour)
insert into public.appointments (id, user_id, business_id, name, start_at, end_at, location_id) values
  ('00000000-0000-0000-0000-000000e46e41', '00000000-0000-0000-0000-000000e46a01', '00000000-0000-0000-0000-000000e46b01', 'תור ראשי',
   date_trunc('hour', now()) + interval '2 days', date_trunc('hour', now()) + interval '2 days 1 hour', null),
  ('00000000-0000-0000-0000-000000e46e42', '00000000-0000-0000-0000-000000e46a01', '00000000-0000-0000-0000-000000e46b01', 'תור סניף',
   date_trunc('hour', now()) + interval '2 days', date_trunc('hour', now()) + interval '2 days 1 hour', '00000000-0000-0000-0000-000000e46c02');
select pg_temp.refused_with($$insert into public.appointments (user_id, business_id, name, start_at, end_at)
  values ('00000000-0000-0000-0000-000000e46a01', '00000000-0000-0000-0000-000000e46b01', 'חופף',
          date_trunc('hour', now()) + interval '2 days 30 minutes', date_trunc('hour', now()) + interval '2 days 90 minutes')$$,
  'appointments_location_no_overlap', 'two appointments of one location at one hour');
begin;
set local role authenticated;
-- the cashier of the main location: its appointments, its locations and registers — nothing of the branch
select pg_temp.as_user('00000000-0000-0000-0000-000000e46a03');
select pg_temp.check((select array_agg(name) = array['תור ראשי'] from public.appointments), 'the main location''s cashier sees its appointments only');
select pg_temp.check((select count(*) = 1 from public.business_locations) and (select count(*) = 1 from public.registers),
  'and its location and register only');
select pg_temp.sale('00000000-0000-0000-0000-000000e46e51', '00000000-0000-0000-0000-000000e46a03', '00000000-0000-0000-0000-000000e46b01');
select pg_temp.refused_with($$select pg_temp.sale('00000000-0000-0000-0000-000000e46e52', '00000000-0000-0000-0000-000000e46a03', '00000000-0000-0000-0000-000000e46d02')$$,
  'not allowed', 'the main location''s cashier sells at the branch''s register');
-- the branch's cashier: the branch only
select pg_temp.as_user('00000000-0000-0000-0000-000000e46a04');
select pg_temp.check((select array_agg(name) = array['תור סניף'] from public.appointments), 'the branch''s cashier sees the branch''s appointments only');
select pg_temp.sale('00000000-0000-0000-0000-000000e46e53', '00000000-0000-0000-0000-000000e46a04');
select pg_temp.check(pg_temp.loc_of('sales', '00000000-0000-0000-0000-000000e46e53') = '00000000-0000-0000-0000-000000e46c02',
  'a sale with no register by the branch''s cashier: their only location');
select pg_temp.check((select count(*) = 1 from public.sales), 'the cashier sees their own sale of today, the branch''s');
select pg_temp.refused_with($$select pg_temp.sale('00000000-0000-0000-0000-000000e46e54', '00000000-0000-0000-0000-000000e46a04', '00000000-0000-0000-0000-000000e46b01')$$,
  'not allowed', 'the branch''s cashier sells at the main register');
-- the branch's manager (full access): the branch's money only
select pg_temp.as_user('00000000-0000-0000-0000-000000e46a02');
select pg_temp.check((select count(*) = 3 from public.sales) and (select count(*) = 3 from public.documents) and (select count(*) = 1 from public.expenses)
                 and (select count(*) = 1 from public.orders) and (select count(*) = 1 from public.sale_refunds),
  'the manager: the branch''s sales, documents, expense, order and refund — not the main location''s');
select pg_temp.check((select bool_and(coalesce(location_id, business_id) = '00000000-0000-0000-0000-000000e46c02') from public.payments),
  'and the branch''s payments only');
select pg_temp.check(pg_temp.affected($$update public.sales set note = 'x' where id = '00000000-0000-0000-0000-000000e46e02'$$) = 0,
  'the manager changes nothing of the main location (they do not see it)');
select pg_temp.refused_with($$insert into public.expenses (user_id, supplier_name, doc_date, amount_before_vat, total, location_id)
  values ('00000000-0000-0000-0000-000000e46a02', 'x', public.il_today(), 1, 1, '00000000-0000-0000-0000-000000e46b01')$$, 'not allowed',
  'the manager writes an expense of the main location');
insert into public.expenses (id, user_id, supplier_name, doc_date, amount_before_vat, total)
values ('00000000-0000-0000-0000-000000e46e55', '00000000-0000-0000-0000-000000e46a02', 'ספק', public.il_today(), 1, 1);
select pg_temp.check(pg_temp.loc_of('expenses', '00000000-0000-0000-0000-000000e46e55') = '00000000-0000-0000-0000-000000e46c02',
  'an expense by the manager, with no location: their branch');
commit;

-- a function writing on the manager's behalf is held too: money back on the main location's credit invoice
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e46a01');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-000000e46a01', 330, jsonb_build_object('id', '00000000-0000-0000-0000-000000e46f05',
  'base_doc_type', 305, 'base_doc_number', 2, 'idempotency_key', 'credit:00000000-0000-0000-0000-000000e46f04:1')));
commit;
select pg_temp.check(pg_temp.loc_of('documents', '00000000-0000-0000-0000-000000e46f05') = '00000000-0000-0000-0000-000000e46b01',
  'a credit invoice is its invoice''s location');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e46a02');
select pg_temp.refused_with($$select public.record_credit_refund('00000000-0000-0000-0000-000000e46f05', 'cash', 50, public.il_today(), '')$$,
  'not allowed', 'the branch''s manager pays back a credit of the main location');
commit;

-- ======================================================================================================================
-- 7. the switch: the owner works in the branch — sees it only, and writes there
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e46a01');
select pg_temp.check((select count(*) from public.sales) = 5 and (select count(*) from public.appointments) = 2, 'all locations: everything');
select public.location_select('00000000-0000-0000-0000-000000e46c02');
select pg_temp.check((select count(*) from public.sales) = 3 and (select array_agg(name) = array['תור סניף'] from public.appointments),
  'the branch picked: the branch only');
select pg_temp.check((select (s->>'current')::uuid = '00000000-0000-0000-0000-000000e46c02' from public.location_state() s), 'the switch remembers it');
insert into public.expenses (id, user_id, supplier_name, doc_date, amount_before_vat, total)
values ('00000000-0000-0000-0000-000000e46e61', '00000000-0000-0000-0000-000000e46a01', 'ספק', public.il_today(), 1, 1);
select pg_temp.check(pg_temp.loc_of('expenses', '00000000-0000-0000-0000-000000e46e61') = '00000000-0000-0000-0000-000000e46c02',
  'a new row goes to the location picked');
select pg_temp.refused_with($$insert into public.expenses (user_id, supplier_name, doc_date, amount_before_vat, total, location_id)
  values ('00000000-0000-0000-0000-000000e46a01', 'x', public.il_today(), 1, 1, '00000000-0000-0000-0000-000000e46b01')$$, 'row-level security',
  'with the branch picked, a row of the main location');
select public.location_select(null);
select pg_temp.check((select count(*) from public.sales) = 5, 'all locations again');
-- the business changes: the location picked of the other business does not narrow this one
commit;

-- ======================================================================================================================
-- 8. shifts: one open day per register — the same person may open two registers
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e46a01');
insert into public.register_shifts (id, user_id, opening_cash, register_id) values
  ('00000000-0000-0000-0000-000000e46e71', '00000000-0000-0000-0000-000000e46a01', 100, '00000000-0000-0000-0000-000000e46b01'),
  ('00000000-0000-0000-0000-000000e46e72', '00000000-0000-0000-0000-000000e46a01', 200, '00000000-0000-0000-0000-000000e46d02');
select pg_temp.refused_with($$insert into public.register_shifts (user_id, opening_cash, register_id)
  values ('00000000-0000-0000-0000-000000e46a01', 0, '00000000-0000-0000-0000-000000e46b01')$$, 'register_shifts_one_open', 'a second open day on one register');
select pg_temp.refused_with($$insert into public.register_shifts (user_id, opening_cash) values ('00000000-0000-0000-0000-000000e46a01', 0)$$,
  'register_shifts_one_open', 'a day opened by an older screen (no register) on a register that is open');
select pg_temp.refused_with($$select public.register_save('00000000-0000-0000-0000-000000e46d02', null, null, null, false, null)$$, 'register_open_shift',
  'a register with an open day is not closed down');
select pg_temp.refused_with($$select public.location_save('00000000-0000-0000-0000-000000e46c02', null, null, null, null, null, false, null)$$,
  'location_open_shift', 'nor its location');
update public.register_shifts set closed_at = now(), counted_cash = 200, expected_cash = 200, difference = 0 where id = '00000000-0000-0000-0000-000000e46e72';
select public.register_save('00000000-0000-0000-0000-000000e46d02', null, null, null, false, null);
select pg_temp.refused_with($$insert into public.register_shifts (user_id, opening_cash, register_id)
  values ('00000000-0000-0000-0000-000000e46a01', 0, '00000000-0000-0000-0000-000000e46d02')$$, 'register_inactive', 'no day opens on a closed-down register');
select pg_temp.refused_with($$select pg_temp.sale('00000000-0000-0000-0000-000000e46e73', '00000000-0000-0000-0000-000000e46a01',
  '00000000-0000-0000-0000-000000e46d02')$$, 'register_inactive', 'no sale at a closed-down register');
commit;
select pg_temp.check(pg_temp.loc_of('register_shifts', '00000000-0000-0000-0000-000000e46e72') = '00000000-0000-0000-0000-000000e46c02', 'a shift: its register''s location');
-- the warehouse closes; the last active location never does
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e46a01');
select public.location_save('00000000-0000-0000-0000-000000e46c03', null, null, null, null, null, false, null);
select pg_temp.refused_with($$select public.register_save(null, '00000000-0000-0000-0000-000000e46c03', 'קופה', '', true, 0)$$, 'register_location',
  'no register in a closed location');
select pg_temp.as_user('00000000-0000-0000-0000-000000e46a06');
select pg_temp.refused_with($$select public.location_save('00000000-0000-0000-0000-000000e46b02', null, null, null, null, null, false, null)$$, 'locations_last',
  'the last active location stays');
commit;

-- ======================================================================================================================
-- 9. a row keeps its location and register; a business with one location works as before
-- ======================================================================================================================
select pg_temp.refused_with($$update public.sales set location_id = '00000000-0000-0000-0000-000000e46b01' where id = '00000000-0000-0000-0000-000000e46e01'$$,
  'location_fixed', 'a sale moves to another location');
select pg_temp.refused_with($$update public.sales set register_id = '00000000-0000-0000-0000-000000e46b01' where id = '00000000-0000-0000-0000-000000e46e01'$$,
  'location_fixed', 'a sale moves to another register');
select pg_temp.check(pg_temp.affected($$update public.sales set note = 'נבדק' where id = '00000000-0000-0000-0000-000000e46e01'$$) = 1,
  'a sale is still changed as before (its location stays)');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e46a06');
select pg_temp.sale('00000000-0000-0000-0000-000000e46e81', '00000000-0000-0000-0000-000000e46a06');
insert into public.register_shifts (id, user_id, opening_cash) values ('00000000-0000-0000-0000-000000e46e82', '00000000-0000-0000-0000-000000e46a06', 50);
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-000000e46a06', 320, jsonb_build_object('id', '00000000-0000-0000-0000-000000e46f81',
  'sale_id', '00000000-0000-0000-0000-000000e46e81', 'idempotency_key', 'sale:00000000-0000-0000-0000-000000e46e81')));
select pg_temp.check((select count(*) = 1 from public.sales) and (select count(*) = 1 from public.documents) and (select count(*) = 1 from public.register_shifts),
  'one location: the owner sees all of theirs');
select pg_temp.check((select jsonb_array_length(s->'locations') = 1 and jsonb_array_length(s->'registers') = 1 from public.location_state() s),
  'one location, one register');
commit;
select pg_temp.check((select location_id = business_id from public.sales where id = '00000000-0000-0000-0000-000000e46e81')
                 and (select register_id = business_id and location_id = business_id from public.register_shifts where id = '00000000-0000-0000-0000-000000e46e82'),
  'one location: the main location (and the main register for the day)');
select pg_temp.check((select not (issuer ? 'location') from public.documents where id = '00000000-0000-0000-0000-000000e46f81'),
  'one location: the document is as before (no location on it)');
-- a day opened before 2.91 (no register) is the main register's: no second open day there (the unique index sees only registers)
update public.register_shifts set closed_at = now(), counted_cash = 50, expected_cash = 50, difference = 0 where id = '00000000-0000-0000-0000-000000e46e82';
alter table public.register_shifts disable trigger a_location_fill;
insert into public.register_shifts (id, user_id, business_id, opening_cash) values
  ('00000000-0000-0000-0000-000000e46e83', '00000000-0000-0000-0000-000000e46a06', '00000000-0000-0000-0000-000000e46b02', 30);
alter table public.register_shifts enable trigger a_location_fill;
select pg_temp.check((select register_id is null and location_id is null from public.register_shifts where id = '00000000-0000-0000-0000-000000e46e83'),
  'an open day from before registers');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e46a06');
select pg_temp.refused_with($$insert into public.register_shifts (user_id, opening_cash, register_id)
  values ('00000000-0000-0000-0000-000000e46a06', 0, '00000000-0000-0000-0000-000000e46b02')$$, 'register_shifts_one_open', 'a second open day beside it');
commit;
