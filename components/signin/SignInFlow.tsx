'use client';
// Sign-in (spec §8 Sign-in, design/screens/sign-in.html): step 1 name + team, step 2 the event password.
// From 768 px it is layout A of design/screens/desktop-sign-in.html: the same steps in a bordered card on the
// page canvas, with key caps and keyboard shortcuts (desktop.ts). The credit stays the last child of <main>.
// Remembered name and team skip to step 2 (so a session-expired redirect to /signin?next=… lands on step 2,
// prefilled). On success, go to `next` (already validated same-origin) or "/".
// Remembered identity and theme: lib/client/prefs.ts (this route has no StoreProvider). readPrefs() gives
// rememberedName / rememberedTeam (both or neither) to skip to step 2; after a successful POST
// /api/session call forgetBellForOtherStaff then writeRememberedIdentity(staffName, team) with the response;
// "Change" calls clearRememberedIdentity(); the theme toggle calls setThemePref(). Never pick other storage keys.
//
// The steps render only on the client: which step to show lives in localStorage, and rendering step 1 on the
// server would flash it (or accept typing that hydration then drops) for everyone who is remembered.
//
// Team join link (J1, lib/join-link.ts): with a code kept for this tab, step 1 is the only step. It opens
// even for a remembered identity (prefilled), and Continue signs in with POST /api/session {…, invite}. If
// the server refuses the code (401: wrong, expired or switched off), the code is forgotten and step 2 opens
// as it always does, with no message about the link. Too many attempts (429) says nothing about the code:
// it is kept, step 1 stays, "Too many attempts. Try again in N min" shows above Continue and Continue waits
// until then (as Sign in does). A dropped signal or a server error keeps the code and says so above
// Continue, which tries again. A link opened in a tab already on /signin only changes the fragment (no
// reload): the `hashchange` listener below picks the code up (JOIN_LINK_SCRIPT already kept it and cleared
// the address bar) and opens step 1, from step 2 too.
import { VisuallyHidden } from '@radix-ui/themes';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { EndedEvent, SessionInfo } from '@/lib/api-types';
import { ENDED_PATH, markEventDrop, readEnded, rememberEnded } from '@/lib/client/ended';
import { clearRememberedIdentity, forgetBellForOtherStaff, readPrefs, writeRememberedIdentity } from '@/lib/client/prefs';
import { announceSignIn } from '@/lib/client/session-signals';
import { markSignedIn, markSignedInEvent } from '@/lib/client/signed-in-at';
import { captureJoinCode, forgetJoinCode } from '@/lib/join-link';
import { safeNextPath } from '@/lib/safe-next';
import { isWide } from './desktop';
import { EndedScreen } from './Ended';
import { MESSAGES, draftFromIdentity, inviteSignInBody, rememberedIdentity, retryMinutes, type Identity, type SignInTeam, type WhoDraft } from './logic';
import { Credit, ThemeToggle } from './parts';
import { PasswordStep } from './PasswordStep';
import { postSession } from './session-api';
import { WhoStep } from './WhoStep';
import styles from './signin.module.css';

/** Screen-reader text for the team join link (the screen itself shows nothing about it). */
const LINK_HINT = 'Signs you in with the team link, no password needed';
const LINK_DONE = 'Signed in with the team link';
/** How often the "Try again in N min" countdown re-checks (as PasswordStep). */
const LOCK_TICK_MS = 5_000;

export interface SignInFlowProps {
  /** Safe same-origin path to return to after sign-in (lib/safe-next), or null for "/". */
  next: string | null;
  /** (Events) The team cards: every running event's teams (the server page reads them). */
  teams?: readonly SignInTeam[];
  /** (Events) /signin?ended=1: the Ended screen (lib/client/ended.ts keeps what it shows). */
  ended?: boolean;
}

const subscribeNothing = () => () => {};
const onClient = () => true;
const onServer = () => false;

export function SignInFlow({ next, teams = [], ended = false }: SignInFlowProps) {
  const mounted = useSyncExternalStore(subscribeNothing, onClient, onServer);
  // (Events) The Ended screen: arrived at /signin?ended=1, or a password / join link of an archived event below.
  const [endedEvent, setEndedEvent] = useState<EndedEvent | null | undefined>(undefined);
  const showEnded = mounted && (endedEvent !== undefined || ended);
  const onEnded = (event: EndedEvent | null) => {
    rememberEnded(event);
    if (event?.id) markEventDrop(event.id);
    forgetJoinCode();
    window.history.replaceState(window.history.state, '', ENDED_PATH);
    setEndedEvent(event);
  };
  return (
    <main className={styles.screen} data-testid="signin">
      <ThemeToggle />
      <span className={styles.growTop} />
      <div className={styles.column}>
        {showEnded ? <EndedScreen event={endedEvent ?? readEnded()} /> : mounted ? <Steps next={next} teams={teams} onEnded={onEnded} /> : null}
      </div>
      <span className={styles.grow} />
      {showEnded ? null : <Credit />}
    </main>
  );
}

/** The event a join link names ("<slug>.<code>"), for its logo; null for an older link without one. */
function linkSlug(code: string | null): string | null {
  const dot = code ? code.indexOf('.') : -1;
  if (!code || dot <= 0) return null;
  const slug = code.slice(0, dot).toLowerCase();
  return /^[a-z0-9][a-z0-9-]{1,39}$/.test(slug) ? slug : null;
}

type StepState =
  | { step: 1; draft: WhoDraft; focus: boolean }
  | { step: 2; identity: Identity; focus: boolean };

