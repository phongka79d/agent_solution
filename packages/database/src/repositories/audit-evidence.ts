/**
 * @file Append-only evidence, agent run log and audit persistence (implement/03 §1 DOMAIN 5,
 * implement/04 §6.1, implement/08 §4.1-§4.2).
 *
 * Three tables, three chain rules, one discipline:
 *
 *  * **`agentos.evidence_records` — the tamper-evident chain of one run** (implement/04 §6.1).
 *    `payload_sha256` digests the RFC 8785 canonical `raw_payload`; `chain_hash` is
 *    `SHA-256(previous_evidence_hash | payload_sha256 | effect_key | step_index)`; `signature` is
 *    HMAC-SHA256 over `chain_hash`; `previous_evidence_hash` is the predecessor's `chain_hash`, and
 *    the 64-zero {@link GENESIS_HASH} is the predecessor of a run's first record.
 *  * **`agentos.agent_run_logs` — the operational row of one executed step**, keyed
 *    `(tenant_id, run_id, skill, step_index)`. A step's single row is appended when the step
 *    resolves and is never rewritten, so a second append for the same key is a refusal rather than
 *    a correction.
 *  * **`agentos.audit_records` — the canonical compliance chain of one tenant** (implement/08
 *    §4.1-§4.2). `chain_hash` is `SHA-256(prev_hash | CanonicalJSON(payload) | timestamp)` over the
 *    sanitized 18-field projection built by {@link buildAuditPayload}; the chain is partitioned per
 *    tenant and its genesis `prev_hash` is {@link GENESIS_HASH}.
 *
 * Four rules shape every method below:
 *
 *  * **Append-only.** No statement of this module is an `UPDATE` or a `DELETE`; the migration's
 *    `trg_immutable_evidence_records` / `trg_immutable_agent_run_logs` / `trg_immutable_audit_records`
 *    triggers are the outer guarantee (NFR-002, `0001_gate_p0.sql` section 7). A stored record is
 *    therefore never corrected, only detected: the verifiers below recompute every digest and report
 *    the interior tampering and the missing links they find instead of repairing anything.
 *  * **Tenant-scoped by construction.** Each call opens exactly one `withTenantContext()`
 *    transaction, so the transaction-local `app.current_tenant_id` binding and the `tenant_id`
 *    predicate always agree and RLS (NFR-006) denies an unbound read or write. Reads are reads of one
 *    tenant's chain, so a cross-tenant row can never be linked into the walk.
 *  * **The predecessor is read, never trusted.** An append first takes a transaction-scoped advisory
 *    lock of its chain scope, then reads the durable predecessor from the table and links to the hash
 *    it finds there. A caller's chain cursor is checked against that predecessor instead of being
 *    believed, so a stale cursor is refused rather than allowed to fork the chain. Row locking alone
 *    cannot carry this rule: a row inserted by a concurrent transaction is invisible to a blocked
 *    reader's snapshot, so two writers could each link to the same predecessor. The advisory lock
 *    is held for the whole read-hash-insert-commit sequence, which is what makes the chain linear
 *    (implement/08 §4.2).
 *  * **The bytes hashed are the bytes stored.** Every JSONB column is written as the canonical JSON
 *    text of the value the digest was computed over, and `canonicalizeJson` refuses a value JSON
 *    cannot represent (an absent member, `NaN`, a non-plain object) instead of converting it, so the
 *    writer, the stored row and the verifier cannot disagree about the hashed bytes (implement/04
 *    §6.1 step 1).
 *
 * The digest primitives are local because `packages/database` is a leaf of the package DAG
 * (implement/02 §2) and may not import `@agentos/core-engine`: `canonicalizeJson` /
 * `sha256CanonicalJson` are reused from `./approvals.js`, and the chain formulas are byte-compatible
 * with `durability/evidence.ts`, so a row written here verifies there and the other way round.
 */

import { createHash, createHmac } from 'node:crypto';

import type { QueryResult, QueryResultRow } from 'pg';

import { withTenantContext } from '../rls.js';
import { canonicalizeJson, sha256CanonicalJson } from './approvals.js';
import { assertIdentifier, assertPositiveInteger, isPlainObject } from './durable-workflows.js';
import type { TenantTransactionRunner } from './effect-reservations.js';

/** `agentos` is not on the connection `search_path`, so every statement is schema-qualified. */
const EVIDENCE_RECORDS = 'agentos.evidence_records';
const AGENT_RUN_LOGS = 'agentos.agent_run_logs';
const AUDIT_RECORDS = 'agentos.audit_records';

/** Environment variable holding the audit signing secret (implement/08 §4.2, implement/01 secrets). */
export const AUDIT_HMAC_SECRET_ENV = 'AUDIT_HMAC_SECRET';

/** Genesis chain link: the predecessor of a scope's first record (implement/08 §4.1 `prev_hash`). */
export const GENESIS_HASH = '0'.repeat(64);

/** Bare lowercase hex SHA-256: the only accepted encoding of every digest and HMAC column here. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * The audit event time as both writer and verifier must serialize it: UTC ISO-8601 with millisecond
 * precision. Any other rendering (a local offset, seconds-only precision, microseconds read back
 * from `TIMESTAMPTZ`) would hash different bytes than the ones stored, so it is refused.
 */
const AUDIT_TIMESTAMP_UTC_ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The six values `agent_run_logs.execution_status` / `audit_records.execution_status` accept. */
export const EXECUTION_STATUSES = [
  'pending',
  'executing',
  'success',
  'failed',
  'denied',
  'aborted',
] as const;

export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

/** The six values `agent_run_logs.authority` / `audit_records.authority` carry (SRS §12). */
export const AUTHORITY_LEVELS = [
  'AUTH-0',
  'AUTH-1',
  'AUTH-2',
  'AUTH-3',
  'AUTH-4',
  'AUTH-5',
] as const;

export type AuthorityLevel = (typeof AUTHORITY_LEVELS)[number];

/**
 * The columns every evidence read publishes, so `SELECT` and `INSERT ... RETURNING` cannot drift
 * apart. `created_at` is a database-generated instant; the chain covers no wall-clock value.
 */
const EVIDENCE_PROJECTION = `
      evidence_id,
      tenant_id,
      run_id,
      correlation_id,
      step_index,
      effect_key,
      previous_evidence_hash,
      payload_sha256,
      chain_hash,
      signature,
      raw_payload,
      created_at`;

/** The 18 mapped run fields plus the operational `step_index` and the three timestamps. */
const RUN_LOG_PROJECTION = `
      tenant_id,
      run_id,
      agent_id,
      customer_or_entity_id,
      trigger,
      context,
      skill,
      step_index,
      tool,
      decision,
      authority,
      approval,
      action,
      execution_status,
      evidence,
      outcome,
      latency_ms,
      cost,
      error,
      started_at,
      completed_at,
      created_at`;

/**
 * The columns the chained audit read publishes. `timestamp` is quoted because it is a reserved
 * word, exactly as the migration quotes it.
 */
const AUDIT_PROJECTION = `
      id,
      run_id,
      tenant_id,
      agent_id,
      customer_or_entity_id,
      trigger,
      context,
      skill,
      tool,
      decision,
      authority,
      approval,
      action,
      execution_status,
      evidence,
      outcome,
      latency_ms,
      cost,
      error,
      "timestamp",
      prev_hash,
      chain_hash`;

/**
 * Serializes every append of one chain scope for the rest of the transaction: the key is derived
 * in-database (`hashtext`) from the table name and the scope identity, so every process — and every
 * language — derives the same lock without sharing a hash function (implement/08 §4.2).
 */
const LOCK_CHAIN_SCOPE = 'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))';

/**
 * `created_at` is omitted so the durable column default (`CURRENT_TIMESTAMP`) stays the single
 * source of that instant; a caller that owns the instant passes it and the `COALESCE` uses it.
 */
const INSERT_EVIDENCE_RECORD = `INSERT INTO ${EVIDENCE_RECORDS} (
      evidence_id,
      tenant_id,
      run_id,
      correlation_id,
      step_index,
      effect_key,
      previous_evidence_hash,
      payload_sha256,
      chain_hash,
      signature,
      raw_payload,
      created_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, COALESCE($12::timestamptz, CURRENT_TIMESTAMP)
    )
    RETURNING${EVIDENCE_PROJECTION}`;

const INSERT_AGENT_RUN_LOG = `INSERT INTO ${AGENT_RUN_LOGS} (
      tenant_id,
      run_id,
      agent_id,
      customer_or_entity_id,
      trigger,
      context,
      skill,
      step_index,
      tool,
      decision,
      authority,
      approval,
      action,
      execution_status,
      evidence,
      outcome,
      latency_ms,
      cost,
      error,
      started_at,
      completed_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10::jsonb, $11, $12::jsonb, $13::jsonb, $14, $15::jsonb,
      $16::jsonb, $17, $18::jsonb, $19::jsonb, $20::timestamptz, $21::timestamptz
    )
    RETURNING tenant_id, run_id, skill, step_index`;

