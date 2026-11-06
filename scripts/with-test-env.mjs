#!/usr/bin/env node
// Runs a command with ONLY the local test environment (.env.test), never .env.local:
//
//   node scripts/with-test-env.mjs next build
//   PORT=3101 node scripts/with-test-env.mjs next start
//
// PORT from the caller's environment wins over .env.test. Refuses non-local Supabase URLs.
import { spawn } from 'node:child_process';
import { childTestEnv } from './test-env.mjs';

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error('usage: node scripts/with-test-env.mjs <command> [args...]');
  process.exit(2);
}

let env;
try {
  env = childTestEnv(process.env.PORT ? { PORT: process.env.PORT } : {});
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
}

// `next start` needs the port as a flag; add it when the caller did not. Test servers listen on loopback
// only (the default binds every interface, which would expose a test server to the LAN), matching the
// 127.0.0.1 base URL the tests use.
if (cmd === 'next' && (args[0] === 'start' || args[0] === 'dev')) {
  if (!args.includes('--port') && !args.includes('-p')) args.push('--port', env.PORT || '3100');
  if (!args.includes('--hostname') && !args.includes('-H')) args.push('--hostname', '127.0.0.1');
}

const child = spawn(cmd === 'next' ? 'node_modules/.bin/next' : cmd, args, { env, stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
