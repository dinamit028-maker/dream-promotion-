#!/usr/bin/env bash
# Numbering and limits under real concurrency (Dream Finance 2.51): several Postgres connections at the same time,
# each in its own transactions, as signed-in users — never one session pretending to be many.
#   1. 8 connections × 25 tax invoice-receipts (320)  → numbers 1..200, no gap, no double
#   2. 8 connections race for the same idempotency key → exactly one document, and the next number has no gap
#   3. 8 connections credit the same invoice of ₪1,180 with ₪236 each → exactly 5 succeed, never beyond the invoice
#   4. 8 connections × 10 quotes and × 10 expenses     → numbers 1..80 each
#   5. the audit chain of the business is intact afterwards
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
