// (Events, lead screens) The Event setup form's logic, pure (no React, no fetch): the form state an event is edited
// in, the payload POST /api/events and PATCH /api/events/:id take, the lead's own checks (the server's rules, so
// most mistakes show before a round trip), list editing (posts, teams, "Last seen" chips, staffing rows) and where a
// server error goes on the form. Unit-tested in tests/unit/events/setup-model.test.ts.
import type { EventAdmin, EventStage } from '@/lib/api-types';

/** A post or team (or a "Last seen" chip, which has only a label) as the form edits it. */
export interface ListItem {
  /** Local key (stable while editing; React keys). */
  key: string;
  /** The server's id: kept so a rename stays a rename (the server moves the requests to the new label). */
  id?: string;
  label: string;
  short: string;
  medical?: boolean;
}

export interface StaffingItem {
  key: string;
  role: string;
  name: string;
}

export interface SetupForm {
  name: string;
  slug: string;
  startsOn: string;
  endsOn: string;
  timezone: string;
  dayStartHour: number;
  mainMedical: string;
  posts: ListItem[];
  teams: ListItem[];
  lastSeen: ListItem[];
  department: string;
  staffing: StaffingItem[];
  preparedBy: string;
}

/** Where an error shows on the form. */
export type FieldKey =
  | 'name'
  | 'slug'
  | 'dates'
  | 'timezone'
  | 'dayStartHour'
  | 'mainMedical'
  | 'posts'
  | 'teams'
  | 'lastSeen'
  | 'department'
  | 'staffing'
  | 'preparedBy'
  | 'logo'
  | 'password'
  | 'joinLink'
  | 'form';

export type FieldErrors = Partial<Record<FieldKey, string>>;

/** The settings an archived event keeps as its records were made with (the server refuses a change: bad_stage). */
export const FROZEN_WHEN_ARCHIVED: ReadonlySet<keyof SetupForm> = new Set<keyof SetupForm>([
  'startsOn',
  'endsOn',
  'timezone',
  'dayStartHour',
  'mainMedical',
  'posts',
  'teams',
  'lastSeen',
]);

export const LIMITS = { name: 80, slug: 40, post: 40, postShort: 16, team: 80, teamShort: 24, lastSeen: 40, mainMedical: 40, items: 12, days: 31, department: 120, preparedBy: 200, staffingCell: 80, staffingRows: 40 } as const;

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const TEAM_FORBIDDEN = /[·•∙⋅・･·]/;

let keySeq = 0;
/** A fresh local key. */
export function newKey(prefix = 'k'): string {
  keySeq += 1;
  return `${prefix}${keySeq}`;
}

/** "Warped Tour Orlando" → "warped-tour-orlando" (the link name a new event suggests until the lead edits it). */
export function suggestSlug(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, LIMITS.slug)
    .replace(/-+$/g, '');
  return SLUG_RE.test(base) ? base : '';
}

const clean = (v: string) => v.trim().replace(/\s+/g, ' ');

/** A new event's form: today, Eastern time, the show day from 6 AM, "Main Med". */
export function emptyForm(today: string, timezone = 'America/New_York'): SetupForm {
  return {
    name: '',
    slug: '',
    startsOn: today,
    endsOn: today,
    timezone,
    dayStartHour: 6,
    mainMedical: 'Main Med',
    posts: [],
    teams: [],
    lastSeen: [],
    department: '',
    staffing: [],
    preparedBy: '',
  };
}

/** An event as the form edits it. */
export function formFromEvent(e: EventAdmin): SetupForm {
  return {
    name: e.name,
    slug: e.slug,
    startsOn: e.startsOn,
    endsOn: e.endsOn,
    timezone: e.timezone,
    dayStartHour: e.dayStartHour,
    mainMedical: e.mainMedical,
    posts: e.posts.map((p) => ({ key: newKey('p'), id: p.id, label: p.label, short: p.short === p.label ? '' : p.short })),
    teams: e.teams.map((t) => ({ key: newKey('t'), id: t.id, label: t.label, short: t.short === t.label ? '' : t.short, medical: t.medical })),
    lastSeen: e.lastSeen.map((label) => ({ key: newKey('l'), label, short: '' })),
    department: e.department ?? '',
    staffing: (e.staffing ?? []).map((r) => ({ key: newKey('s'), role: r.role, name: r.name })),
    preparedBy: e.preparedBy ?? '',
  };
}

