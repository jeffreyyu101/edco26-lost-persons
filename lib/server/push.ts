// Web Push (F4, spec §18 A54): the VAPID keys, which push services a subscription may point at, and the
// sends. Server only. Uses the `web-push` package (pinned) for VAPID signing and aes128gcm encryption.
//
//   * VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT (mailto: or https:) switch push on. Missing or
//     invalid → push is off, silently: no subscription is stored, no push is sent, and the client never
//     shows the alerts banner. NEXT_PUBLIC_VAPID_PUBLIC_KEY is read as the public key when VAPID_PUBLIC_KEY
//     is not set (the client gets the key from POST /api/push/prefs either way).
//   * A subscription's endpoint must be https on a known push service (Chrome / Android: FCM; Firefox:
//     Mozilla; Safari and iOS: Apple; Edge: Windows). Anything else is refused, so the server never posts to
//     an address a client made up. Local test endpoints (https://127.0.0.1) are allowed only with
//     LP_PUSH_ALLOW_LOCAL=1 AND a local Supabase URL, which production never has.
//   * Each push: a timeout, TTL and urgency by kind, the payload (well under 4 KB) encrypted per device.
//     404 / 410 → the subscription is gone; anything else failed (lp_push_result counts it).
//   * Never logs an endpoint, a key or a payload.
import 'server-only';
import { Agent } from 'node:https';
import webpush from 'web-push';
import { PUSH_PAYLOAD_MAX_BYTES, type PushPayload, type PushUrgency } from '../activity';
import { readEnv } from './env';

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
  /** Canonical staff string (whose device it is). */
  staff: string;
}

export type PushResult = 'ok' | 'gone' | 'failed';

export interface PushOutcome {
  endpoint: string;
  result: PushResult;
  /** HTTP status from the push service, or null (timeout, network). */
  status: number | null;
}

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/** How long one push may take before it counts as failed. */
export const PUSH_TIMEOUT_MS = 5_000;

const b64urlBytes = (value: string): number | null => {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return null;
  return Buffer.from(value.replace(/=+$/, ''), 'base64url').length;
};

let cachedConfig: { key: string; value: VapidConfig | null } | null = null;

/** The VAPID keys, or null when push is off (missing or malformed). */
export function vapidConfig(): VapidConfig | null {
  const publicKey = readEnv('VAPID_PUBLIC_KEY') ?? readEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY');
  const privateKey = readEnv('VAPID_PRIVATE_KEY');
  const subject = readEnv('VAPID_SUBJECT');
  const key = `${publicKey ?? ''}|${privateKey ? privateKey.length : 0}|${subject ?? ''}`;
  if (cachedConfig && cachedConfig.key === key) return cachedConfig.value;
  let value: VapidConfig | null = null;
  if (publicKey && privateKey && subject) {
    const okSubject = /^mailto:[^\s@]+@[^\s@]+$/i.test(subject) || /^https:\/\/[^\s]+$/i.test(subject);
    if (b64urlBytes(publicKey) === 65 && b64urlBytes(privateKey) === 32 && okSubject) {
      value = { publicKey: publicKey.replace(/=+$/, ''), privateKey: privateKey.replace(/=+$/, ''), subject };
    } else {
      console.warn(JSON.stringify({ lp: 'push', code: 'vapid_invalid' }));
    }
  }
  cachedConfig = { key, value };
  return value;
}

export function pushEnabled(): boolean {
  return vapidConfig() !== null;
}

/** For tests only. */
export function resetPushConfigCache(): void {
  cachedConfig = null;
}

/** Push services the browsers use (host suffixes). */
const PUSH_HOSTS = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'push.services.mozilla.com',
  'push.apple.com',
  'notify.windows.com',
] as const;

function localSupabase(): boolean {
  const url = readEnv('NEXT_PUBLIC_SUPABASE_URL');
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return host === '127.0.0.1' || host === 'localhost';
  } catch {
    return false;
  }
}

