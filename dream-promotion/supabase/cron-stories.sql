-- Instagram stories → media library, every 10 minutes.
-- Run once in Supabase → SQL Editor.
-- Replace PASTE_CRON_SECRET_HERE with the exact value of CRON_SECRET from Vercel (Settings → Environment Variables).

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- running this file again replaces the job instead of adding a second one
select cron.unschedule(jobid) from cron.job where jobname = 'dp-sync-instagram-stories';

select cron.schedule(
  'dp-sync-instagram-stories',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := 'https://dream-promotion.vercel.app/api/cron/meta-stories',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', 'PASTE_CRON_SECRET_HERE'),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

-- check it ran (after 10 minutes):
-- select status_code, content::text, created from net._http_response order by created desc limit 5;
