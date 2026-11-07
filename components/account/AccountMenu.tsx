'use client';
// Avatar + account menu (design/screens/states.html "Avatar"): name and short team, Theme (Light / Dark /
// Auto), Alerts (this device's lock-screen alerts, On / Off / Blocked; it opens the Alerts sheet with the
// "New requests" and "Updates on my requests" switches and the device state, F4), Dashboard, Sign out, and
// "Built by Jeffrey Yu". Where this device has no Web Push but the page can notify while open (v2.5 A52),
// the system-notification row stays under Alerts ("Allow notifications", "System notifications on",
// "Blocked in browser"). Export CSV is no longer offered to staff (Jeffrey exports from Supabase at the end,
// docs/export.sql).
// Self-contained: reads the store. Sign out is refused by the store while unsent outbox jobs exist; the
// menu then asks once, and only an explicit "Discard & sign out" throws them away. When the server can't
// confirm the sign-out (no signal), the store keeps the session and the menu or dialog says so.
//
// A Radix Popover rather than a DropdownMenu: the Theme segmented control must stay reachable with Tab,
// which a menu's roving focus does not allow.
import { AlertDialog, Avatar, Button, Popover, SegmentedControl, Text, VisuallyHidden } from '@radix-ui/themes';
import { BellDot, BellOff, BellPlus, BellRing, ChartColumn, LogOut, Sun } from 'lucide-react';
import { useId, useState } from 'react';
import { alertsValue } from '@/components/alerts/AlertsSheet';
import { usePushStarted } from '@/components/alerts/AlertsBanner';
import { openAlertsSheet } from '@/lib/client/alerts-ui';
import { navigate } from '@/lib/client/nav';
import { NOTIFY_COPY } from '@/components/ui/NotifyStatus';
import { useAlerts } from '@/lib/client/push-client';
import { useActions, usePrefs, useSession, type ThemePref } from '@/lib/client/store-contract';
import { askNotifyPermission, useNotifyState, type NotifyState } from '@/lib/client/system-notify';
import { avatarInitials, teamShort } from '@/lib/domain';
import s from './account.module.css';

export interface AccountMenuProps {
  /** Radix avatar size for the trigger (header uses "2"). */
  size?: '2' | '3';
}

const THEMES: ReadonlyArray<[ThemePref, string]> = [
  ['light', 'Light'],
  ['dark', 'Dark'],
  ['auto', 'Auto'],
];

const isTheme = (v: string): v is ThemePref => v === 'light' || v === 'dark' || v === 'auto';

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

