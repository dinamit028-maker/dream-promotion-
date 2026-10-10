#!/usr/bin/env bash
# A business with one location, before and after migration 20261010004600 (locations, docs/FINANCE_ADDITIONS_HE.md T12א):
# the database as it is up to 4500, with a business's real kinds of rows (sales, a refund, documents and their payments, an
# expense, appointments, days of the register, a store's order) — then 4600 — and nothing that was there changes, and every
# member (the owner, a cashier) sees exactly what they saw: the same rows, the same sums, the same summary.
# Called by tests/sql/run.sh. Usage: bash tests/sql/locations-compare.sh [db]
set -euo pipefail
cd "$(dirname "$0")/../.."
DB=${1:-${DP_TEST_DB:-dp_test}}_cmp
export PGOPTIONS="-c client_min_messages=warning"
PSQL=(psql -X -q -v ON_ERROR_STOP=1)
as_pg() { if [ "$(id -un)" = postgres ]; then "$@"; else su postgres -c "$(printf '%q ' "$@")"; fi; }
q() { as_pg "${PSQL[@]}" -t -A -d "$DB" -c "$1"; }
fail() { echo "CHECK FAILED: $1"; exit 1; }
LOC=supabase/migrations/20261010004600_locations.sql

as_pg dropdb --if-exists "$DB" >/dev/null
as_pg createdb "$DB"
as_pg "${PSQL[@]}" -d "$DB" -f tests/sql/supabase-shim.sql
for f in supabase/migrations/*.sql; do
  [[ "$f" < "$LOC" ]] || continue
  as_pg env PGOPTIONS="$PGOPTIONS" "${PSQL[@]}" -d "$DB" -f "$f" >/dev/null || fail "migration $f"
done

O=00000000-0000-0000-0000-000000e47a01; K=00000000-0000-0000-0000-000000e47a02; B=00000000-0000-0000-0000-000000e47b01
AS="set local role authenticated; select set_config('request.jwt.claim.sub', '$O', true);"
q "insert into auth.users (id, email) values ('$O', 'owner@cmp.test'), ('$K', 'cashier@cmp.test');
   insert into public.businesses (id, name, slug) values ('$B', 'Compare', 'cmp-test');
   insert into public.business_members (business_id, user_id, role, access) values ('$B', '$O', 'owner', 'full'), ('$B', '$K', 'editor', 'register');
   update public.profiles set current_business_id = '$B' where id in ('$O', '$K');
   insert into public.register_settings (user_id, business_id, business_type, vat_rate, dealer_number, legal_name, street, city, entity_type)
   values ('$O', '$B', 'licensed', 18, '514000004', 'השוואה בע\"מ', 'הרצל', 'תל אביב', 'company');" >/dev/null

DOC="insert into public.documents (id, user_id, doc_type, doc_number, doc_date, customer_name, before_discount, discount, after_discount, vat_amount, total,
       vat_rate, lines, payments, idempotency_key%s) values ('%s', '$O', %s, 0, public.il_today(), 'לקוחה', %s, 0, %s, %s, %s, %s, %s, %s, '%s'%s);"
LINE="'[{\"name\": \"שירות\", \"qty\": 1, \"unitPriceExVat\": 100, \"discountExVat\": 0, \"totalExVat\": 100, \"vatRate\": 18, \"kind\": 1}]'::jsonb"
q "begin; $AS
   insert into public.sales (id, user_id, items, subtotal, total, vat_rate, vat_amount, method, status, paid_at) values
     ('00000000-0000-0000-0000-000000e47c01', '$O', '[{\"name\": \"שירות\", \"price\": 118, \"qty\": 1}]', 118, 118, 18, 18, 'cash', 'paid', now()),
     ('00000000-0000-0000-0000-000000e47c02', '$O', '[{\"name\": \"שירות\", \"price\": 236, \"qty\": 2}]', 236, 236, 18, 36, 'link', 'pending', null),
     ('00000000-0000-0000-0000-000000e47c03', '$O', '[{\"name\": \"מוצר\", \"price\": 59, \"qty\": 1}]', 59, 59, 18, 9, 'card', 'paid', now());
   update public.sales set status = 'cancelled' where id = '00000000-0000-0000-0000-000000e47c03';
   $(printf "$DOC" ', sale_id' 00000000-0000-0000-0000-000000e47d01 320 100 100 18 118 18 "$LINE" \
       "jsonb_build_array(jsonb_build_object('method', 1, 'amount', 118, 'date', public.il_today()))" 'sale:00000000-0000-0000-0000-000000e47c01' ", '00000000-0000-0000-0000-000000e47c01'")
   $(printf "$DOC" ', due_date' 00000000-0000-0000-0000-000000e47d02 305 100 100 18 118 18 "$LINE" "'[]'::jsonb" 'direct:cmp-305' ", public.il_today() + 30")
   $(printf "$DOC" ', paid_document_id' 00000000-0000-0000-0000-000000e47d03 400 118 118 0 118 0 "'[]'::jsonb" \
       "jsonb_build_array(jsonb_build_object('method', 1, 'amount', 118, 'date', public.il_today()))" 'receipt:cmp:1' ", '00000000-0000-0000-0000-000000e47d02'")
   insert into public.sale_refunds (id, user_id, sale_id, amount, vat_amount, method, reason)
   values ('00000000-0000-0000-0000-000000e47c11', '$O', '00000000-0000-0000-0000-000000e47c01', 18, 0, 'cash', 'החזר חלקי');
   insert into public.expenses (id, user_id, supplier_name, doc_date, amount_before_vat, vat_amount, total, paid_on, payment_method)
   values ('00000000-0000-0000-0000-000000e47c21', '$O', 'ספק', public.il_today(), 100, 18, 118, public.il_today(), 'transfer');
   insert into public.appointments (id, user_id, name, start_at, end_at) values
     ('00000000-0000-0000-0000-000000e47c31', '$O', 'תור א', date_trunc('hour', now()) + interval '1 day', date_trunc('hour', now()) + interval '1 day 1 hour'),
     ('00000000-0000-0000-0000-000000e47c32', '$O', 'תור ב', date_trunc('hour', now()) + interval '1 day 2 hours', date_trunc('hour', now()) + interval '1 day 3 hours');
   insert into public.register_shifts (id, user_id, opening_cash, opened_at, closed_at, counted_cash, expected_cash, difference)
   values ('00000000-0000-0000-0000-000000e47c41', '$O', 100, now() - interval '1 day', now() - interval '20 hours', 218, 218, 0);
   insert into public.register_shifts (id, user_id, opening_cash) values ('00000000-0000-0000-0000-000000e47c42', '$O', 150);
   commit;" >/dev/null
# the cashier's own sale today (a cashier sees only theirs)
q "begin; set local role authenticated; select set_config('request.jwt.claim.sub', '$K', true);
   insert into public.sales (id, user_id, items, subtotal, total, vat_rate, vat_amount, method, status, paid_at)
   values ('00000000-0000-0000-0000-000000e47c04', '$K', '[{\"name\": \"שירות\", \"price\": 50, \"qty\": 1}]', 50, 50, 18, 8, 'cash', 'paid', now());
   commit;" >/dev/null
q "insert into public.stores (id, user_id, business_id, name, slug) values ('00000000-0000-0000-0000-000000e47c51', '$O', '$B', 'החנות', 'cmp-store');
   insert into public.orders (id, business_id, store_id, number, token_hash, subtotal, total, customer_name, customer_phone, customer_email, delivery_method,
                              terms_accepted_at, provider, expires_at)
   values ('00000000-0000-0000-0000-000000e47c52', '$B', '00000000-0000-0000-0000-000000e47c51', 1, repeat('b', 64), 59, 59, 'קונה', '0501234567',
           'buyer@cmp.test', 'pickup', now(), 'mock', now() + interval '15 minutes');" >/dev/null

# every row of the tables 4600 touches, without the columns it adds
TABLES="sales register_shifts sale_refunds documents document_drafts payments expenses appointments orders stores"
rows() {
  local out=""
  for t in $TABLES; do
    out+="$t $(q "select count(*) || ' ' || md5(coalesce(string_agg((to_jsonb(x) - 'location_id' - 'register_id')::text, '|' order by x.id::text), ''))
                  from public.$t x where x.business_id = '$B'")"$'\n'
  done
  out+="members $(q "select md5(string_agg((to_jsonb(m) - 'locations')::text, '|' order by m.user_id::text)) from public.business_members m where m.business_id = '$B'")"$'\n'
  out+="profiles $(q "select md5(string_agg((to_jsonb(p) - 'current_location_id')::text, '|' order by p.id::text)) from public.profiles p where p.id in ('$O', '$K')")"
  echo "$out"
}
# what a member sees: rows and sums of every list, the money summary, what is owed
seen() { # $1 = the member
  q "begin; set local role authenticated; select set_config('request.jwt.claim.sub', '$1', true);
     select 'sales ' || count(*) || ' ' || coalesce(sum(total), 0) from public.sales;
     select 'documents ' || count(*) || ' ' || coalesce(sum(total), 0) || ' ' || coalesce(string_agg(doc_type || '/' || doc_number, ',' order by doc_type, doc_number), '') from public.documents;
     select 'payments ' || count(*) || ' ' || coalesce(sum(amount), 0) from public.payments;
     select 'refunds ' || count(*) || ' ' || coalesce(sum(amount), 0) from public.sale_refunds;
     select 'expenses ' || count(*) || ' ' || coalesce(sum(total), 0) from public.expenses;
     select 'appointments ' || count(*) || ' ' || coalesce(string_agg(name, ',' order by start_at), '') from public.appointments;
     select 'shifts ' || count(*) || ' ' || count(*) filter (where closed_at is null) from public.register_shifts;
     select 'orders ' || count(*) from public.orders;
     select 'receivables ' || count(*) || ' ' || coalesce(sum(balance), 0) from public.receivables;
     select 'summary ' || coalesce(public.finance_summary(public.il_today() - 30, public.il_today())::text, '') where public.my_access() = 'full';
     commit;" | grep -v '^$' | grep -v 'set_config\|^[0-9a-f-]*$'
}
before_rows=$(rows); before_owner=$(seen "$O"); before_cashier=$(seen "$K")
if [ -n "${CMP_SHOW:-}" ]; then echo "$before_rows"; echo "--- owner"; echo "$before_owner"; echo "--- cashier"; echo "$before_cashier"; fi
[ -n "$(echo "$before_owner" | grep '^summary ')" ] || fail "the owner's summary before 4600"

as_pg env PGOPTIONS="$PGOPTIONS" "${PSQL[@]}" -d "$DB" -f "$LOC" >/dev/null || fail "migration $LOC"
for f in supabase/migrations/*.sql; do
  [[ "$f" > "$LOC" ]] || continue
  as_pg env PGOPTIONS="$PGOPTIONS" "${PSQL[@]}" -d "$DB" -f "$f" >/dev/null || fail "migration $f"
done

after_rows=$(rows); after_owner=$(seen "$O"); after_cashier=$(seen "$K")
[ "$before_rows" = "$after_rows" ] || { diff <(echo "$before_rows") <(echo "$after_rows"); fail "4600 changed rows that were there"; }
[ "$before_owner" = "$after_owner" ] || { diff <(echo "$before_owner") <(echo "$after_owner"); fail "the owner sees something else after 4600"; }
[ "$before_cashier" = "$after_cashier" ] || { diff <(echo "$before_cashier") <(echo "$after_cashier"); fail "the cashier sees something else after 4600"; }
r=$(q "select count(*) filter (where location_id is not null) from public.sales where business_id = '$B'")
[ "$r" = "0" ] || fail "4600 wrote a location into old rows (got $r)"
echo "ok: one location, before and after 4600 → $(echo "$before_rows" | wc -l) tables' rows unchanged; the owner and the cashier see the same rows, sums and summary"
as_pg dropdb "$DB" >/dev/null
