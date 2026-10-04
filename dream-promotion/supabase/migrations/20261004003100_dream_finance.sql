-- ============================================================================
-- Migration 20261004003100 — Dream Finance 2.51 (additive only: no table, column or row is removed or renamed)
-- Built on the legal documents (1400), the register (1200–1800, 3000) and the multi-business rules (1900–2600).
--   1. business identity  register_settings.entity_type (עוסק פטור / מורשה / חברה / שותפות / מלכ"ר) +
--                         business_finance_profile (bank, payment terms, notes, accountant — never shown to a cashier)
--   2. documents          issuer snapshot (the business as it was on the day of issue), idempotency key, source,
--                         due date, notes, links (paid document, quote, draft). Every insert is checked here:
--                         the type is allowed for the business, totals add up to the agora, VAT matches the rate,
--                         a receipt's payments cover it, no future date, no closed period, a credit invoice never
--                         beyond its invoice (inside a row lock), references stay inside the business
--   3. drafts             document_drafts — no number until issued; issuing marks the draft in the same transaction
--   4. cancellations      document_cancellations — a receipt (400) or transaction invoice (300) issued by mistake.
--                         The document row itself never changes; tax invoices keep the credit invoice (330)
--   5. payments ledger    payments — every shekel in and out, written only by the database (receipts, register
--                         refunds, credit refunds, expenses, cancellations). receivables = 305/300 − credits − payments
--   6. quotes             quotes — numbered per business, statuses, a private link for the customer
--   7. expenses           expenses + the private bucket "finance-files"; never deleted (void); stock comes in through
--                         the same stock log as sales — there is no second inventory
--   8. tax authority      tax_allocation_rules (versioned, verified = false until checked against the official
--                         publication), tax_allocations (append-only; a test number can never pass as a real one),
--                         tax_authority_connections (tokens: server only, one row per business)
--   9. audit              finance_audit_log — append-only, hash-chained per business, written by triggers
--  10. privacy            a super admin sees a business's money only after opening access with a reason
--                         (finance_access_grants: at most 8 hours, written to that business's audit log)
--  11. period lock        finance_period_locks — closed books: no new or changed document / expense dated inside
--  12. reports            receivables view and finance_summary(): the numbers come from the database, in one place
-- Cashier ("קופאי/ת", access = 'register'): none of the new tables (restrictive policies), as in 3000.
-- Idempotent. Rollback: remove the tables, views, functions, triggers and policies created here (the added
-- columns can stay — nothing before 2.51 reads them).
-- ============================================================================

-- ---- 0. helpers ---------------------------------------------------------------------------------------
create or replace function public.il_today() returns date
language sql stable set search_path = public as $$ select (now() at time zone 'Asia/Jerusalem')::date $$;

-- the legal kind of business: the explicit entity, else the register's exempt / licensed switch
create or replace function public.entity_of(p_entity text, p_business_type text) returns text
language sql immutable set search_path = public as $$
  select coalesce(p_entity, case when p_business_type = 'exempt' then 'exempt_dealer' else 'licensed_dealer' end);
$$;
-- an exempt dealer (עוסק פטור) and a non-profit (מלכ"ר) charge no VAT and never issue tax invoices
create or replace function public.entity_charges_vat(p_entity text) returns boolean
language sql immutable set search_path = public as $$
  select coalesce(p_entity, 'licensed_dealer') not in ('exempt_dealer', 'nonprofit');
$$;
create or replace function public.entity_doc_types(p_entity text) returns int[]
language sql immutable set search_path = public as $$
  select case when public.entity_charges_vat(p_entity) then array[300, 305, 320, 330, 400] else array[300, 400] end;
$$;

-- ---- 1. business identity ------------------------------------------------------------------------------
alter table public.register_settings add column if not exists entity_type text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'register_settings_entity_type_check') then
    alter table public.register_settings add constraint register_settings_entity_type_check
      check (entity_type is null or entity_type in ('exempt_dealer', 'licensed_dealer', 'company', 'partnership', 'nonprofit'));
  end if;
end $$;

-- the register's exempt / licensed switch and the entity always agree (the register keeps using business_type)
create or replace function public.register_settings_entity() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.entity_type is not null then
    if tg_op = 'UPDATE' and new.business_type is distinct from old.business_type and new.entity_type is not distinct from old.entity_type then
      if new.business_type = 'exempt' and new.entity_type not in ('exempt_dealer', 'nonprofit') then new.entity_type := 'exempt_dealer';
      elsif new.business_type = 'licensed' and new.entity_type in ('exempt_dealer', 'nonprofit') then new.entity_type := 'licensed_dealer';
      end if;
    end if;
    new.business_type := case when public.entity_charges_vat(new.entity_type) then 'licensed' else 'exempt' end;
  end if;
  return new;
end $$;
revoke execute on function public.register_settings_entity() from public, anon, authenticated;
create or replace trigger b_register_settings_entity before insert or update on public.register_settings
  for each row execute function public.register_settings_entity();

-- the rest of the money profile: a separate table, so a cashier (who reads register_settings) never sees it
create table if not exists public.business_finance_profile (
  business_id      uuid primary key references public.businesses on delete restrict,
  user_id          uuid references auth.users on delete set null,            -- who saved last
  trading_name     text not null default '' check (length(trading_name) <= 120),
  phone            text not null default '' check (length(phone) <= 30),
  email            text not null default '' check (email = '' or email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  bank_name        text not null default '' check (length(bank_name) <= 60),
  bank_branch      text not null default '' check (bank_branch ~ '^[0-9]{0,5}$'),
  bank_account     text not null default '' check (bank_account ~ '^[0-9-]{0,20}$'),
  payment_terms    text not null default 'immediate' check (payment_terms ~ '^(immediate|net_[0-9]{1,3}|eom_[0-9]{1,3})$'),
  quote_valid_days int  not null default 30 check (quote_valid_days between 1 and 365),
  doc_note         text not null default '' check (length(doc_note) <= 500),
  vat_period       text not null default 'bimonthly' check (vat_period in ('monthly', 'bimonthly')),
  accountant_name  text not null default '' check (length(accountant_name) <= 80),
  accountant_email text not null default '' check (accountant_email = '' or accountant_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  updated_at       timestamptz not null default now()
);
create or replace trigger a_fill_business_id before insert on public.business_finance_profile for each row execute function public.fill_business_id();
create or replace trigger touch_business_finance_profile before update on public.business_finance_profile for each row execute function public.touch_updated_at();

-- ---- 2. documents: new columns (nothing existing changes) ------------------------------------------------
alter table public.documents add column if not exists issuer           jsonb;
alter table public.documents add column if not exists idempotency_key  text;
alter table public.documents add column if not exists source           text;
alter table public.documents add column if not exists due_date         date;
alter table public.documents add column if not exists notes            text not null default '';
alter table public.documents add column if not exists customer_email   text not null default '';
alter table public.documents add column if not exists paid_document_id uuid references public.documents on delete restrict;
alter table public.documents add column if not exists draft_id         uuid;
alter table public.documents add column if not exists quote_id         uuid;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'documents_idempotency_key_check') then
    alter table public.documents add constraint documents_idempotency_key_check check (idempotency_key is null or length(idempotency_key) between 1 and 120);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'documents_source_check') then
    alter table public.documents add constraint documents_source_check
      check (source is null or source in ('pos', 'direct', 'quote', 'refund', 'credit', 'receipt'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'documents_notes_check') then
    alter table public.documents add constraint documents_notes_check check (length(notes) <= 1000 and length(customer_email) <= 120);
  end if;
end $$;
-- one document per idempotency key in a business: a double tap or a retry never issues twice
create unique index if not exists documents_idempotency_uq on public.documents (business_id, idempotency_key);
create index if not exists documents_business_date_idx on public.documents (business_id, doc_date desc);
create index if not exists documents_business_type_idx on public.documents (business_id, doc_type, doc_number desc);
create index if not exists documents_lead_idx on public.documents (business_id, lead_id) where lead_id is not null;
create index if not exists documents_base_idx on public.documents (business_id, base_doc_type, base_doc_number) where base_doc_number is not null;
create index if not exists documents_paid_doc_idx on public.documents (paid_document_id) where paid_document_id is not null;
create index if not exists documents_sale_idx on public.documents (sale_id) where sale_id is not null;
create index if not exists sales_business_paid_idx on public.sales (business_id, paid_at) where status = 'paid';

-- ---- 3. drafts -------------------------------------------------------------------------------------------
create table if not exists public.document_drafts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users on delete set null,
  business_id   uuid not null references public.businesses on delete restrict,
  doc_type      int  not null check (doc_type in (300, 305, 320, 330, 400)),
  status        text not null default 'open' check (status in ('open', 'finalized')),
  customer_name text not null default '' check (length(customer_name) <= 120),
  lead_id       uuid references public.leads on delete set null,
  quote_id      uuid,
  total         numeric(14,2) not null default 0,
  body          jsonb not null default '{}' check (jsonb_typeof(body) = 'object' and pg_column_size(body) <= 200000),
  document_id   uuid references public.documents on delete restrict,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check ((status = 'finalized') = (document_id is not null))
);
create index if not exists document_drafts_business_idx on public.document_drafts (business_id, status, updated_at desc);
create or replace trigger a_fill_business_id before insert on public.document_drafts for each row execute function public.fill_business_id();
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'documents_draft_fk') then
    alter table public.documents add constraint documents_draft_fk foreign key (draft_id) references public.document_drafts on delete restrict;
  end if;
end $$;

-- ---- 4. cancellations ------------------------------------------------------------------------------------
create table if not exists public.document_cancellations (
  document_id uuid primary key references public.documents on delete restrict,
  business_id uuid not null references public.businesses on delete restrict,
  user_id     uuid references auth.users on delete set null,
  reason      text not null check (length(trim(reason)) between 2 and 300),
  created_at  timestamptz not null default now()
);
create index if not exists document_cancellations_business_idx on public.document_cancellations (business_id);
create or replace trigger a_fill_business_id before insert on public.document_cancellations for each row execute function public.fill_business_id();

-- ---- 5. quotes --------------------------------------------------
create table if not exists public.quotes (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references auth.users on delete set null,
  business_id     uuid not null references public.businesses on delete restrict,
  quote_number    bigint not null default 0,
  status          text not null default 'draft' check (status in ('draft', 'sent', 'accepted', 'rejected', 'expired', 'converted', 'cancelled')),
  customer_name   text not null default '' check (length(customer_name) <= 120),
  customer_phone  text not null default '' check (length(customer_phone) <= 30),
  customer_email  text not null default '' check (length(customer_email) <= 120),
  customer_dealer text not null default '' check (customer_dealer = '' or customer_dealer ~ '^[0-9]{9}$'),
  customer_street text not null default '' check (length(customer_street) <= 120),
  customer_city   text not null default '' check (length(customer_city) <= 60),
  lead_id         uuid references public.leads on delete set null,
  body            jsonb not null default '{}' check (jsonb_typeof(body) = 'object' and pg_column_size(body) <= 200000),
  before_discount numeric(14,2) not null default 0 check (before_discount >= 0),
  discount        numeric(14,2) not null default 0 check (discount >= 0),
  after_discount  numeric(14,2) not null default 0,
  vat_rate        numeric(5,2)  not null default 0 check (vat_rate between 0 and 30),
  vat_amount      numeric(14,2) not null default 0 check (vat_amount >= 0),
  total           numeric(14,2) not null default 0 check (total >= 0),
  valid_until     date,
  notes           text not null default '' check (length(notes) <= 2000),
  issuer          jsonb,
  share_token     text not null default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  sent_at         timestamptz,
  decided_at      timestamptz,
  decision_by     text not null default '' check (length(decision_by) <= 80),
  decision_note   text not null default '' check (length(decision_note) <= 500),
  converted_document_id uuid references public.documents on delete restrict,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (after_discount = before_discount - discount and total = after_discount + vat_amount)
);
create unique index if not exists quotes_share_token_uq on public.quotes (share_token);
create unique index if not exists quotes_number_uq on public.quotes (business_id, quote_number);
create index if not exists quotes_business_idx on public.quotes (business_id, created_at desc);
create index if not exists quotes_lead_idx on public.quotes (business_id, lead_id) where lead_id is not null;
create or replace trigger a_fill_business_id before insert on public.quotes for each row execute function public.fill_business_id();
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'documents_quote_fk') then
    alter table public.documents add constraint documents_quote_fk foreign key (quote_id) references public.quotes on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'document_drafts_quote_fk') then
    alter table public.document_drafts add constraint document_drafts_quote_fk foreign key (quote_id) references public.quotes on delete set null;
  end if;
