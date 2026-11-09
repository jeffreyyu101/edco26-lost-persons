// (Companion, 2026-11-08) The friend swap and the companion states through the real store against the fake API, the
// pure swap rules, the status meta / stages, Pending's swap group, the alerts and the pushed kinds, and the intake
// field in the create body. Synthetic data only.
import { describe, expect, it } from 'vitest';
import { UNDO_MS } from '@/lib/client/constants';
import { ACCOMPANIED_SUBTITLE, diffAlerts, statusAlert, swapAlert, type AlertContext } from '@/lib/client/alerts';
import { PUSHED_ALERT_KINDS } from '@/lib/client/push-client';
import { EMPTY_FORM_VALUES, formValuesFromCreateBody, toCreateBody } from '@/lib/client/form-values';
import { pendingGroups, viewCounts } from '@/lib/client/selectors';
import { COPY } from '@/lib/client/store-core';
import { friendMayBeWith, isSwapApproved, isSwapRequested, swapCancelState, swapDisplay, swapOverlayFields, swapPlaceLabel, swapToastTitle } from '@/lib/client/swap';
import { STATUS, STATUS_META, SETTABLE_STATUSES, canTransition, statusMeta } from '@/lib/domain';
import { displayStage } from '@/lib/stages';
import { advance } from './helpers/env';
import { boot, finish, installStoreHooks, ready } from './helpers/boot';
import { FakeServer, STAFF, makeRow } from './helpers/fake-server';

const FA4 = 'FA 4 – Oasis';

describe('status meta (companion)', () => {
  it('Accompanied: amber users, open; Friend informed: grey users, closed; both settable', () => {
    expect(STATUS_META[STATUS.accompanied]).toEqual({ label: 'Located · already accompanied', shortLabel: 'Accompanied', tone: 'amber', glyph: 'accompanied', bucket: 'open' });
    expect(STATUS_META[STATUS.friendInformed]).toMatchObject({ label: 'Friend informed', tone: 'gray', glyph: 'friendInformed', bucket: 'closed' });
    expect(SETTABLE_STATUSES).toContain(STATUS.accompanied);
    expect(SETTABLE_STATUSES).toContain(STATUS.friendInformed);
    expect(statusMeta('Found – Accompanied').shortLabel).toBe('Accompanied');
  });

  it('transitions: answer Accompanied, Friend informed and its Undo, Change answer back', () => {
    expect(canTransition(STATUS.waiting, STATUS.accompanied)).toBe(true);
    expect(canTransition(STATUS.accompanied, STATUS.friendInformed)).toBe(true);
    expect(canTransition(STATUS.friendInformed, STATUS.accompanied)).toBe(true);
    for (const to of [STATUS.inMedical, STATUS.notInMedical, STATUS.waiting, STATUS.discharged]) expect(canTransition(STATUS.accompanied, to), to).toBe(true);
  });

  it('stages: accompanied amber, swap requested blue, swap approved green with the place, friend informed grey', () => {
    const at = { createdAt: '2026-11-08T20:00:00Z' };
    expect(displayStage({ ...at, status: STATUS.accompanied }, { now: 0 })).toMatchObject({ key: 'accompanied', tone: 'amber', fullLabel: 'Located · already accompanied' });
    expect(displayStage({ ...at, status: STATUS.accompanied, swapRequestedAt: '2026-11-08T20:10:00Z' }, { now: 0 })).toMatchObject({ key: 'swapRequested', tone: 'blue', label: 'Friend swap requested', glyph: 'swapBlue' });
    expect(displayStage({ ...at, status: STATUS.inMedical, swapPlace: 'mm' }, { now: 0 })).toMatchObject({ key: 'swapApproved', tone: 'green', label: 'Swap at Main Med' });
    expect(displayStage({ ...at, status: STATUS.inMedical, swapPlace: 'fa', postShort: 'FA 4' }, { now: 0 })).toMatchObject({ key: 'swapApproved', label: 'Swap at FA 4' });
    expect(displayStage({ ...at, status: STATUS.friendInformed }, { now: 0 })).toMatchObject({ key: 'friendInformed', tone: 'gray', bucket: 'closed' });
  });
});

