/* Service worker for "Is my friend in medical?" (spec §7 Service worker, v2.1 A15). Scope "/".
 *
 * Build id: the page registers /sw.js?v=<id>, where <id> is a hash of the server HTML's /_next/static/
 * scripts (lib/client/sw-client.ts). A new deploy means a new URL, so a new worker installs, waits, and
 * the page shows "Update ready · Reload" (it posts {type: 'skip-waiting'} when the user taps Reload).
 *
 * Updates never cost offline access:
 *   * Complete before "Update ready". A worker installing over an active one caches the WHOLE build: `/`,
 *     `/signin`, CORE, everything the two pages reference, and every file in /sw-manifest.json, which
 *     `next build` writes with every /_next/static file, the next/dynamic view chunks included
 *     (scripts/sw-manifest.mjs). /_next/static names are content-hashed, so files the older caches already
 *     hold are copied, not downloaded. If anything is missing (no signal, no manifest, or a deploy landing
 *     mid-install so the pages and the manifest disagree), the install fails: the old worker and its cache
 *     keep serving, and the page registers the update again later. Retries keep what was already cached.
 *   * The very first install has nothing to replace: best effort, it takes over at once, and the page tops
 *     it up with every chunk it loaded (A15).
 *   * Activation deletes no cache a page may still use. Each older `lp-` cache is retired with the ids of
 *     the pages open at that moment, and deleted once none of them is left (checked on activation,
 *     navigations and precache messages). Until then static requests fall back to it, so a tab still
 *     running the older build keeps loading its own chunks offline.
 *
 * Strategies:
 *   /api/*                                   never cached, never touched (passthrough)
 *   navigations (/ and /signin)              network first, 4 s timeout, then the cached page
 *   /_next/static/*                          cache first: this worker's cache, then older caches
 *   /icons, /logos, /fonts                   cache first: this worker's cache, then network, then older caches
 *   /manifest.webmanifest                    network first, cached fallback
 *   anything else                            passthrough
 * Only 200 same-origin "basic" responses are cached: never redirects or opaque responses. The cached `/`
 * is stored whole (headers included, so its CSP nonce matches its scripts) and contains no request data:
 * every row is fetched by the client.
 *
 * Notifications (v2.5 A52): the page shows an alert as a system notification through this registration
 * while the app is in the background (lib/client/system-notify.ts). There is no push: this worker only
 * handles the click. It closes the notification, focuses an open window of the app and has it open the
 * request (`/?r=<id>`, `/` for a combined one) in place; a window that does not answer is navigated there;
 * with no window, one opens. A page asks {type: 'lp-caps'} first and notifies only once the active worker
 * answers {notificationClick: true}: the worker of an older build has no click handler and never answers.
 * Before that hand-off the click's target is kept in META (it outlives this worker): an iPhone Home Screen
 * app launched or resumed at its start URL `/`, a frozen page or one whose listener is not in yet misses
 * the hand-off, and navigate() / openWindow() may do nothing there. The page asks {type: 'lp-take-open'}
 * when it starts and whenever it comes back (a few times, in case this click is still being kept), and
 * opens what it gets only if it was tapped just then (lib/client/system-notify.ts watchPendingOpens): taken
 * once, kept 10 minutes at most (the first app page after a sign-in), cleared when a page answers lp-open
 * {ok: true}. A click a page took that way is not navigated to or opened in a window again.
 *
 * Web Push (F4, spec §18 A54): a push shows its notification (title, body, tag "lp-<id>", the app icon;
 * messages sound again when they replace one) and sets the app icon badge to the recipient's unread
 * Activity count. Never both a toast and a notification: every visible window of the app is asked
 * ({type: 'lp-push'} with a port) whether it is in front by the page's own rule (visible, and on a computer
 * focused), and one that is takes the event in the app (it syncs, and toasts it) while nothing is shown,
 * except on WebKit (Safari, every iPhone browser), which revokes a subscription after three pushes that show
 * nothing: there the notification is shown silently and closed at once. A window that does not answer in
 * time (an older build) counts as in front when it is visible and focused. "Send a test alert" (kind
 * 'test') always shows: it is tapped inside the app. A click opens the request (the handler above). pushsubscriptionchange re-subscribes with the same key and tells the server, which
 * drops the old endpoint. The worker answers {type: 'lp-caps'} with {push: true} too: a page subscribes
 * only once the active worker can show pushes.
 *
 * Telemetry (2026-11-08, design/references/observability-design.md §4.7): after a push is shown (or not), and at the
 * very end of a click (after focus, lp-open, navigate or openWindow, so it never costs the click its user activation),
 * the worker appends one entry to a small log in META (`/__lp/tel`, at most 100 entries, none older than 24 h): the
 * push's kind, when it arrived, its sentAt, whether a window took it and whether a notification showed; or the click's
 * kind, age and how it opened. No title, body, URL or id. A page's collector takes the log with {type: 'lp-tel-take'}
 * (it is cleared then). A failed log write is swallowed: it can never stop a notification or a click.
 */
