import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@agentos/ui-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAuthSession: vi.fn(),
  getApprovals: vi.fn(),
  getApproval: vi.fn(),
  submitApprovalDecision: vi.fn(),
}));

vi.mock('../../lib/tenant-console-client', () => ({
  tenantConsoleClient: {
    getAuthSession: mocks.getAuthSession,
    getApprovals: mocks.getApprovals,
    getApproval: mocks.getApproval,
    submitApprovalDecision: mocks.submitApprovalDecision,
  },
}));

import { ApprovalCenter } from './ApprovalCenter';

const session = {
  identity: { user_id: 'op-1', email: 'op@example.test', display_name: 'Operator' },
  membership: { tenant_id: 'tenant-1', tenant_name: 'Tenant One', role: 'admin', scope: 'company' },
  permissions: ['approval:read', 'approval:decide'],
  expires_at: '2099-01-01T00:00:00.000Z',
};

const pendingItem = {
  approval_id: 'approval-1',
  run_id: 'run-1',
  action_id: 'action-1',
  effect_key: 'effect-1',
  payload: { channel: 'EMAIL', audience_size: 320 },
  reason: 'Chiến dịch winback cần bạn duyệt',
  status: 'PENDING',
  is_paused: false,
  decided_by: null,
  decided_at: null,
  decision_notes: null,
  created_at: '2026-09-23T00:00:00.000Z',
  payload_sha256: 'a'.repeat(64),
  summary: {
    title_key: 'approvals.title.campaign',
    params: { campaign_name: 'Winback tháng 10', audience_size: 320, channel: 'email' },
    requesting_agent_key: 'skill.marketing.send_campaign',
    domain: 'marketing',
    campaign_id: 'campaign-1',
    customer_id: null,
    risk: 'high',
    evidence_count: 2,
    modification: null,
    expires_at: '2099-01-01T00:00:00.000Z',
  },
};

const modifiedItem = {
  ...pendingItem,
  status: 'MODIFIED',
  payload: { channel: 'ZALO', audience_size: 320 },
  payload_sha256: 'b'.repeat(64),
  decided_by: '18ad2c85-7a84-48ed-9c07-67b3f45d87e1',
  decision_notes: 'Đã chuyển sang Zalo',
  summary: {
    ...pendingItem.summary,
    params: { ...pendingItem.summary.params, channel: 'zalo' },
    modification: { before: pendingItem.payload, after: { channel: 'ZALO', audience_size: 320 } },
  },
};

