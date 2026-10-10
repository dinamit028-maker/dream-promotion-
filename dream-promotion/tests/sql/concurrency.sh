#!/usr/bin/env bash
# Numbering and limits under real concurrency (Dream Finance 2.51): several Postgres connections at the same time,
# each in its own transactions, as signed-in users — never one session pretending to be many.
#   1. 8 connections × 25 tax invoice-receipts (320)  → numbers 1..200, no gap, no double
#   2. 8 connections race for the same idempotency key → exactly one document, and the next number has no gap
#   3. 8 connections credit the same invoice of ₪1,180 with ₪236 each → exactly 5 succeed, never beyond the invoice
#   4. 8 connections × 10 quotes and × 10 expenses     → numbers 1..80 each
#   5. the audit chain of the business is intact afterwards
#   6. 8 connections × 20 sales of the same two variants, in crossing order (3300) → every unit counted, no deadlock
#   7. 8 connections race to save the same SKU, on items and on variants (3300) → exactly one
#   8. 8 shoppers check out the last 3 units at once (3500) → exactly 3 orders, never more held than there is
#   9. 8 copies of one payment notice at once (3500) → one test_paid, one use of the coupon, one line on the timeline
#  10. the register and the checkout race for the same 4 units (3500) → what was sold + what is held never exceeds the stock
#  11. 8 paid orders of one new customer (her phone in 8 spellings) recorded at once (3600) → one lead, 8 sales
#  12. 8 connections record the same paid order at once (3600) → one sale, one stock movement
#  13. 8 connections take the last 3 treatments of a package, and 8 deduct one session (4200) → exactly 3, exactly one
# Called by tests/sql/run.sh after the checks (same database). Usage: bash tests/sql/concurrency.sh <db>
set -euo pipefail
cd "$(dirname "$0")/../.."
DB=${1:-${DP_TEST_DB:-dp_test}}
as_pg() { if [ "$(id -un)" = postgres ]; then "$@"; else su postgres -c "$(printf '%q ' "$@")"; fi; }
q() { as_pg psql -X -q -t -A -v ON_ERROR_STOP=1 -d "$DB" -c "$1"; }
TMP=$(mktemp -d); chmod 755 "$TMP"; trap 'rm -rf "$TMP"' EXIT
U=00000000-0000-0000-0000-0000000cc001; B=00000000-0000-0000-0000-0000000cb001
fail() { echo "CHECK FAILED: $1"; exit 1; }

q "insert into auth.users (id, email) values ('$U', 'load@test') on conflict do nothing;
   insert into public.businesses (id, name, slug) values ('$B', 'Load', 'load-test') on conflict do nothing;
   insert into public.business_members (business_id, user_id, role) values ('$B', '$U', 'owner') on conflict do nothing;
   update public.profiles set current_business_id = '$B' where id = '$U';
   insert into public.register_settings (user_id, business_id, business_type, vat_rate, dealer_number, legal_name)
   values ('$U', '$B', 'licensed', 18, '123456782', 'Load Ltd') on conflict do nothing;" >/dev/null

AS="set local role authenticated; select set_config('request.jwt.claim.sub', '$U', true);"
DOC="insert into public.documents (user_id, doc_type, doc_number, doc_date, before_discount, discount, after_discount, vat_amount, total, vat_rate, lines, payments%s)
  values ('$U', %s, 0, public.il_today(), %s, 0, %s, %s, %s, 18,
  jsonb_build_array(jsonb_build_object('name', 'x', 'qty', 1, 'totalExVat', %s)), %s%s);"
pay() { echo "jsonb_build_array(jsonb_build_object('method', 1, 'amount', $1))"; }

worker_script() { # $1 = file, $2 = how many, $3 = the statement
  : > "$1"; for _ in $(seq "$2"); do printf 'begin;\n%s\n%s\ncommit;\n' "$AS" "$3" >> "$1"; done; chmod 644 "$1"
}
run_parallel() { # $1 = prefix of the script files; every connection runs its own file at the same time
  local pids=()
  for f in "$TMP"/"$1"-*.sql; do as_pg psql -X -q -v ON_ERROR_STOP=0 -d "$DB" -f "$f" >/dev/null 2>&1 & pids+=($!); done
  for p in "${pids[@]}"; do wait "$p" || true; done
}

