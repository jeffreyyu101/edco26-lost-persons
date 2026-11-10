#!/usr/bin/env node
// Runs the Playwright e2e suite in N parallel lanes (default 3) with the same tests and the same isolation as
// `npm run test:e2e`: every lane has its OWN local Supabase stack and its OWN production build + `next start`
// on its own port, and runs its share of the spec files with one worker, exactly as a single run does.
//
//   npm run test:e2e:lanes                       # 3 lanes, full suite
//   npm run test:e2e:lanes -- --lanes 2
//   npm run test:e2e:lanes -- --files list.spec.ts,health.spec.ts
//   npm run test:e2e:lanes -- --plan             # only print how the suite would be split
//   npm run test:e2e:lanes -- -- --grep "dashboard"   # everything after a second `--` goes to Playwright
//
// How a lane is isolated (docs: README "Parallel lanes"):
//   * Stack: claimed the way ~/.config/lp-stacks/claim.sh does (an atomic /tmp/lp-stack-sN.claim directory), but a
//     stopped free stack first: a free stack that is running is claimed only when no other is free, and the log says
//     so. Created/started with make.sh, then `supabase db reset`,
//     the synthetic seed and its photos (what `npm run db:reset` does, against that stack) and the auto-close job
//     paused. The scripts in ~/.config/lp-stacks are used as they are; use.sh is NOT used, because it rewrites
//     .env.test inside the worktree (and the test tooling reads that one file through a path fixed at ROOT).
//     Nothing shared is rewritten: each lane runs in its own copy of this checkout (`cp -c` clones on APFS, so it
//     costs seconds, not disk) with its own .env.test / .env.test.local naming its stack and port, its own
//     `.next` and `test-results`, and its own e2e lock (the lock directory is per stack port). The test tooling
//     (scripts/test-env.mjs, tests, config) is the unmodified one, running from the copy.
//   * Build: one `next build` per lane (about 12 s) in its own copy, so no lane's server reads another's `.next`.
//   * Server: `node scripts/with-test-env.mjs next start` on the lane's port, so Playwright reuses it.
//
// Split: whole spec files per project (never single tests), balanced by seconds from scripts/e2e-lane-timings.json
// (updated after a run that ran every test), falling back to test counts. The set of tests that ran is compared
// with `playwright test --list`; any test missing, duplicated or unexpected fails the run.
//
// On exit (normal, error, Ctrl-C, SIGTERM) every server and Playwright process it started is stopped, every stack it
// claimed is released and left as it was found (a stack that was running stays running, with its auth container
// started again; one that was stopped is stopped, unless --keep-stacks), and the lane copies are deleted.
import { execFile, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statfsSync, writeFileSync, createWriteStream } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ROOT, assertLocalUrl, parseEnv } from './test-env.mjs';
import {
  availableMemoryBytes,
  compareRuns,
  failuresOf,
  flattenReport,
  fmtDuration,
  laneInvocations,
  parseMeminfo,
  partition,
  resourceProblems,
  stackAfterRun,
  stackClaimOrder,
  tally,
  unitsFrom,
  updateTimings,
  weigh,
} from './e2e-lanes-lib.mjs';

const TIMINGS_FILE = join(ROOT, 'scripts', 'e2e-lane-timings.json');
const STACKS_DIR = process.env.LP_STACKS_DIR || join(homedir(), '.config', 'lp-stacks');
const STACKS_HOME = join(homedir(), '.lp-stacks');
const PROJECT_ORDER = ['chromium-iphone14', 'webkit-iphone14'];
const COPY_SKIP = new Set(['.git', '.claude', '.next', 'test-results', 'playwright-report', 'blob-report', '.env.test.local']);

// --- arguments ------------------------------------------------------------------------------------------------

