// The profile's audit trail (spec §8 Profile "Audit trail", v2.1 A1, v2.3 A35): turns the normalised
// AuditEvent[] from GET /api/requests/:id (oldest first) into display items, newest first. Pure: no React,
// no I/O, so it is unit-tested (tests/unit/profile/audit-trail.test.ts).
//
//   status / cancelled / legacy_*  → "from → to" with glyphs (legacy actions normalised: medical_search
//                                    not found → Not found in medical, medical_search_found → In medical,
//                                    check_completed → "Not found in medical (rechecked)")
//   edit                           → "Edited <label>" with old (struck) → new; Name and Post merged
//                                    (domain.displayChanges)
//   photo                          → "Photo added" with the timing; back-to-back uploads by the same
//                                    person with the same timing merge into "2 photos · Today"
//   created                        → "Request logged" with the post
//   other                          → the raw action, humanised (never dropped)
// Who = "name · short team"; when = "Nov 6, 11:10 PM" in the event timezone.
import type { AuditEvent } from '@/lib/api-types';
import { PHOTO_TIMING_LABEL, STATUS, canonStaff, displayChanges, isInMedical, parseStaff, postFull, statusMeta, type PhotoTimingAny, type StatusValue } from '@/lib/domain';
import { STAGE_META, type StageGlyphKind, type StageTone } from '@/lib/stages';
import { formatAuditTime, formatClockAmPm } from '@/lib/format';

/** Edit values longer than this are cut with "…" in the trail (the full value is in the details above). */
export const AUDIT_VALUE_MAX = 160;
/** Photo uploads by the same person, with the same timing, at most this far apart, show as one item. */
export const PHOTO_MERGE_MS = 10 * 60_000;

export interface AuditStatusChange {
  /** Null when the event does not record where it came from (Jeffrey's legacy actions). */
  from: StatusValue | null;
  fromLabel: string | null;
  to: StatusValue;
  toLabel: string;
  /** (F5) Set when a side is a "Not found yet" hold rather than its plain status: the stage's glyph and tone. */
  fromGlyph?: StageGlyphKind;
  toGlyph?: StageGlyphKind;
  toTone?: StageTone;
}

export interface AuditChangeRow {
  label: string;
  /** "—" for an empty value. */
  from: string;
  to: string;
}

export interface AuditItem {
  key: string;
  at: string;
  /** "Rae Chen · GCHX Med Transpo"; "" when the event has no staff. */
  who: string;
  /** "Nov 6, 11:10 PM" in the event timezone. */
  when: string;
  /** Set for status moves (the timeline marker is the `to` glyph). */
  status: AuditStatusChange | null;
  /** Set for everything else: "Request logged", "Photo added", "Edited Hair". */
  title: string | null;
  /** Edit rows (old → new). */
  changes: AuditChangeRow[];
  /** Show each change's label in front of it (an edit that changed several fields). */
  labelChanges: boolean;
  /** One grey line under the title: the post, "2 photos · Today", "Undo". */
  note: string | null;
  /** Free-text audit note written with the event (Jeffrey's audit_note), if any. */
  notes: string | null;
}

const EMPTY = '—';

function clip(value: string | null): string {
  if (value === null) return EMPTY;
  const chars = Array.from(value);
  return chars.length > AUDIT_VALUE_MAX ? `${chars.slice(0, AUDIT_VALUE_MAX - 1).join('').trimEnd()}…` : value;
}

/** "Rae Chen · GC/HX - Special Operations/Med Transpo" → "Rae Chen · GCHX Med Transpo". */
export function auditWho(staff: string | null | undefined): string {
  const p = parseStaff(staff);
  if (!p.name) return p.teamShort;
  return p.teamShort ? `${p.name} · ${p.teamShort}` : p.name;
}

function statusChange(from: StatusValue | null, to: StatusValue, toLabel?: string): AuditStatusChange {
  return {
    from,
    fromLabel: from ? statusMeta(from).shortLabel : null,
    to,
    toLabel: toLabel ?? statusMeta(to).shortLabel,
  };
}

/** "check_in_completed" → "Check in completed". */
function humanize(actionType: string): string {
  const s = actionType.replace(/[_-]+/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Updated';
}

const KIND_NOTE: Partial<Record<string, string>> = { undo: 'Undo', reopen: 'Reopened' };

function photoNote(count: number, timing: PhotoTimingAny | null): string | null {
  const label = timing ? PHOTO_TIMING_LABEL[timing] : null;
  if (count <= 1) return label;
  return label ? `${count} photos · ${label}` : `${count} photos`;
}

const time = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
};

/** Oldest first, stable (ties keep the server's order). */
function chronological(audit: readonly AuditEvent[]): AuditEvent[] {
  return audit
    .map((event, index) => ({ event, index }))
    .sort((a, b) => time(a.event.at) - time(b.event.at) || a.index - b.index)
    .map((x) => x.event);
}

function base(event: AuditEvent, timeZone: string): Omit<AuditItem, 'status' | 'title' | 'note' | 'changes' | 'labelChanges'> {
  return {
    key: event.id,
    at: event.at,
    who: auditWho(event.staff),
    when: formatAuditTime(event.at, timeZone),
    notes: event.notes?.trim() || null,
  };
}

