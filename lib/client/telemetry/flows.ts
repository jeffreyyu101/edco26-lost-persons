// Timed flows (design §1.4 "Flows"): measured on the device from the store's public state, the messages engine, the
// view, taps and field focus, the request starts and ends the fetch observer sees, alerts and the service worker's
// log. Request ids, message ids and rows never leave the phone: only durations, counts and enums do. Pure apart from
// the env it is given (its clock included), so tests drive it with snapshots.
import type { RequestSummary } from '../../api-types';
import { STATUS } from '../../domain';
import type { AlertEvent, StoreState } from '../store-contract';
import type { MessagingSnapshot } from '../messages-core';
import type { Props, TelEvent } from './buffer';
import { SLOW_MS } from './detect';
import type { NetEnd, NetStart } from './net';
import type { SwEntry } from './sw';

export interface FlowEnv {
  now(): number;
  /** performance.timeOrigin (epoch ms): the page's launch. */
  timeOrigin: number;
  visible(): boolean;
  desk(): boolean;
  /** Emits a flow event (the collector adds the view). */
  emit(e: TelEvent): void;
  /** A slow flow segment (a frustration event, with a trail). */
  slow(what: string, a: string, ms: number, p?: Props): void;
}

/** Status database value → its key (STATUS's own names, snake case). */
export const STATUS_KEY: Readonly<Record<string, string>> = {
  [STATUS.waiting]: 'waiting',
  [STATUS.notInMedical]: 'not_found',
  [STATUS.inMedical]: 'in_medical',
  [STATUS.reunited]: 'reunited',
  [STATUS.discharged]: 'discharged',
  [STATUS.cancelled]: 'cancelled',
  [STATUS.legacyBringFriend]: 'in_medical',
  [STATUS.inactive]: 'closed_inactive',
};

const OPEN_WAIT_MS = 30_000;
const RESUME_WAIT_MS = 30_000;
const SUBMIT_LINK_MS = 3_000;
const ALERT_TOAST_MS = 2_000;
const ALERT_PUSH_MS = 60_000;
const ALERT_RECENT_MS = 15 * 60_000;
const ALERT_MAX_WAIT_MS = 10 * 60_000;
const PUSH_SHOW_MS = 15_000;
const READ_WATCH_MS = 30 * 60_000;
const SECTIONS = ['post', 'person', 'more', 'friend', 'photo'] as const;

type Section = (typeof SECTIONS)[number];

interface NewFlow {
  t: number;
  from: string;
  dwell: Record<Section, number>;
  cur: Section | null;
  curAt: number;
  fields: Set<string>;
  photos: number;
  inval: number;
  submitAt: number | null;
}

interface SubmitFlow {
  t: number;
  offline: boolean;
  tries: number;
  photos: number;
  created: boolean;
}

interface AnswerFlow {
  mutationId: string;
  kind: string;
  startedAt: number;
  to?: string;
  baseVersion: number | null;
  queued?: number;
  st?: string;
}

interface MsgFlow {
  t: number;
  q: 'message' | 'enroute';
  requestId: string;
  ok: boolean;
  offline: boolean;
  tries: number;
  failed: boolean;
}

interface AlertCandidate {
  arrivedAt: number;
  /** Server clock (epoch ms) the request was created. */
  createdAt: number;
  visible: boolean;
  bell: boolean;
}

interface PendingClick {
  at: number;
  via: string;
  kind: string | null;
  src: 'push' | 'page';
  cold: boolean;
}

