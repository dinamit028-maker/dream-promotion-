-- ============================================================================================================================
-- Migration 20261011005100 — manual journal entries, one-sided (T13א of docs/FINANCE_ADDITIONS_HE.md); 2.96.0.
-- Prepared only: NOT applied to the live database (needs the owner's explicit approval). Runs after 20261011004900 (the reports)
-- and 20261011004800 (the comparison of locations): it stops at the top without them, changing nothing. The word delete is in it
-- (the append-only trigger and the grants) — run it in the SQL Editor (the MCP stops on it). Tested on a local Postgres:
-- tests/sql/journal.check.sql, tests/sql/concurrency.sh §21 and tests/sql/stock-compare.sh 5100 (a business with no entry: the same
-- day, the same numbers).
--
--   1. the entries   journal_entries: a movement no document made — a correction, a provision, a move between kinds — with its
--                    date, kind (income / expense / VAT / other), amount before VAT, VAT (and for a VAT entry: on sales or on
--                    inputs), an expense's category, an explanation (required), its location, and — when it belongs to someone —
--                    a customer (a CRM card or a name) or a supplier. Numbered per business; its id chosen by the screen (a second
--                    try is the same entry). Never changed and never removed: a mistake is undone by a reversing entry (the same
--                    entry with the opposite sign, once, with a reason). Closed books hold: no entry dated in them. Every entry and
--                    every reversal is in the audit log.
--   2. who           only the business's owners (role owner, full access, every location) record or reverse an entry — an
--                    accountant the system admin added as a member is one; everybody who sees the money reads them (the
--                    location picked at the top, as the ledger); a cashier never.
--   3. the reports   the entries are in the money summary (income, expenses, the VAT working paper, profit and the months —
--                    finance_summary, marked apart as "manual"), in income by customer, sales by item (a line of their own),
--                    suppliers and kinds of expense, a customer's or a supplier's card ("פקודה ידנית") and the comparison of
--                    locations — every report's total stays the money screens' number.
-- No row is removed and no existing row is changed. The rollback is a comment at the end.
-- ============================================================================================================================

-- ---- 0. after 20261011004900 and 20261011004800 ------------------------------------------------------------------------------------
do $$ begin
  if to_regprocedure('public.report_business(date, date)') is null then
    raise exception 'migration 20261011005100 runs after 20261011004900 (the reports) — run that one first; nothing was changed';
  end if;
  if to_regprocedure('public.location_compare(date, date)') is null then
    raise exception 'migration 20261011005100 runs after 20261011004800 (the comparison of locations) — run that one first; nothing was changed';
  end if;
end $$;

-- ---- 1. the entries --------------------------------------------------------------------------------------------------------------
create table if not exists public.journal_entries (
  id            uuid primary key,                                            -- chosen by the screen: a second try is the same entry
  business_id   uuid not null references public.businesses on delete restrict,
  location_id   uuid not null,
  number        int  not null check (number > 0),
  entry_date    date not null,
  kind          text not null check (kind in ('income', 'expense', 'vat', 'other')),
  amount        numeric(14,2) not null default 0 check (abs(amount) <= 100000000),   -- before VAT; a reversal is negative
  vat           numeric(14,2) not null default 0 check (abs(vat) <= 100000000),
  vat_side      text check (vat_side in ('output', 'input')),                -- income: on sales; expense: on inputs; a VAT entry: either
  category      text check (category ~ '^[a-z_]{2,30}$'),                   -- an expense's kind (expenses.category's)
  explanation   text not null check (length(btrim(explanation)) between 2 and 500),
  party_kind    text check (party_kind in ('customer', 'supplier')),
  lead_id       uuid references public.leads on delete restrict,
  party_name    text not null default '' check (length(party_name) <= 120),
  party_dealer  text not null default '' check (party_dealer = '' or party_dealer ~ '^[0-9]{9}$'),
  reverses      uuid unique,                                                 -- the entry this one undoes (once)
  user_id       uuid references auth.users on delete set null,
  created_at    timestamptz not null default now(),
  unique (business_id, number),
  unique (id, business_id),
  check (amount <> 0 or vat <> 0),
  check (case kind when 'income'  then vat_side = 'output' and category is null
                   when 'expense' then vat_side = 'input' and category is not null
                   when 'vat'     then vat_side is not null and amount = 0 and category is null and party_kind is null
                   else vat_side is null and vat = 0 and category is null end),
  check (party_kind is null or (party_kind = 'customer' and kind in ('income', 'other')) or (party_kind = 'supplier' and kind in ('expense', 'other'))),
  check ((party_kind is null) = (lead_id is null and party_name = '' and party_dealer = '')),
  check (lead_id is null or party_kind = 'customer'),
  foreign key (location_id, business_id) references public.business_locations (id, business_id) on delete restrict,
  foreign key (reverses, business_id) references public.journal_entries (id, business_id) on delete restrict
);
create index if not exists journal_entries_business_idx on public.journal_entries (business_id, entry_date);
create index if not exists journal_entries_lead_idx on public.journal_entries (business_id, lead_id) where lead_id is not null;
create or replace trigger journal_entries_append_only before update or delete on public.journal_entries
  for each row execute function public.finance_append_only();

