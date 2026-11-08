'use client';
// Starts the in-house telemetry collector (lib/client/telemetry, its own chunk) once the app is idle, from the shell's
// F4 host (components/activity/ActivityHost.tsx), which is itself loaded after start: nothing of it is on the first
// load (A25). The gate (lib/client/telemetry-gate.ts) keeps it off past the auto-off, after the server said off, and in
// automated browsers. A chunk that fails to load (festival Wi-Fi) is not retried this page load; nothing depends on it.
// The view is handed over as it changes; unmount stops everything the collector attached.
import { useEffect, useRef } from 'react';
import type { View } from '@/lib/client/nav';
import type { AppStore } from '@/lib/client/store-contract';
import { telemetryAllowed } from '@/lib/client/telemetry-gate';

export interface TelemetryView {
  name: View['name'];
  /** All requests' filter kind (the value is never sent). */
  filter: 'status' | 'post' | 'none';
}

interface Handle {
  view(view: TelemetryView): void;
  stop(): void;
  running(): boolean;
}

/** After idle: requestIdleCallback (5 s at most), or 3 s where it is missing (Safari). */
function whenIdle(fn: () => void): () => void {
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
  if (w.requestIdleCallback) {
    const id = w.requestIdleCallback(fn, { timeout: 5_000 });
    return () => w.cancelIdleCallback?.(id);
  }
  const id = window.setTimeout(fn, 3_000);
  return () => window.clearTimeout(id);
}

export function useTelemetry(store: AppStore, view: View): void {
  const filter: TelemetryView['filter'] = view.name === 'all' ? (view.status ? 'status' : view.post ? 'post' : 'none') : 'none';
  const current = useRef<TelemetryView>({ name: view.name, filter });
  const handle = useRef<Handle | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    let live = true;
    let loading = false;
    let failed = false;
    let cancel: (() => void) | undefined;
    const tryStart = () => {
      if (!live || loading || failed || handle.current?.running() || !telemetryAllowed()) return;
      loading = true;
      cancel = whenIdle(() => {
        import('@/lib/client/telemetry').then(
          (m) => {
            loading = false;
            if (!live) return;
            handle.current = m.startTelemetry(m.browserTelemetryHost(store, () => current.current));
          },
          () => {
            loading = false;
            failed = true;
          },
        );
      });
    };
    tryStart();
    // A page left open across the server's "off" (or a long night in the background) checks again when it comes back.
    const onVisible = () => {
      if (document.visibilityState === 'visible') tryStart();
    };
    document.addEventListener('visibilitychange', onVisible, { passive: true });
    return () => {
      live = false;
      cancel?.();
      document.removeEventListener('visibilitychange', onVisible);
      handle.current?.stop();
      handle.current = null;
    };
  }, [store]);

  useEffect(() => {
    current.current = { name: view.name, filter };
    handle.current?.view(current.current);
  }, [view.name, filter]);
}
