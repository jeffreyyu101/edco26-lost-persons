#!/usr/bin/env node
// Production-build smoke check (spec §9.6 "the CSP and nonce work in a production build"): /signin serves
// the CSP, hydrates with no CSP violations, and `/` with a valid session renders the shell and a lazily
// loaded view under the nonce CSP, in Chromium and WebKit: on a phone, then on a desk (from 768 px the
// desk chunk, components/desk, loads too and a request opens beside the list).
// Run against a server started with: PORT=3100 node scripts/with-test-env.mjs next start
//   node scripts/smoke-csp.mjs            (PORT from the environment or .env.test)
// tests/e2e/smoke.spec.ts runs this script as part of `npm run test:e2e`, so its selectors can't go stale.
import { chromium, webkit } from '@playwright/test';
import { SignJWT } from 'jose';
import { loadTestEnv, testBaseUrl } from './test-env.mjs';

const env = loadTestEnv();
const base = testBaseUrl();

async function sessionCookie() {
  const now = Math.floor(Date.now() / 1000);
  const sid = `${now}.${'ab'.repeat(12)}`;
  const token = await new SignJWT({ staffName: 'TEST-1a Smoke', team: 'GC/HX - Dispatch', sid })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(new TextEncoder().encode(env.SESSION_SECRET));
  return { name: 'lp_session', value: token, url: base, httpOnly: true, sameSite: 'Lax' };
}

async function check(browserType) {
  const browser = await browserType.launch();
  const failures = [];
  try {
    // A phone first (the layout every check below was written for); the desk pass is at the end.
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const violations = [];
    const watch = (p) => {
      p.on('console', (msg) => {
        const text = msg.text();
        if (msg.type() === 'error' || /Content Security Policy|Refused to/i.test(text)) violations.push(text);
      });
      p.on('pageerror', (err) => violations.push(`pageerror: ${err.message}`));
      return p;
    };
    const page = watch(await context.newPage());

    // 1. /signin: CSP header, nonce on scripts, hydration.
    const res = await page.goto(`${base}/signin`, { waitUntil: 'networkidle' });
    const csp = res?.headers()['content-security-policy'] ?? '';
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    if (!nonce) failures.push('signin: no nonce in CSP header');
    if (!csp.includes("'strict-dynamic'")) failures.push('signin: CSP lacks strict-dynamic');
    await page.waitForFunction(() => document.documentElement.dataset.hydrated === 'true', null, { timeout: 15_000 });
    const scripts = await page.evaluate(() => [...document.scripts].map((s) => ({ src: s.src, nonce: s.nonce })));
    const unnonced = scripts.filter((s) => !s.nonce);
    if (unnonced.length) failures.push(`signin: ${unnonced.length} script(s) without a nonce`);
    const themeClass = await page.evaluate(() => document.documentElement.className);
    if (!/\b(light|dark)\b/.test(themeClass)) failures.push(`signin: theme class missing on <html> (${themeClass})`);
    const heading = await page.getByRole('heading', { name: 'Staff sign-in' }).count();
    if (heading !== 1) failures.push('signin: heading not rendered');

    // 2. / without a session redirects to /signin.
    const redirected = await page.goto(`${base}/?view=pending`);
    if (!redirected?.url().includes('/signin?next=%2F%3Fview%3Dpending')) failures.push(`/ did not redirect to sign-in (${redirected?.url()})`);

    // 3. / with a session renders the shell and a dynamic view chunk; /signin then redirects home.
    await context.addCookies([await sessionCookie()]);
    await page.goto(`${base}/`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.documentElement.dataset.hydrated === 'true', null, { timeout: 15_000 });
    await page.getByTestId('request-list').waitFor({ timeout: 15_000 });
    const rows = await page.locator('[data-request-id]').count();
    if (rows < 1) failures.push('/: no rows rendered by the list');
    // The view switcher ("All requests N, change view") renders once the list view chunk has loaded.
    await page.getByTestId('view-switcher').waitFor({ timeout: 15_000 });
    const switcher = (await page.getByTestId('view-switcher').getAttribute('aria-label')) ?? '';
    if (!/^All requests\b/.test(switcher)) failures.push(`/: view switcher does not name All requests (${switcher})`);
    await page.locator('[data-request-id]').first().click();
    await page.getByTestId('profile').waitFor({ timeout: 15_000 });
    if (!page.url().includes('?r=')) failures.push('/: row click did not pushState ?r=');
    await page.goBack();
    await page.getByTestId('request-list').waitFor({ timeout: 15_000 });
    const back = await page.goto(`${base}/signin`);
    if (new URL(back?.url() ?? base).pathname !== '/') failures.push('/signin with a session did not redirect to /');

    // 4. The desk, in its own page (navigating the first one again would abort its in-flight fetches): the
    //    sidebar, top bar and pane chunk load under the same CSP, and a row opens beside the list.
    const desk = watch(await context.newPage());
    await desk.setViewportSize({ width: 1280, height: 800 });
    await desk.goto(`${base}/`, { waitUntil: 'networkidle' });
    await desk.getByTestId('desk-sidebar').waitFor({ timeout: 15_000 });
    const title = (await desk.getByTestId('desk-topbar').getByRole('heading', { level: 1 }).textContent()) ?? '';
    if (!/^All requests\b/.test(title)) failures.push(`desk: top bar does not title All requests (${title})`);
    await desk.locator('[data-desk-main] [data-request-id]').first().click();
    await desk.getByTestId('desk-pane').waitFor({ timeout: 15_000 });
    if (!desk.url().includes('?r=')) failures.push('desk: row click did not pushState ?r=');
    if ((await desk.locator('[data-desk-main] [data-request-id]').count()) < 1) failures.push('desk: the list left when a request opened');

    if (violations.length) failures.push(...violations.map((v) => `console: ${v}`));
    await context.close();
  } finally {
    await browser.close();
  }
  return failures;
}

let failed = false;
for (const [name, type] of [
  ['chromium', chromium],
  ['webkit', webkit],
]) {
  const failures = await check(type);
  if (failures.length) {
    failed = true;
    console.error(`${name}: FAIL\n  ${failures.join('\n  ')}`);
  } else {
    console.log(`${name}: ok (CSP header + nonce, hydrated, redirects, shell + lazy view + pushState, desk)`);
  }
}
process.exit(failed ? 1 : 0);
