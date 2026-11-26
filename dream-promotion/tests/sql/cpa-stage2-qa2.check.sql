-- QA round 2 of 2.119.0 (stage 2), next to cpa-rules-stage2.check.sql and cpa-stage2-qa.check.sql, on the migrated database:
--   1. a member limited to one location can neither list nor download another location's delivered PDF through Storage (the bucket's
--      read policy asks document_delivery_files — its location gate); a file nobody recorded yet (uploaded, not "added") is read by no one
--   2. keyset paging (backup_export_after) over a table with a composite primary key whose FIRST column varies (bank_deposit_cheques):
--      every row exactly once across pages, in key order, for page sizes 1, 5, the exact size, one less, and past the end
-- Fixtures only, fictional: dealer number 000000018, mails *.example.test.
\set ON_ERROR_STOP 1
set client_min_messages = warning;

create or replace function pg_temp.check(ok boolean, msg text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'CHECK FAILED: %', msg; end if; end $$;
create or replace function pg_temp.refused_with(stmt text, expect text, msg text, state text default null) returns void language plpgsql as $$
begin
  execute stmt;
  raise exception 'CHECK FAILED: % (it was allowed)', msg;
exception when others then
  if sqlerrm like 'CHECK FAILED%' then raise; end if;
  if position(expect in sqlerrm) = 0 then raise exception 'CHECK FAILED: % (refused, but with "%")', msg, sqlerrm; end if;
  if state is not null and sqlstate <> state then raise exception 'CHECK FAILED: % (refused, but with sqlstate % — "%")', msg, sqlstate, sqlerrm; end if;
end $$;
create or replace function pg_temp.as_user(uid text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', uid, true), set_config('request.jwt.claim.role', 'authenticated', true);
$$;
create or replace function pg_temp.as_server() returns void language sql as $$
  select set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claim.role', 'service_role', true);
$$;
-- a document row the way the app sends it: one line, VAT 18%; a 320's payment in cash (the amount = the total)
create or replace function pg_temp.doc(p_user text, p_type int, p_before numeric, p_extra jsonb default '{}')
returns jsonb language sql as $$
  select jsonb_build_object('user_id', p_user, 'doc_type', p_type, 'doc_number', 0, 'doc_date', public.il_today(),
    'customer_name', 'לקוח לדוגמה', 'before_discount', p_before, 'discount', 0, 'after_discount', p_before, 'vat_amount', round(p_before * 0.18, 2),
    'total', p_before + round(p_before * 0.18, 2), 'vat_rate', 18,
    'lines', jsonb_build_array(jsonb_build_object('name', 'שירות', 'qty', 1, 'unitPriceExVat', p_before, 'discountExVat', 0, 'totalExVat', p_before, 'vatRate', 18, 'kind', 1)),
    'payments', case when p_type = 320 then jsonb_build_array(jsonb_build_object('method', 1, 'amount', p_before + round(p_before * 0.18, 2), 'date', public.il_today())) else '[]'::jsonb end)
    || p_extra;
$$;
create or replace function pg_temp.issue(r jsonb) returns uuid language plpgsql as $$
declare cols text; id uuid;
begin
  select string_agg(quote_ident(k), ', ') into cols from jsonb_object_keys(r) k;
  execute format('insert into public.documents (%s) select %s from jsonb_populate_record(null::public.documents, $1) returning id', cols, cols) using r into id;
  return id;
end $$;
create or replace function pg_temp.d(p_key text) returns uuid language sql as $$ select id from public.documents where idempotency_key = p_key $$;
create or replace function pg_temp.tok(p_key text) returns text language sql as $$ select share_token from public.documents where idempotency_key = p_key $$;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000693e1', 'owner@qa-693.example.test'), ('00000000-0000-0000-0000-0000000693e2', 'second@qa-693.example.test'),
  ('00000000-0000-0000-0000-0000000693e3', 'main@qa-693.example.test');
insert into public.businesses (id, name, slug) values ('00000000-0000-0000-0000-0000000693b1', 'QA 693', 'qa-693');
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-0000000693b1', '00000000-0000-0000-0000-0000000693e1', 'owner', 'full'),
  ('00000000-0000-0000-0000-0000000693b1', '00000000-0000-0000-0000-0000000693e2', 'editor', 'full'),
  ('00000000-0000-0000-0000-0000000693b1', '00000000-0000-0000-0000-0000000693e3', 'editor', 'full');
update public.profiles set current_business_id = '00000000-0000-0000-0000-0000000693b1'
 where id in ('00000000-0000-0000-0000-0000000693e1', '00000000-0000-0000-0000-0000000693e2', '00000000-0000-0000-0000-0000000693e3');
insert into public.register_settings (user_id, business_id, business_type, vat_rate, dealer_number, legal_name, street, city, entity_type)
values ('00000000-0000-0000-0000-0000000693e1', '00000000-0000-0000-0000-0000000693b1', 'licensed', 18, '000000018', 'עסק לדוגמה', 'הדוגמה', 'עיר דוגמה', 'licensed_dealer');
-- the main location is the business's own id; a second one
select pg_temp.check(exists (select 1 from public.business_locations where id = '00000000-0000-0000-0000-0000000693b1'), 'the business has its main location');
insert into public.business_locations (id, business_id, name) values ('00000000-0000-0000-0000-0000000693c2', '00000000-0000-0000-0000-0000000693b1', 'סניף שני');
update public.business_members set locations = array['00000000-0000-0000-0000-0000000693c2'::uuid] where user_id = '00000000-0000-0000-0000-0000000693e2';
update public.business_members set locations = array['00000000-0000-0000-0000-0000000693b1'::uuid] where user_id = '00000000-0000-0000-0000-0000000693e3';

-- one document in each location, each delivered to its customer; the server keeps each original's PDF
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000693e1');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000693e1', 305, 100, '{"idempotency_key": "l:main", "location_id": "00000000-0000-0000-0000-0000000693b1"}'));
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000693e1', 305, 100, '{"idempotency_key": "l:two", "location_id": "00000000-0000-0000-0000-0000000693c2"}'));
commit;
select pg_temp.check((select location_id from public.documents where idempotency_key = 'l:two') = '00000000-0000-0000-0000-0000000693c2'
  and coalesce((select location_id from public.documents where idempotency_key = 'l:main'), '00000000-0000-0000-0000-0000000693b1') = '00000000-0000-0000-0000-0000000693b1', 'two documents, two locations');
