'use client';
// Every F4 piece the list views, the desk chrome, the account menu and the shell show, in ONE chunk loaded
// through components/activity/slots.tsx. Kept out of the views' own chunks so the first load's chunk map
// does not list the push and Activity code for every view (spec A25 budget; F4 A53–A59).
import { VisuallyHidden } from '@radix-ui/themes';
import { BellDot, BellOff, BellPlus, BellRing } from 'lucide-react';
import accountStyles from '@/components/account/account.module.css';
import { usePushStarted } from '@/components/alerts/AlertsBanner';
import { alertsValue } from '@/components/alerts/AlertsSheet';
import deskStyles from '@/components/desk/desk.module.css';
import { Tip } from '@/components/desk/parts';
import { NOTIFY_COPY } from '@/components/ui/NotifyStatus';
import { badgeText } from '@/lib/activity';
import { activityClient, useActivity } from '@/lib/client/activity-client';
import { openAlertsSheet } from '@/lib/client/alerts-ui';
import { useAlerts } from '@/lib/client/push-client';
import { askNotifyPermission, useNotifyState, type NotifyState } from '@/lib/client/system-notify';
import { bellLabel } from './ActivityBell';
import { BellIcon } from './icons';

export { AlertsBanner } from '@/components/alerts/AlertsBanner';
export { ActivityBell, ActivityNavItem } from './ActivityBell';
export { ActivityHost } from './ActivityHost';

const s = accountStyles;
const d = deskStyles;

/** System notifications (v2.5 A52) where this device has no Web Push: every alert while the app is open. */
function NotifyItem({ state }: { state: NotifyState }) {
  if (state.permission === 'default') {
    return (
      // Called inside the tap: browsers only prompt for a user gesture.
      <button type="button" className={s.mitem} onClick={() => void askNotifyPermission()} data-testid="notify-allow">
        <BellPlus size={16} aria-hidden />
        {NOTIFY_COPY.allow}
      </button>
    );
  }
  const on = state.permission === 'granted';
  return (
    <div className={`${s.mitem} ${s.static} ${on ? '' : s.quiet}`} data-testid="notify-state" data-state={state.permission}>
      {on ? <BellDot size={16} aria-hidden /> : <BellOff size={16} aria-hidden />}
      {on ? (
        NOTIFY_COPY.on
      ) : (
        <>
          <span aria-hidden>{NOTIFY_COPY.blocked}</span>
          <VisuallyHidden>{NOTIFY_COPY.blockedFull}</VisuallyHidden>
        </>
      )}
    </div>
  );
}

/**
 * The account menu's Alerts row (it opens the Alerts sheet; named by what it shows, "Alerts Off", WCAG 2.5.3),
 * and, where this device has no Web Push but the page can notify while open, the system-notification row.
 */
export function AccountAlertsRow({ onOpen }: { onOpen: () => void }) {
  usePushStarted();
  const alerts = useAlerts();
  const notify = useNotifyState();
  const on = alerts.status === 'on';
  const value = alertsValue(alerts.status);
  return (
    <>
      <button
        type="button"
        className={s.mitem}
        aria-haspopup="dialog"
        onClick={() => {
          onOpen();
          openAlertsSheet();
        }}
        data-testid="alerts-menu"
      >
        {on ? <BellRing size={16} aria-hidden /> : <BellOff size={16} aria-hidden />}
        <span className={s.sp}>Alerts</span>{' '}
        {value ? (
          <span className={s.mval} data-on={on ? '' : undefined}>
            {value}
          </span>
        ) : null}
      </button>
      {alerts.status === 'unsupported' && notify.supported ? <NotifyItem state={notify} /> : null}
    </>
  );
}

/** The desk sidebar's Alerts row: this computer's alerts (On / Off / Blocked); it opens the Alerts sheet. */
export function DeskAlertsRow() {
  usePushStarted();
  const alerts = useAlerts();
  const on = alerts.status === 'on';
  const value = alertsValue(alerts.status);
  return (
    <button type="button" className={d.bell} aria-haspopup="dialog" data-on={on ? '' : undefined} onClick={openAlertsSheet} data-testid="desk-alerts">
      {on ? <BellRing size={16} strokeWidth={1.75} aria-hidden /> : <BellOff size={16} strokeWidth={1.75} aria-hidden />}
      {/* Named by what it shows: "Alerts On" (WCAG 2.5.3). */}
      <span className={d.nl}>Alerts</span>{' '}
      {value ? <span className={d.nc}>{value}</span> : null}
    </button>
  );
}

/** The rail's Alerts icon (opens the Alerts sheet; the name says this computer's state). */
export function DeskRailAlerts() {
  usePushStarted();
  const alerts = useAlerts();
  const value = alertsValue(alerts.status);
  return (
    <button
      type="button"
      className={`${d.ri} lp-hit`}
      aria-label={value ? `Alerts, ${value}` : 'Alerts'}
      aria-haspopup="dialog"
      data-on={alerts.status === 'on' ? '' : undefined}
      onClick={openAlertsSheet}
    >
      {alerts.status === 'on' ? <BellRing size={19} strokeWidth={1.75} aria-hidden /> : <BellOff size={19} strokeWidth={1.75} aria-hidden />}
      <Tip>Alerts</Tip>
    </button>
  );
}

/** The rail's Activity icon with the bell's count; it opens the top bar's popover. */
export function DeskRailActivity() {
  const activity = useActivity();
  const unread = badgeText(activity.unread);
  return (
    <button
      type="button"
      className={`${d.ri} lp-hit`}
      aria-label={bellLabel(activity.unread)}
      aria-haspopup="dialog"
      onClick={() => activityClient().setOpen(true)}
      data-testid="desk-rail-activity"
    >
      <BellIcon size={19} strokeWidth={1.75} />
      {unread ? (
        <span className={d.bd} aria-hidden>
          {unread}
        </span>
      ) : null}
      <Tip>Activity</Tip>
    </button>
  );
}
