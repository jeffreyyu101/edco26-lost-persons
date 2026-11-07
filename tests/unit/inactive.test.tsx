// F6 · Inactivity auto-close (Brian 2026-11-06 19:55–20:07; spec §24 A96–A103): the client side of 'Closed –
// Inactive'. One constant with SQL (lp_inactive_minutes), the status's label / glyph / bucket, its stage, Reopen as
// its only move, the status sort order (closed: Archived / Closed), the timer-off glyph (not Reunited's check), the
// list and stepper labels, the Activity kind, the in-app alert, the dashboard's closed total, and the sync's notify
// candidates. Pure: no network, no database.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StageGlyph } from '@/components/ui/StageGlyph';
import { StatusGlyph } from '@/components/ui/StatusGlyph';
import { closedTotal, inactiveCount } from '@/components/dashboard/dashboard-model';
import { narrowStatusLabel, stepperModel } from '@/components/list/list-helpers';
import { changeAnswerChoices } from '@/components/profile/change-answer';
import {
  ACTIVITY_GLYPH,
  ACTIVITY_KINDS,
  activityAriaLabel,
  activityGlyph,
  inactiveDetail,
  isActivityKind,
  pushPayload,
  pushTtl,
  pushUrgency,
  statusChangeEvent,
} from '@/lib/activity';
import type { RequestSummary, Stats } from '@/lib/api-types';
import { alertStillCurrent, statusAlert } from '@/lib/client/alerts';
import { byNewestClosed, friendComingOrder, statusGroups, waitingOrder } from '@/lib/client/status-order';
import {
  AUTO_CLOSE_KIND,
  INACTIVE_MINUTES,
  STATUS,
  STATUSES,
  STATUS_KINDS,
  STATUS_META,
  SYSTEM_STAFF,
  TRANSITIONS,
  canTransition,
  isInactiveClosed,
  isStatus,
  menuActions,
  primaryActions,
  statusBucket,
  statusMeta,
  undoTarget,
} from '@/lib/domain';
import { STAGE_META, displayStage, stageLook, stagePhrase } from '@/lib/stages';
import { inactiveCandidates } from '@/lib/server/inactive-notify';

const MIGRATION = readFileSync(join(__dirname, '..', '..', 'supabase/migrations/20261106000000_rework.sql'), 'utf8');
const NOW = Date.parse('2026-11-07T03:00:00Z');
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

let n = 0;
function row(over: Partial<RequestSummary> = {}): RequestSummary {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    clientMutationId: null,
    caseNumber: 1000 + n,
    firstName: 'S.',
    lastName: 'L.',
    age: '20',
    gender: 'Female',
    heightBuild: null,
    hair: null,
    identifyingFeatures: null,
    physicalDescription: null,
    lastSeen: null,
    clothing: null,
    additionalNotes: null,
    reportingLocation: 'FA 3 – Kinetic',
    otherLocation: null,
    contactName: null,
    contactPhone: null,
    contactRelationship: null,
    contactNotes: null,
    status: STATUS.inactive,
    createdBy: 'Dana Kim · GC/HX - Dispatch',
    updatedBy: SYSTEM_STAFF,
    createdAt: iso(120),
    updatedAt: iso(5),
    foundAt: iso(70),
    reunionStartedAt: iso(70),
    closedAt: iso(5),
    rowVersion: 4,
    firstPhotoId: null,
    photoCount: 0,
    name: 'S. L.',
    postShort: 'FA 3',
    medicalLocation: 'Bed 3',
    recheckAt: null,
    notFoundChecks: 0,
    ...over,
  };
}

describe('one constant with SQL', () => {
  it('INACTIVE_MINUTES = lp_inactive_minutes() = 60', () => {
    const m = /create or replace function public\.lp_inactive_minutes\(\)[\s\S]*?\$fn\$\s*select (\d+)\s*\$fn\$/.exec(MIGRATION);
    expect(Number(m?.[1])).toBe(INACTIVE_MINUTES);
    expect(INACTIVE_MINUTES).toBe(60);
    // lp_close_inactive measures against it, never a literal of its own.
    const fn = /create function public\.lp_close_inactive[\s\S]*?\n\$fn\$;/.exec(MIGRATION)?.[0] ?? '';
    expect(fn).toContain('public.lp_inactive_minutes()');
    expect(fn).toContain(`'${AUTO_CLOSE_KIND}'`);
    expect(fn).toContain(`'${SYSTEM_STAFF}'`);
    expect(fn).toContain(`'${STATUS.inactive}'`);
  });

  it('the pg_cron job is lp-close-inactive, every 5 minutes, unscheduled first', () => {
    expect(MIGRATION).toContain("perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'lp-close-inactive';");
    expect(MIGRATION).toContain("cron.schedule('lp-close-inactive', '*/5 * * * *', 'select public.lp_close_inactive()')");
  });
});

