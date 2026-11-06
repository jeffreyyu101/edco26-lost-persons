// Session signals shared by the store (on `/`) and the sign-in screen (on /signin, outside the store).
// No React and no store import. Nothing here runs at import time (server-render invariants, A38).
//
//   * The pending sign-out marker (localStorage `lp-logout-pending`). The store writes it before it asks the
//     server to clear the cookie and removes it once the server confirmed it or the attempt was given up.
//     A page that loads while it is set (the app was reloaded or killed mid sign-out) finishes the sign-out
//     before it trusts the session again. A successful sign-in removes it, so it can never end a new session.
//   * The sign-in announcement on BroadcastChannel('lp'). Open tabs of the app re-check GET /api/session
//     when they hear it, so a tab that kept an older identity (suspended while someone else signed in)
//     switches to the staff the cookie now belongs to before it syncs, writes or sends queued requests.
//
// Neither carries a name or anything else about the person: the marker holds a time and a flag, and the
// message only says that a sign-in happened.

/** The store's BroadcastChannel name (logout, outbox, myids, signin). */
export const SESSION_CHANNEL = 'lp';
export const LOGOUT_PENDING_KEY = 'lp-logout-pending';

export interface LogoutPending {
  /** Local epoch ms when the sign-out started. */
  at: number;
  /** The user chose "Discard & sign out" (unsent requests go too). */
  discard: boolean;
}

export function readLogoutPending(storage: Storage | null): LogoutPending | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(LOGOUT_PENDING_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<LogoutPending> | null;
    // Anything unreadable still means a sign-out was asked for: finish it, keeping unsent requests.
    return { at: typeof parsed?.at === 'number' ? parsed.at : 0, discard: parsed?.discard === true };
  } catch {
    return { at: 0, discard: false };
  }
}

/** Best effort: false when storage refused it (the in-memory state still guards this tab). */
export function writeLogoutPending(storage: Storage | null, value: LogoutPending): boolean {
  if (!storage) return false;
  try {
    storage.setItem(LOGOUT_PENDING_KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function clearLogoutPending(storage: Storage | null): void {
  try {
    storage?.removeItem(LOGOUT_PENDING_KEY);
  } catch {
    // best effort
  }
}

/**
 * Called by the sign-in screen right after POST /api/session succeeded: a sign-out that never finished
 * must not end this new session, and open tabs must re-check who is signed in.
 */
export function announceSignIn(): void {
  if (typeof window === 'undefined') return;
  let storage: Storage | null = null;
  try {
    storage = window.localStorage;
  } catch {
    storage = null;
  }
  clearLogoutPending(storage);
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const channel = new BroadcastChannel(SESSION_CHANNEL);
    channel.postMessage({ type: 'signin' });
    channel.close();
  } catch {
    // No channel: open tabs still re-check the session when they become visible again.
  }
}
