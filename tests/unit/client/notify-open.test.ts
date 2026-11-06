// The page side of a notification click (v2.5 A52, lib/client/system-notify.ts): public/sw.js posts
// {type: 'lp-open', url}; the app page opens that view in place (pushState, no reload) and answers {ok}.
// Anything else is ignored. Stubbed window and service worker container; synthetic ids only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listenForNotificationOpens, openFromNotification } from '@/lib/client/system-notify';

const ID = '0f0f0f0f-0000-4000-8000-000000000012';

function fakeContainer() {
  let listener: ((event: Event) => void) | null = null;
  return {
    addEventListener: (_type: string, fn: (event: Event) => void) => {
      listener = fn;
    },
    removeEventListener: () => {
      listener = null;
    },
    /** Posts a message from the worker; resolves the page's reply (undefined when there is none). */
    post(data: unknown): unknown {
      let reply: unknown;
      listener?.({ data, ports: [{ postMessage: (m: unknown) => (reply = m) }] } as unknown as Event);
      return reply;
    },
    listening: () => listener !== null,
  };
}

describe('listenForNotificationOpens', () => {
  it('opens the URL the worker names and answers ok', () => {
    const container = fakeContainer();
    const open = vi.fn(() => true);
    listenForNotificationOpens(container, open);
    expect(container.post({ type: 'lp-open', url: `/?r=${ID}` })).toEqual({ ok: true });
    expect(open).toHaveBeenCalledWith(`/?r=${ID}`);
  });

  it('answers not ok when the page cannot open it, so the worker navigates the window instead', () => {
    const container = fakeContainer();
    listenForNotificationOpens(container, () => false);
    expect(container.post({ type: 'lp-open', url: '/signin' })).toEqual({ ok: false });
    const throwing = fakeContainer();
    listenForNotificationOpens(throwing, () => {
      throw new Error('boom');
    });
    expect(throwing.post({ type: 'lp-open', url: '/' })).toEqual({ ok: false });
  });

  it('ignores every other message, and stops when removed', () => {
    const container = fakeContainer();
    const open = vi.fn(() => true);
    const stop = listenForNotificationOpens(container, open);
    expect(container.post({ type: 'precache', urls: [] })).toBeUndefined();
    expect(container.post({ type: 'lp-open', url: 42 })).toBeUndefined();
    expect(container.post(null)).toBeUndefined();
    expect(open).not.toHaveBeenCalled();
    stop();
    expect(container.listening()).toBe(false);
  });
});

describe('openFromNotification', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubWindow() {
    const pushState = vi.fn();
    vi.stubGlobal('window', { location: { origin: 'https://lp.test', pathname: '/', search: '?view=pending' }, history: { state: { lpDepth: 2 }, pushState, replaceState: vi.fn() } });
    return pushState;
  }

  it('pushes the request’s profile as an in-app view (Back returns to where the page was)', () => {
    const pushState = stubWindow();
    expect(openFromNotification(`/?r=${ID}`)).toBe(true);
    expect(pushState).toHaveBeenCalledWith({ lpDepth: 3 }, '', `/?r=${ID}`);
    expect(openFromNotification('/')).toBe(true);
    expect(pushState).toHaveBeenLastCalledWith({ lpDepth: 3 }, '', '/');
  });

  it('already showing that view: nothing pushed (Back still leaves it), and the worker hears ok', () => {
    const pushState = stubWindow();
    expect(openFromNotification('/?view=pending')).toBe(true);
    expect(pushState).not.toHaveBeenCalled();
  });

  it('refuses another path or origin (the worker navigates or opens a window instead)', () => {
    const pushState = stubWindow();
    expect(openFromNotification('/signin')).toBe(false);
    expect(openFromNotification(`https://evil.example/?r=${ID}`)).toBe(false);
    expect(pushState).not.toHaveBeenCalled();
  });
});
