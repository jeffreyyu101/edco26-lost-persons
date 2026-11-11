// The EDC backfill (20261110000000_events.sql, spec "Data" → "Existing EDC rows"), proven on a scratch database that
// looks like production before the events migration: the whole chain up to the post-event file, the synthetic seed
// as it was before events (commit 0a416a9: 21 requests with audit history and photo rows), plus rows in every other
// table the migration touches (messages, read markers, en route, Activity, inactive closes, push, telemetry, an audit
// row with no request). Then:
//   * every existing row keeps every existing column exactly (updated_at and row_version included), compared as JSON;
//   * every request (and every row keyed by one, or by a device) belongs to the archived edco26 event; telemetry rows
//     are not rewritten; the counter continues after the highest case number; records_delete_at is NULL;
//   * pasted again, nothing changes at all;
//   * the event is frozen (the guard), still readable (stats), and its old numbers stay unique per event;
//   * (review) the global case-number rule goes whatever it is called (a renamed constraint and an extra unique index
//     here), a trigger someone disabled on purpose stays disabled, and EDC's ended_at is its real end.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ROOT } from '../../scripts/test-env.mjs';
import { dbUrl, psql } from './harness';

const DB = `lp_backfill_${process.pid}_${randomBytes(3).toString('hex')}`;
const EVENTS_FILE = '20261110000000_events.sql';
const PRE_EVENTS_COMMIT = '0a416a9';

function url(): string {
  const u = new URL(dbUrl());
  u.pathname = `/${DB}`;
  return u.toString();
}
function sql(command: string): string {
  return execFileSync('psql', [url(), '-v', 'ON_ERROR_STOP=1', '-q', '-At', '-c', command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();
}
function file(path: string, pre: string[] = []): void {
  execFileSync('psql', [url(), '-v', 'ON_ERROR_STOP=1', '-q', ...pre.flatMap((c) => ['-c', c]), '-f', path], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PGOPTIONS: '-c client_min_messages=warning' },
  });
}

/** Tables with the column that orders them, and whether the migration gives them an event_id. */
const TABLES: Array<[table: string, order: string]> = [
  ['patients', 'id'],
  ['audit_events', 'id'],
  ['patient_photos', 'id'],
  ['lp_messages', 'id'],
  ['lp_message_reads', 'request_id, staff'],
  ['lp_enroute', 'request_id, staff'],
  ['lp_activity', 'staff, request_id'],
  ['lp_inactive_closes', 'request_id, closed_at'],
  ['lp_push_prefs', 'staff'],
  ['lp_push_subscriptions', 'id'],
  ['lp_tel_devices', 'device'],
  ['lp_tel_events', 'id'],
  ['lp_login_attempts', 'id'],
];

/** Every row of every table as JSON, without the new event_id column (what existed before must be identical). */
function snapshot(): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const [table, order] of TABLES) {
    out[table] = JSON.parse(sql(`select coalesce(json_agg(to_jsonb(t) - 'event_id' order by ${order}), '[]') from public.${table} t`)) as unknown[];
  }
  out.sequences = JSON.parse(sql(`select json_build_object('case', (select last_value from public.patient_case_number_seq))`)) as unknown as unknown[];
  return out;
}

function everything(): string {
  // Including event_id and the events / lp_org rows: a second paste must not change a single value.
  return TABLES.map(([t, order]) => sql(`select coalesce(json_agg(to_jsonb(x) order by ${order}), '[]') from public.${t} x`))
    .concat(sql(`select json_agg(to_jsonb(e) order by slug) from public.events e`), sql(`select json_agg(to_jsonb(o)) from public.lp_org o`))
    .join('\n');
}

