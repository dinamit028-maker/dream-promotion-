#!/usr/bin/env bash
# Stage 3 (2.120, migration 7000) — QA additions, under real concurrency (several Postgres connections at once, as the signed-in owner):
#   1. 8 connections call the switch at the same moment → ONE switch (one row, one log line), every location with its own code
#   2. 8 connections issue 305 / 320 / 400 / 300 in three locations and credit one invoice (330) from two of them, at once → every
#      (location, type) series 1..n with no gap and no double; the number's first two digits are the series' branch code; a credit
#      is of the location that issues it; no number twice in the business and type
#   3. 4 connections set a new location's branch code while 4 issue its first documents → whatever won, every document of the
#      location carries the location's code at the end (a code never changes under a document)
# Not part of run.sh (QA addition): bash tests/sql/cpa-stage3-qa-concurrency.sh <db>   (the db after tests/sql/run.sh's migrations)
set -euo pipefail
cd "$(dirname "$0")/../.."
DB=${1:-${DP_TEST_DB:-dp_test}}
as_pg() { if [ "$(id -un)" = postgres ]; then "$@"; else su postgres -c "$(printf '%q ' "$@")"; fi; }
q() { as_pg psql -X -q -t -A -v ON_ERROR_STOP=1 -d "$DB" -c "$1"; }
TMP=$(mktemp -d); chmod 755 "$TMP"; trap 'rm -rf "$TMP"' EXIT
U=$(cat /proc/sys/kernel/random/uuid); B=$(cat /proc/sys/kernel/random/uuid); L2=$(cat /proc/sys/kernel/random/uuid); L3=$(cat /proc/sys/kernel/random/uuid); L4=$(cat /proc/sys/kernel/random/uuid); SFX=${B:0:8}
fail() { echo "CHECK FAILED: $1"; exit 1; }

q "insert into auth.users (id, email) values ('$U', 'stage3qa-$SFX@example.test');
   insert into public.businesses (id, name, slug) values ('$B', 'Stage3 QA', 'stage3qa-$SFX');
   insert into public.business_members (business_id, user_id, role, access) values ('$B', '$U', 'owner', 'full');
   update public.profiles set current_business_id = '$B' where id = '$U';
   insert into public.register_settings (user_id, business_id, business_type, vat_rate, dealer_number, legal_name, entity_type)
   values ('$U', '$B', 'licensed', 18, '000000075', 'Stage3 QA Ltd', 'licensed_dealer');
   insert into public.business_locations (id, business_id, name, kind, sort) values ('$L2', '$B', 'סניף שני', 'branch', 1), ('$L3', '$B', 'סניף שלישי', 'branch', 2);" >/dev/null
AS="set local role authenticated; select set_config('request.jwt.claim.sub', '$U', true);"
BASEDOC="insert into public.documents (user_id, doc_type, doc_number, doc_date, before_discount, discount, after_discount, vat_amount, total, vat_rate, lines, idempotency_key, due_date)
  values ('$U', 305, 0, public.il_today(), 1000, 0, 1000, 180, 1180, 18, '[{\"name\":\"x\",\"qty\":1,\"totalExVat\":1000}]', 'base:$SFX', public.il_today() + 30);"
q "begin; $AS $BASEDOC commit;" >/dev/null     # the business's 305 #1, before the switch
run_files() { local pids=(); for f in "$TMP"/"$1"-*.sql; do as_pg psql -X -q -v ON_ERROR_STOP=0 -d "$DB" -f "$f" > "$f.out" 2>&1 & pids+=($!); done; for p in "${pids[@]}"; do wait "$p" || true; done; }

