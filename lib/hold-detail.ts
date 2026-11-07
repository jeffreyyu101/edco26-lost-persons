// (F5, contract B) The first Not found's words: "Not found yet · recheck 4:40 PM". Its own module, not lib/domain.ts:
// domain stays free of lib/format.ts, so /signin (which needs domain) does not carry the formatter, and the first
// load of / (A25) keeps its chunks as they were before F5. Pure and isomorphic: no I/O, no React.
import { NOT_FOUND_YET_LABEL } from './domain';
import { formatClockAmPm } from './format';

/**
 * Nouns only: line 2 of the Activity row, the push body, and the in-app alert's subtitle / system notification
 * body. Just "Not found yet" when the recheck time is missing or unreadable.
 */
export function holdDetail(recheckAt: string | null | undefined, timeZone?: string): string {
  return recheckAt && Number.isFinite(Date.parse(recheckAt)) ? `${NOT_FOUND_YET_LABEL} · recheck ${formatClockAmPm(recheckAt, timeZone)}` : NOT_FOUND_YET_LABEL;
}
