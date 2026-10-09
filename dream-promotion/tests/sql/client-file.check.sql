-- Client file (migration 20261009004100) on a real Postgres (tests/sql/run.sh), tried as the signed-in roles and the server.
-- Fixtures only, with ids of their own:
--   Clinic A  owner OA, practitioner TA (marked by OA), staff SA (editor, not marked), cashier KA (marked attempt refused),
--             viewer VA (marked: reads, never writes)           customer LA
--   Clinic B  owner OB — the other business                     customer LB
--   super admin X (member of neither)
-- Every check raises "CHECK FAILED: …" when the database does not behave.
\set ON_ERROR_STOP 1
set client_min_messages = warning;

create or replace function pg_temp.check(ok boolean, msg text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'CHECK FAILED: %', msg; end if; end $$;
create or replace function pg_temp.refused(stmt text, msg text) returns void language plpgsql as $$
begin
  execute stmt;
  raise exception 'CHECK FAILED: % (it was allowed)', msg;
exception when others then
  if sqlerrm like 'CHECK FAILED%' then raise; end if;
end $$;
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
create or replace function pg_temp.h(t text) returns text language sql as $$ select encode(sha256(convert_to(t, 'UTF8')), 'hex') $$;
-- rows of every client-file table the caller sees
create or replace function pg_temp.seen() returns int language sql as $$
  select ((select count(*) from public.client_treatments) + (select count(*) from public.client_sessions)
        + (select count(*) from public.client_photos) + (select count(*) from public.declaration_templates)
        + (select count(*) from public.declaration_requests) + (select count(*) from public.declarations)
        + (select count(*) from public.client_file_views) + (select count(*) from public.client_file_access))::int
$$;

-- ---- the world --------------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000c1a01', 'oa@clinic-a.test'), ('00000000-0000-0000-0000-0000000c1a02', 'ta@clinic-a.test'),
  ('00000000-0000-0000-0000-0000000c1a03', 'sa@clinic-a.test'), ('00000000-0000-0000-0000-0000000c1a04', 'ka@clinic-a.test'),
  ('00000000-0000-0000-0000-0000000c1a05', 'va@clinic-a.test'), ('00000000-0000-0000-0000-0000000c1b01', 'ob@clinic-b.test'),
  ('00000000-0000-0000-0000-0000000c1a0f', 'x@platform.test');
update public.profiles set is_super_admin = true where id = '00000000-0000-0000-0000-0000000c1a0f';
insert into public.businesses (id, name, slug) values
  ('00000000-0000-0000-0000-0000000c1b0a', 'Clinic A', 'clinic-a-41'), ('00000000-0000-0000-0000-0000000c1b0b', 'Clinic B', 'clinic-b-41');
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-0000000c1b0a', '00000000-0000-0000-0000-0000000c1a01', 'owner', 'full'),
  ('00000000-0000-0000-0000-0000000c1b0a', '00000000-0000-0000-0000-0000000c1a02', 'editor', 'full'),
  ('00000000-0000-0000-0000-0000000c1b0a', '00000000-0000-0000-0000-0000000c1a03', 'editor', 'full'),
  ('00000000-0000-0000-0000-0000000c1b0a', '00000000-0000-0000-0000-0000000c1a04', 'editor', 'register'),
  ('00000000-0000-0000-0000-0000000c1b0a', '00000000-0000-0000-0000-0000000c1a05', 'viewer', 'full'),
  ('00000000-0000-0000-0000-0000000c1b0b', '00000000-0000-0000-0000-0000000c1b01', 'owner', 'full');
update public.profiles set current_business_id = '00000000-0000-0000-0000-0000000c1b0a'
 where id::text like '00000000-0000-0000-0000-0000000c1a0%';
update public.profiles set current_business_id = '00000000-0000-0000-0000-0000000c1b0b'
 where id in ('00000000-0000-0000-0000-0000000c1b01', '00000000-0000-0000-0000-0000000c1a0f');
insert into public.leads (id, user_id, business_id, name, phone) values
  ('00000000-0000-0000-0000-0000000c1d0a', '00000000-0000-0000-0000-0000000c1a01', '00000000-0000-0000-0000-0000000c1b0a', 'נועה', '0501111111'),
  ('00000000-0000-0000-0000-0000000c1d0b', '00000000-0000-0000-0000-0000000c1b01', '00000000-0000-0000-0000-0000000c1b0b', 'מיכל', '0502222222');

-- ======================================================================================================================
-- 1. the bucket: private, and no browser reads or writes anything in it
-- ======================================================================================================================
select pg_temp.check((select not public from storage.buckets where id = 'client-files'), 'client-files is a private bucket');
select pg_temp.check((select file_size_limit = 15728640 from storage.buckets where id = 'client-files'), 'up to 15MB a file');
insert into storage.objects (bucket_id, name) values
  ('client-files', '00000000-0000-0000-0000-0000000c1b0a/00000000-0000-0000-0000-0000000c1d0a/p1.webp');

-- ======================================================================================================================
-- 2. who may: the owner marks a practitioner; a cashier can not be marked; only the owner marks
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000c1a02');
select pg_temp.check(not public.client_files_allowed(), 'TA before being marked: no');
select pg_temp.refused_with($$select public.client_file_set_access('00000000-0000-0000-0000-0000000c1a03', true)$$, 'not allowed',
  'a practitioner does not mark others');
select pg_temp.as_user('00000000-0000-0000-0000-0000000c1a01');
select pg_temp.check(public.client_files_allowed(), 'the owner: yes');
select public.client_file_set_access('00000000-0000-0000-0000-0000000c1a02', true);
select public.client_file_set_access('00000000-0000-0000-0000-0000000c1a05', true);
select public.client_file_set_access('00000000-0000-0000-0000-0000000c1a02', true);   -- twice: still one row
select pg_temp.refused_with($$select public.client_file_set_access('00000000-0000-0000-0000-0000000c1a04', true)$$, 'not a cashier',
  'a cashier can not be marked');
select pg_temp.refused_with($$select public.client_file_set_access('00000000-0000-0000-0000-0000000c1b01', true)$$, 'only a member',
  'a member of another business can not be marked');
select pg_temp.check((select count(*) from public.client_file_access where revoked_at is null) = 2, 'two marked (TA, VA), once each');
select pg_temp.refused($$insert into public.client_file_access (business_id, user_id) values
  ('00000000-0000-0000-0000-0000000c1b0a', '00000000-0000-0000-0000-0000000c1a03')$$, 'the marks are written only through the function');
select pg_temp.as_user('00000000-0000-0000-0000-0000000c1a02');
select pg_temp.check(public.client_files_allowed(), 'TA once marked: yes');
select pg_temp.check((select count(*) from public.client_file_access) = 0, 'TA does not read who is marked');
commit;

-- ======================================================================================================================
-- 3. the owner builds the clinic's file: types, a treatment, a session, a photo; a template, approved
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000c1a01');
insert into public.treatment_types (id, business_id, name) values
  ('00000000-0000-0000-0000-0000000c1e01', '00000000-0000-0000-0000-0000000c1b0a', 'לייזר'),
  ('00000000-0000-0000-0000-0000000c1e02', '00000000-0000-0000-0000-0000000c1b0a', 'מיצוק');
select pg_temp.refused($$insert into public.treatment_types (business_id, name) values ('00000000-0000-0000-0000-0000000c1b0a', ' לייזר ')$$,
  'a type''s name once per clinic');
insert into public.client_treatments (id, business_id, lead_id, treatment_type_id, area, title) values
  ('00000000-0000-0000-0000-0000000c1f01', '00000000-0000-0000-0000-0000000c1b0a', '00000000-0000-0000-0000-0000000c1d0a',
   '00000000-0000-0000-0000-0000000c1e01', 'רגליים', 'הסרת שיער');
insert into public.client_sessions (id, business_id, treatment_id, lead_id, params) values
  ('00000000-0000-0000-0000-0000000c1f11', '00000000-0000-0000-0000-0000000c1b0a', '00000000-0000-0000-0000-0000000c1f01',
   '00000000-0000-0000-0000-0000000c1d0a', '{"joule": 18}');
insert into public.client_photos (id, business_id, lead_id, treatment_id, session_id, stage, path, width, height) values
  ('00000000-0000-0000-0000-0000000c1f21', '00000000-0000-0000-0000-0000000c1b0a', '00000000-0000-0000-0000-0000000c1d0a',
   '00000000-0000-0000-0000-0000000c1f01', '00000000-0000-0000-0000-0000000c1f11', 'before',
   '00000000-0000-0000-0000-0000000c1b0a/00000000-0000-0000-0000-0000000c1d0a/p1.webp', 2048, 1536);
select pg_temp.check((select by_user = '00000000-0000-0000-0000-0000000c1a01' from public.client_photos), 'who took the photo is kept');
select pg_temp.refused_with($$insert into public.client_photos (business_id, lead_id, stage, path) values
  ('00000000-0000-0000-0000-0000000c1b0a', '00000000-0000-0000-0000-0000000c1d0a', 'after', '00000000-0000-0000-0000-0000000c1b0b/x/p.webp')$$,
  'client_photos_path_check', 'a photo is stored under its own business and customer');
select pg_temp.refused_with($$insert into public.client_photos (business_id, lead_id, stage, path) values
  ('00000000-0000-0000-0000-0000000c1b0a', '00000000-0000-0000-0000-0000000c1d0a', 'after',
   '00000000-0000-0000-0000-0000000c1b0a/00000000-0000-0000-0000-0000000c1d0a/../../x.webp')$$,
  'client_photos_path_check', 'no ".." in a path');
select pg_temp.refused_with($$insert into public.client_photos (business_id, lead_id, stage, path) values
  ('00000000-0000-0000-0000-0000000c1b0a', '00000000-0000-0000-0000-0000000c1d0a', 'side',
   '00000000-0000-0000-0000-0000000c1b0a/00000000-0000-0000-0000-0000000c1d0a/p9.webp')$$, 'stage', 'before / after / process only');

-- 7. marketing: no consent yet → no
select pg_temp.refused_with($$update public.client_photos set marketing_ok = true where id = '00000000-0000-0000-0000-0000000c1f21'$$,
  'did not agree', 'a photo is not for marketing without the customer''s signed consent');

-- 4. templates
insert into public.declaration_templates (id, business_id, title, treatment_type_ids, fields, acks, valid_days) values
  ('00000000-0000-0000-0000-0000000c1c01', '00000000-0000-0000-0000-0000000c1b0a', 'הצהרת לייזר', '{00000000-0000-0000-0000-0000000c1e01}',
   '[{"key": "chronic", "type": "yesno", "label": "האם חלית במחלה כרונית?", "required": true,
      "followUps": [{"key": "which", "type": "text", "label": "איזו מחלה?", "required": true}], "showFollowUpsWhen": "yes"}]',
   '["ידוע לי שתוצאות הלייזר אינן מובטחות ב-100%"]', 365),
  ('00000000-0000-0000-0000-0000000c1c02', '00000000-0000-0000-0000-0000000c1b0a', 'הצהרה כללית', '{}',
   '[{"key": "pregnant", "type": "yesno", "label": "האם את בהריון?", "required": true}]', '[]', null),
  ('00000000-0000-0000-0000-0000000c1c03', '00000000-0000-0000-0000-0000000c1b0a', 'ריקה', '{}', '[]', '[]', 30);
