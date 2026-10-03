import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { AuthSession } from '@agentos/ui-foundation/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../auth/SessionProvider';

const mocks = vi.hoisted(() => ({
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

const RUN_ID = '11111111-2222-4333-8444-555555555555';

function overview(overrides: Record<string, unknown> = {}) {
  return {
    attention: [],
    ai_team: [
      { domain: 'sales', status: 'ACTIVE', reason_key: 'company.ai_team.reason.active', counter_key: 'runs_today', counter_value: 3, href: '/ai-team/sales' },
      { domain: 'care', status: 'NOT_READY', reason_key: 'company.ai_team.reason.not_ready', href: '/ai-team/care' },
      { domain: 'marketing', status: 'DISABLED', reason_key: 'company.ai_team.reason.disabled', href: '/ai-team/marketing' },
    ],
    today: {
      updated_at: '2026-10-01T03:00:00.000Z',
      metrics: [
        { key: 'conversations', count: 1, updated_at: '2026-10-01T03:00:00.000Z' },
        { key: 'campaigns_by_state', count: 2, updated_at: '2026-10-01T02:00:00.000Z', params: { state: 'AWAITING_APPROVAL' } },
      ],
    },
    activity: [{
      kind: 'RUN_COMPLETED',
      sentence_key: 'company.activity.run_completed',
      params: { run_id: RUN_ID },
      run_id: RUN_ID,
      domain: 'sales',
      occurred_at: '2026-10-01T02:30:00.000Z',
    }],
    sections: { attention: 'OK', ai_team: 'OK', today: 'OK', activity: 'OK', workspace: 'OK' },
    ...overrides,
  };
}

describe('CompanyOverview', () => {
  beforeEach(() => {
    mocks.getCompanyOverview.mockReset();
    mocks.getCompanyOverview.mockResolvedValue(overview());
  });
  afterEach(() => cleanup());

  it('greets the operator by name and shows the company name', async () => {
    render(<SessionProvider session={session}><CompanyOverview /></SessionProvider>);
    await waitFor(() => expect(screen.getByText('Xin chào, Nguyễn An')).toBeTruthy());
    expect(screen.getByText('Cửa hàng Một')).toBeTruthy();
  });

  it('shows the all-clear copy instead of a NO_DATA badge when nothing needs the operator', async () => {
    render(<SessionProvider session={session}><CompanyOverview /></SessionProvider>);
    await waitFor(() => expect(screen.getByText('Mọi thứ đang ổn')).toBeTruthy());
  });

  it('groups attention by type with a count and one CTA', async () => {
    mocks.getCompanyOverview.mockResolvedValue(overview({
      attention: [{
        type: 'HUMAN_HANDOFF',
        severity: 'danger',
        domain: 'care',
        count: 2,
        title_key: 'company.attention_group.human_handoff',
        params: { count: 2 },
        href: '/conversations/abc',
        cta_key: 'company.attention_cta.human_handoff',
      }],
    }));
    render(<SessionProvider session={session}><CompanyOverview /></SessionProvider>);
    await waitFor(() => expect(screen.getByText('2 hội thoại cần nhân viên')).toBeTruthy());
    expect(screen.getByText('Mở hội thoại')).toBeTruthy();
  });

  it('renders a scoped error with retry when one section fails', async () => {
    mocks.getCompanyOverview.mockResolvedValue(overview({
      sections: { attention: 'ERROR', ai_team: 'OK', today: 'OK', activity: 'OK', workspace: 'OK' },
    }));
    render(<SessionProvider session={session}><CompanyOverview /></SessionProvider>);
    await waitFor(() => expect(screen.getAllByText('Thử lại').length).toBeGreaterThan(0));
    expect(screen.queryByText('Mọi thứ đang ổn')).toBeNull();
  });

  it('uses localized campaign and tenant state labels', async () => {
    mocks.getCompanyOverview.mockResolvedValue(overview({
      today: {
        updated_at: '2026-10-01T03:00:00.000Z',
        metrics: [{ key: 'campaigns_by_state', count: 2, updated_at: '2026-10-01T02:00:00.000Z', params: { state: 'AWAITING_APPROVAL' } }],
      },
      workspace: { status: 'PROVISIONED', checklist: [] },
    }));
    render(<SessionProvider session={session}><CompanyOverview /></SessionProvider>);

    await waitFor(() => expect(screen.getByText('Chiến dịch · Chờ phê duyệt')).toBeTruthy());
    expect(screen.getByText('Trạng thái: Chưa cấu hình')).toBeTruthy();
    expect(document.body.textContent).not.toContain('awaiting approval');
    expect(document.body.textContent).not.toContain('provisioned');
  });

  it('never renders raw UUIDs or UPPER_SNAKE codes in visible copy', async () => {
    mocks.getCompanyOverview.mockResolvedValue(overview({
      workspace: {
        status: 'PROVISIONING',
        checklist: [
          { key: 'profile', label_key: 'overview.checklist.profile', done: true, href: '/settings' },
          { key: 'llm', label_key: 'overview.checklist.llm', done: false, href: '/integrations' },
        ],
      },
    }));
    render(<SessionProvider session={session}><CompanyOverview /></SessionProvider>);
    await waitFor(() => expect(screen.getByText('Hôm nay')).toBeTruthy());
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(text).not.toMatch(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/);
  });
});
