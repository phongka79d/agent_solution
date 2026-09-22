import { createHash, createHmac } from 'node:crypto';

import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { canonicalizeJson } from './approvals.js';
import {
  AUDIT_HMAC_SECRET_ENV,
  AuditRepository,
  EvidenceRepository,
  GENESIS_HASH,
  auditChainHash,
  buildAuditPayload,
  evidenceChainHash,
  signEvidenceChainHash,
  verifyAuditChain,
  verifyEvidenceChain,
} from './audit-evidence.js';
import type {
  AgentRunLog,
  AgentRunLogRecord,
  AuditRecord,
  AuditRecordInput,
  ChainBreak,
  ChainBreakKind,
  ImmutableEvidenceRecord,
} from './audit-evidence.js';
import type { TenantTransactionRunner } from './effect-reservations.js';

/**
 * Unit suite for the append-only evidence, run-log and audit chains (implement/04 §6.1,
 * implement/08 §4.1-§4.2, TC-ORC-007).
 *
 * Every expectation is recomputed here with `node:crypto` from the documented byte contracts —
 * `SHA-256(previous | payload_sha256 | effect_key | step_index)` and
 * `SHA-256(prev_hash | CanonicalJSON(payload) | timestamp)`, the HMAC over the evidence link — so a
 * test fails when the module and the contract disagree, not when two copies of the same computation
 * agree. The fixture rows are Date-carrying objects exactly as `pg` returns them.
 *
 * The repository is exercised against a scripted `pg` client that classifies every statement it
 * issues: anything that is not the advisory lock, a read of one of the three tables, or an `INSERT`
 * into one of them fails the suite. That is how the append-only discipline (NFR-002) is asserted as
 * observed behavior — an `UPDATE` or a `DELETE` would be classified here and rejected — instead of
 * being asserted about the module's source text. The live half (the immutability triggers, RLS
 * denial, the `CHECK` constraints) belongs to `src/rls.test.ts` and the migration rehearsal, and is
 * not duplicated here.
 */

/** Tenant bound to every statement; the repository is tenant-scoped by construction (NFR-006). */
const TENANT = '11111111-1111-1111-1111-111111111111';
const RUN_ID = 'RUN-1';
const CORRELATION_ID = 'CORR-1';

/** The signing secret the cases pass explicitly; the fail-closed cases delete the environment. */
const SECRET = 'unit-test-audit-secret';

const CREATED_AT = new Date('2026-01-01T00:00:02.000Z');
const STARTED_AT = '2026-01-01T00:00:00.000Z';
const COMPLETED_AT = '2026-01-01T00:00:01.000Z';

/** Two step payloads with a distinct canonical form, so a swapped record is visible. */
const FIRST_PAYLOAD = { order: 'ORD-1', step: 1 };
const SECOND_PAYLOAD = { order: 'ORD-1', step: 2 };

const FIRST_PAYLOAD_CANONICAL = '{"order":"ORD-1","step":1}';

/**
 * `SHA-256` over the documented `|`-joined byte contract, computed by this file alone.
 *
 * The chain formulas are the module's own contract, so they are recomputed from `node:crypto` here
 * rather than called: an expectation that called `evidenceChainHash` would pass for a wrong order of
 * the joined parts as well.
 */
function sha256(...parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('|'), 'utf8').digest('hex');
}

function sha256CanonicalValue(value: unknown): string {
  return createHash('sha256').update(canonicalizeJson(value), 'utf8').digest('hex');
}

/** The record at `index`; a missing fixture fails loudly instead of being compared as `undefined`. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];

  if (item === undefined) {
    throw new Error(`FIXTURE_MISSING: no fixture at index ${index}.`);
  }

  return item;
}

/** The first break of a report that carries `kind`, whatever else the report found. */
function breakFor(report: { readonly breaks: readonly ChainBreak[] }, kind: ChainBreakKind): ChainBreak | undefined {
  return report.breaks.find((candidate) => candidate.kind === kind);
}

/* ------------------------------------------------------------------------------------------------
 * Fixture rows, built from the byte contracts like the writer would
 * ---------------------------------------------------------------------------------------------- */

/** One evidence record as the writer stores it, with every digest recomputed by this file. */
function evidenceRecord(params: {
  step_index: number;
  effect_key: string;
  payload: Record<string, unknown>;
  previous_evidence_hash: string;
}): ImmutableEvidenceRecord {
  const payload_sha256 = sha256CanonicalValue(params.payload);
  const chain_hash = sha256(
    params.previous_evidence_hash,
    payload_sha256,
    params.effect_key,
    String(params.step_index),
  );

  return {
    evidence_id: `ev_${sha256(TENANT, RUN_ID, params.effect_key, String(params.step_index)).slice(0, 16)}`,
    run_id: RUN_ID,
    tenant_id: TENANT,
    correlation_id: CORRELATION_ID,
    step_index: params.step_index,
    effect_key: params.effect_key,
    previous_evidence_hash: params.previous_evidence_hash,
    payload_sha256,
    chain_hash,
    signature: createHmac('sha256', SECRET).update(chain_hash, 'utf8').digest('hex'),
    raw_payload: params.payload,
    created_at: CREATED_AT.toISOString(),
  };
}

