/**
 * T8.3 operations console contracts.
 *
 * Covers operator-visible retry/reconciliation behavior, diagnostic steps, export privacy, server
 * search serialization, and localized filters.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunTable } from './RunTable';
import { RunFilterControls } from './RunFilterControls';
import { ReconcileModal } from './ReconcileModal';
import { retryRun, runsQuery } from './api';
import { EMPTY_RUN_FILTERS, type PlatformRunListItem } from './types';
import { RunDetailView } from './RunDetailView';
import { buildRunDetailExportJson } from './format';
import type { PlatformRunDetail, PlatformRunTrace } from './types';

function runRow(over: Partial<PlatformRunListItem>): PlatformRunListItem {
  return {
    tenant_id: '11111111-1111-4111-8111-111111111111',
    display_name: 'Acme',
    run_id: 'run-1',
    domain: 'sales',
    current_step: 3,
    state: 'failed',
    failure_class: 'RETRYABLE',
    retry_eligible: true,
    attempts: 1,
    max_retries: 3,
    duration_ms: 1200,
    created_at: '2026-09-30T10:00:00.000Z',
    updated_at: '2026-09-30T10:00:02.000Z',
    correlation_id: 'corr-1',
    ...over,
  };
}

const diagnosticDetail: PlatformRunDetail = {
  tenant_id: '11111111-1111-4111-8111-111111111111',
  display_name: 'Acme',
  run_id: 'run-detail',
  domain: 'sales',
  correlation_id: 'corr-detail',
  current_step: 1,
  state: 'completed',
  task_version: 1,
  failure_class: null,
  retry_eligible: false,
  attempts: 1,
  max_retries: 3,
  lease_owner: 'worker-1',
  lease_expires_at: null,
  conversation_id: null,
  error_code: null,
  duration_ms: 10,
  stage_event_count: 1,
  evidence_count: 1,
  cost_breakdown: [],
  input_tokens_total: 12,
  output_tokens_total: 8,
  cached_tokens_total: 0,
  created_at: '2026-09-30T10:00:00.000Z',
  updated_at: '2026-09-30T10:00:10.000Z',
};

const diagnosticTrace: PlatformRunTrace = {
  run_id: diagnosticDetail.run_id,
  correlation_id: diagnosticDetail.correlation_id,
  domain: diagnosticDetail.domain,
  state: { business: 'completed', raw: 'completed' },
  attempts: 1,
  duration_ms: 10,
  stages: [{
    stage: 'PLAN',
    status: 'completed',
    started_at: '2026-09-30T10:00:00.000Z',
    completed_at: '2026-09-30T10:00:00.010Z',
    duration_ms: 10,
    agent_code: 'SA-01',
    skill_id: 'skill.sales.create_quote',
    summary_key: null,
    error_class: null,
    detail: {
      plan: 'Create quote',
      customer_email: 'customer@example.test',
      nested: { phone_number: '+1-555-0100' },
    },
    evidence_refs: ['evidence-1'],
  }],
  provider_calls: [],
  steps: [{
    step_index: 1,
    agent: 'SA-01',
    skill: 'skill.sales.create_quote',
    tool_binding: 'crm.create_quote',
    authority: 'AUTH-2',
    autonomy_decision: { outcome: 'ALLOW' },
    execution_status: 'completed',
    effect_key: 'effect-1',
    reservation_status: 'COMMITTED',
    receipt_ref: 'evidence-1',
    error_code: null,
    error_hint: null,
  }],
  audit_entries: [],
  approvals: [],
  handoffs: [],
  effect_keys: ['effect-1'],
  approval_id: null,
  evidence_refs: ['evidence-1'],
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('RunTable action eligibility', () => {
  it('offers reconciliation only for a parked (waiting) run, never a retry', () => {
    const onRetry = vi.fn();
    const onReconcile = vi.fn();
    render(
      <RunTable
        runs={[runRow({ state: 'waiting', failure_class: null, retry_eligible: false })]}
        isLoading={false}
        onRetry={onRetry}
        onReconcile={onReconcile}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Thử lại' })).toBeNull();
    const reconcile = screen.getByRole('button', { name: 'Đối soát' });
    fireEvent.click(reconcile);
    expect(onReconcile).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('offers no recovery action for a failed run the server will neither retry nor reconcile', () => {
    render(
      <RunTable
        runs={[runRow({ state: 'failed', failure_class: 'FATAL', retry_eligible: false })]}
        isLoading={false}
        onRetry={vi.fn()}
        onReconcile={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Thử lại' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Đối soát' })).toBeNull();
  });

  it('offers retry only when the server marks the run eligible', () => {
    const onRetry = vi.fn();
    render(
      <RunTable
        runs={[runRow({ failure_class: 'RETRYABLE', retry_eligible: true })]}
        isLoading={false}
        onRetry={onRetry}
        onReconcile={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Đối soát' })).toBeNull();
  });
});

describe('operations transport', () => {
  it('posts a retry to the platform company-run command route', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ run_id: 'run-1', status: 'accepted', correlation_id: 'corr-1' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const accepted = await retryRun('company-1', 'run-1', 'đã kiểm tra');

    expect(accepted.status).toBe('accepted');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/platform/companies/company-1/runs/run-1/retry');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ reason: 'đã kiểm tra' });
  });

  it('serializes the end-date filter as the server before bound', () => {
    const query = runsQuery({ ...EMPTY_RUN_FILTERS, to: '2026-09-30', state: 'failed' });
    expect(query).toContain('state=failed');
    expect(decodeURIComponent(query)).toContain('before=2026-09-30T23:59:59.999Z');
  });
  it('serializes the search filter as a server query parameter', () => {
    expect(runsQuery({ ...EMPTY_RUN_FILTERS, search: '  conversation-42  ' })).toBe('?search=conversation-42');
  });

});

describe('run diagnostics', () => {
  it('renders execution steps with autonomy, reservation and receipt diagnostics', async () => {
    const fetchMock = vi.fn(async (input: string) => new Response(
      JSON.stringify(input.endsWith('/trace') ? diagnosticTrace : diagnosticDetail),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    render(<RunDetailView companyId="company-1" runId="run-detail" />);

    const toolBinding = await screen.findByText('crm.create_quote');
    const table = toolBinding.closest('table');
    expect(table?.textContent).toContain('SA-01');
    expect(table?.textContent).toContain('create quote');
    expect(table?.textContent).toContain('crm.create_quote');
    expect(table?.textContent).toContain('outcome: ALLOW');
    expect(table?.textContent).toContain('COMMITTED');
    expect(table?.textContent).toContain('evidence-1');
  });

  it('redacts email and phone keys recursively in the downloadable JSON payload', () => {
    const exported = buildRunDetailExportJson(diagnosticDetail, diagnosticTrace);

    expect(exported).toContain('"plan": "Create quote"');
    expect(exported).not.toContain('customer_email');
    expect(exported).not.toContain('customer@example.test');
    expect(exported).not.toContain('phone_number');
    expect(exported).not.toContain('+1-555-0100');
  });
});

describe('localized filters', () => {
  it('renders Vietnamese labels with native date pickers', () => {
    const { container } = render(
      <RunFilterControls filters={EMPTY_RUN_FILTERS} isLoading={false} onChange={vi.fn()} onApply={vi.fn()} onReset={vi.fn()} />,
    );
    expect(screen.getByLabelText('Công ty', { exact: true })).toBeTruthy();
    expect(screen.getByLabelText('Tìm kiếm', { exact: true })).toBe(screen.getByRole('searchbox', { name: 'Tìm kiếm' }));
    expect(screen.getByLabelText('Trạng thái', { exact: true })).toBe(screen.getByRole('combobox', { name: 'Trạng thái' }));
    expect(screen.getByLabelText('Lĩnh vực', { exact: true })).toBe(screen.getByRole('combobox', { name: 'Lĩnh vực' }));
    expect(screen.getByLabelText('Từ ngày', { exact: true }).getAttribute('type')).toBe('date');
    expect(screen.getByLabelText('Đến ngày', { exact: true }).getAttribute('type')).toBe('date');
    expect(container.textContent).toContain('Xóa bộ lọc');
    expect(container.textContent).not.toContain('Apply');
  });

  it('keeps filters editable and apply/reset operable while results refresh', () => {
    const onChange = vi.fn();
    const onApply = vi.fn();
    const onReset = vi.fn();
    render(
      <RunFilterControls filters={EMPTY_RUN_FILTERS} isLoading={true} onChange={onChange} onApply={onApply} onReset={onReset} />,
    );

    fireEvent.change(screen.getByLabelText('Trạng thái', { exact: true }), { target: { value: 'failed' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_RUN_FILTERS, state: 'failed' });
    fireEvent.change(screen.getByLabelText('Lĩnh vực', { exact: true }), { target: { value: 'sales' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_RUN_FILTERS, domain: 'sales' });
    fireEvent.change(screen.getByLabelText('Tìm kiếm', { exact: true }), { target: { value: 'run-42' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_RUN_FILTERS, search: 'run-42' });

    const form = screen.getByRole('form', { name: 'Bộ lọc lượt chạy' });
    const apply = form.querySelector('button[type="submit"]');
    if (!(apply instanceof HTMLButtonElement)) {
      throw new Error('Missing filter submit button');
    }
    const reset = screen.getByRole('button', { name: 'Xóa bộ lọc' });
    expect(apply.disabled).toBe(false);
    expect(reset.hasAttribute('disabled')).toBe(false);
    fireEvent.click(apply);
    expect(onApply).toHaveBeenCalledTimes(1);
    fireEvent.click(reset);
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});

describe('reconciliation modal', () => {
  it('requires a reason before submitting and never issues a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(
      <ReconcileModal
        item={{
          tenant_id: 'company-1',
          display_name: 'Acme',
          run_id: 'run-1',
          failure_class: 'UNKNOWN',
          reason: 'INDETERMINATE_OUTCOME',
        }}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );
    expect(screen.getByText('Provider xác nhận thành công')).toBeTruthy();
    expect(screen.getByText('Chuyển xử lý thủ công')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận đối soát' }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('lý do'));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
