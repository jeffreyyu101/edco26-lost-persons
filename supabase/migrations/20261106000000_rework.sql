-- =====================================================================================================
-- 20261106000000_rework.sql — "Is my friend in medical?" rebuild (EDC Orlando 2026)
--
-- THE ONLY FILE TO PASTE INTO THE PRODUCTION SQL EDITOR.
--
-- How to apply (Supabase dashboard → SQL Editor, as the default postgres role):
--   1. Dry run: paste the whole file, change the LAST line `commit;` to `rollback;`, and run it.
--      It must finish without an error. Read the NOTICE lines (constraint checks). Nothing is changed.
--   2. Real run: paste the file again unchanged (ending in `commit;`) and run it.
--   It is safe to run twice: every step is idempotent and the whole file is one transaction, so a
--   failure part-way leaves the database exactly as it was.
--
-- What it does (no existing column or constraint is altered, except the NOT VALID re-add in step 2):
--   0. Preflight: the production tables and the client_mutation_id unique key must exist.
--   1. patients.row_version (optimistic concurrency and sync) and patients.last_seen (if missing).
--   2. Replaces the reporting_location / status CHECK only when it lacks a needed value (or a value rows
--      already hold), NOT VALID. Values already in the table stay allowed, so legacy rows stay editable.
--   3. lp_touch() BEFORE UPDATE trigger: updated_at = clock_timestamp(), row_version + 1.
--   4. patient_photos.thumb_path.
--   5. lp_login_attempts (sign-in rate limiting), RLS on, no policies.
--   6. The lp_* functions the app calls. Only service_role may execute them.
-- =====================================================================================================

begin;

-- Never queue behind live traffic for long while altering tables during the event.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- -----------------------------------------------------------------------------------------------------
-- 0. Preflight
-- -----------------------------------------------------------------------------------------------------
do $preflight$
declare
  v_attnum smallint;
  v_missing text;
begin
  if current_setting('server_version_num')::int < 140000 then
    raise exception 'Preflight failed: PostgreSQL 14 or newer is required (found %).', current_setting('server_version');
  end if;

  if to_regclass('public.patients') is null then
    raise exception 'Preflight failed: table public.patients is missing. This is not the lost-persons database.';
  end if;
  if to_regclass('public.audit_events') is null then
    raise exception 'Preflight failed: table public.audit_events is missing.';
  end if;
  if to_regclass('public.patient_photos') is null then
    raise exception 'Preflight failed: table public.patient_photos is missing.';
  end if;
  if to_regclass('public.patient_case_number_seq') is null then
    raise exception 'Preflight failed: sequence public.patient_case_number_seq is missing.';
  end if;

  select a.attnum into v_attnum
  from pg_catalog.pg_attribute a
  where a.attrelid = 'public.patients'::regclass and a.attname = 'client_mutation_id' and not a.attisdropped;
  if v_attnum is null then
    raise exception 'Preflight failed: column public.patients.client_mutation_id is missing.';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_index i
    where i.indrelid = 'public.patients'::regclass
      and i.indisunique and i.indisvalid and i.indpred is null
      and i.indnatts = 1 and i.indkey[0] = v_attnum
  ) then
    raise exception 'Preflight failed: no unique index or constraint on public.patients(client_mutation_id).';
  end if;

  -- Every pre-existing column the functions below read or write (last_seen is added in step 1).
  select string_agg(format('%s.%s', c.tbl, c.col), ', ' order by c.tbl, c.col) into v_missing
  from (values
    ('patients', 'id'), ('patients', 'case_number'), ('patients', 'first_name'), ('patients', 'last_name'),
    ('patients', 'age'), ('patients', 'gender'), ('patients', 'height_build'), ('patients', 'hair'),
    ('patients', 'identifying_features'), ('patients', 'physical_description'),
    ('patients', 'clothing'), ('patients', 'additional_notes'), ('patients', 'reporting_location'),
    ('patients', 'other_location'), ('patients', 'contact_name'), ('patients', 'contact_phone'),
    ('patients', 'contact_relationship'), ('patients', 'contact_notes'), ('patients', 'status'),
    ('patients', 'created_by'), ('patients', 'updated_by'), ('patients', 'created_at'), ('patients', 'updated_at'),
    ('patients', 'found_at'), ('patients', 'reunion_started_at'), ('patients', 'closed_at'),
    ('audit_events', 'id'), ('audit_events', 'patient_id'), ('audit_events', 'staff_name'),
    ('audit_events', 'action_type'), ('audit_events', 'previous_value'), ('audit_events', 'new_value'),
    ('audit_events', 'notes'), ('audit_events', 'occurred_at'),
    ('patient_photos', 'id'), ('patient_photos', 'patient_id'), ('patient_photos', 'storage_path'),
    ('patient_photos', 'photo_timing'), ('patient_photos', 'uploaded_by'), ('patient_photos', 'created_at'),
    ('patient_photos', 'is_active')
  ) as c(tbl, col)
  where not exists (
    select 1 from pg_catalog.pg_attribute a
    where a.attrelid = format('public.%I', c.tbl)::regclass and a.attname = c.col and not a.attisdropped
  );
  if v_missing is not null then
    raise exception 'Preflight failed: missing columns: %', v_missing;
  end if;
end
$preflight$;

-- -----------------------------------------------------------------------------------------------------
-- 1. Row version, and last_seen in case Jeffrey's 20261105 add_last_seen migration never ran.
-- -----------------------------------------------------------------------------------------------------
alter table public.patients add column if not exists row_version bigint not null default 0;
alter table public.patients add column if not exists last_seen text;

-- -----------------------------------------------------------------------------------------------------
-- 2. Locations and statuses (in case 20261105_update_locations_and_statuses never ran in production).
--    A CHECK is replaced only when its current definition lacks one of the needed values (spec §4), or a
--    value that rows already hold. The new CHECK allows the needed values PLUS every value already in the
--    table: NOT VALID only skips re-checking existing rows once, but Postgres checks every later UPDATE of
--    a row, and every lp_* write is an UPDATE (status, updated_by, ...). Without the extra values a legacy
--    row (e.g. reporting_location 'FA 3' or status 'Found – Transported') could never be answered, edited
--    or given a photo again. New non-canonical values are still refused: lp_clean_fields only accepts the
--    five posts and lp_set_status only the settable statuses. A NOTICE names the extra values kept.
-- -----------------------------------------------------------------------------------------------------
do $checks$
declare
  v_locations constant text[] := array['FA 3 – Kinetic', 'FA 4 – Oasis', 'Command', 'Base', 'Other'];
  v_statuses constant text[] := array['Added', 'Checked – Not Found', 'Found – Awaiting Reunion', 'Reunited – Closed',
                                      'Found – Discharged', 'Bring friend to medical', 'Cancelled'];
  v_def text;
  v_value text;
  v_lacking boolean;
  v_extra text[];
  v_allowed text[];
  v_kept text;
