'use client';
// The All requests log (log option B, design/screens/polish-v7.html ColH / Row / fold, v7-log.png): one
// grid for the whole list, so every column lines up and sizes to its content, and each request is one
// 48 px line:  message lane  ·  Friend  ·  Status  ·  Created  ·  Updated. The name takes the room that is left,
// with an 80 px floor: on a narrow phone the status label gets shorter ("Waiting", "En route"), and only past the
// floor is it cut. The lane and the times never shrink.
// (Message lane, design/screens/msg-indicator.html, Brian 2026-11-07) The # column made way for a fixed 31 px lane
// with no header: the blue bubble with the unread count, the grey outline once read, nothing without messages
// (MessageMark). The row stays one button: a tap in the lane (a 52 px wide, full-height hit area) opens the
// request at its Messages, anywhere else at the top (openRowAt). The LP number is in the row's sentence, and on a
// search result's second line when the number matched.
// Queued requests (states.html Offline) and search results (states.html SRow) use the same grid. Sorted by
// status (Pending v9.1, design/screens/pending-v9.html frame 6), thin pinned dividers name each group: glyph,
// label, count.
import { CircleAlert, ChevronDown, ChevronRight } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { MessageMark, UnreadBubble, openRowAt } from '@/components/messages/CardActivity';
import { StageGlyph } from '@/components/ui/StageGlyph';
import { StatusGlyph } from '@/components/ui/StatusGlyph';
import type { OutboxItem, RequestSummary } from '@/lib/api-types';
import { navigate } from '@/lib/client/nav';
import type { SearchHit } from '@/lib/client/selectors';
import { STATUS_GROUP_META, type StatusGroupName } from '@/lib/client/status-order';
import { STAGE_META, stageLook, type StageKey } from '@/lib/stages';
import { NOT_UPDATED, formatCaseNumber } from '@/lib/format';
import {
  archivedFoldLabel,
  displayName,
  highlightParts,
  isClosed,
  logRowLabel,
  outboxDisplay,
  outboxRowLabel,
  searchLogLabel,
  type Ranges,
} from './list-helpers';
import s from './list.module.css';

