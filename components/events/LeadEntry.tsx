'use client';
// (Events, lead screens) The /events pages' client entry. It only loads the screen (its own chunk) with a plain
// import(), like /health's entry: nothing lead-only is bundled into `/`, and the store never starts here. It imports
// nothing `/` loads (not even lib/theme): a page entry sharing a module with `/`'s first load makes the bundler regroup
// `/`'s first-load chunks (bytes on every staff phone). The screens follow the system theme themselves.
import { useEffect, useState } from 'react';
import type { EventsScreen } from './EventsScreen';
import type { SetupScreen } from './SetupScreen';

export type LeadScreen = { kind: 'list' } | { kind: 'setup'; id: string; fromApp: boolean };

type Loaded = { list: typeof EventsScreen } | { setup: typeof SetupScreen };

export function LeadEntry({ screen }: { screen: LeadScreen }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const kind = screen.kind;
  useEffect(() => {
    let live = true;
    const load: Promise<Loaded> = kind === 'list' ? import('./EventsScreen').then((m) => ({ list: m.EventsScreen })) : import('./SetupScreen').then((m) => ({ setup: m.SetupScreen }));
    load.then(
      (m) => {
        if (live) setLoaded(m);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [kind]);
  if (loaded && 'list' in loaded) return <loaded.list />;
  if (loaded && 'setup' in loaded && screen.kind === 'setup') return <loaded.setup id={screen.id} fromApp={screen.fromApp} />;
  return <main style={{ minHeight: '100dvh' }} aria-busy="true" />;
}