const INSERT_AUDIT_RECORD = `INSERT INTO ${AUDIT_RECORDS} (
      run_id,
      tenant_id,
      agent_id,
      customer_or_entity_id,
      trigger,
      context,
      skill,
      tool,
      decision,
      authority,
      approval,
      action,
      execution_status,
      evidence,
      outcome,
      latency_ms,
      cost,
      error,
      "timestamp",
      prev_hash,
      chain_hash
    ) VALUES (
      $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb, $10, $11::jsonb, $12::jsonb, $13, $14::jsonb,
      $15::jsonb, $16, $17::jsonb, $18::jsonb, $19::timestamptz, $20, $21
    )
    RETURNING id`;

/**
 * The run's durable chain tail. `step_index` orders the chain and `evidence_id` breaks a tie between
 * two effects of one step, so the predecessor is the greatest link deterministically — no wall
 * clock, and therefore no dependence on two transactions that started in the same millisecond.
 */
const SELECT_EVIDENCE_TAIL = `SELECT${EVIDENCE_PROJECTION}
  FROM ${EVIDENCE_RECORDS}
  WHERE tenant_id = $1 AND run_id = $2
  ORDER BY step_index DESC, evidence_id DESC
  LIMIT 1`;

const SELECT_EVIDENCE_BY_RUN = `SELECT${EVIDENCE_PROJECTION}
  FROM ${EVIDENCE_RECORDS}
  WHERE tenant_id = $1 AND run_id = $2
  ORDER BY step_index, evidence_id`;

/**
 * The tenant's durable chain tail. The writer binds `timestamp` to the audit event time, so the
 * greatest `(timestamp, id)` pair is the last append; `id` is time-ordered (`uuid_generate_v7`), so
 * a tie cannot leave the choice to the planner.
 */
const SELECT_AUDIT_TAIL = `SELECT${AUDIT_PROJECTION}
  FROM ${AUDIT_RECORDS}
  WHERE tenant_id = $1
  ORDER BY "timestamp" DESC, id DESC
  LIMIT 1`;

const SELECT_AUDIT_BY_TENANT = `SELECT${AUDIT_PROJECTION}
  FROM ${AUDIT_RECORDS}
  WHERE tenant_id = $1
  ORDER BY "timestamp", id`;

const SELECT_RUN_LOGS_BY_RUN = `SELECT${RUN_LOG_PROJECTION}
  FROM ${AGENT_RUN_LOGS}
  WHERE tenant_id = $1 AND run_id = $2
  ORDER BY step_index, skill`;

/* ------------------------------------------------------------------------------------------------
 * Chain primitives (implement/04 §6.1 step 2-3, implement/08 §4.2)
 * ---------------------------------------------------------------------------------------------- */

/** Digests a UTF-8 string with SHA-256: the byte contract of both chain formulas. */
function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Resolves the audit signing secret and fails closed when it is absent (§04 §6.1 step 3, §08 §4.2).
 *
 * Local for the same leaf-package reason as the chain formulas, with the same name and semantics as
 * `durability/evidence.ts` so a composition root can inject one secret into both.
 *
 * @param secret Explicit secret; when omitted the process environment is read.
 * @returns The secret to sign with.
 * @throws Error `AUDIT_SECRET_MISSING` when no secret is configured. The value itself is never
 *   echoed into the message.
 */
export function requireAuditHmacSecret(secret?: string): string {
  const resolved = secret ?? process.env[AUDIT_HMAC_SECRET_ENV];

  if (typeof resolved !== 'string' || resolved.trim().length === 0) {
    throw new Error(
      'AUDIT_SECRET_MISSING: AUDIT_HMAC_SECRET is required to sign evidence records and to verify ' +
        'the chains that carry them; an unsigned chain is not an audit chain (NFR-002).',
    );
  }

  return resolved;
}

/**
 * Validates one digest column before it is written or hashed.
 *
 * @param value Candidate digest.
 * @param column Column the digest belongs to, for the refusal message.
 * @param code Error code to raise.
 * @returns The validated digest.
 * @throws Error `<code>` when the value is not a bare lowercase 64-character hex SHA-256.
 */
export function assertSha256Digest(value: unknown, column: string, code: string): string {
  if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
    throw new Error(
      `${code}: ${column} must be a bare lowercase 64-character hex SHA-256 digest (no prefix, no ` +
        'uppercase); a digest in any other spelling cannot be compared with a recomputed one ' +
        '(implement/04 §6.1, implement/08 §4.2).',
    );
  }

  return value;
}

/**
 * Extends the per-run evidence chain (§04 §6.1 step 2).
 *
 * @param params.previous_evidence_hash Predecessor's `chain_hash`; {@link GENESIS_HASH} for the
 *   first record of a run.
 * @param params.payload_sha256 Digest of the canonical payload.
 * @param params.effect_key Deterministic key of the step that produced the record.
 * @param params.step_index Step ordinal inside the run.
 * @returns `chain_hash` as 64 lower-case hexadecimal characters.
 * @throws Error `EVIDENCE_INPUT_INVALID` for a malformed digest, a blank `effect_key` or an ordinal
 *   that is not a non-negative integer.
 */
export function evidenceChainHash(params: {
  previous_evidence_hash: string;
  payload_sha256: string;
  effect_key: string;
  step_index: number;
}): string {
  assertSha256Digest(params.previous_evidence_hash, 'previous_evidence_hash', 'EVIDENCE_INPUT_INVALID');
  assertSha256Digest(params.payload_sha256, 'payload_sha256', 'EVIDENCE_INPUT_INVALID');

  if (typeof params.effect_key !== 'string' || params.effect_key.trim().length === 0) {
    throw new Error(
      'EVIDENCE_INPUT_INVALID: evidence cannot be chained without the effect_key that binds the ' +
        'record to one action (BR-010).',
    );
  }

  if (!Number.isInteger(params.step_index) || params.step_index < 0) {
    throw new Error(
      `EVIDENCE_INPUT_INVALID: step_index must be a non-negative integer; received ` +
        `${String(params.step_index)}.`,
    );
  }

  return sha256Hex(
    `${params.previous_evidence_hash}|${params.payload_sha256}|${params.effect_key}|${params.step_index}`,
  );
}

/**
 * Signs an evidence chain hash with HMAC-SHA256 (§04 §6.1 step 3, non-repudiation).
 *
 * @param chain_hash The `chain_hash` to sign.
 * @param secret Explicit secret; when omitted the process environment is read.
 * @returns The `signature` column value: 64 lower-case hexadecimal characters.
 * @throws Error `EVIDENCE_INPUT_INVALID` for a malformed `chain_hash`, or `AUDIT_SECRET_MISSING`
 *   when no signing secret is configured.
 */
export function signEvidenceChainHash(chain_hash: string, secret?: string): string {
  assertSha256Digest(chain_hash, 'chain_hash', 'EVIDENCE_INPUT_INVALID');

  return createHmac('sha256', requireAuditHmacSecret(secret)).update(chain_hash, 'utf8').digest('hex');
}

/**
 * Projects an audit record onto the hashed payload (§08 §4.2): the 18 mapped fields and nothing
 * else.
 *
 * `step_index` and the operational `started_at` / `completed_at` renderings are deliberately absent
 * — `audit_records` stores no `step_index`, and the event time enters the hash through the
 * `timestamp` argument. An absent nullable field is normalized to `null` here so the hashed value is
 * exactly the value the row stores, which is what lets a verifier reproduce the digest from a read
 * row.
 *
 * @param record The canonical run record about to be appended.
 * @returns The exact value to pass as `payload` to {@link auditChainHash}.
 */
export function buildAuditPayload(record: AuditRecordInput): Record<string, unknown> {
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
    approval: record.approval ?? null,
    action: record.action,
    execution_status: record.execution_status,
    evidence: record.evidence,
    outcome: record.outcome ?? null,
    latency_ms: record.latency_ms,
    cost: record.cost,
    error: record.error ?? null,
  };
}

/**
 * Extends the per-tenant audit chain (§08 §4.2) over the UTF-8 byte contract
 * `prev_hash + "|" + CanonicalJSON(payload) + "|" + timestamp`.
 *
 * @param params.prev_hash Tenant predecessor hash; {@link GENESIS_HASH} for the tenant's first
 *   record.
 * @param params.payload Sanitized payload; use {@link buildAuditPayload}.
 * @param params.timestamp Audit event time as the writer stores it: UTC ISO-8601 with milliseconds.
 * @returns `chain_hash` as 64 lower-case hexadecimal characters.
 * @throws Error `AUDIT_INPUT_INVALID` for a malformed predecessor hash or timestamp, or
 *   `CANONICAL_JSON_INVALID` when the payload is not canonicalizable.
 */
export function auditChainHash(params: {
  prev_hash: string;
  payload: Record<string, unknown>;
  timestamp: string;
}): string {
  assertSha256Digest(params.prev_hash, 'prev_hash', 'AUDIT_INPUT_INVALID');

  if (typeof params.timestamp !== 'string' || !AUDIT_TIMESTAMP_UTC_ISO_MS.test(params.timestamp)) {
    throw new Error(
      'AUDIT_INPUT_INVALID: timestamp must be UTC ISO-8601 with milliseconds ' +
        '(YYYY-MM-DDTHH:MM:SS.sssZ) so writer and verifier hash identical bytes; received ' +
        `${String(params.timestamp)}.`,
    );
  }

  return sha256Hex(`${params.prev_hash}|${canonicalizeJson(params.payload)}|${params.timestamp}`);
}

