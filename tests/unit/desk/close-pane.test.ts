// Closing the desk pane (components/desk/DetailPane.tsx closePane): one Back per close even when Esc and ×
// land before history.back() does, the closed request is the address bar's (J / K replace it before React
// renders), and a deep link closes to the main view instead of leaving the app. Synthetic only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closePane, takeClosedPane } from '@/components/desk/DetailPane';
import { ALL_VIEW, type MainView } from '@/components/desk/views';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

function stubWindow(search: string, lpDepth: number) {
  const calls: string[] = [];
  const location = { search, href: `http://127.0.0.1/${search}` };
  const history = {
    state: { lpDepth } as { lpDepth: number },
    back: () => calls.push('back'),
    replaceState: (_: unknown, __: string, href: string) => calls.push(`replace ${href}`),
    pushState: (_: unknown, __: string, href: string) => calls.push(`push ${href}`),
  };
  vi.stubGlobal('window', { location, history });
  return { calls, location };
}

afterEach(() => {
  takeClosedPane();
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
});
