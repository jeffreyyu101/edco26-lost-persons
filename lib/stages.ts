// The stage system (F5, Brian 2026-11-06 evening; design/screens/updates.html #clarify, #recheck, #colors):
// lib/domain's stage map and displayStage, in a module of its own so the first load of `/` (A25) does not carry
// it (only the views, which load later, import it). Pure and isomorphic: no I/O, no React.
import {
  RECHECK_MINUTES,
  STATUS,
  STATUS_META,
  NOT_FOUND_YET_LABEL,
  canonicalTeam,
  isHeld,
  isInMedical,
  parseStaff,
  statusMeta,
  type GlyphKind,
  type Status,
  type StatusBucket,
} from './domain';
import { DEFAULT_EVENT_TIMEZONE, formatClock, formatClockAmPm, formatDuration, minutesSince } from './format';

export { RECHECK_MINUTES, isHeld, isRecheckDue } from './domain';

// What a request shows: its stored status, refined by what else is known about it. The stored statuses and
// their transitions are unchanged; a stage is derived for display only:
//   Waiting for check   + needsInfo (F3, medical asked)    → Needs info      amber  ring with "?"
//   Waiting for check   + recheckAt (the hold, below)     → Not found yet   violet hourglass
//   (Needs info on hold keeps its label and carries the hold's recheck time: recheckAt, due, recheck)
//   In medical          + enroute.state 'enroute' (F3)    → Friend en route teal   walking figure
//   In medical          + enroute.state 'arrived' (F3)    → Friend arrived  green  check (not filled)
// Needs info beats Not found yet. Every other status is its own stage, with its label from STATUS_META, so a
// renamed status label flows through. Colour = meaning: blue medical is looking, amber front of house's
// turn, violet on hold, green found, teal on the move, grey closed (design/screens/colors-1.png).
//
// The "Not found yet" hold (rework SQL step 1d, lp_set_status): the first Not found on a request Waiting for
// check keeps it open (status 'Added') with recheckAt = answer + RECHECK_MINUTES and notFoundChecks = 1; it
// is due once recheckAt has passed, and stays open until someone answers. The next Not found is final.

export type StageKey =
  | 'waiting'
  | 'needsInfo'
  | 'notFoundYet'
  | 'inMedical'
  | 'enroute'
  | 'arrived'
  | 'notInMedical'
  | 'reunited'
  | 'discharged'
  | 'cancelled'
  /** A legacy status this app does not know (shown verbatim, grey, closed). */
  | 'legacy';

/** Radix colour of a stage: its label (step 11, or 12 on a tint), glyph and tint (step a3). */
export type StageTone = 'blue' | 'amber' | 'violet' | 'green' | 'teal' | 'gray';

/** Which glyph a stage draws (components/ui/StageGlyph.tsx). The status glyphs are StatusGlyph's. */
export type StageGlyphKind = GlyphKind | 'needsInfo' | 'hourglass' | 'walk' | 'arrived';

export interface StageMeta {
  label: string;
  tone: StageTone;
  glyph: StageGlyphKind;
  bucket: StatusBucket;
}

const fromStatus = (status: Status): StageMeta => {
  const m = STATUS_META[status];
  return { label: m.shortLabel, tone: m.tone, glyph: m.glyph, bucket: m.bucket };
};

/** The ONE stage map: label, colour and glyph per stage. Status stages take their label from STATUS_META. */
export const STAGE_META: Readonly<Record<Exclude<StageKey, 'legacy'>, StageMeta>> = {
  waiting: fromStatus(STATUS.waiting),
  needsInfo: { label: 'Needs info', tone: 'amber', glyph: 'needsInfo', bucket: 'open' },
  notFoundYet: { label: NOT_FOUND_YET_LABEL, tone: 'violet', glyph: 'hourglass', bucket: 'open' },
  inMedical: fromStatus(STATUS.inMedical),
  enroute: { label: 'Friend en route', tone: 'teal', glyph: 'walk', bucket: 'open' },
  arrived: { label: 'Friend arrived', tone: 'green', glyph: 'arrived', bucket: 'open' },
  notInMedical: fromStatus(STATUS.notInMedical),
  reunited: fromStatus(STATUS.reunited),
  discharged: fromStatus(STATUS.discharged),
  cancelled: fromStatus(STATUS.cancelled),
};

/**
 * What displayStage reads. Every refinement is optional: rows cached before a field existed, and branches
 * without F3's messages / en route, simply don't have them. F3's fields keep the shared contract's shapes
 * (needsInfo, lastMessage {by, mine, text}, lastMessageAt, enroute {count, earliestEta, state, mine}); they
 * are read loosely so a row of either build fits.
 */
