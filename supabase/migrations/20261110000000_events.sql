-- =====================================================================================================
-- 20261110000000_events.sql — Multi-event foundation, phase 1 (database)
-- Spec: ~/.config/lp-deploy/events-spec-20261109.md ("Model", "Data", "Server").
--
-- PRODUCTION: paste THIS FILE ALONE into the SQL Editor (default postgres role) after
-- 20261109120000_companion_post_event.sql, then deploy the matching build at once (the old build calls RPC
-- signatures this file retires). One transaction: a failure part-way changes nothing. Safe to run twice.
--   1. Dry run: paste the whole file, change the LAST line `commit;` to `rollback;`, run it. No error = good.
--   2. Real run: paste the file again unchanged (ending in `commit;`) and run it.
--   3. Run scripts/bootstrap-events.mjs once (lead passcode, EDC staff password + join link from the env).
--
-- What it does. Existing rows keep every existing column exactly as it is: only the new event_id columns are
-- filled (with the patients triggers switched off for that one UPDATE, so updated_at / row_version stay put).
--   A. Tables: events (one row per event) and lp_org (one row: the Ground Control lead passcode hash). RLS on, no
--      policies, service_role only.
--   B. The EDC event: slug 'edco26', "EDC Orlando", 2026-11-06 … 2026-11-08, America/New_York, stage 'archived',
--      case_seq = its highest case number, records_delete_at NULL. Every existing request belongs to it.
--   C. event_id on patients (NOT NULL, FK), and on the staff/device-keyed tables: audit_events, lp_activity,
--      lp_message_reads, lp_inactive_closes, lp_push_subscriptions, lp_tel_devices, lp_tel_events. Existing rows are
--      backfilled (from their request, else the EDC event), except lp_tel_events: telemetry rows are never rewritten
--      (30-day retention removes them; their CHECKs are NOT VALID); they stay NULL = before events existed.
--      Rows inserted from now on get their event from their request (trigger) or from the RPC.
--   D. Numbering: unique (event_id, case_number) replaces the global unique case_number; the column default
--      (the global sequence) is dropped: lp_create_request takes events.case_seq + 1 under the event's row lock.
--      The sequence itself stays (the rework file's preflight needs it), unused.
--   E. The fixed reporting_location CHECK is dropped: a post is valid when it is one of the event's posts or
--      'Other' (lp_clean_fields(event, …)). Team validity is the app server's (sign-in, against events.teams).
--   F. Write guard: lp_require_writable(event) (stage practice or live, else SQLSTATE P0410 'event_ended'), called
--      first by every write RPC; a BEFORE INSERT/UPDATE/DELETE trigger on patients as the backstop. Read markers,
--      push prefs and telemetry stay writable.
--   G. Every RPC the app server calls takes p_event and only reaches that event's rows. The write and detail RPCs
--      whose bodies needed no change are wrapped (wrapper: guard + "this request is in this event"; the old
--      signature becomes internal, no longer executable by service_role); the list/sync/stats/push/telemetry
--      ones are redefined with the event filter. Old signatures that were redefined are dropped.
--   H. lp_close_inactive closes only live events' requests. Telemetry is on while any event is practice or live
--      (the fixed off_at no longer applies).
--   I. Lead RPCs (events list/create/update, staff password, join link, logo, go live, end, reopen, lead passcode)
--      and lp_stats(p_event, p_range): '1h' | '2h' | '6h' | 'today' | 'event' | 'day:N', in the event's time
--      zone and show day (day_start_hour), post breakdowns as arrays ordered by count (top 4 + 'Other').
--   J. Storage bucket 'event-logos' (private; the app serves logos through its own route).
-- =====================================================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- -----------------------------------------------------------------------------------------------------
-- 0. Preflight
-- -----------------------------------------------------------------------------------------------------
do $pre$
begin
  if pg_catalog.to_regclass('public.patients') is null
     or pg_catalog.to_regprocedure('public.lp_swap(uuid,bigint,text,text,text)') is null
     or pg_catalog.to_regprocedure('public.lp_set_status(uuid,bigint,text,text,text)') is null
     or pg_catalog.to_regclass('public.lp_tel_events') is null
     or pg_catalog.to_regclass('public.lp_activity') is null then
    raise exception 'Preflight failed: the rework, dashboard_v4 and companion migrations must be applied first.';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'patients' and column_name = 'swap_closed') then
    raise exception 'Preflight failed: patients.swap_closed is missing (20261109120000_companion_post_event.sql first).';
  end if;
end
$pre$;

-- -----------------------------------------------------------------------------------------------------
-- A. events, lp_org
-- -----------------------------------------------------------------------------------------------------
create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  name text not null check (pg_catalog.char_length(pg_catalog.btrim(name)) between 1 and 80),
  starts_on date not null,
  ends_on date not null,
  timezone text not null default 'America/New_York' check (pg_catalog.char_length(timezone) between 1 and 64),
  day_start_hour integer not null default 6 check (day_start_hour between 0 and 23),
  stage text not null default 'practice' check (stage in ('practice', 'live', 'archived')),
  logo_path text,
  -- Ordered [{id, label, short}]: label is what patients.reporting_location stores.
  posts jsonb not null default '[]'::jsonb check (pg_catalog.jsonb_typeof(posts) = 'array'),
  main_medical text not null default 'Main Med' check (pg_catalog.char_length(pg_catalog.btrim(main_medical)) between 1 and 40),
  -- Ordered [{id, label, short, medical}]: label is the team stored in the session; at most one medical.
  teams jsonb not null default '[]'::jsonb check (pg_catalog.jsonb_typeof(teams) = 'array'),
  -- Ordered [label]: the "Last seen" chips.
  last_seen jsonb not null default '[]'::jsonb check (pg_catalog.jsonb_typeof(last_seen) = 'array'),
  staff_password_hash text,
  invite_code_sha256 text check (invite_code_sha256 is null or invite_code_sha256 ~ '^[0-9a-f]{64}$'),
  invite_expires_at timestamptz,
  report_to jsonb not null default '[]'::jsonb,
  case_seq bigint not null default 0 check (case_seq >= 0),
  went_live_at timestamptz,
  ended_at timestamptz,
  records_delete_at timestamptz,
  records_deleted_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  -- Bumped by every settings / stage change: GET /api/sync returns it so a client knows to re-read its config.
  updated_at timestamptz not null default pg_catalog.now(),
  constraint events_dates_check check (ends_on >= starts_on)
);

create table if not exists public.lp_org (
  id boolean primary key default true check (id),
  lead_passcode_hash text,
  updated_at timestamptz not null default pg_catalog.now()
);
insert into public.lp_org (id) values (true) on conflict (id) do nothing;

alter table public.events enable row level security;
alter table public.lp_org enable row level security;
revoke all on table public.events, public.lp_org from public, anon, authenticated;
grant select, insert, update on table public.events to service_role;
grant select, insert, update on table public.lp_org to service_role;

-- -----------------------------------------------------------------------------------------------------
-- B. The EDC event (finished: archived; nothing is deleted)
-- -----------------------------------------------------------------------------------------------------
insert into public.events (slug, name, starts_on, ends_on, timezone, day_start_hour, stage, posts, main_medical, teams,
                           last_seen, went_live_at, ended_at, records_delete_at)
select 'edco26', 'EDC Orlando', date '2026-11-06', date '2026-11-08', 'America/New_York', 6, 'archived',
       '[{"id": "fa3", "label": "FA 3 – Kinetic", "short": "FA 3"},
         {"id": "fa4", "label": "FA 4 – Oasis", "short": "FA 4"},
         {"id": "command", "label": "Command", "short": "Command"},
         {"id": "base", "label": "Base", "short": "Base"}]'::jsonb,
       'Main Med',
       '[{"id": "transpo", "label": "GC/HX - Special Operations/Med Transpo", "short": "GCHX Med Transpo", "medical": false},
         {"id": "dispatch", "label": "GC/HX - Dispatch", "short": "Dispatch", "medical": false},
         {"id": "base", "label": "GC/HX - Base", "short": "GCHX Base", "medical": false},
         {"id": "medical", "label": "Medical", "short": "Medical", "medical": true}]'::jsonb,
       '["kineticFIELD", "circuitGROUNDS", "neonGARDEN", "stereoBLOOM", "Taken to medical"]'::jsonb,
       (select pg_catalog.min(p.created_at) from public.patients p),
       pg_catalog.now(),
       null
on conflict (slug) do nothing;

-- -----------------------------------------------------------------------------------------------------
-- C. event_id columns and the backfill
-- -----------------------------------------------------------------------------------------------------
alter table public.patients add column if not exists event_id uuid references public.events (id);
alter table public.audit_events add column if not exists event_id uuid references public.events (id);
alter table public.lp_activity add column if not exists event_id uuid references public.events (id);
alter table public.lp_message_reads add column if not exists event_id uuid references public.events (id);
alter table public.lp_inactive_closes add column if not exists event_id uuid references public.events (id);
alter table public.lp_push_subscriptions add column if not exists event_id uuid references public.events (id);
alter table public.lp_tel_devices add column if not exists event_id uuid references public.events (id);
alter table public.lp_tel_events add column if not exists event_id uuid references public.events (id);

do $backfill$
declare
  v_edc uuid := (select e.id from public.events e where e.slug = 'edco26');
  v_n bigint;
begin
  -- patients: the touch trigger would bump updated_at / row_version, the en route trigger is status-only, and the
  -- guard (section F, on a re-run) would refuse an archived event: none of them may run for this one UPDATE.
  alter table public.patients disable trigger user;
  update public.patients set event_id = v_edc where event_id is null;
  get diagnostics v_n = row_count;
  alter table public.patients enable trigger user;
  raise notice 'events: % request(s) assigned to edco26', v_n;

  update public.audit_events a set event_id = p.event_id from public.patients p where p.id = a.patient_id and a.event_id is null;
  update public.audit_events set event_id = v_edc where event_id is null;
  update public.lp_activity a set event_id = p.event_id from public.patients p where p.id = a.request_id and a.event_id is null;
  update public.lp_message_reads r set event_id = p.event_id from public.patients p where p.id = r.request_id and r.event_id is null;
  update public.lp_inactive_closes c set event_id = p.event_id from public.patients p where p.id = c.request_id and c.event_id is null;
  update public.lp_push_subscriptions set event_id = v_edc where event_id is null;
  update public.lp_tel_devices set event_id = v_edc where event_id is null;

  -- The EDC counter continues after its highest number (only ever moves up).
  update public.events e
     set case_seq = greatest(e.case_seq, coalesce((select pg_catalog.max(p.case_number) from public.patients p where p.event_id = e.id), 0))
   where e.id = v_edc
     and e.case_seq < coalesce((select pg_catalog.max(p.case_number) from public.patients p where p.event_id = e.id), 0);
end
$backfill$;

alter table public.patients alter column event_id set not null;

create index if not exists patients_event_updated_idx on public.patients (event_id, updated_at, id);
create index if not exists audit_events_event_idx on public.audit_events (event_id, occurred_at);
create index if not exists lp_activity_event_staff_idx on public.lp_activity (event_id, staff, at desc);
create index if not exists lp_push_subscriptions_event_idx on public.lp_push_subscriptions (event_id, staff);
create index if not exists lp_tel_events_event_at_idx on public.lp_tel_events (event_id, at);

-- Rows keyed by a request take their event from it.
create or replace function public.lp_event_from_request()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_request uuid;
begin
  if new.event_id is null then
    v_request := case tg_table_name when 'audit_events' then (pg_catalog.to_jsonb(new) ->> 'patient_id')::uuid
                                    else (pg_catalog.to_jsonb(new) ->> 'request_id')::uuid end;
    if v_request is not null then
      select p.event_id into new.event_id from public.patients p where p.id = v_request;
    end if;
  end if;
  return new;
end
$fn$;
revoke all on function public.lp_event_from_request() from public, anon, authenticated;

drop trigger if exists lp_audit_events_event on public.audit_events;
create trigger lp_audit_events_event before insert on public.audit_events
  for each row execute function public.lp_event_from_request();
drop trigger if exists lp_activity_event on public.lp_activity;
create trigger lp_activity_event before insert on public.lp_activity
  for each row execute function public.lp_event_from_request();
drop trigger if exists lp_message_reads_event on public.lp_message_reads;
create trigger lp_message_reads_event before insert on public.lp_message_reads
  for each row execute function public.lp_event_from_request();
drop trigger if exists lp_inactive_closes_event on public.lp_inactive_closes;
create trigger lp_inactive_closes_event before insert on public.lp_inactive_closes
  for each row execute function public.lp_event_from_request();

-- -----------------------------------------------------------------------------------------------------
-- D. Per-event numbering
-- -----------------------------------------------------------------------------------------------------
create unique index if not exists patients_event_case_key on public.patients (event_id, case_number);
alter table public.patients drop constraint if exists patients_case_number_key;
alter table public.patients alter column case_number drop default;

-- -----------------------------------------------------------------------------------------------------
-- E. Posts are the event's (validated in lp_clean_fields(p_event, …)), not a fixed CHECK
-- -----------------------------------------------------------------------------------------------------
alter table public.patients drop constraint if exists patients_reporting_location_check;

-- -----------------------------------------------------------------------------------------------------
-- F. The write guard
-- -----------------------------------------------------------------------------------------------------
-- lp_require_writable: the event must exist (else P0002) and be practice or live (else P0410 event_ended, which the
-- app server answers with HTTP 410). It takes a row lock on the event so a write and a stage change (go live, end)
-- never interleave: FOR SHARE for ordinary writes (they run side by side), FOR UPDATE for a create (its case number
-- comes from the same row) and for the stage changes themselves.
create or replace function public.lp_require_writable(p_event uuid, p_exclusive boolean default false)
returns void
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_stage text;
begin
  if p_event is null then
    raise exception using errcode = 'P0002', message = 'not_found', detail = 'field:event';
  end if;
  if coalesce(p_exclusive, false) then
    select e.stage into v_stage from public.events e where e.id = p_event for update;
  else
    select e.stage into v_stage from public.events e where e.id = p_event for share;
  end if;
  if v_stage is null then
    raise exception using errcode = 'P0002', message = 'not_found', detail = 'field:event';
  end if;
  if v_stage not in ('practice', 'live') then
    raise exception using errcode = 'P0410', message = 'event_ended';
  end if;
