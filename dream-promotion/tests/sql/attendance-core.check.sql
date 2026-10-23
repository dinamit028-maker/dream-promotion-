-- Attendance, stage 1 (2.107, migration 5800) on a real Postgres (tests/sql/run.sh) — the whole path of one month:
-- an employee is added, clocks in and out through the clock (the server), a manager adds a forgotten shift, corrects one (the old
-- entry voided, a new one in its place — both kept, with the history), closes a forgotten clock-out, approves an employee's request,
-- records absences, approves and closes the month (locked: nothing is written into it), reopens it with a reason.
-- And who may: the owner / editor = admin, an approver = only the people given to them, payroll reads (and the private part), a
-- viewer reads, a cashier and another business — nothing; a business without the module — nothing of it. Nothing is ever deleted.
--   "Shop" A: owner a1, editor a2, approver a3 (department "מטבח"), payroll a4, viewer a5, cashier a6. "Other" B: owner b1.
--   "Clock only" C (modules {attendance}): owner c1. "Dream only" D (modules {dream}): owner d1.
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
  ('00000000-0000-0000-0000-0000000580a1', 'owner@shop-58.test'), ('00000000-0000-0000-0000-0000000580a2', 'editor@shop-58.test'),
  ('00000000-0000-0000-0000-0000000580a3', 'approver@shop-58.test'), ('00000000-0000-0000-0000-0000000580a4', 'payroll@shop-58.test'),
  ('00000000-0000-0000-0000-0000000580a5', 'viewer@shop-58.test'), ('00000000-0000-0000-0000-0000000580a6', 'cashier@shop-58.test'),
  ('00000000-0000-0000-0000-0000000580b1', 'owner@other-58.test'), ('00000000-0000-0000-0000-0000000580c1', 'owner@clock-58.test'),
  ('00000000-0000-0000-0000-0000000580d1', 'owner@dream-58.test');
insert into public.profiles (id, full_name, email) values
  ('00000000-0000-0000-0000-0000000580a1', 'רונית הבעלים', 'owner@shop-58.test'), ('00000000-0000-0000-0000-0000000580a3', 'יוסי המאשר', 'approver@shop-58.test')
on conflict (id) do update set full_name = excluded.full_name, email = excluded.email;
insert into public.businesses (id, name, slug) values
  ('00000000-0000-0000-0000-00000058b001', 'Shop', 'shop-58'), ('00000000-0000-0000-0000-00000058b002', 'Other', 'other-58');
insert into public.businesses (id, name, slug, modules) values
  ('00000000-0000-0000-0000-00000058b003', 'Clock', 'clock-58', array['attendance']), ('00000000-0000-0000-0000-00000058b004', 'Dream', 'dream-58', array['dream']);
insert into public.business_members (business_id, user_id, role, access, attendance_role) values
  ('00000000-0000-0000-0000-00000058b001', '00000000-0000-0000-0000-0000000580a1', 'owner', 'full', null),
  ('00000000-0000-0000-0000-00000058b001', '00000000-0000-0000-0000-0000000580a2', 'editor', 'full', null),
  ('00000000-0000-0000-0000-00000058b001', '00000000-0000-0000-0000-0000000580a3', 'editor', 'full', 'approver'),
  ('00000000-0000-0000-0000-00000058b001', '00000000-0000-0000-0000-0000000580a4', 'viewer', 'full', 'payroll'),
  ('00000000-0000-0000-0000-00000058b001', '00000000-0000-0000-0000-0000000580a5', 'viewer', 'full', null),
  ('00000000-0000-0000-0000-00000058b001', '00000000-0000-0000-0000-0000000580a6', 'editor', 'register', null),
  ('00000000-0000-0000-0000-00000058b002', '00000000-0000-0000-0000-0000000580b1', 'owner', 'full', null),
  ('00000000-0000-0000-0000-00000058b003', '00000000-0000-0000-0000-0000000580c1', 'owner', 'full', null),
  ('00000000-0000-0000-0000-00000058b004', '00000000-0000-0000-0000-0000000580d1', 'owner', 'full', null);

select pg_temp.refused_with($$insert into public.business_members (business_id, user_id, attendance_role) values
  ('00000000-0000-0000-0000-00000058b002', '00000000-0000-0000-0000-0000000580a1', 'boss')$$, 'attendance_role_check', 'roles from the list');
