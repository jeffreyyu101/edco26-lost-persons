-- =====================================================================================================
-- 20261108120000_companion.sql — Companion (design/screens/companion-v1.html, wording B)
--
-- Main Med allows ONE companion per patient. Located now asks "Someone already with them?":
--   No  → 'Found – Awaiting Reunion' (Located · friend coming, as before)
--   Yes → 'Found – Accompanied' (Located · already accompanied): Request swap | Friend informed
-- A friend swap request goes to whoever answered; they approve it at the request's tent ('fa') or Main Med
-- ('mm') → 'Found – Awaiting Reunion' with swap_place, or decline it (stays Accompanied).
-- 'Closed – Friend Informed' closes an Accompanied request (reopen / Undo → Accompanied).
--
-- PRODUCTION: paste THIS FILE ALONE into the SQL Editor (scripts/companion-sql.mjs writes migration.sql and
-- dry-run.sql). It needs 20261106000000_rework.sql and 20261108000000_dashboard_v4.sql already there.
-- Additive only: five new columns (defaults, so old builds keep working), the status CHECK widened, and
-- create or replace of the functions that enumerate statuses; one new function lp_swap. Safe to run twice.
--
-- What it does:
--   patients: friend_in_medical ('yes' | 'no' | 'unsure', default 'unsure'), friend_in_medical_name (≤ 60, only
--     kept while 'yes'), swap_requested_at / swap_requested_by (an open swap request), swap_place ('fa' | 'mm').
--   statuses: + 'Found – Accompanied' (open, counts as located) and 'Closed – Friend Informed' (closed).
--   lp_row (the new fields), lp_clean_fields / lp_create_request / lp_update_fields (friend_in_medical*),
--   lp_set_status (TRANSITIONS, kind 'inform'), lp_swap (new), lp_involved_staff / lp_activity_fallback_staff
--   (Accompanied answers, swap requesters), lp_activity_record (kinds accompanied, swap_requested,
--   swap_approved, swap_declined, friend_informed), lp_close_inactive (Accompanied idles like In medical),
--   lp_stats() (+ friendInformed; Accompanied is In medical) and lp_stats(text) (attention kind 'swap').
-- =====================================================================================================

begin;

do $pre$
begin
  if pg_catalog.to_regprocedure('public.lp_stats(text)') is null
     or pg_catalog.to_regprocedure('public.lp_set_status(uuid,bigint,text,text,text)') is null then
    raise exception 'Preflight failed: lp_stats(text) / lp_set_status are missing (rework and dashboard_v4 first).';
  end if;
end
$pre$;

alter table public.patients
  add column if not exists friend_in_medical text not null default 'unsure',
  add column if not exists friend_in_medical_name text,
  add column if not exists swap_requested_at timestamptz,
  add column if not exists swap_requested_by text,
  add column if not exists swap_place text;

alter table public.patients drop constraint if exists patients_friend_in_medical_check;
alter table public.patients add constraint patients_friend_in_medical_check
  check (friend_in_medical in ('yes', 'no', 'unsure'));
alter table public.patients drop constraint if exists patients_friend_in_medical_name_check;
alter table public.patients add constraint patients_friend_in_medical_name_check
  check (friend_in_medical_name is null or pg_catalog.char_length(friend_in_medical_name) <= 60);
alter table public.patients drop constraint if exists patients_swap_place_check;
alter table public.patients add constraint patients_swap_place_check
  check (swap_place is null or swap_place in ('fa', 'mm'));

-- The status CHECK: every status (lib/domain.ts STATUSES, same order) plus any legacy value still in use
-- (NOT VALID, as the rework did: existing rows are never re-checked).
do $checks$
declare
  v_statuses constant text[] := array['Added', 'Checked – Not Found', 'Found – Awaiting Reunion', 'Reunited – Closed',
                                      'Found – Discharged', 'Bring friend to medical', 'Cancelled', 'Closed – Inactive',
                                      'Found – Accompanied', 'Closed – Friend Informed'];
  v_extra text[];
