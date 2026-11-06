'use client';
import { useState } from 'react';
import type { View } from '@/lib/client/nav';
import { ALL_VIEW, nextMainView, type MainView } from './views';

/**
 * The list or dashboard the desk keeps in its main column: the current view when it is one, else the
 * last one shown (All for a deep link to a request or a form). In memory only, like the phone's scroll
 * memory: a reload of /?r=… shows All behind the request.
 */
export function useMainView(view: View): MainView {
  const [main, setMain] = useState<MainView>(() => nextMainView(view, ALL_VIEW));
  const next = nextMainView(view, main);
  if (next !== main) setMain(next);
  return next;
}