select pg_temp.refused_with($$update public.businesses set modules = array['crm'] where id = '00000000-0000-0000-0000-00000058b002'$$,
  'modules_check', 'modules from the list');
select pg_temp.refused_with($$update public.businesses set modules = '{}' where id = '00000000-0000-0000-0000-00000058b002'$$,
  'modules_check', 'at least one module');
select pg_temp.check((select bool_and(modules = array['dream', 'attendance']) from public.businesses where id not in
  ('00000000-0000-0000-0000-00000058b003', '00000000-0000-0000-0000-00000058b004')), 'every other business keeps both modules');

-- ---- 1. who is who -------------------------------------------------------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000580a1');
select pg_temp.check(public.att_role() = 'admin' and public.has_module('attendance') and public.has_module('dream'), 'the owner: admin, both modules');
select pg_temp.as_user('00000000-0000-0000-0000-0000000580a2');
select pg_temp.check(public.att_role() = 'admin', 'an editor: admin (as before: the editors managed the clock)');
select pg_temp.as_user('00000000-0000-0000-0000-0000000580a3');
select pg_temp.check(public.att_role() = 'approver', 'approver');
select pg_temp.as_user('00000000-0000-0000-0000-0000000580a4');
select pg_temp.check(public.att_role() = 'payroll', 'payroll');
select pg_temp.as_user('00000000-0000-0000-0000-0000000580a5');
select pg_temp.check(public.att_role() = 'viewer', 'viewer');
select pg_temp.as_user('00000000-0000-0000-0000-0000000580a6');
select pg_temp.check(public.att_role() = 'none', 'a cashier: nothing');
select pg_temp.as_user('00000000-0000-0000-0000-0000000580c1');
select pg_temp.check(public.has_module('attendance') and not public.has_module('dream'), 'attendance only');
select pg_temp.as_user('00000000-0000-0000-0000-0000000580d1');
select pg_temp.check(not public.has_module('attendance') and public.has_module('dream'), 'Dream only');
commit;

-- ---- 2. the admin sets up: a department, a track, employees (the private part apart) -------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000580a1');
insert into public.departments (id, business_id, name) values
  ('00000000-0000-0000-0000-00000058d001', '00000000-0000-0000-0000-00000058b001', 'מטבח'),
  ('00000000-0000-0000-0000-00000058d002', '00000000-0000-0000-0000-00000058b001', 'שירות');
insert into public.work_tracks (id, business_id, name, day_minutes, start_time) values
  ('00000000-0000-0000-0000-00000058f001', '00000000-0000-0000-0000-00000058b001', '8.6 שעות', array[516, 516, 516, 516, 516, 0, 0], '08:00');
insert into public.employees (id, user_id, business_id, name, phone, token, employee_code, department_id, title, track_id, start_date) values
  ('00000000-0000-0000-0000-00000058e001', '00000000-0000-0000-0000-0000000580a1', '00000000-0000-0000-0000-00000058b001', 'דנה כהן', '0501111111',
   'tok58-dana-AAAAAAAAAAAAAAAAAAAAAAAA', '101', '00000000-0000-0000-0000-00000058d001', 'טבחית', '00000000-0000-0000-0000-00000058f001', '2026-01-01'),
  ('00000000-0000-0000-0000-00000058e002', '00000000-0000-0000-0000-0000000580a1', '00000000-0000-0000-0000-00000058b001', 'אבי לוי', '0502222222',
   'tok58-avi-BBBBBBBBBBBBBBBBBBBBBBBBB', '102', '00000000-0000-0000-0000-00000058d002', 'מלצר', '00000000-0000-0000-0000-00000058f001', '2026-01-01');
insert into public.employee_private (employee_id, business_id, id_number, pay_kind, hourly_agorot) values
  ('00000000-0000-0000-0000-00000058e001', '00000000-0000-0000-0000-00000058b001', '123456782', 'hourly', 4500);
insert into public.attendance_approvers (business_id, approver_user_id, department_id, created_by) values
  ('00000000-0000-0000-0000-00000058b001', '00000000-0000-0000-0000-0000000580a3', '00000000-0000-0000-0000-00000058d001', '00000000-0000-0000-0000-0000000580a1');
select pg_temp.refused_with($$insert into public.employees (user_id, business_id, name, token, employee_code) values
  ('00000000-0000-0000-0000-0000000580a1', '00000000-0000-0000-0000-00000058b001', 'כפול', 'tok58-dup-CCCCCCCCCCCCCCCCCCCCCCCC', '101')$$,
  'employees_code_uq', 'an employee code once per business');
