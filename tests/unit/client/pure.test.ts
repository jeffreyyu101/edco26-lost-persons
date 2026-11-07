// Pure rules of the client core: merge, reconcile, overlays, alerts, image size steps, backoff, prompt,
// HTTP classification, the SW build id. Synthetic data only.
import { describe, expect, it, vi } from 'vitest';
import type { OutboxItem, RequestSummary } from '@/lib/api-types';
import { STATUS } from '@/lib/domain';
import { alertStillCurrent, alertToast, coalesceAlerts, diffAlerts, diffRaisedAlerts, latestPerRequest, type AlertContext } from '@/lib/client/alerts';
import { apiRequest, isDefinitive, isUncertain } from '@/lib/client/http';
import { MIN_FULL_EDGE, encodeWithinBudget, firstFullStep, fitSize, nextFullStep } from '@/lib/client/image';
import {
  CREATE_DEFINITIVE,
  PHOTO_DEFINITIVE,
  confirmedRowForJob,
  nextPollDelay,
  outboxBackoffMs,
  promptFor,
  syncBackoffMs,
} from '@/lib/client/outbox-logic';
import { buildIdFrom, scriptSrcsFromHtml } from '@/lib/client/sw-client';
import { mergeRows, normalizeRow, overlayForPatch, replaceAll, sameRow, staleIds, summaryOf } from '@/lib/client/sync-merge';
import { uuid } from '@/lib/client/uuid';
import { STAFF, json, makeRow, testId } from './helpers/fake-server';

const map = (...rows: RequestSummary[]) => new Map(rows.map((r) => [r.id, r]));

describe('monotonic merge (spec §7 Merge, A11)', () => {
  const a1 = makeRow(1, { rowVersion: 3 });

  it('replaces on a greater version and adds new rows', () => {
    const next = mergeRows(map(a1), [{ ...a1, rowVersion: 4, status: STATUS.inMedical }, makeRow(2)]);
    expect(next?.get(a1.id)?.status).toBe(STATUS.inMedical);
    expect(next?.size).toBe(2);
  });

  it('never goes back to an older version', () => {
    expect(mergeRows(map(a1), [{ ...a1, rowVersion: 2, status: STATUS.notInMedical }])).toBeNull();
  });

  it('keeps identity for an identical equal-version row (the 30 s overlap re-delivers rows)', () => {
    expect(mergeRows(map(a1), [{ ...a1 }])).toBeNull();
    const changed = mergeRows(map(a1), [{ ...a1, clothing: 'Blue' }]);
    expect(changed?.get(a1.id)?.clothing).toBe('Blue');
    expect(sameRow(a1, { ...a1 })).toBe(true);
  });

  it('full fetch replaces everything but keeps higher local versions and rows touched meanwhile', () => {
    const stale = makeRow(3, { rowVersion: 9 });
    const touched = makeRow(4);
    const gone = makeRow(5);
    const confirmed = map(a1, stale, touched, gone);
    const next = replaceAll(confirmed, [{ ...a1, rowVersion: 5 }, { ...stale, rowVersion: 7 }], new Set([touched.id]));
    expect(next.get(a1.id)?.rowVersion).toBe(5);
    expect(next.get(stale.id)?.rowVersion).toBe(9);
    expect(next.has(touched.id)).toBe(true);
    expect(next.has(gone.id)).toBe(false);
  });

  it('reconcile finds rows at a different version or missing', () => {
    const confirmed = map(a1, makeRow(2, { rowVersion: 1 }));
    expect(staleIds(confirmed, [[a1.id, 3], [testId(2), 2], [testId(7), 1]])).toEqual([testId(2), testId(7)]);
  });

  it('builds edit overlays the way the server normalises them', () => {
    const row = makeRow(1);
    expect(overlayForPatch(row, { name: '  Kayla   Martinez ', hair: '  ', reportingLocation: 'Other', otherLocation: ' Gate 2 ' })).toEqual({
      name: 'Kayla Martinez',
      firstName: 'Kayla',
      lastName: 'Martinez',
      hair: null,
      reportingLocation: 'Other',
      otherLocation: 'Gate 2',
      postShort: 'Gate 2',
    });
    // A PATCH queued by a client from before age became text: its text, as the server stores it.
    expect(overlayForPatch(row, { age: 30 })).toEqual({ age: '30' });
    expect(overlayForPatch(row, { age: ' mid-20s ' })).toEqual({ age: 'mid-20s' });
  });

  it('a row holding a numeric age (cached before age became text) is kept with its age as text', () => {
    const numeric = { ...a1, age: 24 as unknown as string };
    expect(normalizeRow(numeric)).toEqual({ ...a1, age: '24' });
    expect(normalizeRow(a1)).toBe(a1);
    // Loading the cache into an empty store, a delta sync, a full fetch: confirmed only ever holds text.
    expect(mergeRows(new Map(), [numeric])?.get(a1.id)?.age).toBe('24');
    expect(replaceAll(new Map(), [numeric], new Set()).get(a1.id)?.age).toBe('24');
    // Equal version, same content once normalised: identity kept (no needless re-render).
    const stored = map({ ...a1, age: '24' });
    expect(mergeRows(stored, [numeric])).toBeNull();
    expect(replaceAll(stored, [numeric], new Set()).get(a1.id)).toBe(stored.get(a1.id));
    // Not a finite number (a corrupted cache): no age rather than "NaN".
    expect(normalizeRow({ ...a1, age: Number.NaN as unknown as string }).age).toBeNull();
  });

  it('strips photos and audit from a detail', () => {
    const row = makeRow(1);
    expect(summaryOf({ ...row, photos: [], audit: [] })).toEqual(row);
  });
});

