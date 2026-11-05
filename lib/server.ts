import { createClient } from '@supabase/supabase-js';
import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';
import { normalizeSupabaseUrl } from './supabase-url';

const configuredUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
// Supabase JS expects the project URL and appends `/rest/v1` itself. Accept
// the REST URL too, since it is commonly copied from the API docs.
const url = normalizeSupabaseUrl(configuredUrl);
const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const secret = process.env.SESSION_SECRET;

export function db() {
  if (!url || !key) {
    throw new Error('Supabase server environment is not configured');
  }

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function secretKey() {
  if (!secret || secret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters');
  }

  return new TextEncoder().encode(secret);
}

export async function createSession(staffName: string) {
  const token = await new SignJWT({ staffName })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('12h')
    .sign(secretKey());

  const cookieStore = await cookies();

  cookieStore.set('edc_session', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: 60 * 60 * 12,
  });
}

export async function currentStaff() {
  const cookieStore = await cookies();
  const token = cookieStore.get('edc_session')?.value;

  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, secretKey());

    return typeof payload.staffName === 'string'
      ? payload.staffName
      : null;
  } catch {
    return null;
  }
}

export function jsonError(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}
