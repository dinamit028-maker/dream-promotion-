-- ============================================================================
-- Migration 20261002000700 — every paid endpoint goes through the same quota
-- Purpose: usage.kind gains 'transcribe', 'text' and 'render' (units = one call / one render),
--          so transcription, AI text and the final render are reserved → run → committed /
--          released like image, video and voice — with monthly, parallel and per-minute limits.
-- Safe on production: the old kind check (whatever its name) is replaced, rows are untouched.
-- Rollback: put back check (kind in ('video','image','voice')) — only if no 'transcribe' rows exist.
-- ============================================================================
do $$
declare c record;
begin
  for c in
    select con.conname from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    where ns.nspname = 'public' and rel.relname = 'usage' and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%kind%'
  loop
    execute format('alter table public.usage drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.usage add constraint usage_kind_check check (kind in ('video','image','voice','transcribe','text','render'));
