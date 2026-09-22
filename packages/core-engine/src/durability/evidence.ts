/**
 * @file Cryptographic evidence and audit chaining (implement/04 §6.1, implement/08 §4.1-§4.2).
 *
 * Two chains, two scopes, one byte contract:
 *
 *   * **Evidence — per run** (§04 §6.1, `evidence_records`). `payload_sha256` digests the RFC 8785
 *     canonical payload, `chain_hash` is
 *     `SHA-256(previous_evidence_hash | payload_sha256 | effect_key | step_index)` — the `'0' × 64`
 *     {@link GENESIS_HASH} is the predecessor of a run's first record — and `signature` is
 *     HMAC-SHA256 over `chain_hash`, so a row cannot be forged without the audit secret.
 *   * **Audit — per tenant** (§08 §4.2, `audit_records`). `chain_hash` is
 *     `SHA-256(prev_hash | CanonicalJSON(payload) | timestamp)`, where `payload` is the sanitized
 *     18-field compliance projection ({@link buildAuditPayload}) that excludes `id`, `prev_hash`,
 *     `chain_hash` and the event time. Chains are partitioned per tenant and serialized by the
 *     writer; two distinct children of one predecessor are prevented there, not here.
 *
 * Everything is UTC and self-contained: no wall-clock value ever enters a digest except the audit
 * event time, which the writer hashes exactly as it stores it (UTC ISO-8601 with milliseconds).
 * Sealing is fail-closed — without `AUDIT_HMAC_SECRET` no evidence record can be built at all,
 * because an unsigned audit chain is not an audit chain.
 */

import {
  type AgentRunLogRecord,
  GENESIS_HASH,
  type ImmutableEvidenceRecord,
  OrchestratorError,
} from '../contracts/types.js';
import {
  canonicalizeJson,
  hmacSha256Hex,
  isSha256Hex,
  sha256CanonicalJson,
  sha256Hex,
} from './canonical-json.js';

/** Environment variable holding the audit signing secret (§08 §4.2, §01 secrets table). */
export const AUDIT_HMAC_SECRET_ENV = 'AUDIT_HMAC_SECRET';

/**
 * The audit event time as both writer and verifier must serialize it: UTC ISO-8601 with
 * millisecond precision. Any other rendering (a local offset, seconds-only precision, microseconds
 * read back from `TIMESTAMPTZ`) would hash different bytes than the ones stored, so it is refused.
 */
const AUDIT_TIMESTAMP_UTC_ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Resolves the audit signing secret and fails closed when it is absent (§04 §6.1 step 3, §08
 * "every row's HMAC verifies with the injected secret").
 *
 * @param secret - Explicit secret; when omitted the process environment is read once.
 * @returns The secret to sign with.
 * @throws OrchestratorError `AUDIT_SECRET_MISSING` when no secret is configured. The value itself is
 *   never echoed into the message.
 */
export function requireAuditHmacSecret(secret?: string): string {
  const resolved = secret ?? process.env[AUDIT_HMAC_SECRET_ENV];

  if (typeof resolved !== 'string' || resolved.trim().length === 0) {
    throw new OrchestratorError(
      'AUDIT_SECRET_MISSING',
      'AUDIT_HMAC_SECRET is required to sign evidence records (NFR-002).',
    );
  }

  return resolved;
}

/**
 * Extends the per-run evidence chain (§04 §6.1 step 2).
 *
 * @param params.previous_evidence_hash - Predecessor's `chain_hash`; {@link GENESIS_HASH} for the
 *   first record of a run.
 * @param params.payload_sha256 - Digest of the canonical payload.
 * @param params.effect_key - Deterministic key of the step that produced the record.
 * @param params.step_index - Step ordinal inside the run.
 * @returns `chain_hash` as 64 lower-case hexadecimal characters.
 * @throws OrchestratorError `EVIDENCE_INPUT_INVALID` when a digest input is not a SHA-256 digest or
 *   the step ordinal is not a non-negative integer.
 */