/** A genesis-linked chain of `steps`, each link carrying its predecessor's `chain_hash`. */
function evidenceChain(
  steps: readonly { step_index: number; effect_key: string; payload: Record<string, unknown> }[],
): readonly ImmutableEvidenceRecord[] {
  const records: ImmutableEvidenceRecord[] = [];
  let previous = GENESIS_HASH;

  for (const step of steps) {
    const record = evidenceRecord({ ...step, previous_evidence_hash: previous });

    records.push(record);
    previous = record.chain_hash;
  }

  return records;
}

/** The canonical 18-field audit event of one step. */
function auditEvent(overrides: Partial<AuditRecordInput> = {}): AuditRecordInput {
  const record: AuditRecordInput = {
    run_id: RUN_ID,
    tenant_id: TENANT,
    agent_id: 'agent-sales-01',
    customer_or_entity_id: 'CUST-1',
    trigger: 'product.inquiry',
    context: { session: 'S-1' },
    skill: 'skill.sales.create_order',
    step_index: 3,
    tool: 'order_connector',
    decision: { verdict: 'ALLOW' },
    authority: 'AUTH-3',
    approval: null,
    action: { type: 'create_order' },
    execution_status: 'success',
    evidence: { evidence_id: 'ev_1' },
    outcome: { order_id: 'ORD-1' },
    latency_ms: 120,
    cost: { tokens: 10 },
    error: null,
    started_at: STARTED_AT,
    completed_at: COMPLETED_AT,
  };

  return Object.assign(record, overrides);
}

/**
 * One audit record as the writer stores it, chained with the tenant predecessor it was given.
 *
 * The 18 mapped fields are listed explicitly, and the operational `step_index` / `started_at` /
 * `completed_at` of the input are deliberately absent: `audit_records` stores neither, so a read
 * that republished them would not equal this fixture.
 */
function auditRecord(
  input: AuditRecordInput,
  prev_hash: string,
  timestamp: string,
  id = '0193f000-0000-7000-8000-000000000001',
): AuditRecord {
  return {
    id,
    run_id: input.run_id,
    tenant_id: input.tenant_id,
    agent_id: input.agent_id,
    customer_or_entity_id: input.customer_or_entity_id,
    trigger: input.trigger,
    context: input.context,
    skill: input.skill,
    tool: input.tool,
    decision: input.decision,
    authority: input.authority,
    approval: input.approval ?? null,
    action: input.action,
    execution_status: input.execution_status,
    evidence: input.evidence,
    outcome: input.outcome ?? null,
    latency_ms: input.latency_ms,
    cost: input.cost,
    error: input.error ?? null,
    timestamp,
    prev_hash,
    chain_hash: sha256(prev_hash, canonicalizeJson(buildAuditPayload(input)), timestamp),
  };
}

/** A tenant chase of `events`, each link carrying the predecessor's `chain_hash`. */
function auditChain(
  events: readonly { input: AuditRecordInput; timestamp: string }[],
): readonly AuditRecord[] {
  const records: AuditRecord[] = [];
  let previous = GENESIS_HASH;

  for (const [index, event] of events.entries()) {
    const record = auditRecord(
      event.input,
      previous,
      event.timestamp,
      `0193f000-0000-7000-8000-${String(index + 1).padStart(12, '0')}`,
    );

    records.push(record);
    previous = record.chain_hash;
  }

  return records;
}

/** The canonical 18-field operational run log of one resolved step. */
function runLogRecord(overrides: Partial<AgentRunLogRecord> = {}): AgentRunLogRecord {
  const record: AgentRunLogRecord = {
    run_id: RUN_ID,
    tenant_id: TENANT,
    agent_id: 'agent-sales-01',
    customer_or_entity_id: 'CUST-1',
    trigger: 'product.inquiry',
    context: { session: 'S-1', channel: 'web' },
    skill: 'skill.sales.create_order',
    step_index: 3,
    tool: 'order_connector',
    decision: { verdict: 'ALLOW' },
    authority: 'AUTH-3',
    approval: null,
    action: { type: 'create_order' },
    execution_status: 'success',
    evidence: { evidence_id: 'ev_1' },
    outcome: { order_id: 'ORD-1' },
    latency_ms: 120,
    cost: { tokens: 10 },
    error: null,
    started_at: STARTED_AT,
    completed_at: COMPLETED_AT,
  };

  return Object.assign(record, overrides);
}

function storedRunLog(overrides: Partial<AgentRunLog> = {}): AgentRunLog {
  return {
    ...runLogRecord(),
    created_at: CREATED_AT.toISOString(),
    ...overrides,
  };
}

/**
 * A stored row as `pg` publishes it: the same columns, with every `TIMESTAMPTZ` handed back as a
 * `Date` — which is what the row mappers have to render as ISO-8601 UTC strings.
 */
