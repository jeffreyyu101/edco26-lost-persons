// (Companion) lib/domain.ts statuses and helpers, lib/activity.ts kinds and copy, lib/server/notify.ts swapEvent
// recipients (the spec table), and the swap body schema.
import { describe, expect, it, vi } from 'vitest';
import {
  ACTIVITY_GLYPH,
  ACTIVITY_KINDS,
  accompaniedDetail,
  newRequestDetail,
  pushPayload,
  pushUrgency,
  statusChangeEvent,
  swapApprovedDetail,
  swapRequestedDetail,
} from '@/lib/activity';
import {
  STATUS,
  STATUS_META,
  SETTABLE_STATUSES,
  canTransition,
  isInMedical,
  isLocated,
  isSwapApproved,
  isSwapRequested,
  statusBucket,
  swapLabel,
  undoTarget,
} from '@/lib/domain';
import { createRequestSchema, setStatusSchema, swapSchema } from '@/lib/validation';

vi.mock('server-only', () => ({}));
vi.mock('next/server', () => ({ after: () => { throw new Error('no request'); } }));

const ID = '5b0f8c1e-2f4d-4a51-9c39-0d6c1b1e7a10';

describe('statuses', () => {
  it('Accompanied: amber, open, counts as located (not In medical); Friend informed: grey, closed', () => {
    expect(STATUS.accompanied).toBe('Found – Accompanied');
    expect(STATUS.friendInformed).toBe('Closed – Friend Informed');
    expect(STATUS_META[STATUS.accompanied]).toMatchObject({ label: 'Located · already accompanied', shortLabel: 'Accompanied', tone: 'amber', glyph: 'accompanied', bucket: 'open' });
    expect(STATUS_META[STATUS.friendInformed]).toMatchObject({ label: 'Friend informed', tone: 'gray', glyph: 'friendInformed', bucket: 'closed' });
    expect(statusBucket(STATUS.friendInformed)).toBe('closed');
    expect(isLocated(STATUS.accompanied)).toBe(true);
    expect(isLocated(STATUS.inMedical)).toBe(true);
    expect(isInMedical(STATUS.accompanied)).toBe(false);
    expect(SETTABLE_STATUSES).toContain(STATUS.accompanied);
    expect(SETTABLE_STATUSES).toContain(STATUS.friendInformed);
  });

  it('transitions: answer / change into Accompanied; Friend informed and back; never Reunited straight from Accompanied', () => {
    expect(canTransition(STATUS.waiting, STATUS.accompanied)).toBe(true);
    expect(canTransition(STATUS.inMedical, STATUS.accompanied)).toBe(true);
    expect(canTransition(STATUS.accompanied, STATUS.inMedical)).toBe(true);
    expect(canTransition(STATUS.accompanied, STATUS.notInMedical)).toBe(true);
    expect(canTransition(STATUS.accompanied, STATUS.waiting)).toBe(true);
    expect(canTransition(STATUS.accompanied, STATUS.discharged)).toBe(true);
    expect(canTransition(STATUS.accompanied, STATUS.friendInformed)).toBe(true);
    expect(canTransition(STATUS.friendInformed, STATUS.accompanied)).toBe(true);
    expect(canTransition(STATUS.accompanied, STATUS.reunited)).toBe(false);
    expect(canTransition(STATUS.waiting, STATUS.friendInformed)).toBe(false);
    expect(undoTarget(STATUS.accompanied)).toBe(STATUS.accompanied);
  });

  it('swap helpers', () => {
    expect(isSwapRequested({ status: STATUS.accompanied, swapRequestedAt: '2026-11-08T23:00:00Z' })).toBe(true);
    expect(isSwapRequested({ status: STATUS.accompanied, swapRequestedAt: null })).toBe(false);
    expect(isSwapApproved({ status: STATUS.inMedical, swapPlace: 'fa' })).toBe(true);
    expect(isSwapApproved({ status: STATUS.inMedical, swapPlace: null })).toBe(false);
    expect(swapLabel('mm', 'FA 4', 'Main Med')).toBe('Swap at Main Med');
    expect(swapLabel('fa', 'FA 4', 'Main Med')).toBe('Swap at FA 4');
    expect(swapLabel('fa', 'Command', 'Main Med')).toBe('Swap at Command');
    // (Events) 'mm' is the event's own name for its main medical.
    expect(swapLabel('mm', 'Stage A', 'Med Tent')).toBe('Swap at Med Tent');
  });
});