'use strict';

const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const PREFIX = 'lp-';
const CACHE = PREFIX + VERSION;
// Retired caches ({cacheName: [client ids]}), kept outside the `lp-` namespace.
const META = 'lp:meta';
const RETIRED_KEY = '/__lp/retired';
const MANIFEST_URL = '/sw-manifest.json';
const HASHED_PREFIX = '/_next/static/';
const NAV_TIMEOUT_MS = 4000;
// Most URLs a page may post in one precache message (A15).
const MAX_PRECACHE = 400;
// How long a window may take to answer "open this request" before it is navigated instead (A52).
const OPEN_REPLY_MS = 1500;
const OPEN_MESSAGE = 'lp-open';
const CAPS_MESSAGE = 'lp-caps';
// The page asks for the notification click no page has opened yet (lib/client/system-notify.ts).
const TAKE_OPEN_MESSAGE = 'lp-take-open';
// The click no page has opened yet ({url, at}), in META: it outlives this worker.
const PENDING_OPEN_KEY = '/__lp/pending-open';
// The longest a click is kept for a page to take: the first app page after a sign-in (lib/client/system-notify.ts
// PENDING_SIGNIN_MS). The page decides whether it is still worth opening.
const PENDING_OPEN_MS = 10 * 60 * 1000;
// The click's hand-off never waits longer than this for the target to be stored.
const PENDING_SAVE_MS = 500;
const CORE = [
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png',
  '/logos/edc-orlando.png',
  '/logos/ground-control.png',
];
const STATIC_PREFIXES = [HASHED_PREFIX, '/icons/', '/logos/', '/fonts/'];
const PAGES = ['/', '/signin'];

function isStatic(pathname) {
  return STATIC_PREFIXES.some((p) => pathname.startsWith(p));
}

function cacheable(res) {
  return !!res && res.status === 200 && res.type === 'basic' && !res.redirected;
}

function pathOf(url) {
  return new URL(url, self.location.origin).pathname;
}

// ---- Caches -------------------------------------------------------------------------------------------

function cacheNameOf(worker) {
  if (!worker || !worker.scriptURL) return null;
  try {
    return PREFIX + (new URL(worker.scriptURL).searchParams.get('v') || 'dev');
  } catch (e) {
    return null;
  }
}

/** This worker's cache and those of every worker in the registration (installing, waiting, active). */
function liveCaches() {
  const r = self.registration;
  return new Set([CACHE, cacheNameOf(r.installing), cacheNameOf(r.waiting), cacheNameOf(r.active)].filter(Boolean));
}

/** The other `lp-` caches, newest first. */
async function otherCaches() {
  return (await caches.keys()).filter((n) => n.startsWith(PREFIX) && n !== CACHE).reverse();
}

/**
 * `request` in `cache`. A /_next/static name is content-hashed, so the same path under any query (a
 * deployment id, or none) is the same file: `hashed` matches ignoring the query.
 */
async function matchIn(cache, request, hashed) {
  return (await cache.match(request)) || (hashed ? await cache.match(request, { ignoreSearch: true }) : undefined);
}

/** `request` from another `lp-` cache, newest first. */
async function matchOther(request, hashed) {
  for (const name of await otherCaches()) {
    const hit = await matchIn(await caches.open(name), request, hashed);
    if (hit) return hit;
  }
  return undefined;
}

function isHashed(url) {
  return pathOf(url).startsWith(HASHED_PREFIX);
}

let metaQueue = Promise.resolve();

