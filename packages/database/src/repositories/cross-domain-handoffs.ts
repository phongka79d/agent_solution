/**
 * @file Durable cross-domain handoff admission on PostgreSQL (implement/04 §3.2.3, §4.1).
 *
 * Invariant: one reservation, one target durable task and one handoff ledger row are admitted in
 * the same tenant transaction. The reservation's effect key is the handoff idempotency key, so a
 * handoff is never admitted twice and the target run is never moved onto a second queue.
 *
 * Why a refusal exists: a different request fingerprint is CONFLICT, an unexpired reservation is
 * IN_FLIGHT, and an expired or failed reservation is RECONCILE_REQUIRED. A FACT evidence reference
 * is also refused unless the authoritative evidence row exists for the source run; caller assertions
 * never promote themselves into persisted facts.
 */

import type { PoolClient, QueryResultRow } from 'pg';

import type {
  AdmitCrossDomainHandoffInput,
  CrossDomainHandoffAdmission,
  CrossDomainHandoffRecord,
  CrossDomainLifecycleRecord,
  EffectReservationRecord,
  HandoffEvidenceRow,
} from '../contracts/index.js';
import { withTenantContext } from '../rls.js';
import { insertDurableTask } from './durable-workflows.js';
import {
  type TenantTransactionRunner,
  insertReservationRow,
  lockReservationRow,
} from './effect-reservations.js';

const HANDOFF_SKILL_ID = 'orchestrator.cross_domain_handoff';
const HANDOFFS = 'agentos.cross_domain_handoffs';
const DEFAULT_HANDOFF_LIMIT = 50;
const MAX_HANDOFF_LIMIT = 200;
const SAVEPOINT = 'cross_domain_handoff_ledger';

const HANDOFF_PROJECTION = `
    id AS handoff_id,
    tenant_id,
    customer_id,
    correlation_id,
    rtrim(idempotency_key) AS idempotency_key,
    rtrim(request_fingerprint) AS request_fingerprint,
    source_domain,
    source_agent,
    source_run_id,
    target_domain,
    target_agent,
    target_module,
    target_run_id,
    reason,
    classification,
    evidence,
    lifecycle_state,
    lifecycle_version,
    hop_count,
    visited_domains,
    occurred_at,
    created_at`;

const SELECT_HANDOFF = `SELECT${HANDOFF_PROJECTION}
  FROM ${HANDOFFS}
  WHERE tenant_id = $1 AND idempotency_key = $2`;

const SELECT_LIFECYCLE = `SELECT
    tenant_id,
    customer_id,
    lifecycle_state AS state,
    lifecycle_version AS version,
    hop_count,
    visited_domains AS domains,
    created_at AS updated_at
  FROM ${HANDOFFS}
  WHERE tenant_id = $1 AND customer_id = $2
  ORDER BY lifecycle_version DESC, id DESC
  LIMIT 1`;

const SELECT_HANDOFFS = `SELECT${HANDOFF_PROJECTION}
  FROM ${HANDOFFS}
  WHERE tenant_id = $1 AND customer_id = $2
  ORDER BY occurred_at, id
  LIMIT $3`;

const VERIFY_FACT = `SELECT 1 AS verified
  FROM agentos.evidences
  WHERE tenant_id = $1
    AND run_id = $2
    AND taxonomy_type = 'FACT'
    AND claim = $3
    AND source_uri = $4
    AND source_version = $5
    AND verified_by = $6
  LIMIT 1`;

const INSERT_HANDOFF = `INSERT INTO ${HANDOFFS} (
    tenant_id,
    customer_id,
    correlation_id,
    idempotency_key,
    request_fingerprint,
    source_domain,
    source_agent,
    source_run_id,
    target_domain,
    target_agent,
    target_module,
    target_run_id,
    reason,
    classification,
    evidence,
    lifecycle_state,
    lifecycle_version,
    hop_count,
    visited_domains,
    occurred_at
  )
  VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
    $11, $12, $13, $14, $15::jsonb, $16, $17, $18, $19::text[], $20::timestamptz
  )
  ON CONFLICT (tenant_id, customer_id, lifecycle_version) DO NOTHING
  RETURNING${HANDOFF_PROJECTION}`;

