// The pure parts of scripts/e2e-lanes.mjs (the parallel e2e runner): reading Playwright's JSON, the split into
// lanes, merging and comparing runs, timings, and the resource preflight. No processes, no database.
import { describe, expect, it } from 'vitest';
import {
  availableMemoryBytes,
  compareRuns,
  dockerUsedBytes,
  failuresOf,
  filePattern,
  flattenReport,
  fmtDuration,
  laneInvocations,
  parseMeminfo,
  parseSize,
  partition,
  resourceProblems,
  stackAfterRun,
  stackClaimOrder,
  tally,
  testKey,
  unitsFrom,
  updateTimings,
  weigh,
  type FlatTest,
} from '../../scripts/e2e-lanes-lib.mjs';

const CH = 'chromium-iphone14';
const WK = 'webkit-iphone14';

const test = (over: Partial<FlatTest>): FlatTest => ({
  project: CH,
  file: 'a.spec.ts',
  line: 1,
  title: 't',
  status: 'passed',
  ran: true,
  outcome: 'expected',
  durationMs: 1000,
  error: '',
  ...over,
});

const report = {
  suites: [
    {
      title: 'a.spec.ts',
      file: 'a.spec.ts',
      specs: [{ title: 'top', file: 'a.spec.ts', line: 3, tests: [{ projectName: CH, status: 'expected', results: [{ status: 'passed', duration: 1500 }] }] }],
      suites: [
        {
          title: 'group',
          file: 'a.spec.ts',
          specs: [
            {
              title: 'nested',
              file: 'a.spec.ts',
              line: 9,
              tests: [
                { projectName: CH, status: 'unexpected', results: [{ status: 'failed', duration: 2000, error: { message: '\u001b[31mExpected 1\u001b[39m\nReceived 2' } }] },
                { projectName: WK, status: 'skipped', results: [{ status: 'skipped', duration: 0 }] },
              ],
            },
          ],
        },
      ],
    },
  ],
};

describe('flattenReport', () => {
  it('flattens files, describes and projects, with titles, status, duration and the first error line', () => {
    const t = flattenReport(report);
    expect(t.map((x) => [x.project, x.file, x.line, x.title, x.status])).toEqual([
      [CH, 'a.spec.ts', 3, 'top', 'passed'],
      [CH, 'a.spec.ts', 9, 'group › nested', 'failed'],
      [WK, 'a.spec.ts', 9, 'group › nested', 'skipped'],
    ]);
    expect(t[1]?.error).toBe('Expected 1');
    expect(t[0]?.durationMs).toBe(1500);
  });

  it('marks a listed-only test (no attempts) as not run', () => {
    const listed = { suites: [{ title: 'a.spec.ts', file: 'a.spec.ts', specs: [{ title: 'x', file: 'a.spec.ts', line: 1, tests: [{ projectName: CH, status: 'skipped', results: [] }] }] }] };
    const [t] = flattenReport(listed);
    expect(t?.ran).toBe(false);
    expect(tally([t as FlatTest]).other).toBe(1);
  });
});

describe('tally and failuresOf', () => {
  const tests = flattenReport(report);
  it('counts passed, failed and skipped', () => {
    expect(tally(tests)).toEqual({ total: 3, passed: 1, failed: 1, skipped: 1, other: 0 });
  });
  it('lists only failed tests (not skipped ones)', () => {
    expect(failuresOf(tests).map(testKey)).toEqual([`${CH}|a.spec.ts:9|group › nested`]);
  });
  it('counts a flaky test (passed on retry) as passed', () => {
    expect(tally([test({ outcome: 'flaky' })]).passed).toBe(1);
    expect(failuresOf([test({ outcome: 'flaky' })])).toEqual([]);
  });
});

