'use client';
// Sign-in (spec §8 Sign-in, design/screens/sign-in.html): step 1 name + team, step 2 the event password.
// From 768 px it is layout A of design/screens/desktop-sign-in.html: the same steps in a bordered card on the
// page canvas, with key caps and keyboard shortcuts (desktop.ts). The credit stays the last child of <main>.
// Remembered name and team skip to step 2 (so a session-expired redirect to /signin?next=… lands on step 2,
// prefilled). On success, go to `next` (already validated same-origin) or "/".
// Remembered identity and theme: lib/client/prefs.ts (this route has no StoreProvider). readPrefs() gives
// rememberedName / rememberedTeam (both or neither) to skip to step 2; after a successful POST
// /api/session call writeRememberedIdentity(staffName, team) with the response; "Change" calls
// clearRememberedIdentity(); the theme toggle calls setThemePref(). Never pick other storage keys.
//
// The steps render only on the client: which step to show lives in localStorage, and rendering step 1 on the
// server would flash it (or accept typing that hydration then drops) for everyone who is remembered.
//
// Team join link (J1, lib/join-link.ts): with a code kept for this tab, step 1 is the only step. It opens
// even for a remembered identity (prefilled), and Continue signs in with POST /api/session {…, invite}. If
// the server refuses the code (401: wrong, expired or switched off) or the attempt (429), the code is
// forgotten and step 2 opens as it always does, with no message about the link. A dropped signal or a
// server error keeps the code and says so above Continue, which tries again.
import { VisuallyHidden } from '@radix-ui/themes';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { SessionInfo } from '@/lib/api-types';
import { clearRememberedIdentity, readPrefs, writeRememberedIdentity } from '@/lib/client/prefs';
import { announceSignIn } from '@/lib/client/session-signals';
import { captureJoinCode, forgetJoinCode } from '@/lib/join-link';
import { safeNextPath } from '@/lib/safe-next';
import { isWide } from './desktop';
import { MESSAGES, draftFromIdentity, inviteSignInBody, rememberedIdentity, type Identity, type WhoDraft } from './logic';
import { Credit, ThemeToggle } from './parts';
import { PasswordStep } from './PasswordStep';
import { postSession } from './session-api';
import { WhoStep } from './WhoStep';
import styles from './signin.module.css';

/** Screen-reader text for the team join link (the screen itself shows nothing about it). */
const LINK_HINT = 'Signs you in with the team link, no password needed';
const LINK_DONE = 'Signed in with the team link';

export interface SignInFlowProps {
  /** Safe same-origin path to return to after sign-in (lib/safe-next), or null for "/". */
  next: string | null;
}

const subscribeNothing = () => () => {};
const onClient = () => true;
const onServer = () => false;

export function SignInFlow({ next }: SignInFlowProps) {
  const mounted = useSyncExternalStore(subscribeNothing, onClient, onServer);
  return (
    <main className={styles.screen} data-testid="signin">
      <ThemeToggle />
      <span className={styles.growTop} />
      <div className={styles.column}>{mounted ? <Steps next={next} /> : null}</div>
      <span className={styles.grow} />
      <Credit />
    </main>
  );
}

type StepState =
  | { step: 1; draft: WhoDraft; focus: boolean }
  | { step: 2; identity: Identity; focus: boolean };

function initialState(withLink: boolean): StepState {
  const remembered = rememberedIdentity(readPrefs());
  // From 768 px the step's first field is focused on load (desktop-sign-in.html); the phone waits for a tap.
  const focus = isWide();
  // A team join link signs in from step 1, so a remembered identity prefills it instead of skipping it.
  if (withLink) return { step: 1, draft: draftFromIdentity(remembered), focus };
  return remembered ? { step: 2, identity: remembered, focus } : { step: 1, draft: draftFromIdentity(null), focus };
}

/** After a successful POST /api/session with the link (PasswordStep does the same after the password). */
function openApp(session: SessionInfo | null, identity: Identity, next: string | null): void {
  // Remember what the server stored (canonical team), then open the app with the new cookie.
  writeRememberedIdentity(session?.staffName ?? identity.name, session?.team ?? identity.team);
  // A sign-out left pending must not end this new session; open tabs re-check who is signed in.
  announceSignIn();
  window.location.replace(safeNextPath(next) ?? '/');
}

function Steps({ next }: SignInFlowProps) {
  // The code a team join link left for this tab (and out of the address bar), or null.
  const [joinCode, setJoinCode] = useState<string | null>(() => captureJoinCode());
  const [state, setState] = useState<StepState>(() => initialState(joinCode !== null));
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const busy = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const continueWithLink = async (identity: Identity, code: string) => {
    if (busy.current) return;
    busy.current = true;
    setSubmitting(true);
    setMessage(null);
    const outcome = await postSession(inviteSignInBody(identity, code));
    if (!alive.current) return;
    if (outcome.kind === 'ok') {
      forgetJoinCode();
      setAnnouncement(LINK_DONE);
      openApp(outcome.session, identity, next);
      return; // Stay busy while the app loads.
    }
    busy.current = false;
    setSubmitting(false);
    if (outcome.kind === 'password' || outcome.kind === 'rate_limited') {
      // Refused: the event password, exactly as without a link (its step shows a lock on its own submit).
      forgetJoinCode();
      setJoinCode(null);
      setState({ step: 2, identity, focus: true });
      return;
    }
    setMessage(outcome.kind === 'invalid' ? outcome.message : MESSAGES[outcome.kind]);
  };

  if (state.step === 1) {
    return (
      <>
        <WhoStep
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
          message={message}
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
      next={next}
      autoFocus={state.focus}
      onChange={() => {
        clearRememberedIdentity();
        setState({ step: 1, draft: draftFromIdentity(state.identity), focus: true });
      }}
    />
  );
}
