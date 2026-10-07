import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { can, safeNext } from '@agentos/ui-foundation/auth';
import { PlatformShell } from '../../components/shell/PlatformShell';
import { SessionProvider } from '../../components/auth/SessionProvider';
import { getServerSession } from '../../lib/auth/server-session';
import { PLATFORM_SESSION_COOKIE } from '../../lib/auth/session';

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
    return cookies().get(PLATFORM_SESSION_COOKIE) !== undefined;
  } catch {
    return false;
  }
}

export default async function AppLayout({ children }: { readonly children: ReactNode }) {
  const session = await getServerSession();
  if (!session || session.membership.scope !== 'platform' || !can(session, 'platform:admin')) {
    const next = encodeURIComponent(safeNext(requestPath()));
    const expired = session === null && hasSessionCookie();
    redirect(`/sign-in?${expired ? 'reason=expired&' : ''}next=${next}`);
    return null;
  }

  return (
    <SessionProvider session={session}>
      <PlatformShell>{children}</PlatformShell>
    </SessionProvider>
  );
}
