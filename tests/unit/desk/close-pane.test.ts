// Closing the desk pane (components/desk/DetailPane.tsx closePane): one Back per close even when Esc and ×
// land before history.back() does, the closed request is the address bar's (J / K replace it before React
// renders), a deep link closes to the main view instead of leaving the app, and one close goes back past
// requests opened over requests (a dashboard row pushes each one). Synthetic only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closePane, forgetHistoryEntries, noteHistoryEntry, takeClosedPane } from '@/components/desk/DetailPane';
import { ALL_VIEW, type MainView } from '@/components/desk/views';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

/** Each stub's addresses are its own (a close is once per address, and the module outlives a test). */
let stubs = 0;

function stubWindow(search: string, lpDepth: number) {
  const calls: string[] = [];
  const tag = `#s${(stubs += 1)}`;
  const location = { search, href: `http://127.0.0.1/${search}${tag}` };
  const history = {
    state: { lpDepth } as { lpDepth: number },
    back: () => calls.push('back'),
    go: (n: number) => calls.push(`go ${n}`),
    replaceState: (_: unknown, __: string, href: string) => calls.push(`replace ${href}`),
    pushState: (_: unknown, __: string, href: string) => calls.push(`push ${href}`),
  };
  vi.stubGlobal('window', { location, history });
  return { calls, location, history, tag };
}

/** Visit `search` at `lpDepth` as the desk sees it (DeskKeys notes each address). */
function visit(stub: ReturnType<typeof stubWindow>, search: string, lpDepth: number) {
  stub.location.search = search;
  stub.location.href = `http://127.0.0.1/${search}${stub.tag}`;
  stub.history.state = { lpDepth };
  noteHistoryEntry();
}

afterEach(() => {
  takeClosedPane();
  forgetHistoryEntries();
  vi.unstubAllGlobals();
});

describe('closePane', () => {
  it('goes back once per address, however many times it is asked before Back lands', () => {
    const { calls, location } = stubWindow(`?q=kay&r=${B}`, 2);
    closePane({ name: 'search', q: 'kay' });
    closePane({ name: 'search', q: 'kay' });
    expect(calls).toEqual(['back']);
    expect(takeClosedPane()).toBe(B);
    expect(takeClosedPane()).toBeNull();

    // Back landed, another request was opened: closing works again.
    location.search = `?q=kay&r=${A}`;
    location.href = `http://127.0.0.1/${location.search}`;
    closePane({ name: 'search', q: 'kay' });
    expect(calls).toEqual(['back', 'back']);
    expect(takeClosedPane()).toBe(A);
  });

  it('on a deep link replaces the entry with the main view instead of leaving the app', () => {
    const { calls } = stubWindow(`?r=${A}&x=1`, 0);
    const pending: MainView = { name: 'pending' };
    closePane(pending);
    expect(calls).toEqual(['replace /?view=pending']);
    stubWindow(`?r=${A}&x=2`, 0);
    closePane(ALL_VIEW);
    expect(takeClosedPane()).toBe(A);
  });

  it('closes in one go from a request opened over another (A, then a dashboard row pushes B)', () => {
    const stub = stubWindow('?dashboard=1', 0);
    visit(stub, '?dashboard=1', 0);
    visit(stub, `?r=${A}`, 1);
    visit(stub, `?r=${B}`, 2);
    closePane({ name: 'dashboard' });
    expect(stub.calls).toEqual(['go -2']);
    expect(takeClosedPane()).toBe(B);
  });

  it('steps back past the forms between (A, New request, the duplicate link to B) to the list', () => {
    const stub = stubWindow('?view=pending', 3);
    visit(stub, '?q=x', 3);
    visit(stub, '?view=pending', 4);
    visit(stub, `?r=${A}`, 5);
    visit(stub, '?new=1', 6);
    visit(stub, `?r=${B}`, 7);
    closePane({ name: 'pending' });
    expect(stub.calls).toEqual(['go -3']);
  });

  it('with the list one entry down is a plain Back', () => {
    const stub = stubWindow('?view=mine', 0);
    visit(stub, '?view=mine', 0);
    visit(stub, `?r=${A}`, 1);
    closePane({ name: 'mine' });
    expect(stub.calls).toEqual(['go -1']);
  });

  it('an entry noted again counts as what it shows now (Back, then another request pushed there)', () => {
    const stub = stubWindow('', 0);
    visit(stub, '', 0);
    visit(stub, '?q=kay', 1);
    // Back to All, then a request opened from it: entry 1 is the request now.
    visit(stub, '', 0);
    visit(stub, `?r=${A}`, 1);
    visit(stub, `?r=${B}`, 2);
    closePane(ALL_VIEW);
    expect(stub.calls).toEqual(['go -2']);
  });

  it('requests all the way down to a deep link close to the main view in place', () => {
    const stub = stubWindow(`?r=${A}`, 0);
    visit(stub, `?r=${A}`, 0);
    visit(stub, '?new=1', 1);
    visit(stub, `?r=${B}`, 2);
    closePane(ALL_VIEW);
    expect(stub.calls).toEqual(['replace /']);
    expect(takeClosedPane()).toBe(B);
  });

  it('an entry the desk never saw (before a reload) ends the walk: one Back', () => {
    const stub = stubWindow('', 0);
    visit(stub, '', 0);
    visit(stub, `?r=${B}`, 2);
    closePane(ALL_VIEW);
    expect(stub.calls).toEqual(['back']);
  });

  it('forgets what it saw when the desk goes away', () => {
    const stub = stubWindow('', 0);
    visit(stub, '', 0);
    visit(stub, `?r=${A}`, 1);
    visit(stub, `?r=${B}`, 2);
    forgetHistoryEntries();
    closePane(ALL_VIEW);
    expect(stub.calls).toEqual(['back']);
  });
});
