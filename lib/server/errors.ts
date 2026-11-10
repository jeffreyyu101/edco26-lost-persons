// API errors (spec §6, lib/api-types ApiError): every failure is {error: {code, message, id?, ...}}.
// Handlers throw ApiFailure; lib/server/route.ts turns it into the response and the log line.
// Database errors are mapped from supabase-js `error.code` (the SQLSTATE raised by the lp_* functions);
// the HTTP status PostgREST itself chose is ignored. Server only.
import 'server-only';
import type { ApiError, ApiErrorCode } from '../api-types';
import { newErrorId } from './log';

export const HTTP_STATUS: Readonly<Record<ApiErrorCode, number>> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  bad_origin: 403,
  not_found: 404,
  too_large: 413,
  unsupported_media: 415,
  conflict: 409,
  invalid: 422,
  photo_limit: 422,
  rate_limited: 429,
  unavailable: 503,
  event_ended: 410,
  no_event: 409,
};

/** Safe default messages (never contain request data). */
export const DEFAULT_MESSAGE: Readonly<Record<ApiErrorCode, string>> = {
  bad_request: 'Bad request',
  unauthorized: 'Sign in again',
  forbidden: 'Only the person who logged this request can do that',
  bad_origin: 'Cross-site request refused',
  not_found: 'Not found',
  too_large: 'Too large',
  unsupported_media: 'Unsupported file type',
  conflict: 'Updated by someone else',
  invalid: 'Check the details and try again',
  photo_limit: 'This request already has 3 photos',
  rate_limited: 'Too many attempts. Try again later',
  unavailable: "Couldn't reach the log. Try again",
  event_ended: 'This event is now closed',
  no_event: 'Open an event first',
};

type Extra = Omit<ApiError['error'], 'code' | 'message' | 'id'>;

export class ApiFailure extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly extra: Extra;
  readonly headers: Record<string, string>;
  /** The underlying database / storage error code, for the log line only. */
  readonly dbCode: string | undefined;
  /** Set for 5xx (always) and whenever the caller wants the failure correlated. */
  readonly errorId: string | undefined;

  constructor(
    code: ApiErrorCode,
    message?: string,
    options: { extra?: Extra; headers?: Record<string, string>; dbCode?: string } = {},
  ) {
    super(message ?? DEFAULT_MESSAGE[code]);
    this.name = 'ApiFailure';
    this.code = code;
    this.status = HTTP_STATUS[code];
    this.extra = options.extra ?? {};
    this.headers = options.headers ?? {};
    this.dbCode = options.dbCode;
    this.errorId = this.status >= 500 ? newErrorId() : undefined;
  }

  body(): ApiError {
    return { error: { code: this.code, message: this.message, ...(this.errorId ? { id: this.errorId } : {}), ...this.extra } };
  }
}

/** The subset of supabase-js PostgrestError / StorageError we read. message/details are NEVER logged. */
export interface DbError {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
}

