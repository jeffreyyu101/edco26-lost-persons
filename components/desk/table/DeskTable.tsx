'use client';
// The desk request table's parts (design/screens/desktop-log.html .tbl / .th / .tr / .fold): the column
// header, a request row, a search result row, an unsent (outbox) row, the Archived fold, a group header and
// the loading skeleton. Every row is one 44 px line on a fixed column grid, so the columns line up across
// rows without measuring (Plane, mobbin-desktop.txt §2). The views that compose them are in
// ./DeskTableViews.tsx.
//
// A row is a button named by one screen-reader sentence (./table-model.ts); its visible cells are hidden
// from screen readers, as on the phone log. Rows carry data-request-id: the desk keyboard (J / K, Enter,
// Esc) and the pane's previous / next walk them in the order shown, and the open request is the selected
// row (data-selected, aria-current).
import { Skeleton } from '@radix-ui/themes';
import { ChevronDown, CircleAlert, RefreshCw } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { StageGlyph } from '@/components/ui/StageGlyph';
import { StatusGlyph } from '@/components/ui/StatusGlyph';
import type { OutboxItem, RequestSummary } from '@/lib/api-types';
import { navigate } from '@/lib/client/nav';
import type { SearchHit } from '@/lib/client/selectors';
import { stageLook, type DisplayStage } from '@/lib/stages';
import { NOT_UPDATED } from '@/lib/format';
import { archivedFoldLabel, highlightParts, isClosed, logNumber, logNumberRanges, type Ranges } from '@/components/list/list-helpers';
import {
  TABLE_COLUMNS,
  friendCell,
  loggedByPhrase,
  loggedByShort,
  outboxRow,
  postCell,
  searchRowLabel,
  tableRowLabel,
  type RowTimes,
  type TableColumnKey,
} from './table-model';
import t from './table.module.css';

const COLUMN_CLASS: Readonly<Record<TableColumnKey, string | undefined>> = {
  number: t.cNum,
  friend: t.cFriend,
  status: t.cStatus,
  post: t.cPost,
  created: t.cCreated,
  updated: t.cUpdated,
  by: t.cBy,
};

const cx = (...names: Array<string | false | null | undefined>) => names.filter(Boolean).join(' ');

/** The table: its column header, then the rows. data-testid="request-list" as on the phone. */
export function DeskTable({ children, testId = 'request-list' }: { children: ReactNode; testId?: string }) {
  return (
    <div className={t.table} data-testid={testId} data-desk-table="">
      <ColumnHeader />
      {children}
    </div>
  );
}

/**
 * "#  Friend  Status  Post  Created  Updated  Logged by", sticky under the top bar. Every row's sentence says
 * what each value is, so the header is hidden from screen readers.
 */
export function ColumnHeader() {
  return (
    <div className={cx(t.grid, t.th)} aria-hidden data-testid="desk-table-columns">
      {TABLE_COLUMNS.map((c) => (
        <span key={c.key} className={COLUMN_CLASS[c.key]} data-col={c.key}>
          {c.label}
        </span>
      ))}
    </div>
  );
}

/** Words for screen readers only. */
function Vh({ children }: { children: ReactNode }) {
  return <span className={t.vh}>{children}</span>;
}