/** Read-modify-write the retired map, one change at a time. */
function updateRetired(change) {
  const run = metaQueue.then(async () => {
    const meta = await caches.open(META);
    let retired = {};
    try {
      const res = await meta.match(RETIRED_KEY);
      const data = res ? await res.json() : null;
      if (data && typeof data === 'object' && !Array.isArray(data)) retired = data;
    } catch (e) {
      retired = {};
    }
    const before = JSON.stringify(retired);
    await change(retired);
    const after = JSON.stringify(retired);
    if (after !== before) await meta.put(RETIRED_KEY, new Response(after, { headers: { 'Content-Type': 'application/json' } }));
  });
  metaQueue = run.catch(() => undefined);
  return run;
}

/** On activation: every other `lp-` cache may still serve a page open now (an older build). */
async function retireOthers() {
  const pages = await self.clients.matchAll({ type: 'all', includeUncontrolled: true });
  const ids = pages.map((c) => c.id);
  const names = (await caches.keys()).filter((n) => n.startsWith(PREFIX));
  await updateRetired((retired) => {
    const live = liveCaches();
    for (const name of names) if (!live.has(name) && !retired[name]) retired[name] = ids;
    for (const name of live) delete retired[name];
  });
}

/** Delete each retired cache once none of the pages open when it was retired is left. */
async function sweep() {
  await updateRetired(async (retired) => {
    const live = liveCaches();
    for (const name of Object.keys(retired)) {
      // A worker of that version is back (installing, waiting or active): its cache is in use again.
      if (live.has(name)) {
        delete retired[name];
        continue;
      }
      const ids = Array.isArray(retired[name]) ? retired[name] : [];
      const open = await Promise.all(ids.map((id) => self.clients.get(id).catch(() => undefined)));
      if (open.some(Boolean)) continue;
      await caches.delete(name);
      delete retired[name];
    }
  });
}

function sweepLater(event) {
  try {
    event.waitUntil(sweep().catch(() => undefined));
  } catch (e) {
    // the event can no longer be extended
  }
}

// ---- Precache -----------------------------------------------------------------------------------------

async function cacheIfOk(cache, url, init) {
  try {
    const res = await fetch(url, Object.assign({ credentials: 'same-origin', redirect: 'manual' }, init || {}));
    if (cacheable(res)) {
      await cache.put(url, res.clone());
      return res;
    }
  } catch (e) {
    // offline, blocked or out of space
  }
  return null;
}

/** `url` in `cache`: already there, copied from an older cache (/_next/static only), or fetched. */
async function ensureCached(cache, url) {
  const hashed = isHashed(url);
  const have = await matchIn(cache, url, hashed);
  if (have) return have;
  if (hashed) {
    const old = await matchOther(url, true);
    if (old) {
      try {
        await cache.put(url, old.clone());
        return old;
      } catch (e) {
        return null;
      }
    }
  }
  return cacheIfOk(cache, url);
}

/** /_next/static URLs referenced by an HTML page or a stylesheet (fonts live in /_next/static/media). */
function assetUrls(text) {
  const out = new Set();
  const re = /(?:src|href)="(\/_next\/static\/[^"]+)"|url\((?:'|")?(\/_next\/static\/[^)'"]+)(?:'|")?\)/g;
  let m;
  while ((m = re.exec(text))) out.add((m[1] || m[2]).replace(/&amp;/g, '&'));
  return [...out];
}

/** Same-origin static URL as path + query, or null. */
function staticKey(u) {
  if (typeof u !== 'string') return null;
  try {
    const url = new URL(u, self.location.origin);
    return url.origin === self.location.origin && isStatic(url.pathname) ? url.pathname + url.search : null;
  } catch (e) {
    return null;
  }
}

