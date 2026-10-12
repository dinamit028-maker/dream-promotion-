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
#  14. payment links (4300): 8 links of ₪300 on one invoice of ₪1,180 at once → exactly 3; the provider's answer for one link
#      8 times at once → paid once; 8 different transactions for one link at once → one pays it, 7 are logged as double
#  15. plans and reminders (4400): 8 connections make a plan for one invoice at once → one plan (and with "replace", one in force);
#      the timer runs 8 times at once → every late line gets its reminder once, one email each
#  16. recurring charges (4500): the same new plan saved from 8 connections at once → one plan, once on the card and in the log;
#      the timer 8 times at once, on two dates → one charge per plan and period, each handed to the server once; a paused plan none
#  17. locations and registers (4600): 8 connections open a day on one register at once → one; on two registers → one each (the same
#      person); 80 documents from 8 connections in two locations → one series, no gap; 16 new locations at once → never more than 10
#  18. stock by location (4700): 80 sales from 8 connections at two locations, crossing → each location's count and the total right;
#      the same transfer sent and received from 8 connections at once → once each; one count approved 8 times at once → its
#      differences once; 8 new counts of one location at once → one open
#  19. serial numbers and SKU series (4800): one number sold from 8 registers at once → sold once (the DoD); sales and transfers of
#      two numbered products from 8 connections, crossing → every number once, no deadlock; 8 connections × 10 new products with the
#      next SKU of one series → 80 codes, none twice, no gap
#  20. the desks, deposits, the bank and the goods documents (5000): one cheque deposited from 8 connections at once → in one deposit;
#      8 deposits of the whole cash desk at once → never more than it holds; the same file imported 8 times at once → each line
#      once; one receipt approved on 8 lines at once → one match; one delivery note invoiced 8 times at once → one invoice; 8 return
#      notes of one unit on a note of 3 at once → exactly 3
#  21. manual journal entries (5100): the same new entry from 8 connections at once → one; 8 connections × 10 entries → numbers
#      1..81, no gap, no double; one entry undone from 8 connections at once → one reversal
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

# ---- 14. payment links from 8 connections at once (4300) -----------------------------------------------------------------------
# the terminal back to a test one, checked (section 11 made it live; new mode → not verified until checked again)
q "update public.payment_accounts set mode = 'test' where business_id = '$B';
   update public.payment_accounts set verified_at = now() where business_id = '$B';" >/dev/null
q "begin; $AS $(printf "$DOC" ', due_date' 305 1000 1000 180 1180 1000 "'[]'::jsonb" ", public.il_today() + 30") commit;" >/dev/null
PLI=$(q "select id from public.documents where business_id = '$B' and doc_type = 305 order by doc_number desc limit 1")
# 8 links of ₪300 at once on ₪1,180: the invoice's lock lets exactly 3 through
for w in $(seq 8); do
  printf 'begin;\n%s\nselect public.paylink_create(%s, %s, %s, %s, 300, 7, %s, %s);\ncommit;\n' \
    "$SR" "'$B'" "'$U'" "'document'" "'$PLI'" "'https://app.load.test'" "'link'" > "$TMP/plk-$w.sql"
  chmod 644 "$TMP/plk-$w.sql"
done
run_parallel plk
r=$(q "select count(*) || ' ' || coalesce(sum(amount), 0) from public.payment_requests where document_id = '$PLI'")
[ "$r" = "3 900.00" ] || fail "8 links of ₪300 on ₪1,180 at once: exactly 3 (expected 3 900.00, got: $r)"
echo "ok: 8 links of ₪300 on one invoice of ₪1,180 at once → exactly 3, never more asked for than the balance"
# the provider's answer for one link, 8 times at once (8 copies of the webhook): paid once
PL1=$(q "select id from public.payment_requests where document_id = '$PLI' order by created_at, id limit 1")
PL2=$(q "select id from public.payment_requests where document_id = '$PLI' order by created_at, id offset 1 limit 1")
q "$SR select public.sf_paylink_page('$PL1', 'race-1', 'https://pay.test/race-1'); select public.sf_paylink_page('$PL2', 'race-2', 'https://pay.test/race-2');" >/dev/null
for w in $(seq 8); do
  printf 'begin;\n%s\nselect public.sf_paylink_event(%s, %s, %s, %s, true, %s);\nselect public.sf_paylink_paid(%s, %s, %s, %s, 300, %s);\ncommit;\n' \
    "$SR" "'$PL1'" "'mock'" "'mock:link-callback:race'" "'callback'" "'{}'" "'$PL1'" "'race-1'" "'mock'" "'txn-race'" "'ILS'" > "$TMP/plp-$w.sql"
  chmod 644 "$TMP/plp-$w.sql"
