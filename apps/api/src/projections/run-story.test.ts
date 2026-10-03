import { describe, expect, it } from 'vitest';

import type { DurableTaskRecord } from '@agentos/database';
import { mapRetryEligibility, projectRunStory, titleOf } from './run-story.js';

describe('run story projection helpers', () => {
  it('builds a localized title from safe domain, masked customer, and campaign parameters', () => {
    const title = titleOf('sales', {
      signal: {
        payload: {
          customer: { display_name: 'Nguyễn Văn An' },
          campaign: { name: 'Winback tháng 10' },
        },
      },
    });

    expect(title).toEqual({
      key: 'company.run.title.sales',
      params: {
        domain: 'bán hàng',
        customer: 'N*** V*** A***',
        campaign: 'Winback tháng 10',
      },
    });
    expect(JSON.stringify(title.params)).not.toContain('Nguyễn Văn An');
  });

  it('exposes a typed terminal refusal reason in the company-facing story', () => {
    const task: DurableTaskRecord = {
      task_id: 'task-1',
      tenant_id: 'tenant-1',
      run_id: 'run-1',
      correlation_id: 'correlation-1',
      current_step: 1,
      state: 'completed',
      task_version: 2,
      lease_owner: null,
      lease_expires_at: null,
      retry_count: 0,
      max_retries: 3,
      last_error_class: null,
      paused_for_approval_id: null,
      state_payload: {
        signal: { payload: { module: 'sales' } },
        plan: {
          steps: [],
          terminal_response: { response_kind: 'REFUSAL', reason_code: 'LLM_INVALID_RESPONSE' },
        },
      },
      error_details: null,
      created_at: '2026-10-02T00:00:00.000Z',
      updated_at: '2026-10-02T00:00:01.000Z',
    };

    const story = projectRunStory(task, [], { retryable: false, reason: 'NOT_FAILED' });

    expect(story.final_outcome.reason_code).toBe('LLM_INVALID_RESPONSE');
  });

  it('maps server retry classifications to safe company-facing eligibility', () => {
    expect(mapRetryEligibility({
      retryable: true,
      failure_class: 'PRE_DISPATCH_PROVIDER_REJECTION',
      effect_key: 'private-effect-key',
    }, 'failed')).toEqual({ retryable: true, reason_code: 'SAFE_TO_RETRY' });
    expect(mapRetryEligibility({ retryable: false, reason: 'UNKNOWN' }, 'failed'))
      .toEqual({ retryable: false, reason_code: 'RETRY_SAFETY_NOT_PROVEN' });
    expect(mapRetryEligibility({ retryable: false, reason: 'NOT_FAILED' }, 'waiting'))
      .toEqual({ retryable: false, reason_code: 'RECONCILIATION_REQUIRED' });
    expect(mapRetryEligibility({ retryable: false, reason: 'NOT_FOUND' }, 'completed'))
      .toEqual({ retryable: false, reason_code: 'NOT_FOUND' });
  });
});
