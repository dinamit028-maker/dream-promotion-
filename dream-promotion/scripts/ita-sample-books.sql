-- ita-sample-books.sql — LOCAL demo only (never the live database: it stops on a Supabase project). After tests/sql/ita-demo.seed.sql,
-- the licensed demo business (fictitious, dealer 000000109) keeps double-entry books from 1.6.2026 — the first day of its demo
-- documents — so scripts/ita-sample.mjs can make the sample of a file FROM THE BOOKS (2.124, stage 4ה: B100 + B110, 1013 = 2):
--   1. the owner moves the books' start to 1.6.2026 (gl_books_start_set — before any entry; migration 7100);
--   2. opening balances (gl_opening_balances: the bank, the main cash desk, a demo customer of its own — the rest to 3100);
--   3. every document / cancellation / deposit of the demo is posted (gl_replay, in batches — the books' own posting);
--   4. one manual double entry (gl_manual_create: rent paid from the bank), dated the day this runs.
-- Everything through the books' own functions, as the demo owner signed in — nothing written into gl_* by hand. Run again: the
-- start is fixed after the first entry, the opening balances and the manual entry are once (their keys) — nothing is added.
-- Usage (repo dream-promotion/):  psql -X -v ON_ERROR_STOP=1 -d ita_demo -f scripts/ita-sample-books.sql
--   then:  ITA_FROM=2026-06-01 npx -y tsx scripts/ita-sample.mjs docs/ita-registration/sample-books
\set ON_ERROR_STOP 1
set client_min_messages = warning;
do $$ begin
  if to_regclass('auth.identities') is not null or current_database() = 'postgres' then
    raise exception 'ita-sample-books: local demo data only — refusing to run on % (a Supabase / live database?)', current_database(); end if;
end $$;
begin;
set local role authenticated;
set local "request.jwt.claim.sub" = 'd3e00000-0000-4000-8000-0000000000a1';
set local "request.jwt.claim.role" = 'authenticated';
do $$
declare B constant uuid := 'd3e00000-0000-4000-8000-000000000001'; r jsonb; n int := 0;
begin
  if not exists (select 1 from public.gl_transactions where business_id = B) then
    perform public.gl_books_start_set(date '2026-06-01');
    perform public.gl_opening_balances(jsonb_build_array(
      jsonb_build_object('account', 'BANK', 'side', 'D', 'amount', 25000),
      jsonb_build_object('account', '1100', 'side', 'D', 'amount', 1500.50),
      jsonb_build_object('account', 'DEMO-OPEN', 'name', 'לקוח דמו — יתרת פתיחה', 'side', 'D', 'amount', 2360)));
  end if;
  loop
    r := public.gl_replay(B, null, 500, false);
    n := n + 1;
    exit when coalesce((r->>'left')::int, 0) = 0 or coalesce((r->>'posted')::int, 0) = 0 or n > 50;
  end loop;
  perform public.gl_manual_create('d3e00000-0000-4000-8000-00000000e001'::uuid, public.il_today(), 'שכירות דמו — העברה מהבנק',
    jsonb_build_array(jsonb_build_object('account', '6103', 'side', 'D', 'amount', 3000), jsonb_build_object('account', 'BANK', 'side', 'C', 'amount', 3000)));
end $$;
commit;
select json_build_object('start', (select start_date from public.gl_books where business_id = 'd3e00000-0000-4000-8000-000000000001'),
  'entries', (select count(*) from public.gl_transactions where business_id = 'd3e00000-0000-4000-8000-000000000001'),
  'lines', (select count(*) from public.gl_lines where business_id = 'd3e00000-0000-4000-8000-000000000001'),
  'unposted', (select count(*) from public.gl_unposted where business_id = 'd3e00000-0000-4000-8000-000000000001'),
  'failures', (select count(*) from public.gl_post_failures where business_id = 'd3e00000-0000-4000-8000-000000000001'));