begin
  -- reporting_location
  select pg_catalog.array_agg(x.v order by x.v),
         pg_catalog.string_agg(pg_catalog.format('%L (%s rows)', x.v, x.n), ', ' order by x.v)
    into v_extra, v_kept
  from (
    select p.reporting_location as v, pg_catalog.count(*) as n
    from public.patients p
    where p.reporting_location is not null and not (p.reporting_location = any (v_locations))
    group by p.reporting_location
  ) as x;
  v_allowed := v_locations || coalesce(v_extra, '{}'::text[]);

  select pg_catalog.pg_get_constraintdef(c.oid) into v_def
  from pg_catalog.pg_constraint c
  where c.conrelid = 'public.patients'::regclass and c.conname = 'patients_reporting_location_check';
  v_lacking := v_def is null;
  if not v_lacking then
    foreach v_value in array v_allowed loop
      if pg_catalog.strpos(v_def, pg_catalog.quote_literal(v_value)) = 0 then
        v_lacking := true;
      end if;
    end loop;
  end if;
  if v_lacking then
    raise notice 'patients_reporting_location_check: replacing (NOT VALID). Legacy values kept for existing rows: %',
      coalesce(v_kept, 'none');
    alter table public.patients drop constraint if exists patients_reporting_location_check;
    execute pg_catalog.format(
      'alter table public.patients add constraint patients_reporting_location_check check (reporting_location in (%s)) not valid',
      (select pg_catalog.string_agg(pg_catalog.quote_literal(u.v), ', ' order by u.o)
       from pg_catalog.unnest(v_allowed) with ordinality as u(v, o)));
  else
    raise notice 'patients_reporting_location_check: already allows every post and every value in use, unchanged.';
  end if;

  -- status
  select pg_catalog.array_agg(x.v order by x.v),
         pg_catalog.string_agg(pg_catalog.format('%L (%s rows)', x.v, x.n), ', ' order by x.v)
    into v_extra, v_kept
  from (
    select p.status as v, pg_catalog.count(*) as n
    from public.patients p
    where p.status is not null and not (p.status = any (v_statuses))
    group by p.status
  ) as x;
  v_allowed := v_statuses || coalesce(v_extra, '{}'::text[]);

  select pg_catalog.pg_get_constraintdef(c.oid) into v_def
  from pg_catalog.pg_constraint c
  where c.conrelid = 'public.patients'::regclass and c.conname = 'patients_status_check';
  v_lacking := v_def is null;
  if not v_lacking then
    foreach v_value in array v_allowed loop
      if pg_catalog.strpos(v_def, pg_catalog.quote_literal(v_value)) = 0 then
        v_lacking := true;
      end if;
    end loop;
  end if;
  if v_lacking then
    raise notice 'patients_status_check: replacing (NOT VALID). Legacy values kept for existing rows: %',
      coalesce(v_kept, 'none');
    alter table public.patients drop constraint if exists patients_status_check;
    execute pg_catalog.format(
      'alter table public.patients add constraint patients_status_check check (status in (%s)) not valid',
      (select pg_catalog.string_agg(pg_catalog.quote_literal(u.v), ', ' order by u.o)
       from pg_catalog.unnest(v_allowed) with ordinality as u(v, o)));
  else
    raise notice 'patients_status_check: already allows every status and every value in use, unchanged.';
  end if;
end
$checks$;

-- -----------------------------------------------------------------------------------------------------
-- 3. Touch trigger. clock_timestamp() (wall clock at write time) keeps the sync cursor close to commit time.
--    create or replace (never drop): the trigger depends on the function.
-- -----------------------------------------------------------------------------------------------------
create or replace function public.lp_touch()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
begin
  new.updated_at := pg_catalog.clock_timestamp();
  new.row_version := old.row_version + 1;
  return new;
end
$fn$;

create or replace trigger lp_patients_touch
  before update on public.patients
  for each row execute function public.lp_touch();

create index if not exists patients_updated_at_idx on public.patients (updated_at);

-- -----------------------------------------------------------------------------------------------------
-- 4. Thumbnails
-- -----------------------------------------------------------------------------------------------------
alter table public.patient_photos add column if not exists thumb_path text;

-- -----------------------------------------------------------------------------------------------------
-- 5. Login attempts (sign-in rate limiting). RLS on, no policies: only service_role can touch it.
-- -----------------------------------------------------------------------------------------------------
create table if not exists public.lp_login_attempts (
  id bigserial primary key,
  ip text not null,
  name_key text not null,
  ok boolean,
  at timestamptz not null default now()
);
create index if not exists lp_login_attempts_ip_at_idx on public.lp_login_attempts (ip, at);
create index if not exists lp_login_attempts_name_key_at_idx on public.lp_login_attempts (name_key, at);
create index if not exists lp_login_attempts_at_idx on public.lp_login_attempts (at);
alter table public.lp_login_attempts enable row level security;

-- RLS stays on for every app table (no policies: browsers can never read them directly).
alter table public.patients enable row level security;
alter table public.audit_events enable row level security;
alter table public.patient_photos enable row level security;