end
$fn$;

-- lp_require_event_row: the request must be in the event (else P0002 not_found, exactly as a missing id).
create or replace function public.lp_require_event_row(p_event uuid, p_request uuid)
returns void
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $fn$
begin
  if p_event is null or p_request is null
     or not exists (select 1 from public.patients p where p.id = p_request and p.event_id = p_event) then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;
end
$fn$;

-- The backstop: nothing writes a request of an archived event, whoever calls (a cron job, a hand-written UPDATE);
-- and a request never moves to another event.
create or replace function public.lp_patients_writable()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_event uuid := case when tg_op = 'DELETE' then old.event_id else new.event_id end;
begin
  if tg_op = 'UPDATE' and old.event_id is not null and new.event_id is distinct from old.event_id then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:event_id';
  end if;
  if exists (select 1 from public.events e where e.id = v_event and e.stage = 'archived') then
    raise exception using errcode = 'P0410', message = 'event_ended';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$fn$;
revoke all on function public.lp_patients_writable() from public, anon, authenticated;

drop trigger if exists lp_patients_writable on public.patients;
create trigger lp_patients_writable before insert or update or delete on public.patients
  for each row execute function public.lp_patients_writable();

-- -----------------------------------------------------------------------------------------------------
-- G0. lp_clean_fields: the fixed post list goes (the event decides)
-- -----------------------------------------------------------------------------------------------------
create or replace function public.lp_clean_fields(p jsonb, p_partial boolean)
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
      when 'friend_in_medical' then 10
      when 'friend_in_medical_name' then 60
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

    if v_key in ('medical_location', 'friend_in_medical_name') and v_text is not null then
      v_text := pg_catalog.btrim(v_text, E' \t\r\n');
    end if;

    if v_text is not null and pg_catalog.char_length(v_text) > v_limit then
      raise exception using errcode = 'P0422', message = 'field_too_long', detail = pg_catalog.format('field:%s', v_key);
    end if;

    -- (Companion) yes | no | unsure; null (or '') reads as unsure.
    if v_key = 'friend_in_medical' then
      v_text := coalesce(v_text, 'unsure');
      if v_text not in ('yes', 'no', 'unsure') then
        raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:friend_in_medical';
      end if;
    end if;

    -- (Events) Which posts are valid is the event's (lp_clean_fields(p_event, …)); here only "not blank".
    if v_key = 'reporting_location' and v_text is null then
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

-- lp_clean_fields(p_event, …): lp_clean_fields plus the event's posts. A post is valid when it is the label of one of
-- the event's posts, or 'Other' (with its other_location, checked by the callers as before).
create or replace function public.lp_clean_fields(p_event uuid, p jsonb, p_partial boolean)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_out jsonb := public.lp_clean_fields(p, p_partial);
  v_post text := v_out ->> 'reporting_location';
begin
  if v_out ? 'reporting_location' and v_post is distinct from 'Other'
     and not exists (select 1 from public.events e cross join lateral pg_catalog.jsonb_array_elements(e.posts) as x(post)
                      where e.id = p_event and x.post ->> 'label' = v_post) then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:reporting_location';
  end if;
  return v_out;
end
$fn$;

-- -----------------------------------------------------------------------------------------------------
-- G1. lp_create_request(p_event, …): the request belongs to the event; its number is the event's next one.
-- -----------------------------------------------------------------------------------------------------
drop function if exists public.lp_create_request(jsonb, text);
create or replace function public.lp_create_request(p_event uuid, p jsonb, p_staff text)
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
  v_case bigint;
begin
  perform public.lp_require_staff(p_staff);
  -- Stage check and the event's row lock (FOR UPDATE): creates in one event take their numbers one at a time.
  perform public.lp_require_writable(p_event, true);

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

  -- 1. Already created (a retry): return it unchanged. Read after the lock, so an identical create that was
  --    running in parallel has committed by now. Another event's request is never returned.
  select * into v_row from public.patients where client_mutation_id = v_cmid;
  if v_row.id is not null then
    if v_row.event_id <> p_event then
      raise exception using errcode = 'P0002', message = 'not_found';
    end if;
    return pg_catalog.jsonb_build_object('created', false, 'row', public.lp_row(v_row));
  end if;

  -- 2. Validate. A new request has no medical location yet (it is set once medical has the patient).
  if p ? 'medical_location' then
    raise exception using errcode = 'P0422', message = 'unknown_field', detail = 'field:medical_location';
  end if;
  v_fields := public.lp_clean_fields(p_event, p - 'client_mutation_id', false);

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

  -- 3. The event's next number (the row is already locked), then the insert.
  update public.events set case_seq = case_seq + 1 where id = p_event returning case_seq into v_case;

  begin
    insert into public.patients as t (
      event_id, case_number,
      client_mutation_id, first_name, last_name, age, gender, height_build, hair, identifying_features,
      physical_description, last_seen, clothing, additional_notes, reporting_location, other_location,
      contact_name, contact_phone, contact_relationship, contact_notes, status, created_by, updated_by,
      friend_in_medical, friend_in_medical_name
    ) values (
      p_event, v_case,
      v_cmid, v_new.first_name, v_new.last_name, v_new.age, v_new.gender, v_new.height_build, v_new.hair,
      v_new.identifying_features, v_new.physical_description, v_new.last_seen, v_new.clothing,
      v_new.additional_notes, v_new.reporting_location, v_new.other_location, v_new.contact_name,
      v_new.contact_phone, v_new.contact_relationship, v_new.contact_notes, 'Added', p_staff, p_staff,
      coalesce(v_new.friend_in_medical, 'unsure'),
      case when coalesce(v_new.friend_in_medical, 'unsure') = 'yes' then v_new.friend_in_medical_name end
    )
    on conflict (client_mutation_id) do nothing
    returning t.* into v_row;
  exception when check_violation or not_null_violation then
    raise exception using errcode = 'P0422', message = 'rejected_by_constraint';
  end;

  if v_row.id is null then
    -- Only another event's create with the same client id can get here (this event's are serialised above).
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;

  insert into public.audit_events (patient_id, event_id, staff_name, action_type, previous_value, new_value)
  values (
    v_row.id, p_event, p_staff, 'patient_created', null,
    pg_catalog.jsonb_build_object('reporting_location', v_row.reporting_location, 'other_location', v_row.other_location)
  );

  return pg_catalog.jsonb_build_object('created', true, 'row', public.lp_row(v_row));
end
$fn$;

-- -----------------------------------------------------------------------------------------------------
-- G2. Wrappers: the guard and "this request is in this event", then the unchanged function. SECURITY DEFINER
-- because the old signature is no longer executable by service_role (section K): the app server can only reach a
-- request through its event.
-- -----------------------------------------------------------------------------------------------------
create or replace function public.lp_update_fields(p_event uuid, p_id uuid, p_patch jsonb, p_expected_version bigint, p_staff text)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp
as $fn$
begin
  perform public.lp_require_writable(p_event);
  perform public.lp_require_event_row(p_event, p_id);
  -- The event's posts (the inner lp_clean_fields only checks "not blank").
  perform public.lp_clean_fields(p_event, p_patch, true);
  return public.lp_update_fields(p_id, p_patch, p_expected_version, p_staff);
end
$fn$;

create or replace function public.lp_set_status(p_event uuid, p_id uuid, p_expected_version bigint, p_status text, p_staff text, p_kind text)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp
as $fn$
begin
  perform public.lp_require_writable(p_event);
  perform public.lp_require_event_row(p_event, p_id);
  return public.lp_set_status(p_id, p_expected_version, p_status, p_staff, p_kind);
end
$fn$;

create or replace function public.lp_cancel(p_event uuid, p_id uuid, p_expected_version bigint, p_staff text)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp
as $fn$
begin
  perform public.lp_require_writable(p_event);
  perform public.lp_require_event_row(p_event, p_id);
  return public.lp_cancel(p_id, p_expected_version, p_staff);
end
$fn$;

create or replace function public.lp_swap(p_event uuid, p_id uuid, p_expected_version bigint, p_action text, p_place text, p_staff text)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp
as $fn$
begin
  perform public.lp_require_writable(p_event);
  perform public.lp_require_event_row(p_event, p_id);
  return public.lp_swap(p_id, p_expected_version, p_action, p_place, p_staff);
end
$fn$;

create or replace function public.lp_set_enroute(p_event uuid, p_request uuid, p_action text, p_eta_offset_seconds integer,
                                                 p_eta_at timestamptz, p_eta_minutes integer, p_staff text)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp
as $fn$
begin
  perform public.lp_require_writable(p_event);
  perform public.lp_require_event_row(p_event, p_request);
  return public.lp_set_enroute(p_request, p_action, p_eta_offset_seconds, p_eta_at, p_eta_minutes, p_staff);
end
$fn$;

create or replace function public.lp_add_photo(p_event uuid, p_id uuid, p_photo_id uuid, p_path text, p_thumb text, p_timing text, p_staff text)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp
as $fn$
begin
  perform public.lp_require_writable(p_event);
  perform public.lp_require_event_row(p_event, p_id);
  return public.lp_add_photo(p_id, p_photo_id, p_path, p_thumb, p_timing, p_staff);
end
$fn$;

create or replace function public.lp_post_message(p_event uuid, p_request uuid, p_body text, p_client_mutation_id uuid, p_staff text, p_team text)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp
as $fn$
begin
  perform public.lp_require_writable(p_event);
  perform public.lp_require_event_row(p_event, p_request);
  return public.lp_post_message(p_request, p_body, p_client_mutation_id, p_staff, p_team);
end
$fn$;

create or replace function public.lp_unsend_message(p_event uuid, p_request uuid, p_message uuid, p_staff text)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp
as $fn$
begin
  perform public.lp_require_writable(p_event);
  perform public.lp_require_event_row(p_event, p_request);
  return public.lp_unsend_message(p_request, p_message, p_staff);
end
$fn$;

-- Reads and read markers: the event check only (they keep working after the event ended).
create or replace function public.lp_detail(p_event uuid, p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $fn$
begin
  perform public.lp_require_event_row(p_event, p_id);
  return public.lp_detail(p_id);
end
$fn$;

create or replace function public.lp_messages_thread(p_event uuid, p_request uuid, p_staff text, p_before_at timestamptz default null,
                                                     p_before_id uuid default null, p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $fn$
begin
  perform public.lp_require_event_row(p_event, p_request);
  return public.lp_messages_thread(p_request, p_staff, p_before_at, p_before_id, p_limit);
end
$fn$;

create or replace function public.lp_mark_read(p_event uuid, p_request uuid, p_staff text, p_upto timestamptz default null)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp
as $fn$
begin
  perform public.lp_require_event_row(p_event, p_request);
  return public.lp_mark_read(p_request, p_staff, p_upto);
end
$fn$;

create or replace function public.lp_involved_staff(p_event uuid, p_request uuid)
returns setof text language plpgsql stable security definer set search_path = public, pg_temp
as $fn$
begin
  perform public.lp_require_event_row(p_event, p_request);
  return query select s from public.lp_involved_staff(p_request) as s;
end
$fn$;

create or replace function public.lp_activity_fallback_staff(p_event uuid, p_request uuid)
returns text[] language plpgsql stable security definer set search_path = public, pg_temp
as $fn$
begin
  perform public.lp_require_event_row(p_event, p_request);
  return public.lp_activity_fallback_staff(p_request);
end
$fn$;

-- -----------------------------------------------------------------------------------------------------
-- G3. Redefined with the event filter (old signatures dropped)
-- -----------------------------------------------------------------------------------------------------
drop function if exists public.lp_sync(timestamptz, uuid[], boolean, timestamptz, uuid, integer);
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
create or replace function public.lp_sync(
  p_event uuid,
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
    where p.id = any (p_ids) and p.event_id = p_event;
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
        where p.event_id = p_event
          and (p_since is null or p.updated_at > p_since - interval '30 seconds')
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
    'next', v_next,
    -- (Events) The event's stage and config version: the client re-reads its config when the version moves, and an
    -- archived stage means the event ended.
    'event', (select pg_catalog.jsonb_build_object('id', e.id, 'stage', e.stage, 'version', e.updated_at)
                from public.events e where e.id = p_event)
  );

  if coalesce(p_reconcile, false) then
    v_result := v_result || pg_catalog.jsonb_build_object(
      'versions',
      (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(p.id, p.row_version) order by p.id), '[]'::jsonb)
       from public.patients p where p.event_id = p_event)
    );
  end if;

  return v_result;
end
$fn$;


