'use client';
// List views: All, Pending, My requests and Search (spec §8 List views, v2.1 A3/A22; log option B and the
// header declutter of 2026-11-06, design/screens/polish-v7.html + v7-log.png). The page loads each export
// with next/dynamic. Every action goes through the store contract; every view change through lib/client/nav.
//
// All requests opens with the brand card (Jeffrey, 2026-11-06 10:31: logos, event details and the big "Is my
// friend in medical?"), which scrolls away; Pending and My requests open with just their large title (Pending
// v8, Brian 2026-11-06 afternoon). Each view owns its sticky bar (the large title that is the view menu,
// search, and the avatar with its offline / reconnecting badge), the offline / error banner under it, the
// filter chips (Pending: its To check | Friend coming control), and the New request button. Skeletons show
// only while there is no cached data yet.
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
import { AlertsBanner } from '@/components/alerts/AlertsBanner';
import { ConnectionBanner } from '@/components/ui/Banner';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatusGlyph } from '@/components/ui/StatusGlyph';
import { PendingBoard } from '@/components/desk/PendingBoard';
import { LocationEditor, anchorFor, type LocationTarget, type Measurable } from '@/components/profile/LocationEditor';
import type { RequestSummary } from '@/lib/api-types';
import { goBack, navigate } from '@/lib/client/nav';
import { splitOpenClosed } from '@/lib/client/selectors';
import {
  useActions,
  useAllRows,
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
import { STATUS, parsePostFilterKey, postFilterLabel, statusMeta, type GlyphKind } from '@/lib/domain';
import { formatCreatedTime, formatUpdatedAgo, updatedPhrase } from '@/lib/format';
import { useInDesk } from '@/components/desk/desk-context';
import { AppHeader } from './AppHeader';
import { BrandCard } from './BrandCard';
import { CheckCard, ComingCard, MineCard, OutboxCard } from './cards';
import { displayName } from './list-helpers';
import { PendingTabs, pendingTabIds, usePendingTab } from './PendingTabs';
import { primeKeyboard, useDelayedFlag, useScrollMemory, useStatusTap, useStickyHeight } from './hooks';
import { mineFreshTone, resultCount, searchDisplay, updatedSince } from './list-helpers';
import { AllSkeleton, MineSkeleton, PendingSkeleton } from './ListSkeletons';
import { ArchivedFold, ArchivedRows, ColumnHeader, LogGrid, LogRow, OutboxLogRow, SearchLogRow } from './rows';
import type { ListViewName } from './ViewSwitcher';
import s from './list.module.css';

const selectHydrated = (state: StoreState) => state.hydrated;

/** A sync shorter than this doesn't turn the reconnecting arrow (no flicker on every quick retry). */
const SLOW_SYNC_MS = 400;

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
  /** Filter chips under the title (All only). */
  chips?: ReactNode;
  /** Selecting the current view still navigates (All with a filter clears the filter). */
  filtered?: boolean;
  skeleton: ReactNode;
  children: ReactNode;
}

function Chrome({ view, chips, filtered = false, skeleton, children }: ChromeProps) {
  const actions = useActions();
  const { connection, syncing } = useConnection();
  const counts = useCounts();
  const loading = useIsLoading();
  const hydrated = useStoreSelector(selectHydrated);
  const snackbar = useSnackbar();
  const { rootRef, stickyRef } = useStickyHeight();
  // From 768 px the desk shell draws the brand (its sidebar) and this view's chrome: the brand card is phone
  // only, and only on All requests (Pending v8: Pending and My requests get just the large title).
  const inDesk = useInDesk();
  // The reconnecting arrow turns only for a retry that takes a moment (no flicker on fast attempts).
  const slowSync = useDelayedFlag(syncing, SLOW_SYNC_MS);

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

  return (
    <div className={s.root} data-view={view} ref={rootRef}>
      {inDesk || view !== 'all' ? null : <BrandCard />}
      {/* F4: until lock-screen alerts work on this phone (on the desk it sits in the main column). */}
      {inDesk ? null : <AlertsBanner />}
      <div className={s.sticky} ref={stickyRef}>
        <AppHeader
          view={view}
          counts={loading ? null : counts}
          onSelect={select}
          connection={connection}
          syncing={slowSync}
          onOpenSearch={() => {
            primeKeyboard();
            navigate({ q: '' });
          }}
          account={<AccountMenu />}
        />
        {loading ? null : <ConnectionBanner />}
        {chips}
      </div>
      <main className={s.body}>
        {inDesk ? <AlertsBanner /> : null}
        {body}
      </main>
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
  };
}