export function evidenceChainHash(params: {
  previous_evidence_hash: string;
  payload_sha256: string;
  effect_key: string;
  step_index: number;
}): string {
  if (!isSha256Hex(params.previous_evidence_hash)) {
    throw new OrchestratorError(
      'EVIDENCE_INPUT_INVALID',
      'previous_evidence_hash must be a 64-character lower-case SHA-256 digest (GENESIS_HASH for '
        + `the first record of a run); received ${params.previous_evidence_hash}.`,
    );
  }

  if (!isSha256Hex(params.payload_sha256)) {
    throw new OrchestratorError(
      'EVIDENCE_INPUT_INVALID',
      `payload_sha256 must be a 64-character lower-case SHA-256 digest; received ${params.payload_sha256}.`,
    );
  }

  if (params.effect_key.trim().length === 0) {
    throw new OrchestratorError(
      'EVIDENCE_INPUT_INVALID',
      'evidence cannot be chained without the effect_key that binds the record to one action (BR-010).',
    );
  }

  if (!Number.isInteger(params.step_index) || params.step_index < 0) {
    throw new OrchestratorError(
      'EVIDENCE_INPUT_INVALID',
      `step_index must be a non-negative integer; received ${String(params.step_index)}.`,
    );
  }

  return sha256Hex(
    `${params.previous_evidence_hash}|${params.payload_sha256}|${params.effect_key}|${params.step_index}`,
  );
}

/**
 * Signs an evidence chain hash with HMAC-SHA256 (§04 §6.1 step 3, non-repudiation).
 *
 * @param chain_hash - The `chain_hash` to sign.
 * @param secret - Explicit secret; when omitted the process environment is read once.
 * @returns The `signature` column value: 64 lower-case hexadecimal characters.
 * @throws OrchestratorError `EVIDENCE_INPUT_INVALID` for a malformed `chain_hash`, or
 *   `AUDIT_SECRET_MISSING` when no signing secret is configured.
 */
export function signEvidenceChainHash(chain_hash: string, secret?: string): string {
  if (!isSha256Hex(chain_hash)) {
    throw new OrchestratorError(
      'EVIDENCE_INPUT_INVALID',
      `chain_hash must be a 64-character lower-case SHA-256 digest; received ${chain_hash}.`,
    );
  }

  return hmacSha256Hex(requireAuditHmacSecret(secret), chain_hash);
}

/**
 * Builds one complete, signed, chained evidence record (§04 §6.1). Pure: it neither reads the clock
 * nor opens a connection, so the same inputs reproduce the same row bytes anywhere.
 *
 * @param params.tenant_id - Tenant owning the run.
 * @param params.run_id - Run the evidence belongs to.
 * @param params.correlation_id - Trace identity carried across all stages.
 * @param params.step_index - Step ordinal inside the run.
 * @param params.effect_key - Deterministic key of the reserved effect.
 * @param params.payload - Payload about to be recorded; the provider receipt is recorded verbatim.
 * @param params.previous_evidence_hash - Predecessor's `chain_hash`; defaults to
 *   {@link GENESIS_HASH}, the predecessor of a run's first record.
 * @param params.secret - Explicit signing secret; when omitted the environment is read.
 * @param params.created_at - Record timestamp; defaults to the current UTC instant.
 * @returns The immutable record: `evidence_id` is derived from the run identity, `payload_sha256`
 *   and `chain_hash` from the canonical bytes, `signature` from the secret.
 * @throws OrchestratorError `AUDIT_SECRET_MISSING` when no signing secret is configured, or
 *   `CANONICAL_JSON_INVALID` when the payload is not canonicalizable.
 */