function rowOf(record: ImmutableEvidenceRecord | AuditRecord | AgentRunLog): QueryResultRow {
  if ('evidence_id' in record) {
    return { ...record, created_at: new Date(record.created_at) };
  }

  if ('prev_hash' in record) {
    return { ...record, timestamp: new Date(record.timestamp) };
  }

  return {
    ...record,
    started_at: new Date(record.started_at),
    completed_at: new Date(record.completed_at),
    created_at: CREATED_AT,
  };
}

/* ------------------------------------------------------------------------------------------------
 * Scripted `pg` client
 * ---------------------------------------------------------------------------------------------- */

/**
 * Which statement of the module a SQL text is. The eight kinds below are the module's whole SQL
 * vocabulary: the advisory lock, one read and one insert per table. A statement that is anything
 * else — an `UPDATE`, a `DELETE`, a statement of a table this module must not touch — raises here,
 * so every case of this suite doubles as a check that the module only ever appends.
 */
type StatementKind =
  | 'lock'
  | 'evidence_tail'
  | 'evidence_read'
  | 'evidence_insert'
  | 'run_log_insert'
  | 'run_log_read'
  | 'audit_tail'
  | 'audit_read'
  | 'audit_insert';

function classify(sql: string): StatementKind {
  if (sql.startsWith('SELECT pg_advisory_xact_lock')) {
    return 'lock';
  }

  if (sql.startsWith('INSERT INTO agentos.evidence_records')) {
    return 'evidence_insert';
  }

  if (sql.startsWith('INSERT INTO agentos.agent_run_logs')) {
    return 'run_log_insert';
  }

  if (sql.startsWith('INSERT INTO agentos.audit_records')) {
    return 'audit_insert';
  }

  if (sql.includes('FROM agentos.evidence_records')) {
    return sql.includes('DESC') ? 'evidence_tail' : 'evidence_read';
  }

  if (sql.includes('FROM agentos.agent_run_logs')) {
    return 'run_log_read';
  }

  if (sql.includes('FROM agentos.audit_records')) {
    return sql.includes('DESC') ? 'audit_tail' : 'audit_read';
  }

  throw new Error(
    `SCRIPTED_STATEMENT_UNKNOWN: no case scripts the statement "${sql}"; the module appends and ` +
      'reads, so anything else is a defect this suite refuses to answer.',
  );
}

/** The `pg` result of one statement, as a case scripts it. */
interface ScriptedAnswer {
  /** Rows a `SELECT` / `INSERT ... RETURNING` returns. */
  readonly rows?: readonly QueryResultRow[];
  /** `rowCount` of the statement; omitted means the number of scripted rows. */
  readonly rowCount?: number | null;
  /** Error `pg` raises for this statement instead of a result. */
  readonly fails?: unknown;
}

type ScriptedAnswers = Partial<Record<StatementKind, ScriptedAnswer>>;

/** One statement the module issued, with the parameters `pg` would have received. */
interface IssuedStatement {
  readonly kind: StatementKind;
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** Deterministic stand-in for the `pg` client of one tenant transaction. */
class ScriptedClient {
  readonly statements: IssuedStatement[] = [];

  private readonly answers: ScriptedAnswers;

  constructor(answers: ScriptedAnswers) {
    this.answers = answers;
  }

  async query<R extends QueryResultRow>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<R>> {
    const kind = classify(sql);
    this.statements.push({ kind, sql, params });

    const answer = this.answers[kind];

    if (answer === undefined) {
      throw new Error(`SCRIPTED_ANSWER_MISSING: no case scripts a ${kind} statement.`);
    }

    if (answer.fails !== undefined) {
      throw answer.fails;
    }

    const rows = (answer.rows ?? []) as unknown as R[];

    return {
      rows,
      rowCount: answer.rowCount === undefined ? rows.length : answer.rowCount,
    } as QueryResult<R>;
  }
}

/** The repositories wired to one scripted client, plus the tenants their transactions bound. */
interface RepositoryHarness {
  readonly evidence: EvidenceRepository;
  readonly audit: AuditRepository;
  readonly client: ScriptedClient;
  readonly boundTenants: string[];
}

function harnessFor(answers: ScriptedAnswers): RepositoryHarness {
  const client = new ScriptedClient({ lock: { rows: [] }, ...answers });
  const boundTenants: string[] = [];
  const runInTenantTransaction: TenantTransactionRunner = async (tenant_id, work) => {
    boundTenants.push(tenant_id);

    return work(client as unknown as PoolClient);
  };

  return {
    evidence: new EvidenceRepository(runInTenantTransaction),
    audit: new AuditRepository(runInTenantTransaction),
    client,
    boundTenants,
  };
}

/** The parameters bound to the single statement of `kind`; fails when it was never issued. */
function bindingsOf(client: ScriptedClient, kind: StatementKind): readonly unknown[] {
  const statement = client.statements.find((candidate) => candidate.kind === kind);

  if (statement === undefined) {
    throw new Error(`SCRIPTED_STATEMENT_MISSING: no ${kind} statement was issued.`);
  }

  return statement.params;
}

/** The statements the module issued, in order. */
function issuedKinds(client: ScriptedClient): readonly StatementKind[] {
  return client.statements.map((statement) => statement.kind);
}

/** The message of the error `work` failed with; fails the test when it did not fail. */
async function refusalOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error('EXPECTED_REFUSAL: the call succeeded, but the append-only rule must refuse it.');
}

