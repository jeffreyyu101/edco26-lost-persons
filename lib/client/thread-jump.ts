'use client';
// Jump to the thread (Request page order R2, Brian 2026-11-07). Every "open this request for its messages"
// entry point lands at the request's Messages instead of its top: a card's Message button (its badge included),
// a desk row's unread badge, an Activity row whose latest event is a message, a message's toast, and a message's
// push or page notification ("/?r=<id>&to=thread", lib/thread-link.ts). Other ways in (a row, search, a Pending
// card) open at the top as before.
//
// One waiting jump at a time, taken once by that request's MessagesSection, which scrolls itself into view and
// focuses the composer on a computer only. The request may already be open (its section is told), or open a
// moment later (its section takes it when it mounts). No React here: the store, on the first load, uses
// openThread for a message's toast.
import { THREAD_PARAM, THREAD_VALUE, wantsThread } from '../thread-link';
import { navigate, setSignInNext } from './nav';

/**
 * How long a jump waits for its request's Messages to show (the view chunk, the row on a cold start over a
 * slow festival network), and how long a sign-in after a 401 still comes back to a thread it opened.
 */
const JUMP_MS = 60_000;

let pending: { id: string; until: number } | null = null;
/** The request whose Messages a jump last brought into view, and until when a sign-in comes back to them. */
let landed: { id: string; until: number } | null = null;
const listeners = new Set<() => void>();

/** Ask the request's Messages to come into view (now if it is open, else when it opens). */
export function requestThreadJump(requestId: string): void {
  pending = { id: requestId, until: Date.now() + JUMP_MS };
  // A 401 before or just after it lands: the sign-in comes back to the thread, not the request's top.
  setSignInNext(withThread);
  for (const listener of [...listeners]) listener();
}

/**
 * `location` ("/?r=<id>") with `to=thread` while a jump to that request's Messages waits or has just landed:
 * the address after sign-in (store-core sessionExpired, through nav.ts signInNext).
 */
export function withThread(location: string): string {
  let url: URL;
  try {
    url = new URL(location, 'https://lp.invalid');
  } catch {
    return location;
  }
  const id = url.searchParams.get('r');
  if (!id || url.searchParams.get('edit') !== null || wantsThread(url.searchParams)) return location;
  const recent = landed !== null && landed.id === id && Date.now() <= landed.until;
  if (!threadJumpWaiting(id) && !recent) return location;
  url.searchParams.set(THREAD_PARAM, THREAD_VALUE);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** A jump to this request's thread is waiting. */
export function threadJumpWaiting(requestId: string): boolean {
  return pending !== null && pending.id === requestId && Date.now() <= pending.until;
}

/** True once for the request whose jump is waiting. */
export function takeThreadJump(requestId: string): boolean {
  if (!threadJumpWaiting(requestId)) return false;
  pending = null;
  landed = { id: requestId, until: Date.now() + JUMP_MS };
  return true;
}

/** Another request's Messages opened first: a jump that was waiting for a request left behind is dropped. */
export function dropOtherThreadJump(requestId: string): void {
  if (pending && pending.id !== requestId) pending = null;
}

/** Called whenever a jump is asked for. Returns the remover. */
export function subscribeThreadJump(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Open the request at its Messages (a Message button, an unread badge, a message's Activity row or toast). */
export function openThread(requestId: string): void {
  requestThreadJump(requestId);
  navigate({ r: requestId });
}

/**
 * The page opened at "/?r=<id>&to=thread" (a message's notification, a new window or a reload): ask for the
 * jump and drop `to` from the address, so Back, Forward and a later reload open the request at its top.
 */
export function takeThreadParam(requestId: string): boolean {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  if (params.get('r') !== requestId || params.get('edit') !== null || !wantsThread(params)) return false;
  requestThreadJump(requestId);
  navigate({ r: requestId }, { replace: true });
  return true;
}
