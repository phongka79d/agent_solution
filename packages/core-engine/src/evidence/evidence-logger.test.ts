/**
 * @file Evidence chain tests (§6.1–§6.2): the digest/chain/signature formulas reproduced
 * independently, chain linking from `GENESIS_HASH`, the fail-closed secret contract (including the
 * absence of a `process.env` fallback), append-only Agent Run rows and the unique outcome watcher.
 */

import { createHash, createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { OrchestratorError, GENESIS_HASH, type AgentRunLogRecord } from '../contracts/types.js';
import { canonicalizeJson } from '../effects/canonical-json.js';
import { MemoryEvidenceLogger } from './evidence-logger.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const RUN = 'run_evidence_1';
const SECRET = 'audit-test-secret-not-a-production-value';

const RUN_LOG: AgentRunLogRecord = {
  run_id: RUN,
  tenant_id: TENANT,
  agent_id: 'MKT-01',
  customer_or_entity_id: 'cust_1',
  trigger: 'inbound.line.message',
  context: { session_id: 'sess_1' },
  skill: 'SKL_CART_RECOVERY',
  step_index: 1,
  tool: 'adapter.line.push',
  decision: { skill_id: 'SKL_CART_RECOVERY' },
  authority: 'AUTH-3',
  approval: null,
  action: { effect_key: 'effect_key_1' },
  execution_status: 'success',
  evidence: { evidence_id: 'ev_1' },
  outcome: null,
  latency_ms: 120,
  cost: { total_cost_usd: 0.001 },
  error: null,
  started_at: '2026-09-22T00:00:00.000Z',
  completed_at: '2026-09-22T00:00:00.120Z',
};

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

describe('MemoryEvidenceLogger chain', () => {
  it('links each record to its predecessor, starting from GENESIS_HASH', async () => {
    const logger = new MemoryEvidenceLogger(SECRET);
    const firstPayload = { action: { skill_id: 'SKL_CART_RECOVERY' }, receipt: null, replayed: false };
    const secondPayload = { action: { skill_id: 'SKL_CART_RECOVERY' }, receipt: { id: 'rcpt_1' }, replayed: false };

    const first = await logger.createImmutableRecord({
      run_id: RUN,
      tenant_id: TENANT,
      correlation_id: 'corr_1',
      step_index: 1,
      effect_key: 'effect_key_1',
      previous_evidence_hash: GENESIS_HASH,
      payload: firstPayload,
    });

    const firstRaw = canonicalizeJson(firstPayload);
    expect(GENESIS_HASH).toBe('0'.repeat(64));
    expect(first.previous_evidence_hash).toBe(GENESIS_HASH);
    expect(first.payload_sha256).toBe(sha256Hex(firstRaw));
    expect(first.chain_hash).toBe(
      sha256Hex(`${GENESIS_HASH}|${first.payload_sha256}|effect_key_1|1`),
    );
    expect(first.signature).toBe(createHmac('sha256', SECRET).update(first.chain_hash, 'utf8').digest('hex'));
    expect(first.evidence_id).toBe(`ev_${sha256Hex(`${TENANT}|${RUN}|effect_key_1|1`).slice(0, 16)}`);

    const second = await logger.createImmutableRecord({
      run_id: RUN,
      tenant_id: TENANT,
      correlation_id: 'corr_1',
      step_index: 2,
      effect_key: 'effect_key_2',
      previous_evidence_hash: first.chain_hash,
      payload: secondPayload,
    });

    expect(second.previous_evidence_hash).toBe(first.chain_hash);
    expect(second.chain_hash).toBe(
      sha256Hex(`${first.chain_hash}|${second.payload_sha256}|effect_key_2|2`),
    );
    expect(second.chain_hash).not.toBe(first.chain_hash);

    const stored = logger.listEvidence(TENANT, RUN);
    expect(stored.map((record) => record.chain_hash)).toEqual([first.chain_hash, second.chain_hash]);
    expect(stored[0]?.raw_payload).toBe(firstRaw);
    expect(logger.listEvidence(OTHER_TENANT, RUN)).toHaveLength(0);
  });

  it('binds the digest to the payload bytes, so a changed payload breaks the chain', async () => {
    const logger = new MemoryEvidenceLogger(SECRET);
    const payload = { action: { discount_percent: 0 }, replayed: false };

    const record = await logger.createImmutableRecord({
      run_id: RUN,
      tenant_id: TENANT,
      correlation_id: 'corr_1',
      step_index: 1,
      effect_key: 'effect_key_1',
      previous_evidence_hash: GENESIS_HASH,
      payload,
    });

    const tampered = sha256Hex(canonicalizeJson({ action: { discount_percent: 5 }, replayed: false }));
    expect(record.payload_sha256).not.toBe(tampered);
    expect(record.payload_sha256).toBe(sha256Hex(canonicalizeJson(payload)));
  });

  it('fails closed without a secret and never reads one from the environment', async () => {
    const previous = process.env.AUDIT_HMAC_SECRET;
    process.env.AUDIT_HMAC_SECRET = 'environment-secret-that-must-be-ignored';
    try {
      const logger = new MemoryEvidenceLogger('');
      let thrown: unknown;
      try {
        await logger.createImmutableRecord({
          run_id: RUN,
          tenant_id: TENANT,
          correlation_id: 'corr_1',
          step_index: 1,
          effect_key: 'effect_key_1',
          previous_evidence_hash: GENESIS_HASH,
          payload: { action: {} },
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(OrchestratorError);
      expect((thrown as OrchestratorError).code).toBe('AUDIT_SECRET_MISSING');
      expect(logger.listEvidence(TENANT, RUN)).toHaveLength(0);
    } finally {
      if (previous === undefined) {
        delete process.env.AUDIT_HMAC_SECRET;
      } else {
        process.env.AUDIT_HMAC_SECRET = previous;
      }
    }
  });

  it('refuses a missing predecessor hash and a payload with no canonical form', async () => {
    const logger = new MemoryEvidenceLogger(SECRET);

    await expect(
      logger.createImmutableRecord({
        run_id: RUN,
        tenant_id: TENANT,
        correlation_id: 'corr_1',
        step_index: 1,
        effect_key: 'effect_key_1',
        previous_evidence_hash: '',
        payload: { action: {} },
      }),
    ).rejects.toThrow(OrchestratorError);

    await expect(
      logger.createImmutableRecord({
        run_id: RUN,
        tenant_id: TENANT,
        correlation_id: 'corr_1',
        step_index: 1,
        effect_key: 'effect_key_1',
        previous_evidence_hash: GENESIS_HASH,
        payload: { callback: () => 'not json' },
      }),
    ).rejects.toThrow(OrchestratorError);

    expect(logger.listEvidence(TENANT, RUN)).toHaveLength(0);
  });
});

describe('MemoryEvidenceLogger appends', () => {
  it('appends one Agent Run row per (tenant, run, skill, step_index)', async () => {
    const logger = new MemoryEvidenceLogger(SECRET);

    await logger.logAgentRun(RUN_LOG);
    let thrown: unknown;
    try {
      await logger.logAgentRun({ ...RUN_LOG });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OrchestratorError);
    expect((thrown as OrchestratorError).code).toBe('EVIDENCE_APPEND_ONLY_VIOLATION');

    await logger.logAgentRun({ ...RUN_LOG, step_index: 2 });
    expect(logger.listAgentRuns(TENANT, RUN).map((row) => row.step_index)).toEqual([1, 2]);
    expect(logger.listAgentRuns(OTHER_TENANT, RUN)).toHaveLength(0);
  });

  it('registers exactly one outcome watcher per (tenant, effect_key)', async () => {
    const nowMs = 1_700_000_000_000;
    const logger = new MemoryEvidenceLogger(SECRET, { now: () => nowMs });

    await logger.initializeOutcomeWatch({
      tenant_id: TENANT,
      run_id: RUN,
      effect_key: 'effect_key_1',
      skill_id: 'SKL_CART_RECOVERY',
    });
    await logger.initializeOutcomeWatch({
      tenant_id: TENANT,
      run_id: 'run_evidence_2',
      effect_key: 'effect_key_1',
      skill_id: 'SKL_CART_RECOVERY',
    });
    await logger.initializeOutcomeWatch({
      tenant_id: OTHER_TENANT,
      run_id: RUN,
      effect_key: 'effect_key_1',
      skill_id: 'SKL_CART_RECOVERY',
    });

    const watch = logger.getOutcomeWatch(TENANT, 'effect_key_1');
    expect(watch?.run_id).toBe(RUN);
    expect(watch?.status).toBe('OBSERVING');
    expect(watch?.created_at).toBe(new Date(nowMs).toISOString());
    expect(watch?.expires_at).toBe(new Date(nowMs + 72 * 60 * 60 * 1000).toISOString());
    expect(logger.getOutcomeWatch(OTHER_TENANT, 'effect_key_1')?.run_id).toBe(RUN);
    expect(logger.getOutcomeWatch(TENANT, 'effect_key_missing')).toBeNull();
  });
});
