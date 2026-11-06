// Sign-in end to end (spec §8 Sign-in, §9.4 "sign-in: wrong password, rate-limit message, remembered step 2,
// Change" and "session expiry: a 401 lands on step 2 and returns").
//
// Two groups:
//   * "sign-in UI" mocks POST /api/session with page.route, so it runs against any build (no database).
//   * "@api" tests use the real POST /api/session and the local Supabase stack. They skip themselves when
//     the route is missing (404). Each test sends a unique fake client IP (x-vercel-forwarded-for, read
//     locally per A17) and a unique synthetic name, so login limits never leak between tests or runs.
//     The in-app 401 test also exercises the real store's redirect (lib/client/store-core.ts).
// Run one group with `--grep @api` or `--grep-invert @api`. Synthetic data only.
import { expect, test, type BrowserContext, type Page, type Request, type Route } from '@playwright/test';
import { loadTestEnv } from '../../scripts/test-env.mjs';

const MED = 'GC/HX - Special Operations/Med Transpo';
const DISPATCH = 'GC/HX - Dispatch';
const TEAM_ORDER = ['GCHX Med Transpo', 'Dispatch', 'GCHX Base', 'Medical'];
const NETWORK_MESSAGE = 'Couldn’t sign in — check signal and try again';

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function sessionInfo(staffName: string, team: string) {
  return { staffName, team, staff: `${staffName} · ${team}`, expiresAt: new Date(Date.now() + 12 * 3600_000).toISOString() };
}

const json = (route: Route, status: number, body: unknown, headers: Record<string, string> = {}) =>
  route.fulfill({ status, contentType: 'application/json', headers: { 'Cache-Control': 'no-store', ...headers }, body: JSON.stringify(body) });

/** Answers POST /api/session with `respond` and records every request body. */
async function mockSession(page: Page, respond: (route: Route, body: Record<string, unknown>) => Promise<void>) {
  const bodies: Record<string, unknown>[] = [];
  await page.route('**/api/session', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    bodies.push(body);
    await respond(route, body);
  });
  return bodies;
}

async function openSignIn(page: Page, path = '/signin') {
  await page.goto(path);
  await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
}

/** Puts a remembered identity in localStorage (as a past sign-in would) and reloads. */
async function remember(page: Page, name: string, team: string, path = '/signin') {
  await openSignIn(page, path);
  await page.evaluate(([n, t]) => localStorage.setItem('lp-identity', JSON.stringify({ name: n, team: t })), [name, team]);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
}

const nameField = (page: Page) => page.getByRole('textbox', { name: 'Your name' });
const otherTeamField = (page: Page) => page.getByRole('textbox', { name: 'Other team' });
const passwordField = (page: Page) => page.getByLabel('Event password');
const continueButton = (page: Page) => page.getByRole('button', { name: 'Continue' });
const signInButton = (page: Page) => page.getByRole('button', { name: 'Sign in' });
const stepTwoHeading = (page: Page) => page.getByRole('heading', { name: 'Enter the event password' });
/** The error row under the field (scoped: Next's route announcer is also role=alert). */
const alertLine = (page: Page) => page.getByTestId('signin').getByRole('alert');

async function fillStepOne(page: Page, name: string, team: { card: string } | { other: string }) {
  await nameField(page).fill(name);
  if ('card' in team) await page.getByRole('radio', { name: team.card }).click();
  else await otherTeamField(page).fill(team.other);
  await continueButton(page).click();
  await expect(stepTwoHeading(page)).toBeVisible();
}

/** Resolves with the first top-level navigation away from /signin. */
function nextNavigation(page: Page): Promise<Request> {
  return page.waitForRequest((r) => r.isNavigationRequest() && r.frame() === page.mainFrame() && new URL(r.url()).pathname !== '/signin');
}

// ---------------------------------------------------------------------------------------------------
// UI with a mocked POST /api/session
// ---------------------------------------------------------------------------------------------------

