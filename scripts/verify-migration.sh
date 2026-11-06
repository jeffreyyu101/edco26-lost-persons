#!/usr/bin/env bash
# Proves supabase/migrations/20261106000000_rework.sql is safe to paste into production once or twice.
# LOCAL ONLY (same host guard as db-reset.sh). It does not touch the app database's data:
#
#   1. Re-applies the rework migration twice to the local app database (already migrated by
#      `supabase db reset`), as the production SQL editor would.
#   2. Builds a scratch database `lp_upgrade_fixture` from Jeffrey's ORIGINAL schema (commit 8d21e4f:
#      no last_seen column, the old location/status CHECKs incl. 'Found – Transported'), adds a legacy
#      nullable column and legacy rows, applies the rework migration twice, smoke-tests the functions,
#      then drops the scratch database.
#
#   bash scripts/verify-migration.sh
set -euo pipefail

cd "$(dirname "$0")/.."
die() { echo "verify-migration: $*" >&2; exit 1; }

status_env="$(supabase status -o env 2>/dev/null)" || die "the local stack is not running. Start it with: supabase start"
db_url="$(printf '%s\n' "$status_env" | grep -E '^DB_URL=' | cut -d= -f2- | tr -d '"')"
host="$(node -e 'try{process.stdout.write(new URL(process.argv[1]).hostname)}catch{process.stdout.write("invalid")}' "$db_url")"
case "$host" in 127.0.0.1|localhost) ;; *) die "refusing to run: DB host is '$host'." ;; esac

migration=supabase/migrations/20261106000000_rework.sql
fixture_url="${db_url%/*}/lp_upgrade_fixture"

apply() { # apply <url> <label>
  local out
  if ! out="$(psql "$1" -v ON_ERROR_STOP=1 -q -f "$migration" 2>&1)"; then
    printf '%s\n' "$out" | grep -v 'skipping$' >&2
    die "$2: FAILED"
  fi
  printf '%s\n' "$out" | grep -E 'NOTICE: +patients_' | sed -E 's/^.*NOTICE: +/    /' || true
  echo "  $2: ok"
}

echo "1. App database ($db_url)"
apply "$db_url" "re-apply #1"
apply "$db_url" "re-apply #2"

echo "2. Upgrade fixture (Jeffrey's original schema, commit 8d21e4f)"
psql "$db_url" -q -c "drop database if exists lp_upgrade_fixture" -c "create database lp_upgrade_fixture" >/dev/null
trap 'psql "$db_url" -q -c "drop database if exists lp_upgrade_fixture" >/dev/null 2>&1 || true' EXIT

git show 8d21e4f:supabase/schema.sql | psql "$fixture_url" -v ON_ERROR_STOP=1 -q >/dev/null 2>&1 \
  || die "could not build the fixture schema"
psql "$fixture_url" -v ON_ERROR_STOP=1 -q >/dev/null <<'SQL'
alter table public.patients add column checked_in_at timestamptz; -- legacy nullable column from the removed check-in feature
insert into public.patients (client_mutation_id, first_name, last_name, reporting_location, other_location, status, created_by, updated_by)
values ('00000000-0000-4000-8000-0000000000a1', 'X.Y.', '', 'FA 3 – Kinetic', null, 'Found – Transported', 'Old · Prevent', 'Old · Prevent'),
       ('00000000-0000-4000-8000-0000000000a2', 'A.B.', '', 'Other', 'Gate', 'Added', 'Old · GC/HX - Dispatch', 'Old · GC/HX - Dispatch');
insert into public.patient_photos (patient_id, storage_path, photo_timing, uploaded_by)
select id, id || '/legacy.jpg', 'unsure', 'Old · Prevent' from public.patients where first_name = 'X.Y.';
insert into public.audit_events (patient_id, staff_name, action_type, new_value)
select id, 'Old · Prevent', 'medical_search', '{"outcome":"not_found"}' from public.patients where first_name = 'X.Y.';
SQL
apply "$fixture_url" "apply #1"
apply "$fixture_url" "apply #2"

result="$(psql "$fixture_url" -v ON_ERROR_STOP=1 -q -At <<'SQL'
set role service_role;
select string_agg(x, ' ') from (
  select 'last_seen=' || exists(select 1 from information_schema.columns where table_name = 'patients' and column_name = 'last_seen')::text as x
  union all select 'rows=' || jsonb_array_length(lp_sync(null) -> 'rows')
  union all select 'answer=' || ((lp_set_status((select id from patients where first_name = 'A.B.'),
                     (select row_version from patients where first_name = 'A.B.'), 'Found – Awaiting Reunion', 'T · Medical', 'answer')) -> 'row' ->> 'status')
  union all select 'stats_total=' || (lp_stats() ->> 'total')
) s;
SQL
)"
echo "  smoke: $result"
[[ "$result" == *"last_seen=true"* && "$result" == *"rows=2"* && "$result" == *"answer=Found – Awaiting Reunion"* && "$result" == *"stats_total=2"* ]] \
  || die "fixture smoke test failed"

echo "verify-migration: all good"
