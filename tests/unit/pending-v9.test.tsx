// Pending v9.1 (Brian 2026-11-06 19:35–20:40, design/screens/pending-v9.html): the one status order (rule 2:
// Waiting for check longest wait first, holds in place; rule 4: Friend arrived → en route → nobody; the closed
// ones newest closed first), the groups All and My requests show when sorted by status, the two-state left answer
// by hold state, the Undo bar's words, the sort toggle's words and its memory per view per device (storage
// blocked too), the folds' memory, the desk header's sort, and Pending's count. Synthetic data only.
import { Theme } from '@radix-ui/themes';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeskTable, sortHeaderLabel } from '@/components/desk/table/DeskTable';
import { CheckCard, ComingCard, holdState } from '@/components/list/cards';
import { ArchivedFold as DeskArchivedFold } from '@/components/desk/table/DeskTable';
import { logRowLabel, stageClock } from '@/components/list/list-helpers';
import { ArchivedFold, GroupDivider } from '@/components/list/rows';
import { QueueHeader } from '@/components/list/PendingQueues';
import { SORT_WORDS, sortAnnouncement, sortToggleLabel } from '@/components/list/SortToggle';
import type { RequestSummary } from '@/lib/api-types';
import { notFoundSnack } from '@/lib/client/hold';
import { pendingGroups, viewCounts } from '@/lib/client/selectors';
import {
  byFriendComing,
  comingRank,
  friendComingOrder,
  nextRecheckAt,
  oldestWaitMinutes,
  statusGroups,
  waitingOrder,
} from '@/lib/client/status-order';
import { SORT_STORAGE_KEYS, readSortOrder, waitingShowsFolded, writeSortOrder } from '@/lib/client/view-prefs';
import { StoreContext } from '@/lib/client/store-contract';
import { createStubStore } from '@/lib/client/store-stub';
import { stubRows } from '@/lib/client/stub-data';
import { NOT_FOUND_YET_LABEL, RECHECK_MINUTES, STATUS, STATUS_META, notFoundHolds } from '@/lib/domain';
import { NOT_FOUND_FINAL_LABEL, displayStage, notFoundAnswer, stageLook } from '@/lib/stages';

const NOW = Date.parse('2026-11-06T21:31:00Z'); // 4:31 PM in New York
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
const base = stubRows(NOW).find((r) => r.status === STATUS.waiting) as RequestSummary;

let seq = 0;
function row(name: string, over: Partial<RequestSummary> & Record<string, unknown> = {}): RequestSummary {
  seq += 1;
  return { ...base, id: `v9-${name}`, caseNumber: 100 + seq, name, firstName: name, lastName: null, recheckAt: null, notFoundChecks: 0, medicalLocation: null, ...over } as RequestSummary;
}
const held = (createdMin: number, heldMin: number) => ({ createdAt: at(createdMin), recheckAt: at(heldMin + RECHECK_MINUTES), notFoundChecks: 1 });
const inMed = (foundMin: number, over: Record<string, unknown> = {}) => ({
  status: STATUS.inMedical,
  createdAt: at(foundMin - 20),
  foundAt: at(foundMin),
  reunionStartedAt: at(foundMin),
  updatedAt: at(foundMin),
  ...over,
});

const PV = row('P.V.', held(-51, -11));
const SO = row('S.O.', held(-47, -15));
const MR = row('M.R.', held(-40, -25)); // due
const BW = row('B.W.', { createdAt: at(-27) });
const KT = row('K.T.', { createdAt: at(-16) });
const JD = row('J.D.', { createdAt: at(-9), needsInfo: true });
const EN = row('E.N.', { createdAt: at(-1) });
const MP = row('M.P.', inMed(-26, { enroute: { count: 0, earliestEta: null, state: 'arrived', mine: null } }));
const AL = row('A.L.', inMed(-7, { enroute: { count: 1, earliestEta: at(4), state: 'enroute', mine: null } }));
const XE = row('X.E.', inMed(-30, { enroute: { count: 1, earliestEta: null, state: 'enroute', mine: null } }));
const YE = row('Y.E.', inMed(-3, { enroute: { count: 2, earliestEta: at(2), state: 'enroute', mine: null } }));
const RP = row('R.P.', inMed(-2));
const OLD = row('O.L.', inMed(-40));
const TN = row('T.N.', { status: STATUS.notInMedical, createdAt: at(-90), updatedAt: at(-30), notFoundChecks: 2 });
const LG = row('L.G.', { status: STATUS.reunited, createdAt: at(-120), closedAt: at(-60), updatedAt: at(-60) });
const DF = row('D.F.', { status: STATUS.cancelled, createdAt: at(-130), closedAt: at(-100), updatedAt: at(-100) });

