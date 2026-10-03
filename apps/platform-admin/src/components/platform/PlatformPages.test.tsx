import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthSession } from '@agentos/ui-foundation/auth';
import { SessionProvider } from '../auth/SessionProvider';
import { CompaniesPage, CompanyDetail, CompanyUsersTab } from './Companies';
import { PlatformOverview } from './PlatformOverview';
import { SettingsPage, SubscriptionsPage, UsagePage, summarizeUsageByCurrency } from './PlatformPages';
import type { PlatformUsage } from '../../lib/platform-client';

function usageRow(over: Partial<PlatformUsage>): PlatformUsage {
  return {
    tenant_id: 'tenant-1',
    display_name: 'Acme',
    usage_day: '2026-09-30',
    domain: 'sales',
    model: 'gpt-fast',
    currency: 'USD',
    cost_recorded: true,
    record_count: 1,
    input_tokens_total: 0,
    output_tokens_total: 0,
    cached_tokens_total: 0,
    tokens_total: 100,
    cost_total: '10.00',
    monthly_token_budget: null,
    ...over,
  };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const session: AuthSession = {
  identity: { user_id: 'platform-user', email: 'platform@example.test', display_name: 'Platform Admin' },
  membership: { tenant_id: 'tenant-1', tenant_name: null, role: 'admin', scope: 'platform' },
  permissions: ['platform:admin'],
  expires_at: '2030-01-01T00:00:00.000Z',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function company(tenantId: string, name: string, status: string) {
  return { tenant_id: tenantId, display_name: name, status, created_at: '2026-09-23T00:00:00.000Z', enabled_modules: null };
}

const companyWriterSession: AuthSession = {
  ...session,
  permissions: ['platform:admin', 'platform:companies:write', 'platform:audit:read'],
};

function companyDetailFetch() {
  let companyStatus = 'ACTIVE';
  let autonomyPaused = false;
  const users = [
    {
      user_id: 'invitation-1',
      email: 'pending@example.test',
      display_name: null,
      role_bundle: 'OPERATOR',
      status: 'INVITED',
      last_sign_in_at: null,
    },
    {
      user_id: 'member-1',
      email: 'member@example.test',
      display_name: 'Active Member',
      role_bundle: 'OPERATOR',
      status: 'ACTIVE',
      last_sign_in_at: '2026-09-30T10:05:00.000Z',
    },
  ];
  const autonomy = {
    tenant_id: 'tenant-1',
    paused: false,
    current: [{
      policy_id: 'policy-1',
      policy_version: '1',
      skill_id: 'skill.sales.propose',
      state: 'ACTIVE',
      reason: 'Approved evidence',
      evidence_window_ref: 'evidence-window-1',
      effective_at: '2026-09-30T00:00:00.000Z',
    }],
    history: [],
  };
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === '/api/v1/platform/tenants/tenant-1') {
      return json({ tenant_id: 'tenant-1', display_name: 'Acme', status: companyStatus, created_at: '2026-09-23T00:00:00.000Z' });
    }
    if (url === '/api/v1/platform/companies/tenant-1/overview') {
      return json({ tenant_id: 'tenant-1', display_name: 'Acme', status: companyStatus, data_class: 'PRODUCTION', created_at: '2026-09-23T00:00:00.000Z', runs_total: 4, runs_failed: 1, runs_running: 0, runs_waiting: 0, retry_eligible_count: 0, reconciliation_count: 0, needs_attention: true, last_activity_at: '2026-09-24T00:00:00.000Z' });
    }
    if (url === '/api/v1/platform/tenants/tenant-1/readiness') {
      return json({ tenant_id: 'tenant-1', capability_statuses: {}, connector_statuses: {}, owner_input_statuses: {} });
    }
    if (url === '/api/v1/platform/companies/tenant-1/autonomy') {
      return json({ ...autonomy, paused: autonomyPaused });
    }
    if (url === '/api/v1/platform/companies/tenant-1/users') return json({ items: users });
    if (url.startsWith('/api/v1/platform/usage?')) return json({ items: [] });
    if (url.startsWith('/api/v1/platform/runs?')) return json({ items: [] });
    if (url.startsWith('/api/v1/platform/audit?')) return json({ items: [] });
    if (method === 'POST' && url === '/api/v1/platform/companies/tenant-1/suspend') {
      companyStatus = 'SUSPENDED';
      return json({ tenant_id: 'tenant-1', status: companyStatus });
    }
    if (method === 'POST' && url === '/api/v1/platform/companies/tenant-1/autonomy/pause') {
      autonomyPaused = true;
      return json({ ...autonomy, paused: autonomyPaused });
    }
    if (method === 'POST' && url === '/api/v1/platform/companies/tenant-1/invitations') {
      return json({ invitation_id: 'invitation-2' }, 201);
    }
    if (method === 'POST' && url === '/api/v1/platform/companies/tenant-1/users/member-1/deactivate') {
      users[1] = { ...users[1]!, status: 'DEACTIVATED' };
      return json({ user_id: 'member-1', status: 'DEACTIVATED' });
    }
    return json({}, 404);
  });
}

