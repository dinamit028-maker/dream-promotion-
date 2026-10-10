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
exit $failed
