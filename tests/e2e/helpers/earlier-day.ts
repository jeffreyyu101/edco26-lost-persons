// Rows logged on an earlier event day, for the widest times the lists show ("Mon 12:58 AM"), without waiting
// for midnight: the page's /api/sync answers are rewritten so chosen rows carry an earlier created time (the
// server and the database are untouched). And a cut check that sees what WebKit hides.
import type { Locator, Page } from '@playwright/test';
import type { SyncResponse } from '../../../lib/api-types';

const DAY_MS = 86_400_000;

/**
 * The widest earlier-day created time (format.formatCreatedTime): Monday at 12:58 AM in `timeZone`, or
 * Wednesday when today is a Monday, always 1 to 6 event days ago. Returns the instant and its weekday.
 */
export function widestEarlierDay(timeZone: string): { at: string; weekday: string } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const partsOf = (t: number) => Object.fromEntries(fmt.formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  const now = Date.now();
  const weekday = partsOf(now).weekday === 'Mon' ? 'Wed' : 'Mon';
  for (let back = 1; back <= 6; back += 1) {
    const day = partsOf(now - back * DAY_MS);
    if (day.weekday !== weekday) continue;
    // 00:58 on that date in the zone: a UTC guess, corrected by the zone's offset there.
    const target = Date.UTC(Number(day.year), Number(day.month) - 1, Number(day.day), 0, 58);
    let t = target;
    for (let i = 0; i < 2; i += 1) {
      const p = partsOf(t);
      t += target - Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute));
    }
    return { at: new Date(t).toISOString(), weekday };
  }
  throw new Error(`no ${weekday} in the last 6 days`);
}

/**
 * From now on, the page's syncs say the rows `ids` were created at `createdAt`. Needs `serviceWorkers: 'block'`:
 * page.route never sees a request the service worker makes.
 */
export async function backdateInSync(page: Page, ids: readonly string[], createdAt: string): Promise<void> {
  await page.route('**/api/sync*', async (route) => {
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const body = (await response.json()) as SyncResponse;
    for (const row of body.rows) if (ids.includes(row.id)) row.createdAt = createdAt;
    return route.fulfill({ response, json: body });
  });
}

/**
 * Whether an element's text is cut: its laid-out width (a Range over its contents) against its box, to the
 * sub-pixel. WebKit reports scrollWidth == clientWidth for a right-aligned cell while it draws the ellipsis.
 */
export function textCut(el: Locator): Promise<boolean> {
  return el.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    return range.getBoundingClientRect().width > node.getBoundingClientRect().width + 0.01;
  });
}