describe('platform overview', () => {
  it('renders the "Cần chú ý" queue and KPI cards without a fake live badge', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/v1/platform/companies')) {
        return json({ items: [company('tenant-1', 'Acme', 'PROVISIONED')] });
      }
      if (url === '/api/v1/platform/runs/summary') {
        return json({ items: [{ state: 'FAILED', run_count: 2, tenant_count: 1, retry_eligible_count: 1, reconciliation_count: 1 }] });
      }
      if (url.startsWith('/api/v1/platform/runs/reconciliation')) {
        return json({ items: [{ tenant_id: 'tenant-1', display_name: 'Acme', run_id: 'run-1', domain: 'sales', state: 'UNKNOWN', failure_class: 'DISPATCH_TIMEOUT', attempts: 1, max_retries: 2, reason: 'unknown effect', correlation_id: 'c-1', updated_at: '2026-09-24T00:00:00.000Z' }] });
      }
      if (url.startsWith('/api/v1/platform/runs?')) {
        return json({ items: [{ tenant_id: 'tenant-1', display_name: 'Acme', run_id: 'run-1', domain: 'sales', current_step: 2, state: 'FAILED', failure_class: 'LLM_TIMEOUT', retry_eligible: true, attempts: 1, max_retries: 2, duration_ms: 100, created_at: '2026-09-24T00:00:00.000Z', updated_at: '2026-09-24T00:00:00.000Z', correlation_id: 'c-1' }] });
      }
      if (url === '/api/v1/platform/providers') {
        return json({ providers: [{ provider_id: 'openai', display_name: 'OpenAI', base_url: 'https://api.openai.com', reasoning_model: 'gpt', fast_model: 'mini', timeout_ms: 1000, structured_mode: 'json_object', status: 'FAILED', is_default: true, secret_configured: false, config_version: '1', updated_at: '2026-09-24T00:00:00.000Z' }] });
      }
      if (url.startsWith('/api/v1/platform/usage?')) {
        return json({ items: [{ tenant_id: 'tenant-1', display_name: 'Acme', usage_day: '2026-09-24', domain: 'sales', model: 'gpt', currency: 'VND', cost_recorded: true, record_count: 1, input_tokens_total: 10, output_tokens_total: 5, cached_tokens_total: 0, tokens_total: 15, cost_total: '123.5', monthly_token_budget: null }] });
      }
      return json({}, 404);
    }));

    render(<PlatformOverview />);

    expect(screen.getByRole('heading', { name: 'Cần chú ý' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Công ty theo trạng thái', level: 2 })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Tỷ lệ lỗi' })).toBeTruthy();
    expect(screen.queryByText('Dữ liệu trực tiếp')).toBeNull();
    await waitFor(() => expect(screen.getByText(/LLM_TIMEOUT/)).toBeTruthy());
    expect(screen.getByText(/123.5 VND/)).toBeTruthy();
  });

  it('keeps the companies KPI available when the usage request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/v1/platform/companies')) return json({ items: [company('tenant-1', 'Acme', 'ACTIVE')] });
      if (url === '/api/v1/platform/runs/summary') return json({ items: [] });
      if (url.startsWith('/api/v1/platform/runs/reconciliation')) return json({ items: [] });
      if (url.startsWith('/api/v1/platform/runs?')) return json({ items: [] });
      if (url === '/api/v1/platform/providers') return json({ providers: [] });
      if (url.startsWith('/api/v1/platform/usage?')) {
        return json({ error_code: 'USAGE_UNAVAILABLE', message: 'Usage service unavailable', correlation_id: 'usage-correlation' }, 500);
      }
      return json({}, 404);
    }));

    render(<PlatformOverview />);

    const companiesCard = screen.getByRole('heading', { name: 'Công ty theo trạng thái', level: 3 }).closest('article')!;
    await waitFor(() => expect(within(companiesCard).getByText('1')).toBeTruthy());
  });
});

