#!/usr/bin/env bash
# Reset the LOCAL Supabase stack: re-apply every migration, load the synthetic seed, upload seed photos.
#
#   npm run db:reset
#
# Hard guard: refuses to run unless every database / API URL involved points at 127.0.0.1 or localhost.
# It never reads .env.local and never passes --linked or --db-url to the Supabase CLI.
# Only the Phase 1a, 1b-server, Integrate and QA agents may run this, and only when no other agent is running.
set -euo pipefail

cd "$(dirname "$0")/.."

die() { echo "db-reset: $*" >&2; exit 1; }

host_of() {
  # Prints the host part of a URL or postgres connection string.
  node -e '
    const raw = process.argv[1];
    try { const u = new URL(raw); process.stdout.write(u.hostname.replace(/^\[|\]$/g, "")); }
    catch { process.stdout.write("invalid"); }
  ' "$1"
}

require_local() {
  local label="$1" url="$2" host
  host="$(host_of "$url")"
  case "$host" in
    127.0.0.1|localhost) ;;
    *) die "refusing to run: $label host is '$host', not 127.0.0.1 or localhost." ;;
  esac
}

# Anything in the caller's environment that could redirect a client must also be local.
for var in NEXT_PUBLIC_SUPABASE_URL SUPABASE_URL SUPABASE_DB_URL DATABASE_URL; do
  if [[ -n "${!var:-}" ]]; then
    require_local "$var" "${!var}"
  fi
done

# .env.test is the committed local-only env; its URL must be local too.
if [[ -f .env.test ]]; then
  test_url="$(grep -E '^NEXT_PUBLIC_SUPABASE_URL=' .env.test | head -n1 | cut -d= -f2- | tr -d '"' || true)"
  [[ -n "$test_url" ]] && require_local ".env.test NEXT_PUBLIC_SUPABASE_URL" "$test_url"
fi

command -v supabase >/dev/null || die "the Supabase CLI is not installed."
command -v psql >/dev/null || die "psql is not installed."

status_env="$(supabase status -o env 2>/dev/null)" || die "the local stack is not running. Start it with: supabase start"
get() { printf '%s\n' "$status_env" | grep -E "^$1=" | head -n1 | cut -d= -f2- | tr -d '"'; }

db_url="$(get DB_URL)"
api_url="$(get API_URL)"
secret_key="$(get SECRET_KEY)"
[[ -n "$secret_key" ]] || secret_key="$(get SERVICE_ROLE_KEY)"

[[ -n "$db_url" && -n "$api_url" && -n "$secret_key" ]] || die "could not read the local stack's URLs and keys."
require_local "local DB_URL" "$db_url"
require_local "local API_URL" "$api_url"

echo "db-reset: resetting the local database ($db_url)"
supabase db reset --local --no-seed

echo "db-reset: loading supabase/seed.sql"
psql "$db_url" -v ON_ERROR_STOP=1 -q -f supabase/seed.sql >/dev/null

echo "db-reset: uploading synthetic seed photos"
full="supabase/seed-photos/photo.jpg"
thumb="supabase/seed-photos/photo_thumb.jpg"
[[ -f "$full" && -f "$thumb" ]] || die "missing $full or $thumb"

upload() {
  local path="$1" file="$2" code
  code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
    "$api_url/storage/v1/object/patient-photos/$path" \
    -H "apikey: $secret_key" -H "Authorization: Bearer $secret_key" \
    -H "Content-Type: image/jpeg" -H "x-upsert: true" \
    --data-binary "@$file")"
  [[ "$code" == "200" ]] || die "upload of a seed photo failed with HTTP $code"
}

count=0
while IFS='|' read -r storage_path thumb_path; do
  [[ -n "$storage_path" ]] || continue
  upload "$storage_path" "$full"; count=$((count + 1))
  if [[ -n "$thumb_path" ]]; then upload "$thumb_path" "$thumb"; count=$((count + 1)); fi
done < <(psql "$db_url" -At -F '|' -c "select storage_path, coalesce(thumb_path, '') from public.patient_photos order by storage_path")

echo "db-reset: done ($count photo objects uploaded)"
