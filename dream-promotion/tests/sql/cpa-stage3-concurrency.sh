#!/usr/bin/env bash
# Stage 3 (2.120, migration 7000) under real concurrency: several Postgres connections at the same time, each in its own
# transactions, as the signed-in owner — never one session pretending to be many.
#   1. 8 connections issue 30 documents each, in two locations, while the owner switches the business to numbering per location
#      in the middle → the business's series has no gap and no double; each location's series = its branch code, then 1, 2, 3 …
#      with no gap and no double; no number twice in the business; no document refused
#   2. 8 connections issue 10 more each, after the switch → each location's series goes on, no gap, no double
# Not part of run.sh: bash tests/sql/cpa-stage3-concurrency.sh <db>   (the db after tests/sql/run.sh's migrations)
set -euo pipefail
cd "$(dirname "$0")/../.."
DB=${1:-${DP_TEST_DB:-dp_test}}
as_pg() { if [ "$(id -un)" = postgres ]; then "$@"; else su postgres -c "$(printf '%q ' "$@")"; fi; }
q() { as_pg psql -X -q -t -A -v ON_ERROR_STOP=1 -d "$DB" -c "$1"; }
TMP=$(mktemp -d); chmod 755 "$TMP"; trap 'rm -rf "$TMP"' EXIT
# fresh ids each run (it can be run again on the same database)
U=$(cat /proc/sys/kernel/random/uuid); B=$(cat /proc/sys/kernel/random/uuid); L2=$(cat /proc/sys/kernel/random/uuid); SFX=${B:0:8}
fail() { echo "CHECK FAILED: $1"; exit 1; }

q "insert into auth.users (id, email) values ('$U', 'stage3-$SFX@example.test');
   insert into public.businesses (id, name, slug) values ('$B', 'Stage3', 'stage3-$SFX');
   insert into public.business_members (business_id, user_id, role, access) values ('$B', '$U', 'owner', 'full');
   update public.profiles set current_business_id = '$B' where id = '$U';
   insert into public.register_settings (user_id, business_id, business_type, vat_rate, dealer_number, legal_name, entity_type)
   values ('$U', '$B', 'licensed', 18, '000000075', 'Stage3 Ltd', 'licensed_dealer');
   insert into public.business_locations (id, business_id, name, kind, sort) values ('$L2', '$B', 'סניף שני', 'branch', 1);" >/dev/null

AS="set local role authenticated; select set_config('request.jwt.claim.sub', '$U', true);"
worker() { # $1 = file, $2 = how many, $3 = key prefix, $4 = location
  : > "$1"
  for i in $(seq "$2"); do
    printf "begin; %s insert into public.documents (user_id, doc_type, doc_number, doc_date, before_discount, discount, after_discount, vat_amount, total, vat_rate, lines, idempotency_key, location_id) values ('%s', 300, 0, public.il_today(), 100, 0, 100, 18, 118, 18, '[{\"name\":\"x\",\"qty\":1,\"totalExVat\":100}]', '%s:%s', '%s'); commit;\n" \
      "$AS" "$U" "$3" "$i" "$4" >> "$1"
  done
  chmod 644 "$1"
}
run_parallel() { local pids=(); for f in "$TMP"/"$1"-*.sql; do as_pg psql -X -q -v ON_ERROR_STOP=0 -d "$DB" -f "$f" > "$f.out" 2>&1 & pids+=($!); done; }
wait_all() { wait; }
loc_of() { if [ $(( $1 % 2 )) = 0 ]; then echo "$L2"; else echo "$B"; fi; }

# ---- 1. issuing in two locations while the owner switches ------------------------------------------------------------------
for w in $(seq 8); do worker "$TMP/a-$w.sql" 30 "c3a-$SFX-$w" "$(loc_of "$w")"; done
run_parallel a
sleep 0.3
r=$(q "begin; $AS select public.document_numbering_per_location()->>'perLocation'; commit;" | grep -E '^(true|false)$' || true)
wait_all
[ "$r" = "true" ] || fail "the owner switched in the middle (got: $r)"
errs=$(cat "$TMP"/a-*.sql.out | grep -c ERROR || true)
[ "$errs" = "0" ] || fail "no document refused around the switch (got $errs errors: $(grep -h ERROR "$TMP"/a-*.sql.out | head -2))"
r=$(q "select count(*) || ' ' || count(distinct doc_number) || ' ' || coalesce(max(doc_number), 0)
         from public.documents where business_id = '$B' and series_location_id is null")
set -- $r; [ "$1" = "$2" ] && [ "$1" = "$3" ] || fail "the business's series: 1..n, no gap, no double (count distinct max: $r)"
BUS=$1
for L in "$B" "$L2"; do
  code=$(q "select branch_code from public.business_locations where id = '$L'")
  r=$(q "select count(*) || ' ' || count(distinct doc_number) || ' ' || coalesce(min(doc_number), 0) || ' ' || coalesce(max(doc_number), 0)
           from public.documents where business_id = '$B' and series_location_id = '$L'")
  set -- $r
  [ "$1" = "$2" ] && [ "$3" = "$(( 10#$code * 1000000 + 1 ))" ] && [ "$4" = "$(( 10#$code * 1000000 + $1 ))" ] \
    || fail "location $code: ${code}000001 .. with no gap and no double (count distinct min max: $r)"
done
r=$(q "select count(*) from public.documents where business_id = '$B'")
[ "$r" = "240" ] || fail "every document issued: 240 (got $r)"
echo "ok: 8 connections × 30 documents in two locations, the owner switching in the middle → the business's series 1..$BUS, each location's series from its code (01000001 …, 02000001 …), no gap, no double, none refused"

# ---- 2. after the switch: 8 × 10 more -----------------------------------------------------------------------------------------
for w in $(seq 8); do worker "$TMP/b-$w.sql" 10 "c3b-$SFX-$w" "$(loc_of "$w")"; done
run_parallel b; wait_all
for L in "$B" "$L2"; do
  code=$(q "select branch_code from public.business_locations where id = '$L'")
  r=$(q "select count(*) || ' ' || count(distinct doc_number) || ' ' || coalesce(min(doc_number), 0) || ' ' || coalesce(max(doc_number), 0)
           from public.documents where business_id = '$B' and series_location_id = '$L'")
  set -- $r
  [ "$1" = "$2" ] && [ "$3" = "$(( 10#$code * 1000000 + 1 ))" ] && [ "$4" = "$(( 10#$code * 1000000 + $1 ))" ] \
    || fail "location $code after the switch: no gap and no double (count distinct min max: $r)"
done
r=$(q "select count(*) || ' ' || count(distinct doc_number) from public.documents where business_id = '$B'")
set -- $r; [ "$1" = "320" ] && [ "$2" = "320" ] || fail "320 documents, every number once in the business (got: $r)"
echo "ok: 8 connections × 10 more after the switch → each location's series goes on, no gap, no double; every number once in the business"
