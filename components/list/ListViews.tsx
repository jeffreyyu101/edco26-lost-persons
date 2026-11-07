'use client';
// List views: All, Pending, My requests and Search (spec §8 List views, v2.1 A3/A22; log option B and the
// header declutter of 2026-11-06, design/screens/polish-v7.html + v7-log.png; Pending v9.1 of 2026-11-06 evening,
// design/screens/pending-v9.html). The page loads each export with next/dynamic. Every action goes through the
// store contract; every view change through lib/client/nav.
//
// All requests opens with the brand row (Jeffrey, 2026-11-06 10:31: logos, event details and "Is my friend in
// medical?"; made one compact row with an X by Brian, 2026-11-06 afternoon), which scrolls away. Its X hides
// it on this device, and the avatar menu's "Show header" brings it back. Pending and My requests start at
// their large title (Pending v8, Brian 2026-11-06 afternoon). Each view owns its sticky bar (the large title
// that is the view menu, search, and the avatar with its offline / reconnecting badge), the line under the
// title ("Updated just now" and Refresh now; on All and My requests the "⇅" sort toggle at its right end,
// Pending v9.1), the Reconnecting / Offline banner (the line, the banner and the badge from one
// useLiveStatus()), the filter chips, and the New request button. Skeletons show only while there is no cached
// data yet. From 768 px the desk shell draws the brand row, the title and the line (in its top bar; the desk
// table's column header sorts there); the list keeps the banner and the chips.
//
// All requests (option B): queued requests on top, then open requests (newest first), then every closed
// request folded into one "Archived N" row (Brian, 2026-11-06) that opens in place (remembered for the
// session). With a search or a status / post filter, the matching rows are one list, closed ones greyed in
// place, with no fold. Only All archives: Pending never lists closed requests, and My requests keeps showing
// the reporter theirs (Not in medical included), so they can tell the friend.
import { Button, Text } from '@radix-ui/themes';
import { MapPin, Plus, Search as SearchIcon, X } from 'lucide-react';
import { useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { AccountMenu } from '@/components/account/AccountMenu';
import { ConnectionBanner } from '@/components/ui/Banner';
import { EmptyState } from '@/components/ui/EmptyState';
import { LiveIndicator } from '@/components/ui/LiveIndicator';
import { StatusGlyph } from '@/components/ui/StatusGlyph';
import { PendingBoard } from '@/components/desk/PendingBoard';
import { LocationEditor, anchorFor, type LocationTarget, type Measurable } from '@/components/profile/LocationEditor';
import type { RequestSummary } from '@/lib/api-types';
import { goBack, navigate } from '@/lib/client/nav';
import { splitOpenClosed } from '@/lib/client/selectors';
import { byFriendComing, nextRecheckAt, statusGroups } from '@/lib/client/status-order';
import { useMineClosedOpen, useSortOrder } from '@/lib/client/view-prefs';
import {
  useActions,
  useAllRows,
  useAppStore,
  useConnection,
  useCounts,
  useEventTimezone,
  useIsLoading,
  useMine,
  useNow,
  useOutbox,
  usePending,
  usePrefs,
  useSearch,
  useSession,
  useSnackbar,
  useStoreSelector,
  type StoreState,
} from '@/lib/client/store-contract';
import { refreshSync } from '@/lib/client/refresh-now';
import { useLiveStatus } from '@/lib/client/use-live-status';
import { STATUS, notFoundHolds, parsePostFilterKey, postFilterLabel, statusMeta, type GlyphKind } from '@/lib/domain';
import { formatCreatedTime, formatUpdatedAgo, updatedPhrase } from '@/lib/format';
import { useInDesk } from '@/components/desk/desk-context';
import { AppHeader } from './AppHeader';
import { BrandCard } from './BrandCard';
import { MineCard, OutboxCard } from './cards';
import { displayName } from './list-helpers';
import { PendingQueues, useLeaving } from './PendingQueues';
import { SortToggle } from './SortToggle';
import { primeKeyboard, useScrollMemory, useStatusTap, useStickyHeight } from './hooks';
import { mineFreshTone, resultCount, searchDisplay, updatedSince } from './list-helpers';
import { AllSkeleton, MineSkeleton, PendingSkeleton } from './ListSkeletons';
import { ArchivedFold, ArchivedRows, ColumnHeader, GroupDivider, LogGrid, LogRow, OutboxLogRow, SearchLogRow } from './rows';
import type { ListViewName } from './ViewSwitcher';
import s from './list.module.css';

const selectHydrated = (state: StoreState) => state.hydrated;

/** "New request": the 50 px capsule floating over the list (polish-v7.html .fab). */
function NewRequestButton() {
  return (
    <button type="button" className={s.fab} onClick={() => navigate({ new: true })}>
      <Plus size={18} strokeWidth={2.25} aria-hidden />
      New request
    </button>
  );
}

interface ChromeProps {
  view: ListViewName;
  /**
   * (Pending v9.1) The right end of the line under the title: the "⇅" sort toggle on All and My requests, with
   * F1.2's "● Updated just now ⟳" at its left. Phone only (the desk table's column header sorts).
   */
  sort?: ReactNode;
  /** Filter chips under the title (All only). */
  chips?: ReactNode;
  /** Selecting the current view still navigates (All with a filter clears the filter). */
  filtered?: boolean;
  skeleton: ReactNode;
  children: ReactNode;
}

function Chrome({ view, sort = null, chips, filtered = false, skeleton, children }: ChromeProps) {
  const store = useAppStore();
  const actions = useActions();
  const { connection } = useConnection();
  // The one live status of this view: the line, the banner, the avatar badge and the live region all show it.
  const live = useLiveStatus();
  const refresh = useCallback(() => refreshSync(store), [store]);
  const counts = useCounts();
  const loading = useIsLoading();
  const hydrated = useStoreSelector(selectHydrated);
  const snackbar = useSnackbar();
  const prefs = usePrefs();
  const { rootRef, stickyRef } = useStickyHeight();
  // From 768 px the desk shell draws the brand row (above its top bar) and this view's chrome, the line under
  // the title included (in its top bar): the list's own brand row and line are phone only.
  const inDesk = useInDesk();
  // The brand row is on All only (Pending v8: Pending and My requests get just the large title), unless its X
  // hid it on this device.
  const brand = !inDesk && view === 'all' && !prefs.brandHidden;

  const select = (next: ListViewName) => {
    if (next === view && !filtered) return;
    // Switching views replaces the entry (like tabs): Back never loops between list views.
    navigate(next === 'all' ? {} : { view: next }, { replace: true });
  };

  // No cached data: skeletons while loading, or "Can't reach the log" once the cache is known to be empty
  // and the server can't be reached.
  const body = loading ? (
    hydrated && connection !== 'live' ? (
      <EmptyState
        icon="plug"
        title="Can't reach the log"
        action={{ label: 'Try again', onClick: actions.syncNow, icon: 'refresh' }}
      />
    ) : (
      skeleton
    )
  ) : (
    children
  );

  const hideBrand = () => {
    // The X is about to go: keyboard focus moves on to the view title instead of falling back to the page.
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && rootRef.current?.contains(focused) && !stickyRef.current?.contains(focused)) {
      stickyRef.current?.querySelector<HTMLElement>('h1 button')?.focus();
    }
    actions.setPref('brandHidden', true);
  };
  // "Show header" in the avatar menu (All only, while hidden): back at the top of the page, where it is.
  const showBrand = () => {
    actions.setPref('brandHidden', false);
    window.scrollTo(0, 0);
  };

  return (
    <div className={s.root} data-view={view} ref={rootRef}>
      {brand ? <BrandCard onHide={hideBrand} /> : null}
      <div className={s.sticky} ref={stickyRef}>
        <AppHeader
          view={view}
          counts={loading ? null : counts}
          onSelect={select}
          state={live.state}
          onOpenSearch={() => {
            primeKeyboard();
            navigate({ q: '' });
          }}
          account={<AccountMenu onShowHeader={view === 'all' && prefs.brandHidden ? showBrand : undefined} />}
        />
        {inDesk ? null : sort ? (
          // (Pending v9.1) The line with the "⇅" toggle at its right end (its own row under 360 px).
          <div className={s.liveRow} data-testid="live-row">
            <div className={s.liveIn}>
              <LiveIndicator className={s.liveLead} line={live} onRefresh={refresh} />
              {sort}
            </div>
          </div>
        ) : (
          <LiveIndicator className={s.live} line={live} onRefresh={refresh} />
        )}
        {loading ? null : <ConnectionBanner status={live} />}
        {chips}
      </div>
      <main className={s.body}>{body}</main>
      {snackbar ? null : <NewRequestButton />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------
// All
// ---------------------------------------------------------------------------------------------------

export interface AllViewProps {
  /** Status filter (database value) from ?status=, shown as a chip. */
  status: string | null;
  /** Post filter key (domain.postFilterKey) from ?post=, shown as a chip. */
  post: string | null;
  /** ?open=1 with ?post= (a dashboard "Open by post" bar): open requests only, shown as a chip. */
  open?: boolean;
}

// Chip names start with what the chip shows, "Not in medical 3" (WCAG 2.5.3); {' '} keeps the label and
// the count apart as words without adding space to the layout.
function FilterChips({ status, post, open, count }: { status: string | null; post: string | null; open: boolean; count: number }) {
  const statusLabel = status ? statusMeta(status).shortLabel : '';
  const postPlace = post ? parsePostFilterKey(post) : null;
  const postLabel = postPlace ? postFilterLabel(postPlace.reportingLocation, postPlace.otherLocation) : '';
  const openOnly = open && !!post;
  return (
    <div className={s.chips}>
      {status ? (
        <button
          type="button"
          className={s.chip}
          aria-label={post ? `${statusLabel}. Clear this filter` : `${statusLabel} ${count} shown. Clear this filter`}
          onClick={() => navigate(post ? { post, ...(openOnly ? { open: true as const } : {}) } : {}, { replace: true })}
          data-testid="status-chip"
        >
          <StatusGlyph status={status} size={12} />
          <span className={s.chipLabel}>{statusLabel}</span>{' '}
          {post ? null : <span className={s.chipCount}>{count}</span>}
          <span className={s.chipX}>
            <X size={14} strokeWidth={2} aria-hidden />
          </span>
        </button>
      ) : null}
      {openOnly && post ? (
        <button
          type="button"
          className={s.chip}
          aria-label="Open requests only. Clear this filter"
          onClick={() => navigate({ ...(status ? { status } : {}), post }, { replace: true })}
          data-testid="open-chip"
        >
          <span className={s.chipLabel}>Open</span>
          <span className={s.chipX}>
            <X size={14} strokeWidth={2} aria-hidden />
          </span>
        </button>
      ) : null}
      {post ? (
        <button
          type="button"
          className={s.chip}
          aria-label={`${postLabel} ${count} shown. Clear this filter`}
          onClick={() => navigate(status ? { status } : {}, { replace: true })}
          data-testid="post-chip"
        >
          <MapPin size={13} strokeWidth={2} aria-hidden />
          <span className={s.chipLabel}>{postLabel}</span>{' '}
          <span className={s.chipCount}>{count}</span>
          <span className={s.chipX}>
            <X size={14} strokeWidth={2} aria-hidden />
          </span>
        </button>
      ) : null}
    </div>
  );
}

/** The created / updated text, and Updated as a screen reader says it, for one log row. */
function rowTimes(row: RequestSummary, now: number, tz: string) {
  const since = updatedSince(row);
  return {
    created: formatCreatedTime(row.createdAt, now, tz),
    updated: formatUpdatedAgo(row.createdAt, since, now),
    updatedSaid: updatedPhrase(row.createdAt, since, now),
    timeZone: tz,
  };
}

function Rows({ rows, now, tz }: { rows: readonly RequestSummary[]; now: number; tz: string }) {
  return (
    <>
      {rows.map((row) => (
        <LogRow key={row.id} row={row} now={now} {...rowTimes(row, now, tz)} />
      ))}
    </>
  );
}

export function AllView({ status, post, open = false }: AllViewProps) {
  const openOnly = open && !!post;
  const rows = useAllRows({ status, post, open: openOnly });
  const outbox = useOutbox();
  const loading = useIsLoading();
  const tz = useEventTimezone();
  const now = useNow();
  const prefs = usePrefs();
  const actions = useActions();
  const archivedId = useId();
  const [order] = useSortOrder('all');
  const byStatus = order === 'status';
  const filtered = !!(status || post);
  // Requests saved on this phone sit on top of the unfiltered log (they have no status or LP number yet).
  const queued = filtered ? [] : outbox;
  // Unfiltered: open first, closed folded under Archived (rows are already newest first). Filtered: one list,
  // closed rows greyed in place, no fold. (Pending v9.1) Sorted by status: Waiting for check, Friend coming and
  // the closed ones as groups under thin dividers, the closed ones still folded under Archived when unfiltered.
  const sections = useMemo(() => (filtered || byStatus ? null : splitOpenClosed(rows)), [filtered, byStatus, rows]);
  const groups = useMemo(() => (byStatus ? statusGroups(rows) : null), [byStatus, rows]);
  // The Archived fold's open state lasts for this browser session (prefs.closedExpanded, sessionStorage).
  const expanded = prefs.closedExpanded;
  useScrollMemory(`all|${status ?? ''}|${post ?? ''}|${openOnly ? 'open' : ''}|${order}`, !loading);

  const archived = (closedRows: readonly RequestSummary[]) =>
    closedRows.length > 0 ? (
      <>
        <ArchivedFold count={closedRows.length} open={expanded} controls={archivedId} onToggle={() => actions.setPref('closedExpanded', !expanded)} />
        {expanded ? (
          <ArchivedRows id={archivedId}>
            <Rows rows={closedRows} now={now} tz={tz} />
          </ArchivedRows>
        ) : null}
      </>
    ) : null;

  return (
    <Chrome
      view="all"
      filtered={filtered}
      sort={<SortToggle view="all" />}
      chips={filtered ? <FilterChips status={status} post={post} open={openOnly} count={rows.length} /> : null}
      skeleton={<AllSkeleton />}
    >
      {rows.length + queued.length === 0 ? (
        <EmptyState icon="inbox" title={filtered ? 'No matching requests' : 'No requests yet'} />
      ) : (
        <LogGrid>
          <ColumnHeader />
          {queued.map((item) => (
            <OutboxLogRow key={item.mutationId} item={item} created={formatCreatedTime(item.createdAt, now, tz)} />
          ))}
          {groups ? (
            <>
              {groups.waiting.length > 0 ? (
                <>
                  <GroupDivider group="check" count={groups.waiting.length} />
                  <Rows rows={groups.waiting} now={now} tz={tz} />
                </>
              ) : null}
              {groups.coming.length > 0 ? (
                <>
                  <GroupDivider group="coming" count={groups.coming.length} />
                  <Rows rows={groups.coming} now={now} tz={tz} />
                </>
              ) : null}
              {filtered ? (
                groups.closed.length > 0 ? (
                  <>
                    <GroupDivider group="closed" count={groups.closed.length} />
                    <Rows rows={groups.closed} now={now} tz={tz} />
                  </>
                ) : null
              ) : (
                archived(groups.closed)
              )}
            </>
          ) : sections ? (
            <>
              <Rows rows={sections.open} now={now} tz={tz} />
              {archived(sections.closed)}
            </>
          ) : (
            <Rows rows={rows} now={now} tz={tz} />
          )}
        </LogGrid>
      )}
    </Chrome>
  );
}

function SectionHeader({ kind, label, count }: { kind: GlyphKind; label: string; count: number }) {
  return (
    <h2 className={s.sh}>
      <StatusGlyph kind={kind} />
      <Text size="2" weight="medium">
        {label}
      </Text>
      <Text size="2" color="gray" weight="regular">
        {count}
      </Text>
    </h2>
  );
}

// ---------------------------------------------------------------------------------------------------
// Pending v9.1 (design/screens/pending-v9.html, Brian 2026-11-06 19:35–20:40): one page, Waiting for check
// (longest wait first: Needs info and "Not found yet" holds in place) then Friend coming (Friend arrived →
// Friend en route → nobody coming yet), each under a header that folds it (components/list/PendingQueues.tsx).
// The phone stacks them in one scroll; the desk shows them side by side (components/desk/PendingBoard.tsx).
// In medical saves at once (overlay + Undo, as before) and then asks where medical has them: the phone's
// bottom sheet, the desk's popover at the card. A Friend coming card's location chip edits it. The left answer
// is "Not found yet" (the hold) until the request is held, then "Not found" (closes it; the card animates out).
// ---------------------------------------------------------------------------------------------------

/** The location being asked for or edited, and where the desk popover points. */
interface Locating {
  target: LocationTarget;
  anchor: RefObject<Measurable | null>;
  /** After an answer: the Waiting for check card that takes the answered one's place (the next, else the one before). */
  after: string | null;
}

/** The open button of the card for `id` in `testId`'s queue on the desk board, if it is on screen. */
function deskCardButton(testId: 'check-card' | 'friend-coming-card', id?: string): HTMLElement | null {
  const card = id ? `[data-testid="${testId}"][data-pending-card="${id}"]` : `[data-testid="${testId}"]`;
  const buttons = Array.from(document.querySelectorAll<HTMLElement>(`[data-desk-main] ${card} [data-request-id]`));
  return buttons.find((el) => el.getClientRects().length > 0) ?? null;
}

export interface PendingViewProps {
  /** Desk: the request open in the pane beside the board (its card is scrolled into view). */
  selected?: string | null;
}

/**
 * useNow(), plus a re-render the moment the next "Not found yet" hold among `rows` becomes due, so its chip
 * turns to "Recheck due" on time (not up to 15 s late). Nothing moves: only the chip changes.
 */
function useRecheckNow(rows: readonly RequestSummary[]): number {
  const tick = useNow();
  const [bumped, setBumped] = useState(0);
  const now = Math.max(tick, bumped);
  const next = nextRecheckAt(rows, now);
  useEffect(() => {
    if (next === null) return;
    const timer = setTimeout(() => setBumped(Date.now()), Math.max(0, next - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [next]);
  return now;
}

export function PendingView({ selected = null }: PendingViewProps = {}) {
  const { friendComing, waiting } = usePending();
  const loading = useIsLoading();
  const now = useRecheckNow(waiting);
  // Rule 2: pendingGroups already gives Waiting for check longest wait first. Rule 4 for Friend coming.
  const coming = useMemo(() => [...friendComing].sort(byFriendComing), [friendComing]);
  const leaving = useLeaving(waiting);
  const { mark, unmark } = leaving;
  const inDesk = useInDesk();
  const { offline, tap } = useStatusTap();
  const actions = useActions();
  const [locating, setLocating] = useState<Locating | null>(null);
  useScrollMemory('pending', !loading);
  // The Waiting for check queue as last rendered, for the handlers (memoised cards keep their callbacks).
  const queue = useRef(waiting);
  useEffect(() => {
    queue.current = waiting;
  }, [waiting]);

  // Desk: a request opened beside the board keeps its card on screen (each column scrolls on its own, and a
  // docked request can stack the board into one column), so its highlight and the focus stay in view and J / K
  // carry on from it. Only when another request opens.
  const [followed, setFollowed] = useState<string | null>(null);
  const inPending = !!selected && (waiting.some((r) => r.id === selected) || friendComing.some((r) => r.id === selected));
  if (inDesk && selected !== followed && (selected === null || inPending)) setFollowed(selected);
  useEffect(() => {
    if (!inDesk || !followed) return;
    const el = deskCardButton('check-card', followed) ?? deskCardButton('friend-coming-card', followed);
    el?.scrollIntoView({ block: 'nearest' });
  }, [inDesk, followed]);

  const openLocation = useCallback((row: RequestSummary, mode: LocationTarget['mode'], card: HTMLElement | null) => {
    const waitingNow = queue.current;
    const at = mode === 'answer' ? waitingNow.findIndex((r) => r.id === row.id) : -1;
    setLocating({
      target: { id: row.id, name: displayName(row.name), mode, initial: (row.medicalLocation ?? '').trim() },
      // The desk popover points at what was tapped: the Waiting for check card (where it stays once the card
      // has moved on to Friend coming), or the location chip.
      anchor: anchorFor(
        mode === 'answer' ? `[data-desk-main] [data-testid="check-card"][data-pending-card="${row.id}"]` : `[data-desk-main] [data-location-anchor="${row.id}"]`,
        card?.getBoundingClientRect() ?? null,
      ),
      after: at < 0 ? null : (waitingNow[at + 1] ?? waitingNow[at - 1])?.id ?? null,
    });
  }, []);
  const closeLocation = useCallback(() => setLocating(null), []);

  // The first Not found holds the request; a Not found on a held one closes it, and its card animates out.
  const onNotFound = useCallback(
    (row: RequestSummary) => {
      const closes = !notFoundHolds(row);
      if (closes && !offline) mark(row.id);
      const result = tap(row.id, STATUS.notInMedical, 'answer');
      if (closes) void Promise.resolve(result).then(() => unmark(row.id));
    },
    [tap, offline, mark, unmark],
  );
  const onReunited = useCallback((row: RequestSummary) => void tap(row.id, STATUS.reunited, 'reunite'), [tap]);
  const onInMedical = useCallback(
    (row: RequestSummary, card: HTMLElement | null) => {
      const result = tap(row.id, STATUS.inMedical, 'answer');
      if (!result) return;
      // iOS opens the keyboard only for a focus made during the tap: the sheet's field takes it over.
      if (!inDesk) primeKeyboard();
      openLocation(row, 'answer', card);
      // The answer didn't stick (someone else answered first, no signal): nothing to locate.
      void result.then((r) => {
        if (!r.ok) setLocating((cur) => (cur?.target.id === row.id && cur.target.mode === 'answer' ? null : cur));
      });
    },
    [tap, inDesk, openLocation],
  );
  const onLocate = useCallback(
    (row: RequestSummary, card: HTMLElement | null) => {
      if (offline) {
        actions.showToast({ tone: 'amber', icon: 'cloud-off', title: 'Needs a connection', durationMs: 3_000 });
        return;
      }
      if (!inDesk) primeKeyboard();
      openLocation(row, 'edit', card);
    },
    [actions, offline, inDesk, openLocation],
  );
  // The desk popover hands the focus back to the chip that opened it. After an answer the tapped card has
  // left Waiting for check: the focus goes to the card that took its place (the next one, or the one before
  // when it was the last), so Tab and J / K carry on through the queue from there; with Waiting for check
  // empty, to the answered card in Friend coming.
  const returnFocus = useCallback(() => {
    if (!locating) return null;
    const { target, after } = locating;
    if (target.mode === 'edit') {
      const chips = Array.from(document.querySelectorAll<HTMLElement>(`[data-desk-main] [data-location-anchor="${target.id}"]`));
      return chips.find((el) => el.getClientRects().length > 0) ?? null;
    }
    return (
      (after ? deskCardButton('check-card', after) : null) ?? deskCardButton('check-card') ?? deskCardButton('friend-coming-card', target.id)
    );
  }, [locating]);

  const editor = (
    <LocationEditor
      target={locating?.target ?? null}
      desk={inDesk}
      anchor={locating?.anchor}
      returnFocus={returnFocus}
      onClose={closeLocation}
    />
  );
  const queues = {
    waiting,
    coming,
    now,
    offline,
    leaving,
    onNotFound,
    onInMedical,
    onReunited,
    onLocate,
  };

  if (inDesk) {
    return (
      <Chrome view="pending" skeleton={<PendingSkeleton />}>
        <PendingBoard {...queues} />
        {editor}
      </Chrome>
    );
  }

  return (
    <Chrome view="pending" skeleton={<PendingSkeleton />}>
      <div className={s.queues} data-testid="request-list">
        <PendingQueues {...queues} />
      </div>
      {editor}
    </Chrome>
  );
}

// ---------------------------------------------------------------------------------------------------
// My requests: queued requests on top, then open requests, then the closed ones (Not in medical included),
// each newest update first, with the progress stepper. (Pending v9.1) "⇅ Updated" ↔ "⇅ Status": sorted by status,
// Waiting for check (longest wait first), then Friend coming, under thin dividers, then "Closed N" folded.
// ---------------------------------------------------------------------------------------------------

export function MineView() {
  const rows = useMine();
  const outbox = useOutbox();
  const session = useSession();
  const loading = useIsLoading();
  const now = useNow();
  const tz = useEventTimezone();
  const [order] = useSortOrder('mine');
  const byStatus = order === 'status';
  const { open, closed } = useMemo(() => splitOpenClosed(rows), [rows]);
  const groups = useMemo(() => (byStatus ? statusGroups(rows) : null), [byStatus, rows]);
  const [closedOpen, setClosedOpen] = useMineClosedOpen();
  const closedId = useId();
  useScrollMemory(`mine|${order}`, !loading);

  const card = (row: RequestSummary) => <MineCard key={row.id} row={row} now={now} timeZone={tz} freshTone={mineFreshTone(row, now, session.staff)} />;

  return (
    <Chrome view="mine" sort={<SortToggle view="mine" />} skeleton={<MineSkeleton />}>
      {rows.length + outbox.length === 0 ? (
        <EmptyState icon="inbox" title="No requests yet" />
      ) : groups ? (
        <div className={s.groups} data-testid="request-list" data-order="status">
          {outbox.length > 0 ? (
            <div className={s.scroll}>
              {outbox.map((item) => (
                <OutboxCard key={item.mutationId} item={item} now={now} />
              ))}
            </div>
          ) : null}
          {groups.waiting.length > 0 ? (
            <section aria-label={`Waiting for check, ${groups.waiting.length}`} data-testid="mine-group-check">
              <GroupDivider group="check" count={groups.waiting.length} cards />
              <div className={s.scroll}>{groups.waiting.map(card)}</div>
            </section>
          ) : null}
          {groups.coming.length > 0 ? (
            <section aria-label={`Friend coming, ${groups.coming.length}`} data-testid="mine-group-coming">
              <GroupDivider group="coming" count={groups.coming.length} cards />
              <div className={s.scroll}>{groups.coming.map(card)}</div>
            </section>
          ) : null}
          {groups.closed.length > 0 ? (
            <section data-testid="mine-closed">
              <ArchivedFold label="Closed" className={s.foldCards} count={groups.closed.length} open={closedOpen} controls={closedId} onToggle={() => setClosedOpen(!closedOpen)} />
              {closedOpen ? (
                <div id={closedId} className={s.scroll} role="group" aria-label="Closed requests" data-testid="closed-rows">
                  {groups.closed.map(card)}
                </div>
              ) : null}
            </section>
          ) : null}
        </div>
      ) : (
        <div className={s.scroll} data-testid="request-list">
          {outbox.map((item) => (
            <OutboxCard key={item.mutationId} item={item} now={now} />
          ))}
          {open.map(card)}
          {closed.length > 0 ? (
            <section className={s.scroll} style={{ padding: 0 }} aria-label={`Closed, ${closed.length}`} data-testid="mine-closed">
              <SectionHeader kind="closed" label="Closed" count={closed.length} />
              {closed.map(card)}
            </section>
          ) : null}
        </div>
      )}
    </Chrome>
  );
}

// ---------------------------------------------------------------------------------------------------
// Search: the field takes over the header (states.html Search); results in the log grid
// ---------------------------------------------------------------------------------------------------

export interface SearchViewProps {
  /** The search text from ?q= (may be empty when search was just opened). */
  q: string;
}

/** The ?q= value is capped at 200 characters by nav.parseView; longer text would leave search. */
const MAX_QUERY = 200;

export function SearchView({ q }: SearchViewProps) {
  const [text, setText] = useState(q);
  const query = useDeferredValue(text);
  const hits = useSearch(query);
  const loading = useIsLoading();
  const tz = useEventTimezone();
  const now = useNow();
  const inputRef = useRef<HTMLInputElement>(null);
  const { rootRef, stickyRef } = useStickyHeight();
  const hasQuery = query.trim() !== '';
  // Freshly opened (empty) search takes focus; coming back to results (Back from a profile) does not
  // pop the keyboard over them.
  const [focusOnMount] = useState(q === '');
  useScrollMemory('search', !loading);

  useEffect(() => {
    // Takes focus from primeKeyboard()'s proxy input, so iOS keeps the keyboard up.
    if (focusOnMount) inputRef.current?.focus({ preventScroll: true });
  }, [focusOnMount]);

  const change = (value: string) => {
    setText(value);
    navigate({ q: value }, { replace: true });
  };
  const cancel = () => goBack({});

  return (
    <div className={s.root} data-view="search" ref={rootRef}>
      <div className={s.sticky} ref={stickyRef}>
        <form
          role="search"
          className={s.search}
          onSubmit={(e) => {
            e.preventDefault();
            inputRef.current?.blur();
          }}
        >
          <div className={s.sfield}>
            <SearchIcon size={16} strokeWidth={1.75} aria-hidden />
            <input
              ref={inputRef}
              type="search"
              enterKeyHint="search"
              className={s.sinput}
              value={text}
              onChange={(e) => change(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') cancel();
              }}
              placeholder="Name, clothing, LP number"
              aria-label="Search requests"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={MAX_QUERY}
            />
            {text ? (
              <button
                type="button"
                className={s.sclear}
                aria-label="Clear search"
                onClick={() => {
                  change('');
                  inputRef.current?.focus();
                }}
              >
                <X size={15} strokeWidth={1.75} aria-hidden />
              </button>
            ) : null}
          </div>
          <Button type="button" variant="ghost" color="gray" className="lp-hit" onClick={cancel}>
            Cancel
          </Button>
        </form>
        {loading ? null : <ConnectionBanner />}
        <div className={s.cnt} aria-live="polite">
          {hasQuery && !loading ? (
            <Text size="1" color="gray">
              {resultCount(hits.length)}
            </Text>
          ) : null}
        </div>
      </div>
      <main className={s.body}>
        {loading && hasQuery ? (
          <AllSkeleton />
        ) : hits.length > 0 ? (
          <LogGrid>
            <ColumnHeader />
            {hits.map((hit) => {
              const { row } = hit;
              const d = searchDisplay(hit);
              // Name and LP number hits are highlighted in place; any other field shows the matched text.
              const line = hit.field === 'name' || hit.field === 'caseNumber' ? '' : d.line;
              return (
                <SearchLogRow
                  key={row.id}
                  hit={hit}
                  now={now}
                  {...rowTimes(row, now, tz)}
                  nameRanges={d.nameRanges}
                  caseRanges={d.caseRanges}
                  line={line}
                  lineRanges={line ? d.lineRanges : []}
                />
              );
            })}
          </LogGrid>
        ) : hasQuery ? (
          <EmptyState icon="search" title="No matches" />
        ) : null}
      </main>
    </div>
  );
}