/** Cache `urls` (and the /_next/static URLs their stylesheets name). Returns the URLs that could not be. */
async function precacheUrls(cache, urls, limit) {
  const unique = [...new Set(urls.map(staticKey).filter(Boolean))].slice(0, limit);
  const seen = new Set(unique);
  const queue = unique.slice();
  const missing = [];
  let cached = 0;
  const worker = async () => {
    while (queue.length) {
      const url = queue.shift();
      const res = await ensureCached(cache, url);
      if (!res) {
        missing.push(url);
        continue;
      }
      cached += 1;
      if (pathOf(url).endsWith('.css')) {
        try {
          for (const nested of assetUrls(await res.clone().text())) {
            if (!seen.has(nested)) {
              seen.add(nested);
              queue.push(nested);
            }
          }
        } catch (e) {
          // ignore
        }
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return { cached, missing };
}

/** A page fetched fresh, not cached yet (only a 200, never a redirect): {res, html}, or null. */
async function fetchPage(path, init) {
  try {
    const res = await fetch(path, Object.assign({ credentials: 'same-origin', redirect: 'manual', cache: 'no-store' }, init || {}));
    if (!cacheable(res)) return null;
    return { res, html: await res.clone().text() };
  } catch (e) {
    return null;
  }
}

/** Store a fetched page whole (headers included, so its CSP nonce matches its scripts). */
async function putPage(cache, path, page) {
  try {
    await cache.put(path, page.res);
    return true;
  } catch (e) {
    return false;
  }
}

/** The live build's /_next/static file list (scripts/sw-manifest.mjs), or null. */
async function loadManifest() {
  try {
    const res = await fetch(MANIFEST_URL, { cache: 'no-store', credentials: 'same-origin', redirect: 'manual' });
    if (!cacheable(res)) return null;
    const data = await res.json();
    const assets = data && Array.isArray(data.assets) ? data.assets.filter((u) => typeof u === 'string' && u.startsWith(HASHED_PREFIX)) : [];
    return assets.length ? assets : null;
  } catch (e) {
    return null;
  }
}

/**
 * Cache the whole live build into `cache`: CORE, the signed-in shell `/`, `/signin` as a signed-out
 * visitor gets it, everything both reference, and every manifest asset. The pages go in last, and when
 * `strict` only once everything else is in: a cache never holds a page whose files it lacks (a re-install
 * of the active version writes into the active cache). Returns every URL that must now be in the cache,
 * and what is missing (empty when the build is complete).
 */
async function precacheBuild(cache, strict) {
  const problems = [];
  const manifest = await loadManifest();
  if (!manifest) problems.push(MANIFEST_URL);
  const [shell, signIn] = await Promise.all([
    fetchPage('/'),
    // Without the cookie: signed in, the proxy would redirect /signin to /.
    fetchPage('/signin', { credentials: 'omit' }),
  ]);
  if (!shell) problems.push('/');
  if (!signIn) problems.push('/signin');
  const referenced = assetUrls((shell ? shell.html : '') + (signIn ? signIn.html : ''));
  if (manifest) {
    // The pages must be the build the manifest lists, not a deploy that landed in between.
    const listed = new Set(manifest);
    for (const u of referenced) if (!listed.has(pathOf(u))) problems.push(u);
  }
  const assets = referenced.concat(manifest || []);
  const [core, built] = await Promise.all([Promise.all(CORE.map((u) => ensureCached(cache, u))), precacheUrls(cache, assets, Infinity)]);
  core.forEach((res, i) => {
    if (!res) problems.push(CORE[i]);
  });
  problems.push(...built.missing);
  if (!strict || problems.length === 0) {
    if (shell && !(await putPage(cache, '/', shell))) problems.push('/');
    if (signIn && !(await putPage(cache, '/signin', signIn))) problems.push('/signin');
  }
  return { required: PAGES.concat(CORE, assets.map(staticKey).filter(Boolean)), problems };
}

async function install() {
  // Retried after an earlier activation retired this version's cache: it is in use again.
  await updateRetired((retired) => {
    delete retired[CACHE];
  }).catch(() => undefined);
  const cache = await caches.open(CACHE);
  if (!self.registration.active) {
    // The very first install: nothing to replace. Best effort, then take over at once.
    try {
      await precacheBuild(cache, false);
    } catch (e) {
      // the page tops the cache up (A15)
    }
    await self.skipWaiting();
    return;
  }
  // An update waits for "Reload", and Reload must find the whole new build (see the header).
  const { required, problems } = await precacheBuild(cache, true);
  if (problems.length === 0) {
    // Read back by name: the cache that activation will use holds every file.
    const check = await caches.open(CACHE);
    for (const url of required) if (!(await matchIn(check, url, isHashed(url)))) problems.push(url);
  }
  if (problems.length > 0) throw new Error(`Update not installed: ${problems.length} file(s) could not be cached`);
}

self.addEventListener('install', (event) => {
  event.waitUntil(install());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Book-keeping failures only keep caches longer; they never delete one.
      await retireOthers().catch(() => undefined);
      await self.clients.claim();
      await sweep().catch(() => undefined);
    })(),
  );
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'skip-waiting') {
    self.skipWaiting();
    return;
  }
  if (data.type === CAPS_MESSAGE) {
    // This worker handles notification clicks (A52): the page may show alerts as notifications. It also
    // shows Web Pushes (F4): the page may subscribe.
    const port = event.ports && event.ports[0];
    if (port) port.postMessage({ notificationClick: true, push: true });
    return;
  }
  if (data.type === TEL_TAKE_MESSAGE) {
    // Telemetry: the push and click log, once ({entries}); an older worker never answers this.
    const port = event.ports && event.ports[0];
    event.waitUntil(
      takeTelLog().then((entries) => {
        if (port) port.postMessage({ entries });
      }),
    );
    return;
  }
  if (data.type === TAKE_OPEN_MESSAGE) {
    // A page that started or came back: the click it should open, once ({open: {url, at}}), or {open: null}.
    const port = event.ports && event.ports[0];
    const reply = (open) => {
      if (port) port.postMessage({ open });
    };
    event.waitUntil(takePendingOpen().then(reply, () => reply(null)));
    return;
  }
  if (data.type === 'precache' && Array.isArray(data.urls)) {
    const port = event.ports && event.ports[0];
    event.waitUntil(
      (async () => {
        try {
          const cache = await caches.open(CACHE);
          if (!(await cache.match('/'))) {
            const shell = await fetchPage('/');
            if (shell) {
              await precacheUrls(cache, assetUrls(shell.html), MAX_PRECACHE);
              await putPage(cache, '/', shell);
            }
          }
          const { cached } = await precacheUrls(cache, data.urls, MAX_PRECACHE);
          if (port) port.postMessage({ ok: true, count: cached });
        } catch (e) {
          if (port) port.postMessage({ ok: false });
        }
        await sweep().catch(() => undefined);
      })(),
    );
  }
});

