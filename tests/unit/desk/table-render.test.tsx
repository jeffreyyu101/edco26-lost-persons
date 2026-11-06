// Server renders of the desk request table views (components/desk/table/DeskTableViews.tsx) against the
// stub store: the columns, the order (unsent, open, Archived fold), the fold's remembered state, filters and
// their chips, the selected row, My requests' closed group, search highlighting, and the loading / error /
// empty states. Synthetic data only.
import { Theme } from '@radix-ui/themes';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DeskAllTable, DeskMineTable, DeskSearchTable } from '@/components/desk/table/DeskTableViews';
import { DeskFrame } from '@/components/desk/DeskFrame';
import type { OutboxItem } from '@/lib/api-types';
import { StoreContext, type AppStore, type StoreState } from '@/lib/client/store-contract';
import { createStubStore } from '@/lib/client/store-stub';
import { STUB_SESSION, stubId } from '@/lib/client/stub-data';
import { STATUS, postFilterKey } from '@/lib/domain';

// useNow() reads the real clock during a server render (sampled when its module loaded), so the stub is
// built around the real now, half a minute back: "9m ago" in the stub then reads 9m, not 8m.
const NOW = Date.now() - 30_000;

function storeWith(patch: (s: StoreState) => StoreState = (s) => s): AppStore {
  const base = createStubStore({ eventTimezone: 'America/New_York', now: NOW });
  const state = patch(base.getState());
  return { getState: () => state, subscribe: () => () => {}, actions: base.actions };
}

const render = (store: AppStore, node: ReactNode) =>
  renderToString(
    <Theme>
      <StoreContext.Provider value={store}>
        <DeskFrame desk>{node}</DeskFrame>
      </StoreContext.Provider>
    </Theme>,
  );

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const at = (html: string, n: number) => html.indexOf(`data-request-id="${stubId(n)}"`);
/** The opening tag of LP-n's row. */
const rowTag = (html: string, n: number) => {
  const i = at(html, n);
  return i < 0 ? '' : html.slice(html.lastIndexOf('<', i), html.indexOf('>', i) + 1);
};
/** LP-n's row element, whole. */
const rowHtml = (html: string, n: number) => {
  const i = at(html, n);
  if (i < 0) return '';
  const start = html.lastIndexOf('<button', i);
  return html.slice(start, html.indexOf('</button>', i) + '</button>'.length);
};
/** The visible text of one of LP-n's cells. */
const cell = (html: string, n: number, col: string) => {
  const row = rowHtml(html, n);
  const i = row.indexOf(`data-col="${col}"`);
  if (i < 0) return null;
  const open = row.lastIndexOf('<span', i);
  // Cells hold at most two levels of spans: count to the matching close.
  let depth = 0;
  let j = open;
  do {
    const nextOpen = row.indexOf('<span', j + 1);
    const nextClose = row.indexOf('</span>', j + 1);
    if (nextOpen >= 0 && nextOpen < nextClose) {
      depth += 1;
      j = nextOpen;
    } else {
      depth -= 1;
      j = nextClose;
    }
  } while (depth >= 0 && j >= 0);
  return text(row.slice(open, j + '</span>'.length));
};

function outboxItem(over: Partial<OutboxItem> = {}): OutboxItem {
  const id = over.mutationId ?? '0b5a3c2e-8d4f-4a1b-9c7e-2f6d8a1b3c4d';
  return {
    mutationId: id,
    payload: { clientMutationId: id, reportingLocation: 'FA 3 – Kinetic', name: 'TEST-T Queued', age: '30', gender: 'Male' },
    photos: [],
    serverId: null,
    caseNumber: null,
    state: 'pending',
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    operator: { staffName: 'Dana Kim', team: 'GC/HX - Dispatch', staff: STUB_SESSION.staff },
    createdAt: NOW - 60_000,
    source: 'app',
    ...over,
  };
}