begin
  select pg_catalog.array_agg(distinct p.status order by p.status) into v_extra
    from public.patients p
   where p.status is not null and not (p.status = any (v_statuses));
  alter table public.patients drop constraint if exists patients_status_check;
  execute pg_catalog.format(
    'alter table public.patients add constraint patients_status_check check (status in (%s)) not valid',
    (select pg_catalog.string_agg(pg_catalog.quote_literal(v), ', ') from pg_catalog.unnest(v_statuses || coalesce(v_extra, '{}'::text[])) v));
  if v_extra is not null then
    raise notice 'patients_status_check: legacy values kept for existing rows: %', v_extra;
  end if;
end
$checks$;

create or replace function public.lp_row(p public.patients)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_count integer;
  v_first uuid;
  v_quiet boolean := false;
begin
  select pg_catalog.count(*)::integer,
         (pg_catalog.array_agg(ph.id order by ph.created_at, ph.id))[1]
    into v_count, v_first
  from public.patient_photos ph
  where ph.patient_id = p.id and ph.is_active;

  if p.status = 'Closed – Inactive' then
    select coalesce(pg_catalog.bool_or(c.quiet), false) into v_quiet
      from public.lp_inactive_closes c
     where c.request_id = p.id and c.closed_at = p.closed_at;
  end if;

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
    'not_found_checks', p.not_found_checks,
    -- (F6) A backlog auto-close: nobody is told (above).
    'quiet_close', v_quiet
  ) || pg_catalog.jsonb_build_object(
    -- (Companion) Intake: is a friend already with them in medical; the swap request and where a swap was approved.
    'friend_in_medical', p.friend_in_medical,
    'friend_in_medical_name', p.friend_in_medical_name,
    'swap_requested_at', p.swap_requested_at,
    'swap_requested_by', p.swap_requested_by,
    'swap_place', p.swap_place
  );
end
$fn$;

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

create or replace function public.lp_create_request(p jsonb, p_staff text)
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
      contact_name, contact_phone, contact_relationship, contact_notes, status, created_by, updated_by,
      friend_in_medical, friend_in_medical_name
    ) values (
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

create or replace function public.lp_update_fields(p_id uuid, p_patch jsonb, p_expected_version bigint, p_staff text)
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

  -- (Companion) The friend's name is only kept while friend_in_medical is 'yes'.
  if coalesce(v_changes ->> 'friend_in_medical', v_row.friend_in_medical) <> 'yes' then
    if v_row.friend_in_medical_name is not null then
      v_changes := v_changes || '{"friend_in_medical_name": null}'::jsonb;
    else
      v_changes := v_changes - 'friend_in_medical_name';
    end if;
  end if;

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
           friend_in_medical = coalesce(v_merged.friend_in_medical, 'unsure'),
           friend_in_medical_name = v_merged.friend_in_medical_name,
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

create or replace function public.lp_set_status(p_id uuid, p_expected_version bigint, p_status text, p_staff text, p_kind text)
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
  if p_kind is null or p_kind not in ('answer', 'change', 'reunite', 'discharge', 'undo', 'reopen', 'inform') then
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
                      'Reunited – Closed', 'Found – Discharged', 'Cancelled',
                      'Found – Accompanied', 'Closed – Friend Informed') then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:status';
  end if;

  if v_row.row_version <> p_expected_version then
    raise exception using errcode = 'P0409', message = 'version_conflict', hint = v_row.status;
  end if;

  v_allowed := case v_row.status
    -- TRANSITIONS:BEGIN (keep identical to TRANSITIONS in lib/domain.ts)
    when 'Added' then p_status in ('Checked – Not Found', 'Found – Awaiting Reunion', 'Found – Accompanied')
    when 'Checked – Not Found' then p_status in ('Found – Awaiting Reunion', 'Added', 'Found – Accompanied')
    when 'Found – Awaiting Reunion' then p_status in ('Reunited – Closed', 'Checked – Not Found', 'Found – Discharged', 'Added', 'Found – Accompanied')
    when 'Reunited – Closed' then p_status in ('Found – Awaiting Reunion')
    when 'Found – Discharged' then p_status in ('Found – Awaiting Reunion', 'Found – Accompanied')
    when 'Cancelled' then p_status in ('Added')
    when 'Bring friend to medical' then p_status in ('Reunited – Closed', 'Found – Discharged', 'Checked – Not Found')
    when 'Closed – Inactive' then p_status in ('Found – Awaiting Reunion')
    when 'Found – Accompanied' then p_status in ('Closed – Friend Informed', 'Found – Awaiting Reunion', 'Checked – Not Found', 'Found – Discharged', 'Added')
    when 'Closed – Friend Informed' then p_status in ('Found – Accompanied')
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
  elsif p_status in ('Found – Awaiting Reunion', 'Found – Accompanied') then
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
           found_at = case when p_status in ('Found – Awaiting Reunion', 'Found – Accompanied') then coalesce(found_at, now()) else found_at end,
           reunion_started_at = case
             when p_status = 'Found – Awaiting Reunion' then now()
             when p_status in ('Added', 'Checked – Not Found', 'Found – Accompanied') then null
             else reunion_started_at
           end,
           closed_at = case
             when p_status in ('Reunited – Closed', 'Found – Discharged', 'Cancelled', 'Closed – Friend Informed') then now()
             else null
           end,
           -- (Companion) Any status change ends an open swap request; a swap place lasts while the swap runs.
           swap_requested_at = null,
           swap_requested_by = null,
           swap_place = case
             when p_status in ('Found – Awaiting Reunion', 'Reunited – Closed', 'Found – Discharged') then swap_place
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

