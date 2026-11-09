// Privacy (design §1.3, hard rule): no text from the screen or the data can leave. The whole collector runs a scripted
// session against fake elements whose text, values, labels and URLs THROW when read (fakes.ts), a store whose rows,
// toasts and message bodies throw when their personal fields are read, and planted names and phone numbers everywhere
// (tests/fixtures/canon-staff.json plus synthetic ones). Every batch it sends (fetch, gzipped, and sendBeacon) must hold
// none of them: no fixture name, no @, no UUID, no space in any string, no run of 3+ digits outside numbers.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STATUS } from '@/lib/domain';
import { startTelemetry, type TelemetryHandle } from '@/lib/client/telemetry';
import { FakeMutationObserver, el, ev, fakeBrowser, fakeHost, fakeMessaging, fakeStore, forbiddenReads, type Fakes, type FakeStore } from './fakes';

const ID = '0f0f0f0f-0000-4000-8000-000000000044';
const PLANTED = ['Quorra', 'Zyxwvut', '407 555 0199', '4075550199', '0199', 'Gate Plum', 'secret phrase plum', 'quorra@example.test'];
const FIXTURE_NAMES = [
  ...new Set(
    (JSON.parse(readFileSync(new URL('../../fixtures/canon-staff.json', import.meta.url), 'utf8')) as Array<{ input: string }>)
      .flatMap((x) => x.input.split(/[·•]/)[0]?.split(/\s+/) ?? [])
      .filter((w) => /^[A-Za-z]{3,}$/.test(w)),
  ),
];

/** An object whose listed fields throw when read (and record it). */
function trapped<T extends object>(base: T, fields: readonly string[]): T {
  const out = { ...base };
  for (const f of fields) {
    Object.defineProperty(out, f, {
      enumerable: true,
      get() {
        forbiddenReads.push(`store.${f}`);
        throw new Error(`forbidden store read: ${f}`);
      },
    });
  }
  return out;
}

const ROW_SECRETS = ['firstName', 'lastName', 'age', 'gender', 'clothing', 'lastSeen', 'hair', 'heightBuild', 'identifyingFeatures', 'physicalDescription', 'additionalNotes', 'contactName', 'contactPhone', 'contactRelationship', 'contactNotes', 'createdBy', 'updatedBy', 'medicalLocation', 'lastMessage'];

let f: Fakes;
let store: FakeStore;
let handle: TelemetryHandle;

/** Every telemetry payload sent so far, as parsed JSON. */
function payloads(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const c of f.fetchCalls) {
    if (c.url !== '/api/telemetry') continue;
    const body = c.init?.body;
    const text = typeof body === 'string' ? body : gunzipSync(Buffer.from(body as ArrayBuffer)).toString('utf8');
    out.push(JSON.parse(text) as Record<string, unknown>);
  }
  for (const b of f.beacons) out.push(JSON.parse(b.body) as Record<string, unknown>);
  return out;
}

function strings(value: unknown, key = '', acc: Array<[string, string]> = []): Array<[string, string]> {
  if (typeof value === 'string') acc.push([key, value]);
  else if (Array.isArray(value)) for (const v of value) strings(v, key, acc);
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) strings(v, k, acc);
  return acc;
}

beforeEach(() => {
  vi.useFakeTimers({ now: Date.UTC(2026, 10, 9, 3, 0, 0) });
  forbiddenReads.length = 0;
  f = fakeBrowser();
  f.storage.setItem('lp-tel-test', '1');
  f.respond = async (url) =>
    url === '/api/telemetry'
      ? new Response(JSON.stringify({ on: true, until: Date.now() + 86_400_000, flushSeconds: 60, sample: 1, now: Date.now(), rejected: 0 }), { status: 200 })
      : new Response('{}', { status: 200 });
  store = fakeStore();
});

afterEach(() => {
  handle?.stop();
  vi.useRealTimers();
});

