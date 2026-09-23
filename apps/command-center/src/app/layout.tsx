import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'AgentOS Command Center',
  description: 'Operator console for the AgentOS autonomous agent platform.',
};

const NAV_ITEMS = [
  { href: '/', label: 'Executive', id: 'nav-executive' },
  { href: '/analytics?tab=operations', label: 'Operations', id: 'nav-operations' },
  { href: '/approvals?tab=approvals', label: 'Approvals', id: 'nav-approvals' },
  { href: '/approvals?tab=customer', label: 'Customer 360', id: 'nav-customer360' },
  { href: '/takeover', label: 'Conversation Console', id: 'nav-conversation' },
] as const;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark bg-slate-950 text-slate-100">
      <body className="min-h-screen flex flex-col bg-slate-950 font-sans antialiased selection:bg-sky-500 selection:text-white">
        <header
          role="banner"
          className="sticky top-0 z-40 w-full border-b border-slate-800 bg-slate-950/90 backdrop-blur supports-[backdrop-filter]:bg-slate-950/75"
        >
          <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
            <div className="flex items-center gap-6">
              <Link
                href="/"
                className="flex items-center gap-2 font-mono text-sm font-semibold tracking-wider text-slate-100 hover:text-sky-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 rounded"
                aria-label="AgentOS Command Center Home"
              >
                <span className="inline-block h-2.5 w-2.5 rounded-full bg-sky-500" aria-hidden="true" />
                <span className="uppercase">AgentOS</span>
                <span className="text-xs text-slate-500">CC</span>
              </Link>

              <nav
                role="navigation"
                aria-label="Main Navigation"
                className="hidden md:flex items-center gap-1"
              >
                {NAV_ITEMS.map((item) => (
                  <Link
                    key={item.id}
                    href={item.href}
                    className="px-3 py-1.5 text-xs font-medium rounded-md text-slate-300 hover:text-slate-100 hover:bg-slate-900 border border-transparent hover:border-slate-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                  >
                    {item.label}
                  </Link>
                ))}
              </nav>
            </div>

            <div className="flex items-center gap-3">
              <div
                role="status"
                aria-label="System operational status"
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-mono font-medium bg-slate-900 border border-slate-800 text-slate-300"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" aria-hidden="true" />
                <span>OPERATIONAL</span>
              </div>
            </div>
          </div>

          {/* Responsive sub-bar for smaller screens */}
          <nav
            role="navigation"
            aria-label="Mobile Navigation"
            className="flex md:hidden overflow-x-auto border-t border-slate-800/80 px-4 py-2 gap-2 scrollbar-none"
          >
            {NAV_ITEMS.map((item) => (
              <Link
                key={`mobile-${item.id}`}
                href={item.href}
                className="whitespace-nowrap px-2.5 py-1 text-xs font-medium rounded text-slate-300 hover:text-slate-100 hover:bg-slate-900 border border-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </header>

        <div className="flex-1 flex flex-col">{children}</div>

        <footer
          role="contentinfo"
          className="border-t border-slate-800/80 bg-slate-950 py-3 text-center text-[11px] font-mono text-slate-600"
        >
          <div className="mx-auto max-w-7xl px-4 flex flex-col sm:flex-row items-center justify-between gap-2">
            <span>AgentOS Command Center &bull; Fail-Closed Contract Verification</span>
            <span>API Gateway /api/v1</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
