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
import { useState, useSyncExternalStore } from 'react';
import { clearRememberedIdentity, readPrefs } from '@/lib/client/prefs';
import { isWide } from './desktop';
import { draftFromIdentity, rememberedIdentity, type Identity, type WhoDraft } from './logic';
import { Credit, ThemeToggle } from './parts';
import { PasswordStep } from './PasswordStep';
import { WhoStep } from './WhoStep';
import styles from './signin.module.css';

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

function initialState(): StepState {
  const remembered = rememberedIdentity(readPrefs());
  // From 768 px the step's first field is focused on load (desktop-sign-in.html); the phone waits for a tap.
  const focus = isWide();
  return remembered ? { step: 2, identity: remembered, focus } : { step: 1, draft: draftFromIdentity(null), focus };
}

function Steps({ next }: SignInFlowProps) {
  const [state, setState] = useState<StepState>(initialState);

  if (state.step === 1) {
    return (
      <WhoStep
        draft={state.draft}
        onDraft={(draft) => setState({ step: 1, draft, focus: false })}
        onContinue={(identity) => setState({ step: 2, identity, focus: true })}
        autoFocus={state.focus}
      />
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
