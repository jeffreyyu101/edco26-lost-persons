'use client';
// List views: All, Pending, My requests and Search (spec §8 List views, v2.1 A3/A22; mockups
// design/screens/requests.html, states.html, skeletons.html). The page loads each export with
// next/dynamic. Every action goes through the store contract; every view change through lib/client/nav.
//
// The list views own their header (title, live dot, search, bell, avatar), the offline / error banner
// between the header and the view bar (states.html Offline), the view switcher with the filter chips,
// and the New request button. Skeletons show only while there is no cached data yet.
import { Button, Text } from '@radix-ui/themes';
import { MapPin, Plus, Search as SearchIcon, X } from 'lucide-react';
import { useDeferredValue, useEffect, useRef, useState, type ReactNode } from 'react';
import { AccountMenu } from '@/components/account/AccountMenu';
import { ConnectionBanner } from '@/components/ui/Banner';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatusGlyph } from '@/components/ui/StatusGlyph';
import { goBack, navigate } from '@/lib/client/nav';
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
import { parsePostFilterKey, postFilterLabel, statusMeta } from '@/lib/domain';
import { formatListTime } from '@/lib/format';
import { BellSheet, isStandalone } from './BellSheet';
import { CheckCard, ComingCard, MineCard, OutboxCard } from './cards';
import { primeKeyboard, useDelayedFlag, useScrollMemory, useStatusTap } from './hooks';
import { mineFreshTone, resultCount } from './list-helpers';
import { AllSkeleton, MineSkeleton, PendingSkeleton } from './ListSkeletons';
import { AppHeader } from './AppHeader';
import { OutboxRow, RequestRow, SearchRow } from './rows';
import { ViewSwitcher, type ListViewName } from './ViewSwitcher';
import s from './list.module.css';

/** A sync shorter than this doesn't turn the live dot grey (no flicker on every 6 s poll). */
const SLOW_SYNC_MS = 400;

const selectHydrated = (state: StoreState) => state.hydrated;

interface ChromeProps {
  view: ListViewName;
  /** Filter chips under the switcher (All only). */
  chips?: ReactNode;
  /** Selecting the current view still navigates (All with a filter clears the filter). */
  filtered?: boolean;
  skeleton: ReactNode;
  children: ReactNode;
}

function Chrome({ view, chips, filtered = false, skeleton, children }: ChromeProps) {
  const actions = useActions();
  const { connection, syncing } = useConnection();
  const prefs = usePrefs();
  const counts = useCounts();
  const loading = useIsLoading();
  const hydrated = useStoreSelector(selectHydrated);
  const snackbar = useSnackbar();
  const slowSync = useDelayedFlag(syncing, SLOW_SYNC_MS);
  const [bellSheet, setBellSheet] = useState({ open: false, standalone: false });

  const toggleBell = () => {
    const on = !prefs.bell;
    actions.setPref('bell', on);
    if (on && !prefs.bellIntroSeen) {
      actions.setPref('bellIntroSeen', true);
      setBellSheet({ open: true, standalone: isStandalone() });
    }
  };

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
    <div className={s.root} data-view={view}>
      <div className={s.sticky}>
        <AppHeader
          connection={connection}
          // Grey while the first data loads or a slow sync runs; offline / error stays amber.
          syncing={connection === 'live' && (loading || slowSync)}
          onSyncNow={actions.syncNow}
          onOpenSearch={() => {
            primeKeyboard();
            navigate({ q: '' });
          }}
          bellOn={prefs.bell}
          onToggleBell={toggleBell}
          account={<AccountMenu />}
        />
        {loading ? null : <ConnectionBanner />}
        <ViewSwitcher view={view} counts={loading ? null : counts} onSelect={select}>
          {chips}
        </ViewSwitcher>
      </div>
      <main className={s.body}>{body}</main>
      {snackbar ? null : (
        <Button className={`${s.fab} lp-hit`} size="3" radius="full" highContrast onClick={() => navigate({ new: true })}>
          <Plus size={16} strokeWidth={1.75} aria-hidden /> New request
        </Button>
      )}
      <BellSheet
        open={bellSheet.open}
        standalone={bellSheet.standalone}
        onOpenChange={(open) => setBellSheet((b) => ({ ...b, open }))}
      />
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
}

