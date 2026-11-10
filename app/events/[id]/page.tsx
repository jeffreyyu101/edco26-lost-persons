import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { connection } from 'next/server';
import { LeadEntry } from '@/components/events/LeadEntry';
import { SESSION_COOKIE, sessionSecretFromEnv, verifySessionToken } from '@/lib/server/session-token';

export const metadata: Metadata = { title: 'Event · Is my friend in medical?' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// /events/new and /events/<id> (Event setup, design/screens/events-v2-b): one form for a new event and for an
// event's settings. Leads only (staff go to their log). `?from=app`: opened from the app's "Event" item, so Back
// returns there.
export default async function EventSetupPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ from?: string | string[] }> }) {
  await connection();
  const { id } = await params;
  const claims = await verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value, sessionSecretFromEnv());
  if (!claims) redirect(`/signin?next=${encodeURIComponent(`/events/${id}`)}`);
  if (claims.role !== 'lead') redirect('/');
  if (id !== 'new' && !UUID.test(id)) notFound();
  const from = (await searchParams).from;
  return <LeadEntry screen={{ kind: 'setup', id: id.toLowerCase(), fromApp: from === 'app' }} />;
}
