// The frustration detectors (lib/client/telemetry/detect.ts, design §1.6), pure with the clock passed in, and the
// DOM watcher (dom.ts) end to end on fake elements: rage, stuck scroll, dead taps, loops, slow limits, stuck sends.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Loop, RageTap, SLOW_MS, STUCK_SEND_MS, StuckScroll, StuckSend, abortKind, dirOf, isStill, responded } from '@/lib/client/telemetry/detect';
import { attachDom, newMarks, type DomCore } from '@/lib/client/telemetry/dom';
import { createGuard } from '@/lib/client/telemetry/host';
import type { TelEvent } from '@/lib/client/telemetry/buffer';
import { FakeMutationObserver, el, ev, fakeBrowser, forbiddenReads } from './fakes';

describe('rage tap', () => {
  it('3 taps in 900 ms within 25 px: one event with k = 3', () => {
    const r = new RageTap();
    expect(r.down(0, 100, 100)).toBeNull();
    expect(r.down(400, 110, 105)).toBeNull();
    expect(r.down(900, 120, 110)).toEqual({ k: 3, r: 22 });
  });

  it('40 px apart, or over 1.2 s: none', () => {
    const far = new RageTap();
    expect([far.down(0, 0, 0), far.down(100, 40, 0), far.down(200, 80, 0)]).toEqual([null, null, null]);
    const slow = new RageTap();
    expect([slow.down(0, 0, 0), slow.down(600, 0, 0), slow.down(1200, 0, 0)]).toEqual([null, null, null]);
  });

  it('a 4th tap within 2 s does not repeat; a new cluster later does', () => {
    const r = new RageTap();
    r.down(0, 0, 0);
    r.down(100, 0, 0);
    expect(r.down(200, 0, 0)).not.toBeNull();
    expect(r.down(300, 0, 0)).toBeNull();
    expect(r.down(1500, 2, 2)).toBeNull();
    r.down(3000, 0, 0);
    r.down(3100, 0, 0);
    expect(r.down(3200, 0, 0)).toEqual({ k: 3, r: 0 });
  });

  it('a stray tap before the cluster does not hide it', () => {
    const r = new RageTap();
    r.down(0, 300, 300);
    r.down(100, 0, 0);
    r.down(200, 0, 0);
    expect(r.down(300, 0, 0)).toEqual({ k: 3, r: 0 });
  });
});

describe('stuck scroll', () => {
  it('3 still swipes in one area within 8 s: one event (dominant direction, prevented count)', () => {
    const s = new StuckScroll();
    expect(s.add('thread', { t: 0, dir: 'up', prevented: false })).toBeNull();
    expect(s.add('thread', { t: 3_000, dir: 'up', prevented: true })).toBeNull();
    expect(s.add('thread', { t: 8_000, dir: 'down', prevented: false })).toEqual({ k: 3, dir: 'up', prev: 1 });
  });

  it('other areas, an 11 s spread, and the 30 s cooldown', () => {
    const s = new StuckScroll();
    s.add('thread', { t: 0, dir: 'up', prevented: false });
    s.add('profile', { t: 100, dir: 'up', prevented: false });
    expect(s.add('thread', { t: 11_000, dir: 'up', prevented: false })).toBeNull();
    expect(s.add('thread', { t: 12_000, dir: 'up', prevented: false })).toBeNull();
    expect(s.add('thread', { t: 13_000, dir: 'up', prevented: false })).not.toBeNull();
    s.add('thread', { t: 14_000, dir: 'up', prevented: false });
    s.add('thread', { t: 15_000, dir: 'up', prevented: false });
    expect(s.add('thread', { t: 16_000, dir: 'up', prevented: false })).toBeNull();
    s.add('thread', { t: 44_000, dir: 'up', prevented: false });
    s.add('thread', { t: 44_500, dir: 'up', prevented: false });
    expect(s.add('thread', { t: 45_000, dir: 'up', prevented: false })).not.toBeNull();
  });

  it('still: no scroll from the document or a container of the target since the swipe began', () => {
    const target = { id: 't' };
    const container = { id: 'c', contains: (x: unknown) => x === target };
    const other = { id: 'o', contains: () => false };
    const doc = { id: 'doc' };
    const isDoc = (x: { id: string }) => x === doc;
    const contains = (x: { id: string; contains?: (y: unknown) => boolean }) => !!x.contains?.(target);
    expect(isStill(100, 500, [{ t: 50, target: container }, { t: 150, target: other }], isDoc, contains)).toBe(true);
    expect(isStill(100, 500, [{ t: 150, target: container }], isDoc, contains)).toBe(false);
    expect(isStill(100, 500, [{ t: 150, target: doc }], isDoc, contains)).toBe(false);
    // A scroll after the stillness window (the next view rendering) does not make it a scroll.
    expect(isStill(100, 500, [{ t: 900, target: doc }], isDoc, contains)).toBe(true);
  });

  it('direction is the finger’s', () => {
    expect(dirOf(0, -50)).toBe('up');
    expect(dirOf(0, 50)).toBe('down');
    expect(dirOf(-60, 10)).toBe('left');
    expect(dirOf(60, -10)).toBe('right');
  });
});

