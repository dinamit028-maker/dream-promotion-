-- ============================================================================================================================
-- Migration 20261010004400 — payment plans, scheduled debt reminders, a duplicate expense (docs/FINANCE_ADDITIONS_HE.md,
-- T3 + T5 + T6; 2.89.0). Prepared only: NOT applied to the live database (needs the owner's explicit approval). Runs after
-- 4300 (it widens the email rules 4300 made). Tested on a local Postgres: tests/sql/plans-reminders.check.sql and
-- tests/sql/concurrency.sh §15.
--
--   1. plans      payment_plans + payment_plan_items: the balance of an open invoice (also a package's) split into dated
--                 payments that add up to it to the agora. Not card installments — dates the business collects on. Made and
--                 cancelled only by payment_plan_create / payment_plan_cancel; money still pays the invoice (payments).
--   2. lines      receivable_lines: what is owed, by date. An invoice without a plan is one line (its own due date); with a
--                 plan, a line per payment, paid in order (whatever was paid or credited since the plan covers the first
--                 ones). finance_summary()'s "overdue" counts these lines; nothing else in it changes.
--   3. reminders  debt_reminder_settings (off; only the owner turns it on, and the approval is kept), debt_reminders (each
--                 one once per line and step), debt_reminder_stops ("לא לשלוח" on a customer). The dashboard's timer
--                 (/api/cron/commerce) queues them: an email (the one outbox) or the WhatsApp queue the owner sends from.
--                 A payment stops them: every send asks again whether the line is still open.
--   4. expenses   expenses.file_sha256 (the same file again → "already recorded"), expense_duplicates() (the same
--                 supplier and number, or supplier + amount + date) — a warning, never a block; "זו הוצאה אחרת" is kept
--                 (expenses.duplicate_ack, who and when from the database) and logged.
-- No statement here removes rows. email_outbox's two checks are widened again (a reminder's email) — the SQL Editor runs
-- this file (the MCP stops on the word drop). The rollback at the end is a comment.
-- ============================================================================================================================

-- 4300 first: this file widens the email rules it made
do $$
begin
  if to_regclass('public.payment_requests') is null then
    raise exception 'run 20261010004300_payment_links.sql first' using errcode = '55000';
  end if;
end $$;

-- ---- 1. payment plans ------------------------------------------------------------------------------------------------------
create table if not exists public.payment_plans (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses on delete restrict,
  user_id       uuid references auth.users on delete set null,                     -- who made it
  document_id   uuid not null references public.documents on delete restrict,      -- the open invoice (305 / 300) it splits
  lead_id       uuid references public.leads on delete set null,
  total         numeric(14,2) not null check (total > 0 and total <= 10000000),    -- the balance when it was made
  payments      int not null check (payments between 2 and 36),
  status        text not null default 'active' check (status in ('active', 'cancelled')),
  note          text not null default '' check (length(note) <= 300),
  created_at    timestamptz not null default now(),
  cancelled_at  timestamptz,
  cancelled_by  uuid,
  cancel_reason text not null default '' check (length(cancel_reason) <= 300),
  check ((status = 'cancelled') = (cancelled_at is not null))
);
create index if not exists payment_plans_business_idx on public.payment_plans (business_id, created_at desc);
-- one plan in force per invoice (a new one replaces it — payment_plan_create with p_replace)
create unique index if not exists payment_plans_active_uq on public.payment_plans (document_id) where status = 'active';

create table if not exists public.payment_plan_items (
  id          uuid primary key default gen_random_uuid(),
  plan_id     uuid not null references public.payment_plans on delete restrict,
  business_id uuid not null references public.businesses on delete restrict,
  n           int not null check (n between 1 and 36),
  due_date    date not null,
  amount      numeric(14,2) not null check (amount > 0),
  unique (plan_id, n)
);
create index if not exists payment_plan_items_business_idx on public.payment_plan_items (business_id, due_date);

-- a plan keeps its payments (it is cancelled and made again); a payment of it never changes
create or replace function public.payment_plans_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_table_name = 'payment_plan_items' then
    raise exception 'a payment of a plan does not change — the plan is made again' using errcode = '23514'; end if;
  if (new.id, new.business_id, new.document_id, new.total, new.payments, new.note, new.created_at)
       is distinct from (old.id, old.business_id, old.document_id, old.total, old.payments, old.note, old.created_at)
     or (new.lead_id is not null and new.lead_id is distinct from old.lead_id)
     or (new.user_id is not null and new.user_id is distinct from old.user_id) then
    raise exception 'a payment plan keeps its payments — it is cancelled and made again' using errcode = '23514'; end if;
  if old.status = 'cancelled' and (new.status, new.cancelled_at, new.cancelled_by, new.cancel_reason)
       is distinct from (old.status, old.cancelled_at, old.cancelled_by, old.cancel_reason) then
    raise exception 'a cancelled plan stays cancelled' using errcode = '23514'; end if;
  return new;
end $$;
revoke execute on function public.payment_plans_guard() from public, anon, authenticated;
create or replace trigger b_payment_plans_guard before update on public.payment_plans
  for each row execute function public.payment_plans_guard();
create or replace trigger b_payment_plan_items_guard before update on public.payment_plan_items
  for each row execute function public.payment_plans_guard();
create or replace trigger payment_plans_no_delete before delete on public.payment_plans
  for each row execute function public.finance_append_only();
create or replace trigger payment_plan_items_no_delete before delete on public.payment_plan_items
  for each row execute function public.finance_append_only();

-- ---- 3a. reminders: the tables (before the policies, which cover them too) -------------------------------------------------
create table if not exists public.debt_reminder_settings (
  business_id uuid primary key references public.businesses on delete restrict,
  enabled     boolean not null default false,
  days        int[] not null default '{3,7,14}',                                   -- days after the due date, ascending
  channel     text not null default 'whatsapp' check (channel in ('email', 'whatsapp')),
  approved_by uuid references auth.users on delete set null,                       -- the owner who turned it on (with these rules)
  approved_at timestamptz,
  updated_by  uuid references auth.users on delete set null,
  updated_at  timestamptz not null default now(),
  check (cardinality(days) between 1 and 5 and 1 <= all (days) and 120 >= all (days)),
  check (not enabled or approved_at is not null)
);

-- "לא לשלוח": a customer who gets no automatic reminder (lifted, never deleted)
create table if not exists public.debt_reminder_stops (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses on delete restrict,
  lead_id     uuid not null references public.leads on delete cascade,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  lifted_at   timestamptz,
  lifted_by   uuid
);
create unique index if not exists debt_reminder_stops_active_uq on public.debt_reminder_stops (lead_id) where lifted_at is null;

-- every reminder the timer queued: once per line (an invoice, or a payment of its plan) and step
create table if not exists public.debt_reminders (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses on delete restrict,
  document_id   uuid not null references public.documents on delete restrict,
  item_id       uuid references public.payment_plan_items on delete restrict,       -- a payment of a plan (null: the invoice)
  lead_id       uuid references public.leads on delete set null,
  step          int not null check (step between 1 and 5),
  days          int not null check (days between 1 and 120),
  due_date      date not null,
  amount        numeric(14,2) not null check (amount > 0),                          -- what was open (when sent: then)
  tone          text not null check (tone in ('friendly', 'firm', 'final')),
  channel       text not null check (channel in ('email', 'whatsapp')),
  to_address    text not null default '' check (length(to_address) <= 120),
  status        text not null default 'queued' check (status in ('queued', 'sent', 'cancelled', 'failed')),
  email_id      uuid,                                                              -- its row in email_outbox (an email)
  created_at    timestamptz not null default now(),
  sent_at       timestamptz,
  sent_by       uuid,                                                              -- who sent it on WhatsApp (an email: null)
  cancelled_at  timestamptz,
  cancel_reason text not null default '' check (cancel_reason in ('', 'paid', 'stopped', 'off', 'changed', 'superseded', 'skipped')),
  error         text not null default '' check (length(error) <= 300),
  check ((status = 'sent') = (sent_at is not null)),
  check ((status = 'cancelled') = (cancelled_at is not null))
);
create unique index if not exists debt_reminders_doc_step_uq on public.debt_reminders (document_id, step) where item_id is null;
create unique index if not exists debt_reminders_item_step_uq on public.debt_reminders (item_id, step) where item_id is not null;
create index if not exists debt_reminders_queued_idx on public.debt_reminders (business_id, created_at) where status = 'queued';
create index if not exists debt_reminders_document_idx on public.debt_reminders (document_id, created_at desc);
create index if not exists debt_reminders_lead_idx on public.debt_reminders (lead_id) where lead_id is not null;

create or replace function public.debt_reminders_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if (new.id, new.business_id, new.document_id, new.item_id, new.step, new.days, new.due_date, new.tone, new.channel, new.created_at)
       is distinct from (old.id, old.business_id, old.document_id, old.item_id, old.step, old.days, old.due_date, old.tone, old.channel, old.created_at)
     or (new.lead_id is not null and new.lead_id is distinct from old.lead_id) then
    raise exception 'a reminder keeps what it is about' using errcode = '23514'; end if;
  if old.status <> 'queued' and (new.status, new.sent_at, new.sent_by, new.cancelled_at, new.cancel_reason, new.amount, new.error)
       is distinct from (old.status, old.sent_at, old.sent_by, old.cancelled_at, old.cancel_reason, old.amount, old.error) then
    raise exception 'a reminder that was sent, cancelled or failed stays so' using errcode = '23514'; end if;
  return new;
end $$;
revoke execute on function public.debt_reminders_guard() from public, anon, authenticated;
create or replace trigger b_debt_reminders_guard before update on public.debt_reminders
  for each row execute function public.debt_reminders_guard();
create or replace trigger debt_reminders_no_delete before delete on public.debt_reminders
  for each row execute function public.finance_append_only();

-- the money screens read these (never a cashier, never a business whose money is closed to the caller); only the functions
-- of this file write them
do $$
declare
  t text; op text;
  gate        constant text := 'business_id = (select public.current_business_id()) and business_id in (select public.accessible_business_ids())';
  fin         constant text := 'business_id in (select public.finance_business_ids())';
  full_access constant text := '(select public.my_access()) <> ''register''';
  writer      constant text := '(select public.can_write())';
begin
  foreach t in array array['payment_plans', 'payment_plan_items', 'debt_reminder_settings', 'debt_reminder_stops', 'debt_reminders'] loop
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
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_business_read') then
      execute format('create policy %I on public.%I for select to authenticated using (%s)', t || '_business_read', t, gate);
    end if;
    foreach op in array array['insert', 'update', 'delete'] loop
      if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_viewer_' || op) then
        execute format('create policy %I on public.%I as restrictive for %s to authenticated %s', t || '_viewer_' || op, t, op,
          case op when 'insert' then format('with check (%s)', writer) when 'update' then format('using (%s) with check (%s)', writer, writer) else format('using (%s)', writer) end);
      end if;
    end loop;
  end loop;
end $$;

-- ---- 1b. making and cancelling a plan (a member who may write the business's money: finance_guard + can_write) ------------
-- Under the invoice's lock (as its receipts and links): the payments add up to the balance exactly, every one later than the
-- one before, none in the past, none more than 5 years ahead. The id is fixed on the device: the same call again is the same plan.
create or replace function public.payment_plan_create(p_id uuid, p_document uuid, p_items jsonb, p_note text default '', p_replace boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  b uuid := public.finance_guard(); d public.documents; pl public.payment_plans; old_id uuid; bal numeric; it jsonb;
  k int := 0; cnt int; amt numeric; dd date; prev date; first_d date; s numeric := 0; today date := public.il_today(); lbl text;
begin
  if not public.can_write() then raise exception 'not allowed' using errcode = '42501'; end if;
  if not public.business_is_active(b) then raise exception 'business_locked' using errcode = '42501'; end if;
  if p_id is null or p_document is null then raise exception 'plan_request: which invoice' using errcode = '22023'; end if;
  select * into d from public.documents where id = p_document and business_id = b for update;
  if d.id is null then raise exception 'plan_not_found' using errcode = '42501'; end if;
  -- the same call again (its answer was lost): the plan it made
  select * into pl from public.payment_plans where id = p_id;
  if pl.id is not null then
    if pl.business_id <> b or pl.document_id <> d.id then raise exception 'plan_request: another plan has this id' using errcode = '22023'; end if;
    return jsonb_build_object('result', 'already', 'plan', pl.id);
  end if;
  if d.doc_type not in (300, 305) then raise exception 'plan_not_invoice: a plan splits an open invoice' using errcode = '23514'; end if;
  if exists (select 1 from public.document_cancellations x where x.document_id = d.id) then
    raise exception 'plan_not_invoice: the invoice was cancelled' using errcode = '23514'; end if;
  select d.total - coalesce((select sum(c.total) from public.documents c where c.business_id = d.business_id and c.doc_type = 330
                               and c.base_doc_type = d.doc_type and c.base_doc_number = d.doc_number), 0)
                 - coalesce((select sum(case p.direction when 'in' then p.amount else -p.amount end) from public.payments p where p.applies_to = d.id), 0)
    into bal;
  if bal <= 0 then raise exception 'plan_paid: nothing is owed on this invoice' using errcode = '23514'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then raise exception 'plan_items: the payments' using errcode = '22023'; end if;
  cnt := jsonb_array_length(p_items);
  if cnt < 2 or cnt > 36 then raise exception 'plan_count: 2 to 36 payments' using errcode = '22023'; end if;
  for it in select e from jsonb_array_elements(p_items) e loop
    k := k + 1;
    begin
      amt := (it->>'amount')::numeric; dd := (it->>'due')::date;
    exception when others then
      raise exception 'plan_items: payment %', k using errcode = '22023';
    end;
    if amt is null or dd is null then raise exception 'plan_items: payment %', k using errcode = '22023'; end if;
    if amt <= 0 or amt <> round(amt, 2) then raise exception 'plan_amount: payment % — more than zero, in agorot', k using errcode = '22023'; end if;
    if dd < today then raise exception 'plan_date: payment % is in the past', k using errcode = '22023'; end if;
    if dd > today + 1830 then raise exception 'plan_date: payment % is more than 5 years ahead', k using errcode = '22023'; end if;
    if prev is not null and dd <= prev then raise exception 'plan_date: payment % is not after the one before it', k using errcode = '22023'; end if;
    if first_d is null then first_d := dd; end if;
    prev := dd; s := s + amt;
  end loop;
  if s <> bal then raise exception 'plan_sum: the payments add up to %, the balance is %', s, bal using errcode = '23514'; end if;
  select x.id into old_id from public.payment_plans x where x.document_id = d.id and x.status = 'active' for update;
  if old_id is not null then
    if not coalesce(p_replace, false) then raise exception 'plan_exists: the invoice already has a plan' using errcode = '23505'; end if;
    update public.payment_plans set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = 'הוחלפה בפריסה חדשה'
     where id = old_id;
    perform public.finance_log(b, 'plan.cancelled', 'documents', d.id::text, jsonb_build_object('plan', old_id, 'reason', 'replaced'));
  end if;
  insert into public.payment_plans (id, business_id, user_id, document_id, lead_id, total, payments, note)
  values (p_id, b, auth.uid(), d.id, d.lead_id, bal, cnt, left(btrim(coalesce(p_note, '')), 300))
  returning * into pl;
  insert into public.payment_plan_items (plan_id, business_id, n, due_date, amount)
  select pl.id, b, x.n::int, (x.e->>'due')::date, (x.e->>'amount')::numeric from jsonb_array_elements(p_items) with ordinality as x(e, n);
  lbl := case d.doc_type when 305 then 'חשבונית מס' else 'חשבונית עסקה' end || ' מס׳ ' || d.doc_number;
  perform public.finance_log(b, 'plan.created', 'documents', d.id::text,
    jsonb_build_object('plan', pl.id, 'total', bal, 'payments', cnt, 'first', first_d, 'last', prev, 'replaced', old_id));
  if d.lead_id is not null and auth.uid() is not null then
    insert into public.lead_activities (user_id, business_id, lead_id, kind, body)
    values (auth.uid(), b, d.lead_id, 'note', format('פריסה לתשלומים: %s · %s תשלומים · ₪%s', lbl, cnt, trim_scale(bal)));
  end if;
  return jsonb_build_object('result', 'ok', 'plan', pl.id);
end $$;

create or replace function public.payment_plan_cancel(p_plan uuid, p_reason text default '') returns jsonb
language plpgsql security definer set search_path = public as $$
declare b uuid := public.finance_guard(); pl public.payment_plans;
begin
  if not public.can_write() then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into pl from public.payment_plans where id = p_plan and business_id = b for update;
  if pl.id is null then raise exception 'plan_not_found' using errcode = '42501'; end if;
  if pl.status = 'cancelled' then return jsonb_build_object('result', 'already'); end if;
  update public.payment_plans set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(),
         cancel_reason = left(btrim(coalesce(p_reason, '')), 300)
   where id = pl.id;
  perform public.finance_log(b, 'plan.cancelled', 'documents', pl.document_id::text, jsonb_build_object('plan', pl.id, 'reason', left(coalesce(p_reason, ''), 120)));
  if pl.lead_id is not null and auth.uid() is not null then
    insert into public.lead_activities (user_id, business_id, lead_id, kind, body)
    values (auth.uid(), b, pl.lead_id, 'note', 'הפריסה לתשלומים בוטלה' || case when btrim(coalesce(p_reason, '')) <> '' then ': ' || left(btrim(p_reason), 200) else '' end);
  end if;
  return jsonb_build_object('result', 'ok');
end $$;

-- ---- 2. what is owed, by date (the caller's row-level security applies: security invoker) -----------------------------------
-- No plan: the invoice is one line — its own due date, its balance (as the receivables view). A plan: a line per payment, in
-- order; what the invoice went down since the plan was made (payments, credits) covers the first payments. More owed than the
-- plan (money given back after it was made): a line of its own, due at the invoice's date. A cancelled invoice has no lines.
create or replace view public.receivable_lines with (security_invoker = true) as
with r as (
  select * from public.receivables where not cancelled
), p as (
  select pl.id as plan_id, pl.document_id, pl.total from public.payment_plans pl where pl.status = 'active'
), i as (
  select it.plan_id, it.id as item_id, it.n, it.due_date, it.amount,
         sum(it.amount) over (partition by it.plan_id order by it.n) as cum, count(*) over (partition by it.plan_id) as of_n
    from public.payment_plan_items it where it.plan_id in (select p.plan_id from p)
)
select r.id as document_id, r.business_id, r.lead_id, r.doc_type, r.doc_number, r.doc_date, r.customer_name, r.customer_phone, r.customer_email,
       r.share_token, r.balance as doc_balance, null::uuid as plan_id, null::uuid as item_id, null::int as n, null::int as of_n,
       r.due_date, r.balance as amount, greatest(r.balance, 0)::numeric(14,2) as open_amount
  from r where not exists (select 1 from p where p.document_id = r.id)
union all
select r.id, r.business_id, r.lead_id, r.doc_type, r.doc_number, r.doc_date, r.customer_name, r.customer_phone, r.customer_email,
       r.share_token, r.balance, p.plan_id, i.item_id, i.n, i.of_n::int, i.due_date, i.amount,
       (i.amount - least(i.amount, greatest(0::numeric, least(p.total, greatest(0::numeric, p.total - r.balance)) - (i.cum - i.amount))))::numeric(14,2)
  from r join p on p.document_id = r.id join i on i.plan_id = p.plan_id
union all
select r.id, r.business_id, r.lead_id, r.doc_type, r.doc_number, r.doc_date, r.customer_name, r.customer_phone, r.customer_email,
       r.share_token, r.balance, p.plan_id, null::uuid, null::int, null::int, coalesce(r.due_date, r.doc_date),
       (r.balance - p.total)::numeric(14,2), (r.balance - p.total)::numeric(14,2)
  from r join p on p.document_id = r.id where r.balance > p.total;
revoke all on public.receivable_lines from anon;
grant select on public.receivable_lines to authenticated;

-- the money screens' numbers: the same function, its "overdue" now by these lines (an invoice without a plan: as before)
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
    select coalesce(sum(amount) filter (where direction = 'in'), 0) as cin, coalesce(sum(amount) filter (where direction = 'out'), 0) as cout,
           coalesce((select jsonb_agg(jsonb_build_object('method', method, 'in', i, 'out', o) order by i desc)
                       from (select method, sum(amount) filter (where direction = 'in') i, sum(amount) filter (where direction = 'out') o
                               from public.payments where business_id = b and paid_on between p_from and p_to group by method) m), '[]'::jsonb) as by_method
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
    'receivables', jsonb_build_object('open', recv.open, 'count', recv.n, 'overdue', recv.overdue, 'overdueCount', recv.overdue_n),
    'pending', jsonb_build_object('count', pend.n, 'total', pend.t),
    'posWithoutDocument', jsonb_build_object('count', nodoc.n, 'total', nodoc.t),
    'allocationMissing', alloc.n,
    'months', coalesce(months.j, '[]'::jsonb),
    'lockedUntil', public.finance_locked_until(b))
  into res from rev, types, et, cash, recv, pend, nodoc, alloc, months;
  return res;
end $$;

-- ---- 3b. reminders: what is due now (one place: the timer queues it, the settings screen shows how many) -----------------------
-- For each open line of the business with a customer card (not marked "לא לשלוח") and a due date: the step = the last rule
-- whose day has come; nothing if a reminder of this line at this step or a later one exists (once per line and step — a step
-- that was missed is not sent late). A line late more than 30 days past the last rule gets nothing automatic (old debts:
-- by hand). The channel: email when chosen and the customer has an address, else the WhatsApp queue (a phone), else nothing.
create or replace function public.debt_reminders_due(p_business uuid, p_days int[], p_channel text, p_today date)
returns table (document_id uuid, item_id uuid, lead_id uuid, step int, days int, due_date date, open_amount numeric, tone text, channel text, to_address text)
language plpgsql stable security definer set search_path = public as $$
declare r record; st int; addr text; ch text; nd int := cardinality(p_days);
begin
  if p_business is null or nd is null or nd < 1 then return; end if;
  for r in
    select l.document_id, l.item_id, l.lead_id, l.due_date, l.open_amount as amt, l.customer_email, l.customer_phone, ld.email as lead_email, ld.phone as lead_phone,
           (p_today - l.due_date) as late
      from public.receivable_lines l join public.leads ld on ld.id = l.lead_id and ld.business_id = l.business_id
     where l.business_id = p_business and l.open_amount > 0 and l.due_date is not null
       and l.due_date <= p_today - p_days[1] and l.due_date >= p_today - (p_days[nd] + 30)
       and not exists (select 1 from public.debt_reminder_stops x where x.lead_id = l.lead_id and x.lifted_at is null)
     order by l.due_date, l.document_id, l.item_id
  loop
    select max(k) into st from generate_subscripts(p_days, 1) k where p_days[k] <= r.late;
    if st is null then continue; end if;
    if exists (select 1 from public.debt_reminders q where q.document_id = r.document_id and q.item_id is not distinct from r.item_id and q.step >= st) then
      continue; end if;
    ch := null; addr := '';
    if p_channel = 'email' then
      addr := coalesce(nullif(btrim(r.lead_email), ''), nullif(btrim(r.customer_email), ''), '');
      if addr ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' and length(addr) <= 120 then ch := 'email'; end if;
    end if;
    if ch is null then
      addr := coalesce(nullif(btrim(r.lead_phone), ''), nullif(btrim(r.customer_phone), ''), '');
      if length(regexp_replace(addr, '\D', '', 'g')) >= 9 then ch := 'whatsapp'; end if;
    end if;
    if ch is null then continue; end if;
    document_id := r.document_id; item_id := r.item_id; lead_id := r.lead_id; step := st; days := p_days[st]; due_date := r.due_date;
    open_amount := r.amt; channel := ch; to_address := left(addr, 120);
    tone := case when st = 1 then 'friendly' when st = nd and nd >= 3 then 'final' else 'firm' end;
    return next;
  end loop;
end $$;

-- may a queued reminder still go? 'ok' with what is open now, else why not: paid, stopped (the customer said no), off,
-- changed (a plan was made or cancelled, the invoice was cancelled)
create or replace function public.debt_reminder_state(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare q public.debt_reminders; l record;
begin
  select * into q from public.debt_reminders where id = p_id;
  if q.id is null then return jsonb_build_object('state', 'not_found'); end if;
  if q.status <> 'queued' then return jsonb_build_object('state', q.status); end if;
  if not coalesce((select s.enabled from public.debt_reminder_settings s where s.business_id = q.business_id), false)
     or not public.business_is_active(q.business_id) then return jsonb_build_object('state', 'off'); end if;
  if q.lead_id is null or exists (select 1 from public.debt_reminder_stops x where x.lead_id = q.lead_id and x.lifted_at is null) then
    return jsonb_build_object('state', 'stopped'); end if;
  select * into l from public.receivable_lines x
   where x.document_id = q.document_id and x.business_id = q.business_id
     and ((q.item_id is null and x.item_id is null and x.plan_id is null) or x.item_id = q.item_id)
   limit 1;
  if not found then return jsonb_build_object('state', 'changed'); end if;
  if l.open_amount <= 0 then return jsonb_build_object('state', 'paid'); end if;
  return jsonb_build_object('state', 'ok', 'open', l.open_amount, 'due', l.due_date, 'n', l.n, 'of', l.of_n, 'docType', l.doc_type,
    'docNumber', l.doc_number, 'customer', l.customer_name, 'shareToken', l.share_token, 'lead', q.lead_id, 'step', q.step, 'tone', q.tone);
end $$;

-- a reminder's words as the customer card keeps them
create or replace function public.debt_reminder_label(p_state jsonb) returns text
language sql stable set search_path = public as $$
  select case (p_state->>'docType')::int when 305 then 'חשבונית מס' else 'חשבונית עסקה' end || ' מס׳ ' || (p_state->>'docNumber')
         || case when p_state->>'n' is not null then format(' (תשלום %s מתוך %s)', p_state->>'n', p_state->>'of') else '' end
         || ' · ₪' || trim_scale((p_state->>'open')::numeric)
$$;

-- ---- 3c. the timer (the dashboard's server: /api/cron/commerce) ----------------------------------------------------------------
-- First, what was queued and may not go any more is cancelled (paid meanwhile, the customer said no, reminders off, the plan
-- changed) — an email already being sent is checked again just before it goes (debt_reminder_check). Then, only on the hours
-- customers expect a message (09:00–19:00 Israel time, not on Saturday), the new ones: an email goes to the outbox (sent by
-- the same run), a WhatsApp one waits in the owner's queue. Two runs at once queue nothing twice (unique line and step).
create or replace function public.debt_reminders_queue(p_now timestamptz default now(), p_limit int default 200) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t timestamp := p_now at time zone 'Asia/Jerusalem'; today date := (p_now at time zone 'Asia/Jerusalem')::date;
  r record; s record; rid uuid; eid uuid; st text; n_cancel int := 0; n_mail int := 0; n_wa int := 0; n_left int := greatest(coalesce(p_limit, 200), 1);
  wa_biz jsonb := '{}'::jsonb;
begin
  for r in select q.id from public.debt_reminders q
            where q.status = 'queued'
              and (q.channel = 'whatsapp' or q.email_id is null
                   or exists (select 1 from public.email_outbox o where o.id = q.email_id and o.status = 'queued'))
  loop
    st := public.debt_reminder_state(r.id)->>'state';
    if st <> 'ok' then
      update public.debt_reminders set status = 'cancelled', cancelled_at = now(), cancel_reason = st
       where id = r.id and status = 'queued' and st in ('paid', 'stopped', 'off', 'changed');
      if found then n_cancel := n_cancel + 1; end if;
    end if;
  end loop;
  if extract(isodow from t) = 6 or extract(hour from t) < 9 or extract(hour from t) >= 19 then
    return jsonb_build_object('cancelled', n_cancel, 'emails', 0, 'whatsapp', 0, 'quiet', true, 'businesses', '{}'::jsonb);
  end if;
  for s in select x.business_id, x.days, x.channel from public.debt_reminder_settings x
            where x.enabled and public.business_is_active(x.business_id) order by x.business_id loop
    for r in select * from public.debt_reminders_due(s.business_id, s.days, s.channel, today) loop
      exit when n_left <= 0;
      -- an earlier step of this line still waiting in the WhatsApp queue: this one takes its place
      update public.debt_reminders set status = 'cancelled', cancelled_at = now(), cancel_reason = 'superseded'
       where document_id = r.document_id and item_id is not distinct from r.item_id and status = 'queued' and step < r.step;
      rid := null;
      insert into public.debt_reminders (business_id, document_id, item_id, lead_id, step, days, due_date, amount, tone, channel, to_address)
      values (s.business_id, r.document_id, r.item_id, r.lead_id, r.step, r.days, r.due_date, r.open_amount, r.tone, r.channel, r.to_address)
      on conflict do nothing
      returning id into rid;
      if rid is null then continue; end if;
      n_left := n_left - 1;
      if r.channel = 'email' then
        insert into public.email_outbox (business_id, kind, reminder_id, to_email) values (s.business_id, 'debt_reminder', rid, r.to_address)
        returning id into eid;
        update public.debt_reminders set email_id = eid where id = rid;
        n_mail := n_mail + 1;
      else
        n_wa := n_wa + 1;
        wa_biz := jsonb_set(wa_biz, array[s.business_id::text], to_jsonb(coalesce((wa_biz->>s.business_id::text)::int, 0) + 1));
      end if;
    end loop;
  end loop;
  return jsonb_build_object('cancelled', n_cancel, 'emails', n_mail, 'whatsapp', n_wa, 'quiet', false, 'businesses', wa_biz);
end $$;

-- the server, just before a reminder's email goes: still allowed? (if not, it is cancelled here, with why)
create or replace function public.debt_reminder_check(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s jsonb := public.debt_reminder_state(p_id);
begin
  if s->>'state' in ('paid', 'stopped', 'off', 'changed') then
    update public.debt_reminders set status = 'cancelled', cancelled_at = now(), cancel_reason = s->>'state' where id = p_id and status = 'queued';
  end if;
  return s;
end $$;

-- an email's answer (from email_outbox_done): sent → kept on the customer's card and in the log; failed → failed
create or replace function public.debt_reminder_emailed(p_id uuid, p_ok boolean, p_error text default '') returns void
language plpgsql security definer set search_path = public as $$
declare q public.debt_reminders; s jsonb; who uuid;
begin
  if p_ok then
    update public.debt_reminders set status = 'sent', sent_at = now() where id = p_id and status = 'queued' returning * into q;
    if not found then return; end if;
    select jsonb_build_object('docType', d.doc_type, 'docNumber', d.doc_number, 'open', q.amount,
                              'n', (select it.n from public.payment_plan_items it where it.id = q.item_id),
                              'of', (select pl.payments from public.payment_plan_items it join public.payment_plans pl on pl.id = it.plan_id where it.id = q.item_id))
      into s from public.documents d where d.id = q.document_id;
    who := public.commerce_owner(q.business_id);
    if q.lead_id is not null and who is not null then
      insert into public.lead_activities (user_id, business_id, lead_id, kind, body)
      values (who, q.business_id, q.lead_id, 'email', 'תזכורת תשלום אוטומטית במייל: ' || public.debt_reminder_label(s));
    end if;
    perform public.finance_log(q.business_id, 'reminder.sent', 'documents', q.document_id::text,
      jsonb_build_object('reminder', q.id, 'step', q.step, 'channel', 'email', 'open', q.amount, 'item', q.item_id, 'auto', true));
  else
    update public.debt_reminders set status = 'failed', error = left(coalesce(p_error, ''), 300) where id = p_id and status = 'queued';
  end if;
end $$;

-- ---- 3d. the owner's side (the browser; a member who may write the money) ---------------------------------------------------
-- the rules: turning reminders ON (or changing them while on) is the owner's — the approval is kept with who and when; turning
-- them off is anyone's who may write, and what waits in the queue is cancelled at once
create or replace function public.debt_reminders_configure(p_enabled boolean, p_days int[], p_channel text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b uuid := public.finance_guard(); d int[]; s public.debt_reminder_settings; is_owner boolean; n int;
begin
  if not public.can_write() then raise exception 'not allowed' using errcode = '42501'; end if;
  if coalesce(p_channel, '') not in ('email', 'whatsapp') then raise exception 'reminders_channel: email or whatsapp' using errcode = '22023'; end if;
  select array_agg(distinct x order by x) into d from unnest(coalesce(p_days, '{}'::int[])) x where x is not null;
  if d is null or cardinality(d) < 1 or cardinality(d) > 5 or d[1] < 1 or d[cardinality(d)] > 120 then
    raise exception 'reminders_days: 1 to 5 days, each 1 to 120' using errcode = '22023'; end if;
  is_owner := exists (select 1 from public.business_members m where m.business_id = b and m.user_id = auth.uid() and m.role = 'owner' and m.access = 'full');
  if coalesce(p_enabled, false) then
    if not is_owner then raise exception 'reminders_owner: only the business owner turns reminders on' using errcode = '42501'; end if;
    insert into public.debt_reminder_settings as x (business_id, enabled, days, channel, approved_by, approved_at, updated_by, updated_at)
    values (b, true, d, p_channel, auth.uid(), now(), auth.uid(), now())
    on conflict (business_id) do update set enabled = true, days = excluded.days, channel = excluded.channel, approved_by = auth.uid(),
      approved_at = now(), updated_by = auth.uid(), updated_at = now()
    returning * into s;
    perform public.finance_log(b, 'reminders.enabled', 'debt_reminder_settings', b::text, jsonb_build_object('days', to_jsonb(d), 'channel', p_channel));
  else
    insert into public.debt_reminder_settings as x (business_id, enabled, days, channel, updated_by, updated_at)
    values (b, false, d, p_channel, auth.uid(), now())
    on conflict (business_id) do update set enabled = false, days = excluded.days, channel = excluded.channel, updated_by = auth.uid(), updated_at = now()
    returning * into s;
    update public.debt_reminders set status = 'cancelled', cancelled_at = now(), cancel_reason = 'off'
     where business_id = b and status = 'queued'
       and (channel = 'whatsapp' or email_id is null or exists (select 1 from public.email_outbox o where o.id = email_id and o.status = 'queued'));
    get diagnostics n = row_count;
    perform public.finance_log(b, 'reminders.disabled', 'debt_reminder_settings', b::text, jsonb_build_object('days', to_jsonb(d), 'channel', p_channel, 'cancelled', n));
  end if;
  return to_jsonb(s);
end $$;

-- how many open debts would get a reminder now with these rules (the screen where the owner approves)
create or replace function public.debt_reminders_preview(p_days int[], p_channel text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare b uuid := public.finance_guard(); d int[];
begin
  select array_agg(distinct x order by x) into d from unnest(coalesce(p_days, '{}'::int[])) x where x is not null and x between 1 and 120;
  if d is null then return jsonb_build_object('email', 0, 'whatsapp', 0); end if;
  return (select jsonb_build_object('email', count(*) filter (where q.channel = 'email'), 'whatsapp', count(*) filter (where q.channel = 'whatsapp'))
            from public.debt_reminders_due(b, d[1:5], case when p_channel = 'email' then 'email' else 'whatsapp' end, public.il_today()) q);
end $$;

-- "לא לשלוח" on a customer (or lifting it): logged, on their card, and what waits for them is cancelled
create or replace function public.debt_reminders_stop(p_lead uuid, p_stop boolean) returns boolean
language plpgsql security definer set search_path = public as $$
declare b uuid := public.finance_guard();
begin
  if not public.can_write() then raise exception 'not allowed' using errcode = '42501'; end if;
  if not exists (select 1 from public.leads l where l.id = p_lead and l.business_id = b) then raise exception 'reminder_not_found' using errcode = '42501'; end if;
  if coalesce(p_stop, false) then
    if exists (select 1 from public.debt_reminder_stops x where x.lead_id = p_lead and x.lifted_at is null) then return true; end if;
    insert into public.debt_reminder_stops (business_id, lead_id, created_by) values (b, p_lead, auth.uid()) on conflict do nothing;
    update public.debt_reminders set status = 'cancelled', cancelled_at = now(), cancel_reason = 'stopped'
     where lead_id = p_lead and business_id = b and status = 'queued'
       and (channel = 'whatsapp' or email_id is null or exists (select 1 from public.email_outbox o where o.id = email_id and o.status = 'queued'));
    perform public.finance_log(b, 'reminders.stopped', 'leads', p_lead::text, '{}'::jsonb);
    insert into public.lead_activities (user_id, business_id, lead_id, kind, body) values (auth.uid(), b, p_lead, 'note', 'סומן/ה "לא לשלוח" תזכורות חוב');
    return true;
  end if;
  update public.debt_reminder_stops set lifted_at = now(), lifted_by = auth.uid() where lead_id = p_lead and business_id = b and lifted_at is null;
  if found then
    perform public.finance_log(b, 'reminders.resumed', 'leads', p_lead::text, '{}'::jsonb);
    insert into public.lead_activities (user_id, business_id, lead_id, kind, body) values (auth.uid(), b, p_lead, 'note', 'תזכורות חוב — חזרו לפעול');
  end if;
  return false;
end $$;

-- the WhatsApp queue: the owner taps "שליחה" — asked again first (paid meanwhile → not sent, and cancelled); else it is sent
-- now (WhatsApp opens with the text), kept on the customer's card and in the log
create or replace function public.debt_reminder_whatsapp(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b uuid := public.finance_guard(); q public.debt_reminders; s jsonb;
begin
  if not public.can_write() then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into q from public.debt_reminders where id = p_id and business_id = b for update;
  if q.id is null or q.channel <> 'whatsapp' then raise exception 'reminder_not_found' using errcode = '42501'; end if;
  if q.status <> 'queued' then return jsonb_build_object('result', q.status); end if;
  s := public.debt_reminder_state(q.id);
  if s->>'state' <> 'ok' then
    if s->>'state' in ('paid', 'stopped', 'off', 'changed') then
      update public.debt_reminders set status = 'cancelled', cancelled_at = now(), cancel_reason = s->>'state' where id = q.id;
    end if;
    return jsonb_build_object('result', s->>'state');
  end if;
  update public.debt_reminders set status = 'sent', sent_at = now(), sent_by = auth.uid(), amount = (s->>'open')::numeric where id = q.id;
  insert into public.lead_activities (user_id, business_id, lead_id, kind, body)
  values (auth.uid(), b, q.lead_id, 'whatsapp', 'תזכורת תשלום בוואטסאפ: ' || public.debt_reminder_label(s));
  perform public.finance_log(b, 'reminder.sent', 'documents', q.document_id::text,
    jsonb_build_object('reminder', q.id, 'step', q.step, 'channel', 'whatsapp', 'open', s->'open', 'item', q.item_id, 'auto', true));
  return jsonb_build_object('result', 'ok') || s;
end $$;

-- "לא עכשיו": the owner lets one go (logged); the next step comes on its day
create or replace function public.debt_reminder_skip(p_id uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare b uuid := public.finance_guard(); q public.debt_reminders;
begin
  if not public.can_write() then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.debt_reminders set status = 'cancelled', cancelled_at = now(), cancel_reason = 'skipped'
   where id = p_id and business_id = b and status = 'queued' and channel = 'whatsapp' returning * into q;
  if not found then return false; end if;
  perform public.finance_log(b, 'reminder.skipped', 'documents', q.document_id::text, jsonb_build_object('reminder', q.id, 'step', q.step));
  return true;
end $$;

-- ---- 3e. a reminder's email in the one outbox ---------------------------------------------------------------------------------
alter table public.email_outbox add column if not exists reminder_id uuid references public.debt_reminders on delete cascade;
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'email_outbox_kind_check' and conrelid = 'public.email_outbox'::regclass
              and pg_get_constraintdef(oid) not like '%debt_reminder%') then
    alter table public.email_outbox drop constraint email_outbox_kind_check;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'email_outbox_kind_check' and conrelid = 'public.email_outbox'::regclass) then
    alter table public.email_outbox add constraint email_outbox_kind_check
      check (kind in ('order_confirmation', 'order_ready', 'order_shipped', 'order_refunded', 'payment_link', 'debt_reminder'));
  end if;
  if exists (select 1 from pg_constraint where conname = 'email_outbox_about_check' and conrelid = 'public.email_outbox'::regclass
              and pg_get_constraintdef(oid) not like '%debt_reminder%') then
    alter table public.email_outbox drop constraint email_outbox_about_check;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'email_outbox_about_check' and conrelid = 'public.email_outbox'::regclass) then
    alter table public.email_outbox add constraint email_outbox_about_check
      check ((kind not in ('payment_link', 'debt_reminder') and order_id is not null and store_id is not null and request_id is null and reminder_id is null)
             or (kind = 'payment_link' and request_id is not null and order_id is null and reminder_id is null)
             or (kind = 'debt_reminder' and reminder_id is not null and order_id is null and request_id is null));
  end if;
end $$;
create unique index if not exists email_outbox_reminder_uq on public.email_outbox (reminder_id) where reminder_id is not null;

-- as in 4300, and a reminder's email tells its reminder (sent: on the customer's card and in the log; failed: failed)
create or replace function public.email_outbox_done(p_id uuid, p_provider_id text, p_error text default '', p_final boolean default false)
returns text language plpgsql security definer set search_path = public as $$
declare e public.email_outbox;
begin
  select * into e from public.email_outbox where id = p_id for update;
  if e.id is null then return 'not_found'; end if;
  if e.status = 'sent' then return 'sent'; end if;
  if btrim(coalesce(p_provider_id, '')) <> '' then
    update public.email_outbox set status = 'sent', provider_id = left(btrim(p_provider_id), 120), sent_at = now(), last_error = '', updated_at = now()
     where id = e.id;
    if e.order_id is not null then perform public.order_event(e.order_id, 'email_sent', jsonb_build_object('kind', e.kind)); end if;
    if e.reminder_id is not null then perform public.debt_reminder_emailed(e.reminder_id, true); end if;
    return 'sent';
  end if;
  if p_final or e.attempts >= 5 then
    update public.email_outbox set status = 'failed', last_error = left(coalesce(p_error, ''), 300), updated_at = now() where id = e.id;
    if e.order_id is not null then
      perform public.order_event(e.order_id, 'email_failed', jsonb_build_object('kind', e.kind, 'error', left(coalesce(p_error, ''), 120)));
      perform public.store_alert(e.order_id, 'email_failed', 'מייל ללקוח לא נשלח: ' || left(coalesce(p_error, ''), 200));
    end if;
    if e.reminder_id is not null then perform public.debt_reminder_emailed(e.reminder_id, false, p_error); end if;
    return 'failed';
  end if;
  update public.email_outbox set status = 'queued', last_error = left(coalesce(p_error, ''), 300), updated_at = now() where id = e.id;
  return 'queued';
end $$;

-- ---- 4. a duplicate expense: a warning, never a block ------------------------------------------------------------------------
alter table public.expenses add column if not exists file_sha256 text;
alter table public.expenses add column if not exists duplicate_ack jsonb;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'expenses_file_sha256_check') then
    alter table public.expenses add constraint expenses_file_sha256_check check (file_sha256 is null or file_sha256 ~ '^[0-9a-f]{64}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'expenses_duplicate_ack_check') then
    alter table public.expenses add constraint expenses_duplicate_ack_check
      check (duplicate_ack is null or (jsonb_typeof(duplicate_ack) = 'object' and pg_column_size(duplicate_ack) <= 2000));
  end if;
end $$;
create index if not exists expenses_file_sha256_idx on public.expenses (business_id, file_sha256) where file_sha256 is not null;

-- the file's fingerprint is the file's (it stays); "זו הוצאה אחרת" keeps which expenses and why — who and when come from
-- here, never from the browser, and it is not taken back
create or replace function public.expenses_duplicate_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
declare ofs jsonb; rs jsonb;
begin
  if tg_op = 'UPDATE' then
    if old.file_sha256 is not null then new.file_sha256 := old.file_sha256; end if;
    if new.duplicate_ack is null or new.duplicate_ack is not distinct from old.duplicate_ack then
      new.duplicate_ack := old.duplicate_ack; return new;
    end if;
  elsif new.duplicate_ack is null then
    return new;
  end if;
  ofs := new.duplicate_ack->'of'; rs := new.duplicate_ack->'reasons';
  if jsonb_typeof(ofs) is distinct from 'array' or jsonb_typeof(rs) is distinct from 'array'
     or jsonb_array_length(ofs) not between 1 and 10 or jsonb_array_length(rs) not between 1 and 3
     or exists (select 1 from jsonb_array_elements(rs) x where jsonb_typeof(x) <> 'string' or x #>> '{}' not in ('file', 'number', 'amount_date'))
     or exists (select 1 from jsonb_array_elements(ofs) x where jsonb_typeof(x) <> 'string' or x #>> '{}' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
    raise exception 'duplicate_ack: which expenses and why' using errcode = '22023';
  end if;
  new.duplicate_ack := jsonb_build_object('of', ofs, 'reasons', rs, 'by', auth.uid(), 'at', now());
  return new;
end $$;
revoke execute on function public.expenses_duplicate_stamp() from public, anon, authenticated;
create or replace trigger c_expenses_duplicate before insert or update on public.expenses
  for each row execute function public.expenses_duplicate_stamp();

create or replace function public.expenses_duplicate_log() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.duplicate_ack is not null and (tg_op = 'INSERT' or new.duplicate_ack is distinct from old.duplicate_ack) then
    perform public.finance_log(new.business_id, 'expense.not_duplicate', 'expenses', new.id::text,
      jsonb_build_object('number', new.expense_number, 'of', new.duplicate_ack->'of', 'reasons', new.duplicate_ack->'reasons'));
  end if;
  return null;
end $$;
revoke execute on function public.expenses_duplicate_log() from public, anon, authenticated;
create or replace trigger expenses_duplicate_log after insert or update on public.expenses
  for each row execute function public.expenses_duplicate_log();

-- the same supplier: both dealer numbers when both have one, else the name in letters (Latin / Hebrew) and digits only;
-- the same document number: letters and digits only, no leading zeros (features/finance/expenses.ts does the same)
create or replace function public.expense_norm_supplier(p text) returns text
language sql immutable set search_path = public as $$
  select regexp_replace(lower(coalesce(p, '')), '[^0-9a-zא-ת]+', '', 'g')
$$;
create or replace function public.expense_norm_number(p text) returns text
language sql immutable set search_path = public as $$
  select case when x = '' then '' when ltrim(x, '0') = '' then '0' else ltrim(x, '0') end
    from (select regexp_replace(lower(coalesce(p, '')), '[^0-9a-zא-ת]+', '', 'g') as x) y
$$;

-- what this expense may repeat (the caller's row-level security applies: security invoker; a void one does not count):
--   file         the same file (its sha256)
--   number       the same supplier and the same document number
--   amount_date  the same supplier, the same total and the same date
create or replace function public.expense_duplicates(p_sha text, p_dealer text, p_supplier text, p_doc_number text, p_total numeric,
                                                    p_doc_date date, p_exclude uuid default null)
returns table (id uuid, expense_number bigint, doc_date date, created_at timestamptz, supplier_name text, supplier_doc_number text,
               total numeric, status text, reasons text[])
language sql stable security invoker set search_path = public as $$
  with a as (
    select (coalesce(p_sha, '') ~ '^[0-9a-f]{64}$') as has_sha, coalesce(p_dealer, '') ~ '^[0-9]{9}$' as has_dealer,
           public.expense_norm_supplier(p_supplier) as sup, public.expense_norm_number(p_doc_number) as num
  ), x as (
    select e.*,
           (a.has_sha and e.file_sha256 = p_sha) as same_file,
           (case when a.has_dealer and e.supplier_dealer ~ '^[0-9]{9}$' then e.supplier_dealer = p_dealer
                 else a.sup <> '' and public.expense_norm_supplier(e.supplier_name) = a.sup end) as same_supplier,
           a.num as num
      from public.expenses e, a
     where e.business_id = public.current_business_id() and e.status <> 'void' and (p_exclude is null or e.id <> p_exclude)
       and ((a.has_sha and e.file_sha256 = p_sha) or (a.has_dealer and e.supplier_dealer = p_dealer)
            or (a.sup <> '' and public.expense_norm_supplier(e.supplier_name) = a.sup))
  ), y as (
    select x.*, x.same_supplier and x.num <> '' and public.expense_norm_number(x.supplier_doc_number) = x.num as same_number,
           x.same_supplier and p_total is not null and p_doc_date is not null and x.total = p_total and x.doc_date = p_doc_date as same_amount_date
      from x
  )
  select y.id, y.expense_number, y.doc_date, y.created_at, y.supplier_name, y.supplier_doc_number, y.total, y.status,
         array_remove(array[case when y.same_file then 'file' end, case when y.same_number then 'number' end,
                            case when y.same_amount_date then 'amount_date' end], null)
    from y
   where y.same_file or y.same_number or y.same_amount_date
   order by y.same_file desc, y.created_at desc
   limit 5
$$;

-- ---- 5. who runs what ----------------------------------------------------------------------------------------------------------
do $$
declare f text;
begin
  -- a signed-in member (each checks finance_guard / the caller's own row-level security)
  foreach f in array array['public.payment_plan_create(uuid, uuid, jsonb, text, boolean)', 'public.payment_plan_cancel(uuid, text)',
    'public.debt_reminders_configure(boolean, int[], text)', 'public.debt_reminders_preview(int[], text)', 'public.debt_reminders_stop(uuid, boolean)',
    'public.debt_reminder_whatsapp(uuid)', 'public.debt_reminder_skip(uuid)',
    'public.expense_duplicates(text, text, text, text, numeric, date, uuid)', 'public.expense_norm_supplier(text)', 'public.expense_norm_number(text)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  -- the dashboard's server (service role) only
  foreach f in array array['public.debt_reminders_due(uuid, int[], text, date)', 'public.debt_reminder_state(uuid)',
    'public.debt_reminders_queue(timestamptz, int)', 'public.debt_reminder_check(uuid)', 'public.debt_reminder_emailed(uuid, boolean, text)',
    'public.debt_reminder_label(jsonb)',
    'public.email_outbox_done(uuid, text, text, boolean)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- ============================================================================================================================
-- Rollback (by hand, if ever needed — the plans, the reminders and their log go with it):
--   finance_summary back to its text in 20261004003100; email_outbox_done back to its text in 20261010004300; email_outbox:
--   delete the debt_reminder rows, the two checks back to their text in 4300, drop column reminder_id; drop the functions of
--   sections 1b, 3b–3d and 4 (payment_plan_*, debt_reminder*, expense_duplicates, expense_norm_*, expenses_duplicate_*) and
--   the triggers c_expenses_duplicate / expenses_duplicate_log; drop view receivable_lines; drop tables debt_reminders,
--   debt_reminder_stops, debt_reminder_settings, payment_plan_items, payment_plans (and payment_plans_guard,
--   debt_reminders_guard); expenses: drop the two checks and the columns file_sha256 / duplicate_ack.
-- ============================================================================================================================
