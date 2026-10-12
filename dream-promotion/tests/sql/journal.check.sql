-- Manual journal entries, one-sided (T13א) — migration 20261011005100, docs/FINANCE_ADDITIONS_HE.md — on a real Postgres
-- (tests/sql/run.sh). The screens' calls run as the signed-in roles. Fixtures only, with ids of their own:
--   Clinic JA (a company, VAT 18%)  owner OA, OL (an owner limited to the branch L2), EA (editor, full access), VA (viewer),
--                                   KA (cashier); a branch L2; the customer card Dana; a tax invoice to Dana; a paid expense.
--   Shop JB (an exempt dealer)      owner OB — a second business: nothing of the first, and no VAT.
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
create or replace function pg_temp.as_user(uid text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', uid, true), set_config('request.jwt.claim.role', 'authenticated', true);
$$;
-- an entry as the screen sends it (the id: e51e + its two digits)
create or replace function pg_temp.je(p_n int, p_date date, p_kind text, p_amount numeric, p_vat numeric, p_side text default null,
                                      p_cat text default null, p_expl text default 'תיקון לפי רואה החשבון', p_loc uuid default null, p_party jsonb default null)
returns jsonb language sql as $$
  select public.journal_entry_create(('00000000-0000-0000-0000-000000e51e' || lpad(p_n::text, 2, '0'))::uuid, p_date, p_kind, p_amount, p_vat, p_side,
                                     p_cat, p_expl, p_loc, p_party) $$;
create or replace function pg_temp.jid(p_n int) returns uuid language sql as $$ select ('00000000-0000-0000-0000-000000e51e' || lpad(p_n::text, 2, '0'))::uuid $$;

-- ---- the world ------------------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000e51a01', 'oa@journal-a.test'), ('00000000-0000-0000-0000-000000e51a02', 'ol@journal-a.test'),
  ('00000000-0000-0000-0000-000000e51a03', 'ea@journal-a.test'), ('00000000-0000-0000-0000-000000e51a04', 'va@journal-a.test'),
  ('00000000-0000-0000-0000-000000e51a05', 'ka@journal-a.test'), ('00000000-0000-0000-0000-000000e51a06', 'ob@journal-b.test');
insert into public.businesses (id, name, slug) values ('00000000-0000-0000-0000-000000e51b01', 'Clinic JA', 'journal-clinic-a'),
  ('00000000-0000-0000-0000-000000e51b02', 'Shop JB', 'journal-shop-b');
insert into public.business_members (business_id, user_id, role, access) values
  ('00000000-0000-0000-0000-000000e51b01', '00000000-0000-0000-0000-000000e51a01', 'owner', 'full'),
  ('00000000-0000-0000-0000-000000e51b01', '00000000-0000-0000-0000-000000e51a02', 'owner', 'full'),
  ('00000000-0000-0000-0000-000000e51b01', '00000000-0000-0000-0000-000000e51a03', 'editor', 'full'),
  ('00000000-0000-0000-0000-000000e51b01', '00000000-0000-0000-0000-000000e51a04', 'viewer', 'full'),
  ('00000000-0000-0000-0000-000000e51b01', '00000000-0000-0000-0000-000000e51a05', 'editor', 'register'),
  ('00000000-0000-0000-0000-000000e51b02', '00000000-0000-0000-0000-000000e51a06', 'owner', 'full');
update public.profiles set current_business_id = '00000000-0000-0000-0000-000000e51b01'
 where id in ('00000000-0000-0000-0000-000000e51a01', '00000000-0000-0000-0000-000000e51a02', '00000000-0000-0000-0000-000000e51a03',
              '00000000-0000-0000-0000-000000e51a04', '00000000-0000-0000-0000-000000e51a05');
update public.profiles set current_business_id = '00000000-0000-0000-0000-000000e51b02' where id = '00000000-0000-0000-0000-000000e51a06';
insert into public.register_settings (user_id, business_id, business_type, vat_rate, dealer_number, legal_name, street, city, entity_type) values
  ('00000000-0000-0000-0000-000000e51a01', '00000000-0000-0000-0000-000000e51b01', 'licensed', 18, '514000004', 'קליניקה א׳ בע"מ', 'הרצל', 'תל אביב', 'company'),
  ('00000000-0000-0000-0000-000000e51a06', '00000000-0000-0000-0000-000000e51b02', 'exempt', 0, '123456782', 'חנות ב׳', 'הגפן', 'חיפה', 'exempt_dealer');
insert into public.business_locations (id, business_id, name, kind, sort) values
  ('00000000-0000-0000-0000-000000e51c01', '00000000-0000-0000-0000-000000e51b01', 'סניף צפון', 'clinic', 1),
  ('00000000-0000-0000-0000-000000e51c02', '00000000-0000-0000-0000-000000e51b01', 'סניף שנסגר', 'clinic', 2);
update public.business_locations set active = false where id = '00000000-0000-0000-0000-000000e51c02';
update public.business_members set locations = array['00000000-0000-0000-0000-000000e51c01'::uuid]
 where business_id = '00000000-0000-0000-0000-000000e51b01' and user_id = '00000000-0000-0000-0000-000000e51a02';
insert into public.leads (id, user_id, business_id, name, phone) values
  ('00000000-0000-0000-0000-000000e51d01', '00000000-0000-0000-0000-000000e51a01', '00000000-0000-0000-0000-000000e51b01', 'דנה', '0501234567'),
  ('00000000-0000-0000-0000-000000e51d02', '00000000-0000-0000-0000-000000e51a06', '00000000-0000-0000-0000-000000e51b02', 'יוסי', '0507654321');
-- a tax invoice to Dana (1,000 + 180 VAT, not paid) and a paid expense from a supplier (500 + 90)
insert into public.documents (user_id, doc_type, doc_number, doc_date, customer_name, lead_id, before_discount, discount, after_discount, vat_amount, total,
                              vat_rate, idempotency_key, lines, payments)
values ('00000000-0000-0000-0000-000000e51a01', 305, 0, public.il_today(), 'דנה', '00000000-0000-0000-0000-000000e51d01', 1000, 0, 1000, 180, 1180, 18, 'j-i1',
        '[{"name": "טיפול", "qty": 1, "unitPriceExVat": 1000, "discountExVat": 0, "totalExVat": 1000, "vatRate": 18, "kind": 1}]', '[]');
insert into public.expenses (id, user_id, supplier_name, supplier_dealer, doc_date, supplier_doc_type, amount_before_vat, vat_amount, total, category, paid_on, payment_method)
values ('00000000-0000-0000-0000-000000e51f01', '00000000-0000-0000-0000-000000e51a01', 'ספק ציוד', '512345678', public.il_today(), 'tax_invoice', 500, 90, 590,
        'supplies', public.il_today(), 'transfer');

create temp table jout (who text, j jsonb);
grant all on jout to authenticated;
create or replace function pg_temp.r(p_who text) returns jsonb language sql as $$ select j from jout where who = p_who $$;

-- ======================================================================================================================
-- 1. who records an entry: the business's owners (every location) — not an owner limited to a branch, an editor, a viewer or a
--    cashier; and a business sees only its own
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e51a01');
select pg_temp.check(public.journal_writer(), 'the owner records entries');
select pg_temp.as_user('00000000-0000-0000-0000-000000e51a02');
select pg_temp.check(not public.journal_writer(), 'an owner limited to a branch does not');
select pg_temp.refused_with($$select pg_temp.je(90, public.il_today(), 'income', 10, 0)$$, 'journal_not_allowed', 'the branch''s manager records nothing');
select pg_temp.as_user('00000000-0000-0000-0000-000000e51a03');
select pg_temp.refused_with($$select pg_temp.je(90, public.il_today(), 'income', 10, 0)$$, 'journal_not_allowed', 'an editor records nothing');
select pg_temp.as_user('00000000-0000-0000-0000-000000e51a04');
select pg_temp.refused_with($$select pg_temp.je(90, public.il_today(), 'income', 10, 0)$$, 'journal_not_allowed', 'a viewer records nothing');
select pg_temp.as_user('00000000-0000-0000-0000-000000e51a05');
select pg_temp.refused_with($$select pg_temp.je(90, public.il_today(), 'income', 10, 0)$$, 'not allowed', 'nor a cashier');
commit;
begin;
set local role anon;
select pg_temp.refused_with($$select public.journal_writer()$$, 'permission denied', 'nobody signed out');
commit;

-- ======================================================================================================================
-- 2. what an entry may not be
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e51a01');
select pg_temp.refused_with($$select pg_temp.je(90, public.il_today() + 1, 'income', 10, 0)$$, 'journal_date', 'an entry of tomorrow');
select pg_temp.refused_with($$select pg_temp.je(90, null, 'income', 10, 0)$$, 'journal_date', 'an entry without a date');
select pg_temp.refused_with($$select pg_temp.je(90, public.il_today(), 'loan', 10, 0)$$, 'journal_kind', 'a kind that is not one');
select pg_temp.refused_with($$select pg_temp.je(90, public.il_today(), 'income', 0, 0)$$, 'journal_amount', 'nothing to record');
select pg_temp.refused_with($$select pg_temp.je(90, public.il_today(), 'income', 10.555, 0)$$, 'journal_amount', 'agorot only');
select pg_temp.refused_with($$select pg_temp.je(90, public.il_today(), 'income', 200000000, 0)$$, 'journal_amount', 'a sum beyond any business');
select pg_temp.refused_with($$select pg_temp.je(90, public.il_today(), 'vat', 100, 18, 'output')$$, 'journal_vat', 'a VAT entry is VAT only');
select pg_temp.refused_with($$select pg_temp.je(90, public.il_today(), 'vat', 0, 18)$$, 'journal_vat_side', 'a VAT entry says on sales or on inputs');
select pg_temp.refused_with($$select pg_temp.je(90, public.il_today(), 'vat', 0, 18, 'both')$$, 'journal_vat_side', 'and only those');
select pg_temp.refused_with($$select pg_temp.je(90, public.il_today(), 'other', 100, 18)$$, 'journal_vat', 'an "other" entry has no VAT');
select pg_temp.refused_with($$select pg_temp.je(90, public.il_today(), 'expense', 100, 0, null, 'Not A Kind')$$, 'journal_category', 'an expense''s kind is a kind');
select pg_temp.refused_with($$select pg_temp.je(90, public.il_today(), 'income', 10, 0, null, null, ' x ')$$, 'journal_explanation', 'an explanation is required');
select pg_temp.refused_with($$select pg_temp.je(90, public.il_today(), 'income', 10, 0, null, null, repeat('א', 501))$$, 'journal_explanation', 'and not a book');
select pg_temp.refused_with($$select pg_temp.je(90, public.il_today(), 'expense', 10, 0, null, 'other', 'הוצאה', null, '{"kind": "customer", "name": "דנה"}')$$,
  'journal_party', 'an expense belongs to a supplier, not a customer');
select pg_temp.refused_with($$select pg_temp.je(90, public.il_today(), 'income', 10, 0, null, null, 'הכנסה', null, '{"kind": "supplier", "name": "ספק"}')$$,
  'journal_party', 'income belongs to a customer, not a supplier');
select pg_temp.refused_with($$select pg_temp.je(90, public.il_today(), 'vat', 0, 5, 'output', null, 'מע״מ', null, '{"kind": "customer", "name": "דנה"}')$$,
  'journal_party', 'a VAT entry belongs to nobody');
select pg_temp.refused_with($$select pg_temp.je(90, public.il_today(), 'income', 10, 0, null, null, 'הכנסה', null, '{"kind": "customer", "leadId": "00000000-0000-0000-0000-000000e51d02"}')$$,
  'journal_party', 'another business''s customer card');
select pg_temp.refused_with($$select pg_temp.je(90, public.il_today(), 'income', 10, 0, null, null, 'הכנסה', null, '{"kind": "customer", "leadId": "nope"}')$$,
  'journal_party', 'a card that is not an id');
select pg_temp.refused_with($$select pg_temp.je(90, public.il_today(), 'income', 10, 0, null, null, 'הכנסה', null, '{"kind": "customer", "name": "דנה", "dealer": "12345678"}')$$,
  'journal_party', 'a dealer number has 9 digits');
select pg_temp.refused_with($$select pg_temp.je(90, public.il_today(), 'other', 10, 0, null, null, 'אחר', null, '{"kind": "supplier", "name": " "}')$$,
  'journal_party', 'a supplier with no name or number');
select pg_temp.refused_with($$select pg_temp.je(90, public.il_today(), 'income', 10, 0, null, null, 'הכנסה', '00000000-0000-0000-0000-000000e51c02')$$,
  'journal_location', 'a closed location');
select pg_temp.refused_with($$select pg_temp.je(90, public.il_today(), 'income', 10, 0, null, null, 'הכנסה', '00000000-0000-0000-0000-000000e51b02')$$,
  'journal_location', 'another business''s location');
select pg_temp.refused_with($$select public.journal_entry_create(null, public.il_today(), 'income', 10, 0, null, null, 'הכנסה')$$, 'journal_id', 'an entry has an id');
commit;
select pg_temp.check(not exists (select 1 from public.journal_entries), 'nothing refused was kept');
-- an exempt dealer records no VAT at all
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e51a06');
select pg_temp.refused_with($$select pg_temp.je(80, public.il_today(), 'income', 100, 17)$$, 'journal_vat', 'an exempt dealer''s income carries no VAT');
select pg_temp.refused_with($$select pg_temp.je(80, public.il_today(), 'vat', 0, 17, 'output')$$, 'journal_vat', 'nor a VAT entry');
select pg_temp.check((pg_temp.je(80, public.il_today(), 'income', 100, 0, null, null, 'הכנסה שלא נרשמה בקבלה', null,
                        '{"kind": "customer", "leadId": "00000000-0000-0000-0000-000000e51d02"}')->>'number')::int = 1, 'its own entry 1');
insert into jout select 'jb', public.finance_summary(public.il_today(), public.il_today());
commit;
select pg_temp.check((pg_temp.r('jb')->'revenue'->>'net')::numeric = 100 and (pg_temp.r('jb')->'revenue'->>'vat')::numeric = 0
                     and (pg_temp.r('jb')->>'vatPayable')::numeric = 0, 'the exempt shop: 100 more income, no VAT');

-- ======================================================================================================================
-- 3. the entries of clinic JA: numbered, the same id once, each in the audit log
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e51a01');
select pg_temp.check(pg_temp.je(1, public.il_today(), 'income', 200, 36, null, null, 'הכנסה מטיפול שלא הופקה עליו חשבונית', null,
                       '{"kind": "customer", "leadId": "00000000-0000-0000-0000-000000e51d01"}') = jsonb_build_object('id', pg_temp.jid(1), 'number', 1, 'created', true),
  'entry 1: income of Dana');
select pg_temp.check((pg_temp.je(1, public.il_today(), 'expense', 999, 0, null, 'other', 'אחר לגמרי')->>'created')::boolean = false, 'the same id again is the same entry');
select pg_temp.check((pg_temp.je(2, public.il_today(), 'expense', 100, 18, null, 'supplies', 'חשבונית ספק שלא נרשמה בהוצאות', null,
                       '{"kind": "supplier", "name": "ספק ציוד", "dealer": "512345678"}')->>'number')::int = 2, 'entry 2: an expense of the supplier');
select pg_temp.check((pg_temp.je(3, public.il_today(), 'vat', 0, 50, 'output', null, 'הפרש מע״מ עסקאות מהדוח הקודם')->>'number')::int = 3, 'entry 3: VAT on sales');
select pg_temp.check((pg_temp.je(4, public.il_today(), 'vat', 0, 20, 'input', null, 'מע״מ תשומות שלא נדרש')->>'number')::int = 4, 'entry 4: VAT on inputs');
select pg_temp.check((pg_temp.je(5, public.il_today(), 'other', 300, 0, null, null, 'הלוואה מבעלים — לא הכנסה')->>'number')::int = 5, 'entry 5: other');
select pg_temp.check((pg_temp.je(6, public.il_today(), 'income', 400, 72, null, null, 'הכנסה בסניף', '00000000-0000-0000-0000-000000e51c01')->>'number')::int = 6,
  'entry 6: income at the branch, no customer');
select pg_temp.check((pg_temp.je(7, public.il_today(), 'expense', 250, 0, null, null, 'הפרשה לחופשה', '00000000-0000-0000-0000-000000e51c01')->>'number')::int = 7,
  'entry 7: a provision at the branch (the kind of expense: other)');
select pg_temp.check((pg_temp.je(9, public.il_today(), 'income', 150, 27, null, null, 'הכנסה מלקוח עסקי', null,
                       '{"kind": "customer", "name": "חברת אלפא", "dealer": "516000007"}')->>'number')::int = 8, 'entry 8: a customer by name and number');
select pg_temp.check((pg_temp.je(10, public.il_today() - 5, 'expense', 60, 0, null, 'rent', 'תיקון שכירות')->>'number')::int = 9, 'entry 9: five days ago');
commit;
select pg_temp.check((select count(*) from public.journal_entries where business_id = '00000000-0000-0000-0000-000000e51b01') = 9, 'nine entries');
select pg_temp.check((select string_agg(number::text, ',' order by number) from public.journal_entries where business_id = '00000000-0000-0000-0000-000000e51b01')
                     = '1,2,3,4,5,6,7,8,9', 'numbered one by one');
select pg_temp.check((select location_id = '00000000-0000-0000-0000-000000e51b01' and party_name = 'דנה' and vat_side = 'output' from public.journal_entries where id = pg_temp.jid(1)),
  'entry 1: the main location (none chosen, none picked), Dana''s name kept, VAT on sales');
select pg_temp.check((select category = 'other' and vat_side = 'input' from public.journal_entries where id = pg_temp.jid(7)), 'an expense without a kind is "other"');
select pg_temp.check((select count(*) from public.finance_audit_log where business_id = '00000000-0000-0000-0000-000000e51b01' and action = 'journal.created') = 9,
  'every entry is in the audit log');
select pg_temp.check((select details->>'explanation' = 'הפרשה לחופשה' and (details->>'amount')::numeric = 250 from public.finance_audit_log
                       where action = 'journal.created' and entity_id = pg_temp.jid(7)::text), 'with what it says');

-- ======================================================================================================================
-- 4. undo: a reversing entry — once, with a reason, on or after its entry; never changed, never removed
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e51a01');
select pg_temp.refused_with($$select public.journal_entry_reverse(pg_temp.jid(20), pg_temp.jid(6), public.il_today(), ' ')$$, 'journal_explanation', 'a reversal says why');
select pg_temp.refused_with($$select public.journal_entry_reverse(pg_temp.jid(20), pg_temp.jid(6), public.il_today() - 1, 'נרשם פעמיים')$$, 'journal_date',
  'not before the entry it undoes');
select pg_temp.refused_with($$select public.journal_entry_reverse(pg_temp.jid(20), pg_temp.jid(6), public.il_today() + 1, 'נרשם פעמיים')$$, 'journal_date', 'nor tomorrow');
select pg_temp.refused_with($$select public.journal_entry_reverse(pg_temp.jid(20), pg_temp.jid(55), null, 'נרשם פעמיים')$$, 'journal_entry', 'an entry that is not there');
select pg_temp.check(public.journal_entry_reverse(pg_temp.jid(20), pg_temp.jid(6), null, 'נרשם פעמיים — הכנסה כפולה')
                     = jsonb_build_object('id', pg_temp.jid(20), 'number', 10, 'created', true, 'reverses', 6), 'entry 10 undoes entry 6');
select pg_temp.check((public.journal_entry_reverse(pg_temp.jid(20), pg_temp.jid(6), null, 'שוב')->>'created')::boolean = false, 'the same reversal again: the same entry');
select pg_temp.refused_with($$select public.journal_entry_reverse(pg_temp.jid(21), pg_temp.jid(6), null, 'שוב')$$, 'journal_reversed', 'an entry is undone once');
select pg_temp.refused_with($$select public.journal_entry_reverse(pg_temp.jid(21), pg_temp.jid(20), null, 'ביטול הביטול')$$, 'journal_reverse',
  'a reversal is not undone — a new entry is recorded instead');
select pg_temp.refused_with($$update public.journal_entries set amount = 1 where id = pg_temp.jid(1)$$, 'permission denied', 'an entry is never changed from the app');
select pg_temp.refused_with($$insert into public.journal_entries (id, business_id, location_id, number, entry_date, kind, amount, vat_side, explanation)
  values (gen_random_uuid(), '00000000-0000-0000-0000-000000e51b01', '00000000-0000-0000-0000-000000e51b01', 99, public.il_today(), 'income', 1, 'output', 'עקיפה')$$,
  'permission denied', 'nor written but by its functions');
select pg_temp.as_user('00000000-0000-0000-0000-000000e51a06');
select pg_temp.refused_with($$select public.journal_entry_reverse(pg_temp.jid(22), pg_temp.jid(1), null, 'של עסק אחר')$$, 'journal_entry', 'another business''s entry is not found');
select pg_temp.refused_with($$select pg_temp.je(1, public.il_today(), 'income', 1, 0)$$, 'not allowed', 'nor its id taken');
commit;
select pg_temp.check((select kind = 'income' and amount = -400 and vat = -72 and location_id = '00000000-0000-0000-0000-000000e51c01' and explanation = 'נרשם פעמיים — הכנסה כפולה'
                        from public.journal_entries where id = pg_temp.jid(20)), 'the reversal: the same entry, the opposite sign, at the same location, with its reason');
select pg_temp.check((select count(*) from public.finance_audit_log where action = 'journal.reversed' and (details->>'reverses')::int = 6) = 1, 'in the audit log');
select pg_temp.refused_with($$update public.journal_entries set explanation = 'שונה' where id = pg_temp.jid(1)$$, 'append-only', 'not even by the database''s owner');
select pg_temp.refused_with($$delete from public.journal_entries where id = pg_temp.jid(5)$$, 'append-only', 'and never removed');

-- ======================================================================================================================
-- 5. the reports: the money summary, every report's total, the cards, the comparison of locations — and who reads what
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e51a01');
insert into jout select 'sum', public.finance_summary(public.il_today(), public.il_today());
insert into jout select 'sum5', public.finance_summary(public.il_today() - 5, public.il_today());
insert into jout select 'inc', public.report_income_by_customer(public.il_today(), public.il_today());
insert into jout select 'items', public.report_sales_by_item(public.il_today(), public.il_today());
insert into jout select 'sup', public.report_suppliers(public.il_today(), public.il_today());
insert into jout select 'dana', public.report_customer_ledger('l:00000000-0000-0000-0000-000000e51d01', public.il_today(), public.il_today());
insert into jout select 'alfa', public.report_customer_ledger('d:516000007', public.il_today(), public.il_today());
insert into jout select 'supplier', public.report_supplier_ledger('d:512345678', public.il_today(), public.il_today());
insert into jout select 'cmp', public.location_compare(public.il_today(), public.il_today());
select public.location_select('00000000-0000-0000-0000-000000e51c01');
insert into jout select 'sum:l2', public.finance_summary(public.il_today(), public.il_today());
select public.location_select(null);
select pg_temp.as_user('00000000-0000-0000-0000-000000e51a02');
insert into jout select 'ol', public.finance_summary(public.il_today(), public.il_today());
insert into jout select 'ol:rows', (select jsonb_agg(number order by number) from public.journal_entries);
select pg_temp.as_user('00000000-0000-0000-0000-000000e51a04');
insert into jout select 'va', public.finance_summary(public.il_today(), public.il_today());
insert into jout select 'va:rows', (select jsonb_agg(number order by number) from public.journal_entries);
select pg_temp.as_user('00000000-0000-0000-0000-000000e51a05');
select pg_temp.check((select count(*) from public.journal_entries) = 0, 'a cashier reads no entry');
select pg_temp.as_user('00000000-0000-0000-0000-000000e51a06');
select pg_temp.check((select count(*) from public.journal_entries) = 1, 'the other business reads its own entry only');
commit;
create or replace function pg_temp.n(p_who text, variadic p text[]) returns numeric language sql as $$ select (pg_temp.r(p_who) #>> p)::numeric $$;
-- the money summary of today: the invoice (1,000 + 180), entries 1 (200 + 36), 3 (50 on sales), 6 and its reversal, 8 (150 + 27);
-- the expense (500 + 90), entries 2 (100 + 18), 4 (20 on inputs), 7 (250); entry 5 ("other") in nothing
select pg_temp.check(pg_temp.n('sum', 'revenue', 'net') = 1350 and pg_temp.n('sum', 'revenue', 'vat') = 293 and pg_temp.n('sum', 'revenue', 'gross') = 1643,
  'income: 1,000 + 200 + 150 (400 undone) — VAT 180 + 36 + 27 + 50 on sales');
select pg_temp.check(pg_temp.n('sum', 'expenses', 'net') = 850 and pg_temp.n('sum', 'expenses', 'vat') = 128 and pg_temp.n('sum', 'expenses', 'vatDeductible') = 128
                     and pg_temp.n('sum', 'expenses', 'total') = 958 and pg_temp.n('sum', 'expenses', 'count') = 1,
  'expenses: 500 + 100 + 250, VAT 90 + 18 + 20 on inputs, all deductible; one expense in the count');
select pg_temp.check(pg_temp.n('sum', 'vatPayable') = 165 and pg_temp.n('sum', 'profit') = 500, 'VAT to pay 293 − 128; profit 1,350 − 850');
select pg_temp.check(pg_temp.r('sum')->'manual' = '{"count": 9, "income": {"net": 350, "vat": 63}, "expense": {"net": 350, "vat": 18}, "vat": {"output": 50, "input": 20}}'::jsonb,
  'apart: nine entries of today — income 350 (+63), expenses 350 (+18), VAT 50 on sales and 20 on inputs');
select pg_temp.check((select sum((x->>'total')::numeric) from jsonb_array_elements(pg_temp.r('sum')->'expenses'->'byCategory') x) = 958
                     and (select (x->>'total')::numeric from jsonb_array_elements(pg_temp.r('sum')->'expenses'->'byCategory') x where x->>'category' = 'supplies') = 708,
  'by kind of expense: supplies 590 + 118, the rest "other"');
select pg_temp.check((select sum((m->>'revenue')::numeric) from jsonb_array_elements(pg_temp.r('sum5')->'months') m) = pg_temp.n('sum5', 'revenue', 'net')
                     and (select sum((m->>'expenses')::numeric) from jsonb_array_elements(pg_temp.r('sum5')->'months') m)
                         = pg_temp.n('sum5', 'expenses', 'net') + pg_temp.n('sum5', 'expenses', 'vat') - pg_temp.n('sum5', 'expenses', 'vatDeductible'),
  'the months add up to the period (the entry of five days ago too)');
select pg_temp.check(pg_temp.n('sum5', 'expenses', 'net') = 910, 'five days back: entry 9''s 60 too');
-- every report's total is the money summary's
select pg_temp.check(pg_temp.n('inc', 'total', 'net') = 1350 and pg_temp.n('inc', 'total', 'vat') = 293 and pg_temp.n('inc', 'total', 'manual') = 350,
  'income by customer = the summary''s income (350 of it manual)');
select pg_temp.check((select (x->>'net')::numeric = 1200 and (x->>'vat')::numeric = 216 and (x->>'manual')::numeric = 200 and (x->>'count')::int = 2
                        from jsonb_array_elements(pg_temp.r('inc')->'customers') x where x->>'key' = 'l:00000000-0000-0000-0000-000000e51d01'),
  'Dana: the invoice and entry 1');
select pg_temp.check((select (x->>'net')::numeric = 150 and x->>'name' = 'חברת אלפא' and x->>'dealer' = '516000007'
                        from jsonb_array_elements(pg_temp.r('inc')->'customers') x where x->>'key' = 'd:516000007'), 'a customer by number, named by the entry');
select pg_temp.check((select (x->>'net')::numeric = 0 and (x->>'vat')::numeric = 50 and (x->>'count')::int = 3
                        from jsonb_array_elements(pg_temp.r('inc')->'customers') x where x->>'key' = 'm:'),
  'without a customer: entry 6, its reversal and the VAT on sales');
select pg_temp.check(pg_temp.n('items', 'total') = 1350 and pg_temp.r('items')->'manual' = '{"net": 350, "count": 4}'::jsonb,
  'sales by item = the summary''s income, the entries on a line of their own');
select pg_temp.check(pg_temp.n('sup', 'total', 'total') = 958 and pg_temp.n('sup', 'total', 'net') = 850 and pg_temp.n('sup', 'total', 'paid') = 590
                     and pg_temp.n('sup', 'total', 'manual') = 368 and pg_temp.n('sup', 'total', 'open') = 0,
  'suppliers = the summary''s expenses; the entries are neither paid nor owed');
select pg_temp.check((select (x->>'total')::numeric = 708 and (x->>'manual')::numeric = 118 and (x->>'open')::numeric = 0
                        from jsonb_array_elements(pg_temp.r('sup')->'suppliers') x where x->>'key' = 'd:512345678'), 'the supplier: its expense and entry 2');
select pg_temp.check((select (x->>'total')::numeric = 250 from jsonb_array_elements(pg_temp.r('sup')->'suppliers') x where x->>'key' = 'm:'), 'without a supplier: entry 7');
select pg_temp.check((select (x->>'manual')::numeric = 250 from jsonb_array_elements(pg_temp.r('sup')->'categories') x where x->>'category' = 'other'), 'by kind: entry 7 in "other"');
-- the cards
select pg_temp.check(pg_temp.n('dana', 'closing') = 1416 and pg_temp.n('dana', 'debit') = 1416
                     and (select x->>'note' = 'הכנסה מטיפול שלא הופקה עליו חשבונית' and (x->>'docNumber')::int = 1 and (x->>'debit')::numeric = 236
                            from jsonb_array_elements(pg_temp.r('dana')->'rows') x where x->>'kind' = 'manual'),
  'Dana''s card: the invoice 1,180 and the entry 236 ("פקודה ידנית", with its explanation)');
select pg_temp.check(pg_temp.r('alfa')->>'name' = 'חברת אלפא' and pg_temp.n('alfa', 'closing') = 177, 'a card of a customer who has entries only');
select pg_temp.check(pg_temp.n('supplier', 'closing') = 118
                     and (select (x->>'credit')::numeric = 118 and x->>'note' = 'חשבונית ספק שלא נרשמה בהוצאות'
                            from jsonb_array_elements(pg_temp.r('supplier')->'rows') x where x->>'kind' = 'manual'),
  'the supplier''s card: the expense paid, entry 2 owed');
-- the comparison of locations adds up to the summary
select pg_temp.check((select sum((l->>'profit')::numeric) from jsonb_array_elements(pg_temp.r('cmp')->'locations') l) = pg_temp.n('sum', 'profit')
                     and (select sum((l->'revenue'->>'net')::numeric) from jsonb_array_elements(pg_temp.r('cmp')->'locations') l) = pg_temp.n('sum', 'revenue', 'net'),
  'the comparison of locations: its profits and income add up to the summary''s');
select pg_temp.check((select (l->'revenue'->>'net')::numeric = 0 and (l->'expenses'->>'cost')::numeric = 250 and (l->>'profit')::numeric = -250
                        from jsonb_array_elements(pg_temp.r('cmp')->'locations') l where l->>'id' = '00000000-0000-0000-0000-000000e51c01'),
  'the branch: entry 6 undone, the provision');
-- who reads what: the branch picked at the top, the branch's own manager, the viewer
select pg_temp.check(pg_temp.n('sum:l2', 'revenue', 'net') = 0 and pg_temp.n('sum:l2', 'expenses', 'net') = 250 and (pg_temp.r('sum:l2')->'manual'->>'count')::int = 3,
  'the owner with the branch picked: the branch''s three entries only');
select pg_temp.check(pg_temp.r('ol') = pg_temp.r('sum:l2') and pg_temp.r('ol:rows') = '[6, 7, 10]'::jsonb, 'the branch''s manager: the same, and those three entries');
select pg_temp.check(pg_temp.r('va') = pg_temp.r('sum') and jsonb_array_length(pg_temp.r('va:rows')) = 10, 'the viewer reads them all');

-- ======================================================================================================================
-- 6. closed books: no entry dated in them; an entry in them is undone today
-- ======================================================================================================================
begin;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000e51a01');
select public.lock_finance_period(public.il_today() - 2, 'סגירת תקופה');
select pg_temp.refused_with($$select pg_temp.je(30, public.il_today() - 3, 'income', 10, 0)$$, 'period_locked', 'an entry dated in closed books');
select pg_temp.check((pg_temp.je(30, public.il_today() - 1, 'income', 10, 1.8)->>'number')::int = 11, 'the day after them: entry 11');
select pg_temp.refused_with($$select public.journal_entry_reverse(pg_temp.jid(31), pg_temp.jid(10), public.il_today() - 3, 'תיקון')$$, 'period_locked',
  'a reversal dated in closed books');
select pg_temp.check((public.journal_entry_reverse(pg_temp.jid(31), pg_temp.jid(10), null, 'תיקון אחרי סגירה')->>'number')::int = 12,
  'entry 9 (closed in) undone today: entry 12');
commit;
select pg_temp.check((select entry_date = public.il_today() and amount = -60 and reverses = pg_temp.jid(10) from public.journal_entries where id = pg_temp.jid(31)),
  'today, the opposite sign');
