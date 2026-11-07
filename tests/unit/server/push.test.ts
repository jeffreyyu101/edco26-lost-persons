// lib/server/push.ts (F4, spec §18 A54): VAPID keys switch push on (missing or malformed → off, silently);
// endpoints only on the browsers' push services (local test endpoints only with LP_PUSH_ALLOW_LOCAL=1 AND a
// local Supabase URL); one push per device; 404 / 410 → gone; a timeout → failed. web-push is mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testPayload } from '@/lib/activity';

const mock = vi.hoisted(() => ({ calls: [] as Array<{ endpoint: string; options: Record<string, unknown> }>, status: new Map<string, number | 'hang'>() }));
vi.mock('web-push', () => ({
  default: {
    sendNotification: (sub: { endpoint: string }, _payload: string, options: Record<string, unknown>) => {
      mock.calls.push({ endpoint: sub.endpoint, options });
      const s = mock.status.get(sub.endpoint) ?? 201;
      if (s === 'hang') return new Promise(() => undefined);
      return s < 300 ? Promise.resolve({ statusCode: s }) : Promise.reject(Object.assign(new Error('x'), { statusCode: s }));
    },
  },
}));

const push = await import('@/lib/server/push');

const KEYS = {
  VAPID_PUBLIC_KEY: 'BEaPyhQXb8N_tL40dgifi5XzkMxfyb9Fq-fyPyhDqG_owTqxDe7FG9PoHwIYVWkQFVaeTf0nbxe42jSDHlw0w28',
  VAPID_PRIVATE_KEY: 'on0i8w6NSMAFsfPLVnh20y27lEIG9ASp-m-64EnaLIU',
  VAPID_SUBJECT: 'mailto:lp-tests@example.invalid',
};
const saved = { ...process.env };

function env(vars: Record<string, string | undefined>) {
  for (const k of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT', 'NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'LP_PUSH_ALLOW_LOCAL', 'NEXT_PUBLIC_SUPABASE_URL']) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
  push.resetPushConfigCache();
}

beforeEach(() => {
  mock.calls.length = 0;
  mock.status.clear();
  env(KEYS);
});
afterEach(() => {
  process.env = { ...saved };
  push.resetPushConfigCache();
});

describe('VAPID config', () => {
  it('all three keys: on', () => {
    expect(push.pushEnabled()).toBe(true);
    expect(push.vapidConfig()?.publicKey).toBe(KEYS.VAPID_PUBLIC_KEY);
  });
  it('the public key may come from NEXT_PUBLIC_VAPID_PUBLIC_KEY', () => {
    env({ ...KEYS, VAPID_PUBLIC_KEY: undefined, NEXT_PUBLIC_VAPID_PUBLIC_KEY: KEYS.VAPID_PUBLIC_KEY });
    expect(push.pushEnabled()).toBe(true);
  });
  it.each([
    ['no keys', {}],
    ['no subject', { ...KEYS, VAPID_SUBJECT: undefined }],
    ['a subject that is neither mailto: nor https:', { ...KEYS, VAPID_SUBJECT: 'http://example.com' }],
    ['a short public key', { ...KEYS, VAPID_PUBLIC_KEY: 'abc' }],
    ['a private key that is not base64url', { ...KEYS, VAPID_PRIVATE_KEY: 'not a key!' }],
  ])('%s: off, silently', (_name, vars) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    env(vars);
    expect(push.pushEnabled()).toBe(false);
    for (const call of warn.mock.calls) expect(String(call[0])).not.toContain(KEYS.VAPID_PRIVATE_KEY);
    warn.mockRestore();
  });
});

describe('isAllowedEndpoint', () => {
  it.each([
    ['https://fcm.googleapis.com/fcm/send/abc', true],
    ['https://updates.push.services.mozilla.com/wpush/v2/abc', true],
    ['https://web.push.apple.com/QK_abc', true],
    ['https://wns2-par02p.notify.windows.com/w/?token=abc', true],
    ['http://fcm.googleapis.com/fcm/send/abc', false],
    ['https://fcm.googleapis.com.evil.example/x', false],
    ['https://evilfcm.googleapis.com.example/x', false],
    ['https://fcm.googleapis.com:8443/x', false],
    ['https://user:pw@fcm.googleapis.com/x', false],
    ['https://127.0.0.1:9999/push/a', false],
    ['https://169.254.169.254/latest', false],
    ['nope', false],
  ])('%s → %s', (url, ok) => {
    expect(push.isAllowedEndpoint(url)).toBe(ok);
  });

  it('local test endpoints need BOTH the flag and a local Supabase URL', () => {
    env({ ...KEYS, LP_PUSH_ALLOW_LOCAL: '1', NEXT_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co' });
    expect(push.isAllowedEndpoint('https://127.0.0.1:9999/push/a')).toBe(false);
    env({ ...KEYS, NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54421' });
    expect(push.isAllowedEndpoint('https://127.0.0.1:9999/push/a')).toBe(false);
    env({ ...KEYS, LP_PUSH_ALLOW_LOCAL: '1', NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54421' });
    expect(push.isAllowedEndpoint('https://127.0.0.1:9999/push/a')).toBe(true);
    expect(push.isAllowedEndpoint('http://127.0.0.1:9999/push/a')).toBe(false);
  });
});

describe('sendPushes', () => {
  const target = (endpoint: string) => ({ endpoint, p256dh: 'p', auth: 'a', staff: 's' });
  it('one push per device, with TTL and urgency; 201 ok, 404 / 410 gone, else failed', async () => {
    const a = 'https://fcm.googleapis.com/fcm/send/a';
    const b = 'https://fcm.googleapis.com/fcm/send/b';
    const c = 'https://fcm.googleapis.com/fcm/send/c';
    const d = 'https://fcm.googleapis.com/fcm/send/d';
    mock.status.set(b, 410);
    mock.status.set(c, 404);
    mock.status.set(d, 500);
    const out = await push.sendPushes([target(a), target(a), target(b), target(c), target(d)], () => testPayload(), { ttl: 60, urgency: 'high' });
    expect(mock.calls.map((x) => x.endpoint)).toEqual([a, b, c, d]);
    expect(mock.calls[0]?.options).toMatchObject({ TTL: 60, urgency: 'high', contentEncoding: 'aes128gcm' });
    expect(push.groupOutcomes(out)).toEqual({ ok: [a], gone: [b, c], failed: [d] });
  });

  it('an endpoint that is not a push service is never posted to (and counts as gone)', async () => {
    const out = await push.sendPushes([target('https://evil.example/x')], () => testPayload(), { ttl: 60, urgency: 'normal' });
    expect(mock.calls).toEqual([]);
    expect(out[0]?.result).toBe('gone');
  });

  it('a push service that never answers is failed after the timeout', async () => {
    const a = 'https://fcm.googleapis.com/fcm/send/slow';
    mock.status.set(a, 'hang');
    const started = Date.now();
    const out = await push.sendPushes([target(a)], () => testPayload(), { ttl: 60, urgency: 'normal', timeoutMs: 100 });
    expect(out[0]?.result).toBe('failed');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('push off: sends nothing', async () => {
    env({});
    expect(await push.sendPushes([target('https://fcm.googleapis.com/fcm/send/a')], () => testPayload(), { ttl: 60, urgency: 'normal' })).toEqual([]);
    expect(mock.calls).toEqual([]);
  });
});