// Chip names start with what the chip shows, "Not in medical 3" (WCAG 2.5.3); {' '} keeps the label and
// the count apart as words without adding space to the layout.
function FilterChips({ status, post, count }: { status: string | null; post: string | null; count: number }) {
  const statusLabel = status ? statusMeta(status).shortLabel : '';
  const postPlace = post ? parsePostFilterKey(post) : null;
  const postLabel = postPlace ? postFilterLabel(postPlace.reportingLocation, postPlace.otherLocation) : '';
  return (
    <div className={s.chips}>
      {status ? (
        <button
          type="button"
          className={s.chip}
          aria-label={post ? `${statusLabel}. Clear this filter` : `${statusLabel} ${count} shown. Clear this filter`}
          onClick={() => navigate(post ? { post } : {}, { replace: true })}
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

export function AllView({ status, post }: AllViewProps) {
  const rows = useAllRows({ status, post });
  const outbox = useOutbox();
  const loading = useIsLoading();
  const tz = useEventTimezone();
  const now = useNow();
  const filtered = !!(status || post);
  // Requests saved on this phone sit on top of the unfiltered log (they have no status or LP number yet).
  const queued = filtered ? [] : outbox;
  useScrollMemory(`all|${status ?? ''}|${post ?? ''}`, !loading);

  return (
    <Chrome
      view="all"
      filtered={filtered}
      chips={filtered ? <FilterChips status={status} post={post} count={rows.length} /> : null}
      skeleton={<AllSkeleton />}
    >
      {rows.length + queued.length === 0 ? (
        <EmptyState icon="inbox" title={filtered ? 'No matching requests' : 'No requests yet'} />
      ) : (
        <div className={s.flat} data-testid="request-list">
          {queued.map((item) => (
            <OutboxRow key={item.mutationId} item={item} time={formatListTime(item.createdAt, now, tz)} />
          ))}
          {rows.map((row) => (
            <RequestRow key={row.id} row={row} time={formatListTime(row.createdAt, now, tz)} />
          ))}
        </div>
      )}
    </Chrome>
  );
}

// ---------------------------------------------------------------------------------------------------
// Pending: Friend coming (oldest first), then Waiting for check (oldest first)
// ---------------------------------------------------------------------------------------------------

function SectionHeader({ kind, label, count }: { kind: 'inMedical' | 'waiting'; label: string; count: number }) {
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

export function PendingView() {
  const { friendComing, waiting } = usePending();
  const loading = useIsLoading();
  const now = useNow();
  const { offline, tap } = useStatusTap();
  useScrollMemory('pending', !loading);

  return (
    <Chrome view="pending" skeleton={<PendingSkeleton />}>
      {friendComing.length + waiting.length === 0 ? (
        <EmptyState icon="inbox" title="Nothing pending" />
      ) : (
        <div className={s.scroll} data-testid="request-list">
          {friendComing.length > 0 ? (
            <section className={s.scroll} style={{ padding: 0 }} aria-label={`Friend coming, ${friendComing.length}`}>
              <SectionHeader kind="inMedical" label="Friend coming" count={friendComing.length} />
              {friendComing.map((row) => (
                <ComingCard key={row.id} row={row} now={now} offline={offline} onTap={tap} />
              ))}
            </section>
          ) : null}
          {waiting.length > 0 ? (
            <section className={s.scroll} style={{ padding: 0 }} aria-label={`Waiting for check, ${waiting.length}`}>
              <SectionHeader kind="waiting" label="Waiting for check" count={waiting.length} />
              {waiting.map((row) => (
                <CheckCard key={row.id} row={row} now={now} offline={offline} onTap={tap} />
              ))}
            </section>
          ) : null}
        </div>
      )}
    </Chrome>
  );
}

// ---------------------------------------------------------------------------------------------------
// My requests: queued requests on top, then newest update first, each with the progress stepper
// ---------------------------------------------------------------------------------------------------

export function MineView() {
  const rows = useMine();
  const outbox = useOutbox();
  const session = useSession();
  const loading = useIsLoading();
  const now = useNow();
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
          {rows.map((row) => (
            <MineCard key={row.id} row={row} now={now} freshTone={mineFreshTone(row, now, session.staff)} />
          ))}
        </div>
      )}
    </Chrome>
  );
}

// ---------------------------------------------------------------------------------------------------
// Search: the field takes over the header (states.html Search)
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
  const inputRef = useRef<HTMLInputElement>(null);
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
    <div className={s.root} data-view="search">
      <div className={s.sticky}>
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
          <div className={s.flat} data-testid="request-list">
            {hits.map((hit) => (
              <SearchRow key={hit.row.id} hit={hit} />
            ))}
          </div>
        ) : hasQuery ? (
          <EmptyState icon="search" title="No matches" />
        ) : null}
      </main>
    </div>
  );
}
