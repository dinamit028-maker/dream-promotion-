-- The accountant's answers of 25.11.2026, stage 2 (2.119, migration 6900) on a real Postgres (tests/sql/run.sh):
--   1. (1, 2, 3א) the allocation-number rule in the database only: 305 / 320 / 330, a customer with a dealer number, from the
--      threshold of the document's date UP (≥), before VAT; a private customer never. Not delivered before the number:
--      the customer's link (document_share_open), a delivery from the app (document_delivery_record) and the old print counter.
--      finance_summary's allocationMissing = the same rule.
--   2. (4) an allocation number never changes (tax_allocations append-only, one real number per document).
--   3. (6) document_deliveries: the first delivery = the original, every later one a copy; one original per document; RLS.
--   4. (6 נוסף) the delivered PDF: bucket delivered-documents, only at the path of a recorded delivery, never replaced or removed;
--      document_delivery_files with its sha256; read by a finance member of the business only.
--   5. (20) backups: backup_runs (the server only, running → ok / failed, ok → expired), the export, the retention (12 months /
--      7 years, a monthly copy only after a later yearly one), the bucket backups (no browser role; a file removed only after expiry).
-- "Before": the migration's objects are taken off first (its rollback notes, as written at the end of the file), rows of two
-- businesses are written as before 6900 (an invoice above the threshold printed then, an allocation number entered), and then the
-- migration — once (as on the live database, over rows that exist) and again (it runs twice): every row stays exactly as it was.
-- Fixtures only, fictional: dealer numbers 000000NNN (valid check digit), mails *.example.test.
--   "Alpha" A: a1 owner, a2 cashier, a3 viewer (licensed dealer, 000000034)
--   "Beta"  B: b1 owner (licensed dealer, 000000042)
--   customers: a business 000000059, another 000000067; private customers (no dealer number)
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
-- the rule on a document that is not stored: only the fields it reads
create or replace function pg_temp.req(p_type int, p_date date, p_amount numeric, p_dealer text, p_issuer jsonb default null) returns boolean language sql as $$
  select public.allocation_required(jsonb_populate_record(null::public.documents, jsonb_build_object(
    'id', gen_random_uuid(), 'business_id', '00000000-0000-0000-0000-0000000690b1', 'doc_type', p_type, 'doc_date', p_date,
    'after_discount', p_amount, 'customer_dealer', coalesce(p_dealer, ''), 'issuer', p_issuer)));
$$;
-- every row of the tables 6900 may touch, as text, in a fixed order — "nothing that was there changed"
create or replace function pg_temp.snapshot() returns text language sql as $$
  select md5(coalesce((select string_agg(d::text, '|' order by d.id) from public.documents d), '')
      || coalesce((select string_agg(a::text, '|' order by a.id) from public.tax_allocations a), '')
      -- (the rules without the two new columns: they are the one thing the migration adds to their rows — the defaults)
      || coalesce((select string_agg((to_jsonb(r) - 'required_doc_types' - 'threshold_inclusive')::text, '|' order by r.version) from public.tax_allocation_rules r), '')
      || coalesce((select string_agg(p::text, '|' order by p.id) from public.payments p), '')
      || coalesce((select string_agg(c::text, '|' order by c.document_id) from public.document_cancellations c), '')
      || coalesce((select string_agg(s::text, '|' order by s.business_id) from public.register_settings s), '')
      || coalesce((select string_agg(l::text, '|' order by l.id) from public.finance_audit_log l), '')
      || coalesce((select string_agg(o::text, '|' order by o.id) from storage.objects o), ''));
$$;

-- ---- "before": the migration's objects taken off (its rollback notes, as written) ---------------------------------------------
drop trigger if exists dp_storage_objects_keep on storage.objects; drop function if exists public.storage_objects_keep();
drop policy if exists delivered_documents_read on storage.objects; drop policy if exists delivered_documents_read_gate on storage.objects;
drop policy if exists delivered_documents_anon_none on storage.objects; drop policy if exists delivered_documents_no_insert on storage.objects;
drop policy if exists delivered_documents_no_update on storage.objects; drop policy if exists delivered_documents_no_delete on storage.objects;
drop policy if exists backups_server_only on storage.objects;
drop function public.backup_expire(uuid), public.backup_expirable(), public.backup_may_expire(public.backup_runs),
  public.backup_run_fail(uuid, text), public.backup_run_finish(uuid, text, bigint, jsonb), public.backup_run_start(text, text, uuid),
  public.backup_period_end(text, text), public.backup_export_after(uuid, text, jsonb, int), public.backup_row(jsonb),
  public.backup_due(date), public.backup_orphans(), public.backup_businesses(), public.backup_tables();
drop function public.delivery_originals_unsaved(int);
drop table public.backup_runs; drop function public.backup_runs_guard();
drop function public.document_delivery_file_add(uuid, text, bigint), public.document_delivery_state(uuid),
  public.document_delivery_record(uuid, text), public.document_share_open(text, text),
  public.document_delivery_add(public.documents, text, uuid), public.document_visible(public.documents);
drop table public.document_delivery_files, public.document_deliveries;
drop trigger f_documents_print_allocation on public.documents; drop function public.documents_print_allocation();
drop view public.document_allocation_status;
drop function public.allocation_awaiting(public.documents), public.allocation_number_of(uuid),
  public.allocation_required(public.documents), public.allocation_rule_on(date);
alter table public.tax_allocation_rules drop column threshold_inclusive, drop column required_doc_types;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000690e1', 'owner@alpha-69.example.test'), ('00000000-0000-0000-0000-0000000690e2', 'cashier@alpha-69.example.test'),
  ('00000000-0000-0000-0000-0000000690e3', 'viewer@alpha-69.example.test'), ('00000000-0000-0000-0000-0000000690f1', 'owner@beta-69.example.test');
insert into public.businesses (id, name, slug) values
  ('00000000-0000-0000-0000-0000000690b1', 'Alpha 69', 'alpha-69'), ('00000000-0000-0000-0000-0000000690b2', 'Beta 69', 'beta-69');
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-0000000690b1', '00000000-0000-0000-0000-0000000690e1', 'owner', 'full'),
  ('00000000-0000-0000-0000-0000000690b1', '00000000-0000-0000-0000-0000000690e2', 'editor', 'register'),
  ('00000000-0000-0000-0000-0000000690b1', '00000000-0000-0000-0000-0000000690e3', 'viewer', 'full'),
  ('00000000-0000-0000-0000-0000000690b2', '00000000-0000-0000-0000-0000000690f1', 'owner', 'full');
