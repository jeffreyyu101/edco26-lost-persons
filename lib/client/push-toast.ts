// A push that arrives while the app is in front (F4, spec §18 A54): the worker asked the page, the page said
// it is in front, so the worker showed nothing and the app carries the event. The page syncs at once; when
// that sync raised no alert toast for the request (the store toasts only status changes on the caller's own
// requests and new requests, spec §7), the push's own title and line show as an in-app toast: a location
// change ("Chair 9 → Bed 3"), an edit, the location that completes an answer, or an answer on a request
// someone else logged. Never both: nothing when an alert toast for that request (or a combined one) showed
// within RECENT_MS of the push, nothing for a request this page does not hold, nothing for a test alert.
// Nothing for a message either (F3 + F4 release): the page's own message alert (messages-activity.ts
// diffMessageAlerts) owns it, and stays silent while that request's thread is on screen (the bubble is the
// alert), which a toast from the push would break.
// Loaded with the Activity host (never on the first load). Never logs anything.
import type { StoreActions, StoreState } from './store-contract';
import { navigate } from './nav';

/** The store's in-app alert toast time (lib/client/alerts.ts ALERT_TOAST_MS; not imported: first-load split). */
const TOAST_MS = 12_000;
/** The longest the page waits for its sync to answer before it decides. */
export const PUSH_SYNC_WAIT_MS = 6_000;
/** An alert toast for the request this close to the push is the same event (a poll that got there first). */
export const RECENT_MS = 20_000;

export interface PushMessage {
  type?: unknown;
  kind?: unknown;
  requestId?: unknown;
  title?: unknown;
  body?: unknown;
}

export interface PushToastStore {
  getState(): Pick<StoreState, 'syncing' | 'confirmed'>;
  subscribe(listener: () => void): () => void;
  actions: Pick<StoreActions, 'syncNow' | 'showToast' | 'subscribeAlerts'>;
}

export interface PushToasts {
  /** A push the worker told this page about; `front`: this page said it is in front. */
  handle(message: PushMessage, front: boolean): void;
  stop(): void;
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

export function createPushToasts(store: PushToastStore, now: () => number = Date.now): PushToasts {
  const lastAlert = new Map<string, number>();
  let lastCombined = Number.NEGATIVE_INFINITY;
  let stopped = false;
  const waiting = new Set<() => void>();
  const offAlerts = store.actions.subscribeAlerts((alert) => {
    if (alert.requestId) lastAlert.set(alert.requestId, now());
    else lastCombined = now();
  });

  const decide = (id: string, at: number, title: string, body: string) => {
    if (stopped) return;
    if (Math.max(lastAlert.get(id) ?? Number.NEGATIVE_INFINITY, lastCombined) >= at - RECENT_MS) return;
    if (!store.getState().confirmed.has(id)) return;
    store.actions.showToast({
      tone: 'neutral',
      icon: 'bell',
      title,
      ...(body ? { subtitle: body } : {}),
      action: { label: 'View', run: () => navigate({ r: id }) },
      durationMs: TOAST_MS,
    });
  };

  return {
    handle(message, front) {
      if (stopped) return;
      store.actions.syncNow();
      const id = text(message.requestId, 64);
      const title = text(message.title, 80);
      if (!front || !id || !title || message.kind === 'test' || message.kind === 'message') return;
      const body = text(message.body, 240);
      const at = now();
      // Wait for the sync this push asked for: one that was already on its way when it came may predate the
      // event, so then the one after it (the store runs it, coalesced).
      let syncing = store.getState().syncing;
      let left = syncing ? 2 : 1;
      // The store tells its alert listeners as it shows the toasts, right as the sync ends: decide a tick later.
      const finish = () => {
        cancel();
        setTimeout(() => decide(id, at, title, body), 0);
      };
      const timer = setTimeout(finish, PUSH_SYNC_WAIT_MS);
      const off = store.subscribe(() => {
        const next = store.getState().syncing;
        if (syncing && !next) {
          left -= 1;
          if (left <= 0) finish();
        }
        syncing = next;
      });
      const cancel = () => {
        off();
        clearTimeout(timer);
        waiting.delete(cancel);
      };
      waiting.add(cancel);
    },
    stop() {
      stopped = true;
      offAlerts();
      for (const cancel of [...waiting]) cancel();
    },
  };
}