/* ------------------------------------------------------------------------------------------------
 * Published records (structural ports)
 * ---------------------------------------------------------------------------------------------- */

/**
 * One stored `agentos.evidence_records` row (§04 §6.1).
 *
 * Structurally identical to the core-engine port's `ImmutableEvidenceRecord` plus `raw_payload`,
 * which the verifier needs to recompute `payload_sha256` from the stored bytes.
 */
export interface ImmutableEvidenceRecord {
  readonly evidence_id: string;
  readonly run_id: string;
  readonly tenant_id: string;
  readonly correlation_id: string;
  readonly step_index: number;
  readonly effect_key: string;
  /** Predecessor's `chain_hash`; {@link GENESIS_HASH} for the first record of a run. */
  readonly previous_evidence_hash: string;
  /** SHA-256 of the canonical `raw_payload`. */
  readonly payload_sha256: string;
  /** SHA-256 over `previous | payload_sha256 | effect_key | step_index`. */
  readonly chain_hash: string;
  /** HMAC-SHA256 over `chain_hash`. */
  readonly signature: string;
  /** The canonical payload the digest was computed over, stored verbatim. */
  readonly raw_payload: unknown;
  readonly created_at: string;
}

/** One stored `agentos.agent_run_logs` row: the 18 mapped fields plus `step_index` and the instants. */
export interface AgentRunLog {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly agent_id: string;
  readonly customer_or_entity_id: string;
  readonly trigger: string;
  readonly context: unknown;
  readonly skill: string;
  readonly step_index: number;
  readonly tool: string;
  readonly decision: unknown;
  readonly authority: AuthorityLevel;
  readonly approval: unknown | null;
  readonly action: unknown;
  readonly execution_status: ExecutionStatus;
  readonly evidence: unknown;
  readonly outcome: unknown | null;
  readonly latency_ms: number;
  readonly cost: unknown;
  readonly error: unknown | null;
  readonly started_at: string;
  readonly completed_at: string;
  readonly created_at: string;
}

/**
 * Input of {@link EvidenceRepository.logAgentRun}: the canonical 18-field run record (SRS §17).
 *
 * `step_index` is part of the primary key `(tenant_id, run_id, skill, step_index)`, so omitting it
 * would collapse a multi-step plan into one row per skill.
 */
export interface AgentRunLogRecord {
  readonly run_id: string;
  readonly tenant_id: string;
  readonly agent_id: string;
  readonly customer_or_entity_id: string;
  readonly trigger: string;
  readonly context: unknown;
  readonly skill: string;
  readonly step_index: number;
  readonly tool: string;
  readonly decision: unknown;
  readonly authority: AuthorityLevel;
  readonly approval: unknown | null;
  readonly action: unknown;
  readonly execution_status: ExecutionStatus;
  readonly evidence: unknown;
  readonly outcome: unknown | null;
  readonly latency_ms: number;
  readonly cost: unknown;
  readonly error: unknown | null;
  readonly started_at: string;
  readonly completed_at: string;
}

/** One stored `agentos.audit_records` row, the chained compliance record (§08 §4.1). */
export interface AuditRecord extends AuditRecordInput {
  readonly id: string;
  /** Audit event time as the hashed byte contract renders it: UTC ISO-8601 with milliseconds. */
  readonly timestamp: string;
  /** Predecessor's `chain_hash`; {@link GENESIS_HASH} for the tenant's first record. */
  readonly prev_hash: string;
  /** SHA-256 over `prev_hash | CanonicalJSON(payload) | timestamp`. */
  readonly chain_hash: string;
}

/**
 * Input of {@link AuditRepository.append}: the 18 mapped fields of one audit event plus its event
 * time.
 *
 * The operational `step_index` / `started_at` / `completed_at` members are optional so a full
 * `AgentRunLogRecord` binds to this method verbatim (that is the `IAuditTrail` port's signature);
 * they are not part of the hashed projection.
 */
export interface AuditRecordInput {
  readonly run_id: string;
  readonly tenant_id: string;
  readonly agent_id: string;
  readonly customer_or_entity_id: string;
  readonly trigger: string;
  readonly context: unknown;
  readonly skill: string;
  readonly tool: string;
  readonly decision: unknown;
  readonly authority: AuthorityLevel;
  readonly approval: unknown | null;
  readonly action: unknown;
  readonly execution_status: ExecutionStatus;
  readonly evidence: unknown;
  readonly outcome: unknown | null;
  readonly latency_ms: number;
  readonly cost: unknown;
  readonly error: unknown | null;
  /** Audit event time; defaults to `completed_at` when the operational record is passed verbatim. */
  readonly timestamp?: string;
  readonly step_index?: number;
  readonly started_at?: string;
  readonly completed_at?: string;
}

/* ------------------------------------------------------------------------------------------------
 * Chain verification (implement/04 §6.1, implement/08 §4.2, TC-ORC-007)
 * ---------------------------------------------------------------------------------------------- */

/**
 * Every way a stored chain can fail verification. Each one is a defect a reader can prove from the
 * rows alone, never a hypothesis about the writer's intent:
 *
 *  * `GENESIS_MISSING` / `GENESIS_FORK` — the scope has no record linked to {@link GENESIS_HASH}, or
 *    more than one, so the chain has no single origin.
 *  * `CHAIN_FORK` — two records claim the same predecessor, which is what the writer's per-scope
 *    serialization exists to prevent.
 *  * `MISSING_PREDECESSOR` — a record links to a hash no stored row carries: the linked ancestor is
 *    gone, which is the proof that an interior row was deleted or never written.
 *  * `CHAIN_HASH_DUPLICATE` — two rows share a `chain_hash`, which the `UNIQUE (tenant_id, chain_hash)`
 *    constraint forbids: the rows did not come from the writer.
 *  * `DIGEST_INVALID` — a digest column does not hold a lowercase SHA-256, so nothing can be
 *    recomputed from it.
 *  * `PAYLOAD_DIGEST_MISMATCH` — `payload_sha256` is not the digest of the stored `raw_payload`:
 *    the payload was edited.
 *  * `CHAIN_HASH_MISMATCH` — the stored `chain_hash` is not what the row's own fields reproduce, so
 *    a linked field was edited without re-hashing (or the row was written by hand).
 *  * `SIGNATURE_INVALID` — the HMAC over the stored `chain_hash` does not verify with the configured
 *    secret, which is what a recomputed forgery cannot reproduce.
 *  * `STEP_ORDER_INVALID` — the run's `step_index` decreases along the chain, so the links and the
 *    step order disagree.
 *  * `TIMESTAMP_INVALID` — an audit `timestamp` cannot be rendered as the byte contract the hash was
 *    computed over, so the record cannot be verified at all.
 */
export type ChainBreakKind =
  | 'GENESIS_MISSING'
  | 'GENESIS_FORK'
  | 'CHAIN_FORK'
  | 'MISSING_PREDECESSOR'
  | 'CHAIN_HASH_DUPLICATE'
  | 'DIGEST_INVALID'
  | 'PAYLOAD_DIGEST_MISMATCH'
  | 'CHAIN_HASH_MISMATCH'
  | 'SIGNATURE_INVALID'
  | 'STEP_ORDER_INVALID'
  | 'TIMESTAMP_INVALID';

/** One defect found while verifying a chain. */
export interface ChainBreak {
  readonly kind: ChainBreakKind;
  /** `evidence_id` of the offending record, or `null` when the break concerns the chain as a whole. */
  readonly record: string | null;
  /**
   * 0-based index of the record in the order it was read back (ascending `step_index` for evidence,
   * ascending event time for audit), or `-1` for a break that belongs to no single record.
   */
  readonly row: number;
  readonly detail: string;
}

/** Outcome of verifying one chain: the records read, the ones proven, and every defect found. */
export interface ChainReport {
  readonly valid: boolean;
  /** Records read back from the store. */
  readonly records: number;
  /** Records reached from the genesis link whose every digest reproduced. */
  readonly verified: number;
  /** `chain_hash` of the last reachable record; `null` when nothing is reachable. */
  readonly head_hash: string | null;
  readonly breaks: readonly ChainBreak[];
}

/** Verification of one run's evidence chain. */
export interface EvidenceChainReport extends ChainReport {
  readonly tenant_id: string;
  readonly run_id: string;
}

/** Verification of one tenant's audit chain. */
export interface AuditChainReport extends ChainReport {
  readonly tenant_id: string;
}

/** One record's place in its scope's chain, as the walk needs it. */
interface ChainLink {
  readonly record: string;
  readonly prev_hash: string;
  readonly chain_hash: string;
}

/** The chain the walk is verifying, named the way its refusals and breaks name it. */
interface ChainScope {
  readonly table: string;
  readonly scope: string;
  readonly reference: string;
}

/** Records reachable from the genesis link, in link order, plus the linkage defects found. */
interface ChainWalk {
  readonly order: readonly number[];
  readonly breaks: readonly ChainBreak[];
}

