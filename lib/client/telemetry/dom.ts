// The DOM side of the collector (design §4.2): passive listeners whose handlers only record event properties and push
// onto a queue; `process()` drains it in idle time, where controls and areas are named (attribute reads only), the
// detectors run, and the few deferred layout reads happen (a mouse tap's cursor; a stuck swipe's scroll edge). No
// handler reads text, values or layout.
import { KEYS, type TelView } from '../../telemetry';
import type { Props, TelEvent } from './buffer';
import { DEAD, Loop, RageTap, StuckScroll, TAPPABLE_LOOK, TICKING, dirOf, isStill, responded, type Dir } from './detect';
import type { Guard } from './host';
import { area, ctl, dialogId, firstClassToken, formField, hasClass, interactive, isDialog, isTextField, testid, type NodeLike } from './sanitize';


/** What the DOM watcher needs from the collector. */
export interface DomCore {
  win: Window;
  doc: Document;
  guard: Guard;
  now(): number;
  view(): TelView;
  sampled(): boolean;
  /** A discrete event (the view is added). */
  emit(e: TelEvent): void;
  /** A frustration event (view and trail added). */
  frustration(e: TelEvent): void;
  crumb(code: string, t?: number): void;
  agg(key: string, make: () => TelEvent, update: (e: TelEvent) => void): void;
  /** Response marks for dead taps (the newest time each happened). */
  marks: Marks;
  /** A tap on a control (flows). */
  onTap(control: string, section: string | null, area: string, t: number): void;
  onField(section: string, key: string, t: number): void;
  onInvalid(): void;
  idle(fn: () => void): void;
}

export interface Marks {
  tap: number;
  view: number;
  api: number;
  sheet: number;
  focus: number;
  store: number;
  mutation: number;
  key: { k: string; t: number };
  swipeEnd: number;
}

export function newMarks(): Marks {
  return { tap: 0, view: 0, api: 0, sheet: 0, focus: 0, store: 0, mutation: 0, key: { k: '', t: 0 }, swipeEnd: 0 };
}

type Item =
  | { k: 'down'; t: number; x: number; y: number; target: NodeLike | null; ptr: string }
  | { k: 'up'; t: number; moved: number; held: number; target: NodeLike | null; ptr: string; href: string }
  | { k: 'key'; t: number; key: string }
  | { k: 'focus'; t: number; target: NodeLike | null }
  | { k: 'swipe'; t: number; due: number; t0: number; dx: number; dy: number; target: NodeLike | null; prevented: boolean; input: 'touch' | 'wheel' }
  | { k: 'dialog'; t: number; el: NodeLike; open: boolean }
  | { k: 'pinch'; t: number; touches: number; target: NodeLike | null }
  | { k: 'dead'; t: number; due: number; why: 'not_interactive' | 'no_response'; a: string; c: string; ptr: string; href: string }
  | { k: 'inval'; t: number; due: number };

const MAX_QUEUE = 200;
const SWIPE_MIN_PX = 30;
const TAP_MAX_MOVE_PX = 10;
const TAP_MAX_MS = 800;
const STILL_AFTER_MS = 400;
const WHEEL_GAP_MS = 150;
const PINCH_DEDUPE_MS = 3_000;
const CLOSE_CONTROL = /(close|dismiss|cancel|(^|[-.])x$)/;

export interface DomWatch {
  process(): void;
  /** Open dialogs right now (stuck scroll's `sheet`). */
  openDialogs(): number;
  /** The view changed (dialog close "how", the loop on profile). */
  viewChanged(prev: string | null, name: string, dwell: number, t: number): void;
}

type MO = typeof MutationObserver;
const mutationObserverOf = (win: Window): MO | null => {
  const M = (win as Window & { MutationObserver?: MO }).MutationObserver;
  return typeof M === 'function' ? M : null;
};

