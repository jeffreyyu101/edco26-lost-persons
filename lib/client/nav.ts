'use client';
// In-app navigation for the one signed-in route `/` (spec §7, v2.1 A22). Views are chosen by search
// params and changed with window.history.pushState / replaceState, which Next.js keeps in sync with
// useSearchParams. NEVER use router.push for in-app views: it fetches RSC payloads and breaks offline.
// FROZEN after Phase 1a: later phases may ADD exports, never change existing ones.
import { useSearchParams } from 'next/navigation';
import { useMemo } from 'react';
// No zod here: this module is on the first-load path of `/` (spec §7 Performance).
import { EDIT_SECTIONS, isStatus, isUuid, type EditSection } from '../domain';

/**
 * The view, parsed from the URL. Precedence when several params are present:
 * outbox > new > r (+ edit) > dashboard > q > view=pending|mine > status / post filters > All.
 * Unknown or invalid params are ignored.
 */
export type View =
  | { name: 'all'; status: string | null; post: string | null; open?: true }
  | { name: 'pending' }
  | { name: 'mine' }
  | { name: 'search'; q: string }
  | { name: 'new' }
  | { name: 'profile'; id: string }
  | { name: 'edit'; id: string; section: EditSection }
  | { name: 'dashboard' }
  | { name: 'outbox'; mutationId: string };

export type ViewName = View['name'];

/** URL parameters (A22). `navigate` replaces the whole query with exactly these. */
export interface NavParams {
  view?: 'pending' | 'mine';
  /** All, filtered by a status (database value) — shown as a chip. */
  status?: string;
  /** All, filtered by post: a domain.postFilterKey ("FA 4 – Oasis", "Other:Gate 9") — shown as a chip. */
  post?: string;
  /**
   * With `post`: only open requests (Waiting, In medical), the rows a dashboard "Open by post" bar counts.
   * Ignored without `post`.
   */
  open?: true;
  /** Search text. */
  q?: string;
  new?: true;
  /** Profile of this request id. */
  r?: string;
  /** With r: the full-screen edit form for one section. */
  edit?: EditSection;
  dashboard?: true;
  /** The needs-attention editor for this outbox item. */
  outbox?: string;
}

const MAX_PARAM = 200;

function get(params: Pick<URLSearchParams, 'get'>, key: string): string | null {
  const v = params.get(key);
  if (v === null) return null;
  const t = v.trim();
  return t && t.length <= MAX_PARAM ? t : null;
}

export function parseView(params: Pick<URLSearchParams, 'get'>): View {
  const outbox = get(params, 'outbox');
  if (outbox && isUuid(outbox)) return { name: 'outbox', mutationId: outbox };

  if (get(params, 'new') === '1') return { name: 'new' };

  const r = get(params, 'r');
  if (r && isUuid(r)) {
    const edit = get(params, 'edit');
    if (edit && (EDIT_SECTIONS as readonly string[]).includes(edit)) {
      return { name: 'edit', id: r, section: edit as EditSection };
    }
    return { name: 'profile', id: r };
  }

  if (get(params, 'dashboard') === '1') return { name: 'dashboard' };

  const q = params.get('q');
  if (q !== null && q.length <= MAX_PARAM) return { name: 'search', q };

  const view = get(params, 'view');
  if (view === 'pending') return { name: 'pending' };
  if (view === 'mine') return { name: 'mine' };

  const status = get(params, 'status');
  const post = get(params, 'post');
  const open = post !== null && get(params, 'open') === '1';
  return {
    name: 'all',
    status: status && isStatus(status) ? status : null,
    post: post ?? null,
    ...(open ? { open: true as const } : {}),
  };
}

export function viewToParams(view: View): NavParams {
  switch (view.name) {
    case 'all': {
      const p: NavParams = {};
      if (view.status) p.status = view.status;
      if (view.post) p.post = view.post;
      if (view.post && view.open) p.open = true;
      return p;
    }
    case 'pending':
    case 'mine':
      return { view: view.name };
    case 'search':
      return { q: view.q };
    case 'new':
      return { new: true };
    case 'profile':
      return { r: view.id };
    case 'edit':
      return { r: view.id, edit: view.section };
    case 'dashboard':
      return { dashboard: true };
    case 'outbox':
      return { outbox: view.mutationId };
  }
}

/** "/?view=pending", "/?r=…&edit=person", or "/" for All. */
export function hrefFor(params: NavParams): string {
  const sp = new URLSearchParams();
  if (params.outbox) sp.set('outbox', params.outbox);
  if (params.new) sp.set('new', '1');
  if (params.r) sp.set('r', params.r);
  if (params.r && params.edit) sp.set('edit', params.edit);
  if (params.dashboard) sp.set('dashboard', '1');
  if (params.q !== undefined) sp.set('q', params.q);
  if (params.view) sp.set('view', params.view);
  if (params.status) sp.set('status', params.status);
  if (params.post) sp.set('post', params.post);
  if (params.post && params.open) sp.set('open', '1');
  const s = sp.toString();
  return s ? `/?${s}` : '/';
}

interface HistoryState {
  /** How many in-app entries sit below this one (0 = the entry the app was opened on). */
  lpDepth?: number;
}

function currentDepth(): number {
  const state = (window.history.state ?? {}) as HistoryState;
  return typeof state.lpDepth === 'number' ? state.lpDepth : 0;
}

/**
 * Go to a view. `replace` swaps the current history entry instead of pushing one.
 *
 * Always pass a FRESH state object, never a copy of window.history.state. Next.js patches pushState /
 * replaceState: when the data already carries its own `__NA` / `_N` marker (which every entry Next created
 * has), the patch treats the call as Next-internal, skips its router update, and useSearchParams /
 * useView() never see the new URL (the address bar changes, the view does not). With a fresh object the
 * patch copies `__NA` and the router tree in itself and syncs the router.
 */
export function navigate(params: NavParams, opts: { replace?: boolean } = {}): void {
  if (typeof window === 'undefined') return;
  const href = hrefFor(params);
  if (opts.replace) {
    window.history.replaceState({ lpDepth: currentDepth() }, '', href);
  } else {
    window.history.pushState({ lpDepth: currentDepth() + 1 }, '', href);
  }
}

/**
 * Close a full-screen view: history.back() when the previous entry is in the app (so the list keeps its
 * scroll and filter), else replace with `fallback` (deep links, e.g. a profile opened from iMessage).
 */
export function goBack(fallback: NavParams = {}): void {
  if (typeof window === 'undefined') return;
  if (currentDepth() > 0) window.history.back();
  else navigate(fallback, { replace: true });
}

/** The current view, re-rendered on pushState / replaceState / back / forward. */
export function useView(): View {
  const params = useSearchParams();
  const key = params.toString();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures every change to params
  return useMemo(() => parseView(params), [key]);
}