// ---- Fetch --------------------------------------------------------------------------------------------

async function cacheFirst(request) {
  const hashed = isHashed(request.url);
  const cache = await caches.open(CACHE);
  const hit = await matchIn(cache, request, hashed);
  if (hit) return hit;
  // Content-hashed: an older cache holds the same bytes (an older tab's chunks too).
  if (hashed) {
    const old = await matchOther(request, true);
    if (old) return old;
  }
  try {
    const res = await fetch(request);
    if (cacheable(res)) await cache.put(request, res.clone());
    return res;
  } catch (e) {
    // Offline: an older copy of an icon, logo or font beats none.
    const old = hashed ? undefined : await matchOther(request, false);
    if (old) return old;
    throw e;
  }
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
    // A reload or a closed tab may have released a retired cache.
    sweepLater(event);
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

// ---- Notification clicks (A52) ------------------------------------------------------------------------

/** The same-origin path + query a notification opens: its data.url, or `/`. */
function notificationTarget(data) {
  const raw = data && typeof data.url === 'string' ? data.url : '/';
  try {
    const url = new URL(raw, self.location.origin);
    return url.origin === self.location.origin ? url.pathname + url.search : '/';
  } catch (e) {
    return '/';
  }
}

/** A window's same-origin pathname, or null. */
function windowPath(client) {
  try {
    const url = new URL(client.url);
    return url.origin === self.location.origin ? url.pathname : null;
  } catch (e) {
    return null;
  }
}

/** Ask an app window to open `url` itself, without a reload. True once it says it did. */
function askToOpen(client, url) {
  return new Promise((resolve) => {
    let channel;
    try {
      channel = new MessageChannel();
    } catch (e) {
      resolve(false);
      return;
    }
    const finish = (ok) => {
      clearTimeout(timer);
      channel.port1.onmessage = null;
      channel.port1.close();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), OPEN_REPLY_MS);
    channel.port1.onmessage = (event) => finish(!!(event.data && event.data.ok === true));
    try {
      client.postMessage({ type: OPEN_MESSAGE, url }, [channel.port2]);
    } catch (e) {
      finish(false);
    }
  });
}

/**
 * Focus an app window and have it open `url` in place; else navigate it there; else open a window. True
 * only once a page said it opened it (lp-open {ok: true}): navigate() and openWindow() may do nothing on an
 * iPhone Home Screen app, so they never count. `taken()`: a page took the click with lp-take-open meanwhile
 * (it opened it in place), so nothing reloads that page or opens another window for it.
 */
