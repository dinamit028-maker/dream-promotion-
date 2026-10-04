-- ============================================================================
-- Migration 20261004002600 — multi-business, stage 7: one-per-business keys.
-- RUN BY HAND in the Supabase SQL Editor (it replaces keys, which the MCP connection can not do).
-- No data is removed: the replacing unique indexes already exist since stage 2 and are promoted.
--   brands / register_settings / booking_settings / timeclock_settings: one row per BUSINESS (was per user)
--   document_counters: numbering per (business, document type) (was per user)
--   documents: the number is unique per business — the per-user duplicate rule goes away
-- Without this, the super admin can not save settings or issue documents in a second business.
-- Idempotent.
-- ============================================================================
do $$
declare t text;
begin
  foreach t in array array['brands', 'register_settings', 'booking_settings', 'timeclock_settings'] loop
    if exists (select 1 from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
               where c.conrelid = ('public.' || t)::regclass and c.contype = 'p' and a.attname = 'user_id') then
      execute format('alter table public.%I drop constraint %I', t, t || '_pkey');
      execute format('alter table public.%I add constraint %I primary key using index %I', t, t || '_pkey', t || '_business_uq');
    end if;
  end loop;
  if exists (select 1 from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
             where c.conrelid = 'public.document_counters'::regclass and c.contype = 'p' and a.attname = 'user_id') then
    alter table public.document_counters drop constraint document_counters_pkey;
    alter table public.document_counters add constraint document_counters_pkey primary key using index document_counters_business_uq;
  end if;
  alter table public.documents drop constraint if exists documents_user_id_doc_type_doc_number_key;
end $$;
