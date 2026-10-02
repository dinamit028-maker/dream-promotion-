-- ============================================================================
-- Migration 20261002000800 — reel projects + media source metadata
-- Purpose:
--  * content.reel — the reel studio project (scenes, clips, narration, captions, final reel).
--    It exists in production but was never in source control; a new project would lose every
--    reel. Now it is.
--  * media.meta — where a file came from (Instagram id, permalink, date, caption, account),
--    kept for imports so the origin of every file is known and nothing is downloaded twice.
-- Idempotent; nothing is changed in existing rows.
-- Rollback: alter table public.media drop column meta; (content.reel holds user projects — keep it.)
-- ============================================================================
alter table public.content add column if not exists reel jsonb;
alter table public.media   add column if not exists meta jsonb not null default '{}'::jsonb;
create index if not exists media_user_source_idx on public.media (user_id, source);
create index if not exists media_ig_id_idx on public.media ((meta->>'igId')) where meta ? 'igId';
