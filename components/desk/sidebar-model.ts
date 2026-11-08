// The desk sidebar's open / collapsed model (pure; in the desk chunk; unit-tested in tests/unit/desk/sidebar.test.ts).
// shadcn/ui's Sidebar with collapsible="icon", variant "inset" (design/screens/desktop-sidebar-inset.html): 256 px
// with labels, or 64 px of icons. One component from 768 px (it replaced the 232 px sidebar and the 60 px rail).
//
//   * Docked: the sidebar takes its column and the main card narrows beside it. From 1280 px, and at 1024–1279
//     while no request is open. Without a choice on this device it starts expanded from 1280, collapsed below.
//     The toggle flips it and the choice is kept (lib/desk-sidebar-pref.ts).
//   * Overlay: where the list and an open request would not fit beside 256 px (under 1024, and at 1024–1279 with a
//     request open) the column stays 64 px and the toggle opens the sidebar over the content, with a scrim (Esc, a
//     click on the scrim or choosing a view closes it). Never kept, never open on load.
import type { DeskLayout } from './breakpoints';
import type { SidebarPref } from '@/lib/desk-sidebar-pref';

/** The sidebar element's id: the top bar's toggle controls it (aria-controls). */
export const SIDEBAR_ID = 'desk-sidebar';

/** Expanded and collapsed (icon) widths, CSS px; frame.module.css draws them. */
export const SIDEBAR_WIDTH = 256;
export const SIDEBAR_ICON_WIDTH = 64;

export type SidebarMode = 'docked' | 'overlay';

/** What the toggle reads: the choice kept on this device and whether it is open over the content now. */
export interface SidebarState {
  pref: SidebarPref | null;
  overlay: boolean;
}

/** Where an expanded sidebar goes at this layout, with or without a request open beside the list. */
export function sidebarMode(layout: DeskLayout, paneOpen: boolean): SidebarMode {
  if (layout === 'desktop') return 'docked';
  if (layout === 'laptop' && !paneOpen) return 'docked';
  return 'overlay';
}

/** Expanded with nothing chosen: from 1280 px (the old sidebar's width); collapsed on an iPad or small laptop. */
export function expandedByDefault(layout: DeskLayout): boolean {
  return layout === 'desktop';
}

/** Whether the sidebar shows its labels (docked or over the content). */
export function sidebarExpanded(state: SidebarState, layout: DeskLayout, paneOpen: boolean): boolean {
  if (sidebarMode(layout, paneOpen) === 'overlay') return state.overlay;
  return state.pref ? state.pref === 'expanded' : expandedByDefault(layout);
}

/** After the toggle: docked, it flips and the choice is kept; over the content, it opens or closes there only. */
export function toggled(state: SidebarState, layout: DeskLayout, paneOpen: boolean): SidebarState {
  if (sidebarMode(layout, paneOpen) === 'overlay') return { pref: state.pref, overlay: !state.overlay };
  return { pref: sidebarExpanded(state, layout, paneOpen) ? 'collapsed' : 'expanded', overlay: false };
}
