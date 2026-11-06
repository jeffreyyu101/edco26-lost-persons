'use client';
import { useEffect } from 'react';

/** Sets <html data-hydrated="true"> once React has hydrated (tests wait for it). Renders nothing. */
export function HydrationMarker() {
  useEffect(() => {
    document.documentElement.dataset.hydrated = 'true';
  }, []);
  return null;
}
