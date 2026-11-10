// (Events) The Ended screen's hand-off: the app (a 410 event_ended on any call) and sign-in (a password or join link of
// an archived event) both end on /signin?ended=1, which shows what was kept here: the event's name and logo. This tab
// only (sessionStorage). Imports nothing: /signin and the store both use it, and it costs neither a dependency.
//
// The event's local data (its cache, outbox, queued messages, draft) goes when the store learns the event ended; an
// ended event first seen at sign-in (a phone whose session had already expired) is marked here for the app to drop on
// its next start (DROP_KEY, localStorage), since /signin has no store.
import type { EndedEvent } from '../api-types';

export const ENDED_KEY = 'lp-ended';
export const ENDED_PATH = '/signin?ended=1';
/** localStorage: ids of ended events whose local data the store drops when it next starts. */
export const DROP_KEY = 'lp-drop-events';

function session(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function local(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Keeps what the Ended screen shows (best effort). */
export function rememberEnded(event: EndedEvent | null, storage: Storage | null = session()): void {
  try {
    if (event) storage?.setItem(ENDED_KEY, JSON.stringify({ name: event.name, logoUrl: event.logoUrl, ...(event.id ? { id: event.id } : {}) }));
    else storage?.removeItem(ENDED_KEY);
  } catch {
    // the screen then shows Ground Control alone
  }
}

/** What the Ended screen shows, or null. */
export function readEnded(storage: Storage | null = session()): EndedEvent | null {
  try {
    const v = JSON.parse(storage?.getItem(ENDED_KEY) ?? 'null') as { name?: unknown; logoUrl?: unknown; id?: unknown } | null;
    if (!v || typeof v.name !== 'string') return null;
    return { name: v.name, logoUrl: typeof v.logoUrl === 'string' ? v.logoUrl : null, stage: 'archived', ...(typeof v.id === 'string' ? { id: v.id } : {}) };
  } catch {
    return null;
  }
}

/** Marks an ended event's local data for the store to drop when it next starts. */
export function markEventDrop(eventId: string): void {
  const ids = readEventDrops();
  if (ids.includes(eventId)) return;
  try {
    local()?.setItem(DROP_KEY, JSON.stringify([...ids, eventId].slice(-20)));
  } catch {
    // best effort
  }
}

export function readEventDrops(storage: Storage | null = local()): string[] {
  try {
    const v = JSON.parse(storage?.getItem(DROP_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function clearEventDrops(done: readonly string[], storage: Storage | null = local()): void {
  try {
    const left = readEventDrops(storage).filter((id) => !done.includes(id));
    if (left.length) storage?.setItem(DROP_KEY, JSON.stringify(left));
    else storage?.removeItem(DROP_KEY);
  } catch {
    // best effort
  }
}
