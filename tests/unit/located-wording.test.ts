// (2026-11-07, Located / Not located; DECISIONS, Brian approved) HIPAA: no staff-visible status or answer wording
// may say a named person is "in medical" or "not (found) in medical". Every label a status, a stage, an answer, an
// Undo bar, an alert, a system notification, a Web Push / Activity row or the audit trail shows is built here from
// the real builders and checked for the word "medical". The Medical TEAM name, the app title and free-text values
// (a location, a message) are not status wording and are not checked. Synthetic rows only.
import { describe, expect, it } from 'vitest';
import type { AuditEvent, RequestSummary } from '@/lib/api-types';
import {
  ANSWER_LABEL,
  NOT_FOUND_YET_LABEL,
  STATUS,
  STATUSES,
  STATUS_META,
  actionLabel,
  menuActions,
  primaryActions,
  type StatusActionId,
} from '@/lib/domain';
import { NOT_FOUND_FINAL_LABEL, RECHECK_DUE_LABEL, STAGE_META, displayStage, notFoundAnswer, stagePhrase } from '@/lib/stages';
import { holdDetail } from '@/lib/hold-detail';
import {
  ACTIVITY_KINDS,
  activityAriaLabel,
  activityGlyph,
  activityLine2,
  backToWaitingDetail,
  closedDetail,
  currentDetail,
  editEvent,
  inMedicalDetail,
  inactiveDetail,
  mapActivityRow,
  pushPayload,
  statusChangeEvent,
} from '@/lib/activity';
import { notFoundDetail } from '@/lib/server/stage-notify';
import { LOCATED_SUBTITLE, holdAlert, statusAlert } from '@/lib/client/alerts';
import { systemNotice } from '@/lib/client/system-notify';
import { notFoundSnack } from '@/lib/client/hold';
import { changeAnswerChoices } from '@/components/profile/change-answer';
import { buildAuditTrail } from '@/components/profile/audit-trail';
import { narrowStatusLabel, statusPhrase, stepperModel } from '@/components/list/list-helpers';
import { makeRow } from './client/helpers/fake-server';

const TZ = 'America/New_York';
const NOW = Date.parse('2026-11-07T03:00:00Z');
const RECHECK = '2026-11-07T03:20:00Z';
const MEDICAL = /medical/i;

/** Every staff-visible string `words` holds, flattened, that says "medical". */
function saysMedical(words: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (MEDICAL.test(v)) out.push(v);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(words);
  return out;
}

/** A row in every status and stage this app shows: held, due, needs info, en route, arrived, 2 checks, legacy. */
function everyRow(): RequestSummary[] {
  const rows: RequestSummary[] = STATUSES.map((status, i) => makeRow(i + 1, { status, medicalLocation: 'Chair 9' }));
  rows.push(
    makeRow(20, { status: STATUS.waiting, recheckAt: RECHECK, notFoundChecks: 1 }),
    makeRow(21, { status: STATUS.waiting, recheckAt: '2026-11-07T02:40:00Z', notFoundChecks: 1 }),
    makeRow(22, { status: STATUS.waiting, needsInfo: true } as unknown as Partial<RequestSummary>),
    makeRow(23, { status: STATUS.inMedical, enroute: { count: 1, earliestEta: RECHECK, state: 'enroute', mine: null } } as unknown as Partial<RequestSummary>),
    makeRow(24, { status: STATUS.inMedical, enroute: { count: 1, earliestEta: null, state: 'arrived', mine: null } } as unknown as Partial<RequestSummary>),
    makeRow(25, { status: STATUS.notInMedical, notFoundChecks: 2 }),
    makeRow(26, { status: STATUS.inMedical, medicalLocation: null }),
  );
  return rows;
}

