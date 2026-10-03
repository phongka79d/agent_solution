import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { AuthSession } from '@agentos/ui-foundation/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ push: vi.fn(), request: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('../../../lib/tenant-console-client', () => ({ tenantConsoleClient: { request: mocks.request } }));

import { SessionProvider } from '../../../components/auth/SessionProvider';
import CampaignsPage from './page';
import NewCampaignPage from './new/page';
import CampaignDetailPage from './[runId]/page';

const session: AuthSession = {
  identity: { user_id: 'operator-1', email: 'operator@example.test', display_name: 'Nguyễn An' },
  membership: { tenant_id: 'tenant-1', tenant_name: 'Cửa hàng Một', role: 'operator', scope: 'company' },
  permissions: ['campaign:draft', 'approval:read'],
  expires_at: '2099-01-01T00:00:00.000Z',
};

function response(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function renderWithSession(element: ReactNode) {
  return render(<SessionProvider session={session}>{element}</SessionProvider>);
}

describe('campaign pages', () => {
  beforeEach(() => {
    mocks.push.mockReset();
    mocks.request.mockReset().mockResolvedValue({ task_id: 'run-1' });
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('groups campaigns and shows audience, channel, status and the approval next step', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(response({ items: [
      {
        run_id: 'run-1',
        name: 'Chiến dịch mùa hè',
        objective: 'winback',
        status: 'awaiting_approval',
        audience_count: 24,
        channels: ['EMAIL_HTML'],
      },
      {
        run_id: 'run-2',
        name: 'Chiến dịch thất bại',
        status: 'failed',
        audience_count: 8,
        failure_reason_key: 'PROVIDER_UNAVAILABLE',
      },
    ] }));

    renderWithSession(<CampaignsPage />);

    expect(await screen.findByRole('heading', { name: 'Chiến dịch mùa hè' })).toBeTruthy();
    expect(screen.getByText('Khuyến khích khách hàng quay lại')).toBeTruthy();
    expect(screen.getByText('24 khách')).toBeTruthy();
    expect(screen.getByText('Email')).toBeTruthy();
    expect(screen.getAllByText('Chờ phê duyệt').length).toBeGreaterThan(0);
    const nextStep = screen.getByRole('link', { name: /Chờ bạn phê duyệt/ });
    expect(nextStep.getAttribute('href')).toBe('/approvals');
    expect(screen.getAllByText('Lỗi').length).toBeGreaterThan(0);
    expect(screen.getByText(/Dịch vụ liên quan tạm thời không khả dụng\. Vui lòng thử lại\./)).toBeTruthy();
  });

  it('walks the wizard and posts the selected segment, objective and channel through the shared client', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockImplementation(async (input) => {
      if (String(input) === '/api/v1/campaigns/segments') {
        return response({ segments: [
          { segment_id: 'inactive_30d', label_key: 'campaigns.segments.inactive_30d', kind: 'INACTIVE_DAYS', days: 30, audience_count: 85 },
          { segment_id: 'inactive_90d', label_key: 'campaigns.segments.inactive_90d', kind: 'INACTIVE_DAYS', days: 90, audience_count: 1234 },
        ] });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    mocks.request.mockImplementation(async (endpoint: string, init: RequestInit) => {
      expect(endpoint).toBe('/campaigns/drafts');
      expect(init.method).toBe('POST');
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        name: 'Chiến dịch mùa hè',
        segment_id: 'inactive_90d',
        objective: 'winback',
        content_constraints: { channel: 'SMS_TEXT', locale: 'vi-VN' },
      });
      expect(body.segment_id).not.toBe(body.objective);
      return { task_id: 'run-1' };
    });

    renderWithSession(<NewCampaignPage />);
    fireEvent.change(await screen.findByLabelText('Tên chiến dịch'), { target: { value: 'Chiến dịch mùa hè' } });
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp tục' }));

    await screen.findByRole('option', { name: 'Khách hàng không hoạt động trong 90 ngày · 1.234 khách' });
    expect(screen.getByText('Chỉ gửi khách đã đồng ý nhận marketing.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Phân khúc'), { target: { value: 'inactive_90d' } });
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp tục' }));

    fireEvent.change(await screen.findByLabelText('Kênh'), { target: { value: 'SMS_TEXT' } });
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp tục' }));

    expect(await screen.findByRole('button', { name: 'Tạo bản nháp' })).toBeTruthy();
    // A dl may contain dt/dd groups, not the consent note: axe's definition-list rule
    // otherwise rejects the review step before the draft can be submitted.
    const review = screen.getByText('Chiến dịch mùa hè', { exact: true }).closest('dl');
    expect(review).not.toBeNull();
    expect(review?.querySelector('p')).toBeNull();
    expect(screen.getByText('Chỉ gửi khách đã đồng ý nhận marketing.').closest('dl')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Tạo bản nháp' }));

    await waitFor(() => {
      expect(mocks.request).toHaveBeenCalledTimes(1);
      expect(mocks.push).toHaveBeenCalledWith('/campaigns/run-1');
    });
  });

  it('renders the lifecycle stepper from the run story and shows the dispatch note after approval', async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      if (String(input) === '/api/v1/campaigns/run-9') {
        return response({
          run_id: 'run-9',
          name: 'Winback tháng 10',
          objective: 'winback',
          status: 'approved',
          audience_count: 320,
          channels: ['EMAIL_HTML'],
          approval: { approval_id: 'ap-1', decision: 'APPROVED' },
          dispatch: { status: 'NOT_INTEGRATED' },
        });
      }
      if (String(input) === '/api/v1/runs/run-9/story') {
        return response({ state: 'COMPLETED', steps: [
          { name: 'Generate Content', status: 'COMPLETED', duration_ms: 12 },
          { name: 'Brand Audit', status: 'COMPLETED', duration_ms: 5 },
          { name: 'Consent Check', status: 'COMPLETED', duration_ms: 4 },
          { name: 'Approval', status: 'COMPLETED', duration_ms: 30 },
        ] });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });

    renderWithSession(<CampaignDetailPage params={{ runId: 'run-9' }} />);

    expect(await screen.findByRole('heading', { name: 'Winback tháng 10' })).toBeTruthy();
    for (const label of ['Soạn nội dung', 'Kiểm tra thương hiệu', 'Kiểm tra đồng ý', 'Chờ duyệt', 'Đã duyệt', 'Gửi đi']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.getByText('320 khách')).toBeTruthy();
    expect(screen.getByText('Gửi đi: Chưa tích hợp kênh gửi')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Kết nối kênh' })).toBeTruthy();
  });

  it('shows a plain-word failure reason and hides the dispatch note before approval', async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      if (String(input) === '/api/v1/campaigns/run-3') {
        return response({
          run_id: 'run-3',
          name: 'Nhắc lại đơn hàng',
          status: 'failed',
          failure_reason_key: 'run.failure.transient',
          audience_count: 12,
        });
      }
      if (String(input) === '/api/v1/runs/run-3/story') {
        return response({ state: 'FAILED', steps: [{ name: 'Generate Content', status: 'FAILED', duration_ms: 3 }] });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });

    renderWithSession(<CampaignDetailPage params={{ runId: 'run-3' }} />);

    expect(await screen.findAllByText('Dịch vụ tạm thời không ổn định. Có thể thử lại.')).toBeTruthy();
    expect(screen.queryByText('Gửi đi: Chưa tích hợp kênh gửi')).toBeNull();
  });
});