const names = (rows: readonly RequestSummary[]) => rows.map((r) => r.name);
const shuffled = [EN, MP, TN, KT, RP, MR, LG, AL, PV, DF, JD, SO, OLD, BW, XE, YE];

describe('rule 2: Waiting for check, longest wait first, holds in place', () => {
  it('every request Waiting for check (Needs info, held and due included) in one order: oldest logged first', () => {
    expect(names(waitingOrder(shuffled))).toEqual(['P.V.', 'S.O.', 'M.R.', 'B.W.', 'K.T.', 'J.D.', 'E.N.']);
    // The store's Pending groups give the same order.
    expect(names(pendingGroups(shuffled).waiting)).toEqual(['P.V.', 'S.O.', 'M.R.', 'B.W.', 'K.T.', 'J.D.', 'E.N.']);
  });

  it('nothing jumps when a recheck comes due: the order at a later clock is the same', () => {
    expect(names(waitingOrder(shuffled))).toEqual(names(waitingOrder([...shuffled].reverse())));
    expect(nextRecheckAt(shuffled, NOW)).toBe(Date.parse(at(5)));
    expect(nextRecheckAt(shuffled, Date.parse(at(30)))).toBeNull();
  });

  it('a folded Waiting header shows the oldest wait in whole minutes', () => {
    expect(oldestWaitMinutes(waitingOrder(shuffled), NOW)).toBe(51);
    expect(oldestWaitMinutes([], NOW)).toBeNull();
  });
});

describe('rule 4: Friend coming', () => {
  it('Friend arrived (earliest first) → Friend en route (soonest ETA, no ETA last) → nobody coming (longest since found)', () => {
    expect(names(friendComingOrder(shuffled))).toEqual(['M.P.', 'Y.E.', 'A.L.', 'X.E.', 'O.L.', 'R.P.']);
    expect([MP, AL, RP].map(comingRank)).toEqual([0, 1, 2]);
  });

  it('two arrivals: the arrival time when the server sends it, else since found', () => {
    const a = row('A1', inMed(-5, { enroute: { count: 0, earliestEta: null, state: 'arrived', arrivedAt: at(-1) } }));
    const b = row('A2', inMed(-2, { enroute: { count: 0, earliestEta: null, state: 'arrived', arrivedAt: at(-4) } }));
    const c = row('A3', inMed(-30, { enroute: { count: 0, earliestEta: null, state: 'arrived' } }));
    expect(names([a, b, c].sort(byFriendComing))).toEqual(['A3', 'A2', 'A1']);
  });
});

describe('status groups (All and My requests sorted by status)', () => {
  it('Waiting for check (rule 2), Friend coming (rule 4), then the closed ones newest closed first', () => {
    const g = statusGroups(shuffled);
    expect(names(g.waiting)).toEqual(['P.V.', 'S.O.', 'M.R.', 'B.W.', 'K.T.', 'J.D.', 'E.N.']);
    expect(names(g.coming)).toEqual(['M.P.', 'Y.E.', 'A.L.', 'X.E.', 'O.L.', 'R.P.']);
    expect(names(g.closed)).toEqual(['T.N.', 'L.G.', 'D.F.']);
    // Every row once.
    expect(g.waiting.length + g.coming.length + g.closed.length).toBe(shuffled.length);
  });

  it('Pending counts every request Waiting for check (held included) and every one In medical', () => {
    expect(viewCounts(shuffled, [], new Set(), null).pending).toBe(7 + 6);
  });

  it('the dividers and the desk group rows are headings named in words', () => {
    const html = renderToString(<GroupDivider group="check" count={7} />);
    expect(html).toContain('role="heading"');
    expect(html).toContain('aria-level="2"');
    expect(html).toContain('Waiting for check 7 requests');
    expect(renderToString(<GroupDivider group="coming" count={1} />)).toContain('Friend coming 1 request');
  });
});