describe('loop, slow, stuck send, timeouts', () => {
  it('open and close within 2 s, twice within 20 s', () => {
    const l = new Loop();
    expect(l.close('alerts-sheet', 1_200, 0)).toBeNull();
    expect(l.close('alerts-sheet', 3_000, 5_000)).toBeNull();
    expect(l.close('alerts-sheet', 900, 10_000)).toEqual({ k: 2, ms: 900 });
    expect(l.close('alerts-sheet', 900, 40_000)).toBeNull();
  });

  it('slow limits per flow', () => {
    expect(SLOW_MS).toMatchObject({ api: 3_000, flow_answer: 3_000, flow_msg: 5_000, flow_submit: 10_000, flow_resume: 5_000, flow_open: 8_000 });
  });

  it('stuck send: held 121 s while online and live fires once; offline resets the clock', () => {
    const s = new StuckSend();
    expect(s.check(['o:a'], true, 0)).toEqual([]);
    expect(s.check(['o:a'], true, STUCK_SEND_MS)).toEqual([]);
    expect(s.check(['o:a'], true, 121_000)).toEqual([{ id: 'o:a', age: 121 }]);
    expect(s.check(['o:a'], true, 200_000)).toEqual([]);
    const off = new StuckSend();
    off.check(['m:b'], true, 0);
    off.check(['m:b'], false, 60_000);
    expect(off.check(['m:b'], true, 130_000)).toEqual([]);
    expect(off.check(['m:b'], true, 251_000)).toEqual([{ id: 'm:b', age: 121 }]);
  });

  it('an AbortError is a timeout within 250 ms of the path’s client timeout, else an abort', () => {
    expect(abortKind('/api/sync:delta', 'get', 11_800)).toBe('timeout');
    expect(abortKind('/api/sync:delta', 'get', 3_000)).toBe('abort');
    expect(abortKind('/api/requests', 'post', 14_800)).toBe('timeout');
    expect(abortKind('/api/requests/:id/photos', 'post', 30_000)).toBe('abort');
    expect(abortKind('/api/session', 'get', 4_900)).toBe('timeout');
    expect(abortKind('/api/requests/:id/messages', 'post', 9_800)).toBe('timeout');
  });

  it('responded: any mark within the response window', () => {
    expect(responded(1_000, [null, 500, 2_400])).toBe(false);
    expect(responded(1_000, [1_500])).toBe(true);
  });
});

