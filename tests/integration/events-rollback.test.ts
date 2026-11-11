// The way back (docs/RELEASE-events.md "Roll back"): supabase/rollback/20261110000000_events_down.sql, proven on a
// scratch database built like production before the events migration (the chain up to the post-event file and the
// synthetic seed as it was at 0a416a9):
//   up (the events file) → down (twice) → the build at 0a416a9's RPC contract works: create, update, status, sync,
//   stats, as service_role with the old signatures → up again, cleanly, and the old build's new row lands in edco26.
// The down refuses (and changes nothing) while an event is live or another event has requests. LOCAL ONLY.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ROOT } from '../../scripts/test-env.mjs';
import { dbUrl, psql } from './harness';

const DB = `lp_rollback_${process.pid}_${randomBytes(3).toString('hex')}`;
const UP = join(ROOT, 'supabase', 'migrations', '20261110000000_events.sql');
const DOWN = join(ROOT, 'supabase', 'rollback', '20261110000000_events_down.sql');
const PRE_EVENTS_COMMIT = '0a416a9';

function url(): string {
  const u = new URL(dbUrl());
  u.pathname = `/${DB}`;
  return u.toString();
}
function sql(command: string): string {
  return execFileSync('psql', [url(), '-v', 'ON_ERROR_STOP=1', '-q', '-At', '-c', command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function file(path: string, pre: string[] = []): void {
  execFileSync('psql', [url(), '-v', 'ON_ERROR_STOP=1', '-q', ...pre.flatMap((c) => ['-c', c]), '-f', path], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PGOPTIONS: '-c client_min_messages=warning' },
  });
}
/** The psql error text of a file that must fail. */
function fails(path: string): string {
  try {
    file(path);
  } catch (error) {
    return String((error as { stderr?: string }).stderr ?? error);
  }
  throw new Error(`${path} did not fail`);
}
/** One function's signature list and grants, to compare states. */
function functions(): string {
  // Ordered by the line itself: `order by 1` inside an aggregate is a constant (catalog order), which a re-run's
  // `create or replace` reshuffles without changing anything.
  return sql(`select string_agg(f, E'\\n' order by f) from (
                select p.oid::regprocedure::text || ':' || md5(pg_get_functiondef(p.oid)) || ':' || coalesce(array_to_string(p.proacl, ','), '') as f
                  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.proname like 'lp\\_%') s`);
}

describe('supabase/rollback/20261110000000_events_down.sql', () => {
  let created = false;
  let preFunctions = '';

  afterAll(() => {
    if (created) psql(`drop database if exists ${DB} with (force)`);
  });

  it('builds the pre-events database and applies the events migration', () => {
    psql(`create database ${DB}`);
    created = true;
    const dir = join(ROOT, 'supabase', 'migrations');
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql') && x < '20261110000000_events.sql').sort()) file(join(dir, f));
    const seed = join('/tmp', `${DB}-seed.sql`);
    execFileSync('sh', ['-c', `git show ${PRE_EVENTS_COMMIT}:supabase/seed.sql > ${seed}`], { cwd: ROOT });
    file(seed, ["set lp.allow_seed = 'on'"]);
    execFileSync('rm', ['-f', seed]);
    expect(sql('select count(*) from public.patients')).toBe('21');
    preFunctions = functions();
    file(UP);
    expect(sql(`select stage from public.events where slug = 'edco26'`)).toBe('archived');
  }, 120_000);

  it('refuses, changing nothing, while an event is live or another event has requests', () => {
    const before = functions();
    sql(`insert into public.events (slug, name, starts_on, ends_on, stage, posts, teams)
         values ('rb-live', 'Live one', current_date, current_date, 'live', '[{"id":"a","label":"Gate A","short":"A"}]', '[{"id":"m","label":"Medics","medical":true}]')`);
    expect(fails(DOWN)).toContain('an event is live');
    // Practice, with a request: the old build would show it as EDC's.
    sql(`update public.events set stage = 'practice' where slug = 'rb-live'`);
    sql(`set role service_role; select lp_create_request((select id from public.events where slug = 'rb-live'), '{"client_mutation_id":"00000000-0000-4000-8000-00000000aa01","reporting_location":"Gate A"}', 'X · Medics')`);
    expect(fails(DOWN)).toContain('requests of another event exist');
    expect(functions()).toBe(before);
    expect(sql(`select is_nullable from information_schema.columns where table_name = 'patients' and column_name = 'event_id'`)).toBe('NO');
    // Gone again (a practice event's rows may be deleted).
    sql(`delete from public.audit_events where event_id = (select id from public.events where slug = 'rb-live');
         delete from public.patients where event_id = (select id from public.events where slug = 'rb-live');
         delete from public.events where slug = 'rb-live'`);
  });

  it('down (twice) restores every function and grant the old build uses, exactly, and deletes nothing', () => {
    const rows = sql('select count(*) from public.patients');
    file(DOWN);
    file(DOWN);
    // The pre-events lp_* functions are back byte for byte (bodies and grants); only event-only functions remain extra.
    const now = new Map(functions().split('\n').map((l) => [l.split(':')[0], l] as const));
    for (const line of preFunctions.split('\n')) expect(now.get(line.split(':')[0]), line.split(':')[0]).toBe(line);
    const extra = [...now.keys()].filter((sig) => !preFunctions.includes(`${sig}:`));
    for (const sig of extra) expect(sig, 'only functions with names the old build never calls stay').not.toMatch(/^lp_(sync|stats|create_request|update_fields|set_status|cancel|swap|detail|messages_sync|activity_|push_|tel_|enroute_stats|inactive_claim)\b/);
    expect(sql('select count(*) from public.patients')).toBe(rows);
    expect(sql(`select count(*) from public.events`)).toBe('1');
    expect(sql(`select is_nullable from information_schema.columns where table_name = 'patients' and column_name = 'event_id'`)).toBe('YES');
    expect(sql(`select count(*) from pg_trigger where tgname in ('lp_patients_writable', 'lp_audit_events_writable', 'lp_messages_writable', 'lp_patient_photos_writable', 'lp_enroute_writable')`)).toBe('0');
    expect(sql(`select pg_get_constraintdef(oid) from pg_constraint where conname = 'patients_case_number_key'`)).toBe('UNIQUE (case_number)');
  });

  it('the build at 0a416a9\'s RPC contract works: create, update, status, sync, stats (service_role, old signatures)', () => {
    const max = Number(sql('select max(case_number) from public.patients'));
    const out = sql(`set role service_role;
      select (lp_create_request('{"client_mutation_id":"00000000-0000-4000-8000-00000000bb01","reporting_location":"Base","first_name":"TEST-S"}', 'X · Medical') -> 'row' ->> 'id');`);
    const id = out.split('\n').at(-1)!;
    expect(sql(`select case_number || '/' || coalesce(event_id::text, 'null') from public.patients where id = '${id}'`)).toBe(`${max + 1}/null`);
    // An old FA post is still the only kind of post the old build accepts.
    expect(() => sql(`set role service_role; select lp_create_request('{"client_mutation_id":"00000000-0000-4000-8000-00000000bb02","reporting_location":"Gate A"}', 'X · Medical')`)).toThrow(/invalid_field/);
    const v = sql(`select row_version from public.patients where id = '${id}'`);
    expect(sql(`set role service_role; select lp_update_fields('${id}', '{"hair":"Red"}', ${v}, 'X · Medical') ->> 'changed'`).split('\n').at(-1)).toBe('true');
    const v2 = sql(`select row_version from public.patients where id = '${id}'`);
    expect(sql(`set role service_role; select lp_set_status('${id}', ${v2}, 'Found – Awaiting Reunion', 'X · Medical', 'answer') -> 'row' ->> 'status'`).split('\n').at(-1)).toBe('Found – Awaiting Reunion');
    // EDC's own rows are writable again (the guard is gone).
    const edcRow = sql(`select id || '|' || row_version from public.patients where status = 'Added' and event_id is not null order by case_number limit 1`).split('|');
    expect(sql(`set role service_role; select lp_update_fields('${edcRow[0]}', '{"hair":"Brown"}', ${edcRow[1]}, 'X · Medical') ->> 'changed'`).split('\n').at(-1)).toBe('true');
    expect(sql(`set role service_role; select jsonb_array_length(lp_sync(null) -> 'rows')`).split('\n').at(-1)).toBe('22');
    expect(sql(`set role service_role; select lp_stats() ->> 'total'`).split('\n').at(-1)).toBe('22');
    expect(sql(`set role service_role; select (lp_stats('event') ->> 'total') is not null`).split('\n').at(-1)).toBe('t');
    expect(sql(`set role service_role; select jsonb_typeof(lp_messages_sync('X · Medical', array['${id}']::uuid[], null, false))`).split('\n').at(-1)).toBe('object');
  });

  it('up again: clean, the old build\'s row joins edco26, and everything is per event and frozen again', () => {
    file(UP);
    expect(sql(`select count(*) from public.patients where event_id is null`)).toBe('0');
    expect(sql(`select is_nullable from information_schema.columns where table_name = 'patients' and column_name = 'event_id'`)).toBe('NO');
    expect(sql(`select count(*) from pg_constraint where conname in ('patients_case_number_key', 'patients_reporting_location_check')`)).toBe('0');
    expect(sql(`select case_seq = (select max(case_number) from public.patients) from public.events where slug = 'edco26'`)).toBe('t');
    expect(sql(`select to_regprocedure('public.lp_sync(timestamptz, uuid[], boolean, timestamptz, uuid, integer)') is null`)).toBe('t');
    const edc = sql(`select id from public.events where slug = 'edco26'`);
    expect(sql(`set role service_role; select lp_stats('${edc}', 'event') ->> 'total'`).split('\n').at(-1)).toBe('22');
    expect(() => sql(`update public.patients set hair = 'x' where event_id = '${edc}'`)).toThrow(/event_ended/);
    // And a second paste changes nothing.
    const once = functions();
    file(UP);
    expect(functions()).toBe(once);
  });
});