interface HandoffRow extends QueryResultRow {
  handoff_id: string;
  tenant_id: string;
  customer_id: string;
  correlation_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  source_domain: string;
  source_agent: string;
  source_run_id: string;
  target_domain: string;
  target_agent: string;
  target_module: string;
  target_run_id: string;
  reason: string;
  classification: CrossDomainHandoffRecord['classification'];
  evidence: unknown;
  lifecycle_state: string;
  lifecycle_version: number;
  hop_count: number;
  visited_domains: readonly string[];
  occurred_at: Date | string;
  created_at: Date | string;
}

interface LifecycleRow extends QueryResultRow {
  tenant_id: string;
  customer_id: string;
  state: string;
  version: number;
  hop_count: number;
  domains: readonly string[];
  updated_at: Date | string;
}

function instant(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function evidenceValue(value: unknown): readonly HandoffEvidenceRow[] {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as readonly HandoffEvidenceRow[];
    } catch {
      return [];
    }
  }
  return (Array.isArray(value) ? value : []) as readonly HandoffEvidenceRow[];
}

function toHandoffRecord(row: HandoffRow): CrossDomainHandoffRecord {
  return {
    handoff_id: row.handoff_id,
    tenant_id: row.tenant_id,
    customer_id: row.customer_id,
    correlation_id: row.correlation_id,
    idempotency_key: row.idempotency_key,
    request_fingerprint: row.request_fingerprint,
    source_domain: row.source_domain,
    source_agent: row.source_agent,
    source_run_id: row.source_run_id,
    target_domain: row.target_domain,
    target_agent: row.target_agent,
    target_module: row.target_module,
    target_run_id: row.target_run_id,
    reason: row.reason,
    classification: row.classification,
    evidence: evidenceValue(row.evidence),
    lifecycle_state: row.lifecycle_state,
    lifecycle_version: row.lifecycle_version,
    hop_count: row.hop_count,
    visited_domains: row.visited_domains,
    occurred_at: instant(row.occurred_at),
    created_at: instant(row.created_at),
  };
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === '23505' &&
    (error as { constraint?: unknown }).constraint === constraint
  );
}

function receiptObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function handoffInsertValues(
  input: AdmitCrossDomainHandoffInput,
  target_run_id: string,
): unknown[] {
  return [
    input.tenant_id,
    input.customer_id,
    input.correlation_id,
    input.idempotency_key,
    input.request_fingerprint,
    input.source_domain,
    input.source_agent,
    input.source_run_id,
    input.target_domain,
    input.target_agent,
    input.target_module,
    target_run_id,
    input.reason,
    input.classification,
    JSON.stringify(input.evidence),
    input.lifecycle_state,
    input.lifecycle_version,
    input.hop_count,
    input.visited_domains,
    input.occurred_at,
  ];
}

async function verifyFacts(
  client: PoolClient,
  input: AdmitCrossDomainHandoffInput,
): Promise<void> {
  for (const [index, evidence] of input.evidence.entries()) {
    if (evidence.classification !== 'FACT') continue;

    const result = await client.query(VERIFY_FACT, [
      input.tenant_id,
      input.source_run_id,
      evidence.claim,
      evidence.source_uri,
      evidence.source_version,
      evidence.verified_by,
    ]);

    if (result.rows[0] === undefined) {
      throw new Error(
        `HANDOFF_EVIDENCE_UNVERIFIED: FACT evidence reference ${index} has no authoritative ` +
          `agentos.evidences row for source run ${input.source_run_id} (implement/04 §1.1).`,
      );
    }
  }
}