/** Test endpoints on this machine (integration and end-to-end tests only; never in production). */
export function localEndpointsAllowed(): boolean {
  return readEnv('LP_PUSH_ALLOW_LOCAL') === '1' && localSupabase();
}

function isLocalHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}

/** Whether the server may post to this endpoint. */
export function isAllowedEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (isLocalHost(host)) return localEndpointsAllowed();
  if (url.port && url.port !== '443') return false;
  return PUSH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

let localAgent: Agent | null = null;

/** A self-signed local test push service is trusted only in local test mode. */
function agentFor(endpoint: string): Agent | undefined {
  try {
    if (!isLocalHost(new URL(endpoint).hostname) || !localEndpointsAllowed()) return undefined;
  } catch {
    return undefined;
  }
  localAgent ??= new Agent({ rejectUnauthorized: false });
  return localAgent;
}

export interface SendOptions {
  ttl: number;
  urgency: PushUrgency;
  timeoutMs?: number;
}

function resultOf(status: number | null): PushResult {
  if (status !== null && status >= 200 && status < 300) return 'ok';
  if (status === 404 || status === 410) return 'gone';
  return 'failed';
}

/**
 * Sends one payload per target, all at once, each bounded by a timeout. One push per device: a target
 * listed twice (same endpoint) is sent once. Never throws.
 */
export async function sendPushes(
  targets: readonly PushTarget[],
  payloadFor: (target: PushTarget) => PushPayload,
  options: SendOptions,
): Promise<PushOutcome[]> {
  const vapid = vapidConfig();
  if (!vapid) return [];
  const seen = new Set<string>();
  const unique = targets.filter((t) => {
    if (!t || typeof t.endpoint !== 'string' || seen.has(t.endpoint)) return false;
    seen.add(t.endpoint);
    return true;
  });
  const timeoutMs = options.timeoutMs ?? PUSH_TIMEOUT_MS;
  return Promise.all(
    unique.map(async (target): Promise<PushOutcome> => {
      if (!isAllowedEndpoint(target.endpoint)) return { endpoint: target.endpoint, result: 'gone', status: null };
      let body: string;
      try {
        body = JSON.stringify(payloadFor(target));
      } catch {
        return { endpoint: target.endpoint, result: 'failed', status: null };
      }
      if (Buffer.byteLength(body) > PUSH_PAYLOAD_MAX_BYTES) return { endpoint: target.endpoint, result: 'failed', status: 413 };
      const agent = agentFor(target.endpoint);
      // An async wrapper: a malformed key throws synchronously inside web-push.
      const send = (async () =>
        webpush.sendNotification({ endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } }, body, {
          vapidDetails: vapid,
          TTL: options.ttl,
          urgency: options.urgency,
          timeout: timeoutMs,
          contentEncoding: 'aes128gcm',
          ...(agent ? { agent } : {}),
        }))().then(
          (res) => ({ endpoint: target.endpoint, result: resultOf(res.statusCode), status: res.statusCode }) satisfies PushOutcome,
          (error: unknown) => {
            const status = typeof (error as { statusCode?: unknown })?.statusCode === 'number' ? (error as { statusCode: number }).statusCode : null;
            return { endpoint: target.endpoint, result: status === null ? 'failed' : resultOf(status), status } satisfies PushOutcome;
          },
        );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<PushOutcome>((resolve) => {
        timer = setTimeout(() => resolve({ endpoint: target.endpoint, result: 'failed', status: null }), timeoutMs + 500);
      });
      try {
        return await Promise.race([send, timeout]);
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}

/** Outcomes grouped for lp_push_result. */
export function groupOutcomes(outcomes: readonly PushOutcome[]): { ok: string[]; gone: string[]; failed: string[] } {
  const out = { ok: [] as string[], gone: [] as string[], failed: [] as string[] };
  for (const o of outcomes) out[o.result === 'ok' ? 'ok' : o.result === 'gone' ? 'gone' : 'failed'].push(o.endpoint);
  return out;
}
