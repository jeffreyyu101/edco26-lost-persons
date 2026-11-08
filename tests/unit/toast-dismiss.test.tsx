// The toasts at the top close on a visible ✕ (Brian 2026-11-07: "the notifications that show on the top should be
// dismissable w an x too ... if you open the phone n have pending notifications"), as well as on a tap anywhere.
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Toast, Toaster } from '@/components/ui/Toast';
import type { ToastItem } from '@/lib/client/store-contract';

const sticky: ToastItem = { id: 't1', tone: 'green', icon: 'check', title: 'LP-1004 · Sofia Lopez located', subtitle: 'Friend can head over', durationMs: null };

describe('toast ✕', () => {
  it('every toast has a visible Dismiss button with the x icon (not the screen-reader-only one)', () => {
    const html = renderToString(<Toaster toasts={[sticky, { ...sticky, id: 't2', title: 'Update ready', action: { label: 'Reload', run: () => undefined } }]} onDismiss={() => undefined} />);
    const buttons = [...html.matchAll(/<button[^>]*aria-label="Dismiss"[^>]*>([\s\S]*?)<\/button>/g)];
    expect(buttons).toHaveLength(2);
    for (const [tag, inner] of buttons) {
      expect(tag).toMatch(/class="[^"]*lp-toast-x lp-hit/);
      expect(tag).not.toMatch(/visuallyHidden/);
      expect(inner).toMatch(/<svg/);
    }
  });

  it('the ✕ calls onDismiss', () => {
    let dismissed = 0;
    const el = Toast({ toast: sticky, onDismiss: () => (dismissed += 1) });
    const kids = (el.props as { children: unknown[] }).children.flat() as { type?: unknown; props?: { 'aria-label'?: string; onClick?: () => void } }[];
    const close = kids.find((k) => k && k.type === 'button' && k.props?.['aria-label'] === 'Dismiss');
    expect(close).toBeTruthy();
    close!.props!.onClick!();
    expect(dismissed).toBe(1);
  });
});
