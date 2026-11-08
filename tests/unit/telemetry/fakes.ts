// Fakes for the telemetry collector's unit tests (node environment, no jsdom): elements whose text, values, labels and
// URLs THROW when read (so every test proves the collector never touches them), a window and a document that are
// EventTargets, a MutationObserver the test can feed, and a store whose state the test sets. Synthetic data only.
import type { AlertEvent, StoreState } from '@/lib/client/store-contract';
import { createServerState } from '@/lib/client/store-contract';
import type { MessagingApi, MessagingSnapshot } from '@/lib/client/messages-core';
import type { BatchStore, StoredBatch } from '@/lib/client/telemetry/buffer';
import type { TelHost } from '@/lib/client/telemetry/host';

const FORBIDDEN_PROPS = ['textContent', 'innerText', 'innerHTML', 'outerHTML', 'value', 'title', 'alt', 'placeholder', 'src', 'href', 'label', 'ariaLabel', 'nodeValue', 'data'] as const;
const FORBIDDEN_ATTRS = new Set(['aria-label', 'aria-description', 'title', 'alt', 'placeholder', 'href', 'src', 'value', 'aria-valuetext']);

/** Reads that must never happen (each one is recorded before it throws). */
export const forbiddenReads: string[] = [];

export class FakeEl {
  readonly nodeType = 1;
  tagName: string;
  id = '';
  className = '';
  parentElement: FakeEl | null = null;
  children: FakeEl[] = [];
  disabled = false;
  isContentEditable = false;
  private attrs = new Map<string, string>();
  /** What a reader must never see (text, a value, a label): any read throws. */
  readonly secret: Record<string, string> = {};

  constructor(tag: string, attrs: Record<string, string> = {}) {
    this.tagName = tag.toUpperCase();
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') this.className = v;
      else if (k === 'id') this.id = v;
      else this.attrs.set(k, v);
    }
    for (const prop of FORBIDDEN_PROPS) {
      Object.defineProperty(this, prop, {
        get: () => {
          forbiddenReads.push(`${tag}.${prop}`);
          throw new Error(`forbidden read: ${prop}`);
        },
        configurable: true,
      });
    }
  }

  getAttribute(name: string): string | null {
    if (FORBIDDEN_ATTRS.has(name)) {
      forbiddenReads.push(`getAttribute(${name})`);
      throw new Error(`forbidden attribute read: ${name}`);
    }
    if (name === 'class') return this.className || null;
    if (name === 'id') return this.id || null;
    return this.attrs.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return name === 'class' ? !!this.className : name === 'id' ? !!this.id : this.attrs.has(name);
  }

  /** The secret (a name, a phone number) this element shows; unreadable through every DOM accessor. */
  setSecret(text: string): this {
    this.secret.text = text;
    if (FORBIDDEN_ATTRS.has('aria-label')) this.attrs.set('__aria-label-secret', text);
    return this;
  }

  append(...kids: FakeEl[]): this {
    for (const k of kids) {
      k.parentElement = this;
      this.children.push(k);
    }
    return this;
  }

  remove(child: FakeEl): void {
    this.children = this.children.filter((c) => c !== child);
    child.parentElement = null;
  }

  contains(other: unknown): boolean {
    for (let n = other as FakeEl | null; n; n = n.parentElement) if (n === this) return true;
    return false;
  }

  querySelector(selector: string): FakeEl | null {
    const roles = [...selector.matchAll(/\[role=([a-z]+)\]/g)].map((m) => m[1]);
    const classes = [...selector.matchAll(/\.([a-z0-9-]+)/g)].map((m) => m[1]);
    const walk = (n: FakeEl): FakeEl | null => {
      for (const c of n.children) {
        if (roles.length && roles.includes(c.attrs.get('role') ?? '')) return c;
        if (classes.length && classes.some((cl) => c.className.split(/\s+/).includes(cl as string))) return c;
        const deep = walk(c);
        if (deep) return deep;
      }
      return null;
    };
    return walk(this);
  }
}

/** el('button', {'data-testid': 'x'}, child, …) */
export function el(tag: string, attrs: Record<string, string> = {}, ...kids: FakeEl[]): FakeEl {
  return new FakeEl(tag, attrs).append(...kids);
}

export class FakeMutationObserver {
  static all: FakeMutationObserver[] = [];
  target: unknown = null;
  options: MutationObserverInit = {};
  connected = false;
  constructor(readonly cb: (records: unknown[]) => void) {
    FakeMutationObserver.all.push(this);
  }
  observe(target: unknown, options: MutationObserverInit): void {
    this.target = target;
    this.options = options;
    this.connected = true;
  }
  disconnect(): void {
    this.connected = false;
  }
  /** Delivers records to every connected observer of `target` (subtree ones too). */
  static fire(records: Array<{ target: unknown; addedNodes?: unknown[]; removedNodes?: unknown[] }>): void {
    for (const mo of FakeMutationObserver.all.filter((m) => m.connected)) {
      mo.cb(records.map((r) => ({ addedNodes: [], removedNodes: [], ...r })));
    }
  }
}

export class FakeStorage {
  map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v));
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

export interface FakeWindow extends EventTarget {
  [key: string]: unknown;
}