/**
 * Walks a chain from its genesis record and reports every linkage defect.
 *
 * The walk follows links, not the order rows were read in: `previous_evidence_hash` (evidence) and
 * `prev_hash` (audit) are the authority on order, which is why a deleted interior row shows up as an
 * orphan whose predecessor hash is absent rather than as a plausible-looking shorter chain.
 *
 * @param links The scope's records, in read order.
 * @param scope Table and identity the messages name.
 * @returns The reachable order and the breaks; a break never invalidates the walk itself.
 */
function walkChain(links: readonly ChainLink[], scope: ChainScope): ChainWalk {
  const breaks: ChainBreak[] = [];
  const byChainHash = new Map<string, number>();
  const children = new Map<string, number[]>();

  links.forEach((link, index) => {
    if (byChainHash.has(link.chain_hash)) {
      breaks.push({
        kind: 'CHAIN_HASH_DUPLICATE',
        record: link.record,
        row: index,
        detail:
          `two records of ${scope.scope} carry chain_hash ${link.chain_hash}; ${scope.table} is ` +
          `UNIQUE (tenant_id, chain_hash), so these rows were not written by the chain writer ` +
          `(${scope.reference}).`,
      });
    } else {
      byChainHash.set(link.chain_hash, index);
    }

    const siblings = children.get(link.prev_hash);

    if (siblings === undefined) {
      children.set(link.prev_hash, [index]);
    } else {
      siblings.push(index);
    }
  });

  const roots = children.get(GENESIS_HASH) ?? [];

  if (roots.length === 0) {
    breaks.push({
      kind: 'GENESIS_MISSING',
      record: null,
      row: -1,
      detail:
        `no record of ${scope.scope} links to the genesis digest ${GENESIS_HASH}, so the chain has ` +
        `no verified origin (${scope.reference}).`,
    });
  }

  for (const [prev_hash, holders] of children) {
    for (const index of holders.slice(1)) {
      const link = links[index];
      if (link === undefined) continue;

      breaks.push({
        kind: prev_hash === GENESIS_HASH ? 'GENESIS_FORK' : 'CHAIN_FORK',
        record: link.record,
        row: index,
        detail:
          `record ${link.record} of ${scope.scope} is a second child of predecessor ` +
          `${prev_hash}; a chain link has exactly one successor, so this append forked the chain ` +
          `(${scope.reference}).`,
      });
    }
  }

  const order: number[] = [];
  const visited = new Set<number>();
  let current = roots[0];

  while (current !== undefined && !visited.has(current)) {
    const link = links[current];
    if (link === undefined) break;

    visited.add(current);
    order.push(current);

    const next = (children.get(link.chain_hash) ?? []).find(
      (candidate) => !visited.has(candidate),
    );

    current = next;
  }

  links.forEach((link, index) => {
    if (visited.has(index) || byChainHash.has(link.prev_hash) || link.prev_hash === GENESIS_HASH) {
      return;
    }

    breaks.push({
      kind: 'MISSING_PREDECESSOR',
      record: link.record,
      row: index,
      detail:
        `record ${link.record} of ${scope.scope} links to predecessor ${link.prev_hash}, which no ` +
        `stored row carries; the linked ancestor is missing, so the chain is incomplete ` +
        `(${scope.reference}).`,
    });
  });

  return { order, breaks };
}

/** The row index of a chain-hash lookup, or `-1`; keeps the per-record checks readable. */
function reachedPositions(order: readonly number[]): ReadonlySet<number> {
  return new Set(order);
}

/**
 * How many of the records the walk reached reproduced every digest they were read back with: the
 * `verified` count is about proof, so a record that cannot be reached from the genesis link never
 * counts, however intact its own bytes are.
 */
function reproducedCount(order: readonly number[], reproduced: ReadonlySet<number>): number {
  let count = 0;

  for (const row of order) {
    if (reproduced.has(row)) {
      count += 1;
    }
  }

  return count;
}

/**
 * Recomputes one evidence record's `payload_sha256` from the payload it stores (implement/04 §6.1
 * step 1-2).
 *
 * The digest is taken over the canonical rendering of the stored `raw_payload`, never over the
 * stored `payload_sha256`: the stored column is exactly what an edit would change, so it may be
 * compared with a recomputation but never used as one.
 *
 * @param record The stored record.
 * @param row 0-based read position of the record, for the break.
 * @param scope Table and identity the break names.
 * @param breaks Collector the break is appended to.
 * @returns The recomputed digest, or `null` when the record could not be recomputed (a break was
 * appended instead).
 */
function recomputedPayloadDigest(
  record: ImmutableEvidenceRecord,
  row: number,
  scope: ChainScope,
  breaks: ChainBreak[],
): string | null {
  let recomputed: string;

  try {
    recomputed = sha256CanonicalJson(record.raw_payload);
  } catch (error) {
    breaks.push({
      kind: 'PAYLOAD_DIGEST_MISMATCH',
      record: record.evidence_id,
      row,
      detail:
        `the stored raw_payload of evidence record ${record.evidence_id} has no canonical form (` +
        `${error instanceof Error ? error.message : String(error)}), so the bytes that were digested ` +
        `cannot be reproduced (${scope.reference}).`,
    });

    return null;
  }

  if (recomputed !== record.payload_sha256) {
    breaks.push({
      kind: 'PAYLOAD_DIGEST_MISMATCH',
      record: record.evidence_id,
      row,
      detail:
        `evidence record ${record.evidence_id} stores payload_sha256 ${record.payload_sha256} but ` +
        `its canonical raw_payload digests to ${recomputed}; the payload was edited after it was ` +
        `signed (${scope.reference}).`,
    });

    return null;
  }

  return recomputed;
}

/**
 * Recomputes one evidence record's `chain_hash` from its own fields (implement/04 §6.1 step 2).
 *
 * The predecessor digest that enters the formula is the one the record stores, so a rewritten link
 * is reported here instead of being silently followed.
 *
 * @param record The stored record.
 * @param payload_sha256 The digest recomputed from `raw_payload`.
 * @param row 0-based read position of the record, for the break.
 * @param scope Table and identity the break names.
 * @param breaks Collector the break is appended to.
 * @returns The recomputed `chain_hash`, or `null` when the record could not be recomputed (a break
 * was appended instead).
 */
function recomputedChainHash(
  record: ImmutableEvidenceRecord,
  payload_sha256: string,
  row: number,
  scope: ChainScope,
  breaks: ChainBreak[],
): string | null {
  let recomputed: string;

  try {
    recomputed = evidenceChainHash({
      previous_evidence_hash: record.previous_evidence_hash,
      payload_sha256,
      effect_key: record.effect_key,
      step_index: record.step_index,
    });
  } catch (error) {
    breaks.push({
      kind: 'CHAIN_HASH_MISMATCH',
      record: record.evidence_id,
      row,
      detail:
        `evidence record ${record.evidence_id} cannot be re-hashed (` +
        `${error instanceof Error ? error.message : String(error)}), so the link it carries cannot ` +
        `be reproduced (${scope.reference}).`,
    });

    return null;
  }

  if (recomputed !== record.chain_hash) {
    breaks.push({
      kind: 'CHAIN_HASH_MISMATCH',
      record: record.evidence_id,
      row,
      detail:
        `evidence record ${record.evidence_id} stores chain_hash ${record.chain_hash} but its own ` +
        `fields reproduce ${recomputed}; a hashed field was edited, or the row was written by hand ` +
        `(${scope.reference}).`,
    });

    return null;
  }

  return recomputed;
}

/**
 * Verifies one run's evidence chain (TC-ORC-007, `E2E-OFF-TRACE` step 3).
 *
 * Every stored record is recomputed: `payload_sha256` from the canonical `raw_payload`, `chain_hash`
 * from `previous | payload_sha256 | effect_key | step_index`, and `signature` as the HMAC over the
 * stored `chain_hash`. A record that no longer reproduces is reported, and the walk reports a
 * deleted interior row as a missing predecessor — the report names what is broken instead of
 * truncating the trace at the break.
 *
 * @param records The run's records, as {@link EvidenceRepository} reads them.
 * @param params Scope and signing secret; the secret is required, because a verifier that cannot
 *   verify signatures may not report `valid`.
 * @returns The report; `valid` is `true` only when no break was found.
 * @throws Error `AUDIT_SECRET_MISSING` when no signing secret is configured.
 */
