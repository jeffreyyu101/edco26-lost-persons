// Sign-in from 768 px (design/screens/desktop-sign-in.html layout A, approved): the page canvas, the logos
// above one 420 px bordered card, the theme toggle top right, the credit at the page foot, and the desktop
// touches: the first field focused on load, Enter continues and signs in (↵ cap), 1–4 pick a team when focus
// is not in a text field (cap in each card's corner), Esc on step 2 goes back (esc cap on Change). Under
// 768 px none of it applies (the phone sign-in is covered by signin.spec.ts).
//
// POST /api/session is mocked with page.route, so this runs against any build with no database. Synthetic
// names only; the console must never show them or the passwords.
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { axeViolations, overlappingTargets, smallTargets } from './helpers/a11y';

const MED = 'GC/HX - Special Operations/Med Transpo';
const DISPATCH = 'GC/HX - Dispatch';
const TEAMS = ['GCHX Med Transpo', 'Dispatch', 'GCHX Base', 'Medical'];
const CREDIT = 'Built by Jeffrey & Brian for Ground Control / Headliner Experience';

const SIZES = [
  { name: 'iPad portrait', width: 820, height: 1180, touch: true },
  { name: 'iPad landscape', width: 1180, height: 820, touch: true },
  { name: 'desktop', width: 1440, height: 900, touch: false },
] as const;
const DESKTOP = SIZES[2];

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });

async function openSignIn(page: Page, path = '/signin') {
  await page.goto(path);
  await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
}

/** A remembered identity (as after a past sign-in) opens step 2. */
async function remember(page: Page, name: string, team: string) {
  await openSignIn(page);
  await page.evaluate(([n, t]) => localStorage.setItem('lp-identity', JSON.stringify({ name: n, team: t })), [name, team]);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
}

const nameField = (page: Page) => page.getByRole('textbox', { name: 'Your name' });
const otherTeamField = (page: Page) => page.getByRole('textbox', { name: 'Other team' });
const passwordField = (page: Page) => page.getByLabel('Event password');
const radio = (page: Page, name: string) => page.getByRole('radio', { name, exact: true });
const card = (page: Page) => page.getByTestId('signin-card');
const stepOne = (page: Page) => page.getByRole('heading', { name: 'Staff sign-in' });
const stepTwo = (page: Page) => page.getByRole('heading', { name: 'Enter the event password' });
const changeButton = (page: Page) => page.getByRole('button', { name: 'Change name or team' });
/** Key caps: aria-hidden spans whose glyph is CSS generated content. */
const caps = (scope: Page | Locator) => scope.locator('[data-k]');
const box = async (l: Locator) => {
  const b = await l.boundingBox();
  if (!b) throw new Error('no box');
  return b;
};

const PII = ['Dana Kim', 'Sam Ortiz', 'orlando-wrong', 'orlando-right'];
let consoleLines: string[] = [];
test.beforeEach(({ page }) => {
  consoleLines = [];
  page.on('console', (msg) => consoleLines.push(msg.text()));
  page.on('pageerror', (err) => consoleLines.push(`pageerror: ${err.message}`));
});
test.afterEach(() => {
  for (const line of consoleLines) {
    for (const s of PII) expect(line, 'console must not contain PII').not.toContain(s);
    expect(line).not.toMatch(/^pageerror/);
  }
});

// page.route can't see requests a service worker makes; nothing here needs one.
test.use({ serviceWorkers: 'block', colorScheme: 'light' });