describe('platform companies', () => {
  it('renders the directory columns and creates a company through provisioning', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      void init;
      if (url === '/api/v1/platform/companies') return json({ items: [company('tenant-1', 'Acme', 'PROVISIONED')] });
      if (url.startsWith('/api/v1/platform/companies/') && url.endsWith('/overview')) {
        return json({ tenant_id: 'tenant-1', display_name: 'Acme', status: 'PROVISIONED', data_class: 'PRODUCTION', created_at: '2026-09-23T00:00:00.000Z', runs_total: 4, runs_failed: 1, runs_running: 0, runs_waiting: 0, retry_eligible_count: 0, reconciliation_count: 0, needs_attention: true, last_activity_at: '2026-09-24T00:00:00.000Z' });
      }
      if (url.startsWith('/api/v1/platform/tenants/') && url.endsWith('/readiness')) return json({});
      if (url === '/api/v1/provisioning/tenants') return json({ tenant_id: 'tenant-2', status: 'PROVISIONED' }, 201);
      return json({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CompaniesPage />);

    await screen.findByText('Acme');
    expect(screen.getByRole('columnheader', { name: 'Phân loại dữ liệu' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Sẵn sàng lĩnh vực' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Hoạt động gần nhất' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Tạo công ty' }));
    const dialog = screen.getByRole('dialog');
    const dataClassSelect = within(dialog).getByLabelText('Phân loại dữ liệu') as HTMLSelectElement;
    expect(Array.from(dataClassSelect.options).map((option) => option.value)).toEqual(['PRODUCTION', 'DEMO', 'TEST']);
    expect(dataClassSelect.value).toBe('PRODUCTION');
    fireEvent.change(within(dialog).getByLabelText('Tên công ty'), { target: { value: 'Beta Corp' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Tạo công ty' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/v1/provisioning/tenants', expect.objectContaining({ method: 'POST' }));
    });
    const provisionCall = fetchMock.mock.calls.find(([input]) => String(input) === '/api/v1/provisioning/tenants');
    const provisionBody = JSON.parse(String((provisionCall?.[1] as RequestInit).body));
    expect(provisionBody.data_class).toBe('PRODUCTION');
    expect(provisionBody.idempotency_key).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows an empty state when the directory has no rows', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ items: [] })));
    render(<CompaniesPage />);
    await waitFor(() => expect(screen.getByText('Chưa có dữ liệu')).toBeTruthy());
  });
});

describe('platform company detail actions', () => {
  it('requires a reason and confirmation before suspending a company', async () => {
    const fetchMock = companyDetailFetch();
    vi.stubGlobal('fetch', fetchMock);
    render(
      <SessionProvider session={companyWriterSession}>
        <CompanyDetail id="tenant-1" />
      </SessionProvider>,
    );
    await screen.findByRole('heading', { name: 'Acme' });

    fireEvent.click(screen.getByRole('button', { name: 'Tạm ngưng' }));
    const dialog = screen.getByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Tạm ngưng' });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Lý do'), { target: { value: 'Maintenance window' } });
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/suspend') && init?.method === 'POST')).toBe(false);

    fireEvent.click(confirm);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/platform/companies/tenant-1/suspend',
      expect.objectContaining({ method: 'POST' }),
    ));
    const suspendCall = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith('/suspend') && init?.method === 'POST');
    expect(JSON.parse(String(suspendCall?.[1]?.body))).toEqual({ reason: 'Maintenance window' });
  });

  it('requires confirmation for autonomy changes and presents evidence references', async () => {
    const fetchMock = companyDetailFetch();
    vi.stubGlobal('fetch', fetchMock);
    render(
      <SessionProvider session={companyWriterSession}>
        <CompanyDetail id="tenant-1" />
      </SessionProvider>,
    );
    await screen.findByRole('heading', { name: 'Acme' });
    fireEvent.click(screen.getByRole('tab', { name: 'Tự chủ' }));

    await screen.findByText('evidence-window-1');
    fireEvent.click(screen.getByRole('button', { name: 'Tạm dừng' }));
    const dialog = screen.getByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Tạm dừng' });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Lý do'), { target: { value: 'Policy review' } });
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/autonomy/pause') && init?.method === 'POST')).toBe(false);

    fireEvent.click(confirm);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/platform/companies/tenant-1/autonomy/pause',
      expect.objectContaining({ method: 'POST' }),
    ));
    const pauseCall = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith('/autonomy/pause') && init?.method === 'POST');
    expect(JSON.parse(String(pauseCall?.[1]?.body))).toEqual({ reason: 'Policy review' });
  });

  it('resends a pending company invitation and confirms user deactivation', async () => {
    const fetchMock = companyDetailFetch();
    vi.stubGlobal('fetch', fetchMock);
    render(
      <SessionProvider session={companyWriterSession}>
        <CompanyDetail id="tenant-1" />
      </SessionProvider>,
    );
    await screen.findByRole('heading', { name: 'Acme' });
    fireEvent.click(screen.getByRole('tab', { name: 'Người dùng' }));

    const invitationRow = await screen.findByRole('row', { name: /pending@example\.test/ });
    fireEvent.click(within(invitationRow).getByRole('button', { name: 'Gửi lại' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/platform/companies/tenant-1/invitations',
      expect.objectContaining({ method: 'POST' }),
    ));
    const invitationCall = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith('/invitations') && init?.method === 'POST');
    expect(JSON.parse(String(invitationCall?.[1]?.body))).toEqual({
      email: 'pending@example.test',
      role_bundle: 'OPERATOR',
    });

    const memberRow = await screen.findByRole('row', { name: /Active Member/ });
    fireEvent.click(within(memberRow).getByRole('button', { name: 'Vô hiệu hóa' }));
    const dialog = screen.getByRole('dialog');
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/users/member-1/deactivate') && init?.method === 'POST')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Vô hiệu hóa người dùng' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/platform/companies/tenant-1/users/member-1/deactivate',
      expect.objectContaining({ method: 'POST' }),
    ));
  });
});

