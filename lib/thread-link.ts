// The address that opens a request at its Messages (Request page order R2, Brian 2026-11-07): "/?r=<id>&to=thread".
// Pure and isomorphic, no imports: the server builds it into a message's push (lib/activity.ts), the page into
// its own notification (lib/client/system-notify.ts), and the first load reads it (lib/client/thread-jump.ts).
// An app build before this one ignores `to` (lib/client/nav.ts parseView) and opens the request at its top, so
// old "/?r=<id>" addresses and old builds keep working both ways.

export const THREAD_PARAM = 'to';
export const THREAD_VALUE = 'thread';

/** "/?r=<id>&to=thread". */
export function threadPath(requestId: string): string {
  return `/?r=${encodeURIComponent(requestId)}&${THREAD_PARAM}=${THREAD_VALUE}`;
}

/** The address asks for the thread (`to=thread`). */
export function wantsThread(params: Pick<URLSearchParams, 'get'>): boolean {
  return params.get(THREAD_PARAM) === THREAD_VALUE;
}