describe('privacy: a scripted session with names and phone numbers everywhere', () => {
  it('sends events, and none of them carries any text, value, label, URL query, name or number from the screen or the data', async () => {
    const messaging = fakeMessaging();
    store.actions.messages = messaging.api;
    // The screen: every element labelled with names (unreadable), real testids and CSS-module classes.
    const names = [...PLANTED, ...FIXTURE_NAMES];
    const rows = names.slice(0, 8).map((n, i) => el('div', { 'data-testid': 'mine-card', class: 'XQsjZW_lrow', 'aria-label': `${n} row`, 'data-request-id': ID }).setSecret(`${n} · 407 555 01${i}9`));
    const list = el('div', { 'data-testid': 'request-list' }, ...rows);
    const composerInput = el('textarea', { id: '«r7»-body', 'data-testid': 'composer-input', placeholder: 'Message Quorra' }).setSecret('secret phrase plum');
    const send = el('button', { 'data-testid': 'composer-send', title: 'Send to Quorra' });
    const thread = el('div', { 'data-testid': 'thread' }, el('div', { class: 'ZUuQ-G_bubble' }).setSecret('secret phrase plum'), el('div', { 'data-testid': 'composer' }, composerInput, send));
    const nameInput = el('input', { id: '«r3»-name', value: 'Quorra Zyxwvut' });
    const phoneInput = el('input', { id: '«r3»-contactPhone', value: '407 555 0199' });
    const form = el('div', { 'data-testid': 'request-form' }, el('div', { role: 'group', 'aria-labelledby': '«r3»-person' }, nameInput), el('div', { role: 'group', 'aria-labelledby': '«r3»-friend' }, phoneInput));
    const img = el('img', { src: `/api/photos/${ID}?size=thumb`, alt: 'Quorra', class: 'XQsjZW_thumb' });
    f.body.append(el('main', {}, list, thread, form, img));

    store.set({
      confirmed: new Map([[ID, trapped({ id: ID, rowVersion: 1, status: STATUS.waiting, createdAt: new Date(Date.now() - 60_000).toISOString() }, ROW_SECRETS) as never]]),
      lastSyncLocalAt: Date.now() - 1_000,
      lastSyncAt: new Date().toISOString(),
    });
    handle = startTelemetry(fakeHost(f, store, () => ({ name: 'mine' })));
    await vi.advanceTimersByTimeAsync(50);
    expect(handle.running()).toBe(true);

    // Taps, a rage cluster, swipes with no scroll, keys, field focus, a sheet.
    const tap = (t: unknown, x: number, y: number, id: number) => {
      f.doc.dispatchEvent(ev('pointerdown', { pointerId: id, clientX: x, clientY: y, pointerType: 'touch' }, t));
      f.doc.dispatchEvent(ev('pointerup', { pointerId: id, clientX: x, clientY: y, pointerType: 'touch' }, t));
    };
    for (let i = 0; i < 4; i += 1) tap(rows[0], 20 + i, 30, i + 1);
    tap(send, 300, 700, 9);
    for (let i = 0; i < 3; i += 1) {
      f.win.dispatchEvent(ev('touchstart', { touches: [{ clientX: 100, clientY: 400 }] }, thread.children[0]));
      f.win.dispatchEvent(ev('touchmove', { touches: [{ clientX: 100, clientY: 320 }] }, thread.children[0]));
      f.win.dispatchEvent(ev('touchend', { touches: [] }, thread.children[0]));
      await vi.advanceTimersByTimeAsync(600);
    }
    f.doc.dispatchEvent(ev('keydown', { key: 'Q' }, composerInput));
    f.doc.dispatchEvent(ev('keydown', { key: 'Escape' }, list));
    f.doc.dispatchEvent(ev('focusin', {}, nameInput));
    f.doc.dispatchEvent(ev('focusin', {}, phoneInput));
    const sheet = el('div', { role: 'dialog', 'aria-label': 'Quorra Zyxwvut', class: 'lp-sheet XQsjZW_sheet' });
    const portal = el('div', {}, sheet);
    f.body.append(portal);
    FakeMutationObserver.fire([{ target: f.body, addedNodes: [portal] }]);
    await vi.advanceTimersByTimeAsync(800);
    f.body.remove(portal);
    FakeMutationObserver.fire([{ target: f.body, removedNodes: [portal] }]);
    f.win.dispatchEvent(ev('error', {}, img));

    // Errors whose messages quote data (never read), and a rejection.
    const err = new TypeError('x');
    Object.defineProperty(err, 'message', {
      get() {
        forbiddenReads.push('error.message');
        throw new Error('forbidden');
      },
    });
    err.stack = 'TypeError: Cannot read "Quorra Zyxwvut 407 555 0199"\n    at f (https://lp.test/_next/static/chunks/0sjnextxajij_.js:1:4821)';
    f.win.dispatchEvent(ev('error', { error: err, filename: 'https://lp.test/_next/static/chunks/0sjnextxajij_.js', lineno: 1, colno: 4821 }, f.win));
    f.win.dispatchEvent(ev('unhandledrejection', { reason: new SyntaxError('Unexpected token Q in "Quorra"') }, f.win));

    // App requests through the observed fetch: query values and ids never come out.
    await f.win.fetch(`/api/requests?search=Quorra%20Zyxwvut`);
    await f.win.fetch(`/api/requests/${ID}/messages`, { method: 'POST', body: JSON.stringify({ body: 'secret phrase plum' }) });

    // Store activity: toasts with names in their text, an outbox job with a payload, a message job with a body.
    const prev = store.getState();
    store.set({
      toasts: [trapped({ id: 't1', tone: 'red', icon: 'alert', durationMs: null } as never, ['title', 'subtitle'])],
      outbox: [trapped({ mutationId: 'mmmm', photos: [], serverId: null, caseNumber: null, state: 'pending', attempts: 0, nextAttemptAt: null, lastError: null, createdAt: Date.now(), source: 'app' } as never, ['payload', 'operator'])],
      syncing: true,
    });
    // The store's own order: the sync saves its time, then syncing goes false in its own patch.
    store.set({ lastSyncLocalAt: Date.now(), lastSyncAt: new Date().toISOString() });
    store.set({ syncing: false, toasts: [], outbox: [] });
    void prev;
    messaging.set({ threads: new Map(), jobs: [trapped({ id: 'job1', kind: 'message', requestId: ID, createdAt: Date.now(), state: 'pending', attempts: 0, nextAttemptAt: null, error: null } as never, ['body', 'operator'])] });
    messaging.set({ threads: new Map(), jobs: [] });

    // Quiet for a while: a send; then the page hides: a beacon.
    await vi.advanceTimersByTimeAsync(65_000);
    f.doc.visibilityState = 'hidden';
    f.doc.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(10);

    const sent = payloads();
    expect(sent.length).toBeGreaterThanOrEqual(2);
    const events = sent.flatMap((p) => p.ev as Array<{ n: string }>);
    const names_ = new Set(events.map((e) => e.n));
    for (const n of ['app_start', 'view', 'tap', 'rage_tap', 'swipe', 'stuck_scroll', 'key', 'field', 'sheet', 'error', 'net', 'img_fail', 'vis']) expect(names_, n).toContain(n);

    // Nothing forbidden was ever read.
    expect(forbiddenReads).toEqual([]);

    const text = JSON.stringify(sent).toLowerCase();
    // Planted values: not even as a substring. Fixture names: not as a word (a 3-letter name like "Old" is part of
    // ordinary tokens such as closed-fold).
    for (const secret of PLANTED) {
      for (const word of secret.toLowerCase().split(/\s+/).filter((w) => w.length >= 3)) expect(text.includes(word), `payload contains "${word}"`).toBe(false);
    }
    for (const name of FIXTURE_NAMES) expect(new RegExp(`\\b${name.toLowerCase()}\\b`).test(text), `payload contains the name "${name}"`).toBe(false);
    expect(text).not.toContain('@');
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(text).not.toContain('555');
    for (const p of sent) {
      for (const [key, value] of strings(p.ev)) {
        expect(value, `${key}: "${value}"`).not.toMatch(/\s/);
        // Digit runs: only status codes (st) may hold them (fingerprints and chunk hashes are letters), and nothing
        // reaches the 4 digits the server refuses.
        expect(value, `${key}: "${value}"`).not.toMatch(/\d{4,}/);
        if (key === 'st') continue;
        expect(value, `${key}: "${value}"`).not.toMatch(/\d{3,}/);
      }
    }
  });
});
