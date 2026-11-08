// The breadcrumb trail (design §1.5): the last 30 things the collector saw, from every kind (aggregated ones too). A
// frustration or error event carries a copy, `tr: [[dt, code], ...]`, dt ≤ 0 ms before the event. Codes are tokens
// built from enums and attribute tokens only.
import { CRUMB_RE, TEL_LIMITS } from '../../telemetry';

export type Trail = Array<[number, string]>;

export class Crumbs {
  private readonly ring: Array<{ t: number; c: string }> = [];
  constructor(private readonly size: number = TEL_LIMITS.trail) {}

  add(t: number, code: string): void {
    const c = code.slice(0, 64);
    if (!CRUMB_RE.test(c)) return;
    this.ring.push({ t, c });
    if (this.ring.length > this.size) this.ring.shift();
  }

  /** The trail as seen at `now` (oldest first; every dt ≤ 0). */
  trail(now: number): Trail {
    return this.ring.map(({ t, c }) => [Math.min(0, Math.round(t - now)), c]);
  }

  clear(): void {
    this.ring.length = 0;
  }
}

/** Seconds with one decimal for a crumb ("0.3s"): no long digit runs in a trail. */
export function secs(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s >= 60) return `${Math.min(99, Math.round(s / 60))}m`;
  return s >= 10 ? `${Math.round(s)}s` : `${s.toFixed(1)}s`;
}

/** A status for a crumb: the status class, with the three named codes spelled out. */
export function crumbStatus(st: string): string {
  return st === '401' ? 'auth' : st === '409' ? 'conflict' : st === '429' ? 'limited' : st;
}
