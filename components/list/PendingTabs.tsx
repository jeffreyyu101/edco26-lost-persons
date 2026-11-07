'use client';
// Pending's segmented control (design/screens/pending-v8.html .seg): "To check 4 | Friend coming 3", one list
// at a time. To check is the default; the last tab is remembered on this device (a per-device convenience:
// localStorage, best effort, so it also works with storage blocked). The phone puts it under the large
// title; the desk board uses it when its two columns don't fit side by side.
import { useCallback, useState, type KeyboardEvent } from 'react';
import { FriendComingDot } from '@/components/messages/CardActivity';
import { StatusGlyph } from '@/components/ui/StatusGlyph';
import s from './list.module.css';

export type PendingTab = 'check' | 'coming';

export const PENDING_TAB_KEY = 'lp-pending-tab';

const TABS: ReadonlyArray<{ id: PendingTab; label: string }> = [
  { id: 'check', label: 'To check' },
  { id: 'coming', label: 'Friend coming' },
];

export function readPendingTab(): PendingTab {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(PENDING_TAB_KEY) === 'coming' ? 'coming' : 'check';
  } catch {
    return 'check';
  }
}

function writePendingTab(tab: PendingTab): void {
  try {
    if (tab === 'check') window.localStorage.removeItem(PENDING_TAB_KEY);
    else window.localStorage.setItem(PENDING_TAB_KEY, tab);
  } catch {
    // Private mode / blocked storage: the tab just isn't remembered.
  }
}

/** The tab shown, starting from the remembered one. */
export function usePendingTab(): [PendingTab, (tab: PendingTab) => void] {
  const [tab, setTab] = useState<PendingTab>(readPendingTab);
  const choose = useCallback((next: PendingTab) => {
    setTab(next);
    writePendingTab(next);
  }, []);
  return [tab, choose];
}

/** The ids tying each tab to its list (aria-controls / aria-labelledby). */
export function pendingTabIds(base: string, tab: PendingTab): { tab: string; panel: string } {
  return { tab: `${base}-tab-${tab}`, panel: `${base}-panel-${tab}` };
}

export interface PendingTabsProps {
  tab: PendingTab;
  onChange: (tab: PendingTab) => void;
  /** null while loading (no numbers yet). */
  counts: { check: number; coming: number } | null;
  /** useId() of the view: the tabs and panels derive their ids from it. */
  idBase: string;
  className?: string;
}

export function PendingTabs({ tab, onChange, counts, idBase, className }: PendingTabsProps) {
  // Arrow keys move between the two tabs (the tab pattern); the selected one is the only tab stop.
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const next: PendingTab = e.key === 'Home' ? 'check' : e.key === 'End' ? 'coming' : tab === 'check' ? 'coming' : 'check';
    onChange(next);
    document.getElementById(pendingTabIds(idBase, next).tab)?.focus();
  };
  return (
    <div className={className ? `${s.seg} ${className}` : s.seg} role="tablist" aria-label="Pending" data-testid="pending-tabs">
      {TABS.map(({ id, label }) => {
        const ids = pendingTabIds(idBase, id);
        const count = counts ? counts[id] : null;
        const selected = tab === id;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            id={ids.tab}
            className={s.segb}
            aria-selected={selected}
            aria-controls={ids.panel}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(id)}
            onKeyDown={onKeyDown}
            data-tab={id}
          >
            <StatusGlyph kind={id === 'check' ? 'waiting' : 'inMedical'} size={14} />
            <span className={s.segl}>{label}</span>
            {count === null ? null : (
              <>
                {' '}
                <span className={s.segn}>{count}</span>
              </>
            )}
            {/* F3: a dot while a Friend coming request has unread messages. */}
            {id === 'coming' ? <FriendComingDot /> : null}
          </button>
        );
      })}
    </div>
  );
}
