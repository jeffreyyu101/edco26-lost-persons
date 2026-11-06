// The `lp_session` cookie token (spec §6): a JWT (HS256) holding {staffName, team, iat, sid}.
//   * expires 12 h after it was last (re)issued; authenticated responses re-issue it once it is > 1 h old
//   * absolute cap: 36 h after the first sign-in — `sid` carries that original issue time
// Used by proxy.ts (redirects) and by lib/server/session (the route helpers). No Next.js imports here, so
// it works in the proxy and in unit tests. Never log tokens or claims.
import { SignJWT, jwtVerify } from 'jose';
import { staffString } from '../domain';

export const SESSION_COOKIE = 'lp_session';
export const SESSION_IDLE_SECONDS = 12 * 60 * 60;
export const SESSION_REFRESH_AFTER_SECONDS = 60 * 60;
export const SESSION_ABSOLUTE_SECONDS = 36 * 60 * 60;
/** Tolerated clock difference for iat in the future. */
const CLOCK_SKEW_SECONDS = 60;

export interface SessionClaims {
  staffName: string;
  team: string;
  /** "<first sign-in, epoch seconds>.<random hex>" */
  sid: string;
  iat: number;
  exp: number;
  /** Parsed from sid. */
  firstIssuedAt: number;
}

const keyCache = new Map<string, Uint8Array>();
function key(secret: string): Uint8Array {
  let k = keyCache.get(secret);
  if (!k) {
    k = new TextEncoder().encode(secret);
    keyCache.set(secret, k);
  }
  return k;
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function newSid(nowSeconds: number): string {
  return `${Math.floor(nowSeconds)}.${randomHex(12)}`;
}

/** First sign-in time from a sid, or null when malformed. */
export function sidIssuedAt(sid: string): number | null {
  const m = /^(\d{9,12})\.[0-9a-f]{24}$/.exec(sid);
  return m ? Number(m[1]) : null;
}

/** Expiry for a token issued now: 12 h idle, never past the 36 h absolute cap. */
export function sessionExpiry(nowSeconds: number, firstIssuedAt: number): number {
  return Math.min(Math.floor(nowSeconds) + SESSION_IDLE_SECONDS, firstIssuedAt + SESSION_ABSOLUTE_SECONDS);
}

/**
 * Signs a session token. Pass the existing `sid` when refreshing (keeps the absolute cap); omit it on a
 * fresh sign-in. Returns null if the absolute cap has already passed.
 */
export async function signSessionToken(
  input: { staffName: string; team: string; sid?: string },
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<{ token: string; claims: SessionClaims } | null> {
  const iat = Math.floor(nowSeconds);
  const sid = input.sid ?? newSid(iat);
  const firstIssuedAt = sidIssuedAt(sid);
  if (firstIssuedAt === null) return null;
  const exp = sessionExpiry(iat, firstIssuedAt);
  if (exp <= iat) return null;
  const token = await new SignJWT({ staffName: input.staffName, team: input.team, sid })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(key(secret));
  return { token, claims: { staffName: input.staffName, team: input.team, sid, iat, exp, firstIssuedAt } };
}

/** Verifies a token. Null for anything invalid, expired, past the absolute cap or malformed. */
export async function verifySessionToken(
  token: string | undefined | null,
  secret: string | undefined | null,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<SessionClaims | null> {
  if (!token || !secret || secret.length < 32 || token.length > 4096) return null;
  try {
    const { payload } = await jwtVerify(token, key(secret), {
      algorithms: ['HS256'],
      currentDate: new Date(nowSeconds * 1000),
    });
    const { staffName, team, sid, iat, exp } = payload as Record<string, unknown>;
    if (typeof staffName !== 'string' || typeof team !== 'string' || typeof sid !== 'string') return null;
    if (typeof iat !== 'number' || typeof exp !== 'number') return null;
    if (!staffName || !team) return null;
    const firstIssuedAt = sidIssuedAt(sid);
    if (firstIssuedAt === null) return null;
    if (iat > nowSeconds + CLOCK_SKEW_SECONDS || firstIssuedAt > iat + CLOCK_SKEW_SECONDS) return null;
    if (exp - iat > SESSION_IDLE_SECONDS) return null;
    if (nowSeconds >= exp || nowSeconds >= firstIssuedAt + SESSION_ABSOLUTE_SECONDS) return null;
    return { staffName, team, sid, iat, exp, firstIssuedAt };
  } catch {
    return null;
  }
}

/** True when an authenticated response should re-issue the cookie (token older than 1 h). */
export function needsRefresh(claims: SessionClaims, nowSeconds: number = Math.floor(Date.now() / 1000)): boolean {
  return nowSeconds - claims.iat >= SESSION_REFRESH_AFTER_SECONDS;
}

/** The attribution string for a session: "staffName · team". */
export function claimsStaff(claims: Pick<SessionClaims, 'staffName' | 'team'>): string {
  return staffString(claims.staffName, claims.team);
}
