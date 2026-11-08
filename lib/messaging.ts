// Messages and en route (F3, spec §18 A53–A58, design/DECISIONS.md "Messages and en route"). Pure and
// isomorphic: no I/O, no React. Shared by the server (notification details, validation limits) and the
// client (quick lines, the en route row, previews).
//
// Labels for statuses are never written here: anything that names a status reads it from domain.statusMeta,
// so a later rename (e.g. "Not found in medical") flows through.
import type { EnrouteSummary, LastMessage, RequestSummary } from './api-types';
import { STATUS, canonicalTeam, isInMedical, parseStaff, statusMeta } from './domain';

// ---------------------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------------------

/** Longest message (characters, after trimming). Same as the CHECK on lp_messages.body. */
export const MESSAGE_MAX = 500;
/** The counter under the composer appears from here on ("near the limit"). */
export const MESSAGE_COUNTER_FROM = 400;
/** lastMessage.text in sync and the notification detail: at most this many characters. */
export const MESSAGE_PREVIEW_MAX = 120;
/** A sender may unsend their message for this long (the server checks it too). */
export const UNSEND_WINDOW_MS = 15 * 60_000;
/** Per staff, per minute (lp_post_message). */
export const MESSAGE_RATE_PER_MINUTE = 20;
/** The thread loads the latest this many messages; "Earlier messages" pages back by the same amount. */
export const THREAD_PAGE = 100;

// ---------------------------------------------------------------------------------------------------
// Staff and sides
// ---------------------------------------------------------------------------------------------------

/** The Medical team's canonical value (contract E: medical side = the Medical team, everyone else = front of house). */
export const MEDICAL_TEAM = 'Medical';

export type Side = 'medical' | 'foh';

/** Which side a team is on: the Medical team is medical, every other team is front of house. */
export function sideOfTeam(team: string | null | undefined): Side {
  return canonicalTeam(team ?? '').toLowerCase() === MEDICAL_TEAM.toLowerCase() ? 'medical' : 'foh';
}

/** Which side an attribution string ("Rae Chen · Medical") is on. */
export function sideOfStaff(staff: string | null | undefined): Side {
  return sideOfTeam(parseStaff(staff).team);
}

/**
 * The short sender name used everywhere a message is attributed: first name and the last name's initial,
 * "Rae Chen" → "Rae C.", "Mary Ann Smith" → "Mary S.", "Rae" → "Rae". Never the full name on a lock screen.
 */
export function shortStaffName(name: string | null | undefined): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  const first = words[0] ?? '';
  if (words.length === 1) return first;
  const last = Array.from(words[words.length - 1] ?? '')[0] ?? '';
  return `${first} ${last.toUpperCase()}.`;
}

/** "Rae Chen · Medical" → "Rae C." */
export function senderShort(staff: string | null | undefined): string {
  return shortStaffName(parseStaff(staff).name);
}

/** Text cut to `max` characters, with "…" when it was longer. Whitespace runs collapse to one space. */
export function truncateText(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(t);
  if (chars.length <= max) return t;
  return `${chars.slice(0, Math.max(0, max - 1)).join('').trimEnd()}…`;
}

/** A message body as stored: trimmed; null when empty. */
export function cleanMessage(body: string): string | null {
  const t = body.trim();
  return t === '' ? null : t;
}

/** Characters as the server counts them (code points). */
export function messageLength(body: string): number {
  return Array.from(body.trim()).length;
}

// ---------------------------------------------------------------------------------------------------
// Quick lines (status × side)
// ---------------------------------------------------------------------------------------------------

/** (2026-11-08) No 'arrived': Arrived is no longer offered (design/DECISIONS.md "Request page tonight"). */
export type QuickLineKind = 'message' | 'enroute';

export interface QuickLine {
  /** The text a tap puts in the composer (for 'message'), and the pill's label. */
  text: string;
  kind: QuickLineKind;
}

/** Where a request is for the quick lines: waiting (incl. the Pending hold), in medical, or closed. */
export type QuickStage = 'waiting' | 'in_medical' | 'closed';

/**
 * The quick-line stage. Waiting for check, and a request held for a recheck (F5's `recheckAt`, read as an
 * optional field so this works with or without the hold), are 'waiting'; In medical (legacy Bring friend
 * too) is 'in_medical'; everything else is 'closed'.
 */
export function quickStage(row: Pick<RequestSummary, 'status'> & { recheckAt?: string | null }): QuickStage {
  if (row.status === STATUS.waiting) return 'waiting';
  if (isInMedical(row.status)) return 'in_medical';
  if (typeof row.recheckAt === 'string' && row.recheckAt !== '') return 'waiting';
  return 'closed';
}

const msg = (text: string): QuickLine => ({ text, kind: 'message' });

