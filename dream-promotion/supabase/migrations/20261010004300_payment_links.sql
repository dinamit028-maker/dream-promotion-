-- ============================================================================================================================
-- Migration 20261010004300 — payment links and a deposit on an appointment (docs/FINANCE_ADDITIONS_HE.md, T2; 2.88.0)
-- Prepared only: NOT applied to the live database (needs the owner's explicit approval). Tested on a local Postgres:
-- tests/sql/payment-links.check.sql and tests/sql/concurrency.sh §14.
--
--   1. the switch     platform_flags.payment_links_live — off. Set only in the SQL Editor, after a separate approval (like
--                     commerce_live). Until then every link is a test: paid on the provider's test terminal it is "paid (test)":
--                     no row in payments, no receipt, no deposit to offset.
--   2. the terminal   payment_accounts.verified_at: the storefront's server created a payment page with these keys ("בדיקת
--                     חיבור"). A link is sent only on a connected AND verified terminal; a live one only with the switch on.
--                     New keys, mode or page → not verified (trigger).
--   3. the request    payment_requests: what is paid (an open invoice — also a package's —, an accepted quote, an appointment's
--                     deposit), how much (a part of a balance is allowed; never more than what is left after the other open
--                     links), until when, its status (sent / paid / failed / expired / cancelled), the provider's pages, the
--                     receipt. Created, cancelled and settled only by the functions below; the screens read it (finance RLS).
--   4. the storefront sf_paylink*: a page for the request, a notice once (payment_events.request_id), "paid" only from the
--                     provider's own answer — one transaction, the exact amount. A payment after the link expired or was
--                     cancelled is still recorded (the money was taken) and marked late for the owner.
--   5. the receipt    issued by the dashboard's server through the existing documents (idempotency key paylink:<id>; the
--                     ledger row comes from the receipt, as always): at once, or after the owner's approval
--                     (business_finance_profile.paylink_receipt).
--   6. deposits       booking_services.deposit; one deposit link per appointment; appointment_deposits() tells the register
--                     what was paid for an appointment, so the final payment is the rest.
--   7. emails         email_outbox also holds a link's email (request_id; the order's columns become optional).
-- No statement here removes rows. Two existing constraints are widened (email_outbox: the kind; order/store not required for
-- a link's email) — the SQL Editor runs this file (the MCP stops on the word drop). The rollback at the end is a comment.
-- ============================================================================================================================

-- ---- 1. the switch -------------------------------------------------------------------------------------------------------
insert into public.platform_flags (key, enabled, note)
values ('payment_links_live', false, 'real payment links (money and receipts) — off until a separate approval')
on conflict (key) do nothing;

create or replace function public.payment_links_live() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select f.enabled from public.platform_flags f where f.key = 'payment_links_live'), false)
$$;
revoke execute on function public.payment_links_live() from public, anon;
grant execute on function public.payment_links_live() to authenticated, service_role;

-- ---- 2. the terminal: verified --------------------------------------------------------------------------------------------
alter table public.payment_accounts add column if not exists verified_at timestamptz;

-- other keys, another mode or page: not verified any more (the check is run again)
create or replace function public.payment_accounts_unverify() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.sealed is distinct from old.sealed or new.page_uid is distinct from old.page_uid
     or new.mode is distinct from old.mode or new.provider is distinct from old.provider then
    new.verified_at := null;
  end if;
  return new;
end $$;
revoke execute on function public.payment_accounts_unverify() from public, anon, authenticated;
create or replace trigger b_payment_accounts_unverify before update on public.payment_accounts
  for each row execute function public.payment_accounts_unverify();

