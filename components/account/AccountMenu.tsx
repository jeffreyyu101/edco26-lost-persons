'use client';
// Avatar + account menu (design/screens/states.html "Avatar"): name and short team, Theme (Light / Dark /
// Auto), Dashboard, Export CSV (a new tab in an iOS Home Screen app), Sign out, and "Built by Jeffrey Yu".
// Self-contained: reads the store. Sign out is refused by the store while unsent outbox jobs exist; the
// menu then asks once, and only an explicit "Discard & sign out" throws them away.
//
// A Radix Popover rather than a DropdownMenu: the Theme segmented control must stay reachable with Tab,
// which a menu's roving focus does not allow.
import { AlertDialog, Avatar, Button, Popover, SegmentedControl, Text } from '@radix-ui/themes';
import { ChartColumn, Download, LogOut, Sun } from 'lucide-react';
import { useId, useState } from 'react';
import { navigate } from '@/lib/client/nav';
import { useActions, useConnection, usePrefs, useSession, type ThemePref } from '@/lib/client/store-contract';
import { avatarInitials, teamShort } from '@/lib/domain';
import { EXPORT_CSV_PATH, handleExportClick } from './export-csv';
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

export function AccountMenu({ size = '2' }: AccountMenuProps) {
  const session = useSession();
  const prefs = usePrefs();
  const actions = useActions();
  const { connection } = useConnection();
  const [open, setOpen] = useState(false);
  const [unsent, setUnsent] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const themeLabelId = useId();

  // Offline the session may not be confirmed yet: fall back to who signed in last on this phone.
  const name = session.staffName ?? prefs.rememberedName ?? '';
  const team = session.team ?? prefs.rememberedTeam ?? '';
  const initials = avatarInitials(name) || '?';
  const offline = connection === 'offline';

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
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger>
          <button type="button" className={s.trigger} aria-label={name ? `Account: ${name}` : 'Account'} data-testid="account-trigger">
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
                <SegmentedControl.Item key={value} value={value}>
                  {label}
                </SegmentedControl.Item>
              ))}
            </SegmentedControl.Root>
          </div>
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
          {offline ? (
            <button type="button" className={s.mitem} disabled>
              <Download size={16} aria-hidden />
              Export CSV
            </button>
          ) : (
            <a
              className={s.mitem}
              href={EXPORT_CSV_PATH}
              download
              onClick={(e) => {
                handleExportClick(e);
                setOpen(false);
              }}
            >
              <Download size={16} aria-hidden />
              Export CSV
            </a>
          )}
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
          if (!o && !busy) setUnsent(null);
        }}
      >
        <AlertDialog.Content maxWidth="342px" style={{ padding: 20 }} aria-describedby={undefined}>
          <AlertDialog.Title size="4" weight="medium" mb="0">
            {unsent === 1 ? '1 request not sent' : `${unsent ?? 0} requests not sent`}
          </AlertDialog.Title>
          <div className={s.btns}>
            <AlertDialog.Cancel>
              <Button size="3" variant="soft" color="gray" disabled={busy}>
                Keep
              </Button>
            </AlertDialog.Cancel>
            <Button size="3" color="red" loading={busy} onClick={() => void signOut(true)}>
              Discard &amp; sign out
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </>
  );
}