/** The medical side's quick lines by stage. */
export const MEDICAL_LINES: Readonly<Record<QuickStage, readonly QuickLine[]>> = {
  waiting: [msg('Any tattoos or marks?'), msg('What are they wearing?'), msg('Do you have a photo?')],
  // (HIPAA, Brian 2026-11-07 14:18) "Not ready yet — wait" (was "Being worked up — wait": it described care), and
  // "Hold — not ready yet" went with it (the same words twice).
  in_medical: [msg('Bring 1 person only'), msg('Not ready yet — wait'), msg('Ready for them')],
  closed: [],
};

/** Front of house's quick lines while waiting. In medical depends on en route (foh InMedicalLines). */
export const FOH_WAITING_LINES: readonly QuickLine[] = [msg('Friend is still here'), msg('Friend left the area')];

/**
 * The quick lines for a request, a side, whether I am en route on it now, and whether the friend has
 * arrived (an old row). Every quick line is just a message (a tap fills the composer; Send posts it) except
 * En route (opens the en route sheet).
 *   Waiting (incl. the Pending hold): medical asks; front of house says whether the friend is still here.
 *   In medical: medical's handover lines; front of house "En route" until I am en route (my row in the status
 *   block changes or cancels it) and never once the friend arrived, then "Friend left the area" ("Can't find
 *   them" was removed 2026-11-07, the ops lead + Brian; old messages with it stay as written). (2026-11-08) No
 *   "Arrived" line: after Located the path is (optional) En route → Reunited, Reunited in the request's bar.
 *   Closed: none (free text only).
 */
export function quickLines(stage: QuickStage, side: Side, enrouteMine: boolean, arrived = false): readonly QuickLine[] {
  if (side === 'medical') return MEDICAL_LINES[stage];
  if (stage === 'waiting') return FOH_WAITING_LINES;
  if (stage === 'in_medical') {
    const rest = [msg('Friend left the area')];
    return enrouteMine || arrived ? rest : [{ text: 'En route', kind: 'enroute' }, ...rest];
  }
  return [];
}

/**
 * What the composer holds after a tap on a message quick line (Brian 2026-11-07 13:55: "it should fill in the text
 * box, not automatically send it"): the line when nothing (or only spaces) is typed, else the typed text, a space,
 * and the line (no second space when the text already ends in one). Typed text is never replaced or lost.
 */
export function fillWithQuickLine(typed: string, line: string): string {
  if (typed.trim() === '') return line;
  return /\s$/.test(typed) ? `${typed}${line}` : `${typed} ${line}`;
}

// ---------------------------------------------------------------------------------------------------
// En route
// ---------------------------------------------------------------------------------------------------

/** The ETA pills of the en route sheet. Nothing is preselected for a new en route. */
export const ETA_CHOICES = [
  { minutes: 0, label: 'Now' },
  { minutes: 5, label: '~5 min' },
  { minutes: 10, label: '~10 min' },
  { minutes: 15, label: '~15 min' },
] as const;
export type EtaMinutes = (typeof ETA_CHOICES)[number]['minutes'];
export const ETA_MINUTES: readonly number[] = ETA_CHOICES.map((c) => c.minutes);

export function isEtaMinutes(value: unknown): value is EtaMinutes {
  return typeof value === 'number' && ETA_MINUTES.includes(value);
}

/** Until this long past the ETA it still reads "now"; after it, "late" (amber). */
export const LATE_AFTER_MS = 60_000;
/** Within this much of the ETA the row reads "now" instead of "~1 min". */
export const NOW_WITHIN_MS = 30_000;

export type EnrouteTone = 'teal' | 'amber' | 'green';

export interface EnrouteView {
  state: 'enroute' | 'arrived';
  /** "Friend en route" / "Friend arrived". */
  label: string;
  /** "~4 min", "now", "late", or null (no ETA, or arrived). */
  eta: string | null;
  late: boolean;
  /** How many staff are en route (the small count shows when > 1). */
  count: number;
  tone: EnrouteTone;
  /** For screen readers: everything in one sentence. */
  sentence: string;
}

export const ENROUTE_LABEL = 'Friend en route';
export const ARRIVED_LABEL = 'Friend arrived';

/**
 * "~4 min" (whole minutes, rounded: a fresh "~5 min" reads 5 even when the phone's clock is a few seconds
 * behind the server's), "now" within 30 s of the ETA or up to a minute past it, "late" after that.
 */
export function etaPhrase(etaAt: string | null | undefined, now: number): { text: string; late: boolean } | null {
  if (!etaAt) return null;
  const at = Date.parse(etaAt);
  if (!Number.isFinite(at)) return null;
  const left = at - now;
  if (left > NOW_WITHIN_MS) return { text: `~${Math.max(1, Math.round(left / 60_000))} min`, late: false };
  if (left > -LATE_AFTER_MS) return { text: 'now', late: false };
  return { text: 'late', late: true };
}

