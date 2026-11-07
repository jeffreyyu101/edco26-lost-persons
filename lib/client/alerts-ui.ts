// Whether the Alerts sheet is open (F4). The avatar menu, the desk sidebar and rail, and the banner (once
// alerts turn on) open it; the Activity host draws it. A tiny external store, no other dependency.
import { useSyncExternalStore } from 'react';

let open = false;
const listeners = new Set<() => void>();

function set(next: boolean): void {
  if (next === open) return;
  open = next;
  for (const l of [...listeners]) l();
}

export function openAlertsSheet(): void {
  set(true);
}

export function setAlertsSheetOpen(next: boolean): void {
  set(next);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const get = () => open;
const serverGet = () => false;

export function useAlertsSheetOpen(): boolean {
  return useSyncExternalStore(subscribe, get, serverGet);
}
