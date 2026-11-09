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
//
// (Pending v9.1, Brian 2026-11-06, design/screens/pending-v9.html frame 8) On All requests and My requests the
// column header is the sort control: "Created ↓" (All) or "Updated ↓" (My requests) by default, "Status ↓" when
// sorted by status (aria-sort; the arrow only on the active header; Status again goes back). Sorted by status,
// group header rows (glyph, label, count) sit over Waiting for check and Friend coming, and the closed ones fold
// last. The header is then a one-row table of its own, so its column headers can carry aria-sort.
//
// (Message lane, design/screens/msg-indicator.html, Brian 2026-11-07) The phone log's message lane leads every row,
// before #: the blue bubble with the unread count, the grey outline once read, nothing without messages. It
// replaces the count pill after the name. A click in the lane lands at the thread (openRowAt). With a request
// docked beside the table under 1320 px the # column goes: the pane's top bar carries the LP number.
import { Skeleton } from '@radix-ui/themes';
import { ArrowDown, ArrowUpDown, ChevronDown, ChevronRight, CircleAlert } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { MessageMark, UnreadBubble, openRowAt } from '@/components/messages/CardActivity';
import { StageGlyph } from '@/components/ui/StageGlyph';
import { StatusGlyph } from '@/components/ui/StatusGlyph';
import type { OutboxItem, RequestSummary } from '@/lib/api-types';
import { navigate } from '@/lib/client/nav';
import type { SearchHit } from '@/lib/client/selectors';
import { STATUS_GROUP_META, type StatusGroupName } from '@/lib/client/status-order';
import type { SortOrder } from '@/lib/client/view-prefs';
import { waitTone } from '@/lib/domain';
import { stageLook, type DisplayStage } from '@/lib/stages';
import { NOT_UPDATED, formatCaseNumber } from '@/lib/format';
import { archivedFoldLabel, highlightParts, isClosed, logNumber, logNumberRanges, messagesSentence, type Ranges } from '@/components/list/list-helpers';
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

/** (Pending v9.1) The table's order and how its header changes it. */
export interface TableSort {
  order: SortOrder;
  /** The default order's column: Created (All requests, newest first) or Updated (My requests, latest first). */
  defaultColumn: 'created' | 'updated';
  onChange: (order: SortOrder) => void;
}

/** The table: its column header, then the rows. data-testid="request-list" as on the phone. */
export function DeskTable({ children, testId = 'request-list', sort }: { children: ReactNode; testId?: string; sort?: TableSort }) {
  return (
    <div className={t.table} data-testid={testId} data-desk-table="" data-order={sort?.order}>
      <ColumnHeader sort={sort} />
      {children}
    </div>
  );
}

const DEFAULT_SAID: Readonly<Record<TableSort['defaultColumn'], { order: string; sortBy: string }>> = {
  created: { order: 'newest first', sortBy: 'Sort by newest' },
  updated: { order: 'latest update first', sortBy: 'Sort by latest update' },
};

/** A sortable column header's accessible name: its label, its state, and what a click does. */
export function sortHeaderLabel(column: 'status' | TableSort['defaultColumn'], label: string, sort: Pick<TableSort, 'order' | 'defaultColumn'>): string {
  const d = DEFAULT_SAID[sort.defaultColumn];
  if (column === 'status') return sort.order === 'status' ? `${label}, sorted waiting for check first. ${d.sortBy}` : `${label}. Sort by status, waiting for check first`;
  return sort.order === 'status' ? `${label}. ${d.sortBy}` : `${label}, ${d.order}`;
}

/**
 * "#  Friend  Status  Post  Created  Updated  Logged by" (nothing over the message lane), sticky under the top bar.
 * Every row's sentence says what each value is, so without a sort the header is hidden from screen readers. With one (All and My
 * requests), Status and Created / Updated are buttons that set the order, the active one gray-12 with ↓.
 */
