// push_send rows (design §3 "Server-side push events"): deliver() (lib/server/notify.ts) with web-push mocked writes one
// row per team of the devices it pushed to, with ok / gone / failed counts and the round's duration, and nothing
// else of them; with collection off it writes nothing and still delivers. Synthetic staff only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { admin, api, cookieFor, createRequest, newStaff, psql, staffOf, withTestServer, type Staff } from './harness';

const mock = vi.hoisted(() => ({ sent: [] as string[], status: new Map<string, number>() }));

vi.mock('web-push', () => ({
  default: {
    sendNotification: (sub: { endpoint: string }) => {
      mock.sent.push(sub.endpoint);
      const status = mock.status.get(sub.endpoint) ?? 201;
      if (status >= 200 && status < 300) return Promise.resolve({ statusCode: status, body: '', headers: {} });
      return Promise.reject(Object.assign(new Error('push failed'), { statusCode: status }));
    },
  },
}));

const { notifyStaff } = await import('@/lib/server/notify');
const { resetTelemetryConfigCache } = await import('@/lib/server/telemetry');

withTestServer();

async function device(staff: Staff, tag: string): Promise<string> {
  const endpoint = `https://fcm.googleapis.com/fcm/send/test-tel-${tag}-${crypto.randomUUID()}`;
  const res = await api('/api/push/subscribe', { json: { endpoint, keys: { p256dh: 'BPfakekeyfakekeyfakekeyfakekey', auth: 'fakeauthfake' } }, cookie: await cookieFor(staff) });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return endpoint;
}

const pushRows = (since: string) =>
  psql(`select coalesce(string_agg(team || ':' || (props->>'kind') || ':' || (props->>'ok') || '/' || (props->>'gone') || '/' || (props->>'failed') || ':' || n, ',' order by team), '')
        from public.lp_tel_events where name = 'push_send' and device = 'server' and received_at > '${since}' and props->>'kind' = 'in_medical'`);

/** deliver() runs on after the caller's 1.5 s bound: wait for its rows. */
async function eventuallyRows(since: string, want: string): Promise<string> {
  let got = '';
  for (let i = 0; i < 40; i += 1) {
    got = pushRows(since);
    if (got === want) return got;
    await new Promise((r) => setTimeout(r, 250));
  }
  return got;
}

beforeEach(() => {
  mock.sent.length = 0;
  mock.status.clear();
  resetTelemetryConfigCache();
});

afterAll(async () => {
  psql(`update public.lp_tel_settings set enabled = true, updated_at = now()`);
  for (const table of ['lp_activity', 'lp_push_subscriptions', 'lp_push_prefs'] as const) {
    const { error } = await admin().from(table).delete().like('staff', 'test-s staff %');
    if (error) throw new Error(`cleanup ${table}: ${error.code}`);
  }
});

describe('push_send', () => {
  it('one row per team pushed to, with the counts; no staff, endpoint or request id in it', async () => {
    const since = psql('select now()::text');
    const dana = newStaff('GC/HX - Dispatch');
    const rae = newStaff('Medical');
    const ok = await device(dana, 'ok');
    const gone = await device(dana, 'gone');
    const medic = await device(rae, 'medic');
    mock.status.set(gone, 410);
    const r = await createRequest(dana);
    await notifyStaff([staffOf(dana), staffOf(rae)], { requestId: r.id, kind: 'in_medical', actor: staffOf(newStaff('Medical')), detail: 'Located' });
    expect(await eventuallyRows(since, 'dispatch:in_medical:1/1/0:2,medical:in_medical:1/0/0:1')).toBe('dispatch:in_medical:1/1/0:2,medical:in_medical:1/0/0:1');
    expect(mock.sent).toEqual(expect.arrayContaining([ok, gone, medic]));
    const text = psql(`select string_agg(props::text, ' ') from public.lp_tel_events where name = 'push_send' and received_at > '${since}'`);
    expect(text).not.toContain(r.id);
    expect(text).not.toMatch(/fcm|test-s/i);
  });

  it('with collection off: still delivered, nothing written', async () => {
    psql(`update public.lp_tel_settings set enabled = false, updated_at = now()`);
    try {
      const since = psql('select now()::text');
      const dana = newStaff('GC/HX - Dispatch');
      const ep = await device(dana, 'off');
      const r = await createRequest(dana);
      await notifyStaff([staffOf(dana)], { requestId: r.id, kind: 'in_medical', actor: staffOf(newStaff('Medical')), detail: 'Located' });
      for (let i = 0; i < 20 && !mock.sent.includes(ep); i += 1) await new Promise((r) => setTimeout(r, 250));
      expect(mock.sent).toContain(ep);
      await new Promise((r) => setTimeout(r, 500));
      expect(pushRows(since)).toBe('');
    } finally {
      psql(`update public.lp_tel_settings set enabled = true, updated_at = now()`);
    }
  });
});