-- lp_messages_activity: what the lists show of a request's thread, for the caller: message count, the latest
-- message (first 120 characters, the card preview), unread (other people's messages after the caller's read
-- cursor), needs_info (Waiting for check, the latest message is from the Medical team, and it was written
-- after the request's last status change: a front-of-house reply or any status change clears it), involved
-- (the caller is in lp_involved_staff: the in-app alert) and the en route summary. Unsent messages never
-- count. Internal helper.
create or replace function public.lp_messages_activity(p_request uuid, p_key text, p_status text)
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

  -- (Events) "Medical asked" = the message came from the event's medical team (teams[].medical), not the word Medical.
  if p_status = 'Added' and v_last.id is not null and exists (
       select 1 from public.patients pt join public.events ev on ev.id = pt.event_id
              cross join lateral pg_catalog.jsonb_array_elements(ev.teams) as t(team)
        where pt.id = p_request and (t.team ->> 'medical')::boolean
          and pg_catalog.lower(t.team ->> 'label') = pg_catalog.lower(pg_catalog.btrim(v_last.team))) then
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

drop function if exists public.lp_messages_sync(text, uuid[], timestamptz, boolean);
-- lp_messages_sync: the thread activity /api/sync attaches to its rows, for the caller.
--   threads: {id, …lp_messages_activity} for every id in p_ids that has any message or en route, and, with
--            p_changed, every request whose thread changed since p_since − 30 s (a message posted or unsent,
--            an en route event, the caller's own read on another device).
--   rows:    lp_row of those changed requests that are not in p_ids (their patients row did not change, so
--            lp_sync did not return them).
-- Requests with neither messages nor en route are left out (the server fills the empty activity).
-- Returns {threads, rows}.
create or replace function public.lp_messages_sync(p_event uuid, p_staff text, p_ids uuid[], p_since timestamptz, p_changed boolean)
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
  where p.event_id = p_event
    and (p.id in (select a.id from active a)
         or (p.id in (select c.id from changed c where c.id is not null)
             and not (p.id = any (v_ids))
             and p.updated_at <= v_from));

  return pg_catalog.jsonb_build_object('threads', v_threads, 'rows', v_rows);
end
$fn$;

drop function if exists public.lp_activity_list(text);
-- lp_activity_list: the staff member's Activity, newest first (the latest 100 of the last 3 days), with each
-- request's name (line 1 shows its initials) and status. Returns {serverTime, rows: [...]}.
create or replace function public.lp_activity_list(p_event uuid, p_staff text)
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
    where a.event_id = p_event and a.staff = public.lp_canon_staff(p_staff) and a.at >= now() - interval '3 days'
    order by a.at desc, a.request_id
    limit 100) t;
  return pg_catalog.jsonb_build_object('serverTime', pg_catalog.clock_timestamp(), 'rows', v_rows);
end
$fn$;

drop function if exists public.lp_activity_unread(text);
-- lp_activity_unread: what the bell counts (unread requests, newest first, in the 3-day window), and a
-- fingerprint of the staff member's Activity (16 hex characters) that moves whenever a row is added, changed
-- or read: sync carries {count, key} only, and the client asks for the ids and the list when the key moves.
-- Returns {count, ids, key}.
create or replace function public.lp_activity_unread(p_event uuid, p_staff text)
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
    where a.event_id = p_event and a.staff = v_staff and a.read_at is null and a.at >= now() - interval '3 days'
    order by a.at desc, a.request_id
    limit 100) t;
  select pg_catalog.left(pg_catalog.md5(coalesce(pg_catalog.string_agg(
           a.request_id::text || ':' || extract(epoch from a.at)::text || ':' || (a.read_at is null)::text,
           ',' order by a.request_id), '')), 16)
    into v_key
  from public.lp_activity a
  where a.event_id = p_event and a.staff = v_staff and a.at >= now() - interval '3 days';
  return pg_catalog.jsonb_build_object('count', pg_catalog.cardinality(v_ids), 'ids', pg_catalog.to_jsonb(v_ids), 'key', v_key);
end
$fn$;

drop function if exists public.lp_activity_mark_read(text, uuid);
-- lp_activity_mark_read: the request was opened (p_request), or Mark all read (p_request null). Returns
-- {count, ids}: the rows that turned read (Undo sends them back to lp_activity_unmark).
create or replace function public.lp_activity_mark_read(p_event uuid, p_staff text, p_request uuid)
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
     where a.event_id = p_event
       and a.staff = public.lp_canon_staff(p_staff)
       and a.read_at is null
       and (p_request is null or a.request_id = p_request)
    returning a.request_id)
  select coalesce(pg_catalog.array_agg(request_id), '{}'::uuid[]) into v_ids from done;
  return pg_catalog.jsonb_build_object('count', pg_catalog.cardinality(v_ids), 'ids', pg_catalog.to_jsonb(v_ids));
end
$fn$;

drop function if exists public.lp_activity_unmark(text, uuid[]);
-- lp_activity_unmark: Undo of Mark all read. Those rows are unread again (a row a newer event already made
-- unread is left as it is). Returns how many changed.
create or replace function public.lp_activity_unmark(p_event uuid, p_staff text, p_requests uuid[])
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
   where a.event_id = p_event
     and a.staff = public.lp_canon_staff(p_staff)
     and a.request_id = any (coalesce(p_requests, '{}'::uuid[]))
     and a.read_at is not null;
  get diagnostics v_count = row_count;
  return v_count;
end
$fn$;

drop function if exists public.lp_activity_record(text[], uuid, text, text, text);
create or replace function public.lp_activity_record(p_event uuid, p_recipients text[], p_request uuid, p_kind text, p_actor text, p_detail text)
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
  v_rows text[];
  v_patient public.patients;
  v_targets jsonb;
  v_unread jsonb;
begin
  if p_kind is null or p_kind not in ('message', 'enroute', 'enroute_changed', 'enroute_cancelled', 'arrived', 'new_request',
      'in_medical', 'not_in_medical', 'back_to_waiting', 'moved', 'reunited', 'discharged', 'cancelled', 'edited',
      -- (F6) The inactivity auto-close (section 9), told by the app server once per close.
      'closed_inactive',
      -- (Companion) Already accompanied, the friend swap, Friend informed.
      'accompanied', 'swap_requested', 'swap_approved', 'swap_declined', 'friend_informed',
      -- (Companion follow-up) A swap request or an approved swap called off.
      'swap_cancelled') then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:kind';
  end if;
  -- (Events) A request of another event is treated as missing: nothing is written, nobody is pushed.
  select * into v_patient from public.patients where id = p_request and event_id = p_event;
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

  -- (F6 7b) Who gets an Activity row: everyone, except for a new request the staff on by the Medical default alone.
  if p_kind = 'new_request' then
    select coalesce(pg_catalog.array_agg(s), '{}'::text[]) into v_rows
    from pg_catalog.unnest(v_staff) s
    where not exists (select 1 from public.lp_push_prefs pr where pr.staff = s and pr.new_requests_team_default);
  else
    v_rows := v_staff;
  end if;

  insert into public.lp_activity as a (staff, request_id, event_id, kind, actor, detail, at, read_at)
  select s, p_request, p_event, p_kind, pg_catalog.left(coalesce(p_actor, ''), 200), pg_catalog.left(coalesce(p_detail, ''), 200), now(), null
  from pg_catalog.unnest(v_rows) s
  on conflict (staff, request_id) do update set
    kind = excluded.kind, actor = excluded.actor, detail = excluded.detail, at = excluded.at, read_at = null;

  delete from public.lp_activity a
  where a.staff = any (v_rows)
    and a.event_id = p_event
    and (a.at < now() - interval '3 days'
      or (a.staff, a.request_id) not in (
        select b.staff, b.request_id from (
          select x.staff, x.request_id, pg_catalog.row_number() over (partition by x.staff order by x.at desc, x.request_id) as n
          from public.lp_activity x where x.staff = any (v_rows) and x.event_id = p_event) b
        where b.n <= 100));

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth, 'staff', s.staff) order by s.id), '[]'::jsonb)
    into v_targets
  from public.lp_push_subscriptions s
  where s.staff = any (v_staff)
    -- (Events) Only devices signed in to this event.
    and s.event_id = p_event
    and case when p_kind = 'new_request' then s.new_requests else s.my_updates end;

  select coalesce(pg_catalog.jsonb_object_agg(u.staff, u.n), '{}'::jsonb) into v_unread
  from (
    select a.staff, pg_catalog.count(*) as n from public.lp_activity a
    where a.staff = any (v_staff) and a.event_id = p_event and a.read_at is null and a.at >= now() - interval '3 days'
    group by a.staff) u;

  return pg_catalog.jsonb_build_object('written', pg_catalog.to_jsonb(v_rows), 'targets', v_targets, 'unread', v_unread,
    'firstName', v_patient.first_name, 'lastName', v_patient.last_name);
end
$fn$;

drop function if exists public.lp_push_new_request_staff();
-- lp_push_new_request_staff: everyone whose "New requests" switch is on (canonical staff strings).
create or replace function public.lp_push_new_request_staff(p_event uuid)
returns text[]
language plpgsql
stable
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
as $fn$
begin
  -- (Events) The prefs are global; the people are this event's: a device signed in to it (push subscription), an
  -- Activity row in it, or anything they did in it (audit trail, messages).
  return coalesce((
    select pg_catalog.array_agg(pr.staff order by pr.staff)
    from public.lp_push_prefs pr
    where pr.new_requests
      and (exists (select 1 from public.lp_push_subscriptions s where s.event_id = p_event and s.staff = pr.staff)
        or exists (select 1 from public.lp_activity a where a.event_id = p_event and a.staff = pr.staff)
        or exists (select 1 from public.audit_events e where e.event_id = p_event and public.lp_canon_staff(e.staff_name) = pr.staff)
        or exists (select 1 from public.lp_messages m join public.patients p on p.id = m.request_id
                    where p.event_id = p_event and m.staff_key = pr.staff))), '{}'::text[]);
end
$fn$;

drop function if exists public.lp_push_subscribe(text, text, text, text, text, text, text, boolean);
-- lp_push_subscribe: stores (or re-binds) this device's subscription for p_staff, with the staff member's
-- switches. One row per endpoint, so one subscription per device; a different staff on the same phone takes
-- the row over. p_old_endpoint (the browser rotated the subscription): that row goes, only when it is this
-- staff member's. At most 10 devices per staff member (the least recently confirmed go).
-- Returns {newRequests, myUpdates}.
create or replace function public.lp_push_subscribe(
  p_event uuid,
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

  insert into public.lp_push_subscriptions as s (event_id, endpoint, p256dh, auth, staff, team, user_agent, new_requests, my_updates)
  values (
    p_event, p_endpoint, p_p256dh, p_auth, v_staff, pg_catalog.left(pg_catalog.btrim(coalesce(p_team, '')), 120),
    pg_catalog.left(p_user_agent, 300), (v_prefs ->> 'newRequests')::boolean, (v_prefs ->> 'myUpdates')::boolean)
  on conflict (endpoint) do update set
    event_id = excluded.event_id,
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

drop function if exists public.lp_enroute_stats();
-- lp_enroute_stats: the dashboard's "Friends en route" (requests In medical with someone en route now and
-- nobody arrived yet) and
-- "Time to arrive" (mean minutes from going en route to Arrived, over arrivals in the last 2 hours, 1 decimal;
-- null when none). An arrival is measured from the same staff's latest 'enroute' event on the request before
-- it: a changed ETA does not restart the clock, a cancel and a new en route does. /api/stats merges it into
-- lp_stats (additive fields: friendsEnRoute, avgArriveMinutes).
create or replace function public.lp_enroute_stats(p_event uuid)
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
    where p.event_id = p_event and p.status in ('Found – Awaiting Reunion', 'Bring friend to medical')
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
    where a.event_id = p_event and a.action_type = 'enroute' and a.new_value ->> 'state' = 'arrived'
      and a.occurred_at > v_now - interval '2 hours' and a.occurred_at <= v_now
  ) as x
  where x.started_at is not null;

  return pg_catalog.jsonb_build_object('friendsEnRoute', v_friends, 'avgArriveMinutes', v_avg);
end
$fn$;

drop function if exists public.lp_inactive_claim(uuid[]);
-- lp_inactive_claim: the app server's sync tells the staff involved about an auto-close once (lib/server/
-- inactive-notify.ts). Of the requests in p_ids (≤ 200), it claims every close not told yet, from the last 15
-- minutes, whose request is still 'Closed – Inactive', marking it told in the same statement (SKIP LOCKED: two
-- syncs at once never claim the same close). Returns the claimed request ids (jsonb array).
create or replace function public.lp_inactive_claim(p_event uuid, p_ids uuid[])
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
       and p.event_id = p_event
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


create or replace function public.lp_close_inactive(p_only uuid[] default null)
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
    where p.status in ('Found – Awaiting Reunion', 'Bring friend to medical', 'Found – Accompanied')
      -- (Events) Live events only: practice rows are deleted at go live, archived ones are frozen.
      and p.event_id in (select e.id from public.events e where e.stage = 'live')
      and (p_only is null or p.id = any (p_only))
      and coalesce((select pg_catalog.max(e.occurred_at) from public.audit_events e where e.patient_id = p.id),
                   p.created_at) < v_cutoff
    for update of p skip locked
  ), closed as (
    update public.patients p
       set status = 'Closed – Inactive',
           closed_at = v_now,
           recheck_at = null,
           swap_requested_at = null,
           swap_requested_by = null,
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
    insert into public.lp_inactive_closes (request_id, closed_at, idle_since, notified_at, quiet)
    select c.id, v_now, c.idle_since, case when c.idle_since >= v_quiet then null else v_now end, c.idle_since < v_quiet
      from closed c
    on conflict do nothing
    returning 1
  )
  select pg_catalog.count(*)::integer into v_count from closed;

  -- Notices nobody claimed in time are done with (their request was reopened, or no phone synced).
  update public.lp_inactive_closes
     set notified_at = v_now
   where notified_at is null and closed_at <= v_now - interval '15 minutes'
     -- (Events) Only live events' notices: nothing of a finished event changes.
     and event_id in (select e.id from public.events e where e.stage = 'live');

  return v_count;
end
$fn$;


-- lp_tel_config: what the ingest route caches for 30 s. {on, until (epoch ms), cap, capBytes, flushSeconds, sample}.
-- on = enabled and before off_at. No settings row: off.
create or replace function public.lp_tel_config()
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
set lock_timeout = '2s'
as $fn$
declare
  v_set public.lp_tel_settings;
begin
  select * into v_set from public.lp_tel_settings where id;
  if not found then
    return pg_catalog.jsonb_build_object('on', false, 'enabled', false);
  end if;
  return pg_catalog.jsonb_build_object(
    -- (Events) On while any event is practice or live (and the kill switch is not off); off_at no longer applies.
    'on', v_set.enabled and exists (select 1 from public.events e where e.stage in ('practice', 'live')),
    'enabled', v_set.enabled,
    'until', pg_catalog.floor(extract(epoch from v_set.off_at) * 1000)::bigint,
    'cap', v_set.device_hour_cap,
    'capBytes', v_set.device_hour_bytes,
    'flushSeconds', v_set.flush_seconds,
    'sample', v_set.sample);
end
$fn$;

drop function if exists public.lp_tel_ingest(text, text, text, text, bigint, jsonb, jsonb, integer, text);
-- lp_tel_ingest: one batch from one phone, in one statement's worth of work. Off (kill switch, past off_at, no
-- settings row) → {on: false} and nothing is written. A batch id seen before → {dup: true}. Three quota rows count
-- every event and byte offered this hour: the body's device id and the route's sign-in key (p_quota) against the
-- device caps, and '*' against the fleet caps. Past any of them the rest is dropped ({capped: true}). The event time
-- is the phone's plus the route's skew correction, clamped to [now − 2 days, now].
create or replace function public.lp_tel_ingest(p_event uuid, p_batch text, p_device text, p_session text, p_team text, p_skew_ms bigint,
                                     p_ctx jsonb, p_events jsonb, p_bytes integer, p_quota text default null)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
