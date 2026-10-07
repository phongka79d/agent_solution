import { describe, expect, it } from 'vitest';

import {
  GENESIS_HASH,
  evidenceChainHash,
  signEvidenceChainHash,
  type EvidenceRepository,
  type ImmutableEvidenceRecord,
} from '@agentos/database';
import {
  sha256CanonicalJson,
  type ExecutionReceipt,
  type HydratedContext,
  type PlannedStep,
} from '@agentos/core-engine';

import { createDurableAdapters, DEFAULT_PLAN_INPUT_RESOLVER } from './adapters.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const RUN_ID = 'run-receipt-bridge';
const OTHER_RUN_ID = 'run-other';
const CORRELATION_ID = 'correlation-receipt-bridge';
const EFFECT_KEY = 'effect-receipt-bridge';
const SECRET = 'receipt-bridge-test-audit-secret-that-is-long-enough';
const STEP_INDEX = 1;

const SUCCESS_RECEIPT: ExecutionReceipt = {
  execution_id: 'execution-bridge-1',
  adapter_status: 'SUCCESS',
  provider_reference: 'provider-bridge-1',
  response_payload: {
    offer: {
      sku: 'NM-L01-BLK',
      price_vnd: 18_900_000,
    },
  },
  latency_ms: 37,
  token_usage: {
    prompt: 12,
    completion: 8,
    total_cost_usd: 0.0042,
  },
};

function signedEvidenceRecord(
  raw_payload: Record<string, unknown>,
  overrides: Partial<ImmutableEvidenceRecord> = {},
): ImmutableEvidenceRecord {
  const payload_sha256 = sha256CanonicalJson(raw_payload);
  const chain_hash = evidenceChainHash({
    previous_evidence_hash: GENESIS_HASH,
    payload_sha256,
    effect_key: EFFECT_KEY,
    step_index: STEP_INDEX,
  });

  return {
    evidence_id: 'evidence-receipt-bridge-1',
    run_id: RUN_ID,
    tenant_id: TENANT,
    correlation_id: CORRELATION_ID,
    step_index: STEP_INDEX,
    effect_key: EFFECT_KEY,
    previous_evidence_hash: GENESIS_HASH,
    payload_sha256,
    chain_hash,
    signature: signEvidenceChainHash(chain_hash, SECRET),
    raw_payload,
    created_at: '2026-09-28T00:00:00.000Z',
    ...overrides,
  };
}

function createEvidenceRepository(records: readonly ImmutableEvidenceRecord[]): {
  readonly repository: EvidenceRepository;
  readonly reads: Array<{ tenant_id: string; run_id: string }>;
} {
  const reads: Array<{ tenant_id: string; run_id: string }> = [];
  const repository = {
    readEvidenceChain: async (tenant_id: string, run_id: string) => {
      reads.push({ tenant_id, run_id });
      return records;
    },
  } as unknown as EvidenceRepository;

  return { repository, reads };
}

function createAdapters(evidenceRepository: EvidenceRepository) {
  const adapters = createDurableAdapters({
    workflowRepository: {} as never,
    approvalRepository: {} as never,
    evidenceRepository,
    auditRepository: {} as never,
    conversationRepository: {} as never,
    auditSecret: SECRET,
  });
  const findImmutableRecord = adapters.evidenceLogger.findImmutableRecord;
  if (findImmutableRecord === undefined) {
    throw new Error('TEST_FIXTURE_MISSING_RECEIPT_LOOKUP');
  }
  return {
    ...adapters,
    evidenceLogger: {
      ...adapters.evidenceLogger,
      findImmutableRecord,
    },
  };
}