-- ---- 2. who records them ---------------------------------------------------------------------------------------------------------
-- the business's owners: role owner with full access in every location (the system admin adds an accountant as such a member)
create or replace function public.journal_writer() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.business_members m
                  where m.user_id = auth.uid() and m.business_id = public.current_business_id()
                    and m.role = 'owner' and m.access = 'full' and m.locations is null);
$$;

-- a new entry. p_party: null, or {kind: 'customer' | 'supplier', leadId?, name?, dealer?}
create or replace function public.journal_entry_create(p_id uuid, p_date date, p_kind text, p_amount numeric, p_vat numeric, p_vat_side text,
  p_category text, p_explanation text, p_location uuid default null, p_party jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  b uuid := public.finance_guard(); e record; ent text; vat_on boolean; lock_end date; loc uuid; num int;
  amt numeric := coalesce(p_amount, 0); v numeric := coalesce(p_vat, 0); side text; cat text; expl text := btrim(coalesce(p_explanation, ''));
  pk text; lead uuid; pname text := ''; pdealer text := '';
begin
  if not public.can_write() or not public.journal_writer() then
    raise exception 'journal_not_allowed: only the business''s owners record a manual entry' using errcode = '42501'; end if;
  if not public.business_is_active(b) then raise exception 'business_locked' using errcode = '42501'; end if;
  if p_id is null then raise exception 'journal_id: a new entry has an id' using errcode = '22023'; end if;
  -- one entry of the business at a time: its number, the same id twice
  perform pg_advisory_xact_lock(hashtextextended('journal:' || b::text, 0));
  select * into e from public.journal_entries where id = p_id;
  if e.id is not null then
    if e.business_id <> b then raise exception 'not allowed' using errcode = '42501'; end if;
    return jsonb_build_object('id', e.id, 'number', e.number, 'created', false);
  end if;
  if p_date is null or p_date > public.il_today() or p_date < date '2000-01-01' then
    raise exception 'journal_date: an entry is dated today or before' using errcode = '22023'; end if;
  lock_end := public.finance_locked_until(b);
  if lock_end is not null and p_date <= lock_end then raise exception 'period_locked: the books are closed until %', lock_end using errcode = '23514'; end if;
  if p_kind is null or p_kind not in ('income', 'expense', 'vat', 'other') then
    raise exception 'journal_kind: income, expense, VAT or other' using errcode = '22023'; end if;
  if amt <> round(amt, 2) or v <> round(v, 2) or abs(amt) > 100000000 or abs(v) > 100000000 then
    raise exception 'journal_amount: an amount of money (agorot)' using errcode = '22023'; end if;
  if amt = 0 and v = 0 then raise exception 'journal_amount: an amount or VAT' using errcode = '22023'; end if;
  select public.entity_of(s.entity_type, s.business_type) into ent from public.register_settings s where s.business_id = b;
  vat_on := public.entity_charges_vat(coalesce(ent, 'licensed_dealer'));
  if v <> 0 and not vat_on then raise exception 'journal_vat: an exempt dealer records no VAT' using errcode = '22023'; end if;
  side := case p_kind when 'income' then 'output' when 'expense' then 'input' when 'vat' then p_vat_side end;
  if p_kind = 'vat' and (side is null or side not in ('output', 'input')) then
    raise exception 'journal_vat_side: VAT on sales or on inputs' using errcode = '22023'; end if;
  if p_kind = 'vat' and (amt <> 0 or v = 0) then raise exception 'journal_vat: a VAT entry is VAT only' using errcode = '22023'; end if;
  if p_kind = 'other' and v <> 0 then raise exception 'journal_vat: an "other" entry carries no VAT' using errcode = '22023'; end if;
  cat := case when p_kind = 'expense' then coalesce(nullif(btrim(coalesce(p_category, '')), ''), 'other') end;
  if cat is not null and cat !~ '^[a-z_]{2,30}$' then raise exception 'journal_category: a kind of expense' using errcode = '22023'; end if;
  if length(expl) < 2 or length(expl) > 500 then raise exception 'journal_explanation: an explanation, 2 to 500 letters' using errcode = '22023'; end if;
  -- whom it belongs to (none is fine): a customer — a CRM card of the business or a name; a supplier — a name; a dealer number
  if p_party is not null and jsonb_typeof(p_party) = 'object' and p_party <> '{}'::jsonb then
    pk := p_party->>'kind';
    if p_kind = 'vat' or pk is null or pk not in ('customer', 'supplier') or (pk = 'customer' and p_kind = 'expense') or (pk = 'supplier' and p_kind = 'income') then
      raise exception 'journal_party: a customer on income, a supplier on an expense, either on "other" — none on VAT' using errcode = '22023'; end if;
    if pk = 'customer' and coalesce(p_party->>'leadId', '') <> '' then
      if (p_party->>'leadId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'journal_party: a customer card of the business' using errcode = '22023'; end if;
      lead := (p_party->>'leadId')::uuid;
      select left(coalesce(l.name, ''), 120) into pname from public.leads l where l.id = lead and l.business_id = b;
      if not found then raise exception 'journal_party: a customer card of the business' using errcode = '22023'; end if;
    else
      pname := left(btrim(coalesce(p_party->>'name', '')), 120);
    end if;
    pdealer := btrim(coalesce(p_party->>'dealer', ''));
    if pdealer <> '' and pdealer !~ '^[0-9]{9}$' then raise exception 'journal_party: a dealer number is 9 digits' using errcode = '22023'; end if;
    if lead is null and length(coalesce(pname, '')) < 2 and pdealer = '' then
      raise exception 'journal_party: a name or a dealer number' using errcode = '22023'; end if;
  end if;
  -- where: the location chosen, else the one picked at the top (else the main one) — an active location of the business
  loc := coalesce(p_location, public.location_pick(b));
  if loc is null or not exists (select 1 from public.business_locations l where l.id = loc and l.business_id = b and l.active) then
    raise exception 'journal_location: an active location of the business' using errcode = '22023'; end if;
  select coalesce(max(j.number), 0) + 1 into num from public.journal_entries j where j.business_id = b;
  insert into public.journal_entries (id, business_id, location_id, number, entry_date, kind, amount, vat, vat_side, category, explanation,
                                      party_kind, lead_id, party_name, party_dealer, user_id)
  values (p_id, b, loc, num, p_date, p_kind, amt, v, side, cat, expl, pk, lead, coalesce(pname, ''), pdealer, auth.uid());
  perform public.finance_log(b, 'journal.created', 'journal_entries', p_id::text, jsonb_build_object(
    'number', num, 'date', p_date, 'kind', p_kind, 'amount', amt, 'vat', v, 'vatSide', side, 'category', cat, 'location', loc,
    'party', case when pk is null then null else jsonb_build_object('kind', pk, 'leadId', lead, 'name', coalesce(pname, ''), 'dealer', pdealer) end,
    'explanation', expl));
  return jsonb_build_object('id', p_id, 'number', num, 'created', true);
end $$;

-- undo an entry: the same entry with the opposite sign — once, with a reason, dated on or after it and not in closed books
create or replace function public.journal_entry_reverse(p_id uuid, p_entry uuid, p_date date, p_explanation text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  b uuid := public.finance_guard(); e record; o record; lock_end date; num int; d date := coalesce(p_date, public.il_today());
  expl text := btrim(coalesce(p_explanation, ''));
begin
  if not public.can_write() or not public.journal_writer() then
    raise exception 'journal_not_allowed: only the business''s owners record a manual entry' using errcode = '42501'; end if;
  if not public.business_is_active(b) then raise exception 'business_locked' using errcode = '42501'; end if;
  if p_id is null then raise exception 'journal_id: a new entry has an id' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('journal:' || b::text, 0));
  select * into e from public.journal_entries where id = p_id;
  if e.id is not null then
    if e.business_id <> b or e.reverses is distinct from p_entry then raise exception 'not allowed' using errcode = '42501'; end if;
    return jsonb_build_object('id', e.id, 'number', e.number, 'created', false);
  end if;
  select * into o from public.journal_entries where id = p_entry and business_id = b;
  if o.id is null then raise exception 'journal_entry: the entry was not found in this business' using errcode = '22023'; end if;
  if o.reverses is not null then
    raise exception 'journal_reverse: a reversing entry is not reversed — record a new entry instead' using errcode = '23514'; end if;
  if exists (select 1 from public.journal_entries x where x.reverses = o.id) then
    raise exception 'journal_reversed: the entry was already reversed' using errcode = '23514'; end if;
  if d > public.il_today() or d < o.entry_date then raise exception 'journal_date: a reversal is dated on or after its entry, today or before' using errcode = '22023'; end if;
  lock_end := public.finance_locked_until(b);
  if lock_end is not null and d <= lock_end then raise exception 'period_locked: the books are closed until %', lock_end using errcode = '23514'; end if;
  if length(expl) < 2 or length(expl) > 500 then raise exception 'journal_explanation: an explanation, 2 to 500 letters' using errcode = '22023'; end if;
  if not exists (select 1 from public.business_locations l where l.id = o.location_id and l.business_id = b) then
    raise exception 'journal_location: an active location of the business' using errcode = '22023'; end if;
  select coalesce(max(j.number), 0) + 1 into num from public.journal_entries j where j.business_id = b;
  insert into public.journal_entries (id, business_id, location_id, number, entry_date, kind, amount, vat, vat_side, category, explanation,
                                      party_kind, lead_id, party_name, party_dealer, reverses, user_id)
  values (p_id, b, o.location_id, num, d, o.kind, -o.amount, -o.vat, o.vat_side, o.category, expl,
          o.party_kind, o.lead_id, o.party_name, o.party_dealer, o.id, auth.uid());
  perform public.finance_log(b, 'journal.reversed', 'journal_entries', p_id::text, jsonb_build_object(
    'number', num, 'reverses', o.number, 'date', d, 'kind', o.kind, 'amount', -o.amount, 'vat', -o.vat, 'explanation', expl));
  return jsonb_build_object('id', p_id, 'number', num, 'created', true, 'reverses', o.number);
end $$;

revoke execute on function public.journal_writer(), public.journal_entry_create(uuid, date, text, numeric, numeric, text, text, text, uuid, jsonb),
  public.journal_entry_reverse(uuid, uuid, date, text) from public, anon;
grant execute on function public.journal_writer(), public.journal_entry_create(uuid, date, text, numeric, numeric, text, text, text, uuid, jsonb),
  public.journal_entry_reverse(uuid, uuid, date, text) to authenticated;

-- the screens read the entries (never a cashier, never a business whose money is closed to the caller, the location picked at the
-- top); only the two functions above write them
do $$
declare
  t constant text := 'journal_entries';
  gate        constant text := 'business_id = (select public.current_business_id()) and business_id in (select public.accessible_business_ids())';
  fin         constant text := 'business_id in (select public.finance_business_ids())';
  full_access constant text := '(select public.my_access()) <> ''register''';
  locs        constant text := '(select public.location_filter()) is null or location_id = any ((select public.location_filter())::uuid[])';
begin
  execute format('alter table public.%I enable row level security', t);
  execute format('revoke all on public.%I from anon', t);
  execute format('revoke insert, update, delete, truncate on public.%I from authenticated', t);
  execute format('grant select on public.%I to authenticated', t);
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_business_gate') then
    execute format('create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)', t || '_business_gate', t, gate, gate);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_finance_privacy') then
    execute format('create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)', t || '_finance_privacy', t, fin, fin);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_cashier_none') then
    execute format('create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)', t || '_cashier_none', t, full_access, full_access);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_location_gate') then
    execute format('create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)', t || '_location_gate', t, locs, locs);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_business_read') then
    execute format('create policy %I on public.%I for select to authenticated using (%s)', t || '_business_read', t, gate);
  end if;
end $$;

-- ---- 3. the reports: the entries in the money summary, the reports and the comparison of locations ---------------------------
-- the money summary (20261011004900's): the manual entries in the income, the expenses, the VAT, the profit and the months — and
-- apart, as "manual"
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
    -- 2.96 (T13א): a manual expense entry is in its kind of expense (its VAT on inputs, deductible as recorded) — not in the count
    select category, sum(net) as net, sum(vat) as vat, sum(deductible) as deductible, sum(total) as total, sum(n) as n from (
      select category,
             sum(case when supplier_doc_type = 'credit' then -amount_before_vat else amount_before_vat end) as net,
             sum(case when supplier_doc_type = 'credit' then -vat_amount else vat_amount end) as vat,
             sum((case when supplier_doc_type = 'credit' then -1 else 1 end) * (case when vat_on then round(vat_amount * vat_deductible_pct / 100, 2) else 0 end)) as deductible,
             sum(case when supplier_doc_type = 'credit' then -total else total end) as total, count(*) as n
        from public.expenses where business_id = b and status = 'confirmed' and doc_date between p_from and p_to group by category
      union all
      select je.category, sum(je.amount), sum(je.vat), sum(je.vat), sum(je.amount + je.vat), 0
        from public.journal_entries je where je.business_id = b and je.kind = 'expense' and je.entry_date between p_from and p_to group by je.category
    ) u group by category
  ), et as (
    select coalesce(sum(net), 0) net, coalesce(sum(vat), 0) vat, coalesce(sum(deductible), 0) deductible, coalesce(sum(total), 0) total, coalesce(sum(n), 0) n,
           coalesce(jsonb_agg(jsonb_build_object('category', category, 'net', net, 'vat', vat, 'total', total, 'count', n) order by total desc), '[]'::jsonb) as by_cat
      from e
  ), jr as (
    -- 2.96 (T13א): the manual entries of the period — income before VAT and its VAT on sales; VAT entries on sales or on inputs
    -- (the expenses are in "e" above); apart as "manual", so a screen can say how much of a number they are
    select coalesce(sum(amount) filter (where kind = 'income'), 0) as inc_net, coalesce(sum(vat) filter (where kind = 'income'), 0) as inc_vat,
           coalesce(sum(amount) filter (where kind = 'expense'), 0) as exp_net, coalesce(sum(vat) filter (where kind = 'expense'), 0) as exp_vat,
           coalesce(sum(vat) filter (where kind = 'vat' and vat_side = 'output'), 0) as vat_out,
           coalesce(sum(vat) filter (where kind = 'vat' and vat_side = 'input'), 0) as vat_in, count(*) as n
      from public.journal_entries where business_id = b and entry_date between p_from and p_to
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
                           from d where to_char(d.doc_date, 'YYYY-MM') = to_char(m, 'YYYY-MM'))
                        + (select coalesce(sum(je.amount), 0) from public.journal_entries je where je.business_id = b and je.kind = 'income'
                             and je.entry_date between p_from and p_to and to_char(je.entry_date, 'YYYY-MM') = to_char(m, 'YYYY-MM')),
             'expenses', (select coalesce(sum((case when supplier_doc_type = 'credit' then -1 else 1 end)
                                              * (amount_before_vat + vat_amount - case when vat_on then round(vat_amount * vat_deductible_pct / 100, 2) else 0 end)), 0)
                            from public.expenses x where x.business_id = b and x.status = 'confirmed' and x.doc_date between p_from and p_to
                              and to_char(x.doc_date, 'YYYY-MM') = to_char(m, 'YYYY-MM'))
                       + (select coalesce(sum(je.amount), 0) from public.journal_entries je where je.business_id = b and je.kind = 'expense'
                            and je.entry_date between p_from and p_to and to_char(je.entry_date, 'YYYY-MM') = to_char(m, 'YYYY-MM'))) order by m) as j
      from generate_series(date_trunc('month', p_from::timestamp), date_trunc('month', p_to::timestamp), interval '1 month') m
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'entity', ent, 'vat', vat_on,
    'revenue', jsonb_build_object('net', rev.net + jr.inc_net, 'vat', rev.vat + jr.inc_vat + jr.vat_out,
                                  'gross', rev.net + jr.inc_net + rev.vat + jr.inc_vat + jr.vat_out),
    'documents', types.j,
    'expenses', jsonb_build_object('net', et.net, 'vat', et.vat + jr.vat_in, 'vatDeductible', et.deductible + jr.vat_in, 'total', et.total,
                                   'count', et.n, 'byCategory', et.by_cat),
    'vatPayable', case when vat_on then (rev.vat + jr.inc_vat + jr.vat_out) - (et.deductible + jr.vat_in) else 0 end,
    'profit', (rev.net + jr.inc_net) - (et.net + et.vat - et.deductible),
    'manual', jsonb_build_object('count', jr.n, 'income', jsonb_build_object('net', jr.inc_net, 'vat', jr.inc_vat),
                                 'expense', jsonb_build_object('net', jr.exp_net, 'vat', jr.exp_vat),
                                 'vat', jsonb_build_object('output', jr.vat_out, 'input', jr.vat_in)),
    'cash', jsonb_build_object('in', cash.cin, 'out', cash.cout, 'net', cash.cin - cash.cout, 'byMethod', cash.by_method),
    'withheld', cash.withheld,
    'receivables', jsonb_build_object('open', recv.open, 'count', recv.n, 'overdue', recv.overdue, 'overdueCount', recv.overdue_n),
    'pending', jsonb_build_object('count', pend.n, 'total', pend.t),
    'posWithoutDocument', jsonb_build_object('count', nodoc.n, 'total', nodoc.t),
    'allocationMissing', alloc.n,
    'months', coalesce(months.j, '[]'::jsonb),
    'lockedUntil', public.finance_locked_until(b))
  into res from rev, types, et, jr, cash, recv, pend, nodoc, alloc, months;
  return res;