select pg_temp.check((select family_id = id and version = 1 and status = 'draft' from public.declaration_templates
  where id = '00000000-0000-0000-0000-0000000c1c01'), 'a new template: its own family, version 1, a draft');
select pg_temp.refused_with($$insert into public.declaration_templates (business_id, title, status) values
  ('00000000-0000-0000-0000-0000000c1b0a', 'x', 'approved')$$, 'starts as a draft', 'a template is born a draft');
select pg_temp.refused_with($$insert into public.declaration_templates (business_id, title, treatment_type_ids) values
  ('00000000-0000-0000-0000-0000000c1b0a', 'x', '{00000000-0000-0000-0000-0000000c1e99}')$$, 'unknown treatment type',
  'only the clinic''s own treatment types');
select pg_temp.refused_with($$insert into public.declaration_requests (business_id, lead_id, template_ids, token_hash) values
  ('00000000-0000-0000-0000-0000000c1b0a', '00000000-0000-0000-0000-0000000c1d0a', '{00000000-0000-0000-0000-0000000c1c01}', pg_temp.h('t0'))$$,
  'only approved', 'a draft is never sent');
select pg_temp.refused_with($$update public.declaration_templates set status = 'approved' where id = '00000000-0000-0000-0000-0000000c1c03'$$,
  'empty declaration', 'an empty template is not approved');
