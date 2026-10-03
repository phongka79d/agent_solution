import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AuthSession } from '@agentos/ui-foundation/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CompanyConnectorItem, ConnectorBinding } from '../../lib/types/tenant-console';
import { SessionProvider } from '../auth/SessionProvider';

const mocks = vi.hoisted(() => ({
  getCompanyIntegrations: vi.fn(),
  updateCompanyIntegration: vi.fn(),
  testCompanyIntegration: vi.fn(),
  disconnectCompanyIntegration: vi.fn(),
}));

vi.mock('../../lib/tenant-console-client', () => ({ tenantConsoleClient: mocks }));

import { IntegrationsPage } from './IntegrationsPage';

const session: AuthSession = {
  identity: { user_id: 'u-1', email: 'operator@example.test', display_name: 'Nguyễn An' },
  membership: { tenant_id: 'tenant-1', tenant_name: 'Cửa hàng Một', role: 'admin', scope: 'company' },
  permissions: ['telemetry:read', 'integration:manage'],
  expires_at: '2099-01-01T00:00:00.000Z',
};

const erpBinding = {
  status: 'UNBOUND',
  mode: 'MOCK',
  config: { base_url: 'https://old.example', auth_scheme: 'HMAC_MOCK' },
  version: 1,
  bound_at: '2026-09-30T09:00:00.000Z',
  probe: null,
  secret: null,
} as const;

const erp: CompanyConnectorItem = {
  key: 'API-001',
  category: 'data',
  status: 'NOT_CONFIGURED',
  detail_key: 'company.integrations.not_configured',
  connector_id: 'API-001',
  display_key: 'connectors.api001',
  catalog_category: 'ERP_POS',
  integrated: true,
  config_schema: {
    type: 'object',
    properties: {
      base_url: { type: 'string', format: 'uri' },
      auth_scheme: { type: 'string', enum: ['HMAC_MOCK', 'BEARER', 'BASIC'] },
    },
    required: ['base_url'],
    additionalProperties: false,
  },
  auth_schemes: ['HMAC_MOCK', 'BEARER', 'BASIC'],
  probes: ['catalog', 'inventory', 'customers', 'orders'],
  binding: erpBinding,
};

const shopify: CompanyConnectorItem = {
  key: 'SHOPIFY',
  category: 'commerce',
  status: 'NOT_INTEGRATED',
  detail_key: 'company.integrations.not_integrated',
  connector_id: 'SHOPIFY',
  display_key: 'connectors.shopify',
  catalog_category: 'COMMERCE',
  integrated: false,
  config_schema: { type: 'object', properties: { shop_domain: { type: 'string', minLength: 1 } }, required: ['shop_domain'] },
  auth_schemes: ['BEARER'],
  probes: [],
  binding: null,
};

function renderPage() {
  return render(<SessionProvider session={session}><IntegrationsPage /></SessionProvider>);
}

