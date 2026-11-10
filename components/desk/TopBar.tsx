'use client';
// The main column's top bar (design/screens/desktop-sidebar-inset.html .top, inside the inset card): the sidebar's
// toggle (shadcn SidebarTrigger, PanelLeft, Cmd+B / Ctrl+B) and a short line, the view's title and count, search
// (a field with the "/" cap when the column has room, else an icon that opens search), New request with the "N"
// cap ("New" when the column is narrow, desktop-new-tablet.html iPad landscape), and the Activity bell. The live line
// (v2.2 afternoon, F1.2: "Updated just now", or "Last updated 3:42 PM" while a banner shows, and Refresh now)
// sits next to the title on the lists (design/screens/live-indicator.html, the Desktop frame): the store's last
// sync. The banner under the bar comes from the same derivation (useLiveStatus). The dashboard (v4) has its own
// controls here instead: who's on and the range, portalled into an empty box (components/dashboard/connection-signal).
//
// Search drives the existing Search view through ?q= (lib/client/nav): the first character opens it (one
// history entry), later ones replace it, Esc clears and then leaves.
import { IconButton } from '@radix-ui/themes';
import { PanelLeft, Plus, Search, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ActivityBellSlot } from '@/components/activity/slots';
import { setDashboardSlot } from '@/components/dashboard/connection-signal';
import { LiveIndicator } from '@/components/ui/LiveIndicator';
import { goBack, navigate } from '@/lib/client/nav';
import { refreshSync } from '@/lib/client/refresh-now';
import { useAppStore } from '@/lib/client/store-contract';
import { useLiveStatus } from '@/lib/client/use-live-status';
import { Kbd, useMainCount } from './parts';
import { mainTitle } from './nav-model';
import { SIDEBAR_ID } from './sidebar-model';
import { toggleSidebar, useSidebar } from './sidebar-state';
import type { MainView } from './views';
import d from './desk.module.css';
import { EventStageChip, PRACTICE } from '@/components/ui/EventStageChip';
import { useEventConfig } from '@/lib/client/event-config';

/** nav.parseView ignores a longer ?q=. */
const MAX_QUERY = 200;

export interface DeskTopProps {
  main: MainView;
  /** A request is open in the pane (the sidebar's toggle then opens it over the content where it would not fit). */
  pane?: boolean;
}

export function DeskTop({ main, pane = false }: DeskTopProps) {
  const count = useMainCount(main);
  const searching = main.name === 'search';
  const sidebar = useSidebar(pane);
  const archived = useEventConfig()?.stage === 'archived';
  return (
    <div className={d.topbar} data-searching={searching ? '' : undefined} data-testid="desk-topbar">
      <button
        type="button"
        className={`${d.trigger} lp-hit`}
        aria-label="Toggle sidebar"
        aria-expanded={sidebar.expanded}
        aria-controls={SIDEBAR_ID}
        aria-keyshortcuts="Meta+B Control+B"
        onClick={toggleSidebar}
        data-testid="desk-sidebar-toggle"
      >
        <PanelLeft size={16} strokeWidth={1.75} aria-hidden />
      </button>
      <span className={d.vsep} aria-hidden />
      <h1 className={d.title}>
        {mainTitle(main)}
        {count === null ? null : (
          <>
            {' '}
            <span className={d.count}>{count}</span>
          </>
        )}
      </h1>
      {/* (Events) The event's stage after the title: practice on every view (an archived dashboard draws its own chip). */}
      {main.name === 'dashboard' ? <EventStageChip only={PRACTICE} className={d.stage} /> : null}
      {main.name === 'dashboard' ? (
        // Dashboard v4: who's on and the range control, portalled in by the dashboard (no search or New here), then the
        // Activity bell, as on every view (the sidebar has no Activity item, Brian 2026-11-08).
        <>
          <div ref={setDashboardSlot} className={d.dashSlot} data-testid="desk-dashboard-slot" />
          <span className={d.bellBox}>
            <ActivityBellSlot place="desk" />
          </span>
        </>
      ) : (
        <>
          <ListLive />
          {/* (Events) The event's stage, after the line. */}
          <EventStageChip className={d.stage} />
          <span className={d.sp} />
          <SearchField main={main} />
          <IconButton
            variant="ghost"
            color="gray"
            className={`${d.searchIcon} lp-hit`}
            aria-label="Search"
            aria-keyshortcuts="/"
            onClick={() => navigate({ q: '' })}
          >
            <Search size={16} strokeWidth={1.75} aria-hidden />
          </IconButton>
          {/* Named by its visible text: "New request", or "New" when the column is narrow (an aria-label would
              not match the visible text, axe label-content-name-mismatch). */}
          {archived ? null : (
            <button type="button" className={`${d.newb} lp-hit`} aria-keyshortcuts="N" onClick={() => navigate({ new: true })} data-testid="desk-new">
              <Plus size={16} strokeWidth={2} aria-hidden />
              <span className={d.newLong}>New request</span>
              <span className={d.newShort}>New</span>
              <Kbd className={d.newKbd}>N</Kbd>
            </button>
          )}
          {/* F4: the Activity bell, its popover anchored here. Its box keeps the bell's 28 px while the chunk loads. */}
          <span className={d.bellBox}>
            <ActivityBellSlot place="desk" />
          </span>
        </>
      )}
    </div>
  );
}

/** The lists' line: the store's last successful sync; Refresh now syncs at once (one request). */
function ListLive() {
  const store = useAppStore();
  const live = useLiveStatus();
  const refresh = useCallback(() => refreshSync(store), [store]);
  return <LiveIndicator className={d.liveLine} line={live} onRefresh={refresh} />;
}



function SearchField({ main }: DeskTopProps) {
  const searching = main.name === 'search';
  const urlQ = searching ? main.q : null;
  const [text, setText] = useState(urlQ ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  // Leaving search empties the field; coming back to it (Back to /?q=…) shows that query. While searching
  // the field is the source (the URL follows it, so a late URL update never overwrites newer typing).
  const [wasSearching, setWasSearching] = useState(searching);
  if (searching !== wasSearching) {
    setWasSearching(searching);
    setText((t) => (searching ? t || (urlQ ?? '') : ''));
  }

  // Search opened empty (the icon, or "/" while the field is hidden) takes the focus, like the phone.
  const freshlyOpened = searching && urlQ === '';
  useEffect(() => {
    if (freshlyOpened) inputRef.current?.focus({ preventScroll: true });
  }, [freshlyOpened]);

  const change = (value: string) => {
    const inSearch = searching || text !== '';
    setText(value);
    navigate({ q: value }, { replace: inSearch });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    if (text) {
      change('');
      return;
    }
    e.currentTarget.blur();
    if (searching) goBack({});
  };

  return (
    <form role="search" className={d.search} onSubmit={(e) => e.preventDefault()}>
      <Search size={15} strokeWidth={1.75} className={d.searchGlyph} aria-hidden />
      <input
        ref={inputRef}
        type="search"
        className={d.searchInput}
        value={text}
        onChange={(e) => change(e.currentTarget.value)}
        onKeyDown={onKeyDown}
        placeholder="Search"
        aria-label="Search requests"
        aria-keyshortcuts="/"
        data-desk-search=""
        enterKeyHint="search"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={MAX_QUERY}
      />
      {text ? (
        <button
          type="button"
          className={d.searchClear}
          aria-label="Clear search"
          onClick={() => {
            change('');
            inputRef.current?.focus();
          }}
        >
          <X size={14} strokeWidth={1.75} aria-hidden />
        </button>
      ) : (
        <Kbd>/</Kbd>
      )}
    </form>
  );
}
