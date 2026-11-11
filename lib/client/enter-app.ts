// (Cut-over fix A2) A successful sign-in always enters the app from the network, never from a stored page.
//
// The old build's service worker (EDC, 0a416a9) serves its stored copy of `/` before the network (public/sw.js
// navigation(), "network fix 2"), so a phone that signed in to a new event got the OLD app for one visit, running with
// the new session. /signin is network-first in that worker, so this code runs there: right before leaving for the
// app it deletes the stored `/` from every `lp-` cache. With none stored, that worker's navigation() goes to the
// network (it waits for it), serves the new build's page and stores it; the new page then registers its own worker,
// which takes over quietly (lib/client/sw-client.ts checkWaiting). Only `/` goes, from `lp-` caches only: the
// scripts, icons and /signin stay. Only the OLD build's page goes: every page of this build onwards carries
// <meta name="lp-shell" content="events"> (app/layout.tsx), and a stored `/` with it is kept, so a phone already on
// the new build keeps its instant / offline open and later deploys go through the worker's "Update ready" as before.
// A stored `/` that cannot be read counts as old.
//
// Only after a sign-in succeeded (the phone is online and about to load `/`), never on a page load: offline, the
// stored `/` is what opens the app. Bounded: a missing Cache API, a refusal or a hang never holds the sign-in up.
import { safeNextPath } from '../safe-next';

/** The longest the sign-in waits for the stored page to go. */
export const DROP_SHELL_TIMEOUT_MS = 1_500;

const CACHE_PREFIX = 'lp-';

/** In the HTML of every page from the events build on (app/layout.tsx); the pre-events build's page lacks it. */
export const SHELL_MARKER = 'name="lp-shell"';

/** The parts of the Cache Storage API used here (window.caches). */
export interface CachesLike {
  keys(): Promise<string[]>;
  open(name: string): Promise<{
    match(request: string): Promise<{ text(): Promise<string> } | undefined>;
    delete(request: string): Promise<boolean>;
  }>;
}

/** True when the stored text is the events build's page (or later). */
async function isCurrentShell(stored: { text(): Promise<string> }): Promise<boolean> {
  try {
    return (await stored.text()).includes(SHELL_MARKER);
  } catch {
    return false; // unreadable: treated as old
  }
}

function browserCaches(): CachesLike | null {
  try {
    return (globalThis as { caches?: CachesLike }).caches ?? null;
  } catch {
    return null; // a browser that refuses Cache Storage here
  }
}

/**
 * Deletes the stored app page `/` of the pre-events build (no SHELL_MARKER) from every `lp-` cache. Never rejects;
 * resolves within `timeoutMs`.
 */
export async function dropStoredShell(caches: CachesLike | null = browserCaches(), timeoutMs = DROP_SHELL_TIMEOUT_MS): Promise<void> {
  if (!caches) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = (async () => {
    const names = (await caches.keys()).filter((n) => n.startsWith(CACHE_PREFIX));
    await Promise.all(
      names.map(async (name) => {
        const cache = await caches.open(name);
        const stored = await cache.match('/').catch(() => null);
        if (stored === undefined) return; // nothing stored
        if (stored && (await isCurrentShell(stored))) return;
        await cache.delete('/');
      }),
    );
  })().catch(() => undefined);
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Where a sign-in goes: the safe `next`, else the app. A lead with no event open goes to the Events list even when
 * `next` is the app page (the old build's app sends a 401 to /signin?next=/).
 */
export function afterSignInPath(next: string | null, session: { role?: string; eventId?: string | null } | null): string {
  const safe = safeNextPath(next);
  const leadWithoutEvent = session?.role === 'lead' && !session.eventId;
  if (leadWithoutEvent && (safe === null || new URL(safe, 'https://lp.invalid').pathname === '/')) return '/events';
  return safe ?? '/';
}

/** After a successful sign-in: the stored `/` goes first (bounded), then the app opens with the new cookie. */
export async function enterApp(path: string): Promise<void> {
  await dropStoredShell();
  window.location.replace(path);
}
