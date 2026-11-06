// Mutations through the real store (spec §7 Mutations, A10–A12): optimistic overlays, per-id
// serialisation, monotonic responses, Undo (only when changed, reverse transition with the returned
// version, never retried), the A12 single resend on a 409, failures, edits and cancel.
import { describe, expect, it } from 'vitest';
import { COPY } from '@/lib/client/store-core';
import { applyOverlay } from '@/lib/client/selectors';
import { STATUS } from '@/lib/domain';
import { advance } from './helpers/env';
import { boot, finish, gate, installStoreHooks, photo, ready } from './helpers/boot';
import { FakeServer, STAFF, apiError, json, makeRow } from './helpers/fake-server';

installStoreHooks();

const R1 = makeRow(1);
const shown = (s: ReturnType<ReturnType<typeof boot>['s']>, id: string) => {
  const row = s.confirmed.get(id);
  return row ? applyOverlay(row, s.pending.get(id)) : null;
};
const statusPosts = (server: FakeServer) => server.requests('POST', '/api/requests/').filter((r) => r.path.endsWith('/status'));

describe('setStatus', () => {
  it('shows the overlay at once, then the server row replaces it in one update; Undo only when changed', async () => {
    const server = new FakeServer([R1]);
    const { a, s } = boot(server);
    await ready();
    const g = gate();
    server.override = (req) => (req.path.endsWith('/status') ? g.wait() : undefined);
    const p = a.setStatus(R1.id, STATUS.inMedical, 'answer');
    await advance(0);
    expect(shown(s(), R1.id)?.status).toBe(STATUS.inMedical);
    expect(s().confirmed.get(R1.id)?.status).toBe(STATUS.waiting);
    expect(statusPosts(server)[0]?.body).toEqual({ status: STATUS.inMedical, expectedVersion: 1, kind: 'answer' });
    g.open();
    const res = await finish(p);
    expect(res).toMatchObject({ ok: true, changed: true });
    expect(s().pending.size).toBe(0);
    expect(s().confirmed.get(R1.id)).toMatchObject({ status: STATUS.inMedical, rowVersion: 2 });
    expect(s().snackbar?.message).toBe('LP-1001 · In medical');
    await advance(6_000);
    expect(s().snackbar).toBeNull();
  });

  it('a repeat tap the server calls unchanged shows no Undo', async () => {
    const server = new FakeServer([R1]);
    const { a, s } = boot(server);
    await ready();
    server.change(R1.id, { status: STATUS.inMedical }); // another liaison answered the same
    server.override = (req) => (req.path.endsWith('/status') ? json(200, { changed: false, request: server.row(R1.id) }) : undefined);
    const res = await finish(a.setStatus(R1.id, STATUS.inMedical, 'answer'));
    expect(res).toMatchObject({ ok: true, changed: false });
    expect(s().snackbar).toBeNull();
    expect(s().confirmed.get(R1.id)?.status).toBe(STATUS.inMedical);
  });

  it('Undo sends the reverse transition with kind undo and the version the answer returned', async () => {
    const server = new FakeServer([R1]);
    const { a, s } = boot(server);
    await ready();
    await finish(a.setStatus(R1.id, STATUS.notInMedical, 'answer'));
    const snack = s().snackbar;
    expect(snack).not.toBeNull();
    const res = await finish(a.undo(snack?.id ?? ''));
    expect(res).toMatchObject({ ok: true, changed: true });
    expect(statusPosts(server).at(-1)?.body).toEqual({ status: STATUS.waiting, expectedVersion: 2, kind: 'undo' });
    expect(s().confirmed.get(R1.id)?.status).toBe(STATUS.waiting);
    expect(s().snackbar).toBeNull();
    expect(await a.undo(snack?.id ?? '')).toBeNull(); // used up
  });

  it('Undo is never retried after a 409', async () => {
    const server = new FakeServer([R1]);
    const { a, s } = boot(server);
    await ready();
    await finish(a.setStatus(R1.id, STATUS.inMedical, 'answer'));
    server.change(R1.id, { clothing: 'changed by Rae' });
    const res = await finish(a.undo(s().snackbar?.id ?? ''));
    expect(res).toMatchObject({ ok: false, reason: 'conflict' });
    expect(statusPosts(server)).toHaveLength(2);
    expect(s().pending.size).toBe(0);
    expect(s().toasts.map((t) => t.title)).toContain(COPY.conflict);
  });

  it('A12: a 409 where only fields changed resends once with the new version', async () => {
    const server = new FakeServer([R1]);
    const { a, s } = boot(server);
    await ready();
    server.change(R1.id, { clothing: 'Blue jacket' }); // version 2, still Waiting; not synced yet
    const res = await finish(a.setStatus(R1.id, STATUS.inMedical, 'answer'));
    expect(res).toMatchObject({ ok: true, changed: true });
    expect(statusPosts(server).map((r) => (r.body as { expectedVersion: number }).expectedVersion)).toEqual([1, 2]);
    expect(s().confirmed.get(R1.id)).toMatchObject({ status: STATUS.inMedical, clothing: 'Blue jacket', rowVersion: 3 });
    expect(s().toasts.map((t) => t.title)).not.toContain(COPY.conflict);
  });

  it('A12: a 409 where the status changed drops the overlay and says "Updated by someone else"', async () => {
    const server = new FakeServer([R1]);
    const { a, s } = boot(server);
    await ready();
    server.change(R1.id, { status: STATUS.inMedical });
    const res = await finish(a.setStatus(R1.id, STATUS.notInMedical, 'answer'));
    expect(res).toMatchObject({ ok: false, reason: 'conflict', latest: { status: STATUS.inMedical } });
    expect(statusPosts(server)).toHaveLength(1);
    expect(s().pending.size).toBe(0);
    expect(s().confirmed.get(R1.id)?.status).toBe(STATUS.inMedical);
    expect(s().toasts.map((t) => t.title)).toContain(COPY.conflict);
  });

  it('serialises taps per request: the second waits for the first and uses its version', async () => {
    const server = new FakeServer([R1, makeRow(2)]);
    const { a, s } = boot(server);
    await ready();
    const g = gate();
    let held = false;
    server.override = (req) => {
      if (req.path.endsWith('/status') && !held) {
        held = true;
        return g.wait();
      }
      return undefined;
    };
    const first = a.setStatus(R1.id, STATUS.inMedical, 'answer');
    const second = a.setStatus(R1.id, STATUS.reunited, 'reunite');
    const other = a.setStatus(makeRow(2).id, STATUS.notInMedical, 'answer');
    await advance(0);
    // The other request is not blocked by R1's queue.
    await finish(other);
    expect(statusPosts(server).filter((r) => r.path.includes(R1.id))).toHaveLength(1);
    g.open();
    await finish(first);
    await finish(second);
    const bodies = statusPosts(server)
      .filter((r) => r.path.includes(R1.id))
      .map((r) => r.body);
    expect(bodies).toEqual([
      { status: STATUS.inMedical, expectedVersion: 1, kind: 'answer' },
      { status: STATUS.reunited, expectedVersion: 2, kind: 'reunite' },
    ]);
    expect(s().confirmed.get(R1.id)?.status).toBe(STATUS.reunited);
  });

  it('a queued double tap already satisfied by the first sends nothing more', async () => {
    const server = new FakeServer([R1]);
    const { a } = boot(server);
    await ready();
    const [x, y] = await finish(Promise.all([a.setStatus(R1.id, STATUS.inMedical, 'answer'), a.setStatus(R1.id, STATUS.inMedical, 'answer')]));
    expect(x).toMatchObject({ ok: true, changed: true });
    expect(y).toMatchObject({ ok: true, changed: false });
    expect(statusPosts(server)).toHaveLength(1);
  });

  it('a timeout drops the overlay and says "Couldn\'t save — check signal and try again"', async () => {
    const server = new FakeServer([R1]);
    const { a, s } = boot(server);
    await ready();
    server.override = (req) => (req.path.endsWith('/status') ? 'hang' : undefined);
    const res = await finish(a.setStatus(R1.id, STATUS.inMedical, 'answer'), 10_000);
    expect(res).toMatchObject({ ok: false, reason: 'failed', message: COPY.failed });
    expect(s().pending.size).toBe(0);
    expect(shown(s(), R1.id)?.status).toBe(STATUS.waiting);
    expect(s().toasts.map((t) => t.title)).toContain(COPY.failed);
  });

  it('applies a response only if it is at least the confirmed version (A11)', async () => {
    const server = new FakeServer([R1]);
    const { a, s } = boot(server);
    await ready();
    const g = gate();
    server.override = (req) => (req.path.endsWith('/status') ? g.wait().then(() => json(200, { changed: true, request: { ...R1, status: STATUS.inMedical, rowVersion: 2 } })) : undefined);
    const p = a.setStatus(R1.id, STATUS.inMedical, 'answer');
    await advance(0);
    // Meanwhile a sync delivers version 3 (someone answered Not in medical after us).
    server.override = null;
    server.change(R1.id, { status: STATUS.inMedical });
    server.change(R1.id, { status: STATUS.notInMedical });
    server.override = (req) => (req.path.endsWith('/status') ? g.wait().then(() => json(200, { changed: true, request: { ...R1, status: STATUS.inMedical, rowVersion: 2 } })) : undefined);
    await advance(7_000);
    expect(s().confirmed.get(R1.id)?.rowVersion).toBe(3);
    g.open();
    await finish(p);
    expect(s().confirmed.get(R1.id)).toMatchObject({ rowVersion: 3, status: STATUS.notInMedical });
    expect(s().pending.size).toBe(0);
  });

  it('refuses while offline with "Needs a connection" (status changes are not queued in v1)', async () => {
    const server = new FakeServer([R1]);
    const { a, fe, s } = boot(server);
    await ready();
    fe.setOnline(false);
    fe.fire('window', 'offline');
    const res = await finish(a.setStatus(R1.id, STATUS.inMedical, 'answer'));
    expect(res).toMatchObject({ ok: false, reason: 'offline' });
    expect(statusPosts(server)).toHaveLength(0);
    expect(s().toasts.map((t) => t.title)).toContain(COPY.needsConnection);
  });

  it('maps 403 and 422 to forbidden / invalid without leaving the overlay', async () => {
    const server = new FakeServer([R1]);
    const { a, s } = boot(server);
    await ready();
    server.override = (req) => (req.path.endsWith('/status') ? apiError(403, 'forbidden', 'Creator only') : undefined);
    expect(await finish(a.setStatus(R1.id, STATUS.inMedical, 'answer'))).toMatchObject({ ok: false, reason: 'forbidden' });
    server.override = (req) => (req.path.endsWith('/status') ? apiError(422, 'invalid', 'Not allowed') : undefined);
    expect(await finish(a.setStatus(R1.id, STATUS.inMedical, 'answer'))).toMatchObject({ ok: false, reason: 'invalid' });
    expect(s().pending.size).toBe(0);
  });
});

