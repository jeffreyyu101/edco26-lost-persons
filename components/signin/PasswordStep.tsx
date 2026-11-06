'use client';
// Step 2 (design/screens/sign-in.html `Pass`): "Enter the event password" (no app-name line, spec §1), the
// filled identity row with Change, the password with show/hide, a hidden username for Keychain, Sign in.
// Wrong password → red field + "Incorrect password". 429 → "Too many attempts. Try again in N min" and Sign
// in stays disabled until then.
import { Avatar, Button, Flex, IconButton, Text, TextField } from '@radix-ui/themes';
import { Eye, EyeOff } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { writeRememberedIdentity } from '@/lib/client/prefs';
import { avatarInitials, teamShort } from '@/lib/domain';
import { safeNextPath } from '@/lib/safe-next';
import { MESSAGES, retryMinutes, signInBody, type Identity } from './logic';
import { Brand, ErrorLine } from './parts';
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
}

export function PasswordStep({ identity, onChange, next, autoFocus }: PasswordStepProps) {
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<StepError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  const alive = useRef(true);
  const errorId = useId();

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
    const outcome = await postSession(signInBody(identity, password));
    if (!alive.current) return;

    if (outcome.kind === 'ok') {
      // Remember what the server stored (canonical team), then open the app with the new cookie.
      writeRememberedIdentity(outcome.session?.staffName ?? identity.name, outcome.session?.team ?? identity.team);
      window.location.replace(safeNextPath(next) ?? '/');
      return; // Stay busy while the app loads.
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
    <>
      <Brand title="Enter the event password" appLine={false} />
      <form method="post" noValidate onSubmit={submit}>
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
                {teamShort(identity.team)}
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
              disabled={submitting}
              onClick={onChange}
            >
              Change
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
          >
            Sign in
          </Button>
        </Flex>
      </form>
    </>
  );
}