describe('the status', () => {
  it('"Closed · inactive": grey, closed, the timer-off glyph, "Inactive" on a narrow phone', () => {
    expect(STATUS.inactive).toBe('Closed – Inactive');
    expect(isStatus(STATUS.inactive)).toBe(true);
    expect(STATUSES).toContain(STATUS.inactive);
    expect(STATUS_META[STATUS.inactive]).toEqual({
      label: 'Closed · inactive',
      shortLabel: 'Closed · inactive',
      narrowLabel: 'Inactive',
      tone: 'gray',
      glyph: 'inactive',
      bucket: 'closed',
    });
    expect(statusBucket(STATUS.inactive)).toBe('closed');
    expect(isInactiveClosed(STATUS.inactive)).toBe(true);
    expect(isInactiveClosed(STATUS.reunited)).toBe(false);
    // Its glyph is its own, never Reunited's ✓.
    expect(statusMeta(STATUS.inactive).glyph).not.toBe(statusMeta(STATUS.reunited).glyph);
    expect(narrowStatusLabel(STATUS.inactive)).toBe('Inactive');
  });

  it('Reopen (back to In medical, kind reopen, no Undo) is its only move, for anyone; nothing moves into it', () => {
    expect(TRANSITIONS[STATUS.inactive]).toEqual([STATUS.inMedical]);
    expect(canTransition(STATUS.inactive, STATUS.inMedical)).toBe(true);
    for (const to of STATUSES) if (to !== STATUS.inMedical) expect(canTransition(STATUS.inactive, to), to).toBe(false);
    for (const from of STATUSES) expect(canTransition(from, STATUS.inactive), from).toBe(false);
    expect(primaryActions(STATUS.inactive).map((a) => [a.id, a.label, a.to, a.kind, a.undoable, a.creatorOnly])).toEqual([
      ['reopen', 'Reopen', STATUS.inMedical, 'reopen', false, false],
    ]);
    expect(menuActions(STATUS.inactive, true)).toEqual([]);
    expect(changeAnswerChoices(STATUS.inactive)).toEqual([]);
    // The client never sends it, and no client kind is the auto-close.
    expect((STATUS_KINDS as readonly string[]).includes(AUTO_CLOSE_KIND)).toBe(false);
    expect(undoTarget(STATUS.inactive)).toBe(STATUS.inactive);
  });
});

describe('the stage map', () => {
  it('a status stage of its own: grey, closed, the inactive glyph, the status label', () => {
    expect(STAGE_META.inactive).toEqual({ label: 'Closed · inactive', tone: 'gray', glyph: 'inactive', bucket: 'closed' });
    const stage = displayStage(row(), { now: NOW });
    expect(stage).toMatchObject({ key: 'inactive', label: 'Closed · inactive', fullLabel: 'Closed · inactive', tone: 'gray', glyph: 'inactive', bucket: 'closed' });
    expect(stage.said).toBe('Closed, inactive');
    // No location, en route or wait follows a closed stage.
    expect(stage.extra).toBeUndefined();
    expect(displayStage(row({ enroute: { count: 1, earliestEta: iso(-4), state: 'enroute' } } as Partial<RequestSummary>), { now: NOW }).key).toBe('inactive');
    expect(stageLook(row(), NOW)).toEqual({ key: 'inactive', label: 'Closed · inactive', tone: 'gray', glyph: 'inactive', bucket: 'closed' });
    expect(stagePhrase(row(), 'America/New_York', NOW)).toBe('Closed, inactive');
  });
});

describe('the status sort order', () => {
  it('closed: folded with Archived / Closed, newest closed first; never in Waiting for check or Friend coming', () => {
    const coming = row({ status: STATUS.inMedical, closedAt: null, updatedBy: 'Rae Chen · Medical' });
    const waiting = row({ status: STATUS.waiting, closedAt: null, foundAt: null, reunionStartedAt: null });
    const inactiveOld = row({ closedAt: iso(30) });
    const reunited = row({ status: STATUS.reunited, closedAt: iso(10) });
    const inactiveNew = row({ closedAt: iso(2) });
    const groups = statusGroups([inactiveOld, coming, reunited, waiting, inactiveNew]);
    expect(groups.waiting.map((r) => r.id)).toEqual([waiting.id]);
    expect(groups.coming.map((r) => r.id)).toEqual([coming.id]);
    expect(groups.closed.map((r) => r.id)).toEqual([inactiveNew.id, reunited.id, inactiveOld.id]);
    expect(byNewestClosed(inactiveNew, inactiveOld)).toBeLessThan(0);
    expect(friendComingOrder([inactiveNew, coming]).map((r) => r.id)).toEqual([coming.id]);
    expect(waitingOrder([inactiveNew, waiting]).map((r) => r.id)).toEqual([waiting.id]);
  });
});