describe('updateFields (A10)', () => {
  it('sends only the patch with the base version, overlays it, and confirms', async () => {
    const server = new FakeServer([R1]);
    const { a, s } = boot(server);
    await ready();
    const g = gate();
    server.override = (req) => (req.method === 'PATCH' ? g.wait() : undefined);
    const p = a.updateFields(R1.id, { clothing: 'Yellow raincoat', name: 'Tia  Rossi' }, 1);
    await advance(0);
    expect(shown(s(), R1.id)).toMatchObject({ clothing: 'Yellow raincoat', name: 'Tia Rossi', firstName: 'Tia', lastName: 'Rossi' });
    g.open();
    const res = await finish(p);
    expect(res).toMatchObject({ ok: true, changed: true });
    expect(server.requests('PATCH', '/api/requests/')[0]?.body).toEqual({ patch: { clothing: 'Yellow raincoat', name: 'Tia  Rossi' }, expectedVersion: 1 });
    expect(s().confirmed.get(R1.id)?.clothing).toBe('Yellow raincoat');
    expect(s().pending.size).toBe(0);
  });

  it('on a 409 returns the latest row for the conflict review, without a toast', async () => {
    const server = new FakeServer([R1]);
    const { a, s } = boot(server);
    await ready();
    server.change(R1.id, { clothing: 'Changed by Rae' });
    const res = await finish(a.updateFields(R1.id, { clothing: 'Mine' }, 1));
    expect(res).toMatchObject({ ok: false, reason: 'conflict', latest: { clothing: 'Changed by Rae', rowVersion: 2 } });
    expect(s().toasts.map((t) => t.title)).not.toContain(COPY.conflict);
    expect(s().pending.size).toBe(0);
  });
});