describe('the left answer, by hold state', () => {
  it('"⧗ Pending" (the hold) until the request has a Not found; then "× Not located" (closes it)', () => {
    expect(notFoundHolds(BW)).toBe(true);
    expect(notFoundAnswer(BW)).toEqual({ kind: 'hold', label: NOT_FOUND_YET_LABEL, said: 'Pending. Keeps this request open and schedules a recheck' });
    const closes = { kind: 'close', label: NOT_FOUND_FINAL_LABEL, said: `Not located. Closes this request as ${STATUS_META[STATUS.notInMedical].label.toLowerCase()}` };
    expect(notFoundAnswer(PV)).toEqual(closes);
    expect(notFoundAnswer(MR)).toEqual(closes);
    expect(NOT_FOUND_FINAL_LABEL).toBe('Not located');
    // The card's indicator: held, then due 20 minutes after the hold.
    expect([BW, PV, MR].map((r) => holdState(r, NOW))).toEqual(['none', 'held', 'due']);
    expect(displayStage(MR, { now: NOW }).label).toBe('Recheck due');
  });

  // (F3 + F4 release) The cards read the store since F3 (the Message button, the preview row): a stub store.
  const store = createStubStore({ eventTimezone: 'America/New_York' });
  const render = (node: ReactNode) =>
    renderToString(
      <StoreContext.Provider value={store}>
        <Theme>{node}</Theme>
      </StoreContext.Provider>,
    );
  const noop = () => {};

  it('the card: the same button in both states, the chip only when held or due, the wait the only time', () => {
    const fresh = render(<CheckCard row={BW} now={NOW} offline={false} onNotInMedical={noop} onInMedical={noop} />);
    expect(fresh).toContain('data-answer="hold"');
    // (2026-11-07) The label reserves the longer label's width, so the button is as wide in both states.
    expect(fresh).toMatch(/data-size-as="Not located">Pending<\/span><\/button>/);
    expect(fresh).not.toContain('data-testid="hold-chip"');
    const heldCard = render(<CheckCard row={PV} now={NOW} offline={false} onNotInMedical={noop} onInMedical={noop} />);
    expect(heldCard).toContain('data-answer="close"');
    expect(heldCard).toMatch(/data-size-as="Not located">Not located<\/span><\/button>/);
    expect(heldCard).toContain('aria-label="Not located. Closes this request as');
    expect(heldCard).toMatch(/data-testid="hold-chip"[^>]*>(?:(?!<\/span>).)*Pending<\/span>/);
    expect(heldCard).toContain('data-hold="held"');
    const due = render(<CheckCard row={MR} now={NOW} offline={false} onNotInMedical={noop} onInMedical={noop} />);
    expect(due).toMatch(/data-due=""[^>]*data-testid="hold-chip"/);
    expect(due).toContain('Recheck due');
    expect(due).toMatch(/aria-label="M\.R\., [^."]+\. FA 4 · LP-\d{4}\. Pending, recheck due\./);
    expect(due).toMatch(/Pending, recheck due\. Waiting 40 minutes\./);
    for (const html of [heldCard, due]) expect(html.replace(/aria-label="[^"]*"/g, '')).not.toMatch(/\d:\d\d/);
  });

  it('Friend coming cards: no friend line, the minutes always grey', () => {
    const html = render(<ComingCard row={OLD} now={NOW} offline={false} onReunited={noop} onLocate={noop} />);
    expect(html).not.toContain(OLD.contactName ?? 'never');
    expect(html).not.toContain('on the way');
    expect(html).toContain('data-tone="gray" data-testid="card-minutes"');
  });

  it('the Undo bar: "Pending · recheck in 20 min", then "<full name> closed · not located"', () => {
    expect(notFoundSnack(PV, STATUS.notInMedical)).toEqual({ message: 'Pending · recheck in 20 min', said: 'Pending, recheck in 20 minutes.' });
    const words = STATUS_META[STATUS.notInMedical].label.toLowerCase();
    expect(notFoundSnack({ ...BW, name: 'Bea Walsh', status: STATUS.notInMedical }, STATUS.notInMedical)).toEqual({ message: `Bea Walsh closed · ${words}`, said: `Bea Walsh closed, ${words}.` });
    expect(notFoundSnack({ ...BW, name: '', status: STATUS.notInMedical }, STATUS.notInMedical)?.message).toMatch(/^LP-\d{4} closed · /);
    expect(notFoundSnack(BW, STATUS.inMedical)).toBeNull();
  });
});

