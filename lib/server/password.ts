// The shared event password (spec §3). APP_SHARED_PASSWORD_HASH_B64 (Jeffrey's base64 bcrypt hash) wins;
// otherwise APP_SHARED_PASSWORD, compared in constant time: HMAC-SHA256 both sides with SESSION_SECRET,
// then timingSafeEqual. Server only. Never log the password or the hash.
import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { serverEnv } from './env';

function hmac(secret: string, value: string): Buffer {
  return createHmac('sha256', secret).update(value, 'utf8').digest();
}

export async function verifyPassword(candidate: string): Promise<boolean> {
  const env = serverEnv();
  if (env.password.kind === 'bcrypt') {
    try {
      return await bcrypt.compare(candidate, env.password.hash);
    } catch {
      return false;
    }
  }
  return timingSafeEqual(hmac(env.sessionSecret, candidate), hmac(env.sessionSecret, env.password.value));
}
