'use client';
// The dashboard's connection state (live / offline / retrying) for the desk's top bar. On a phone the
// dashboard shows its Offline / Retrying chip on its own title row; on the desk (from 768 px) the shell's
// top bar holds the title, so the chip goes there (components/desk/TopBar.tsx) and the dashboard only
// publishes the state. Tiny on purpose: the desk chunk imports it.
import { useSyncExternalStore } from 'react';

export type DashboardConnection = 'live' | 'offline' | 'retrying';

let current: DashboardConnection = 'live';
const listeners = new Set<() => void>();

export function setDashboardConnection(next: DashboardConnection): void {
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The state the open dashboard last published ('live' when none is open). */
export function useDashboardConnection(): DashboardConnection {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => 'live',
  );
}
