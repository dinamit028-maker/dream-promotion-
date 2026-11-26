-- QA of 2.119.0 (stage 2 of the accountant's answers), next to cpa-rules-stage2.check.sql, on the migrated database:
--   1. the original is never consumed by reading: the staff's screens (select on documents, document_delivery_state, the view, the money
--      summary) record no delivery and move no print counter; the first real delivery is still the original afterwards
--   2. the customer's door to a document waiting for its allocation number, on every channel (link / pdf / storefront) — nothing told,
--      nothing recorded, nothing in the log, no file; a test number does not open it; the manual number does (and the first open is the original)
--   3. backups: a copy is never deleted before its retention to the day (keep_until = today may go, tomorrow may not), a monthly copy is
--      released only by a later yearly copy of the SAME scope, a failed call on an ok run changes nothing, a file is never written to the
--      path of an ok / failed run, a running run's file is not removable, a failed run's file is
-- Fixtures only, fictional: dealer numbers 000000NNN, mails *.example.test.
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

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000692e1', 'owner@qa-692.example.test');
insert into public.businesses (id, name, slug) values ('00000000-0000-0000-0000-0000000692b1', 'QA 692', 'qa-692'), ('00000000-0000-0000-0000-0000000692b2', 'QA 692 other', 'qa-692-other');
insert into public.business_members (business_id, user_id, role, access) values ('00000000-0000-0000-0000-0000000692b1', '00000000-0000-0000-0000-0000000692e1', 'owner', 'full');
update public.profiles set current_business_id = '00000000-0000-0000-0000-0000000692b1' where id = '00000000-0000-0000-0000-0000000692e1';
insert into public.register_settings (user_id, business_id, business_type, vat_rate, dealer_number, legal_name, street, city, entity_type)
values ('00000000-0000-0000-0000-0000000692e1', '00000000-0000-0000-0000-0000000692b1', 'licensed', 18, '000000034', 'עסק לדוגמה', 'הדוגמה', 'עיר דוגמה', 'licensed_dealer');

begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000692e1');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000692e1', 305, 7000, '{"idempotency_key": "q:big", "customer_dealer": "000000059"}'));
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000692e1', 305, 100, '{"idempotency_key": "q:small"}'));
commit;

-- ---- 1. reading never consumes the original ---------------------------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000692e1');
select pg_temp.check((select count(*) from public.documents) = 2, 'the owner reads both documents');
select pg_temp.check(public.document_delivery_state(pg_temp.d('q:small')) @> '{"delivered": false, "deliveries": 0, "printCount": 0, "original": null}'::jsonb, 'the state of an undelivered document');
select pg_temp.check(public.document_delivery_state(pg_temp.d('q:big')) @> '{"allocation": {"required": true, "awaiting": true}, "delivered": false}'::jsonb, 'the state of the one waiting');
select pg_temp.check((select count(*) from public.document_allocation_status where awaiting) = 1, 'the view');
select pg_temp.check(public.finance_summary(public.il_today(), public.il_today()) ->> 'allocationMissing' = '1', 'the money summary');
commit;
select pg_temp.check((select count(*) from public.document_deliveries where business_id = '00000000-0000-0000-0000-0000000692b1') = 0 and (select sum(print_count) from public.documents where business_id = '00000000-0000-0000-0000-0000000692b1') = 0
  and (select count(*) from public.finance_audit_log where business_id = '00000000-0000-0000-0000-0000000692b1' and action in ('document.delivered', 'document.printed')) = 0, 'after all that reading: no delivery, no print, nothing logged');

-- ---- 2. the customer's door to the one waiting ------------------------------------------------------------------------------------
begin;
set local role service_role;
select pg_temp.as_server();
select pg_temp.check(public.document_share_open(pg_temp.tok('q:big'), 'link') = '{"ok": false, "code": "awaiting_allocation"}'::jsonb
  and public.document_share_open(pg_temp.tok('q:big'), 'pdf') = '{"ok": false, "code": "awaiting_allocation"}'::jsonb
  and public.document_share_open(pg_temp.tok('q:big'), 'storefront') = '{"ok": false, "code": "awaiting_allocation"}'::jsonb,
  'link, pdf and storefront: only the code — not a field of the document');