const previousSecret = process.env[AUDIT_HMAC_SECRET_ENV];

beforeEach(() => {
  // The fail-closed cases are about an UNSET secret, so the environment is cleared for every case
  // and the cases that write pass the secret explicitly.
  delete process.env[AUDIT_HMAC_SECRET_ENV];
});

afterEach(() => {
  if (previousSecret === undefined) {
    delete process.env[AUDIT_HMAC_SECRET_ENV];
  } else {
    process.env[AUDIT_HMAC_SECRET_ENV] = previousSecret;
  }
});

describe('chain primitives', () => {
  it('hashes the documented byte contracts', () => {
    const payload_sha256 = sha256CanonicalValue(FIRST_PAYLOAD);
    const chain_hash = sha256(GENESIS_HASH, payload_sha256, 'EK-1', '1');
    const payload = { run_id: RUN_ID, execution_status: 'success' };

    expect(
      evidenceChainHash({
        previous_evidence_hash: GENESIS_HASH,
        payload_sha256,
        effect_key: 'EK-1',
        step_index: 1,
      }),
    ).toBe(chain_hash);

    expect(signEvidenceChainHash(chain_hash, SECRET)).toBe(
      createHmac('sha256', SECRET).update(chain_hash, 'utf8').digest('hex'),
    );

    expect(
      auditChainHash({ prev_hash: GENESIS_HASH, payload, timestamp: COMPLETED_AT }),
    ).toBe(sha256(GENESIS_HASH, canonicalizeJson(payload), COMPLETED_AT));
  });

  it('hashes exactly the 18 mapped run fields and no operational field', () => {
    const payload = buildAuditPayload(auditEvent());

    expect(Object.keys(payload).sort()).toEqual([
      'action',
      'agent_id',
      'approval',
      'authority',
      'context',
      'cost',
      'customer_or_entity_id',
      'decision',
      'error',
      'evidence',
      'execution_status',
      'latency_ms',
      'outcome',
      'run_id',
      'skill',
      'tenant_id',
      'tool',
      'trigger',
    ]);
    expect(payload.step_index).toBeUndefined();
    expect(payload.started_at).toBeUndefined();
    expect(payload.completed_at).toBeUndefined();
  });
});