set lock_timeout = '2s'
as $fn$
declare
  v_set public.lp_tel_settings;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_count integer;
  v_prev_events integer;
  v_prev_bytes integer;
  v_allowed integer;
  v_inserted integer := 0;
  v_hour timestamptz := pg_catalog.date_trunc('hour', v_now);
  v_bytes integer := greatest(coalesce(p_bytes, 0), 0);
  v_key text;
  v_cap integer;
  v_cap_bytes integer;
begin
  select * into v_set from public.lp_tel_settings where id;
  if not found or not v_set.enabled or not exists (select 1 from public.events e where e.stage in ('practice', 'live')) then
    return pg_catalog.jsonb_build_object('on', false);
  end if;
  if p_events is null or pg_catalog.jsonb_typeof(p_events) <> 'array' then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:ev';
  end if;
  v_count := pg_catalog.jsonb_array_length(p_events);
  if v_count > 300 then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:ev';
  end if;

  insert into public.lp_tel_batches (id, device) values (p_batch, p_device) on conflict do nothing;
  if not found then
    return pg_catalog.jsonb_build_object('on', true, 'accepted', 0, 'dropped', 0, 'dup', true);
  end if;

  v_allowed := v_count;
  foreach v_key in array array[p_device, nullif(p_quota, p_device), '*'] loop
    continue when v_key is null;
    v_cap := case when v_key = '*' then v_set.fleet_hour_cap else v_set.device_hour_cap end;
    v_cap_bytes := case when v_key = '*' then v_set.fleet_hour_bytes else v_set.device_hour_bytes end;
    insert into public.lp_tel_quota as q (device, hour, events, bytes)
    values (v_key, v_hour, v_count, v_bytes)
    on conflict (device, hour) do update set events = q.events + excluded.events, bytes = q.bytes + excluded.bytes
    returning q.events - v_count, q.bytes - v_bytes into v_prev_events, v_prev_bytes;
    v_allowed := least(v_allowed, case when v_prev_bytes + v_bytes > v_cap_bytes then 0
                                       else greatest(0, v_cap - v_prev_events) end);
  end loop;

  if v_allowed > 0 then
    insert into public.lp_tel_events (event_id, at, device, session, team, name, view, area, ctl, ms, n, ok, props, trail)
    select p_event, least(v_now, greatest(v_now - interval '2 days',
                 pg_catalog.to_timestamp(((x.e ->> 'at')::bigint + coalesce(p_skew_ms, 0)) / 1000.0))),
           p_device, p_session, p_team, x.e ->> 'n', x.e ->> 'v', x.e ->> 'a', x.e ->> 'c',
           (x.e ->> 'ms')::integer, (x.e ->> 'k')::integer, (x.e ->> 'ok')::boolean, x.e -> 'p', x.e -> 'tr'
      from pg_catalog.jsonb_array_elements(p_events) with ordinality as x(e, i)
     where x.i <= v_allowed;
    get diagnostics v_inserted = row_count;
  end if;

  insert into public.lp_tel_devices as d (event_id, device, team, plat, osv, eng, sa, lay, dpr, touch, build, eff, mem, last_session)
  values (p_event, p_device, p_team, p_ctx ->> 'plat', (p_ctx ->> 'osv')::integer, p_ctx ->> 'eng', (p_ctx ->> 'sa')::boolean,
          p_ctx ->> 'lay', (p_ctx ->> 'dpr')::integer, (p_ctx ->> 'touch')::boolean, p_ctx ->> 'build', p_ctx ->> 'eff',
          (p_ctx ->> 'mem')::integer, p_session)
  on conflict (device) do update set event_id = excluded.event_id, team = excluded.team, plat = excluded.plat, osv = excluded.osv, eng = excluded.eng,
     sa = excluded.sa, lay = excluded.lay, dpr = excluded.dpr, touch = excluded.touch, build = excluded.build,
     eff = excluded.eff, mem = excluded.mem, last_seen = v_now, last_session = excluded.last_session;

  return pg_catalog.jsonb_build_object('on', true, 'accepted', v_inserted, 'dropped', v_count - v_inserted,
                                       'capped', v_inserted < v_count);
end
$fn$;

drop function if exists public.lp_tel_server_events(jsonb);
-- lp_tel_server_events: rows the server writes itself (device = session = 'server'): push_send after a push, and
-- tel_switch when collection is turned off from /health (written just before the flip). p_rows = [{n, team, ms, k,
-- ok, p}], ≤ 20. Gated by the same settings check. Returns how many were written.
create or replace function public.lp_tel_server_events(p_event uuid, p_rows jsonb)
returns integer
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
set lock_timeout = '2s'
as $fn$
declare
  v_set public.lp_tel_settings;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_count integer := 0;
begin
  select * into v_set from public.lp_tel_settings where id;
  if not found or not v_set.enabled or not exists (select 1 from public.events e where e.stage in ('practice', 'live')) then
    return 0;
  end if;
  if p_rows is null or pg_catalog.jsonb_typeof(p_rows) <> 'array' or pg_catalog.jsonb_array_length(p_rows) = 0 then
    return 0;
  end if;
  if pg_catalog.jsonb_array_length(p_rows) > 20 then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:rows';
  end if;
  insert into public.lp_tel_events (event_id, at, device, session, team, name, ms, n, ok, props)
  select p_event, v_now, 'server', 'server', x.e ->> 'team', x.e ->> 'n', (x.e ->> 'ms')::integer, (x.e ->> 'k')::integer,
         (x.e ->> 'ok')::boolean, x.e -> 'p'
    from pg_catalog.jsonb_array_elements(p_rows) as x(e)
   where x.e ->> 'n' in ('push_send', 'tel_switch');
  get diagnostics v_count = row_count;
  return v_count;
end
$fn$;

-- (Events) lp_tel_health: every read of telemetry is this event's (14 places).
drop function if exists public.lp_tel_health(text, timestamptz, integer);
-- lp_tel_health: one section of the Health page (/health), events since p_since. Sections: kpis, problems, examples,
-- flows, net, push, coverage, errors. The route asks for them in parallel; one that fails or times out shows "—".
create or replace function public.lp_tel_health(p_event uuid, p_section text, p_since timestamptz, p_limit integer default 50)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
set statement_timeout = '6s'
set lock_timeout = '2s'
as $fn$
declare
  v_frus constant text[] := array['stuck_scroll', 'rage_tap', 'dead_tap', 'loop', 'slow', 'pinch', 'error', 'stuck_send'];
  v_since timestamptz := coalesce(p_since, pg_catalog.now() - interval '1 hour');
  v_prev timestamptz := v_since - (pg_catalog.now() - v_since);
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_out jsonb;
begin
  if p_section = 'kpis' then
    with cur as (
      select pg_catalog.count(distinct e.device) filter (where e.device <> 'server') as devices,
             pg_catalog.count(distinct e.session) filter (where e.device <> 'server') as sessions,
             pg_catalog.count(*) as events,
             pg_catalog.count(*) filter (where e.name = any (v_frus)) as frustrations,
             pg_catalog.count(distinct e.device) filter (where e.name = any (v_frus)) as hit_devices,
             pg_catalog.count(*) filter (where e.name = 'error') as errors,
             pg_catalog.sum(case when e.name = 'sync' and pg_catalog.jsonb_typeof(e.props -> 'ok') = 'number' then (e.props ->> 'ok')::numeric else 0 end) as sync_ok,
             pg_catalog.sum(case when e.name = 'sync' and pg_catalog.jsonb_typeof(e.props -> 'fail') = 'number' then (e.props ->> 'fail')::numeric else 0 end) as sync_fail,
             pg_catalog.count(*) filter (where e.name = 'push_rx') as push_rx,
             pg_catalog.count(*) filter (where e.name = 'notif_click' and e.props ->> 'src' = 'push') as push_opened,
             pg_catalog.percentile_cont(0.95) within group (order by e.ms) filter (where e.name = 'flow_open' and coalesce(e.props ->> 'out', 'ok') = 'ok') as open_p95
        from (select * from public.lp_tel_events x where x.event_id = p_event) e
       where e.at >= v_since
    ), prev as (
      select pg_catalog.count(distinct e.device) filter (where e.device <> 'server') as devices,
             pg_catalog.count(*) filter (where e.name = any (v_frus)) as frustrations,
             pg_catalog.count(distinct e.device) filter (where e.name = any (v_frus)) as hit_devices,
             pg_catalog.count(*) filter (where e.name = 'error') as errors
        from (select * from public.lp_tel_events x where x.event_id = p_event) e
       where e.at >= v_prev and e.at < v_since
    )
    select pg_catalog.jsonb_build_object(
             'devices', c.devices, 'sessions', c.sessions, 'events', c.events, 'frustrations', c.frustrations,
             'hitDevices', c.hit_devices, 'errors', c.errors, 'syncOk', c.sync_ok, 'syncFail', c.sync_fail,
             'pushRx', c.push_rx, 'pushOpened', c.push_opened, 'openP95', c.open_p95,
             'prev', pg_catalog.jsonb_build_object('devices', p.devices, 'frustrations', p.frustrations,
                                                   'hitDevices', p.hit_devices, 'errors', p.errors))
      into v_out
      from cur c, prev p;

  elsif p_section = 'problems' or p_section = 'examples' then
    with top as (
      select e.name, e.view, e.area, e.ctl, pg_catalog.count(*) as n, pg_catalog.count(distinct e.device) as devices,
             pg_catalog.array_agg(distinct e.team) as teams, pg_catalog.max(e.at) as last_at,
             (pg_catalog.array_agg(e.id order by e.at desc))[1:3] as examples
        from (select * from public.lp_tel_events x where x.event_id = p_event) e
       where e.at >= v_since and e.name = any (v_frus)
       group by e.name, e.view, e.area, e.ctl
       order by devices desc, n desc
       limit case when p_section = 'examples' then least(v_limit, 10) else v_limit end
    )
    select case when p_section = 'problems' then
             coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                 'name', t.name, 'view', t.view, 'area', t.area, 'ctl', t.ctl, 'n', t.n, 'devices', t.devices,
                 'teams', pg_catalog.to_jsonb(t.teams), 'lastAt', t.last_at, 'examples', pg_catalog.to_jsonb(t.examples))
                 order by t.devices desc, t.n desc) from top t), '[]'::jsonb)
           else
             coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                 'id', e.id, 'name', e.name, 'at', e.at, 'team', e.team, 'view', e.view, 'area', e.area, 'ctl', e.ctl,
                 'ms', e.ms, 'k', e.n, 'props', e.props, 'trail', e.trail) order by e.at desc)
                from (select * from public.lp_tel_events x where x.event_id = p_event) e
               where e.id in (select pg_catalog.unnest(t.examples) from top t)), '[]'::jsonb)
           end
      into v_out;

  elsif p_section = 'flows' then
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name', f.name, 'out', f.out, 'n', f.n, 'p50', f.p50, 'p95', f.p95)
                                         order by f.name, f.n desc), '[]'::jsonb)
      into v_out
      from (
        select e.name, coalesce(e.props ->> 'out', 'ok') as out, pg_catalog.count(*) as n,
               pg_catalog.percentile_cont(0.5) within group (order by e.ms) as p50,
               pg_catalog.percentile_cont(0.95) within group (order by e.ms) as p95
          from (select * from public.lp_tel_events x where x.event_id = p_event) e
         where e.at >= v_since and e.name like 'flow\_%' and e.ms is not null
         group by 1, 2
      ) f;

  elsif p_section = 'net' then
    with r as (
      select e.area as pattern, e.props ->> 'm' as m, e.props ->> 'st' as st,
             case when e.props ->> 'on' = 'false' then 'link_down' else coalesce(e.props ->> 'conn', 'unk') end as state,
             coalesce(e.n, 0) as n
        from (select * from public.lp_tel_events x where x.event_id = p_event) e
       where e.at >= v_since and e.name = 'net'
    ), durs as (
      select e.area as pattern, e.props ->> 'm' as m, d.v::numeric as ms
        from (select * from public.lp_tel_events x where x.event_id = p_event) e
       cross join lateral pg_catalog.jsonb_array_elements_text(
               case when pg_catalog.jsonb_typeof(e.props -> 'd') = 'array' then e.props -> 'd' else '[]'::jsonb end) as d(v)
       where e.at >= v_since and e.name = 'net' and e.props ->> 'st' = '2xx'
    ), pct as (
      select pattern, m, pg_catalog.percentile_cont(0.5) within group (order by ms) as p50,
             pg_catalog.percentile_cont(0.95) within group (order by ms) as p95
        from durs group by 1, 2
    ), st as (
      select pattern, m, state, pg_catalog.sum(n) as n, pg_catalog.sum(n) filter (where r.st in ('5xx', 'net', 'timeout')) as failed
        from r group by 1, 2, 3
    ), agg as (
      select pattern, m, pg_catalog.sum(n) as n,
             coalesce(pg_catalog.sum(n) filter (where r.st in ('5xx', 'net', 'timeout')), 0) as failed,
             coalesce(pg_catalog.sum(n) filter (where r.st = 'timeout'), 0) as timeouts,
             coalesce(pg_catalog.sum(n) filter (where r.st in ('4xx', '401', '409', '429')), 0) as c4xx
        from r group by 1, 2 order by 3 desc limit v_limit
    ), sync as (
      select pg_catalog.sum(case when pg_catalog.jsonb_typeof(e.props -> 'ok') = 'number' then (e.props ->> 'ok')::numeric else 0 end) as ok,
             pg_catalog.sum(case when pg_catalog.jsonb_typeof(e.props -> 'fail') = 'number' then (e.props ->> 'fail')::numeric else 0 end) as fail,
             pg_catalog.sum(case when pg_catalog.jsonb_typeof(e.props -> 'full') = 'number' then (e.props ->> 'full')::numeric else 0 end) as full_n,
             pg_catalog.percentile_cont(0.95) within group (order by (case when pg_catalog.jsonb_typeof(e.props -> 'age') = 'number' then (e.props ->> 'age')::numeric end)) as age_p95
        from (select * from public.lp_tel_events x where x.event_id = p_event) e
       where e.at >= v_since and e.name = 'sync'
    )
    select pg_catalog.jsonb_build_object(
             'rows', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                 'pattern', a.pattern, 'm', a.m, 'n', a.n, 'failed', a.failed, 'timeouts', a.timeouts, 'c4xx', a.c4xx,
                 'p50', p.p50, 'p95', p.p95,
                 'states', (select pg_catalog.jsonb_object_agg(s.state, pg_catalog.jsonb_build_object('n', s.n, 'failed', coalesce(s.failed, 0)))
                              from st s where s.pattern is not distinct from a.pattern and s.m is not distinct from a.m))
                 order by a.n desc)
               from agg a left join pct p on p.pattern is not distinct from a.pattern and p.m is not distinct from a.m), '[]'::jsonb),
             'sync', (select pg_catalog.jsonb_build_object('ok', s.ok, 'fail', s.fail, 'full', s.full_n, 'ageP95', s.age_p95) from sync s))
      into v_out;

  elsif p_section = 'push' then
    with sent as (
      select e.props ->> 'kind' as kind,
             pg_catalog.sum(case when pg_catalog.jsonb_typeof(e.props -> 'ok') = 'number' then (e.props ->> 'ok')::numeric else 0 end) as ok,
             pg_catalog.sum(case when pg_catalog.jsonb_typeof(e.props -> 'gone') = 'number' then (e.props ->> 'gone')::numeric else 0 end) as gone,
             pg_catalog.sum(case when pg_catalog.jsonb_typeof(e.props -> 'failed') = 'number' then (e.props ->> 'failed')::numeric else 0 end) as failed
        from (select * from public.lp_tel_events x where x.event_id = p_event) e
       where e.at >= v_since and e.name = 'push_send'
       group by 1
    ), rx as (
      select e.props ->> 'kind' as kind, pg_catalog.count(*) as rx,
             pg_catalog.count(*) filter (where e.props ->> 'shown' = 'true') as shown,
             pg_catalog.percentile_cont(0.5) within group (order by e.ms) as t50,
             pg_catalog.percentile_cont(0.95) within group (order by e.ms) as t95
        from (select * from public.lp_tel_events x where x.event_id = p_event) e
       where e.at >= v_since and e.name = 'push_rx'
       group by 1
    ), opened as (
      select e.props ->> 'kind' as kind, pg_catalog.count(*) as opened
        from (select * from public.lp_tel_events x where x.event_id = p_event) e
       where e.at >= v_since and e.name = 'notif_click' and e.props ->> 'src' = 'push'
       group by 1
    ), kinds as (
      select kind from sent union select kind from rx union select kind from opened
    )
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'kind', k.kind, 'ok', coalesce(s.ok, 0), 'gone', coalesce(s.gone, 0), 'failed', coalesce(s.failed, 0),
             'rx', coalesce(r.rx, 0), 'shown', coalesce(r.shown, 0), 'opened', coalesce(o.opened, 0),
             't50', r.t50, 't95', r.t95) order by k.kind), '[]'::jsonb)
      into v_out
      from kinds k
      left join sent s on s.kind is not distinct from k.kind
      left join rx r on r.kind is not distinct from k.kind
      left join opened o on o.kind is not distinct from k.kind;

  elsif p_section = 'coverage' then
    with latest as (
      select distinct on (e.device) e.device, e.team, e.props
        from (select * from public.lp_tel_events x where x.event_id = p_event) e
       where e.name = 'device_state' and e.at >= v_since
       order by e.device, e.at desc
    ), devices as (
      select l.team, pg_catalog.count(*) as devices,
             pg_catalog.count(*) filter (where l.props ->> 'sa' = 'true') as standalone,
             pg_catalog.count(*) filter (where l.props ->> 'perm' = 'granted') as granted,
             pg_catalog.count(*) filter (where l.props ->> 'push' = 'sub') as pushsub,
             pg_catalog.count(*) filter (where l.props ->> 'newreq' = 'true') as newreq
        from latest l group by 1
    ), subs as (
      select case (pg_catalog.regexp_match(s.staff, '^(.*) · (.*)$'))[2]
               when 'medical' then 'medical'
               when 'gc/hx - dispatch' then 'dispatch'
               when 'gc/hx - base' then 'base'
               when 'gc/hx - special operations/med transpo' then 'transpo'
               else 'other' end as team,
             pg_catalog.count(*) as n, pg_catalog.count(*) filter (where s.new_requests) as newreq
        from (select * from public.lp_push_subscriptions x where x.event_id = p_event) s group by 1
    ), alerts as (
      select e.team, pg_catalog.count(*) as n,
             pg_catalog.count(*) filter (where e.ms <= 30000 and e.props ->> 'route' in ('toast', 'push')) as within30,
             pg_catalog.percentile_cont(0.5) within group (order by e.ms) as p50
        from (select * from public.lp_tel_events x where x.event_id = p_event) e
       where e.name = 'flow_alert' and e.at >= v_since
       group by 1
    ), teams as (
      select team from devices union select team from subs union select team from alerts
    )
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'team', t.team, 'devices', coalesce(d.devices, 0), 'standalone', coalesce(d.standalone, 0),
             'granted', coalesce(d.granted, 0), 'pushsub', coalesce(d.pushsub, 0), 'newreq', coalesce(d.newreq, 0),
             'subs', coalesce(s.n, 0), 'subsNewreq', coalesce(s.newreq, 0),
             'alerts', coalesce(a.n, 0), 'within30', coalesce(a.within30, 0), 'p50', a.p50) order by t.team), '[]'::jsonb)
      into v_out
      from teams t
      left join devices d on d.team = t.team
      left join subs s on s.team = t.team
      left join alerts a on a.team = t.team;

  elsif p_section = 'errors' then
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'fp', x.fp, 'type', x.type, 'src', x.src, 'line', x.line, 'col', x.col, 'n', x.n, 'devices', x.devices,
             'teams', pg_catalog.to_jsonb(x.teams), 'views', pg_catalog.to_jsonb(x.views), 'lastAt', x.last_at)
             order by x.last_at desc), '[]'::jsonb)
      into v_out
      from (
        select e.props ->> 'fp' as fp, e.ctl as type, e.area as src, e.props ->> 'line' as line, e.props ->> 'col' as col,
               pg_catalog.sum(greatest(coalesce(e.n, 1), 1)) as n, pg_catalog.count(distinct e.device) as devices,
               pg_catalog.array_agg(distinct e.team) as teams, pg_catalog.array_agg(distinct e.view) as views,
               pg_catalog.max(e.at) as last_at
          from (select * from public.lp_tel_events x where x.event_id = p_event) e
         where e.at >= v_since and e.name = 'error'
         group by 1, 2, 3, 4, 5
         order by last_at desc
         limit v_limit
      ) x;
  else
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:section';
  end if;
  return v_out;
