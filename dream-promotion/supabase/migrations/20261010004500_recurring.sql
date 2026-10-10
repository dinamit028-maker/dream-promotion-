-- ============================================================================================================================
-- Migration 20261010004500 — recurring charges: a retainer, a monthly subscription, a standing order (docs/FINANCE_ADDITIONS_HE.md,
-- T4; 2.90.0). Prepared only: NOT applied to the live database (needs the owner's explicit approval). Runs after 4400 (and
-- so after 4300: a charge's link is a payment link of 4300). Tested on a local Postgres: tests/sql/recurring.check.sql and
-- tests/sql/concurrency.sh §16.
--
--   1. plans     recurring_plans: a customer, the lines, how often (every 1 / 2 / 3 / 6 / 12 months, on a day 1–28), from when
--                and until when, what is made each time — an invoice at once, or a draft the owner issues — and whether a
--                payment link goes with it. Active / paused / ended; never deleted. Pausing and ending stop the charges to
--                come and never touch what was already issued; a paused period is not charged late.
--   2. charges   recurring_charges: one per plan and period (the unique key of the doc: plan + period) — a run again, or two at
--                once, never makes a second. The dashboard's timer (/api/cron/commerce) makes them on their day (08:00–20:00
--                Israel time, not on Saturday), claims them and issues them through the existing documents (the key
--                recurring:<plan>:<period>) or as a draft (whose id is the charge's: issuing it marks the charge issued); a
--                blocked one waits for "נסו שוב".
--   3. money     no card and no bank account is ever charged here (an automatic charge is a separate stage, after an explicit
--                approval): each charge is a document, and — when the business's terminal is connected and checked — a
--                payment link (4300). A standing order: no link — the bank pays, a receipt is recorded when the money comes.
-- No statement here removes or changes an existing row, and none drops anything. The rollback at the end is a comment.
-- ============================================================================================================================

-- 4300 / 4400 first: a charge's link is a payment link of 4300; the timer that runs it is the one 4400 extended
do $$
begin
  if to_regclass('public.payment_requests') is null or to_regclass('public.payment_plans') is null then
    raise exception 'run 20261010004300_payment_links.sql and 20261010004400_plans_reminders.sql first' using errcode = '55000';
  end if;
end $$;

-- ---- 1. the schedule: the k-th date of a plan, and the first one on or after a day ---------------------------------------------
-- the anchor is the month of the start date; every_months later, on day_of_month (1–28: every month has it). Calendar arithmetic
-- only (a timestamp without a time zone), so the same in every session.
create or replace function public.recurring_date(p_anchor date, p_every int, p_day int, p_k int) returns date
language sql immutable set search_path = public as $$
  select (date_trunc('month', p_anchor::timestamp) + make_interval(months => p_every * p_k))::date + (p_day - 1)
$$;
create or replace function public.recurring_on_or_after(p_anchor date, p_every int, p_day int, p_from date) returns date
language plpgsql immutable set search_path = public as $$
declare k int; d date;
begin
  if p_anchor is null or p_every is null or p_every < 1 or p_day is null or p_day not between 1 and 28 or p_from is null then return null; end if;
  k := greatest(0, (((extract(year from p_from) - extract(year from p_anchor)) * 12 + extract(month from p_from) - extract(month from p_anchor))::int / p_every) - 1);
  loop
    d := public.recurring_date(p_anchor, p_every, p_day, k);
    exit when d >= p_from and d >= p_anchor;
    k := k + 1;
  end loop;
  return d;
end $$;

-- ---- 2. the tables ---------------------------------------------------------------------------------------------------------------
create table if not exists public.recurring_plans (
  id                 uuid primary key default gen_random_uuid(),
  business_id        uuid not null references public.businesses on delete restrict,
  user_id            uuid references auth.users on delete set null,                -- who made it
  lead_id            uuid not null,                                                -- the customer (the charges are on the card)
  name               text not null check (length(btrim(name)) between 1 and 120),  -- "ריטיינר חודשי — שיווק"
  lines              jsonb not null check (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) between 1 and 30 and pg_column_size(lines) <= 20000),
  prices_include_vat boolean not null default true,
  amount             numeric(14,2) not null check (amount > 0 and amount <= 1000000),  -- the total per period the owner saw (the server issues it only when the lines still add up to it)
  every_months       int not null check (every_months in (1, 2, 3, 6, 12)),
  day_of_month       int not null check (day_of_month between 1 and 28),
  start_date         date not null,
  end_date           date,
  next_date          date not null,                                                -- the next period's date (the timer moves it)
  mode               text not null default 'issue' check (mode in ('issue', 'draft')), -- an invoice at once, or a draft for the owner
  send_link          boolean not null default true,                                -- a payment link with each invoice (when the terminal is ready)
  status             text not null default 'active' check (status in ('active', 'paused', 'ended')),
  note               text not null default '' check (length(note) <= 300),
  paused_at          timestamptz,
  ended_at           timestamptz,
  end_reason         text not null default '' check (length(end_reason) <= 300),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- the customer is the business's own; a customer with a plan is not deleted (as with a package)
  foreign key (lead_id, business_id) references public.leads (id, business_id),
  check (end_date is null or end_date >= start_date),
  check ((status = 'paused') = (paused_at is not null)),
  check ((status = 'ended') = (ended_at is not null))
);
create unique index if not exists recurring_plans_key_uq on public.recurring_plans (id, business_id);
create index if not exists recurring_plans_business_idx on public.recurring_plans (business_id, status, next_date);
create index if not exists recurring_plans_lead_idx on public.recurring_plans (business_id, lead_id);
create index if not exists recurring_plans_due_idx on public.recurring_plans (next_date) where status = 'active';

