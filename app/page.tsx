import { connection } from 'next/server';
import { eventTimezone } from '@/lib/server/env';
import { AppShell } from './app-shell';

// The signed-in app is this one route (spec §7). The HTML is a shell with no data: every row is fetched by
// the client store, so the service worker can cache this page without PII.
export default async function Page() {
  await connection();
  return <AppShell eventTimezone={eventTimezone()} />;
}
