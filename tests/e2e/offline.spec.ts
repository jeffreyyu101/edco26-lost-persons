import { deflateSync } from 'node:zlib';
import { expect, test, type APIRequestContext, type Page, type Route } from '@playwright/test';
import { confirmCrop } from './helpers/photo';
import { signedInAs } from './helpers/session';
import { syncRows } from './helpers/sync';

// Offline, lie-fi and service-worker gates (spec §7 Service worker "Gate", §9.4, v2.1 A13/A15/A17).
// Runs only against a production build (`npm run build:test`): the service worker registers only there.
//   * offline: the shell is cached, the phone goes offline, reloads, opens New request, queues a request
//     with a photo; back online it sends exactly once, photo included.
//   * lie-fi: POST /api/requests hangs; the create queues after the 10 s timeout and sends later.
//   * update: a new worker waiting shows "Update ready · Reload"; Reload hands the page to it, and is
//     refused while a new request is unsent.
// Synthetic data only: every request is named TEST-O-<run>-<n>.

const RUN = Date.now().toString(36);
let seq = 0;
const uniqueName = (label: string) => `TEST-O-${RUN}-${(seq += 1)} ${label}`;
const STAFF = { staffName: `TEST-O Offline ${RUN}`, team: 'GC/HX - Dispatch' };

/** A small decodable PNG (two-colour gradient), so the store's canvas compression really runs. */
function syntheticPng(width = 96, height = 128): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x += 1) {
      const t = y / height;
      raw[row + 1 + x * 3] = Math.round(40 + 180 * t);
      raw[row + 2 + x * 3] = Math.round(160 - 100 * t);
      raw[row + 3 + x * 3] = 120;
    }
  }
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = (table[(c ^ b) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- Locators and helpers -----------------------------------------------------------------------------

const submit = (page: Page) => page.getByTestId('request-form-submit');
const form = (page: Page) => page.getByTestId('request-form');
const personName = (page: Page) => page.getByRole('group', { name: 'Missing person' }).getByLabel('Name', { exact: true });
// The row's name starts with what it shows: "<name>, 7:03. Waiting to send, FA 3, Not sent."
const queuedRow = (page: Page, name: string) => page.getByRole('group', { name: new RegExp(`^${name}, [^.]+\\. Waiting to send, `) });
const updateToast = (page: Page) => page.locator('.lp-toast').filter({ hasText: 'Update ready' });
/** The controlling worker's URL ('' while none, or while the page is between documents during a reload). */
const controllerUrl = (page: Page) => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? '').catch(() => '');

interface Row {
  id: string;
  name: string;
  clientMutationId: string | null;
}

/** Rows with this exact name, read through the API with the same session (not affected by setOffline). */
async function rowsNamed(request: APIRequestContext, name: string): Promise<Row[]> {
  return (await syncRows<Row>(request)).filter((r) => r.name === name);
}

async function photoCount(request: APIRequestContext, id: string): Promise<number> {
  const res = await request.get(`/api/requests/${id}`);
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { photos: unknown[] }).photos.length;
}

/** Load `/` and wait until the service worker controls the page and has cached every view chunk (A15). */
async function loadOfflineReady(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('request-list')).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 30_000 }).toBe(true);
  await expect(page.locator('html')).toHaveAttribute('data-offline-ready', 'true', { timeout: 30_000 });
}

