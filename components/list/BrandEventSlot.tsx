'use client';
// (Events) The brand row's event parts (BrandEvent.tsx: the event logo and its dates), loaded after the first paint: the
// server draws the row without them (it knows no event), so they cost the first load nothing.
import dynamic from 'next/dynamic';

export const BrandEventLogoSlot = dynamic(() => import('./BrandEvent').then((m) => m.BrandEventLogo), { ssr: false });
export const BrandEventDatesSlot = dynamic(() => import('./BrandEvent').then((m) => m.BrandEventDates), { ssr: false });
