-- Form 101 (2.108, migration 5900) on a real Postgres (tests/sql/run.sh): a link for the tax year, the employee's submission
-- (version 1), an update during the year (version 2) — both kept; a submission is never changed, only "the signed paper received"
-- and "reviewed" are added, once each; a used / cancelled / expired link takes no submission; nothing is deleted; the browser never
-- writes; who reads: the admin and payroll of the business — not an approver, a viewer, a cashier or another business.
--   "Shop" A: owner a1, approver a3, payroll a4, viewer a5, cashier a6. "Other" B: owner b1.
\set ON_ERROR_STOP 1
set client_min_messages = warning;

create or replace function pg_temp.check(ok boolean, msg text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'CHECK FAILED: %', msg; end if; end $$;
create or replace function pg_temp.refused_with(stmt text, expect text, msg text) returns void language plpgsql as $$
begin
  execute stmt;
  raise exception 'CHECK FAILED: % (it was allowed)', msg;
exception when others then
  if sqlerrm like 'CHECK FAILED%' then raise; end if;
  if position(expect in sqlerrm) = 0 then raise exception 'CHECK FAILED: % (refused, but with "%")', msg, sqlerrm; end if;
end $$;
create or replace function pg_temp.as_user(uid text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', uid, true), set_config('request.jwt.claim.role', 'authenticated', true);
$$;
create or replace function pg_temp.as_server() returns void language sql as $$
  select set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claim.role', 'service_role', true);
$$;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000590a1', 'owner@shop-59.test'), ('00000000-0000-0000-0000-0000000590a3', 'approver@shop-59.test'),
  ('00000000-0000-0000-0000-0000000590a4', 'payroll@shop-59.test'), ('00000000-0000-0000-0000-0000000590a5', 'viewer@shop-59.test'),
  ('00000000-0000-0000-0000-0000000590a6', 'cashier@shop-59.test'), ('00000000-0000-0000-0000-0000000590b1', 'owner@other-59.test');
insert into public.businesses (id, name, slug) values
  ('00000000-0000-0000-0000-00000059b001', 'Shop', 'shop-59'), ('00000000-0000-0000-0000-00000059b002', 'Other', 'other-59');
insert into public.business_members (business_id, user_id, role, access, attendance_role) values
  ('00000000-0000-0000-0000-00000059b001', '00000000-0000-0000-0000-0000000590a1', 'owner', 'full', null),
  ('00000000-0000-0000-0000-00000059b001', '00000000-0000-0000-0000-0000000590a3', 'editor', 'full', 'approver'),
  ('00000000-0000-0000-0000-00000059b001', '00000000-0000-0000-0000-0000000590a4', 'viewer', 'full', 'payroll'),
  ('00000000-0000-0000-0000-00000059b001', '00000000-0000-0000-0000-0000000590a5', 'viewer', 'full', null),
  ('00000000-0000-0000-0000-00000059b001', '00000000-0000-0000-0000-0000000590a6', 'editor', 'register', null),
  ('00000000-0000-0000-0000-00000059b002', '00000000-0000-0000-0000-0000000590b1', 'owner', 'full', null);
insert into public.employees (id, user_id, business_id, name, phone, token) values
  ('00000000-0000-0000-0000-00000059e001', '00000000-0000-0000-0000-0000000590a1', '00000000-0000-0000-0000-00000059b001', 'דנה כהן', '0501111111', 'tok59-dana-AAAAAAAAAAAAAAAAAAAAAAAA'),
  ('00000000-0000-0000-0000-00000059e002', '00000000-0000-0000-0000-0000000590b1', '00000000-0000-0000-0000-00000059b002', 'זר', '0502222222', 'tok59-other-BBBBBBBBBBBBBBBBBBBBBBB');

-- the employer's deductions file: 9 digits starting with 9
select pg_temp.refused_with($$insert into public.timeclock_settings (user_id, business_id, employer_deductions_file)
  values ('00000000-0000-0000-0000-0000000590a1', '00000000-0000-0000-0000-00000059b001', '123')$$, 'timeclock_settings_employer_check', 'a deductions file number: 9…, 9 digits');

-- ---- the server: a link, a submission (version 1), an update (version 2) ------------------------------------------------------
begin;
set local role service_role;
select pg_temp.as_server();
insert into public.form101_requests (id, business_id, employee_id, tax_year, token_hash, expires_at, sent_by) values
  ('00000000-0000-0000-0000-000000591001', '00000000-0000-0000-0000-00000059b001', '00000000-0000-0000-0000-00000059e001', 2026, repeat('a', 64), now() + interval '30 days', '00000000-0000-0000-0000-0000000590a1'),
  ('00000000-0000-0000-0000-000000591002', '00000000-0000-0000-0000-00000059b001', '00000000-0000-0000-0000-00000059e001', 2026, repeat('b', 64), now() + interval '30 days', '00000000-0000-0000-0000-0000000590a1'),
  ('00000000-0000-0000-0000-000000591003', '00000000-0000-0000-0000-00000059b001', '00000000-0000-0000-0000-00000059e001', 2026, repeat('c', 64), now() + interval '30 days', null),
  ('00000000-0000-0000-0000-000000591004', '00000000-0000-0000-0000-00000059b001', '00000000-0000-0000-0000-00000059e001', 2026, repeat('d', 64), now() - interval '1 day', null);
select pg_temp.refused_with($$insert into public.form101_requests (business_id, employee_id, tax_year, token_hash, expires_at) values
  ('00000000-0000-0000-0000-00000059b001', '00000000-0000-0000-0000-00000059e002', 2026, repeat('e', 64), now())$$, 'foreign key', 'an employee of another business');
update public.form101_requests set status = 'opened' where id = '00000000-0000-0000-0000-000000591001';
select pg_temp.check((select opened_at is not null from public.form101_requests where id = '00000000-0000-0000-0000-000000591001'), 'opened: when');
insert into public.form101_submissions (id, business_id, employee_id, request_id, tax_year, version, form_code, data, signer_name, signature_path, pdf_path, pdf_sha256, ip, user_agent) values
  ('00000000-0000-0000-0000-000000592001', '00000000-0000-0000-0000-00000059b001', '00000000-0000-0000-0000-00000059e001', '00000000-0000-0000-0000-000000591001',
   2026, 99, '0101/130 · 11.2025', '{"employee":{"city":"חיפה"}}', 'דנה כהן', 'x/sig.png', 'x/f.pdf', repeat('0', 64), '1.2.3.4', 'test');
select pg_temp.check((select version = 1 from public.form101_submissions where id = '00000000-0000-0000-0000-000000592001'), 'the version is set by the database: 1');
select pg_temp.check((select status = 'submitted' and done_at is not null from public.form101_requests where id = '00000000-0000-0000-0000-000000591001'), 'the link: submitted');
select pg_temp.refused_with($$insert into public.form101_submissions (business_id, employee_id, request_id, tax_year, version, form_code, data, signer_name, signature_path, pdf_path, pdf_sha256) values
  ('00000000-0000-0000-0000-00000059b001', '00000000-0000-0000-0000-00000059e001', '00000000-0000-0000-0000-000000591001', 2026, 1, 'f', '{}', 'דנה', 'p', 'p', repeat('0', 64))$$,
  'no longer valid', 'one submission per link');
insert into public.form101_submissions (id, business_id, employee_id, request_id, tax_year, version, form_code, data, signer_name, signature_path, pdf_path, pdf_sha256) values
  ('00000000-0000-0000-0000-000000592002', '00000000-0000-0000-0000-00000059b001', '00000000-0000-0000-0000-00000059e001', '00000000-0000-0000-0000-000000591002',
   2026, 1, '0101/130 · 11.2025', '{"employee":{"city":"תל אביב"},"changeNote":"עברתי דירה"}', 'דנה כהן', 'y/sig.png', 'y/f.pdf', repeat('1', 64));
select pg_temp.check((select array_agg(version order by version) = array[1, 2] from public.form101_submissions where employee_id = '00000000-0000-0000-0000-00000059e001'),
  'an update during the year: version 2, version 1 kept');
-- a cancelled or expired link takes nothing
update public.form101_requests set status = 'cancelled' where id = '00000000-0000-0000-0000-000000591003';
select pg_temp.refused_with($$insert into public.form101_submissions (business_id, employee_id, request_id, tax_year, version, form_code, data, signer_name, signature_path, pdf_path, pdf_sha256) values
  ('00000000-0000-0000-0000-00000059b001', '00000000-0000-0000-0000-00000059e001', '00000000-0000-0000-0000-000000591003', 2026, 1, 'f', '{}', 'דנה', 'p', 'p', repeat('0', 64))$$,
  'no longer valid', 'a cancelled link');
select pg_temp.refused_with($$insert into public.form101_submissions (business_id, employee_id, request_id, tax_year, version, form_code, data, signer_name, signature_path, pdf_path, pdf_sha256) values
  ('00000000-0000-0000-0000-00000059b001', '00000000-0000-0000-0000-00000059e001', '00000000-0000-0000-0000-000000591004', 2026, 1, 'f', '{}', 'דנה', 'p', 'p', repeat('0', 64))$$,
  'no longer valid', 'an expired link');
select pg_temp.refused_with($$update public.form101_requests set status = 'opened' where id = '00000000-0000-0000-0000-000000591003'$$, 'closed', 'a cancelled link stays cancelled');
select pg_temp.refused_with($$update public.form101_requests set tax_year = 2027 where id = '00000000-0000-0000-0000-000000591002'$$, 'never changed', 'a link is never changed');
-- a signed form is never changed; the paper and the review — once each
select pg_temp.refused_with($$update public.form101_submissions set data = '{}' where id = '00000000-0000-0000-0000-000000592001'$$, 'never changed', 'the answers are never changed');
select pg_temp.refused_with($$update public.form101_submissions set pdf_sha256 = repeat('9', 64) where id = '00000000-0000-0000-0000-000000592001'$$, 'never changed', 'nor the PDF');
update public.form101_submissions set paper_path = 'x/paper.pdf', paper_by = '00000000-0000-0000-0000-0000000590a1', paper_at = '2000-01-01' where id = '00000000-0000-0000-0000-000000592001';
select pg_temp.check((select paper_at > now() - interval '1 minute' from public.form101_submissions where id = '00000000-0000-0000-0000-000000592001'), 'received now (not a date sent)');
select pg_temp.refused_with($$update public.form101_submissions set paper_path = 'x/other.pdf' where id = '00000000-0000-0000-0000-000000592001'$$, 'already received', 'the paper once');
update public.form101_submissions set reviewed_at = now(), reviewed_by = '00000000-0000-0000-0000-0000000590a4', review_note = 'הוזן לשכר' where id = '00000000-0000-0000-0000-000000592001';
select pg_temp.refused_with($$update public.form101_submissions set review_note = 'שונה' where id = '00000000-0000-0000-0000-000000592001'$$, 'already reviewed', 'the review once');
-- nothing is deleted
select pg_temp.refused_with($$delete from public.form101_submissions where id = '00000000-0000-0000-0000-000000592002'$$, 'never deleted', 'a submission is never deleted');
select pg_temp.refused_with($$delete from public.form101_requests where id = '00000000-0000-0000-0000-000000591003'$$, 'never deleted', 'nor a link');
commit;

-- ---- the browser: reads (admin and payroll only), never writes ----------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000590a1');
select pg_temp.check((select count(*) from public.form101_submissions) = 2, 'the owner (admin) reads both versions');
select pg_temp.check((select count(*) from public.form101_requests) = 4, 'and the links');
select pg_temp.refused_with($$insert into public.form101_requests (business_id, employee_id, tax_year, token_hash, expires_at) values
  ('00000000-0000-0000-0000-00000059b001', '00000000-0000-0000-0000-00000059e001', 2026, repeat('f', 64), now() + interval '1 day')$$, 'permission denied', 'the browser never writes a link');
select pg_temp.refused_with($$update public.form101_submissions set review_note = 'x' where id = '00000000-0000-0000-0000-000000592002'$$, 'permission denied', 'nor a submission');
select pg_temp.as_user('00000000-0000-0000-0000-0000000590a4');
select pg_temp.check((select count(*) from public.form101_submissions) = 2, 'payroll (the accountant) reads');
select pg_temp.as_user('00000000-0000-0000-0000-0000000590a3');
select pg_temp.check((select count(*) from public.form101_submissions) = 0 and (select count(*) from public.form101_requests) = 0, 'an approver: nothing');
select pg_temp.as_user('00000000-0000-0000-0000-0000000590a5');
select pg_temp.check((select count(*) from public.form101_submissions) = 0, 'a viewer: nothing');
select pg_temp.as_user('00000000-0000-0000-0000-0000000590a6');
select pg_temp.check((select count(*) from public.form101_submissions) = 0, 'a cashier: nothing');
select pg_temp.as_user('00000000-0000-0000-0000-0000000590b1');
select pg_temp.check((select count(*) from public.form101_submissions) = 0, 'another business: nothing');
commit;

-- the files' bucket is private, and the browser has no policy on it
select pg_temp.check((select not public from storage.buckets where id = 'form101-files'), 'form101-files is private');
select pg_temp.check(not exists (select 1 from pg_policies where schemaname = 'storage' and (qual like '%form101-files%' or with_check like '%form101-files%')), 'no browser policy on its files');