end $$;

-- income by customer (20261011004900's): the manual income entries too — the total is still the money summary's income
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
           case when vat_doc and doc_type in (305, 320) then vat_amount when vat_doc and doc_type = 330 then -vat_amount else 0 end as vat,
           0::numeric as manual
      from d where (vat_doc and doc_type in (305, 320, 330)) or (not vat_doc and doc_type = 400 and not cancelled)
    union all
    -- 2.96 (T13א): a manual income entry (and a VAT entry on sales) — by its customer, or on a line of its own ("m:") without one
    select case when j.party_kind = 'customer' then public.party_key(j.lead_id, j.party_dealer, j.party_name) else 'm:' end, j.lead_id, j.party_dealer,
           case when j.party_kind = 'customer' then j.party_name else '' end, j.entry_date, j.created_at, j.amount, j.vat, j.amount
      from public.journal_entries j
     where j.business_id = b and j.entry_date between p_from and p_to and (j.kind = 'income' or (j.kind = 'vat' and j.vat_side = 'output'))
  ), g as (
    select k, sum(net) as net, sum(vat) as vat, count(*) as n, sum(manual) as manual,
           (array_agg(lead_id order by doc_date desc, issued_at desc) filter (where lead_id is not null))[1] as lead_id,
           (array_agg(customer_dealer order by doc_date desc, issued_at desc) filter (where customer_dealer <> ''))[1] as dealer,
           (array_agg(customer_name order by doc_date desc, issued_at desc))[1] as name
      from r group by k
  )
  select jsonb_build_object('from', p_from, 'to', p_to, 'vat', vat_on,
           'total', jsonb_build_object('net', coalesce(sum(g.net), 0), 'vat', coalesce(sum(g.vat), 0), 'count', coalesce(sum(g.n), 0),
                                       'manual', coalesce(sum(g.manual), 0)),
           'customers', coalesce(jsonb_agg(jsonb_build_object('key', g.k, 'leadId', g.lead_id, 'name', coalesce(ld.name, g.name, ''), 'dealer', coalesce(g.dealer, ''),
             'net', g.net, 'vat', g.vat, 'gross', g.net + g.vat, 'count', g.n, 'manual', g.manual) order by g.net desc, coalesce(ld.name, g.name)), '[]'::jsonb))
    into res
    from g left join public.leads ld on ld.id = g.lead_id;
  return res;