describe('20261110000000_events.sql on a database like production (the finished EDC event)', () => {
  let before: Record<string, unknown[]>;
  let created = false;

  afterAll(() => {
    if (created) psql(`drop database if exists ${DB} with (force)`);
  });

  it('builds the pre-events database: the chain, the old seed, and a row in every table the migration touches', () => {
    psql(`create database ${DB}`);
    created = true;
    const chain = readdirSync(join(ROOT, 'supabase', 'migrations')).filter((f) => f.endsWith('.sql') && f < EVENTS_FILE).sort();
    expect(chain.at(-1)).toBe('20261109120000_companion_post_event.sql');
    for (const f of chain) file(join(ROOT, 'supabase', 'migrations', f));
    const seed = join('/tmp', `${DB}-seed.sql`);
    execFileSync('sh', ['-c', `git show ${PRE_EVENTS_COMMIT}:supabase/seed.sql > ${seed}`], { cwd: ROOT });
    file(seed, ["set lp.allow_seed = 'on'"]);
    execFileSync('rm', ['-f', seed]);
    const p = (n: number) => `(select id from public.patients order by case_number limit 1 offset ${n})`;
    sql(`
      insert into public.lp_messages (request_id, staff, staff_key, team, body, client_mutation_id)
        values (${p(0)}, 'Dana Kim · GC/HX - Dispatch', 'dana kim · gc/hx - dispatch', 'GC/HX - Dispatch', 'Synthetic message', gen_random_uuid());
      insert into public.lp_message_reads (request_id, staff, last_read_at) values (${p(0)}, 'sam ortiz · medical', now() - interval '1 hour');
      insert into public.lp_enroute (request_id, staff, staff_name, eta_at, eta_minutes, state)
        values (${p(1)}, 'dana kim · gc/hx - dispatch', 'Dana Kim', now() + interval '5 minutes', 5, 'enroute');
      insert into public.lp_activity (staff, request_id, kind, actor, detail) values ('sam ortiz · medical', ${p(2)}, 'edited', 'Dana Kim · GC/HX - Dispatch', 'Details changed');
      insert into public.lp_inactive_closes (request_id, closed_at, idle_since, quiet) values (${p(3)}, now() - interval '2 hours', now() - interval '3 hours', true);
      insert into public.lp_push_prefs (staff, team, new_requests) values ('sam ortiz · medical', 'Medical', true);
      insert into public.lp_push_subscriptions (endpoint, p256dh, auth, staff, team) values ('https://fcm.googleapis.com/fcm/send/synthetic', 'p256dh-synthetic-0000', 'auth-synthetic', 'sam ortiz · medical', 'Medical');
      insert into public.lp_tel_devices (device, team) values ('synthdevice01', 'medical');
      insert into public.lp_tel_events (at, device, session, team, name) values (now() - interval '1 day', 'synthdevice01', 'synthsession', 'medical', 'view');
      insert into public.audit_events (patient_id, staff_name, action_type, notes) values (null, 'System', 'note', 'a row with no request');
      insert into public.lp_login_attempts (ip, name_key, ok) values ('198.18.0.9', 'dana kim', true);
      -- Production may name its rule differently, or carry a second one; and a trigger may be off on purpose.
      alter table public.patients rename constraint patients_case_number_key to patients_case_number_legacy;
      create unique index patients_case_number_extra on public.patients (case_number) where case_number > 0;
      alter table public.patients disable trigger lp_enroute_clear;`);
    expect(sql('select count(*) from public.patients')).toBe('21');
    expect(Number(sql('select count(*) from public.audit_events'))).toBeGreaterThan(20);
    expect(Number(sql('select count(*) from public.patient_photos'))).toBeGreaterThan(0);
    before = snapshot();
  }, 120_000);

  it('keeps every existing column of every existing row, and puts every row in the archived edco26 event', () => {
    file(join(ROOT, 'supabase', 'migrations', EVENTS_FILE));
    expect(snapshot()).toEqual(before);

    const edc = JSON.parse(sql(`select to_jsonb(e) from public.events e where slug = 'edco26'`)) as Record<string, unknown>;
    expect(edc).toMatchObject({
      name: 'EDC Orlando',
      starts_on: '2026-11-06',
      ends_on: '2026-11-08',
      timezone: 'America/New_York',
      day_start_hour: 6,
      stage: 'archived',
      main_medical: 'Main Med',
      records_delete_at: null,
      records_deleted_at: null,
      staff_password_hash: null,
      invite_code_sha256: null,
      logo_path: null,
      report_to: [],
      case_seq: Number(sql('select max(case_number) from public.patients')),
    });
    // The end of its last show day (06:00 Monday in Orlando), not the time the file ran.
    expect(sql(`select ended_at = timestamptz '2026-11-09 06:00:00-05' from public.events where slug = 'edco26'`)).toBe('t');
    expect(edc.posts).toEqual([
      { id: 'fa3', label: 'FA 3 – Kinetic', short: 'FA 3' },
      { id: 'fa4', label: 'FA 4 – Oasis', short: 'FA 4' },
      { id: 'command', label: 'Command', short: 'Command' },
      { id: 'base', label: 'Base', short: 'Base' },
    ]);
    expect((edc.teams as Array<{ label: string; medical: boolean }>).map((t) => [t.label, t.medical])).toEqual([
      ['GC/HX - Special Operations/Med Transpo', false],
      ['GC/HX - Dispatch', false],
      ['GC/HX - Base', false],
      ['Medical', true],
    ]);
    expect(edc.last_seen).toEqual(['kineticFIELD', 'circuitGROUNDS', 'neonGARDEN', 'stereoBLOOM', 'Taken to medical']);
    expect(sql('select count(*) from public.events')).toBe('1');

    for (const t of ['patients', 'audit_events', 'lp_message_reads', 'lp_activity', 'lp_inactive_closes', 'lp_push_subscriptions', 'lp_tel_devices']) {
      expect(sql(`select count(*) filter (where event_id = '${edc.id}') || '/' || count(*) from public.${t}`), t).toMatch(/^(\d+)\/\1$/);
    }
    // Telemetry rows are never rewritten (NULL: before events existed); 30-day retention removes them.
    expect(sql('select count(*) from public.lp_tel_events where event_id is null')).toBe('1');
    // Numbering: per event, the old global default retired (the sequence itself kept, untouched).
    expect(sql(`select column_default is null from information_schema.columns where table_name = 'patients' and column_name = 'case_number'`)).toBe('t');
    expect(sql(`select count(*) from pg_indexes where indexname = 'patients_event_case_key'`)).toBe('1');
    expect(sql(`select count(*) from pg_constraint where conname in ('patients_case_number_key', 'patients_case_number_legacy', 'patients_reporting_location_check')`)).toBe('0');
    // No unique rule on case_number alone is left, whatever its name (constraint or index, partial or not).
    expect(sql(`select count(*) from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
                where i.indrelid = 'public.patients'::regclass and i.indisunique and i.indnkeyatts = 1 and a.attname = 'case_number'`)).toBe('0');
    // The backfill switched off only the triggers that were on, and switched exactly those back on.
    expect(sql(`select string_agg(tgname || ':' || tgenabled::text, ',' order by tgname) from pg_trigger where tgrelid = 'public.patients'::regclass and not tgisinternal`))
      .toBe('lp_enroute_clear:D,lp_patients_touch:O,lp_patients_writable:O');
    expect(sql(`select is_nullable from information_schema.columns where table_name = 'patients' and column_name = 'event_id'`)).toBe('NO');
  });

  it('pasted again, changes nothing at all', () => {
    const once = everything();
    file(join(ROOT, 'supabase', 'migrations', EVENTS_FILE));
    expect(everything()).toBe(once);
  });

  it('the finished event is frozen but readable; a new event numbers from LP-0001 beside it', () => {
    const edc = sql(`select id from public.events where slug = 'edco26'`);
    expect(() => sql(`update public.patients set hair = 'x' where case_number = 1013`)).toThrow(/event_ended/);
    expect(() => sql(`set role service_role; select lp_set_status('${edc}', (select id from public.patients where case_number = 1013), 0, 'Cancelled', 'X · Medical', 'cancel')`)).toThrow(/event_ended/);
    expect(sql(`set role service_role; select lp_stats('${edc}', 'event') ->> 'total'`)).toBe('21');
    expect(sql(`set role service_role; select jsonb_array_length(lp_sync('${edc}', null) -> 'rows')`)).toBe('21');
    // The auto-close never touches it (and the job does not fail on it).
    expect(sql('select public.lp_close_inactive()')).toBe('0');
    sql(`insert into public.events (slug, name, starts_on, ends_on, stage, posts, teams)
         values ('next', 'Next', current_date, current_date, 'live', '[{"id":"a","label":"Gate A","short":"A"}]', '[{"id":"m","label":"Medics","short":"Medics","medical":true}]')`);
    const next = sql(`select id from public.events where slug = 'next'`);
    const made = JSON.parse(sql(`set role service_role; select lp_create_request('${next}', '{"client_mutation_id":"00000000-0000-4000-8000-00000000babe","reporting_location":"Gate A"}', 'X · Medics')::text`)) as { row: { case_number: number } };
    expect(made.row.case_number).toBe(1);
    expect(sql(`set role service_role; select lp_stats('${next}', 'event') ->> 'total'`)).toBe('1');
    expect(sql(`set role service_role; select lp_tel_config() ->> 'on'`)).toBe('true');
  });
});
