import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
 

export const metadata: Metadata = {
  title: 'AgentOS Company Workspace',
  description: 'Tenant-scoped customer care, approvals, and observed operations.',
};

// The middleware sends a per-request CSP nonce; Next stamps it on its scripts only when a page is
// rendered per request. A prerendered page would ship nonce-less scripts the policy blocks.
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi" data-app="tenant">
      <body className="min-h-screen bg-canvas font-sans antialiased text-ink selection:bg-brand selection:text-white">
        {children}
      </body>
    </html>
  );
}
