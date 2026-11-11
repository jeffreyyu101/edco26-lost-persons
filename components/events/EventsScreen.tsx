'use client';
// (Events, lead screens) Events (design/screens/events-v1-a): where the Ground Control lead lands. Every event, live
// first, then practice, then archived (folded under "Archived N"), each with its logo, name, posts / open / logged,
// stage chip and dates. Opening one takes the lead into it (POST /api/session/event, then the app) with every staff
// ability. "New event" creates one. The lead passcode is changed from the account menu (top right).
import { Avatar, Button, Popover, SegmentedControl, Text, VisuallyHidden } from '@radix-ui/themes';
import { ChevronDown, KeyRound, LogOut, Plus, Sun } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import type { EventAdmin, SessionInfo } from '@/lib/api-types';
import { avatarInitials } from '@/lib/domain';
import { applyTheme, followSystemTheme, readThemeChoice, type ThemeChoice } from '@/lib/theme';
import { api, changeLeadPasscode, openEvent, signInAgain } from './api';
import { formatDates } from './format';
import { EventLogo, FieldError, STAGE_LABEL, StageChip } from './parts';
import { SecretSheet } from './SecretSheet';
import a from '@/components/account/account.module.css';
import s from './events.module.css';

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

export function EventsScreen() {
  const [events, setEvents] = useState<EventAdmin[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(true);
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const archivedId = useId();

  useEffect(() => followSystemTheme(), []);

  useEffect(() => {
    let live = true;
    void api.session().then((res) => {
      if (live && res.ok) setSession(res.data);
    });
    void api.list().then((res) => {
      if (!live) return;
      if (res.ok) setEvents(res.data.events);
      else if (res.status !== 401) setFailed(true);
    });
    return () => {
      live = false;
    };
  }, []);

  const running = (events ?? []).filter((e) => e.stage !== 'archived');
  const archived = (events ?? []).filter((e) => e.stage === 'archived');

  const open = async (e: EventAdmin) => {
    setOpening(e.id);
    setOpenError(null);
    const res = await openEvent(e.id);
    if (!res.ok) {
      setOpening(null);
      if (res.status !== 401) setOpenError(res.message);
    }
  };

  const row = (e: EventAdmin) => (
    <li key={e.id} className={s.row} data-stage={e.stage} data-testid="event-row" data-slug={e.slug}>
      <button
        type="button"
        className={s.rowBtn}
        onClick={() => void open(e)}
        aria-busy={opening === e.id}
        disabled={opening !== null}
      >
        <EventLogo name={e.name} logoUrl={e.logoUrl} size={44} />
        <span className={s.rowText}>
          <span className={s.rowName}>{e.name}</span>
          <VisuallyHidden>
            . {STAGE_LABEL[e.stage]}, {formatDates(e.startsOn, e.endsOn, true)}. {e.posts.length} {plural(e.posts.length, 'post')}, {e.open ?? 0} open, {e.requests ?? 0} logged.
          </VisuallyHidden>
          <span className={s.rowMeta} aria-hidden>
            <span>
              <b>{e.posts.length}</b> {plural(e.posts.length, 'post')}
            </span>
            <span className={s.sepDot}>•</span>
            <span>
              <b>{e.open ?? 0}</b> open
            </span>
            <span className={s.sepDot}>•</span>
            <span>
              <b>{e.requests ?? 0}</b> logged
            </span>
          </span>
        </span>
        <span className={s.rowEnd} aria-hidden>
          <StageChip stage={e.stage} />
          <span>{formatDates(e.startsOn, e.endsOn)}</span>
        </span>
      </button>
    </li>
  );

  return (
    <main className={s.screen} data-testid="events-screen">
      <header className={`${s.head} ${s.headList}`}>
        <div className={s.column} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h1 className={s.title}>Events</h1>
          <LeadAccount session={session} />
        </div>
      </header>
      <div className={s.column} style={{ flex: '1 0 auto', paddingBottom: 96 }}>
        {openError ? (
          <div style={{ padding: '0 16px' }}>
            <FieldError id="events-open-error">{openError}</FieldError>
          </div>
        ) : null}
        {events === null ? (
          <div className={s.center} aria-busy={!failed}>
            {failed ? "Couldn't load the events" : <VisuallyHidden>Loading</VisuallyHidden>}
          </div>
        ) : (
          <>
            <ul className={s.list} aria-label="Events" data-testid="events-running">
              {running.map(row)}
            </ul>
            {archived.length ? (
              <>
                <button type="button" className={s.section} aria-expanded={archivedOpen} aria-controls={archivedId} onClick={() => setArchivedOpen((v) => !v)} data-testid="events-archived-toggle">
                  Archived <span className={s.count}>{archived.length}</span>
                  <ChevronDown size={18} className={s.sectionChev} aria-hidden />
                </button>
                <ul className={s.list} id={archivedId} aria-label="Archived events" hidden={!archivedOpen} data-testid="events-archived">
                  {archived.map(row)}
                </ul>
              </>
            ) : null}
          </>
        )}
      </div>
      <Button asChild size="4" radius="full" highContrast className={s.fab}>
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- the setup page is its own entry */}
        <a href="/events/new" data-testid="events-new">
          <Plus size={20} aria-hidden />
          New event
        </a>
      </Button>
    </main>
  );
}