update public.profiles set current_business_id = '00000000-0000-0000-0000-0000000690b1'
 where id in ('00000000-0000-0000-0000-0000000690e1', '00000000-0000-0000-0000-0000000690e2', '00000000-0000-0000-0000-0000000690e3');
update public.profiles set current_business_id = '00000000-0000-0000-0000-0000000690b2' where id = '00000000-0000-0000-0000-0000000690f1';
insert into public.register_settings (user_id, business_id, business_type, vat_rate, dealer_number, legal_name, street, city, entity_type) values
  ('00000000-0000-0000-0000-0000000690e1', '00000000-0000-0000-0000-0000000690b1', 'licensed', 18, '000000034', 'אלפא לדוגמה', 'הדוגמה', 'עיר דוגמה', 'licensed_dealer'),
  ('00000000-0000-0000-0000-0000000690f1', '00000000-0000-0000-0000-0000000690b2', 'licensed', 18, '000000042', 'בטא לדוגמה', 'הדוגמה', 'עיר דוגמה', 'licensed_dealer');

-- the documents of today, as issued before 6900
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000690e1', 305, 5000, '{"customer_dealer":"000000059","idempotency_key":"a:big"}'));
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000690e1', 305, 4999.99, '{"customer_dealer":"000000059","idempotency_key":"a:small"}'));
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000690e1', 305, 80000, '{"idempotency_key":"a:private"}'));
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000690e1', 320, 7000, '{"customer_dealer":"000000067","idempotency_key":"a:alloc"}'));
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000690e1', 305, 6000, '{"customer_dealer":"000000067","idempotency_key":"a:printed"}'));
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000690e1', 330, 5000, jsonb_build_object('customer_dealer', '000000067',
  'idempotency_key', 'a:credit', 'base_doc_type', 320, 'base_doc_number', (select doc_number from public.documents where idempotency_key = 'a:alloc'))));
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000690e2', 320, 100, '{"idempotency_key":"a:cashier"}'));
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000690f1', 305, 9000, '{"customer_dealer":"000000059","idempotency_key":"b:big"}'));
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000690f1', 320, 300, '{"idempotency_key":"b:private"}'));
-- printed then (the old counter — nothing stopped it before 6900), and an allocation number entered by hand
update public.documents set print_count = 1 where id = pg_temp.d('a:printed');
insert into public.tax_allocations (business_id, document_id, status, is_test, allocation_number, gateway)
  values ('00000000-0000-0000-0000-0000000690b1', pg_temp.d('a:alloc'), 'manual', false, '123456789', 'manual');

-- ---- the migration: over these rows (the first time), and again ------------------------------------------------------------
create temp table before_6900 as select pg_temp.snapshot() as s;
\ir ../../supabase/migrations/20261126006900_cpa_rules_stage2.sql
select pg_temp.check((select s from before_6900) = pg_temp.snapshot(), 'the migration over existing rows: every row stays as it was');
\ir ../../supabase/migrations/20261126006900_cpa_rules_stage2.sql
select pg_temp.check((select s from before_6900) = pg_temp.snapshot(), 'the migration again: every row stays as it was');
select pg_temp.check((select count(*) from public.document_deliveries) = 0 and (select count(*) from public.backup_runs) = 0, 'no delivery, no backup run made up');
select pg_temp.check((select count(*) from pg_trigger where tgname = 'f_documents_print_allocation' and tgrelid = 'public.documents'::regclass) = 1
  and (select count(*) from pg_trigger where tgname = 'dp_storage_objects_keep' and tgrelid = 'storage.objects'::regclass) = 1,
  'one print trigger, one Storage trigger after running twice');
select pg_temp.check((select count(*) from storage.buckets where id in ('delivered-documents', 'backups') and not public) = 2, 'two private buckets');

-- ---- 1. the rule -------------------------------------------------------------------------------------------------------------
select pg_temp.check((select count(*) = 4 and bool_and(required_doc_types = '{305,320,330}' and threshold_inclusive and doc_types = '{305,320}')
                        from public.tax_allocation_rules), 'every rule: 305 / 320 / 330, from the threshold up; the old column as it was');
select pg_temp.check(pg_temp.req(305, '2026-07-01', 5000, '000000059'), '305 of exactly ₪5,000 to a business (from 1.6.2026) — needs a number (≥)');
select pg_temp.check(not pg_temp.req(305, '2026-07-01', 4999.99, '000000059'), '₪4,999.99 — below the threshold');
select pg_temp.check(pg_temp.req(320, '2026-07-01', 5000, '000000059'), '320 of ₪5,000 to a business — needs one');
select pg_temp.check(pg_temp.req(330, '2026-07-01', 5000, '000000059'), 'a credit invoice 330 of ₪5,000 to a business — needs one (answer 2)');
select pg_temp.check(not pg_temp.req(305, '2026-07-01', 1000000, null) and not pg_temp.req(330, '2026-07-01', 1000000, ''),
  'a private customer never needs one, whatever the amount');
select pg_temp.check(not pg_temp.req(300, '2026-07-01', 100000, '000000059') and not pg_temp.req(400, '2026-07-01', 100000, '000000059'),
  'not an invoice 300 or a receipt 400');
