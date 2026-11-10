import { connection } from 'next/server';
import { BrandCard } from '@/components/list/BrandCard';
import { AppShell } from './app-shell';

// The signed-in app is this one route (spec §7). The HTML is a shell with no data: every row is fetched by
// the client store, so the service worker can cache this page without PII. The desk's brand card (no data
// either) is rendered here, on the server, so it adds nothing to the first-load JavaScript.
export default async function Page() {
  await connection();
  // (Events) The display time zone, posts, teams and logo are the signed-in event's config, which the store reads
  // (GET /api/session) and keeps on the device: nothing about any event is in this HTML.
  return <AppShell brand={<BrandCard logoLoading="lazy" />} />;
}