describe('alerts diff (spec §7 Alerts)', () => {
  const ctx = (patch: Partial<AlertContext> = {}): AlertContext => ({
    sessionStaff: STAFF.dana.staff,
    myIds: new Set(),
    ownMutationIds: new Set(),
    ownKeys: new Set(),
    bell: false,
    seen: new Set(),
    ...patch,
  });
  const mine = makeRow(4, { firstName: 'Sofia', lastName: 'Lopez', createdBy: STAFF.dana.staff, rowVersion: 2 });

  it('alerts a status change of my request made by someone else, with the spec copy', () => {
    const next = { ...mine, status: STATUS.inMedical, rowVersion: 3, updatedBy: STAFF.rae.staff };
    const alerts = diffAlerts(map(mine), [next], ctx());
    expect(alerts).toEqual([
      { kind: 'in_medical', requestId: mine.id, title: 'LP-1004 · S.L. is in medical', subtitle: 'Bring the friend to Main Med', count: 1 },
    ]);
    expect(diffAlerts(map(mine), [{ ...next, status: STATUS.notInMedical }], ctx())[0]?.title).toBe('LP-1004 · S.L. — not found in medical');
    expect(diffAlerts(map(mine), [{ ...next, status: STATUS.reunited }], ctx())[0]?.title).toBe('LP-1004 · S.L. reunited');
    expect(diffAlerts(map(mine), [{ ...next, status: STATUS.waiting, rowVersion: 3 }], ctx({}))).toEqual([]); // same status
    const back = diffAlerts(map({ ...mine, status: STATUS.inMedical }), [{ ...next, status: STATUS.waiting }], ctx());
    expect(back[0]).toMatchObject({ kind: 'status_changed', title: 'LP-1004 · S.L. — waiting for check' });
  });

  it('counts phone-created ids as mine (canonical created_by too, aliases included)', () => {
    const other = makeRow(9, { createdBy: STAFF.sam.staff, rowVersion: 1 });
    const next = { ...other, status: STATUS.notInMedical, rowVersion: 2, updatedBy: STAFF.rae.staff };
    expect(diffAlerts(map(other), [next], ctx())).toEqual([]);
    expect(diffAlerts(map(other), [next], ctx({ myIds: new Set([other.id]) }))).toHaveLength(1);
    const alias = { ...other, createdBy: 'dana  kim • dispatch' };
    expect(diffAlerts(map(alias), [{ ...next, createdBy: alias.createdBy }], ctx())).toHaveLength(1);
  });

  it('never alerts this phone’s own mutations or the same staff on another phone', () => {
    const next = { ...mine, status: STATUS.inMedical, rowVersion: 3, updatedBy: STAFF.rae.staff };
    expect(diffAlerts(map(mine), [next], ctx({ ownKeys: new Set([`${mine.id}:3`]) }))).toEqual([]);
    expect(diffAlerts(map(mine), [{ ...next, updatedBy: STAFF.dana.staff }], ctx())).toEqual([]);
  });

  it('deduplicates on (id, rowVersion) and ignores older versions', () => {
    const c = ctx();
    const next = { ...mine, status: STATUS.inMedical, rowVersion: 3, updatedBy: STAFF.rae.staff };
    expect(diffAlerts(map(mine), [next], c)).toHaveLength(1);
    expect(diffAlerts(map(mine), [next], c)).toHaveLength(0);
    expect(diffAlerts(map({ ...mine, rowVersion: 5 }), [next], ctx())).toEqual([]);
  });

  it('new requests by others alert only with the bell on; never my own creates', () => {
    const fresh = makeRow(13, { firstName: 'T.', lastName: 'R.', age: '24', gender: 'Male', createdBy: STAFF.sam.staff, caseNumber: 1013 });
    expect(diffAlerts(new Map(), [fresh], ctx())).toEqual([]);
    expect(diffAlerts(new Map(), [fresh], ctx({ bell: true }))).toEqual([
      { kind: 'new_request', requestId: fresh.id, title: 'New request · LP-1013', subtitle: 'T.R. 24 M · FA 4', count: 1 },
    ]);
    expect(diffAlerts(new Map(), [{ ...fresh, createdBy: STAFF.dana.staff }], ctx({ bell: true }))).toEqual([]);
    expect(diffAlerts(new Map(), [{ ...fresh, clientMutationId: 'abc' }], ctx({ bell: true, ownMutationIds: new Set(['abc']) }))).toEqual([]);
    expect(diffAlerts(new Map(), [{ ...fresh, status: STATUS.inMedical }], ctx({ bell: true }))).toEqual([]);
  });

  it('combines more than 2 alerts into one "N updates"', () => {
    const one = { kind: 'reunited' as const, title: 'x', count: 1 };
    expect(coalesceAlerts([one, one])).toHaveLength(2);
    expect(coalesceAlerts([one, one, one])).toEqual([{ kind: 'combined', title: '3 updates', count: 3 }]);
  });

  it('maps alerts to toasts (In medical stays until dismissed; View opens the profile)', () => {
    const view = vi.fn();
    const t = alertToast({ kind: 'in_medical', requestId: 'r1', title: 'a', subtitle: 'b', count: 1 }, view);
    expect(t).toMatchObject({ tone: 'green', icon: 'check', durationMs: null, title: 'a', subtitle: 'b' });
    t.action?.run();
    expect(view).toHaveBeenCalledWith('r1');
    expect(alertToast({ kind: 'combined', title: '3 updates', count: 3 }, view).action).toBeUndefined();
  });

  it('pairs each alert with the status that raised it; one alert per request, the latest wins', () => {
    const other = makeRow(5, { createdBy: STAFF.dana.staff, rowVersion: 1 });
    const raised = diffRaisedAlerts(
      map(mine, other),
      [
        { ...mine, status: STATUS.inMedical, rowVersion: 3, updatedBy: STAFF.rae.staff },
        { ...other, status: STATUS.inMedical, rowVersion: 2, updatedBy: STAFF.rae.staff },
      ],
      ctx(),
    );
    expect(raised.map((r) => [r.alert.kind, r.status])).toEqual([
      ['in_medical', STATUS.inMedical],
      ['in_medical', STATUS.inMedical],
    ]);
    const later = { alert: { kind: 'not_in_medical' as const, requestId: mine.id, title: 'x', count: 1 }, status: STATUS.notInMedical };
    const kept = latestPerRequest([...raised, later]);
    expect(kept.map((r) => [r.alert.requestId, r.alert.kind])).toEqual([
      [other.id, 'in_medical'],
      [mine.id, 'not_in_medical'],
    ]);
    const combined = { alert: { kind: 'combined' as const, title: '3 updates', count: 3 }, status: null };
    expect(latestPerRequest([combined, combined])).toHaveLength(2);
  });

  it('a status alert is current only while the row is still in that status (In medical incl. legacy)', () => {
    expect(alertStillCurrent('in_medical', STATUS.inMedical, { status: STATUS.inMedical })).toBe(true);
    expect(alertStillCurrent('in_medical', STATUS.inMedical, { status: STATUS.legacyBringFriend })).toBe(true);
    expect(alertStillCurrent('in_medical', STATUS.inMedical, { status: STATUS.notInMedical })).toBe(false);
    expect(alertStillCurrent('in_medical', STATUS.inMedical, { status: STATUS.waiting })).toBe(false);
    expect(alertStillCurrent('in_medical', STATUS.inMedical, { status: STATUS.reunited })).toBe(false);
    expect(alertStillCurrent('not_in_medical', STATUS.notInMedical, { status: STATUS.inMedical })).toBe(false);
    expect(alertStillCurrent('status_changed', STATUS.waiting, { status: STATUS.waiting })).toBe(true);
    expect(alertStillCurrent('new_request', STATUS.waiting, { status: STATUS.cancelled })).toBe(true);
    expect(alertStillCurrent('in_medical', STATUS.inMedical, undefined)).toBe(true);
  });
});