describe('partition', () => {
  const mk = (file: string, project: string, tests: number, weight: number) => ({ id: `${file}|${project}`, file, project, tests, weight, measured: true });
  const units = [mk('a', CH, 5, 100), mk('b', CH, 5, 90), mk('c', CH, 5, 60), mk('d', WK, 5, 50), mk('e', WK, 5, 40), mk('f', WK, 5, 10), mk('a', WK, 5, 95)];

  it('puts every unit in exactly one lane', () => {
    const lanes = partition(units, 3, [CH, WK]);
    const ids = lanes.flatMap((l) => l.units.map((u) => u.id)).sort();
    expect(ids).toEqual(units.map((u) => u.id).sort());
  });

  it('balances the weights within the largest single unit', () => {
    const lanes = partition(units, 3, [CH, WK]);
    const w = lanes.map((l) => l.weight);
    expect(Math.max(...w) - Math.min(...w)).toBeLessThanOrEqual(100);
    expect(lanes.map((l) => l.units.reduce((s, u) => s + u.weight, 0))).toEqual(w);
  });

  it('is deterministic and keeps project order, then file order, inside a lane', () => {
    const a = partition(units, 2, [CH, WK]);
    expect(partition([...units].reverse(), 2, [CH, WK])).toEqual(a);
    for (const lane of a) {
      const keys = lane.units.map((u) => `${u.project === CH ? 0 : 1}${u.file}`);
      expect(keys).toEqual([...keys].sort());
    }
  });

  it('gives one lane per project invocation, with anchored file patterns', () => {
    const lane = partition(units, 1, [CH, WK])[0]!;
    const inv = laneInvocations(lane);
    expect(inv.map((i) => i.project)).toEqual([CH, WK]);
    expect(inv[0]?.files).toEqual(['a', 'b', 'c']);
  });

  it('still works with more lanes than units', () => {
    const lanes = partition(units.slice(0, 2), 4, [CH, WK]);
    expect(lanes.filter((l) => l.units.length === 0)).toHaveLength(2);
  });
});

describe('filePattern', () => {
  it('matches that spec file and no other', () => {
    const re = new RegExp(filePattern('signin.spec.ts'));
    expect(re.test('/repo/tests/e2e/signin.spec.ts')).toBe(true);
    expect(re.test('/repo/tests/e2e/signin-desktop.spec.ts')).toBe(false);
    expect(re.test('/repo/tests/e2e/new-signin.spec.ts')).toBe(false);
    expect(re.test('/repo/tests/e2e/signinXspec.ts')).toBe(false);
  });
});

describe('weigh', () => {
  const u = (file: string, tests: number) => ({ id: `${file}|${CH}`, file, project: CH, tests });
  it('uses a recorded time, else test count times the average seconds per test', () => {
    const w = weigh([u('a', 10), u('b', 5), u('c', 4)], { [`a|${CH}`]: 20, [`b|${CH}`]: 10 });
    expect(w.map((x) => [x.file, x.weight, x.measured])).toEqual([['a', 20, true], ['b', 10, true], ['c', 8, false]]);
  });
  it('falls back to counts alone when nothing is recorded', () => {
    expect(weigh([u('a', 3)], {})[0]?.weight).toBe(3);
  });
  it('unitsFrom counts tests per file and project', () => {
    const m = unitsFrom([test({}), test({ line: 2 }), test({ project: WK })]);
    expect([...m.values()].map((x) => x.tests)).toEqual([2, 1]);
  });
});

describe('compareRuns', () => {
  const listed = [test({ line: 1 }), test({ line: 2 }), test({ line: 2, project: WK })];
  it('is identical when every listed test ran once', () => {
    expect(compareRuns(listed, [...listed].reverse()).identical).toBe(true);
  });
  it('reports a missing, a duplicated and an unexpected test', () => {
    const ran = [test({ line: 1 }), test({ line: 1 }), test({ line: 2, project: WK }), test({ line: 99 })];
    const r = compareRuns(listed, ran);
    expect(r.missing).toEqual([testKey(test({ line: 2 }))]);
    expect(r.duplicated).toEqual([testKey(test({ line: 1 }))]);
    expect(r.unexpected).toEqual([testKey(test({ line: 99 }))]);
    expect(r.identical).toBe(false);
  });
  it('does not count a test that was listed but never reported as run', () => {
    expect(compareRuns(listed, [test({ line: 1 }), test({ line: 2 }), test({ line: 2, project: WK, ran: false })]).missing).toHaveLength(1);
  });
});