export function ColumnHeader({ sort }: { sort?: TableSort }) {
  if (!sort) {
    return (
      <div className={cx(t.grid, t.th, t.thSticky)} aria-hidden data-testid="desk-table-columns">
        <span className={t.lane} />
        {TABLE_COLUMNS.map((c) => (
          <span key={c.key} className={COLUMN_CLASS[c.key]} data-col={c.key}>
            {c.label}
          </span>
        ))}
      </div>
    );
  }
  const active = sort.order === 'status' ? 'status' : sort.defaultColumn;
  return (
    <div className={t.thSticky} role="table" aria-label="Sort requests" data-testid="desk-table-columns">
      <div className={cx(t.grid, t.th)} role="row">
        {/* The message lane has no header: its mark says what it is. */}
        <span className={t.lane} aria-hidden />
        {TABLE_COLUMNS.map((c) => {
          const sortable = c.key === 'status' || c.key === sort.defaultColumn;
          const on = sortable && c.key === active;
          return (
            <span
              key={c.key}
              role="columnheader"
              className={COLUMN_CLASS[c.key]}
              data-col={c.key}
              aria-sort={on ? (c.key === 'status' ? 'other' : 'descending') : undefined}
            >
              {sortable ? (
                <button
                  type="button"
                  className={cx(t.thb, on && t.thbOn)}
                  aria-label={sortHeaderLabel(c.key as 'status' | TableSort['defaultColumn'], c.label, sort)}
                  data-testid={`sort-${c.key}`}
                  onClick={() => {
                    if (c.key === 'status') sort.onChange(sort.order === 'status' ? 'default' : 'status');
                    else if (sort.order === 'status') sort.onChange('default');
                  }}
                >
                  {c.label}
                  {on ? <ArrowDown size={13} strokeWidth={2.25} aria-hidden /> : <ArrowUpDown size={12} strokeWidth={2} className={t.thHint} aria-hidden />}
                </button>
              ) : (
                c.label
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** (Pending v9.1) "○ Waiting for check  7": a group header row over a status group, sticky under the column header. */
export function GroupRow({ group, count, label }: { group: StatusGroupName; count: number; label?: string }) {
  const g = STATUS_GROUP_META[group];
  const name = label ?? g.label;
  return (
    <div className={t.gh} role="heading" aria-level={2} data-group={group} data-testid={`group-${group}`}>
      <StatusGlyph kind={g.glyph} size={14} />
      <span aria-hidden>{name}</span>
      <span className={t.ghn} aria-hidden>
        {count}
      </span>
      <span className={t.vh}>{`${name} ${count} ${count === 1 ? 'request' : 'requests'}`}</span>
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
  /** (Message lane) The row's mark (MessageMark); an empty lane when absent. */
  lane?: ReactNode;
  number: ReactNode;
  name: ReactNode;
  ageGender: string;
  /** The matched text of a search result, on a second line under the name. */
  line?: ReactNode;
  /** (Message lane) A number hit's LP number under the name, shown only while docked (the # column is gone there). */
  numLine?: ReactNode;
  glyph: ReactNode;
  tone: string;
  statusLabel: string;
  /** (F5) What follows the label: "· 27m" (every stage of Waiting for check), "· Bed 3", "· ~4 min", "· 2 checks". */
  statusExtra?: string;
  /** (F5) Its short form for a narrow status column ('' for none: a closed row's "· 2 checks"). Absent: always `statusExtra`. */
  statusExtraShort?: string;
  /** (Pending v9.1) The wait's heat (amber from 10 minutes, red from 20) when the extra is a wait. */
  statusExtraTone?: string;
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
      {p.lane ?? <span className={t.lane} aria-hidden />}
      <span className={cx(t.cNum, t.num)} data-col="number" aria-hidden>
        {p.number}
      </span>
      <span className={cx(t.cFriend, t.friend)} data-col="friend" aria-hidden>
        <span className={t.who}>
          <span className={t.nm}>{p.name}</span>
          {p.ageGender ? <span className={t.ag}>{p.ageGender}</span> : null}
        </span>
        {p.line ? <span className={t.match}>{p.line}</span> : null}
        {p.numLine ? <span className={cx(t.match, t.numLine)}>{p.numLine}</span> : null}
      </span>
      <span className={cx(t.cStatus, t.st)} data-col="status" data-tone={p.tone} aria-hidden>
        {p.glyph}
        <span className={t.stl}>{p.statusLabel}</span>
        <StatusExtra extra={p.statusExtra} short={p.statusExtraShort} tone={p.statusExtraTone} />
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
function StatusExtra({ extra, short, tone }: { extra?: string; short?: string; tone?: string }) {
  if (!extra) return null;
  // (F5) A size container picks the whole or the short form (table.module.css .stxWide / .stxNarrow).
  if (short === undefined) {
    return (
      <span className={t.stx} data-tone={tone}>
        {extra}
      </span>
    );
  }
  return (
    <>
      <span className={cx(t.stx, t.stxWide)} data-tone={tone}>
        {extra}
      </span>
      {short ? (
        <span className={cx(t.stx, t.stxNarrow)} data-tone={tone}>
          {short}
        </span>
      ) : null}
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
  /** (Pending v9.1) The views' clock, for the row's sentence ("Recheck due"). */
  now?: number;
}

/** One request. Closed rows are greyed in place. A click opens it (beside the list on the desk). */
export const TableRow = memo(function TableRow({ row, times, selected, stage, timeZone, now = 0 }: TableRowProps) {
  const closed = isClosed(row.status);
  const look = stage ?? stageLook(row, now);
  const friend = friendCell(row);
  return (
    <button
      type="button"
      className={cx(t.grid, t.row, closed && t.closed)}
      data-request-id={row.id}
      data-closed={closed ? '' : undefined}
      data-selected={selected ? '' : undefined}
      aria-current={selected ? 'true' : undefined}
      onClick={(e) => openRowAt(row.id, e.target)}
    >
      <Vh>{withMessages(tableRowLabel(row, times, timeZone, now), row)}</Vh>
      <Cells
        lane={<MessageMark row={row} className={t.lane} />}
        number={logNumber(row.caseNumber)}
        name={friend.name}
        ageGender={friend.ageGender}
        glyph={<StageGlyph glyph={look.glyph} className={t.glyph} />}
        tone={look.tone}
        statusLabel={look.label}
        statusExtra={stage?.extra}
        statusExtraShort={stage?.extraShort}
        statusExtraTone={extraTone(stage)}
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
 * A row's sentence, then what its message lane shows: "…, logged by Lee Park, GCHX Base. 2 unread messages." /
 * "…. 4 messages." (a matched text ending in a stop keeps it) / unchanged without messages.
 */
function withMessages(label: string, row: RequestSummary): string {
  const said = messagesSentence(row);
  if (!said) return label;
  return /[.?!…]$/.test(label) ? `${label}${said}` : `${label}.${said}`;
}

/** The heat of a waiting row's extra: its wait's tone (gray under 10 minutes). */
function extraTone(stage: DisplayStage | undefined): string | undefined {
  return stage?.waitMinutes === undefined ? undefined : waitTone(stage.waitMinutes);
}

export interface SearchRowProps extends Omit<TableRowProps, 'row'> {
  hit: SearchHit;
  nameRanges: Ranges;
  caseRanges: Ranges;
  /** The matched text when the hit is not the name or the number ('' for none), and its ranges. */
  line: string;
  lineRanges: Ranges;
}

/** A search result: the row with the match highlighted, and the matched text under the name. */
export const SearchRow = memo(function SearchRow({ hit, times, selected, stage, timeZone, now = 0, nameRanges, caseRanges, line, lineRanges }: SearchRowProps) {
  const { row } = hit;
  const closed = isClosed(row.status);
  const look = stage ?? stageLook(row, now);
  const friend = friendCell(row);
  // A number hit: docked under 1320 px, # goes, so the LP number shows highlighted under the name (as on the phone's
  // SearchLogRow).
  const numHit = !line && caseRanges.length > 0;
  return (
    <button
      type="button"
      className={cx(t.grid, t.row, closed && t.closed, !!line && t.two, numHit && t.twoDocked)}
      data-request-id={row.id}
      data-closed={closed ? '' : undefined}
      data-selected={selected ? '' : undefined}
      aria-current={selected ? 'true' : undefined}
      onClick={(e) => openRowAt(row.id, e.target)}
    >
      <Vh>{withMessages(searchRowLabel(row, times, line, timeZone, now), row)}</Vh>
      <Cells
        lane={<MessageMark row={row} className={t.lane} />}
        number={<Highlight text={logNumber(row.caseNumber)} ranges={logNumberRanges(row.caseNumber, caseRanges)} />}
        name={<Highlight text={friend.name} ranges={row.name ? nameRanges : []} />}
        ageGender={friend.ageGender}
        line={line ? <Highlight text={line} ranges={lineRanges} /> : null}
        numLine={numHit ? <Highlight text={formatCaseNumber(row.caseNumber)} ranges={caseRanges} /> : null}
        glyph={<StageGlyph glyph={look.glyph} className={t.glyph} />}
        tone={look.tone}
        statusLabel={look.label}
        statusExtra={stage?.extra}
        statusExtraShort={stage?.extraShort}
        statusExtraTone={extraTone(stage)}
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
 * "Archived  6  ›": every closed request folded into one row under the open ones, exactly as F1's phone
 * log (the same test ids, name and remembered open state, prefs.closedExpanded). › while folded, ⌄ while open
 * (Pending v9.1, pending-v9.html .arch). (Message lane) The label lines up with #; while folded the lane carries
 * the folded rows' unread total.
 */
export function ArchivedFold({
  count,
  open,
  controls,
  onToggle,
  label = 'Archived',
  unread = 0,
}: {
  count: number;
  open: boolean;
  controls: string;
  onToggle: () => void;
  /** (Pending v9.1) "Closed" on My requests sorted by status. */
  label?: string;
  /** (Message lane) The unread messages on the folded rows: the lane's bubble while folded. */
  unread?: number;
}) {
  const sum = open ? 0 : unread;
  // Named by its content (no aria-label), as the phone's fold: the lane's "99+" could never match a spoken "120".
  return (
    <button
      type="button"
      className={t.fold}
      aria-expanded={open}
      // Only while the closed rows are on the page (folded, they are not rendered).
      aria-controls={open ? controls : undefined}
      onClick={onToggle}
      data-testid="closed-fold"
    >
      <span className={t.foldLane} data-lane="" aria-hidden>
        {sum > 0 ? <UnreadBubble count={sum} /> : null}
      </span>
      <span className={t.foldLabel} aria-hidden>
        {label}
      </span>
      <span className={t.cap} aria-hidden>
        {count}
      </span>
      <span className={t.sp} />
      <span className={t.chev} aria-hidden>
        {open ? <ChevronDown size={16} strokeWidth={2} /> : <ChevronRight size={16} strokeWidth={2} />}
      </span>
      <Vh>{archivedFoldLabel(count, label, sum)}</Vh>
    </button>
  );
}

/** The archived rows under the fold. */
export function ArchivedRows({ id, children, label = 'Archived' }: { id: string; children: ReactNode; label?: string }) {
  return (
    <div id={id} role="group" aria-label={`${label} requests`} data-testid="closed-rows">
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
          <span className={t.lane} />
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