async function selectHandoff(
  client: PoolClient,
  tenant_id: string,
  idempotency_key: string,
): Promise<CrossDomainHandoffRecord | null> {
  const result = await client.query<HandoffRow>(SELECT_HANDOFF, [tenant_id, idempotency_key]);
  const row = result.rows[0];
  return row === undefined ? null : toHandoffRecord(row);
}

async function insertLedgerRow(
  client: PoolClient,
  input: AdmitCrossDomainHandoffInput,
  target_run_id: string,
): Promise<CrossDomainHandoffRecord | null> {
  const result = await client.query<HandoffRow>(
    INSERT_HANDOFF,
    handoffInsertValues(input, target_run_id),
  );
  const row = result.rows[0];
  return row === undefined ? null : toHandoffRecord(row);
}

async function completeSettledReplay(
  client: PoolClient,
  input: AdmitCrossDomainHandoffInput,
  reservation: EffectReservationRecord,
  receipt: Record<string, unknown> | null,
): Promise<CrossDomainHandoffAdmission> {
  let ledger = await selectHandoff(client, input.tenant_id, input.idempotency_key);
  if (ledger === null) {
    const target_run_id =
      typeof receipt?.target_run_id === 'string' ? receipt.target_run_id : reservation.run_id;
    ledger = await insertLedgerRow(client, input, target_run_id);
    if (ledger === null) {
      ledger = await selectHandoff(client, input.tenant_id, input.idempotency_key);
    }
  }

  if (ledger === null) {
    throw new Error(
      'HANDOFF_REPLAY_LEDGER_MISSING: a settled handoff reservation has no recoverable ledger row; ' +
        'refusing to report a replay without durable handoff identity (implement/04 §4.4).',
    );
  }

  return { kind: 'REPLAY', handoff_id: ledger.handoff_id, run_id: ledger.target_run_id, receipt };
}

async function admitWithRunner(
  input: AdmitCrossDomainHandoffInput,
  runner: TenantTransactionRunner,
): Promise<CrossDomainHandoffAdmission> {
  const nowFn = input.now ?? (() => new Date());
  const now = nowFn();
  if (!Number.isInteger(input.reservation_ttl_ms) || input.reservation_ttl_ms <= 0) {
    throw new Error(
      'HANDOFF_RESERVATION_TTL_INVALID: reservation_ttl_ms must be a positive integer number of ' +
        'milliseconds (implement/04 §3.2.3).',
    );
  }

  const expires_at = new Date(now.getTime() + input.reservation_ttl_ms).toISOString();

  return runner(input.tenant_id, async (client): Promise<CrossDomainHandoffAdmission> => {
    await client.query(`SAVEPOINT ${SAVEPOINT}`);
    await verifyFacts(client, input);

    const reservation = await insertReservationRow(client, {
      tenant_id: input.tenant_id,
      effect_key: input.idempotency_key,
      request_id: input.idempotency_key,
      request_fingerprint: input.request_fingerprint,
      run_id: input.run_id,
      step_index: 0,
      skill_id: HANDOFF_SKILL_ID,
      expires_at,
    });

    if (reservation !== null) {
      try {
        const task = await insertDurableTask(client, {
          tenant_id: input.tenant_id,
          run_id: input.run_id,
          correlation_id: input.correlation_id,
          state: 'queued',
          current_step: 0,
          state_payload: { signal: input.signal },
        });
        const ledger = await insertLedgerRow(client, input, input.run_id);
        if (ledger === null) {
          await client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
          await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
          return { kind: 'CONFLICT' };
        }
        await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
        return { kind: 'ADMITTED', handoff_id: ledger.handoff_id, run_id: input.run_id, task, reservation };
      } catch (error) {
        await client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
        await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
        if (isUniqueViolation(error, 'uq_cross_domain_handoffs_lifecycle')) {
          return { kind: 'CONFLICT' };
        }
        throw error;
      }
    }

    const existing = await lockReservationRow(client, input.tenant_id, input.idempotency_key);
    if (existing === null) {
      throw new Error(
        `HANDOFF_RESERVATION_UNSTABLE: idempotency key ${input.idempotency_key} reported a ` +
          'reservation collision but no row was found under lock (implement/04 §3.2.3).',
      );
    }

    if (existing.request_fingerprint !== input.request_fingerprint) {
      return { kind: 'CONFLICT' };
    }

    const receipt = receiptObject(existing.response_receipt);
    if (existing.status === 'SUCCEEDED' || (existing.status === 'FAILED' && existing.response_receipt !== null)) {
      return completeSettledReplay(client, input, existing, receipt);
    }

    if (existing.status === 'RESERVED') {
      if (existing.expired) {
        return { kind: 'RECONCILE_REQUIRED' };
      }
      const ledger = await selectHandoff(client, input.tenant_id, input.idempotency_key);
      if (ledger === null) {
        throw new Error(
          'HANDOFF_LEDGER_MISSING: a live handoff reservation has no ledger row; refusing to report ' +
            'an in-flight handoff without its durable identity (implement/04 §4.1).',
        );
      }
      return { kind: 'IN_FLIGHT', handoff_id: ledger.handoff_id, run_id: ledger.target_run_id };
    }

    if (existing.status === 'FAILED' || existing.status === 'EXPIRED') {
      return { kind: 'RECONCILE_REQUIRED' };
    }

    throw new Error(
      `HANDOFF_RESERVATION_STATUS_UNKNOWN: idempotency key ${existing.effect_key} carries ` +
        `unhandled status ${String(existing.status)} (implement/04 §3.2.3).`,
    );
  });
}

