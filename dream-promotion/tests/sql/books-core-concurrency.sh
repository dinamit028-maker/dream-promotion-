#!/usr/bin/env bash
# Stage 4ב (migration 7100) under real concurrency: several Postgres connections at once, each in its own transactions, as the
# signed-in owner / cashier — never one session pretending to be many.
#   1. 8 connections issue 25 receipts (320, cash / card in installments) each, in two locations, while the owner records deposits
#      and cancels one, and the server replays the business — every document issued (none refused), every source posted once,
#      the entry numbers 1..n with no gap and no double, every entry balanced, the cash of each location = received − deposited
#   2. a second business issuing at the same time is never held by the first one's books (its own numbers 1..n)
# Not part of run.sh: bash tests/sql/books-core-concurrency.sh <db>   (the db after tests/sql/run.sh's migrations)
set -euo pipefail
cd "$(dirname "$0")/../.."
DB=${1:-${DP_TEST_DB:-dp_test}}
as_pg() { if [ "$(id -un)" = postgres ]; then "$@"; else su postgres -c "$(printf '%q ' "$@")"; fi; }
q() { as_pg psql -X -q -t -A -v ON_ERROR_STOP=1 -d "$DB" -c "$1"; }
TMP=$(mktemp -d); chmod 755 "$TMP"; trap 'rm -rf "$TMP"' EXIT
U=$(cat /proc/sys/kernel/random/uuid); B=$(cat /proc/sys/kernel/random/uuid); L2=$(cat /proc/sys/kernel/random/uuid)
U2=$(cat /proc/sys/kernel/random/uuid); B2=$(cat /proc/sys/kernel/random/uuid); SFX=${B:0:8}
fail() { echo "CHECK FAILED: $1"; exit 1; }

for x in "$U:$B:$SFX-a:000000059" "$U2:$B2:$SFX-b:000000083"; do
  IFS=: read -r u b s dn <<< "$x"
  q "insert into auth.users (id, email) values ('$u', 'books-$s@example.test');
     insert into public.businesses (id, name, slug) values ('$b', 'Books $s', 'books-$s');
     insert into public.business_members (business_id, user_id, role, access) values ('$b', '$u', 'owner', 'full');
     update public.profiles set current_business_id = '$b' where id = '$u';
     insert into public.register_settings (user_id, business_id, business_type, vat_rate, dealer_number, legal_name, entity_type)
     values ('$u', '$b', 'licensed', 18, '$dn', 'Books Ltd', 'licensed_dealer');
     insert into public.business_finance_profile (business_id, user_id, cash_drawers) values ('$b', '$u', true);" >/dev/null
done
q "insert into public.business_locations (id, business_id, name, kind, sort) values ('$L2', '$B', 'סניף שני', 'branch', 1);" >/dev/null
AS="set local role authenticated; select set_config('request.jwt.claim.sub', '$U', true);"
AS2="set local role authenticated; select set_config('request.jwt.claim.sub', '$U2', true);"
q "begin; $AS select public.gl_books_start_set(date_trunc('month', public.il_today())::date); commit;" >/dev/null
q "begin; $AS2 select public.gl_books_start_set(date_trunc('month', public.il_today())::date); commit;" >/dev/null

worker() { # $1 file, $2 how many, $3 key prefix, $4 location, $5 who
  : > "$1"
  for i in $(seq "$2"); do
    if [ $(( i % 3 )) = 0 ]; then
      pay='[{"method":3,"m":"card","amount":118,"cardKind":2,"installments":3}]'
    else
      pay='[{"method":1,"m":"cash","amount":118}]'
    fi
    printf "begin; %s insert into public.documents (user_id, doc_type, doc_number, doc_date, before_discount, discount, after_discount, vat_amount, total, vat_rate, lines, payments, idempotency_key, location_id) values ('%s', 320, 0, public.il_today(), 100, 0, 100, 18, 118, 18, '[{\"name\":\"x\",\"qty\":1,\"totalExVat\":100,\"kind\":1}]', '%s', '%s:%s', '%s'); commit;\n" \
      "$5" "$6" "$pay" "$3" "$i" "$4" >> "$1"
  done
  chmod 644 "$1"
}
loc_of() { if [ $(( $1 % 2 )) = 0 ]; then echo "$L2"; else echo "$B"; fi; }
for w in $(seq 8); do worker "$TMP/a-$w.sql" 25 "bk-$SFX-$w" "$(loc_of "$w")" "$AS" "$U"; done
for w in 1 2; do worker "$TMP/a-x$w.sql" 25 "bk2-$SFX-$w" "$B2" "$AS2" "$U2"; done
pids=()
for f in "$TMP"/a-*.sql; do as_pg psql -X -q -v ON_ERROR_STOP=0 -d "$DB" -f "$f" > "$f.out" 2>&1 & pids+=($!); done
# meanwhile: the owner deposits cash of each location (a little, a few times), cancels one; the server replays
sleep 0.3
: > "$TMP/dep.out"
for k in 1 2 3; do
  D1=$(cat /proc/sys/kernel/random/uuid); D2=$(cat /proc/sys/kernel/random/uuid)
  q "begin; $AS select public.bank_deposit_create('$D1', public.il_today(), '$B', 10, '{}', ''); commit;" >> "$TMP/dep.out" 2>&1 || true
  q "begin; $AS select public.bank_deposit_create('$D2', public.il_today(), '$L2', 10, '{}', ''); commit;" >> "$TMP/dep.out" 2>&1 || true
  q "select public.gl_replay('$B', null);" >> "$TMP/dep.out" 2>&1 || true
  [ "$k" = 2 ] && { q "begin; $AS select public.bank_deposit_cancel('$D2', 'בטעות'); commit;" >> "$TMP/dep.out" 2>&1 || true; }
  sleep 0.2
