-- ita-demo.seed.sql — demo data for the Tax Authority software registration (מרשם התוכנות), LOCAL Postgres ONLY.
-- Never run on the live database (it stops at the top on a Supabase project). Not a migration (not in supabase/migrations);
-- tests/sql/ita-demo.check.sql loads it twice, so it runs on every tests/sql/run.sh.
--
-- What it makes: one separate demo business, "עסק דמו — רישום תוכנה" (licensed dealer, dealer number 000000109 — fictional (leading zeros), a valid
-- check digit), with its issuer details in register_settings + business_finance_profile, and about five months of documents
-- (1.6.2026 – 31.10.2026, no Saturdays) of every type the software issues for a licensed dealer:
--   320 (sales, several lines, cash / card / transfer / cheque / Bit / other / split), 305 (to business customers, with ע.מ / ח.פ),
--   300 (some paid by a 320, some cancelled), 400 (receipts for 305 — whole, in two parts, with tax withheld at source; some
--   cancelled and issued again), 330 (credits of 320 — a full mirror or a part — and of 305 — a part).
-- Enough for a BKMVDATA of more than 2,000 records (C100 + D110 + D120; see tests/sql/ita-demo.check.sql).
--
-- How: every document is a plain insert into public.documents by the demo owner signed in (role authenticated + JWT subject),
-- through every trigger (numbering, issuer snapshot, documents_validate, the ledger, the audit log) — the number, the issue time
-- and the issuer are never written by hand. Cancellations only through document_cancellations. Keys as the app makes them
-- (direct:… / receipt:<doc>:<n> / credit:<doc>:<n>).
--
-- Needs: every migration (tests/sql/run.sh loads them) and a database clock on or after 1.11.2026 (the documents are dated
-- June–October 2026 and a document is never dated ahead of today).
-- Run again: nothing is added (the whole file is one transaction; the documents part runs only for a business without documents,
-- and every document is guarded by its key — never "on conflict do nothing", which would burn a number of the counter).
--
-- Usage (repo dream-promotion/, after the migrations):  psql -X -v ON_ERROR_STOP=1 -d <db> -f tests/sql/ita-demo.seed.sql
\set ON_ERROR_STOP 1
set client_min_messages = warning;

do $$
begin
  -- never on a real Supabase project (the live database): it has auth.identities and is called "postgres"; the local shim has neither
  if to_regclass('auth.identities') is not null or current_database() = 'postgres' then
    raise exception 'ita-demo: this is local test data only — refusing to run on % (a Supabase / live database?)', current_database();
  end if;
end $$;

begin;

do $$
begin
  if to_regprocedure('public.issuer_snapshot(uuid)') is null or to_regprocedure('public.documents_goods()') is null
     or to_regprocedure('public.documents_withholding()') is null or to_regclass('public.business_locations') is null then
    raise exception 'ita-demo: run every migration first (tests/sql/run.sh)';
  end if;
  if public.il_today() < date '2026-11-01' then
    raise exception 'ita-demo: the demo is dated June–October 2026; the database''s today (%) is before 1.11.2026', public.il_today();
  end if;
end $$;

-- ---- the demo business (fixed ids; nothing that exists is changed) ----------------------------------------------------
insert into auth.users (id, email) values ('d3e00000-0000-4000-8000-0000000000a1', 'ita-demo-owner@example.test')
  on conflict (id) do nothing;
insert into public.businesses (id, name, slug) values ('d3e00000-0000-4000-8000-000000000001', 'עסק דמו — רישום תוכנה', 'ita-demo')
  on conflict (id) do nothing;
insert into public.business_members (business_id, user_id, role, access)
  values ('d3e00000-0000-4000-8000-000000000001', 'd3e00000-0000-4000-8000-0000000000a1', 'owner', 'full')
  on conflict do nothing;
