import { describe, expect, it } from 'vitest';

import type { CompanyCrmCampaignRow } from '@agentos/database';
import { deriveCampaignLifecycle, toCampaignProjection } from './campaigns.js';

function row(overrides: Partial<CompanyCrmCampaignRow> = {}): CompanyCrmCampaignRow {
  return {
    campaign_id: null,
    run_id: 'run-1',
    name: 'Known campaign name',
    objective: null,
    channels: [],
    audience_count: 14,
    campaign_status: 'DRAFTING',
    campaign_created_at: null,
    campaign_updated_at: null,
    task_state: 'queued',
    task_payload: { signal: { payload: { module: 'marketing', objective: 'winback' } } },
    task_error: null,
    task_created_at: '2026-01-01T00:00:00.000Z',
    approval_id: null,
    approval_decision: null,
    approval_created_at: null,
    approval_decided_at: null,
    approval_payload: null,
    ...overrides,
  };
}

describe('campaign projection', () => {
  it('projects human-waiting tasks and pending approvals as awaiting_approval', () => {
    const humanWait = toCampaignProjection(row({ task_state: 'awaiting_human' }));
    expect(humanWait.status).toBe('awaiting_approval');

    const pendingApproval = toCampaignProjection(row({
      task_state: 'running',
      approval_id: 'approval-1',
      approval_decision: 'PENDING',
    }));
    expect(pendingApproval).toMatchObject({
      status: 'awaiting_approval',
      approval: { approval_id: 'approval-1', decision: 'PENDING' },
    });
  });

  it('derives lifecycle from persisted task, campaign and approval state', () => {
    expect(deriveCampaignLifecycle(row())).toBe('drafting');
    expect(deriveCampaignLifecycle(row({ task_state: 'awaiting_human', approval_decision: 'PENDING' }))).toBe('awaiting_approval');
    expect(toCampaignProjection(row({ task_state: 'awaiting_human', approval_decision: 'PENDING' })).status).toBe('awaiting_approval');
    expect(deriveCampaignLifecycle(row({ campaign_status: 'AWAITING_APPROVAL' }))).toBe('awaiting_approval');
    expect(deriveCampaignLifecycle(row({ task_state: 'completed', approval_decision: 'APPROVED' }))).toBe('approved');
    expect(deriveCampaignLifecycle(row({ task_state: 'completed', approval_decision: 'REJECTED' }))).toBe('rejected');
    const brandAudit = row({
      task_state: 'running',
      task_payload: {
        signal: {
          payload: { module: 'marketing', stage: 'brand_audit' },
        },
      },
    });
    expect(deriveCampaignLifecycle(brandAudit)).toBe('brand_review');
    expect(deriveCampaignLifecycle(row({ task_state: 'stopped' }))).toBe('cancelled');
  });


  it('projects failed tasks to failed with a reason key', () => {
    expect(toCampaignProjection(row({
      task_state: 'failed',
      task_error: { code: 'PROVIDER_UNAVAILABLE', message: 'private detail' },
    }))).toMatchObject({
      name: 'Known campaign name',
      audience_count: 14,
      status: 'failed',
      failure_reason_key: 'PROVIDER_UNAVAILABLE',
    });
  });

  it('never advertises dispatch integration', () => {
    expect(toCampaignProjection(row()).dispatch).toEqual({ status: 'NOT_INTEGRATED' });
  });
});