describe('cancel', () => {
  it('cancels with the confirmed version', async () => {
    const mine = makeRow(5, { createdBy: STAFF.dana.staff });
    const server = new FakeServer([mine]);
    const { a, s } = boot(server);
    await ready();
    const res = await finish(a.cancel(mine.id));
    expect(res).toMatchObject({ ok: true, changed: true });
    expect(server.requests('POST', `/api/requests/${mine.id}/cancel`)[0]?.body).toEqual({ expectedVersion: 1 });
    expect(s().confirmed.get(mine.id)?.status).toBe(STATUS.cancelled);
  });
});

describe('quiet mutations (the screen shows the failure itself)', () => {
  it('cancel, updateFields and addPhotos add no failure toast with { quiet: true }; the default still toasts', async () => {
    const mine = makeRow(6, { createdBy: STAFF.dana.staff });
    const server = new FakeServer([mine]);
    const { a, s } = boot(server);
    await ready();
    server.override = (req) => (req.path.includes('/api/requests/') && req.method !== 'GET' ? apiError(403, 'forbidden', 'Creator only') : undefined);
    expect(await finish(a.cancel(mine.id, { quiet: true }))).toMatchObject({ ok: false, reason: 'forbidden' });
    expect(await finish(a.updateFields(mine.id, { clothing: 'x' }, 1, { quiet: true }))).toMatchObject({ ok: false, reason: 'forbidden' });
    expect(await finish(a.addPhotos(mine.id, [photo('p0000000-0000-4000-8000-0000000000aa')], 'today', { quiet: true }))).toEqual({ added: 0, failed: 1 });
    expect(s().toasts).toHaveLength(0);
    expect(s().pending.size).toBe(0);
    expect(await finish(a.cancel(mine.id))).toMatchObject({ ok: false, reason: 'forbidden' });
    expect(s().toasts.map((t) => t.title)).toContain(COPY.forbidden);
  });

  it('a quiet refusal offline returns "offline" without the "Needs a connection" toast', async () => {
    const server = new FakeServer([R1]);
    const { a, fe, s } = boot(server);
    await ready();
    fe.setOnline(false);
    fe.fire('window', 'offline');
    expect(await finish(a.cancel(R1.id, { quiet: true }))).toMatchObject({ ok: false, reason: 'offline' });
    expect(s().toasts).toHaveLength(0);
  });
});