end
$fn$;

-- -----------------------------------------------------------------------------------------------------
-- I1. Events: config, list, create, update, secrets, stage changes (lead routes; service_role only)
-- -----------------------------------------------------------------------------------------------------
-- lp_event_json: an event as the app server reads it. Never a hash or a join code.
create or replace function public.lp_event_json(e public.events)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $fn$
  select pg_catalog.jsonb_build_object(
    'id', e.id, 'slug', e.slug, 'name', e.name, 'startsOn', e.starts_on, 'endsOn', e.ends_on,
    'timezone', e.timezone, 'dayStartHour', e.day_start_hour, 'stage', e.stage, 'logoPath', e.logo_path,
    'posts', e.posts, 'mainMedical', e.main_medical, 'teams', e.teams, 'lastSeen', e.last_seen,
    'hasStaffPassword', e.staff_password_hash is not null,
    'joinLinkExpiresAt', case when e.invite_code_sha256 is not null then e.invite_expires_at end,
    'caseSeq', e.case_seq, 'wentLiveAt', e.went_live_at, 'endedAt', e.ended_at,
    'recordsDeleteAt', e.records_delete_at, 'recordsDeletedAt', e.records_deleted_at,
    'createdAt', e.created_at, 'updatedAt', e.updated_at)
$fn$;