select pg_temp.refused_with($$insert into public.attendance_approvers (business_id, approver_user_id, employee_id) values
  ('00000000-0000-0000-0000-00000058b001', '00000000-0000-0000-0000-0000000580b1', '00000000-0000-0000-0000-00000058e002')$$,
  'not a member', 'an approver is a member of the business');
select pg_temp.refused_with($$insert into public.employee_private (employee_id, business_id, id_number) values
  ('00000000-0000-0000-0000-00000058e002', '00000000-0000-0000-0000-00000058b001', '12345')$$, 'id_number_check', 'an ID number is 9 digits');
commit;

-- the others may not set up
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000580a3');
select pg_temp.refused_with($$insert into public.departments (business_id, name) values ('00000000-0000-0000-0000-00000058b001', 'x')$$,
  'row-level security', 'an approver adds no department');
select pg_temp.as_user('00000000-0000-0000-0000-0000000580a4');
select pg_temp.refused_with($$insert into public.departments (business_id, name) values ('00000000-0000-0000-0000-00000058b001', 'x')$$,
  'row-level security', 'payroll adds nothing');
select pg_temp.as_user('00000000-0000-0000-0000-0000000580a5');
select pg_temp.refused_with($$insert into public.departments (business_id, name) values ('00000000-0000-0000-0000-00000058b001', 'x')$$,
  'row-level security', 'a viewer adds nothing');
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000580a3');
update public.employees set title = 'x' where id = '00000000-0000-0000-0000-00000058e001';
commit;
select pg_temp.check((select title from public.employees where id = '00000000-0000-0000-0000-00000058e001') = 'טבחית', 'an approver''s update changed nothing');

-- ---- 3. the clock (the server, as /api/clock/<token>): in and out, exactly as before ------------------------------------------------------
begin;
set local role service_role;
select pg_temp.as_server();
-- Tuesday 1.9.2026, 08:05–16:41 (Israel, UTC+3) — and Wednesday 2.9 in, forgotten out
insert into public.time_entries (id, user_id, business_id, employee_id, clock_in, in_lat, in_lng, source) values
  ('00000000-0000-0000-0000-000000581001', '00000000-0000-0000-0000-0000000580a1', '00000000-0000-0000-0000-00000058b001', '00000000-0000-0000-0000-00000058e001',
   '2026-09-01 05:05:00+00', 32.08, 34.78, 'qr');
update public.time_entries set clock_out = '2026-09-01 13:41:00+00', out_lat = 32.08, out_lng = 34.78 where id = '00000000-0000-0000-0000-000000581001' and clock_out is null;
insert into public.time_entries (id, user_id, business_id, employee_id, clock_in, source) values
  ('00000000-0000-0000-0000-000000581002', '00000000-0000-0000-0000-0000000580a1', '00000000-0000-0000-0000-00000058b001', '00000000-0000-0000-0000-00000058e001',
   '2026-09-02 05:00:00+00', 'self');
-- Avi: Thursday 3.9 a night shift 22:00–06:00
insert into public.time_entries (id, user_id, business_id, employee_id, clock_in, clock_out, source) values
  ('00000000-0000-0000-0000-000000582001', '00000000-0000-0000-0000-0000000580a1', '00000000-0000-0000-0000-00000058b001', '00000000-0000-0000-0000-00000058e002',
   '2026-09-03 19:00:00+00', '2026-09-04 03:00:00+00', 'self');
select pg_temp.refused_with($$insert into public.time_entries (user_id, business_id, employee_id, clock_in, source) values
  ('00000000-0000-0000-0000-0000000580a1', '00000000-0000-0000-0000-00000058b001', '00000000-0000-0000-0000-00000058e001', '2026-09-02 06:00:00+00', 'self')$$,
  'time_entries_one_open', 'one open shift per employee (as before)');
commit;
select pg_temp.check((select method || '/' || out_method from public.time_entries where id = '00000000-0000-0000-0000-000000581001') = 'qr/qr', 'how: QR in and out');
select pg_temp.check((select method from public.time_entries where id = '00000000-0000-0000-0000-000000581002') = 'link', 'how: the link');
select pg_temp.check((select string_agg(kind || ':' || channel, ',' order by at) from public.time_entry_events where entry_id = '00000000-0000-0000-0000-000000581001')
  = 'created:clock,clock_out:clock', 'the clock''s history: ' || coalesce((select string_agg(kind || ':' || channel, ',' order by at) from public.time_entry_events
     where entry_id = '00000000-0000-0000-0000-000000581001'), '-'));