update public.profiles set current_business_id = 'd3e00000-0000-4000-8000-000000000001'
 where id = 'd3e00000-0000-4000-8000-0000000000a1' and current_business_id is distinct from 'd3e00000-0000-4000-8000-000000000001';
-- the issuer: legal name with a plain hyphen (the unified file writes ISO-8859-8: an em dash would become '?')
insert into public.register_settings (user_id, business_id, business_type, vat_rate, dealer_number, company_number, legal_name,
                                      street, house_no, city, zip, entity_type)
  values ('d3e00000-0000-4000-8000-0000000000a1', 'd3e00000-0000-4000-8000-000000000001', 'licensed', 18, '000000109', '',
          'עסק דמו - רישום תוכנה', 'הרצל', '10', 'תל אביב-יפו', '6107001', 'licensed_dealer')
  on conflict (business_id) do nothing;
insert into public.business_finance_profile (business_id, user_id, trading_name, phone, email, bank_name, bank_branch, bank_account,
                                             payment_terms, doc_note, vat_period)
  values ('d3e00000-0000-4000-8000-000000000001', 'd3e00000-0000-4000-8000-0000000000a1', 'דמו רישום', '03-0000000',
          'ita-demo@example.test', 'בנק דמו', '123', '123456', 'net_30', 'מסמך לדוגמה - נתוני דמו בלבד', 'bimonthly')
  on conflict (business_id) do nothing;

-- ---- helpers (this session only) ---------------------------------------------------------------------------------------
-- a fixed pseudo-random number of a text (the same on every database)
create or replace function pg_temp.ita_h(t text) returns int language sql immutable as $$
  select ('x' || substr(md5(t), 1, 7))::bit(28)::int $$;

-- lines and totals, agorot-exact, as computeLines (src/features/finance/compose.ts):
-- items [{name, qty, unit (agorot)}]; prices including VAT (shop) or before VAT (business to business); a discount in percent
create or replace function pg_temp.ita_compute(items jsonb, incl boolean, disc_pct numeric, rate numeric) returns jsonb
language plpgsql immutable as $$
declare
  n int := jsonb_array_length(items); la bigint[] := '{}'; nl bigint[]; sub bigint; d bigint; tot bigint; vat bigint; aft bigint; bef bigint;
  big int; i int; lines jsonb := '[]'; q numeric;
begin
  for i in 1..n loop
    la := la || round((items->(i-1)->>'unit')::numeric * (items->(i-1)->>'qty')::numeric)::bigint;
  end loop;
  select sum(x) into sub from unnest(la) x;
  d := least(sub, round(sub * coalesce(disc_pct, 0) / 100)::bigint);
  if rate = 0 then
    nl := la; bef := sub; aft := sub - d; vat := 0; tot := aft;
  elsif incl then
    tot := sub - d; vat := round(tot * rate / (100 + rate))::bigint; aft := tot - vat;
    nl := array(select x - round(x * rate / (100 + rate))::bigint from unnest(la) with ordinality u(x, o) order by o);
    select sum(x) into bef from unnest(nl) x;
    -- the biggest line absorbs the agorot (the first of equals, as indexOf)
    if d = 0 or bef < aft then
      select o into big from unnest(nl) with ordinality u(x, o) order by x desc, o limit 1;
      nl[big] := nl[big] + aft - bef; bef := aft;
    end if;
  else
    nl := la; bef := sub; aft := sub - d; vat := round(aft * rate / 100)::bigint; tot := aft + vat;
  end if;
  for i in 1..n loop
    q := (items->(i-1)->>'qty')::numeric;
    lines := lines || jsonb_build_array(jsonb_build_object('name', items->(i-1)->>'name', 'qty', q,
      'unitPriceExVat', round(round(nl[i] / q) / 100.0, 2), 'discountExVat', 0, 'totalExVat', round(nl[i] / 100.0, 2), 'vatRate', rate, 'kind', 1));
  end loop;
  return jsonb_build_object('lines', lines, 'before_discount', round(bef / 100.0, 2), 'discount', round((bef - aft) / 100.0, 2),
    'after_discount', round(aft / 100.0, 2), 'vat_amount', round(vat / 100.0, 2), 'total', round(tot / 100.0, 2), 'vat_rate', rate);