-- -----------------------------------------------------------------------------------------------------
-- Privileges. The app server is the only client and it uses service_role. Grant exactly what the
-- security-invoker functions (and the server's direct photo / export reads) need, explicitly.
-- anon and authenticated get nothing (RLS blocks them anyway; this is defence in depth).
-- -----------------------------------------------------------------------------------------------------
revoke all on table public.patients, public.audit_events, public.patient_photos, public.lp_login_attempts
  from anon, authenticated;
revoke all on sequence public.patient_case_number_seq, public.lp_login_attempts_id_seq from anon, authenticated;

grant select, insert, update on table public.patients to service_role;
grant select, insert on table public.audit_events to service_role;
grant select, insert, update on table public.patient_photos to service_role;
grant select, insert, update, delete on table public.lp_login_attempts to service_role;
grant usage, select on sequence public.patient_case_number_seq to service_role;
grant usage, select on sequence public.lp_login_attempts_id_seq to service_role;

-- -----------------------------------------------------------------------------------------------------
-- 6. Functions
--
-- Timeouts: every RPC function carries `set statement_timeout = '4s'` and `set lock_timeout = '2s'` as
-- CREATE FUNCTION attributes. PostgREST hoists statement_timeout to the transaction, so it bounds the
-- whole call; lock_timeout applies inside the function. (SET LOCAL in a function body does NOT bound the
-- running call — verified.) Bounded write transactions are what make the 30 s sync overlap safe.
--
-- Errors (SQLSTATE → HTTP, mapped by the server from error.code):
--   P0409 version conflict (HINT = current status)                   → 409
--   P0422 invalid input or illegal transition (DETAIL = field:<name>) → 422
--   P0403 creator-only action by someone else                        → 403
--   P0429 too many sign-in attempts (HINT = seconds) / photo limit   → 429 / 422
--   P0002 no such request                                            → 404
-- Messages never contain names, phone numbers or other free text from a row.
-- -----------------------------------------------------------------------------------------------------

-- Earlier drafts of this file (never in production) used these; drop them so a re-run is clean.
drop function if exists public.lp_row_json(public.patients);
drop function if exists public.lp_sync(timestamptz, uuid[]);
drop function if exists public.lp_sync(timestamptz, uuid[], boolean);

drop function if exists public.lp_canon_staff(text);
drop function if exists public.lp_row(public.patients);
drop function if exists public.lp_require_staff(text);
drop function if exists public.lp_clean_fields(jsonb, boolean);
drop function if exists public.lp_sync(timestamptz, uuid[], boolean, timestamptz, uuid, integer);
drop function if exists public.lp_create_request(jsonb, text);
drop function if exists public.lp_set_status(uuid, bigint, text, text, text);
drop function if exists public.lp_update_fields(uuid, jsonb, bigint, text);
drop function if exists public.lp_cancel(uuid, bigint, text);
drop function if exists public.lp_add_photo(uuid, uuid, text, text, text, text);
drop function if exists public.lp_login_begin(text, text);
drop function if exists public.lp_login_finish(bigint, boolean);
drop function if exists public.lp_stats();
drop function if exists public.lp_detail(uuid);

-- lp_canon_staff: canonical form of an attribution string "Name · Team", for creator checks.
-- MUST stay identical to canonStaff() in lib/domain.ts (a unit test compares this alias table with it):
--   1. every run of whitespace (the JavaScript \s set) becomes one space
--   2. "•" / "·" separator variants, with an optional space either side, become " · "
--   3. leading and trailing spaces are removed; the result is lowercased
--   4. the part after the LAST " · " is a team; known aliases map to the canonical team
-- Immutable and pure: no SET attributes, no timeouts.
create function public.lp_canon_staff(p text)
returns text
language plpgsql
immutable
strict
parallel safe
security invoker
as $fn$
declare
  v text;
  v_parts text[];
  v_team text;
begin
  v := pg_catalog.regexp_replace(
    p, '[\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+', ' ', 'g');
  v := pg_catalog.regexp_replace(v, ' ?[\u2022\u00b7\u2219\u22c5\u30fb\uff65\u0387] ?', ' · ', 'g');
  v := pg_catalog.lower(pg_catalog.btrim(v, ' '));

  v_parts := pg_catalog.regexp_match(v, '^(.*) · (.*)$');
  if v_parts is null then
    return v;
  end if;

  v_team := case v_parts[2]
    -- TEAM_ALIASES:BEGIN (keep identical to TEAM_ALIASES in lib/domain.ts)
    when 'dispatch' then 'gc/hx - dispatch'
    when 'gchx dispatch' then 'gc/hx - dispatch'
    when 'base' then 'gc/hx - base'
    when 'gchx base' then 'gc/hx - base'
    when 'med transpo' then 'gc/hx - special operations/med transpo'
    when 'gchx med transpo' then 'gc/hx - special operations/med transpo'
    when 'transport' then 'gc/hx - special operations/med transpo'
    when 'special operations' then 'gc/hx - special operations/med transpo'
    when 'medical' then 'medical'
    when 'prevent' then 'prevent'
    -- TEAM_ALIASES:END
    else v_parts[2]
  end;

  return v_parts[1] || ' · ' || v_team;
end
$fn$;

-- lp_row: THE row JSON (snake_case) for sync and every mutation response: every known patients column
-- plus first_photo_id and photo_count over active photos. The server maps it through an allowlist.
-- Internal helper (called from the RPC functions, which carry the timeouts).
create function public.lp_row(p public.patients)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_count integer;
  v_first uuid;
begin
  select pg_catalog.count(*)::integer,
         (pg_catalog.array_agg(ph.id order by ph.created_at, ph.id))[1]
    into v_count, v_first
  from public.patient_photos ph
  where ph.patient_id = p.id and ph.is_active;

  return pg_catalog.jsonb_build_object(
    'id', p.id,
    'client_mutation_id', p.client_mutation_id,
    'case_number', p.case_number,
    'first_name', p.first_name,
    'last_name', p.last_name,
    'age', p.age,
    'gender', p.gender,
    'height_build', p.height_build,
    'hair', p.hair,
    'identifying_features', p.identifying_features,
    'physical_description', p.physical_description,
    'last_seen', p.last_seen,
    'clothing', p.clothing,
    'additional_notes', p.additional_notes,
    'reporting_location', p.reporting_location,
    'other_location', p.other_location,
    'contact_name', p.contact_name,
    'contact_phone', p.contact_phone,
    'contact_relationship', p.contact_relationship,
    'contact_notes', p.contact_notes,
    'status', p.status,
    'created_by', p.created_by,
    'updated_by', p.updated_by,
    'created_at', p.created_at,
    'updated_at', p.updated_at,
    'found_at', p.found_at,
    'reunion_started_at', p.reunion_started_at,
    'closed_at', p.closed_at
  ) || pg_catalog.jsonb_build_object(
    'row_version', p.row_version,
    'first_photo_id', v_first,
    'photo_count', v_count
  );
end
$fn$;

-- lp_require_staff: the attribution string must be present and sane. Internal helper.
create function public.lp_require_staff(p_staff text)
returns void
language plpgsql
immutable
security invoker
set search_path = public, pg_temp
as $fn$
begin
  if p_staff is null or pg_catalog.btrim(p_staff) = '' or pg_catalog.char_length(p_staff) > 200 then
    raise exception using errcode = 'P0422', message = 'invalid_staff', detail = 'field:staff';
  end if;
end
$fn$;

-- lp_clean_fields: validate and normalise editable request fields from JSON. Internal helper.
--   * Only whitelisted keys (spec §4 editable fields + reporting_location, other_location). Others → P0422.
--   * Text values must be JSON strings or null; blank strings become null.
--   * age: a JSON integer 0–120, or null. gender: Male / Female / Other, or null.
--   * Length limits per spec §4. reporting_location, when present, must be a valid post (never null).
-- Returns the cleaned object with exactly the keys given (create requires reporting_location).
create function public.lp_clean_fields(p jsonb, p_partial boolean)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_out jsonb := '{}'::jsonb;
  v_key text;
  v_val jsonb;
  v_text text;
  v_num numeric;
  v_limit integer;
begin
  if p is null or pg_catalog.jsonb_typeof(p) <> 'object' then
    raise exception using errcode = 'P0422', message = 'invalid_body', detail = 'field:body';
  end if;

  for v_key, v_val in select e.key, e.value from pg_catalog.jsonb_each(p) as e loop
    v_limit := case v_key
      when 'first_name' then 120
      when 'last_name' then 120
      when 'clothing' then 300
      when 'hair' then 300
      when 'height_build' then 300
      when 'identifying_features' then 300
      when 'last_seen' then 1000
      when 'physical_description' then 2000
      when 'additional_notes' then 2000
      when 'contact_notes' then 2000
      when 'contact_name' then 120
      when 'contact_relationship' then 120
      when 'contact_phone' then 40
      when 'other_location' then 80
      when 'gender' then 10
      when 'reporting_location' then 40
      when 'age' then 0
      else null
    end;

    if v_limit is null then
      raise exception using errcode = 'P0422', message = 'unknown_field',
        detail = pg_catalog.format('field:%s', pg_catalog.left(v_key, 60));
    end if;

    if v_key = 'age' then
      if pg_catalog.jsonb_typeof(v_val) = 'null' then
        v_out := v_out || pg_catalog.jsonb_build_object('age', null);
      elsif pg_catalog.jsonb_typeof(v_val) = 'number' then
        v_num := (v_val #>> '{}')::numeric;
        if v_num <> pg_catalog.trunc(v_num) or v_num < 0 or v_num > 120 then
          raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:age';
        end if;
        v_out := v_out || pg_catalog.jsonb_build_object('age', v_num::integer);
      else
        raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:age';
      end if;
      continue;
    end if;

    if pg_catalog.jsonb_typeof(v_val) = 'null' then
      v_text := null;
    elsif pg_catalog.jsonb_typeof(v_val) = 'string' then
      v_text := v_val #>> '{}';
      if pg_catalog.btrim(v_text, E' \t\r\n') = '' then
        v_text := null;
      end if;
    else
      raise exception using errcode = 'P0422', message = 'invalid_field', detail = pg_catalog.format('field:%s', v_key);
    end if;

    if v_text is not null and pg_catalog.char_length(v_text) > v_limit then
      raise exception using errcode = 'P0422', message = 'field_too_long', detail = pg_catalog.format('field:%s', v_key);
    end if;

    if v_key = 'gender' and v_text is not null and v_text not in ('Male', 'Female', 'Other') then
      raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:gender';
    end if;

    if v_key = 'reporting_location'
       and (v_text is null or v_text not in ('FA 3 – Kinetic', 'FA 4 – Oasis', 'Command', 'Base', 'Other')) then
      raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:reporting_location';
    end if;

    v_out := v_out || pg_catalog.jsonb_build_object(v_key, v_text);
  end loop;

  if not p_partial and not (v_out ? 'reporting_location') then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:reporting_location';
  end if;

  return v_out;
end
$fn$;

-- lp_sync: one jsonb value per call (avoids the PostgREST row cap), keyset-paged on (updated_at, id).
--   p_ids given      → exactly those rows (max 200), one page
--   p_since null     → every row (full fetch)
--   otherwise        → rows with updated_at > p_since − 30 s (the overlap covers in-flight commits)
--   p_after_at/_id   → continue after that (updated_at, id) position (from the previous page's `next`)
--   p_reconcile      → also versions = [[id, row_version], …] for ALL rows
-- Returns {serverTime, rows, hasMore, next: {at, id} | null, versions?}.
-- serverTime is clock_timestamp() captured FIRST, before any row is read. A client that pages must keep the
-- FIRST page's serverTime as its next cursor and advance it only after every page is applied.
-- Pass serverTime / next.at back verbatim (microsecond precision): never round-trip them through Date.
create function public.lp_sync(
  p_since timestamptz,
  p_ids uuid[] default null,
  p_reconcile boolean default false,
  p_after_at timestamptz default null,
  p_after_id uuid default null,
  p_limit integer default 500
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
set lock_timeout = '2s'
as $fn$
declare
  v_server_time timestamptz := pg_catalog.clock_timestamp();
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 1000);
  v_rows jsonb;
  v_has_more boolean := false;
  v_next jsonb := null;
  v_last_at timestamptz;
  v_last_id text;
  v_result jsonb;
begin
  if p_ids is not null then
    if pg_catalog.cardinality(p_ids) > 200 then
      raise exception using errcode = 'P0422', message = 'too_many_ids', detail = 'field:ids';
    end if;
    select coalesce(pg_catalog.jsonb_agg(public.lp_row(p) order by p.updated_at, p.id), '[]'::jsonb)
      into v_rows
    from public.patients p
    where p.id = any (p_ids);
  else
    if (p_after_at is null) <> (p_after_id is null) then
      raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:after';
    end if;

    -- One statement (one snapshot): fetch limit + 1 rows to learn whether another page follows.
    select coalesce(pg_catalog.jsonb_agg(public.lp_row(s.pat) order by s.rn) filter (where s.rn <= v_limit), '[]'::jsonb),
           pg_catalog.count(*) > v_limit,
           pg_catalog.max((s.pat).updated_at) filter (where s.rn = v_limit),
           pg_catalog.max(((s.pat).id)::text) filter (where s.rn = v_limit)
      into v_rows, v_has_more, v_last_at, v_last_id
    from (
      select t.pat, pg_catalog.row_number() over (order by (t.pat).updated_at, (t.pat).id) as rn
      from (
        select p as pat
        from public.patients p
        where (p_since is null or p.updated_at > p_since - interval '30 seconds')
          and (p_after_at is null or (p.updated_at, p.id) > (p_after_at, p_after_id))
        order by p.updated_at, p.id
        limit v_limit + 1
      ) as t
    ) as s;

    if v_has_more then
      v_next := pg_catalog.jsonb_build_object('at', v_last_at, 'id', v_last_id::uuid);
    end if;
  end if;

  v_result := pg_catalog.jsonb_build_object(
    'serverTime', v_server_time,
    'rows', v_rows,
    'hasMore', v_has_more,
    'next', v_next
  );

  if coalesce(p_reconcile, false) then
    v_result := v_result || pg_catalog.jsonb_build_object(
      'versions',
      (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(p.id, p.row_version) order by p.id), '[]'::jsonb)
       from public.patients p)
    );
  end if;

  return v_result;
end
$fn$;

-- lp_create_request: idempotent on client_mutation_id. An existing row is returned first (so a retry
-- never burns a case number); otherwise insert … on conflict do nothing. Audit only on an actual insert.
--   p: {client_mutation_id, reporting_location, other_location, first_name, last_name, age, gender, clothing,
--       last_seen, hair, height_build, identifying_features, physical_description, additional_notes,
--       contact_name, contact_phone, contact_relationship, contact_notes} — snake_case; the server splits the
--       form's single `name` with domain.splitName. Omitted keys are stored as null.
--   p_staff: the attribution string from the session ("Name · Team"), never from the client.
-- Returns {created: boolean, row}.
create function public.lp_create_request(p jsonb, p_staff text)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
set lock_timeout = '2s'
as $fn$
declare
  v_cmid uuid;
  v_fields jsonb;
  v_new public.patients;
  v_row public.patients;
begin
  perform public.lp_require_staff(p_staff);

  if p is null or pg_catalog.jsonb_typeof(p) <> 'object' then
    raise exception using errcode = 'P0422', message = 'invalid_body', detail = 'field:body';
  end if;

  if pg_catalog.jsonb_typeof(p -> 'client_mutation_id') is distinct from 'string' then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:client_mutation_id';
  end if;
  begin
    v_cmid := (p ->> 'client_mutation_id')::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:client_mutation_id';
  end;

  -- 1. Already created (a retry): return it unchanged.
  select * into v_row from public.patients where client_mutation_id = v_cmid;
  if v_row.id is not null then
    return pg_catalog.jsonb_build_object('created', false, 'row', public.lp_row(v_row));
  end if;

  -- 2. Validate.
  v_fields := public.lp_clean_fields(p - 'client_mutation_id', false);

  -- Other needs other_location; any other post never keeps a stale other_location.
  if v_fields ->> 'reporting_location' = 'Other' then
    if (v_fields ->> 'other_location') is null then
      raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:other_location';
    end if;
  else
    v_fields := v_fields || '{"other_location": null}'::jsonb;
  end if;

  v_new := pg_catalog.jsonb_populate_record(null::public.patients, v_fields);

  if pg_catalog.char_length(pg_catalog.concat_ws(' ', v_new.first_name, v_new.last_name)) > 120 then
    raise exception using errcode = 'P0422', message = 'field_too_long', detail = 'field:name';
  end if;

  -- 3. Insert; a concurrent identical create loses the race and reads the winner's row.
  begin
    insert into public.patients as t (
      client_mutation_id, first_name, last_name, age, gender, height_build, hair, identifying_features,
      physical_description, last_seen, clothing, additional_notes, reporting_location, other_location,
      contact_name, contact_phone, contact_relationship, contact_notes, status, created_by, updated_by
    ) values (
      v_cmid, v_new.first_name, v_new.last_name, v_new.age, v_new.gender, v_new.height_build, v_new.hair,
      v_new.identifying_features, v_new.physical_description, v_new.last_seen, v_new.clothing,
      v_new.additional_notes, v_new.reporting_location, v_new.other_location, v_new.contact_name,
      v_new.contact_phone, v_new.contact_relationship, v_new.contact_notes, 'Added', p_staff, p_staff
    )
    on conflict (client_mutation_id) do nothing
    returning t.* into v_row;
  exception when check_violation or not_null_violation then
    raise exception using errcode = 'P0422', message = 'rejected_by_constraint';
  end;

  if v_row.id is null then
    select * into v_row from public.patients where client_mutation_id = v_cmid;
    if v_row.id is null then
      raise exception using errcode = 'P0002', message = 'not_found';
    end if;
    return pg_catalog.jsonb_build_object('created', false, 'row', public.lp_row(v_row));
  end if;

  insert into public.audit_events (patient_id, staff_name, action_type, previous_value, new_value)
  values (
    v_row.id, p_staff, 'patient_created', null,
    pg_catalog.jsonb_build_object('reporting_location', v_row.reporting_location, 'other_location', v_row.other_location)
  );

  return pg_catalog.jsonb_build_object('created', true, 'row', public.lp_row(v_row));
end
$fn$;

-- lp_set_status: the only way a status changes (except cancel).
--   Locks the row. Already at p_status → {changed: false, row}, no audit (two liaisons, same answer).
--   Version mismatch → P0409 (HINT = current status). Illegal transition → P0422.
--   Cancelled → Added is creator-only → P0403.
--   found_at: set on the first entry into Found – Awaiting Reunion; never overwritten or cleared.
--   reunion_started_at: now() on every entry into Found – Awaiting Reunion; cleared on → Added / Not found.
--   closed_at: now() on entry into Reunited / Discharged / Cancelled; cleared on any other target.
create function public.lp_set_status(p_id uuid, p_expected_version bigint, p_status text, p_staff text, p_kind text)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
set lock_timeout = '2s'
as $fn$
declare
  v_row public.patients;
  v_prev jsonb;
  v_allowed boolean;
begin
  perform public.lp_require_staff(p_staff);

  if p_id is null then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;
  if p_expected_version is null then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:expected_version';
  end if;
  if p_status is null or p_status not in ('Added', 'Checked – Not Found', 'Found – Awaiting Reunion',
                                          'Reunited – Closed', 'Found – Discharged', 'Cancelled') then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:status';
  end if;
  if p_kind is null or p_kind not in ('answer', 'change', 'reunite', 'discharge', 'undo', 'reopen') then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:kind';
  end if;

  select * into v_row from public.patients where id = p_id for update;
  if v_row.id is null then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;

  if v_row.status = p_status then
    return pg_catalog.jsonb_build_object('changed', false, 'row', public.lp_row(v_row));
  end if;

  if v_row.row_version <> p_expected_version then
    raise exception using errcode = 'P0409', message = 'version_conflict', hint = v_row.status;
  end if;

  v_allowed := case v_row.status
    -- TRANSITIONS:BEGIN (keep identical to TRANSITIONS in lib/domain.ts)
    when 'Added' then p_status in ('Checked – Not Found', 'Found – Awaiting Reunion')
    when 'Checked – Not Found' then p_status in ('Found – Awaiting Reunion', 'Added')
    when 'Found – Awaiting Reunion' then p_status in ('Reunited – Closed', 'Checked – Not Found', 'Found – Discharged', 'Added')
    when 'Reunited – Closed' then p_status in ('Found – Awaiting Reunion')
    when 'Found – Discharged' then p_status in ('Found – Awaiting Reunion')
    when 'Cancelled' then p_status in ('Added')
    when 'Bring friend to medical' then p_status in ('Reunited – Closed', 'Found – Discharged', 'Checked – Not Found')
    -- TRANSITIONS:END
    else false
  end;
  if not coalesce(v_allowed, false) then
    raise exception using errcode = 'P0422', message = 'illegal_transition', hint = v_row.status;
  end if;

  if v_row.status = 'Cancelled'
     and public.lp_canon_staff(v_row.created_by) is distinct from public.lp_canon_staff(p_staff) then
    raise exception using errcode = 'P0403', message = 'creator_only';
  end if;

  v_prev := pg_catalog.jsonb_build_object(
    'status', v_row.status,
    'found_at', v_row.found_at,
    'reunion_started_at', v_row.reunion_started_at,
    'closed_at', v_row.closed_at
  );

  begin
    update public.patients
       set status = p_status,
           found_at = case when p_status = 'Found – Awaiting Reunion' then coalesce(found_at, now()) else found_at end,
           reunion_started_at = case
             when p_status = 'Found – Awaiting Reunion' then now()
             when p_status in ('Added', 'Checked – Not Found') then null
             else reunion_started_at
           end,
           closed_at = case
             when p_status in ('Reunited – Closed', 'Found – Discharged', 'Cancelled') then now()
             else null
           end,
           updated_by = p_staff
     where id = p_id
    returning * into v_row;
  exception when check_violation then
    raise exception using errcode = 'P0422', message = 'rejected_by_constraint';
  end;

  insert into public.audit_events (patient_id, staff_name, action_type, previous_value, new_value)
  values (p_id, p_staff, 'status_changed', v_prev,
          pg_catalog.jsonb_build_object('status', p_status, 'kind', p_kind));

  return pg_catalog.jsonb_build_object('changed', true, 'row', public.lp_row(v_row));
end
$fn$;

-- lp_update_fields: edit details. Only whitelisted keys; never status, identity or system fields.
--   p_patch: snake_case keys as in lp_create_request (minus client_mutation_id); a name change sends
--   both first_name and last_name. Omitted = unchanged, null = clear.
--   Version mismatch → P0409. Unchanged keys are skipped; nothing changed → {changed: false, row}, no audit.
--   Field rules apply to the keys sent; the post rule applies to the merged row (Other needs
--   other_location; any other post clears it). Audit patient_updated with only the changed keys.
create function public.lp_update_fields(p_id uuid, p_patch jsonb, p_expected_version bigint, p_staff text)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
set lock_timeout = '2s'
as $fn$
declare
  v_row public.patients;
  v_merged public.patients;
  v_clean jsonb;
  v_current jsonb;
  v_changes jsonb := '{}'::jsonb;
  v_old jsonb := '{}'::jsonb;
  v_key text;
  v_val jsonb;
  v_other text;
begin
  perform public.lp_require_staff(p_staff);

  if p_id is null then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;
  if p_expected_version is null then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:expected_version';
  end if;

  v_clean := public.lp_clean_fields(p_patch, true);

  select * into v_row from public.patients where id = p_id for update;
  if v_row.id is null then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;

  if v_row.row_version <> p_expected_version then
    raise exception using errcode = 'P0409', message = 'version_conflict', hint = v_row.status;
  end if;

  v_current := pg_catalog.to_jsonb(v_row);

  for v_key, v_val in select e.key, e.value from pg_catalog.jsonb_each(v_clean) as e loop
    if (v_current -> v_key) is distinct from v_val then
      v_changes := v_changes || pg_catalog.jsonb_build_object(v_key, v_val);
    end if;
  end loop;

  -- The merged-row post rule.
  v_other := case when v_changes ? 'other_location' then v_changes ->> 'other_location' else v_row.other_location end;
  if coalesce(v_changes ->> 'reporting_location', v_row.reporting_location) = 'Other' then
    if v_other is null or pg_catalog.btrim(v_other) = '' then
      raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:other_location';
    end if;
  elsif v_other is not null then
    if v_row.other_location is null then
      v_changes := v_changes - 'other_location';
    else
      v_changes := v_changes || '{"other_location": null}'::jsonb;
    end if;
  end if;

  if v_changes = '{}'::jsonb then
    return pg_catalog.jsonb_build_object('changed', false, 'row', public.lp_row(v_row));
  end if;

  -- Merged display fields are audited whole: a name change records both first_name and last_name,
  -- a post change records both reporting_location and other_location (the trail shows "Name" / "Post").
  if v_changes ? 'first_name' or v_changes ? 'last_name' then
    v_changes := pg_catalog.jsonb_build_object(
      'first_name', coalesce(v_changes -> 'first_name', v_current -> 'first_name'),
      'last_name', coalesce(v_changes -> 'last_name', v_current -> 'last_name')) || v_changes;
  end if;
  if v_changes ? 'reporting_location' or v_changes ? 'other_location' then
    v_changes := pg_catalog.jsonb_build_object(
      'reporting_location', coalesce(v_changes -> 'reporting_location', v_current -> 'reporting_location'),
      'other_location', coalesce(v_changes -> 'other_location', v_current -> 'other_location')) || v_changes;
  end if;

  v_merged := pg_catalog.jsonb_populate_record(v_row, v_changes);

  if (v_changes ? 'first_name' or v_changes ? 'last_name')
     and pg_catalog.char_length(pg_catalog.concat_ws(' ', v_merged.first_name, v_merged.last_name)) > 120 then
    raise exception using errcode = 'P0422', message = 'field_too_long', detail = 'field:name';
  end if;

  for v_key in select pg_catalog.jsonb_object_keys(v_changes) loop
    v_old := v_old || pg_catalog.jsonb_build_object(v_key, v_current -> v_key);
  end loop;

  begin
    update public.patients
       set first_name = v_merged.first_name,
           last_name = v_merged.last_name,
           age = v_merged.age,
           gender = v_merged.gender,
           height_build = v_merged.height_build,
           hair = v_merged.hair,
           identifying_features = v_merged.identifying_features,
           physical_description = v_merged.physical_description,
           last_seen = v_merged.last_seen,
           clothing = v_merged.clothing,
           additional_notes = v_merged.additional_notes,
           reporting_location = v_merged.reporting_location,
           other_location = v_merged.other_location,
           contact_name = v_merged.contact_name,
           contact_phone = v_merged.contact_phone,
           contact_relationship = v_merged.contact_relationship,
           contact_notes = v_merged.contact_notes,
           updated_by = p_staff
     where id = p_id
    returning * into v_row;
  exception when check_violation or not_null_violation then
    raise exception using errcode = 'P0422', message = 'rejected_by_constraint';
  end;

  insert into public.audit_events (patient_id, staff_name, action_type, previous_value, new_value)
  values (p_id, p_staff, 'patient_updated', v_old, v_changes);

  return pg_catalog.jsonb_build_object('changed', true, 'row', public.lp_row(v_row));
end
$fn$;

-- lp_cancel: creator only (P0403), only while Added (P0422), version-checked (P0409).
-- Repeating a cancel that already happened returns {changed: false, row} so retries are safe.
create function public.lp_cancel(p_id uuid, p_expected_version bigint, p_staff text)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
set lock_timeout = '2s'
as $fn$
declare
  v_row public.patients;
  v_prev jsonb;
begin
  perform public.lp_require_staff(p_staff);

  if p_id is null then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;
  if p_expected_version is null then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:expected_version';
  end if;

  select * into v_row from public.patients where id = p_id for update;
  if v_row.id is null then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;

  if public.lp_canon_staff(v_row.created_by) is distinct from public.lp_canon_staff(p_staff) then
    raise exception using errcode = 'P0403', message = 'creator_only';
  end if;

  if v_row.status = 'Cancelled' then
    return pg_catalog.jsonb_build_object('changed', false, 'row', public.lp_row(v_row));
  end if;

  if v_row.status <> 'Added' then
    raise exception using errcode = 'P0422', message = 'illegal_transition', hint = v_row.status;
  end if;

  if v_row.row_version <> p_expected_version then
    raise exception using errcode = 'P0409', message = 'version_conflict', hint = v_row.status;
  end if;

  v_prev := pg_catalog.jsonb_build_object(
    'status', v_row.status,
    'found_at', v_row.found_at,
    'reunion_started_at', v_row.reunion_started_at,
    'closed_at', v_row.closed_at
  );

  begin
    update public.patients
       set status = 'Cancelled',
           closed_at = now(),
           reunion_started_at = null,
           updated_by = p_staff
     where id = p_id
    returning * into v_row;
  exception when check_violation then
    raise exception using errcode = 'P0422', message = 'rejected_by_constraint';
  end;

  insert into public.audit_events (patient_id, staff_name, action_type, previous_value, new_value)
  values (p_id, p_staff, 'cancelled', v_prev, pg_catalog.jsonb_build_object('status', 'Cancelled'));

  return pg_catalog.jsonb_build_object('changed', true, 'row', public.lp_row(v_row));
end
$fn$;

-- lp_add_photo: idempotent on p_photo_id (a retry returns created: false). At most 3 active photos (P0429).
-- Bumps the parent row (updated_by) so row_version / updated_at change and the photo syncs.
-- Paths must sit under "<p_id>/". Returns {created, photo: {id, photo_timing, uploaded_by, created_at,
-- has_thumb}, row}.
create function public.lp_add_photo(p_id uuid, p_photo_id uuid, p_path text, p_thumb text, p_timing text, p_staff text)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
set lock_timeout = '2s'
as $fn$
declare
  v_row public.patients;
  v_photo public.patient_photos;
  v_active integer;
begin
  perform public.lp_require_staff(p_staff);

  if p_id is null then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;
  if p_photo_id is null then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:photo_id';
  end if;
  if p_timing is null or p_timing not in ('today', 'older') then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:timing';
  end if;
  if p_path is null or pg_catalog.char_length(p_path) > 200 or pg_catalog.left(p_path, 37) <> p_id::text || '/' then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:path';
  end if;
  if p_thumb is not null
     and (pg_catalog.char_length(p_thumb) > 200 or pg_catalog.left(p_thumb, 37) <> p_id::text || '/') then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:thumb';
  end if;

  select * into v_row from public.patients where id = p_id for update;
  if v_row.id is null then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;

  select * into v_photo from public.patient_photos where id = p_photo_id;
  if v_photo.id is not null then
    if v_photo.patient_id <> p_id then
      raise exception using errcode = 'P0422', message = 'photo_id_in_use', detail = 'field:photo_id';
    end if;
    return pg_catalog.jsonb_build_object(
      'created', false,
      'photo', pg_catalog.jsonb_build_object(
        'id', v_photo.id, 'photo_timing', v_photo.photo_timing, 'uploaded_by', v_photo.uploaded_by,
        'created_at', v_photo.created_at, 'has_thumb', v_photo.thumb_path is not null),
      'row', public.lp_row(v_row)
    );
  end if;

  select pg_catalog.count(*)::integer into v_active
  from public.patient_photos where patient_id = p_id and is_active;
  if v_active >= 3 then
    raise exception using errcode = 'P0429', message = 'photo_limit', detail = 'field:photo';
  end if;

  begin
    insert into public.patient_photos (id, patient_id, storage_path, thumb_path, photo_timing, uploaded_by)
    values (p_photo_id, p_id, p_path, p_thumb, p_timing, p_staff)
    returning * into v_photo;
  exception when unique_violation then
    raise exception using errcode = 'P0422', message = 'photo_path_in_use', detail = 'field:path';
  end;

  begin
    update public.patients set updated_by = p_staff where id = p_id returning * into v_row;
  exception when check_violation then
    raise exception using errcode = 'P0422', message = 'rejected_by_constraint';
  end;

  insert into public.audit_events (patient_id, staff_name, action_type, previous_value, new_value)
  values (p_id, p_staff, 'photo_uploaded', null,
          pg_catalog.jsonb_build_object('photo_id', v_photo.id, 'photo_timing', v_photo.photo_timing));

  return pg_catalog.jsonb_build_object(
    'created', true,
    'photo', pg_catalog.jsonb_build_object(
      'id', v_photo.id, 'photo_timing', v_photo.photo_timing, 'uploaded_by', v_photo.uploaded_by,
      'created_at', v_photo.created_at, 'has_thumb', v_photo.thumb_path is not null),
    'row', public.lp_row(v_row)
  );
end
$fn$;

-- lp_login_begin: rate limit, then record a pending attempt and return its id.
--   Serialised per IP with an advisory lock so concurrent attempts are all counted.
--   Counts failed AND pending (ok is null) attempts in the last 15 minutes — a pending row never becomes
--   free, so a crash between begin and finish cannot hand out a free retry.
--   >= 10 for (ip, name_key), or >= 100 for the ip alone → P0429 with HINT = seconds until retry.
create function public.lp_login_begin(p_ip text, p_name_key text)
returns bigint
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
set lock_timeout = '2s'
as $fn$
declare
  v_now timestamptz;
  v_window constant interval := interval '15 minutes';
  v_pair integer;
  v_ip_count integer;
  v_retry_pair integer := 0;
  v_retry_ip integer := 0;
  v_id bigint;
begin
  if p_ip is null or p_ip = '' or pg_catalog.char_length(p_ip) > 100
     or p_name_key is null or p_name_key = '' or pg_catalog.char_length(p_name_key) > 200 then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:login';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('lp_login_begin:' || p_ip));
  v_now := pg_catalog.clock_timestamp();

  select pg_catalog.count(*)::integer into v_pair
  from public.lp_login_attempts
  where ip = p_ip and name_key = p_name_key and at > v_now - v_window and ok is not true;

  select pg_catalog.count(*)::integer into v_ip_count
  from public.lp_login_attempts
  where ip = p_ip and at > v_now - v_window and ok is not true;

  if v_pair >= 10 then
    -- The count drops below 10 when the 10th most recent counted attempt leaves the window.
    select pg_catalog.ceil(extract(epoch from (a.at + v_window - v_now)))::integer into v_retry_pair
    from public.lp_login_attempts a
    where a.ip = p_ip and a.name_key = p_name_key and a.at > v_now - v_window and a.ok is not true
    order by a.at desc
    offset 9 limit 1;
  end if;

  if v_ip_count >= 100 then
    select pg_catalog.ceil(extract(epoch from (a.at + v_window - v_now)))::integer into v_retry_ip
    from public.lp_login_attempts a
    where a.ip = p_ip and a.at > v_now - v_window and a.ok is not true
    order by a.at desc
    offset 99 limit 1;
  end if;

  if v_pair >= 10 or v_ip_count >= 100 then
    raise exception using errcode = 'P0429', message = 'too_many_attempts',
      hint = greatest(coalesce(v_retry_pair, 0), coalesce(v_retry_ip, 0), 1)::text;
  end if;

  insert into public.lp_login_attempts (ip, name_key, ok, at)
  values (p_ip, p_name_key, null, v_now)
  returning id into v_id;

  return v_id;
end
$fn$;

-- lp_login_finish: record the outcome and prune attempts older than a day.
create function public.lp_login_finish(p_id bigint, p_ok boolean)
returns void
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
set lock_timeout = '2s'
as $fn$
begin
  if p_id is null or p_ok is null then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:login';
  end if;

  update public.lp_login_attempts set ok = p_ok where id = p_id and ok is null;
  delete from public.lp_login_attempts where at < pg_catalog.clock_timestamp() - interval '1 day';
end
$fn$;

-- lp_stats: everything the dashboard needs (spec §8 + A21). camelCase keys, passed through by the server.
--   open {waiting, inMedical (legacy Bring friend counts as In medical)}; notInMedical, reunited,
--   discharged, cancelled and total over all rows; longestWait; avgAnswerMinutes; byPost; recent.
--   byPost: the 4 fixed posts always (count may be 0), then one entry per other location with open rows
--   (Other grouped by other_location, legacy post values as themselves); the counts sum to open.
--   postShort here must match postShort() in lib/domain.ts.
create function public.lp_stats()
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
set lock_timeout = '2s'
as $fn$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_counts jsonb;
  v_longest jsonb;
  v_avg numeric;
  v_by_post jsonb;
  v_recent jsonb;
begin
  select pg_catalog.jsonb_build_object(
    'open', pg_catalog.jsonb_build_object(
      'waiting', pg_catalog.count(*) filter (where status = 'Added'),
      'inMedical', pg_catalog.count(*) filter (where status in ('Found – Awaiting Reunion', 'Bring friend to medical'))
    ),
    'notInMedical', pg_catalog.count(*) filter (where status = 'Checked – Not Found'),
    'reunited', pg_catalog.count(*) filter (where status = 'Reunited – Closed'),
    'discharged', pg_catalog.count(*) filter (where status = 'Found – Discharged'),
    'cancelled', pg_catalog.count(*) filter (where status = 'Cancelled'),
    'total', pg_catalog.count(*)
  ) into v_counts
  from public.patients;

  select pg_catalog.jsonb_build_object(
    'id', p.id,
    'caseNumber', p.case_number,
    'reportingLocation', p.reporting_location,
    'otherLocation', p.other_location,
    'postShort', case p.reporting_location
                   when 'FA 3 – Kinetic' then 'FA 3'
                   when 'FA 4 – Oasis' then 'FA 4'
                   when 'Other' then coalesce(nullif(pg_catalog.btrim(p.other_location), ''), 'Other')
                   else p.reporting_location
                 end,
    'minutes', greatest(0, pg_catalog.floor(extract(epoch from (v_now - p.created_at)) / 60))::integer
  ) into v_longest
  from public.patients p
  where p.status = 'Added'
  order by p.created_at asc, p.case_number asc
  limit 1;

  -- The first answer per request (out of Added into Not found / In medical, matched on the statuses in
  -- previous_value and new_value so Jeffrey's full-row events count; legacy medical_search not_found and
  -- medical_search_found count as answers too). Average its delay from created_at over answers in the
  -- last 2 hours.
  with answers as (
    select e.patient_id, e.occurred_at
    from public.audit_events e
    where e.patient_id is not null
      and (
        (e.action_type in ('status_changed', 'check_completed')
         and e.previous_value ->> 'status' = 'Added'
         and e.new_value ->> 'status' in ('Checked – Not Found', 'Found – Awaiting Reunion', 'Bring friend to medical'))
        or (e.action_type = 'medical_search' and e.new_value ->> 'outcome' = 'not_found')
        or e.action_type = 'medical_search_found'
      )
  ), first_answer as (
    select distinct on (a.patient_id) a.patient_id, a.occurred_at
    from answers a
    order by a.patient_id, a.occurred_at asc
  )
  select pg_catalog.round((pg_catalog.avg(extract(epoch from (f.occurred_at - p.created_at))) / 60)::numeric, 1)
    into v_avg
  from first_answer f
  join public.patients p on p.id = f.patient_id
  where f.occurred_at > v_now - interval '2 hours';

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'reportingLocation', x.loc, 'otherLocation', x.other, 'postShort', x.short, 'count', x.n)
           order by x.ord, x.n desc, x.short), '[]'::jsonb)
    into v_by_post
  from (
    select l.loc, null::text as other, l.short, l.ord, pg_catalog.count(p.id)::integer as n
    from (values ('FA 3 – Kinetic', 'FA 3', 1), ('FA 4 – Oasis', 'FA 4', 2), ('Command', 'Command', 3),
                 ('Base', 'Base', 4)) as l(loc, short, ord)
    left join public.patients p
      on p.reporting_location = l.loc
     and p.status in ('Added', 'Found – Awaiting Reunion', 'Bring friend to medical')
    group by l.loc, l.short, l.ord
    union all
    -- Every other open row: Other grouped by its location (case-insensitive), and any legacy post value
    -- (e.g. 'FA 3') as itself, so the bars always add up to the Open number.
    select p.reporting_location,
           case when p.reporting_location = 'Other' then pg_catalog.min(pg_catalog.btrim(p.other_location)) end,
           case when p.reporting_location = 'Other'
                then coalesce(nullif(pg_catalog.min(pg_catalog.btrim(p.other_location)), ''), 'Other')
                else p.reporting_location
           end,
           5,
           pg_catalog.count(*)::integer
    from public.patients p
    where p.reporting_location not in ('FA 3 – Kinetic', 'FA 4 – Oasis', 'Command', 'Base')
      and p.status in ('Added', 'Found – Awaiting Reunion', 'Bring friend to medical')
    group by p.reporting_location,
             case when p.reporting_location = 'Other'
                  then pg_catalog.lower(pg_catalog.btrim(coalesce(p.other_location, '')))
             end
  ) as x;

  select coalesce(pg_catalog.jsonb_agg(r.obj order by r.updated_at desc, r.case_number desc), '[]'::jsonb)
    into v_recent
  from (
    select p.updated_at, p.case_number, pg_catalog.jsonb_build_object(
      'id', p.id,
      'caseNumber', p.case_number,
      'name', nullif(pg_catalog.concat_ws(' ', nullif(p.first_name, ''), nullif(p.last_name, '')), ''),
      'status', p.status,
      'postShort', case p.reporting_location
                     when 'FA 3 – Kinetic' then 'FA 3'
                     when 'FA 4 – Oasis' then 'FA 4'
                     when 'Other' then coalesce(nullif(pg_catalog.btrim(p.other_location), ''), 'Other')
                     else p.reporting_location
                   end,
      'updatedAt', p.updated_at
    ) as obj
    from public.patients p
    order by p.updated_at desc, p.case_number desc
    limit 5
  ) as r;

  return v_counts || pg_catalog.jsonb_build_object(
    'longestWait', v_longest,
    'avgAnswerMinutes', v_avg,
    'byPost', v_by_post,
    'recent', v_recent,
    'serverTime', v_now
  );