select pg_temp.check((select last_active_at from public.employees where id = '00000000-0000-0000-0000-00000058e001') = '2026-09-02 05:00:00+00', 'פעיל לאחרונה');
begin;
set local role service_role;
select pg_temp.as_server();
select pg_temp.refused_with($$update public.time_entries set clock_out = '2026-09-01 14:00:00+00' where id = '00000000-0000-0000-0000-000000581001'$$,
  'set once', 'a clock-out is set once — not even the server changes it');
select pg_temp.refused_with($$update public.time_entries set clock_in = '2026-09-01 04:00:00+00' where id = '00000000-0000-0000-0000-000000581001'$$,
  'not rewritten', 'a clock-in never changes');
commit;

-- ---- 4. nothing is deleted, nothing is written around the functions -------------------------------------------------------------------
select pg_temp.refused_with($$delete from public.time_entries where id = '00000000-0000-0000-0000-000000581001'$$, 'never deleted', 'not even by the owner of the database');
select pg_temp.refused_with($$delete from public.employees where id = '00000000-0000-0000-0000-00000058e002'$$, 'never deleted', 'an employee: archived, not deleted (and not by a cascade)');
select pg_temp.refused_with($$delete from public.time_entry_events$$, 'never deleted', 'the history');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000580a1');
select pg_temp.refused_with($$delete from public.time_entries where id = '00000000-0000-0000-0000-000000581001'$$, 'permission denied', 'the app deletes no entry');
select pg_temp.refused_with($$update public.time_entries set clock_out = now() where id = '00000000-0000-0000-0000-000000581002'$$,
  'only through the attendance functions', 'the app writes no entry directly');
select pg_temp.refused_with($$insert into public.time_entries (user_id, business_id, employee_id, clock_in, clock_out) values ('00000000-0000-0000-0000-0000000580a1',
  '00000000-0000-0000-0000-00000058b001', '00000000-0000-0000-0000-00000058e002', '2026-09-08 05:00:00+00', '2026-09-08 06:00:00+00')$$,
  'only through the attendance functions', 'nor adds one');
select pg_temp.refused_with($$insert into public.time_entry_events (business_id, employee_id, entry_id, channel, kind) values ('00000000-0000-0000-0000-00000058b001',
  '00000000-0000-0000-0000-00000058e001', '00000000-0000-0000-0000-000000581001', 'app', 'created')$$, 'permission denied', 'nor the history');
select pg_temp.refused_with($$delete from public.employees where id = '00000000-0000-0000-0000-00000058e002'$$, 'permission denied', 'nor an employee');
commit;

-- ---- 5. the manager: a forgotten shift, a correction, a forgotten clock-out, a void ------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000580a1');
select pg_temp.refused_with($$select public.att_entry_add('00000000-0000-0000-0000-000000583001', '00000000-0000-0000-0000-00000058e001',
  '2026-09-06 05:00:00+00', '2026-09-06 14:00:00+00', ' ')$$, 'a reason is required', 'a reason, always');
-- an open shift runs until it is closed: nothing is added after it before that
select pg_temp.refused_with($$select public.att_entry_add('00000000-0000-0000-0000-000000583001', '00000000-0000-0000-0000-00000058e001',
  '2026-09-06 05:00:00+00', '2026-09-06 14:00:00+00', 'שכחה להחתים')$$, 'overlaps', 'not over an open shift');
-- the forgotten clock-out of 2.9: 16:30
select public.att_entry_close('00000000-0000-0000-0000-000000581002', '2026-09-02 13:30:00+00', 'שכחה לצאת');
select pg_temp.refused_with($$select public.att_entry_close('00000000-0000-0000-0000-000000581002', '2026-09-02 14:30:00+00', 'שוב')$$, 'not open', 'once');
-- Sunday 6.9: 08:00–17:00, not reported
select public.att_entry_add('00000000-0000-0000-0000-000000583001', '00000000-0000-0000-0000-00000058e001', '2026-09-06 05:00:00+00', '2026-09-06 14:00:00+00', 'שכחה להחתים');
select public.att_entry_add('00000000-0000-0000-0000-000000583001', '00000000-0000-0000-0000-00000058e001', '2026-09-06 05:00:00+00', '2026-09-06 14:00:00+00', 'שכחה להחתים');
select pg_temp.refused_with($$select public.att_entry_add('00000000-0000-0000-0000-000000583002', '00000000-0000-0000-0000-00000058e001',
  '2026-09-06 13:00:00+00', '2026-09-06 15:00:00+00', 'כפול')$$, 'overlaps', 'no two entries at the same time');
