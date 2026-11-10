// Telemetry can never throw into the app: every handler is wrapped (an error inside never reaches the dispatcher), the
// 20th fault stops the collector, stop takes everything off. And the gate: after the server said off, and in automated
// browsers that did not opt in, the collector never loads; (Events) there is no fixed off date any more.
import { describe, expect, it, vi } from 'vitest';
import { MAX_FAULTS, createGuard } from '@/lib/client/telemetry/host';
import { telemetryAllowed } from '@/lib/client/telemetry-gate';
import { TEL_KEYS } from '@/lib/telemetry';
import { FakeStorage } from './fakes';

describe('the guard', () => {
  it('a handler that throws never escapes to the dispatcher; it is counted', () => {
    const g = createGuard();
    const target = new EventTarget();
    g.on(target, 'x', () => {
      throw new Error('boom');
    });
    expect(() => target.dispatchEvent(new Event('x'))).not.toThrow();
    expect(g.faults).toBe(1);
    const wrapped = g.wrap(() => {
      throw new Error('boom');
    });
    expect(() => wrapped()).not.toThrow();
    expect(g.faults).toBe(2);
  });

  it('listeners are passive and capture by default, and come off at stop', () => {
    const g = createGuard();
    const add = vi.fn();
    const remove = vi.fn();
    const target = { addEventListener: add, removeEventListener: remove } as unknown as EventTarget;
    g.on(target, 'pointerdown', () => undefined);
    g.on(target, 'touchmove', () => undefined, { capture: false });
    expect(add.mock.calls.map((c) => c[2])).toEqual([
      { passive: true, capture: true },
      { passive: true, capture: false },
    ]);
    g.stop();
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it('the 20th fault stops everything; nothing runs after', () => {
    const stopped = vi.fn();
    const g = createGuard(stopped);
    const off = vi.fn();
    g.add(off);
    const fn = vi.fn(() => {
      throw new Error('boom');
    });
    const wrapped = g.wrap(fn);
    for (let i = 0; i < MAX_FAULTS + 5; i += 1) wrapped();
    expect(fn).toHaveBeenCalledTimes(MAX_FAULTS);
    expect(g.alive).toBe(false);
    expect(off).toHaveBeenCalledTimes(1);
    expect(stopped).toHaveBeenCalledTimes(1);
  });
});

describe('the gate', () => {
  const env = (storage: FakeStorage | null, webdriver = false) => ({ storage, webdriver });

  it('(Events) no fixed off date: on past the old auto-off (2026-11-10 06:00 ET) and a year on; a stored lp-tel-until is ignored', () => {
    const s = new FakeStorage();
    s.setItem('lp-tel-until', String(Date.parse('2026-11-09T11:00:00Z')));
    for (const at of ['2026-11-10T11:00:00Z', '2026-11-10T12:00:00Z', '2027-11-10T12:00:00Z']) {
      expect(telemetryAllowed(Date.parse(at), env(new FakeStorage())), at).toBe(true);
      expect(telemetryAllowed(Date.parse(at), env(s)), at).toBe(true);
    }
  });

  it('after the server said off: no until the probe is due', () => {
    const s = new FakeStorage();
    const now = Date.parse('2026-11-09T03:00:00Z');
    s.setItem(TEL_KEYS.off, String(now + 60_000));
    expect(telemetryAllowed(now, env(s))).toBe(false);
    expect(telemetryAllowed(now + 61_000, env(s))).toBe(true);
  });

  it('navigator.webdriver without lp-tel-test = 1: no (the e2e suites stay quiet)', () => {
    const s = new FakeStorage();
    const now = Date.parse('2026-11-09T03:00:00Z');
    expect(telemetryAllowed(now, env(s, true))).toBe(false);
    s.setItem(TEL_KEYS.test, '1');
    expect(telemetryAllowed(now, env(s, true))).toBe(true);
  });

  it('localStorage that can’t be read: no', () => {
    const now = Date.parse('2026-11-09T03:00:00Z');
    expect(telemetryAllowed(now, env(null))).toBe(false);
    const throwing = {
      getItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(telemetryAllowed(now, { storage: throwing, webdriver: false })).toBe(false);
  });
});