create temp table dv3 (k text, delivery_id uuid, path text);
grant select on dv3 to authenticated;
begin;
set local role service_role;
select pg_temp.as_server();
insert into dv3 select k, (r ->> 'delivery_id')::uuid, r ->> 'file_path'
  from (select k, public.document_share_open(pg_temp.tok(k)) as r from unnest(array['l:main', 'l:two']) k) x;
insert into storage.objects (bucket_id, name, metadata) select 'delivered-documents', path, '{"size": 1000}' from dv3;
select public.document_delivery_file_add(delivery_id, repeat('a', 64), 1000) from dv3;
-- a second delivery of l:two (a copy): its file is uploaded, but not recorded yet
insert into dv3 select 'l:two:copy', (r ->> 'delivery_id')::uuid, r ->> 'file_path' from (select public.document_share_open(pg_temp.tok('l:two'), 'pdf') as r) x;
insert into storage.objects (bucket_id, name, metadata) select 'delivered-documents', path, '{"size": 1000}' from dv3 where k = 'l:two:copy';
commit;
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'delivered-documents' and name like '00000000-0000-0000-0000-0000000693b1/%') = 3, 'three files in the bucket (two kept, one not recorded)');

-- the owner (no limit): both kept originals — not the one nobody recorded
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000693e1');
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'delivered-documents') = 2
  and (select count(*) from public.document_delivery_files) = 2, 'the owner lists both kept files, not the unrecorded one');
select pg_temp.check((select count(*) from storage.objects o join dv3 on dv3.path = o.name where o.bucket_id = 'delivered-documents' and dv3.k = 'l:two:copy') = 0,
  'a file nobody recorded yet is read by no one (not the owner either)');