select pg_temp.refused_with($$select public.att_entry_add('00000000-0000-0000-0000-000000583003', '00000000-0000-0000-0000-00000058e001',
  now() + interval '1 hour', now() + interval '2 hours', 'עתיד')$$, 'future', 'not in the future');
-- the correction: 1.9 was 08:00–16:41 (the clock-in was late by a fault)
select public.att_entry_fix('00000000-0000-0000-0000-000000581001', '00000000-0000-0000-0000-000000583010', '2026-09-01 05:00:00+00', '2026-09-01 13:41:00+00', 'תקלה בשעון');
select public.att_entry_fix('00000000-0000-0000-0000-000000581001', '00000000-0000-0000-0000-000000583010', '2026-09-01 05:00:00+00', '2026-09-01 13:41:00+00', 'תקלה בשעון');
select pg_temp.refused_with($$select public.att_entry_fix('00000000-0000-0000-0000-000000581001', '00000000-0000-0000-0000-000000583011',
  '2026-09-01 05:00:00+00', '2026-09-01 13:00:00+00', 'שוב')$$, 'already corrected', 'a voided entry is corrected once');
commit;
select pg_temp.check((select count(*) from public.time_entries where id = '00000000-0000-0000-0000-000000583001') = 1, 'a retry is the same shift');
select pg_temp.check((select voided_at is not null and void_reason = 'תקלה בשעון' and clock_in = '2026-09-01 05:05:00+00'
  from public.time_entries where id = '00000000-0000-0000-0000-000000581001'), 'the old entry stays, voided, as it was');
select pg_temp.check((select replaces = '00000000-0000-0000-0000-000000581001' and method = 'manual' and out_method = 'qr' and out_lat = 32.08 and in_lat is null
  from public.time_entries where id = '00000000-0000-0000-0000-000000583010'), 'the new one: what it replaces, the clock-out kept as it was (QR, its place)');
select pg_temp.check((select string_agg(kind || ':' || reason, ',' order by at) from public.time_entry_events
  where entry_id in ('00000000-0000-0000-0000-000000581001', '00000000-0000-0000-0000-000000583010'))
  = 'created:,clock_out:,voided:תקלה בשעון,replacement:תקלה בשעון', 'the history of a correction');
select pg_temp.check((select actor_name from public.time_entry_events where entry_id = '00000000-0000-0000-0000-000000583010') = 'רונית הבעלים', 'who corrected');
select pg_temp.check((select out_method = 'manual' and clock_out = '2026-09-02 13:30:00+00' from public.time_entries where id = '00000000-0000-0000-0000-000000581002'),
  'the forgotten clock-out, by a manager');

-- ---- 6. the approver: only their department; payroll and the viewer read -----------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000580a3');
select pg_temp.check((select string_agg(name, ',') from public.employees) = 'דנה כהן', 'an approver sees only their people');
select pg_temp.check((select count(distinct employee_id) from public.time_entries) = 1, '… and only their entries');
select pg_temp.check((select count(*) from public.employee_private) = 0, '… and no private details');
select pg_temp.refused_with($$select public.att_entry_add('00000000-0000-0000-0000-000000583020', '00000000-0000-0000-0000-00000058e002',
  '2026-09-07 05:00:00+00', '2026-09-07 06:00:00+00', 'לא שלי')$$, 'not allowed', 'not someone else''s');
select public.att_entry_add('00000000-0000-0000-0000-000000583021', '00000000-0000-0000-0000-00000058e001', '2026-09-07 05:00:00+00', '2026-09-07 13:00:00+00', 'דיווח ידני');
select pg_temp.as_user('00000000-0000-0000-0000-0000000580a4');
select pg_temp.check((select count(*) from public.employees where business_id = '00000000-0000-0000-0000-00000058b001') = 2, 'payroll reads everyone');
select pg_temp.check((select id_number from public.employee_private) = '123456782', '… and the private part');
select pg_temp.refused_with($$select public.att_entry_add('00000000-0000-0000-0000-000000583022', '00000000-0000-0000-0000-00000058e001',
  '2026-09-08 05:00:00+00', '2026-09-08 06:00:00+00', 'x')$$, 'not allowed', 'payroll writes nothing');
