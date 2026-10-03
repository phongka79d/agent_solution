import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AuthSession } from '@agentos/ui-foundation/auth';
import { t } from '@agentos/ui-foundation/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionProvider } from '../auth/SessionProvider';

const mocks = vi.hoisted(() => ({
  getCompanyProfile: vi.fn(),
  updateCompanyProfile: vi.fn(),
  getCompanyGovernance: vi.fn(),
  updateCompanyGovernance: vi.fn(),
  getCompanyLlm: vi.fn(),
  updateCompanyLlm: vi.fn(),
  testCompanyLlm: vi.fn(),
  getCompanyAudit: vi.fn(),
  getCompanyUsers: vi.fn(),
  inviteCompanyUser: vi.fn(),
  updateCompanyUser: vi.fn(),
}));

vi.mock('../../lib/tenant-console-client', () => ({ tenantConsoleClient: mocks }));

import { SettingsPage } from './SettingsPage';

const session: AuthSession = {
  identity: { user_id: 'u-1', email: 'operator@example.test', display_name: 'Nguyễn An' },
  membership: { tenant_id: 'tenant-1', tenant_name: 'Cửa hàng Một', role: 'admin', scope: 'company' },
  permissions: ['settings:manage', 'llm:manage'],
  expires_at: '2099-01-01T00:00:00.000Z',
};

const profile = {
  tenant_id: 'tenant-1',
  company_name: 'Cửa hàng Một',
  industry: 'Bán lẻ',
  locale: 'vi-VN',
  timezone: 'Asia/Ho_Chi_Minh',
  currency: 'VND',
  brand_profile: {},
  version: 3,
  updated_at: '2026-09-30T10:00:00.000Z',
};

const companyUser = {
  user_id: 'member-1',
  display_name: 'Lê Bình',
  email: 'member@example.test',
  role_bundle: 'OPERATOR' as const,
  status: 'ACTIVE' as const,
  last_sign_in_at: '2026-09-30T10:05:00.000Z',
  created_at: '2026-09-30T10:00:00.000Z',
  updated_at: '2026-09-30T10:00:00.000Z',
};

const llm = {
  tenant_id: 'tenant-1',
  mode: 'CUSTOM' as const,
  provider_id: 'provider-a',
  base_url: 'https://llm.example.test',
  reasoning_model: 'reasoning-1',
  fast_model: 'fast-1',
  timeout_ms: 30000,
  structured_mode: 'json_object' as const,
  monthly_token_budget: null,
  secret_configured: true,
  config_version: '2',
  updated_at: '2026-09-30T10:00:00.000Z',
  effective: null,
};

function renderPage() {
  return render(
    <SessionProvider session={session}>
      <SettingsPage />
    </SessionProvider>,
  );
}

