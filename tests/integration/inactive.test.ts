// F6 · Inactivity auto-close (Brian 2026-11-06 19:55–20:07; spec §24 A96–A103) against the local stack: the SQL
// (lp_close_inactive, lp_inactive_claim, the status CHECK, the pg_cron job), its Reopen through the real route, the
// sync telling the staff involved once, the dashboard's numbers and the export.
//   * Requests In medical (Friend coming, en route, arrived; the legacy Bring friend) close after 60 idle minutes,
//     measured from the latest audit row (backdated here with psql), else created_at; at 59 they stay.
//   * Every write is activity (it writes an audit row and resets the clock); reading never is.
//   * Waiting for check never closes (Needs info, the Pending hold, Recheck due), nor anything closed.
//   * Idempotent: a second run closes nothing; the migration pasted twice leaves exactly one cron job.
//   * Reopen (any staff) → In medical, no way back to Closed · inactive through the API.
//   * The dashboard never counts it as a reunion; the export shows the status.
// The job itself stays paused on local stacks (tests/helpers/integration-setup.ts): every close here is
// lp_close_inactive(array[…]) on this file's own rows, or the whole function inside a rolled-back transaction.
// Synthetic rows only (TEST-S…), closed again afterwards by the harness or left Closed · inactive.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RequestDetail, RequestSummary, Stats, SyncResponse } from '@/lib/api-types';
import { INACTIVE_MINUTES, STATUS, STATUS_META, SYSTEM_STAFF } from '@/lib/domain';
import { ROOT } from '../../scripts/test-env.mjs';
import { EVENT_ID, admin, api, cookieFor, createRequest, dbUrl, forceStatus, newStaff, psql, staffOf, withTestServer, type Staff } from './harness';
import { eventually } from './push-service';

withTestServer();

const MEDIC = newStaff('Medical');
const FOH = newStaff('GC/HX - Dispatch');
const IN_MEDICAL = STATUS.inMedical;
const MIGRATION = readFileSync(join(ROOT, 'supabase/migrations/20261106000000_rework.sql'), 'utf8');

const lit = (id: string) => `'${id.replace(/'/g, "''")}'`;
const uuidArray = (ids: readonly string[]) => `array[${ids.map(lit).join(', ')}]::uuid[]`;

async function setStatus(r: Pick<RequestSummary, 'id' | 'rowVersion'>, status: string, kind: string, staff: Staff) {
  const res = await api(`/api/requests/${r.id}/status`, { json: { status, expectedVersion: r.rowVersion, kind }, cookie: await cookieFor(staff) });
  return res;
}

async function answered(staff: Staff = MEDIC): Promise<RequestSummary> {
  const r = await createRequest(FOH);
  const res = await setStatus(r, IN_MEDICAL, 'answer', staff);
  expect(res.status, res.text).toBe(200);
  return res.body.request as RequestSummary;
}

/**
 * Moves every audit row of the request and its created_at `minutes` into the past (idle that long). The patients
 * update bumps row_version (the touch trigger), as any write does.
 */
function backdate(id: string, minutes: number): void {
  psql(
    `update public.audit_events set occurred_at = occurred_at - interval '${minutes} minutes' where patient_id = ${lit(id)};` +
      ` update public.patients set created_at = created_at - interval '${minutes} minutes' where id = ${lit(id)};`,
  );
}

/** lp_close_inactive on these requests only (the job's own run takes every request). */
function closeInactive(ids: readonly string[]): number {
  return Number(psql(`select public.lp_close_inactive(${uuidArray(ids)})`));
}

interface DbRow {
  status: string;
  row_version: number;
  updated_by: string;
  closed_at: string | null;
  found_at: string | null;
  reunion_started_at: string | null;
}

async function dbRow(id: string): Promise<DbRow> {
  const { data, error } = await admin().from('patients').select('status, row_version, updated_by, closed_at, found_at, reunion_started_at').eq('id', id).single();
  if (error) throw new Error(error.code);
  return data as DbRow;
}

const audits = (id: string) => Number(psql(`select count(*) from public.audit_events where patient_id = ${lit(id)}`));

