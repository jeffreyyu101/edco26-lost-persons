'use client';
// Small pieces the Health panels share: the colour chip with a glyph, the mini bar, the team chips and the "—" cell.
// A chip or bar is role="img" with a full-sentence label; what shows is the glyph and the value only.
import { Ban, CloudOff, Hourglass, MoveVertical, Repeat, TriangleAlert, Zap, ZoomIn, type Icon } from './icons';
import type { ReactNode } from 'react';
import { DASH, SIGNALS, teamLabel } from './health-model';
import s from './health.module.css';

export const SIGNAL_ICON: Readonly<Record<string, Icon>> = {
  stuck_scroll: MoveVertical,
  rage_tap: Zap,
  dead_tap: Ban,
  loop: Repeat,
  slow: Hourglass,
  pinch: ZoomIn,
  error: TriangleAlert,
  stuck_send: CloudOff,
};

export function Chip({ color, label, children }: { color?: string; label?: string; children: ReactNode }) {
  return (
    <span className={s.chip} data-color={color} {...(label ? { role: 'img', 'aria-label': label } : {})}>
      {children}
    </span>
  );
}

export function SignalChip({ name, label }: { name: string; label: string }) {
  const Glyph = SIGNAL_ICON[name] ?? TriangleAlert;
  const sig = SIGNALS[name];
  return (
    <Chip color={sig?.color ?? 'gray'} label={label}>
      <Glyph size={13} strokeWidth={2} />
      {sig?.label ?? name}
    </Chip>
  );
}

export function Bar({ value, max, color, label }: { value: number; max: number; color?: string; label: string }) {
  const w = max > 0 ? Math.max(2, Math.min(100, (100 * value) / max)) : 0;
  return (
    <span className={s.bar} role="img" aria-label={label}>
      <span className={s.barFill} data-color={color} style={{ width: `${w}%` }} />
    </span>
  );
}

export function TeamChips({ teams }: { teams: readonly string[] }) {
  if (!teams.length) return <span aria-hidden>{DASH}</span>;
  return (
    <span className={s.chips}>
      {teams.map((t) => (
        <Chip key={t}>{teamLabel(t)}</Chip>
      ))}
    </span>
  );
}

/** A section the server could not read: "—". */
export function Missing() {
  return (
    <p className={s.empty} role="img" aria-label="Could not be read">
      {DASH}
    </p>
  );
}

export function NoRows() {
  return (
    <p className={s.empty} role="img" aria-label="Nothing in this window">
      0
    </p>
  );
}