describe('createDurableAdapters production receipt bridge', () => {
  it('projects a valid signed raw_payload receipt through evidenceLogger.findImmutableRecord', async () => {
    const record = signedEvidenceRecord({
      action: { sku: 'NM-L01-BLK' },
      receipt: SUCCESS_RECEIPT,
      replayed: false,
    });
    const { repository, reads } = createEvidenceRepository([record]);
    const adapters = createAdapters(repository);

    const projected = await adapters.evidenceLogger.findImmutableRecord({
      tenant_id: TENANT,
      run_id: RUN_ID,
      effect_key: EFFECT_KEY,
      step_index: STEP_INDEX,
    });

    expect(reads).toEqual([{ tenant_id: TENANT, run_id: RUN_ID }]);
    expect(projected).toMatchObject({
      evidence_id: record.evidence_id,
      tenant_id: TENANT,
      run_id: RUN_ID,
      step_index: STEP_INDEX,
      effect_key: EFFECT_KEY,
      receipt: SUCCESS_RECEIPT,
    });
    expect(projected).not.toHaveProperty('raw_payload');
  });

  it('refuses a receipt chain returned for another tenant or run', async () => {
    const record = signedEvidenceRecord({ receipt: SUCCESS_RECEIPT });
    const { repository } = createEvidenceRepository([record]);
    const adapters = createAdapters(repository);

    await expect(
      adapters.evidenceLogger.findImmutableRecord({
        tenant_id: OTHER_TENANT,
        run_id: RUN_ID,
        effect_key: EFFECT_KEY,
        step_index: STEP_INDEX,
      }),
    ).rejects.toMatchObject({ code: 'INPUT_BINDING_RECEIPT_INVALID' });

    await expect(
      adapters.evidenceLogger.findImmutableRecord({
        tenant_id: TENANT,
        run_id: OTHER_RUN_ID,
        effect_key: EFFECT_KEY,
        step_index: STEP_INDEX,
      }),
    ).rejects.toMatchObject({ code: 'INPUT_BINDING_RECEIPT_INVALID' });
  });

  it('refuses a lookup with the wrong effect and a raw payload tampered after signing', async () => {
    const record = signedEvidenceRecord({ receipt: SUCCESS_RECEIPT });
    const { repository } = createEvidenceRepository([record]);
    const adapters = createAdapters(repository);

    await expect(
      adapters.evidenceLogger.findImmutableRecord({
        tenant_id: TENANT,
        run_id: RUN_ID,
        effect_key: 'effect-not-in-chain',
        step_index: STEP_INDEX,
      }),
    ).resolves.toBeNull();

    const tampered = {
      ...record,
      raw_payload: {
        receipt: {
          ...SUCCESS_RECEIPT,
          response_payload: { offer: { sku: 'NM-TAMPERED' } },
        },
      },
    };
    const tamperedRepo = createEvidenceRepository([tampered]);
    const tamperedAdapters = createAdapters(tamperedRepo.repository);

    await expect(
      tamperedAdapters.evidenceLogger.findImmutableRecord({
        tenant_id: TENANT,
        run_id: RUN_ID,
        effect_key: EFFECT_KEY,
        step_index: STEP_INDEX,
      }),
    ).rejects.toMatchObject({ code: 'INPUT_BINDING_RECEIPT_INVALID' });
  });

  it.each([
    ['missing receipt', { action: { sku: 'NM-L01-BLK' } }],
    [
      'non-success receipt',
      {
        receipt: {
          ...SUCCESS_RECEIPT,
          adapter_status: 'ERROR',
        },
      },
    ],
  ] as const)('refuses a %s in verified raw_payload', async (_label, raw_payload) => {
    const record = signedEvidenceRecord(raw_payload);
    const { repository } = createEvidenceRepository([record]);
    const adapters = createAdapters(repository);

    await expect(
      adapters.evidenceLogger.findImmutableRecord({
        tenant_id: TENANT,
        run_id: RUN_ID,
        effect_key: EFFECT_KEY,
        step_index: STEP_INDEX,
      }),
    ).rejects.toMatchObject({ code: 'INPUT_BINDING_RECEIPT_INVALID' });
  });
});

describe('DEFAULT_PLAN_INPUT_RESOLVER production response bindings', () => {
  const context = {} as HydratedContext;
  const step = (response_path: string): PlannedStep => ({
    step_index: 2,
    agent_id: 'SAL-01',
    skill_id: 'skill.sales.send_message',
    adapter_target: 'local-chat-outbox',
    input_parameters: {},
    required_authority: 'AUTH-1',
    mutating: false,
    price_bearing: false,
    idempotent: true,
    timeout_ms: 1_000,
    depends_on_steps: [STEP_INDEX],
    input_bindings: {
      verified_sku: {
        source_step_index: STEP_INDEX,
        response_path,
      },
    },
  });

  it('maps a declared nested response field from the adapter returned by createDurableAdapters', async () => {
    const adapters = createAdapters(createEvidenceRepository([]).repository);

    const resolved = await adapters.planInputResolver.resolve({
      tenant_id: TENANT,
      run_id: RUN_ID,
      step: step('offer.sku'),
      previous_receipts: { [String(STEP_INDEX)]: SUCCESS_RECEIPT },
      context,
    });

    expect(resolved).toEqual({ verified_sku: 'NM-L01-BLK' });
    expect(adapters.planInputResolver).toBe(DEFAULT_PLAN_INPUT_RESOLVER);
  });

  it('refuses a declared response path that is missing from the receipt', async () => {
    const adapters = createAdapters(createEvidenceRepository([]).repository);

    await expect(
      adapters.planInputResolver.resolve({
        tenant_id: TENANT,
        run_id: RUN_ID,
        step: step('offer.missing'),
        previous_receipts: { [String(STEP_INDEX)]: SUCCESS_RECEIPT },
        context,
      }),
    ).rejects.toMatchObject({ code: 'INPUT_BINDING_RESPONSE_PATH_MISSING' });
  });
});