async function enroute(id: string, json: Record<string, unknown>, staff: Staff = FOH) {
  const res = await api(`/api/requests/${id}/enroute`, { json, cookie: await cookieFor(staff) });
  expect(res.status, res.text).toBe(200);
  return res.body;
}

async function postMessage(id: string, body: string, staff: Staff) {
  const res = await api(`/api/requests/${id}/messages`, { json: { clientMutationId: randomUUID(), body }, cookie: await cookieFor(staff) });
  expect(res.status, res.text).toBe(201);
  return res.body as { message: { id: string } };
}

async function patch(id: string, body: Record<string, unknown>, staff: Staff = MEDIC) {
  const row = await dbRow(id);
  const res = await api(`/api/requests/${id}`, { method: 'PATCH', json: { patch: body, expectedVersion: row.row_version }, cookie: await cookieFor(staff) });
  expect(res.status, res.text).toBe(200);
}

/** The migration file's body (without its own begin / commit), for pastes inside a transaction we roll back. */
function migrationBody(): string {
  const lines = MIGRATION.split('\n');
  const begin = lines.findIndex((l) => l.trim() === 'begin;');
  let commit = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) if (lines[i]?.trim() === 'commit;') { commit = i; break; }
  expect(begin).toBeGreaterThan(0);
  expect(commit).toBeGreaterThan(begin);
  return lines.slice(begin + 1, commit).join('\n');
}