end $$;

-- ---- 6. expenses -------------------------------------------------------------------------------------------
create table if not exists public.expenses (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid references auth.users on delete set null,
  business_id         uuid not null references public.businesses on delete restrict,
  expense_number      bigint not null default 0,
  status              text not null default 'confirmed' check (status in ('draft', 'confirmed', 'void')),
  supplier_name       text not null check (length(trim(supplier_name)) between 1 and 120),
  supplier_dealer     text not null default '' check (supplier_dealer = '' or supplier_dealer ~ '^[0-9]{9}$'),
  supplier_doc_type   text not null default 'tax_invoice' check (supplier_doc_type in ('tax_invoice', 'tax_invoice_receipt', 'receipt', 'invoice', 'credit', 'other')),
  supplier_doc_number text not null default '' check (length(supplier_doc_number) <= 40),
  allocation_number   text not null default '' check (allocation_number ~ '^[0-9]{0,20}$'),
  doc_date            date not null,
  category            text not null default 'other' check (category ~ '^[a-z_]{2,30}$'),
  description         text not null default '' check (length(description) <= 300),
  amount_before_vat   numeric(14,2) not null check (amount_before_vat >= 0),
  vat_amount          numeric(14,2) not null default 0 check (vat_amount >= 0),
  total               numeric(14,2) not null check (total > 0),
  vat_deductible_pct  numeric(5,2)  not null default 100 check (vat_deductible_pct between 0 and 100),
  paid_on             date,
  payment_method      text check (payment_method is null or payment_method in ('cash', 'card', 'transfer', 'bit', 'cheque', 'other')),
  file_path           text not null default '' check (length(file_path) <= 300),
  file_mime           text not null default '' check (length(file_mime) <= 80),
  ai_extracted        jsonb,                              -- what the AI read, kept as it was (never posted by itself)
  ai_model            text not null default '' check (length(ai_model) <= 80),
  confirmed_by        uuid references auth.users on delete set null,
  confirmed_at        timestamptz,
  stock_lines         jsonb not null default '[]' check (jsonb_typeof(stock_lines) = 'array'),  -- [{itemId, qty}]
  void_reason         text not null default '' check (length(void_reason) <= 300),
  voided_at           timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check (total = amount_before_vat + vat_amount),
  -- only a tax invoice (or a supplier's credit note) carries VAT that can be deducted
  check (vat_amount = 0 or supplier_doc_type in ('tax_invoice', 'tax_invoice_receipt', 'credit')),
  check ((paid_on is null) = (payment_method is null)),
  check (status <> 'void' or (voided_at is not null and length(trim(void_reason)) >= 2))
);
create unique index if not exists expenses_number_uq on public.expenses (business_id, expense_number);
create index if not exists expenses_business_date_idx on public.expenses (business_id, doc_date desc);
create index if not exists expenses_business_status_idx on public.expenses (business_id, status);
create or replace trigger a_fill_business_id before insert on public.expenses for each row execute function public.fill_business_id();

-- stock that came in with an expense / went out with a document is traceable to it
alter table public.stock_movements add column if not exists expense_id  uuid references public.expenses on delete set null;
alter table public.stock_movements add column if not exists document_id uuid references public.documents on delete set null;

-- ---- 7. payments ledger ---------------------------------------------------------------------------------------
create table if not exists public.payments (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses on delete restrict,
  user_id     uuid references auth.users on delete set null,
  direction   text not null check (direction in ('in', 'out')),
  amount      numeric(14,2) not null check (amount > 0),
  method      text not null check (method in ('cash', 'card', 'transfer', 'bit', 'cheque', 'other')),
  paid_on     date not null,
  source      text not null check (source in ('document', 'refund', 'credit', 'expense', 'cancel', 'reversal')),
  document_id uuid references public.documents on delete restrict,     -- the receipt / credit invoice / cancelled receipt
  applies_to  uuid references public.documents on delete restrict,     -- the invoice (305 / 300) it pays or pays back
  sale_id     uuid references public.sales on delete set null,
  refund_id   uuid references public.sale_refunds on delete restrict,
  expense_id  uuid references public.expenses on delete restrict,
  lead_id     uuid references public.leads on delete set null,
  reference   jsonb not null default '{}' check (jsonb_typeof(reference) = 'object'),  -- cheque: bank, branch, account, number, dueDate
  note        text not null default '' check (length(note) <= 300),
  created_at  timestamptz not null default now(),
  check (source not in ('document', 'credit', 'cancel') or document_id is not null),
  check (source <> 'refund' or refund_id is not null),
  check (source <> 'expense' or expense_id is not null),
  check (source <> 'reversal' or expense_id is not null or document_id is not null)
);
create index if not exists payments_business_date_idx on public.payments (business_id, paid_on desc);
create index if not exists payments_applies_idx on public.payments (applies_to) where applies_to is not null;
create index if not exists payments_document_idx on public.payments (document_id) where document_id is not null;
create index if not exists payments_expense_idx on public.payments (expense_id) where expense_id is not null;
create index if not exists payments_refund_idx on public.payments (refund_id) where refund_id is not null;

-- ---- numbering of quotes and expenses (documents keep document_counters) -------------------------------------
create table if not exists public.finance_counters (
  business_id uuid not null references public.businesses on delete restrict,
  kind        text not null check (kind in ('quote', 'expense')),
  last_no     bigint not null default 0,
  primary key (business_id, kind)
);

-- ---- 8. tax authority -----------------------------------------------------------------------------------------
-- when an invoice needs an allocation number ("מספר הקצאה"). Versioned: a new rule is a new row, old rows stay.
-- verified = false: the thresholds below were NOT checked against the official Tax Authority publication
-- (www.gov.il is not reachable from the development environment) — an accountant confirms before use.
create table if not exists public.tax_allocation_rules (
  version              int  primary key,
  effective_from       date not null unique,
  threshold_before_vat numeric(14,2) not null check (threshold_before_vat > 0),
  doc_types            int[] not null default '{305,320}',
  requires_customer_dealer boolean not null default true,
  verified             boolean not null default false,
  source_note          text not null default '',
  created_at           timestamptz not null default now()
);
insert into public.tax_allocation_rules (version, effective_from, threshold_before_vat, source_note) values
  (1, '2024-05-05', 25000, 'מקורות משניים (פרסומי רו"ח ותוכנות) — לא אומת מול פרסום רשמי של רשות המסים'),
  (2, '2025-01-01', 20000, 'מקורות משניים — לא אומת מול פרסום רשמי של רשות המסים'),
  (3, '2026-01-01', 10000, 'מקורות משניים — לא אומת מול פרסום רשמי של רשות המסים'),
  (4, '2026-06-01', 5000,  'מקורות משניים — לא אומת מול פרסום רשמי של רשות המסים')
on conflict (version) do nothing;

-- every request for an allocation number, append-only. A test number ("TEST-…", gateway = mock) can never be
-- stored as a real one: real numbers are digits only, test numbers must start with TEST-.
create table if not exists public.tax_allocations (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references public.businesses on delete restrict,
  document_id       uuid not null references public.documents on delete restrict,
  user_id           uuid references auth.users on delete set null,
  status            text not null check (status in ('requested', 'approved', 'rejected', 'error', 'manual')),
  is_test           boolean not null default false,
  allocation_number text check (allocation_number is null or length(allocation_number) between 1 and 40),
  gateway           text not null check (gateway in ('mock', 'live', 'manual')),
  rule_version      int,
  request_digest    text not null default '' check (length(request_digest) <= 64),  -- sha256 of the minimized request, no personal data
  error_code        text not null default '' check (length(error_code) <= 60),
  error_message     text not null default '' check (length(error_message) <= 500),
  created_at        timestamptz not null default now(),
  check (is_test = (gateway = 'mock')),
  check (not is_test or allocation_number is null or allocation_number like 'TEST-%'),
  check (is_test or allocation_number is null or allocation_number ~ '^[0-9]{1,20}$'),
  check (status not in ('approved', 'manual') or allocation_number is not null),
  check ((status = 'manual') = (gateway = 'manual'))
);
create index if not exists tax_allocations_document_idx on public.tax_allocations (document_id, created_at desc);
create index if not exists tax_allocations_business_idx on public.tax_allocations (business_id, created_at desc);
create unique index if not exists tax_allocations_one_real_uq on public.tax_allocations (document_id) where status in ('approved', 'manual') and not is_test;

-- one Tax Authority (SHAAM) connection per business; the tokens are sealed by the server and never leave it
create table if not exists public.tax_authority_connections (
  business_id          uuid primary key references public.businesses on delete restrict,
  status               text not null default 'not_connected' check (status in ('not_connected', 'connected', 'expired', 'revoked', 'error')),
  environment          text not null default 'test' check (environment in ('test', 'production')),
  access_token_sealed  text,
  refresh_token_sealed text,
  expires_at           timestamptz,
  scope                text not null default '',
  connected_by         uuid references auth.users on delete set null,
  connected_at         timestamptz,
  last_error           text not null default '' check (length(last_error) <= 500),
  updated_at           timestamptz not null default now()
);
create or replace trigger touch_tax_authority_connections before update on public.tax_authority_connections for each row execute function public.touch_updated_at();

-- ---- 9. audit log -----------------------------------------------------------------------------------------------
create table if not exists public.finance_audit_log (
  id          bigint generated always as identity primary key,
  business_id uuid not null references public.businesses on delete restrict,
  actor_id    uuid,                                   -- who (null = the server / an automatic step)
  actor_kind  text not null check (actor_kind in ('member', 'super_admin', 'server')),
  action      text not null check (action ~ '^[a-z_]+\.[a-z_]+$'),
  entity      text not null default '',
  entity_id   text not null default '',
  details     jsonb not null default '{}',
  at          timestamptz not null default now(),
  prev_hash   text not null default '',
  hash        text not null
);
create index if not exists finance_audit_log_business_idx on public.finance_audit_log (business_id, id desc);

-- ---- 10. super admin access to a business's money: explicit, with a reason, limited in time ------------------------
create table if not exists public.finance_access_grants (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses on delete restrict,
  user_id     uuid not null references auth.users on delete cascade,
  reason      text not null check (length(trim(reason)) between 5 and 300),
  granted_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  check (expires_at > granted_at and expires_at <= granted_at + interval '8 hours')
);
create index if not exists finance_access_grants_idx on public.finance_access_grants (user_id, business_id, expires_at desc);

-- ---- 11. closed periods ----------------------------------------------------------------------------------------------
create table if not exists public.finance_period_locks (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses on delete restrict,
  user_id     uuid references auth.users on delete set null,
  period_end  date not null,
  note        text not null default '' check (length(note) <= 300),
  created_at  timestamptz not null default now()
);
create index if not exists finance_period_locks_idx on public.finance_period_locks (business_id, period_end desc);

-- ============================================================================================================
-- functions
-- ============================================================================================================

-- the businesses whose money the caller may see: their own (member), or one a super admin opened with a reason
create or replace function public.finance_business_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select m.business_id from public.business_members m where m.user_id = auth.uid()
  union
  select g.business_id from public.finance_access_grants g
   where g.user_id = auth.uid() and g.revoked_at is null and g.expires_at > now() and public.is_super_admin();
$$;
revoke execute on function public.finance_business_ids() from public, anon;
grant execute on function public.finance_business_ids() to authenticated, service_role;

-- every money RPC: the business worked in now, accessible, its money open to the caller, never a cashier
create or replace function public.finance_guard() returns uuid
language plpgsql stable security definer set search_path = public as $$
declare b uuid := public.current_business_id();
begin
  if b is null or not public.can_access_business(b) or b not in (select public.finance_business_ids()) or public.my_access() = 'register' then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return b;
end $$;
revoke execute on function public.finance_guard() from public, anon;
grant execute on function public.finance_guard() to authenticated, service_role;

create or replace function public.finance_locked_until(p_business uuid) returns date
language sql stable security definer set search_path = public as $$
  select max(l.period_end) from public.finance_period_locks l where l.business_id = p_business;
$$;
revoke execute on function public.finance_locked_until(uuid) from public, anon;
grant execute on function public.finance_locked_until(uuid) to authenticated, service_role;

-- the next number of a quote / expense in a business (a locked counter row, like documents — no gaps, no doubles)
create or replace function public.finance_next_number(p_business uuid, p_kind text) returns bigint
language plpgsql security definer set search_path = public as $$
declare n bigint;
begin
  insert into public.finance_counters (business_id, kind, last_no) values (p_business, p_kind, 0) on conflict do nothing;
  update public.finance_counters set last_no = last_no + 1 where business_id = p_business and kind = p_kind returning last_no into n;
  return n;
end $$;
revoke execute on function public.finance_next_number(uuid, text) from public, anon, authenticated;

-- the issuer as printed on a document / quote: taken once, at issue time, and kept with it
create or replace function public.issuer_snapshot(p_business uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare rs record; fp record; brand text; ent text;
begin
  select * into rs from public.register_settings where business_id = p_business;
  select * into fp from public.business_finance_profile where business_id = p_business;
  select b.name into brand from public.brands b where b.business_id = p_business;
  ent := public.entity_of(rs.entity_type, rs.business_type);
  return jsonb_strip_nulls(jsonb_build_object(
    'name', coalesce(nullif(trim(rs.legal_name), ''), nullif(trim(brand), ''), ''),
    'tradingName', nullif(trim(coalesce(fp.trading_name, '')), ''),
    'entityType', ent,
    'dealerNumber', coalesce(rs.dealer_number, ''),
    'companyNumber', nullif(coalesce(rs.company_number, ''), ''),
    'street', nullif(coalesce(rs.street, ''), ''), 'houseNo', nullif(coalesce(rs.house_no, ''), ''),
    'city', nullif(coalesce(rs.city, ''), ''), 'zip', nullif(coalesce(rs.zip, ''), ''),
    'phone', nullif(coalesce(fp.phone, ''), ''), 'email', nullif(coalesce(fp.email, ''), ''),
    'bankName', nullif(coalesce(fp.bank_name, ''), ''), 'bankBranch', nullif(coalesce(fp.bank_branch, ''), ''),
    'bankAccount', nullif(coalesce(fp.bank_account, ''), ''), 'note', nullif(coalesce(fp.doc_note, ''), ''),
    'vatRate', rs.vat_rate));
end $$;
revoke execute on function public.issuer_snapshot(uuid) from public, anon, authenticated;

-- the audit log: one row per money event, chained per business (each row's hash covers the previous one)
create or replace function public.finance_audit_hash(p_prev text, p_business uuid, p_action text, p_entity text, p_entity_id text,
  p_details jsonb, p_at timestamptz, p_actor uuid, p_kind text) returns text
language sql immutable set search_path = public as $$
  select encode(sha256(convert_to(concat_ws('|', coalesce(p_prev, ''), p_business::text, p_action, coalesce(p_entity, ''), coalesce(p_entity_id, ''),
    coalesce(p_details, '{}'::jsonb)::text, to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), coalesce(p_actor::text, ''), p_kind), 'UTF8')), 'hex');
$$;

create or replace function public.finance_log(p_business uuid, p_action text, p_entity text, p_entity_id text, p_details jsonb default '{}')
returns void language plpgsql security definer set search_path = public as $$
declare prev text; actor uuid := auth.uid(); kind text; ts timestamptz := now();
begin
  if p_business is null then return; end if;
  kind := case when actor is null then 'server'
               when public.is_super_admin() and not exists (select 1 from public.business_members m where m.business_id = p_business and m.user_id = actor) then 'super_admin'
               else 'member' end;
  -- one writer per business at a time, so the chain has no forks
  perform pg_advisory_xact_lock(hashtextextended('finance_audit:' || p_business::text, 0));
  select l.hash into prev from public.finance_audit_log l where l.business_id = p_business order by l.id desc limit 1;
  insert into public.finance_audit_log (business_id, actor_id, actor_kind, action, entity, entity_id, details, at, prev_hash, hash)
  values (p_business, actor, kind, p_action, coalesce(p_entity, ''), coalesce(p_entity_id, ''), coalesce(p_details, '{}'::jsonb), ts, coalesce(prev, ''),
          public.finance_audit_hash(prev, p_business, p_action, p_entity, p_entity_id, coalesce(p_details, '{}'::jsonb), ts, actor, kind));
end $$;
revoke execute on function public.finance_log(uuid, text, text, text, jsonb) from public, anon, authenticated;

-- stock moved by a document or an expense — the same log and the same rules as stock_move (sales / refunds)
create or replace function public.stock_move_ref(p_business uuid, p_item uuid, p_delta int, p_reason text, p_note text, p_document uuid, p_expense uuid)
returns void language plpgsql security definer set search_path = public as $$
declare q int;
begin
  if coalesce(p_delta, 0) = 0 then return; end if;
  -- a delivery of a product that was not counted yet starts its count (like adjust_stock)
  if p_reason = 'receive' then
    update public.catalog_items set track_stock = true where id = p_item and business_id = p_business and not track_stock;
  end if;
  update public.catalog_items set stock_qty = stock_qty + p_delta
   where id = p_item and business_id = p_business and track_stock
   returning stock_qty into q;
  if not found then return; end if;
  insert into public.stock_movements (user_id, business_id, item_id, delta, qty_after, reason, note, document_id, expense_id)
  values (auth.uid(), p_business, p_item, p_delta, q, p_reason, left(coalesce(p_note, ''), 200), p_document, p_expense);
end $$;
revoke execute on function public.stock_move_ref(uuid, uuid, int, text, text, uuid, uuid) from public, anon, authenticated;

-- ============================================================================================================
-- documents: checked on the way in, followed by the ledger, the draft, the quote, the stock and the audit log
-- ============================================================================================================
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
    raise exception 'only a credit invoice points to a base document' using errcode = '23514';
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
-- "c_": after a_fill_business_id, before documents_number (numbering) — a refused document never takes a number
create or replace trigger c_documents_validate before insert on public.documents for each row execute function public.documents_validate();

create or replace function public.documents_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare p jsonb; m text; l record; rest jsonb;
begin
  -- 1. the ledger: one row per payment of a receipt
  if new.doc_type in (320, 400) then
    for p in select value from jsonb_array_elements(new.payments) loop
      m := coalesce(nullif(p->>'m', ''), case p->>'method' when '1' then 'cash' when '2' then 'cheque' when '3' then 'card' when '4' then 'transfer' else 'other' end);
      if m not in ('cash', 'card', 'transfer', 'bit', 'cheque', 'other') then m := 'other'; end if;
      insert into public.payments (business_id, user_id, direction, amount, method, paid_on, source, document_id, applies_to, sale_id, lead_id, reference)
      values (new.business_id, new.user_id, 'in', (p->>'amount')::numeric, m, coalesce(nullif(p->>'date', '')::date, new.doc_date), 'document',
              new.id, new.paid_document_id, new.sale_id, new.lead_id,
              case when jsonb_typeof(p->'cheque') = 'object' then p->'cheque' else '{}'::jsonb end);
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
  -- 3. stock: products sold on a direct document go out (the register's sales move stock on their own);
  --    a direct credit invoice brings back the lines marked "restock"
  if new.sale_id is null and new.refund_id is null then
    if new.doc_type in (305, 320, 400) and new.paid_document_id is null then
      for l in select * from public.stock_lines(new.lines) loop
        perform public.stock_move_ref(new.business_id, l.item_id, -l.qty, 'sale', format('%s-%s', new.doc_type, new.doc_number), new.id, null);
      end loop;
    elsif new.doc_type = 320 and new.paid_document_id is not null then
      -- a 320 paying a transaction invoice (300): the 300 moved nothing, the 320 does
      for l in select * from public.stock_lines(new.lines) loop
        perform public.stock_move_ref(new.business_id, l.item_id, -l.qty, 'sale', format('%s-%s', new.doc_type, new.doc_number), new.id, null);
      end loop;
    elsif new.doc_type = 330 then
      select coalesce(jsonb_agg(e), '[]'::jsonb) into rest from jsonb_array_elements(new.lines) e where (e->>'restock') = 'true';
      for l in select * from public.stock_lines(rest) loop
        perform public.stock_move_ref(new.business_id, l.item_id, l.qty, 'refund', format('%s-%s', new.doc_type, new.doc_number), new.id, null);
      end loop;
    end if;
  end if;
  -- 4. the audit log
  perform public.finance_log(new.business_id, 'document.issued', 'documents', new.id::text,
    jsonb_build_object('type', new.doc_type, 'number', new.doc_number, 'total', new.total, 'date', new.doc_date, 'source', new.source));
  return null;
end $$;
revoke execute on function public.documents_after_insert() from public, anon, authenticated;
create or replace trigger documents_after_insert after insert on public.documents for each row execute function public.documents_after_insert();

create or replace function public.documents_after_print() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.print_count > old.print_count then
    perform public.finance_log(new.business_id, 'document.printed', 'documents', new.id::text,
      jsonb_build_object('type', new.doc_type, 'number', new.doc_number, 'copy', new.print_count));
  end if;
  return null;
end $$;
revoke execute on function public.documents_after_print() from public, anon, authenticated;
create or replace trigger documents_after_print after update of print_count on public.documents for each row execute function public.documents_after_print();

-- ---- drafts: editable and removable while open; issued only by issuing their document ----------------------------
create or replace function public.document_drafts_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'open' then raise exception 'an issued draft stays (it points to its document)' using errcode = '23514'; end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and old.status <> 'open' then raise exception 'the draft was already issued' using errcode = '23514'; end if;
  -- pg_trigger_depth() = 1: a statement of the app itself (the issuing trigger runs one level deeper)
  if pg_trigger_depth() = 1 then
    if tg_op = 'INSERT' and (new.status <> 'open' or new.document_id is not null) then
      raise exception 'a draft is issued only by issuing its document' using errcode = '42501'; end if;
    if tg_op = 'UPDATE' and (new.status <> old.status or new.document_id is distinct from old.document_id or new.business_id <> old.business_id) then
      raise exception 'a draft is issued only by issuing its document' using errcode = '42501'; end if;
  end if;
  new.updated_at := now();
  if tg_op = 'INSERT' then new.created_at := now(); end if;
  return new;
end $$;
revoke execute on function public.document_drafts_guard() from public, anon, authenticated;
create or replace trigger b_document_drafts_guard before insert or update or delete on public.document_drafts for each row execute function public.document_drafts_guard();

create or replace function public.document_drafts_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if pg_trigger_depth() > 1 then return null; end if;   -- issuing is logged as document.issued
  perform public.finance_log(coalesce(new.business_id, old.business_id),
    case tg_op when 'INSERT' then 'draft.created' when 'UPDATE' then 'draft.updated' else 'draft.deleted' end,
    'document_drafts', coalesce(new.id, old.id)::text,
    jsonb_build_object('type', coalesce(new.doc_type, old.doc_type), 'total', coalesce(new.total, old.total)));
  return null;
end $$;
revoke execute on function public.document_drafts_audit() from public, anon, authenticated;
create or replace trigger document_drafts_audit after insert or update or delete on public.document_drafts for each row execute function public.document_drafts_audit();

-- ---- cancellations: a 300 / 400 issued by mistake (never a tax invoice); a paid 300 is not cancelled ---------------
create or replace function public.document_cancellations_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare d record; lock_end date;
begin
  select id, business_id, doc_type, doc_date into d from public.documents where id = new.document_id for update;
  if not found or d.business_id is distinct from new.business_id then
    raise exception 'the document was not found in this business' using errcode = '42501'; end if;
  if d.doc_type not in (300, 400) then
    raise exception 'cancel_not_allowed: a tax invoice is corrected by a credit invoice (330)' using errcode = '23514'; end if;
  lock_end := public.finance_locked_until(d.business_id);
  if lock_end is not null and d.doc_date <= lock_end then
    raise exception 'period_locked: the books are closed until %', lock_end using errcode = '23514'; end if;
  if d.doc_type = 300 and exists (select 1 from public.documents p where p.paid_document_id = d.id
                                    and not exists (select 1 from public.document_cancellations c where c.document_id = p.id)) then
    raise exception 'a paid transaction invoice is not cancelled (cancel its receipt first)' using errcode = '23514'; end if;
  new.created_at := now();
  return new;
end $$;
revoke execute on function public.document_cancellations_check() from public, anon, authenticated;
create or replace trigger b_document_cancellations_check before insert on public.document_cancellations for each row execute function public.document_cancellations_check();

create or replace function public.document_cancellations_after() returns trigger
language plpgsql security definer set search_path = public as $$
declare d record;
begin
  select doc_type, doc_number into d from public.documents where id = new.document_id;
  -- money of a cancelled receipt goes back off the books (a reversing row; the original row stays)
  insert into public.payments (business_id, user_id, direction, amount, method, paid_on, source, document_id, applies_to, sale_id, lead_id, note)
  select p.business_id, auth.uid(), 'out', p.amount, p.method, public.il_today(), 'cancel', p.document_id, p.applies_to, p.sale_id, p.lead_id, left(new.reason, 300)
    from public.payments p where p.document_id = new.document_id and p.direction = 'in' and p.source = 'document';
  perform public.finance_log(new.business_id, 'document.cancelled', 'documents', new.document_id::text,
    jsonb_build_object('type', d.doc_type, 'number', d.doc_number, 'reason', new.reason));
  return null;
end $$;
revoke execute on function public.document_cancellations_after() from public, anon, authenticated;
create or replace trigger document_cancellations_after after insert on public.document_cancellations for each row execute function public.document_cancellations_after();

-- ---- the ledger is written by the database only, and never changes ----------------------------------------------------
create or replace function public.finance_append_only() returns trigger
language plpgsql set search_path = public as $$
begin
  raise exception '% is append-only (record a reversing entry instead)', tg_table_name using errcode = '42501';
end $$;
revoke execute on function public.finance_append_only() from public, anon, authenticated;
create or replace trigger payments_append_only before update or delete on public.payments for each row execute function public.finance_append_only();
create or replace trigger finance_audit_log_append_only before update or delete on public.finance_audit_log for each row execute function public.finance_append_only();
create or replace trigger tax_allocations_append_only before update or delete on public.tax_allocations for each row execute function public.finance_append_only();
create or replace trigger finance_period_locks_append_only before update or delete on public.finance_period_locks for each row execute function public.finance_append_only();
create or replace trigger document_cancellations_append_only before update or delete on public.document_cancellations for each row execute function public.finance_append_only();

create or replace function public.payments_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.finance_log(new.business_id, case new.direction when 'in' then 'payment.in' else 'payment.out' end, 'payments', new.id::text,
    jsonb_build_object('amount', new.amount, 'method', new.method, 'source', new.source, 'on', new.paid_on));
  return null;
end $$;
revoke execute on function public.payments_audit() from public, anon, authenticated;
create or replace trigger payments_audit after insert on public.payments for each row execute function public.payments_audit();

-- a register refund (3000) is money out
create or replace function public.sale_refunds_ledger() returns trigger
language plpgsql security definer set search_path = public as $$
declare lead uuid;
begin
  select s.lead_id into lead from public.sales s where s.id = new.sale_id;
  insert into public.payments (business_id, user_id, direction, amount, method, paid_on, source, refund_id, sale_id, lead_id, note)
  values (new.business_id, new.user_id, 'out', new.amount, new.method, (new.created_at at time zone 'Asia/Jerusalem')::date, 'refund',
          new.id, new.sale_id, lead, left(new.reason, 300));
  perform public.finance_log(new.business_id, 'refund.recorded', 'sale_refunds', new.id::text,
    jsonb_build_object('amount', new.amount, 'method', new.method, 'sale', new.sale_id));
  return null;
end $$;
revoke execute on function public.sale_refunds_ledger() from public, anon, authenticated;
create or replace trigger sale_refunds_ledger after insert on public.sale_refunds for each row execute function public.sale_refunds_ledger();

-- a cancelled register sale is a money event too
create or replace function public.sales_audit_cancel() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'cancelled' and old.status <> 'cancelled' then
    perform public.finance_log(new.business_id, 'sale.cancelled', 'sales', new.id::text, jsonb_build_object('total', new.total, 'was', old.status));
  end if;
  return null;
end $$;
revoke execute on function public.sales_audit_cancel() from public, anon, authenticated;
create or replace trigger sales_audit_cancel after update of status on public.sales for each row execute function public.sales_audit_cancel();

-- changes of the business's legal details are logged (which fields — not the values of bank accounts)
create or replace function public.register_settings_audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare changed text[];
begin
  changed := array_remove(array[
    case when new.business_type is distinct from old.business_type then 'business_type' end,
    case when new.entity_type is distinct from old.entity_type then 'entity_type' end,
    case when new.vat_rate is distinct from old.vat_rate then 'vat_rate' end,
    case when new.dealer_number is distinct from old.dealer_number then 'dealer_number' end,
    case when new.company_number is distinct from old.company_number then 'company_number' end,
    case when new.legal_name is distinct from old.legal_name then 'legal_name' end,
    case when (new.street, new.house_no, new.city, new.zip) is distinct from (old.street, old.house_no, old.city, old.zip) then 'address' end], null);
  if cardinality(changed) > 0 then
    perform public.finance_log(new.business_id, 'settings.business', 'register_settings', new.business_id::text,
      jsonb_build_object('fields', to_jsonb(changed), 'vatRate', new.vat_rate, 'entity', public.entity_of(new.entity_type, new.business_type)));
  end if;
  return null;
end $$;
revoke execute on function public.register_settings_audit() from public, anon, authenticated;
create or replace trigger register_settings_audit after update on public.register_settings for each row execute function public.register_settings_audit();

create or replace function public.business_finance_profile_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.finance_log(new.business_id, 'settings.finance_profile', 'business_finance_profile', new.business_id::text,
    jsonb_build_object('bankChanged', tg_op = 'INSERT' or (new.bank_name, new.bank_branch, new.bank_account) is distinct from (old.bank_name, old.bank_branch, old.bank_account),
                       'terms', new.payment_terms));
  return null;
end $$;
revoke execute on function public.business_finance_profile_audit() from public, anon, authenticated;
create or replace trigger business_finance_profile_audit after insert or update on public.business_finance_profile for each row execute function public.business_finance_profile_audit();

-- ---- quotes: numbered, statuses move forward only, a decided quote keeps its content -------------------------------------
create or replace function public.quotes_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare ok boolean;
begin
  if tg_op = 'INSERT' then
    if new.status not in ('draft', 'sent') then raise exception 'a new quote is a draft or sent' using errcode = '23514'; end if;
    new.quote_number := public.finance_next_number(new.business_id, 'quote');
    new.issuer := public.issuer_snapshot(new.business_id);
    new.created_at := now(); new.updated_at := now();
    new.decided_at := null; new.decision_by := ''; new.decision_note := ''; new.converted_document_id := null;
    new.sent_at := case when new.status = 'sent' then now() end;
    return new;
  end if;
  if new.quote_number <> old.quote_number or new.business_id <> old.business_id or new.share_token <> old.share_token
     or new.created_at <> old.created_at or new.issuer is distinct from old.issuer then
    raise exception 'a quote keeps its number, business and link' using errcode = '23514'; end if;
  -- the document it became is set by issuing that document, never by hand
  if pg_trigger_depth() = 1 and new.converted_document_id is distinct from old.converted_document_id then
    raise exception 'a quote is converted by issuing its document' using errcode = '42501'; end if;
  if new.status <> old.status then
    ok := case old.status
      when 'draft'    then new.status in ('sent', 'cancelled', 'converted')
      when 'sent'     then new.status in ('draft', 'accepted', 'rejected', 'expired', 'cancelled', 'converted')
      when 'accepted' then new.status in ('converted', 'cancelled')
      when 'expired'  then new.status in ('sent', 'cancelled')
      else false end;
    if not ok then raise exception 'quote_status: % → % is not allowed', old.status, new.status using errcode = '23514'; end if;
    if new.status = 'converted' and new.converted_document_id is null then
      raise exception 'a quote is converted by issuing its document' using errcode = '23514'; end if;
    if new.status = 'sent' then new.sent_at := now(); end if;
    if new.status in ('accepted', 'rejected') then new.decided_at := now(); end if;
  end if;
  if old.status not in ('draft', 'sent', 'expired') and (new.customer_name, new.customer_phone, new.customer_email, new.customer_dealer, new.customer_street,
       new.customer_city, new.lead_id, new.body, new.before_discount, new.discount, new.after_discount, new.vat_rate, new.vat_amount, new.total,
       new.valid_until, new.notes) is distinct from (old.customer_name, old.customer_phone, old.customer_email, old.customer_dealer, old.customer_street,
       old.customer_city, old.lead_id, old.body, old.before_discount, old.discount, old.after_discount, old.vat_rate, old.vat_amount, old.total,
       old.valid_until, old.notes) then
    raise exception 'a decided quote does not change (make a new one)' using errcode = '23514'; end if;
  new.updated_at := now();
  return new;
end $$;
revoke execute on function public.quotes_guard() from public, anon, authenticated;
create or replace trigger b_quotes_guard before insert or update on public.quotes for each row execute function public.quotes_guard();

create or replace function public.quotes_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public.finance_log(new.business_id, 'quote.created', 'quotes', new.id::text, jsonb_build_object('number', new.quote_number, 'total', new.total));
  elsif new.status <> old.status then
    perform public.finance_log(new.business_id, 'quote.status', 'quotes', new.id::text,
      jsonb_build_object('number', new.quote_number, 'from', old.status, 'to', new.status, 'by', nullif(new.decision_by, '')));
  elsif pg_trigger_depth() = 1 then
    perform public.finance_log(new.business_id, 'quote.updated', 'quotes', new.id::text, jsonb_build_object('number', new.quote_number, 'total', new.total));
  end if;
  return null;
end $$;
revoke execute on function public.quotes_audit() from public, anon, authenticated;
create or replace trigger quotes_audit after insert or update on public.quotes for each row execute function public.quotes_audit();

-- ---- expenses: numbered, never deleted, closed books stay closed, a paid expense keeps its amounts ---------------------------
create or replace function public.expenses_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare lock_end date := public.finance_locked_until(new.business_id);
begin
  if new.doc_date > public.il_today() then raise exception 'an expense can not be dated in the future' using errcode = '23514'; end if;
  if tg_op = 'INSERT' then
    if new.status = 'void' then raise exception 'a new expense is not void' using errcode = '23514'; end if;
    if lock_end is not null and new.doc_date <= lock_end then
      raise exception 'period_locked: the books are closed until %', lock_end using errcode = '23514'; end if;
    new.expense_number := public.finance_next_number(new.business_id, 'expense');
    new.created_at := now(); new.updated_at := now(); new.voided_at := null; new.void_reason := '';
    if new.status = 'confirmed' then new.confirmed_by := auth.uid(); new.confirmed_at := now();
    else new.confirmed_by := null; new.confirmed_at := null; end if;
    return new;
  end if;
  if old.status = 'void' then raise exception 'a void expense does not change' using errcode = '23514'; end if;
  if new.expense_number <> old.expense_number or new.business_id <> old.business_id or new.created_at <> old.created_at
     or new.user_id is distinct from old.user_id or new.ai_extracted is distinct from old.ai_extracted then
    raise exception 'an expense keeps its number, business, author and what the AI read' using errcode = '23514'; end if;
  if lock_end is not null and (old.doc_date <= lock_end or new.doc_date <= lock_end) then
    raise exception 'period_locked: the books are closed until %', lock_end using errcode = '23514'; end if;
  if old.status = 'confirmed' and new.status = 'draft' then
    raise exception 'a confirmed expense does not go back to draft (void it)' using errcode = '23514'; end if;
  if old.paid_on is not null and (new.amount_before_vat, new.vat_amount, new.total, new.vat_deductible_pct, new.doc_date, new.paid_on,
       new.payment_method, new.supplier_doc_type) is distinct from (old.amount_before_vat, old.vat_amount, old.total, old.vat_deductible_pct,
       old.doc_date, old.paid_on, old.payment_method, old.supplier_doc_type) then
    raise exception 'a paid expense keeps its amounts (void it and record it again)' using errcode = '23514'; end if;
  if new.status = 'confirmed' and old.status = 'draft' then new.confirmed_by := auth.uid(); new.confirmed_at := now();
  else new.confirmed_by := old.confirmed_by; new.confirmed_at := old.confirmed_at; end if;
  if new.status = 'void' then new.voided_at := now(); else new.voided_at := null; end if;
  new.updated_at := now();
  return new;
end $$;
revoke execute on function public.expenses_guard() from public, anon, authenticated;
create or replace trigger b_expenses_guard before insert or update on public.expenses for each row execute function public.expenses_guard();
create or replace trigger expenses_no_delete before delete on public.expenses for each row execute function public.finance_append_only();

create or replace function public.expenses_after() returns trigger
language plpgsql security definer set search_path = public as $$
declare l record; credit boolean := new.supplier_doc_type = 'credit';
begin
  -- money out (a supplier's credit note: money back in) once the expense is confirmed and paid
  if new.status = 'confirmed' and new.paid_on is not null
     and (tg_op = 'INSERT' or old.status <> 'confirmed' or old.paid_on is null) then
    insert into public.payments (business_id, user_id, direction, amount, method, paid_on, source, expense_id, note)
    values (new.business_id, auth.uid(), case when credit then 'in' else 'out' end, new.total, new.payment_method, new.paid_on, 'expense', new.id,
            left(new.supplier_name, 300));
  end if;
  if tg_op = 'UPDATE' and new.status = 'void' and old.status <> 'void' then
    -- what moved for it moves back: money (a reversing row) and stock
    insert into public.payments (business_id, user_id, direction, amount, method, paid_on, source, expense_id, note)
    select p.business_id, auth.uid(), case p.direction when 'in' then 'out' else 'in' end, p.amount, p.method, public.il_today(), 'reversal', p.expense_id,
           left('ביטול: ' || new.void_reason, 300)
      from public.payments p where p.expense_id = new.id and p.source = 'expense';
    for l in select m.item_id, sum(m.delta)::int as qty from public.stock_movements m where m.expense_id = new.id group by m.item_id having sum(m.delta) <> 0 loop
      perform public.stock_move_ref(new.business_id, l.item_id, -l.qty, 'adjust', format('ביטול הוצאה %s', new.expense_number), null, new.id);
    end loop;
  end if;
  perform public.finance_log(new.business_id,
    case when tg_op = 'INSERT' then 'expense.created'
         when new.status = 'void' and old.status <> 'void' then 'expense.voided'
         when new.status = 'confirmed' and old.status = 'draft' then 'expense.confirmed'
         when new.paid_on is not null and old.paid_on is null then 'expense.paid'
         else 'expense.updated' end,
    'expenses', new.id::text, jsonb_build_object('number', new.expense_number, 'total', new.total, 'status', new.status, 'date', new.doc_date));
  return null;
end $$;
revoke execute on function public.expenses_after() from public, anon, authenticated;
create or replace trigger expenses_after after insert or update on public.expenses for each row execute function public.expenses_after();

-- the rest of the audit triggers
create or replace function public.tax_allocations_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.finance_log(new.business_id, 'allocation.' || new.status, 'documents', new.document_id::text,
    jsonb_build_object('gateway', new.gateway, 'test', new.is_test, 'rule', new.rule_version, 'error', nullif(new.error_code, '')));
  return null;
end $$;
revoke execute on function public.tax_allocations_audit() from public, anon, authenticated;
create or replace trigger tax_allocations_audit after insert on public.tax_allocations for each row execute function public.tax_allocations_audit();

create or replace function public.finance_period_locks_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.finance_log(new.business_id, 'period.locked', 'finance_period_locks', new.id::text, jsonb_build_object('until', new.period_end));
  return null;
end $$;
revoke execute on function public.finance_period_locks_audit() from public, anon, authenticated;
create or replace trigger finance_period_locks_audit after insert on public.finance_period_locks for each row execute function public.finance_period_locks_audit();

-- grants change only by the two functions below (opening is an insert, closing sets revoked_at)
create or replace function public.finance_access_grants_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' or new.business_id <> old.business_id or new.user_id <> old.user_id or new.reason <> old.reason
     or new.granted_at <> old.granted_at or new.expires_at <> old.expires_at or (old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at) then
    raise exception 'an access grant is only closed, never changed' using errcode = '42501';
  end if;
  return new;
end $$;
revoke execute on function public.finance_access_grants_guard() from public, anon, authenticated;
create or replace trigger finance_access_grants_guard before update or delete on public.finance_access_grants for each row execute function public.finance_access_grants_guard();

-- ============================================================================================================
-- row-level security
-- ============================================================================================================
do $$
declare
  t text; op text;
  gate        constant text := 'business_id = (select public.current_business_id()) and business_id in (select public.accessible_business_ids())';
  fin         constant text := 'business_id in (select public.finance_business_ids())';
  full_access constant text := '(select public.my_access()) <> ''register''';
  -- the commands members may use on each new table (reading is always allowed; the rest is written by the database)
  cmds constant jsonb := '{
    "business_finance_profile": ["insert", "update"],
    "document_drafts": ["insert", "update", "delete"],
    "document_cancellations": ["insert"],
    "payments": [], "quotes": ["insert", "update"], "expenses": ["insert", "update"],
    "tax_allocations": [], "finance_audit_log": [], "finance_period_locks": []}';
begin
  for t in select jsonb_object_keys(cmds) loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate on public.%I from authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    -- restrictive: the business worked in now, its money open to the caller, never the cashier
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
    for op in select jsonb_array_elements_text(cmds -> t) loop
      execute format('grant %s on public.%I to authenticated', op, t);
      if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_business_' || op) then
        execute format('create policy %I on public.%I for %s to authenticated %s', t || '_business_' || op, t, op,
          case op when 'insert' then format('with check (%s and user_id = auth.uid())', gate)
                  when 'update' then format('using (%s) with check (%s)', gate, gate)
                  else format('using (%s)', gate) end);
      end if;
    end loop;
  end loop;

  -- the money of the register and the documents: the same privacy rule (a super admin opens access first)
  foreach t in array array['documents', 'document_counters', 'sales', 'sale_refunds', 'register_shifts'] loop
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_finance_privacy') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)', t || '_finance_privacy', t, fin, fin);
    end if;
  end loop;
end $$;

-- server-only tables: no client access at all (the server uses the service role)
alter table public.finance_counters          enable row level security;
alter table public.tax_authority_connections enable row level security;
revoke all on public.finance_counters, public.tax_authority_connections from anon, authenticated;

-- the rules are the same for everyone: read-only
alter table public.tax_allocation_rules enable row level security;
revoke all on public.tax_allocation_rules from anon;
revoke insert, update, delete, truncate on public.tax_allocation_rules from authenticated;
grant select on public.tax_allocation_rules to authenticated;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'tax_allocation_rules' and policyname = 'tax_allocation_rules_read') then
    create policy tax_allocation_rules_read on public.tax_allocation_rules for select to authenticated using (true);
  end if;
end $$;

-- grants: the super admin sees their own; the business's full-access members see who opened their books
alter table public.finance_access_grants enable row level security;
revoke all on public.finance_access_grants from anon;
revoke insert, update, delete, truncate on public.finance_access_grants from authenticated;
grant select on public.finance_access_grants to authenticated;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'finance_access_grants' and policyname = 'finance_access_grants_read') then
    create policy finance_access_grants_read on public.finance_access_grants for select to authenticated
      using (user_id = auth.uid() or business_id in (select m.business_id from public.business_members m where m.user_id = auth.uid() and m.access = 'full'));
  end if;
