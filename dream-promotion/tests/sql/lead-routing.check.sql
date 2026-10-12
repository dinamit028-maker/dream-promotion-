-- Lead departments and WhatsApp to the team (migration 20261012005300, 2.99.0) on a real Postgres (tests/sql/run.sh), tried as the
-- signed-in roles — never as the superuser, except to build the world and to write as the server does (service_role).
-- Fixtures only, with ids of their own:
--   Studio A   owner OA, editor EA (is the person "דנה" of the team), viewer VA      contacts LA1, LA2, LA3
--   Studio B   owner OB                                                              contact LB1
-- Every check raises "CHECK FAILED: …" when the database does not behave.
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
create or replace function pg_temp.affected(stmt text) returns int language plpgsql as $$
declare n int; begin execute stmt; get diagnostics n = row_count; return n; end $$;
create or replace function pg_temp.as_user(uid text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', uid, true), set_config('request.jwt.claim.role', 'authenticated', true);
$$;

-- ---- the world --------------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000005301', 'oa@lr-a.test'), ('00000000-0000-0000-0000-000000005302', 'ea@lr-a.test'),
  ('00000000-0000-0000-0000-000000005303', 'va@lr-a.test'), ('00000000-0000-0000-0000-000000005304', 'ob@lr-b.test');
insert into public.businesses (id, name, slug) values
  ('00000000-0000-0000-0000-0000000053a1', 'Studio A', 'lr-studio-a'), ('00000000-0000-0000-0000-0000000053a2', 'Studio B', 'lr-studio-b');
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-0000000053a1', '00000000-0000-0000-0000-000000005301', 'owner', 'full'),
  ('00000000-0000-0000-0000-0000000053a1', '00000000-0000-0000-0000-000000005302', 'editor', 'full'),
  ('00000000-0000-0000-0000-0000000053a1', '00000000-0000-0000-0000-000000005303', 'viewer', 'full'),
  ('00000000-0000-0000-0000-0000000053a2', '00000000-0000-0000-0000-000000005304', 'owner', 'full');
update public.profiles set current_business_id = '00000000-0000-0000-0000-0000000053a1'
 where id in ('00000000-0000-0000-0000-000000005301', '00000000-0000-0000-0000-000000005302', '00000000-0000-0000-0000-000000005303');
update public.profiles set current_business_id = '00000000-0000-0000-0000-0000000053a2' where id = '00000000-0000-0000-0000-000000005304';
insert into public.leads (id, user_id, business_id, name, phone, source) values
  ('00000000-0000-0000-0000-0000000053c1', '00000000-0000-0000-0000-000000005301', '00000000-0000-0000-0000-0000000053a1', 'נועה', '050-1111111', 'Meta · טופס לייזר'),
  ('00000000-0000-0000-0000-0000000053c2', '00000000-0000-0000-0000-000000005301', '00000000-0000-0000-0000-0000000053a1', 'רותם', '050-2222222', 'Meta · טופס כללי'),
  ('00000000-0000-0000-0000-0000000053c3', '00000000-0000-0000-0000-000000005301', '00000000-0000-0000-0000-0000000053a1', 'שירה', '050-3333333', 'ידני'),
  ('00000000-0000-0000-0000-0000000053c4', '00000000-0000-0000-0000-000000005304', '00000000-0000-0000-0000-0000000053a2', 'מיכל', '050-4444444', 'Meta · גבות');

-- the server writes the team and the departments (service_role, as /api/leads/departments does)
begin;
set local role service_role;
insert into public.lead_staff (id, business_id, name, phone, member_user_id) values
  ('00000000-0000-0000-0000-0000000053d1', '00000000-0000-0000-0000-0000000053a1', 'דנה', '972501234567', '00000000-0000-0000-0000-000000005302'),
  ('00000000-0000-0000-0000-0000000053d2', '00000000-0000-0000-0000-0000000053a1', 'מיכל', '15550100123', null),
  ('00000000-0000-0000-0000-0000000053d3', '00000000-0000-0000-0000-0000000053a2', 'אור', '972509999999', null);
insert into public.lead_departments (id, business_id, name, staff_id, position) values
  ('00000000-0000-0000-0000-0000000053e1', '00000000-0000-0000-0000-0000000053a1', 'לייזר', '00000000-0000-0000-0000-0000000053d1', 0),
  ('00000000-0000-0000-0000-0000000053e2', '00000000-0000-0000-0000-0000000053a1', 'מיקרובליידינג', '00000000-0000-0000-0000-0000000053d2', 1),
  ('00000000-0000-0000-0000-0000000053e3', '00000000-0000-0000-0000-0000000053a2', 'גבות', '00000000-0000-0000-0000-0000000053d3', 0);
insert into public.lead_department_rules (business_id, department_id, kind, form_id, form_name, campaign, question, answer) values
  ('00000000-0000-0000-0000-0000000053a1', '00000000-0000-0000-0000-0000000053e1', 'form', '1234567890', 'טופס לייזר', '', '', ''),
  ('00000000-0000-0000-0000-0000000053a1', '00000000-0000-0000-0000-0000000053e2', 'answer', '', '', '', 'איזה טיפול?', 'מיקרובליידינג'),
  ('00000000-0000-0000-0000-0000000053a1', '00000000-0000-0000-0000-0000000053e2', 'campaign', '', '', 'גבות אוקטובר', '', '');
insert into public.lead_routing (business_id, default_staff_id) values ('00000000-0000-0000-0000-0000000053a1', '00000000-0000-0000-0000-0000000053d2');
select pg_temp.check((select count(*) = 3 from public.lead_staff where id::text like '%53d_'), 'the server writes the team');
commit;

-- ======================================================================================================================
-- 1. the five tables are the server's: the browser neither reads nor writes them (the team's phones, Meta's errors)
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000005301');
select pg_temp.refused_with($$select * from public.lead_staff$$, 'permission denied', 'the owner reads the team only through the server');
select pg_temp.refused_with($$select * from public.lead_departments$$, 'permission denied', 'departments: through the server');
select pg_temp.refused_with($$select * from public.lead_department_rules$$, 'permission denied', 'rules: through the server');
select pg_temp.refused_with($$select * from public.lead_routing$$, 'permission denied', 'the default recipient: through the server');
select pg_temp.refused_with($$select * from public.lead_notifications$$, 'permission denied', 'the messages: through the server');
select pg_temp.refused_with($$insert into public.lead_staff (business_id, name, phone) values ('00000000-0000-0000-0000-0000000053a1', 'x', '972500000000')$$,
  'permission denied', 'the browser never adds a person');
select pg_temp.refused_with($$insert into public.lead_notifications (business_id, lead_id, staff_id, kind, dedupe_key)
  values ('00000000-0000-0000-0000-0000000053a1', '00000000-0000-0000-0000-0000000053c1', '00000000-0000-0000-0000-0000000053d1', 'lead', 'x')$$,
  'permission denied', 'the browser never queues a message');
rollback;
begin;
set local role anon;
select pg_temp.refused_with($$select * from public.lead_staff$$, 'permission denied', 'anon: nothing');
select pg_temp.refused_with($$select * from public.lead_notifications$$, 'permission denied', 'anon: nothing');
rollback;

-- ======================================================================================================================
-- 2. the shapes: a WhatsApp number, one active person per number and per member, departments, rules, the default
-- ======================================================================================================================
begin;
set local role service_role;
select pg_temp.refused_with($$insert into public.lead_staff (business_id, name, phone) values ('00000000-0000-0000-0000-0000000053a1', 'x', '0501234567')$$,
  'lead_staff_phone_check', 'a number is international digits (972…), not 05…');
select pg_temp.refused_with($$insert into public.lead_staff (business_id, name, phone) values ('00000000-0000-0000-0000-0000000053a1', 'x', '+972501234567')$$,
  'lead_staff_phone_check', 'digits only, no "+"');
select pg_temp.refused_with($$insert into public.lead_staff (business_id, name, phone) values ('00000000-0000-0000-0000-0000000053a1', 'x', '9725')$$,
  'lead_staff_phone_check', 'too short');
select pg_temp.refused_with($$insert into public.lead_staff (business_id, name, phone) values ('00000000-0000-0000-0000-0000000053a1', '  ', '972501230000')$$,
  'lead_staff_name_check', 'a person has a name');
select pg_temp.refused_with($$insert into public.lead_staff (business_id, name, phone) values ('00000000-0000-0000-0000-0000000053a1', 'דנה 2', '972501234567')$$,
  'lead_staff_phone_uq', 'one active person per number in a business');
insert into public.lead_staff (business_id, name, phone, active) values ('00000000-0000-0000-0000-0000000053a1', 'דנה (לשעבר)', '972501234567', false);
insert into public.lead_staff (business_id, name, phone) values ('00000000-0000-0000-0000-0000000053a2', 'דנה ב-B', '972501234567');
select pg_temp.check(true, 'the same number: once removed, or in another business');
select pg_temp.refused_with($$insert into public.lead_staff (business_id, name, phone, member_user_id) values ('00000000-0000-0000-0000-0000000053a1', 'דנה 3', '972501239999', '00000000-0000-0000-0000-000000005302')$$,
  'lead_staff_member_uq', 'one active person per member of the business');

select pg_temp.refused_with($$insert into public.lead_departments (business_id, name, staff_id) values ('00000000-0000-0000-0000-0000000053a1', ' לייזר ', '00000000-0000-0000-0000-0000000053d2')$$,
  'lead_departments_name_uq', 'one active department per name (spaces and case aside)');
select pg_temp.refused_with($$insert into public.lead_departments (business_id, name, staff_id) values ('00000000-0000-0000-0000-0000000053a1', 'פנים', '00000000-0000-0000-0000-0000000053d3')$$,
  'lead_departments_staff_fk', 'the person responsible is of the same business');
select pg_temp.refused_with($$insert into public.lead_departments (business_id, name, staff_id) values ('00000000-0000-0000-0000-0000000053a1', 'פנים', null)$$,
  'null value', 'a department has a person responsible');

select pg_temp.refused_with($$insert into public.lead_department_rules (business_id, department_id, kind, form_id) values ('00000000-0000-0000-0000-0000000053a1', '00000000-0000-0000-0000-0000000053e1', 'form', 'abc')$$,
  'lead_department_rules_shape', 'a form is recognised by its Meta id (digits)');
select pg_temp.refused_with($$insert into public.lead_department_rules (business_id, department_id, kind, question) values ('00000000-0000-0000-0000-0000000053a1', '00000000-0000-0000-0000-0000000053e1', 'answer', 'איזה טיפול?')$$,
  'lead_department_rules_shape', 'a question needs its answer');
select pg_temp.refused_with($$insert into public.lead_department_rules (business_id, department_id, kind, campaign) values ('00000000-0000-0000-0000-0000000053a1', '00000000-0000-0000-0000-0000000053e1', 'campaign', '  ')$$,
  'lead_department_rules_shape', 'a campaign needs a name or an id');
select pg_temp.refused_with($$insert into public.lead_department_rules (business_id, department_id, kind, campaign) values ('00000000-0000-0000-0000-0000000053a2', '00000000-0000-0000-0000-0000000053e1', 'campaign', 'x')$$,
  'lead_department_rules_department_fk', 'a rule belongs to a department of the same business');
select pg_temp.refused_with($$insert into public.lead_department_rules (business_id, department_id, kind, campaign) values ('00000000-0000-0000-0000-0000000053a1', '00000000-0000-0000-0000-0000000053e1', 'tag', 'x')$$,
  'lead_department_rules_kind_check', 'three kinds of rule only');
select pg_temp.refused_with($$update public.lead_routing set default_staff_id = '00000000-0000-0000-0000-0000000053d3' where business_id = '00000000-0000-0000-0000-0000000053a1'$$,
  'lead_routing_default_fk', 'the default recipient is of the same business');
rollback;

-- ======================================================================================================================
-- 3. the contact's department and person: the server's (the owner moves a lead through it), every other column as before
-- ======================================================================================================================
begin;
set local role service_role;
update public.leads set department_id = '00000000-0000-0000-0000-0000000053e1', assigned_staff_id = '00000000-0000-0000-0000-0000000053d1',
       routed_at = now(), routed_by = 'טופס: טופס לייזר'
 where id = '00000000-0000-0000-0000-0000000053c1';
update public.leads set routed_at = now(), routed_by = '', assigned_staff_id = '00000000-0000-0000-0000-0000000053d2'
 where id = '00000000-0000-0000-0000-0000000053c2'; -- no department: "ללא מחלקה", to the default recipient
select pg_temp.refused_with($$update public.leads set department_id = '00000000-0000-0000-0000-0000000053e3' where id = '00000000-0000-0000-0000-0000000053c1'$$,
  'leads_department_fk', 'a department of another business never');
select pg_temp.refused_with($$update public.leads set assigned_staff_id = '00000000-0000-0000-0000-0000000053d3' where id = '00000000-0000-0000-0000-0000000053c1'$$,
  'leads_assignee_fk', 'a person of another business never');
select pg_temp.refused_with($$update public.leads set routed_by = repeat('x', 301) where id = '00000000-0000-0000-0000-0000000053c1'$$,
  'leads_routed_by_len', 'why — short');
commit;

begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000005301');
select pg_temp.check((select department_id = '00000000-0000-0000-0000-0000000053e1' and assigned_staff_id = '00000000-0000-0000-0000-0000000053d1'
  and routed_by = 'טופס: טופס לייזר' from public.leads where id = '00000000-0000-0000-0000-0000000053c1'), 'the members read the department and the person on the contact');
select pg_temp.refused_with($$update public.leads set assigned_staff_id = '00000000-0000-0000-0000-0000000053d2' where id = '00000000-0000-0000-0000-0000000053c1'$$,
  'lead_routing_server_only', 'even the owner moves a lead only through the server');
select pg_temp.refused_with($$update public.leads set assigned_staff_id = null where id = '00000000-0000-0000-0000-0000000053c1'$$,
  'lead_routing_server_only', 'nor clears the person');
select pg_temp.refused_with($$update public.leads set department_id = null where id = '00000000-0000-0000-0000-0000000053c1'$$,
  'lead_routing_server_only', 'nor the department');
select pg_temp.refused_with($$update public.leads set routed_at = null, routed_by = '' where id = '00000000-0000-0000-0000-0000000053c1'$$,
  'lead_routing_server_only', 'nor when and why');
select pg_temp.check(pg_temp.affected($$update public.leads set name = 'נועה כהן', status = 'נוצר קשר', notes = 'התקשרתי' where id = '00000000-0000-0000-0000-0000000053c1'$$) = 1,
  'every other column of the contact: as before');
select pg_temp.check((select name = 'נועה כהן' and assigned_staff_id = '00000000-0000-0000-0000-0000000053d1' and department_id = '00000000-0000-0000-0000-0000000053e1'
  from public.leads where id = '00000000-0000-0000-0000-0000000053c1'), 'a change of the details keeps the department and the person');
-- the app's save of a contact (repo.saveLead: an upsert of the details, without the four columns)
insert into public.leads (id, user_id, business_id, name, phone, source, status, notes, date)
values ('00000000-0000-0000-0000-0000000053c1', '00000000-0000-0000-0000-000000005301', '00000000-0000-0000-0000-0000000053a1', 'נועה כ.', '050-1111111', 'Meta · טופס לייזר', 'מעוניין', '', current_date)
on conflict (id) do update set name = excluded.name, status = excluded.status;
select pg_temp.check((select name = 'נועה כ.' and assigned_staff_id = '00000000-0000-0000-0000-0000000053d1' and routed_at is not null
  from public.leads where id = '00000000-0000-0000-0000-0000000053c1'), 'the app''s upsert of a contact keeps the department and the person');
select pg_temp.refused_with($$insert into public.leads (user_id, business_id, name, assigned_staff_id) values ('00000000-0000-0000-0000-000000005301', '00000000-0000-0000-0000-0000000053a1', 'x', '00000000-0000-0000-0000-0000000053d1')$$,
  'lead_routing_server_only', 'a new contact from the browser has no person');
select pg_temp.refused_with($$insert into public.leads (user_id, business_id, name, routed_by) values ('00000000-0000-0000-0000-000000005301', '00000000-0000-0000-0000-0000000053a1', 'x', 'טופס')$$,
  'lead_routing_server_only', 'nor a reason');
select pg_temp.check(pg_temp.affected($$insert into public.leads (user_id, business_id, name, phone) values ('00000000-0000-0000-0000-000000005301', '00000000-0000-0000-0000-0000000053a1', 'חדשה', '050-5555555')$$) = 1,
  'a new contact from the browser: as before');
rollback;

begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000005302'); -- the editor, who is "דנה" of the team
select pg_temp.refused_with($$update public.leads set assigned_staff_id = '00000000-0000-0000-0000-0000000053d1' where id = '00000000-0000-0000-0000-0000000053c3'$$,
  'lead_routing_server_only', 'a member never takes a lead to themselves');
select pg_temp.check((select count(*) = 1 from public.leads where assigned_staff_id = '00000000-0000-0000-0000-0000000053d1'),
  '"הלידים שלי": the editor sees the contact of their person');
rollback;

begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000005304'); -- the owner of B
select pg_temp.check((select count(*) = 0 from public.leads where id = '00000000-0000-0000-0000-0000000053c1'), 'another business''s contacts: never');
rollback;

-- ======================================================================================================================
-- 4. the messages: once per Meta lead and person, one claimer, and they go with their contact
-- ======================================================================================================================
begin;
set local role service_role;
insert into public.lead_notifications (id, business_id, lead_id, staff_id, kind, dedupe_key, external_id, staff_name, to_phone, params) values
  ('00000000-0000-0000-0000-0000000053f1', '00000000-0000-0000-0000-0000000053a1', '00000000-0000-0000-0000-0000000053c1', '00000000-0000-0000-0000-0000000053d1',
   'lead', 'lead:m-1:00000000-0000-0000-0000-0000000053d1', 'm-1', 'דנה', '972501234567', '["לייזר","נועה","050-1111111","—","https://wa.me/972501111111"]'),
  ('00000000-0000-0000-0000-0000000053f2', '00000000-0000-0000-0000-0000000053a1', '00000000-0000-0000-0000-0000000053c2', '00000000-0000-0000-0000-0000000053d2',
   'lead', 'lead:m-2:00000000-0000-0000-0000-0000000053d2', 'm-2', 'מיכל', '15550100123', '[]');
select pg_temp.refused_with($$insert into public.lead_notifications (business_id, lead_id, staff_id, kind, dedupe_key)
  values ('00000000-0000-0000-0000-0000000053a1', '00000000-0000-0000-0000-0000000053c1', '00000000-0000-0000-0000-0000000053d1', 'lead', 'lead:m-1:00000000-0000-0000-0000-0000000053d1')$$,
  'lead_notifications_once', 'the same Meta lead is never queued twice for the same person');
select pg_temp.check(pg_temp.affected($$insert into public.lead_notifications (business_id, lead_id, staff_id, kind, dedupe_key)
  values ('00000000-0000-0000-0000-0000000053a1', '00000000-0000-0000-0000-0000000053c1', '00000000-0000-0000-0000-0000000053d2', 'move', 'move:00000000-0000-0000-0000-0000000053c1:00000000-0000-0000-0000-0000000053d2')$$) = 1,
  'moved by the owner to another person: one message to that person');
select pg_temp.refused_with($$insert into public.lead_notifications (business_id, lead_id, staff_id, kind, dedupe_key)
  values ('00000000-0000-0000-0000-0000000053a1', '00000000-0000-0000-0000-0000000053c4', '00000000-0000-0000-0000-0000000053d1', 'lead', 'lead:x:1')$$,
  'lead_notifications_lead_fk', 'a message about a contact of another business never');
select pg_temp.refused_with($$insert into public.lead_notifications (business_id, lead_id, staff_id, kind, dedupe_key)
  values ('00000000-0000-0000-0000-0000000053a1', '00000000-0000-0000-0000-0000000053c1', '00000000-0000-0000-0000-0000000053d3', 'lead', 'lead:x:2')$$,
  'lead_notifications_staff_fk', 'a message to a person of another business never');
select pg_temp.refused_with($$update public.lead_notifications set status = 'done' where id = '00000000-0000-0000-0000-0000000053f1'$$,
  'lead_notifications_status_check', 'five states only');
-- one claimer: queued → sending happens once (the server's conditional update)
select pg_temp.check(pg_temp.affected($$update public.lead_notifications set status = 'sending', attempts = 1, claimed_at = now()
  where id = '00000000-0000-0000-0000-0000000053f1' and status = 'queued'$$) = 1, 'the first claim takes the message');
select pg_temp.check(pg_temp.affected($$update public.lead_notifications set status = 'sending', attempts = 1, claimed_at = now()
  where id = '00000000-0000-0000-0000-0000000053f1' and status = 'queued'$$) = 0, 'a second claim finds nothing to take');
update public.lead_notifications set status = 'sent', wa_message_id = 'wamid.TEST', sent_at = now() where id = '00000000-0000-0000-0000-0000000053f1';
update public.lead_notifications set status = 'failed', attempts = 2, error_code = '131030',
       error = '{"code":131030,"message":"Recipient phone number not in allowed list","fbtrace_id":"A1"}' where id = '00000000-0000-0000-0000-0000000053f2';
select pg_temp.check((select error->>'code' = '131030' and error_code = '131030' from public.lead_notifications where id = '00000000-0000-0000-0000-0000000053f2'),
  'Meta''s whole error is kept');
commit;

begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000005301');
select pg_temp.check(pg_temp.affected($$delete from public.leads where id = '00000000-0000-0000-0000-0000000053c2'$$) = 1, 'the owner deletes a contact');
reset role;
select pg_temp.check((select count(*) = 0 from public.lead_notifications where lead_id = '00000000-0000-0000-0000-0000000053c2'),
  'its messages go with it (the browser has no access to them, the database removes them)');
select pg_temp.check((select count(*) = 2 from public.lead_notifications where lead_id = '00000000-0000-0000-0000-0000000053c1'), 'the other contact''s stay');
rollback;

-- ======================================================================================================================
-- 5. a person and a department are removed, never deleted: the contacts keep their names
-- ======================================================================================================================
begin;
set local role service_role;
update public.lead_departments set active = false where id = '00000000-0000-0000-0000-0000000053e1';
update public.lead_staff set active = false where id = '00000000-0000-0000-0000-0000000053d1';
select pg_temp.check((select d.name = 'לייזר' and s.name = 'דנה' from public.leads l join public.lead_departments d on d.id = l.department_id
  join public.lead_staff s on s.id = l.assigned_staff_id where l.id = '00000000-0000-0000-0000-0000000053c1'), 'a removed department and person keep their names on the contact');
insert into public.lead_departments (business_id, name, staff_id) values ('00000000-0000-0000-0000-0000000053a1', 'לייזר', '00000000-0000-0000-0000-0000000053d2');
select pg_temp.check(true, 'a department of the same name can be opened again once the old one is removed');
rollback;
