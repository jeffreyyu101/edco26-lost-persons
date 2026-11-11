// The wrapper every API route handler goes through (spec §6 "Every route"):
//   * same-origin check for mutations (403 bad_origin), before anything else
//   * session required (401) except where a route opts out; sliding cookie re-issue (> 1 h old)
//   * every failure → {error: {code, message, id?}} with Cache-Control: no-store; anything unexpected → 503
//     with an error id
//   * one log line per failure / slow request: route pattern, status, code, error id, db code, timing only
//   * (Events) the event comes from the session, never from the client: a route needs one (409 no_event for a lead
//     with none open) unless it opts out; lead-only routes answer 403 to staff. An archived event's writes fail in
//     SQL with P0410, mapped to 410 event_ended (lib/server/errors.ts).
//   * (Phase 2) a request whose X-LP-Event header names another event than the session's: 409 wrong_event (a tab still
//     working event A must never write into event B, signed in meanwhile in another tab). An event route answers a
//     call with no header the same (the old build's app), unless the route is marked `headerless` with its reason.
//   * (Events) one lp_session_state call per signed-in request:
//       - staff of an archived event: 410 event_ended with the event block the Ended screen shows, on EVERY route
//         (reads included: a phone that only polls learns the event ended), except the few marked `afterEnd`
//         (sign-out, removing the device's push subscription). GET /api/session answers the same 410, so a reload
//         lands on the Ended screen rather than on sign-in. Leads are not stopped: they keep reading an ended event.
//       - a lead whose token carries an older lead passcode version than lp_org's: 401, and the cookie is cleared (a
//         passcode change signs every lead out).
// Server only.
import 'server-only';
import { EnvError } from './env';
import { ApiFailure } from './errors';
import { eventEndedFailure, type EventRow } from './events';
import { assertSameOrigin, json } from './http';
import { logRequest } from './log';
import { clearedSessionCookie, requireSession, type ActiveSession } from './session';
import { rpc } from './supabase';

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
  /** (Events) Staff of an archived event may still call it (sign-out, push unsubscribe). Default false: 410. */
  afterEnd?: boolean;
  /**
   * (Events) An event route answers a call with no X-LP-Event header 409 wrong_event (the old build's app sends none).
   * Set this, to the one-line reason, only for a call that cannot carry the header (an <img src>, sendBeacon, the
   * service worker) and is safe without it. Never on a route that creates or changes a request, message or photo.
   * tests/unit/route-event-header.test.ts keeps the list.
   */
  headerless?: string;
}

export interface PublicContext<P extends Params> {
  request: Request;
  params: P;
}

export interface AuthedContext<P extends Params> extends PublicContext<P> {
  session: ActiveSession;
  /** (Events) The session's event id; '' only on an `event: 'optional'` route whose session has none. */
  eventId: string;
  /** (Events) The session's event as the wrapper read it for this request (null: none open). */
  event: EventRow | null;
}

interface SessionState {
  leadVersion: number;
  event: EventRow | null;
}

/** (Cut-over) The one event route whose headerless call (the old build's app) is refused for good, not with 409. */
const OLD_APP_CREATE = 'POST /api/requests';
export const OLD_APP_CREATE_MESSAGE =
  'Not sent. This screen is out of date. Close the app, open it again, sign in, then log the request again.';

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
    let event: EventRow | null = null;
    let clearCookie = false;
    try {
      if (sameOrigin) assertSameOrigin(request);
      if (needsSession) {
        session = await requireSession(request);
        if (options.lead && session.role !== 'lead') throw new ApiFailure('forbidden', 'Leads only');
        const state = await rpc<SessionState | null>('lp_session_state', { p_event: session.eventId });
        event = state?.event ?? null;
        if (session.role === 'lead' && session.claims.pv !== Number(state?.leadVersion ?? 0)) {
          // Signed in with a lead passcode that has since changed.
          session = null;
          clearCookie = true;
          throw new ApiFailure('unauthorized');
        }
        if (session.role === 'staff') {
          if (!event) throw new ApiFailure('unauthorized');
          if (event.stage === 'archived' && !options.afterEnd) {
            session = null; // no sliding re-issue for an ended event's session
            throw eventEndedFailure(event);
          }
        }
        if ((options.event ?? 'required') === 'required' && !session.eventId) throw new ApiFailure('no_event');
        // (Phase 2) The tab says which event its request is for (X-LP-Event): another than the cookie's (signed in to
        // another event in another tab) is refused, so a queued write of event A never lands in event B.
        // Routes that serve any session (GET /api/session above all: how the tab learns the cookie's event) are exempt.
        // No header at all is refused the same way: only the old build's app (cached by its service worker) sends none,
        // and it must neither write into nor read a new event. It retries 409 quietly, so it stays inert. 'none' (a tab
        // that knows no event yet) still goes through.
        const claimed = request.headers.get('x-lp-event');
        if ((options.event ?? 'required') === 'required') {
          // The log line tells the two apart: dbCode 'no_header' is the old build's app.
          if (claimed === null && !options.headerless) {
            // The old app retries a 409 forever and later loses the item: its create gets a final 422 instead, which it
            // shows on the item as "Not sent · needs attention" with this message (no field, so no form error).
            if (name === OLD_APP_CREATE) throw new ApiFailure('invalid', OLD_APP_CREATE_MESSAGE, { dbCode: 'no_header' });
            throw new ApiFailure('wrong_event', undefined, { dbCode: 'no_header' });
          }
          if (claimed !== null && claimed !== 'none' && claimed !== session.eventId) throw new ApiFailure('wrong_event');
        }
      }
      const params = (await context.params) as P;
      response = await handler(session ? { request, params, session, eventId: session.eventId ?? '', event } : { request, params });
    } catch (error) {
      failure = failureFrom(error);
      response = json(failure.body(), failure.status, failure.headers);
    }
    if (clearCookie) response.headers.append('Set-Cookie', clearedSessionCookie(request));
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
