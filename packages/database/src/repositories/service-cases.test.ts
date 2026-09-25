import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';

import type { ManageServiceCaseInput, ManagedServiceCase, ServiceCaseState } from '../contracts/service-cases.js';
import { ServiceCaseRepository } from './service-cases.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = 'aaaaaaaa-0000-4000-8000-00000000000a';
const CONVERSATION_ID = 'cccccccc-0000-4000-8000-00000000000c';
const ORDER_ID = 'dddddddd-0000-4000-8000-00000000000d';
const EVIDENCE_ID = 'eeeeeeee-0000-4000-8000-00000000000e';
const CASE_ID = 'ffffffff-0000-4000-8000-00000000000f';
const EFFECT_KEY = 'a'.repeat(64);
const FINGERPRINT = 'b'.repeat(64);
const NOW = new Date('2026-04-15T12:00:00.000Z');

type StatementKind =
  | 'SET_TIMEOUT'
  | 'LOCK_EFFECT'
  | 'SELECT_EVENT'
  | 'SELECT_CONVERSATION'
  | 'SELECT_ORDER'
  | 'SELECT_EVIDENCE'
  | 'INSERT_CASE'
  | 'SELECT_CASE'
  | 'UPDATE_CASE'
  | 'INSERT_EVENT';

interface ScriptedAnswer {
  readonly rows?: readonly QueryResultRow[];
  readonly fails?: unknown;
}

type Answers = Partial<Record<StatementKind, ScriptedAnswer | ((params: readonly unknown[]) => ScriptedAnswer)>>;

interface IssuedStatement {
  readonly kind: StatementKind;
  readonly sql: string;
  readonly params: readonly unknown[];
}

function classify(sql: string): StatementKind {
  if (sql.includes('set_config(')) return 'SET_TIMEOUT';
  if (sql.includes('pg_advisory_xact_lock')) return 'LOCK_EFFECT';
  if (sql.includes('INSERT INTO agentos.service_case_events')) return 'INSERT_EVENT';
  if (sql.includes('FROM agentos.service_case_events')) return 'SELECT_EVENT';
  if (sql.includes('FROM agentos.conversations')) return 'SELECT_CONVERSATION';
  if (sql.includes('FROM agentos.orders')) return 'SELECT_ORDER';
  if (sql.includes('FROM agentos.evidences')) return 'SELECT_EVIDENCE';
  if (sql.includes('INSERT INTO agentos.service_cases')) return 'INSERT_CASE';
  if (sql.includes('UPDATE agentos.service_cases AS sc')) return 'UPDATE_CASE';
  if (sql.includes('FROM agentos.service_cases')) return 'SELECT_CASE';
  throw new Error('UNKNOWN_CASE_SQL');
}

class ScriptedClient {
  readonly statements: IssuedStatement[] = [];

  constructor(private readonly answers: Answers) {}

  async query<R extends QueryResultRow>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<R>> {
    const kind = classify(sql);
    this.statements.push({ kind, sql, params });
    const scripted = this.answers[kind];
    if (scripted === undefined) throw new Error('SCRIPTED_ANSWER_MISSING:' + kind);
    const answer = typeof scripted === 'function' ? scripted(params) : scripted;
    if (answer.fails !== undefined) throw answer.fails;
    const rows = (answer.rows ?? []) as unknown as R[];
    return { rows, rowCount: rows.length } as QueryResult<R>;
  }
}

interface CaseRow extends QueryResultRow {
  case_id: string;
  tenant_id: string;
  customer_id: string;
  intent: string;
  priority: 'P1' | 'P2' | 'P3' | 'P4';
  status: ServiceCaseState;
  conversation_id: string;
  related_order_id: string | null;
  evidence_id: string | null;
  evidence_refs: unknown;
  assigned_agent: string;
  assigned_human_id: string | null;
  sla_target_hours: number | null;
  updated_at: Date;
  case_version: number;
  sla_history: unknown;
  resolution: string | null;
}

function caseRow(overrides: Partial<CaseRow> = {}): CaseRow {
  return {
    case_id: CASE_ID,
    tenant_id: TENANT_ID,
    customer_id: CUSTOMER_ID,
    intent: 'billing',
    priority: 'P2',
    status: 'NEW',
    conversation_id: CONVERSATION_ID,
    related_order_id: null,
    evidence_id: null,
    evidence_refs: [],
    assigned_agent: 'CS-01',
    assigned_human_id: null,
    sla_target_hours: 4,
    updated_at: NOW,
    case_version: 1,
    sla_history: [{ opened_at: NOW.toISOString(), due_at: '2026-04-15T16:00:00.000Z', reason: 'created' }],
    resolution: null,
    ...overrides,
  };
}