export function Highlight({ text, ranges }: { text: string; ranges: Ranges }) {
  if (ranges.length === 0) return <>{text}</>;
  return (
    <>
      {highlightParts(text, ranges).map((part, i) =>
        part.hit ? (
          <mark key={i} className={s.mark}>
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

/** The log grid. Its rows (and the column header) are subgrids of it. */
export function LogGrid({ children, testId = 'request-list' }: { children: ReactNode; testId?: string }) {
  return (
    <div className={s.log} data-testid={testId}>
      {children}
    </div>
  );
}

/** The quiet column header (hidden from screen readers: every row's name says what each value is). */
export function ColumnHeader() {
  return (
    <div className={`${s.lrow} ${s.colh}`} aria-hidden data-testid="log-columns">
      {/* The message lane has no header: its mark says what it is. */}
      <span className={s.c1} />
      <span className={s.c2}>Friend</span>
      <span className={s.c3}>Status</span>
      {/* One right-aligned pair over both time columns: "Updated" is wider than anything under it ("—", "2m",
          "now"), so on its own it would widen that column and take the room from the names. */}
      <span className={s.c45}>
        <span>Created</span>
        <span>Updated</span>
      </span>
    </div>
  );
}

// A row's accessible name is its content, not an aria-label: one screen-reader-only sentence, with the
// visible cells hidden from screen readers. So it reads "LP-1013, T.R., Waiting for check, created
// 11:02 PM, updated 2 minutes ago" (list-helpers.logRowLabel) and never "1013 T.R. … 2m", and the label-in-
// name check (WCAG 2.5.3) has no aria-label to compare against the compact visible values.

/** Words for screen readers only (in the row's name, not on screen). */
function Vh({ children }: { children: ReactNode }) {
  return <span className={s.vh}>{children}</span>;
}

interface LogCellsProps {
  /** The message lane (MessageMark), or an empty lane for an unsent request. */
  lane: ReactNode;
  name: ReactNode;
  /** The status glyph. */
  glyph: ReactNode;
  tone: string;
  statusLabel: string;
  /** A shorter label for narrow phones ("Waiting"), or null to keep the label everywhere. */
  statusNarrow?: string | null;
  created: string;
  updated: string;
}

/** The visible cells of a row (hidden from screen readers: the row's sentence says it all). */
function LogCells({ lane, name, glyph, tone, statusLabel, statusNarrow, created, updated }: LogCellsProps) {
  return (
    <>
      {lane}
      <span className={`${s.c2} ${s.nm}`} data-col="name" aria-hidden>
        {name}
      </span>
      <span className={`${s.c3} ${s.stc}`} data-col="status" data-tone={tone} aria-hidden>
        {glyph}
        <span className={s.stl}>
          {statusNarrow ? (
            <>
              <span className={s.stWide}>{statusLabel}</span>
              <span className={s.stNarrow} data-narrow="">
                {statusNarrow}
              </span>
            </>
          ) : (
            statusLabel
          )}
        </span>
      </span>
      <span className={`${s.c4} ${s.tm}`} data-col="created" aria-hidden>
        {created}
      </span>
      <span className={`${s.c5} ${s.tm}`} data-col="updated" data-none={updated === NOT_UPDATED ? '' : undefined} aria-hidden>
        {updated}
      </span>
    </>
  );
}

/**
 * The label a stage shows under 430 px (lib/stages STAGE_META narrow): Waiting for check → "Waiting", Friend en
 * route → "En route", Friend arrived → "Arrived", Recheck due → "Recheck", Closed · inactive → "Inactive". The
 * other stages are short already (null).
 */
export const narrowStageLabel = (key: StageKey): string | null => (key === 'legacy' ? null : (STAGE_META[key].narrow ?? null));

/** A row's message lane: the mark, with the lane's hit area (list.module.css .lane). */
const lane = (row: RequestSummary) => <MessageMark row={row} className={`${s.c1} ${s.lane}`} />;

export interface LogRowProps {
  row: RequestSummary;
  /** "11:02 PM" / "Thu 11:02 PM" (format.formatCreatedTime). */
  created: string;
  /** "2m" / "—" (format.formatUpdatedAgo). */
  updated: string;
  /** "updated 2 minutes ago" / "not updated yet" (format.updatedPhrase). */
  updatedSaid: string;
  /** (F5) The event timezone, for the stage in the row's sentence. */
  timeZone?: string;
  /**
   * (Pending v9.1) The clock the stage reads: a hold whose recheck time has passed reads "Recheck due". Pass
   * list-helpers.stageClock(row, now), not the ticking clock: it changes only when the stage does, so the memo
   * skips every other row on a tick.
   */
  now?: number;
}

/**
 * One request: message lane, name, status, created, updated. Closed rows are greyed (the lane's read mark gray-10, an
 * unread bubble stays blue). A tap opens the request, at its Messages when it landed in the lane.
 */
export const LogRow = memo(function LogRow({ row, created, updated, updatedSaid, timeZone, now = 0 }: LogRowProps) {
  const closed = isClosed(row.status);
  // (F5) The stage: Needs info, Not found yet, Recheck due, Friend en route… over the stored status.
  const look = stageLook(row, now);
  return (
    <button
      type="button"
      className={`${s.lrow} ${s.lr} ${closed ? s.closed : ''}`}
      data-request-id={row.id}
      data-closed={closed ? '' : undefined}
      onClick={(e) => openRowAt(row.id, e.target)}
    >
      <Vh>{logRowLabel(row, created, updatedSaid, timeZone, now)}</Vh>
      <LogCells
        lane={lane(row)}
        name={displayName(row.name)}
        glyph={<StageGlyph glyph={look.glyph} className={s.lg} />}
        tone={look.tone}
        statusLabel={look.label}
        statusNarrow={narrowStageLabel(look.key)}
        created={created}
        updated={updated}
      />
    </button>
  );
});

export interface SearchLogRowProps extends Omit<LogRowProps, 'row'> {
  hit: SearchHit;
  /** Highlight ranges in the name (name hits) and in the LP number (number hits). */
  nameRanges: Ranges;
  caseRanges: Ranges;
  /** The matched text when the hit is not the name or the number, with its ranges ('' for none). */
  line: string;
  lineRanges: Ranges;
}

/**
 * A search result: the log row with the match highlighted, and the matched text under the name. With the # column
 * gone, a number match shows the LP number there, highlighted ("LP-1013"; the row's sentence starts with it).
 */
export const SearchLogRow = memo(function SearchLogRow({ hit, created, updated, updatedSaid, timeZone, now = 0, nameRanges, caseRanges, line, lineRanges }: SearchLogRowProps) {
  const { row } = hit;
  const closed = isClosed(row.status);
  const look = stageLook(row, now);
  // The matched text, else the LP number when it is what matched (caseRanges are in formatCaseNumber's text).
  const shown = line ? { text: line, ranges: lineRanges } : caseRanges.length > 0 ? { text: formatCaseNumber(row.caseNumber), ranges: caseRanges } : null;
  return (
    <button
      type="button"
      className={`${s.lrow} ${s.lr} ${shown ? s.lr2 : ''} ${closed ? s.closed : ''}`}
      data-request-id={row.id}
      data-closed={closed ? '' : undefined}
      onClick={(e) => openRowAt(row.id, e.target)}
    >
      <Vh>{searchLogLabel(row, created, updatedSaid, line, timeZone, now)}</Vh>
      <LogCells
        lane={lane(row)}
        name={<Highlight text={displayName(row.name)} ranges={row.name ? nameRanges : []} />}
        glyph={<StageGlyph glyph={look.glyph} className={s.lg} />}
        tone={look.tone}
        statusLabel={look.label}
        statusNarrow={narrowStageLabel(look.key)}
        created={created}
        updated={updated}
      />
      {shown ? (
        <span className={s.match} data-col="match" aria-hidden>
          <Highlight text={shown.text} ranges={shown.ranges} />
        </span>
      ) : null}
    </button>
  );
});

/**
 * A request saved on this phone and not sent yet, in the same grid: dashed glyph and "Waiting to send" (or
 * "Needs attention", which opens its editor). No LP number yet, and nothing has updated it.
 */
export function OutboxLogRow({ item, created }: { item: OutboxItem; created: string }) {
  const d = outboxDisplay(item);
  // "Kayla, 19 F, 11:02 PM. Waiting to send, FA 3, Not sent." (+ "Open to fix and resend.")
  const label = outboxRowLabel(d, created);
  const cells = (
    <LogCells
      lane={<span className={`${s.c1} ${s.lane}`} aria-hidden />}
      name={d.name}
      glyph={
        d.needsAttention ? (
          <CircleAlert size={14} strokeWidth={2.25} className={`${s.lg} ${s.attention}`} aria-hidden />
        ) : (
          <StatusGlyph kind="queued" className={s.lg} />
        )
      }
      tone={d.needsAttention ? 'red' : 'queued'}
      statusLabel={d.label}
      created={created}
      updated={NOT_UPDATED}
    />
  );
  if (d.needsAttention) {
    return (
      <button type="button" className={`${s.lrow} ${s.lr}`} data-outbox-id={item.mutationId} onClick={() => navigate({ outbox: item.mutationId })}>
        <Vh>{label}</Vh>
        {cells}
      </button>
    );
  }
  // Not a control: a group named by the same sentence.
  return (
    <div className={`${s.lrow} ${s.lr}`} data-outbox-id={item.mutationId} role="group" aria-label={label}>
      {cells}
    </div>
  );
}

/**
 * "Archived  6  ›": every closed request (Not in medical, Reunited, Discharged, Cancelled) folded into one
 * row under the open ones (log option B; named Archived by Brian, 2026-11-06). Tap to show them below, greyed.
 * (Pending v9.1, pending-v9.html .arch) › while folded, ⌄ while open, gray-11: Pending's section headers' fold.
 * (Message lane) In the log (`lane`), "Archived" lines up with the names, and while folded the lane carries the
 * unread messages of the rows it hides: the blue bubble with their total, and its name says it ("Archived 6
 * requests. 3 unread messages.").
 */
export function ArchivedFold({
  count,
  open,
  controls,
  onToggle,
  label = 'Archived',
  className,
  lane = false,
  unread = 0,
}: {
  count: number;
  open: boolean;
  controls: string;
  onToggle: () => void;
  /** (Pending v9.1) "Closed" on My requests sorted by status. */
  label?: string;
  className?: string;
  /** In the log grid: the message lane leads the row. */
  lane?: boolean;
  /** The unread messages on the folded rows (list-helpers.unreadTotal). */
  unread?: number;
}) {
  const sum = open ? 0 : unread;
  // Named by its content, as the rows are (no aria-label): one screen-reader-only sentence, the visible parts hidden
  // from screen readers. The lane's "99+" could never match a spoken "120", so an aria-label would fail label-in-name.
  return (
    <button
      type="button"
      className={className ? `${s.fold} ${className}` : s.fold}
      aria-expanded={open}
      // Only while the closed rows are on the page (folded, they are not rendered).
      aria-controls={open ? controls : undefined}
      onClick={onToggle}
      // The test ids keep their log option B names (closed-fold, closed-rows), which other specs use.
      data-testid="closed-fold"
    >
      {lane ? (
        <span className={s.foldLane} data-lane="" aria-hidden>
          {sum > 0 ? <UnreadBubble count={sum} /> : null}
        </span>
      ) : null}
      <span className={s.foldLabel} aria-hidden>
        {label}
      </span>
      <span className={s.cap} aria-hidden>
        {count}
      </span>
      <span className={s.sp} />
      <span className={s.foldChev} aria-hidden>
        {open ? <ChevronDown size={16} strokeWidth={2} /> : <ChevronRight size={16} strokeWidth={2} />}
      </span>
      <Vh>{archivedFoldLabel(count, label, sum)}</Vh>
    </button>
  );
}

/** The archived rows under the fold: a subgrid of the log, so their columns line up with the open rows. */
export function ArchivedRows({ id, children, label = 'Archived' }: { id: string; children: ReactNode; label?: string }) {
  return (
    <div id={id} className={s.sub} role="group" aria-label={`${label} requests`} data-testid="closed-rows">
      {children}
    </div>
  );
}

/**
 * "○ Waiting for check 7": the thin divider over a status group when a list is sorted by status (pending-v9.html
 * .gd). It pins under the view's sticky header while its group scrolls. A heading, named in words.
 */
export function GroupDivider({ group, count, label, cards = false }: { group: StatusGroupName; count: number; label?: string; cards?: boolean }) {
  const g = STATUS_GROUP_META[group];
  const name = label ?? g.label;
  return (
    <div className={cards ? `${s.gd} ${s.gdCards}` : s.gd} role="heading" aria-level={2} data-group={group} data-testid={`group-${group}`}>
      <StatusGlyph kind={g.glyph} size={14} />
      <span aria-hidden>{name}</span>
      <span className={s.gdn} aria-hidden>
        {count}
      </span>
      <span className={s.vh}>{`${name} ${count} ${count === 1 ? 'request' : 'requests'}`}</span>
    </div>
  );
}
