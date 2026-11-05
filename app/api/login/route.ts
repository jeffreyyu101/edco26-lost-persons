import { createSession, jsonError } from '@/lib/server';
import bcrypt from 'bcryptjs';

export async function POST(req: Request) {
  const { password, staffName } = await req.json().catch(() => ({}));

  if (
    !password ||
    !staffName ||
    typeof staffName !== 'string' ||
    staffName.trim().length < 2
  ) {
    return jsonError('Enter the event password and your name.');
  }

  const encodedHash = process.env.APP_SHARED_PASSWORD_HASH_B64;

  if (!encodedHash) {
    return jsonError('Login configuration is missing.', 500);
  }

  let hash: string;

  try {
    hash = Buffer.from(encodedHash, 'base64').toString('utf8');
  } catch {
    return jsonError('Login configuration is invalid.', 500);
  }

  if (!(await bcrypt.compare(password, hash))) {
    return jsonError('The event password is incorrect.', 401);
  }

  await createSession(staffName.trim().slice(0, 60));

  return Response.json({ ok: true });
}