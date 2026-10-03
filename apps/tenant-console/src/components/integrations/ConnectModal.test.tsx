import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CompanyConnectorItem, ConnectorBinding, ConnectorTestResponse } from '../../lib/types/tenant-console';
import { ConnectModal } from './ConnectModal';

const mocks = vi.hoisted(() => ({
  updateCompanyIntegration: vi.fn(),
  testCompanyIntegration: vi.fn(),
}));
vi.mock('../../lib/tenant-console-client', () => ({ tenantConsoleClient: mocks }));

const initialBinding: ConnectorBinding = {
  status: 'UNBOUND', mode: 'MOCK', version: 1,
  config: { base_url: 'http://erp.example/api/v1', auth_scheme: 'HMAC_MOCK' },
  bound_at: '2026-10-01T09:00:00.000Z', probe: null, secret: null,
};
const item: CompanyConnectorItem = {
  key: 'API-001', category: 'data', status: 'NOT_CONFIGURED',
  detail_key: 'company.integrations.not_configured', connector_id: 'API-001',
  display_key: 'connectors.api001', catalog_category: 'ERP_POS', integrated: true,
  config_schema: {
    type: 'object',
    properties: {
      base_url: { type: 'string', format: 'uri' },
      auth_scheme: { type: 'string', enum: ['HMAC_MOCK'] },
    },
    required: ['base_url'],
  },
  auth_schemes: ['HMAC_MOCK'], probes: ['catalog'], binding: initialBinding,
};

const probes: readonly ConnectorTestResponse[] = [
  {
    outcome: 'PASS',
    checks: [{ probe: 'catalog', outcome: 'PASS', latency_ms: 12, http_status: 200, error_class: null }],
    binding: {
      ...initialBinding, status: 'BOUND', version: 2,
      probe: { outcome: 'PASS', latency_ms: 12, http_status: 200, error_class: null, probed_at: '2026-10-01T09:01:00.000Z' },
    },
  },
  {
    outcome: 'FAIL',
    checks: [{ probe: 'catalog', outcome: 'FAIL', latency_ms: 5, http_status: 401, error_class: 'AUTH_FAILED' }],
    binding: {
      ...initialBinding, status: 'DEGRADED', version: 3,
      probe: { outcome: 'FAIL', latency_ms: 5, http_status: 401, error_class: 'AUTH_FAILED', probed_at: '2026-10-01T09:02:00.000Z' },
    },
  },
];

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('ConnectModal', () => {
  it.each(probes)('publishes the $outcome probe binding and uses its version for the next save', async (probe) => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    mocks.testCompanyIntegration.mockResolvedValue(probe);
    mocks.updateCompanyIntegration.mockResolvedValue({ binding: { ...probe.binding, version: probe.binding.version + 1 } });
    render(<ConnectModal open item={item} onClose={vi.fn()} onSaved={onSaved} />);

    const modal = screen.getByRole('dialog');
    await user.click(within(modal).getByRole('button', { name: 'Kiểm tra kết nối' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('API-001', probe.binding));
    expect(mocks.testCompanyIntegration).toHaveBeenCalledWith('API-001');
    expect(within(modal).getByText(probe.outcome === 'PASS' ? 'Kết nối hoạt động.' : 'Kết nối lỗi.')).toBeTruthy();
    if (probe.outcome === 'FAIL') expect(within(modal).getByText('Lỗi xác thực')).toBeTruthy();

    await user.click(within(modal).getByRole('button', { name: 'Lưu' }));
    await waitFor(() => expect(mocks.updateCompanyIntegration).toHaveBeenCalledWith(
      'API-001', { config: initialBinding.config }, probe.binding.version,
    ));
  });
});
