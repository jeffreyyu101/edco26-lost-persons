import { gzipSync } from 'node:zlib';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { sessionCookieHeader } from './helpers/session';

// First-load JS budget (spec §7 Performance, v2.2 A25), measured the way the reviewer does: every
// <script src> in the server HTML of the route, fetched from the production build and gzipped (zlib
// default level). View chunks loaded later through next/dynamic are not part of the first load.
// Request-based, so it runs in one project only. Needs a production build (npm run build:test).
const KB = 1024;
// §18 A59 (F3, 2026-11-06 evening): 230 → 234 KB and 40 → 42 KB. The F3 base already measured 230.2 KB
// (route-only 38.8 KB); messages add 1.9 KB to the first load (the store's side of it), the engine itself
// loading after start (lib/client/messages-lazy.ts).
const BUDGET = {
  /** Everything `/` loads first: framework + Radix baseline (~192 KB at Phase 1a) + app code. */
  homeTotal: 234 * KB,
  /** Scripts `/` loads that /signin does not: the app's own first-load code (shell, store, nav). */
  homeOnly: 42 * KB,
};

async function scriptSizes(request: APIRequestContext, path: string, cookie?: string): Promise<Map<string, number>> {
  const res = await request.get(path, { headers: cookie ? { cookie } : {}, maxRedirects: 0 });
  expect(res.status(), path).toBe(200);
  const html = await res.text();
  const srcs = new Set([...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]!.replace(/&amp;/g, '&')));
  const sizes = new Map<string, number>();
  for (const src of srcs) sizes.set(src, gzipSync(await (await request.get(src)).body()).length);
  return sizes;
}

const sum = (values: Iterable<number>) => [...values].reduce((a, b) => a + b, 0);
const kb = (n: number) => `${(n / KB).toFixed(1)} KB`;

test('first-load JS of / stays within the A25 budget', async ({ request }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-iphone14', 'request-based; one project is enough');
  // A real session (POST /api/session), as a phone has after sign-in.
  const home = await scriptSizes(request, '/', await sessionCookieHeader({ staffName: 'TEST-e2e First Load', team: 'Medical' }));
  const signin = await scriptSizes(request, '/signin');
  const homeTotal = sum(home.values());
  const homeOnly = sum([...home].filter(([src]) => !signin.has(src)).map(([, n]) => n));
  const summary = `/ ${home.size} scripts ${kb(homeTotal)} (route-only ${kb(homeOnly)}) · /signin ${signin.size} scripts ${kb(sum(signin.values()))}`;
  testInfo.annotations.push({ type: 'first-load-js', description: summary });
  console.log(`first-load JS gzipped: ${summary}`);
  expect(homeTotal, `/ first-load JS ${kb(homeTotal)}`).toBeLessThanOrEqual(BUDGET.homeTotal);
  expect(homeOnly, `/ route-only first-load JS ${kb(homeOnly)}`).toBeLessThanOrEqual(BUDGET.homeOnly);
});