update public.declaration_templates set status = 'approved' where id in ('00000000-0000-0000-0000-0000000c1c01', '00000000-0000-0000-0000-0000000c1c02');
select pg_temp.check((select approved_by = '00000000-0000-0000-0000-0000000c1a01' and approved_at is not null from public.declaration_templates
  where id = '00000000-0000-0000-0000-0000000c1c01'), 'approval keeps who and when');
select pg_temp.refused_with($$update public.declaration_templates set fields = '[]' where id = '00000000-0000-0000-0000-0000000c1c01'$$,
  'new version', 'approved wording never changes');
select pg_temp.refused_with($$delete from public.declaration_templates where id = '00000000-0000-0000-0000-0000000c1c01'$$,
  'archived, never deleted', 'an approved template is not deleted');
select pg_temp.refused_with($$update public.declaration_templates set status = 'draft' where id = '00000000-0000-0000-0000-0000000c1c01'$$,
  'draft → approved → archived', 'an approved template does not go back to draft');
select pg_temp.check(pg_temp.affected($$delete from public.declaration_templates where id = '00000000-0000-0000-0000-0000000c1c03'$$) = 1,
  'a draft may be deleted');
commit;

-- ---- an edit after approval is a new version; the practitioner edits, only the owner approves ---------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000c1a02');
insert into public.declaration_templates (id, business_id, family_id, title, treatment_type_ids, fields, acks, valid_days) values
  ('00000000-0000-0000-0000-0000000c1c11', '00000000-0000-0000-0000-0000000c1b0a', '00000000-0000-0000-0000-0000000c1c01', 'הצהרת לייזר',
   '{00000000-0000-0000-0000-0000000c1e01}', '[{"key": "chronic", "type": "yesno", "label": "האם חלית במחלה כרונית?", "required": true}]',
   '["ידוע לי שתוצאות הלייזר אינן מובטחות ב-100%, ושגורמים הורמונליים עשויים להשפיע"]', 180);
select pg_temp.check((select version from public.declaration_templates where id = '00000000-0000-0000-0000-0000000c1c11') = 2, 'the edit is version 2');
select pg_temp.refused($$insert into public.declaration_templates (business_id, family_id, title) values
  ('00000000-0000-0000-0000-0000000c1b0a', '00000000-0000-0000-0000-0000000c1c01', 'עוד טיוטה')$$, 'one draft per template at a time');
select pg_temp.refused_with($$update public.declaration_templates set status = 'approved' where id = '00000000-0000-0000-0000-0000000c1c11'$$,
  'only the owner', 'a practitioner does not approve');
select pg_temp.check((select status from public.declaration_templates where id = '00000000-0000-0000-0000-0000000c1c01') = 'approved',
  'until v2 is approved, v1 is still the one sent');
commit;

-- ======================================================================================================================
-- 5. a link: approved templates, versions copied, the token as a hash only
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000c1a02');
select pg_temp.refused_with($$insert into public.declaration_requests (business_id, lead_id, template_ids, token_hash) values
  ('00000000-0000-0000-0000-0000000c1b0a', '00000000-0000-0000-0000-0000000c1d0a', '{00000000-0000-0000-0000-0000000c1c01}', 'plain-token')$$,
  'token_hash_check', 'the token is never kept as it is');
