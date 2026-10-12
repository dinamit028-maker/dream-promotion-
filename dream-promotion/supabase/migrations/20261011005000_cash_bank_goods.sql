-- ============================================================================================================================
-- Migration 20261011005000 — the money desks, bank deposits, cheques and the bank's reconciliation (T9); an order, a delivery note
-- and a return note for a business that sells products (T10) — docs/FINANCE_ADDITIONS_HE.md; 2.95.0.
-- Prepared only: NOT applied to the live database (needs the owner's explicit approval). Runs after 20261011004900 (the reports):
-- it stops at the top without it, changing nothing. It drops and adds again the "doc_type in (…)" checks of documents and drafts
-- (run it in the SQL Editor: the MCP stops on the word drop). Tested on a local Postgres: tests/sql/cash-bank.check.sql,
-- tests/sql/concurrency.sh §20 and tests/sql/stock-compare.sh 5000 (a business that turns nothing on: the same rows and numbers).
--
--   1. switches     business_finance_profile.cash_drawers (the desks, deposits, cheques and the bank) and sells_products (order,
--                   delivery note, return note) — both off: nothing new is shown or issued until the owner turns them on;
--                   cheque_remind_days (a cheque in the drawer is reminded that many days before it is due; 0 = never; 3).
--   2. the desks    no new table of money: a desk is the payments ledger by method. The cash desk holds every cash payment in, less
--                   every cash payment out, less the cash the deposits took. A received cheque (a receipt's payment by cheque) is in
--                   the drawer until it is deposited, matched to the bank on its own, or its receipt is cancelled.
--   3. deposits     bank_deposits + bank_deposit_cheques: cash (an amount, never more than that location's cash desk holds) and
--                   chosen cheques of that location — one deposit for many receipts; numbered per business; its id chosen by the
--                   screen (a second try is the same deposit). Cancelled with a reason, never removed — and only while the bank has
--                   not matched it. A deposited cheque leaves the drawer; "the cheques deposited" is a report of the screen.
--   4. reminders    cheque_reminders: each cheque in the drawer is reminded once, a few days before it is due (a phone notification
--                   to the managers by the timer, 08:00–20:00, not on Saturday) — only when the desks are on.
--   5. the bank     bank_statements / bank_lines: a file of the bank's movements the owner uploaded (CSV or Excel, read by the
--                   screen) — not a connection to the bank. A line is kept once however many files carry it. bank_matches: a line ↔
--                   receipts, payments to suppliers or deposits that add up to it to the agora. The screen suggests by amount and
--                   date; nothing is matched without the owner's approval (a call per line). A line with no match stays "לטיפול"
--                   until it is matched or marked handled with a note (a bank fee). Members limited to some locations do not see it.
--   6. documents    100 הזמנה, 200 תעודת משלוח, 210 תעודת החזרה (the unified file's own codes, openformat.ts) — the same documents
--                   table, numbering (a series per type), checks, audit log and unified file. Only a business that sells products
--                   issues them, never a cashier. A delivery note takes the goods out; the invoice made from it (its base: fields
--                   1256/1257) takes nothing again and never more than the note left; a return note (made from a delivery note,
--                   before it is invoiced) brings back at most what went out. An order moves nothing. An order, a delivery note and
--                   a return note issued by mistake are cancelled (the goods move back), unless a document was made from them.
-- No row is removed and no existing row is changed. The rollback is a comment at the end.
-- ============================================================================================================================

-- ---- 0. after 20261011004900 -----------------------------------------------------------------------------------------------------
do $$ begin
  if to_regprocedure('public.report_business(date, date)') is null then
    raise exception 'migration 20261011005000 runs after 20261011004900 (the reports) — run that one first; nothing was changed';
  end if;
end $$;

-- ---- 1. the switches -------------------------------------------------------------------------------------------------------------
alter table public.business_finance_profile add column if not exists cash_drawers boolean not null default false;
alter table public.business_finance_profile add column if not exists sells_products boolean not null default false;
alter table public.business_finance_profile add column if not exists cheque_remind_days int not null default 3 check (cheque_remind_days between 0 and 30);

-- ---- 2. deposits -----------------------------------------------------------------------------------------------------------------
create table if not exists public.bank_deposits (
  id            uuid primary key,                                              -- chosen by the screen: a second try is the same deposit
  business_id   uuid not null references public.businesses on delete restrict,
  location_id   uuid not null,
  number        int  not null check (number > 0),
  deposited_on  date not null,
  cash          numeric(14,2) not null default 0 check (cash >= 0),
  cheques       numeric(14,2) not null default 0 check (cheques >= 0),
  note          text not null default '' check (length(note) <= 300),
  status        text not null default 'active' check (status in ('active', 'cancelled')),
  cancel_reason text not null default '' check (length(cancel_reason) <= 300),
  cancelled_at  timestamptz,
  cancelled_by  uuid references auth.users on delete set null,
  user_id       uuid references auth.users on delete set null,
  created_at    timestamptz not null default now(),
  unique (business_id, number),
  unique (id, business_id),
  check (cash + cheques > 0),
  check ((status = 'cancelled') = (cancelled_at is not null)),
  foreign key (location_id, business_id) references public.business_locations (id, business_id) on delete restrict
);
create index if not exists bank_deposits_business_idx on public.bank_deposits (business_id, deposited_on desc);

-- the cheques of a deposit: a received cheque is in one active deposit at most
create table if not exists public.bank_deposit_cheques (
  deposit_id  uuid not null,
  business_id uuid not null,
  location_id uuid not null,
  payment_id  uuid not null references public.payments on delete restrict,
  amount      numeric(14,2) not null check (amount > 0),
  active      boolean not null default true,
  primary key (deposit_id, payment_id),
  foreign key (deposit_id, business_id) references public.bank_deposits (id, business_id) on delete restrict
);
create unique index if not exists bank_deposit_cheques_once on public.bank_deposit_cheques (payment_id) where active;
create index if not exists bank_deposit_cheques_business_idx on public.bank_deposit_cheques (business_id);

-- ---- 3. a cheque is reminded once ------------------------------------------------------------------------------------------------
create table if not exists public.cheque_reminders (
  payment_id  uuid primary key references public.payments on delete restrict,
  business_id uuid not null references public.businesses on delete restrict,
  due_date    date not null,
  sent_at     timestamptz not null default now()
);

-- ---- 4. the bank's lines and the matches -----------------------------------------------------------------------------------------
create table if not exists public.bank_statements (
  id          uuid primary key,                                                -- chosen by the screen: a second try is the same import
  business_id uuid not null references public.businesses on delete restrict,
  account     text not null default '' check (length(account) <= 60),
  file_name   text not null default '' check (length(file_name) <= 200),
  lines_total int  not null default 0 check (lines_total >= 0),
  lines_new   int  not null default 0 check (lines_new >= 0),
  date_from   date,
  date_to     date,
  user_id     uuid references auth.users on delete set null,
  created_at  timestamptz not null default now(),
  unique (id, business_id)
);
create index if not exists bank_statements_business_idx on public.bank_statements (business_id, created_at desc);

create table if not exists public.bank_lines (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses on delete restrict,
  statement_id uuid not null,
  account      text not null default '' check (length(account) <= 60),
  line_date    date not null,
  description  text not null default '' check (length(description) <= 300),
  reference    text not null default '' check (length(reference) <= 60),
  amount       numeric(14,2) not null check (amount <> 0),                     -- money in > 0, money out < 0
  balance      numeric(14,2),
  fingerprint  text not null check (length(fingerprint) = 32),                 -- the same line of the bank in two files is one line
  status       text not null default 'open' check (status in ('open', 'matched', 'handled')),
  note         text not null default '' check (length(note) <= 300),
  handled_by   uuid references auth.users on delete set null,
  handled_at   timestamptz,
  created_at   timestamptz not null default now(),
  unique (business_id, fingerprint),
  unique (id, business_id),
  foreign key (statement_id, business_id) references public.bank_statements (id, business_id) on delete restrict
);
create index if not exists bank_lines_business_idx on public.bank_lines (business_id, line_date desc);

create table if not exists public.bank_matches (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses on delete restrict,
  bank_line_id uuid not null,
  payment_id   uuid references public.payments on delete restrict,
  deposit_id   uuid,
  amount       numeric(14,2) not null check (amount > 0),
  active       boolean not null default true,
  approved_by  uuid references auth.users on delete set null,
  approved_at  timestamptz not null default now(),
  undone_by    uuid references auth.users on delete set null,
  undone_at    timestamptz,
  undo_reason  text not null default '' check (length(undo_reason) <= 300),
  check ((payment_id is null) <> (deposit_id is null)),
  check (active = (undone_at is null)),
  foreign key (bank_line_id, business_id) references public.bank_lines (id, business_id) on delete restrict,
  foreign key (deposit_id, business_id) references public.bank_deposits (id, business_id) on delete restrict
);
-- a receipt, a payment or a deposit is matched to one line at most
create unique index if not exists bank_matches_payment_once on public.bank_matches (payment_id) where active and payment_id is not null;
create unique index if not exists bank_matches_deposit_once on public.bank_matches (deposit_id) where active and deposit_id is not null;
create index if not exists bank_matches_line_idx on public.bank_matches (bank_line_id);
create index if not exists payments_method_idx on public.payments (business_id, method, direction);

-- never removed (a deposit is cancelled, a match undone, a line reopened — by the functions below, with the log)
do $$
declare t text;
begin
  foreach t in array array['bank_deposits', 'bank_deposit_cheques', 'cheque_reminders', 'bank_statements', 'bank_lines', 'bank_matches'] loop
    execute format('create or replace trigger %I before delete on public.%I for each row execute function public.finance_append_only()', t || '_no_delete', t);
  end loop;
end $$;

-- ============================================================================================================================
-- the desks, the deposits and the cheques
-- ============================================================================================================================
-- a date written yyyy-mm-dd, or null (a cheque's due date, a line of the bank)
create or replace function public.iso_date(p text) returns date
language plpgsql immutable set search_path = public as $$
begin
  if p is null or p !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return null; end if;
  return p::date;
exception when others then return null;
end $$;

-- the cash a location's desk holds now: every cash payment in, less every cash payment out, less the cash its deposits took
create or replace function public.cash_desk_cash(p_business uuid, p_location uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce((select sum(case p.direction when 'in' then p.amount else -p.amount end) from public.payments p
                    where p.business_id = p_business and p.method = 'cash' and coalesce(p.location_id, p.business_id) = p_location), 0)
       - coalesce((select sum(d.cash) from public.bank_deposits d
                    where d.business_id = p_business and d.location_id = p_location and d.status = 'active'), 0);
$$;

-- a received cheque (a receipt's payment by cheque) is in the drawer until it is deposited, matched to the bank on its own, or
-- its receipt is cancelled
create or replace function public.cheque_in_drawer(p_payment uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.payments p
                  where p.id = p_payment and p.direction = 'in' and p.method = 'cheque' and p.source = 'document'
                    and not exists (select 1 from public.document_cancellations c where c.document_id = p.document_id)
                    and not exists (select 1 from public.bank_deposit_cheques x where x.payment_id = p.id and x.active)
                    and not exists (select 1 from public.bank_matches m where m.payment_id = p.id and m.active));
$$;
revoke execute on function public.iso_date(text), public.cash_desk_cash(uuid, uuid), public.cheque_in_drawer(uuid) from public, anon, authenticated;

-- the desks screen: each method's money in and out in the period, the cash the desk holds now, the cheques in the drawer now (and
-- those due within the reminder's days), the deposits of the period — of the locations the caller sees now (the ledger's own rule)
create or replace function public.cash_desks(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare b uuid := public.report_business(p_from, p_to); f uuid[] := public.location_filter(); days int; today date := public.il_today(); res jsonb;
begin
  select fp.cheque_remind_days into days from public.business_finance_profile fp where fp.business_id = b;
  days := coalesce(days, 3);
  with p as (
    select x.* from public.payments x where x.business_id = b and (f is null or coalesce(x.location_id, x.business_id) = any (f))
  ), per as (
    select m.method, m.ord,
           coalesce(sum(p.amount) filter (where p.direction = 'in' and p.paid_on between p_from and p_to), 0) as inn,
           coalesce(sum(p.amount) filter (where p.direction = 'out' and p.paid_on between p_from and p_to), 0) as outt,
           count(p.id) filter (where p.paid_on between p_from and p_to) as n
      from unnest(array['cash', 'cheque', 'card', 'transfer', 'bit', 'other']) with ordinality m(method, ord)
      left join p on p.method = m.method
     group by m.method, m.ord
  ), dep as (
    select d.* from public.bank_deposits d where d.business_id = b and (f is null or d.location_id = any (f))
  ), chq as (
    select p.amount, public.iso_date(p.reference->>'dueDate') as due
      from p where p.direction = 'in' and p.method = 'cheque' and p.source = 'document' and public.cheque_in_drawer(p.id)
  )
  select jsonb_build_object(
    'methods', (select jsonb_agg(jsonb_build_object('method', method, 'in', inn, 'out', outt, 'count', n) order by ord) from per),
    'cash', (select coalesce(sum(case p.direction when 'in' then p.amount else -p.amount end), 0) from p where p.method = 'cash')
            - (select coalesce(sum(d.cash), 0) from dep d where d.status = 'active'),
    'cheques', jsonb_build_object('count', (select count(*) from chq), 'total', (select coalesce(sum(amount), 0) from chq),
                                  'dueCount', (select count(*) from chq where due <= today + days),
                                  'dueTotal', (select coalesce(sum(amount), 0) from chq where due <= today + days)),
    'deposits', jsonb_build_object('count', (select count(*) from dep where status = 'active' and deposited_on between p_from and p_to),
                                   'total', (select coalesce(sum(cash + cheques), 0) from dep where status = 'active' and deposited_on between p_from and p_to)),
    'remindDays', days, 'today', today)
    into res;
  return res;
end $$;

-- the cheques: those in the drawer now (by due date), and those deposited in the period ("the cheques deposited") — each with
-- its receipt, its customer and its deposit
create or replace function public.cheque_book(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare b uuid := public.report_business(p_from, p_to); f uuid[] := public.location_filter(); res jsonb;
begin
  with c as (
    select p.id, p.amount, p.paid_on, p.reference, coalesce(p.location_id, p.business_id) as loc, d.doc_type, d.doc_number,
           coalesce(d.customer_name, '') as customer, public.iso_date(p.reference->>'dueDate') as due,
           dc.deposit_id, dep.number as dep_number, dep.deposited_on,
           exists (select 1 from public.document_cancellations k where k.document_id = p.document_id) as cancelled,
           exists (select 1 from public.bank_matches m where m.payment_id = p.id and m.active) as matched
      from public.payments p
      left join public.documents d on d.id = p.document_id
      left join public.bank_deposit_cheques dc on dc.payment_id = p.id and dc.active
      left join public.bank_deposits dep on dep.id = dc.deposit_id
     where p.business_id = b and p.direction = 'in' and p.method = 'cheque' and p.source = 'document'
       and (f is null or coalesce(p.location_id, p.business_id) = any (f))
  ), j as (
    select c.*, jsonb_build_object('id', c.id, 'amount', c.amount, 'paidOn', c.paid_on, 'number', coalesce(c.reference->>'number', ''),
             'bank', coalesce(c.reference->>'bank', ''), 'branch', coalesce(c.reference->>'branch', ''),
             'account', coalesce(c.reference->>'account', ''), 'dueDate', c.due, 'docType', c.doc_type, 'docNumber', c.doc_number,
             'customer', c.customer, 'location', c.loc, 'matched', c.matched,
             'deposit', case when c.deposit_id is not null then jsonb_build_object('id', c.deposit_id, 'number', c.dep_number, 'date', c.deposited_on) end) as card
      from c
  )
  select jsonb_build_object(
    'drawer', coalesce((select jsonb_agg(card order by due nulls last, paid_on, id) from j where not cancelled and deposit_id is null and not matched), '[]'::jsonb),
    'deposited', coalesce((select jsonb_agg(card order by deposited_on, dep_number, id) from j
                            where deposit_id is not null and deposited_on between p_from and p_to), '[]'::jsonb))
    into res;
  return res;
end $$;

-- the deposits of the period, each with its cheques (a cancelled one keeps the cheques it had)
create or replace function public.deposit_book(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare b uuid := public.report_business(p_from, p_to); f uuid[] := public.location_filter(); res jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'number', d.number, 'date', d.deposited_on, 'location', d.location_id, 'cash', d.cash,
           'cheques', d.cheques, 'total', d.cash + d.cheques, 'note', d.note, 'status', d.status, 'cancelReason', d.cancel_reason,
           'matched', exists (select 1 from public.bank_matches m where m.deposit_id = d.id and m.active),
           'items', coalesce((select jsonb_agg(jsonb_build_object('payment', x.payment_id, 'amount', x.amount, 'number', coalesce(p.reference->>'number', ''),
                                  'bank', coalesce(p.reference->>'bank', ''), 'dueDate', public.iso_date(p.reference->>'dueDate'),
                                  'customer', coalesce(doc.customer_name, ''), 'docType', doc.doc_type, 'docNumber', doc.doc_number) order by p.paid_on, p.id)
                                from public.bank_deposit_cheques x join public.payments p on p.id = x.payment_id
                                left join public.documents doc on doc.id = p.document_id
                               where x.deposit_id = d.id and (x.active or d.status = 'cancelled')), '[]'::jsonb))
         order by d.deposited_on desc, d.number desc), '[]'::jsonb)
    into res
    from public.bank_deposits d
   where d.business_id = b and d.deposited_on between p_from and p_to and (f is null or d.location_id = any (f));
  return res;
end $$;

-- a deposit: cash (never more than that location's cash desk holds) and cheques in the drawer of that location, taken to the bank
-- together. The id is chosen by the screen: the same id again is the same deposit.
create or replace function public.bank_deposit_create(p_id uuid, p_date date, p_location uuid, p_cash numeric, p_cheques uuid[], p_note text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare b uuid := public.finance_guard(); d record; loc uuid; lock_end date; have numeric; cash numeric := coalesce(p_cash, 0);
        ids uuid[]; n int; chq numeric; num int; bad text;
begin
  if not public.can_write() then raise exception 'not allowed' using errcode = '42501'; end if;
  if not public.business_is_active(b) then raise exception 'business_locked' using errcode = '42501'; end if;
  if p_id is null then raise exception 'deposit_id: a new deposit has an id' using errcode = '22023'; end if;
  -- one deposit of the business at a time: its number, the cash the desk holds, the same id twice — "no key update", as the stock
  -- transfers: a document's or a payment's check of its business (key share) never waits on it
  perform 1 from public.businesses where id = b for no key update;
  select * into d from public.bank_deposits where id = p_id;
  if d.id is not null then
    if d.business_id <> b then raise exception 'not allowed' using errcode = '42501'; end if;
    return jsonb_build_object('id', d.id, 'number', d.number, 'created', false);
  end if;
  if p_date is null or p_date > public.il_today() or p_date < public.il_today() - 3650 then
    raise exception 'deposit_date: a deposit is dated today or before' using errcode = '22023'; end if;
  lock_end := public.finance_locked_until(b);
  if lock_end is not null and p_date <= lock_end then
    raise exception 'period_locked: the books are closed until %', lock_end using errcode = '23514'; end if;
  loc := coalesce(p_location, public.location_pick(b));
  if loc is null or not exists (select 1 from public.business_locations l where l.id = loc and l.business_id = b) then
    raise exception 'deposit_location: a location of the business' using errcode = '22023'; end if;
  if not public.location_allowed(b, loc) then raise exception 'not allowed: this location is not yours' using errcode = '42501'; end if;
  if cash < 0 or cash >= 1e10 or round(cash, 2) <> cash then raise exception 'deposit_cash: an amount of money' using errcode = '22023'; end if;
  select coalesce(array_agg(distinct x), '{}') into ids from unnest(coalesce(p_cheques, '{}'::uuid[])) x where x is not null;
  n := cardinality(ids);
  if n > 200 then raise exception 'deposit_cheques: up to 200 cheques in a deposit' using errcode = '22023'; end if;
  if cash = 0 and n = 0 then raise exception 'deposit_empty: cash or cheques to deposit' using errcode = '22023'; end if;
  -- every cheque: received on a receipt of the business, of this location, in the drawer now
  select string_agg(x::text, ', ') into bad from unnest(ids) x
   where not exists (select 1 from public.payments p where p.id = x and p.business_id = b and p.direction = 'in' and p.method = 'cheque' and p.source = 'document');
  if bad is not null then raise exception 'deposit_cheque: a cheque received on a receipt of the business' using errcode = '22023'; end if;
  if exists (select 1 from public.payments p where p.id = any (ids) and coalesce(p.location_id, p.business_id) <> loc) then
    raise exception 'deposit_cheque_location: the cheques of the deposit''s location' using errcode = '22023'; end if;
  if exists (select 1 from unnest(ids) x where not public.cheque_in_drawer(x)) then
    raise exception 'deposit_cheque_taken: a cheque is no longer in the drawer (deposited, matched to the bank or its receipt cancelled)' using errcode = '23514'; end if;
  if cash > 0 then
    have := public.cash_desk_cash(b, loc);
    if cash > have then raise exception 'deposit_cash_over: the cash desk holds %', greatest(have, 0) using errcode = '23514'; end if;
  end if;
  select coalesce(sum(p.amount), 0) into chq from public.payments p where p.id = any (ids);
  select coalesce(max(x.number), 0) + 1 into num from public.bank_deposits x where x.business_id = b;
  insert into public.bank_deposits (id, business_id, location_id, number, deposited_on, cash, cheques, note, user_id)
  values (p_id, b, loc, num, p_date, cash, chq, left(btrim(coalesce(p_note, '')), 300), auth.uid());
  insert into public.bank_deposit_cheques (deposit_id, business_id, location_id, payment_id, amount)
  select p_id, b, loc, p.id, p.amount from public.payments p where p.id = any (ids);
  perform public.finance_log(b, 'deposit.created', 'bank_deposits', p_id::text,
    jsonb_build_object('number', num, 'date', p_date, 'cash', cash, 'cheques', n, 'total', cash + chq, 'location', loc));
  return jsonb_build_object('id', p_id, 'number', num, 'created', true);
exception when unique_violation then
  raise exception 'deposit_cheque_taken: a cheque is no longer in the drawer (deposited, matched to the bank or its receipt cancelled)' using errcode = '23505';
end $$;

-- a deposit recorded by mistake: cancelled with a reason (its cheques back in the drawer, its cash back in the desk) — not after
-- the bank matched it, not in closed books
create or replace function public.bank_deposit_cancel(p_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b uuid := public.finance_guard(); d record; lock_end date;
begin
  if not public.can_write() then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into d from public.bank_deposits where id = p_id for update;
  if d.id is null or d.business_id <> b then raise exception 'not allowed' using errcode = '42501'; end if;
  if not public.location_allowed(b, d.location_id) then raise exception 'not allowed: this location is not yours' using errcode = '42501'; end if;
  if d.status = 'cancelled' then return jsonb_build_object('id', d.id, 'result', 'already'); end if;
  if length(btrim(coalesce(p_reason, ''))) < 2 then raise exception 'reason_required: a reason or a note, two letters at least' using errcode = '22023'; end if;
  lock_end := public.finance_locked_until(b);
  if lock_end is not null and d.deposited_on <= lock_end then
    raise exception 'period_locked: the books are closed until %', lock_end using errcode = '23514'; end if;
  if exists (select 1 from public.bank_matches m where m.deposit_id = d.id and m.active) then
    raise exception 'deposit_matched: the bank already matched this deposit — undo that match first' using errcode = '23514'; end if;
  update public.bank_deposits set status = 'cancelled', cancel_reason = left(btrim(p_reason), 300), cancelled_at = now(), cancelled_by = auth.uid()
   where id = d.id;
  update public.bank_deposit_cheques set active = false where deposit_id = d.id and active;
  perform public.finance_log(b, 'deposit.cancelled', 'bank_deposits', d.id::text,
    jsonb_build_object('number', d.number, 'total', d.cash + d.cheques, 'reason', left(btrim(p_reason), 300)));
  return jsonb_build_object('id', d.id, 'result', 'cancelled');
end $$;

-- the timer: the cheques in the drawer due within the business's days (or due in the last 30 days and never reminded) — each once,
-- 08:00–20:00 Israel time, not on Saturday, for a business whose desks are on. Two runs at once remind nothing twice.
create or replace function public.cheque_reminders_claim(p_limit int default 100, p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = public as $$
declare il timestamp := p_now at time zone 'Asia/Jerusalem'; today date := (p_now at time zone 'Asia/Jerusalem')::date; res jsonb;
begin
  if extract(hour from il) < 8 or extract(hour from il) >= 20 or extract(isodow from il) = 6 then return '[]'::jsonb; end if;
  with cand as (
    select p.id, p.business_id, p.amount, public.iso_date(p.reference->>'dueDate') as due, coalesce(p.reference->>'number', '') as num,
           coalesce(d.customer_name, '') as customer
      from public.payments p
      join public.business_finance_profile fp on fp.business_id = p.business_id and fp.cash_drawers and fp.cheque_remind_days > 0
      left join public.documents d on d.id = p.document_id
     where p.direction = 'in' and p.method = 'cheque' and p.source = 'document'
       and public.iso_date(p.reference->>'dueDate') between today - 30 and today + fp.cheque_remind_days
       and not exists (select 1 from public.cheque_reminders r where r.payment_id = p.id)
       and public.cheque_in_drawer(p.id)
       and public.business_is_active(p.business_id)
     order by public.iso_date(p.reference->>'dueDate'), p.id
     limit greatest(1, least(coalesce(p_limit, 100), 500))
  ), ins as (
    insert into public.cheque_reminders (payment_id, business_id, due_date)
    select id, business_id, due from cand
    on conflict (payment_id) do nothing
    returning payment_id
  )
  select coalesce(jsonb_agg(jsonb_build_object('business', g.business_id, 'count', g.n, 'total', g.total, 'firstDue', g.first_due, 'cheques', g.list)
                            order by g.business_id), '[]'::jsonb)
    into res
    from (select c.business_id, count(*) as n, sum(c.amount) as total, min(c.due) as first_due,
                 jsonb_agg(jsonb_build_object('number', c.num, 'amount', c.amount, 'due', c.due, 'customer', c.customer) order by c.due, c.id) as list
            from cand c where c.id in (select payment_id from ins) group by c.business_id) g;
  return res;
end $$;

-- ============================================================================================================================
-- the bank
-- ============================================================================================================================
-- the bank is the whole business's: money access, never a cashier, never a member limited to some locations; writing needs can_write
create or replace function public.bank_guard(p_write boolean) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare b uuid := public.finance_guard();
begin
  if public.my_locations() is not null then raise exception 'not allowed: the bank is the whole business''s' using errcode = '42501'; end if;
  if p_write and (not public.can_write() or not public.business_is_active(b)) then raise exception 'not allowed' using errcode = '42501'; end if;
  return b;
end $$;

-- a payment as the matching screen shows it: what it is, the document or the expense behind it
create or replace function public.payment_card(p_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', p.id, 'direction', p.direction, 'amount', p.amount, 'method', p.method, 'paidOn', p.paid_on, 'source', p.source,
           'docType', d.doc_type, 'docNumber', d.doc_number, 'customer', coalesce(d.customer_name, ''),
           'expenseNumber', e.expense_number, 'supplier', coalesce(e.supplier_name, ''), 'note', p.note,
           'cheque', case when p.method = 'cheque' then coalesce(p.reference->>'number', '') end)
    from public.payments p
    left join public.documents d on d.id = coalesce(p.document_id, p.applies_to)
    left join public.expenses e on e.id = p.expense_id
   where p.id = p_id;
$$;

-- may this payment meet the bank on its own? Money that went through the bank: not tax withheld at source, not cash (cash comes
-- and goes through the desk, and reaches the bank in a deposit), not a cancellation's or a void's reversing row, not a receipt that
-- was cancelled, not an expense that was voided, not a cheque that is in a deposit (the deposit meets the bank)
create or replace function public.bank_payment_ok(p_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.payments p
                  where p.id = p_id and p.method not in ('withholding', 'cash')
                    and p.source not in ('cancel', 'reversal')
                    and not (p.document_id is not null and p.source = 'document'
                             and exists (select 1 from public.document_cancellations c where c.document_id = p.document_id))
                    and not (p.expense_id is not null and exists (select 1 from public.expenses e where e.id = p.expense_id and e.status = 'void'))
                    and not exists (select 1 from public.bank_deposit_cheques x where x.payment_id = p.id and x.active));
$$;
revoke execute on function public.bank_guard(boolean), public.payment_card(uuid), public.bank_payment_ok(uuid) from public, anon, authenticated;

-- a file of the bank: its lines as the screen read them ([{date, amount, description, reference, balance}], in the file's order).
-- A line that is already here (the same account, day, amount, text, reference and balance — the n-th of its kind in the file) is
-- kept once. The id is chosen by the screen: the same id again is the same import.
create or replace function public.bank_import(p_id uuid, p_account text, p_file text, p_lines jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b uuid := public.bank_guard(true); s record; n int; bad int; added int; acc text := left(btrim(coalesce(p_account, '')), 60);
begin
  if p_id is null then raise exception 'bank_id: a new import has an id' using errcode = '22023'; end if;
  -- one import of the business at a time (the same line in two files at once is kept once)
  perform pg_advisory_xact_lock(hashtextextended('bank_import:' || b::text, 0));
  select * into s from public.bank_statements where id = p_id;
  if s.id is not null then
    if s.business_id <> b then raise exception 'not allowed' using errcode = '42501'; end if;
    return jsonb_build_object('id', s.id, 'total', s.lines_total, 'added', s.lines_new, 'created', false);
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' then raise exception 'bank_lines: a list of lines' using errcode = '22023'; end if;
  n := jsonb_array_length(p_lines);
  if n = 0 or n > 5000 then raise exception 'bank_lines: 1 to 5,000 lines in a file' using errcode = '22023'; end if;
  select count(*) into bad from jsonb_array_elements(p_lines) e
   where jsonb_typeof(e) <> 'object'
      or public.iso_date(e->>'date') is null or public.iso_date(e->>'date') not between date '2000-01-01' and public.il_today() + 31
      or jsonb_typeof(e->'amount') is distinct from 'number' or (e->>'amount')::numeric = 0 or abs((e->>'amount')::numeric) >= 1e10
      or round((e->>'amount')::numeric, 2) <> (e->>'amount')::numeric
      or (e ? 'balance' and jsonb_typeof(e->'balance') not in ('number', 'null'))
      or (jsonb_typeof(e->'balance') = 'number' and (abs((e->>'balance')::numeric) >= 1e12 or round((e->>'balance')::numeric, 2) <> (e->>'balance')::numeric))
      or (e ? 'description' and jsonb_typeof(e->'description') <> 'string') or length(coalesce(e->>'description', '')) > 300
      or (e ? 'reference' and jsonb_typeof(e->'reference') <> 'string') or length(coalesce(e->>'reference', '')) > 60;
  if bad > 0 then raise exception 'bank_lines: each line has a date, an amount (not zero) and its text' using errcode = '22023'; end if;
  insert into public.bank_statements (id, business_id, account, file_name, lines_total, user_id)
  values (p_id, b, acc, left(btrim(coalesce(p_file, '')), 200), n, auth.uid());
  with l as (
    select (e->>'date')::date as day, round((e->>'amount')::numeric, 2) as amount,
           left(btrim(coalesce(e->>'description', '')), 300) as descr, left(btrim(coalesce(e->>'reference', '')), 60) as ref,
           case when jsonb_typeof(e->'balance') = 'number' then round((e->>'balance')::numeric, 2) end as bal, o
      from jsonb_array_elements(p_lines) with ordinality x(e, o)
  ), k as (
    select l.*, concat_ws('|', acc, day::text, amount::text, lower(regexp_replace(descr, '\s+', ' ', 'g')), ref, coalesce(bal::text, '')) as key from l
  ), f as (
    select k.*, md5(key || '#' || row_number() over (partition by key order by o)) as fp from k
  )
  insert into public.bank_lines (business_id, statement_id, account, line_date, description, reference, amount, balance, fingerprint)
  select b, p_id, acc, day, descr, ref, amount, bal, fp from f order by o
  on conflict (business_id, fingerprint) do nothing;
  get diagnostics added = row_count;
  update public.bank_statements set lines_new = added,
         date_from = (select min((e->>'date')::date) from jsonb_array_elements(p_lines) e),
         date_to = (select max((e->>'date')::date) from jsonb_array_elements(p_lines) e)
   where id = p_id;
  perform public.finance_log(b, 'bank.imported', 'bank_statements', p_id::text,
    jsonb_build_object('account', acc, 'file', left(btrim(coalesce(p_file, '')), 200), 'lines', n, 'added', added));
  return jsonb_build_object('id', p_id, 'total', n, 'added', added, 'created', true);
end $$;

-- the bank's lines of the period, each with what it was matched to; the files uploaded
create or replace function public.bank_book(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare b uuid := public.bank_guard(false); res jsonb;
begin
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 3700 then raise exception 'bad range' using errcode = '22023'; end if;
  select jsonb_build_object(
    'lines', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'date', l.line_date, 'description', l.description, 'reference', l.reference,
               'amount', l.amount, 'balance', l.balance, 'status', l.status, 'note', l.note, 'account', l.account, 'statement', l.statement_id,
               'matches', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'amount', m.amount,
                                      'payment', case when m.payment_id is not null then public.payment_card(m.payment_id) end,
                                      'deposit', case when m.deposit_id is not null then
                                        (select jsonb_build_object('id', d.id, 'number', d.number, 'date', d.deposited_on, 'cash', d.cash, 'cheques', d.cheques)
                                           from public.bank_deposits d where d.id = m.deposit_id) end) order by m.approved_at, m.id)
                                    from public.bank_matches m where m.bank_line_id = l.id and m.active), '[]'::jsonb))
             order by l.line_date, l.created_at, l.id)
        from public.bank_lines l where l.business_id = b and l.line_date between p_from and p_to), '[]'::jsonb),
    'statements', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'account', s.account, 'file', s.file_name, 'total', s.lines_total,
               'added', s.lines_new, 'from', s.date_from, 'to', s.date_to, 'at', s.created_at) order by s.created_at desc)
        from (select * from public.bank_statements x where x.business_id = b order by x.created_at desc limit 50) s), '[]'::jsonb))
    into res;
  return res;
