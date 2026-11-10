import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { connection } from 'next/server';
import { HealthEntry } from '@/components/health/HealthEntry';
import { SESSION_COOKIE, sessionSecretFromEnv, verifySessionToken } from '@/lib/server/session-token';

export const metadata: Metadata = { title: 'Health · Is my friend in medical?' };

// /health (design/references/observability-design.md §5): the in-house telemetry's dashboard, desktop only. Its own
// route, so `/`'s bundle and first load are untouched and the store never starts here (no sync loop). Any signed-in
// session may open it (the data has no personal details); without one it goes to sign-in and comes back.
export default async function HealthPage() {
  await connection();
  const claims = await verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value, sessionSecretFromEnv());
  if (!claims) redirect('/signin?next=/health');
  // (Events) Only a lead may switch collection off or back on (POST /api/telemetry/settings checks it too).
  return <HealthEntry lead={claims.role === 'lead'} />;
}