describe('platform company users', () => {
  it('shows member names, falls back to email, masks the email column, and formats last sign-in', async () => {
    const last_sign_in_at = '2026-09-30T10:05:00.000Z';
    vi.stubGlobal('fetch', vi.fn(async () => json({
      items: [
        {
          user_id: 'member-1',
          display_name: 'Alice Admin',
          email: 'alice@example.com',
          role_bundle: 'COMPANY_ADMIN',
          status: 'ACTIVE',
          last_sign_in_at,
        },
        {
          user_id: 'member-2',
          display_name: null,
          email: 'new@example.com',
          role_bundle: 'VIEWER',
          status: 'INVITED',
          last_sign_in_at: null,
        },
      ],
    })));

    render(<CompanyUsersTab companyId="company-1" canManage />);

    expect(await screen.findByText('Alice Admin')).toBeTruthy();
    expect(screen.getByText('new@example.com')).toBeTruthy();
    expect(screen.getByText('a***@example.com')).toBeTruthy();
    expect(screen.getByText('n***@example.com')).toBeTruthy();
    expect(screen.getByText(new Date(last_sign_in_at).toLocaleString())).toBeTruthy();
  });

  it('invites a company administrator through the company-specific route', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/users') && (init?.method ?? 'GET') === 'GET') return json({ items: [] });
      if (url.endsWith('/invitations') && init?.method === 'POST') {
        return json({
          invitation_id: 'invite-1',
          email: 'new-admin@example.com',
          role_bundle: 'COMPANY_ADMIN',
          expires_at: '2026-10-04T00:00:00.000Z',
        }, 201);
      }
      return json({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CompanyUsersTab companyId="company-1" canManage />);

    fireEvent.change(await screen.findByLabelText('Email quản trị viên'), { target: { value: 'new-admin@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mời quản trị viên công ty' }));

    await waitFor(() => {
      const inviteCall = fetchMock.mock.calls.find(([input]) => String(input) === '/api/v1/platform/companies/company-1/invitations');
      expect(inviteCall?.[1]?.method).toBe('POST');
      expect(JSON.parse(String(inviteCall?.[1]?.body))).toEqual({
        email: 'new-admin@example.com',
        role_bundle: 'COMPANY_ADMIN',
      });
    });
    expect(await screen.findByRole('status')).toBeTruthy();
  });
});