select pg_temp.as_user('00000000-0000-0000-0000-0000000580a5');
select pg_temp.check((select count(*) from public.time_entries where business_id = '00000000-0000-0000-0000-00000058b001') > 0, 'a viewer reads');
select pg_temp.check((select count(*) from public.employee_private) = 0, '… not the private part');
select pg_temp.refused_with($$select public.att_entry_void('00000000-0000-0000-0000-000000583021', 'x y')$$, 'not allowed', 'a viewer writes nothing');
select pg_temp.as_user('00000000-0000-0000-0000-0000000580a6');
select pg_temp.check((select count(*) from public.employees) = 0 and (select count(*) from public.time_entries) = 0, 'a cashier: nothing');
select pg_temp.as_user('00000000-0000-0000-0000-0000000580b1');
select pg_temp.check((select count(*) from public.time_entries) = 0 and (select count(*) from public.time_entry_events) = 0, 'another business: nothing');
select pg_temp.refused_with($$select public.att_entry_void('00000000-0000-0000-0000-000000583021', 'x y')$$, 'not allowed', '… and changes nothing');
select pg_temp.as_user('00000000-0000-0000-0000-0000000580d1');
select pg_temp.refused_with($$select public.att_month_mark('00000000-0000-0000-0000-00000058e001', '2026-09', 'approved')$$, 'not allowed', 'a business without the module');
select pg_temp.check((select count(*) from public.departments) = 0, '… sees no attendance table');
commit;

-- ---- 7. an employee's request (the server) and the manager's decision -----------------------------------------------------------------
begin;
set local role service_role;
select pg_temp.as_server();
-- Avi forgot Tuesday 8.9, 09:00–15:00
select public.att_request_create('00000000-0000-0000-0000-000000584001', '00000000-0000-0000-0000-00000058e002', 'shift', null,
  '2026-09-08 06:00:00+00', '2026-09-08 12:00:00+00', 'שכחתי את הטלפון');
select public.att_request_create('00000000-0000-0000-0000-000000584001', '00000000-0000-0000-0000-00000058e002', 'shift', null,
  '2026-09-08 06:00:00+00', '2026-09-08 12:00:00+00', 'שכחתי את הטלפון');
select public.att_request_create('00000000-0000-0000-0000-000000584002', '00000000-0000-0000-0000-00000058e002', 'shift', null,
  '2026-09-09 06:00:00+00', '2026-09-09 12:00:00+00', 'עוד יום');
-- an absence the employee asks for, with a sick note
select public.att_absence_add('00000000-0000-0000-0000-000000585001', '00000000-0000-0000-0000-00000058e002', 'sick', '2026-09-10', '2026-09-11', null, 'חום',
  '00000000-0000-0000-0000-00000058b001/00000000-0000-0000-0000-00000058e002/note.pdf');
select pg_temp.refused_with($$select public.att_absence_add('00000000-0000-0000-0000-000000585009', '00000000-0000-0000-0000-00000058e002', 'sick', '2026-09-10', '2026-09-10', null, '',
  '00000000-0000-0000-0000-00000058b002/x.pdf')$$, 'not allowed', 'a file of the employee''s own business only');