describe('Undo after this phone changes the same request again (regression)', () => {
  it('Mark discharged within the Undo window clears the In medical Undo; its id is used up', async () => {
    const server = new FakeServer([R1]);
    const { a, s } = boot(server);
    await ready();
    await finish(a.setStatus(R1.id, STATUS.inMedical, 'answer'));
    const snack = s().snackbar;
    expect(snack?.message).toBe('LP-1001 · In medical');
    await finish(a.setStatus(R1.id, STATUS.discharged, 'discharge'));
    expect(s().confirmed.get(R1.id)?.status).toBe(STATUS.discharged);
    expect(s().snackbar).toBeNull();
    expect(await a.undo(snack?.id ?? '')).toBeNull();
    expect(statusPosts(server).map((r) => (r.body as { kind: string }).kind)).toEqual(['answer', 'discharge']);
    expect(s().toasts.map((t) => t.title)).not.toContain(COPY.conflict);
  });

  it('an edit or a photo of the same request clears the Undo; another request keeps it', async () => {
    const R2 = makeRow(2);
    const server = new FakeServer([R1, R2]);
    const { a, s } = boot(server);
    await ready();
    await finish(a.setStatus(R1.id, STATUS.notInMedical, 'answer'));
    expect(s().snackbar).not.toBeNull();
    await finish(a.updateFields(R2.id, { clothing: 'Other row' }, 1));
    expect(s().snackbar).not.toBeNull();
    await finish(a.updateFields(R1.id, { clothing: 'Blue jacket' }, 2));
    expect(s().snackbar).toBeNull();

    await finish(a.setStatus(R1.id, STATUS.inMedical, 'change'));
    expect(s().snackbar?.message).toBe('LP-1001 · In medical');
    const photos = await finish(a.addPhotos(R1.id, [photo('e0000000-0000-4000-8000-0000000000b1')], 'today'));
    expect(photos).toEqual({ added: 1, failed: 0 });
    expect(s().snackbar).toBeNull();
  });

  it('cancel of the same request clears the Undo', async () => {
    const mine = makeRow(7, { createdBy: STAFF.dana.staff, status: STATUS.notInMedical });
    const server = new FakeServer([mine]);
    const { a, s } = boot(server);
    await ready();
    await finish(a.setStatus(mine.id, STATUS.inMedical, 'change'));
    expect(s().snackbar).not.toBeNull();
    // The real server only cancels from Waiting; the fake has no such check, which lets this test cover
    // the cancel path's commit on its own.
    await finish(a.cancel(mine.id));
    expect(s().confirmed.get(mine.id)?.status).toBe(STATUS.cancelled);
    expect(s().snackbar).toBeNull();
  });

  it('an Undo queued behind this phone’s own edit sends nothing and never says "someone else"', async () => {
    const server = new FakeServer([R1]);
    const { a, s } = boot(server);
    await ready();
    await finish(a.setStatus(R1.id, STATUS.inMedical, 'answer'));
    const snackId = s().snackbar?.id ?? '';
    const g = gate();
    server.override = (req) => (req.method === 'PATCH' ? g.wait() : undefined);
    const edit = a.updateFields(R1.id, { clothing: 'Green tee' }, 2);
    await advance(0);
    const undo = a.undo(snackId); // tapped while the edit is still in flight
    await advance(0);
    g.open();
    server.override = null;
    expect(await finish(edit)).toMatchObject({ ok: true, changed: true });
    expect(await finish(undo)).toMatchObject({ ok: false, reason: 'conflict', message: COPY.undoStale });
    expect(statusPosts(server)).toHaveLength(1);
    const titles = s().toasts.map((t) => t.title);
    expect(titles).toContain(COPY.undoStale);
    expect(titles).not.toContain(COPY.conflict);
    expect(s().confirmed.get(R1.id)?.status).toBe(STATUS.inMedical);
  });

  it('a 409 on Undo after the same staff changed it on another phone is not "Updated by someone else"', async () => {
    const server = new FakeServer([R1]);
    const { a, s } = boot(server);
    await ready();
    await finish(a.setStatus(R1.id, STATUS.inMedical, 'answer'));
    server.change(R1.id, { clothing: 'Edited on my other phone' }, STAFF.dana.staff);
    const res = await finish(a.undo(s().snackbar?.id ?? ''));
    expect(res).toMatchObject({ ok: false, reason: 'conflict', message: COPY.undoStale });
    expect(statusPosts(server)).toHaveLength(2); // sent once, never retried
    expect(s().toasts.map((t) => t.title)).toEqual([COPY.undoStale]);
  });
});
