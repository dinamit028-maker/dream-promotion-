-- ============================================================================
-- Migration 20261004002400 — multi-business, stage 5: why a scheduled post was cancelled.
-- The timer cancels the posts of a locked business with cancel_reason = 'העסק נעול' instead of
-- publishing them. '' = cancelled by the user (or not cancelled). Additive, idempotent.
-- ============================================================================
alter table public.scheduled_posts add column if not exists cancel_reason text not null default '';
