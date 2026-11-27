#!/usr/bin/env bash
# Stage 4ג (migration 7200) under real concurrency: several Postgres connections at once, each in its own transactions, as the
# signed-in owner — never one session pretending to be many.
#   1. 6 connections record 15 expenses each (paid in cash / by card / by transfer, three suppliers shared by all — their accounts
#      opened at the same moment), voiding every fifth, while 2 connections issue receipts, one records manual entries (each sent
#      twice — a retry), one adds and renames accounts, one opens and closes the register's days with a difference, and the server replays — no deadlock, nothing
#      refused, every source posted once, one account per supplier, the entry numbers 1..n with no gap, every entry balanced,
#      gl_reconcile: the books = the existing reports
#   2. two connections post the same bank line to an account at the same moment: one wins, the other is told the line is handled
# Not part of run.sh: bash tests/sql/books-more-concurrency.sh <db>   (the db after tests/sql/run.sh's migrations)
set -euo pipefail
cd "$(dirname "$0")/../.."
DB=${1:-${DP_TEST_DB:-dp_test}}
as_pg() { if [ "$(id -un)" = postgres ]; then "$@"; else su postgres -c "$(printf '%q ' "$@")"; fi; }
q() { as_pg psql -X -q -t -A -v ON_ERROR_STOP=1 -d "$DB" -c "$1"; }
TMP=$(mktemp -d); chmod 755 "$TMP"; trap 'rm -rf "$TMP"' EXIT
U=$(cat /proc/sys/kernel/random/uuid); B=$(cat /proc/sys/kernel/random/uuid); SFX=${B:0:8}
fail() { echo "CHECK FAILED: $1"; exit 1; }

q "insert into auth.users (id, email) values ('$U', 'books72-$SFX@example.test');
   insert into public.businesses (id, name, slug) values ('$B', 'Books72 $SFX', 'books72-$SFX');
   insert into public.business_members (business_id, user_id, role, access) values ('$B', '$U', 'owner', 'full');
   update public.profiles set current_business_id = '$B' where id = '$U';
   insert into public.register_settings (user_id, business_id, business_type, vat_rate, dealer_number, legal_name, entity_type)
   values ('$U', '$B', 'licensed', 18, '000000059', 'Books Ltd', 'licensed_dealer');
   insert into public.business_finance_profile (business_id, user_id, cash_drawers) values ('$B', '$U', true);" >/dev/null
AS="set local role authenticated; select set_config('request.jwt.claim.sub', '$U', true);"
q "begin; $AS select public.gl_books_start_set(date_trunc('month', public.il_today())::date); commit;" >/dev/null
# a bank file: one line two connections race for
q "begin; $AS select public.bank_import(gen_random_uuid(), '000-0000001', 'x.csv', jsonb_build_array(jsonb_build_object('date', public.il_today(), 'amount', -25, 'description', 'עמלה'))); commit;" >/dev/null
LINE=$(q "select id from public.bank_lines where business_id = '$B'")

: > "$TMP/e-all"
for w in $(seq 6); do
  f="$TMP/e-$w.sql"; : > "$f"
  for i in $(seq 15); do
    id=$(cat /proc/sys/kernel/random/uuid)
    case $(( i % 3 )) in 0) m=cash;; 1) m=card;; *) m=transfer;; esac
    case $(( (i + w) % 3 )) in 0) s="ספק אחד לדוגמה"; d="000000067";; 1) s="ספק שני לדוגמה"; d="";; *) s="ספק שלישי לדוגמה"; d="000000075";; esac
    printf "begin; %s insert into public.expenses (id, user_id, supplier_name, supplier_dealer, doc_date, category, amount_before_vat, vat_amount, total, vat_deductible_pct, paid_on, payment_method) values ('%s', '%s', '%s', '%s', public.il_today(), 'office', 100, 18, 118, 50, public.il_today(), '%s'); commit;\n" \
      "$AS" "$id" "$U" "$s" "$d" "$m" >> "$f"
    if [ $(( i % 5 )) = 0 ]; then
      printf "begin; %s update public.expenses set status = 'void', void_reason = 'בטעות' where id = '%s'; commit;\n" "$AS" "$id" >> "$f"
    fi
  done
  chmod 644 "$f"
