// (network fix 2, 2026-11-08) public/sw.js serves the stored app page `/` at once and refreshes it from the network in
// the background (the next open gets the new copy). /signin stays network-first, and with no stored `/` the page is
// network-first with the 4 s timeout, as before. Synthetic builds, fake caches and network (tests/unit/sw/harness.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeCacheStorage, FakeNetwork, firstInstall, loadWorker, makeBuild, serve, type PageClient } from './harness';

const A = makeBuild('a1');
const B = makeBuild('b2');
// The same build fetched again (a new nonce, say): it names the same files.
const NEWER = A.shellHtml.replace(`shell ${A.tag}`, 'shell from the network');
const NEWER_SIGNIN = '<!DOCTYPE html><html><body>signin from the network</body></html>';

let caches: FakeCacheStorage;
let network: FakeNetwork;
let pages: PageClient[];

/** The network answers page navigations only after `ms` (a slow festival link); everything else at once. */
function slow(base: FakeNetwork, ms: number): FakeNetwork {
  const fetch = async (input: Parameters<FakeNetwork['fetch']>[0]) => {
    const path = new URL(typeof input === 'string' ? input : input.url, 'https://lp.test').pathname;
    if (path === '/' || path === '/signin') await new Promise((r) => setTimeout(r, ms));
    return base.fetch(input);
  };
  return Object.assign(Object.create(base) as FakeNetwork, { fetch });
}

beforeEach(async () => {
  caches = new FakeCacheStorage();
  network = new FakeNetwork();
  pages = [{ id: 'tab-1' }];
  await firstInstall(caches, network, A, pages);
});

describe('the stored app page first (fix 2)', () => {
  it('a stored `/` is served at once, without waiting for the network, which then refreshes it for the next open', async () => {
    network.routes.set('/', { body: NEWER, contentType: 'text/html' });
    const worker = loadWorker({ version: A.tag, caches, network: slow(network, 150), active: A.tag, pages });
    const res = await worker.fetch('/', 'navigate');
    // The network answered in 150 ms, well inside the old 4 s race: the stored copy was served anyway.
    expect(await res?.text()).toBe(A.shellHtml);
    // The refresh finished in the background (waitUntil): the next open gets the network's copy.
    expect(await caches.get(`lp-${A.tag}`)!.text('/')).toBe(NEWER);
    const next = await worker.fetch('/', 'navigate');
    expect(await next?.text()).toBe(NEWER);
    // A deep link (a notification's /?r=…) opens on the same stored page.
    const deep = await worker.fetch('/?r=0f0f0f0f-0000-4000-8000-0000000000d4', 'navigate');
    expect(await deep?.text()).toBe(NEWER);
  });

  it('/signin stays network-first', async () => {
    network.routes.set('/signin', { body: NEWER_SIGNIN, contentType: 'text/html' });
    const worker = loadWorker({ version: A.tag, caches, network: slow(network, 150), active: A.tag, pages });
    const res = await worker.fetch('/signin', 'navigate');
    expect(await res?.text()).toBe(NEWER_SIGNIN);
  });

  it('no stored `/`: network-first with the 4 s timeout, as before', async () => {
    await caches.get(`lp-${A.tag}`)!.delete('/');
    network.routes.set('/', { body: NEWER, contentType: 'text/html' });
    const worker = loadWorker({ version: A.tag, caches, network: slow(network, 150), active: A.tag, pages });
    const res = await worker.fetch('/', 'navigate');
    expect(await res?.text()).toBe(NEWER);
  });

  it('offline: the stored `/` (unchanged); a redirect from the network (signed out) never replaces it', async () => {
    network.online = false;
    const worker = loadWorker({ version: A.tag, caches, network, active: A.tag, pages });
    expect(await (await worker.fetch('/', 'navigate'))?.text()).toBe(A.shellHtml);
    network.online = true;
    network.routes.set('/', { body: '', status: 307 });
    expect(await (await worker.fetch('/', 'navigate'))?.text()).toBe(A.shellHtml);
    expect(await caches.get(`lp-${A.tag}`)!.text('/')).toBe(A.shellHtml);
  });

  it('a refresh that names the same files as the stored page still replaces it', async () => {
    network.routes.set('/', { body: NEWER, contentType: 'text/html' });
    const worker = loadWorker({ version: A.tag, caches, network, active: A.tag, pages });
    expect(await (await worker.fetch('/', 'navigate'))?.text()).toBe(A.shellHtml);
    expect(await caches.get(`lp-${A.tag}`)!.text('/')).toBe(NEWER);
  });
});

