// Pending clarity on the request page (Brian 2026-11-08, mockup approved in chat; design/DECISIONS.md "Request page
// tonight, and no Arrived" row 7): a hold's status block reads "Pending · not located yet" with "First check · Rae C. ·
// 12:52" under it, and the row "Medical rechecks 1:12 AM" with "in 14 min" at its right over a bar that fills over the
// 20-minute hold; once due "Recheck due · not located yet" and "Medical recheck was due 1:12 AM" · "3 min ago", no bar.
// Screen readers hear sentences. Lists, cards, toasts and notifications keep the short "Pending" (the Undo bar's
// "Pending · recheck in 20 min" is tests/unit/stages.test.tsx's).
// lib/stages recheckCountdown + displayStage, and server renders of the request and the lists against the stub store.
// Synthetic data only.
import { Theme } from '@radix-ui/themes';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AllView, MineView } from '@/components/list/ListViews';
import { ProfileView } from '@/components/profile/ProfileView';
import type { RequestSummary } from '@/lib/api-types';
import { StoreContext, type AppStore } from '@/lib/client/store-contract';
import { createStubStore } from '@/lib/client/store-stub';
import { STUB_SESSION } from '@/lib/client/stub-data';
import { NOT_FOUND_YET_LABEL, RECHECK_MINUTES, STATUS } from '@/lib/domain';
import { formatClockAmPm, formatCreatedTime, formatListTime } from '@/lib/format';
import { NOT_LOCATED_YET, RECHECK_DUE_LABEL, displayStage, recheckCountdown, stageLook, stagePhrase } from '@/lib/stages';

const TZ = 'America/New_York';
const AT = Date.parse('2026-11-08T06:12:00Z'); // 1:12 AM in New York
const MIN = 60_000;

describe('recheckCountdown', () => {
  it('while held: "Medical rechecks 1:12 AM", whole minutes left rounded up, and the share of the 20 minutes gone', () => {
    expect(recheckCountdown(new Date(AT).toISOString(), AT - 14 * MIN, TZ)).toEqual({
      due: false,
      lead: 'Medical rechecks',
      time: '1:12 AM',
      when: 'in 14 min',
      said: 'Medical rechecks at 1:12 AM, in 14 minutes.',
      progress: expect.closeTo(0.3, 6),
    });
    // 13 min 1 s left reads 14; never "in 0 min".
    expect(recheckCountdown(new Date(AT).toISOString(), AT - 13 * MIN - 1_000, TZ)?.when).toBe('in 14 min');
    const last = recheckCountdown(new Date(AT).toISOString(), AT - 20_000, TZ)!;
    expect([last.when, last.said, last.due]).toEqual(['in 1 min', 'Medical rechecks at 1:12 AM, in 1 minute.', false]);
    // The bar: empty at the first Not found, full at the recheck time.
    expect(recheckCountdown(new Date(AT).toISOString(), AT - RECHECK_MINUTES * MIN, TZ)?.progress).toBe(0);
    expect(recheckCountdown(new Date(AT).toISOString(), AT - 30 * MIN, TZ)?.progress).toBe(0);
    expect(recheckCountdown(new Date(AT).toISOString(), AT - 5 * MIN, TZ)?.progress).toBe(0.75);
  });

  it('once due: "Medical recheck was due 1:12 AM", how long ago (rounded down), full', () => {
    const due = (ms: number) => recheckCountdown(new Date(AT).toISOString(), AT + ms, TZ)!;
    expect(due(0)).toEqual({
      due: true,
      lead: 'Medical recheck was due',
      time: '1:12 AM',
      when: 'now',
      said: 'Medical recheck was due at 1:12 AM, just now.',
      progress: 1,
    });
    expect([due(3 * MIN + 59_000).when, due(3 * MIN + 59_000).said]).toEqual(['3 min ago', 'Medical recheck was due at 1:12 AM, 3 minutes ago.']);
    expect(due(MIN).said).toBe('Medical recheck was due at 1:12 AM, 1 minute ago.');
    expect([due(60 * MIN).when, due(60 * MIN).said]).toEqual(['1 h ago', 'Medical recheck was due at 1:12 AM, 1 hour ago.']);
    expect([due(125 * MIN).when, due(125 * MIN).said]).toEqual(['2 h 5 min ago', 'Medical recheck was due at 1:12 AM, 2 hours 5 minutes ago.']);
  });

  it('an unreadable time has no row', () => {
    expect(recheckCountdown('not a time', AT, TZ)).toBeNull();
  });
});

describe('the stage', () => {
  const held = (minutesToRecheck: number) => ({
    status: STATUS.waiting,
    createdAt: new Date(AT - 30 * MIN).toISOString(),
    recheckAt: new Date(AT).toISOString(),
    notFoundChecks: 1,
    now: AT - minutesToRecheck * MIN,
  });

  it('the request block says what the hold means; the label, the look and the sentence stay short', () => {
    for (const [minutes, label, full] of [
      [14, NOT_FOUND_YET_LABEL, `Pending · ${NOT_LOCATED_YET}`],
      [-3, RECHECK_DUE_LABEL, `Recheck due · ${NOT_LOCATED_YET}`],
    ] as const) {
      const { now, ...row } = held(minutes);
      const stage = displayStage(row, { now, timeZone: TZ });
      expect(stage.fullLabel).toBe(full);
      expect(stage.label).toBe(label);
      expect(stage.said).toBe(label);
      expect(stageLook(row, now).label).toBe(label);
      expect(stagePhrase(row, TZ, now)).toBe(label);
    }
    expect(NOT_FOUND_YET_LABEL).toBe('Pending');
  });
});

