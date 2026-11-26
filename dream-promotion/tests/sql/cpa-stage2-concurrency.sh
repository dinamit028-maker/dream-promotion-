#!/usr/bin/env bash
# Stage 2 (2.119, migration 6900) under real concurrency — QA: several Postgres connections at the same time, each in its own
# transactions, as the server (service_role) or as a signed-in user — never one session pretending to be many.
#   1. 8 connections open the same customer link for the first time at once      → 8 deliveries, EXACTLY ONE original
#   2. 8 connections open the link of a document waiting for its allocation number → nothing recorded, nothing told (awaiting_allocation)
#   3. 4 server opens + 4 prints from the app at once, on one document             → one original in all, the print counter = the prints
#   4. 8 connections start the same monthly backup at once                         → one run; 8 more after it is ok → still one, no new file path
# Not part of run.sh (QA addition): bash tests/sql/cpa-stage2-concurrency.sh <db>   (the db after tests/sql/run.sh's migrations)
set -euo pipefail
cd "$(dirname "$0")/../.."
DB=${1:-${DP_TEST_DB:-dp_test}}
as_pg() { if [ "$(id -un)" = postgres ]; then "$@"; else su postgres -c "$(printf '%q ' "$@")"; fi; }
q() { as_pg psql -X -q -t -A -v ON_ERROR_STOP=1 -d "$DB" -c "$1"; }
TMP=$(mktemp -d); chmod 755 "$TMP"; trap 'rm -rf "$TMP"' EXIT
# fresh ids each run (it can be run again on the same database)
U=$(cat /proc/sys/kernel/random/uuid); B=$(cat /proc/sys/kernel/random/uuid); SFX=${B:0:8}
fail() { echo "CHECK FAILED: $1"; exit 1; }

q "insert into auth.users (id, email) values ('$U', 'stage2-$SFX@example.test') on conflict do nothing;
   insert into public.businesses (id, name, slug) values ('$B', 'Stage2', 'stage2-$SFX') on conflict do nothing;
   insert into public.business_members (business_id, user_id, role) values ('$B', '$U', 'owner') on conflict do nothing;
   update public.profiles set current_business_id = '$B' where id = '$U';
   insert into public.register_settings (user_id, business_id, business_type, vat_rate, dealer_number, legal_name, entity_type)
   values ('$U', '$B', 'licensed', 18, '000000018', 'Stage2 Ltd', 'licensed_dealer') on conflict do nothing;" >/dev/null

AS="set local role authenticated; select set_config('request.jwt.claim.sub', '$U', true);"
SERVER="set local role service_role; select set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claim.role', 'service_role', true);"
issue() { # $1 = key, $2 = before VAT, $3 = customer dealer ('' = a private customer)
  q "begin; $AS insert into public.documents (user_id, doc_type, doc_number, doc_date, customer_name, customer_dealer, before_discount, discount, after_discount, vat_amount, total, vat_rate, lines, payments, idempotency_key)
     values ('$U', 305, 0, public.il_today(), 'x', '$3', $2, 0, $2, $2 * 0.18, $2 * 1.18, 18, jsonb_build_array(jsonb_build_object('name', 'x', 'qty', 1, 'totalExVat', $2)), '[]'::jsonb, '$1'); commit;" >/dev/null
}
issue open:small-$SFX 100 ''
issue open:big-$SFX 7000 '000000059'
issue open:mix-$SFX 100 ''
tok() { q "select share_token from public.documents where idempotency_key = '$1'"; }
run_parallel() { local pids=(); for f in "$TMP"/"$1"-*.sql; do as_pg psql -X -q -v ON_ERROR_STOP=0 -d "$DB" -f "$f" >/dev/null 2>&1 & pids+=($!); done; for p in "${pids[@]}"; do wait "$p" || true; done; }
script() { printf 'begin;\n%s\n%s\ncommit;\n' "$2" "$3" > "$1"; chmod 644 "$1"; }