# ---- 1. the switch from 8 connections ----------------------------------------------------------------------------------------
for w in $(seq 8); do printf 'begin; %s select public.document_numbering_per_location();\ncommit;\n' "$AS" > "$TMP/sw-$w.sql"; chmod 644 "$TMP/sw-$w.sql"; done
run_files sw
r=$(q "select count(*) from public.document_numbering where business_id = '$B'")
[ "$r" = "1" ] || fail "one switch row (got $r)"
r=$(q "select count(*) from public.finance_audit_log where business_id = '$B' and action = 'numbering.per_location'")
[ "$r" = "1" ] || fail "the switch is in the log once (got $r)"
r=$(q "select string_agg(branch_code, ',' order by branch_code) from public.business_locations where business_id = '$B'")
[ "$r" = "01,02,03" ] || fail "every location has its own code 01,02,03 (got $r)"
r=$(cat "$TMP"/sw-*.sql.out | grep -c ERROR || true)
[ "$r" = "0" ] || fail "no caller got an error (the later ones get the state): $(grep -h ERROR "$TMP"/sw-*.sql.out | head -2)"
echo "ok: 8 connections switch at once → one switch, one log line, codes 01,02,03"

# ---- 2. mixed types, three locations, credits ---------------------------------------------------------------------------------
BASE=$(q "select doc_number from public.documents where idempotency_key = 'base:$SFX'")
[ "$BASE" = "1" ] || fail "the base invoice is the business's #1 (got $BASE)"
loc_of() { case $(( $1 % 3 )) in 0) echo "$B";; 1) echo "$L2";; *) echo "$L3";; esac; }
for w in $(seq 8); do
  f="$TMP/mix-$w.sql"; : > "$f"; loc=$(loc_of "$w")
  for t in 305 320 400 300; do for i in 1 2 3; do
    pay="'[]'::jsonb"; [ "$t" = 320 ] || [ "$t" = 400 ] && pay="jsonb_build_array(jsonb_build_object('method', 1, 'amount', 118))"
    vat=18; tot=118; rate=18; [ "$t" = 400 ] && { vat=0; tot=118; rate=0; } ; [ "$t" = 400 ] && b=118 || b=100
    printf "begin; %s insert into public.documents (user_id, doc_type, doc_number, doc_date, before_discount, discount, after_discount, vat_amount, total, vat_rate, lines, payments, idempotency_key, location_id) values ('%s', %s, 0, public.il_today(), %s, 0, %s, %s, %s, %s, '[{\"name\":\"x\",\"qty\":1,\"totalExVat\":%s}]', %s, 'm:%s:%s:%s:%s', '%s'); commit;\n" \
      "$AS" "$U" "$t" "$b" "$b" "$vat" "$tot" "$rate" "$b" "$pay" "$SFX" "$w" "$t" "$i" "$loc" >> "$f"
  done; done
  if [ $(( w % 2 )) = 0 ]; then   # a credit of 118 on the base invoice, issued at the location of this connection
    printf "begin; %s insert into public.documents (user_id, doc_type, doc_number, doc_date, before_discount, discount, after_discount, vat_amount, total, vat_rate, lines, idempotency_key, location_id, base_doc_type, base_doc_number) values ('%s', 330, 0, public.il_today(), 100, 0, 100, 18, 118, 18, '[{\"name\":\"x\",\"qty\":1,\"totalExVat\":100}]', 'cr:%s:%s', '%s', 305, 1); commit;\n" \
      "$AS" "$U" "$SFX" "$w" "$loc" >> "$f"
  fi
  chmod 644 "$f"
done
run_files mix
errs=$(cat "$TMP"/mix-*.sql.out | grep -c ERROR || true)
[ "$errs" = "0" ] || fail "no document refused (got $errs: $(grep -h ERROR "$TMP"/mix-*.sql.out | head -2))"
r=$(q "select count(*) from public.documents where business_id = '$B' and idempotency_key like 'm:$SFX:%'")
[ "$r" = "96" ] || fail "96 documents issued (got $r)"
r=$(q "select count(*) from public.documents where business_id = '$B' and idempotency_key like 'cr:$SFX:%'")
[ "$r" = "4" ] || fail "4 credits issued (got $r)"
# every (location, type) series: 1..n, no gap, no double, prefix = the location's code
bad=$(q "select count(*) from (
  select d.series_location_id, d.doc_type, count(*) n, count(distinct d.doc_number) dn, min(d.doc_number) mn, max(d.doc_number) mx, l.branch_code::int * 1000000 as base
    from public.documents d join public.business_locations l on l.id = d.series_location_id
   where d.business_id = '$B' and d.series_location_id is not null group by d.series_location_id, d.doc_type, l.branch_code) s
  where n <> dn or mn <> base + 1 or mx <> base + n")
