-- Comments and messages from Meta into the leads board ("💬 תגובות"): every 10 minutes.
-- Run once in Supabase → SQL Editor, after migration 20261004002800.
-- Replace PASTE_CRON_SECRET_HERE with the exact value of CRON_SECRET from Vercel.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname = 'dp-meta-inbox';

select cron.schedule(
  'dp-meta-inbox',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := 'https://dream-promotion.vercel.app/api/cron/meta-inbox',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', 'PASTE_CRON_SECRET_HERE'),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
