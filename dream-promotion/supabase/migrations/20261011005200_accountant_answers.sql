-- ============================================================================================================================
-- Migration 20261011005200 — two of the accountant's answers of 11.10.2026 (STATUS.md §5, items 14 and 25); 2.97.0.
-- Prepared only: NOT applied to the live database (needs the owner's explicit approval; the SQL Editor). Runs after
-- 20261010004300 (payment links — already in the live database): it stops at the top without it, changing nothing. It does not
-- need 4900–5100. No drop and no delete in it. Tested on a local Postgres: tests/sql/payment-links.check.sql §8 and
-- tests/sql/allocation-rules.check.sql.
--
--   1. the thresholds   the allocation-number thresholds (tax_allocation_rules, versions 1–4: ₪25,000 from 5.5.2024, ₪20,000 from
--                       1.1.2025, ₪10,000 from 1.1.2026, ₪5,000 from 1.6.2026) are marked confirmed with the accountant — only a
--                       row whose version, date and threshold are exactly these (a row that differs stays as it is). The mark
--                       changes labels only (the money settings, the document's hint): nothing is sent and nothing is blocked by
--                       it, and the request to the Tax Authority is still not built.
--   2. the deposit      the register's line of an appointment whose deposit was paid ("יתרה אחרי מקדמה") names the deposit's
--                       document: appointment_deposit_receipts() — the same amount as appointment_deposits() (the same rows: real
--                       deposits paid, of the business worked in now), and the documents issued for them (type and number; a
--                       cancelled one is not named). For the register (a cashier too) and the appointments screen.
-- No table, no column; appointment_deposits() stays as it is (a screen from before keeps working). The rollback is at the end.
-- ============================================================================================================================

-- ---- 0. after 20261010004300 -----------------------------------------------------------------------------------------------------
do $$ begin
  if to_regprocedure('public.appointment_deposits(uuid[])') is null or to_regclass('public.payment_requests') is null then
    raise exception 'migration 20261011005200 runs after 20261010004300 (payment links) — run that one first; nothing was changed';
  end if;
end $$;

-- ---- 1. the thresholds, confirmed with the accountant ---------------------------------------------------------------------------
update public.tax_allocation_rules r
   set verified = true,
       source_note = 'אושר מול רואה חשבון (11.10.2026): הסף ותאריך התחולה. לא נבדק כאן מול פרסום רשמי של רשות המסים.'
  from (values (1, date '2024-05-05', 25000::numeric), (2, date '2025-01-01', 20000::numeric),
               (3, date '2026-01-01', 10000::numeric), (4, date '2026-06-01', 5000::numeric)) v(version, effective_from, threshold)
 where r.version = v.version and r.effective_from = v.effective_from and r.threshold_before_vat = v.threshold and not r.verified;

-- ---- 2. a deposit's document, for the register's line -----------------------------------------------------------------------------
-- the amount: exactly appointment_deposits()'s (a deposit whose receipt waits for the owner, or was not issued, still counts — the
-- money came); receipts: [{type, number}] of the documents issued for them, not cancelled, by number — only to whoever may see the
-- business's documents (finance_business_ids(): its members, a cashier too; a super admin only with access opened — as the
-- documents' own rows)
create or replace function public.appointment_deposit_receipts(p_ids uuid[]) returns table (appointment_id uuid, amount numeric, receipts jsonb)
language sql stable security definer set search_path = public as $$
  select r.appointment_id, sum(r.paid_amount)::numeric,
         coalesce(jsonb_agg(jsonb_build_object('type', d.doc_type, 'number', d.doc_number) order by d.doc_number)
                    filter (where d.id is not null), '[]'::jsonb)
    from public.payment_requests r
    left join public.documents d
      on r.receipt_status = 'issued' and d.id = r.receipt_document_id and d.business_id = r.business_id
     and r.business_id in (select public.finance_business_ids())
     and not exists (select 1 from public.document_cancellations c where c.document_id = d.id)
   where r.kind = 'deposit' and r.status = 'paid' and not r.is_test and r.appointment_id = any(coalesce(p_ids, '{}'::uuid[]))
     and r.business_id = public.current_business_id() and r.business_id in (select public.accessible_business_ids())
   group by r.appointment_id
$$;
revoke execute on function public.appointment_deposit_receipts(uuid[]) from public, anon;
grant execute on function public.appointment_deposit_receipts(uuid[]) to authenticated;

-- ---- rollback (by hand, only if needed) ------------------------------------------------------------------------------------------
--   update public.tax_allocation_rules set verified = false, source_note = 'מקורות משניים — לא אומת מול פרסום רשמי של רשות המסים'
--    where version in (1, 2, 3, 4) and source_note like 'אושר מול רואה חשבון (11.10.2026)%';
--   revoke execute on function public.appointment_deposit_receipts(uuid[]) from authenticated;
--   (the function itself may stay: nothing calls it once the screens go back; the register falls back to appointment_deposits())