beforeEach(() => {
  mocks.getCompanyIntegrations.mockResolvedValue({ items: [erp, shopify] });
  mocks.updateCompanyIntegration.mockReset();
  mocks.testCompanyIntegration.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('IntegrationsPage', () => {
  it('prefers the current live binding over a stale catalog status', async () => {
    mocks.getCompanyIntegrations.mockResolvedValue({
      items: [{
        ...erp,
        binding: {
          ...erpBinding, status: 'BOUND', mode: 'LIVE',
          probe: { outcome: 'PASS', latency_ms: 12, http_status: 200, error_class: null, probed_at: '2026-10-01T09:00:00.000Z' },
        },
      }],
    });
    renderPage();

    const card = await screen.findByTestId('connector-card-API-001');
    expect(within(card).getByText('Đang hoạt động')).toBeTruthy();
    expect(within(card).queryByText('Chưa cấu hình')).toBeNull();
  });

  it('groups connectors under the business groups with translated status', async () => {
    renderPage();

    await screen.findByTestId('connector-card-API-001');
    expect(screen.getByRole('heading', { level: 2, name: 'Dữ liệu sản phẩm & đơn hàng' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Kênh trò chuyện' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Dịch vụ AI' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Thanh toán & tuân thủ' })).toBeTruthy();
    expect(screen.getByText('ERP / POS nội bộ')).toBeTruthy();
    expect(screen.getByText('Chưa cấu hình')).toBeTruthy();
    expect(screen.getAllByText('Chưa tích hợp').length).toBeGreaterThan(0);
  });

  it('posts config and the write-only secret, then shows only the fingerprint', async () => {
    const user = userEvent.setup();
    mocks.updateCompanyIntegration.mockResolvedValue({
      binding: {
        status: 'BOUND',
        mode: 'LIVE',
        config: { base_url: 'https://erp.example', auth_scheme: 'BEARER' },
        version: 2,
        bound_at: '2026-10-01T09:00:00.000Z',
        probe: null,
        secret: { fingerprint: 'fp-123', last4: 'alue' },
      },
    });
    renderPage();

    const card = await screen.findByTestId('connector-card-API-001');
    await user.click(within(card).getByRole('button', { name: 'Kết nối' }));

    const baseUrl = screen.getByLabelText('Địa chỉ máy chủ (URL)');
    await user.clear(baseUrl);
    await user.type(baseUrl, 'https://erp.example');
    await user.selectOptions(screen.getByLabelText('Cách xác thực'), 'BEARER');
    await user.type(screen.getByLabelText('Khoá xác thực'), 'top-secret-value');
    await user.click(screen.getByRole('button', { name: 'Lưu' }));

    await waitFor(() => expect(mocks.updateCompanyIntegration).toHaveBeenCalledWith(
      'API-001',
      { config: { base_url: 'https://erp.example', auth_scheme: 'BEARER' }, secret: 'top-secret-value' },
      1,
    ));
    expect(await screen.findByText(/fp-123/)).toBeTruthy();
    expect(screen.queryByText('top-secret-value')).toBeNull();
    const secretInput = screen.getByLabelText('Khoá xác thực');
    if (!(secretInput instanceof HTMLInputElement)) throw new Error('The secret field must be an input.');
    expect(secretInput.value).toBe('');
    expect(within(card).getByText('Chưa tích hợp')).toBeTruthy();
  });

  it('shows per-check test results including the authentication failure', async () => {
    const user = userEvent.setup();
    mocks.testCompanyIntegration.mockResolvedValue({
      outcome: 'FAIL',
      checks: [
        { probe: 'catalog', outcome: 'PASS', latency_ms: 12, http_status: 200, error_class: null },
        { probe: 'inventory', outcome: 'FAIL', latency_ms: 5, http_status: 401, error_class: 'PROVIDER_REJECTED' },
      ],
      binding: erpBinding,
    });
    renderPage();

    const card = await screen.findByTestId('connector-card-API-001');
    await user.click(within(card).getByRole('button', { name: 'Kiểm tra' }));

    expect(await screen.findByText('Danh mục')).toBeTruthy();
    expect(screen.getByText('Tồn kho')).toBeTruthy();
    expect(screen.getByText('Lỗi xác thực')).toBeTruthy();
    expect(mocks.testCompanyIntegration).toHaveBeenCalledWith('API-001');
  });

  it('updates the card badge from each probe binding without refetching integrations', async () => {
    const user = userEvent.setup();
    const passed: ConnectorBinding = {
      ...erpBinding, status: 'BOUND',
      probe: { outcome: 'PASS', latency_ms: 12, http_status: 200, error_class: null, probed_at: '2026-10-01T09:00:00.000Z' },
    };
    const failed: ConnectorBinding = {
      ...passed, status: 'DEGRADED',
      probe: { outcome: 'FAIL', latency_ms: 5, http_status: 401, error_class: 'AUTH_FAILED', probed_at: '2026-10-01T09:01:00.000Z' },
    };
    mocks.testCompanyIntegration.mockResolvedValueOnce({
      outcome: 'PASS', checks: [{ probe: 'catalog', outcome: 'PASS', latency_ms: 12, http_status: 200, error_class: null }],
      binding: passed,
    }).mockResolvedValueOnce({
      outcome: 'FAIL', checks: [{ probe: 'catalog', outcome: 'FAIL', latency_ms: 5, http_status: 401, error_class: 'AUTH_FAILED' }],
      binding: failed,
    });
    renderPage();

    const card = await screen.findByTestId('connector-card-API-001');
    expect(within(card).getByText('Chưa cấu hình')).toBeTruthy();
    await user.click(within(card).getByRole('button', { name: 'Kiểm tra' }));
    expect(await within(card).findByText('Mô phỏng demo')).toBeTruthy();
    expect(within(card).queryByText('Chưa cấu hình')).toBeNull();
    await user.click(within(card).getByRole('button', { name: 'Kiểm tra' }));
    const header = within(card).getByRole('heading', { name: 'ERP / POS nội bộ' }).parentElement;
    if (header === null) throw new Error('The connector card must have a status header.');
    expect(await within(header).findByText('Lỗi', { exact: true })).toBeTruthy();
    expect(within(card).queryByText('Mô phỏng demo')).toBeNull();
    expect(mocks.getCompanyIntegrations).toHaveBeenCalledTimes(1);
  });

  it('publishes modal probe bindings to the card and retains the probe results', async () => {
    const user = userEvent.setup();
    mocks.testCompanyIntegration.mockResolvedValue({
      outcome: 'PASS',
      checks: [{ probe: 'catalog', outcome: 'PASS', latency_ms: 12, http_status: 200, error_class: null }],
      binding: {
        ...erpBinding, status: 'BOUND',
        probe: { outcome: 'PASS', latency_ms: 12, http_status: 200, error_class: null, probed_at: '2026-10-01T09:00:00.000Z' },
      },
    });
    renderPage();

    const card = await screen.findByTestId('connector-card-API-001');
    await user.click(within(card).getByRole('button', { name: 'Kết nối' }));
    const modal = screen.getByRole('dialog');
    await user.click(within(modal).getByRole('button', { name: 'Kiểm tra kết nối' }));
    expect(await within(modal).findByText('Kết nối hoạt động.')).toBeTruthy();
    expect(await within(card).findByText('Mô phỏng demo')).toBeTruthy();
    await user.click(within(modal).getByRole('button', { name: 'Hủy' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(card).getByText('Mô phỏng demo')).toBeTruthy();
    expect(mocks.getCompanyIntegrations).toHaveBeenCalledTimes(1);
  });
});