# ---- 1. 200 documents from 8 connections ----------------------------------------------------------------------------
for w in $(seq 8); do worker_script "$TMP/docs-$w.sql" 25 "$(printf "$DOC" '' 320 100 100 18 118 100 "$(pay 118)" '')"; done
run_parallel docs
r=$(q "select count(*) || ' ' || min(doc_number) || ' ' || max(doc_number) || ' ' || count(distinct doc_number) from public.documents where business_id = '$B' and doc_type = 320")
[ "$r" = "200 1 200 200" ] || fail "200 parallel documents are numbered 1..200 without gaps or doubles (got: $r)"
echo "ok: 200 documents from 8 connections → 1..200, no gap, no double"

# ---- 2. the same idempotency key from 8 connections -----------------------------------------------------------------
for w in $(seq 8); do worker_script "$TMP/idem-$w.sql" 1 "$(printf "$DOC" ', idempotency_key' 320 100 100 18 118 100 "$(pay 118)" ", 'sale:race'")"; done
run_parallel idem
r=$(q "select count(*) from public.documents where business_id = '$B' and idempotency_key = 'sale:race'")
[ "$r" = "1" ] || fail "one document per idempotency key under a race (got $r)"
q "begin; $AS $(printf "$DOC" '' 320 100 100 18 118 100 "$(pay 118)" '') commit;" >/dev/null
r=$(q "select max(doc_number) from public.documents where business_id = '$B' and doc_type = 320")
[ "$r" = "202" ] || fail "the refused duplicates left no gap (next number should be 202, got $r)"
echo "ok: 8 racing requests with one idempotency key → one document, numbering continues without a gap"

# ---- 3. 8 credit invoices of ₪236 on one invoice of ₪1,180 -------------------------------------------------------------
q "begin; $AS $(printf "$DOC" ', due_date' 305 1000 1000 180 1180 1000 "'[]'::jsonb" ", public.il_today() + 30") commit;" >/dev/null
BASE=$(q "select max(doc_number) from public.documents where business_id = '$B' and doc_type = 305")
for w in $(seq 8); do worker_script "$TMP/credit-$w.sql" 1 "$(printf "$DOC" ', base_doc_type, base_doc_number' 330 200 200 36 236 200 "'[]'::jsonb" ", 305, $BASE")"; done
run_parallel credit
r=$(q "select count(*) || ' ' || coalesce(sum(total), 0) from public.documents where business_id = '$B' and doc_type = 330 and base_doc_number = $BASE")
[ "$r" = "5 1180.00" ] || fail "parallel credit invoices never pass the invoice (expected 5 of ₪236 = 1180.00, got: $r)"
echo "ok: 8 parallel credits of ₪236 on ₪1,180 → exactly 5, never beyond the invoice"

# ---- 4. quotes and expenses from 8 connections -----------------------------------------------------------------------
for w in $(seq 8); do
  worker_script "$TMP/quotes-$w.sql" 10 "insert into public.quotes (user_id, customer_name, before_discount, after_discount, vat_rate, vat_amount, total) values ('$U', 'q', 100, 100, 18, 18, 118);"
  worker_script "$TMP/exp-$w.sql" 10 "insert into public.expenses (user_id, supplier_name, doc_date, amount_before_vat, vat_amount, total) values ('$U', 's', public.il_today(), 100, 18, 118);"
done
run_parallel quotes; run_parallel exp
r=$(q "select count(*) || ' ' || min(quote_number) || ' ' || max(quote_number) || ' ' || count(distinct quote_number) from public.quotes where business_id = '$B'")
[ "$r" = "80 1 80 80" ] || fail "80 parallel quotes are numbered 1..80 (got: $r)"
r=$(q "select count(*) || ' ' || min(expense_number) || ' ' || max(expense_number) || ' ' || count(distinct expense_number) from public.expenses where business_id = '$B'")
[ "$r" = "80 1 80 80" ] || fail "80 parallel expenses are numbered 1..80 (got: $r)"
echo "ok: 80 quotes and 80 expenses from 8 connections → 1..80 each"

