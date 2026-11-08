// In-house telemetry (Brian 2026-11-08 ~00:50: "lets try to log everything so we can make actionabile improvements";
// design/references/observability-design.md). The constants the phone's collector (lib/client/telemetry/*, a lazy
// chunk), the ingest route's zod schema (lib/server/telemetry.ts) and the SQL CHECKs share. Pure: no zod, no React.
//
// Privacy by construction: an event is numbers, booleans, enum tokens and attribute-derived tokens only. A token can't
// hold a space, a capital, an @ or a long digit run, so names, phone numbers and message text can't pass even by
// mistake; the collector never reads screen text in the first place.
import { canonicalTeam } from './domain';

export const TEL_VERSION = 1;
export const TEL_PATH = '/api/telemetry';
/** The gzip body's content type (no Content-Encoding header: Next.js and Vercel treat one specially). */
export const TEL_GZIP_TYPE = 'application/x-lp-tel+gzip';

/** Every event name (design §1.4): 37. */
export const EVENT_NAMES = [
  // lifecycle and navigation
  'app_start',
  'view',
  'sheet',
  'vis',
  'sw',
  'device_state',
  // interaction
  'tap',
  'swipe',
  'key',
  'field',
  'img_fail',
  // frustration
  'stuck_scroll',
  'rage_tap',
  'dead_tap',
  'loop',
  'slow',
  'pinch',
  'error',
  'stuck_send',
  // flows
  'flow_open',
  'flow_resume',
  'flow_new',
  'flow_submit',
  'flow_answer',
  'flow_msg',
  'flow_read',
  'flow_push',
  'flow_alert',
  // network, state, push and server
  'net',
  'sync',
  'link',
  'outbox',
  'vitals',
  'push_rx',
  'notif_click',
  'push_send',
  'tel_switch',
] as const;
export type EventName = (typeof EVENT_NAMES)[number];

/** Written by the server only: refused from a phone. */
export const SERVER_ONLY_EVENTS: readonly EventName[] = ['push_send', 'tel_switch'];
/** Frustration signals: the only events that carry a breadcrumb trail (`tr`). */
export const FRUSTRATION = ['stuck_scroll', 'rage_tap', 'dead_tap', 'loop', 'slow', 'pinch', 'error', 'stuck_send'] as const satisfies readonly EventName[];
/** Kept as counts in memory and written as one row per key when a batch is built. */
export const AGGREGATES = ['tap', 'swipe', 'key', 'field', 'img_fail', 'net', 'sync', 'outbox'] as const satisfies readonly EventName[];
/** Aggregates that `sample` thins out (frustration, errors, flows, net, state and push are always kept). */
export const SAMPLED = ['tap', 'swipe', 'key', 'field'] as const satisfies readonly EventName[];

/** lib/client/nav.ts View['name'], plus unknown. */
export const VIEWS = ['all', 'pending', 'mine', 'search', 'new', 'profile', 'edit', 'dashboard', 'outbox', 'unknown'] as const;
export type TelView = (typeof VIEWS)[number];

/** The only keys an event's `p` may hold (design §1.4). */
export const PROP_KEYS = [
  'nav', 'cold', 'ttfb', 'dcl', 'load', 'fcp', 'upd',
  'from', 'lay', 'filter', 'pane',
  'role', 'how', 'what',
  'perm', 'notif', 'push', 'newreq', 'sa', 'badge',
  'ptr', 'up', 'down', 'left', 'right', 'still', 'prev', 'input',
  'dir', 'edge', 'sheet', 'kb', 'inter', 'r', 'why',
  'm', 'st', 'on', 'conn', 'eff', 'scale', 'touches',
  'type', 'kind', 'line', 'col', 'fp',
  'q', 'depth', 'age',
  'out', 'cache', 'api', 'away',
  's_post', 's_person', 's_more', 's_friend', 's_photo', 'fields', 'photos', 'inval', 'desk',
  'tries', 'offline', 'to', 'queued', 'lag', 'src', 'via', 'route', 'seen', 'vis', 'skew',
  'd', 'bytes', 'retry', 'ok', 'fail', 'full', 'max', 'end', 'attn', 'mq',
  'lcp', 'cls', 'inp', 'lt', 'ltms', 'front', 'shown', 'silent', 'gone', 'failed', 'sampled',
] as const;
export type PropKey = (typeof PROP_KEYS)[number];

/**
 * Areas (design §1.3): the data-testids that name a region of the app. `#` stands for any digit run, so
 * `pending-column-2` is `pending-column-#`.
 */
export const AREAS = [
  'request-list', 'pending-board', 'pending-column-#', 'pending-section-#', 'profile', 'thread', 'composer', 'messages',
  'request-form', 'alerts-sheet', 'activity-sheet', 'activity-panel', 'activity-popover', 'enroute-sheet', 'location-form',
  'photo-viewer', 'crop-frame', 'desk-sidebar', 'desk-rail', 'desk-topbar', 'desk-pane', 'desk-table-view', 'dashboard',
  'brand-card',
] as const;