/** Runs `sql` as one psql script (stdin), returning stdout (unaligned, tuples only). */
function psqlScript(sql: string): string {
  return execFileSync('psql', [dbUrl(), '-v', 'ON_ERROR_STOP=1', '-q', '-At', '-f', '-'], {
    input: sql,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

describe('lp_close_inactive', () => {
  it('closes requests In medical after 60 idle minutes: Friend coming, en route, arrived and the legacy Bring friend', async () => {
    const coming = await answered();
    const onTheWay = await answered();
    await enroute(onTheWay.id, { action: 'set', etaMinutes: 5 });
    const arrived = await answered();
    await enroute(arrived.id, { action: 'set', etaMinutes: 5 });
    await enroute(arrived.id, { action: 'arrive' });
    const legacy = await createRequest(FOH);
    await forceStatus(legacy.id, STATUS.legacyBringFriend);
    const ids = [coming.id, onTheWay.id, arrived.id, legacy.id];
    const before = await Promise.all(ids.map(dbRow));
    for (const id of ids) backdate(id, INACTIVE_MINUTES + 1);
    const since = psql("select to_json(clock_timestamp()) #>> '{}'");

    expect(closeInactive(ids)).toBe(4);

    for (const [i, id] of ids.entries()) {
      const row = await dbRow(id);
      expect(row.status, id).toBe(STATUS.inactive);
      expect(row.updated_by).toBe(SYSTEM_STAFF);
      expect(row.closed_at).not.toBeNull();
      // The touch trigger bumped the version (phones sync it); found_at is kept.
      expect(row.row_version).toBeGreaterThan(before[i]!.row_version + 1);
      expect(row.found_at).toBe(before[i]!.found_at);
      // ONE audit row by System: from where it was, kind auto_close, "No activity for 1 h".
      const audit = JSON.parse(
        psql(`select json_agg(json_build_object('staff', staff_name, 'from', previous_value ->> 'status', 'to', new_value ->> 'status', 'kind', new_value ->> 'kind', 'notes', notes, 'minutes', new_value ->> 'inactive_minutes', 'idle', new_value ->> 'idle_since')) from public.audit_events where patient_id = ${lit(id)} and new_value ->> 'kind' = 'auto_close'`),
      ) as Array<Record<string, string>>;
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ staff: SYSTEM_STAFF, from: before[i]!.status, to: STATUS.inactive, kind: 'auto_close', notes: 'No activity for 1 h', minutes: '60' });
      expect(audit[0]?.idle).toBeTruthy();
    }
    // F3's trigger cleared en route on the way out, attributed to System.
    expect(psql(`select count(*) from public.lp_enroute where request_id in (${lit(onTheWay.id)}, ${lit(arrived.id)})`)).toBe('0');
    expect(psql(`select string_agg(distinct staff_name, ',') from public.audit_events where patient_id = ${lit(onTheWay.id)} and action_type = 'enroute' and new_value ->> 'state' = 'cleared'`)).toBe(SYSTEM_STAFF);

    // Phones see it: the delta sync carries it, and the detail shows the System change and its note.
    const cookie = await cookieFor(FOH);
    const sync = (await api(`/api/sync?since=${encodeURIComponent(since)}`, { cookie })).body as SyncResponse;
    expect(sync.rows.find((r) => r.id === coming.id)).toMatchObject({ status: STATUS.inactive, updatedBy: SYSTEM_STAFF });
    const detail = (await api(`/api/requests/${coming.id}`, { cookie })).body as RequestDetail;
    expect(detail.status).toBe(STATUS.inactive);
    const last = detail.audit[detail.audit.length - 1]!;
    expect(last).toMatchObject({ action: 'status', staff: SYSTEM_STAFF, notes: 'No activity for 1 h', previous: { status: IN_MEDICAL }, next: { status: STATUS.inactive, kind: null } });
  });

  it('measures from the latest audit row, else created_at: 59 idle minutes stay open', async () => {
    const r = await answered();
    backdate(r.id, INACTIVE_MINUTES - 1);
    expect(closeInactive([r.id])).toBe(0);
    expect((await dbRow(r.id)).status).toBe(IN_MEDICAL);
    backdate(r.id, 2);
    expect(closeInactive([r.id])).toBe(1);

    // A row with no audit row at all (written before the app audited): its created_at.
    const fresh = randomUUID();
    const stale = randomUUID();
    const by = staffOf(FOH);
    psql(
      // (Events) Rows of the test event, numbered by hand (well above any request the app numbers).
      `insert into public.patients (id, event_id, case_number, first_name, reporting_location, status, created_by, updated_by, created_at) values ` +
        `(${lit(fresh)}, ${lit(EVENT_ID)}, 900000000 + (random() * 99999999)::bigint, 'TEST-S no audit fresh', 'Base', 'Found – Awaiting Reunion', ${lit(by)}, ${lit(by)}, now() - interval '30 minutes'), ` +
        `(${lit(stale)}, ${lit(EVENT_ID)}, 900000000 + (random() * 99999999)::bigint, 'TEST-S no audit stale', 'Base', 'Found – Awaiting Reunion', ${lit(by)}, ${lit(by)}, now() - interval '61 minutes')`,
    );
    expect(closeInactive([fresh, stale])).toBe(1);
    expect((await dbRow(fresh)).status).toBe(IN_MEDICAL);
    expect((await dbRow(stale)).status).toBe(STATUS.inactive);
    await forceStatus(fresh, STATUS.reunited);
  });

  it('every write is activity (it audits and resets the clock); reading never is', async () => {
    const writes: Array<[string, (r: RequestSummary) => Promise<void>]> = [
      ['message', async (r) => void (await postMessage(r.id, 'TEST-S being worked up', MEDIC))],
      ['unsend', async (r) => {
        const m = await postMessage(r.id, 'TEST-S typo', MEDIC);
        backdate(r.id, INACTIVE_MINUTES + 1);
        const res = await api(`/api/requests/${r.id}/messages/${m.message.id}/unsend`, { json: {}, cookie: await cookieFor(MEDIC) });
        expect(res.status, res.text).toBe(200);
      }],
      ['en route', async (r) => void (await enroute(r.id, { action: 'set', etaMinutes: 10 }))],
      ['en route cancel', async (r) => {
        await enroute(r.id, { action: 'set' });
        backdate(r.id, INACTIVE_MINUTES + 1);
        await enroute(r.id, { action: 'cancel' });
      }],
      ['location', async (r) => patch(r.id, { medicalLocation: 'TEST-S Bed 3' })],
      ['edit', async (r) => patch(r.id, { hair: 'TEST-S red' }, FOH)],
      ['photo', async (r) => {
        const photo = randomUUID();
        expect(psql(`select public.lp_add_photo(${lit(r.id)}, ${lit(photo)}, ${lit(`${r.id}/${photo}.jpg`)}, null, 'today', ${lit(staffOf(MEDIC))}) ->> 'created'`)).toBe('true');
      }],
      ['Reunited, then Undo', async (r) => {
        const row = await dbRow(r.id);
        const done = await setStatus({ id: r.id, rowVersion: row.row_version }, STATUS.reunited, 'reunite', MEDIC);
        expect(done.status, done.text).toBe(200);
        backdate(r.id, INACTIVE_MINUTES + 1);
        // (backdate itself bumps row_version: the Undo carries the version as it is now)
        const back = await setStatus({ id: r.id, rowVersion: (await dbRow(r.id)).row_version }, IN_MEDICAL, 'undo', MEDIC);
        expect(back.status, back.text).toBe(200);
      }],
    ];
    for (const [name, write] of writes) {
      const r = await answered();
      backdate(r.id, INACTIVE_MINUTES + 1);
      const n = audits(r.id);
      await write(r);
      expect(audits(r.id), `${name} writes an audit row`).toBeGreaterThan(n);
      expect(closeInactive([r.id]), `${name} resets the clock`).toBe(0);
      expect((await dbRow(r.id)).status, name).toBe(IN_MEDICAL);
      // …and once that is an hour old too, it closes.
      backdate(r.id, INACTIVE_MINUTES + 1);
      expect(closeInactive([r.id]), name).toBe(1);
    }

    // Reading: the detail, the thread, the read cursor, Activity, sync. No audit row, the clock runs on.
    const r = await answered();
    await postMessage(r.id, 'TEST-S any tattoos?', MEDIC);
    backdate(r.id, INACTIVE_MINUTES + 1);
    const n = audits(r.id);
    const cookie = await cookieFor(FOH);
    expect((await api(`/api/requests/${r.id}`, { cookie })).status).toBe(200);
    expect((await api(`/api/requests/${r.id}/messages`, { cookie })).status).toBe(200);
    expect((await api(`/api/requests/${r.id}/messages/read`, { json: {}, cookie })).status).toBe(200);
    expect((await api('/api/activity/read', { json: { all: true }, cookie })).status).toBe(200);
    expect((await api(`/api/sync?ids=${r.id}`, { cookie })).status).toBe(200);
    expect(audits(r.id)).toBe(n);
    expect(closeInactive([r.id])).toBe(1);
  });

  it('never closes Waiting for check (plain, Needs info, Pending, Recheck due) or anything closed', async () => {
    const plain = await createRequest(FOH);
    const needsInfo = await createRequest(FOH);
    await postMessage(needsInfo.id, 'TEST-S do you have a photo?', MEDIC);
    const held = await createRequest(FOH);
    expect((await setStatus(held, STATUS.notInMedical, 'answer', MEDIC)).body.request.recheckAt).toBeTruthy();
    const due = await createRequest(FOH);
    await setStatus(due, STATUS.notInMedical, 'answer', MEDIC);
    psql(`update public.patients set recheck_at = now() - interval '2 hours' where id = ${lit(due.id)}`);
    const reunited = await answered();
    await setStatus(reunited, STATUS.reunited, 'reunite', MEDIC);
    const notFound = await answered();
    await setStatus(notFound, STATUS.notInMedical, 'change', MEDIC);
    const discharged = await answered();
    await setStatus(discharged, STATUS.discharged, 'discharge', MEDIC);
    const cancelled = await createRequest(FOH);
    expect((await api(`/api/requests/${cancelled.id}/cancel`, { json: { expectedVersion: cancelled.rowVersion }, cookie: await cookieFor(FOH) })).status).toBe(200);
    const already = await answered();
    backdate(already.id, INACTIVE_MINUTES + 1);
    expect(closeInactive([already.id])).toBe(1);

    const ids = [plain, needsInfo, held, due, reunited, notFound, discharged, cancelled, already].map((r) => r.id);
    for (const id of ids) backdate(id, 3 * INACTIVE_MINUTES);
    const before = await Promise.all(ids.map(dbRow));
    expect(closeInactive(ids)).toBe(0);
    const after = await Promise.all(ids.map(dbRow));
    expect(after.map((r) => [r.status, r.row_version])).toEqual(before.map((r) => [r.status, r.row_version]));
    expect(before.slice(0, 4).every((r) => r.status === STATUS.waiting)).toBe(true);
  });

  it('is idempotent; without a list it closes every eligible request (rolled back here: the stack is shared)', async () => {
    const a = await answered();
    const b = await answered();
    const open = await answered();
    backdate(a.id, INACTIVE_MINUTES + 5);
    backdate(b.id, INACTIVE_MINUTES + 5);
    const out = psqlScript(`begin;
select public.lp_close_inactive();
select count(*) from public.patients where id in (${lit(a.id)}, ${lit(b.id)}) and status = 'Closed – Inactive';
select status from public.patients where id = ${lit(open.id)};
select public.lp_close_inactive();
select count(*) from public.lp_inactive_closes where request_id in (${lit(a.id)}, ${lit(b.id)});
rollback;`).split('\n');
    expect(Number(out[0])).toBeGreaterThanOrEqual(2);
    expect(out.slice(1)).toEqual(['2', IN_MEDICAL, '0', '2']);
    // Rolled back: nothing changed.
    expect((await dbRow(a.id)).status).toBe(IN_MEDICAL);
    // A second run on the same rows closes nothing more.
    expect(closeInactive([a.id, b.id])).toBe(2);
    expect(closeInactive([a.id, b.id])).toBe(0);
  });

  it('is service_role only (security definer, the function timeouts)', () => {
    expect(psql("select prosecdef from pg_proc where proname = 'lp_close_inactive'")).toBe('t');
    const cfg = psql("select proconfig::text from pg_proc where proname = 'lp_close_inactive'");
    expect(cfg).toContain('statement_timeout=4s');
    expect(cfg).toContain('lock_timeout=2s');
    expect(cfg).toContain('search_path=public, pg_temp');
    for (const fn of ['lp_close_inactive(uuid[])', 'lp_inactive_claim(uuid, uuid[])', 'lp_inactive_minutes()']) {
      expect(psql(`select has_function_privilege('anon', 'public.${fn}', 'execute')::text || has_function_privilege('authenticated', 'public.${fn}', 'execute')::text || has_function_privilege('service_role', 'public.${fn}', 'execute')::text`), fn).toBe('falsefalsetrue');
    }
    expect(psql('select public.lp_inactive_minutes()')).toBe(String(INACTIVE_MINUTES));
  });
});

describe('the migration', () => {
  it('pasted twice leaves exactly one cron job (every 5 minutes) and allows the status in the CHECK', () => {
    const body = migrationBody();
    const out = psqlScript(`begin;
${body}
${body}
select count(*) || '|' || min(schedule) || '|' || min(command) from cron.job where jobname = 'lp-close-inactive';
select pg_get_constraintdef(oid) like '%''Closed – Inactive''%' from pg_constraint where conname = 'patients_status_check';
rollback;`).split('\n');
    expect(out.slice(-2)).toEqual(['1|*/5 * * * *|select public.lp_close_inactive()', 't']);
    // Rolled back: the local stack's job stays paused.
    expect(psql("select count(*) from cron.job where jobname = 'lp-close-inactive'")).toBe('0');
  });

  it('turns New requests on for everyone who never set it (and their devices), pasted twice; a switch set in the sheet stays', () => {
    const id = () => randomUUID().slice(0, 8);
    const rows: Array<[name: string, team: string, prefsOn: boolean, set: boolean, deviceOn: boolean]> = [
      [`test-s staff ${id()} · medical`, 'Medical', false, false, false],
      [`test-s staff ${id()} · medical`, 'Medical', false, true, false],
      // A row an old bell turned on before (never set in the sheet): it keeps its Activity rows (not the team default).
      [`test-s staff ${id()} · medical`, 'Medical', true, false, true],
      // (2026-11-08, Brian: "new requests should be on for everyone by default n configurable") Every team now.
      [`test-s staff ${id()} · gc/hx - dispatch`, 'GC/HX - Dispatch', false, false, false],
      [`test-s staff ${id()} · gc/hx - base`, 'GC/HX - Base', false, true, false],
      [`test-s staff ${id()} · gc/hx - base`, 'GC/HX - Base', true, true, true],
      [`test-s staff ${id()} · gc/hx - dispatch`, 'GC/HX - Dispatch', true, false, true],
    ];
    const ep = (s: string) => `https://push.example.test/${encodeURIComponent(s)}`;
    const out = psqlScript(`begin;
insert into public.lp_push_prefs (staff, team, new_requests, new_requests_set) values
  ${rows.map(([s, team, on, set]) => `(${lit(s)}, ${lit(team)}, ${on}, ${set})`).join(',\n  ')};
insert into public.lp_push_subscriptions (endpoint, p256dh, auth, staff, team, new_requests) values
  ${rows.map(([s, team, , , on]) => `(${lit(ep(s))}, 'p256dh-key-0123456789', 'auth-0123', ${lit(s)}, ${lit(team)}, ${on})`).join(',\n  ')};
${migrationBody()}
${migrationBody()}
select string_agg(pr.new_requests::text || '/' || s.new_requests::text || '/' || pr.new_requests_team_default::text, ',' order by o.n)
  from (values ${rows.map(([s], i) => `(${lit(s)}, ${i})`).join(', ')}) o(staff, n)
  join public.lp_push_prefs pr on pr.staff = o.staff join public.lp_push_subscriptions s on s.staff = pr.staff;
rollback;`).split('\n');
    // prefs / device / on by the team default alone (push only, no Activity row).
    expect(out[out.length - 1]).toBe(
      [
        'true/true/true', // Medical, never set
        'false/false/false', // Medical, set off in the sheet
        'true/true/false', // Medical, an old bell's
        'true/true/true', // front of house, never set
        'false/false/false', // front of house, set off in the sheet
        'true/true/false', // front of house, set on in the sheet
        'true/true/false', // front of house, an old bell's
      ].join(','),
    );
  });
});

describe('Reopen', () => {
  it('anyone reopens Closed · inactive back to In medical (kind reopen, found_at kept); nothing moves back through the API', async () => {
    const r = await answered();
    backdate(r.id, INACTIVE_MINUTES + 1);
    closeInactive([r.id]);
    const closed = await dbRow(r.id);
    // Not the logger, not the answerer.
    const other = newStaff('GC/HX - Base');
    // Straight to Reunited is not a move from Closed · inactive.
    const skip = await setStatus({ id: r.id, rowVersion: closed.row_version }, STATUS.reunited, 'reunite', other);
    expect(skip.status).toBe(422);
    const res = await setStatus({ id: r.id, rowVersion: closed.row_version }, IN_MEDICAL, 'reopen', other);
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ changed: true, request: { status: IN_MEDICAL, closedAt: null, foundAt: closed.found_at } });
    expect(Date.parse(res.body.request.reunionStartedAt)).toBeGreaterThan(Date.parse(closed.reunion_started_at ?? '1970-01-01'));
    const detail = (await api(`/api/requests/${r.id}`, { cookie: await cookieFor(other) })).body as RequestDetail;
    expect(detail.audit[detail.audit.length - 1]).toMatchObject({ action: 'status', staff: staffOf(other), previous: { status: STATUS.inactive }, next: { status: IN_MEDICAL, kind: 'reopen' } });
    // Closed · inactive is no target for any client (only the server's job writes it).
    const back = await setStatus(res.body.request, STATUS.inactive, 'undo', other);
    expect(back.status).toBe(422);
    expect((await dbRow(r.id)).status).toBe(IN_MEDICAL);
    // Reopened, it is In medical like any other: it closes again after another idle hour.
    backdate(r.id, INACTIVE_MINUTES + 1);
    expect(closeInactive([r.id])).toBe(1);
  });
});

