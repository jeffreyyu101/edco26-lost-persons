'use client';
// (Events, lead screens) A lead's entries on `/`, for leads only (nothing for staff):
//   * LeadMenuItems, in the account menu: "Event" (setup of the event open in this session; on the desk it is in the
//     sidebar instead) and "Events" (the list, to switch or create).
//   * DeskEventLink, the desk sidebar's "Event" item (design/screens/events-v1-d: Dashboard, Event, Health).
//   * EventSwitcher, the desk's event switcher under the sidebar's lockup: its own chunk (next/dynamic), so staff never
//     download it.
// Both read the role and the open event from lib/client/event-config.ts (feat/events-client). They share one module
// with the account menu's chunk on purpose: a module of their own, used from the list and the desk, would become a
// shared chunk that every lazy view import of `/` lists (bytes in the first load).
import { CalendarCog, LayoutList } from 'lucide-react';
import dynamic from 'next/dynamic';
import type { ReactNode } from 'react';
import { useIsDesk } from '@/components/desk/breakpoints';
import { useEventConfig, useSessionRole } from '@/lib/client/event-config';

export const EventSwitcher = dynamic(() => import('./EventSwitcher').then((m) => m.EventSwitcher), { ssr: false });

/** The open event's id for a lead, else null (staff, not known yet, or no event open). */
function useLeadEventId(): string | null {
  const role = useSessionRole();
  const event = useEventConfig();
  return role === 'lead' ? (event?.id ?? null) : null;
}

export function LeadMenuItems({ className }: { className: string | undefined }) {
  const role = useSessionRole();
  const eventId = useLeadEventId();
  const desk = useIsDesk();
  if (role !== 'lead') return null;
  return (
    <>
      {!desk && eventId ? (
        <a className={className} href={`/events/${eventId}?from=app`} data-testid="lead-event-item">
          <CalendarCog size={16} aria-hidden />
          Event
        </a>
      ) : null}
      {/* A plain link: /events is its own route (it leaves the store). */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a className={className} href="/events" data-testid="lead-events-item">
        <LayoutList size={16} aria-hidden />
        Events
      </a>
    </>
  );
}

export function DeskEventLink({ className, labelClassName, tip }: { className: string | undefined; labelClassName: string | undefined; tip: ReactNode }) {
  const eventId = useLeadEventId();
  if (!eventId) return null;
  return (
    <a href={`/events/${eventId}?from=app`} className={className} data-testid="desk-event">
      <CalendarCog size={16} strokeWidth={1.75} aria-hidden />
      <span className={labelClassName}>Event</span>
      {tip}
    </a>
  );
}

/** True for a lead with an event open (the desk shows the event switcher). */
export function useIsLeadInEvent(): boolean {
  return useLeadEventId() !== null;
}
