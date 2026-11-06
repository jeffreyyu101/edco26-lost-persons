// Sign-in rate limits (spec §5 lp_login_begin, §6 client IP, A17): ≥ 10 failed/pending attempts per
// name + IP, or ≥ 100 per IP, in 15 minutes → 429 with Retry-After. Every test uses its own fake IP and
// deletes its own attempts; nobody truncates the table.
import { afterEach, describe, expect, it } from 'vitest';
import { PASSWORD, admin, api, clearAttempts, freshIp, pii, uniq, withTestServer } from './harness';

withTestServer();

const ips: string[] = [];
afterEach(async () => {
  while (ips.length) await clearAttempts(ips.pop() as string);
});
async function ip(): Promise<string> {
  const v = await freshIp();
  ips.push(v);
  return v;
}

const attempt = (staffName: string, password: string, headers: Record<string, string>) =>
  api('/api/session', { json: { staffName, team: 'Medical', password }, headers });

async function attemptsFor(ipValue: string) {
  const { data, error } = await admin().from('lp_login_attempts').select('ip, name_key, ok').eq('ip', ipValue);
  if (error) throw new Error(error.code);
  return data as Array<{ ip: string; name_key: string; ok: boolean | null }>;
}

describe('login limits', () => {
  it('per name + IP: the 11th attempt after 10 failures is 429 with Retry-After, even with the right password', async () => {
    const addr = await ip();
    const name = pii(`TEST-S Limit ${uniq()}`);
    for (let i = 0; i < 10; i += 1) {
      const res = await attempt(name, 'wrong-password', { 'x-real-ip': addr });
      expect(res.status, `attempt ${i + 1}`).toBe(401);
    }
    const limited = await attempt(name, PASSWORD, { 'x-real-ip': addr });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('rate_limited');
    const retry = Number(limited.headers.get('retry-after'));
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(15 * 60);
    expect(limited.body.error.retryAfterSeconds).toBe(retry);
    expect(limited.body.error.message).toMatch(/^Too many attempts\. Try again in \d+ min$/);

    // The same IP with another name is still allowed (the pair limit, not the IP limit).
    const other = await attempt(pii(`TEST-S Limit ${uniq()}`), PASSWORD, { 'x-real-ip': addr });
    expect(other.status).toBe(200);
    // name_key is the lowercased name; successful attempts are recorded as ok.
    const rows = await attemptsFor(addr);
    expect(rows.filter((r) => r.name_key === name.toLowerCase())).toHaveLength(10);
    expect(rows.filter((r) => r.ok === true)).toHaveLength(1);
  });

  it('a successful sign-in does not count against the limit', async () => {
    const addr = await ip();
    const name = pii(`TEST-S Ok ${uniq()}`);
    for (let i = 0; i < 12; i += 1) expect((await attempt(name, PASSWORD, { 'x-real-ip': addr })).status).toBe(200);
  });

  it('per IP: 100 failures from one IP across names → 429 for any name', async () => {
    const addr = await ip();
    // 99 earlier failures with different names (inserted directly), then the 100th through the API.
    const rows = Array.from({ length: 99 }, (_, i) => ({ ip: addr, name_key: `test-s bulk ${i}`, ok: false }));
    const { error } = await admin().from('lp_login_attempts').insert(rows);
    expect(error).toBeNull();
    expect((await attempt(pii(`TEST-S Ip ${uniq()}`), 'wrong-password', { 'x-real-ip': addr })).status).toBe(401);
    const limited = await attempt(pii(`TEST-S Ip ${uniq()}`), PASSWORD, { 'x-real-ip': addr });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('concurrent attempts are all counted: 16 at once → exactly 10 checked, 6 refused', async () => {
    const addr = await ip();
    const name = pii(`TEST-S Burst ${uniq()}`);
    const results = await Promise.all(
      Array.from({ length: 16 }, () => attempt(name, 'wrong-password', { 'x-real-ip': addr })),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 401)).toHaveLength(10);
    expect(statuses.filter((s) => s === 429)).toHaveLength(6);
    expect(await attemptsFor(addr)).toHaveLength(10);
  });

  it('a forged x-forwarded-for is ignored when the Vercel header is present', async () => {
    const real = await ip();
    const name = pii(`TEST-S Forge ${uniq()}`);
    for (let i = 0; i < 10; i += 1) {
      const forged = await freshIp();
      ips.push(forged);
      const res = await attempt(name, 'wrong-password', { 'x-vercel-forwarded-for': real, 'x-forwarded-for': forged });
      expect(res.status).toBe(401);
    }
    const forged = await freshIp();
    ips.push(forged);
    const limited = await attempt(name, PASSWORD, { 'x-vercel-forwarded-for': real, 'x-forwarded-for': forged, 'x-real-ip': forged });
    expect(limited.status).toBe(429);
    expect((await attemptsFor(real)).length).toBe(10);
    expect((await attemptsFor(forged)).length).toBe(0);
  });

  it('IP order: x-vercel-forwarded-for, then x-real-ip, then the leftmost x-forwarded-for', async () => {
    const [a, b, c, d] = [await ip(), await ip(), await ip(), await ip()];
    const name = pii(`TEST-S Order ${uniq()}`);
    await attempt(name, PASSWORD, { 'x-vercel-forwarded-for': a, 'x-real-ip': b, 'x-forwarded-for': c });
    await attempt(name, PASSWORD, { 'x-real-ip': b, 'x-forwarded-for': c });
    await attempt(name, PASSWORD, { 'x-forwarded-for': `${c}, ${d}` });
    expect(await attemptsFor(a)).toHaveLength(1);
    expect(await attemptsFor(b)).toHaveLength(1);
    expect(await attemptsFor(c)).toHaveLength(1);
    expect(await attemptsFor(d)).toHaveLength(0);
  });
});
