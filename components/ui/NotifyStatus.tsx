'use client';
// System notifications in the "Alerts are on" sheets (v2.5 A52): a one-tap "Allow notifications", or the
// answer ("System notifications on", or a quiet "Blocked in browser" that never asks again). Rendered only
// where they are supported (desktop browsers, Android, the iPhone Home Screen app); an iPhone Safari tab
// keeps the Home Screen tip instead. The avatar menu shows the same states as menu rows (AccountMenu).
import { Button, Text, VisuallyHidden } from '@radix-ui/themes';
import { BellDot, BellOff, BellPlus } from 'lucide-react';
import { askNotifyPermission, type NotifyState } from '@/lib/client/system-notify';
import styles from './ui.module.css';

export const NOTIFY_COPY = {
  allow: 'Allow notifications',
  on: 'System notifications on',
  blocked: 'Blocked in browser',
  /** What a screen reader hears for the blocked state (the visible label is short). */
  blockedFull: 'System notifications are blocked in this browser.',
} as const;

const ICON = { size: 18, strokeWidth: 1.75, 'aria-hidden': true } as const;

export function NotifySheetRow({ state }: { state: NotifyState }) {
  if (!state.supported) return null;
  if (state.permission === 'default') {
    return (
      <div className={styles.notifyRow}>
        {/* Called inside the tap: browsers only prompt for a user gesture. */}
        <Button
          size="3"
          variant="soft"
          color="gray"
          highContrast
          className={`${styles.fullButton} lp-hit`}
          onClick={() => void askNotifyPermission()}
          data-testid="notify-allow"
        >
          <BellPlus {...ICON} />
          {NOTIFY_COPY.allow}
        </Button>
      </div>
    );
  }
  const on = state.permission === 'granted';
  return (
    <div className={`${styles.step} ${styles.notifyRow}`} data-testid="notify-state" data-state={state.permission}>
      <span className={styles.stepIcon} aria-hidden>
        {on ? <BellDot {...ICON} /> : <BellOff {...ICON} />}
      </span>
      {on ? (
        <Text size="3">{NOTIFY_COPY.on}</Text>
      ) : (
        <>
          <Text size="3" color="gray" aria-hidden>
            {NOTIFY_COPY.blocked}
          </Text>
          <VisuallyHidden>{NOTIFY_COPY.blockedFull}</VisuallyHidden>
        </>
      )}
    </div>
  );
}
