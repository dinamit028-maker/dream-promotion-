-- The appointments calendar (2.105, migration 5700) on a real Postgres (tests/sql/run.sh): a practitioner of the team for an
-- appointment, no double booking per practitioner (and 4600's rule for one without a practitioner), the history of every change —
-- by the trigger only, read through the appointment — and the team for the calendar without a number.
--   "Clinic" A: owner a1 (no one on the team), a2 = Sagit (practitioner, linked), a3 a cashier; the team: Sagit (yellow, a number),
--   Karin (pink, no number), Aviv (not a practitioner). "Other" B: owner b1; Dana (practitioner).
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
-- an appointment of the clinic, by its owner's account unless said (the trigger reads who from the session)
create or replace function pg_temp.appt(id text, staff text, t0 text, minutes int, name text default 'לקוחה', status text default 'booked')
returns void language sql as $$
  insert into public.appointments (id, user_id, business_id, name, start_at, end_at, staff_id, status)
  values (id::uuid, '00000000-0000-0000-0000-0000000570a1', '00000000-0000-0000-0000-00000057b001', name, t0::timestamptz,
          t0::timestamptz + make_interval(mins => minutes), staff::uuid, status);
$$;
create or replace function pg_temp.events(appt text) returns text language sql as $$
  select coalesce(string_agg(kind, ',' order by at, id), '') from public.appointment_events where appointment_id = appt::uuid;
$$;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000570a1', 'owner@clinic-57.test'), ('00000000-0000-0000-0000-0000000570a2', 'sagit@clinic-57.test'),
  ('00000000-0000-0000-0000-0000000570a3', 'cashier@clinic-57.test'), ('00000000-0000-0000-0000-0000000570b1', 'owner@other-57.test');
insert into public.profiles (id, full_name, email) values
  ('00000000-0000-0000-0000-0000000570a1', 'בעל העסק', 'owner@clinic-57.test'), ('00000000-0000-0000-0000-0000000570a2', 'Sagit P', 'sagit@clinic-57.test'),
  ('00000000-0000-0000-0000-0000000570a3', '', 'cashier@clinic-57.test'), ('00000000-0000-0000-0000-0000000570b1', 'Other', 'owner@other-57.test')
on conflict (id) do update set full_name = excluded.full_name, email = excluded.email;
insert into public.businesses (id, name, slug) values
  ('00000000-0000-0000-0000-00000057b001', 'Clinic', 'clinic-57'), ('00000000-0000-0000-0000-00000057b002', 'Other', 'other-57');
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-00000057b001', '00000000-0000-0000-0000-0000000570a1', 'owner', 'full'),
  ('00000000-0000-0000-0000-00000057b001', '00000000-0000-0000-0000-0000000570a2', 'editor', 'full'),
  ('00000000-0000-0000-0000-00000057b001', '00000000-0000-0000-0000-0000000570a3', 'editor', 'register'),
  ('00000000-0000-0000-0000-00000057b002', '00000000-0000-0000-0000-0000000570b1', 'owner', 'full');

-- ---- 1. the team: a practitioner, her colour, a number only when she gets WhatsApp -------------------------------------------------
insert into public.lead_staff (id, business_id, name, phone, member_user_id, practitioner, color) values
  ('00000000-0000-0000-0000-00000057c001', '00000000-0000-0000-0000-00000057b001', 'שגית פרץ', '972501112222', '00000000-0000-0000-0000-0000000570a2', true, 'yellow'),
  ('00000000-0000-0000-0000-00000057c002', '00000000-0000-0000-0000-00000057b001', 'קרין בן ניזרי', null, null, true, 'pink'),
  ('00000000-0000-0000-0000-00000057c003', '00000000-0000-0000-0000-00000057b001', 'אביב', '972503334444', null, false, ''),
  ('00000000-0000-0000-0000-00000057c009', '00000000-0000-0000-0000-00000057b002', 'דנה', null, null, true, 'turquoise');
select pg_temp.check((select phone is null from public.lead_staff where id = '00000000-0000-0000-0000-00000057c002'), 'a practitioner with no number');
-- two with no number in one business (Karin and Gal): allowed — one number per business is only for a number that is there
-- (lead_staff_phone_uq); the row is taken back at once (P0099), so the lists below stay as they are
do $$ begin
  insert into public.lead_staff (business_id, name, phone, practitioner, color) values ('00000000-0000-0000-0000-00000057b001', 'גל שחר', null, true, 'turquoise');
  raise exception 'taken back' using errcode = 'P0099';
exception when sqlstate 'P0099' then null;
end $$;
select pg_temp.refused_with($$insert into public.lead_staff (business_id, name, phone) values ('00000000-0000-0000-0000-00000057b001', 'x', '0501234567')$$,
  'lead_staff_phone_check', 'a number that is there keeps its format (international digits)');
select pg_temp.refused_with($$insert into public.lead_staff (business_id, name, color) values ('00000000-0000-0000-0000-00000057b001', 'x', 'purple')$$,
  'lead_staff_color_check', 'a colour from the list only');
select pg_temp.check((select count(*) = 0 from public.lead_staff where practitioner and business_id not in
  ('00000000-0000-0000-0000-00000057b001', '00000000-0000-0000-0000-00000057b002')), 'nobody was a practitioner when the columns came');

-- ---- 2. the practitioner of an appointment: of its business, on the team, marked ---------------------------------------------------
select pg_temp.check((select count(*) = 0 from pg_constraint where conname = 'appointments_location_no_overlap'), '4600''s rule is replaced');
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000570a2');
select pg_temp.appt('00000000-0000-0000-0000-00000057e001', '00000000-0000-0000-0000-00000057c002', '2030-01-06 10:00+02', 60, 'דנה ל.');
select pg_temp.refused_with($$select pg_temp.appt('00000000-0000-0000-0000-00000057e0f1', '00000000-0000-0000-0000-00000057c003', '2030-01-06 12:00+02', 30)$$,
  'not an active practitioner', 'a person of the team who is not a practitioner');
select pg_temp.refused_with($$select pg_temp.appt('00000000-0000-0000-0000-00000057e0f2', '00000000-0000-0000-0000-00000057c009', '2030-01-06 12:00+02', 30)$$,
  'not an active practitioner', 'a practitioner of another business');
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000570b1');
-- another business: refused before anything is said about the clinic's team
select pg_temp.refused_with($$select pg_temp.appt('00000000-0000-0000-0000-00000057e0f3', '00000000-0000-0000-0000-00000057c002', '2030-01-06 12:00+02', 30)$$,
  'not allowed', 'another business books with the clinic''s practitioner');
commit;

-- ---- 3. no double booking: per practitioner; with none — per location, among themselves -------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000570a1');
select pg_temp.refused_with($$select pg_temp.appt('00000000-0000-0000-0000-00000057e0f4', '00000000-0000-0000-0000-00000057c002', '2030-01-06 10:30+02', 60)$$,
  'appointments_staff_no_overlap', 'Karin twice at 10:30');
select pg_temp.appt('00000000-0000-0000-0000-00000057e002', '00000000-0000-0000-0000-00000057c001', '2030-01-06 10:30+02', 60, 'רוני ש.');   -- Sagit, the same hour
select pg_temp.appt('00000000-0000-0000-0000-00000057e003', null, '2030-01-06 10:00+02', 60, 'בלי מטפלת');                                 -- no practitioner
select pg_temp.refused_with($$select pg_temp.appt('00000000-0000-0000-0000-00000057e0f5', null, '2030-01-06 10:30+02', 30)$$,
  'appointments_unassigned_no_overlap', 'two with no practitioner at one hour (4600''s rule)');
select pg_temp.appt('00000000-0000-0000-0000-00000057e004', '00000000-0000-0000-0000-00000057c002', '2030-01-06 10:15+02', 30, 'בוטל', 'cancelled'); -- cancelled: no block
-- reassigning onto a practitioner who is busy then: refused; once she is free — fine
select pg_temp.refused_with($$update public.appointments set staff_id = '00000000-0000-0000-0000-00000057c002' where id = '00000000-0000-0000-0000-00000057e002'$$,
  'appointments_staff_no_overlap', 'Sagit''s 10:30 given to Karin, busy until 11:00');
update public.appointments set start_at = '2030-01-06 11:30+02', end_at = '2030-01-06 12:30+02' where id = '00000000-0000-0000-0000-00000057e001';
update public.appointments set staff_id = '00000000-0000-0000-0000-00000057c002' where id = '00000000-0000-0000-0000-00000057e002';
select pg_temp.check((select staff_id = '00000000-0000-0000-0000-00000057c002' from public.appointments where id = '00000000-0000-0000-0000-00000057e002'),
  'given to Karin once she is free (10:30–11:30 and 11:30–12:30 touch, not overlap)');
-- one save that moves and reassigns: the one with no practitioner, to Sagit at 13:00
update public.appointments set staff_id = '00000000-0000-0000-0000-00000057c001', start_at = '2030-01-06 13:00+02', end_at = '2030-01-06 14:00+02'
 where id = '00000000-0000-0000-0000-00000057e003';
commit;
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000570a2');
update public.appointments set status = 'done' where id = '00000000-0000-0000-0000-00000057e002';
update public.appointments set note = 'צבע 2' where id = '00000000-0000-0000-0000-00000057e002';
update public.appointments set note = 'צבע 2' where id = '00000000-0000-0000-0000-00000057e002';   -- nothing changed: nothing written
commit;

-- a practitioner who left: no new appointment for her; her existing ones go on (no check unless she is set again)
update public.lead_staff set active = false where id = '00000000-0000-0000-0000-00000057c001';
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000570a1');
select pg_temp.refused_with($$select pg_temp.appt('00000000-0000-0000-0000-00000057e0f6', '00000000-0000-0000-0000-00000057c001', '2030-01-07 10:00+02', 30)$$,
  'not an active practitioner', 'a practitioner who left');
update public.appointments set status = 'confirmed' where id = '00000000-0000-0000-0000-00000057e003';
select pg_temp.check((select status = 'confirmed' and staff_id = '00000000-0000-0000-0000-00000057c001' from public.appointments where id = '00000000-0000-0000-0000-00000057e003'),
  'her existing appointment goes on');
commit;
update public.lead_staff set active = true where id = '00000000-0000-0000-0000-00000057c001';

-- the server (no session — the booking page): no one to name
insert into public.appointments (id, user_id, business_id, name, start_at, end_at, source)
values ('00000000-0000-0000-0000-00000057e006', '00000000-0000-0000-0000-0000000570a1', '00000000-0000-0000-0000-00000057b001', 'מהדף',
        '2030-01-08 09:00+02', '2030-01-08 09:30+02', 'public');

-- ---- 4. the history: every change, who and when, written by the trigger -----------------------------------------------------------
select pg_temp.check(pg_temp.events('00000000-0000-0000-0000-00000057e001') = 'created,moved', 'Karin''s: created, moved — ' || pg_temp.events('00000000-0000-0000-0000-00000057e001'));
select pg_temp.check((select actor = '00000000-0000-0000-0000-0000000570a2' and actor_name = 'שגית פרץ' and after->>'staff' = 'קרין בן ניזרי' and after->>'status' = 'booked'
  from public.appointment_events where appointment_id = '00000000-0000-0000-0000-00000057e001' and kind = 'created'),
  'created by Sagit''s account — her name on the team (not the account''s), for Karin');
select pg_temp.check((select actor_name = 'בעל העסק' and (before->>'start')::timestamptz = '2030-01-06 10:00+02' and (after->>'start')::timestamptz = '2030-01-06 11:30+02'
  and (after->>'end')::timestamptz = '2030-01-06 12:30+02' from public.appointment_events where appointment_id = '00000000-0000-0000-0000-00000057e001' and kind = 'moved'),
  'moved by the owner (no one on the team: the account''s name), 10:00 → 11:30');
select pg_temp.check(pg_temp.events('00000000-0000-0000-0000-00000057e002') = 'created,staff,status,edited',
  'Sagit''s → Karin''s, done, a note — and the save that changed nothing wrote nothing: ' || pg_temp.events('00000000-0000-0000-0000-00000057e002'));
select pg_temp.check((select before->>'staff' = 'שגית פרץ' and after->>'staff' = 'קרין בן ניזרי' and before->>'staff_id' = '00000000-0000-0000-0000-00000057c001'
  from public.appointment_events where appointment_id = '00000000-0000-0000-0000-00000057e002' and kind = 'staff'), 'from Sagit to Karin, by name');
select pg_temp.check((select before->>'status' = 'booked' and after->>'status' = 'done' and actor_name = 'שגית פרץ'
  from public.appointment_events where appointment_id = '00000000-0000-0000-0000-00000057e002' and kind = 'status'), 'the status, by Sagit');
select pg_temp.check((select before = '{"note": ""}'::jsonb and after = '{"note": "צבע 2"}'::jsonb
  from public.appointment_events where appointment_id = '00000000-0000-0000-0000-00000057e002' and kind = 'edited'), 'an edit: only what changed');
select pg_temp.check((select string_agg(kind, ',' order by kind) from public.appointment_events where appointment_id = '00000000-0000-0000-0000-00000057e003') = 'created,moved,staff,status',
  'one save that moved and reassigned: two rows (and the status after)');
select pg_temp.check((select actor is null and actor_name = '' and after->>'source' = 'public' from public.appointment_events
  where appointment_id = '00000000-0000-0000-0000-00000057e006'), 'the booking page: no one to name');

-- ---- 5. who reads it; nobody writes it ----------------------------------------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000570a1');
select pg_temp.check((select count(*) from public.appointment_events) = (select count(*) from public.appointment_events e
  join public.appointments a on a.id = e.appointment_id where a.business_id = '00000000-0000-0000-0000-00000057b001') and
  (select count(*) from public.appointment_events) >= 12, 'the clinic reads its own history');
select pg_temp.refused_with($$insert into public.appointment_events (business_id, appointment_id, kind) values
  ('00000000-0000-0000-0000-00000057b001', '00000000-0000-0000-0000-00000057e001', 'moved')$$, 'permission denied', 'no one writes a line');
select pg_temp.refused_with($$update public.appointment_events set actor_name = 'x'$$, 'permission denied', 'no one changes a line');
select pg_temp.refused_with($$delete from public.appointment_events$$, 'permission denied', 'no one removes a line');
select pg_temp.as_user('00000000-0000-0000-0000-0000000570b1');
select pg_temp.check((select count(*) from public.appointment_events) = 0, 'another business reads none of it');
commit;

-- ---- 6. the team for the calendar: names, colours, practitioners — never a number --------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000570a2');
select pg_temp.check((select string_agg(name || ':' || color || ':' || practitioner::text, ',' order by id) from public.appointment_staff())
  = 'שגית פרץ:yellow:true,קרין בן ניזרי:pink:true,אביב::false', 'the clinic''s team: ' || (select string_agg(name, ',') from public.appointment_staff()));
select pg_temp.check((select bool_and(not (to_jsonb(s) ? 'phone')) from public.appointment_staff() s), 'no number in it');
select pg_temp.check((select member_user_id = '00000000-0000-0000-0000-0000000570a2' from public.appointment_staff() where name = 'שגית פרץ'), 'who is me');
select pg_temp.as_user('00000000-0000-0000-0000-0000000570b1');
select pg_temp.check((select string_agg(name, ',') from public.appointment_staff()) = 'דנה', 'another business: its own');
select pg_temp.as_user('00000000-0000-0000-0000-0000000570a3');
select pg_temp.check((select count(*) from public.appointment_staff()) = 0, 'a cashier: nothing');
commit;
begin;
set local role anon;
select pg_temp.refused_with($$select public.appointment_staff()$$, 'permission denied', 'a visitor');
commit;
