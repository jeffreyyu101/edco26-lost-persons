// GET /api/stats (spec §8 Dashboard, A21, A31, A49): every number checked against the database, the average
// answer and reunite times recomputed independently in TypeScript from the raw audit events, the exact seed
// numbers on a freshly reset database, and auth. avgReuniteMinutes and loggedLastHour are also checked for
// EXACT values on a scratch database (the local migration chain, then synthetic rows with fixed times),
// because the shared app database holds other runs' rows.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Stats } from '@/lib/api-types';
import { POSTS, STATUS } from '@/lib/domain';
import { ROOT } from '../../scripts/test-env.mjs';
import { admin, api, cookieFor, createBody, createRequest, dbUrl, newStaff, pii, psql, uniq, withTestServer } from './harness';

withTestServer();

const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
const OPEN_SQL = `status in (${[STATUS.waiting, STATUS.inMedical, STATUS.legacyBringFriend].map(lit).join(', ')})`;

/** count(*) of patients matching a SQL condition (local database, test-only). */
async function count(where = 'true'): Promise<number> {
  return Number(psql(`select count(*) from public.patients where ${where}`));
}

async function stats(): Promise<Stats> {
  const res = await api<Stats>('/api/stats', { cookie: await cookieFor(newStaff()) });
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('no-store');
  return res.body;
}

/** The dashboard's average answer time, recomputed from the raw audit trail (spec §8, A21). */
function expectedAvgAnswerMinutes(): number | null {
  const raw = psql(`
    select coalesce(json_agg(json_build_object(
      'pid', e.patient_id, 'type', e.action_type, 'prev', e.previous_value ->> 'status',
      'next', e.new_value ->> 'status', 'outcome', e.new_value ->> 'outcome',
      'at', extract(epoch from e.occurred_at), 'created', extract(epoch from p.created_at),
      'now', extract(epoch from clock_timestamp()))), '[]')
    from public.audit_events e join public.patients p on p.id = e.patient_id`);
  const events = JSON.parse(raw) as Array<{ pid: string; type: string; prev: string | null; next: string | null; outcome: string | null; at: number; created: number; now: number }>;
  const answers = new Set([STATUS.notInMedical, STATUS.inMedical, STATUS.legacyBringFriend] as string[]);
  const first = new Map<string, { at: number; created: number }>();
  let now = Date.now() / 1000;
  for (const e of events) {
    now = e.now;
    const isAnswer =
      ((e.type === 'status_changed' || e.type === 'check_completed') && e.prev === STATUS.waiting && answers.has(e.next ?? '')) ||
      (e.type === 'medical_search' && e.outcome === 'not_found') ||
      e.type === 'medical_search_found';
    if (!isAnswer) continue;
    const prev = first.get(e.pid);
    if (!prev || e.at < prev.at) first.set(e.pid, { at: e.at, created: e.created });
  }
  const recent = [...first.values()].filter((f) => f.at > now - 2 * 3600);
  if (recent.length === 0) return null;
  const mean = recent.reduce((s, f) => s + (f.at - f.created), 0) / recent.length / 60;
  return Math.round(mean * 10) / 10;
}

/** Raw audit events with the request's current status, plus the database clock. */
function rawAudit() {
  const raw = psql(`
    select coalesce(json_agg(json_build_object(
      'pid', e.patient_id, 'type', e.action_type, 'prev', e.previous_value ->> 'status',
      'next', e.new_value ->> 'status', 'status', p.status,
      'at', extract(epoch from e.occurred_at), 'now', extract(epoch from clock_timestamp()))), '[]')
    from public.audit_events e join public.patients p on p.id = e.patient_id`);
  return JSON.parse(raw) as Array<{ pid: string; type: string; prev: string | null; next: string | null; status: string; at: number; now: number }>;
}

/**
 * The dashboard's average time to reunite, recomputed from the raw audit trail (A49): per request that is
 * Reunited now, its latest status change into Reunited – Closed in the last 2 h, minus the latest In medical
 * answer at or before it (out of Waiting or Not in medical into In medical or legacy Bring friend, or a legacy
 * medical_search_found). Reunions with no such answer are left out.
 */
