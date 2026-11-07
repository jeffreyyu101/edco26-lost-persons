#!/usr/bin/env bash
# Proves supabase/migrations/20261106000000_rework.sql is safe to paste into production once or twice.
# LOCAL ONLY (same host guard as db-reset.sh). It does not touch the app database's data:
#
#   1. Re-applies the rework migration twice to the local app database (already migrated by
#      `supabase db reset`), as the production SQL editor would.
#   2. Builds a scratch database `lp_upgrade_fixture` from Jeffrey's ORIGINAL schema (commit 8d21e4f:
#      no last_seen column, the old location/status CHECKs incl. 'Found – Transported'), widens the
#      location CHECK to an even older value ('FA 3'), adds a legacy nullable column and legacy rows,
#      applies the rework migration twice, then smoke-tests the functions: legacy rows (old post, old
#      status) stay answerable / editable / photo-able, new non-canonical values are still refused,
#      lp_stats byPost adds up to the open count, a repeat of a legacy status is {changed: false} (A36),
#      and an other_location-only edit audits both halves of the post (A35). Then drops the scratch database.
#
#   bash scripts/verify-migration.sh
#
# The database is SUPABASE_DB_URL when it is set (as the integration harness's dbUrl() reads it, so a test
# run against an isolated stack checks that stack), else the default stack's from `supabase status`.
set -euo pipefail

cd "$(dirname "$0")/.."
die() { echo "verify-migration: $*" >&2; exit 1; }

if [[ -n "${SUPABASE_DB_URL:-}" ]]; then
  db_url="$SUPABASE_DB_URL"
else
  status_env="$(supabase status -o env 2>/dev/null)" || die "the local stack is not running. Start it with: supabase start"
  db_url="$(printf '%s\n' "$status_env" | grep -E '^DB_URL=' | cut -d= -f2- | tr -d '"')"
fi
[[ -n "$db_url" ]] || die "no database URL (set SUPABASE_DB_URL, or start the local stack: supabase start)"
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
# lp_stats: the byPost bars always add up to the Open hero number.
by_post="$(psql "$db_url" -v ON_ERROR_STOP=1 -q -At <<'SQL'
begin;
set local role service_role;
select (s -> 'open' ->> 'waiting')::int + (s -> 'open' ->> 'inMedical')::int = coalesce(
         (select sum((b ->> 'count')::int) from jsonb_array_elements(s -> 'byPost') b), 0)
from (select lp_stats() as s) x;
rollback;
SQL
)"
[[ "$by_post" == "t" ]] || die "app database: lp_stats byPost does not add up to open"
echo "  lp_stats byPost adds up to open: ok"
# A36: repeating the legacy 'Bring friend to medical' on a row already in it is {changed: false} (rolled back).
legacy_repeat="$(psql "$db_url" -v ON_ERROR_STOP=1 -q -At <<'SQL'
begin;
set local role service_role;
select lp_set_status(id, row_version, 'Bring friend to medical', 'T · Medical', 'answer') ->> 'changed'
  from patients where status = 'Bring friend to medical' order by case_number limit 1;
rollback;
SQL
)"
case "$legacy_repeat" in
  false) echo "  legacy Bring friend repeat is changed=false: ok" ;;
  "") echo "  legacy Bring friend repeat: skipped (no such row in the app database)" ;;
  *) die "app database: repeating 'Bring friend to medical' returned '$legacy_repeat', expected false" ;;
esac

echo "2. Upgrade fixture (Jeffrey's original schema, commit 8d21e4f)"
psql "$db_url" -q -c "drop database if exists lp_upgrade_fixture" -c "create database lp_upgrade_fixture" >/dev/null
trap 'psql "$db_url" -q -c "drop database if exists lp_upgrade_fixture" >/dev/null 2>&1 || true' EXIT

git show 8d21e4f:supabase/schema.sql | psql "$fixture_url" -v ON_ERROR_STOP=1 -q >/dev/null 2>&1 \
  || die "could not build the fixture schema"
psql "$fixture_url" -v ON_ERROR_STOP=1 -q >/dev/null <<'SQL'
alter table public.patients add column checked_in_at timestamptz; -- legacy nullable column from the removed check-in feature
-- An even older post value ('FA 3') that today's CHECK no longer lists: rows holding it must stay editable.
alter table public.patients drop constraint patients_reporting_location_check;
alter table public.patients add constraint patients_reporting_location_check
  check (reporting_location in ('FA 3', 'FA 3 – Kinetic', 'FA 4 – Oasis', 'Other'));