end $$;

-- ---- the private bucket of expense files: <business_id>/<file>; read and upload only, never replaced or removed ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('finance-files', 'finance-files', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'])
on conflict (id) do nothing;
do $$
declare
  rule constant text := 'bucket_id = ''finance-files'' and (storage.foldername(name))[1] = (select public.current_business_id())::text'
    || ' and (select public.current_business_id()) in (select public.accessible_business_ids())'
    || ' and (select public.current_business_id()) in (select public.finance_business_ids())'
    || ' and (select public.my_access()) <> ''register''';
begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'finance_files_read') then
    execute format('create policy finance_files_read on storage.objects for select to authenticated using (%s)', rule);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'finance_files_insert') then
    execute format('create policy finance_files_insert on storage.objects for insert to authenticated with check (%s)', rule);
  end if;
end $$;

-- ============================================================================================================
-- functions the app calls
-- ============================================================================================================

-- where the caller stands in the business they work in: member / super admin, and whether its money is open to them
create or replace function public.finance_access_state() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'business', b, 'superAdmin', public.is_super_admin(), 'access', public.my_access(),
    'member', exists (select 1 from public.business_members m where m.business_id = b and m.user_id = auth.uid()),
    'open', b in (select public.finance_business_ids()),
    'grantUntil', (select max(g.expires_at) from public.finance_access_grants g
                    where g.business_id = b and g.user_id = auth.uid() and g.revoked_at is null and g.expires_at > now()),
    'lockedUntil', public.finance_locked_until(b))
  from (select public.current_business_id() as b) x;
