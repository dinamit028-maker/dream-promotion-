-- Dream Commerce stages 3–4 (2.56–2.57): the jobs of the cart, the checkout and the orders that were paid.
-- Run in Supabase → SQL Editor, AFTER migrations 20261006003500_commerce_checkout.sql and 20261006003600_commerce_finance.sql
-- (by hand: it removes old rows, and the MCP stops at a delete). Running it again replaces the jobs. Replace:
--   PASTE_STOREFRONT_URL_HERE         the storefront's own address on Vercel, e.g. https://dream-storefront.vercel.app
--   PASTE_STOREFRONT_CRON_SECRET_HERE the exact value of STOREFRONT_CRON_SECRET in the storefront's Vercel project
--   PASTE_DASHBOARD_URL_HERE          the dashboard's address, e.g. https://dream-promotion.vercel.app
--   PASTE_DASHBOARD_CRON_SECRET_HERE  the exact value of CRON_SECRET in the dashboard's Vercel project
--   1. every minute    holds that ran out go back on sale; an order nobody paid 15 minutes after that is "expired"
--   2. every 5 minutes the storefront asks the payment provider about orders nobody confirmed for 10 minutes
--   4. every 2 minutes the dashboard finishes paid orders (the sale, the document), the owners' alerts and the emails
--   3. every night     rate-limit counters older than a day, and carts untouched for 30 days (with their lines), are removed
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname in ('dp-commerce-release', 'dp-commerce-payments', 'dp-commerce-cleanup', 'dp-commerce-finalize');

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
  'dp-commerce-finalize',
  '*/2 * * * *',
  $$
  select net.http_post(
    url := 'PASTE_DASHBOARD_URL_HERE/api/cron/commerce',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', 'PASTE_DASHBOARD_CRON_SECRET_HERE'),
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