insert into public.patients (client_mutation_id, first_name, last_name, reporting_location, other_location, status, created_by, updated_by)
values ('00000000-0000-4000-8000-0000000000a1', 'X.Y.', '', 'FA 3 – Kinetic', null, 'Found – Transported', 'Old · Prevent', 'Old · Prevent'),
       ('00000000-0000-4000-8000-0000000000a2', 'A.B.', '', 'Other', 'Gate', 'Added', 'Old · GC/HX - Dispatch', 'Old · GC/HX - Dispatch'),
       ('00000000-0000-4000-8000-0000000000a3', 'L.F.', '', 'FA 3', null, 'Added', 'Old · Medical', 'Old · Medical');
insert into public.patient_photos (patient_id, storage_path, photo_timing, uploaded_by)
select id, id || '/legacy.jpg', 'unsure', 'Old · Prevent' from public.patients where first_name = 'X.Y.';
insert into public.audit_events (patient_id, staff_name, action_type, new_value)
select id, 'Old · Prevent', 'medical_search', '{"outcome":"not_found"}' from public.patients where first_name = 'X.Y.';
SQL
apply "$fixture_url" "apply #1"
apply "$fixture_url" "apply #2"

# One check per line, run in order (each as service_role, like the app server).
result="$(psql "$fixture_url" -v ON_ERROR_STOP=1 -q -At <<'SQL' | tr '\n' ' '
set role service_role;
create temp table ids as
  select first_name as k, id from patients where first_name in ('X.Y.', 'A.B.', 'L.F.');
create function pg_temp.v(p_k text) returns bigint language sql as
  $$ select p.row_version from patients p join ids on ids.id = p.id where ids.k = p_k $$;