describe('updateTimings', () => {
  it('records seconds per file and project, keeps others, skips units with a failure or an unreported test', () => {
    const next = updateTimings(
      { [`old|${CH}`]: 5, [`bad|${CH}`]: 7, [`gone|${CH}`]: 9 },
      [
        test({ file: 'ok', durationMs: 1200 }),
        test({ file: 'ok', line: 2, durationMs: 800 }),
        test({ file: 'bad', durationMs: 60_000, status: 'failed', outcome: 'unexpected' }),
        test({ file: 'gone', ran: false, status: 'listed', durationMs: 0 }),
      ],
    );
    expect(next).toEqual({ [`bad|${CH}`]: 7, [`gone|${CH}`]: 9, [`ok|${CH}`]: 2, [`old|${CH}`]: 5 });
  });
});

describe('preflight numbers', () => {
  const GB = 1024 ** 3;
  it('reads vm_stat', () => {
    const vm = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:   100.\nPages active:  999.\nPages inactive:  200.\nPages speculative:   10.\nPages purgeable:   5.\n';
    expect(availableMemoryBytes(vm)).toBe(315 * 16384);
  });
  it('reads /proc/meminfo and docker sizes', () => {
    expect(parseMeminfo('MemTotal:        6053088 kB\nMemAvailable:    4419724 kB\n')).toEqual({ total: 6053088 * 1024, available: 4419724 * 1024 });
    expect(parseSize('221.5MiB')).toBe(221.5 * 1024 ** 2);
    expect(dockerUsedBytes('10MiB / 5.7GiB\n1GiB / 5.7GiB')).toBe(10 * 1024 ** 2 + GB);
  });
  const ok = { hostAvailable: 8 * GB, vmTotal: 6 * GB, vmAvailable: 4 * GB, diskFree: 30 * GB, lanes: 3, newStacks: 3 };
  it('goes when there is room', () => {
    expect(resourceProblems(ok)).toEqual([]);
  });
  it('refuses with a clear message for each shortage', () => {
    expect(resourceProblems({ ...ok, hostAvailable: 3 * GB })[0]).toMatch(/free memory on this Mac/);
    expect(resourceProblems({ ...ok, vmAvailable: 1 * GB })[0]).toMatch(/Docker VM/);
    expect(resourceProblems({ ...ok, diskFree: 2 * GB })[0]).toMatch(/free disk/);
    expect(resourceProblems({ hostAvailable: 0, vmTotal: 6 * GB, vmAvailable: 0, diskFree: 0, lanes: 3, newStacks: 3 })).toHaveLength(3);
  });
});

describe('fmtDuration', () => {
  it('formats seconds and minutes', () => {
    expect(fmtDuration(45_200)).toBe('45.2s');
    expect(fmtDuration(723_000)).toBe('12m 03s');
  });
});

describe('stackClaimOrder and stackAfterRun (a stack is left as it was found)', () => {
  const now = 1_800_000_000_000;
  it('tries free stopped stacks first, then free running ones; claimed ones never, unless the claim is over 3 h old', () => {
    const order = stackClaimOrder(
      [
        { n: 5, running: true, claimedAtMs: null },
        { n: 2, running: true, claimedAtMs: now - 60_000 },
        { n: 7, running: false, claimedAtMs: null },
        { n: 3, running: false, claimedAtMs: null },
        { n: 4, running: false, claimedAtMs: now - 4 * 3600_000 },
        { n: 6, running: true, claimedAtMs: now - 3600_000 },
      ],
      now,
    );
    expect(order).toEqual([
      { n: 3, running: false, stale: false },
      { n: 4, running: false, stale: true },
      { n: 7, running: false, stale: false },
      { n: 5, running: true, stale: false },
    ]);
  });
  it('offers a running unclaimed stack when it is the only free one', () => {
    expect(stackClaimOrder([{ n: 5, running: true, claimedAtMs: null }, { n: 2, running: false, claimedAtMs: now }], now)).toEqual([{ n: 5, running: true, stale: false }]);
    expect(stackClaimOrder([{ n: 2, running: false, claimedAtMs: now }], now)).toEqual([]);
  });
  it('a stack that was running stays running; one that was stopped is stopped unless --keep-stacks', () => {
    expect(stackAfterRun(true, false)).toBe('leave-running');
    expect(stackAfterRun(true, true)).toBe('leave-running');
    expect(stackAfterRun(false, false)).toBe('stop');
    expect(stackAfterRun(false, true)).toBe('leave-running');
  });
});
