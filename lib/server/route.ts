// The wrapper every API route handler goes through (spec §6 "Every route"):
//   * same-origin check for mutations (403 bad_origin), before anything else
//   * session required (401) except where a route opts out; sliding cookie re-issue (> 1 h old)
//   * every failure → {error: {code, message, id?}} with Cache-Control: no-store; anything unexpected → 503
//     with an error id
//   * one log line per failure / slow request: route pattern, status, code, error id, db code, timing only
//   * (Events) the event comes from the session, never from the client: a route needs one (409 no_event for a lead
//     with none open) unless it opts out; lead-only routes answer 403 to staff. An archived event's writes fail in
//     SQL with P0410, mapped to 410 event_ended (lib/server/errors.ts).
// Server only.
import 'server-only';
import { EnvError } from './env';
import { ApiFailure } from './errors';
import { assertSameOrigin, json } from './http';
import { logRequest } from './log';
import { requireSession, type ActiveSession } from './session';

type Params = Record<string, string | string[] | undefined>;

/** What Next.js passes as the second argument to a route handler. */
export interface NextRouteContext<P extends Params> {
  params: Promise<P>;
}

export interface RouteOptions {
  /** Require Origin === the request origin (default: true for anything but GET / HEAD). */
  sameOrigin?: boolean;
  /** Re-issue the session cookie when it is over 1 h old (default true). Off for logout and redirects. */
  refresh?: boolean;
  /** (Events) 'required' (default): the session must have an event (409 no_event). 'optional': it may have none. */
  event?: 'required' | 'optional';
  /** (Events) Leads only (403 forbidden for staff). */
  lead?: boolean;
}

export interface PublicContext<P extends Params> {
  request: Request;
  params: P;
}

export interface AuthedContext<P extends Params> extends PublicContext<P> {
  session: ActiveSession;
  /** (Events) The session's event id; '' only on an `event: 'optional'` route whose session has none. */
  eventId: string;
}

function failureFrom(error: unknown): ApiFailure {
  if (error instanceof ApiFailure) return error;
  if (error instanceof EnvError) {
    // EnvError messages name variables, never their values (lib/server/env.ts).
    console.error(JSON.stringify({ lp: 'env', message: error.message }));
    return new ApiFailure('unavailable', undefined, { dbCode: 'env' });
  }
  return new ApiFailure('unavailable', undefined, { dbCode: 'exception' });
}

function methodOf(name: string): string {
  return name.split(' ')[0] ?? 'GET';
}

function wrap<P extends Params>(
  name: string,
  options: RouteOptions,
  needsSession: boolean,
  handler: (ctx: AuthedContext<P> | PublicContext<P>) => Promise<Response>,
) {
  const method = methodOf(name);
  const sameOrigin = options.sameOrigin ?? !(method === 'GET' || method === 'HEAD');
  const refresh = options.refresh ?? true;

  return async function routeHandler(request: Request, context: NextRouteContext<P>): Promise<Response> {
    const started = performance.now();
    let response: Response;
    let failure: ApiFailure | null = null;
    let session: ActiveSession | null = null;
    try {
      if (sameOrigin) assertSameOrigin(request);
      if (needsSession) {
        session = await requireSession(request);
        if (options.lead && session.role !== 'lead') throw new ApiFailure('forbidden', 'Leads only');
        if ((options.event ?? 'required') === 'required' && !session.eventId) throw new ApiFailure('no_event');
      }
      const params = (await context.params) as P;
      response = await handler(session ? { request, params, session, eventId: session.eventId ?? '' } : { request, params });
    } catch (error) {
      failure = failureFrom(error);
      response = json(failure.body(), failure.status, failure.headers);
    }
    if (refresh && session?.setCookie) response.headers.append('Set-Cookie', session.setCookie);
    // No compression here: Next.js drops a route handler's Content-Encoding header (the client would get
    // gzip bytes labelled as plain JSON). Vercel's edge compresses responses itself.
    logRequest({
      route: name,
      status: response.status,
      code: failure?.code,
      errorId: failure?.errorId,
      dbCode: failure?.dbCode,
      ms: performance.now() - started,
    });
    return response;
  };
}

/** A route that requires a session. `name` is "METHOD /api/pattern" (used for the log line). */
export function authedRoute<P extends Params = Record<string, never>>(
  name: string,
  options: RouteOptions,
  handler: (ctx: AuthedContext<P>) => Promise<Response>,
) {
  return wrap<P>(name, options, true, handler as (ctx: AuthedContext<P> | PublicContext<P>) => Promise<Response>);
}

/** A route that does not require a session (only POST /api/session). */
export function publicRoute<P extends Params = Record<string, never>>(
  name: string,
  options: RouteOptions,
  handler: (ctx: PublicContext<P>) => Promise<Response>,
) {
  return wrap<P>(name, options, false, handler);
}
