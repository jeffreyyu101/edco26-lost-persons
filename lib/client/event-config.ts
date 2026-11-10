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

/** The medical team's label ('' when the event has none, so nothing matches it). */
export function medicalLabel(event: Pick<EventConfig, 'teams'> | null | undefined): string {
  return medicalTeam(event)?.label ?? '';
}

/** What a swap place 'mm' is called at this event ("Main Med"). */
export function mainMedicalLabel(event: Pick<EventConfig, 'mainMedical'> | null | undefined): string {
  return event?.mainMedical?.trim() || '';
}

/** One of the event's teams by its label (case-insensitive), or null for any other (Other) team text. */
export function teamOf(event: Pick<EventConfig, 'teams'> | null | undefined, team: string | null | undefined): EventTeam | null {
  const t = (team ?? '').trim().toLowerCase();
  if (!t) return null;
  return event?.teams.find((x) => x.label.toLowerCase() === t) ?? null;
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

// ---------------------------------------------------------------------------------------------------
// The last config on this device (an offline reload renders with it before GET /api/session answers)
// ---------------------------------------------------------------------------------------------------

export const EVENT_STORAGE_KEY = 'lp-event';

interface StoredEvent {
  role: SessionRole;
  event: EventConfig | null;
}

function isConfig(value: unknown): value is EventConfig {
  const v = value as Partial<EventConfig> | null;
  return (
    !!v &&
    typeof v === 'object' &&
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.timezone === 'string' &&
    Array.isArray(v.posts) &&
    Array.isArray(v.teams) &&
    Array.isArray(v.lastSeen) &&
    (v.stage === 'practice' || v.stage === 'live' || v.stage === 'archived')
  );
}

/** The role and event config this device last had (null when none, or unreadable). Safe on the server. */
export function readStoredEvent(storage: Storage | null = localStore()): StoredEvent | null {
  try {
    const raw = storage?.getItem(EVENT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { role?: unknown; event?: unknown };
    const role = parsed.role === 'lead' ? 'lead' : parsed.role === 'staff' ? 'staff' : null;
    if (!role) return null;
    return { role, event: isConfig(parsed.event) ? parsed.event : null };
  } catch {
    return null;
  }
}

/** Keeps (or with null forgets) the role and config on this device. Best effort. */
export function writeStoredEvent(value: StoredEvent | null, storage: Storage | null = localStore()): void {
  try {
    if (value) storage?.setItem(EVENT_STORAGE_KEY, JSON.stringify(value));
    else storage?.removeItem(EVENT_STORAGE_KEY);
  } catch {
    // private mode: the next load asks the server
  }
}

function localStore(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
