-- 2.123.0 — stage 4ד: the opening balances of suppliers (tests/sql/books-opening-suppliers.check.sql). The owner's answer 3 of the
-- 7200 review (27.11.2026): suppliers' opening balances in gl_opening_balances.
-- What it does: gl_opening_balances(jsonb) also takes a supplier's line —
--   { "supplier": { "dealer": "<9 digits or empty>", "name": "<name>" }, "side": "D" | "C", "amount": n }
-- — its account found or opened by gl_supplier_account(business, dealer, name) (7200): the same account (role) that supplier's
-- expenses post to later. Everything else as before: once, dated the start date, the owner, the rest against 3100; an "account"
-- line as before (a new customer — with "name", never a reserved key: four digits, BANK or "S-…").
-- Also (answer 13, confirmed by the owner 27.11.2026): the books' screens are hidden by default — gl_books.show_screens (false),
-- turned on / off by the owner only (gl_books_screens_set); gl_books_state() says it ("showScreens"). The books post either way.
-- Replaces (same signature) — md5 of prosrc. BEFORE running, compare the old one with the live database; AFTER, the new one:
--   select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = 'public.gl_opening_balances(jsonb)'::regprocedure
--   gl_opening_balances(jsonb)   of 7100   e39e88dce864a72cb3ae53480642e30d  d41d6b0a2acecc2c6ecfd8f7ee85bdf2
--   gl_books_state()             of 7100   e6ca162810b13e6737c06cbc0cba46e7  3c7ec2364edb0a985b7154e3c6ee7a38
--   gl_books_screens_set(boolean)   new                                     9e93f3df5f37636fc3897658da14ed1d
-- Running 7100 again after this one brings the old ones back — then run this one again. One new column (gl_books.show_screens,
-- not null default false — no existing row changes otherwise), no drop / delete. Runs after 7200 — it stops at the top without it, changing nothing. RUN IT AS ONE SCRIPT IN THE SQL EDITOR.
set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public.gl_supplier_account(uuid, text, text)') is null or to_regprocedure('public.gl_opening_balances(jsonb)') is null
     or to_regprocedure('public.gl_supplier_role(text, text)') is null then
    raise exception 'migration 20261130007300 runs after 20261129007200 (books, more) — run it first; nothing was changed';
  end if;
end $$;