describe('Located / Not located: no status wording says "medical"', () => {
  it('the labels: Located, Located · friend coming, Not located, the Pending hold; the answers ✓ Located, × Not located, ⧗ Pending', () => {
    expect(ANSWER_LABEL).toEqual({ notFound: 'Not located', inMedical: 'Located' });
    expect(STATUS_META[STATUS.inMedical]).toMatchObject({ label: 'Located · friend coming', shortLabel: 'Located' });
    expect(STATUS_META[STATUS.legacyBringFriend]).toMatchObject({ label: 'Located · friend coming', shortLabel: 'Located' });
    expect(STATUS_META[STATUS.notInMedical]).toMatchObject({ label: 'Not located', shortLabel: 'Not located' });
    expect(NOT_FOUND_YET_LABEL).toBe('Pending');
    expect(STAGE_META.notFoundYet.label).toBe('Pending');
    // (2026-11-07 12:29) The 20-minute hold is the third answer, "Pending" (it was "Not located yet").
    expect(notFoundAnswer(makeRow(1, { status: STATUS.waiting })).label).toBe('Pending');
    expect(RECHECK_DUE_LABEL).toBe('Recheck due');
    expect(NOT_FOUND_FINAL_LABEL).toBe('Not located');
    // The database values never change.
    expect(STATUS.inMedical).toBe('Found – Awaiting Reunion');
    expect(STATUS.notInMedical).toBe('Checked – Not Found');
  });

  it('STATUS_META, STAGE_META and every action definition', () => {
    // The words only: `glyph` ('inMedical') is an internal key, never shown.
    expect(saysMedical(Object.values(STATUS_META).map((m) => [m.label, m.shortLabel, m.narrowLabel ?? '']))).toEqual([]);
    expect(saysMedical(Object.values(STAGE_META).map((m) => m.label))).toEqual([]);
    const ids: StatusActionId[] = ['notInMedical', 'inMedical', 'changeToNotInMedical', 'changeToInMedical', 'reunited', 'discharge', 'reopen'];
    expect(saysMedical(ids.map(actionLabel))).toEqual([]);
    for (const status of [...STATUSES, 'Found – Transported']) {
      expect(saysMedical(primaryActions(status).map((a) => a.label)), status).toEqual([]);
      expect(saysMedical(menuActions(status, true).map((a) => a.label)), status).toEqual([]);
      expect(saysMedical(changeAnswerChoices(status)), status).toEqual([]);
      expect(saysMedical([statusPhrase(status), narrowStatusLabel(status) ?? '', stepperModel(status).steps]), status).toEqual([]);
    }
  });

  it('every stage as a card, a row, the request page and a screen reader show it', () => {
    for (const row of everyRow()) {
      for (const now of [0, NOW]) {
        const stage = displayStage(row, { now, timeZone: TZ });
        expect(saysMedical([stage.label, stage.fullLabel, stage.said, stage.sub ?? '', stage.extra ?? '', stage.recheck ?? '']), row.status).toEqual([]);
        expect(saysMedical(stagePhrase(row, TZ, now)), row.status).toEqual([]);
      }
      expect(saysMedical(notFoundAnswer(row)), row.status).toEqual([]);
    }
  });

  it('the in-app alerts and the system notifications', () => {
    for (const row of everyRow()) {
      const alert = statusAlert(row, TZ);
      expect(saysMedical([alert.title, alert.subtitle ?? '']), row.status).toEqual([]);
      const notice = systemNotice(alert, (id) => (id === row.id ? row : undefined));
      expect(saysMedical([notice.title, notice.body]), row.status).toEqual([]);
    }
    const held = makeRow(30, { status: STATUS.waiting, recheckAt: RECHECK, notFoundChecks: 1 });
    expect(holdAlert(held, TZ)).toMatchObject({ title: 'T. R30', subtitle: 'Pending · recheck 10:20 PM' });
    expect(statusAlert(makeRow(31, { status: STATUS.inMedical }), TZ).title).toBe('LP-1031 · T. R31 located');
    expect(statusAlert(makeRow(32, { status: STATUS.notInMedical }), TZ).title).toBe('LP-1032 · T. R32 — not located');
  });

  it('the Undo bar after a Not located answer', () => {
    const held = makeRow(40, { status: STATUS.waiting, recheckAt: RECHECK, notFoundChecks: 1 });
    expect(notFoundSnack(held, STATUS.notInMedical)).toEqual({ message: 'Pending · recheck in 20 min', said: 'Pending, recheck in 20 minutes.' });
    const closed = makeRow(41, { status: STATUS.notInMedical, notFoundChecks: 2, firstName: 'B.', lastName: 'W.' });
    expect(notFoundSnack(closed, STATUS.notInMedical)).toEqual({ message: 'B. W. closed · not located', said: 'B. W. closed, not located.' });
  });

  it('the Web Push and Activity words (contract B), the hold and the final answer included', () => {
    const details = [
      inMedicalDetail(null),
      inMedicalDetail('Chair 9'),
      backToWaitingDetail(),
      closedDetail('reunited'),
      closedDetail('discharged'),
      closedDetail('cancelled'),
      inactiveDetail(),
      holdDetail(RECHECK, TZ),
      holdDetail(null),
      notFoundDetail(makeRow(50, { status: STATUS.waiting, recheckAt: RECHECK, notFoundChecks: 1 }), TZ) ?? '',
      notFoundDetail(makeRow(51, { status: STATUS.notInMedical }), TZ) ?? '',
      ...STATUSES.map((s) => statusChangeEvent(s, 'Bed 3')?.detail ?? ''),
      editEvent(['medical_location'], null, 'Chair 9', STATUS.inMedical).detail,
    ];
    expect(saysMedical(details)).toEqual([]);
    expect(details.slice(0, 2)).toEqual(['Located', 'Located · Chair 9']);
    expect(details.slice(7, 11)).toEqual(['Pending · recheck 10:20 PM', 'Pending', 'Pending · recheck 10:20 PM', 'Not located']);
    for (const kind of ACTIVITY_KINDS) {
      for (const detail of details) {
        const p = pushPayload({ requestId: 'r1', kind, detail }, 'Jordan Diaz', 1);
        expect(saysMedical([p.title, p.body])).toEqual([]);
      }
    }
  });

  it('the audit trail, legacy medical_search / check_completed events included', () => {
    const at = '2026-11-07T03:00:00.000000+00:00';
    const base = { id: 'e', at, staff: 'Rae Chen · Medical', notes: null };
    const events = [
      { ...base, id: 'e1', action: 'status', previous: { status: STATUS.waiting }, next: { status: STATUS.inMedical, kind: 'answer' } },
      { ...base, id: 'e2', action: 'status', previous: { status: STATUS.inMedical }, next: { status: STATUS.notInMedical, kind: 'change' } },
      { ...base, id: 'e3', action: 'status', previous: { status: STATUS.waiting }, next: { status: STATUS.waiting, kind: 'answer', held: true, recheckAt: RECHECK, notFoundChecks: 1 } },
      { ...base, id: 'e4', action: 'legacy_search_not_found', previous: null, next: { status: STATUS.notInMedical } },
      { ...base, id: 'e5', action: 'legacy_search_found', previous: null, next: { status: STATUS.inMedical } },
      { ...base, id: 'e6', action: 'legacy_check', previous: { status: STATUS.waiting }, next: { status: STATUS.notInMedical } },
    ] as unknown as AuditEvent[];
    const items = buildAuditTrail(events, TZ);
    // The staff attribution ("· Medical") is the team's name, not a status: only the status words are checked.
    expect(saysMedical(items.map((i) => [i.title ?? '', i.note ?? '', i.status?.fromLabel ?? '', i.status?.toLabel ?? '']))).toEqual([]);
    expect(items.map((i) => i.status?.toLabel)).toContain('Not located (rechecked)');
  });
});

