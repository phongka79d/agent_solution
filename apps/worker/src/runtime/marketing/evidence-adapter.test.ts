import { describe, expect, it, vi } from 'vitest';
import type { ImmutableEvidenceRecord } from '@agentos/database';
import type { MarketingEvidence, MarketingInvocationContext } from './contracts.js';
import { createMarketingEvidencePort, type AppendCanonicalEvidence } from './evidence-adapter.js';

const CONTEXT: MarketingInvocationContext = {
  tenant_id: 'tenant-1',
  run_id: 'run-1',
  correlation_id: 'correlation-1',
  request_id: 'request-1',
  step_index: 1,
  action_revision: 1,
  caller_agent: 'MKT-01',
  granted_authority: 'AUTH-1',
};

const EVIDENCE: MarketingEvidence = {
  evidence_id: 'evidence-1',
  tenant_id: CONTEXT.tenant_id,
  run_id: CONTEXT.run_id,
  correlation_id: CONTEXT.correlation_id,
  effect_key: 'effect-1',
  classification: 'FACT',
  source_uri: 'research://source-1',
  source_version: 'v1',
  claim: 'Observed search-volume growth.',
};

describe('createMarketingEvidencePort', () => {
  it('rejects duplicate evidence IDs before persisting the bundle', async () => {
    const append: AppendCanonicalEvidence = vi.fn(async () => ({
      evidence_id: 'persisted-1',
    }) as ImmutableEvidenceRecord);
    const port = createMarketingEvidencePort({ append });

    await expect(
      port.append([EVIDENCE, { ...EVIDENCE, claim: 'A second claim.' }], CONTEXT, 'effect-1'),
    ).rejects.toMatchObject({ code: 'EVIDENCE_DUPLICATE_ID' });
    expect(append).not.toHaveBeenCalled();
  });
});