describe('the DOM watcher (fake elements, idle processing)', () => {
  let events: TelEvent[];
  let core: DomCore;
  let f: ReturnType<typeof fakeBrowser>;

  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
    f = fakeBrowser();
    events = [];
    const guard = createGuard();
    core = {
      win: f.win,
      doc: f.doc as unknown as Document,
      guard,
      now: () => Date.now(),
      view: () => 'profile',
      sampled: () => true,
      emit: (e) => events.push(e),
      frustration: (e) => events.push({ ...e, tr: [] }),
      crumb: () => undefined,
      agg: (_k, make, update) => {
        const e = make();
        update(e);
        events.push(e);
      },
      marks: newMarks(),
      onTap: () => undefined,
      onField: () => undefined,
      onInvalid: () => undefined,
      idle: (fn) => setTimeout(fn, 0),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    expect(forbiddenReads).toEqual([]);
    forbiddenReads.length = 0;
  });

  const tap = (target: unknown, x = 10, y = 10, id = 1) => {
    f.doc.dispatchEvent(ev('pointerdown', { pointerId: id, clientX: x, clientY: y, pointerType: 'touch' }, target));
    f.doc.dispatchEvent(ev('pointerup', { pointerId: id, clientX: x, clientY: y, pointerType: 'touch' }, target));
  };
  const swipe = (target: unknown, dy: number) => {
    f.win.dispatchEvent(ev('touchstart', { touches: [{ clientX: 100, clientY: 300 }] }, target));
    f.win.dispatchEvent(ev('touchmove', { touches: [{ clientX: 100, clientY: 300 + dy }] }, target));
    f.win.dispatchEvent(ev('touchend', { touches: [] }, target));
  };

  it('a triple tap on a card: rage_tap (k 3); a dead tap on a card-looking div with no response', async () => {
    const watch = attachDom(core);
    const body = el('div', { 'data-testid': 'check-card' }, el('span', { class: 'XQsjZW_cardBody' }));
    const target = body.children[0];
    tap(target, 10, 10, 1);
    tap(target, 12, 11, 2);
    tap(target, 14, 12, 3);
    await vi.advanceTimersByTimeAsync(10);
    watch.process();
    expect(events.filter((e) => e.n === 'rage_tap')).toEqual([expect.objectContaining({ a: 'check-card', c: 'check-card', k: 3 })]);
    await vi.advanceTimersByTimeAsync(1_300);
    watch.process();
    expect(events.filter((e) => e.n === 'dead_tap').map((e) => e.p?.why)).toContain('not_interactive');
  });

  it('a button with no response in 1 s is dead; a mutation, a sheet or a view change is a response', async () => {
    const watch = attachDom(core);
    const btn = el('button', { 'data-testid': 'enroute-button' });
    tap(btn);
    await vi.advanceTimersByTimeAsync(1_300);
    watch.process();
    expect(events.filter((e) => e.n === 'dead_tap')).toEqual([expect.objectContaining({ c: 'enroute-button', p: expect.objectContaining({ why: 'no_response' }) })]);

    events.length = 0;
    tap(btn);
    FakeMutationObserver.fire([{ target: el('div', { 'data-testid': 'thread' }) }]);
    await vi.advanceTimersByTimeAsync(1_300);
    watch.process();
    expect(events.filter((e) => e.n === 'dead_tap')).toEqual([]);

    events.length = 0;
    tap(btn);
    FakeMutationObserver.fire([{ target: el('span', { 'data-testid': 'live-text' }) }]);
    await vi.advanceTimersByTimeAsync(1_300);
    watch.process();
    expect(events.filter((e) => e.n === 'dead_tap')).toHaveLength(1);

    events.length = 0;
    tap(btn);
    core.marks.view = Date.now() + 200;
    await vi.advanceTimersByTimeAsync(1_300);
    watch.process();
    expect(events.filter((e) => e.n === 'dead_tap')).toEqual([]);
  });

  it('a disabled control: dead_tap disabled at once', async () => {
    const watch = attachDom(core);
    const btn = el('button', { 'data-testid': 'composer-send' });
    btn.disabled = true;
    tap(btn);
    await vi.advanceTimersByTimeAsync(10);
    watch.process();
    expect(events.filter((e) => e.n === 'dead_tap')).toEqual([expect.objectContaining({ p: expect.objectContaining({ why: 'disabled' }) })]);
  });

  it('three still swipes in the thread: stuck_scroll with a = thread; toaster and grabber swipes never count', async () => {
    const watch = attachDom(core);
    const inThread = el('span');
    el('div', { 'data-testid': 'thread' }, inThread);
    for (let i = 0; i < 3; i += 1) {
      swipe(inThread, -80);
      await vi.advanceTimersByTimeAsync(500);
      watch.process();
    }
    expect(events.filter((e) => e.n === 'stuck_scroll')).toEqual([expect.objectContaining({ a: 'thread', k: 3, p: expect.objectContaining({ dir: 'up', input: 'touch' }) })]);
    const swipes = events.filter((e) => e.n === 'swipe');
    expect(swipes.every((e) => e.p?.still === 1)).toBe(true);

    events.length = 0;
    const toast = el('span');
    el('div', { class: 'lp-toaster' }, toast);
    const grab = el('div', { 'data-sheet-grab': '' });
    for (const t of [toast, toast, toast, grab, grab, grab]) {
      swipe(t, -80);
      await vi.advanceTimersByTimeAsync(500);
      watch.process();
    }
    expect(events).toEqual([]);
  });

  it('a swipe followed by a scroll in its container is not still', async () => {
    const watch = attachDom(core);
    const target = el('span');
    const list = el('div', { 'data-testid': 'request-list' }, target);
    swipe(target, -80);
    f.doc.dispatchEvent(ev('scroll', {}, list));
    await vi.advanceTimersByTimeAsync(500);
    watch.process();
    expect(events.filter((e) => e.n === 'swipe')[0]?.p?.still).toBeUndefined();
  });

  it('a sheet opened and closed quickly twice: sheet events with dwell and how, then a loop', async () => {
    const watch = attachDom(core);
    for (let i = 0; i < 2; i += 1) {
      const sheet = el('div', { role: 'dialog', 'data-testid': 'alerts-sheet' });
      const portal = el('div', {}, sheet);
      FakeMutationObserver.fire([{ target: f.body, addedNodes: [portal] }]);
      await vi.advanceTimersByTimeAsync(10);
      watch.process();
      f.doc.dispatchEvent(ev('keydown', { key: 'Escape' }, el('div')));
      await vi.advanceTimersByTimeAsync(400);
      f.doc.dispatchEvent(ev('keydown', { key: 'Escape' }, el('div')));
      FakeMutationObserver.fire([{ target: f.body, removedNodes: [portal] }]);
      await vi.advanceTimersByTimeAsync(10);
      watch.process();
    }
    const sheets = events.filter((e) => e.n === 'sheet');
    expect(sheets.map((e) => e.ok)).toEqual([true, false, true, false]);
    expect(sheets[1]).toEqual(expect.objectContaining({ a: 'alerts-sheet', p: { role: 'dialog', how: 'esc' } }));
    expect(events.filter((e) => e.n === 'loop')).toEqual([expect.objectContaining({ a: 'alerts-sheet', k: 2 })]);
  });

  it('an event keeps the view it happened in, even when processing comes after a view change', async () => {
    let current = 'profile';
    const watch = attachDom({ ...core, view: () => current as never });
    const btn = el('button', { 'data-testid': 'composer-send' });
    btn.disabled = true;
    f.doc.dispatchEvent(ev('pointerdown', { pointerId: 1, clientX: 1, clientY: 1, pointerType: 'touch' }, btn));
    f.doc.dispatchEvent(ev('pointerup', { pointerId: 1, clientX: 1, clientY: 1, pointerType: 'touch' }, btn));
    current = 'search';
    await vi.advanceTimersByTimeAsync(10);
    watch.process();
    expect(events.filter((e) => e.n === 'dead_tap').map((e) => e.v)).toEqual(['profile']);
    expect(events.filter((e) => e.n === 'tap').map((e) => e.v)).toEqual(['profile']);
  });

  it('keys outside text fields only, whitelisted', async () => {
    const watch = attachDom(core);
    f.doc.dispatchEvent(ev('keydown', { key: 'j' }, el('div')));
    f.doc.dispatchEvent(ev('keydown', { key: 'q' }, el('div')));
    f.doc.dispatchEvent(ev('keydown', { key: 'j' }, el('input')));
    f.doc.dispatchEvent(ev('keydown', { key: '/' }, el('div')));
    await vi.advanceTimersByTimeAsync(10);
    watch.process();
    expect(events.filter((e) => e.n === 'key').map((e) => e.c)).toEqual(['j', 'slash']);
  });
});
