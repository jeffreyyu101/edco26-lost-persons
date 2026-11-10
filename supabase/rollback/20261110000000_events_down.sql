-- =====================================================================================================
-- supabase/rollback/20261110000000_events_down.sql — undo the multi-event migration's SCHEMA, so the build before it
-- (main at 0a416a9) works again. NOT a migration: it lives outside supabase/migrations so nothing applies it by
-- itself. Release runbook: docs/RELEASE-events.md ("Roll back").
--
-- Only while no event is live: it refuses to run when any event is live, or when any request belongs to an event other
-- than edco26 (the old build has one log and would show them as EDC's, numbered against EDC's).
--
-- What it does (one transaction; safe to run twice; deletes no data):
--   * drops the write guards (patients and its child tables): the old build writes the EDC rows the guard froze;
--   * patients: event_id may be NULL again (the old build inserts without it; a later run of the events migration puts
--     such rows in edco26), case_number takes the global sequence again (moved past the highest number) with its global
--     unique rule, and the fixed post CHECK is back (NOT VALID, as the rework file left it);
--   * the functions the events migration replaced or retired come back exactly as they were before it (bodies and
--     grants, generated from a database built from the migrations before it), and the event-scoped overloads of the
--     same names are dropped so every RPC name resolves as the old build expects.
-- Kept: the events / lp_org tables and every event_id column with its values, the lead RPCs, the event-logos bucket.
-- Running 20261110000000_events.sql again afterwards brings everything back (tests/integration/events-rollback.test.ts).
--
-- Generated from the pre-events chain (supabase/migrations/*.sql before 20261110000000_events.sql); the function
-- bodies below are pg_get_functiondef output, unedited.
-- =====================================================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $pre$
declare
  v_edc uuid;
begin
  if pg_catalog.to_regclass('public.events') is null then
    raise exception 'Rollback refused: public.events is missing (the events migration was never applied here).';
  end if;
  v_edc := (select e.id from public.events e where e.slug = 'edco26');
  if exists (select 1 from public.events e where e.stage = 'live') then
    raise exception 'Rollback refused: an event is live. End it first (the old build cannot hold more than the EDC log).';
  end if;
  if exists (select 1 from public.patients p where p.event_id is distinct from v_edc and p.event_id is not null) then
    raise exception 'Rollback refused: requests of another event exist; the old build would show them as EDC''s. Nothing changed.';
  end if;
end
$pre$;

-- 1. The write guards go (the old build writes the EDC rows).
drop trigger if exists lp_patients_writable on public.patients;
drop trigger if exists lp_audit_events_writable on public.audit_events;
drop trigger if exists lp_messages_writable on public.lp_messages;
drop trigger if exists lp_patient_photos_writable on public.patient_photos;
drop trigger if exists lp_enroute_writable on public.lp_enroute;

-- 2. patients as the old build expects it.
alter table public.patients alter column event_id drop not null;

do $numbers$
declare
  v_max bigint := coalesce((select pg_catalog.max(p.case_number) from public.patients p), 0);
  v_last bigint;
  v_called boolean;
begin
  select s.last_value, s.is_called into v_last, v_called from public.patient_case_number_seq s;
  -- The sequence only ever moves up: the next number follows the highest one in use.
  v_max := greatest(v_max, case when v_called then v_last else v_last - 1 end);
  if v_max >= 1 then
    perform pg_catalog.setval('public.patient_case_number_seq', v_max, true);
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint c
                  where c.conrelid = 'public.patients'::regclass and c.conname = 'patients_case_number_key') then
    if exists (select 1 from public.patients p group by p.case_number having pg_catalog.count(*) > 1) then
      raise exception 'Rollback refused: a case number is used twice; the global unique rule cannot come back. Nothing changed.';
    end if;
    alter table public.patients add constraint patients_case_number_key unique (case_number);
  end if;
end
$numbers$;
alter table public.patients alter column case_number set default pg_catalog.nextval('public.patient_case_number_seq'::regclass);

do $posts$
begin
  if not exists (select 1 from pg_catalog.pg_constraint c
                  where c.conrelid = 'public.patients'::regclass and c.conname = 'patients_reporting_location_check') then
    alter table public.patients add constraint patients_reporting_location_check
      check (reporting_location = any (array['FA 3 – Kinetic', 'FA 4 – Oasis', 'Command', 'Base', 'Other'])) not valid;
  end if;
end
$posts$;

-- 3. The event-scoped overloads of the old names go (the events migration creates them again).
drop function if exists public.lp_activity_fallback_staff(uuid,uuid);
drop function if exists public.lp_activity_list(uuid,text);
drop function if exists public.lp_activity_mark_read(uuid,text,uuid);
drop function if exists public.lp_activity_record(uuid,text[],uuid,text,text,text);
drop function if exists public.lp_activity_unmark(uuid,text,uuid[]);
drop function if exists public.lp_activity_unread(uuid,text);
drop function if exists public.lp_add_photo(uuid,uuid,uuid,text,text,text,text);
drop function if exists public.lp_cancel(uuid,uuid,bigint,text);
drop function if exists public.lp_clean_fields(uuid,jsonb,boolean);
drop function if exists public.lp_create_request(uuid,jsonb,text);
drop function if exists public.lp_detail(uuid,uuid);
drop function if exists public.lp_enroute_stats(uuid);
drop function if exists public.lp_inactive_claim(uuid,uuid[]);
drop function if exists public.lp_involved_staff(uuid,uuid);
drop function if exists public.lp_mark_read(uuid,uuid,text,timestamp with time zone);
drop function if exists public.lp_messages_sync(uuid,text,uuid[],timestamp with time zone,boolean);
drop function if exists public.lp_messages_thread(uuid,uuid,text,timestamp with time zone,uuid,integer);
drop function if exists public.lp_post_message(uuid,uuid,text,uuid,text,text);
drop function if exists public.lp_push_new_request_staff(uuid);
drop function if exists public.lp_push_subscribe(uuid,text,text,text,text,text,text,text,boolean);
drop function if exists public.lp_set_enroute(uuid,uuid,text,integer,timestamp with time zone,integer,text);
drop function if exists public.lp_set_status(uuid,uuid,bigint,text,text,text);
drop function if exists public.lp_stats(uuid,text);
drop function if exists public.lp_swap(uuid,uuid,bigint,text,text,text);
drop function if exists public.lp_sync(uuid,timestamp with time zone,uuid[],boolean,timestamp with time zone,uuid,integer);
drop function if exists public.lp_tel_health(uuid,text,timestamp with time zone,integer);
drop function if exists public.lp_tel_ingest(uuid,text,text,text,text,bigint,jsonb,jsonb,integer,text);
drop function if exists public.lp_tel_server_events(uuid,jsonb);
drop function if exists public.lp_unsend_message(uuid,uuid,uuid,text);
drop function if exists public.lp_update_fields(uuid,uuid,jsonb,bigint,text);

-- 4. The functions as they were before the events migration (bodies and grants).

-- lp_activity_fallback_staff(uuid)
CREATE OR REPLACE FUNCTION public.lp_activity_fallback_staff(p_request uuid)
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '4s'
AS $function$
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
$function$
;
revoke all on function public.lp_activity_fallback_staff(uuid) from public, anon, authenticated, service_role;
grant execute on function public.lp_activity_fallback_staff(uuid) to service_role;

-- lp_activity_list(text)
CREATE OR REPLACE FUNCTION public.lp_activity_list(p_staff text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '4s'
AS $function$
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
$function$
;
revoke all on function public.lp_activity_list(text) from public, anon, authenticated, service_role;
grant execute on function public.lp_activity_list(text) to service_role;

-- lp_activity_mark_read(text,uuid)
CREATE OR REPLACE FUNCTION public.lp_activity_mark_read(p_staff text, p_request uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '4s'
 SET lock_timeout TO '2s'
AS $function$
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
$function$
;
revoke all on function public.lp_activity_mark_read(text,uuid) from public, anon, authenticated, service_role;
grant execute on function public.lp_activity_mark_read(text,uuid) to service_role;

-- lp_activity_record(text[],uuid,text,text,text)
CREATE OR REPLACE FUNCTION public.lp_activity_record(p_recipients text[], p_request uuid, p_kind text, p_actor text, p_detail text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '4s'
 SET lock_timeout TO '2s'
AS $function$
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
$function$
;
revoke all on function public.lp_activity_record(text[],uuid,text,text,text) from public, anon, authenticated, service_role;
grant execute on function public.lp_activity_record(text[],uuid,text,text,text) to service_role;

-- lp_activity_unmark(text,uuid[])
CREATE OR REPLACE FUNCTION public.lp_activity_unmark(p_staff text, p_requests uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '4s'
 SET lock_timeout TO '2s'
AS $function$
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
$function$
;
revoke all on function public.lp_activity_unmark(text,uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.lp_activity_unmark(text,uuid[]) to service_role;

-- lp_activity_unread(text)
CREATE OR REPLACE FUNCTION public.lp_activity_unread(p_staff text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '4s'
AS $function$
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
$function$
;
revoke all on function public.lp_activity_unread(text) from public, anon, authenticated, service_role;
grant execute on function public.lp_activity_unread(text) to service_role;

-- lp_add_photo(uuid,uuid,text,text,text,text)
CREATE OR REPLACE FUNCTION public.lp_add_photo(p_id uuid, p_photo_id uuid, p_path text, p_thumb text, p_timing text, p_staff text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '4s'
 SET lock_timeout TO '2s'
AS $function$
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
$function$
;
revoke all on function public.lp_add_photo(uuid,uuid,text,text,text,text) from public, anon, authenticated, service_role;
grant execute on function public.lp_add_photo(uuid,uuid,text,text,text,text) to service_role;

-- lp_cancel(uuid,bigint,text)
CREATE OR REPLACE FUNCTION public.lp_cancel(p_id uuid, p_expected_version bigint, p_staff text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '4s'
 SET lock_timeout TO '2s'
AS $function$
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
$function$
;
revoke all on function public.lp_cancel(uuid,bigint,text) from public, anon, authenticated, service_role;
grant execute on function public.lp_cancel(uuid,bigint,text) to service_role;

-- lp_clean_fields(jsonb,boolean)
CREATE OR REPLACE FUNCTION public.lp_clean_fields(p jsonb, p_partial boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;
revoke all on function public.lp_clean_fields(jsonb,boolean) from public, anon, authenticated, service_role;
grant execute on function public.lp_clean_fields(jsonb,boolean) to service_role;

-- lp_close_inactive(uuid[])
CREATE OR REPLACE FUNCTION public.lp_close_inactive(p_only uuid[] DEFAULT NULL::uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '4s'
 SET lock_timeout TO '2s'
AS $function$
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
$function$
;
revoke all on function public.lp_close_inactive(uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.lp_close_inactive(uuid[]) to service_role;

-- lp_create_request(jsonb,text)
CREATE OR REPLACE FUNCTION public.lp_create_request(p jsonb, p_staff text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '4s'
 SET lock_timeout TO '2s'
AS $function$
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
$function$
;
revoke all on function public.lp_create_request(jsonb,text) from public, anon, authenticated, service_role;
grant execute on function public.lp_create_request(jsonb,text) to service_role;

-- lp_detail(uuid)
CREATE OR REPLACE FUNCTION public.lp_detail(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '4s'
 SET lock_timeout TO '2s'
AS $function$
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
$function$
;
revoke all on function public.lp_detail(uuid) from public, anon, authenticated, service_role;
grant execute on function public.lp_detail(uuid) to service_role;

-- lp_enroute_stats()
CREATE OR REPLACE FUNCTION public.lp_enroute_stats()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '4s'
 SET lock_timeout TO '2s'
AS $function$
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
$function$
;
revoke all on function public.lp_enroute_stats() from public, anon, authenticated, service_role;
grant execute on function public.lp_enroute_stats() to service_role;

-- lp_enroute_summary(uuid,text)
CREATE OR REPLACE FUNCTION public.lp_enroute_summary(p_request uuid, p_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;
revoke all on function public.lp_enroute_summary(uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.lp_enroute_summary(uuid,text) to service_role;

-- lp_inactive_claim(uuid[])
CREATE OR REPLACE FUNCTION public.lp_inactive_claim(p_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '4s'
 SET lock_timeout TO '2s'
AS $function$
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
$function$
;
revoke all on function public.lp_inactive_claim(uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.lp_inactive_claim(uuid[]) to service_role;

-- lp_involved_staff(uuid)
CREATE OR REPLACE FUNCTION public.lp_involved_staff(p_request uuid)
 RETURNS SETOF text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '4s'
 SET lock_timeout TO '2s'
AS $function$
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
$function$
;
revoke all on function public.lp_involved_staff(uuid) from public, anon, authenticated, service_role;
grant execute on function public.lp_involved_staff(uuid) to service_role;

-- lp_mark_read(uuid,text,timestamp with time zone)
CREATE OR REPLACE FUNCTION public.lp_mark_read(p_request uuid, p_staff text, p_upto timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '4s'
 SET lock_timeout TO '2s'
AS $function$
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
$function$
;
revoke all on function public.lp_mark_read(uuid,text,timestamp with time zone) from public, anon, authenticated, service_role;
grant execute on function public.lp_mark_read(uuid,text,timestamp with time zone) to service_role;

-- lp_messages_activity(uuid,text,text)
CREATE OR REPLACE FUNCTION public.lp_messages_activity(p_request uuid, p_key text, p_status text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;
revoke all on function public.lp_messages_activity(uuid,text,text) from public, anon, authenticated, service_role;
grant execute on function public.lp_messages_activity(uuid,text,text) to service_role;

-- lp_messages_sync(text,uuid[],timestamp with time zone,boolean)
CREATE OR REPLACE FUNCTION public.lp_messages_sync(p_staff text, p_ids uuid[], p_since timestamp with time zone, p_changed boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '4s'
 SET lock_timeout TO '2s'
AS $function$
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
$function$
;
revoke all on function public.lp_messages_sync(text,uuid[],timestamp with time zone,boolean) from public, anon, authenticated, service_role;
grant execute on function public.lp_messages_sync(text,uuid[],timestamp with time zone,boolean) to service_role;

-- lp_messages_thread(uuid,text,timestamp with time zone,uuid,integer)
CREATE OR REPLACE FUNCTION public.lp_messages_thread(p_request uuid, p_staff text, p_before_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '4s'
 SET lock_timeout TO '2s'
AS $function$
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
$function$
;
revoke all on function public.lp_messages_thread(uuid,text,timestamp with time zone,uuid,integer) from public, anon, authenticated, service_role;
grant execute on function public.lp_messages_thread(uuid,text,timestamp with time zone,uuid,integer) to service_role;

-- lp_post_message(uuid,text,uuid,text,text)
CREATE OR REPLACE FUNCTION public.lp_post_message(p_request uuid, p_body text, p_client_mutation_id uuid, p_staff text, p_team text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '4s'
 SET lock_timeout TO '2s'
AS $function$
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
$function$
;
revoke all on function public.lp_post_message(uuid,text,uuid,text,text) from public, anon, authenticated, service_role;
grant execute on function public.lp_post_message(uuid,text,uuid,text,text) to service_role;

-- lp_push_new_request_staff()
CREATE OR REPLACE FUNCTION public.lp_push_new_request_staff()
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '4s'
AS $function$
begin
  return coalesce((select pg_catalog.array_agg(pr.staff order by pr.staff) from public.lp_push_prefs pr where pr.new_requests), '{}'::text[]);
end
$function$
;
revoke all on function public.lp_push_new_request_staff() from public, anon, authenticated, service_role;
grant execute on function public.lp_push_new_request_staff() to service_role;

-- lp_push_subscribe(text,text,text,text,text,text,text,boolean)
CREATE OR REPLACE FUNCTION public.lp_push_subscribe(p_endpoint text, p_p256dh text, p_auth text, p_staff text, p_team text, p_user_agent text, p_old_endpoint text, p_default_new_requests boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '4s'
 SET lock_timeout TO '2s'
AS $function$
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
$function$
;
revoke all on function public.lp_push_subscribe(text,text,text,text,text,text,text,boolean) from public, anon, authenticated, service_role;
grant execute on function public.lp_push_subscribe(text,text,text,text,text,text,text,boolean) to service_role;

-- lp_set_enroute(uuid,text,integer,timestamp with time zone,integer,text)
CREATE OR REPLACE FUNCTION public.lp_set_enroute(p_request uuid, p_action text, p_eta_offset_seconds integer, p_eta_at timestamp with time zone, p_eta_minutes integer, p_staff text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '4s'
 SET lock_timeout TO '2s'
AS $function$
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
$function$
;
revoke all on function public.lp_set_enroute(uuid,text,integer,timestamp with time zone,integer,text) from public, anon, authenticated, service_role;
grant execute on function public.lp_set_enroute(uuid,text,integer,timestamp with time zone,integer,text) to service_role;

-- lp_set_status(uuid,bigint,text,text,text)
CREATE OR REPLACE FUNCTION public.lp_set_status(p_id uuid, p_expected_version bigint, p_status text, p_staff text, p_kind text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '4s'
 SET lock_timeout TO '2s'
AS $function$
declare
  v_row public.patients;
  v_prev jsonb;
  v_allowed boolean;
  v_held boolean;
  v_last jsonb;
  v_last_to text;
  v_recheck timestamptz;
  v_checks integer;
  v_swap_at timestamptz := null;
  v_swap_by text := null;
  v_closed_from text;
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

  -- (Post-event) Reopen of a request closed while Located · already accompanied (inactive, discharged) goes back
  -- to Accompanied, never to Located · friend coming (which tells front of house to send the friend).
  if p_kind = 'reopen' and p_status in ('Found – Awaiting Reunion', 'Found – Accompanied')
     and v_row.status in ('Closed – Inactive', 'Found – Discharged') then
    select e.previous_value ->> 'status' into v_closed_from
      from public.audit_events e
     where e.patient_id = p_id and e.action_type = 'status_changed' and e.new_value ->> 'status' = v_row.status
     order by e.occurred_at desc, e.id desc
     limit 1;
    if v_closed_from = 'Found – Accompanied' then
      p_status := 'Found – Accompanied';
    end if;
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
    when 'Closed – Inactive' then p_status in ('Found – Awaiting Reunion', 'Found – Accompanied')
    when 'Found – Accompanied' then p_status in ('Closed – Friend Informed', 'Found – Awaiting Reunion', 'Checked – Not Found', 'Found – Discharged', 'Added')
    when 'Closed – Friend Informed' then p_status in ('Found – Accompanied')
    -- TRANSITIONS:END
    else false
  end;
  -- (F5) Waiting for check → Waiting for check is allowed only to clear or restore a hold (see above).
  if v_row.status = 'Added' and p_status = 'Added' and v_held then
    v_allowed := p_kind in ('undo', 'change');
  end if;
  -- (Post-event) Moves allowed for one kind only (keep identical to KIND_ONLY_TRANSITIONS in lib/domain.ts).
  -- KIND_ONLY:BEGIN
  if v_row.status = 'Closed – Inactive' and p_status = 'Found – Accompanied' then
    v_allowed := p_kind = 'reopen' and v_closed_from is not distinct from 'Found – Accompanied';
  end if;
  -- KIND_ONLY:END
  if not coalesce(v_allowed, false) then
    raise exception using errcode = 'P0422', message = 'illegal_transition', hint = v_row.status;
  end if;
  -- (Post-event) Friend informed while a swap request is open: someone asked for the swap after this tap's view.
  -- No hint (PostgREST cannot render a non-ASCII one, and the status is unchanged anyway).
  if p_status = 'Closed – Friend Informed' and v_row.swap_requested_at is not null then
    raise exception using errcode = 'P0409', message = 'version_conflict';
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
  ) || pg_catalog.jsonb_build_object(
    -- (Post-event) The open swap request this change ends, for its Undo.
    'swap_requested_at', v_row.swap_requested_at,
    'swap_requested_by', v_row.swap_requested_by
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
      -- (Post-event) Back to Accompanied: the swap request the undone change ended comes back with it.
      if p_status = 'Found – Accompanied' then
        v_swap_at := (v_last ->> 'swap_requested_at')::timestamptz;
        v_swap_by := v_last ->> 'swap_requested_by';
      end if;
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
           -- (Companion) Any status change ends an open swap request (an Undo back to Accompanied puts it back); a
           -- swap place lasts while the swap runs.
           swap_requested_at = v_swap_at,
           swap_requested_by = case when v_swap_at is null then null else v_swap_by end,
           swap_closed = null,
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
$function$
;
revoke all on function public.lp_set_status(uuid,bigint,text,text,text) from public, anon, authenticated, service_role;
grant execute on function public.lp_set_status(uuid,bigint,text,text,text) to service_role;

-- lp_stats()
CREATE OR REPLACE FUNCTION public.lp_stats()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '4s'
 SET lock_timeout TO '2s'
AS $function$
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
        -- (Post-event) Accompanied → Located (a swap approved, or Change answer): the friend is sent from then.
        -- A restore (the Undo of Cancel swap) or an Undo (of Located → Accompanied) puts the earlier clock back:
        -- not a new start.
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
$function$
;
revoke all on function public.lp_stats() from public, anon, authenticated, service_role;
grant execute on function public.lp_stats() to service_role;

-- lp_stats(text)
CREATE OR REPLACE FUNCTION public.lp_stats(p_range text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '4s'
 SET lock_timeout TO '2s'
AS $function$
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
            -- (Post-event) Accompanied → Located (a swap approved, or Change answer): Needs attention times it from then.
            -- A restore (the Undo of Cancel swap) or an Undo (of Located → Accompanied) keeps the earlier start.
            or (e.action_type = 'status_changed'
                and e.previous_value ->> 'status' = 'Found – Accompanied'
                and e.new_value ->> 'status' in ('Found – Awaiting Reunion', 'Bring friend to medical')
                and coalesce(e.new_value ->> 'restore', '') <> 'true'
                and coalesce(e.new_value ->> 'kind', '') <> 'undo')
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
$function$
;
revoke all on function public.lp_stats(text) from public, anon, authenticated, service_role;
grant execute on function public.lp_stats(text) to service_role;

-- lp_swap(uuid,bigint,text,text,text)
CREATE OR REPLACE FUNCTION public.lp_swap(p_id uuid, p_expected_version bigint, p_action text, p_place text, p_staff text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '4s'
 SET lock_timeout TO '2s'
AS $function$
declare
  v_row public.patients;
  v_prev jsonb;
  v_requester text;
  v_answerer text;
  v_from text;
  v_undid text;
  v_last_type text;
  v_last_staff text;
  v_last_prev jsonb;
  v_last_new jsonb;
begin
  perform public.lp_require_staff(p_staff);

  if p_id is null then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;
  if p_expected_version is null then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:expected_version';
  end if;
  if p_action is null or p_action not in ('request', 'approve', 'decline', 'withdraw', 'cancel', 'restore') then
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

  if p_action = 'restore' then
    -- The latest status or swap step on the request: the one an Undo takes back.
    select e.action_type, e.staff_name, e.previous_value, e.new_value
      into v_last_type, v_last_staff, v_last_prev, v_last_new
      from public.audit_events e
     where e.patient_id = p_id
       and e.action_type in ('status_changed', 'check_completed', 'swap_requested', 'swap_declined', 'swap_withdrawn',
                             'swap_cancelled', 'swap_request_restored')
     order by e.occurred_at desc, e.id desc
     limit 1;
    -- Idempotent repeat: this person's restore is already the latest step.
    if v_last_new ->> 'restore' = 'true'
       and public.lp_canon_staff(v_last_staff) is not distinct from public.lp_canon_staff(p_staff) then
      return pg_catalog.jsonb_build_object('changed', false, 'row', public.lp_row(v_row));
    end if;
  end if;

  if (p_action = 'request' and v_row.status = 'Found – Accompanied' and v_row.swap_requested_at is not null)
     or (p_action in ('decline', 'withdraw') and v_row.status = 'Found – Accompanied' and v_row.swap_requested_at is null)
     or (p_action = 'approve' and v_row.status = 'Found – Awaiting Reunion' and v_row.swap_place = p_place)
     or (p_action = 'cancel' and v_row.status = 'Found – Accompanied' and v_row.swap_requested_at is null) then
    return pg_catalog.jsonb_build_object('changed', false, 'row', public.lp_row(v_row));
  end if;

  if v_row.row_version <> p_expected_version then
    raise exception using errcode = 'P0409', message = 'version_conflict', hint = v_row.status;
  end if;
  if p_action = 'cancel' then
    -- (Companion follow-up) Cancel: an open swap request (Accompanied + swap_requested_*), or an approved swap
    -- (In medical + swap_place, not yet Reunited).
    if v_row.status = 'Found – Accompanied' and v_row.swap_requested_at is not null then
      v_from := 'requested';
    elsif v_row.status in ('Found – Awaiting Reunion', 'Bring friend to medical') and v_row.swap_place is not null then
      v_from := 'approved';
    else
      raise exception using errcode = 'P0422', message = 'illegal_transition', hint = v_row.status;
    end if;
  elsif p_action = 'restore' then
    -- Only the person who took the step, and only while the request is still where that step left it.
    if v_last_type is not null
       and public.lp_canon_staff(v_last_staff) is not distinct from public.lp_canon_staff(p_staff) then
      if v_last_type in ('swap_cancelled', 'swap_declined')
         and v_row.status = 'Found – Accompanied' and v_row.swap_requested_at is null and v_row.swap_place is null then
        if v_last_type = 'swap_cancelled' and v_last_new ->> 'from' = 'approved'
           and v_last_prev ->> 'swap_place' in ('fa', 'mm') then
          v_undid := 'swap_cancelled';
          v_from := 'approved';
        elsif v_last_prev ->> 'swap_requested_at' is not null then
          v_undid := v_last_type;
          v_from := 'requested';
        end if;
      elsif v_last_type = 'status_changed' and v_last_new ->> 'kind' = 'swap'
            and v_last_prev ->> 'status' = 'Found – Accompanied'
            and v_last_prev ->> 'swap_requested_at' is not null
            and v_row.status = v_last_new ->> 'status'
            and v_row.swap_place is not distinct from v_last_new ->> 'swap_place' then
        v_undid := 'swap_approved';
        v_from := 'requested';
      end if;
    end if;
    -- No hint on the two refusals below: PostgREST cannot render a non-ASCII one (the status has an en dash).
    if v_undid is null then
      raise exception using errcode = 'P0422', message = 'illegal_transition';
    end if;
  elsif v_row.status <> 'Found – Accompanied' then
    raise exception using errcode = 'P0422', message = 'illegal_transition', hint = v_row.status;
  elsif p_action = 'approve' and v_row.swap_requested_at is null then
    -- A swap is approved only while someone is asking for it (declined, cancelled or withdrawn in between).
    -- One exception: an app from before this file undoes its own Cancel swap of an approved swap by approving it
    -- again at the same place (the latest step on the request is that cancel, by the same person).
    select e.action_type, e.staff_name, e.previous_value, e.new_value
      into v_last_type, v_last_staff, v_last_prev, v_last_new
      from public.audit_events e
     where e.patient_id = p_id
       and e.action_type in ('status_changed', 'check_completed', 'swap_requested', 'swap_declined', 'swap_withdrawn',
                             'swap_cancelled', 'swap_request_restored')
     order by e.occurred_at desc, e.id desc
     limit 1;
    if not (v_last_type is not distinct from 'swap_cancelled'
            and v_last_new ->> 'from' = 'approved'
            and v_last_prev ->> 'swap_place' = p_place
            and public.lp_canon_staff(v_last_staff) is not distinct from public.lp_canon_staff(p_staff)) then
      raise exception using errcode = 'P0422', message = 'illegal_transition';
    end if;
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

  if p_action = 'cancel' then
    update public.patients
       set status = 'Found – Accompanied',
           swap_requested_at = null,
           swap_requested_by = null,
           swap_place = null,
           swap_closed = case when v_from = 'requested' then 'cancelled' else null end,
           reunion_started_at = case when v_from = 'approved' then null else reunion_started_at end,
           updated_by = p_staff
     where id = p_id
    returning * into v_row;
    insert into public.audit_events (patient_id, staff_name, action_type, previous_value, new_value)
    values (p_id, p_staff, 'swap_cancelled', v_prev,
            pg_catalog.jsonb_build_object('status', v_row.status, 'from', v_from));
  elsif p_action = 'request' then
    update public.patients
       set swap_requested_at = now(), swap_requested_by = p_staff, swap_closed = null, updated_by = p_staff
     where id = p_id
    returning * into v_row;
    insert into public.audit_events (patient_id, staff_name, action_type, previous_value, new_value)
    values (p_id, p_staff, 'swap_requested', v_prev, pg_catalog.jsonb_build_object('status', v_row.status));
  elsif p_action = 'approve' then
    update public.patients
       set status = 'Found – Awaiting Reunion',
           swap_place = p_place,
           swap_requested_at = null,
           swap_requested_by = null,
           swap_closed = null,
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
  elsif p_action = 'restore' and v_undid = 'swap_cancelled' and v_from = 'approved' then
    -- The approved swap back at the same place, its friend clock as it was.
    update public.patients
       set status = 'Found – Awaiting Reunion',
           swap_place = v_last_prev ->> 'swap_place',
           swap_requested_at = null,
           swap_requested_by = null,
           swap_closed = null,
           found_at = coalesce(found_at, now()),
           reunion_started_at = coalesce((v_last_prev ->> 'reunion_started_at')::timestamptz, now()),
           closed_at = null,
           recheck_at = null,
           updated_by = p_staff
     where id = p_id
    returning * into v_row;
    insert into public.audit_events (patient_id, staff_name, action_type, previous_value, new_value)
    values (p_id, p_staff, 'status_changed', v_prev,
            pg_catalog.jsonb_build_object('status', v_row.status, 'kind', 'swap', 'swap_place', v_row.swap_place, 'restore', true)
            || pg_catalog.jsonb_build_object('recheck_at', null, 'not_found_checks', v_row.not_found_checks));
  elsif p_action = 'restore' and v_undid = 'swap_approved' then
    -- Accompanied again, with the request the approval answered (its requester and time).
    update public.patients
       set status = 'Found – Accompanied',
           swap_place = null,
           swap_requested_at = (v_last_prev ->> 'swap_requested_at')::timestamptz,
           swap_requested_by = v_last_prev ->> 'swap_requested_by',
           swap_closed = null,
           reunion_started_at = null,
           closed_at = null,
           updated_by = p_staff
     where id = p_id
    returning * into v_row;
    insert into public.audit_events (patient_id, staff_name, action_type, previous_value, new_value)
    values (p_id, p_staff, 'status_changed', v_prev,
            pg_catalog.jsonb_build_object('status', v_row.status, 'kind', 'undo', 'restore', true)
            || pg_catalog.jsonb_build_object('recheck_at', v_row.recheck_at, 'not_found_checks', v_row.not_found_checks));
  elsif p_action = 'restore' then
    -- The request a decline or a cancel cleared, as it was.
    update public.patients
       set swap_requested_at = (v_last_prev ->> 'swap_requested_at')::timestamptz,
           swap_requested_by = v_last_prev ->> 'swap_requested_by',
           swap_closed = null,
           updated_by = p_staff
     where id = p_id
    returning * into v_row;
    insert into public.audit_events (patient_id, staff_name, action_type, previous_value, new_value)
    values (p_id, p_staff, 'swap_request_restored', v_prev,
            pg_catalog.jsonb_build_object('status', v_row.status, 'restore', true, 'undid', v_undid));
  else
    update public.patients
       set swap_requested_at = null,
           swap_requested_by = null,
           swap_closed = case when p_action = 'decline' then 'declined' else 'withdrawn' end,
           updated_by = p_staff
     where id = p_id
    returning * into v_row;
    insert into public.audit_events (patient_id, staff_name, action_type, previous_value, new_value)
    values (p_id, p_staff, case when p_action = 'decline' then 'swap_declined' else 'swap_withdrawn' end, v_prev,
            pg_catalog.jsonb_build_object('status', v_row.status));
  end if;

  -- The staff who answered: the latest change into Accompanied / Located, not counting Undo or Reopen (those
  -- only put back an earlier answer; the person tapping them did not answer).
  if p_action in ('request', 'withdraw') or (p_action in ('cancel', 'restore') and v_from = 'requested') then
    select e.staff_name into v_answerer
      from public.audit_events e
     where e.patient_id = p_id
       and e.action_type in ('status_changed', 'check_completed')
       and e.new_value ->> 'status' in ('Found – Accompanied', 'Found – Awaiting Reunion', 'Bring friend to medical')
       and coalesce(e.new_value ->> 'kind', '') not in ('undo', 'reopen')
     order by e.occurred_at desc, e.id desc
     limit 1;
  end if;
  if p_action = 'restore' then
    v_requester := v_row.swap_requested_by;
  end if;

  return pg_catalog.jsonb_build_object('changed', true, 'row', public.lp_row(v_row),
    'answerer', v_answerer, 'requester', v_requester, 'creator', v_row.created_by, 'from', v_from, 'undid', v_undid);
end
$function$
;
revoke all on function public.lp_swap(uuid,bigint,text,text,text) from public, anon, authenticated, service_role;
grant execute on function public.lp_swap(uuid,bigint,text,text,text) to service_role;

-- lp_sync(timestamp with time zone,uuid[],boolean,timestamp with time zone,uuid,integer)
CREATE OR REPLACE FUNCTION public.lp_sync(p_since timestamp with time zone, p_ids uuid[] DEFAULT NULL::uuid[], p_reconcile boolean DEFAULT false, p_after_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_after_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 500)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '4s'
 SET lock_timeout TO '2s'
AS $function$
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
$function$
;
revoke all on function public.lp_sync(timestamp with time zone,uuid[],boolean,timestamp with time zone,uuid,integer) from public, anon, authenticated, service_role;
grant execute on function public.lp_sync(timestamp with time zone,uuid[],boolean,timestamp with time zone,uuid,integer) to service_role;

-- lp_tel_config()
CREATE OR REPLACE FUNCTION public.lp_tel_config()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '4s'
 SET lock_timeout TO '2s'
AS $function$
declare
  v_set public.lp_tel_settings;
begin
  select * into v_set from public.lp_tel_settings where id;
  if not found then
    return pg_catalog.jsonb_build_object('on', false, 'enabled', false);
  end if;
  return pg_catalog.jsonb_build_object(
    'on', v_set.enabled and pg_catalog.clock_timestamp() < v_set.off_at,
    'enabled', v_set.enabled,
    'until', pg_catalog.floor(extract(epoch from v_set.off_at) * 1000)::bigint,
    'cap', v_set.device_hour_cap,
    'capBytes', v_set.device_hour_bytes,
    'flushSeconds', v_set.flush_seconds,
    'sample', v_set.sample);
end
$function$
;
revoke all on function public.lp_tel_config() from public, anon, authenticated, service_role;
grant execute on function public.lp_tel_config() to service_role;

-- lp_tel_health(text,timestamp with time zone,integer)
CREATE OR REPLACE FUNCTION public.lp_tel_health(p_section text, p_since timestamp with time zone, p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '6s'
 SET lock_timeout TO '2s'
AS $function$
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
        from public.lp_tel_events e
       where e.at >= v_since
    ), prev as (
      select pg_catalog.count(distinct e.device) filter (where e.device <> 'server') as devices,
             pg_catalog.count(*) filter (where e.name = any (v_frus)) as frustrations,
             pg_catalog.count(distinct e.device) filter (where e.name = any (v_frus)) as hit_devices,
             pg_catalog.count(*) filter (where e.name = 'error') as errors
        from public.lp_tel_events e
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
        from public.lp_tel_events e
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
                from public.lp_tel_events e
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
          from public.lp_tel_events e
         where e.at >= v_since and e.name like 'flow\_%' and e.ms is not null
         group by 1, 2
      ) f;

  elsif p_section = 'net' then
    with r as (
      select e.area as pattern, e.props ->> 'm' as m, e.props ->> 'st' as st,
             case when e.props ->> 'on' = 'false' then 'link_down' else coalesce(e.props ->> 'conn', 'unk') end as state,
             coalesce(e.n, 0) as n
        from public.lp_tel_events e
       where e.at >= v_since and e.name = 'net'
    ), durs as (
      select e.area as pattern, e.props ->> 'm' as m, d.v::numeric as ms
        from public.lp_tel_events e
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
        from public.lp_tel_events e
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
        from public.lp_tel_events e
       where e.at >= v_since and e.name = 'push_send'
       group by 1
    ), rx as (
      select e.props ->> 'kind' as kind, pg_catalog.count(*) as rx,
             pg_catalog.count(*) filter (where e.props ->> 'shown' = 'true') as shown,
             pg_catalog.percentile_cont(0.5) within group (order by e.ms) as t50,
             pg_catalog.percentile_cont(0.95) within group (order by e.ms) as t95
        from public.lp_tel_events e
       where e.at >= v_since and e.name = 'push_rx'
       group by 1
    ), opened as (
      select e.props ->> 'kind' as kind, pg_catalog.count(*) as opened
        from public.lp_tel_events e
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
        from public.lp_tel_events e
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
        from public.lp_push_subscriptions s group by 1
    ), alerts as (
      select e.team, pg_catalog.count(*) as n,
             pg_catalog.count(*) filter (where e.ms <= 30000 and e.props ->> 'route' in ('toast', 'push')) as within30,
             pg_catalog.percentile_cont(0.5) within group (order by e.ms) as p50
        from public.lp_tel_events e
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
          from public.lp_tel_events e
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
$function$
;
revoke all on function public.lp_tel_health(text,timestamp with time zone,integer) from public, anon, authenticated, service_role;
grant execute on function public.lp_tel_health(text,timestamp with time zone,integer) to service_role;

-- lp_tel_ingest(text,text,text,text,bigint,jsonb,jsonb,integer,text)
CREATE OR REPLACE FUNCTION public.lp_tel_ingest(p_batch text, p_device text, p_session text, p_team text, p_skew_ms bigint, p_ctx jsonb, p_events jsonb, p_bytes integer, p_quota text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '4s'
 SET lock_timeout TO '2s'
AS $function$
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
  if not found or not v_set.enabled or v_now >= v_set.off_at then
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
    insert into public.lp_tel_events (at, device, session, team, name, view, area, ctl, ms, n, ok, props, trail)
    select least(v_now, greatest(v_now - interval '2 days',
                 pg_catalog.to_timestamp(((x.e ->> 'at')::bigint + coalesce(p_skew_ms, 0)) / 1000.0))),
           p_device, p_session, p_team, x.e ->> 'n', x.e ->> 'v', x.e ->> 'a', x.e ->> 'c',
           (x.e ->> 'ms')::integer, (x.e ->> 'k')::integer, (x.e ->> 'ok')::boolean, x.e -> 'p', x.e -> 'tr'
      from pg_catalog.jsonb_array_elements(p_events) with ordinality as x(e, i)
     where x.i <= v_allowed;
    get diagnostics v_inserted = row_count;
  end if;

  insert into public.lp_tel_devices as d (device, team, plat, osv, eng, sa, lay, dpr, touch, build, eff, mem, last_session)
  values (p_device, p_team, p_ctx ->> 'plat', (p_ctx ->> 'osv')::integer, p_ctx ->> 'eng', (p_ctx ->> 'sa')::boolean,
          p_ctx ->> 'lay', (p_ctx ->> 'dpr')::integer, (p_ctx ->> 'touch')::boolean, p_ctx ->> 'build', p_ctx ->> 'eff',
          (p_ctx ->> 'mem')::integer, p_session)
  on conflict (device) do update set team = excluded.team, plat = excluded.plat, osv = excluded.osv, eng = excluded.eng,
     sa = excluded.sa, lay = excluded.lay, dpr = excluded.dpr, touch = excluded.touch, build = excluded.build,
     eff = excluded.eff, mem = excluded.mem, last_seen = v_now, last_session = excluded.last_session;

  return pg_catalog.jsonb_build_object('on', true, 'accepted', v_inserted, 'dropped', v_count - v_inserted,
                                       'capped', v_inserted < v_count);
end
$function$
;
revoke all on function public.lp_tel_ingest(text,text,text,text,bigint,jsonb,jsonb,integer,text) from public, anon, authenticated, service_role;
grant execute on function public.lp_tel_ingest(text,text,text,text,bigint,jsonb,jsonb,integer,text) to service_role;

-- lp_tel_server_events(jsonb)
CREATE OR REPLACE FUNCTION public.lp_tel_server_events(p_rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '4s'
 SET lock_timeout TO '2s'
AS $function$
declare
  v_set public.lp_tel_settings;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_count integer := 0;
begin
  select * into v_set from public.lp_tel_settings where id;
  if not found or not v_set.enabled or v_now >= v_set.off_at then
    return 0;
  end if;
  if p_rows is null or pg_catalog.jsonb_typeof(p_rows) <> 'array' or pg_catalog.jsonb_array_length(p_rows) = 0 then
    return 0;
  end if;
  if pg_catalog.jsonb_array_length(p_rows) > 20 then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:rows';
  end if;
  insert into public.lp_tel_events (at, device, session, team, name, ms, n, ok, props)
  select v_now, 'server', 'server', x.e ->> 'team', x.e ->> 'n', (x.e ->> 'ms')::integer, (x.e ->> 'k')::integer,
         (x.e ->> 'ok')::boolean, x.e -> 'p'
    from pg_catalog.jsonb_array_elements(p_rows) as x(e)
   where x.e ->> 'n' in ('push_send', 'tel_switch');
  get diagnostics v_count = row_count;
  return v_count;
end
$function$
;
revoke all on function public.lp_tel_server_events(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.lp_tel_server_events(jsonb) to service_role;

-- lp_unsend_message(uuid,uuid,text)
CREATE OR REPLACE FUNCTION public.lp_unsend_message(p_request uuid, p_message uuid, p_staff text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '4s'
 SET lock_timeout TO '2s'
AS $function$
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
$function$
;
revoke all on function public.lp_unsend_message(uuid,uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.lp_unsend_message(uuid,uuid,text) to service_role;

-- lp_update_fields(uuid,jsonb,bigint,text)
CREATE OR REPLACE FUNCTION public.lp_update_fields(p_id uuid, p_patch jsonb, p_expected_version bigint, p_staff text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '4s'
 SET lock_timeout TO '2s'
AS $function$
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
$function$
;
revoke all on function public.lp_update_fields(uuid,jsonb,bigint,text) from public, anon, authenticated, service_role;
grant execute on function public.lp_update_fields(uuid,jsonb,bigint,text) to service_role;

notify pgrst, 'reload schema';

commit;
