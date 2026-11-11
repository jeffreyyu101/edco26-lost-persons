'use client';
// (Events) The brand row's event parts: the event's logo before Ground Control's (white when it is a single-colour
// transparent logo, else as uploaded) and its dates under the title. The row itself (BrandCard) has no state and is
// drawn on the server; these read the signed-in event's config on the client, so no event is in the server's HTML.
import { EventLogo } from '@/components/ui/EventLogo';
import { eventDates, useEventConfig } from '@/lib/client/event-config';
import b from './brand.module.css';

export function BrandEventLogo({ loading }: { loading?: 'lazy' }) {
  const event = useEventConfig();
  if (!event?.logoUrl) return null;
  return (
    <>
      <EventLogo src={event.logoUrl} surface="dark" className={b.edc} height={19} loading={loading} />
      <span className={b.div} aria-hidden="true" />
    </>
  );
}

export function BrandEventDates() {
  const event = useEventConfig();
  const short = eventDates(event, 'short');
  if (!short) return null;
  return (
    <>
      <p className={`${b.dates} ${b.datesShort}`}>{short}</p>
      <p className={`${b.dates} ${b.datesLong}`}>{eventDates(event, 'long')}</p>
    </>
  );
}