describe('the sort toggle and the desk header', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('names the current order and what a tap does; the live region words', () => {
    expect(SORT_WORDS.all.off).toBe('Newest');
    expect(SORT_WORDS.mine.off).toBe('Updated');
    expect(sortToggleLabel('all', 'default')).toBe('Newest, newest first. Sort by status, waiting for check first');
    expect(sortToggleLabel('mine', 'default')).toBe('Updated, latest update first. Sort by status, waiting for check first');
    expect(sortToggleLabel('all', 'status')).toMatch(/^Status order, waiting for check first/);
    expect(sortAnnouncement('all', 'status')).toBe('Sorted by status');
    expect(sortAnnouncement('all', 'default')).toBe('Sorted: newest first');
    expect(sortAnnouncement('mine', 'default')).toBe('Sorted: latest update first');
  });

  it('is remembered per view on this device, and works with storage blocked', () => {
    const saved = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => saved.set(k, v), removeItem: (k: string) => saved.delete(k) },
    });
    expect(readSortOrder('all')).toBe('default');
    writeSortOrder('all', 'status');
    expect(saved.get(SORT_STORAGE_KEYS.all)).toBe('status');
    expect(readSortOrder('all')).toBe('status');
    expect(readSortOrder('mine')).toBe('default');
    writeSortOrder('all', 'default');
    expect(saved.has(SORT_STORAGE_KEYS.all)).toBe(false);
    saved.set(SORT_STORAGE_KEYS.mine, 'nonsense');
    expect(readSortOrder('mine')).toBe('default');
    vi.stubGlobal('window', {
      get localStorage(): Storage {
        throw new Error('blocked');
      },
    });
    expect(readSortOrder('all')).toBe('default');
    expect(() => writeSortOrder('all', 'status')).not.toThrow();
  });

  it('the Waiting fold: folded until the count rises above where it was folded (or has fallen to)', () => {
    expect(waitingShowsFolded({ folded: true, base: 7 }, 7)).toBe(true);
    expect(waitingShowsFolded({ folded: true, base: 7 }, 6)).toBe(true);
    expect(waitingShowsFolded({ folded: true, base: 7 }, 8)).toBe(false);
    expect(waitingShowsFolded({ folded: false, base: 0 }, 3)).toBe(false);
  });

  it('the desk header: aria-sort on the active column only, Status ↓ (other) or Created ↓ / Updated ↓ (descending)', () => {
    const onChange = () => {};
    const created = renderToString(<DeskTable sort={{ order: 'default', defaultColumn: 'created', onChange }}>{null}</DeskTable>);
    expect(created).toMatch(/role="columnheader"[^>]*data-col="created" aria-sort="descending"/);
    expect(created).not.toMatch(/data-col="status" aria-sort=/);
    expect(created).toContain('role="table"');
    const status = renderToString(<DeskTable sort={{ order: 'status', defaultColumn: 'updated', onChange }}>{null}</DeskTable>);
    expect(status).toMatch(/data-col="status" aria-sort="other"/);
    expect(status).not.toMatch(/data-col="updated" aria-sort=/);
    expect(sortHeaderLabel('status', 'Status', { order: 'default', defaultColumn: 'created' })).toBe('Status. Sort by status, waiting for check first');
    expect(sortHeaderLabel('status', 'Status', { order: 'status', defaultColumn: 'created' })).toBe('Status, sorted waiting for check first. Sort by newest');
    expect(sortHeaderLabel('created', 'Created', { order: 'default', defaultColumn: 'created' })).toBe('Created, newest first');
    expect(sortHeaderLabel('updated', 'Updated', { order: 'status', defaultColumn: 'updated' })).toBe('Updated. Sort by latest update');
    // Search has no sort: its header stays hidden from screen readers.
    expect(renderToString(<DeskTable>{null}</DeskTable>)).toMatch(/aria-hidden="true" data-testid="desk-table-columns"/);
  });

  it('Pending headers: a fold button with the count, the oldest wait when folded; a plain heading with 0', () => {
    const open = renderToString(<QueueHeader queue="check" count={7} open onToggle={() => {}} oldestWait={51} controls="c" />);
    // Named by its content: "Waiting for check 7 requests" (the label and count it shows, then the hidden word).
    const words = (html: string) => html.replace(/<span aria-hidden="true">[^<]*<\/span>/g, '').replace(/<svg[^]*?<\/svg>/g, '').replace(/<[^>]+>/g, '').replace(/<!-- -->/g, '');
    expect(open).toContain('aria-expanded="true"');
    expect(open).not.toContain('aria-label=');
    expect(words(open)).toBe('Waiting for check 7 requests');
    expect(open).not.toContain('queue-oldest-wait');
    const folded = renderToString(<QueueHeader queue="check" count={7} open={false} onToggle={() => {}} oldestWait={51} controls="c" />);
    expect(folded).toContain('aria-expanded="false"');
    expect(words(folded)).toBe('Waiting for check 7 requests, longest wait 51 minutes');
    expect(folded).toMatch(/data-tone="red" data-testid="queue-oldest-wait">.*51m/);
    const empty = renderToString(<QueueHeader queue="check" count={0} open onToggle={() => {}} controls="c" />);
    expect(empty).toContain('data-zero=""');
    expect(empty).not.toContain('<button');
    expect(empty).toContain('Waiting for check, no requests');
  });
});

