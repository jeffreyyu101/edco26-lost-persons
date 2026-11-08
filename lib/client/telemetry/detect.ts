// Frustration detectors (design §1.6). Pure: every call passes the time in, nothing reads a clock, the DOM or layout.
// The collector (dom.ts) feeds them from its idle-time processing, never from an event handler.

/** ≥ 3 pointerdowns within 1,000 ms, all within 30 px of the first: one rage tap; that cluster is then silent 2 s. */
export const RAGE = { taps: 3, windowMs: 1_000, radiusPx: 30, silenceMs: 2_000 } as const;
/** ≥ 3 still swipes in one area within 10 s: one stuck scroll; 30 s cooldown per area. */
export const STUCK = { swipes: 3, windowMs: 10_000, cooldownMs: 30_000 } as const;
/** A close under 2 s is quick; a second quick close of the same sheet or view within 20 s is a loop. */
export const LOOP = { quickMs: 2_000, windowMs: 20_000 } as const;
/** A no-response watch: nothing visibly happened within 1 s of the tap. */
export const DEAD = { responseMs: 1_000 } as const;
/** A queued item held this long while online and live is stuck. */
export const STUCK_SEND_MS = 120_000;

/** Slow limits (ms): an /api/* request, and each timed flow. */
export const SLOW_MS: Readonly<Record<string, number>> = {
  api: 3_000,
  flow_answer: 3_000,
  flow_msg: 5_000,
  flow_submit: 10_000,
  flow_resume: 5_000,
  flow_open: 8_000,
};

export interface RageHit {
  k: number;
  /** The largest distance from the first tap (px). */
  r: number;
}

export class RageTap {
  private downs: Array<{ t: number; x: number; y: number }> = [];
  private silent: { until: number; x: number; y: number } | null = null;

  down(t: number, x: number, y: number): RageHit | null {
    this.downs = this.downs.filter((d) => t - d.t <= RAGE.windowMs);
    this.downs.push({ t, x, y });
    if (this.silent && t < this.silent.until && Math.hypot(x - this.silent.x, y - this.silent.y) <= RAGE.radiusPx) return null;
    // The cluster's first tap: the earliest recent one this tap is near.
    const first = this.downs.find((d) => Math.hypot(d.x - x, d.y - y) <= RAGE.radiusPx);
    if (!first) return null;
    const near = this.downs.filter((d) => d.t >= first.t && Math.hypot(d.x - first.x, d.y - first.y) <= RAGE.radiusPx);
    if (near.length < RAGE.taps) return null;
    const r = Math.round(Math.max(...near.map((d) => Math.hypot(d.x - first.x, d.y - first.y))));
    this.silent = { until: t + RAGE.silenceMs, x: first.x, y: first.y };
    this.downs = [];
    return { k: near.length, r };
  }
}

export type Dir = 'up' | 'down' | 'left' | 'right';

/** The direction of a gesture that moved (dx, dy): the finger's direction ("up" = the finger moved up). */
export function dirOf(dx: number, dy: number): Dir {
  if (Math.abs(dx) > Math.abs(dy)) return dx < 0 ? 'left' : 'right';
  return dy < 0 ? 'up' : 'down';
}

export interface StillSwipe {
  t: number;
  dir: Dir;
  prevented: boolean;
}

export interface StuckHit {
  k: number;
  dir: Dir;
  prev: number;
}

export class StuckScroll {
  private still = new Map<string, StillSwipe[]>();
  private cooldown = new Map<string, number>();

  /** A swipe in `area` that moved nothing. Returns a hit on the third within 10 s (then 30 s of cooldown there). */
  add(area: string, swipe: StillSwipe): StuckHit | null {
    const list = (this.still.get(area) ?? []).filter((s) => swipe.t - s.t <= STUCK.windowMs);
    list.push(swipe);
    this.still.set(area, list);
    if (list.length < STUCK.swipes) return null;
    const until = this.cooldown.get(area) ?? 0;
    if (swipe.t < until) return null;
    this.cooldown.set(area, swipe.t + STUCK.cooldownMs);
    this.still.set(area, []);
    const counts = new Map<Dir, number>();
    for (const s of list) counts.set(s.dir, (counts.get(s.dir) ?? 0) + 1);
    const dir = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? swipe.dir;
    return { k: list.length, dir, prev: list.filter((s) => s.prevented).length };
  }
}

