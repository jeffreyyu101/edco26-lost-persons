import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '@/lib/api-types';
import { STATUS } from '@/lib/domain';
import { AUDIT_VALUE_MAX, auditWho, buildAuditTrail, statusOrigin } from '@/components/profile/audit-trail';

// Synthetic events only. Times are UTC; the trail formats them in America/New_York, which is on EST
// (UTC−5) after Nov 1, 2026: 2026-11-07T04:10Z is "Nov 6, 11:10 PM".
const TZ = 'America/New_York';
const DANA = 'Dana Kim · GC/HX - Dispatch';
const RAE = 'Rae Chen · GC/HX - Special Operations/Med Transpo';

let n = 0;
const at = (hhmm: string) => `2026-11-07T${hhmm}:00.000000+00:00`;
function ev<T extends AuditEvent['action']>(action: T, time: string, staff: string, rest: Omit<Extract<AuditEvent, { action: T }>, 'id' | 'at' | 'staff' | 'notes' | 'action'> & { notes?: string | null }): AuditEvent {
  n += 1;
  return { id: `e${n}`, action, at: at(time), staff, notes: null, ...rest } as AuditEvent;
}

const created = ev('created', '03:58', DANA, { previous: null, next: { reportingLocation: 'FA 3 – Kinetic', otherLocation: null } });
const photo1 = ev('photo', '04:01', DANA, { previous: null, next: { photoId: 'p1', timing: 'today' } });
const photo2 = ev('photo', '04:01', DANA, { previous: null, next: { photoId: 'p2', timing: 'today' } });
const hair = ev('edit', '04:03', DANA, { previous: { hair: null }, next: { hair: 'Blond, two braids' } });
const answer = ev('status', '04:10', RAE, { previous: { status: STATUS.waiting }, next: { status: STATUS.inMedical, kind: 'answer' } });

