'use client';
// The store provider for the `/` page (spec §7 Store). Phase 1a ships it backed by the in-memory STUB
// (synthetic rows) so the shell and placeholder views render; Phase 1b (C) replaces the body with the real
// store (sync, overlays, outbox, IndexedDB, alerts) implementing the same AppStore contract.
// Phase 1b MUST remove the store-stub import (and with it stub-data): they are the only reason synthetic
// rows ship in the `/` first load today (v2.2 A25). Prefs come from lib/client/prefs.ts (readPrefs /
// writePref), as in the stub.
//
// This provider is ALSO RENDERED ON THE SERVER (AppShell is a client component returned by a server
// page), and the useState initializer below runs there for every request. The real store must therefore
// keep the server-render invariants documented above `AppStore` in store-contract.ts:
//   * Construction is pure: no timers, fetch, IndexedDB, navigator, window listeners or BroadcastChannel.
//   * Every side effect begins in store.start(), called from the useEffect below (client only, after
//     hydration). The function it returns stops them all.
//   * Hydration reads store.getServerState() (= createServerState(eventTimezone): connection 'live', empty
//     outbox, …), so an offline reload of the service-worker-cached HTML hydrates cleanly and then shows
//     the offline banner.
import { useEffect, useState, type ReactNode } from 'react';
import { StoreContext, type AppStore } from './store-contract';
import { createStubStore } from './store-stub';

export interface StoreProviderProps {
  children: ReactNode;
  /** IANA zone for every displayed time (EVENT_TIMEZONE, read on the server). */
  eventTimezone: string;
}

export function StoreProvider({ children, eventTimezone }: StoreProviderProps) {
  // Pure construction: safe on the server (see above).
  const [store] = useState<AppStore>(() => createStubStore({ eventTimezone }));
  // Side effects start on the client only, after hydration; the returned function stops them.
  useEffect(() => store.start?.(), [store]);
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}