insert into public.declaration_requests (id, business_id, lead_id, template_ids, template_versions, token_hash, status) values
  ('00000000-0000-0000-0000-0000000c1a71', '00000000-0000-0000-0000-0000000c1b0a', '00000000-0000-0000-0000-0000000c1d0a',
   '{00000000-0000-0000-0000-0000000c1c02,00000000-0000-0000-0000-0000000c1c01}', '{9,9}', pg_temp.h('token-1'), 'signed');
select pg_temp.check((select template_versions = '{1,1}' and status = 'sent' and expires_at > now() + interval '6 days 23 hours'
  and expires_at <= now() + interval '7 days' from public.declaration_requests where id = '00000000-0000-0000-0000-0000000c1a71'),
  'versions from the templates, "sent", valid for 7 days — whatever the browser sent');
select pg_temp.refused_with($$update public.declaration_requests set status = 'signed' where id = '00000000-0000-0000-0000-0000000c1a71'$$,
  'not allowed', 'the business does not mark a link signed');
select pg_temp.refused_with($$update public.declaration_requests set token_hash = pg_temp.h('other') where id = '00000000-0000-0000-0000-0000000c1a71'$$,
  'does not change', 'a link''s token never changes');
insert into public.declaration_requests (id, business_id, lead_id, template_ids, token_hash) values
  ('00000000-0000-0000-0000-0000000c1a72', '00000000-0000-0000-0000-0000000c1b0a', '00000000-0000-0000-0000-0000000c1d0a',
   '{00000000-0000-0000-0000-0000000c1c01}', pg_temp.h('token-2'));
update public.declaration_requests set status = 'cancelled' where id = '00000000-0000-0000-0000-0000000c1a72';
select pg_temp.refused_with($$update public.declaration_requests set status = 'sent' where id = '00000000-0000-0000-0000-0000000c1a72'$$,
  'already cancelled', 'a cancelled link stays cancelled');
select pg_temp.refused_with($$delete from public.declaration_requests where id = '00000000-0000-0000-0000-0000000c1a72'$$,
  'whole client file', 'a link is not deleted');
commit;

-- ======================================================================================================================
-- 3. the customer signs (the server) — append-only
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000c1a01');
select pg_temp.refused($$insert into public.declarations (business_id, lead_id, request_id, template_id, template_version, signer_name,
  signature_path, pdf_path, pdf_sha256) values ('00000000-0000-0000-0000-0000000c1b0a', '00000000-0000-0000-0000-0000000c1d0a',
  '00000000-0000-0000-0000-0000000c1a71', '00000000-0000-0000-0000-0000000c1c01', 1, 'נועה כהן',
  '00000000-0000-0000-0000-0000000c1b0a/00000000-0000-0000-0000-0000000c1d0a/s.png',
  '00000000-0000-0000-0000-0000000c1b0a/00000000-0000-0000-0000-0000000c1d0a/d.pdf', repeat('a', 64))$$,
  'a declaration is not written from the browser — not even by the owner');
commit;

begin;
set local role service_role;
update public.declaration_requests set status = 'opened' where id = '00000000-0000-0000-0000-0000000c1a71';
select pg_temp.refused_with($$update public.declaration_requests set status = 'signed' where id = '00000000-0000-0000-0000-0000000c1a71'$$,
  'not every declaration', 'a link is signed only when every declaration in it is');
insert into public.declarations (id, business_id, lead_id, request_id, template_id, template_version, answers, acks, signer_name,
  signature_path, pdf_path, pdf_sha256, ip, user_agent, marketing_ok, signed_at) values
  ('00000000-0000-0000-0000-0000000c1d71', '00000000-0000-0000-0000-0000000c1b0a', '00000000-0000-0000-0000-0000000c1d0a',
   '00000000-0000-0000-0000-0000000c1a71', '00000000-0000-0000-0000-0000000c1c01', 7, '{"chronic": "no"}', '[true]', 'נועה כהן',
   '00000000-0000-0000-0000-0000000c1b0a/00000000-0000-0000-0000-0000000c1d0a/s1.png',
   '00000000-0000-0000-0000-0000000c1b0a/00000000-0000-0000-0000-0000000c1d0a/d1.pdf', repeat('a', 64), '10.0.0.1', 'test', true,
   '2020-01-01');
select pg_temp.check((select template_version = 1 and signed_at > now() - interval '1 minute' and valid_until = public.il_today() + 365
  from public.declarations where id = '00000000-0000-0000-0000-0000000c1d71'),
  'the version sent, the server''s clock and the template''s validity (not what the caller sent)');
select pg_temp.refused($$insert into public.declarations (business_id, lead_id, request_id, template_id, template_version, signer_name,
  signature_path, pdf_path, pdf_sha256) values ('00000000-0000-0000-0000-0000000c1b0a', '00000000-0000-0000-0000-0000000c1d0a',
  '00000000-0000-0000-0000-0000000c1a71', '00000000-0000-0000-0000-0000000c1c01', 1, 'נועה כהן',
  '00000000-0000-0000-0000-0000000c1b0a/00000000-0000-0000-0000-0000000c1d0a/s2.png',
  '00000000-0000-0000-0000-0000000c1b0a/00000000-0000-0000-0000-0000000c1d0a/d2.pdf', repeat('b', 64))$$,
  'a second signature of the same template on the same link');
