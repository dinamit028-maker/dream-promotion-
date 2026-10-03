-- ============================================================================
-- Migration 20261003001700 — security hardening (from the Supabase security advisor, 3 Oct 2026)
--   * fixed search_path on two trigger functions (lint 0011)
--   * trigger functions cannot be called directly through the API (lints 0028/0029) —
--     the triggers themselves keep working (tested: documents are still numbered for signed-in users)
-- Left on purpose: RLS-without-policy on ai_generations / scheduled_posts / social_accounts (server-only
-- tables — the browser must not read them); pg_net / btree_gist in public (moving pg_net can break the
-- cron jobs). Applied to production through the Supabase connector. Idempotent.
-- ============================================================================
alter function public.documents_immutable() set search_path = public;
alter function public.touch_updated_at() set search_path = public;
revoke execute on function public.documents_before_insert() from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
