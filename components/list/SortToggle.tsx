'use client';
// Sort by status on All requests and My requests (Pending v9.1, Brian 2026-11-06; design/screens/pending-v9.html
// SortToggle, frames 6, 7 and 9): ONE tap, no menu. The button names the current order: an outlined "⇅ Newest"
// (All) or "⇅ Updated" (My requests) by default, a filled gray-a4 "⇅ Status" when on. It sits at the right end of
// the live line under the title and drops to its own row, left-aligned, on a phone narrower than 360 px. The
// choice is remembered per view on this device (lib/client/view-prefs.ts), and a polite live region says what
// happened ("Sorted by status" / "Sorted: newest first").
import { ArrowUpDown } from 'lucide-react';
import { useState } from 'react';
import { useSortOrder, type SortOrder, type SortView } from '@/lib/client/view-prefs';
import s from './list.module.css';

export interface SortWords {
  /** The default order's word on the button. */
  off: string;
  /** The default order as a screen reader says it. */
  offSaid: string;
}

export const SORT_WORDS: Readonly<Record<SortView, SortWords>> = {
  all: { off: 'Newest', offSaid: 'newest first' },
  mine: { off: 'Updated', offSaid: 'latest update first' },
};

export const STATUS_SORT_LABEL = 'Status';

/** The button's accessible name: it starts with its visible word (WCAG 2.5.3) and says what a tap does. */
export function sortToggleLabel(view: SortView, order: SortOrder): string {
  const w = SORT_WORDS[view];
  return order === 'status'
    ? `${STATUS_SORT_LABEL} order, waiting for check first. Sort ${w.offSaid}`
    : `${w.off}, ${w.offSaid}. Sort by status, waiting for check first`;
}

/** What the live region says after a tap. */
export function sortAnnouncement(view: SortView, order: SortOrder): string {
  return order === 'status' ? 'Sorted by status' : `Sorted: ${SORT_WORDS[view].offSaid}`;
}

export function SortToggle({ view }: { view: SortView }) {
  const [order, setOrder] = useSortOrder(view);
  const [announced, setAnnounced] = useState('');
  const on = order === 'status';
  return (
    <>
      <button
        type="button"
        className={s.sort}
        aria-pressed={on}
        aria-label={sortToggleLabel(view, order)}
        data-testid="sort-toggle"
        onClick={() => {
          const next: SortOrder = on ? 'default' : 'status';
          setOrder(next);
          setAnnounced(sortAnnouncement(view, next));
        }}
      >
        <ArrowUpDown size={14} strokeWidth={2} aria-hidden />
        {on ? STATUS_SORT_LABEL : SORT_WORDS[view].off}
      </button>
      <span className={s.vh} role="status" aria-live="polite" data-testid="sort-announcement">
        {announced}
      </span>
    </>
  );
}