async function pickPost(page: Page, post: string) {
  await page.getByRole('button', { name: /^Reporting from/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Reporting from' });
  await sheet.locator('label', { hasText: post }).click();
  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(sheet).toBeHidden();
}

/** A deploy changes the build id, so the page registers a new worker URL: it installs and waits. */
async function deployNewWorker(page: Page, version: string) {
  await page.evaluate((v) => navigator.serviceWorker.register(`/sw.js?v=${v}`, { scope: '/' }).then(() => undefined), version);
}

let errors: string[];

// Signed in once through POST /api/session (A17).
signedInAs(STAFF);

test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (msg) => {
    const text = msg.text();
    if (/Content Security Policy|Refused to/i.test(text)) errors.push(text);
  });
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

// ---- Offline ------------------------------------------------------------------------------------------

test('offline: reload from the cached shell, open New request, queue with a photo; back online it sends once', async ({ page, context }) => {
  test.setTimeout(150_000);
  const name = uniqueName('offline');
  await loadOfflineReady(page);

  await context.setOffline(true);
  await page.reload();
  // The cached shell hydrates under its stored CSP and shows the cached list under the offline banner.
  await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
  await expect(page.getByTestId('request-list')).toBeVisible();
  await expect(page.getByTestId('connection-banner').filter({ hasText: /^Offline · 0 waiting to send$/ })).toBeVisible();

  // The New request view's chunk and the photo compressor come from the service worker cache.
  await page.getByRole('button', { name: 'New request' }).click();
  await expect(submit(page)).toHaveText('Save offline');
  await pickPost(page, 'FA 4 – Oasis');
  await personName(page).fill(name);
  await page.locator('input[type=file]').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: syntheticPng() });
  await confirmCrop(page);
  await expect(page.getByRole('button', { name: /^1 photo/ })).toBeVisible();
  await submit(page).click();
  await expect(page.getByText('Saved on this phone', { exact: true })).toBeVisible();
  await expect(form(page)).toHaveCount(0);

  // Waiting to send, on top of the list, and counted in the banner.
  await expect(queuedRow(page, name)).toBeVisible();
  await expect(page.getByTestId('connection-banner').filter({ hasText: /^Offline · 1 waiting to send$/ })).toBeVisible();
  expect(await rowsNamed(page.request, name)).toHaveLength(0);

  await context.setOffline(false);
  await expect.poll(async () => (await rowsNamed(page.request, name)).length, { timeout: 45_000 }).toBe(1);
  const [sent] = await rowsNamed(page.request, name);
  await expect.poll(() => photoCount(page.request, sent!.id), { timeout: 45_000 }).toBe(1);
  await expect(queuedRow(page, name)).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator(`[data-request-id="${sent!.id}"]`)).toBeVisible({ timeout: 20_000 });

  // Exactly once: later polls and outbox passes add nothing.
  await page.waitForTimeout(8_000);
  expect(await rowsNamed(page.request, name)).toHaveLength(1);
  expect(await photoCount(page.request, sent!.id)).toBe(1);
});

// ---- Lie-fi -------------------------------------------------------------------------------------------

