// F5: the stage system (lib/stages displayStage + STAGE_META) and the "Pending" hold on the client: every
// status × Needs info × hold (none / held / due) × en route, the colours' contrast in light and dark, the one
// 20-minute constant shared with SQL, the labels (read from STATUS_META and the action definitions, so the "Not
// found in medical" rename flows through), the optimistic overlay and Undo words, the alert, the mapper and the
// audit trail. Pending v9.1 (2026-11-06 evening) replaced F5's lanes: a due hold is the "Recheck due" stage, every
// stage of Waiting for check is followed by its wait, and Pending is tests/unit/pending-v9.test.tsx's. Synthetic
// data only.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Theme } from '@radix-ui/themes';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DeskContext } from '@/components/desk/desk-context';
import { PendingBoard } from '@/components/desk/PendingBoard';
import { DeskAllTable } from '@/components/desk/table/DeskTableViews';
import { AllView, MineView, PendingView } from '@/components/list/ListViews';
import { logRowLabel } from '@/components/list/list-helpers';
import { ProfileView } from '@/components/profile/ProfileView';
import { buildAuditTrail, holdOrigin } from '@/components/profile/audit-trail';
import type { AuditEvent, RequestSummary } from '@/lib/api-types';
import { HOLD_ALERT_UNNAMED, alertStillCurrent, diffAlerts, diffRaisedAlerts, holdAlert, statusAlert, type AlertContext } from '@/lib/client/alerts';
import { systemNotice } from '@/lib/client/system-notify';
import { holdChanged, holdSnackMessage, holdsOnNotFound, notFoundSnack, statusOverlayFields } from '@/lib/client/hold';
import { pendingGroups } from '@/lib/client/selectors';
import { StoreContext, type AppStore, type StoreState } from '@/lib/client/store-contract';
import { createStubStore } from '@/lib/client/store-stub';
import { STUB_SESSION, stubRows } from '@/lib/client/stub-data';
import { RECHECK_MINUTES, STATUS, STATUS_META, actionLabel, alertName, isHeld, isRecheckDue, primaryActions } from '@/lib/domain';
import { holdDetail } from '@/lib/hold-detail';
import { narrowStageLabel } from '@/components/list/rows';
import { STAGE_META, displayStage, notFoundAnswer, etaText, holdAnsweredAt, isMedicalTeam, shortStaffName, stageLook, stagePhrase, type StageKey, type StageSource } from '@/lib/stages';
import { formatClockAmPm } from '@/lib/format';
import { mapAudit, mapRow } from '@/lib/server/mappers';
import { notFoundDetail } from '@/lib/server/stage-notify';

const ROOT = join(__dirname, '..', '..');
const TZ = 'America/New_York';
const NOW = Date.parse('2026-11-06T21:30:00Z'); // 4:30 PM in New York
const at = (minutesFromNow: number) => new Date(NOW + minutesFromNow * 60_000).toISOString();

const rows = stubRows(NOW);
const waitingRow = rows.find((r) => r.status === STATUS.waiting) as RequestSummary;

function row(over: Partial<RequestSummary> & Record<string, unknown> = {}): RequestSummary {
  return { ...waitingRow, recheckAt: null, notFoundChecks: 0, medicalLocation: null, ...over } as RequestSummary;
}

// ---------------------------------------------------------------------------------------------------
// displayStage: every status × Needs info × hold × en route
// ---------------------------------------------------------------------------------------------------

const STATUSES_UNDER_TEST = [
  STATUS.waiting,
  STATUS.notInMedical,
  STATUS.inMedical,
  STATUS.reunited,
  STATUS.discharged,
  STATUS.cancelled,
  STATUS.legacyBringFriend,
  'Found – Transported',
] as const;
const HOLDS = { none: null, held: at(10), due: at(-3) } as const;
const ENROUTE = {
  none: null,
  enroute: { count: 1, earliestEta: at(4), state: 'enroute', mine: null },
  arrived: { count: 0, earliestEta: null, state: 'arrived', mine: null },
} as const;

function expectedKey(status: string, needsInfo: boolean, hold: keyof typeof HOLDS, enroute: keyof typeof ENROUTE): StageKey {
  switch (status) {
    case STATUS.waiting:
      if (needsInfo) return 'needsInfo';
      return hold === 'none' ? 'waiting' : hold === 'due' ? 'recheckDue' : 'notFoundYet';
    case STATUS.inMedical:
    case STATUS.legacyBringFriend:
      return enroute === 'none' ? 'inMedical' : enroute;
    case STATUS.notInMedical:
      return 'notInMedical';
    case STATUS.reunited:
      return 'reunited';
    case STATUS.discharged:
      return 'discharged';
    case STATUS.cancelled:
      return 'cancelled';
    default:
      return 'legacy';
  }
}

