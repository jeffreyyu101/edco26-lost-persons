// (Events) The role and event config this device last had (localStorage), so an offline reload renders the same posts,
// teams, time zone and logo before GET /api/session answers. No React and nothing else imported: the store reads it at
// construction (pure: localStorage only, like readPrefs) and it stays off the screens' modules.
import type { EventConfig, SessionRole } from '../api-types';

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