-- ---- 3. settings: the receipt of a link; a service's deposit ---------------------------------------------------------------
alter table public.business_finance_profile add column if not exists paylink_receipt text not null default 'auto';
alter table public.booking_services add column if not exists deposit numeric(10,2);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'business_finance_profile_paylink_receipt_check') then
    alter table public.business_finance_profile add constraint business_finance_profile_paylink_receipt_check
      check (paylink_receipt in ('auto', 'approve'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'booking_services_deposit_check') then
    alter table public.booking_services add constraint booking_services_deposit_check
      check (deposit is null or (deposit > 0 and deposit <= 100000 and (price is null or deposit <= price)));
  end if;
end $$;

-- ---- 4. the request ---------------------------------------------------------------------------------------------------------
create table if not exists public.payment_requests (
  id                  uuid primary key default gen_random_uuid(),
  business_id         uuid not null references public.businesses on delete restrict,
  user_id             uuid references auth.users on delete set null,             -- who sent it (null: the public booking page)
  kind                text not null check (kind in ('document', 'quote', 'deposit')),
  document_id         uuid references public.documents on delete restrict,       -- kind document: the invoice it pays
  package_id          uuid references public.client_packages on delete restrict, -- that invoice is a package's (for the screens)
  quote_id            uuid references public.quotes on delete restrict,          -- kind quote
  appointment_id      uuid references public.appointments on delete restrict,    -- kind deposit
  lead_id             uuid references public.leads on delete set null,
  label               text not null check (length(label) between 1 and 160),       -- what it pays, as the customer reads it
  customer_name       text not null default '' check (length(customer_name) <= 120),
  customer_phone      text not null default '' check (length(customer_phone) <= 30),
  customer_email      text not null default '' check (length(customer_email) <= 120),
  amount              numeric(14,2) not null check (amount > 0 and amount <= 1000000),
  currency            text not null default 'ILS' check (currency = 'ILS'),
  is_test             boolean not null,                                          -- the terminal was a test one when sent
  provider            text not null check (provider in ('payplus', 'mock')),
  status              text not null default 'sent' check (status in ('sent', 'paid', 'failed', 'expired', 'cancelled')),
  expires_at          timestamptz not null,
  link_origin         text not null check (link_origin ~ '^https?://[^/?#[:space:]]+$'),  -- the dashboard's address (the email's link)
  sent_via            text not null default 'link' check (sent_via in ('whatsapp', 'email', 'link')),
  sends               int not null default 1 check (sends between 1 and 50),
  -- the provider's payment pages of this link (a new one after a declined try; at most 5): {page, url, at, state}
  pages               jsonb not null default '[]' check (jsonb_typeof(pages) = 'array' and jsonb_array_length(pages) <= 5),
  paid_at             timestamptz,
  paid_amount         numeric(14,2),
  provider_txn        text not null default '' check (length(provider_txn) <= 120),
  paid_late           boolean not null default false,                            -- paid after it expired or was cancelled
  failed_at           timestamptz,
  fail_reason         text not null default '' check (length(fail_reason) <= 120),
  cancelled_at        timestamptz,
  cancelled_by        uuid,
  cancel_reason       text not null default '' check (length(cancel_reason) <= 300),
  -- the receipt (a real payment only): pending = issued by the server now; awaiting = the owner approves first
  receipt_status      text not null default 'none' check (receipt_status in ('none', 'pending', 'awaiting', 'issued', 'blocked')),
  receipt_document_id uuid references public.documents on delete restrict,
  receipt_error       text not null default '' check (length(receipt_error) <= 300),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check (kind <> 'document' or document_id is not null),
  check (kind <> 'quote' or quote_id is not null),
  check (kind <> 'deposit' or appointment_id is not null),
  check (package_id is null or kind = 'document'),
  check ((status = 'paid') = (paid_at is not null and paid_amount is not null and provider_txn <> '')),
  check (status <> 'cancelled' or cancelled_at is not null),
  check (receipt_status = 'none' or (status = 'paid' and not is_test)),
  check (receipt_status <> 'issued' or receipt_document_id is not null)
);
create index if not exists payment_requests_business_idx on public.payment_requests (business_id, created_at desc);
create index if not exists payment_requests_document_idx on public.payment_requests (document_id) where document_id is not null;
create index if not exists payment_requests_quote_idx on public.payment_requests (quote_id) where quote_id is not null;
create index if not exists payment_requests_lead_idx on public.payment_requests (lead_id) where lead_id is not null;
create index if not exists payment_requests_receipt_idx on public.payment_requests (created_at) where receipt_status = 'pending';
-- one deposit link per appointment that is still open or paid (a failed one is sent again, an expired / cancelled one replaced)
create unique index if not exists payment_requests_deposit_uq on public.payment_requests (appointment_id)
  where kind = 'deposit' and status in ('sent', 'failed', 'paid');
-- a receipt is the receipt of one link
create unique index if not exists payment_requests_receipt_uq on public.payment_requests (receipt_document_id) where receipt_document_id is not null;

-- a notice / a check of a link's payment (the same log as the orders'), once
alter table public.payment_events add column if not exists request_id uuid references public.payment_requests on delete set null;
create index if not exists payment_events_request_idx on public.payment_events (request_id, id) where request_id is not null;

-- what never changes on a link, and the order of its statuses (the functions below are the only writers; this holds them)
create or replace function public.payment_requests_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.business_id is distinct from old.business_id or new.kind is distinct from old.kind or new.amount is distinct from old.amount
     or new.document_id is distinct from old.document_id or new.quote_id is distinct from old.quote_id
     or new.appointment_id is distinct from old.appointment_id or new.package_id is distinct from old.package_id
     or new.is_test is distinct from old.is_test or new.provider is distinct from old.provider or new.created_at is distinct from old.created_at then
    raise exception 'a payment link keeps what it asks for — a new link is sent instead' using errcode = '23514';
  end if;
  if old.status = 'paid' and (new.status <> 'paid' or new.paid_at is distinct from old.paid_at or new.provider_txn is distinct from old.provider_txn
                              or new.paid_amount is distinct from old.paid_amount) then
    raise exception 'a paid link stays paid' using errcode = '23514';
  end if;
  if old.status in ('expired', 'cancelled') and new.status not in (old.status, 'paid') then
    raise exception 'a closed link only becomes paid (a late payment)' using errcode = '23514';
  end if;
  if old.receipt_status = 'issued' and (new.receipt_status <> 'issued' or new.receipt_document_id is distinct from old.receipt_document_id) then
    raise exception 'the receipt of a link is issued once' using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end $$;
revoke execute on function public.payment_requests_guard() from public, anon, authenticated;
create or replace trigger b_payment_requests_guard before update on public.payment_requests
  for each row execute function public.payment_requests_guard();