function initialState(withLink: boolean, teams: readonly SignInTeam[]): StepState {
  const remembered = rememberedIdentity(readPrefs());
  // From 768 px the step's first field is focused on load (desktop-sign-in.html); the phone waits for a tap.
  const focus = isWide();
  // A team join link signs in from step 1, so a remembered identity prefills it instead of skipping it.
  if (withLink) return { step: 1, draft: draftFromIdentity(remembered, teams), focus };
  return remembered ? { step: 2, identity: remembered, focus } : { step: 1, draft: draftFromIdentity(null, teams), focus };
}

/** After a successful POST /api/session with the link (PasswordStep does the same after the password). */
function openApp(session: SessionInfo | null, identity: Identity, next: string | null): void {
  // Remember what the server stored (canonical team), then open the app with the new cookie. Someone else than
  // the remembered staff member starts without their bell (F6 follow-up: it copies their server switch).
  forgetBellForOtherStaff(session?.staffName ?? identity.name, session?.team ?? identity.team);
  writeRememberedIdentity(session?.staffName ?? identity.name, session?.team ?? identity.team);
  // A sign-out left pending must not end this new session; open tabs re-check who is signed in.
  announceSignIn();
  // The app page opens a notification tapped before this sign-in (lib/client/signed-in-at.ts), and starts from this
  // event's cache, never the previous event's.
  markSignedIn();
  markSignedInEvent(session?.eventId);
  window.location.replace(safeNextPath(next) ?? '/');
}

function Steps({ next, teams, onEnded }: { next: string | null; teams: readonly SignInTeam[]; onEnded: (event: EndedEvent | null) => void }) {
  // The code a team join link left for this tab (and out of the address bar), or null.
  const [joinCode, setJoinCode] = useState<string | null>(() => captureJoinCode());
  const [state, setState] = useState<StepState>(() => initialState(joinCode !== null, teams));
  // (Events) A join link names its event: its logo beside Ground Control's (a password: Ground Control alone).
  const slug = linkSlug(joinCode);
  const eventLogo = slug ? `/api/events/logo/${slug}` : null;
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  // A 429 on the link: Continue waits until then (ms), and `now` drives the countdown.
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const busy = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // The link opened in this tab while it already shows /signin: only the fragment changes, nothing reloads.
  useEffect(() => {
    const onHashChange = () => {
      const code = captureJoinCode();
      if (!code || busy.current) return;
      setJoinCode(code);
      setMessage(null);
      setState((s) => (s.step === 1 ? s : { step: 1, draft: draftFromIdentity(s.identity, teams), focus: isWide() }));
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [teams]);

  // Count the rate-limit lock down; when it passes, Continue comes back.
  useEffect(() => {
    if (lockedUntil === null) return;
    const id = setInterval(() => {
      const t = Date.now();
      if (t < lockedUntil) setNow(t);
      else setLockedUntil(null);
    }, LOCK_TICK_MS);
    return () => clearInterval(id);
  }, [lockedUntil]);

  const continueWithLink = async (identity: Identity, code: string) => {
    if (busy.current) return;
    busy.current = true;
    setSubmitting(true);
    setMessage(null);
    const outcome = await postSession(inviteSignInBody(identity, code, teams));
    if (!alive.current) return;
    if (outcome.kind === 'ok') {
      forgetJoinCode();
      setAnnouncement(LINK_DONE);
      openApp(outcome.session, identity, next);
      return; // Stay busy while the app loads.
    }
    if (outcome.kind === 'ended') {
      onEnded(outcome.event);
      return;
    }
    busy.current = false;
    setSubmitting(false);
    if (outcome.kind === 'password') {
      // The code was refused: the event password, exactly as without a link.
      forgetJoinCode();
      setJoinCode(null);
      setState({ step: 2, identity, focus: true });
      return;
    }
    if (outcome.kind === 'rate_limited') {
      // Not about the code: keep it, and Continue waits out the lock.
      const t = Date.now();
      setNow(t);
      setLockedUntil(t + outcome.retryAfterSeconds * 1000);
      return;
    }
    setMessage(outcome.kind === 'invalid' ? outcome.message : MESSAGES[outcome.kind]);
  };

  if (state.step === 1) {
    const lockMessage = joinCode !== null && lockedUntil !== null ? MESSAGES.rateLimited(retryMinutes((lockedUntil - now) / 1000)) : null;
    return (
      <>
        <WhoStep
          teams={teams}
          eventLogo={eventLogo}
          draft={state.draft}
          onDraft={(draft) => {
            setState({ step: 1, draft, focus: false });
            setMessage(null);
          }}
          onContinue={(identity) => {
            if (joinCode) void continueWithLink(identity, joinCode);
            else setState({ step: 2, identity, focus: true });
          }}
          autoFocus={state.focus}
          submitting={submitting}
          locked={lockMessage !== null}
          message={lockMessage ?? message}
          continueHint={joinCode ? LINK_HINT : null}
        />
        <VisuallyHidden role="status">{announcement}</VisuallyHidden>
      </>
    );
  }
  return (
    <PasswordStep
      key={`${state.identity.name}\u0000${state.identity.team}`}
      identity={state.identity}
      teams={teams}
      next={next}
      autoFocus={state.focus}
      onEnded={onEnded}
      onChange={() => {
        clearRememberedIdentity();
        setState({ step: 1, draft: draftFromIdentity(state.identity, teams), focus: true });
      }}
    />
  );
}
