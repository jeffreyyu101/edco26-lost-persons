import '@fontsource-variable/inter';
import '@radix-ui/themes/styles.css';
import './globals.css';
import { Theme } from '@radix-ui/themes';
import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { BRAND_HIDDEN_SCRIPT } from '@/lib/brand-pref';
import { THEME_SCRIPT } from '@/lib/theme';
import { HydrationMarker } from './hydration-marker';

export const metadata: Metadata = {
  title: 'Is my friend in medical?',
  description: 'EDC Orlando 2026 · Ground Control / Headliner Experience',
  applicationName: 'Is my friend in medical?',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'In medical?', statusBarStyle: 'default' },
  icons: {
    icon: [
      { url: '/icons/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  robots: { index: false, follow: false },
  formatDetection: { telephone: false, email: false, address: false },
  referrer: 'no-referrer',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#111113' },
  ],
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  // The proxy puts a per-request nonce in the CSP and in x-nonce; Next.js applies it to its own scripts.
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Applies the saved Light / Dark / Auto theme, and a brand row hidden on this device, before first
            paint (no flash). */}
        <script nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: THEME_SCRIPT + BRAND_HIDDEN_SCRIPT }} />
      </head>
      <body>
        <Theme accentColor="gray" grayColor="gray" radius="medium">
          {children}
        </Theme>
        <HydrationMarker />
      </body>
    </html>
  );
}
