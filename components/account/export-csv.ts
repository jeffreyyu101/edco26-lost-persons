'use client';
// Export CSV (spec §6 GET /api/export, §8 Avatar menu): a plain link to the export route, which answers
// with Content-Disposition: attachment, so the browser downloads it. In an iOS Home Screen app a download
// link does nothing visible, so there it opens in a new tab instead (Jeffrey's "Export CSV ↓", kept).
import type { MouseEvent } from 'react';

export const EXPORT_CSV_PATH = '/api/export';

/** True inside a Home Screen (standalone) web app. */
export function isStandaloneApp(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches === true;
}

/** onClick for the export link: lets the browser download it, except in a standalone app (new tab). */
export function handleExportClick(event: MouseEvent<HTMLAnchorElement>): void {
  if (!isStandaloneApp()) return;
  event.preventDefault();
  window.open(EXPORT_CSV_PATH, '_blank', 'noopener');
}
