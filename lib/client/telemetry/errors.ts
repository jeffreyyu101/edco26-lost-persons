// Errors (design §1.4 `error`): window `error` (scripts) and `unhandledrejection`, and a capture `error` on a failed
// <script> or stylesheet (a chunk that didn't load). An error is stored as its TYPE and a fingerprint of the type and
// the top /_next/static frame only: NEVER its message (V8's JSON.parse messages quote the input text). The source is
// `chunk:<hash>` (an 8-character hash of the chunk's path), `app`, `ext` (another origin) or `unk`.
import { fnv8 } from './sanitize';

export const ERROR_TYPES = [
  'typeerror',
  'referenceerror',
  'syntaxerror',
  'rangeerror',
  'chunkloaderror',
  'aborterror',
  'notallowederror',
  'quotaexceedederror',
  'securityerror',
] as const;

export interface ErrorInfo {
  type: string;
  kind: 'error' | 'rejection' | 'resource';
  src: string;
  line?: number;
  col?: number;
  fp: string;
}

const TYPE_SET: ReadonlySet<string> = new Set(ERROR_TYPES);

/** The error's type token from its name (constructor name), or `other`. Never reads the message. */
export function errorType(error: unknown): string {
  const name = error && typeof error === 'object' ? (error as { name?: unknown }).name : undefined;
  const t = typeof name === 'string' ? name.toLowerCase() : '';
  return TYPE_SET.has(t) ? t : 'other';
}

/** The first same-origin /_next/static frame of a stack: its path, line and column. */
export function topFrame(stack: unknown, origin: string): { path: string; line: number; col: number } | null {
  if (typeof stack !== 'string') return null;
  const re = /(https?:\/\/[^\s()'"]+?\/_next\/static\/[^\s()'":]+):(\d+):(\d+)/g;
  for (let m = re.exec(stack); m; m = re.exec(stack)) {
    try {
      const u = new URL(m[1] as string);
      if (u.origin !== origin) continue;
      return { path: u.pathname, line: Number(m[2]), col: Number(m[3]) };
    } catch {
      continue;
    }
  }
  return null;
}

/** The source token of a script URL: `chunk:<hash8>` for this build's static files, `ext` for another origin. */
export function sourceOf(url: unknown, origin: string): string {
  if (typeof url !== 'string' || url === '') return 'unk';
  try {
    const u = new URL(url, origin);
    if (u.origin !== origin) return 'ext';
    return u.pathname.startsWith('/_next/static/') ? `chunk:${fnv8(u.pathname)}` : 'app';
  } catch {
    return 'unk';
  }
}

/** A script error (ErrorEvent) or a rejection's reason. */
export function describeError(kind: 'error' | 'rejection', error: unknown, filename: unknown, line: unknown, col: unknown, origin: string): ErrorInfo {
  const type = errorType(error);
  const stack = error && typeof error === 'object' ? (error as { stack?: unknown }).stack : undefined;
  const frame = topFrame(stack, origin);
  const src = frame ? `chunk:${fnv8(frame.path)}` : sourceOf(filename, origin);
  const l = frame?.line ?? (typeof line === 'number' && line > 0 ? line : undefined);
  const c = frame?.col ?? (typeof col === 'number' && col > 0 ? col : undefined);
  return { type, kind, src, line: l, col: c, fp: fnv8(`${type}|${frame ? `${frame.path}:${frame.line}:${frame.col}` : src}`) };
}

/** A failed <script> or stylesheet: the element's own URL attribute (a static asset path, hashed; nothing else). */
export function describeResource(tagName: string, url: unknown, origin: string): ErrorInfo | null {
  const t = tagName.toLowerCase();
  if (t !== 'script' && t !== 'link') return null;
  const src = sourceOf(url, origin);
  return { type: 'chunkloaderror', kind: 'resource', src, fp: fnv8(`chunkloaderror|${src}`) };
}
