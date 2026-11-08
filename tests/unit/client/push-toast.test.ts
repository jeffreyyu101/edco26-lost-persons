// lib/client/push-toast.ts (F4, spec §18 A54): a push while the app is in front (the worker showed nothing)
// syncs at once, and when that sync raised no alert toast for the request, the push's own title and line show
// as an in-app toast (a location change, an edit, an answer on someone else's request). Never both: nothing
// when an alert toast for the request came first (a poll that got there before the push) or during the sync,
// nothing for a request the page does not hold, nothing for a test alert, nothing when not in front.
// Synthetic ids only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PUSH_SYNC_WAIT_MS, createPushToasts, type PushToastStore } from '@/lib/client/push-toast';
import type { AlertEvent, ToastItem } from '@/lib/client/store-contract';

const ID = '0f0f0f0f-0000-4000-8000-0000000000d4';
const OTHER = '0f0f0f0f-0000-4000-8000-0000000000e5';

function fakeStore(held: string[] = [ID], open: string[] = []) {
  let syncing = false;
  const refreshed: string[] = [];
  const listeners = new Set<() => void>();
  const alertListeners = new Set<(a: AlertEvent) => void>();
  const toasts: Array<Omit<ToastItem, 'id'>> = [];
  let syncs = 0;
  const confirmed = new Map(held.map((id) => [id, {} as never]));
  const store: PushToastStore = {
    getState: () => ({ syncing, confirmed }),
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    actions: {
      syncNow: () => {
        syncs += 1;
      },
      showToast: (t) => {
        toasts.push(t);
        return String(toasts.length);
      },
      subscribeAlerts: (l) => {
        alertListeners.add(l);
        return () => alertListeners.delete(l);
      },
      messages: {
        isOpen: (id) => open.includes(id),
        refresh: (id) => {
          refreshed.push(id);
        },
      },
    },
  };
  const setSyncing = (v: boolean) => {
    syncing = v;
    for (const l of [...listeners]) l();
  };
  return {
    store,
    toasts,
    refreshed,
    syncs: () => syncs,
    /** One poll: syncing, the alerts it raised, done. */
    poll(alerts: AlertEvent[] = []) {
      setSyncing(true);
      for (const a of alerts) for (const l of [...alertListeners]) l(a);
      setSyncing(false);
    },
    setSyncing,
  };
}