describe('All requests table', () => {
  it('renders the columns, unsent rows on top, open rows newest first, then the Archived fold (folded)', () => {
    const store = storeWith((s) => ({
      ...s,
      outbox: [outboxItem(), outboxItem({ mutationId: '1b5a3c2e-8d4f-4a1b-9c7e-2f6d8a1b3c4d', state: 'needs_attention', createdAt: NOW - 120_000 })],
    }));
    const html = render(store, <DeskAllTable status={null} post={null} />);
    expect(html).toContain('data-testid="request-list"');
    expect(html).toContain('data-desk-view="all"');
    // No phone chrome: no brand card, view menu or floating New request.
    for (const phone of ['brand-card', 'view-switcher', 'log-columns']) expect(html).not.toContain(`data-testid="${phone}"`);
    expect(html).not.toContain('>New request<');

    const cols = html.slice(html.indexOf('data-testid="desk-table-columns"'), html.indexOf('</div>', html.indexOf('data-testid="desk-table-columns"')));
    expect(text(`<x ${cols}`)).toContain('# Friend Status Post Created Updated Logged by');

    const queued = html.indexOf('Waiting to send');
    const attention = html.indexOf('Needs attention');
    expect(queued).toBeGreaterThan(html.indexOf('data-testid="desk-table-columns"'));
    expect(attention).toBeGreaterThan(queued);
    // The phone's sentences, so a spec finds an unsent row the same way at any width.
    expect(html).toMatch(/role="group" aria-label="TEST-T Queued, 30 M, [^"]+\. Waiting to send, FA 3, Not sent\."/);
    expect(html).toContain('data-outbox-id="1b5a3c2e-8d4f-4a1b-9c7e-2f6d8a1b3c4d"');

    const open = [1013, 1012, 1011, 1010, 1007, 1004, 1005].map((n) => at(html, n));
    expect(open[0]).toBeGreaterThan(attention);
    for (let i = 1; i < open.length; i++) expect(open[i]).toBeGreaterThan(open[i - 1]!);
    const fold = html.indexOf('data-testid="closed-fold"');
    expect(fold).toBeGreaterThan(open.at(-1)!);
    const foldTag = html.slice(html.lastIndexOf('<button', fold), html.indexOf('>', fold) + 1);
    expect(foldTag).toContain('aria-expanded="false"');
    expect(foldTag).toMatch(/aria-label="Archived \d+ requests"/);
    expect(foldTag).not.toContain('aria-controls');
    // Folded: no closed row is on the page.
    for (const n of [1009, 1008, 1006, 1003, 1002, 1001, 1000]) expect(at(html, n)).toBe(-1);
    expect(html).not.toContain('data-testid="closed-rows"');
  });

  it('shows each cell as the mockup does, and names each row with one sentence', () => {
    const html = render(storeWith(), <DeskAllTable status={null} post={null} />);
    expect(cell(html, 1012, 'number')).toBe('1012');
    expect(cell(html, 1012, 'friend')).toBe('Kayla Martinez 19 F');
    expect(cell(html, 1012, 'status')).toBe('Waiting for check');
    expect(cell(html, 1012, 'post')).toBe('FA 3 – Kinetic');
    expect(cell(html, 1012, 'created')).toMatch(/^(\w{3} )?\d{1,2}:\d\d (AM|PM)$/);
    expect(cell(html, 1012, 'updated')).toBe('9m');
    expect(cell(html, 1012, 'by')).toBe('Dana K. · Dispatch');
    expect(cell(html, 1013, 'updated')).toBe('—');
    expect(cell(html, 1004, 'status')).toBe('In medical');
    expect(rowTag(html, 1012)).toContain('type="button"');
    // Every visible cell is hidden from screen readers; the sentence is the row's name.
    const row = rowHtml(html, 1012);
    expect(row.match(/data-col="[a-z]+" [^>]*aria-hidden="true"|aria-hidden="true"[^>]*data-col=/g)?.length).toBe(7);
    expect(text(row)).toMatch(/^LP-1012, Kayla Martinez, 19 F, Waiting for check, created .+, updated 9 minutes ago, FA 3 – Kinetic, logged by Dana Kim, Dispatch/);
    // Tooltips: the whole attribution, and the exact time of the last change.
    expect(row).toContain('title="Dana Kim, Dispatch"');
    expect(row).toMatch(/data-col="updated"[^>]*title="Nov \d+, \d{1,2}:\d\d (AM|PM)"|title="Nov \d+, \d{1,2}:\d\d (AM|PM)"[^>]*data-col="updated"/);
  });

  it('opens the Archived fold in place from prefs, closed rows greyed, newest first', () => {
    const html = render(
      storeWith((s) => ({ ...s, prefs: { ...s.prefs, closedExpanded: true } })),
      <DeskAllTable status={null} post={null} />,
    );
    const fold = html.indexOf('data-testid="closed-fold"');
    const group = html.indexOf('data-testid="closed-rows"');
    expect(html.slice(html.lastIndexOf('<button', fold), fold)).toContain('aria-expanded="true"');
    expect(html.slice(html.lastIndexOf('<button', fold), fold)).toMatch(/aria-controls="[^"]+"/);
    expect(group).toBeGreaterThan(fold);
    expect(html.slice(html.lastIndexOf('<div', group), group)).toContain('aria-label="Archived requests"');
    const closed = [1009, 1008, 1003, 1006, 1002, 1001, 1000].map((n) => at(html, n));
    expect(closed[0]).toBeGreaterThan(group);
    for (let i = 1; i < closed.length; i++) expect(closed[i]).toBeGreaterThan(closed[i - 1]!);
    expect(rowTag(html, 1009)).toContain('data-closed');
    expect(rowTag(html, 1013)).not.toContain('data-closed');
    expect(cell(html, 1009, 'status')).toBe('Not in medical');
  });

  it('highlights the request open in the pane', () => {
    const html = render(storeWith(), <DeskAllTable status={null} post={null} selected={stubId(1004)} />);
    expect(rowTag(html, 1004)).toContain('data-selected');
    expect(rowTag(html, 1004)).toContain('aria-current="true"');
    expect(rowTag(html, 1013)).not.toContain('data-selected');
    expect(rowTag(html, 1013)).not.toContain('aria-current');
  });

  it('with a filter: one list, closed rows greyed in place, no fold and no unsent rows, and the phone\'s chips', () => {
    const store = storeWith((s) => ({ ...s, outbox: [outboxItem()] }));
    const html = render(store, <DeskAllTable status={STATUS.notInMedical} post={null} />);
    expect(html).not.toContain('data-testid="closed-fold"');
    expect(html).not.toContain('Waiting to send');
    expect(at(html, 1009)).toBeGreaterThan(0);
    expect(at(html, 1013)).toBe(-1);
    expect(html).toMatch(/aria-label="Not in medical 2 shown\. Clear this filter"[^>]*data-testid="status-chip"/);

    const post = postFilterKey('FA 4 – Oasis', null);
    const byPost = render(store, <DeskAllTable status={null} post={post} open />);
    expect(byPost).toContain('data-testid="open-chip"');
    expect(byPost).toMatch(/aria-label="FA 4 – Oasis 3 shown\. Clear this filter"[^>]*data-testid="post-chip"/);
    expect([1013, 1010, 1007].every((n) => at(byPost, n) > 0)).toBe(true);
    expect(at(byPost, 1008)).toBe(-1);

    const none = render(store, <DeskAllTable status={null} post={postFilterKey('Other', 'Nowhere')} />);
    expect(text(none)).toContain('No matching requests');
  });

  it('loading: the real column header over a skeleton; offline before any data: "Can\'t reach the log"', () => {
    const loading = render(storeWith((s) => ({ ...s, hasData: false, hydrated: false })), <DeskAllTable status={null} post={null} />);
    expect(loading).toContain('data-testid="desk-table-skeleton"');
    expect(loading).toContain('data-testid="desk-table-columns"');
    expect(loading).toContain('aria-busy="true"');
    expect(loading).not.toContain('data-request-id');

    const failed = render(storeWith((s) => ({ ...s, hasData: false, hydrated: true, connection: 'error' })), <DeskAllTable status={null} post={null} />);
    expect(text(failed)).toContain("Can't reach the log");
    expect(text(failed)).toContain('Try again');
    expect(failed).not.toContain('desk-table-skeleton');

    const empty = render(storeWith((s) => ({ ...s, confirmed: new Map(), outbox: [] })), <DeskAllTable status={null} post={null} />);
    expect(text(empty)).toContain('No requests yet');
  });

  it('offline with data: the amber banner over the table', () => {
    const html = render(storeWith((s) => ({ ...s, connection: 'offline', outbox: [outboxItem()] })), <DeskAllTable status={null} post={null} />);
    expect(text(html)).toContain('Offline · 1 waiting to send');
    expect(html.indexOf('Offline')).toBeLessThan(html.indexOf('data-testid="request-list"'));
  });
});