[ "$bad" = "0" ] || fail "every (location, type) series is 1..n with the location's code ($bad series are not)"
r=$(q "select count(*) from public.documents d join public.business_locations l on l.id = d.series_location_id
        where d.business_id = '$B' and floor(d.doc_number / 1000000) <> l.branch_code::int")
[ "$r" = "0" ] || fail "a number's first digits are its series' code ($r are not)"
r=$(q "select count(*) from (select doc_type, doc_number from public.documents where business_id = '$B' group by 1, 2 having count(*) > 1) x")
[ "$r" = "0" ] || fail "no number twice in the business and type ($r)"
r=$(q "select count(*) from public.documents d where d.business_id = '$B' and d.doc_type = 330 and d.series_location_id is distinct from coalesce(d.location_id, d.business_id)")
[ "$r" = "0" ] || fail "a credit is in the series of the location that issues it ($r are not)"
r=$(q "select count(*) from public.documents d where d.business_id = '$B' and d.series_location_id is not null and d.series_location_id is distinct from coalesce(d.location_id, d.business_id)")
[ "$r" = "0" ] || fail "every document is in its own location's series ($r are not)"
r=$(q "select coalesce(sum(total), 0) from public.documents where business_id = '$B' and doc_type = 330 and base_doc_number = 1")
[ "$r" = "472.00" ] || fail "4 credits of 118 on the base invoice (got $r)"
echo "ok: 8 connections × 4 types × 3 locations + 4 credits at once → every (location, type) series 1..n with its code, a credit in its issuer's series, no number twice"

# ---- 3. a branch code set while the location's first documents are issued ---------------------------------------------------------
q "insert into public.business_locations (id, business_id, name, kind, sort) values ('$L4', '$B', 'סניף רביעי', 'branch', 3);" >/dev/null
C0=$(q "select branch_code from public.business_locations where id = '$L4'")
[ "$C0" = "04" ] || fail "a location opened after the switch gets the next free code (got $C0)"
for w in 1 2 3 4; do
  printf "begin; %s select public.location_branch_code_set('%s', '77');\ncommit;\n" "$AS" "$L4" > "$TMP/code-$w.sql"; chmod 644 "$TMP/code-$w.sql"
  f="$TMP/code-d$w.sql"; : > "$f"
  for i in 1 2 3; do printf "begin; %s insert into public.documents (user_id, doc_type, doc_number, doc_date, before_discount, discount, after_discount, vat_amount, total, vat_rate, lines, idempotency_key, location_id) values ('%s', 300, 0, public.il_today(), 100, 0, 100, 18, 118, 18, '[{\"name\":\"x\",\"qty\":1,\"totalExVat\":100}]', 'k:%s:%s:%s', '%s'); commit;\n" "$AS" "$U" "$SFX" "$w" "$i" "$L4" >> "$f"; done
  chmod 644 "$f"
done
run_files code
CODE=$(q "select branch_code from public.business_locations where id = '$L4'")
r=$(q "select count(*) from public.documents where business_id = '$B' and location_id = '$L4'")
[ "$r" = "12" ] || fail "all 12 documents of the new location were issued (got $r)"
r=$(q "select count(*) from public.documents d where d.business_id = '$B' and d.location_id = '$L4' and floor(d.doc_number / 1000000) <> $CODE::int")
[ "$r" = "0" ] || fail "every document of the location carries its final code $CODE (got $r that do not)"
r=$(q "select count(distinct doc_number) || ' ' || min(doc_number) || ' ' || max(doc_number) from public.documents where business_id = '$B' and location_id = '$L4'")
set -- $r; [ "$1" = "12" ] && [ "$2" = "$(( 10#$CODE * 1000000 + 1 ))" ] && [ "$3" = "$(( 10#$CODE * 1000000 + 12 ))" ] || fail "its 12 numbers are ${CODE}000001..${CODE}000012 (got: $r)"
echo "ok: a code set (4×) while the location's first documents are issued (12) → code $CODE, every document of it carries it, no gap, no double"