describe('activity', () => {
  it('kinds, glyphs and copy (spec table)', () => {
    for (const k of ['accompanied', 'swap_requested', 'swap_approved', 'swap_declined', 'swap_cancelled', 'friend_informed'] as const) {
      expect(ACTIVITY_KINDS).toContain(k);
    }
    expect(ACTIVITY_GLYPH.swap_cancelled).toEqual({ icon: 'swap-x', tone: 'gray' });
    expect(ACTIVITY_GLYPH.accompanied).toEqual({ icon: 'users', tone: 'amber' });
    expect(ACTIVITY_GLYPH.swap_requested).toEqual({ icon: 'arrow-left-right', tone: 'blue' });
    expect(ACTIVITY_GLYPH.swap_approved).toEqual({ icon: 'arrow-left-right', tone: 'green' });
    expect(ACTIVITY_GLYPH.swap_declined).toEqual({ icon: 'swap-x', tone: 'gray' });
    expect(ACTIVITY_GLYPH.friend_informed).toEqual({ icon: 'users', tone: 'gray' });
    expect(accompaniedDetail()).toBe("Located · already accompanied · Don't send the friend");
    expect(swapRequestedDetail('FA 4')).toBe('Friend swap requested · FA 4 · decide where');
    expect(swapApprovedDetail('mm', 'FA 4', 'Main Med')).toBe('Swap at Main Med');
    expect(swapApprovedDetail('fa', 'FA 3', 'Main Med')).toBe('Swap at FA 3');
    expect(statusChangeEvent(STATUS.accompanied, null)).toEqual({ kind: 'accompanied', detail: accompaniedDetail() });
    expect(statusChangeEvent(STATUS.friendInformed, null)).toEqual({ kind: 'friend_informed', detail: 'Friend informed' });
    // (Post-event) Back to an approved swap (the Undo of Swap done) says the swap, never "Located".
    expect(statusChangeEvent(STATUS.inMedical, null, { place: 'fa', post: 'FA 4', mainMedical: 'Main Med' })).toEqual({ kind: 'swap_approved', detail: 'Swap at FA 4' });
    expect(statusChangeEvent(STATUS.inMedical, null, { place: null, post: 'FA 4', mainMedical: 'Main Med' })?.kind).toBe('in_medical');
    expect(pushUrgency('accompanied')).toBe('high');
    expect(pushUrgency('swap_requested')).toBe('high');
    expect(pushPayload({ requestId: ID, kind: 'accompanied', detail: 'x' }, 'Jane Doe', null).requireInteraction).toBe(true);
  });

  it('a new request with a friend already in medical says so', () => {
    const row = { name: 'Tara Reyes', age: '24', gender: 'Male', postShort: 'FA 4' };
    expect(newRequestDetail(row)).toBe('Tara Reyes · 24 M · FA 4');
    expect(newRequestDetail({ ...row, friendInMedical: 'yes' })).toBe('Tara Reyes · 24 M · FA 4 · friend may be with them');
    expect(newRequestDetail({ ...row, friendInMedical: 'unsure' })).toBe('Tara Reyes · 24 M · FA 4');
  });
});

