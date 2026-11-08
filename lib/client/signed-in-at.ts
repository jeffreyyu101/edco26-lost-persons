// When this tab last signed in (sessionStorage `lp-signed-in-at`, this tab only, a time and nothing about the
// person). The sign-in screen writes it just before it opens the app; the app page reads it once
// (lib/client/system-notify.ts watchPendingOpens), so a notification tapped before a long sign-in still opens
// there. Off the app's first load: only the sign-in screen and system-notify import it.

export const SIGNED_IN_AT_KEY = 'lp-signed-in-at';

/** Called by the sign-in screen right after POST /api/session succeeded. Best effort. */
export function markSignedIn(): void {
  try {
    window.sessionStorage.setItem(SIGNED_IN_AT_KEY, String(Date.now()));
  } catch {
    // No sessionStorage: a notification tapped before sign-in opens only if the sign-in was quick.
  }
}

/** When this tab signed in (epoch ms), read once; null when it did not or it can't be read. */
export function takeSignedInAt(): number | null {
  try {
    const storage = window.sessionStorage;
    const raw = storage.getItem(SIGNED_IN_AT_KEY);
    if (raw === null) return null;
    storage.removeItem(SIGNED_IN_AT_KEY);
    const at = Number(raw);
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}