end
$fn$;

-- lp_detail: the row (lp_row), active photos (oldest first) and audit events (oldest first, raw — the
-- server normalises legacy formats).
create function public.lp_detail(p_id uuid)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
set lock_timeout = '2s'
as $fn$
declare
  v_row public.patients;
  v_photos jsonb;
  v_events jsonb;
begin
  if p_id is null then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;

  select * into v_row from public.patients where id = p_id;
  if v_row.id is null then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'id', ph.id, 'photo_timing', ph.photo_timing, 'uploaded_by', ph.uploaded_by,
           'created_at', ph.created_at, 'has_thumb', ph.thumb_path is not null)
           order by ph.created_at, ph.id), '[]'::jsonb)
    into v_photos
  from public.patient_photos ph
  where ph.patient_id = p_id and ph.is_active;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'id', e.id, 'action_type', e.action_type, 'staff_name', e.staff_name,
           'previous_value', e.previous_value, 'new_value', e.new_value, 'notes', e.notes,
           'occurred_at', e.occurred_at)
           order by e.occurred_at, e.id), '[]'::jsonb)
    into v_events
  from public.audit_events e
  where e.patient_id = p_id;

  return pg_catalog.jsonb_build_object('row', public.lp_row(v_row), 'photos', v_photos, 'events', v_events);
