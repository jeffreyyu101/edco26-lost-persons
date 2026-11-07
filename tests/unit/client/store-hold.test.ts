// F5: the "Not found yet" hold through the real store (spec §18 A56): the first Not found's overlay keeps the
// status and goes on hold at once, its Undo bar names the recheck time, a double tap stays one answer, a
// deliberate second Not found is final, and A12's 409 resend never turns someone else's hold into a final answer.
// The fake server answers a first Not found as lp_set_status does (status stays Added). Synthetic data only.
import { describe, expect, it } from 'vitest';
import { RECHECK_MINUTES, STATUS } from '@/lib/domain';
import { applyOverlay } from '@/lib/client/selectors';
import { advance } from './helpers/env';
import { boot, finish, gate, installStoreHooks, ready } from './helpers/boot';
import { FakeServer, apiError, json, makeRow, type FakeRequest } from './helpers/fake-server';

installStoreHooks();

const R1 = makeRow(1);
const statusPosts = (server: FakeServer) => server.requests('POST', '/api/requests/').filter((r) => r.path.endsWith('/status'));

/** lp_set_status's hold: a first Not found on a request Waiting for check that was never held. */
function holdingServer(server: FakeServer, wait?: () => Promise<undefined>) {
  server.override = async (req: FakeRequest) => {
    if (!req.path.endsWith('/status')) return undefined;
    if (wait) await wait();
    const id = req.path.split('/')[3] as string;
    const cur = server.row(id);
    const { status, expectedVersion, kind } = req.body as { status: string; expectedVersion: number; kind: string };
    if (status !== STATUS.notInMedical || cur.status !== STATUS.waiting || (cur.notFoundChecks ?? 0) !== 0 || kind === 'undo') return undefined;
    if (expectedVersion !== cur.rowVersion) return apiError(409, 'conflict', 'Updated by someone else', { currentStatus: cur.status });
    const row = server.change(id, { recheckAt: new Date(Date.now() + RECHECK_MINUTES * 60_000).toISOString(), notFoundChecks: 1 });
    return json(200, { changed: true, request: row });
  };
}

describe('the hold in the store', () => {
  it('the first Not found keeps Waiting for check and goes on hold at once; the Undo bar reads "Not found yet · recheck in 20 min"', async () => {
    const server = new FakeServer([R1]);
    const { a, s } = boot(server);
    await ready();
    const g = gate();
    holdingServer(server, g.wait);
    const p = a.setStatus(R1.id, STATUS.notInMedical, 'answer');
    await advance(0);
    const shown = applyOverlay(s().confirmed.get(R1.id)!, s().pending.get(R1.id));
    expect(shown.status).toBe(STATUS.waiting);
    expect(shown.notFoundChecks).toBe(1);
    expect(shown.recheckAt).not.toBeNull();
    g.open();
    expect(await finish(p)).toMatchObject({ ok: true, changed: true });
    expect(s().confirmed.get(R1.id)).toMatchObject({ status: STATUS.waiting, notFoundChecks: 1 });
    expect(s().snackbar?.message).toBe(`Not found yet · recheck in ${RECHECK_MINUTES} min`);
    expect(s().snackbar?.said).toBe(`Not found yet, recheck in ${RECHECK_MINUTES} minutes.`);
    // Undo: back to Waiting for check, kind undo, as before.
    await finish(a.undo(s().snackbar!.id));
    expect(statusPosts(server).at(-1)?.body).toEqual({ status: STATUS.waiting, expectedVersion: 2, kind: 'undo' });
  });

  it('a double tap is one answer: the second is satisfied by the first, never sent as the final one', async () => {
    const server = new FakeServer([R1]);
    const { a, s } = boot(server);
    await ready();
    holdingServer(server);
    const first = a.setStatus(R1.id, STATUS.notInMedical, 'answer');
    const second = a.setStatus(R1.id, STATUS.notInMedical, 'answer');
    expect(await finish(first)).toMatchObject({ ok: true, changed: true });
    expect(await finish(second)).toMatchObject({ ok: true, changed: false });
    expect(statusPosts(server)).toHaveLength(1);
    expect(s().confirmed.get(R1.id)).toMatchObject({ status: STATUS.waiting, notFoundChecks: 1 });
  });

  it('a Not found on a request already on hold is the final answer', async () => {
    const server = new FakeServer([R1]);
    const { a, s } = boot(server);
    await ready();
    holdingServer(server);
    await finish(a.setStatus(R1.id, STATUS.notInMedical, 'answer'));
    expect(await finish(a.setStatus(R1.id, STATUS.notInMedical, 'answer'))).toMatchObject({ ok: true, changed: true });
    expect(statusPosts(server)).toHaveLength(2);
    expect(s().confirmed.get(R1.id)?.status).toBe(STATUS.notInMedical);
  });

  it("A12's resend is skipped when someone else put it on hold meanwhile: a conflict, not a final answer", async () => {
    const server = new FakeServer([R1]);
    const { a, s } = boot(server);
    await ready();
    holdingServer(server);
    // Another liaison's first Not found, not synced here yet.
    server.change(R1.id, { recheckAt: new Date(Date.now() + RECHECK_MINUTES * 60_000).toISOString(), notFoundChecks: 1 });
    const res = await finish(a.setStatus(R1.id, STATUS.notInMedical, 'answer'));
    expect(res).toMatchObject({ ok: false, reason: 'conflict' });
    expect(statusPosts(server)).toHaveLength(1);
    expect(s().confirmed.get(R1.id)).toMatchObject({ status: STATUS.waiting, notFoundChecks: 1 });
  });

  it('In medical on a request someone else held meanwhile is still resent once (it is right either way)', async () => {
    const server = new FakeServer([R1]);
    const { a, s } = boot(server);
    await ready();
    holdingServer(server);
    server.change(R1.id, { recheckAt: new Date(Date.now() + RECHECK_MINUTES * 60_000).toISOString(), notFoundChecks: 1 });
    expect(await finish(a.setStatus(R1.id, STATUS.inMedical, 'answer'))).toMatchObject({ ok: true, changed: true });
    expect(statusPosts(server)).toHaveLength(2);
    expect(s().confirmed.get(R1.id)?.status).toBe(STATUS.inMedical);
  });
});
