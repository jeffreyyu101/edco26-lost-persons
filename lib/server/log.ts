// Server logging (spec §6 "Logs only the route, error code, error id and timing"). Server only.
//
// NEVER pass request bodies, rows, names, phone numbers, free text, database error messages / details
// (a Postgres CHECK violation's detail echoes the row) or tokens here. The only accepted fields are the
// ones in LogFields, and every string is reduced to a short safe token before it is printed.
import 'server-only';

export interface LogFields {
  /** "POST /api/requests/[id]/status" — the route pattern, never the concrete path (no ids). */
  route: string;
  status: number;
  /** ApiErrorCode, when the response is an error. */
  code?: string;
  /** Correlates with the error id returned to the client. */
  errorId?: string;
  /** SQLSTATE / PostgREST / storage error code (never the message). */
  dbCode?: string;
  /** Wall time of the request in ms. */
  ms: number;
}

/** A code-like token: letters, digits, '_', '-', '.', at most 40 characters. */
function token(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const t = value.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40);
  return t || undefined;
}

/** Requests slower than this are logged even when they succeed. */
export const SLOW_REQUEST_MS = 2_000;

/** One JSON line per notable request: every failure, and slow successes. Successes are silent. */
export function logRequest(fields: LogFields): void {
  const line = {
    route: fields.route.replace(/[^A-Za-z0-9_./[\] -]/g, '').slice(0, 80),
    status: Math.trunc(fields.status),
    code: token(fields.code),
    errorId: token(fields.errorId),
    dbCode: token(fields.dbCode),
    ms: Math.round(fields.ms),
  };
  if (line.status >= 500) console.error(JSON.stringify({ lp: 'api', ...line }));
  else if (line.status >= 400 || line.ms >= SLOW_REQUEST_MS) console.warn(JSON.stringify({ lp: 'api', ...line }));
}

export type SignInMethod = 'password' | 'invite';

/**
 * One line per checked sign-in: how ("password" or "invite", the team join link) and whether it passed.
 * Nothing else: never the name, the password, the code, its hash or the IP.
 */
export function logSignIn(method: SignInMethod, ok: boolean): void {
  // eslint-disable-next-line no-console -- deliberate: a fixed-shape line, the method and the outcome only (J1)
  console.info(JSON.stringify({ lp: 'signin', method: method === 'invite' ? 'invite' : 'password', ok: ok === true }));
}

/** A short random error id, e.g. "e7c1f09a2b". */
export function newErrorId(): string {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
