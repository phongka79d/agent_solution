import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { AuthSession } from '@agentos/ui-foundation/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../auth/SessionProvider';

const mocks = vi.hoisted(() => ({
  getCompanyAttention: vi.fn(),
  getCompanyAiTeam: vi.fn(),
  getCompanyActivity: vi.fn(),
  getCompanyOverview: vi.fn(),
}));

vi.mock('../../lib/tenant-console-client', () => ({ tenantConsoleClient: mocks }));

import { CompanyOverview } from './CompanyOverview';

const session: AuthSession = {
  identity: { user_id: 'u-1', email: 'operator@example.test', display_name: 'Nguyễn An' },
  membership: { tenant_id: 'tenant-1', tenant_name: 'Cửa hàng Một', role: 'operator', scope: 'company' },
  permissions: ['telemetry:read', 'run:read'],
  expires_at: '2099-01-01T00:00:00.000Z',
};

describe('CompanyOverview', () => {
  beforeEach(() => {
    mocks.getCompanyAttention.mockResolvedValue({ items: [] });
    mocks.getCompanyAiTeam.mockResolvedValue({ agents: [] });
    mocks.getCompanyActivity.mockResolvedValue({ items: [], next_cursor: null });
    mocks.getCompanyOverview.mockResolvedValue({ attention: [], agents: [], activity: [] });
  });
  afterEach(() => cleanup());

  it('renders translated attention items from the company API', async () => {
    mocks.getCompanyAttention.mockResolvedValue({
      items: [{
        type: 'CONNECTOR_NOT_CONFIGURED',
        severity: 'warning',
        domain: 'platform',
        title_key: 'company.attention.connector_not_configured',
        params: { connector_id: 'CRM' },
        href: '/integrations',
        source_ref: 'connector-1',
      }],
    });
    render(<SessionProvider session={session}><CompanyOverview /></SessionProvider>);

    await waitFor(() => expect(screen.getByText('Kết nối CRM chưa được cấu hình.')).toBeTruthy());
  });

  it('shows an empty state when attention has no items', async () => {
    render(<SessionProvider session={session}><CompanyOverview /></SessionProvider>);

    await waitFor(() => expect(screen.getByText('Hiện chưa có việc cần xử lý.')).toBeTruthy());
  });
});