create or replace function public.lp_event_get(p_event uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $fn$
  select public.lp_event_json(e) from public.events e where e.id = p_event
$fn$;

create or replace function public.lp_event_by_slug(p_slug text)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $fn$
  select public.lp_event_json(e) from public.events e where e.slug = pg_catalog.lower(pg_catalog.btrim(p_slug))
$fn$;

-- Lead's Events list: live, then practice, then archived (newest first), with request counts.
create or replace function public.lp_events_list()
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
as $fn$
  select coalesce(pg_catalog.jsonb_agg(public.lp_event_json(e) || pg_catalog.jsonb_build_object(
           'requests', (select pg_catalog.count(*) from public.patients p where p.event_id = e.id),
           'open', (select pg_catalog.count(*) from public.patients p where p.event_id = e.id
                     and p.status in ('Added', 'Found – Awaiting Reunion', 'Bring friend to medical', 'Found – Accompanied')))
           order by case e.stage when 'live' then 0 when 'practice' then 1 else 2 end, e.starts_on desc, e.created_at desc), '[]'::jsonb)
  from public.events e
$fn$;

-- Shape checks for an event's settings (the app server validates first, with friendlier messages). Raises P0422
-- invalid_field with field:<name>.
create or replace function public.lp_event_check(e public.events)
returns void
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_item jsonb;
  v_labels text[] := '{}';
  v_ids text[] := '{}';
  v_medical integer := 0;
begin
  if e.slug is null or e.slug !~ '^[a-z0-9][a-z0-9-]{1,39}$' then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:slug';
  end if;
  if e.name is null or pg_catalog.char_length(pg_catalog.btrim(e.name)) not between 1 and 80 then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:name';
  end if;
  if e.starts_on is null or e.ends_on is null or e.ends_on < e.starts_on or e.ends_on - e.starts_on > 31 then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:ends_on';
  end if;
  if e.timezone is null or not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = e.timezone) then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:timezone';
  end if;
  if e.day_start_hour is null or e.day_start_hour not between 0 and 23 then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:day_start_hour';
  end if;
  if e.main_medical is null or pg_catalog.char_length(pg_catalog.btrim(e.main_medical)) not between 1 and 40 then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:main_medical';
  end if;

  if pg_catalog.jsonb_typeof(e.posts) <> 'array' or pg_catalog.jsonb_array_length(e.posts) > 12 then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:posts';
  end if;
  for v_item in select x from pg_catalog.jsonb_array_elements(e.posts) as x loop
    if pg_catalog.jsonb_typeof(v_item) <> 'object'
       or pg_catalog.jsonb_typeof(v_item -> 'label') is distinct from 'string'
       or pg_catalog.char_length(pg_catalog.btrim(v_item ->> 'label')) not between 1 and 40
       or v_item ->> 'label' <> pg_catalog.btrim(v_item ->> 'label')
       or pg_catalog.lower(v_item ->> 'label') = 'other'
       or coalesce(v_item ->> 'id', '') !~ '^[a-z0-9_-]{1,24}$'
       or (v_item ? 'short' and (pg_catalog.jsonb_typeof(v_item -> 'short') <> 'string'
                                 or pg_catalog.char_length(v_item ->> 'short') not between 1 and 16))
       or pg_catalog.lower(v_item ->> 'label') = any (v_labels)
       or (v_item ->> 'id') = any (v_ids) then
      raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:posts';
    end if;
    v_labels := v_labels || pg_catalog.lower(v_item ->> 'label');
    v_ids := v_ids || (v_item ->> 'id');
  end loop;

  v_labels := '{}';
  v_ids := '{}';
  if pg_catalog.jsonb_typeof(e.teams) <> 'array' or pg_catalog.jsonb_array_length(e.teams) > 12 then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:teams';
  end if;
  for v_item in select x from pg_catalog.jsonb_array_elements(e.teams) as x loop
    if pg_catalog.jsonb_typeof(v_item) <> 'object'
       or pg_catalog.jsonb_typeof(v_item -> 'label') is distinct from 'string'
       or pg_catalog.char_length(pg_catalog.btrim(v_item ->> 'label')) not between 2 and 80
       or v_item ->> 'label' <> pg_catalog.btrim(v_item ->> 'label')
       or v_item ->> 'label' ~ '[·•∙⋅・･·]'
       or pg_catalog.lower(v_item ->> 'label') = 'other'
       or coalesce(v_item ->> 'id', '') !~ '^[a-z0-9_-]{1,24}$'
       or (v_item ? 'short' and (pg_catalog.jsonb_typeof(v_item -> 'short') <> 'string'
                                 or pg_catalog.char_length(v_item ->> 'short') not between 1 and 24))
       or (v_item ? 'medical' and pg_catalog.jsonb_typeof(v_item -> 'medical') <> 'boolean')
       or pg_catalog.lower(v_item ->> 'label') = any (v_labels)
       or (v_item ->> 'id') = any (v_ids) then
      raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:teams';
    end if;
    v_labels := v_labels || pg_catalog.lower(v_item ->> 'label');
    v_ids := v_ids || (v_item ->> 'id');
    if coalesce((v_item ->> 'medical')::boolean, false) then
      v_medical := v_medical + 1;
    end if;
  end loop;
  if v_medical > 1 then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:teams';
  end if;

  if pg_catalog.jsonb_typeof(e.last_seen) <> 'array' or pg_catalog.jsonb_array_length(e.last_seen) > 12
     or exists (select 1 from pg_catalog.jsonb_array_elements(e.last_seen) x
                 where pg_catalog.jsonb_typeof(x) <> 'string' or pg_catalog.char_length(pg_catalog.btrim(x #>> '{}')) not between 1 and 40) then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:last_seen';
  end if;
end
$fn$;

-- The settings a lead may set (create and update). Anything else in p is refused.
create or replace function public.lp_event_apply(e public.events, p jsonb)
returns public.events
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_key text;
begin
  if p is null or pg_catalog.jsonb_typeof(p) <> 'object' then
    raise exception using errcode = 'P0422', message = 'invalid_body', detail = 'field:body';
  end if;
  for v_key in select pg_catalog.jsonb_object_keys(p) loop
    if v_key not in ('slug', 'name', 'starts_on', 'ends_on', 'timezone', 'day_start_hour', 'posts', 'main_medical',
                     'teams', 'last_seen') then
      raise exception using errcode = 'P0422', message = 'unknown_field', detail = pg_catalog.format('field:%s', pg_catalog.left(v_key, 60));
    end if;
  end loop;
  begin
    e := pg_catalog.jsonb_populate_record(e, p);
  exception when others then
    raise exception using errcode = 'P0422', message = 'invalid_body', detail = 'field:body';
  end;
  e.slug := pg_catalog.lower(pg_catalog.btrim(e.slug));
  e.name := pg_catalog.btrim(e.name);
  e.main_medical := pg_catalog.btrim(e.main_medical);
  perform public.lp_event_check(e);
  return e;
end
$fn$;

create or replace function public.lp_event_create(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
set lock_timeout = '2s'
as $fn$
declare
  v_new public.events;
begin
  v_new := public.lp_event_apply(
    pg_catalog.jsonb_populate_record(null::public.events,
      '{"timezone": "America/New_York", "day_start_hour": 6, "main_medical": "Main Med", "posts": [], "teams": [], "last_seen": []}'::jsonb),
    p);
  begin
    insert into public.events (slug, name, starts_on, ends_on, timezone, day_start_hour, stage, posts, main_medical, teams, last_seen)
    values (v_new.slug, v_new.name, v_new.starts_on, v_new.ends_on, v_new.timezone, v_new.day_start_hour, 'practice',
            v_new.posts, v_new.main_medical, v_new.teams, v_new.last_seen)
    returning * into v_new;
  exception when unique_violation then
    raise exception using errcode = 'P0409', message = 'slug_taken', detail = 'field:slug';
  end;
  return public.lp_event_json(v_new);
end
$fn$;

create or replace function public.lp_event_update(p_event uuid, p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
set lock_timeout = '2s'
as $fn$
declare
  v_row public.events;
begin
  select * into v_row from public.events where id = p_event for update;
  if v_row.id is null then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;
  v_row := public.lp_event_apply(v_row, p);
  begin
    update public.events
       set slug = v_row.slug, name = v_row.name, starts_on = v_row.starts_on, ends_on = v_row.ends_on,
           timezone = v_row.timezone, day_start_hour = v_row.day_start_hour, posts = v_row.posts,
           main_medical = v_row.main_medical, teams = v_row.teams, last_seen = v_row.last_seen,
           updated_at = pg_catalog.now()
     where id = p_event
    returning * into v_row;
  exception when unique_violation then
    raise exception using errcode = 'P0409', message = 'slug_taken', detail = 'field:slug';
  end;
  return public.lp_event_json(v_row);
end
$fn$;

-- Staff password: the app server hashes it (bcrypt) and checks it against the lead passcode and every other
-- non-archived event's password first (only it has the plain text). Null turns password sign-in off.
create or replace function public.lp_event_set_password(p_event uuid, p_hash text)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
set lock_timeout = '2s'
as $fn$
declare
  v_row public.events;
begin
  if p_hash is not null and p_hash !~ '^\$2[abxy]\$\d{2}\$[./A-Za-z0-9]{53}$' then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:password';
  end if;
  update public.events set staff_password_hash = p_hash, updated_at = pg_catalog.now() where id = p_event returning * into v_row;
  if v_row.id is null then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;
  return public.lp_event_json(v_row);
end
$fn$;

-- Join link: only the SHA-256 of the code is stored. Null turns the link off.
create or replace function public.lp_event_set_invite(p_event uuid, p_sha256 text, p_expires_at timestamptz)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
set lock_timeout = '2s'
as $fn$
declare
  v_row public.events;
begin
  if p_sha256 is not null and (p_sha256 !~ '^[0-9a-f]{64}$' or p_expires_at is null) then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:invite';
  end if;
  update public.events
     set invite_code_sha256 = p_sha256, invite_expires_at = case when p_sha256 is null then null else p_expires_at end,
         updated_at = pg_catalog.now()
   where id = p_event
  returning * into v_row;
  if v_row.id is null then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;
  return public.lp_event_json(v_row);
end
$fn$;

-- Logo: the storage path in the event-logos bucket. Returns {event, oldPath} (the server removes the old object).
create or replace function public.lp_event_set_logo(p_event uuid, p_path text)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
set lock_timeout = '2s'
as $fn$
declare
  v_old text;
  v_row public.events;
begin
  if p_path is not null and p_path !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(png|webp|jpg)$' then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:logo';
  end if;
  select logo_path into v_old from public.events where id = p_event for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;
  update public.events set logo_path = p_path, updated_at = pg_catalog.now() where id = p_event returning * into v_row;
  return pg_catalog.jsonb_build_object('event', public.lp_event_json(v_row), 'oldPath', v_old);
end
$fn$;

-- Go live: practice → live. Every practice request goes (its audit trail, photos rows, messages, en route, Activity
-- rows, read markers, inactive notices) and numbering restarts at 1. Returns {event, photoPaths}: the storage objects
-- the app server then removes. SECURITY DEFINER: service_role has no DELETE on these tables.
create or replace function public.lp_event_go_live(p_event uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
set statement_timeout = '30s'
set lock_timeout = '5s'
as $fn$
declare
  v_row public.events;
  v_paths jsonb;
  v_ids uuid[];
begin
  -- The event's row lock first: in-flight writes (FOR SHARE) finish, new ones wait and then see 'live'.
  select * into v_row from public.events where id = p_event for update;
  if v_row.id is null then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;
  if v_row.stage <> 'practice' then
    raise exception using errcode = 'P0409', message = 'bad_stage', hint = v_row.stage;
  end if;
  if pg_catalog.jsonb_array_length(v_row.posts) = 0 then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:posts';
  end if;
  if pg_catalog.jsonb_array_length(v_row.teams) = 0 then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:teams';
  end if;

  select coalesce(pg_catalog.array_agg(p.id), '{}'::uuid[]) into v_ids from public.patients p where p.event_id = p_event;
  select coalesce(pg_catalog.jsonb_agg(x.path order by x.path), '[]'::jsonb) into v_paths
  from (
    select ph.storage_path as path from public.patient_photos ph where ph.patient_id = any (v_ids)
    union
    select ph.thumb_path from public.patient_photos ph where ph.patient_id = any (v_ids) and ph.thumb_path is not null
  ) x;

  delete from public.patient_photos where patient_id = any (v_ids);
  delete from public.audit_events where patient_id = any (v_ids) or event_id = p_event;
  -- lp_messages, lp_enroute, lp_activity, lp_message_reads, lp_inactive_closes go with their request (ON DELETE CASCADE).
  delete from public.patients where id = any (v_ids);

  update public.events
     set stage = 'live', case_seq = 0, went_live_at = pg_catalog.now(), updated_at = pg_catalog.now()
   where id = p_event
  returning * into v_row;
  return pg_catalog.jsonb_build_object('event', public.lp_event_json(v_row), 'photoPaths', v_paths, 'deleted', pg_catalog.cardinality(v_ids));
end
$fn$;

-- End: live → archived. Nothing is deleted; open requests stay as they are (frozen by the write guard).
create or replace function public.lp_event_end(p_event uuid)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
set lock_timeout = '5s'
as $fn$
declare
  v_row public.events;
begin
  select * into v_row from public.events where id = p_event for update;
  if v_row.id is null then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;
  if v_row.stage <> 'live' then
    raise exception using errcode = 'P0409', message = 'bad_stage', hint = v_row.stage;
  end if;
  update public.events set stage = 'archived', ended_at = pg_catalog.now(), updated_at = pg_catalog.now()
   where id = p_event returning * into v_row;
  return public.lp_event_json(v_row);
end
$fn$;

-- Reopen: archived → live, while its records still exist.
create or replace function public.lp_event_reopen(p_event uuid)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
set lock_timeout = '5s'
as $fn$
declare
  v_row public.events;
begin
  select * into v_row from public.events where id = p_event for update;
  if v_row.id is null then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;
  if v_row.stage <> 'archived' or v_row.records_deleted_at is not null then
    raise exception using errcode = 'P0409', message = 'bad_stage', hint = v_row.stage;
  end if;
  update public.events set stage = 'live', ended_at = null, updated_at = pg_catalog.now()
   where id = p_event returning * into v_row;
  return public.lp_event_json(v_row);
end
$fn$;

-- Sign-in: the lead passcode hash and every event's staff password hash (the app server compares; bcrypt).
create or replace function public.lp_auth_secrets()
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $fn$
  select pg_catalog.jsonb_build_object(
    'lead', (select o.lead_passcode_hash from public.lp_org o where o.id),
    'events', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', e.id, 'stage', e.stage, 'hash', e.staff_password_hash)
               order by case e.stage when 'archived' then 1 else 0 end, e.created_at)
      from public.events e where e.staff_password_hash is not null), '[]'::jsonb))
$fn$;

-- Join links: the events with a link (one slug, or all when p_slug is null), their code hash and expiry.
create or replace function public.lp_invite_candidates(p_slug text)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $fn$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'id', e.id, 'stage', e.stage, 'sha256', e.invite_code_sha256, 'expiresAt', e.invite_expires_at)
           order by case e.stage when 'archived' then 1 else 0 end, e.created_at), '[]'::jsonb)
  from public.events e
  where e.invite_code_sha256 is not null
    and (p_slug is null or e.slug = pg_catalog.lower(pg_catalog.btrim(p_slug)))
$fn$;

create or replace function public.lp_org_set_lead_passcode(p_hash text)
returns void
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
set lock_timeout = '2s'
as $fn$
begin
  if p_hash is null or p_hash !~ '^\$2[abxy]\$\d{2}\$[./A-Za-z0-9]{53}$' then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:passcode';
  end if;
  insert into public.lp_org as o (id, lead_passcode_hash, updated_at) values (true, p_hash, pg_catalog.now())
  on conflict (id) do update set lead_passcode_hash = excluded.lead_passcode_hash, updated_at = excluded.updated_at;
end
$fn$;

-- -----------------------------------------------------------------------------------------------------
-- I2. Stats: lp_stats(p_event, p_range) replaces lp_stats() and lp_stats(text)
-- -----------------------------------------------------------------------------------------------------
-- A post's short form: the event's short label for one of its posts, the Other location (else 'Other'), or a legacy
-- value as stored.
create or replace function public.lp_post_short(p_posts jsonb, p_location text, p_other text)
returns text
language sql
immutable
security invoker
set search_path = public, pg_temp
as $fn$
  select case
    when p_location is null then null
    when p_location = 'Other' then coalesce(nullif(pg_catalog.btrim(p_other), ''), 'Other')
    else coalesce((select coalesce(nullif(x.post ->> 'short', ''), x.post ->> 'label')
                     from pg_catalog.jsonb_array_elements(coalesce(p_posts, '[]'::jsonb)) as x(post)
                    where x.post ->> 'label' = p_location
                    limit 1), p_location)
  end
$fn$;

-- The live snapshot (what lp_stats() returned), for one event. byPost: the event's posts (every one, also at 0) and
-- every other open location (Other by its location, legacy values as stored), ordered by count, so the bars add up
-- to the Open number. p_names = false leaves recent[].name null.
create or replace function public.lp_stats_base(p_event uuid, p_names boolean)
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
  v_posts jsonb := coalesce((select e.posts from public.events e where e.id = p_event), '[]'::jsonb);
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
      'inMedical', pg_catalog.count(*) filter (where status in ('Found – Awaiting Reunion', 'Bring friend to medical', 'Found – Accompanied'))
    ),
    'notInMedical', pg_catalog.count(*) filter (where status = 'Checked – Not Found'),
    'reunited', pg_catalog.count(*) filter (where status = 'Reunited – Closed'),
    'discharged', pg_catalog.count(*) filter (where status = 'Found – Discharged'),
    'cancelled', pg_catalog.count(*) filter (where status = 'Cancelled'),
    'inactive', pg_catalog.count(*) filter (where status = 'Closed – Inactive'),
    'friendInformed', pg_catalog.count(*) filter (where status = 'Closed – Friend Informed'),
    'total', pg_catalog.count(*),
    'loggedLastHour', pg_catalog.count(*) filter (where created_at > v_now - interval '60 minutes')
  ) into v_counts
  from public.patients
  where event_id = p_event;

  select pg_catalog.jsonb_build_object(
    'id', p.id,
    'caseNumber', p.case_number,
    'reportingLocation', p.reporting_location,
    'otherLocation', p.other_location,
    'postShort', public.lp_post_short(v_posts, p.reporting_location, p.other_location),
    'minutes', greatest(0, pg_catalog.floor(extract(epoch from (v_now - p.created_at)) / 60))::integer
  ) into v_longest
  from public.patients p
  where p.event_id = p_event
    and p.status = 'Added'
    and (p.recheck_at is null or p.recheck_at <= v_now)
  order by p.created_at asc, p.case_number asc
  limit 1;

  -- The first answer per request; average delay over answers in the last 2 hours (as lp_stats()).
  with answers as (
    select e.patient_id, e.occurred_at
    from public.audit_events e
    where e.event_id = p_event
      and e.patient_id is not null
      and (
        (e.action_type in ('status_changed', 'check_completed')
         and e.previous_value ->> 'status' = 'Added'
         and e.new_value ->> 'status' in ('Checked – Not Found', 'Found – Awaiting Reunion', 'Bring friend to medical', 'Found – Accompanied'))
        or (e.action_type = 'medical_search' and e.new_value ->> 'outcome' = 'not_found')
        or e.action_type = 'medical_search_found'
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

  -- Time to reunite (A49), as lp_stats().
  with reunions as (
    select distinct on (e.patient_id) e.patient_id, e.occurred_at
    from public.audit_events e
    join public.patients p on p.id = e.patient_id
    where p.event_id = p_event
      and e.action_type = 'status_changed'
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
         and e.new_value ->> 'status' in ('Found – Awaiting Reunion', 'Bring friend to medical', 'Found – Accompanied'))
        or (e.action_type = 'status_changed'
            and e.previous_value ->> 'status' = 'Found – Accompanied'
            and e.new_value ->> 'status' in ('Found – Awaiting Reunion', 'Bring friend to medical')
            and coalesce(e.new_value ->> 'restore', '') <> 'true'
            and coalesce(e.new_value ->> 'kind', '') <> 'undo')
        or e.action_type = 'medical_search_found'
      )
    order by e.occurred_at desc
    limit 1
  ) as a;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'reportingLocation', x.loc, 'otherLocation', x.other, 'postShort', x.short, 'count', x.n)
           order by x.n desc, x.ord, x.short), '[]'::jsonb)
    into v_by_post
  from (
    select l.loc, null::text as other, l.short, l.ord, pg_catalog.count(p.id)::integer as n
    from (
      select x.post ->> 'label' as loc, coalesce(nullif(x.post ->> 'short', ''), x.post ->> 'label') as short, x.ord::integer as ord
      from pg_catalog.jsonb_array_elements(v_posts) with ordinality as x(post, ord)
    ) as l
    left join public.patients p
      on p.event_id = p_event
     and p.reporting_location = l.loc
     and p.status in ('Added', 'Found – Awaiting Reunion', 'Bring friend to medical', 'Found – Accompanied')
    group by l.loc, l.short, l.ord
    union all
    select p.reporting_location,
           case when p.reporting_location = 'Other' then pg_catalog.min(pg_catalog.btrim(p.other_location)) end,
           case when p.reporting_location = 'Other'
                then coalesce(nullif(pg_catalog.min(pg_catalog.btrim(p.other_location)), ''), 'Other')
                else p.reporting_location
           end,
           1000,
           pg_catalog.count(*)::integer
    from public.patients p
    where p.event_id = p_event
      and not exists (select 1 from pg_catalog.jsonb_array_elements(v_posts) as x(post) where x.post ->> 'label' = p.reporting_location)
      and p.status in ('Added', 'Found – Awaiting Reunion', 'Bring friend to medical', 'Found – Accompanied')
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
      'name', case when p_names then nullif(pg_catalog.concat_ws(' ', nullif(p.first_name, ''), nullif(p.last_name, '')), '') end,
      'status', p.status,
      'postShort', public.lp_post_short(v_posts, p.reporting_location, p.other_location),
      'updatedAt', p.updated_at
    ) as obj
    from public.patients p
    where p.event_id = p_event
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

