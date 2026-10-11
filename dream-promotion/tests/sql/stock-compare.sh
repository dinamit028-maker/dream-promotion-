#!/usr/bin/env bash
# A business with one location, without and with migration 20261011004700 (stock by location, docs/FINANCE_ADDITIONS_HE.md T12ב):
# two databases — every migration before it, and every migration — and the same day of a business on both: deliveries and
# counts (the screens' functions as they were), sales and a cancel, a refund back to stock, a document and its cancellation, a
# receipt and its credit invoice, an expense's delivery and its void, variants and "לא משויך", reconciling, an order of the site
# that holds units. Every count, every move (without the columns 4700 adds), every answer of the functions and what the site
# says is free — the same on both.
# Called by tests/sql/run.sh. Usage: bash tests/sql/stock-compare.sh [db]
set -euo pipefail
cd "$(dirname "$0")/../.."
BASE=${1:-${DP_TEST_DB:-dp_test}}
export PGOPTIONS="-c client_min_messages=warning"
PSQL=(psql -X -q -v ON_ERROR_STOP=1)
as_pg() { if [ "$(id -un)" = postgres ]; then "$@"; else su postgres -c "$(printf '%q ' "$@")"; fi; }
fail() { echo "CHECK FAILED: $1"; exit 1; }
STOCK=supabase/migrations/20261011004700_stock_locations.sql
TMPF=$(mktemp); trap 'rm -f "$TMPF" "$TMPF.before" "$TMPF.after"' EXIT