export function attachDom(core: DomCore): DomWatch {
  const { win, doc, guard } = core;
  const MOClass = mutationObserverOf(win);
  const queue: Item[] = [];
  const rage = new RageTap();
  const stuck = new StuckScroll();
  const loop = new Loop();
  const downs = new Map<number, { t: number; x: number; y: number }>();
  const scrolls: Array<{ t: number; target: unknown }> = [];
  const dialogs = new Map<NodeLike, { id: string; t: number; role: string }>();
  let touch: { t: number; x: number; y: number; lx: number; ly: number; target: NodeLike | null; prevented: boolean } | null = null;
  let wheel: { t0: number; last: number; dx: number; dy: number; target: NodeLike | null } | null = null;
  let wheelTimer: number | undefined;
  let lastPinch = 0;
  let lastTap: { t: number; c: string; target: NodeLike | null } | null = null;
  let scheduled = false;
  let timer: number | undefined;
  let mo: MutationObserver | null = null;
  let watchUntil = 0;

  const schedule = () => {
    if (scheduled || !guard.alive) return;
    scheduled = true;
    core.idle(() => {
      scheduled = false;
      process();
    });
  };
  const scheduleAt = (due: number) => {
    if (timer !== undefined) return;
    timer = win.setTimeout(
      guard.wrap(() => {
        timer = undefined;
        schedule();
      }),
      Math.max(50, due - core.now()),
    );
  };
  guard.add(() => {
    if (timer !== undefined) win.clearTimeout(timer);
    if (wheelTimer !== undefined) win.clearTimeout(wheelTimer);
    mo?.disconnect();
  });
  const withView = (item: Item, v: TelView): Item => {
    views.set(item, v);
    return item;
  };
  // Each item keeps the view it happened in (idle processing can come after a view change, on Safari especially).
  const views = new WeakMap<Item, TelView>();
  const enqueue = (item: Item) => {
    if (queue.length >= MAX_QUEUE) return;
    views.set(item, core.view());
    queue.push(item);
    schedule();
  };
  const targetOf = (e: Event): NodeLike | null => {
    const t = e.target as unknown as NodeLike | null;
    return t && typeof t === 'object' && 'parentElement' in t ? t : null;
  };

  // A body mutation watch while a tap waits for its response (started in the handler: React answers a tap before
  // idle time comes). Ticking text (the live line) does not count.
  const watchMutations = (t: number) => {
    watchUntil = t + DEAD.responseMs + 200;
    if (mo || !MOClass || !doc.body) return;
    const observer = new MOClass(
      guard.wrap((records: MutationRecord[]) => {
        const now = core.now();
        for (const r of records) {
          const node = r.target as unknown as NodeLike & { nodeType?: number };
          const el = node.nodeType === 1 ? node : (node.parentElement ?? null);
          const id = testid(el) ?? testid(el?.parentElement ?? null);
          if (id && TICKING.has(id)) continue;
          core.marks.mutation = now;
          break;
        }
        if (now > watchUntil) {
          mo?.disconnect();
          mo = null;
        }
      }),
    );
    mo = observer;
    observer.observe(doc.body, { subtree: true, childList: true, attributes: true, characterData: true });
    win.setTimeout(
      guard.wrap(() => {
        if (core.now() >= watchUntil) {
          mo?.disconnect();
          mo = null;
        }
      }),
      DEAD.responseMs + 400,
    );
  };

  // ---- Pointer ------------------------------------------------------------------------------------
  guard.on(doc, 'pointerdown', (e) => {
    const p = e as PointerEvent;
    const t = core.now();
    core.marks.tap = t;
    downs.set(p.pointerId, { t, x: p.clientX, y: p.clientY });
    if (downs.size > 10) downs.delete(downs.keys().next().value as number);
    enqueue({ k: 'down', t, x: p.clientX, y: p.clientY, target: targetOf(e), ptr: p.pointerType || 'touch' });
  });
  guard.on(doc, 'pointerup', (e) => {
    const p = e as PointerEvent;
    const t = core.now();
    const d = downs.get(p.pointerId);
    downs.delete(p.pointerId);
    const moved = d ? Math.hypot(p.clientX - d.x, p.clientY - d.y) : 0;
    const held = d ? t - d.t : 0;
    if (moved <= TAP_MAX_MOVE_PX && held <= TAP_MAX_MS) watchMutations(t);
    enqueue({ k: 'up', t, moved, held, target: targetOf(e), ptr: p.pointerType || 'touch', href: win.location?.href ?? '' });
  });

  // ---- Touch, wheel and scroll (bubble on window: after the app's own non-passive handlers) ------------
  guard.on(
    win,
    'touchstart',
    (e) => {
      const te = e as TouchEvent;
      const t = core.now();
      if (te.touches.length >= 2) {
        touch = null;
        if (t - lastPinch > PINCH_DEDUPE_MS) {
          lastPinch = t;
          enqueue({ k: 'pinch', t, touches: te.touches.length, target: targetOf(e) });
        }
        return;
      }
      const p = te.touches[0];
      if (!p) return;
      touch = { t, x: p.clientX, y: p.clientY, lx: p.clientX, ly: p.clientY, target: targetOf(e), prevented: false };
    },
    { capture: false },
  );
  guard.on(
    win,
    'touchmove',
    (e) => {
      if (!touch) return;
      const p = (e as TouchEvent).touches[0];
      if (p) {
        touch.lx = p.clientX;
        touch.ly = p.clientY;
      }
      if (e.defaultPrevented) touch.prevented = true;
    },
    { capture: false },
  );
  guard.on(
    win,
    'touchend',
    () => {
      const s = touch;
      touch = null;
      if (!s) return;
      const t = core.now();
      const dx = s.lx - s.x;
      const dy = s.ly - s.y;
      if (Math.hypot(dx, dy) < SWIPE_MIN_PX) return;
      core.marks.swipeEnd = t;
      enqueue({ k: 'swipe', t, due: t + STILL_AFTER_MS, t0: s.t, dx, dy, target: s.target, prevented: s.prevented, input: 'touch' });
    },
    { capture: false },
  );
  guard.on(
    win,
    'gesturestart',
    (e) => {
      const t = core.now();
      if (t - lastPinch <= PINCH_DEDUPE_MS) return;
      lastPinch = t;
      enqueue({ k: 'pinch', t, touches: 2, target: targetOf(e) });
    },
    { capture: false },
  );
  const endWheel = () => {
    wheelTimer = undefined;
    const w = wheel;
    if (!w) return;
    if (core.now() - w.last < WHEEL_GAP_MS) {
      wheelTimer = win.setTimeout(guard.wrap(endWheel), WHEEL_GAP_MS);
      return;
    }
    wheel = null;
    if (Math.hypot(w.dx, w.dy) < 1) return;
    // The finger's direction: a wheel scrolling down is a finger moving up.
    enqueue({ k: 'swipe', t: w.last, due: w.last + 300, t0: w.t0, dx: -w.dx, dy: -w.dy, target: w.target, prevented: false, input: 'wheel' });
  };
  guard.on(
    win,
    'wheel',
    (e) => {
      const we = e as WheelEvent;
      const t = core.now();
      if (!wheel) {
        wheel = { t0: t, last: t, dx: 0, dy: 0, target: targetOf(e) };
        wheelTimer = win.setTimeout(guard.wrap(endWheel), WHEEL_GAP_MS);
      }
      wheel.last = t;
      wheel.dx += we.deltaX || 0;
      wheel.dy += we.deltaY || 0;
    },
    { capture: false },
  );
  guard.on(doc, 'scroll', (e) => {
    scrolls.push({ t: core.now(), target: e.target });
    if (scrolls.length > 40) scrolls.shift();
  });

  // ---- Keys and focus -----------------------------------------------------------------------------
  guard.on(doc, 'keydown', (e) => {
    const ke = e as KeyboardEvent;
    if (isTextField(targetOf(e))) return;
    const raw = typeof ke.key === 'string' ? ke.key.toLowerCase() : '';
    const key = raw === '/' ? 'slash' : raw;
    if (!(KEYS as readonly string[]).includes(key)) return;
    const t = core.now();
    core.marks.key = { k: key, t };
    enqueue({ k: 'key', t, key });
  });
  guard.on(doc, 'focusin', (e) => {
    const t = core.now();
    core.marks.focus = t;
    enqueue({ k: 'focus', t, target: targetOf(e) });
  });

  // ---- Dialogs, sheets, menus and popovers (portals under <body>) -----------------------------------
  const findDialog = (node: unknown): NodeLike | null => {
    const el = node as NodeLike & { nodeType?: number; querySelector?(s: string): unknown };
    if (!el || el.nodeType !== 1) return null;
    if (isDialog(el)) return el;
    const inner = el.querySelector?.('[role=dialog],[role=alertdialog],[role=menu]');
    return inner ? (inner as NodeLike) : null;
  };
  if (MOClass && doc.body) {
    const bodyWatch = new MOClass(
      guard.wrap((records: MutationRecord[]) => {
        const t = core.now();
        for (const r of records) {
          for (const node of Array.from(r.addedNodes)) {
            const el = findDialog(node);
            if (el && !dialogs.has(el)) enqueue({ k: 'dialog', t, el, open: true });
          }
          for (const node of Array.from(r.removedNodes)) {
            const n = node as unknown as NodeLike;
            for (const el of dialogs.keys()) if (el === n || n.contains?.(el)) enqueue({ k: 'dialog', t, el, open: false });
          }
        }
      }),
    );
    bodyWatch.observe(doc.body, { childList: true });
    guard.add(() => bodyWatch.disconnect());
  }

  // ---- Processing (idle time) -----------------------------------------------------------------------
  const view = () => core.view();

  const sheetHow = (el: NodeLike, t: number): string => {
    if (core.marks.key.k === 'escape' && t - core.marks.key.t <= 300) return 'esc';
    if (lastTap && t - lastTap.t <= 1_000) {
      if (CLOSE_CONTROL.test(lastTap.c)) return 'x';
      const inside = !!lastTap.target && !!el.contains?.(lastTap.target);
      return inside ? 'action' : 'backdrop';
    }
    if (t - core.marks.swipeEnd <= 300) return 'swipe';
    if (t - core.marks.view <= 300) return 'nav';
    return 'unknown';
  };

  const looksTappable = (target: NodeLike | null, ptr: string): boolean => {
    let el = target;
    for (let i = 0; el && i <= 3; i += 1, el = el.parentElement ?? null) {
      const name = testid(el) ?? firstClassToken(el);
      if (name && TAPPABLE_LOOK.test(name)) return true;
    }
    if (ptr === 'mouse' && target && typeof win.getComputedStyle === 'function') {
      try {
        return win.getComputedStyle(target as unknown as Element).cursor === 'pointer';
      } catch {
        return false;
      }
    }
    return false;
  };

  const disabledControl = (target: NodeLike | null): boolean => {
    let el = target;
    for (let i = 0; el && i <= 8; i += 1, el = el.parentElement ?? null) {
      if (el.getAttribute?.('aria-disabled') === 'true') return true;
      if ((el.tagName ?? '').toLowerCase() === 'button' && el.disabled === true) return true;
    }
    return false;
  };

  const edgeOf = (target: NodeLike | null): string => {
    try {
      let el = target as unknown as (Element & { scrollTop: number; scrollHeight: number; clientHeight: number }) | null;
      for (let i = 0; el && i < 30; i += 1, el = el.parentElement as typeof el) {
        if (el.scrollHeight > el.clientHeight + 1) {
          const style = win.getComputedStyle?.(el);
          if (style && !/(auto|scroll)/.test(style.overflowY)) continue;
          if (el.scrollTop <= 0) return 'top';
          if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) return 'bottom';
          return 'mid';
        }
      }
      const root = doc.scrollingElement as (Element & { scrollTop: number; scrollHeight: number; clientHeight: number }) | null;
      if (!root) return 'unk';
      if (root.scrollTop <= 0) return 'top';
      return root.scrollTop + root.clientHeight >= root.scrollHeight - 1 ? 'bottom' : 'mid';
    } catch {
      return 'unk';
    }
  };

  const gesture = (target: NodeLike | null): boolean => {
    let el = target;
    for (let i = 0; el && i <= 12; i += 1, el = el.parentElement ?? null) {
      if (hasClass(el, 'lp-toaster')) return true;
      if (el.hasAttribute?.('data-sheet-grab')) return true;
      const id = testid(el);
      if (id && id.endsWith('grabber')) return true;
    }
    return false;
  };

  const DIR_CODE: Record<Dir, string> = { up: 'u', down: 'd', left: 'l', right: 'r' };

  const handle = (item: Item) => {
    const v = views.get(item) ?? view();
    switch (item.k) {
      case 'down': {
        const hit = rage.down(item.t, item.x, item.y);
        if (hit) {
          core.frustration({ v, n: 'rage_tap', at: item.t, a: area(item.target), c: ctl(item.target), k: hit.k, p: { ptr: item.ptr, inter: !!interactive(item.target), r: hit.r } });
        }
        return;
      }
      case 'up': {
        if (item.moved > TAP_MAX_MOVE_PX || item.held > TAP_MAX_MS) return;
        const target = item.target;
        const inter = interactive(target);
        const c = ctl(target);
        const a = area(target);
        lastTap = { t: item.t, c, target };
        core.crumb(`t:${a}/${c}`, item.t);
        if (core.sampled()) core.agg(`tap|${v}|${a}|${c}|${item.ptr}`, () => ({ n: 'tap', at: item.t, v, a, c, k: 0, p: { ptr: item.ptr } }), (e) => (e.k = (e.k ?? 0) + 1));
        core.onTap(c, formField(target)?.section ?? null, a, item.t);
        if (c === 'request-form-submit') queue.push(withView({ k: 'inval', t: item.t, due: item.t + 700 }, v));
        if (disabledControl(target)) {
          core.frustration({ v, n: 'dead_tap', at: item.t, a, c, p: { why: 'disabled', ptr: item.ptr } });
          return;
        }
        const tag = (inter?.tagName ?? '').toLowerCase();
        const role = inter?.getAttribute?.('role') ?? null;
        const watch = !inter ? (looksTappable(target, item.ptr) ? 'not_interactive' : null) : tag === 'button' || tag === 'a' || role === 'button' ? 'no_response' : null;
        if (watch) queue.push(withView({ k: 'dead', t: item.t, due: item.t + DEAD.responseMs, why: watch, a, c, ptr: item.ptr, href: item.href }, v));
        return;
      }
      case 'dead': {
        const href = win.location?.href ?? '';
        const m = core.marks;
        if (href !== item.href || responded(item.t, [m.view, m.api, m.sheet, m.focus, m.store, m.mutation])) return;
        core.frustration({ v, n: 'dead_tap', at: item.t, a: item.a, c: item.c, p: { why: item.why, ptr: item.ptr } });
        return;
      }
      case 'inval': {
        try {
          if (doc.querySelector?.('.lp-rf-err')) core.onInvalid();
        } catch {
          // a query never fails, but never break processing
        }
        return;
      }
      case 'key': {
        core.crumb(`k:${item.key}`, item.t);
        if (core.sampled()) core.agg(`key|${v}|${item.key}`, () => ({ n: 'key', at: item.t, v, c: item.key, k: 0 }), (e) => (e.k = (e.k ?? 0) + 1));
        return;
      }
      case 'focus': {
        const f = formField(item.target);
        if (isTextField(item.target)) core.crumb('kb+', item.t);
        if (!f) return;
        core.crumb(`f:${f.section}/${f.key}`, item.t);
        if (core.sampled()) core.agg(`field|${v}|${f.section}|${f.key}`, () => ({ n: 'field', at: item.t, v, a: f.section, c: f.key, k: 0 }), (e) => (e.k = (e.k ?? 0) + 1));
        core.onField(f.section, f.key, item.t);
        return;
      }
      case 'swipe': {
        if (gesture(item.target)) return;
        const a = area(item.target);
        const dir = dirOf(item.dx, item.dy);
        const target = item.target;
        const still = isStill(
          item.t0,
          item.due,
          scrolls,
          (s) => s === doc || s === doc.documentElement || s === win,
          (s) => {
            const el = s as { contains?(o: unknown): boolean } | null;
            return !!el && typeof el.contains === 'function' && !!target && el.contains(target);
          },
        );
        core.crumb(`w${still ? '!' : ''}${item.prevented ? '^' : ''}:${a}:${DIR_CODE[dir]}`, item.t);
        if (core.sampled()) {
          core.agg(
            `swipe|${v}|${a}|${item.input}`,
            () => ({ n: 'swipe', at: item.t, v, a, k: 0, p: { input: item.input } }),
            (e) => {
              const p = (e.p ??= {}) as Props;
              e.k = (e.k ?? 0) + 1;
              p[dir] = ((p[dir] as number) ?? 0) + 1;
              if (still) p.still = ((p.still as number) ?? 0) + 1;
              if (item.prevented) p.prev = ((p.prev as number) ?? 0) + 1;
            },
          );
        }
        if (!still) return;
        const hit = stuck.add(a, { t: item.t, dir, prevented: item.prevented });
        if (!hit) return;
        const vv = (win as Window & { visualViewport?: { height: number } | null }).visualViewport;
        const kb = !!vv && win.innerHeight > 0 && vv.height < 0.75 * win.innerHeight;
        core.frustration({ v, n: 'stuck_scroll', at: item.t, a, k: hit.k, p: { dir: hit.dir, edge: edgeOf(target), prev: hit.prev, input: item.input, sheet: dialogs.size > 0, kb } });
        return;
      }
      case 'dialog': {
        if (item.open) {
          if (dialogs.has(item.el)) return;
          const id = dialogId(item.el);
          const role = item.el.getAttribute?.('role') ?? 'dialog';
          dialogs.set(item.el, { id, t: item.t, role });
          core.marks.sheet = item.t;
          core.crumb(`s+${id}`, item.t);
          core.emit({ v, n: 'sheet', at: item.t, a: id, ok: true, p: { role } });
          return;
        }
        const d = dialogs.get(item.el);
        if (!d) return;
        dialogs.delete(item.el);
        const dwell = Math.max(0, item.t - d.t);
        core.marks.sheet = item.t;
        core.crumb(`s-${d.id}`, item.t);
        core.emit({ v, n: 'sheet', at: item.t, a: d.id, ok: false, ms: dwell, p: { role: d.role, how: sheetHow(item.el, item.t) } });
        const l = loop.close(d.id, dwell, item.t);
        if (l) core.frustration({ v, n: 'loop', at: item.t, a: d.id, k: l.k, ms: l.ms });
        return;
      }
      case 'pinch': {
        const vv = (win as Window & { visualViewport?: { scale: number } | null }).visualViewport;
        core.crumb('z', item.t);
        core.frustration({ v, n: 'pinch', at: item.t, a: area(item.target), p: { scale: Math.round((vv?.scale ?? 1) * 100), touches: item.touches } });
        return;
      }
    }
  };

  function process(): void {
    if (!guard.alive) return;
    const now = core.now();
    let next = Infinity;
    const later: Item[] = [];
    for (const item of queue.splice(0)) {
      const due = 'due' in item ? item.due : 0;
      if (due > now) {
        later.push(item);
        next = Math.min(next, due);
        continue;
      }
      try {
        handle(item);
      } catch {
        guard.fault();
      }
    }
    queue.push(...later);
    for (const item of queue) if ('due' in item) next = Math.min(next, item.due);
    if (next !== Infinity) scheduleAt(next);
  }

  return {
    process,
    openDialogs: () => dialogs.size,
    viewChanged(prev, name, dwell, t) {
      if (prev === 'profile' && name !== 'profile') {
        const l = loop.close('view:profile', dwell, t);
        if (l) core.frustration({ n: 'loop', at: t, a: 'view:profile', k: l.k, ms: l.ms });
      }
    },
  };
}
