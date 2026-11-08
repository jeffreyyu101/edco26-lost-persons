// Request page order (Brian 2026-11-07, design/DECISIONS.md "Request page order", spec R1–R3): the request reads
// header → status block → (the latest-message line) → Details → Photos → Messages → Audit trail, on the phone and in
// the desk pane; the latest-message line shows only while the request needs info or has unread messages for me;
// and every "open this request for its messages" entry point asks for the thread ("/?r=<id>&to=thread", the jump).
// (2026-11-08, request page tonight) The line carries no second Needs info chip (T1), wraps to two lines and shows the
// message's time at its right, said as "at 12:24 PM" (T2).
// Server renders against the stub store with a stand-in messages engine; stubbed window / history. Synthetic ids.
import { Theme } from '@radix-ui/themes';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openRowAt } from '@/components/messages/CardActivity';
import { ProfileView } from '@/components/profile/ProfileView';
import { pushPayload } from '@/lib/activity';
import type { LastMessage, RequestSummary } from '@/lib/api-types';
import type { MessagingApi } from '@/lib/client/messages-core';
import { StoreContext, type AlertEvent, type AppStore } from '@/lib/client/store-contract';
import { createStubStore } from '@/lib/client/store-stub';
import { formatCreatedTime } from '@/lib/format';
import { stubId } from '@/lib/client/stub-data';
import { openFromNotification, systemNotice } from '@/lib/client/system-notify';
import {
  dropOtherThreadJump,
  openThread,
  requestThreadJump,
  subscribeThreadJump,
  takeThreadJump,
  takeThreadParam,
  threadJumpWaiting,
} from '@/lib/client/thread-jump';
import { threadPreviewShown } from '@/lib/messaging';
import { threadPath, wantsThread } from '@/lib/thread-link';

const NOW = Date.now();
const WAITING = stubId(1012);
const IN_MEDICAL = stubId(1004);
const FROM_MEDICAL: LastMessage = { by: 'Rae C.', mine: false, text: 'Any tattoos or marks?' };
const MINE: LastMessage = { by: 'Dana K.', mine: true, text: 'Butterfly tattoo, left wrist' };
const TZ = 'America/New_York';
/** When the latest message was written (3 minutes ago), and the time the line shows for it ("12:24 PM"). */
const LAST_AT = new Date(NOW - 3 * 60_000).toISOString();
const lastTime = () => formatCreatedTime(LAST_AT, Date.now(), TZ);

/** The engine's two reads a server render makes; nothing else is called before effects run. */
const ENGINE = {
  getSnapshot: () => ({ threads: new Map(), jobs: [] }),
  subscribe: () => () => undefined,
} as unknown as MessagingApi;

function store(id: string, patch: (row: RequestSummary) => RequestSummary = (r) => r, synced = true): AppStore {
  const base = createStubStore({ eventTimezone: TZ, now: NOW });
  const state = base.getState();
  const confirmed = new Map(state.confirmed);
  confirmed.set(id, patch(confirmed.get(id)!));
  // `synced: false`: the rows are only what the phone's cache had at start (no sync since the page loaded).
  const next = { ...state, confirmed, ...(synced ? {} : { lastSyncAt: null, lastSyncLocalAt: null }) };
  return { getState: () => next, subscribe: () => () => {}, actions: { ...base.actions, messages: ENGINE } };
}

const render = (s: AppStore, node: ReactNode) =>
  renderToString(
    <Theme>
      <StoreContext.Provider value={s}>{node}</StoreContext.Provider>
    </Theme>,
  );

const at = (html: string, marker: string) => html.indexOf(marker);
const ORDER = ['data-testid="status-block"', '>Missing person<', '>Friend or family<', '>Photos<', 'data-testid="messages"', '>Audit trail<'];