done
run_parallel plp
r=$(q "select (select status || ' ' || provider_txn from public.payment_requests where id = '$PL1') || ' ' ||
              (select count(*) from public.finance_audit_log where entity_id = '$PL1' and action = 'paylink.test_paid') || ' ' ||
              (select count(*) from public.finance_audit_log where entity_id = '$PL1' and action = 'paylink.double') || ' ' ||
              (select count(*) from public.payment_events where event_key = 'mock:link-callback:race')")
[ "$r" = "paid txn-race 1 0 1" ] || fail "one webhook 8 times at once: paid once, one logged notice (expected paid txn-race 1 0 1, got: $r)"
echo "ok: the same webhook 8 times at once → the link paid once, one logged notice"
# 8 different transactions for one link at once: one pays it, the other 7 are logged for the owner — never paid twice
for w in $(seq 8); do
  printf 'begin;\n%s\nselect public.sf_paylink_paid(%s, %s, %s, %s, 300, %s);\ncommit;\n' \
    "$SR" "'$PL2'" "'race-2'" "'mock'" "'txn-other-$w'" "'ILS'" > "$TMP/pld-$w.sql"
  chmod 644 "$TMP/pld-$w.sql"
done
run_parallel pld
r=$(q "select (select status from public.payment_requests where id = '$PL2') || ' ' ||
              (select count(*) from public.finance_audit_log where entity_id = '$PL2' and action = 'paylink.test_paid') || ' ' ||
              (select count(*) from public.finance_audit_log where entity_id = '$PL2' and action = 'paylink.double') || ' ' ||
              (select count(*) from public.payments where applies_to = '$PLI')")
[ "$r" = "paid 1 7 0" ] || fail "8 transactions for one link at once: one pays, 7 double, nothing in the ledger (test) (expected paid 1 7 0, got: $r)"
echo "ok: 8 different transactions for one link at once → one pays it, 7 logged as double, no payment twice"

# ---- 15. payment plans and the reminders' timer from 8 connections at once (4400) ------------------------------------------------
q "begin; $AS $(printf "$DOC" ', due_date' 305 1000 1000 180 1180 1000 "'[]'::jsonb" ", public.il_today() + 30") commit;" >/dev/null
PLAN_INV=$(q "select id from public.documents where business_id = '$B' and doc_type = 305 order by doc_number desc limit 1")
ITEMS="jsonb_build_array(jsonb_build_object('amount', 590, 'due', public.il_today() + 1), jsonb_build_object('amount', 590, 'due', public.il_today() + 31))"
for w in $(seq 8); do worker_script "$TMP/plan-$w.sql" 1 "select public.payment_plan_create(gen_random_uuid(), '$PLAN_INV', $ITEMS);"; done
run_parallel plan
r=$(q "select count(*) || ' ' || count(*) filter (where status = 'active') from public.payment_plans where document_id = '$PLAN_INV'")
[ "$r" = "1 1" ] || fail "8 plans for one invoice at once: exactly one (expected 1 1, got: $r)"
for w in $(seq 8); do worker_script "$TMP/replan-$w.sql" 1 "select public.payment_plan_create(gen_random_uuid(), '$PLAN_INV', $ITEMS, '', true);"; done
run_parallel replan
r=$(q "select count(*) || ' ' || count(*) filter (where status = 'active') || ' ' ||
              (select count(*) from public.payment_plan_items i join public.payment_plans p on p.id = i.plan_id where p.document_id = '$PLAN_INV' and p.status = 'active')
         from public.payment_plans where document_id = '$PLAN_INV'")
[ "$r" = "9 1 2" ] || fail "8 replacing plans at once: one in force with its 2 payments, the rest cancelled (expected 9 1 2, got: $r)"
echo "ok: 8 connections make a plan for one invoice at once → one plan; 8 replacing it at once → one in force"
# a customer who owes 6 late invoices, reminders on (by email): the timer 8 times at once queues each once
LEAD=00000000-0000-0000-0000-0000000cc0e1
q "insert into public.leads (id, user_id, business_id, name, phone, email) values ('$LEAD', '$U', '$B', 'Late', '0509999999', 'late@load.test') on conflict do nothing;
   insert into public.debt_reminder_settings (business_id, enabled, days, channel, approved_by, approved_at)
   values ('$B', true, '{3,7,14}', 'email', '$U', now()) on conflict (business_id) do update set enabled = true, channel = 'email', approved_at = now();" >/dev/null
LATE="insert into public.documents (user_id, doc_type, doc_number, doc_date, due_date, lead_id, customer_name, before_discount, discount, after_discount, vat_amount, total, vat_rate, lines, payments)
  values ('$U', 305, 0, public.il_today() - %s - 1, public.il_today() - %s, '$LEAD', 'Late', 100, 0, 100, 18, 118, 18,
  jsonb_build_array(jsonb_build_object('name', 'x', 'qty', 1, 'totalExVat', 100)), '[]'::jsonb);"
for late in 4 5 8 10 20 30; do q "begin; $AS $(printf "$LATE" "$late" "$late") commit;" >/dev/null; done
r=$(q "select count(*) from public.documents where business_id = '$B' and lead_id = '$LEAD' and due_date < public.il_today()")
[ "$r" = "6" ] || fail "the 6 late invoices of the load test were not issued (got: $r)"
AT="((public.il_today() + case when extract(isodow from public.il_today()) = 6 then 1 else 0 end) + time '10:00') at time zone 'Asia/Jerusalem'"
for w in $(seq 8); do
  printf 'begin;\nset local role service_role;\nselect public.debt_reminders_queue(%s);\ncommit;\n' "$AT" > "$TMP/remind-$w.sql"
  chmod 644 "$TMP/remind-$w.sql"
done
run_parallel remind
r=$(q "select count(*) || ' ' || count(distinct (document_id, step)) || ' ' || count(email_id) || ' ' ||
              (select count(*) from public.email_outbox o where o.business_id = '$B' and o.kind = 'debt_reminder')
         from public.debt_reminders where business_id = '$B'")
[ "$r" = "6 6 6 6" ] || fail "the timer 8 times at once: each late line once, one email each (expected 6 6 6 6, got: $r)"
echo "ok: the reminders' timer from 8 connections at once → each of 6 late invoices reminded once, one email each"

# ---- 16. recurring charges: one plan saved 8 times at once, and the timer 8 times at once (4500) -----------------------------------
RL=00000000-0000-0000-0000-0000000cc0f1
q "insert into public.leads (id, user_id, business_id, name, phone, email) values ('$RL', '$U', '$B', 'Monthly', '0508888888', '') on conflict do nothing;" >/dev/null
rsave() { # $1 = the plan's id: every month on today's day (at most the 28th), from today, ₪100, an invoice without a link
  echo "select public.recurring_plan_save('$1', '$RL', 'מנוי', jsonb_build_array(jsonb_build_object('name', 'מנוי', 'qty', 1, 'unitPrice', 100)), true, 100, 1,
        least(extract(day from public.il_today())::int, 28), public.il_today(), null, 'issue', false, '');"
}
P0=00000000-0000-0000-0000-0000000cc0f0
for w in $(seq 8); do worker_script "$TMP/rsave-$w.sql" 1 "$(rsave $P0)"; done
run_parallel rsave
r=$(q "select (select count(*) from public.recurring_plans where business_id = '$B') || ' ' ||
              (select count(*) from public.finance_audit_log where action = 'recurring.created' and entity_id = '$P0') || ' ' ||
              (select count(*) from public.lead_activities where lead_id = '$RL' and body like 'חיוב חוזר: מנוי%')")
[ "$r" = "1 1 1" ] || fail "one new plan saved from 8 connections at once: one plan, once in the log and on the card (expected 1 1 1, got: $r)"
echo "ok: the same new plan saved from 8 connections at once → one plan, once in the log and on the card"
# 5 more plans, one of them paused; the timer 8 times at once on their date, then on the next one
for i in 2 3 4 5 6; do q "begin; $AS $(rsave 00000000-0000-0000-0000-0000000cc0f$i) commit;" >/dev/null; done
q "begin; $AS select public.recurring_plan_set('00000000-0000-0000-0000-0000000cc0f6', 'pause'); commit;" >/dev/null
N1=$(q "select next_date from public.recurring_plans where id = '$P0'")
N2=$(q "select public.recurring_on_or_after(public.il_today(), 1, least(extract(day from public.il_today())::int, 28), '$N1'::date + 1)")
at() { echo "(('$1'::date + case when extract(isodow from '$1'::date) = 6 then 1 else 0 end) + time '10:00') at time zone 'Asia/Jerusalem'"; }
for w in $(seq 8); do
  printf 'begin;\nset local role service_role;\nselect count(*) from public.recurring_due(%s);\ncommit;\n' "$(at "$N1")" > "$TMP/rdue-$w.sql"
  printf 'begin;\nset local role service_role;\nselect count(*) from public.recurring_due(%s);\ncommit;\n' "$(at "$N2")" > "$TMP/rdue2-$w.sql"
  chmod 644 "$TMP/rdue-$w.sql" "$TMP/rdue2-$w.sql"
done
run_parallel rdue
RC="select count(*) || ' ' || count(distinct (plan_id, period_date)) || ' ' || coalesce(sum(attempts), 0) || ' ' ||
           count(*) filter (where plan_id = '00000000-0000-0000-0000-0000000cc0f6') from public.recurring_charges where business_id = '$B'"
r=$(q "$RC")
[ "$r" = "5 5 5 0" ] || fail "the timer 8 times at once: one charge per active plan, each handed out once, none for the paused (expected 5 5 5 0, got: $r)"
run_parallel rdue2
r=$(q "$RC")
[ "$r" = "10 10 15 0" ] || fail "the timer 8 times at once on the next date: one more each, all 10 handed out once (expected 10 10 15 0, got: $r)"
echo "ok: the recurring timer from 8 connections at once, on two dates → one charge per plan and period, each handed out once, none for a paused plan"

# ---- 17. locations and registers: one open day per register, one series of numbers, at most 10 locations (4600) -----------------
LL=00000000-0000-0000-0000-0000000cc1a1; LR=00000000-0000-0000-0000-0000000cc1a2
q "begin; $AS select public.location_save('$LL', 'סניף עומס', 'store', '', '', '', true, 1);
   select public.register_save('$LR', '$LL', 'קופה 2', '', true, 1); commit;" >/dev/null
q "update public.register_shifts set closed_at = now(), counted_cash = 0, expected_cash = 0, difference = 0 where business_id = '$B' and closed_at is null;" >/dev/null
shift() { echo "insert into public.register_shifts (user_id, opening_cash, register_id) values ('$U', 0, '$1');"; }
for w in $(seq 8); do worker_script "$TMP/shift-$w.sql" 1 "$(shift "$B")"; done
run_parallel shift
r=$(q "select count(*) from public.register_shifts where business_id = '$B' and closed_at is null")
[ "$r" = "1" ] || fail "8 connections open a day on one register at once: one open day (got: $r)"
q "update public.register_shifts set closed_at = now(), counted_cash = 0, expected_cash = 0, difference = 0 where business_id = '$B' and closed_at is null;" >/dev/null
rm -f "$TMP"/shift-*.sql
for w in $(seq 8); do worker_script "$TMP/shift-$w.sql" 1 "$(shift "$([ $((w % 2)) = 0 ] && echo "$B" || echo "$LR")")"; done
run_parallel shift
r=$(q "select count(*) || ' ' || count(distinct register_id) from public.register_shifts where business_id = '$B' and closed_at is null")
[ "$r" = "2 2" ] || fail "8 connections (one person) open days on two registers at once: one each (expected 2 2, got: $r)"
echo "ok: 8 connections open a day on one register at once → one; on two registers (the same person) → one each"
before=$(q "select coalesce(max(doc_number), 0) from public.documents where business_id = '$B' and doc_type = 320")
for w in $(seq 8); do
  loc=$([ $((w % 2)) = 0 ] && echo "$B" || echo "$LL")
  worker_script "$TMP/locdocs-$w.sql" 10 "$(printf "$DOC" ', location_id' 320 100 100 18 118 100 "$(pay 118)" ", '$loc'")"
done
run_parallel locdocs
r=$(q "select count(*) || ' ' || count(distinct doc_number) || ' ' || (max(doc_number) - $before) || ' ' ||
              count(*) filter (where location_id = '$LL') || ' ' || count(*) filter (where location_id = '$B')
         from public.documents where business_id = '$B' and doc_type = 320 and doc_number > $before")
[ "$r" = "80 80 80 40 40" ] || fail "80 documents from 8 connections in two locations: one series, no gap (expected 80 80 80 40 40, got: $r)"
echo "ok: 80 documents from 8 connections in two locations → one series of numbers for the business, no gap, no double"
for w in $(seq 8); do worker_script "$TMP/newloc-$w.sql" 2 "select public.location_save(null, 'סניף ' || gen_random_uuid(), 'warehouse', '', '', '', true, 0);"; done
run_parallel newloc
r=$(q "select count(*) from public.business_locations where business_id = '$B'")
[ "$r" = "10" ] || fail "16 new locations at once: never more than 10 (got: $r)"
echo "ok: 16 new locations from 8 connections at once → 10, never more"

# ---- 18. stock by location: crossing sales at two locations, a transfer and a count approved from 8 connections (4700) ----------
SI=00000000-0000-0000-0000-0000000cc1b1; ST1=00000000-0000-0000-0000-0000000cc1b2; SC1=00000000-0000-0000-0000-0000000cc1b3
q "insert into public.catalog_items (id, user_id, business_id, name, price, kind, track_stock) values ('$SI', '$U', '$B', 'מוצר עומס', 10, 'product', true);" >/dev/null
q "begin; $AS select public.stock_adjust('$B', '$SI', null, 'set', 100); select public.stock_adjust('$LL', '$SI', null, 'add', 40); commit;" >/dev/null
q "update public.register_shifts set closed_at = now(), counted_cash = 0, expected_cash = 0, difference = 0 where business_id = '$B' and closed_at is null;" >/dev/null
ssale() { echo "insert into public.sales (user_id, items, subtotal, total, vat_rate, vat_amount, method, status, paid_at, register_id)
  values ('$U', '[{\"name\":\"x\",\"price\":10,\"qty\":1,\"itemId\":\"$SI\"}]', 10, 10, 18, 1.53, 'cash', 'paid', now(), '$1');"; }
for w in $(seq 8); do
  : > "$TMP/ssale-$w.sql"
  for k in $(seq 5); do
    printf 'begin;\n%s\n%s\ncommit;\nbegin;\n%s\n%s\ncommit;\n' "$AS" "$(ssale "$([ $((w % 2)) = 0 ] && echo "$B" || echo "$LR")")" \
      "$AS" "$(ssale "$([ $((w % 2)) = 0 ] && echo "$LR" || echo "$B")")" >> "$TMP/ssale-$w.sql"
  done
  chmod 644 "$TMP/ssale-$w.sql"
done
run_parallel ssale
r=$(q "select public.stock_at('$B', '$SI', null) || ' ' || public.stock_at('$LL', '$SI', null) || ' ' || (select stock_qty from public.catalog_items where id = '$SI')
        || ' ' || (select coalesce(sum(delta), 0) from public.stock_movements where item_id = '$SI' and location_id = '$LL')")
[ "$r" = "60 0 60 0" ] || fail "80 crossing sales at two locations: 60 left at the main one, none at the branch (expected 60 0 60 0, got: $r)"
echo "ok: 80 sales from 8 connections at two locations, crossing → each location's count and the total right, no deadlock"
q "begin; $AS select public.stock_adjust('$LL', '$SI', null, 'add', 10); commit;" >/dev/null
for w in $(seq 8); do worker_script "$TMP/tsend-$w.sql" 1 "select public.stock_transfer_send('$ST1', '$B', '$LL', '[{\"itemId\":\"$SI\",\"qty\":5}]');"; done
run_parallel tsend
for w in $(seq 8); do worker_script "$TMP/trecv-$w.sql" 1 "select public.stock_transfer_receive('$ST1', '[]');"; done
run_parallel trecv
r=$(q "select (select count(*) from public.stock_transfers where id = '$ST1' and status = 'received') || ' ' ||
              (select count(*) || '/' || sum(delta) from public.stock_movements where transfer_id = '$ST1') || ' ' ||
              public.stock_at('$B', '$SI', null) || ' ' || public.stock_at('$LL', '$SI', null)")
[ "$r" = "1 2/0 55 15" ] || fail "one transfer sent and received from 8 connections: once each (expected 1 2/0 55 15, got: $r)"
echo "ok: the same transfer sent and received from 8 connections at once → one transfer, out once and in once"
for w in $(seq 8); do worker_script "$TMP/cstart-$w.sql" 1 "select public.stock_count_start(gen_random_uuid(), '$LL');"; done
run_parallel cstart
r=$(q "select count(*) from public.stock_counts where location_id = '$LL' and status = 'open'")
[ "$r" = "1" ] || fail "8 new counts of one location at once: one open (got: $r)"
q "begin; $AS select public.stock_count_cancel(id) from public.stock_counts where location_id = '$LL' and status = 'open'; commit;" >/dev/null
q "begin; $AS select public.stock_count_start('$SC1', '$B'); select public.stock_count_set('$SC1', '$SI', null, 50); commit;" >/dev/null
for w in $(seq 8); do worker_script "$TMP/capprove-$w.sql" 1 "select public.stock_count_approve('$SC1');"; done
run_parallel capprove
r=$(q "select (select status from public.stock_counts where id = '$SC1') || ' ' ||
              (select count(*) || '/' || sum(delta) from public.stock_movements where count_id = '$SC1') || ' ' || public.stock_at('$B', '$SI', null)")
[ "$r" = "approved 1/-5 50" ] || fail "one count approved from 8 connections: its difference once (expected approved 1/-5 50, got: $r)"
echo "ok: 8 new counts of one location at once → one open; one count approved 8 times at once → its difference once"

# ---- 19. serial numbers and SKU series: one number from 8 registers, crossing sales and transfers, 80 SKUs at once (4800) --------
NP=00000000-0000-0000-0000-0000000cc1c1; NQ=00000000-0000-0000-0000-0000000cc1c2; NS=00000000-0000-0000-0000-0000000cc1c3
q "insert into public.catalog_items (id, user_id, business_id, name, price, kind, track_stock) values
     ('$NP', '$U', '$B', 'טלפון עומס', 10, 'product', true), ('$NQ', '$U', '$B', 'שעון עומס', 10, 'product', true);" >/dev/null
q "begin; $AS select public.serial_tracking('$NP', true); select public.serial_tracking('$NQ', true);
   select public.serial_receive('$NP', null, '$B', array(select 'A-' || g from generate_series(1, 20) g));
   select public.serial_receive('$NQ', null, '$B', array(select 'B-' || g from generate_series(1, 20) g)); commit;" >/dev/null
nline() { echo "{\"name\":\"x\",\"price\":10,\"qty\":1,\"itemId\":\"$1\",\"serials\":[\"$2\"]}"; }
nsale() { echo "insert into public.sales (user_id, items, subtotal, total, vat_rate, vat_amount, method, status, paid_at, register_id)
  values ('$U', '[$1]', 10, 10, 18, 1.53, 'cash', 'paid', now(), '$B');"; }
for w in $(seq 8); do worker_script "$TMP/nsame-$w.sql" 1 "$(nsale "$(nline "$NP" A-1)")"; done
run_parallel nsame
r=$(q "select (select count(*) from public.catalog_serials where item_id = '$NP' and serial = 'A-1' and status = 'sold') || ' ' ||
              (select count(*) from public.catalog_serial_events e join public.catalog_serials s on s.id = e.serial_id
                where s.item_id = '$NP' and s.serial = 'A-1' and e.kind = 'sold') || ' ' ||
              (select count(*) from public.sales where business_id = '$B' and items @> '[{\"serials\":[\"A-1\"]}]') || ' ' ||
              (select stock_qty from public.catalog_items where id = '$NP')")
[ "$r" = "1 1 1 19" ] || fail "one number from 8 registers at once: sold once (expected 1 1 1 19, got: $r)"
echo "ok: one serial number sold from 8 registers at once → one sale holds it, 7 refused (the DoD)"
for w in $(seq 8); do
  : > "$TMP/ncross-$w.sql"
  for j in 1 2; do
    n=$((1 + (w - 1) * 2 + j))
    if [ $((w % 2)) = 0 ]; then
      if [ $((w % 4)) = 0 ]; then st=$(nsale "$(nline "$NP" "A-$n"),$(nline "$NQ" "B-$n")"); else st=$(nsale "$(nline "$NQ" "B-$n"),$(nline "$NP" "A-$n")"); fi
    else
      st="select public.stock_transfer_send(gen_random_uuid(), '$B', '$LL', '[$(nline "$NQ" "B-$n"),$(nline "$NP" "A-$n")]');"
    fi
    printf 'begin;\n%s\n%s\ncommit;\n' "$AS" "$st" >> "$TMP/ncross-$w.sql"
  done
  chmod 644 "$TMP/ncross-$w.sql"
done
run_parallel ncross
r=$(q "select string_agg(x, ' ' order by x) from (select right(item_id::text, 1) || ':' || status || ':' || count(*) as x from public.catalog_serials
         where item_id in ('$NP', '$NQ') group by item_id, status) z")
[ "$r" = "1:in_stock:3 1:in_transit:8 1:sold:9 2:in_stock:4 2:in_transit:8 2:sold:8" ] \
  || fail "sales and transfers of numbered products, crossing: every number once (got: $r)"
r=$(q "select (select stock_qty from public.catalog_items where id = '$NP') || ' ' || (select stock_qty from public.catalog_items where id = '$NQ') || ' ' ||
              (select count(*) from public.stock_transfers where business_id = '$B' and status = 'sent' and lines::text like '%\"serials\"%')")
[ "$r" = "3 4 8" ] || fail "crossing: the stock follows the numbers (expected 3 4 8, got: $r)"
echo "ok: 16 sales and 16 transfers of two numbered products from 8 connections, crossing → every number once, the stock with them, no deadlock"
q "begin; $AS select public.sku_series_save('$NS', 'עומס', 'LD', 4, 1, true); commit;" >/dev/null
for w in $(seq 8); do
  worker_script "$TMP/nsku-$w.sql" 10 "insert into public.catalog_items (user_id, business_id, name, price, kind, sku) values ('$U', '$B', 'פריט ' || gen_random_uuid(), 1, 'product', public.sku_next('$NS'));"
done
run_parallel nsku
r=$(q "select count(*) || ' ' || count(distinct sku) || ' ' || min(sku) || ' ' || max(sku) || ' ' || (select next_no from public.sku_series where id = '$NS')
         from public.catalog_items where business_id = '$B' and sku like 'LD-%'")
[ "$r" = "80 80 LD-0001 LD-0080 81" ] || fail "80 new products with the next SKU from 8 connections: none twice, no gap (expected 80 80 LD-0001 LD-0080 81, got: $r)"
echo "ok: 80 new products from 8 connections, each with the next SKU of one series → LD-0001..LD-0080, none twice, no gap"

# ---- 20. the desks, deposits, the bank and the goods documents (5000) --------------------------------------------------------------
W=$(q "select id from public.business_locations where business_id = '$B' and kind = 'warehouse' order by created_at, id limit 1")
[ -n "$W" ] || fail "a location of its own for the desk"
CH=00000000-0000-0000-0000-0000000cc1d1
for k in 1 2 3 4; do q "begin; $AS $(printf "$DOC" ', location_id, idempotency_key' 320 100 100 18 118 100 "$(pay 118)" ", '$W', 'desk-cash-$k'") commit;" >/dev/null; done
q "begin; $AS $(printf "$DOC" ', location_id, idempotency_key' 320 100 100 18 118 100 \
   "jsonb_build_array(jsonb_build_object('method', 2, 'amount', 118, 'm', 'cheque', 'cheque', jsonb_build_object('number', '777')))" ", '$W', 'desk-cheque'") commit;" >/dev/null
q "begin; $AS $(printf "$DOC" ', location_id, idempotency_key' 320 100 100 18 118 100 \
   "jsonb_build_array(jsonb_build_object('method', 4, 'amount', 118, 'm', 'transfer'))" ", '$W', 'desk-transfer'") commit;" >/dev/null
CHP=$(q "select p.id from public.payments p join public.documents d on d.id = p.document_id where d.idempotency_key = 'desk-cheque' and p.business_id = '$B'")
TRP=$(q "select p.id from public.payments p join public.documents d on d.id = p.document_id where d.idempotency_key = 'desk-transfer' and p.business_id = '$B'")
for w in $(seq 8); do worker_script "$TMP/dchq-$w.sql" 1 "select public.bank_deposit_create(gen_random_uuid(), public.il_today(), '$W', 0, array['$CHP'::uuid], '');"; done
run_parallel dchq
r=$(q "select (select count(*) from public.bank_deposit_cheques where payment_id = '$CHP' and active) || ' ' ||
              (select count(*) from public.bank_deposits where business_id = '$B' and location_id = '$W')")
[ "$r" = "1 1" ] || fail "one cheque deposited from 8 connections at once: in one deposit (expected 1 1, got: $r)"
echo "ok: one cheque deposited from 8 connections at once → one deposit holds it, 7 refused"
for w in $(seq 8); do worker_script "$TMP/dcash-$w.sql" 1 "select public.bank_deposit_create(gen_random_uuid(), public.il_today(), '$W', 118, '{}', '');"; done
run_parallel dcash
r=$(q "select (select count(*) from public.bank_deposits where business_id = '$B' and location_id = '$W' and cash > 0) || ' ' || public.cash_desk_cash('$B', '$W')
        || ' ' || (select count(distinct number) || '/' || count(*) from public.bank_deposits where business_id = '$B')")
[ "$r" = "4 0.00 5/5" ] || fail "8 deposits of 118 from a desk of 472 at once: exactly 4, the desk at 0, numbers unique (expected 4 0.00 5/5, got: $r)"
echo "ok: 8 deposits of the cash desk at once → never more than it holds (4 of 8), no number twice"
FILE=$(q "select jsonb_agg(jsonb_build_object('date', public.il_today() - (g % 5), 'amount', 100 + g, 'description', 'שורה ' || g)) from generate_series(1, 20) g")
for w in $(seq 8); do worker_script "$TMP/bimp-$w.sql" 1 "select public.bank_import(gen_random_uuid(), 'עומס', 'file.csv', '$FILE'::jsonb);"; done
run_parallel bimp
r=$(q "select (select count(*) from public.bank_lines where business_id = '$B') || ' ' || (select count(*) from public.bank_statements where business_id = '$B')
        || ' ' || (select sum(lines_new) from public.bank_statements where business_id = '$B')")
[ "$r" = "20 8 20" ] || fail "the same file imported from 8 connections at once: each line once (expected 20 8 20, got: $r)"
echo "ok: the same file of 20 lines imported from 8 connections at once → 20 lines, each once"
q "begin; $AS select public.bank_import(gen_random_uuid(), 'עומס', 'file2.csv', (select jsonb_agg(jsonb_build_object('date', public.il_today(), 'amount', 118, 'description', 'העברה ' || g)) from generate_series(1, 8) g)); commit;" >/dev/null
for w in $(seq 8); do
  worker_script "$TMP/bmatch-$w.sql" 1 "select public.bank_match((select id from public.bank_lines where business_id = '$B' and description = 'העברה $w'), array['$TRP'::uuid]);"
done
run_parallel bmatch
r=$(q "select (select count(*) from public.bank_matches where payment_id = '$TRP' and active) || ' ' ||
              (select count(*) from public.bank_lines where business_id = '$B' and description like 'העברה %' and status = 'matched')")
[ "$r" = "1 1" ] || fail "one receipt approved on 8 lines at once: one match (expected 1 1, got: $r)"
echo "ok: one receipt approved on 8 lines from 8 connections at once → one match, 7 lines still open"
q "insert into public.business_finance_profile (business_id, user_id, sells_products) values ('$B', '$U', true)
   on conflict (business_id) do update set sells_products = true;" >/dev/null
GL='[{"name":"מוצר עומס","qty":%s,"unitPriceExVat":10,"discountExVat":0,"totalExVat":%s,"vatRate":18,"kind":1,"itemId":"'$SI'"}]'
gdoc() { # $1 type, $2 qty, $3 key, $4 base type + number ("" = none)
  local b=$(($2 * 10)); local v; v=$(q "select round($b * 0.18, 2)"); local tot; tot=$(q "select $b + $v")
  echo "insert into public.documents (user_id, doc_type, doc_number, doc_date, before_discount, discount, after_discount, vat_amount, total, vat_rate, lines, payments, idempotency_key$( [ -n "$4" ] && echo ', base_doc_type, base_doc_number'))
    values ('$U', $1, 0, public.il_today(), $b, 0, $b, $v, $tot, 18, '$(printf "$GL" "$2" "$b")', '[]', $3$( [ -n "$4" ] && echo ", $4"));"
}
q "begin; $AS $(gdoc 200 3 "'gd-1'" "") $(gdoc 200 3 "'gd-2'" "") commit;" >/dev/null
N1=$(q "select doc_number from public.documents where business_id = '$B' and idempotency_key = 'gd-1'")
N2=$(q "select doc_number from public.documents where business_id = '$B' and idempotency_key = 'gd-2'")
S0=$(q "select stock_qty from public.catalog_items where id = '$SI'")
for w in $(seq 8); do worker_script "$TMP/ginv-$w.sql" 1 "$(gdoc 305 3 "'gi-$w'" "200, $N1")"; done
run_parallel ginv
for w in $(seq 8); do worker_script "$TMP/gret-$w.sql" 1 "$(gdoc 210 1 "'gr-$w'" "200, $N2")"; done
run_parallel gret
r=$(q "select (select count(*) from public.documents where business_id = '$B' and doc_type = 305 and base_doc_type = 200 and base_doc_number = $N1) || ' ' ||
              (select count(*) from public.documents where business_id = '$B' and doc_type = 210 and base_doc_type = 200 and base_doc_number = $N2) || ' ' ||
              ((select stock_qty from public.catalog_items where id = '$SI') - $S0)")
[ "$r" = "1 3 3" ] || fail "a delivery note invoiced 8 times / 8 returns of one on a note of 3, at once: one invoice, 3 returns, 3 back (expected 1 3 3, got: $r)"
echo "ok: one delivery note invoiced from 8 connections at once → one invoice; 8 returns of one unit on a note of 3 → exactly 3, 3 back in stock"

# ---- 21. manual journal entries (5100) -----------------------------------------------------------------------------------------------
JE=00000000-0000-0000-0000-0000000cc1e1
for w in $(seq 8); do worker_script "$TMP/jsame-$w.sql" 1 "select public.journal_entry_create('$JE', public.il_today(), 'income', 100, 18, null, null, 'עומס');"; done
run_parallel jsame
r=$(q "select count(*) || ' ' || coalesce(max(number), 0) from public.journal_entries where business_id = '$B'")
[ "$r" = "1 1" ] || fail "the same new entry from 8 connections at once: one entry (expected 1 1, got: $r)"
echo "ok: the same new entry from 8 connections at once → one entry, number 1"
for w in $(seq 8); do worker_script "$TMP/jmany-$w.sql" 10 "select public.journal_entry_create(gen_random_uuid(), public.il_today(), 'expense', 10, 1.8, null, 'other', 'עומס $w');"; done
run_parallel jmany
r=$(q "select count(*) || ' ' || count(distinct number) || ' ' || min(number) || ' ' || max(number) from public.journal_entries where business_id = '$B'")
[ "$r" = "81 81 1 81" ] || fail "8 connections × 10 entries: numbered 1..81, no gap, no double (expected 81 81 1 81, got: $r)"
echo "ok: 8 connections × 10 entries at once → numbers 1..81, no gap, no double"
for w in $(seq 8); do worker_script "$TMP/jrev-$w.sql" 1 "select public.journal_entry_reverse(gen_random_uuid(), '$JE', null, 'ביטול $w');"; done
run_parallel jrev
r=$(q "select (select count(*) from public.journal_entries where reverses = '$JE') || ' ' || (select count(*) from public.journal_entries where business_id = '$B')
        || ' ' || (select count(*) from public.finance_audit_log where business_id = '$B' and action like 'journal.%')")
[ "$r" = "1 82 82" ] || fail "one entry undone from 8 connections at once: one reversal, each in the audit log once (expected 1 82 82, got: $r)"
echo "ok: one entry undone from 8 connections at once → one reversal, 7 refused; every entry in the audit log once"