describe('the dashboard and the export', () => {
  it('an inactive close is never a reunion (Reunited, Time to reunite); it counts as closed', async () => {
    const r = await answered();
    backdate(r.id, INACTIVE_MINUTES + 1);
    // Before and after in one transaction (rolled back), so nothing else moves the numbers in between.
    const [before, closed, after] = psqlScript(`begin;
select public.lp_stats(${lit(EVENT_ID)})::text;
select public.lp_close_inactive(${uuidArray([r.id])});
select public.lp_stats(${lit(EVENT_ID)})::text;
rollback;`).split('\n') as [string, string, string];
    expect(closed).toBe('1');
    const s0 = JSON.parse(before) as Stats;
    const s1 = JSON.parse(after) as Stats;
    expect(s1.reunited).toBe(s0.reunited);
    expect(s1.avgReuniteMinutes).toBe(s0.avgReuniteMinutes);
    expect(s1.inactive).toBe((s0.inactive ?? 0) + 1);
    expect(s1.open.inMedical).toBe(s0.open.inMedical - 1);
    expect(s1.total).toBe(s0.total);
    // Open + every closed status = total.
    expect(s1.open.waiting + s1.open.inMedical + s1.notInMedical + s1.reunited + s1.discharged + s1.cancelled + (s1.inactive ?? 0) + (s1.friendInformed ?? 0)).toBe(s1.total);

    // Through the route, once it really closed.
    closeInactive([r.id]);
    const stats = (await api('/api/stats', { cookie: await cookieFor(FOH) })).body as Stats;
    expect(typeof stats.inactive).toBe('number');
    expect(stats.inactive).toBeGreaterThanOrEqual(1);
  });

  it('docs/export.sql shows "Closed · inactive" and the System audit row', async () => {
    const r = await answered();
    backdate(r.id, INACTIVE_MINUTES + 1);
    closeInactive([r.id]);
    // (Events) The file exports one event (EDC's by default): here the local test event.
    const sql = readFileSync(join(ROOT, 'docs', 'export.sql'), 'utf8').replaceAll("ev.slug = 'edco26'", "ev.slug = 'local'");
    const [q1, rest] = sql.split(/^-- Query 2: audit trail$/m) as [string, string];
    const [q2] = rest.split(/^-- Query 3: messages and en route$/m) as [string, string];
    const caseLabel = `LP-${String(r.caseNumber).padStart(4, '0')}`;
    const run = (q: string) =>
      execFileSync('psql', [dbUrl(), '-v', 'ON_ERROR_STOP=1', '-q', '--csv', '-c', q], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, PGOPTIONS: '-c default_transaction_read_only=on' },
      });
    const line1 = run(q1).split('\n').find((l) => l.startsWith(`${caseLabel},`)) ?? '';
    expect(line1).toContain(`,${STATUS_META[STATUS.inactive].label},${STATUS.inactive},`);
    const line2 = run(q2).split('\n').find((l) => l.startsWith(`${caseLabel},`) && l.includes('auto_close')) ?? '';
    expect(line2).toContain(`,${SYSTEM_STAFF},status_changed,${IN_MEDICAL},${STATUS.inactive},auto_close,No activity for 1 h,`);
  });
});