commit;
select pg_temp.check((select count(*) from public.time_requests) = 2, 'a retry is the same request');
select pg_temp.check((select status || '/' || requested_by from public.absences where id = '00000000-0000-0000-0000-000000585001') = 'pending/employee', 'the employee''s absence waits');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000580a3');
select pg_temp.refused_with($$select public.att_request_decide('00000000-0000-0000-0000-000000584001', true, '')$$, 'not allowed', 'not the approver of Avi');
select pg_temp.as_user('00000000-0000-0000-0000-0000000580a2');
select public.att_request_decide('00000000-0000-0000-0000-000000584001', true, '');
select pg_temp.refused_with($$select public.att_request_decide('00000000-0000-0000-0000-000000584001', true, '')$$, 'already decided', 'once');
select pg_temp.refused_with($$select public.att_request_decide('00000000-0000-0000-0000-000000584002', false, '')$$, 'reason', 'a rejection says why');
select public.att_request_decide('00000000-0000-0000-0000-000000584002', false, 'לא עבדת ביום הזה');
select public.att_absence_decide('00000000-0000-0000-0000-000000585001', 'approved', '');
-- the manager records a vacation day (approved at once), then a reserve duty, cancelled by mistake
select public.att_absence_add('00000000-0000-0000-0000-000000585002', '00000000-0000-0000-0000-00000058e001', 'vacation', '2026-09-14', '2026-09-14', null, '', '');
select public.att_absence_add('00000000-0000-0000-0000-000000585003', '00000000-0000-0000-0000-00000058e001', 'reserve', '2026-09-20', '2026-09-24', null, '', '');
select pg_temp.refused_with($$select public.att_absence_decide('00000000-0000-0000-0000-000000585003', 'cancelled', '')$$, 'reason', 'a cancel says why');
select public.att_absence_decide('00000000-0000-0000-0000-000000585003', 'cancelled', 'נרשם בטעות');
commit;
select pg_temp.check((select t.method = 'request' and t.clock_in = '2026-09-08 06:00:00+00' and q.status = 'approved'
  from public.time_requests q join public.time_entries t on t.id = q.result_entry_id where q.id = '00000000-0000-0000-0000-000000584001'), 'approved = the entry');
select pg_temp.check((select status = 'rejected' and result_entry_id is null and decision_note = 'לא עבדת ביום הזה' from public.time_requests
  where id = '00000000-0000-0000-0000-000000584002'), 'rejected = nothing written, the reason kept');
select pg_temp.check((select string_agg(id::text || ':' || status, ',' order by id) from public.absences) =
  '00000000-0000-0000-0000-000000585001:approved,00000000-0000-0000-0000-000000585002:approved,00000000-0000-0000-0000-000000585003:cancelled', 'absences');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000580a1');
select pg_temp.refused_with($$update public.absences set status = 'approved' where id = '00000000-0000-0000-0000-000000585003'$$, 'permission denied', 'the app changes no absence directly');
commit;

-- ---- 8. the month: approve, close (and what it refuses), locked, reopened --------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000580a1');
select pg_temp.refused_with($$select public.att_month_mark('00000000-0000-0000-0000-00000058e001', to_char(now() at time zone 'Asia/Jerusalem', 'YYYY-MM'), 'closed')$$,
  'after it ended', 'the month worked in now is not closed');
commit;
-- Avi: an open shift on 29.9 (the clock) — September can not close for him until it is closed
begin;
set local role service_role;
select pg_temp.as_server();
insert into public.time_entries (id, user_id, business_id, employee_id, clock_in, source) values
  ('00000000-0000-0000-0000-000000582009', '00000000-0000-0000-0000-0000000580a1', '00000000-0000-0000-0000-00000058b001', '00000000-0000-0000-0000-00000058e002',
   '2026-09-29 05:00:00+00', 'self');
select public.att_request_create('00000000-0000-0000-0000-000000584003', '00000000-0000-0000-0000-00000058e001', 'shift', null,
  '2026-09-15 05:00:00+00', '2026-09-15 06:00:00+00', 'שעה');
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000580a3');
select public.att_month_mark('00000000-0000-0000-0000-00000058e001', '2026-09', 'approved');
select pg_temp.refused_with($$select public.att_month_mark('00000000-0000-0000-0000-00000058e001', '2026-09', 'closed')$$, 'not allowed', 'an approver approves, the admin closes');
select pg_temp.as_user('00000000-0000-0000-0000-0000000580a1');
select pg_temp.refused_with($$select public.att_month_mark('00000000-0000-0000-0000-00000058e002', '2026-09', 'closed')$$, 'open shift', 'not with an open shift');
select pg_temp.refused_with($$select public.att_month_mark('00000000-0000-0000-0000-00000058e001', '2026-09', 'closed')$$, 'request is waiting', 'not with a request waiting');
select public.att_request_decide('00000000-0000-0000-0000-000000584003', false, 'לא אושר');
-- the track's settings change without any confirmation (they are a recommendation only — the owner of the system, 23.10.2026)
update public.work_tracks set tier1_pct = 130 where id = '00000000-0000-0000-0000-00000058f001';
update public.work_tracks set tier1_pct = 125 where id = '00000000-0000-0000-0000-00000058f001';
select pg_temp.refused_with($$update public.work_tracks set ot_mode = 'monthly' where id = '00000000-0000-0000-0000-00000058f001'$$, 'work_tracks_rules_check',
  'a monthly threshold has its hours and its 125% part');
