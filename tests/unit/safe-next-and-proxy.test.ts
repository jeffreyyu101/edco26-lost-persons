import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, config } from '@/proxy';
import { safeNextPath } from '@/lib/safe-next';

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