end $$;

-- what a line of the period may be matched to: the payments that went through the bank and are not matched yet, and the active
-- deposits not matched yet
create or replace function public.bank_candidates(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare b uuid := public.bank_guard(false); res jsonb;
begin
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 3700 then raise exception 'bad range' using errcode = '22023'; end if;
  select jsonb_build_object(
    'payments', coalesce((select jsonb_agg(public.payment_card(p.id) order by p.paid_on, p.created_at, p.id)
        from public.payments p
       where p.business_id = b and p.paid_on between p_from and p_to and public.bank_payment_ok(p.id)
         and not exists (select 1 from public.bank_matches m where m.payment_id = p.id and m.active)), '[]'::jsonb),
    'deposits', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'number', d.number, 'date', d.deposited_on, 'cash', d.cash,
               'cheques', d.cheques, 'total', d.cash + d.cheques,
               'count', (select count(*) from public.bank_deposit_cheques x where x.deposit_id = d.id and x.active)) order by d.deposited_on, d.number)
        from public.bank_deposits d
       where d.business_id = b and d.status = 'active' and d.deposited_on between p_from and p_to
         and not exists (select 1 from public.bank_matches m where m.deposit_id = d.id and m.active)), '[]'::jsonb))
    into res;
  return res;
end $$;

