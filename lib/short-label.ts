// (Events) The short name a post or team gets when the lead leaves Short empty: the dashboard's series, the list's
// chips. Shared by the server (lib/validation.ts: a missing or blank short) and the Event setup form (the Short
// field's placeholder and the chip preview), so what the lead sees is what is stored. Pure; unit-tested in
// tests/unit/short-label.test.ts.

/** Where a label's leading part ends: "FA 1 – Main Stage", "Gate A: North", "Med / Ops", "Main (old)". */
const SEPARATORS = [' – ', ' — ', ' - ', ': ', ' / ', ' ('] as const;

/** A letter or a digit: the leading part must name something (not "–" or "(" alone). */
const WORDY = /[\p{L}\p{N}]/u;
/** Punctuation and spaces a cut must not end with ("Main Stage," "North –", "Gate ("). */
const TRAILING = /[\s\p{P}]+$/u;

const tidy = (v: string) => v.trim().replace(/\s+/g, ' ');

/** The label's user-perceived characters (an emoji with its modifiers stays whole). */
function graphemes(v: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(v), (s) => s.segment);
  }
  return Array.from(v);
}

/** The longest whole-grapheme start of `v` whose length (UTF-16, as the server's limits count) is at most `max`. */
function cut(v: string, max: number): string {
  let out = '';
  for (const g of graphemes(v)) {
    if (out.length + g.length > max) break;
    out += g;
  }
  return out;
}

/**
 * A short name of at most `max` characters for `label`:
 * - the label itself when it fits;
 * - else the text before its first separator (" – ", " — ", " - ", ": ", " / ", " (") when that is 1..max characters
 *   ("FA 1 – Main Stage" → "FA 1");
 * - else the label cut to `max` at a word boundary, trimmed, with no trailing punctuation and no ellipsis
 *   ("Ground Control Dispatch Team", 24 → "Ground Control Dispatch"). A label with no space is cut hard.
 * Never empty for a label with any visible character; '' for a blank label.
 */
export function deriveShort(label: string, max: number): string {
  const text = tidy(label);
  if (!text || max < 1) return '';
  if (text.length <= max) return text;

  let first = -1;
  for (const sep of SEPARATORS) {
    const at = text.indexOf(sep);
    if (at > 0 && (first < 0 || at < first)) first = at;
  }
  if (first > 0) {
    const head = text.slice(0, first).replace(TRAILING, '');
    if (head.length >= 1 && head.length <= max && WORDY.test(head)) return head;
  }

  const hard = cut(text, max);
  // The cut ends between words when the next character is a space; otherwise back up to the last space in it.
  const atWord = text.charAt(hard.length) === ' ';
  const lastSpace = hard.lastIndexOf(' ');
  const words = atWord ? hard : lastSpace > 0 ? hard.slice(0, lastSpace) : hard;
  const clean = words.replace(TRAILING, '');
  if (clean) return clean;
  // Only punctuation in reach (a label of separators): the hard cut, trimmed, rather than nothing.
  return hard.trim() || hard;
}

/** What a post's or team's short will be: the typed Short, or the derived one when it is blank. */
export function effectiveShort(label: string, short: string | null | undefined, max: number): string {
  return tidy(short ?? '') || deriveShort(label, max);
}
