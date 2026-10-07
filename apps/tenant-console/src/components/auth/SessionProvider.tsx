'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { AuthSession } from '@agentos/ui-foundation/auth';

const SessionContext = createContext<AuthSession | null>(null);

export function SessionProvider({ session, children }: { readonly session: AuthSession; readonly children: ReactNode }) {
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

export function useSession(): AuthSession | null {
  return useContext(SessionContext);
}