commit;
-- the owner picks one location at the top: only that one
update public.profiles set current_location_id = '00000000-0000-0000-0000-0000000693c2' where id = '00000000-0000-0000-0000-0000000693e1';
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000693e1');
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'delivered-documents') = 1
  and (select count(*) from storage.objects o join dv3 on dv3.path = o.name where dv3.k = 'l:two') = 1, 'the location picked at the top: its file only');
commit;
update public.profiles set current_location_id = null where id = '00000000-0000-0000-0000-0000000693e1';
-- a member of the second location only
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000693e2');
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'delivered-documents') = 1
  and (select count(*) from storage.objects o join dv3 on dv3.path = o.name where dv3.k = 'l:two') = 1
  and (select count(*) from public.document_delivery_files) = 1, 'a member of the second location: its file only — the list');
select pg_temp.check((select count(*) from storage.objects o join dv3 on dv3.path = o.name where dv3.k = 'l:main') = 0, 'the main location''s file by its exact path (a download): not found');
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'delivered-documents' and name = (select path from dv3 where k = 'l:main')) = 0, 'by name — the same');
select pg_temp.check((select count(*) from public.document_deliveries) = 2 and (select count(*) from public.documents) = 1, 'and the records of the other location are not theirs either');
commit;
-- a member of the main location only: the opposite
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000693e3');
select pg_temp.check((select count(*) from storage.objects o join dv3 on dv3.path = o.name where dv3.k = 'l:main') = 1
  and (select count(*) from storage.objects where bucket_id = 'delivered-documents') = 1, 'a member of the main location: the main file only');
select pg_temp.check((select count(*) from storage.objects o join dv3 on dv3.path = o.name where dv3.k like 'l:two%') = 0, 'not the second location''s files');
commit;
-- the member's limit is the only difference: take it off and both are there
update public.business_members set locations = null where user_id = '00000000-0000-0000-0000-0000000693e2';
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000693e2');
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'delivered-documents') = 2, 'without the limit: both');
commit;

-- ---- 2. keyset paging over a composite key whose first column varies ---------------------------------------------------------------
-- 4 deposits × 3 cheques each (random ids: the pairs interleave)
insert into public.bank_deposits (id, business_id, location_id, number, deposited_on)
select gen_random_uuid(), '00000000-0000-0000-0000-0000000693b1', '00000000-0000-0000-0000-0000000693b1', n, public.il_today() from generate_series(1, 4) n;
insert into public.payments (id, business_id, direction, amount, method, paid_on, source)
select gen_random_uuid(), '00000000-0000-0000-0000-0000000693b1', 'in', 10, 'cheque', public.il_today(), 'document' from generate_series(1, 12);
create temp table pay693 as select row_number() over (order by id) as n, id from public.payments where business_id = '00000000-0000-0000-0000-0000000693b1';
insert into public.bank_deposit_cheques (deposit_id, business_id, location_id, payment_id, amount)
select d.id, d.business_id, d.location_id, p.id, 10
  from (select id, business_id, location_id, row_number() over (order by number) as dn from public.bank_deposits where business_id = '00000000-0000-0000-0000-0000000693b1') d
  join pay693 p on ((p.n - 1) / 3) + 1 = d.dn;