function input(overrides: Partial<ManageServiceCaseInput> = {}): ManageServiceCaseInput {
  return {
    tenant_id: TENANT_ID,
    customer_id: CUSTOMER_ID,
    intent: 'billing',
    priority: 'P2',
    conversation_id: CONVERSATION_ID,
    action_type: 'CREATE',
    sla_target_hours: 4,
    effect_key: EFFECT_KEY,
    request_fingerprint: FINGERPRINT,
    actor_id: 'CS-01',
    ...overrides,
  };
}

interface Harness {
  readonly repository: ServiceCaseRepository;
  readonly client: ScriptedClient;
  readonly boundTenants: string[];
}

function harnessFor(answers: Answers): Harness {
  const client = new ScriptedClient(answers);
  const boundTenants: string[] = [];
  const repository = new ServiceCaseRepository(async (tenantId, work) => {
    boundTenants.push(tenantId);
    return work(client as unknown as PoolClient);
  });
  return { repository, client, boundTenants };
}

const emptyEventRows: readonly QueryResultRow[] = [];
const boundConversation = [{ id: CONVERSATION_ID }];

describe('ServiceCaseRepository', () => {
  it('creates a version-1 case only after tenant/customer bindings and stores an immutable receipt', async () => {
    const created = caseRow({ evidence_refs: [EVIDENCE_ID], related_order_id: ORDER_ID });
    const harness = harnessFor({
      LOCK_EFFECT: { rows: emptyEventRows },
      SELECT_EVENT: { rows: emptyEventRows },
      SELECT_CONVERSATION: { rows: boundConversation },
      SELECT_ORDER: { rows: [{ id: ORDER_ID }] },
      SELECT_EVIDENCE: { rows: [{ id: EVIDENCE_ID }] },
      INSERT_CASE: { rows: [created] },
      INSERT_EVENT: { rows: emptyEventRows },
    });

    const result = await harness.repository.manage(input({
      related_order_id: ORDER_ID,
      evidence_refs: [EVIDENCE_ID],
    }));

    expect(result).toMatchObject({ case_id: CASE_ID, status: 'NEW', case_version: 1, sla_target_hours: 4 });
    expect(harness.boundTenants).toEqual([TENANT_ID]);
    expect(harness.client.statements.map(({ kind }) => kind)).toEqual([
      'LOCK_EFFECT', 'SELECT_EVENT', 'SELECT_CONVERSATION', 'SELECT_EVIDENCE', 'SELECT_ORDER', 'INSERT_CASE', 'INSERT_EVENT',
    ]);
    expect(harness.client.statements.find(({ kind }) => kind === 'SELECT_CONVERSATION')?.params)
      .toEqual([TENANT_ID, CONVERSATION_ID, CUSTOMER_ID]);
    expect(harness.client.statements.find(({ kind }) => kind === 'SELECT_EVIDENCE')?.params)
      .toEqual([TENANT_ID, CUSTOMER_ID, [EVIDENCE_ID]]);
    expect(harness.client.statements.find(({ kind }) => kind === 'SELECT_ORDER')?.params)
      .toEqual([TENANT_ID, ORDER_ID, CUSTOMER_ID]);
    expect(harness.client.statements.find(({ kind }) => kind === 'INSERT_EVENT')?.params[10])
      .toBe(JSON.stringify(result));
  });

  it('replays the exact stored receipt without repeating binding checks or writes', async () => {
    const receipt: ManagedServiceCase = {
      case_id: CASE_ID,
      customer_id: CUSTOMER_ID,
      intent: 'billing',
      priority: 'P2',
      status: 'NEW',
      conversation_id: CONVERSATION_ID,
      related_order_id: null,
      evidence_refs: [],
      assigned_owner: 'CS-01',
      sla_target_hours: 4,
      updated_at: NOW.toISOString(),
      case_version: 1,
    };
    const harness = harnessFor({
      LOCK_EFFECT: { rows: emptyEventRows },
      SELECT_EVENT: { rows: [{ request_fingerprint: FINGERPRINT, result_payload: receipt }] },
    });

    await expect(harness.repository.manage(input())).resolves.toEqual(receipt);
    expect(harness.client.statements.map(({ kind }) => kind)).toEqual(['LOCK_EFFECT', 'SELECT_EVENT']);
  });

  it('rejects reuse of an effect key with a different fingerprint before reading the case', async () => {
    const harness = harnessFor({
      LOCK_EFFECT: { rows: emptyEventRows },
      SELECT_EVENT: { rows: [{ request_fingerprint: 'c'.repeat(64), result_payload: {} }] },
    });

    await expect(harness.repository.manage(input())).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);
    expect(harness.client.statements.map(({ kind }) => kind)).toEqual(['LOCK_EFFECT', 'SELECT_EVENT']);
  });

  it('rejects an optimistic version conflict before any case update or receipt insert', async () => {
    const harness = harnessFor({
      LOCK_EFFECT: { rows: emptyEventRows },
      SELECT_EVENT: { rows: emptyEventRows },
      SELECT_CONVERSATION: { rows: boundConversation },
      SELECT_CASE: { rows: [caseRow({ case_version: 3 })] },
    });

    await expect(harness.repository.manage(input({
      action_type: 'TRANSITION_STATE',
      case_id: CASE_ID,
      expected_case_version: 2,
      target_status: 'CLASSIFIED',
    }))).rejects.toThrow(/CASE_VERSION_CONFLICT/);
    expect(harness.client.statements.map(({ kind }) => kind)).toEqual([
      'LOCK_EFFECT', 'SELECT_EVENT', 'SELECT_CONVERSATION', 'SELECT_CASE',
    ]);
  });

  it('rejects illegal FSM transitions without updating the case', async () => {
    const harness = harnessFor({
      LOCK_EFFECT: { rows: emptyEventRows },
      SELECT_EVENT: { rows: emptyEventRows },
      SELECT_CONVERSATION: { rows: boundConversation },
      SELECT_CASE: { rows: [caseRow({ status: 'NEW', case_version: 1 })] },
    });

    await expect(harness.repository.manage(input({
      action_type: 'TRANSITION_STATE',
      case_id: CASE_ID,
      expected_case_version: 1,
      target_status: 'RESOLVED',
    }))).rejects.toThrow(/INVALID_FSM_TRANSITION/);
    expect(harness.client.statements.map(({ kind }) => kind)).not.toContain('UPDATE_CASE');
    expect(harness.client.statements.map(({ kind }) => kind)).not.toContain('INSERT_EVENT');
  });

  it('requires evidence before resolution and leaves the case untouched when none is linked', async () => {
    const harness = harnessFor({
      LOCK_EFFECT: { rows: emptyEventRows },
      SELECT_EVENT: { rows: emptyEventRows },
      SELECT_CONVERSATION: { rows: boundConversation },
      SELECT_CASE: { rows: [caseRow({ status: 'IN_PROGRESS', case_version: 2 })] },
    });

    await expect(harness.repository.manage(input({
      action_type: 'RESOLVE',
      case_id: CASE_ID,
      expected_case_version: 2,
      notes: 'Customer confirmed the replacement arrived.',
    }))).rejects.toThrow(/CASE_EVIDENCE_REQUIRED/);
    expect(harness.client.statements.map(({ kind }) => kind)).not.toContain('UPDATE_CASE');
    expect(harness.client.statements.map(({ kind }) => kind)).not.toContain('INSERT_EVENT');
  });

  it('increments reopen count, timestamp and SLA window under the expected case version', async () => {
    const reopened = caseRow({ status: 'IN_PROGRESS', case_version: 8 });
    const harness = harnessFor({
      LOCK_EFFECT: { rows: emptyEventRows },
      SELECT_EVENT: { rows: emptyEventRows },
      SELECT_CONVERSATION: { rows: boundConversation },
      SELECT_CASE: { rows: [caseRow({ status: 'RESOLVED', case_version: 7, evidence_refs: [EVIDENCE_ID] })] },
      UPDATE_CASE: { rows: [reopened] },
      INSERT_EVENT: { rows: emptyEventRows },
    });

    await expect(harness.repository.manage(input({
      action_type: 'REOPEN',
      case_id: CASE_ID,
      expected_case_version: 7,
      notes: 'Customer requested that the case be reopened.',
    }))).resolves.toMatchObject({ status: 'IN_PROGRESS', case_version: 8 });

    const update = harness.client.statements.find(({ kind }) => kind === 'UPDATE_CASE');
    expect(update?.sql).toContain('reopen_count = reopen_count + CASE WHEN $14::boolean THEN 1 ELSE 0 END');
    expect(update?.params[12]).toBe('reopened');
    expect(update?.params[13]).toBe(true);
  });

  it('requires configured SLA hours for case creation instead of inventing a target', async () => {
    const harness = harnessFor({
      LOCK_EFFECT: { rows: emptyEventRows },
      SELECT_EVENT: { rows: emptyEventRows },
      SELECT_CONVERSATION: { rows: boundConversation },
    });

    const createWithoutSla = { ...input() };
    delete createWithoutSla.sla_target_hours;
    await expect(harness.repository.manage(createWithoutSla))
      .rejects.toThrow(/CASE_SLA_POLICY_UNAVAILABLE/);
    expect(harness.client.statements.map(({ kind }) => kind)).toEqual([
      'LOCK_EFFECT', 'SELECT_EVENT', 'SELECT_CONVERSATION',
    ]);
  });
  it('reconciles a committed effect by its immutable receipt before reading a case', async () => {
    const receipt: ManagedServiceCase = {
      case_id: CASE_ID,
      customer_id: CUSTOMER_ID,
      intent: 'billing',
      priority: 'P2',
      status: 'IN_PROGRESS',
      conversation_id: CONVERSATION_ID,
      related_order_id: null,
      evidence_refs: [],
      assigned_owner: 'CS-01',
      sla_target_hours: 4,
      updated_at: NOW.toISOString(),
      case_version: 3,
    };
    const harness = harnessFor({
      SET_TIMEOUT: { rows: emptyEventRows },
      LOCK_EFFECT: { rows: emptyEventRows },
      SELECT_EVENT: { rows: [{ request_fingerprint: FINGERPRINT, result_payload: receipt }] },
    });

    await expect(harness.repository.reconcile(input({
      action_type: 'TRANSITION_STATE',
      case_id: CASE_ID,
      expected_case_version: 2,
      target_status: 'IN_PROGRESS',
    }))).resolves.toEqual({ state: 'COMMITTED', output: receipt });

    expect(harness.client.statements.map(({ kind }) => kind)).toEqual([
      'SET_TIMEOUT', 'LOCK_EFFECT', 'SELECT_EVENT',
    ]);
    const timeout = harness.client.statements[0]!;
    expect(timeout.params).toEqual([1_000]);
    expect(timeout.sql).toContain('LEAST(');
    expect(timeout.sql).toContain('statement_timeout');
  });

  it('re-reads the tenant-bound case version when no receipt exists and never mutates', async () => {
    const current = caseRow({ status: 'IN_PROGRESS', case_version: 6 });
    const harness = harnessFor({
      SET_TIMEOUT: { rows: emptyEventRows },
      LOCK_EFFECT: { rows: emptyEventRows },
      SELECT_EVENT: { rows: emptyEventRows },
      SELECT_CASE: { rows: [current] },
    });

    await expect(harness.repository.reconcile(input({
      action_type: 'TRANSITION_STATE',
      case_id: CASE_ID,
      expected_case_version: 5,
      target_status: 'RESOLVED',
    }))).resolves.toEqual({
      state: 'NOT_COMMITTED',
      case_id: CASE_ID,
      current_case_version: 6,
      current_status: 'IN_PROGRESS',
    });

    expect(harness.boundTenants).toEqual([TENANT_ID]);
    expect(harness.client.statements.map(({ kind }) => kind)).toEqual([
      'SET_TIMEOUT', 'LOCK_EFFECT', 'SELECT_EVENT', 'SELECT_CASE',
    ]);
    expect(harness.client.statements.find(({ kind }) => kind === 'SELECT_CASE')?.params)
      .toEqual([TENANT_ID, CASE_ID]);
    expect(harness.client.statements.map(({ kind }) => kind)).not.toContain('UPDATE_CASE');
    expect(harness.client.statements.map(({ kind }) => kind)).not.toContain('INSERT_EVENT');
  });

  it('rejects a receipt whose fingerprint differs before exposing case state', async () => {
    const harness = harnessFor({
      SET_TIMEOUT: { rows: emptyEventRows },
      LOCK_EFFECT: { rows: emptyEventRows },
      SELECT_EVENT: { rows: [{ request_fingerprint: 'c'.repeat(64), result_payload: {} }] },
    });

    await expect(harness.repository.reconcile(input())).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);
    expect(harness.client.statements.map(({ kind }) => kind)).toEqual([
      'SET_TIMEOUT', 'LOCK_EFFECT', 'SELECT_EVENT',
    ]);
  });
});