const argv = process.argv.slice(2);
const dashes = argv.indexOf('--');
const ownArgs = dashes < 0 ? argv : argv.slice(0, dashes);
const playwrightArgs = dashes < 0 ? [] : argv.slice(dashes + 1);
const opt = { lanes: 3, files: null, plan: false, keepStacks: false, keepDirs: false, keepAuth: false, basePort: 3201, logDir: null, help: false };
for (let i = 0; i < ownArgs.length; i++) {
  const a = ownArgs[i];
  const value = () => {
    const v = ownArgs[++i];
    if (v === undefined) die(`${a} needs a value`);
    return v;
  };
  if (a === '--lanes') opt.lanes = Number(value());
  else if (a === '--files') opt.files = value().split(',').map((s) => s.trim().replace(/^tests\/e2e\//, '')).filter(Boolean);
  else if (a === '--base-port') opt.basePort = Number(value());
  else if (a === '--log-dir') opt.logDir = value();
  else if (a === '--plan') opt.plan = true;
  else if (a === '--keep-stacks') opt.keepStacks = true;
  else if (a === '--keep-dirs') opt.keepDirs = true;
  else if (a === '--keep-auth') opt.keepAuth = true;
  else if (a === '-h' || a === '--help') opt.help = true;
  else die(`unknown option ${a} (see --help)`);
}
if (opt.help) {
  console.log(`usage: npm run test:e2e:lanes -- [options] [-- <playwright args>]
  --lanes N         lanes to run (default 3)
  --files a,b       only these spec files (relative to tests/e2e)
  --plan            print the split and stop; starts nothing
  --keep-stacks     leave the lane Supabase stacks running, auth container restarted (they are still released)
  --keep-dirs       keep the lane copies of the checkout (for debugging)
  --keep-auth       leave the unused Supabase auth container running
  --base-port P     first app port to try (default 3201)
  --log-dir DIR     where the logs and merged results go (default: a new folder in the temp dir)`);
  process.exit(0);
}
if (!Number.isInteger(opt.lanes) || opt.lanes < 1 || opt.lanes > 6) die('--lanes must be a whole number from 1 to 6');

function die(message, code = 2) {
  console.error(`e2e-lanes: ${message}`);
  process.exit(code);
}

// --- plumbing -------------------------------------------------------------------------------------------------

const startedAt = Date.now();
const runId = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const logDir = opt.logDir || join(tmpdir(), `lp-e2e-lanes-${runId}`);
const laneRoot = join(tmpdir(), `lp-e2e-lanes-${runId}-dirs`);
mkdirSync(logDir, { recursive: true });
const say = (msg) => console.log(`[${((Date.now() - startedAt) / 1000).toFixed(0).padStart(4)}s] ${msg}`);

/** Every process group this run started, so cleanup can stop them. */
const tracked = new Set();
const claimed = []; // stack numbers
const startedStacks = new Set();
/** The claimed stacks that were already running when claimed: they are left running. */
const foundRunning = new Set();
let cleaning = null;

function run(cmd, args, { cwd = ROOT, env = process.env, log, input, timeoutMs = 10 * 60_000, track = true } = {}) {
  return new Promise((resolve) => {
    const out = log ? createWriteStream(log, { flags: 'a' }) : null;
    out?.write(`\n$ ${cmd} ${args.join(' ').replace(/postgres(ql)?:\/\/\S+/g, 'postgresql://<local-db>')}\n`);
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    if (track) tracked.add(child);
    let stdout = '';
    child.stdout.on('data', (d) => {
      stdout += d;
      out?.write(d);
    });
    child.stderr.on('data', (d) => out?.write(d));
    if (input !== undefined) child.stdin.end(input);
    const timer = setTimeout(() => killGroup(child, 'SIGKILL'), timeoutMs);
    child.on('error', (error) => {
      out?.write(`spawn error: ${error.message}\n`);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      tracked.delete(child);
      out?.end();
      resolve({ code: code ?? (signal ? 1 : 0), stdout });
    });
  });
}

function killGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Already gone.
  }
}

async function must(label, cmd, args, opts) {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${label} failed (exit ${r.code}); see ${opts?.log ?? 'the log'}`);
  return r.stdout;
}

const capture = (cmd, args, timeoutMs = 20_000) =>
  new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: timeoutMs }, (error, stdout) => resolve(error ? null : stdout));
  });

function freePort(port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

async function pickPorts(count, from) {
  const ports = [];
  for (let p = from; ports.length < count && p < from + 200; p++) if (await freePort(p)) ports.push(p);
  if (ports.length < count) throw new Error(`no ${count} free ports from ${from}`);
  return ports;
}

async function waitHttp(url, { headers = {}, timeoutMs = 120_000, ok = (s) => s === 200 } = {}) {
  const until = Date.now() + timeoutMs;
  let last = 'no answer';
  while (Date.now() < until) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(5_000), redirect: 'manual' });
      if (ok(res.status)) return;
      last = `HTTP ${res.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(1_000);
  }
  throw new Error(`${url} not ready after ${Math.round(timeoutMs / 1000)} s (${last})`);
}

// --- cleanup --------------------------------------------------------------------------------------------------

