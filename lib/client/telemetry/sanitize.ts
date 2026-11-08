// Naming controls and areas without reading any text (design §1.3). Pure. Every function here reads ATTRIBUTES ONLY
// (data-testid, class, role, tabindex, id, aria-labelledby, aria-disabled, the presence of href, the tag) and the
// parent chain: never textContent, innerText, innerHTML, value, aria-label, title, alt, placeholder, src or href's
// value. tests/unit/telemetry/privacy.test.ts makes those throw.
import { AREAS, FORM_FIELDS, TOKEN_RE } from '../../telemetry';

/** The DOM surface this module reads (real Elements satisfy it; tests pass fakes). */
export interface NodeLike {
  tagName?: string;
  id?: string;
  className?: unknown;
  parentElement?: NodeLike | null;
  getAttribute?(name: string): string | null;
  hasAttribute?(name: string): boolean;
  disabled?: boolean;
  isContentEditable?: boolean;
  contains?(other: unknown): boolean;
}

const UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * A token: UUIDs and runs of 2+ digits become `#`, characters outside [a-z0-9_.:#/-] are dropped, cut at 48. Refuses
 * (null) anything with whitespace, a capital, an @ or a non-ASCII character: those are never attribute names.
 */
export function tok(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  if (/[\sA-Z@]/.test(value) || /[^\x21-\x7e]/.test(value)) return null;
  const t = value
    .replace(UUID_G, '#')
    .replace(/\d{2,}/g, '#')
    .replace(/[^a-z0-9_.:#/-]/g, '')
    .slice(0, 48);
  return TOKEN_RE.test(t) ? t : null;
}

/** A lowercase token of a CSS-module local name ("checkActs" → "checkacts"). */
function local(name: string): string | null {
  return /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(name) ? tok(name.toLowerCase()) : null;
}

/**
 * The token of one class name, or null when it is not one we name controls by:
 *   Turbopack production  `<6-char hash>_<local>`            → `<local>`        ("ZUuQ-G_checkActs" → "checkacts")
 *   Turbopack development `<file>-module__<hash>__<local>`   → `<file>.<local>` ("list-module__Ab3x9q__row" → "list.row")
 *   webpack               `<file>_<local>__<hash5>`          → `<file>.<local>`
 *   global `lp-*` (not lp-hit), and Radix Themes components `rt-<Component>` (not rt-r-*, rt-variant-*, …).
 */
export function classToken(cls: string): string | null {
  let m = /^([a-z0-9-]+)-module__[A-Za-z0-9_-]+?__([A-Za-z][A-Za-z0-9]*)$/.exec(cls);
  if (m) {
    const l = local(m[2] ?? '');
    const file = tok(m[1]);
    return l && file ? tok(`${file}.${l}`) : null;
  }
  m = /^[A-Za-z0-9_-]{6}_([A-Za-z][A-Za-z0-9]*)$/.exec(cls);
  if (m && !cls.startsWith('lp-') && !cls.startsWith('rt-')) return local(m[1] ?? '');
  m = /^([a-z][a-z0-9-]*)_([A-Za-z][A-Za-z0-9]*)__[A-Za-z0-9_-]{5}$/.exec(cls);
  if (m) {
    const l = local(m[2] ?? '');
    const file = tok(m[1]);
    return l && file ? tok(`${file}.${l}`) : null;
  }
  if (/^lp-[a-z0-9-]+$/.test(cls) && cls !== 'lp-hit') return tok(cls);
  if (/^rt-[A-Z][A-Za-z]+$/.test(cls)) return tok(cls.toLowerCase());
  return null;
}

function classNames(el: NodeLike): string[] {
  const raw = el.className;
  // SVG elements carry an SVGAnimatedString.
  const s = typeof raw === 'string' ? raw : raw && typeof (raw as { baseVal?: unknown }).baseVal === 'string' ? (raw as { baseVal: string }).baseVal : '';
  return s ? s.split(/\s+/).filter(Boolean) : [];
}

/** The first class token of an element. */
export function firstClassToken(el: NodeLike | null | undefined): string | null {
  if (!el) return null;
  for (const c of classNames(el)) {
    const t = classToken(c);
    if (t) return t;
  }
  return null;
}

export function hasClass(el: NodeLike | null | undefined, cls: string): boolean {
  return !!el && classNames(el).includes(cls);
}

function attr(el: NodeLike, name: string): string | null {
  return el.getAttribute ? el.getAttribute(name) : null;
}

export function testid(el: NodeLike | null | undefined): string | null {
  return el ? tok(attr(el, 'data-testid')) : null;
}

function tag(el: NodeLike): string {
  return typeof el.tagName === 'string' ? el.tagName.toLowerCase() : '';
}

const INTERACTIVE_TAGS = new Set(['button', 'input', 'select', 'textarea', 'label', 'summary']);
const INTERACTIVE_ROLES = new Set(['button', 'link', 'tab', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'switch', 'checkbox', 'radio', 'option']);

export function isInteractive(el: NodeLike): boolean {
  const t = tag(el);
  if (INTERACTIVE_TAGS.has(t)) return true;
  if (t === 'a' && !!el.hasAttribute?.('href')) return true;
  const role = attr(el, 'role');
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  const tabindex = attr(el, 'tabindex');
  return tabindex !== null && tabindex !== '-1';
}

/** The closest interactive element within 8 levels, or null. */
export function interactive(target: NodeLike | null | undefined): NodeLike | null {
  let el = target ?? null;
  for (let i = 0; el && i <= 8; i += 1, el = el.parentElement ?? null) if (isInteractive(el)) return el;
  return null;
}

function roleOrTag(el: NodeLike): string {
  return tok(attr(el, 'role')) ?? (tok(tag(el)) || 'unknown');
}

/**
 * A row's message lane (components/messages/CardActivity MessageMark, 2026-11-07): a click there opens the request at
 * its thread, not at the top (openRowAt), so it is a control of its own inside the row's button.
 */
const LANE_ATTR = 'data-thread-badge';
export const LANE_CONTROL = 'message-mark';

/**
 * The control's name: a row's message lane (`message-mark`) when the tap landed in it; else its testid, the closest
 * testid ≤ 2 levels up, its first class token, else its role or tag.
 */
export function ctl(target: NodeLike | null | undefined): string {
  if (!target) return 'unknown';
  const inter = interactive(target);
  for (let up: NodeLike | null = target, i = 0; up && up !== inter && i <= 8; i += 1, up = up.parentElement ?? null) {
    if (up.hasAttribute?.(LANE_ATTR)) return testid(up) ?? LANE_CONTROL;
  }
  const el = inter ?? target;
  const own = testid(el);
  if (own) return own;
  let up = el.parentElement ?? null;
  for (let i = 0; up && i < 2; i += 1, up = up.parentElement ?? null) {
    const t = testid(up);
    if (t) return t;
  }
  return firstClassToken(el) ?? roleOrTag(el);
}

const AREA_SET: ReadonlySet<string> = new Set(AREAS);
const DIALOG_ROLES = new Set(['dialog', 'alertdialog', 'menu']);

/** An AREAS testid with every digit run as `#` ("pending-column-2" → "pending-column-#"), or null. */
export function areaTestid(el: NodeLike): string | null {
  const t = testid(el);
  if (!t) return null;
  const n = t.replace(/\d+/g, '#');
  return AREA_SET.has(n) ? n : null;
}

/** The id of an open dialog, sheet, menu or popover: its testid, else its class token, else its role. */
export function dialogId(el: NodeLike): string {
  return testid(el) ?? firstClassToken(el) ?? roleOrTag(el);
}

export function isDialog(el: NodeLike): boolean {
  const role = attr(el, 'role');
  return !!role && DIALOG_ROLES.has(role);
}

/**
 * The area a target is in: the first ancestor that is an AREAS testid, the Toaster, or an open dialog (its id); else
 * the first testid within 15 levels; else `page`.
 */
export function area(target: NodeLike | null | undefined): string {
  let el = target ?? null;
  let firstTestid: string | null = null;
  for (let depth = 0; el; depth += 1, el = el.parentElement ?? null) {
    const a = areaTestid(el);
    if (a) return a;
    if (hasClass(el, 'lp-toaster')) return 'lp-toaster';
    if (isDialog(el)) return dialogId(el);
    if (!firstTestid && depth <= 15) firstTestid = testid(el);
    if (depth > 40) break;
  }
  return firstTestid ?? 'page';
}

/**
 * Areas of the request page that scroll with the page, not in a box of their own, everywhere but the desk pane
 * (2026-11-08, "Phone thread in the page": messages.module.css `.thread` has no overflow; only `.panel .thread`
 * scrolls).
 */
const PAGE_FLOW: ReadonlySet<string> = new Set(['thread', 'messages', 'composer']);

/**
 * The area a swipe scrolls (the swipe counts and stuck scroll): `area()`, except that outside the desk pane the
 * request page's Messages (`thread`, `messages`, `composer`) are part of the page, so a swipe that starts there is the
 * page's (`profile`; else the next area up, else `page`). In the desk pane (`[data-presentation=panel]` or
 * `desk-pane`) the thread still scrolls in its own box and keeps its own area. `a`: the target's area() when known.
 */
export function scrollArea(target: NodeLike | null | undefined, a: string = area(target)): string {
  if (!PAGE_FLOW.has(a)) return a;
  let el = target ?? null;
  for (let depth = 0; el && depth <= 40; depth += 1, el = el.parentElement ?? null) {
    if (attr(el, 'data-presentation') === 'panel' || attr(el, 'data-testid') === 'desk-pane') return a;
    const up = areaTestid(el);
    if (up && !PAGE_FLOW.has(up)) return up;
    if (isDialog(el)) return dialogId(el);
  }
  return 'page';
}

/** The closest ancestor (or the element) with this testid, within `max` levels. */
export function closestTestid(target: NodeLike | null | undefined, id: string, max = 40): NodeLike | null {
  let el = target ?? null;
  for (let i = 0; el && i <= max; i += 1, el = el.parentElement ?? null) if (attr(el, 'data-testid') === id) return el;
  return null;
}

/** Text fields: where keys are never counted. */
export function isTextField(el: NodeLike | null | undefined): boolean {
  if (!el) return false;
  const t = tag(el);
  return t === 'input' || t === 'textarea' || t === 'select' || el.isContentEditable === true;
}

const FIELD_SET: ReadonlySet<string> = new Set(FORM_FIELDS);

/** The suffix of a React useId-based id ("«r3»-lastSeen", "_r_3_-contactPhone") after its last '-', lowercased. */
function idSuffix(id: string | null | undefined): string | null {
  if (!id) return null;
  const at = id.lastIndexOf('-');
  const s = (at >= 0 ? id.slice(at + 1) : id).toLowerCase();
  return /^[a-z][a-z0-9]{0,30}$/.test(s) ? s : null;
}

export interface FormField {
  /** person, more, friend, post, photo, or field. */
  section: string;
  /** A FORM_FIELDS key, or `field`. */
  key: string;
}

/**
 * A request-form field (only inside [data-testid=request-form]): its key from the input's id suffix and its section
 * from the enclosing group's aria-labelledby id suffix (post chip and photo slots by class / testid). Ids, not labels.
 */
export function formField(target: NodeLike | null | undefined): FormField | null {
  if (!target || !closestTestid(target, 'request-form')) return null;
  const id = typeof target.id === 'string' ? target.id : null;
  const suffix = idSuffix(id);
  const key = suffix && FIELD_SET.has(suffix) ? suffix : 'field';
  let section = 'field';
  for (let el: NodeLike | null = target, i = 0; el && i < 12; i += 1, el = el.parentElement ?? null) {
    if (hasClass(el, 'lp-rf-pchip')) {
      section = 'post';
      break;
    }
    const t = attr(el, 'data-testid');
    if (t === 'add-photo' || t === 'card-photo' || hasClass(el, 'lp-rf-photo')) {
      section = 'photo';
      break;
    }
    if (attr(el, 'role') === 'group') {
      const s = idSuffix(attr(el, 'aria-labelledby'));
      if (s === 'person' || s === 'more' || s === 'friend') {
        section = s;
        break;
      }
    }
    if (t === 'request-form') break;
  }
  return { section, key };
}

const UUID_PATH = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** `/api/sync` mode from which query keys are present (never their values). */
function syncMode(params: URLSearchParams): string {
  if (params.has('ids')) return 'ids';
  if (params.has('afterAt')) return 'page';
  if (params.has('reconcile')) return 'reconcile';
  if (params.has('since')) return 'delta';
  return 'full';
}

/**
 * The path pattern of a same-origin /api/ URL: UUIDs as `:id`, digit runs as `#`, the query dropped (`/api/sync` gets
 * its mode: `/api/sync:delta`). Null for another origin or a non-API path.
 */
export function pathPattern(url: string, origin: string): string | null {
  let u: URL;
  try {
    u = new URL(url, origin);
  } catch {
    return null;
  }
  if (u.origin !== origin || !u.pathname.startsWith('/api/')) return null;
  let p = u.pathname.toLowerCase().replace(UUID_PATH, ':id').replace(/\d{2,}/g, '#').replace(/[^a-z0-9_.:#/-]/g, '');
  if (p === '/api/sync') p += `:${syncMode(u.searchParams)}`;
  p = p.slice(0, 64);
  return TOKEN_RE.test(p) ? p : null;
}

/** FNV-1a as 8 letters (hex 0-f written a-p): no digit run for the server's DIGIT_RUN_RE to refuse. */
export function fnv8(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let out = '';
  for (const c of h.toString(16).padStart(8, '0')) out += String.fromCharCode(97 + Number.parseInt(c, 16));
  return out;
}
