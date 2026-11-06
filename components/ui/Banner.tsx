'use client';
// Inline status banner (mockups: .bnr — "Offline · 2 waiting to send", "Can't reach the log · Try again",
// "Updated by someone else", "Update ready · Reload"). STUB (Phase 1a): props are final.
import { Button } from '@radix-ui/themes';
import { CircleAlert, CloudOff, Plug, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';

export type BannerTone = 'amber' | 'red' | 'gray' | 'blue';
export type BannerIcon = 'offline' | 'error' | 'conflict' | 'update';

const ICONS = { offline: CloudOff, error: Plug, conflict: CircleAlert, update: RefreshCw } as const;

export interface BannerProps {
  tone: BannerTone;
  icon: BannerIcon;
  children: ReactNode;
  action?: { label: string; onClick: () => void; disabled?: boolean };
}

export function Banner({ tone, icon, children, action }: BannerProps) {
  const Icon = ICONS[icon];
  return (
    <div
      role="status"
      className="lp-banner"
      data-tone={tone}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        margin: '0 12px 8px',
        padding: '9px 12px',
        borderRadius: 'var(--radius-3)',
        fontSize: 13,
        fontWeight: 500,
        background: `var(--${tone}-a3)`,
        color: `var(--${tone}-11)`,
      }}
    >
      <Icon size={16} aria-hidden />
      <span style={{ flex: 1 }}>{children}</span>
      {action ? (
        <Button size="1" variant="soft" color={tone} onClick={action.onClick} disabled={action.disabled}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
