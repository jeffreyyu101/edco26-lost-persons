// F3 write routes notify after the response (brief item 7, contract A "never delays the API response"):
// POST …/messages and POST …/enroute answer first and hand notifyStaff to next/server after(), so a slow
// push (F4's real notifyStaff) never keeps a bubble on "Sending…". The route wrapper, the database and the
// notifier are stubbed; everything else (validation, mapping, the notification detail) is the real code.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const afterTasks: Array<() => unknown> = [];
const notified: Array<{ recipients: readonly string[]; detail: string; kind: string }> = [];
let rpcResult: unknown = null;

vi.mock('next/server', () => ({ after: (task: () => unknown) => void afterTasks.push(task) }));
vi.mock('@/lib/server/supabase', () => ({ rpc: async () => rpcResult }));
vi.mock('@/lib/server/notify', () => ({
  // A notifier that never finishes: if the route awaited it, the response would never come.
  notifyStaff: (recipients: readonly string[], event: { detail: string; kind: string }) => {
    notified.push({ recipients, detail: event.detail, kind: event.kind });
    return new Promise<void>(() => undefined);
  },
}));
vi.mock('@/lib/server/route', () => ({
  authedRoute:
    (_name: string, _opts: unknown, handler: (ctx: unknown) => Promise<Response>) =>
    async (request: Request, ctx: { params: Promise<Record<string, string>> }) =>
      handler({ request, params: await ctx.params, session: { staff: 'Dana Kent · GC/HX - Dispatch', claims: { team: 'GC/HX - Dispatch' } } }),
}));

const ID = '5eed0000-0000-4000-8000-0000000000f3';
const post = (path: string, body: unknown) =>
  new Request(`https://lp.test/api/requests/${ID}/${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
const ctx = { params: Promise.resolve({ id: ID }) };

beforeEach(() => {
  afterTasks.length = 0;
  notified.length = 0;
});

describe('notifications go after the response', () => {
  it('a new message answers 201 before anyone is notified; the notification carries a masked detail', async () => {
    const { POST } = await import('@/app/api/requests/[id]/messages/route');
    rpcResult = {
      created: true,
      message: { id: 'm1', staff: 'Dana Kent · GC/HX - Dispatch', team: 'GC/HX - Dispatch', body: 'Her sister is at 407-555-0199', created_at: '2026-11-07T03:00:00Z', mine: true, client_mutation_id: '5eed0000-0000-4000-8000-0000000000a1' },
      activity: {},
      recipients: ['rae chen · medical'],
    };
    const res = await POST(post('messages', { clientMutationId: '5eed0000-0000-4000-8000-0000000000a1', body: 'Her sister is at 407-555-0199' }), ctx);
    expect(res.status).toBe(201);
    expect(notified).toHaveLength(0);
    expect(afterTasks).toHaveLength(1);
    void afterTasks[0]?.();
    expect(notified).toEqual([{ recipients: ['rae chen · medical'], kind: 'message', detail: 'Dana K.: Her sister is at •••' }]);
  });

  it('a retried message (not created) notifies nobody', async () => {
    const { POST } = await import('@/app/api/requests/[id]/messages/route');
    rpcResult = { created: false, message: { id: 'm1', body: 'x' }, activity: {}, recipients: ['rae chen · medical'] };
    const res = await POST(post('messages', { clientMutationId: '5eed0000-0000-4000-8000-0000000000a1', body: 'x' }), ctx);
    expect(res.status).toBe(200);
    expect(afterTasks).toHaveLength(0);
  });

  it('an en route tap answers first, then notifies', async () => {
    const { POST } = await import('@/app/api/requests/[id]/enroute/route');
    rpcResult = { changed: true, event: 'arrived', activity: {}, recipients: ['rae chen · medical'] };
    const res = await POST(post('enroute', { action: 'arrive' }), ctx);
    expect(res.status).toBe(200);
    expect(notified).toHaveLength(0);
    expect(afterTasks).toHaveLength(1);
    void afterTasks[0]?.();
    expect(notified).toEqual([{ recipients: ['rae chen · medical'], kind: 'arrived', detail: 'Friend arrived' }]);
  });
});
