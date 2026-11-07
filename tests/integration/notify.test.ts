// notifyStaff (contract A) in-process against the local database, with web-push mocked (F4, spec §18 A57):
// ONE Activity row per (staff, request) holding the latest event, the actor and duplicates dropped, a push per
// device with the initials as the title and no ids or contact details, 410 deletes the subscription, and a
// push service that never answers never holds the caller beyond 1.5 s. Also involvedStaff (contract C): the
// logger and the answerer, whether or not lp_involved_staff (the Messages release) is there.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestSummary } from '@/lib/api-types';
import { admin, api, cookieFor, createRequest, newStaff, staffOf, withTestServer, type Staff } from './harness';

interface Sent {
  endpoint: string;
  payload: Record<string, unknown>;
  options: Record<string, unknown>;
}

const mock = vi.hoisted(() => ({
  sent: [] as Array<{ endpoint: string; payload: string; options: Record<string, unknown> }>,
  status: new Map<string, number | 'hang'>(),
}));

vi.mock('web-push', () => ({
  default: {
    sendNotification: (sub: { endpoint: string }, payload: string, options: Record<string, unknown>) => {
      mock.sent.push({ endpoint: sub.endpoint, payload, options });
      const status = mock.status.get(sub.endpoint) ?? 201;
      if (status === 'hang') return new Promise(() => undefined);
      if (status >= 200 && status < 300) return Promise.resolve({ statusCode: status, body: '', headers: {} });
      return Promise.reject(Object.assign(new Error('push failed'), { statusCode: status }));
    },
  },
}));

const { notifyStaff, NOTIFY_WAIT_MS } = await import('@/lib/server/notify');
const { involvedStaff, fallbackStaff } = await import('@/lib/server/involved');
const { editEventFor } = await import('@/lib/server/activity-events');

withTestServer();

const canon = (s: Staff) => staffOf(s).toLowerCase();
const sent = (): Sent[] => mock.sent.map((s) => ({ endpoint: s.endpoint, payload: JSON.parse(s.payload) as Record<string, unknown>, options: s.options }));