select public.att_month_mark('00000000-0000-0000-0000-00000058e001', '2026-09', 'closed');
select public.att_month_mark('00000000-0000-0000-0000-00000058e001', '2026-09', 'closed');
select pg_temp.check((select rules_snapshot->>'name' = '8.6 שעות' and (rules_snapshot->>'tier1_pct')::int = 125 from public.attendance_months
  where employee_id = '00000000-0000-0000-0000-00000058e001' and month = '2026-09'), 'the month keeps the rules it was closed with');
-- locked: nothing of Dana's September is written
select pg_temp.refused_with($$select public.att_entry_add('00000000-0000-0000-0000-000000583030', '00000000-0000-0000-0000-00000058e001',
  '2026-09-16 05:00:00+00', '2026-09-16 06:00:00+00', 'אחרי הסגירה')$$, 'month is closed', 'no new entry in a closed month');
select pg_temp.refused_with($$select public.att_entry_fix('00000000-0000-0000-0000-000000583001', '00000000-0000-0000-0000-000000583031',
  '2026-09-06 05:00:00+00', '2026-09-06 13:00:00+00', 'אחרי הסגירה')$$, 'month is closed', 'no correction');
select pg_temp.refused_with($$select public.att_entry_void('00000000-0000-0000-0000-000000583001', 'אחרי הסגירה')$$, 'month is closed', 'no void');
select pg_temp.refused_with($$select public.att_absence_add('00000000-0000-0000-0000-000000585004', '00000000-0000-0000-0000-00000058e001', 'vacation', '2026-09-30', '2026-10-01', null, '', '')$$,
  'month is closed', 'no absence that touches it');
select pg_temp.refused_with($$select public.att_month_mark('00000000-0000-0000-0000-00000058e001', '2026-09', 'approved')$$, 'month is closed', 'approved after closed — no');
-- Avi's September is open: his shift may still be closed
select public.att_entry_close('00000000-0000-0000-0000-000000582009', '2026-09-29 14:00:00+00', 'שכח לצאת');
select public.att_month_mark('00000000-0000-0000-0000-00000058e002', '2026-09', 'closed');
-- reopen: the admin only, with a reason
select pg_temp.refused_with($$select public.att_month_mark('00000000-0000-0000-0000-00000058e001', '2026-09', 'reopened', '')$$, 'reason', 'a reopen says why');
select public.att_month_mark('00000000-0000-0000-0000-00000058e001', '2026-09', 'reopened', 'תיקון אחרי בדיקת רו״ח');
select public.att_entry_add('00000000-0000-0000-0000-000000583032', '00000000-0000-0000-0000-00000058e001', '2026-09-16 05:00:00+00', '2026-09-16 06:00:00+00', 'אחרי הפתיחה');
select public.att_month_mark('00000000-0000-0000-0000-00000058e001', '2026-09', 'closed');
commit;
begin;
set local role service_role;
select pg_temp.as_server();
select pg_temp.refused_with($$select public.att_request_create('00000000-0000-0000-0000-000000584009', '00000000-0000-0000-0000-00000058e001', 'shift', null,
  '2026-09-17 05:00:00+00', '2026-09-17 06:00:00+00', '')$$, 'month is closed', 'no request into a closed month');
commit;
select pg_temp.check((select string_agg(kind || ':' || reason, ',' order by at) from public.attendance_month_events where employee_id = '00000000-0000-0000-0000-00000058e001')
  = 'approved:,closed:,reopened:תיקון אחרי בדיקת רו״ח,closed:', 'the month''s history (a repeated close is one)');
select pg_temp.check((select status from public.attendance_months where employee_id = '00000000-0000-0000-0000-00000058e001' and month = '2026-09') = 'closed', 'closed again');

-- ---- 9. the sums one may trust: every live entry of Dana's September, and nothing lost -------------------------------------------------
select pg_temp.check((select count(*) from public.time_entries where employee_id = '00000000-0000-0000-0000-00000058e001') = 6, 'every entry kept (with the voided one)');
select pg_temp.check((select sum(extract(epoch from clock_out - clock_in)) / 60 from public.time_entries
  where employee_id = '00000000-0000-0000-0000-00000058e001' and voided_at is null) = 521 + 510 + 540 + 480 + 60, 'the live minutes of September');
select pg_temp.check((select count(*) from public.time_entries t where not exists (select 1 from public.time_entry_events e where e.entry_id = t.id)) = 0,
  'every entry has its history');
