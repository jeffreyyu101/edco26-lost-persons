// Where medical has the patient (Pending v8, 2026-11-06 afternoon) through the real store: the location
// PATCH queues behind the In medical tap that opened the sheet and goes out with the version current when it
// runs, the overlay shows it at once, a 409 is resent once on the latest version, the status Undo still on
// screen keeps working (a location is not a status), and offline it needs a connection. Synthetic data.
import { describe, expect, it } from 'vitest';
import { COPY } from '@/lib/client/store-core';
import { applyOverlay } from '@/lib/client/selectors';
import { STATUS } from '@/lib/domain';
import { advance } from './helpers/env';
import { boot, finish, gate, installStoreHooks, ready } from './helpers/boot';
import { FakeServer, makeRow } from './helpers/fake-server';

installStoreHooks();

const R1 = makeRow(1);
const shown = (s: ReturnType<ReturnType<typeof boot>['s']>, id: string) => {
  const row = s.confirmed.get(id);
  return row ? applyOverlay(row, s.pending.get(id)) : null;
};
const patches = (server: FakeServer) => server.requests('PATCH', '/api/requests/');

describe('setMedicalLocation', () => {
  it('right after In medical: waits for the answer, sends the version it returned, shows the location at once', async () => {
    const server = new FakeServer([R1]);
    const { a, s } = boot(server);
    await ready();
    const g = gate();
    server.override = (req) => (req.path.endsWith('/status') ? g.wait() : undefined);
    const answer = a.setStatus(R1.id, STATUS.inMedical, 'answer');
    await advance(0);
    // Saved from the sheet while the answer is still on its way.
    const located = a.setMedicalLocation(R1.id, '  Chair 14 ');
    await advance(0);
    expect(patches(server)).toHaveLength(0);
    g.open();
    server.override = null;
    expect(await finish(answer)).toMatchObject({ ok: true, changed: true });
    expect(shown(s(), R1.id)?.medicalLocation).toBe('Chair 14');
    expect(await finish(located)).toMatchObject({ ok: true, changed: true });
    expect(patches(server).map((r) => r.body)).toEqual([{ patch: { medicalLocation: 'Chair 14' }, expectedVersion: 2 }]);
    expect(s().confirmed.get(R1.id)).toMatchObject({ status: STATUS.inMedical, medicalLocation: 'Chair 14', rowVersion: 3 });
    expect(s().pending.size).toBe(0);
  });

  it('the In medical Undo stays and still works after the location is saved; the location stays too', async () => {
    const server = new FakeServer([R1]);
    const { a, s } = boot(server);
    await ready();
    await finish(a.setStatus(R1.id, STATUS.inMedical, 'answer'));
    const snack = s().snackbar;
    expect(snack?.message).toBe('LP-1001 · In medical');
    await finish(a.setMedicalLocation(R1.id, 'Bed 3 · triage'));
    expect(s().snackbar?.id).toBe(snack?.id);
    const undone = await finish(a.undo(snack?.id ?? ''));
    expect(undone).toMatchObject({ ok: true, changed: true });
    const posts = server.requests('POST', '/api/requests/').filter((r) => r.path.endsWith('/status'));
    expect(posts.at(-1)?.body).toEqual({ status: STATUS.waiting, expectedVersion: 3, kind: 'undo' });
    expect(s().confirmed.get(R1.id)).toMatchObject({ status: STATUS.waiting, medicalLocation: 'Bed 3 · triage' });
    expect(s().toasts.map((t) => t.title)).not.toContain(COPY.undoStale);
  });

  it('someone else saved in between (409): resent once on the latest version', async () => {
    const server = new FakeServer([{ ...R1, status: STATUS.inMedical }]);
    const { a, s } = boot(server);
    await ready();
    server.change(R1.id, { clothing: 'Changed elsewhere' });
    const res = await finish(a.setMedicalLocation(R1.id, 'Chair 9'));
    expect(res).toMatchObject({ ok: true, changed: true });
    expect(patches(server).map((r) => (r.body as { expectedVersion: number }).expectedVersion)).toEqual([1, 2]);
    expect(s().confirmed.get(R1.id)).toMatchObject({ medicalLocation: 'Chair 9', clothing: 'Changed elsewhere' });
    expect(s().toasts.map((t) => t.title)).not.toContain(COPY.conflict);
  });

  it('the same value sends nothing; a blank clears it (null)', async () => {
    const server = new FakeServer([{ ...R1, status: STATUS.inMedical, medicalLocation: 'Chair 2' }]);
    const { a, s } = boot(server);
    await ready();
    expect(await finish(a.setMedicalLocation(R1.id, ' Chair 2 '))).toMatchObject({ ok: true, changed: false });
    expect(patches(server)).toHaveLength(0);
    await finish(a.setMedicalLocation(R1.id, '   '));
    expect(patches(server).map((r) => r.body)).toEqual([{ patch: { medicalLocation: null }, expectedVersion: 1 }]);
    expect(s().confirmed.get(R1.id)?.medicalLocation).toBeNull();
  });

  it('a row cached before the field existed (no medicalLocation key) takes a location', async () => {
    const legacy = { ...R1, status: STATUS.inMedical } as Record<string, unknown>;
    delete legacy.medicalLocation;
    const server = new FakeServer([legacy as unknown as typeof R1]);
    const { a, s } = boot(server);
    await ready();
    expect(s().confirmed.get(R1.id)?.medicalLocation).toBeUndefined();
    expect(await finish(a.setMedicalLocation(R1.id, 'Chair 1'))).toMatchObject({ ok: true, changed: true });
    expect(s().confirmed.get(R1.id)?.medicalLocation).toBe('Chair 1');
  });

  it('offline: refused with "Needs a connection", nothing sent', async () => {
    const server = new FakeServer([{ ...R1, status: STATUS.inMedical }]);
    const { a, fe, s } = boot(server);
    await ready();
    fe.setOnline(false);
    fe.fire('window', 'offline');
    expect(await finish(a.setMedicalLocation(R1.id, 'Chair 1'))).toMatchObject({ ok: false, reason: 'offline' });
    expect(patches(server)).toHaveLength(0);
    expect(s().toasts.map((t) => t.title)).toContain(COPY.needsConnection);
  });
});