describe('"<name> located" says "Friend can head over", never Main Med (HIPAA, Brian 2026-11-07 14:18)', () => {
  const MED = /\bmed\b|medical/i;

  it('the in-app alert and the system notification', () => {
    expect(LOCATED_SUBTITLE).toBe('Friend can head over');
    const row = makeRow(33, { status: STATUS.inMedical, medicalLocation: 'Chair 9' });
    const alert = statusAlert(row, TZ);
    expect(alert).toMatchObject({ kind: 'in_medical', title: 'LP-1033 · T. R33 located', subtitle: 'Friend can head over' });
    const notice = systemNotice(alert, (id) => (id === row.id ? row : undefined));
    expect(notice.title).toBe('T. R33 · Located');
    expect(notice.body.split('\n').at(-1)).toBe('Friend can head over');
  });

  it('no alert or system notification, in any status or stage, names Main Med', () => {
    for (const row of everyRow()) {
      const alert = statusAlert(row, TZ);
      const notice = systemNotice(alert, (id) => (id === row.id ? row : undefined));
      expect([alert.title, alert.subtitle ?? '', notice.title, notice.body].join('\n'), row.status).not.toMatch(MED);
    }
  });
});

describe('Activity rows written before the rename read with the new words', () => {
  it('rewrites only an old status word at the start of a status row', () => {
    expect(currentDetail('in_medical', 'In medical')).toBe('Located');
    expect(currentDetail('in_medical', 'In medical · Chair 9')).toBe('Located · Chair 9');
    expect(currentDetail('not_in_medical', 'Not found yet · recheck 4:40 PM')).toBe('Pending · recheck 4:40 PM');
    expect(currentDetail('not_in_medical', 'Not found yet')).toBe('Pending');
    // A row written by the Located build, before the hold became Pending.
    expect(currentDetail('not_in_medical', 'Not located yet · recheck 4:40 PM')).toBe('Pending · recheck 4:40 PM');
    expect(currentDetail('not_in_medical', 'Not located yet')).toBe('Pending');
    expect(currentDetail('not_in_medical', 'Not found in medical')).toBe('Not located');
    expect(currentDetail('not_in_medical', 'Not in medical')).toBe('Not located');
    // New rows, other kinds and anything else are left as written.
    expect(currentDetail('in_medical', 'Located · Chair 9')).toBe('Located · Chair 9');
    expect(currentDetail('not_in_medical', 'Pending · recheck 4:40 PM')).toBe('Pending · recheck 4:40 PM');
    expect(currentDetail('message', 'Rae C.: In medical · Bed 3?')).toBe('Rae C.: In medical · Bed 3?');
    expect(currentDetail('moved', 'In medical tent → Bed 3')).toBe('In medical tent → Bed 3');
    expect(currentDetail('in_medical', 'In medicalish')).toBe('In medicalish');
  });

  it('GET /api/activity maps an old row to today’s words, glyph and sentence', () => {
    const raw = (kind: string, detail: string) => ({ request_id: 'r1', kind, detail, at: '2026-11-07T03:00:00Z', read_at: null, first_name: 'B.', last_name: 'W.' });
    const located = mapActivityRow(raw('in_medical', 'In medical · Chair 9'));
    expect(located).toMatchObject({ kind: 'in_medical', detail: 'Located · Chair 9' });
    const held = mapActivityRow(raw('not_in_medical', 'Not found yet · recheck 4:40 PM'));
    expect(held?.detail).toBe('Pending · recheck 4:40 PM');
    const final = mapActivityRow(raw('not_in_medical', 'Not found in medical'));
    expect(final?.detail).toBe('Not located');
    const heldLocated = mapActivityRow(raw('not_in_medical', 'Not located yet · recheck 4:40 PM'));
    expect(heldLocated?.detail).toBe('Pending · recheck 4:40 PM');
    expect(activityGlyph('not_in_medical', heldLocated?.detail ?? '')).toEqual({ icon: 'hourglass', tone: 'violet' });
    for (const row of [located, held, final, heldLocated]) {
      expect(row).not.toBeNull();
      if (!row) continue;
      expect(saysMedical([activityLine2(row), activityAriaLabel(row, NOW)])).toEqual([]);
    }
    expect(activityAriaLabel(located!, NOW)).toMatch(/^Request B\. W\., answer: Located, Chair 9\./);
  });
});
