'use client';
// The desk's request table views (design/screens/desktop-log.html), from 768 px in the shell's main column:
// All requests, My requests and Search. app/app-shell.tsx loads this file with next/dynamic only on the
// desk, so phones never download it; under 768 px the phone list (components/list) renders as before.
//
// The shell supplies the title, count, search field, views and New request; each view here draws only its
// data, with the states the phone has: the offline / error banner, the filter chips from the dashboard
// (?status, ?post, ?open), the skeleton before any data, "Can't reach the log", and the empty states.
//
//   All          unsent requests on top, then open requests (newest first), then every closed one folded into
//                "Archived N ⌄" (F1's phone log: same fold, same remembered state). With a filter: one list,
//                closed rows greyed in place, no fold, no unsent rows (as on the phone).
//   My requests  unsent on top, then open, then a "Closed N" group (never folded: the reporter tells the
//                friend), each newest update first.
//   Search       results by the top bar's query (?q=), newest first, the match highlighted.
//
// (Pending v9.1) All and My requests sort by status from their column header (Status ↓; Created ↓ / Updated ↓
// goes back): group rows over Waiting for check (longest wait first) and Friend coming (arrived, en route,
// nobody yet), then the closed ones folded last (Archived on All, Closed on My requests), newest closed first.
// The choice is the phone toggle's, per view on this device (lib/client/view-prefs.ts).
import { MapPin, X } from 'lucide-react';
import { useDeferredValue, useId, useMemo, type ReactNode } from 'react';
import { AlertsBannerSlot as AlertsBanner } from '@/components/activity/slots';
import { ConnectionBanner } from '@/components/ui/Banner';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatusGlyph } from '@/components/ui/StatusGlyph';
import { useScrollMemory } from '@/components/list/hooks';
import { resultCount, searchDisplay } from '@/components/list/list-helpers';
import type { OutboxItem, RequestSummary } from '@/lib/api-types';
import { navigate } from '@/lib/client/nav';
import { splitOpenClosed } from '@/lib/client/selectors';
import { statusGroups, type StatusGroups } from '@/lib/client/status-order';
import { useMineClosedOpen, useSortOrder } from '@/lib/client/view-prefs';
import {
  useActions,
  useAllRows,
  useConnection,
  useEventTimezone,
  useIsLoading,
  useMine,
  useNow,
  useOutbox,
  usePrefs,
  useSearch,
  useStoreSelector,
  type StoreState,
} from '@/lib/client/store-contract';
import { parsePostFilterKey, postFilterLabel, statusMeta } from '@/lib/domain';
import { displayStage } from '@/lib/stages';
import { formatCreatedTime } from '@/lib/format';
import { ArchivedFold, ArchivedRows, DeskTable, GroupHeader, GroupRow, OutboxRow, SearchRow, TableRow, TableSkeleton } from './DeskTable';
import { rowTimes } from './table-model';
import t from './table.module.css';

const selectHydrated = (state: StoreState) => state.hydrated;

interface FrameProps {
  view: 'all' | 'mine' | 'search';
  chips?: ReactNode;
  /** Shown while there is no cached data yet (null: nothing). */
  skeleton?: ReactNode;
  children: ReactNode;
}

/** A table view's frame: the connection banner, the chips, then the table or its loading / error state. */
function Frame({ view, chips = null, skeleton = <TableSkeleton />, children }: FrameProps) {
  const actions = useActions();
  const { connection } = useConnection();
  const loading = useIsLoading();
  const hydrated = useStoreSelector(selectHydrated);
  const body = loading ? (
    hydrated && connection !== 'live' ? (
      <EmptyState icon="plug" title="Can't reach the log" action={{ label: 'Try again', onClick: actions.syncNow, icon: 'refresh' }} />
    ) : (
      skeleton
    )
  ) : (
    children
  );
  return (
    <div className={t.root} data-desk-view={view} data-testid="desk-table-view">
      {/* F4: until lock-screen alerts work on this computer (All and My requests; Pending draws its own). */}
      {view === 'search' ? null : <AlertsBanner />}
      {loading ? null : (
        <div className={t.banner}>
          <ConnectionBanner />
        </div>
      )}
      {chips}
      {body}
    </div>
  );
}

function Rows({ rows, now, tz, selected }: { rows: readonly RequestSummary[]; now: number; tz: string; selected: string | null }) {
  return (
    <>
      {rows.map((row) => (
        <TableRow
          key={row.id}
          row={row}
          times={rowTimes(row, now, tz)}
          selected={row.id === selected}
          stage={displayStage(row, { now, timeZone: tz })}
          timeZone={tz}
          now={now}
        />
      ))}
    </>
  );
}