/**
 * Whether a swipe moved nothing: no scroll event between its start and the end of its stillness window (`until`: 400 ms
 * after the finger lifted) came from the document or from an element containing its target.
 */
export function isStill<T>(
  startedAt: number,
  until: number,
  scrolls: ReadonlyArray<{ t: number; target: T }>,
  isDocument: (target: T) => boolean,
  contains: (target: T) => boolean,
): boolean {
  return !scrolls.some((s) => s.t >= startedAt && s.t <= until && (isDocument(s.target) || contains(s.target)));
}

export class Loop {
  private quick = new Map<string, number[]>();

  /** A sheet or view `id` closed after `dwell` ms at `t`. Returns {k, ms} on the second quick close within 20 s. */
  close(id: string, dwell: number, t: number): { k: number; ms: number } | null {
    if (dwell >= LOOP.quickMs) return null;
    const list = (this.quick.get(id) ?? []).filter((at) => t - at <= LOOP.windowMs);
    list.push(t);
    if (list.length >= 2) {
      this.quick.set(id, []);
      return { k: list.length, ms: Math.round(dwell) };
    }
    this.quick.set(id, list);
    return null;
  }
}

/** The look of something tappable (by its testid or class token), for a tap that landed on nothing interactive. */
export const TAPPABLE_LOOK = /(chip|card|row|badge|pill|tile|avatar|thumb|photo|glyph|icon|tab|link|btn|button)/;

/**
 * Ticking text (the live line, waits, and since 2026-11-08 the request's recheck countdown, its sentence and bar,
 * every 15 s): their mutations are not a response to a tap.
 */
export const TICKING = new Set([
  'live-text',
  'card-minutes',
  'wait-badge',
  'live-indicator',
  'live-announcement',
  'sort-announcement',
  'recheck-row',
  'recheck-when',
  'recheck-bar',
]);

/**
 * Whether a tap at `t` saw any response within DEAD.responseMs: a view or address change, an /api/* request, a
 * sheet, a focus change, a store emit or a DOM mutation (the newest time each was seen).
 */
export function responded(t: number, seen: ReadonlyArray<number | null | undefined>): boolean {
  return seen.some((at) => typeof at === 'number' && at >= t && at <= t + DEAD.responseMs + 250);
}

/** The client timeout a path's requests run with (lib/client/constants.ts and the store's callers). */
export function clientTimeoutMs(pattern: string, method: string): number {
  if (pattern.startsWith('/api/sync')) return 12_000;
  if (pattern === '/api/requests' && method === 'post') return 15_000;
  if (pattern.endsWith('/photos')) return 60_000;
  if (pattern === '/api/session') return 5_000;
  return 10_000;
}

/** An AbortError is a timeout when it came within 250 ms of the path's client timeout, else an abort. */
export function abortKind(pattern: string, method: string, elapsed: number): 'timeout' | 'abort' {
  return elapsed >= clientTimeoutMs(pattern, method) - 250 ? 'timeout' : 'abort';
}

/** Tracks queued items (outbox and message jobs) held continuously while online and live. */
export class StuckSend {
  private since = new Map<string, number>();
  private fired = new Set<string>();

  /**
   * The items queued now (`ids`), whether the phone is online and live, at `t`: returns the ids that just passed
   * STUCK_SEND_MS (each once) with their age.
   */
  check(ids: readonly string[], healthy: boolean, t: number): Array<{ id: string; age: number }> {
    const now = new Set(ids);
    for (const id of [...this.since.keys()]) if (!now.has(id)) this.since.delete(id);
    for (const id of [...this.fired]) if (!now.has(id)) this.fired.delete(id);
    const out: Array<{ id: string; age: number }> = [];
    for (const id of ids) {
      if (!healthy) {
        this.since.delete(id);
        continue;
      }
      const since = this.since.get(id) ?? t;
      this.since.set(id, since);
      if (t - since > STUCK_SEND_MS && !this.fired.has(id)) {
        this.fired.add(id);
        out.push({ id, age: Math.round((t - since) / 1000) });
      }
    }
    return out;
  }
}