-- lp_stats(p_event, p_range). No range: the live snapshot (lp_stats_base, names in recent). A range: the snapshot
-- with names out, plus the dashboard fields of lp_stats(text), in the event's time zone and show day:
--   p_range  '1h' | '2h' | '6h' (rolling, from a 15-minute boundary), 'today' (since the current show day began at
--            day_start_hour), 'event' (from the event's first request), 'day:N' (show day N: starts_on + N − 1 from
--            day_start_hour, 24 h; N ≥ 1).
--   range    {key, from, to (day:N's end, else null = now), step, compare, day (N or null), posts: [{post, n}]}: the posts of this range, by count, the
--            four busiest by name and the rest (Other locations and legacy values too) as 'Other', last.
--   calls    {total, prevTotal, buckets [{at, day, n, posts [{post, n}], prev}]}: per 15 min (per hour and show day for
--            'event'); prev = the same clock bucket the day before ('today', 'day:N' after the first, 1h/2h/6h).
--   heat     {step, cols [{at | hour, n, posts [{post, n}]}]}: 'event' sums each clock hour over every show day.
--   speed    [{key, target, n, median, p90, prevMedian, byPost [{post, n, median}], spark [{at, day, n, median, p90}]}].
--   live, attention {total, items [{id, caseNumber, post, kind, since, enroute, etaAt}]}, recap: as lp_stats(text).
--   team     [{team, on}]: the event's team ids in setup order (+ 'other' when someone else is on).
create or replace function public.lp_stats(p_event uuid, p_range text default null)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
set statement_timeout = '4s'
set lock_timeout = '2s'
as $fn$
declare
  v_ev public.events;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_tz text;
  v_dh interval;
  v_o constant timestamptz := timestamptz '2026-01-01 00:00:00+00';
  v_day constant interval := interval '1 day';
  v_from timestamptz;
  v_to timestamptz;
  v_step interval;
  v_spark interval;
  v_cmp boolean;
  v_today date;
  v_n integer;
  v_base jsonb;
  v_out jsonb;
  v_team jsonb;
begin
  select * into v_ev from public.events where id = p_event;
  if v_ev.id is null then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;
  if p_range is null then
    return public.lp_stats_base(p_event, true);
  end if;
  if p_range not in ('1h', '2h', '6h', 'today', 'event') and p_range !~ '^day:[1-9][0-9]{0,2}$' then
    raise exception using errcode = '22023', message = 'bad_range';
  end if;

  v_tz := v_ev.timezone;
  v_dh := pg_catalog.make_interval(hours => v_ev.day_start_hour);
  -- The show day a time belongs to: its local date, day_start_hour earlier.
  v_today := pg_catalog.date_trunc('day', (v_now at time zone v_tz) - v_dh)::date;
  v_n := case when p_range like 'day:%' then pg_catalog.substr(p_range, 5)::integer end;
  v_step := case when p_range = 'event' then interval '1 hour' else interval '15 minutes' end;
  v_spark := case when p_range in ('1h', '2h') then interval '15 minutes' else interval '1 hour' end;
  v_cmp := p_range <> 'event' and p_range <> 'day:1';
  v_from := case
    when p_range = 'today' then (v_today + v_dh) at time zone v_tz
    when p_range = 'event' then pg_catalog.date_bin(interval '1 hour',
      coalesce((select pg_catalog.min(pt.created_at) from public.patients pt where pt.event_id = p_event), v_now), v_o)
    when v_n is not null then ((v_ev.starts_on + (v_n - 1)) + v_dh) at time zone v_tz
    else pg_catalog.to_timestamp(pg_catalog.ceil(extract(epoch from v_now - case p_range when '1h' then interval '1 hour'
                                                                               when '2h' then interval '2 hours'
                                                                               else interval '6 hours' end) / 900) * 900)
  end;
  v_to := case when v_n is not null then least(v_now, ((v_ev.starts_on + v_n) + v_dh) at time zone v_tz) else v_now end;
  v_to := greatest(v_to, v_from);

  v_base := public.lp_stats_base(p_event, false);

  with pd as (
    select x.ord::integer as ord, x.post ->> 'label' as label, coalesce(nullif(x.post ->> 'short', ''), x.post ->> 'label') as short
    from pg_catalog.jsonb_array_elements(v_ev.posts) with ordinality as x(post, ord)
  ), p0 as (
    select pt.id, pt.case_number, pt.created_at, pt.status, pt.recheck_at, pt.swap_requested_at,
           coalesce(pd.short, 'Other') as post0, coalesce(pd.ord, 1000) as post_ord
    from public.patients pt
    left join pd on pd.label = pt.reporting_location
    where pt.event_id = p_event
  ), top as (
    -- The four busiest posts of the range by name; everything else is 'Other'.
    select t.post0, t.rnk
    from (
      select p0.post0, pg_catalog.row_number() over (order by pg_catalog.count(*) desc, pg_catalog.min(p0.post_ord), p0.post0) as rnk
      from p0
      where p0.post0 <> 'Other' and p0.created_at >= v_from and p0.created_at < v_to
      group by p0.post0
    ) t
    where t.rnk <= 4
  ), p as (
    select p0.*, coalesce(top.post0, 'Other') as tent, coalesce(top.rnk, 5) as tent_rank
    from p0
    left join top on top.post0 = p0.post0
  ), plist as (
    select p.tent, p.tent_rank, pg_catalog.count(*) filter (where p.created_at >= v_from and p.created_at < v_to)::integer as n
    from p
    group by p.tent, p.tent_rank
    having p.tent <> 'Other' or pg_catalog.count(*) filter (where p.created_at >= v_from and p.created_at < v_to) > 0
  ), ev as (
    select e.patient_id, e.occurred_at,
           ((e.action_type in ('status_changed', 'check_completed')
             and e.previous_value ->> 'status' = 'Added'
             and e.new_value ->> 'status' in ('Checked – Not Found', 'Found – Awaiting Reunion', 'Bring friend to medical', 'Found – Accompanied'))
            or (e.action_type = 'medical_search' and e.new_value ->> 'outcome' = 'not_found')
            or e.action_type = 'medical_search_found'
            or (e.action_type = 'status_changed' and e.new_value ->> 'held' = 'true')) as is_answer,
           ((e.action_type = 'status_changed'
             and e.previous_value ->> 'status' in ('Added', 'Checked – Not Found')
             and e.new_value ->> 'status' in ('Found – Awaiting Reunion', 'Bring friend to medical', 'Found – Accompanied'))
            or (e.action_type = 'status_changed'
                and e.previous_value ->> 'status' = 'Found – Accompanied'
                and e.new_value ->> 'status' in ('Found – Awaiting Reunion', 'Bring friend to medical')
                and coalesce(e.new_value ->> 'restore', '') <> 'true'
                and coalesce(e.new_value ->> 'kind', '') <> 'undo')
            or e.action_type = 'medical_search_found') as is_located,
           (e.action_type = 'status_changed' and e.new_value ->> 'status' = 'Reunited – Closed') as is_reunited,
           (e.action_type = 'status_changed' and e.new_value ->> 'status' = 'Checked – Not Found') as is_not_located
    from public.audit_events e
    where e.event_id = p_event
      and e.patient_id is not null
      and e.action_type in ('status_changed', 'check_completed', 'medical_search', 'medical_search_found')
  ), agg as (
    select ev.patient_id,
           pg_catalog.min(ev.occurred_at) filter (where ev.is_answer) as first_check_at,
           pg_catalog.min(ev.occurred_at) filter (where ev.is_located) as located_at,
           pg_catalog.max(ev.occurred_at) filter (where ev.is_located) as located_last_at,
           pg_catalog.max(ev.occurred_at) filter (where ev.is_reunited) as reunited_at,
           pg_catalog.max(ev.occurred_at) filter (where ev.is_not_located) as not_located_at
    from ev
    group by ev.patient_id
  ), lc as (
    select p.*, a.first_check_at, a.located_at, a.located_last_at,
           case when p.status = 'Reunited – Closed' then a.reunited_at end as reunited_at,
           case when p.status = 'Checked – Not Found' then a.not_located_at end as not_located_at
    from p
    left join agg a on a.patient_id = p.id
  ), dur as (
    select k, tent, e, greatest(0, extract(epoch from e - created_at) / 60)::float8 as m
    from (
      select 'firstCheck' as k, tent, first_check_at as e, created_at from lc where first_check_at is not null
      union all
      select 'located', tent, located_at, created_at from lc where located_at is not null
      union all
      select 'reunited', tent, reunited_at, created_at from lc where reunited_at is not null
    ) d
  ), bk as (
    -- Calls buckets: 15 min over the range, or ('event') 1 h over each show day from its first call to its last (to
    -- now for today's).
    select null::date as day, g.b
    from pg_catalog.generate_series(pg_catalog.date_bin(v_step, v_from, v_o),
                                    pg_catalog.date_bin(v_step, greatest(v_from, v_to - interval '1 microsecond'), v_o), v_step) as g(b)
    where p_range <> 'event'
    union all
    select n.day, g.b
    from (
      select pg_catalog.date_trunc('day', (lc.created_at at time zone v_tz) - v_dh)::date as day,
             pg_catalog.min(pg_catalog.date_bin(v_step, lc.created_at, v_o)) as b0,
             pg_catalog.max(pg_catalog.date_bin(v_step, lc.created_at, v_o)) as b1
      from lc
      where p_range = 'event'
      group by 1
    ) n
    cross join lateral pg_catalog.generate_series(
      n.b0, case when n.day = v_today then greatest(n.b1, pg_catalog.date_bin(v_step, v_now, v_o)) else n.b1 end, v_step) as g(b)
  ), cur as (
    select pg_catalog.date_bin(v_step, created_at, v_o) as b, tent, pg_catalog.count(*)::integer as n
    from lc
    where created_at >= v_from and created_at < v_to
    group by 1, 2
  ), prv as (
    select pg_catalog.date_bin(v_step, created_at + v_day, v_o) as b, pg_catalog.count(*)::integer as n
    from lc
    where v_cmp and created_at >= v_from - v_day and created_at < v_to - v_day
    group by 1
  ), sb as (
    select bk.day, bk.b from bk where v_spark = v_step
    union all
    select null::date, g.b
    from pg_catalog.generate_series(pg_catalog.date_bin(v_spark, v_from, v_o),
                                    pg_catalog.date_bin(v_spark, greatest(v_from, v_to - interval '1 microsecond'), v_o), v_spark) as g(b)
    where v_spark <> v_step
  ), hcur as (
    select case when p_range = 'event'
                then ((extract(hour from created_at at time zone v_tz)::integer - v_ev.day_start_hour + 24) % 24)
           end as o,
           case when p_range <> 'event' then pg_catalog.date_bin(v_spark, created_at, v_o) end as b,
           tent, pg_catalog.count(*)::integer as n
    from lc
    where p_range = 'event' or (created_at >= v_from and created_at < v_to)
    group by 1, 2, 3
  ), kinds as (
    select * from (values ('firstCheck', 10, 1), ('located', 15, 2), ('reunited', 30, 3)) as k(k, target, ord)
  ), att as (
    select x.*, en.enroute, en.eta_at
    from (
      select id, case_number, post0, 'wait' as kind, created_at as since, extract(epoch from v_now - created_at) / 60 - 30 as score
      from lc where status = 'Added' and recheck_at is null
      union all
      select id, case_number, post0, 'recheck', recheck_at, extract(epoch from v_now - recheck_at) / 60 - 10
      from lc where status = 'Added' and recheck_at is not null and recheck_at <= v_now
      union all
      select id, case_number, post0, 'located', coalesce(located_last_at, created_at),
             extract(epoch from v_now - coalesce(located_last_at, created_at)) / 60 - 30
      from lc where status in ('Found – Awaiting Reunion', 'Bring friend to medical')
      union all
      select id, case_number, post0, 'swap', swap_requested_at, extract(epoch from v_now - swap_requested_at) / 60 - 10
      from lc where status = 'Found – Accompanied' and swap_requested_at is not null
    ) x
    left join lateral (
      select true as enroute, pg_catalog.min(r.eta_at) as eta_at
      from public.lp_enroute r
      where r.request_id = x.id and r.state = 'enroute'
      having pg_catalog.count(*) > 0
    ) en on true
  )
  select pg_catalog.jsonb_build_object(
    'range', pg_catalog.jsonb_build_object('key', p_range, 'from', v_from,
                                           -- The nominal end: a show day's end for 'day:N', else null (now). Never the
                                           -- clock itself, so an unchanged poll keeps its ETag.
                                           'to', case when v_n is not null then ((v_ev.starts_on + v_n) + v_dh) at time zone v_tz end,
                                           'step', (extract(epoch from v_step) / 60)::integer, 'compare', v_cmp, 'day', v_n,
                                           'posts', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('post', pl.tent, 'n', pl.n)
                                                                order by pl.tent_rank) from plist pl), '[]'::jsonb)),
    'live', (select pg_catalog.jsonb_build_object(
               'waiting', pg_catalog.count(*) filter (where status = 'Added' and recheck_at is null),
               'pending', pg_catalog.count(*) filter (where status = 'Added' and recheck_at is not null),
               'located', pg_catalog.count(*) filter (where status in ('Found – Awaiting Reunion', 'Bring friend to medical', 'Found – Accompanied')))
             from lc),
    'attention', pg_catalog.jsonb_build_object(
      'total', (select pg_catalog.count(*) from att),
      'items', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                 'id', t.id, 'caseNumber', t.case_number, 'post', t.post0, 'kind', t.kind, 'since', t.since,
                 'enroute', coalesce(t.enroute, false), 'etaAt', t.eta_at) order by t.score desc, t.case_number)
        from (select * from att order by score desc, case_number limit 5) t), '[]'::jsonb)),
    'speed', (
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'key', k.k, 'target', k.target, 'n', s.n, 'median', s.med, 'p90', s.p90, 'prevMedian', s.prev,
               'byPost', s.by_post, 'spark', s.spark) order by k.ord)
      from kinds k
      cross join lateral (
        select
          (select pg_catalog.count(*) from dur where dur.k = k.k and dur.e >= v_from and dur.e < v_to)::integer as n,
          (select pg_catalog.round((pg_catalog.percentile_cont(0.5) within group (order by dur.m))::numeric, 1)
             from dur where dur.k = k.k and dur.e >= v_from and dur.e < v_to) as med,
          (select pg_catalog.round((pg_catalog.percentile_cont(0.9) within group (order by dur.m))::numeric, 1)
             from dur where dur.k = k.k and dur.e >= v_from and dur.e < v_to) as p90,
          (select pg_catalog.round((pg_catalog.percentile_cont(0.5) within group (order by dur.m))::numeric, 1)
             from dur where v_cmp and dur.k = k.k and dur.e >= v_from - v_day and dur.e < v_to - v_day) as prev,
          (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('post', pl.tent, 'n', q.n, 'median', q.med)
                    order by pl.tent_rank), '[]'::jsonb)
             from plist pl
             cross join lateral (
               select pg_catalog.count(*)::integer as n,
                      pg_catalog.round((pg_catalog.percentile_cont(0.5) within group (order by dur.m))::numeric, 1) as med
               from dur where dur.k = k.k and dur.tent = pl.tent and dur.e >= v_from and dur.e < v_to
             ) q) as by_post,
          (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                    'at', sb.b, 'day', sb.day, 'n', q.n, 'median', q.med, 'p90', q.p90) order by sb.b), '[]'::jsonb)
             from sb
             cross join lateral (
               select pg_catalog.count(*)::integer as n,
                      pg_catalog.round((pg_catalog.percentile_cont(0.5) within group (order by dur.m))::numeric, 1) as med,
                      pg_catalog.round((pg_catalog.percentile_cont(0.9) within group (order by dur.m))::numeric, 1) as p90
               from dur
               where dur.k = k.k and dur.e >= greatest(sb.b, v_from) and dur.e < least(sb.b + v_spark, v_to)
             ) q) as spark
      ) s),
    'calls', pg_catalog.jsonb_build_object(
      'total', (select pg_catalog.count(*) from lc where created_at >= v_from and created_at < v_to),
      'prevTotal', case when v_cmp then (select pg_catalog.count(*) from lc
                                         where created_at >= v_from - v_day and created_at < v_to - v_day) end,
      'buckets', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                 'at', bk.b, 'day', bk.day,
                 'n', coalesce((select pg_catalog.sum(c.n) from cur c where c.b = bk.b), 0),
                 'posts', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('post', pl.tent, 'n', coalesce(c.n, 0))
                                             order by pl.tent_rank)
                                    from plist pl left join cur c on c.b = bk.b and c.tent = pl.tent), '[]'::jsonb),
                 'prev', case when v_cmp then coalesce(prv.n, 0) end) order by bk.b)
        from bk
        left join prv on prv.b = bk.b), '[]'::jsonb)),
    'heat', case when p_range = 'event' then pg_catalog.jsonb_build_object('step', 60, 'cols', coalesce((
        -- Clock hours from day_start_hour, summed over every show day; dense from the first hour with a call to the last.
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                 'hour', (h.o + v_ev.day_start_hour) % 24,
                 'n', coalesce((select pg_catalog.sum(c.n) from hcur c where c.o = h.o), 0),
                 'posts', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('post', pl.tent, 'n', coalesce(c.n, 0))
                                             order by pl.tent_rank)
                                    from plist pl left join hcur c on c.o = h.o and c.tent = pl.tent), '[]'::jsonb))
                 order by h.o)
        from (select pg_catalog.generate_series(pg_catalog.min(c.o), pg_catalog.max(c.o)) as o from hcur c) h), '[]'::jsonb))
      else pg_catalog.jsonb_build_object('step', (extract(epoch from v_spark) / 60)::integer, 'cols', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                 'at', g.b,
                 'n', coalesce((select pg_catalog.sum(c.n) from hcur c where c.b = g.b), 0),
                 'posts', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('post', pl.tent, 'n', coalesce(c.n, 0))
                                             order by pl.tent_rank)
                                    from plist pl left join hcur c on c.b = g.b and c.tent = pl.tent), '[]'::jsonb))
                 order by g.b)
        from pg_catalog.generate_series(pg_catalog.date_bin(v_spark, v_from, v_o),
                                        pg_catalog.date_bin(v_spark, greatest(v_from, v_to - interval '1 microsecond'), v_o), v_spark) as g(b)), '[]'::jsonb))
      end,
    'recap', (
      select pg_catalog.jsonb_build_object(
        'reunited', pg_catalog.count(*) filter (where reunited_at >= v_from and reunited_at < v_to),
        'notLocated', pg_catalog.count(*) filter (where not_located_at >= v_from and not_located_at < v_to),
        'fastest', pg_catalog.round((pg_catalog.min(extract(epoch from reunited_at - created_at) / 60)
                     filter (where reunited_at >= v_from and reunited_at < v_to))::numeric, 1),
        'prevReunited', case when v_cmp then pg_catalog.count(*) filter (
                          where reunited_at >= v_from - v_day and reunited_at < v_to - v_day) end,
        'prevNotLocated', case when v_cmp then pg_catalog.count(*) filter (
                            where not_located_at >= v_from - v_day and not_located_at < v_to - v_day) end,
        'prevFastest', case when v_cmp then pg_catalog.round((pg_catalog.min(extract(epoch from reunited_at - created_at) / 60)
                         filter (where reunited_at >= v_from - v_day and reunited_at < v_to - v_day))::numeric, 1) end,
        'lastReunionAt', pg_catalog.max(reunited_at))
      from lc)
  ) into v_out;

  -- Who's on: per team of this event, people with any activity in it in the last 10 minutes (audit trail, messages),
  -- or telemetry sessions; a team's number is the larger of the two, never their sum. A person's team is matched to
  -- the event's teams by label, short label or id; anything else is 'other'.
  with acts as (
    select public.lp_canon_staff(e.staff_name) as who
    from public.audit_events e
    where e.event_id = p_event and e.occurred_at > v_now - interval '10 minutes' and e.staff_name like '% · %'
    union
    select m.staff_key from public.lp_messages m join public.patients pt on pt.id = m.request_id
    where pt.event_id = p_event and m.created_at > v_now - interval '10 minutes'
  ), named as (
    select coalesce((select t.team ->> 'id' from pg_catalog.jsonb_array_elements(v_ev.teams) as t(team)
                      where s.t in (pg_catalog.lower(t.team ->> 'label'), pg_catalog.lower(t.team ->> 'short'), pg_catalog.lower(t.team ->> 'id'))
                      limit 1), 'other') as team,
           pg_catalog.count(distinct s.who)::integer as n
    from (select a.who, pg_catalog.lower(pg_catalog.regexp_replace(a.who, '^.* · ', '')) as t from acts a where a.who is not null) s
    group by 1
  ), tel as (
    select te.team, pg_catalog.count(distinct te.session)::integer as n
    from public.lp_tel_events te
    where te.event_id = p_event and te.at > v_now - interval '10 minutes' and te.session <> 'server'
    group by te.team
  ), teams as (
    select x.team ->> 'id' as team, x.ord::integer as ord from pg_catalog.jsonb_array_elements(v_ev.teams) with ordinality as x(team, ord)
    union all
    select 'other', 1000
  )
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('team', t.team, 'on', greatest(coalesce(n.n, 0), coalesce(tl.n, 0))) order by t.ord)
    into v_team
  from teams t
  left join named n on n.team = t.team
  left join tel tl on tl.team = t.team
  where t.team <> 'other' or greatest(coalesce(n.n, 0), coalesce(tl.n, 0)) > 0;

  return v_base || v_out || pg_catalog.jsonb_build_object('team', coalesce(v_team, '[]'::jsonb));
