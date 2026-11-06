'use client';
// The desk chunk: everything the shell draws from 768 px. app/app-shell.tsx loads it with next/dynamic
// only on the desk, so phones never download it and the first load of `/` stays within budget.
export { DeskNav, type DeskNavProps } from './Nav';
export { DeskTop, type DeskTopProps } from './TopBar';
export { DeskPane, closePane, openInPane, type DeskPaneProps } from './DetailPane';
export { DeskKeys, type DeskKeysProps } from './ShortcutManager';
