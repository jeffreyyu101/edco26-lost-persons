// Proxy (spec §6 Proxy): per-request CSP nonce, security headers and the auth redirects for page routes.
//   * `/` without a valid session cookie → /signin?next=<path+query>
//   * `/signin` with a valid session cookie → the safe `next`, else `/`
// API routes, static assets, the service worker, the manifest, icons, logos and fonts never run through
// here (see `config.matcher`). Runs on the Node.js runtime (the Next.js 16 default for proxy).
import { NextResponse, type NextRequest } from 'next/server';
import { safeNextPath } from '@/lib/safe-next';
import { SESSION_COOKIE, sessionSecretFromEnv, verifySessionToken } from '@/lib/server/session-token';

/** Origin of the Supabase project (signed photo URLs redirect there), or null if unset / invalid. */
function supabaseOrigin(): string | null {
  const raw = process.env['NEXT_PUBLIC_SUPABASE_URL'];
  if (!raw) return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64');
}

export function contentSecurityPolicy(nonce: string, dev: boolean, imageOrigin: string | null): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${imageOrigin ? ` ${imageOrigin}` : ''}`,
    "connect-src 'self'",
    "font-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

const SECURITY_HEADERS: ReadonlyArray<[string, string]> = [
  ['X-Content-Type-Options', 'nosniff'],
  ['Referrer-Policy', 'no-referrer'],
  ['Permissions-Policy', 'camera=(self), geolocation=(), microphone=()'],
  ['X-Frame-Options', 'DENY'],
];

function withHeaders(response: NextResponse, csp: string): NextResponse {
  response.headers.set('Content-Security-Policy', csp);
  for (const [name, value] of SECURITY_HEADERS) response.headers.set(name, value);
  return response;
}

export async function proxy(request: NextRequest) {
  const nonce = newNonce();
  const csp = contentSecurityPolicy(nonce, process.env.NODE_ENV === 'development', supabaseOrigin());
  const { pathname, search } = request.nextUrl;

  if (pathname === '/' || pathname === '/signin') {
    // Same trimmed secret the session routes sign with (serverEnv().sessionSecret).
    const claims = await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value, sessionSecretFromEnv());

    if (pathname === '/' && !claims) {
      const target = new URL('/signin', request.url);
      if (search) target.searchParams.set('next', `/${search}`);
      const response = NextResponse.redirect(target, 307);
      response.headers.set('Cache-Control', 'no-store');
      return withHeaders(response, csp);
    }

    if (pathname === '/signin' && claims) {
      const next = safeNextPath(request.nextUrl.searchParams.get('next')) ?? '/';
      const response = NextResponse.redirect(new URL(next, request.url), 307);
      response.headers.set('Cache-Control', 'no-store');
      return withHeaders(response, csp);
    }
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);
  return withHeaders(NextResponse.next({ request: { headers: requestHeaders } }), csp);
}

export const config = {
  matcher: [
    // Every page path except /api/*, /_next/*, /sw.js, /manifest.webmanifest, /icons/*, /logos/*,
    // /fonts/* and /favicon*.
    '/((?!api/|api$|_next/|sw\\.js$|manifest\\.webmanifest$|icons/|logos/|fonts/|favicon).*)',
  ],
};