describe('displayStage', () => {
  const cases = STATUSES_UNDER_TEST.flatMap((status) =>
    [false, true].flatMap((needsInfo) =>
      (Object.keys(HOLDS) as Array<keyof typeof HOLDS>).flatMap((hold) =>
        (Object.keys(ENROUTE) as Array<keyof typeof ENROUTE>).map((enroute) => [status, needsInfo, hold, enroute] as const),
      ),
    ),
  );

  it.each(cases)('%s · needsInfo %s · hold %s · en route %s', (status, needsInfo, hold, enroute) => {
    const source: StageSource = {
      status,
      createdAt: at(-9),
      recheckAt: HOLDS[hold],
      notFoundChecks: hold === 'none' ? 0 : 1,
      needsInfo,
      lastMessage: needsInfo ? { by: 'Rae Chen · Medical', mine: false, text: 'Any tattoos or marks?' } : null,
      lastMessageAt: needsInfo ? at(-10) : null,
      enroute: ENROUTE[enroute],
      medicalLocation: 'Bed 3',
    };
    const stage = displayStage(source, { now: NOW, timeZone: TZ });
    const key = expectedKey(status, needsInfo, hold, enroute);
    expect(stage.key).toBe(key);
    if (key !== 'legacy') {
      expect({ label: stage.label, narrow: stage.narrow, tone: stage.tone, glyph: stage.glyph, bucket: stage.bucket }).toEqual(STAGE_META[key]);
    } else {
      expect(stage).toMatchObject({ label: 'Found – Transported', tone: 'gray', bucket: 'closed' });
    }
    // The look says the same at the same clock; with no clock a due hold reads Pending.
    expect(stageLook(source, NOW)).toMatchObject({ key, label: stage.label, tone: stage.tone, glyph: stage.glyph });
    expect(stageLook(source).key).toBe(key === 'recheckDue' ? 'notFoundYet' : key);
    // One line under the label, and what a desk cell puts after it.
    switch (key) {
      case 'waiting':
        expect([stage.sub, stage.extra]).toEqual(['9m', '· 9m']);
        break;
      case 'needsInfo':
        expect(stage.sub).toBe('Rae C. asked · 4:20 PM');
        // (Pending v9.1) Every stage of Waiting for check is followed by its wait on the desk, never a time.
        expect([stage.extra, stage.waitMinutes, stage.extraShort]).toEqual(['· 9m', 9, undefined]);
        expect(stage.said).toBe('Needs info, Rae C. asked at 4:20 PM');
        if (hold === 'none') {
          expect(stage.recheck).toBeUndefined();
        } else {
          // (F5) Needs info wins the label, and the hold goes on: the request's own block keeps its recheck time.
          const time = formatClockAmPm(HOLDS[hold] as string, TZ);
          expect({ recheck: stage.recheck, recheckAt: stage.recheckAt, due: stage.due }).toEqual({
            recheck: `Recheck ${time}`,
            recheckAt: HOLDS[hold],
            due: hold === 'due',
          });
        }
        break;
      case 'notFoundYet':
      case 'recheckDue': {
        const time = formatClockAmPm(HOLDS[hold] as string, TZ);
        // The request's block keeps the recheck time; the desk shows the wait, never the time.
        expect([stage.sub, stage.extra, stage.waitMinutes]).toEqual([`Recheck ${time}`, '· 9m', 9]);
        expect(stage.recheck).toBe(`Recheck ${time}`);
        expect(stage.due).toBe(hold === 'due');
        expect(stage.said).toBe(hold === 'due' ? 'Recheck due' : 'Pending');
        break;
      }
      case 'inMedical':
        expect([stage.sub, stage.extra]).toEqual(['Bed 3', '· Bed 3']);
        expect(stage.fullLabel).toBe(STATUS_META[STATUS.inMedical].label);
        break;
      case 'enroute':
        expect([stage.sub, stage.extra]).toEqual(['~4 min', '· ~4 min']);
        expect(stage.said).toBe('Friend en route, ETA about 4 min');
        break;
      default:
        expect(stage.extra).toBeUndefined();
    }
    // Only a request on hold carries a recheck time.
    const held = status === STATUS.waiting && hold !== 'none';
    expect(stage.recheck !== undefined).toBe(held);
    expect(stage.recheckAt !== undefined).toBe(held);
    expect(stage.said).not.toContain('·');
  });

  it('Not located after a hold says how many checks it took', () => {
    const final = displayStage({ status: STATUS.notInMedical, createdAt: at(-60), notFoundChecks: 2 }, { now: NOW, timeZone: TZ });
    expect(final.label).toBe(STATUS_META[STATUS.notInMedical].shortLabel);
    expect([final.sub, final.extra]).toEqual(['2 checks', '· 2 checks']);
    // A desk cell short of room drops it rather than cutting it.
    expect(final.extraShort).toBe('');
    // One check (Change answer from In medical) adds nothing.
    expect(displayStage({ status: STATUS.notInMedical, createdAt: at(-60), notFoundChecks: 1 }, { now: NOW }).extra).toBeUndefined();
  });

  it('rows cached before the hold existed (no recheckAt / notFoundChecks) are plain Waiting for check', () => {
    const old = { ...waitingRow } as Record<string, unknown>;
    delete old.recheckAt;
    delete old.notFoundChecks;
    expect(displayStage(old as unknown as StageSource, { now: NOW }).key).toBe('waiting');
    expect(isHeld(old as unknown as StageSource)).toBe(false);
  });

  it('helpers: the ETA, short names, the hold times, the medical side', () => {
    expect(etaText(at(4), NOW)).toBe('~4 min');
    expect(etaText(at(-1), NOW)).toBe('now');
    expect(etaText(null, NOW)).toBeNull();
    expect(shortStaffName('Rae Chen · Medical')).toBe('Rae C.');
    expect(shortStaffName('Rae')).toBe('Rae');
    expect(holdAnsweredAt({ status: STATUS.waiting, recheckAt: at(20) })).toBe(new Date(NOW).toISOString());
    expect(holdAnsweredAt({ status: STATUS.inMedical, recheckAt: at(20) })).toBeNull();
    expect(isRecheckDue({ status: STATUS.waiting, recheckAt: at(0) }, NOW)).toBe(true);
    expect(isRecheckDue({ status: STATUS.waiting, recheckAt: at(1) }, NOW)).toBe(false);
    expect(isMedicalTeam('Medical')).toBe(true);
    expect(isMedicalTeam('medical')).toBe(true);
    expect(isMedicalTeam('GC/HX - Base')).toBe(false);
    expect(isMedicalTeam(null)).toBe(false);
  });

  it('the row sentence names the stage, with the status words for status stages (no recheck time)', () => {
    expect(stagePhrase({ status: STATUS.inMedical, createdAt: at(-5) })).toBe('Located, friend coming');
    expect(stagePhrase({ status: STATUS.waiting, createdAt: at(-5), recheckAt: at(10) }, TZ)).toBe('Pending');
    expect(stagePhrase({ status: STATUS.waiting, createdAt: at(-5), recheckAt: at(-1) }, TZ, NOW)).toBe('Recheck due');
    expect(logRowLabel(row({ recheckAt: at(10), notFoundChecks: 1 }), '4:11 PM', 'updated now', TZ)).toContain(', Pending, created 4:11 PM');
    expect(logRowLabel(row({ recheckAt: at(-1), notFoundChecks: 1 }), '4:11 PM', 'updated now', TZ, NOW)).toContain(', Recheck due, created 4:11 PM');
    // Needs info on hold: Needs info (the hold's time is the request's own block's).
    expect(stagePhrase({ status: STATUS.waiting, createdAt: at(-5), recheckAt: at(10), needsInfo: true }, TZ)).toBe('Needs info');
  });
});

