import { describe, expect, it } from 'vitest';
import type { OutboxItem, RequestSummary } from '@/lib/api-types';
import { EMPTY_FORM_VALUES, canSend, formValuesFromRequest, hasAnyDetail, parseAge, toCreateBody, toPatch } from '@/lib/client/form-values';
import { hrefFor, parseView, viewToParams, type View } from '@/lib/client/nav';
import {
  filterAll,
  highlightRanges,
  mineRows,
  pendingGroups,
  searchRequests,
  sortNewestFirst,
  viewCounts,
  visibleOutbox,
} from '@/lib/client/selectors';
import { createStubStore } from '@/lib/client/store-stub';
import { STUB_SESSION, stubRows } from '@/lib/client/stub-data';
import { createRequestSchema, requestPatchSchema } from '@/lib/validation';

const NOW = Date.parse('2026-11-07T03:10:00Z');
const rows = stubRows(NOW);
const byCase = (n: number) => rows.find((r) => r.caseNumber === n) as RequestSummary;
const ID = '5eed0000-0000-4000-8000-000000001012';
const CMID = '0b5a3c2e-8d4f-4a1b-9c7e-2f6d8a1b3c4d';

describe('nav (A22)', () => {
  const p = (s: string) => parseView(new URLSearchParams(s));

  it('parses every view', () => {
    expect(p('')).toEqual({ name: 'all', status: null, post: null });
    expect(p('view=pending')).toEqual({ name: 'pending' });
    expect(p('view=mine')).toEqual({ name: 'mine' });
    expect(p('status=Checked+%E2%80%93+Not+Found')).toEqual({ name: 'all', status: 'Checked – Not Found', post: null });
    expect(p('post=FA+3')).toEqual({ name: 'all', status: null, post: 'FA 3' });
    expect(p('q=pink')).toEqual({ name: 'search', q: 'pink' });
    expect(p('q=')).toEqual({ name: 'search', q: '' });
    expect(p('new=1')).toEqual({ name: 'new' });
    expect(p(`r=${ID}`)).toEqual({ name: 'profile', id: ID });
    expect(p(`r=${ID}&edit=friend`)).toEqual({ name: 'edit', id: ID, section: 'friend' });
    expect(p('dashboard=1')).toEqual({ name: 'dashboard' });
    expect(p(`outbox=${CMID}`)).toEqual({ name: 'outbox', mutationId: CMID });
  });

  it('ignores unknown or invalid params and applies precedence', () => {
    expect(p('foo=bar')).toEqual({ name: 'all', status: null, post: null });
    expect(p('status=Bogus')).toEqual({ name: 'all', status: null, post: null });
    expect(p('r=not-a-uuid')).toEqual({ name: 'all', status: null, post: null });
    expect(p(`r=${ID}&edit=everything`)).toEqual({ name: 'profile', id: ID });
    expect(p(`new=1&r=${ID}`)).toEqual({ name: 'new' });
    expect(p(`outbox=${CMID}&new=1`)).toEqual({ name: 'outbox', mutationId: CMID });
    expect(p('view=pending&q=x')).toEqual({ name: 'search', q: 'x' });
  });

  it('round-trips views through URLs', () => {
    const views: View[] = [
      { name: 'all', status: null, post: null },
      { name: 'all', status: 'Found – Awaiting Reunion', post: 'FA 4' },
      { name: 'pending' },
      { name: 'mine' },
      { name: 'search', q: 'pink hat' },
      { name: 'new' },
      { name: 'profile', id: ID },
      { name: 'edit', id: ID, section: 'person' },
      { name: 'dashboard' },
      { name: 'outbox', mutationId: CMID },
    ];
    for (const v of views) {
      const href = hrefFor(viewToParams(v));
      expect(parseView(new URL(href, 'https://x').searchParams), href).toEqual(v);
    }
    expect(hrefFor({})).toBe('/');
  });
});

describe('selectors', () => {
  it('sorts All newest first and filters by status / post', () => {
    const sorted = sortNewestFirst(rows);
    expect(sorted[0]?.caseNumber).toBe(1013);
    expect(sorted.at(-1)?.caseNumber).toBe(993);
    expect(filterAll(rows, { status: 'Found – Awaiting Reunion', post: null }).map((r) => r.caseNumber).sort()).toEqual([1004, 1005, 1007]);
    expect(filterAll(rows, { status: null, post: 'info booth' }).map((r) => r.caseNumber)).toEqual([997]);
  });

  it('groups Pending: friend coming then waiting, oldest first', () => {
    const g = pendingGroups(rows);
    expect(g.friendComing.map((r) => r.caseNumber)).toEqual([1005, 1004, 1007]);
    expect(g.waiting.map((r) => r.caseNumber)).toEqual([1010, 1011, 1012, 1013]);
  });

  it('My requests = phone ids ∪ canonical creator, newest update first', () => {
    const mine = mineRows(rows, new Set([byCase(1013).id]), 'dana kim · dispatch');
    expect(mine.map((r) => r.caseNumber)).toEqual([1013, 1004, 1012, 1009, 1002, 1000, 994]);
  });

  it('hides outbox items that are already confirmed (A6)', () => {
    const item = (mutationId: string, createdAt: number) => ({ mutationId, createdAt }) as OutboxItem;
    const confirmed = new Map(rows.map((r) => [r.id, r]));
    const sent = { ...byCase(1013), clientMutationId: CMID };
    confirmed.set(sent.id, sent);
    const shown = visibleOutbox([item(CMID, 1), item('a', 2), item('b', 3)], confirmed);
    expect(shown.map((o) => o.mutationId)).toEqual(['b', 'a']);
    expect(viewCounts(rows, shown, new Set(), STUB_SESSION.staff)).toEqual({ all: 23, pending: 7, mine: 8 });
  });

  it('searches names, clothing, hair, posts and LP numbers', () => {
    expect(searchRequests(rows, 'pink').map((h) => [h.row.caseNumber, h.field])).toEqual([
      [1012, 'clothing'],
      [998, 'clothing'],
    ]);
    expect(searchRequests(rows, 'LP-1012').map((h) => h.row.caseNumber)).toEqual([1012]);
    expect(searchRequests(rows, '1012')[0]?.ranges).toEqual([[3, 7]]);
    expect(searchRequests(rows, 'kayla')[0]?.field).toBe('name');
    expect(searchRequests(rows, 'info booth').map((h) => [h.row.caseNumber, h.field])).toEqual([[997, 'lastSeen']]);
    expect(searchRequests(rows, '   ')).toEqual([]);
    expect(highlightRanges('Pink hat, pink boots', 'PINK')).toEqual([[0, 4], [10, 14]]);
  });
});