select pg_temp.check(pg_temp.req(305, '2026-03-01', 10000, '000000059') and not pg_temp.req(305, '2026-03-01', 9999.99, '000000059'), '1.1.2026–31.5.2026: ₪10,000');
select pg_temp.check(pg_temp.req(305, '2026-05-31', 10000, '000000059') and not pg_temp.req(305, '2026-05-31', 5000, '000000059'), '31.5.2026 is still ₪10,000');
select pg_temp.check(pg_temp.req(305, '2025-06-01', 20000, '000000059') and not pg_temp.req(305, '2025-06-01', 19999.99, '000000059'), '2025: ₪20,000');
select pg_temp.check(pg_temp.req(305, '2024-06-01', 25000, '000000059') and not pg_temp.req(305, '2024-06-01', 24999.99, '000000059'), 'from 5.5.2024: ₪25,000');
select pg_temp.check(not pg_temp.req(305, '2024-05-04', 1000000, '000000059'), 'before 5.5.2024 — no rule');
select pg_temp.check(not pg_temp.req(305, '2026-07-01', 100000, '000000059', '{"entityType":"exempt_dealer"}'), 'an exempt dealer''s document (its issuer snapshot)');
select pg_temp.check((select array_agg(k order by k) from (values ('a:big'), ('a:small'), ('a:private'), ('a:alloc'), ('a:printed'), ('a:credit'), ('a:cashier'), ('b:big'), ('b:private')) v(k)
                       where public.allocation_awaiting((select d from public.documents d where d.idempotency_key = v.k)))
                     = array['a:big', 'a:credit', 'a:printed', 'b:big'], 'awaiting: the ₪5,000 invoice, the credit, the one printed before, Beta''s — not the one with its number');
-- a test number (mock gateway) never releases a document
insert into public.tax_allocations (business_id, document_id, status, is_test, allocation_number, gateway)
  values ('00000000-0000-0000-0000-0000000690b2', pg_temp.d('b:big'), 'approved', true, 'TEST-1', 'mock');
select pg_temp.check(public.allocation_awaiting((select d from public.documents d where d.idempotency_key = 'b:big')), 'a test number is not a number');
-- the money summary counts the same rule; the view says the same
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000690e1');
select pg_temp.check((public.finance_summary(public.il_today(), public.il_today()) ->> 'allocationMissing')::int = 3, 'allocationMissing of Alpha: 3 (≥ and the 330 count)');
select pg_temp.check((select count(*) from public.document_allocation_status where awaiting) = 3
  and (select allocation_number from public.document_allocation_status where document_id = pg_temp.d('a:alloc')) = '123456789'
  and (select count(*) from public.document_allocation_status) = 7, 'the view: Alpha''s documents only, the same 3 awaiting, the number');
commit;

-- the store's order page: "doc_awaiting" next to "doc_token" (a row of orders as the page passes it — only the fields it reads)
create or replace function pg_temp.order_view(p_doc uuid) returns jsonb language sql as $$
  select public.sf_order_view(jsonb_populate_record(null::public.orders, jsonb_build_object('id', gen_random_uuid(),
    'business_id', '00000000-0000-0000-0000-0000000690b1', 'document_id', p_doc)));
$$;
select pg_temp.check(pg_temp.order_view(pg_temp.d('a:big')) @> jsonb_build_object('doc_awaiting', true, 'doc_token', pg_temp.tok('a:big')),
  'the order''s page: its document waits for the number — doc_awaiting true (the token as before)');
select pg_temp.check(pg_temp.order_view(pg_temp.d('a:alloc')) @> jsonb_build_object('doc_awaiting', false, 'doc_token', pg_temp.tok('a:alloc')),
  'with its number — doc_awaiting false');
select pg_temp.check(pg_temp.order_view(null) @> '{"doc_awaiting": false, "doc_token": null}'::jsonb, 'no document yet — false, no token');
select pg_temp.check(pg_temp.order_view(pg_temp.d('b:big')) @> '{"doc_awaiting": false, "doc_token": null}'::jsonb, 'another business''s document — nothing of it');
select pg_temp.check(not has_function_privilege('anon', 'public.sf_order_view(public.orders)', 'execute')
  and not has_function_privilege('authenticated', 'public.sf_order_view(public.orders)', 'execute')
  and (select prosecdef from pg_proc where oid = 'public.sf_order_view(public.orders)'::regprocedure), 'the order view: still the servers'' only, security definer');

-- ---- 2. an allocation number never changes -------------------------------------------------------------------------------------
select pg_temp.refused_with($$update public.tax_allocations set allocation_number = '987654321' where document_id = pg_temp.d('a:alloc')$$, 'append-only', 'a number is never edited');
select pg_temp.refused_with($$delete from public.tax_allocations where document_id = pg_temp.d('a:alloc')$$, 'append-only', 'a number is never removed');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000690e1');
select pg_temp.refused_with($$select public.record_manual_allocation(pg_temp.d('a:alloc'), '987654321')$$, 'already has', 'no second number for a document');
commit;

-- ---- 1 + 3. the customer's link: blocked before the number; the first open is the original -----------------------------------
select pg_temp.check(not has_function_privilege('anon', 'public.document_share_open(text, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.document_share_open(text, text)', 'execute')
  and has_function_privilege('service_role', 'public.document_share_open(text, text)', 'execute'), 'the link: the server only');
begin;
set local role service_role;
select pg_temp.as_server();
select pg_temp.check(public.document_share_open('nope') = '{"ok": false, "code": "not_found"}'::jsonb
  and public.document_share_open(repeat('0', 64)) = '{"ok": false, "code": "not_found"}'::jsonb, 'an unknown link — not found');
select pg_temp.check(public.document_share_open(pg_temp.tok('a:big')) = '{"ok": false, "code": "awaiting_allocation"}'::jsonb
  and public.document_share_open(pg_temp.tok('a:credit'), 'pdf') = '{"ok": false, "code": "awaiting_allocation"}'::jsonb
  and public.document_share_open(pg_temp.tok('a:printed'), 'storefront') = '{"ok": false, "code": "awaiting_allocation"}'::jsonb,
  'awaiting its number: the link, the PDF and the storefront say so — and tell nothing of the document');
select pg_temp.check((public.document_share_open(pg_temp.tok('a:private')) ->> 'original')::boolean, 'the first open of the link is the original');
select pg_temp.check(public.document_share_open(pg_temp.tok('a:private'), 'pdf') ->> 'mark' = 'העתק נאמן למקור'
  and not (public.document_share_open(pg_temp.tok('a:private')) ->> 'original')::boolean, 'the PDF after it, and the link again — copies');
select pg_temp.check((public.document_share_open(pg_temp.tok('a:alloc')) ->> 'original')::boolean, 'with its allocation number — delivered, the original');
select pg_temp.refused_with($$select public.document_share_open(pg_temp.tok('a:private'), 'print')$$, 'delivery_channel', 'the link does not print');
commit;
select pg_temp.check((select count(*) from public.document_deliveries) = 4 and (select count(*) from public.document_deliveries where is_original) = 2
  and not exists (select 1 from public.document_deliveries where document_id in (pg_temp.d('a:big'), pg_temp.d('a:credit'), pg_temp.d('a:printed'))),
  '4 deliveries, 2 originals; nothing recorded for the documents awaiting');