$$;

-- a super admin opens a business's money for a limited time, with a reason; the business sees it in its audit log
create or replace function public.open_finance_access(p_business uuid, p_reason text, p_minutes int default 60) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare until timestamptz;
begin
  if not public.is_super_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_business is null or not exists (select 1 from public.businesses where id = p_business) then raise exception 'business not found' using errcode = '22023'; end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'a reason is required (5 characters or more)' using errcode = '22023'; end if;
  if p_minutes is null or p_minutes < 5 or p_minutes > 480 then raise exception 'between 5 minutes and 8 hours' using errcode = '22023'; end if;
  until := now() + make_interval(mins => p_minutes);
  insert into public.finance_access_grants (business_id, user_id, reason, granted_at, expires_at) values (p_business, auth.uid(), trim(p_reason), now(), until);
  perform public.finance_log(p_business, 'support.access_opened', 'finance_access_grants', auth.uid()::text,
    jsonb_build_object('reason', trim(p_reason), 'until', until));
  return until;
end $$;

create or replace function public.close_finance_access(p_business uuid) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.finance_access_grants set revoked_at = now()
   where business_id = p_business and user_id = auth.uid() and revoked_at is null and expires_at > now();
  get diagnostics n = row_count;
  if n > 0 then perform public.finance_log(p_business, 'support.access_closed', 'finance_access_grants', auth.uid()::text, '{}'); end if;
  return n;
