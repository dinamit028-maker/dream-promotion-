-- Dream Commerce stage 3 (2.56): the jobs of the cart and the checkout.
-- Run once in Supabase → SQL Editor, AFTER migration 20261006003500_commerce_checkout.sql (by hand: it removes old rows,
-- and the MCP stops at a delete). Replace:
--   PASTE_STOREFRONT_URL_HERE         the storefront's own address on Vercel, e.g. https://dream-storefront.vercel.app
--   PASTE_STOREFRONT_CRON_SECRET_HERE the exact value of STOREFRONT_CRON_SECRET in the storefront's Vercel project
--   1. every minute    holds that ran out go back on sale; an order nobody paid 15 minutes after that is "expired"
--   2. every 5 minutes the storefront asks the payment provider about orders nobody confirmed for 10 minutes
--   3. every night     rate-limit counters older than a day, and carts untouched for 30 days (with their lines), are removed
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname in ('dp-commerce-release', 'dp-commerce-payments', 'dp-commerce-cleanup');

select cron.schedule('dp-commerce-release', '* * * * *', $$ select public.store_release_expired(); $$);

select cron.schedule(
  'dp-commerce-payments',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'PASTE_STOREFRONT_URL_HERE/api/cron/payments',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', 'PASTE_STOREFRONT_CRON_SECRET_HERE'),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

select cron.schedule(
  'dp-commerce-cleanup',
  '17 3 * * *',
  $$
  delete from public.rate_limits where window_start < now() - interval '1 day';
  delete from public.store_carts c where c.updated_at < now() - interval '30 days'
     and not exists (select 1 from public.orders o where o.cart_id = c.id and o.payment_status = 'pending');
  $$
);

-- Check (read only): select jobname, schedule, active from cron.job where jobname like 'dp-commerce-%';
