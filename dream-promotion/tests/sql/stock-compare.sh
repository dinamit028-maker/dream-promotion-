#!/usr/bin/env bash
# A business with one location, without and with a migration that changes how stock moves — 20261011004700 (stock by location,
# docs/FINANCE_ADDITIONS_HE.md T12ב), and 20261011004800 (serial numbers, T12ג — every mover again): two databases — every
# migration before it, and every migration — and the same day of a business on both: deliveries and counts (the screens'
# functions as they were), sales and a cancel, a refund back to stock, a document and its cancellation, a receipt and its credit
# invoice, an expense's delivery and its void, variants and "לא משויך", reconciling, an order of the site that holds units. Every
# count, every move (without the columns 4700 adds), every answer of the functions and what the site says is free — the same on both.
# 20261011004900 (the reports and tax withheld at source, T8) rewrote the receipts' way into the ledger and finance_summary: the
# same day (a receipt paid by cheque too) gives the same ledger, row by row, and the same summary (4900 only adds "withheld": 0).
# 20261011005000 (the desks, deposits and the bank, T9; order / delivery note / return note, T10) rewrote the documents' checks, their
# way into the stock and the cancellations: the same day — a business that turns nothing on — gives the same everything.
# 20261011005100 (manual journal entries, T13א) rewrote finance_summary and the reports' functions: the same day, no entry — the same
# summary (5100 only adds "manual", all 0) and the same reports.
# Called by tests/sql/run.sh. Usage: bash tests/sql/stock-compare.sh [db] [the migration: 4700 (default), 4800, 4900, 5000 or 5100]
set -euo pipefail
cd "$(dirname "$0")/../.."
BASE=${1:-${DP_TEST_DB:-dp_test}}
export PGOPTIONS="-c client_min_messages=warning"
PSQL=(psql -X -q -v ON_ERROR_STOP=1)
as_pg() { if [ "$(id -un)" = postgres ]; then "$@"; else su postgres -c "$(printf '%q ' "$@")"; fi; }
fail() { echo "CHECK FAILED: $1"; exit 1; }
case "${2:-4700}" in
  4700) STOCK=supabase/migrations/20261011004700_stock_locations.sql ;;
  4800) STOCK=supabase/migrations/20261011004800_items_lists_reports.sql ;;
  4900) STOCK=supabase/migrations/20261011004900_reports.sql ;;
  5000) STOCK=supabase/migrations/20261011005000_cash_bank_goods.sql ;;
  5100) STOCK=supabase/migrations/20261011005100_journal_entries.sql ;;
  *) fail "the migration to compare: 4700, 4800, 4900, 5000 or 5100" ;;
