import { connection } from 'next/server';
import { BrandCard } from '@/components/list/BrandCard';
import { eventTimezone } from '@/lib/server/env';
import { AppShell } from './app-shell';

// The signed-in app is this one route (spec §7). The HTML is a shell with no data: every row is fetched by
// the client store, so the service worker can cache this page without PII. The desk's brand card (no data
// either) is rendered here, on the server, so it adds nothing to the first-load JavaScript.
export default async function Page() {
  await connection();
  return <AppShell eventTimezone={eventTimezone()} brand={<BrandCard logoLoading="lazy" />} />;
}
