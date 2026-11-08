'use client';
// Toasts at the top (requests.html .toast: icon circle, title, subtitle, View) and the Undo snackbar at the
// bottom (.snack). Both are announced politely. A toast closes on tap anywhere or on its ✕ (Dismiss; Brian
// 2026-11-07: the alerts waiting when the phone is opened close with an x too); sticky ones (durationMs null)
// stay until then.
import { Button, Text } from '@radix-ui/themes';
import { Bell, Check, CircleAlert, CloudOff, Footprints, Info, MessageCircle, RefreshCw, X } from 'lucide-react';
import type { MouseEvent } from 'react';
import type { SnackbarItem, ToastIcon, ToastItem, ToastTone } from '@/lib/client/store-contract';
import styles from './ui.module.css';

const ICONS: Readonly<Record<ToastIcon, typeof Bell>> = {
  bell: Bell,
  check: Check,
  x: X,
  alert: CircleAlert,
  refresh: RefreshCw,
  'cloud-off': CloudOff,
  info: Info,
  walk: Footprints,
  message: MessageCircle,
};

/** Icon circle colours (mockup: bell = gray-a4 / gray-12, "is in medical" = green-a4 / green-11). */
const TONE: Readonly<Record<ToastTone, { background: string; color: string }>> = {
  neutral: { background: 'var(--gray-a4)', color: 'var(--gray-12)' },
  green: { background: 'var(--green-a4)', color: 'var(--green-11)' },
  amber: { background: 'var(--amber-a4)', color: 'var(--amber-11)' },
  red: { background: 'var(--red-a4)', color: 'var(--red-11)' },
  blue: { background: 'var(--blue-a4)', color: 'var(--blue-11)' },
};

export interface ToasterProps {
  toasts: readonly ToastItem[];
  onDismiss: (id: string) => void;
}

/** Stacks the store's toasts at the top of the screen. */
export function Toaster({ toasts, onDismiss }: ToasterProps) {
  return (
    <div aria-live="polite" role="status" className={`lp-toaster ${styles.toaster}`}>
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} onDismiss={() => onDismiss(t.id)} />
      ))}
    </div>
  );
}

export interface ToastProps {
  toast: ToastItem;
  onDismiss: () => void;
}

export function Toast({ toast, onDismiss }: ToastProps) {
  const Icon = ICONS[toast.icon];
  const tone = TONE[toast.tone];
  const runAction = (event: MouseEvent) => {
    event.stopPropagation();
    // Dismiss first: the action may show a new toast (e.g. "Update ready" again when a reload is refused).
    onDismiss();
    toast.action?.run();
  };
  return (
    <div className={`lp-toast ${styles.toast}`} data-tone={toast.tone} onClick={onDismiss}>
      <span className={styles.toastIcon} style={tone} aria-hidden>
        <Icon size={toast.icon === 'check' ? 18 : 17} />
      </span>
      <div className={styles.toastText}>
        <Text size="2" weight="medium">
          {toast.title}
        </Text>
        {toast.subtitle ? (
          <Text size="1" color="gray">
            {toast.subtitle}
          </Text>
        ) : null}
      </div>
      {toast.action ? (
        <Button size="1" variant="soft" color="gray" highContrast onClick={runAction}>
          {toast.action.label}
        </Button>
      ) : null}
      <button type="button" className="lp-toast-x lp-hit" aria-label="Dismiss" onClick={onDismiss}>
        <X />
      </button>
    </div>
  );
}

export interface SnackbarProps {
  snackbar: SnackbarItem | null;
  onUndo: (id: string) => void;
  onDismiss: () => void;
}

/**
 * The 10 s Undo bar. Escape dismisses it while Undo has focus. (Pending v9.1) When the bar's words are compact
 * ("Bea Walsh closed · not located"), screen readers hear them as a sentence instead ("Bea Walsh closed, not
 * located."). Two lines before it cuts: a long name keeps the status in view.
 */
export function Snackbar({ snackbar, onUndo, onDismiss }: SnackbarProps) {
  if (!snackbar) return null;
  return (
    <div role="status" aria-live="polite" className={`lp-snack ${styles.snack}`}>
      <Text size="2" className={styles.snackText} aria-hidden={snackbar.said ? true : undefined}>
        {snackbar.message}
      </Text>
      {snackbar.said ? <span className={styles.visuallyHidden}>{snackbar.said}</span> : null}
      <button
        type="button"
        className={styles.undo}
        onClick={() => onUndo(snackbar.id)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onDismiss();
        }}
      >
        Undo
      </button>
    </div>
  );
}