esac
TAG=${2:-4700}
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
    update public.expenses set status = 'void', void_reason = 'כפול' where id = '00000000-0000-0000-0000-000000e48701';
    insert into public.documents (id, user_id, doc_type, doc_number, doc_date, customer_name, before_discount, discount, after_discount, vat_amount, total, vat_rate,
                                  lines, payments, idempotency_key)
    values ('00000000-0000-0000-0000-000000e48604', '$O', 400, 0, public.il_today(), 'לקוחה', 50, 0, 50, 0, 50, 18,
            '[{\"name\":\"מקדמה\",\"qty\":1,\"unitPriceExVat\":50,\"discountExVat\":0,\"totalExVat\":50,\"vatRate\":18,\"kind\":1}]',
            jsonb_build_array(jsonb_build_object('method', 2, 'amount', 30, 'date', public.il_today(), 'm', 'cheque',
                                                 'cheque', jsonb_build_object('number', '1234', 'bank', '12', 'branch', '345', 'account', '678901')),
                              jsonb_build_object('method', 9, 'amount', 20, 'date', public.il_today(), 'm', 'bit')), 'cmp-400');" >/dev/null || return 1
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
                       || ' ' || count(*) from public.stock_movements m where m.business_id = '$B';
                select 'ledger ' || md5(string_agg(concat_ws('/', p.direction, p.amount, p.method, p.paid_on, p.source, p.document_id, p.applies_to, p.sale_id,
                                                           p.refund_id, p.expense_id, p.lead_id, p.reference, p.note, p.user_id), '|' order by concat_ws('/', p.direction,
                                                           p.amount, p.method, p.paid_on, p.source, p.document_id, p.applies_to, p.sale_id, p.refund_id, p.expense_id,
                                                           p.lead_id, p.reference, p.note, p.user_id)))
                       || ' ' || count(*) from public.payments p where p.business_id = '$B';" || return 1
  "${q[@]}" -c "begin; $AS
    select 'summary ' || (public.finance_summary(public.il_today() - 30, public.il_today()) - 'withheld' - 'manual')::text;
    select 'withheld ' || coalesce(public.finance_summary(public.il_today() - 30, public.il_today())->>'withheld', '0');
    select 'manual ' || coalesce(public.finance_summary(public.il_today() - 30, public.il_today())->'manual'->>'count', '0');
    commit;" || return 1
  # 5100 rewrote the reports of 4900 and 4800's comparison of locations too: the same answers without and with it (no entry —
  # only the "manual": 0 it adds, which is taken out here)
  if [ "$TAG" = 5100 ]; then
    "${q[@]}" -c "begin; $AS
      select 'income ' || (public.report_income_by_customer(public.il_today() - 30, public.il_today()) #- '{total,manual}')::text;
      select 'items ' || (public.report_sales_by_item(public.il_today() - 30, public.il_today()) - 'manual')::text;
      select 'suppliers ' || (public.report_suppliers(public.il_today() - 30, public.il_today()) #- '{total,manual}')::text;
      select 'cmp ' || public.location_compare(public.il_today() - 30, public.il_today())::text;
      commit;" | sed -E 's/,? ?\"manual\": 0(\.00)?//g' || return 1
  fi
}
build "${BASE}_stk_before" no
build "${BASE}_stk_after" yes
day "${BASE}_stk_before" > "$TMPF.before" || fail "the day without $TAG"
day "${BASE}_stk_after" > "$TMPF.after" || fail "the day with $TAG"
before=$(cat "$TMPF.before"); after=$(cat "$TMPF.after")
if [ -n "${CMP_SHOW:-}" ]; then cat "$TMPF.after"; fi
[ -n "$(echo "$before" | grep '^moves ')" ] || fail "the day ran on the database without $TAG"
[ "$before" = "$after" ] || { diff <(echo "$before") <(echo "$after"); fail "one location: $TAG changed something"; }
[ -n "$(echo "$before" | grep '^ledger .* [1-9]')" ] || fail "the day wrote no ledger rows"
if [ "$TAG" = 4700 ]; then
  r=$(as_pg "${PSQL[@]}" -t -A -d "${BASE}_stk_after" -c "select count(*) from public.stock_levels where business_id = '$B'")
  [ "$r" = "0" ] || fail "one location: nothing kept for other locations (got $r)"
elif [ "$TAG" = 4900 ]; then
  r=$(as_pg "${PSQL[@]}" -t -A -d "${BASE}_stk_after" -c "select count(*) from public.payments where method = 'withholding'")
  [ "$r" = "0" ] || fail "one location: no tax withheld at source appeared (got $r)"
elif [ "$TAG" = 5100 ]; then
  r=$(as_pg "${PSQL[@]}" -t -A -d "${BASE}_stk_after" -c "select count(*) from public.journal_entries")
  [ "$r" = "0" ] || fail "one location: no journal entry appeared (got $r)"
elif [ "$TAG" = 5000 ]; then
  r=$(as_pg "${PSQL[@]}" -t -A -d "${BASE}_stk_after" -c "select (select count(*) from public.bank_deposits) + (select count(*) from public.bank_lines)
                                                              + (select count(*) from public.cheque_reminders) + (select count(*) from public.documents where doc_type in (100, 200, 210))
                                                              + (select count(*) from public.business_finance_profile where cash_drawers or sells_products)")
  [ "$r" = "0" ] || fail "one location: no deposit, bank line, reminder, goods document or switch appeared (got $r)"
else
  r=$(as_pg "${PSQL[@]}" -t -A -d "${BASE}_stk_after" -c "select (select count(*) from public.catalog_serials) + (select count(*) from public.price_lists)
                                                              + (select count(*) from public.sku_series) + (select count(*) from public.catalog_items where track_serials)")
  [ "$r" = "0" ] || fail "one location: no serial number, price list or SKU series appeared (got $r)"
fi
echo "ok: one location, without and with $TAG → the same day gives the same counts, moves, answers and the same site ($(echo "$after" | grep -c .) results compared)"
as_pg dropdb "${BASE}_stk_before" >/dev/null; as_pg dropdb "${BASE}_stk_after" >/dev/null