export interface Fakes {
  win: Window & Record<string, unknown>;
  doc: Document & { body: FakeEl; visibilityState: string };
  body: FakeEl;
  storage: FakeStorage;
  beacons: Array<{ url: string; body: string }>;
  fetchCalls: Array<{ url: string; init: RequestInit | undefined }>;
  /** What the page's own fetch answers. */
  respond: (url: string, init: RequestInit | undefined) => Promise<Response>;
  nav: Record<string, unknown>;
}

/** A window + document pair. Timers are the global ones (vi.useFakeTimers drives them). */
export function fakeBrowser(opts: { width?: number; ua?: string; standalone?: boolean; noCompressionStream?: boolean } = {}): Fakes {
  FakeMutationObserver.all = [];
  const storage = new FakeStorage();
  const body = el('body');
  const beacons: Fakes['beacons'] = [];
  const fetchCalls: Fakes['fetchCalls'] = [];
  const nav: Record<string, unknown> = {
    userAgent: opts.ua ?? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
    maxTouchPoints: 5,
    onLine: true,
    standalone: opts.standalone ?? true,
    webdriver: false,
    sendBeacon: (url: string, body: string) => {
      beacons.push({ url, body });
      return true;
    },
  };
  const fakes = {} as Fakes;
  const win = new EventTarget() as unknown as Window & Record<string, unknown>;
  const doc = new EventTarget() as unknown as Document & { body: FakeEl; visibilityState: string };
  Object.assign(doc, { body, documentElement: el('html'), visibilityState: 'visible', scrollingElement: null, querySelector: (s: string) => body.querySelector(s) });
  fakes.respond = async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  Object.assign(win, {
    navigator: nav,
    location: { origin: 'https://lp.test', href: 'https://lp.test/', pathname: '/' },
    innerWidth: opts.width ?? 390,
    innerHeight: 844,
    devicePixelRatio: 3,
    localStorage: storage,
    MutationObserver: FakeMutationObserver,
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms) as unknown as number,
    clearTimeout: (id: number) => clearTimeout(id),
    setInterval: (fn: () => void, ms?: number) => setInterval(fn, ms) as unknown as number,
    clearInterval: (id: number) => clearInterval(id),
    performance: { timeOrigin: Date.now(), getEntriesByType: () => [], getEntriesByName: () => [] },
    matchMedia: () => ({ matches: opts.standalone ?? true }),
    getComputedStyle: () => ({ cursor: 'auto', overflowY: 'visible' }),
    fetch: (url: string, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return fakes.respond(String(url), init);
    },
  });
  // Safari 16.4+ (the default iPhone here) has CompressionStream; an older one doesn't.
  if (!opts.noCompressionStream) Object.assign(win, { CompressionStream: class {} });
  Object.assign(fakes, { win, doc, body, storage, beacons, fetchCalls, nav });
  return fakes;
}

/** A pointer / touch / key event with the given properties (a plain Event plus fields). */
export function ev(type: string, props: Record<string, unknown> = {}, target?: unknown): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  for (const [k, v] of Object.entries(props)) Object.defineProperty(e, k, { value: v, configurable: true });
  if (target !== undefined) Object.defineProperty(e, 'target', { value: target, configurable: true });
  return e;
}

export interface FakeStore {
  getState(): StoreState;
  subscribe(listener: () => void): () => void;
  actions: { messages?: MessagingApi; subscribeAlerts(listener: (a: AlertEvent) => void): () => void };
  set(patch: Partial<StoreState>): void;
  alert(a: AlertEvent): void;
  listeners: Set<() => void>;
}

export function fakeStore(initial: Partial<StoreState> = {}): FakeStore {
  let state: StoreState = {
    ...createServerState('America/New_York'),
    hydrated: true,
    hasData: true,
    session: { status: 'active', staffName: 'TEST-u Quorra Zyxwvut', team: 'Medical', staff: 'TEST-u Quorra Zyxwvut · Medical', expiresAt: null },
    ...initial,
  };
  const listeners = new Set<() => void>();
  const alerts = new Set<(a: AlertEvent) => void>();
  return {
    listeners,
    getState: () => state,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    actions: {
      subscribeAlerts: (l) => {
        alerts.add(l);
        return () => alerts.delete(l);
      },
    },
    set(patch) {
      state = { ...state, ...patch };
      for (const l of [...listeners]) l();
    },
    alert(a) {
      for (const l of [...alerts]) l(a);
    },
  };
}

export function fakeMessaging(initial: MessagingSnapshot = { threads: new Map(), jobs: [] }) {
  let snap = initial;
  const listeners = new Set<() => void>();
  const api = {
    getSnapshot: () => snap,
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  } as unknown as MessagingApi;
  return {
    api,
    set(next: MessagingSnapshot) {
      snap = next;
      for (const l of [...listeners]) l();
    },
  };
}

export class MemoryBatchStore implements BatchStore {
  map = new Map<string, StoredBatch>();
  async all() {
    return [...this.map.values()].map((b) => structuredClone(b));
  }
  async put(b: StoredBatch) {
    this.map.set(b.b, structuredClone(b));
  }
  async del(ids: readonly string[]) {
    for (const id of ids) this.map.delete(id);
  }
  async clear() {
    this.map.clear();
  }
}

export function fakeHost(f: Fakes, store: FakeStore, view: () => { name: string } = () => ({ name: 'all' }), batches: BatchStore | null = new MemoryBatchStore()): TelHost {
  return { win: f.win, doc: f.doc as unknown as Document, store, view, now: () => Date.now(), batchStore: async () => batches };
}