end $$;

-- sales by item (20261011004900's): the manual income entries on a line of their own — the total is still the money summary's income
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
           'total', (select coalesce(sum(amt), 0) from src)
                    + (select coalesce(sum(j.amount), 0) from public.journal_entries j where j.business_id = b and j.kind = 'income' and j.entry_date between p_from and p_to),
           -- 2.96 (T13א): the manual income entries — a line of their own (no item, no treatment type)
           'manual', (select jsonb_build_object('net', coalesce(sum(j.amount), 0), 'count', count(*)) from public.journal_entries j
                       where j.business_id = b and j.kind = 'income' and j.entry_date between p_from and p_to),
           'items', coalesce((select jsonb_agg(jsonb_build_object('key', k, 'itemId', item_id, 'variantId', variant_id,
                       'name', case when variant_id is null then coalesce(item_name, name) else name end, 'kind', coalesce(kind, ''),
                       'typeId', type_id, 'qty', qty, 'net', net) order by net desc, name) from items), '[]'::jsonb),
           'types', coalesce((select jsonb_agg(jsonb_build_object('typeId', type_id, 'name', name, 'qty', qty, 'net', net) order by net desc, name) from types), '[]'::jsonb),
           'unattributed', (select jsonb_build_object('net', net, 'count', n) from un))
    into res;
  return res;