-- the owner approves a match: the line ↔ receipts / payments / deposits that add up to it to the agora (money in: receipts and
-- deposits; money out: payments). Never twice for anything; the line is then "matched".
create or replace function public.bank_match(p_line uuid, p_payments uuid[] default '{}', p_deposits uuid[] default '{}') returns jsonb
language plpgsql security definer set search_path = public as $$
declare b uuid := public.bank_guard(true); l record; pays uuid[]; deps uuid[]; s numeric;
begin
  select * into l from public.bank_lines where id = p_line for update;
  if l.id is null or l.business_id <> b then raise exception 'not allowed' using errcode = '42501'; end if;
  if l.status <> 'open' then raise exception 'bank_line_closed: the line is already matched or handled' using errcode = '23514'; end if;
  select coalesce(array_agg(distinct x), '{}') into pays from unnest(coalesce(p_payments, '{}'::uuid[])) x where x is not null;
  select coalesce(array_agg(distinct x), '{}') into deps from unnest(coalesce(p_deposits, '{}'::uuid[])) x where x is not null;
  if cardinality(pays) + cardinality(deps) = 0 or cardinality(pays) + cardinality(deps) > 50 then
    raise exception 'bank_match_items: one to 50 receipts, payments or deposits' using errcode = '22023'; end if;
  if (select count(*) from public.payments p where p.id = any (pays) and p.business_id = b) <> cardinality(pays)
     or (select count(*) from public.bank_deposits d where d.id = any (deps) and d.business_id = b) <> cardinality(deps) then
    raise exception 'not allowed' using errcode = '42501'; end if;
  if exists (select 1 from public.payments p where p.id = any (pays) and p.direction <> case when l.amount > 0 then 'in' else 'out' end)
     or (l.amount < 0 and cardinality(deps) > 0) then
    raise exception 'bank_match_sign: money that came in meets a line of money in; money paid, a line of money out' using errcode = '23514'; end if;
  if exists (select 1 from unnest(pays) x where not public.bank_payment_ok(x)) then
    raise exception 'bank_match_item: only money that went through the bank (cash and deposited cheques meet it in their deposit)' using errcode = '23514'; end if;
  if exists (select 1 from public.bank_deposits d where d.id = any (deps) and d.status <> 'active') then
    raise exception 'bank_match_item: a cancelled deposit' using errcode = '23514'; end if;
  s := coalesce((select sum(p.amount) from public.payments p where p.id = any (pays)), 0)
     + coalesce((select sum(d.cash + d.cheques) from public.bank_deposits d where d.id = any (deps)), 0);
  if s <> abs(l.amount) then
    raise exception 'bank_match_sum: the chosen add up to % but the line is %', s, abs(l.amount) using errcode = '23514'; end if;
  insert into public.bank_matches (business_id, bank_line_id, payment_id, amount, approved_by)
  select b, l.id, p.id, p.amount, auth.uid() from public.payments p where p.id = any (pays);
  insert into public.bank_matches (business_id, bank_line_id, deposit_id, amount, approved_by)
  select b, l.id, d.id, d.cash + d.cheques, auth.uid() from public.bank_deposits d where d.id = any (deps);
  update public.bank_lines set status = 'matched' where id = l.id;
  perform public.finance_log(b, 'bank.matched', 'bank_lines', l.id::text,
    jsonb_build_object('date', l.line_date, 'amount', l.amount, 'payments', cardinality(pays), 'deposits', cardinality(deps)));
  return jsonb_build_object('line', l.id, 'items', cardinality(pays) + cardinality(deps));
