-- ============================================================================
-- Migration 20261004002100 — multi-business, stage 2b: business_id is required
-- Run only after the backfill left no row without a business (check below fails loudly otherwise).
-- ai_generations stays nullable on purpose: it is the cost ledger, its user_id is nullable
-- (on delete set null), and a failed insert there silently loses a cost record.
-- New rows keep working unchanged: trigger a_fill_business_id (migration 2000) fills business_id.
-- Idempotent. Rollback: alter table ... alter column business_id drop not null.
-- ============================================================================
do $$ declare t text; n bigint; begin
  foreach t in array array[
    'social_accounts','brands','content','media','scheduled_posts','social_posts','ad_drafts','leads','lead_activities','usage',
    'booking_settings','booking_services','appointments','catalog_items','sales','documents','document_counters','register_settings','register_shifts',
    'employees','time_entries','timeclock_settings'] loop
    execute format('select count(*) from public.%I where business_id is null', t) into n;
    if n > 0 then raise exception '% has % rows without a business — finish the backfill first', t, n; end if;
    execute format('alter table public.%I alter column business_id set not null', t);
  end loop;
end $$;
