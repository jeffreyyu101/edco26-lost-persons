'use client';
// (Events) The Ended screen: what a staff member sees once their event has ended (spec "Ended"), from the app (any
// call answered 410 event_ended: they were signed out and the event's data left this phone) or from sign-in (a
// password or join link of an archived event). Minimal and formal: the event's logo beside Ground Control's, the
// event's name, the Archived chip and one line. Nothing else: no stats, no other event, no password field.
import { Heading, Text } from '@radix-ui/themes';
import type { EndedEvent } from '@/lib/api-types';
import { StageChip } from '@/components/ui/StageChip';
import { Logos } from './parts';
import styles from './signin.module.css';

export const ENDED_LINE = 'This event is now closed. Thank you for your work.';

export function EndedScreen({ event }: { event: EndedEvent | null }) {
  return (
    <div className={styles.ended} data-testid="ended">
      <Logos eventLogo={event?.logoUrl ?? null} eventName={event?.name ?? null} />
      {event?.name ? (
        <Heading as="h1" size="6" weight="bold" align="center" className={styles.endedName}>
          {event.name}
        </Heading>
      ) : null}
      <StageChip stage="archived" />
      <Text as="p" size="3" color="gray" align="center" className={styles.endedLine}>
        {ENDED_LINE}
      </Text>
    </div>
  );
}