done
wait "${pids[@]}"
errs=$(cat "$TMP"/a-*.sql.out | grep -c ERROR || true)
[ "$errs" = "0" ] || fail "no document refused (got $errs errors: $(grep -h ERROR "$TMP"/a-*.sql.out | head -2))"
grep -q ERROR "$TMP/dep.out" && fail "the deposits / the replay in the middle: $(grep ERROR "$TMP/dep.out" | head -2)"
r=$(q "select count(*) from public.documents where business_id = '$B' and doc_type = 320")
[ "$r" = "200" ] || fail "every document issued: 200 (got $r)"
r=$(q "select count(*) from public.gl_unposted where business_id in ('$B', '$B2')")
[ "$r" = "0" ] || fail "every source posted (unposted: $r — $(q "select string_agg(error, ' | ') from public.gl_unposted where business_id in ('$B', '$B2')"))"
r=$(q "select (select count(*) from public.documents where business_id = '$B' and doc_type = 320) + (select count(*) from public.bank_deposits where business_id = '$B')
              + (select count(*) from public.bank_deposits where business_id = '$B' and status = 'cancelled')
           || ' ' || (select count(*) from public.gl_transactions where business_id = '$B')")
set -- $r; [ "$1" = "$2" ] || fail "one entry per source (sources entries: $r)"
for b in "$B" "$B2"; do
  r=$(q "select count(*) || ' ' || count(distinct number) || ' ' || coalesce(min(number), 0) || ' ' || coalesce(max(number), 0) from public.gl_transactions where business_id = '$b'")
  set -- $r; [ "$1" = "$2" ] && [ "$3" = "1" ] && [ "$4" = "$1" ] || fail "the entry numbers 1..n, no gap, no double ($b: $r)"
done
r=$(q "select count(*) from public.gl_transactions t where t.business_id in ('$B', '$B2')
         and (select coalesce(sum(case side when 'D' then amount else -amount end), 0) from public.gl_lines l where l.transaction_id = t.id) <> 0")
[ "$r" = "0" ] || fail "every entry balanced (unbalanced: $r)"
for L in "$B" "$L2"; do
  r=$(q "select (select coalesce(sum(case l.side when 'D' then l.amount else -l.amount end), 0) from public.gl_lines l join public.gl_accounts a on a.id = l.account_id
                  where a.business_id = '$B' and a.role = 'cash:$L')
          = (select coalesce(sum(amount) filter (where direction = 'in'), 0) - coalesce(sum(amount) filter (where direction = 'out'), 0)
               from public.payments where business_id = '$B' and method = 'cash' and coalesce(location_id, business_id) = '$L')
            - (select coalesce(sum(cash), 0) from public.bank_deposits where business_id = '$B' and location_id = '$L' and status = 'active')")
  [ "$r" = "t" ] || fail "the cash of location $L in the books = received − deposited"
done
r=$(q "select count(*) from public.gl_lines l join public.gl_accounts a on a.id = l.account_id where a.business_id = '$B' and a.role = 'card_clearing'")
c=$(q "select count(*) * 3 from public.documents where business_id = '$B' and payments->0->>'m' = 'card'")
[ "$r" = "$c" ] || fail "a card in 3 installments — 3 lines each ($r vs $c)"
echo "ok: 8 connections × 25 receipts in two locations (+ a second business, 2 × 25), deposits, a cancellation and replays in the middle → none refused, every source posted once, entries 1..n per business with no gap, all balanced, the cash in the books = received − deposited, 3 lines per installment card"
