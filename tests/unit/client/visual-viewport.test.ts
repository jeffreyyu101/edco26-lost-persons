// The on-screen keyboard helper shared by every sheet and the phone's request form (lib/client/visual-viewport.ts,
// hotfix F5.1): the visual viewport's box while a keyboard is up (iOS 26's box below the layout viewport
// included), following it on an element (data-kb and the --lp-vv-* variables, back at once when the field loses
// the focus), and pinning the page. A fake window / document / visualViewport stands in for the browser.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KEYBOARD_MIN_PX, UNDER_MAX_PX, followKeyboard, isTextField, keyboardBox, lockPageScroll, revealDelta } from '@/lib/client/visual-viewport';

describe('keyboardBox', () => {
  const vv = (height: number, offsetTop = 0, scale = 1) => ({ height, offsetTop, scale });

  it('is null without a keyboard: the full screen, a toolbar or accessory strip, a pinch zoom', () => {
    expect(keyboardBox(844, vv(844))).toBeNull();
    expect(keyboardBox(844, vv(844 - KEYBOARD_MIN_PX))).toBeNull();
    expect(keyboardBox(844, vv(400, 0, 2))).toBeNull();
  });

  it('is the visual viewport above the keyboard (iPhone 14, the Home Screen app)', () => {
    expect(keyboardBox(844, vv(508))).toEqual({ top: 0, height: 508, under: 0 });
  });

  it('follows a pan: the phone scrolled the visual viewport down to show the field', () => {
    expect(keyboardBox(844, vv(508, 150))).toEqual({ top: 150, height: 508, under: 0 });
  });

  it('measures the part below the layout viewport (iOS 26 Safari: its tab bar floats there)', () => {
    // innerHeight 788 (to the tab bar), panned 336 px: the visible area ends 56 px below the layout viewport.
    expect(keyboardBox(788, vv(508, 336))).toEqual({ top: 336, height: 508, under: 56 });
    // Never more than UNDER_MAX_PX, whatever the numbers say.
    expect(keyboardBox(600, vv(400, 500))?.under).toBe(UNDER_MAX_PX);
  });

  it('rounds to whole pixels', () => {
    expect(keyboardBox(844.4, vv(507.6, 0.4))).toEqual({ top: 0, height: 508, under: 0 });
  });
});

// ---- A stand-in browser ------------------------------------------------------------------------------

class FakeStyle {
  props = new Map<string, { value: string; priority: string }>();
  setProperty(k: string, v: string, priority = '') {
    this.props.set(k, { value: v, priority });
  }
  removeProperty(k: string) {
    this.props.delete(k);
  }
  get(k: string) {
    return this.props.get(k)?.value;
  }
}

const field = () => ({ matches: () => true });
const button = () => ({ matches: () => false });

function focusEvent(type: 'focusin' | 'focusout', relatedTarget: unknown = null): Event {
  return Object.assign(new Event(type), { relatedTarget });
}

let vv: EventTarget & { height: number; offsetTop: number; scale: number };
let doc: EventTarget & { activeElement: unknown; body: { style: FakeStyle } };
let win: { visualViewport: typeof vv | undefined; innerHeight: number; scrollY: number; scrollTo: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vv = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 });
  doc = Object.assign(new EventTarget(), { activeElement: null as unknown, body: { style: new FakeStyle() } });
  win = { visualViewport: vv, innerHeight: 844, scrollY: 0, scrollTo: vi.fn() };
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function element() {
  return { style: new FakeStyle(), dataset: {} as Record<string, string> };
}

function keyboard(height: number, offsetTop = 0) {
  Object.assign(vv, { height, offsetTop });
  vv.dispatchEvent(new Event('resize'));
}