// ---------------------------------------------------------------------------------------------------
// Labels: from STATUS_META and the action definitions (the rename to "Not located" flows through)
// ---------------------------------------------------------------------------------------------------

describe('labels', () => {
  it('status stages take their labels from STATUS_META; the new stages are the approved words', () => {
    for (const key of ['waiting', 'inMedical', 'notInMedical', 'reunited', 'discharged', 'cancelled'] as const) {
      const status = { waiting: STATUS.waiting, inMedical: STATUS.inMedical, notInMedical: STATUS.notInMedical, reunited: STATUS.reunited, discharged: STATUS.discharged, cancelled: STATUS.cancelled }[key];
      expect(STAGE_META[key].label).toBe(STATUS_META[status].shortLabel);
      expect(STAGE_META[key].tone).toBe(STATUS_META[status].tone);
    }
    expect(STAGE_META.needsInfo.label).toBe('Needs info');
    expect(STAGE_META.notFoundYet.label).toBe('Pending');
    expect(STAGE_META.recheckDue.label).toBe('Recheck due');
    expect(STAGE_META.recheckDue.glyph).toBe('history');
    expect(STAGE_META.enroute.label).toBe('Friend en route');
    expect(STAGE_META.arrived.label).toBe('Friend arrived');
  });

  it('(message lane) the narrow labels under 430 px: Waiting, En route, Arrived, Recheck, Inactive; the rest are short already', () => {
    expect(Object.fromEntries(Object.entries(STAGE_META).filter(([, m]) => m.narrow).map(([k, m]) => [k, m.narrow]))).toEqual({
      waiting: 'Waiting',
      recheckDue: 'Recheck',
      enroute: 'En route',
      arrived: 'Arrived',
      inactive: 'Inactive',
    });
    // The log row reads them through narrowStageLabel (legacy statuses keep their label).
    for (const [key, narrow] of [['enroute', 'En route'], ['arrived', 'Arrived'], ['recheckDue', 'Recheck'], ['waiting', 'Waiting'], ['inactive', 'Inactive']] as const) {
      expect(narrowStageLabel(key)).toBe(narrow);
    }
    for (const key of ['needsInfo', 'notFoundYet', 'inMedical', 'notInMedical', 'reunited', 'discharged', 'cancelled', 'legacy'] as const) {
      expect(narrowStageLabel(key)).toBeNull();
    }
    // Every narrow label is shorter than its label.
    for (const m of Object.values(STAGE_META)) if (m.narrow) expect(m.narrow.length).toBeLessThan(m.label.length);
  });

  it('colour = meaning: blue waiting, amber needs info, violet pending, green in medical / arrived, teal en route, grey closed', () => {
    expect(Object.fromEntries(Object.entries(STAGE_META).map(([k, m]) => [k, m.tone]))).toEqual({
      waiting: 'blue',
      needsInfo: 'amber',
      notFoundYet: 'violet',
      recheckDue: 'violet',
      inMedical: 'green',
      enroute: 'teal',
      arrived: 'green',
      notInMedical: 'gray',
      reunited: 'gray',
      discharged: 'gray',
      cancelled: 'gray',
      inactive: 'gray',
    });
    for (const key of ['needsInfo', 'notFoundYet', 'recheckDue', 'enroute', 'arrived'] as const) expect(STAGE_META[key].bucket).toBe('open');
  });

  it('the answer buttons and the Undo bar (Pending v9.1): "Pending · recheck in 20 min", then "<full name> closed · …"', () => {
    const [notFound, inMedical] = primaryActions(STATUS.waiting);
    expect(notFound?.label).toBe(actionLabel('notInMedical'));
    expect(inMedical?.label).toBe(actionLabel('inMedical'));
    expect(notFoundAnswer(row()).label).toBe('Pending');
    const held = row({ recheckAt: '2026-11-06T21:40:00Z', notFoundChecks: 1 });
    expect(notFoundAnswer(held).label).toBe('Not located');
    expect(holdSnackMessage(held, STATUS.notInMedical)).toBe(`Pending · recheck in ${RECHECK_MINUTES} min`);
    expect(holdSnackMessage(held, STATUS.inMedical)).toBeNull();
    expect(holdSnackMessage(row(), STATUS.notInMedical)).toBeNull();
    const closed = row({ name: 'Bea Walsh', status: STATUS.notInMedical, notFoundChecks: 2 });
    const words = STATUS_META[STATUS.notInMedical].label.toLowerCase();
    expect(notFoundSnack(closed, STATUS.notInMedical)).toEqual({ message: `Bea Walsh closed · ${words}`, said: `Bea Walsh closed, ${words}.` });
  });

  it('the notification detail: "Pending · recheck 4:40 PM", or the final status label from STATUS_META', () => {
    expect(notFoundDetail(row({ recheckAt: '2026-11-06T21:40:00Z', notFoundChecks: 1 }), TZ)).toBe('Pending · recheck 4:40 PM');
    expect(notFoundDetail(row({ status: STATUS.notInMedical, notFoundChecks: 2 }), TZ)).toBe(STATUS_META[STATUS.notInMedical].label);
    expect(notFoundDetail(row(), TZ)).toBeNull();
    // One builder for the server's detail and the client's alert.
    expect(notFoundDetail(row({ recheckAt: '2026-11-06T21:40:00Z', notFoundChecks: 1 }), TZ)).toBe(holdDetail('2026-11-06T21:40:00Z', TZ));
  });
});

