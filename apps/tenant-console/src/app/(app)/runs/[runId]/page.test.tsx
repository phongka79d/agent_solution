import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { AuthSession } from '@agentos/ui-foundation/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionProvider } from '../../../../components/auth/SessionProvider';
import RunStoryPage from './page';

const RUN_ID = '11111111-2222-4333-8444-555555555555';
const session: AuthSession = {
  identity: { user_id: 'operator-1', email: 'operator@example.test', display_name: 'Nguyễn An' },
  membership: { tenant_id: 'tenant-1', tenant_name: 'Cửa hàng Một', role: 'operator', scope: 'company' },
  permissions: ['run:read'],
  expires_at: '2099-01-01T00:00:00.000Z',
};

function response(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('run story page', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => response({
      domain: 'sales',
      title_key: 'company.run.title.sales',
      title_params: { domain: 'bán hàng', customer: 'N*** V*** A***', campaign: 'Winback' },
      state: 'FAILED',
      retries: 2,
      retry_eligibility: { retryable: true, reason_code: 'SAFE_TO_RETRY' },
      steps: [{
        name: 'Gợi ý sản phẩm',
        status: 'COMPLETED',
        duration_ms: 420,
        summary_key: 'stage.success',
        summary: { customer_verified: true },
      }],
      final_outcome: { status: 'FAILED', reason_key: 'run.failure.transient' },
      duration_ms: 4200,
    })));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders localized story, safe statuses, retries and domain-aware actions', async () => {
    render(
      <SessionProvider session={session}>
        <RunStoryPage params={{ runId: RUN_ID }} />
      </SessionProvider>,
    );

    expect(await screen.findByRole('heading', { name: 'Tư vấn sản phẩm cho N*** V*** A***' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Gợi ý sản phẩm' })).toBeTruthy();
    expect(screen.getByText('Hoàn tất')).toBeTruthy();
    expect(screen.getByText('Thông tin khách hàng đã được xác minh.')).toBeTruthy();
    expect(screen.getByText('Số lần thử lại: 2')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Kiểm tra kết nối →' }).getAttribute('href')).toBe('/integrations');
    expect(screen.getByRole('link', { name: 'Quay lại' }).getAttribute('href')).toBe('/conversations');

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith(
      `/api/v1/runs/${encodeURIComponent(RUN_ID)}/story`,
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    ));
    const technical = document.querySelector('details');
    expect(technical?.textContent).toContain(RUN_ID);
    const visibleText = (document.body.textContent ?? '').replace(technical?.textContent ?? '', '');
    expect(visibleText).not.toContain(RUN_ID);
    expect(visibleText).not.toMatch(/\b(?:FAILED|COMPLETED|SAFE_TO_RETRY)\b/);
    expect(visibleText).not.toContain('"summary"');
  });
});
