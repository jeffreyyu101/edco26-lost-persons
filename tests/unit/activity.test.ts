// lib/activity.ts (F4, spec §18 A53–A59): contract B copy, the push payload (initials title, no ids or contact
// details, under 4 KB, one tag per request), urgency and TTL, the glyph map, the bell's badge, row times, day
// labels, the screen-reader sentence, and which events F4 raises (never Not in medical).
import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_GLYPH,
  ACTIVITY_KINDS,
  NO_NAME,
  PUSH_PAYLOAD_MAX_BYTES,
  activityAriaLabel,
  activityLine2,
  activityGlyph,
  activityTime,
  backToWaitingDetail,
  badgeText,
  closedDetail,
  editEvent,
  enrouteDetail,
  groupByDay,
  inMedicalDetail,
  isActivityKind,
  mapActivityRow,
  messageDetail,
  movedDetail,
  newRequestDetail,
  pushPayload,
  pushTtl,
  pushUrgency,
  requestTitle,
  scrubDetail,
  shortStaffName,
  statusChangeEvent,
  testPayload,
} from '@/lib/activity';
import { STATUS, STATUS_META } from '@/lib/domain';

const ID = '0f0f0f0f-0000-4000-8000-000000000101';
const TZ = 'America/New_York';
const NOW = Date.parse('2026-11-06T21:30:00Z'); // 4:30 PM in New York

describe('contract B: detail copy', () => {
  it('message: sender first name + last initial, text cut to 120 characters', () => {
    expect(shortStaffName('Rae Chen')).toBe('Rae C.');
    expect(shortStaffName('Rae')).toBe('Rae');
    expect(messageDetail('Rae Chen', '  Bring 1   person only ')).toBe('Rae C.: Bring 1 person only');
    const long = messageDetail('Rae Chen', 'x'.repeat(300));
    expect(Array.from(long.replace('Rae C.: ', ''))).toHaveLength(120);
    expect(long.endsWith('…')).toBe(true);
  });

  it('en route, new request, in medical, back to waiting, moved, closed, edited', () => {
    expect(enrouteDetail(4)).toBe('Friend en route · ~4 min');
    expect(enrouteDetail(null)).toBe('Friend en route');
    expect(newRequestDetail({ name: 'Tara Ruiz', age: '24', gender: 'Male', postShort: 'FA 4' })).toBe('T.R. · 24 M · FA 4');
    expect(newRequestDetail({ name: null, age: null, gender: null, postShort: 'FA 3' })).toBe('FA 3');
    expect(inMedicalDetail('Chair 9')).toBe('Located · Chair 9');
    expect(inMedicalDetail(null)).toBe('Located');
    expect(backToWaitingDetail()).toBe('Back to Waiting for check');
    expect(movedDetail('Chair 9', 'Bed 3')).toBe('Chair 9 → Bed 3');
    expect(movedDetail(null, 'Bed 3')).toBe('Bed 3');
    expect(closedDetail('reunited')).toBe('Reunited');
    expect(closedDetail('discharged')).toBe('Discharged');
    expect(closedDetail('cancelled')).toBe('Cancelled');
  });

  it('status words come from STATUS_META (a later rename flows through)', () => {
    expect(inMedicalDetail(null)).toBe(STATUS_META[STATUS.inMedical].shortLabel);
    expect(backToWaitingDetail()).toBe(`Back to ${STATUS_META[STATUS.waiting].label}`);
  });

  it('scrubDetail drops request ids and phone numbers, keeps short numbers', () => {
    expect(scrubDetail('LP-1013 · Located · Chair 9')).toBe('Located · Chair 9');
    expect(scrubDetail('Rae C.: call (407) 555-0142 now')).toBe('Rae C.: call ••• now');
    expect(scrubDetail('Rae C.: +1 407 555 0142')).toBe('Rae C.: •••');
    expect(scrubDetail('T.R. · 24 M · FA 4')).toBe('T.R. · 24 M · FA 4');
    expect(scrubDetail('Not located yet · recheck 4:40 PM')).toBe('Not located yet · recheck 4:40 PM');
    expect(scrubDetail('Friend en route · ~4 min')).toBe('Friend en route · ~4 min');
    expect(Array.from(scrubDetail('y'.repeat(500)))).toHaveLength(200);
  });

  it('line 1 and the push title are initials, never the full name', () => {
    expect(requestTitle('Jordan', 'Diaz')).toBe('J.D.');
    expect(requestTitle(null, null)).toBe(NO_NAME);
  });
});