describe('swap rules (lib/client/swap.ts)', () => {
  const row = makeRow(1, { status: STATUS.accompanied, reportingLocation: FA4, postShort: 'FA 4' });

  it('requested / approved / labels', () => {
    expect(isSwapRequested(row)).toBe(false);
    expect(isSwapRequested({ ...row, swapRequestedAt: '2026-11-08T20:10:00Z' })).toBe(true);
    expect(isSwapApproved({ ...row, status: STATUS.inMedical, swapPlace: 'fa' })).toBe(true);
    expect(isSwapApproved({ ...row, status: STATUS.inMedical, swapPlace: null })).toBe(false);
    expect(swapPlaceLabel('fa', row)).toBe('FA 4');
    expect(swapPlaceLabel('mm', row)).toBe('Main Med');
    expect(swapPlaceLabel('fa', { reportingLocation: 'Other', otherLocation: 'Command', postShort: '' })).toBe('Command');
    expect(swapDisplay({ ...row, swapRequestedAt: 'x' })).toEqual({ label: 'Friend swap requested', tone: 'blue' });
    expect(swapDisplay({ ...row, status: STATUS.inMedical, swapPlace: 'mm' })).toEqual({ label: 'Swap at Main Med', tone: 'green' });
  });

  it('overlays and toast titles', () => {
    expect(swapOverlayFields({ action: 'request' }, 'Rae · Medical', 'T')).toEqual({ swapRequestedAt: 'T', swapRequestedBy: 'Rae · Medical' });
    expect(swapOverlayFields({ action: 'approve', place: 'mm' }, null, 'T')).toEqual({ status: STATUS.inMedical, swapPlace: 'mm', swapRequestedAt: null, swapRequestedBy: null });
    expect(swapOverlayFields({ action: 'decline' }, null, 'T')).toEqual({ swapRequestedAt: null, swapRequestedBy: null });
    expect(swapToastTitle({ action: 'approve', place: 'fa' }, row)).toBe('LP-1001 · Swap at FA 4');
    expect(swapToastTitle({ action: 'decline' }, row)).toBe('LP-1001 · Swap declined');
  });

  it('the intake row shows only while Waiting with Yes', () => {
    expect(friendMayBeWith({ status: STATUS.waiting, friendInMedical: 'yes', friendInMedicalName: ' Alex ' })).toEqual({ name: 'Alex' });
    expect(friendMayBeWith({ status: STATUS.waiting, friendInMedical: 'unsure', friendInMedicalName: null })).toBeNull();
    expect(friendMayBeWith({ status: STATUS.accompanied, friendInMedical: 'yes', friendInMedicalName: 'Alex' })).toBeNull();
  });
});

describe('Pending (companion)', () => {
  it('Friend swap requested is its own group (counted); Accompanied without one is not on Pending', () => {
    const rows = [
      makeRow(1, { status: STATUS.accompanied }),
      makeRow(2, { status: STATUS.accompanied, swapRequestedAt: '2026-11-08T20:10:00Z' }),
      makeRow(3, { status: STATUS.waiting }),
    ];
    const g = pendingGroups(rows);
    expect(g.swapRequested.map((r) => r.caseNumber)).toEqual([1002]);
    expect(g.waiting.map((r) => r.caseNumber)).toEqual([1003]);
    expect(g.friendComing).toHaveLength(0);
    expect(viewCounts(rows, [], new Set(), null).pending).toBe(2);
  });
});

describe('create body (intake)', () => {
  const base = { ...EMPTY_FORM_VALUES, name: 'Ava Lin', reportingLocation: FA4 as never };
  it('Not sure sends nothing (server default); Yes sends the name; No sends no name', () => {
    expect(toCreateBody(base, 'm1')).not.toHaveProperty('friendInMedical');
    expect(toCreateBody({ ...base, friendInMedical: 'yes', friendInMedicalName: '  Alex  ' }, 'm1')).toMatchObject({ friendInMedical: 'yes', friendInMedicalName: 'Alex' });
    const no = toCreateBody({ ...base, friendInMedical: 'no', friendInMedicalName: 'Alex' }, 'm1');
    expect(no.friendInMedical).toBe('no');
    expect(no).not.toHaveProperty('friendInMedicalName');
    expect(formValuesFromCreateBody(toCreateBody({ ...base, friendInMedical: 'yes', friendInMedicalName: 'Alex' }, 'm1'))).toMatchObject({ friendInMedical: 'yes', friendInMedicalName: 'Alex' });
  });
});