end
$fn$;

drop function if exists public.lp_stats(text);
drop function if exists public.lp_stats();

-- -----------------------------------------------------------------------------------------------------
-- J. Storage bucket for event logos (private; served through GET /api/events/logo/<slug>)
-- -----------------------------------------------------------------------------------------------------
do $bucket$
begin
  if pg_catalog.to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('event-logos', 'event-logos', false, 1048576, array['image/png', 'image/webp', 'image/jpeg'])
    on conflict (id) do nothing;
  else
    raise notice 'event-logos bucket: NOT created (no storage schema)';
  end if;
end
$bucket$;

-- -----------------------------------------------------------------------------------------------------
-- K. Privileges: service_role only; the wrapped old signatures are internal from now on
-- -----------------------------------------------------------------------------------------------------
do $grants$
declare
  v_sig text;
begin
  foreach v_sig in array array[
    'public.lp_require_writable(uuid, boolean)', 'public.lp_require_event_row(uuid, uuid)',
    'public.lp_clean_fields(jsonb, boolean)', 'public.lp_clean_fields(uuid, jsonb, boolean)',
    'public.lp_create_request(uuid, jsonb, text)',
    'public.lp_update_fields(uuid, uuid, jsonb, bigint, text)', 'public.lp_set_status(uuid, uuid, bigint, text, text, text)',
    'public.lp_cancel(uuid, uuid, bigint, text)', 'public.lp_swap(uuid, uuid, bigint, text, text, text)',
    'public.lp_set_enroute(uuid, uuid, text, integer, timestamptz, integer, text)',
    'public.lp_add_photo(uuid, uuid, uuid, text, text, text, text)', 'public.lp_post_message(uuid, uuid, text, uuid, text, text)',
    'public.lp_unsend_message(uuid, uuid, uuid, text)', 'public.lp_detail(uuid, uuid)',
    'public.lp_messages_thread(uuid, uuid, text, timestamptz, uuid, integer)', 'public.lp_mark_read(uuid, uuid, text, timestamptz)',
    'public.lp_involved_staff(uuid, uuid)', 'public.lp_activity_fallback_staff(uuid, uuid)',
    'public.lp_sync(uuid, timestamptz, uuid[], boolean, timestamptz, uuid, integer)',
    'public.lp_messages_activity(uuid, text, text)', 'public.lp_messages_sync(uuid, text, uuid[], timestamptz, boolean)',
    'public.lp_activity_list(uuid, text)', 'public.lp_activity_unread(uuid, text)', 'public.lp_activity_mark_read(uuid, text, uuid)',
    'public.lp_activity_unmark(uuid, text, uuid[])', 'public.lp_activity_record(uuid, text[], uuid, text, text, text)',
    'public.lp_push_new_request_staff(uuid)', 'public.lp_push_subscribe(uuid, text, text, text, text, text, text, text, boolean)',
    'public.lp_enroute_stats(uuid)', 'public.lp_inactive_claim(uuid, uuid[])', 'public.lp_close_inactive(uuid[])',
    'public.lp_tel_config()', 'public.lp_tel_ingest(uuid, text, text, text, text, bigint, jsonb, jsonb, integer, text)',
    'public.lp_tel_server_events(uuid, jsonb)', 'public.lp_tel_health(uuid, text, timestamptz, integer)',
    'public.lp_event_json(public.events)', 'public.lp_event_get(uuid)', 'public.lp_event_by_slug(text)', 'public.lp_events_list()',
    'public.lp_event_check(public.events)', 'public.lp_event_apply(public.events, jsonb)', 'public.lp_event_create(jsonb)',
    'public.lp_event_update(uuid, jsonb)', 'public.lp_event_set_password(uuid, text)',
    'public.lp_event_set_invite(uuid, text, timestamptz)', 'public.lp_event_set_logo(uuid, text)', 'public.lp_event_go_live(uuid)',
    'public.lp_event_end(uuid)', 'public.lp_event_reopen(uuid)', 'public.lp_auth_secrets()', 'public.lp_invite_candidates(text)',
    'public.lp_org_set_lead_passcode(text)', 'public.lp_post_short(jsonb, text, text)', 'public.lp_stats_base(uuid, boolean)',
    'public.lp_stats(uuid, text)'
  ] loop
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated', v_sig);
    execute pg_catalog.format('grant execute on function %s to service_role', v_sig);
  end loop;

  -- Reachable only through their event wrappers now (the request must be in the caller's event).
  foreach v_sig in array array[
    'public.lp_update_fields(uuid, jsonb, bigint, text)', 'public.lp_set_status(uuid, bigint, text, text, text)',
    'public.lp_cancel(uuid, bigint, text)', 'public.lp_swap(uuid, bigint, text, text, text)',
    'public.lp_set_enroute(uuid, text, integer, timestamptz, integer, text)', 'public.lp_add_photo(uuid, uuid, text, text, text, text)',
    'public.lp_post_message(uuid, text, uuid, text, text)', 'public.lp_unsend_message(uuid, uuid, text)', 'public.lp_detail(uuid)',
    'public.lp_messages_thread(uuid, text, timestamptz, uuid, integer)', 'public.lp_mark_read(uuid, text, timestamptz)',
    'public.lp_activity_fallback_staff(uuid)'
  ] loop
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated, service_role', v_sig);
  end loop;
end
$grants$;

notify pgrst, 'reload schema';

commit;
