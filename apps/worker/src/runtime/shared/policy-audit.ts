/**
 * @file Policy Audit and Engine Wiring (implement/04 §3.2, implement/08 §1.2, §7.1).
 *
 * Implements domain-neutral policy audit mapping and engine creation bound to the durable
 * audit boundary (IAuditTrail / AuditRepository).
 */

import type {
  AgentRunLogRecord,
  IAuditTrail,
} from '@agentos/core-engine/contracts';
import type {
  PolicyAuditPort,
  PolicyAuditRecord,
} from '@agentos/core-engine';
import type {
  AuditRecordInput,
  AuditRepository,
  ExecutionStatus,
} from '@agentos/database';
export type DurableAuditSinkTarget =
  | IAuditTrail
  | AuditRepository
  | { append(record: AgentRunLogRecord | AuditRecordInput): Promise<void> };

/**
 * Maps a canonical PEP decision intent (PolicyAuditRecord) onto the repository-native
 * AuditRecordInput / AgentRunLogRecord, preserving tenant, run, correlation, skill, authority,
 * effect, payload binding, and signed audit semantics.
 */
export function mapPolicyAuditRecordToAuditInput(
  record: PolicyAuditRecord,
): AuditRecordInput & AgentRunLogRecord {
  const timestamp =
    record.occurred_at && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.occurred_at)
      ? record.occurred_at
      : new Date(record.occurred_at || Date.now()).toISOString();

  let execution_status: ExecutionStatus;
  if (record.verdict === 'AUTO_APPROVED' || record.verdict === 'AWAITING_HUMAN_APPROVAL') {
    execution_status = 'pending';
  } else {
    execution_status = 'denied';
  }

  const authority = record.authority ?? 'AUTH-0';
  const correlationId = (record.correlation_id && record.correlation_id.trim().length > 0)
    ? record.correlation_id.trim()
    : record.run_id;

  return {
    run_id: record.run_id,
    tenant_id: record.tenant_id,
    agent_id: record.agent_id,
    customer_or_entity_id: correlationId.slice(0, 64),
    trigger: 'policy_enforcement',
    context: {
      correlation_id: record.correlation_id,
      rule_id: record.rule_id,
      error_code: record.error_code,
      payload_sha256: record.payload_sha256,
    },
    skill: record.skill_id,
    step_index: 0,
    tool: record.tool_name,
    decision: {
      verdict: record.verdict,
      decision_code: record.decision_code,
      rule_id: record.rule_id,
      error_code: record.error_code,
      authority: record.authority,
    },
    authority,
    approval: record.approval_id !== null ? { approval_id: record.approval_id } : null,
    action: {
      tool_name: record.tool_name,
      skill_id: record.skill_id,
      payload_sha256: record.payload_sha256,
      effect_key: record.effect_key,
    },
    execution_status,
    evidence: record.payload_sha256 !== null
      ? {
          payload_sha256: record.payload_sha256,
          rule_id: record.rule_id,
          error_code: record.error_code,
        }
      : {
          rule_id: record.rule_id,
          error_code: record.error_code,
        },
    outcome: record.verdict,
    latency_ms: 0,
    cost: { prompt: 0, completion: 0, total_cost_usd: 0 },
    error: record.error_code !== null
      ? { code: record.error_code, rule_id: record.rule_id }
      : null,
    timestamp,
    started_at: timestamp,
    completed_at: timestamp,
  };
}

/**
 * Creates an append-only PolicyAuditPort adapter that binds the PolicyEnforcementPoint to
 * the existing durable audit boundary (IAuditTrail or AuditRepository).
 */
export function createPolicyAuditSink(
  target: DurableAuditSinkTarget,
): PolicyAuditPort {
  return {
    async append(record: PolicyAuditRecord): Promise<void> {
      const mapped = mapPolicyAuditRecordToAuditInput(record);
      await target.append(mapped);
    },
  };
}