async function openFromNotification(url, taken = async () => false) {
  // Absolute: a Home Screen app may resolve a relative one against nothing and open its start URL.
  const href = new URL(url, self.location.origin).href;
  const windows = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter((c) => windowPath(c) !== null);
  // The app page `/` beats /signin; matchAll lists the most recently focused window first.
  const client = windows.find((c) => c.focused && windowPath(c) === '/') || windows.find((c) => windowPath(c) === '/') || windows[0];
  if (client) {
    let target = client;
    try {
      target = (await client.focus()) || client;
    } catch (e) {
      // Focus needs the click's user activation; the window still opens the request.
    }
    if (windowPath(target) === '/' && (await askToOpen(target, url))) return true;
    if (await taken()) return false;
    try {
      if (await target.navigate(href)) return false;
    } catch (e) {
      // navigate() only works on a window this worker controls: open a new one.
    }
  }
  if (await taken()) return false;
  if (self.clients.openWindow) await self.clients.openWindow(href);
  return false;
}

// ---- The click no page opened yet (lp-take-open) -------------------------------------------------------

let pendingQueue = Promise.resolve();

/** Run `step` on the pending open after every earlier one (a click's save always lands before its clear). */
function pendingStep(step) {
  const run = pendingQueue.then(step);
  pendingQueue = run.catch(() => undefined);
  return run;
}

async function readPendingOpen(meta) {
  try {
    const res = await meta.match(PENDING_OPEN_KEY);
    const data = res ? await res.json() : null;
    return data && typeof data.url === 'string' && typeof data.at === 'number' ? { url: data.url, at: data.at } : null;
  } catch (e) {
    return null;
  }
}

function savePendingOpen(open) {
  return pendingStep(async () => {
    const meta = await caches.open(META);
    await meta.put(PENDING_OPEN_KEY, new Response(JSON.stringify(open), { headers: { 'Content-Type': 'application/json' } }));
  });
}

/** A page opened this click: forget it (unless a newer click replaced it meanwhile). */
function clearPendingOpen(open) {
  return pendingStep(async () => {
    const meta = await caches.open(META);
    const stored = await readPendingOpen(meta);
    if (stored && stored.url === open.url && stored.at === open.at) await meta.delete(PENDING_OPEN_KEY);
  });
}

/** The pending open, taken once: {url, at} while fresh, else null (an expired one is dropped too). */
function takePendingOpen() {
  return pendingStep(async () => {
    const meta = await caches.open(META);
    // Pages ask several times each time they come back: nothing kept, nothing written.
    if (!(await meta.match(PENDING_OPEN_KEY))) return null;
    const stored = await readPendingOpen(meta);
    await meta.delete(PENDING_OPEN_KEY);
    return stored && Math.abs(Date.now() - stored.at) <= PENDING_OPEN_MS ? stored : null;
  });
}

/**
 * This click, once kept, is gone: a page took it (lp-take-open) and opened it, or a newer click replaced
 * it (that click opens its own). Read in turn after the save. False when Cache Storage fails or the entry
 * cannot be read back: the click then navigates or opens a window, as before.
 */
function pendingTaken(open) {
  return pendingStep(async () => {
    const meta = await caches.open(META);
    const res = await meta.match(PENDING_OPEN_KEY);
    if (!res) return true;
    const data = await res.json();
    return !(data && data.url === open.url && data.at === open.at);
  }).catch(() => false);
}

// ---- Telemetry log (lp-tel-take) -----------------------------------------------------------------------

const TEL_LOG_KEY = '/__lp/tel';
const TEL_TAKE_MESSAGE = 'lp-tel-take';
const TEL_LOG_MAX = 100;
const TEL_LOG_MS = 24 * 60 * 60 * 1000;

// Its own chain, never the pending-open one: a log write or take must not run ahead of a click's hand-off.
let telQueue = Promise.resolve();

/** Run `step` on the log after every earlier log step. */
function telStep(step) {
  const run = telQueue.then(step);
  telQueue = run.catch(() => undefined);
  return run;
}