export function verifyEvidenceChain(
  records: readonly ImmutableEvidenceRecord[],
  params: { readonly tenant_id: string; readonly run_id: string; readonly secret?: string },
): EvidenceChainReport {
  const secret = requireAuditHmacSecret(params.secret);
  const scope: ChainScope = {
    table: EVIDENCE_RECORDS,
    scope: `run ${params.run_id} of tenant ${params.tenant_id}`,
    reference: 'implement/04 §6.1',
  };

  const links: ChainLink[] = records.map((record) => ({
    record: record.evidence_id,
    prev_hash: record.previous_evidence_hash,
    chain_hash: record.chain_hash,
  }));

  const walk = walkChain(links, scope);
  const breaks: ChainBreak[] = [...walk.breaks];
  const reached = reachedPositions(walk.order);
  const reproduced = new Set<number>();

  records.forEach((record, row) => {
    const digests = [
      ['previous_evidence_hash', record.previous_evidence_hash],
      ['payload_sha256', record.payload_sha256],
      ['chain_hash', record.chain_hash],
      ['signature', record.signature],
    ] as const;

    let wellFormed = true;

    for (const [column, value] of digests) {
      if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
        wellFormed = false;
        breaks.push({
          kind: 'DIGEST_INVALID',
          record: record.evidence_id,
          row,
          detail:
            `evidence record ${record.evidence_id} stores ${column} = ${String(value)}, which is not ` +
            `a lowercase SHA-256; no digest of this row can be recomputed (${scope.reference}).`,
        });
      }
    }

    if (!wellFormed) {
      return;
    }

    const payload_sha256 = recomputedPayloadDigest(record, row, scope, breaks);

    if (payload_sha256 === null) {
      return;
    }

    const chain_hash = recomputedChainHash(record, payload_sha256, row, scope, breaks);

    if (chain_hash === null) {
      return;
    }

    const signature = createHmac('sha256', secret).update(record.chain_hash, 'utf8').digest('hex');

    if (signature !== record.signature) {
      breaks.push({
        kind: 'SIGNATURE_INVALID',
        record: record.evidence_id,
        row,
        detail:
          `the signature of evidence record ${record.evidence_id} does not verify with the ` +
          `configured ${AUDIT_HMAC_SECRET_ENV}; the stored chain_hash was not signed by this ` +
          `chain's signer, so the record is not non-repudiable (${scope.reference}).`,
      });

      return;
    }

    if (reached.has(row)) {
      reproduced.add(row);
    }
  });

  let previous_step_index: number | null = null;
  let head_hash: string | null = null;

  for (const row of walk.order) {
    // `walk.order` holds read positions of `records` by construction; the guard keeps the walk total.
    const record = records[row];

    if (record === undefined) {
      continue;
    }

    if (previous_step_index !== null && record.step_index < previous_step_index) {
      breaks.push({
        kind: 'STEP_ORDER_INVALID',
        record: record.evidence_id,
        row,
        detail:
          `evidence record ${record.evidence_id} is step ${record.step_index}, which precedes step ` +
          `${previous_step_index} earlier in the run's chain; the links and the step order disagree ` +
          `(${scope.reference}).`,
      });
    }

    previous_step_index = record.step_index;
    head_hash = record.chain_hash;
  }

  return {
    valid: breaks.length === 0,
    records: records.length,
    verified: reproducedCount(walk.order, reproduced),
    head_hash,
    breaks,
    tenant_id: params.tenant_id,
    run_id: params.run_id,
  };
}

/**
 * Verifies one tenant's audit chain (TC-ORC-007, implement/08 §4.2).
 *
 * Every stored record is re-hashed with {@link auditChainHash} over {@link buildAuditPayload} and
 * the event time the record publishes: the chain is the whole integrity mechanism of
 * `audit_records`, because the migration gives that table no signature column, so a record whose
 * fields no longer reproduce its `chain_hash` is reported as `CHAIN_HASH_MISMATCH` and a record
 * whose event time is not the UTC-millisecond rendering the writer hashed is reported as
 * `TIMESTAMP_INVALID` rather than verified with different bytes. The walk itself is the same one the
 * evidence chain uses, so a deleted interior record appears as a missing predecessor and a second
 * child of one predecessor as a fork.
 *
 * @param records The tenant's records, as {@link AuditRepository} reads them.
 * @param params Scope the breaks name.
 * @returns The report; `valid` is `true` only when no break was found.
 */
export function verifyAuditChain(
  records: readonly AuditRecord[],
  params: { readonly tenant_id: string },
): AuditChainReport {
  const scope: ChainScope = {
    table: AUDIT_RECORDS,
    scope: `tenant ${params.tenant_id}`,
    reference: 'implement/08 §4.2',
  };

  const walk = walkChain(
    records.map((record) => ({
      record: record.id,
      prev_hash: record.prev_hash,
      chain_hash: record.chain_hash,
    })),
    scope,
  );

  const breaks: ChainBreak[] = [...walk.breaks];
  const reached = reachedPositions(walk.order);
  const reproduced = new Set<number>();

  records.forEach((record, row) => {
    const digests = [
      ['prev_hash', record.prev_hash],
      ['chain_hash', record.chain_hash],
    ] as const;

    let wellFormed = true;

    for (const [column, value] of digests) {
      if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
        wellFormed = false;
        breaks.push({
          kind: 'DIGEST_INVALID',
          record: record.id,
          row,
          detail:
            `audit record ${record.id} stores ${column} = ${String(value)}, which is not a lowercase ` +
            `SHA-256; no digest of this row can be recomputed (${scope.reference}).`,
        });
      }
    }

    if (!wellFormed) {
      return;
    }

    if (typeof record.timestamp !== 'string' || !AUDIT_TIMESTAMP_UTC_ISO_MS.test(record.timestamp)) {
      breaks.push({
        kind: 'TIMESTAMP_INVALID',
        record: record.id,
        row,
        detail:
          `audit record ${record.id} renders its event time as ${String(record.timestamp)}, which is ` +
          `not UTC ISO-8601 with milliseconds; the writer and the verifier would hash different ` +
          `bytes, so the record cannot be verified (${scope.reference}).`,
      });

      return;
    }

    let recomputed: string;

    try {
      recomputed = auditChainHash({
        prev_hash: record.prev_hash,
        payload: buildAuditPayload(record),
        timestamp: record.timestamp,
      });
    } catch (error) {
      breaks.push({
        kind: 'CHAIN_HASH_MISMATCH',
        record: record.id,
        row,
        detail:
          `audit record ${record.id} cannot be re-hashed (` +
          `${error instanceof Error ? error.message : String(error)}), so the link it carries ` +
          `cannot be reproduced (${scope.reference}).`,
      });

      return;
    }

    if (recomputed !== record.chain_hash) {
      breaks.push({
        kind: 'CHAIN_HASH_MISMATCH',
        record: record.id,
        row,
        detail:
          `audit record ${record.id} stores chain_hash ${record.chain_hash} but its own fields ` +
          `reproduce ${recomputed}; a hashed field was edited after the row was appended ` +
          `(${scope.reference}).`,
      });

      return;
    }

    if (reached.has(row)) {
      reproduced.add(row);
    }
  });

  let head_hash: string | null = null;

  for (const row of walk.order) {
    const record = records[row];

    if (record !== undefined) {
      head_hash = record.chain_hash;
    }
  }

  return {
    valid: breaks.length === 0,
    records: records.length,
    verified: reproducedCount(walk.order, reproduced),
    head_hash,
    breaks,
    tenant_id: params.tenant_id,
  };
}

/* ------------------------------------------------------------------------------------------------
 * Persistence: the append-only writers and the chain readers (implement/04 §6.1, implement/08 §4.2)
 * ---------------------------------------------------------------------------------------------- */

/** One `agentos.evidence_records` row exactly as `pg` returns it, before the projection is published. */
interface EvidenceRecordRow extends QueryResultRow {
  evidence_id: string;
  tenant_id: string;
  run_id: string;
  correlation_id: string;
  step_index: number;
  effect_key: string;
  previous_evidence_hash: string;
  payload_sha256: string;
  chain_hash: string;
  signature: string;
  raw_payload: unknown;
  created_at: Date;
}

/** One `agentos.agent_run_logs` row exactly as `pg` returns it. */
interface AgentRunLogRow extends QueryResultRow {
  tenant_id: string;
  run_id: string;
  agent_id: string;
  customer_or_entity_id: string;
  trigger: string;
  context: unknown;
  skill: string;
  step_index: number;
  tool: string;
  decision: unknown;
  authority: AuthorityLevel;
  approval: unknown | null;
  action: unknown;
  execution_status: ExecutionStatus;
  evidence: unknown;
  outcome: unknown | null;
  latency_ms: number;
  cost: unknown;
  error: unknown | null;
  started_at: Date;
  completed_at: Date;
  created_at: Date;
}

/** One `agentos.audit_records` row exactly as `pg` returns it. */
interface AuditRecordRow extends QueryResultRow {
  id: string;
  run_id: string;
  tenant_id: string;
  agent_id: string;
  customer_or_entity_id: string;
  trigger: string;
  context: unknown;
  skill: string;
  tool: string;
  decision: unknown;
  authority: AuthorityLevel;
  approval: unknown | null;
  action: unknown;
  execution_status: ExecutionStatus;
  evidence: unknown;
  outcome: unknown | null;
  latency_ms: number;
  cost: unknown;
  error: unknown | null;
  timestamp: Date;
  prev_hash: string;
  chain_hash: string;
}

/**
 * Publishes one evidence row. `created_at` becomes an ISO-8601 UTC string and the digests are
 * published verbatim, so the record a caller verifies carries exactly the fields the row stores.
 */
function toEvidenceRecord(row: EvidenceRecordRow): ImmutableEvidenceRecord {
  return {
    evidence_id: row.evidence_id,
    run_id: row.run_id,
    tenant_id: row.tenant_id,
    correlation_id: row.correlation_id,
    step_index: row.step_index,
    effect_key: row.effect_key,
    previous_evidence_hash: row.previous_evidence_hash,
    payload_sha256: row.payload_sha256,
    chain_hash: row.chain_hash,
    signature: row.signature,
    raw_payload: row.raw_payload,
    created_at: row.created_at.toISOString(),
  };
}

