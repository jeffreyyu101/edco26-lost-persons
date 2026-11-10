// (Phase 3) A lead opening another event (the Events list, the desk switcher: components/events/api.ts openEvent)
// marks it for the app's store (lib/client/signed-in-at.ts) BEFORE loading `/`, so the store starts from that event's
// cache and never shows the previous event's rows while GET /api/session is in flight.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openEvent } from '@/components/events/api';
import { SIGNED_IN_EVENT_KEY } from '@/lib/client/signed-in-at';

let store: Map<string, string>;
let order: string[];

beforeEach(() => {
  store = new Map();
  order = [];
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        order.push(`set ${k}=${v}`);
        store.set(k, v);
      },
      removeItem: (k: string) => void store.delete(k),
    },
    location: { pathname: '/events', search: '', assign: (to: string) => order.push(`assign ${to}`), replace: (to: string) => order.push(`replace ${to}`) },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

describe('openEvent', () => {
  it('marks the opened event, then loads the app', async () => {
    vi.stubGlobal('fetch', answer(200, { role: 'lead', eventId: 'b0000000-0000-4000-8000-000000000002', staffName: 'L', team: 'T', staff: 'l · t' }));
    const res = await openEvent('b0000000-0000-4000-8000-000000000002');
    expect(res.ok).toBe(true);
    expect(order).toEqual([`set ${SIGNED_IN_EVENT_KEY}=b0000000-0000-4000-8000-000000000002`, 'assign /']);
  });

  it('a refused open marks nothing and stays', async () => {
    vi.stubGlobal('fetch', answer(404, { error: { code: 'not_found', message: 'Not found' } }));
    const res = await openEvent('b0000000-0000-4000-8000-000000000003');
    expect(res.ok).toBe(false);
    expect(order).toEqual([]);
    expect(store.has(SIGNED_IN_EVENT_KEY)).toBe(false);
  });
});