describe('image size steps (spec §7 Photos)', () => {
  it('fits the long edge without upscaling', () => {
    expect(fitSize(4032, 3024, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(fitSize(3024, 4032, 320)).toEqual({ width: 240, height: 320 });
    expect(fitSize(800, 600, 1600)).toEqual({ width: 800, height: 600 });
  });

  it('starts at 1600 px / 0.82, steps quality to 0.6, then shrinks the edge', () => {
    let step = firstFullStep(4032, 3024);
    expect(step).toEqual({ edge: 1600, quality: 0.82 });
    const big = 3_000_000;
    step = nextFullStep(step, big) ?? step;
    expect(step).toEqual({ edge: 1600, quality: 0.72 });
    step = nextFullStep(step, big) ?? step;
    expect(step).toEqual({ edge: 1600, quality: 0.6 });
    step = nextFullStep(step, big) ?? step;
    expect(step).toEqual({ edge: 1280, quality: 0.6 });
    expect(nextFullStep(step, 2_500_000)).toBeNull();
    expect(nextFullStep({ edge: MIN_FULL_EDGE, quality: 0.6 }, big)).toBeNull();
    expect(firstFullStep(800, 600)).toEqual({ edge: 800, quality: 0.82 });
  });

  it('encodes until the image is ≤ 2.5 MB', async () => {
    const calls: Array<[number, number, number]> = [];
    // A fake encoder: bytes grow with pixels and quality.
    const encode = async (size: { width: number; height: number }, q: number) => {
      calls.push([size.width, size.height, q]);
      return new Blob([new Uint8Array(Math.round(size.width * size.height * q * 2.4))]);
    };
    const out = await encodeWithinBudget(4032, 3024, encode);
    expect(out.blob.size).toBeLessThanOrEqual(2_500_000);
    expect(calls[0]).toEqual([1600, 1200, 0.82]);
    expect(calls.map((c) => c[2])).toEqual([0.82, 0.72, 0.6, 0.6]);
    expect(out.size).toEqual({ width: 1280, height: 960 });
    const small = await encodeWithinBudget(640, 480, encode);
    expect(small.step).toEqual({ edge: 640, quality: 0.82 });
  });
});

describe('outbox and sync rules', () => {
  it('backs off 5 s, 15 s, 60 s, then every 2 min', () => {
    expect([1, 2, 3, 4, 9].map(outboxBackoffMs)).toEqual([5_000, 15_000, 60_000, 120_000, 120_000]);
  });

  it('polls every 6 s ± 1 s visible, 60 s hidden, with 6/12/24/60 s backoff', () => {
    expect(nextPollDelay(0, true, 0)).toBe(5_000);
    expect(nextPollDelay(0, true, 1)).toBe(7_000);
    expect(nextPollDelay(0, false, 0.5)).toBe(60_000);
    expect([1, 2, 3, 4, 7].map(syncBackoffMs)).toEqual([6_000, 12_000, 24_000, 60_000, 60_000]);
    expect(nextPollDelay(2, true, 0.5)).toBe(12_000);
  });

  const job = (id: string, staff: string, patch: Partial<OutboxItem> = {}): OutboxItem => ({
    mutationId: id,
    payload: { clientMutationId: id, reportingLocation: 'Base' },
    photos: [],
    serverId: null,
    caseNumber: null,
    state: 'pending',
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    operator: { staffName: staff.split(' · ')[0] ?? '', team: '', staff },
    createdAt: 1,
    source: 'app',
    ...patch,
  });

  it('asks "Send N requests saved by X?" per saver, skipping created / needs-attention / approved jobs', () => {
    const jobs = [
      job('a', STAFF.dana.staff),
      job('b', 'dana kim · dispatch'),
      job('c', STAFF.rae.staff),
      job('d', STAFF.sam.staff),
      job('e', STAFF.dana.staff, { serverId: 'x' }),
      job('f', STAFF.dana.staff, { state: 'needs_attention' }),
      job('g', ''),
    ];
    const p = promptFor(jobs, STAFF.sam.staff, 'Sam Lee', new Set());
    expect(p).toEqual({ prompt: { count: 2, savedBy: 'Dana Kim', sendAs: 'Sam Lee' }, ids: ['a', 'b'] });
    expect(promptFor(jobs, STAFF.sam.staff, 'Sam Lee', new Set(['a', 'b']))?.ids).toEqual(['c']);
    expect(promptFor(jobs, null, null, new Set())).toBeNull();
  });

  it('finds the confirmed row a job already created (A6)', () => {
    const row = makeRow(1, { clientMutationId: 'm1' });
    expect(confirmedRowForJob({ mutationId: 'm1' }, map(row))).toBe(row);
    expect(confirmedRowForJob({ mutationId: 'm2' }, map(row))).toBeNull();
  });
});

describe('HTTP classification', () => {
  it('parses JSON successes and API errors', async () => {
    const ok = await apiRequest<{ a: number }>(async () => json(200, { a: 1 }), '/api/x', { timeoutMs: 1000 });
    expect(ok).toEqual({ ok: true, status: 200, data: { a: 1 } });
    const err = await apiRequest(async () => json(422, { error: { code: 'invalid', message: 'Bad', field: 'otherLocation' } }), '/api/x', { timeoutMs: 1000 });
    expect(err).toEqual({ ok: false, kind: 'http', status: 422, error: { code: 'invalid', message: 'Bad', field: 'otherLocation' } });
    expect(isDefinitive(err as never, CREATE_DEFINITIVE)).toBe(true);
  });

  it('treats captive portals (HTML 200, redirects, 511) as no network', async () => {
    const html = await apiRequest(async () => new Response('<html>login</html>', { status: 200 }), '/api/x', { timeoutMs: 1000 });
    expect(html).toEqual({ ok: false, kind: 'network' });
    const portal = await apiRequest(async () => new Response('', { status: 511 }), '/api/x', { timeoutMs: 1000 });
    expect(portal).toEqual({ ok: false, kind: 'network' });
    const thrown = await apiRequest(async () => {
      throw new TypeError('Failed to fetch');
    }, '/api/x', { timeoutMs: 1000 });
    expect(thrown).toEqual({ ok: false, kind: 'network' });
  });

  it('an HTML 404 is never a definitive rejection (nothing queued is discarded on a proxy page)', async () => {
    const res = await apiRequest(async () => new Response('<html>nope</html>', { status: 404 }), '/api/x', { timeoutMs: 1000 });
    expect(res).toEqual({ ok: false, kind: 'http', status: 404, error: null });
    expect(isDefinitive(res as never, PHOTO_DEFINITIVE)).toBe(false);
    expect(isUncertain({ ok: false, kind: 'http', status: 503, error: null })).toBe(true);
    expect(isUncertain({ ok: false, kind: 'timeout' })).toBe(true);
  });

  it('times out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const p = apiRequest((_url, init) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('abort')))), '/api/x', { timeoutMs: 12_000 });
      await vi.advanceTimersByTimeAsync(12_000);
      expect(await p).toEqual({ ok: false, kind: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('service worker build id', () => {
  it('hashes the /_next/static script set, ignoring order, origin and non-static scripts', () => {
    const a = buildIdFrom(['https://x.test/_next/static/chunks/a.js', '/_next/static/chunks/b.js', '/other.js']);
    const b = buildIdFrom(['/_next/static/chunks/b.js', '/_next/static/chunks/a.js']);
    expect(a).toBe(b);
    expect(a).not.toBe(buildIdFrom(['/_next/static/chunks/a2.js', '/_next/static/chunks/b.js']));
    expect(buildIdFrom([])).toBe('');
    const html = '<script src="/_next/static/chunks/a.js" async=""></script><script>inline</script><script nonce="n" src="/_next/static/chunks/b.js?dpl=1&amp;x=2"></script>';
    expect(scriptSrcsFromHtml(html)).toEqual(['/_next/static/chunks/a.js', '/_next/static/chunks/b.js?dpl=1&x=2']);
  });
});

describe('uuid', () => {
  it('makes v4 UUIDs even without crypto.randomUUID (http LAN testing)', () => {
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: (b: Uint8Array) => real.getRandomValues(b) });
    try {
      const ids = new Set(Array.from({ length: 50 }, () => uuid()));
      expect(ids.size).toBe(50);
      for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