/** Publishes one run-log row with its three instants as ISO-8601 UTC strings. */
function toAgentRunLog(row: AgentRunLogRow): AgentRunLog {
  return {
    tenant_id: row.tenant_id,
    run_id: row.run_id,
    agent_id: row.agent_id,
    customer_or_entity_id: row.customer_or_entity_id,
    trigger: row.trigger,
    context: row.context,
    skill: row.skill,
    step_index: row.step_index,
    tool: row.tool,
    decision: row.decision,
    authority: row.authority,
    approval: row.approval,
    action: row.action,
    execution_status: row.execution_status,
    evidence: row.evidence,
    outcome: row.outcome,
    latency_ms: row.latency_ms,
    cost: row.cost,
    error: row.error,
    started_at: row.started_at.toISOString(),
    completed_at: row.completed_at.toISOString(),
    created_at: row.created_at.toISOString(),
  };
}

/**
 * Publishes one audit row. `timestamp` is rendered as UTC ISO-8601 with milliseconds, the byte
 * contract the chain hash was computed over, so a verifier reading this record back re-hashes the
 * same bytes the writer hashed (implement/08 §4.2).
 */
function toAuditRecord(row: AuditRecordRow): AuditRecord {
  return {
    id: row.id,
    run_id: row.run_id,
    tenant_id: row.tenant_id,
    agent_id: row.agent_id,
    customer_or_entity_id: row.customer_or_entity_id,
    trigger: row.trigger,
    context: row.context,
    skill: row.skill,
    tool: row.tool,
    decision: row.decision,
    authority: row.authority,
    approval: row.approval,
    action: row.action,
    execution_status: row.execution_status,
    evidence: row.evidence,
    outcome: row.outcome,
    latency_ms: row.latency_ms,
    cost: row.cost,
    error: row.error,
    timestamp: row.timestamp.toISOString(),
    prev_hash: row.prev_hash,
    chain_hash: row.chain_hash,
  };
}

/**
 * Reads the SQLSTATE of a `pg` driver error, when the failure carries one.
 *
 * Only used to translate a unique violation (`23505`) on an append-only key into the refusal that
 * names the record it collided on. Anything else is rethrown untouched: a connection or driver
 * failure is not an audit outcome.
 */
function sqlState(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }

  const { code } = error as { code?: unknown };

  return typeof code === 'string' ? code : undefined;
}

/**
 * The primary key of one evidence record, derived from the run identity exactly as
 * `durability/evidence.ts` derives it (`ev_` and 16 hex characters), so re-appending the same effect
 * addresses the row it would duplicate: the database refuses it instead of the chain growing a
 * second link for one effect (implement/04 §6.1).
 */
function evidenceIdFor(params: {
  tenant_id: string;
  run_id: string;
  effect_key: string;
  step_index: number;
}): string {
  return `ev_${sha256Hex(
    `${params.tenant_id}|${params.run_id}|${params.effect_key}|${params.step_index}`,
  ).slice(0, 16)}`;
}

/**
 * Canonical text of one JSONB column: the bytes the digest covers, written verbatim so the writer,
 * the stored row and the verifier cannot disagree about them (implement/04 §6.1 step 1).
 *
 * A value JSON cannot represent (an absent member, `NaN`, a `Date`) is refused rather than
 * converted, because the converted bytes would hash to something the caller never saw.
 *
 * @param value Column value as the caller supplied it.
 * @param column Column the value belongs to, for the refusal message.
 * @param code Error code to raise.
 * @returns The canonical JSON text to bind to the statement.
 * @throws Error `<code>` when the value has no canonical form.
 */
function canonicalJsonColumn(value: unknown, column: string, code: string): string {
  try {
    return canonicalizeJson(value);
  } catch (error) {
    throw new Error(
      `${code}: ${column} has no canonical JSON form (` +
        `${error instanceof Error ? error.message : String(error)}); an absent member or a non-JSON ` +
        'value would change the hashed bytes, so it is refused instead of converted ' +
        '(implement/04 §6.1).',
    );
  }
}

/**
 * Canonical text of a nullable JSONB column: `null` and `undefined` both mean SQL NULL, so the
 * column stores nothing rather than a JSON `null` the verifier would have to re-hash.
 */
function nullableJsonColumn(value: unknown, column: string, code: string): string | null {
  return value === undefined || value === null ? null : canonicalJsonColumn(value, column, code);
}

/**
 * Validates an operational instant against the `TIMESTAMPTZ` column it will land in.
 *
 * The column is not hashed, so any instant PostgreSQL can store is accepted and refused here only
 * when it cannot be one at all: a value the server would reject with `22007` names no column.
 */
function assertInstant(value: unknown, column: string, code: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(
      `${code}: ${column} must be an ISO-8601 instant so the operational log carries the step's own ` +
        `clock rather than the server's; received ${String(value)} (implement/04 §6.1).`,
    );
  }

  return value;
}

/**
 * Validates `execution_status` against the migration's closed six-value vocabulary.
 *
 * @param value Candidate status.
 * @param code Error code to raise.
 * @throws Error `<code>` for anything outside {@link EXECUTION_STATUSES}; there is no seventh status,
 * and a timeout-UNKNOWN attempt is `failed` with `error.outcome = 'UNKNOWN'`.
 */
function assertExecutionStatus(value: unknown, code: string): asserts value is ExecutionStatus {
  if (typeof value !== 'string' || !EXECUTION_STATUSES.includes(value as ExecutionStatus)) {
    throw new Error(
      `${code}: execution_status ${String(value)} is not one of ${EXECUTION_STATUSES.join(', ')}; ` +
        'the append-only vocabulary is closed, so an unknown status is refused rather than stored ' +
        '(implement/03 §1 DOMAIN 5).',
    );
  }
}

/**
 * Validates `authority` against the SRS §12 taxonomy (`AUTH-0` .. `AUTH-5`, no seventh level).
 *
 * @param value Candidate authority.
 * @param code Error code to raise.
 * @throws Error `<code>` for anything outside {@link AUTHORITY_LEVELS}.
 */
function assertAuthority(value: unknown, code: string): asserts value is AuthorityLevel {
  if (typeof value !== 'string' || !AUTHORITY_LEVELS.includes(value as AuthorityLevel)) {
    throw new Error(
      `${code}: authority ${String(value)} is not one of ${AUTHORITY_LEVELS.join(', ')}; the ` +
        'taxonomy is closed, and AUTH-5 is never approvable (SRS §12).',
    );
  }
}

/**
 * The 18 mapped run fields validated and rendered for storage: identities bounded to the `VARCHAR`
 * columns they will land in, each JSONB column as its canonical text, and the two closed value sets
 * checked against the migration's vocabulary.
 *
 * Both append-only ledgers store this shape — `audit_records` and `agent_run_logs` carry the same 18
 * fields — so one preparation serves both and neither can drift into accepting a status or a length
 * the other refuses.
 */
interface PreparedLedgerRecord {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly agent_id: string;
  readonly customer_or_entity_id: string;
  readonly trigger: string;
  readonly skill: string;
  readonly tool: string;
  readonly context: string;
  readonly decision: string;
  readonly approval: string | null;
  readonly action: string;
  readonly evidence: string;
  readonly outcome: string | null;
  readonly cost: string;
  readonly error: string | null;
  readonly latency_ms: number;
  readonly execution_status: ExecutionStatus;
  readonly authority: AuthorityLevel;
}

/**
 * Validates one canonical run record and renders it for storage.
 *
 * @param record The 18-field run record (SRS §17) to be appended.
 * @param code Error code every refusal of this preparation raises.
 * @returns The validated record with its JSONB columns as canonical text.
 * @throws Error `<code>` when a field cannot be stored in the column that owns it.
 */
function prepareLedgerRecord(record: AuditRecordInput, code: string): PreparedLedgerRecord {
  assertIdentifier(record.tenant_id, 'tenant_id', 36, code);
  assertIdentifier(record.run_id, 'run_id', 64, code);
  assertIdentifier(record.agent_id, 'agent_id', 32, code);
  assertIdentifier(record.customer_or_entity_id, 'customer_or_entity_id', 64, code);
  assertIdentifier(record.trigger, 'trigger', 128, code);
  assertIdentifier(record.skill, 'skill', 64, code);
  assertIdentifier(record.tool, 'tool', 64, code);
  assertExecutionStatus(record.execution_status, code);
  assertAuthority(record.authority, code);

  if (
    typeof record.latency_ms !== 'number' ||
    !Number.isInteger(record.latency_ms) ||
    record.latency_ms < 0
  ) {
    throw new Error(
      `${code}: latency_ms must be a non-negative integer; a step whose duration was not measured ` +
        `stores 0 rather than a fabricated duration (implement/04 §6.1).`,
    );
  }

  return {
    tenant_id: record.tenant_id,
    run_id: record.run_id,
    agent_id: record.agent_id,
    customer_or_entity_id: record.customer_or_entity_id,
    trigger: record.trigger,
    skill: record.skill,
    tool: record.tool,
    context: canonicalJsonColumn(record.context, 'context', code),
    decision: canonicalJsonColumn(record.decision, 'decision', code),
    approval: nullableJsonColumn(record.approval, 'approval', code),
    action: canonicalJsonColumn(record.action, 'action', code),
    evidence: canonicalJsonColumn(record.evidence, 'evidence', code),
    outcome: nullableJsonColumn(record.outcome, 'outcome', code),
    cost: canonicalJsonColumn(record.cost, 'cost', code),
    error: nullableJsonColumn(record.error, 'error', code),
    latency_ms: record.latency_ms,
    execution_status: record.execution_status,
    authority: record.authority,
  };
}