describe('which events F4 raises (contract D)', () => {
  it('status changes: In medical, Back to Waiting, Reunited, Discharged — never Not in medical', () => {
    expect(statusChangeEvent(STATUS.inMedical, 'Chair 9')).toEqual({ kind: 'in_medical', detail: 'Located · Chair 9' });
    expect(statusChangeEvent(STATUS.legacyBringFriend, null)).toEqual({ kind: 'in_medical', detail: 'Located' });
    expect(statusChangeEvent(STATUS.waiting, null)).toEqual({ kind: 'back_to_waiting', detail: 'Back to Waiting for check' });
    expect(statusChangeEvent(STATUS.reunited, null)?.kind).toBe('reunited');
    expect(statusChangeEvent(STATUS.discharged, null)?.kind).toBe('discharged');
    expect(statusChangeEvent(STATUS.notInMedical, null)).toBeNull();
    expect(statusChangeEvent('Found – Transported', null)).toBeNull();
  });

  it('edits: the first location while In medical completes the answer; a new place moves; else Details changed', () => {
    expect(editEvent(['medical_location'], null, 'Chair 9', STATUS.inMedical)).toEqual({ kind: 'in_medical', detail: 'Located · Chair 9' });
    expect(editEvent(['medical_location'], 'Chair 9', 'Bed 3', STATUS.inMedical)).toEqual({ kind: 'moved', detail: 'Chair 9 → Bed 3' });
    expect(editEvent(['medical_location'], null, 'Bed 3', STATUS.reunited)).toEqual({ kind: 'moved', detail: 'Bed 3' });
    expect(editEvent(['medical_location'], 'Bed 3', null, STATUS.inMedical)).toEqual({ kind: 'edited', detail: 'Details changed' });
    expect(editEvent(['clothing'], null, null, STATUS.waiting)).toEqual({ kind: 'edited', detail: 'Details changed' });
  });
});

describe('push payload', () => {
  it('title = initials (New request for a new one), body = the scrubbed detail, one tag per request', () => {
    const p = pushPayload({ requestId: ID, kind: 'in_medical', detail: 'LP-1013 Located · Chair 9' }, 'J.D.', 2);
    expect(p).toMatchObject({ title: 'J.D.', body: 'Located · Chair 9', tag: `lp-${ID}`, url: `/?r=${ID}`, renotify: true, requireInteraction: true, badge: 2 });
    expect(pushPayload({ requestId: ID, kind: 'new_request', detail: 'T.R. · 24 M · FA 4' }, 'T.R.', null).title).toBe('New request');
    expect(pushPayload({ requestId: ID, kind: 'message', detail: 'Rae C.: hi' }, 'A.L.', null).renotify).toBe(true);
  });

  it('regression: every event sounds when it replaces the request\'s earlier notification; only In medical stays until dismissed', () => {
    for (const kind of ACTIVITY_KINDS) {
      const p = pushPayload({ requestId: ID, kind, detail: 'Friend arrived' }, 'J.D.', null);
      expect(p.renotify, kind).toBe(true);
      expect(p.requireInteraction, kind).toBe(kind === 'in_medical');
    }
  });

  it('never carries an LP number, a phone number or more than the limit', () => {
    for (const kind of ACTIVITY_KINDS) {
      const p = pushPayload({ requestId: ID, kind, detail: `LP-0012 call 407-555-0142 ${'z'.repeat(400)}` }, 'J.D.', 9);
      const json = JSON.stringify(p);
      expect(json).not.toMatch(/LP-?\d/);
      expect(json).not.toContain('555');
      expect(Buffer.byteLength(json)).toBeLessThan(PUSH_PAYLOAD_MAX_BYTES);
      expect(Buffer.byteLength(json)).toBeLessThan(4_000);
    }
    expect(testPayload()).toMatchObject({ kind: 'test', tag: 'lp-test', url: '/' });
  });

  it('urgency and TTL: new requests, answers and messages are high', () => {
    for (const k of ['new_request', 'in_medical', 'not_in_medical', 'back_to_waiting', 'message'] as const) {
      expect(pushUrgency(k)).toBe('high');
      expect(pushTtl(k)).toBe(3_600);
    }
    for (const k of ['moved', 'edited', 'reunited', 'enroute'] as const) {
      expect(pushUrgency(k)).toBe('normal');
      expect(pushTtl(k)).toBe(900);
    }
  });
});

