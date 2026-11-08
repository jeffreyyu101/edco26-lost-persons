'use client';
// Lazy slots for the F4 pieces (components/activity/F4Parts.tsx, one chunk). The views, the desk chrome, the
// account menu and the shell render these instead of importing the pieces, so their chunks (and the first
// load's map of them) don't carry the push and Activity code (spec A25). Client only, like every view.
import dynamic from 'next/dynamic';

const load = () => import('./F4Parts');

/** Holds the bell's 36 px place while the chunk loads (no shift in the header). */
const bellPlace = () => <span style={{ display: 'inline-block', width: 36, height: 36, flex: 'none' }} aria-hidden />;

export const ActivityBellSlot = dynamic(() => load().then((m) => m.ActivityBell), { ssr: false, loading: bellPlace });
export const AlertsBannerSlot = dynamic(() => load().then((m) => m.AlertsBanner), { ssr: false });
export const ActivityHostSlot = dynamic(() => load().then((m) => m.ActivityHost), { ssr: false });
export const AccountAlertsRowSlot = dynamic(() => load().then((m) => m.AccountAlertsRow), { ssr: false });
export const DeskActivitySlot = dynamic(() => load().then((m) => m.DeskActivityItem), { ssr: false });
export const DeskAlertsRowSlot = dynamic(() => load().then((m) => m.DeskAlertsRow), { ssr: false });
