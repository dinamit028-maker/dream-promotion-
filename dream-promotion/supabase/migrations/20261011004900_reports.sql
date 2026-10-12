-- 2.94.0 — the missing reports (docs/FINANCE_ADDITIONS_HE.md T8). Runs after 20261011004700_stock_locations (it stops at the top
-- without it, changing nothing). No row that is there is removed or changed.
--   1. withholding     tax a customer withheld at source ("ניכוי במקור") is one more way a receipt is paid: the receipt lists it
--                      (its amount — and the percent on the certificate) and the ledger keeps it as payments.method =
--                      'withholding'. It pays the invoice (receivables count it) but it is not money: finance_summary leaves it
--                      out of the cash in and out and gives it on its own ("withheld"). A cancelled receipt reverses it, as any.
--   2. reports         report_income_by_customer, report_sales_by_item (by item, service and treatment type), report_customer_ledger,
--                      report_suppliers (by supplier and by kind, paid and not yet paid), report_supplier_ledger, report_withholding —
--                      every one from the same rows and by the same rules as finance_summary (revenue: tax invoices less credit
--                      invoices, or an exempt dealer's receipts; expenses: the confirmed ones), so their totals are its totals. They
--                      run as the caller (security invoker): the business's policies decide what is read — the location picked at
--                      the top too (T12ד), and a cashier gets nothing.
--   3. a service's treatment type   catalog_items.treatment_type_id (a package keeps package_type_id): sales by treatment type.
--   4. advances        business_finance_profile.advance_pct — the percent of the income tax advances the business sets; the screen
--                      shows an estimate only, never a sum to pay.
-- Not here: PCN874 (the detailed VAT file) — the official current specification could not be checked (STATUS.md, section 4נח).
-- Tests: tests/sql/reports.check.sql. Rollback: see the end.

do $$
begin
  if to_regclass('public.stock_levels') is null or to_regclass('public.receivable_lines') is null or to_regclass('public.treatment_types') is null then
    raise exception 'run 20261009004100_client_file, 20261010004400_plans_reminders and 20261011004700_stock_locations first';
  end if;
end $$;

-- ---- 1. withholding ----------------------------------------------------------------------------------------------------------------
alter table public.payments drop constraint if exists payments_method_check;
alter table public.payments add constraint payments_method_check
  check (method in ('cash', 'card', 'transfer', 'bit', 'cheque', 'other', 'withholding'));
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payments_withholding_source' and conrelid = 'public.payments'::regclass) then
    -- only a receipt is paid by it (and its cancellation reverses it): never a refund, a credit's money back or an expense
    alter table public.payments add constraint payments_withholding_source check (method <> 'withholding' or source in ('document', 'cancel'));
  end if;
end $$;

-- the percent written on a withholding entry of a receipt: a number 0–100 with up to two decimals, or none
create or replace function public.withholding_pct(p jsonb) returns numeric
language sql immutable set search_path = public as $$
  select case when coalesce(p->>'pct', '') ~ '^[0-9]{1,3}(\.[0-9]{1,2})?$' and (p->>'pct')::numeric <= 100 then (p->>'pct')::numeric end
$$;

-- a receipt that names tax withheld at source: a customer who withheld it, a percent that is a percent, and money too
create or replace function public.documents_withholding() returns trigger
language plpgsql set search_path = public as $$
declare w numeric; n int; bad int;
begin
  if jsonb_typeof(new.payments) is distinct from 'array' then return new; end if;
  select coalesce(sum((p->>'amount')::numeric), 0), count(*),
         count(*) filter (where coalesce(p->>'pct', '') <> '' and public.withholding_pct(p) is null)
    into w, n, bad
    from jsonb_array_elements(new.payments) p where p->>'m' = 'withholding';
  if n = 0 then return new; end if;
  if new.doc_type not in (320, 400) then raise exception 'withholding: only a receipt' using errcode = '23514'; end if;
  if bad > 0 then raise exception 'withholding_pct: the percent is a number from 0 to 100' using errcode = '23514'; end if;
  if new.lead_id is null and btrim(coalesce(new.customer_name, '')) = '' then
    raise exception 'withholding_customer: tax withheld at source needs the customer who withheld it' using errcode = '23514';
  end if;
  if w >= new.total then raise exception 'withholding_all: tax withheld at source is part of a payment, not all of it' using errcode = '23514'; end if;
  return new;
end $$;
revoke execute on function public.documents_withholding() from public, anon, authenticated;
create or replace trigger d_documents_withholding before insert on public.documents
  for each row execute function public.documents_withholding();

-- the receipt's payments into the ledger (20261011004700's, and a withholding entry stays one, with its percent)
create or replace function public.documents_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare p jsonb; m text; l record; rest jsonb;
begin
  -- 1. the ledger: one row per payment of a receipt (2.94: tax withheld at source stays "withholding", with its percent)
  if new.doc_type in (320, 400) then
    for p in select value from jsonb_array_elements(new.payments) loop
      m := coalesce(nullif(p->>'m', ''), case p->>'method' when '1' then 'cash' when '2' then 'cheque' when '3' then 'card' when '4' then 'transfer' else 'other' end);
      if m not in ('cash', 'card', 'transfer', 'bit', 'cheque', 'other', 'withholding') then m := 'other'; end if;
      insert into public.payments (business_id, user_id, direction, amount, method, paid_on, source, document_id, applies_to, sale_id, lead_id, reference)
      values (new.business_id, new.user_id, 'in', (p->>'amount')::numeric, m, coalesce(nullif(p->>'date', '')::date, new.doc_date), 'document',
              new.id, new.paid_document_id, new.sale_id, new.lead_id,
              case when m = 'withholding' then jsonb_strip_nulls(jsonb_build_object('pct', public.withholding_pct(p)))
                   when jsonb_typeof(p->'cheque') = 'object' then p->'cheque' else '{}'::jsonb end);
    end loop;
  end if;
  -- 2. the draft it came from is now issued; the quote it came from is converted
  if new.draft_id is not null then
    update public.document_drafts set status = 'finalized', document_id = new.id where id = new.draft_id and business_id = new.business_id;
  end if;
  if new.quote_id is not null then
    update public.quotes set status = 'converted', converted_document_id = new.id
     where id = new.quote_id and business_id = new.business_id and status in ('draft', 'sent', 'accepted');
  end if;
  -- 3. stock: products sold on a direct document go out on the document that makes the sale — a 300 / 305, or a
  --    320 / 400 that stands alone — and never again on the receipt that pays it (whole or in parts, exempt or not).
  --    Cancelling that document brings them back (document_cancellations_after). The register's sales move stock on
  --    their own. A direct credit invoice brings back the lines marked "restock". A line's variant moves with it (3300).
  if new.sale_id is null and new.refund_id is null then
    if new.doc_type in (300, 305, 320, 400) and new.paid_document_id is null then
      for l in select * from public.stock_lines_v(new.lines) loop
        perform public.stock_move_ref_at(new.business_id, coalesce(new.location_id, new.business_id), l.item_id, l.variant_id, -l.qty, 'sale', format('%s-%s', new.doc_type, new.doc_number), new.id, null);
      end loop;
    elsif new.doc_type = 330 then
      select coalesce(jsonb_agg(e), '[]'::jsonb) into rest from jsonb_array_elements(new.lines) e where (e->>'restock') = 'true';
      for l in select * from public.stock_lines_v(rest) loop
        perform public.stock_move_ref_at(new.business_id, coalesce(new.location_id, new.business_id), l.item_id, l.variant_id, l.qty, 'refund', format('%s-%s', new.doc_type, new.doc_number), new.id, null);
      end loop;
    end if;
  end if;
  -- 4. the audit log
  perform public.finance_log(new.business_id, 'document.issued', 'documents', new.id::text,
    jsonb_build_object('type', new.doc_type, 'number', new.doc_number, 'total', new.total, 'date', new.doc_date, 'source', new.source));
  return null;
