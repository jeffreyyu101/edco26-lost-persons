// POST /api/session (spec §6, A27). The only network call /signin makes. Never logs: the body holds the
// staff name and the event password.
import type { SignInBody } from '@/lib/validation';
import { interpretSignInResponse, type SignInOutcome } from './logic';

export const SESSION_PATH = '/api/session';

/** bcrypt on the server plus a weak festival signal: a little longer than the 10 s mutation timeout. */
export const SIGN_IN_TIMEOUT_MS = 15_000;

export async function postSession(body: SignInBody, timeoutMs = SIGN_IN_TIMEOUT_MS): Promise<SignInOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(SESSION_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      // Empty or non-JSON body (e.g. a proxy error page): the status decides.
    }
    return interpretSignInResponse(res.status, json, res.headers.get('Retry-After'), Date.now());
  } catch {
    return { kind: 'network' };
  } finally {
    clearTimeout(timer);
  }
}