select pg_temp.refused_with($$insert into public.declarations (business_id, lead_id, request_id, template_id, template_version, signer_name,
  signature_path, pdf_path, pdf_sha256) values ('00000000-0000-0000-0000-0000000c1b0a', '00000000-0000-0000-0000-0000000c1d0a',
  '00000000-0000-0000-0000-0000000c1a72', '00000000-0000-0000-0000-0000000c1c01', 1, 'נועה כהן',
  '00000000-0000-0000-0000-0000000c1b0a/00000000-0000-0000-0000-0000000c1d0a/s3.png',
  '00000000-0000-0000-0000-0000000c1b0a/00000000-0000-0000-0000-0000000c1d0a/d3.pdf', repeat('c', 64))$$,
  'no longer valid', 'a cancelled link is not signed');
insert into public.declarations (business_id, lead_id, request_id, template_id, template_version, signer_name,
  signature_path, pdf_path, pdf_sha256) values ('00000000-0000-0000-0000-0000000c1b0a', '00000000-0000-0000-0000-0000000c1d0a',
  '00000000-0000-0000-0000-0000000c1a71', '00000000-0000-0000-0000-0000000c1c02', 1, 'נועה כהן',
  '00000000-0000-0000-0000-0000000c1b0a/00000000-0000-0000-0000-0000000c1d0a/s4.png',
  '00000000-0000-0000-0000-0000000c1b0a/00000000-0000-0000-0000-0000000c1d0a/d4.pdf', repeat('d', 64));
select pg_temp.check((select valid_until is null from public.declarations where template_id = '00000000-0000-0000-0000-0000000c1c02'),
  'a template without validity: no expiry');
update public.declaration_requests set status = 'signed' where id = '00000000-0000-0000-0000-0000000c1a71';
select pg_temp.refused_with($$insert into public.declarations (business_id, lead_id, request_id, template_id, template_version, signer_name,
  signature_path, pdf_path, pdf_sha256) values ('00000000-0000-0000-0000-0000000c1b0a', '00000000-0000-0000-0000-0000000c1d0a',
  '00000000-0000-0000-0000-0000000c1a71', '00000000-0000-0000-0000-0000000c1c01', 1, 'נועה כהן',
  '00000000-0000-0000-0000-0000000c1b0a/00000000-0000-0000-0000-0000000c1d0a/s5.png',
  '00000000-0000-0000-0000-0000000c1b0a/00000000-0000-0000-0000-0000000c1d0a/d5.pdf', repeat('e', 64))$$,
  'no longer valid', 'a signed link is not signed again');
select pg_temp.refused_with($$update public.declaration_requests set status = 'opened' where id = '00000000-0000-0000-0000-0000000c1a71'$$,
  'already signed', 'a signed link stays signed');
-- append-only: not the server, not the database owner
select pg_temp.refused_with($$update public.declarations set answers = '{"chronic": "yes"}' where id = '00000000-0000-0000-0000-0000000c1d71'$$,
  'never changed', 'the server does not change a signed declaration');
select pg_temp.refused_with($$delete from public.declarations where id = '00000000-0000-0000-0000-0000000c1d71'$$,
  'whole client file', 'the server does not delete a declaration');
commit;
select pg_temp.refused_with($$update public.declarations set signer_name = 'אחר' where id = '00000000-0000-0000-0000-0000000c1d71'$$,
  'never changed', 'not even the database owner changes a declaration');
select pg_temp.refused_with($$delete from public.declarations where id = '00000000-0000-0000-0000-0000000c1d71'$$,
  'whole client file', 'not even the database owner deletes one row of the file');

-- an expired link: refused
begin;
set local role service_role;
insert into public.declaration_requests (id, business_id, lead_id, template_ids, token_hash) values
  ('00000000-0000-0000-0000-0000000c1a73', '00000000-0000-0000-0000-0000000c1b0a', '00000000-0000-0000-0000-0000000c1d0a',
   '{00000000-0000-0000-0000-0000000c1c02}', pg_temp.h('token-3'));
commit;
alter table public.declaration_requests disable trigger b_declaration_requests_check;
update public.declaration_requests set expires_at = now() - interval '1 minute' where id = '00000000-0000-0000-0000-0000000c1a73';
alter table public.declaration_requests enable trigger b_declaration_requests_check;
begin;
set local role service_role;
select pg_temp.refused_with($$insert into public.declarations (business_id, lead_id, request_id, template_id, template_version, signer_name,
  signature_path, pdf_path, pdf_sha256) values ('00000000-0000-0000-0000-0000000c1b0a', '00000000-0000-0000-0000-0000000c1d0a',
  '00000000-0000-0000-0000-0000000c1a73', '00000000-0000-0000-0000-0000000c1c02', 1, 'נועה כהן',
  '00000000-0000-0000-0000-0000000c1b0a/00000000-0000-0000-0000-0000000c1d0a/s6.png',
  '00000000-0000-0000-0000-0000000c1b0a/00000000-0000-0000-0000-0000000c1d0a/d6.pdf', repeat('f', 64))$$,
  'expired', 'an expired link is not signed');
update public.declaration_requests set status = 'expired' where id = '00000000-0000-0000-0000-0000000c1a73';
commit;

