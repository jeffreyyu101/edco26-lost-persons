// A fake Web Push service for the integration tests (F4): an HTTPS server on 127.0.0.1 with a throwaway
// self-signed certificate. The server under test posts to it only because .env.test sets LP_PUSH_ALLOW_LOCAL=1
// with a local Supabase URL (lib/server/push.ts). Each fake device has a real P-256 key pair and auth secret,
// so every push is decrypted here exactly as a browser would (aes128gcm, http_ece) and its JSON checked.
// Per device the service answers 201 (delivered), 410 (gone), 500 (failed) or never (hang).
import { execFileSync } from 'node:child_process';
import { createECDH, randomBytes, type ECDH } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const ece = require('http_ece') as { decrypt(buffer: Buffer, params: { version: string; privateKey: ECDH; authSecret: Buffer }): Buffer };

export type DeviceMode = 'ok' | 'gone' | 'fail' | 'hang';

export interface Delivery {
  payload: Record<string, unknown>;
  ttl: string | null;
  urgency: string | null;
  at: number;
}

export interface FakeDevice {
  name: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  deliveries: Delivery[];
  mode: DeviceMode;
}

export interface PushService {
  origin: string;
  device(name?: string): FakeDevice;
  /** Every request the service received (decrypted or not), for "nothing was pushed" checks. */
  hits(): number;
  close(): Promise<void>;
}

export async function startPushService(): Promise<PushService> {
  const dir = mkdtempSync(join(tmpdir(), 'lp-push-'));
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=127.0.0.1'],
    { stdio: 'ignore' },
  );
  const key = readFileSync(join(dir, 'key.pem'));
  const cert = readFileSync(join(dir, 'cert.pem'));
  rmSync(dir, { recursive: true, force: true });

  const devices = new Map<string, FakeDevice & { ecdh: ECDH; secret: Buffer }>();
  let hits = 0;
  const hanging = new Set<() => void>();

  const server: Server = createServer({ key, cert }, (req, res) => {
    hits += 1;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const name = decodeURIComponent((req.url ?? '').replace(/^\/push\//, ''));
      const d = devices.get(name);
      if (!d) {
        res.writeHead(404).end();
        return;
      }
      if (d.mode === 'hang') {
        hanging.add(() => res.destroy());
        return;
      }
      try {
        const plain = ece.decrypt(Buffer.concat(chunks), { version: 'aes128gcm', privateKey: d.ecdh, authSecret: d.secret });
        d.deliveries.push({
          payload: JSON.parse(plain.toString('utf8')) as Record<string, unknown>,
          ttl: (req.headers.ttl as string | undefined) ?? null,
          urgency: (req.headers.urgency as string | undefined) ?? null,
          at: Date.now(),
        });
      } catch {
        res.writeHead(400).end();
        return;
      }
      res.writeHead(d.mode === 'gone' ? 410 : d.mode === 'fail' ? 500 : 201).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const origin = `https://127.0.0.1:${port}`;
  let n = 0;

  return {
    origin,
    device(name) {
      n += 1;
      const id = name ?? `d${Date.now().toString(36)}${n}`;
      const ecdh = createECDH('prime256v1');
      ecdh.generateKeys();
      const secret = randomBytes(16);
      const d = {
        name: id,
        endpoint: `${origin}/push/${encodeURIComponent(id)}`,
        keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: secret.toString('base64url') },
        deliveries: [] as Delivery[],
        mode: 'ok' as DeviceMode,
        ecdh,
        secret,
      };
      devices.set(id, d);
      return d;
    },
    hits: () => hits,
    async close() {
      for (const end of hanging) end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Polls `check` until it returns a value (not undefined / false) or the time runs out. */
export async function eventually<T>(check: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 8_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = await check();
    if (v !== undefined && v !== false) return v as T;
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 100));
  }
}