describe('EvidenceRepository.appendEvidence', () => {
  it('links a run\'s first record to the genesis digest under the chain lock', async () => {
    const expected = evidenceRecord({
      step_index: 1,
      effect_key: 'EK-1',
      payload: FIRST_PAYLOAD,
      previous_evidence_hash: GENESIS_HASH,
    });
    const { evidence, client, boundTenants } = harnessFor({
      evidence_tail: { rows: [] },
      evidence_insert: { rows: [rowOf(expected)] },
    });

    const record = await evidence.appendEvidence({
      tenant_id: TENANT,
      run_id: RUN_ID,
      correlation_id: CORRELATION_ID,
      step_index: 1,
      effect_key: 'EK-1',
      payload: FIRST_PAYLOAD,
      secret: SECRET,
    });

    expect(record).toEqual(expected);
    expect(boundTenants).toEqual([TENANT]);
    expect(issuedKinds(client)).toEqual(['lock', 'evidence_tail', 'evidence_insert']);
    expect(bindingsOf(client, 'lock')).toEqual(['agentos.evidence_records', `${TENANT}|${RUN_ID}`]);
    expect(bindingsOf(client, 'evidence_tail')).toEqual([TENANT, RUN_ID]);
    expect(bindingsOf(client, 'evidence_insert')).toEqual([
      expected.evidence_id,
      TENANT,
      RUN_ID,
      CORRELATION_ID,
      1,
      'EK-1',
      GENESIS_HASH,
      expected.payload_sha256,
      expected.chain_hash,
      expected.signature,
      FIRST_PAYLOAD_CANONICAL,
      null,
    ]);
  });

  it('links the next record to the durable predecessor instead of the caller\'s cursor', async () => {
    const previous = evidenceRecord({
      step_index: 1,
      effect_key: 'EK-1',
      payload: FIRST_PAYLOAD,
      previous_evidence_hash: GENESIS_HASH,
    });
    const expected = evidenceRecord({
      step_index: 2,
      effect_key: 'EK-2',
      payload: SECOND_PAYLOAD,
      previous_evidence_hash: previous.chain_hash,
    });
    const { evidence, client } = harnessFor({
      evidence_tail: { rows: [rowOf(previous)] },
      evidence_insert: { rows: [rowOf(expected)] },
    });

    const record = await evidence.appendEvidence({
      tenant_id: TENANT,
      run_id: RUN_ID,
      correlation_id: CORRELATION_ID,
      step_index: 2,
      effect_key: 'EK-2',
      payload: SECOND_PAYLOAD,
      previous_evidence_hash: previous.chain_hash,
      secret: SECRET,
    });

    expect(record).toEqual(expected);
    expect(bindingsOf(client, 'evidence_insert')).toEqual([
      expected.evidence_id,
      TENANT,
      RUN_ID,
      CORRELATION_ID,
      2,
      'EK-2',
      previous.chain_hash,
      expected.payload_sha256,
      expected.chain_hash,
      expected.signature,
      canonicalizeJson(SECOND_PAYLOAD),
      null,
    ]);
  });

  it('refuses a stale cursor instead of linking to a predecessor the chain does not carry', async () => {
    const tail = evidenceRecord({
      step_index: 1,
      effect_key: 'EK-1',
      payload: FIRST_PAYLOAD,
      previous_evidence_hash: GENESIS_HASH,
    });
    const { evidence, client } = harnessFor({ evidence_tail: { rows: [rowOf(tail)] } });

    const message = await refusalOf(
      evidence.appendEvidence({
        tenant_id: TENANT,
        run_id: RUN_ID,
        correlation_id: CORRELATION_ID,
        step_index: 2,
        effect_key: 'EK-2',
        payload: SECOND_PAYLOAD,
        previous_evidence_hash: GENESIS_HASH,
        secret: SECRET,
      }),
    );

    expect(message).toContain('EVIDENCE_CHAIN_STALE');
    expect(message).toContain(tail.chain_hash);
    expect(issuedKinds(client)).toEqual(['lock', 'evidence_tail']);
  });

  it('refuses to append without a configured signing secret', async () => {
    const { evidence, client, boundTenants } = harnessFor({});

    const message = await refusalOf(
      evidence.appendEvidence({
        tenant_id: TENANT,
        run_id: RUN_ID,
        correlation_id: CORRELATION_ID,
        step_index: 1,
        effect_key: 'EK-1',
        payload: FIRST_PAYLOAD,
      }),
    );

    expect(message).toContain('AUDIT_SECRET_MISSING');
    expect(boundTenants).toEqual([]);
    expect(client.statements).toEqual([]);
  });

  it('refuses a replayed append of one effect as a duplicate, not as a raw driver error', async () => {
    const duplicate = Object.assign(
      new Error('duplicate key value violates unique constraint "evidence_records_pkey"'),
      { code: '23505' },
    );
    const { evidence } = harnessFor({
      evidence_tail: { rows: [] },
      evidence_insert: { fails: duplicate },
    });

    const message = await refusalOf(
      evidence.appendEvidence({
        tenant_id: TENANT,
        run_id: RUN_ID,
        correlation_id: CORRELATION_ID,
        step_index: 1,
        effect_key: 'EK-1',
        payload: FIRST_PAYLOAD,
        secret: SECRET,
      }),
    );

    expect(message).toContain('EVIDENCE_ALREADY_APPENDED');
  });

  it('refuses a payload that is not a JSON object', async () => {
    const { evidence, client } = harnessFor({});

    const message = await refusalOf(
      evidence.appendEvidence({
        tenant_id: TENANT,
        run_id: RUN_ID,
        correlation_id: CORRELATION_ID,
        step_index: 1,
        effect_key: 'EK-1',
        // The declared type is what the writer promises; a JavaScript caller can still pass an
        // array, and the boundary must refuse it rather than hash a payload no verifier can read.
        payload: [1, 2, 3] as unknown as Record<string, unknown>,
        secret: SECRET,
      }),
    );

    expect(message).toContain('EVIDENCE_INPUT_INVALID');
    expect(client.statements).toEqual([]);
  });
});