describe('form values', () => {
  it('parses age', () => {
    expect(parseAge('')).toBeNull();
    expect(parseAge(' 19 ')).toBe(19);
    expect(parseAge('121')).toBe('invalid');
    expect(parseAge('1.5')).toBe('invalid');
  });

  it('enables Send once any detail (a photo counts) and a post are set', () => {
    expect(canSend(EMPTY_FORM_VALUES)).toBe(false);
    expect(canSend({ ...EMPTY_FORM_VALUES, name: 'T.R.' })).toBe(false); // no post
    expect(canSend({ ...EMPTY_FORM_VALUES, name: 'T.R.', reportingLocation: 'FA 4 – Oasis' })).toBe(true);
    expect(canSend({ ...EMPTY_FORM_VALUES, reportingLocation: 'FA 4 – Oasis' }, 1)).toBe(true);
    expect(canSend({ ...EMPTY_FORM_VALUES, reportingLocation: 'FA 4 – Oasis' })).toBe(false);
    expect(canSend({ ...EMPTY_FORM_VALUES, name: 'x', reportingLocation: 'Other' })).toBe(false);
    expect(canSend({ ...EMPTY_FORM_VALUES, name: 'x', reportingLocation: 'Other', otherLocation: 'Gate' })).toBe(true);
    expect(canSend({ ...EMPTY_FORM_VALUES, name: 'x', age: '200', reportingLocation: 'Base' })).toBe(false);
    expect(hasAnyDetail({ ...EMPTY_FORM_VALUES, contactPhone: '407' })).toBe(true);
  });

  it('builds a create body the server schema accepts', () => {
    const body = toCreateBody(
      { ...EMPTY_FORM_VALUES, name: '  Kayla  Martinez ', age: '19', gender: 'Female', reportingLocation: 'FA 3 – Kinetic', otherLocation: 'stale', clothing: ' Pink hat ' },
      CMID,
    );
    expect(body).toMatchObject({ clientMutationId: CMID, name: 'Kayla Martinez', age: 19, gender: 'Female', otherLocation: null, clothing: 'Pink hat', hair: null });
    expect(createRequestSchema.safeParse(body).success).toBe(true);
  });

  it('sends only changed keys when editing', () => {
    const base = formValuesFromRequest(byCase(1012));
    expect(base.name).toBe('Kayla Martinez');
    expect(toPatch(base, { ...base })).toBeNull();
    expect(toPatch(base, { ...base, hair: '  ' })).toEqual({ hair: null });
    expect(toPatch(base, { ...base, name: 'Kayla  Martinez' })).toBeNull();
    const patch = toPatch(base, { ...base, reportingLocation: 'Other', otherLocation: 'Gate', age: '20' });
    expect(patch).toEqual({ age: 20, reportingLocation: 'Other', otherLocation: 'Gate' });
    expect(requestPatchSchema.safeParse(patch).success).toBe(true);
  });
});

describe('stub store', () => {
  it('follows the domain rules: transitions, idempotent repeat, undo, creator checks', async () => {
    const store = createStubStore({ eventTimezone: 'America/New_York', now: NOW });
    const { actions } = store;
    const id = byCase(1012).id;

    const answered = await actions.setStatus(id, 'Found – Awaiting Reunion', 'answer');
    expect(answered).toMatchObject({ ok: true, changed: true });
    expect(store.getState().snackbar?.message).toBe('LP-1012 · In medical');

    const repeat = await actions.setStatus(id, 'Found – Awaiting Reunion', 'answer');
    expect(repeat).toMatchObject({ ok: true, changed: false });

    const undone = await actions.undo(store.getState().snackbar!.id);
    expect(undone).toMatchObject({ ok: true, request: { status: 'Added' } });

    expect(await actions.setStatus(id, 'Reunited – Closed', 'reunite')).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await actions.cancel(byCase(1013).id)).toMatchObject({ ok: false, reason: 'forbidden' });
    expect(await actions.cancel(id)).toMatchObject({ ok: true, changed: true, request: { status: 'Cancelled' } });

    const created = await actions.create({
      values: { ...EMPTY_FORM_VALUES, name: 'TEST-1a-1', reportingLocation: 'Base' },
      clientMutationId: CMID,
      photos: [],
      photoTiming: 'today',
    });
    expect(created).toMatchObject({ outcome: 'sent', request: { caseNumber: 1014, name: 'TEST-1a-1' } });
    const again = await actions.create({ values: EMPTY_FORM_VALUES, clientMutationId: CMID, photos: [], photoTiming: 'today' });
    expect(again).toMatchObject({ outcome: 'sent', request: { caseNumber: 1014 } });
  });
});