# ---- 1 ----
T=$(tok open:small-$SFX)
for w in $(seq 8); do script "$TMP/first-$w.sql" "$SERVER" "select public.document_share_open('$T', 'link');"; done
run_parallel first
r=$(q "select count(*) || ' ' || count(*) filter (where is_original) from public.document_deliveries where document_id = (select id from public.documents where idempotency_key = 'open:small-$SFX')")
[ "$r" = "8 1" ] || fail "8 first opens at once: 8 deliveries and exactly one original (got: $r)"
echo "ok: 8 connections open one link at once → 8 deliveries, exactly one original"

# ---- 2 ----
T=$(tok open:big-$SFX)
for w in $(seq 8); do script "$TMP/wait-$w.sql" "$SERVER" "select public.document_share_open('$T', (array['link','pdf','storefront'])[1 + $w % 3]);"; done
run_parallel wait
r=$(q "select count(*) from public.document_deliveries where document_id = (select id from public.documents where idempotency_key = 'open:big-$SFX')")
[ "$r" = "0" ] || fail "a document waiting for its number is never delivered, under a race (got $r deliveries)"
r=$(q "select count(*) from public.finance_audit_log where action = 'document.delivered' and entity_id = (select id::text from public.documents where idempotency_key = 'open:big-$SFX')")
[ "$r" = "0" ] || fail "nothing logged as delivered for it (got $r)"
echo "ok: 8 racing opens of a document waiting for its allocation number → none recorded"

# ---- 3 ----
T=$(tok open:mix-$SFX); D=$(q "select id from public.documents where idempotency_key = 'open:mix-$SFX'")
for w in 1 2 3 4; do script "$TMP/mix-s$w.sql" "$SERVER" "select public.document_share_open('$T', 'pdf');"; script "$TMP/mix-p$w.sql" "$AS" "select public.document_delivery_record('$D', 'print');"; done
run_parallel mix
r=$(q "select count(*) || ' ' || count(*) filter (where is_original) || ' ' || (select print_count from public.documents where id = '$D') from public.document_deliveries where document_id = '$D'")
[ "$r" = "8 1 4" ] || fail "4 opens + 4 prints at once: 8 deliveries, one original, print counter 4 (got: $r)"
echo "ok: 4 link opens + 4 prints at once → one original in all, the print counter = the prints"

# ---- 4 ----
P=$(q "select to_char((date_trunc('month', public.il_today()) - interval '1 month')::date, 'YYYY-MM')")
for w in $(seq 8); do script "$TMP/bk-$w.sql" "$SERVER" "select public.backup_run_start('monthly', '$P', '$B');"; done
run_parallel bk
r=$(q "select count(*) || ' ' || count(distinct object_path) from public.backup_runs where kind = 'monthly' and period = '$P' and business_id = '$B'")
[ "$r" = "1 1" ] || fail "the same backup started 8 times at once is one run (got: $r)"
PATH_=$(q "select object_path from public.backup_runs where kind = 'monthly' and period = '$P' and business_id = '$B'")
q "begin; $SERVER insert into storage.objects (bucket_id, name, metadata) values ('backups', '$PATH_', '{\"size\": 10}'); select public.backup_run_finish((select id from public.backup_runs where object_path = '$PATH_'), repeat('a', 64), 10, '{\"documents\": 1}'); commit;" >/dev/null
for w in $(seq 8); do script "$TMP/bk2-$w.sql" "$SERVER" "select public.backup_run_start('monthly', '$P', '$B');"; done
run_parallel bk2
r=$(q "select count(*) || ' ' || count(*) filter (where status = 'ok') from public.backup_runs where kind = 'monthly' and period = '$P' and business_id = '$B'")
[ "$r" = "1 1" ] || fail "once ok, the period never starts a second run (got: $r)"
echo "ok: 8 racing starts of one backup → one run; after it is ok, 8 more → still one (no second file path)"