describe('the order of the request (R1)', () => {
  for (const presentation of ['page', 'panel'] as const) {
    it(`${presentation}: header → status block → Details → Photos → Messages → Audit trail`, () => {
      for (const id of [WAITING, IN_MEDICAL]) {
        const html = render(store(id), <ProfileView id={id} presentation={presentation} />);
        const positions = [at(html, '<h1'), ...ORDER.map((m) => at(html, m))];
        expect(positions.every((p) => p > 0), `${presentation} ${id}: ${positions.join(', ')}`).toBe(true);
        expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      }
    });

    it(`${presentation}: the latest-message line sits right under the status block, before the details`, () => {
      const html = render(store(WAITING, (r) => ({ ...r, needsInfo: true, lastMessage: FROM_MEDICAL, messageCount: 1, unread: 1 })), <ProfileView id={WAITING} presentation={presentation} />);
      const line = at(html, 'data-testid="thread-preview"');
      expect(line).toBeGreaterThan(at(html, 'data-testid="status-block"'));
      expect(line).toBeLessThan(at(html, '>Missing person<'));
      if (presentation === 'panel') expect(line).toBeGreaterThan(at(html, 'data-testid="profile-actions"'));
    });
  }
});

const preview = (html: string) => {
  const i = at(html, 'data-testid="thread-preview"');
  return i < 0 ? null : html.slice(html.lastIndexOf('<button', i), html.indexOf('</button>', i));
};

