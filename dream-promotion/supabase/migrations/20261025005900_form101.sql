-- 2.108.0 — טופס 101 (docs/FORM101_REQUIREMENTS_HE.md; tests/sql/form101.check.sql). Runs only after 5800 (attendance core).
-- The employee fills the official form of the tax year on the phone (a personal link), signs on the screen, and it is kept in the
-- employee's file — a new form every tax year, and a new version on every update during the year; nothing is ever deleted or
-- rewritten. The accountant reviews it and enters it in the payroll (the owner of the system, 24–25.10.2026).
--   form101_requests     a link sent to an employee (its token only as sha-256), for a tax year; sent → opened → submitted
--   form101_submissions  what the employee filled and signed: the answers, the signature, the PDF and the attachments (their paths
--                        in the private bucket form101-files and their sha-256), the server's time, IP and browser; version 1, 2, …
--                        per employee and year. Later only "the signed paper was received" and "reviewed" are added, once each.
-- Who sees: the attendance admin and payroll (the accountant) only — never an approver or a viewer (the task: "פרטי טופס 101 …
-- נגישים רק למנהל המורשה ולרואה החשבון"). The browser only reads; every write is the server's (/api/attendance/form101, /api/f101).
-- Additions only: no existing row changes.

do $$ begin
  if to_regprocedure('public.att_role()') is null or to_regclass('public.employee_private') is null then
    raise exception 'run migration 20261023005800 (attendance core) first';
  end if;
end $$;

-- the employer's part of the form (חלק א): the deductions file number and a phone; the name and address are the business's details
alter table public.timeclock_settings add column if not exists employer_deductions_file text not null default '';
alter table public.timeclock_settings add column if not exists employer_phone text not null default '';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'timeclock_settings_employer_check') then
    alter table public.timeclock_settings add constraint timeclock_settings_employer_check check (
      (employer_deductions_file = '' or employer_deductions_file ~ '^9[0-9]{8}$') and length(employer_phone) <= 20);
  end if;
end $$;

create table if not exists public.form101_requests (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses on delete restrict,
  employee_id  uuid not null,
  tax_year     int  not null check (tax_year between 2020 and 2100),
  kind         text not null default 'year' check (kind in ('year', 'update')),
  token_hash   text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  status       text not null default 'sent' check (status in ('sent', 'opened', 'submitted', 'cancelled', 'expired')),
  expires_at   timestamptz not null,
  sent_by      uuid references auth.users on delete set null,
  created_at   timestamptz not null default now(),
  opened_at    timestamptz,
  done_at      timestamptz,
  unique (id, business_id, employee_id),
  foreign key (employee_id, business_id) references public.employees (id, business_id)
);
create index if not exists form101_requests_employee_idx on public.form101_requests (business_id, employee_id, created_at desc);

create table if not exists public.form101_submissions (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references public.businesses on delete restrict,
  employee_id    uuid not null,
  request_id     uuid not null unique,               -- one submission per link: a second one is refused
  tax_year       int  not null check (tax_year between 2020 and 2100),
  version        int  not null check (version >= 1),
  form_code      text not null check (length(form_code) <= 40),   -- the official form it follows (0101/130 · 11.2025)
  data           jsonb not null,
  signer_name    text not null check (length(signer_name) between 2 and 200),
  signature_path text not null check (length(signature_path) <= 300),
  pdf_path       text not null check (length(pdf_path) <= 300),
  pdf_sha256     text not null check (pdf_sha256 ~ '^[0-9a-f]{64}$'),
  attachments    jsonb not null default '[]'::jsonb check (jsonb_typeof(attachments) = 'array'),
  ip             text check (ip is null or length(ip) <= 64),
  user_agent     text not null default '' check (length(user_agent) <= 1000),
  submitted_at   timestamptz not null default now(),
  -- added once each, by the server (the admin or payroll): the hand-signed paper (a scan in the bucket), and the accountant's review
  paper_path     text check (paper_path is null or length(paper_path) <= 300),
  paper_at       timestamptz,
  paper_by       uuid references auth.users on delete set null,
  reviewed_at    timestamptz,
  reviewed_by    uuid references auth.users on delete set null,
  review_note    text not null default '' check (length(review_note) <= 500),
  unique (business_id, employee_id, tax_year, version),
  foreign key (request_id, business_id, employee_id) references public.form101_requests (id, business_id, employee_id),
  foreign key (employee_id, business_id) references public.employees (id, business_id)
);
create index if not exists form101_submissions_employee_idx on public.form101_submissions (business_id, employee_id, tax_year desc, version desc);