function Rows({ rows, now, tz }: { rows: readonly RequestSummary[]; now: number; tz: string }) {
  return (
    <>
      {rows.map((row) => (
        <LogRow key={row.id} row={row} {...rowTimes(row, now, tz)} />
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
  const filtered = !!(status || post);
  // Requests saved on this phone sit on top of the unfiltered log (they have no status or LP number yet).
  const queued = filtered ? [] : outbox;
  // Unfiltered: open first, closed folded under Archived (rows are already newest first). Filtered: one list,
  // closed rows greyed in place, no fold.
  const sections = useMemo(() => (filtered ? null : splitOpenClosed(rows)), [filtered, rows]);
  // The Archived fold's open state lasts for this browser session (prefs.closedExpanded, sessionStorage).
  const expanded = prefs.closedExpanded;
  useScrollMemory(`all|${status ?? ''}|${post ?? ''}|${openOnly ? 'open' : ''}`, !loading);

  return (
    <Chrome
      view="all"
      filtered={filtered}
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
          {sections ? (
            <>
              <Rows rows={sections.open} now={now} tz={tz} />
              {sections.closed.length > 0 ? (
                <ArchivedFold
                  count={sections.closed.length}
                  open={expanded}
                  controls={archivedId}
                  onToggle={() => actions.setPref('closedExpanded', !expanded)}
                />
              ) : null}
              {expanded && sections.closed.length > 0 ? (
                <ArchivedRows id={archivedId}>
                  <Rows rows={sections.closed} now={now} tz={tz} />
                </ArchivedRows>
              ) : null}
            </>
          ) : (
            <Rows rows={rows} now={now} tz={tz} />
          )}
        </LogGrid>
      )}
    </Chrome>
  );
}

// ---------------------------------------------------------------------------------------------------
// Pending v8 (design/screens/pending-v8.html, Brian + Dani 2026-11-06 afternoon): To check (oldest first) and
// Friend coming (oldest answer first). The phone shows one at a time under a segmented control (To check by
// default, the last tab remembered); the desk shows both side by side (components/desk/PendingBoard.tsx).
// In medical saves at once (overlay + Undo, as before) and then asks where medical has them: the phone's
// bottom sheet, the desk's popover at the card. A Friend coming card's location chip edits it.
// ---------------------------------------------------------------------------------------------------

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

/** The location being asked for or edited, and where the desk popover points. */
interface Locating {
  target: LocationTarget;
  anchor: RefObject<Measurable | null>;
}

export function PendingView() {
  const { friendComing, waiting } = usePending();
  const loading = useIsLoading();
  const now = useNow();
  const inDesk = useInDesk();
  const { offline, tap } = useStatusTap();
  const actions = useActions();
  const [tab, chooseTab] = usePendingTab();
  const [locating, setLocating] = useState<Locating | null>(null);
  const idBase = useId();
  useScrollMemory('pending', !loading);
  // The other list starts at its top (the title and the control stay on screen, they are sticky).
  const setTab = useCallback(
    (next: typeof tab) => {
      if (next !== tab) window.scrollTo(0, 0);
      chooseTab(next);
    },
    [tab, chooseTab],
  );

  const openLocation = useCallback((row: RequestSummary, mode: LocationTarget['mode'], card: HTMLElement | null) => {
    setLocating({
      target: { id: row.id, name: displayName(row.name), mode, initial: (row.medicalLocation ?? '').trim() },
      // The desk popover points at what was tapped: the To check card (where it stays once the card has
      // moved on to Friend coming), or the location chip.
      anchor: anchorFor(
        mode === 'answer' ? `[data-desk-main] [data-testid="check-card"][data-pending-card="${row.id}"]` : `[data-desk-main] [data-location-anchor="${row.id}"]`,
        card?.getBoundingClientRect() ?? null,
      ),
    });
  }, []);
  const closeLocation = useCallback(() => setLocating(null), []);

  const onNotInMedical = useCallback((row: RequestSummary) => void tap(row.id, STATUS.notInMedical, 'answer'), [tap]);
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
  // left To check, so the focus is let go (J / K carry on from the last card).
  const returnFocus = useCallback(() => {
    const target = locating?.target;
    if (!target || target.mode !== 'edit') return null;
    const chips = Array.from(document.querySelectorAll<HTMLElement>(`[data-desk-main] [data-location-anchor="${target.id}"]`));
    return chips.find((el) => el.getClientRects().length > 0) ?? null;
  }, [locating]);

  const counts = { check: waiting.length, coming: friendComing.length };
  const editor = (
    <LocationEditor
      target={locating?.target ?? null}
      desk={inDesk}
      anchor={locating?.anchor}
      returnFocus={returnFocus}
      onClose={closeLocation}
    />
  );

  if (inDesk) {
    return (
      <Chrome view="pending" skeleton={<PendingSkeleton />}>
        <PendingBoard
          waiting={waiting}
          friendComing={friendComing}
          now={now}
          offline={offline}
          tab={tab}
          onTab={setTab}
          idBase={idBase}
          onNotInMedical={onNotInMedical}
          onInMedical={onInMedical}
          onReunited={onReunited}
          onLocate={onLocate}
        />
        {editor}
      </Chrome>
    );
  }

  const ids = pendingTabIds(idBase, tab);
  const shown = tab === 'check' ? waiting : friendComing;
  return (
    <Chrome
      view="pending"
      chips={<PendingTabs tab={tab} onChange={setTab} counts={loading ? null : counts} idBase={idBase} />}
      skeleton={<PendingSkeleton />}
    >
      {friendComing.length + waiting.length === 0 ? (
        <EmptyState icon="inbox" title="Nothing pending" />
      ) : shown.length === 0 ? (
        <div className={s.tabBody} role="tabpanel" id={ids.panel} aria-labelledby={ids.tab}>
          <EmptyState icon="inbox" title={tab === 'check' ? 'Nothing to check' : 'No friends coming'} />
        </div>
      ) : (
        <div className={s.scroll} role="tabpanel" id={ids.panel} aria-labelledby={ids.tab} data-testid="request-list" data-tab={tab}>
          {tab === 'check'
            ? waiting.map((row) => (
                <CheckCard key={row.id} row={row} now={now} offline={offline} onNotInMedical={onNotInMedical} onInMedical={onInMedical} />
              ))
            : friendComing.map((row) => (
                <ComingCard key={row.id} row={row} now={now} offline={offline} onReunited={onReunited} onLocate={onLocate} />
              ))}
        </div>
      )}
      {editor}
    </Chrome>
  );
}

// ---------------------------------------------------------------------------------------------------
// My requests: queued requests on top, then open requests, then the closed ones (Not in medical included),
// each newest update first, with the progress stepper
// ---------------------------------------------------------------------------------------------------

export function MineView() {
  const rows = useMine();
  const outbox = useOutbox();
  const session = useSession();
  const loading = useIsLoading();
  const now = useNow();
  const { open, closed } = useMemo(() => splitOpenClosed(rows), [rows]);
  useScrollMemory('mine', !loading);

  return (
    <Chrome view="mine" skeleton={<MineSkeleton />}>
      {rows.length + outbox.length === 0 ? (
        <EmptyState icon="inbox" title="No requests yet" />
      ) : (
        <div className={s.scroll} data-testid="request-list">
          {outbox.map((item) => (
            <OutboxCard key={item.mutationId} item={item} now={now} />
          ))}
          {open.map((row) => (
            <MineCard key={row.id} row={row} now={now} freshTone={mineFreshTone(row, now, session.staff)} />
          ))}
          {closed.length > 0 ? (
            <section className={s.scroll} style={{ padding: 0 }} aria-label={`Closed, ${closed.length}`} data-testid="mine-closed">
              <SectionHeader kind="closed" label="Closed" count={closed.length} />
              {closed.map((row) => (
                <MineCard key={row.id} row={row} now={now} freshTone={mineFreshTone(row, now, session.staff)} />
              ))}
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