-- ---- marketing: now the customer agreed (in the signed declaration) ------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000c1a02');
update public.client_photos set marketing_ok = true where id = '00000000-0000-0000-0000-0000000c1f21';
select pg_temp.refused_with($$update public.client_photos set path = '00000000-0000-0000-0000-0000000c1b0a/00000000-0000-0000-0000-0000000c1d0a/other.webp'
  where id = '00000000-0000-0000-0000-0000000c1f21'$$, 'stays with its file', 'a photo''s file does not move');
select pg_temp.refused_with($$delete from public.client_photos where id = '00000000-0000-0000-0000-0000000c1f21'$$,
  'whole client file', 'a photo is not deleted alone');
-- the owner approves v2: v1 is archived; the declaration signed on v1 keeps v1
select pg_temp.as_user('00000000-0000-0000-0000-0000000c1a01');
update public.declaration_templates set status = 'approved' where id = '00000000-0000-0000-0000-0000000c1c11';
select pg_temp.check((select status from public.declaration_templates where id = '00000000-0000-0000-0000-0000000c1c01') = 'archived'
  and (select archived_at is not null from public.declaration_templates where id = '00000000-0000-0000-0000-0000000c1c01'),
  'approving v2 archives v1');
select pg_temp.check((select template_id = '00000000-0000-0000-0000-0000000c1c01' and template_version = 1 from public.declarations
  where id = '00000000-0000-0000-0000-0000000c1d71'), 'the signed declaration still points at v1');
select pg_temp.refused_with($$update public.declaration_templates set status = 'approved' where id = '00000000-0000-0000-0000-0000000c1c01'$$,
  'draft → approved → archived', 'an archived template does not come back');
commit;

-- ======================================================================================================================
-- 6. the view log
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000c1a02');
select pg_temp.check(public.client_file_view('photo', '00000000-0000-0000-0000-0000000c1f21') = '00000000-0000-0000-0000-0000000c1d0a',
  'TA opens the photo: logged, the customer returned');
select pg_temp.check(public.client_file_view('declaration', '00000000-0000-0000-0000-0000000c1d71') = '00000000-0000-0000-0000-0000000c1d0a',
  'TA opens the declaration: logged');
select pg_temp.refused_with($$select public.client_file_view('photo', '00000000-0000-0000-0000-0000000c1f99')$$, 'not allowed', 'no such photo');
select pg_temp.check((select count(*) from public.client_file_views) = 0, 'a practitioner does not read the log');
select pg_temp.refused($$insert into public.client_file_views (business_id, user_id, lead_id, object, object_id) values
  ('00000000-0000-0000-0000-0000000c1b0a', '00000000-0000-0000-0000-0000000c1a02', '00000000-0000-0000-0000-0000000c1d0a', 'photo',
   '00000000-0000-0000-0000-0000000c1f21')$$, 'the log is written only through the functions');
select pg_temp.as_user('00000000-0000-0000-0000-0000000c1a01');
select pg_temp.check((select count(*) from public.client_file_views where user_id = '00000000-0000-0000-0000-0000000c1a02'
  and lead_id = '00000000-0000-0000-0000-0000000c1d0a' and action = 'view' and at > now() - interval '1 minute') = 2,
  'the owner reads the log: who, what, when');
select pg_temp.check(pg_temp.affected($$update public.client_file_views set at = now() - interval '1 year'$$) = 0, 'the owner does not change the log');
commit;
begin;
set local role service_role;
select pg_temp.check(public.client_file_log_view('00000000-0000-0000-0000-0000000c1a01', '00000000-0000-0000-0000-0000000c1b0a', 'photo',
  '00000000-0000-0000-0000-0000000c1f21') = '00000000-0000-0000-0000-0000000c1d0a', 'the server logs the owner''s view before a signed URL');
select pg_temp.refused_with($$select public.client_file_log_view('00000000-0000-0000-0000-0000000c1a04', '00000000-0000-0000-0000-0000000c1b0a',
  'photo', '00000000-0000-0000-0000-0000000c1f21')$$, 'not allowed', 'the server refuses a cashier''s view');
select pg_temp.refused_with($$select public.client_file_log_view('00000000-0000-0000-0000-0000000c1b01', '00000000-0000-0000-0000-0000000c1b0b',
  'photo', '00000000-0000-0000-0000-0000000c1f21')$$, 'not allowed', 'the server refuses B''s owner A''s photo (same answer as "no such photo")');
select pg_temp.refused_with($$update public.client_file_views set at = now()$$, 'never changed', 'the server does not change the log');
select pg_temp.refused_with($$delete from public.client_file_views$$, 'never changed', 'the server does not delete the log');
commit;

-- ======================================================================================================================
-- 1. who sees what: the cashier, the unmarked staff, the viewer, the other business, the super admin, anon
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000c1a04');   -- cashier
select pg_temp.check(not public.client_files_allowed(), 'cashier: no');
select pg_temp.check(pg_temp.seen() = 0, 'the cashier sees no treatment, photo, declaration, link, template or log');
select pg_temp.check((select count(*) from public.treatment_types) = 2, 'the cashier sees the names of the treatment types (booking)');
select pg_temp.refused_with($$insert into public.treatment_types (business_id, name) values ('00000000-0000-0000-0000-0000000c1b0a', 'קרבון')$$,
  'not allowed', 'the cashier does not add a treatment type');