export function Highlight({ text, ranges }: { text: string; ranges: Ranges }) {
  if (ranges.length === 0) return <>{text}</>;
  return (
    <>
      {highlightParts(text, ranges).map((part, i) =>
        part.hit ? (
          <mark key={i} className={t.mark}>
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

interface CellsProps {
  number: ReactNode;
  name: ReactNode;
  ageGender: string;
  /** The matched text of a search result, on a second line under the name. */
  line?: ReactNode;
  glyph: ReactNode;
  tone: string;
  statusLabel: string;
  /** (F5) What follows the label: "· 4:40 PM", "· Bed 3", "· ~4 min", "· 2 checks". */
  statusExtra?: string;
  /** (F5) Its short form for a narrow status column ("· 4:40"; '' for none). Absent: always `statusExtra`. */
  statusExtraShort?: string;
  /** (F5) A glyph before it: ⟳ for a recheck time. */
  statusExtraGlyph?: 'recheck';
  post: string;
  created: string;
  createdTitle?: string;
  updated: string;
  updatedTitle?: string | null;
  by: string;
  byTitle?: string;
}

/** The visible cells of a row (hidden from screen readers: the row's sentence says it all). */
function Cells(p: CellsProps) {
  return (
    <>
      <span className={cx(t.cNum, t.num)} data-col="number" aria-hidden>
        {p.number}
      </span>
      <span className={cx(t.cFriend, t.friend)} data-col="friend" aria-hidden>
        <span className={t.who}>
          <span className={t.nm}>{p.name}</span>
          {p.ageGender ? <span className={t.ag}>{p.ageGender}</span> : null}
        </span>
        {p.line ? <span className={t.match}>{p.line}</span> : null}
      </span>
      <span className={cx(t.cStatus, t.st)} data-col="status" data-tone={p.tone} aria-hidden>
        {p.glyph}
        <span className={t.stl}>{p.statusLabel}</span>
        <StatusExtra extra={p.statusExtra} short={p.statusExtraShort} glyph={p.statusExtraGlyph} />
      </span>
      <span className={cx(t.cPost, t.mut)} data-col="post" aria-hidden>
        {p.post}
      </span>
      <span className={cx(t.cCreated, t.tm)} data-col="created" title={p.createdTitle} aria-hidden>
        {p.created}
      </span>
      <span
        className={cx(t.cUpdated, t.tm)}
        data-col="updated"
        data-none={p.updated === NOT_UPDATED ? '' : undefined}
        title={p.updatedTitle ?? undefined}
        aria-hidden
      >
        {p.updated}
      </span>
      <span className={cx(t.cBy, t.mut)} data-col="by" title={p.byTitle} aria-hidden>
        {p.by}
      </span>
    </>
  );
}

/** (F5) What follows the status label: whole while the column has room, else its short form. */
function StatusExtra({ extra, short, glyph }: { extra?: string; short?: string; glyph?: 'recheck' }) {
  if (!extra) return null;
  const mark = glyph === 'recheck' ? <RefreshCw size={12} strokeWidth={2} className={t.stxGlyph} aria-hidden /> : null;
  if (short === undefined) {
    return (
      <>
        {mark}
        <span className={t.stx}>{extra}</span>
      </>
    );
  }
  return (
    <>
      {mark}
      <span className={cx(t.stx, t.stxWide)}>{extra}</span>
      {short ? <span className={cx(t.stx, t.stxNarrow)}>{short}</span> : null}
    </>
  );
}

export interface TableRowProps {
  row: RequestSummary;
  times: RowTimes;
  /** The request open in the pane. */
  selected: boolean;
  /**
   * (F5) The row's stage at the views' clock (lib/stages displayStage): label and what follows it ("Friend en
   * route · ~4 min"). Without it, the stage's label alone.
   */
  stage?: DisplayStage;
  /** (F5) For the stage in the row's sentence. */
  timeZone?: string;
}

/** One request. Closed rows are greyed in place. A click opens it (beside the list on the desk). */
export const TableRow = memo(function TableRow({ row, times, selected, stage, timeZone }: TableRowProps) {
  const closed = isClosed(row.status);
  const look = stage ?? stageLook(row);
  const friend = friendCell(row);
  return (
    <button
      type="button"
      className={cx(t.grid, t.row, closed && t.closed)}
      data-request-id={row.id}
      data-closed={closed ? '' : undefined}
      data-selected={selected ? '' : undefined}
      aria-current={selected ? 'true' : undefined}
      onClick={() => navigate({ r: row.id })}
    >
      <Vh>{tableRowLabel(row, times, timeZone)}</Vh>
      <Cells
        number={logNumber(row.caseNumber)}
        name={friend.name}
        ageGender={friend.ageGender}
        glyph={<StageGlyph glyph={look.glyph} className={t.glyph} />}
        tone={look.tone}
        statusLabel={look.label}
        statusExtra={stage?.extra}
        statusExtraShort={stage?.extraShort}
        statusExtraGlyph={stage?.extraGlyph}
        post={postCell(row)}
        created={times.created}
        createdTitle={times.createdTitle}
        updated={times.updated}
        updatedTitle={times.updatedTitle}
        by={loggedByShort(row.createdBy)}
        byTitle={loggedByPhrase(row.createdBy)}
      />
    </button>
  );
});

export interface SearchRowProps extends Omit<TableRowProps, 'row'> {
  hit: SearchHit;
  nameRanges: Ranges;
  caseRanges: Ranges;
  /** The matched text when the hit is not the name or the number ('' for none), and its ranges. */
  line: string;
  lineRanges: Ranges;
}

/** A search result: the row with the match highlighted, and the matched text under the name. */
export const SearchRow = memo(function SearchRow({ hit, times, selected, stage, timeZone, nameRanges, caseRanges, line, lineRanges }: SearchRowProps) {
  const { row } = hit;
  const closed = isClosed(row.status);
  const look = stage ?? stageLook(row);
  const friend = friendCell(row);
  return (
    <button
      type="button"
      className={cx(t.grid, t.row, closed && t.closed, !!line && t.two)}
      data-request-id={row.id}
      data-closed={closed ? '' : undefined}
      data-selected={selected ? '' : undefined}
      aria-current={selected ? 'true' : undefined}
      onClick={() => navigate({ r: row.id })}
    >
      <Vh>{searchRowLabel(row, times, line, timeZone)}</Vh>
      <Cells
        number={<Highlight text={logNumber(row.caseNumber)} ranges={logNumberRanges(row.caseNumber, caseRanges)} />}
        name={<Highlight text={friend.name} ranges={row.name ? nameRanges : []} />}
        ageGender={friend.ageGender}
        line={line ? <Highlight text={line} ranges={lineRanges} /> : null}
        glyph={<StageGlyph glyph={look.glyph} className={t.glyph} />}
        tone={look.tone}
        statusLabel={look.label}
        statusExtra={stage?.extra}
        statusExtraShort={stage?.extraShort}
        statusExtraGlyph={stage?.extraGlyph}
        post={postCell(row)}
        created={times.created}
        createdTitle={times.createdTitle}
        updated={times.updated}
        updatedTitle={times.updatedTitle}
        by={loggedByShort(row.createdBy)}
        byTitle={loggedByPhrase(row.createdBy)}
      />
    </button>
  );
});

/**
 * A request saved on this device and not sent yet (states.html Offline): a dashed glyph and "Waiting to
 * send", no number and nothing updated. "Needs attention" opens its editor; a waiting one is not a control.
 */
export function OutboxRow({ item, created }: { item: OutboxItem; created: string }) {
  const m = outboxRow(item, created);
  const cells = (
    <Cells
      number={m.number}
      name={m.name}
      ageGender={m.ageGender}
      glyph={
        m.needsAttention ? (
          <CircleAlert size={14} strokeWidth={2.25} className={cx(t.glyph, t.attention)} aria-hidden />
        ) : (
          <StatusGlyph kind="queued" className={t.glyph} />
        )
      }
      tone={m.needsAttention ? 'red' : 'queued'}
      statusLabel={m.label}
      post={m.post}
      created={created}
      updated={NOT_UPDATED}
      by={m.by}
    />
  );
  if (m.needsAttention) {
    return (
      <button type="button" className={cx(t.grid, t.row)} data-outbox-id={item.mutationId} onClick={() => navigate({ outbox: item.mutationId })}>
        <Vh>{m.said}</Vh>
        {cells}
      </button>
    );
  }
  return (
    <div className={cx(t.grid, t.row)} data-outbox-id={item.mutationId} role="group" aria-label={m.said}>
      {cells}
    </div>
  );
}

/**
 * "Archived  6  ⌄": every closed request folded into one row under the open ones, exactly as F1's phone
 * log (the same test ids, name and remembered open state, prefs.closedExpanded).
 */
export function ArchivedFold({ count, open, controls, onToggle }: { count: number; open: boolean; controls: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={t.fold}
      aria-expanded={open}
      // Only while the closed rows are on the page (folded, they are not rendered).
      aria-controls={open ? controls : undefined}
      aria-label={archivedFoldLabel(count)}
      onClick={onToggle}
      data-testid="closed-fold"
    >
      <span className={t.foldLabel}>Archived</span> <span className={t.cap}>{count}</span>
      <span className={t.sp} />
      <span className={t.chev} data-open={open ? '' : undefined}>
        <ChevronDown size={16} strokeWidth={2.25} aria-hidden />
      </span>
    </button>
  );
}

/** The archived rows under the fold. */
export function ArchivedRows({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div id={id} role="group" aria-label="Archived requests" data-testid="closed-rows">
      {children}
    </div>
  );
}

/** A static group header ("Closed  4" in My requests, where closed requests are never folded away). */
export function GroupHeader({ label, count }: { label: string; count: number }) {
  return (
    <h2 className={t.fold} data-static="">
      <span className={t.foldLabel}>{label}</span> <span className={t.cap}>{count}</span>
    </h2>
  );
}

// Varied widths so the skeleton reads like the table, not a grid of identical bars.
const SK_ROWS: ReadonlyArray<readonly [string, string, string]> = [
  ['44%', '112px', '84px'],
  ['62%', '112px', '96px'],
  ['36%', '112px', '72px'],
  ['52%', '72px', '96px'],
  ['40%', '72px', '84px'],
  ['58%', '88px', '72px'],
  ['46%', '72px', '96px'],
  ['54%', '96px', '84px'],
];

function Sk({ w, h = 12, round = false }: { w: string; h?: number; round?: boolean }) {
  return <Skeleton width={w} height={`${h}px`} style={round ? { borderRadius: '50%', flex: 'none' } : { flex: 'none' }} />;
}

/** One placeholder cell: the column's own class (so Post and Logged by hide as theirs do), content inside. */
function SkCell({ col, end = false, children }: { col: TableColumnKey; end?: boolean; children: ReactNode }) {
  return (
    <span className={COLUMN_CLASS[col]}>
      <span className={cx(t.skCell, end && t.skEnd)}>{children}</span>
    </span>
  );
}

/** Loading (no cached data yet): the real column header over placeholder rows in the same columns. */
export function TableSkeleton() {
  return (
    <div className={t.table} role="status" aria-busy="true" aria-label="Loading requests" data-testid="desk-table-skeleton">
      <ColumnHeader />
      {SK_ROWS.map(([name, status, other], i) => (
        <div key={i} className={cx(t.grid, t.row, t.skRow)} aria-hidden>
          <SkCell col="number">
            <Sk w="34px" h={11} />
          </SkCell>
          <SkCell col="friend">
            <Sk w={name} h={13} />
          </SkCell>
          <SkCell col="status">
            <Sk w="14px" h={14} round />
            <Sk w={status} h={11} />
          </SkCell>
          <SkCell col="post">
            <Sk w={other} h={11} />
          </SkCell>
          <SkCell col="created" end>
            <Sk w="58px" h={11} />
          </SkCell>
          <SkCell col="updated" end>
            <Sk w="22px" h={11} />
          </SkCell>
          <SkCell col="by">
            <Sk w={other} h={11} />
          </SkCell>
        </div>
      ))}
    </div>
  );
}
