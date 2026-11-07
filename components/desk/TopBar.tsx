'use client';
// The main column's top bar (design/screens/desktop-log.html .top): the view's title and count, search
// (a field with the "/" cap when the column has room, else an icon that opens search), and New request
// with the "N" cap ("New" when the column is narrow, desktop-new-tablet.html iPad landscape). On the
// dashboard, its Offline / Retrying chip sits beside the title (the dashboard has no title row of its own here).
//
// Search drives the existing Search view through ?q= (lib/client/nav): the first character opens it (one
// history entry), later ones replace it, Esc clears and then leaves.
import { IconButton } from '@radix-ui/themes';
import { Plus, Search, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ActivityBellSlot } from '@/components/activity/slots';
import { DashboardConnectionChip } from '@/components/dashboard/ConnectionChip';
import { useDashboardConnection } from '@/components/dashboard/connection-signal';
import { goBack, navigate } from '@/lib/client/nav';
import { Kbd, useMainCount } from './parts';
import { mainTitle } from './nav-model';
import type { MainView } from './views';
import d from './desk.module.css';

/** nav.parseView ignores a longer ?q=. */
const MAX_QUERY = 200;

export interface DeskTopProps {
  main: MainView;
}

export function DeskTop({ main }: DeskTopProps) {
  const count = useMainCount(main);
  const searching = main.name === 'search';
  return (
    <div className={d.topbar} data-searching={searching ? '' : undefined} data-testid="desk-topbar">
      <h1 className={d.title}>
        {mainTitle(main)}
        {count === null ? null : (
          <>
            {' '}
            <span className={d.count}>{count}</span>
          </>
        )}
      </h1>
      {main.name === 'dashboard' ? <DashboardChip /> : null}
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
        <Search size={17} strokeWidth={1.75} aria-hidden />
      </IconButton>
      {/* Named by its visible text: "New request", or "New" when the column is narrow (an aria-label would
          not match the visible text, axe label-content-name-mismatch). */}
      <button type="button" className={`${d.newb} lp-hit`} aria-keyshortcuts="N" onClick={() => navigate({ new: true })} data-testid="desk-new">
        <Plus size={15} strokeWidth={2.25} aria-hidden />
        <span className={d.newLong}>New request</span>
        <span className={d.newShort}>New</span>
        <Kbd className={d.newKbd}>N</Kbd>
      </button>
      {/* F4: the Activity bell, its popover anchored here (the sidebar's Activity item opens the same one). */}
      <ActivityBellSlot place="desk" />
    </div>
  );
}

function DashboardChip() {
  return <DashboardConnectionChip state={useDashboardConnection()} className={d.conn} />;
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
