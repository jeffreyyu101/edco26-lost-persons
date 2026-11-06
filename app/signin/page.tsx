import type { Metadata } from 'next';
import { preload } from 'react-dom';
import { SignInFlow } from '@/components/signin/SignInFlow';
import { safeNextPath } from '@/lib/safe-next';

export const metadata: Metadata = { title: 'Sign in · Is my friend in medical?' };

// /signin (spec §8). The proxy sends signed-in visitors on to `next`; this page only validates ?next=
// (same-origin paths only) and renders the flow, which picks its step on the client.
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = typeof params.next === 'string' ? safeNextPath(params.next) : null;
  // The steps mount after hydration; fetch the logos meanwhile so they don't pop in.
  preload('/logos/edc-orlando.png', { as: 'image' });
  preload('/logos/ground-control.png', { as: 'image' });
  return <SignInFlow next={next} />;
}