export function AccountMenu({ size = '2' }: AccountMenuProps) {
  const session = useSession();
  const prefs = usePrefs();
  const actions = useActions();
  usePushStarted();
  const alerts = useAlerts();
  const notify = useNotifyState();
  const [open, setOpen] = useState(false);
  const [unsent, setUnsent] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const themeLabelId = useId();
  const alertsOn = alerts.status === 'on';
  const alertsShown = alertsValue(alerts.status);

  // Offline the session may not be confirmed yet: fall back to who signed in last on this phone.
  const name = session.staffName ?? prefs.rememberedName ?? '';
  const team = session.team ?? prefs.rememberedTeam ?? '';
  const initials = avatarInitials(name) || '?';

  const signOut = async (discardOutbox: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const result = await actions.signOut(discardOutbox ? { discardOutbox: true } : undefined);
      if (result.ok) {
        // The store has already started the full navigation to /signin (replace: Back can't return here).
        setOpen(false);
        setUnsent(null);
        return;
      }
      if (result.reason === 'failed') {
        // Still signed in: shown where the tap was (the menu, or the discard dialog).
        setError(result.message);
        return;
      }
      setOpen(false);
      setUnsent(result.count);
    } catch {
      setError("Couldn't sign out — check signal and try again");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Popover.Root
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (o) setError(null);
        }}
      >
        <Popover.Trigger>
          {/* The name starts with the initials the avatar shows (WCAG 2.5.3): "DK, account: Dana Kim". */}
          <button
            type="button"
            className={s.trigger}
            aria-label={name ? `${initials}, account: ${name}` : 'Account'}
            data-testid="account-trigger"
          >
            <Avatar size={size} radius="full" variant="solid" color="gray" highContrast fallback={initials} />
          </button>
        </Popover.Trigger>
        <Popover.Content align="end" sideOffset={8} width="262px" maxWidth="calc(100vw - 24px)" className={s.menu} aria-label="Account">
          <div className={s.mhead}>
            <Avatar size="3" radius="full" variant="solid" color="gray" highContrast fallback={initials} />
            <div>
              <Text as="div" size="3" weight="medium">
                {name || 'Signed in'}
              </Text>
              {team ? (
                <Text as="div" size="2" color="gray">
                  {teamShort(team)}
                </Text>
              ) : null}
            </div>
          </div>
          <div className={s.msep} />
          <div className={`${s.mitem} ${s.static}`}>
            <Sun size={16} aria-hidden />
            <span className={s.sp} id={themeLabelId}>
              Theme
            </span>
            <SegmentedControl.Root
              size="1"
              value={prefs.theme}
              onValueChange={(v) => {
                if (isTheme(v)) actions.setPref('theme', v);
              }}
              aria-labelledby={themeLabelId}
            >
              {THEMES.map(([value, label]) => (
                <SegmentedControl.Item key={value} value={value} className="lp-hit">
                  {label}
                </SegmentedControl.Item>
              ))}
            </SegmentedControl.Root>
          </div>
          {/* Opens the Alerts sheet (F4). Named by what it shows: "Alerts Off" (WCAG 2.5.3). */}
          <button
            type="button"
            className={s.mitem}
            aria-haspopup="dialog"
            onClick={() => {
              setOpen(false);
              openAlertsSheet();
            }}
            data-testid="alerts-menu"
          >
            {alertsOn ? <BellRing size={16} aria-hidden /> : <BellOff size={16} aria-hidden />}
            <span className={s.sp}>Alerts</span>{' '}
            {alertsShown ? (
              <span className={s.mval} data-on={alertsOn ? '' : undefined}>
                {alertsShown}
              </span>
            ) : null}
          </button>
          {alerts.status === 'unsupported' && notify.supported ? <NotifyItem state={notify} /> : null}
          <button
            type="button"
            className={s.mitem}
            onClick={() => {
              setOpen(false);
              navigate({ dashboard: true });
            }}
          >
            <ChartColumn size={16} aria-hidden />
            Dashboard
          </button>
          <div className={s.msep} />
          <button type="button" className={s.mitem} disabled={busy} onClick={() => void signOut(false)}>
            <LogOut size={16} aria-hidden />
            Sign out
          </button>
          {error ? (
            <Text as="p" size="1" color="red" role="alert" className={s.mfoot}>
              {error}
            </Text>
          ) : null}
          <div className={s.msep} />
          <Text as="div" size="1" color="gray" className={s.mfoot}>
            Built by Jeffrey Yu
          </Text>
        </Popover.Content>
      </Popover.Root>

      <AlertDialog.Root
        open={unsent !== null}
        onOpenChange={(o) => {
          if (!o && !busy) {
            setUnsent(null);
            setError(null);
          }
        }}
      >
        <AlertDialog.Content maxWidth="342px" style={{ padding: 20 }} aria-describedby={undefined}>
          <AlertDialog.Title size="4" weight="medium" mb="0">
            {unsent === 1 ? '1 request not sent' : `${unsent ?? 0} requests not sent`}
          </AlertDialog.Title>
          {error ? (
            <Text as="p" size="2" color="red" role="alert" mt="2" mb="0">
              {error}
            </Text>
          ) : null}
          <div className={s.btns}>
            <AlertDialog.Cancel>
              <Button size="3" variant="soft" color="gray" disabled={busy}>
                Keep
              </Button>
            </AlertDialog.Cancel>
            <Button size="3" color="red" className="lp-solid-accent" loading={busy} onClick={() => void signOut(true)}>
              Discard &amp; sign out
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Root>

    </>
  );
}
