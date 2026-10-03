import { cleanup, render } from '@testing-library/react';
import type { AuthSession } from '@agentos/ui-foundation/auth';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionProvider } from '../auth/SessionProvider';
import { CompanyShell } from './CompanyShell';

vi.mock('next/navigation', () => ({ usePathname: () => '/' }));
vi.mock('../auth/SessionExpiryDialog', () => ({ SessionExpiryDialog: () => null }));
vi.mock('../../lib/tenant-console-client', () => ({
  tenantConsoleClient: { getCompanyAttention: vi.fn().mockResolvedValue({ items: [] }) },
}));

const tenantId = '99999999-9999-4999-8999-999999999999';

afterEach(cleanup);

describe('company workspace label', () => {
  it.each([
    { name: 'Cửa hàng Một', label: 'Cửa hàng Một' },
    { name: null, label: 'Công ty' },
    { name: '   ', label: 'Công ty' },
  ])('renders $label rather than a tenant ID when the name is $name', ({ name, label }) => {
    const session: AuthSession = {
      identity: { user_id: 'operator', email: 'operator@example.test', display_name: 'Nguyễn An' },
      membership: { tenant_id: tenantId, tenant_name: name, role: 'viewer', scope: 'company' },
      permissions: [],
      expires_at: '2099-01-01T00:00:00.000Z',
    };
    const { container } = render(<SessionProvider session={session}><CompanyShell><p>Nội dung</p></CompanyShell></SessionProvider>);
    expect(container.querySelector('.tenant-workspace__name')?.textContent).toBe(label);
    expect(container.querySelector('.tenant-breadcrumb li')?.textContent).toBe(label);
    expect(container.textContent).not.toContain(tenantId);
  });
});
