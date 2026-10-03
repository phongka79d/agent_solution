import { describe, expect, it } from 'vitest';
import type { HydratedContext } from '@agentos/core-engine/contracts';
import { SalesAdvisorExecutionState } from './advisor-adapters.js';

describe('SalesAdvisorExecutionState', () => {
  it('rehydrates advisor requirements and observations from checkpoint context in a fresh instance', () => {
    const context: HydratedContext = {
      correlation_id: 'corr-advisor-reclaim',
      tenant_id: '11111111-1111-4111-8111-111111111111',
      customer: null,
      working_memory: {
        session_id: 'session-advisor-reclaim',
        last_touch_channel: 'web',
        turn_count: 1,
        takeover_active: false,
      },
      knowledge_citations: [],
      hydrated_at: '2026-10-01T00:00:00.000Z',
    };
    const requirements = {
      category: 'accessories',
      budget: { amount: 100, currency: 'TWD' },
      use_case: 'travel',
      product_eligibility: { sku: 'SKU-HINT', category: 'portable' },
    };
    const advisor = new SalesAdvisorExecutionState();
    advisor.setRequirements(context, requirements);
    advisor.recordCandidateSku(context, 'SKU-VERIFIED');
    advisor.recordStock(context, 'SKU-VERIFIED', 4);
    context.run_state!.sales!.lexicon = { recommendation: ['recommend'] };

    const checkpointContext = JSON.parse(JSON.stringify(context)) as HydratedContext;
    const reclaimedAdvisor = new SalesAdvisorExecutionState();

    expect(reclaimedAdvisor.requirementsFor(checkpointContext)).toEqual(requirements);
    expect(reclaimedAdvisor.candidateSkuFor(checkpointContext)).toBe('SKU-VERIFIED');
    expect(reclaimedAdvisor.stockFor(checkpointContext, 'SKU-VERIFIED')).toBe(4);
    expect(checkpointContext.run_state?.sales?.lexicon).toEqual({ recommendation: ['recommend'] });
  });
});