/** Request-form field keys (the suffix of the input's id after React's useId prefix), lowercased. */
export const FORM_FIELDS = [
  'name', 'age', 'gender', 'lastseen', 'clothing', 'hair', 'heightbuild', 'identifyingfeatures', 'physicaldescription',
  'additionalnotes', 'contactname', 'contactphone', 'contactrelationship', 'contactnotes', 'otherlocation',
] as const;
/** Request-form sections. */
export const FORM_SECTIONS = ['post', 'person', 'more', 'friend', 'photo', 'field'] as const;

/** Named keys counted outside text fields (`/` is `slash`). */
export const KEYS = ['escape', 'enter', 'arrowup', 'arrowdown', 'j', 'k', 'n', 'slash'] as const;

/** A token (area, control, error type, crumb): lowercase, no spaces, digit runs already `#`. */
export const TOKEN_SOURCE = '^[a-z0-9/][a-z0-9_.:#/-]{0,63}$';
export const TOKEN_RE = new RegExp(TOKEN_SOURCE);
/**
 * A breadcrumb code (design §1.5): a token's characters plus the four markers the codes use (`v>pending`,
 * `s+alerts-sheet`, `w!^:thread:u`). Still no space, capital or @.
 */
export const CRUMB_SOURCE = '^[a-z0-9/][a-z0-9_.:#/>+!^-]{0,63}$';
export const CRUMB_RE = new RegExp(CRUMB_SOURCE);
/** An enum value inside `p`. */
export const ENUM_SOURCE = '^[a-z0-9_.:-]{1,24}$';
export const ENUM_RE = new RegExp(ENUM_SOURCE);

export const PLATFORMS = ['ios', 'android', 'mac', 'windows', 'linux', 'other'] as const;
export const ENGINES = ['webkit', 'blink', 'gecko', 'other'] as const;
export const LAYOUTS = ['phone', 'tablet', 'laptop', 'desktop'] as const;
export const EFFECTIVE = ['na', 'slow-2g', '2g', '3g', '4g'] as const;

/** Team keys: the server derives one from the session, never from the phone. */
export const TEAM_KEYS = ['medical', 'dispatch', 'base', 'transpo', 'other'] as const;
export type TeamKey = (typeof TEAM_KEYS)[number];

const TEAM_KEY_OF: Readonly<Record<string, TeamKey>> = {
  Medical: 'medical',
  'GC/HX - Dispatch': 'dispatch',
  'GC/HX - Base': 'base',
  'GC/HX - Special Operations/Med Transpo': 'transpo',
};

/** The team key for a session's team (canonical, alias or custom text): custom text is `other`. */
export function teamKey(team: string | null | undefined): TeamKey {
  if (typeof team !== 'string' || !team.trim()) return 'other';
  return TEAM_KEY_OF[canonicalTeam(team)] ?? 'other';
}

/** Limits (design §4.5, §2 caps). */
export const TEL_LIMITS = {
  /** Breadcrumbs carried by a frustration event. */
  trail: 30,
  /** Discrete events kept in memory. */
  memory: 500,
  /** Events kept in the IndexedDB ring. */
  idb: 500,
  /** Events per batch. */
  batchEvents: 300,
  /** JSON bytes per batch (and the wire cap). */
  batchBytes: 48 * 1024,
  /** Inflated body cap on the server (a gzip bomb stops here). */
  inflatedBytes: 256 * 1024,
  /** After a 5xx, network error or timeout: no send for this long. */
  backoffMs: 5 * 60_000,
  /** A batch is dropped after this many failed sends. */
  maxTries: 3,
  /** Discrete events wait at least this long between sends (aggregates: 5 times as long). */
  flushSeconds: 60,
  aggregateFactor: 5,
  /** Keys in one event's `p`. */
  props: 24,
  /** Durations in one `net` row's `d`. */
  durations: 120,
  /** Stored batches older than this are dropped at load. */
  storedMaxAgeMs: 24 * 60 * 60_000,
  /** After the server said off: the next probe. */
  offProbeMs: 30 * 60_000,
  /** The send itself is aborted after this long. */
  sendTimeoutMs: 8_000,
} as const;

export { TEL_DEFAULT_UNTIL, TEL_KEYS } from './telemetry-keys';

/** The pass-through fetch observer (design §4.3, decision §8). Off: resource timing only (status `unk` on WebKit). */
export const FETCH_OBSERVER = true;

/** The IndexedDB database and store of the batch ring (separate from the store's `lp-client`). */
export const TEL_IDB = { db: 'lp-tel', store: 'q' } as const;

/** The service-worker message that hands over (and clears) the push / click log. */
export const TEL_SW_TAKE = 'lp-tel-take';

/** The Health page's windows. */
export const HEALTH_WINDOWS = ['1h', '3h', '12h', 'all'] as const;
export type HealthWindow = (typeof HEALTH_WINDOWS)[number];
export const HEALTH_SECTIONS = ['kpis', 'problems', 'examples', 'flows', 'net', 'push', 'coverage', 'errors'] as const;
export type HealthSection = (typeof HEALTH_SECTIONS)[number];