# ---- 5. the audit chain held through all of it -----------------------------------------------------------------------
r=$(q "begin; $AS select public.finance_audit_verify() ->> 'ok'; commit;" | tail -1)
n=$(q "select count(*) from public.finance_audit_log where business_id = '$B'")
[ "$r" = "true" ] || fail "the audit chain is intact after the parallel load (got $r)"
echo "ok: audit chain intact after the load ($n rows, one writer per business at a time)"

# ---- 6. stock per variant under load: 160 sales of two variants, half of them listing the lines in the other order --------
IT=00000000-0000-0000-0000-0000000cc1f1; VA=00000000-0000-0000-0000-0000000cc3a1; VB=00000000-0000-0000-0000-0000000cc3a2
q "insert into public.catalog_items (id, user_id, business_id, name, price, kind, track_stock, stock_qty) values ('$IT', '$U', '$B', 'shirt', 100, 'product', true, 1000);
   insert into public.catalog_variants (id, item_id, option1, stock_qty) values ('$VA', '$IT', 'A', 500), ('$VB', '$IT', 'B', 500);" >/dev/null
line() { echo "{\"name\":\"shirt $1\",\"price\":100,\"qty\":1,\"itemId\":\"$IT\",\"variantId\":\"$2\"}"; }
SALE="insert into public.sales (user_id, items, subtotal, total, vat_rate, vat_amount, method, status, paid_at, employee_name) values ('$U', '%s', 200, 200, 18, 30.51, 'cash', 'paid', now(), 'load-variants');"
for w in $(seq 8); do
  if [ $((w % 2)) -eq 0 ]; then items="[$(line A "$VA"),$(line B "$VB")]"; else items="[$(line B "$VB"),$(line A "$VA")]"; fi
  worker_script "$TMP/vsale-$w.sql" 20 "$(printf "$SALE" "$items")"
done
run_parallel vsale
r=$(q "select (select count(*) from public.sales where business_id = '$B' and employee_name = 'load-variants') || ' ' ||
              (select stock_qty from public.catalog_variants where id = '$VA') || ' ' || (select stock_qty from public.catalog_variants where id = '$VB') || ' ' ||
              (select stock_qty from public.catalog_items where id = '$IT') || ' ' ||
              (select count(*) from public.stock_movements where item_id = '$IT' and variant_id is not null and reason = 'sale')")
[ "$r" = "160 340 340 680 320" ] || fail "160 parallel sales of two variants: every sale in, every unit out, item = sum (expected 160 340 340 680 320, got: $r)"
echo "ok: 160 sales of two variants from 8 connections, lines in crossing order → no deadlock, 340 + 340 = 680, 320 logged moves"

# ---- 7. the same SKU from 8 connections, on items and on variants: one wins -----------------------------------------------
for w in $(seq 8); do
  if [ "$w" -le 4 ]; then stmt="insert into public.catalog_items (user_id, name, price, sku) values ('$U', 'race $w', 1, 'RACE-1');"
  else stmt="insert into public.catalog_variants (item_id, option1, sku) values ('$IT', 'R$w', 'race-1');"; fi
  worker_script "$TMP/code-$w.sql" 1 "$stmt"
done
run_parallel code
r=$(q "select (select count(*) from public.catalog_items where business_id = '$B' and lower(sku) = 'race-1') + (select count(*) from public.catalog_variants where business_id = '$B' and lower(sku) = 'race-1')")
[ "$r" = "1" ] || fail "one SKU in a business, across items and variants, under a race (got $r)"
echo "ok: 8 connections saving one SKU on items and variants → exactly one"

# ---- 8. the last units: 8 shoppers check out at the same moment ------------------------------------------------------------
ST=00000000-0000-0000-0000-0000000cc501; LAST=00000000-0000-0000-0000-0000000cc1f2
SR="set local role service_role;"
h() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }
CUST='{"name":"קונה","phone":"0501234567","email":"x@example.com","method":"pickup","terms":"true"}'
q "insert into public.catalog_items (id, user_id, business_id, name, price, kind, track_stock, stock_qty, slug, publish_online)
     values ('$LAST', '$U', '$B', 'last', 50, 'product', true, 3, 'last', true);
   insert into public.stores (id, business_id, name, phone) values ('$ST', '$B', 'Load', '03-1234567');
   insert into public.payment_accounts (business_id, provider, mode, sealed) values ('$B', 'mock', 'test', 'v1.x');
   update public.stores set checkout_enabled = true, pickup_enabled = true where id = '$ST';
   insert into public.store_coupons (store_id, code, kind, value) values ('$ST', 'RACE', 'amount', 5);" >/dev/null