// (network fix 2 follow-up) The stored `/` runs; the network's copy is another build (a deploy or a rollback). Nothing
// loads that build's files, so it must never become the stored page: the next open, offline, has to boot. The open
// page is told about the build (lp-build) so it registers that build's worker at once.
describe('the background refresh after a deploy (fix 2 follow-up)', () => {
  const told: unknown[] = [];
  const tab = (): PageClient => ({ id: 'tab-1', postMessage: (m: unknown) => told.push(m) });
  const scripts = (html: string) => [...html.matchAll(/<script\b[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);

  beforeEach(() => {
    told.length = 0;
    pages.splice(0, pages.length, tab());
  });

  it('deploy, one online open, then an offline open: the stored build still boots', async () => {
    serve(network, B);
    const worker = loadWorker({ version: A.tag, caches, network, active: A.tag, pages });
    expect(await (await worker.fetch('/', 'navigate'))?.text()).toBe(A.shellHtml);
    // B's page was fetched but never stored: lp-a1 lacks its files.
    expect(await caches.get(`lp-${A.tag}`)!.text('/')).toBe(A.shellHtml);
    expect(told).toEqual([{ type: 'lp-build', scripts: scripts(B.shellHtml) }]);
    // A page that starts after the refresh asks, and gets the same answer.
    expect(await worker.message({ type: 'lp-build' })).toEqual({ type: 'lp-build', scripts: scripts(B.shellHtml) });

    network.online = false;
    const next = await worker.fetch('/', 'navigate');
    expect(await next?.text()).toBe(A.shellHtml);
    for (const path of [A.shellChunk, A.css, A.shared]) expect((await worker.fetch(path))?.status, path).toBe(200);
  });

  it('deploy, one open, then a rollback: the next open runs the stored build and its files load', async () => {
    serve(network, B);
    const worker = loadWorker({ version: A.tag, caches, network, active: A.tag, pages });
    await worker.fetch('/', 'navigate');
    serve(network, A);
    expect(await (await worker.fetch('/', 'navigate'))?.text()).toBe(A.shellHtml);
    expect((await worker.fetch(A.shellChunk))?.status).toBe(200);
    // The live build is the stored one again: nothing more to tell, nothing to answer.
    expect(await worker.message({ type: 'lp-build' })).toBeUndefined();
  });

  it('no other build: nothing is posted and the ask gets no answer', async () => {
    const worker = loadWorker({ version: A.tag, caches, network, active: A.tag, pages });
    await worker.fetch('/', 'navigate');
    expect(told).toEqual([]);
    expect(await worker.message({ type: 'lp-build' })).toBeUndefined();
  });

  describe('lie-fi (/signin, the network past 4 s)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('the late copy of another build never replaces the stored page', async () => {
      vi.useFakeTimers();
      serve(network, B);
      const worker = loadWorker({ version: A.tag, caches, network: slow(network, 5_000), active: A.tag, pages });
      const res = worker.fetch('/signin', 'navigate');
      await vi.advanceTimersByTimeAsync(6_000);
      expect(await (await res)?.text()).toContain(`signin ${A.tag}`);
      expect(await caches.get(`lp-${A.tag}`)!.text('/signin')).toContain(`signin ${A.tag}`);
      expect(told).toEqual([]);
    });
  });
});
