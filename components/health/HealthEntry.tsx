'use client';
// /health's client entry: it only loads the dashboard (HealthView, its own chunk) with a plain import(). The route's
// entry then shares no module with `/`'s first load beyond what /signin shares too: a page entry that used `/`'s icons
// or Radix parts directly made the bundler regroup `/`'s own first-load chunks (+320 B gzipped, over A25's 42 KB).
import { useEffect, useState, type ComponentType } from 'react';

export function HealthEntry({ lead, event }: { lead: boolean; event: string }) {
  const [View, setView] = useState<ComponentType<{ lead: boolean; event: string }> | null>(null);
  useEffect(() => {
    let live = true;
    import('./HealthView').then(
      (m) => {
        if (live) setView(() => m.HealthView);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  return View ? <View lead={lead} event={event} /> : <main style={{ minHeight: '100dvh' }} aria-busy="true" />;
}
