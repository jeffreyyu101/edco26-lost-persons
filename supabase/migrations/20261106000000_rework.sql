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
-- What it does (no existing column or constraint is altered, except the NOT VALID re-add in step 2 and
-- the age conversion in step 1b):
--   0. Preflight: the production tables and the client_mutation_id unique key must exist.
--   1. patients.row_version (optimistic concurrency and sync) and patients.last_seen (if missing).
--   1b. patients.age becomes free text ("mid-20s"), only while it is not text yet: its CHECK is dropped and
--      every value is kept as its text (24 → '24').
--   1c. patients.medical_location (nullable text): where medical has the patient ("Chair 14"). Additive.
--   1d. patients.recheck_at (nullable) and patients.not_found_checks (smallint, default 0): the "Not found
--      yet" hold. Additive.
--   2. Replaces the reporting_location / status CHECK only when it lacks a needed value (or a value rows
--      already hold), NOT VALID. Values already in the table stay allowed, so legacy rows stay editable.
--   3. lp_touch() BEFORE UPDATE trigger: updated_at = clock_timestamp(), row_version + 1.
--   4. patient_photos.thumb_path.
--   5. lp_login_attempts (sign-in rate limiting), RLS on, no policies.
--   6. The lp_* functions the app calls. Only service_role may execute them.
--   7. Messages and en route (2026-11-06 evening): lp_messages, lp_message_reads, lp_enroute, their
--      functions and the trigger that clears en route when a request leaves In medical. Additive.
--   8. Web Push and the Activity inbox (F4): lp_push_prefs, lp_push_subscriptions, lp_activity and the
--      lp_push_* / lp_activity_* functions. Additive.
--   9. Inactivity auto-close (F6): the status 'Closed – Inactive' (allowed by step 2), lp_inactive_minutes(),
--      lp_inactive_closes, lp_close_inactive(), lp_inactive_claim(), and the pg_cron job 'lp-close-inactive'
--      every 5 minutes (enabled and scheduled only where pg_cron can run; a NOTICE says which). Additive.
--      Pause the job with: select cron.unschedule('lp-close-inactive');
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
-- 1b. Age is free text (Jeffrey, 2026-11-06 10:31: "for age, they can put mid-20s, not just numbers").
--     Runs only while patients.age is not text (Jeffrey's baseline: smallint with a 0–120 CHECK), so a
--     re-run changes nothing. Every CHECK that reads age is dropped first (`age between 0 and 120` cannot
--     apply to text), then USING age::text keeps every value (24 → '24', null stays null). The rewrite
--     holds an ACCESS EXCLUSIVE lock only while it runs (bounded by the timeouts above). The app's schema
--     has no index, view or default on age; if one existed, the ALTER would fail and the whole file roll
--     back (the dry run shows it). The lp_* functions are recreated against the new row type in step 6.
--     Paste this BEFORE deploying an app that sends text ages: the previous lp_clean_fields refuses them,
--     while the previous app keeps working on this one (it sends numbers, stored as text).
-- -----------------------------------------------------------------------------------------------------
do $age$
declare
  v_type text;
  v_con name;
  v_dropped text[] := '{}';
begin
  select pg_catalog.format_type(a.atttypid, a.atttypmod) into v_type
  from pg_catalog.pg_attribute a
  where a.attrelid = 'public.patients'::regclass and a.attname = 'age' and not a.attisdropped;

  if v_type = 'text' then
    raise notice 'patients.age: already text, unchanged.';
    return;
  end if;

  for v_con in
    select c.conname
    from pg_catalog.pg_constraint c
    join pg_catalog.pg_attribute a
      on a.attrelid = c.conrelid and a.attname = 'age' and not a.attisdropped
    where c.conrelid = 'public.patients'::regclass and c.contype = 'c' and a.attnum = any (c.conkey)
    order by c.conname
  loop
    execute pg_catalog.format('alter table public.patients drop constraint %I', v_con);
    v_dropped := v_dropped || v_con::text;
  end loop;

  alter table public.patients alter column age type text using age::text;

  raise notice 'patients.age: % → text, every value kept. CHECKs dropped: %',
    v_type, coalesce(nullif(pg_catalog.array_to_string(v_dropped, ', '), ''), 'none');
end
$age$;

-- -----------------------------------------------------------------------------------------------------
-- 1c. Where medical has the patient (Dani + Brian, 2026-11-06 afternoon): an optional free-text location
--     ("Chair 14", "Bed 3 · triage"), at most 60 characters, set through lp_update_fields like any other
--     field and audited the same way. It stays until someone edits it (no status change clears it).
--     Additive and safe while the build that is live now serves: a nullable column with no default needs no
--     table rewrite, the previous build never writes it, and its server maps lp_row through an allowlist,
--     so the extra key is ignored. A re-run keeps every value (add column if not exists).
-- -----------------------------------------------------------------------------------------------------
alter table public.patients add column if not exists medical_location text;

-- -----------------------------------------------------------------------------------------------------
-- 1d. The "Not found yet" hold (F5, Brian 2026-11-06 evening; design/screens/updates.html #recheck). The first
--     Not found on a request that is Waiting for check keeps it open: the status STAYS 'Added' (so a build
--     from before this keeps it in its queue), recheck_at = now() + lp_stages_recheck_minutes() and
--     not_found_checks = 1. A Not found on a held request is the final 'Checked – Not Found' (closed). A due
--     hold is never closed by itself: it waits for someone to answer. Additive and safe while the live build
--     serves: a nullable column, and a NOT NULL column with a constant default (no table rewrite on
--     PostgreSQL 11+); the live build never writes them and its server maps lp_row through an allowlist. A
--     re-run keeps every value (add column if not exists).
-- -----------------------------------------------------------------------------------------------------
alter table public.patients add column if not exists recheck_at timestamptz;
alter table public.patients add column if not exists not_found_checks smallint not null default 0;

-- -----------------------------------------------------------------------------------------------------
-- 2. Locations and statuses (in case 20261105_update_locations_and_statuses never ran in production).
--    A CHECK is replaced only when its current definition lacks one of the needed values (spec §4), or a
--    value that rows already hold. The new CHECK allows the needed values PLUS every value already in the
--    table: NOT VALID only skips re-checking existing rows once, but Postgres checks every later UPDATE of
--    a row, and every lp_* write is an UPDATE (status, updated_by, ...). Without the extra values a legacy
--    row (e.g. reporting_location 'FA 3' or status 'Found – Transported') could never be answered, edited
--    or given a photo again. New non-canonical values are still refused: lp_clean_fields only accepts the
--    five posts and lp_set_status only the settable statuses. A NOTICE names the extra values kept.
--    (F6) 'Closed – Inactive' is needed too (only lp_close_inactive, section 9, writes it): on a database from
--    before F6 the CHECK lacks it, so the first run of this file replaces the CHECK once (NOT VALID, as above).
-- -----------------------------------------------------------------------------------------------------
do $checks$
declare
  v_locations constant text[] := array['FA 3 – Kinetic', 'FA 4 – Oasis', 'Command', 'Base', 'Other'];
  v_statuses constant text[] := array['Added', 'Checked – Not Found', 'Found – Awaiting Reunion', 'Reunited – Closed',
                                      'Found – Discharged', 'Bring friend to medical', 'Cancelled', 'Closed – Inactive'];
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
-- lp_stats is not dropped: it is `create or replace`d below (same signature and return type since the first
-- production run), so a re-run never removes it, and its grants carry over.
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
    'photo_count', v_count,
    'medical_location', p.medical_location
  ) || pg_catalog.jsonb_build_object(
    -- (F5) The "Not found yet" hold (step 1d): when the recheck is due, and how many Not found answers.
    'recheck_at', p.recheck_at,
    'not_found_checks', p.not_found_checks
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
--   * age and gender are free text (Jeffrey, 2026-11-06 10:31): "mid-20s", "24", "Non-binary", ≤40
--     characters each. age also takes a JSON number (a request queued by an older client), stored as its
--     text (24 → '24').
--   * Length limits per spec §4. reporting_location, when present, must be a valid post (never null).
--   * medical_location (2026-11-06 afternoon) is trimmed, ≤60 characters. Only lp_update_fields stores it.
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
      when 'age' then 40
      when 'gender' then 40
      when 'reporting_location' then 40
      when 'medical_location' then 60
      else null
    end;

    if v_limit is null then
      raise exception using errcode = 'P0422', message = 'unknown_field',
        detail = pg_catalog.format('field:%s', pg_catalog.left(v_key, 60));
    end if;

    if pg_catalog.jsonb_typeof(v_val) = 'null' then
      v_text := null;
    elsif pg_catalog.jsonb_typeof(v_val) = 'string' then
      v_text := v_val #>> '{}';
      if pg_catalog.btrim(v_text, E' \t\r\n') = '' then
        v_text := null;
      end if;
    elsif v_key = 'age' and pg_catalog.jsonb_typeof(v_val) = 'number' then
      v_text := v_val #>> '{}';
    else
      raise exception using errcode = 'P0422', message = 'invalid_field', detail = pg_catalog.format('field:%s', v_key);
    end if;

    if v_key = 'medical_location' and v_text is not null then
      v_text := pg_catalog.btrim(v_text, E' \t\r\n');
    end if;

    if v_text is not null and pg_catalog.char_length(v_text) > v_limit then
      raise exception using errcode = 'P0422', message = 'field_too_long', detail = pg_catalog.format('field:%s', v_key);
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

  -- 2. Validate. A new request has no medical location yet (it is set once medical has the patient).
  if p ? 'medical_location' then
    raise exception using errcode = 'P0422', message = 'unknown_field', detail = 'field:medical_location';
  end if;
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

-- (F5) How long a "Not found yet" hold lasts before medical looks again: ONE constant for SQL and TypeScript
-- (RECHECK_MINUTES in lib/domain.ts; a unit test compares them). Immutable, no timeouts.
create or replace function public.lp_stages_recheck_minutes()
returns integer
language sql
immutable
security invoker
set search_path = public, pg_temp
as $fn$
  select 20
$fn$;

-- lp_set_status: the only way a status changes (except cancel).
--   Locks the row. Already at p_status → {changed: false, row}, no audit (two liaisons, same answer),
--   for any current status including legacy ones; only then is p_status checked against the §4 values.
--   Version mismatch → P0409 (HINT = current status). Illegal transition → P0422.
--   Cancelled → Added is creator-only → P0403.
--   found_at: set on the first entry into Found – Awaiting Reunion; never overwritten or cleared.
--   reunion_started_at: now() on every entry into Found – Awaiting Reunion; cleared on → Added / Not found.
--   closed_at: now() on entry into Reunited / Discharged / Cancelled; cleared on any other target.
--
--   (F5) The "Not found yet" hold (step 1d). The transitions are unchanged; what Not found STORES depends on
--   the request:
--   * Waiting for check with not_found_checks = 0 (and not an Undo) → the HOLD: the status stays 'Added',
--     recheck_at = now() + lp_stages_recheck_minutes(), not_found_checks = 1, audit status_changed
--     {status: 'Added', kind, held: true, answer: 'not_found', recheck_at, not_found_checks, row_version}. A
--     build from before this calls the same function with the same arguments and gets the hold too: the row
--     it gets back is still Waiting for check, so it keeps the request in its queue.
--   * Any other Not found (a held request, due or not; Change answer from In medical) → the final
--     'Checked – Not Found', recheck_at = null, not_found_checks + 1 (2 after a hold).
--   * In medical clears recheck_at (any time). Back to Waiting for check (kind change) and Reopen clear both.
--   * Undo restores the hold fields the undone change replaced (the previous_value of the latest
--     status_changed, when that is the change being undone): Undo of the first Not found clears the hold
--     (counter back to 0); Undo of the final Not found, or of In medical on a held request, puts the hold
--     back. Undo of a cancel keeps them (lp_cancel never touches them).
--   * Waiting for check → Waiting for check on a held request (Undo, or Back to Waiting) is a real change.
--   * A Not found sent with the version from just before a hold, when that hold is the last write (two
--     liaisons tapped Not found at once), is the idempotent repeat: {changed: false}, no audit. Without it
--     the second phone's 409 retry would close the request at once.
--   * A due hold never closes by itself: nothing here (or anywhere) runs on a timer.
--
--   (F6) 'Closed – Inactive' is never a target here: only lp_close_inactive (section 9, on a timer) writes it, and
--   only for a request In medical. From it the one move is Reopen → 'Found – Awaiting Reunion' (kind 'reopen'),
--   for any staff, like a Reopen of Reunited: found_at stays, reunion_started_at restarts, closed_at clears. A
--   Reopen has no Undo (the app's convention), so nothing here moves a request back to 'Closed – Inactive'.
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
  v_held boolean;
  v_last jsonb;
  v_last_to text;
  v_recheck timestamptz;
  v_checks integer;
begin
  perform public.lp_require_staff(p_staff);

  if p_id is null then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;
  if p_expected_version is null then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:expected_version';
  end if;
  if p_status is null then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:status';
  end if;
  if p_kind is null or p_kind not in ('answer', 'change', 'reunite', 'discharge', 'undo', 'reopen') then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:kind';
  end if;

  select * into v_row from public.patients where id = p_id for update;
  if v_row.id is null then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;

  v_held := v_row.status = 'Added' and (v_row.recheck_at is not null or v_row.not_found_checks <> 0);

  -- Idempotent repeat (spec §4), checked BEFORE the target whitelist so it holds for every status the
  -- row can be in, legacy ones included ('Bring friend to medical' → 'Bring friend to medical' is
  -- {changed: false}, not invalid_field). Nothing is written, so no non-canonical value can get in.
  -- (F5) Waiting for check → Waiting for check on a held request clears or restores the hold below.
  if v_row.status = p_status and not (p_status = 'Added' and v_held) then
    return pg_catalog.jsonb_build_object('changed', false, 'row', public.lp_row(v_row));
  end if;

  -- (F5) Two liaisons, the same first Not found at once: the hold is already the last write.
  if p_status = 'Checked – Not Found' and p_kind = 'answer' and v_row.status = 'Added'
     and v_row.recheck_at is not null and p_expected_version = v_row.row_version - 1
     and exists (
       select 1 from public.audit_events e
       where e.patient_id = p_id and e.action_type = 'status_changed'
         and e.new_value ->> 'held' = 'true'
         and e.new_value ->> 'row_version' = v_row.row_version::text
     ) then
    return pg_catalog.jsonb_build_object('changed', false, 'row', public.lp_row(v_row));
  end if;

  -- New writes stay canonical (A30): only the §4 statuses are valid targets.
  if p_status not in ('Added', 'Checked – Not Found', 'Found – Awaiting Reunion',
                      'Reunited – Closed', 'Found – Discharged', 'Cancelled') then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:status';
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
    when 'Closed – Inactive' then p_status in ('Found – Awaiting Reunion')
    -- TRANSITIONS:END
    else false
  end;
  -- (F5) Waiting for check → Waiting for check is allowed only to clear or restore a hold (see above).
  if v_row.status = 'Added' and p_status = 'Added' and v_held then
    v_allowed := p_kind in ('undo', 'change');
  end if;
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
  ) || pg_catalog.jsonb_build_object(
    'recheck_at', v_row.recheck_at,
    'not_found_checks', v_row.not_found_checks
  );

  -- (F5) The first Not found on a request Waiting for check: the hold. The status stays 'Added'.
  if p_status = 'Checked – Not Found' and v_row.status = 'Added' and v_row.not_found_checks = 0 and p_kind <> 'undo' then
    update public.patients
       set recheck_at = now() + pg_catalog.make_interval(mins => public.lp_stages_recheck_minutes()),
           not_found_checks = 1,
           updated_by = p_staff
     where id = p_id
    returning * into v_row;

    insert into public.audit_events (patient_id, staff_name, action_type, previous_value, new_value)
    values (p_id, p_staff, 'status_changed', v_prev,
            pg_catalog.jsonb_build_object('status', 'Added', 'kind', p_kind, 'held', true, 'answer', 'not_found')
            || pg_catalog.jsonb_build_object('recheck_at', v_row.recheck_at, 'not_found_checks', v_row.not_found_checks,
                                             'row_version', v_row.row_version));

    return pg_catalog.jsonb_build_object('changed', true, 'row', public.lp_row(v_row));
  end if;

  -- (F5) The hold fields after the change.
  v_recheck := v_row.recheck_at;
  v_checks := v_row.not_found_checks;
  if p_status = 'Added' then
    -- Back to Waiting for check and Reopen start afresh; an Undo of a cancel keeps them (cancel left them).
    if not (p_kind = 'undo' and v_row.status = 'Cancelled') then
      v_recheck := null;
      v_checks := 0;
    end if;
  elsif p_status = 'Checked – Not Found' then
    -- The final answer.
    v_recheck := null;
    v_checks := least(v_row.not_found_checks + 1, 99);
  elsif p_status = 'Found – Awaiting Reunion' then
    v_recheck := null;
  end if;
  -- Undo puts back what the undone change replaced, when the latest status change is that change.
  if p_kind = 'undo' and v_row.status <> 'Cancelled' then
    select e.previous_value, e.new_value ->> 'status' into v_last, v_last_to
    from public.audit_events e
    where e.patient_id = p_id and e.action_type = 'status_changed'
    order by e.occurred_at desc, e.id desc
    limit 1;
    if v_last ->> 'status' = p_status and v_last_to = v_row.status then
      v_recheck := (v_last ->> 'recheck_at')::timestamptz;
      v_checks := coalesce((v_last ->> 'not_found_checks')::integer, 0);
    end if;
  end if;

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
           recheck_at = v_recheck,
           not_found_checks = v_checks,
           updated_by = p_staff
     where id = p_id
    returning * into v_row;
  exception when check_violation then
    raise exception using errcode = 'P0422', message = 'rejected_by_constraint';
  end;

  insert into public.audit_events (patient_id, staff_name, action_type, previous_value, new_value)
  values (p_id, p_staff, 'status_changed', v_prev,
          pg_catalog.jsonb_build_object('status', p_status, 'kind', p_kind)
          || pg_catalog.jsonb_build_object('recheck_at', v_row.recheck_at, 'not_found_checks', v_row.not_found_checks));

  return pg_catalog.jsonb_build_object('changed', true, 'row', public.lp_row(v_row));
end
$fn$;

-- lp_update_fields: edit details. Only whitelisted keys; never status, identity or system fields.
--   p_patch: snake_case keys as in lp_create_request (minus client_mutation_id), plus medical_location
--   (where medical has the patient); a name change sends both first_name and last_name. Omitted =
--   unchanged, null = clear.
--   Version mismatch → P0409. Unchanged keys are skipped; nothing changed → {changed: false, row}, no audit.
--   Field rules apply to the keys sent; the post rule applies to the merged row (Other needs
--   other_location; any other post clears it). Audit patient_updated with the changed keys, except that
--   a merged display field is recorded whole (spec A35): a change to either half of the name records
--   first_name AND last_name, and a change to either half of the post records reporting_location AND
--   other_location, the unchanged half included, so each audit row can show "Name" / "Post" on its own.
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

  -- Merged display fields are audited whole (spec A35, a recorded exception to "only the changed keys"):
  -- a name change records both first_name and last_name, a post change records both reporting_location
  -- and other_location, so the trail can show "Name" / "Post" from this row alone (an other_location-only
  -- edit would otherwise have no post to show). The unchanged half is the same in previous and new.
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
           medical_location = v_merged.medical_location,
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

-- lp_stats: everything the dashboard needs (spec §8 + A21 + A49). camelCase keys, passed through by the server.
--   (F5) A request on a "Not found yet" hold is still 'Added': it counts as open.waiting, never as
--   notInMedical (only the final Not found does); its first Not found counts as its first answer.
--   (F6) inactive: requests 'Closed – Inactive' now (closed, in total; the dashboard adds it to Closed). An
--   inactive close is never a reunion: reunited counts 'Reunited – Closed' only, and Time to reunite reads
--   status_changed rows into 'Reunited – Closed' of requests that are Reunited now.
--   open {waiting, inMedical (legacy Bring friend counts as In medical)}; notInMedical, reunited,
--   discharged, cancelled and total over all rows; loggedLastHour (rows created in the last 60 minutes,
--   any status); longestWait; avgAnswerMinutes; avgReuniteMinutes; byPost; recent.
--   byPost: the 4 fixed posts always (count may be 0), then one entry per other location with open rows
--   (Other grouped by other_location, legacy post values as themselves); the counts sum to open.
--   postShort here must match postShort() in lib/domain.ts.
--   STABLE (read-only): every statement below reads the same snapshot, so open, byPost, longestWait and
--   recent always agree with each other even while requests change. A VOLATILE function would take a new
--   snapshot per statement.
--   create or replace (not drop + create): re-running this file on a database that already has lp_stats()
--   replaces it in place, inside the one transaction.
create or replace function public.lp_stats()
returns jsonb
language plpgsql
stable
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
  v_avg_reunite numeric;
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
    'inactive', pg_catalog.count(*) filter (where status = 'Closed – Inactive'),
    'total', pg_catalog.count(*),
    'loggedLastHour', pg_catalog.count(*) filter (where created_at > v_now - interval '60 minutes')
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
    -- (F5) A request on a "Not found yet" hold is not waiting for medical until its recheck is due.
    and (p.recheck_at is null or p.recheck_at <= v_now)
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
        -- (F5) The first Not found that put the request on hold (its status stayed 'Added') is an answer.
        or (e.action_type = 'status_changed' and e.new_value ->> 'held' = 'true')
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

  -- Time to reunite (A49). One reunion per request: a request that is Reunited now, at its latest
  -- status_changed into Reunited – Closed, when that happened in the last 2 hours. It is measured from the
  -- latest In medical answer before it: a status_changed out of Added or Checked – Not Found into Found –
  -- Awaiting Reunion or legacy Bring friend to medical (so Change answer restarts the clock, while an Undo
  -- of Reunited or a Reopen, which leave a closed status, do not), or a legacy medical_search_found. A
  -- reunion with no such answer before it is left out. Mean in minutes, 1 decimal; null when there is none.
  with reunions as (
    select distinct on (e.patient_id) e.patient_id, e.occurred_at
    from public.audit_events e
    join public.patients p on p.id = e.patient_id
    where e.action_type = 'status_changed'
      and e.new_value ->> 'status' = 'Reunited – Closed'
      and p.status = 'Reunited – Closed'
      and e.occurred_at > v_now - interval '2 hours'
    order by e.patient_id, e.occurred_at desc
  )
  select pg_catalog.round((pg_catalog.avg(extract(epoch from (r.occurred_at - a.occurred_at))) / 60)::numeric, 1)
    into v_avg_reunite
  from reunions r
  cross join lateral (
    select e.occurred_at
    from public.audit_events e
    where e.patient_id = r.patient_id
      and e.occurred_at <= r.occurred_at
      and (
        (e.action_type = 'status_changed'
         and e.previous_value ->> 'status' in ('Added', 'Checked – Not Found')
         and e.new_value ->> 'status' in ('Found – Awaiting Reunion', 'Bring friend to medical'))
        or e.action_type = 'medical_search_found'
      )
    order by e.occurred_at desc
    limit 1
  ) as a;

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
    'avgReuniteMinutes', v_avg_reunite,
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
revoke all on function public.lp_stages_recheck_minutes() from public, anon, authenticated;
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
grant execute on function public.lp_stages_recheck_minutes() to service_role;
grant execute on function public.lp_set_status(uuid, bigint, text, text, text) to service_role;
grant execute on function public.lp_update_fields(uuid, jsonb, bigint, text) to service_role;
grant execute on function public.lp_cancel(uuid, bigint, text) to service_role;
grant execute on function public.lp_add_photo(uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.lp_login_begin(text, text) to service_role;
grant execute on function public.lp_login_finish(bigint, boolean) to service_role;
grant execute on function public.lp_stats() to service_role;
grant execute on function public.lp_detail(uuid) to service_role;

-- -----------------------------------------------------------------------------------------------------
-- 7. Messages and en route (F3, 2026-11-06 evening; spec §21 A74-A81, design/DECISIONS.md "Messages and en
--    route"). Additive only: three new tables, two indexes on existing tables (one partial), an AFTER UPDATE
--    OF status trigger on patients and new functions. No existing column, constraint or function changes, so
--    the build that is live now keeps working on a migrated database (it never calls them; the trigger only
--    deletes en route rows, which only this build writes).
--
--    lp_messages       one row per message; never deleted (an unsend sets unsent_at, kept for the audit and the
--                      export). Idempotent on client_mutation_id (a queued send retried from a phone).
--    lp_message_reads  one read cursor per (request, staff): unread = other people's messages after it.
--                      last_read_at = the newest message the reader has seen; read_at = when they saw it (the
--                      "Read 4:14 PM" receipt).
--    lp_enroute        who is walking the friend to medical: one row per (request, staff), 'enroute' or
--                      'arrived', with an optional absolute ETA. Cleared (same transaction) by any status change
--                      out of In medical: Not in medical, Back to Waiting, Reunited, Discharged, Cancelled.
--
--    Staff are keyed by lp_canon_staff(attribution), stored at write time (staff_key / staff): no index,
--    default or constraint may depend on lp_canon_staff, because section 6 drops and recreates it.
--    Every write goes through one function and writes its audit_events row in the same transaction
--    (message_posted, message_unsent, enroute). Reads are not audited (they change nothing in the record).
--    Every name below starts with lp_messages / lp_enroute, except the tables and functions the F3/F4/F5
--    contract names (lp_messages, lp_message_reads, lp_enroute, lp_post_message, lp_mark_read,
--    lp_set_enroute, lp_unsend_message, lp_involved_staff).
-- -----------------------------------------------------------------------------------------------------

create table if not exists public.lp_messages (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.patients (id) on delete cascade,
  -- The attribution string "Name · Team" from the session (display), and its canonical form (comparisons).
  staff text not null,
  staff_key text not null,
  -- The session's canonical team: 'Medical' marks a medical-side message (Needs info).
  team text not null default '',
  body text not null,
  created_at timestamptz not null default clock_timestamp(),
  unsent_at timestamptz,
  client_mutation_id uuid not null,
  constraint lp_messages_client_mutation_id_key unique (client_mutation_id),
  constraint lp_messages_body_check check (char_length(body) between 1 and 500)
);
create index if not exists lp_messages_request_idx on public.lp_messages (request_id, created_at desc, id desc);
create index if not exists lp_messages_created_at_idx on public.lp_messages (created_at);
create index if not exists lp_messages_unsent_at_idx on public.lp_messages (unsent_at) where unsent_at is not null;
create index if not exists lp_messages_staff_idx on public.lp_messages (staff_key, created_at);

create table if not exists public.lp_message_reads (
  request_id uuid not null references public.patients (id) on delete cascade,
  -- Canonical staff (lp_canon_staff).
  staff text not null,
  last_read_at timestamptz not null,
  read_at timestamptz not null default clock_timestamp(),
  primary key (request_id, staff)
);
create index if not exists lp_message_reads_staff_idx on public.lp_message_reads (staff, read_at);

create table if not exists public.lp_enroute (
  request_id uuid not null references public.patients (id) on delete cascade,
  -- Canonical staff (lp_canon_staff), and the attribution string for the export.
  staff text not null,
  staff_name text not null,
  eta_at timestamptz,
  -- The ETA pill chosen (0 = Now, 5, 10, 15), so the edit sheet shows it selected. Null = no ETA.
  eta_minutes smallint,
  state text not null,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (request_id, staff),
  constraint lp_enroute_state_check check (state in ('enroute', 'arrived')),
  constraint lp_enroute_eta_minutes_check check (eta_minutes is null or eta_minutes between 0 and 60)
);

-- Message and en route events are read back from the audit trail (sync deltas, the export, Time to arrive).
create index if not exists lp_messages_audit_at_idx on public.audit_events (occurred_at)
  where action_type in ('message_posted', 'message_unsent', 'enroute');

alter table public.lp_messages enable row level security;
alter table public.lp_message_reads enable row level security;
alter table public.lp_enroute enable row level security;
revoke all on table public.lp_messages, public.lp_message_reads, public.lp_enroute from anon, authenticated;
grant select, insert, update on table public.lp_messages to service_role;
grant select, insert, update, delete on table public.lp_message_reads to service_role;
grant select, insert, update, delete on table public.lp_enroute to service_role;

-- A status change out of In medical clears every en route on the request, in the same transaction, with one
-- audit row ('enroute' / cleared) attributed to whoever changed the status (updated_by); the rows it cleared
-- are kept in that audit row (previous_value.rows). No notification of its own: the status change's
-- notification reaches en-route staff through lp_involved_staff.
-- Back to In medical within 30 seconds of the change that cleared them (an Undo of Reunited / Not in
-- medical / Discharged, or a mis-tap put right at once), from the status they were cleared to, with no en
-- route event since: the cleared rows come back as they were (audit 'enroute' / restored). Later than that
-- (a reopen), the request starts with nobody en route. The trigger cannot see the change's kind (lp_set_status
-- writes it after the update), hence the window: the Undo bar shows for 10 s, plus time on the network.
-- create or replace (never drop): the trigger depends on it.
create or replace function public.lp_enroute_on_status()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_n integer;
  v_rows jsonb;
begin
  if new.status in ('Found – Awaiting Reunion', 'Bring friend to medical') then
    select a.previous_value -> 'rows' into v_rows
      from public.audit_events a
     where a.patient_id = new.id
       and a.action_type = 'enroute'
       and a.new_value ->> 'state' = 'cleared'
       and a.new_value ->> 'status' = old.status
       and a.occurred_at > pg_catalog.clock_timestamp() - interval '30 seconds'
       and not exists (
         select 1 from public.audit_events b
          where b.patient_id = new.id and b.action_type = 'enroute' and b.occurred_at > a.occurred_at
       )
     order by a.occurred_at desc
     limit 1;
    if v_rows is not null and pg_catalog.jsonb_typeof(v_rows) = 'array'
       and not exists (select 1 from public.lp_enroute e where e.request_id = new.id) then
      with back as (
        insert into public.lp_enroute as e (request_id, staff, staff_name, eta_at, eta_minutes, state, updated_at)
        select new.id, r.staff, coalesce(r.staff_name, r.staff), r.eta_at, r.eta_minutes, r.state, coalesce(r.updated_at, pg_catalog.clock_timestamp())
          from pg_catalog.jsonb_to_recordset(v_rows)
               as r(staff text, staff_name text, eta_at timestamptz, eta_minutes smallint, state text, updated_at timestamptz)
         where r.staff is not null and r.state in ('enroute', 'arrived')
           and (r.eta_minutes is null or r.eta_minutes between 0 and 60)
        on conflict (request_id, staff) do nothing
        returning 1
      )
      select pg_catalog.count(*)::integer into v_n from back;
      if v_n > 0 then
        insert into public.audit_events (patient_id, staff_name, action_type, previous_value, new_value, occurred_at)
        values (new.id, new.updated_by, 'enroute', null,
                pg_catalog.jsonb_build_object('state', 'restored', 'status', new.status, 'count', v_n), pg_catalog.clock_timestamp());
      end if;
    end if;
    return null;
  end if;
  with gone as (
    delete from public.lp_enroute e where e.request_id = new.id returning e.*
  )
  select pg_catalog.count(*)::integer,
         coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'staff', g.staff, 'staff_name', g.staff_name, 'eta_at', g.eta_at, 'eta_minutes', g.eta_minutes,
           'state', g.state, 'updated_at', g.updated_at)), '[]'::jsonb)
    into v_n, v_rows
  from gone g;
  if v_n > 0 then
    insert into public.audit_events (patient_id, staff_name, action_type, previous_value, new_value, occurred_at)
    values (new.id, new.updated_by, 'enroute', pg_catalog.jsonb_build_object('count', v_n, 'rows', v_rows),
            pg_catalog.jsonb_build_object('state', 'cleared', 'status', new.status), pg_catalog.clock_timestamp());
  end if;
  return null;