select pg_temp.refused_with($$select public.document_share_open(pg_temp.tok('q:big'), 'email')$$, 'delivery_channel', 'a channel that is not the customer''s door');
select pg_temp.refused_with($$select public.document_share_open(pg_temp.tok('q:big'), null)$$, 'delivery_channel', 'no channel');
commit;
select pg_temp.check((select count(*) from public.document_deliveries where business_id = '00000000-0000-0000-0000-0000000692b1') = 0 and (select count(*) from public.finance_audit_log where business_id = '00000000-0000-0000-0000-0000000692b1' and action = 'document.delivered') = 0
  and (select count(*) from storage.objects where bucket_id = 'delivered-documents' and name like '00000000-0000-0000-0000-0000000692b1/%') = 0, 'nothing recorded, logged or kept for the one waiting');
-- a test number from the mock gateway does not open it
insert into public.tax_allocations (business_id, document_id, status, is_test, allocation_number, gateway)
  values ('00000000-0000-0000-0000-0000000692b1', pg_temp.d('q:big'), 'approved', true, 'TEST-1', 'mock');
begin;
set local role service_role;
select pg_temp.as_server();
select pg_temp.check(public.document_share_open(pg_temp.tok('q:big')) = '{"ok": false, "code": "awaiting_allocation"}'::jsonb, 'a test number does not open it');
commit;
-- a staff delivery of the one waiting is refused with the "awaiting" state (55000), on every channel the app has
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000692e1');
select pg_temp.refused_with(format($$select public.document_delivery_record(pg_temp.d('q:big'), %L)$$, c), 'awaiting_allocation', 'the app''s ' || c || ' of the one waiting', '55000')
  from unnest(array['print', 'pdf', 'email', 'whatsapp']) c;
select pg_temp.refused_with($$update public.documents set print_count = print_count + 1 where id = pg_temp.d('q:big')$$, 'awaiting', 'the old print counter');
commit;
-- the manual number: it opens, and the first open is the original (reading before did not use it up)
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000692e1');
select public.record_manual_allocation(pg_temp.d('q:big'), '123456789');
commit;
begin;
set local role service_role;
select pg_temp.as_server();
select pg_temp.check((public.document_share_open(pg_temp.tok('q:big')) ->> 'original')::boolean, 'with its number: delivered, and it is the original');
commit;

-- ---- 3. backups: retention to the day, the scope, and the files ---------------------------------------------------------------
create or replace function pg_temp.mkrun(p_id text, p_kind text, p_period text, p_business uuid, p_status text, p_keep date, p_fin timestamptz default '2018-04-01 03:00+00') returns void language plpgsql as $$
declare path text := coalesce(p_business::text, 'all') || '/' || p_kind || '/' || p_period || '/' || p_id || '.json.gz';
begin
  insert into public.backup_runs (id, kind, period, business_id, started_at, object_path) values (p_id::uuid, p_kind, p_period, p_business, '2018-04-01', path);
  insert into storage.objects (bucket_id, name) values ('backups', path);
  if p_status = 'ok' then
    update public.backup_runs set status = 'ok', finished_at = p_fin, sha256 = repeat('a', 64), bytes = 10, row_counts = '{}', keep_until = p_keep where id = p_id::uuid;
  elsif p_status = 'failed' then
    update public.backup_runs set status = 'failed', finished_at = '2018-04-01 03:00+00', error = 'qa' where id = p_id::uuid;
  end if;
end $$;
-- yearly copies of scope "all": the day it may go is its keep_until, to the day
select pg_temp.mkrun('00000000-0000-0000-0000-0000000692c1', 'yearly', '2017', null, 'ok', public.il_today());
select pg_temp.mkrun('00000000-0000-0000-0000-0000000692c2', 'yearly', '2016', null, 'ok', public.il_today() + 1);
begin;
set local role service_role;
select pg_temp.as_server();
select pg_temp.check((select array_agg(e ->> 'id') from jsonb_array_elements(public.backup_expirable()) e) = array['00000000-0000-0000-0000-0000000692c1'],
  'keep_until = today: it may go; tomorrow: it may not');