end $$;

-- a customer's card (20261011004900's): the customer's manual entries too ("פקודה ידנית", with its explanation)
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
    union all
    -- 2.96 (T13א): a manual entry of this customer — owed more when it is positive, less when it is negative
    select j.entry_date, j.created_at, 'manual', null::int, j.number, greatest(j.amount + j.vat, 0), greatest(-(j.amount + j.vat), 0), '', j.id::text
      from public.journal_entries j
     where j.business_id = b and j.party_kind = 'customer' and public.party_key(j.lead_id, j.party_dealer, j.party_name) = p_key
  ), op as (
    select coalesce(sum(debit - credit), 0) as opening from mv where day < p_from
  ), rw as (
    select mv.*, op.opening + sum(debit - credit) over (order by day, at, kind, rid rows unbounded preceding) as balance
      from mv, op where day between p_from and p_to
  )
  select jsonb_build_object('key', p_key, 'from', p_from, 'to', p_to,
           'name', coalesce((select l.name from public.leads l where p_key like 'l:%' and l.id::text = substr(p_key, 3)),
                            (select m.customer_name from mine m order by m.doc_date desc, m.issued_at desc limit 1),
                            (select j.party_name from public.journal_entries j where j.business_id = b and j.party_kind = 'customer'
                                and public.party_key(j.lead_id, j.party_dealer, j.party_name) = p_key order by j.entry_date desc, j.created_at desc limit 1), ''),
           'opening', (select opening from op),
           'debit', coalesce((select sum(debit) from rw), 0), 'credit', coalesce((select sum(credit) from rw), 0),
           'closing', (select opening from op) + coalesce((select sum(debit - credit) from rw), 0),
           'rows', coalesce((select jsonb_agg(jsonb_build_object('date', day, 'kind', kind, 'docType', doc_type, 'docNumber', doc_number,
                     'debit', debit, 'credit', credit, 'method', method, 'balance', balance,
                     'note', case when kind = 'manual' then (select j.explanation from public.journal_entries j where j.id::text = rw.rid) else '' end)
                     order by day, at, kind, rid) from rw), '[]'::jsonb))
    into res;
  return res;