async function device(staff: Staff, tag: string) {
  const endpoint = `https://fcm.googleapis.com/fcm/send/test-notify-${tag}-${crypto.randomUUID()}`;
  const res = await api('/api/push/subscribe', {
    json: { endpoint, keys: { p256dh: 'BPfakekeyfakekeyfakekeyfakekey', auth: 'fakeauthfake' } },
    cookie: await cookieFor(staff),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return endpoint;
}

/**
 * The request's Activity rows, of `only` these staff when given: (F6 7b) every Medical identity on the shared stack
 * that never set New requests now has it on, so creating a request also writes their "New request" rows.
 */
async function rows(requestId: string, only?: readonly Staff[]) {
  let query = admin().from('lp_activity').select('staff, kind, actor, detail, read_at').eq('request_id', requestId);
  if (only) query = query.in('staff', only.map(canon));
  const { data, error } = await query;
  if (error) throw new Error(error.code);
  return data as Array<{ staff: string; kind: string; actor: string; detail: string; read_at: string | null }>;
}

beforeEach(() => {
  mock.sent.length = 0;
  mock.status.clear();
});

afterAll(async () => {
  for (const table of ['lp_activity', 'lp_push_subscriptions', 'lp_push_prefs'] as const) {
    const { error } = await admin().from(table).delete().like('staff', 'test-s staff %');
    if (error) throw new Error(`cleanup ${table}: ${error.code}`);
  }
});

describe('notifyStaff', () => {
  it('one row per (staff, request) with the latest event; the actor and duplicates are dropped', async () => {
    const dana = newStaff();
    const rae = newStaff('Medical');
    const r = await createRequest(dana, { name: 'Ana TEST-S Lima' });
    await notifyStaff([staffOf(dana), staffOf(dana).toUpperCase(), staffOf(rae)], { requestId: r.id, kind: 'in_medical', actor: staffOf(rae), detail: 'In medical' });
    await notifyStaff([staffOf(dana), staffOf(rae)], { requestId: r.id, kind: 'moved', actor: staffOf(rae), detail: 'Chair 9 → Bed 3' });
    const got = await rows(r.id, [dana, rae]);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ staff: canon(dana), kind: 'moved', detail: 'Chair 9 → Bed 3', actor: staffOf(rae), read_at: null });
  });

  it('a new event makes a read row unread again and moves it to the top', async () => {
    const dana = newStaff();
    const r1 = await createRequest(dana);
    const r2 = await createRequest(dana);
    const actor = staffOf(newStaff('Medical'));
    await notifyStaff([staffOf(dana)], { requestId: r1.id, kind: 'in_medical', actor, detail: 'In medical' });
    await notifyStaff([staffOf(dana)], { requestId: r2.id, kind: 'in_medical', actor, detail: 'In medical' });
    await api('/api/activity/read', { json: { all: true }, cookie: await cookieFor(dana) });
    await notifyStaff([staffOf(dana)], { requestId: r1.id, kind: 'reunited', actor, detail: 'Reunited' });
    const list = (await api('/api/activity', { cookie: await cookieFor(dana) })).body.rows as Array<{ requestId: string; read: boolean; kind: string }>;
    expect(list.map((x) => [x.requestId, x.kind, x.read])).toEqual([
      [r1.id, 'reunited', false],
      [r2.id, 'in_medical', true],
    ]);
  });

  it('pushes once per device: initials as the title, the detail as the body, no ids or contact details', async () => {
    const dana = newStaff();
    const phone = await device(dana, 'a');
    const laptop = await device(dana, 'b');
    const r = await createRequest(dana, { name: 'Jordan TEST-S Diaz', contactPhone: '(407) 555-0142' });
    await notifyStaff([staffOf(dana), staffOf(dana)], {
      requestId: r.id,
      kind: 'message',
      actor: staffOf(newStaff('Medical')),
      detail: 'Rae C.: call me on 407-555-0142 about LP-0042',
    });
    const s = sent().filter((x) => x.endpoint === phone || x.endpoint === laptop);
    expect(s.map((x) => x.endpoint).sort()).toEqual([phone, laptop].sort());
    for (const x of s) {
      expect(x.payload).toMatchObject({ title: 'J.D.', tag: `lp-${r.id}`, url: `/?r=${r.id}`, kind: 'message', renotify: true, badge: 1 });
      expect(x.payload.body).toBe('Rae C.: call me on ••• about');
      const text = JSON.stringify(x.payload);
      expect(text).not.toMatch(/LP-?\d/);
      expect(text).not.toContain('555');
      expect(text).not.toContain('Jordan');
      expect(Buffer.byteLength(text)).toBeLessThan(4_000);
      expect(x.options).toMatchObject({ TTL: 3_600, urgency: 'high' });
      expect((x.options.vapidDetails as { subject?: string }).subject).toBe(process.env.VAPID_SUBJECT);
    }
    // The stored detail is scrubbed too.
    expect((await rows(r.id, [dana]))[0]?.detail).toBe('Rae C.: call me on ••• about');
  });

  it('a 410 from the push service deletes the subscription; a 500 counts a failure', async () => {
    const dana = newStaff();
    const gone = await device(dana, 'gone');
    const flaky = await device(dana, 'flaky');
    mock.status.set(gone, 410);
    mock.status.set(flaky, 500);
    const r = await createRequest(dana);
    await notifyStaff([staffOf(dana)], { requestId: r.id, kind: 'edited', actor: 'Someone · Medical', detail: 'Details changed' });
    const { data } = await admin().from('lp_push_subscriptions').select('endpoint, failures').in('endpoint', [gone, flaky]);
    expect(data).toEqual([{ endpoint: flaky, failures: 1 }]);
  });

  it('a push service that never answers never holds the caller beyond 1.5 s', async () => {
    const dana = newStaff();
    const stuck = await device(dana, 'stuck');
    mock.status.set(stuck, 'hang');
    const r = await createRequest(dana);
    const started = Date.now();
    await notifyStaff([staffOf(dana)], { requestId: r.id, kind: 'edited', actor: 'Someone · Medical', detail: 'Details changed' });
    expect(Date.now() - started).toBeLessThan(NOTIFY_WAIT_MS + 300);
    // The row is written before the push goes out.
    expect(await rows(r.id, [dana])).toHaveLength(1);
  });

  it('never throws: an unknown request, a bad kind, nobody to tell', async () => {
    await expect(notifyStaff(['A B · Medical'], { requestId: crypto.randomUUID(), kind: 'edited', actor: 'x', detail: 'x' })).resolves.toBeUndefined();
    await expect(notifyStaff(['A B · Medical'], { requestId: 'nope', kind: 'edited', actor: 'x', detail: 'x' })).resolves.toBeUndefined();
    await expect(notifyStaff([], { requestId: crypto.randomUUID(), kind: 'edited', actor: 'x', detail: 'x' })).resolves.toBeUndefined();
  });
});