/** Staffing rows with both cells blank are dropped (a row the lead added and left empty). */
function staffingRows(form: SetupForm) {
  return form.staffing.map((r) => ({ role: clean(r.role), name: clean(r.name) })).filter((r) => r.role || r.name);
}

/** Every setting, as POST /api/events and PATCH /api/events/:id take them. */
export function payloadFromForm(form: SetupForm): Record<string, unknown> {
  return {
    name: clean(form.name),
    slug: form.slug.trim().toLowerCase(),
    startsOn: form.startsOn,
    endsOn: form.endsOn,
    timezone: form.timezone,
    dayStartHour: form.dayStartHour,
    mainMedical: clean(form.mainMedical),
    posts: form.posts.map((p) => ({ ...(p.id ? { id: p.id } : {}), label: clean(p.label), ...(clean(p.short) ? { short: clean(p.short) } : {}) })),
    teams: form.teams.map((t) => ({
      ...(t.id ? { id: t.id } : {}),
      label: clean(t.label),
      ...(clean(t.short) ? { short: clean(t.short) } : {}),
      medical: t.medical === true,
    })),
    lastSeen: form.lastSeen.map((l) => clean(l.label)),
    department: clean(form.department) || null,
    staffing: staffingRows(form),
    preparedBy: clean(form.preparedBy) || null,
  };
}

/** Only what changed since `base` (PATCH). An archived event never sends its frozen settings. */
export function changedPayload(base: SetupForm, form: SetupForm, stage: EventStage): Record<string, unknown> {
  const before = payloadFromForm(base);
  const after = payloadFromForm(form);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(after)) {
    if (stage === 'archived' && FROZEN_WHEN_ARCHIVED.has(k as keyof SetupForm)) continue;
    if (JSON.stringify(v) !== JSON.stringify(before[k])) out[k] = v;
  }
  return out;
}

