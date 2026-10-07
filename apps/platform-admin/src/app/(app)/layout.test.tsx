import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthSession } from '@agentos/ui-foundation/auth';

const mocks = vi.hoisted(() => ({ getServerSession: vi.fn(), redirect: vi.fn() }));
const { getServerSession, redirect } = mocks;

vi.mock('../../lib/auth/server-session', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
import AppLayout from './layout';

const platformSession: AuthSession = {
  identity: { user_id: 'platform-user', email: 'platform@example.test', display_name: 'Platform Admin' },
  membership: { tenant_id: 'tenant-1', tenant_name: null, role: 'admin', scope: 'platform' },
  permissions: ['platform:admin'],
  expires_at: '2030-01-01T00:00:00.000Z',
};

describe('platform app layout authentication', () => {
  beforeEach(() => {
    getServerSession.mockReset();
    redirect.mockReset();
  });

  it('redirects without rendering children when the server session is absent', async () => {
    getServerSession.mockResolvedValue(null);
    const children = <span>protected child</span>;
    const result = await AppLayout({ children });
    expect(redirect).toHaveBeenCalledWith('/sign-in?next=%2F');
    expect(result).toBeNull();
  });

  it('redirects company-scope sessions before rendering children', async () => {
    getServerSession.mockResolvedValue({
      ...platformSession,
      membership: { ...platformSession.membership, scope: 'company' },
    });
    const result = await AppLayout({ children: <span>protected child</span> });
    expect(redirect).toHaveBeenCalledWith('/sign-in?next=%2F');
    expect(result).toBeNull();
  });
});