describe('review fixes', () => {
  it("a log row's stage clock changes only when its stage does (memoized rows skip the 15 s ticks)", () => {
    const ticks = [NOW, NOW + 15_000, NOW + 30_000, NOW + 45_000];
    // Not held, or held and not due yet: 0 at every tick, so the row's props stay the same.
    for (const r of [BW, JD, EN, PV, SO, MP, AL, RP, TN, LG]) expect(new Set(ticks.map((t) => stageClock(r, t)))).toEqual(new Set([0]));
    // Due: its own recheck time, at every tick.
    expect(new Set(ticks.map((t) => stageClock(MR, t)))).toEqual(new Set([Date.parse(MR.recheckAt!)]));
    // And it reads exactly as the ticking clock would, before and after a hold comes due.
    for (const t of [NOW, Date.parse(PV.recheckAt!) - 1, Date.parse(PV.recheckAt!), NOW + 60 * 60_000]) {
      for (const r of shuffled) {
        expect(stageLook(r, stageClock(r, t))).toEqual(stageLook(r, t));
        expect(logRowLabel(r, '4:00 PM', 'updated 2 minutes ago', undefined, stageClock(r, t))).toBe(logRowLabel(r, '4:00 PM', 'updated 2 minutes ago', undefined, t));
      }
    }
  });

  it('the Archived / Closed folds: › while folded, ⌄ while open, never rotated (phone and desk)', () => {
    for (const Fold of [ArchivedFold, DeskArchivedFold]) {
      const folded = renderToString(<Fold count={3} open={false} controls="c" onToggle={() => {}} />);
      expect(folded).toContain('lucide-chevron-right');
      expect(folded).not.toContain('lucide-chevron-down');
      expect(folded).not.toContain('data-open');
      const open = renderToString(<Fold label="Closed" count={1} open controls="c" onToggle={() => {}} />);
      expect(open).toContain('lucide-chevron-down');
      expect(open).not.toContain('lucide-chevron-right');
      expect(open).not.toContain('data-open');
    }
  });
});
