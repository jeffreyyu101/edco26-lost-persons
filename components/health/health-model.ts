// The Health page's data shape and its pure helpers: number formats, labels, targets, glyphs and the full-sentence
// screen-reader labels (visible text stays labels and values only, Brian's rule). No React here.
import type { HealthWindow, TeamKey } from '@/lib/telemetry';

export interface HealthConfig {
  on: boolean;
  enabled: boolean;
  until: number;
  flushSeconds: number;
  sample: number;
}

export interface Kpis {
  devices: number;
  sessions: number;
  events: number;
  frustrations: number;
  hitDevices: number;
  errors: number;
  syncOk: number | null;
  syncFail: number | null;
  pushRx: number;
  pushOpened: number;
  openP95: number | null;
  prev?: { devices: number; frustrations: number; hitDevices: number; errors: number };
}

export interface Problem {
  name: string;
  view: string | null;
  area: string | null;
  ctl: string | null;
  n: number;
  devices: number;
  teams: string[];
  lastAt: string;
  examples: number[];
}

export interface Example {
  id: number;
  name: string;
  at: string;
  team: string;
  view: string | null;
  area: string | null;
  ctl: string | null;
  ms: number | null;
  k: number | null;
  props: Record<string, unknown> | null;
  trail: Array<[number, string]> | null;
}

export interface FlowRow {
  name: string;
  out: string;
  n: number;
  p50: number | null;
  p95: number | null;
}

export interface NetRow {
  pattern: string;
  m: string | null;
  n: number;
  failed: number;
  timeouts: number;
  c4xx: number;
  p50: number | null;
  p95: number | null;
  states: Record<string, { n: number; failed: number }> | null;
}

export interface NetSection {
  rows: NetRow[];
  sync: { ok: number | null; fail: number | null; full: number | null; ageP95: number | null } | null;
}

export interface PushRow {
  kind: string | null;
  ok: number;
  gone: number;
  failed: number;
  rx: number;
  shown: number;
  opened: number;
  t50: number | null;
  t95: number | null;
}

export interface CoverageRow {
  team: string;
  devices: number;
  standalone: number;
  granted: number;
  pushsub: number;
  newreq: number;
  subs: number;
  subsNewreq: number;
  alerts: number;
  within30: number;
  p50: number | null;
}

export interface ErrorRow {
  fp: string | null;
  type: string | null;
  src: string | null;
  line: string | null;
  col: string | null;
  n: number;
  devices: number;
  teams: string[];
  views: string[];
  lastAt: string;
}

export interface HealthData {
  generatedAt: string;
  window: HealthWindow;
  /** (Events) The event's teams: telemetry keys a team by its id. */
  teams?: Array<{ id: string; short: string }>;
  /** (Events) The event's time zone. */
  timeZone?: string | null;
  config: HealthConfig | null;
  kpis: Kpis | null;
  problems: Problem[] | null;
  examples: Example[] | null;
  flows: FlowRow[] | null;
  net: NetSection | null;
  push: PushRow[] | null;
  coverage: CoverageRow[] | null;
  errors: ErrorRow[] | null;
}

export const DASH = '—';

/** lib/telemetry.ts HEALTH_WINDOWS (a test keeps them equal; not imported, so this chunk shares nothing with `/`). */
export const WINDOWS: readonly HealthWindow[] = ['1h', '3h', '12h', 'all'];
/** lib/telemetry.ts TEL_KEYS.health: set once /health was opened on this device (the desk sidebar's link). */
export const HEALTH_SEEN_KEY = 'lp-health';