end $$;

-- suppliers and kinds of expense (20261011004900's): the manual expense entries too — in the totals, never paid and never owed
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
    select x.k, x.category, x.supplier_name, x.supplier_dealer, x.doc_date, x.created_at,
           sg * total as amount, sg * amount_before_vat as net, sg * vat_amount as vat, coalesce(pay.paid, 0) as paid, 0::numeric as manual
      from x left join pay on pay.expense_id = x.id
    union all
    -- 2.96 (T13א): a manual expense entry — by its supplier, or on a line of its own ("m:") without one; never paid, never owed
    select case when j.party_kind = 'supplier' then public.party_key(null, j.party_dealer, j.party_name) else 'm:' end, j.category,
           case when j.party_kind = 'supplier' then j.party_name else '' end, j.party_dealer, j.entry_date, j.created_at,
           j.amount + j.vat, j.amount, j.vat, 0, j.amount + j.vat
      from public.journal_entries j where j.business_id = b and j.kind = 'expense' and j.entry_date between p_from and p_to
  ), s as (
    select k, (array_agg(supplier_name order by doc_date desc, created_at desc))[1] as name,
           (array_agg(supplier_dealer order by doc_date desc, created_at desc) filter (where supplier_dealer <> ''))[1] as dealer,
           count(*) as n, sum(net) as net, sum(vat) as vat, sum(amount) as total, sum(paid) as paid, sum(manual) as manual
      from r group by k
  ), c as (
    select category, count(*) as n, sum(net) as net, sum(amount) as total, sum(paid) as paid, sum(manual) as manual from r group by category
  )
  select jsonb_build_object('from', p_from, 'to', p_to,
           'total', jsonb_build_object('net', coalesce((select sum(net) from r), 0), 'vat', coalesce((select sum(vat) from r), 0),
                                       'total', coalesce((select sum(amount) from r), 0), 'paid', coalesce((select sum(paid) from r), 0),
                                       'open', coalesce((select sum(amount - paid - manual) from r), 0), 'count', (select count(*) from r),
                                       'manual', coalesce((select sum(manual) from r), 0)),
           'suppliers', coalesce((select jsonb_agg(jsonb_build_object('key', k, 'name', coalesce(name, ''), 'dealer', coalesce(dealer, ''), 'count', n,
                           'net', net, 'vat', vat, 'total', total, 'paid', paid, 'open', total - paid - manual, 'manual', manual) order by total desc, name) from s), '[]'::jsonb),
           'categories', coalesce((select jsonb_agg(jsonb_build_object('category', category, 'count', n, 'net', net, 'total', total, 'paid', paid,
                           'open', total - paid - manual, 'manual', manual) order by total desc, category) from c), '[]'::jsonb))
    into res;
  return res;