create or replace function public.lp_involved_staff(p_request uuid)
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
          and e.new_value ->> 'status' in ('Found – Awaiting Reunion', 'Checked – Not Found', 'Bring friend to medical', 'Found – Accompanied'))
        or (e.action_type = 'status_changed' and e.new_value ->> 'answer' = 'not_found')
        or e.action_type in ('medical_search', 'medical_search_found')
        -- (Companion) Whoever asked for a friend swap.
        or e.action_type = 'swap_requested'
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

create or replace function public.lp_activity_fallback_staff(p_request uuid)
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
          and e.new_value ->> 'status' in ('Found – Awaiting Reunion', 'Checked – Not Found', 'Bring friend to medical', 'Found – Accompanied'))
        or (e.action_type = 'status_changed' and e.new_value ->> 'answer' = 'not_found')
        or e.action_type in ('medical_search', 'medical_search_found', 'check_completed', 'swap_requested'))
  ) x
  where x.staff is not null and pg_catalog.btrim(x.staff) <> '';
  return coalesce(v_out, '{}'::text[]);
end
$fn$;

create or replace function public.lp_activity_record(p_recipients text[], p_request uuid, p_kind text, p_actor text, p_detail text)
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
      'accompanied', 'swap_requested', 'swap_approved', 'swap_declined', 'friend_informed') then
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

  -- (F6 7b) Who gets an Activity row: everyone, except for a new request the staff on by the Medical default alone.
  if p_kind = 'new_request' then
    select coalesce(pg_catalog.array_agg(s), '{}'::text[]) into v_rows
    from pg_catalog.unnest(v_staff) s
    where not exists (select 1 from public.lp_push_prefs pr where pr.staff = s and pr.new_requests_team_default);
  else
    v_rows := v_staff;
  end if;

  insert into public.lp_activity as a (staff, request_id, kind, actor, detail, at, read_at)
  select s, p_request, p_kind, pg_catalog.left(coalesce(p_actor, ''), 200), pg_catalog.left(coalesce(p_detail, ''), 200), now(), null
  from pg_catalog.unnest(v_rows) s
  on conflict (staff, request_id) do update set
    kind = excluded.kind, actor = excluded.actor, detail = excluded.detail, at = excluded.at, read_at = null;

  delete from public.lp_activity a
  where a.staff = any (v_rows)
    and (a.at < now() - interval '3 days'
      or (a.staff, a.request_id) not in (
        select b.staff, b.request_id from (
          select x.staff, x.request_id, pg_catalog.row_number() over (partition by x.staff order by x.at desc, x.request_id) as n
          from public.lp_activity x where x.staff = any (v_rows)) b
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

  return pg_catalog.jsonb_build_object('written', pg_catalog.to_jsonb(v_rows), 'targets', v_targets, 'unread', v_unread,
    'firstName', v_patient.first_name, 'lastName', v_patient.last_name);
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
   where notified_at is null and closed_at <= v_now - interval '15 minutes';

  return v_count;
end
$fn$;

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
         and e.new_value ->> 'status' in ('Checked – Not Found', 'Found – Awaiting Reunion', 'Bring friend to medical', 'Found – Accompanied'))
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
         and e.new_value ->> 'status' in ('Found – Awaiting Reunion', 'Bring friend to medical', 'Found – Accompanied'))
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
     and p.status in ('Added', 'Found – Awaiting Reunion', 'Bring friend to medical', 'Found – Accompanied')
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

