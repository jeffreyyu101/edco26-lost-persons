'use client';
// The All requests log (log option B, design/screens/polish-v7.html ColH / Row / fold, v7-log.png): one
// grid for the whole list, so every column lines up and sizes to its content, and each request is one
// 48 px line:  #  ·  Friend  ·  Status  ·  Created  ·  Updated. Only the name shrinks (with an ellipsis).
// Queued requests (states.html Offline) and search results (states.html SRow) use the same grid.
import { CircleAlert, ChevronDown } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { StatusGlyph } from '@/components/ui/StatusGlyph';
import type { OutboxItem, RequestSummary } from '@/lib/api-types';
import { navigate } from '@/lib/client/nav';
import type { SearchHit } from '@/lib/client/selectors';
import { statusMeta } from '@/lib/domain';
import { NOT_UPDATED } from '@/lib/format';
import {
  closedFoldLabel,
  displayName,
  highlightParts,
  isClosed,
  logNumber,
  logNumberRanges,
  outboxDisplay,
  outboxRowLabel,
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
      <span className={s.c1}>#</span>
      <span className={s.c2}>Friend</span>
      <span className={s.c3}>Status</span>
      <span className={`${s.c4} ${s.end}`}>Created</span>
      <span className={`${s.c5} ${s.end}`}>Updated</span>
    </div>
  );
}

function StatusCell({ status }: { status: string }) {
  const meta = statusMeta(status);
  return (
    <span className={`${s.c3} ${s.stc}`} data-col="status" data-tone={meta.tone}>
      <StatusGlyph status={status} className={s.lg} />
      <span className={s.stl}>{meta.shortLabel}</span>
    </span>
  );
}

export interface LogRowProps {
  row: RequestSummary;
  /** "11:02 PM" / "Thu 11:02 PM" (format.formatCreatedTime). */
  created: string;
  /** "2m" / "—" (format.formatUpdatedAgo). */
  updated: string;
  /** The full sentence (list-helpers.logRowLabel). */
  label: string;
}

/** One request: number, name, status, created, updated. Closed rows are greyed. Tap opens the profile. */
export const LogRow = memo(function LogRow({ row, created, updated, label }: LogRowProps) {
  const closed = isClosed(row.status);
  return (
    <button
      type="button"
      className={`${s.lrow} ${s.lr} ${closed ? s.closed : ''}`}
      data-request-id={row.id}
      data-closed={closed ? '' : undefined}
      aria-label={label}
      onClick={() => navigate({ r: row.id })}
    >
      <span className={`${s.c1} ${s.num}`} data-col="number">
        {logNumber(row.caseNumber)}
      </span>
      <span className={`${s.c2} ${s.nm}`} data-col="name">
        {displayName(row.name)}
      </span>
      <StatusCell status={row.status} />
      <span className={`${s.c4} ${s.tm}`} data-col="created">
        {created}
      </span>
      <span className={`${s.c5} ${s.tm}`} data-col="updated" data-none={updated === NOT_UPDATED ? '' : undefined}>
        {updated}
      </span>
    </button>
  );
});

export interface SearchLogRowProps {
  hit: SearchHit;
  created: string;
  updated: string;
  label: string;
  /** Highlight ranges in the name (name hits) and in the LP number (number hits). */
  nameRanges: Ranges;
  caseRanges: Ranges;
  /** The matched text when the hit is not the name or the number, with its ranges ('' for none). */
  line: string;
  lineRanges: Ranges;
}

/** A search result: the log row with the match highlighted, and the matched text under the name. */
export const SearchLogRow = memo(function SearchLogRow({ hit, created, updated, label, nameRanges, caseRanges, line, lineRanges }: SearchLogRowProps) {
  const { row } = hit;
  const closed = isClosed(row.status);
  const num = logNumber(row.caseNumber);
  return (
    <button
      type="button"
      className={`${s.lrow} ${s.lr} ${line ? s.lr2 : ''} ${closed ? s.closed : ''}`}
      data-request-id={row.id}
      data-closed={closed ? '' : undefined}
      aria-label={label}
      onClick={() => navigate({ r: row.id })}
    >
      <span className={`${s.c1} ${s.num}`} data-col="number">
        <Highlight text={num} ranges={logNumberRanges(row.caseNumber, caseRanges)} />
      </span>
      <span className={`${s.c2} ${s.nm}`} data-col="name">
        <Highlight text={displayName(row.name)} ranges={row.name ? nameRanges : []} />
      </span>
      <StatusCell status={row.status} />
      <span className={`${s.c4} ${s.tm}`} data-col="created">
        {created}
      </span>
      <span className={`${s.c5} ${s.tm}`} data-col="updated" data-none={updated === NOT_UPDATED ? '' : undefined}>
        {updated}
      </span>
      {line ? (
        <span className={s.match} data-col="match">
          <Highlight text={line} ranges={lineRanges} />
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
  const label = outboxRowLabel(d, created);
  const cells = (
    <>
      <span className={`${s.c1} ${s.num}`} data-col="number">
        {item.caseNumber ? logNumber(item.caseNumber) : ''}
      </span>
      <span className={`${s.c2} ${s.nm}`} data-col="name">
        {d.name}
      </span>
      <span className={`${s.c3} ${s.stc}`} data-col="status" data-tone={d.needsAttention ? 'red' : 'queued'}>
        {d.needsAttention ? (
          <CircleAlert size={14} strokeWidth={2.25} className={`${s.lg} ${s.attention}`} aria-hidden />
        ) : (
          <StatusGlyph kind="queued" className={s.lg} />
        )}
        <span className={s.stl}>{d.label}</span>
      </span>
      <span className={`${s.c4} ${s.tm}`} data-col="created">
        {created}
      </span>
      <span className={`${s.c5} ${s.tm}`} data-col="updated" data-none="">
        {NOT_UPDATED}
      </span>
    </>
  );
  if (d.needsAttention) {
    return (
      <button
        type="button"
        className={`${s.lrow} ${s.lr}`}
        data-outbox-id={item.mutationId}
        aria-label={label}
        onClick={() => navigate({ outbox: item.mutationId })}
      >
        {cells}
      </button>
    );
  }
  return (
    <div className={`${s.lrow} ${s.lr}`} data-outbox-id={item.mutationId} role="group" aria-label={label}>
      {cells}
    </div>
  );
}

/** "Closed  6  ⌄": every closed request folded into one row; tap to show them below (log option B). */
export function ClosedFold({ count, open, controls, onToggle }: { count: number; open: boolean; controls: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={s.fold}
      aria-expanded={open}
      // Only while the closed rows are on the page (folded, they are not rendered).
      aria-controls={open ? controls : undefined}
      aria-label={closedFoldLabel(count)}
      onClick={onToggle}
      data-testid="closed-fold"
    >
      <span className={s.foldLabel}>Closed</span>{' '}
      <span className={s.cap}>{count}</span>
      <span className={s.sp} />
      <span className={s.foldChev} data-open={open ? '' : undefined}>
        <ChevronDown size={16} strokeWidth={2.25} aria-hidden />
      </span>
    </button>
  );
}

/** The closed rows under the fold: a subgrid of the log, so their columns line up with the open rows. */
export function ClosedRows({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div id={id} className={s.sub} role="group" aria-label="Closed requests" data-testid="closed-rows">
      {children}
    </div>
  );
}
