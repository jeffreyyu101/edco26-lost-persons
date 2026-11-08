'use client';
// What the desk's top bar needs to draw the dashboard's live line (v2.2 afternoon, F1.2: "Updated just now" /
// "Last updated 3:42 PM" and Refresh now). On a phone the dashboard draws that line under its own title; on
// the desk (from 768 px) the shell's top bar holds the title, so the line goes there, next to it
// (components/desk/TopBar.tsx; design/screens/live-indicator.html, the Desktop frame), and the dashboard only
// publishes its inputs: when its stats last arrived, whether the fetch is failing, and its refresh. The top
// bar derives the line from them with the same useLiveStatus() the dashboard's own banner uses, so the two
// never disagree. Tiny on purpose: the desk chunk imports it.
import { useSyncExternalStore } from 'react';

export interface DashboardLive {
  /** When the last stats fetch landed (epoch ms on this device), or null before the first. */
  syncedAt: number | null;
  /** The stats fetches failed past the lists' thresholds (useStats().failing): Reconnecting. */
  failing: boolean;
  /** Fetch the stats at once (Refresh now). */
  refresh: () => Promise<void>;
}

let current: DashboardLive | null = null;
const listeners = new Set<() => void>();

/** The open dashboard's live inputs, or null when it closes. */
export function setDashboardLive(next: DashboardLive | null): void {
  if (next === current) return;
  if (next && current && next.syncedAt === current.syncedAt && next.failing === current.failing && next.refresh === current.refresh) return;
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const read = () => current;

/**
 * What the open dashboard last published (null when none is open). The top bar is desk-only and never
 * hydrated from server HTML (the desk chunk loads after hydration), so the server snapshot can be the same.
 */
export function useDashboardLive(): DashboardLive | null {
  return useSyncExternalStore(subscribe, read, read);
}

// ---- Dashboard v4: the desk top bar's slot (design/screens/dashboard-v4.html .top: who's on, then the range control
// at the far right). The top bar renders an empty box on the dashboard and publishes it here; the dashboard portals
// its controls into it, so they stay in the dashboard's chunk and share its state.
let slot: HTMLElement | null = null;
const slotListeners = new Set<() => void>();

export function setDashboardSlot(el: HTMLElement | null): void {
  if (el === slot) return;
  slot = el;
  for (const listener of slotListeners) listener();
}

function subscribeSlot(listener: () => void): () => void {
  slotListeners.add(listener);
  return () => slotListeners.delete(listener);
}

const readSlot = () => slot;
const noSlot = () => null;

/** The desk top bar's dashboard box, or null (phone, or before the top bar has drawn). */
export function useDashboardSlot(): HTMLElement | null {
  return useSyncExternalStore(subscribeSlot, readSlot, noSlot);
}
