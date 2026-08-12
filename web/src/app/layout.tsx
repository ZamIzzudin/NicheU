import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Niche Daily',
  description: 'Partner AI WhatsApp agent dashboard',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <body className="bg-cream text-ink">{children}</body>
    </html>
  );
}