describe('EvidenceRepository.logAgentRun', () => {
  it('appends the resolved step\'s single row with its JSONB columns as canonical text', async () => {
    const record = runLogRecord();
    const { evidence, client, boundTenants } = harnessFor({
      run_log_insert: { rows: [{ tenant_id: TENANT, run_id: RUN_ID, skill: record.skill, step_index: 3 }] },
    });

    await evidence.logAgentRun(record);

    expect(boundTenants).toEqual([TENANT]);
    expect(issuedKinds(client)).toEqual(['run_log_insert']);
    expect(bindingsOf(client, 'run_log_insert')).toEqual([
      TENANT,
      RUN_ID,
      'agent-sales-01',
      'CUST-1',
      'product.inquiry',
      '{"channel":"web","session":"S-1"}',
      'skill.sales.create_order',
      3,
      'order_connector',
      '{"verdict":"ALLOW"}',
      'AUTH-3',
      null,
      '{"type":"create_order"}',
      'success',
      '{"evidence_id":"ev_1"}',
      '{"order_id":"ORD-1"}',
      120,
      '{"tokens":10}',
      null,
      STARTED_AT,
      COMPLETED_AT,
    ]);
  });

  it('refuses a second row for the same resolved step', async () => {
    const duplicate = Object.assign(
      new Error('duplicate key value violates unique constraint "agent_run_logs_pkey"'),
      { code: '23505' },
    );
    const { evidence } = harnessFor({ run_log_insert: { fails: duplicate } });

    const message = await refusalOf(evidence.logAgentRun(runLogRecord()));

    expect(message).toContain('AGENT_RUN_LOG_APPENDED');
  });

  it('refuses a status, an authority and a latency the columns cannot store', async () => {
    const { evidence, client } = harnessFor({});

    const status = await refusalOf(
      evidence.logAgentRun(
        runLogRecord({ execution_status: 'timeout' as AgentRunLogRecord['execution_status'] }),
      ),
    );
    const authority = await refusalOf(
      evidence.logAgentRun(runLogRecord({ authority: 'AUTH-6' as AgentRunLogRecord['authority'] })),
    );
    const latency = await refusalOf(evidence.logAgentRun(runLogRecord({ latency_ms: -1 })));

    expect(status).toContain('AGENT_RUN_LOG_INVALID');
    expect(authority).toContain('AGENT_RUN_LOG_INVALID');
    expect(latency).toContain('AGENT_RUN_LOG_INVALID');
    expect(client.statements).toEqual([]);
  });
});

describe('EvidenceRepository reads', () => {
  it('publishes the run chain and the operational log with instants as ISO-8601 strings', async () => {
    const chain = evidenceChain([
      { step_index: 1, effect_key: 'EK-1', payload: FIRST_PAYLOAD },
      { step_index: 2, effect_key: 'EK-2', payload: SECOND_PAYLOAD },
    ]);
    const runLog = storedRunLog();
    const { evidence, client, boundTenants } = harnessFor({
      evidence_read: { rows: chain.map((record) => rowOf(record)) },
      run_log_read: { rows: [rowOf(runLog)] },
    });

    const records = await evidence.readEvidenceChain(TENANT, RUN_ID);
    const logs = await evidence.readRunLogs(TENANT, RUN_ID);

    expect(records).toEqual(chain);
    expect(bindingsOf(client, 'evidence_read')).toEqual([TENANT, RUN_ID]);
    expect(logs).toEqual([
      { ...runLog, started_at: STARTED_AT, completed_at: COMPLETED_AT, created_at: CREATED_AT.toISOString() },
    ]);
    expect(bindingsOf(client, 'run_log_read')).toEqual([TENANT, RUN_ID]);
    expect(boundTenants).toEqual([TENANT, TENANT]);
  });

  it('verifies a chain the repository appended', async () => {
    const chain = evidenceChain([
      { step_index: 1, effect_key: 'EK-1', payload: FIRST_PAYLOAD },
      { step_index: 2, effect_key: 'EK-2', payload: SECOND_PAYLOAD },
      { step_index: 3, effect_key: 'EK-3', payload: { order: 'ORD-1', step: 3 } },
    ]);
    const { evidence } = harnessFor({
      evidence_read: { rows: chain.map((record) => rowOf(record)) },
    });

    const report = await evidence.verifyRunChain(TENANT, RUN_ID, SECRET);

    expect(report).toEqual({
      valid: true,
      records: 3,
      verified: 3,
      head_hash: at(chain, 2).chain_hash,
      breaks: [],
      tenant_id: TENANT,
      run_id: RUN_ID,
    });
  });

  it('verifies nothing as valid without a configured signing secret', async () => {
    const chain = evidenceChain([{ step_index: 1, effect_key: 'EK-1', payload: FIRST_PAYLOAD }]);
    const { evidence, client } = harnessFor({
      evidence_read: { rows: chain.map((record) => rowOf(record)) },
    });

    const message = await refusalOf(evidence.verifyRunChain(TENANT, RUN_ID));

    expect(message).toContain('AUDIT_SECRET_MISSING');
    expect(issuedKinds(client)).toEqual(['evidence_read']);
  });
});

