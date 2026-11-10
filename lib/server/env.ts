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

export interface ServerEnv {
  /** Normalised project URL, e.g. https://abc.supabase.co */
  supabaseUrl: string;
  /** Origin of supabaseUrl (for the CSP img-src that signed photo URLs redirect to). */
  supabaseOrigin: string;
  /** SUPABASE_SECRET_KEY, else SUPABASE_SERVICE_ROLE_KEY. */
  supabaseKey: string;
  sessionSecret: string;
  // (Events) The staff password, the lead passcode and the join links live in the database (lib/server/events.ts).
  // APP_SHARED_PASSWORD(_HASH_B64) / INVITE_* are read only by scripts/bootstrap-events.mjs, once.
  /** PHASE2: the fallback display time zone until every screen reads the event's (EventConfig.timezone). */
  eventTimezone: string;
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

  const eventTimezone = readEnv('EVENT_TIMEZONE') ?? DEFAULT_EVENT_TIMEZONE;
  if (!isValidTimeZone(eventTimezone)) problems.push('EVENT_TIMEZONE is not a valid IANA time zone');

  if (problems.length > 0 || !supabaseUrl || !supabaseKey || !sessionSecret) {
    throw new EnvError(`Server environment is not configured: ${problems.join('; ')}.`);
  }

  cached = {
    supabaseUrl,
    supabaseOrigin: new URL(supabaseUrl).origin,
    supabaseKey,
    sessionSecret,
    eventTimezone,
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
