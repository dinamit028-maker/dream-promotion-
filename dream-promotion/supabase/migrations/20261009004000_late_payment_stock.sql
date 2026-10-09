-- 2.79.0 — a payment that comes after the order's hold ran out (STATUS, risk 23).
-- The money is already taken, so the payment is still accepted (as since 2.57). What changes:
--   1. "late" is seen also before the minute cron released the hold (a hold past its time already holds nothing —
--      sf_reserved), and the timeline says the same as the alert;
--   2. what is missing is counted when the payment comes: per product (and size / colour), ordered vs. free for this order
--      (stock minus the units held for OTHER orders), kept on the order (orders.stock_short) and written in the owner's alert.
-- Stock is not clamped: the sale still takes all its units, so a product can go below 0 — that number is the units owed to
-- this customer, and a refund of the order brings it back exactly. The order says it; the owner decides (restock or refund).
-- Additions only: one nullable column, and sf_order_paid replaced with the same signature and grants.

alter table public.orders add column if not exists stock_short jsonb;  -- null: nothing missing; else [{name, variant, qty, available}]

create or replace function public.sf_order_paid(p_store uuid, p_order uuid, p_provider text, p_txn text, p_amount numeric, p_currency text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o public.orders; was text; late boolean; short jsonb;
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
  -- late: the order expired, or one of its holds was released — or ran out and the cron has not come yet
  late := was <> 'pending' or exists (select 1 from public.stock_reservations r where r.order_id = o.id
            and (r.status = 'released' or (r.status = 'held' and r.expires_at <= now())));
  if o.is_test then
    update public.orders set payment_status = 'test_paid', provider_txn = p_txn, paid_at = now(), updated_at = now() where id = o.id;
    update public.stock_reservations set status = 'released', updated_at = now() where order_id = o.id and status in ('held', 'paid');
  else
    if late then
      -- what is free for this order now: the stock, less what is held for other orders (paid, or held and still in time)
      select jsonb_agg(jsonb_build_object('name', x.name, 'variant', x.variant_label, 'qty', x.qty, 'available', greatest(x.free, 0))
                       order by x.name, x.variant_label)
        into short
        from (select l.name, l.variant_label, sum(l.qty)::int as qty,
                     coalesce(v.stock_qty, i.stock_qty) - coalesce((select sum(r.qty) from public.stock_reservations r
                        where r.order_id <> o.id and r.item_id = l.item_id
                          and (l.variant_id is null or r.variant_id = l.variant_id)
                          and (r.status = 'paid' or (r.status = 'held' and r.expires_at > now()))), 0)::int as free
                from public.order_lines l
                join public.catalog_items i on i.id = l.item_id and i.track_stock
                left join public.catalog_variants v on v.id = l.variant_id
               where l.order_id = o.id
               group by l.item_id, l.variant_id, l.name, l.variant_label, v.stock_qty, i.stock_qty) x
       where x.qty > x.free;
    end if;
    update public.orders set payment_status = 'paid', provider_txn = p_txn, paid_at = now(), document_status = 'pending',
           stock_short = short, updated_at = now()
     where id = o.id;
    -- every hold of the order is the order's now (a hold that ran out too), until the sale takes the units
    update public.stock_reservations set status = 'paid', updated_at = now() where order_id = o.id and status in ('held', 'released');
    perform public.store_alert(o.id, 'new_order', '');
    if late then
      perform public.store_alert(o.id, 'late_payment', case when short is null
        then 'התשלום הגיע אחרי שהשמירה על המלאי פגה — המלאי הספיק לכל הפריטים.'
        else 'התשלום הגיע אחרי שהשמירה על המלאי פגה. חסר במלאי: ' || (
          select string_agg(e->>'name' || case when e->>'variant' <> '' then ' (' || (e->>'variant') || ')' else '' end
                            || ' — הוזמנו ' || (e->>'qty') || ', יש ' || (e->>'available'), '; ')
            from jsonb_array_elements(short) e) || '. להשלים מלאי או להחזיר כסף על החסר.'
        end);
    end if;
  end if;
  if o.coupon_code <> '' then
    update public.store_coupons set used_count = used_count + 1 where store_id = o.store_id and code = o.coupon_code;
  end if;
  if o.cart_id is not null then update public.store_cart_lines set qty = 0, updated_at = now() where cart_id = o.cart_id and qty > 0; end if;
  perform public.order_email(o.id, 'order_confirmation', '');
  perform public.order_event(o.id, case when o.is_test then 'test_paid' else 'paid' end,
                             jsonb_build_object('txn', p_txn, 'amount', p_amount, 'late', late, 'short', short is not null));
  return jsonb_build_object('result', 'ok', 'status', case when o.is_test then 'test_paid' else 'paid' end);
end $$;
