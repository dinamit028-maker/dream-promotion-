-- ============================================================================================================================
-- Migration 20261006003600 — Dream Commerce stage 4: a paid order becomes a sale, a customer, a document (2.57.0)
-- Additive: new columns on sales / orders, new tables, new functions. Functions of 3500 that change keep their signature
-- (create or replace): sf_checkout_start (a live terminal, behind the platform's switch), sf_order_paid (a live payment),
-- sf_order_view (fulfillment, the document, a request).
--   1. sales        sales.channel ('pos' | 'online'): the register and its reports count 'pos' only. A user of the app
--                   always writes 'pos' (b_sales_channel); only the database's own commerce_record_sale writes 'online'
--   2. the switch   platform_flags.commerce_live — off. Until it is turned on (SQL Editor only: no screen and no route can),
--                   every order is a test, as in stage 3. Turned on only after the owner's separate approval
--   3. customer     phone_key() = phoneDigits of crm.ts (tests compare the two on one table of examples);
--                   commerce_upsert_customer: one lead per phone / email of a business, fills empty fields only
--   4. the sale     sf_order_paid (live): paid, the units stay held ('paid') until the sale takes them;
--                   commerce_record_sale (the dashboard's server, with the VAT of vat.ts): sales row id = order id,
--                   the existing trigger moves the stock, the reservations are 'used', a purchase on the customer's card
--   5. document     orders.document_status pending → issued / blocked (order_document_done). The document itself is
--                   issued by the dashboard's server through the existing documents table and its checks
--                   (idempotency_key sale:<order id>, the same key as "a paid sale without a document")
--   6. after        fulfillment (order_set_fulfillment), a refund (sale_refunds → the order's status, an email),
--                   a customer's request (sf_order_request), email_outbox (Resend; "sent" only with the provider's id),
--                   store_alerts (the owner's phone), store_email_domains (the store's sending domain, server-written)
-- No statement here removes rows, so the MCP applies the whole file.
-- Tested on a local Postgres 16: tests/sql/commerce-finance.check.sql and tests/sql/concurrency.sh. Applied to the live
-- database only after explicit approval.
-- ============================================================================================================================

-- ---- 1. sales from the site ----------------------------------------------------------------------------------------------
alter table public.sales add column if not exists channel text not null default 'pos';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sales_channel_check' and conrelid = 'public.sales'::regclass) then
    alter table public.sales add constraint sales_channel_check check (channel in ('pos', 'online'));
  end if;
end $$;
create index if not exists sales_business_channel_idx on public.sales (business_id, channel, created_at desc);

-- invoker: the app's users (the register, the money screens) always write 'pos' and never change a sale's channel
create or replace function public.sales_channel_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user in ('anon', 'authenticated') then
    new.channel := case when tg_op = 'INSERT' then 'pos' else old.channel end;
  end if;
  return new;
end $$;
revoke execute on function public.sales_channel_guard() from public, anon, authenticated;
create or replace trigger b_sales_channel before insert or update on public.sales for each row execute function public.sales_channel_guard();

-- ---- 2. the orders of stage 4 --------------------------------------------------------------------------------------------
alter table public.orders add column if not exists document_id     uuid;                              -- the 320 / 400 issued
alter table public.orders add column if not exists document_error  text not null default '';         -- why it is blocked (Hebrew)
alter table public.orders add column if not exists tracking_number text not null default '';
alter table public.orders add column if not exists tracking_url    text not null default '';
alter table public.orders add column if not exists shipped_at      timestamptz;
alter table public.orders add column if not exists request_kind    text not null default '';         -- the customer asked: cancel / return
alter table public.orders add column if not exists request_note    text not null default '';
alter table public.orders add column if not exists requested_at    timestamptz;
alter table public.orders add column if not exists refunded_total  numeric(12,2) not null default 0;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'orders_stage4_check' and conrelid = 'public.orders'::regclass) then
    alter table public.orders add constraint orders_stage4_check check (
      length(document_error) <= 300 and length(tracking_number) <= 60
      and (tracking_url = '' or (tracking_url ~ '^https://' and length(tracking_url) <= 300))
      and request_kind in ('', 'cancel', 'return') and length(request_note) <= 500 and refunded_total >= 0);
  end if;
end $$;
-- what the dashboard's server still has to do: record the sale, issue the document
create index if not exists orders_finalize_idx on public.orders (paid_at)
  where not is_test and payment_status in ('paid', 'partially_refunded', 'refunded') and (sale_id is null or document_status = 'pending');

-- ---- 3. the platform's switch ----------------------------------------------------------------------------------------------
-- No grant at all, not even to the servers. Real sales open when the platform's owner sets commerce_live in the SQL Editor — after a backup,
-- the plan, the accountant / the tax authority and the lawyer (the owner's decision, 6.10.2026: "נעול עד אישור נפרד").
create table if not exists public.platform_flags (
  key        text primary key check (key ~ '^[a-z_]{3,40}$'),
  enabled    boolean not null default false,
  note       text not null default '' check (length(note) <= 300),
  updated_at timestamptz not null default now()
);
insert into public.platform_flags (key, enabled, note) values ('commerce_live', false, 'real sales on the sites — off until a separate approval')
on conflict (key) do nothing;

create or replace function public.commerce_live() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select f.enabled from public.platform_flags f where f.key = 'commerce_live'), false)
$$;
revoke execute on function public.commerce_live() from public, anon;
grant execute on function public.commerce_live() to authenticated, service_role;

