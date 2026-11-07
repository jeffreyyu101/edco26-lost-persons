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
 *
 * Web Push (F4, spec §18 A54): a push shows its notification (title, body, tag "lp-<id>", the app icon;
 * messages sound again when they replace one) and sets the app icon badge to the recipient's unread
 * Activity count. Never both a toast and a notification: while a window of the app is visible AND focused,
 * that window gets {type: 'lp-push'} and syncs at once (its toast and bell carry the event) and nothing is
 * shown, except on WebKit (Safari, every iPhone browser), which revokes a subscription after three pushes
 * that show nothing: there the notification is shown silently and closed at once. A click opens the request
 * (the handler above). pushsubscriptionchange re-subscribes with the same key and tells the server, which
 * drops the old endpoint. The worker answers {type: 'lp-caps'} with {push: true} too: a page subscribes
 * only once the active worker can show pushes.
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

async function openFromNotification(url) {
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
    if (windowPath(target) === '/' && (await askToOpen(target, url))) return;
    try {
      if (await target.navigate(url)) return;
    } catch (e) {
      // navigate() only works on a window this worker controls: open a new one.
    }
  }
  if (self.clients.openWindow) await self.clients.openWindow(url);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(openFromNotification(notificationTarget(event.notification.data)).catch(() => undefined));
});

// ---- Web Push (F4) ------------------------------------------------------------------------------------

const PUSH_MESSAGE = 'lp-push';
const PUSH_ICON = '/icons/icon-192.png';
const APP_NAME = 'Is my friend in medical?';

/** WebKit (Safari on a Mac, every browser on an iPhone or iPad) revokes push after silent pushes. */
function isWebKit() {
  const ua = (self.navigator && self.navigator.userAgent) || '';
  return /AppleWebKit/.test(ua) && !/Chrome\/|Chromium\/|Edg\/|Firefox\//.test(ua);
}

/** The payload, checked: {title, body, tag, url, kind, requestId, renotify, badge}. Never throws. */
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
    badge: raw && typeof raw.badge === 'number' && raw.badge >= 0 ? Math.floor(raw.badge) : null,
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
    silent: !!silent,
    icon: PUSH_ICON,
    lang: 'en-US',
    timestamp: Date.now(),
    data: { url: data.url, key: null, push: true, kind: data.kind, requestId: data.requestId },
  });
}

async function handlePush(event) {
  const data = pushData(event);
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const app = windows.filter((c) => windowPath(c) !== null);
  // The app is in front: its own sync shows the toast and the bell (never both).
  const front = app.some((c) => c.visibilityState === 'visible' && c.focused);
  for (const c of app) {
    try {
      c.postMessage({ type: PUSH_MESSAGE, kind: data.kind, requestId: data.requestId });
    } catch (e) {
      // that window is going away
    }
  }
  await setBadge(data.badge);
  if (!front) {
    await showPush(data, false);
    return;
  }
  if (!isWebKit()) return;
  // WebKit counts a push that shows nothing against the subscription: show it silently and take it away.
  await showPush(data, true);
  try {
    const shown = await self.registration.getNotifications({ tag: data.tag });
    for (const n of shown) if (n.data && n.data.push === true) n.close();
  } catch (e) {
    // it stays in the notification centre; still one alert
  }
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