select pg_temp.refused_with($$select public.client_file_view('photo', '00000000-0000-0000-0000-0000000c1f21')$$, 'not allowed', 'the cashier opens no photo');
select pg_temp.check(pg_temp.affected($$update public.client_photos set stage = 'after'$$) = 0, 'the cashier changes no photo');

select pg_temp.as_user('00000000-0000-0000-0000-0000000c1a03');   -- staff, not marked
select pg_temp.check(pg_temp.seen() = 0, 'staff the owner did not mark see nothing');
select pg_temp.refused_with($$insert into public.client_treatments (business_id, lead_id) values
  ('00000000-0000-0000-0000-0000000c1b0a', '00000000-0000-0000-0000-0000000c1d0a')$$, 'not allowed', 'and write nothing');

select pg_temp.as_user('00000000-0000-0000-0000-0000000c1a05');   -- viewer, marked
select pg_temp.check((select count(*) from public.client_photos) = 1 and (select count(*) from public.declarations) = 2, 'a marked viewer reads');
select pg_temp.refused($$insert into public.client_treatments (business_id, lead_id) values
  ('00000000-0000-0000-0000-0000000c1b0a', '00000000-0000-0000-0000-0000000c1d0a')$$, 'and never writes');
select pg_temp.check(pg_temp.affected($$update public.client_treatments set notes = 'x'$$) = 0, 'a viewer changes nothing');

select pg_temp.as_user('00000000-0000-0000-0000-0000000c1b01');   -- the other business's owner
select pg_temp.check(public.client_files_allowed(), 'B''s owner has a client file of her own');
select pg_temp.check(pg_temp.seen() = 0 and (select count(*) from public.treatment_types) = 0, 'another business sees nothing of A');
select pg_temp.check(pg_temp.affected($$update public.client_photos set marketing_ok = false$$) = 0
  and pg_temp.affected($$delete from public.declaration_templates$$) = 0, 'and changes nothing of A');
select pg_temp.refused_with($$insert into public.client_treatments (business_id, lead_id) values
  ('00000000-0000-0000-0000-0000000c1b0a', '00000000-0000-0000-0000-0000000c1d0a')$$, 'not allowed', 'B writes nothing into A');
select pg_temp.refused_with($$insert into public.client_treatments (business_id, lead_id) values
  ('00000000-0000-0000-0000-0000000c1b0b', '00000000-0000-0000-0000-0000000c1d0a')$$, 'foreign key', 'B hangs nothing on A''s customer');
insert into public.client_treatments (business_id, lead_id, title) values
  ('00000000-0000-0000-0000-0000000c1b0b', '00000000-0000-0000-0000-0000000c1d0b', 'מיקרובליידינג');
select pg_temp.refused_with($$insert into public.client_sessions (business_id, treatment_id, lead_id) values
  ('00000000-0000-0000-0000-0000000c1b0b', '00000000-0000-0000-0000-0000000c1f01', '00000000-0000-0000-0000-0000000c1d0b')$$, 'foreign key',
  'B hangs nothing on A''s treatment');
select pg_temp.refused_with($$insert into public.declaration_requests (business_id, lead_id, template_ids, token_hash) values
  ('00000000-0000-0000-0000-0000000c1b0b', '00000000-0000-0000-0000-0000000c1d0b', '{00000000-0000-0000-0000-0000000c1c11}', pg_temp.h('b'))$$,
  'only approved', 'B sends no template of A (the same answer as a draft)');

select pg_temp.as_user('00000000-0000-0000-0000-0000000c1a0f');   -- super admin, not a member
select pg_temp.check(not public.client_files_allowed() and pg_temp.seen() = 0, 'the super admin, not a member, sees no client file');
commit;

begin;
set local role anon;
select pg_temp.refused($$select count(*) from public.client_photos$$, 'anon reads no table of the client file');
select pg_temp.refused($$select count(*) from public.declarations$$, 'anon reads no declaration');
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'client-files') = 0, 'anon sees no file');
commit;

-- storage: not even the owner, in her own folder, from the browser
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000c1a01');
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'client-files') = 0, 'the browser lists no file (server only)');
select pg_temp.refused($$insert into storage.objects (bucket_id, name) values
  ('client-files', '00000000-0000-0000-0000-0000000c1b0a/00000000-0000-0000-0000-0000000c1d0a/p2.webp')$$, 'the browser uploads nothing (EXIF is removed on the server)');
select pg_temp.check(pg_temp.affected($$delete from storage.objects where bucket_id = 'client-files'$$) = 0, 'the browser removes nothing');
commit;

-- a marked member who later becomes a cashier (the platform changes the membership) sees nothing from then
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000c1a01');
select public.client_file_set_access('00000000-0000-0000-0000-0000000c1a03', true);
select pg_temp.as_user('00000000-0000-0000-0000-0000000c1a03');
select pg_temp.check(public.client_files_allowed() and pg_temp.seen() > 0, 'SA once marked: sees the file');
commit;
update public.business_members set access = 'register'
 where business_id = '00000000-0000-0000-0000-0000000c1b0a' and user_id = '00000000-0000-0000-0000-0000000c1a03';
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000c1a03');
select pg_temp.check(not public.client_files_allowed() and pg_temp.seen() = 0, 'marked, then made a cashier: sees nothing');
commit;
begin;
set local role service_role;
select pg_temp.refused_with($$select public.client_file_log_view('00000000-0000-0000-0000-0000000c1a03', '00000000-0000-0000-0000-0000000c1b0a',
  'photo', '00000000-0000-0000-0000-0000000c1f21')$$, 'not allowed', 'nor through the server');
