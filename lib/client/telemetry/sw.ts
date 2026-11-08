// The service worker's push and click log (design §4.7): public/sw.js keeps up to 100 entries in Cache Storage and
// hands them over (and clears them) on {type: 'lp-tel-take'}. An older worker never answers: after 3 s the collector
// moves on.
import { TEL_SW_TAKE } from '../../telemetry';

/** A push the worker received. */
export interface SwRx {
  e: 'rx';
  /** The push's kind (ActivityKind or test). */
  k: string;
  /** Worker clock (epoch ms) when it arrived. */
  at: number;
  /** The server clock when it was built (pushPayload sentAt), or null. */
  sent: number | null;
  /** A window took it in the app. */
  fr: boolean;
  /** A notification was shown. */
  sh: boolean;
  /** WebKit's silent show (shown and closed at once). */
  si: boolean;
}

/** A notification click. */
export interface SwClick {
  e: 'click';
  k: string | null;
  /** It was a Web Push (else the page's own notification). */
  ps: boolean;
  at: number;
  /** ms from the notification's timestamp to the click, or null. */
  age: number | null;
  via: 'lp-open' | 'take-open' | 'nav';
}

export type SwEntry = SwRx | SwClick;

const KIND = /^[a-z_]{1,24}$/;

/** Entries as the worker wrote them, checked (anything malformed is dropped). */
export function cleanEntries(raw: unknown): SwEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: SwEntry[] = [];
  for (const r of raw.slice(0, 100)) {
    if (!r || typeof r !== 'object') continue;
    const x = r as Record<string, unknown>;
    if (typeof x.at !== 'number' || !Number.isFinite(x.at)) continue;
    if (x.e === 'rx' && typeof x.k === 'string' && KIND.test(x.k)) {
      out.push({ e: 'rx', k: x.k, at: x.at, sent: typeof x.sent === 'number' && Number.isFinite(x.sent) ? x.sent : null, fr: x.fr === true, sh: x.sh === true, si: x.si === true });
    } else if (x.e === 'click') {
      const via = x.via === 'lp-open' || x.via === 'take-open' ? x.via : 'nav';
      out.push({ e: 'click', k: typeof x.k === 'string' && KIND.test(x.k) ? x.k : null, ps: x.ps === true, at: x.at, age: typeof x.age === 'number' && Number.isFinite(x.age) ? x.age : null, via });
    }
  }
  return out;
}

interface SwContainerLike {
  controller: { postMessage(message: unknown, transfer: Transferable[]): void } | null;
}

/** Asks the controlling worker for its log. Resolves [] without a worker, an answer, or within 3 s. */
export function takeSwLog(container: SwContainerLike | undefined | null, setTimer: (fn: () => void, ms: number) => unknown, timeoutMs = 3_000): Promise<SwEntry[]> {
  return new Promise((resolve) => {
    const worker = container?.controller;
    if (!worker || typeof MessageChannel === 'undefined') {
      resolve([]);
      return;
    }
    let settled = false;
    const channel = new MessageChannel();
    const finish = (entries: SwEntry[]) => {
      if (settled) return;
      settled = true;
      channel.port1.onmessage = null;
      try {
        channel.port1.close();
      } catch {
        // closed already
      }
      resolve(entries);
    };
    setTimer(() => finish([]), timeoutMs);
    channel.port1.onmessage = (event: MessageEvent) => {
      try {
        finish(cleanEntries((event.data as { entries?: unknown } | null)?.entries));
      } catch {
        finish([]);
      }
    };
    try {
      worker.postMessage({ type: TEL_SW_TAKE }, [channel.port2]);
    } catch {
      finish([]);
    }
  });
}
