// Service-worker wiring for `/` (spec §7 Service worker, v2.1 A15). Production builds only (in development
// a cache-first SW would serve stale chunks to the dev server).
//
// Build id. public/sw.js is a static file, so the build is injected through its URL: `/sw.js?v=<id>`, and
// the SW names its cache `lp-<id>`. The id is a hash of the `/_next/static/` scripts in the SERVER HTML of
// `/` (content-hashed file names, so it changes with every deploy). It is captured when this module is first
// evaluated, before any next/dynamic view chunk adds its own <script>. A new id means a new registration URL,
// which installs a new worker: it waits, and the store shows "Update ready · Reload".
// A tab that stays open across a deploy finds out by fetching `/` now and then (visible only, throttled, 8 s after
// the page shows) and comparing the script set.
import { SYNC } from './constants';

const STATIC_PREFIX = '/_next/static/';
const DEPLOY_CHECK_MS = 10 * 60_000;
const PRECACHE_REPLY_MS = 30_000;

/** FNV-1a over the sorted unique URLs, base 36. Empty when there are none. */
export function buildIdFrom(urls: readonly string[]): string {
  const list = [...new Set(urls.filter((u) => u.includes(STATIC_PREFIX)).map(pathOf))].sort();
  if (list.length === 0) return '';
  let h = 0x811c9dc5;
  for (const ch of list.join('|')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(36)}${list.length.toString(36)}`;
}

function pathOf(url: string): string {
  try {
    const u = new URL(url, 'https://lp.invalid');
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

/** The build id a worker was registered with (`/sw.js?v=<id>`), or null. */
export function scriptBuild(scriptURL: string): string | null {
  try {
    return new URL(scriptURL, 'https://lp.invalid').searchParams.get('v');
  } catch {
    return null;
  }
}

/** `<script src>` URLs in an HTML document's text. */
export function scriptSrcsFromHtml(html: string): string[] {
  return [...html.matchAll(/<script\b[^>]*\ssrc="([^"]+)"/g)].map((m) => (m[1] ?? '').replace(/&amp;/g, '&'));
}

// Captured at module evaluation (see the header): the scripts the server rendered.
const INITIAL_SCRIPTS: readonly string[] =
  typeof document === 'undefined' ? [] : Array.from(document.scripts, (s) => s.src).filter((s) => s.includes(STATIC_PREFIX));

/** Every same-origin static asset this page has loaded (A15): resources, scripts, stylesheets, preloads. */
export function collectAssetUrls(): string[] {
  if (typeof window === 'undefined') return [];
  const origin = window.location.origin;
  const urls = new Set<string>();
  const add = (raw: string | null | undefined) => {
    if (!raw) return;
    try {
      const u = new URL(raw, origin);
      if (u.origin === origin && u.pathname.startsWith(STATIC_PREFIX)) urls.add(`${u.pathname}${u.search}`);
    } catch {
      // ignore
    }
  };
  try {
    for (const e of performance.getEntriesByType('resource')) add(e.name);
  } catch {
    // no resource timing
  }
  for (const s of Array.from(document.scripts)) add(s.src);
  for (const l of Array.from(document.querySelectorAll<HTMLLinkElement>('link[href]'))) add(l.href);
  return [...urls];
}

export interface SwHooks {
  onUpdateReady(): void;
  onOfflineReady(): void;
}

export interface SwController {
  stop(): void;
  /** Activate the waiting worker and reload once it controls the page. False when nothing is waiting. */
  activateWaiting(): boolean;
  /** Post every static URL to the active worker and wait for it to cache them (A15). */
  precache(): Promise<boolean>;
}

function postWithReply(target: ServiceWorker, message: unknown, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(false), timeoutMs);
    channel.port1.onmessage = (event: MessageEvent<{ ok?: boolean }>) => {
      clearTimeout(timer);
      resolve(event.data?.ok === true);
    };
    try {
      target.postMessage(message, [channel.port2]);
    } catch {
      clearTimeout(timer);
      resolve(false);
    }
  });
}

export function startServiceWorker(hooks: SwHooks): SwController | null {
  if (process.env.NODE_ENV !== 'production') return null;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || typeof window === 'undefined') return null;
  const buildId = buildIdFrom(INITIAL_SCRIPTS);
  if (!buildId) return null;
  const sw = navigator.serviceWorker;
  let reg: ServiceWorkerRegistration | null = null;
  let stopped = false;
  let wantReload = false;
  let reloading = false;
  let lastDeployCheck = Date.now();
  let checking = false;

  const reload = () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  };
  const onControllerChange = () => {
    // The first install claims the page too; only reload when the user asked for the update.
    if (wantReload) reload();
  };
  sw.addEventListener('controllerchange', onControllerChange);

  const checkWaiting = (r: ServiceWorkerRegistration) => {
    const waiting = r.waiting;
    const controller = sw.controller;
    if (stopped || !waiting || !controller) return;
    // The same build id (same ?v=) is not an update the user has to load: a second install of the same
    // worker (seen when two tabs install at once) takes over quietly, without "Update ready". (Cut-over fix A3) So
    // does a worker of the build this page already runs: the page came from the network under an older worker (a
    // sign-in on a phone that held the old build, lib/client/enter-app.ts). No reload: the page is that build.
    if (waiting.scriptURL === controller.scriptURL || scriptBuild(waiting.scriptURL) === buildId) {
      waiting.postMessage({ type: 'skip-waiting' });
      return;
    }
    hooks.onUpdateReady();
  };
  const watch = (r: ServiceWorkerRegistration) => {
    checkWaiting(r);
    r.addEventListener('updatefound', () => {
      const installing = r.installing;
      installing?.addEventListener('statechange', () => {
        if (installing.state === 'installed') checkWaiting(r);
      });
    });
  };

  const register = (id: string) =>
    sw.register(`/sw.js?v=${encodeURIComponent(id)}`, { scope: '/' }).then(
      (r: ServiceWorkerRegistration | undefined) => {
        // Some environments (blocked or stubbed service workers) resolve without a registration.
        if (!r) return null;
        if (!reg) {
          reg = r;
          watch(r);
        }
        return r;
      },
      () => null,
    );
  void register(buildId);

  // (network fix 2 follow-up) A page served from the stored `/` runs the stored build. When the worker's background
  // refresh finds another one, it says so (lp-build with its scripts; asked once here in case that came first): register
  // it now, which ends in "Update ready", instead of waiting minutes for the deploy check.
  const onMessage = (event: MessageEvent<{ type?: unknown; scripts?: unknown }>) => {
    const scripts = event.data?.type === 'lp-build' ? event.data.scripts : null;
    const next = Array.isArray(scripts) ? buildIdFrom(scripts.filter((s): s is string => typeof s === 'string')) : '';
    if (next && next !== buildId && !stopped) void register(next);
  };
  sw.addEventListener('message', onMessage);
  try {
    sw.controller?.postMessage({ type: 'lp-build' });
  } catch {
    // no worker yet
  }

  // A tab open across a deploy: compare the live `/` script set with ours.
  const deployCheck = async () => {
    if (stopped || checking || document.visibilityState !== 'visible') return;
    if (Date.now() - lastDeployCheck < DEPLOY_CHECK_MS / 2) return;
    checking = true;
    lastDeployCheck = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SYNC.requestTimeoutMs);
      const res = await fetch('/', { cache: 'no-store', credentials: 'same-origin', redirect: 'manual', signal: controller.signal });
      clearTimeout(timer);
      if (res.type === 'opaqueredirect' || !res.ok) return;
      const next = buildIdFrom(scriptSrcsFromHtml(await res.text()));
      if (next && next !== buildId && !stopped) await register(next);
    } catch {
      // Offline: try again later.
    } finally {
      checking = false;
    }
  };
  // Never in the way of the sync a resume starts: the check goes out 8 s after the page shows (and the interval, which
  // a locked phone runs on unlock, waits the same); a glance shorter than that checks nothing.
  let later: ReturnType<typeof setTimeout> | undefined;
  const onVisible = () => {
    clearTimeout(later);
    if (document.visibilityState === 'visible') later = setTimeout(deployCheck, 8_000);
  };
  const interval = setInterval(onVisible, DEPLOY_CHECK_MS);
  document.addEventListener('visibilitychange', onVisible);

  return {
    stop() {
      stopped = true;
      clearInterval(interval);
      clearTimeout(later);
      document.removeEventListener('visibilitychange', onVisible);
      sw.removeEventListener('controllerchange', onControllerChange);
      sw.removeEventListener('message', onMessage);
    },
    activateWaiting() {
      const waiting = (reg as ServiceWorkerRegistration | null)?.waiting;
      if (!waiting) return false;
      wantReload = true;
      waiting.postMessage({ type: 'skip-waiting' });
      // If controllerchange never comes (an old browser), reload anyway.
      setTimeout(reload, 4_000);
      return true;
    },
    async precache() {
      try {
        const ready = await sw.ready;
        const target = ready.active;
        if (!target || stopped) return false;
        const ok = await postWithReply(target, { type: 'precache', urls: collectAssetUrls() }, PRECACHE_REPLY_MS);
        if (ok && !stopped) hooks.onOfflineReady();
        return ok;
      } catch {
        return false;
      }
    },
  };
}