select pg_temp.check((select count(*) from public.finance_audit_log where action = 'document.delivered' and business_id = '00000000-0000-0000-0000-0000000690b1') = 4,
  'every delivery by the link is in the business''s log');
-- a locked business: nothing opens, nothing recorded
update public.businesses set status = 'locked' where id = '00000000-0000-0000-0000-0000000690b2';
begin;
set local role service_role;
select pg_temp.as_server();
select pg_temp.check(public.document_share_open(pg_temp.tok('b:private')) = '{"ok": false, "code": "unavailable"}'::jsonb, 'a locked business — unavailable');
commit;
update public.businesses set status = 'active' where id = '00000000-0000-0000-0000-0000000690b2';
-- the number comes: the invoice printed before 6900 is delivered — a copy (it was printed, the original went then)
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000690e1');
select public.record_manual_allocation(pg_temp.d('a:printed'), '555555555');
commit;
begin;
set local role service_role;
select pg_temp.as_server();
select pg_temp.check(not (public.document_share_open(pg_temp.tok('a:printed')) ->> 'original')::boolean, 'printed before 6900 — its link is a copy');
commit;
-- one original per document, whoever writes
select pg_temp.refused_with($$insert into public.document_deliveries (business_id, document_id, channel, is_original)
  values ('00000000-0000-0000-0000-0000000690b1', pg_temp.d('a:private'), 'link', true)$$, 'one_original', 'a second original');
select pg_temp.refused_with($$update public.document_deliveries set channel = 'email'$$, 'append-only', 'a delivery is never changed');
select pg_temp.refused_with($$delete from public.document_deliveries$$, 'append-only', 'a delivery is never removed');
select pg_temp.refused_with($$truncate public.document_deliveries cascade$$, 'append-only', 'nor truncated');

-- ---- 1 + 3. from the app: print, mail, WhatsApp — the same rules ------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000690e1');
select pg_temp.refused_with($$select public.document_delivery_record(pg_temp.d('a:big'), 'print')$$, 'awaiting_allocation', 'no print before the number', '55000');
select pg_temp.refused_with($$select public.document_delivery_record(pg_temp.d('a:credit'), 'whatsapp')$$, 'awaiting_allocation', 'no WhatsApp before the number', '55000');
select pg_temp.refused_with($$update public.documents set print_count = print_count + 1 where id = pg_temp.d('a:big')$$, 'awaiting_allocation',
  'nor the old print counter', '55000');
select pg_temp.check(public.document_delivery_record(pg_temp.d('a:small'), 'print') @> '{"original": true, "mark": "מקור", "print_count": 1}'::jsonb, 'the first print — the original');
select pg_temp.check(public.document_delivery_record(pg_temp.d('a:small'), 'print') @> '{"original": false, "mark": "העתק נאמן למקור", "print_count": 2}'::jsonb, 'the second — a copy');
select pg_temp.check(public.document_delivery_record(pg_temp.d('a:small'), 'email') @> '{"original": false}'::jsonb, 'a mail after it — a copy');
select pg_temp.check((select print_count from public.documents where id = pg_temp.d('a:small')) = 2, 'the print counter moved with the prints only');
update public.documents set print_count = print_count + 1 where id = pg_temp.d('a:small');   -- the old way, a document that needs no number
select pg_temp.check((select print_count from public.documents where id = pg_temp.d('a:small')) = 3, 'the old print counter still works where no number is needed');
select pg_temp.refused_with($$select public.document_delivery_record(pg_temp.d('b:private'), 'print')$$, 'not allowed', 'another business''s document', '42501');
select pg_temp.refused_with($$select public.document_delivery_record(pg_temp.d('a:small'), 'link')$$, 'delivery_channel', 'the link is the server''s');
select pg_temp.check(public.document_delivery_state(pg_temp.d('a:big')) @> '{"allocation": {"required": true, "awaiting": true, "number": null,
  "rule": {"version": 4, "threshold": 5000, "inclusive": true, "docTypes": [305, 320, 330]}}, "delivered": false, "deliveries": 0}'::jsonb,
  'the state: needs a number, awaiting, by rule 4, not delivered');
select pg_temp.check(public.document_delivery_state(pg_temp.d('a:alloc')) @> '{"allocation": {"required": true, "awaiting": false, "number": "123456789", "manual": true}, "delivered": true, "original": {"channel": "link"}}'::jsonb,
  'the state: its number (by hand), delivered first by the link');
select pg_temp.check(public.document_delivery_state(pg_temp.d('a:private')) @> '{"allocation": {"required": false, "awaiting": false}}'::jsonb, 'a private customer — no number needed');
select pg_temp.refused_with($$select public.document_delivery_state(pg_temp.d('b:big'))$$, 'not allowed', 'nothing of another business', '42501');
-- what the owner reads: Alpha's deliveries only
select pg_temp.check((select count(*) from public.document_deliveries) = 8 and (select count(distinct business_id) from public.document_deliveries) = 1,
  'the owner sees the 8 deliveries of Alpha');
select pg_temp.refused_with($$insert into public.document_deliveries (business_id, document_id, channel, is_original)
  values ('00000000-0000-0000-0000-0000000690b1', pg_temp.d('a:small'), 'print', false)$$, 'permission denied', 'no browser writes a delivery');
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000690e3');
select pg_temp.refused_with($$select public.document_delivery_record(pg_temp.d('a:small'), 'print')$$, 'read-only', 'a viewer delivers nothing', '42501');
select pg_temp.check((select count(*) from public.document_deliveries) = 8, 'a viewer reads them');
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000690e2');
select pg_temp.check(public.document_delivery_record(pg_temp.d('a:cashier'), 'print') @> '{"original": true}'::jsonb, 'the cashier prints her own sale of today — the original');
select pg_temp.refused_with($$select public.document_delivery_record(pg_temp.d('a:small'), 'print')$$, 'not allowed', 'not another''s document', '42501');
select pg_temp.refused_with($$select public.document_delivery_state(pg_temp.d('a:big'))$$, 'not allowed', 'nor its state', '42501');
select pg_temp.check((select count(*) from public.document_deliveries) = 0, 'a cashier reads no delivery');
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000690f1');
select pg_temp.check((select count(*) from public.document_deliveries) = 0, 'Beta sees none of Alpha''s deliveries');
commit;
begin;
set local role anon;
select pg_temp.refused_with($$select count(*) from public.document_deliveries$$, 'permission denied', 'the public reads nothing');
select pg_temp.refused_with($$select count(*) from public.backup_runs$$, 'permission denied', 'nor the backups');
commit;

