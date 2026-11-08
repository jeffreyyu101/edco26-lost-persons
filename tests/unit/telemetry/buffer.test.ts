// Buffering (lib/client/telemetry/buffer.ts, design §4.4): the 500-event memory ring, aggregates, batch limits, the
// 500-event IndexedDB ring of batches (24 h, oldest first) in its own `lp-tel` database, and cleaning to the schema.
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { EventBuffer, cleanEvent, idbBatchStore, trimStored, type StoredBatch } from '@/lib/client/telemetry/buffer';

const ev = (i: number) => ({ n: 'view' as const, at: 1_000 + i, v: 'all' as const });

describe('memory ring and aggregates', () => {
  it('caps at 500, dropping the oldest', () => {
    const b = new EventBuffer();
    for (let i = 0; i < 520; i += 1) b.push(ev(i));
    expect(b.discrete).toBe(500);
    expect(b.dropped).toBe(20);
    const taken = b.take(1_000, 10_000_000);
    expect(taken[0]?.at).toBe(1_020);
  });

  it('a batch holds ≤ 300 events and ≤ the byte limit; the rest waits', () => {
    const b = new EventBuffer();
    for (let i = 0; i < 400; i += 1) b.push(ev(i));
    expect(b.take()).toHaveLength(300);
    expect(b.discrete).toBe(100);
    const big = new EventBuffer();
    for (let i = 0; i < 400; i += 1) big.push({ n: 'net', at: i, a: '/api/sync:delta', p: { d: Array.from({ length: 120 }, () => 12_345) } });
    const batch = big.take();
    expect(JSON.stringify(batch).length).toBeLessThan(48 * 1024);
    expect(big.discrete).toBeGreaterThan(0);
  });

  it('aggregates are one row per key until taken', () => {
    const b = new EventBuffer();
    for (let i = 0; i < 5; i += 1) b.agg('tap|all|request-list|list.row|touch', () => ({ n: 'tap', at: 1, a: 'request-list', c: 'list.row', k: 0 }), (e) => (e.k = (e.k ?? 0) + 1));
    expect(b.aggregates).toBe(1);
    expect(b.take()).toEqual([expect.objectContaining({ n: 'tap', k: 5 })]);
    expect(b.aggregates).toBe(0);
  });

  it('errors: one per fingerprint until the next send, repeats counted', () => {
    const b = new EventBuffer();
    for (let i = 0; i < 3; i += 1) b.pushError('abcd1234', { n: 'error', at: i, c: 'typeerror', p: { type: 'typeerror', fp: 'abcd1234' } });
    const [e] = b.take();
    expect(e).toEqual(expect.objectContaining({ n: 'error', k: 3 }));
    b.pushError('abcd1234', { n: 'error', at: 9, c: 'typeerror' });
    expect(b.take()[0]?.k).toBe(1);
  });

  it('cleanEvent drops what the schema would refuse', () => {
    expect(
      cleanEvent({
        n: 'tap',
        at: 1.4,
        a: 'Quorra Zyxwvut',
        c: 'ok-token',
        ms: -5,
        k: 1e9,
        p: { ptr: 'touch', nope: 1, kind: 'Has Spaces', d: [1, 2], ok: true } as never,
        tr: [[-1, 'v>all'], [5, 'bad'], [-2, 'Bad Token']],
      }),
    ).toEqual({ n: 'tap', at: 1, c: 'ok-token', ms: 0, k: 100_000, p: { ptr: 'touch', d: [1, 2], ok: true }, tr: [[-1, 'v>all']] });
  });
});

describe('the IndexedDB ring', () => {
  const batch = (b: string, at: number, n = 10, tries = 0): StoredBatch => ({ b, s: 'sess000001', ev: Array.from({ length: n }, (_, i) => ev(i)), tries, at, next: 0 });

  it('keeps ≤ 500 events (oldest batches dropped first) and nothing older than 24 h', () => {
    const now = 100 * 3_600_000;
    const list = [batch('old0000001', now - 25 * 3_600_000), batch('aaaaaaaa01', now - 1_000, 300), batch('aaaaaaaa02', now - 500, 150), batch('aaaaaaaa03', now - 100, 100), batch('tried00001', now, 5, 3)];
    const { keep, drop } = trimStored(list, now);
    expect(keep.map((b) => b.b)).toEqual(['aaaaaaaa02', 'aaaaaaaa03']);
    expect(drop.sort()).toEqual(['aaaaaaaa01', 'old0000001', 'tried00001']);
  });

  it('its own database (lp-tel / q), separate from the store’s lp-client; put, all, del, clear', async () => {
    const store = await idbBatchStore(indexedDB);
    expect(store).not.toBeNull();
    await store!.put(batch('bbbbbbbb01', 1));
    await store!.put(batch('bbbbbbbb02', 2));
    expect((await store!.all()).map((b) => b.b).sort()).toEqual(['bbbbbbbb01', 'bbbbbbbb02']);
    await store!.del(['bbbbbbbb01']);
    expect((await store!.all()).map((b) => b.b)).toEqual(['bbbbbbbb02']);
    const dbs = await indexedDB.databases();
    expect(dbs.map((d) => d.name)).toContain('lp-tel');
    expect(dbs.map((d) => d.name)).not.toContain('lp-client');
    await store!.clear();
    expect(await store!.all()).toEqual([]);
  });

  it('no IndexedDB: no store (telemetry goes on in memory)', async () => {
    expect(await idbBatchStore(null)).toBeNull();
  });
});