/** "first_name" → "firstName". */
export function snakeToCamel(value: string): string {
  return value.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

/** The offending field from a P0422 DETAIL "field:<snake_name>", camelCased; undefined when absent. */
export function fieldFromDetail(details: string | null | undefined): string | undefined {
  const m = /^field:([a-z_][a-z0-9_]{0,59})$/.exec(details ?? '');
  return m?.[1] ? snakeToCamel(m[1]) : undefined;
}

const INVALID_MESSAGES: Readonly<Record<string, string>> = {
  illegal_transition: "That change isn't allowed from the current status",
  field_too_long: 'Too long',
  unknown_field: 'Unknown field',
  invalid_field: 'Check the details and try again',
  invalid_body: 'Check the details and try again',
  rejected_by_constraint: 'Check the details and try again',
  too_many_ids: 'Too many ids',
  photo_id_in_use: 'Photo id already used',
  photo_path_in_use: 'Photo already stored',
  invalid_staff: 'Sign in again',
  too_late: 'Too late to unsend',
  slug_taken: 'That link name is taken',
};

/**
 * Where an error came from: P0429 means "too many sign-in attempts" for login, "photo limit" for photos and
 * "too many messages" for messages (F3: 20 a minute per staff, Retry-After from the HINT).
 */
export type DbContext = 'default' | 'login' | 'photo' | 'message';

/**
 * Maps a supabase-js error to an ApiFailure (spec §5 Errors):
 *   P0409 → 409 conflict (currentStatus from HINT) · P0422 → 422 invalid (field from DETAIL) ·
 *   P0403 → 403 forbidden · P0429 → 429 rate_limited (login, Retry-After from HINT) / 422 photo_limit
 *   (photos) · P0002 / PGRST116 → 404 · anything else → 503 unavailable with an error id.
 */
export function mapDbError(error: DbError, context: DbContext = 'default'): ApiFailure {
  const code = typeof error.code === 'string' ? error.code : '';
  switch (code) {
    case 'P0409':
      if (error.message === 'slug_taken') return new ApiFailure('conflict', INVALID_MESSAGES.slug_taken, { dbCode: code, extra: { field: 'slug' } });
      if (error.message === 'bad_stage') return new ApiFailure('conflict', 'Not possible at this stage', { dbCode: code });
      return new ApiFailure('conflict', undefined, {
        dbCode: code,
        extra: typeof error.hint === 'string' && error.hint ? { currentStatus: error.hint.slice(0, 60) } : {},
      });
    case 'P0422': {
      const field = fieldFromDetail(error.details);
      const message = INVALID_MESSAGES[error.message ?? ''] ?? DEFAULT_MESSAGE.invalid;
      return new ApiFailure('invalid', message, {
        dbCode: code,
        extra: {
          ...(field ? { field } : {}),
          ...(error.message === 'illegal_transition' && error.hint ? { currentStatus: error.hint.slice(0, 60) } : {}),
        },
      });
    }
    case 'P0403':
      return new ApiFailure('forbidden', undefined, { dbCode: code });
    // (Events) lp_require_writable / the patients guard: the event is archived.
    case 'P0410':
      return new ApiFailure('event_ended', undefined, { dbCode: code });
    case 'P0429': {
      if (context === 'photo') return new ApiFailure('photo_limit', undefined, { dbCode: code, extra: { field: 'photo' } });
      if (context === 'message') {
        const seconds = Math.max(1, Math.min(60, Number.parseInt(error.hint ?? '', 10) || 30));
        return new ApiFailure('rate_limited', 'Too many messages. Wait a moment', {
          dbCode: code,
          extra: { retryAfterSeconds: seconds },
          headers: { 'Retry-After': String(seconds) },
        });
      }
      if (context === 'login') {
        const seconds = Math.max(1, Math.min(24 * 3600, Number.parseInt(error.hint ?? '', 10) || 60));
        return new ApiFailure('rate_limited', `Too many attempts. Try again in ${Math.max(1, Math.ceil(seconds / 60))} min`, {
          dbCode: code,
          extra: { retryAfterSeconds: seconds },
          headers: { 'Retry-After': String(seconds) },
        });
      }
      return new ApiFailure('rate_limited', undefined, { dbCode: code });
    }
    case 'P0002':
    case 'PGRST116':
      return new ApiFailure('not_found', undefined, { dbCode: code });
    default:
      return new ApiFailure('unavailable', undefined, { dbCode: code || 'network' });
  }
}

/** True for the rejections after which an uploaded photo's objects are deleted (spec §6 photos). */
export function isDefinitiveRejection(failure: ApiFailure): boolean {
  return (
    failure.code === 'photo_limit' ||
    failure.code === 'invalid' ||
    failure.code === 'forbidden' ||
    failure.code === 'not_found' ||
    failure.code === 'event_ended'
  );
}
