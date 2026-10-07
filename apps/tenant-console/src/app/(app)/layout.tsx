import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { safeNext } from '@agentos/ui-foundation/auth';
import { CompanyShell } from '../../components/shell/CompanyShell';
import { SessionProvider } from '../../components/auth/SessionProvider';
import { getServerSession } from '../../lib/auth/server-session';
import { TENANT_SESSION_COOKIE } from '../../lib/auth/session';

export const dynamic = 'force-dynamic';

function requestPath(): string {
  try {
    return headers().get('x-agentos-pathname') ?? '/';
  } catch {
    return '/';
  }
}

function hasSessionCookie(): boolean {
  try {
    return cookies().get(TENANT_SESSION_COOKIE) !== undefined;
  } catch {
    return false;
  }
}

export default async function AppLayout({ children }: { readonly children: ReactNode }) {
  const session = await getServerSession();
  if (!session) {
    const next = encodeURIComponent(safeNext(requestPath()));
    redirect(`/sign-in?${hasSessionCookie() ? 'reason=expired&' : ''}next=${next}`);
    return null;
  }

  return (
    <SessionProvider session={session}>
      <CompanyShell>{children}</CompanyShell>
    </SessionProvider>
  );
}
