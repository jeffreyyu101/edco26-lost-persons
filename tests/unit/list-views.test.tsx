// List views (agent L): the pure display helpers in components/list/list-helpers.ts, the search / filter /
// sort selectors as the lists use them, and server renders of the views against a fixed store state.
// Synthetic data only.
import { STUB_EVENT } from '@/lib/client/stub-data';
import { Theme } from '@radix-ui/themes';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeskContext } from '@/components/desk/desk-context';
import { ConnectionIndicator } from '@/components/list/AppHeader';
import { HIDE_HEADER_LABEL } from '@/components/list/BrandCard';
import { ConnectionBanner } from '@/components/ui/Banner';
import { AllView, MineView, PendingView, SearchView } from '@/components/list/ListViews';
import { switcherLabel } from '@/components/list/ViewSwitcher';
import {
  NO_NAME,
  archivedFoldLabel,
  cardDescription,
  highlightParts,
  isClosed,
  isFresh,
  logNumber,
  logNumberRanges,
  logRowLabel,
  markCount,
  messageMark,
  messagesSentence,
  mineFreshTone,
  narrowStatusLabel,
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
  unreadTotal,
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
    expect(statusSince(byCase(1009))).toBe(byCase(1009).updatedAt); // not located
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

  it('stepperModel follows the status (Not located ends the line)', () => {
    expect(stepperModel(STATUS.waiting)).toMatchObject({ steps: ['Logged', 'Checked', 'Located', 'Reunited'], current: 1, mode: 'pend' });
    expect(stepperModel(STATUS.notInMedical)).toMatchObject({ steps: ['Logged', 'Checked', 'Not located'], current: 2, mode: 'cur' });
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
    expect(outboxDisplay(outboxItem(), STUB_EVENT.posts)).toEqual({
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
    const d = outboxDisplay(outboxItem(), STUB_EVENT.posts);
    expect(outboxRowLabel(d, '11:02 PM')).toBe('TEST-L Queued, 30 M, 11:02 PM. Waiting to send, FA 3, Not sent.');
    expect(startsWith(outboxRowLabel(d, '11:02 PM'), `${d.name} ${d.ageGender} 11:02 PM`)).toBe(true);
    expect(switcherLabel('Pending', 4)).toBe('Pending 4, change view');
    expect(switcherLabel('All requests', null)).toBe('All requests, change view');
    expect(startsWith(archivedFoldLabel(6), 'Archived 6')).toBe(true);
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

  it('log rows: a full sentence per row, the bare number, the Archived fold name', () => {
    expect(logRowLabel(byCase(1013), '11:02 PM', 'updated 2 minutes ago')).toBe('LP-1013, T.R., Waiting for check, created 11:02 PM, updated 2 minutes ago');
    expect(logRowLabel(byCase(1004), 'Thu 9:58 PM', 'not updated yet')).toBe('LP-1004, S.L., Located, friend coming, created Thu 9:58 PM, not updated yet');
    expect(logRowLabel({ ...byCase(1009), name: '' }, '10:44 PM', 'updated 6 minutes ago')).toBe('LP-1009, No name, Not located, created 10:44 PM, updated 6 minutes ago');
    expect(searchLogLabel(byCase(1012), '10:58 PM', 'not updated yet', '…pink braids')).toBe('LP-1012, Kayla Martinez, Waiting for check, created 10:58 PM, not updated yet. …pink braids');
    expect(statusPhrase(STATUS.legacyBringFriend)).toBe('Located, friend coming');
    expect(logNumber(998)).toBe('998');
    // Search ranges in "LP-0998" / "LP-1012" map onto the bare number.
    expect(logNumberRanges(1012, [[3, 7]])).toEqual([[0, 4]]);
    expect(logNumberRanges(1012, [[3, 5]])).toEqual([[0, 2]]);
    expect(logNumberRanges(998, [[4, 7]])).toEqual([[0, 3]]);
    expect(logNumberRanges(998, [[0, 2]])).toEqual([]);
    expect(archivedFoldLabel(1)).toBe('Archived 1 request');
    expect(archivedFoldLabel(6)).toBe('Archived 6 requests');
    // On a narrow phone only the long labels get shorter, so the name keeps its room (review fix). (2026-11-07)
    // "Not located" is short already: it reads the same there (it was "Not found in medical", narrow "Not found").
    expect(narrowStatusLabel(STATUS.waiting)).toBe('Waiting');
    expect(narrowStatusLabel(STATUS.inactive)).toBe('Inactive');
    for (const st of [STATUS.notInMedical, STATUS.inMedical, STATUS.legacyBringFriend, STATUS.reunited, STATUS.discharged, STATUS.cancelled, 'Some legacy value']) {
      expect(narrowStatusLabel(st)).toBeNull();
    }
    // Not located is closed and grey everywhere, the stepper included.
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

  it('matches the medical location ("Chair 14", Pending v8), also on rows cached without the field', () => {
    const located = rows.map((r) => (r.caseNumber === 1004 ? { ...r, medicalLocation: 'Beach chair 14' } : r));
    const hits = searchRequests(located, 'chair 14');
    expect(hits.map((h) => [h.row.caseNumber, h.field, h.text])).toEqual([[1004, 'medicalLocation', 'Beach chair 14']]);
    expect(searchDisplay(hits[0]!).line).toBe('Beach chair 14');
    // The stub rows carry no medicalLocation key at all (like a phone's cache from before): no throw, no hit.
    expect(rows.every((r) => !('medicalLocation' in r))).toBe(true);
    expect(searchRequests(rows, 'chair')).toEqual([]);
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

describe('the message lane (msg-indicator.html, Brian 2026-11-07, with his override: no involved gate)', () => {
  it('the mark: the blue bubble whenever unread > 0, else the grey outline while there are messages, else nothing', () => {
    // Unread for me (the server's count never includes my own messages): blue, the unread count, for everyone.
    expect(messageMark({ messageCount: 3, unread: 2 })).toEqual({ kind: 'unread', count: 2, text: '2' });
    expect(messageMark({ messageCount: 3, unread: 1, involved: false } as Parameters<typeof messageMark>[0])).toEqual({ kind: 'unread', count: 1, text: '1' });
    // A dispatcher who never opened the thread still sees it blue (Brian: "even a dispatcher thats fine").
    expect(messageMark({ messageCount: 4, unread: 4 })?.kind).toBe('unread');
    // Read (my reply is the latest, or I read them all): the outline, no number.
    expect(messageMark({ messageCount: 5, unread: 0 })).toEqual({ kind: 'read', count: 5 });
    // No messages, and rows cached before F3 (no activity fields): nothing.
    expect(messageMark({ messageCount: 0, unread: 0 })).toBeNull();
    expect(messageMark({})).toBeNull();
    // A bad count never draws a mark.
    expect(messageMark({ messageCount: -1, unread: -2 })).toBeNull();
    // Unread wins even when the total is missing.
    expect(messageMark({ unread: 3 })).toEqual({ kind: 'unread', count: 3, text: '3' });
  });

  it('the count caps at "99+" from 100 (the 31 px lane fits "99+" and nothing wider)', () => {
    expect([1, 9, 12, 99, 100, 101, 1234].map(markCount)).toEqual(['1', '9', '12', '99', '99+', '99+', '99+']);
    expect(messageMark({ messageCount: 140, unread: 120 })).toEqual({ kind: 'unread', count: 120, text: '99+' });
  });

  it('the sentences: " N unread message(s)." / " N message(s)." / nothing; the row keeps its LP number', () => {
    expect(messagesSentence({ messageCount: 3, unread: 1 })).toBe(' 1 unread message.');
    expect(messagesSentence({ messageCount: 3, unread: 2 })).toBe(' 2 unread messages.');
    expect(messagesSentence({ messageCount: 1, unread: 0 })).toBe(' 1 message.');
    expect(messagesSentence({ messageCount: 4, unread: 0 })).toBe(' 4 messages.');
    expect(messagesSentence({ messageCount: 0, unread: 0 })).toBe('');
    expect(messagesSentence({})).toBe('');
    // The spoken count is the real one, never the visual cap.
    expect(messagesSentence({ messageCount: 150, unread: 120 })).toBe(' 120 unread messages.');

    const tr = byCase(1013);
    expect(logRowLabel({ ...tr, messageCount: 3, unread: 2 }, '11:02 PM', 'updated 2 minutes ago')).toBe(
      'LP-1013, T.R., Waiting for check, created 11:02 PM, updated 2 minutes ago. 2 unread messages.',
    );
    expect(logRowLabel({ ...tr, messageCount: 4, unread: 0 }, '11:02 PM', 'updated 2 minutes ago')).toBe(
      'LP-1013, T.R., Waiting for check, created 11:02 PM, updated 2 minutes ago. 4 messages.',
    );
    expect(logRowLabel({ ...tr, messageCount: 0, unread: 0 }, '11:02 PM', 'updated 2 minutes ago')).toBe('LP-1013, T.R., Waiting for check, created 11:02 PM, updated 2 minutes ago');
    // Search: the matched text gets its full stop when the lane's sentence follows it.
    const kayla = byCase(1012);
    expect(searchLogLabel({ ...kayla, messageCount: 2, unread: 1 }, '10:58 PM', 'not updated yet', '…pink braids')).toBe(
      'LP-1012, Kayla Martinez, Waiting for check, created 10:58 PM, not updated yet. …pink braids. 1 unread message.',
    );
    expect(searchLogLabel({ ...kayla, messageCount: 2, unread: 0 }, '10:58 PM', 'not updated yet', '')).toBe(
      'LP-1012, Kayla Martinez, Waiting for check, created 10:58 PM, not updated yet. 2 messages.',
    );
    expect(searchLogLabel({ ...kayla, messageCount: 2, unread: 0 }, '10:58 PM', 'not updated yet', 'Any tattoos?')).toBe(
      'LP-1012, Kayla Martinez, Waiting for check, created 10:58 PM, not updated yet. Any tattoos? 2 messages.',
    );
  });

  it('the folded Archived row: the hidden rows\' unread total, in its lane and its name', () => {
    expect(unreadTotal([{ unread: 1 }, { unread: 2 }, {}, { unread: 0 }])).toBe(3);
    expect(archivedFoldLabel(6, 'Archived', 3)).toBe('Archived 6 requests. 3 unread messages.');
    expect(archivedFoldLabel(1, 'Archived', 1)).toBe('Archived 1 request. 1 unread message.');
    expect(archivedFoldLabel(6, 'Archived', 0)).toBe('Archived 6 requests');
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
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const idOf = (n: number) => `5eed0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  /** The opening tag of the element carrying data-request-id for LP-n (its class and attributes). */
  const rowTag = (html: string, n: number) => {
    const at = html.indexOf(`data-request-id="${idOf(n)}"`);
    if (at < 0) return '';
    return html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
  };
  /**
   * What a screen reader says for LP-n's row (it has no aria-label): its content minus everything marked
   * aria-hidden, which leaves the one screen-reader-only sentence.
   */
  const spoken = (html: string, n: number) => {
    const at = html.indexOf(`data-request-id="${idOf(n)}"`);
    const button = html.slice(html.indexOf('>', at) + 1, html.indexOf('</button>', at));
    // Each aria-hidden cell is a top-level child of the row: drop it with everything inside it.
    let out = button;
    for (;;) {
      const start = out.search(/<span [^>]*aria-hidden="true"[^>]*>/);
      if (start < 0) break;
      let depth = 0;
      let i = start;
      const tag = /<\/?span\b[^>]*>/g;
      tag.lastIndex = start;
      for (let m = tag.exec(out); m; m = tag.exec(out)) {
        depth += m[0].startsWith('</') ? -1 : 1;
        if (depth === 0) {
          i = m.index + m[0].length;
          break;
        }
      }
      out = out.slice(0, start) + out.slice(i);
    }
    return out
      .replace(/<[^>]+>/g, '')
      .replace(/&#x27;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
  };
  /** LP-n's message lane: '' (empty), 'read', or 'unread:<text>'; null without a lane. */
  const laneOf = (html: string, n: number) => {
    const at = html.indexOf(`data-request-id="${idOf(n)}"`);
    const button = html.slice(at, html.indexOf('</button>', at));
    const m = /<span class="([^"]*)" data-lane=""([^>]*)>([^]*?)<span [^>]*data-col="name"/.exec(button);
    if (!m) return null;
    const attrs = m[2]!;
    expect(attrs).toContain('aria-hidden="true"');
    if (!attrs.includes('data-mark=')) return '';
    expect(attrs).toContain('data-thread-badge=""');
    if (attrs.includes('data-mark="read"')) {
      expect(m[3]).toContain('lucide-message-square');
      return 'read';
    }
    return `unread:${/>([^<]*)<\/span><\/span>$/.exec(m[3]!.trim())?.[1] ?? '?'}`;
  };
  /** LP-n's cell in one column, as HTML (cells hold no nested data-col). */
  const cellHtml = (html: string, n: number, col: string) => {
    const at = html.indexOf(`data-request-id="${idOf(n)}"`);
    const button = html.slice(at, html.indexOf('</button>', at));
    const start = button.indexOf(`data-col="${col}"`);
    if (start < 0) return null;
    const cell = button.slice(button.indexOf('>', start) + 1);
    // The cell ends where the next column starts.
    const end = cell.search(/<span [^>]*data-col="/);
    return end < 0 ? cell : cell.slice(0, end);
  };
  const text = (cell: string) =>
    cell
      .replace(/<svg[^]*?<\/svg>/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/<!-- -->/g, '')
      .trim();
  /**
   * What LP-n's row shows in one column from 400 px up: the cell's text without the screen-reader-only words
   * and without the narrow-phone label.
   */
  const shown = (html: string, n: number, col: string) => {
    const cell = cellHtml(html, n, col);
    if (cell === null) return null;
    return text(cell.replace(/<span class="[^"]*vh[^"]*">[^<]*<\/span>/g, '').replace(/<span class="[^"]*stNarrow[^"]*"[^>]*>[^<]*<\/span>/g, ''));
  };
  /** The status label LP-n's row shows under 430 px instead ("Waiting"), or null when it keeps its label. */
  const narrow = (html: string, n: number) => {
    const cell = cellHtml(html, n, 'status') ?? '';
    const m = /<span class="[^"]*stNarrow[^"]*"[^>]*>([^<]*)<\/span>/.exec(cell);
    if (!m) return null;
    // Narrow and wide labels come as a pair, so CSS can show exactly one of them.
    expect(cell).toMatch(/<span class="[^"]*stWide[^"]*">[^<]+<\/span>/);
    return m[1];
  };

  it('All (option B): queued on top, open rows newest first, every closed one folded into "Archived N"', () => {
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
    // One quiet column header. "Created" and "Updated" are one pair over both time columns, so the wider
    // "Updated" never sizes its column on its own (review fix: it took the names' room). (Message lane) No # and
    // nothing over the lane: an empty first cell.
    const cols = html.slice(html.indexOf('data-testid="log-columns"'));
    expect(cols).toMatch(/^[^>]*><span class="[^"]*c1[^"]*"><\/span><span class="[^"]*c2[^"]*">Friend<[^]*?>Status<[^]*?>Created<[^]*?>Updated</);
    expect(cols.slice(0, cols.indexOf('Updated'))).not.toContain('>#<');
    expect(cols).toMatch(/^[^]*?<span class="[^"]*c45[^"]*"><span>Created<\/span><span>Updated<\/span><\/span>/);

    const queued = html.indexOf('Waiting to send');
    const attention = html.indexOf('Needs attention');
    expect(queued).toBeGreaterThan(html.indexOf('data-testid="log-columns"'));
    expect(attention).toBeGreaterThan(queued);
    // Open rows: Waiting (blue) and In medical (green), newest first, after the queued ones.
    const open = [1013, 1012, 1011, 1010, 1007, 1004, 1005];
    const at = open.map((n) => html.indexOf(`data-request-id="${idOf(n)}"`));
    expect(at[0]).toBeGreaterThan(attention);
    for (let i = 1; i < at.length; i++) expect(at[i]).toBeGreaterThan(at[i - 1]!);
    // Every closed one (Not located included) is folded: not rendered, counted in the fold.
    const all = [...store.getState().confirmed.values()];
    const closed = all.filter((r) => statusMeta(r.status).bucket === 'closed');
    expect(closed.map((r) => r.caseNumber)).toEqual(expect.arrayContaining([1009, 1008, 1006, 1003, 1002, 1001]));
    for (const r of closed) expect(html).not.toContain(`data-request-id="${r.id}"`);
    const fold = html.slice(html.indexOf('data-testid="closed-fold"') - 300, html.indexOf('</button>', html.indexOf('data-testid="closed-fold"')));
    expect(fold).toContain('aria-expanded="false"');
    // (Message lane) Named by its content: the visible "Archived N" is hidden from screen readers, one sentence says it.
    expect(fold).not.toContain('aria-label=');
    expect(fold).toMatch(new RegExp(`class="[^"]*vh[^"]*">Archived ${closed.length} requests</span>`));
    expect(fold).toMatch(new RegExp(`aria-hidden="true">Archived</span><span[^>]*aria-hidden="true">${closed.length}</span>`));
    expect(fold).not.toContain('>Closed<');
    expect(html.indexOf('data-testid="closed-fold"')).toBeGreaterThan(at.at(-1)!);
  });

  it('All: the Archived fold opens in place (from prefs), greyed rows newest first in the same grid', () => {
    const store = storeWith((s) => ({ ...s, prefs: { ...s.prefs, closedExpanded: true } }));
    const html = render(store, <AllView status={null} post={null} />);
    const fold = html.indexOf('data-testid="closed-fold"');
    const group = html.indexOf('data-testid="closed-rows"');
    expect(html.slice(fold - 300, fold)).toContain('aria-expanded="true"');
    expect(group).toBeGreaterThan(fold);
    expect(html.slice(html.lastIndexOf('<div', group), group)).toContain('aria-label="Archived requests"');
    // Newest created first: 38, 45, 65, 70, 82 and 93 minutes ago, then yesterday's.
    const closed = [1009, 1008, 1003, 1006, 1002, 1001, 1000];
    const at = closed.map((n) => html.indexOf(`data-request-id="${idOf(n)}"`));
    expect(at[0]).toBeGreaterThan(group);
    for (let i = 1; i < at.length; i++) expect(at[i]).toBeGreaterThan(at[i - 1]!);
    // Greyed: Not located and Reunited rows carry the closed style; open rows do not.
    expect(rowTag(html, 1009)).toContain('data-closed');
    expect(rowTag(html, 1003)).toContain('data-closed');
    expect(rowTag(html, 1013)).not.toContain('data-closed');
  });

  it('All requests opens with the compact brand row, above the sticky bar; Pending, My requests and Search do not (v8)', () => {
    const store = storeWith((s) => ({ ...s, myIds: new Set([...s.confirmed.keys()]), event: s.event && { ...s.event, logoUrl: '/api/events/logo/local?v=abc' } }));
    // Pending v8 (Brian, 2026-11-06 afternoon): Pending and My requests get just the large title.
    for (const node of [<PendingView key="pending" />, <MineView key="mine" />]) {
      const html = render(store, node);
      expect(html).not.toContain('brand-card');
      expect(html.match(/<h1[\s>]/g)?.length).toBe(1);
      // The large title is the first thing in the view.
      expect(html.indexOf('<header')).toBeLessThan(html.indexOf('data-testid="view-switcher"'));
      expect(html.slice(0, html.indexOf('<header'))).not.toMatch(/<img /);
    }
    for (const node of [<AllView key="all" status={null} post={null} />, <AllView key="filtered" status={STATUS.waiting} post={null} />]) {
      const html = render(store, node);
      const card = html.indexOf('data-testid="brand-card"');
      const title = html.indexOf('data-testid="view-switcher"');
      expect(card).toBeGreaterThan(0);
      // The first thing in the view: before the title, once.
      expect(html.slice(0, card)).not.toContain('data-testid="view-switcher"');
      expect(html.indexOf('data-testid="brand-card"', card + 1)).toBe(-1);
      expect(card).toBeLessThan(title);
      // The row's own markup: up to the sticky bar's <header>, which follows it directly.
      const header = html.indexOf('<header', card);
      expect(header).toBeLessThan(title);
      const brand = html.slice(html.lastIndexOf('<div', card), header).replace(/<!-- -->/g, '');
      expect(brand).toMatch(/<\/button><\/div><div class="[^"]*sticky[^"]*">$/);
      // (Events) The permanent Ground Control logo, sized up front (no shift when it loads). The event's logo and dates
      // are the event's config, drawn on the client after the first paint (BrandEventSlot): none in the server's HTML,
      // and no event logo baked into the build.
      expect(brand).toMatch(/<img [^>]*src="\/logos\/ground-control.png" alt="Ground Control" width="313" height="120"/);
      expect(brand).not.toContain('/api/events/logo');
      expect(brand).not.toContain('edc-orlando');
      expect(brand).not.toMatch(/Nov 6/);
      // The title with "in medical?" in its own span, then the dates (capitals come from CSS): short on a
      // phone, long on a wide screen (CSS shows one of them).
      expect(brand).toMatch(/>Is my friend <span class="[^"]*accent[^"]*">in medical\?<\/span><\/p>/);
      // No "event operations" (or "event ops"), no credit line, no orbit rings.
      expect(brand).not.toMatch(/event op/i);
      expect(brand).not.toContain('Built by');
      expect(brand).not.toContain('orbit');
      // The X: a button named "Hide header".
      expect(HIDE_HEADER_LABEL).toBe('Hide header');
      // The desk's server-drawn copy has no handler: its slot catches the click by data-brand-hide.
      expect(brand).toMatch(/<button type="button" class="[^"]*hide[^"]*" aria-label="Hide header" data-brand-hide="" data-testid="brand-hide">/);
      // The row adds no heading (the view menu title stays the h1).
      expect(brand).not.toMatch(/<h[1-6][\s>]/);
      expect(html.match(/<h1[\s>]/g)?.length).toBe(1);
    }
    for (const [name, node] of [
      ['Pending', <PendingView key="pending" />],
      ['My requests', <MineView key="mine" />],
      ['Search', <SearchView key="search" q="" />],
      ['Search results', <SearchView key="search-q" q="pink" />],
    ] as const) {
      expect(render(store, node), name).not.toContain('brand-card');
    }
  });

  it('hidden with its X: no brand row on All, and the avatar menu offers Show header (All only)', () => {
    const hidden = storeWith((s) => ({ ...s, prefs: { ...s.prefs, brandHidden: true } }));
    const html = render(hidden, <AllView status={null} post={null} />);
    expect(html).not.toContain('brand-card');
    // The view starts at its sticky bar.
    expect(html).toMatch(/^<div[^>]*>(<div[^>]*>)*?<div class="[^"]*root[^"]*" data-view="all"><div class="[^"]*sticky[^"]*">/);
  });

  it('the brand row is there before any data (skeletons and the error state), so nothing moves when rows load', () => {
    const loading = render(storeWith((s) => ({ ...s, hasData: false, hydrated: false })), <AllView status={null} post={null} />);
    expect(loading).toContain('list-skeleton');
    expect(loading.indexOf('data-testid="brand-card"')).toBeGreaterThan(0);
    expect(loading.indexOf('data-testid="brand-card"')).toBeLessThan(loading.indexOf('list-skeleton'));
    const failed = render(storeWith((s) => ({ ...s, hasData: false, hydrated: true, connection: 'error' })), <AllView status={null} post={null} />);
    expect(failed).toContain('Can&#x27;t reach the log');
    expect(failed).toContain('data-testid="brand-card"');
    // Pending: no card (v8), the same error state.
    const pending = render(storeWith((s) => ({ ...s, hasData: false, hydrated: true, connection: 'error' })), <PendingView />);
    expect(pending).toContain('Can&#x27;t reach the log');
    expect(pending).not.toContain('brand-card');
  });

  it('the line sits right under the title on All, Pending and My requests: a plain dot, "Updated just now", Refresh now', () => {
    const store = storeWith((s) => ({ ...s, lastSyncLocalAt: Date.now() - 5_000 }));
    for (const [name, node] of [
      ['All', <AllView key="all" status={null} post={null} />],
      ['Pending', <PendingView key="pending" />],
      ['My requests', <MineView key="mine" />],
    ] as const) {
      const html = render(store, node);
      const header = html.indexOf('</header>');
      const live = html.indexOf('data-testid="live-indicator"');
      expect(live, name).toBeGreaterThan(header);
      // Directly after the header, inside the sticky bar, before the list. (Pending v9.1) On All and My requests the
      // line shares its row with the "⇅" sort toggle, at the row's right end; Pending has no toggle.
      const row = name === 'Pending' ? '' : '<div class="[^"]*liveRow[^"]*" data-testid="live-row"><div class="[^"]*liveIn[^"]*">';
      expect(html.slice(header, live), name).toMatch(new RegExp(`^</header>${row}<div class="[^"]*live[^"]*"[^>]*data-state="healthy"\\s*$`));
      expect(live, name).toBeLessThan(html.indexOf('data-testid="request-list"'));
      if (name === 'Pending') expect(html, name).not.toContain('data-testid="sort-toggle"');
      else expect(html.indexOf('data-testid="sort-toggle"'), name).toBeGreaterThan(live);
      const line = html.slice(live, html.indexOf('</div>', live));
      expect(line, name).toMatch(/<span class="[^"]*liveDot[^"]*" aria-hidden="true"><\/span>/);
      // Minutes only: never seconds.
      expect(line, name).toMatch(/aria-hidden="true" data-testid="live-text">Updated just now<\/span>/);
      expect(line, name).not.toMatch(/\ds ago|seconds/);
      // One full sentence for screen readers, then the button, right after the words.
      expect(line, name).toContain('>List updated just now.</span>');
      expect(line, name).toMatch(/<\/span><button type="button" class="[^"]*liveRefresh[^"]*" aria-label="Refresh now" data-testid="refresh-now"><svg[^>]*lucide-refresh-cw[^>]*aria-hidden="true"/);
      // Healthy: no banner and no badge; the live region is there, silent until the state changes.
      expect(html, name).not.toContain('connection-banner');
      expect(html, name).not.toContain('connection-indicator');
      expect(html.slice(html.indexOf('data-testid="live-announcement"') - 200), name).toMatch(/role="status"[^>]*data-testid="live-announcement"[^>]*><\/span>/);
      expect(html.match(/data-testid="live-announcement"/g), name).toHaveLength(1);
    }
    // Search keeps its own bar, with no line.
    expect(render(store, <SearchView q="" />)).not.toContain('live-indicator');
  });

  it('before the first sync the line reads "Updating…" with a turning arrow, no age, no button (network fix 1d)', () => {
    const before = render(storeWith((s) => ({ ...s, lastSyncLocalAt: null })), <PendingView />);
    expect(before).toMatch(/data-state="healthy" data-updating="" data-testid="live-indicator"><svg[^>]*class="[^"]*liveSpin[^"]*"[^>]*>(?:<path[^>]*><\/path>)+<\/svg><span[^>]*data-testid="live-text">Updating…<\/span><span[^>]*>Updating the list\.<\/span><\/div>/);
    expect(before).not.toContain('Updated');
    expect(before).not.toContain('Refresh now');
    // Offline before the first sync: nothing on the line (the banner says Offline), as before.
    const offline = render(storeWith((s) => ({ ...s, lastSyncLocalAt: null, connection: 'offline' })), <PendingView />);
    expect(offline).toMatch(/data-state="none" data-testid="live-indicator"><\/div>/);
  });

  it('one state for the line, the banner and the badge: requests failing with a connection read Reconnecting everywhere', () => {
    // The F1.1 review finding: the store calls two failed requests 'offline' even while the phone reports a
    // connection. The line said Reconnecting while the banner said Offline; now all three say Reconnecting.
    const at = Date.now() - 45_000;
    const clock = formatCreatedTime(at, Date.now(), 'America/New_York');
    for (const connection of ['offline', 'error'] as const) {
      const html = render(storeWith((s) => ({ ...s, connection, lastSyncLocalAt: at })), <PendingView />);
      expect(html, connection).toMatch(/data-state="reconnecting" data-testid="live-indicator"/);
      expect(html, connection).toContain(`data-testid="live-text">Last updated ${clock}</span>`);
      expect(html, connection).toContain(`>Reconnecting. List last updated at ${clock}.</span>`);
      expect(html, connection).toMatch(/data-tone="amber" data-testid="connection-banner"[^>]*>.*?Reconnecting…<\/span>/);
      expect(html, connection).not.toContain('waiting to send');
      expect(html, connection).toMatch(/role="img" data-state="reconnecting" aria-label="Reconnecting" data-testid="connection-indicator"/);
    }
  });

  it('only All archives: Pending lists no closed request; My requests shows the reporter theirs, unfolded', () => {
    const store = storeWith((s) => ({ ...s, myIds: new Set([...s.confirmed.keys()]), prefs: { ...s.prefs, closedExpanded: false } }));
    const pending = render(store, <PendingView />);
    expect(pending).not.toContain('data-testid="closed-fold"');
    for (const r of store.getState().confirmed.values()) {
      if (statusMeta(r.status).bucket === 'closed') expect(pending).not.toContain(`data-request-id="${r.id}"`);
    }
    // My requests: no Archived fold, and Not located (LP-1009) and Reunited (LP-1003) are on the page.
    const mine = render(store, <MineView />);
    expect(mine).not.toContain('data-testid="closed-fold"');
    expect(mine).not.toContain('Archived');
    expect(mine).toContain(`data-request-id="${idOf(1009)}"`);
    expect(mine).toContain(`data-request-id="${idOf(1003)}"`);
  });

  it('All rows: lane, name, status, created with AM/PM, updated as "—" or a compact age; full-sentence names', () => {
    const now = Date.now();
    const store = storeWith((s) => s);
    const html = render(store, <AllView status={null} post={null} />);
    const row = (n: number) => store.getState().confirmed.get(idOf(n))!;
    // T.R. (LP-1013) was logged a minute ago and never changed: "—".
    const tr = row(1013);
    const created = formatCreatedTime(tr.createdAt, now, 'America/New_York');
    expect(created).toMatch(/^(\w{3} )?\d{1,2}:\d{2} (AM|PM)$/);
    // The row's name is its content (no aria-label, so it always says what is shown): one sentence.
    expect(rowTag(html, 1013)).not.toContain('aria-label');
    expect(spoken(html, 1013)).toBe(logRowLabel(tr, created, 'not updated yet'));
    expect(spoken(html, 1013)).toBe(`LP-1013, T.R., Waiting for check, created ${created}, not updated yet`);
    // What it shows: an empty message lane (no messages), the name, the blue status, the created time, "—". No
    // number column (message lane): the LP number is in the sentence.
    expect(shown(html, 1013, 'number')).toBeNull();
    expect(laneOf(html, 1013)).toBe('');
    expect(shown(html, 1013, 'name')).toBe('T.R.');
    expect(shown(html, 1013, 'status')).toBe('Waiting for check');
    // Under 430 px it reads "Waiting" (the name keeps its room); the sentence above still says it in full.
    expect(narrow(html, 1013)).toBe('Waiting');
    expect(shown(html, 1013, 'created')).toBe(created);
    expect(shown(html, 1013, 'updated')).toBe('—');
    expect(html.slice(html.indexOf(`data-request-id="${idOf(1013)}"`))).toMatch(/^[^]*?data-col="status" data-tone="blue"/);
    // Jordan Diaz (LP-1007) moved to In medical 2 minutes ago: green, "2m" (or 1m/3m at a minute edge).
    expect(spoken(html, 1007)).toMatch(/^LP-1007, Jordan Diaz, Located, friend coming, created (?:[A-Z][a-z]{2} )?\S+ (AM|PM), updated [123] minutes? ago$/);
    expect(shown(html, 1007, 'status')).toBe('Located');
    expect(narrow(html, 1007)).toBeNull();
    expect(shown(html, 1007, 'updated')).toMatch(/^[123]m$/);
    expect(html.slice(html.indexOf(`data-request-id="${idOf(1007)}"`))).toMatch(/^[^]*?data-col="status" data-tone="green"/);
    // Kayla Martinez (LP-1012) was logged with 2 photos and edited since: updated.
    expect(shown(html, 1012, 'updated')).toMatch(/^\d+m$/);
  });

  it('search rows: the matched text under the name is part of the spoken sentence', () => {
    const now = Date.now();
    const store = storeWith((s) => s);
    const html = render(store, <SearchView q="ferris" />);
    const df = store.getState().confirmed.get(idOf(1011))!;
    const created = formatCreatedTime(df.createdAt, now, 'America/New_York');
    expect(shown(html, 1011, 'match')).toBe('Ferris wheel line');
    expect(spoken(html, 1011)).toBe(searchLogLabel(df, created, 'not updated yet', 'Ferris wheel line'));
  });

  it('the message lane: blue bubble with the unread count, grey outline once read, nothing without; the sentence says it', () => {
    const now = Date.now();
    // LP-1013: 2 unread from another staff member · LP-1012: a read conversation · LP-1011: none · LP-1010: 120 unread ·
    // closed LP-1009 (open fold): 1 unread · closed LP-1006: read.
    const activity: Record<number, Partial<RequestSummary>> = {
      1013: { messageCount: 3, unread: 2, involved: false },
      1012: { messageCount: 4, unread: 0, involved: true },
      1011: { messageCount: 0, unread: 0 },
      1010: { messageCount: 130, unread: 120, involved: true },
      1009: { messageCount: 2, unread: 1, involved: true },
      1006: { messageCount: 6, unread: 0, involved: true },
    };
    const withActivity = (s: StoreState): StoreState => {
      const confirmed = new Map(s.confirmed);
      for (const [n, a] of Object.entries(activity)) {
        const r = confirmed.get(idOf(Number(n)))!;
        confirmed.set(r.id, { ...r, ...a });
      }
      return { ...s, confirmed };
    };
    const store = storeWith((s) => ({ ...withActivity(s), prefs: { ...s.prefs, closedExpanded: true } }));
    const html = render(store, <AllView status={null} post={null} />);
    expect(laneOf(html, 1013)).toBe('unread:2');
    expect(laneOf(html, 1012)).toBe('read');
    expect(laneOf(html, 1011)).toBe('');
    expect(laneOf(html, 1010)).toBe('unread:99+');
    expect(html).toMatch(/data-wide="">99\+<\/span>/);
    // Closed rows keep the mark: unread stays the blue bubble, read stays the outline (greyed by CSS, not faded).
    expect(laneOf(html, 1009)).toBe('unread:1');
    expect(laneOf(html, 1006)).toBe('read');
    // One button per row: the mark is aria-hidden inside it, and the sentence says it in full.
    const tr = store.getState().confirmed.get(idOf(1013))!;
    const created = formatCreatedTime(tr.createdAt, now, 'America/New_York');
    expect(spoken(html, 1013)).toBe(`LP-1013, T.R., Waiting for check, created ${created}, not updated yet. 2 unread messages.`);
    expect(spoken(html, 1012)).toMatch(/, updated \d+ minutes? ago\. 4 messages\.$/);
    expect(spoken(html, 1011)).toMatch(/not updated yet$/);
    expect(spoken(html, 1010)).toMatch(/\. 120 unread messages\.$/);
    // No count pill after the name, no dot: the lane is the only unread signal in the row.
    expect(html).not.toContain('row-unread');
    expect(html).not.toContain('unread-dot');
    // Folded, the Archived row carries the closed rows' unread total in its lane, and says it.
    const folded = render(storeWith((s) => ({ ...withActivity(s), prefs: { ...s.prefs, closedExpanded: false } })), <AllView status={null} post={null} />);
    const fold = folded.slice(folded.lastIndexOf('<button', folded.indexOf('data-testid="closed-fold"')), folded.indexOf('</button>', folded.indexOf('data-testid="closed-fold"')));
    expect(fold).toMatch(/class="[^"]*vh[^"]*">Archived \d+ requests\. 1 unread message\.<\/span>/);
    expect(fold).toMatch(/data-lane="" aria-hidden="true"><span class="[^"]*markBubble[^"]*">1<\/span><\/span>/);
    // Open, the rows show their own marks: the fold's lane is empty and its name is the plain count.
    const open = html.slice(html.lastIndexOf('<button', html.indexOf('data-testid="closed-fold"')), html.indexOf('</button>', html.indexOf('data-testid="closed-fold"')));
    expect(open).toMatch(/class="[^"]*vh[^"]*">Archived \d+ requests<\/span>/);
    expect(open).toMatch(/data-lane="" aria-hidden="true"><\/span>/);
  });

  it("Pending's Friend coming header: the filled message bubble (not a dot) while one of its requests has unread messages", () => {
    const quiet = render(storeWith((s) => s), <PendingView />);
    expect(quiet).not.toContain('data-testid="unread-mark"');
    const store = storeWith((s) => {
      const confirmed = new Map(s.confirmed);
      const r = confirmed.get(idOf(1004))!;
      confirmed.set(r.id, { ...r, messageCount: 2, unread: 1 });
      return { ...s, confirmed };
    });
    const html = render(store, <PendingView />);
    const header = html.slice(html.indexOf('data-testid="queue-header-coming"'), html.indexOf('</h2>', html.indexOf('data-testid="queue-header-coming"')));
    const mark = /<svg[^>]*data-testid="unread-mark"[^>]*>/.exec(header)?.[0] ?? '';
    expect(mark).toContain('lucide-message-square');
    expect(mark).toContain('fill="currentColor"');
    expect(mark).toContain('stroke-width="0"');
    expect(mark).toContain('width="14"');
    expect(mark).toContain('role="img"');
    expect(mark).toContain('aria-label="Unread messages"');
    expect(header).not.toContain('unread-dot');
  });

  it('search: the same row; a number match shows the LP number, highlighted, on the second line', () => {
    const store = storeWith((s) => {
      const confirmed = new Map(s.confirmed);
      const r = confirmed.get(idOf(1013))!;
      confirmed.set(r.id, { ...r, messageCount: 2, unread: 1 });
      return { ...s, confirmed };
    });
    const html = render(store, <SearchView q="1013" />);
    expect(laneOf(html, 1013)).toBe('unread:1');
    expect(shown(html, 1013, 'number')).toBeNull();
    const match = cellHtml(html, 1013, 'match') ?? '';
    expect(text(match)).toBe('LP-1013');
    expect(match).toMatch(/<mark[^>]*>1013<\/mark>/);
    expect(rowTag(html, 1013)).toMatch(/class="[^"]*lr2/);
    // The sentence already starts with the number: it is not said twice.
    expect(spoken(html, 1013)).toMatch(/^LP-1013, T\.R\., Waiting for check, created [^.]+, not updated yet\. 1 unread message\.$/);
    // A name match: no second line.
    const byName = render(store, <SearchView q="T.R." />);
    expect(cellHtml(byName, 1013, 'match')).toBeNull();
  });

  it('All filtered (status, post, open): one list, closed rows greyed in place, no fold, no queued rows', () => {
    const store = storeWith((s) => ({ ...s, outbox: [outboxItem()] }));
    const html = render(store, <AllView status={null} post="FA 3 – Kinetic" />);
    expect(html).not.toContain('data-testid="closed-fold"');
    expect(html).not.toContain('Waiting to send');
    // LP-1009 (Not located) and LP-1002 (Discharged) are at FA 3: listed in place, greyed.
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
    expect(html).toContain('Not located 2 shown. Clear this filter');
    expect(html).not.toContain('Waiting to send');
    // (2026-11-07) "Not located" has no narrow form: one label, the same at every width.
    expect(narrow(html, 1009)).toBeNull();
    expect(shown(html, 1009, 'status')).toBe('Not located');
  });

  it('skeletons only while there is no data; the error state once the empty cache is known and offline', () => {
    const loading = storeWith((s) => ({ ...s, hasData: false, hydrated: false }));
    expect(render(loading, <PendingView />)).toContain('list-skeleton');
    const failed = storeWith((s) => ({ ...s, hasData: false, hydrated: true, connection: 'error' }));
    const html = render(failed, <MineView />);
    expect(html).not.toContain('list-skeleton');
    expect(html).toContain('Can&#x27;t reach the log');
  });

  it('a problem: a badge on the avatar in the header, the line under the title, the banner between them and the log', () => {
    const store = storeWith((s) => ({ ...s, connection: 'error', outbox: [outboxItem()] }));
    const html = render(store, <AllView status={null} post={null} />);
    const title = html.indexOf('data-testid="view-switcher"');
    const avatar = html.indexOf('data-testid="account-trigger"');
    const indicator = html.indexOf('data-testid="connection-indicator"');
    const line = html.indexOf('data-testid="live-indicator"');
    const banner = html.indexOf('data-testid="connection-banner"');
    const cols = html.indexOf('data-testid="log-columns"');
    expect(title).toBeGreaterThan(0);
    expect(avatar).toBeGreaterThan(title);
    expect(indicator).toBeGreaterThan(avatar);
    const badge = html.slice(html.lastIndexOf('<span', indicator), indicator + 60);
    expect(badge).toContain('role="img"');
    expect(badge).toContain('data-state="reconnecting"');
    expect(badge).toContain('aria-label="Reconnecting"');
    expect(line).toBeGreaterThan(indicator);
    expect(banner).toBeGreaterThan(line);
    expect(cols).toBeGreaterThan(banner);
    // The banner is not a live region itself (a new waiting count is never read out); the one live region is.
    expect(html.slice(html.lastIndexOf('<div', banner), banner)).not.toContain('role=');
    // Healthy: no badge at all.
    expect(render(storeWith((s) => s), <PendingView />)).not.toContain('connection-indicator');
  });

  it('offline: the gray banner keeps "Offline · N waiting to send", and the badge is gray with a crossed-out cloud', () => {
    // A server render reads the phone as online, so the offline cues are rendered from the state directly.
    const store = storeWith((s) => ({ ...s, outbox: [outboxItem()] }));
    const offline = { state: 'offline' as const, text: 'Last updated 3:42 PM', sentence: 'Offline. List last updated at 3:42 PM.' };
    const banner = render(store, <ConnectionBanner status={offline} />);
    expect(banner).toMatch(/<div class="lp-banner [^"]*" data-tone="gray" data-testid="connection-banner" style="background:var\(--gray-a3\);color:var\(--gray-12\)"><svg[^>]*lucide-cloud-off/);
    expect(banner).toContain('>Offline · 1 waiting to send</span>');
    // The one live region follows the banner, silent until the state changes.
    expect(banner).toMatch(/waiting to send<\/span><\/div><span[^>]*role="status"[^>]*data-testid="live-announcement"[^>]*><\/span>/);
    const reconnecting = render(store, <ConnectionBanner status={{ ...offline, state: 'reconnecting' }} />);
    expect(reconnecting).toMatch(/data-tone="amber" data-testid="connection-banner"[^>]*><svg[^>]*lucide-cloud-sync/);
    expect(reconnecting).toContain('>Reconnecting…</span>');
    expect(render(store, <ConnectionBanner status={{ ...offline, state: 'healthy' }} />)).not.toContain('connection-banner');
    expect(renderToString(<ConnectionIndicator state="offline" />)).toMatch(
      /^<span class="[^"]*conn[^"]*" role="img" data-state="offline" aria-label="Offline" data-testid="connection-indicator"><svg[^>]*lucide-cloud-off/,
    );
    expect(renderToString(<ConnectionIndicator state="healthy" />)).toBe('');
  });

  it('Pending and My requests use the same large title, with no separate ×', () => {
    const pending = render(storeWith((s) => s), <PendingView />);
    expect(pending).toMatch(/aria-label="Pending 7, change view"/);
    expect(pending).not.toContain('Back to all requests');
    const mine = render(storeWith((s) => s), <MineView />);
    expect(mine).toMatch(/aria-label="My requests \d+, change view"/);
  });

  it('My requests: Not located is closed, greyed, in the Closed area after the open requests', () => {
    // Every stub row is "mine" for this check (created by the signed-in staff).
    const store = storeWith((s) => ({ ...s, myIds: new Set([...s.confirmed.keys()]) }));
    const html = render(store, <MineView />);
    const area = html.indexOf('data-testid="mine-closed"');
    expect(area).toBeGreaterThan(0);
    const card = (n: number) => html.indexOf(`data-request-id="${idOf(n)}"`);
    for (const n of [1013, 1012, 1007, 1004]) expect(card(n)).toBeLessThan(area);
    for (const n of [1009, 1008, 1003, 1001]) expect(card(n)).toBeGreaterThan(area);
    // The Not located card is dimmed like every closed card.
    const tag = html.slice(html.lastIndexOf('data-testid="mine-card"', card(1009)) - 300, card(1009));
    expect(tag).toMatch(/dimCard/);
  });

  it('Pending (phone, v9.1): one page, Waiting for check then Friend coming under their headers; no tabs', () => {
    const html = render(storeWith((s) => s), <PendingView />);
    expect(html).not.toContain('data-testid="pending-tabs"');
    expect(html).not.toContain('role="tablist"');
    // The two sections, in this order, each under a 44 px header with its count and a fold button.
    const check = html.indexOf('data-testid="pending-section-check"');
    const coming = html.indexOf('data-testid="pending-section-coming"');
    expect(check).toBeGreaterThan(html.indexOf('data-testid="view-switcher"'));
    expect(coming).toBeGreaterThan(check);
    expect(html).toMatch(/data-testid="queue-toggle-check"[^]*?>Waiting for check<\/span> <span[^>]*>4<\/span><span[^>]*> requests<\/span>/);
    expect(html).toMatch(/data-testid="queue-toggle-coming"[^]*?>Friend coming<\/span> <span[^>]*>3<\/span><span[^>]*> requests<\/span>/);
    expect(html.match(/aria-expanded="true"[^>]*data-testid="queue-toggle-/g)?.length).toBe(2);
    // Every card on one page: the 4 Waiting for check cards (longest wait first), then the 3 Friend coming.
    expect(html.match(/data-testid="check-card"/g)?.length).toBe(4);
    expect(html.match(/data-testid="friend-coming-card"/g)?.length).toBe(3);
    const order = [1010, 1011, 1012, 1013].map((n) => html.indexOf(`data-request-id="${idOf(n)}"`));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(order[3]).toBeLessThan(coming);
    // The left answer of a request never held is the first Not found (the hold).
    expect(html).toContain('>Pending<');
    expect(html).toContain('aria-label="Pending. Keeps this request open and schedules a recheck"');
    // Never held: no final "Not located" answer yet (it closes the request; the status reads the same words).
    expect(html).not.toContain('>Not located<');
  });

  it('Pending To check card: photo only when there is one, the name, minutes with a clock, wearing, "post · LP-####"', () => {
    const html = render(storeWith((s) => s), <PendingView />);
    const card = (n: number) => {
      const at = html.indexOf(`data-request-id="${idOf(n)}"`);
      const start = html.lastIndexOf('data-testid="check-card"', at);
      const next = html.indexOf('data-testid="check-card"', at);
      return html.slice(start, next > 0 ? next : undefined);
    };
    // LP-1012 has photos, the other three have none: no empty placeholder (Brian, v8).
    const checkCards = html.slice(html.indexOf('data-testid="pending-section-check"'), html.indexOf('data-testid="pending-section-coming"'));
    expect(checkCards.match(/data-testid="card-photo"/g)?.length).toBe(1);
    expect(card(1012)).toContain('data-testid="card-photo"');
    expect(card(1010)).not.toContain('card-photo');
    // "FA 4 · LP-1010": the post first, then the number, one quiet line.
    expect(card(1010)).toMatch(/>FA 4 · LP-1010</);
    expect(card(1010)).toContain('Neon green bikini top, white platform boots, red bandana');
    // Minutes beside the name: B.W. ~24m red, D.F. ~16m amber, T.R. ~1m grey, each with the clock.
    expect(card(1010)).toMatch(/data-tone="red" data-testid="card-minutes"><svg[^]*?<\/svg>2[34]m</);
    expect(card(1011)).toMatch(/data-tone="amber" data-testid="card-minutes"><svg[^]*?<\/svg>1[56]m</);
    expect(card(1013)).toMatch(/data-tone="gray" data-testid="card-minutes"><svg[^]*?<\/svg>(now|1m)</);
    // The card's sentence: who, where from, how long; then what they wear.
    expect(card(1010)).toMatch(/aria-label="B\.W\., 23 F\. FA 4 · LP-1010\. Waiting 2[34] minutes\. Neon green/);
  });

  it('Pending on the desk: both queues side by side, the Friend coming card with its location chip, no friend line', () => {
    const store = storeWith((s) => {
      const confirmed = new Map(s.confirmed);
      const sl = confirmed.get(idOf(1004))!;
      confirmed.set(sl.id, { ...sl, medicalLocation: 'Chair 14' });
      return { ...s, confirmed };
    });
    const html = render(
      store,
      <DeskContext.Provider value>
        <PendingView />
      </DeskContext.Provider>,
    );
    expect(html).toContain('data-testid="pending-board"');
    expect(html).not.toContain('brand-card');
    // The line under the title is the desk top bar's (components/desk/TopBar.tsx), not the list's.
    expect(html).not.toContain('data-testid="live-indicator"');
    // Both columns, Waiting for check first, each with its header, count and chevron; no tabs anywhere.
    expect(html.indexOf('data-testid="pending-column-check"')).toBeLessThan(html.indexOf('data-testid="pending-column-coming"'));
    expect(html).not.toContain('data-testid="pending-tabs"');
    expect(html).toContain('data-testid="queue-toggle-check"');
    expect(html).toContain('data-testid="queue-toggle-coming"');
    expect(html.match(/data-testid="check-card"/g)?.length).toBe(4);
    expect(html.match(/data-testid="friend-coming-card"/g)?.length).toBe(3);
    expect(html.match(/>Reunited</g)?.length).toBe(3);
    // Friend coming: the location chip (green with a pin) or a quiet "+ Location"; (v9.1) no friend line.
    expect(html).toMatch(/aria-label="Chair 14, edit location"/);
    expect(html.match(/aria-label="Add location"/g)?.length).toBe(2);
    expect(html).not.toContain('Jess T.');
    expect(html).not.toContain('on the way');
    // No coloured arrow line, no "from FA 3" any more.
    expect(html).not.toMatch(/from FA 3/);
    // Minutes since the answer, without the clock: S.L. answered ~3 minutes ago.
    const sl = html.slice(html.lastIndexOf('data-testid="friend-coming-card"', html.indexOf(`data-request-id="${idOf(1004)}"`)));
    expect(sl).toMatch(/data-tone="gray" data-testid="card-minutes">[23]m</);
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
    // (v9.1) Pending keeps both headers with 0: no rows, no text.
    const pending = render(store, <PendingView />);
    expect(pending).toContain('Waiting for check, no requests');
    expect(pending).toContain('Friend coming, no requests');
    expect(pending).not.toContain('Nothing pending');
    expect(render(store, <SearchView q="zzz" />)).toContain('No matches');
  });
});
