/**
 * @file In-memory evidence / outcome logger (implement/04 §6.1–§6.2).
 *
 * Implements `IEvidenceLogger` as a test/composition binding of the canonical chained compliance
 * writer. The cryptography is the specification's, byte for byte:
 *
 *   payload_sha256 = hex(SHA-256(RFC 8785 canonical payload))
 *   chain_hash     = hex(SHA-256(`${previous_evidence_hash}|${payload_sha256}|${effect_key}|${step_index}`))
 *   signature      = hex(HMAC-SHA256(hmacSecret, chain_hash))
 *
 * The secret is constructor-injected and mandatory: there is no `process.env` fallback and no
 * literal default, because a chain anyone can re-sign is not evidence (NFR-002). An empty secret
 * fails the write with `AUDIT_SECRET_MISSING` and persists nothing.
 *
 * The chain cursor belongs to the caller (the orchestrator threads `previous_evidence_hash` from
 * the checkpoint, starting at `GENESIS_HASH`), so this binding never invents a predecessor hash and
 * never rewrites an appended record: records and Agent Run rows are append-only, and the outcome
 * watcher is unique per `(tenant_id, effect_key)` so a replay is a no-op instead of a second
 * watcher for the same effect.
 *
 * No method here produces a `BusinessOutcome`: revenue is only ever recorded from a verified
 * provider/attribution source (§6.2), never synthesized by the writer.
 */

import { createHash, createHmac } from 'node:crypto';

import type { IEvidenceLogger } from '../contracts/ports.js';
import {
  OrchestratorError,
  type AgentRunLogRecord,
  type ImmutableEvidenceRecord,
} from '../contracts/types.js';
import { canonicalizeJson } from '../effects/canonical-json.js';

/** §6.2 `pending_outcome_attributions.expires_at` — the 72-hour idempotency window. */
const OUTCOME_WATCH_WINDOW_MS = 72 * 60 * 60 * 1000;

/** An appended evidence record plus the canonical bytes its digest was computed over (§6.2
 * `evidence_records.raw_payload`). */
export interface StoredEvidenceRecord extends ImmutableEvidenceRecord {
  readonly raw_payload: string;
}

/** One `pending_outcome_attributions` row as this binding stores it. */
export interface OutcomeWatch {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly effect_key: string;
  readonly skill_id: string;
  readonly status: 'OBSERVING';
  readonly created_at: string;
  readonly expires_at: string;
}

export interface MemoryEvidenceLoggerOptions {
  /** Injectable clock (milliseconds since epoch) for deterministic timestamps and watch expiry. */
  readonly now?: () => number;
}

export class MemoryEvidenceLogger implements IEvidenceLogger {
  private readonly evidence = new Map<string, StoredEvidenceRecord[]>();
  /** Row's primary key `(tenant_id, run_id, skill, step_index)`, seen — the append-only gate. */
  private readonly agentRunKeys = new Set<string>();
  /** Appended rows per `(tenant_id, run_id)`, append order — what `listAgentRuns()` reads. */
  private readonly agentRuns = new Map<string, AgentRunLogRecord[]>();
  private readonly outcomeWatches = new Map<string, OutcomeWatch>();
  private readonly hmacSecret: string;
  private readonly now: () => number;