const parseTime = (iso: unknown): number | null => {
  if (typeof iso !== 'string') return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/** The request id in an API path (/api/requests/<id>/…), in memory only. */
function requestIdOf(path: string): string | null {
  const m = /^\/api\/requests\/([0-9a-f-]{36})(?:\/|$)/i.exec(path);
  return m ? (m[1] as string).toLowerCase() : null;
}

export class Flows {
  private openDone = false;
  private openCache: 'yes' | 'no' | 'unk' = 'unk';
  private firstSyncApi: number | null = null;
  private resume: { t: number; away: number } | null = null;
  private hiddenAt: number | null = null;
  private newFlow: NewFlow | null = null;
  private outbox = new Map<string, SubmitFlow>();
  private outboxSeen = false;
  private answers = new Map<string, AnswerFlow>();
  private msgs = new Map<string, MsgFlow>();
  private msgsSeen = false;
  private reads = new Map<string, { requestId: string; jobId: string; messageId: string | null; createdAt: number | null; until: number }>();
  private seenIds: Set<string> | null = null;
  private seenRef: ReadonlyMap<string, RequestSummary> | null = null;
  private candidates: AlertCandidate[] = [];
  private lastAlertAt: number | null = null;
  private clicks: PendingClick[] = [];
  /** When the profile view last opened (a click's log entry can arrive after the request it opened). */
  private profileAt: number | null = null;
  /** Server clock − this device's clock (ms), from the last sync (lastSyncAt) or the ingest answer. */
  private skew: number | null = null;
  private connection: StoreState['connection'] = 'live';
  private viewName: string | null = null;

  constructor(private readonly env: FlowEnv) {}

  setSkew(skew: number | null): void {
    if (skew !== null && Number.isFinite(skew)) this.skew = Math.round(skew);
  }

  /** A store emit (prev: the state at the previous emit, null for the first). `newToasts`: tones of toasts added now. */
  onState(s: StoreState, prev: StoreState | null, newToasts: readonly string[]): void {
    const now = this.env.now();
    this.connection = s.connection;
    if (s.lastSyncAt && s.lastSyncLocalAt !== null && (!prev || prev.lastSyncLocalAt !== s.lastSyncLocalAt)) {
      const server = parseTime(s.lastSyncAt);
      if (server !== null) this.skew = server - s.lastSyncLocalAt;
    }
    this.flowOpen(s, prev);
    this.flowResume(s);
    this.flowSubmit(s, now);
    this.flowAnswer(s, now, newToasts);
    this.alertRows(s, now);
  }

  private flowOpen(s: StoreState, prev: StoreState | null): void {
    if (this.openDone) return;
    if (prev === null) this.openCache = s.lastSyncLocalAt !== null ? 'unk' : s.hasData ? 'yes' : 'no';
    else if (s.lastSyncLocalAt === null) this.openCache = s.hasData ? 'yes' : 'no';
    if (s.lastSyncLocalAt === null) return;
    this.openDone = true;
    const ms = Math.max(0, s.lastSyncLocalAt - this.env.timeOrigin);
    const p: Props = { out: 'ok', cache: this.openCache };
    if (this.firstSyncApi !== null) p.api = this.firstSyncApi;
    this.env.emit({ n: 'flow_open', at: s.lastSyncLocalAt, ms, p });
    if (ms > (SLOW_MS.flow_open ?? 8_000)) this.env.slow('open', 'flow_open', ms);
  }

  /** The first /api/sync seen in resource timing (before the collector) or by the fetch observer. */
  syncApiAt(msFromOrigin: number): void {
    if (this.firstSyncApi === null && msFromOrigin >= 0) this.firstSyncApi = Math.round(msFromOrigin);
  }

  private flowResume(s: StoreState): void {
    const r = this.resume;
    if (!r) return;
    if (s.lastSyncLocalAt !== null && s.lastSyncLocalAt > r.t) {
      this.resume = null;
      const ms = s.lastSyncLocalAt - r.t;
      this.env.emit({ n: 'flow_resume', at: r.t, ms, p: { out: 'ok', away: r.away } });
      if (ms > (SLOW_MS.flow_resume ?? 5_000)) this.env.slow('resume', 'flow_resume', ms);
    } else if (s.connection !== 'live') {
      this.resume = null;
      this.env.emit({ n: 'flow_resume', at: r.t, ms: Math.max(0, this.env.now() - r.t), p: { out: 'fail', away: r.away } });
    }
  }

  private flowSubmit(s: StoreState, now: number): void {
    const ids = new Set<string>();
    for (const job of s.outbox) {
      ids.add(job.mutationId);
      let f = this.outbox.get(job.mutationId);
      if (!f) {
        f = { t: now, offline: false, tries: job.attempts, photos: job.photos.length, created: job.serverId !== null };
        this.outbox.set(job.mutationId, f);
        // A new job right after a tap on the form's submit: the new-request flow ends in a submit.
        if (this.outboxSeen && this.newFlow && this.newFlow.submitAt !== null && now - this.newFlow.submitAt <= SUBMIT_LINK_MS) this.endNew('submit', now);
        if (!this.outboxSeen) f.t = -1; // there before the collector: not timed
      }
      f.tries = job.attempts;
      f.photos = job.photos.length;
      f.created = job.serverId !== null;
      if (s.connection === 'offline') f.offline = true;
      if (job.state === 'needs_attention' && f.t >= 0) {
        this.emitSubmit(f, 'attention', now);
        f.t = -1;
      }
    }
    for (const [id, f] of this.outbox) {
      if (ids.has(id)) continue;
      this.outbox.delete(id);
      if (f.t >= 0) this.emitSubmit(f, f.created ? 'ok' : 'discarded', now);
    }
    this.outboxSeen = true;
  }

  private emitSubmit(f: SubmitFlow, out: string, now: number): void {
    const ms = Math.max(0, now - f.t);
    this.env.emit({ n: 'flow_submit', at: f.t, ms, p: { out, tries: f.tries, offline: f.offline, photos: f.photos } });
    if (out === 'ok' && ms > (SLOW_MS.flow_submit ?? 10_000)) this.env.slow('submit', 'flow_submit', ms);
  }

  private flowAnswer(s: StoreState, now: number, newToasts: readonly string[]): void {
    for (const [id, overlay] of s.pending) {
      const a = this.answers.get(id);
      if (a && a.mutationId === overlay.mutationId) continue;
      if (a) this.endAnswer(id, a, s, now, newToasts);
      const status = typeof overlay.fields.status === 'string' ? overlay.fields.status : undefined;
      this.answers.set(id, {
        mutationId: overlay.mutationId,
        kind: overlay.kind,
        startedAt: overlay.startedAt,
        to: overlay.kind === 'status' && status ? STATUS_KEY[status] : undefined,
        baseVersion: s.confirmed.get(id)?.rowVersion ?? null,
      });
    }
    for (const [id, a] of this.answers) if (!s.pending.has(id)) this.endAnswer(id, a, s, now, newToasts);
  }

  private endAnswer(id: string, a: AnswerFlow, s: StoreState, now: number, newToasts: readonly string[]): void {
    this.answers.delete(id);
    const version = s.confirmed.get(id)?.rowVersion ?? null;
    const out =
      s.connection === 'offline'
        ? 'offline'
        : newToasts.includes('red')
          ? 'failed'
          : newToasts.includes('amber')
            ? 'conflict'
            : version !== null && a.baseVersion !== null && version > a.baseVersion
              ? 'ok'
              : 'same';
    const ms = Math.max(0, now - a.startedAt);
    const p: Props = { kind: a.kind, out };
    if (a.to) p.to = a.to;
    if (a.queued !== undefined) p.queued = a.queued;
    if (a.st) p.st = a.st;
    this.env.emit({ n: 'flow_answer', at: a.startedAt, ms, p });
    if ((out === 'ok' || out === 'same') && ms > (SLOW_MS.flow_answer ?? 3_000)) this.env.slow('answer', 'flow_answer', ms, { kind: a.kind });
  }

  private alertRows(s: StoreState, now: number): void {
    if (s.lastSyncLocalAt === null) return;
    if (this.seenIds === null) {
      this.seenIds = new Set(s.confirmed.keys());
      this.seenRef = s.confirmed;
      return;
    }
    if (this.seenRef === s.confirmed) return;
    this.seenRef = s.confirmed;
    const serverNow = now + (this.skew ?? 0);
    for (const [id, row] of s.confirmed) {
      if (this.seenIds.has(id)) continue;
      this.seenIds.add(id);
      if (s.myIds.has(id)) continue;
      const created = parseTime(row.createdAt);
      if (created === null || serverNow - created > ALERT_RECENT_MS) continue;
      if (this.candidates.length < 20) this.candidates.push({ arrivedAt: now, createdAt: created, visible: this.env.visible(), bell: s.prefs.bell });
    }
  }

  /** An in-app alert (store subscribeAlerts): a toast for a new request resolves the visible candidates. */
  onAlert(alert: Pick<AlertEvent, 'kind'>, t: number): void {
    if (alert.kind !== 'new_request' && alert.kind !== 'combined') return;
    this.lastAlertAt = t;
    for (const c of [...this.candidates]) {
      if (t >= c.arrivedAt - 500 && t - c.arrivedAt <= ALERT_TOAST_MS) this.endAlert(c, 'toast', t);
    }
  }

  private endAlert(c: AlertCandidate, route: string, alertAt: number | null): void {
    this.candidates = this.candidates.filter((x) => x !== c);
    const p: Props = { route, seen: Math.max(0, Math.round(c.arrivedAt + (this.skew ?? 0) - c.createdAt)), vis: c.visible, skew: this.skew === null ? 'unk' : 'ok' };
    const e: TelEvent = { n: 'flow_alert', at: c.arrivedAt, p };
    if (alertAt !== null) e.ms = Math.max(0, Math.round(alertAt + (this.skew ?? 0) - c.createdAt));
    this.env.emit(e);
  }

  /** The service worker's log: push_rx and notif_click events, plus the push and click flows. */
  onSwEntries(entries: readonly SwEntry[]): void {
    for (const x of entries) {
      if (x.e === 'rx') {
        const p: Props = { kind: x.k, front: x.fr, shown: x.sh, silent: x.si };
        const e: TelEvent = { n: 'push_rx', at: x.at, p };
        if (x.sent !== null && this.skew !== null) {
          const transit = x.at + this.skew - x.sent;
          if (transit >= 0) e.ms = Math.round(transit);
        }
        this.env.emit(e);
        if (x.k === 'new_request') {
          for (const c of [...this.candidates]) if (Math.abs(x.at - c.arrivedAt) <= ALERT_PUSH_MS && !c.visible) this.endAlert(c, 'push', x.at);
        }
      } else {
        const src = x.ps ? 'push' : 'page';
        const p: Props = { src, via: x.via };
        if (x.k) p.kind = x.k;
        const e: TelEvent = { n: 'notif_click', at: x.at, p };
        if (x.age !== null && x.age >= 0) e.ms = Math.round(x.age);
        this.env.emit(e);
        const click: PendingClick = { at: x.at, via: x.via, kind: x.k, src, cold: x.at < this.env.timeOrigin };
        // The log is taken after the resume's sync, so the request this click opened may already be on screen.
        const shownAt = this.viewName === 'profile' ? this.profileAt : null;
        if (shownAt !== null && shownAt > x.at && shownAt - Math.max(x.at, this.env.timeOrigin) <= PUSH_SHOW_MS) this.emitPush(click, 'ok', shownAt);
        else this.clicks.push(click);
      }
    }
  }

  onMessages(snap: MessagingSnapshot): void {
    const now = this.env.now();
    const ids = new Set<string>();
    for (const job of snap.jobs) {
      ids.add(job.id);
      let f = this.msgs.get(job.id);
      if (!f) {
        f = { t: this.msgsSeen ? now : -1, q: job.kind, requestId: job.requestId.toLowerCase(), ok: false, offline: false, tries: job.attempts, failed: false };
        this.msgs.set(job.id, f);
      }
      f.tries = job.attempts;
      if (this.connection === 'offline') f.offline = true;
      if (job.state === 'failed' && !f.failed) {
        f.failed = true;
        if (f.t >= 0) this.env.emit({ n: 'flow_msg', at: f.t, ms: Math.max(0, now - f.t), p: { q: f.q, out: 'failed', tries: f.tries, offline: f.offline } });
      }
    }
    for (const [id, f] of this.msgs) {
      if (ids.has(id)) continue;
      this.msgs.delete(id);
      if (f.t < 0 || f.failed) continue;
      const ms = Math.max(0, now - f.t);
      this.env.emit({ n: 'flow_msg', at: f.t, ms, p: { q: f.q, out: f.ok ? 'ok' : 'discarded', tries: f.tries, offline: f.offline } });
      if (f.ok && ms > (SLOW_MS.flow_msg ?? 5_000)) this.env.slow('send', 'flow_msg', ms, { q: f.q });
      if (f.ok && f.q === 'message') this.reads.set(id, { requestId: f.requestId, jobId: id, messageId: null, createdAt: null, until: now + READ_WATCH_MS });
    }
    this.msgsSeen = true;
    this.readReceipts(snap, now);
  }

  private readReceipts(snap: MessagingSnapshot, now: number): void {
    for (const [key, w] of this.reads) {
      if (now > w.until) {
        this.reads.delete(key);
        continue;
      }
      const thread = snap.threads.get(w.requestId);
      if (!thread) continue;
      if (w.messageId === null) {
        const mine = thread.messages.find((m) => m.clientMutationId === w.jobId);
        if (!mine) continue;
        w.messageId = mine.id;
        w.createdAt = parseTime(mine.createdAt);
      }
      const receipt = thread.receipt;
      if (!receipt || receipt.messageId !== w.messageId || !receipt.readAt) continue;
      const readAt = parseTime(receipt.readAt);
      this.reads.delete(key);
      if (readAt === null || w.createdAt === null) continue;
      const e: TelEvent = { n: 'flow_read', at: now, ms: Math.max(0, readAt - w.createdAt) };
      if (this.skew !== null) e.p = { lag: Math.round(now + this.skew - readAt) };
      this.env.emit(e);
    }
  }

  /** A request started (fetch observer). */
  onNetStart(req: NetStart): void {
    if (req.pattern.startsWith('/api/sync') && this.firstSyncApi === null) this.syncApiAt(req.t - this.env.timeOrigin);
    if (req.method !== 'post' && req.method !== 'patch') return;
    const id = requestIdOf(req.path);
    const a = id ? this.answers.get(id) : undefined;
    if (a && a.queued === undefined && req.t >= a.startedAt) a.queued = Math.round(req.t - a.startedAt);
  }

  /** A request ended (fetch observer). */
  onNetEnd(req: NetEnd): void {
    const id = requestIdOf(req.path);
    if (!id) return;
    const a = this.answers.get(id);
    if (a && (req.method === 'post' || req.method === 'patch') && a.st === undefined && req.t >= a.startedAt) a.st = req.st;
    if (req.method === 'post' && req.st === '2xx' && /\/(messages|enroute)$/.test(req.path)) {
      const q = req.path.endsWith('/enroute') ? 'enroute' : 'message';
      for (const f of this.msgs.values()) if (f.requestId === id && f.q === q) f.ok = true;
    }
  }

  onView(name: string, prev: string | null, t: number): void {
    this.viewName = name;
    if (name === 'new' && prev !== 'new') {
      this.newFlow = { t, from: prev ?? 'unknown', dwell: { post: 0, person: 0, more: 0, friend: 0, photo: 0 }, cur: null, curAt: t, fields: new Set(), photos: 0, inval: 0, submitAt: null };
    } else if (prev === 'new' && name !== 'new' && this.newFlow) {
      // Leaving the form: a submit is linked by its outbox job within 3 s; without one it is abandoned.
      const f = this.newFlow;
      if (f.submitAt !== null && t - f.submitAt <= SUBMIT_LINK_MS) return;
      this.endNew('abandon', t);
    }
    if (name === 'profile') {
      if (prev !== 'profile') this.profileAt = t;
      for (const c of [...this.clicks]) {
        if (t - Math.max(c.at, this.env.timeOrigin) <= PUSH_SHOW_MS) {
          this.clicks = this.clicks.filter((x) => x !== c);
          this.emitPush(c, 'ok', t);
        }
      }
    }
  }

  private emitPush(c: PendingClick, out: string, t: number): void {
    const p: Props = { src: c.src, via: c.via, cold: c.cold, out };
    if (c.kind) p.kind = c.kind;
    this.env.emit({ n: 'flow_push', at: c.at, ms: Math.max(0, Math.round(t - c.at)), p });
  }

  private section(sec: Section | null, t: number): void {
    const f = this.newFlow;
    if (!f) return;
    if (f.cur) f.dwell[f.cur] += Math.max(0, t - f.curAt);
    f.cur = sec;
    f.curAt = t;
  }

  /** A tap on a control (its ctl token). */
  onTap(control: string, section: string | null, t: number): void {
    const f = this.newFlow;
    if (!f) return;
    if (control === 'request-form-submit') f.submitAt = t;
    if (section && (SECTIONS as readonly string[]).includes(section)) {
      if (section === 'photo') f.photos += 1;
      if (f.cur !== section) this.section(section as Section, t);
    }
  }

  /** Focus moved into a request-form field. */
  onField(section: string, key: string, t: number): void {
    const f = this.newFlow;
    if (!f) return;
    f.fields.add(key);
    if ((SECTIONS as readonly string[]).includes(section) && f.cur !== section) this.section(section as Section, t);
  }

  /** A submit showed an error line (.lp-rf-err) afterwards. */
  onInvalid(): void {
    if (this.newFlow) {
      this.newFlow.inval += 1;
      this.newFlow.submitAt = null;
    }
  }

  private endNew(out: 'submit' | 'abandon', t: number): void {
    const f = this.newFlow;
    if (!f) return;
    this.section(null, t);
    this.newFlow = null;
    this.env.emit({
      n: 'flow_new',
      at: f.t,
      ms: Math.max(0, t - f.t),
      p: {
        out,
        from: f.from,
        s_post: Math.round(f.dwell.post),
        s_person: Math.round(f.dwell.person),
        s_more: Math.round(f.dwell.more),
        s_friend: Math.round(f.dwell.friend),
        s_photo: Math.round(f.dwell.photo),
        fields: f.fields.size,
        photos: f.photos,
        inval: f.inval,
        desk: this.env.desk(),
      },
    });
  }

  onVisibility(visible: boolean, t: number): void {
    if (!visible) {
      this.hiddenAt = t;
      if (this.resume) {
        const r = this.resume;
        this.resume = null;
        this.env.emit({ n: 'flow_resume', at: r.t, ms: Math.max(0, t - r.t), p: { out: 'none', away: r.away } });
      }
      return;
    }
    const away = this.hiddenAt === null ? 0 : Math.round((t - this.hiddenAt) / 1000);
    this.hiddenAt = null;
    this.resume = { t, away };
  }

  /** Time passing (each idle check): the waits that ran out. */
  tick(t: number, offlineNow: boolean): void {
    if (!this.openDone && t - this.env.timeOrigin >= OPEN_WAIT_MS) {
      this.openDone = true;
      this.env.emit({ n: 'flow_open', at: this.env.timeOrigin, ms: Math.round(t - this.env.timeOrigin), p: { out: offlineNow ? 'offline' : 'none', cache: this.openCache } });
    }
    if (this.resume && t - this.resume.t >= RESUME_WAIT_MS) {
      const r = this.resume;
      this.resume = null;
      this.env.emit({ n: 'flow_resume', at: r.t, ms: Math.round(t - r.t), p: { out: 'none', away: r.away } });
    }
    if (this.newFlow && this.newFlow.submitAt !== null && t - this.newFlow.submitAt > SUBMIT_LINK_MS) {
      // No outbox job followed the tap: the form stayed (an error line) or it was left without sending.
      this.newFlow.submitAt = null;
      if (this.viewName !== 'new') this.endNew('abandon', t);
    }
    for (const c of [...this.candidates]) {
      if (c.visible && t - c.arrivedAt > ALERT_TOAST_MS) this.endAlert(c, c.bell ? 'none' : 'off', null);
      else if (!c.visible && t - c.arrivedAt > ALERT_MAX_WAIT_MS) this.endAlert(c, c.bell ? 'hidden' : 'off', null);
    }
    for (const c of [...this.clicks]) {
      if (t - Math.max(c.at, this.env.timeOrigin) > PUSH_SHOW_MS) {
        this.clicks = this.clicks.filter((x) => x !== c);
        this.emitPush(c, 'not_shown', t);
      }
    }
  }

  /** Hidden candidates once the worker's log is in: no push for them means the alert never reached the phone. */
  settleHidden(t: number): void {
    for (const c of [...this.candidates]) if (!c.visible && t - c.arrivedAt > ALERT_PUSH_MS) this.endAlert(c, c.bell ? 'hidden' : 'off', null);
  }

  /** The page is going away: submits still in flight end here. */
  unload(t: number): void {
    for (const [id, f] of this.outbox) {
      if (f.t < 0) continue;
      this.emitSubmit(f, 'unload', t);
      f.t = -1;
      this.outbox.set(id, f);
    }
  }

  /** Time of the last in-app new-request alert (tests). */
  get lastAlert(): number | null {
    return this.lastAlertAt;
  }
}