select pg_temp.check((select count(*) from public.bank_deposit_cheques where business_id = '00000000-0000-0000-0000-0000000693b1') = 12, '12 rows, 4 deposits');
select pg_temp.check((select count(distinct deposit_id) from public.bank_deposit_cheques where business_id = '00000000-0000-0000-0000-0000000693b1') = 4, 'the first column varies');
-- every page size: the pages joined are the table, once each, in key order
create or replace function pg_temp.walk(p_limit int) returns text language plpgsql as $$
declare after jsonb := null; pg jsonb; ids text[] := '{}'; pages int := 0; total int := null; r jsonb;
begin
  loop
    pg := public.backup_export_after('00000000-0000-0000-0000-0000000693b1', 'bank_deposit_cheques', after, p_limit);
    pages := pages + 1;
    if pages = 1 then total := (pg ->> 'total')::int; elsif pg ->> 'total' is not null then raise exception 'CHECK FAILED: total only on the first page'; end if;
    for r in select * from jsonb_array_elements(pg -> 'rows') loop ids := ids || ((r ->> 'deposit_id') || '/' || (r ->> 'payment_id')); end loop;
    if (pg ->> 'count')::int > p_limit then raise exception 'CHECK FAILED: a page of % rows over the limit %', pg ->> 'count', p_limit; end if;
    exit when not (pg ->> 'more')::boolean;
    if pg -> 'last' is null then raise exception 'CHECK FAILED: more, but no last key'; end if;
    after := pg -> 'last';
    if pages > 50 then raise exception 'CHECK FAILED: the paging does not end'; end if;
  end loop;
  if total <> 12 or cardinality(ids) <> 12 then raise exception 'CHECK FAILED: limit %: total %, rows %', p_limit, total, cardinality(ids); end if;
  if (select count(distinct x) from unnest(ids) x) <> 12 then raise exception 'CHECK FAILED: limit %: a row twice', p_limit; end if;
  if ids <> (select array_agg(deposit_id || '/' || payment_id order by deposit_id, payment_id) from public.bank_deposit_cheques where business_id = '00000000-0000-0000-0000-0000000693b1') then
    raise exception 'CHECK FAILED: limit %: not in key order', p_limit; end if;
  return pages || ' pages';
end $$;
select pg_temp.check(pg_temp.walk(1) = '12 pages', 'one row a page: 12 pages');
select pg_temp.check(pg_temp.walk(5) = '3 pages', 'pages of 5: 5 + 5 + 2');
select pg_temp.check(pg_temp.walk(11) = '2 pages', 'one less than the table: 11 + 1');
select pg_temp.check(pg_temp.walk(12) = '1 pages', 'exactly the table: one page, no "more"');
select pg_temp.check(pg_temp.walk(100) = '1 pages', 'more than the table: one page');
-- past the end: the last row's key gives an empty page, nothing more
select pg_temp.check((select (x ->> 'count')::int = 0 and not (x ->> 'more')::boolean and x -> 'last' is null
                        from (select public.backup_export_after('00000000-0000-0000-0000-0000000693b1', 'bank_deposit_cheques',
                          (select jsonb_build_object('deposit_id', deposit_id, 'payment_id', payment_id) from public.bank_deposit_cheques where business_id = '00000000-0000-0000-0000-0000000693b1' order by deposit_id desc, payment_id desc limit 1), 5) x) y),
  'after the last row: an empty page');
-- a row added between two pages (a live business): the walk neither repeats nor skips what was there
create temp table walk_state as select public.backup_export_after('00000000-0000-0000-0000-0000000693b1', 'bank_deposit_cheques', null, 5) as pg1;
insert into public.payments (id, business_id, direction, amount, method, paid_on, source) values ('00000000-0000-0000-0000-0000000693f1', '00000000-0000-0000-0000-0000000693b1', 'in', 10, 'cheque', public.il_today(), 'document');
insert into public.bank_deposit_cheques (deposit_id, business_id, location_id, payment_id, amount)
select id, business_id, location_id, '00000000-0000-0000-0000-0000000693f1', 10 from public.bank_deposits where business_id = '00000000-0000-0000-0000-0000000693b1' order by number limit 1;
select pg_temp.check((select (select count(*) from jsonb_array_elements(pg1 -> 'rows')) = 5 from walk_state)
  and (select count(distinct (r ->> 'deposit_id') || '/' || (r ->> 'payment_id'))
         from (select jsonb_array_elements(pg1 -> 'rows') r from walk_state
               union all select jsonb_array_elements(public.backup_export_after('00000000-0000-0000-0000-0000000693b1', 'bank_deposit_cheques', pg1 -> 'last', 100) -> 'rows') from walk_state) z) = 13,
  'a row inserted between two pages is in the file once (or not at all) — never a repeat, never one of the 12 missing');