build() { # $1 = the database, $2 = with 4700 (yes / no)
  as_pg dropdb --if-exists "$1" >/dev/null
  as_pg createdb "$1"
  as_pg "${PSQL[@]}" -d "$1" -f tests/sql/supabase-shim.sql
  for f in supabase/migrations/*.sql; do
    if [ "$2" = no ] && [[ ! "$f" < "$STOCK" ]]; then continue; fi
    as_pg env PGOPTIONS="$PGOPTIONS" "${PSQL[@]}" -d "$1" -f "$f" >/dev/null || fail "migration $f"
  done
}
O=00000000-0000-0000-0000-000000e48a01; B=00000000-0000-0000-0000-000000e48b01
A=00000000-0000-0000-0000-000000e48f01; V=00000000-0000-0000-0000-000000e48f02; U=00000000-0000-0000-0000-000000e48f03
X=00000000-0000-0000-0000-000000e48f21; Y=00000000-0000-0000-0000-000000e48f22
AS="set local role authenticated; select set_config('request.jwt.claim.sub', '$O', true);"
line() { echo "{\"name\":\"$1\",\"price\":10,\"qty\":$2,\"itemId\":\"$3\"$( [ -n "${4:-}" ] && echo ",\"variantId\":\"$4\"" ),\"kind\":\"product\"}"; }
day() { # the same day of the business, on database $1 — prints every answer of a function
  local q=(as_pg "${PSQL[@]}" -t -A -d "$1")
  set -o pipefail
  "${q[@]}" -c "insert into auth.users (id, email) values ('$O', 'owner@stock-cmp.test');
    insert into public.businesses (id, name, slug) values ('$B', 'Compare', 'stock-cmp');
    insert into public.business_members (business_id, user_id, role, access) values ('$B', '$O', 'owner', 'full');
    update public.profiles set current_business_id = '$B' where id = '$O';
    insert into public.register_settings (user_id, business_id, business_type, vat_rate, dealer_number, legal_name, street, city, entity_type)
    values ('$O', '$B', 'licensed', 18, '514000004', 'השוואה בע\"מ', 'הרצל', 'תל אביב', 'company');
    insert into public.catalog_items (id, user_id, business_id, name, price, kind, track_stock, low_stock, slug, publish_online) values
      ('$A', '$O', '$B', 'קרם', 100, 'product', true, 2, 'cream', true), ('$V', '$O', '$B', 'חולצה', 100, 'product', true, 1, 'shirt', true),
      ('$U', '$O', '$B', 'גרביים', 20, 'product', false, 2, 'socks', true);
    insert into public.catalog_variants (id, item_id, business_id, option1) values ('$X', '$V', '$B', 'S'), ('$Y', '$V', '$B', 'M');" >/dev/null || return 1
  "${q[@]}" -c "begin; $AS
    select 'adjust ' || public.adjust_stock('$A', 'set', 10) || ' ' || public.adjust_stock('$A', 'add', 5, 'משלוח')
           || ' ' || public.adjust_variant_stock('$X', 'set', 4) || ' ' || public.adjust_variant_stock('$Y', 'add', 2);
    insert into public.sales (id, user_id, items, subtotal, total, vat_rate, vat_amount, method, status, paid_at) values
      ('00000000-0000-0000-0000-000000e48501', '$O', '[$(line קרם 2 "$A")]', 20, 20, 18, 3, 'cash', 'paid', now()),
      ('00000000-0000-0000-0000-000000e48502', '$O', '[$(line חולצה 1 "$V" "$X")]', 10, 10, 18, 1.5, 'card', 'paid', now()),
      ('00000000-0000-0000-0000-000000e48503', '$O', '[$(line חולצה 1 "$V")]', 10, 10, 18, 1.5, 'cash', 'paid', now()),
      ('00000000-0000-0000-0000-000000e48504', '$O', '[$(line גרביים 1 "$U")]', 10, 10, 18, 1.5, 'cash', 'paid', now()),
      ('00000000-0000-0000-0000-000000e48505', '$O', '[$(line קרם 1 "$A")]', 10, 10, 18, 1.5, 'link', 'pending', null);
    update public.sales set status = 'cancelled' where id = '00000000-0000-0000-0000-000000e48505';
    insert into public.sale_refunds (id, user_id, sale_id, amount, vat_amount, method, items, restock, reason)
    values ('00000000-0000-0000-0000-000000e48511', '$O', '00000000-0000-0000-0000-000000e48501', 10, 1.5, 'cash', '[$(line קרם 1 "$A")]', true, 'החזרה');
    insert into public.expenses (id, user_id, supplier_name, doc_date, category, amount_before_vat, vat_amount, total, paid_on, payment_method, stock_lines)
    values ('00000000-0000-0000-0000-000000e48701', '$O', 'ספק', public.il_today(), 'inventory', 100, 18, 118, public.il_today(), 'transfer',
            '[{\"itemId\":\"$A\",\"qty\":3},{\"itemId\":\"$V\",\"variantId\":\"$Y\",\"qty\":1}]');
    select 'received ' || public.receive_expense_stock('00000000-0000-0000-0000-000000e48701');
    commit;" || return 1
  local doc="insert into public.documents (id, user_id, doc_type, doc_number, doc_date, customer_name, before_discount, discount, after_discount, vat_amount,
     total, vat_rate, lines, payments, idempotency_key%s) values ('%s', '$O', %s, 0, public.il_today(), 'לקוחה', 100, 0, 100, 18, 118, 18,
     '[{\"name\":\"קרם\",\"qty\":1,\"unitPriceExVat\":100,\"discountExVat\":0,\"totalExVat\":100,\"vatRate\":18,\"kind\":1,\"itemId\":\"$A\"%s}]', %s, '%s'%s);"
  "${q[@]}" -c "$(printf "$doc" '' 00000000-0000-0000-0000-000000e48601 300 '' "'[]'" cmp-300 '')
    insert into public.document_cancellations (document_id, user_id, reason) values ('00000000-0000-0000-0000-000000e48601', '$O', 'הופקה בטעות');
    $(printf "$doc" '' 00000000-0000-0000-0000-000000e48602 320 '' "jsonb_build_array(jsonb_build_object('method', 1, 'amount', 118, 'date', public.il_today()))" cmp-320 '')
    $(printf "$doc" ', base_doc_type, base_doc_number' 00000000-0000-0000-0000-000000e48603 330 ',"restock":true' "'[]'" cmp-330 \
       ", 320, (select doc_number from public.documents where id = '00000000-0000-0000-0000-000000e48602')")
    update public.expenses set status = 'void', void_reason = 'כפול' where id = '00000000-0000-0000-0000-000000e48701';" >/dev/null || return 1
  "${q[@]}" -c "begin; $AS select 'reconcile ' || public.reconcile_variant_stock('$V'); commit;" || return 1
  # an order of the site holds 3 creams
  "${q[@]}" -c "insert into public.stores (id, user_id, business_id, name, slug, status) values ('00000000-0000-0000-0000-000000e48801', '$O', '$B', 'החנות', 'stock-cmp-store', 'draft');
    insert into public.orders (id, business_id, store_id, number, token_hash, subtotal, total, customer_name, customer_phone, customer_email, delivery_method,
                               terms_accepted_at, provider, expires_at)
    values ('00000000-0000-0000-0000-000000e48802', '$B', '00000000-0000-0000-0000-000000e48801', 1, repeat('d', 64), 300, 300, 'קונה', '0501234567',
            'buyer@stock-cmp.test', 'pickup', now(), 'mock', now() + interval '1 hour');
    insert into public.stock_reservations (business_id, order_id, item_id, variant_id, qty, expires_at)
    values ('$B', '00000000-0000-0000-0000-000000e48802', '$A', null, 3, now() + interval '1 hour');" >/dev/null || return 1
  "${q[@]}" -c "begin; $AS
    select 'conflict ' || coalesce(public.stock_reserved_conflict('[$(line קרם 20 "$A")]', null), '-') || ' ' || coalesce(public.stock_reserved_conflict('[$(line קרם 1 "$A")]', null), '-');
    select 'held ' || (select jsonb_agg(x - 'location' order by x->>'item_id') from jsonb_array_elements(public.reserved_stock()) x)::text;
    commit;" || return 1
  "${q[@]}" -c "select 'items ' || string_agg(i.name || ':' || i.stock_qty || ':' || i.track_stock || ':' || public.sf_prices(i)::text, ' | ' order by i.id)
                  from public.catalog_items i where i.business_id = '$B';
                select 'variants ' || string_agg(v.option1 || ':' || v.stock_qty, ' | ' order by v.id) from public.catalog_variants v where v.business_id = '$B';
                select 'product ' || (public.sf_product('00000000-0000-0000-0000-000000e48801', 'shirt', true) - 'updated_at' - 'related')::text;
                select 'moves ' || md5(string_agg(concat_ws('/', m.item_id, m.variant_id, m.delta, m.qty_after, m.reason, m.sale_id, m.refund_id, m.document_id,
                                                           m.expense_id, m.note, m.user_id), '|' order by concat_ws('/', m.item_id, m.variant_id, m.delta, m.qty_after,
                                                           m.reason, m.sale_id, m.refund_id, m.document_id, m.expense_id, m.note, m.user_id)))
                       || ' ' || count(*) from public.stock_movements m where m.business_id = '$B';" || return 1
}
build "${BASE}_stk_before" no
build "${BASE}_stk_after" yes
day "${BASE}_stk_before" > "$TMPF.before" || fail "the day without 4700"
day "${BASE}_stk_after" > "$TMPF.after" || fail "the day with 4700"
before=$(cat "$TMPF.before"); after=$(cat "$TMPF.after")
if [ -n "${CMP_SHOW:-}" ]; then cat "$TMPF.after"; fi
[ -n "$(echo "$before" | grep '^moves ')" ] || fail "the day ran on the database without 4700"
[ "$before" = "$after" ] || { diff <(echo "$before") <(echo "$after"); fail "one location: 4700 changed something"; }
r=$(as_pg "${PSQL[@]}" -t -A -d "${BASE}_stk_after" -c "select count(*) from public.stock_levels where business_id = '$B'")
[ "$r" = "0" ] || fail "one location: nothing kept for other locations (got $r)"
echo "ok: one location, without and with 4700 → the same day gives the same counts, moves, answers and the same site ($(echo "$after" | grep -c .) results compared)"
as_pg dropdb "${BASE}_stk_before" >/dev/null; as_pg dropdb "${BASE}_stk_after" >/dev/null
