import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AuthSession } from '@agentos/ui-foundation/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionProvider } from '../../auth/SessionProvider';

const mocks = vi.hoisted(() => ({ getCompanyAudit: vi.fn() }));
vi.mock('../../../lib/tenant-console-client', () => ({ tenantConsoleClient: mocks }));

import { applyCompanyAuditFilters, chainStatusOf, SettingsAuditTab } from './SettingsAuditTab';

const session: AuthSession = {
  identity: { user_id: 'u-1', email: 'operator@example.test', display_name: 'Nguyễn An' },
  membership: { tenant_id: 'tenant-1', tenant_name: 'Cửa hàng Một', role: 'admin', scope: 'company' },
  permissions: ['settings:manage'],
  expires_at: '2099-01-01T00:00:00.000Z',
};

const events = [
  {
    event_id: 'evt-1',
    chain_seq: '7',
    actor_kind: 'OPERATOR',
    actor_id: 'owner@example.test',
    scope: 'company',
    action: 'llm.update',
    tenant_id: 'tenant-1',
    target: 'tenant_llm_config',
    outcome: 'SUCCESS',
    reason: 'switch provider',
    before_state: { api_key: '••••' },
    after_state: { base_url: 'https://llm.example.test' },
    correlation_id: 'corr-1',
    created_at: '2026-09-30T10:00:00.000Z',
  },
  {
    event_id: 'evt-2',
    chain_seq: '6',
    actor_kind: 'SYSTEM',
    actor_id: 'system',
    scope: 'company',
    action: 'governance.update',
    tenant_id: 'tenant-1',
    target: null,
    outcome: 'FAILED',
    reason: null,
    before_state: null,
    after_state: null,
    correlation_id: 'corr-2',
    created_at: '2026-09-28T10:00:00.000Z',
  },
];

function renderTab(granted = true) {
  return render(
    <SessionProvider session={granted ? session : { ...session, permissions: [] }}>
      <SettingsAuditTab />
    </SessionProvider>,
  );
}

beforeEach(() => {
  mocks.getCompanyAudit.mockResolvedValue({ items: events, next_cursor: null });
});
afterEach(() => {
  cleanup();
  mocks.getCompanyAudit.mockReset();
});

describe('chainStatusOf', () => {
  it('reports the API verdict when present and stays unchecked otherwise', () => {
    expect(chainStatusOf({ items: [], chain_verified: false })).toBe('FAILED');
    expect(chainStatusOf({ items: [] })).toBe('UNCHECKED');
  });
});

describe('applyCompanyAuditFilters', () => {
  it('filters by outcome and inclusive date window', () => {
    expect(applyCompanyAuditFilters(events, { actor: '', action: '', outcome: 'FAILED', from: '', to: '' }).map((e) => e.event_id)).toEqual(['evt-2']);
    expect(applyCompanyAuditFilters(events, { actor: '', action: '', outcome: '', from: '2026-09-30', to: '2026-09-30' }).map((e) => e.event_id)).toEqual(['evt-1']);
  });
});

describe('SettingsAuditTab', () => {
  it('renders company audit rows from GET /company/audit', async () => {
    renderTab();

    expect(await screen.findByText('llm.update')).toBeTruthy();
    expect(screen.getByText('Chuỗi kiểm toán: Chưa kiểm tra')).toBeTruthy();
    expect(mocks.getCompanyAudit).toHaveBeenCalledWith({ limit: 50 });
  });

  it('opens the detail drawer with the redacted before/after values', async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('llm.update');

    await user.click(screen.getAllByRole('button', { name: 'Chi tiết' })[0]!);
    expect(await screen.findByText('Chi tiết sự kiện kiểm toán')).toBeTruthy();
    expect(screen.getByText(/"base_url": "https:\/\/llm.example.test"/)).toBeTruthy();
  });

  it('refuses without settings:manage and never calls the API', async () => {
    renderTab(false);

    await waitFor(() => expect(screen.getByText('Không có quyền truy cập')).toBeTruthy());
    expect(mocks.getCompanyAudit).not.toHaveBeenCalled();
  });
});