describe('the inbox', () => {
  it('one glyph and colour per kind', () => {
    expect(Object.keys(ACTIVITY_GLYPH).sort()).toEqual([...ACTIVITY_KINDS].sort());
    expect(ACTIVITY_GLYPH.message).toEqual({ icon: 'message-square', tone: 'gray' });
    expect(ACTIVITY_GLYPH.in_medical).toEqual({ icon: 'cross', tone: 'green' });
    expect(ACTIVITY_GLYPH.enroute).toEqual({ icon: 'walk', tone: 'teal' });
    expect(ACTIVITY_GLYPH.enroute_changed).toEqual({ icon: 'walk', tone: 'teal' });
    expect(ACTIVITY_GLYPH.enroute_cancelled).toEqual({ icon: 'walk', tone: 'gray' });
    expect(ACTIVITY_GLYPH.arrived).toEqual({ icon: 'check', tone: 'green' });
    expect(ACTIVITY_GLYPH.moved).toEqual({ icon: 'map-pin', tone: 'gray' });
    expect(ACTIVITY_GLYPH.back_to_waiting).toEqual({ icon: 'undo-2', tone: 'blue' });
    expect(ACTIVITY_GLYPH.new_request).toEqual({ icon: 'plus', tone: 'blue' });
    expect(ACTIVITY_GLYPH.reunited).toEqual({ icon: 'check', tone: 'gray' });
    expect(ACTIVITY_GLYPH.discharged).toEqual({ icon: 'check', tone: 'gray' });
    expect(ACTIVITY_GLYPH.cancelled).toEqual({ icon: 'x', tone: 'gray' });
    expect(ACTIVITY_GLYPH.edited).toEqual({ icon: 'pencil', tone: 'gray' });
    expect(activityGlyph('not_in_medical', 'Not located yet · recheck 4:40 PM')).toEqual({ icon: 'hourglass', tone: 'violet' });
    expect(activityGlyph('not_in_medical', 'Not located')).toEqual({ icon: 'x', tone: 'gray' });
  });

  it('the badge: hidden at 0, then 1–9, then 9+', () => {
    expect(badgeText(0)).toBe('');
    expect(badgeText(-1)).toBe('');
    expect(badgeText(1)).toBe('1');
    expect(badgeText(9)).toBe('9');
    expect(badgeText(10)).toBe('9+');
    expect(badgeText(250)).toBe('9+');
  });

  it('row time: now, minutes, 1h, then the clock', () => {
    expect(activityTime(new Date(NOW - 20_000).toISOString(), NOW, TZ)).toBe('now');
    expect(activityTime(new Date(NOW - 2 * 60_000).toISOString(), NOW, TZ)).toBe('2m');
    expect(activityTime(new Date(NOW - 59 * 60_000).toISOString(), NOW, TZ)).toBe('59m');
    expect(activityTime(new Date(NOW - 61 * 60_000).toISOString(), NOW, TZ)).toBe('1h');
    expect(activityTime('2026-11-06T16:12:00Z', NOW, TZ)).toBe('11:12 AM');
  });

  it('day labels only when the list spans more than one day', () => {
    const today = [{ at: '2026-11-06T21:00:00Z' }, { at: '2026-11-06T15:00:00Z' }];
    expect(groupByDay(today, NOW, TZ)).toEqual([{ label: null, rows: today }]);
    const spans = [...today, { at: '2026-11-05T22:00:00Z' }, { at: '2026-11-04T22:00:00Z' }];
    expect(groupByDay(spans, NOW, TZ).map((s) => [s.label, s.rows.length])).toEqual([
      ['Today', 2],
      ['Yesterday', 1],
      ['Wed', 1],
    ]);
    expect(groupByDay([], NOW, TZ)).toEqual([]);
  });

  it('every row has a full sentence for screen readers', () => {
    const at = new Date(NOW - 5 * 60_000).toISOString();
    expect(activityAriaLabel({ kind: 'in_medical', title: 'J.D.', detail: 'Located · Chair 9', at, read: false }, NOW)).toBe(
      'Request J D, answer: Located, Chair 9. 5 minutes ago. Unread.',
    );
    expect(activityAriaLabel({ kind: 'moved', title: 'R.P.', detail: 'Chair 9 → Bed 3', at, read: true }, NOW)).toBe(
      'Request R P, location changed: Chair 9 to Bed 3. 5 minutes ago.',
    );
    expect(activityAriaLabel({ kind: 'new_request', title: 'T.R.', detail: 'T.R. · 24 M · FA 4', at, read: false }, NOW)).toBe(
      'Request T R, new request: 24 M, FA 4. 5 minutes ago. Unread.',
    );
  });

  it("a new request's line 2 does not repeat line 1's initials (f34-v2-2); every other kind shows the detail", () => {
    expect(activityLine2({ kind: 'new_request', title: 'T.R.', detail: 'T.R. · 24 M · FA 4' })).toBe('New request · 24 M · FA 4');
    expect(activityLine2({ kind: 'new_request', title: NO_NAME, detail: '24 M · FA 4' })).toBe('New request · 24 M · FA 4');
    expect(activityLine2({ kind: 'new_request', title: 'T.R.', detail: 'T.R.' })).toBe('New request');
    expect(activityLine2({ kind: 'in_medical', title: 'J.D.', detail: 'Located · Chair 9' })).toBe('Located · Chair 9');
  });

  it('maps lp_activity_list rows (unknown kinds dropped, detail scrubbed)', () => {
    expect(
      mapActivityRow({ request_id: ID, kind: 'moved', detail: 'LP-0001 Chair 9 → Bed 3', at: '2026-11-06T21:00:00Z', read_at: null, first_name: 'Rory', last_name: 'Park' }),
    ).toEqual({ requestId: ID, kind: 'moved', title: 'R.P.', detail: 'Chair 9 → Bed 3', at: '2026-11-06T21:00:00Z', read: false });
    expect(mapActivityRow({ request_id: ID, kind: 'nope', at: 'x' })).toBeNull();
    expect(isActivityKind('edited')).toBe(true);
    expect(isActivityKind('status')).toBe(false);
  });
});