  constructor(hmacSecret: string, options: MemoryEvidenceLoggerOptions = {}) {
    this.hmacSecret = hmacSecret;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Appends one immutable, chained evidence record.
   *
   * @param params The step identity, the caller's chain cursor and the raw payload. The returned
   *   record echoes `previous_evidence_hash` unchanged: linking is the caller's contract per §6.1
   *   step 3, and this writer must not invent a predecessor.
   * @throws {OrchestratorError} `AUDIT_SECRET_MISSING` (empty secret, nothing written),
   *   `EVIDENCE_CHAIN_BROKEN` (empty predecessor hash, nothing written),
   *   `CANONICAL_JSON_UNSUPPORTED` (the payload has no canonical form, so its digest would not be
   *   reproducible).
   */
  public async createImmutableRecord(params: {
    run_id: string;
    tenant_id: string;
    correlation_id: string;
    step_index: number;
    effect_key: string;
    previous_evidence_hash: string;
    payload: Record<string, unknown>;
  }): Promise<ImmutableEvidenceRecord> {
    // Fail closed BEFORE hashing: a misconfigured logger must not leave an unsigned chain behind.
    if (this.hmacSecret.length === 0) {
      throw new OrchestratorError(
        'AUDIT_SECRET_MISSING',
        'A non-empty HMAC secret is required to sign evidence records; an unsigned chain is not an audit chain (NFR-002).',
      );
    }
    if (params.previous_evidence_hash.length === 0) {
      throw new OrchestratorError(
        'EVIDENCE_CHAIN_BROKEN',
        `Evidence for step ${params.step_index} of run '${params.run_id}' has no predecessor hash; the first record of a run starts at GENESIS_HASH.`,
      );
    }

    const raw_payload = canonicalizeJson(params.payload);
    const payload_sha256 = sha256Hex(raw_payload);
    const chain_hash = sha256Hex(
      `${params.previous_evidence_hash}|${payload_sha256}|${params.effect_key}|${params.step_index}`,
    );
    const signature = createHmac('sha256', this.hmacSecret).update(chain_hash, 'utf8').digest('hex');
    // Deterministic identity of the append: `sha256(tenant|run|effect_key|step_index)`, never a
    // random UUID, so a retried writer addresses the same row instead of minting a second one.
    const evidence_id = `ev_${sha256Hex(
      `${params.tenant_id}|${params.run_id}|${params.effect_key}|${params.step_index}`,
    ).slice(0, 16)}`;

    const record: ImmutableEvidenceRecord = {
      evidence_id,
      run_id: params.run_id,
      tenant_id: params.tenant_id,
      correlation_id: params.correlation_id,
      step_index: params.step_index,
      effect_key: params.effect_key,
      previous_evidence_hash: params.previous_evidence_hash,
      payload_sha256,
      chain_hash,
      signature,
      created_at: new Date(this.now()).toISOString(),
    };

    const key = scopedKey(params.tenant_id, params.run_id);
    const existing = this.evidence.get(key);
    if (existing === undefined) {
      this.evidence.set(key, [{ ...record, raw_payload }]);
    } else {
      existing.push({ ...record, raw_payload });
    }

    return record;
  }

  /**
   * Appends one canonical Agent Run row.
   *
   * Append-only: `(tenant_id, run_id, skill, step_index)` is the row's primary key (§6.2), so a
   * second append for the same step is a programming error — the step's single row is written when
   * the step reaches a terminal disposition, and a retry or reconciliation is a distinct attempt
   * recorded in the audit trail, not a second row for the same step.
   *
   * The row is stored under its identity key (the append-only gate) *and* appended to the
   * `(tenant_id, run_id)` list `listAgentRuns()` reads back in append order.
   *
   * @throws {OrchestratorError} `EVIDENCE_APPEND_ONLY_VIOLATION` on a duplicate key.
   */
  public async logAgentRun(runLog: AgentRunLogRecord): Promise<void> {
    const identity = scopedKey(
      runLog.tenant_id,
      runLog.run_id,
      runLog.skill,
      String(runLog.step_index),
    );
    if (this.agentRunKeys.has(identity)) {
      throw new OrchestratorError(
        'EVIDENCE_APPEND_ONLY_VIOLATION',
        `Agent Run row '${runLog.skill}' step ${runLog.step_index} of run '${runLog.run_id}' already exists; the log is append-only.`,
      );
    }

    const runKey = scopedKey(runLog.tenant_id, runLog.run_id);
    const rows = this.agentRuns.get(runKey);
    if (rows === undefined) {
      this.agentRuns.set(runKey, [{ ...runLog }]);
    } else {
      rows.push({ ...runLog });
    }
    this.agentRunKeys.add(identity);
  }

  /**
   * Registers the asynchronous outcome watcher for an effect.
   *
   * Unique per `(tenant_id, effect_key)`: a replayed step registers nothing new, so one external
   * effect can never be attributed twice or watched by two competing rows (§6.2).
   */
  public async initializeOutcomeWatch(params: {
    tenant_id: string;
    run_id: string;
    effect_key: string;
    skill_id: string;
  }): Promise<void> {
    const key = scopedKey(params.tenant_id, params.effect_key);
    if (this.outcomeWatches.has(key)) {
      return;
    }
    const startedAt = this.now();
    this.outcomeWatches.set(key, {
      tenant_id: params.tenant_id,
      run_id: params.run_id,
      effect_key: params.effect_key,
      skill_id: params.skill_id,
      status: 'OBSERVING',
      created_at: new Date(startedAt).toISOString(),
      expires_at: new Date(startedAt + OUTCOME_WATCH_WINDOW_MS).toISOString(),
    });
  }

  /** Appended evidence records of one run, oldest first, with their canonical `raw_payload`. */
  public listEvidence(tenant_id: string, run_id: string): readonly StoredEvidenceRecord[] {
    return (this.evidence.get(scopedKey(tenant_id, run_id)) ?? []).map((record) => ({ ...record }));
  }

  /** Appended Agent Run rows of one run, in append order. */
  public listAgentRuns(tenant_id: string, run_id: string): readonly AgentRunLogRecord[] {
    return (this.agentRuns.get(scopedKey(tenant_id, run_id)) ?? []).map((runLog) => ({ ...runLog }));
  }

  /** The outcome watcher bound to an effect, or null when no watch was ever registered. */
  public getOutcomeWatch(tenant_id: string, effect_key: string): OutcomeWatch | null {
    const watch = this.outcomeWatches.get(scopedKey(tenant_id, effect_key));
    return watch === undefined ? null : { ...watch };
  }
}

/** Composite store key: NUL-separated so `tenant_id` + identity can never collide by concatenation. */
function scopedKey(...parts: readonly string[]): string {
  return parts.join('\u0000');
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