end $$;

-- finance_summary (20261010004400's): tax withheld at source is out of the cash, on its own
create or replace function public.finance_summary(p_from date, p_to date) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  b uuid := public.current_business_id(); ent text; vat_on boolean; res jsonb; today date := public.il_today();
begin
  if b is null or (select public.my_access()) = 'register' or b not in (select public.finance_business_ids()) then
    raise exception 'not allowed' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 3700 then raise exception 'bad range' using errcode = '22023'; end if;
  select public.entity_of(s.entity_type, s.business_type) into ent from public.register_settings s where s.business_id = b;
  ent := coalesce(ent, 'licensed_dealer');
  vat_on := public.entity_charges_vat(ent);
  with d as (
    select doc.id, doc.doc_type, doc.doc_date, doc.after_discount, doc.vat_amount, doc.total, doc.customer_dealer,
           public.entity_charges_vat(coalesce(doc.issuer->>'entityType', ent)) as vat_doc,
           exists (select 1 from public.document_cancellations c where c.document_id = doc.id) as cancelled
      from public.documents doc where doc.business_id = b and doc.doc_date between p_from and p_to
  ), rev as (
    -- income: a VAT business by its tax invoices (305 / 320) less credit invoices (330); an exempt one by its receipts
    select coalesce(sum(case when vat_doc and doc_type in (305, 320) then after_discount when vat_doc and doc_type = 330 then -after_discount
                             when not vat_doc and doc_type = 400 and not cancelled then total else 0 end), 0) as net,
           coalesce(sum(case when vat_doc and doc_type in (305, 320) then vat_amount when vat_doc and doc_type = 330 then -vat_amount else 0 end), 0) as vat
      from d
  ), types as (
    select coalesce(jsonb_object_agg(doc_type::text, jsonb_build_object('count', n, 'total', t, 'cancelled', c)), '{}'::jsonb) as j
      from (select doc_type, count(*) n, sum(total) t, count(*) filter (where cancelled) c from d group by doc_type) x
  ), e as (
    select category,
           sum(case when supplier_doc_type = 'credit' then -amount_before_vat else amount_before_vat end) as net,
           sum(case when supplier_doc_type = 'credit' then -vat_amount else vat_amount end) as vat,
           sum((case when supplier_doc_type = 'credit' then -1 else 1 end) * (case when vat_on then round(vat_amount * vat_deductible_pct / 100, 2) else 0 end)) as deductible,
           sum(case when supplier_doc_type = 'credit' then -total else total end) as total, count(*) as n
      from public.expenses where business_id = b and status = 'confirmed' and doc_date between p_from and p_to group by category
  ), et as (
    select coalesce(sum(net), 0) net, coalesce(sum(vat), 0) vat, coalesce(sum(deductible), 0) deductible, coalesce(sum(total), 0) total, coalesce(sum(n), 0) n,
           coalesce(jsonb_agg(jsonb_build_object('category', category, 'net', net, 'vat', vat, 'total', total, 'count', n) order by total desc), '[]'::jsonb) as by_cat
      from e
  ), cash as (
    -- 2.94: tax withheld at source (a receipt's "ניכוי במקור") pays the invoice but is not money — out of in / out, on its own
    select coalesce(sum(amount) filter (where direction = 'in' and method <> 'withholding'), 0) as cin,
           coalesce(sum(amount) filter (where direction = 'out' and method <> 'withholding'), 0) as cout,
           coalesce(sum(case direction when 'in' then amount else -amount end) filter (where method = 'withholding'), 0) as withheld,
           coalesce((select jsonb_agg(jsonb_build_object('method', method, 'in', i, 'out', o) order by i desc)
                       from (select method, sum(amount) filter (where direction = 'in') i, sum(amount) filter (where direction = 'out') o
                               from public.payments where business_id = b and paid_on between p_from and p_to and method <> 'withholding'
                              group by method) m), '[]'::jsonb) as by_method
      from public.payments where business_id = b and paid_on between p_from and p_to
  ), recv as (
    -- open: every invoice's balance; overdue: the lines past their date (an invoice without a plan: its balance, as before)
    select coalesce(sum(balance) filter (where balance > 0), 0) as open, count(*) filter (where balance > 0) as n,
           coalesce((select sum(l.open_amount) from public.receivable_lines l where l.business_id = b and l.open_amount > 0 and l.due_date < today), 0) as overdue,
           (select count(distinct l.document_id) from public.receivable_lines l where l.business_id = b and l.open_amount > 0 and l.due_date < today) as overdue_n
      from public.receivables where business_id = b and not cancelled
  ), pend as (
    select count(*) n, coalesce(sum(total), 0) t from public.sales where business_id = b and status = 'pending'
  ), nodoc as (
    select count(*) n, coalesce(sum(s.total), 0) t from public.sales s
     where s.business_id = b and s.status = 'paid' and (coalesce(s.paid_at, s.created_at) at time zone 'Asia/Jerusalem')::date between p_from and p_to
       and not exists (select 1 from public.documents x where x.sale_id = s.id and x.doc_type in (305, 320, 400))
  ), alloc as (
    select count(*) n from d
     where d.doc_type in (305, 320) and d.vat_doc and d.customer_dealer <> ''
       and d.after_discount > coalesce((select r.threshold_before_vat from public.tax_allocation_rules r where r.effective_from <= d.doc_date
                                         order by r.effective_from desc limit 1), 'infinity'::numeric)
       and not exists (select 1 from public.tax_allocations a where a.document_id = d.id and a.status in ('approved', 'manual') and not a.is_test)
  ), months as (
    select jsonb_agg(jsonb_build_object('month', to_char(m, 'YYYY-MM'),
             'revenue', (select coalesce(sum(case when vat_doc and doc_type in (305, 320) then after_discount when vat_doc and doc_type = 330 then -after_discount
                                                  when not vat_doc and doc_type = 400 and not cancelled then total else 0 end), 0)
                           from d where to_char(d.doc_date, 'YYYY-MM') = to_char(m, 'YYYY-MM')),
             'expenses', (select coalesce(sum((case when supplier_doc_type = 'credit' then -1 else 1 end)
                                              * (amount_before_vat + vat_amount - case when vat_on then round(vat_amount * vat_deductible_pct / 100, 2) else 0 end)), 0)
                            from public.expenses x where x.business_id = b and x.status = 'confirmed' and x.doc_date between p_from and p_to
                              and to_char(x.doc_date, 'YYYY-MM') = to_char(m, 'YYYY-MM'))) order by m) as j
      from generate_series(date_trunc('month', p_from::timestamp), date_trunc('month', p_to::timestamp), interval '1 month') m
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'entity', ent, 'vat', vat_on,
    'revenue', jsonb_build_object('net', rev.net, 'vat', rev.vat, 'gross', rev.net + rev.vat),
    'documents', types.j,
    'expenses', jsonb_build_object('net', et.net, 'vat', et.vat, 'vatDeductible', et.deductible, 'total', et.total, 'count', et.n, 'byCategory', et.by_cat),
    'vatPayable', case when vat_on then rev.vat - et.deductible else 0 end,
    'profit', rev.net - (et.net + et.vat - et.deductible),
    'cash', jsonb_build_object('in', cash.cin, 'out', cash.cout, 'net', cash.cin - cash.cout, 'byMethod', cash.by_method),
    'withheld', cash.withheld,
    'receivables', jsonb_build_object('open', recv.open, 'count', recv.n, 'overdue', recv.overdue, 'overdueCount', recv.overdue_n),
    'pending', jsonb_build_object('count', pend.n, 'total', pend.t),
    'posWithoutDocument', jsonb_build_object('count', nodoc.n, 'total', nodoc.t),
    'allocationMissing', alloc.n,
    'months', coalesce(months.j, '[]'::jsonb),
    'lockedUntil', public.finance_locked_until(b))
  into res from rev, types, et, cash, recv, pend, nodoc, alloc, months;
  return res;
end $$;

-- ---- 3. a service's treatment type -----------------------------------------------------------------------------------------------
alter table public.catalog_items add column if not exists treatment_type_id uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'catalog_items_treatment_type_fk' and conrelid = 'public.catalog_items'::regclass) then
    alter table public.catalog_items add constraint catalog_items_treatment_type_fk
      foreign key (treatment_type_id, business_id) references public.treatment_types (id, business_id) on delete set null (treatment_type_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'catalog_items_treatment_type_check' and conrelid = 'public.catalog_items'::regclass) then
    -- a service has a treatment type; a package keeps its own (package_type_id)
    alter table public.catalog_items add constraint catalog_items_treatment_type_check check (treatment_type_id is null or kind = 'service');
  end if;
end $$;

-- ---- 4. advances -----------------------------------------------------------------------------------------------------------------
alter table public.business_finance_profile add column if not exists advance_pct numeric(5,2);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'business_finance_profile_advance_pct_check' and conrelid = 'public.business_finance_profile'::regclass) then
    alter table public.business_finance_profile add constraint business_finance_profile_advance_pct_check check (advance_pct is null or advance_pct between 0 and 100);
  end if;