export interface StageSource {
  status: string;
  createdAt: string;
  medicalLocation?: string | null;
  /** (F5) When the "Not found yet" hold is due; null when not held. */
  recheckAt?: string | null;
  /** (F5) Not found answers in this round: 1 while held, 2 after the final one. */
  notFoundChecks?: number;
  /** (F3) Waiting for check and the latest message is from medical. */
  needsInfo?: boolean;
  /** (F3) The latest message. `by`: who sent it (attribution string or display name). */
  lastMessage?: { by?: string | null; mine?: boolean; text?: string | null } | null;
  /** (F3) When the latest message was sent. */
  lastMessageAt?: string | null;
  /** (F3) Who is walking the friend to medical. */
  enroute?: { count?: number; earliestEta?: string | null; state?: string | null } | null;
}

export interface DisplayStage extends StageMeta {
  key: StageKey;
  /** The detail block's label: the status's full label for status stages ("In medical · friend coming"). */
  fullLabel: string;
  /** One quiet line under the label: "9m", "Recheck 4:40 PM", "Bed 3", "~4 min", "Rae C. asked · 4:20 PM", "2 checks". */
  sub?: string;
  /**
   * What follows the label in a desk status cell: "· 9m", "· 4:40 PM", "· Bed 3", "· ~4 min", "· 2 checks"; for
   * Needs info on hold, "4:40 PM" after the recheck glyph (`extraGlyph`).
   */
  extra?: string;
  /**
   * The desk cell's narrow form of `extra`, when its status column is short of room (a request open beside
   * the list on a small window): "· 4:40" for "· 4:40 PM"; '' drops the extra ("· 2 checks"). Absent: `extra`
   * is already short.
   */
  extraShort?: string;
  /** The desk cell draws this glyph before `extra` (Needs info on hold: "⟳ 4:40 PM"). */
  extraGlyph?: 'recheck';
  /** The stage as a screen reader says it, in words: "Not found yet, recheck at 4:40 PM". */
  said: string;
  /**
   * A request on hold (Not found yet, or Needs info while held): when the recheck is due, whether it is due at
   * `now`, and its row / chip words, "Recheck 4:40 PM".
   */
  recheckAt?: string;
  due?: boolean;
  recheck?: string;
}

export interface StageOptions {
  /** Epoch ms (useNow()); decides held vs due, minutes waiting and the ETA. */
  now: number;
  /** IANA zone for times ("4:40 PM"). */
  timeZone?: string;
}

const epoch = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : NaN;
};

/** Medical side (contract E): staff of the Medical team; every other team is front of house. */
export function isMedicalTeam(team: string | null | undefined): boolean {
  return !!team && canonicalTeam(team) === 'Medical';
}

/** When a held request got its first Not found: RECHECK_MINUTES before its recheck time. Null when not held. */
export function holdAnsweredAt(row: Pick<StageSource, 'status' | 'recheckAt'>): string | null {
  if (!isHeld(row)) return null;
  return new Date(epoch(row.recheckAt) - RECHECK_MINUTES * 60_000).toISOString();
}

/** "Rae Chen · Medical" or "Rae Chen" → "Rae C."; one word stays as it is. */
export function shortStaffName(staff: string | null | undefined): string {
  const words = parseStaff(staff).name.split(' ').filter(Boolean);
  if (words.length < 2) return words[0] ?? '';
  const initial = /\p{L}/u.exec(words[words.length - 1] ?? '')?.[0];
  return initial ? `${words[0]} ${initial.toUpperCase()}.` : words.join(' ');
}

/** "~4 min" until an ETA, "now" once it has passed; null without one. */
export function etaText(eta: string | null | undefined, now: number): string | null {
  const t = epoch(eta);
  if (!Number.isFinite(t)) return null;
  const minutes = Math.ceil((t - now) / 60_000);
  return minutes <= 0 ? 'now' : `~${minutes} min`;
}

const withExtra = (sub: string | undefined): Pick<DisplayStage, 'sub' | 'extra'> => (sub ? { sub, extra: `· ${sub}` } : {});

/** A hold's times: "4:40 PM", "4:40", "Recheck 4:40 PM", and whether it is due at `now`. */
function holdOf(recheckAt: string, timeZone: string, now: number) {
  const clock = formatClockAmPm(recheckAt, timeZone);
  return { recheckAt, clock, short: formatClock(recheckAt, timeZone), recheck: `Recheck ${clock}`, due: epoch(recheckAt) <= now };
}

/**
 * The stage a request shows (list status cells, the desk status cell, the detail status block, the My
 * requests chip). Pure: pass `now` from useNow().
 */
export function displayStage(row: StageSource, opts: StageOptions): DisplayStage {
  const stage = stageOf(row, opts);
  // Screen readers get words, not the visual "·" ("In medical, friend coming, Bed 3").
  return { ...stage, said: stage.said.replace(/\s*·\s*/g, ', ') };
}