-- ---- 4. the delivered PDF ------------------------------------------------------------------------------------------------------
create temp table dv as select id, business_id, document_id from public.document_deliveries where document_id = pg_temp.d('a:alloc') and is_original;
grant select on dv to authenticated, service_role;
begin;
set local role service_role;
select pg_temp.as_server();
select pg_temp.refused_with($$select public.document_delivery_file_add((select id from dv), repeat('a', 64), 1000)$$, 'delivery_file_missing', 'upload first');
select pg_temp.refused_with($$insert into storage.objects (bucket_id, name) values ('delivered-documents', '00000000-0000-0000-0000-0000000690b1/x.pdf')$$,
  'stored_file_path', 'a delivered PDF only at the path of a recorded delivery — even the server');
insert into storage.objects (bucket_id, name, metadata) select 'delivered-documents', business_id || '/' || document_id || '/' || id || '.pdf', '{"size": 1000}' from dv;
select pg_temp.check(public.document_delivery_file_add((select id from dv), repeat('a', 64), 1000) @> '{"created": true}'::jsonb, 'the file and its sha256');
select pg_temp.check(public.document_delivery_file_add((select id from dv), repeat('a', 64), 1000) @> '{"created": false}'::jsonb, 'again — the same, nothing new');
select pg_temp.refused_with($$select public.document_delivery_file_add((select id from dv), repeat('b', 64), 1000)$$, 'delivery_file_exists', 'never another file for it');
select pg_temp.refused_with($$update storage.objects set metadata = '{"size": 2}' where bucket_id = 'delivered-documents'$$, 'stored_file_locked', 'never replaced — even by the server');
select pg_temp.refused_with($$update storage.objects set name = name || '.old' where bucket_id = 'delivered-documents'$$, 'stored_file_locked', 'never moved');
select pg_temp.refused_with($$delete from storage.objects where bucket_id = 'delivered-documents'$$, 'stored_file_locked', 'never removed');
commit;
select pg_temp.refused_with($$update public.document_delivery_files set sha256 = repeat('c', 64)$$, 'append-only', 'the record of the file never changes');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000690e1');
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'delivered-documents') = 1
  and (select count(*) from public.document_delivery_files) = 1, 'the owner reads Alpha''s delivered file');
select pg_temp.refused_with($$insert into storage.objects (bucket_id, name) select 'delivered-documents', business_id || '/' || document_id || '/' || id || '.pdf' from dv$$,
  'row-level security', 'no browser uploads one');
with u as (update storage.objects set metadata = '{}' where bucket_id = 'delivered-documents' returning 1) select pg_temp.check((select count(*) from u) = 0, 'nor replaces it');
with u as (delete from storage.objects where bucket_id = 'delivered-documents' returning 1) select pg_temp.check((select count(*) from u) = 0, 'nor removes it');
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000690e2');
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'delivered-documents') = 0, 'the cashier — none');
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000690f1');
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'delivered-documents') = 0
  and (select count(*) from public.document_delivery_files) = 0, 'Beta — none of Alpha''s');
commit;
begin;
set local role anon;
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'delivered-documents') = 0, 'the public — none');
commit;

-- ---- 5. backups --------------------------------------------------------------------------------------------------------------
select pg_temp.check(not has_function_privilege('authenticated', 'public.backup_export_after(uuid, text, jsonb, integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.backup_due(date)', 'execute')
  and not has_function_privilege('authenticated', 'public.backup_orphans()', 'execute')
  and not has_function_privilege('authenticated', 'public.delivery_originals_unsaved(integer)', 'execute')
  and has_function_privilege('service_role', 'public.delivery_originals_unsaved(integer)', 'execute')
  and not has_function_privilege('anon', 'public.backup_run_start(text, text, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.backup_expire(uuid)', 'execute')
  and has_function_privilege('service_role', 'public.backup_expire(uuid)', 'execute')
  and not has_table_privilege('authenticated', 'public.backup_runs', 'select'), 'backups: the server only');
select pg_temp.check(not ('payment_accounts' = any (public.backup_tables())) and not ('tax_authority_connections' = any (public.backup_tables()))
  and 'documents' = any (public.backup_tables()) and 'finance_audit_log' = any (public.backup_tables()), 'the backup: the books, never a key or a token');
begin;
set local role service_role;
select pg_temp.as_server();
-- the export: one business, its rows only, in keyset pages (after the last key), the total on the first page only
create temp table pg1 as select public.backup_export_after('00000000-0000-0000-0000-0000000690b1', 'documents', null, 3) as x;
create temp table pg2 as select public.backup_export_after('00000000-0000-0000-0000-0000000690b1', 'documents', (select x -> 'last' from pg1), 3) as x;
create temp table pg3 as select public.backup_export_after('00000000-0000-0000-0000-0000000690b1', 'documents', (select x -> 'last' from pg2), 3) as x;
select pg_temp.check((select (x ->> 'total')::int = 7 and (x ->> 'count')::int = 3 and (x ->> 'more')::boolean
                        and (select array_agg(k) from jsonb_object_keys(x -> 'last') k) = array['id'] from pg1), 'the first page: 3 of 7, the total, more, its last key');
select pg_temp.check((select x -> 'total' = 'null'::jsonb and (x ->> 'count')::int = 3 and (x ->> 'more')::boolean from pg2), 'the second page: no count again');
select pg_temp.check((select (x ->> 'count')::int = 1 and not (x ->> 'more')::boolean from pg3), 'the last page');
select pg_temp.check((select string_agg(r ->> 'id', ',' order by n, o) from (select 1 n, x from pg1 union all select 2, x from pg2 union all select 3, x from pg3) p,
                        jsonb_array_elements(p.x -> 'rows') with ordinality e(r, o))
  = (select string_agg(id::text, ',' order by id) from public.documents where business_id = '00000000-0000-0000-0000-0000000690b1'),
  'the three pages: every row of Alpha once, in the order of the key');