-- ---- 4. the customer -------------------------------------------------------------------------------------------------------
-- crm.ts phoneDigits, in SQL: keep digits and '+', remove a leading '+', then a leading '00', a leading 0 → 972, digits only.
-- tests/sql/commerce-finance.check.sql holds the one table of examples; tests/commerce-finance.test.ts runs it through the TS
create or replace function public.phone_key(p text) returns text
language sql immutable parallel safe set search_path = public as $$
  select regexp_replace(case when c like '0%' then '972' || substr(c, 2) else c end, '[^0-9]', '', 'g')
    from (select case when b like '00%' then substr(b, 3) else b end as c
            from (select case when a like '+%' then substr(a, 2) else a end as b
                    from (select regexp_replace(coalesce(p, ''), '[^0-9+]', '', 'g') as a) x) y) z
$$;
create index if not exists leads_phone_key_idx on public.leads (business_id, public.phone_key(phone)) where coalesce(phone, '') <> '';
create index if not exists leads_email_key_idx on public.leads (business_id, lower(btrim(email))) where email <> '';

-- who a sale of the site is recorded by (sales.user_id, documents.user_id): the business's owner, else its first editor
create or replace function public.commerce_owner(p_business uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select m.user_id from public.business_members m
   where m.business_id = p_business and m.role in ('owner', 'editor') and m.access = 'full'
   order by (m.role = 'owner') desc, m.created_at, m.user_id limit 1
$$;

-- the customer of an order: the lead with the same phone (phone_key) or else the same email; a new lead otherwise
-- (source "אתר", status "נסגר" = a customer). An existing lead keeps every value it has — only empty fields are filled.
-- One lock per business: two orders of one new customer recorded at once make one lead, not two.
create or replace function public.commerce_upsert_customer(p_business uuid, p_owner uuid, p_name text, p_phone text, p_email text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  pk text := public.phone_key(p_phone);
  ek text := lower(btrim(coalesce(p_email, '')));
  nm text := left(btrim(coalesce(p_name, '')), 120);
  ph text := btrim(coalesce(p_phone, ''));
  found_id uuid;
begin
  if p_business is null or p_owner is null then raise exception 'business and owner are required' using errcode = '23502'; end if;
  if length(pk) < 9 then pk := ''; ph := ''; end if;
  if length(ek) > 120 or ek !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' then ek := ''; end if;
  perform pg_advisory_xact_lock(hashtextextended('dp-lead:' || p_business::text, 0));
  if pk <> '' then
    select l.id into found_id from public.leads l
     where l.business_id = p_business and coalesce(l.phone, '') <> '' and public.phone_key(l.phone) = pk
     order by l.created_at, l.id limit 1;
  end if;
  if found_id is null and ek <> '' then
    select l.id into found_id from public.leads l
     where l.business_id = p_business and l.email <> '' and lower(btrim(l.email)) = ek
     order by l.created_at, l.id limit 1;
  end if;
  if found_id is null then
    insert into public.leads (user_id, business_id, name, phone, email, source, status)
    values (p_owner, p_business, coalesce(nullif(nm, ''), 'לקוח מהאתר'), ph, ek, 'אתר', 'נסגר')
    returning id into found_id;
  else
    update public.leads l set
      name  = case when btrim(l.name) = '' and nm <> '' then nm else l.name end,
      phone = case when coalesce(l.phone, '') = '' then ph else l.phone end,
      email = case when l.email = '' then ek else l.email end
     where l.id = found_id
       and (btrim(l.name) = '' and nm <> '' or coalesce(l.phone, '') = '' and ph <> '' or l.email = '' and ek <> '');
  end if;
  return found_id;
end $$;

-- ---- 5. emails and alerts ----------------------------------------------------------------------------------------------------
-- one queue for every email to a customer, sent by the dashboard's server (Resend). "sent" only with the provider's id.
create table if not exists public.email_outbox (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses on delete restrict,
  store_id    uuid not null references public.stores on delete restrict,
  order_id    uuid not null references public.orders on delete cascade,
  kind        text not null check (kind in ('order_confirmation', 'order_ready', 'order_shipped', 'order_refunded')),
  ref         text not null default '' check (length(ref) <= 80),              -- a refund's id: one email per refund
  to_email    text not null check (length(to_email) between 3 and 120),
  status      text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed')),
  provider_id text not null default '' check (length(provider_id) <= 120),
  attempts    int not null default 0,
  last_error  text not null default '' check (length(last_error) <= 300),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  sent_at     timestamptz,
  unique (order_id, kind, ref),
  check (status <> 'sent' or provider_id <> '')
);
create index if not exists email_outbox_waiting_idx on public.email_outbox (created_at) where status in ('queued', 'sending');

-- what the owner is told (a phone notification, and a mark on the order): one per order and kind
create table if not exists public.store_alerts (
  id          bigint generated always as identity primary key,
  business_id uuid not null references public.businesses on delete restrict,
  order_id    uuid not null references public.orders on delete cascade,
  kind        text not null check (kind in ('new_order', 'late_payment', 'document_blocked', 'request', 'email_failed')),
  body        text not null default '' check (length(body) <= 300),
  pushed_at   timestamptz,
  seen_at     timestamptz,
  created_at  timestamptz not null default now(),
  unique (order_id, kind)
);
create index if not exists store_alerts_unpushed_idx on public.store_alerts (id) where pushed_at is null;

-- the store's sending domain at Resend: written only by the dashboard's server (what Resend answered), read by the screen
create table if not exists public.store_email_domains (
  store_id    uuid primary key references public.stores on delete cascade,
  business_id uuid not null references public.businesses on delete restrict,
  domain      text not null check (length(domain) <= 200 and domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?([.][a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
  provider_id text not null default '' check (length(provider_id) <= 120),
  status      text not null default 'pending' check (status in ('pending', 'verified', 'failed')),
  records     jsonb not null default '[]',                                       -- the DNS records to add
  from_name   text not null default '' check (length(from_name) <= 60),
  checked_at  timestamptz,
  created_at  timestamptz not null default now()
);

do $$
declare
  t text; op text;
  gate        constant text := 'business_id = (select public.current_business_id()) and business_id in (select public.accessible_business_ids())';
  fin         constant text := 'business_id in (select public.finance_business_ids())';
  full_access constant text := '(select public.my_access()) <> ''register''';
  writer      constant text := '(select public.can_write())';
begin
  -- read by the business's screens (the money ones: customers' emails and orders), written by the server only
  foreach t in array array['email_outbox', 'store_alerts', 'store_email_domains'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate on public.%I from authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_business_gate') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)', t || '_business_gate', t, gate, gate);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_cashier_none') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)', t || '_cashier_none', t, full_access, full_access);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_finance_privacy') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)', t || '_finance_privacy', t, fin, fin);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_business_read') then
      execute format('create policy %I on public.%I for select to authenticated using (%s)', t || '_business_read', t, gate);
    end if;
    foreach op in array array['insert', 'update', 'delete'] loop
      if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_viewer_' || op) then
        execute format('create policy %I on public.%I as restrictive for %s to authenticated %s', t || '_viewer_' || op, t, op,
          case op when 'insert' then format('with check (%s)', writer) when 'update' then format('using (%s) with check (%s)', writer, writer) else format('using (%s)', writer) end);
      end if;
    end loop;
  end loop;
  alter table public.platform_flags enable row level security;
  revoke all on public.platform_flags from anon, authenticated, service_role;   -- not even the servers: the SQL Editor only
end $$;

-- an email to the order's customer, once per order, kind and ref
create or replace function public.order_email(p_order uuid, p_kind text, p_ref text default '') returns void
language sql security definer set search_path = public as $$
  insert into public.email_outbox (business_id, store_id, order_id, kind, ref, to_email)
  select o.business_id, o.store_id, o.id, p_kind, left(coalesce(p_ref, ''), 80), o.customer_email
    from public.orders o where o.id = p_order and length(o.customer_email) >= 3
  on conflict (order_id, kind, ref) do nothing
$$;
-- an alert to the owner: again when it happens again (a document blocked a second time is pushed again)
create or replace function public.store_alert(p_order uuid, p_kind text, p_body text default '') returns void
language sql security definer set search_path = public as $$
  insert into public.store_alerts (business_id, order_id, kind, body)
  select o.business_id, o.id, p_kind, left(coalesce(p_body, ''), 300) from public.orders o where o.id = p_order
  on conflict (order_id, kind) do update set body = excluded.body, created_at = now(), pushed_at = null, seen_at = null
$$;
revoke execute on function public.order_email(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.store_alert(uuid, text, text) from public, anon, authenticated;

-- ---- 6. the storefront: a live terminal, a live payment ------------------------------------------------------------------
-- "לתשלום" (3500), now with a live terminal: an order is real only when the business's terminal is live AND the platform's
-- switch is on (commerce_live); a live terminal while the switch is off → 'live_not_yet', as in stage 3. Otherwise unchanged.
create or replace function public.sf_checkout_start(p_store uuid, p_cart text, p_order_token text, p_customer jsonb,
                                                    p_ip_hash text default '', p_preview boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s public.stores; c public.store_carts; a public.payment_accounts; o public.orders; l record; cp jsonb;
  bad jsonb := '[]'; fields text[] := '{}'; free int; pr numeric; sub numeric := 0; disc numeric := 0; ship numeric := 0;
  name text := btrim(coalesce(p_customer->>'name', ''));
  phone text := regexp_replace(coalesce(p_customer->>'phone', ''), '[^0-9+]', '', 'g');
  email text := lower(btrim(coalesce(p_customer->>'email', '')));
  method text := coalesce(p_customer->>'method', '');
  addr jsonb := '{}'; num int; pos int := 0;
begin
  s := public.sf_selling_store(p_store, p_preview);
  if s.id is null then return jsonb_build_object('ok', false, 'error', 'store'); end if;
  if not s.checkout_enabled then return jsonb_build_object('ok', false, 'error', 'checkout_off'); end if;
  select * into a from public.payment_accounts where business_id = s.business_id;
  if a.business_id is null then return jsonb_build_object('ok', false, 'error', 'payment'); end if;
  if a.mode <> 'test' and not public.commerce_live() then return jsonb_build_object('ok', false, 'error', 'live_not_yet'); end if;
  if coalesce(p_order_token, '') !~ '^[0-9a-f]{64}$' then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  select * into c from public.store_carts where token_hash = p_cart and store_id = s.id;
  if c.id is null or not exists (select 1 from public.store_cart_lines where cart_id = c.id and qty > 0) then
    return jsonb_build_object('ok', false, 'error', 'empty');
  end if;

  -- the customer's details
  if length(name) not between 2 and 80 then fields := array_append(fields, 'name'); end if;
  if phone ~ '^\+?972[0-9]{8,9}$' then phone := regexp_replace(phone, '^\+?972', '0'); end if;   -- +972 50… → 050…
  if phone !~ '^0[0-9]{8,9}$' and phone !~ '^\+[0-9]{9,15}$' then fields := array_append(fields, 'phone'); end if;
  if length(email) > 120 or email !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' then fields := array_append(fields, 'email'); end if;
  if method = 'pickup' and not s.pickup_enabled or method = 'delivery' and not s.delivery_enabled or method not in ('pickup', 'delivery') then
    fields := array_append(fields, 'method');
  end if;
  if method = 'delivery' then
    addr := jsonb_build_object('city', btrim(coalesce(p_customer->>'city', '')), 'street', btrim(coalesce(p_customer->>'street', '')),
                               'house', btrim(coalesce(p_customer->>'house', '')), 'apartment', btrim(coalesce(p_customer->>'apartment', '')));
    if length(addr->>'city') not between 2 and 60 then fields := array_append(fields, 'city'); end if;
    if length(addr->>'street') not between 2 and 80 then fields := array_append(fields, 'street'); end if;
    if length(addr->>'house') not between 1 and 10 then fields := array_append(fields, 'house'); end if;
    if length(addr->>'apartment') > 10 then fields := array_append(fields, 'apartment'); end if;
  end if;
  if length(coalesce(p_customer->>'notes', '')) > 500 then fields := array_append(fields, 'notes'); end if;
  if coalesce(p_customer->>'terms', '') <> 'true' then fields := array_append(fields, 'terms'); end if;
  if cardinality(fields) > 0 then return jsonb_build_object('ok', false, 'error', 'details', 'fields', to_jsonb(fields)); end if;

  -- a few open orders per shopper at a time: holding a store's stock is not a game
  if coalesce(p_ip_hash, '') <> '' and (select count(*) from public.orders x where x.store_id = s.id and x.ip_hash = p_ip_hash
                                          and x.payment_status = 'pending' and x.expires_at > now()) >= 3 then
    return jsonb_build_object('ok', false, 'error', 'too_many_open');
  end if;

  -- lock the products, then check what is left of each after what is held
  perform 1 from public.catalog_items i
    where i.id in (select cl.item_id from public.store_cart_lines cl where cl.cart_id = c.id and cl.qty > 0)
    order by i.id for update;
  for l in
    select cl.qty, cl.item_id, cl.variant_id, i as itm, v as var
      from public.store_cart_lines cl
      join public.catalog_items i on i.id = cl.item_id
      left join public.catalog_variants v on v.id = cl.variant_id
     where cl.cart_id = c.id and cl.qty > 0
     order by cl.added_at, cl.item_id, cl.variant_id
  loop
    pr := public.sf_line_price(l.itm, l.var);
    if (l.itm).business_id <> s.business_id or not (l.itm).publish_online or not (l.itm).active or (l.itm).slug is null or pr is null
       or ((l.itm).has_variants and ((l.var).id is null or not (l.var).active or (l.var).item_id <> (l.itm).id))
       or (not (l.itm).has_variants and l.variant_id is not null) then
      bad := bad || jsonb_build_object('item', l.item_id, 'variant', l.variant_id, 'name', (l.itm).name, 'available', 0);
      continue;
    end if;
    if (l.itm).track_stock then
      free := case when (l.var).id is not null then (l.var).stock_qty else (l.itm).stock_qty end - public.sf_reserved((l.itm).id, (l.var).id);
      if l.qty > free then
        bad := bad || jsonb_build_object('item', l.item_id, 'variant', l.variant_id, 'name', (l.itm).name, 'available', greatest(free, 0));
        continue;
      end if;
    end if;
    sub := sub + pr * l.qty;
  end loop;
  if jsonb_array_length(bad) > 0 then return jsonb_build_object('ok', false, 'error', 'stock', 'lines', bad); end if;

  cp := public.sf_coupon_eval(s, c.coupon_code, sub);
  if cp ? 'error' then return jsonb_build_object('ok', false, 'error', 'coupon', 'reason', cp->>'error', 'min', cp->'min'); end if;
  disc := coalesce((cp->>'discount')::numeric, 0);
  ship := case when method = 'delivery' then public.sf_delivery_price(s, sub - disc) else 0 end;
  if sub - disc + ship <= 0 then return jsonb_build_object('ok', false, 'error', 'zero_total'); end if;

  insert into public.store_order_counters (business_id, last) values (s.business_id, 1001)
  on conflict (business_id) do update set last = store_order_counters.last + 1 returning last into num;
  insert into public.orders (business_id, store_id, number, token_hash, cart_id, is_test, currency, subtotal, discount, shipping, total,
                             coupon_code, customer_name, customer_phone, customer_email, delivery_method, address, notes,
                             terms_accepted_at, provider, expires_at, ip_hash)
  values (s.business_id, s.id, num, p_order_token, c.id, a.mode = 'test', s.currency, sub, disc, ship, sub - disc + ship,
          coalesce(cp->>'code', ''), name, phone, email, method, addr, btrim(coalesce(p_customer->>'notes', '')),
          now(), a.provider, now() + make_interval(mins => s.reserve_minutes), left(coalesce(p_ip_hash, ''), 64))
  returning * into o;

  for l in
    select cl.qty, cl.item_id, cl.variant_id, i as itm, v as var
      from public.store_cart_lines cl
      join public.catalog_items i on i.id = cl.item_id
      left join public.catalog_variants v on v.id = cl.variant_id
     where cl.cart_id = c.id and cl.qty > 0
     order by cl.added_at, cl.item_id, cl.variant_id
  loop
    pos := pos + 1;
    pr := public.sf_line_price(l.itm, l.var);
    insert into public.order_lines (order_id, business_id, item_id, variant_id, name, variant_label, sku, image_url, unit_price, qty, line_total, position)
    values (o.id, s.business_id, l.item_id, l.variant_id, (l.itm).name,
            case when (l.var).id is not null then concat_ws(' / ', nullif((l.var).option1, ''), nullif((l.var).option2, ''), nullif((l.var).option3, '')) else '' end,
            coalesce(nullif((l.var).sku, ''), (l.itm).sku, ''),
            coalesce(public.sf_image((l.itm).id, (l.itm).image_url)->>'url', ''),
            pr, l.qty, pr * l.qty, pos);
    if (l.itm).track_stock then
      insert into public.stock_reservations (business_id, order_id, item_id, variant_id, qty, expires_at)
      values (s.business_id, o.id, l.item_id, l.variant_id, l.qty, o.expires_at);
    end if;
  end loop;
  perform public.order_event(o.id, 'created', jsonb_build_object('total', o.total, 'test', o.is_test, 'expires_at', o.expires_at));

  return jsonb_build_object('ok', true,
    'order', jsonb_build_object('id', o.id, 'number', o.number, 'total', trim_scale(o.total), 'currency', o.currency,
               'name', o.customer_name, 'email', o.customer_email, 'phone', o.customer_phone, 'expires_at', o.expires_at,
               'lines', (select jsonb_agg(jsonb_build_object('name', x.name || case when x.variant_label <> '' then ' — ' || x.variant_label else '' end,
                                                            'qty', x.qty, 'price', trim_scale(x.unit_price)) order by x.position)
                           from public.order_lines x where x.order_id = o.id),
               'shipping', trim_scale(o.shipping), 'discount', trim_scale(o.discount)),
    'account', jsonb_build_object('provider', a.provider, 'mode', a.mode, 'sealed', a.sealed, 'page_uid', a.page_uid));
end $$;

-- the provider confirmed (by a direct question, never by a notice alone) that this transaction paid this order.
-- Locks the order: the same transaction again → 'already'; another transaction → 'double' (logged, nothing changes); a
-- different amount or currency → 'mismatch' (logged, nothing changes).
-- Test: test_paid, the units are released — no sale, no stock movement, no document, no customer (as in stage 3).
-- Live: paid; the units stay held ('paid') until the dashboard's server records the sale (commerce_record_sale), which
-- takes them. A payment that came after the hold ran out is accepted (a paid order is never lost) and the owner is told
-- to check the stock. Both: the coupon counts one use, the cart empties, the customer gets a confirmation email.
create or replace function public.sf_order_paid(p_store uuid, p_order uuid, p_provider text, p_txn text, p_amount numeric, p_currency text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o public.orders; was text; late boolean;
begin
  select * into o from public.orders where id = p_order and store_id = p_store for update;
  if o.id is null then return jsonb_build_object('result', 'not_found'); end if;
  if o.provider <> p_provider or coalesce(p_txn, '') = '' then
    perform public.order_event(o.id, 'payment_rejected', jsonb_build_object('reason', 'provider', 'provider', p_provider));
    return jsonb_build_object('result', 'rejected');
  end if;
  if o.payment_status in ('paid', 'test_paid', 'refunded', 'partially_refunded') then
    if o.provider_txn = p_txn then return jsonb_build_object('result', 'already', 'status', o.payment_status); end if;
    perform public.order_event(o.id, 'double_payment', jsonb_build_object('txn', p_txn, 'amount', p_amount));
    return jsonb_build_object('result', 'double', 'status', o.payment_status);
  end if;
  if p_amount is distinct from o.total or upper(coalesce(p_currency, '')) <> o.currency then
    perform public.order_event(o.id, 'amount_mismatch', jsonb_build_object('txn', p_txn, 'amount', p_amount, 'currency', p_currency));
    return jsonb_build_object('result', 'mismatch', 'status', o.payment_status);
  end if;
  was := o.payment_status;
  if o.is_test then
    update public.orders set payment_status = 'test_paid', provider_txn = p_txn, paid_at = now(), updated_at = now() where id = o.id;
    update public.stock_reservations set status = 'released', updated_at = now() where order_id = o.id and status in ('held', 'paid');
  else
    late := was <> 'pending' or exists (select 1 from public.stock_reservations r where r.order_id = o.id and r.status = 'released');
    update public.orders set payment_status = 'paid', provider_txn = p_txn, paid_at = now(), document_status = 'pending', updated_at = now()
     where id = o.id;
    update public.stock_reservations set status = 'paid', updated_at = now() where order_id = o.id and status = 'held';
    perform public.store_alert(o.id, 'new_order', '');
    if late then
      perform public.store_alert(o.id, 'late_payment', 'התשלום הגיע אחרי שהשמירה על המלאי פגה — כדאי לבדוק שיש מלאי לכל הפריטים.');
    end if;
  end if;
  if o.coupon_code <> '' then
    update public.store_coupons set used_count = used_count + 1 where store_id = o.store_id and code = o.coupon_code;
  end if;
  if o.cart_id is not null then update public.store_cart_lines set qty = 0, updated_at = now() where cart_id = o.cart_id and qty > 0; end if;
  perform public.order_email(o.id, 'order_confirmation', '');
  perform public.order_event(o.id, case when o.is_test then 'test_paid' else 'paid' end,
                             jsonb_build_object('txn', p_txn, 'amount', p_amount, 'late', was <> 'pending'));
  return jsonb_build_object('result', 'ok', 'status', case when o.is_test then 'test_paid' else 'paid' end);
end $$;

-- the customer asks to cancel or return (the order's page, or /cancel with the order's number and email): recorded on the
-- order and told to the owner. It moves no money by itself — the owner decides and refunds from the dashboard.
create or replace function public.order_request_apply(p_order uuid, p_kind text, p_note text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o public.orders;
begin
  if p_kind not in ('cancel', 'return') or length(coalesce(p_note, '')) > 500 then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  select * into o from public.orders where id = p_order for update;
  if o.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if o.payment_status not in ('paid', 'partially_refunded', 'test_paid') then return jsonb_build_object('ok', false, 'error', 'not_paid'); end if;
  if o.request_kind <> '' then return jsonb_build_object('ok', false, 'error', 'already', 'kind', o.request_kind); end if;
  update public.orders set request_kind = p_kind, request_note = btrim(coalesce(p_note, '')), requested_at = now(), updated_at = now()
   where id = o.id;
  perform public.order_event(o.id, 'request', jsonb_build_object('kind', p_kind));
  perform public.store_alert(o.id, 'request', case p_kind when 'cancel' then 'הלקוח ביקש לבטל את ההזמנה' else 'הלקוח ביקש להחזיר את ההזמנה' end);
  return jsonb_build_object('ok', true, 'kind', p_kind, 'number', o.number);
end $$;
revoke execute on function public.order_request_apply(uuid, text, text) from public, anon, authenticated;

-- by the order's link (the checkout's token) or by its id (the storefront checked the email's signed link first)
create or replace function public.sf_order_request(p_store uuid, p_order_token text, p_kind text, p_note text)
returns jsonb language sql security definer set search_path = public as $$
  select coalesce((select public.order_request_apply(o.id, p_kind, p_note) from public.orders o
                    where o.token_hash = p_order_token and o.store_id = p_store), jsonb_build_object('ok', false, 'error', 'not_found'))
$$;
create or replace function public.sf_order_request_by_id(p_store uuid, p_order uuid, p_kind text, p_note text)
returns jsonb language sql security definer set search_path = public as $$
  select coalesce((select public.order_request_apply(o.id, p_kind, p_note) from public.orders o
                    where o.id = p_order and o.store_id = p_store), jsonb_build_object('ok', false, 'error', 'not_found'))
$$;
-- /cancel: the order's number and the email it was made with (both must match; "not found" says nothing more)
create or replace function public.sf_order_request_by_number(p_store uuid, p_number int, p_email text, p_kind text, p_note text)
returns jsonb language sql security definer set search_path = public as $$
  select coalesce((select public.order_request_apply(o.id, p_kind, p_note) from public.orders o
                    where o.store_id = p_store and o.number = p_number and o.customer_email = lower(btrim(coalesce(p_email, '')))
                      and length(btrim(coalesce(p_email, ''))) >= 3),
                  jsonb_build_object('ok', false, 'error', 'not_found'))
$$;

-- an order as its page shows it (the customer's link, or the server by id). doc_token: the issued document's share token —
-- the storefront's server fetches the document with it, so the customer sees it on the business's own domain.
create or replace function public.sf_order_view(o public.orders) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', o.id, 'number', o.number, 'status', o.payment_status, 'test', o.is_test, 'currency', o.currency,
    'subtotal', trim_scale(o.subtotal), 'discount', trim_scale(o.discount), 'shipping', trim_scale(o.shipping), 'total', trim_scale(o.total),
    'coupon', o.coupon_code, 'method', o.delivery_method, 'name', o.customer_name, 'provider', o.provider, 'page', o.provider_page,
    'created_at', o.created_at, 'expires_at', o.expires_at, 'paid_at', o.paid_at,
    'fulfillment', o.fulfillment_status, 'tracking', o.tracking_number, 'tracking_url', o.tracking_url,
    'document', o.document_status, 'request', o.request_kind, 'refunded', trim_scale(o.refunded_total), 'state', o.state,
    'doc_token', (select d.share_token from public.documents d where d.id = o.document_id and d.business_id = o.business_id),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('name', x.name, 'variant', x.variant_label, 'qty', x.qty,
                                                           'price', trim_scale(x.unit_price), 'total', trim_scale(x.line_total), 'image', x.image_url)
                                        order by x.position) from public.order_lines x where x.order_id = o.id), '[]'::jsonb))
$$;
revoke execute on function public.sf_order_view(public.orders) from public, anon, authenticated;

-- ---- 7. the dashboard's server: the sale, the document -----------------------------------------------------------------------
-- A paid live order becomes a sale, in one transaction. The VAT comes from the dashboard (vat.ts, the business's rate) and
-- is checked here against the order's total (one agora). The sale's id is the order's: a second call changes nothing.
-- The existing trigger of sales moves the stock; the units held for the order are then 'used'.
create or replace function public.commerce_record_sale(p_order uuid, p_vat_rate numeric, p_vat_amount numeric)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o public.orders; owner_id uuid; lead uuid; items jsonb; units int; expect numeric;
begin
  select * into o from public.orders where id = p_order for update;
  if o.id is null then return jsonb_build_object('result', 'not_found'); end if;
  if o.sale_id is not null then return jsonb_build_object('result', 'already', 'sale', o.sale_id, 'lead', o.lead_id); end if;
  if o.is_test or o.payment_status <> 'paid' then return jsonb_build_object('result', 'not_paid', 'status', o.payment_status); end if;
  if p_vat_rate is null or p_vat_rate < 0 or p_vat_rate > 50 or p_vat_amount is null or p_vat_amount < 0 then
    raise exception 'vat_invalid' using errcode = '22023';
  end if;
  expect := round(o.total * p_vat_rate / (100 + p_vat_rate), 2);
  if abs(p_vat_amount - expect) > 0.01 then raise exception 'vat_mismatch: % expected', expect using errcode = '22023'; end if;
  owner_id := public.commerce_owner(o.business_id);
  if owner_id is null then raise exception 'business_owner_missing' using errcode = '23502'; end if;
  lead := public.commerce_upsert_customer(o.business_id, owner_id, o.customer_name, o.customer_phone, o.customer_email);

  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'name', x.name || case when x.variant_label <> '' then ' — ' || x.variant_label else '' end,
           'price', trim_scale(x.unit_price), 'qty', x.qty, 'itemId', x.item_id, 'variantId', x.variant_id, 'kind', 'product'))
           order by x.position), '[]'::jsonb), coalesce(sum(x.qty), 0)
    into items, units from public.order_lines x where x.order_id = o.id;
  if o.shipping > 0 then
    items := items || jsonb_build_array(jsonb_build_object('name', 'משלוח', 'price', trim_scale(o.shipping), 'qty', 1, 'kind', 'service'));
  end if;
  insert into public.sales (id, user_id, business_id, lead_id, customer_name, customer_phone, items, subtotal, discount, total,
                            vat_rate, vat_amount, method, status, note, paid_at, channel)
  values (o.id, owner_id, o.business_id, lead, o.customer_name, o.customer_phone, items, o.subtotal + o.shipping, o.discount, o.total,
          p_vat_rate, p_vat_amount, 'card', 'paid', 'הזמנה באתר #' || o.number, coalesce(o.paid_at, now()), 'online')
  on conflict (id) do nothing;
  update public.stock_reservations set status = 'used', updated_at = now() where order_id = o.id and status in ('held', 'paid');
  update public.orders set sale_id = o.id, lead_id = lead, updated_at = now(),
         document_status = case when document_status = 'not_required' then 'pending' else document_status end
   where id = o.id;
  insert into public.lead_activities (user_id, business_id, lead_id, kind, body)
  values (owner_id, o.business_id, lead, 'purchase',
          format('הזמנה באתר #%s · %s%s · %s', o.number, case o.currency when 'ILS' then '₪' else o.currency || ' ' end, trim_scale(o.total),
                 case when units = 1 then 'פריט אחד' else units || ' פריטים' end));
  update public.leads set value = value + o.total where id = lead;
  perform public.order_event(o.id, 'sale_recorded', jsonb_build_object('lead', lead, 'vat_rate', p_vat_rate, 'vat', p_vat_amount));
  return jsonb_build_object('result', 'ok', 'sale', o.id, 'lead', lead);
