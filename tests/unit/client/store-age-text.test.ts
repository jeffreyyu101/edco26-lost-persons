// Age became free text on 2026-11-06 (Jeffrey). A phone that had the app open before the deploy keeps rows
// with a numeric age (24) in IndexedDB, and the smallint → text ALTER bumps no row_version, so sync never
// resends them. The real store must text them on the way in, so search (and everything else) only ever
// sees a string. Synthetic data only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestSummary } from '@/lib/api-types';
import { K, openKv } from '@/lib/client/persist';
import { searchRequests } from '@/lib/client/selectors';
import { createAppStore } from '@/lib/client/store-core';
import { advance, fakeEnv, settle, useStoreTimers, type EnvOptions } from './helpers/env';
import { FakeServer, makeRow } from './helpers/fake-server';

const TZ = 'America/New_York';
const STAFF_KEY = 'dana kim · gc/hx - dispatch';
const stops: Array<() => void> = [];

/** A row as the old build stored and served it: `age` a number. */
const legacy = (n: number, age: number) => makeRow(n, { age: age as unknown as string });

function boot(server: FakeServer, opts: EnvOptions = {}) {
  const fe = fakeEnv(server, opts);
  const store = createAppStore({ eventTimezone: TZ, env: () => fe.env });
  const stop = store.start?.() ?? (() => {});
  stops.push(stop);
  return { store, fe, stop, s: () => store.getState() };
}

async function ready() {
  await settle();
  await advance(0);
  await advance(50);
}

const ages = (rows: Iterable<RequestSummary>) => [...rows].map((r) => r.age);

beforeEach(() => {
  useStoreTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await settle(10);
});

describe('numeric ages from before the free-text change', () => {
  it('rows the old server answered with a number are stored as text', async () => {
    const server = new FakeServer([legacy(1, 24), legacy(2, 0), makeRow(3, { age: null })]);
    const { s } = boot(server);
    await ready();
    expect(ages(s().confirmed.values()).sort()).toEqual(['0', '24', null].sort());
    expect(() => searchRequests([...s().confirmed.values()], 'zebra')).not.toThrow();
  });

  it('a cache written by the old build (numeric ages, recent cursor, delta sync resends nothing) is texted on load', async () => {
    const server = new FakeServer([makeRow(1), makeRow(2)]);
    const first = boot(server);
    await ready();
    await advance(3_500);
    first.stop();
    // The cache as the old client left it, and a cursor well inside the 6 h full-fetch window.
    const kv = openKv(first.fe.dbName);
    await kv?.set(K.rows(STAFF_KEY), [legacy(1, 24), legacy(2, 31)]);

    server.overlap = 0; // the delta resends nothing: only the cache holds these rows' ages
    const second = boot(server, { dbName: first.fe.dbName });
    await ready();
    const sinces = server.requests('GET', '/api/sync').map((r) => r.query.get('since'));
    expect(sinces.at(-1)).not.toBeNull(); // a delta sync, not a full fetch
    expect(ages(second.s().confirmed.values()).sort()).toEqual(['24', '31']);
    expect(() => searchRequests([...second.s().confirmed.values()], 'zebra')).not.toThrow();
    expect(searchRequests([...second.s().confirmed.values()], 'zebra')).toEqual([]);
  });
});