end $$;

-- how a receipt was paid (the document's payments, as toDocPayment): one or two payments of amount_a agorot
create or replace function pg_temp.ita_pay(kind text, amount_a bigint, d date, seed text) returns jsonb language plpgsql immutable as $$
declare h int := pg_temp.ita_h(seed); a1 bigint; s text := to_char(d, 'YYYY-MM-DD');
  -- fictional cheque details: branch 000, account 000xxx, a small cheque number (the bank code identifies no one)
  cheque jsonb := jsonb_build_object('bank', (10 + h % 3 * 2)::text, 'branch', '000', 'account', '000' || lpad((h % 1000)::text, 3, '0'),
                                     'number', (1 + h % 999)::text, 'dueDate', to_char(d + h % 45, 'YYYY-MM-DD'));
  one jsonb;
begin
  a1 := round(amount_a * 0.4)::bigint;
  one := case kind
    when 'cash'     then jsonb_build_object('method', 1, 'amount', round(amount_a / 100.0, 2), 'date', s, 'm', 'cash')
    when 'card'     then jsonb_build_object('method', 3, 'amount', round(amount_a / 100.0, 2), 'date', s, 'm', 'card')
    when 'transfer' then jsonb_build_object('method', 4, 'amount', round(amount_a / 100.0, 2), 'date', s, 'm', 'transfer')
    when 'cheque'   then jsonb_build_object('method', 2, 'amount', round(amount_a / 100.0, 2), 'date', s, 'm', 'cheque', 'cheque', cheque)
    when 'bit'      then jsonb_build_object('method', 9, 'amount', round(amount_a / 100.0, 2), 'date', s, 'm', 'bit')
    when 'other'    then jsonb_build_object('method', 9, 'amount', round(amount_a / 100.0, 2), 'date', s, 'm', 'other')
    else null end;
  if one is not null then return jsonb_build_array(one); end if;
  if kind = 'cash_card' then
    return jsonb_build_array(jsonb_build_object('method', 1, 'amount', round(a1 / 100.0, 2), 'date', s, 'm', 'cash'),
                             jsonb_build_object('method', 3, 'amount', round((amount_a - a1) / 100.0, 2), 'date', s, 'm', 'card'));
  elsif kind = 'cheque_cash' then
    return jsonb_build_array(jsonb_build_object('method', 2, 'amount', round((amount_a - a1) / 100.0, 2), 'date', s, 'm', 'cheque', 'cheque', cheque),
                             jsonb_build_object('method', 1, 'amount', round(a1 / 100.0, 2), 'date', s, 'm', 'cash'));
  elsif kind = 'withholding' then
    -- tax withheld at source, 5% — part of the payment, never all of it (2.94)
    a1 := round(amount_a * 0.05)::bigint;
    return jsonb_build_array(jsonb_build_object('method', 4, 'amount', round((amount_a - a1) / 100.0, 2), 'date', s, 'm', 'transfer'),
                             jsonb_build_object('method', 9, 'amount', round(a1 / 100.0, 2), 'date', s, 'm', 'withholding', 'pct', 5));
  end if;
  raise exception 'ita-demo: unknown payment kind %', kind;
end $$;

-- issue one document the way the app does (issueDocumentRow: a plain insert; the key guards a second run)
create or replace function pg_temp.ita_issue(k text, r jsonb) returns uuid language plpgsql as $$
declare cols text; id uuid;
begin
  select d.id into id from public.documents d where d.business_id = 'd3e00000-0000-4000-8000-000000000001' and d.idempotency_key = k;
  if id is not null then return id; end if;
  r := r || jsonb_build_object('idempotency_key', k, 'user_id', 'd3e00000-0000-4000-8000-0000000000a1',
                               'business_id', 'd3e00000-0000-4000-8000-000000000001', 'doc_number', 0);
  select string_agg(quote_ident(x), ', ') into cols from jsonb_object_keys(r) x;
  execute format('insert into public.documents (%s) select %s from jsonb_populate_record(null::public.documents, $1) returning id', cols, cols)
    using r into id;
  return id;
end $$;

-- what is left to pay on an invoice (as documents_more_checks: total − credits − receipts, a cancelled receipt's money is back)
create or replace function pg_temp.ita_balance(p_doc uuid) returns numeric language sql stable as $$
  select d.total
       - coalesce((select sum(c.total) from public.documents c where c.business_id = d.business_id and c.doc_type = 330
                     and c.base_doc_type = d.doc_type and c.base_doc_number = d.doc_number), 0)
       - coalesce((select sum(case p.direction when 'in' then p.amount else -p.amount end) from public.payments p where p.applies_to = d.id), 0)
    from public.documents d where d.id = p_doc $$;

-- ---- the documents, as the demo owner ----------------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = 'd3e00000-0000-4000-8000-0000000000a1';
set local "request.jwt.claim.role" = 'authenticated';

do $$
declare
  B constant uuid := 'd3e00000-0000-4000-8000-000000000001';
  U constant uuid := 'd3e00000-0000-4000-8000-0000000000a1';
  -- a shop's price list (prices including VAT, agorot)
  shop constant jsonb := '[
    {"name":"טיפול פנים קלאסי","unit":28000},{"name":"טיפול פנים מתקדם","unit":42000},{"name":"פילינג","unit":19000},
    {"name":"עיצוב גבות","unit":7000},{"name":"הסרת שיער - שוקיים","unit":16000},{"name":"מניקור","unit":9000},
    {"name":"פדיקור","unit":12000},{"name":"קרם לחות 50 מל","unit":14900},{"name":"סרום ויטמין C","unit":21990},
    {"name":"מסכה לפנים","unit":5990},{"name":"שמן גוף","unit":8900},{"name":"כרטיס מתנה","unit":30000},
    {"name":"עיסוי 60 דקות","unit":32000},{"name":"ייעוץ עור","unit":15000}]';
  -- business to business (prices before VAT, agorot)
  b2b constant jsonb := '[
    {"name":"סדנת הדרכה לצוות","unit":240000},{"name":"ייעוץ עסקי - שעה","unit":45000},{"name":"חבילת טיפולים לעובדים","unit":380000},
    {"name":"ערכת מוצרים לסלון","unit":125000},{"name":"הרצאה","unit":300000},{"name":"שעת עבודה","unit":28000},
    {"name":"ערכת דוגמיות","unit":8550},{"name":"אחזקה חודשית","unit":90000}]';
  people constant jsonb := '[
    {"n":"נועה לוי","p":"050-0000001"},{"n":"מיכל כהן","p":"050-0000002"},{"n":"שירה אברהם","p":"050-0000003"},
    {"n":"רונית פרץ","p":"050-0000004"},{"n":"יעל מזרחי","p":"050-0000005"},{"n":"אורית ביטון","p":"050-0000006"},
    {"n":"תמר דהן","p":"050-0000007"},{"n":"הילה אוחיון","p":"050-0000008"},{"n":"גלית שלום","p":"050-0000009"},
    {"n":"דניאל חדד","p":"050-0000010"},{"n":"עדי גבאי","p":"050-0000011"},{"n":"ליאת אזולאי","p":"050-0000012"}]';
  firms constant jsonb := '[
    {"n":"סטודיו אור בע\"מ","d":"000000018","s":"הנביאים 12","c":"ירושלים","p":"03-0000001"},
    {"n":"מרכז יופי השרון בע\"מ","d":"000000026","s":"ויצמן 40","c":"כפר סבא","p":"03-0000002"},
    {"n":"קליניקה גליל בע\"מ","d":"000000034","s":"החרושת 5","c":"כרמיאל","p":"03-0000003"},
    {"n":"רשת ספא דרום בע\"מ","d":"000000042","s":"שדרות רגר 100","c":"באר שבע","p":"03-0000004"},
    {"n":"עמותת נשים למען נשים","d":"000000059","s":"הרצל 7","c":"רחובות","p":"03-0000005"},
    {"n":"דנה כהן עיצוב שיער","d":"000000067","s":"הגפן 3","c":"חיפה","p":"03-0000006"},
    {"n":"יוסי מזרחי עיצובים","d":"000000075","s":"העצמאות 22","c":"אשדוד","p":"03-0000007"},
    {"n":"אחים לוי שותפות","d":"000000083","s":"המלאכה 9","c":"נתניה","p":"03-0000008"},
    {"n":"פארם פלוס בע\"מ","d":"000000091","s":"דרך השלום 53","c":"תל אביב-יפו","p":"03-0000009"}]';
  rate constant numeric := 18;
  d date; k int; j int; nn int; hh int; c int; key text; items jsonb; cust jsonb; calc jsonb; pay jsonb; row jsonb; kind text;
  r record; bal numeric; amt bigint; nrec int; fin date; ref text;