-- replaces gl_opening_balances(jsonb) of 20261128007100 — also a supplier's line (by gl_supplier_account)
CREATE OR REPLACE FUNCTION public.gl_opening_balances(p_lines jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare b uuid := public.finance_guard(); bk public.gl_books; e jsonb; a uuid; k text; s text; amt numeric; r public.gl_line_in[] := '{}';
  dsum numeric := 0; csum numeric := 0; tx uuid; lock_end date; nm text; sp jsonb; dl text;
begin
  if not public.can_write() or not public.journal_writer() then raise exception 'not allowed' using errcode = '42501'; end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 or jsonb_array_length(p_lines) > 2000 then
    raise exception 'opening_lines: רשימת יתרות (1 עד 2000 שורות)' using errcode = '22023'; end if;
  perform public.gl_chart_ensure(b);
  perform pg_advisory_xact_lock(hashtextextended('finance_audit:' || b::text, 0));   -- finance_log's lock first, as a document's issue
  select * into bk from public.gl_books where business_id = b for update;
  if bk.opening_tx is not null or exists (select 1 from public.gl_transactions where idempotency_key = 'opening:' || b) then
    raise exception 'opening_done: יתרות הפתיחה כבר נרשמו (תיקון — בפקודה)' using errcode = '23514'; end if;
  lock_end := public.finance_locked_until(b);
  if lock_end is not null and bk.start_date <= lock_end then
    raise exception 'period_locked: the books are closed until %', lock_end using errcode = '23514'; end if;
  for e in select value from jsonb_array_elements(p_lines) loop
    k := btrim(coalesce(e->>'account', '')); s := e->>'side'; sp := e->'supplier';
    if jsonb_typeof(e->'amount') is distinct from 'number' then raise exception 'opening_amount: סכום — מספר' using errcode = '22023'; end if;
    amt := (e->>'amount')::numeric;
    if s not in ('D', 'C') or amt is null or amt <= 0 or amt <> round(amt, 2) or amt > 999999999999 then
      raise exception 'opening_line: כל שורה — חשבון, חובה / זכות (D / C) וסכום מעל 0, עד אגורות' using errcode = '22023'; end if;
    -- 7300: a supplier's balance — its account under 2100 by gl_supplier_account (the same account its expenses post to)
    if sp is not null then
      if e ? 'account' or jsonb_typeof(sp) is distinct from 'object' then
        raise exception 'opening_supplier: שורת ספק — "supplier" עם מספר עוסק ושם, בלי "account"' using errcode = '22023'; end if;
      dl := btrim(coalesce(sp->>'dealer', '')); nm := btrim(coalesce(sp->>'name', ''));
      if (dl <> '' and dl !~ '^[0-9]{9}$') or nm = '' or length(nm) > 120 then
        raise exception 'opening_supplier: ספק — שם (עד 120 תווים), ומספר עוסק של 9 ספרות או ריק' using errcode = '22023'; end if;
      a := public.gl_supplier_account(b, dl, nm);
    else
    select id into a from public.gl_accounts where business_id = b and key = k;
    if a is null then
      nm := btrim(coalesce(e->>'name', ''));
      if k = '' or length(k) > 15 or nm = '' or public.gl_key_reserved(k) then
        raise exception 'opening_account: חשבון % לא נמצא (לקוח חדש — עם שם, ומפתח שאינו של המערכת)', k using errcode = '22023'; end if;
      insert into public.gl_accounts (business_id, key, name, kind, tb_code, tb_name, parent_key, role)
      values (b, k, left(nm, 50), 'asset', 'CUSTOMERS', 'לקוחות', '1300', 'customer:' || k) returning id into a;
    end if;
    end if;
    if a = public.gl_account(b, 'opening') then raise exception 'opening_account: חשבון יתרות הפתיחה מתאזן לבד' using errcode = '22023'; end if;
    r := r || public.gl_ln(a, s, amt, bk.start_date);
    if s = 'D' then dsum := dsum + amt; else csum := csum + amt; end if;
  end loop;
  r := r || public.gl_ln(public.gl_account(b, 'opening'), 'C', dsum - csum, bk.start_date);
  if coalesce(cardinality(r), 0) < 2 then raise exception 'opening_lines: לפחות שורה אחת עם סכום' using errcode = '22023'; end if;
  insert into public.gl_transactions (business_id, number, tx_date, value_date, source_kind, source_id, idempotency_key, details, location_id, user_id)
  values (b, bk.last_tx_no + 1, bk.start_date, bk.start_date, 'opening', b, 'opening:' || b, 'יתרות פתיחה', b, auth.uid())
  returning id into tx;
  insert into public.gl_lines (transaction_id, business_id, line_no, account_id, side, amount, value_date, match1, match2, location_id)
  select tx, b, l.o, l.account_id, l.side, l.amount, l.value_date, l.match1, l.match2, b
    from unnest(r) with ordinality as l(account_id, side, amount, value_date, match1, match2, o);
  update public.gl_books set last_tx_no = last_tx_no + 1, opening_tx = tx, updated_at = now() where business_id = b;
  perform public.finance_log(b, 'books.opening', 'gl_transactions', tx::text, jsonb_build_object('debit', dsum, 'credit', csum, 'lines', jsonb_array_length(p_lines)));
  return jsonb_build_object('id', tx, 'number', bk.last_tx_no + 1, 'date', bk.start_date, 'debit', dsum, 'credit', csum, 'opening', dsum - csum);
end $function$;

-- answer 13: the books' screens — hidden until the owner turns them on (the books post either way)
alter table public.gl_books add column if not exists show_screens boolean not null default false;

-- replaces gl_books_state() of 20261128007100 — the same keys, and "showScreens"
create or replace function public.gl_books_state() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare b uuid := public.finance_guard(); bk public.gl_books;
begin
  bk := public.gl_books_ensure(b);
  return jsonb_build_object('startDate', bk.start_date, 'started', public.il_today() >= bk.start_date,
    'transactions', bk.last_tx_no, 'openingEntered', bk.opening_tx is not null,
    'canMoveStart', not exists (select 1 from public.gl_transactions t where t.business_id = b),
    'owner', public.journal_writer(), 'showScreens', bk.show_screens);
end $$;

-- the owner turns the books' screens on / off (journal_writer, can_write; in the audit log). Returns { showScreens, changed }
create or replace function public.gl_books_screens_set(p_on boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare b uuid := public.finance_guard(); bk public.gl_books;
begin
  if not public.can_write() or not public.journal_writer() then
    raise exception 'books_not_allowed: רק הבעלים מציגים או מסתירים את מסכי הנהלת החשבונות' using errcode = '42501'; end if;
  if p_on is null then raise exception 'books_screens: להציג או להסתיר' using errcode = '22023'; end if;
  perform public.gl_books_ensure(b);
  perform pg_advisory_xact_lock(hashtextextended('finance_audit:' || b::text, 0));   -- finance_log's lock first, then the books'
  select * into bk from public.gl_books where business_id = b for update;
  if bk.show_screens = p_on then return jsonb_build_object('showScreens', p_on, 'changed', false); end if;
  update public.gl_books set show_screens = p_on, updated_at = now() where business_id = b;
  perform public.finance_log(b, case when p_on then 'books.screens_on' else 'books.screens_off' end, 'gl_books', b::text,
    jsonb_build_object('from', bk.show_screens, 'to', p_on));
  return jsonb_build_object('showScreens', p_on, 'changed', true);
end $$;
revoke execute on function public.gl_books_screens_set(boolean) from public, anon;
grant execute on function public.gl_books_screens_set(boolean) to authenticated;

-- the grants of 7100 stay (create or replace keeps them): the owner's function, never anon
revoke execute on function public.gl_opening_balances(jsonb) from public, anon;
grant execute on function public.gl_opening_balances(jsonb) to authenticated, service_role;

-- Rollback (by hand): drop function gl_books_screens_set(boolean); run again gl_books_state() of 20261128007100 (section 9 only);
-- alter table gl_books drop column show_screens (the screens then follow the code's default); run again gl_opening_balances() of
-- 20261128007100 (section 8 only) — the supplier accounts it opened stay
-- (gl_accounts are never removed), and so does an opening entry already recorded.