const push = (over: Record<string, unknown> = {}) => ({ type: 'lp-push', kind: 'moved', requestId: ID, title: 'J.D.', body: 'Chair 9 → Bed 3', ...over });
const statusAlert = (requestId = ID): AlertEvent => ({ kind: 'in_medical', requestId, title: 'LP-1004 · J.D. located', count: 1 });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a push while the app is in front', () => {
  it('regression: an event the store does not toast (a location change) shows as an in-app toast from the push', async () => {
    const f = fakeStore();
    const toasts = createPushToasts(f.store);
    toasts.handle(push(), true);
    expect(f.syncs()).toBe(1);
    f.poll();
    await vi.advanceTimersByTimeAsync(10);
    expect(f.toasts).toHaveLength(1);
    expect(f.toasts[0]).toMatchObject({ title: 'J.D.', subtitle: 'Chair 9 → Bed 3', tone: 'neutral', icon: 'bell', action: { label: 'View' } });
  });

  it('the sync raised its own toast for the request: nothing more (never two toasts for one event)', async () => {
    const f = fakeStore();
    const toasts = createPushToasts(f.store);
    toasts.handle(push({ kind: 'in_medical', body: 'Located' }), true);
    f.poll([statusAlert()]);
    await vi.advanceTimersByTimeAsync(10);
    expect(f.toasts).toHaveLength(0);
  });

  it('a poll that got there before the push already toasted it: nothing more', async () => {
    const f = fakeStore();
    const toasts = createPushToasts(f.store);
    f.poll([statusAlert()]);
    await vi.advanceTimersByTimeAsync(2_000);
    toasts.handle(push({ kind: 'in_medical', body: 'Located' }), true);
    f.poll();
    await vi.advanceTimersByTimeAsync(10);
    expect(f.toasts).toHaveLength(0);
  });

  it('a toast for another request does not count', async () => {
    const f = fakeStore([ID, OTHER]);
    const toasts = createPushToasts(f.store);
    toasts.handle(push(), true);
    f.poll([statusAlert(OTHER)]);
    await vi.advanceTimersByTimeAsync(10);
    expect(f.toasts).toHaveLength(1);
  });

  it('a poll already on its way when the push came may predate it: the next one decides', async () => {
    const f = fakeStore();
    const toasts = createPushToasts(f.store);
    f.setSyncing(true);
    toasts.handle(push({ kind: 'in_medical', body: 'Located' }), true);
    f.setSyncing(false); // the old poll: no alert yet
    await vi.advanceTimersByTimeAsync(10);
    expect(f.toasts).toHaveLength(0);
    f.poll([statusAlert()]); // the rerun brings the change and its toast
    await vi.advanceTimersByTimeAsync(10);
    expect(f.toasts).toHaveLength(0);
  });

  it('no sync answers (offline): it still shows after the wait', async () => {
    const f = fakeStore();
    const toasts = createPushToasts(f.store);
    toasts.handle(push(), true);
    await vi.advanceTimersByTimeAsync(PUSH_SYNC_WAIT_MS + 10);
    expect(f.toasts).toHaveLength(1);
  });

  it('not for a request this page does not hold, not for a test alert, not when the page is not in front', async () => {
    const f = fakeStore([]);
    const toasts = createPushToasts(f.store);
    toasts.handle(push(), true);
    toasts.handle(push({ kind: 'test', requestId: null, title: 'Is my friend in medical?' }), true);
    const g = fakeStore();
    const other = createPushToasts(g.store);
    other.handle(push(), false);
    expect(g.syncs()).toBe(1); // it still syncs
    f.poll();
    g.poll();
    await vi.advanceTimersByTimeAsync(PUSH_SYNC_WAIT_MS + 10);
    expect(f.toasts).toHaveLength(0);
    expect(g.toasts).toHaveLength(0);
  });

  it('F3 + F4 release: never for a message (the page\'s own message alert owns it, silent while its thread is on screen)', async () => {
    const f = fakeStore();
    const toasts = createPushToasts(f.store);
    toasts.handle(push({ kind: 'message', title: 'J.D.', body: 'Rae C.: Bring 1 person only' }), true);
    expect(f.syncs()).toBe(1); // it still syncs
    f.poll();
    await vi.advanceTimersByTimeAsync(PUSH_SYNC_WAIT_MS + 10);
    expect(f.toasts).toHaveLength(0);
  });

  it('stop() (sign-out, unmount) drops what is waiting', async () => {
    const f = fakeStore();
    const toasts = createPushToasts(f.store);
    toasts.handle(push(), true);
    toasts.stop();
    await vi.advanceTimersByTimeAsync(PUSH_SYNC_WAIT_MS + 10);
    expect(f.toasts).toHaveLength(0);
  });
});

// (network fix 5) A message push while in front, for the thread on screen: it loads at once, with the sync.
describe('a message push for the open thread (fix 5)', () => {
  const message = (over: Record<string, unknown> = {}) => push({ kind: 'message', title: 'Rae C. · Medical', body: 'Found her', ...over });

  it('in front, thread open: one refresh of that thread, and the sync, at once', () => {
    const f = fakeStore([ID], [ID]);
    const toasts = createPushToasts(f.store);
    toasts.handle(message(), true);
    expect(f.refreshed).toEqual([ID]);
    expect(f.syncs()).toBe(1);
    expect(f.toasts).toHaveLength(0); // still no toast for a message (the page's own alert owns it)
  });

  it('nothing for a closed thread, a page not in front, or another kind', () => {
    const closed = fakeStore([ID], [OTHER]);
    createPushToasts(closed.store).handle(message(), true);
    expect(closed.refreshed).toEqual([]);
    const behind = fakeStore([ID], [ID]);
    createPushToasts(behind.store).handle(message(), false);
    expect(behind.refreshed).toEqual([]);
    expect(behind.syncs()).toBe(1);
    const moved = fakeStore([ID], [ID]);
    createPushToasts(moved.store).handle(push(), true);
    expect(moved.refreshed).toEqual([]);
  });
});