describe('My requests table', () => {
  it('unsent on top, then open, then a "Closed N" group (never folded), each newest update first', () => {
    const store = storeWith((s) => ({ ...s, outbox: [outboxItem()] }));
    const html = render(store, <DeskMineTable />);
    expect(html).toContain('data-desk-view="mine"');
    expect(html).not.toContain('data-testid="closed-fold"');
    const queued = html.indexOf('Waiting to send');
    // Dana Kim's (the stub session's) requests: open 1004 (3m), 1012 (9m); closed 1009, 1002, 1000.
    const open = [1004, 1012].map((n) => at(html, n));
    const group = html.indexOf('data-testid="mine-closed"');
    const closed = [1009, 1002, 1000].map((n) => at(html, n));
    expect(open[0]).toBeGreaterThan(queued);
    expect(open[1]).toBeGreaterThan(open[0]!);
    expect(group).toBeGreaterThan(open[1]!);
    expect(closed[0]).toBeGreaterThan(group);
    for (let i = 1; i < closed.length; i++) expect(closed[i]).toBeGreaterThan(closed[i - 1]!);
    expect(html.slice(html.lastIndexOf('<section', group), group)).toMatch(/aria-label="Closed, \d+"/);
    expect(text(html.slice(group, closed[0]))).toMatch(/Closed \d+/);
    // Someone else's request is not here.
    expect(at(html, 1013)).toBe(-1);

    expect(text(render(storeWith((s) => ({ ...s, confirmed: new Map(), outbox: [] })), <DeskMineTable />))).toContain('No requests yet');
  });
});

