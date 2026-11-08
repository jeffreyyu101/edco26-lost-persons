-- =====================================================================================================
-- 20261108000000_dashboard_v4.sql — Dashboard v4 (design/screens/dashboard-v4.html): lp_stats(p_range)
--
-- PRODUCTION: paste THIS FILE ALONE into the SQL Editor (default postgres role). It needs only what
-- 20261106000000_rework.sql already put there (lp_stats(), lp_canon_staff(), lp_enroute, lp_messages); it never
-- re-runs the rework file. Order: this migration first, then deploy (the new build falls back to lp_stats()
-- while lp_stats(text) is missing, and the deployed build never calls lp_stats(text)).
--   1. Dry run: paste the whole file, change the LAST line `commit;` to `rollback;`, run it. No error = good.
--   2. Real run: paste the file again unchanged (ending in `commit;`) and run it.
--   3. Check: select jsonb_typeof(public.lp_stats('tonight') -> 'calls');   -- object
--   Safe to run twice (create or replace); one transaction, so a failure part-way changes nothing.
--
-- What it does (additive only: no table, column, index or existing function is touched):
--   lp_stats(p_range text), a NEW overload beside lp_stats() (which stays exactly as it is, so the deployed
--   dashboard keeps working). PostgREST picks it by its named argument: rpc('lp_stats', {p_range}).
--   p_range: '1h' | '2h' | '6h' (rolling, starting on a 15-minute boundary), 'tonight' (since the latest 12:00 ET:
--   after midnight that is still yesterday noon, so a night that runs to 02:00 stays one night), 'event' (all).
--   It returns every lp_stats() field (recent[].name is null: aggregates and case numbers only) plus:
--     range     {key, from, step (minutes per calls bucket), compare (the previous night is shown)}
--     live      {waiting (no first check), pending (on a re-check hold), located (friend not here yet)}
--     attention {total, items[5]}: most urgent first. Urgency = minutes past the point a row turns red
--               (waiting and located: 30 min after logged / located; a due re-check: 10 min after recheck_at).
--               Item: id, caseNumber, tent, kind (wait | recheck | located), since, enroute, etaAt.
--     speed     [firstCheck, located, reunited]: minutes from logged, over steps reached in the range:
--               n, median, p90, prevMedian, byTent {FA 4, FA 3, Other}, spark [{at, night, median, p90, n}].
--     calls     {total, prevTotal, buckets [{at, night, fa4, fa3, other, prev}]}: requests logged per 15 min
--               (per hour and night for 'event'); prev = the same clock bucket the night before.
--     heat      {step, cols [{at | hour, fa4, fa3, other}]}: hour × tent (15 min for 1h / 2h; for 'event' the
--               clock hours in ET summed over every night).
--     recap     {reunited, notLocated, fastest, prev…, lastReunionAt}
--     team      [{team, on}]: people with activity in the last 10 minutes (audit trail, messages, telemetry),
--               per team. Counts only.
--   Never a name, description, last_seen, photo or medical_location. STABLE: one snapshot for every number.
-- =====================================================================================================

begin;

do $pre$
begin
  if pg_catalog.to_regprocedure('public.lp_stats()') is null
     or pg_catalog.to_regprocedure('public.lp_canon_staff(text)') is null then
    raise exception 'Preflight failed: public.lp_stats() / lp_canon_staff(text) are missing (20261106000000_rework.sql first).';
  end if;
  if pg_catalog.to_regclass('public.lp_enroute') is null or pg_catalog.to_regclass('public.lp_messages') is null then
    raise exception 'Preflight failed: public.lp_enroute / lp_messages are missing (rework section 7 first).';
  end if;
end
$pre$;

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
    select pt.id, pt.case_number, pt.created_at, pt.status, pt.recheck_at,
           case pt.reporting_location when 'FA 4 – Oasis' then 'FA 4' when 'FA 3 – Kinetic' then 'FA 3' else 'Other' end as tent,
           case pt.reporting_location when 'FA 4 – Oasis' then 'FA 4' when 'FA 3 – Kinetic' then 'FA 3'
                when 'Command' then 'Command' when 'Base' then 'Base' else 'Other' end as short
    from public.patients pt
  ), ev as (
    -- The lifecycle steps, read from the audit trail exactly as lp_stats() reads them.
    select e.patient_id, e.occurred_at,
           ((e.action_type in ('status_changed', 'check_completed')
             and e.previous_value ->> 'status' = 'Added'
             and e.new_value ->> 'status' in ('Checked – Not Found', 'Found – Awaiting Reunion', 'Bring friend to medical'))
            or (e.action_type = 'medical_search' and e.new_value ->> 'outcome' = 'not_found')
            or e.action_type = 'medical_search_found'
            or (e.action_type = 'status_changed' and e.new_value ->> 'held' = 'true')) as is_answer,
           ((e.action_type = 'status_changed'
             and e.previous_value ->> 'status' in ('Added', 'Checked – Not Found')
             and e.new_value ->> 'status' in ('Found – Awaiting Reunion', 'Bring friend to medical'))
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
               'located', pg_catalog.count(*) filter (where status in ('Found – Awaiting Reunion', 'Bring friend to medical')))
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

revoke all on function public.lp_stats(text) from public, anon, authenticated;
grant execute on function public.lp_stats(text) to service_role;

notify pgrst, 'reload schema';

commit;