done
for w in 1 2; do
  f="$TMP/d-$w.sql"; : > "$f"
  for i in $(seq 20); do
    printf "begin; %s insert into public.documents (user_id, doc_type, doc_number, doc_date, before_discount, discount, after_discount, vat_amount, total, vat_rate, lines, payments, idempotency_key) values ('%s', 320, 0, public.il_today(), 100, 0, 100, 18, 118, 18, '[{\"name\":\"x\",\"qty\":1,\"totalExVat\":100,\"kind\":1}]', '[{\"method\":1,\"m\":\"cash\",\"amount\":118}]', 'b72c-%s-%s-%s'); commit;\n" \
      "$AS" "$U" "$SFX" "$w" "$i" >> "$f"
  done
  chmod 644 "$f"
done
f="$TMP/m.sql"; : > "$f"
for i in $(seq 20); do
  id=$(cat /proc/sys/kernel/random/uuid)
  for r in 1 2; do
    printf "begin; %s select public.gl_manual_create('%s', public.il_today(), 'פקודה %s', '[{\"account\": \"BANK\", \"side\": \"D\", \"amount\": 10}, {\"account\": \"3200\", \"side\": \"C\", \"amount\": 10}]'); commit;\n" \
      "$AS" "$id" "$i" >> "$f"
  done
done
chmod 644 "$f"
f="$TMP/s.sql"; : > "$f"
for i in $(seq 10); do
  id=$(cat /proc/sys/kernel/random/uuid)
  printf "begin; %s insert into public.register_shifts (id, user_id, opening_cash) values ('%s', '%s', 0); commit;\n" "$AS" "$id" "$U" >> "$f"
  printf "begin; %s update public.register_shifts set closed_at = now(), counted_cash = 1, expected_cash = 0, difference = 1 where id = '%s'; commit;\n" "$AS" "$id" >> "$f"
done
chmod 644 "$f"
f="$TMP/a.sql"; : > "$f"
for i in $(seq 10); do
  printf "begin; %s select public.gl_account_add('62%02d', 'חשבון %s', 'expense'); commit;\n" "$AS" "$i" "$i" >> "$f"
  printf "begin; %s select public.gl_account_update('62%02d', 'חשבון %s — שם חדש'); commit;\n" "$AS" "$i" "$i" >> "$f"
done
chmod 644 "$f"
printf "begin; %s select public.bank_line_classify('%s', '6112', 'עמלה'); commit;\n" "$AS" "$LINE" > "$TMP/c1.sql"; cp "$TMP/c1.sql" "$TMP/c2.sql"; chmod 644 "$TMP"/c*.sql

pids=()
for f in "$TMP"/e-*.sql "$TMP"/d-*.sql "$TMP/m.sql" "$TMP/s.sql" "$TMP/a.sql"; do as_pg psql -X -q -v ON_ERROR_STOP=0 -d "$DB" -f "$f" > "$f.out" 2>&1 & pids+=($!); done
as_pg psql -X -q -v ON_ERROR_STOP=0 -d "$DB" -f "$TMP/c1.sql" > "$TMP/c1.out" 2>&1 & pids+=($!)
as_pg psql -X -q -v ON_ERROR_STOP=0 -d "$DB" -f "$TMP/c2.sql" > "$TMP/c2.out" 2>&1 & pids+=($!)
: > "$TMP/r.out"
for k in 1 2 3 4; do q "select public.gl_replay_pending(200, 50);" >> "$TMP/r.out" 2>&1 || true; sleep 0.3; done
wait "${pids[@]}"
q "select public.gl_replay_pending(1000, 1000);" >> "$TMP/r.out" 2>&1 || true