end $$;

-- a supplier's card (20261011004900's): the supplier's manual entries too ("פקודה ידנית", with its explanation)
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
    union all
    -- 2.96 (T13א): a manual entry of this supplier — the business owes more when it is positive, less when it is negative
    select j.entry_date, j.created_at, 'manual', j.number, '', greatest(-(j.amount + j.vat), 0), greatest(j.amount + j.vat, 0), '', j.id::text
      from public.journal_entries j
     where j.business_id = b and j.party_kind = 'supplier' and public.party_key(null, j.party_dealer, j.party_name) = p_key
  ), op as (
    select coalesce(sum(credit - debit), 0) as opening from mv where day < p_from
  ), rw as (
    select mv.*, op.opening + sum(credit - debit) over (order by day, at, kind, rid rows unbounded preceding) as balance
      from mv, op where day between p_from and p_to
  )
  select jsonb_build_object('key', p_key, 'from', p_from, 'to', p_to,
           'name', coalesce((select x.supplier_name from x order by x.doc_date desc, x.created_at desc limit 1),
                            (select j.party_name from public.journal_entries j where j.business_id = b and j.party_kind = 'supplier'
                                and public.party_key(null, j.party_dealer, j.party_name) = p_key order by j.entry_date desc, j.created_at desc limit 1), ''),
           'opening', (select opening from op),
           'debit', coalesce((select sum(debit) from rw), 0), 'credit', coalesce((select sum(credit) from rw), 0),
           'closing', (select opening from op) + coalesce((select sum(credit - debit) from rw), 0),
           'rows', coalesce((select jsonb_agg(jsonb_build_object('date', day, 'kind', kind, 'number', number, 'ref', ref,
                     'debit', debit, 'credit', credit, 'method', method, 'balance', balance,
                     'note', case when kind = 'manual' then (select j.explanation from public.journal_entries j where j.id::text = rw.rid) else '' end)
                     order by day, at, kind, rid) from rw), '[]'::jsonb))
    into res;
  return res;
end $$;

