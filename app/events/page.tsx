import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { connection } from 'next/server';
import { LeadEntry } from '@/components/events/LeadEntry';
import { SESSION_COOKIE, sessionSecretFromEnv, verifySessionToken } from '@/lib/server/session-token';

export const metadata: Metadata = { title: 'Events · Is my friend in medical?' };

// /events (Events, design/screens/events-v1-a): where a Ground Control lead lands and picks, creates or sets up an
// event. Its own route, so `/`'s bundle is untouched. Leads only: staff go to their event's log, no session to
// sign-in. Every lead route checks the role again (403 for staff).
export default async function EventsPage() {
  await connection();
  const claims = await verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value, sessionSecretFromEnv());
  if (!claims) redirect('/signin?next=/events');
  if (claims.role !== 'lead') redirect('/');
  return <LeadEntry screen={{ kind: 'list' }} />;
}