end $$;

-- the document of the order's sale was issued (p_document), or cannot be until the business fixes something (p_error, in
-- Hebrew): blocked, shown on the order, told to the owner. Only an issued document of this order's sale is accepted.
create or replace function public.order_document_done(p_order uuid, p_document uuid, p_error text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare o public.orders;
begin
  select * into o from public.orders where id = p_order for update;
  if o.id is null or o.sale_id is null then return jsonb_build_object('result', 'not_found'); end if;
  if p_document is not null then
    if not exists (select 1 from public.documents d where d.id = p_document and d.sale_id = o.sale_id and d.business_id = o.business_id) then
      raise exception 'the document is not of this order' using errcode = '23514';
    end if;
    if o.document_status = 'issued' and o.document_id = p_document then return jsonb_build_object('result', 'already'); end if;
    update public.orders set document_status = 'issued', document_id = p_document, document_error = '', updated_at = now() where id = o.id;
    perform public.order_event(o.id, 'document_issued', jsonb_build_object('document', p_document));
    return jsonb_build_object('result', 'ok', 'status', 'issued');
  end if;
  if o.document_status = 'issued' then return jsonb_build_object('result', 'already'); end if;
  update public.orders set document_status = 'blocked', document_error = left(coalesce(nullif(btrim(p_error), ''), 'המסמך לא הופק'), 300), updated_at = now()
   where id = o.id;
  perform public.order_event(o.id, 'document_blocked', jsonb_build_object('error', left(coalesce(p_error, ''), 300)));
  perform public.store_alert(o.id, 'document_blocked', 'המסמך להזמנה לא הופק: ' || left(coalesce(p_error, ''), 200));
  return jsonb_build_object('result', 'ok', 'status', 'blocked');
end $$;

-- a blocked document is tried again only after the business fixed what blocked it (the order's page: "נסו שוב")
create or replace function public.order_document_retry(p_order uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  update public.orders set document_status = 'pending', updated_at = now() where id = p_order and document_status = 'blocked' and sale_id is not null;
  if not found then return jsonb_build_object('result', 'ignored'); end if;
  perform public.order_event(p_order, 'document_retry', '{}');
  return jsonb_build_object('result', 'ok');
end $$;

-- live orders the server still has to finish (record the sale, issue the document) — the cron's list
create or replace function public.commerce_pending(p_limit int default 20) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x.id), '[]'::jsonb) from (
    select o.id from public.orders o
     where not o.is_test and o.payment_status in ('paid', 'partially_refunded', 'refunded') and (o.sale_id is null or o.document_status = 'pending')
     order by o.paid_at limit least(greatest(coalesce(p_limit, 20), 1), 100)) x
$$;

-- a refund of an online sale (from the order's page, or from the register): the order's money status, an email
create or replace function public.orders_after_refund() returns trigger
language plpgsql security definer set search_path = public as $$
declare o public.orders; done numeric;
begin
  select * into o from public.orders where sale_id = new.sale_id and business_id = new.business_id for update;
  if o.id is null then return null; end if;
  select coalesce(sum(r.amount), 0) into done from public.sale_refunds r where r.sale_id = new.sale_id;
  update public.orders set refunded_total = done, updated_at = now(),
         payment_status = case when done >= o.total then 'refunded' else 'partially_refunded' end
   where id = o.id;
  perform public.order_event(o.id, 'refund', jsonb_build_object('refund', new.id, 'amount', new.amount, 'restock', new.restock));
  perform public.order_email(o.id, 'order_refunded', new.id::text);
  return null;
end $$;
revoke execute on function public.orders_after_refund() from public, anon, authenticated;
create or replace trigger sale_refunds_order after insert on public.sale_refunds for each row execute function public.orders_after_refund();

-- the emails waiting to go: taken by one sender at a time (skip locked); one that hung 10 minutes is taken again (Resend
-- gets the email's id as its idempotency key, so a retry never sends twice)
create or replace function public.email_outbox_claim(p_limit int default 20) returns setof public.email_outbox
language sql security definer set search_path = public as $$
  update public.email_outbox e set status = 'sending', attempts = e.attempts + 1, updated_at = now()
   where e.id in (select x.id from public.email_outbox x
                   where (x.status = 'queued' or (x.status = 'sending' and x.updated_at < now() - interval '10 minutes')) and x.attempts < 5
                   order by x.created_at limit least(greatest(coalesce(p_limit, 20), 1), 100)
                   for update skip locked)
  returning e.*
$$;
-- what the provider answered: an id → sent; otherwise again later, and after 5 tries (or a final error) failed + the owner told
create or replace function public.email_outbox_done(p_id uuid, p_provider_id text, p_error text default '', p_final boolean default false)
returns text language plpgsql security definer set search_path = public as $$
declare e public.email_outbox;
begin
  select * into e from public.email_outbox where id = p_id for update;
  if e.id is null then return 'not_found'; end if;
  if e.status = 'sent' then return 'sent'; end if;
  if btrim(coalesce(p_provider_id, '')) <> '' then
    update public.email_outbox set status = 'sent', provider_id = left(btrim(p_provider_id), 120), sent_at = now(), last_error = '', updated_at = now()
     where id = e.id;
    perform public.order_event(e.order_id, 'email_sent', jsonb_build_object('kind', e.kind));
    return 'sent';
  end if;
  if p_final or e.attempts >= 5 then
    update public.email_outbox set status = 'failed', last_error = left(coalesce(p_error, ''), 300), updated_at = now() where id = e.id;
    perform public.order_event(e.order_id, 'email_failed', jsonb_build_object('kind', e.kind, 'error', left(coalesce(p_error, ''), 120)));
    perform public.store_alert(e.order_id, 'email_failed', 'מייל ללקוח לא נשלח: ' || left(coalesce(p_error, ''), 200));
    return 'failed';
  end if;
  update public.email_outbox set status = 'queued', last_error = left(coalesce(p_error, ''), 300), updated_at = now() where id = e.id;
  return 'queued';
end $$;

-- the alerts not yet sent to the owners' phones, taken once
create or replace function public.store_alerts_claim(p_limit int default 20) returns jsonb
language sql security definer set search_path = public as $$
  with c as (
    update public.store_alerts a set pushed_at = now()
     where a.id in (select x.id from public.store_alerts x where x.pushed_at is null order by x.id
                     limit least(greatest(coalesce(p_limit, 20), 1), 100) for update skip locked)
    returning a.*)
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'business', c.business_id, 'order', c.order_id, 'kind', c.kind, 'body', c.body,
                                               'number', o.number, 'total', trim_scale(o.total), 'name', o.customer_name, 'test', o.is_test)
                            order by c.id), '[]'::jsonb)
    from c join public.orders o on o.id = c.order_id
