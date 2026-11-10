// (Events) X-LP-Event for the API calls the TESTS make (page.request, context.request, the request fixture). An event
// route answers a call that does not say which event it is for 409 wrong_event (lib/server/route.ts): the new
// client always says it (lib/client/store-core.ts call()), and the tests' own setup calls act as that client does,
// naming the event of the session cookie they send. Imported for its effect by every spec (through helpers/session.ts
// or directly); it changes nothing the browser sends, so the app's own calls are still checked by the server.
// A call that sets X-LP-Event itself is left alone; `'x-lp-event': ''` sends none (the old build's app).
import { request, type APIRequestContext } from '@playwright/test';

const SESSION_COOKIE = 'lp_session';
const PATCHED = Symbol.for('lp.e2e.apiEvent');

/** The event a session token names ('none' for none), or null when it is not a readable session token. */
export function tokenEvent(token: string | undefined): string | null {
  const payload = token?.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { eventId?: unknown };
    return typeof claims.eventId === 'string' && claims.eventId ? claims.eventId : 'none';
  } catch {
    return null;
  }
}

function fromCookieHeader(header: string): string | undefined {
  return header
    .split(/;\s*/)
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
}

function isApiPath(url: string): boolean {
  try {
    return new URL(url, 'http://lp.invalid').pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

type FetchOptions = NonNullable<Parameters<APIRequestContext['fetch']>[1]>;
type Fetch = APIRequestContext['fetch'];

async function install(): Promise<void> {
  const probe = await request.newContext();
  const proto = Object.getPrototypeOf(probe) as { fetch: Fetch; [PATCHED]?: true };
  await probe.dispose();
  if (proto[PATCHED]) return;
  const original = proto.fetch;
  proto.fetch = async function fetch(this: APIRequestContext, urlOrRequest, options: FetchOptions = {}) {
    if (typeof urlOrRequest !== 'string' || !isApiPath(urlOrRequest)) return original.call(this, urlOrRequest, options);
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    const set = Object.keys(headers).find((h) => h.toLowerCase() === 'x-lp-event');
    if (set !== undefined) {
      if (headers[set] === '') delete headers[set];
      return original.call(this, urlOrRequest, { ...options, headers });
    }
    const explicit = Object.entries(headers).find(([h]) => h.toLowerCase() === 'cookie')?.[1];
    const token = explicit !== undefined ? fromCookieHeader(explicit) : (await this.storageState()).cookies.find((c) => c.name === SESSION_COOKIE)?.value;
    const event = tokenEvent(token);
    if (event) headers['x-lp-event'] = event;
    return original.call(this, urlOrRequest, { ...options, headers });
  } as Fetch;
  proto[PATCHED] = true;
}

await install();