create table if not exists public.recurring_charges (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses on delete restrict,
  plan_id      uuid not null,
  period_date  date not null,
  status       text not null default 'pending' check (status in ('pending', 'draft', 'issued', 'blocked')),
  document_id  uuid references public.documents on delete restrict,
  draft_id     uuid references public.document_drafts on delete set null,          -- the owner may delete a draft: "not this period"
  paylink_id   uuid references public.payment_requests on delete restrict,
  note         text not null default '' check (length(note) <= 300),              -- e.g. why no link went with it
  error        text not null default '' check (length(error) <= 300),             -- why it was blocked
  attempts     int not null default 0,
  claimed_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  foreign key (plan_id, business_id) references public.recurring_plans (id, business_id),
  unique (plan_id, period_date),
  check (status <> 'issued' or document_id is not null),
  check (status <> 'blocked' or error <> '')
);
create index if not exists recurring_charges_business_idx on public.recurring_charges (business_id, created_at desc);
create index if not exists recurring_charges_pending_idx on public.recurring_charges (period_date) where status = 'pending';
create unique index if not exists recurring_charges_document_uq on public.recurring_charges (document_id) where document_id is not null;

-- what never changes on a plan (its customer, its business), its schedule once it charged (a new plan instead), an ended plan;
-- a charge keeps its plan and period, and only moves forward (pending → draft / issued / blocked; blocked → pending, "נסו שוב";
-- a draft → issued, when the owner issues it)
create or replace function public.recurring_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_table_name = 'recurring_plans' then
    if (new.id, new.business_id, new.lead_id, new.created_at) is distinct from (old.id, old.business_id, old.lead_id, old.created_at)
       or (new.user_id is not null and new.user_id is distinct from old.user_id) then
      raise exception 'a recurring plan keeps its customer and business' using errcode = '23514'; end if;
    -- an ended plan stays as it was (only who made it may become empty, when that user is removed)
    if old.status = 'ended' and (to_jsonb(new) - 'user_id' - 'updated_at') is distinct from (to_jsonb(old) - 'user_id' - 'updated_at') then
      raise exception 'an ended plan stays as it was' using errcode = '23514'; end if;
    if (new.every_months, new.day_of_month, new.start_date) is distinct from (old.every_months, old.day_of_month, old.start_date)
       and exists (select 1 from public.recurring_charges c where c.plan_id = old.id) then
      raise exception 'recurring_schedule: a plan that charged keeps its schedule — end it and make a new one' using errcode = '23514'; end if;
    new.updated_at := now();
    return new;
  end if;
  if (new.id, new.business_id, new.plan_id, new.period_date, new.created_at) is distinct from (old.id, old.business_id, old.plan_id, old.period_date, old.created_at) then
    raise exception 'a charge keeps its plan and period' using errcode = '23514'; end if;
  if new.status is distinct from old.status and not (
       (old.status = 'pending' and new.status in ('draft', 'issued', 'blocked'))
    or (old.status = 'blocked' and new.status in ('pending', 'draft', 'issued'))
    or (old.status = 'draft' and new.status = 'issued')) then
    raise exception 'a charge only moves forward (% → %)', old.status, new.status using errcode = '23514'; end if;
  if old.document_id is not null and new.document_id is distinct from old.document_id then
    raise exception 'a charge keeps its document' using errcode = '23514'; end if;
  if old.paylink_id is not null and new.paylink_id is distinct from old.paylink_id then
    raise exception 'a charge keeps its payment link' using errcode = '23514'; end if;
  new.updated_at := now();
  return new;
