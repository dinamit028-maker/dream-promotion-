-- 2.48.0 — the picture of the post a comment was written on (a copy in storage, so it does not expire with Meta's link).
-- Additions only; idempotent.
alter table public.social_messages add column if not exists post_image text not null default '';