async function cleanup(reason) {
  if (cleaning) return cleaning;
  cleaning = (async () => {
    if (reason) console.error(`\ne2e-lanes: ${reason}; cleaning up…`);
    for (const child of tracked) killGroup(child, 'SIGTERM');
    const until = Date.now() + 8_000;
    while (tracked.size && Date.now() < until) await sleep(200);
    for (const child of tracked) killGroup(child, 'SIGKILL');
    const after = (n) => stackAfterRun(foundRunning.has(n), opt.keepStacks);
    if (!opt.keepAuth) {
      for (const n of startedStacks) if (after(n) === 'leave-running') await run('docker', ['start', `supabase_auth_lp-s${n}`], { track: false });
    }
    // One at a time, and checked: two `supabase` processes finishing together race on ~/.supabase/telemetry.json
    // and one of them dies before it has stopped anything.
    for (const n of [...startedStacks].filter((x) => after(x) === 'stop')) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        await run('supabase', ['stop', '--workdir', join(STACKS_HOME, `s${n}`)], { log: join(logDir, `stack-s${n}-stop.log`), timeoutMs: 120_000, track: false });
        const up = (await capture('docker', ['ps', '--format', '{{.Names}}'])) ?? '';
        if (!up.split('\n').includes(`supabase_db_lp-s${n}`)) break;
      }
    }
    for (const n of claimed.splice(0)) await run('zsh', [join(STACKS_DIR, 'release.sh'), String(n)], { track: false });
    if (!opt.keepDirs) rmSync(laneRoot, { recursive: true, force: true });
  })();
  return cleaning;
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (cleaning) {
      console.error('e2e-lanes: second signal, exiting now');
      process.exit(130);
    }
    void cleanup(`caught ${signal}`).then(() => process.exit(130));
  });
}

// --- preflight ------------------------------------------------------------------------------------------------

async function preflight(newStacks) {
  for (const f of ['claim.sh', 'make.sh', 'release.sh']) {
    if (!existsSync(join(STACKS_DIR, f))) die(`${join(STACKS_DIR, f)} not found (set LP_STACKS_DIR)`);
  }
  for (const bin of ['supabase', 'psql', 'docker']) {
    if ((await capture('which', [bin])) === null) die(`${bin} is not installed or not on PATH`);
  }
  const dockerMem = await capture('docker', ['info', '--format', '{{.MemTotal}}'], 15_000);
  if (dockerMem === null) die('Docker is not running (start Colima or Docker Desktop first)');
  const vm = parseMeminfo((await capture('colima', ['ssh', '--', 'cat', '/proc/meminfo'], 20_000)) ?? '');
  if (!vm.total) {
    // No colima: fall back to what Docker reports; "available" is then unknown, so assume the VM is fully free.
    vm.total = Number(dockerMem.trim()) || 0;
    vm.available = vm.total;
  }
  const hostAvailable = availableMemoryBytes((await capture('vm_stat', [])) ?? '');
  let diskFree = Infinity;
  for (const dir of new Set([tmpdir(), ROOT, STACKS_HOME])) {
    try {
      const s = statfsSync(dir);
      diskFree = Math.min(diskFree, s.bavail * s.bsize);
    } catch {
      // Not there yet.
    }
  }
  const snapshot = { hostAvailable, vmTotal: vm.total, vmAvailable: vm.available, diskFree, lanes: opt.lanes, newStacks };
  const problems = resourceProblems(snapshot);
  const GB = 1024 ** 3;
  const free = (() => {
    let n = 0;
    try {
      for (const d of readdirSync(STACKS_HOME)) if (/^s\d+$/.test(d) && !existsSync(`/tmp/lp-stack-${d}.claim`)) n++;
    } catch {
      // No stacks at all.
    }
    return n;
  })();
  if (newStacks > free) problems.push(`only ${free} unclaimed local stack(s) in ${STACKS_HOME}, ${newStacks} needed (make more with ${join(STACKS_DIR, 'make.sh')} N <supabase dir>, or wait for a release)`);
  say(
    `preflight: host ${(hostAvailable / GB).toFixed(1)} GB available, Docker VM ${(vm.available / GB).toFixed(1)}/${(vm.total / GB).toFixed(1)} GB available, ` +
      `disk ${(diskFree / GB).toFixed(0)} GB free, load ${loadavg()[0].toFixed(1)}, ${free} free stack(s)`,
  );
  if (loadavg()[0] > 8) say(`warning: load average ${loadavg()[0].toFixed(1)} is above 8; timings will be inflated`);
  if (problems.length) {
    console.error(`e2e-lanes: refusing to start:\n  - ${problems.join('\n  - ')}`);
    process.exit(3);
  }
  return snapshot;
}

// --- claiming a stack -----------------------------------------------------------------------------------------