describe('telling the staff involved (F4 Activity + push, once)', () => {
  const canon = (s: Staff) => staffOf(s).toLowerCase();
  async function activityOf(staff: Staff, requestId: string) {
    const { data, error } = await admin().from('lp_activity').select('kind, actor, detail, at').eq('staff', canon(staff)).eq('request_id', requestId).maybeSingle();
    if (error) throw new Error(error.code);
    return data as { kind: string; actor: string; detail: string; at: string } | null;
  }

  it('the next sync tells the logger and the answerer once ("Closed · inactive"); a backlog close is never told', async () => {
    const r = await answered();
    backdate(r.id, INACTIVE_MINUTES + 1);
    expect(closeInactive([r.id])).toBe(1);
    expect(psql(`select notified_at is null from public.lp_inactive_closes where request_id = ${lit(r.id)}`)).toBe('t');
    const cookie = await cookieFor(newStaff());
    const res = await api(`/api/sync?ids=${r.id}`, { cookie });
    // A fresh close is not quiet: phones raise their in-app alert for it as for any status change.
    expect(res.body.rows[0]).toMatchObject({ status: STATUS.inactive, quietClose: false });
    const told = await eventually(() => activityOf(FOH, r.id).then((a) => a?.kind === 'closed_inactive' && a));
    expect(told).toMatchObject({ detail: 'Closed · inactive', actor: SYSTEM_STAFF });
    expect(await eventually(() => activityOf(MEDIC, r.id).then((a) => a?.kind === 'closed_inactive' && a))).toMatchObject({ detail: 'Closed · inactive' });
    expect(psql(`select notified_at is not null from public.lp_inactive_closes where request_id = ${lit(r.id)}`)).toBe('t');
    // Once: more syncs from more phones never tell it again.
    await api(`/api/sync?ids=${r.id}`, { cookie: await cookieFor(FOH) });
    await api(`/api/sync?ids=${r.id}`, { cookie });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect((await activityOf(FOH, r.id))?.at).toBe(told.at);

    // A close long past the limit (the first run after the migration, a paused job) is closed quietly.
    const backlog = await answered();
    backdate(backlog.id, 3 * INACTIVE_MINUTES);
    expect(closeInactive([backlog.id])).toBe(1);
    expect(psql(`select (notified_at is not null) || '|' || quiet from public.lp_inactive_closes where request_id = ${lit(backlog.id)}`)).toBe('true|true');
    expect(psql(`select quiet from public.lp_inactive_closes where request_id = ${lit(r.id)}`)).toBe('f');
    // Regression (review): the row says it is quiet, so no phone raises an in-app alert for it either.
    const quiet = await api(`/api/sync?ids=${backlog.id}`, { cookie });
    expect(quiet.body.rows[0]).toMatchObject({ status: STATUS.inactive, quietClose: true });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect((await activityOf(FOH, backlog.id))?.kind).not.toBe('closed_inactive');
    // Reopened, it is an ordinary row again; a later close of it after a normal idle hour is told.
    const closedRow = await dbRow(backlog.id);
    const reopened = await setStatus({ id: backlog.id, rowVersion: closedRow.row_version }, IN_MEDICAL, 'reopen', FOH);
    expect(reopened.status, reopened.text).toBe(200);
    expect(reopened.body.request).toMatchObject({ status: IN_MEDICAL, quietClose: false });
    backdate(backlog.id, INACTIVE_MINUTES + 1);
    expect(closeInactive([backlog.id])).toBe(1);
    expect((await api(`/api/sync?ids=${backlog.id}`, { cookie })).body.rows[0]).toMatchObject({ status: STATUS.inactive, quietClose: false });
    await eventually(() => activityOf(FOH, backlog.id).then((a) => a?.kind === 'closed_inactive' && a));
  });

  it('lp_inactive_claim: a close is claimed once, only while it is still Closed · inactive (rolled back)', async () => {
    const a = await answered();
    const b = await answered();
    backdate(a.id, INACTIVE_MINUTES + 1);
    backdate(b.id, INACTIVE_MINUTES + 1);
    const out = psqlScript(`begin;
select public.lp_inactive_claim(${lit(EVENT_ID)}, null)::text;
select public.lp_inactive_claim(${lit(EVENT_ID)}, '{}'::uuid[])::text;
select public.lp_close_inactive(${uuidArray([a.id, b.id])});
update public.patients set status = 'Found – Awaiting Reunion', closed_at = null where id = ${lit(b.id)};
select public.lp_inactive_claim(${lit(EVENT_ID)}, ${uuidArray([a.id, b.id])})::text;
select public.lp_inactive_claim(${lit(EVENT_ID)}, ${uuidArray([a.id, b.id])})::text;
rollback;`).split('\n');
    expect(out).toEqual(['[]', '[]', '2', `["${a.id}"]`, '[]']);
  });
});