select pg_temp.check((select bool_and(r ->> 'business_id' = '00000000-0000-0000-0000-0000000690b1' and not (r ? 'share_token')
                             and r ->> 'share_token_sha256' = encode(sha256(convert_to((select share_token from public.documents d where d.id = (r ->> 'id')::uuid), 'UTF8')), 'hex'))
                        from pg1, jsonb_array_elements(pg1.x -> 'rows') r), 'no link token in a backup — only its sha256');
-- a key of two columns (finance_counters: business, kind)
insert into public.finance_counters (business_id, kind, last_no) values ('00000000-0000-0000-0000-0000000690b1', 'expense', 0), ('00000000-0000-0000-0000-0000000690b1', 'quote', 0)
  on conflict do nothing;
select pg_temp.check((select (public.backup_export_after('00000000-0000-0000-0000-0000000690b1', 'finance_counters', x -> 'last', 1) #>> '{rows,0,kind}') = 'quote'
                        from (select public.backup_export_after('00000000-0000-0000-0000-0000000690b1', 'finance_counters', null, 1) x) f), 'a key of two columns pages too');
select pg_temp.refused_with($$select public.backup_export_after('00000000-0000-0000-0000-0000000690b1', 'documents', '{"nope": 1}', 3)$$, 'backup_page', 'p_after needs the key');
select pg_temp.check((public.backup_export_after(null, 'tax_allocation_rules') ->> 'total')::int = 4
  and (public.backup_export_after('00000000-0000-0000-0000-0000000690b2', 'businesses') ->> 'total')::int = 1, 'the rules (all) and the business itself');
select pg_temp.refused_with($$select public.backup_export_after('00000000-0000-0000-0000-0000000690b1', 'payment_accounts')$$, 'backup_table', 'never the terminal keys');
select pg_temp.refused_with($$select public.backup_export_after(null, 'documents')$$, 'backup_business', 'a business''s table needs the business');
-- a run: the period must be over; the same period again is the same run; the file only at its path
select pg_temp.refused_with($$select public.backup_run_start('monthly', to_char(public.il_today(), 'YYYY-MM'))$$, 'backup_period_open', 'this month is not over');
select pg_temp.refused_with($$select public.backup_run_start('yearly', to_char(public.il_today(), 'YYYY'))$$, 'backup_period_open', 'nor this year');
select pg_temp.refused_with($$select public.backup_run_start('monthly', '2026-13')$$, 'backup_period', 'a month that is not');
create temp table run1 as select public.backup_run_start('monthly', '2026-10', '00000000-0000-0000-0000-0000000690b1') as r;
select pg_temp.check((select (r ->> 'created')::boolean and r ->> 'object_path' = '00000000-0000-0000-0000-0000000690b1/monthly/2026-10/' || (r ->> 'id') || '.json.gz' from run1),
  'a run of October for Alpha, its path');
select pg_temp.check((select public.backup_run_start('monthly', '2026-10', '00000000-0000-0000-0000-0000000690b1') @> jsonb_build_object('id', r ->> 'id', 'created', false) from run1),
  'October again — the same run');
select pg_temp.refused_with($$select public.backup_run_finish((select (r ->> 'id')::uuid from run1), repeat('d', 64), 100, '{"documents": 7}')$$, 'backup_file_missing', 'finished only with its file');
select pg_temp.refused_with($$insert into storage.objects (bucket_id, name) values ('backups', 'all/monthly/2026-10/x.json.gz')$$, 'stored_file_path', 'a backup only at the path of a running run');
insert into storage.objects (bucket_id, name, metadata) select 'backups', r ->> 'object_path', '{"size": 100}' from run1;
select pg_temp.check((select public.backup_run_finish((r ->> 'id')::uuid, repeat('d', 64), 100, '{"documents": 7}') ->> 'keep_until' from run1)
  = ((greatest(date '2026-11-01', public.il_today()) + interval '12 months')::date)::text, 'ok — kept 12 months');
select pg_temp.refused_with($$select public.backup_expire((select (r ->> 'id')::uuid from run1))$$, 'backup_retention', 'a copy younger than its retention stays', '55000');
select pg_temp.refused_with($$delete from storage.objects where bucket_id = 'backups'$$, 'stored_file_locked', 'its file is not removed before backup_expire');
select pg_temp.refused_with($$update storage.objects set metadata = '{"size": 1}' where bucket_id = 'backups'$$, 'stored_file_locked', 'nor replaced');
commit;
select pg_temp.refused_with($$update public.backup_runs set keep_until = '2020-01-01'$$, 'not allowed', 'a run''s retention never changes — even by the owner of the table');
select pg_temp.refused_with($$update public.backup_runs set status = 'running'$$, 'not allowed', 'a run never goes back');
select pg_temp.refused_with($$delete from public.backup_runs$$, 'append-only', 'a run is never removed');
select pg_temp.refused_with($$truncate public.backup_runs$$, 'append-only', 'nor truncated');
-- old copies (as if written years ago): a monthly copy goes only after its 12 months AND a later yearly copy
insert into public.backup_runs (id, kind, period, business_id, started_at, object_path) values
  ('00000000-0000-0000-0000-0000000690c1', 'monthly', '2019-03', null, '2019-04-01', 'all/monthly/2019-03/00000000-0000-0000-0000-0000000690c1.json.gz'),
  ('00000000-0000-0000-0000-0000000690c2', 'yearly', '2019', null, '2020-01-02', 'all/yearly/2019/00000000-0000-0000-0000-0000000690c2.json.gz');
insert into storage.objects (bucket_id, name) select 'backups', object_path from public.backup_runs where id in ('00000000-0000-0000-0000-0000000690c1', '00000000-0000-0000-0000-0000000690c2');
update public.backup_runs set status = 'ok', finished_at = '2019-04-01 03:00+00', sha256 = repeat('e', 64), bytes = 10, row_counts = '{}', keep_until = '2020-04-01'
 where id = '00000000-0000-0000-0000-0000000690c1';
begin;
set local role service_role;
select pg_temp.as_server();
select pg_temp.check(public.backup_expirable() = '[]'::jsonb, 'no yearly copy after it yet — nothing may go');
select pg_temp.refused_with($$select public.backup_expire('00000000-0000-0000-0000-0000000690c1')$$, 'backup_retention', 'a monthly copy without a later yearly one stays');
commit;
update public.backup_runs set status = 'ok', finished_at = '2020-01-02 03:00+00', sha256 = repeat('f', 64), bytes = 10, row_counts = '{}', keep_until = (public.il_today() + 1)
 where id = '00000000-0000-0000-0000-0000000690c2';
begin;
set local role service_role;
select pg_temp.as_server();
select pg_temp.check((select array_agg(e ->> 'id') from jsonb_array_elements(public.backup_expirable()) e) = array['00000000-0000-0000-0000-0000000690c1'],
  'now the monthly copy may go — the yearly one is still kept');
select pg_temp.refused_with($$select public.backup_expire('00000000-0000-0000-0000-0000000690c2')$$, 'backup_retention', 'a yearly copy within its 7 years stays');
select pg_temp.check(public.backup_expire('00000000-0000-0000-0000-0000000690c1') @> '{"changed": true}'::jsonb, 'the monthly copy expires');
select pg_temp.check(public.backup_expire('00000000-0000-0000-0000-0000000690c1') @> '{"changed": false}'::jsonb, 'again — nothing new');
with x as (delete from storage.objects where bucket_id = 'backups' and name like 'all/monthly/2019-03/%' returning 1) select pg_temp.check((select count(*) from x) = 1,
  'then (only then) its file is removed');
select pg_temp.refused_with($$delete from storage.objects where bucket_id = 'backups' and name like 'all/yearly/2019/%'$$, 'stored_file_locked', 'the yearly file stays');
-- a failed run: its file may go; the period may run again
create temp table run2 as select public.backup_run_start('yearly', '2025', null) as r;
select pg_temp.check((select public.backup_run_fail((r ->> 'id')::uuid, 'the upload failed') @> '{"changed": true}'::jsonb from run2), 'a failed run');
select pg_temp.check((select (public.backup_run_start('yearly', '2025', null) ->> 'id') <> (r ->> 'id') from run2), 'the period runs again, a new run');
commit;
create temp table run3 as select object_path from public.backup_runs where status = 'running';
grant select on run3 to authenticated;
select pg_temp.check((select count(*) from run3) = 1, 'the run of 2025 again is running');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000690e1');
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'backups') = 0, 'no signed-in user sees a backup file');
select pg_temp.refused_with($$insert into storage.objects (bucket_id, name) select 'backups', object_path from run3$$, 'row-level security',
  'nor uploads one — even at the path of a running run');