end
$fn$;

-- -----------------------------------------------------------------------------------------------------
-- Function privileges: nobody but service_role.
-- -----------------------------------------------------------------------------------------------------
revoke all on function public.lp_touch() from public, anon, authenticated;
revoke all on function public.lp_canon_staff(text) from public, anon, authenticated;
revoke all on function public.lp_row(public.patients) from public, anon, authenticated;
revoke all on function public.lp_require_staff(text) from public, anon, authenticated;
revoke all on function public.lp_clean_fields(jsonb, boolean) from public, anon, authenticated;
revoke all on function public.lp_sync(timestamptz, uuid[], boolean, timestamptz, uuid, integer) from public, anon, authenticated;
revoke all on function public.lp_create_request(jsonb, text) from public, anon, authenticated;
revoke all on function public.lp_set_status(uuid, bigint, text, text, text) from public, anon, authenticated;
revoke all on function public.lp_update_fields(uuid, jsonb, bigint, text) from public, anon, authenticated;
revoke all on function public.lp_cancel(uuid, bigint, text) from public, anon, authenticated;
revoke all on function public.lp_add_photo(uuid, uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.lp_login_begin(text, text) from public, anon, authenticated;
revoke all on function public.lp_login_finish(bigint, boolean) from public, anon, authenticated;
revoke all on function public.lp_stats() from public, anon, authenticated;
revoke all on function public.lp_detail(uuid) from public, anon, authenticated;

grant execute on function public.lp_canon_staff(text) to service_role;
grant execute on function public.lp_row(public.patients) to service_role;
grant execute on function public.lp_require_staff(text) to service_role;
grant execute on function public.lp_clean_fields(jsonb, boolean) to service_role;
grant execute on function public.lp_sync(timestamptz, uuid[], boolean, timestamptz, uuid, integer) to service_role;
grant execute on function public.lp_create_request(jsonb, text) to service_role;
grant execute on function public.lp_set_status(uuid, bigint, text, text, text) to service_role;
grant execute on function public.lp_update_fields(uuid, jsonb, bigint, text) to service_role;
grant execute on function public.lp_cancel(uuid, bigint, text) to service_role;
grant execute on function public.lp_add_photo(uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.lp_login_begin(text, text) to service_role;
grant execute on function public.lp_login_finish(bigint, boolean) to service_role;
grant execute on function public.lp_stats() to service_role;
grant execute on function public.lp_detail(uuid) to service_role;

notify pgrst, 'reload schema';

commit;