/** Input of {@link EvidenceRepository.appendEvidence}: one step's link to append. */
export interface AppendEvidenceInput {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly correlation_id: string;
  /** Step ordinal inside the run; the chain orders links by it, so it is part of the hashed bytes. */
  readonly step_index: number;
  /** Deterministic key of the step that produced the record (BR-010). */
  readonly effect_key: string;
  /** Payload of the step; digested in its canonical form and stored verbatim. */
  readonly payload: Record<string, unknown>;
  /**
   * The predecessor `chain_hash` the caller holds — the chain cursor of a resumed run. Optional: the
   * writer always reads the durable predecessor, and when this cursor is supplied it must agree with
   * it, so a stale cursor is refused instead of forking the chain.
   */
  readonly previous_evidence_hash?: string;
  /** Explicit signing secret; when omitted the process environment is read. */
  readonly secret?: string;
  /** Record instant; when omitted the durable default (`CURRENT_TIMESTAMP`) owns it. */
  readonly created_at?: string;
}

/**
 * The append-only writer and reader of one run's evidence chain (implement/04 §6.1-§6.2).
 *
 *  * `appendEvidence()` — the whole chain step in one transaction: take the advisory lock of
 *    `(tenant, run)`, read the durable predecessor, check the caller's cursor against it, hash the
 *    canonical payload and insert the signed link. The predecessor is read, never supplied, so no
 *    caller can fork a chain by handing in a hash of its own.
 *  * `logAgentRun()` — the step's single operational row, appended once. A second append for the
 *    same `(tenant_id, run_id, skill, step_index)` is refused, because an append-only log is
 *    extended, never corrected.
 *  * `readEvidenceChain()` / `readRunLogs()` — the run's rows in chain and step order.
 *  * `verifyRunChain()` — reads the chain and recomputes every digest and signature through
 *    {@link verifyEvidenceChain}, so a tampered or incomplete trace is reported rather than
 *    truncated.
 */
export class EvidenceRepository {
  private readonly runInTenantTransaction: TenantTransactionRunner;

  /**
   * @param runInTenantTransaction Binds a tenant to the transaction every statement runs in.
   * Defaults to the package's `withTenantContext` binder.
   */
  constructor(runInTenantTransaction: TenantTransactionRunner = withTenantContext) {
    this.runInTenantTransaction = runInTenantTransaction;
  }

  /**
   * Appends one signed link to the run's evidence chain (implement/04 §6.1 steps 1-4).
   *
   * The advisory lock is what makes the chain linear: `ORDER BY step_index DESC, evidence_id DESC
   * LIMIT 1` under `pg_advisory_xact_lock` yields the durable predecessor, and the record links to
   * THAT hash — a concurrent append therefore cannot make two records claim one predecessor, which
   * `UNIQUE (tenant_id, chain_hash)` alone could only detect afterwards.
   *
   * @param input Chain identity, canonical payload and the optional cursor the caller holds.
   * @returns The stored record, exactly as {@link EvidenceRepository.verifyRunChain} reads it back.
   * @throws Error `EVIDENCE_INPUT_INVALID` when the input cannot address or hash a durable row.
   * @throws Error `AUDIT_SECRET_MISSING` when no signing secret is configured; the refusal happens
   * before the transaction opens, so an unsigned record never reaches the table.
   * @throws Error `EVIDENCE_CHAIN_STALE` when the caller's cursor is not the durable predecessor.
   * @throws Error `EVIDENCE_ALREADY_APPENDED` when this effect already holds its link.
   */
  async appendEvidence(input: AppendEvidenceInput): Promise<ImmutableEvidenceRecord> {
    assertIdentifier(input.tenant_id, 'tenant_id', 36, 'EVIDENCE_INPUT_INVALID');
    assertIdentifier(input.run_id, 'run_id', 64, 'EVIDENCE_INPUT_INVALID');
    assertIdentifier(input.correlation_id, 'correlation_id', 64, 'EVIDENCE_INPUT_INVALID');
    assertIdentifier(input.effect_key, 'effect_key', 128, 'EVIDENCE_INPUT_INVALID');
    assertPositiveInteger(input.step_index, 'step_index', 'EVIDENCE_INPUT_INVALID');

    if (!isPlainObject(input.payload)) {
      throw new Error(
        'EVIDENCE_INPUT_INVALID: payload must be a JSON object; the record digests its canonical ' +
          'form and republishes it as raw_payload, so a non-object has no record to verify ' +
          '(implement/04 §6.1).',
      );
    }

    const secret = requireAuditHmacSecret(input.secret);
    const payload_sha256 = sha256CanonicalJson(input.payload);
    const raw_payload = canonicalizeJson(input.payload);
    const created_at =
      input.created_at === undefined
        ? null
        : assertInstant(input.created_at, 'created_at', 'EVIDENCE_INPUT_INVALID');
    const cursor = input.previous_evidence_hash;

    if (cursor !== undefined) {
      assertSha256Digest(cursor, 'previous_evidence_hash', 'EVIDENCE_INPUT_INVALID');
    }

    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      await client.query(LOCK_CHAIN_SCOPE, [
        EVIDENCE_RECORDS,
        `${input.tenant_id}|${input.run_id}`,
      ]);

      const tail = await client.query<EvidenceRecordRow>(SELECT_EVIDENCE_TAIL, [
        input.tenant_id,
        input.run_id,
      ]);
      const tailRow = tail.rows[0];
      const previous_evidence_hash = tailRow === undefined ? GENESIS_HASH : tailRow.chain_hash;

      if (cursor !== undefined && cursor !== previous_evidence_hash) {
        throw new Error(
          `EVIDENCE_CHAIN_STALE: run ${input.run_id} of tenant ${input.tenant_id} ends at ` +
            `${previous_evidence_hash}, but this caller holds ${cursor}; the record is refused ` +
            'rather than linked to a predecessor the chain does not carry (implement/04 §6.1).',
        );
      }

      const evidence_id = evidenceIdFor(input);
      const chain_hash = evidenceChainHash({
        previous_evidence_hash,
        payload_sha256,
        effect_key: input.effect_key,
        step_index: input.step_index,
      });

      let inserted: QueryResult<EvidenceRecordRow>;

      try {
        inserted = await client.query<EvidenceRecordRow>(INSERT_EVIDENCE_RECORD, [
          evidence_id,
          input.tenant_id,
          input.run_id,
          input.correlation_id,
          input.step_index,
          input.effect_key,
          previous_evidence_hash,
          payload_sha256,
          chain_hash,
          signEvidenceChainHash(chain_hash, secret),
          raw_payload,
          created_at,
        ]);
      } catch (error) {
        if (sqlState(error) === '23505') {
          throw new Error(
            `EVIDENCE_ALREADY_APPENDED: evidence record ${evidence_id} (step ${input.step_index} of ` +
              `run ${input.run_id}) already exists in this tenant's chain; an append-only chain is ` +
              'extended, never rewritten, so the stored link is left untouched (NFR-002).',
          );
        }

        throw error;
      }

      const row = inserted.rows[0];

      if (row === undefined) {
        throw new Error(
          `EVIDENCE_APPEND_UNCONFIRMED: the insert of evidence record ${evidence_id} published no ` +
            'row; refusing to report a link the database did not store (NFR-004).',
        );
      }

      return toEvidenceRecord(row);
    });
  }

  /**
   * Appends the single operational run-log row of a resolved step (implement/04 §6.1, §6.2).
   *
   * The row is written only when the step reaches its terminal disposition: an attempt or a pause
   * belongs to the chained audit trail, so the log stays one row per resolved step. The primary key
   * `(tenant_id, run_id, skill, step_index)` is what makes "once" structural — a second append is
   * refused (`AGENT_RUN_LOG_APPENDED`) instead of overwriting the first.
   *
   * @param record The canonical 18-field run record of the resolved step.
   * @throws Error `AGENT_RUN_LOG_INVALID` when a field cannot be stored as its column requires.
   * @throws Error `AGENT_RUN_LOG_APPENDED` when the step already has its row.
   */
  async logAgentRun(record: AgentRunLogRecord): Promise<void> {
    const prepared = prepareLedgerRecord(record, 'AGENT_RUN_LOG_INVALID');
    assertPositiveInteger(record.step_index, 'step_index', 'AGENT_RUN_LOG_INVALID');
    const started_at = assertInstant(record.started_at, 'started_at', 'AGENT_RUN_LOG_INVALID');
    const completed_at = assertInstant(record.completed_at, 'completed_at', 'AGENT_RUN_LOG_INVALID');

    await this.runInTenantTransaction(record.tenant_id, async (client): Promise<void> => {
      let appended: QueryResult<QueryResultRow>;

      try {
        appended = await client.query(INSERT_AGENT_RUN_LOG, [
          prepared.tenant_id,
          prepared.run_id,
          prepared.agent_id,
          prepared.customer_or_entity_id,
          prepared.trigger,
          prepared.context,
          prepared.skill,
          record.step_index,
          prepared.tool,
          prepared.decision,
          prepared.authority,
          prepared.approval,
          prepared.action,
          prepared.execution_status,
          prepared.evidence,
          prepared.outcome,
          prepared.latency_ms,
          prepared.cost,
          prepared.error,
          started_at,
          completed_at,
        ]);
      } catch (error) {
        if (sqlState(error) === '23505') {
          throw new Error(
            `AGENT_RUN_LOG_APPENDED: step ${record.step_index} of run ${record.run_id} already has ` +
              `its agent_run_logs row for skill ${record.skill}; the log carries one row per ` +
              'resolved step and is never rewritten (implement/04 §6.1).',
          );
        }

        throw error;
      }

      if (appended.rowCount !== 1) {
        throw new Error(
          `AGENT_RUN_LOG_UNCONFIRMED: the append of step ${record.step_index} of run ` +
            `${record.run_id} affected no row; refusing to report a step that was not logged ` +
            '(NFR-002).',
        );
      }
    });
  }

  /**
   * Reads the run's evidence chain in link order (`step_index`, then `evidence_id`).
   *
   * One tenant's chain is one transaction: the binder sets the transaction-local
   * `app.current_tenant_id` and the predicate repeats the same tenant, so a neighbouring tenant's
   * record can never enter the walk the verifier runs (NFR-006).
   *
   * @param tenant_id Tenant that owns the run; also enforced by row-level security.
   * @param run_id Run whose chain is read.
   * @returns The stored records, oldest link first.
   */
  async readEvidenceChain(
    tenant_id: string,
    run_id: string,
  ): Promise<readonly ImmutableEvidenceRecord[]> {
    assertIdentifier(tenant_id, 'tenant_id', 36, 'EVIDENCE_INPUT_INVALID');
    assertIdentifier(run_id, 'run_id', 64, 'EVIDENCE_INPUT_INVALID');

    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query<EvidenceRecordRow>(SELECT_EVIDENCE_BY_RUN, [
        tenant_id,
        run_id,
      ]);

      return result.rows.map(toEvidenceRecord);
    });
  }

  /**
   * Reads the run's chain and verifies it (TC-ORC-007, `E2E-OFF-TRACE` step 3).
   *
   * The repository adds nothing to the report: it reads the rows and hands them to
   * {@link verifyEvidenceChain}, so a caller that read the same rows itself gets the same answer.
   *
   * @param tenant_id Tenant that owns the run.
   * @param run_id Run whose chain is verified.
   * @param secret Explicit signing secret; when omitted the process environment is read.
   * @returns The report; `valid` is `true` only when no break was found.
   * @throws Error `AUDIT_SECRET_MISSING` when no signing secret is configured: a verifier that
   * cannot verify signatures may not report `valid`.
   */
  async verifyRunChain(
    tenant_id: string,
    run_id: string,
    secret?: string,
  ): Promise<EvidenceChainReport> {
    const records = await this.readEvidenceChain(tenant_id, run_id);

    return secret === undefined
      ? verifyEvidenceChain(records, { tenant_id, run_id })
      : verifyEvidenceChain(records, { tenant_id, run_id, secret });
  }

  /**
   * Reads the run's operational log in step order (implement/06 §8.2 R16).
   *
   * One row per resolved step, with `execution_status` from the six-value vocabulary and the three
   * instants as ISO-8601 UTC strings.
   *
   * @param tenant_id Tenant that owns the run; also enforced by row-level security.
   * @param run_id Run whose log is read.
   * @returns The stored rows, oldest step first.
   */
  async readRunLogs(tenant_id: string, run_id: string): Promise<readonly AgentRunLog[]> {
    assertIdentifier(tenant_id, 'tenant_id', 36, 'EVIDENCE_INPUT_INVALID');
    assertIdentifier(run_id, 'run_id', 64, 'EVIDENCE_INPUT_INVALID');

    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query<AgentRunLogRow>(SELECT_RUN_LOGS_BY_RUN, [tenant_id, run_id]);

      return result.rows.map(toAgentRunLog);
    });
  }
}

