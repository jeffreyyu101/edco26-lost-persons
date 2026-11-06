// Which view the desk shows where (pure; unit-tested in tests/unit/desk/views.test.ts). On the first-load
// path of `/`: keep it small (the sidebar's model is in ./nav-model.ts, in the desk chunk).
//
// The URL keeps the phone's meaning (lib/client/nav.ts): ?r= is "the request", ?new=1 "the form", and so
// on. On the desk the main column always shows a list or the dashboard (the "main view"); a request opens
// beside it in the detail pane, and the forms open over it. The main view is the last list or dashboard
// the URL showed (rows open a request with navigate({ r }), which drops the list's own params), or All
// for a deep link.
import type { View } from '@/lib/client/nav';

export type MainView = Extract<View, { name: 'all' | 'pending' | 'mine' | 'search' | 'dashboard' }>;
export type FormView = Extract<View, { name: 'new' | 'edit' | 'outbox' }>;

export const ALL_VIEW: MainView = { name: 'all', status: null, post: null };

export function isMainView(view: View): view is MainView {
  return view.name === 'all' || view.name === 'pending' || view.name === 'mine' || view.name === 'search' || view.name === 'dashboard';
}

export function isFormView(view: View): view is FormView {
  return view.name === 'new' || view.name === 'edit' || view.name === 'outbox';
}

/** The request open in the detail pane, or null. Its edit form opens over it, so the pane stays behind. */
export function paneRequestId(view: View): string | null {
  return view.name === 'profile' || view.name === 'edit' ? view.id : null;
}

/** The main view to keep showing when `view` is not one (a request or a form is open). */
export function nextMainView(view: View, previous: MainView): MainView {
  return isMainView(view) ? view : previous;
}
