// Phase 1a e2e helper: a valid lp_session cookie minted with the .env.test SESSION_SECRET, for specs that
// need the signed-in `/` before the real sign-in route exists. Feature specs sign in through the UI once
// per file with storageState instead (v2.1 A17). Synthetic identities only.
import type { BrowserContext } from '@playwright/test';
import { loadTestEnv, testBaseUrl } from '../../../scripts/test-env.mjs';
import { SESSION_COOKIE, signSessionToken } from '../../../lib/server/session-token';

export async function mintSessionToken(staff = { staffName: 'TEST-e2e Smoke', team: 'Medical' }): Promise<string> {
  const env: Record<string, string | undefined> = loadTestEnv();
  const secret = env['SESSION_SECRET']?.trim();
  if (!secret) throw new Error('.env.test has no SESSION_SECRET');
  const signed = await signSessionToken(staff, secret);
  if (!signed) throw new Error('could not sign a session token');
  return signed.token;
}

export async function addSessionCookie(context: BrowserContext, staff?: { staffName: string; team: string }): Promise<void> {
  const token = await mintSessionToken(staff);
  await context.addCookies([{ name: SESSION_COOKIE, value: token, url: testBaseUrl(), httpOnly: true, sameSite: 'Lax' }]);
}