/** Display items for the trail, newest first. */
export function buildAuditTrail(audit: readonly AuditEvent[], timeZone: string): AuditItem[] {
  const items: AuditItem[] = [];
  // Photo merging state: the open photo item and what it merges on.
  let photo: { item: AuditItem; staff: string | null; timing: PhotoTimingAny | null; last: number; count: number } | null = null;

  for (const event of chronological(audit)) {
    const common = base(event, timeZone);
    const plain = { status: null, title: null, changes: [], labelChanges: false, note: null } satisfies Partial<AuditItem>;

    if (event.action === 'photo') {
      const staff = canonStaff(event.staff);
      const timing = event.next.timing;
      const at = time(event.at);
      if (photo && !common.notes && !photo.item.notes && photo.staff === staff && photo.timing === timing && at - photo.last <= PHOTO_MERGE_MS) {
        photo.count += 1;
        photo.last = at;
        // The merged item shows when the last photo landed.
        photo.item.at = common.at;
        photo.item.when = common.when;
        photo.item.note = photoNote(photo.count, timing);
        continue;
      }
      const item: AuditItem = { ...common, ...plain, title: 'Photo added', note: photoNote(1, timing) };
      items.push(item);
      photo = { item, staff, timing, last: at, count: 1 };
      continue;
    }
    photo = null;

    switch (event.action) {
      case 'created': {
        const post = postFull(event.next.reportingLocation, event.next.otherLocation);
        items.push({ ...common, ...plain, title: 'Request logged', note: post || null });
        break;
      }
      case 'status': {
        // (F5) The "Not found yet" hold: its first Not found (held), and changes from or back to a hold.
        const change = statusChange(event.previous.status, event.next.status);
        const held = STAGE_META.notFoundYet;
        if (event.previous.hold && event.previous.status === STATUS.waiting) {
          change.fromLabel = held.label;
          change.fromGlyph = held.glyph;
        }
        const toHold = event.next.status === STATUS.waiting ? event.next.hold : undefined;
        if (toHold) {
          change.toLabel = held.label;
          change.toGlyph = held.glyph;
          change.toTone = held.tone;
        }
        const kindNote = (event.next.kind && KIND_NOTE[event.next.kind]) || null;
        const recheck = toHold && event.next.held ? `Recheck ${formatClockAmPm(toHold.recheckAt, timeZone)}` : null;
        items.push({ ...common, ...plain, status: change, note: recheck ?? kindNote });
        break;
      }
      case 'cancelled':
        items.push({ ...common, ...plain, status: statusChange(event.previous.status, STATUS.cancelled) });
        break;
      case 'legacy_search_not_found':
        items.push({ ...common, ...plain, status: statusChange(null, STATUS.notInMedical) });
        break;
      case 'legacy_search_found':
        items.push({ ...common, ...plain, status: statusChange(null, STATUS.inMedical) });
        break;
      case 'legacy_check':
        items.push({
          ...common,
          ...plain,
          status: statusChange(event.previous.status, STATUS.notInMedical, `${statusMeta(STATUS.notInMedical).shortLabel} (rechecked)`),
        });
        break;
      case 'edit': {
        const rows = displayChanges(event.previous ?? {}, event.next ?? {});
        const changes = rows.map((c) => ({ label: c.label, from: clip(c.from), to: clip(c.to) }));
        items.push({
          ...common,
          ...plain,
          title: changes.length > 0 ? `Edited ${rows.map((c) => c.label).join(', ')}` : 'Edited details',
          changes,
          labelChanges: changes.length > 1,
        });
        break;
      }
      case 'other':
        items.push({ ...common, ...plain, title: humanize(event.next.actionType) });
        break;
      default: {
        // A future action the client doesn't know yet: keep it in the trail.
        const unknown = event as { action?: unknown };
        items.push({ ...common, ...plain, title: humanize(typeof unknown.action === 'string' ? unknown.action : '') });
      }
    }
  }
  return items.reverse();
}

/** The moment and person behind the current status, for the status block ("Rae Chen · 11:10"). */
export interface StatusOrigin {
  staffName: string;
  at: string;
}

/**
 * (F5) Who gave the first Not found that put the request on its current "Not found yet" hold, and when: the
 * newest status event marked held. Null when the trail has none.
 */
export function holdOrigin(audit: readonly AuditEvent[]): StatusOrigin | null {
  const events = chronological(audit);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e?.action === 'status' && e.next.held) return { staffName: parseStaff(e.staff).name, at: e.at };
  }
  return null;
}

/**
 * The newest audit event that moved the request into `status` (In medical matches the legacy Bring-friend
 * status too). Null when the trail has none.
 */
export function statusOrigin(audit: readonly AuditEvent[], status: string): StatusOrigin | null {
  const matches = (to: string) => to === status || (isInMedical(status) && isInMedical(to));
  const events = chronological(audit);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (!e) continue;
    let to: string | null = null;
    if (e.action === 'status' || e.action === 'cancelled' || e.action === 'legacy_check') to = e.next.status;
    else if (e.action === 'legacy_search_found' || e.action === 'legacy_search_not_found') to = e.next.status;
    if (to !== null && matches(to)) return { staffName: parseStaff(e.staff).name, at: e.at };
  }
  return null;
}