describe('verifyEvidenceChain', () => {
  const chain = evidenceChain([
    { step_index: 1, effect_key: 'EK-1', payload: FIRST_PAYLOAD },
    { step_index: 2, effect_key: 'EK-2', payload: SECOND_PAYLOAD },
    { step_index: 3, effect_key: 'EK-3', payload: { order: 'ORD-1', step: 3 } },
  ]);

  const scope = { tenant_id: TENANT, run_id: RUN_ID, secret: SECRET };

  it('reports an edited payload and stops counting that record as verified', () => {
    const edited = { ...at(chain, 1), raw_payload: { order: 'ORD-EVIL', step: 2 } };
    const report = verifyEvidenceChain([at(chain, 0), edited, at(chain, 2)], scope);

    expect(report.valid).toBe(false);
    expect(breakFor(report, 'PAYLOAD_DIGEST_MISMATCH')?.row).toBe(1);
    expect(breakFor(report, 'PAYLOAD_DIGEST_MISMATCH')?.record).toBe(at(chain, 1).evidence_id);
    expect(report.verified).toBe(2);
    expect(report.head_hash).toBe(at(chain, 2).chain_hash);
  });

  it('reports an edited hashed field as a chain-hash mismatch', () => {
    const edited = { ...at(chain, 2), effect_key: 'EK-REWRITTEN' };
    const report = verifyEvidenceChain([at(chain, 0), at(chain, 1), edited], scope);

    expect(report.valid).toBe(false);
    expect(breakFor(report, 'CHAIN_HASH_MISMATCH')?.row).toBe(2);
    expect(report.verified).toBe(2);
  });

  it('reports an edited signature as not non-repudiable', () => {
    const edited = { ...at(chain, 0), signature: 'f'.repeat(64) };
    const report = verifyEvidenceChain([edited, at(chain, 1), at(chain, 2)], scope);

    expect(report.valid).toBe(false);
    expect(breakFor(report, 'SIGNATURE_INVALID')?.record).toBe(at(chain, 0).evidence_id);
    expect(report.verified).toBe(2);
  });

  it('reports a digest column that is not a SHA-256', () => {
    const edited = { ...at(chain, 0), payload_sha256: 'NOT-A-DIGEST' };
    const report = verifyEvidenceChain([edited, at(chain, 1), at(chain, 2)], scope);

    expect(report.valid).toBe(false);
    expect(breakFor(report, 'DIGEST_INVALID')?.record).toBe(at(chain, 0).evidence_id);
    expect(report.verified).toBe(2);
  });

  it('reports a deleted interior record as a missing predecessor', () => {
    const report = verifyEvidenceChain([at(chain, 0), at(chain, 2)], scope);

    expect(report.valid).toBe(false);
    expect(breakFor(report, 'MISSING_PREDECESSOR')?.record).toBe(at(chain, 2).evidence_id);
    expect(report.verified).toBe(1);
    expect(report.records).toBe(2);
  });

  it('reports two records that claim one chain hash as duplicates', () => {
    const forged = { ...at(chain, 1), chain_hash: at(chain, 0).chain_hash };
    const report = verifyEvidenceChain([at(chain, 0), forged], scope);

    expect(report.valid).toBe(false);
    expect(breakFor(report, 'CHAIN_HASH_DUPLICATE')?.record).toBe(at(chain, 1).evidence_id);
  });

  it('reports a second child of the genesis digest as a fork', () => {
    const forked = evidenceRecord({
      step_index: 1,
      effect_key: 'EK-OTHER',
      payload: { order: 'ORD-2', step: 1 },
      previous_evidence_hash: GENESIS_HASH,
    });
    const report = verifyEvidenceChain([at(chain, 0), forked], scope);

    expect(report.valid).toBe(false);
    expect(breakFor(report, 'GENESIS_FORK')?.record).toBe(forked.evidence_id);
  });

  it('reports a chain whose records never link to the genesis digest', () => {
    const orphan = evidenceRecord({
      step_index: 1,
      effect_key: 'EK-ORPHAN',
      payload: FIRST_PAYLOAD,
      previous_evidence_hash: 'a'.repeat(64),
    });
    const report = verifyEvidenceChain([orphan], scope);

    expect(report.valid).toBe(false);
    expect(breakFor(report, 'GENESIS_MISSING')?.row).toBe(-1);
    expect(breakFor(report, 'MISSING_PREDECESSOR')?.record).toBe(orphan.evidence_id);
    expect(report.verified).toBe(0);
    expect(report.head_hash).toBeNull();
  });

  it('reports a chain whose links contradict the step order', () => {
    const first = evidenceRecord({
      step_index: 2,
      effect_key: 'EK-2',
      payload: SECOND_PAYLOAD,
      previous_evidence_hash: GENESIS_HASH,
    });
    const second = evidenceRecord({
      step_index: 1,
      effect_key: 'EK-1',
      payload: FIRST_PAYLOAD,
      previous_evidence_hash: first.chain_hash,
    });
    const report = verifyEvidenceChain([first, second], scope);

    expect(report.valid).toBe(false);
    expect(breakFor(report, 'STEP_ORDER_INVALID')?.record).toBe(second.evidence_id);
    expect(report.verified).toBe(2);
  });

  it('refuses to verify without a configured signing secret', () => {
    expect(() => verifyEvidenceChain(chain, { tenant_id: TENANT, run_id: RUN_ID })).toThrowError(
      /AUDIT_SECRET_MISSING/,
    );
  });
});

