// An in-memory stand-in for the API (spec §6) for the store's unit tests: sessions, paged delta sync with
// database-style cursors ("…+00:00", microseconds), creates idempotent on clientMutationId, status changes
// with version checks and the §4 transitions, edits, cancel, photos idempotent on photoId, detail, stats.
// Synthetic data only. Every request is recorded; `override` can hang, drop or answer any request.
import type { PhotoInfo, RequestSummary, SessionInfo, SyncResponse } from '@/lib/api-types';
import { STATUS, canTransition, joinName, postShort, splitName } from '@/lib/domain';

export interface FakeRequest {
  /** The URL exactly as the client built it. */
  raw: string;
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  form: FormData | null;
}

export type Override = (req: FakeRequest) => Response | 'hang' | 'network' | undefined | Promise<Response | 'hang' | 'network' | undefined>;

export const STAFF = {
  dana: { staffName: 'Dana Kim', team: 'GC/HX - Dispatch', staff: 'Dana Kim · GC/HX - Dispatch' },
  rae: { staffName: 'Rae Chen', team: 'Medical', staff: 'Rae Chen · Medical' },
  sam: { staffName: 'Sam Lee', team: 'GC/HX - Base', staff: 'Sam Lee · GC/HX - Base' },
} as const;

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export const apiError = (status: number, code: string, message = 'Rejected', extra: Record<string, unknown> = {}) =>
  json(status, { error: { code, message, ...extra } });