/**
 * The append-only writer and reader of one tenant's audit chain (implement/08 §4.1-§4.2).
 *
 *  * `append()` — one transaction per event: take the advisory lock of the tenant, read the tenant's
 *    durable predecessor, hash the sanitized 18-field projection together with the event time and
 *    insert the link. The engine appends every event of a step (the AUTH-4 pause, each failing
 *    attempt, each retry, the terminal outcome), so the ledger carries the whole story while
 *    `agent_run_logs` carries the resolved step exactly once.
 *  * `readTenantChain()` / `verifyTenantChain()` — the tenant's chain in event order, and the
 *    recomputation that proves it.
 */
export class AuditRepository {
  private readonly runInTenantTransaction: TenantTransactionRunner;

  /**
   * @param runInTenantTransaction Binds a tenant to the transaction every statement runs in.
   * Defaults to the package's `withTenantContext` binder.
   */
  constructor(runInTenantTransaction: TenantTransactionRunner = withTenantContext) {
    this.runInTenantTransaction = runInTenantTransaction;
  }

  /**
   * Appends one event to the tenant's audit chain (implement/08 §4.2).
   *
   * The append is serialized per tenant by `pg_advisory_xact_lock`, and the predecessor is the
   * tenant's durable tail read under that lock — never a value the caller supplies — so two
   * concurrent writers cannot both extend the same link. The event time is hashed in the rendering
   * the column stores, which is why a caller that owns the instant passes it as UTC ISO-8601 with
   * milliseconds.
   *
   * @param record The 18-field event; `timestamp` defaults to `completed_at`, then to now.
   * @throws Error `AUDIT_INPUT_INVALID` when a field cannot be stored as its column requires, or
   *   when the event time is not the rendering the chain hash covers.
   */
  async append(record: AuditRecordInput): Promise<void> {
    const prepared = prepareLedgerRecord(record, 'AUDIT_INPUT_INVALID');
    const timestamp = record.timestamp ?? record.completed_at ?? new Date().toISOString();

    if (!AUDIT_TIMESTAMP_UTC_ISO_MS.test(timestamp)) {
      throw new Error(
        'AUDIT_INPUT_INVALID: timestamp must be UTC ISO-8601 with milliseconds ' +
          `(YYYY-MM-DDTHH:MM:SS.sssZ), the rendering the chain hash covers, so a caller that owns ` +
          `the event time must pass it in that form; received ${String(timestamp)} (implement/08 §4.2).`,
      );
    }

    const payload = buildAuditPayload(record);

    await this.runInTenantTransaction(prepared.tenant_id, async (client): Promise<void> => {
      await client.query(LOCK_CHAIN_SCOPE, [AUDIT_RECORDS, prepared.tenant_id]);

      const tail = await client.query<AuditRecordRow>(SELECT_AUDIT_TAIL, [prepared.tenant_id]);
      const tailRow = tail.rows[0];
      const prev_hash = tailRow === undefined ? GENESIS_HASH : tailRow.chain_hash;
      const chain_hash = auditChainHash({ prev_hash, payload, timestamp });

      const appended = await client.query(INSERT_AUDIT_RECORD, [
        prepared.run_id,
        prepared.tenant_id,
        prepared.agent_id,
        prepared.customer_or_entity_id,
        prepared.trigger,
        prepared.context,
        prepared.skill,
        prepared.tool,
        prepared.decision,
        prepared.authority,
        prepared.approval,
        prepared.action,
        prepared.execution_status,
        prepared.evidence,
        prepared.outcome,
        prepared.latency_ms,
        prepared.cost,
        prepared.error,
        timestamp,
        prev_hash,
        chain_hash,
      ]);

      if (appended.rowCount !== 1) {
        throw new Error(
          `AUDIT_APPEND_UNCONFIRMED: the append of run ${prepared.run_id} affected no row; refusing ` +
            'to report an event the ledger did not store (NFR-002).',
        );
      }
    });
  }

  /**
   * Reads the tenant's audit chain in event order (`timestamp`, then `id`).
   *
   * The read is scoped to one tenant by the transaction binding and by the predicate, so the chain a
   * caller verifies is never spliced with another tenant's records (NFR-006).
   *
   * @param tenant_id Tenant that owns the chain; also enforced by row-level security.
   * @returns The stored records, oldest event first.
   */
  async readTenantChain(tenant_id: string): Promise<readonly AuditRecord[]> {
    assertIdentifier(tenant_id, 'tenant_id', 36, 'AUDIT_INPUT_INVALID');

    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query<AuditRecordRow>(SELECT_AUDIT_BY_TENANT, [tenant_id]);

      return result.rows.map(toAuditRecord);
    });
  }

  /**
   * Reads the tenant's chain and recomputes every link (TC-ORC-007, implement/08 §4.2).
   *
   * @param tenant_id Tenant whose chain is verified.
   * @returns The report; `valid` is `true` only when no break was found.
   */
  async verifyTenantChain(tenant_id: string): Promise<AuditChainReport> {
    const records = await this.readTenantChain(tenant_id);

    return verifyAuditChain(records, { tenant_id });
  }
}