for w in $(seq 8); do
  q "$SR select public.sf_cart_set('$ST', '$(h "cart-$w")', '$LAST', null, 1, 'add', true);" >/dev/null
  printf 'begin;\n%s\nselect public.sf_checkout_start(%s, %s, %s, %s, %s, true);\ncommit;\n' "$SR" "'$ST'" "'$(h "cart-$w")'" "'$(h "order-$w")'" "'$CUST'" "'ip-$w'" > "$TMP/last-$w.sql"
  chmod 644 "$TMP/last-$w.sql"
done
run_parallel last
r=$(q "select (select count(*) from public.orders where store_id = '$ST') || ' ' ||
              (select coalesce(sum(qty), 0) from public.stock_reservations where item_id = '$LAST' and status = 'held') || ' ' ||
              (select stock_qty from public.catalog_items where id = '$LAST')")
[ "$r" = "3 3 3" ] || fail "8 shoppers, 3 units: exactly 3 orders hold 3 units, the stock unmoved (expected 3 3 3, got: $r)"
echo "ok: 8 shoppers check out the last 3 units at once → exactly 3 orders, 3 held, none beyond the stock"

# ---- 9. one payment notice, 8 times at once ----------------------------------------------------------------------------
PAYI=00000000-0000-0000-0000-0000000cc1f4
q "insert into public.catalog_items (id, user_id, business_id, name, price, kind, track_stock, stock_qty, slug, publish_online)
     values ('$PAYI', '$U', '$B', 'pay', 80, 'product', true, 10, 'pay', true);" >/dev/null
q "$SR select public.sf_cart_set('$ST', '$(h cart-pay)', '$PAYI', null, 1, 'add', true); select public.sf_cart_coupon('$ST', '$(h cart-pay)', 'RACE', true);
   select public.sf_checkout_start('$ST', '$(h cart-pay)', '$(h order-pay)', '$CUST', 'ip-pay', true);" >/dev/null
OID=$(q "select id from public.orders where token_hash = '$(h order-pay)'")
TOT=$(q "select total from public.orders where id = '$OID'")
for w in $(seq 8); do
  printf 'begin;\n%s\nselect public.sf_payment_event(%s, %s, %s, %s, %s, true, %s);\nselect public.sf_order_paid(%s, %s, %s, %s, %s, %s);\ncommit;\n' \
    "$SR" "'$ST'" "'$OID'" "'mock'" "'mock:callback:race'" "'callback'" "'{}'" "'$ST'" "'$OID'" "'mock'" "'txn-race'" "$TOT" "'ILS'" > "$TMP/pay-$w.sql"
  chmod 644 "$TMP/pay-$w.sql"
done
run_parallel pay
r=$(q "select (select payment_status from public.orders where id = '$OID') || ' ' ||
              (select count(*) from public.order_events where order_id = '$OID' and kind = 'test_paid') || ' ' ||
              (select used_count from public.store_coupons where store_id = '$ST' and code = 'RACE') || ' ' ||
              (select count(*) from public.payment_events where event_key = 'mock:callback:race') || ' ' ||
              (select count(*) from public.sales where id = '$OID')")
[ "$r" = "test_paid 1 1 1 0" ] || fail "8 copies of a notice: one test_paid, one coupon use, one event, no sale (expected test_paid 1 1 1 0, got: $r)"
echo "ok: 8 copies of one payment notice at once → one test_paid, the coupon used once, one logged notice, no sale"

# ---- 10. the register and the checkout race for the same 4 units ----------------------------------------------------------
RACE=00000000-0000-0000-0000-0000000cc1f3
q "insert into public.catalog_items (id, user_id, business_id, name, price, kind, track_stock, stock_qty, slug, publish_online)
     values ('$RACE', '$U', '$B', 'race', 50, 'product', true, 4, 'race', true);" >/dev/null
for w in $(seq 8); do
  if [ $((w % 2)) -eq 0 ]; then
    q "$SR select public.sf_cart_set('$ST', '$(h "rc-$w")', '$RACE', null, 1, 'add', true);" >/dev/null
    printf 'begin;\n%s\nselect public.sf_checkout_start(%s, %s, %s, %s, %s, true);\ncommit;\n' "$SR" "'$ST'" "'$(h "rc-$w")'" "'$(h "ro-$w")'" "'$CUST'" "'rip-$w'" > "$TMP/mix-$w.sql"
  else
    printf 'begin;\n%s\ninsert into public.sales (user_id, items, subtotal, total, method, status, paid_at, employee_name) values (%s, %s, 50, 50, %s, %s, now(), %s);\ncommit;\n' \
      "$AS" "'$U'" "'[{\"name\":\"race\",\"price\":50,\"qty\":1,\"itemId\":\"$RACE\"}]'" "'cash'" "'paid'" "'race'" > "$TMP/mix-$w.sql"
  fi
  chmod 644 "$TMP/mix-$w.sql"
done
run_parallel mix
r=$(q "select (select stock_qty from public.catalog_items where id = '$RACE') - (select coalesce(sum(qty), 0) from public.stock_reservations where item_id = '$RACE' and status = 'held') >= 0
          and (select count(*) from public.sales where employee_name = 'race') + (select coalesce(sum(qty), 0) from public.stock_reservations where item_id = '$RACE' and status = 'held') = 4")
[ "$r" = "t" ] || fail "the register and the checkout on 4 units: sold + held = 4, never more held than in stock (got: $r)"
echo "ok: the register (4 connections) and the checkout (4 connections) race for 4 units → sold + held = 4, nothing oversold"

# ---- 11. one new customer, 8 orders recorded at once (3600) -------------------------------------------------------------
LIVEI=00000000-0000-0000-0000-0000000cc1f5
q "update public.platform_flags set enabled = true where key = 'commerce_live';
   update public.payment_accounts set mode = 'live' where business_id = '$B';
   insert into public.catalog_items (id, user_id, business_id, name, price, kind, track_stock, stock_qty, slug, publish_online)
     values ('$LIVEI', '$U', '$B', 'live', 30, 'product', true, 20, 'live', true);" >/dev/null
PHONES=("0521112233" "+972-52-111-2233" "+972 52-111-2233" "052 111 2233" "(052) 1112233" "+972521112233" "052-1112233" "972 52 1112233")
for w in $(seq 8); do
  C="{\"name\":\"קונה חדשה\",\"phone\":\"${PHONES[$((w-1))]}\",\"email\":\"n$w@example.com\",\"method\":\"pickup\",\"terms\":\"true\"}"
  q "$SR select public.sf_cart_set('$ST', '$(h "lc-$w")', '$LIVEI', null, 1, 'add', true);
     select public.sf_checkout_start('$ST', '$(h "lc-$w")', '$(h "lo-$w")', '$C', 'lip-$w', true);" >/dev/null
  O=$(q "select id from public.orders where token_hash = '$(h "lo-$w")'")
  q "$SR select public.sf_order_paid('$ST', '$O', 'mock', 'ltx-$w', 30, 'ILS');" >/dev/null
  printf 'begin;\n%s\nselect public.commerce_record_sale(%s, 18, 4.58);\ncommit;\n' "$SR" "'$O'" > "$TMP/cust-$w.sql"
  chmod 644 "$TMP/cust-$w.sql"
done
run_parallel cust
r=$(q "select (select count(*) from public.leads where business_id = '$B' and public.phone_key(phone) = '972521112233') || ' ' ||
              (select count(distinct lead_id) from public.orders where token_hash like '%' and store_id = '$ST' and not is_test) || ' ' ||
              (select count(*) from public.sales where business_id = '$B' and channel = 'online') || ' ' ||
              (select stock_qty from public.catalog_items where id = '$LIVEI')")
[ "$r" = "1 1 8 12" ] || fail "one new customer, 8 orders at once: one lead, 8 sales, 8 units out (expected 1 1 8 12, got: $r)"
echo "ok: 8 orders of one new customer (8 spellings of her phone) recorded at once → one lead, 8 sales, 8 units out"

# ---- 12. the same order recorded 8 times at once (3600) ---------------------------------------------------------------------
q "$SR select public.sf_cart_set('$ST', '$(h lc-same)', '$LIVEI', null, 2, 'add', true);
   select public.sf_checkout_start('$ST', '$(h lc-same)', '$(h lo-same)', '$CUST', 'lip-same', true);" >/dev/null
O=$(q "select id from public.orders where token_hash = '$(h lo-same)'")
q "$SR select public.sf_order_paid('$ST', '$O', 'mock', 'ltx-same', 60, 'ILS');" >/dev/null
for w in $(seq 8); do
  printf 'begin;\n%s\nselect public.commerce_record_sale(%s, 18, 9.15);\ncommit;\n' "$SR" "'$O'" > "$TMP/same-$w.sql"
  chmod 644 "$TMP/same-$w.sql"
done
run_parallel same
r=$(q "select (select count(*) from public.sales where id = '$O') || ' ' || (select count(*) from public.stock_movements where sale_id = '$O') || ' ' ||
              (select stock_qty from public.catalog_items where id = '$LIVEI') || ' ' ||
              (select count(*) from public.order_events where order_id = '$O' and kind = 'sale_recorded')")
q "update public.platform_flags set enabled = false where key = 'commerce_live';" >/dev/null
[ "$r" = "1 1 10 1" ] || fail "the same order 8 times at once: one sale, one movement (expected 1 1 10 1, got: $r)"
echo "ok: 8 connections record the same paid order at once → one sale, one stock movement, one line on the timeline"

# ---- 13. the last treatments of a package, and one session, from 8 connections at once (4200) ---------------------------------
PKL=00000000-0000-0000-0000-0000000cc4a1; PKT=00000000-0000-0000-0000-0000000cc4a2
PK3=00000000-0000-0000-0000-0000000cc4a3; PK9=00000000-0000-0000-0000-0000000cc4a4; PKS=00000000-0000-0000-0000-0000000cc4a5
q "insert into public.leads (id, user_id, business_id, name) values ('$PKL', '$U', '$B', 'עומס');
   insert into public.client_treatments (id, business_id, lead_id, title) values ('$PKT', '$B', '$PKL', 'טיפול');
   insert into public.client_packages (id, business_id, user_id, lead_id, name, sessions_total, price) values
     ('$PK3', '$B', '$U', '$PKL', 'שלושה אחרונים', 3, 0), ('$PK9', '$B', '$U', '$PKL', 'הרבה', 50, 0);
   insert into public.client_sessions (id, business_id, treatment_id, lead_id, notes) values ('$PKS', '$B', '$PKT', '$PKL', 'one');" >/dev/null
# 8 sessions, each with its deduction, race for 3 treatments: a refused deduction takes its session with it
for w in $(seq 8); do worker_script "$TMP/pkg-$w.sql" 1 "select public.client_session_add('$PKL', '$PKT', null, 'race-$w', '$PK3');"; done
run_parallel pkg
r=$(q "select (select count(*) from public.client_package_uses where package_id = '$PK3' and returned_at is null) || ' ' ||
              (select count(*) from public.client_sessions where lead_id = '$PKL' and notes like 'race-%')")
[ "$r" = "3 3" ] || fail "8 connections take the last 3 treatments of a package: exactly 3 deductions and 3 sessions (got: $r)"
echo "ok: 8 connections take the last 3 treatments of a package at once → exactly 3 sessions with 3 deductions, none beyond"
# one session deducted from 8 connections at once: exactly one deduction
for w in $(seq 8); do worker_script "$TMP/pks-$w.sql" 1 "insert into public.client_package_uses (business_id, package_id, lead_id, session_id) values ('$B', '$PK9', '$PKL', '$PKS');"; done
run_parallel pks
r=$(q "select count(*) from public.client_package_uses where session_id = '$PKS'")
[ "$r" = "1" ] || fail "one session deducted from 8 connections at once: exactly one deduction (got: $r)"
echo "ok: one session deducted from 8 connections at once → exactly one deduction"
