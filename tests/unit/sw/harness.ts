// Runs public/sw.js in a vm context with an in-memory Cache Storage, a fake network and fake window
// clients, so its install / activate / fetch / message handlers can be driven event by event. Synthetic
// builds only: every file name and page body here is made up.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export const ORIGIN = 'https://lp.test';
const SOURCE_PATH = new URL('../../../public/sw.js', import.meta.url);

type Input = string | { url: string };

function urlOf(input: Input): URL {
  return new URL(typeof input === 'string' ? input : input.url, ORIGIN);
}

/** Path + query of a request or URL. */
export function keyOf(input: Input): string {
  const url = urlOf(input);
  return `${url.pathname}${url.search}`;
}

/** Responses a same-origin fetch or a cache hit gives a service worker are "basic". */
function basic(res: Response): Response {
  Object.defineProperty(res, 'type', { value: 'basic' });
  return res;
}

interface Stored {
  body: ArrayBuffer;
  status: number;
  headers: [string, string][];
}

export class FakeCache {
  readonly entries = new Map<string, Stored>();

  async match(input: Input, options?: { ignoreSearch?: boolean }): Promise<Response | undefined> {
    let hit = this.entries.get(keyOf(input));
    if (!hit && options?.ignoreSearch) {
      const path = urlOf(input).pathname;
      for (const [key, value] of this.entries) {
        if (urlOf(key).pathname === path) {
          hit = value;
          break;
        }
      }
    }
    return hit ? basic(new Response(hit.body.slice(0), { status: hit.status, headers: hit.headers })) : undefined;
  }

  async put(input: Input, res: Response): Promise<void> {
    const body = await res.arrayBuffer();
    this.entries.set(keyOf(input), { body, status: res.status, headers: [...res.headers] });
  }

  has(path: string): boolean {
    return this.entries.has(path);
  }

  async text(path: string): Promise<string | null> {
    const res = await this.match(path);
    return res ? res.text() : null;
  }
}

export class FakeCacheStorage {
  readonly map = new Map<string, FakeCache>();

  async open(name: string): Promise<FakeCache> {
    let cache = this.map.get(name);
    if (!cache) {
      cache = new FakeCache();
      this.map.set(name, cache);
    }
    return cache;
  }

  async keys(): Promise<string[]> {
    return [...this.map.keys()];
  }

  async delete(name: string): Promise<boolean> {
    return this.map.delete(name);
  }

  async has(name: string): Promise<boolean> {
    return this.map.has(name);
  }

  /** Names of the version caches (`lp-…`), in creation order. */
  versions(): string[] {
    return [...this.map.keys()].filter((n) => n.startsWith('lp-'));
  }

  get(name: string): FakeCache | undefined {
    return this.map.get(name);
  }
}

export interface Route {
  body: string;
  status?: number;
  contentType?: string;
}

export class FakeNetwork {
  online = true;
  readonly routes = new Map<string, Route>();
  /** Every path + query fetched, in order (also while offline). */
  readonly log: string[] = [];
  private remaining: number | null = null;

  /** The signal drops after `n` more requests. */
  dropAfter(n: number): void {
    this.remaining = n;
  }

  readonly fetch = async (input: Input): Promise<Response> => {
    const key = keyOf(input);
    this.log.push(key);
    if (this.remaining !== null) {
      if (this.remaining <= 0) this.online = false;
      else this.remaining -= 1;
    }
    if (!this.online) throw new TypeError('Failed to fetch');
    const route = this.routes.get(key);
    if (!route) return basic(new Response('not found', { status: 404 }));
    return basic(new Response(route.body, { status: route.status ?? 200, headers: { 'content-type': route.contentType ?? 'text/plain' } }));
  };

  fetched(path: string): boolean {
    return this.log.includes(path);
  }

  clearLog(): void {
    this.log.length = 0;
  }
}

/** A synthetic Next build: `/`, `/signin`, CORE, its chunks and its /sw-manifest.json. */
export interface Build {
  tag: string;
  shellChunk: string;
  /** Loaded only through next/dynamic: no page's HTML names it. */
  viewChunk: string;
  signInChunk: string;
  css: string;
  font: string;
  /** The same file in every build (an unchanged, content-hashed chunk). */
  shared: string;
  assets: string[];
  shellHtml: string;
}

export const CORE = [
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png',
  '/logos/edc-orlando.png',
  '/logos/ground-control.png',
];

export function makeBuild(tag: string): Build {
  const shellChunk = `/_next/static/chunks/shell-${tag}.js`;
  const viewChunk = `/_next/static/chunks/view-${tag}.js`;
  const signInChunk = `/_next/static/chunks/signin-${tag}.js`;
  const css = `/_next/static/chunks/app-${tag}.css`;
  const font = `/_next/static/media/inter-${tag}.woff2`;
  const shared = '/_next/static/chunks/framework-0000.js';
  const shellHtml = `<!DOCTYPE html><html><head><link rel="stylesheet" href="${css}"/><script src="${shared}" async=""></script><script src="${shellChunk}" async=""></script></head><body>shell ${tag}</body></html>`;
  return {
    tag,
    shellChunk,
    viewChunk,
    signInChunk,
    css,
    font,
    shared,
    assets: [shared, shellChunk, viewChunk, signInChunk, css, font, `/_next/static/build-${tag}/_buildManifest.js`].sort(),
    shellHtml,
  };
}

