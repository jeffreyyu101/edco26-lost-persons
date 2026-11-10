// (Events, lead screens) The lead screens' calls to the lead routes (PR #32): GET/POST /api/events, GET/PATCH
// /api/events/:id, its password, join link, logo and stage routes, POST /api/session/event and POST
// /api/org/lead-passcode. Every call has a timeout and never throws. A 401 (the session ended, or another lead changed
// the passcode) goes to sign-in and comes back here. Never logs anything: bodies hold passwords and passcodes.
import type { ApiError, EventAdmin, SessionInfo } from '@/lib/api-types';

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; code: string; message: string; field?: string };

const TIMEOUT_MS = 15_000;

/** Calls in flight, and the hold a passcode change puts on new ones (see changeLeadPasscode). */
const inflight = new Set<Promise<unknown>>();
let hold: Promise<void> | null = null;

/** Where a 401 sends the lead: sign-in, then back to this screen. */
export function signInAgain(): void {
  const here = `${window.location.pathname}${window.location.search}`;
  window.location.replace(`/signin?next=${encodeURIComponent(here)}`);
}

interface CallOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  json?: unknown;
  form?: FormData;
  /** Default: a 401 goes to sign-in. False: the caller handles it. */
  redirectOn401?: boolean;
}

async function send<T>(path: string, opts: CallOptions): Promise<ApiResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(path, {
      method: opts.method ?? 'GET',
      headers: opts.json !== undefined ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
      body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.form,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // not our API's answer: the status decides
    }
    if (res.ok) return { ok: true, status: res.status, data: body as T };
    const err = (body as ApiError | null)?.error;
    if (res.status === 401 && opts.redirectOn401 !== false) signInAgain();
    return {
      ok: false,
      status: res.status,
      code: typeof err?.code === 'string' ? err.code : 'http',
      message: typeof err?.message === 'string' ? err.message : "Couldn't save. Try again",
      ...(typeof err?.field === 'string' ? { field: err.field } : {}),
    };
  } catch {
    return { ok: false, status: 0, code: 'network', message: "Couldn't reach the server" };
  } finally {
    clearTimeout(timer);
  }
}

/** One call, after any passcode change in progress. */
export async function leadCall<T>(path: string, opts: CallOptions = {}): Promise<ApiResult<T>> {
  while (hold) await hold;
  const p = send<T>(path, opts);
  inflight.add(p);
  try {
    return await p;
  } finally {
    inflight.delete(p);
  }
}

const enc = encodeURIComponent;

export const api = {
  session: () => leadCall<SessionInfo>('/api/session'),
  list: () => leadCall<{ events: EventAdmin[] }>('/api/events'),
  get: (id: string) => leadCall<{ event: EventAdmin }>(`/api/events/${enc(id)}`),
  create: (settings: Record<string, unknown>) => leadCall<{ event: EventAdmin }>('/api/events', { method: 'POST', json: settings }),
  update: (id: string, patch: Record<string, unknown>) => leadCall<{ event: EventAdmin }>(`/api/events/${enc(id)}`, { method: 'PATCH', json: patch }),
  setPassword: (id: string, password: string) => leadCall<{ event: EventAdmin }>(`/api/events/${enc(id)}/password`, { method: 'POST', json: { password } }),
  newJoinLink: (id: string) => leadCall<{ link: string; expiresAt: string; event: EventAdmin }>(`/api/events/${enc(id)}/join-link`, { method: 'POST', json: {} }),
  uploadLogo: (id: string, file: Blob) => {
    const form = new FormData();
    form.append('logo', file);
    return leadCall<{ event: EventAdmin }>(`/api/events/${enc(id)}/logo`, { method: 'POST', form });
  },
  removeLogo: (id: string) => leadCall<{ event: EventAdmin }>(`/api/events/${enc(id)}/logo`, { method: 'DELETE' }),
  goLive: (id: string) => leadCall<{ event: EventAdmin; deleted: number }>(`/api/events/${enc(id)}/go-live`, { method: 'POST' }),
  end: (id: string) => leadCall<{ event: EventAdmin }>(`/api/events/${enc(id)}/end`, { method: 'POST' }),
  reopen: (id: string) => leadCall<{ event: EventAdmin }>(`/api/events/${enc(id)}/reopen`, { method: 'POST' }),
  /** A lead opens an event (a re-issued cookie with it); null goes back to no event open. */
  open: (eventId: string | null) => leadCall<SessionInfo>('/api/session/event', { method: 'POST', json: { eventId } }),
  signOut: () => leadCall<{ ok: true }>('/api/session', { method: 'DELETE', redirectOn401: false }),
};

/** Opens `eventId` in this session and goes to the app (`/`), its log. False when it could not be opened. */
export async function openEvent(eventId: string): Promise<ApiResult<SessionInfo>> {
  const res = await api.open(eventId);
  // A full navigation: `/` starts its store afresh on the event now open.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  if (res.ok) window.location.assign('/');
  return res;
}

export type PasscodeOutcome = { ok: true } | { ok: false; signedOut: true } | { ok: false; signedOut: false; message: string; field?: string };

/**
 * Changes the Ground Control lead passcode (POST /api/org/lead-passcode). The change signs every lead session out,
 * and the server re-issues this one's cookie. A call of this page that read the passcode version after the change
 * but still carried the old cookie answers 401 and clears the cookie, possibly after the new one was set. So: no new
 * call starts until the change is over, the ones in flight finish first, and afterwards the session is checked; if
 * a late 401 cleared it, the lead is signed in again with the new passcode (they just typed it). Only if that fails
 * too does the page go to sign-in.
 */
export async function changeLeadPasscode(passcode: string, who: { staffName: string; team: string }): Promise<PasscodeOutcome> {
  while (hold) await hold;
  let release: () => void = () => undefined;
  hold = new Promise<void>((r) => {
    release = r;
  });
  try {
    await Promise.allSettled([...inflight]);
    const res = await send<{ ok: true }>('/api/org/lead-passcode', { method: 'POST', json: { passcode }, redirectOn401: false });
    if (!res.ok) {
      if (res.status === 401) return { ok: false, signedOut: true };
      return { ok: false, signedOut: false, message: res.message, ...(res.field ? { field: res.field } : {}) };
    }
    const check = await send<SessionInfo>('/api/session', { redirectOn401: false });
    if (check.ok || check.status !== 401) return { ok: true };
    const again = await send<SessionInfo>('/api/session', {
      method: 'POST',
      json: { staffName: who.staffName, team: who.team, password: passcode },
      redirectOn401: false,
    });
    return again.ok ? { ok: true } : { ok: false, signedOut: true };
  } finally {
    hold = null;
    release();
  }
}