create or replace function public.lp_stats(p_range text)
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
  v_tz constant text := 'America/New_York';
  v_o constant timestamptz := timestamptz '2026-01-01 00:00:00+00';
  v_day constant interval := interval '1 day';
  v_from timestamptz;
  v_step interval;
  v_spark interval;
  v_cmp boolean;
  v_night date;
  v_base jsonb;
  v_out jsonb;
  v_team jsonb;
begin
  if p_range is null or p_range not in ('1h', '2h', '6h', 'tonight', 'event') then
    raise exception using errcode = '22023', message = 'bad_range';
  end if;
  v_cmp := p_range <> 'event';
  v_step := case when p_range = 'event' then interval '1 hour' else interval '15 minutes' end;
  v_spark := case when p_range in ('1h', '2h') then interval '15 minutes' else interval '1 hour' end;
  -- The night a time belongs to: its ET date 12 hours earlier (noon to noon).
  v_night := pg_catalog.date_trunc('day', (v_now at time zone v_tz) - interval '12 hours')::date;
  v_from := case p_range
    when 'tonight' then (v_night + interval '12 hours') at time zone v_tz
    when 'event' then pg_catalog.date_bin(interval '1 hour', coalesce((select pg_catalog.min(created_at) from public.patients), v_now), v_o)
    else pg_catalog.to_timestamp(pg_catalog.ceil(extract(epoch from v_now - case p_range when '1h' then interval '1 hour'
                                                                               when '2h' then interval '2 hours'
                                                                               else interval '6 hours' end) / 900) * 900)
  end;

  -- Every existing field, names out (recent keeps its shape: name is null).
  v_base := public.lp_stats();
  v_base := v_base || pg_catalog.jsonb_build_object('recent', coalesce((
    select pg_catalog.jsonb_agg(r || '{"name": null}'::jsonb order by o)
    from pg_catalog.jsonb_array_elements(v_base -> 'recent') with ordinality as x(r, o)), '[]'::jsonb));

  with p as (
    select pt.id, pt.case_number, pt.created_at, pt.status, pt.recheck_at, pt.swap_requested_at,
           case pt.reporting_location when 'FA 4 – Oasis' then 'FA 4' when 'FA 3 – Kinetic' then 'FA 3' else 'Other' end as tent,
           case pt.reporting_location when 'FA 4 – Oasis' then 'FA 4' when 'FA 3 – Kinetic' then 'FA 3'
                when 'Command' then 'Command' when 'Base' then 'Base' else 'Other' end as short
    from public.patients pt
  ), ev as (
    -- The lifecycle steps, read from the audit trail exactly as lp_stats() reads them.
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
            or e.action_type = 'medical_search_found') as is_located,
           (e.action_type = 'status_changed' and e.new_value ->> 'status' = 'Reunited – Closed') as is_reunited,
           (e.action_type = 'status_changed' and e.new_value ->> 'status' = 'Checked – Not Found') as is_not_located
    from public.audit_events e
    where e.patient_id is not null
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
    -- Calls buckets: 15 min over the range, or (event) 1 h over each night from its first call to its last
    -- (to now for tonight's).
    select null::date as night, g.b
    from pg_catalog.generate_series(pg_catalog.date_bin(v_step, v_from, v_o), pg_catalog.date_bin(v_step, v_now, v_o), v_step) as g(b)
    where p_range <> 'event'
    union all
    select n.night, g.b
    from (
      select pg_catalog.date_trunc('day', (lc.created_at at time zone v_tz) - interval '12 hours')::date as night,
             pg_catalog.min(pg_catalog.date_bin(v_step, lc.created_at, v_o)) as b0,
             pg_catalog.max(pg_catalog.date_bin(v_step, lc.created_at, v_o)) as b1
      from lc
      where p_range = 'event'
      group by 1
    ) n
    cross join lateral pg_catalog.generate_series(
      n.b0, case when n.night = v_night then greatest(n.b1, pg_catalog.date_bin(v_step, v_now, v_o)) else n.b1 end, v_step) as g(b)
  ), cur as (
    select pg_catalog.date_bin(v_step, created_at, v_o) as b,
           pg_catalog.count(*) filter (where tent = 'FA 4')::integer as fa4,
           pg_catalog.count(*) filter (where tent = 'FA 3')::integer as fa3,
           pg_catalog.count(*) filter (where tent = 'Other')::integer as other
    from lc
    where created_at >= v_from and created_at < v_now
    group by 1
  ), prv as (
    select pg_catalog.date_bin(v_step, created_at + v_day, v_o) as b, pg_catalog.count(*)::integer as n
    from lc
    where v_cmp and created_at >= v_from - v_day and created_at < pg_catalog.date_bin(v_step, v_now, v_o) + v_step - v_day
    group by 1
  ), sb as (
    -- Sparkline buckets: the calls buckets when they share the step (1h, 2h, event), else hourly.
    select bk.night, bk.b from bk where v_spark = v_step
    union all
    select null::date, g.b
    from pg_catalog.generate_series(pg_catalog.date_bin(v_spark, v_from, v_o), pg_catalog.date_bin(v_spark, v_now, v_o), v_spark) as g(b)
    where v_spark <> v_step
  ), kinds as (
    select * from (values ('firstCheck', 10, 1), ('located', 15, 2), ('reunited', 30, 3)) as k(k, target, ord)
  ), att as (
    select x.*, en.enroute, en.eta_at
    from (
      select id, case_number, short, 'wait' as kind, created_at as since, extract(epoch from v_now - created_at) / 60 - 30 as score
      from lc where status = 'Added' and recheck_at is null
      union all
      select id, case_number, short, 'recheck', recheck_at, extract(epoch from v_now - recheck_at) / 60 - 10
      from lc where status = 'Added' and recheck_at is not null and recheck_at <= v_now
      union all
      select id, case_number, short, 'located', coalesce(located_last_at, created_at),
             extract(epoch from v_now - coalesce(located_last_at, created_at)) / 60 - 30
      from lc where status in ('Found – Awaiting Reunion', 'Bring friend to medical')
      union all
      -- (Companion) A friend swap request waits on the answerer: red 10 min after it was asked.
      select id, case_number, short, 'swap', swap_requested_at, extract(epoch from v_now - swap_requested_at) / 60 - 10
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
                                           'step', (extract(epoch from v_step) / 60)::integer, 'compare', v_cmp),
    'live', (select pg_catalog.jsonb_build_object(
               'waiting', pg_catalog.count(*) filter (where status = 'Added' and recheck_at is null),
               'pending', pg_catalog.count(*) filter (where status = 'Added' and recheck_at is not null),
               'located', pg_catalog.count(*) filter (where status in ('Found – Awaiting Reunion', 'Bring friend to medical', 'Found – Accompanied')))
             from lc),
    'attention', pg_catalog.jsonb_build_object(
      'total', (select pg_catalog.count(*) from att),
      'items', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                 'id', t.id, 'caseNumber', t.case_number, 'tent', t.short, 'kind', t.kind, 'since', t.since,
                 'enroute', coalesce(t.enroute, false), 'etaAt', t.eta_at) order by t.score desc, t.case_number)
        from (select * from att order by score desc, case_number limit 5) t), '[]'::jsonb)),
    'speed', (
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'key', k.k, 'target', k.target, 'n', s.n, 'median', s.med, 'p90', s.p90, 'prevMedian', s.prev,
               'byTent', s.by_tent, 'spark', s.spark) order by k.ord)
      from kinds k
      cross join lateral (
        select
          (select pg_catalog.count(*) from dur where dur.k = k.k and dur.e >= v_from and dur.e < v_now)::integer as n,
          (select pg_catalog.round((pg_catalog.percentile_cont(0.5) within group (order by dur.m))::numeric, 1)
             from dur where dur.k = k.k and dur.e >= v_from and dur.e < v_now) as med,
          (select pg_catalog.round((pg_catalog.percentile_cont(0.9) within group (order by dur.m))::numeric, 1)
             from dur where dur.k = k.k and dur.e >= v_from and dur.e < v_now) as p90,
          (select pg_catalog.round((pg_catalog.percentile_cont(0.5) within group (order by dur.m))::numeric, 1)
             from dur where v_cmp and dur.k = k.k and dur.e >= v_from - v_day and dur.e < v_now - v_day) as prev,
          (select pg_catalog.jsonb_object_agg(tt.tent, (
                    select pg_catalog.round((pg_catalog.percentile_cont(0.5) within group (order by dur.m))::numeric, 1)
                    from dur where dur.k = k.k and dur.tent = tt.tent and dur.e >= v_from and dur.e < v_now))
             from (values ('FA 4'), ('FA 3'), ('Other')) as tt(tent)) as by_tent,
          (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                    'at', sb.b, 'night', sb.night, 'n', q.n, 'median', q.med, 'p90', q.p90) order by sb.b), '[]'::jsonb)
             from sb
             cross join lateral (
               select pg_catalog.count(*)::integer as n,
                      pg_catalog.round((pg_catalog.percentile_cont(0.5) within group (order by dur.m))::numeric, 1) as med,
                      pg_catalog.round((pg_catalog.percentile_cont(0.9) within group (order by dur.m))::numeric, 1) as p90
               from dur
               where dur.k = k.k and dur.e >= greatest(sb.b, v_from) and dur.e < least(sb.b + v_spark, v_now)
             ) q) as spark
      ) s),
    'calls', pg_catalog.jsonb_build_object(
      'total', (select pg_catalog.count(*) from lc where created_at >= v_from and created_at < v_now),
      'prevTotal', case when v_cmp then (select pg_catalog.count(*) from lc
                                         where created_at >= v_from - v_day and created_at < v_now - v_day) end,
      'buckets', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                 'at', bk.b, 'night', bk.night, 'fa4', coalesce(cur.fa4, 0), 'fa3', coalesce(cur.fa3, 0),
                 'other', coalesce(cur.other, 0), 'prev', case when v_cmp then coalesce(prv.n, 0) end) order by bk.b)
        from bk
        left join cur on cur.b = bk.b
        left join prv on prv.b = bk.b), '[]'::jsonb)),
    'heat', case when p_range = 'event' then pg_catalog.jsonb_build_object('step', 60, 'cols', coalesce((
        -- ET clock hours from noon, summed over every night; dense from the first hour with a call to the last.
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                 'hour', (h.o + 12) % 24, 'fa4', coalesce(c.fa4, 0), 'fa3', coalesce(c.fa3, 0), 'other', coalesce(c.other, 0))
                 order by h.o)
        from (
          select pg_catalog.generate_series(pg_catalog.min(o), pg_catalog.max(o)) as o
          from (select ((extract(hour from created_at at time zone v_tz)::integer + 12) % 24) as o from lc) z
        ) h
        left join (
          select ((extract(hour from created_at at time zone v_tz)::integer + 12) % 24) as o,
                 pg_catalog.count(*) filter (where tent = 'FA 4')::integer as fa4,
                 pg_catalog.count(*) filter (where tent = 'FA 3')::integer as fa3,
                 pg_catalog.count(*) filter (where tent = 'Other')::integer as other
          from lc group by 1
        ) c on c.o = h.o), '[]'::jsonb))
      else pg_catalog.jsonb_build_object('step', (extract(epoch from v_spark) / 60)::integer, 'cols', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                 'at', g.b, 'fa4', coalesce(c.fa4, 0), 'fa3', coalesce(c.fa3, 0), 'other', coalesce(c.other, 0)) order by g.b)
        from pg_catalog.generate_series(pg_catalog.date_bin(v_spark, v_from, v_o), pg_catalog.date_bin(v_spark, v_now, v_o), v_spark) as g(b)
        left join (
          select pg_catalog.date_bin(v_spark, created_at, v_o) as b,
                 pg_catalog.count(*) filter (where tent = 'FA 4')::integer as fa4,
                 pg_catalog.count(*) filter (where tent = 'FA 3')::integer as fa3,
                 pg_catalog.count(*) filter (where tent = 'Other')::integer as other
          from lc where created_at >= v_from and created_at < v_now group by 1
        ) c on c.b = g.b), '[]'::jsonb))
      end,
    'recap', (
      select pg_catalog.jsonb_build_object(
        'reunited', pg_catalog.count(*) filter (where reunited_at >= v_from and reunited_at < v_now),
        'notLocated', pg_catalog.count(*) filter (where not_located_at >= v_from and not_located_at < v_now),
        'fastest', pg_catalog.round((pg_catalog.min(extract(epoch from reunited_at - created_at) / 60)
                     filter (where reunited_at >= v_from and reunited_at < v_now))::numeric, 1),
        'prevReunited', case when v_cmp then pg_catalog.count(*) filter (
                          where reunited_at >= v_from - v_day and reunited_at < v_now - v_day) end,
        'prevNotLocated', case when v_cmp then pg_catalog.count(*) filter (
                            where not_located_at >= v_from - v_day and not_located_at < v_now - v_day) end,
        'prevFastest', case when v_cmp then pg_catalog.round((pg_catalog.min(extract(epoch from reunited_at - created_at) / 60)
                         filter (where reunited_at >= v_from - v_day and reunited_at < v_now - v_day))::numeric, 1) end,
        'lastReunionAt', pg_catalog.max(reunited_at))
      from lc)
  ) into v_out;

  -- Who's on: per team, people with any activity in the last 10 minutes. The audit trail and messages name a
  -- person (canonical "name · team"); telemetry has sign-in sessions. A person can be in both, so a team's
  -- number is the larger of the two, never their sum.
  with acts as (
    select public.lp_canon_staff(e.staff_name) as who
    from public.audit_events e
    where e.occurred_at > v_now - interval '10 minutes' and e.staff_name like '% · %'
    union
    select m.staff_key from public.lp_messages m where m.created_at > v_now - interval '10 minutes'
  ), named as (
    select case when t like '%dispatch%' then 'dispatch' when t like '%transpo%' then 'transpo'
                when t like '%base%' then 'base' when t like '%medical%' then 'medical' else 'other' end as team,
           pg_catalog.count(distinct who)::integer as n
    from (select a.who, pg_catalog.lower(pg_catalog.regexp_replace(a.who, '^.* · ', '')) as t from acts a where a.who is not null) s
    group by 1
  ), teams as (
    select * from (values ('medical', 1), ('dispatch', 2), ('base', 3), ('transpo', 4), ('other', 5)) as t(team, ord)
  )
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('team', t.team, 'on', coalesce(n.n, 0)) order by t.ord)
    into v_team
  from teams t
  left join named n on n.team = t.team
  where t.team <> 'other' or coalesce(n.n, 0) > 0;

  -- Telemetry (2026-11-08, off by itself 2026-11-10) adds the sessions that only looked: read only when there.
  if pg_catalog.to_regclass('public.lp_tel_events') is not null then
    select pg_catalog.jsonb_agg(
             case when x.n > (t ->> 'on')::integer then t || pg_catalog.jsonb_build_object('on', x.n) else t end
             order by o)
      into v_team
    from pg_catalog.jsonb_array_elements(v_team) with ordinality as a(t, o)
    left join (
      select te.team, pg_catalog.count(distinct te.session)::integer as n
      from public.lp_tel_events te
      where te.at > v_now - interval '10 minutes' and te.session <> 'server'
      group by te.team
    ) x on x.team = t ->> 'team';
  end if;

  return v_base || v_out || pg_catalog.jsonb_build_object('team', coalesce(v_team, '[]'::jsonb));