end $$;
revoke execute on function public.recurring_guard() from public, anon, authenticated;
create or replace trigger b_recurring_plans_guard before update on public.recurring_plans for each row execute function public.recurring_guard();
create or replace trigger b_recurring_charges_guard before update on public.recurring_charges for each row execute function public.recurring_guard();
create or replace trigger recurring_plans_no_delete before delete on public.recurring_plans for each row execute function public.finance_append_only();
create or replace trigger recurring_charges_no_delete before delete on public.recurring_charges for each row execute function public.finance_append_only();

-- the money screens read them (never a cashier, never a business whose money is closed to the caller); only the functions write
do $$
declare
  t text; op text;
  gate        constant text := 'business_id = (select public.current_business_id()) and business_id in (select public.accessible_business_ids())';
  fin         constant text := 'business_id in (select public.finance_business_ids())';
  full_access constant text := '(select public.my_access()) <> ''register''';
  writer      constant text := '(select public.can_write())';
begin
  foreach t in array array['recurring_plans', 'recurring_charges'] loop
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

-- ---- 3. the owner's side (a member who may write the money: finance_guard + can_write) --------------------------------------------
-- a new plan (its id from the device: the same save twice makes one plan), or new terms for one that is active or paused: the
-- lines, the amount, the name, what is made, the link, the end, the note — from the next charge on (what was charged stays as it
-- was). The schedule (how often, the day, the start) changes only before the first charge.
create or replace function public.recurring_plan_save(p_id uuid, p_lead uuid, p_name text, p_lines jsonb, p_prices_include_vat boolean, p_amount numeric,
                                                      p_every int, p_day int, p_start date, p_end date, p_mode text, p_send_link boolean, p_note text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  b uuid := public.finance_guard(); pl public.recurring_plans; today date := public.il_today(); l jsonb; n int := 0; nxt date;
  q numeric; u numeric; lead_name text; charged boolean;
  uuid_re constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if not public.can_write() then raise exception 'not allowed' using errcode = '42501'; end if;
  if not public.business_is_active(b) then raise exception 'business_locked' using errcode = '42501'; end if;
  if p_id is null then raise exception 'recurring_request: the plan' using errcode = '22023'; end if;
  select x.name into lead_name from public.leads x where x.id = p_lead and x.business_id = b;
  if not found then raise exception 'recurring_customer: a customer of this business' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_name, ''))) not between 1 and 120 then raise exception 'recurring_name: 1 to 120 characters' using errcode = '22023'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) not between 1 and 30 then
    raise exception 'recurring_lines: 1 to 30 lines' using errcode = '22023'; end if;
  for l in select e from jsonb_array_elements(p_lines) e loop
    n := n + 1;
    if jsonb_typeof(l) <> 'object' then raise exception 'recurring_lines: line %', n using errcode = '22023'; end if;
    begin
      q := (l->>'qty')::numeric; u := (l->>'unitPrice')::numeric;
    exception when others then
      raise exception 'recurring_lines: line %', n using errcode = '22023';
    end;
    if length(btrim(coalesce(l->>'name', ''))) not between 1 and 120 or q is null or q <= 0 or q > 100000 or u is null or u < 0 or u > 1000000 then
      raise exception 'recurring_lines: line %', n using errcode = '22023'; end if;
    -- an item of the catalog (stock moves with the document) is the business's own; a variant is of that item
    if coalesce(l->>'itemId', '') <> '' and ((l->>'itemId') !~* uuid_re
        or not exists (select 1 from public.catalog_items ci where ci.id = (l->>'itemId')::uuid and ci.business_id = b)) then
      raise exception 'recurring_lines: line % — the item', n using errcode = '22023'; end if;
    if coalesce(l->>'variantId', '') <> '' and (coalesce(l->>'itemId', '') = '' or (l->>'variantId') !~* uuid_re
        or not exists (select 1 from public.catalog_variants v where v.id = (l->>'variantId')::uuid and v.item_id = (l->>'itemId')::uuid and v.business_id = b)) then
      raise exception 'recurring_lines: line % — the variant', n using errcode = '22023'; end if;
  end loop;
  if p_amount is null or p_amount <= 0 or p_amount > 1000000 or p_amount <> round(p_amount, 2) then raise exception 'recurring_amount' using errcode = '22023'; end if;
  if p_every is null or p_every not in (1, 2, 3, 6, 12) then raise exception 'recurring_every: 1, 2, 3, 6 or 12 months' using errcode = '22023'; end if;
  if p_day is null or p_day not between 1 and 28 then raise exception 'recurring_day: 1 to 28' using errcode = '22023'; end if;
  if p_start is null then raise exception 'recurring_start: within a year' using errcode = '22023'; end if;
  if p_end is not null and p_end < p_start then raise exception 'recurring_end: after the start' using errcode = '22023'; end if;
  if coalesce(p_mode, '') not in ('issue', 'draft') then raise exception 'recurring_mode' using errcode = '22023'; end if;
  if length(coalesce(p_note, '')) > 300 then raise exception 'recurring_note: up to 300 characters' using errcode = '22023'; end if;

  select * into pl from public.recurring_plans where id = p_id for update;
  if not found then
    if p_start < today - 366 or p_start > today + 366 then raise exception 'recurring_start: within a year' using errcode = '22023'; end if;
    -- the first charge: the first date of the schedule from the start — never one in the past
    nxt := public.recurring_on_or_after(p_start, p_every, p_day, greatest(p_start, today));
    if p_end is not null and nxt > p_end then raise exception 'recurring_end: no charge before the end date' using errcode = '22023'; end if;
    insert into public.recurring_plans (id, business_id, user_id, lead_id, name, lines, prices_include_vat, amount, every_months, day_of_month, start_date, end_date,
                                        next_date, mode, send_link, note)
    values (p_id, b, auth.uid(), p_lead, btrim(p_name), p_lines, coalesce(p_prices_include_vat, true), p_amount, p_every, p_day, p_start, p_end, nxt, p_mode,
            coalesce(p_send_link, true), btrim(coalesce(p_note, '')))
    returning * into pl;
    perform public.finance_log(b, 'recurring.created', 'recurring_plans', pl.id::text,
      jsonb_build_object('lead', p_lead, 'amount', p_amount, 'every', p_every, 'day', p_day, 'first', nxt, 'end', p_end, 'mode', p_mode, 'link', pl.send_link));
    if auth.uid() is not null then
      insert into public.lead_activities (user_id, business_id, lead_id, kind, body)
      values (auth.uid(), b, p_lead, 'note', format('חיוב חוזר: %s · ₪%s %s · ראשון ב-%s', btrim(p_name), trim_scale(p_amount),
              case p_every when 1 then 'כל חודש' when 2 then 'כל חודשיים' when 3 then 'כל 3 חודשים' when 6 then 'כל חצי שנה' else 'כל שנה' end, to_char(nxt, 'DD/MM/YYYY')));
    end if;
    return jsonb_build_object('result', 'created', 'plan', pl.id, 'next', nxt, 'status', pl.status);
  end if;

  if pl.business_id <> b then raise exception 'recurring_not_found' using errcode = '42501'; end if;
  if pl.status = 'ended' then raise exception 'recurring_ended: an ended plan does not change' using errcode = '23514'; end if;
  if pl.lead_id <> p_lead then raise exception 'recurring_customer: a plan keeps its customer (a new plan for another)' using errcode = '23514'; end if;
  charged := exists (select 1 from public.recurring_charges c where c.plan_id = pl.id);
  if charged and (p_every, p_day, p_start) is distinct from (pl.every_months, pl.day_of_month, pl.start_date) then
    raise exception 'recurring_schedule: a plan that charged keeps its schedule — end it and make a new one' using errcode = '23514'; end if;
  if p_start is distinct from pl.start_date and (p_start < today - 366 or p_start > today + 366) then
    raise exception 'recurring_start: within a year' using errcode = '22023'; end if;
  nxt := case when charged then pl.next_date else public.recurring_on_or_after(p_start, p_every, p_day, greatest(p_start, today)) end;
  if p_end is not null and nxt > p_end and not charged then raise exception 'recurring_end: no charge before the end date' using errcode = '22023'; end if;
  update public.recurring_plans set name = btrim(p_name), lines = p_lines, prices_include_vat = coalesce(p_prices_include_vat, true), amount = p_amount,
         every_months = p_every, day_of_month = p_day, start_date = p_start, end_date = p_end, next_date = nxt, mode = p_mode, send_link = coalesce(p_send_link, true),
         note = btrim(coalesce(p_note, ''))
   where id = pl.id
  returning * into pl;
  -- an end date before the next charge: nothing more to charge
  if pl.end_date is not null and pl.next_date > pl.end_date then
    update public.recurring_plans set status = 'ended', ended_at = now(), paused_at = null, end_reason = 'הגיע תאריך הסיום' where id = pl.id returning * into pl;
  end if;
  perform public.finance_log(b, 'recurring.changed', 'recurring_plans', pl.id::text,
    jsonb_build_object('amount', p_amount, 'every', p_every, 'day', p_day, 'next', pl.next_date, 'end', p_end, 'mode', p_mode, 'link', pl.send_link, 'status', pl.status));
  return jsonb_build_object('result', 'changed', 'plan', pl.id, 'next', pl.next_date, 'status', pl.status);
