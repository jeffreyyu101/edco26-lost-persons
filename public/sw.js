/* Service worker for "Is my friend in medical?" (spec §7 Service worker, v2.1 A15). Scope "/".
 *
 * Build id: the page registers /sw.js?v=<id>, where <id> is a hash of the server HTML's /_next/static/
 * scripts (lib/client/sw-client.ts). A new deploy means a new URL, so a new worker installs, waits, and
 * the page shows "Update ready · Reload" (it posts {type: 'skip-waiting'} when the user taps Reload).
 *
 * Strategies:
 *   /api/*                                   never cached, never touched (passthrough)
 *   navigations (/ and /signin)              network first, 4 s timeout, then the cached page
 *   /_next/static/*, /icons, /logos, /fonts  cache first
 *   /manifest.webmanifest                    network first, cached fallback
 *   anything else                            passthrough
 * Only 200 same-origin "basic" responses are cached: never redirects or opaque responses. The cached `/`
 * is stored whole (headers included, so its CSP nonce matches its scripts) and contains no request data:
 * every row is fetched by the client.
 */
'use strict';

const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE = 'lp-' + VERSION;
const NAV_TIMEOUT_MS = 4000;
const MAX_PRECACHE = 400;
const CORE = [
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png',
  '/logos/edc-orlando.png',
  '/logos/ground-control.png',
];
const STATIC_PREFIXES = ['/_next/static/', '/icons/', '/logos/', '/fonts/'];
const PAGES = ['/', '/signin'];

function isStatic(pathname) {
  return STATIC_PREFIXES.some((p) => pathname.startsWith(p));
}

function cacheable(res) {
  return !!res && res.status === 200 && res.type === 'basic' && !res.redirected;
}

async function cacheIfOk(cache, url, init) {
  try {
    const res = await fetch(url, Object.assign({ credentials: 'same-origin', redirect: 'manual' }, init || {}));
    if (cacheable(res)) {
      await cache.put(url, res.clone());
      return res;
    }
  } catch (e) {
    // offline or blocked: best effort
  }
  return null;
}

/** /_next/static URLs referenced by an HTML page or a stylesheet (fonts live in /_next/static/media). */
function assetUrls(text) {
  const out = new Set();
  const re = /(?:src|href)="(\/_next\/static\/[^"]+)"|url\((?:'|")?(\/_next\/static\/[^)'"]+)(?:'|")?\)/g;
  let m;
  while ((m = re.exec(text))) out.add((m[1] || m[2]).replace(/&amp;/g, '&'));
  return [...out];
}

async function precacheUrls(cache, urls) {
  let count = 0;
  const list = urls
    .filter((u) => typeof u === 'string')
    .map((u) => {
      try {
        const url = new URL(u, self.location.origin);
        return url.origin === self.location.origin && isStatic(url.pathname) ? url.pathname + url.search : null;
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean)
    .slice(0, MAX_PRECACHE);
  const unique = [...new Set(list)];
  const queue = unique.slice();
  const worker = async () => {
    while (queue.length) {
      const url = queue.shift();
      if (await cache.match(url)) {
        count += 1;
        continue;
      }
      const res = await cacheIfOk(cache, url);
      if (res) {
        count += 1;
        if (url.endsWith('.css')) {
          try {
            for (const nested of assetUrls(await res.clone().text())) if (!unique.includes(nested)) queue.push(nested);
          } catch (e) {
            // ignore
          }
        }
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return count;
}

/** Cache the signed-in shell and every asset it references (only a 200 page, never the sign-in redirect). */
async function precacheShell(cache) {
  const res = await cacheIfOk(cache, '/', { cache: 'no-store' });
  if (!res) return;
  try {
    await precacheUrls(cache, assetUrls(await res.clone().text()));
  } catch (e) {
    // ignore
  }
}

/** The sign-in page as a signed-out visitor gets it (no cookie), and the assets it references. */
async function precacheSignIn(cache) {
  const res = await cacheIfOk(cache, '/signin', { cache: 'no-store', credentials: 'omit' });
  if (!res) return;
  try {
    await precacheUrls(cache, assetUrls(await res.clone().text()));
  } catch (e) {
    // ignore
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(CORE.map((u) => cacheIfOk(cache, u)));
      await precacheShell(cache);
      // /signin without the cookie (signed in, the proxy would redirect it to /), plus its own chunks.
      await precacheSignIn(cache);
      // The very first install takes over at once; an update waits for "Reload".
      if (!self.registration.active) await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.startsWith('lp-') && n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'skip-waiting') {
    self.skipWaiting();
    return;
  }
  if (data.type === 'precache' && Array.isArray(data.urls)) {
    const port = event.ports && event.ports[0];
    event.waitUntil(
      (async () => {
        try {
          const cache = await caches.open(CACHE);
          if (!(await cache.match('/'))) await precacheShell(cache);
          const count = await precacheUrls(cache, data.urls);
          if (port) port.postMessage({ ok: true, count });
        } catch (e) {
          if (port) port.postMessage({ ok: false });
        }
      })(),
    );
  }
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (cacheable(res)) await cache.put(request, res.clone());
  return res;
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(request);
    if (cacheable(res)) await cache.put(request, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(request);
    if (hit) return hit;
    throw e;
  }
}

async function navigation(event) {
  const url = new URL(event.request.url);
  const key = PAGES.includes(url.pathname) ? url.pathname : null;
  const network = fetch(event.request).then(async (res) => {
    if (key && cacheable(res)) {
      const cache = await caches.open(CACHE);
      await cache.put(key, res.clone());
    }
    return res;
  });
  if (!key) return network;
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), NAV_TIMEOUT_MS));
  const first = await Promise.race([network.catch(() => null), timeout]);
  if (first) return first;
  const cache = await caches.open(CACHE);
  const hit = await cache.match(key);
  if (hit) {
    // Lie-fi: serve the shell now, let the network finish in the background to refresh it.
    event.waitUntil(network.catch(() => undefined));
    return hit;
  }
  return network;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  let url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') {
    event.respondWith(navigation(event));
    return;
  }
  if (isStatic(url.pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (url.pathname === '/manifest.webmanifest') {
    event.respondWith(networkFirst(request));
  }
});