end $$;

-- close the books up to a day that has passed (members with full access only; nothing reopens them from the app)
create or replace function public.lock_finance_period(p_end date, p_note text default '') returns date
language plpgsql security definer set search_path = public as $$
declare b uuid := public.finance_guard(); cur date;
begin
  if not exists (select 1 from public.business_members m where m.business_id = b and m.user_id = auth.uid() and m.access = 'full') then
    raise exception 'only the business closes its books' using errcode = '42501'; end if;
  if p_end is null or p_end >= public.il_today() then raise exception 'a period that has ended (before today)' using errcode = '22023'; end if;
  cur := public.finance_locked_until(b);
  if cur is not null and p_end <= cur then raise exception 'the books are already closed until %', cur using errcode = '22023'; end if;
  insert into public.finance_period_locks (business_id, user_id, period_end, note) values (b, auth.uid(), p_end, left(coalesce(p_note, ''), 300));
  return p_end;
end $$;

-- money paid back on a credit invoice issued outside the register (the register's refunds record themselves)
create or replace function public.record_credit_refund(p_document uuid, p_method text, p_amount numeric, p_paid_on date default null, p_note text default '')
returns uuid language plpgsql security definer set search_path = public as $$
declare b uuid := public.finance_guard(); d record; base_id uuid; done numeric; day date := coalesce(p_paid_on, public.il_today()); lock_end date; new_id uuid;
begin
  select x.id, x.business_id, x.doc_type, x.total, x.base_doc_type, x.base_doc_number, x.lead_id, x.sale_id, x.refund_id
    into d from public.documents x where x.id = p_document for update;
  if not found or d.business_id <> b or d.doc_type <> 330 then raise exception 'a refund is recorded on a credit invoice of this business' using errcode = '23514'; end if;
  if d.refund_id is not null then raise exception 'this credit invoice belongs to a register refund (already recorded)' using errcode = '23514'; end if;
  if p_method is null or p_method not in ('cash', 'card', 'transfer', 'bit', 'cheque', 'other') then raise exception 'unknown payment method' using errcode = '22023'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'an amount above zero' using errcode = '22023'; end if;
  if day > public.il_today() then raise exception 'not in the future' using errcode = '22023'; end if;
  lock_end := public.finance_locked_until(b);
  if lock_end is not null and day <= lock_end then raise exception 'period_locked: the books are closed until %', lock_end using errcode = '23514'; end if;
  select coalesce(sum(p.amount), 0) into done from public.payments p where p.document_id = d.id and p.source = 'credit';
  if done + p_amount > d.total then raise exception 'more than the credit invoice (% left)', d.total - done using errcode = '23514'; end if;
  select x.id into base_id from public.documents x where x.business_id = b and x.doc_type = d.base_doc_type and x.doc_number = d.base_doc_number;
  insert into public.payments (business_id, user_id, direction, amount, method, paid_on, source, document_id, applies_to, sale_id, lead_id, note)
  values (b, auth.uid(), 'out', round(p_amount, 2), p_method, day, 'credit', d.id, base_id, d.sale_id, d.lead_id, left(coalesce(p_note, ''), 300))
  returning payments.id into new_id;
  return new_id;
end $$;

-- an allocation number received from the Tax Authority outside the app (marked "entered by hand" everywhere)
create or replace function public.record_manual_allocation(p_document uuid, p_number text) returns uuid
language plpgsql security definer set search_path = public as $$
declare b uuid := public.finance_guard(); d record; new_id uuid;
begin
  if coalesce(p_number, '') !~ '^[0-9]{6,20}$' then raise exception 'an allocation number is digits only' using errcode = '22023'; end if;
  select x.id, x.business_id, x.doc_type into d from public.documents x where x.id = p_document;
  if not found or d.business_id <> b then raise exception 'not allowed' using errcode = '42501'; end if;
  if d.doc_type not in (305, 320, 330) then raise exception 'allocation numbers are for tax invoices' using errcode = '23514'; end if;
  if exists (select 1 from public.tax_allocations a where a.document_id = d.id and a.status in ('approved', 'manual') and not a.is_test) then
    raise exception 'the document already has an allocation number' using errcode = '23505'; end if;
  insert into public.tax_allocations (business_id, document_id, user_id, status, is_test, allocation_number, gateway)
  values (b, d.id, auth.uid(), 'manual', false, p_number, 'manual') returning tax_allocations.id into new_id;
  return new_id;
end $$;

-- products bought with a confirmed expense come into stock — once (the same log as sales and deliveries)
create or replace function public.receive_expense_stock(p_expense uuid) returns int
language plpgsql security definer set search_path = public as $$
declare b uuid := public.finance_guard(); e record; l record; n int := 0;
begin
  select * into e from public.expenses where id = p_expense for update;
  if not found or e.business_id <> b then raise exception 'not allowed' using errcode = '42501'; end if;
  if e.status <> 'confirmed' then raise exception 'only a confirmed expense brings stock in' using errcode = '23514'; end if;
  if exists (select 1 from public.stock_movements m where m.expense_id = e.id and m.reason = 'receive') then return 0; end if;
  for l in select * from public.stock_lines(e.stock_lines) loop
    if exists (select 1 from public.catalog_items c where c.id = l.item_id and c.business_id = b) then
      perform public.stock_move_ref(b, l.item_id, l.qty, 'receive', format('הוצאה %s · %s', e.expense_number, e.supplier_name), null, e.id);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- events that happen in the browser (an export, a reminder sent) — written to the audit log, nothing else
create or replace function public.log_finance_event(p_action text, p_entity text default '', p_entity_id text default '', p_details jsonb default '{}')
returns void language plpgsql security definer set search_path = public as $$
declare b uuid := public.finance_guard();
begin
  if p_action not in ('export.open_format', 'export.csv', 'export.package', 'reminder.sent', 'document.sent', 'quote.sent', 'report.printed') then
    raise exception 'unknown event' using errcode = '22023'; end if;
  if pg_column_size(coalesce(p_details, '{}'::jsonb)) > 4000 then raise exception 'details too large' using errcode = '22023'; end if;
  perform public.finance_log(b, p_action, left(coalesce(p_entity, ''), 60), left(coalesce(p_entity_id, ''), 80), coalesce(p_details, '{}'::jsonb));
end $$;

-- is the audit chain of the business intact? (recomputes every hash)
create or replace function public.finance_audit_verify() returns jsonb
language plpgsql stable set search_path = public as $$
declare b uuid := public.current_business_id(); r record; prev text := ''; n int := 0;
begin
  if (select public.my_access()) = 'register' then raise exception 'not allowed' using errcode = '42501'; end if;
  for r in select * from public.finance_audit_log where business_id = b order by id loop
    if r.prev_hash <> prev or r.hash <> public.finance_audit_hash(prev, r.business_id, r.action, r.entity, r.entity_id, r.details, r.at, r.actor_id, r.actor_kind) then
      return jsonb_build_object('ok', false, 'rows', n, 'firstBad', r.id);
    end if;
    prev := r.hash; n := n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'rows', n);
