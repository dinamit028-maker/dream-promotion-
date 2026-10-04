-- Leads from Meta Lead Ads forms into the CRM: every 10 minutes.
-- Run once in Supabase → SQL Editor, after migration 20261004002700.
-- Replace PASTE_CRON_SECRET_HERE with the exact value of CRON_SECRET from Vercel.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname = 'dp-meta-leads';

select cron.schedule(
  'dp-meta-leads',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := 'https://dream-promotion.vercel.app/api/cron/meta-leads',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', 'PASTE_CRON_SECRET_HERE'),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