exception when unique_violation then
  raise exception 'bank_match_taken: one of them is already matched to another line' using errcode = '23505';
end $$;

-- a match approved by mistake: undone with a reason (the line is open again; the match stays in the history)
create or replace function public.bank_unmatch(p_line uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b uuid := public.bank_guard(true); l record; n int;
begin
  select * into l from public.bank_lines where id = p_line for update;
  if l.id is null or l.business_id <> b then raise exception 'not allowed' using errcode = '42501'; end if;
  if l.status <> 'matched' then raise exception 'bank_line_not_matched: the line is not matched' using errcode = '23514'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 2 then raise exception 'reason_required: a reason or a note, two letters at least' using errcode = '22023'; end if;
  update public.bank_matches set active = false, undone_at = now(), undone_by = auth.uid(), undo_reason = left(btrim(p_reason), 300)
   where bank_line_id = l.id and active;
  get diagnostics n = row_count;
  update public.bank_lines set status = 'open' where id = l.id;
  perform public.finance_log(b, 'bank.unmatched', 'bank_lines', l.id::text,
    jsonb_build_object('date', l.line_date, 'amount', l.amount, 'items', n, 'reason', left(btrim(p_reason), 300)));
  return jsonb_build_object('line', l.id, 'undone', n);
end $$;

-- a line that needs no match (a bank fee, interest): handled, with a note; and back to "לטיפול"
create or replace function public.bank_line_handle(p_line uuid, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b uuid := public.bank_guard(true); l record;
begin
  select * into l from public.bank_lines where id = p_line for update;
  if l.id is null or l.business_id <> b then raise exception 'not allowed' using errcode = '42501'; end if;
  if l.status <> 'open' then raise exception 'bank_line_closed: the line is already matched or handled' using errcode = '23514'; end if;
  if length(btrim(coalesce(p_note, ''))) < 2 then raise exception 'reason_required: a reason or a note, two letters at least' using errcode = '22023'; end if;
  update public.bank_lines set status = 'handled', note = left(btrim(p_note), 300), handled_by = auth.uid(), handled_at = now() where id = l.id;
  perform public.finance_log(b, 'bank.handled', 'bank_lines', l.id::text,
    jsonb_build_object('date', l.line_date, 'amount', l.amount, 'note', left(btrim(p_note), 300)));
  return jsonb_build_object('line', l.id, 'status', 'handled');
end $$;
create or replace function public.bank_line_reopen(p_line uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b uuid := public.bank_guard(true); l record;
begin
  select * into l from public.bank_lines where id = p_line for update;
  if l.id is null or l.business_id <> b then raise exception 'not allowed' using errcode = '42501'; end if;
  if l.status <> 'handled' then raise exception 'bank_line_not_handled: the line is not marked handled' using errcode = '23514'; end if;
  update public.bank_lines set status = 'open', note = '', handled_by = null, handled_at = null where id = l.id;
  perform public.finance_log(b, 'bank.reopened', 'bank_lines', l.id::text, jsonb_build_object('date', l.line_date, 'amount', l.amount, 'note', l.note));
  return jsonb_build_object('line', l.id, 'status', 'open');
end $$;

revoke execute on function public.cash_desks(date, date), public.cheque_book(date, date), public.deposit_book(date, date),
  public.bank_deposit_create(uuid, date, uuid, numeric, uuid[], text), public.bank_deposit_cancel(uuid, text),
  public.bank_import(uuid, text, text, jsonb), public.bank_book(date, date), public.bank_candidates(date, date),
  public.bank_match(uuid, uuid[], uuid[]), public.bank_unmatch(uuid, text), public.bank_line_handle(uuid, text), public.bank_line_reopen(uuid)
  from public, anon;
grant execute on function public.cash_desks(date, date), public.cheque_book(date, date), public.deposit_book(date, date),
  public.bank_deposit_create(uuid, date, uuid, numeric, uuid[], text), public.bank_deposit_cancel(uuid, text),
  public.bank_import(uuid, text, text, jsonb), public.bank_book(date, date), public.bank_candidates(date, date),
  public.bank_match(uuid, uuid[], uuid[]), public.bank_unmatch(uuid, text), public.bank_line_handle(uuid, text), public.bank_line_reopen(uuid)
  to authenticated;
revoke execute on function public.cheque_reminders_claim(int, timestamptz) from public, anon, authenticated;
grant execute on function public.cheque_reminders_claim(int, timestamptz) to service_role;

-- the screens read these (never a cashier, never a business whose money is closed to the caller); only the functions above write
-- them. Deposits by location (as the ledger); the bank's tables for a member who sees every location only.
do $$
declare
  t text;
  gate        constant text := 'business_id = (select public.current_business_id()) and business_id in (select public.accessible_business_ids())';
  fin         constant text := 'business_id in (select public.finance_business_ids())';
  full_access constant text := '(select public.my_access()) <> ''register''';
  locs        constant text := '(select public.location_filter()) is null or location_id = any ((select public.location_filter())::uuid[])';
  whole       constant text := '(select public.my_locations()) is null';
begin
  foreach t in array array['bank_deposits', 'bank_deposit_cheques', 'bank_statements', 'bank_lines', 'bank_matches'] loop
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
    if t in ('bank_deposits', 'bank_deposit_cheques') then
      if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_location_gate') then
        execute format('create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)', t || '_location_gate', t, locs, locs);
      end if;
    elsif not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_whole_business') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)', t || '_whole_business', t, whole, whole);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_business_read') then
      execute format('create policy %I on public.%I for select to authenticated using (%s)', t || '_business_read', t, gate);
    end if;
  end loop;
  -- the reminders are the timer's (the service role) only
  alter table public.cheque_reminders enable row level security;
  revoke all on public.cheque_reminders from anon, authenticated;
end $$;

-- ============================================================================================================================
-- 6. an order, a delivery note and a return note (T10)
-- ============================================================================================================================
-- the documents table and the drafts take the three types (an order and a delivery note may wait as a draft; a return note is made
-- from its delivery note only)
alter table public.documents drop constraint if exists documents_doc_type_check;
alter table public.documents add constraint documents_doc_type_check check (doc_type in (100, 200, 210, 300, 305, 320, 330, 400));
alter table public.document_drafts drop constraint if exists document_drafts_doc_type_check;
alter table public.document_drafts add constraint document_drafts_doc_type_check check (doc_type in (100, 200, 300, 305, 320, 330, 400));

-- what each kind of business may issue (20261004003100's matrix, and the three goods documents — issued only once "selling
-- products" is on: d_documents_goods below)
create or replace function public.entity_doc_types(p_entity text) returns int[]
language sql immutable set search_path = public as $$
  select case when public.entity_charges_vat(p_entity) then array[100, 200, 210, 300, 305, 320, 330, 400] else array[100, 200, 210, 300, 400] end;
$$;

-- documents_validate (20261004003100's): a document made from an order or a delivery note may name it as its base; nothing else changes
create or replace function public.documents_validate() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  rs record; ent text; n int; bad int; s numeric; lock_end date; base record; done numeric; tgt record; mirror boolean := false;
begin
  if new.business_id is null then raise exception 'a document must belong to a business' using errcode = '23502'; end if;
  select * into rs from public.register_settings where business_id = new.business_id;
  if not found or coalesce(rs.dealer_number, '') !~ '^[0-9]{9}$' then
    raise exception 'business_details_missing: a document needs the business''s dealer number (9 digits)' using errcode = '23514';
  end if;
  ent := public.entity_of(rs.entity_type, rs.business_type);
  if not (new.doc_type = any (public.entity_doc_types(ent))) then
    raise exception 'doc_type_not_allowed: % does not issue document type %', ent, new.doc_type using errcode = '23514';
  end if;
  -- a cashier issues the sale's own document, nothing more
  if public.my_access() = 'register' and (new.paid_document_id is not null or new.quote_id is not null or new.draft_id is not null) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  -- references stay inside the business
  if new.sale_id is not null and not exists (select 1 from public.sales x where x.id = new.sale_id and x.business_id = new.business_id) then
    raise exception 'the sale belongs to another business' using errcode = '42501'; end if;
  if new.lead_id is not null and not exists (select 1 from public.leads x where x.id = new.lead_id and x.business_id = new.business_id) then
    raise exception 'the customer belongs to another business' using errcode = '42501'; end if;
  if new.refund_id is not null and not exists (select 1 from public.sale_refunds x where x.id = new.refund_id and x.business_id = new.business_id) then
    raise exception 'the refund belongs to another business' using errcode = '42501'; end if;
  if new.quote_id is not null and not exists (select 1 from public.quotes x where x.id = new.quote_id and x.business_id = new.business_id
                                                and x.status in ('draft', 'sent', 'accepted')) then
    raise exception 'the quote was not found in this business (or was already used)' using errcode = '23514'; end if;
  if new.draft_id is not null and not exists (select 1 from public.document_drafts x where x.id = new.draft_id and x.business_id = new.business_id
                                                and x.status = 'open' and x.doc_type = new.doc_type) then
    raise exception 'the draft was not found in this business (or was already issued)' using errcode = '23514'; end if;

  -- a credit invoice: points to a tax invoice of this business, never beyond what is left to credit (in a lock)
  if new.doc_type = 330 then
    if new.base_doc_type is null or new.base_doc_type not in (305, 320) or new.base_doc_number is null then
      raise exception 'a credit invoice points to a tax invoice (305 / 320)' using errcode = '23514'; end if;
    select id, total, before_discount, discount, after_discount, vat_amount into base from public.documents
     where business_id = new.business_id and doc_type = new.base_doc_type and doc_number = new.base_doc_number for update;
    if not found then raise exception 'the credited invoice was not found in this business' using errcode = '23514'; end if;
    select coalesce(sum(c.total), 0) into done from public.documents c
     where c.business_id = new.business_id and c.doc_type = 330 and c.base_doc_type = new.base_doc_type and c.base_doc_number = new.base_doc_number;
    if done + new.total > base.total then
      raise exception 'credit_exceeds_original: % left to credit', base.total - done using errcode = '23514'; end if;
    -- a full mirror of an invoice issued before these checks existed is accepted as it is
    mirror := new.total = base.total and new.before_discount = base.before_discount and new.discount = base.discount
              and new.after_discount = base.after_discount and new.vat_amount = base.vat_amount;
  elsif new.base_doc_type is not null or new.base_doc_number is not null then
    -- 2.95 (T10): a document made from an order or a delivery note names it (fields 1256/1257) — d_documents_goods checks which
    if new.base_doc_number is null or not ((new.doc_type = 200 and new.base_doc_type = 100) or (new.doc_type = 210 and new.base_doc_type = 200)
                                            or (new.doc_type in (300, 305, 320) and new.base_doc_type in (100, 200))) then
      raise exception 'only a credit invoice points to a base document (or a document made from an order or a delivery note)' using errcode = '23514';
    end if;
  end if;

  -- totals, to the agora
  if not mirror then
    if new.before_discount < 0 or new.discount < 0 or new.vat_amount < 0 or new.total <= 0 then
      raise exception 'totals: amounts are positive and the total is above zero' using errcode = '23514'; end if;
    if new.after_discount <> new.before_discount - new.discount then
      raise exception 'totals: after discount must equal before discount minus the discount' using errcode = '23514'; end if;
    if new.total <> new.after_discount + new.vat_amount then
      raise exception 'totals: the total must equal the amount before VAT plus the VAT' using errcode = '23514'; end if;
    if new.vat_rate < 0 or new.vat_rate > 30 then raise exception 'totals: VAT rate out of range' using errcode = '23514'; end if;
    if not public.entity_charges_vat(ent) or new.doc_type = 400 then
      if new.vat_amount <> 0 then raise exception 'totals: this document carries no VAT' using errcode = '23514'; end if;
    elsif abs(new.vat_amount - round(new.after_discount * new.vat_rate / 100, 2)) > 0.01 then
      raise exception 'totals: the VAT does not match the rate' using errcode = '23514';
    end if;
    if jsonb_typeof(new.lines) is distinct from 'array' then raise exception 'lines: a list is expected' using errcode = '23514'; end if;
    n := jsonb_array_length(new.lines);
    if n = 0 and new.doc_type <> 400 then raise exception 'lines: a document needs at least one line' using errcode = '23514'; end if;
    if n > 0 then
      select coalesce(sum((e->>'totalExVat')::numeric), 0), count(*) filter (where coalesce(e->>'name', '') = '' or e->>'totalExVat' is null)
        into s, bad from jsonb_array_elements(new.lines) e;
      if bad > 0 then raise exception 'lines: every line needs a name and a total' using errcode = '23514'; end if;
      if s <> new.before_discount then
        raise exception 'lines: the lines add up to % but the document says %', s, new.before_discount using errcode = '23514'; end if;
    end if;
  end if;

  -- payments: a receipt (320 / 400) lists how it was paid, exactly the total; other documents list none
  if jsonb_typeof(new.payments) is distinct from 'array' then raise exception 'payments: a list is expected' using errcode = '23514'; end if;
  if new.doc_type in (320, 400) then
    if jsonb_array_length(new.payments) = 0 then raise exception 'payments: a receipt says how it was paid' using errcode = '23514'; end if;
    select coalesce(sum((p->>'amount')::numeric), 0),
           count(*) filter (where coalesce((p->>'amount')::numeric, 0) <= 0 or coalesce(p->>'method', '') !~ '^[1-9]$'
                              or (p ? 'date' and coalesce(p->>'date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'))
      into s, bad from jsonb_array_elements(new.payments) p;
    if bad > 0 then raise exception 'payments: each payment needs a method (1–9), an amount above zero and a valid date' using errcode = '23514'; end if;
    if abs(s - new.total) > 0.01 then raise exception 'payments: % paid but the document says %', s, new.total using errcode = '23514'; end if;
  elsif jsonb_array_length(new.payments) > 0 then
    raise exception 'payments: only a receipt (320 / 400) lists payments' using errcode = '23514';
  end if;

  -- a receipt paying an invoice of this business: 400 pays a 305 / 300, a 320 pays a 300 (in a lock)
  if new.paid_document_id is not null then
    select id, doc_type, business_id into tgt from public.documents where id = new.paid_document_id for update;
    if not found or tgt.business_id is distinct from new.business_id then
      raise exception 'the paid document was not found in this business' using errcode = '42501'; end if;
    if not ((new.doc_type = 400 and tgt.doc_type in (300, 305)) or (new.doc_type = 320 and tgt.doc_type = 300)) then
      raise exception 'a receipt (400) pays a 305 / 300; a tax invoice-receipt (320) pays a 300' using errcode = '23514'; end if;
    if exists (select 1 from public.document_cancellations x where x.document_id = tgt.id) then
      raise exception 'the paid document was cancelled' using errcode = '23514'; end if;
  end if;

  -- dates: never ahead of the day it is issued (a client clock a little ahead is brought back), never in closed books
  if new.doc_date > public.il_today() + 1 then raise exception 'a document can not be dated in the future' using errcode = '23514'; end if;
  if new.doc_date > public.il_today() then new.doc_date := public.il_today(); end if;
  lock_end := public.finance_locked_until(new.business_id);
  if lock_end is not null and new.doc_date <= lock_end then
    raise exception 'period_locked: the books are closed until %', lock_end using errcode = '23514'; end if;
  if new.doc_type in (300, 305) then
    if new.due_date is not null and new.due_date < new.doc_date then raise exception 'the due date is before the document date' using errcode = '23514'; end if;
  else
    new.due_date := null;
  end if;

  new.source := coalesce(new.source, case when new.refund_id is not null then 'refund' when new.sale_id is not null then 'pos'
                                          when new.paid_document_id is not null then 'receipt'
                                          when new.quote_id is not null then 'quote' when new.doc_type = 330 then 'credit' else 'direct' end);
  new.issuer := public.issuer_snapshot(new.business_id);   -- whatever the client sent: the business as it is now
  return new;
end $$;
revoke execute on function public.documents_validate() from public, anon, authenticated;

-- the goods documents: only a business that sells products issues them, never a cashier; a document made from an order or a delivery
-- note (its base) names one of this business that was not cancelled — locked, so two documents made from it at once are checked one
-- after the other. A delivery note is invoiced once, and nothing is returned on it after that (a credit invoice on the invoice
-- then); neither its invoice nor its return notes take more of a product than went out on it, less what came back.
create or replace function public.documents_goods() returns trigger
language plpgsql security definer set search_path = public as $$
declare base record; over text;
begin
  if new.doc_type in (100, 200, 210) or new.base_doc_type in (100, 200) then
    if public.my_access() = 'register' then raise exception 'not allowed' using errcode = '42501'; end if;
  end if;
  if new.doc_type in (100, 200, 210) then
    if not coalesce((select fp.sells_products from public.business_finance_profile fp where fp.business_id = new.business_id), false) then
      raise exception 'goods_off: orders, delivery notes and return notes are for a business that sells products (turned on in the settings)'
        using errcode = '23514';
    end if;
    if new.doc_type = 210 and new.base_doc_type is distinct from 200 then
      raise exception 'goods_return_base: a return note is made from a delivery note' using errcode = '23514';
    end if;
  end if;
  if new.base_doc_type in (100, 200) then
    if new.paid_document_id is not null then
      raise exception 'goods_base_receipt: a receipt for an invoice is not made from an order or a delivery note' using errcode = '23514';
    end if;
    select d.id, d.doc_number, d.lines into base from public.documents d
     where d.business_id = new.business_id and d.doc_type = new.base_doc_type and d.doc_number = new.base_doc_number for update;
    if base.id is null then raise exception 'goods_base_missing: the order / delivery note was not found in this business' using errcode = '23514'; end if;
    if exists (select 1 from public.document_cancellations c where c.document_id = base.id) then
      raise exception 'goods_base_cancelled: the order / delivery note was cancelled' using errcode = '23514';
    end if;
    if new.base_doc_type = 200 then
      if exists (select 1 from public.documents x
                  where x.business_id = new.business_id and x.base_doc_type = 200 and x.base_doc_number = base.doc_number
                    and x.doc_type in (300, 305, 320) and not exists (select 1 from public.document_cancellations c where c.document_id = x.id)) then
        raise exception 'goods_invoiced: the delivery note was already invoiced' using errcode = '23514';
      end if;
      select string_agg(ci.name, ', ' order by ci.name) into over
        from public.stock_lines_v(new.lines) n
        join public.catalog_items ci on ci.id = n.item_id and ci.business_id = new.business_id and ci.kind = 'product'
        left join public.stock_lines_v(base.lines) o on o.item_id = n.item_id and o.variant_id is not distinct from n.variant_id
        left join lateral (select coalesce(sum(r.qty), 0) as qty
                             from public.documents x cross join lateral public.stock_lines_v(x.lines) r
                            where x.business_id = new.business_id and x.doc_type = 210 and x.base_doc_type = 200 and x.base_doc_number = base.doc_number
                              and not exists (select 1 from public.document_cancellations c where c.document_id = x.id)
                              and r.item_id = n.item_id and r.variant_id is not distinct from n.variant_id) back on true
       where n.qty > coalesce(o.qty, 0) - back.qty;
      if over is not null then
        raise exception 'goods_over_delivery: more than the delivery note left (%)', over using errcode = '23514';
      end if;
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.documents_goods() from public, anon, authenticated;
-- "d_documents_goods": after c_documents_validate (which allows the base) and d_documents_checks, before the numbering
create or replace trigger d_documents_goods before insert on public.documents for each row execute function public.documents_goods();

-- the receipts' payments into the ledger and the stock (20261011004900's): a delivery note takes the goods out, a return note brings
-- them back, an invoice made from a delivery note moves nothing; an order moves nothing
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
    if new.doc_type = 200 then
      -- 2.95 (T10): a delivery note takes the goods out — the invoice made from it takes nothing again
      for l in select * from public.stock_lines_v(new.lines) loop
        perform public.stock_move_ref_at(new.business_id, coalesce(new.location_id, new.business_id), l.item_id, l.variant_id, -l.qty, 'sale', format('%s-%s', new.doc_type, new.doc_number), new.id, null);
      end loop;
    elsif new.doc_type = 210 then
      -- a return note brings back what came back, where it went out from (its delivery note's location)
      for l in select * from public.stock_lines_v(new.lines) loop
        perform public.stock_move_ref_at(new.business_id, coalesce(new.location_id, new.business_id), l.item_id, l.variant_id, l.qty, 'refund', format('%s-%s', new.doc_type, new.doc_number), new.id, null);
      end loop;
    elsif new.doc_type in (300, 305, 320, 400) and new.paid_document_id is null and new.base_doc_type is distinct from 200 then
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

-- cancellations (20261004003100's): also an order, a delivery note or a return note issued by mistake (their goods move back —
-- document_cancellations_after), unless a document was made from it
create or replace function public.document_cancellations_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare d record; lock_end date;
begin
  select id, business_id, doc_type, doc_number, doc_date, base_doc_number into d from public.documents where id = new.document_id for update;
  if not found or d.business_id is distinct from new.business_id then
    raise exception 'the document was not found in this business' using errcode = '42501'; end if;
  if d.doc_type not in (300, 400, 100, 200, 210) then
    raise exception 'cancel_not_allowed: a tax invoice is corrected by a credit invoice (330)' using errcode = '23514'; end if;
  lock_end := public.finance_locked_until(d.business_id);
  if lock_end is not null and d.doc_date <= lock_end then
    raise exception 'period_locked: the books are closed until %', lock_end using errcode = '23514'; end if;
  if d.doc_type = 300 and exists (select 1 from public.documents p where p.paid_document_id = d.id
                                    and not exists (select 1 from public.document_cancellations c where c.document_id = p.id)) then
    raise exception 'a paid transaction invoice is not cancelled (cancel its receipt first)' using errcode = '23514'; end if;
  -- 2.95 (T10): an order / a delivery note a document was made from stays (cancel that one first, if it may be)
  if d.doc_type in (100, 200) and exists (select 1 from public.documents x
                                            where x.business_id = d.business_id and x.base_doc_type = d.doc_type and x.base_doc_number = d.doc_number
                                              and not exists (select 1 from public.document_cancellations c where c.document_id = x.id)) then
    raise exception 'cancel_has_followers: a document was made from it — cancel that one first' using errcode = '23514'; end if;
  -- a return note stays once its delivery note was invoiced (the invoice counted what came back)
  if d.doc_type = 210 and exists (select 1 from public.documents x
                                    where x.business_id = d.business_id and x.base_doc_type = 200 and x.base_doc_number = d.base_doc_number
                                      and x.doc_type in (300, 305, 320)
                                      and not exists (select 1 from public.document_cancellations c where c.document_id = x.id)) then
    raise exception 'cancel_has_followers: its delivery note was invoiced' using errcode = '23514'; end if;
  new.created_at := now();
  return new;
end $$;
revoke execute on function public.document_cancellations_check() from public, anon, authenticated;

-- the log of the business (20261004003100's): and who turned the desks or the goods documents on or off
create or replace function public.business_finance_profile_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.finance_log(new.business_id, 'settings.finance_profile', 'business_finance_profile', new.business_id::text,
    jsonb_build_object('bankChanged', tg_op = 'INSERT' or (new.bank_name, new.bank_branch, new.bank_account) is distinct from (old.bank_name, old.bank_branch, old.bank_account),
                       'terms', new.payment_terms)
    || case when tg_op = 'INSERT' or (new.cash_drawers, new.sells_products, new.cheque_remind_days)
                                     is distinct from (old.cash_drawers, old.sells_products, old.cheque_remind_days)
            then jsonb_build_object('cashDrawers', new.cash_drawers, 'sellsProducts', new.sells_products, 'chequeRemindDays', new.cheque_remind_days)
            else '{}'::jsonb end);
  return null;
end $$;
revoke execute on function public.business_finance_profile_audit() from public, anon, authenticated;

-- ============================================================================================================================
-- Rollback (by hand, if ever needed — nothing that existed before is lost): drop the policies of bank_deposits, bank_deposit_cheques,
--   bank_statements, bank_lines and bank_matches; drop the functions cash_desks, cheque_book, deposit_book, bank_deposit_create,
--   bank_deposit_cancel, cheque_reminders_claim, bank_import, bank_book, bank_candidates, bank_match, bank_unmatch, bank_line_handle,
--   bank_line_reopen, bank_guard, payment_card, bank_payment_ok, cash_desk_cash, cheque_in_drawer, iso_date; drop the trigger
--   d_documents_goods and the function documents_goods; drop the tables bank_matches, bank_lines, bank_statements, cheque_reminders,
--   bank_deposit_cheques, bank_deposits; drop index payments_method_idx; put back entity_doc_types, documents_validate and
--   document_cancellations_check of 20261004003100, documents_after_insert of 20261011004900 and business_finance_profile_audit of
--   20261004003100; documents_doc_type_check and document_drafts_doc_type_check back to (300, 305, 320, 330, 400) — only while no
--   document of type 100 / 200 / 210 was issued; alter table business_finance_profile drop column cash_drawers, sells_products,
--   cheque_remind_days.
-- ============================================================================================================================
