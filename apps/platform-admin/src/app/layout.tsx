import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'AgentOS Platform Operations',
  description: 'Current-tenant operations, readiness, and bounded autonomy controls.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi" data-app="platform">
      <body className="min-h-screen bg-canvas font-sans antialiased text-ink selection:bg-brand selection:text-white">
        {children}
      </body>
    </html>
  );
}
