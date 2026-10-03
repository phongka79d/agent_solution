import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AuthSession } from '@agentos/ui-foundation/auth';
import { t } from '@agentos/ui-foundation/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionProvider } from '../../auth/SessionProvider';

const mocks = vi.hoisted(() => ({ getCompanyAudit: vi.fn() }));

vi.mock('../../../lib/tenant-console-client', () => ({ tenantConsoleClient: mocks }));

import { HistoryDrawer } from './HistoryDrawer';

const session: AuthSession = {
  identity: { user_id: 'user-1', email: 'user@example.test', display_name: 'Nguyễn An' },
  membership: { tenant_id: 'tenant-1', tenant_name: 'Cửa hàng Một', role: 'admin', scope: 'company' },
  permissions: ['settings:manage'],
  expires_at: '2099-01-01T00:00:00.000Z',
};

function renderDrawer(permissions: AuthSession['permissions'] = session.permissions) {
  return render(<SessionProvider session={{ ...session, permissions }}><HistoryDrawer scope="company.profile" /></SessionProvider>);
}

beforeEach(() => {
  mocks.getCompanyAudit.mockResolvedValue({ items: [{
    event_id: 'event-1',
    chain_seq: '1',
    actor_kind: 'OPERATOR',
    actor_id: 'operator-1',
    scope: 'company.profile',
    action: 'UPDATE',
    tenant_id: 'tenant-1',
    target: 'company.profile',
    outcome: 'SUCCESS',
    reason: 'Owner settings update',
    before_state: { company_name: 'Old company name' },
    after_state: { company_name: 'New company name' },
    correlation_id: 'correlation-1',
    created_at: '2026-10-01T12:00:00.000Z',
  }] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('HistoryDrawer', () => {
  it('loads only on open and requests the matching settings scope', async () => {
    const user = userEvent.setup();
    renderDrawer();

    expect(mocks.getCompanyAudit).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: t('settings.action.history') }));
    await waitFor(() => expect(mocks.getCompanyAudit).toHaveBeenCalledWith({ limit: 25, scope: 'company.profile' }));
    expect(await screen.findByText('UPDATE')).toBeTruthy();
    expect(screen.getByText('operator-1 (OPERATOR)')).toBeTruthy();
    expect(screen.getByText(/Old company name/)).toBeTruthy();
    expect(screen.getByText(/New company name/)).toBeTruthy();
    expect(screen.getByText('Owner settings update')).toBeTruthy();
  });

  it('does not expose the history drawer without settings permission', () => {
    renderDrawer([]);
    expect(screen.queryByRole('button', { name: t('settings.action.history') })).toBeNull();
    expect(mocks.getCompanyAudit).not.toHaveBeenCalled();
  });
});
