// (network fix 2, 2026-11-08) public/sw.js serves the stored app page `/` at once and refreshes it from the network in
// the background (the next open gets the new copy). /signin stays network-first, and with no stored `/` the page is
// network-first with the 4 s timeout, as before. Synthetic builds, fake caches and network (tests/unit/sw/harness.ts).
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeCacheStorage, FakeNetwork, firstInstall, loadWorker, makeBuild, type PageClient } from './harness';

const A = makeBuild('a1');
const NEWER = '<!DOCTYPE html><html><body>shell from the network</body></html>';
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
});
