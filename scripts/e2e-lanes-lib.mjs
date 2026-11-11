// Pure logic for scripts/e2e-lanes.mjs (no I/O, no processes): reading Playwright's JSON, splitting the suite into
// lanes, merging the lane results, comparing them with the full test list, and parsing the resource numbers the
// preflight checks. Unit tests: tests/unit/e2e-lanes.test.ts. Types: scripts/e2e-lanes-lib.d.mts.

/** Strips ANSI colour codes. */
export function stripAnsi(text) {
  return String(text).replace(/\u001b\[[0-9;]*m/g, '');
}

/** The identity of one test: project, spec file (relative to testDir), line, full title. */
export function testKey(t) {
  return `${t.project}|${t.file}:${t.line}|${t.title}`;
}

/**
 * Flattens a Playwright JSON report (`--reporter=json`, also `--list --reporter=json`) into one entry per test.
 * `status` is the outcome of the last attempt: passed | failed | timedOut | interrupted | skipped | listed.
 * `durationMs` sums every attempt. Runs of the same test are not merged here.
 */
export function flattenReport(report) {
  const out = [];
  // Top-level suites are spec files (no title part); nested ones are describe blocks.
  const walk = (suite, titles, top) => {
    const here = top ? titles : [...titles, suite.title].filter(Boolean);
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const results = test.results ?? [];
        const last = results[results.length - 1];
        const status = last ? last.status : 'listed'; // 'listed': no attempt was reported (a --list, or never reached)
        const err = last?.error?.message ?? last?.errors?.[0]?.message ?? '';
        out.push({
          project: test.projectName,
          file: spec.file ?? suite.file,
          line: spec.line,
          title: [...here, spec.title].join(' › '),
          status,
          ran: results.length > 0,
          outcome: test.status, // expected | unexpected | flaky | skipped (Playwright's own verdict)
          durationMs: results.reduce((sum, r) => sum + (r.duration ?? 0), 0),
          error: stripAnsi(err).split('\n').find((l) => l.trim()) ?? '',
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, here, false);
  };
  for (const suite of report.suites ?? []) walk(suite, [], true);
  return out;
}

/** `file|project` — the unit a lane runs. */
export const unitId = (file, project) => `${file}|${project}`;

/** Test counts per unit from a flattened list: Map<unitId, {file, project, tests}>. */
export function unitsFrom(tests) {
  const units = new Map();
  for (const t of tests) {
    const id = unitId(t.file, t.project);
    const u = units.get(id) ?? { id, file: t.file, project: t.project, tests: 0 };
    u.tests += 1;
    units.set(id, u);
  }
  return units;
}

/**
 * Weight (expected seconds) of every unit: its recorded seconds when there is one, else its test count times the
 * average seconds-per-test of the recorded units (1 s per test when nothing is recorded).
 */
export function weigh(units, timings) {
  let seconds = 0;
  let count = 0;
  for (const u of units) {
    const s = timings[u.id];
    if (typeof s === 'number' && s > 0) {
      seconds += s;
      count += u.tests;
    }
  }
  const perTest = count > 0 ? seconds / count : 1;
  return units.map((u) => {
    const s = timings[u.id];
    return typeof s === 'number' && s > 0 ? { ...u, weight: s, measured: true } : { ...u, weight: u.tests * perTest, measured: false };
  });
}

/**
 * Longest-processing-time-first split of weighed units into `lanes` lanes. Deterministic. Each lane keeps its units in
 * `order` (project order, then spec-file order), so a file runs in its own order exactly as a single run does.
 * @param {{id:string,file:string,project:string,tests:number,weight:number}[]} units
 * @param {number} lanes
 * @param {string[]} projectOrder
 */
export function partition(units, lanes, projectOrder) {
  const out = Array.from({ length: lanes }, () => ({ units: [], weight: 0 }));
  const sorted = [...units].sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : 1));
  for (const u of sorted) {
    let best = out[0];
    for (const lane of out) if (lane.weight < best.weight) best = lane;
    best.units.push(u);
    best.weight += u.weight;
  }
  const rank = (p) => {
    const i = projectOrder.indexOf(p);
    return i < 0 ? projectOrder.length : i;
  };
  for (const lane of out) {
    lane.units.sort((a, b) => rank(a.project) - rank(b.project) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  }
  return out;
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Playwright file arguments are regexes on the path: one anchored pattern per spec file. */
export function filePattern(file) {
  return `[/\\\\]${escapeRegex(file).replace(/\//g, '[/\\\\]')}$`;
}

/** The invocations a lane makes: one per project, in project order, each with its spec files. */
export function laneInvocations(lane) {
  const byProject = new Map();
  for (const u of lane.units) {
    const files = byProject.get(u.project) ?? [];
    files.push(u.file);
    byProject.set(u.project, files);
  }
  return [...byProject].map(([project, files]) => ({ project, files, patterns: files.map(filePattern) }));
}

/** Summary counts of flattened tests. `flaky` (passed on a retry) counts as passed; retries are 0 in this suite. */
export function tally(tests) {
  const t = { total: tests.length, passed: 0, failed: 0, skipped: 0, other: 0 };
  for (const x of tests) {
    if (!x.ran) t.other += 1; // listed but never reported
    else if (x.status === 'skipped') t.skipped += 1;
    else if (x.outcome === 'expected' || x.outcome === 'flaky' || (x.outcome === undefined && x.status === 'passed')) t.passed += 1;
    else if (x.status === 'failed' || x.status === 'timedOut' || x.outcome === 'unexpected') t.failed += 1;
    else t.other += 1; // interrupted / never reported
  }
  return t;
}

/** Tests that did not pass, for the failure list. */
export const failuresOf = (tests) => tests.filter((x) => x.ran && x.status !== 'skipped' && x.outcome !== 'expected' && x.outcome !== 'flaky' && !(x.outcome === undefined && x.status === 'passed'));

/**
 * Compares what the lanes ran with the full list. Returns the keys that are missing (listed, not run), duplicated
 * (run more than once) and unexpected (run, not listed).
 */
export function compareRuns(listed, ran) {
  const count = (arr) => {
    const m = new Map();
    for (const t of arr) m.set(testKey(t), (m.get(testKey(t)) ?? 0) + 1);
    return m;
  };
  const want = count(listed);
  const got = count(ran.filter((t) => t.ran));
  const missing = [];
  const duplicated = [];
  const unexpected = [];
  for (const [k, n] of want) {
    const g = got.get(k) ?? 0;
    if (g === 0) missing.push(k);
    else if (g > n) duplicated.push(k);
    else if (g < n) missing.push(k);
  }
  for (const k of got.keys()) if (!want.has(k)) unexpected.push(k);
  return { missing, duplicated, unexpected, identical: !missing.length && !duplicated.length && !unexpected.length };
}

/**
 * New timings after a run: seconds per unit from the tests that ran, for units whose tests all ran and none failed (a
 * failed test's time is a timeout, not the spec's cost). Other units keep their old value.
 */
export function updateTimings(old, ran, round = 1) {
  const next = { ...old };
  const by = new Map();
  for (const t of ran) {
    const id = unitId(t.file, t.project);
    const u = by.get(id) ?? { ms: 0, bad: false };
    u.ms += t.durationMs;
    if (!t.ran) u.bad = true;
    if (t.status !== 'skipped' && (t.outcome === 'unexpected' || t.status === 'failed' || t.status === 'timedOut' || t.status === 'interrupted')) u.bad = true;
    by.set(id, u);
  }
  const f = 10 ** round;
  for (const [id, u] of by) if (!u.bad) next[id] = Math.max(0.1, Math.round((u.ms / 1000) * f) / f);
  return Object.fromEntries(Object.entries(next).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** "12m 03s" / "45.2s". */
export function fmtDuration(ms) {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.round(s - m * 60)).padStart(2, '0')}s`;
}

// --- resource preflight ---------------------------------------------------------------------------------------

/** macOS `vm_stat` → bytes that can be handed out without swapping: free + inactive + speculative + purgeable. */
export function availableMemoryBytes(vmStat) {
  const page = Number(/page size of (\d+) bytes/.exec(vmStat)?.[1] ?? 16384);
  const pages = (label) => Number(new RegExp(`^${label}:\\s+(\\d+)`, 'm').exec(vmStat)?.[1] ?? 0);
  return (pages('Pages free') + pages('Pages inactive') + pages('Pages speculative') + pages('Pages purgeable')) * page;
}

const UNIT = { b: 1, kb: 1e3, kib: 1024, mb: 1e6, mib: 1024 ** 2, gb: 1e9, gib: 1024 ** 3, tb: 1e12, tib: 1024 ** 4 };
/** "221.5MiB" → bytes. */
export function parseSize(text) {
  const m = /^\s*([\d.]+)\s*([a-zA-Z]+)\s*$/.exec(text);
  if (!m) return 0;
  return Number(m[1]) * (UNIT[m[2].toLowerCase()] ?? 1);
}

/** `docker stats --no-stream --format '{{.MemUsage}}'` lines ("221.5MiB / 5.773GiB") → total used bytes. */
export function dockerUsedBytes(lines) {
  return lines
    .split('\n')
    .map((l) => l.split('/')[0] ?? '')
    .reduce((sum, part) => sum + parseSize(part), 0);
}

/** Linux /proc/meminfo → { total, available } in bytes (the Docker VM). */
export function parseMeminfo(text) {
  const kb = (label) => Number(new RegExp(`^${label}:\\s+(\\d+)\\s*kB`, 'm').exec(text)?.[1] ?? 0) * 1024;
  return { total: kb('MemTotal'), available: kb('MemAvailable') };
}

/**
 * Whether to start. Pure so it can be tested: returns the list of problems (empty = go).
 * @param {{hostAvailable:number, vmTotal:number, vmAvailable:number, diskFree:number, lanes:number, newStacks:number}} r
 * @param {{perLaneHost?:number, hostReserve?:number, perStackVm?:number, vmReserve?:number, minDisk?:number}} [limits]
 */
export function resourceProblems(r, limits = {}) {
  const GB = 1024 ** 3;
  const perLaneHost = limits.perLaneHost ?? 1.0 * GB; // a browser, a Next server and the runner's node processes
  const hostReserve = limits.hostReserve ?? 1.5 * GB;
  const perStackVm = limits.perStackVm ?? 0.7 * GB; // db + rest + storage + kong (auth is stopped)
  const vmReserve = limits.vmReserve ?? 0.5 * GB;
  const minDisk = limits.minDisk ?? 8 * GB;
  const problems = [];
  const needHost = r.lanes * perLaneHost + hostReserve;
  if (r.hostAvailable < needHost) {
    problems.push(`not enough free memory on this Mac: ${(r.hostAvailable / GB).toFixed(1)} GB available, ${(needHost / GB).toFixed(1)} GB needed for ${r.lanes} lanes`);
  }
  const needVm = r.newStacks * perStackVm + vmReserve;
  const vmFree = r.vmAvailable;
  if (r.newStacks > 0 && vmFree < needVm) {
    problems.push(`not enough free memory in the Docker VM: ${(vmFree / GB).toFixed(1)} GB free of ${(r.vmTotal / GB).toFixed(1)} GB, ${(needVm / GB).toFixed(1)} GB needed to start ${r.newStacks} Supabase stack(s)`);
  }
  if (r.diskFree < minDisk) {
    problems.push(`not enough free disk: ${(r.diskFree / GB).toFixed(1)} GB free, ${(minDisk / GB).toFixed(1)} GB needed`);
  }
  return problems;
}

/**
 * The stacks a lane may claim, in the order to try them: free (unclaimed) and stopped first, then free but running
 * (someone may be using it without a claim: only when nothing else is free). A claim older than `staleMs` counts as
 * free, as in ~/.config/lp-stacks/claim.sh. Each entry says whether the stack was running when found, so the run can
 * leave it that way.
 */
export function stackClaimOrder(stacks, nowMs, staleMs = 3 * 3600_000) {
  const free = stacks.filter((s) => s.claimedAtMs === null || nowMs - s.claimedAtMs > staleMs);
  const byN = (a, b) => a.n - b.n;
  return [...free.filter((s) => !s.running).sort(byN), ...free.filter((s) => s.running).sort(byN)].map((s) => ({
    n: s.n,
    running: s.running,
    stale: s.claimedAtMs !== null,
  }));
}

/** What to do with a claimed stack at the end of a run: leave it as it was found (running stays running). */
export function stackAfterRun(foundRunning, keepStacks) {
  return foundRunning || keepStacks ? 'leave-running' : 'stop';
}