commit;

-- ---- the functions: who runs what ------------------------------------------------------------------------------------------
select pg_temp.check(not has_function_privilege('authenticated', 'public.document_visible(public.documents)', 'execute')
  and not has_function_privilege('service_role', 'public.document_delivery_add(public.documents, text, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.document_delivery_file_add(uuid, text, bigint)', 'execute')
  and not has_function_privilege('anon', 'public.document_delivery_record(uuid, text)', 'execute')
  and not has_function_privilege('anon', 'public.document_delivery_state(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.storage_objects_keep()', 'execute')
  and not has_function_privilege('anon', 'public.allocation_required(public.documents)', 'execute'), 'internal functions stay internal');
select pg_temp.check((select prosecdef from pg_proc where oid = 'public.allocation_required(public.documents)'::regprocedure) is false
  and (select prosecdef from pg_proc where oid = 'public.finance_summary(date, date)'::regprocedure) is false, 'the rule and the summary run as the caller (their RLS)');

-- ---- review of 2.119: locations, public buckets, the unsaved originals, orphan files, what is due, viewer policies ---------------
-- a member of one location reads the delivered PDFs of that location only
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000690e4', 'branch@alpha-69.example.test');
insert into public.business_locations (id, business_id, name) values ('00000000-0000-0000-0000-0000000690a2', '00000000-0000-0000-0000-0000000690b1', 'סניף שני');
insert into public.business_members (business_id, user_id, role, access, locations) values
  ('00000000-0000-0000-0000-0000000690b1', '00000000-0000-0000-0000-0000000690e4', 'editor', 'full', array['00000000-0000-0000-0000-0000000690b1']::uuid[]);
update public.profiles set current_business_id = '00000000-0000-0000-0000-0000000690b1' where id = '00000000-0000-0000-0000-0000000690e4';
select pg_temp.check(exists (select 1 from public.business_locations where id = '00000000-0000-0000-0000-0000000690b1'), 'Alpha''s main location has the business''s id');
select pg_temp.issue(pg_temp.doc('00000000-0000-0000-0000-0000000690e1', 320, 200, '{"idempotency_key":"a:branch2","location_id":"00000000-0000-0000-0000-0000000690a2"}'));
select pg_temp.check((select location_id from public.documents where id = pg_temp.d('a:branch2')) = '00000000-0000-0000-0000-0000000690a2', 'a document of the second location');
begin;
set local role service_role;
select pg_temp.as_server();
create temp table dv2 as select (public.document_share_open(pg_temp.tok('a:branch2')) ->> 'delivery_id')::uuid as id;
insert into storage.objects (bucket_id, name) select 'delivered-documents', '00000000-0000-0000-0000-0000000690b1/' || pg_temp.d('a:branch2') || '/' || id || '.pdf' from dv2;
select public.document_delivery_file_add((select id from dv2), repeat('9', 64), 500);
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000690e1');
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'delivered-documents') = 2, 'the owner reads both locations'' PDFs');
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000690e4');
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'delivered-documents') = 1
  and exists (select 1 from storage.objects o, dv where o.bucket_id = 'delivered-documents' and o.name = dv.business_id || '/' || dv.document_id || '/' || dv.id || '.pdf'),
  'a member of the main location: its PDF only');
select pg_temp.check(not exists (select 1 from storage.objects o where o.bucket_id = 'delivered-documents' and o.name like '%' || pg_temp.d('a:branch2') || '%')
  and (select count(*) from public.document_delivery_files) = 1, 'never the other location''s — not the file, not its record');
commit;