describe('alerts (companion)', () => {
  const ctx = (staff: string): AlertContext => ({ sessionStaff: staff, myIds: new Set(), ownMutationIds: new Set(), ownKeys: new Set(), bell: false, seen: new Set() });

  it('statusAlert: Accompanied, Friend informed, Swap approved', () => {
    const r = makeRow(1, { status: STATUS.accompanied, name: '' });
    expect(statusAlert(r)).toMatchObject({ kind: 'accompanied', title: 'LP-1001 · Located · already accompanied', subtitle: ACCOMPANIED_SUBTITLE });
    expect(statusAlert({ ...r, status: STATUS.friendInformed })).toMatchObject({ kind: 'friend_informed', title: 'LP-1001 · Friend informed' });
    expect(statusAlert({ ...r, status: STATUS.inMedical, swapPlace: 'mm' })).toMatchObject({ kind: 'swap_approved', title: 'LP-1001 · Swap at Main Med' });
  });

  it('swapAlert: opened and declined requests; diffAlerts tells the involved answerer', () => {
    const before = makeRow(1, { status: STATUS.accompanied, name: '', postShort: 'FA 4', rowVersion: 2 });
    const asked = { ...before, swapRequestedAt: '2026-11-08T20:10:00Z', rowVersion: 3, updatedBy: STAFF.rae.staff, involved: true };
    expect(swapAlert(before, asked)).toMatchObject({ kind: 'swap_requested', title: 'LP-1001 · Friend swap requested', subtitle: 'FA 4 · decide where' });
    expect(swapAlert(asked, { ...asked, swapRequestedAt: null })).toMatchObject({ kind: 'swap_declined' });
    const out = diffAlerts(new Map([[before.id, before]]), [asked], ctx('Someone Else · GC/HX - Dispatch'));
    expect(out.map((a) => a.kind)).toEqual(['swap_requested']);
  });

  it('the server pushes every companion kind', () => {
    for (const k of ['accompanied', 'swap_requested', 'swap_approved', 'swap_declined', 'swap_cancelled', 'friend_informed'] as const) expect(PUSHED_ALERT_KINDS.has(k), k).toBe(true);
  });

  it('swapAlert: a request cancelled by its requester, an approved swap cancelled', () => {
    const asked = makeRow(1, { status: STATUS.accompanied, name: '', rowVersion: 3, swapRequestedAt: '2026-11-08T20:10:00Z', swapRequestedBy: STAFF.rae.staff });
    expect(swapAlert(asked, { ...asked, swapRequestedAt: null, swapRequestedBy: null, updatedBy: STAFF.rae.staff, rowVersion: 4 })).toMatchObject({ kind: 'swap_cancelled', title: 'LP-1001 · Swap request cancelled' });
    const approved = makeRow(1, { status: STATUS.inMedical, name: '', rowVersion: 5, swapPlace: 'mm' });
    expect(swapAlert(approved, { ...approved, status: STATUS.accompanied, swapPlace: null, rowVersion: 6 })).toMatchObject({ kind: 'swap_cancelled', title: 'LP-1001 · Swap cancelled' });
  });
});