describe('the glyph', () => {
  const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);

  it('lucide timer-off as a bare grey outline (no circle), unlike Reunited\'s filled check', () => {
    const inactive = html(<StatusGlyph status={STATUS.inactive} />);
    expect(inactive).toContain('data-glyph="inactive"');
    expect(inactive).toContain('viewBox="0 0 24 24"');
    expect(inactive).toContain('stroke="var(--gray-9)"');
    expect(inactive).toContain('fill="none"');
    expect(inactive).toContain('d="m2 2 20 20"');
    expect(inactive).toContain('d="M10 2h4"');
    expect(inactive).not.toContain('<circle');
    expect(inactive).toContain('aria-hidden="true"');
    const reunited = html(<StatusGlyph status={STATUS.reunited} />);
    expect(reunited).toContain('data-glyph="closed"');
    expect(reunited).toContain('<circle');
    // The stage glyph is the same drawing, and a label makes it an image.
    expect(html(<StageGlyph glyph="inactive" />)).toContain('data-glyph="inactive"');
    expect(html(<StatusGlyph status={STATUS.inactive} label="Closed, inactive" />)).toContain('role="img"');
  });
});

describe('lists', () => {
  it('My requests: Logged → Checked → In medical → Closed · inactive, grey', () => {
    expect(stepperModel(STATUS.inactive)).toEqual({
      steps: ['Logged', 'Checked', 'In medical', 'Closed · inactive'],
      current: 3,
      mode: 'cur',
      color: 'var(--gray-9)',
    });
  });
});

describe('Activity and alerts', () => {
  it('closed_inactive: "Closed · inactive", the timer-off glyph in grey, normal urgency, spoken as closed', () => {
    expect(ACTIVITY_KINDS).toContain('closed_inactive');
    expect(isActivityKind('closed_inactive')).toBe(true);
    expect(inactiveDetail()).toBe('Closed · inactive');
    expect(ACTIVITY_GLYPH.closed_inactive).toEqual({ icon: 'timer-off', tone: 'gray' });
    expect(activityGlyph('closed_inactive', inactiveDetail())).toEqual({ icon: 'timer-off', tone: 'gray' });
    expect(pushUrgency('closed_inactive')).toBe('normal');
    expect(pushTtl('closed_inactive')).toBe(900);
    const payload = pushPayload({ requestId: '00000000-0000-4000-8000-000000000001', kind: 'closed_inactive', detail: inactiveDetail() }, 'S.L.', 1);
    expect(payload).toMatchObject({ title: 'S.L.', body: 'Closed · inactive', tag: 'lp-00000000-0000-4000-8000-000000000001', renotify: true, requireInteraction: false });
    const said = activityAriaLabel({ kind: 'closed_inactive', title: 'S.L.', detail: inactiveDetail(), at: iso(1), read: false }, NOW);
    expect(said).toBe('Request S L, closed: Closed, inactive. 1 minute ago. Unread.');
    // Only the server's auto-close raises it; no status route ever does.
    expect(statusChangeEvent(STATUS.inactive, null)).toBeNull();
    // The SQL whitelist takes it.
    expect(/p_kind not in \([\s\S]*?'closed_inactive'\)/.test(MIGRATION)).toBe(true);
  });

  it('the in-app alert reads the status, and a sticky "is in medical" toast closes once the request is inactive', () => {
    const r = row({ caseNumber: 1004, name: 'Sky Lane' });
    expect(statusAlert(r)).toMatchObject({ kind: 'status_changed', title: 'LP-1004 · S.L. — closed · inactive' });
    expect(alertStillCurrent('in_medical', STATUS.inMedical, r)).toBe(false);
  });
});

describe('the dashboard', () => {
  const stats = (over: Partial<Stats>): Stats => ({
    open: { waiting: 1, inMedical: 1 },
    notInMedical: 1,
    reunited: 2,
    discharged: 1,
    cancelled: 1,
    total: 9,
    longestWait: null,
    avgAnswerMinutes: null,
    avgReuniteMinutes: null,
    loggedLastHour: 0,
    byPost: [],
    recent: [],
    serverTime: iso(0),
    ...over,
  });

  it('Closed counts it; Reunited never does; a server before F6 sends nothing (0)', () => {
    expect(closedTotal(stats({ inactive: 2 }))).toBe(7);
    expect(closedTotal(stats({}))).toBe(5);
    expect(inactiveCount(stats({}))).toBe(0);
    expect(inactiveCount(stats({ inactive: 3 }))).toBe(3);
    expect(inactiveCount(stats({ inactive: Number.NaN }))).toBe(0);
    const s = stats({ inactive: 2 });
    expect(s.open.waiting + s.open.inMedical + closedTotal(s)).toBe(s.total);
  });
});

describe('the sync tells new auto-closes', () => {
  it('candidates: Closed · inactive, closed in the last 15 minutes, never another status or an old close', () => {
    const now = Date.now();
    const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
    const fresh = row({ closedAt: at(3) });
    const edge = row({ closedAt: at(14.9) });
    const old = row({ closedAt: at(16) });
    const reunited = row({ status: STATUS.reunited, closedAt: at(1) });
    const noTime = row({ closedAt: null });
    expect(inactiveCandidates([fresh, edge, old, reunited, noTime], now)).toEqual([fresh.id, edge.id]);
    expect(inactiveCandidates([], now)).toEqual([]);
  });
});