let idSeq = 0;
export const testId = (n: number) => `7e570000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const newId = () => testId(900_000 + (idSeq += 1));

export function makeRow(n: number, patch: Partial<RequestSummary> = {}): RequestSummary {
  const base: RequestSummary = {
    id: testId(n),
    clientMutationId: null,
    caseNumber: 1000 + n,
    firstName: 'T.',
    lastName: `R${n}`,
    age: '24',
    gender: 'Male',
    heightBuild: null,
    hair: null,
    identifyingFeatures: null,
    physicalDescription: null,
    lastSeen: null,
    clothing: 'Red hoodie',
    additionalNotes: null,
    reportingLocation: 'FA 4 – Oasis',
    otherLocation: null,
    contactName: 'Maya R.',
    contactPhone: null,
    contactRelationship: null,
    contactNotes: null,
    status: STATUS.waiting,
    createdBy: STAFF.sam.staff,
    updatedBy: STAFF.sam.staff,
    createdAt: '2026-11-07T02:00:00.000000+00:00',
    updatedAt: '2026-11-07T02:00:00.000000+00:00',
    foundAt: null,
    reunionStartedAt: null,
    closedAt: null,
    rowVersion: 1,
    firstPhotoId: null,
    photoCount: 0,
    name: '',
    postShort: 'FA 4',
  };
  const row = { ...base, ...patch };
  row.name = patch.name ?? joinName(row.firstName, row.lastName);
  row.postShort = postShort(row.reportingLocation, row.otherLocation);
  return row;
}

interface Stored {
  row: RequestSummary;
  seq: number;
}

export class FakeServer {
  readonly rows = new Map<string, Stored>();
  readonly log: FakeRequest[] = [];
  readonly photos = new Map<string, { requestId: string; info: PhotoInfo }>();
  session: SessionInfo | null = { ...STAFF.dana, expiresAt: '2026-11-07T15:00:00.000000+00:00' };
  pageSize = 500;
  /** How many seq units each delta repeats (the 30 s overlap). */
  overlap = 2;
  override: Override | null = null;
  /** Extra fields of every sync response (F4: activityUnread / activityKey). */
  syncExtras: Record<string, unknown> | null = null;
  private seq = 0;
  private nextCase = 2000;
  /** serverTime strings this server issued → seq at that moment (a mangled '+' won't be found → 400). */
  private issued = new Map<string, number>();

  constructor(rows: RequestSummary[] = []) {
    for (const r of rows) this.put(r);
  }

  /** A database-clock timestamp for a seq (microseconds, '+00:00' offset — the A37 case). */
  stamp(seq: number): string {
    const ms = Date.parse('2026-11-07T03:00:00Z') + seq * 1000;
    return `${new Date(ms).toISOString().slice(0, 19)}.${String(seq % 1_000_000).padStart(6, '0')}+00:00`;
  }

  put(row: RequestSummary): RequestSummary {
    this.seq += 1;
    this.rows.set(row.id, { row, seq: this.seq });
    return row;
  }

  /** Someone else changes a row (bumps version and updated_at). */
  change(id: string, patch: Partial<RequestSummary>, by: string = STAFF.rae.staff): RequestSummary {
    const cur = this.rows.get(id);
    if (!cur) throw new Error(`no row ${id}`);
    this.seq += 1;
    const row = { ...cur.row, ...patch, rowVersion: cur.row.rowVersion + 1, updatedBy: by, updatedAt: this.stamp(this.seq) };
    this.rows.set(id, { row, seq: this.seq });
    return row;
  }

  row(id: string): RequestSummary {
    const r = this.rows.get(id)?.row;
    if (!r) throw new Error(`no row ${id}`);
    return r;
  }

  requests(method: string, pathPrefix: string): FakeRequest[] {
    return this.log.filter((r) => r.method === method && r.path.startsWith(pathPrefix));
  }

  fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input, 'https://lp.test');
    const method = (init.method ?? 'GET').toUpperCase();
    let body: unknown = null;
    let form: FormData | null = null;
    if (typeof init.body === 'string') body = JSON.parse(init.body);
    else if (init.body instanceof FormData) form = init.body;
    const req: FakeRequest = { raw: input, method, path: url.pathname, query: url.searchParams, body, form };
    this.log.push(req);
    const signal = init.signal;
    const aborted = () => new DOMException('The operation was aborted.', 'AbortError');
    if (signal?.aborted) throw aborted();
    const o = this.override ? await this.override(req) : undefined;
    if (o === 'hang') {
      return new Promise<Response>((_, reject) => signal?.addEventListener('abort', () => reject(aborted())));
    }
    if (o === 'network') throw new TypeError('Failed to fetch');
    if (o) return o;
    return this.route(req);
  };

  private needSession(): Response | null {
    return this.session ? null : apiError(401, 'unauthorized', 'Sign in again');
  }

  private route(req: FakeRequest): Response {
    const { method, path } = req;
    if (path === '/api/session') {
      if (method === 'DELETE') {
        this.session = null;
        return json(200, { ok: true });
      }
      return this.session ? json(200, this.session) : apiError(401, 'unauthorized', 'Sign in again');
    }
    const denied = this.needSession();
    if (denied) return denied;
    if (path === '/api/sync' && method === 'GET') return this.sync(req.query);
    if (path === '/api/stats') return json(200, { open: { waiting: 0, inMedical: 0 }, serverTime: this.stamp(this.seq) });
    if (path === '/api/requests' && method === 'POST') return this.create(req.body as Record<string, unknown>);
    const m = /^\/api\/requests\/([^/]+)(\/status|\/cancel|\/photos|\/swap)?$/.exec(path);
    if (!m) return apiError(404, 'not_found', 'Not found');
    const id = decodeURIComponent(m[1] ?? '');
    const cur = this.rows.get(id)?.row;
    if (!cur) return apiError(404, 'not_found', 'Request not found');
    const action = m[2];
    if (!action && method === 'GET') return json(200, { ...cur, photos: [], audit: [] });
    if (!action && method === 'PATCH') {
      const { patch, expectedVersion } = req.body as { patch: Record<string, unknown>; expectedVersion: number };
      if (expectedVersion !== cur.rowVersion) return apiError(409, 'conflict', 'Updated by someone else', { currentStatus: cur.status });
      const next: Partial<RequestSummary> = {};
      for (const [k, v] of Object.entries(patch)) {
        if (k === 'name') Object.assign(next, splitName(v as string | null));
        else (next as Record<string, unknown>)[k] = v;
      }
      const row = this.change(id, { ...next }, this.session?.staff);
      const fixed = { ...row, name: joinName(row.firstName, row.lastName), postShort: postShort(row.reportingLocation, row.otherLocation) };
      this.rows.set(id, { row: fixed, seq: this.rows.get(id)?.seq ?? 0 });
      return json(200, { changed: true, request: fixed });
    }
    if (action === '/status') {
      const { status, expectedVersion } = req.body as { status: string; expectedVersion: number; kind: string };
      if (cur.status === status) return json(200, { changed: false, request: cur });
      if (expectedVersion !== cur.rowVersion) return apiError(409, 'conflict', 'Updated by someone else', { currentStatus: cur.status });
      if (!canTransition(cur.status, status)) return apiError(422, 'invalid', 'Not allowed');
      const row = this.change(id, { status }, this.session?.staff);
      return json(200, { changed: true, request: row });
    }
    if (action === '/swap') {
      // (Companion) request / approve(place) / decline, as the backend's POST /api/requests/:id/swap.
      const body = req.body as { action: 'request' | 'approve' | 'decline' | 'withdraw' | 'cancel'; place?: 'fa' | 'mm'; expectedVersion: number };
      if (body.expectedVersion !== cur.rowVersion) return apiError(409, 'conflict', 'Updated by someone else', { currentStatus: cur.status });
      const staff = this.session?.staff;
      // (Companion follow-up) cancel: an open request → cleared; an approved swap → back to Accompanied.
      if (body.action === 'cancel' && cur.status === STATUS.inMedical && cur.swapPlace) {
        return json(200, { changed: true, request: this.change(id, { status: STATUS.accompanied, swapPlace: null }, staff) });
      }
      if (cur.status !== STATUS.accompanied) return apiError(422, 'invalid', 'Not allowed');
      if (body.action === 'request') {
        if (cur.swapRequestedAt) return json(200, { changed: false, request: cur });
        return json(200, { changed: true, request: this.change(id, { swapRequestedAt: this.stamp(this.seq), swapRequestedBy: staff ?? null }, staff) });
      }
      if (!cur.swapRequestedAt) return apiError(422, 'invalid', 'No swap requested');
      if (body.action === 'approve') {
        return json(200, { changed: true, request: this.change(id, { status: STATUS.inMedical, swapPlace: body.place ?? null, swapRequestedAt: null, swapRequestedBy: null }, staff) });
      }
      return json(200, { changed: true, request: this.change(id, { swapRequestedAt: null, swapRequestedBy: null }, staff) });
    }
    if (action === '/cancel') {
      const { expectedVersion } = req.body as { expectedVersion: number };
      if (expectedVersion !== cur.rowVersion) return apiError(409, 'conflict', 'Updated by someone else');
      const row = this.change(id, { status: STATUS.cancelled }, this.session?.staff);
      return json(200, { changed: true, request: row });
    }
    if (action === '/photos' && method === 'POST') {
      const form = req.form;
      const photoId = String(form?.get('photoId') ?? '');
      const existing = this.photos.get(photoId);
      if (existing) return json(200, { created: false, photo: existing.info, request: this.row(existing.requestId) });
      if (cur.photoCount >= 3) return apiError(422, 'photo_limit', 'Three photos at most');
      const info: PhotoInfo = { id: photoId, timing: (form?.get('timing') as 'today') ?? 'today', createdAt: this.stamp(this.seq), uploadedBy: this.session?.staff ?? '', hasThumb: true };
      this.photos.set(photoId, { requestId: id, info });
      const row = this.change(id, { photoCount: cur.photoCount + 1, firstPhotoId: cur.firstPhotoId ?? photoId }, this.session?.staff);
      return json(201, { created: true, photo: info, request: row });
    }
    return apiError(404, 'not_found', 'Not found');
  }

  private create(body: Record<string, unknown>): Response {
    const cmid = body['clientMutationId'] as string;
    for (const { row } of this.rows.values()) if (row.clientMutationId === cmid) return json(200, { created: false, request: row });
    this.nextCase += 1;
    this.seq += 1;
    const { firstName, lastName } = splitName((body['name'] as string | null) ?? null);
    const row = makeRow(0, {
      id: newId(),
      clientMutationId: cmid,
      caseNumber: this.nextCase,
      firstName,
      lastName,
      age: typeof body['age'] === 'number' ? String(body['age']) : ((body['age'] as string | null) ?? null),
      gender: (body['gender'] as string | null) ?? null,
      clothing: (body['clothing'] as string | null) ?? null,
      reportingLocation: body['reportingLocation'] as string,
      otherLocation: (body['otherLocation'] as string | null) ?? null,
      contactName: (body['contactName'] as string | null) ?? null,
      createdBy: this.session?.staff ?? '',
      updatedBy: this.session?.staff ?? '',
      createdAt: this.stamp(this.seq),
      updatedAt: this.stamp(this.seq),
      rowVersion: 0,
    });
    this.rows.set(row.id, { row, seq: this.seq });
    return json(201, { created: true, request: row });
  }

  private sync(q: URLSearchParams): Response {
    const ids = q.get('ids');
    const now = this.stamp(this.seq);
    this.issued.set(now, this.seq);
    if (ids) {
      const rows = ids.split(',').map((id) => this.rows.get(id)?.row).filter((r): r is RequestSummary => !!r);
      return json(200, { serverTime: now, rows, hasMore: false, next: null } satisfies SyncResponse);
    }
    const since = q.get('since');
    let fromSeq = 0;
    if (since !== null) {
      const at = this.issued.get(since);
      // A cursor that arrived mangled ("+" decoded as a space) is unknown here: the real schema 400s.
      if (at === undefined) return apiError(400, 'bad_request', 'Bad cursor');
      fromSeq = Math.max(0, at - this.overlap);
    }
    const afterAt = q.get('afterAt');
    const afterId = q.get('afterId') ?? '';
    const afterSeq = afterAt !== null ? (this.issued.get(afterAt) ?? Number.NaN) : null;
    if (afterSeq !== null && Number.isNaN(afterSeq)) return apiError(400, 'bad_request', 'Bad page cursor');
    const all = [...this.rows.values()]
      .filter((s) => s.seq > fromSeq)
      .sort((a, b) => a.seq - b.seq || a.row.id.localeCompare(b.row.id))
      .filter((s) => afterSeq === null || s.seq > afterSeq || (s.seq === afterSeq && s.row.id > afterId));
    const page = all.slice(0, this.pageSize);
    const last = page.at(-1);
    const hasMore = all.length > page.length;
    let next: SyncResponse['next'] = null;
    if (hasMore && last) {
      const at = this.stamp(last.seq);
      this.issued.set(at, last.seq);
      next = { at, id: last.row.id };
    }
    const res: SyncResponse = { serverTime: now, rows: page.map((s) => s.row), hasMore, next };
    if (q.get('reconcile') === '1') res.versions = [...this.rows.values()].map((s) => [s.row.id, s.row.rowVersion]);
    return json(200, this.syncExtras ? { ...res, ...this.syncExtras } : res);
  }
}