create function pg_temp.id(p_k text) returns uuid language sql as $$ select id from ids where k = p_k $$;
-- Refused with SQLSTATE P0422 / 23514 → 'refused', anything else → the error text.
create function pg_temp.refused(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ACCEPTED';
exception when sqlstate 'P0422' or check_violation then
  return 'refused';
end $$;

select 'last_seen=' || exists(select 1 from information_schema.columns where table_name = 'patients' and column_name = 'last_seen')::text;
select 'rows=' || jsonb_array_length(lp_sync(null) -> 'rows');
select 'answer=' || (lp_set_status(pg_temp.id('A.B.'), pg_temp.v('A.B.'), 'Found – Awaiting Reunion', 'T · Medical', 'answer') -> 'row' ->> 'status');
-- A legacy post ('FA 3') can still be answered and edited, and get a photo.
select 'legacy_post_answer=' || (lp_set_status(pg_temp.id('L.F.'), pg_temp.v('L.F.'), 'Found – Awaiting Reunion', 'T · Medical', 'answer') -> 'row' ->> 'status');
select 'legacy_post_edit=' || (lp_update_fields(pg_temp.id('L.F.'), '{"hair":"Red"}', pg_temp.v('L.F.'), 'T · Medical') ->> 'changed');
select 'legacy_post_photo=' || (lp_add_photo(pg_temp.id('L.F.'), '00000000-0000-4000-8000-0000000000b1',
          pg_temp.id('L.F.') || '/00000000-0000-4000-8000-0000000000b1.jpg', null, 'today', 'T · Medical') ->> 'created');
-- A legacy status ('Found – Transported') can still be edited and get a photo.
select 'legacy_status_edit=' || (lp_update_fields(pg_temp.id('X.Y.'), '{"hair":"Blond"}', pg_temp.v('X.Y.'), 'T · Medical') ->> 'changed');
select 'legacy_status_photo=' || (lp_add_photo(pg_temp.id('X.Y.'), '00000000-0000-4000-8000-0000000000b2',
          pg_temp.id('X.Y.') || '/00000000-0000-4000-8000-0000000000b2.jpg', null, 'older', 'T · Medical') ->> 'created');
-- New non-canonical values are still refused (by the functions, and by the CHECK for anything else).
select 'new_legacy_post=' || pg_temp.refused(format('select lp_update_fields(%L, %L, %s, %L)',
          pg_temp.id('A.B.'), '{"reporting_location":"FA 3"}', pg_temp.v('A.B.'), 'T · Medical'));
select 'new_bogus_post=' || pg_temp.refused(format('update patients set reporting_location = %L where id = %L', 'Bogus', pg_temp.id('A.B.')));
select 'new_bogus_status=' || pg_temp.refused(format('update patients set status = %L where id = %L', 'Bogus', pg_temp.id('A.B.')));
-- byPost: the fixed posts, then Gate (Other) and the legacy 'FA 3', adding up to open.
select 'stats_total=' || (lp_stats() ->> 'total');
select 'by_post=' || (select string_agg(b ->> 'postShort' || ':' || (b ->> 'count'), ',') from jsonb_array_elements(lp_stats() -> 'byPost') b);
select 'by_post_sums_to_open=' || ((s -> 'open' ->> 'waiting')::int + (s -> 'open' ->> 'inMedical')::int
          = (select sum((b ->> 'count')::int) from jsonb_array_elements(s -> 'byPost') b))::text
  from (select lp_stats() as s) x;
-- A36: the idempotent repeat holds for a legacy status too ({changed: false}, no audit row), while a
-- non-canonical target is still refused. (Each check reads the audit in a later statement.)
select 'legacy_status_repeat=' || (lp_set_status(pg_temp.id('X.Y.'), pg_temp.v('X.Y.'), 'Found – Transported', 'T · Medical', 'answer') ->> 'changed');
select 'legacy_status_repeat_audit=' || count(*) from audit_events where patient_id = pg_temp.id('X.Y.') and action_type = 'status_changed';
select 'bogus_status_target=' || pg_temp.refused(format('select lp_set_status(%L, %s, %L, %L, %L)',
          pg_temp.id('A.B.'), pg_temp.v('A.B.'), 'Found – Transported', 'T · Medical', 'answer'));
-- A35: an edit of only other_location still records both halves of the post (last, as it renames Gate).
select 'other_location_edit=' || (lp_update_fields(pg_temp.id('A.B.'), '{"other_location":"Gate 2"}', pg_temp.v('A.B.'), 'T · Medical') ->> 'changed');
select 'post_pair_audit=' || (previous_value ->> 'reporting_location') || '/' || (previous_value ->> 'other_location')
       || '>' || (new_value ->> 'reporting_location') || '/' || (new_value ->> 'other_location')
  from audit_events where patient_id = pg_temp.id('A.B.') and action_type = 'patient_updated'
  order by occurred_at desc limit 1;
SQL
)"
echo "  smoke: $result"
for want in "last_seen=true" "rows=3" "answer=Found – Awaiting Reunion" "legacy_post_answer=Found – Awaiting Reunion" \
            "legacy_post_edit=true" "legacy_post_photo=true" "legacy_status_edit=true" "legacy_status_photo=true" \
            "legacy_status_repeat=false" "legacy_status_repeat_audit=0" "bogus_status_target=refused" \
            "other_location_edit=true" "post_pair_audit=Other/Gate>Other/Gate 2" \
            "new_legacy_post=refused" "new_bogus_post=refused" "new_bogus_status=refused" "stats_total=3" \
            "by_post=FA 3:0,FA 4:0,Command:0,Base:0,FA 3:1,Gate:1" "by_post_sums_to_open=true"; do
  [[ "$result" == *"$want"* ]] || die "fixture smoke test failed: expected '$want'"
done

# The re-added CHECKs keep the legacy values in use and are NOT VALID.
checks="$(psql "$fixture_url" -v ON_ERROR_STOP=1 -q -At -c "
  select string_agg(conname || ':' || convalidated::text || ':' ||
         (pg_get_constraintdef(oid) like '%''FA 3''::text%' or pg_get_constraintdef(oid) like '%''Found – Transported''::text%')::text, ' ' order by conname)
  from pg_constraint where conrelid = 'public.patients'::regclass
    and conname in ('patients_reporting_location_check', 'patients_status_check')")"
echo "  checks: $checks"
[[ "$checks" == "patients_reporting_location_check:false:true patients_status_check:false:true" ]] \
  || die "fixture: the re-added CHECKs must be NOT VALID and keep the legacy values in use"

echo "verify-migration: all good"
