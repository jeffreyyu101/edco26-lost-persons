// List views (agent L): the pure display helpers in components/list/list-helpers.ts, the search / filter /
// sort selectors as the lists use them, and server renders of the views against a fixed store state.
// Synthetic data only.
import { Theme } from '@radix-ui/themes';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AllView, MineView, PendingView, SearchView } from '@/components/list/ListViews';
import { switcherLabel } from '@/components/list/ViewSwitcher';
import {
  NO_NAME,
  cardDescription,
  closedFoldLabel,
  highlightParts,
  isClosed,
  isFresh,
  logNumber,
  logNumberRanges,
  logRowLabel,
  mineFreshTone,
  minutesPhrase,
  outboxDisplay,
  queuedStepper,
  resultCount,
  outboxRowLabel,
  searchDisplay,
  searchLogLabel,
  snippet,
  statusPhrase,
  statusSince,
  stepperModel,
  updatedSince,
} from '@/components/list/list-helpers';
import { formatCreatedTime } from '@/lib/format';
import type { OutboxItem, RequestSummary } from '@/lib/api-types';
import { filterAll, mineRows, pendingGroups, searchRequests, sortNewestFirst } from '@/lib/client/selectors';
import { StoreContext, createServerState, type AppStore, type StoreState } from '@/lib/client/store-contract';
import { createStubStore } from '@/lib/client/store-stub';
import { STUB_SESSION, stubRows } from '@/lib/client/stub-data';
import { STATUS, postFilterKey, statusMeta } from '@/lib/domain';

const NOW = Date.parse('2026-11-07T03:10:00Z');
const rows = stubRows(NOW);
const byCase = (n: number) => rows.find((r) => r.caseNumber === n) as RequestSummary;
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

