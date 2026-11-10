import type { Metadata } from 'next';
import { preload } from 'react-dom';
import { SignInFlow } from '@/components/signin/SignInFlow';
import { signInTeams } from '@/lib/server/events';
import { safeNextPath } from '@/lib/safe-next';

export const metadata: Metadata = { title: 'Sign in · Is my friend in medical?' };

// /signin (spec §8). The proxy sends signed-in visitors on to `next` (not to /signin?ended=1: the Ended screen); this
// page validates ?next= (same-origin paths only), reads the team cards (every running event's teams: a password says
// which event it is only once it signs in) and renders the flow, which picks its step on the client.
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = typeof params.next === 'string' ? safeNextPath(params.next) : null;
  const ended = params.ended === '1';
  // The steps mount after hydration; fetch the logo meanwhile so it doesn't pop in.
  preload('/logos/ground-control.png', { as: 'image' });
  return <SignInFlow next={next} teams={ended ? [] : await signInTeams()} ended={ended} />;
}