describe('AuditRepository.append', () => {
  it('chains a tenant\'s first event to the genesis digest under the tenant lock', async () => {
    const input = auditEvent();
    const expected = auditRecord(input, GENESIS_HASH, COMPLETED_AT);
    const { audit, client, boundTenants } = harnessFor({
      audit_tail: { rows: [] },
      audit_insert: { rows: [{ id: expected.id }] },
    });

    await audit.append(input);

    expect(boundTenants).toEqual([TENANT]);
    expect(issuedKinds(client)).toEqual(['lock', 'audit_tail', 'audit_insert']);
    expect(bindingsOf(client, 'lock')).toEqual(['agentos.audit_records', TENANT]);
    expect(bindingsOf(client, 'audit_tail')).toEqual([TENANT]);
    expect(bindingsOf(client, 'audit_insert')).toEqual([
      RUN_ID,
      TENANT,
      'agent-sales-01',
      'CUST-1',
      'product.inquiry',
      '{"session":"S-1"}',
      'skill.sales.create_order',
      'order_connector',
      '{"verdict":"ALLOW"}',
      'AUTH-3',
      null,
      '{"type":"create_order"}',
      'success',
      '{"evidence_id":"ev_1"}',
      '{"order_id":"ORD-1"}',
      120,
      '{"tokens":10}',
      null,
      COMPLETED_AT,
      GENESIS_HASH,
      expected.chain_hash,
    ]);
  });

  it('chains the next event to the tenant\'s durable predecessor', async () => {
    const previousInput = auditEvent();
    const previous = auditRecord(previousInput, GENESIS_HASH, COMPLETED_AT);
    const nextInput = auditEvent({ execution_status: 'failed', error: { outcome: 'UNKNOWN' } });
    const nextTimestamp = '2026-01-01T00:00:02.000Z';
    const { audit, client } = harnessFor({
      audit_tail: { rows: [rowOf(previous)] },
      audit_insert: { rows: [{ id: '0193f000-0000-7000-8000-000000000002' }] },
    });

    await audit.append({ ...nextInput, timestamp: nextTimestamp });

    expect(bindingsOf(client, 'audit_insert')[19]).toBe(previous.chain_hash);
    expect(bindingsOf(client, 'audit_insert')[18]).toBe(nextTimestamp);
    expect(bindingsOf(client, 'audit_insert')[20]).toBe(
      sha256(previous.chain_hash, canonicalizeJson(buildAuditPayload(nextInput)), nextTimestamp),
    );
  });

  it('defaults the event time to the step\'s completion and refuses any other rendering', async () => {
    const input = auditEvent();
    const { audit: writing } = harnessFor({
      audit_tail: { rows: [] },
      audit_insert: { rows: [{ id: '0193f000-0000-7000-8000-000000000001' }] },
    });
    const { audit: refusing, client } = harnessFor({});

    await writing.append(input);

    const message = await refusalOf(refusing.append({ ...input, timestamp: '2026-01-01T00:00:01Z' }));

    expect(message).toContain('AUDIT_INPUT_INVALID');
    expect(issuedKinds(client)).toEqual([]);
  });
});

describe('AuditRepository reads', () => {
  const chain = auditChain([
    { input: auditEvent(), timestamp: COMPLETED_AT },
    {
      input: auditEvent({ execution_status: 'failed', error: { outcome: 'UNKNOWN' } }),
      timestamp: '2026-01-01T00:00:02.000Z',
    },
  ]);

  it('reads and verifies the tenant\'s chain through the tenant binder', async () => {
    const { audit, client, boundTenants } = harnessFor({
      audit_read: { rows: chain.map((record) => rowOf(record)) },
    });

    const records = await audit.readTenantChain(TENANT);
    const report = await audit.verifyTenantChain(TENANT);

    expect(records).toEqual(chain);
    expect(bindingsOf(client, 'audit_read')).toEqual([TENANT]);
    expect(report).toEqual({
      valid: true,
      records: 2,
      verified: 2,
      head_hash: at(chain, 1).chain_hash,
      breaks: [],
      tenant_id: TENANT,
    });
    expect(boundTenants).toEqual([TENANT, TENANT]);
  });

  it('reports an edited audit field as a chain-hash mismatch', () => {
    const edited = { ...at(chain, 1), outcome: { order_id: 'ORD-EVIL' } };
    const report = verifyAuditChain([at(chain, 0), edited], { tenant_id: TENANT });

    expect(report.valid).toBe(false);
    expect(breakFor(report, 'CHAIN_HASH_MISMATCH')?.record).toBe(at(chain, 1).id);
    expect(report.verified).toBe(1);
  });

  it('reports an event time that is not the rendering the chain hash covers', () => {
    const edited = { ...at(chain, 0), timestamp: '2026-01-01T00:00:01Z' };
    const report = verifyAuditChain([edited, at(chain, 1)], { tenant_id: TENANT });

    expect(report.valid).toBe(false);
    expect(breakFor(report, 'TIMESTAMP_INVALID')?.record).toBe(at(chain, 0).id);
    expect(report.verified).toBe(1);
  });

  it('reports a tenant chain that does not start at its genesis digest', () => {
    const report = verifyAuditChain([at(chain, 1)], { tenant_id: TENANT });

    expect(report.valid).toBe(false);
    expect(breakFor(report, 'GENESIS_MISSING')?.row).toBe(-1);
    expect(breakFor(report, 'MISSING_PREDECESSOR')?.record).toBe(at(chain, 1).id);
    expect(report.verified).toBe(0);
    expect(report.head_hash).toBeNull();
  });
});