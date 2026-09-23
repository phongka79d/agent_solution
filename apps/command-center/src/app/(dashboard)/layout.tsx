/**
 * @file apps/command-center/src/app/(dashboard)/layout.tsx
 * Layout wrapper for dashboard route group.
 * The responsive operational navigation shell is hoisted to RootLayout (app/layout.tsx).
 */
import type { ReactNode } from 'react';

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
