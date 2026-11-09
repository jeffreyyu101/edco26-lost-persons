-- =====================================================================================================
-- 20261108190000_companion_cancel.sql — Companion follow-up: cancel a swap
--
-- lp_swap gains p_action 'cancel' (same signature):
--   swap requested (Accompanied + swap_requested_*) → the request cleared, stays Accompanied.
--   swap approved (In medical + swap_place, not yet Reunited) → back to 'Found – Accompanied', swap_place cleared.
--   Audit swap_cancelled (new_value.from 'requested' | 'approved'); returns 'from' so the app server knows whom to
--   tell. lp_activity_record accepts kind 'swap_cancelled' (every earlier kind kept).
--
-- PRODUCTION: paste THIS FILE ALONE into the SQL Editor after 20261108120000_companion.sql. Additive only:
-- create or replace of two functions, same signatures. Safe to run twice.
-- =====================================================================================================

begin;

do $pre$
begin
  if pg_catalog.to_regprocedure('public.lp_swap(uuid,bigint,text,text,text)') is null
     or pg_catalog.to_regprocedure('public.lp_activity_record(text[],uuid,text,text,text)') is null then
    raise exception 'Preflight failed: lp_swap / lp_activity_record are missing (20261108120000_companion.sql first).';
  end if;
end
$pre$;

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
$fn$;

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
  v_from text;
begin
  perform public.lp_require_staff(p_staff);

  if p_id is null then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;
  if p_expected_version is null then
    raise exception using errcode = 'P0422', message = 'invalid_field', detail = 'field:expected_version';
  end if;
  if p_action is null or p_action not in ('request', 'approve', 'decline', 'withdraw', 'cancel') then
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
  elsif v_row.status <> 'Found – Accompanied' then
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

  if p_action = 'cancel' then
    update public.patients
       set status = 'Found – Accompanied',
           swap_requested_at = null,
           swap_requested_by = null,
           swap_place = null,
           reunion_started_at = case when v_from = 'approved' then null else reunion_started_at end,
           updated_by = p_staff
     where id = p_id
    returning * into v_row;
    insert into public.audit_events (patient_id, staff_name, action_type, previous_value, new_value)
    values (p_id, p_staff, 'swap_cancelled', v_prev,
            pg_catalog.jsonb_build_object('status', v_row.status, 'from', v_from));
    if v_from = 'requested' then
      select e.staff_name into v_answerer
        from public.audit_events e
       where e.patient_id = p_id
         and e.action_type in ('status_changed', 'check_completed')
         and e.new_value ->> 'status' in ('Found – Accompanied', 'Found – Awaiting Reunion', 'Bring friend to medical')
       order by e.occurred_at desc, e.id desc
       limit 1;
    end if;
  elsif p_action = 'request' then
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
    'answerer', v_answerer, 'requester', v_requester, 'creator', v_row.created_by, 'from', v_from);
end
$fn$;

revoke all on function public.lp_swap(uuid, bigint, text, text, text) from public, anon, authenticated;
grant execute on function public.lp_swap(uuid, bigint, text, text, text) to service_role;

notify pgrst, 'reload schema';

commit;