select pg_temp.refused_with($$select public.backup_expire('00000000-0000-0000-0000-0000000692c2')$$, 'backup_retention', 'a copy with one more day to keep stays', '55000');
-- a failed call on an ok run changes nothing, and its file is still locked
select pg_temp.check(public.backup_run_fail('00000000-0000-0000-0000-0000000692c2', 'a late error') @> '{"changed": false, "status": "ok"}'::jsonb, 'backup_run_fail on an ok run: nothing');
select pg_temp.refused_with($$delete from storage.objects where bucket_id = 'backups' and name like '%0000000692c2%'$$, 'stored_file_locked', 'the file of that ok run stays');
-- expire answers nothing for a run that is not ok
select pg_temp.mkrun('00000000-0000-0000-0000-0000000692c3', 'monthly', '2018-01', '00000000-0000-0000-0000-0000000692b1', 'failed', null);
select pg_temp.refused_with($$select public.backup_expire('00000000-0000-0000-0000-0000000692c3')$$, 'backup_retention', 'a failed run is not "expired"');
commit;
-- a monthly copy of business A: released by a later yearly copy of A, not of another business or of "all"
select pg_temp.mkrun('00000000-0000-0000-0000-0000000692c4', 'monthly', '2015-03', '00000000-0000-0000-0000-0000000692b1', 'ok', '2016-04-01');
select pg_temp.mkrun('00000000-0000-0000-0000-0000000692c5', 'yearly', '2015', '00000000-0000-0000-0000-0000000692b2', 'ok', public.il_today() + 100, '2018-05-01 03:00+00');
select pg_temp.mkrun('00000000-0000-0000-0000-0000000692c6', 'yearly', '2015', null, 'ok', public.il_today() + 100, '2018-05-01 03:00+00');
begin;
set local role service_role;
select pg_temp.as_server();
select pg_temp.refused_with($$select public.backup_expire('00000000-0000-0000-0000-0000000692c4')$$, 'backup_retention', 'another business''s (or "all"''s) yearly copy does not release it', '55000');
commit;
select pg_temp.mkrun('00000000-0000-0000-0000-0000000692c7', 'yearly', '2015', '00000000-0000-0000-0000-0000000692b1', 'ok', public.il_today() + 100, '2018-05-01 03:00+00');
begin;
set local role service_role;
select pg_temp.as_server();
select pg_temp.check(public.backup_expire('00000000-0000-0000-0000-0000000692c4') @> '{"changed": true}'::jsonb, 'its own yearly copy releases it');
commit;
-- the files: never written to the path of an ok / failed / expired run; a running run's file is not removable; a failed run's is
begin;
set local role service_role;
select pg_temp.as_server();
select pg_temp.refused_with($$insert into storage.objects (bucket_id, name) values ('backups', 'all/yearly/2016/00000000-0000-0000-0000-0000000692c2.json.gz')$$, 'stored_file_path', 'no second write to the path of an ok run');
select pg_temp.refused_with($$insert into storage.objects (bucket_id, name) values ('backups', 'all/yearly/2016/00000000-0000-0000-0000-0000000692c2.json.gz.v2')$$, 'stored_file_path', 'no file next to it either');
select pg_temp.refused_with($$insert into storage.objects (bucket_id, name) values ('backups', '00000000-0000-0000-0000-0000000692b1/monthly/2018-01/00000000-0000-0000-0000-0000000692c3.json.gz')$$, 'stored_file_path', 'nor to a failed run''s path');
with x as (delete from storage.objects where bucket_id = 'backups' and name like '%0000000692c3%' returning 1) select pg_temp.check((select count(*) from x) = 1, 'a failed run''s file may go');
create temp table r4 as select public.backup_run_start('monthly', '2018-02', '00000000-0000-0000-0000-0000000692b1') as r;
insert into storage.objects (bucket_id, name) select 'backups', r ->> 'object_path' from r4;
select pg_temp.refused_with($$delete from storage.objects where bucket_id = 'backups' and name = (select r ->> 'object_path' from r4)$$, 'stored_file_locked', 'a running run''s file is not removable');
commit;
