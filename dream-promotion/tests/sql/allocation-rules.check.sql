-- The allocation-number thresholds after migration 20261011005200 (the accountant's answer of 11.10.2026, STATUS.md §5 item 14),
-- on a real Postgres (tests/sql/run.sh): the four versions confirmed, with the note the screens show; nothing else changed;
-- the table is still read-only for the signed-in roles. Every check raises "CHECK FAILED: …" when the database does not behave.
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

select pg_temp.check((select count(*) = 4 from public.tax_allocation_rules), 'four versions, as before');
select pg_temp.check((select array_agg(version || ':' || effective_from || ':' || threshold_before_vat::int || ':' || verified order by version)
                        = array['1:2024-05-05:25000:true', '2:2025-01-01:20000:true', '3:2026-01-01:10000:true', '4:2026-06-01:5000:true']
                        from public.tax_allocation_rules),
  'the same dates and thresholds — each confirmed');
select pg_temp.check((select bool_and(source_note like 'אושר מול רואה חשבון (11.10.2026)%') from public.tax_allocation_rules),
  'the note says who confirmed it, and when');
select pg_temp.check((select bool_and(doc_types = '{305,320}' and requires_customer_dealer) from public.tax_allocation_rules),
  'what needs a number did not change');

-- the migration again changes nothing (a row already confirmed is left as it is)
update public.tax_allocation_rules set source_note = source_note || ' ' where version = 1;
\i supabase/migrations/20261011005200_accountant_answers.sql
select pg_temp.check((select source_note like '% ' from public.tax_allocation_rules where version = 1), 'a second run does not touch a confirmed row');
update public.tax_allocation_rules set source_note = rtrim(source_note) where version = 1;

-- still read-only for the screens
begin;
set local role authenticated;
select pg_temp.refused($$update public.tax_allocation_rules set verified = false$$, 'nobody signed in changes the thresholds');
select pg_temp.check((select count(*) = 4 from public.tax_allocation_rules), 'everybody signed in reads them');
commit;