test.describe('lie-fi', () => {
  // page.route can't see requests that pass through a service worker in WebKit; nothing here needs one.
  test.use({ serviceWorkers: 'block' });

  test('a hanging POST /api/requests queues the create after 10 s; it sends later, exactly once', async ({ page }) => {
    test.setTimeout(150_000);
    const name = uniqueName('lie-fi');
    const hung: Route[] = [];
    let hang = true;
    await page.route('**/api/requests', async (route) => {
      if (route.request().method() !== 'POST' || !hang) return route.fallback();
      hung.push(route); // never answered while the signal is "lying"
    });

    await page.goto('/?new=1');
    await expect(submit(page)).toHaveText('Send request');
    await pickPost(page, 'Command');
    await personName(page).fill(name);
    const started = Date.now();
    await submit(page).click();
    await expect(page.getByText('Saved on this phone', { exact: true })).toBeVisible({ timeout: 20_000 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(9_500);
    await expect(form(page)).toHaveCount(0);
    await expect(queuedRow(page, name)).toBeVisible();
    expect(hung.length).toBeGreaterThanOrEqual(1);
    const mutationId = (hung[0]!.request().postDataJSON() as { clientMutationId: string }).clientMutationId;

    // The signal comes back: hung requests drop, the outbox retry (same mutation id) goes through.
    hang = false;
    for (const route of hung) await route.abort('failed').catch(() => undefined);
    await expect
      .poll(async () => (await rowsNamed(page.request, name)).map((r) => r.clientMutationId), { timeout: 90_000 })
      .toEqual([mutationId]);
    await expect(queuedRow(page, name)).toHaveCount(0, { timeout: 20_000 });
    await page.waitForTimeout(6_000);
    expect(await rowsNamed(page.request, name)).toHaveLength(1);
  });
});

// ---- Service worker update ---------------------------------------------------------------------------

test('a new service worker waiting shows "Update ready · Reload"; Reload hands the page to it', async ({ page }) => {
  await loadOfflineReady(page);
  expect(await controllerUrl(page)).toMatch(/\/sw\.js\?v=/);

  const next = `e2e-update-${RUN}`;
  await deployNewWorker(page, next);
  await expect(updateToast(page)).toBeVisible({ timeout: 30_000 });

  await updateToast(page).getByRole('button', { name: 'Reload' }).click();
  await expect.poll(() => controllerUrl(page), { timeout: 30_000 }).toContain(`v=${next}`);
  await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
  await expect(page.getByTestId('request-list')).toBeVisible();
});

/**
 * A phone still on an earlier deploy's worker: `older` installs and takes over first (from a page that is
 * not the app, so nothing registers this build's worker yet). Loading `/` then registers this build's
 * worker, which installs over it and waits, as after a real deploy: "Update ready".
 */
async function loadOnOlderWorker(page: Page, older: string) {
  await page.goto('/icons/icon-192.png');
  await page.evaluate(async (v) => {
    await navigator.serviceWorker.register(`/sw.js?v=${v}`, { scope: '/' });
    await navigator.serviceWorker.ready;
  }, older);
  await loadOfflineReady(page);
  expect(await controllerUrl(page)).toContain(`v=${older}`);
  await expect(updateToast(page)).toBeVisible({ timeout: 30_000 });
}

/** Taps Reload and waits until a fresh document, controlled by this build's worker, has hydrated. */
async function reloadIntoUpdate(page: Page, older: string) {
  await page.evaluate(() => {
    (window as unknown as { lpBeforeUpdate?: boolean }).lpBeforeUpdate = true;
  });
  await updateToast(page).getByRole('button', { name: 'Reload' }).click();
  await expect.poll(() => controllerUrl(page), { timeout: 30_000 }).toMatch(/\/sw\.js\?v=/);
  await expect.poll(() => controllerUrl(page), { timeout: 30_000 }).not.toContain(`v=${older}`);
  // Nothing in memory from before: every chunk the page needs now comes through the new worker.
  await expect
    .poll(() => page.evaluate(() => !(window as unknown as { lpBeforeUpdate?: boolean }).lpBeforeUpdate).catch(() => false), { timeout: 30_000 })
    .toBe(true);
  await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
}

const cacheNames = (page: Page) => page.evaluate(() => caches.keys()).catch(() => [] as string[]);

/** Every /_next/static file of this build (public/sw-manifest.json, written by `next build`). */
async function buildAssets(page: Page): Promise<string[]> {
  const res = await page.request.get('/sw-manifest.json');
  expect(res.status()).toBe(200);
  return ((await res.json()) as { assets: string[] }).assets;
}

test('an update applied with no signal reloads from its own cache and opens every view', async ({ page, context, browserName }) => {
  test.setTimeout(120_000);
  const older = `e2e-older-${RUN}-offline`;
  await loadOnOlderWorker(page, older);

  // "Update ready" means the waiting worker already holds the whole build, view chunks included.
  const assets = await buildAssets(page);
  const missing = await page.evaluate(async (urls) => {
    const waiting = (await navigator.serviceWorker.getRegistration())?.waiting;
    if (!waiting) return ['(no waiting worker)'];
    const cache = await caches.open(`lp-${new URL(waiting.scriptURL).searchParams.get('v')}`);
    const out: string[] = [];
    for (const url of ['/', '/signin', ...urls]) if (!(await cache.match(url))) out.push(url);
    return out;
  }, assets);
  expect(missing).toEqual([]);

  // The signal drops before the user taps Reload.
  await context.setOffline(true);
  if (browserName === 'chromium') {
    // The HTTP cache keeps every chunk this browser loaded (immutable): empty it, so only the service
    // worker can answer. (WebKit has no equivalent; the cache check above covers it.)
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.clearBrowserCache');
    await cdp.detach();
  }
  await reloadIntoUpdate(page, older);
  await expect(page.getByTestId('request-list')).toBeVisible();
  await expect(page.getByTestId('connection-banner').filter({ hasText: /^Offline · 0 waiting to send$/ })).toBeVisible();
  await page.getByRole('button', { name: 'New request' }).click();
  await expect(submit(page)).toHaveText('Save offline');
  await page.goto('/?dashboard=1');
  await expect(page.getByTestId('dashboard')).toBeVisible();
  await context.setOffline(false);
});

test.describe('desk 1180 × 820, offline', () => {
  test.use({ viewport: { width: 1180, height: 820 }, isMobile: false, hasTouch: true, deviceScaleFactor: 1 });

  // The worker keeps one copy of `/`, the last page it fetched whatever its query, and answers every
  // navigation with it offline. The brand card is server-drawn for All requests only, so the copy can have
  // it when the URL asks for Pending, or lack it when the URL is All: hydration must take the HTML as it is
  // (the afterEach fails on React's hydration error #418).
  test('the cached shell hydrates under any view: Pending from the All copy, All from the Pending copy', async ({ page, context }) => {
    test.setTimeout(120_000);
    await loadOfflineReady(page);
    await expect(page.getByTestId('desk-brand')).toBeVisible();

    await context.setOffline(true);
    await page.goto('/?view=pending');
    await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
    await expect(page.getByTestId('pending-board')).toBeVisible();
    await expect(page.getByTestId('desk-brand')).toHaveCount(0);

    await context.setOffline(false);
    await page.goto('/?view=pending');
    await expect(page.getByTestId('pending-board')).toBeVisible();
    await expect(page.getByTestId('desk-brand')).toHaveCount(0);

    await context.setOffline(true);
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
    await expect(page.getByTestId('desk-table-view')).toBeVisible();
    await expect(page.getByTestId('desk-brand')).toBeVisible();
    await context.setOffline(false);
  });
});

test('activating an update keeps the old cache while an older tab is open, then lets it go', async ({ page, context }) => {
  test.setTimeout(120_000);
  const older = `e2e-older-${RUN}-retain`;
  await loadOnOlderWorker(page, older);
  const olderTab = await context.newPage();
  await loadOfflineReady(olderTab);

  await reloadIntoUpdate(page, older);
  await expect(page.getByTestId('request-list')).toBeVisible();
  const newCache = `lp-${new URL(await controllerUrl(page)).searchParams.get('v')}`;

  // The older tab still runs what it loaded: its cache stays.
  expect(await cacheNames(page)).toEqual(expect.arrayContaining([`lp-${older}`, newCache]));
  await page.reload();
  await expect(page.getByTestId('request-list')).toBeVisible();
  expect(await cacheNames(page)).toContain(`lp-${older}`);

  // Once no tab from before is left, the next navigation deletes it.
  await olderTab.close();
  await expect
    .poll(
      async () => {
        await page.reload();
        await expect(page.getByTestId('request-list')).toBeVisible();
        return cacheNames(page);
      },
      { timeout: 30_000 },
    )
    .not.toContain(`lp-${older}`);
  expect(await cacheNames(page)).toContain(newCache);
});

test('the build manifest lists every file / and /signin load, and the server has each one', async ({ page, playwright, baseURL }) => {
  const res = await page.request.get('/sw-manifest.json');
  expect(res.status()).toBe(200);
  const { assets } = (await res.json()) as { assets: string[] };
  const listed = new Set(assets);
  // The next/dynamic view chunks are in it too: far more files than the shell names.
  const shellHtml = await (await page.request.get('/')).text();
  const signedOut = await playwright.request.newContext({ baseURL });
  const signInHtml = await (await signedOut.get('/signin')).text();
  await signedOut.dispose();
  const referenced = [...new Set([...(shellHtml + signInHtml).matchAll(/\/_next\/static\/[^"'\\) ]+/g)].map((m) => m[0].split('?')[0] as string))];
  expect(referenced.length).toBeGreaterThan(3);
  for (const url of referenced) expect(listed.has(url), url).toBe(true);
  expect(assets.length).toBeGreaterThan(referenced.length);
  for (const url of assets) expect((await page.request.get(url)).status(), url).toBe(200);
});

test('Reload is refused while a new request has unsent details', async ({ page }) => {
  await loadOfflineReady(page);
  await page.getByRole('button', { name: 'New request' }).click();
  await pickPost(page, 'Base');
  await personName(page).fill(uniqueName('pending update'));

  await deployNewWorker(page, `e2e-refuse-${RUN}`);
  await expect(updateToast(page)).toBeVisible({ timeout: 30_000 });
  const controller = await controllerUrl(page);
  await updateToast(page).getByRole('button', { name: 'Reload' }).click();
  await expect(page.locator('.lp-toast').filter({ hasText: 'Finish or cancel the new request first' })).toBeVisible();
  await page.waitForTimeout(2_000);
  expect(await controllerUrl(page)).toBe(controller);
  await expect(form(page)).toBeVisible();
  await expect(personName(page)).not.toHaveValue('');
});