end $$;

-- ---- 2. reports --------------------------------------------------------------------------------------------------------------------
-- who a document's customer (or an expense's supplier) is: the CRM card; else the dealer number; else the name (expense_norm_supplier's rule)
create or replace function public.party_key(p_lead uuid, p_dealer text, p_name text) returns text
language sql immutable set search_path = public as $$
  select case when p_lead is not null then 'l:' || p_lead::text
              when coalesce(p_dealer, '') ~ '^[0-9]{9}$' then 'd:' || p_dealer
              else 'n:' || public.expense_norm_supplier(p_name) end
$$;

-- every report: the business the member works in, its money open to them (not a cashier), a sane period — as finance_summary
create or replace function public.report_business(p_from date, p_to date) returns uuid
language plpgsql stable set search_path = public as $$
declare b uuid := public.current_business_id();
begin
  if b is null or (select public.my_access()) = 'register' or b not in (select public.finance_business_ids()) then
    raise exception 'not allowed' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 3700 then raise exception 'bad range' using errcode = '22023'; end if;
  return b;
end $$;

-- a document's revenue: a VAT business by its tax invoices less its credit invoices (before VAT), an exempt one by its receipts —
-- finance_summary's own rule, here for one document (0 when it is not revenue)
create or replace function public.doc_revenue(p_type int, p_vat_doc boolean, p_after numeric, p_total numeric, p_cancelled boolean) returns numeric
language sql immutable set search_path = public as $$
  select case when p_vat_doc and p_type in (305, 320) then p_after when p_vat_doc and p_type = 330 then -p_after
              when not p_vat_doc and p_type = 400 and not p_cancelled then p_total else 0 end
$$;

create or replace function public.report_income_by_customer(p_from date, p_to date) returns jsonb
language plpgsql stable set search_path = public as $$
declare b uuid := public.report_business(p_from, p_to); ent text; vat_on boolean; res jsonb;
begin
  select public.entity_of(s.entity_type, s.business_type) into ent from public.register_settings s where s.business_id = b;
  ent := coalesce(ent, 'licensed_dealer');
  vat_on := public.entity_charges_vat(ent);
  with d as (
    select doc.doc_type, doc.doc_date, doc.issued_at, doc.lead_id, doc.customer_dealer, doc.customer_name, doc.after_discount, doc.vat_amount, doc.total,
           public.entity_charges_vat(coalesce(doc.issuer->>'entityType', ent)) as vat_doc,
           exists (select 1 from public.document_cancellations c where c.document_id = doc.id) as cancelled
      from public.documents doc where doc.business_id = b and doc.doc_date between p_from and p_to
  ), r as (
    select public.party_key(lead_id, customer_dealer, customer_name) as k, lead_id, customer_dealer, customer_name, doc_date, issued_at,
           public.doc_revenue(doc_type, vat_doc, after_discount, total, cancelled) as net,
           case when vat_doc and doc_type in (305, 320) then vat_amount when vat_doc and doc_type = 330 then -vat_amount else 0 end as vat
      from d where (vat_doc and doc_type in (305, 320, 330)) or (not vat_doc and doc_type = 400 and not cancelled)
  ), g as (
    select k, sum(net) as net, sum(vat) as vat, count(*) as n,
           (array_agg(lead_id order by doc_date desc, issued_at desc) filter (where lead_id is not null))[1] as lead_id,
           (array_agg(customer_dealer order by doc_date desc, issued_at desc) filter (where customer_dealer <> ''))[1] as dealer,
           (array_agg(customer_name order by doc_date desc, issued_at desc))[1] as name
      from r group by k
  )
  select jsonb_build_object('from', p_from, 'to', p_to, 'vat', vat_on,
           'total', jsonb_build_object('net', coalesce(sum(g.net), 0), 'vat', coalesce(sum(g.vat), 0), 'count', coalesce(sum(g.n), 0)),
           'customers', coalesce(jsonb_agg(jsonb_build_object('key', g.k, 'leadId', g.lead_id, 'name', coalesce(ld.name, g.name, ''), 'dealer', coalesce(g.dealer, ''),
             'net', g.net, 'vat', g.vat, 'gross', g.net + g.vat, 'count', g.n) order by g.net desc, coalesce(ld.name, g.name)), '[]'::jsonb))
    into res
    from g left join public.leads ld on ld.id = g.lead_id;
  return res;
end $$;

-- a sale's (or a refund's) items as a document's lines for the reports: the item, the variant, the quantity, and price × quantity as
-- the weight (the register's prices include VAT — every line alike, so the shares are the same)
create or replace function public.report_item_lines(p_items jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('name', coalesce(e->>'name', ''), 'qty', (e->>'qty')::numeric, 'itemId', e->>'itemId', 'variantId', e->>'variantId',
                  'totalExVat', (e->>'qty')::numeric * case when coalesce(e->>'price', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (e->>'price')::numeric else 0 end)
                  order by n), '[]'::jsonb)
    from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) with ordinality x(e, n)
   where coalesce(e->>'qty', '') ~ '^[0-9]+(\.[0-9]+)?$' and (e->>'qty')::numeric > 0
