'use client';
// The desk sidebar's state on this device (the model is ./sidebar-model.ts): the width chosen with its toggle, kept
// in localStorage (lib/desk-sidebar-pref.ts; every read and write in try / catch, like the other per-device
// prefs) and mirrored on <html data-desk-sidebar> for the CSS column; and the sidebar opened over the content,
// which lasts while the address stays the same (choosing a view, opening a request or a form closes it).
// The top bar's button, the sidebar's edge and Cmd+B / Ctrl+B (ShortcutManager) all call toggleSidebar().
import { useSyncExternalStore } from 'react';
import { parseView } from '@/lib/client/nav';
import { SIDEBAR_ATTR, SIDEBAR_STORAGE_KEY, parseSidebarPref, type SidebarPref } from '@/lib/desk-sidebar-pref';
import { DOCK_MIN, SIDEBAR_MIN, type DeskLayout } from './breakpoints';
import { sidebarExpanded, sidebarMode, toggled, type SidebarMode } from './sidebar-model';
import { paneRequestId } from './views';

interface Snapshot {
  pref: SidebarPref | null;
  /** The address the sidebar was opened over the content at, or null. */
  overlayAt: string | null;
}

/** The stored choice, or null (none yet, blocked storage, or no window). */
export function readSidebarPref(): SidebarPref | null {
  try {
    return parseSidebarPref(window.localStorage.getItem(SIDEBAR_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** Keep the choice (best effort) and mark <html> for the CSS column at once. */
export function writeSidebarPref(pref: SidebarPref): void {
  try {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, pref);
  } catch {
    // Private mode or blocked storage: the choice lasts for this page only.
  }
  markSidebar(pref);
}

function markSidebar(pref: SidebarPref | null): void {
  const root = typeof document === 'undefined' ? undefined : document.documentElement;
  if (!root) return;
  if (pref) root.setAttribute(SIDEBAR_ATTR, pref);
  else root.removeAttribute(SIDEBAR_ATTR);
}

const SERVER: Snapshot = { pref: null, overlayAt: null };
let snapshot: Snapshot | null = null;
const listeners = new Set<() => void>();

function current(): Snapshot {
  if (!snapshot) {
    snapshot = typeof window === 'undefined' ? SERVER : { pref: readSidebarPref(), overlayAt: null };
    // The pre-paint script marked <html> already; this covers a page that loaded before the choice was made.
    if (typeof window !== 'undefined') markSidebar(snapshot.pref);
  }
  return snapshot;
}

function update(next: Snapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

/** Another tab changed the choice: follow it. */
function onStorage(e: StorageEvent): void {
  if (e.key !== SIDEBAR_STORAGE_KEY && e.key !== null) return;
  const pref = readSidebarPref();
  markSidebar(pref);
  update({ ...current(), pref });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener('storage', onStorage);
  };
}

const WIDE_QUERY = `(min-width: ${SIDEBAR_MIN}px)`;
const DOCK_QUERY = `(min-width: ${DOCK_MIN}px)`;

const matches = (query: string) => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(query).matches;

/** The desk layout now (the stylesheets' breakpoints). */
export function deskLayoutNow(): DeskLayout {
  return matches(WIDE_QUERY) ? 'desktop' : matches(DOCK_QUERY) ? 'laptop' : 'tablet';
}

function subscribeLayout(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const queries = [window.matchMedia(WIDE_QUERY), window.matchMedia(DOCK_QUERY)];
  for (const q of queries) q.addEventListener('change', onChange);
  return () => {
    for (const q of queries) q.removeEventListener('change', onChange);
  };
}

/** The desk layout, re-rendered when the window crosses 1024 or 1280 px. The server draws the desktop. */
export function useDeskLayout(): DeskLayout {
  return useSyncExternalStore(subscribeLayout, deskLayoutNow, () => 'desktop');
}

const overlayOpenAt = (s: Snapshot) => s.overlayAt !== null && typeof window !== 'undefined' && s.overlayAt === window.location.href;

/** A request open in the pane, from the address bar (navigate() changes it before React re-renders). */
const paneOpenNow = () => paneRequestId(parseView(new URLSearchParams(window.location.search))) !== null;

export interface SidebarView {
  mode: SidebarMode;
  /** Labels and counts shown (docked expanded, or open over the content). */
  expanded: boolean;
  /** Open over the content, with the scrim. */
  overlay: boolean;
}

/** The sidebar as it is drawn now, for the sidebar itself and the top bar's toggle. */
export function useSidebar(paneOpen: boolean): SidebarView {
  const s = useSyncExternalStore(subscribe, current, () => SERVER);
  const layout = useDeskLayout();
  const mode = sidebarMode(layout, paneOpen);
  const overlay = mode === 'overlay' && overlayOpenAt(s);
  return { mode, overlay, expanded: sidebarExpanded({ pref: s.pref, overlay }, layout, paneOpen) };
}

/** The toggle (the top bar's button, the sidebar's edge, Cmd+B / Ctrl+B). */
export function toggleSidebar(): void {
  const s = current();
  const layout = deskLayoutNow();
  const paneOpen = paneOpenNow();
  const next = toggled({ pref: s.pref, overlay: sidebarMode(layout, paneOpen) === 'overlay' && overlayOpenAt(s) }, layout, paneOpen);
  if (next.pref && next.pref !== s.pref) writeSidebarPref(next.pref);
  update({ pref: next.pref, overlayAt: next.overlay ? window.location.href : null });
}

/** Whether the sidebar is open over the content now (Esc closes it first). */
export function sidebarOverlayOpen(): boolean {
  return overlayOpenAt(current()) && sidebarMode(deskLayoutNow(), paneOpenNow()) === 'overlay';
}

/** Close the sidebar opened over the content (Esc, the scrim, a view chosen, the address changed). */
export function closeSidebarOverlay(): void {
  const s = current();
  if (s.overlayAt !== null) update({ ...s, overlayAt: null });
}