export function createEvidenceChainLink(params: {
  tenant_id: string;
  run_id: string;
  correlation_id: string;
  step_index: number;
  effect_key: string;
  payload: Record<string, unknown>;
  previous_evidence_hash?: string;
  secret?: string;
  created_at?: string;
}): ImmutableEvidenceRecord {
  const previousEvidenceHash = params.previous_evidence_hash ?? GENESIS_HASH;
  const payloadSha256 = sha256CanonicalJson(params.payload);
  const chainHash = evidenceChainHash({
    previous_evidence_hash: previousEvidenceHash,
    payload_sha256: payloadSha256,
    effect_key: params.effect_key,
    step_index: params.step_index,
  });

  return {
    evidence_id: `ev_${sha256Hex(
      `${params.tenant_id}|${params.run_id}|${params.effect_key}|${params.step_index}`,
    ).slice(0, 16)}`,
    run_id: params.run_id,
    tenant_id: params.tenant_id,
    correlation_id: params.correlation_id,
    step_index: params.step_index,
    effect_key: params.effect_key,
    previous_evidence_hash: previousEvidenceHash,
    payload_sha256: payloadSha256,
    chain_hash: chainHash,
    signature: signEvidenceChainHash(chainHash, params.secret),
    created_at: params.created_at ?? new Date().toISOString(),
  };
}

/**
 * Projects an `AgentRunLogRecord` onto the hashed audit payload (§08 §4.2): the 18 mapped fields
 * (`run_id` .. `error`, `tenant_id` included) and nothing else. The operational `step_index` and the
 * `started_at` / `completed_at` renderings of the event time are deliberately absent — `audit_records`
 * stores no `step_index`, and the event time enters the hash through the `timestamp` argument.
 *
 * @param record - The canonical run record about to be appended.
 * @returns The exact value to pass as `payload` to {@link auditChainHash}.
 */
export function buildAuditPayload(record: AgentRunLogRecord): Record<string, unknown> {
  return {
    run_id: record.run_id,
    tenant_id: record.tenant_id,
    agent_id: record.agent_id,
    customer_or_entity_id: record.customer_or_entity_id,
    trigger: record.trigger,
    context: record.context,
    skill: record.skill,
    tool: record.tool,
    decision: record.decision,
    authority: record.authority,
    approval: record.approval,
    action: record.action,
    execution_status: record.execution_status,
    evidence: record.evidence,
    outcome: record.outcome,
    latency_ms: record.latency_ms,
    cost: record.cost,
    error: record.error,
  };
}

/**
 * Extends the per-tenant audit chain (§08 §4.2) over the UTF-8 byte contract
 * `prev_hash + "|" + CanonicalJSON(payload) + "|" + timestamp`.
 *
 * The chain is partitioned per tenant: `prev_hash` is the same tenant's immediately preceding
 * `chain_hash`, or {@link GENESIS_HASH} for that tenant's first record. Serializing the append is
 * the writer's duty (the `UNIQUE (tenant_id, chain_hash)` constraint detects duplicates but cannot
 * prevent two distinct children of one predecessor).
 *
 * @param params.prev_hash - Tenant predecessor hash.
 * @param params.payload - Sanitized payload; use {@link buildAuditPayload}.
 * @param params.timestamp - Audit event time as the writer stores it: UTC ISO-8601 with
 *   milliseconds.
 * @returns `chain_hash` as 64 lower-case hexadecimal characters.
 * @throws OrchestratorError `AUDIT_INPUT_INVALID` for a malformed predecessor hash or timestamp,
 *   or `CANONICAL_JSON_INVALID` when the payload is not canonicalizable.
 */
export function auditChainHash(params: {
  prev_hash: string;
  payload: Record<string, unknown>;
  timestamp: string;
}): string {
  if (!isSha256Hex(params.prev_hash)) {
    throw new OrchestratorError(
      'AUDIT_INPUT_INVALID',
      'prev_hash must be a 64-character lower-case SHA-256 digest (GENESIS_HASH for the first '
        + `record of a tenant chain); received ${params.prev_hash}.`,
    );
  }

  if (!AUDIT_TIMESTAMP_UTC_ISO_MS.test(params.timestamp)) {
    throw new OrchestratorError(
      'AUDIT_INPUT_INVALID',
      `timestamp must be UTC ISO-8601 with milliseconds (YYYY-MM-DDTHH:MM:SS.sssZ) so writer and `
        + `verifier hash identical bytes; received ${params.timestamp}.`,
    );
  }

  return sha256Hex(`${params.prev_hash}|${canonicalizeJson(params.payload)}|${params.timestamp}`);
}