$$;

-- sales by item, service and treatment type: each revenue document's amount (as above) spread over its lines by their totals before
-- VAT — rounded to the agora, what rounding leaves on the biggest line — so the items add up to the revenue exactly. A document of
-- the register or of the site (its sale's, or its refund's) is spread over the lines of the sale — they carry the item, the
-- document's lines only name it — a refund over the lines that came back, or (a sum) over the sale's by its share. A receipt with
-- no lines of its own (an exempt dealer's receipt paying a transaction invoice) takes the lines of the document it pays, and its
-- share of their quantities (a receipt for half of it: half the units); a document with no lines at all is "not by item".
create or replace function public.report_sales_by_item(p_from date, p_to date) returns jsonb
language plpgsql stable set search_path = public as $$
declare b uuid := public.report_business(p_from, p_to); ent text; vat_on boolean; res jsonb;
begin
  select public.entity_of(s.entity_type, s.business_type) into ent from public.register_settings s where s.business_id = b;
  ent := coalesce(ent, 'licensed_dealer');
  vat_on := public.entity_charges_vat(ent);
  with d as (
    select doc.id, doc.doc_type, doc.lines, doc.paid_document_id, doc.sale_id, doc.refund_id, doc.total,
           public.doc_revenue(doc.doc_type, public.entity_charges_vat(coalesce(doc.issuer->>'entityType', ent)), doc.after_discount, doc.total,
             exists (select 1 from public.document_cancellations c where c.document_id = doc.id)) as amt
      from public.documents doc where doc.business_id = b and doc.doc_date between p_from and p_to
  ), own as (
    select d.*, jsonb_typeof(d.lines) = 'array' and jsonb_array_length(d.lines) > 0 as has_lines from d where d.amt <> 0
  ), via as (
    -- the register's and the site's documents: the lines of the refund (what came back), else of the sale
    select o.*, rf.lines as refund_lines, sl.lines as sale_lines, sl.total as sale_total, p.lines as paid_lines, p.total as paid_total
      from own o
      left join public.sale_refunds rr on rr.id = o.refund_id
      left join lateral (select public.report_item_lines(rr.items) as lines) rf on rr.id is not null
      left join lateral (select s.total, public.report_item_lines(s.items) as lines from public.sales s where s.id = coalesce(o.sale_id, rr.sale_id)) sl on true
      left join public.documents p on not o.has_lines and p.id = o.paid_document_id and jsonb_typeof(p.lines) = 'array'
  ), src as (
    select v.id, v.amt, v.doc_type,
           case when jsonb_array_length(coalesce(v.refund_lines, '[]'::jsonb)) > 0 then v.refund_lines
                when jsonb_array_length(coalesce(v.sale_lines, '[]'::jsonb)) > 0 then v.sale_lines
                when v.has_lines then v.lines else coalesce(v.paid_lines, '[]'::jsonb) end as lines,
           case when jsonb_array_length(coalesce(v.refund_lines, '[]'::jsonb)) > 0 then 1
                when jsonb_array_length(coalesce(v.sale_lines, '[]'::jsonb)) > 0 then
                  case when v.refund_id is null then 1 else coalesce(abs(v.total) / nullif(v.sale_total, 0), 0) end
                when v.has_lines then 1 else coalesce(abs(v.amt) / nullif(v.paid_total, 0), 0) end as frac
      from via v
  ), l as (
    select s.id, s.amt, s.frac, e.ord, e.value as line,
           case when coalesce(e.value->>'totalExVat', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (e.value->>'totalExVat')::numeric else 0 end as base
      from src s cross join lateral jsonb_array_elements(s.lines) with ordinality e(value, ord)
  ), w as (
    select l.*, sum(base) over (partition by id) as tot, row_number() over (partition by id order by abs(base) desc, ord) as rk from l
  ), sh as (
    select w.*, round(amt * base / tot, 2) as share0 from w where tot <> 0
  ), fx as (
    select sh.*, share0 + case when rk = 1 then amt - sum(share0) over (partition by id) else 0 end as share from sh
  ), un as (
    select coalesce(sum(s.amt), 0) as net, count(*) as n from src s where not exists (select 1 from sh where sh.id = s.id)
  ), it as (
    select coalesce(nullif(line->>'itemId', '') || '|' || coalesce(line->>'variantId', ''), 'name:' || coalesce(line->>'name', '')) as k,
           max(case when coalesce(line->>'itemId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then line->>'itemId' end) as item_id,
           max(case when coalesce(line->>'variantId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then line->>'variantId' end) as variant_id,
           max(coalesce(line->>'name', '')) as name,
           round(sum(sign(amt) * frac * case when coalesce(line->>'qty', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (line->>'qty')::numeric else 0 end), 2) as qty,
           sum(share) as net
      from fx group by 1
  ), items as (
    select it.*, ci.kind, ci.name as item_name,
           case when ci.kind = 'package' then ci.package_type_id else ci.treatment_type_id end as type_id
      from it left join public.catalog_items ci on ci.id = it.item_id::uuid and ci.business_id = b
  ), types as (
    select i.type_id, coalesce(t.name, '') as name, sum(i.net) as net, sum(i.qty) as qty
      from items i left join public.treatment_types t on t.id = i.type_id and t.business_id = b group by 1, 2
  )
  select jsonb_build_object('from', p_from, 'to', p_to, 'vat', vat_on,
           'total', (select coalesce(sum(amt), 0) from src),
           'items', coalesce((select jsonb_agg(jsonb_build_object('key', k, 'itemId', item_id, 'variantId', variant_id,
                       'name', case when variant_id is null then coalesce(item_name, name) else name end, 'kind', coalesce(kind, ''),
                       'typeId', type_id, 'qty', qty, 'net', net) order by net desc, name) from items), '[]'::jsonb),
           'types', coalesce((select jsonb_agg(jsonb_build_object('typeId', type_id, 'name', name, 'qty', qty, 'net', net) order by net desc, name) from types), '[]'::jsonb),
           'unattributed', (select jsonb_build_object('net', net, 'count', n) from un))
    into res;
  return res;
end $$;

-- a customer's card ("כרטסת לקוח"): what they were charged (an invoice, a tax invoice-receipt, a stand-alone receipt) and what
-- they paid or were credited (a receipt's payments — tax withheld included —, a credit invoice, a cancelled charge), money paid back,
-- with the balance as it runs. The opening balance is everything before the period.
create or replace function public.report_customer_ledger(p_key text, p_from date, p_to date) returns jsonb
language plpgsql stable set search_path = public as $$
declare b uuid := public.report_business(p_from, p_to); res jsonb;
begin
  if coalesce(p_key, '') !~ '^(l|d|n):' then raise exception 'customer: a key' using errcode = '22023'; end if;
  with docs as (
    select doc.id, doc.doc_type, doc.doc_number, doc.doc_date, doc.issued_at, doc.total, doc.paid_document_id, doc.refund_id, doc.lead_id, doc.customer_name,
           public.party_key(doc.lead_id, doc.customer_dealer, doc.customer_name) as k,
           (select c.created_at from public.document_cancellations c where c.document_id = doc.id) as cancelled_at
      from public.documents doc where doc.business_id = b
  ), mine as (
    select * from docs where k = p_key
  ), mv as (
    -- a tax invoice-receipt (320) or a receipt (400) that pays an invoice charges nothing again: the invoice did
    select doc_date as day, issued_at as at, 'charge' as kind, doc_type, doc_number, total as debit, 0::numeric as credit, '' as method, id::text as rid
      from mine where doc_type in (300, 305) or (doc_type in (320, 400) and paid_document_id is null)
    union all
    select doc_date, issued_at, 'credit', doc_type, doc_number, 0, total, '', id::text from mine where doc_type = 330
    union all
    select (cancelled_at at time zone 'Asia/Jerusalem')::date, cancelled_at, 'cancelled', doc_type, doc_number, 0, total, '', id::text
      from mine where cancelled_at is not null and (doc_type = 300 or (doc_type = 400 and paid_document_id is null))
    union all
    select p.paid_on, p.created_at, 'payment_' || p.source, x.doc_type, x.doc_number,
           case when p.direction = 'out' then p.amount else 0 end, case when p.direction = 'in' then p.amount else 0 end, p.method, p.id::text
      from public.payments p
      join lateral (select m.doc_type, m.doc_number from mine m
                     where m.id = coalesce(p.document_id, (select r.id from public.documents r where r.refund_id = p.refund_id and r.doc_type = 330 limit 1), p.applies_to)
                     limit 1) x on true
     where p.business_id = b and p.source in ('document', 'credit', 'cancel', 'refund')
  ), op as (
    select coalesce(sum(debit - credit), 0) as opening from mv where day < p_from
  ), rw as (
    select mv.*, op.opening + sum(debit - credit) over (order by day, at, kind, rid rows unbounded preceding) as balance
      from mv, op where day between p_from and p_to
  )
  select jsonb_build_object('key', p_key, 'from', p_from, 'to', p_to,
           'name', coalesce((select l.name from public.leads l where p_key like 'l:%' and l.id::text = substr(p_key, 3)),
                            (select m.customer_name from mine m order by m.doc_date desc, m.issued_at desc limit 1), ''),
           'opening', (select opening from op),
           'debit', coalesce((select sum(debit) from rw), 0), 'credit', coalesce((select sum(credit) from rw), 0),
           'closing', (select opening from op) + coalesce((select sum(debit - credit) from rw), 0),
           'rows', coalesce((select jsonb_agg(jsonb_build_object('date', day, 'kind', kind, 'docType', doc_type, 'docNumber', doc_number,
                     'debit', debit, 'credit', credit, 'method', method, 'balance', balance) order by day, at, kind, rid) from rw), '[]'::jsonb))
    into res;
  return res;
end $$;

-- suppliers and kinds of expense: the confirmed expenses of the period (a supplier's credit note takes off), what of them was paid
-- (the ledger: money out, less money back and voided payments) and what is still to pay
create or replace function public.report_suppliers(p_from date, p_to date) returns jsonb
language plpgsql stable set search_path = public as $$
declare b uuid := public.report_business(p_from, p_to); res jsonb;
begin
  with x as (
    select e.id, e.category, e.supplier_name, e.supplier_dealer, e.doc_date, e.created_at,
           public.party_key(null, e.supplier_dealer, e.supplier_name) as k,
           (case when e.supplier_doc_type = 'credit' then -1 else 1 end) as sg, e.amount_before_vat, e.vat_amount, e.total
      from public.expenses e where e.business_id = b and e.status = 'confirmed' and e.doc_date between p_from and p_to
  ), pay as (
    select p.expense_id, sum(case p.direction when 'out' then p.amount else -p.amount end) as paid
      from public.payments p where p.business_id = b and p.expense_id is not null and p.source in ('expense', 'reversal') group by 1
  ), r as (
    select x.*, sg * total as amount, sg * amount_before_vat as net, sg * vat_amount as vat, coalesce(pay.paid, 0) as paid
      from x left join pay on pay.expense_id = x.id
  ), s as (
    select k, (array_agg(supplier_name order by doc_date desc, created_at desc))[1] as name,
           (array_agg(supplier_dealer order by doc_date desc, created_at desc) filter (where supplier_dealer <> ''))[1] as dealer,
           count(*) as n, sum(net) as net, sum(vat) as vat, sum(amount) as total, sum(paid) as paid
      from r group by k
  ), c as (
    select category, count(*) as n, sum(net) as net, sum(amount) as total, sum(paid) as paid from r group by category
  )
  select jsonb_build_object('from', p_from, 'to', p_to,
           'total', jsonb_build_object('net', coalesce((select sum(net) from r), 0), 'vat', coalesce((select sum(vat) from r), 0),
                                       'total', coalesce((select sum(amount) from r), 0), 'paid', coalesce((select sum(paid) from r), 0),
                                       'open', coalesce((select sum(amount - paid) from r), 0), 'count', (select count(*) from r)),
           'suppliers', coalesce((select jsonb_agg(jsonb_build_object('key', k, 'name', coalesce(name, ''), 'dealer', coalesce(dealer, ''), 'count', n,
                           'net', net, 'vat', vat, 'total', total, 'paid', paid, 'open', total - paid) order by total desc, name) from s), '[]'::jsonb),
           'categories', coalesce((select jsonb_agg(jsonb_build_object('category', category, 'count', n, 'net', net, 'total', total, 'paid', paid,
                           'open', total - paid) order by total desc, category) from c), '[]'::jsonb))
    into res;
  return res;
end $$;

-- a supplier's card ("כרטסת ספק"): their invoices (what the business owes), their credit notes and the business's payments to them
-- (and back), with what is owed as it runs. The opening balance is everything before the period.
create or replace function public.report_supplier_ledger(p_key text, p_from date, p_to date) returns jsonb
language plpgsql stable set search_path = public as $$
declare b uuid := public.report_business(p_from, p_to); res jsonb;
begin
  if coalesce(p_key, '') !~ '^(d|n):' then raise exception 'supplier: a key' using errcode = '22023'; end if;
  with x as (
    select e.id, e.status, e.supplier_name, e.supplier_doc_type, e.supplier_doc_number, e.expense_number, e.doc_date, e.created_at, e.total
      from public.expenses e where e.business_id = b and public.party_key(null, e.supplier_dealer, e.supplier_name) = p_key
  ), mv as (
    select doc_date as day, created_at as at, case when supplier_doc_type = 'credit' then 'supplier_credit' else 'invoice' end as kind,
           expense_number as number, supplier_doc_number as ref,
           case when supplier_doc_type = 'credit' then total else 0 end as debit, case when supplier_doc_type = 'credit' then 0 else total end as credit, '' as method,
           id::text as rid
      from x where status = 'confirmed'
    union all
    select p.paid_on, p.created_at, 'payment_' || p.source, x.expense_number, x.supplier_doc_number,
           case when p.direction = 'out' then p.amount else 0 end, case when p.direction = 'in' then p.amount else 0 end, p.method, p.id::text
      from public.payments p join x on x.id = p.expense_id
     where p.business_id = b and p.source in ('expense', 'reversal')
  ), op as (
    select coalesce(sum(credit - debit), 0) as opening from mv where day < p_from
  ), rw as (
    select mv.*, op.opening + sum(credit - debit) over (order by day, at, kind, rid rows unbounded preceding) as balance
      from mv, op where day between p_from and p_to
  )
  select jsonb_build_object('key', p_key, 'from', p_from, 'to', p_to,
           'name', coalesce((select x.supplier_name from x order by x.doc_date desc, x.created_at desc limit 1), ''),
           'opening', (select opening from op),
           'debit', coalesce((select sum(debit) from rw), 0), 'credit', coalesce((select sum(credit) from rw), 0),
           'closing', (select opening from op) + coalesce((select sum(credit - debit) from rw), 0),
           'rows', coalesce((select jsonb_agg(jsonb_build_object('date', day, 'kind', kind, 'number', number, 'ref', ref,
                     'debit', debit, 'credit', credit, 'method', method, 'balance', balance) order by day, at, kind, rid) from rw), '[]'::jsonb))
    into res;
  return res;
end $$;

-- tax withheld at source, by customer (for the yearly report against the certificates): the receipts' withholding entries of the
-- period, less the ones of receipts cancelled since
create or replace function public.report_withholding(p_from date, p_to date) returns jsonb
language plpgsql stable set search_path = public as $$
declare b uuid := public.report_business(p_from, p_to); res jsonb;
begin
  with w as (
    select p.paid_on, p.created_at, p.direction, case p.direction when 'in' then p.amount else -p.amount end as amount, (p.reference->>'pct')::numeric as pct,
           r.doc_type, r.doc_number, r.customer_name, r.customer_dealer, r.lead_id,
           public.party_key(r.lead_id, r.customer_dealer, r.customer_name) as k,
           (select i.doc_type || '-' || i.doc_number from public.documents i where i.id = p.applies_to) as invoice
      from public.payments p join public.documents r on r.id = p.document_id
     where p.business_id = b and p.method = 'withholding' and p.paid_on between p_from and p_to
  ), g as (
    select k, sum(amount) as amount, count(*) filter (where direction = 'in') - count(*) filter (where direction = 'out') as n,
           (array_agg(lead_id order by paid_on desc, created_at desc) filter (where lead_id is not null))[1] as lead_id,
           (array_agg(customer_dealer order by paid_on desc, created_at desc) filter (where customer_dealer <> ''))[1] as dealer,
           (array_agg(customer_name order by paid_on desc, created_at desc))[1] as name
      from w group by k
  )
  select jsonb_build_object('from', p_from, 'to', p_to, 'total', coalesce((select sum(amount) from w), 0),
           'customers', coalesce((select jsonb_agg(jsonb_build_object('key', g.k, 'leadId', g.lead_id, 'name', coalesce(ld.name, g.name, ''),
                           'dealer', coalesce(g.dealer, ''), 'amount', g.amount, 'count', g.n) order by g.amount desc, coalesce(ld.name, g.name))
                           from g left join public.leads ld on ld.id = g.lead_id), '[]'::jsonb),
           'rows', coalesce((select jsonb_agg(jsonb_build_object('date', paid_on, 'key', k, 'name', customer_name, 'dealer', customer_dealer,
                       'docType', doc_type, 'docNumber', doc_number, 'invoice', invoice, 'amount', amount, 'pct', pct) order by paid_on, created_at) from w), '[]'::jsonb))
    into res;
  return res;
end $$;

-- the screens call the reports (the business's own policies decide what they read); nobody else
do $$
declare f text;
begin
  foreach f in array array['report_income_by_customer(date, date)', 'report_sales_by_item(date, date)', 'report_customer_ledger(text, date, date)',
                           'report_suppliers(date, date)', 'report_supplier_ledger(text, date, date)', 'report_withholding(date, date)',
                           'report_business(date, date)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- =====================================================================================================================
-- Rollback (by hand, if ever needed — only while no receipt names tax withheld at source): drop the functions report_*, party_key,
--   doc_revenue, report_item_lines, documents_withholding (and the trigger d_documents_withholding), withholding_pct; put back finance_summary of
--   20261010004400 and documents_after_insert of 20261011004700; the method check of payments without 'withholding' and
--   drop payments_withholding_source; alter table catalog_items drop column treatment_type_id; alter table
--   business_finance_profile drop column advance_pct.
-- =====================================================================================================================
