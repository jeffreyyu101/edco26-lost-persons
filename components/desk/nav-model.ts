// The sidebar / rail / top bar / pane model (pure; in the desk chunk; unit-tested in tests/unit/desk).
import type { NavParams } from '@/lib/client/nav';
import type { MainView } from './views';

/** Sidebar / rail entries. `dashboard` is a peer view on the desk (on the phone it opens from the menu). */
export type NavKey = 'all' | 'pending' | 'mine' | 'dashboard';

export const NAV_PARAMS: Readonly<Record<NavKey, NavParams>> = {
  all: {},
  pending: { view: 'pending' },
  mine: { view: 'mine' },
  dashboard: { dashboard: true },
};

export const NAV_LABEL: Readonly<Record<NavKey, string>> = {
  all: 'All requests',
  pending: 'Pending',
  mine: 'My requests',
  dashboard: 'Dashboard',
};

/** The sidebar entry the main view belongs to (search belongs to none). */
export function navKeyOf(view: MainView): NavKey | null {
  return view.name === 'search' ? null : view.name;
}

/** The top bar title of the main view. */
export function mainTitle(view: MainView): string {
  return view.name === 'search' ? 'Search' : NAV_LABEL[view.name];
}

/** Previous and next request ids around `current` in `ids` (the order the main column shows them). */
export function neighbours(ids: readonly string[], current: string | null): { prev: string | null; next: string | null } {
  if (ids.length === 0) return { prev: null, next: null };
  const at = current === null ? -1 : ids.indexOf(current);
  if (at < 0) return { prev: null, next: ids[0] ?? null };
  return { prev: ids[at - 1] ?? null, next: ids[at + 1] ?? null };
}

/** "LP-1004" style label is lib/format's; this is the pane's fallback while the row is unknown. */
export const PANE_FALLBACK_LABEL = 'Request';
