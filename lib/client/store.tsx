'use client';
// The store provider for the `/` page (spec §7 Store). Phase 1a ships it backed by the in-memory STUB
// (synthetic rows) so the shell and placeholder views render; Phase 1b (C) replaces the body with the real
// store (sync, overlays, outbox, IndexedDB, alerts) implementing the same AppStore contract.
import { useState, type ReactNode } from 'react';
import { StoreContext, createStubStore, type AppStore } from './store-contract';

export interface StoreProviderProps {
  children: ReactNode;
  /** IANA zone for every displayed time (EVENT_TIMEZONE, read on the server). */
  eventTimezone: string;
}

export function StoreProvider({ children, eventTimezone }: StoreProviderProps) {
  const [store] = useState<AppStore>(() => createStubStore({ eventTimezone }));
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}
