import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  redirect: vi.fn(),
  headers: vi.fn(),
  cookies: vi.fn(),
}));

vi.mock('../../lib/auth/server-session', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('next/headers', () => ({ headers: mocks.headers, cookies: mocks.cookies }));

import AppLayout from './layout';

describe('tenant app layout', () => {
  it('redirects before rendering children when the server session is absent', async () => {
    mocks.getServerSession.mockResolvedValue(null);
    mocks.headers.mockReturnValue(new Headers([['x-agentos-pathname', '/approvals?x=1']]));
    mocks.cookies.mockReturnValue({ get: vi.fn(() => undefined) });

    const result = await AppLayout({ children: 'child' });

    expect(mocks.redirect).toHaveBeenCalledWith('/sign-in?next=%2Fapprovals%3Fx%3D1');
    expect(result).toBeNull();
  });
});