describe('followKeyboard', () => {
  it('writes the box while the keyboard is up, follows a pan, and clears it when the keyboard goes', () => {
    const el = element();
    const stop = followKeyboard(el as unknown as HTMLElement);
    expect(el.dataset.kb).toBeUndefined();

    keyboard(508);
    expect(el.dataset.kb).toBe('');
    expect([el.style.get('--lp-vv-top'), el.style.get('--lp-vv-h'), el.style.get('--lp-vv-under')]).toEqual(['0px', '508px', '0px']);

    vv.offsetTop = 120;
    vv.dispatchEvent(new Event('scroll'));
    expect(el.style.get('--lp-vv-top')).toBe('120px');

    keyboard(844);
    expect(el.dataset.kb).toBeUndefined();
    expect(el.style.props.size).toBe(0);
    stop();
  });

  it('lets go as soon as the field loses the focus, before the keyboard reports it is gone', () => {
    const el = element();
    const stop = followKeyboard(el as unknown as HTMLElement);
    doc.activeElement = field();
    keyboard(508);
    expect(el.dataset.kb).toBe('');

    // Focus moves to another field (the keyboard's next / previous arrows): it stays.
    doc.dispatchEvent(focusEvent('focusout', field()));
    expect(el.dataset.kb).toBe('');

    // Focus leaves for a button or nowhere (Done): back to the bottom now, and late keyboard events are ignored.
    doc.dispatchEvent(focusEvent('focusout', button()));
    expect(el.dataset.kb).toBeUndefined();
    vv.dispatchEvent(new Event('resize'));
    expect(el.dataset.kb).toBeUndefined();

    // A field takes the focus again: the keyboard counts again.
    doc.dispatchEvent(focusEvent('focusin'));
    expect(el.dataset.kb).toBe('');
    stop();
  });

  it('reads the iOS 26 box below the layout viewport', () => {
    win.innerHeight = 788;
    const el = element();
    const stop = followKeyboard(el as unknown as HTMLElement);
    keyboard(508, 336);
    expect([el.style.get('--lp-vv-top'), el.style.get('--lp-vv-h'), el.style.get('--lp-vv-under')]).toEqual(['336px', '508px', '56px']);
    stop();
  });

  it('stops listening and clears everything when stopped; nothing at all without a visualViewport', () => {
    const el = element();
    const stop = followKeyboard(el as unknown as HTMLElement);
    keyboard(508);
    stop();
    expect(el.dataset.kb).toBeUndefined();
    expect(el.style.props.size).toBe(0);
    keyboard(400);
    expect(el.dataset.kb).toBeUndefined();

    win.visualViewport = undefined;
    const other = element();
    followKeyboard(other as unknown as HTMLElement)();
    expect(other.dataset.kb).toBeUndefined();
  });
});

describe('lockPageScroll', () => {
  it('pins the body at its scroll offset (important, over Radix) and puts the scroll back once every lock is released', () => {
    win.scrollY = 400;
    const style = doc.body.style;
    const first = lockPageScroll();
    expect(style.props.get('position')).toEqual({ value: 'fixed', priority: 'important' });
    expect(style.get('top')).toBe('-400px');
    const second = lockPageScroll();
    first();
    first();
    expect(style.get('position')).toBe('fixed');
    expect(win.scrollTo).not.toHaveBeenCalled();
    second();
    expect(style.props.size).toBe(0);
    expect(win.scrollTo).toHaveBeenCalledWith(0, 400);
  });
});

describe('revealDelta (a sheet or the form keeps its focused field in view)', () => {
  it('scrolls a field under the sheet\'s foot up into view, never past its top; nothing when it shows', () => {
    const view = { top: 300, bottom: 600 };
    expect(revealDelta(view, { top: 400, bottom: 450 }, 12)).toBe(0);
    expect(revealDelta(view, { top: 590, bottom: 640 }, 12)).toBe(52);
    expect(revealDelta(view, { top: 290, bottom: 340 }, 12)).toBe(-22);
    expect(revealDelta(view, { top: 320, bottom: 900 }, 12)).toBe(8);
  });
});

describe('isTextField', () => {
  it('asks the element; anything without matches() is not one', () => {
    expect(isTextField(field())).toBe(true);
    expect(isTextField(button())).toBe(false);
    expect(isTextField(null)).toBe(false);
    expect(isTextField({})).toBe(false);
  });
});