begin
  -- a second run: the business already has its documents — nothing more
  if exists (select 1 from public.documents x where x.business_id = B) then
    raise notice 'ita-demo: already seeded — nothing added';
    return;
  end if;

  for d in select g::date from generate_series(date '2026-06-01', date '2026-10-31', interval '1 day') g loop
    continue when extract(isodow from d) = 6;   -- closed on Saturday

    -- ======== the day's new documents ========
    -- 305: one or two tax invoices to business customers (prices before VAT, net 30)
    for k in 1..(case when pg_temp.ita_h('305:' || d) % 10 = 0 then 0 when pg_temp.ita_h('305:' || d) % 4 = 0 then 2 else 1 end) loop
      key := format('direct:ita-demo-%s-305-%s', to_char(d, 'YYYYMMDD'), k); hh := pg_temp.ita_h(key);
      items := '[]'; nn := 2 + hh % 4;
      for j in 1..nn loop
        items := items || jsonb_build_array(b2b->(pg_temp.ita_h(key || ':' || j) % 8)
          || jsonb_build_object('qty', case when pg_temp.ita_h(key || ':q' || j) % 4 = 0 then 1.5 + pg_temp.ita_h(key || ':q' || j) % 3 else 1 end));
      end loop;
      cust := firms->(hh % 9);
      calc := pg_temp.ita_compute(items, false, case when hh % 6 = 0 then 5 else 0 end, rate);
      perform pg_temp.ita_issue(key, calc || jsonb_build_object('doc_type', 305, 'doc_date', d, 'due_date', d + 30,
        'customer_name', cust->>'n', 'customer_dealer', cust->>'d', 'customer_street', cust->>'s', 'customer_city', cust->>'c',
        'customer_phone', cust->>'p', 'payments', '[]'::jsonb));
    end loop;

    -- 300: a transaction invoice every third day or so (paid later by a 320, cancelled, or left open)
    if pg_temp.ita_h('300:' || d) % 3 = 0 then
      key := format('direct:ita-demo-%s-300-1', to_char(d, 'YYYYMMDD')); hh := pg_temp.ita_h(key);
      items := '[]'; nn := 1 + hh % 3;
      for j in 1..nn loop items := items || jsonb_build_array(b2b->(pg_temp.ita_h(key || ':' || j) % 8) || '{"qty":1}'); end loop;
      cust := case when hh % 3 = 0 then (people->(hh % 12)) || jsonb_build_object('d', '', 's', '', 'c', '') else firms->(hh % 9) end;
      calc := pg_temp.ita_compute(items, false, 0, rate);
      perform pg_temp.ita_issue(key, calc || jsonb_build_object('doc_type', 300, 'doc_date', d, 'due_date', d + 14,
        'customer_name', cust->>'n', 'customer_dealer', cust->>'d', 'customer_street', cust->>'s', 'customer_city', cust->>'c',
        'customer_phone', cust->>'p', 'payments', '[]'::jsonb));
    end if;

    -- 320: two or three sales of the shop (prices including VAT), paid on the spot
    for k in 1..(2 + pg_temp.ita_h('320:' || d) % 2) loop
      key := format('direct:ita-demo-%s-320-%s', to_char(d, 'YYYYMMDD'), k); hh := pg_temp.ita_h(key);
      items := '[]'; nn := 1 + hh % 4;
      for j in 1..nn loop
        items := items || jsonb_build_array(shop->(pg_temp.ita_h(key || ':' || j) % 14)
          || jsonb_build_object('qty', case when pg_temp.ita_h(key || ':q' || j) % 5 = 0 then 2 else 1 end));
      end loop;
      cust := case when hh % 5 = 0 then '{"n":"","p":"","d":"","s":"","c":""}'::jsonb          -- a walk-in customer
                   when hh % 7 = 0 then firms->(hh % 9)                                         -- a business, with its ע.מ / ח.פ
                   else (people->(hh % 12)) || jsonb_build_object('d', '', 's', '', 'c', '') end;
      calc := pg_temp.ita_compute(items, true, case when hh % 10 = 1 then 10 else 0 end, rate);
      c := (hh / 7) % 100;
      kind := case when c < 30 then 'cash' when c < 58 then 'card' when c < 66 then 'transfer' when c < 74 then 'cheque'
                   when c < 82 then 'bit' when c < 86 then 'other' when c < 94 then 'cash_card' else 'cheque_cash' end;
      pay := pg_temp.ita_pay(kind, round((calc->>'total')::numeric * 100)::bigint, d, key || ':pay');
      perform pg_temp.ita_issue(key, calc || jsonb_build_object('doc_type', 320, 'doc_date', d,
        'customer_name', cust->>'n', 'customer_dealer', cust->>'d', 'customer_street', cust->>'s', 'customer_city', cust->>'c',
        'customer_phone', cust->>'p', 'payments', pay));
    end loop;

    -- ======== what follows earlier documents (credits, receipts, cancellations) ========
    -- (only documents of the last 60 days are looked at: every follow-up comes within 20 days, a receipt issued again a day later)
    -- 330 on a 320: about 1 in 11 — a full mirror (creditFor) or half of it (one line, VAT inside), 1–4 days later
    for r in select x.* from public.documents x
              where x.business_id = B and x.doc_date >= d - 60 and x.doc_type = 320 and x.paid_document_id is null
                and pg_temp.ita_h(x.idempotency_key || ':credit') % 100 < 9
                and x.doc_date + 1 + pg_temp.ita_h(x.idempotency_key || ':credit') / 100 % 4 <= d
                and not exists (select 1 from public.documents c where c.business_id = B and c.doc_type = 330
                                  and c.base_doc_type = 320 and c.base_doc_number = x.doc_number)
              order by x.doc_number loop
      key := format('credit:%s:1', r.id);
      ref := format('חשבונית מס / קבלה מס׳ %s', r.doc_number);
      if pg_temp.ita_h(r.idempotency_key || ':credit') % 100 < 5 then
        row := jsonb_build_object('lines', r.lines, 'before_discount', r.before_discount, 'discount', r.discount, 'after_discount', r.after_discount,
                                  'vat_amount', r.vat_amount, 'total', r.total, 'vat_rate', r.vat_rate, 'notes', 'ביטול עסקה - החזר ללקוח');
      else
        amt := round(r.total * 50)::bigint;   -- half, in agorot
        calc := pg_temp.ita_compute(jsonb_build_array(jsonb_build_object('name', 'זיכוי — ' || ref, 'qty', 1, 'unit', amt)), true, 0, r.vat_rate);
        row := calc || jsonb_build_object('notes', 'פיצוי ללקוח על טיפול חלקי');
      end if;
      perform pg_temp.ita_issue(key, row || jsonb_build_object('doc_type', 330, 'doc_date', d, 'base_doc_type', 320, 'base_doc_number', r.doc_number,
        'customer_name', r.customer_name, 'customer_phone', r.customer_phone, 'customer_dealer', r.customer_dealer,
        'customer_street', r.customer_street, 'customer_city', r.customer_city, 'payments', '[]'::jsonb));
    end loop;

    -- 330 on a 305: about 1 in 12 — a fifth of it (a discount after the fact), two days later, before it is paid
    for r in select x.* from public.documents x
              where x.business_id = B and x.doc_date >= d - 60 and x.doc_type = 305 and pg_temp.ita_h(x.idempotency_key) % 100 < 8 and x.doc_date + 2 <= d
                and not exists (select 1 from public.documents c where c.business_id = B and c.doc_type = 330
                                  and c.base_doc_type = 305 and c.base_doc_number = x.doc_number)
              order by x.doc_number loop
      key := format('credit:%s:1', r.id);
      amt := round(r.total * 20)::bigint;
      calc := pg_temp.ita_compute(jsonb_build_array(jsonb_build_object('name', format('זיכוי — חשבונית מס מס׳ %s', r.doc_number), 'qty', 1, 'unit', amt)),
                                  true, 0, r.vat_rate);
      perform pg_temp.ita_issue(key, calc || jsonb_build_object('doc_type', 330, 'doc_date', d, 'base_doc_type', 305, 'base_doc_number', r.doc_number,
        'customer_name', r.customer_name, 'customer_phone', r.customer_phone, 'customer_dealer', r.customer_dealer,
        'customer_street', r.customer_street, 'customer_city', r.customer_city, 'notes', 'הנחה בדיעבד', 'payments', '[]'::jsonb));
    end loop;

    -- 300: 15% cancelled the next day (issued by mistake, never paid); 55% paid whole by a 320 (composeReceipt) 3–12 days later
    for r in select x.* from public.documents x
              where x.business_id = B and x.doc_date >= d - 60 and x.doc_type = 300 and pg_temp.ita_h(x.idempotency_key) % 100 between 55 and 69 and x.doc_date + 1 <= d
                and not exists (select 1 from public.document_cancellations c where c.document_id = x.id)
              order by x.doc_number loop
      insert into public.document_cancellations (document_id, business_id, user_id, reason)
        values (r.id, B, U, 'הופקה בטעות - העסקה לא בוצעה');
    end loop;
    for r in select x.* from public.documents x
              where x.business_id = B and x.doc_date >= d - 60 and x.doc_type = 300 and pg_temp.ita_h(x.idempotency_key) % 100 < 55
                and x.doc_date + 3 + pg_temp.ita_h(x.idempotency_key) / 100 % 10 <= d
                and not exists (select 1 from public.document_cancellations c where c.document_id = x.id)
                and not exists (select 1 from public.documents p where p.paid_document_id = x.id)
              order by x.doc_number loop
      c := pg_temp.ita_h(r.idempotency_key || ':pay') % 100;
      kind := case when c < 40 then 'transfer' when c < 65 then 'cheque' when c < 85 then 'card' else 'cash' end;
      pay := pg_temp.ita_pay(kind, round(r.total * 100)::bigint, d, r.idempotency_key || ':pay');
      perform pg_temp.ita_issue(format('receipt:%s:1', r.id), jsonb_build_object('doc_type', 320, 'doc_date', d, 'paid_document_id', r.id,
        'lines', r.lines, 'before_discount', r.before_discount, 'discount', r.discount, 'after_discount', r.after_discount,
        'vat_amount', r.vat_amount, 'total', r.total, 'vat_rate', r.vat_rate, 'notes', format('על פי חשבונית עסקה מס׳ %s', r.doc_number),
        'customer_name', r.customer_name, 'customer_phone', r.customer_phone, 'customer_dealer', r.customer_dealer,
        'customer_street', r.customer_street, 'customer_city', r.customer_city, 'payments', pay));
    end loop;

    -- 400 on a 305 (composeReceipt). By the invoice: <8 credited, then paid at +10; 8–84 paid whole at +5..+19;
    -- 85–94 in two parts (40% at +4, the rest at +18); 95–99 left open. A cancelled receipt is issued again the next day.
    for r in select x.*, pg_temp.ita_h(x.idempotency_key) % 100 as cls,
                    x.doc_date + case when pg_temp.ita_h(x.idempotency_key) % 100 < 8 then 10
                                      when pg_temp.ita_h(x.idempotency_key) % 100 < 85 then 5 + pg_temp.ita_h(x.idempotency_key) / 100 % 15
                                      else 18 end as final_day
               from public.documents x
              where x.business_id = B and x.doc_date >= d - 60 and x.doc_type = 305 and pg_temp.ita_h(x.idempotency_key) % 100 < 95 and x.doc_date + 4 <= d
              order by x.doc_number loop
      bal := pg_temp.ita_balance(r.id);
      continue when bal <= 0;
      select count(*) into nrec from public.documents p where p.paid_document_id = r.id;
      if r.final_day <= d then
        amt := round(bal * 100)::bigint;
      elsif r.cls >= 85 and nrec = 0 then
        amt := round(bal * 40)::bigint;   -- the first part, 40%
      else
        continue;
      end if;
      key := format('receipt:%s:%s', r.id, nrec + 1);
      c := pg_temp.ita_h(r.idempotency_key || ':pay:' || (nrec + 1)) % 100;
      kind := case when c < 45 then 'transfer' when c < 70 then 'cheque' when c < 80 then 'card' when c < 85 then 'cash'
                   when c < 93 then 'withholding' else 'other' end;
      pay := pg_temp.ita_pay(kind, amt, d, r.idempotency_key || ':pay:' || (nrec + 1));
      ref := format('חשבונית מס מס׳ %s', r.doc_number);
      perform pg_temp.ita_issue(key, jsonb_build_object('doc_type', 400, 'doc_date', d, 'paid_document_id', r.id,
        'lines', jsonb_build_array(jsonb_build_object('name', 'תשלום עבור ' || ref, 'qty', 1, 'unitPriceExVat', round(amt / 100.0, 2),
                                                       'discountExVat', 0, 'totalExVat', round(amt / 100.0, 2), 'vatRate', 0, 'kind', 1)),
        'before_discount', round(amt / 100.0, 2), 'discount', 0, 'after_discount', round(amt / 100.0, 2), 'vat_amount', 0,
        'total', round(amt / 100.0, 2), 'vat_rate', 0,
        'customer_name', r.customer_name, 'customer_phone', r.customer_phone, 'customer_dealer', r.customer_dealer,
        'customer_street', r.customer_street, 'customer_city', r.customer_city, 'payments', pay));
    end loop;

    -- a receipt issued by mistake (about 1 in 20): cancelled the same day — its money goes back, the invoice is open again
    for r in select p.id from public.documents p join public.documents inv on inv.id = p.paid_document_id
              where p.business_id = B and p.doc_type = 400 and p.doc_date = d
                and pg_temp.ita_h(inv.idempotency_key || ':cancel:' || split_part(p.idempotency_key, ':', 3)) % 100 < 5
                and not exists (select 1 from public.document_cancellations c where c.document_id = p.id)
              order by p.doc_number loop
      insert into public.document_cancellations (document_id, business_id, user_id, reason)
        values (r.id, B, U, 'קבלה הופקה בטעות - סכום שגוי');
    end loop;
  end loop;
end $$;

commit;