test.describe('sign-in UI', () => {
  // page.route can't see requests a service worker makes; nothing here needs one.
  test.use({ serviceWorkers: 'block', colorScheme: 'light' });

  const secrets = ['Dana Kim', 'Sam Ortiz', 'orlando-wrong', 'orlando-right'];
  let consoleLines: string[];

  test.beforeEach(({ page }) => {
    consoleLines = [];
    page.on('console', (msg) => consoleLines.push(msg.text()));
    page.on('pageerror', (err) => consoleLines.push(`pageerror: ${err.message}`));
  });

  test.afterEach(() => {
    // Never log PII: no name or password may reach the console, and nothing may throw.
    for (const line of consoleLines) {
      for (const s of secrets) expect(line, 'console must not contain PII').not.toContain(s);
      expect(line).not.toMatch(/^pageerror/);
    }
  });

  test('step 1: logos, copy, team cards in order; Continue needs a name and a team', async ({ page }) => {
    await openSignIn(page);
    await expect(page.getByRole('heading', { name: 'Staff sign-in' })).toBeVisible();
    await expect(page.getByText('Is my friend in medical?', { exact: true })).toBeVisible();
    await expect(page.getByRole('img', { name: 'EDC Orlando' })).toBeVisible();
    await expect(page.getByRole('img', { name: 'Ground Control' })).toBeVisible();
    await expect(page.getByText('Built by Jeffrey & Brian for Ground Control / Headliner Experience')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Switch to dark mode' })).toBeVisible();
    await expect(page.getByText('Your team', { exact: true })).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: 'Your team' }).getByRole('radio')).toHaveText(TEAM_ORDER);

    // iOS: inputs at 16 px never zoom.
    expect(await nameField(page).evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px');

    await expect(continueButton(page)).toBeDisabled();
    await nameField(page).fill('D');
    await page.getByRole('radio', { name: 'Dispatch' }).click();
    await expect(continueButton(page)).toBeDisabled();
    await nameField(page).fill('Dana Kim');
    await expect(continueButton(page)).toBeEnabled();

    // A card and the Other team text exclude each other.
    await otherTeamField(page).fill('Site Ops');
    await expect(page.getByRole('radio', { name: 'Dispatch' })).toHaveAttribute('aria-checked', 'false');
    await expect(continueButton(page)).toBeEnabled();
    await page.getByRole('radio', { name: 'Medical' }).click();
    await expect(otherTeamField(page)).toHaveValue('');
    await expect(page.getByRole('radio', { name: 'Medical' })).toHaveAttribute('aria-checked', 'true');

    // The attribution separator can't be part of a name.
    await nameField(page).fill('Dana · Kim');
    await expect(page.getByText('Remove the “·” character')).toBeVisible();
    await expect(continueButton(page)).toBeDisabled();
  });

  test('step 2: identity row with no app-name line, show/hide, Keychain username, Change goes back prefilled', async ({ page }) => {
    await openSignIn(page);
    await fillStepOne(page, 'Dana Kim', { card: 'GCHX Med Transpo' });

    await expect(page.getByText('Is my friend in medical?', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Dana Kim', { exact: true })).toBeVisible();
    await expect(page.getByText('GCHX Med Transpo', { exact: true })).toBeVisible();
    await expect(page.getByText('DK', { exact: true })).toBeVisible();
    await expect(passwordField(page)).toBeFocused();
    await expect(signInButton(page)).toBeDisabled();

    const keychain = page.locator('input[autocomplete="username"]');
    await expect(keychain).toHaveValue('Dana Kim');
    await expect(keychain).toHaveAttribute('name', 'username');
    await expect(passwordField(page)).toHaveAttribute('autocomplete', 'current-password');

    await passwordField(page).fill('orlando-wrong');
    await expect(signInButton(page)).toBeEnabled();
    await expect(passwordField(page)).toHaveAttribute('type', 'password');
    await page.getByRole('button', { name: 'Show password' }).click();
    await expect(passwordField(page)).toHaveAttribute('type', 'text');
    await page.getByRole('button', { name: 'Hide password' }).click();
    await expect(passwordField(page)).toHaveAttribute('type', 'password');

    await page.getByRole('button', { name: 'Change name or team' }).click();
    await expect(page.getByRole('heading', { name: 'Staff sign-in' })).toBeVisible();
    await expect(nameField(page)).toHaveValue('Dana Kim');
    await expect(nameField(page)).toBeFocused();
    await expect(page.getByRole('radio', { name: 'GCHX Med Transpo' })).toHaveAttribute('aria-checked', 'true');
  });

  test('wrong password: red field, "Incorrect password", field cleared; typing clears the error', async ({ page }) => {
    const bodies = await mockSession(page, (route) => json(route, 401, { error: { code: 'unauthorized', message: 'Incorrect password' } }));
    await openSignIn(page);
    await fillStepOne(page, 'Dana Kim', { card: 'GCHX Med Transpo' });
    await passwordField(page).fill('orlando-wrong');
    await passwordField(page).press('Enter');

    await expect(alertLine(page)).toHaveText('Incorrect password');
    await expect(passwordField(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(passwordField(page)).toHaveValue('');
    await expect(passwordField(page)).toBeFocused();
    await expect(signInButton(page)).toBeDisabled();
    expect(bodies).toEqual([{ staffName: 'Dana Kim', team: MED, password: 'orlando-wrong' }]);

    await passwordField(page).pressSequentially('x');
    await expect(page.getByText('Incorrect password')).toHaveCount(0);
    await expect(passwordField(page)).not.toHaveAttribute('aria-invalid', 'true');
  });

  test('429: "Too many attempts. Try again in N min" and Sign in stays disabled', async ({ page }) => {
    await mockSession(page, (route) =>
      json(route, 429, { error: { code: 'rate_limited', message: 'Too many attempts', retryAfterSeconds: 600 } }, { 'Retry-After': '600' }),
    );
    await remember(page, 'Dana Kim', MED);
    await passwordField(page).fill('orlando-wrong');
    await signInButton(page).click();
    await expect(alertLine(page)).toHaveText('Too many attempts. Try again in 10 min');
    await expect(signInButton(page)).toBeDisabled();
    await passwordField(page).fill('orlando-right');
    await expect(signInButton(page)).toBeDisabled();
    await expect(alertLine(page)).toHaveText('Too many attempts. Try again in 10 min');
  });

  test('success: an alias typed as Other team is sent canonical, the response is remembered, ?next= opens', async ({ page }) => {
    const bodies = await mockSession(page, (route, body) => json(route, 200, sessionInfo(String(body.staffName), DISPATCH)));
    await openSignIn(page, `/signin?next=${encodeURIComponent('/?view=mine')}`);
    await fillStepOne(page, '  Dana   Kim ', { other: 'dispatch' });
    await expect(page.getByText('Dispatch', { exact: true })).toBeVisible();
    await passwordField(page).fill('orlando-right');
    const navigation = nextNavigation(page);
    await signInButton(page).click();

    const url = new URL((await navigation).url());
    expect(`${url.pathname}${url.search}`).toBe('/?view=mine');
    expect(bodies).toEqual([{ staffName: 'Dana Kim', team: DISPATCH, password: 'orlando-right' }]);
    // Without a real cookie the proxy sends us back; the remembered identity now opens step 2.
    await expect(page).toHaveURL(/\/signin\?next=%2F%3Fview%3Dmine$/);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('lp-identity') ?? 'null'))).toEqual({ name: 'Dana Kim', team: DISPATCH });
    await expect(stepTwoHeading(page)).toBeVisible();
  });

  test('a custom Other team is sent as Other + otherTeam; nothing can be re-sent or changed mid-request', async ({ page }) => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const bodies = await mockSession(page, async (route) => {
      await held;
      await json(route, 401, { error: { code: 'unauthorized', message: 'x' } });
    });
    await openSignIn(page);
    await fillStepOne(page, 'Sam Ortiz', { other: 'Site Ops' });
    await expect(page.getByText('Site Ops', { exact: true })).toBeVisible();
    await passwordField(page).fill('orlando-wrong');
    await signInButton(page).click();
    await expect(signInButton(page)).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Change name or team' })).toBeDisabled();
    await passwordField(page).press('Enter');
    release();
    await expect(page.getByText('Incorrect password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Change name or team' })).toBeEnabled();
    expect(bodies).toEqual([{ staffName: 'Sam Ortiz', team: 'Other', otherTeam: 'Site Ops', password: 'orlando-wrong' }]);
  });

  for (const unsafe of ['https://evil.example/x', '//evil.example/x', '/api/export', '/\\evil.example']) {
    test(`?next=${unsafe} is ignored: sign-in opens /`, async ({ page, baseURL }) => {
      await mockSession(page, (route) => json(route, 200, sessionInfo('Dana Kim', MED)));
      await remember(page, 'Dana Kim', MED, `/signin?next=${encodeURIComponent(unsafe)}`);
      await passwordField(page).fill('orlando-right');
      const navigation = nextNavigation(page);
      await signInButton(page).click();
      const url = new URL((await navigation).url());
      expect(url.origin).toBe(new URL(baseURL ?? '').origin);
      expect(`${url.pathname}${url.search}`).toBe('/');
    });
  }

  test('remembered name and team land on step 2; Change forgets them', async ({ page }) => {
    await remember(page, 'Dana Kim', 'Prevent');
    await expect(stepTwoHeading(page)).toBeVisible();
    await expect(page.getByText('Dana Kim', { exact: true })).toBeVisible();
    await expect(page.getByText('Prevent', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Staff sign-in' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Change name or team' }).click();
    await expect(otherTeamField(page)).toHaveValue('Prevent');
    expect(await page.evaluate(() => localStorage.getItem('lp-identity'))).toBeNull();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Staff sign-in' })).toBeVisible();
    await expect(nameField(page)).toHaveValue('');
  });

  test('no connection and server errors keep the user on step 2 with a short message', async ({ page }) => {
    let mode: 'abort' | '503' = 'abort';
    await page.route('**/api/session', (route) =>
      mode === 'abort' ? route.abort('internetdisconnected') : json(route, 503, { error: { code: 'unavailable', message: 'x', id: 'e1' } }),
    );
    await remember(page, 'Dana Kim', MED);
    await passwordField(page).fill('orlando-right');
    await signInButton(page).click();
    await expect(alertLine(page)).toHaveText(NETWORK_MESSAGE);
    await expect(passwordField(page)).toHaveValue('orlando-right');
    await expect(passwordField(page)).not.toHaveAttribute('aria-invalid', 'true');
    mode = '503';
    await signInButton(page).click();
    await expect(alertLine(page)).toHaveText('Couldn’t sign in — try again');
    await expect(signInButton(page)).toBeEnabled();
  });

  test('theme toggle: dark persists across a reload with no flash; the EDC logo inverts', async ({ page }) => {
    await openSignIn(page);
    await expect(page.locator('html')).toHaveClass(/\blight\b/);
    await page.getByRole('button', { name: 'Switch to dark mode' }).click();
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    expect(await page.evaluate(() => localStorage.getItem('lp-theme'))).toBe('dark');
    await expect(page.getByRole('button', { name: 'Switch to light mode' })).toBeVisible();
    await expect(page.getByRole('img', { name: 'EDC Orlando' })).toHaveCSS('filter', 'invert(1)');
    await expect(page.getByRole('img', { name: 'Ground Control' })).toHaveCSS('filter', 'none');

    // The class must already be on <html> when the document is parsed (pre-paint script), not after hydration.
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        (window as unknown as { __lpClassAtParse: string }).__lpClassAtParse = document.documentElement.className;
      });
    });
    await page.reload();
    expect(await page.evaluate(() => (window as unknown as { __lpClassAtParse?: string }).__lpClassAtParse)).toMatch(/\bdark\b/);
    await page.getByRole('button', { name: 'Switch to light mode' }).click();
    await expect(page.locator('html')).toHaveClass(/\blight\b/);
  });
});

