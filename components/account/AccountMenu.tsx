'use client';
// Avatar + account menu (design/screens/states.html "Avatar"): name and short team, Theme (Light / Dark /
// Auto), Alerts (this device's lock-screen alerts, On / Off / Blocked; it opens the Alerts sheet with the
// "New requests" and "Updates on my requests" switches and the device state, F4), Show header (only on All
// requests while its brand row is hidden, v2.2), Dashboard, Sign out, and "Built by Jeffrey Yu". Where this
// device has no Web Push but the page can notify while open (v2.5 A52), the system-notification row stays
// under Alerts ("Allow notifications", "System notifications on", "Blocked in browser"). Export CSV is no
// longer offered to staff (Jeffrey exports from Supabase at the end, docs/export.sql).
// Self-contained: reads the store. Sign out is refused by the store while unsent outbox jobs exist; the
// menu then asks once, and only an explicit "Discard & sign out" throws them away. When the server can't
// confirm the sign-out (no signal), the store keeps the session and the menu or dialog says so.
//
// A Radix Popover rather than a DropdownMenu: the Theme segmented control must stay reachable with Tab,
// which a menu's roving focus does not allow.
import { AlertDialog, Avatar, Button, Popover, SegmentedControl, Text } from '@radix-ui/themes';
import { ChartColumn, Eye, LogOut, Sun } from 'lucide-react';
import { useId, useState } from 'react';
import { AccountAlertsRowSlot } from '@/components/activity/slots';
import { navigate } from '@/lib/client/nav';
import { useActions, usePrefs, useSession, type ThemePref } from '@/lib/client/store-contract';
import { avatarInitials, teamShort } from '@/lib/domain';
import s from './account.module.css';
import { useEventConfig } from '@/lib/client/event-config';

export interface AccountMenuProps {
  /** Radix avatar size for the trigger (header uses "2"). */
  size?: '2' | '3';
  /** Set while the brand row is hidden on this view: the menu offers "Show header", which calls it. */
  onShowHeader?: () => void;
}

const THEMES: ReadonlyArray<[ThemePref, string]> = [
  ['light', 'Light'],
  ['dark', 'Dark'],
  ['auto', 'Auto'],
];

const isTheme = (v: string): v is ThemePref => v === 'light' || v === 'dark' || v === 'auto';

/** "2 requests not sent", "1 message not sent", "1 request and 2 messages not sent" (F3: messages queue too). */
function unsentTitle(unsent: { requests: number; messages: number } | null): string {
  const n = unsent ?? { requests: 0, messages: 0 };
  const parts = [
    n.requests > 0 || n.messages === 0 ? (n.requests === 1 ? '1 request' : `${n.requests} requests`) : null,
    n.messages > 0 ? (n.messages === 1 ? '1 message' : `${n.messages} messages`) : null,
  ].filter(Boolean);
  return `${parts.join(' and ')} not sent`;
}

export function AccountMenu({ size = '2', onShowHeader }: AccountMenuProps) {
  const session = useSession();
  const prefs = usePrefs();
  const actions = useActions();
  const [open, setOpen] = useState(false);
  const [unsent, setUnsent] = useState<{ requests: number; messages: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const themeLabelId = useId();

  // Offline the session may not be confirmed yet: fall back to who signed in last on this phone.
  const name = session.staffName ?? prefs.rememberedName ?? '';
  const team = session.team ?? prefs.rememberedTeam ?? '';
  const event = useEventConfig();
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
      setUnsent({ requests: result.count, messages: result.messages ?? 0 });
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
                  {teamShort(team, event?.teams)}
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
          {/* Alerts (F4): opens the Alerts sheet; "Allow notifications" where the device has no Web Push. */}
          <AccountAlertsRowSlot onOpen={() => setOpen(false)} />
          {onShowHeader ? (
            <button
              type="button"
              className={s.mitem}
              onClick={() => {
                setOpen(false);
                onShowHeader();
              }}
              data-testid="show-header"
            >
              <Eye size={16} aria-hidden />
              Show header
            </button>
          ) : null}
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
            {unsentTitle(unsent)}
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