describe('buildAuditTrail', () => {
  it('lists every event newest first with who (short team) and when (event timezone)', () => {
    const items = buildAuditTrail([created, photo1, photo2, hair, answer], TZ);
    expect(items.map((i) => i.status?.toLabel ?? i.title)).toEqual(['Located', 'Edited Hair', 'Photo added', 'Request logged']);
    expect(items[0]).toMatchObject({
      who: 'Rae Chen · GCHX Med Transpo',
      when: 'Nov 6, 11:10 PM',
      status: { from: STATUS.waiting, fromLabel: 'Waiting for check', to: STATUS.inMedical, toLabel: 'Located' },
      note: null,
    });
    expect(items[3]).toMatchObject({ title: 'Request logged', note: 'FA 3 – Kinetic', who: 'Dana Kim · Dispatch', when: 'Nov 6, 10:58 PM' });
  });

  it('shows an edit as label with old → new ("—" for empty)', () => {
    const [item] = buildAuditTrail([hair], TZ);
    expect(item).toMatchObject({ title: 'Edited Hair', labelChanges: false, changes: [{ label: 'Hair', from: '—', to: 'Blond, two braids' }] });
  });

  it('merges name halves and post halves (A35) and labels several changes', () => {
    const edit = ev('edit', '04:20', DANA, {
      previous: { firstName: 'Dana', lastName: 'Kim', reportingLocation: 'Other', otherLocation: 'Gate', clothing: 'Red' },
      next: { firstName: 'Dana', lastName: 'Lee', reportingLocation: 'Other', otherLocation: 'Gate 2', clothing: 'Blue' },
    });
    const [item] = buildAuditTrail([edit], TZ);
    expect(item?.labelChanges).toBe(true);
    expect(item?.changes).toEqual([
      { label: 'Name', from: 'Dana Kim', to: 'Dana Lee' },
      { label: 'Post', from: 'Gate', to: 'Gate 2' },
      { label: 'Wearing', from: 'Red', to: 'Blue' },
    ]);
    expect(item?.title).toBe('Edited Name, Post, Wearing');
  });

  it('keeps an edit whose merged values did not change, as "Edited details"', () => {
    const edit = ev('edit', '04:21', DANA, { previous: { firstName: 'A', lastName: 'B' }, next: { firstName: 'A', lastName: 'B' } });
    expect(buildAuditTrail([edit], TZ)[0]).toMatchObject({ title: 'Edited details', changes: [] });
  });

  it('cuts very long edit values', () => {
    const long = 'x'.repeat(AUDIT_VALUE_MAX + 50);
    const edit = ev('edit', '04:22', DANA, { previous: { physicalDescription: null }, next: { physicalDescription: long } });
    const to = buildAuditTrail([edit], TZ)[0]?.changes[0]?.to ?? '';
    expect(Array.from(to)).toHaveLength(AUDIT_VALUE_MAX);
    expect(to.endsWith('…')).toBe(true);
  });

  it('merges back-to-back photo uploads by the same person with the same timing', () => {
    const items = buildAuditTrail([photo1, photo2], TZ);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: 'Photo added', note: '2 photos · Today' });
  });

  it('does not merge photos from different people, timings or far apart', () => {
    const other = ev('photo', '04:02', RAE, { previous: null, next: { photoId: 'p3', timing: 'today' } });
    const older = ev('photo', '04:02', RAE, { previous: null, next: { photoId: 'p4', timing: 'older' } });
    const later = ev('photo', '05:30', RAE, { previous: null, next: { photoId: 'p5', timing: 'older' } });
    const unsure = ev('photo', '05:31', RAE, { previous: null, next: { photoId: 'p6', timing: 'unsure' } });
    const items = buildAuditTrail([photo1, other, older, later, unsure], TZ);
    expect(items.map((i) => i.note)).toEqual(['Timing unknown', 'Not today', 'Not today', 'Today', 'Today']);
  });

  it('normalises Jeffrey legacy actions', () => {
    const items = buildAuditTrail(
      [
        ev('legacy_search_not_found', '01:00', 'Sam Ortiz · Medical', { previous: null, next: { status: STATUS.notInMedical } }),
        ev('legacy_search_found', '01:10', 'Sam Ortiz · Medical', { previous: null, next: { status: STATUS.inMedical } }),
        ev('legacy_check', '01:20', 'Sam Ortiz · Prevent', { previous: { status: STATUS.notInMedical }, next: { status: STATUS.notInMedical } }),
        ev('other', '01:30', 'Sam Ortiz', { previous: null, next: { actionType: 'check_in_completed' } }),
      ],
      TZ,
    );
    expect(items.map((i) => (i.status ? `${i.status.fromLabel ?? ''}→${i.status.toLabel}` : i.title))).toEqual([
      'Check in completed',
      'Not located→Not located (rechecked)',
      '→Located',
      '→Not located',
    ]);
    expect(items[0]?.who).toBe('Sam Ortiz');
    expect(items[1]?.who).toBe('Sam Ortiz · Prevent');
  });

  it('shows cancel, undo and reopen as status moves', () => {
    const items = buildAuditTrail(
      [
        ev('cancelled', '02:00', DANA, { previous: { status: STATUS.waiting }, next: { status: 'Cancelled' } }),
        ev('status', '02:01', DANA, { previous: { status: STATUS.cancelled }, next: { status: STATUS.waiting, kind: 'reopen' } }),
        ev('status', '02:02', RAE, { previous: { status: STATUS.waiting }, next: { status: STATUS.notInMedical, kind: 'answer' } }),
        ev('status', '02:03', RAE, { previous: { status: STATUS.notInMedical }, next: { status: STATUS.waiting, kind: 'undo' } }),
        ev('status', '02:04', RAE, { previous: { status: null }, next: { status: 'Found – Transported', kind: null } }),
      ],
      TZ,
    );
    expect(items.map((i) => [i.status?.fromLabel ?? null, i.status?.toLabel, i.note])).toEqual([
      [null, 'Found – Transported', null],
      ['Not located', 'Waiting for check', 'Undo'],
      ['Waiting for check', 'Not located', null],
      ['Cancelled', 'Waiting for check', 'Reopened'],
      ['Waiting for check', 'Cancelled', null],
    ]);
  });

  it('keeps the server order for equal times and shows audit notes', () => {
    const a = ev('other', '03:00', DANA, { previous: null, next: { actionType: 'first' } });
    const b = ev('other', '03:00', DANA, { previous: null, next: { actionType: 'second' }, notes: '  Spoke to the friend  ' });
    const items = buildAuditTrail([a, b], TZ);
    expect(items.map((i) => i.title)).toEqual(['Second', 'First']);
    expect(items[0]?.notes).toBe('Spoke to the friend');
  });

  it('handles an empty trail and a missing staff string', () => {
    expect(buildAuditTrail([], TZ)).toEqual([]);
    expect(auditWho('')).toBe('');
    expect(auditWho(null)).toBe('');
  });
});

describe('statusOrigin', () => {
  it('finds the newest move into the current status', () => {
    const back = ev('status', '04:30', DANA, { previous: { status: STATUS.inMedical }, next: { status: STATUS.waiting, kind: 'undo' } });
    const again = ev('status', '04:40', 'Sam Ortiz · Medical', { previous: { status: STATUS.waiting }, next: { status: STATUS.inMedical, kind: 'answer' } });
    expect(statusOrigin([created, answer], STATUS.inMedical)).toEqual({ staffName: 'Rae Chen', at: answer.at });
    expect(statusOrigin([created, answer, back, again], STATUS.inMedical)).toEqual({ staffName: 'Sam Ortiz', at: again.at });
    expect(statusOrigin([created, answer, back], STATUS.waiting)).toEqual({ staffName: 'Dana Kim', at: back.at });
  });

  it('treats the legacy Bring-friend status as In medical, and returns null when nothing matches', () => {
    const legacy = ev('legacy_search_found', '01:10', 'Sam Ortiz · Medical', { previous: null, next: { status: STATUS.inMedical } });
    expect(statusOrigin([legacy], STATUS.legacyBringFriend)?.staffName).toBe('Sam Ortiz');
    expect(statusOrigin([created], STATUS.notInMedical)).toBeNull();
  });
});
