// GET /api/stats (spec §8 Dashboard, A21, A31): every number checked against the database, the average
// answer time recomputed independently in TypeScript from the raw audit events, the exact seed numbers on
// a freshly reset database, and auth.
import { describe, expect, it } from 'vitest';
import type { Stats } from '@/lib/api-types';
import { POSTS, STATUS } from '@/lib/domain';
import { admin, api, cookieFor, createRequest, newStaff, psql, withTestServer } from './harness';

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

  it('requires a session', async () => {
    expect((await api('/api/stats')).status).toBe(401);
  });
});