// ---------------------------------------------------------------------------------------------------
// One constant: RECHECK_MINUTES = lp_stages_recheck_minutes()
// ---------------------------------------------------------------------------------------------------

describe('the 20-minute hold', () => {
  const sql = readFileSync(join(ROOT, 'supabase/migrations/20261106000000_rework.sql'), 'utf8');

  it('TypeScript and SQL share one value', () => {
    const m = /create or replace function public\.lp_stages_recheck_minutes\(\)[\s\S]*?\$fn\$\s*select (\d+)\s*\$fn\$/.exec(sql);
    expect(m?.[1]).toBe(String(RECHECK_MINUTES));
    expect(RECHECK_MINUTES).toBe(20);
    // lp_set_status uses the function, never a second literal.
    const fn = sql.slice(sql.indexOf('create function public.lp_set_status('), sql.indexOf('-- lp_update_fields:'));
    expect(fn).toContain('public.lp_stages_recheck_minutes()');
    expect(fn).not.toMatch(/interval '20 minutes'/);
  });

  it('the migration is additive: the columns are added if missing, never altered', () => {
    expect(sql).toContain('alter table public.patients add column if not exists recheck_at timestamptz;');
    expect(sql).toContain('alter table public.patients add column if not exists not_found_checks smallint not null default 0;');
    expect(sql).not.toMatch(/alter table public\.patients\s+alter column (recheck_at|not_found_checks)/);
    expect(sql).toMatch(/'recheck_at', p\.recheck_at,\s*'not_found_checks', p\.not_found_checks/);
  });
});

// ---------------------------------------------------------------------------------------------------
// Contrast (spec §7: 4.5:1 text, 3:1 glyphs), light and dark, from the Radix Themes tokens the app uses
// ---------------------------------------------------------------------------------------------------