/** A request's stage key, label, colour and glyph: what needs no clock (a list's status cell). */
export function stageLook(row: StageSource): StageMeta & { key: StageKey } {
  const { key, label, tone, glyph, bucket } = stageOf(row, { now: 0 });
  return { key, label, tone, glyph, bucket };
}

/**
 * A row's stage as its screen-reader sentence says it, with no clock: the status's words for a status stage
 * ("In medical, friend coming"), else the stage ("Not found yet, recheck at 4:40 PM", "Friend en route").
 */
export function stagePhrase(row: StageSource, timeZone: string = DEFAULT_EVENT_TIMEZONE): string {
  const stage = stageOf(row, { now: 0, timeZone });
  const words = (s: string) => s.replace(/\s*·\s*/g, ', ');
  switch (stage.key) {
    case 'notFoundYet':
      return words(stage.said);
    case 'needsInfo':
      return stage.recheckAt ? `${stage.label}, recheck at ${formatClockAmPm(stage.recheckAt, timeZone)}` : stage.label;
    case 'enroute':
    case 'arrived':
      return stage.label;
    default:
      return words(statusMeta(row.status).label);
  }
}

function stageOf(row: StageSource, opts: StageOptions): DisplayStage {
  const tz = opts.timeZone ?? DEFAULT_EVENT_TIMEZONE;
  const status = row.status;
  const of = (key: Exclude<StageKey, 'legacy'>, rest: Partial<DisplayStage> = {}): DisplayStage => {
    const meta = STAGE_META[key];
    return { ...meta, key, fullLabel: meta.label, said: meta.label, ...rest };
  };

  if (status === STATUS.waiting) {
    // The hold, whichever stage shows: Needs info wins the label, but the recheck time stays on every surface.
    const hold = isHeld(row) ? holdOf(row.recheckAt as string, tz, opts.now) : null;
    if (row.needsInfo) {
      const by = row.lastMessage ? (row.lastMessage.mine ? 'You' : shortStaffName(row.lastMessage.by)) : '';
      const at = Number.isFinite(epoch(row.lastMessageAt)) ? formatClockAmPm(row.lastMessageAt as string, tz) : '';
      const sub = by ? [`${by} asked`, at].filter(Boolean).join(' · ') : undefined;
      const asked = sub ? `${STAGE_META.needsInfo.label}, ${by} asked${at ? ` at ${at}` : ''}` : STAGE_META.needsInfo.label;
      const said = hold ? `${asked}, recheck at ${hold.clock}` : asked;
      const held: Partial<DisplayStage> = hold
        ? { extra: hold.clock, extraShort: hold.short, extraGlyph: 'recheck', recheckAt: hold.recheckAt, due: hold.due, recheck: hold.recheck }
        : {};
      return of('needsInfo', { ...(sub ? { sub } : {}), said, ...held });
    }
    if (hold) {
      return of('notFoundYet', {
        sub: hold.recheck,
        extra: `· ${hold.clock}`,
        extraShort: `· ${hold.short}`,
        said: `${STAGE_META.notFoundYet.label}, recheck at ${hold.clock}`,
        recheckAt: hold.recheckAt,
        due: hold.due,
        recheck: hold.recheck,
      });
    }
    const waited = formatDuration(minutesSince(row.createdAt, opts.now));
    return of('waiting', { ...withExtra(waited), said: STATUS_META[STATUS.waiting].label });
  }
  if (isInMedical(status)) {
    const full = STATUS_META[STATUS.inMedical].label;
    if (row.enroute?.state === 'enroute') {
      const eta = etaText(row.enroute.earliestEta, opts.now);
      const said = eta ? `${STAGE_META.enroute.label}, ETA ${eta === 'now' ? 'now' : eta.replace('~', 'about ')}` : STAGE_META.enroute.label;
      return of('enroute', { ...withExtra(eta ?? undefined), said });
    }
    if (row.enroute?.state === 'arrived') return of('arrived');
    const location = (row.medicalLocation ?? '').trim();
    return of('inMedical', { fullLabel: full, ...withExtra(location || undefined), said: location ? `${full}, ${location}` : full });
  }
  if (status === STATUS.notInMedical) {
    const checks = row.notFoundChecks ?? 0;
    const label = STAGE_META.notInMedical.label;
    return of('notInMedical', checks >= 2 ? { ...withExtra(`${checks} checks`), extraShort: '', said: `${label}, ${checks} checks` } : {});
  }
  if (status === STATUS.reunited) return of('reunited');
  if (status === STATUS.discharged) return of('discharged');
  if (status === STATUS.cancelled) return of('cancelled');
  const legacy = statusMeta(status);
  return { label: legacy.shortLabel, fullLabel: legacy.label, tone: legacy.tone, glyph: legacy.glyph, bucket: legacy.bucket, key: 'legacy', said: legacy.label };
}