-- the comparison of locations (20261011004800's): each location's manual entries in its income, expenses and profit
create or replace function public.location_compare(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare b uuid := public.current_business_id(); ent text; vat_on boolean; res jsonb;
begin
  if b is null or b not in (select public.accessible_business_ids()) or b not in (select public.finance_business_ids())
     or public.my_access() = 'register' then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 3700 then raise exception 'bad range' using errcode = '22023'; end if;
  select public.entity_of(s.entity_type, s.business_type) into ent from public.register_settings s where s.business_id = b;
  ent := coalesce(ent, 'licensed_dealer');
  vat_on := public.entity_charges_vat(ent);
  with locs as (
    select l.id, l.name, l.active, l.sort, l.created_at, (l.id = b) as main from public.business_locations l
     where l.business_id = b and public.location_allowed(b, l.id)
  ), d as (
    select coalesce(doc.location_id, doc.business_id) as loc, doc.doc_type, doc.after_discount, doc.vat_amount, doc.total,
           public.entity_charges_vat(coalesce(doc.issuer->>'entityType', ent)) as vat_doc,
           exists (select 1 from public.document_cancellations c where c.document_id = doc.id) as cancelled
      from public.documents doc where doc.business_id = b and doc.doc_date between p_from and p_to
  ), rev as (
    select loc, sum(net) as net, sum(vat) as vat from (
      select loc,
             sum(case when vat_doc and doc_type in (305, 320) then after_discount when vat_doc and doc_type = 330 then -after_discount
                      when not vat_doc and doc_type = 400 and not cancelled then total else 0 end) as net,
             sum(case when vat_doc and doc_type in (305, 320) then vat_amount when vat_doc and doc_type = 330 then -vat_amount else 0 end) as vat
        from d group by loc
      union all
      -- 2.96 (T13א): the manual income entries (and VAT entries on sales) at their location
      select j.location_id, coalesce(sum(j.amount) filter (where j.kind = 'income'), 0),
             coalesce(sum(j.vat) filter (where j.kind = 'income' or (j.kind = 'vat' and j.vat_side = 'output')), 0)
        from public.journal_entries j where j.business_id = b and j.entry_date between p_from and p_to group by 1
    ) u group by loc
  ), ex as (
    select loc, sum(net) as net, sum(cost) as cost from (
      select coalesce(x.location_id, x.business_id) as loc,
             sum(case when x.supplier_doc_type = 'credit' then -x.amount_before_vat else x.amount_before_vat end) as net,
             sum((case when x.supplier_doc_type = 'credit' then -1 else 1 end)
                 * (x.amount_before_vat + x.vat_amount - case when vat_on then round(x.vat_amount * x.vat_deductible_pct / 100, 2) else 0 end)) as cost
        from public.expenses x where x.business_id = b and x.status = 'confirmed' and x.doc_date between p_from and p_to group by 1
      union all
      -- the manual expense entries at their location (their VAT is deductible as recorded: the cost is the amount before VAT)
      select j.location_id, sum(j.amount), sum(j.amount)
        from public.journal_entries j where j.business_id = b and j.kind = 'expense' and j.entry_date between p_from and p_to group by 1
    ) u group by loc
  ), sl as (
    select coalesce(s.location_id, s.business_id) as loc, s.id, s.total, s.items, s.channel
      from public.sales s
     where s.business_id = b and s.status = 'paid'
       and (coalesce(s.paid_at, s.created_at) at time zone 'Asia/Jerusalem')::date between p_from and p_to
  ), st as (
    select loc, count(*) as n, sum(total) as total, count(*) filter (where channel = 'online') as online from sl group by loc
  ), rf as (
    select coalesce(r.location_id, r.business_id) as loc, sum(r.amount) as amount, count(*) as n from public.sale_refunds r
     where r.business_id = b and (r.created_at at time zone 'Asia/Jerusalem')::date between p_from and p_to group by 1
  ), lines as (
    -- a product (a variant on its own), or a line with no product by its name
    select sl.loc, coalesce(nullif(e->>'itemId', '') || '|' || coalesce(e->>'variantId', ''), 'name:' || coalesce(e->>'name', '')) as k,
           max(coalesce(e->>'name', '')) as name,
           max(case when coalesce(e->>'itemId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then e->>'itemId' end) as item_id,
           sum(case when coalesce(e->>'qty', '') ~ '^[0-9]+(\.[0-9]+)?$' then (e->>'qty')::numeric else 0 end) as qty,
           sum(case when coalesce(e->>'qty', '') ~ '^[0-9]+(\.[0-9]+)?$' and coalesce(e->>'price', '') ~ '^-?[0-9]+(\.[0-9]+)?$'
                    then (e->>'qty')::numeric * (e->>'price')::numeric else 0 end) as total
      from sl cross join lateral jsonb_array_elements(case when jsonb_typeof(sl.items) = 'array' then sl.items else '[]'::jsonb end) e
     group by 1, 2
  ), top as (
    select loc, jsonb_agg(jsonb_build_object('itemId', item_id, 'name', name, 'qty', qty, 'total', round(total, 2)) order by total desc, name) as j
      from (select l.*, row_number() over (partition by loc order by total desc, name) as k2 from lines l) x
     where k2 <= 10 group by loc
  ), sk as (
    -- the stock now: units (an item's own count holds its variants'), and their value at the selling price (a variant's own)
    select r.location_id as loc,
           sum(case when r.variant_id is null then r.qty else 0 end) as units,
           sum(case when r.variant_id is null and not i.has_variants then greatest(r.qty, 0) * i.price
                    when r.variant_id is not null then greatest(r.qty, 0) * coalesce(v.price, i.price) else 0 end) as value
      from public.stock_by_location_rows() r
      join public.catalog_items i on i.id = r.item_id
      left join public.catalog_variants v on v.id = r.variant_id
     group by 1
  )
  select jsonb_build_object('from', p_from, 'to', p_to, 'vat', vat_on, 'locations', coalesce(jsonb_agg(jsonb_build_object(
           'id', locs.id, 'name', locs.name, 'active', locs.active, 'main', locs.main,
           'revenue', jsonb_build_object('net', coalesce(rev.net, 0), 'vat', coalesce(rev.vat, 0)),
           'expenses', jsonb_build_object('net', coalesce(ex.net, 0), 'cost', coalesce(ex.cost, 0)),
           'profit', coalesce(rev.net, 0) - coalesce(ex.cost, 0),
           'sales', jsonb_build_object('count', coalesce(st.n, 0), 'total', coalesce(st.total, 0), 'online', coalesce(st.online, 0),
                                       'refunds', coalesce(rf.amount, 0), 'refundCount', coalesce(rf.n, 0)),
           'items', coalesce(top.j, '[]'::jsonb),
           'stock', jsonb_build_object('units', coalesce(sk.units, 0), 'value', round(coalesce(sk.value, 0), 2)))
         order by locs.main desc, locs.sort, locs.created_at), '[]'::jsonb))
    into res
    from locs left join rev on rev.loc = locs.id left join ex on ex.loc = locs.id left join st on st.loc = locs.id
         left join rf on rf.loc = locs.id left join top on top.loc = locs.id left join sk on sk.loc = locs.id;
  return res;
end $$;

-- ============================================================================================================================
-- Rollback (by hand, if ever needed — nothing that existed before is lost): run 20261011004900 again (it puts back finance_summary and
--   the six report functions without the entries) and 20261011004800's location_compare; drop the policies of journal_entries, the
--   functions journal_entry_create, journal_entry_reverse, journal_writer, the trigger journal_entries_append_only and the table
--   journal_entries (its rows are lost — keep a copy first).
-- ============================================================================================================================
