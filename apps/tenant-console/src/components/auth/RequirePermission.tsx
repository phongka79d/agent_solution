'use client';

import type { ReactNode } from 'react';
import { can, canAny, type Permission } from '@agentos/ui-foundation/auth';
import { useSession } from './SessionProvider';

export function RequirePermission({
  permission,
  permissions,
  children,
}: {
  readonly permission?: Permission;
  readonly permissions?: readonly Permission[];
  readonly children: ReactNode;
}) {
  const session = useSession();
  const allowed = permission !== undefined
    ? can(session, permission)
    : permissions !== undefined && canAny(session, permissions);
  if (!allowed) return <p role="alert">Không có quyền truy cập</p>;
  return <>{children}</>;
}
