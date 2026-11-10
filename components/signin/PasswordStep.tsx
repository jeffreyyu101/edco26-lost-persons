'use client';
// Step 2 (design/screens/sign-in.html `Pass`): "Enter the event password" (no app-name line, spec §1), the
// filled identity row with Change, the password with show/hide, a hidden username for Keychain, Sign in.
// Wrong password → red field + "Incorrect password". 429 → "Too many attempts. Try again in N min" and Sign
// in stays disabled until then.
// From 768 px (desktop-sign-in.html): ↵ on Sign in, an esc cap on Change, and Esc goes back to step 1 (as
// Change does) from anywhere on the step, the password field included.
import { Avatar, Button, Flex, IconButton, Text, TextField } from '@radix-ui/themes';
import { Eye, EyeOff } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { forgetBellForOtherStaff, writeRememberedIdentity } from '@/lib/client/prefs';
import { announceSignIn } from '@/lib/client/session-signals';
import { markSignedIn, markSignedInEvent } from '@/lib/client/signed-in-at';
import { avatarInitials, teamShort } from '@/lib/domain';
import { safeNextPath } from '@/lib/safe-next';
import { isEnterControl, isTextEntry, useStepKeys, useWide } from './desktop';
import type { EndedEvent } from '@/lib/api-types';
import { MESSAGES, retryMinutes, signInBody, type Identity, type SignInTeam } from './logic';
import { ErrorLine, Kbd, StepCard } from './parts';
import { postSession } from './session-api';
import styles from './signin.module.css';

type StepError = { kind: 'password' } | { kind: 'rate_limited' } | { kind: 'message'; text: string };

/** How often the "Try again in N min" countdown re-checks. */
const LOCK_TICK_MS = 5_000;

export interface PasswordStepProps {
  identity: Identity;
  /** Back to step 1 ("Change"). */
  onChange: () => void;
  /** Safe same-origin path to open after signing in, or null for "/". */
  next: string | null;
  /** Focus the password on mount (after Continue). */
  autoFocus: boolean;
  /** (Events) The team cards (a card team is sent as itself, anything else as Other). */
  teams?: readonly SignInTeam[];
  /** (Events) The password is an archived event's: the Ended screen. */
  onEnded?: (event: EndedEvent | null) => void;
}

