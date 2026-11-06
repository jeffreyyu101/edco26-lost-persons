import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contentSecurityPolicy, config, proxy } from '@/proxy';
import { safeNextPath } from '@/lib/safe-next';
import { SESSION_COOKIE, signSessionToken } from '@/lib/server/session-token';

describe('safeNextPath', () => {
  it('accepts same-origin app paths', () => {
    expect(safeNextPath('/')).toBe('/');
    expect(safeNextPath('/?r=5eed0000-0000-4000-8000-000000001012')).toBe('/?r=5eed0000-0000-4000-8000-000000001012');
    expect(safeNextPath('/?view=pending#x')).toBe('/?view=pending#x');
  });

  it('rejects anything that could leave the origin or loop', () => {
    for (const bad of [
      null,
      '',
      'https://evil.example',
      '//evil.example/x',
      '/\\evil.example',
      'javascript:alert(1)',
      '/%0d%0aSet-Cookie:x',
      '/\nfoo',
      '/api/session',
      '/api',
      '/signin?next=/',
      `/${'a'.repeat(600)}`,
    ]) {
      const result = safeNextPath(bad);
      if (bad === '/%0d%0aSet-Cookie:x') {
        // Encoded control characters stay encoded in the path: harmless and same-origin.
        expect(result).toBe('/%0d%0aSet-Cookie:x');
      } else {
        expect(result, String(bad)).toBeNull();
      }
    }
  });
});

describe('proxy CSP and matcher', () => {
  it('builds the spec CSP with the nonce', () => {
    const csp = contentSecurityPolicy('abc123', false, 'https://xyz.supabase.co');
    expect(csp).toBe(
      "default-src 'self'; script-src 'self' 'nonce-abc123' 'strict-dynamic'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: blob: https://xyz.supabase.co; connect-src 'self'; font-src 'self'; worker-src 'self'; " +
        "manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
    );
    expect(contentSecurityPolicy('n', true, null)).toContain("'strict-dynamic' 'unsafe-eval'");
    expect(contentSecurityPolicy('n', false, null)).toContain("img-src 'self' data: blob:;");
  });

  it('matches page paths and skips API, assets, the SW and the manifest', () => {
    const source = config.matcher[0] as string;
    // Next.js anchors the matcher; the group after the first "/" carries the negative lookahead.
    const re = new RegExp(`^${source.replace(/\\\\/g, '\\')}$`);
    for (const path of ['/', '/signin', '/signin?next=/', '/whatever']) expect(re.test(path.split('?')[0] as string), path).toBe(true);
    for (const path of [
      '/api/sync',
      '/api',
      '/_next/static/chunks/main.js',
      '/sw.js',
      '/manifest.webmanifest',
      '/icons/icon-192.png',
      '/logos/edc-orlando.png',
      '/fonts/inter.woff2',
      '/favicon.ico',
      '/favicon-32.png',
    ]) {
      expect(re.test(path), path).toBe(false);
    }
  });
});

describe('proxy auth redirects', () => {
  const SECRET = 'unit-test-session-secret-0123456789abcdef';
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.SESSION_SECRET;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = saved;
  });

  const request = (path: string, token?: string) =>
    new NextRequest(`http://127.0.0.1:3100${path}`, token ? { headers: { cookie: `${SESSION_COOKIE}=${token}` } } : {});

  it('sends / without a cookie to sign-in, keeping the view', async () => {
    process.env.SESSION_SECRET = SECRET;
    const response = await proxy(request('/?view=mine'));
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get('location') ?? '');
    expect(`${location.pathname}${location.search}`).toBe('/signin?next=%2F%3Fview%3Dmine');
  });

  it('accepts a cookie signed with the trimmed secret when SESSION_SECRET has surrounding whitespace', async () => {
    // The session routes sign with serverEnv().sessionSecret, which is trimmed. A value pasted into Vercel
    // with a trailing newline must not turn every sign-in into a redirect loop.
    process.env.SESSION_SECRET = ` ${SECRET}\n`;
    const signed = await signSessionToken({ staffName: 'Dana Kim', team: 'GC/HX - Dispatch' }, SECRET);
    const home = await proxy(request('/', signed!.token));
    expect(home.status).toBe(200);
    expect(home.headers.get('x-middleware-next')).toBe('1');
    const signin = await proxy(request('/signin', signed!.token));
    expect(signin.status).toBe(307);
    expect(new URL(signin.headers.get('location') ?? '').pathname).toBe('/');
  });

  it('rejects a cookie signed with a different secret', async () => {
    process.env.SESSION_SECRET = SECRET;
    const signed = await signSessionToken({ staffName: 'Dana Kim', team: 'Medical' }, `${SECRET}-other`);
    expect((await proxy(request('/', signed!.token))).status).toBe(307);
  });
});
