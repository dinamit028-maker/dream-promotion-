#!/usr/bin/env bash
# The clock before and after migration 20261023005800 (attendance, stage 1): the database up to 5700 with a business's employees,
# shifts (closed, open, edited by the old screen) and QR settings — then 5800 — and no existing row changes (only the new columns,
# empty), the clock (the server) still clocks in and out, and the owner still reads the same employees and shifts.
# Called by tests/sql/run.sh. Usage: bash tests/sql/attendance-compare.sh [db]
set -euo pipefail
cd "$(dirname "$0")/../.."
DB=${1:-${DP_TEST_DB:-dp_test}}_att
export PGOPTIONS="-c client_min_messages=warning"
PSQL=(psql -X -q -v ON_ERROR_STOP=1)
as_pg() { if [ "$(id -un)" = postgres ]; then "$@"; else su postgres -c "$(printf '%q ' "$@")"; fi; }
q() { as_pg "${PSQL[@]}" -t -A -d "$DB" -c "$1"; }
fail() { echo "CHECK FAILED: $1"; exit 1; }
ATT=supabase/migrations/20261023005800_attendance_core.sql

as_pg dropdb --if-exists "$DB" >/dev/null
as_pg createdb "$DB"
as_pg "${PSQL[@]}" -d "$DB" -f tests/sql/supabase-shim.sql
for f in supabase/migrations/*.sql; do
  [[ "$f" < "$ATT" ]] || continue
  as_pg env PGOPTIONS="$PGOPTIONS" "${PSQL[@]}" -d "$DB" -f "$f" >/dev/null || fail "migration $f"
done

O=00000000-0000-0000-0000-000000e58a01; B=00000000-0000-0000-0000-000000e58b01; E=00000000-0000-0000-0000-000000e58e01; F=00000000-0000-0000-0000-000000e58e02
q "insert into auth.users (id, email) values ('$O', 'owner@att-cmp.test');
   insert into public.businesses (id, name, slug) values ('$B', 'Att', 'att-cmp');
   insert into public.business_members (business_id, user_id, role, access) values ('$B', '$O', 'owner', 'full');
   update public.profiles set current_business_id = '$B' where id = '$O';
   insert into public.employees (id, user_id, business_id, name, phone, hourly_rate, token) values
     ('$E', '$O', '$B', 'דנה', '0501', 45.5, 'tokcmpAAAAAAAAAAAAAAAAAAAAAAAAAA'), ('$F', '$O', '$B', 'אבי', '', null, 'tokcmpBBBBBBBBBBBBBBBBBBBBBBBBBB');
   insert into public.time_entries (user_id, business_id, employee_id, clock_in, clock_out, source, edited, note) values
     ('$O', '$B', '$E', '2026-09-01 05:00:00+00', '2026-09-01 13:00:00+00', 'qr', false, ''),
     ('$O', '$B', '$E', '2026-09-02 19:00:00+00', '2026-09-03 03:00:00+00', 'self', true, 'תוקן'),
     ('$O', '$B', '$F', '2026-09-03 05:00:00+00', null, 'manual', false, '');
   insert into public.timeclock_settings (user_id, business_id, site_code, require_qr) values ('$O', '$B', 'SITEcmpABCDEFGHJKMN12', true);" >/dev/null

rows() {
  echo "employees $(q "select count(*) || ' ' || md5(string_agg((to_jsonb(e) - 'employee_code' - 'department_id' - 'title' - 'track_id' - 'start_date' - 'end_date'
                  - 'last_active_at' - 'invited_at')::text, '|' order by e.id)) from public.employees e")"
  echo "entries $(q "select count(*) || ' ' || md5(string_agg((to_jsonb(t) - 'method' - 'out_method' - 'replaces' - 'voided_at' - 'voided_by' - 'void_reason'
                  - 'created_by')::text, '|' order by t.id)) from public.time_entries t")"
  echo "settings $(q "select md5(string_agg((to_jsonb(s) - 'exports_pdf_only' - 'employer_deductions_file' - 'employer_phone')::text, '|')) from public.timeclock_settings s")"
}
seen() {
  q "begin; set local role authenticated; select set_config('request.jwt.claim.sub', '$O', true);
     select 'emps ' || count(*) || ' ' || string_agg(name || ':' || coalesce(hourly_rate::text, '-'), ',' order by name) from public.employees;
     select 'shifts ' || count(*) || ' ' || count(*) filter (where clock_out is null) from public.time_entries;
     commit;" | grep -v '^$' | grep -v 'set_config\|^[0-9a-f-]*$'
}
before_rows=$(rows); before_seen=$(seen)
as_pg env PGOPTIONS="$PGOPTIONS" "${PSQL[@]}" -d "$DB" -f "$ATT" >/dev/null || fail "migration $ATT"
for f in supabase/migrations/*.sql; do
  [[ "$f" > "$ATT" ]] || continue
  as_pg env PGOPTIONS="$PGOPTIONS" "${PSQL[@]}" -d "$DB" -f "$f" >/dev/null || fail "migration $f"
done
after_rows=$(rows); after_seen=$(seen)
diff <(echo "$before_rows") <(echo "$after_rows") || fail "a row changed with 5800"
diff <(echo "$before_seen") <(echo "$after_seen") || fail "the owner sees something else after 5800"
[ "$(q "select count(*) from public.time_entries where method is not null or voided_at is not null")" = 0 ] || fail "the new columns of old rows are empty"
[ "$(q "select count(*) from public.time_entry_events")" = 0 ] || fail "no history is made up for old rows"
# the clock as before: Avi's open shift is closed, Dana clocks in, a second clock-in is 23505
q "begin; set local role service_role; select set_config('request.jwt.claim.role', 'service_role', true);
   update public.time_entries set clock_out = now() where employee_id = '$F' and clock_out is null;
   insert into public.time_entries (user_id, business_id, employee_id, clock_in, source) values ('$O', '$B', '$E', now(), 'qr');
   commit;" >/dev/null || fail "the clock in / out after 5800"
out=$(q "begin; set local role service_role;
   insert into public.time_entries (user_id, business_id, employee_id, clock_in, source) values ('$O', '$B', '$E', now(), 'qr'); commit;" 2>&1 || true)
echo "$out" | grep -q 'time_entries_one_open' || fail "a second clock-in is the same error as before: $out"
[ "$(q "select string_agg(kind || ':' || channel, ',' order by at) from public.time_entry_events")" = "clock_out:clock,created:clock" ] || fail "the clock's history"
echo "ok: the clock without and with 5800 → no existing row changed, the owner sees the same, the clock clocks in and out as before"