describe('involvedStaff (contract C)', () => {
  it('the logger, then the answerer too — with or without lp_involved_staff', async () => {
    const dana = newStaff();
    const rae = newStaff('Medical');
    const r = await createRequest(dana);
    const canonList = async () => (await involvedStaff(r.id)).map((s) => s.toLowerCase());
    expect(await canonList()).toContain(canon(dana));
    const res = await api(`/api/requests/${r.id}/status`, {
      json: { status: 'Found – Awaiting Reunion', expectedVersion: (r as RequestSummary).rowVersion, kind: 'answer' },
      cookie: await cookieFor(rae),
    });
    expect(res.status).toBe(200);
    const list = await canonList();
    expect(list).toContain(canon(dana));
    expect(list).toContain(canon(rae));
    expect((await fallbackStaff(r.id)).map((s) => s.toLowerCase()).sort()).toEqual([canon(dana), canon(rae)].sort());
  });
});

describe('the edit event (PATCH, built after the response)', () => {
  it("regression: two people editing the same request at once: each event is its own author's change", async () => {
    const dana = newStaff();
    const rae = newStaff('Medical');
    const r = await createRequest(dana);
    const answered = await api(`/api/requests/${r.id}/status`, {
      json: { status: 'Found – Awaiting Reunion', expectedVersion: (r as RequestSummary).rowVersion, kind: 'answer' },
      cookie: await cookieFor(rae),
    });
    const v1 = (answered.body as { request: RequestSummary }).request.rowVersion;
    // Rae sets where medical has them; right after, Dana edits the clothing (before Rae's event is built).
    const located = await api(`/api/requests/${r.id}`, { method: 'PATCH', json: { patch: { medicalLocation: 'Chair 9' }, expectedVersion: v1 }, cookie: await cookieFor(rae) });
    expect(located.status).toBe(200);
    const v2 = (located.body as { request: RequestSummary }).request.rowVersion;
    const edited = await api(`/api/requests/${r.id}`, { method: 'PATCH', json: { patch: { clothing: 'Blue TEST-S hoodie' }, expectedVersion: v2 }, cookie: await cookieFor(dana) });
    expect(edited.status).toBe(200);
    const status = (edited.body as { request: RequestSummary }).request.status;
    expect(await editEventFor(r.id, staffOf(rae), status)).toMatchObject({ kind: 'in_medical', detail: 'In medical · Chair 9', actor: staffOf(rae) });
    expect(await editEventFor(r.id, staffOf(dana), status)).toMatchObject({ kind: 'edited', detail: 'Details changed', actor: staffOf(dana) });
  });
});
