'use client';
// true inside the desk shell (from 768 px), where the shell supplies the title, search, views, bell,
// account and New request. A view that reads it can skip its own phone chrome (large title, view
// switcher, floating New request button); until the list and dashboard views read it, the desk
// stylesheet (components/desk/frame.module.css, "Phone chrome inside the main column") hides that chrome.
import { createContext, useContext } from 'react';

export const DeskContext = createContext(false);

export function useInDesk(): boolean {
  return useContext(DeskContext);
}
