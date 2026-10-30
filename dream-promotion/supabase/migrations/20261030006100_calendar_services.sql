-- 2.110.0 — the treatments for a calendar member ("יומן ולידים", 6000) (tests/sql/calendar-services.check.sql).
-- The owner of the system (30.10.2026, SaGabot): Gal adds treatments (e.g. "לייזר — ידיים") and changes their names and default
-- length; never their price or deposit (money), and never deletes one (hides it). Runs after 6000.
--   booking_services: a calendar member inserts and updates — the cashier rule (3000) and 6000's "read only" are opened for
--   them; deleting stays closed. b_booking_services_calendar_money: what they add has no price and no deposit, and what they
--   change keeps its price and deposit.
-- Additions only: no row changes.

do $$ begin
  if to_regprocedure('public.calendar_member()') is null then
    raise exception 'run migration 20261028006000 (calendar access) first';
  end if;
end $$;

-- the cashier rule: a cashier reads the services; a calendar member adds and changes them
do $$ begin
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'booking_services' and policyname = 'booking_services_cashier_insert') then
    alter policy booking_services_cashier_insert on public.booking_services
      with check ((select public.my_access()) <> 'register' or (select public.calendar_member()));
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'booking_services' and policyname = 'booking_services_cashier_update') then
    alter policy booking_services_cashier_update on public.booking_services
      using ((select public.my_access()) <> 'register' or (select public.calendar_member()))
      with check ((select public.my_access()) <> 'register' or (select public.calendar_member()));
  end if;
  -- 6000's "read only" for them, opened for insert and update (delete stays: booking_services_calendar_delete)
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'booking_services' and policyname = 'booking_services_calendar_insert') then
    alter policy booking_services_calendar_insert on public.booking_services with check (true);
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'booking_services' and policyname = 'booking_services_calendar_update') then
    alter policy booking_services_calendar_update on public.booking_services using (true) with check (true);
  end if;
end $$;

-- no money: a calendar member's service has no price or deposit, and a change keeps the ones the owner set
create or replace function public.booking_services_calendar_money() returns trigger
language plpgsql set search_path = public as $$
begin
  if not public.calendar_member() then return new; end if;
  if tg_op = 'INSERT' then
    if new.price is not null or new.deposit is not null then
      raise exception 'מחיר ומקדמה של טיפול — רק בעלי העסק.' using errcode = 'P0001', hint = 'owner_only';
    end if;
  elsif new.price is distinct from old.price or new.deposit is distinct from old.deposit then
    raise exception 'מחיר ומקדמה של טיפול — רק בעלי העסק.' using errcode = 'P0001', hint = 'owner_only';
  end if;
  return new;
end $$;
revoke execute on function public.booking_services_calendar_money() from public, anon;
create or replace trigger b_booking_services_calendar_money before insert or update on public.booking_services
  for each row execute function public.booking_services_calendar_money();

-- ---- rollback (by hand, only to undo it) ---------------------------------------------------------------------------------------
--   (running 6000 again does not change existing policies)
--   alter policy booking_services_calendar_insert on public.booking_services with check (not (select public.calendar_member()));
--   alter policy booking_services_calendar_update on public.booking_services using (not (select public.calendar_member()))
--     with check (not (select public.calendar_member()));