/** (Pending v9.1) Waiting for check and Friend coming under their group rows (an empty group is left out). */
function OpenGroups({ groups, now, tz, selected }: { groups: StatusGroups; now: number; tz: string; selected: string | null }) {
  return (
    <>
      {groups.waiting.length > 0 ? (
        <>
          <GroupRow group="check" count={groups.waiting.length} />
          <Rows rows={groups.waiting} now={now} tz={tz} selected={selected} />
        </>
      ) : null}
      {groups.coming.length > 0 ? (
        <>
          <GroupRow group="coming" count={groups.coming.length} />
          <Rows rows={groups.coming} now={now} tz={tz} selected={selected} />
        </>
      ) : null}
    </>
  );
}

function Queued({ items, now, tz }: { items: readonly OutboxItem[]; now: number; tz: string }) {
  return (
    <>
      {items.map((item) => (
        <OutboxRow key={item.mutationId} item={item} created={formatCreatedTime(item.createdAt, now, tz)} />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------
// All requests
// ---------------------------------------------------------------------------------------------------

export interface DeskAllTableProps {
  /** Status filter (database value) from ?status=. */
  status: string | null;
  /** Post filter key (domain.postFilterKey) from ?post=. */
  post: string | null;
  /** ?open=1 with ?post=: open requests only (a dashboard "Open by post" bar). */
  open?: boolean;
  /** The request open in the pane (?r=), highlighted. */
  selected?: string | null;
}

/**
 * The filter chips, exactly as the phone's (components/list/ListViews.tsx FilterChips): the same names,
 * test ids and what clearing each one keeps. Each name starts with what the chip shows (WCAG 2.5.3).
 */
function FilterChips({ status, post, open, count }: { status: string | null; post: string | null; open: boolean; count: number }) {
  const statusLabel = status ? statusMeta(status).shortLabel : '';
  const place = post ? parsePostFilterKey(post) : null;
  const postLabel = place ? postFilterLabel(place.reportingLocation, place.otherLocation) : '';
  const openOnly = open && !!post;
  return (
    <div className={t.chips} data-testid="desk-filter-chips">
      {status ? (
        <button
          type="button"
          className={t.chip}
          aria-label={post ? `${statusLabel}. Clear this filter` : `${statusLabel} ${count} shown. Clear this filter`}
          onClick={() => navigate(post ? { post, ...(openOnly ? { open: true as const } : {}) } : {}, { replace: true })}
          data-testid="status-chip"
        >
          <StatusGlyph status={status} size={12} />
          <span className={t.chipLabel}>{statusLabel}</span>{' '}
          {post ? null : <span className={t.chipCount}>{count}</span>}
          <X size={14} strokeWidth={2} className={t.chipX} aria-hidden />
        </button>
      ) : null}
      {openOnly && post ? (
        <button
          type="button"
          className={t.chip}
          aria-label="Open requests only. Clear this filter"
          onClick={() => navigate({ ...(status ? { status } : {}), post }, { replace: true })}
          data-testid="open-chip"
        >
          <span className={t.chipLabel}>Open</span>
          <X size={14} strokeWidth={2} className={t.chipX} aria-hidden />
        </button>
      ) : null}
      {post ? (
        <button
          type="button"
          className={t.chip}
          aria-label={`${postLabel} ${count} shown. Clear this filter`}
          onClick={() => navigate(status ? { status } : {}, { replace: true })}
          data-testid="post-chip"
        >
          <MapPin size={13} strokeWidth={2} aria-hidden />
          <span className={t.chipLabel}>{postLabel}</span> <span className={t.chipCount}>{count}</span>
          <X size={14} strokeWidth={2} className={t.chipX} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

export function DeskAllTable({ status, post, open = false, selected = null }: DeskAllTableProps) {
  const openOnly = open && !!post;
  const rows = useAllRows({ status, post, open: openOnly });
  const outbox = useOutbox();
  const loading = useIsLoading();
  const tz = useEventTimezone();
  const now = useNow();
  const prefs = usePrefs();
  const actions = useActions();
  const archivedId = useId();
  const [order, setOrder] = useSortOrder('all');
  const byStatus = order === 'status';
  const filtered = !!(status || post);
  const queued = filtered ? [] : outbox;
  const sections = useMemo(() => (filtered || byStatus ? null : splitOpenClosed(rows)), [filtered, byStatus, rows]);
  const groups = useMemo(() => (byStatus ? statusGroups(rows) : null), [byStatus, rows]);
  // The phone's Archived state (prefs.closedExpanded, for this browser session).
  const expanded = prefs.closedExpanded;
  useScrollMemory(`desk-all|${status ?? ''}|${post ?? ''}|${openOnly ? 'open' : ''}|${order}`, !loading);
  const archived = (closedRows: readonly RequestSummary[]) =>
    closedRows.length > 0 ? (
      <>
        <ArchivedFold count={closedRows.length} open={expanded} controls={archivedId} onToggle={() => actions.setPref('closedExpanded', !expanded)} />
        {expanded ? (
          <ArchivedRows id={archivedId}>
            <Rows rows={closedRows} now={now} tz={tz} selected={selected} />
          </ArchivedRows>
        ) : null}
      </>
    ) : null;

  return (
    <Frame view="all" chips={filtered ? <FilterChips status={status} post={post} open={openOnly} count={rows.length} /> : null}>
      {rows.length + queued.length === 0 ? (
        <EmptyState icon="inbox" title={filtered ? 'No matching requests' : 'No requests yet'} />
      ) : (
        <DeskTable sort={{ order, defaultColumn: 'created', onChange: setOrder }}>
          <Queued items={queued} now={now} tz={tz} />
          {groups ? (
            <>
              <OpenGroups groups={groups} now={now} tz={tz} selected={selected} />
              {filtered ? (
                groups.closed.length > 0 ? (
                  <>
                    <GroupHeader label="Archived" count={groups.closed.length} />
                    <Rows rows={groups.closed} now={now} tz={tz} selected={selected} />
                  </>
                ) : null
              ) : (
                archived(groups.closed)
              )}
            </>
          ) : sections ? (
            <>
              <Rows rows={sections.open} now={now} tz={tz} selected={selected} />
              {archived(sections.closed)}
            </>
          ) : (
            <Rows rows={rows} now={now} tz={tz} selected={selected} />
          )}
        </DeskTable>
      )}
    </Frame>
  );
}

// ---------------------------------------------------------------------------------------------------
// My requests
// ---------------------------------------------------------------------------------------------------

export function DeskMineTable({ selected = null }: { selected?: string | null }) {
  const rows = useMine();
  const outbox = useOutbox();
  const loading = useIsLoading();
  const tz = useEventTimezone();
  const now = useNow();
  const [order, setOrder] = useSortOrder('mine');
  const byStatus = order === 'status';
  const { open, closed } = useMemo(() => splitOpenClosed(rows), [rows]);
  const groups = useMemo(() => (byStatus ? statusGroups(rows) : null), [byStatus, rows]);
  const [closedOpen, setClosedOpen] = useMineClosedOpen();
  const closedId = useId();
  useScrollMemory(`desk-mine|${order}`, !loading);

  return (
    <Frame view="mine">
      {rows.length + outbox.length === 0 ? (
        <EmptyState icon="inbox" title="No requests yet" />
      ) : groups ? (
        <DeskTable sort={{ order, defaultColumn: 'updated', onChange: setOrder }}>
          <Queued items={outbox} now={now} tz={tz} />
          <OpenGroups groups={groups} now={now} tz={tz} selected={selected} />
          {groups.closed.length > 0 ? (
            <section data-testid="mine-closed">
              <ArchivedFold label="Closed" count={groups.closed.length} open={closedOpen} controls={closedId} onToggle={() => setClosedOpen(!closedOpen)} />
              {closedOpen ? (
                <ArchivedRows id={closedId} label="Closed">
                  <Rows rows={groups.closed} now={now} tz={tz} selected={selected} />
                </ArchivedRows>
              ) : null}
            </section>
          ) : null}
        </DeskTable>
      ) : (
        <DeskTable sort={{ order, defaultColumn: 'updated', onChange: setOrder }}>
          <Queued items={outbox} now={now} tz={tz} />
          <Rows rows={open} now={now} tz={tz} selected={selected} />
          {closed.length > 0 ? (
            <section aria-label={`Closed, ${closed.length}`} data-testid="mine-closed">
              <GroupHeader label="Closed" count={closed.length} />
              <Rows rows={closed} now={now} tz={tz} selected={selected} />
            </section>
          ) : null}
        </DeskTable>
      )}
    </Frame>
  );
}

// ---------------------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------------------

export function DeskSearchTable({ q, selected = null }: { q: string; selected?: string | null }) {
  const query = useDeferredValue(q);
  const hits = useSearch(query);
  const loading = useIsLoading();
  const tz = useEventTimezone();
  const now = useNow();
  const hasQuery = query.trim() !== '';
  useScrollMemory('desk-search', !loading);

  return (
    <Frame view="search" skeleton={hasQuery ? <TableSkeleton /> : null}>
      {/* The count, for screen readers: the rows are the visible answer. */}
      <div className={t.vh} role="status" aria-live="polite">
        {hasQuery ? resultCount(hits.length) : ''}
      </div>
      {hits.length > 0 ? (
        <DeskTable>
          {hits.map((hit) => {
            const d = searchDisplay(hit);
            // Name and number hits are highlighted in place; any other field shows the matched text.
            const line = hit.field === 'name' || hit.field === 'caseNumber' ? '' : d.line;
            return (
              <SearchRow
                key={hit.row.id}
                hit={hit}
                times={rowTimes(hit.row, now, tz)}
                selected={hit.row.id === selected}
                stage={displayStage(hit.row, { now, timeZone: tz })}
                timeZone={tz}
                now={now}
                nameRanges={d.nameRanges}
                caseRanges={d.caseRanges}
                line={line}
                lineRanges={line ? d.lineRanges : []}
              />
            );
          })}
        </DeskTable>
      ) : hasQuery ? (
        <EmptyState icon="search" title="No matches" />
      ) : null}
    </Frame>
  );
}
