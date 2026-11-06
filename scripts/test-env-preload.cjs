// Preloaded into every Node process of a test run: childTestEnv() (scripts/test-env.mjs) puts
// `--require <this file>` in NODE_OPTIONS, and next build / next start / next dev and their workers inherit it.
//
// Next.js reads .env* files (.env.local, .env, .env.production, ...) only through loadEnvConfig() in @next/env.
// __NEXT_PROCESSED_ENV stops the first load from applying them, but the files are still read, and a dev-server
// reload (forceReload) applies them regardless. So loadEnvConfig is replaced here, before Next requires
// @next/env, by one that reads no file: a test run only ever has the environment built from .env.test.
// If that cannot be done the process exits instead of running unprotected.
'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- a `node --require` preload is CommonJS */
const { join } = require('node:path');

try {
  // Resolved the way Next's own `require('@next/env')` resolves it.
  const id = require.resolve('@next/env', { paths: [join(__dirname, '..', 'node_modules', 'next')] });
  const real = require(id);
  const exportsWithoutDotenv = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(real))) {
    Object.defineProperty(exportsWithoutDotenv, key, { ...descriptor, configurable: true });
  }
  Object.defineProperty(exportsWithoutDotenv, 'loadEnvConfig', {
    enumerable: true,
    value: () => ({ combinedEnv: process.env, parsedEnv: undefined, loadedEnvFiles: [] }),
  });
  require.cache[id].exports = exportsWithoutDotenv;
} catch (error) {
  console.error(`test-env: cannot turn off Next.js .env file loading (${error && error.message}); refusing to run.`);
  process.exit(1);
}
