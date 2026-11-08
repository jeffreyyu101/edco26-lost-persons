// Desk keyboard (components/desk/keyboard.ts): which key does what, and when nothing fires. Synthetic only.
import { describe, expect, it } from 'vitest';
import {
  decideShortcut,
  describeTarget,
  inMessageLane,
  mainRowId,
  readRowIds,
  type KeyInput,
  type ShortcutContext,
  type TargetInfo,
} from '@/components/desk/keyboard';

const key = (k: string, mods: Partial<KeyInput> = {}): KeyInput => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
const BODY: TargetInfo = { editable: false, inOverlay: false, row: false, body: true };
const ROW: TargetInfo = { editable: false, inOverlay: false, row: true, body: false };
const BUTTON: TargetInfo = { editable: false, inOverlay: false, row: false, body: false };
const INPUT: TargetInfo = { editable: true, inOverlay: false, row: false, body: false };
const IN_MENU: TargetInfo = { editable: false, inOverlay: true, row: false, body: false };
const CLOSED: ShortcutContext = { overlayOpen: false, formOpen: false, paneOpen: false };
const OPEN: ShortcutContext = { overlayOpen: false, formOpen: false, paneOpen: true };

describe('decideShortcut', () => {
  it('maps the contract keys', () => {
    expect(decideShortcut(key('/'), BODY, CLOSED)).toBe('search');
    expect(decideShortcut(key('n'), BODY, CLOSED)).toBe('new');
    expect(decideShortcut(key('N', { shiftKey: true }), BODY, CLOSED)).toBe('new');
    expect(decideShortcut(key('j'), BODY, CLOSED)).toBe('next');
    expect(decideShortcut(key('J'), ROW, CLOSED)).toBe('next');
    expect(decideShortcut(key('k'), BODY, CLOSED)).toBe('prev');
    expect(decideShortcut(key('K'), BUTTON, OPEN)).toBe('prev');
    expect(decideShortcut(key('Escape'), BODY, OPEN)).toBe('close');
    expect(decideShortcut(key('Escape'), ROW, OPEN)).toBe('close');
  });

  it('works from any non-text control, not only the page', () => {
    expect(decideShortcut(key('/'), BUTTON, CLOSED)).toBe('search');
    expect(decideShortcut(key('n'), ROW, OPEN)).toBe('new');
    expect(decideShortcut(key('j'), BUTTON, OPEN)).toBe('next');
  });

  it('arrow keys move only from a row or from nothing (elsewhere they scroll or drive a widget)', () => {
    expect(decideShortcut(key('ArrowDown'), BODY, CLOSED)).toBe('next');
    expect(decideShortcut(key('ArrowUp'), ROW, OPEN)).toBe('prev');
    expect(decideShortcut(key('ArrowDown'), BUTTON, OPEN)).toBeNull();
    expect(decideShortcut(key('ArrowDown', { shiftKey: true }), ROW, CLOSED)).toBeNull();
  });

  it('Enter opens the selection from nothing; on a row it is the row’s own click', () => {
    expect(decideShortcut(key('Enter'), BODY, CLOSED)).toBe('open');
    expect(decideShortcut(key('Enter'), ROW, CLOSED)).toBeNull();
    expect(decideShortcut(key('Enter'), BUTTON, CLOSED)).toBeNull();
  });

  it('Esc does nothing without an open request', () => {
    expect(decideShortcut(key('Escape'), BODY, CLOSED)).toBeNull();
  });

  it('never fires while typing', () => {
    for (const k of ['/', 'n', 'N', 'j', 'k', 'ArrowDown', 'ArrowUp', 'Enter', 'Escape']) {
      expect(decideShortcut(key(k), INPUT, OPEN), k).toBeNull();
    }
  });

  it('never fires inside, or while there is, a dialog, sheet, menu or popover, or while a form is open', () => {
    for (const k of ['/', 'n', 'j', 'k', 'ArrowDown', 'Enter', 'Escape']) {
      expect(decideShortcut(key(k), IN_MENU, OPEN), `${k} in a menu`).toBeNull();
      expect(decideShortcut(key(k), BODY, { ...OPEN, overlayOpen: true }), `${k} with a dialog open`).toBeNull();
      expect(decideShortcut(key(k), BODY, { ...OPEN, formOpen: true }), `${k} with a form open`).toBeNull();
    }
  });

  it('leaves every Cmd / Ctrl / Alt combination to the browser and the form', () => {
    for (const k of ['l', 't', 'w', 'n', 'N', 'Enter', 'k', 'j', '/']) {
      expect(decideShortcut(key(k, { metaKey: true }), BODY, CLOSED), `Cmd+${k}`).toBeNull();
      expect(decideShortcut(key(k, { ctrlKey: true }), BODY, CLOSED), `Ctrl+${k}`).toBeNull();
      expect(decideShortcut(key(k, { altKey: true }), BODY, CLOSED), `Alt+${k}`).toBeNull();
    }
  });

  it('ignores composition, handled events and other keys', () => {
    expect(decideShortcut(key('n', { isComposing: true }), BODY, CLOSED)).toBeNull();
    expect(decideShortcut(key('Process'), BODY, CLOSED)).toBeNull();
    expect(decideShortcut(key('Escape', { defaultPrevented: true }), BODY, OPEN)).toBeNull();
    for (const k of ['a', 'c', ' ', 'Tab', '?', 'Backspace', 'ArrowLeft']) expect(decideShortcut(key(k), BODY, OPEN), k).toBeNull();
  });
});