/** Every stack in ~/.lp-stacks: whether its database container runs, and when its claim (if any) was made. */
async function seeStacks() {
  const up = new Set(((await capture('docker', ['ps', '--format', '{{.Names}}'])) ?? '').split('\n').map((x) => x.trim()));
  const out = [];
  let dirs = [];
  try {
    dirs = readdirSync(STACKS_HOME).filter((d) => /^s\d+$/.test(d));
  } catch {
    // No stacks at all.
  }
  for (const d of dirs) {
    const n = Number(d.slice(1));
    const claimDir = `/tmp/lp-stack-s${n}.claim`;
    let claimedAtMs = null;
    if (existsSync(claimDir)) {
      try {
        claimedAtMs = Number(readFileSync(join(claimDir, 'owner'), 'utf8').trim().split(/\s+/)[1]) * 1000 || Date.now();
      } catch {
        claimedAtMs = Date.now(); // Being written right now: taken.
      }
    }
    out.push({ n, running: up.has(`supabase_db_lp-s${n}`), claimedAtMs });
  }
  return out;
}

/**
 * Claims a stack as claim.sh does (mkdir is the lock; owner file "<owner> <epoch s>"; a claim over 3 h old is stale),
 * preferring a stopped free stack; a running free one only when no stopped one is free, said in the log. Waits like
 * claim.sh (15 s polls, 30 min at most).
 */
async function claimStack(owner, laneNo) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const seen = await seeStacks();
    for (const c of stackClaimOrder(seen, Date.now())) {
      const dir = `/tmp/lp-stack-s${c.n}.claim`;
      if (c.stale) rmSync(dir, { recursive: true, force: true });
      try {
        mkdirSync(dir);
      } catch {
        continue; // Someone else got it first.
      }
      writeFileSync(join(dir, 'owner'), `${owner} ${Math.floor(Date.now() / 1000)}\n`);
      if (c.running) say(`lane ${laneNo}: no stopped stack is free; claiming s${c.n}, which is running without a claim (it is left running afterwards)`);
      return c;
    }
    if (attempt === 0) say(`lane ${laneNo}: no free stack; waiting for one (15 s polls, 30 min at most)`);
    await sleep(15_000);
  }
  throw new Error('no free stack after 30 min');
}

// --- lane preparation -----------------------------------------------------------------------------------------

async function cloneCheckout(dest, log) {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(ROOT)) {
    if (COPY_SKIP.has(name)) continue;
    // `cp -c` clones on APFS (copy-on-write, symlinks kept as links); plain `cp -R` where cloning is unsupported.
    const from = join(ROOT, name);
    const to = join(dest, name);
    let r = await run('cp', ['-cR', from, to], { log, track: false });
    if (r.code !== 0) {
      rmSync(to, { recursive: true, force: true });
      r = await run('cp', ['-R', from, to], { log, track: false });
    }
    if (r.code !== 0) throw new Error(`could not copy ${name} into ${dest}; see ${log}`);
  }
}

/** Rewrites the lane copy's .env.test (same edits as use.sh) and writes its .env.test.local keys. */
function writeLaneEnv(dir, { api, db, secret, publishable, port, n }) {
  assertLocalUrl('lane API_URL', api);
  assertLocalUrl('lane DB_URL', db);
  const file = join(dir, '.env.test');
  let s = readFileSync(file, 'utf8');
  s = s.replace(/^NEXT_PUBLIC_SUPABASE_URL=.*$/m, `NEXT_PUBLIC_SUPABASE_URL=${api}`);
  s = s.replace(/^SUPABASE_DB_URL=.*\n?/m, '');
  s = s.replace(/^PORT=.*\n?/m, '');
  s = `${s.replace(/\n+$/, '')}\nPORT=${port}\nSUPABASE_DB_URL=${db}\n`;
  writeFileSync(file, s);
  writeFileSync(
    join(dir, '.env.test.local'),
    `# Generated for isolated stack s${n} by scripts/e2e-lanes.mjs (local only). Gitignored; never commit.\nSUPABASE_SECRET_KEY=${secret}\nSUPABASE_PUBLISHABLE_KEY=${publishable}\n`,
    { mode: 0o600 },
  );
}

async function stackStatus(n) {
  let out = null;
  for (let attempt = 1; attempt <= 3 && !out; attempt++) out = await capture('supabase', ['status', '-o', 'env', '--workdir', join(STACKS_HOME, `s${n}`)], 60_000);
  if (!out) throw new Error(`supabase status failed for stack s${n}`);
  const env = parseEnv(out);
  const secret = env.SECRET_KEY || env.SERVICE_ROLE_KEY;
  if (!env.API_URL || !env.DB_URL || !secret) throw new Error(`supabase status for s${n} lacks API_URL / DB_URL / secret key`);
  return { api: env.API_URL, db: env.DB_URL, secret, publishable: env.PUBLISHABLE_KEY || env.ANON_KEY || '' };
}