commit;

-- the block on client-files holds even if some other bucket's policy were written too widely
begin;
create policy client_file_test_wide on storage.objects for all to authenticated using (true) with check (true);
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000c1a01');
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'client-files') = 0, 'a wide policy elsewhere: still no file listed');
select pg_temp.refused($$insert into storage.objects (bucket_id, name) values
  ('client-files', '00000000-0000-0000-0000-0000000c1b0a/00000000-0000-0000-0000-0000000c1d0a/p3.webp')$$, 'a wide policy elsewhere: still no upload');
rollback;

-- the owner unmarks TA: from now TA sees nothing (the mark is kept, revoked)
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000c1a01');
select public.client_file_set_access('00000000-0000-0000-0000-0000000c1a02', false);
select pg_temp.as_user('00000000-0000-0000-0000-0000000c1a02');
select pg_temp.check(not public.client_files_allowed() and pg_temp.seen() = 0, 'unmarked: TA sees nothing');
commit;
select pg_temp.check((select count(*) from public.client_file_access where user_id = '00000000-0000-0000-0000-0000000c1a02' and revoked_at is not null) = 1,
  'the revoked mark is kept');

-- ======================================================================================================================
-- deletion of a whole client file, on the customer's request: the owner only, through the server
-- ======================================================================================================================
begin;
set local role service_role;
select pg_temp.refused_with($$select public.client_file_purge('00000000-0000-0000-0000-0000000c1a02', '00000000-0000-0000-0000-0000000c1b0a',
  '00000000-0000-0000-0000-0000000c1d0a')$$, 'not allowed', 'a practitioner does not delete a client file');
select pg_temp.refused_with($$select public.client_file_purge('00000000-0000-0000-0000-0000000c1b01', '00000000-0000-0000-0000-0000000c1b0b',
  '00000000-0000-0000-0000-0000000c1d0a')$$, 'not allowed', 'B''s owner does not delete A''s customer');
create temp table purged as select public.client_file_purge('00000000-0000-0000-0000-0000000c1a01', '00000000-0000-0000-0000-0000000c1b0a',
  '00000000-0000-0000-0000-0000000c1d0a') as r;
select pg_temp.check((select jsonb_array_length(r->'paths') = 5 from purged), 'the files to remove: a photo, 2 signatures, 2 PDFs');
select pg_temp.check((select r->'counts' = '{"photos": 1, "declarations": 2, "treatments": 1}' from purged), 'what was deleted, counted');
select pg_temp.check(not exists (select 1 from public.client_photos where lead_id = '00000000-0000-0000-0000-0000000c1d0a')
  and not exists (select 1 from public.declarations where lead_id = '00000000-0000-0000-0000-0000000c1d0a')
  and not exists (select 1 from public.declaration_requests where lead_id = '00000000-0000-0000-0000-0000000c1d0a')
  and not exists (select 1 from public.client_sessions where lead_id = '00000000-0000-0000-0000-0000000c1d0a')
  and not exists (select 1 from public.client_treatments where lead_id = '00000000-0000-0000-0000-0000000c1d0a'), 'the whole file is gone');
select pg_temp.check((select count(*) from public.client_file_views where lead_id = '00000000-0000-0000-0000-0000000c1d0a'
  and action = 'purge' and object = 'client_file' and user_id = '00000000-0000-0000-0000-0000000c1a01') = 1, 'the purge is in the log');
select pg_temp.check((select count(*) from public.client_file_views where lead_id = '00000000-0000-0000-0000-0000000c1d0a' and action = 'view') = 3,
  'the earlier views stay in the log');
select pg_temp.check((select count(*) from public.declaration_templates where business_id = '00000000-0000-0000-0000-0000000c1b0a') = 3,
  'the clinic''s templates stay (they are the business''s, not the customer''s)');
select pg_temp.check(exists (select 1 from public.client_treatments where business_id = '00000000-0000-0000-0000-0000000c1b0b'), 'B''s file untouched');
select pg_temp.check(coalesce(current_setting('dream.client_file_purge', true), '') = '', 'the purge mark does not outlive the purge');
select pg_temp.refused_with($$delete from public.client_treatments$$, 'whole client file', 'after the purge: still no deleting one by one');
commit;

-- a client file holds its customer: the lead is not deleted from under it
select pg_temp.refused_with($$delete from public.leads where id = '00000000-0000-0000-0000-0000000c1d0b'$$, 'foreign key',
  'a customer with a client file is not deleted (the owner deletes the file first)');
-- the functions are not for the browser
select pg_temp.check(not has_function_privilege('authenticated', 'public.client_file_purge(uuid, uuid, uuid)', 'execute'), 'purge: the server only');
select pg_temp.check(not has_function_privilege('authenticated', 'public.client_file_log_view(uuid, uuid, text, uuid)', 'execute'), 'log_view: the server only');
select pg_temp.check(not has_function_privilege('authenticated', 'public.client_files_allowed_for(uuid, uuid)', 'execute'), 'allowed_for: the server only');
select pg_temp.check(not has_function_privilege('anon', 'public.client_file_view(text, uuid)', 'execute'), 'anon logs nothing');