-- the originals whose PDF is not kept: older than 5 minutes, oldest first
begin;
set local role service_role;
select pg_temp.as_server();
select pg_temp.check(public.delivery_originals_unsaved() = '[]'::jsonb, 'every original is new (less than 5 minutes) — none yet');
commit;
alter table public.document_deliveries disable trigger document_deliveries_append_only;
update public.document_deliveries set created_at = created_at - interval '10 minutes';
alter table public.document_deliveries enable trigger document_deliveries_append_only;
begin;
set local role service_role;
select pg_temp.as_server();
select pg_temp.check((select count(*) from jsonb_array_elements(public.delivery_originals_unsaved()) e) = (select count(*) from public.document_deliveries v
                        where v.is_original and not exists (select 1 from public.document_delivery_files f where f.delivery_id = v.id))
  and (select count(*) from jsonb_array_elements(public.delivery_originals_unsaved()) e) >= 3, 'the originals without a kept PDF');
select pg_temp.check(not exists (select 1 from jsonb_array_elements(public.delivery_originals_unsaved()) e
                       where (e ->> 'delivery_id')::uuid in (select delivery_id from public.document_delivery_files))
  and not exists (select 1 from jsonb_array_elements(public.delivery_originals_unsaved()) e
                    where (e ->> 'delivery_id')::uuid in (select id from public.document_deliveries where not is_original)), 'never a kept one, never a copy');
select pg_temp.check((select bool_and(e ->> 'file_path' = (e ->> 'business_id') || '/' || (e ->> 'document_id') || '/' || (e ->> 'delivery_id') || '.pdf')
                        from jsonb_array_elements(public.delivery_originals_unsaved()) e), 'with the path to store it at');
select pg_temp.check(jsonb_array_length(public.delivery_originals_unsaved(1)) = 1
  and (public.delivery_originals_unsaved(1) -> 0 ->> 'at')::timestamptz = (select min(v.created_at) from public.document_deliveries v
        where v.is_original and not exists (select 1 from public.document_delivery_files f where f.delivery_id = v.id)), 'the oldest first, as many as asked');
-- orphan files: the yearly run of 2025 that failed (its file never uploaded) — none; a failed run with its file — listed until removed
select pg_temp.check(public.backup_orphans() = '[]'::jsonb, 'no orphan file yet');
create temp table run4 as select public.backup_run_start('yearly', '2024', '00000000-0000-0000-0000-0000000690b2') as r;
insert into storage.objects (bucket_id, name) select 'backups', r ->> 'object_path' from run4;
select public.backup_run_fail((r ->> 'id')::uuid, 'the finish never came') from run4;
select pg_temp.check((select jsonb_path_query_array(public.backup_orphans(), '$[*].id') = jsonb_build_array(r ->> 'id') from run4), 'a failed run with its file — an orphan');
delete from storage.objects where bucket_id = 'backups' and name = (select r ->> 'object_path' from run4);
select pg_temp.check(public.backup_orphans() = '[]'::jsonb, 'removed — no orphan');
commit;
-- what is due: every month that is over since the business was created or 11.2026 (the later), every year that is over
update public.businesses set created_at = '2026-09-15 10:00+03' where id = '00000000-0000-0000-0000-0000000690b2';
begin;
set local role service_role;
select pg_temp.as_server();
select pg_temp.check((select jsonb_agg(e - 'running' order by o) from jsonb_array_elements(public.backup_due('2027-02-10')) with ordinality x(e, o)
                       where e ->> 'business_id' = '00000000-0000-0000-0000-0000000690b2')
  = '[{"kind": "monthly", "period": "2026-11", "business_id": "00000000-0000-0000-0000-0000000690b2"},
      {"kind": "monthly", "period": "2026-12", "business_id": "00000000-0000-0000-0000-0000000690b2"},
      {"kind": "yearly", "period": "2026", "business_id": "00000000-0000-0000-0000-0000000690b2"},
      {"kind": "monthly", "period": "2027-01", "business_id": "00000000-0000-0000-0000-0000000690b2"}]'::jsonb,
  'Beta on 10.2.2027: November, December, the year 2026, January — oldest first');
select pg_temp.check(not exists (select 1 from jsonb_array_elements(public.backup_due('2026-11-30')) e where e ->> 'business_id' = '00000000-0000-0000-0000-0000000690b2'),
  'on 30.11.2026 nothing is over yet');
commit;
-- (November is not over today: its run is written as it would be on 1.12.2026)
insert into public.backup_runs (id, kind, period, business_id, object_path) values ('00000000-0000-0000-0000-0000000690c5', 'monthly', '2026-11',
  '00000000-0000-0000-0000-0000000690b2', '00000000-0000-0000-0000-0000000690b2/monthly/2026-11/00000000-0000-0000-0000-0000000690c5.json.gz');
update public.backup_runs set status = 'ok', finished_at = now(), sha256 = repeat('1', 64), bytes = 10, row_counts = '{}', keep_until = '2027-12-01'
 where id = '00000000-0000-0000-0000-0000000690c5';
begin;
set local role service_role;
select pg_temp.as_server();
select pg_temp.check(not exists (select 1 from jsonb_array_elements(public.backup_due('2027-02-10')) e
                       where e ->> 'business_id' = '00000000-0000-0000-0000-0000000690b2' and e ->> 'period' = '2026-11'), 'a month that is ok — no longer due');
commit;
-- the viewer policies of 3200 on the two new tables
select pg_temp.check((select count(*) from pg_policies where schemaname = 'public' and tablename in ('document_deliveries', 'document_delivery_files')
                       and policyname ~ '_viewer_(insert|update|delete)$' and permissive = 'RESTRICTIVE') = 6, 'the viewer policies, restrictive, on both tables');
-- a public bucket of the same name: the migration stops, changes nothing
update storage.buckets set public = true where id = 'backups';
-- (the migration's own guard — its first block, as written in the file)
\set guard `awk '/^do [$][$]$/ {f=1} f {print} f && /^end [$][$];$/ {exit}' supabase/migrations/20261126006900_cpa_rules_stage2.sql`
select pg_temp.check(length(:'guard') > 500 and position('PUBLIC' in :'guard') > 0, 'the guard block was read from the migration');
select pg_temp.refused_with(:'guard', 'the bucket backups already exists and is PUBLIC', 'a public bucket of that name — the migration stops');
update storage.buckets set public = false where id = 'backups';
select pg_temp.check((select file_size_limit from storage.buckets where id = 'backups') = 524288000, 'backups: up to 500 MB a file');
