-- The demo data for the Tax Authority software registration (tests/sql/ita-demo.seed.sql) on a real Postgres (tests/sql/run.sh):
-- loaded twice in a row — the second time adds nothing —, numbered without gaps per type, every document type of a licensed
-- dealer, cancellations and credits through the existing mechanisms, more than 2,000 records for BKMVDATA — and no other
-- business changes (the businesses of the earlier check files, and one more made here, with rows before the seed).
-- Every check raises "CHECK FAILED: …" when the database does not behave.
\set ON_ERROR_STOP 1
set client_min_messages = warning;

do $$
begin
  -- never on a real Supabase project (the live database): it has auth.identities and is called "postgres"; the local shim has neither
  if to_regclass('auth.identities') is not null or current_database() = 'postgres' then
    raise exception 'ita-demo: this is local test data only — refusing to run on % (a Supabase / live database?)', current_database();
  end if;
end $$;

create or replace function pg_temp.check(ok boolean, msg text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'CHECK FAILED: %', msg; end if; end $$;
-- a 9-digit number with its check digit (validIsraeliId, src/features/register/billing.ts)
create or replace function pg_temp.valid_id(v text) returns boolean language sql immutable as $$
  select v ~ '^[0-9]{9}$' and v <> '000000000' and (select sum(case when x > 9 then x - 9 else x end) % 10 = 0
    from (select substr(v, i, 1)::int * ((i - 1) % 2 + 1) as x from generate_series(1, 9) i) s) $$;

-- ---- another business with rows before the seed (made here, so the check stands on its own too) ----------------------
insert into auth.users (id, email) values ('d3e00000-0000-4000-8000-0000000000b1', 'other-owner@example.test') on conflict (id) do nothing;
insert into public.businesses (id, name, slug) values ('d3e00000-0000-4000-8000-000000000002', 'עסק אחר', 'ita-demo-other') on conflict (id) do nothing;
insert into public.business_members (business_id, user_id, role, access)
  values ('d3e00000-0000-4000-8000-000000000002', 'd3e00000-0000-4000-8000-0000000000b1', 'owner', 'full') on conflict do nothing;
update public.profiles set current_business_id = 'd3e00000-0000-4000-8000-000000000002' where id = 'd3e00000-0000-4000-8000-0000000000b1';
insert into public.register_settings (user_id, business_id, business_type, vat_rate, dealer_number, legal_name, street, city, entity_type)
  values ('d3e00000-0000-4000-8000-0000000000b1', 'd3e00000-0000-4000-8000-000000000002', 'licensed', 18, '000000992', 'עסק אחר בע"מ',
          'הרצל', 'חולון', 'company') on conflict (business_id) do nothing;
begin;
set local role authenticated;
set local "request.jwt.claim.sub" = 'd3e00000-0000-4000-8000-0000000000b1';
set local "request.jwt.claim.role" = 'authenticated';
do $$
declare inv uuid; tx uuid;
begin
  if exists (select 1 from public.documents where business_id = 'd3e00000-0000-4000-8000-000000000002') then return; end if;
  insert into public.documents (user_id, doc_type, doc_number, doc_date, customer_name, customer_dealer, lines, payments,
                                before_discount, discount, after_discount, vat_amount, total, vat_rate, idempotency_key)
  values ('d3e00000-0000-4000-8000-0000000000b1', 305, 0, public.il_today(), 'לקוח של עסק אחר', '000000026',
          '[{"name":"שירות","qty":1,"unitPriceExVat":1000,"discountExVat":0,"totalExVat":1000,"vatRate":18,"kind":1}]', '[]',
          1000, 0, 1000, 180, 1180, 18, 'direct:other-1') returning id into inv;
  insert into public.documents (user_id, doc_type, doc_number, doc_date, customer_name, paid_document_id, lines, payments,
                                before_discount, discount, after_discount, vat_amount, total, vat_rate, idempotency_key)
  values ('d3e00000-0000-4000-8000-0000000000b1', 400, 0, public.il_today(), 'לקוח של עסק אחר', inv,
          '[{"name":"תשלום","qty":1,"unitPriceExVat":500,"discountExVat":0,"totalExVat":500,"vatRate":0,"kind":1}]',
          jsonb_build_array(jsonb_build_object('method', 4, 'amount', 500, 'date', public.il_today(), 'm', 'transfer')),
          500, 0, 500, 0, 500, 0, 'receipt:' || inv || ':1');
  insert into public.documents (user_id, doc_type, doc_number, doc_date, customer_name, lines, payments,
                                before_discount, discount, after_discount, vat_amount, total, vat_rate, idempotency_key)
  values ('d3e00000-0000-4000-8000-0000000000b1', 300, 0, public.il_today(), 'לקוח אחר',
          '[{"name":"שירות","qty":1,"unitPriceExVat":100,"discountExVat":0,"totalExVat":100,"vatRate":18,"kind":1}]', '[]',
          100, 0, 100, 18, 118, 18, 'direct:other-2') returning id into tx;
  insert into public.document_cancellations (document_id, business_id, user_id, reason)
    values (tx, 'd3e00000-0000-4000-8000-000000000002', 'd3e00000-0000-4000-8000-0000000000b1', 'בטעות');
end $$;
commit;

-- ---- every other business, before the seed ---------------------------------------------------------------------------
create temp table ita_snap (what text, run int, sig text);
create or replace function pg_temp.others(p_run int) returns void language plpgsql as $$
declare t text;
begin
  foreach t in array array['documents', 'document_counters', 'payments', 'document_cancellations', 'finance_audit_log', 'register_settings',
                           'business_finance_profile', 'business_members', 'business_locations', 'stock_movements', 'leads'] loop
    execute format('insert into ita_snap select %L, %s, md5(coalesce(string_agg(x.r, ''|'' order by x.r), '''')) || '':'' || count(*)
                      from (select t::text as r from public.%I t where t.business_id not in (''d3e00000-0000-4000-8000-000000000001'', ''d3e00000-0000-4000-8000-000000000003'')) x', t, p_run, t);
  end loop;
  insert into ita_snap select 'businesses', p_run, md5(coalesce(string_agg(b::text, '|' order by b.id), '')) || ':' || count(*)
    from public.businesses b where b.id not in ('d3e00000-0000-4000-8000-000000000001', 'd3e00000-0000-4000-8000-000000000003');
  insert into ita_snap select 'profiles', p_run, md5(coalesce(string_agg(p::text, '|' order by p.id), '')) || ':' || count(*)
    from public.profiles p where p.id not in ('d3e00000-0000-4000-8000-0000000000a1', 'd3e00000-0000-4000-8000-0000000000a3');
end $$;
select pg_temp.others(0);
select pg_temp.check((select count(*) from public.documents where business_id <> 'd3e00000-0000-4000-8000-000000000001') >= 3,
  'other businesses have documents before the seed');

-- ---- the seed, the first time ----------------------------------------------------------------------------------------
\ir ita-demo.seed.sql

create or replace function pg_temp.demo(p_run int) returns void language sql as $$
  insert into ita_snap
  select 'demo:documents', p_run, count(*)::text || ':' || coalesce(sum(doc_number), 0) || ':' || coalesce(sum(total), 0)
    from public.documents where business_id = 'd3e00000-0000-4000-8000-000000000001'
  union all select 'demo:payments', p_run, count(*)::text || ':' || coalesce(sum(amount), 0) from public.payments where business_id = 'd3e00000-0000-4000-8000-000000000001'
  union all select 'demo:cancellations', p_run, count(*)::text from public.document_cancellations where business_id = 'd3e00000-0000-4000-8000-000000000001'
  union all select 'demo:counters', p_run, coalesce(string_agg(doc_type || '=' || last_no, ',' order by doc_type), '')
    from public.document_counters where business_id = 'd3e00000-0000-4000-8000-000000000001'
  union all select 'demo:audit', p_run, count(*)::text from public.finance_audit_log where business_id = 'd3e00000-0000-4000-8000-000000000001'
  union all select 'demo:settings', p_run, md5(r::text) from public.register_settings r where business_id = 'd3e00000-0000-4000-8000-000000000001'
  -- 2.118: the exempt dealer's demo
  union all select 'exempt:documents', p_run, count(*)::text || ':' || coalesce(sum(doc_number), 0) || ':' || coalesce(sum(total), 0)
    from public.documents where business_id = 'd3e00000-0000-4000-8000-000000000003'
  union all select 'exempt:payments', p_run, count(*)::text || ':' || coalesce(sum(amount), 0) from public.payments where business_id = 'd3e00000-0000-4000-8000-000000000003'
  union all select 'exempt:audit', p_run, count(*)::text from public.finance_audit_log where business_id = 'd3e00000-0000-4000-8000-000000000003'
  union all select 'exempt:settings', p_run, md5(r::text) from public.register_settings r where business_id = 'd3e00000-0000-4000-8000-000000000003';
$$;
select pg_temp.demo(1);
select pg_temp.others(1);

-- ---- what it made ----------------------------------------------------------------------------------------------------
create temp view ita_docs as select * from public.documents where business_id = 'd3e00000-0000-4000-8000-000000000001';
select pg_temp.check((select register_settings.entity_type = 'licensed_dealer' and dealer_number = '000000109' and pg_temp.valid_id(dealer_number)
                        and legal_name <> '' and street <> '' and city <> '' and zip <> ''
                        from public.register_settings where business_id = 'd3e00000-0000-4000-8000-000000000001'),
  'the demo is a licensed dealer with a valid dealer number and full issuer details');
select pg_temp.check((select array_agg(distinct doc_type order by doc_type) from ita_docs) = array[300, 305, 320, 330, 400],
  'every document type of a licensed dealer: 300, 305, 320, 330, 400');
-- numbered 1..n per type, no gap, no double, and the counter at n
select pg_temp.check(not exists (
  select 1 from (select doc_type, count(*) n, max(doc_number) mx, min(doc_number) mn, count(distinct doc_number) dn from ita_docs group by doc_type) t
   left join public.document_counters c on c.business_id = 'd3e00000-0000-4000-8000-000000000001' and c.doc_type = t.doc_type
   where t.mn <> 1 or t.mx <> t.n or t.dn <> t.n or c.last_no is distinct from t.n), 'numbered 1..n per type, without gaps, and the counter is at n');
select pg_temp.check(not exists (select 1 from ita_docs d where d.doc_number <> (select count(*) from ita_docs x where x.doc_type = d.doc_type and x.link_no <= d.link_no)),
  'the numbers of each type follow the order of issue');
select pg_temp.check((select bool_and(doc_date between date '2026-06-01' and date '2026-10-31' and extract(isodow from doc_date) <> 6 and doc_date < public.il_today())
                        from ita_docs), 'dated June–October 2026, in the past, no Saturday');
select pg_temp.check((select count(distinct date_trunc('month', doc_date)) from ita_docs) = 5, 'five months of documents');
select pg_temp.check(public.finance_locked_until('d3e00000-0000-4000-8000-000000000001') is null, 'no closed period in the demo');
select pg_temp.check((select bool_and(issuer->>'dealerNumber' = '000000109' and issuer->>'name' = 'עסק דמו - רישום תוכנה' and issuer->>'entityType' = 'licensed_dealer')
                        from ita_docs), 'every document carries the issuer snapshot of the demo');
select pg_temp.check((select bool_and(user_id = 'd3e00000-0000-4000-8000-0000000000a1' and print_count = 0 and idempotency_key is not null) from ita_docs),
  'every document issued by the demo owner, with its key, never printed');
-- the receipts and credits stand on the right documents
select pg_temp.check(not exists (select 1 from ita_docs r join public.documents inv on inv.id = r.paid_document_id
                                  where not ((r.doc_type = 400 and inv.doc_type = 305) or (r.doc_type = 320 and inv.doc_type = 300))),
  'a 400 pays a 305, a 320 pays a 300');
select pg_temp.check((select count(*) from ita_docs where doc_type = 400 and paid_document_id is not null) > 50
                     and (select count(*) from ita_docs where doc_type = 320 and paid_document_id is not null) > 5, 'receipts on 305 and 320 on 300');
select pg_temp.check(not exists (select 1 from ita_docs c where c.doc_type = 330 and not exists (
                                   select 1 from ita_docs b where b.doc_type = c.base_doc_type and b.doc_number = c.base_doc_number and b.doc_type in (305, 320))),
  'every 330 points to a 305 / 320 of the demo');
select pg_temp.check((select count(distinct base_doc_type) from ita_docs where doc_type = 330) = 2, 'credits of 305 and of 320');
select pg_temp.check(not exists (select 1 from ita_docs b where b.doc_type in (305, 320) and b.total < (select coalesce(sum(c.total), 0) from ita_docs c
                                   where c.doc_type = 330 and c.base_doc_type = b.doc_type and c.base_doc_number = b.doc_number)), 'never credited beyond the invoice');
select pg_temp.check(not exists (select 1 from ita_docs inv where inv.doc_type in (300, 305) and inv.total
        < coalesce((select sum(case p.direction when 'in' then p.amount else -p.amount end) from public.payments p where p.applies_to = inv.id), 0)
        + (select coalesce(sum(c.total), 0) from ita_docs c where c.doc_type = 330 and c.base_doc_type = inv.doc_type and c.base_doc_number = inv.doc_number)),
  'never paid beyond the invoice');
-- cancellations: only 300 / 400, some of each; a cancelled receipt's money is reversed in the ledger
select pg_temp.check((select array_agg(distinct d.doc_type order by d.doc_type) from public.document_cancellations c join ita_docs d on d.id = c.document_id) = array[300, 400],
  'cancellations of 300 and of 400 only');
select pg_temp.check(not exists (select 1 from public.document_cancellations c join ita_docs d on d.id = c.document_id
                                  where d.doc_type = 300 and exists (select 1 from ita_docs p where p.paid_document_id = d.id)), 'a cancelled 300 was never paid');
select pg_temp.check((select coalesce(sum(amount), 0) from public.payments where business_id = 'd3e00000-0000-4000-8000-000000000001' and direction = 'out')
                   = (select coalesce(sum((p->>'amount')::numeric), 0) from public.document_cancellations c join ita_docs d on d.id = c.document_id,
                        jsonb_array_elements(d.payments) p), 'the money of every cancelled receipt went back off the books, nothing else');
select pg_temp.check((select count(*) from public.payments where business_id = 'd3e00000-0000-4000-8000-000000000001' and direction = 'in')
                   = (select sum(jsonb_array_length(payments)) from ita_docs), 'one ledger row per payment of a receipt');
-- payments: cash, cheque (with its details), card, transfer, other (Bit, other, tax withheld at source)
select pg_temp.check((select array_agg(distinct (p->>'method')::int order by (p->>'method')::int) from ita_docs, jsonb_array_elements(payments) p) = array[1, 2, 3, 4, 9],
  'payments by cash, cheque, card, transfer and other');
select pg_temp.check((select bool_and(p->'cheque'->>'number' ~ '^[0-9]+$' and p->'cheque'->>'bank' <> '' and p->'cheque'->>'dueDate' <> '')
                        from ita_docs, jsonb_array_elements(payments) p where p->>'method' = '2'), 'every cheque with its bank, number and due date');
-- 2.118 (the accountant, answer 12): Bit is method 4 (with m 'bit'); "other" (9) — other and tax withheld at source
select pg_temp.check((select array_agg(distinct p->>'m' order by p->>'m') from ita_docs, jsonb_array_elements(payments) p where p->>'method' = '9') = array['other', 'withholding'],
  'other (9): other, withheld at source');
select pg_temp.check(exists (select 1 from ita_docs, jsonb_array_elements(payments) p where p->>'m' = 'bit')
                     and not exists (select 1 from ita_docs, jsonb_array_elements(payments) p where p->>'m' = 'bit' and p->>'method' <> '4'), 'Bit: method 4');
select pg_temp.check((select count(*) from ita_docs where jsonb_array_length(payments) > 1) > 20, 'receipts paid in more than one way');
-- customers: several, some businesses with a valid ע.מ / ח.פ, some walk-in
select pg_temp.check((select count(distinct customer_dealer) from ita_docs where customer_dealer <> '') >= 5
                     and (select bool_and(pg_temp.valid_id(customer_dealer)) from ita_docs where customer_dealer <> ''), 'business customers with valid numbers');
select pg_temp.check((select count(distinct customer_name) from ita_docs) >= 15 and exists (select 1 from ita_docs where customer_name = ''), 'many customers, and walk-ins');
select pg_temp.check((select count(*) from ita_docs where jsonb_array_length(lines) >= 3) > 100 and exists (select 1 from ita_docs where discount > 0),
  'documents with several lines, some with a discount');
-- the unified file: C100 per document, D110 per line, D120 per payment — at least 2,000, well under 4MB (444 / 339 / 222 + CRLF)
select pg_temp.check((select count(*) + sum(jsonb_array_length(lines)) + sum(jsonb_array_length(payments)) from ita_docs) between 2000 and 6000,
  'between 2,000 and 6,000 records of C100 + D110 + D120');
select pg_temp.check((select count(*) * 446 + sum(jsonb_array_length(lines)) * 341 + sum(jsonb_array_length(payments)) * 224 from ita_docs) < 4000000,
  'BKMVDATA under 4MB');
select pg_temp.check((select count(*) from public.business_locations where business_id = 'd3e00000-0000-4000-8000-000000000001') = 1,
  'the demo has its one main location (no location line on its documents)');

-- ---- the exempt dealer's demo (2.118) --------------------------------------------------------------------------------------
create temp view ita_x as select * from public.documents where business_id = 'd3e00000-0000-4000-8000-000000000003';
select pg_temp.check((select entity_type = 'exempt_dealer' and business_type = 'exempt' and dealer_number = '000000117' and pg_temp.valid_id(dealer_number)
                        from public.register_settings where business_id = 'd3e00000-0000-4000-8000-000000000003'), 'an exempt dealer with a valid fictional number');
select pg_temp.check((select array_agg(distinct doc_type) from ita_x) = array[400], 'an exempt dealer: receipts only, no tax invoice');
select pg_temp.check((select count(*) from ita_x where total > 0) between 20 and 40, 'between 20 and 40 receipts');
select pg_temp.check((select bool_and(vat_amount = 0) from ita_x), 'no VAT');
select pg_temp.check(not exists (select 1 from (select doc_number, row_number() over (order by doc_number) n from ita_x) t where doc_number <> n),
  'numbered 1..n without a gap');
select pg_temp.check(not exists (select 1 from ita_x a join ita_x b on b.doc_number > a.doc_number and b.doc_date < a.doc_date), 'numbers in the order of the dates');
select pg_temp.check((select array_agg(distinct p->>'m' order by p->>'m') from ita_x, jsonb_array_elements(payments) p) = array['bit', 'card', 'cash', 'transfer']
                     and not exists (select 1 from ita_x, jsonb_array_elements(payments) p where p->>'m' = 'bit' and p->>'method' <> '4'),
  'cash, transfer, Bit (4) and card');
select pg_temp.check((select bool_and(p->>'cardKind' in ('1', '2')) from ita_x, jsonb_array_elements(payments) p where p->>'method' = '3')
                     and exists (select 1 from ita_x, jsonb_array_elements(payments) p where p->>'cardKind' = '2'), 'every card payment with its kind (regular, installments)');
-- the refund receipts: two, each on a receipt; one partial back to the card, one full in cash
select pg_temp.check((select count(*) from ita_x where total < 0) = 2
                     and (select bool_and(r.base_doc_type = 400 and r.source = 'refund' and -r.total <= o.total)
                            from ita_x r join ita_x o on o.doc_type = 400 and o.doc_number = r.base_doc_number where r.total < 0), 'two refund receipts, each on its receipt');
select pg_temp.check(exists (select 1 from ita_x r join ita_x o on o.doc_number = r.base_doc_number, jsonb_array_elements(r.payments) p
                              where r.total < 0 and -r.total < o.total and p->>'method' = '3' and p->>'cardKind' = '1'), 'a partial refund, back to the card');
select pg_temp.check(exists (select 1 from ita_x r join ita_x o on o.doc_number = r.base_doc_number, jsonb_array_elements(r.payments) p
                              where r.total < 0 and -r.total = o.total and p->>'method' = '1'), 'a full refund, in cash');
select pg_temp.check((select coalesce(sum(amount), 0) from public.payments where business_id = 'd3e00000-0000-4000-8000-000000000003' and direction = 'out')
                   = (select -sum(total) from ita_x where total < 0), 'the refunds'' money out, once');
select pg_temp.check(not exists (select 1 from public.document_cancellations c join ita_x x on x.id = c.document_id), 'nothing cancelled');

-- ---- the seed again: nothing added -----------------------------------------------------------------------------------
\ir ita-demo.seed.sql
select pg_temp.demo(2);
select pg_temp.others(2);
select pg_temp.check(not exists (select 1 from ita_snap a join ita_snap b on b.what = a.what and b.run = 2 where a.run = 1 and a.sig is distinct from b.sig)
                     and (select count(*) from ita_snap where run = 2) = (select count(*) from ita_snap where run = 1),
  'the second run adds and changes nothing');
-- ---- no other business changed ---------------------------------------------------------------------------------------
select pg_temp.check(not exists (select 1 from ita_snap a join ita_snap b on b.what = a.what and b.run in (1, 2)
                                  where a.run = 0 and a.sig is distinct from b.sig), 'every other business is as it was (' ||
  coalesce((select string_agg(distinct a.what, ', ') from ita_snap a join ita_snap b on b.what = a.what and b.run in (1, 2) where a.run = 0 and a.sig is distinct from b.sig), '') || ')');
-- the other business does not see the demo, the demo does not see it (as the signed-in owners)
begin;
set local role authenticated;
set local "request.jwt.claim.sub" = 'd3e00000-0000-4000-8000-0000000000b1';
set local "request.jwt.claim.role" = 'authenticated';
select pg_temp.check((select count(*) from public.documents where business_id = 'd3e00000-0000-4000-8000-000000000001') = 0, 'another owner sees none of the demo');
set local "request.jwt.claim.sub" = 'd3e00000-0000-4000-8000-0000000000a1';
select pg_temp.check((select count(*) from public.documents where business_id <> 'd3e00000-0000-4000-8000-000000000001') = 0
                     and (select count(*) from public.documents) > 700, 'the demo owner sees only the demo');
commit;