end $$;

-- ---- receivables: every invoice that asks for money (305 / 300) with what was credited and paid ----------------------------
create or replace view public.receivables with (security_invoker = true) as
select d.id, d.business_id, d.doc_type, d.doc_number, d.doc_date, d.due_date, d.customer_name, d.customer_phone, d.customer_email, d.lead_id,
       d.total, d.share_token,
       coalesce(cr.amount, 0)::numeric(14,2) as credited,
       coalesce(pa.amount, 0)::numeric(14,2) as paid,
       (d.total - coalesce(cr.amount, 0) - coalesce(pa.amount, 0))::numeric(14,2) as balance,
       (x.document_id is not null) as cancelled
  from public.documents d
  left join lateral (select sum(c.total) as amount from public.documents c
                      where c.business_id = d.business_id and c.doc_type = 330 and c.base_doc_type = d.doc_type and c.base_doc_number = d.doc_number) cr on true
  left join lateral (select sum(case p.direction when 'in' then p.amount else -p.amount end) as amount
                       from public.payments p where p.applies_to = d.id) pa on true
  left join public.document_cancellations x on x.document_id = d.id
 where d.doc_type in (300, 305) and (select public.my_access()) <> 'register';
revoke all on public.receivables from anon;
grant select on public.receivables to authenticated;