describe('Search table', () => {
  it('highlights the match: in the name, the number, or the matched text under the name', () => {
    const html = render(storeWith(), <DeskSearchTable q="pink" />);
    expect(html).toContain('data-desk-view="search"');
    // Kayla (1012, pink hat) and J.H. (998, pink hair), newest first.
    expect(at(html, 1012)).toBeGreaterThan(0);
    expect(at(html, 998)).toBeGreaterThan(at(html, 1012));
    expect(rowHtml(html, 998)).toMatch(/<mark[^>]*>pink<\/mark>/);
    expect(text(rowHtml(html, 998))).toMatch(/\. Black tank, pink hair, glitter on face/);
    expect(html).toMatch(/role="status" aria-live="polite"[^>]*>2 results</);

    const byName = render(storeWith(), <DeskSearchTable q="kayla" />);
    expect(rowHtml(byName, 1012)).toMatch(/<mark[^>]*>Kayla<\/mark>/);
    const byNumber = render(storeWith(), <DeskSearchTable q="1012" />);
    expect(cell(byNumber, 1012, 'number')).toBe('1012');
    expect(rowHtml(byNumber, 1012)).toMatch(/<mark[^>]*>1012<\/mark>/);

    expect(text(render(storeWith(), <DeskSearchTable q="zzzz-nothing" />))).toContain('No matches');
    const blank = render(storeWith(), <DeskSearchTable q="" />);
    expect(blank).not.toContain('data-request-id');
    expect(blank).not.toContain('No matches');
  });
});
