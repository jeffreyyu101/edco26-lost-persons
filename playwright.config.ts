import { defineConfig, devices } from '@playwright/test';
import { childTestEnv, testBaseUrl } from './scripts/test-env.mjs';

// End-to-end tests (spec §9.4, v2.1 A17). One worker; Chromium with the iPhone 14 profile, plus WebKit.
// baseURL comes from PORT (each agent uses its own port; default 3100). If nothing is listening there,
// Playwright starts `next start` with the .env.test environment (run `npm run build:test` first).
const baseURL = testBaseUrl();
const port = new URL(baseURL).port;

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results',
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    serviceWorkers: 'allow',
  },
  projects: [
    // --mute-audio: the alert chimes never play through the machine's speakers during a run.
    { name: 'chromium-iphone14', use: { ...devices['iPhone 14'], browserName: 'chromium', launchOptions: { args: ['--mute-audio'] } } },
    { name: 'webkit-iphone14', use: { ...devices['iPhone 14'] } },
  ],
  webServer: {
    command: 'node scripts/with-test-env.mjs next start',
    url: `${baseURL}/signin`,
    reuseExistingServer: true,
    timeout: 120_000,
    env: childTestEnv({ PORT: port }),
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