type Rgba = [number, number, number, number];
function radixScale(color: string): Record<'light' | 'dark', Record<string, Rgba>> {
  const css = readFileSync(join(ROOT, 'node_modules/@radix-ui/themes/tokens/colors', `${color}.css`), 'utf8');
  const out: Partial<Record<'light' | 'dark', Record<string, Rgba>>> = {};
  for (const [, selector = '', body = ''] of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    const theme = selector.includes('.dark') ? 'dark' : selector.includes(':root') ? 'light' : null;
    if (!theme || out[theme]) continue;
    const vars: Record<string, Rgba> = {};
    for (const [, name = '', hex = ''] of body.matchAll(/--([\w-]+):\s*#([0-9a-fA-F]{6,8})/g)) {
      vars[name] = [0, 2, 4, 6].map((i) => (i < hex.length ? parseInt(hex.slice(i, i + 2), 16) : 255)) as Rgba;
    }
    if (Object.keys(vars).length > 0) out[theme] = vars;
  }
  return out as Record<'light' | 'dark', Record<string, Rgba>>;
}
const over = (fg: Rgba, bg: Rgba): Rgba => {
  const a = fg[3] / 255;
  return [0, 1, 2].map((i) => fg[i]! * a + bg[i]! * (1 - a)).concat(255) as Rgba;
};
const luminance = (c: Rgba) =>
  [0, 1, 2]
    .map((i) => {
      const v = c[i]! / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    })
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
const contrast = (a: Rgba, b: Rgba) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

describe('STAGE_META contrast', () => {
  const gray = radixScale('gray');
  const tones = [...new Set(Object.values(STAGE_META).map((m) => m.tone))];
  for (const theme of ['light', 'dark'] as const) {
    const page: Rgba = theme === 'light' ? [255, 255, 255, 255] : gray.dark['gray-1']!;
    const panel: Rgba = theme === 'light' ? [255, 255, 255, 255] : gray.dark['gray-2']!;
    it.each(tones)(`${theme}: %s labels on the page and cards, and on the detail block's tint`, (tone) => {
      const s = radixScale(tone)[theme];
      // List rows and card lines: step 11 on the page and on the solid card.
      expect(contrast(s[`${tone}-11`]!, page)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(s[`${tone}-11`]!, panel)).toBeGreaterThanOrEqual(4.5);
      // The detail block (step a3 tint): its label is step 12 (Radix highContrast).
      expect(contrast(s[`${tone}-12`]!, over(s[`${tone}-a3`]!, page))).toBeGreaterThanOrEqual(4.5);
      // Chips (step a4 tint on a card): step 12 in light, step 11 in dark (list.module.css .stageChip, .rc).
      const chipText = theme === 'light' ? s[`${tone}-12`]! : s[`${tone}-11`]!;
      expect(contrast(chipText, over(s[`${tone}-a4`]!, panel))).toBeGreaterThanOrEqual(4.5);
      // The line glyphs (hourglass, walking figure, check, the "?" ring) are step 11: 3:1 for graphics.
      expect(contrast(s[`${tone}-11`]!, page)).toBeGreaterThanOrEqual(3);
    });
  }
});

// ---------------------------------------------------------------------------------------------------
// The tap before the server answers, and the 409 retry
// ---------------------------------------------------------------------------------------------------

describe('optimistic hold', () => {
  it('a first Not found keeps the status and goes on hold; a Not found on a held request closes it', () => {
    expect(holdsOnNotFound(row(), 'answer')).toBe(true);
    const first = statusOverlayFields(row(), STATUS.notInMedical, 'answer', NOW);
    expect(first.status).toBeUndefined();
    expect(first).toEqual({ recheckAt: at(RECHECK_MINUTES), notFoundChecks: 1 });
    const held = row({ recheckAt: at(5), notFoundChecks: 1 });
    expect(holdsOnNotFound(held, 'answer')).toBe(false);
    expect(statusOverlayFields(held, STATUS.notInMedical, 'answer', NOW)).toEqual({ status: STATUS.notInMedical, recheckAt: null });
    expect(statusOverlayFields(held, STATUS.inMedical, 'answer', NOW)).toEqual({ status: STATUS.inMedical, recheckAt: null });
    // An Undo back to Not found (of Back to Waiting) is never a hold.
    expect(holdsOnNotFound(row(), 'undo')).toBe(false);
  });

  it('an Undo overlays the hold fields the undone change replaced (Pending v9.1): the card comes back as the server restores it', () => {
    const closed = row({ status: STATUS.notInMedical, recheckAt: null, notFoundChecks: 2 });
    expect(statusOverlayFields(closed, STATUS.waiting, 'undo', NOW, { recheckAt: at(5), notFoundChecks: 1 })).toEqual({
      status: STATUS.waiting,
      recheckAt: at(5),
      notFoundChecks: 1,
    });
    const held = row({ recheckAt: at(5), notFoundChecks: 1 });
    expect(statusOverlayFields(held, STATUS.waiting, 'undo', NOW, { recheckAt: null, notFoundChecks: 0 })).toEqual({ status: STATUS.waiting, recheckAt: null, notFoundChecks: 0 });
    // Without a record (an older caller) only the status, as before.
    expect(statusOverlayFields(closed, STATUS.waiting, 'undo', NOW)).toEqual({ status: STATUS.waiting });
  });

  it('a hold that moved under a tap blocks the resend of a Not found', () => {
    expect(holdChanged(row(), row({ recheckAt: at(20), notFoundChecks: 1 }))).toBe(true);
    expect(holdChanged(row(), row())).toBe(false);
    const cached = { ...waitingRow } as Record<string, unknown>;
    delete cached.recheckAt;
    delete cached.notFoundChecks;
    expect(holdChanged(cached as unknown as RequestSummary, row())).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------
// The in-app alert for front of house
// ---------------------------------------------------------------------------------------------------

describe('alerts', () => {
  const ctx = (): AlertContext => ({ sessionStaff: STUB_SESSION.staff, myIds: new Set(), ownMutationIds: new Set(), ownKeys: new Set(), bell: false, seen: new Set(), timeZone: TZ });
  const RAE = 'Rae Chen · Medical';

  it('my request going on hold (someone else, status unchanged) alerts once: the full name, "Pending · recheck 4:50 PM"', () => {
    const before = row({ createdBy: STUB_SESSION.staff, rowVersion: 3 });
    const after = row({ createdBy: STUB_SESSION.staff, rowVersion: 4, updatedBy: RAE, recheckAt: at(20), notFoundChecks: 1 });
    const c = ctx();
    const alerts = diffAlerts(new Map([[before.id, before]]), [after], c);
    expect(alerts).toEqual([holdAlert(after, TZ)]);
    expect(alerts[0]).toMatchObject({ kind: 'status_changed', requestId: after.id, title: alertName(after.name), subtitle: 'Pending · recheck 4:50 PM' });
    expect(diffAlerts(new Map([[before.id, before]]), [after], c)).toEqual([]);
    // Not mine, or by me: nothing.
    expect(diffAlerts(new Map([[before.id, before]]), [{ ...after, createdBy: 'Lee Park · GC/HX - Base' }], ctx())).toEqual([]);
    expect(diffAlerts(new Map([[before.id, before]]), [{ ...after, updatedBy: STUB_SESSION.staff }], ctx())).toEqual([]);
  });

  it('no LP number in the hold alert or its system notification (contract B, recheck-6.png)', () => {
    const held = row({ createdBy: STUB_SESSION.staff, rowVersion: 4, updatedBy: RAE, recheckAt: at(20), notFoundChecks: 1 });
    const alert = holdAlert(held, TZ);
    const notice = systemNotice(alert, () => held);
    expect({ title: notice.title, body: notice.body, tag: notice.tag, url: notice.url }).toEqual({
      title: alertName(held.name),
      body: 'Pending · recheck 4:50 PM',
      tag: `lp-${held.id}`,
      url: `/?r=${held.id}`,
    });
    for (const text of [alert.title, alert.subtitle, notice.title, notice.body]) expect(text).not.toMatch(/LP-?\d/);
    // No name: "Request", never the number.
    expect(holdAlert({ ...held, name: '' }, TZ).title).toBe(HOLD_ALERT_UNNAMED);
  });

  it('the hold alert closes when its Undo takes the hold away (status unchanged), and an Undo that puts it back reads "Pending"', () => {
    const before = row({ createdBy: STUB_SESSION.staff, rowVersion: 3 });
    const heldRow = row({ createdBy: STUB_SESSION.staff, rowVersion: 4, updatedBy: RAE, recheckAt: at(20), notFoundChecks: 1 });
    const undone = row({ createdBy: STUB_SESSION.staff, rowVersion: 5, updatedBy: RAE, recheckAt: null, notFoundChecks: 0 });
    const [raised] = diffRaisedAlerts(new Map([[before.id, before]]), [heldRow], ctx());
    expect(raised).toMatchObject({ status: STATUS.waiting, held: true });
    expect(alertStillCurrent(raised!.alert.kind, raised!.status, heldRow, raised!.held)).toBe(true);
    // Still held once due: still current.
    expect(alertStillCurrent(raised!.alert.kind, raised!.status, { ...heldRow, recheckAt: at(-1) }, raised!.held)).toBe(true);
    // The Undo: the same status, the hold gone. The alert (toast and system notification) is out of date.
    expect(alertStillCurrent(raised!.alert.kind, raised!.status, undone, raised!.held)).toBe(false);
    // Undoing that Undo raises nothing new for the status (unchanged) but the hold alert again.
    expect(diffAlerts(new Map([[undone.id, undone]]), [{ ...heldRow, rowVersion: 6 }], ctx())).toEqual([holdAlert(heldRow, TZ)]);
    // An Undo of the final Not found (or of In medical) puts the hold back: "Pending", not "waiting for check".
    const final = row({ createdBy: STUB_SESSION.staff, status: STATUS.notInMedical, rowVersion: 6, recheckAt: null, notFoundChecks: 2 });
    const back = { ...heldRow, rowVersion: 7 };
    const [again] = diffRaisedAlerts(new Map([[final.id, final]]), [back], ctx());
    expect(again).toMatchObject({ alert: holdAlert(back, TZ), status: STATUS.waiting, held: true });
    expect(statusAlert(back, TZ)).toEqual(holdAlert(back, TZ));
    // A plain "waiting for check" alert goes out of date when the request then goes on hold.
    const [plain] = diffRaisedAlerts(new Map([[final.id, final]]), [{ ...undone, rowVersion: 7 }], ctx());
    expect(plain).toMatchObject({ status: STATUS.waiting, held: false });
    expect(alertStillCurrent(plain!.alert.kind, plain!.status, heldRow, plain!.held)).toBe(false);
    // Callers that do not track the hold keep the status-only rule.
    expect(alertStillCurrent('status_changed', STATUS.waiting, undone)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------
// Server mapping and the audit trail
// ---------------------------------------------------------------------------------------------------

describe('mapper and audit trail', () => {
  it('lp_row → recheckAt / notFoundChecks; a database without them maps to not held', () => {
    expect(mapRow({ id: 'x', status: STATUS.waiting, recheck_at: '2026-11-06T21:40:00+00:00', not_found_checks: 1 })).toMatchObject({
      recheckAt: '2026-11-06T21:40:00+00:00',
      notFoundChecks: 1,
    });
    expect(mapRow({ id: 'x', status: STATUS.waiting })).toMatchObject({ recheckAt: null, notFoundChecks: 0 });
  });

  const ev = (id: string, minute: number, prev: Record<string, unknown>, next: Record<string, unknown>): AuditEvent =>
    mapAudit({ id, action_type: 'status_changed', staff_name: 'Rae Chen · Medical', previous_value: prev, new_value: next, occurred_at: at(minute) });
  const hold = ev(
    'h',
    -20,
    { status: STATUS.waiting, recheck_at: null, not_found_checks: 0 },
    { status: STATUS.waiting, kind: 'answer', held: true, answer: 'not_found', recheck_at: '2026-11-06T21:30:00+00:00', not_found_checks: 1, row_version: 4 },
  );
  const final = ev(
    'f',
    -1,
    { status: STATUS.waiting, recheck_at: '2026-11-06T21:30:00+00:00', not_found_checks: 1 },
    { status: STATUS.notInMedical, kind: 'answer', recheck_at: null, not_found_checks: 2 },
  );

  it('status events carry the hold; older events map exactly as before', () => {
    expect(hold).toMatchObject({ action: 'status', next: { status: STATUS.waiting, kind: 'answer', held: true, hold: { recheckAt: '2026-11-06T21:30:00+00:00', checks: 1 } } });
    expect(final).toMatchObject({ previous: { status: STATUS.waiting, hold: { checks: 1 } }, next: { status: STATUS.notInMedical } });
    const legacy = ev('l', -5, { status: STATUS.waiting }, { status: STATUS.inMedical, kind: 'answer' });
    expect(legacy).toEqual({ id: 'l', at: at(-5), staff: 'Rae Chen · Medical', notes: null, action: 'status', previous: { status: STATUS.waiting }, next: { status: STATUS.inMedical, kind: 'answer' } });
  });

  it('the trail reads "Waiting for check → Pending · Recheck 4:30 PM", then "Pending → Not located"', () => {
    const items = buildAuditTrail([hold, final], TZ);
    expect(items[1]?.status).toMatchObject({ fromLabel: STATUS_META[STATUS.waiting].shortLabel, toLabel: 'Pending', toGlyph: 'hourglass', toTone: 'violet' });
    expect(items[1]?.note).toBe('Recheck 4:30 PM');
    expect(items[0]?.status).toMatchObject({ fromLabel: 'Pending', fromGlyph: 'hourglass', toLabel: STATUS_META[STATUS.notInMedical].shortLabel });
    expect(holdOrigin([hold, final])).toEqual({ staffName: 'Rae Chen', at: at(-20) });
  });
});

// ---------------------------------------------------------------------------------------------------
// Renders: the list status cell, the desk status cell, Pending's lanes, the detail block, My requests
// ---------------------------------------------------------------------------------------------------

const RECHECK_NOW = Date.now();
const soon = (minutes: number) => new Date(RECHECK_NOW + minutes * 60_000).toISOString();

function storeWith(patch: (rows: RequestSummary[]) => RequestSummary[], session: Partial<StoreState['session']> = {}): AppStore {
  const base = createStubStore({ eventTimezone: TZ, now: RECHECK_NOW });
  const state = base.getState();
  const patched = patch([...state.confirmed.values()]);
  const next: StoreState = {
    ...state,
    confirmed: new Map(patched.map((r) => [r.id, r])),
    session: { ...state.session, ...session },
  };
  return { getState: () => next, subscribe: () => () => {}, actions: base.actions };
}

const render = (store: AppStore, node: ReactNode, desk = false) =>
  renderToString(
    <Theme>
      <StoreContext.Provider value={store}>
        <DeskContext.Provider value={desk}>{node}</DeskContext.Provider>
      </StoreContext.Provider>
    </Theme>,
  );

/** Holds the first two Waiting requests of the stub: one due, one later. */
function heldStore(session: Partial<StoreState['session']> = {}) {
  let n = 0;
  return storeWith(
    (all) =>
      all.map((r) => {
        if (r.status !== STATUS.waiting || n >= 2) return r;
        n += 1;
        return { ...r, recheckAt: n === 1 ? soon(-2) : soon(12), notFoundChecks: 1 };
      }),
    session,
  );
}

describe('renders', () => {
  it('All (phone): a held request reads "Pending" (violet hourglass), a due one "Recheck due" (violet history), never "Waiting"', () => {
    const store = heldStore();
    const held = [...store.getState().confirmed.values()].filter((r) => isHeld(r));
    expect(held).toHaveLength(2);
    const html = render(store, <AllView status={null} post={null} />);
    for (const r of held) {
      const due = isRecheckDue(r, RECHECK_NOW);
      const i = html.indexOf(`data-request-id="${r.id}"`);
      const rowHtml = html.slice(i, html.indexOf('</button>', i));
      expect(rowHtml).toContain('data-tone="violet"');
      expect(rowHtml).toContain(due ? 'data-glyph="history"' : 'data-glyph="hourglass"');
      expect(rowHtml).toContain(due ? '>Recheck due<' : '>Pending<');
      expect(rowHtml).not.toContain('Waiting');
      expect(rowHtml).not.toMatch(/recheck at/);
    }
  });

  it('desk table: "Pending · 12m" / "Recheck due · 40m": the wait after the label, never the recheck time', () => {
    const store = heldStore();
    const held = [...store.getState().confirmed.values()].filter((r) => isHeld(r));
    const html = render(store, <DeskAllTable status={null} post={null} />, true);
    for (const r of held) {
      const i = html.indexOf(`data-request-id="${r.id}"`);
      const cell = html.slice(html.indexOf('data-col="status"', i), html.indexOf('data-col="post"', i)).replace(/<[^>]+>/g, '');
      const label = isRecheckDue(r, RECHECK_NOW) ? 'Recheck due' : 'Pending';
      expect(cell).toMatch(new RegExp(`${label}· (now|\\d+m)<`));
      expect(cell).not.toContain(formatClockAmPm(r.recheckAt as string, TZ));
    }
  });

  it('Pending (phone): held and due requests stay in Waiting for check in wait order, with their chips; no Later', () => {
    const store = heldStore({ team: 'Medical', staff: 'Rae Chen · Medical', staffName: 'Rae Chen' });
    const html = render(store, <PendingView />);
    const waiting = pendingGroups([...store.getState().confirmed.values()]).waiting;
    const order = [...html.matchAll(/data-testid="check-card" data-pending-card="([^"]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(waiting.map((r) => r.id));
    expect(html).not.toContain('data-testid="later-group"');
    expect(html).not.toContain('data-testid="recheck-chip"');
    expect(html).toContain('>Recheck due<');
    expect(html).toMatch(/data-testid="hold-chip"[^>]*>(?:(?!<\/span>).)*Pending<\/span>/);
  });

  it('desk board: the same cards in the Waiting for check column', () => {
    const store = heldStore();
    const waiting = pendingGroups([...store.getState().confirmed.values()]).waiting;
    const html = render(
      store,
      <PendingBoard
        waiting={waiting}
        coming={[]}
        now={RECHECK_NOW}
        offline={false}
        leaving={{ items: waiting.map((r) => ({ row: r, leaving: false })), mark: () => {}, unmark: () => {} }}
        onNotFound={() => {}}
        onInMedical={() => {}}
        onReunited={() => {}}
        onLocate={() => {}}
      />,
      true,
    );
    expect(html).toContain('data-testid="pending-column-check"');
    expect(html).toContain('data-testid="hold-chip"');
    expect(html).not.toContain('data-testid="later-group"');
  });

  it('the request (medical): violet block, "Pending · not located yet", "Medical rechecks 4:40 PM", and the answers inside the block', () => {
    const store = heldStore({ team: 'Medical', staff: 'Rae Chen · Medical', staffName: 'Rae Chen' });
    const held = [...store.getState().confirmed.values()].find((r) => isHeld(r) && Date.parse(r.recheckAt!) > RECHECK_NOW)!;
    const html = render(store, <ProfileView id={held.id} />);
    const i = html.indexOf('data-testid="status-block"');
    const block = html.slice(html.lastIndexOf('<div', i), html.indexOf('data-testid="person-details"') > 0 ? html.indexOf('data-testid="person-details"') : i + 4000);
    expect(block).toContain('data-tone="violet"');
    // (2026-11-08, Pending clarity) The block says what the hold means; lists keep "Pending".
    expect(block).toContain('>Pending · not located yet<');
    expect(block).toMatch(new RegExp(`data-testid="recheck-text"[^>]*>Medical rechecks(<!-- -->)? <b>${formatClockAmPm(held.recheckAt!, TZ)}</b>`));
    // (Pending v9.1 GLYPHS) Recheck is lucide history, as on the chip and the heading; refresh-cw is the live line's.
    const recheck = block.slice(block.indexOf('data-testid="recheck-row"'), block.indexOf('data-testid="recheck-row"') + 1200);
    expect(recheck).toContain('lucide-history');
    expect(block).not.toContain('lucide-refresh-cw');
    expect(block).toContain('data-testid="block-answers"');
    // (Pending v9.1) Held: the left answer is the final "Not located".
    expect(block).toContain('>Not located<');
    expect(block).toContain(`>${actionLabel('inMedical')}<`);
    // No second set of answers at the foot.
    expect(html).not.toContain('data-testid="profile-actions"');
  });

  it('the request (front of house): the same block without answers in it; the bar keeps them', () => {
    const store = heldStore();
    const held = [...store.getState().confirmed.values()].find((r) => isHeld(r))!;
    const html = render(store, <ProfileView id={held.id} />);
    expect(html).not.toContain('data-testid="block-answers"');
    expect(html).toContain('data-testid="recheck-row"');
    expect(html).toContain('data-testid="profile-actions"');
  });

  it('Needs info on hold: the request\'s recheck row keeps the time; the My requests card and the desk cell show none (v9.1)', () => {
    const store = storeWith((all) => {
      const mineId = all.find((r) => r.createdBy === STUB_SESSION.staff && r.status !== STATUS.cancelled)!.id;
      return all.map((r) =>
        r.id === mineId
          ? {
              ...r,
              status: STATUS.waiting,
              closedAt: null,
              recheckAt: soon(12),
              notFoundChecks: 1,
              needsInfo: true,
              lastMessage: { by: 'Rae Chen · Medical', mine: false, text: 'Any tattoos?' },
              lastMessageAt: soon(-1),
            }
          : r,
      );
    });
    const held = [...store.getState().confirmed.values()].find((r) => isHeld(r))!;
    const time = formatClockAmPm(held.recheckAt!, TZ);
    const profile = render(store, <ProfileView id={held.id} />);
    expect(profile).toContain('data-stage="needsInfo"');
    // (2026-11-08) The same hold row as Pending's: "Medical rechecks 4:40 PM", the minutes left and the bar.
    expect(profile).toMatch(new RegExp(`data-testid="recheck-row"[\\s\\S]*?Medical rechecks(<!-- -->)? <b>${time}</b>`));
    expect(profile).toContain('data-testid="recheck-bar"');
    const mine = render(store, <MineView />);
    const i = mine.indexOf(`data-request-id="${held.id}"`);
    const next = mine.indexOf('data-testid="mine-card"', i + 1);
    const card = mine.slice(mine.lastIndexOf('data-testid="mine-card"', i), next > 0 ? next : undefined);
    expect(card).toMatch(/data-testid="stage-chip"[^>]*>.*Needs info/);
    expect(card).toMatch(/data-testid="hold-chip"[^>]*>(?:(?!<\/span>).)*Pending<\/span>/);
    expect(card).not.toContain(time);
    expect(card).toMatch(/aria-label="[^"]*Needs info, Rae C\. asked at [^"]*, pending, waiting /);
    const desk = render(store, <DeskAllTable status={null} post={null} />, true);
    const j = desk.indexOf(`data-request-id="${held.id}"`);
    const cell = desk.slice(desk.indexOf('data-col="status"', j), desk.indexOf('data-col="post"', j));
    expect(cell).not.toContain('lucide-refresh-cw');
    expect(cell).toContain('>Needs info<');
    expect(cell).toMatch(/class="[^"]*stx[^"]*"[^>]*>· \d+m</);
    expect(cell).not.toContain(time);
  });

  it('My requests: the wait in the corner and the violet "Pending" chip under the name; no recheck time', () => {
    // One of this phone's own requests, put on hold.
    const store = storeWith((all) => {
      const mineId = all.find((r) => r.createdBy === STUB_SESSION.staff && r.status !== STATUS.cancelled)!.id;
      return all.map((r) => (r.id === mineId ? { ...r, status: STATUS.waiting, recheckAt: soon(12), notFoundChecks: 1, closedAt: null } : r));
    });
    const held = [...store.getState().confirmed.values()].find((r) => isHeld(r))!;
    const html = render(store, <MineView />);
    const i = html.indexOf(`data-request-id="${held.id}"`);
    const card = html.slice(html.lastIndexOf('data-testid="mine-card"', i), html.indexOf('data-testid="mine-card"', i + 1) > 0 ? html.indexOf('data-testid="mine-card"', i + 1) : undefined);
    expect(card).toMatch(/data-testid="hold-chip"[^>]*>(?:(?!<\/span>).)*Pending<\/span>/);
    expect(card).not.toContain('data-testid="stage-chip"');
    expect(card).not.toContain(`Recheck ${formatClockAmPm(held.recheckAt!, TZ)}`);
    expect(card).toMatch(/aria-label="[^"]*\. Pending, waiting /);
  });
});
