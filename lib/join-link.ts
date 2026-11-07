// Team join link (design/DECISIONS.md "Team join link (Brian 2026-11-06 23:55)", docs/BUILD_SPEC.md J1).
//
//   https://<host>/signin#join=<code>    (also /#join=<code>: the proxy sends a signed-out visitor on to
//                                         /signin, and the browser keeps the fragment across the redirect)
//
// The code rides in the URL fragment, which never reaches a server (not in the request line, the logs or a
// Referer). Before first paint JOIN_LINK_SCRIPT (inlined with the theme script in app/layout.tsx), and again
// on every `hashchange` (the link opened in a tab already showing that page only changes the fragment, with
// no reload):
//   * on /signin keeps the code in sessionStorage (this tab only; never localStorage, a cookie or the URL);
//   * anywhere else drops it (the page rendered, so the visitor is already signed in: they just get the app);
//   * always removes the fragment from the address bar (history.replaceState), so it is in no back / forward
//     entry of the tab, later screenshot or re-shared link. The browser's own History list (and address-bar
//     suggestions, and History sync) already saved the visited link, code included, before any script ran:
//     nothing on the page can remove that (HANDOFF "Known limits").
// captureJoinCode() does the same from the sign-in flow (a page reached without the script, e.g. a copy
// cached before this build), then returns the kept code. The flow forgets it once the server answers.
// Imports nothing: the server layout and the client sign-in share it.

/** sessionStorage key holding the code while the sign-in flow is open in this tab. */
export const JOIN_STORAGE_KEY = 'lp-join';
/** The fragment parameter: `#join=<code>`. */
export const JOIN_PARAM = 'join';
/** Longest code kept (the server accepts 1–200 characters, like the password). */
export const JOIN_CODE_MAX = 200;
export const SIGNIN_PATH = '/signin';

/**
 * Tiny, dependency-free, runs before first paint and on every later `hashchange` (registered here, so before
 * any listener React adds). Keep in sync with captureJoinCode() (both are tested on the same cases in
 * tests/unit/join-link.test.ts). Blocked storage: the fragment is still removed.
 */
export const JOIN_LINK_SCRIPT = `(function(){function f(){try{var l=location,h=l.hash;if(!h||h.length<2)return;var p=new URLSearchParams(h.slice(1));if(!p.has(${JSON.stringify(JOIN_PARAM)}))return;var c=(p.get(${JSON.stringify(JOIN_PARAM)})||'').trim();if(l.pathname===${JSON.stringify(SIGNIN_PATH)}&&c&&c.length<=${JOIN_CODE_MAX}){try{sessionStorage.setItem(${JSON.stringify(JOIN_STORAGE_KEY)},c)}catch(e){}}history.replaceState(history.state,'',l.pathname+l.search)}catch(e){}}f();try{addEventListener('hashchange',f)}catch(e){}})();`;

/** The parts of `window` the join link touches (a fake one in unit tests). */
export interface JoinWindow {
  location: { pathname: string; search: string; hash: string };
  history: { replaceState(data: unknown, unused: string, url?: string | null): void };
  sessionStorage: Storage;
}

function currentWindow(): JoinWindow | null {
  return typeof window === 'undefined' ? null : window;
}

function storage(win: JoinWindow): Storage | null {
  try {
    return win.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** The kept code, or null. */
export function readJoinCode(win: JoinWindow | null = currentWindow()): string | null {
  if (!win) return null;
  try {
    const code = storage(win)?.getItem(JOIN_STORAGE_KEY) ?? null;
    return code && code.length <= JOIN_CODE_MAX ? code : null;
  } catch {
    return null;
  }
}

/** Forgets the kept code (after the server accepted or refused it). */
export function forgetJoinCode(win: JoinWindow | null = currentWindow()): void {
  if (!win) return;
  try {
    storage(win)?.removeItem(JOIN_STORAGE_KEY);
  } catch {
    // Blocked storage: nothing was kept.
  }
}

/**
 * JOIN_LINK_SCRIPT for the sign-in flow: keeps a `#join=` code from the address bar (on /signin only) and
 * removes the fragment, then returns the kept code (this one or one the pre-paint script kept), or null.
 * Idempotent, so React may call it twice.
 */
export function captureJoinCode(win: JoinWindow | null = currentWindow()): string | null {
  if (!win) return null;
  try {
    const { pathname, search, hash } = win.location;
    if (hash && hash.length > 1) {
      const params = new URLSearchParams(hash.slice(1));
      if (params.has(JOIN_PARAM)) {
        const code = (params.get(JOIN_PARAM) ?? '').trim();
        if (pathname === SIGNIN_PATH && code && code.length <= JOIN_CODE_MAX) {
          try {
            storage(win)?.setItem(JOIN_STORAGE_KEY, code);
          } catch {
            // Blocked storage: the link can't be used in this tab; the password step works as always.
          }
        }
        // A fresh state object (spec A26): Next's patched replaceState then keeps its router in step.
        win.history.replaceState(null, '', pathname + search);
      }
    }
  } catch {
    // An unreadable location or history: keep whatever is already kept.
  }
  return readJoinCode(win);
}
