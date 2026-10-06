import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ServiceWorkerRegistrar } from '@/components/ServiceWorkerRegistrar';
import { SkipLink } from '@/components/SkipLink';

export const metadata: Metadata = {
  title: 'Qwixx Score Sheet',
  description: 'A multiplayer, local-first score sheet for the dice game Qwixx.',
  manifest: '/manifest.webmanifest',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0f172a',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans antialiased">
        <SkipLink />
        <ServiceWorkerRegistrar />
        {children}
      </body>
    </html>
  );
}