export function serve(network: FakeNetwork, build: Build, options: { manifest?: boolean } = {}): void {
  network.routes.clear();
  network.routes.set('/', { body: build.shellHtml, contentType: 'text/html' });
  network.routes.set('/signin', {
    body: `<!DOCTYPE html><html><head><link rel="stylesheet" href="${build.css}"/><script src="${build.shared}"></script><script src="${build.signInChunk}"></script></head><body>signin ${build.tag}</body></html>`,
    contentType: 'text/html',
  });
  for (const path of CORE) network.routes.set(path, { body: `core ${path}` });
  for (const path of build.assets) {
    const body = path.endsWith('.css') ? `@font-face{src:url(${build.font}) format("woff2")}` : `asset ${path === build.shared ? 'shared' : build.tag} ${path}`;
    network.routes.set(path, { body });
  }
  if (options.manifest !== false) network.routes.set('/sw-manifest.json', { body: JSON.stringify({ assets: build.assets }), contentType: 'application/json' });
}

export interface PageClient {
  id: string;
  /** Window clients (notification clicks): the page's URL, focus state and WindowClient methods. */
  url?: string;
  focused?: boolean;
  focus?: () => Promise<PageClient | null>;
  navigate?: (url: string) => Promise<PageClient | null>;
  postMessage?: (message: unknown, transfer?: unknown[]) => void;
}

type Listener = (event: Record<string, unknown>) => void;

export interface Worker {
  version: string;
  cacheName: string;
  pages: PageClient[];
  registration: { active: { scriptURL: string } | null; waiting: { scriptURL: string } | null; installing: { scriptURL: string } | null };
  skipWaitingCalls(): number;
  install(): Promise<void>;
  activate(): Promise<void>;
  /** A fetch event. Resolves to the response (undefined when the worker passes it through) once every waitUntil settled. */
  fetch(path: string, mode?: 'navigate' | 'no-cors' | 'cors'): Promise<Response | undefined>;
  message(data: unknown): Promise<unknown>;
  /** A click on a notification carrying `data`. Resolves once every waitUntil settled. */
  notificationClick(data: unknown): Promise<{ closed: boolean }>;
  /** URLs passed to clients.openWindow, in order. */
  opened: string[];
}

export function scriptUrl(version: string): string {
  return `${ORIGIN}/sw.js?v=${encodeURIComponent(version)}`;
}

/** Evaluate public/sw.js as the worker for `version`. `pages` is live: push or splice to open or close tabs. */
export function loadWorker(options: {
  version: string;
  caches: FakeCacheStorage;
  network: FakeNetwork;
  active?: string | null;
  waiting?: string | null;
  installing?: string | null;
  pages?: PageClient[];
}): Worker {
  const listeners = new Map<string, Listener[]>();
  const pages = options.pages ?? [];
  const worker = (v: string | null | undefined) => (v ? { scriptURL: scriptUrl(v) } : null);
  const registration = { active: worker(options.active), waiting: worker(options.waiting), installing: worker(options.installing) };
  let skipped = 0;
  const opened: string[] = [];
  const self = {
    location: new URL(scriptUrl(options.version)),
    registration,
    clients: {
      matchAll: async () => pages.slice(),
      get: async (id: string) => pages.find((p) => p.id === id),
      claim: async () => undefined,
      openWindow: async (url: string) => {
        opened.push(url);
        return null;
      },
    },
    skipWaiting: async () => {
      skipped += 1;
    },
    addEventListener: (type: string, fn: Listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
  };
  vm.runInNewContext(readFileSync(SOURCE_PATH, 'utf8'), {
    self,
    caches: options.caches,
    fetch: options.network.fetch,
    URL,
    Response,
    Headers,
    setTimeout,
    clearTimeout,
    MessageChannel,
    console,
  });

  const dispatch = async (type: string, extra: Record<string, unknown> = {}) => {
    const waits: Promise<unknown>[] = [];
    const event: Record<string, unknown> = { ...extra, waitUntil: (p: unknown) => waits.push(Promise.resolve(p)) };
    for (const fn of listeners.get(type) ?? []) fn(event);
    await Promise.all(waits);
    return event;
  };

  return {
    version: options.version,
    cacheName: `lp-${options.version}`,
    pages,
    registration,
    skipWaitingCalls: () => skipped,
    install: async () => {
      await dispatch('install');
    },
    activate: async () => {
      await dispatch('activate');
    },
    fetch: async (path, mode = 'no-cors') => {
      let responded: Promise<Response> | undefined;
      const waits: Promise<unknown>[] = [];
      const event = {
        request: { url: `${ORIGIN}${path}`, method: 'GET', mode },
        respondWith: (p: Promise<Response>) => {
          responded = p;
        },
        waitUntil: (p: unknown) => waits.push(Promise.resolve(p)),
      };
      for (const fn of listeners.get('fetch') ?? []) fn(event);
      const response = responded ? await responded : undefined;
      await Promise.all(waits);
      return response;
    },
    message: async (data) => {
      let reply: unknown;
      await dispatch('message', { data, ports: [{ postMessage: (m: unknown) => (reply = m) }] });
      return reply;
    },
    notificationClick: async (data) => {
      let closed = false;
      await dispatch('notificationclick', { notification: { data, close: () => (closed = true) } });
      return { closed };
    },
    opened,
  };
}

/** A phone that ran build `tag`'s first install and activation: its worker controls the open pages. */
export async function firstInstall(caches: FakeCacheStorage, network: FakeNetwork, build: Build, pages: PageClient[]): Promise<Worker> {
  serve(network, build);
  const worker = loadWorker({ version: build.tag, caches, network, pages });
  await worker.install();
  worker.registration.active = { scriptURL: scriptUrl(build.tag) };
  await worker.activate();
  return worker;
}
