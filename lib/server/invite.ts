// The team join link's code (design/DECISIONS.md "Team join link", docs/BUILD_SPEC.md J1). The server holds
// only INVITE_CODE_SHA256 (hex SHA-256 of the code) and INVITE_EXPIRES_AT; the code itself is never stored.
// A candidate is hashed and compared in constant time (timingSafeEqual over equal-length digests), and is
// accepted only before the expiry. Off (always false) when the variables are unset. Server only. Never log
// the code or its hash.
import 'server-only';
import { createHash, timingSafeEqual } from 'node:crypto';
import { serverEnv, type InviteConfig } from './env';

const NO_DIGEST = Buffer.alloc(32);

/** True when `candidate` is the configured code and `nowMs` is before its expiry. */
export function inviteMatches(candidate: string, invite: InviteConfig | null, nowMs: number): boolean {
  const digest = createHash('sha256').update(candidate, 'utf8').digest();
  // Always one comparison, so an off or expired link answers in the same time as a wrong code.
  const same = timingSafeEqual(digest, invite?.sha256.length === 32 ? invite.sha256 : NO_DIGEST);
  return invite !== null && same && nowMs < invite.expiresAt;
}

/** Checks a join code against the server environment. */
export function verifyInvite(candidate: string, nowMs: number = Date.now()): boolean {
  return inviteMatches(candidate, serverEnv().invite, nowMs);
}