describe('ApprovalCenter', () => {
  beforeEach(() => {
    mocks.getAuthSession.mockReset().mockResolvedValue(session);
    mocks.getApprovals.mockReset().mockResolvedValue({ items: [pendingItem], next_cursor: null });
    mocks.getApproval.mockReset().mockResolvedValue(pendingItem);
    mocks.submitApprovalDecision.mockReset();
  });

  afterEach(() => cleanup());

  it('renders the Vietnamese tabs and the campaign card sentence', async () => {
    render(<ApprovalCenter />);

    expect(await screen.findByRole('tab', { name: 'Chờ duyệt' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Đã xử lý' })).toBeTruthy();
    expect(await screen.findByText(/Gửi chiến dịch “Winback tháng 10” cho 320 khách qua Email/)).toBeTruthy();
    expect(await screen.findByText('Yêu cầu bởi Chiến dịch Marketing · Marketing')).toBeTruthy();
    expect(screen.queryByText(/skill\./)).toBeNull();
    expect(mocks.getApprovals).toHaveBeenCalledWith(expect.objectContaining({ status: 'PENDING' }));
  });

  it('opens the drawer with what-will-happen, checks and technical details', async () => {
    render(<ApprovalCenter />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /Gửi chiến dịch/ }));

    expect(await screen.findByText('Điều gì sẽ xảy ra')).toBeTruthy();
    expect(screen.getByText('Chi tiết kỹ thuật')).toBeTruthy();
    expect(screen.getByText('Bằng chứng')).toBeTruthy();
    expect(screen.getByText(/^a{64}$/)).toBeTruthy();
  });

  it('loads the Đã xử lý history from the DECIDED filter', async () => {
    render(<ApprovalCenter />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('tab', { name: 'Đã xử lý' }));

    expect(mocks.getApprovals).toHaveBeenCalledWith(expect.objectContaining({ status: 'DECIDED' }));
  });

  it('T6.8 refreshes a stale pending proposal and requires the reviewer to reopen it', async () => {
    mocks.getApprovals
      .mockResolvedValueOnce({ items: [pendingItem], next_cursor: null })
      .mockResolvedValue({
        items: [{
          ...pendingItem,
          payload: { channel: 'EMAIL', audience_size: 640 },
          payload_sha256: 'b'.repeat(64),
          summary: { ...pendingItem.summary, params: { ...pendingItem.summary.params, audience_size: 640 } },
        }],
        next_cursor: null,
      });
    mocks.getApproval.mockResolvedValue({ ...pendingItem, payload_sha256: 'b'.repeat(64) });
    mocks.submitApprovalDecision.mockRejectedValue(
      new ApiError(409, {
        error_code: 'APPROVAL_STALE_PAYLOAD',
        message: 'payload changed',
        retryable: false,
        correlation_id: 'corr-1',
      }),
    );
    render(<ApprovalCenter />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /Gửi chiến dịch/ }));
    await user.click(await screen.findByRole('button', { name: 'Duyệt' }));

    expect(await screen.findByText('Đề xuất đã thay đổi, cần xem lại')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('APPROVAL_STALE_PAYLOAD')).toBeNull();
    const refreshed = await screen.findByRole('button', { name: /cho 640 khách qua Email/ });
    await user.click(refreshed);
    expect(await screen.findByRole('button', { name: 'Duyệt' })).toBeTruthy();
    expect(mocks.submitApprovalDecision).toHaveBeenCalledTimes(1);
  });

  it.each(['APPROVAL_NOT_CLAIMABLE', 'APPROVAL_STALE_PAYLOAD'])(
    'T6.8 refreshes an already-decided proposal after %s without resubmitting it',
    async (errorCode) => {
      mocks.getApprovals
        .mockResolvedValueOnce({ items: [pendingItem], next_cursor: null })
        .mockResolvedValue({ items: [modifiedItem], next_cursor: null });
      mocks.getApproval.mockResolvedValue(modifiedItem);
      mocks.submitApprovalDecision.mockRejectedValue(new ApiError(409, {
        error_code: errorCode,
        message: 'approval is already decided',
        retryable: false,
        correlation_id: 'corr-2',
      }));
      render(<ApprovalCenter />);
      const user = userEvent.setup();

      await user.click(await screen.findByRole('button', { name: /Gửi chiến dịch/ }));
      await user.click(await screen.findByRole('button', { name: 'Duyệt' }));

      expect(await screen.findByText('Đề xuất đã thay đổi, cần xem lại')).toBeTruthy();
      const decided = await screen.findByRole('button', { name: /Đã duyệt bản chỉnh sửa/ });
      expect(screen.getByRole('tab', { name: 'Đã xử lý' }).getAttribute('aria-selected')).toBe('true');
      expect(screen.queryByRole('dialog')).toBeNull();
      await user.click(decided);
      expect(await screen.findByText('Đã chuyển sang Zalo')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Duyệt' })).toBeNull();
      expect(screen.queryByText(errorCode)).toBeNull();
      expect(mocks.getApproval).toHaveBeenCalledWith(pendingItem.approval_id);
      expect(mocks.getApprovals).toHaveBeenLastCalledWith({ status: 'DECIDED' });
      expect(mocks.submitApprovalDecision).toHaveBeenCalledTimes(1);
    },
  );

  it('T6.8 approves the edited revision once with the reviewed digest and preserves untouched fields', async () => {
    mocks.submitApprovalDecision.mockResolvedValue({ status: 'QUEUED' });
    mocks.getApprovals
      .mockResolvedValueOnce({ items: [pendingItem], next_cursor: null })
      .mockResolvedValue({ items: [], next_cursor: null });
    render(<ApprovalCenter />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /Gửi chiến dịch/ }));
    await user.click(await screen.findByRole('button', { name: 'Yêu cầu sửa' }));
    await user.type(screen.getByLabelText('Kênh gửi'), 'ZALO');
    await user.type(screen.getByLabelText('Ghi chú'), 'Chuyển sang Zalo trước khi gửi');
    await user.click(screen.getByRole('button', { name: 'Gửi yêu cầu sửa' }));

    expect(await screen.findByText(/Đã duyệt bản chỉnh sửa · Đang kiểm tra lại/)).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocks.submitApprovalDecision).toHaveBeenCalledTimes(1);
    expect(mocks.submitApprovalDecision).toHaveBeenCalledWith(pendingItem.approval_id, {
      decision: 'MODIFY',
      reason: 'Chuyển sang Zalo trước khi gửi',
      expected_payload_sha256: pendingItem.payload_sha256,
      modified_payload: { ...pendingItem.payload, channel: 'ZALO' },
    });
  });
});