// ---------------------------------------------------------------------------------------------------
// Real POST /api/session (local Supabase). Skipped until the route exists.
// ---------------------------------------------------------------------------------------------------

test.describe('sign-in with the real server @api', () => {
  const env: Record<string, string | undefined> = loadTestEnv();
  const password = env['APP_SHARED_PASSWORD'];
  let routeExists: boolean | null = null;

  test.beforeEach(async ({ request, context }) => {
    if (routeExists === null) routeExists = (await request.get('/api/session')).status() !== 404;
    test.skip(!routeExists, 'POST /api/session is not built in this checkout');
    test.skip(!password, '.env.test has no APP_SHARED_PASSWORD');
    await useFakeIp(context);
  });

  /** A unique client IP per test, so the per-IP login limit never carries over. */
  async function useFakeIp(context: BrowserContext): Promise<string> {
    const octet = () => Math.floor(Math.random() * 250) + 1;
    const ip = `10.${octet()}.${octet()}.${octet()}`;
    await context.setExtraHTTPHeaders({ 'x-vercel-forwarded-for': ip, 'x-real-ip': ip });
    return ip;
  }

  test('wrong password shows "Incorrect password" @api', async ({ page }) => {
    await openSignIn(page);
    await fillStepOne(page, `TEST-B wrong ${uniq()}`, { card: 'Medical' });
    await passwordField(page).fill(`not-${password}`);
    await signInButton(page).click();
    await expect(alertLine(page)).toHaveText('Incorrect password');
    await expect(passwordField(page)).toHaveAttribute('aria-invalid', 'true');
  });

  test('signs in, returns to ?next=, and after the session expires lands on step 2 and returns @api', async ({ page, context }) => {
    const name = `TEST-B ok ${uniq()}`;
    await openSignIn(page, `/signin?next=${encodeURIComponent('/?view=mine')}`);
    await fillStepOne(page, name, { card: 'Medical' });
    await passwordField(page).fill(password ?? '');
    await signInButton(page).click();
    await expect(page).toHaveURL(/\/\?view=mine$/);
    const cookie = (await context.cookies()).find((c) => c.name === 'lp_session');
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('Lax');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('lp-identity') ?? 'null'))).toEqual({ name, team: 'Medical' });

    // Session expiry: the cookie is gone; opening the app goes to step 2, prefilled, and comes back.
    await context.clearCookies({ name: 'lp_session' });
    // Leave the app first: its next poll would 401 and redirect, racing (aborting) the goto below.
    await page.goto('about:blank');
    await page.goto('/?view=pending');
    await expect(page).toHaveURL(/\/signin\?next=%2F%3Fview%3Dpending$/);
    await expect(stepTwoHeading(page)).toBeVisible();
    await expect(page.getByText(name, { exact: true })).toBeVisible();
    await passwordField(page).fill(password ?? '');
    await signInButton(page).click();
    await expect(page).toHaveURL(/\/\?view=pending$/);
  });

  test('too many wrong passwords: "Too many attempts. Try again in N min" @api', async ({ page, baseURL }) => {
    const name = `TEST-B limit ${uniq()}`;
    const ip = await useFakeIp(page.context());
    const headers = { origin: new URL(baseURL ?? '').origin, 'x-vercel-forwarded-for': ip, 'x-real-ip': ip };
    let limited = false;
    for (let i = 0; i < 12 && !limited; i += 1) {
      const res = await page.request.post('/api/session', {
        headers,
        data: { staffName: name, team: 'Medical', password: `wrong-${i}` },
      });
      expect([401, 429]).toContain(res.status());
      limited = res.status() === 429;
    }
    expect(limited, 'the server rate-limits repeated wrong passwords').toBe(true);

    await remember(page, name, 'Medical');
    await passwordField(page).fill(password ?? '');
    await signInButton(page).click();
    await expect(alertLine(page)).toHaveText(/^Too many attempts\. Try again in (?:[1-9]|1[0-5]) min$/);
    await expect(signInButton(page)).toBeDisabled();
  });

  test('a 401 inside the app lands on step 2 prefilled and returns after sign-in @api', async ({ page, context }) => {
    const name = `TEST-B expiry ${uniq()}`;
    await openSignIn(page, `/signin?next=${encodeURIComponent('/?view=mine')}`);
    await fillStepOne(page, name, { card: 'GCHX Base' });
    await passwordField(page).fill(password ?? '');
    await signInButton(page).click();
    await expect(page).toHaveURL(/\/\?view=mine$/);
    await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');

    // The cookie expires while the app is open: the next sync gets a 401 and the store sends us to sign-in.
    await context.clearCookies({ name: 'lp_session' });
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page).toHaveURL(/\/signin\?next=/, { timeout: 20_000 });
    await expect(stepTwoHeading(page)).toBeVisible();
    await expect(page.getByText(name, { exact: true })).toBeVisible();
    await passwordField(page).fill(password ?? '');
    await signInButton(page).click();
    await expect(page).toHaveURL(/\/\?view=mine$/);
  });
});