describe('the latest-message line (R1)', () => {
  it('Needs info: "Rae C.: Any tattoos or marks?", its time, the unread dot, one button that says it all; no second chip (T1)', () => {
    const html = render(store(WAITING, (r) => ({ ...r, needsInfo: true, lastMessage: FROM_MEDICAL, lastMessageAt: LAST_AT, messageCount: 1, unread: 1 })), <ProfileView id={WAITING} />);
    const line = preview(html)!;
    expect(line).not.toBeNull();
    // (T1) The status block above says Needs info (in words and glyph): the line has no chip of its own.
    expect(line).not.toContain('stage-chip');
    expect(line).not.toContain('data-tone="amber"');
    expect(html.slice(at(html, 'data-testid="status-block"'), at(html, 'data-testid="thread-preview"'))).toContain('Needs info');
    expect(line).toContain('data-testid="preview-unread"');
    expect(line.replace(/<!-- -->/g, '')).toMatch(/Rae C\.:<\/span> Any tattoos or marks\?/);
    // (T2) The time at the right, before the ⌄, and in the sentence.
    expect(line.replace(/<!-- -->/g, '')).toMatch(new RegExp(`data-testid="preview-time"[^>]*>${lastTime()}</span><svg`));
    expect(line).toContain(`Last message, unread, from Rae C. at ${lastTime()}: Any tattoos or marks? Go to messages.`);
    expect(line).not.toContain('Needs info');
  });

  it('Needs info when my own question is the latest: "You: …" and its time, no dot, no chip', () => {
    const html = render(store(WAITING, (r) => ({ ...r, needsInfo: true, lastMessage: { ...FROM_MEDICAL, mine: true }, lastMessageAt: LAST_AT, messageCount: 1, unread: 0 })), <ProfileView id={WAITING} />);
    const line = preview(html)!;
    expect(line).not.toContain('stage-chip');
    expect(line).not.toContain('preview-unread');
    expect(line).toContain(`Last message, from you at ${lastTime()}: Any tattoos or marks?`);
  });

  it('Located with unread messages for me: the line with its dot and time, no chip', () => {
    const html = render(store(IN_MEDICAL, (r) => ({ ...r, lastMessage: { by: 'Rae C.', mine: false, text: 'Bring 1 person only' }, lastMessageAt: LAST_AT, messageCount: 3, unread: 2 })), <ProfileView id={IN_MEDICAL} />);
    const line = preview(html)!;
    expect(line).not.toContain('stage-chip');
    expect(line).toContain('data-testid="preview-unread"');
    expect(line).toContain('data-testid="preview-time"');
    expect(line).toContain(`Last message, unread, from Rae C. at ${lastTime()}: Bring 1 person only. Go to messages.`);
  });

  it('(T2) without a readable time for the latest message: no time, the sentence as before', () => {
    for (const lastMessageAt of [null, 'not a time']) {
      const html = render(store(IN_MEDICAL, (r) => ({ ...r, lastMessage: { by: 'Rae C.', mine: false, text: 'Bring 1 person only' }, lastMessageAt, messageCount: 3, unread: 2 })), <ProfileView id={IN_MEDICAL} />);
      const line = preview(html)!;
      expect(line, String(lastMessageAt)).not.toContain('preview-time');
      expect(line).toContain('Last message, unread, from Rae C.: Bring 1 person only. Go to messages.');
    }
  });

  it('not otherwise: no messages, messages all read, or my own reply the latest', () => {
    const cases: Array<[string, (r: RequestSummary) => RequestSummary]> = [
      [WAITING, (r) => r],
      [WAITING, (r) => ({ ...r, lastMessage: FROM_MEDICAL, messageCount: 2, unread: 0, needsInfo: false })],
      [IN_MEDICAL, (r) => ({ ...r, lastMessage: FROM_MEDICAL, messageCount: 2, unread: 0 })],
      [IN_MEDICAL, (r) => ({ ...r, lastMessage: MINE, messageCount: 2, unread: 0 })],
    ];
    for (const [id, patch] of cases) expect(preview(render(store(id, patch), <ProfileView id={id} />))).toBeNull();
  });

  it("not from the phone's cache alone: an unread count read at start, before any sync, detail or thread came back, shows no line", () => {
    // The cache can be behind: the message was read on another device, or just before a reload.
    const unreadRow = (r: RequestSummary) => ({ ...r, lastMessage: { by: 'Rae C.', mine: false, text: 'Bring 1 person only' }, messageCount: 1, unread: 1 });
    expect(preview(render(store(IN_MEDICAL, unreadRow, false), <ProfileView id={IN_MEDICAL} />))).toBeNull();
    // Once this visit heard from the server (here a sync since the page loaded; the detail and the thread's own load
    // count too, end to end in tests/e2e/detail-order.spec.ts, as a server render reads no engine snapshot).
    expect(preview(render(store(IN_MEDICAL, unreadRow, true), <ProfileView id={IN_MEDICAL} />))).toContain('data-testid="preview-unread"');
    // Needs info is not a kept count: it shows from the row as it is.
    const asked = (r: RequestSummary) => ({ ...r, needsInfo: true, lastMessage: FROM_MEDICAL, messageCount: 1, unread: 1 });
    const line = preview(render(store(WAITING, asked, false), <ProfileView id={WAITING} />))!;
    expect(line).toContain('Any tattoos or marks?');
    expect(line).not.toContain('stage-chip');
    expect(line).not.toContain('preview-unread');
  });

  it('the rule: Needs info, or unread from someone else seen on this visit, until my own message is the latest', () => {
    expect(threadPreviewShown(true, false, null)).toBe(true);
    expect(threadPreviewShown(true, false, MINE)).toBe(true);
    expect(threadPreviewShown(false, true, FROM_MEDICAL)).toBe(true);
    expect(threadPreviewShown(false, true, MINE)).toBe(false);
    expect(threadPreviewShown(false, true, null)).toBe(false);
    expect(threadPreviewShown(false, false, FROM_MEDICAL)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------
// Entry points (R2)
// ---------------------------------------------------------------------------------------------------

const ID = '0f0f0f0f-0000-4000-8000-000000000042';
const OTHER = '0f0f0f0f-0000-4000-8000-000000000043';

function fakeWindow(search = '', lpDepth = 0) {
  const history = { state: { lpDepth }, pushState: vi.fn(), replaceState: vi.fn(), back: vi.fn() };
  vi.stubGlobal('window', { history, location: { origin: 'https://lp.test', pathname: '/', search } });
  return history;
}

describe('the thread address (R2)', () => {
  it('"/?r=<id>&to=thread", read back; a plain "/?r=<id>" does not ask for the thread', () => {
    expect(threadPath(ID)).toBe(`/?r=${ID}&to=thread`);
    expect(wantsThread(new URL(threadPath(ID), 'https://x.test').searchParams)).toBe(true);
    expect(wantsThread(new URLSearchParams(`r=${ID}`))).toBe(false);
    expect(wantsThread(new URLSearchParams(`r=${ID}&to=top`))).toBe(false);
  });

  it("a message's push opens the thread; every other event still opens the request", () => {
    expect(pushPayload({ requestId: ID, kind: 'message', detail: 'Rae C.: Any tattoos?' }, 'J.D.', 1).url).toBe(`/?r=${ID}&to=thread`);
    for (const kind of ['in_medical', 'new_request', 'enroute', 'reunited'] as const) expect(pushPayload({ requestId: ID, kind, detail: 'x' }, 'J.D.', 1).url, kind).toBe(`/?r=${ID}`);
  });

  it("a message's page notification opens the thread; an answer's opens the request", () => {
    const message: AlertEvent = { kind: 'message', requestId: ID, title: 'J.D.', subtitle: 'Rae C.: Any tattoos?', count: 1 };
    expect(systemNotice(message, () => undefined).url).toBe(`/?r=${ID}&to=thread`);
    expect(systemNotice({ ...message, kind: 'in_medical' }, () => undefined).url).toBe(`/?r=${ID}`);
  });
});

describe('the jump (R2)', () => {
  beforeEach(() => {
    takeThreadJump(ID);
    takeThreadJump(OTHER);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('waits for its request, is taken once, tells the open thread, and lapses after 60 s (a slow cold start)', () => {
    const told = vi.fn();
    const off = subscribeThreadJump(told);
    requestThreadJump(ID);
    expect(told).toHaveBeenCalledTimes(1);
    expect(threadJumpWaiting(ID)).toBe(true);
    expect(takeThreadJump(OTHER)).toBe(false);
    expect(takeThreadJump(ID)).toBe(true);
    expect(takeThreadJump(ID)).toBe(false);
    off();
    vi.useFakeTimers();
    requestThreadJump(ID);
    vi.advanceTimersByTime(59_000);
    expect(threadJumpWaiting(ID)).toBe(true);
    vi.advanceTimersByTime(1_001);
    expect(takeThreadJump(ID)).toBe(false);
  });

  it("another request's Messages opening first drops a jump left behind; its own never", () => {
    requestThreadJump(ID);
    dropOtherThreadJump(ID);
    expect(threadJumpWaiting(ID)).toBe(true);
    dropOtherThreadJump(OTHER);
    expect(threadJumpWaiting(ID)).toBe(false);
  });

  it('a Message button (openThread) opens "/?r=<id>" with the jump waiting', () => {
    const history = fakeWindow('', 1);
    openThread(ID);
    expect(history.pushState).toHaveBeenCalledWith({ lpDepth: 2 }, '', `/?r=${ID}`);
    expect(takeThreadJump(ID)).toBe(true);
  });

  it("a desk row: a click on the unread badge lands at the thread, anywhere else at the top", () => {
    const history = fakeWindow();
    const badge = { closest: (sel: string) => (sel === '[data-thread-badge]' ? {} : null) };
    const name = { closest: () => null };
    openRowAt(ID, badge as unknown as EventTarget);
    expect(takeThreadJump(ID)).toBe(true);
    openRowAt(ID, name as unknown as EventTarget);
    openRowAt(ID, null);
    expect(takeThreadJump(ID)).toBe(false);
    expect(history.pushState).toHaveBeenCalledTimes(3);
  });

  it('a notification click on an open page: "/?r=<id>&to=thread" asks for the jump, "/?r=<id>" does not', () => {
    fakeWindow();
    expect(openFromNotification(`/?r=${ID}&to=thread`)).toBe(true);
    expect(takeThreadJump(ID)).toBe(true);
    expect(openFromNotification(`/?r=${ID}`)).toBe(true);
    expect(takeThreadJump(ID)).toBe(false);
    // Already showing that request: no second history entry, the open thread still jumps.
    const history = fakeWindow(`?r=${ID}`);
    expect(openFromNotification(`/?r=${ID}&to=thread`)).toBe(true);
    expect(history.pushState).not.toHaveBeenCalled();
    expect(takeThreadJump(ID)).toBe(true);
  });

  it('a page opened at "/?r=<id>&to=thread" asks for the jump and drops `to` from the address', () => {
    const history = fakeWindow(`?r=${ID}&to=thread`, 0);
    expect(takeThreadParam(ID)).toBe(true);
    expect(history.replaceState).toHaveBeenCalledWith({ lpDepth: 0 }, '', `/?r=${ID}`);
    expect(takeThreadJump(ID)).toBe(true);
    // Old addresses, edit forms and another request's address: nothing.
    for (const search of [`?r=${ID}`, `?r=${ID}&edit=person&to=thread`, `?r=${OTHER}&to=thread`]) {
      const h = fakeWindow(search);
      expect(takeThreadParam(ID), search).toBe(false);
      expect(h.replaceState).not.toHaveBeenCalled();
    }
    expect(threadJumpWaiting(ID)).toBe(false);
  });
});