$$;

-- ---- 8. the dashboard's screens -------------------------------------------------------------------------------------------
-- where an order stands with the goods; "ready" (pickup) and "shipped" (delivery) email the customer once
create or replace function public.order_set_fulfillment(p_order uuid, p_status text, p_tracking text default '', p_url text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare b uuid := public.current_business_id(); o public.orders; trk text := left(btrim(coalesce(p_tracking, '')), 60); url text := btrim(coalesce(p_url, ''));
begin
  if b is null or b not in (select public.accessible_business_ids()) or b not in (select public.finance_business_ids())
     or public.my_access() = 'register' or not public.can_write() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into o from public.orders where id = p_order and business_id = b for update;
  if o.id is null then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_status not in ('unfulfilled', 'processing', 'ready', 'shipped', 'delivered', 'returned') then
    return jsonb_build_object('ok', false, 'error', 'status');
  end if;
  if o.payment_status not in ('paid', 'partially_refunded', 'refunded', 'test_paid') then return jsonb_build_object('ok', false, 'error', 'not_paid'); end if;
  if url <> '' and (url !~ '^https://' or length(url) > 300) then return jsonb_build_object('ok', false, 'error', 'url'); end if;
  if o.fulfillment_status = p_status and (p_status <> 'shipped' or (o.tracking_number = trk and o.tracking_url = url)) then
    return jsonb_build_object('ok', true, 'same', true);
  end if;
  update public.orders set fulfillment_status = p_status, updated_at = now(),
         tracking_number = case when p_status = 'shipped' then trk else tracking_number end,
         tracking_url    = case when p_status = 'shipped' then url else tracking_url end,
         shipped_at      = case when p_status = 'shipped' then coalesce(shipped_at, now()) else shipped_at end
   where id = o.id;
  perform public.order_event(o.id, 'fulfillment', jsonb_build_object('from', o.fulfillment_status, 'to', p_status, 'tracking', trk));
  if p_status = 'shipped' and o.delivery_method = 'delivery' then perform public.order_email(o.id, 'order_shipped', ''); end if;
  if p_status = 'ready' and o.delivery_method = 'pickup' then perform public.order_email(o.id, 'order_ready', ''); end if;
  return jsonb_build_object('ok', true);
end $$;

-- the owner saw the order's alerts
create or replace function public.store_alerts_seen(p_order uuid) returns void
language plpgsql security definer set search_path = public as $$
declare b uuid := public.current_business_id();
begin
  if b is null or b not in (select public.accessible_business_ids()) or b not in (select public.finance_business_ids())
     or public.my_access() = 'register' then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.store_alerts set seen_at = now() where business_id = b and order_id = p_order and seen_at is null;
end $$;

do $$
declare f text;
begin
  -- the storefront's server and the dashboard's server (service role) only
  foreach f in array array['public.sf_order_request(uuid, text, text, text)', 'public.sf_order_request_by_id(uuid, uuid, text, text)',
    'public.sf_order_request_by_number(uuid, int, text, text, text)', 'public.commerce_owner(uuid)',
    'public.commerce_upsert_customer(uuid, uuid, text, text, text)', 'public.commerce_record_sale(uuid, numeric, numeric)',
    'public.order_document_done(uuid, uuid, text)', 'public.order_document_retry(uuid)', 'public.commerce_pending(int)',
    'public.email_outbox_claim(int)', 'public.email_outbox_done(uuid, text, text, boolean)', 'public.store_alerts_claim(int)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  -- the screens (each checks the business worked in now, its money open to the caller, never a cashier)
  foreach f in array array['public.order_set_fulfillment(uuid, text, text, text)', 'public.store_alerts_seen(uuid)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  revoke execute on function public.sales_channel_guard() from public, anon, authenticated;
end $$;