describe('platform empty states', () => {
  it('shows empty Usage state without usage rows', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ items: [] })));
    render(<UsagePage />);
    await waitFor(() => expect(screen.getByText('Chưa có dữ liệu')).toBeTruthy());
  });

  it('does not request usage when either date input is cleared', async () => {
    const fetchMock = vi.fn(async () => json({ items: [] }));
    vi.stubGlobal('fetch', fetchMock);
    render(<UsagePage />);
    await screen.findByText('Chưa có dữ liệu');

    const from = screen.getByLabelText('Từ ngày') as HTMLInputElement;
    const to = screen.getByLabelText('Đến ngày') as HTMLInputElement;
    const load = screen.getByRole('button', { name: 'Tải dữ liệu' });
    const originalFrom = from.value;
    fireEvent.change(from, { target: { value: '' } });
    fireEvent.click(load);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.change(from, { target: { value: originalFrom } });
    fireEvent.change(to, { target: { value: '' } });
    fireEvent.click(load);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('marks Subscriptions as not integrated', () => {
    render(<SubscriptionsPage />);
    expect(screen.getByRole('heading', { name: 'Chưa tích hợp' })).toBeTruthy();
  });

  it('shows platform settings tabs in Vietnamese without raw role codes', () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ items: [] })));
    render(
      <SessionProvider session={session}>
        <SettingsPage
          authProvider="demo"
          sessionTtlSeconds={1800}
          featureFlags={[{ key: 'PLATFORM_FEATURE_SUBSCRIPTIONS', labelKey: 'platform.feature_subscriptions', enabled: true }]}
        />
      </SessionProvider>,
    );
    expect(screen.getByRole('tab', { name: 'Tài khoản' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Quản trị viên' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Danh mục kỹ năng' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Tính năng' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Bảo mật' })).toBeTruthy();
    expect(screen.queryByText('platform_admin')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Quản trị viên' }));
    const inviteEmail = screen.getByLabelText('Email quản trị viên mới');
    const inviteButton = screen.getByRole('button', { name: 'Gửi lời mời' });
    expect(inviteButton.hasAttribute('disabled')).toBe(true);
    fireEvent.change(inviteEmail, { target: { value: 'next-admin@example.test' } });
    expect(inviteButton.hasAttribute('disabled')).toBe(false);

    fireEvent.click(screen.getByRole('tab', { name: 'Tính năng' }));
    expect(screen.getByText('Gói dịch vụ')).toBeTruthy();
    expect(screen.getByText('Đang bật')).toBeTruthy();
  });
  it('loads masked platform-admin emails and sends invitations', async () => {
    const signedInAt = '2026-09-30T10:05:00.000Z';
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/api/v1/platform/admins' && method === 'GET') {
        return json({
          items: [{
            user_id: 'admin-1',
            display_name: 'Jane Admin',
            email: 'j***@example.test',
            status: 'ACTIVE',
            last_sign_in_at: signedInAt,
            created_at: '2026-09-01T00:00:00.000Z',
            updated_at: '2026-09-30T10:05:00.000Z',
            role: 'PLATFORM_ADMIN',
          }],
        });
      }
      if (url === '/api/v1/platform/admins' && method === 'POST') {
        return json({
          invitation_id: 'invite-1',
          email: 'n***@example.test',
          expires_at: '2026-10-04T00:00:00.000Z',
        }, 201);
      }
      return json({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <SessionProvider session={session}>
        <SettingsPage authProvider="demo" sessionTtlSeconds={1800} featureFlags={[]} />
      </SessionProvider>,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Quản trị viên' }));

    expect(await screen.findByText('Jane Admin')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Tên hiển thị' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Địa chỉ email' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Trạng thái' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Lần đăng nhập gần nhất' })).toBeTruthy();
    expect(screen.getByText('Đang hoạt động')).toBeTruthy();
    expect(screen.getByText('j***@example.test')).toBeTruthy();
    expect(screen.queryByText('jane@example.test')).toBeNull();
    expect(screen.getByText(new Date(signedInAt).toLocaleString())).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Email quản trị viên mới'), { target: { value: 'new-admin@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gửi lời mời' }));

    await waitFor(() => {
      const inviteCall = fetchMock.mock.calls.find(([input, init]) => String(input) === '/api/v1/platform/admins' && init?.method === 'POST');
      expect(inviteCall?.[1]?.method).toBe('POST');
      expect(JSON.parse(String(inviteCall?.[1]?.body))).toEqual({ email: 'new-admin@example.test' });
    });
    expect((await screen.findByRole('status')).textContent).toContain('Đã gửi lời mời quản trị viên.');
  });

  it('renders fleet health columns and shows no-data cells for null metrics', async () => {
    const catalogEntry = {
      skill_id: 'skill.sales.propose',
      display_key: 'sales.propose',
      domain: 'sales',
      effect_class: 'READ',
      required_authority: 'AUTH-1',
      autonomy_class: 'READ_ONLY',
      completion: 'SYNC',
      allowed_agents: ['sales'],
      connector_kinds: [],
      retired: false,
      contract_version: '1.0.0',
      runs_24h: 0,
      success_rate_24h: null,
      p95_ms_24h: null,
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/platform/skill-catalog') return json({ catalog: [catalogEntry] });
      if (url === '/api/v1/platform/companies') {
        return json({ items: [{ tenant_id: 'tenant-1', display_name: 'Acme', status: 'PROVISIONED', created_at: '2026-09-23T00:00:00.000Z' }] });
      }
      return json({}, 404);
    }));
    render(
      <SessionProvider session={session}>
        <SettingsPage authProvider="demo" sessionTtlSeconds={1800} featureFlags={[]} />
      </SessionProvider>,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Danh mục kỹ năng' }));

    expect(await screen.findByText('sales.propose')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Lượt chạy (24 giờ)' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Tỷ lệ thành công (24 giờ)' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Độ trễ P95 (24 giờ)' })).toBeTruthy();
    const row = screen.getByRole('row', { name: /sales\.propose/ });
    expect(within(row).getByText('0')).toBeTruthy();
    expect(within(row).getAllByText('Chưa có dữ liệu')).toHaveLength(2);
  });

  it('grants a per-company skill entitlement from the catalog tab', async () => {
    const catalogEntry = {
      skill_id: 'skill.sales.propose', display_key: 'sales.propose', domain: 'sales', effect_class: 'READ',
      required_authority: 'AUTH-1', autonomy_class: 'READ_ONLY', completion: 'SYNC',
      allowed_agents: ['sales'],
      connector_kinds: [],
      retired: false,
      contract_version: '1.0.0',
      runs_24h: 1,
      success_rate_24h: 100,
      p95_ms_24h: 250,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/v1/platform/skill-catalog' && (init?.method ?? 'GET') === 'GET') return json({ catalog: [catalogEntry] });
      if (url === '/api/v1/platform/companies') return json({ items: [{ tenant_id: 'tenant-1', display_name: 'Acme', status: 'PROVISIONED', created_at: '2026-09-23T00:00:00.000Z' }] });
      if (url === '/api/v1/platform/skill-catalog/skill.sales.propose/entitlement/tenant-1') {
        return json({ entitlement: { tenant_id: 'tenant-1', skill_id: 'skill.sales.propose', enabled: true, version: 'v2' } });
      }
      return json({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <SessionProvider session={session}>
        <SettingsPage authProvider="db" sessionTtlSeconds={1800} featureFlags={[]} />
      </SessionProvider>,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Danh mục kỹ năng' }));
    await screen.findByText('sales.propose');

    fireEvent.change(screen.getByLabelText('Công ty'), { target: { value: 'tenant-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Bật' }));
    await waitFor(() => expect(screen.getByText('Đang bật')).toBeTruthy());
    const putCall = fetchMock.mock.calls.find(([input, init]) => String(input).includes('/entitlement/tenant-1') && (init?.method ?? '') === 'PUT');
    expect(putCall).toBeTruthy();
  });
});

describe('platform usage currency isolation', () => {
  it('never sums two currencies, and counts unrecorded rows separately', () => {
    const summary = summarizeUsageByCurrency([
      usageRow({ currency: 'USD', cost_total: '10.00', tokens_total: 100 }),
      usageRow({ currency: 'EUR', cost_total: '7.00', tokens_total: 50 }),
      usageRow({ currency: 'USD', cost_total: '5.00', tokens_total: 25 }),
      usageRow({ currency: null, cost_recorded: false, cost_total: null, tokens_total: 40 }),
    ]);

    expect(summary.currencies).toEqual([
      { currency: 'USD', cost: 15, tokens: 125, records: 2 },
      { currency: 'EUR', cost: 7, tokens: 50, records: 1 },
    ]);
    expect(summary.unrecorded).toEqual({ records: 1, tokens: 40 });
  });

  it('renders each currency total separately and labels unrecorded cost', async () => {
    const items = [
      usageRow({ currency: 'USD', cost_total: '10.00' }),
      usageRow({ currency: 'EUR', cost_total: '7.00' }),
      usageRow({ currency: 'USD', cost_total: '5.00' }),
      usageRow({ currency: null, cost_recorded: false, cost_total: null }),
    ];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items }), { status: 200 })));

    render(<UsagePage />);

    await waitFor(() => expect(screen.getAllByText('15 USD').length).toBeGreaterThan(0));
    expect(screen.getAllByText('7 EUR').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Chưa ghi nhận chi phí').length).toBeGreaterThan(0);
  });
});