async function readTelLog(meta) {
  try {
    const res = await meta.match(TEL_LOG_KEY);
    const list = res ? await res.json() : [];
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

/** Appends one entry (numbers, booleans and enums only). Never rejects. */
function telLog(entry) {
  return telStep(async () => {
    const meta = await caches.open(META);
    const now = Date.now();
    const list = (await readTelLog(meta)).filter((x) => x && typeof x.at === 'number' && now - x.at <= TEL_LOG_MS);
    list.push(entry);
    const kept = list.slice(-TEL_LOG_MAX);
    await meta.put(TEL_LOG_KEY, new Response(JSON.stringify(kept), { headers: { 'Content-Type': 'application/json' } }));
  }).catch(() => undefined);
}

/** The log, handed over once and cleared. */
function takeTelLog() {
  return telStep(async () => {
    const meta = await caches.open(META);
    if (!(await meta.match(TEL_LOG_KEY))) return [];
    const list = await readTelLog(meta);
    await meta.delete(TEL_LOG_KEY);
    const now = Date.now();
    return list.filter((x) => x && typeof x.at === 'number' && now - x.at <= TEL_LOG_MS);
  }).catch(() => []);
}

/** A push or page notification's kind for the log ('' when it has none). */
function telKind(kind) {
  return typeof kind === 'string' && /^[a-z_]{1,24}$/.test(kind) ? kind : null;
}

async function handleClick(url, info) {
  const open = { url, at: Date.now() };
  // Kept first, so a page that misses the hand-off below still finds it; never long enough to cost the
  // click its user activation (focus, openWindow).
  let kept = false;
  const saved = savePendingOpen(open).then(
    () => {
      kept = true;
    },
    () => undefined,
  );
  let timer;
  await Promise.race([saved, new Promise((resolve) => (timer = setTimeout(resolve, PENDING_SAVE_MS)))]);
  clearTimeout(timer);
  // Not kept (yet): no page can have taken it, so the window is still navigated or opened.
  const taken = () => (kept ? pendingTaken(open) : Promise.resolve(false));
  const opened = await openFromNotification(url, taken).catch(() => false);
  if (opened) await clearPendingOpen(open).catch(() => undefined);
  await saved;
  // Telemetry, last: the click has done everything it does. How it opened: a page answered lp-open, a page took the
  // kept click (lp-take-open), or the worker navigated / opened a window.
  const via = opened ? 'lp-open' : kept && (await taken().catch(() => false)) ? 'take-open' : 'nav';
  const ts = info && typeof info.timestamp === 'number' ? info.timestamp : null;
  await telLog({ e: 'click', k: telKind(info && info.kind), ps: !!(info && info.push === true), at: Date.now(), age: ts === null ? null : Math.max(0, Date.now() - ts), via });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || null;
  const info = { kind: data && data.kind, push: !!(data && data.push === true), timestamp: event.notification.timestamp };
  event.waitUntil(handleClick(notificationTarget(data), info).catch(() => undefined));
});

// ---- Web Push (F4) ------------------------------------------------------------------------------------

const PUSH_MESSAGE = 'lp-push';
const PUSH_ICON = '/icons/icon-192.png';
/** How long a push waits for a visible app window to say whether it is in front. */
const FRONT_ASK_MS = 600;
const APP_NAME = 'Is my friend in medical?';

/** WebKit (Safari on a Mac, every browser on an iPhone or iPad) revokes push after silent pushes. */
function isWebKit() {
  const ua = (self.navigator && self.navigator.userAgent) || '';
  return /AppleWebKit/.test(ua) && !/Chrome\/|Chromium\/|Edg\/|Firefox\//.test(ua);
}

/** The payload, checked: {title, body, tag, url, kind, requestId, renotify, requireInteraction, badge}. Never throws. */
function pushData(event) {
  let raw = null;
  try {
    raw = event.data ? event.data.json() : null;
  } catch (e) {
    raw = null;
  }
  const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const tag = text(raw && raw.tag, 80);
  return {
    title: text(raw && raw.title, 80) || APP_NAME,
    body: text(raw && raw.body, 240),
    tag: /^lp-[A-Za-z0-9-]{1,64}$/.test(tag) ? tag : 'lp-update',
    url: notificationTarget({ url: raw && raw.url }),
    kind: text(raw && raw.kind, 40),
    requestId: text(raw && raw.requestId, 64) || null,
    renotify: !!(raw && raw.renotify === true),
    requireInteraction: !!(raw && raw.requireInteraction === true),
    badge: raw && typeof raw.badge === 'number' && raw.badge >= 0 ? Math.floor(raw.badge) : null,
    // Telemetry: the server clock when the push was built (push transit times on the Health page).
    sentAt: raw && typeof raw.sentAt === 'number' && Number.isFinite(raw.sentAt) ? raw.sentAt : null,
  };
}

async function setBadge(count) {
  const nav = self.navigator;
  try {
    if (count === null || !nav) return;
    if (count > 0 && nav.setAppBadge) await nav.setAppBadge(count);
    else if (count === 0 && nav.clearAppBadge) await nav.clearAppBadge();
  } catch (e) {
    // badges are best effort
  }
}

function showPush(data, silent) {
  return self.registration.showNotification(data.title, {
    body: data.body,
    tag: data.tag,
    renotify: data.renotify && !silent,
    requireInteraction: data.requireInteraction && !silent,
    silent: !!silent,
    icon: PUSH_ICON,
    lang: 'en-US',
    timestamp: Date.now(),
    data: { url: data.url, key: null, push: true, kind: data.kind, requestId: data.requestId },
  });
}

/**
 * Tells a visible app window about the push and resolves whether it is in front, by its own answer
 * ({front}); without one in time, visible and focused counts as in front.
 */
function askFront(client, message) {
  const fallback = client.visibilityState === 'visible' && client.focused === true;
  return new Promise((resolve) => {
    let channel = null;
    try {
      channel = new MessageChannel();
    } catch (e) {
      channel = null;
    }
    if (!channel) {
      try {
        client.postMessage(message);
      } catch (e) {
        // that window is going away
      }
      resolve(fallback);
      return;
    }
    const port = channel.port1;
    let timer = null;
    const done = (front) => {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
      port.onmessage = null;
      try {
        port.close();
      } catch (e) {
        // closed already
      }
      resolve(front);
    };
    timer = setTimeout(() => done(fallback), FRONT_ASK_MS);
    port.onmessage = (event) => done(!!(event.data && event.data.front === true));
    try {
      client.postMessage(message, [channel.port2]);
    } catch (e) {
      done(fallback);
    }
  });
}

/** Telemetry: one log entry per push, written after it was shown (or not). Never rejects. */
function logPush(data, front, shown, silent) {
  return telLog({ e: 'rx', k: telKind(data.kind) || 'other', at: Date.now(), sent: data.sentAt, fr: front, sh: shown, si: silent });
}

async function handlePush(event) {
  const data = pushData(event);
  await setBadge(data.badge);
  // "Send a test alert" is tapped inside the app: it shows in front too (that is what it tests).
  if (data.kind === 'test') {
    await showPush(data, false);
    await logPush(data, false, true, false);
    return;
  }
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const app = windows.filter((c) => windowPath(c) !== null);
  // Every app window hears about it (it syncs); a visible one says whether it is in front, and then takes
  // the event in the app (its toast and bell): never both.
  const message = { type: PUSH_MESSAGE, kind: data.kind, requestId: data.requestId, title: data.title, body: data.body };
  const answers = await Promise.all(
    app.map((c) => {
      if (c.visibilityState === 'visible') return askFront(c, message);
      try {
        c.postMessage(message);
      } catch (e) {
        // that window is going away
      }
      return false;
    }),
  );
  const front = answers.some(Boolean);
  if (!front) {
    await showPush(data, false);
    await logPush(data, false, true, false);
    return;
  }
  if (!isWebKit()) {
    await logPush(data, true, false, false);
    return;
  }
  // WebKit counts a push that shows nothing against the subscription: show it silently and take it away.
  await showPush(data, true);
  try {
    const shown = await self.registration.getNotifications({ tag: data.tag });
    for (const n of shown) if (n.data && n.data.push === true) n.close();
  } catch (e) {
    // it stays in the notification centre; still one alert
  }
  await logPush(data, true, true, true);
}

self.addEventListener('push', (event) => {
  event.waitUntil(
    handlePush(event).catch(() =>
      // Whatever went wrong, a push always shows something (WebKit revokes silent ones).
      self.registration.showNotification(APP_NAME, { tag: 'lp-update', icon: PUSH_ICON, data: { url: '/', push: true } }).catch(() => undefined),
    ),
  );
});

async function resubscribe(event) {
  const old = event.oldSubscription || null;
  let next = event.newSubscription || null;
  if (!next) {
    const key = old && old.options ? old.options.applicationServerKey : null;
    if (!key) return;
    next = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  }
  const json = next.toJSON();
  if (!json || !json.endpoint || !json.keys) return;
  await fetch('/api/push/subscribe', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth }, oldEndpoint: old ? old.endpoint : null }),
  });
}

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(resubscribe(event).catch(() => undefined));
});
