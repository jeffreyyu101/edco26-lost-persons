// Session helpers for the route handlers (spec §6 session cookie). The token format lives in
// session-token.ts (shared with proxy.ts). Server only. Never log tokens or claims.
//
// Cookie: lp_session; HttpOnly; Path=/; SameSite=Lax (links from iMessage / Slack keep the session; the
// Origin check is the CSRF defence); Secure when the request came in over https (A16); Max-Age = the
// token's remaining life. Authenticated responses re-issue it once the token is over 1 h old (sliding 12 h),
// never past the 36 h absolute cap carried in `sid`.
import 'server-only';
import type { EventConfig, SessionInfo } from '../api-types';
import { serverEnv } from './env';
import { ApiFailure } from './errors';
import { isHttps } from './http';
import {
  SESSION_COOKIE,
  claimsStaff,
  needsRefresh,
  signSessionToken,
  verifySessionToken,
  type SessionClaims,
} from './session-token';

/** The lp_session value from a Cookie header (the first one, as browsers send the most specific first). */
export function readSessionCookie(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      const value = part.slice(eq + 1).trim();
      return value || null;
    }
  }
  return null;
}

/** Set-Cookie for a session token expiring at `exp` (epoch seconds). */
export function sessionCookie(request: Request, token: string, exp: number, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const maxAge = Math.max(0, exp - nowSeconds);
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
    `Expires=${new Date(exp * 1000).toUTCString()}`,
  ];
  if (isHttps(request)) parts.push('Secure');
  return parts.join('; ');
}

/** Set-Cookie that deletes the session cookie. */
export function clearedSessionCookie(request: Request): string {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT'];
  if (isHttps(request)) parts.push('Secure');
  return parts.join('; ');
}

export interface ActiveSession {
  claims: SessionClaims;
  /** (Events) The session's event, or null (a lead with none open). Every RPC is called with it. */
  eventId: string | null;
  role: SessionClaims['role'];
  /** "staffName · team" — the attribution passed to every lp_* write. Never from the client. */
  staff: string;
  /** A re-issued cookie to attach to the response (token older than 1 h), or null. */
  setCookie: string | null;
}

/**
 * The verified session for a request, re-issuing the token when it is over 1 h old. Throws 401
 * unauthorized when the cookie is missing, invalid, expired or past the absolute cap.
 */
export async function requireSession(request: Request): Promise<ActiveSession> {
  const secret = serverEnv().sessionSecret;
  const now = Math.floor(Date.now() / 1000);
  const claims = await verifySessionToken(readSessionCookie(request), secret, now);
  if (!claims) throw new ApiFailure('unauthorized');
  const active = (c: SessionClaims, setCookie: string | null): ActiveSession => ({
    claims: c,
    eventId: c.eventId,
    role: c.role,
    staff: claimsStaff(c),
    setCookie,
  });
  if (!needsRefresh(claims, now)) return active(claims, null);
  const refreshed = await signSessionToken(
    { staffName: claims.staffName, team: claims.team, eventId: claims.eventId, role: claims.role, pv: claims.pv, sid: claims.sid },
    secret,
    now,
  );
  if (!refreshed || refreshed.claims.exp <= claims.exp) {
    // Already at the absolute cap: the current token stays valid until it expires.
    return active(claims, null);
  }
  return active(refreshed.claims, sessionCookie(request, refreshed.token, refreshed.claims.exp, now));
}

/** The SessionInfo body for a set of claims (A27) and the session's event config (null: none open). */
export function sessionInfo(claims: SessionClaims, event: EventConfig | null): SessionInfo {
  return {
    role: claims.role,
    eventId: claims.eventId,
    event,
    staffName: claims.staffName,
    team: claims.team,
    staff: claimsStaff(claims),
    expiresAt: new Date(claims.exp * 1000).toISOString(),
  };
}