/** "420 ms", "1.2 s", "2.6 m", "1.1 h", or "—". */
export function fmtMs(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return DASH;
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} m`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

/** A duration in words for a screen reader ("1.2 seconds"). */
export function sayMs(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return 'no data';
  if (ms < 1_000) return `${Math.round(ms)} milliseconds`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} seconds`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} minutes`;
  return `${(ms / 3_600_000).toFixed(1)} hours`;
}

/** "98.6 %" or "—" (no denominator). */
export function pct(n: number | null | undefined, d: number | null | undefined): string {
  if (typeof n !== 'number' || typeof d !== 'number' || d <= 0) return DASH;
  const v = (100 * n) / d;
  return `${v >= 99.95 || v === 0 ? Math.round(v) : v.toFixed(1)} %`;
}

export function num(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : DASH;
}

/** How long before `ref` an ISO time was: "now", "4 m", "2 h", "3 d". */
export function ago(iso: string | null | undefined, ref: number): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return DASH;
  const s = Math.max(0, (ref - t) / 1000);
  if (s < 60) return 'now';
  if (s < 3_600) return `${Math.round(s / 60)} m`;
  if (s < 86_400) return `${Math.round(s / 3_600)} h`;
  return `${Math.round(s / 86_400)} d`;
}

export function sayAgo(iso: string | null | undefined, ref: number): string {
  const a = ago(iso, ref);
  if (a === DASH) return 'at an unknown time';
  if (a === 'now') return 'just now';
  const [n, u] = a.split(' ');
  const unit = u === 'm' ? 'minute' : u === 'h' ? 'hour' : 'day';
  return `${n} ${unit}${n === '1' ? '' : 's'} ago`;
}

/**
 * (Events) The page's event: its team names (telemetry keys a team by EventTeam.id; 'other' is anyone outside them) and
 * time zone, from the last answer (applyHealthEvent sets them before the panels render).
 */
let healthTeams: ReadonlyArray<{ id: string; short: string }> = [];
let healthZone: string | undefined;
export function applyHealthEvent(data: Pick<HealthData, 'teams' | 'timeZone'>): void {
  healthTeams = data.teams ?? [];
  healthZone = data.timeZone ?? undefined;
}

export function teamLabel(team: TeamKey): string {
  if (team === 'other') return 'Other';
  return healthTeams.find((t) => t.id === team)?.short ?? team;
}

/** "Medical and Dispatch", "Medical, Dispatch and Other". */
export function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

const VIEW_WORDS: Readonly<Record<string, string>> = {
  all: 'All requests',
  pending: 'Pending',
  mine: 'My requests',
  search: 'Search',
  new: 'the new request form',
  profile: 'the request page',
  edit: 'the edit form',
  dashboard: 'the dashboard',
  outbox: 'the outbox editor',
  unknown: 'an unknown view',
};

export function viewWords(view: string | null): string {
  return VIEW_WORDS[view ?? 'unknown'] ?? 'an unknown view';
}

export type SignalColor = 'amber' | 'red' | 'orange' | 'violet' | 'blue' | 'gray';

export const SIGNALS: Readonly<Record<string, { label: string; color: SignalColor }>> = {
  stuck_scroll: { label: 'Stuck scroll', color: 'amber' },
  rage_tap: { label: 'Rage tap', color: 'red' },
  dead_tap: { label: 'Dead tap', color: 'orange' },
  loop: { label: 'Loop', color: 'violet' },
  slow: { label: 'Slow', color: 'amber' },
  pinch: { label: 'Pinch', color: 'blue' },
  error: { label: 'Error', color: 'red' },
  stuck_send: { label: 'Stuck send', color: 'red' },
};

export function signalLabel(name: string): string {
  return SIGNALS[name]?.label ?? name;
}

/** The problem row's screen-reader sentence. */
export function problemSentence(p: Problem, ref: number): string {
  const where = [p.area ? `in ${p.area}` : null, `on ${viewWords(p.view)}`, p.ctl ? `at ${p.ctl}` : null].filter(Boolean).join(' ');
  const teams = listWords(p.teams.map(teamLabel));
  return `${signalLabel(p.name)} ${where}: ${p.n} time${p.n === 1 ? '' : 's'} on ${p.devices} device${p.devices === 1 ? '' : 's'}${teams ? `, ${teams}` : ''}, last ${sayAgo(p.lastAt, ref)}.`;
}

export interface PathDef {
  name: string;
  label: string;
  /** p95 target (ms), or null when the path has none. */
  target: number | null;
}

export const PATHS: readonly PathDef[] = [
  { name: 'flow_open', label: 'Open → fresh data', target: 3_000 },
  { name: 'flow_resume', label: 'Resume → fresh data', target: 2_000 },
  { name: 'flow_new', label: 'New request → submit', target: null },
  { name: 'flow_submit', label: 'Submit → server', target: 5_000 },
  { name: 'flow_answer', label: 'Answer → server', target: 2_000 },
  { name: 'flow_msg', label: 'Message → delivered', target: 3_000 },
  { name: 'flow_read', label: 'Delivered → read', target: null },
  { name: 'flow_push', label: 'Push open → shown', target: 3_000 },
  { name: 'flow_alert', label: 'New request → alert', target: 15_000 },
];

/** The good outcome of each path: its p50 / p95 come from these rows only. */
export const GOOD_OUT: Readonly<Record<string, readonly string[]>> = {
  flow_open: ['ok'],
  flow_resume: ['ok'],
  flow_new: ['submit'],
  flow_submit: ['ok'],
  flow_answer: ['ok', 'same'],
  flow_msg: ['ok'],
  flow_read: ['ok'],
  flow_push: ['ok'],
  flow_alert: ['ok', 'toast', 'push'],
};

export interface PathSummary {
  def: PathDef;
  n: number;
  p50: number | null;
  p95: number | null;
  outs: Array<{ out: string; n: number }>;
}

/** One row per path: n over every outcome, p50 / p95 of the good outcome (the busiest such row). */
export function summarizePaths(rows: readonly FlowRow[]): PathSummary[] {
  return PATHS.map((def) => {
    const mine = rows.filter((r) => r.name === def.name);
    const good = mine.filter((r) => (GOOD_OUT[def.name] ?? ['ok']).includes(r.out)).sort((a, b) => b.n - a.n)[0];
    return {
      def,
      n: mine.reduce((s, r) => s + r.n, 0),
      p50: good?.p50 ?? null,
      p95: good?.p95 ?? null,
      outs: mine.map((r) => ({ out: r.out, n: r.n })).sort((a, b) => b.n - a.n),
    };
  });
}

export type Grade = 'ok' | 'warn' | 'bad' | 'none';

/** ✓ within the target, ↑ within twice it, ↑↑ past that. */
export function grade(p95: number | null, target: number | null): Grade {
  if (p95 === null || target === null) return 'none';
  if (p95 <= target) return 'ok';
  return p95 <= 2 * target ? 'warn' : 'bad';
}

export const GRADE_GLYPH: Readonly<Record<Grade, string>> = { ok: '✓', warn: '↑', bad: '↑↑', none: '' };
export const GRADE_COLOR: Readonly<Record<Grade, 'green' | 'amber' | 'red' | 'gray'>> = { ok: 'green', warn: 'amber', bad: 'red', none: 'gray' };
export const GRADE_WORDS: Readonly<Record<Grade, string>> = { ok: 'within target', warn: 'over target', bad: 'more than twice the target', none: 'no target' };

/** A KPI's change against the previous window of the same length: the glyph and whether up is bad. */
export function trend(now: number | null | undefined, before: number | null | undefined, upIsBad = true): { glyph: string; color: 'red' | 'green' | 'gray'; words: string } | null {
  if (typeof now !== 'number' || typeof before !== 'number') return null;
  if (now === before) return { glyph: '→', color: 'gray', words: 'unchanged from the previous window' };
  const up = now > before;
  return { glyph: up ? '↑' : '↓', color: up === upIsBad ? 'red' : 'green', words: `${up ? 'up' : 'down'} from ${before} in the previous window` };
}

/** The crumb's kind, for its glyph. */
export function crumbKind(code: string): 'view' | 'tap' | 'swipe' | 'sheet' | 'net' | 'online' | 'offline' | 'toast' | 'key' | 'field' | 'error' | 'other' {
  if (code.startsWith('v>')) return 'view';
  if (code.startsWith('t:')) return 'tap';
  if (code.startsWith('w')) return 'swipe';
  if (code.startsWith('s+') || code.startsWith('s-')) return 'sheet';
  if (code.startsWith('n:')) return 'net';
  if (code === 'x:online' || code === 'c:live' || code === 'u') return 'online';
  if (code === 'x:offline' || code.startsWith('c:') || code === 'h') return 'offline';
  if (code.startsWith('toast:')) return 'toast';
  if (code.startsWith('k:') || code.startsWith('kb')) return 'key';
  if (code.startsWith('f:')) return 'field';
  if (code.startsWith('e:')) return 'error';
  return 'other';
}

/** "−12.4 s". */
export function fmtDt(dt: number): string {
  return `−${(Math.abs(dt) / 1000).toFixed(1)} s`;
}

/** A clock time in the event's zone ("10:42 PM"). */
export function fmtClock(iso: string, timeZone: string | undefined = healthZone): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return DASH;
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone }).format(new Date(t));
}

/** The network-state split's labels. */
export const STATE_LABEL: Readonly<Record<string, string>> = { live: 'live', error: 'error', offline: 'offline', link_down: 'link down', unk: 'unknown' };