-- the browser never writes here (invoker: an app user's write runs as 'authenticated' and is refused; the server is service_role)
create or replace function public.form101_server_only() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user in ('anon', 'authenticated') then
    raise exception 'form101: written by the server only' using errcode = '42501';
  end if;
  return new;
end $$;
revoke execute on function public.form101_server_only() from public, anon, authenticated;

-- a submission is never rewritten: only paper_* and reviewed_* / review_note may be added, once; its request becomes "submitted"
create or replace function public.form101_submission_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.paper_path is not null or new.reviewed_at is not null then
      raise exception 'form101: a new submission is not received or reviewed yet' using errcode = '23514';
    end if;
    if not exists (select 1 from public.form101_requests r where r.id = new.request_id and r.business_id = new.business_id
                    and r.employee_id = new.employee_id and r.tax_year = new.tax_year and r.status in ('sent', 'opened') and r.expires_at > now()) then
      raise exception 'form101: the link is no longer valid' using errcode = '23514';
    end if;
    new.submitted_at := now();
    new.version := coalesce((select max(s.version) from public.form101_submissions s
                              where s.business_id = new.business_id and s.employee_id = new.employee_id and s.tax_year = new.tax_year), 0) + 1;
    return new;
  end if;
  if (new.id, new.business_id, new.employee_id, new.request_id, new.tax_year, new.version, new.form_code, new.data, new.signer_name,
      new.signature_path, new.pdf_path, new.pdf_sha256, new.attachments, new.ip, new.user_agent, new.submitted_at)
     is distinct from (old.id, old.business_id, old.employee_id, old.request_id, old.tax_year, old.version, old.form_code, old.data, old.signer_name,
      old.signature_path, old.pdf_path, old.pdf_sha256, old.attachments, old.ip, old.user_agent, old.submitted_at) then
    raise exception 'form101: a signed form is never changed — send a new one' using errcode = '42501';
  end if;
  if old.paper_path is not null and (new.paper_path, new.paper_at, new.paper_by) is distinct from (old.paper_path, old.paper_at, old.paper_by) then
    raise exception 'form101: the signed paper was already received' using errcode = '23514';
  end if;
  if old.reviewed_at is not null and (new.reviewed_at, new.reviewed_by, new.review_note) is distinct from (old.reviewed_at, old.reviewed_by, old.review_note) then
    raise exception 'form101: already reviewed' using errcode = '23514';
  end if;
  if new.paper_path is not null and old.paper_path is null then new.paper_at := now(); end if;
  if new.reviewed_at is not null and old.reviewed_at is null then new.reviewed_at := now(); end if;
  return new;
end $$;
revoke execute on function public.form101_submission_guard() from public, anon, authenticated;

create or replace function public.form101_submitted() returns trigger
language plpgsql set search_path = public as $$
begin
  update public.form101_requests set status = 'submitted', done_at = now() where id = new.request_id and status in ('sent', 'opened');
  return new;
end $$;
revoke execute on function public.form101_submitted() from public, anon, authenticated;

-- a request: what it is for never changes; its status only moves forward (sent → opened → submitted / cancelled / expired)
create or replace function public.form101_request_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    if (new.id, new.business_id, new.employee_id, new.tax_year, new.kind, new.token_hash, new.expires_at, new.sent_by, new.created_at)
       is distinct from (old.id, old.business_id, old.employee_id, old.tax_year, old.kind, old.token_hash, old.expires_at, old.sent_by, old.created_at) then
      raise exception 'form101: a link is never changed — send a new one' using errcode = '42501';
    end if;
    if old.status in ('submitted', 'cancelled', 'expired') and new.status is distinct from old.status then
      raise exception 'form101: the link is closed' using errcode = '23514';
    end if;
    if new.status = 'opened' and old.status = 'sent' then new.opened_at := now(); end if;
    if new.status in ('cancelled', 'expired') and old.status in ('sent', 'opened') then new.done_at := now(); end if;
  end if;
  return new;
end $$;
revoke execute on function public.form101_request_guard() from public, anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['form101_requests', 'form101_submissions'] loop
    execute format('drop trigger if exists a_form101_server_only on public.%I', t);
    execute format('create trigger a_form101_server_only before insert or update on public.%I for each row execute function public.form101_server_only()', t);
    execute format('drop trigger if exists att_no_delete on public.%I', t);
    execute format('create trigger att_no_delete before delete on public.%I for each row execute function public.att_no_delete()', t);
  end loop;
end $$;
drop trigger if exists b_form101_request_guard on public.form101_requests;
create trigger b_form101_request_guard before update on public.form101_requests for each row execute function public.form101_request_guard();
drop trigger if exists b_form101_submission_guard on public.form101_submissions;
create trigger b_form101_submission_guard before insert or update on public.form101_submissions for each row execute function public.form101_submission_guard();
drop trigger if exists z_form101_submitted on public.form101_submissions;
create trigger z_form101_submitted after insert on public.form101_submissions for each row execute function public.form101_submitted();

-- ---- row-level security: read only, the admin and payroll of the business worked in now -------------------------------------------
do $$
declare
  t text;
  gate constant text := 'business_id = (select public.current_business_id()) and business_id in (select public.accessible_business_ids())';
  full_access constant text := '(select public.my_access()) <> ''register''';
  module constant text := '(select public.has_module(''attendance''))';
begin
  foreach t in array array['form101_requests', 'form101_submissions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_business_gate', t);
    execute format('create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)', t || '_business_gate', t, gate, gate);
    execute format('drop policy if exists %I on public.%I', t || '_cashier_none', t);
    execute format('create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)', t || '_cashier_none', t, full_access, full_access);
    execute format('drop policy if exists %I on public.%I', t || '_module', t);
    execute format('create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)', t || '_module', t, module, module);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select to authenticated using ((select public.att_role()) in (''admin'', ''payroll''))', t || '_read', t);
    execute format('revoke insert, update, delete, truncate on public.%I from public, anon, authenticated', t);
  end loop;
end $$;

-- the files: a private bucket with no policy for the browser at all — the server hands out a short-lived link after its own check
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('form101-files', 'form101-files', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'])
on conflict (id) do nothing;

-- To undo (in the SQL Editor; no data of another table depends on these): drop the two tables, their functions and the bucket's
-- objects / the bucket; the two columns of timeclock_settings can stay.