end
$fn$;

create or replace trigger lp_enroute_clear
  after update of status on public.patients
  for each row
  when (old.status is distinct from new.status)
  execute function public.lp_enroute_on_status();

drop function if exists public.lp_messages_json(public.lp_messages, text);
drop function if exists public.lp_enroute_summary(uuid, text);
drop function if exists public.lp_involved_staff(uuid);
drop function if exists public.lp_messages_activity(uuid, text, text);
drop function if exists public.lp_post_message(uuid, text, uuid, text, text);
drop function if exists public.lp_unsend_message(uuid, uuid, text);
drop function if exists public.lp_mark_read(uuid, text, timestamptz);
drop function if exists public.lp_set_enroute(uuid, text, integer, timestamptz, integer, text);
drop function if exists public.lp_messages_thread(uuid, text, timestamptz, uuid, integer);
drop function if exists public.lp_messages_sync(text, uuid[], timestamptz, boolean);
drop function if exists public.lp_enroute_stats();

-- lp_messages_json: one message as the API returns it (snake_case), `mine` for the caller. Internal helper.
create function public.lp_messages_json(m public.lp_messages, p_key text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $fn$
begin
  return pg_catalog.jsonb_build_object(
    'id', m.id,
    'request_id', m.request_id,
    'staff', m.staff,
    'team', m.team,
    'body', m.body,
    'created_at', m.created_at,
    'unsent_at', m.unsent_at,
    'client_mutation_id', m.client_mutation_id,
    'mine', m.staff_key = p_key
  );
end
$fn$;

-- lp_enroute_summary: the request's en route state for the caller, or null when nobody is en route: how many
-- are en route, the earliest ETA, 'arrived' once anyone arrived (it wins: the friend is there), and the
-- caller's own row. Internal helper.
create function public.lp_enroute_summary(p_request uuid, p_key text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_rows integer;
  v_count integer;
  v_eta timestamptz;
  v_arrived boolean;
  v_mine public.lp_enroute;
begin
  select pg_catalog.count(*)::integer,
         pg_catalog.count(*) filter (where e.state = 'enroute')::integer,
         pg_catalog.min(e.eta_at) filter (where e.state = 'enroute'),
         coalesce(pg_catalog.bool_or(e.state = 'arrived'), false)
    into v_rows, v_count, v_eta, v_arrived
  from public.lp_enroute e
  where e.request_id = p_request;

  if v_rows = 0 then
    return null;
  end if;

  select * into v_mine from public.lp_enroute e where e.request_id = p_request and e.staff = p_key;

  return pg_catalog.jsonb_build_object(
    'count', v_count,
    'earliest_eta', v_eta,
    'state', case when v_arrived then 'arrived' else 'enroute' end,
    'mine', case
      when v_mine.request_id is null then null
      else pg_catalog.jsonb_build_object('eta_at', v_mine.eta_at, 'eta_minutes', v_mine.eta_minutes, 'state', v_mine.state)
    end
  );
end
$fn$;

-- lp_involved_staff (contract C): everyone a change to this request concerns (canonical staff, distinct): the
-- logger, whoever answered In medical / Not in medical (legacy answers too), whoever gave the first Not found
-- that put it on a "Not found yet" hold (F5: the status stays 'Added' and the audit row says answer
-- 'not_found'; added by the F3 + F4 release), whoever set the location, everyone who messaged, everyone who was
-- ever en route on it (from the audit trail, so it still holds after a status change cleared them) and anyone
-- en route now. F4's notifications call it right after a change.
create function public.lp_involved_staff(p_request uuid)
returns setof text
language plpgsql
stable
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
set lock_timeout = '2s'
as $fn$
begin
  return query
  select distinct x.s
  from (
    select public.lp_canon_staff(p.created_by) as s
    from public.patients p
    where p.id = p_request
    union all
    select public.lp_canon_staff(e.staff_name)
    from public.audit_events e
    where e.patient_id = p_request
      and (
        (e.action_type in ('status_changed', 'check_completed')
          and e.new_value ->> 'status' in ('Found – Awaiting Reunion', 'Checked – Not Found', 'Bring friend to medical'))
        or (e.action_type = 'status_changed' and e.new_value ->> 'answer' = 'not_found')
        or e.action_type in ('medical_search', 'medical_search_found')
        or (e.action_type = 'patient_updated' and e.new_value ? 'medical_location')
        or (e.action_type = 'enroute' and e.new_value ->> 'state' in ('enroute', 'changed', 'arrived'))
      )
    union all
    select m.staff_key from public.lp_messages m where m.request_id = p_request
    union all
    select r.staff from public.lp_enroute r where r.request_id = p_request
  ) as x
  where x.s is not null and x.s <> '';
end
$fn$;

-- lp_messages_activity: what the lists show of a request's thread, for the caller: message count, the latest
-- message (first 120 characters, the card preview), unread (other people's messages after the caller's read
-- cursor), needs_info (Waiting for check, the latest message is from the Medical team, and it was written
-- after the request's last status change: a front-of-house reply or any status change clears it), involved
-- (the caller is in lp_involved_staff: the in-app alert) and the en route summary. Unsent messages never
-- count. Internal helper.
create function public.lp_messages_activity(p_request uuid, p_key text, p_status text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_count integer;
  v_last public.lp_messages;
  v_read timestamptz;
  v_unread integer;
  v_changed timestamptz;
  v_needs boolean := false;
  v_involved boolean := false;
begin
  select pg_catalog.count(*)::integer into v_count
  from public.lp_messages m where m.request_id = p_request and m.unsent_at is null;

  select * into v_last
  from public.lp_messages m
  where m.request_id = p_request and m.unsent_at is null
  order by m.created_at desc, m.id desc
  limit 1;

  select r.last_read_at into v_read from public.lp_message_reads r where r.request_id = p_request and r.staff = p_key;

  select pg_catalog.count(*)::integer into v_unread
  from public.lp_messages m
  where m.request_id = p_request and m.unsent_at is null and m.staff_key <> p_key
    and (v_read is null or m.created_at > v_read);

  if p_status = 'Added' and v_last.id is not null and pg_catalog.lower(pg_catalog.btrim(v_last.team)) = 'medical' then
    select pg_catalog.max(e.occurred_at) into v_changed
    from public.audit_events e
    where e.patient_id = p_request and e.action_type in ('status_changed', 'cancelled');
    v_needs := v_changed is null or v_last.created_at > v_changed;
  end if;

  if v_count > 0 then
    v_involved := exists (select 1 from public.lp_involved_staff(p_request) as s(staff) where s.staff = p_key);
  end if;

  return pg_catalog.jsonb_build_object(
    'message_count', v_count,
    'last_message_at', v_last.created_at,
    'last_message', case
      when v_last.id is null then null
      else pg_catalog.jsonb_build_object(
        'staff', v_last.staff,
        'team', v_last.team,
        'body', pg_catalog.left(v_last.body, 120),
        'mine', v_last.staff_key = p_key,
        'at', v_last.created_at)
    end,
    'unread', v_unread,
    'needs_info', v_needs,
    'involved', v_involved,
    'enroute', public.lp_enroute_summary(p_request, p_key)
  );
end
$fn$;

-- lp_post_message: a message on a request, at any status (closed ones too).
--   Idempotent on p_client_mutation_id: a retry returns the message already stored ({created: false}); the
--   same id on another request or by another staff → P0422 field:client_mutation_id.
--   Body: trimmed, 1–500 characters (P0422 field:body). Plain text; the client never renders it as HTML.
--   Rate limit: 20 messages a minute per staff (canonical), serialised per staff with an advisory lock;
--   over it → P0429 with HINT = seconds until the next one is allowed.
--   Audit message_posted {message_id, body}. Returns {created, message, activity, recipients}: recipients =
--   lp_involved_staff, for the notification (contract D) sent after the response.
create function public.lp_post_message(p_request uuid, p_body text, p_client_mutation_id uuid, p_staff text, p_team text)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
set lock_timeout = '2s'
as $fn$
declare
  v_key text;
  v_status text;
  v_msg public.lp_messages;
  v_body text;
  v_n integer;
  v_oldest timestamptz;
  v_created boolean := true;
begin
  perform public.lp_require_staff(p_staff);
  if p_request is null then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;
  if p_client_mutation_id is null then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:client_mutation_id';
  end if;
  v_key := public.lp_canon_staff(p_staff);

  select p.status into v_status from public.patients p where p.id = p_request;
  if not found then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;

  select * into v_msg from public.lp_messages m where m.client_mutation_id = p_client_mutation_id;
  if v_msg.id is not null then
    if v_msg.request_id <> p_request or v_msg.staff_key <> v_key then
      raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:client_mutation_id';
    end if;
    v_created := false;
  else
    v_body := pg_catalog.btrim(p_body, E' \t\r\n');
    if v_body is null or v_body = '' then
      raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:body';
    end if;
    if pg_catalog.char_length(v_body) > 500 then
      raise exception using errcode = 'P0422', message = 'field_too_long', detail = 'field:body';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('lp_messages:' || v_key));
    select pg_catalog.count(*)::integer, pg_catalog.min(m.created_at) into v_n, v_oldest
    from public.lp_messages m
    where m.staff_key = v_key and m.created_at > pg_catalog.clock_timestamp() - interval '60 seconds';
    if v_n >= 20 then
      raise exception using errcode = 'P0429', message = 'rate_limited',
        hint = greatest(1, pg_catalog.ceil(60 - extract(epoch from pg_catalog.clock_timestamp() - v_oldest)))::integer::text;
    end if;

    insert into public.lp_messages as t (request_id, staff, staff_key, team, body, client_mutation_id)
    values (p_request, p_staff, v_key, coalesce(pg_catalog.btrim(p_team), ''), v_body, p_client_mutation_id)
    on conflict (client_mutation_id) do nothing
    returning t.* into v_msg;

    if v_msg.id is null then
      -- A concurrent identical send won the race: answer with its message.
      select * into v_msg from public.lp_messages m where m.client_mutation_id = p_client_mutation_id;
      if v_msg.request_id <> p_request or v_msg.staff_key <> v_key then
        raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:client_mutation_id';
      end if;
      v_created := false;
    else
      insert into public.audit_events (patient_id, staff_name, action_type, previous_value, new_value, occurred_at)
      values (p_request, p_staff, 'message_posted', null,
              pg_catalog.jsonb_build_object('message_id', v_msg.id, 'body', v_msg.body), v_msg.created_at);
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'created', v_created,
    'message', public.lp_messages_json(v_msg, v_key),
    'activity', public.lp_messages_activity(p_request, v_key, v_status),
    'recipients', case when v_created
      then (select coalesce(pg_catalog.jsonb_agg(s.staff), '[]'::jsonb) from public.lp_involved_staff(p_request) as s(staff))
      else '[]'::jsonb end
  );
end
$fn$;

-- lp_unsend_message: the sender takes a message back within 15 minutes. It disappears from every thread,
-- count and preview, and stays in lp_messages (unsent_at), in the audit trail and in the export.
--   A message of another request (p_request) → P0002. Someone else's message → P0403. Older than 15 minutes
--   → P0422 too_late (field:message). Already unsent → {changed: false}. Audit message_unsent (previous {message_id, body}). Returns {changed, message, activity}.
create function public.lp_unsend_message(p_request uuid, p_message uuid, p_staff text)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
set lock_timeout = '2s'
as $fn$
declare
  v_key text;
  v_msg public.lp_messages;
  v_status text;
begin
  perform public.lp_require_staff(p_staff);
  if p_message is null then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;
  v_key := public.lp_canon_staff(p_staff);
  select * into v_msg from public.lp_messages m where m.id = p_message for update;
  if v_msg.id is null or v_msg.request_id is distinct from p_request then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;
  if v_msg.staff_key <> v_key then
    raise exception using errcode = 'P0403', message = 'sender_only';
  end if;
  select p.status into v_status from public.patients p where p.id = v_msg.request_id;
  if v_msg.unsent_at is not null then
    return pg_catalog.jsonb_build_object('changed', false, 'message', public.lp_messages_json(v_msg, v_key),
      'activity', public.lp_messages_activity(v_msg.request_id, v_key, v_status));
  end if;
  if pg_catalog.clock_timestamp() - v_msg.created_at > interval '15 minutes' then
    raise exception using errcode = 'P0422', message = 'too_late', detail = 'field:message';
  end if;

  update public.lp_messages m set unsent_at = pg_catalog.clock_timestamp() where m.id = p_message returning * into v_msg;

  insert into public.audit_events (patient_id, staff_name, action_type, previous_value, new_value, occurred_at)
  values (v_msg.request_id, p_staff, 'message_unsent',
          pg_catalog.jsonb_build_object('message_id', v_msg.id, 'body', v_msg.body),
          pg_catalog.jsonb_build_object('message_id', v_msg.id), v_msg.unsent_at);

  return pg_catalog.jsonb_build_object('changed', true, 'message', public.lp_messages_json(v_msg, v_key),
    'activity', public.lp_messages_activity(v_msg.request_id, v_key, v_status));
end
$fn$;

-- lp_mark_read: the caller saw the thread up to p_upto (the newest message on their screen; null = now). The
-- cursor only moves forward, and only past someone else's message, so "Read 4:14 PM" keeps the time the
-- message was first seen and an open thread with nothing new writes nothing. Not audited.
-- Returns {changed, activity}.
create function public.lp_mark_read(p_request uuid, p_staff text, p_upto timestamptz default null)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
set lock_timeout = '2s'
as $fn$
declare
  v_key text;
  v_status text;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_upto timestamptz;
  v_last timestamptz;
  v_changed boolean := false;
begin
  perform public.lp_require_staff(p_staff);
  if p_request is null then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;
  v_key := public.lp_canon_staff(p_staff);
  select p.status into v_status from public.patients p where p.id = p_request;
  if not found then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;
  v_upto := least(coalesce(p_upto, v_now), v_now);

  select r.last_read_at into v_last from public.lp_message_reads r where r.request_id = p_request and r.staff = v_key for update;
  if (v_last is null or v_upto > v_last) and exists (
    select 1 from public.lp_messages m
    where m.request_id = p_request and m.unsent_at is null and m.staff_key <> v_key
      and m.created_at <= v_upto and (v_last is null or m.created_at > v_last)
  ) then
    insert into public.lp_message_reads as r (request_id, staff, last_read_at, read_at)
    values (p_request, v_key, v_upto, v_now)
    on conflict (request_id, staff) do update
      set last_read_at = greatest(r.last_read_at, excluded.last_read_at), read_at = excluded.read_at;
    v_changed := true;
  end if;

  return pg_catalog.jsonb_build_object('changed', v_changed, 'activity', public.lp_messages_activity(p_request, v_key, v_status));
end
$fn$;

-- lp_set_enroute: front of house walking the friend over. p_action:
--   'set'    en route, or a new ETA: p_eta_at (absolute; the Undo of a cancel), else clock_timestamp() +
--            p_eta_offset_seconds (the pill's minutes minus how long ago it was tapped, so a queued tap keeps
--            its ETA), else no ETA. ETAs are clamped to ±6 h. p_eta_minutes is the pill (0–60) or null.
--   'cancel' clears only the caller's en route.
--   'arrive' the friend arrived (the caller's row becomes 'arrived', and so does everyone else's still en
--            route on the request: the friend is there; the audit row counts them in also_arrived).
--   Only while the request is In medical; at any other status the call is accepted and changes nothing
--   ({changed: false, ignored: true}), so a queued tap that lands after the answer changed never fails.
--   Repeats change nothing (same state and ETA within 30 s). Audit 'enroute' {state: enroute | changed |
--   cancelled | arrived, eta_at, eta_minutes, staff_key}. Returns {changed, ignored, event, activity,
--   recipients} (recipients = lp_involved_staff when it changed, for the notification).
create function public.lp_set_enroute(
  p_request uuid,
  p_action text,
  p_eta_offset_seconds integer,
  p_eta_at timestamptz,
  p_eta_minutes integer,
  p_staff text
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
  v_key text;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_status text;
  v_cur public.lp_enroute;
  v_eta timestamptz;
  v_event text;
  v_prev jsonb;
  v_others integer := 0;
begin
  perform public.lp_require_staff(p_staff);
  if p_request is null then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;
  if p_action is null or p_action not in ('set', 'cancel', 'arrive') then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:action';
  end if;
  if p_eta_minutes is not null and (p_eta_minutes < 0 or p_eta_minutes > 60) then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:eta_minutes';
  end if;
  v_key := public.lp_canon_staff(p_staff);

  -- FOR SHARE: a status change (FOR UPDATE, then the clearing trigger) waits for this, and this for it.
  select p.status into v_status from public.patients p where p.id = p_request for share;
  if not found then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;
  if v_status not in ('Found – Awaiting Reunion', 'Bring friend to medical') then
    return pg_catalog.jsonb_build_object('changed', false, 'ignored', true, 'event', null,
      'activity', public.lp_messages_activity(p_request, v_key, v_status), 'recipients', '[]'::jsonb);
  end if;

  select * into v_cur from public.lp_enroute e where e.request_id = p_request and e.staff = v_key for update;
  v_prev := case when v_cur.request_id is null then null
    else pg_catalog.jsonb_build_object('state', v_cur.state, 'eta_at', v_cur.eta_at, 'eta_minutes', v_cur.eta_minutes) end;

  if p_action = 'set' then
    v_eta := coalesce(p_eta_at, case when p_eta_offset_seconds is null then null
                                     else v_now + pg_catalog.make_interval(secs => p_eta_offset_seconds) end);
    if v_eta is not null then
      v_eta := least(greatest(v_eta, v_now - interval '6 hours'), v_now + interval '6 hours');
    end if;
    if v_cur.request_id is not null and v_cur.state = 'enroute'
       and v_cur.eta_minutes is not distinct from p_eta_minutes::smallint
       and ((v_cur.eta_at is null and v_eta is null)
            or (v_cur.eta_at is not null and v_eta is not null and abs(extract(epoch from v_cur.eta_at - v_eta)) < 30)) then
      return pg_catalog.jsonb_build_object('changed', false, 'ignored', false, 'event', null,
        'activity', public.lp_messages_activity(p_request, v_key, v_status), 'recipients', '[]'::jsonb);
    end if;
    v_event := case when v_cur.request_id is null or v_cur.state = 'arrived' then 'enroute' else 'changed' end;
    insert into public.lp_enroute as e (request_id, staff, staff_name, eta_at, eta_minutes, state, updated_at)
    values (p_request, v_key, p_staff, v_eta, p_eta_minutes::smallint, 'enroute', v_now)
    on conflict (request_id, staff) do update
      set staff_name = excluded.staff_name, eta_at = excluded.eta_at, eta_minutes = excluded.eta_minutes,
          state = 'enroute', updated_at = excluded.updated_at;
  elsif p_action = 'cancel' then
    if v_cur.request_id is null then
      return pg_catalog.jsonb_build_object('changed', false, 'ignored', false, 'event', null,
        'activity', public.lp_messages_activity(p_request, v_key, v_status), 'recipients', '[]'::jsonb);
    end if;
    delete from public.lp_enroute e where e.request_id = p_request and e.staff = v_key;
    v_event := 'cancelled';
    v_eta := v_cur.eta_at;
  else
    if v_cur.state = 'arrived' then
      return pg_catalog.jsonb_build_object('changed', false, 'ignored', false, 'event', null,
        'activity', public.lp_messages_activity(p_request, v_key, v_status), 'recipients', '[]'::jsonb);
    end if;
    v_eta := v_cur.eta_at;
    insert into public.lp_enroute as e (request_id, staff, staff_name, eta_at, eta_minutes, state, updated_at)
    values (p_request, v_key, p_staff, v_eta, v_cur.eta_minutes, 'arrived', v_now)
    on conflict (request_id, staff) do update set staff_name = excluded.staff_name, state = 'arrived', updated_at = excluded.updated_at;
    -- The friend is there: everyone else still bringing them is done too (the row reads "Friend arrived" for
    -- all), so nobody is left with an en route they can no longer change, and Friends en route drops it.
    update public.lp_enroute e set state = 'arrived', updated_at = v_now
     where e.request_id = p_request and e.staff <> v_key and e.state = 'enroute';
    get diagnostics v_others = row_count;
    v_event := 'arrived';
  end if;

  insert into public.audit_events (patient_id, staff_name, action_type, previous_value, new_value, occurred_at)
  values (p_request, p_staff, 'enroute', v_prev,
          pg_catalog.jsonb_build_object('state', v_event, 'eta_at', v_eta,
            'eta_minutes', case when p_action = 'set' then p_eta_minutes else v_cur.eta_minutes end, 'staff_key', v_key)
          || case when v_others > 0 then pg_catalog.jsonb_build_object('also_arrived', v_others) else '{}'::jsonb end,
          v_now);

  return pg_catalog.jsonb_build_object('changed', true, 'ignored', false, 'event', v_event,
    'activity', public.lp_messages_activity(p_request, v_key, v_status),
    'recipients', (select coalesce(pg_catalog.jsonb_agg(s.staff), '[]'::jsonb) from public.lp_involved_staff(p_request) as s(staff)));
end
$fn$;

-- lp_messages_thread: a request's messages for the caller, the latest p_limit (≤ 200) before the
-- (created_at, id) cursor, oldest first, with has_earlier. Unsent messages are left out. The first page also
-- carries the receipt of the caller's latest message: read_at = when the first other reader whose cursor is at
-- or past it read the thread. Returns {messages, has_earlier, receipt: {message_id, read_at} | null, activity}.
create function public.lp_messages_thread(p_request uuid, p_staff text, p_before_at timestamptz default null, p_before_id uuid default null, p_limit integer default 100)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
set lock_timeout = '2s'
as $fn$
declare
  v_key text;
  v_status text;
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 200);
  v_messages jsonb;
  v_more boolean;
  v_mine public.lp_messages;
  v_receipt jsonb := null;
begin
  perform public.lp_require_staff(p_staff);
  if p_request is null then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;
  if (p_before_at is null) <> (p_before_id is null) then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:before';
  end if;
  v_key := public.lp_canon_staff(p_staff);
  select p.status into v_status from public.patients p where p.id = p_request;
  if not found then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;

  select coalesce(pg_catalog.jsonb_agg(public.lp_messages_json(t.m, v_key) order by (t.m).created_at, (t.m).id)
                    filter (where t.rn <= v_limit), '[]'::jsonb),
         pg_catalog.count(*) > v_limit
    into v_messages, v_more
  from (
    select m, pg_catalog.row_number() over (order by m.created_at desc, m.id desc) as rn
    from public.lp_messages m
    where m.request_id = p_request and m.unsent_at is null
      and (p_before_at is null or (m.created_at, m.id) < (p_before_at, p_before_id))
    order by m.created_at desc, m.id desc
    limit v_limit + 1
  ) as t;

  if p_before_at is null then
    select * into v_mine
    from public.lp_messages m
    where m.request_id = p_request and m.unsent_at is null and m.staff_key = v_key
    order by m.created_at desc, m.id desc
    limit 1;
    if v_mine.id is not null then
      v_receipt := pg_catalog.jsonb_build_object(
        'message_id', v_mine.id,
        'read_at', (select pg_catalog.min(r.read_at) from public.lp_message_reads r
                    where r.request_id = p_request and r.staff <> v_key and r.last_read_at >= v_mine.created_at));
    end if;
  end if;

  return pg_catalog.jsonb_build_object('messages', v_messages, 'has_earlier', v_more, 'receipt', v_receipt,
    'activity', public.lp_messages_activity(p_request, v_key, v_status));
end
$fn$;

-- lp_messages_sync: the thread activity /api/sync attaches to its rows, for the caller.
--   threads: {id, …lp_messages_activity} for every id in p_ids that has any message or en route, and, with
--            p_changed, every request whose thread changed since p_since − 30 s (a message posted or unsent,
--            an en route event, the caller's own read on another device).
--   rows:    lp_row of those changed requests that are not in p_ids (their patients row did not change, so
--            lp_sync did not return them).
-- Requests with neither messages nor en route are left out (the server fills the empty activity).
-- Returns {threads, rows}.
create function public.lp_messages_sync(p_staff text, p_ids uuid[], p_since timestamptz, p_changed boolean)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
set lock_timeout = '2s'
as $fn$
declare
  v_key text;
  v_ids uuid[] := coalesce(p_ids, '{}'::uuid[]);
  v_delta boolean := coalesce(p_changed, false) and p_since is not null;
  v_from timestamptz := p_since - interval '30 seconds';
  v_threads jsonb;
  v_rows jsonb;
begin
  perform public.lp_require_staff(p_staff);
  if pg_catalog.cardinality(v_ids) > 1000 then
    raise exception using errcode = 'P0422', message = 'too_many_ids', detail = 'field:ids';
  end if;
  v_key := public.lp_canon_staff(p_staff);

  with changed as (
    select e.patient_id as id from public.audit_events e
    where v_delta and e.action_type in ('message_posted', 'message_unsent', 'enroute') and e.occurred_at > v_from
    union
    select m.request_id from public.lp_messages m
    where v_delta and (m.created_at > v_from or m.unsent_at > v_from)
    union
    select r.request_id from public.lp_message_reads r
    where v_delta and r.staff = v_key and r.read_at > v_from
  ), active as (
    select m.request_id as id from public.lp_messages m where m.request_id = any (v_ids)
    union
    select e.request_id from public.lp_enroute e where e.request_id = any (v_ids)
  )
  -- A changed request whose own row changed since p_since − 30 s is in lp_sync's delta (on this page or a
  -- later one) and gets its activity there; only the others come back as extra rows, so a paged delta never
  -- returns a row twice.
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', p.id) || public.lp_messages_activity(p.id, v_key, p.status)), '[]'::jsonb),
         coalesce(pg_catalog.jsonb_agg(public.lp_row(p)) filter (where not (p.id = any (v_ids))), '[]'::jsonb)
    into v_threads, v_rows
  from public.patients p
  where p.id in (select a.id from active a)
     or (p.id in (select c.id from changed c where c.id is not null)
         and not (p.id = any (v_ids))
         and p.updated_at <= v_from);

  return pg_catalog.jsonb_build_object('threads', v_threads, 'rows', v_rows);
end
$fn$;

-- lp_enroute_stats: the dashboard's "Friends en route" (requests In medical with someone en route now and
-- nobody arrived yet) and
-- "Time to arrive" (mean minutes from going en route to Arrived, over arrivals in the last 2 hours, 1 decimal;
-- null when none). An arrival is measured from the same staff's latest 'enroute' event on the request before
-- it: a changed ETA does not restart the clock, a cancel and a new en route does. /api/stats merges it into
-- lp_stats (additive fields: friendsEnRoute, avgArriveMinutes).
create function public.lp_enroute_stats()
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
set lock_timeout = '2s'
as $fn$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_friends integer;
  v_avg numeric;
begin
  -- A request whose friend arrived is no longer "en route", even if a late tap left someone's row 'enroute'.
  select pg_catalog.count(*)::integer into v_friends
  from (
    select e.request_id
    from public.lp_enroute e
    join public.patients p on p.id = e.request_id
    where p.status in ('Found – Awaiting Reunion', 'Bring friend to medical')
    group by e.request_id
    having pg_catalog.bool_and(e.state = 'enroute')
  ) as x;

  select pg_catalog.round(pg_catalog.avg(extract(epoch from (x.arrived_at - x.started_at)) / 60.0)::numeric, 1) into v_avg
  from (
    select a.occurred_at as arrived_at,
           (select pg_catalog.max(s.occurred_at)
              from public.audit_events s
             where s.action_type = 'enroute' and s.patient_id = a.patient_id
               and s.new_value ->> 'staff_key' = a.new_value ->> 'staff_key'
               and s.new_value ->> 'state' = 'enroute'
               and s.occurred_at <= a.occurred_at) as started_at
    from public.audit_events a
    where a.action_type = 'enroute' and a.new_value ->> 'state' = 'arrived'
      and a.occurred_at > v_now - interval '2 hours' and a.occurred_at <= v_now
  ) as x
  where x.started_at is not null;

  return pg_catalog.jsonb_build_object('friendsEnRoute', v_friends, 'avgArriveMinutes', v_avg);
end
$fn$;

revoke all on function public.lp_enroute_on_status() from public, anon, authenticated;
revoke all on function public.lp_messages_json(public.lp_messages, text) from public, anon, authenticated;
revoke all on function public.lp_enroute_summary(uuid, text) from public, anon, authenticated;
revoke all on function public.lp_involved_staff(uuid) from public, anon, authenticated;
revoke all on function public.lp_messages_activity(uuid, text, text) from public, anon, authenticated;
revoke all on function public.lp_post_message(uuid, text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.lp_unsend_message(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.lp_mark_read(uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.lp_set_enroute(uuid, text, integer, timestamptz, integer, text) from public, anon, authenticated;
revoke all on function public.lp_messages_thread(uuid, text, timestamptz, uuid, integer) from public, anon, authenticated;
revoke all on function public.lp_messages_sync(text, uuid[], timestamptz, boolean) from public, anon, authenticated;
revoke all on function public.lp_enroute_stats() from public, anon, authenticated;

grant execute on function public.lp_messages_json(public.lp_messages, text) to service_role;
grant execute on function public.lp_enroute_summary(uuid, text) to service_role;
grant execute on function public.lp_involved_staff(uuid) to service_role;
grant execute on function public.lp_messages_activity(uuid, text, text) to service_role;
grant execute on function public.lp_post_message(uuid, text, uuid, text, text) to service_role;
grant execute on function public.lp_unsend_message(uuid, uuid, text) to service_role;
grant execute on function public.lp_mark_read(uuid, text, timestamptz) to service_role;
grant execute on function public.lp_set_enroute(uuid, text, integer, timestamptz, integer, text) to service_role;
grant execute on function public.lp_messages_thread(uuid, text, timestamptz, uuid, integer) to service_role;
grant execute on function public.lp_messages_sync(text, uuid[], timestamptz, boolean) to service_role;
grant execute on function public.lp_enroute_stats() to service_role;

-- -----------------------------------------------------------------------------------------------------
-- 8. F4 · Web Push, the Alerts switches and the Activity inbox (2026-11-06 evening; spec §22 A82–A89).
--    ADDITIVE ONLY: three new tables and new lp_push_* / lp_activity_* functions. Nothing above changes, so
--    the build that is live now keeps working on a database that has this, and a re-run keeps every
--    subscription, switch and Activity row (create table if not exists; functions are dropped by name and
--    recreated, every overload of these F4 names included, so an older draft can never leave an ambiguous
--    overload behind).
--
--    lp_push_prefs          one row per staff member (canonical staff string, lp_canon_staff of
--                           "Name · Team"): the Alerts sheet's "New requests" and "Updates on my requests".
--                           Created on first use with New requests as the phone's old "Alerts" bell was (off
--                           unless it was on) and Updates on my requests on. Until the staff member sets New
--                           requests in the Alerts sheet (new_requests_set), any of their devices whose old
--                           bell was on turns it on: no phone loses the new-request alerts it had.
--    lp_push_subscriptions  one row per device (the push endpoint is unique): its keys, whose it is, and the
--                           two switches (copied from lp_push_prefs, which is the source). A different staff
--                           signing in on the same phone re-binds the row. Deleted on 404 / 410 from the push
--                           service, and after 5 failures in a row.
--    lp_activity            ONE row per (staff, request): the latest event about that request for that staff
--                           member. A new event rewrites it (kind, actor, detail, at = now) and makes it
--                           unread again. Kept 3 days, at most 100 per staff member.
--
--    RLS on, no policies, service_role only, like every other app table. Notification text never holds a
--    phone number, contact details or a request id (LP-####): `detail` is built by the server (contract B).
-- -----------------------------------------------------------------------------------------------------
create table if not exists public.lp_push_prefs (
  staff text primary key,
  team text not null default '',
  new_requests boolean not null default false,
  my_updates boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- (A table made by an earlier draft of this section gets the column too.)
alter table public.lp_push_prefs add column if not exists new_requests_set boolean not null default false;
alter table public.lp_push_prefs enable row level security;

create table if not exists public.lp_push_subscriptions (
  id bigserial primary key,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  staff text not null,
  team text not null default '',
  user_agent text,
  new_requests boolean not null default false,
  my_updates boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_ok_at timestamptz,
  failures integer not null default 0
);
create index if not exists lp_push_subscriptions_staff_idx on public.lp_push_subscriptions (staff);
alter table public.lp_push_subscriptions enable row level security;

create table if not exists public.lp_activity (
  staff text not null,
  request_id uuid not null references public.patients (id) on delete cascade,
  kind text not null,
  actor text not null default '',
  detail text not null default '',
  at timestamptz not null default now(),
  read_at timestamptz,
  primary key (staff, request_id)
);
create index if not exists lp_activity_staff_at_idx on public.lp_activity (staff, at desc);
alter table public.lp_activity enable row level security;

revoke all on table public.lp_push_prefs, public.lp_push_subscriptions, public.lp_activity from public, anon, authenticated;
revoke all on sequence public.lp_push_subscriptions_id_seq from public, anon, authenticated;
grant select, insert, update, delete on table public.lp_push_prefs to service_role;
grant select, insert, update, delete on table public.lp_push_subscriptions to service_role;
grant select, insert, update, delete on table public.lp_activity to service_role;
grant usage, select on sequence public.lp_push_subscriptions_id_seq to service_role;

-- Every overload of the F4 function names goes first (a re-run, or an older draft with other arguments).
do $f4drop$
declare
  v record;
begin
  for v in
    select p.oid::regprocedure as sig
    from pg_catalog.pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('lp_push_prefs_sync', 'lp_push_subscribe', 'lp_push_unsubscribe', 'lp_push_test_target',
                        'lp_push_result', 'lp_push_new_request_staff', 'lp_activity_record', 'lp_activity_list',
                        'lp_activity_mark_read', 'lp_activity_unmark', 'lp_activity_unread', 'lp_activity_fallback_staff')
  loop
    execute pg_catalog.format('drop function %s', v.sig);
  end loop;
end
$f4drop$;

-- lp_push_prefs_sync: the staff member's switches, created with the defaults on first use. Non-null
-- arguments change a switch (and every device of theirs follows); a New requests set this way is the staff
-- member's own choice (new_requests_set) and stays. p_default_new_requests is a device's old "Alerts" bell:
-- until that choice is made, a device whose bell was on turns New requests on (OR), whichever device came
-- first; without it, New requests starts off. Returns {newRequests, myUpdates}.
-- (F6, Brian 2026-11-07 02:15: Main Med gets distracted; the lock-screen push is the chosen alert.) Staff of the
-- Medical team (the canonical staff string's team is 'medical') start with New requests ON, and so does a Medical
-- staff member's row that never had the switch set in the Alerts sheet (new_requests_set false); everyone else
-- keeps the rule above. A switch set in the sheet always stays as set.
create function public.lp_push_prefs_sync(
  p_staff text, p_team text, p_new_requests boolean, p_my_updates boolean, p_default_new_requests boolean)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
set lock_timeout = '2s'
as $fn$
declare
  v_staff text;
  v_team text := pg_catalog.left(pg_catalog.btrim(coalesce(p_team, '')), 120);
  v_row public.lp_push_prefs;
  v_default boolean;
begin
  perform public.lp_require_staff(p_staff);
  v_staff := public.lp_canon_staff(p_staff);
  -- (F6) The device's old bell, or the Medical team's default (on).
  v_default := coalesce(p_default_new_requests, false)
               or coalesce((pg_catalog.regexp_match(v_staff, '^(.*) · (.*)$'))[2] = 'medical', false);

  insert into public.lp_push_prefs as pr (staff, team, new_requests, my_updates, new_requests_set)
  values (
    v_staff, v_team,
    coalesce(p_new_requests, v_default),
    coalesce(p_my_updates, true),
    p_new_requests is not null)
  on conflict (staff) do update set
    team = excluded.team,
    new_requests = case
      when p_new_requests is not null then p_new_requests
      when pr.new_requests_set then pr.new_requests
      else pr.new_requests or v_default
    end,
    new_requests_set = pr.new_requests_set or p_new_requests is not null,
    my_updates = coalesce(p_my_updates, pr.my_updates),
    updated_at = case when p_new_requests is null and p_my_updates is null then pr.updated_at else now() end
  returning * into v_row;

  update public.lp_push_subscriptions
     set new_requests = v_row.new_requests, my_updates = v_row.my_updates
   where staff = v_staff and (new_requests is distinct from v_row.new_requests or my_updates is distinct from v_row.my_updates);

  return pg_catalog.jsonb_build_object('newRequests', v_row.new_requests, 'myUpdates', v_row.my_updates);
end
$fn$;

-- lp_push_subscribe: stores (or re-binds) this device's subscription for p_staff, with the staff member's
-- switches. One row per endpoint, so one subscription per device; a different staff on the same phone takes
-- the row over. p_old_endpoint (the browser rotated the subscription): that row goes, only when it is this
-- staff member's. At most 10 devices per staff member (the least recently confirmed go).
-- Returns {newRequests, myUpdates}.
create function public.lp_push_subscribe(
  p_endpoint text, p_p256dh text, p_auth text, p_staff text, p_team text, p_user_agent text,
  p_old_endpoint text, p_default_new_requests boolean)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
set lock_timeout = '2s'
as $fn$
declare
  v_staff text;
  v_prefs jsonb;
begin
  perform public.lp_require_staff(p_staff);
  if p_endpoint is null or pg_catalog.char_length(p_endpoint) not between 12 and 1024 then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:endpoint';
  end if;
  if p_p256dh is null or pg_catalog.char_length(p_p256dh) not between 16 and 200 then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:p256dh';
  end if;
  if p_auth is null or pg_catalog.char_length(p_auth) not between 8 and 100 then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:auth';
  end if;
  v_staff := public.lp_canon_staff(p_staff);
  v_prefs := public.lp_push_prefs_sync(p_staff, p_team, null, null, p_default_new_requests);

  if p_old_endpoint is not null and p_old_endpoint <> p_endpoint then
    delete from public.lp_push_subscriptions where endpoint = p_old_endpoint and staff = v_staff;
  end if;

  insert into public.lp_push_subscriptions as s (endpoint, p256dh, auth, staff, team, user_agent, new_requests, my_updates)
  values (
    p_endpoint, p_p256dh, p_auth, v_staff, pg_catalog.left(pg_catalog.btrim(coalesce(p_team, '')), 120),
    pg_catalog.left(p_user_agent, 300), (v_prefs ->> 'newRequests')::boolean, (v_prefs ->> 'myUpdates')::boolean)
  on conflict (endpoint) do update set
    p256dh = excluded.p256dh,
    auth = excluded.auth,
    staff = excluded.staff,
    team = excluded.team,
    user_agent = excluded.user_agent,
    new_requests = excluded.new_requests,
    my_updates = excluded.my_updates,
    updated_at = now(),
    failures = 0;

  delete from public.lp_push_subscriptions
  where staff = v_staff
    and id not in (
      select s.id from public.lp_push_subscriptions s
      where s.staff = v_staff
      order by coalesce(s.last_ok_at, s.updated_at) desc, s.id desc
      limit 10);

  return v_prefs;
end
$fn$;

-- lp_push_unsubscribe: this device stops getting pushes (sign-out), only when the subscription is p_staff's
-- (nobody can switch off another person's device). Returns whether a row went.
create function public.lp_push_unsubscribe(p_endpoint text, p_staff text)
returns boolean
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
set lock_timeout = '2s'
as $fn$
declare
  v_count integer;
begin
  perform public.lp_require_staff(p_staff);
  if p_endpoint is null then
    return false;
  end if;
  delete from public.lp_push_subscriptions where endpoint = p_endpoint and staff = public.lp_canon_staff(p_staff);
  get diagnostics v_count = row_count;
  return v_count > 0;
end
$fn$;

-- lp_push_test_target: "Send a test alert". The subscription of this endpoint, only when it belongs to
-- p_staff (else null). Returns {endpoint, p256dh, auth, staff} or null.
create function public.lp_push_test_target(p_endpoint text, p_staff text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
as $fn$
declare
  v_row public.lp_push_subscriptions;
begin
  perform public.lp_require_staff(p_staff);
  select * into v_row from public.lp_push_subscriptions
  where endpoint = p_endpoint and staff = public.lp_canon_staff(p_staff);
  if v_row.id is null then
    return null;
  end if;
  return pg_catalog.jsonb_build_object('endpoint', v_row.endpoint, 'p256dh', v_row.p256dh, 'auth', v_row.auth, 'staff', v_row.staff);
end
$fn$;

-- lp_push_result: what the push services answered. ok → last_ok_at, failures reset; gone (404 / 410) →
-- deleted; failed (timeout, 5xx, 429, …) → failures + 1, deleted at 5 in a row.
create function public.lp_push_result(p_ok text[], p_gone text[], p_failed text[])
returns void
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
set lock_timeout = '2s'
as $fn$
begin
  if p_ok is not null and pg_catalog.cardinality(p_ok) > 0 then
    update public.lp_push_subscriptions set last_ok_at = now(), failures = 0 where endpoint = any (p_ok);
  end if;
  if p_gone is not null and pg_catalog.cardinality(p_gone) > 0 then
    delete from public.lp_push_subscriptions where endpoint = any (p_gone);
  end if;
  if p_failed is not null and pg_catalog.cardinality(p_failed) > 0 then
    update public.lp_push_subscriptions set failures = failures + 1 where endpoint = any (p_failed);
    delete from public.lp_push_subscriptions where endpoint = any (p_failed) and failures >= 5;
  end if;
end
$fn$;

-- lp_push_new_request_staff: everyone whose "New requests" switch is on (canonical staff strings).
create function public.lp_push_new_request_staff()
returns text[]
language plpgsql
stable
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
as $fn$
begin
  return coalesce((select pg_catalog.array_agg(pr.staff order by pr.staff) from public.lp_push_prefs pr where pr.new_requests), '{}'::text[]);
end
$fn$;

-- lp_activity_fallback_staff: who is involved in a request when lp_involved_staff (the Messages release)
-- is not there: whoever logged it and whoever answered In medical or Not in medical (attribution strings).
create function public.lp_activity_fallback_staff(p_request uuid)
returns text[]
language plpgsql
stable
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
as $fn$
declare
  v_out text[];
begin
  select pg_catalog.array_agg(distinct x.staff) into v_out
  from (
    select p.created_by as staff from public.patients p where p.id = p_request
    union all
    select e.staff_name from public.audit_events e
    where e.patient_id = p_request
      and (
        (e.action_type = 'status_changed'
          and e.new_value ->> 'status' in ('Found – Awaiting Reunion', 'Checked – Not Found', 'Bring friend to medical'))
        or (e.action_type = 'status_changed' and e.new_value ->> 'answer' = 'not_found')
        or e.action_type in ('medical_search', 'medical_search_found', 'check_completed'))
  ) x
  where x.staff is not null and pg_catalog.btrim(x.staff) <> '';
  return coalesce(v_out, '{}'::text[]);
end
$fn$;

-- lp_activity_record: one event about a request for p_recipients (attribution or canonical strings). The
-- actor and duplicates are dropped; each remaining staff member's row for the request becomes this event,
-- unread, at now() (it moves to the top). Their rows older than 3 days, and beyond their newest 100, go.
-- Returns {written: [staff], targets: [{endpoint, p256dh, auth, staff}] (devices whose switch for this kind
-- is on), unread: {staff: count}, firstName, lastName} (the request's name, for the push title's initials).
create function public.lp_activity_record(p_recipients text[], p_request uuid, p_kind text, p_actor text, p_detail text)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
set lock_timeout = '2s'
as $fn$
declare
  v_actor text := public.lp_canon_staff(coalesce(p_actor, ''));
  v_staff text[];
  v_patient public.patients;
  v_targets jsonb;
  v_unread jsonb;
begin
  if p_kind is null or p_kind not in ('message', 'enroute', 'enroute_changed', 'enroute_cancelled', 'arrived', 'new_request',
      'in_medical', 'not_in_medical', 'back_to_waiting', 'moved', 'reunited', 'discharged', 'cancelled', 'edited',
      -- (F6) The inactivity auto-close (section 9), told by the app server once per close.
      'closed_inactive') then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:kind';
  end if;
  select * into v_patient from public.patients where id = p_request;
  if v_patient.id is null then
    return pg_catalog.jsonb_build_object('written', '[]'::jsonb, 'targets', '[]'::jsonb, 'unread', '{}'::jsonb);
  end if;

  select coalesce(pg_catalog.array_agg(distinct c.s), '{}'::text[]) into v_staff
  from (select public.lp_canon_staff(r) as s from pg_catalog.unnest(coalesce(p_recipients, '{}'::text[])) r) c
  where c.s is not null and c.s <> '' and pg_catalog.char_length(c.s) <= 200 and c.s is distinct from v_actor;

  if pg_catalog.cardinality(v_staff) = 0 then
    return pg_catalog.jsonb_build_object('written', '[]'::jsonb, 'targets', '[]'::jsonb, 'unread', '{}'::jsonb,
      'firstName', v_patient.first_name, 'lastName', v_patient.last_name);
  end if;

  insert into public.lp_activity as a (staff, request_id, kind, actor, detail, at, read_at)
  select s, p_request, p_kind, pg_catalog.left(coalesce(p_actor, ''), 200), pg_catalog.left(coalesce(p_detail, ''), 200), now(), null
  from pg_catalog.unnest(v_staff) s
  on conflict (staff, request_id) do update set
    kind = excluded.kind, actor = excluded.actor, detail = excluded.detail, at = excluded.at, read_at = null;

  delete from public.lp_activity a
  where a.staff = any (v_staff)
    and (a.at < now() - interval '3 days'
      or (a.staff, a.request_id) not in (
        select b.staff, b.request_id from (
          select x.staff, x.request_id, pg_catalog.row_number() over (partition by x.staff order by x.at desc, x.request_id) as n
          from public.lp_activity x where x.staff = any (v_staff)) b
        where b.n <= 100));

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth, 'staff', s.staff) order by s.id), '[]'::jsonb)
    into v_targets
  from public.lp_push_subscriptions s
  where s.staff = any (v_staff)
    and case when p_kind = 'new_request' then s.new_requests else s.my_updates end;

  select coalesce(pg_catalog.jsonb_object_agg(u.staff, u.n), '{}'::jsonb) into v_unread
  from (
    select a.staff, pg_catalog.count(*) as n from public.lp_activity a
    where a.staff = any (v_staff) and a.read_at is null and a.at >= now() - interval '3 days'
    group by a.staff) u;

  return pg_catalog.jsonb_build_object('written', pg_catalog.to_jsonb(v_staff), 'targets', v_targets, 'unread', v_unread,
    'firstName', v_patient.first_name, 'lastName', v_patient.last_name);
end
$fn$;

-- lp_activity_list: the staff member's Activity, newest first (the latest 100 of the last 3 days), with each
-- request's name (line 1 shows its initials) and status. Returns {serverTime, rows: [...]}.
create function public.lp_activity_list(p_staff text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
as $fn$
declare
  v_rows jsonb;
begin
  perform public.lp_require_staff(p_staff);
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'request_id', t.request_id, 'kind', t.kind, 'detail', t.detail, 'at', t.at, 'read_at', t.read_at,
           'first_name', t.first_name, 'last_name', t.last_name, 'status', t.status) order by t.at desc, t.request_id), '[]'::jsonb)
    into v_rows
  from (
    select a.request_id, a.kind, a.detail, a.at, a.read_at, p.first_name, p.last_name, p.status
    from public.lp_activity a
    join public.patients p on p.id = a.request_id
    where a.staff = public.lp_canon_staff(p_staff) and a.at >= now() - interval '3 days'
    order by a.at desc, a.request_id
    limit 100) t;
  return pg_catalog.jsonb_build_object('serverTime', pg_catalog.clock_timestamp(), 'rows', v_rows);
end
$fn$;

-- lp_activity_mark_read: the request was opened (p_request), or Mark all read (p_request null). Returns
-- {count, ids}: the rows that turned read (Undo sends them back to lp_activity_unmark).
create function public.lp_activity_mark_read(p_staff text, p_request uuid)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
set lock_timeout = '2s'
as $fn$
declare
  v_ids uuid[];
begin
  perform public.lp_require_staff(p_staff);
  with done as (
    update public.lp_activity a
       set read_at = now()
     where a.staff = public.lp_canon_staff(p_staff)
       and a.read_at is null
       and (p_request is null or a.request_id = p_request)
    returning a.request_id)
  select coalesce(pg_catalog.array_agg(request_id), '{}'::uuid[]) into v_ids from done;
  return pg_catalog.jsonb_build_object('count', pg_catalog.cardinality(v_ids), 'ids', pg_catalog.to_jsonb(v_ids));
end
$fn$;

-- lp_activity_unmark: Undo of Mark all read. Those rows are unread again (a row a newer event already made
-- unread is left as it is). Returns how many changed.
create function public.lp_activity_unmark(p_staff text, p_requests uuid[])
returns integer
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
set lock_timeout = '2s'
as $fn$
declare
  v_count integer;
begin
  perform public.lp_require_staff(p_staff);
  update public.lp_activity a
     set read_at = null
   where a.staff = public.lp_canon_staff(p_staff)
     and a.request_id = any (coalesce(p_requests, '{}'::uuid[]))
     and a.read_at is not null;
  get diagnostics v_count = row_count;
  return v_count;
end
$fn$;

-- lp_activity_unread: what the bell counts (unread requests, newest first, in the 3-day window), and a
-- fingerprint of the staff member's Activity (16 hex characters) that moves whenever a row is added, changed
-- or read: sync carries {count, key} only, and the client asks for the ids and the list when the key moves.
-- Returns {count, ids, key}.
create function public.lp_activity_unread(p_staff text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
as $fn$
declare
  v_staff text;
  v_ids uuid[];
  v_key text;
begin
  perform public.lp_require_staff(p_staff);
  v_staff := public.lp_canon_staff(p_staff);
  select coalesce(pg_catalog.array_agg(t.request_id order by t.at desc, t.request_id), '{}'::uuid[]) into v_ids
  from (
    select a.request_id, a.at from public.lp_activity a
    where a.staff = v_staff and a.read_at is null and a.at >= now() - interval '3 days'
    order by a.at desc, a.request_id
    limit 100) t;
  select pg_catalog.left(pg_catalog.md5(coalesce(pg_catalog.string_agg(
           a.request_id::text || ':' || extract(epoch from a.at)::text || ':' || (a.read_at is null)::text,
           ',' order by a.request_id), '')), 16)
    into v_key
  from public.lp_activity a
  where a.staff = v_staff and a.at >= now() - interval '3 days';
  return pg_catalog.jsonb_build_object('count', pg_catalog.cardinality(v_ids), 'ids', pg_catalog.to_jsonb(v_ids), 'key', v_key);
end
$fn$;

revoke all on function public.lp_push_prefs_sync(text, text, boolean, boolean, boolean) from public, anon, authenticated;
revoke all on function public.lp_push_subscribe(text, text, text, text, text, text, text, boolean) from public, anon, authenticated;
revoke all on function public.lp_push_unsubscribe(text, text) from public, anon, authenticated;
revoke all on function public.lp_push_test_target(text, text) from public, anon, authenticated;
revoke all on function public.lp_push_result(text[], text[], text[]) from public, anon, authenticated;
revoke all on function public.lp_push_new_request_staff() from public, anon, authenticated;
revoke all on function public.lp_activity_fallback_staff(uuid) from public, anon, authenticated;
revoke all on function public.lp_activity_record(text[], uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.lp_activity_list(text) from public, anon, authenticated;
revoke all on function public.lp_activity_mark_read(text, uuid) from public, anon, authenticated;
revoke all on function public.lp_activity_unmark(text, uuid[]) from public, anon, authenticated;
revoke all on function public.lp_activity_unread(text) from public, anon, authenticated;

grant execute on function public.lp_push_prefs_sync(text, text, boolean, boolean, boolean) to service_role;
grant execute on function public.lp_push_subscribe(text, text, text, text, text, text, text, boolean) to service_role;
grant execute on function public.lp_push_unsubscribe(text, text) to service_role;
grant execute on function public.lp_push_test_target(text, text) to service_role;
grant execute on function public.lp_push_result(text[], text[], text[]) to service_role;
grant execute on function public.lp_push_new_request_staff() to service_role;
grant execute on function public.lp_activity_fallback_staff(uuid) to service_role;
grant execute on function public.lp_activity_record(text[], uuid, text, text, text) to service_role;
grant execute on function public.lp_activity_list(text) to service_role;
grant execute on function public.lp_activity_mark_read(text, uuid) to service_role;
grant execute on function public.lp_activity_unmark(text, uuid[]) to service_role;
grant execute on function public.lp_activity_unread(text) to service_role;

-- -----------------------------------------------------------------------------------------------------
-- 9. F6 · Inactivity auto-close (Brian 2026-11-06 19:55–20:07; spec §24 A96–A103, design/DECISIONS.md "F6
--    inactivity auto-close"). Friend coming backs up because staff don't tap Reunited, so a request In medical
--    (Friend coming, Friend en route, Friend arrived; the legacy 'Bring friend to medical' too) with NO ACTIVITY
--    for lp_inactive_minutes() closes as 'Closed – Inactive' (grey, closed; Reopen brings it back, lp_set_status).
--    Activity is the request's latest audit_events.occurred_at, else its created_at: every write audits (create,
--    answer, edit, location, photo, message, unsend, en route); reading never does (lp_mark_read and the Activity
--    inbox write no audit row). Never closed: Waiting for check (Needs info and the "Not found yet" hold included,
--    status 'Added') and anything already closed.
--
--    ADDITIVE ONLY: the status value (step 2's CHECK), one new table, new functions, the Reopen move and the counts
--    (sections 6 and 8), and the pg_cron job 'lp-close-inactive' every 5 minutes. The build that is live now keeps
--    working: it shows 'Closed – Inactive' verbatim, grey, closed, with no actions, and never calls the new
--    functions. A re-run keeps every close and notice and leaves exactly one job.
--
--    lp_inactive_closes  one row per auto-close: when, the activity it was measured from (idle_since), and
--                        notified_at: set when the app server claims it to tell the staff involved (once per close,
--                        lp_inactive_claim), or at once for a close it will not tell. Those are a backlog: idle more
--                        than 15 minutes past the limit when closed (the first run after this file, or after the job
--                        was paused), so a deploy never sends a burst of stale alerts; and closes nobody claimed
--                        within 15 minutes.
--    Pause the job:      select cron.unschedule('lp-close-inactive');   (paste this file again to schedule it again)
-- -----------------------------------------------------------------------------------------------------

-- ONE constant for SQL and TypeScript (INACTIVE_MINUTES in lib/domain.ts; a unit test compares them).
create or replace function public.lp_inactive_minutes()
returns integer
language sql
immutable
security invoker
set search_path = public, pg_temp
as $fn$
  select 60
$fn$;

create table if not exists public.lp_inactive_closes (
  request_id uuid not null references public.patients (id) on delete cascade,
  closed_at timestamptz not null,
  idle_since timestamptz not null,
  notified_at timestamptz,
  primary key (request_id, closed_at)
);
create index if not exists lp_inactive_closes_pending_idx on public.lp_inactive_closes (closed_at) where notified_at is null;
alter table public.lp_inactive_closes enable row level security;
revoke all on table public.lp_inactive_closes from public, anon, authenticated;
grant select, insert, update on table public.lp_inactive_closes to service_role;

drop function if exists public.lp_close_inactive();
drop function if exists public.lp_close_inactive(uuid[]);
drop function if exists public.lp_inactive_claim(uuid[]);

-- lp_close_inactive: closes every eligible request in ONE statement and returns how many. For each: status
-- 'Closed – Inactive', closed_at = now, updated_by 'System' (the touch trigger bumps row_version and updated_at,
-- so every phone's next sync has it; F3's trigger clears its en route rows), one audit row status_changed by
-- 'System' {status 'Closed – Inactive', kind 'auto_close', idle_since, inactive_minutes} with the note "No activity
-- for 1 h", and one lp_inactive_closes row. Rows another transaction holds are skipped (SKIP LOCKED: someone is
-- changing them right now) and come up again on the next run. Idempotent: a second call closes nothing more.
--   p_only (tests and manual use): only these requests, when they are eligible. The job passes nothing.
-- SECURITY DEFINER so the pg_cron job (run as the role that scheduled it) needs no table grants; service_role only.
create function public.lp_close_inactive(p_only uuid[] default null)
returns integer
language plpgsql
volatile
security definer
set search_path = public, pg_temp
set statement_timeout = '4s'
set lock_timeout = '2s'
as $fn$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_minutes constant integer := public.lp_inactive_minutes();
  v_cutoff timestamptz := v_now - pg_catalog.make_interval(mins => v_minutes);
  -- A close this far past the limit is a backlog: closed, but nobody is told.
  v_quiet timestamptz := v_now - pg_catalog.make_interval(mins => v_minutes + 15);
  v_note text := 'No activity for ' || case when v_minutes % 60 = 0 then (v_minutes / 60)::text || ' h'
                                             else v_minutes::text || ' min' end;
  v_count integer;
begin
  with eligible as (
    select p.id, p.status, p.found_at, p.reunion_started_at, p.closed_at, p.recheck_at, p.not_found_checks,
           coalesce((select pg_catalog.max(e.occurred_at) from public.audit_events e where e.patient_id = p.id),
                    p.created_at) as idle_since
    from public.patients p
    where p.status in ('Found – Awaiting Reunion', 'Bring friend to medical')
      and (p_only is null or p.id = any (p_only))
      and coalesce((select pg_catalog.max(e.occurred_at) from public.audit_events e where e.patient_id = p.id),
                   p.created_at) < v_cutoff
    for update of p skip locked
  ), closed as (
    update public.patients p
       set status = 'Closed – Inactive',
           closed_at = v_now,
           recheck_at = null,
           updated_by = 'System'
      from eligible el
     where p.id = el.id
    returning p.id, el.status as prev_status, el.found_at, el.reunion_started_at, el.closed_at, el.recheck_at,
              el.not_found_checks, el.idle_since
  ), audited as (
    insert into public.audit_events (patient_id, staff_name, action_type, previous_value, new_value, notes, occurred_at)
    select c.id, 'System', 'status_changed',
           pg_catalog.jsonb_build_object('status', c.prev_status, 'found_at', c.found_at,
             'reunion_started_at', c.reunion_started_at, 'closed_at', c.closed_at,
             'recheck_at', c.recheck_at, 'not_found_checks', c.not_found_checks),
           pg_catalog.jsonb_build_object('status', 'Closed – Inactive', 'kind', 'auto_close',
             'idle_since', c.idle_since, 'inactive_minutes', v_minutes,
             'recheck_at', null, 'not_found_checks', c.not_found_checks),
           v_note, v_now
      from closed c
    returning 1
  ), noted as (
    insert into public.lp_inactive_closes (request_id, closed_at, idle_since, notified_at)
    select c.id, v_now, c.idle_since, case when c.idle_since >= v_quiet then null else v_now end
      from closed c
    on conflict do nothing
    returning 1
  )
  select pg_catalog.count(*)::integer into v_count from closed;

  -- Notices nobody claimed in time are done with (their request was reopened, or no phone synced).
  update public.lp_inactive_closes
     set notified_at = v_now
   where notified_at is null and closed_at <= v_now - interval '15 minutes';

  return v_count;
end
$fn$;

-- lp_inactive_claim: the app server's sync tells the staff involved about an auto-close once (lib/server/
-- inactive-notify.ts). Of the requests in p_ids (≤ 200), it claims every close not told yet, from the last 15
-- minutes, whose request is still 'Closed – Inactive', marking it told in the same statement (SKIP LOCKED: two
-- syncs at once never claim the same close). Returns the claimed request ids (jsonb array).
create function public.lp_inactive_claim(p_ids uuid[])
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
set lock_timeout = '2s'
as $fn$
declare
  v_ids uuid[];
begin
  if p_ids is null or pg_catalog.cardinality(p_ids) = 0 then
    return '[]'::jsonb;
  end if;
  if pg_catalog.cardinality(p_ids) > 200 then
    raise exception using errcode = 'P0422', message = 'too_many_ids', detail = 'field:ids';
  end if;
  with claimable as (
    select c.request_id, c.closed_at
      from public.lp_inactive_closes c
      join public.patients p on p.id = c.request_id
     where c.notified_at is null
       and c.request_id = any (p_ids)
       and c.closed_at > pg_catalog.clock_timestamp() - interval '15 minutes'
       and p.status = 'Closed – Inactive'
    for update of c skip locked
  ), done as (
    update public.lp_inactive_closes c
       set notified_at = pg_catalog.clock_timestamp()
      from claimable k
     where c.request_id = k.request_id and c.closed_at = k.closed_at
    returning c.request_id
  )
  select coalesce(pg_catalog.array_agg(distinct d.request_id), '{}'::uuid[]) into v_ids from done d;
  return pg_catalog.to_jsonb(v_ids);
end
$fn$;

revoke all on function public.lp_inactive_minutes() from public, anon, authenticated;
revoke all on function public.lp_close_inactive(uuid[]) from public, anon, authenticated;
revoke all on function public.lp_inactive_claim(uuid[]) from public, anon, authenticated;
grant execute on function public.lp_inactive_minutes() to service_role;
grant execute on function public.lp_close_inactive(uuid[]) to service_role;
grant execute on function public.lp_inactive_claim(uuid[]) to service_role;

-- (F6, Brian 2026-11-07 02:15) Medical staff whose "New requests" switch was never set in the Alerts sheet get it
-- ON now, on every device of theirs (lp_push_prefs_sync keeps it so from here on). Anyone who set it keeps it.
with medical as (
  update public.lp_push_prefs pr
     set new_requests = true, updated_at = now()
   where not pr.new_requests_set
     and not pr.new_requests
     and (pg_catalog.regexp_match(pr.staff, '^(.*) · (.*)$'))[2] = 'medical'
  returning pr.staff
)
update public.lp_push_subscriptions s
   set new_requests = true
 where s.staff in (select m.staff from medical m) and not s.new_requests;

-- The job: every 5 minutes, exactly one 'lp-close-inactive' (any earlier one of that name is unscheduled first).
-- pg_cron is enabled here when the server can run it (Supabase: it is preloaded; this is the Dashboard's Database →
-- Extensions → pg_cron). Where it can't (another database than cron.database_name, a server without it) the file
-- still succeeds: the NOTICE says the job is NOT scheduled, and lp_close_inactive() can be run by hand.
do $cron$
declare
  v_job bigint;
  v_due integer;
begin
  select pg_catalog.count(*)::integer into v_due
    from public.patients p
   where p.status in ('Found – Awaiting Reunion', 'Bring friend to medical')
     and coalesce((select pg_catalog.max(e.occurred_at) from public.audit_events e where e.patient_id = p.id), p.created_at)
         < pg_catalog.clock_timestamp() - pg_catalog.make_interval(mins => public.lp_inactive_minutes());
  raise notice 'lp-close-inactive: % request(s) In medical have had no activity for % min now (the next run closes them).',
    v_due, public.lp_inactive_minutes();

  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron')
     and exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then
    begin
      create extension if not exists pg_cron;
      raise notice 'pg_cron: enabled.';
    exception when others then
      raise notice 'pg_cron: cannot be enabled here (%).', sqlerrm;
    end;
  end if;

  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    raise notice 'lp-close-inactive: NOT scheduled (pg_cron is not available). Enable pg_cron, then paste this file again.';
    return;
  end if;

  perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'lp-close-inactive';
  v_job := cron.schedule('lp-close-inactive', '*/5 * * * *', 'select public.lp_close_inactive()');
  raise notice 'lp-close-inactive: scheduled every 5 minutes (job %). Pause: select cron.unschedule(''lp-close-inactive'');', v_job;
end
$cron$;

notify pgrst, 'reload schema';

commit;
