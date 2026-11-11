// (Events, cut-over fix A1) An event route refuses a call that does not say which event it is for: no X-LP-Event
// header → 409 wrong_event, like a header naming another event (lib/server/route.ts); the create (POST /api/requests)
// gets a final 422 instead, so the old app shows it as not sent rather than retrying it forever. Only the old build's app, still
// served by its service worker on phones after the release, sends none; it must neither write into nor read a new
// event. A route whose calls cannot carry the header (an <img src>, sendBeacon, the service worker) opts out with
// `headerless: '<reason>'`, and only the routes listed below may: a new route cannot forget the check, and a request,
// message or photo write is never exempt.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const EVENT = '10ca1000-0000-4000-8000-000000000001';
const OTHER = '10ca1000-0000-4000-8000-000000000002';

let session: { eventId: string | null; role: 'staff' | 'lead' } = { eventId: EVENT, role: 'staff' };

vi.mock('@/lib/server/session', () => ({
  requireSession: async () => ({ claims: { pv: 0, team: 'Site Ops' }, eventId: session.eventId, role: session.role, staff: 'Dana Kent · Site Ops', setCookie: null }),
  clearedSessionCookie: () => 'lp_session=; Max-Age=0',
}));
vi.mock('@/lib/server/supabase', () => ({
  rpc: async () => ({ leadVersion: 0, event: session.eventId ? { id: session.eventId, stage: 'live' } : null }),
}));
vi.mock('@/lib/server/log', () => ({ logRequest: () => undefined }));

/** The routes whose calls cannot send X-LP-Event, each safe without it (the reason is on the route itself). */
const HEADERLESS = new Map([
  ['GET /api/photos/[id]', 'an <img src>; the photo is served only when its request is in the session event'],
  ['POST /api/telemetry', 'sendBeacon from a hidden page; diagnostics, no request data'],
  ['POST /api/push/subscribe', "the service worker's pushsubscriptionchange; binds the device to the session's own event"],
]);

const ROOT = join(__dirname, '..', '..');
const API = join(ROOT, 'app', 'api');

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return routeFiles(p);
    return name === 'route.ts' ? [p] : [];
  });
}

interface Declared {
  file: string;
  name: string;
  kind: 'authed' | 'public';
  options: string;
}

/** Every authedRoute / publicRoute call: its "METHOD /api/…" name and the source text of its options object. */
function declaredRoutes(): Declared[] {
  const out: Declared[] = [];
  for (const file of routeFiles(API)) {
    const src = readFileSync(file, 'utf8');
    const re = /\b(authedRoute|publicRoute)(?:<[^>]*>)?\(\s*'([^']+)',\s*\{/g;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      // The options object: from its `{` to the matching `}` (string contents skipped).
      let depth = 0;
      let i = m.index + m[0].length - 1;
      let quote: string | null = null;
      for (; i < src.length; i++) {
        const ch = src[i];
        if (quote) {
          if (ch === '\\') i++;
          else if (ch === quote) quote = null;
        } else if (ch === "'" || ch === '"' || ch === '`') quote = ch;
        else if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) break;
      }
      out.push({ file: relative(ROOT, file), name: m[2] as string, kind: m[1] === 'authedRoute' ? 'authed' : 'public', options: src.slice(m.index + m[0].length - 1, i + 1) });
    }
  }
  return out;
}

const eventRequired = (d: Declared) => d.kind === 'authed' && !/\bevent:\s*'optional'/.test(d.options);
const isHeaderless = (d: Declared) => /\bheaderless:/.test(d.options);

describe('every event route enforces X-LP-Event (or is on the reviewed headerless list)', () => {
  const routes = declaredRoutes();

  it('finds the routes, and every exported handler of a route file goes through the wrapper', () => {
    expect(routes.length).toBeGreaterThan(30);
    for (const file of routeFiles(API)) {
      const src = readFileSync(file, 'utf8');
      if (file.includes('[...unknown]')) continue; // the JSON 404 for any other /api path: no session, no data
      const handlers = [...src.matchAll(/export const (GET|POST|PATCH|PUT|DELETE)\s*=\s*(\w+)/g)];
      expect(handlers.length, relative(ROOT, file)).toBeGreaterThan(0);
      for (const h of handlers) expect(['authedRoute', 'publicRoute'], `${relative(ROOT, file)} ${h[1]}`).toContain(h[2]);
    }
  });

  it('an event-required route is headerless only when it is on the list, and the list has nothing else', () => {
    const headerless = routes.filter((d) => eventRequired(d) && isHeaderless(d)).map((d) => d.name);
    expect(headerless.sort()).toEqual([...HEADERLESS.keys()].sort());
    // On a route that needs no event the option means nothing: never set it there (it would read as an exemption).
    expect(routes.filter((d) => !eventRequired(d) && isHeaderless(d)).map((d) => d.name)).toEqual([]);
  });

  it('no route that creates or changes a request, message or photo is headerless', () => {
    for (const d of routes.filter(isHeaderless)) {
      const [method, path] = d.name.split(' ') as [string, string];
      expect(path.startsWith('/api/requests') && method !== 'GET', d.name).toBe(false);
    }
  });

  it('every event-required route of the new client is among the ones the wrapper checks', () => {
    // The ones the client calls (lib/client store, messages, activity, push, stats, health): all enforce the header.
    const enforced = routes.filter((d) => eventRequired(d) && !isHeaderless(d)).map((d) => d.name);
    for (const name of ['GET /api/sync', 'POST /api/requests', 'POST /api/requests/[id]/photos', 'POST /api/requests/[id]/messages', 'GET /api/stats', 'GET /api/activity/unread', 'GET /api/telemetry/health']) {
      expect(enforced, name).toContain(name);
    }
  });
});