describe('store.swap (the real store)', () => {
  installStoreHooks();
  const swapPosts = (server: FakeServer) => server.requests('POST', '/api/requests/').filter((r) => r.path.endsWith('/swap')).map((r) => r.body);

  it('request: POST /swap {action: request} with the version, overlay, then Undo = withdraw', async () => {
    const row = makeRow(1, { status: STATUS.accompanied, rowVersion: 3 });
    const server = new FakeServer([row]);
    const { a, s } = boot(server);
    await ready();
    const res = await finish(a.swap(row.id, { action: 'request' }));
    expect(res).toMatchObject({ ok: true, changed: true });
    expect(swapPosts(server)).toEqual([{ action: 'request', expectedVersion: 3 }]);
    expect(s().confirmed.get(row.id)?.swapRequestedAt).toBeTruthy();
    expect(s().snackbar?.message).toBe('LP-1001 · Friend swap requested');
    await finish(a.undo(s().snackbar?.id ?? ''));
    await advance(0);
    expect(swapPosts(server).at(-1)).toEqual({ action: 'withdraw', expectedVersion: 4 });
    expect(s().confirmed.get(row.id)?.swapRequestedAt ?? null).toBeNull();
  });

  it('approve at Main Med → In medical with swapPlace; decline returns to Accompanied', async () => {
    const asked = makeRow(1, { status: STATUS.accompanied, rowVersion: 5, swapRequestedAt: '2026-11-08T20:10:00Z', swapRequestedBy: STAFF.rae.staff });
    const other = makeRow(2, { status: STATUS.accompanied, rowVersion: 2, swapRequestedAt: '2026-11-08T20:11:00Z', swapRequestedBy: STAFF.rae.staff });
    const server = new FakeServer([asked, other]);
    const { a, s } = boot(server);
    await ready();
    await finish(a.swap(asked.id, { action: 'approve', place: 'mm' }));
    expect(s().confirmed.get(asked.id)).toMatchObject({ status: STATUS.inMedical, swapPlace: 'mm', swapRequestedAt: null });
    expect(s().toasts.map((t) => t.title)).toContain('LP-1001 · Swap at Main Med');
    await finish(a.swap(other.id, { action: 'decline' }));
    expect(s().confirmed.get(other.id)).toMatchObject({ status: STATUS.accompanied, swapRequestedAt: null });
    expect(swapPosts(server)).toEqual([
      { action: 'approve', place: 'mm', expectedVersion: 5 },
      { action: 'decline', expectedVersion: 2 },
    ]);
  });

  it('cancel from requested: stays Accompanied, request cleared; Undo = request again', async () => {
    const asked = makeRow(1, { status: STATUS.accompanied, rowVersion: 5, swapRequestedAt: '2026-11-08T20:10:00Z', swapRequestedBy: STAFF.rae.staff });
    expect(swapCancelState(asked)).toBe('requested');
    const server = new FakeServer([asked]);
    const { a, s } = boot(server);
    await ready();
    await finish(a.swap(asked.id, { action: 'cancel' }));
    expect(s().confirmed.get(asked.id)).toMatchObject({ status: STATUS.accompanied, swapRequestedAt: null });
    expect(s().snackbar?.message).toBe('LP-1001 · Swap request cancelled');
    await finish(a.undo(s().snackbar?.id ?? ''));
    await advance(0);
    expect(swapPosts(server)).toEqual([{ action: 'cancel', expectedVersion: 5 }, { action: 'request', expectedVersion: 6 }]);
    expect(s().confirmed.get(asked.id)?.swapRequestedAt).toBeTruthy();
  });

  it('cancel from approved: back to Accompanied, swapPlace cleared; Undo = approve again at the same place', async () => {
    const approved = makeRow(1, { status: STATUS.inMedical, rowVersion: 7, swapPlace: 'fa' });
    expect(swapCancelState(approved)).toBe('approved');
    expect(swapOverlayFields({ action: 'cancel' }, null, 'x')).toEqual({ status: STATUS.accompanied, swapRequestedAt: null, swapRequestedBy: null, swapPlace: null });
    const server = new FakeServer([approved]);
    const { a, s } = boot(server);
    await ready();
    await finish(a.swap(approved.id, { action: 'cancel' }));
    expect(s().confirmed.get(approved.id)).toMatchObject({ status: STATUS.accompanied, swapPlace: null });
    expect(s().snackbar?.message).toBe('LP-1001 · Swap cancelled');
    await finish(a.undo(s().snackbar?.id ?? ''));
    await advance(0);
    expect(swapPosts(server).at(-1)).toEqual({ action: 'approve', place: 'fa', expectedVersion: 8 });
  });

  it('the "Friend swap requested" Undo closes when someone else answers the request', async () => {
    const row = makeRow(1, { status: STATUS.accompanied, rowVersion: 3 });
    const server = new FakeServer([row]);
    const { a, s } = boot(server);
    await ready();
    await finish(a.swap(row.id, { action: 'request' }));
    expect(s().snackbar?.message).toBe('LP-1001 · Friend swap requested');
    server.change(row.id, { swapRequestedAt: null, swapRequestedBy: null }, STAFF.rae.staff);
    await advance(7_000);
    expect(s().confirmed.get(row.id)?.swapRequestedAt ?? null).toBeNull();
    expect(s().snackbar).toBeNull();
  });

  it('Friend informed goes through setStatus (kind inform) with Undo', async () => {
    const row = makeRow(1, { status: STATUS.accompanied, rowVersion: 3 });
    const server = new FakeServer([row]);
    const { a, s } = boot(server);
    await ready();
    await finish(a.setStatus(row.id, STATUS.friendInformed, 'inform'));
    expect(server.requests('POST', '/api/requests/').at(-1)?.body).toEqual({ status: STATUS.friendInformed, expectedVersion: 3, kind: 'inform' });
    expect(s().confirmed.get(row.id)?.status).toBe(STATUS.friendInformed);
    expect(s().snackbar?.message).toBe('LP-1001 · Friend informed');
    await advance(UNDO_MS - 100);
    await finish(a.undo(s().snackbar?.id ?? ''));
    expect(s().confirmed.get(row.id)?.status).toBe(STATUS.accompanied);
  });

  it('offline: refused with "Needs a connection", nothing sent, nothing pretends to be saved', async () => {
    const row = makeRow(1, { status: STATUS.accompanied, rowVersion: 3 });
    const server = new FakeServer([row]);
    const { a, fe, s } = boot(server);
    await ready();
    fe.setOnline(false);
    fe.fire('window', 'offline');
    expect(await finish(a.swap(row.id, { action: 'request' }))).toMatchObject({ ok: false, reason: 'offline' });
    expect(await finish(a.setStatus(row.id, STATUS.friendInformed, 'inform'))).toMatchObject({ ok: false, reason: 'offline' });
    expect(swapPosts(server)).toHaveLength(0);
    expect(s().confirmed.get(row.id)?.status).toBe(STATUS.accompanied);
    expect(s().toasts.map((t) => t.title)).toContain(COPY.needsConnection);
  });
});