function expectedAvgReuniteMinutes(): number | null {
  const events = rawAudit();
  const now = events[0]?.now ?? Date.now() / 1000;
  const intoMedical = new Set<string>([STATUS.inMedical, STATUS.legacyBringFriend]);
  const fromUnanswered = new Set<string>([STATUS.waiting, STATUS.notInMedical]);
  const byPatient = new Map<string, typeof events>();
  for (const e of events) byPatient.set(e.pid, [...(byPatient.get(e.pid) ?? []), e]);
  const minutes: number[] = [];
  for (const list of byPatient.values()) {
    const reunions = list.filter((e) => e.type === 'status_changed' && e.next === STATUS.reunited && e.status === STATUS.reunited);
    if (reunions.length === 0) continue;
    const reunion = reunions.reduce((a, b) => (b.at > a.at ? b : a));
    if (reunion.at <= now - 2 * 3600) continue;
    const answers = list.filter(
      (e) =>
        e.at <= reunion.at &&
        ((e.type === 'status_changed' && fromUnanswered.has(e.prev ?? '') && intoMedical.has(e.next ?? '')) ||
          e.type === 'medical_search_found'),
    );
    if (answers.length === 0) continue;
    const answer = answers.reduce((a, b) => (b.at > a.at ? b : a));
    minutes.push((reunion.at - answer.at) / 60);
  }
  if (minutes.length === 0) return null;
  return Math.round((minutes.reduce((sum, m) => sum + m, 0) / minutes.length) * 10) / 10;
}

/** Requests created in the last 60 minutes, by the database clock. */
function loggedLastHourNow(): number {
  return Number(psql(`select count(*) from public.patients where created_at > clock_timestamp() - interval '60 minutes'`));
}

