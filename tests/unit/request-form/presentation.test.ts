// The request form's presentation by viewport width (phone page / side sheet / modal) and its ⌘↵ / Ctrl+↵
// send shortcut. The dialogs themselves are covered by tests/e2e/new-request-desktop.spec.ts.
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import {
  FORM_MODAL_MIN_WIDTH,
  FORM_SHEET_MIN_WIDTH,
  isApplePlatform,
  isOverlay,
  isSendShortcut,
  presentationForWidth,
  sendShortcut,
  useFormPresentation,
} from '@/components/request-form/presentation';

const key = (patch: Partial<Parameters<typeof isSendShortcut>[0]>) => ({ key: 'Enter', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...patch });

describe('presentationForWidth', () => {
  it('follows the responsive contract: page under 768, sheet to 1023, modal from 1024', () => {
    expect(FORM_SHEET_MIN_WIDTH).toBe(768);
    expect(FORM_MODAL_MIN_WIDTH).toBe(1024);
    expect(presentationForWidth(390)).toBe('page');
    expect(presentationForWidth(767)).toBe('page');
    expect(presentationForWidth(768)).toBe('sheet');
    expect(presentationForWidth(820)).toBe('sheet');
    expect(presentationForWidth(1023)).toBe('sheet');
    expect(presentationForWidth(1024)).toBe('modal');
    expect(presentationForWidth(1180)).toBe('modal');
    expect(presentationForWidth(1440)).toBe('modal');
  });

  it('only the phone page is drawn without a dialog', () => {
    expect(isOverlay('page')).toBe(false);
    expect(isOverlay('sheet')).toBe(true);
    expect(isOverlay('modal')).toBe(true);
  });

  it('server renders (no window) get the phone page; a forced choice wins', () => {
    const Probe = ({ choice }: { choice?: 'auto' | 'modal' }) => useFormPresentation(choice);
    expect(renderToString(createElement(Probe))).toBe('page');
    expect(renderToString(createElement(Probe, { choice: 'modal' }))).toBe('modal');
  });
});

describe('send shortcut', () => {
  it('is ⌘↵ or Ctrl+↵, never a plain, Shift or Alt Enter, and never mid-composition', () => {
    expect(isSendShortcut(key({ metaKey: true }))).toBe(true);
    expect(isSendShortcut(key({ ctrlKey: true }))).toBe(true);
    expect(isSendShortcut(key({}))).toBe(false);
    expect(isSendShortcut(key({ metaKey: true, shiftKey: true }))).toBe(false);
    expect(isSendShortcut(key({ ctrlKey: true, altKey: true }))).toBe(false);
    expect(isSendShortcut(key({ metaKey: true, isComposing: true }))).toBe(false);
    expect(isSendShortcut(key({ key: 'n', metaKey: true }))).toBe(false);
  });

  it('shows ⌘↵ on Apple keyboards and Ctrl ↵ elsewhere, with a matching aria-keyshortcuts', () => {
    expect(isApplePlatform({ platform: 'MacIntel' })).toBe(true);
    expect(isApplePlatform({ platform: 'iPad', userAgent: '' })).toBe(true);
    expect(isApplePlatform({ platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })).toBe(false);
    expect(isApplePlatform(undefined)).toBe(false);
    expect(sendShortcut(true)).toEqual({ cap: '⌘↵', aria: 'Meta+Enter' });
    expect(sendShortcut(false)).toEqual({ cap: 'Ctrl ↵', aria: 'Control+Enter' });
  });
});
