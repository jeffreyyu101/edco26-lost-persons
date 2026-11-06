'use client';
// "Alerts are on" (spec §7 Alerts, states.html Alerts): shown the first time the bell is turned on.
// Alerts show while this app is open; then the Home Screen tip (skipped inside the Home Screen app).
// No lock-screen promise.
import { Button, Flex, Heading, Text } from '@radix-ui/themes';
import { BellRing, Share, SquarePlus } from 'lucide-react';
import { Sheet } from '@/components/ui/Sheet';
import s from './list.module.css';

export interface BellSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Running as the Home Screen app already: no tip. */
  standalone: boolean;
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches === true;
}

const ICON = { strokeWidth: 1.75, 'aria-hidden': true } as const;

export function BellSheet({ open, onOpenChange, standalone }: BellSheetProps) {
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Alerts are on"
      hideTitle
      description="New requests alert you while this app is open."
    >
      <Flex align="center" gap="3" aria-hidden>
        <span className={`${s.sicon} ${s.siconRound}`}>
          <BellRing size={20} {...ICON} />
        </span>
        <Heading as="h2" size="4" weight="medium">
          Alerts are on
        </Heading>
      </Flex>
      <Text as="p" size="3" mt="3">
        New requests alert you while this app is open.
      </Text>
      {standalone ? null : (
        <>
          <ol className={s.steps} aria-label="Add it to your Home Screen">
            <li className={s.step}>
              <span className={s.sicon}>
                <Share size={18} {...ICON} />
              </span>
              <Text size="3">
                Tap <b>Share</b>
              </Text>
            </li>
            <li className={s.step}>
              <span className={s.sicon}>
                <SquarePlus size={18} {...ICON} />
              </span>
              <Text size="3">Add to Home Screen</Text>
            </li>
          </ol>
          <Text as="p" size="2" color="gray" mb="4">
            The Home Screen app has its own sign-in and saved requests.
          </Text>
        </>
      )}
      <Button size="3" highContrast mt={standalone ? '4' : '0'} style={{ width: '100%' }} onClick={() => onOpenChange(false)}>
        Got it
      </Button>
    </Sheet>
  );
}
