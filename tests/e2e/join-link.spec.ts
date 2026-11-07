// Team join link end to end (J1), against the real POST /api/session: the test server runs with the
// synthetic link on (scripts/test-env.mjs TEST_INVITE_ENV).
//   * /signin#join=<code>: the fragment is gone from the address bar, the code is in sessionStorage only;
//     name + team → Continue → the app, with no password screen at any point.
//   * /#join=<code> signed out: the proxy's redirect keeps the fragment, then the same.
//   * a remembered name and team: step 1 prefilled (not step 2), Continue → the app.
//   * a bad code: Continue → the password step, with no message; the password works as always.
//   * no signal: the code is kept and Continue tries again.
//   * signed in already: the link just opens the app, fragment removed, nothing kept.
// Each test sends its own fake client IP and synthetic name, so login limits never leak between tests.
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { TEST_INVITE_CODE, loadTestEnv } from '../../scripts/test-env.mjs';
import { signedInAs } from './helpers/session';

const CODE = TEST_INVITE_CODE;
const PASSWORD = loadTestEnv()['APP_SHARED_PASSWORD'] ?? '';
const NETWORK_MESSAGE = 'Couldn’t sign in — check signal and try again';
const APP_URL = /127\.0\.0\.1:\d+\/$/;

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function useFakeIp(context: BrowserContext): Promise<void> {
  const octet = () => Math.floor(Math.random() * 250) + 1;
  const ip = `10.${octet()}.${octet()}.${octet()}`;
  await context.setExtraHTTPHeaders({ 'x-vercel-forwarded-for': ip, 'x-real-ip': ip });
}

const nameField = (page: Page) => page.getByRole('textbox', { name: 'Your name' });
const continueButton = (page: Page) => page.getByRole('button', { name: 'Continue' });
const stepTwoHeading = (page: Page) => page.getByRole('heading', { name: 'Enter the event password' });
const passwordField = (page: Page) => page.getByLabel('Event password');
const alertLine = (page: Page) => page.getByTestId('signin').getByRole('alert');

async function hydrated(page: Page): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
}

/** What the tab keeps: the code in sessionStorage, and nothing of it in localStorage, cookies or the URL. */
async function kept(page: Page) {
  return page.evaluate((code) => {
    const local = Object.keys(localStorage).map((k) => localStorage.getItem(k) ?? '');
    return {
      session: sessionStorage.getItem('lp-join'),
      hash: location.hash,
      href: location.href,
      inLocal: local.some((v) => v.includes(code)),
      inCookie: document.cookie.includes(code),
    };
  }, CODE);
}

/** Marks the tab (sessionStorage survives the navigations) if a password field ever appears. */
async function watchForPasswordStep(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const check = () => {
      if (document.querySelector('input[name="password"]')) sessionStorage.setItem('e2e-saw-password', '1');
    };
    new MutationObserver(check).observe(document, { childList: true, subtree: true });
  });
}
const sawPasswordStep = (page: Page) => page.evaluate(() => sessionStorage.getItem('e2e-saw-password') === '1');

/** Every POST /api/session body the page sends. */
function sessionBodies(page: Page): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/session') bodies.push(r.postDataJSON() as Record<string, unknown>);
  });
  return bodies;
}

/** Text a sighted user can see in the sign-in screen (screen-reader-only text is a 1 px box). */
function visibleText(page: Page): Promise<string> {
  return page.getByTestId('signin').evaluate((root) => {
    const out: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const box = n.parentElement?.getBoundingClientRect();
      const text = n.textContent?.trim();
      if (text && box && box.width > 1 && box.height > 1) out.push(text);
    }
    return out.join(' ');
  });
}

