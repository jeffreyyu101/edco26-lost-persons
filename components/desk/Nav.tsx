'use client';
// The desk sidebar, from 768 px: shadcn/ui's Sidebar (collapsible="icon", variant="inset") in Radix Themes tokens,
// design/screens/desktop-sidebar-inset.html (Brian 2026-11-08). One component replaced the 232 px sidebar and the
// 60 px icon rail: 256 px with labels and counts, or 64 px of icons with the label as a tooltip. Expanded from
// 1280 px, collapsed below, until someone toggles it (the top bar's button, the sidebar's edge, Cmd+B / Ctrl+B);
// where an expanded sidebar would squeeze the list and an open request it opens over them instead, with a scrim
// (./sidebar-model.ts, ./sidebar-state.ts).
//
// Header: the logo lockup (EDC Orlando | Ground Control, the brand card's colours) with the live dot; tap syncs.
// Content: the views with live counts (hidden while loading), Pending's unread-messages bubble, F4's Activity (it
// opens the top bar's Activity popover), a separator, Dashboard, and Health (the in-house telemetry's page, its own
// route) only on a device that has opened /health once (localStorage lp-health): floor staff never see it.
// Footer: Alerts (its switch shows this computer's alerts; the row opens the Alerts sheet) and the signed-in
// person with the phone's account menu (with "Show header" on All requests while its brand row is hidden).
import { Activity, ChartColumn, ChevronsUpDown, Inbox, List, UserRound, type LucideIcon } from 'lucide-react';
import { useEffect, useSyncExternalStore } from 'react';
import { AccountMenu } from '@/components/account/AccountMenu';
import { DeskAlertsRowSlot } from '@/components/activity/slots';
import { DeskEventLink, EventSwitcher, useIsLeadInEvent } from '@/components/events/LeadNav';
import { PendingDot } from '@/components/messages/CardActivity';
import { useActions, usePrefs, useCounts, useIsLoading, useSession } from '@/lib/client/store-contract';
import { teamShort } from '@/lib/domain';
import { LiveMark, Tip, ViewLink } from './parts';
import { NAV_LABEL, NAV_PARAMS, navKeyOf, type NavKey } from './nav-model';
import { SIDEBAR_ID } from './sidebar-model';
import { closeSidebarOverlay, toggleSidebar, useSidebar } from './sidebar-state';
import type { MainView } from './views';
import d from './desk.module.css';

const ICONS: Readonly<Record<NavKey, LucideIcon>> = {
  all: List,
  pending: Inbox,
  mine: UserRound,
  dashboard: ChartColumn,
};

const VIEW_KEYS = ['all', 'pending', 'mine'] as const;

const noSubscribe = () => () => undefined;
function healthSeen(): boolean {
  try {
    return window.localStorage.getItem('lp-health') === '1';
  } catch {
    return false;
  }
}
/** The Health link shows on a device that has opened /health once (false on the server and in hydration). */
function useHealthLink(): boolean {
  return useSyncExternalStore(noSubscribe, healthSeen, () => false);
}

export interface DeskNavProps {
  /** The view in the main column. */
  main: MainView;
  /** A request is open in the pane (where an expanded sidebar would not fit beside it, it opens over it). */
  pane?: boolean;
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

export function DeskNav({ main, pane = false }: DeskNavProps) {
  const sidebar = useSidebar(pane);
  const health = useHealthLink();
  const active = navKeyOf(main);
  const counts = useCounts();
  const loading = useIsLoading();
  const showHeader = useShowHeader(main);
  const lead = useIsLeadInEvent();

  // Open over the content until the address changes (a view chosen, a request or a form opened) or the sidebar
  // docks (a wider window, the request closed): then it is closed for good, not waiting to come back.
  useEffect(() => {
    if (!sidebar.overlay) closeSidebarOverlay();
  });

  const item = (k: NavKey) => {
    const Icon = ICONS[k];
    const count = k === 'dashboard' || loading ? null : counts[k];
    return (
      <ViewLink key={k} params={NAV_PARAMS[k]} current={active === k} className={d.item}>
        <Icon size={16} strokeWidth={1.75} aria-hidden />
        <span className={d.label}>{NAV_LABEL[k]}</span>
        {count === null ? null : (
          <>
            {' '}
            <span className={d.badge}>{count}</span>
          </>
        )}
        {/* F3, message lane: the filled bubble while a Pending request has unread messages, right after the label
            (read after the count: "Pending 4 Unread messages"); a dot on the icon while collapsed. */}
        {k === 'pending' ? <PendingDot /> : null}
        <Tip>{NAV_LABEL[k]}</Tip>
      </ViewLink>
    );
  };

  return (
    <>
      <div
        id={SIDEBAR_ID}
        className={d.sidebar}
        data-testid="desk-sidebar"
        data-state={sidebar.expanded ? 'expanded' : 'collapsed'}
        data-overlay={sidebar.overlay ? '' : undefined}
      >
        <div className={d.sideHead}>
          <LiveMark />
          {lead ? <EventSwitcher /> : null}
        </div>
        <nav className={d.sideContent} aria-label="Views">
          <div className={d.group}>
            <div className={d.menu}>
              {VIEW_KEYS.map(item)}
            </div>
          </div>
          <span className={d.sep} aria-hidden />
          <div className={`${d.group} ${d.groupNext}`}>
            <div className={d.menu}>
              {item('dashboard')}
              {/* (Events) A lead's setup of the open event (its own route). */}
              <DeskEventLink className={d.item} labelClassName={d.label} tip={<Tip>Event</Tip>} />
              {health ? (
                // A plain link: /health is its own route.
                <a href="/health" className={d.item} data-testid="desk-health">
                  <Activity size={16} strokeWidth={1.75} aria-hidden />
                  <span className={d.label}>Health</span>
                  <Tip>Health</Tip>
                </a>
              ) : null}
            </div>
          </div>
        </nav>
        <div className={d.sideFoot}>
          <div className={d.menu}>
            <DeskAlertsRowSlot />
            <Person onShowHeader={showHeader} />
          </div>
        </div>
        {/* The sidebar's edge (shadcn SidebarRail): a click toggles it. A pointer shortcut only: keyboards have the
            top bar's button and Cmd+B, so it is out of the tab order and hidden from assistive tech. */}
        <button type="button" className={d.rail} tabIndex={-1} aria-hidden onClick={toggleSidebar} data-testid="desk-sidebar-rail" />
      </div>
      {sidebar.overlay ? <div className={d.scrim} aria-hidden onClick={closeSidebarOverlay} data-testid="desk-sidebar-scrim" /> : null}
    </>
  );
}

/** Avatar, name and team; the phone's account menu opens from anywhere on the row. */
function Person({ onShowHeader }: { onShowHeader: (() => void) | undefined }) {
  const session = useSession();
  const prefs = usePrefs();
  const name = session.staffName ?? prefs.rememberedName ?? '';
  const team = session.team ?? prefs.rememberedTeam ?? '';
  return (
    <div className={d.person}>
      <AccountMenu size="2" onShowHeader={onShowHeader} />
      <span className={d.personText} aria-hidden>
        <span className={d.personName}>{name || 'Signed in'}</span>
        {team ? <span className={d.personTeam}>{teamShort(team)}</span> : null}
      </span>
      <ChevronsUpDown size={16} strokeWidth={1.75} className={d.personEnd} aria-hidden />
      <Tip>{name || 'Account'}</Tip>
    </div>
  );
}