describe('GET /api/stats', () => {
  it('matches the database: counts, open split, byPost, longest wait, recent, average answer time', async () => {
    // Make sure there is at least one fresh answer inside the 2 h window.
    const staff = newStaff();
    const r = await createRequest(staff, { reportingLocation: 'Other', otherLocation: 'TEST-S Gate' });
    const answered = await api(`/api/requests/${r.id}/status`, {
      json: { status: STATUS.notInMedical, expectedVersion: r.rowVersion, kind: 'answer' },
      cookie: await cookieFor(newStaff('Medical')),
    });
    expect(answered.status).toBe(200);

    const s = await stats();
    const waiting = await count(`status = ${lit(STATUS.waiting)}`);
    const inMedical = await count(`status in (${lit(STATUS.inMedical)}, ${lit(STATUS.legacyBringFriend)})`);
    expect(s.open).toEqual({ waiting, inMedical });
    expect(s.notInMedical).toBe(await count(`status = ${lit(STATUS.notInMedical)}`));
    expect(s.reunited).toBe(await count(`status = ${lit(STATUS.reunited)}`));
    expect(s.discharged).toBe(await count(`status = ${lit(STATUS.discharged)}`));
    expect(s.cancelled).toBe(await count(`status = ${lit(STATUS.cancelled)}`));
    expect(s.total).toBe(await count());
    expect(s.serverTime).toMatch(/[+-]\d\d:\d\d$/);

    // byPost: the 4 fixed posts first (always present), then other locations with open rows; sums to open.
    const fixed = POSTS.filter((p) => p.value !== 'Other');
    expect(s.byPost.slice(0, 4).map((b) => b.reportingLocation)).toEqual(fixed.map((p) => p.value));
    expect(s.byPost.slice(0, 4).map((b) => b.postShort)).toEqual(fixed.map((p) => p.short));
    for (const b of s.byPost.slice(0, 4)) {
      expect(b.count).toBe(await count(`reporting_location = ${lit(b.reportingLocation)} and ${OPEN_SQL}`));
    }
    for (const b of s.byPost.slice(4)) expect(b.count).toBeGreaterThan(0);
    expect(s.byPost.reduce((n, b) => n + b.count, 0)).toBe(waiting + inMedical);

    // longestWait: the oldest Waiting row.
    const { data: oldest } = await admin()
      .from('patients')
      .select('id, case_number, created_at')
      .eq('status', STATUS.waiting)
      .order('created_at', { ascending: true })
      .order('case_number', { ascending: true })
      .limit(1);
    if (oldest && oldest[0]) {
      expect(s.longestWait?.id).toBe(oldest[0].id);
      expect(s.longestWait?.caseNumber).toBe(oldest[0].case_number);
      const minutes = Math.floor((Date.now() - Date.parse(oldest[0].created_at)) / 60_000);
      expect(Math.abs((s.longestWait?.minutes ?? -99) - minutes)).toBeLessThanOrEqual(1);
    } else {
      expect(s.longestWait).toBeNull();
    }

    // recent: the 5 most recently updated, newest first.
    const { data: recent } = await admin()
      .from('patients')
      .select('id')
      .order('updated_at', { ascending: false })
      .order('case_number', { ascending: false })
      .limit(5);
    expect(s.recent.map((x) => x.id)).toEqual((recent ?? []).map((x) => x.id));
    expect(s.recent[0]).toMatchObject({ id: r.id, status: STATUS.notInMedical, postShort: 'TEST-S Gate', name: r.name });

    expect(s.avgAnswerMinutes).not.toBeNull();
    expect(s.avgAnswerMinutes).toBeCloseTo(expectedAvgAnswerMinutes() as number, 1);
  });

  it('exact numbers on a freshly reset seed (skipped once tests have added rows)', async () => {
    const s = await stats();
    const seedOnly = (await count('case_number > 1013')) === 0;
    if (!seedOnly) return;
    expect(s.open).toEqual({ waiting: 4, inMedical: 3 });
    expect([s.notInMedical, s.reunited, s.discharged, s.cancelled, s.total]).toEqual([2, 10, 1, 1, 21]);
    expect(s.byPost.map((b) => [b.postShort, b.count])).toEqual([
      ['FA 3', 3],
      ['FA 4', 3],
      ['Command', 1],
      ['Base', 0],
    ]);
    expect(s.longestWait?.caseNumber).toBe(1010);
    expect(s.recent.map((x) => x.caseNumber)).toEqual([1013, 1007, 1004, 1012, 1011]);
  });

  it('avgReuniteMinutes and loggedLastHour match the database (v2.2 Performance, A49)', async () => {
    // A request of our own goes Waiting → In medical → Reunited through the API, so there is at least one
    // reunion in the 2 h window and one request logged in the last hour.
    const medical = await cookieFor(newStaff('Medical'));
    const created = await api('/api/requests', { json: createBody({ name: pii(`TEST-core-${uniq()}`) }), cookie: await cookieFor(newStaff()) });
    expect(created.status).toBe(201);
    const answered = await api(`/api/requests/${created.body.request.id}/status`, {
      json: { status: STATUS.inMedical, expectedVersion: created.body.request.rowVersion, kind: 'answer' },
      cookie: medical,
    });
    expect(answered.status).toBe(200);
    const reunited = await api(`/api/requests/${created.body.request.id}/status`, {
      json: { status: STATUS.reunited, expectedVersion: answered.body.request.rowVersion, kind: 'reunite' },
      cookie: medical,
    });
    expect(reunited.status).toBe(200);

    // Bracketed by database reads before and after, so another suite's request (or a row ageing out of the
    // window) between the reads can't make this flaky.
    const before = { avg: expectedAvgReuniteMinutes(), logged: loggedLastHourNow() };
    const s = await stats();
    const after = { avg: expectedAvgReuniteMinutes(), logged: loggedLastHourNow() };

    expect(Number.isInteger(s.loggedLastHour)).toBe(true);
    expect(s.loggedLastHour).toBeGreaterThanOrEqual(1);
    expect(s.loggedLastHour).toBeGreaterThanOrEqual(Math.min(before.logged, after.logged));
    expect(s.loggedLastHour).toBeLessThanOrEqual(Math.max(before.logged, after.logged));

    expect(typeof s.avgReuniteMinutes).toBe('number');
    const avg = s.avgReuniteMinutes as number;
    expect(Math.round(avg * 10) / 10).toBe(avg);
    const close = (x: number | null) => x !== null && Math.abs(avg - x) < 0.051;
    expect(close(before.avg) || close(after.avg), `${avg} vs ${before.avg} / ${after.avg}`).toBe(true);
  });

  it('requires a session', async () => {
    expect((await api('/api/stats')).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------------------------------
// Exact values (A49) on a scratch database: the local migration chain (baseline, Jeffrey's two 2026-11-05
// files, the rework) applied to a fresh database, then synthetic rows and audit events with fixed times.
// Every duration is set by the test, so the expected numbers are exact. The database is dropped afterwards.
// ---------------------------------------------------------------------------------------------------

const SCRATCH = `lp_stats_core_${process.pid}_${randomBytes(3).toString('hex')}`;
let scratchCreated = false;

function scratchUrl(): string {
  const url = new URL(dbUrl());
  url.pathname = `/${SCRATCH}`;
  return url.toString();
}

/** psql against the scratch database: a file (-f) or a command (-c). NOTICE lines are swallowed. */
function scratch(args: string[]): string {
  return execFileSync('psql', [scratchUrl(), '-v', 'ON_ERROR_STOP=1', '-q', '-At', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** lp_stats() on the scratch database, called as service_role like the app server. */
function scratchStats(): Stats {
  return JSON.parse(scratch(['-c', 'set role service_role; select public.lp_stats()::text;'])) as Stats;
}

type Ev = [key: string, actionType: string, previous: object | null, next: object | null, minutesAgo: number];

/** Synthetic requests [key, status, created minutes ago] and their audit events, relative to now(). */
function insertNight(rows: Array<[key: string, status: string, minutesAgo: number]>, events: Ev[]): void {
  const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
  const json = (v: object | null) => (v === null ? 'null::jsonb' : `${lit(JSON.stringify(v))}::jsonb`);
  const staff = lit('TEST-core Staff · Medical');
  scratch([
    '-c',
    `insert into public.patients (first_name, reporting_location, status, created_by, updated_by, created_at) values ${rows
      .map(([k, status, ago]) => `(${lit(k)}, 'FA 3 – Kinetic', ${lit(status)}, ${staff}, ${staff}, now() - make_interval(mins => ${ago}))`)
      .join(', ')};
     insert into public.audit_events (patient_id, staff_name, action_type, previous_value, new_value, occurred_at)
     select p.id, ${staff}, e.t, e.prev, e.next, now() - make_interval(mins => e.ago)
     from (values ${events.map(([k, t, prev, next, ago]) => `(${lit(k)}, ${lit(t)}, ${json(prev)}, ${json(next)}, ${ago})`).join(', ')})
       as e(k, t, prev, next, ago)
     join public.patients p on p.first_name = e.k;`,
  ]);
}

/** A status_changed event as lp_set_status writes it. */
function change(key: string, from: string, to: string, kind: string, minutesAgo: number): Ev {
  return [key, 'status_changed', { status: from }, { status: to, kind }, minutesAgo];
}

describe('lp_stats avgReuniteMinutes and loggedLastHour: exact values on a scratch database (A49)', () => {
  const S = STATUS;

  afterAll(() => {
    if (scratchCreated) psql(`drop database if exists ${SCRATCH} with (force)`);
  });

  it('builds the scratch database from the local migration chain', () => {
    psql(`create database ${SCRATCH}`);
    scratchCreated = true;
    const chain = readdirSync(join(ROOT, 'supabase', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
    expect(chain.at(-1)).toBe('20261106000000_rework.sql');
    for (const file of chain) scratch(['-f', join(ROOT, 'supabase', 'migrations', file)]);
    expect(scratchStats()).toMatchObject({ total: 0, avgReuniteMinutes: null, loggedLastHour: 0, avgAnswerMinutes: null });
  }, 60_000);

  it('null when no reunion qualifies; loggedLastHour counts every status created in the last 60 minutes', () => {
    insertNight(
      [
        ['TEST-core-6', S.reunited, 200], // reunited 130 minutes ago: outside the 2 h window
        ['TEST-core-7', S.inMedical, 59], // reunited, then reopened: not Reunited now
        ['TEST-core-8', S.discharged, 61], // discharged, never reunited
        ['TEST-core-9', S.reunited, 30], // reunited with no In medical answer in the audit (a direct write)
      ],
      [
        change('TEST-core-6', S.waiting, S.inMedical, 'answer', 150),
        change('TEST-core-6', S.inMedical, S.reunited, 'reunite', 130),
        change('TEST-core-7', S.waiting, S.inMedical, 'answer', 30),
        change('TEST-core-7', S.inMedical, S.reunited, 'reunite', 20),
        change('TEST-core-7', S.reunited, S.inMedical, 'reopen', 10),
        change('TEST-core-8', S.waiting, S.inMedical, 'answer', 50),
        change('TEST-core-8', S.inMedical, S.discharged, 'discharge', 20),
        change('TEST-core-9', S.inMedical, S.reunited, 'reunite', 5),
      ],
    );
    // Created in the last hour: 7 (59 min) and 9 (30 min); 6 (200) and 8 (61) are older.
    expect(scratchStats()).toMatchObject({ total: 4, avgReuniteMinutes: null, loggedLastHour: 2 });
  });

  it('the mean from the latest In medical answer to the latest reunion, rounded to 1 decimal', () => {
    insertNight(
      [
        ['TEST-core-1', S.reunited, 50],
        ['TEST-core-2', S.reunited, 100],
        ['TEST-core-3', S.reunited, 180],
        ['TEST-core-4', S.reunited, 55],
        ['TEST-core-5', S.reunited, 170],
        ['TEST-core-10', S.cancelled, 5],
        ['TEST-core-11', S.waiting, 1],
      ],
      [
        // 1: answered 40, reunited 30 → 10 min.
        change('TEST-core-1', S.waiting, S.inMedical, 'answer', 40),
        change('TEST-core-1', S.inMedical, S.reunited, 'reunite', 30),
        // 2: In medical 95, changed to Not in medical 90, changed back 60, reunited 35 → 25 min (latest answer).
        change('TEST-core-2', S.waiting, S.inMedical, 'answer', 95),
        change('TEST-core-2', S.inMedical, S.notInMedical, 'change', 90),
        change('TEST-core-2', S.notInMedical, S.inMedical, 'change', 60),
        change('TEST-core-2', S.inMedical, S.reunited, 'reunite', 35),
        // 3: Jeffrey's app (full-row previous_value, the patch as new_value), legacy Bring friend → 15 min.
        ['TEST-core-3', 'status_changed', { status: S.waiting, first_name: 'TEST-core-3', closed_at: null }, { status: S.legacyBringFriend, found_at: '2026-11-06T00:00:00Z' }, 75],
        ['TEST-core-3', 'status_changed', { status: S.legacyBringFriend, first_name: 'TEST-core-3' }, { status: S.reunited, closed_at: '2026-11-06T00:00:00Z' }, 60],
        // 4: answered 51, reunited 45, Undo 44 (not an answer), reunited again 40 → 11 min.
        change('TEST-core-4', S.waiting, S.inMedical, 'answer', 51),
        change('TEST-core-4', S.inMedical, S.reunited, 'reunite', 45),
        change('TEST-core-4', S.reunited, S.inMedical, 'undo', 44),
        change('TEST-core-4', S.inMedical, S.reunited, 'reunite', 40),
        // 5: Jeffrey's legacy medical_search_found 110, reunited 100 → 10 min.
        ['TEST-core-5', 'medical_search_found', null, {}, 110],
        change('TEST-core-5', S.inMedical, S.reunited, 'reunite', 100),
      ],
    );
    // (10 + 25 + 15 + 11 + 10) / 5 = 14.2. Logged in the last hour: 1, 4, 7, 9, 10 and 11.
    expect(scratchStats()).toMatchObject({ total: 11, avgReuniteMinutes: 14.2, loggedLastHour: 6 });

    // One more reunion of 12 min 20 s: (71 + 12.333…) / 6 = 13.888… → 13.9.
    scratch([
      '-c',
      `insert into public.patients (first_name, reporting_location, status, created_by, updated_by, created_at)
       values ('TEST-core-12', 'Base', 'Reunited – Closed', 'TEST-core Staff · Medical', 'TEST-core Staff · Medical', now() - interval '3 hours');
       insert into public.audit_events (patient_id, staff_name, action_type, previous_value, new_value, occurred_at)
       select p.id, 'TEST-core Staff · Medical', 'status_changed', e.prev, e.next, now() - e.ago
       from (values ('{"status":"Added"}'::jsonb, '{"status":"Found – Awaiting Reunion","kind":"answer"}'::jsonb, interval '30 minutes 20 seconds'),
                    ('{"status":"Found – Awaiting Reunion"}'::jsonb, '{"status":"Reunited – Closed","kind":"reunite"}'::jsonb, interval '18 minutes'))
         as e(prev, next, ago)
       join public.patients p on p.first_name = 'TEST-core-12';`,
    ]);
    expect(scratchStats()).toMatchObject({ total: 12, avgReuniteMinutes: 13.9, loggedLastHour: 6 });
  });
});