/** A minimal element: tag, type, contenteditable and the ancestors that `closest` can match. */
function el(tag: string, opts: { type?: string; editable?: boolean; matches?: string[] } = {}) {
  const matches = opts.matches ?? [];
  return {
    tagName: tag,
    isContentEditable: opts.editable ?? false,
    getAttribute: (name: string) => (name === 'type' ? (opts.type ?? null) : null),
    closest: (selector: string) => (matches.some((m) => selector.includes(m)) ? {} : null),
  };
}

describe('describeTarget', () => {
  const doc = { body: { tagName: 'BODY' } };

  it('treats the page itself as nothing focused', () => {
    expect(describeTarget(doc.body as unknown as EventTarget, doc).body).toBe(true);
    expect(describeTarget(null, doc).body).toBe(true);
  });

  it('knows typing targets', () => {
    expect(describeTarget(el('INPUT') as unknown as EventTarget, doc).editable).toBe(true);
    expect(describeTarget(el('INPUT', { type: 'search' }) as unknown as EventTarget, doc).editable).toBe(true);
    expect(describeTarget(el('TEXTAREA') as unknown as EventTarget, doc).editable).toBe(true);
    expect(describeTarget(el('SELECT') as unknown as EventTarget, doc).editable).toBe(true);
    expect(describeTarget(el('DIV', { editable: true }) as unknown as EventTarget, doc).editable).toBe(true);
    expect(describeTarget(el('INPUT', { type: 'checkbox' }) as unknown as EventTarget, doc).editable).toBe(false);
    expect(describeTarget(el('BUTTON') as unknown as EventTarget, doc).editable).toBe(false);
  });

  it('knows rows and overlays', () => {
    expect(describeTarget(el('BUTTON', { matches: ['[data-request-id]'] }) as unknown as EventTarget, doc).row).toBe(true);
    expect(describeTarget(el('BUTTON', { matches: ['[role="menu"]'] }) as unknown as EventTarget, doc).inOverlay).toBe(true);
    expect(describeTarget(el('BUTTON', { matches: ['[role="dialog"]'] }) as unknown as EventTarget, doc).inOverlay).toBe(true);
    expect(describeTarget(el('A') as unknown as EventTarget, doc)).toEqual({ editable: false, inOverlay: false, row: false, body: false });
  });
});

describe('readRowIds', () => {
  const row = (id: string, visible = true) => ({
    getAttribute: (name: string) => (name === 'data-request-id' ? id : null),
    getClientRects: () => (visible ? [{}] : []),
  });
  const root = (rows: ReturnType<typeof row>[]) => ({ querySelectorAll: () => rows }) as unknown as ParentNode;

  it('lists visible rows once, in document order', () => {
    expect(readRowIds(root([row('a'), row('b'), row('a'), row('c', false), row('d')]))).toEqual(['a', 'b', 'd']);
    expect(readRowIds(null)).toEqual([]);
  });
});

describe('mainRowId', () => {
  /** A target whose closest main-column row (if any) carries `id`. */
  const target = (id: string | null, selectorSeen: string[] = []) => ({
    closest: (selector: string) => {
      selectorSeen.push(selector);
      return id === null ? null : { getAttribute: (name: string) => (name === 'data-request-id' ? id : null) };
    },
  });

  it("is the id of the main column's row the click landed in (the row a pane click opens in place)", () => {
    const seen: string[] = [];
    expect(mainRowId(target('00000000-0000-4000-8000-00000000000b', seen) as unknown as EventTarget)).toBe('00000000-0000-4000-8000-00000000000b');
    expect(seen).toEqual(['[data-desk-main] [data-request-id]']);
  });

  it('is null off a row, for an empty id, and for no target or a non-element (the window)', () => {
    expect(mainRowId(target(null) as unknown as EventTarget)).toBeNull();
    expect(mainRowId(target('') as unknown as EventTarget)).toBeNull();
    expect(mainRowId(null)).toBeNull();
    expect(mainRowId({} as EventTarget)).toBeNull();
  });
});

describe('inMessageLane', () => {
  it("(message lane) a click inside a row's lane mark opens at the thread, docked too; anywhere else does not", () => {
    const seen: string[] = [];
    const inLane = { closest: (sel: string) => (seen.push(sel), sel === '[data-thread-badge]' ? {} : null) };
    expect(inMessageLane(inLane as unknown as EventTarget)).toBe(true);
    expect(seen).toEqual(['[data-thread-badge]']);
    expect(inMessageLane({ closest: () => null } as unknown as EventTarget)).toBe(false);
    expect(inMessageLane(null)).toBe(false);
    expect(inMessageLane({} as EventTarget)).toBe(false);
  });
});
