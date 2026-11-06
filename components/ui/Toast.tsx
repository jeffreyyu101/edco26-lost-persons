'use client';
// Toasts at the top (mockups: .toast — icon circle, title, subtitle, View button) and the Undo snackbar
// at the bottom (.snack). aria-live="polite". STUB (Phase 1a): props are final; C ports the mockup CSS.
import { Button, Text } from '@radix-ui/themes';
import { Bell, Check, CircleAlert, CloudOff, Info, RefreshCw, Footprints, X } from 'lucide-react';
import type { SnackbarItem, ToastIcon, ToastItem } from '@/lib/client/store-contract';

const ICONS: Readonly<Record<ToastIcon, typeof Bell>> = {
  bell: Bell,
  check: Check,
  x: X,
  alert: CircleAlert,
  refresh: RefreshCw,
  'cloud-off': CloudOff,
  info: Info,
  walk: Footprints,
};

export interface ToasterProps {
  toasts: readonly ToastItem[];
  onDismiss: (id: string) => void;
}

/** Stacks the store's toasts at the top of the screen. */
export function Toaster({ toasts, onDismiss }: ToasterProps) {
  return (
    <div aria-live="polite" role="status" className="lp-toaster" style={{ position: 'fixed', top: 10, left: 10, right: 10, zIndex: 50, display: 'grid', gap: 8 }}>
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
  return (
    <div className="lp-toast" data-tone={toast.tone} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: 12, borderRadius: 'var(--radius-5)', background: 'var(--color-panel-solid)', boxShadow: 'var(--shadow-5)' }}>
      <Icon size={17} aria-hidden />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
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
        <Button
          size="1"
          variant="soft"
          color="gray"
          highContrast
          onClick={() => {
            toast.action?.run();
            onDismiss();
          }}
        >
          {toast.action.label}
        </Button>
      ) : null}
    </div>
  );
}

export interface SnackbarProps {
  snackbar: SnackbarItem | null;
  onUndo: (id: string) => void;
  onDismiss: () => void;
}

/** The 6 s Undo bar. */
export function Snackbar({ snackbar, onUndo }: SnackbarProps) {
  if (!snackbar) return null;
  return (
    <div role="status" aria-live="polite" className="lp-snack" style={{ position: 'fixed', left: 12, right: 12, bottom: 'calc(24px + env(safe-area-inset-bottom))', zIndex: 50, display: 'flex', alignItems: 'center', gap: 10, padding: '10px 10px 10px 14px', borderRadius: 'var(--radius-4)', background: 'var(--gray-12)', color: 'var(--gray-1)' }}>
      <Text size="2" style={{ flex: 1 }}>
        {snackbar.message}
      </Text>
      <button type="button" onClick={() => onUndo(snackbar.id)} style={{ border: 0, background: 'none', color: 'inherit', font: 'inherit', fontWeight: 600, fontSize: 14, padding: '6px 8px', minHeight: 44 }}>
        Undo
      </button>
    </div>
  );
}
