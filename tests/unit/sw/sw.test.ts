// public/sw.js updates (spec §7 Service worker, A15): an update may only offer "Update ready · Reload" once
// the whole new build is cached, view chunks included, and activating it never deletes a cache a page may
// still use. Driven through tests/unit/sw/harness.ts: synthetic builds, fake caches, network and tabs.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CORE,
  FakeCacheStorage,
  FakeNetwork,
  firstInstall,
  loadWorker,
  makeBuild,
  scriptUrl,
  serve,
  type PageClient,
  type Worker,
} from './harness';

const A = makeBuild('a1');
const B = makeBuild('b2');

let caches: FakeCacheStorage;
let network: FakeNetwork;
let pages: PageClient[];

beforeEach(() => {
  caches = new FakeCacheStorage();
  network = new FakeNetwork();
  pages = [{ id: 'tab-1' }];
});

/** Phone on build A; build B deployed; the page registers B's worker, which installs over A's. */
async function updateWorker(options: { manifest?: boolean } = {}): Promise<Worker> {
  await firstInstall(caches, network, A, pages);
  serve(network, B, options);
  network.clearLog();
  return loadWorker({ version: B.tag, caches, network, active: A.tag, pages });
}

/** The user taps Reload: the waiting worker becomes the active one and activates. */
async function activate(worker: Worker): Promise<void> {
  worker.registration.active = { scriptURL: scriptUrl(worker.version) };
  worker.registration.waiting = null;
  await worker.activate();
}

describe('installing an update', () => {
  it('caches the whole new build, next/dynamic view chunks included, before it waits for Reload', async () => {
    const worker = await updateWorker();
    await worker.install();

    const cache = caches.get(worker.cacheName)!;
    for (const path of ['/', '/signin', ...CORE, ...B.assets]) expect(cache.has(path), path).toBe(true);
    expect(await cache.text(B.viewChunk)).toContain(B.tag);
    expect(await cache.text('/')).toBe(B.shellHtml);
    // An update waits for "Reload".
    expect(worker.skipWaitingCalls()).toBe(0);
  });

  it('after Reload with no signal, the new shell and every view load from the new cache', async () => {
    const worker = await updateWorker();
    await worker.install();
    network.online = false;
    await activate(worker);

    const shell = await worker.fetch('/', 'navigate');
    expect(await shell?.text()).toBe(B.shellHtml);
    for (const path of [B.shellChunk, B.viewChunk, B.css, B.font]) {
      const res = await worker.fetch(path);
      expect(res?.status, path).toBe(200);
    }
  });

  it.each([
    ['a view chunk fails to download', () => network.routes.set(B.viewChunk, { body: 'oops', status: 500 })],
    ['the signal drops during the install', () => network.dropAfter(4)],
    ['the build has no manifest', () => network.routes.delete('/sw-manifest.json')],
    ['the pages come from a newer deploy than the manifest', () => network.routes.set('/', { body: makeBuild('c3').shellHtml, contentType: 'text/html' })],
    ['the shell redirects to sign-in', () => network.routes.set('/', { body: '', status: 307 })],
  ])('fails, so the old worker keeps serving, when %s', async (_label, breakIt) => {
    const worker = await updateWorker();
    breakIt();
    await expect(worker.install()).rejects.toThrow(/Update not installed/);
    // The working cache is untouched.
    const old = caches.get(`lp-${A.tag}`)!;
    expect(await old.text('/')).toBe(A.shellHtml);
    expect(old.has(A.viewChunk)).toBe(true);
  });

  it('a retried update keeps what it already cached and installs once every file is reachable', async () => {
    const first = await updateWorker();
    network.routes.set(B.viewChunk, { body: 'oops', status: 500 });
    await expect(first.install()).rejects.toThrow();

    serve(network, B);
    network.clearLog();
    const retry = loadWorker({ version: B.tag, caches, network, active: A.tag, pages });
    await retry.install();
    expect(network.fetched(B.viewChunk)).toBe(true);
    expect(network.fetched(B.shellChunk)).toBe(false);
    expect(caches.get(retry.cacheName)!.has(B.viewChunk)).toBe(true);
  });

  it('a failed re-install of the active version (a changed sw.js) never leaves the active cache a shell without its files', async () => {
    await firstInstall(caches, network, A, pages);
    // Build B is live; the browser's update check re-installs the worker with the same ?v=a1, so it fills lp-a1.
    serve(network, B);
    network.routes.set(B.viewChunk, { body: 'oops', status: 500 });
    const reinstall = loadWorker({ version: A.tag, caches, network, active: A.tag, pages });
    await expect(reinstall.install()).rejects.toThrow(/Update not installed/);
    expect(await caches.get(`lp-${A.tag}`)!.text('/')).toBe(A.shellHtml);
  });

  it('copies unchanged /_next/static files from the older cache instead of downloading them', async () => {
    const worker = await updateWorker();
    await worker.install();
    expect(network.fetched(B.shared)).toBe(false);
    expect(caches.get(worker.cacheName)!.has(B.shared)).toBe(true);
    expect(network.fetched(B.viewChunk)).toBe(true);
  });

  it('the very first install is best effort and takes over at once', async () => {
    serve(network, A);
    network.routes.set(A.viewChunk, { body: 'oops', status: 500 });
    const worker = loadWorker({ version: A.tag, caches, network, pages });
    await worker.install();
    expect(worker.skipWaitingCalls()).toBe(1);
    const cache = caches.get(worker.cacheName)!;
    expect(cache.has('/')).toBe(true);
    expect(cache.has(A.shellChunk)).toBe(true);
  });
});

