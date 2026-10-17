#!/usr/bin/env bash
# Runs every migration on a fresh local Postgres database, then the SQL checks in tests/sql/*.check.sql.
# Needs a local Postgres 16 (pg_ctlcluster 16 main start). Usage: bash tests/sql/run.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
DB=${DP_TEST_DB:-dp_test}
export PGOPTIONS="-c client_min_messages=warning"
PSQL=(psql -X -q -v ON_ERROR_STOP=1)
as_pg() { if [ "$(id -un)" = postgres ]; then "$@"; else su postgres -c "$(printf '%q ' "$@")"; fi; }
as_pg dropdb --if-exists "$DB" >/dev/null
as_pg createdb "$DB"
as_pg "${PSQL[@]}" -d "$DB" -f tests/sql/supabase-shim.sql
for f in supabase/migrations/*.sql; do
  as_pg env PGOPTIONS="$PGOPTIONS" "${PSQL[@]}" -d "$DB" -f "$f" >/dev/null || { echo "FAILED: $f"; exit 1; }
done
echo "migrations: $(ls supabase/migrations/*.sql | wc -l) applied"
# every check file runs (one failure does not hide the next); the run fails if any of them failed
failed=0
for f in tests/sql/*.check.sql; do
  if as_pg env PGOPTIONS="$PGOPTIONS" "${PSQL[@]}" -o /dev/null -d "$DB" -f "$f"; then echo "ok: $f"; else echo "FAILED: $f"; failed=1; fi
done
# numbering, idempotency and credit limits with several connections at once
bash tests/sql/concurrency.sh "$DB" || failed=1
# a business with one location: the same rows and the same view before and after migration 4600 (locations)
bash tests/sql/locations-compare.sh "$DB" || failed=1
# a business with one location: the same day of the business without and with migration 4700 (stock by location)
bash tests/sql/stock-compare.sh "$DB" 4700 || failed=1
# … and without and with migration 4800 (serial numbers, price lists, SKU series — every stock mover again)
bash tests/sql/stock-compare.sh "$DB" 4800 || failed=1
# … and without and with migration 4900 (the reports, tax withheld at source — the receipts' ledger rows and the money summary)
bash tests/sql/stock-compare.sh "$DB" 4900 || failed=1
# … and without and with migration 5000 (the desks, deposits and the bank; order, delivery note and return note — the documents'
# checks, stock and cancellations rewritten: a business that turns nothing on keeps the same day)
bash tests/sql/stock-compare.sh "$DB" 5000 || failed=1
# … and without and with migration 5100 (manual journal entries — the money summary and the reports rewritten: no entry, the same answers)
bash tests/sql/stock-compare.sh "$DB" 5100 || failed=1
# … and without and with migration 5400 (a product sold by a quote — the site's line price, card, product and list rewritten:
# a store that sells as before, the same prices, product and lists)
bash tests/sql/stock-compare.sh "$DB" 5400 || failed=1
exit $failed
