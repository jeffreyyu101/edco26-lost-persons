'use client';
// The store provider for the `/` page (spec §7 Store). Backed by the REAL store (lib/client/store-core.ts):
// sync, overlays, the outbox, IndexedDB, alerts and the service worker. The in-memory stub
// (store-stub.ts + stub-data.ts) is for tests only and must never be imported here (v2.2 A25).
//
// This provider is ALSO RENDERED ON THE SERVER (AppShell is a client component returned by a server
// page), and the useState initializer below runs there for every request. The store keeps the
// server-render invariants documented above `AppStore` in store-contract.ts:
//   * Construction is pure: no timers, fetch, IndexedDB, navigator, window listeners or BroadcastChannel.
//   * Every side effect begins in store.start(), called from the useEffect below (client only, after
//     hydration). The function it returns stops them all (StrictMode runs start → stop → start).
//   * Hydration reads store.getServerState() (= createServerState(eventTimezone)), so an offline reload of
//     the service-worker-cached HTML hydrates cleanly and then shows the offline banner.
import { useEffect, useState, type ReactNode } from 'react';
import { StoreContext, type AppStore } from './store-contract';
import { createAppStore } from './store-core';
import { FALLBACK_TIMEZONE } from '../format';

export interface StoreProviderProps {
  children: ReactNode;
  /**
   * IANA zone of the server render and hydration, before the event's config is known (default UTC; the server HTML
   * shows no time). The store then uses the event's (EventConfig.timezone).
   */
  eventTimezone?: string;
}

export function StoreProvider({ children, eventTimezone = FALLBACK_TIMEZONE }: StoreProviderProps) {
  // Pure construction: safe on the server (see above).
  const [store] = useState<AppStore>(() => createAppStore({ eventTimezone }));
  // Side effects start on the client only, after hydration; the returned function stops them.
  useEffect(() => store.start?.(), [store]);
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}