export function isDirty(base: SetupForm, form: SetupForm, stage: EventStage): boolean {
  return Object.keys(changedPayload(base, form, stage)).length > 0;
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

/** The problem with one post, team or chip label among `list`, or null. */
export function itemError(kind: 'post' | 'team' | 'lastSeen', list: readonly ListItem[], item: Pick<ListItem, 'key' | 'label' | 'short'>): string | null {
  const label = clean(item.label);
  const max = kind === 'post' ? LIMITS.post : kind === 'team' ? LIMITS.team : LIMITS.lastSeen;
  const min = kind === 'team' ? 2 : 1;
  if (label.length < min) return kind === 'team' ? 'At least 2 characters' : 'Required';
  if (label.length > max) return `At most ${max} characters`;
  if (kind !== 'lastSeen' && label.toLowerCase() === 'other') return '"Other" is always there';
  if (kind === 'team' && TEAM_FORBIDDEN.test(label)) return 'No "·"';
  const shortMax = kind === 'post' ? LIMITS.postShort : LIMITS.teamShort;
  if (kind !== 'lastSeen' && clean(item.short).length > shortMax) return `Short: at most ${shortMax} characters`;
  if (list.some((o) => o.key !== item.key && clean(o.label).toLowerCase() === label.toLowerCase())) return 'Already there';
  return null;
}

/** The lead's own checks, before the server's. Empty when the form can be sent. */
export function validateForm(form: SetupForm): FieldErrors {
  const errors: FieldErrors = {};
  const name = clean(form.name);
  if (!name) errors.name = 'Required';
  else if (name.length > LIMITS.name) errors.name = `At most ${LIMITS.name} characters`;
  const slug = form.slug.trim().toLowerCase();
  if (!SLUG_RE.test(slug)) errors.slug = '2–40 lowercase letters, digits or dashes';
  if (!isDate(form.startsOn) || !isDate(form.endsOn)) errors.dates = 'Required';
  else if (form.endsOn < form.startsOn) errors.dates = 'The last day is before the first';
  else if (daysBetween(form.startsOn, form.endsOn) > LIMITS.days) errors.dates = `At most ${LIMITS.days + 1} days`;
  if (!form.timezone) errors.timezone = 'Required';
  if (!Number.isInteger(form.dayStartHour) || form.dayStartHour < 0 || form.dayStartHour > 23) errors.dayStartHour = 'Required';
  const mm = clean(form.mainMedical);
  if (!mm) errors.mainMedical = 'Required';
  else if (mm.length > LIMITS.mainMedical) errors.mainMedical = `At most ${LIMITS.mainMedical} characters`;
  const listCheck = (kind: 'post' | 'team' | 'lastSeen', list: ListItem[], key: FieldKey) => {
    if (list.length > LIMITS.items) errors[key] = `At most ${LIMITS.items}`;
    for (const item of list) {
      const e = itemError(kind, list, item);
      if (e) {
        errors[key] = `${clean(item.label) || '—'}: ${e}`;
        return;
      }
    }
  };
  listCheck('post', form.posts, 'posts');
  listCheck('team', form.teams, 'teams');
  listCheck('lastSeen', form.lastSeen, 'lastSeen');
  if (!errors.teams && form.teams.filter((t) => t.medical).length > 1) errors.teams = 'Only one medical team';
  if (clean(form.department).length > LIMITS.department) errors.department = `At most ${LIMITS.department} characters`;
  if (clean(form.preparedBy).length > LIMITS.preparedBy) errors.preparedBy = `At most ${LIMITS.preparedBy} characters`;
  const rows = staffingRows(form);
  if (rows.length > LIMITS.staffingRows) errors.staffing = `At most ${LIMITS.staffingRows} rows`;
  else if (rows.some((r) => !r.role || !r.name)) errors.staffing = 'Role and name';
  else if (rows.some((r) => r.role.length > LIMITS.staffingCell || r.name.length > LIMITS.staffingCell)) errors.staffing = `At most ${LIMITS.staffingCell} characters`;
  return errors;
}

/** The server's field (camelCase, from {error: {field}}) → where it shows on the form. */
export function fieldKeyOf(serverField: string | undefined): FieldKey {
  switch (serverField) {
    case 'name':
    case 'slug':
    case 'timezone':
    case 'dayStartHour':
    case 'mainMedical':
    case 'posts':
    case 'teams':
    case 'lastSeen':
    case 'department':
    case 'staffing':
    case 'preparedBy':
    case 'logo':
    case 'password':
      return serverField;
    case 'startsOn':
    case 'endsOn':
      return 'dates';
    case 'expiresAt':
    case 'invite':
      return 'joinLink';
    default:
      return 'form';
  }
}

// ---- Lists -------------------------------------------------------------------------------------------

export function addItem(list: readonly ListItem[], item: Omit<ListItem, 'key'>): ListItem[] {
  return [...list, { ...item, key: newKey() }];
}

export function updateItem(list: readonly ListItem[], key: string, patch: Partial<Omit<ListItem, 'key'>>): ListItem[] {
  return list.map((i) => (i.key === key ? { ...i, ...patch } : i));
}

export function removeItem<T extends { key: string }>(list: readonly T[], key: string): T[] {
  return list.filter((i) => i.key !== key);
}

/** Moves the item one place up (-1) or down (+1); nothing at either end. */
export function moveItem<T extends { key: string }>(list: readonly T[], key: string, delta: -1 | 1): T[] {
  const from = list.findIndex((i) => i.key === key);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= list.length) return [...list];
  const out = [...list];
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item!);
  return out;
}

/** Marks `key` as the medical team (at most one): turning one on turns any other off. */
export function setMedical(teams: readonly ListItem[], key: string, on: boolean): ListItem[] {
  return teams.map((t) => (t.key === key ? { ...t, medical: on } : on ? { ...t, medical: false } : t));
}

// ---- Stage -------------------------------------------------------------------------------------------

/** Go live needs at least one post and one team (the server refuses otherwise). */
export function canGoLive(e: Pick<EventAdmin, 'stage' | 'posts' | 'teams'>): boolean {
  return e.stage === 'practice' && e.posts.length > 0 && e.teams.length > 0;
}

/** The LP number a request gets: LP-0001. */
export function lpNumber(n: number): string {
  return `LP-${String(n).padStart(4, '0')}`;
}