/** Executes one reservation, target task and ledger admission in one tenant transaction. */
export async function admitCrossDomainHandoff(
  input: AdmitCrossDomainHandoffInput,
): Promise<CrossDomainHandoffAdmission> {
  return admitWithRunner(input, withTenantContext);
}

/** Reads the latest durable lifecycle state for one tenant/customer pair. */
export async function readCrossDomainLifecycle(
  tenant_id: string,
  customer_id: string,
): Promise<CrossDomainLifecycleRecord | null> {
  return withTenantContext(tenant_id, async (client) => {
    const result = await client.query<LifecycleRow>(SELECT_LIFECYCLE, [tenant_id, customer_id]);
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          tenant_id: row.tenant_id,
          customer_id: row.customer_id,
          state: row.state,
          version: row.version,
          hop_count: row.hop_count,
          domains: row.domains,
          updated_at: instant(row.updated_at),
        };
  });
}

/** Reads one handoff by its tenant-scoped idempotency key. */
export async function readCrossDomainHandoff(
  tenant_id: string,
  idempotency_key: string,
): Promise<CrossDomainHandoffRecord | null> {
  return withTenantContext(tenant_id, (client) => selectHandoff(client, tenant_id, idempotency_key));
}

/** Lists a tenant/customer handoff timeline in ascending occurred-at/id order. */
export async function listCrossDomainHandoffs(
  tenant_id: string,
  customer_id: string,
  limit = DEFAULT_HANDOFF_LIMIT,
): Promise<readonly CrossDomainHandoffRecord[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HANDOFF_LIMIT) {
    throw new Error(
      `HANDOFF_LIMIT_INVALID: limit must be an integer between 1 and ${MAX_HANDOFF_LIMIT} ` +
        `(default ${DEFAULT_HANDOFF_LIMIT}); received ${String(limit)} (implement/04 §4.1).`,
    );
  }

  return withTenantContext(tenant_id, async (client) => {
    const result = await client.query<HandoffRow>(SELECT_HANDOFFS, [tenant_id, customer_id, limit]);
    return result.rows.map(toHandoffRecord);
  });
}
