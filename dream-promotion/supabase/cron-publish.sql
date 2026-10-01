-- Scheduled publishing: every 5 minutes, publish what is due.
-- Run once in Supabase → SQL Editor, after migration 20261001000600.
-- Replace PASTE_CRON_SECRET_HERE with the exact value of CRON_SECRET from Vercel.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname = 'dp-publish-due';

select cron.schedule(
  'dp-publish-due',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://dream-promotion.vercel.app/api/cron/publish-due',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', 'PASTE_CRON_SECRET_HERE'),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
