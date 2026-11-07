'use client';
// The exact taps of a path, as chips with › between them (design/screens/alerts-banner.html Steps). The
// chips are decoration for sight; a screen reader hears the same path as one sentence.
import { VisuallyHidden } from '@radix-ui/themes';
import { ChevronRight, EllipsisVertical, Lock, Settings, Share, SlidersHorizontal, SquarePlus, TextAlignStart } from 'lucide-react';
import type { ComponentType } from 'react';
import { BellIcon, EllipsisIcon, type IconProps } from '@/components/activity/icons';
import { stepsSentence, type Step, type StepIcon } from '@/lib/client/alerts-platform';
import s from './alerts.module.css';

const ICONS: Readonly<Record<StepIcon, ComponentType<IconProps>>> = {
  'more-h': EllipsisIcon,
  'more-v': EllipsisVertical,
  'page-menu': TextAlignStart,
  share: Share,
  'square-plus': SquarePlus,
  settings: Settings,
  sliders: SlidersHorizontal,
  lock: Lock,
  bell: BellIcon,
};

export function StepChips({ steps, lead, testId }: { steps: readonly Step[]; lead: string; testId?: string }) {
  return (
    <>
      <ol className={s.steps} aria-hidden data-testid={testId}>
        {steps.map((step, i) => {
          const Icon = step.icon ? ICONS[step.icon] : null;
          return (
            <li key={`${i}-${step.label}`} className={s.step}>
              <span className={s.chip} data-testid="step-chip">
                {Icon ? <Icon size={14} strokeWidth={2} /> : null}
                {step.label}
              </span>
              {/* The › trails its chip, so a wrapped line starts with a chip (alerts-banner-3). */}
              {i < steps.length - 1 ? <ChevronRight size={13} strokeWidth={2} className={s.sep} /> : null}
            </li>
          );
        })}
      </ol>
      <VisuallyHidden>{stepsSentence(lead, steps)}</VisuallyHidden>
    </>
  );
}