end $$;

-- pause (no charge while paused — the periods that pass are not charged later), resume (from the next date of the schedule on
-- or after today), end (for good). A charge that waited and was not issued yet is held ("נסו שוב" issues it, by choice); what
-- was issued stays as it was.
create or replace function public.recurring_plan_set(p_plan uuid, p_action text, p_reason text default '') returns jsonb
language plpgsql security definer set search_path = public as $$
declare b uuid := public.finance_guard(); pl public.recurring_plans; nxt date; today date := public.il_today(); held int := 0;
begin
  if not public.can_write() then raise exception 'not allowed' using errcode = '42501'; end if;
  if coalesce(p_action, '') not in ('pause', 'resume', 'end') then raise exception 'recurring_request: pause, resume or end' using errcode = '22023'; end if;
  select * into pl from public.recurring_plans where id = p_plan and business_id = b for update;
  if not found then raise exception 'recurring_not_found' using errcode = '42501'; end if;
  if pl.status = 'ended' then return jsonb_build_object('result', 'already', 'status', 'ended', 'next', pl.next_date); end if;
  if p_action = 'pause' then
    if pl.status = 'paused' then return jsonb_build_object('result', 'already', 'status', 'paused', 'next', pl.next_date); end if;
    update public.recurring_plans set status = 'paused', paused_at = now() where id = pl.id returning * into pl;
  elsif p_action = 'resume' then
    if pl.status = 'active' then return jsonb_build_object('result', 'already', 'status', 'active', 'next', pl.next_date); end if;
    if not public.business_is_active(b) then raise exception 'business_locked' using errcode = '42501'; end if;
    nxt := public.recurring_on_or_after(pl.start_date, pl.every_months, pl.day_of_month, greatest(today, pl.next_date));
    if pl.end_date is not null and nxt > pl.end_date then
      update public.recurring_plans set status = 'ended', ended_at = now(), paused_at = null, next_date = nxt, end_reason = 'הגיע תאריך הסיום'
       where id = pl.id returning * into pl;
    else
      update public.recurring_plans set status = 'active', paused_at = null, next_date = nxt where id = pl.id returning * into pl;
    end if;
  else
    update public.recurring_plans set status = 'ended', ended_at = now(), paused_at = null,
           end_reason = left(coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'הסתיים'), 300)
     where id = pl.id returning * into pl;
  end if;
  if pl.status <> 'active' then
    update public.recurring_charges set status = 'blocked', claimed_at = null,
           error = case pl.status when 'paused' then 'התוכנית הושהתה לפני שהחיוב הופק' else 'התוכנית הסתיימה לפני שהחיוב הופק' end
     where plan_id = pl.id and status = 'pending';
    get diagnostics held = row_count;
  end if;
  perform public.finance_log(b, 'recurring.' || p_action, 'recurring_plans', pl.id::text,
    jsonb_build_object('status', pl.status, 'next', pl.next_date, 'held', held, 'reason', left(coalesce(p_reason, ''), 120)));
  if auth.uid() is not null then
    insert into public.lead_activities (user_id, business_id, lead_id, kind, body)
    values (auth.uid(), b, pl.lead_id, 'note', format('חיוב חוזר "%s": %s', pl.name,
            case pl.status when 'paused' then 'הושהה' when 'active' then 'חזר לפעול — החיוב הבא ב-' || to_char(pl.next_date, 'DD/MM/YYYY') else 'הסתיים' end));
  end if;
  return jsonb_build_object('result', 'ok', 'status', pl.status, 'next', pl.next_date, 'held', held);