/** What the one en route row shows, or null when nobody is en route (or the request is not In medical). */
export function enrouteView(
  enroute: EnrouteSummary | null | undefined,
  now: number,
  status?: string,
): EnrouteView | null {
  if (!enroute) return null;
  if (status !== undefined && !isInMedical(status)) return null;
  if (enroute.state === 'arrived') {
    return { state: 'arrived', label: ARRIVED_LABEL, eta: null, late: false, count: 0, tone: 'green', sentence: `${ARRIVED_LABEL}.` };
  }
  if (enroute.count <= 0) return null;
  const eta = etaPhrase(enroute.earliestEta, now);
  // Starts with the visible label (WCAG 2.5.3), then says everything in words.
  const who = enroute.count > 1 ? `${ENROUTE_LABEL}, ${enroute.count} staff bringing them` : ENROUTE_LABEL;
  const when = !eta ? '' : eta.late ? ', later than expected' : eta.text === 'now' ? ', arriving now' : `, about ${eta.text.replace('~', '')} away`;
  return {
    state: 'enroute',
    label: ENROUTE_LABEL,
    eta: eta?.text ?? null,
    late: !!eta?.late,
    count: enroute.count,
    tone: eta?.late ? 'amber' : 'teal',
    sentence: `${who}${when}.`,
  };
}

/** Am I en route (not arrived) on this request now? */
export function iAmEnroute(enroute: EnrouteSummary | null | undefined): boolean {
  return !!enroute?.mine && enroute.state === 'enroute' && (enroute.mine.state ?? 'enroute') === 'enroute';
}

// ---------------------------------------------------------------------------------------------------
// Notification details (contract B: nouns only, built by the caller)
// ---------------------------------------------------------------------------------------------------

export const DETAIL = {
  enrouteCancelled: 'En route cancelled',
  arrived: 'Friend arrived',
} as const;

/** What stands in for a phone number or an email address in a notification. */
export const CONTACT_MASK = '•••';

/**
 * A message text with contact details masked, for notifications (contract E: never a phone number or
 * contact detail on a lock screen or in Activity): email addresses, and any run of 7 or more digits that
 * may be broken up by spaces, dashes, dots, slashes or parentheses ("407-555-0199", "(407) 555 0199",
 * "+1 407 555 0199"). Shorter numbers ("Bed 3", "4:40 PM", "FA 4", "24") stay.
 */
export function maskContacts(text: string): string {
  return text
    .replace(/[^\s@<>()[\]",;:]+@[^\s@<>()[\]",;:]+\.[^\s@<>()[\]",;:]{2,}/g, CONTACT_MASK)
    .replace(/\+?\(?\d[\d\s().\/-]*\d/g, (run) => ((run.match(/\d/g)?.length ?? 0) >= 7 ? CONTACT_MASK : run));
}

/**
 * "Rae C.: Bring 1 person only" (sender's short name, contact details masked, the text cut to 120
 * characters).
 */
export function messageDetail(senderStaff: string, body: string): string {
  const who = senderShort(senderStaff);
  const text = truncateText(maskContacts(body), MESSAGE_PREVIEW_MAX);
  return who ? `${who}: ${text}` : text;
}

/** "Friend en route · ~4 min", "Friend en route · now", or "Friend en route" with no ETA. */
export function enrouteDetail(etaAt: string | null | undefined, now: number): string {
  const eta = etaPhrase(etaAt, now);
  return eta && !eta.late ? `${ENROUTE_LABEL} · ${eta.text}` : ENROUTE_LABEL;
}

// ---------------------------------------------------------------------------------------------------
// Previews and the row's activity
// ---------------------------------------------------------------------------------------------------

/** "You: Any tattoos or marks?" / "Rae C.: Butterfly tattoo, left wrist". */
export function previewText(last: LastMessage): { who: string; text: string } {
  return { who: last.mine ? 'You' : last.by || 'Staff', text: last.text };
}

/**
 * (Request page order R1, Brian 2026-11-07) The request page's latest-message line under the status block shows
 * only while the request needs info, or while it has unread messages for me. The thread marks itself read as
 * soon as it loads, so the page passes `seenUnread`: unread messages from someone else came in while it was
 * open (on arrival included). It goes once my own message is the latest (I answered).
 */
export function threadPreviewShown(needsInfo: boolean, seenUnread: boolean, last: Pick<LastMessage, 'mine'> | null | undefined): boolean {
  return needsInfo || (seenUnread && !!last && !last.mine);
}

// The activity fields, EMPTY_ACTIVITY, hasActivity and unreadOf live in ./messaging-activity (the store's
// first-load code needs only those); re-exported here so every other caller keeps one import.
export { ACTIVITY_KEYS, EMPTY_ACTIVITY, hasActivity, unreadOf } from './messaging-activity';
export type { ActivityKey, RequestActivity } from './messaging-activity';

/** "In medical" or the status's own short label (never hard-coded): for screen-reader sentences. */
export function statusShort(status: string): string {
  return statusMeta(status).shortLabel;
}