grep -qi deadlock "$TMP"/*.out && fail "a deadlock: $(grep -hi deadlock "$TMP"/*.out | head -2)"
errs=$(cat "$TMP"/e-*.out "$TMP"/d-*.out "$TMP/m.sql.out" "$TMP/s.sql.out" "$TMP/a.sql.out" "$TMP/r.out" | grep -c ERROR || true)
[ "$errs" = "0" ] || fail "nothing refused (got $errs: $(grep -h ERROR "$TMP"/*.out | head -3))"
c=$(cat "$TMP/c1.out" "$TMP/c2.out" | grep -c 'bank_line_closed' || true)
o=$(cat "$TMP/c1.out" "$TMP/c2.out" | grep ERROR | grep -vc 'bank_line_closed' || true)
[ "$c" = "1" ] && [ "$o" = "0" ] || fail "the same bank line at once: one posts, the other is told it is handled ($c / $o)"
r=$(q "select count(*) from public.gl_bank_line_accounts where business_id = '$B'")
[ "$r" = "1" ] || fail "the bank line posted once (got $r)"
r=$(q "select count(*) from public.gl_unposted where business_id = '$B'")
[ "$r" = "0" ] || fail "every source posted (unposted: $r — $(q "select string_agg(source_kind || ' ' || coalesce(error, ''), ' | ') from public.gl_unposted where business_id = '$B'"))"
r=$(q "select count(*) || ' ' || count(distinct number) || ' ' || coalesce(min(number), 0) || ' ' || coalesce(max(number), 0) from public.gl_transactions where business_id = '$B'")
set -- $r; [ "$1" = "$2" ] && [ "$3" = "1" ] && [ "$4" = "$1" ] || fail "the entry numbers 1..n, no gap, no double ($r)"
r=$(q "select count(*) from public.gl_transactions t where t.business_id = '$B'
         and (select coalesce(sum(case side when 'D' then amount else -amount end), 0) from public.gl_lines l where l.transaction_id = t.id) <> 0")
[ "$r" = "0" ] || fail "every entry balanced (unbalanced: $r)"
r=$(q "select count(*) from public.gl_accounts where business_id = '$B' and parent_key = '2100'")
[ "$r" = "3" ] || fail "one account per supplier (got $r)"
r=$(q "select count(*) from public.gl_accounts where business_id = '$B' and key like '62__' and name like '%שם חדש'")
[ "$r" = "10" ] || fail "the owner's chart changes in the middle (got $r)"
r=$(q "select count(*) from public.gl_transactions where business_id = '$B' and source_kind = 'manual'")
[ "$r" = "20" ] || fail "each manual entry once, the retry the same (got $r)"
# expenses: 90 posted, 18 of them voided (reversed); their payments 90 + 18 reversals; the days 10
r=$(q "select (select count(*) from public.gl_transactions where business_id = '$B' and source_kind = 'expense' and reverses is null)
         || ' ' || (select count(*) from public.gl_transactions where business_id = '$B' and source_kind = 'expense' and reverses is not null)
         || ' ' || (select count(*) from public.gl_transactions where business_id = '$B' and source_kind = 'expense_payment')
         || ' ' || (select count(*) from public.gl_transactions where business_id = '$B' and source_kind = 'shift')")
[ "$r" = "90 18 108 10" ] || fail "expenses 90 posted, 18 reversed; 108 payments; 10 days (got $r)"
r=$(q "select coalesce(sum(case l.side when 'D' then l.amount else -l.amount end), 0) from public.gl_lines l join public.gl_accounts a on a.id = l.account_id
        where a.business_id = '$B' and a.parent_key = '2100'")
[ "$r" = "0.00" ] || fail "every supplier paid: the suppliers at 0 (got $r)"
r=$(q "begin; $AS select (public.gl_reconcile(date_trunc('month', public.il_today())::date, public.il_today())->>'same'); commit;" | tail -1)
[ "$r" = "true" ] || fail "gl_reconcile: the books = the existing reports ($(q "begin; $AS select public.gl_reconcile(date_trunc('month', public.il_today())::date, public.il_today())->'rows'; commit;"))"
echo "ok: 6 connections × 15 expenses (three shared suppliers, every fifth voided), 2 × 20 receipts, 20 manual entries sent twice, 10 accounts added and renamed, 10 register days and the server's replay at once → no deadlock, nothing refused, every source posted once, one account per supplier, entries 1..n with no gap, all balanced, gl_reconcile the same; one bank line posted by two connections at once → once"
