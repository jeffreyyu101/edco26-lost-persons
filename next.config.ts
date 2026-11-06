import type { NextConfig } from 'next';

// Security headers for every response, including API routes, static files and /sw.js.
// The CSP (per-request nonce) and the auth redirects live in proxy.ts.
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Permissions-Policy', value: 'camera=(self), geolocation=(), microphone=()' },
  { key: 'X-Frame-Options', value: 'DENY' },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Pin the workspace root to this project (a stray lockfile in a parent folder must not be picked up).
  turbopack: { root: process.cwd() },
  reactStrictMode: true,
  // No next/image anywhere (spec §2): the optimizer would strip the session cookie.
  images: { unoptimized: true },
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      {
        // The service worker must always be revalidated so updates are noticed.
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
      {
        source: '/manifest.webmanifest',
        headers: [{ key: 'Content-Type', value: 'application/manifest+json' }],
      },
    ];
  },
};

export default nextConfig;