end $$;

-- "נסו שוב": a held charge goes back to the timer
create or replace function public.recurring_charge_retry(p_charge uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare b uuid := public.finance_guard(); c public.recurring_charges;
begin
  if not public.can_write() then raise exception 'not allowed' using errcode = '42501'; end if;
  if not public.business_is_active(b) then raise exception 'business_locked' using errcode = '42501'; end if;
  update public.recurring_charges set status = 'pending', attempts = 0, claimed_at = null, error = ''
   where id = p_charge and business_id = b and status = 'blocked' returning * into c;
  if not found then return false; end if;
  perform public.finance_log(b, 'recurring.retry', 'recurring_charges', c.id::text, jsonb_build_object('plan', c.plan_id, 'period', c.period_date));
  return true;
end $$;

-- ---- 4. the timer (the dashboard's server: /api/cron/commerce) -------------------------------------------------------------------
-- 08:00–20:00 Israel time, not on Saturday (a Saturday's charge is made on Sunday): every active plan of an active business whose
-- date came gets its period's charge (once — plan + period is unique; a run again or two at once make nothing twice), the next
-- date, and its end. A period missed by up to 35 days (the timer was down) is charged now; an older one is held with the reason —
-- never charged by itself, "נסו שוב" charges it. A paused plan charges nothing. Then the charges that wait (new, or not finished
-- by an earlier run — claimed again after 10 minutes, at most 5 times, then held) are claimed and returned for the server.
create or replace function public.recurring_due(p_now timestamptz default now(), p_limit int default 50) returns setof uuid
language plpgsql security definer set search_path = public as $$
declare local timestamp := p_now at time zone 'Asia/Jerusalem'; today date := (p_now at time zone 'Asia/Jerusalem')::date; pl record; nxt date; k int;
begin
  if extract(isodow from local) <> 6 and extract(hour from local) between 8 and 19 then
    for pl in select p.* from public.recurring_plans p
               where p.status = 'active' and p.next_date <= today and public.business_is_active(p.business_id)
               order by p.next_date, p.id
               for update skip locked
    loop
      nxt := pl.next_date; k := 0;
      while nxt <= today and k < 24 and (pl.end_date is null or nxt <= pl.end_date) loop
        if nxt < today - 35 then
          insert into public.recurring_charges (business_id, plan_id, period_date, status, error)
          values (pl.business_id, pl.id, nxt, 'blocked', 'התאריך עבר לפני יותר מ-35 יום, ולכן לא חויב מעצמו. "נסו שוב" יפיק אותו עכשיו.')
          on conflict do nothing;
        else
          insert into public.recurring_charges (business_id, plan_id, period_date) values (pl.business_id, pl.id, nxt) on conflict do nothing;
        end if;
        nxt := public.recurring_on_or_after(pl.start_date, pl.every_months, pl.day_of_month, nxt + 1);
        k := k + 1;
      end loop;
      if pl.end_date is not null and nxt > pl.end_date then
        update public.recurring_plans set next_date = nxt, status = 'ended', ended_at = now(), end_reason = 'הגיע תאריך הסיום' where id = pl.id;
        perform public.finance_log(pl.business_id, 'recurring.end', 'recurring_plans', pl.id::text, jsonb_build_object('status', 'ended', 'reason', 'end_date'));
      else
        update public.recurring_plans set next_date = nxt where id = pl.id;
      end if;
    end loop;
  end if;
  -- five claims that never came back: held for the owner
  update public.recurring_charges set status = 'blocked', claimed_at = null, error = 'לא הופק אחרי 5 ניסיונות. "נסו שוב" ינסה שוב.'
   where status = 'pending' and attempts >= 5 and claimed_at < p_now - interval '10 minutes';
  return query
    update public.recurring_charges c set claimed_at = p_now, attempts = c.attempts + 1
     where c.id in (select x.id from public.recurring_charges x
                     where x.status = 'pending' and x.attempts < 5 and (x.claimed_at is null or x.claimed_at < p_now - interval '10 minutes')
                       and public.business_is_active(x.business_id)
                     order by x.period_date, x.id
                     limit greatest(coalesce(p_limit, 50), 1)
                     for update skip locked)
    returning c.id;
end $$;

-- the server's answer for a charge: issued (its document; a link with it, or why not), a draft for the owner, or held (why).
-- The same answer again adds only what is missing; an answer after the charge was done changes nothing.
create or replace function public.recurring_charge_done(p_charge uuid, p_status text, p_document uuid default null, p_draft uuid default null,
                                                        p_paylink uuid default null, p_note text default '', p_error text default '')
returns text language plpgsql security definer set search_path = public as $$
declare c public.recurring_charges; pl public.recurring_plans; d public.documents; who uuid;
begin
  if coalesce(p_status, '') not in ('issued', 'draft', 'blocked') then raise exception 'recurring_request: issued, draft or blocked' using errcode = '22023'; end if;
  if p_status = 'issued' and p_document is null then raise exception 'recurring_request: an issued charge has its document' using errcode = '22023'; end if;
  if p_status = 'draft' and p_draft is null then raise exception 'recurring_request: a draft charge has its draft' using errcode = '22023'; end if;
  select * into c from public.recurring_charges where id = p_charge for update;
  if not found then return 'not_found'; end if;
  select * into pl from public.recurring_plans where id = c.plan_id;
  if p_document is not null then
    select * into d from public.documents x where x.id = p_document and x.business_id = c.business_id;
    if not found then raise exception 'recurring_request: the document is not this business''s' using errcode = '22023'; end if;
  end if;
  if p_draft is not null and not exists (select 1 from public.document_drafts x where x.id = p_draft and x.business_id = c.business_id) then
    raise exception 'recurring_request: the draft is not this business''s' using errcode = '22023'; end if;
  if p_paylink is not null and not exists (select 1 from public.payment_requests x where x.id = p_paylink and x.business_id = c.business_id
                                             and x.document_id = coalesce(c.document_id, p_document)) then
    raise exception 'recurring_request: the link is not this document''s' using errcode = '22023'; end if;
  if c.status = 'issued' or (c.status = 'draft' and p_status <> 'issued') then
    if c.status = p_status then        -- the same answer again (a retry of the server): only what is missing is added
      update public.recurring_charges set paylink_id = coalesce(paylink_id, p_paylink),
             note = case when btrim(coalesce(p_note, '')) <> '' then left(btrim(p_note), 300) else note end, claimed_at = null
       where id = c.id;
    end if;
    return c.status;
  end if;
  update public.recurring_charges set status = p_status, document_id = coalesce(p_document, document_id), draft_id = coalesce(p_draft, draft_id),
         paylink_id = coalesce(p_paylink, paylink_id), note = left(btrim(coalesce(p_note, '')), 300),
         error = case when p_status = 'blocked' then left(coalesce(nullif(btrim(coalesce(p_error, '')), ''), 'לא הופק'), 300) else '' end, claimed_at = null
   where id = c.id;
  perform public.finance_log(c.business_id, 'recurring.' || p_status, 'recurring_charges', c.id::text,
    jsonb_build_object('plan', c.plan_id, 'period', c.period_date, 'document', p_document, 'draft', p_draft, 'link', p_paylink, 'error', left(coalesce(p_error, ''), 120)));
  who := coalesce(pl.user_id, public.commerce_owner(c.business_id));
  if p_status = 'issued' and who is not null then
    insert into public.lead_activities (user_id, business_id, lead_id, kind, body)
    values (who, c.business_id, pl.lead_id, 'purchase', format('חיוב חוזר "%s" (%s): %s מס׳ %s · ₪%s%s', pl.name, to_char(c.period_date, 'DD/MM/YYYY'),
            case d.doc_type when 305 then 'חשבונית מס' else 'חשבונית עסקה' end, d.doc_number, trim_scale(d.total),
            case when p_paylink is not null then ' · עם לינק לתשלום' else '' end));
  end if;
  return p_status;
end $$;

-- a recurring charge's draft (its id is the charge's), issued from the document center: the charge is issued with it, in the same
-- transaction. Any other draft is not touched.
create or replace function public.recurring_draft_issued() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.recurring_charges set status = 'issued', document_id = new.document_id, draft_id = new.id, error = '', claimed_at = null
   where id = new.id and business_id = new.business_id and status in ('pending', 'draft', 'blocked') and document_id is null;
  if found then
    perform public.finance_log(new.business_id, 'recurring.issued', 'recurring_charges', new.id::text, jsonb_build_object('document', new.document_id, 'draft', new.id));
  end if;
  return null;
end $$;
revoke execute on function public.recurring_draft_issued() from public, anon, authenticated;
create or replace trigger z_document_drafts_recurring after update of status on public.document_drafts
  for each row when (old.status = 'open' and new.status = 'finalized') execute function public.recurring_draft_issued();

-- ---- 5. who runs what ----------------------------------------------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array['public.recurring_plan_save(uuid, uuid, text, jsonb, boolean, numeric, int, int, date, date, text, boolean, text)',
    'public.recurring_plan_set(uuid, text, text)', 'public.recurring_charge_retry(uuid)', 'public.recurring_date(date, int, int, int)',
    'public.recurring_on_or_after(date, int, int, date)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  foreach f in array array['public.recurring_due(timestamptz, int)', 'public.recurring_charge_done(uuid, text, uuid, uuid, uuid, text, text)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- ============================================================================================================================
-- Rollback (by hand, if ever needed — the plans, their charges and their log go with them; the documents and drafts stay):
--   drop trigger z_document_drafts_recurring on document_drafts; drop the functions of sections 1, 3 and 4 (recurring_date,
--   recurring_on_or_after, recurring_plan_save, recurring_plan_set, recurring_charge_retry, recurring_due, recurring_charge_done,
--   recurring_draft_issued); drop table recurring_charges, recurring_plans (and recurring_guard).
-- ============================================================================================================================