const THEMES: ReadonlyArray<[ThemeChoice, string]> = [
  ['light', 'Light'],
  ['dark', 'Dark'],
  ['auto', 'Auto'],
];

/** The lead's avatar and menu (the app's account menu, components/account): who is signed in, Theme, Lead passcode, Sign out. */
function LeadAccount({ session }: { session: SessionInfo | null }) {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeChoice>(() => (typeof window === 'undefined' ? 'auto' : readThemeChoice()));
  const [passcode, setPasscode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const themeLabel = useId();
  const name = session?.staffName ?? '';
  const initials = avatarInitials(name) || '?';

  const signOut = async () => {
    setBusy(true);
    setError(null);
    const res = await api.signOut();
    if (res.ok || res.status === 401) window.location.replace('/signin');
    else {
      setBusy(false);
      setError("Couldn't sign out — check signal and try again");
    }
  };

  const savePasscode = async (value: string): Promise<string | null> => {
    if (!session) return "Couldn't save. Try again";
    const out = await changeLeadPasscode(value, { staffName: session.staffName, team: session.team });
    if (out.ok) {
      setPasscode(false);
      return null;
    }
    if (out.signedOut) {
      signInAgain();
      return null;
    }
    return out.message;
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
          <button type="button" className={a.trigger} aria-label={name ? `${initials}, account: ${name}` : 'Account'} data-testid="lead-account">
            <Avatar size="3" radius="full" variant="solid" color="gray" highContrast fallback={initials} />
          </button>
        </Popover.Trigger>
        <Popover.Content align="end" sideOffset={8} width="262px" maxWidth="calc(100vw - 24px)" className={a.menu} aria-label="Account">
          <div className={a.mhead}>
            <Avatar size="3" radius="full" variant="solid" color="gray" highContrast fallback={initials} />
            <div>
              <Text as="div" size="3" weight="medium">
                {name || 'Signed in'}
              </Text>
              <Text as="div" size="2" color="gray">
                Lead
              </Text>
            </div>
          </div>
          <div className={a.msep} />
          <div className={`${a.mitem} ${a.static}`}>
            <Sun size={16} aria-hidden />
            <span className={a.sp} id={themeLabel}>
              Theme
            </span>
            <SegmentedControl.Root
              size="1"
              value={theme}
              aria-labelledby={themeLabel}
              onValueChange={(v) => {
                const t = v as ThemeChoice;
                setTheme(t);
                applyTheme(t);
              }}
            >
              {THEMES.map(([v, label]) => (
                <SegmentedControl.Item key={v} value={v} className="lp-hit">
                  {label}
                </SegmentedControl.Item>
              ))}
            </SegmentedControl.Root>
          </div>
          <button
            type="button"
            className={a.mitem}
            onClick={() => {
              setOpen(false);
              setPasscode(true);
            }}
            data-testid="lead-passcode"
          >
            <KeyRound size={16} aria-hidden />
            Lead passcode
          </button>
          <div className={a.msep} />
          <button type="button" className={a.mitem} disabled={busy} onClick={() => void signOut()} data-testid="lead-signout">
            <LogOut size={16} aria-hidden />
            Sign out
          </button>
          {error ? (
            <Text as="p" size="1" color="red" role="alert" className={a.mfoot}>
              {error}
            </Text>
          ) : null}
        </Popover.Content>
      </Popover.Root>
      {passcode ? <SecretSheet title="Lead passcode" label="Passcode" onSave={savePasscode} onClose={() => setPasscode(false)} testId="passcode-sheet" /> : null}
    </>
  );
}