beforeEach(() => {
  mocks.getCompanyProfile.mockResolvedValue(profile);
  mocks.updateCompanyProfile.mockResolvedValue({ ...profile, company_name: 'Cửa hàng Hai', version: 4 });
  mocks.getCompanyGovernance.mockResolvedValue({ require_distinct_approver: false, approval_expiry_hours: 24, takeover_lease_seconds: 120, version: 1, updated_at: '2026-09-30T10:00:00.000Z' });
  mocks.getCompanyLlm.mockResolvedValue(llm);
  mocks.updateCompanyLlm.mockResolvedValue(llm);
  mocks.testCompanyLlm.mockResolvedValue({ outcome: 'PASS', latency_ms: 12, http_status: 200, error_class: null });
  mocks.getCompanyAudit.mockResolvedValue({ items: [], next_cursor: null });
  mocks.getCompanyUsers.mockResolvedValue({ items: [companyUser] });
  mocks.inviteCompanyUser.mockResolvedValue({
    invitation_id: 'inv-1',
    email: 'new@example.test',
    role_bundle: 'OPERATOR',
    expires_at: '2026-10-03T10:00:00.000Z',
  });
  mocks.updateCompanyUser.mockImplementation(async (update: Partial<typeof companyUser>) => ({ ...companyUser, ...update }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SettingsPage', () => {
  it('sends If-Match with the version loaded from the profile endpoint', async () => {
    renderPage();
    const form = await screen.findByTestId('settings-profile-form');
    const nameInput = within(form).getAllByRole('textbox')[0] as HTMLInputElement;
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Cửa hàng Hai');
    const save = within(form).getAllByRole('button')[0] as HTMLButtonElement;
    await userEvent.click(save);

    await waitFor(() => expect(mocks.updateCompanyProfile).toHaveBeenCalledTimes(1));
    const [body, version] = mocks.updateCompanyProfile.mock.calls[0] as [Record<string, unknown>, number];
    expect(version).toBe(3);
    expect(body.company_name).toBe('Cửa hàng Hai');
  });

  it('opens the conflict dialog when the server reports a version conflict', async () => {
    mocks.updateCompanyProfile.mockRejectedValueOnce(
      Object.assign(new Error('conflict'), { status: 409, error_code: 'VERSION_CONFLICT' }),
    );
    renderPage();
    const form = await screen.findByTestId('settings-profile-form');
    const nameInput = within(form).getAllByRole('textbox')[0] as HTMLInputElement;
    await userEvent.type(nameInput, ' X');
    await userEvent.click(within(form).getAllByRole('button')[0] as HTMLButtonElement);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Cài đặt vừa được người khác thay đổi')).toBeTruthy();
    expect(mocks.updateCompanyProfile).toHaveBeenCalledTimes(1);
  });

  it('never renders the stored API key and clears a new key after saving', async () => {
    const secret = 'sk-super-secret-value';
    renderPage();
    await screen.findByTestId('settings-profile-form');
    await userEvent.click(screen.getAllByRole('tab')[2] as HTMLElement);
    const form = await screen.findByTestId('settings-llm-form');
    const keyInput = form.querySelector('input[type="password"]') as HTMLInputElement;
    expect(keyInput.value).toBe('');
    await userEvent.type(keyInput, secret);
    expect(screen.queryByText(secret)).toBeNull();
    await userEvent.click(within(form).getAllByRole('button')[0] as HTMLButtonElement);

    await waitFor(() => expect(mocks.updateCompanyLlm).toHaveBeenCalledTimes(1));
    const [body] = mocks.updateCompanyLlm.mock.calls[0] as [Record<string, unknown>, string | null];
    expect(body.api_key).toBe(secret);
    await waitFor(() => expect((form.querySelector('input[type="password"]') as HTMLInputElement).value).toBe(''));
    expect(screen.queryByText(secret)).toBeNull();
  });
  it('falls back to the member email when no display name is available', async () => {
    mocks.getCompanyUsers.mockResolvedValueOnce({
      items: [{ ...companyUser, display_name: null, last_sign_in_at: null }],
    });
    renderPage();
    await userEvent.click(screen.getByRole('tab', { name: 'Người dùng' }));

    const userRow = await screen.findByRole('row', { name: /member@example\.test/ });
    expect(within(userRow).getAllByText('member@example.test')).toHaveLength(2);
  });

  it('shows a resend action for pending invitations and issues a replacement invitation', async () => {
    mocks.getCompanyUsers.mockResolvedValueOnce({
      items: [{ ...companyUser, user_id: 'invitation-1', status: 'INVITED', last_sign_in_at: null }],
    });
    renderPage();
    await userEvent.click(screen.getByRole('tab', { name: 'Người dùng' }));

    const row = await screen.findByRole('row', { name: /member@example\.test/ });
    const resend = within(row).getByRole('button', { name: t('settings.users.resend_invitation') });
    expect(within(row).getByRole('combobox', { name: 'Đổi vai trò: member@example.test' }).hasAttribute('disabled')).toBe(true);
    await userEvent.click(resend);

    await waitFor(() => expect(mocks.inviteCompanyUser).toHaveBeenCalledWith('member@example.test', 'OPERATOR'));
    const status = await screen.findByRole('status');
    expect(status.textContent).toBe(t('settings.users.invite_resent'));
  });
  it('requires confirmation before deactivating a company user', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('tab', { name: 'Người dùng' }));
    await screen.findByText('member@example.test');
    expect(screen.getByText('Lê Bình')).toBeTruthy();
    expect(screen.getByText(new Date(companyUser.last_sign_in_at).toLocaleString())).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Vô hiệu hóa' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Vô hiệu hóa người dùng này?')).toBeTruthy();
    expect(mocks.updateCompanyUser).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Vô hiệu hóa người dùng' }));
    await waitFor(() => expect(mocks.updateCompanyUser).toHaveBeenCalledWith({
      user_id: 'member-1',
      status: 'DEACTIVATED',
    }));
  });
  it('invites a chosen role and applies subsequent role changes', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('tab', { name: 'Người dùng' }));
    const inviteEmail = await screen.findByLabelText('Địa chỉ email');
    await userEvent.type(inviteEmail, 'new@example.test');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Vai trò' }), 'VIEWER');
    await userEvent.click(screen.getByRole('button', { name: 'Mời người dùng' }));

    await waitFor(() => expect(mocks.inviteCompanyUser).toHaveBeenCalledWith('new@example.test', 'VIEWER'));
    expect(await screen.findByRole('status')).toBeTruthy();

    const roleSelect = screen.getByRole('combobox', { name: 'Đổi vai trò: member@example.test' }) as HTMLSelectElement;
    await userEvent.selectOptions(roleSelect, 'VIEWER');
    await waitFor(() => expect(mocks.updateCompanyUser).toHaveBeenCalledWith({
      user_id: 'member-1',
      role_bundle: 'VIEWER',
    }));
    expect(roleSelect.value).toBe('VIEWER');
  });
  it('opens change history for the matching profile, governance, and LLM form scopes', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('settings-profile-form');

    await user.click(screen.getByRole('button', { name: t('settings.action.history') }));
    await waitFor(() => expect(mocks.getCompanyAudit).toHaveBeenNthCalledWith(1, { limit: 25, scope: 'company.profile' }));

    await user.click(screen.getByRole('tab', { name: t('settings.tab.approvals') }));
    await screen.findByTestId('settings-governance-form');
    await user.click(screen.getByRole('button', { name: t('settings.action.history') }));
    await waitFor(() => expect(mocks.getCompanyAudit).toHaveBeenNthCalledWith(2, { limit: 25, scope: 'company.governance' }));

    await user.click(screen.getByRole('tab', { name: t('settings.tab.ai') }));
    await screen.findByTestId('settings-llm-form');
    await user.click(screen.getByRole('button', { name: t('settings.action.history') }));
    await waitFor(() => expect(mocks.getCompanyAudit).toHaveBeenNthCalledWith(3, { limit: 25, scope: 'company.llm' }));
  });
  it('exposes data and security tabs without a technical identity tab', () => {
    renderPage();
    expect(screen.getByRole('tab', { name: t('settings.tab.data') })).toBeTruthy();
    expect(screen.getByRole('tab', { name: t('settings.tab.security') })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: t('settings.tab.technical') })).toBeNull();
  });


});
