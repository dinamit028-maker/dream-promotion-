-- ============================================================================
-- Migration 20261003001400 — legal documents (toolbox stage 3c, part 1)
-- Built to "הוראות מס הכנסה (ניהול פנקסי חשבונות)" and the unified-file spec v1.31:
--   * documents are numbered consecutively per business and per document type, with no gaps
--     (a locked counter row inside the same transaction — a failed insert leaves no hole)
--   * an issued document can never be changed or deleted (trigger); corrections = credit invoice (330)
--   * the issue time is the server's (field 1205 "תאריך הפקת מסמך" — not editable by the user)
--   * every print is counted: the first is "מקור", later ones "העתק נאמן למקור"
-- register_settings gets the legal business details the documents and the unified file need.
-- Idempotent. Rollback: drop table documents, document_counters (+ the added columns).
-- ============================================================================
alter table public.register_settings add column if not exists dealer_number  text not null default '' check (dealer_number = '' or dealer_number ~ '^[0-9]{9}$');
alter table public.register_settings add column if not exists company_number text not null default '' check (company_number = '' or company_number ~ '^[0-9]{9}$');
alter table public.register_settings add column if not exists legal_name     text not null default '';
alter table public.register_settings add column if not exists street         text not null default '';
alter table public.register_settings add column if not exists house_no       text not null default '';
alter table public.register_settings add column if not exists city           text not null default '';
alter table public.register_settings add column if not exists zip            text not null default '';

create table if not exists public.document_counters (
  user_id  uuid not null references auth.users on delete cascade,
  doc_type int  not null,
  last_no  bigint not null default 0,
  primary key (user_id, doc_type)
);
alter table public.document_counters enable row level security;
drop policy if exists document_counters_read on public.document_counters;
create policy document_counters_read on public.document_counters for select using (user_id = auth.uid());

create table if not exists public.documents (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users on delete cascade,
  doc_type        int  not null check (doc_type in (300, 305, 320, 330, 400)),
  doc_number      bigint not null,
  link_no         bigint generated always as identity,          -- field 1234/1273/1323
  issued_at       timestamptz not null default now(),           -- field 1205/1206 (server time)
  doc_date        date not null,                                -- field 1230 (shown on the document)
  customer_name   text not null default '',
  customer_phone  text not null default '',
  customer_dealer text not null default '' check (customer_dealer = '' or customer_dealer ~ '^[0-9]{9}$'),
  customer_street text not null default '', customer_city text not null default '',
  lines           jsonb not null default '[]',   -- [{name, qty, unitPriceExVat, discountExVat, totalExVat, vatRate, kind}]
  payments        jsonb not null default '[]',   -- [{method:1..9, amount, date, ...}]
  before_discount numeric(14,2) not null,        -- 1219 (ex VAT)
  discount        numeric(14,2) not null default 0, -- 1220 (ex VAT, shown negative in the file)
  after_discount  numeric(14,2) not null,        -- 1221 (ex VAT)
  vat_amount      numeric(14,2) not null,        -- 1222
  total           numeric(14,2) not null,        -- 1223 (incl. VAT)
  vat_rate        numeric(5,2) not null,
  base_doc_type   int, base_doc_number bigint,   -- 1256/1257 (a credit invoice points to its original)
  sale_id         uuid references public.sales on delete set null,
  lead_id         uuid references public.leads on delete set null,
  issued_by       text not null default '',      -- 1233
  print_count     int not null default 0,
  unique (user_id, doc_type, doc_number)
);
create index if not exists documents_user_date_idx on public.documents (user_id, doc_date);

-- consecutive numbering without gaps + server time, whatever the client sends
create or replace function public.documents_before_insert() returns trigger language plpgsql security definer set search_path = public as $$
declare n bigint;
begin
  insert into public.document_counters(user_id, doc_type, last_no) values (new.user_id, new.doc_type, 0) on conflict do nothing;
  update public.document_counters set last_no = last_no + 1
    where user_id = new.user_id and doc_type = new.doc_type returning last_no into n;
  new.doc_number := n;
  new.issued_at := now();
  new.print_count := 0;
  return new;
end $$;
drop trigger if exists documents_number on public.documents;
create trigger documents_number before insert on public.documents for each row execute function public.documents_before_insert();

-- an issued document is final: only the print counter may move forward
create or replace function public.documents_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'issued documents cannot be deleted (issue a credit invoice instead)'; end if;
  if (to_jsonb(new) - 'print_count') <> (to_jsonb(old) - 'print_count') or new.print_count < old.print_count then
    raise exception 'issued documents cannot be changed (issue a credit invoice instead)';
  end if;
  return new;
end $$;
drop trigger if exists documents_lock on public.documents;
create trigger documents_lock before update or delete on public.documents for each row execute function public.documents_immutable();

alter table public.documents enable row level security;
drop policy if exists documents_read on public.documents;
create policy documents_read on public.documents for select using (user_id = auth.uid());
drop policy if exists documents_insert on public.documents;
create policy documents_insert on public.documents for insert with check (user_id = auth.uid());
drop policy if exists documents_print on public.documents;
create policy documents_print on public.documents for update using (user_id = auth.uid()) with check (user_id = auth.uid());
