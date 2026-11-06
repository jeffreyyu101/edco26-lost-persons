// The one server-side Supabase client (service role). Server only: the key never reaches the browser.
// Every call is bounded by a timeout so a stalled database or storage request ends as a 503 (the client
// retries) instead of hanging the function. The lp_* RPCs also carry statement_timeout = 4s in SQL.
import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { ApiFailure, mapDbError, type DbContext, type DbError } from './errors';
import { serverEnv } from './env';

export const PHOTO_BUCKET = 'patient-photos';

/** Database (PostgREST) calls. statement_timeout is 4 s; allow for the network on top. */
export const DB_TIMEOUT_MS = 8_000;
/** Storage uploads of up to ~3.9 MB. */
export const STORAGE_TIMEOUT_MS = 20_000;

function timedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const ms = url.includes('/storage/v1/') ? STORAGE_TIMEOUT_MS : DB_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(ms);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return fetch(input, { ...init, signal });
}

let client: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (client) return client;
  const env = serverEnv();
  client = createClient(env.supabaseUrl, env.supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: timedFetch, headers: { 'X-Client-Info': 'lp-server' } },
  });
  return client;
}

/**
 * Calls an lp_* function and returns its data, or throws the mapped ApiFailure. A thrown fetch error
 * (timeout, network) becomes 503.
 */
export async function rpc<T>(fn: string, args: Record<string, unknown>, context: DbContext = 'default'): Promise<T> {
  let result: { data: unknown; error: DbError | null };
  try {
    result = await db().rpc(fn, args);
  } catch {
    throw new ApiFailure('unavailable', undefined, { dbCode: 'fetch' });
  }
  if (result.error) throw mapDbError(result.error, context);
  return result.data as T;
}