describe('activating an update', () => {
  it('keeps the old cache while a tab from before is open, and deletes it once none is left', async () => {
    const worker = await updateWorker();
    await worker.install();
    await activate(worker);
    expect(caches.versions()).toEqual([`lp-${A.tag}`, `lp-${B.tag}`]);

    // The old tab, offline, still loads its own build's chunks.
    network.online = false;
    const old = await worker.fetch(A.viewChunk);
    expect(await old?.text()).toContain(A.tag);

    // The old tab reloads (a new client), and the next navigation lets the old cache go.
    pages.splice(0, pages.length, { id: 'tab-1-reloaded' });
    await worker.fetch('/', 'navigate');
    expect(caches.versions()).toEqual([`lp-${B.tag}`]);
    await expect(worker.fetch(A.viewChunk)).rejects.toThrow();
  });

  it('with no tab open, the old cache goes on activation', async () => {
    const worker = await updateWorker();
    await worker.install();
    pages.splice(0, pages.length);
    await activate(worker);
    expect(caches.versions()).toEqual([`lp-${B.tag}`]);
  });

  it('never deletes the cache of a worker that is still installing or waiting', async () => {
    const worker = await updateWorker();
    await worker.install();
    // Build C deployed meanwhile: its worker is filling lp-c3.
    const C = makeBuild('c3');
    serve(network, C);
    const next = loadWorker({ version: C.tag, caches, network, active: A.tag, installing: C.tag, pages });
    await next.install();
    worker.registration.installing = { scriptURL: scriptUrl(C.tag) };
    pages.splice(0, pages.length);
    await activate(worker);

    expect(caches.versions()).toEqual([`lp-${B.tag}`, `lp-${C.tag}`]);
    expect(caches.get(`lp-${C.tag}`)!.has(C.viewChunk)).toBe(true);
  });

  it('a chunk requested with a deployment id query is served from the cached build file', async () => {
    const worker = await updateWorker();
    await worker.install();
    network.online = false;
    await activate(worker);
    const res = await worker.fetch(`${B.viewChunk}?dpl=dpl_synthetic123`);
    expect(await res?.text()).toContain(B.tag);
  });

  it('the page precache (A15) still answers, and releases retired caches', async () => {
    const worker = await updateWorker();
    await worker.install();
    await activate(worker);
    pages.splice(0, pages.length, { id: 'tab-2' });
    const reply = await worker.message({ type: 'precache', urls: [B.shellChunk, B.viewChunk, 'https://elsewhere.test/x.js', '/api/sync'] });
    expect(reply).toEqual({ ok: true, count: 2 });
    expect(caches.versions()).toEqual([`lp-${B.tag}`]);
  });
});
