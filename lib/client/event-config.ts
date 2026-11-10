'use client';
// (Events, phase 2) The signed-in event's config on the client: ONE module every screen reads it through.
//
//   const event = useEventConfig();   // EventConfig | null (null: not known yet, or a lead with no event open)
//   const role = useSessionRole();    // 'staff' | 'lead' | null (not known yet)
//
// Where it comes from: GET /api/session `event` (lib/api-types.ts EventConfig), read by the store when it confirms the
// session and again whenever a sync answer says the event's version moved (GET /api/sync?ev=<updatedAt>). The last
// config is kept on this device (localStorage, see readStoredEvent) so an offline reload renders the same posts,
// teams, time zone and logo before the first answer. Nothing here is baked into the build.
//
// The pure helpers below take the config (or a part of it) as an argument, so they work in tests and on the server
// render path, where there is no config.
import type { EventConfig, EventPost, EventStage, EventTeam, SessionRole } from '../api-types';
import { OTHER_POST } from '../domain';
import { useStoreSelector, type StoreState } from './store-contract';

export type { EventConfig, EventPost, EventStage, EventTeam, SessionRole };

const selectEvent = (s: StoreState) => s.event;
const selectRole = (s: StoreState) => s.role;

/** The signed-in event's config, or null (not known yet; a lead who has not opened an event). */
export function useEventConfig(): EventConfig | null {
  return useStoreSelector(selectEvent);
}

/** 'staff' or 'lead' once the session is known (an offline reload: the last one), else null. */
export function useSessionRole(): SessionRole | null {
  return useStoreSelector(selectRole);
}

// ---------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------

/** The posts a request can be logged at, in setup order (the form adds "Other" itself). */
export function eventPosts(event: Pick<EventConfig, 'posts'> | null | undefined): readonly EventPost[] {
  return event?.posts ?? [];
}

/** True when `label` is one of the event's posts (not "Other"). */
export function isEventPost(event: Pick<EventConfig, 'posts'> | null | undefined, label: string | null | undefined): boolean {
  return !!label && label !== OTHER_POST && eventPosts(event).some((p) => p.label === label);
}

/** The event's medical team (exactly one may be), or null. */
export function medicalTeam(event: Pick<EventConfig, 'teams'> | null | undefined): EventTeam | null {
  return event?.teams.find((t) => t.medical) ?? null;
}

/**
 * Every name the medical team goes by: its label, then (phase 2) the labels it had before a rename, which sessions
 * signed in earlier still carry. [] when the event has none, so nothing matches.
 */
export function medicalLabel(event: Pick<EventConfig, 'teams'> | null | undefined): string[] {
  const t = medicalTeam(event);
  return t ? [t.label, ...(t.aliases ?? [])] : [];
}

/** What a swap place 'mm' is called at this event ("Main Med"). */
export function mainMedicalLabel(event: Pick<EventConfig, 'mainMedical'> | null | undefined): string {
  return event?.mainMedical?.trim() || '';
}

/** One of the event's teams by its label (case-insensitive), or null for any other (Other) team text. */
export function teamOf(event: Pick<EventConfig, 'teams'> | null | undefined, team: string | null | undefined): EventTeam | null {
  const t = (team ?? '').trim().toLowerCase();
  if (!t) return null;
  return event?.teams.find((x) => x.label.toLowerCase() === t || (x.aliases ?? []).some((a) => a.toLowerCase() === t)) ?? null;
}

/** The short form of a team for display: the event's short name, else the team text itself. */
export function teamShortOf(event: Pick<EventConfig, 'teams'> | null | undefined, team: string | null | undefined): string {
  return teamOf(event, team)?.short ?? (team ?? '').trim();
}

/** The event's IANA zone, or the device's when no config is known yet. */
export function eventZone(event: Pick<EventConfig, 'timezone'> | null | undefined): string {
  return event?.timezone || deviceZone();
}

/** This device's IANA time zone ('UTC' when it can't be read). */
export function deviceZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * The event's dates in words: short "Nov 14–15" (or "Nov 30–Dec 1"), long "November 14–15, 2026". '' when unknown.
 * Calendar dates (YYYY-MM-DD): no time zone involved.
 */
export function eventDates(event: Pick<EventConfig, 'startsOn' | 'endsOn'> | null | undefined, form: 'short' | 'long'): string {
  const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(event?.startsOn ?? '');
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(event?.endsOn ?? '');
  if (!a || !b) return '';
  const [, y1, m1, d1] = a.map(Number) as [number, number, number, number];
  const [, y2, m2, d2] = b.map(Number) as [number, number, number, number];
  const month = (m: number) => (form === 'short' ? (MONTHS[m - 1] ?? '').slice(0, 3) : (MONTHS[m - 1] ?? ''));
  const same = y1 === y2 && m1 === m2;
  const range = same ? (d1 === d2 ? `${month(m1)} ${d1}` : `${month(m1)} ${d1}–${d2}`) : `${month(m1)} ${d1}–${month(m2)} ${d2}`;
  return form === 'long' ? `${range}, ${y2}` : range;
}

// The last config on this device: lib/client/event-store.ts (no React, so the store's first load carries only that).
export { EVENT_STORAGE_KEY, readStoredEvent, writeStoredEvent } from './event-store';
