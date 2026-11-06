// Desk keyboard shortcuts (from 768 px): "/" search, N new request, J/K or ↓/↑ move through the main
// column's requests, Enter opens the selected one, Esc closes the open request. The decision is pure
// (decideShortcut, unit-tested in tests/unit/desk/keyboard.test.ts); describeTarget reads the DOM.
//
// Never fires while typing (inputs, text areas, selects, contenteditable), while a dialog, sheet, menu or
// popover is open or owns focus, while a form is open, or with Cmd / Ctrl / Alt held (the browser owns
// Cmd+L/T/W/N; Cmd+Enter belongs to the form).

export type ShortcutAction = 'search' | 'new' | 'next' | 'prev' | 'open' | 'close';

/** What the key event landed on. */
export interface TargetInfo {
  /** A text field, select or contenteditable: typing goes there. */
  editable: boolean;
  /** Inside a dialog, alert dialog, menu, listbox or popover. */
  inOverlay: boolean;
  /** A request row (an element with data-request-id) in the main column. */
  row: boolean;
  /** Nothing in particular has focus (document.body, or the document itself). */
  body: boolean;
}

export interface KeyInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
}

export interface ShortcutContext {
  /** Some dialog / sheet / menu / popover is open anywhere on the page. */
  overlayOpen: boolean;
  /** A form (new request, edit, needs attention) is open over the desk. */
  formOpen: boolean;
  /** A request is open in the detail pane. */
  paneOpen: boolean;
}

export function decideShortcut(e: KeyInput, target: TargetInfo, ctx: ShortcutContext): ShortcutAction | null {
  if (e.defaultPrevented || e.isComposing || e.key === 'Process' || e.key === 'Unidentified') return null;
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (target.editable || target.inOverlay || ctx.overlayOpen || ctx.formOpen) return null;
  switch (e.key) {
    case '/':
      return 'search';
    case 'n':
    case 'N':
      return 'new';
    case 'j':
    case 'J':
      return 'next';
    case 'k':
    case 'K':
      return 'prev';
    // Arrow keys scroll the page or move inside widgets everywhere else: only on a row or on nothing.
    case 'ArrowDown':
      return !e.shiftKey && (target.row || target.body) ? 'next' : null;
    case 'ArrowUp':
      return !e.shiftKey && (target.row || target.body) ? 'prev' : null;
    // Enter on a row is the row's own click; on nothing it opens the selected row.
    case 'Enter':
      return target.body && !e.shiftKey ? 'open' : null;
    case 'Escape':
      return ctx.paneOpen ? 'close' : null;
    default:
      return null;
  }
}

/** Input types that take typed text (everything else, like checkboxes and buttons, does not). */
const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color', 'image']);

export const OVERLAY_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [aria-modal="true"]';

export const ROW_SELECTOR = '[data-request-id]';

/** Where the main column's request rows live (DeskFrame sets it). */
export const MAIN_SELECTOR = '[data-desk-main]';

interface ElementLike {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
  getAttribute?: (name: string) => string | null;
}

export function describeTarget(target: EventTarget | null, doc: { body: unknown } | null = typeof document === 'undefined' ? null : document): TargetInfo {
  const el = target as ElementLike | null;
  const body = !el || el === doc?.body || !el.tagName || el.tagName === 'HTML' || el.tagName === 'BODY';
  if (body) return { editable: false, inOverlay: false, row: false, body: true };
  const tag = el.tagName!.toUpperCase();
  const type = (el.getAttribute?.('type') ?? 'text').toLowerCase();
  const editable =
    tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && !NON_TEXT_INPUTS.has(type)) || el.isContentEditable === true;
  const inOverlay = !!el.closest?.(OVERLAY_SELECTOR);
  const row = !!el.closest?.(`${MAIN_SELECTOR} ${ROW_SELECTOR}`);
  return { editable, inOverlay, row, body: false };
}

/** Request ids in the order the main column shows them (each once). */
export function readRowIds(root: ParentNode | null): string[] {
  if (!root) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(ROW_SELECTOR))) {
    const id = el.getAttribute('data-request-id');
    if (!id || seen.has(id)) continue;
    // Rows hidden by a collapsed group (display: none) can't be moved to.
    if (el.getClientRects().length === 0) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** The main column's row for `id`, if it is on screen. */
export function rowElement(id: string): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const main = document.querySelector(MAIN_SELECTOR);
  if (!main) return null;
  for (const el of Array.from(main.querySelectorAll<HTMLElement>(ROW_SELECTOR))) {
    if (el.getAttribute('data-request-id') === id && el.getClientRects().length > 0) return el;
  }
  return null;
}

/**
 * An open dialog, sheet, menu or popover anywhere (Radix mounts their content only while open; a popover
 * is role="dialog"). Tooltips don't count.
 */
export function overlayOpen(): boolean {
  if (typeof document === 'undefined') return false;
  return document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]') !== null;
}
