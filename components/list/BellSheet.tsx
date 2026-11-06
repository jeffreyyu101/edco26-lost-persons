'use client';
// "Alerts are on" (spec §7 Alerts, states.html Alerts): shown the first time the bell is turned on.
// Alerts show while this app is open. Where the device has system notifications (desktop, Android, the
// iPhone Home Screen app; v2.5 A52), "Allow notifications" or its answer follows; an iPhone Safari tab gets
// the Home Screen tip instead (skipped inside the Home Screen app). No lock-screen promise on the tab.
import { Button, Flex, Text } from '@radix-ui/themes';
import { BellRing, Share, SquarePlus } from 'lucide-react';
import { NotifySheetRow } from '@/components/ui/NotifyStatus';
import { Sheet, SheetDescription, SheetTitle } from '@/components/ui/Sheet';
import { useNotifyState } from '@/lib/client/system-notify';
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
  const notify = useNotifyState();
  const tip = !standalone && !notify.supported;
  return (
    // The visible heading and line name and describe the sheet (no hidden copy read twice).
    <Sheet open={open} onOpenChange={onOpenChange} titleInContent>
      <Flex align="center" gap="3">
        <span className={`${s.sicon} ${s.siconRound}`}>
          <BellRing size={20} {...ICON} />
        </span>
        <SheetTitle as="h2" size="4" weight="medium" mb="0" trim="normal">
          Alerts are on
        </SheetTitle>
      </Flex>
      <SheetDescription size="3" mt="3">
        New requests alert you while this app is open.
      </SheetDescription>
      <NotifySheetRow state={notify} />
      {!tip ? null : (
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
      <Button size="3" highContrast mt={tip ? '0' : '4'} className="lp-hit" style={{ width: '100%' }} onClick={() => onOpenChange(false)}>
        Got it
      </Button>
    </Sheet>
  );
}