-- ---- the numbers of the money screens, from one place (RLS applies: security invoker) ----------------------------------
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
    select coalesce(sum(balance) filter (where balance > 0), 0) as open, count(*) filter (where balance > 0) as n,
           coalesce(sum(balance) filter (where balance > 0 and due_date < today), 0) as overdue, count(*) filter (where balance > 0 and due_date < today) as overdue_n
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

-- execute rights: internal functions are not callable from the API; the app's functions are for signed-in users
revoke execute on function public.finance_access_state(), public.open_finance_access(uuid, text, int), public.close_finance_access(uuid),
  public.lock_finance_period(date, text), public.record_credit_refund(uuid, text, numeric, date, text), public.record_manual_allocation(uuid, text),
  public.receive_expense_stock(uuid), public.log_finance_event(text, text, text, jsonb), public.finance_audit_verify(), public.finance_summary(date, date)
  from public, anon;
grant execute on function public.finance_access_state(), public.open_finance_access(uuid, text, int), public.close_finance_access(uuid),
  public.lock_finance_period(date, text), public.record_credit_refund(uuid, text, numeric, date, text), public.record_manual_allocation(uuid, text),
  public.receive_expense_stock(uuid), public.log_finance_event(text, text, text, jsonb), public.finance_audit_verify(), public.finance_summary(date, date)
  to authenticated;
revoke execute on function public.finance_audit_hash(text, uuid, text, text, text, jsonb, timestamptz, uuid, text) from public, anon;
