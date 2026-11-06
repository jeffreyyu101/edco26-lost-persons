'use client';
// Avatar + account menu (design/screens/states.html "Avatar"): name and short team, Theme (Light / Dark /
// Auto), Alerts (On / Off: the new-request alerts the header bell used to toggle, 2026-11-06 header
// declutter), Show header (only on All requests while its brand row is hidden, v2.2), Dashboard, Sign out, and
// "Built by Jeffrey Yu". Export CSV is no longer offered to staff (Jeffrey exports from Supabase at the end,
// docs/export.sql).
// Self-contained: reads the store. Sign out is refused by the store while unsent outbox jobs exist; the
// menu then asks once, and only an explicit "Discard & sign out" throws them away. When the server can't
// confirm the sign-out (no signal), the store keeps the session and the menu or dialog says so.
//
// A Radix Popover rather than a DropdownMenu: the Theme segmented control must stay reachable with Tab,
// which a menu's roving focus does not allow.
import { AlertDialog, Avatar, Button, Popover, SegmentedControl, Text } from '@radix-ui/themes';
import { BellOff, BellRing, ChartColumn, Eye, LogOut, Sun } from 'lucide-react';
import { useId, useState } from 'react';
import { BellSheet, isStandalone } from '@/components/list/BellSheet';
import { navigate } from '@/lib/client/nav';
import { useActions, usePrefs, useSession, type ThemePref } from '@/lib/client/store-contract';
import { avatarInitials, teamShort } from '@/lib/domain';
import s from './account.module.css';

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

export function AccountMenu({ size = '2', onShowHeader }: AccountMenuProps) {
  const session = useSession();
  const prefs = usePrefs();
  const actions = useActions();
  const [open, setOpen] = useState(false);
  const [unsent, setUnsent] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bellSheet, setBellSheet] = useState({ open: false, standalone: false });
  const themeLabelId = useId();

  // Offline the session may not be confirmed yet: fall back to who signed in last on this phone.
  const name = session.staffName ?? prefs.rememberedName ?? '';
  const team = session.team ?? prefs.rememberedTeam ?? '';
  const initials = avatarInitials(name) || '?';

  // Exactly what the header bell did: flip the pref; the first time it goes on, "Alerts are on" explains
  // where alerts show (and the Home Screen tip).
  const toggleAlerts = () => {
    const on = !prefs.bell;
    actions.setPref('bell', on);
    if (on && !prefs.bellIntroSeen) {
      actions.setPref('bellIntroSeen', true);
      setOpen(false);
      setBellSheet({ open: true, standalone: isStandalone() });
    }
  };

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
          {/* A switch named "Alerts"; its state is announced, so the visible On / Off is not read twice. */}
          <button
            type="button"
            role="switch"
            aria-checked={prefs.bell}
            className={s.mitem}
            onClick={toggleAlerts}
            data-testid="alerts-switch"
          >
            {prefs.bell ? <BellRing size={16} aria-hidden /> : <BellOff size={16} aria-hidden />}
            <span className={s.sp}>Alerts</span>
            <span className={s.mval} data-on={prefs.bell ? '' : undefined} aria-hidden>
              {prefs.bell ? 'On' : 'Off'}
            </span>
          </button>
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

      <BellSheet
        open={bellSheet.open}
        standalone={bellSheet.standalone}
        onOpenChange={(o) => setBellSheet((b) => ({ ...b, open: o }))}
      />
    </>
  );
}
