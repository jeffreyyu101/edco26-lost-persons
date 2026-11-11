'use client';
// (Phase 3) The alerts reminder's slot in the views (components/list/ListViews.tsx, the desk table views): the box this
// device showed last holds the banner's place while F4's chunk loads (banner-place.tsx), so a cold load doesn't move the
// list. React.lazy, not next/dynamic: the place depends on where the slot is. Its own module, imported only by the view
// chunks, so none of it is in the first load.
import { Suspense, lazy } from 'react';
import { BannerPlace, type BannerPlaceName } from './banner-place';

const AlertsBannerLazy = lazy(() => import('@/components/activity/F4Parts').then((m) => ({ default: m.AlertsBanner })));

export function AlertsBannerSlot({ place }: { place: BannerPlaceName }) {
  // Client only, like next/dynamic's ssr: false (the views are never rendered on the server; a server render, as in
  // the unit tests, gets nothing here).
  if (typeof window === 'undefined') return null;
  return (
    <Suspense fallback={<BannerPlace place={place} />}>
      <AlertsBannerLazy place={place} />
    </Suspense>
  );
}
