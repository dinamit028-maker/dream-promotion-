-- ============================================================================
-- Migration 20261001000400 — upload limits on the "assets" bucket
-- Purpose: Supabase Storage itself refuses files that are too big or of the wrong type,
--          whatever the browser claims. Allowed: images, videos, audio, and JSON (the caption
--          pack the reel renderer reads). Max 200 MB per file.
--          Note: on the Supabase Free plan the project-wide upload cap is 50 MB and it wins.
-- Rollback: update storage.buckets set file_size_limit = null, allowed_mime_types = null where id = 'assets';
-- ============================================================================
update storage.buckets
   set file_size_limit = 209715200,
       allowed_mime_types = array[
         'image/jpeg','image/jpg','image/png','image/webp','image/gif','image/heic','image/heif',
         'video/mp4','video/quicktime','video/webm','video/x-m4v',
         'audio/mpeg','audio/mp3','audio/mp4','audio/x-m4a','audio/aac','audio/wav','audio/x-wav','audio/webm','audio/ogg',
         'application/json'
       ]
 where id = 'assets';
