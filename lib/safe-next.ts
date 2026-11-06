// `?next=` handling (spec §8 Sign-in): only same-origin paths are honoured. Used by proxy.ts, the sign-in
// page and the client after sign-in. Pure.

const MAX_NEXT = 512;

/**
 * Returns a safe same-origin path ("/", "/?r=…") or null. Rejects absolute URLs, protocol-relative
 * "//host", backslash tricks, control characters, /api and /signin targets.
 */
export function safeNextPath(next: string | null | undefined): string | null {
  if (!next || next.length > MAX_NEXT) return null;
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return null;
  if (/[\u0000-\u001f\u007f\\]/.test(next)) return null;
  let url: URL;
  try {
    url = new URL(next, 'https://lp.invalid');
  } catch {
    return null;
  }
  if (url.origin !== 'https://lp.invalid') return null;
  if (url.pathname.startsWith('/api/') || url.pathname === '/api' || url.pathname.startsWith('/signin')) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}