create or replace trigger payment_requests_no_delete before delete on public.payment_requests
  for each row execute function public.finance_append_only();

-- the screens read (the money ones: never a cashier, never a business that is not open to the caller's money);
-- only the functions of this file and the servers write
do $$
declare
  t text := 'payment_requests'; op text;
  gate        constant text := 'business_id = (select public.current_business_id()) and business_id in (select public.accessible_business_ids())';
  fin         constant text := 'business_id in (select public.finance_business_ids())';
  full_access constant text := '(select public.my_access()) <> ''register''';
  writer      constant text := '(select public.can_write())';
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
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_business_read') then
    execute format('create policy %I on public.%I for select to authenticated using (%s)', t || '_business_read', t, gate);
  end if;
  foreach op in array array['insert', 'update', 'delete'] loop
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_viewer_' || op) then
      execute format('create policy %I on public.%I as restrictive for %s to authenticated %s', t || '_viewer_' || op, t, op,
        case op when 'insert' then format('with check (%s)', writer) when 'update' then format('using (%s) with check (%s)', writer, writer) else format('using (%s)', writer) end);
    end if;
  end loop;
end $$;

-- ---- 5. sending a link (the dashboard's server, for a member it checked: financeCaller, write) -----------------------------
-- What is left to ask for: the invoice's balance (or the quote's total) less the links still open on it (and paid links whose
-- receipt is not issued yet) — under the invoice's lock, as its receipts. A deposit is the service's, never typed.
create or replace function public.paylink_create(p_business uuid, p_user uuid, p_kind text, p_target uuid, p_amount numeric,
                                                 p_days int, p_origin text, p_via text default 'link', p_package uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  a public.payment_accounts; d public.documents; q public.quotes; ap public.appointments; sv public.booking_services;
  r public.payment_requests; bal numeric; held numeric; amt numeric := round(coalesce(p_amount, 0), 2);
  lbl text; cname text := ''; cphone text := ''; cemail text := ''; lead uuid; pkg_name text;
begin
  if p_business is null or p_kind not in ('document', 'quote', 'deposit') or p_target is null then
    raise exception 'paylink_request: what is paid' using errcode = '22023'; end if;
  if coalesce(p_via, '') not in ('whatsapp', 'email', 'link') then raise exception 'paylink_request: how it is sent' using errcode = '22023'; end if;
  if p_days is null or p_days < 1 or p_days > 30 then raise exception 'paylink_days: 1 to 30 days' using errcode = '22023'; end if;
  if coalesce(p_origin, '') !~ '^https?://[^/?#[:space:]]+$' then raise exception 'paylink_request: the address' using errcode = '22023'; end if;
  if not public.business_is_active(p_business) then raise exception 'business_locked' using errcode = '42501'; end if;
  -- the terminal: connected and verified; a live one only with the platform's switch
  select * into a from public.payment_accounts where business_id = p_business;
  if a.business_id is null then raise exception 'paylink_no_terminal: no payment provider is connected' using errcode = '55000'; end if;
  if a.verified_at is null then raise exception 'paylink_not_verified: the terminal was not checked yet' using errcode = '55000'; end if;
  if a.mode = 'live' and not public.payment_links_live() then raise exception 'paylink_live_closed' using errcode = '55000'; end if;

  if p_kind = 'document' then
    select * into d from public.documents where id = p_target and business_id = p_business for update;
    if d.id is null then raise exception 'paylink_not_found' using errcode = '42501'; end if;
    if d.doc_type not in (300, 305) then raise exception 'paylink_not_invoice: a link pays an open invoice' using errcode = '23514'; end if;
    if exists (select 1 from public.document_cancellations x where x.document_id = d.id) then
      raise exception 'paylink_not_invoice: the invoice was cancelled' using errcode = '23514'; end if;
    select d.total - coalesce((select sum(c.total) from public.documents c where c.business_id = d.business_id and c.doc_type = 330
                                 and c.base_doc_type = d.doc_type and c.base_doc_number = d.doc_number), 0)
                   - coalesce((select sum(case p.direction when 'in' then p.amount else -p.amount end) from public.payments p where p.applies_to = d.id), 0)
      into bal;
    select coalesce(sum(x.amount), 0) into held from public.payment_requests x
     where x.document_id = d.id and ((x.status in ('sent', 'failed') and x.expires_at > now())
                                     or (x.status = 'paid' and x.receipt_status in ('pending', 'awaiting', 'blocked')));
    lbl := case d.doc_type when 305 then 'חשבונית מס' else 'חשבונית עסקה' end || ' מס׳ ' || d.doc_number;
    if p_package is not null then
      select p.name into pkg_name from public.client_packages p where p.id = p_package and p.business_id = p_business and p.document_id = d.id;
      if pkg_name is null then raise exception 'paylink_not_found: the package' using errcode = '42501'; end if;
      lbl := left(pkg_name, 100) || ' (' || lbl || ')';
    end if;
    cname := d.customer_name; cphone := coalesce(d.customer_phone, ''); cemail := coalesce(d.customer_email, ''); lead := d.lead_id;
  elsif p_kind = 'quote' then
    if p_package is not null then raise exception 'paylink_request: a package is paid on its invoice' using errcode = '22023'; end if;
    select * into q from public.quotes where id = p_target and business_id = p_business for update;
    if q.id is null then raise exception 'paylink_not_found' using errcode = '42501'; end if;
    if q.status <> 'accepted' then raise exception 'paylink_quote: a link pays an accepted quote' using errcode = '23514'; end if;
    bal := q.total;
    select coalesce(sum(x.amount), 0) into held from public.payment_requests x
     where x.quote_id = q.id and ((x.status in ('sent', 'failed') and x.expires_at > now())
                                  or (x.status = 'paid' and not x.is_test and x.receipt_status in ('pending', 'awaiting', 'blocked')));
    lbl := 'הצעת מחיר מס׳ ' || q.quote_number;
    cname := q.customer_name; cphone := q.customer_phone; cemail := q.customer_email; lead := q.lead_id;
  else
    if p_package is not null then raise exception 'paylink_request: a package is paid on its invoice' using errcode = '22023'; end if;
    select * into ap from public.appointments where id = p_target and business_id = p_business for update;
    if ap.id is null then raise exception 'paylink_not_found' using errcode = '42501'; end if;
    if ap.status not in ('booked', 'confirmed') then raise exception 'paylink_appointment: the appointment is not open' using errcode = '23514'; end if;
    if ap.end_at <= now() then raise exception 'paylink_appointment: the appointment is over' using errcode = '23514'; end if;
    select * into sv from public.booking_services where id = ap.service_id and business_id = p_business;
    if coalesce(sv.deposit, 0) <= 0 then raise exception 'paylink_no_deposit: the service asks no deposit' using errcode = '23514'; end if;
    if exists (select 1 from public.payment_requests x where x.appointment_id = ap.id and x.kind = 'deposit' and x.status in ('sent', 'failed', 'paid')) then
      raise exception 'paylink_deposit_exists: the appointment already has a deposit link' using errcode = '23505'; end if;
    amt := sv.deposit; bal := sv.deposit; held := 0;
    lbl := 'מקדמה לתור: ' || left(coalesce(nullif(btrim(ap.service_name), ''), sv.name), 80) || ' · '
           || to_char(ap.start_at at time zone 'Asia/Jerusalem', 'DD/MM HH24:MI');
    cname := ap.name; cphone := ap.phone; cemail := ap.email; lead := ap.lead_id;
  end if;

  if amt <= 0 then raise exception 'paylink_amount: more than zero' using errcode = '22023'; end if;
  if amt > bal - held then
    raise exception 'paylink_over_balance: % left to ask for', greatest(bal - held, 0) using errcode = '23514'; end if;
  insert into public.payment_requests (business_id, user_id, kind, document_id, package_id, quote_id, appointment_id, lead_id, label,
                                       customer_name, customer_phone, customer_email, amount, is_test, provider, expires_at, link_origin, sent_via)
  values (p_business, p_user, p_kind, case when p_kind = 'document' then p_target end, case when p_kind = 'document' then p_package end,
          case when p_kind = 'quote' then p_target end, case when p_kind = 'deposit' then p_target end, lead, lbl,
          left(coalesce(cname, ''), 120), left(coalesce(cphone, ''), 30), left(coalesce(cemail, ''), 120), amt, a.mode = 'test', a.provider,
          now() + make_interval(days => p_days), p_origin, p_via)
  returning * into r;
  perform public.finance_log(p_business, 'paylink.created', 'payment_requests', r.id::text,
    jsonb_build_object('kind', r.kind, 'amount', r.amount, 'test', r.is_test, 'by', p_user, 'via', p_via));
  return to_jsonb(r);
end $$;

-- sent again (WhatsApp / email / copied): counted, the way it went last
create or replace function public.paylink_sent(p_business uuid, p_request uuid, p_via text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(p_via, '') not in ('whatsapp', 'email', 'link') then raise exception 'paylink_request: how it is sent' using errcode = '22023'; end if;
  update public.payment_requests set sent_via = p_via, sends = least(sends + 1, 50)
   where id = p_request and business_id = p_business and status in ('sent', 'failed') and expires_at > now();
  return found;
end $$;

-- cancelled by the owner (a link not paid yet): the page tells the customer; a payment already on its way is still recorded
create or replace function public.paylink_cancel(p_business uuid, p_request uuid, p_user uuid, p_reason text default '') returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.payment_requests;
begin
  select * into r from public.payment_requests where id = p_request and business_id = p_business for update;
  if r.id is null then return jsonb_build_object('result', 'not_found'); end if;
  if r.status not in ('sent', 'failed') then return jsonb_build_object('result', 'ignored', 'status', r.status); end if;
  update public.payment_requests set status = 'cancelled', cancelled_at = now(), cancelled_by = p_user,
         cancel_reason = left(btrim(coalesce(p_reason, '')), 300)
   where id = r.id;
  perform public.finance_log(p_business, 'paylink.cancelled', 'payment_requests', r.id::text, jsonb_build_object('by', p_user));
  return jsonb_build_object('result', 'ok', 'status', 'cancelled');
end $$;

-- links past their time (the cron); the public page also reads the time itself
create or replace function public.paylinks_expire() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.payment_requests set status = 'expired' where status in ('sent', 'failed') and expires_at <= now();
  get diagnostics n = row_count;
  return n;
end $$;

-- the link's email to the customer (one per send: p_ref), through the one outbox; false when there is no email
create or replace function public.paylink_email(p_request uuid, p_ref text default '') returns boolean
language plpgsql security definer set search_path = public as $$
declare r public.payment_requests; n int;
begin
  select * into r from public.payment_requests where id = p_request;
  if r.id is null or r.customer_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then return false; end if;
  insert into public.email_outbox (business_id, store_id, order_id, request_id, kind, ref, to_email)
  values (r.business_id, (select s.id from public.stores s where s.business_id = r.business_id), null, r.id, 'payment_link',
          left(coalesce(p_ref, ''), 80), r.customer_email)
  on conflict do nothing;
  get diagnostics n = row_count;
  return n = 1;
end $$;

-- ---- 6. the storefront's server: the page, the notices, the provider's answer ----------------------------------------------
-- the link, its terminal (sealed: only that server opens it) and the name the customer knows
create or replace function public.sf_paylink(p_request uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', r.id, 'business', r.business_id, 'status', r.status, 'amount', trim_scale(r.amount), 'currency', r.currency,
           'test', r.is_test, 'provider', r.provider, 'expires_at', r.expires_at, 'expired', r.expires_at <= now(), 'pages', r.pages,
           'label', r.label, 'customer', jsonb_build_object('name', r.customer_name, 'email', r.customer_email, 'phone', r.customer_phone),
           'business_name', coalesce(nullif(btrim(fp.trading_name), ''), nullif(btrim(br.name), ''), nullif(btrim(rs.legal_name), ''), b.name),
           'account', case when a.business_id is null then null
                      else jsonb_build_object('provider', a.provider, 'mode', a.mode, 'sealed', a.sealed, 'page_uid', a.page_uid) end)
    from public.payment_requests r
    join public.businesses b on b.id = r.business_id
    left join public.payment_accounts a on a.business_id = r.business_id
    left join public.business_finance_profile fp on fp.business_id = r.business_id
    left join public.brands br on br.business_id = r.business_id
    left join public.register_settings rs on rs.business_id = r.business_id
   where r.id = p_request
   limit 1
$$;

-- a new page of the provider for this link (an open link; at most 5 tries). A link that failed is open again. Closed too when
-- what it pays changed since it was sent: the invoice was cancelled or paid meanwhile (less left than the link asks), the quote
-- is no longer accepted (or its document), the appointment is no longer open — nobody pays for what is not owed any more
create or replace function public.sf_paylink_page(p_request uuid, p_page text, p_url text) returns text
language plpgsql security definer set search_path = public as $$
declare r public.payment_requests; d public.documents; left_now numeric;
begin
  select * into r from public.payment_requests where id = p_request for update;
  if r.id is null then return 'not_found'; end if;
  if r.status not in ('sent', 'failed') or r.expires_at <= now() then return 'closed'; end if;
  if r.kind = 'document' then
    select * into d from public.documents where id = r.document_id;
    if exists (select 1 from public.document_cancellations x where x.document_id = r.document_id) then return 'closed'; end if;
    left_now := d.total - coalesce((select sum(c.total) from public.documents c where c.business_id = d.business_id and c.doc_type = 330
                                     and c.base_doc_type = d.doc_type and c.base_doc_number = d.doc_number), 0)
                        - coalesce((select sum(case p.direction when 'in' then p.amount else -p.amount end) from public.payments p where p.applies_to = d.id), 0);
    if left_now < r.amount then return 'closed'; end if;
  elsif r.kind = 'quote' then
    if not exists (select 1 from public.quotes q where q.id = r.quote_id and q.status in ('accepted', 'converted')) then return 'closed'; end if;
  elsif not exists (select 1 from public.appointments a where a.id = r.appointment_id and a.status in ('booked', 'confirmed')) then
    return 'closed';
  end if;
  if jsonb_array_length(r.pages) >= 5 then return 'too_many'; end if;
  if coalesce(btrim(p_page), '') = '' or length(p_page) > 120 or coalesce(p_url, '') !~ '^https?://' or length(p_url) > 500 then return 'bad'; end if;
  if exists (select 1 from jsonb_array_elements(r.pages) e where e->>'page' = p_page) then return 'ok'; end if;
  update public.payment_requests
     set pages = pages || jsonb_build_array(jsonb_build_object('page', p_page, 'url', p_url, 'at', now(), 'state', 'pending')),
         status = 'sent'
   where id = r.id;
  return 'ok';
end $$;

-- a notice / a check of a link's payment, once: true when it is new (a repeated or replayed one changes nothing)
create or replace function public.sf_paylink_event(p_request uuid, p_provider text, p_key text, p_kind text,
                                                   p_signature_ok boolean, p_payload jsonb) returns boolean
language plpgsql security definer set search_path = public as $$
declare b uuid; n int;
begin
  select business_id into b from public.payment_requests where id = p_request;
  if b is null then return false; end if;
  insert into public.payment_events (business_id, order_id, request_id, provider, event_key, kind, signature_ok, payload)
  values (b, null, p_request, p_provider, left(p_key, 200), p_kind, p_signature_ok, coalesce(p_payload, '{}'::jsonb))
  on conflict (event_key) do nothing;
  get diagnostics n = row_count;
  return n = 1;
end $$;

-- the provider confirmed (asked directly — never a notice alone) that this transaction paid this link, on one of its pages.
-- The same transaction again → 'already'; another transaction → 'double' (logged for the owner, nothing else changes);
-- another amount or currency → 'mismatch'. A test link → paid (test): no money, no receipt. A real one → paid, its receipt
-- 'pending' (issued by the server now) or 'awaiting' (the owner approves first). Late (expired / cancelled) is still paid.
create or replace function public.sf_paylink_paid(p_request uuid, p_page text, p_provider text, p_txn text, p_amount numeric, p_currency text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.payment_requests; was text; how text; who uuid;
begin
  select * into r from public.payment_requests where id = p_request for update;
  if r.id is null then return jsonb_build_object('result', 'not_found'); end if;
  if r.provider <> p_provider or coalesce(btrim(p_txn), '') = ''
     or not exists (select 1 from jsonb_array_elements(r.pages) e where e->>'page' = p_page) then
    perform public.finance_log(r.business_id, 'paylink.rejected', 'payment_requests', r.id::text, jsonb_build_object('provider', p_provider, 'page', left(coalesce(p_page, ''), 80)));
    return jsonb_build_object('result', 'rejected', 'status', r.status);
  end if;
  if r.status = 'paid' then
    if r.provider_txn = p_txn then return jsonb_build_object('result', 'already', 'status', 'paid', 'test', r.is_test); end if;
    perform public.finance_log(r.business_id, 'paylink.double', 'payment_requests', r.id::text, jsonb_build_object('txn', left(p_txn, 120), 'amount', p_amount));
    return jsonb_build_object('result', 'double', 'status', 'paid', 'test', r.is_test);
  end if;
  if p_amount is distinct from r.amount or upper(coalesce(p_currency, '')) <> r.currency then
    perform public.finance_log(r.business_id, 'paylink.mismatch', 'payment_requests', r.id::text,
      jsonb_build_object('txn', left(p_txn, 120), 'amount', p_amount, 'currency', left(coalesce(p_currency, ''), 8)));
    return jsonb_build_object('result', 'mismatch', 'status', r.status);
  end if;
  was := r.status;
  select coalesce(fp.paylink_receipt, 'auto') into how from public.business_finance_profile fp where fp.business_id = r.business_id;
  update public.payment_requests
     set status = 'paid', paid_at = now(), paid_amount = p_amount, provider_txn = left(p_txn, 120), paid_late = was in ('expired', 'cancelled'),
         pages = (select coalesce(jsonb_agg(case when e->>'page' = p_page then jsonb_set(e, '{state}', '"approved"') else e end), '[]'::jsonb)
                    from jsonb_array_elements(r.pages) e),
         receipt_status = case when r.is_test then 'none' when coalesce(how, 'auto') = 'approve' then 'awaiting' else 'pending' end
   where id = r.id;
  perform public.finance_log(r.business_id, case when r.is_test then 'paylink.test_paid' else 'paylink.paid' end, 'payment_requests', r.id::text,
    jsonb_build_object('txn', left(p_txn, 120), 'amount', p_amount, 'late', was in ('expired', 'cancelled')));
  -- the customer's card
  who := coalesce(r.user_id, public.commerce_owner(r.business_id));
  if r.lead_id is not null and who is not null then
    insert into public.lead_activities (user_id, business_id, lead_id, kind, body)
    values (who, r.business_id, r.lead_id, 'purchase',
            format('שולם בלינק: %s · ₪%s%s', r.label, trim_scale(p_amount), case when r.is_test then ' (בדיקה — לא כסף אמיתי)' else '' end));
  end if;
  return jsonb_build_object('result', 'ok', 'status', 'paid', 'test', r.is_test, 'late', was in ('expired', 'cancelled'));
end $$;

-- the provider said this page was declined or cancelled: the page is closed; the link fails when no page is still open
-- (the customer may try again with the same link while it is open)
create or replace function public.sf_paylink_failed(p_request uuid, p_page text, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.payment_requests; np jsonb; fails boolean;
begin
  select * into r from public.payment_requests where id = p_request for update;
  if r.id is null then return jsonb_build_object('result', 'not_found'); end if;
  if not exists (select 1 from jsonb_array_elements(r.pages) e where e->>'page' = p_page and e->>'state' = 'pending') then
    return jsonb_build_object('result', 'ignored', 'status', r.status);
  end if;
  select coalesce(jsonb_agg(case when e->>'page' = p_page then jsonb_set(e, '{state}', '"declined"') else e end), '[]'::jsonb)
    into np from jsonb_array_elements(r.pages) e;
  -- the link fails when it was open and none of its pages is open any more (an expired / cancelled one stays as it is)
  fails := r.status = 'sent' and not exists (select 1 from jsonb_array_elements(np) e where e->>'state' = 'pending');
  update public.payment_requests
     set pages = np,
         status = case when fails then 'failed' else r.status end,
         failed_at = case when fails then now() else r.failed_at end,
         fail_reason = case when fails then left(coalesce(p_reason, ''), 120) else r.fail_reason end
   where id = r.id
  returning * into r;
  perform public.finance_log(r.business_id, 'paylink.failed', 'payment_requests', r.id::text, jsonb_build_object('reason', left(coalesce(p_reason, ''), 120)));
  return jsonb_build_object('result', 'ok', 'status', r.status);
end $$;

-- links with a page nobody confirmed for 10 minutes (no notice came, the customer closed the tab): the storefront's cron
-- asks the provider — also for a link that expired or was cancelled meanwhile (a late payment is never lost)
create or replace function public.sf_paylinks_unconfirmed(p_limit int default 50) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x.id), '[]'::jsonb) from (
    select r.id from public.payment_requests r
     where r.status <> 'paid' and r.created_at > now() - interval '40 days'
       and exists (select 1 from jsonb_array_elements(r.pages) e
                    where e->>'state' = 'pending' and (e->>'at')::timestamptz < now() - interval '10 minutes'
                      and (e->>'at')::timestamptz > now() - interval '3 days')
     order by r.updated_at limit least(greatest(coalesce(p_limit, 50), 1), 200)) x
$$;

-- the terminal of a business, for "בדיקת חיבור" (the dashboard's server asks the storefront's, which opens the keys)
create or replace function public.sf_paylink_account(p_business uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('provider', a.provider, 'mode', a.mode, 'sealed', a.sealed, 'page_uid', a.page_uid,
           'business_name', coalesce(nullif(btrim(fp.trading_name), ''), nullif(btrim(br.name), ''), b.name))
    from public.payment_accounts a join public.businesses b on b.id = a.business_id
    left join public.business_finance_profile fp on fp.business_id = a.business_id
    left join public.brands br on br.business_id = a.business_id
   where a.business_id = p_business limit 1
$$;
-- the provider accepted these very keys (a page was created): verified — not when the keys changed meanwhile
create or replace function public.sf_paylink_verified(p_business uuid, p_sealed text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update public.payment_accounts set verified_at = now() where business_id = p_business and sealed = p_sealed;
  return found;
end $$;

-- ---- 7. the receipt (the dashboard's server) ----------------------------------------------------------------------------------
-- real links paid whose receipt the server issues now
create or replace function public.paylinks_receipts_pending(p_limit int default 20) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x.id), '[]'::jsonb) from (
    select r.id from public.payment_requests r where r.receipt_status = 'pending' and r.status = 'paid' and not r.is_test
     order by r.paid_at limit least(greatest(coalesce(p_limit, 20), 1), 100)) x
$$;

-- the owner approves a receipt that waits (awaiting → pending; the server issues it), or tries a blocked one again
create or replace function public.paylink_receipt_approve(p_business uuid, p_request uuid, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.payment_requests;
begin
  select * into r from public.payment_requests where id = p_request and business_id = p_business for update;
  if r.id is null then return jsonb_build_object('result', 'not_found'); end if;
  if r.receipt_status not in ('awaiting', 'blocked') then return jsonb_build_object('result', 'ignored', 'receipt', r.receipt_status); end if;
  update public.payment_requests set receipt_status = 'pending', receipt_error = '' where id = r.id;
  perform public.finance_log(p_business, 'paylink.receipt_approved', 'payment_requests', r.id::text, jsonb_build_object('by', p_user));
  return jsonb_build_object('result', 'ok', 'receipt', 'pending');
end $$;

-- the receipt was issued (p_document: the link's own key, in its business), or cannot be until the business fixes something
-- (p_error, in Hebrew): blocked, shown to the owner. A blocked one is tried again only by the owner's approval.
create or replace function public.paylink_receipt_done(p_request uuid, p_document uuid, p_error text default '') returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.payment_requests;
begin
  select * into r from public.payment_requests where id = p_request for update;
  if r.id is null or r.status <> 'paid' or r.is_test then return jsonb_build_object('result', 'not_found'); end if;
  if p_document is not null then
    if not exists (select 1 from public.documents d where d.id = p_document and d.business_id = r.business_id
                    and d.idempotency_key = 'paylink:' || r.id::text) then
      raise exception 'the document is not this link''s receipt' using errcode = '23514'; end if;
    if r.receipt_status = 'issued' then
      return jsonb_build_object('result', case when r.receipt_document_id = p_document then 'already' else 'other' end); end if;
    update public.payment_requests set receipt_status = 'issued', receipt_document_id = p_document, receipt_error = '' where id = r.id;
    perform public.finance_log(r.business_id, 'paylink.receipt', 'payment_requests', r.id::text, jsonb_build_object('document', p_document));
    return jsonb_build_object('result', 'ok', 'receipt', 'issued');
  end if;
  if r.receipt_status = 'issued' then return jsonb_build_object('result', 'already'); end if;
  update public.payment_requests set receipt_status = 'blocked', receipt_error = left(coalesce(nullif(btrim(p_error), ''), 'הקבלה לא הופקה'), 300)
   where id = r.id;
  perform public.finance_log(r.business_id, 'paylink.receipt_blocked', 'payment_requests', r.id::text, jsonb_build_object('error', left(coalesce(p_error, ''), 200)));
  return jsonb_build_object('result', 'ok', 'receipt', 'blocked');
end $$;

-- ---- 8. a deposit, offset from the final payment (the register: also a cashier's) --------------------------------------------
-- what was really paid (no test link) as a deposit for these appointments of the business worked in now — the amount only
create or replace function public.appointment_deposits(p_ids uuid[]) returns table (appointment_id uuid, amount numeric)
language sql stable security definer set search_path = public as $$
  select r.appointment_id, sum(r.paid_amount)::numeric
    from public.payment_requests r
   where r.kind = 'deposit' and r.status = 'paid' and not r.is_test and r.appointment_id = any(coalesce(p_ids, '{}'::uuid[]))
     and r.business_id = public.current_business_id() and r.business_id in (select public.accessible_business_ids())
   group by r.appointment_id
$$;
revoke execute on function public.appointment_deposits(uuid[]) from public, anon;
grant execute on function public.appointment_deposits(uuid[]) to authenticated;

-- ---- 9. emails: a link's email in the one outbox ----------------------------------------------------------------------------
alter table public.email_outbox add column if not exists request_id uuid references public.payment_requests on delete cascade;
alter table public.email_outbox alter column order_id drop not null;
alter table public.email_outbox alter column store_id drop not null;
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'email_outbox_kind_check' and conrelid = 'public.email_outbox'::regclass
              and pg_get_constraintdef(oid) not like '%payment_link%') then
    alter table public.email_outbox drop constraint email_outbox_kind_check;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'email_outbox_kind_check' and conrelid = 'public.email_outbox'::regclass) then
    alter table public.email_outbox add constraint email_outbox_kind_check
      check (kind in ('order_confirmation', 'order_ready', 'order_shipped', 'order_refunded', 'payment_link'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'email_outbox_about_check' and conrelid = 'public.email_outbox'::regclass) then
    alter table public.email_outbox add constraint email_outbox_about_check
      check ((kind <> 'payment_link' and order_id is not null and store_id is not null and request_id is null)
             or (kind = 'payment_link' and request_id is not null and order_id is null));
  end if;
end $$;
create unique index if not exists email_outbox_request_uq on public.email_outbox (request_id, kind, ref) where request_id is not null;

-- as in 3600: a provider id → sent; else again later, and after 5 tries (or a final error) failed — an order's email also
-- tells the order and the owner; a link's email has no order (the link's screen shows the email's state)
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
    return 'sent';
  end if;
  if p_final or e.attempts >= 5 then
    update public.email_outbox set status = 'failed', last_error = left(coalesce(p_error, ''), 300), updated_at = now() where id = e.id;
    if e.order_id is not null then
      perform public.order_event(e.order_id, 'email_failed', jsonb_build_object('kind', e.kind, 'error', left(coalesce(p_error, ''), 120)));
      perform public.store_alert(e.order_id, 'email_failed', 'מייל ללקוח לא נשלח: ' || left(coalesce(p_error, ''), 200));
    end if;
    return 'failed';
  end if;
  update public.email_outbox set status = 'queued', last_error = left(coalesce(p_error, ''), 300), updated_at = now() where id = e.id;
  return 'queued';
end $$;

-- ---- 10. who runs what --------------------------------------------------------------------------------------------------------
do $$
declare f text;
begin
  -- the storefront's server and the dashboard's server (service role) only
  foreach f in array array['public.paylink_create(uuid, uuid, text, uuid, numeric, int, text, text, uuid)',
    'public.paylink_sent(uuid, uuid, text)', 'public.paylink_cancel(uuid, uuid, uuid, text)', 'public.paylinks_expire()',
    'public.paylink_email(uuid, text)', 'public.sf_paylink(uuid)', 'public.sf_paylink_page(uuid, text, text)',
    'public.sf_paylink_event(uuid, text, text, text, boolean, jsonb)', 'public.sf_paylink_paid(uuid, text, text, text, numeric, text)',
    'public.sf_paylink_failed(uuid, text, text)', 'public.sf_paylinks_unconfirmed(int)', 'public.sf_paylink_account(uuid)',
    'public.sf_paylink_verified(uuid, text)', 'public.paylinks_receipts_pending(int)', 'public.paylink_receipt_approve(uuid, uuid, uuid)',
    'public.paylink_receipt_done(uuid, uuid, text)', 'public.email_outbox_done(uuid, text, text, boolean)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- ============================================================================================================================
-- Rollback (by hand, if ever needed — the links sent and their log go with it):
--   drop trigger b_payment_accounts_unverify on payment_accounts; drop function payment_accounts_unverify();
--   the functions of sections 1 and 5–8 (payment_links_live, paylink_*, paylinks_*, sf_paylink*, appointment_deposits);
--   email_outbox_done back to its text in 20261006003600; email_outbox: delete the payment_link rows, drop constraint
--   email_outbox_about_check, the kind check back to the four order kinds, set order_id / store_id not null, drop column request_id;
--   payment_events: drop column request_id; drop table payment_requests (and its guard function); the columns
--   payment_accounts.verified_at, business_finance_profile.paylink_receipt, booking_services.deposit and their checks;
--   delete from platform_flags where key = 'payment_links_live'.
-- ============================================================================================================================