export function PasswordStep({ identity, onChange, next, autoFocus, teams = [], onEnded }: PasswordStepProps) {
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<StepError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const busy = useRef(false);
  const alive = useRef(true);
  const errorId = useId();
  const wide = useWide();

  useStepKeys(wide, (event) => {
    if (event.key === 'Escape') {
      // Never mid-request (Change is disabled then), and not when something else already used this Esc.
      if (event.defaultPrevented || busy.current) return;
      event.preventDefault();
      onChange();
      return;
    }
    // Enter from the page (not a field or a button): sign in, or go to the empty password.
    if (event.key === 'Enter' && !event.defaultPrevented && !isTextEntry(event.target) && !isEnterControl(event.target)) {
      event.preventDefault();
      if (inputRef.current && !inputRef.current.value) inputRef.current.focus();
      else formRef.current?.requestSubmit();
    }
  });

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Count the rate-limit lock down; when it passes, Sign in comes back.
  useEffect(() => {
    if (lockedUntil === null) return;
    const id = setInterval(() => {
      const t = Date.now();
      if (t < lockedUntil) {
        setNow(t);
        return;
      }
      setLockedUntil(null);
      setError((e) => (e?.kind === 'rate_limited' ? null : e));
    }, LOCK_TICK_MS);
    return () => clearInterval(id);
  }, [lockedUntil]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy.current || !password || lockedUntil !== null) return;
    busy.current = true;
    setSubmitting(true);
    setError(null);
    const outcome = await postSession(signInBody(identity, password, teams));
    if (!alive.current) return;

    if (outcome.kind === 'ok') {
      // Remember what the server stored (canonical team), then open the app with the new cookie. Someone else
      // than the remembered staff member starts without their bell (F6 follow-up).
      forgetBellForOtherStaff(outcome.session?.staffName ?? identity.name, outcome.session?.team ?? identity.team);
      writeRememberedIdentity(outcome.session?.staffName ?? identity.name, outcome.session?.team ?? identity.team);
      // A sign-out left pending must not end this new session; open tabs re-check who is signed in.
      announceSignIn();
      // The app page opens a notification tapped before this sign-in (lib/client/signed-in-at.ts), and starts from this
      // event's cache, never the previous event's.
      markSignedIn();
      markSignedInEvent(outcome.session?.eventId);
      // (Events) The Ground Control lead passcode signs in with no event open: the Events list.
      const lead = outcome.session?.role === 'lead' && !outcome.session.eventId;
      window.location.replace(safeNextPath(next) ?? (lead ? '/events' : '/'));
      return; // Stay busy while the app loads.
    }

    if (outcome.kind === 'ended') {
      onEnded?.(outcome.event);
      return;
    }
    busy.current = false;
    setSubmitting(false);
    switch (outcome.kind) {
      case 'password':
        setPassword('');
        setError({ kind: 'password' });
        inputRef.current?.focus();
        return;
      case 'rate_limited': {
        const t = Date.now();
        setNow(t);
        setLockedUntil(t + outcome.retryAfterSeconds * 1000);
        setError({ kind: 'rate_limited' });
        return;
      }
      case 'invalid':
        setError({ kind: 'message', text: outcome.message });
        return;
      case 'forbidden':
        setError({ kind: 'message', text: MESSAGES.forbidden });
        return;
      case 'server':
        setError({ kind: 'message', text: MESSAGES.server });
        return;
      case 'network':
        setError({ kind: 'message', text: MESSAGES.network });
        return;
    }
  };

  const message =
    error?.kind === 'password'
      ? MESSAGES.password
      : error?.kind === 'rate_limited' && lockedUntil !== null
        ? MESSAGES.rateLimited(retryMinutes((lockedUntil - now) / 1000))
        : error?.kind === 'message'
          ? error.text
          : null;
  const invalid = error?.kind === 'password';

  return (
    <StepCard title="Enter the event password" appLine={false}>
      <form ref={formRef} method="post" noValidate onSubmit={submit}>
        <Flex direction="column" gap="3">
          {/* Keychain saves and fills the password against this username (not readOnly: Safari skips those). */}
          <input
            className={styles.keychain}
            type="text"
            name="username"
            autoComplete="username"
            defaultValue={identity.name}
            tabIndex={-1}
            aria-hidden="true"
          />
          <div className={styles.idrow}>
            <Avatar size="2" radius="full" variant="solid" color="gray" highContrast fallback={avatarInitials(identity.name)} aria-hidden />
            <div className={styles.nm}>
              <Text size="2" weight="medium" truncate>
                {identity.name}
              </Text>
              <Text size="1" color="gray" truncate>
                {teamShort(identity.team, teams)}
              </Text>
            </div>
            <Button
              type="button"
              size="1"
              variant="surface"
              color="gray"
              highContrast
              className={styles.hitSmall}
              aria-label="Change name or team"
              aria-keyshortcuts={wide ? 'Escape' : undefined}
              disabled={submitting}
              onClick={onChange}
            >
              Change
              <Kbd k="esc" variant="small" />
            </Button>
          </div>

          <TextField.Root
            ref={inputRef}
            size="3"
            type={show ? 'text' : 'password'}
            name="password"
            placeholder="Event password"
            aria-label="Event password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (error && error.kind !== 'rate_limited') setError(null);
            }}
            autoComplete="current-password"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            maxLength={200}
            autoFocus={autoFocus}
            className={invalid ? styles.invalid : undefined}
            aria-invalid={invalid ? true : undefined}
            aria-describedby={message ? errorId : undefined}
          >
            <TextField.Slot side="right">
              <IconButton
                type="button"
                size="2"
                variant="ghost"
                color="gray"
                className={styles.hit}
                aria-label={show ? 'Hide password' : 'Show password'}
                // Keep focus (and the iOS keyboard) in the field.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setShow((s) => !s)}
              >
                {show ? <EyeOff size={18} strokeWidth={1.75} aria-hidden /> : <Eye size={18} strokeWidth={1.75} aria-hidden />}
              </IconButton>
            </TextField.Slot>
          </TextField.Root>
          {message ? <ErrorLine id={errorId}>{message}</ErrorLine> : null}

          <Button
            type="submit"
            size="3"
            mt="1"
            highContrast
            loading={submitting}
            // Radix only defaults `disabled` to `loading` when no disabled prop is given: say both.
            disabled={submitting || !password || lockedUntil !== null}
            className={styles.submit}
            aria-keyshortcuts={wide ? 'Enter' : undefined}
          >
            Sign in
            <Kbd k="↵" />
          </Button>
        </Flex>
      </form>
    </StepCard>
  );
}
