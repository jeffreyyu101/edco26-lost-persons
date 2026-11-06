import type { Metadata } from 'next';
import { SignInFlow } from '@/components/signin/SignInFlow';
import { safeNextPath } from '@/lib/safe-next';

export const metadata: Metadata = { title: 'Sign in · Is my friend in medical?' };

// Placeholder route (Phase 1a). B (Phase 2) owns components/signin/**; this page only validates ?next=.
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = typeof params.next === 'string' ? safeNextPath(params.next) : null;
  return <SignInFlow next={next} />;
}
