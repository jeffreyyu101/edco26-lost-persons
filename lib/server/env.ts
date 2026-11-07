// Server environment (spec §3): validated with zod on first use; a missing or bad variable fails with a
// clear message naming the variable (never its value). Server only.
//
// Variables are read with computed keys (`process.env[name]`) so the bundler can never inline a value —
// in particular NEXT_PUBLIC_SUPABASE_URL, whose name is kept only for compatibility with Jeffrey's Vercel
// env and which must stay server-side.
import 'server-only';
import { z } from 'zod';
import { DEFAULT_EVENT_TIMEZONE } from '../format';
import { sessionSecretFromEnv } from './session-token';

/**
 * Supabase JS expects the project URL and appends `/rest/v1` itself. Accept the REST URL too, since it
 * is commonly copied from the API settings: strip a trailing `/rest/v1` (with or without a slash) and a
 * trailing slash. Undefined stays undefined for the caller to validate. (Ported from lib/supabase-url.js.)
 */
export function normalizeSupabaseUrl(configuredUrl?: string): string | undefined {
  return configuredUrl?.replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '');
}

/** Reads a variable; blank counts as unset. */
export function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvError';
  }
}

export type PasswordConfig = { kind: 'bcrypt'; hash: string } | { kind: 'plain'; value: string };

/** The team join link (lib/server/invite.ts). Only its SHA-256 is configured; the code is never stored. */
export interface InviteConfig {
  /** INVITE_CODE_SHA256 as 32 bytes. */
  sha256: Buffer;
  /** INVITE_EXPIRES_AT in epoch ms: the link is refused from then on. */
  expiresAt: number;
}

export interface ServerEnv {
  /** Normalised project URL, e.g. https://abc.supabase.co */
  supabaseUrl: string;
  /** Origin of supabaseUrl (for the CSP img-src that signed photo URLs redirect to). */
  supabaseOrigin: string;
  /** SUPABASE_SECRET_KEY, else SUPABASE_SERVICE_ROLE_KEY. */
  supabaseKey: string;
  sessionSecret: string;
  /** APP_SHARED_PASSWORD_HASH_B64 wins when both are set. */
  password: PasswordConfig;
  eventTimezone: string;
  /** Team join link, or null when off (INVITE_CODE_SHA256 or INVITE_EXPIRES_AT unset or unreadable). */
  invite: InviteConfig | null;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

const urlSchema = z.url({ protocol: /^https?$/ });
const isoSchema = z.iso.datetime({ offset: true });

/**
 * The team join link's variables. Both optional: unset means password only, as before the link existed. A
 * value that can't be read turns the link off and is reported by name (never its value) instead of
 * failing the whole server, so a typo never takes the app down during the event.
 */
export function readInviteEnv(): { invite: InviteConfig | null; problem: string | null } {
  const hex = readEnv('INVITE_CODE_SHA256');
  if (!hex) return { invite: null, problem: null };
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return { invite: null, problem: 'INVITE_CODE_SHA256 is not a 64-character hex SHA-256; team links are off' };
  const expires = readEnv('INVITE_EXPIRES_AT');
  if (!expires) return { invite: null, problem: 'INVITE_EXPIRES_AT is missing; team links are off' };
  const expiresAt = Date.parse(expires);
  if (!isoSchema.safeParse(expires).success || Number.isNaN(expiresAt)) {
    return { invite: null, problem: 'INVITE_EXPIRES_AT is not an ISO date-time with Z or an offset; team links are off' };
  }
  return { invite: { sha256: Buffer.from(hex, 'hex'), expiresAt }, problem: null };
}

let cached: ServerEnv | null = null;

/** The validated server environment. Throws EnvError listing every problem (names only). */
export function serverEnv(): ServerEnv {
  if (cached) return cached;
  const problems: string[] = [];

  const rawUrl = readEnv('NEXT_PUBLIC_SUPABASE_URL');
  const supabaseUrl = normalizeSupabaseUrl(rawUrl);
  if (!supabaseUrl) problems.push('NEXT_PUBLIC_SUPABASE_URL is missing');
  else if (!urlSchema.safeParse(supabaseUrl).success) problems.push('NEXT_PUBLIC_SUPABASE_URL is not a valid http(s) URL');

  const supabaseKey = readEnv('SUPABASE_SECRET_KEY') ?? readEnv('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseKey) problems.push('SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) is missing');

  // The same reader as the proxy, so both always use the identical (trimmed) key.
  const sessionSecret = sessionSecretFromEnv() ?? undefined;
  if (!sessionSecret) problems.push('SESSION_SECRET is missing');
  else if (sessionSecret.length < 32) problems.push('SESSION_SECRET must be at least 32 characters');

  let password: PasswordConfig | null = null;
  const hashB64 = readEnv('APP_SHARED_PASSWORD_HASH_B64');
  const plain = process.env['APP_SHARED_PASSWORD'];
  if (hashB64) {
    const hash = Buffer.from(hashB64, 'base64').toString('utf8');
    if (!/^\$2[abxy]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(hash)) problems.push('APP_SHARED_PASSWORD_HASH_B64 is not a base64-encoded bcrypt hash');
    else password = { kind: 'bcrypt', hash };
  } else if (plain !== undefined && plain !== '') {
    password = { kind: 'plain', value: plain };
  } else {
    problems.push('APP_SHARED_PASSWORD_HASH_B64 or APP_SHARED_PASSWORD is required');
  }

  const eventTimezone = readEnv('EVENT_TIMEZONE') ?? DEFAULT_EVENT_TIMEZONE;
  if (!isValidTimeZone(eventTimezone)) problems.push('EVENT_TIMEZONE is not a valid IANA time zone');

  if (problems.length > 0 || !supabaseUrl || !supabaseKey || !sessionSecret || !password) {
    throw new EnvError(`Server environment is not configured: ${problems.join('; ')}.`);
  }

  const invite = readInviteEnv();
  // Once per server instance (the result is cached). Names only, never values.
  if (invite.problem) console.error(JSON.stringify({ lp: 'env', message: invite.problem }));

  cached = {
    supabaseUrl,
    supabaseOrigin: new URL(supabaseUrl).origin,
    supabaseKey,
    sessionSecret,
    password,
    eventTimezone,
    invite: invite.invite,
  };
  return cached;
}

/** For tests only: forget the cached environment. */
export function resetServerEnvCache(): void {
  cached = null;
}

/** Event timezone without requiring the rest of the environment (layout, page). */
export function eventTimezone(): string {
  const tz = readEnv('EVENT_TIMEZONE');
  return tz && isValidTimeZone(tz) ? tz : DEFAULT_EVENT_TIMEZONE;
}