describe('notify swapEvent recipients', async () => {
  const { swapEvent } = await import('@/lib/server/notify');
  const row = { id: ID, postShort: 'FA 4', swapPlace: null };
  const parties = { answerer: 'Bob · Special Ops', requester: 'Cy · Command', creator: 'Ann · Dispatch' };

  it('request → the answerer (else everyone involved); approve → everyone involved; decline → requester + creator; withdraw → the answerer', () => {
    expect(swapEvent('request', row, 'Cy · Command', parties)).toEqual({
      recipients: ['Bob · Special Ops'],
      event: { requestId: ID, actor: 'Cy · Command', kind: 'swap_requested', detail: 'Friend swap requested · FA 4 · decide where' },
    });
    expect(swapEvent('request', row, 'Cy · Command', { ...parties, answerer: null })?.recipients).toBeNull();
    expect(swapEvent('approve', { ...row, swapPlace: 'mm' }, 'Bob · Special Ops', parties, 'Main Med')).toMatchObject({
      recipients: null,
      event: { kind: 'swap_approved', detail: 'Swap at Main Med' },
    });
    expect(swapEvent('decline', row, 'Bob · Special Ops', parties)).toMatchObject({
      recipients: ['Cy · Command', 'Ann · Dispatch'],
      event: { kind: 'swap_declined', detail: 'Swap declined' },
    });
    // (Post-event) The requester's Undo tells the answerer their "decide where" is gone.
    expect(swapEvent('withdraw', row, 'Cy · Command', parties)).toEqual({
      recipients: ['Bob · Special Ops'],
      event: { requestId: ID, actor: 'Cy · Command', kind: 'swap_cancelled', detail: 'Swap request cancelled' },
    });
  });

  it('(post-event) an answerer who is the actor counts as none: everyone involved is told', () => {
    expect(swapEvent('request', row, 'bob · special ops', parties)?.recipients).toBeNull();
    expect(swapEvent('cancel', row, 'Bob · Special Ops', { ...parties, from: 'requested' })?.recipients).toBeNull();
  });

  it('(post-event) restore: an approval back → "Swap at …"; an approval taken back → "Swap cancelled"; a request back → the answerer, a decline undone → nobody', () => {
    expect(swapEvent('restore', { ...row, swapPlace: 'fa' }, 'Ann · Dispatch', { ...parties, from: 'approved', undid: 'swap_cancelled' })).toMatchObject({
      recipients: null,
      event: { kind: 'swap_approved', detail: 'Swap at FA 4' },
    });
    expect(swapEvent('restore', row, 'Bob · Special Ops', { ...parties, from: 'requested', undid: 'swap_approved' })).toMatchObject({
      recipients: null,
      event: { kind: 'swap_cancelled', detail: 'Swap cancelled' },
    });
    expect(swapEvent('restore', row, 'Ann · Dispatch', { ...parties, from: 'requested', undid: 'swap_cancelled' })).toMatchObject({
      recipients: ['Bob · Special Ops'],
      event: { kind: 'swap_requested' },
    });
    // The answerer cancelled it themselves: the cancel told everyone involved, so does its Undo.
    expect(swapEvent('restore', row, 'Bob · Special Ops', { ...parties, from: 'requested', undid: 'swap_cancelled' })).toMatchObject({
      recipients: null,
      event: { kind: 'swap_requested' },
    });
    expect(swapEvent('restore', row, 'Bob · Special Ops', { ...parties, from: 'requested', undid: 'swap_declined' })).toBeNull();
  });

  it('cancel: from requested → the answerer (copy "Swap request cancelled"); from approved → everyone involved ("Swap cancelled")', () => {
    expect(swapEvent('cancel', row, 'Cy · Command', { ...parties, from: 'requested' })).toEqual({
      recipients: ['Bob · Special Ops'],
      event: { requestId: ID, actor: 'Cy · Command', kind: 'swap_cancelled', detail: 'Swap request cancelled' },
    });
    expect(swapEvent('cancel', row, 'Cy · Command', { ...parties, answerer: null, from: 'requested' })?.recipients).toBeNull();
    expect(swapEvent('cancel', row, 'Bob · Special Ops', { ...parties, from: 'approved' })).toEqual({
      recipients: null,
      event: { requestId: ID, actor: 'Bob · Special Ops', kind: 'swap_cancelled', detail: 'Swap cancelled' },
    });
  });
});

describe('validation', () => {
  it('create accepts friendInMedical / friendInMedicalName; status accepts the new statuses and kind inform', () => {
    const base = { clientMutationId: ID, reportingLocation: 'FA 4 – Oasis' };
    expect(createRequestSchema.safeParse({ ...base, friendInMedical: 'yes', friendInMedicalName: ' Sam ' }).data).toMatchObject({ friendInMedical: 'yes', friendInMedicalName: 'Sam' });
    expect(createRequestSchema.safeParse({ ...base, friendInMedical: 'maybe' }).success).toBe(false);
    expect(createRequestSchema.safeParse({ ...base, friendInMedicalName: 'x'.repeat(61) }).success).toBe(false);
    expect(setStatusSchema.safeParse({ status: STATUS.friendInformed, expectedVersion: 1, kind: 'inform' }).success).toBe(true);
    expect(setStatusSchema.safeParse({ status: STATUS.accompanied, expectedVersion: 1, kind: 'answer' }).success).toBe(true);
  });

  it('swap body', () => {
    expect(swapSchema.safeParse({ action: 'request', expectedVersion: 3 }).success).toBe(true);
    expect(swapSchema.safeParse({ action: 'approve', place: 'fa', expectedVersion: 3 }).success).toBe(true);
    expect(swapSchema.safeParse({ action: 'approve', expectedVersion: 3 }).success).toBe(false);
    expect(swapSchema.safeParse({ action: 'decline', place: 'mm', expectedVersion: 3 }).success).toBe(false);
    expect(swapSchema.safeParse({ action: 'withdraw', expectedVersion: 3 }).success).toBe(true);
    expect(swapSchema.safeParse({ action: 'cancel', expectedVersion: 3 }).success).toBe(true);
    expect(swapSchema.safeParse({ action: 'cancel', place: 'mm', expectedVersion: 3 }).success).toBe(false);
    expect(swapSchema.safeParse({ action: 'restore', expectedVersion: 3 }).success).toBe(true);
  });
});
