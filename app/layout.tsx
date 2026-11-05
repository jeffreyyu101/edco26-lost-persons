import './styles.css';
import type { Metadata, Viewport } from 'next';
export const metadata: Metadata = { title: 'EDC Orlando 2026 | Lost Person Coordination', description: 'Staff coordination log' };
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' };
export default function RootLayout({ children }: Readonly<{children: React.ReactNode}>) { return <html lang="en"><body>{children}</body></html>; }
