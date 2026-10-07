import { describe, expect, it } from 'vitest';

import type { CompanyCrmCampaignRow } from '@agentos/database';
import { deriveCampaignLifecycle, toCampaignProjection } from './campaigns.js';

function row(overrides: Partial<CompanyCrmCampaignRow> = {}): CompanyCrmCampaignRow {
  return {
    campaign_id: null,
    run_id: 'run-1',
    name: null,
    objective: null,
    channels: [],
    campaign_status: 'approved',
    campaign_created_at: null,
    campaign_updated_at: null,
    task_state: 'queued',
    task_payload: { signal: { payload: { module: 'marketing', objective: 'winback' } } },
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
  it('derives lifecycle from persisted task, campaign and approval state', () => {
    expect(deriveCampaignLifecycle(row())).toBe('in_review');
    expect(deriveCampaignLifecycle(row({ task_state: 'awaiting_human', approval_decision: 'PENDING' }))).toBe('awaiting_approval');
    expect(deriveCampaignLifecycle(row({ task_state: 'completed', approval_decision: 'APPROVED' }))).toBe('approved');
    expect(deriveCampaignLifecycle(row({ task_state: 'running', task_payload: { signal: { payload: { module: 'marketing', stage: 'brand_audit' } } } }))).toBe('brand_audit');
    expect(deriveCampaignLifecycle(row({ task_state: 'running', campaign_status: 'IN_FLIGHT' }))).toBe('in_flight');
    expect(deriveCampaignLifecycle(row({ task_state: 'IN_FLIGHT' }))).toBe('in_flight');
  });

  it('never advertises dispatch integration', () => {
    expect(toCampaignProjection(row()).dispatch).toEqual({ status: 'NOT_INTEGRATED' });
  });
});