describe('the wrapper (lib/server/route.ts)', () => {
  beforeEach(() => {
    session = { eventId: EVENT, role: 'staff' };
    vi.stubEnv('SESSION_SECRET', 'x'.repeat(48));
  });

  async function routes() {
    const { authedRoute } = await import('@/lib/server/route');
    const ok = async () => new Response('{"ok":true}', { status: 200 });
    return {
      // (The origin check is not under test here.)
      write: authedRoute('POST /api/requests', { sameOrigin: false }, ok),
      message: authedRoute('POST /api/requests/[id]/messages', { sameOrigin: false }, ok),
      photoUpload: authedRoute('POST /api/requests/[id]/photos', { sameOrigin: false }, ok),
      sync: authedRoute('GET /api/sync', {}, ok),
      photo: authedRoute('GET /api/photos/[id]', { headerless: 'an <img src>' }, ok),
      session: authedRoute('GET /api/session', { event: 'optional' }, ok),
    };
  }
  const call = async (handler: (r: Request, c: { params: Promise<Record<string, never>> }) => Promise<Response>, method: string, header?: string) => {
    const headers: Record<string, string> = { origin: 'https://lp.test' };
    if (header !== undefined) headers['x-lp-event'] = header;
    const res = await handler(new Request('https://lp.test/api/x', { method, headers, ...(method === 'GET' ? {} : { body: '{}' }) }), { params: Promise.resolve({}) });
    const body = (await res.json()) as { error?: { code?: string; message?: string; field?: string } };
    lastError = body.error ?? null;
    return { status: res.status, code: body.error?.code ?? null };
  };
  let lastError: { code?: string; message?: string; field?: string } | null = null;

  it("no header on the create (the old app's form or outbox): a final 422 with the message and no field", async () => {
    // The old client treats 422 + our error body as definitive: "Not sent · needs attention", the message on the item;
    // with no field it is not taken for a form error. A 409 it would retry forever, and the new build later drops it.
    const r = await routes();
    expect(await call(r.write, 'POST')).toEqual({ status: 422, code: 'invalid' });
    expect(lastError).toEqual({
      code: 'invalid',
      message: 'Not sent. This screen is out of date. Close the app, open it again, sign in, then log the request again.',
    });
    // With a header, the create is unaffected (another event: still 409).
    expect(await call(r.write, 'POST', OTHER)).toEqual({ status: 409, code: 'wrong_event' });
  });

  it('no header: 409 wrong_event on every other write and on GET /api/sync', async () => {
    const r = await routes();
    expect(await call(r.message, 'POST')).toEqual({ status: 409, code: 'wrong_event' });
    expect(await call(r.photoUpload, 'POST')).toEqual({ status: 409, code: 'wrong_event' });
    expect(await call(r.sync, 'GET')).toEqual({ status: 409, code: 'wrong_event' });
    // An empty header is no claim either.
    expect(await call(r.sync, 'GET', '')).toEqual({ status: 409, code: 'wrong_event' });
  });

  it("the session's event, or 'none' (a tab that knows no event yet), goes through as before; another event does not", async () => {
    const r = await routes();
    expect(await call(r.write, 'POST', EVENT)).toEqual({ status: 200, code: null });
    expect(await call(r.sync, 'GET', EVENT)).toEqual({ status: 200, code: null });
    expect(await call(r.sync, 'GET', 'none')).toEqual({ status: 200, code: null });
    expect(await call(r.write, 'POST', OTHER)).toEqual({ status: 409, code: 'wrong_event' });
  });

  it('a headerless route still answers without the header, but never for another event; an optional route needs none', async () => {
    const r = await routes();
    expect(await call(r.photo, 'GET')).toEqual({ status: 200, code: null });
    expect(await call(r.photo, 'GET', OTHER)).toEqual({ status: 409, code: 'wrong_event' });
    expect(await call(r.session, 'GET')).toEqual({ status: 200, code: null });
    expect(await call(r.session, 'GET', OTHER)).toEqual({ status: 200, code: null });
  });

  it('a lead with no event open still gets no_event first', async () => {
    session = { eventId: null, role: 'lead' };
    const r = await routes();
    expect(await call(r.sync, 'GET')).toEqual({ status: 409, code: 'no_event' });
  });
});