const PAUSE_SQL =
  "do $pause$ begin if to_regclass('cron.job') is not null then perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'lp-close-inactive'; end if; end $pause$;";

/** Starts stack n, rebuilds its database from this checkout's migrations + seed, pauses the auto-close job. */
async function prepareStack(lane) {
  const { n, log } = lane;
  const workdir = join(STACKS_HOME, `s${n}`);
  say(`lane ${lane.index + 1}: starting stack s${n}`);
  // Every stack this run claimed is left on exit as it was found: stopped if it was stopped, else running with its
  // auth container started again (make.sh on a stack whose auth container this run stopped would fail for the next user).
  startedStacks.add(n);
  // Starting a stack can fail while Docker is busy (a half-started db container); stop what is there and try again.
  for (let attempt = 1; ; attempt++) {
    const made = await run('zsh', [join(STACKS_DIR, 'make.sh'), String(n), join(ROOT, 'supabase')], { log, timeoutMs: 10 * 60_000 });
    const reset = made.code === 0 ? await run('supabase', ['db', 'reset', '--local', '--no-seed', '--workdir', workdir], { log, timeoutMs: 10 * 60_000 }) : made;
    if (reset.code === 0) break;
    if (attempt >= 3) throw new Error(`stack s${n} would not start after ${attempt} tries; see ${log}`);
    say(`lane ${lane.index + 1}: stack s${n} did not start (try ${attempt}); stopping it and trying again`);
    await run('supabase', ['stop', '--workdir', workdir], { log, timeoutMs: 120_000 });
  }
  const st = await stackStatus(n);
  assertLocalUrl('lane DB_URL', st.db);
  assertLocalUrl('lane API_URL', st.api);
  const psqlEnv = { ...process.env, PGOPTIONS: '-c client_min_messages=warning' };
  // seed.sql aborts unless lp.allow_seed is on; the host checks above are what make that safe (db-reset.sh does the same).
  await must('seed', 'psql', [st.db, '-v', 'ON_ERROR_STOP=1', '-q', '-c', "set lp.allow_seed = 'on'", '-f', join(ROOT, 'supabase', 'seed.sql')], { log, env: psqlEnv });
  // F6: the migrations re-schedule the auto-close job; it must stay paused for the whole run.
  await must('pause lp-close-inactive', 'psql', [st.db, '-v', 'ON_ERROR_STOP=1', '-q', '-c', PAUSE_SQL], { log, env: psqlEnv });
  const paths = await must('seed photo list', 'psql', [st.db, '-At', '-F', '|', '-c', 'select storage_path, coalesce(thumb_path, \'\') from public.patient_photos order by storage_path'], { log, env: psqlEnv });
  const full = readFileSync(join(ROOT, 'supabase', 'seed-photos', 'photo.jpg'));
  const thumb = readFileSync(join(ROOT, 'supabase', 'seed-photos', 'photo_thumb.jpg'));
  const upload = async (path, bytes) => {
    const res = await fetch(`${st.api}/storage/v1/object/patient-photos/${path}`, {
      method: 'POST',
      headers: { apikey: st.secret, Authorization: `Bearer ${st.secret}`, 'Content-Type': 'image/jpeg', 'x-upsert': 'true' },
      body: bytes,
    });
    if (res.status !== 200) throw new Error(`upload of a seed photo to stack s${n} failed with HTTP ${res.status}`);
  };
  for (const line of paths.split('\n')) {
    const [storagePath, thumbPath] = line.split('|');
    if (!storagePath) continue;
    await upload(storagePath, full);
    if (thumbPath) await upload(thumbPath, thumb);
  }
  // The app only talks to PostgREST and Storage through Kong; the auth (GoTrue) container is idle memory.
  if (!opt.keepAuth) await run('docker', ['stop', `supabase_auth_lp-s${n}`], { log, track: false });
  return st;
}