test.describe('team join link, signed out', () => {
  let problems: string[];

  test.beforeEach(async ({ context, page }) => {
    await useFakeIp(context);
    problems = [];
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (msg) => {
      if (msg.text().includes(CODE)) problems.push('the console printed the code');
    });
  });

  test.afterEach(() => {
    expect(problems).toEqual([]);
  });

  test('/signin#join=…: the code leaves the address bar; name + team → the app, no password step', async ({ page, context }) => {
    await watchForPasswordStep(page);
    const bodies = sessionBodies(page);
    const name = `TEST-B join ${uniq()}`;
    await page.goto(`/signin#join=${CODE}`);
    await hydrated(page);
    expect(page.url()).not.toContain('#');
    expect(page.url()).not.toContain(CODE);
    expect(await kept(page)).toMatchObject({ session: CODE, hash: '', inLocal: false, inCookie: false });

    // Step 1 as always: the same heading, fields and button, nothing about the link on screen.
    await expect(page.getByRole('heading', { name: 'Staff sign-in' })).toBeVisible();
    expect(await visibleText(page)).not.toMatch(/link|join|password/i);
    await expect(continueButton(page)).toHaveAccessibleDescription('Signs you in with the team link, no password needed');

    await nameField(page).fill(name);
    await page.getByRole('radio', { name: 'Medical' }).click();
    await continueButton(page).click();
    await expect(page).toHaveURL(APP_URL);
    await expect(page.getByTestId('request-list')).toBeVisible();

    expect(bodies).toEqual([{ staffName: name, team: 'Medical', invite: CODE }]);
    expect(await sawPasswordStep(page)).toBe(false);
    expect((await context.cookies()).find((c) => c.name === 'lp_session')?.httpOnly).toBe(true);
    // Remembered like a password sign-in; the code is forgotten once used.
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('lp-identity') ?? 'null'))).toEqual({ name, team: 'Medical' });
    expect(await kept(page)).toMatchObject({ session: null, inLocal: false });
    expect(page.url()).not.toContain(CODE);
  });

  test('/#join=… signed out: the redirect to sign-in keeps the code, then step 1 → the app', async ({ page }) => {
    await watchForPasswordStep(page);
    await page.goto(`/#join=${CODE}`);
    await expect(page).toHaveURL(/\/signin$/);
    await hydrated(page);
    expect(await kept(page)).toMatchObject({ session: CODE, hash: '' });
    await nameField(page).fill(`TEST-B join root ${uniq()}`);
    await page.getByRole('radio', { name: 'Dispatch' }).click();
    await continueButton(page).click();
    await expect(page).toHaveURL(APP_URL);
    expect(await sawPasswordStep(page)).toBe(false);
  });

  test('a remembered name and team: step 1 prefilled instead of the password step, Continue → the app', async ({ page }) => {
    await watchForPasswordStep(page);
    const name = `TEST-B join remembered ${uniq()}`;
    await page.goto('/signin');
    await hydrated(page);
    await page.evaluate((n) => localStorage.setItem('lp-identity', JSON.stringify({ name: n, team: 'GC/HX - Base' })), name);
    await page.goto(`/signin?next=${encodeURIComponent('/?view=mine')}#join=${CODE}`);
    await hydrated(page);
    expect(page.url()).toMatch(/\/signin\?next=%2F%3Fview%3Dmine$/);
    await expect(nameField(page)).toHaveValue(name);
    await expect(page.getByRole('radio', { name: 'GCHX Base' })).toHaveAttribute('aria-checked', 'true');
    await continueButton(page).click();
    await expect(page).toHaveURL(/\/\?view=mine$/);
    expect(await sawPasswordStep(page)).toBe(false);
  });

  test('a bad code: Continue → the password step with no message; the password signs in', async ({ page }) => {
    const bodies = sessionBodies(page);
    const name = `TEST-B join bad ${uniq()}`;
    await page.goto('/signin#join=not-the-team-code');
    await hydrated(page);
    expect(page.url()).not.toContain('#');
    await nameField(page).fill(name);
    await page.getByRole('radio', { name: 'Medical' }).click();
    await continueButton(page).click();
    await expect(stepTwoHeading(page)).toBeVisible();
    await expect(page.getByText(name, { exact: true })).toBeVisible();
    await expect(alertLine(page)).toHaveCount(0);
    await expect(passwordField(page)).not.toHaveAttribute('aria-invalid', 'true');
    expect(await kept(page)).toMatchObject({ session: null });

    await passwordField(page).fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(APP_URL);
    expect(bodies).toEqual([
      { staffName: name, team: 'Medical', invite: 'not-the-team-code' },
      { staffName: name, team: 'Medical', password: PASSWORD },
    ]);
  });

  test('no signal: the code is kept, the usual message shows, and Continue tries again', async ({ page }) => {
    let failNext = true;
    await page.route('**/api/session', async (route) => {
      if (route.request().method() === 'POST' && failNext) {
        failNext = false;
        return route.abort('internetdisconnected');
      }
      return route.fallback();
    });
    await page.goto(`/signin#join=${CODE}`);
    await hydrated(page);
    await nameField(page).fill(`TEST-B join offline ${uniq()}`);
    await page.getByRole('radio', { name: 'Medical' }).click();
    await continueButton(page).click();
    await expect(alertLine(page)).toHaveText(NETWORK_MESSAGE);
    await expect(stepTwoHeading(page)).toHaveCount(0);
    expect(await kept(page)).toMatchObject({ session: CODE });
    await continueButton(page).click();
    await expect(page).toHaveURL(APP_URL);
  });
});

test.describe('team join link, signed in already', () => {
  signedInAs({ staffName: 'TEST-e2e Join Link', team: 'Medical' });

  test('the link just opens the app: fragment removed, nothing kept', async ({ page }) => {
    await page.goto(`/signin#join=${CODE}`);
    await expect(page).toHaveURL(APP_URL);
    await hydrated(page);
    await expect(page.getByTestId('request-list')).toBeVisible();
    expect(await kept(page)).toMatchObject({ session: null, hash: '', inLocal: false });
    expect(page.url()).not.toContain(CODE);

    await page.goto(`/?view=mine#join=${CODE}`);
    await hydrated(page);
    await expect(page).toHaveURL(/\/\?view=mine$/);
    expect(await kept(page)).toMatchObject({ session: null, hash: '' });
  });
});
