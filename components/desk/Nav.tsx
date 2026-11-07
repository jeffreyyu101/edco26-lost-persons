'use client';
// Sidebar (from 1280 px) and icon rail (768–1279), design/screens/desktop-log.html .side and
// desktop-new-tablet.html .rl. Both render; CSS shows one. At the top, the compact logo lockup (EDC Orlando |
// Ground Control, the brand card's colours) with the live dot; then views with live counts, a divider, Dashboard;
// at the bottom the Alerts row (it opens the Alerts sheet, F4) and the signed-in person with the phone's
// account menu (with "Show header" on All requests while its brand row is hidden, as on the phone). F4 adds
// Activity under the views, with the bell's unread count; it opens the top bar's Activity popover. Rail icons
// show their label as a tooltip on hover and keyboard focus.
import { ChartColumn, ChevronDown, Inbox, List, UserRound, type LucideIcon } from 'lucide-react';
import { AccountMenu } from '@/components/account/AccountMenu';
import { ActivityNavItemSlot, DeskAlertsRowSlot, DeskRailActivitySlot, DeskRailAlertsSlot } from '@/components/activity/slots';
import { PendingDot } from '@/components/messages/CardActivity';
import { useActions, usePrefs, useCounts, useIsLoading, useSession } from '@/lib/client/store-contract';
import { teamShort } from '@/lib/domain';
import { LiveMark, Tip, ViewLink } from './parts';
import { NAV_LABEL, NAV_PARAMS, navKeyOf, type NavKey } from './nav-model';
import type { MainView } from './views';
import d from './desk.module.css';

const ICONS: Readonly<Record<NavKey, LucideIcon>> = {
  all: List,
  pending: Inbox,
  mine: UserRound,
  dashboard: ChartColumn,
};

const VIEW_KEYS = ['all', 'pending', 'mine'] as const;

export interface DeskNavProps {
  /** The view in the main column. */
  main: MainView;
}

/**
 * "Show header" in the account menu: on All requests while its brand row is hidden on this device, it brings
 * the row back, at the top of the page where it is (as the phone's menu does).
 */
function useShowHeader(main: MainView): (() => void) | undefined {
  const prefs = usePrefs();
  const actions = useActions();
  if (main.name !== 'all' || !prefs.brandHidden) return undefined;
  return () => {
    actions.setPref('brandHidden', false);
    window.scrollTo(0, 0);
  };
}

export function DeskNav({ main }: DeskNavProps) {
  return (
    <>
      <Sidebar main={main} />
      <Rail main={main} />
    </>
  );
}

function Sidebar({ main }: DeskNavProps) {
  const active = navKeyOf(main);
  const counts = useCounts();
  const loading = useIsLoading();
  const showHeader = useShowHeader(main);
  return (
    <div className={d.side} data-testid="desk-sidebar">
      <div className={d.brand}>
        <LiveMark variant="side" />
      </div>
      <nav className={d.views} aria-label="Views">
        {VIEW_KEYS.map((k) => {
          const Icon = ICONS[k];
          return (
            <ViewLink key={k} params={NAV_PARAMS[k]} current={active === k} className={d.ni}>
              <Icon size={16} strokeWidth={1.75} aria-hidden />
              <span className={d.nl}>{NAV_LABEL[k]}</span>{' '}
              {loading ? null : <span className={d.nc}>{counts[k]}</span>}
              {/* F3: a dot while a Pending request has unread messages (after the count: "Pending 4", then the dot). */}
              {k === 'pending' ? <PendingDot /> : null}
            </ViewLink>
          );
        })}
        <ActivityNavItemSlot />
        <span className={d.sep} aria-hidden />
        <ViewLink params={NAV_PARAMS.dashboard} current={active === 'dashboard'} className={d.ni}>
          <ChartColumn size={16} strokeWidth={1.75} aria-hidden />
          <span className={d.nl}>{NAV_LABEL.dashboard}</span>
        </ViewLink>
      </nav>
      <span className={d.sp} />
      <DeskAlertsRowSlot />
      <Person onShowHeader={showHeader} />
    </div>
  );
}

/** Avatar, name and team; the phone's account menu opens from anywhere on the row. */
function Person({ onShowHeader }: { onShowHeader: (() => void) | undefined }) {
  const session = useSession();
  const prefs = usePrefs();
  const name = session.staffName ?? prefs.rememberedName ?? '';
  const team = session.team ?? prefs.rememberedTeam ?? '';
  return (
    <div className={d.me}>
      <AccountMenu size="2" onShowHeader={onShowHeader} />
      <span className={d.mt} aria-hidden>
        <span className={d.mn}>{name || 'Signed in'}</span>
        {team ? <span className={d.mteam}>{teamShort(team)}</span> : null}
      </span>
      <ChevronDown size={14} strokeWidth={1.75} className={d.mchev} aria-hidden />
    </div>
  );
}

function Rail({ main }: DeskNavProps) {
  const active = navKeyOf(main);
  const counts = useCounts();
  const loading = useIsLoading();
  const showHeader = useShowHeader(main);
  const pending = loading ? 0 : counts.pending;
  const item = (k: NavKey) => {
    const Icon = ICONS[k];
    const badge = k === 'pending' && pending > 0 ? pending : null;
    return (
      <ViewLink key={k} params={NAV_PARAMS[k]} current={active === k} className={`${d.ri} lp-hit`} label={badge === null ? NAV_LABEL[k] : `${NAV_LABEL[k]} ${badge}`}>
        <Icon size={19} strokeWidth={1.75} aria-hidden />
        {k === 'pending' ? <PendingDot rail /> : null}
        {badge === null ? null : (
          <span className={d.bd} aria-hidden>
            {badge > 99 ? '99+' : badge}
          </span>
        )}
        <Tip>{NAV_LABEL[k]}</Tip>
      </ViewLink>
    );
  };
  return (
    <div className={d.rail} data-testid="desk-rail">
      <LiveMark variant="rail" className={d.railMark} />
      <nav className={d.railViews} aria-label="Views">
        {VIEW_KEYS.map(item)}
        <DeskRailActivitySlot />
        <span className={d.railSep} aria-hidden />
        {item('dashboard')}
      </nav>
      <span className={d.sp} />
      <DeskRailAlertsSlot />
      <div className={d.railMe}>
        <AccountMenu size="2" onShowHeader={showHeader} />
      </div>
    </div>
  );
}
