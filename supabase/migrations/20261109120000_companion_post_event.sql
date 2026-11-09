-- =====================================================================================================
-- 20261109120000_companion_post_event.sql — Companion fixes after the EDCO26 Saturday release
--
--   patients.swap_closed (new, nullable): how the latest swap request ended while the request stayed
--     Accompanied ('declined' | 'withdrawn' | 'cancelled'), so the app can say "Swap declined" only for a decline.
--   lp_row: + swap_closed.
--   lp_swap: 'approve' needs an open request; new 'restore' (the Undo of Cancel swap / Decline / Swap at …, keeping
--     the original requester); 'withdraw' resolves the answerer; the answerer skips Undo / Reopen status changes.
--   lp_set_status: Reopen of a request closed (inactive or discharged) while Accompanied goes back to Accompanied
--     ('Closed – Inactive' → 'Found – Accompanied' allowed); Friend informed while a swap request is open → P0409;
--     an Undo back to Accompanied brings back the swap request the undone change ended.
--   lp_stats() / lp_stats(text): Accompanied → Located (a swap approved, or Change answer) restarts the friend's
--     clock (Needs attention "located" since, Time to reunite).
--
-- PRODUCTION: paste THIS FILE ALONE into the SQL Editor after 20261108190000_companion_cancel.sql. Additive only:
-- one nullable column with a CHECK (added only when missing), and create or replace of five functions with the
-- same signatures. Safe to run twice and on a live database: no row is rewritten, nothing is dropped.
-- =====================================================================================================

begin;

do $pre$
begin
  if pg_catalog.to_regprocedure('public.lp_swap(uuid,bigint,text,text,text)') is null
     or pg_catalog.to_regprocedure('public.lp_set_status(uuid,bigint,text,text,text)') is null
     or pg_catalog.to_regprocedure('public.lp_stats(text)') is null then
    raise exception 'Preflight failed: lp_swap / lp_set_status / lp_stats(text) are missing (companion migrations first).';
  end if;
end
$pre$;

alter table public.patients add column if not exists swap_closed text;
-- The CHECK only when it is not there yet (a second run changes nothing and drops nothing).
do $chk$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
     where conrelid = 'public.patients'::regclass and conname = 'patients_swap_closed_check'
  ) then
    alter table public.patients add constraint patients_swap_closed_check
      check (swap_closed is null or swap_closed in ('declined', 'withdrawn', 'cancelled'));
  end if;
end
$chk$;

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
  ) || pg_catalog.jsonb_build_object(
    -- (Post-event) How the latest open swap request ended while the request stayed Accompanied.
    'swap_closed', p.swap_closed
  );
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
  if p_kind = 'reopen' and p_status = 'Found – Awaiting Reunion' and v_row.status in ('Closed – Inactive', 'Found – Discharged') then
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
$fn$;

-- lp_swap (post-event): the friend swap, as 20261108190000_companion_cancel.sql, plus
--   'approve' needs an open request (a stale tap after a decline / cancel / withdraw is refused, not applied),
--     except an older app's Undo of its own Cancel swap (approve again at the same place);
--   'withdraw' resolves the answerer (the app server tells them the request was cancelled);
--   'restore' (new) is the Undo of the caller's own latest swap step, putting back exactly what it replaced:
--     after Cancel swap request or Decline → the request again, its original requester and time;
--     after Cancel swap (approved)         → the approved swap at the same place;
--     after Swap at … (approve)            → Accompanied with the request open again.
--   Audit: swap_request_restored, or status_changed (new_value.restore = true) when the status moves.
--   swap_closed: 'declined' | 'withdrawn' | 'cancelled' when a request is cleared and the status stays Accompanied.
--   The answerer (whom request / cancel / withdraw / restore tell) skips Undo and Reopen status changes.
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
$fn$;

revoke all on function public.lp_swap(uuid, bigint, text, text, text) from public, anon, authenticated;
grant execute on function public.lp_swap(uuid, bigint, text, text, text) to service_role;

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
        -- (Post-event) Accompanied → Located (a swap approved, or Change answer): the friend is sent from then.
        -- A restore (the Undo of Cancel swap) puts the earlier clock back: not a new start.
        or (e.action_type = 'status_changed'
            and e.previous_value ->> 'status' = 'Found – Accompanied'
            and e.new_value ->> 'status' in ('Found – Awaiting Reunion', 'Bring friend to medical')
            and coalesce(e.new_value ->> 'restore', '') <> 'true')
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
            -- (Post-event) Accompanied → Located (a swap approved, or Change answer): Needs attention times it from then.
            -- A restore (the Undo of Cancel swap) keeps the earlier start.
            or (e.action_type = 'status_changed'
                and e.previous_value ->> 'status' = 'Found – Accompanied'
                and e.new_value ->> 'status' in ('Found – Awaiting Reunion', 'Bring friend to medical')
                and coalesce(e.new_value ->> 'restore', '') <> 'true')
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


notify pgrst, 'reload schema';

commit;