async function prepareLane(lane) {
  const { index, dir, log } = lane;
  const t0 = Date.now();
  const st = await prepareStack(lane);
  lane.stack = st;
  writeLaneEnv(dir, { ...st, port: lane.port, n: lane.n });
  say(`lane ${index + 1}: stack s${lane.n} ready; building`);
  await must('next build', 'node', ['scripts/with-test-env.mjs', 'next', 'build'], { cwd: dir, log, timeoutMs: 10 * 60_000 });
  const serverLog = createWriteStream(join(logDir, `lane${index + 1}-server.log`));
  const server = spawn('node', ['scripts/with-test-env.mjs', 'next', 'start'], {
    cwd: dir,
    env: { ...process.env, PORT: String(lane.port) },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  tracked.add(server);
  server.stdout.pipe(serverLog);
  server.stderr.pipe(serverLog);
  server.on('close', () => tracked.delete(server));
  lane.server = server;
  await waitHttp(`http://127.0.0.1:${lane.port}/signin`);
  lane.setupMs = Date.now() - t0;
  say(`lane ${index + 1}: server up on :${lane.port} (setup ${fmtDuration(lane.setupMs)})`);
}

// --- running a lane -------------------------------------------------------------------------------------------

function laneEnv(lane) {
  const env = { ...process.env, PORT: String(lane.port), SUPABASE_DB_URL: lane.stack.db, FORCE_COLOR: '0' };
  for (const k of ['LP_E2E_LOCK_OWNER', 'LP_E2E_LOCK_DIR', 'NO_COLOR']) delete env[k];
  return env;
}

async function runLane(lane) {
  const t0 = Date.now();
  lane.startedAt = t0;
  lane.tests = [];
  lane.errors = [];
  lane.done = 0;
  const label = `lane ${lane.index + 1}`;
  for (const inv of lane.invocations) {
    const json = join(logDir, `lane${lane.index + 1}-${inv.project}.json`);
    // --output per project: Playwright empties its output folder at the start of a run, which would wipe the first project's failure artefacts.
    const args = ['playwright', 'test', `--project=${inv.project}`, '--reporter=list,json', `--output=${join(lane.dir, `test-results-${inv.project}`)}`, ...inv.patterns, ...playwrightArgs];
    const out = createWriteStream(lane.log, { flags: 'a' });
    out.write(`\n$ npx ${args.join(' ')}\n`);
    const child = spawn(join(lane.dir, 'node_modules', '.bin', 'playwright'), args.slice(1), {
      cwd: lane.dir,
      env: { ...laneEnv(lane), PLAYWRIGHT_JSON_OUTPUT_NAME: json },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    tracked.add(child);
    let pending = '';
    child.stdout.on('data', (d) => {
      out.write(d);
      pending += d;
      let nl;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        if (/^\s+[✓✘-]\s+\d+ \[/.test(line)) lane.done += 1;
        if (/^\s+✘\s+\d+ \[/.test(line)) console.log(`[lane ${lane.index + 1}] ${line.trim().slice(0, 220)}`);
      }
    });
    child.stderr.on('data', (d) => out.write(d));
    const code = await new Promise((resolve) => {
      child.on('close', (c, s) => {
        tracked.delete(child);
        out.end();
        resolve(c ?? (s ? 1 : 0));
      });
    });
    let report = null;
    try {
      report = JSON.parse(readFileSync(json, 'utf8'));
    } catch {
      lane.errors.push(`${label} ${inv.project}: Playwright exited ${code} without a JSON report (see ${lane.log})`);
    }
    if (report) {
      lane.tests.push(...flattenReport(report));
      for (const e of report.errors ?? []) lane.errors.push(`${label} ${inv.project}: ${String(e.message ?? e).split('\n')[0]}`);
    }
  }
  lane.runMs = Date.now() - t0;
  say(`${label}: finished in ${fmtDuration(lane.runMs)}`);
}

// --- main -----------------------------------------------------------------------------------------------------

async function main() {
  const snapshot = opt.plan ? null : await preflight(opt.lanes);

  // 1. One copy of the checkout per lane; the suite is listed from the first one (its env is a placeholder until
  // its stack is up; `--list` never touches a database).
  say(`logs: ${logDir}`);
  const lanes = Array.from({ length: opt.lanes }, (_, index) => ({
    index,
    dir: join(laneRoot, `lane${index + 1}`),
    log: join(logDir, `lane${index + 1}.log`),
  }));
  say('copying the checkout for each lane');
  const copies = opt.plan ? lanes.slice(0, 1) : lanes; // --plan only needs one copy to list the suite from
  await Promise.all(copies.map((lane) => cloneCheckout(lane.dir, join(logDir, 'copy.log'))));
  for (const lane of copies) {
    writeFileSync(join(lane.dir, '.env.test.local'), '# placeholder until the lane stack is up\nSUPABASE_SECRET_KEY=placeholder\nSUPABASE_PUBLISHABLE_KEY=placeholder\n', { mode: 0o600 });
  }
  const listEnv = { ...process.env, FORCE_COLOR: '0' };
  delete listEnv.PLAYWRIGHT_JSON_OUTPUT_NAME;
  const listRaw = await must('playwright --list', join(lanes[0].dir, 'node_modules', '.bin', 'playwright'), ['test', '--list', '--reporter=json', ...playwrightArgs], {
    cwd: lanes[0].dir,
    env: listEnv,
    log: join(logDir, 'list.log'),
  }).catch(() => null);
  if (listRaw === null) throw new Error(`could not list the suite; see ${join(logDir, 'list.log')}`);
  const jsonStart = listRaw.indexOf('{');
  let listed = flattenReport(JSON.parse(listRaw.slice(jsonStart)));
  if (opt.files) {
    const want = new Set(opt.files);
    listed = listed.filter((t) => want.has(t.file));
    for (const f of want) if (!listed.some((t) => t.file === f)) die(`--files: no tests in ${f}`);
  }
  if (listed.length === 0) die('no tests to run');

  // 2. The split.
  let timings = {};
  try {
    timings = JSON.parse(readFileSync(TIMINGS_FILE, 'utf8'));
  } catch {
    // None yet: test counts only.
  }
  const units = weigh([...unitsFrom(listed).values()], timings);
  const plan = partition(units, opt.lanes, PROJECT_ORDER);
  for (const [i, p] of plan.entries()) {
    lanes[i].plan = p;
    lanes[i].invocations = laneInvocations(p);
    lanes[i].expectedTests = p.units.reduce((s, u) => s + u.tests, 0);
  }
  const unmeasured = units.filter((u) => !u.measured).length;
  console.log(`\nSplit: ${listed.length} tests, ${units.length} file×project units (${unmeasured} without a recorded time)`);
  for (const [i, p] of plan.entries()) {
    const per = laneInvocations(p).map((inv) => `${inv.project.replace('-iphone14', '')} ${inv.files.length} files`).join(', ');
    console.log(`  lane ${i + 1}: ~${fmtDuration(p.weight * 1000)} expected, ${lanes[i].expectedTests} tests (${per})`);
  }
  console.log('');
  if (opt.plan) {
    for (const [i, p] of plan.entries()) {
      console.log(`lane ${i + 1}:`);
      for (const u of p.units) console.log(`  ${u.project.replace('-iphone14', '').padEnd(9)} ${u.file.padEnd(34)} ${String(u.tests).padStart(3)} tests  ${u.weight.toFixed(0).padStart(4)}s${u.measured ? '' : ' (est.)'}`);
    }
    await cleanup();
    return 0;
  }
  const active = lanes.filter((l) => l.invocations.length > 0);

  // 3. Stacks, builds and servers, all lanes at once. A lane that cannot be prepared is reported and does not stop the others.
  const ports = await pickPorts(active.length, opt.basePort);
  for (const [i, lane] of active.entries()) {
    lane.port = ports[i];
    const got = await claimStack(`e2e-lanes-${process.pid}-lane${lane.index + 1}`, lane.index + 1);
    const n = got.n;
    claimed.push(n);
    if (got.running) foundRunning.add(n);
    lane.n = n;
    say(`lane ${lane.index + 1}: claimed stack s${n}${got.running ? ' (was running; stays running)' : ''}, app port ${lane.port}`);
  }
  await Promise.all(
    active.map((lane) =>
      prepareLane(lane).catch((error) => {
        lane.prepError = error instanceof Error ? error.message : String(error);
        console.error(`[lane ${lane.index + 1}] setup failed: ${lane.prepError}`);
      }),
    ),
  );

  // 4. Run. Memory snapshot with all stacks up (for the report).
  const dockerNow = await capture('colima', ['ssh', '--', 'cat', '/proc/meminfo'], 20_000);
  const vmNow = parseMeminfo(dockerNow ?? '');
  const hostNow = availableMemoryBytes((await capture('vm_stat', [])) ?? '');
  const GB = 1024 ** 3;
  say(`stacks up: host ${(hostNow / GB).toFixed(1)} GB available, Docker VM ${(vmNow.available / GB).toFixed(1)}/${(vmNow.total / GB).toFixed(1)} GB available, load ${loadavg()[0].toFixed(1)}`);
  const testsStart = Date.now();
  const ready = active.filter((l) => !l.prepError);
  const ticker = setInterval(() => {
    const parts = ready.map((l) => `L${l.index + 1} ${l.done ?? 0}/${l.expectedTests}`);
    say(`progress: ${parts.join('  ')}`);
  }, 60_000);
  await Promise.all(ready.map((lane) => runLane(lane).catch((error) => {
    lane.errors ??= [];
    lane.errors.push(`lane ${lane.index + 1}: ${error instanceof Error ? error.message : String(error)}`);
  })));
  clearInterval(ticker);
  if (cleaning) return 130; // interrupted: the signal handler is cleaning up; no summary of a partial run
  const testsMs = Date.now() - testsStart;

  // 5. Merge and report.
  const ran = lanes.flatMap((l) => (l.tests ?? []).map((t) => ({ ...t, lane: l.index + 1 })));
  const t = tally(ran);
  const cmp = compareRuns(listed, ran);
  const failures = failuresOf(ran);
  const laneErrors = lanes.flatMap((l) => [...(l.prepError ? [`lane ${l.index + 1}: setup failed: ${l.prepError}`] : []), ...(l.errors ?? [])]);
  const totalMs = Date.now() - startedAt;

  const lines = [];
  lines.push('', '═══ e2e lanes: merged summary ═══');
  lines.push(`tests      ${listed.length} listed · ${ran.filter((x) => x.ran).length} run · ${t.passed} passed · ${t.failed} failed · ${t.skipped} skipped${t.other ? ` · ${t.other} not reported` : ''}`);
  lines.push(
    cmp.identical
      ? `coverage   identical to \`playwright test --list\`: every test ran exactly once (${listed.length}, ${new Set(listed.map((x) => x.project)).size} projects)`
      : `coverage   DIFFERS from \`playwright test --list\`: ${cmp.missing.length} missing, ${cmp.duplicated.length} duplicated, ${cmp.unexpected.length} unexpected`,
  );
  for (const k of cmp.missing.slice(0, 20)) lines.push(`  missing     ${k}`);
  for (const k of cmp.duplicated.slice(0, 20)) lines.push(`  duplicated  ${k}`);
  for (const k of cmp.unexpected.slice(0, 20)) lines.push(`  unexpected  ${k}`);
  lines.push(`wall-clock ${fmtDuration(totalMs)} total · ${fmtDuration(testsMs)} testing · ${fmtDuration(testsStart - startedAt)} before the first test (copy, stacks, builds)`);
  for (const l of lanes) {
    if (!l.invocations?.length) continue;
    const mine = ran.filter((x) => x.lane === l.index + 1);
    const lt = tally(mine);
    lines.push(
      `lane ${l.index + 1}     ${l.runMs !== undefined ? fmtDuration(l.runMs) : 'did not run'} (expected ${fmtDuration(l.plan.weight * 1000)}) · ${l.expectedTests} tests · ${lt.passed} passed ${lt.failed} failed ${lt.skipped} skipped · stack s${l.n} :${l.port} · setup ${l.setupMs !== undefined ? fmtDuration(l.setupMs) : 'failed'}`,
    );
  }
  if (failures.length) {
    lines.push('', `failures (${failures.length}):`);
    for (const f of failures) lines.push(`  lane ${f.lane}  ${f.project}  tests/e2e/${f.file}:${f.line}  ${f.title}${f.error ? `\n      ${f.error.slice(0, 200)}` : ''}`);
  }
  for (const e of laneErrors) lines.push(`ERROR ${e}`);
  lines.push('', `logs: ${logDir}`);
  const summary = lines.join('\n');
  console.log(summary);
  writeFileSync(join(logDir, 'summary.txt'), `${summary}\n`);
  writeFileSync(
    join(logDir, 'results.json'),
    JSON.stringify({ tally: t, comparison: cmp, wallMs: totalMs, testsMs, hostAvailableAtStart: snapshot?.hostAvailable, tests: ran }, null, 1),
  );

  // 6. Keep failure artefacts (the lane copies are deleted on exit), and refresh the timings.
  if (failures.length) {
    for (const l of active) {
      for (const project of PROJECT_ORDER) {
        const results = join(l.dir, `test-results-${project}`);
        if (existsSync(results)) cpSync(results, join(logDir, `lane${l.index + 1}-${project}-test-results`), { recursive: true });
      }
    }
  }
  if (cmp.identical && !laneErrors.length && playwrightArgs.length === 0) {
    const next = updateTimings(timings, ran);
    writeFileSync(TIMINGS_FILE, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`timings: ${TIMINGS_FILE} updated`);
  }
  return failures.length || laneErrors.length || !cmp.identical || t.other ? 1 : 0;
}

let code = 1;
try {
  code = await main();
} catch (error) {
  console.error(`e2e-lanes: ${error instanceof Error ? error.message : String(error)}`);
  code = 1;
} finally {
  await cleanup();
}
process.exit(code);
