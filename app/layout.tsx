import './styles.css';
import type { Metadata, Viewport } from 'next';
export const metadata: Metadata = { title: 'Is My Friend in Medical? | EDC Orlando 2026', description: 'EDC Orlando medical transportation coordination log' };
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' };
export default function RootLayout({ children }: Readonly<{children: React.ReactNode}>) { return <html lang="en"><body>{children}</body></html>; }
