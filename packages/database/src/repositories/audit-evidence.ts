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
 *    triggers are the outer guarantee (NFR-002, the `IMMUTABLE AUDIT TRIGGERS` section of
 *    `0000_agentos_schema.sql`). A stored record is therefore never corrected, only detected: the
 *    verifiers below recompute every digest and report the interior tampering and the missing links
 *    they find instead of repairing anything.
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
 * `sha256CanonicalJson` are reused from `./canonical-json.js`, and the chain formulas are
 * byte-compatible with `durability/evidence.ts`, so a row written here verifies there and the other
 * way round.
 */

import type { QueryResult, QueryResultRow } from 'pg';

import { withTenantContext } from '../rls.js';
import { canonicalizeJson, sha256CanonicalJson } from './canonical-json.js';
import { assertIdentifier, assertPositiveInteger, isPlainObject } from './durable-workflows.js';
import type { TenantTransactionRunner } from './effect-reservations.js';
import {
  GENESIS_HASH,
  assertSha256Digest,
  auditChainHash,
  buildAuditPayload,
  evidenceChainHash,
  requireAuditHmacSecret,
  signEvidenceChainHash,
  verifyAuditChain,
  verifyEvidenceChain,
} from './audit-evidence.chain.js';
import type { AuditChainReport, EvidenceChainReport } from './audit-evidence.chain.js';
import {
  AUDIT_RECORDS,
  EVIDENCE_RECORDS,
  INSERT_AGENT_RUN_LOG,
  INSERT_AUDIT_RECORD,
  INSERT_EVIDENCE_RECORD,
  LOCK_CHAIN_SCOPE,
  SELECT_AUDIT_BY_TENANT,
  SELECT_AUDIT_SERVER_TIMESTAMP,
  SELECT_AUDIT_TAIL,
  SELECT_EVIDENCE_BY_EFFECT,
  SELECT_EVIDENCE_BY_RUN,
  SELECT_EVIDENCE_TAIL,
  SELECT_RUN_LOGS_BY_RUN,
  assertInstant,
  evidenceIdFor,
  prepareLedgerRecord,
  sqlState,
  toAgentRunLog,
  toAuditRecord,
  toEvidenceRecord,
} from './audit-evidence.sql.js';
import type {
  AgentRunLogRow,
  AuditRecordRow,
  AuditServerTimestampRow,
  EvidenceRecordRow,
  AuthorityLevel,
  ExecutionStatus,
} from './audit-evidence.sql.js';

export { AUDIT_HMAC_SECRET_ENV, GENESIS_HASH } from './audit-evidence.chain.js';
export { AUTHORITY_LEVELS, EXECUTION_STATUSES } from './audit-evidence.sql.js';
export type { AuthorityLevel, ExecutionStatus } from './audit-evidence.sql.js';
export {
  assertSha256Digest,
  auditChainHash,
  buildAuditPayload,
  evidenceChainHash,
  requireAuditHmacSecret,
  signEvidenceChainHash,
  verifyAuditChain,
  verifyEvidenceChain,
} from './audit-evidence.chain.js';
export type {
  AuditChainReport,
  ChainBreak,
  ChainBreakKind,
  ChainReport,
  EvidenceChainReport,
} from './audit-evidence.chain.js';



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
  /** PostgreSQL publishes the tenant-local BIGINT sequence as a decimal string. */
  readonly chain_seq: string;
  /** Audit event time as the hashed byte contract renders it: UTC ISO-8601 with milliseconds. */
  readonly timestamp: string;
  /** Predecessor's `chain_hash`; {@link GENESIS_HASH} for the tenant's first record. */
  readonly prev_hash: string;
  /** SHA-256 over `prev_hash | CanonicalJSON(payload) | timestamp`. */
  readonly chain_hash: string;
}

/**
 * Input of {@link AuditRepository.append}: the 18 mapped fields of one audit event.
 *
 * The optional operational members let a full `AgentRunLogRecord` bind to this method verbatim
 * (that is the `IAuditTrail` port's signature); they are not part of the hashed projection.
 * `timestamp` is accepted for source compatibility but deliberately ignored: the database clock
 * owns the stored event time and the chain ordering is {@link AuditRecord.chain_seq}.
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
  /** Legacy caller event-time hint; ignored in favor of the server clock. */
  readonly timestamp?: string;
  readonly step_index?: number;
  readonly started_at?: string;
  readonly completed_at?: string;
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
  async findEvidence(input: { tenant_id: string; run_id: string; effect_key: string; step_index: number }): Promise<ImmutableEvidenceRecord | null> {
    assertIdentifier(input.tenant_id, 'tenant_id', 36, 'EVIDENCE_INPUT_INVALID');
    assertIdentifier(input.run_id, 'run_id', 64, 'EVIDENCE_INPUT_INVALID');
    assertIdentifier(input.effect_key, 'effect_key', 128, 'EVIDENCE_INPUT_INVALID');
    if (!Number.isInteger(input.step_index) || input.step_index < 1) throw new Error('EVIDENCE_INPUT_INVALID: step_index must be a positive integer');
    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const result = await client.query<EvidenceRecordRow>(
        SELECT_EVIDENCE_BY_EFFECT,
        [input.tenant_id, input.run_id, input.effect_key, input.step_index],
      );
      return result.rows[0] === undefined ? null : toEvidenceRecord(result.rows[0]);
    });
  }

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
   * tenant's durable tail read under that lock — never a value the caller supplies. The database
   * assigns `chain_seq` in the INSERT and supplies the UTC-millisecond event timestamp via
   * `clock_timestamp()`, so skewed caller clocks cannot fork or reorder the chain.
   *
   * @param record The 18-field event; any legacy `timestamp` hint is ignored.
   * @throws Error `AUDIT_APPEND_UNCONFIRMED` when the insert does not publish a row.
   */
  async append(record: AuditRecordInput): Promise<void> {
    const prepared = prepareLedgerRecord(record, 'AUDIT_INPUT_INVALID');
    const payload = buildAuditPayload(record);

    await this.runInTenantTransaction(prepared.tenant_id, async (client): Promise<void> => {
      await client.query(LOCK_CHAIN_SCOPE, [AUDIT_RECORDS, prepared.tenant_id]);

      const tail = await client.query<AuditRecordRow>(SELECT_AUDIT_TAIL, [prepared.tenant_id]);
      const tailRow = tail.rows[0];
      const prev_hash = tailRow === undefined ? GENESIS_HASH : tailRow.chain_hash;

      const serverTime = await client.query<AuditServerTimestampRow>(
        SELECT_AUDIT_SERVER_TIMESTAMP,
      );
      const serverTimeRow = serverTime.rows[0];

      if (serverTimeRow === undefined || !(serverTimeRow.server_timestamp instanceof Date)) {
        throw new Error(
          `AUDIT_SERVER_TIME_UNCONFIRMED: the database did not publish a server timestamp for run ` +
            `${prepared.run_id}; refusing to hash an event against a caller clock (NFR-002).`,
        );
      }

      const timestamp = serverTimeRow.server_timestamp.toISOString();
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
   * Reads the tenant's audit chain in database sequence order (`chain_seq`, then `id`).
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