for (const size of SIZES) {
  test.describe(`layout A at ${size.width}×${size.height} (${size.name})`, () => {
    test.use({ viewport: { width: size.width, height: size.height }, isMobile: false, hasTouch: size.touch, deviceScaleFactor: 1 });

    test('canvas, logos above a 420 px card, toggle top right, credit at the foot, key caps, no overflow', async ({ page }) => {
      await openSignIn(page);
      await expect(stepOne(page)).toBeVisible();
      await expect(nameField(page)).toBeFocused();

      const c = await box(card(page));
      expect(Math.round(c.width)).toBe(420);
      expect(Math.abs(c.x + c.width / 2 - size.width / 2)).toBeLessThan(1);

      // The logos sit above the card, outside it.
      await expect(card(page).getByRole('img')).toHaveCount(0);
      for (const alt of ['EDC Orlando', 'Ground Control']) {
        const logo = await box(page.getByRole('img', { name: alt }));
        expect(logo.y + logo.height).toBeLessThan(c.y);
      }

      // A bordered panel on the page canvas (gray-2), not the phone's plain column.
      const look = await page.evaluate(() => {
        const main = document.querySelector('[data-testid="signin"]') as HTMLElement;
        const panel = document.querySelector('[data-testid="signin-card"]') as HTMLElement;
        const probe = document.createElement('div');
        probe.style.background = 'var(--gray-2)';
        main.appendChild(probe);
        const gray2 = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return { canvas: getComputedStyle(main).backgroundColor, gray2, card: getComputedStyle(panel).backgroundColor, ring: getComputedStyle(panel).boxShadow };
      });
      expect(look.canvas).toBe(look.gray2);
      expect(look.card).toBe('rgb(255, 255, 255)');
      expect(look.ring).toContain('0px 0px 0px 1px');

      // The heading is left-aligned inside the card (32 px padding), the app line above it.
      const heading = await box(stepOne(page));
      expect(Math.round(heading.x - c.x)).toBe(32);
      await expect(card(page).getByText('Is my friend in medical?', { exact: true })).toBeVisible();

      // Toggle in the page's top-right corner; credit below the card at the page foot.
      const toggle = await box(page.getByRole('button', { name: 'Switch to dark mode' }));
      expect(size.width - (toggle.x + toggle.width)).toBeLessThan(40);
      expect(toggle.y).toBeLessThan(40);
      const credit = await box(page.getByText(CREDIT, { exact: true }));
      expect(credit.y).toBeGreaterThan(c.y + c.height);
      expect(size.height - (credit.y + credit.height)).toBeLessThan(40);

      // ↵ on Continue and 1–4 on the cards, none of it in the controls' names or text.
      await expect(caps(page)).toHaveCount(5);
      for (const cap of await caps(page).all()) await expect(cap).toBeVisible();
      await expect(page.getByRole('button', { name: 'Continue', exact: true })).toHaveAttribute('aria-keyshortcuts', 'Enter');
      await expect(page.getByRole('radiogroup', { name: 'Your team' }).getByRole('radio')).toHaveText(TEAMS);
      for (const [i, team] of TEAMS.entries()) {
        await expect(radio(page, team)).toHaveAttribute('aria-keyshortcuts', String(i + 1));
        await expect(caps(radio(page, team))).toHaveAttribute('data-k', String(i + 1));
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

      // Step 2: no app-name line, esc on Change, ↵ on Sign in; the password is focused on load.
      await remember(page, 'Dana Kim', MED);
      await expect(stepTwo(page)).toBeVisible();
      await expect(passwordField(page)).toBeFocused();
      await expect(page.getByText('Is my friend in medical?', { exact: true })).toHaveCount(0);
      await expect(caps(changeButton(page))).toHaveAttribute('data-k', 'esc');
      await expect(caps(changeButton(page))).toBeVisible();
      await expect(changeButton(page)).toHaveAttribute('aria-keyshortcuts', 'Escape');
      await expect(caps(page.getByRole('button', { name: 'Sign in', exact: true }))).toBeVisible();
      expect(Math.round((await box(card(page))).width)).toBe(420);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    });
  });
}

test.describe('keyboard from 768 px', () => {
  test.use({ viewport: { width: DESKTOP.width, height: DESKTOP.height }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });

  test('type the name, Enter, a digit picks the team, Enter continues; Esc comes back prefilled', async ({ page }) => {
    await openSignIn(page);
    await expect(nameField(page)).toBeFocused();

    // Digits typed into a field are text, never shortcuts.
    await page.keyboard.type('Dana Kim2');
    await expect(nameField(page)).toHaveValue('Dana Kim2');
    for (const team of TEAMS) await expect(radio(page, team)).toHaveAttribute('aria-checked', 'false');
    await page.keyboard.press('Backspace');

    // No team yet: Enter leaves the field, then 1–4 pick (Cmd/Ctrl + digit is the browser's, not ours).
    await page.keyboard.press('Enter');
    await expect(nameField(page)).not.toBeFocused();
    await expect(stepOne(page)).toBeVisible();
    await page.keyboard.press('2');
    await expect(radio(page, 'Dispatch')).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Control+3');
    await page.keyboard.press('Meta+3');
    await expect(radio(page, 'Dispatch')).toHaveAttribute('aria-checked', 'true');

    // A digit clears a typed Other team, as tapping a card does.
    await otherTeamField(page).fill('Site Ops');
    await expect(radio(page, 'Dispatch')).toHaveAttribute('aria-checked', 'false');
    await page.keyboard.press('3');
    await expect(otherTeamField(page)).toHaveValue('Site Ops3');
    await page.keyboard.press('Backspace');
    await page.locator('body').click({ position: { x: 5, y: 300 } });
    await page.keyboard.press('4');
    await expect(radio(page, 'Medical')).toHaveAttribute('aria-checked', 'true');
    await expect(otherTeamField(page)).toHaveValue('');

    await page.keyboard.press('Enter');
    await expect(stepTwo(page)).toBeVisible();
    await expect(passwordField(page)).toBeFocused();
    await expect(page.getByText('Medical', { exact: true })).toBeVisible();

    // Esc (even from the password field) is Change: back to step 1, prefilled, name focused, not remembered.
    await page.keyboard.type('orlando-wrong');
    await page.keyboard.press('Escape');
    await expect(stepOne(page)).toBeVisible();
    await expect(nameField(page)).toBeFocused();
    await expect(nameField(page)).toHaveValue('Dana Kim');
    await expect(radio(page, 'Medical')).toHaveAttribute('aria-checked', 'true');
    expect(await page.evaluate(() => localStorage.getItem('lp-identity'))).toBeNull();

    // Valid step 1: Enter in the name field continues.
    await page.keyboard.press('Enter');
    await expect(stepTwo(page)).toBeVisible();
    await expect(passwordField(page)).toHaveValue('');
  });

  test('on the cards: Tab in, a digit moves the choice and the focus, Enter continues', async ({ page }) => {
    await openSignIn(page);
    await page.keyboard.type('Sam Ortiz');
    await page.keyboard.press('Tab');
    await expect(radio(page, 'GCHX Med Transpo')).toBeFocused();
    await page.keyboard.press('3');
    await expect(radio(page, 'GCHX Base')).toHaveAttribute('aria-checked', 'true');
    await expect(radio(page, 'GCHX Base')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(stepTwo(page)).toBeVisible();
    await expect(page.getByText('GCHX Base', { exact: true })).toBeVisible();
  });

  test('Enter on a button is the button: the theme toggle switches theme and step 1 stays', async ({ page }) => {
    await openSignIn(page);
    await nameField(page).fill('Dana Kim');
    await radio(page, 'Dispatch').click();
    await page.getByRole('button', { name: 'Switch to dark mode' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await expect(stepOne(page)).toBeVisible();
  });

  test('step 2: Enter signs in; Esc does nothing mid-request; a wrong password keeps the step', async ({ page }) => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const bodies: unknown[] = [];
    await page.route('**/api/session', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      bodies.push(route.request().postDataJSON());
      await held;
      await json(route, 401, { error: { code: 'unauthorized', message: 'x' } });
    });
    await remember(page, 'Dana Kim', DISPATCH);
    await expect(passwordField(page)).toBeFocused();
    await page.keyboard.type('orlando-wrong');
    await page.keyboard.press('Enter');
    await expect(changeButton(page)).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(stepTwo(page)).toBeVisible();
    release();
    await expect(page.getByTestId('signin').getByRole('alert')).toHaveText('Incorrect password');
    await expect(passwordField(page)).toBeFocused();
    expect(bodies).toEqual([{ staffName: 'Dana Kim', team: DISPATCH, password: 'orlando-wrong' }]);

    // From the page (focus nowhere in particular) Enter goes to the empty password, then signs in.
    await page.locator('body').click({ position: { x: 5, y: 300 } });
    await page.keyboard.press('Enter');
    await expect(passwordField(page)).toBeFocused();
    await page.keyboard.type('orlando-right');
    await page.locator('body').click({ position: { x: 5, y: 300 } });
    await page.keyboard.press('Enter');
    await expect.poll(() => bodies.length).toBe(2);
  });

  test('success: Enter signs in and opens ?next=', async ({ page }) => {
    await page.route('**/api/session', (route) =>
      route.request().method() === 'POST'
        ? json(route, 200, { staffName: 'Dana Kim', team: MED, staff: `Dana Kim · ${MED}`, expiresAt: new Date(Date.now() + 3600_000).toISOString() })
        : route.fallback(),
    );
    await openSignIn(page, `/signin?next=${encodeURIComponent('/?view=pending')}`);
    await page.keyboard.type('Dana Kim');
    await page.keyboard.press('Enter');
    await page.keyboard.press('1');
    const navigation = page.waitForRequest((r) => r.isNavigationRequest() && new URL(r.url()).pathname !== '/signin');
    await page.keyboard.press('Enter');
    await expect(passwordField(page)).toBeFocused();
    await page.keyboard.type('orlando-right');
    await page.keyboard.press('Enter');
    const url = new URL((await navigation).url());
    expect(`${url.pathname}${url.search}`).toBe('/?view=pending');
  });
});

test.describe('under 768 px the phone sign-in is unchanged', () => {
  test.use({ viewport: { width: 767, height: 900 } });

  test('no card, no caps, no autofocus, no shortcuts', async ({ page }) => {
    await openSignIn(page);
    await expect(stepOne(page)).toBeVisible();
    await expect(nameField(page)).not.toBeFocused();
    for (const cap of await caps(page).all()) await expect(cap).toBeHidden();
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).not.toHaveAttribute('aria-keyshortcuts', /.+/);
    const look = await card(page).evaluate((el) => ({ shadow: getComputedStyle(el).boxShadow, padding: getComputedStyle(el).paddingTop }));
    expect(look).toEqual({ shadow: 'none', padding: '0px' });
    expect(await stepOne(page).evaluate((el) => getComputedStyle(el).textAlign)).toBe('center');

    await page.keyboard.press('2');
    await expect(radio(page, 'Dispatch')).toHaveAttribute('aria-checked', 'false');

    await remember(page, 'Dana Kim', MED);
    await expect(passwordField(page)).not.toBeFocused();
    await page.keyboard.press('Escape');
    await expect(stepTwo(page)).toBeVisible();
  });
});

// Accessibility at tablet and desktop sizes, both themes (as tests/e2e/a11y.spec.ts does for the phone):
// axe WCAG 2.0/2.1 A + AA, 44 px targets on touch sizes, and no tap area over another control.
test.describe('accessibility from 768 px', () => {
  test.use({ bypassCSP: true });
  for (const theme of ['light', 'dark'] as const) {
    for (const size of [SIZES[0], DESKTOP]) {
      test.describe(`${theme} at ${size.width}×${size.height}`, () => {
        test.use({ viewport: { width: size.width, height: size.height }, isMobile: false, hasTouch: size.touch, colorScheme: theme });

        test(`both steps pass axe${size.touch ? ' and have 44 px targets' : ''} (${theme}, ${size.width})`, async ({ page }) => {
          await page.addInitScript((t) => localStorage.setItem('lp-theme', t), theme);
          await openSignIn(page);
          await nameField(page).fill('Dana Kim');
          await radio(page, 'Dispatch').click();
          await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
          const results = [{ view: 'step 1', axe: await axeViolations(page), small: size.touch ? await smallTargets(page) : [], overlaps: await overlappingTargets(page) }];
          await page.keyboard.press('Enter'); // focus is on the card: Enter continues
          await expect(stepTwo(page)).toBeVisible();
          await page.keyboard.type('orlando-wrong');
          results.push({ view: 'step 2', axe: await axeViolations(page), small: size.touch ? await smallTargets(page) : [], overlaps: await overlappingTargets(page) });
          for (const r of results) expect.soft(r, r.view).toEqual({ view: r.view, axe: [], small: [], overlaps: [] });
        });
      });
    }
  }
});
