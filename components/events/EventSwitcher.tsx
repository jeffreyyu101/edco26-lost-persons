'use client';
// (Events, lead screens) The desk's event switcher (design/screens/events-v1-d), under the sidebar's logo lockup, for
// leads only (loaded with next/dynamic: staff never download it). It shows the event open in this session; its menu
// lists every event (logo, name, stage chip, ✓ on the open one), then New event and the Events list. Picking an event
// opens it (POST /api/session/event) and reloads the app on it.
import { DropdownMenu, VisuallyHidden } from '@radix-ui/themes';
import { Check, ChevronsUpDown, LayoutList, Plus } from 'lucide-react';
import { useState } from 'react';
import type { EventAdmin } from '@/lib/api-types';
import { api, openEvent } from './api';
import { EventLogo, STAGE_LABEL, StageChip } from './parts';
import { useEventConfig, useSessionRole } from '@/lib/client/event-config';
import s from './events.module.css';

export function EventSwitcher() {
  const role = useSessionRole();
  const current = useEventConfig();
  const [events, setEvents] = useState<EventAdmin[] | null>(null);
  if (role !== 'lead' || !current) return null;

  const load = (open: boolean) => {
    if (!open) return;
    void api.list().then((res) => {
      if (res.ok) setEvents(res.data.events);
    });
  };

  return (
    <DropdownMenu.Root onOpenChange={load}>
      <DropdownMenu.Trigger>
        <button type="button" className={s.switcher} aria-label={`Event: ${current.name}, ${STAGE_LABEL[current.stage]}. Switch event`} data-testid="event-switcher">
          <EventLogo name={current.name} logoUrl={current.logoUrl} size={28} />
          <span className={s.switcherName}>{current.name}</span>
          <ChevronsUpDown size={16} strokeWidth={1.75} className={s.switcherChev} aria-hidden />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="start" variant="soft" className={s.menuContent} data-testid="event-switcher-menu">
        <DropdownMenu.Label>Events</DropdownMenu.Label>
        {events === null ? (
          <DropdownMenu.Item disabled>
            <VisuallyHidden>Loading</VisuallyHidden>…
          </DropdownMenu.Item>
        ) : (
          events.map((e) => (
            <DropdownMenu.Item
              key={e.id}
              onSelect={() => {
                if (e.id !== current.id) void openEvent(e.id);
              }}
              data-testid="event-switcher-item"
              data-slug={e.slug}
            >
              <span className={s.menuItem}>
                <EventLogo name={e.name} logoUrl={e.logoUrl} size={24} />
                <span className={s.menuName}>{e.name}</span>
                <StageChip stage={e.stage} />
                {e.id === current.id ? <Check size={16} aria-label="Open now" /> : <span style={{ width: 16 }} aria-hidden />}
              </span>
            </DropdownMenu.Item>
          ))
        )}
        <DropdownMenu.Separator />
        {/* Full navigations: the lead pages are their own route, without the store. */}
        {/* eslint-disable-next-line @next/next/no-location-assign-relative-destination */}
        <DropdownMenu.Item onSelect={() => window.location.assign('/events/new')}>
          <Plus size={16} aria-hidden />
          New event
        </DropdownMenu.Item>
        {/* eslint-disable-next-line @next/next/no-location-assign-relative-destination */}
        <DropdownMenu.Item onSelect={() => window.location.assign('/events')}>
          <LayoutList size={16} aria-hidden />
          All events
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}