end
$fn$;

-- lp_swap: the friend swap on an Accompanied request (POST /api/requests/:id/swap).
--   p_action 'request'  → swap_requested_at/by set; the status stays Accompanied. Audit swap_requested.
--            'approve'  → p_place 'fa' (the request's own tent / post) or 'mm' (Main Med): status
--                         'Found – Awaiting Reunion', swap_place set, the request cleared. Audit status_changed
--                         (kind 'swap'), so it reads as a Located answer everywhere (stats, involved, Undo).
--            'decline'  → the request cleared; stays Accompanied. Audit swap_declined.
--            'withdraw' → the same without telling anyone (the requester's Undo). Audit swap_withdrawn.
--   Idempotent repeats → {changed: false}. Stale p_expected_version → P0409; not Accompanied → P0422
--   illegal_transition (hint: the status). Returns {changed, row, answerer, requester, creator}: who the app
--   server tells (answerer = the latest status change into Accompanied / Located).
create or replace function public.lp_swap(p_id uuid, p_expected_version bigint, p_action text, p_place text, p_staff text)
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
  v_requester text;
  v_answerer text;
begin
  perform public.lp_require_staff(p_staff);

  if p_id is null then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;
  if p_expected_version is null then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:expected_version';
  end if;
  if p_action is null or p_action not in ('request', 'approve', 'decline', 'withdraw') then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:action';
  end if;
  if p_action = 'approve' and (p_place is null or p_place not in ('fa', 'mm')) then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:place';
  end if;

  select * into v_row from public.patients where id = p_id for update;
  if v_row.id is null then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;
  v_requester := v_row.swap_requested_by;

  if (p_action = 'request' and v_row.status = 'Found – Accompanied' and v_row.swap_requested_at is not null)
     or (p_action in ('decline', 'withdraw') and v_row.status = 'Found – Accompanied' and v_row.swap_requested_at is null)
     or (p_action = 'approve' and v_row.status = 'Found – Awaiting Reunion' and v_row.swap_place = p_place) then
    return pg_catalog.jsonb_build_object('changed', false, 'row', public.lp_row(v_row));
  end if;

  if v_row.row_version <> p_expected_version then
    raise exception using errcode = 'P0409', message = 'version_conflict', hint = v_row.status;
  end if;
  if v_row.status <> 'Found – Accompanied' then
    raise exception using errcode = 'P0422', message = 'illegal_transition', hint = v_row.status;
  end if;

  v_prev := pg_catalog.jsonb_build_object(
    'status', v_row.status,
    'found_at', v_row.found_at,
    'reunion_started_at', v_row.reunion_started_at,
    'closed_at', v_row.closed_at,
    'recheck_at', v_row.recheck_at,
    'not_found_checks', v_row.not_found_checks
  ) || pg_catalog.jsonb_build_object(
    'swap_requested_at', v_row.swap_requested_at,
    'swap_requested_by', v_row.swap_requested_by,
    'swap_place', v_row.swap_place
  );

  if p_action = 'request' then
    update public.patients
       set swap_requested_at = now(), swap_requested_by = p_staff, updated_by = p_staff
     where id = p_id
    returning * into v_row;
    insert into public.audit_events (patient_id, staff_name, action_type, previous_value, new_value)
    values (p_id, p_staff, 'swap_requested', v_prev, pg_catalog.jsonb_build_object('status', v_row.status));

    select e.staff_name into v_answerer
      from public.audit_events e
     where e.patient_id = p_id
       and e.action_type in ('status_changed', 'check_completed')
       and e.new_value ->> 'status' in ('Found – Accompanied', 'Found – Awaiting Reunion', 'Bring friend to medical')
     order by e.occurred_at desc, e.id desc
     limit 1;
  elsif p_action = 'approve' then
    update public.patients
       set status = 'Found – Awaiting Reunion',
           swap_place = p_place,
           swap_requested_at = null,
           swap_requested_by = null,
           found_at = coalesce(found_at, now()),
           reunion_started_at = now(),
           closed_at = null,
           recheck_at = null,
           updated_by = p_staff
     where id = p_id
    returning * into v_row;
    insert into public.audit_events (patient_id, staff_name, action_type, previous_value, new_value)
    values (p_id, p_staff, 'status_changed', v_prev,
            pg_catalog.jsonb_build_object('status', v_row.status, 'kind', 'swap', 'swap_place', p_place)
            || pg_catalog.jsonb_build_object('recheck_at', null, 'not_found_checks', v_row.not_found_checks));
  else
    update public.patients
       set swap_requested_at = null, swap_requested_by = null, updated_by = p_staff
     where id = p_id
    returning * into v_row;
    insert into public.audit_events (patient_id, staff_name, action_type, previous_value, new_value)
    values (p_id, p_staff, case when p_action = 'decline' then 'swap_declined' else 'swap_withdrawn' end, v_prev,
            pg_catalog.jsonb_build_object('status', v_row.status));
  end if;

  return pg_catalog.jsonb_build_object('changed', true, 'row', public.lp_row(v_row),
    'answerer', v_answerer, 'requester', v_requester, 'creator', v_row.created_by);
end
$fn$;

revoke all on function public.lp_swap(uuid, bigint, text, text, text) from public, anon, authenticated;
grant execute on function public.lp_swap(uuid, bigint, text, text, text) to service_role;

notify pgrst, 'reload schema';

commit;