// ---------------------------------------------------------------------------------------------------
// Server renders: the request's block, and the lists that keep "Pending"
// ---------------------------------------------------------------------------------------------------

const NOW = Date.now();
const iso = (minutes: number) => new Date(NOW + minutes * MIN).toISOString();

/** The stub store with this phone's first own Waiting request put on hold, its recheck `minutes` from now. */
function heldStore(minutes: number): { store: AppStore; row: RequestSummary } {
  const base = createStubStore({ eventTimezone: TZ, now: NOW });
  const state = base.getState();
  const all = [...state.confirmed.values()];
  const mine = all.find((r) => r.createdBy === STUB_SESSION.staff && r.status !== STATUS.cancelled)!;
  const recheckAt = iso(minutes);
  // The first Not found, by Rae Chen, is the row's last change: the block shows it before the audit trail loads.
  const answeredAt = iso(minutes - RECHECK_MINUTES);
  const row: RequestSummary = {
    ...mine,
    status: STATUS.waiting,
    closedAt: null,
    recheckAt,
    notFoundChecks: 1,
    needsInfo: false,
    updatedAt: answeredAt,
    updatedBy: 'Rae Chen · Medical',
  };
  const next = { ...state, confirmed: new Map(all.map((r) => [r.id, r.id === row.id ? row : r])) };
  return { store: { getState: () => next, subscribe: () => () => {}, actions: base.actions }, row };
}

const render = (store: AppStore, node: ReactNode) =>
  renderToString(
    <Theme>
      <StoreContext.Provider value={store}>{node}</StoreContext.Provider>
    </Theme>,
  );

/** The status block's HTML. */
function blockOf(html: string): string {
  const i = html.indexOf('data-testid="status-block"');
  const end = html.indexOf('data-testid="person-details"', i);
  return html.slice(html.lastIndexOf('<div', i), end > 0 ? end : i + 6000);
}

describe('the request page', () => {
  it('held: "Pending · not located yet", "First check · Rae C. · 12:52", "Medical rechecks 1:12 AM" · "in 13 min" and the bar', () => {
    // 12.5 minutes: whole minutes left read 13 whatever the few milliseconds between here and the render.
    const { store, row } = heldStore(12.5);
    const block = blockOf(render(store, <ProfileView id={row.id} />));
    const time = formatClockAmPm(row.recheckAt!, TZ);
    expect(block).toContain('data-stage="notFoundYet"');
    expect(block).toContain('data-tone="violet"');
    expect(block).toMatch(/aria-hidden="true" data-testid="status-label"[^>]*>Pending · not located yet</);
    expect(block).toContain('>Pending, not located yet.<');
    expect(block).toMatch(new RegExp(`data-testid="status-sub"[^>]*>First check · Rae C\\. · ${formatListTime(row.updatedAt, NOW, TZ)}<`));
    expect(block).toContain(`>First check by Rae C. at ${formatCreatedTime(row.updatedAt, NOW, TZ)}.<`);
    expect(block).toMatch(new RegExp(`data-testid="recheck-text"[^>]*>Medical rechecks(<!-- -->)? <b>${time}</b>`));
    expect(block).toMatch(/data-testid="recheck-when"[^>]*>in 13 min</);
    expect(block).toContain(`>Medical rechecks at ${time}, in 13 minutes.<`);
    // 7.5 of the 20 minutes gone.
    const progress = Number(/data-testid="recheck-bar" data-progress="([\d.]+)"/.exec(block)?.[1]);
    expect(progress).toBeCloseTo(0.375, 2);
    expect(block).not.toContain('Recheck due');
  });

  it('due: "Recheck due · not located yet", "Medical recheck was due 1:12 AM" · "3 min ago", no bar', () => {
    const { store, row } = heldStore(-3.5);
    const block = blockOf(render(store, <ProfileView id={row.id} />));
    const time = formatClockAmPm(row.recheckAt!, TZ);
    expect(block).toContain('data-stage="recheckDue"');
    expect(block).toMatch(/data-testid="status-label"[^>]*>Recheck due · not located yet</);
    expect(block).toContain('>Recheck due, not located yet.<');
    expect(block).toMatch(/data-testid="recheck-row"[^>]*data-due=""|data-due="" data-testid="recheck-row"/);
    expect(block).toMatch(new RegExp(`data-testid="recheck-text"[^>]*>Medical recheck was due(<!-- -->)? <b>${time}</b>`));
    expect(block).toMatch(/data-testid="recheck-when"[^>]*>3 min ago</);
    expect(block).toContain(`>Medical recheck was due at ${time}, 3 minutes ago.<`);
    expect(block).not.toContain('data-testid="recheck-bar"');
  });

  it('the lists keep the short "Pending" and never the long wording', () => {
    for (const minutes of [12.5, -3.5]) {
      const { store } = heldStore(minutes);
      for (const view of [<MineView key="mine" />, <AllView key="all" status={null} post={null} open={false} />]) {
        const html = render(store, view);
        expect(html).toContain(minutes > 0 ? '>Pending<' : '>Recheck due<');
        expect(html).not.toContain(NOT_LOCATED_YET);
        expect(html).not.toContain('Medical rechecks');
      }
    }
  });
});
