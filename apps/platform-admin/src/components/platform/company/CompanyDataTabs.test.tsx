import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { auditActionLabel, auditActorKindLabel, auditReasonLabel } from '../../../lib/audit-format';
import type { PlatformCompanyAuditEvent } from '../../../lib/platform-client';
import { CompanyAuditTab } from './CompanyDataTabs';

function auditEvent(eventId: string, reason: string | null): PlatformCompanyAuditEvent {
  return {
    event_id: eventId,
    chain_seq: eventId,
    actor_kind: 'SYSTEM',
    actor_id: 'connector-probe',
    action: 'connector.probe.recorded',
    outcome: 'SUCCESS',
    reason,
    created_at: '2026-09-30T10:00:00.000Z',
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('auditReasonLabel', () => {
  it('keeps operator prose and uses neutral labels for missing or unknown reasons', () => {
    expect(auditReasonLabel('Đổi cấu hình kết nối')).toBe('Đổi cấu hình kết nối');
    expect(auditReasonLabel('FUTURE_PROVIDER_FAILURE')).toBe('Không xác định');
    expect(auditReasonLabel('constructor')).toBe('constructor');
    expect(auditReasonLabel('Lỗi FUTURE_PROVIDER_FAILURE')).toBe('Không xác định');
    for (const reason of [null, undefined, '', '  ']) {
      expect(auditReasonLabel(reason)).toBe('Chưa có dữ liệu');
    }
  });
});

describe('audit operation labels', () => {
  it('uses neutral fallbacks rather than unknown machine codes', () => {
    expect(auditActionLabel('FUTURE_ACTION')).toBe('Thao tác hệ thống');
    expect(auditActionLabel('constructor')).toBe('Thao tác hệ thống');
    expect(auditActorKindLabel('OPERATOR')).toBe('Nhân viên');
    expect(auditActorKindLabel('SYSTEM')).toBe('Hệ thống');
    expect(auditActorKindLabel('FUTURE_ACTOR')).toBe('Người thực hiện');
  });
});

describe('CompanyAuditTab', () => {
  it('localizes catalogued failures without exposing raw codes in the audit table', async () => {
    const items = [
      auditEvent('1', 'PROVIDER_REJECTED'),
      auditEvent('2', 'PROVIDER_UNAVAILABLE'),
      auditEvent('3', 'FUTURE_PROVIDER_FAILURE'),
      auditEvent('4', 'Đổi cấu hình kết nối'),
      auditEvent('5', null),
    ];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    const { container } = render(<CompanyAuditTab companyId="tenant-1" />);

    expect(await screen.findByText('Nhà cung cấp từ chối yêu cầu.')).toBeTruthy();
    expect(screen.getByText('Dịch vụ liên quan tạm thời không khả dụng. Vui lòng thử lại.')).toBeTruthy();
    expect(screen.getByText('Không xác định')).toBeTruthy();
    expect(screen.getByText('Đổi cấu hình kết nối')).toBeTruthy();
    expect(screen.getByText('Chưa có dữ liệu')).toBeTruthy();
    expect(container.textContent).not.toMatch(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/);
  });

  it('localizes actions, actor kinds and timestamps, keeping raw actions in collapsed technical details', async () => {
    const actions = ['RESET_DRY_RUN', 'RESET', 'secret.create', 'skill.agents.replace', 'FUTURE_ACTION'];
    const items = actions.map((action, index) => ({
      ...auditEvent(String(index), null),
      actor_kind: 'OPERATOR',
      actor_id: 'demo-company-admin',
      action,
    }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    render(<CompanyAuditTab companyId="tenant-1" />);

    expect(await screen.findByText('Xem trước đặt lại dữ liệu')).toBeTruthy();
    expect(screen.getByText('Đặt lại dữ liệu')).toBeTruthy();
    expect(screen.getByText('Tạo thông tin xác thực')).toBeTruthy();
    expect(screen.getByText('Cập nhật nhân sự AI của kỹ năng')).toBeTruthy();
    expect(screen.getByText('Thao tác hệ thống')).toBeTruthy();
    expect(screen.getAllByText(/Nhân viên/)).toHaveLength(actions.length);
    expect(screen.queryByText(/OPERATOR/)).toBeNull();
    expect(screen.getAllByText(new Date('2026-09-30T10:00:00.000Z').toLocaleString('vi-VN'))).toHaveLength(actions.length);
    for (const action of actions) {
      const technicalCode = screen.getByText(action);
      expect(technicalCode.tagName).toBe('CODE');
      expect(technicalCode.classList.contains('font-mono')).toBe(true);
      expect(technicalCode.closest('details')?.open).toBe(false);
    }
  });
});