function outboxItem(over: Partial<OutboxItem> = {}): OutboxItem {
  const id = over.mutationId ?? '0b5a3c2e-8d4f-4a1b-9c7e-2f6d8a1b3c4d';
  return {
    mutationId: id,
    payload: { clientMutationId: id, reportingLocation: 'FA 3 – Kinetic', name: 'TEST-L Queued', age: 30, gender: 'Male' },
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

// ---------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------

describe('list helpers', () => {
  it('cardDescription joins clothing, description, features and hair, skipping blanks and repeats', () => {
    expect(cardDescription({ clothing: ' Red hoodie ', physicalDescription: null, identifyingFeatures: '', hair: 'Blond' })).toBe('Red hoodie · Blond');
    expect(cardDescription({ clothing: 'Red hoodie', physicalDescription: 'red hoodie', identifyingFeatures: null, hair: null })).toBe('Red hoodie');
    expect(cardDescription({ clothing: 'Two\nlines', physicalDescription: null, identifyingFeatures: null, hair: null })).toBe('Two lines');
    expect(cardDescription({ clothing: null, physicalDescription: null, identifyingFeatures: null, hair: null })).toBe('');
  });

  it('statusSince picks the timestamp of the current status', () => {
    expect(statusSince(byCase(1012))).toBe(byCase(1012).createdAt); // waiting
    expect(statusSince(byCase(1004))).toBe(byCase(1004).reunionStartedAt); // in medical
    expect(statusSince(byCase(1005))).toBe(byCase(1005).foundAt); // legacy Bring friend, no reunion time
    expect(statusSince(byCase(1003))).toBe(byCase(1003).closedAt); // reunited
    expect(statusSince(byCase(1009))).toBe(byCase(1009).updatedAt); // not in medical
  });

  it('isFresh: the last minute only, tolerating a slightly fast database clock', () => {
    expect(isFresh(iso(0.5), NOW)).toBe(true);
    expect(isFresh(iso(2), NOW)).toBe(false);
    expect(isFresh(iso(-0.5), NOW)).toBe(true);
    expect(isFresh(iso(-5), NOW)).toBe(false);
    expect(isFresh(null, NOW)).toBe(false);
    expect(isFresh('nonsense', NOW)).toBe(false);
  });

  it('mineFreshTone: only status changes by someone else, in the last minute', () => {
    const changed = { ...byCase(1004), reunionStartedAt: iso(0.2), updatedBy: 'Rae Chen · Medical' };
    expect(mineFreshTone(changed, NOW, STUB_SESSION.staff)).toBe('green');
    expect(mineFreshTone({ ...changed, updatedBy: 'dana kim · dispatch' }, NOW, STUB_SESSION.staff)).toBeNull();
    expect(mineFreshTone({ ...changed, reunionStartedAt: iso(5) }, NOW, STUB_SESSION.staff)).toBeNull();
    expect(mineFreshTone({ ...byCase(1012), createdAt: iso(0.2) }, NOW, STUB_SESSION.staff)).toBeNull();
  });

  it('stepperModel follows the status (Not in medical ends the line)', () => {
    expect(stepperModel(STATUS.waiting)).toMatchObject({ steps: ['Logged', 'Checked', 'In medical', 'Reunited'], current: 1, mode: 'pend' });
    expect(stepperModel(STATUS.notInMedical)).toMatchObject({ steps: ['Logged', 'Checked', 'Not in medical'], current: 2, mode: 'cur' });
    expect(stepperModel(STATUS.inMedical)).toMatchObject({ current: 2, mode: 'cur', color: 'var(--green-9)' });
    expect(stepperModel(STATUS.legacyBringFriend)).toMatchObject({ current: 2, mode: 'cur' });
    expect(stepperModel(STATUS.reunited)).toMatchObject({ current: 3, mode: 'cur' });
    expect(stepperModel(STATUS.discharged).steps.at(-1)).toBe('Discharged');
    expect(stepperModel(STATUS.cancelled)).toMatchObject({ steps: ['Logged', 'Cancelled'], current: 1 });
    expect(stepperModel('Found – Transported')).toMatchObject({ steps: ['Logged', 'Found – Transported'], current: 1 });
    expect(queuedStepper(false)).toMatchObject({ current: 0, mode: 'pend', color: 'var(--gray-9)' });
    expect(queuedStepper(true).color).toBe('var(--red-9)');
  });

  it('outboxDisplay: "Not sent" until an LP number exists, Needs attention for rejected creates', () => {
    expect(outboxDisplay(outboxItem())).toEqual({
      name: 'TEST-L Queued',
      ageGender: '30 M',
      post: 'FA 3',
      caseText: 'Not sent',
      needsAttention: false,
      label: 'Waiting to send',
    });
    const other = outboxItem({
      state: 'needs_attention',
      caseNumber: 1020,
      payload: { clientMutationId: 'x', reportingLocation: 'Other', otherLocation: 'Info booth', name: null, gender: '' },
    });
    expect(outboxDisplay(other)).toMatchObject({ name: NO_NAME, ageGender: '', post: 'Info booth', caseText: 'LP-1020', label: 'Needs attention' });
  });

  it('snippet starts near the first match so the highlight is visible', () => {
    expect(snippet('Pink hat', [[0, 4]])).toEqual({ text: 'Pink hat', ranges: [[0, 4]] });
    const long = 'Last seen near the big stage by the left speaker stack wearing pink';
    const at = long.indexOf('pink');
    const s = snippet(long, [[at, at + 4]]);
    expect(s.text.startsWith('…')).toBe(true);
    expect(s.text.slice(s.ranges[0]![0], s.ranges[0]![1])).toBe('pink');
    expect(s.text.length).toBeLessThan(long.length);
    // Starts at a word boundary.
    expect(s.text[1]).not.toBe(' ');
    expect(long.includes(s.text.slice(1))).toBe(true);
  });

  it('highlightParts splits text and clamps bad ranges', () => {
    expect(highlightParts('Black tank, pink hair', [[12, 16]])).toEqual([
      { text: 'Black tank, ', hit: false },
      { text: 'pink', hit: true },
      { text: ' hair', hit: false },
    ]);
    expect(highlightParts('abc', [[2, 10], [0, 1]])).toEqual([
      { text: 'a', hit: true },
      { text: 'b', hit: false },
      { text: 'c', hit: true },
    ]);
    expect(highlightParts('abc', [])).toEqual([{ text: 'abc', hit: false }]);
  });

  it('searchDisplay highlights the name, the LP number or the matched field', () => {
    const [nameHit] = searchRequests(rows, 'kayla');
    expect(searchDisplay(nameHit!)).toMatchObject({ nameRanges: [[0, 5]], caseRanges: [], lineRanges: [] });
    expect(searchDisplay(nameHit!).line).toContain('Pink cowboy hat');
    const [lpHit] = searchRequests(rows, 'LP-1012');
    expect(searchDisplay(lpHit!)).toMatchObject({ nameRanges: [], caseRanges: [[3, 7]] });
    const hairHit = searchRequests(rows, 'braids').find((h) => h.row.caseNumber === 1012);
    expect(hairHit && searchDisplay(hairHit).lineRanges.length).toBe(1);
  });

  it('copy helpers', () => {
    expect(resultCount(1)).toBe('1 result');
    expect(resultCount(0)).toBe('0 results');
    expect(minutesPhrase(0)).toBe('less than a minute');
    expect(minutesPhrase(1)).toBe('1 minute');
    expect(minutesPhrase(125)).toBe('2 hours');
  });

  it('names start with the visible text where the label repeats it (WCAG 2.5.3)', () => {
    // axe's label-content-name-mismatch: the visible words must be a contiguous run of the name's words.
    const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
    const startsWith = (name: string, visible: string) => {
      const n = words(name);
      const v = words(visible);
      return v.every((w, i) => n[i] === w);
    };
    const d = outboxDisplay(outboxItem());
    expect(outboxRowLabel(d, '11:02 PM')).toBe('TEST-L Queued, 30 M, 11:02 PM. Waiting to send, FA 3, Not sent.');
    expect(startsWith(outboxRowLabel(d, '11:02 PM'), `${d.name} ${d.ageGender} 11:02 PM`)).toBe(true);
    expect(switcherLabel('Pending', 4)).toBe('Pending 4, change view');
    expect(switcherLabel('All requests', null)).toBe('All requests, change view');
    expect(startsWith(closedFoldLabel(6), 'Closed 6')).toBe(true);
  });

  it('updatedSince: the logger\'s own photos are part of logging; any other write is an update', () => {
    const base = { ...byCase(1013), rowVersion: 0, photoCount: 0, updatedBy: byCase(1013).createdBy };
    // Nothing written since: the timestamps decide (equal on insert).
    expect(updatedSince(base)).toBe(base.updatedAt);
    // Logged with 2 photos: the 2 uploads by the creator are not an update.
    expect(updatedSince({ ...base, rowVersion: 2, photoCount: 2 })).toBeNull();
    // A third write (an edit) is.
    expect(updatedSince({ ...base, rowVersion: 3, photoCount: 2 })).toBe(base.updatedAt);
    // Someone else's photo is.
    expect(updatedSince({ ...base, rowVersion: 1, photoCount: 1, updatedBy: 'Sam Ortiz · Medical' })).toBe(base.updatedAt);
    // Once answered, it is always updated.
    expect(updatedSince({ ...base, status: STATUS.inMedical, rowVersion: 1, photoCount: 1 })).toBe(base.updatedAt);
  });

  it('log rows: a full sentence per row, the bare number, the Closed fold name', () => {
    expect(logRowLabel(byCase(1013), '11:02 PM', 'updated 2 minutes ago')).toBe('LP-1013, T.R., Waiting for check, created 11:02 PM, updated 2 minutes ago');
    expect(logRowLabel(byCase(1004), 'Thu 9:58 PM', 'not updated yet')).toBe('LP-1004, S.L., In medical, friend coming, created Thu 9:58 PM, not updated yet');
    expect(logRowLabel({ ...byCase(1009), name: '' }, '10:44 PM', 'updated 6 minutes ago')).toBe('LP-1009, No name, Not in medical, created 10:44 PM, updated 6 minutes ago');
    expect(searchLogLabel(byCase(1012), '10:58 PM', 'not updated yet', '…pink braids')).toBe('LP-1012, Kayla Martinez, Waiting for check, created 10:58 PM, not updated yet. …pink braids');
    expect(statusPhrase(STATUS.legacyBringFriend)).toBe('In medical, friend coming');
    expect(logNumber(998)).toBe('998');
    // Search ranges in "LP-0998" / "LP-1012" map onto the bare number.
    expect(logNumberRanges(1012, [[3, 7]])).toEqual([[0, 4]]);
    expect(logNumberRanges(1012, [[3, 5]])).toEqual([[0, 2]]);
    expect(logNumberRanges(998, [[4, 7]])).toEqual([[0, 3]]);
    expect(logNumberRanges(998, [[0, 2]])).toEqual([]);
    expect(closedFoldLabel(1)).toBe('Closed 1 request');
    expect(closedFoldLabel(6)).toBe('Closed 6 requests');
    // Not in medical is closed and grey everywhere, the stepper included.
    expect(stepperModel(STATUS.notInMedical).color).toBe('var(--gray-9)');
    expect(isClosed(STATUS.notInMedical)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------
// Search / filter / sort as the lists use them
// ---------------------------------------------------------------------------------------------------

describe('search, filter and sort', () => {
  it('matches the LP number as 1012, LP-1012, lp1012 or "lp 1012"', () => {
    for (const q of ['1012', 'LP-1012', 'lp1012', 'lp 1012', ' 1012 ']) {
      const hits = searchRequests(rows, q);
      expect(hits.map((h) => h.row.caseNumber), q).toEqual([1012]);
      expect(hits[0]?.field).toBe('caseNumber');
    }
    // A zero-padded LP number (LP-0998) matches with or without the zero.
    expect(searchRequests(rows, 'LP-0998').map((h) => h.row.caseNumber)).toEqual([998]);
    // Two or more digits match as a prefix while typing.
    expect(searchRequests(rows, '101').map((h) => h.row.caseNumber)).toEqual([1013, 1012, 1011, 1010]);
  });

  it('is case-insensitive over name, clothing, last seen, description, features, hair and post', () => {
    expect(searchRequests(rows, 'PINK').map((h) => h.row.caseNumber).sort((a, b) => a - b)).toEqual([998, 1012]);
    expect(searchRequests(rows, 'ferris').map((h) => h.field)).toEqual(['lastSeen']);
    expect(searchRequests(rows, 'sleeve tattoo')[0]?.field).toBe('clothing');
    expect(searchRequests(rows, 'curly')[0]?.field).toBe('hair');
    expect(searchRequests(rows, 'info booth').map((h) => h.row.caseNumber)).toEqual([997]);
    expect(searchRequests(rows, 'oasis').every((h) => h.field === 'post')).toBe(true);
    expect(searchRequests(rows, '   ')).toEqual([]);
  });

  it('All is newest first; the status filter treats legacy Bring friend as In medical; post matches the post key', () => {
    const all = sortNewestFirst(rows);
    expect(all[0]?.caseNumber).toBe(1013);
    for (let i = 1; i < all.length; i++) expect(Date.parse(all[i - 1]!.createdAt)).toBeGreaterThanOrEqual(Date.parse(all[i]!.createdAt));
    expect(filterAll(all, { status: STATUS.inMedical, post: null }).map((r) => r.caseNumber)).toEqual([1007, 1004, 1005]);
    expect(filterAll(all, { status: STATUS.notInMedical, post: null }).map((r) => r.caseNumber)).toEqual([1009, 1008]);
    const fa3 = filterAll(all, { status: null, post: 'FA 3 – Kinetic' });
    expect(fa3.length).toBeGreaterThan(0);
    expect(fa3.every((r) => r.reportingLocation === 'FA 3 – Kinetic')).toBe(true);
    expect(filterAll(all, { status: STATUS.inMedical, post: 'FA 3 – Kinetic' }).map((r) => r.caseNumber)).toEqual([1004, 1005]);
  });

  it('a dashboard bar (post + open) lists only the open rows it counts (regression)', () => {
    const all = sortNewestFirst(rows);
    for (const post of new Set(all.map((r) => postFilterKey(r.reportingLocation, r.otherLocation)))) {
      const atPost = filterAll(all, { status: null, post });
      const open = filterAll(all, { status: null, post, open: true });
      // What lp_stats byPost counts for the bar: Waiting, In medical and legacy Bring friend at that post.
      const counted = atPost.filter((r) => [STATUS.waiting, STATUS.inMedical, STATUS.legacyBringFriend].includes(r.status as never));
      expect(open.map((r) => r.id)).toEqual(counted.map((r) => r.id));
    }
    const fa3 = filterAll(all, { status: null, post: 'FA 3 – Kinetic' });
    const fa3Open = filterAll(all, { status: null, post: 'FA 3 – Kinetic', open: true });
    expect(fa3.some((r) => statusMeta(r.status).bucket !== 'open')).toBe(true); // the fixture has closed rows there
    expect(fa3Open.length).toBeLessThan(fa3.length);
    expect(fa3Open.every((r) => statusMeta(r.status).bucket === 'open')).toBe(true);
  });

  it('Pending: Friend coming and Waiting for check, both oldest first', () => {
    const { friendComing, waiting } = pendingGroups(rows);
    expect(friendComing.map((r) => r.caseNumber)).toEqual([1005, 1004, 1007]);
    expect(waiting.map((r) => r.caseNumber)).toEqual([1010, 1011, 1012, 1013]);
  });

  it('My requests: this phone or the canonical creator, newest update first', () => {
    const mine = mineRows(rows, new Set([byCase(1013).id]), 'dana kim • dispatch');
    expect(mine[0]?.caseNumber).toBe(1013);
    expect(mine.map((r) => r.caseNumber)).toContain(1012);
    expect(mine.map((r) => r.caseNumber)).not.toContain(1011);
  });
});

// ---------------------------------------------------------------------------------------------------
// Server renders of the views (structure, order, states)
// ---------------------------------------------------------------------------------------------------

// useNow() reads the real clock during a server render, so these stores are built around the real now.
function storeWith(patch: (s: StoreState) => StoreState): AppStore {
  const base = createStubStore({ eventTimezone: 'America/New_York', now: Date.now() });
  const state = patch(base.getState());
  return { getState: () => state, subscribe: () => () => {}, actions: base.actions };
}

const render = (store: AppStore, node: ReactNode) =>
  renderToString(
    <Theme>
      <StoreContext.Provider value={store}>{node}</StoreContext.Provider>
    </Theme>,
  );

describe('list views render', () => {
  const idOf = (n: number) => `5eed0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  /** The opening tag of the element carrying data-request-id for LP-n (its class and attributes). */
  const rowTag = (html: string, n: number) => {
    const at = html.indexOf(`data-request-id="${idOf(n)}"`);
    if (at < 0) return '';
    return html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
  };

  it('All (option B): queued on top, open rows newest first, every closed one folded into "Closed N"', () => {
    const store = storeWith((s) => ({ ...s, outbox: [outboxItem(), outboxItem({ mutationId: '1b5a3c2e-8d4f-4a1b-9c7e-2f6d8a1b3c4d', state: 'needs_attention', createdAt: NOW - 120_000 })] }));
    const html = render(store, <AllView status={null} post={null} />);
    expect(html).toContain('data-testid="request-list"');
    expect(html).not.toContain('list-skeleton');
    // The large title is the view menu; no "Newest first", no separate ×, no bell, no live dot.
    expect(html).toContain('All requests');
    expect(html).toMatch(/aria-label="All requests \d+, change view"/);
    expect(html).not.toContain('Newest first');
    expect(html).not.toContain('Back to all requests');
    expect(html).not.toContain('New-request alerts');
    expect(html).not.toContain('live-dot');
    expect(html).not.toContain('connection-indicator');
    // One quiet column header.
    const cols = html.slice(html.indexOf('data-testid="log-columns"'));
    expect(cols).toMatch(/^[^]*?>#<[^]*?>Friend<[^]*?>Status<[^]*?>Created<[^]*?>Updated</);

    const queued = html.indexOf('Waiting to send');
    const attention = html.indexOf('Needs attention');
    expect(queued).toBeGreaterThan(html.indexOf('data-testid="log-columns"'));
    expect(attention).toBeGreaterThan(queued);
    // Open rows: Waiting (blue) and In medical (green), newest first, after the queued ones.
    const open = [1013, 1012, 1011, 1010, 1007, 1004, 1005];
    const at = open.map((n) => html.indexOf(`data-request-id="${idOf(n)}"`));
    expect(at[0]).toBeGreaterThan(attention);
    for (let i = 1; i < at.length; i++) expect(at[i]).toBeGreaterThan(at[i - 1]!);
    // Every closed one (Not in medical included) is folded: not rendered, counted in the fold.
    const all = [...store.getState().confirmed.values()];
    const closed = all.filter((r) => statusMeta(r.status).bucket === 'closed');
    expect(closed.map((r) => r.caseNumber)).toEqual(expect.arrayContaining([1009, 1008, 1006, 1003, 1002, 1001]));
    for (const r of closed) expect(html).not.toContain(`data-request-id="${r.id}"`);
    const fold = html.slice(html.indexOf('data-testid="closed-fold"') - 300, html.indexOf('data-testid="closed-fold"') + 600);
    expect(fold).toContain('aria-expanded="false"');
    expect(fold).toContain(`aria-label="Closed ${closed.length} requests"`);
    expect(fold).toContain(`>${closed.length}</span>`);
    expect(html.indexOf('data-testid="closed-fold"')).toBeGreaterThan(at.at(-1)!);
  });

  it('All: the Closed fold opens in place (from prefs), greyed rows newest first in the same grid', () => {
    const store = storeWith((s) => ({ ...s, prefs: { ...s.prefs, closedExpanded: true } }));
    const html = render(store, <AllView status={null} post={null} />);
    const fold = html.indexOf('data-testid="closed-fold"');
    const group = html.indexOf('data-testid="closed-rows"');
    expect(html.slice(fold - 300, fold)).toContain('aria-expanded="true"');
    expect(group).toBeGreaterThan(fold);
    // Newest created first: 38, 45, 65, 70, 82 and 93 minutes ago, then yesterday's.
    const closed = [1009, 1008, 1003, 1006, 1002, 1001, 1000];
    const at = closed.map((n) => html.indexOf(`data-request-id="${idOf(n)}"`));
    expect(at[0]).toBeGreaterThan(group);
    for (let i = 1; i < at.length; i++) expect(at[i]).toBeGreaterThan(at[i - 1]!);
    // Greyed: Not in medical and Reunited rows carry the closed style; open rows do not.
    expect(rowTag(html, 1009)).toContain('data-closed');
    expect(rowTag(html, 1003)).toContain('data-closed');
    expect(rowTag(html, 1013)).not.toContain('data-closed');
  });

  it('All rows: number, name, status, created with AM/PM, updated as "—" or a compact age; full-sentence names', () => {
    const now = Date.now();
    const store = storeWith((s) => s);
    const html = render(store, <AllView status={null} post={null} />);
    const row = (n: number) => store.getState().confirmed.get(idOf(n))!;
    // T.R. (LP-1013) was logged a minute ago and never changed: "—".
    const tr = row(1013);
    const created = formatCreatedTime(tr.createdAt, now, 'America/New_York');
    expect(created).toMatch(/^(\w{3} )?\d{1,2}:\d{2} (AM|PM)$/);
    expect(rowTag(html, 1013)).toContain(`aria-label="LP-1013, T.R., Waiting for check, created ${created}, not updated yet"`);
    const trHtml = html.slice(html.indexOf(`data-request-id="${idOf(1013)}"`), html.indexOf('</button>', html.indexOf(`data-request-id="${idOf(1013)}"`)));
    expect(trHtml).toMatch(/data-col="number"[^>]*>1013</);
    expect(trHtml).toMatch(/data-col="name"[^>]*>T\.R\.</);
    expect(trHtml).toMatch(/data-tone="blue"/);
    expect(trHtml).toContain('Waiting for check');
    expect(trHtml).toContain(`>${created}<`);
    expect(trHtml).toMatch(/data-col="updated"[^>]*data-none=""[^>]*>—</);
    // Jordan Diaz (LP-1007) moved to In medical 2 minutes ago: green, "2m" (or 1m/3m at a minute edge).
    const jd = rowTag(html, 1007);
    expect(jd).toMatch(/aria-label="LP-1007, Jordan Diaz, In medical, friend coming, created [^"]+ (AM|PM), updated [123] minutes? ago"/);
    const jdHtml = html.slice(html.indexOf(`data-request-id="${idOf(1007)}"`), html.indexOf('</button>', html.indexOf(`data-request-id="${idOf(1007)}"`)));
    expect(jdHtml).toMatch(/data-tone="green"/);
    expect(jdHtml).toMatch(/data-col="updated"[^>]*>[123]m</);
  });

  it('All filtered (status, post, open): one list, closed rows greyed in place, no fold, no queued rows', () => {
    const store = storeWith((s) => ({ ...s, outbox: [outboxItem()] }));
    const html = render(store, <AllView status={null} post="FA 3 – Kinetic" />);
    expect(html).not.toContain('data-testid="closed-fold"');
    expect(html).not.toContain('Waiting to send');
    // LP-1009 (Not in medical) and LP-1002 (Discharged) are at FA 3: listed in place, greyed.
    expect(html).toContain(`data-request-id="${idOf(1009)}"`);
    expect(rowTag(html, 1009)).toContain('data-closed');
    expect(rowTag(html, 1012)).not.toContain('data-closed');
    expect(html.indexOf(`data-request-id="${idOf(1012)}"`)).toBeLessThan(html.indexOf(`data-request-id="${idOf(1009)}"`));
    const byStatus = render(store, <AllView status={STATUS.notInMedical} post={null} />);
    expect(byStatus).not.toContain('data-testid="closed-fold"');
    expect(rowTag(byStatus, 1009)).toContain('data-closed');
  });

  it('All from a dashboard bar (post + open) shows an Open chip and a post chip with the open count', () => {
    const store = storeWith((s) => s);
    const all = [...store.getState().confirmed.values()];
    const openAtFa3 = all.filter((r) => r.reportingLocation === 'FA 3 – Kinetic' && statusMeta(r.status).bucket === 'open');
    const closedAtFa3 = all.filter((r) => r.reportingLocation === 'FA 3 – Kinetic' && statusMeta(r.status).bucket !== 'open');
    expect(closedAtFa3.length).toBeGreaterThan(0);
    const html = render(store, <AllView status={null} post="FA 3 – Kinetic" open />);
    expect(html).toContain('data-testid="open-chip"');
    expect(html).toContain('Open requests only. Clear this filter');
    expect(html).toContain(`FA 3 – Kinetic ${openAtFa3.length} shown. Clear this filter`);
    for (const r of openAtFa3) expect(html).toContain(`data-request-id="${r.id}"`);
    for (const r of closedAtFa3) expect(html).not.toContain(`data-request-id="${r.id}"`);
    // Without ?open=1 the post filter still lists every row at the post, and shows no Open chip.
    const every = render(store, <AllView status={null} post="FA 3 – Kinetic" />);
    expect(every).not.toContain('data-testid="open-chip"');
    for (const r of closedAtFa3) expect(every).toContain(`data-request-id="${r.id}"`);
  });

  it('All with a status filter shows the chip and hides the outbox', () => {
    const store = storeWith((s) => ({ ...s, outbox: [outboxItem()] }));
    const html = render(store, <AllView status={STATUS.notInMedical} post={null} />);
    expect(html).toContain('data-testid="status-chip"');
    expect(html).toContain('Not in medical 2 shown. Clear this filter');
    expect(html).not.toContain('Waiting to send');
  });

  it('skeletons only while there is no data; the error state once the empty cache is known and offline', () => {
    const loading = storeWith((s) => ({ ...s, hasData: false, hydrated: false }));
    expect(render(loading, <PendingView />)).toContain('list-skeleton');
    const failed = storeWith((s) => ({ ...s, hasData: false, hydrated: true, connection: 'error' }));
    const html = render(failed, <MineView />);
    expect(html).not.toContain('list-skeleton');
    expect(html).toContain('Can&#x27;t reach the log');
  });

  it('offline: a badge on the avatar in the header, and the banner between the header and the log', () => {
    const store = storeWith((s) => ({ ...s, connection: 'offline', outbox: [outboxItem()] }));
    const html = render(store, <AllView status={null} post={null} />);
    const title = html.indexOf('data-testid="view-switcher"');
    const avatar = html.indexOf('data-testid="account-trigger"');
    const indicator = html.indexOf('data-testid="connection-indicator"');
    const banner = html.indexOf('Offline · <!-- -->1<!-- --> waiting to send');
    const cols = html.indexOf('data-testid="log-columns"');
    expect(title).toBeGreaterThan(0);
    expect(indicator).toBeGreaterThan(avatar);
    expect(avatar).toBeGreaterThan(title);
    const badge = html.slice(html.lastIndexOf('<span', indicator), indicator + 60);
    expect(badge).toContain('role="img"');
    expect(badge).toContain('data-state="offline"');
    expect(badge).toContain('aria-label="Offline"');
    expect(banner).toBeGreaterThan(indicator);
    expect(cols).toBeGreaterThan(banner);
    // Can't reach the log: the badge turns red; live: nothing at all.
    const error = render(storeWith((s) => ({ ...s, connection: 'error' })), <PendingView />);
    expect(error).toMatch(/data-state="error"[^>]*aria-label="Can&#x27;t reach the log"|aria-label="Can&#x27;t reach the log"[^>]*data-state="error"/);
    expect(render(storeWith((s) => s), <PendingView />)).not.toContain('connection-indicator');
  });

  it('Pending and My requests use the same large title, with no separate ×', () => {
    const pending = render(storeWith((s) => s), <PendingView />);
    expect(pending).toMatch(/aria-label="Pending 7, change view"/);
    expect(pending).not.toContain('Back to all requests');
    const mine = render(storeWith((s) => s), <MineView />);
    expect(mine).toMatch(/aria-label="My requests \d+, change view"/);
  });

  it('My requests: Not in medical is closed, greyed, in the Closed area after the open requests', () => {
    // Every stub row is "mine" for this check (created by the signed-in staff).
    const store = storeWith((s) => ({ ...s, myIds: new Set([...s.confirmed.keys()]) }));
    const html = render(store, <MineView />);
    const area = html.indexOf('data-testid="mine-closed"');
    expect(area).toBeGreaterThan(0);
    const card = (n: number) => html.indexOf(`data-request-id="${idOf(n)}"`);
    for (const n of [1013, 1012, 1007, 1004]) expect(card(n)).toBeLessThan(area);
    for (const n of [1009, 1008, 1003, 1001]) expect(card(n)).toBeGreaterThan(area);
    // The Not in medical card is dimmed like every closed card.
    const tag = html.slice(html.lastIndexOf('data-testid="mine-card"', card(1009)) - 300, card(1009));
    expect(tag).toMatch(/dimCard/);
  });

  it('Pending: Friend coming cards (friend, post, time) then Waiting for check cards with both answers', () => {
    const html = render(storeWith((s) => s), <PendingView />);
    expect(html.indexOf('Friend coming')).toBeLessThan(html.indexOf('Waiting for check'));
    // (The stub's 3 minutes can read 2m: useNow's clock is read when the module loads.)
    expect(html).toMatch(/<span>Jess T\. · from FA 3 · [23]m<\/span>/);
    expect(html.match(/data-testid="check-card"/g)?.length).toBe(4);
    expect(html.match(/>Reunited</g)?.length).toBe(3);
    expect(html).toContain('Not in medical');
    // Wait badges: B.W. ~24m (red), D.F. ~16m (amber), T.R. ~1m (grey).
    expect(html).toMatch(/data-accent-color="red"[^>]*><svg.*?<\/svg>2[34]m</);
    expect(html).toMatch(/data-accent-color="amber"[^>]*><svg.*?<\/svg>1[56]m</);
    expect(html).toMatch(/data-accent-color="gray"[^>]*><svg.*?<\/svg>(now|1m)</);
  });

  it('Pending offline: answer buttons look disabled and say why', () => {
    const html = render(storeWith((s) => ({ ...s, connection: 'offline' })), <PendingView />);
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('Needs a connection');
  });

  it('My requests: queued items first, then cards with the stepper', () => {
    const store = storeWith((s) => ({ ...s, outbox: [outboxItem()] }));
    const html = render(store, <MineView />);
    expect(html.indexOf('data-testid="outbox-card"')).toBeLessThan(html.indexOf('data-testid="mine-card"'));
    expect(html).toContain('Logged');
    expect(html).toContain('data-step="pend"');
  });

  it('Search renders the count and highlights', () => {
    const html = render(storeWith((s) => s), <SearchView q="pink" />);
    expect(html).toContain('2 results');
    expect(html.match(/<mark/g)?.length).toBe(2);
    const empty = render(storeWith((s) => s), <SearchView q="" />);
    expect(empty).not.toContain('results');
  });

  it('empty states', () => {
    const empty = { ...createServerState('America/New_York'), hydrated: true, hasData: true };
    const store: AppStore = { getState: () => empty, subscribe: () => () => {}, actions: createStubStore({ eventTimezone: 'UTC' }).actions };
    expect(render(store, <AllView status={null} post={null} />)).toContain('No requests yet');
    expect(render(store, <PendingView />)).toContain('Nothing pending');
    expect(render(store, <SearchView q="zzz" />)).toContain('No matches');
  });
});
