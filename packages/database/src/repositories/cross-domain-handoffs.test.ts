import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AdmitCrossDomainHandoffInput,
  CrossDomainHandoffRecord,
  EffectReservationRecord,
} from '../contracts/index.js';

const TENANT = '11111111-1111-4111-1111-111111111111';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const CORRELATION = 'correlation-1';
const KEY = 'a'.repeat(64);
const FINGERPRINT = 'b'.repeat(64);
const OTHER_FINGERPRINT = 'c'.repeat(64);
const SOURCE_RUN = 'source-run-1';
const TARGET_RUN = 'target-run-1';
const STORED_TARGET_RUN = 'target-run-stored';
const NOW = new Date('2026-09-23T00:00:00.000Z');

function reservation(overrides: Partial<EffectReservationRecord> = {}): EffectReservationRecord {
  return {
    tenant_id: TENANT,
    effect_key: KEY,
    request_id: KEY,
    request_fingerprint: FINGERPRINT,
    run_id: TARGET_RUN,
    step_index: 0,
    skill_id: 'orchestrator.cross_domain_handoff',
    status: 'RESERVED',
    response_receipt: null,
    reserved_at: NOW.toISOString(),
    resolved_at: null,
    expires_at: new Date(NOW.getTime() + 86_400_000).toISOString(),
    expired: false,
    ...overrides,
  };
}

function taskRow() {
  return {
    task_id: 'task-1',
    tenant_id: TENANT,
    run_id: TARGET_RUN,
    correlation_id: CORRELATION,
    current_step: 0,
    state: 'queued' as const,
    task_version: 1,
    lease_owner: null,
    lease_expires_at: null,
    retry_count: 0,
    max_retries: 3,
    last_error_class: null,
    paused_for_approval_id: null,
    state_payload: { signal: { source: 'test' } },
    error_details: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
}

function handoff(overrides: Partial<CrossDomainHandoffRecord> = {}): CrossDomainHandoffRecord {
  return {
    handoff_id: 'handoff-1',
    tenant_id: TENANT,
    customer_id: CUSTOMER,
    correlation_id: CORRELATION,
    idempotency_key: KEY,
    request_fingerprint: FINGERPRINT,
    source_domain: 'commerce',
    source_agent: 'COM-01',
    source_run_id: SOURCE_RUN,
    target_domain: 'care',
    target_agent: 'CS-01',
    target_module: 'care.intake',
    target_run_id: TARGET_RUN,
    reason: 'customer requested help',
    classification: 'SIGNAL',
    evidence: [],
    lifecycle_state: 'HANDED_OFF',
    lifecycle_version: 1,
    hop_count: 1,
    visited_domains: ['commerce'],
    occurred_at: NOW.toISOString(),
    created_at: NOW.toISOString(),
    ...overrides,
  };
}

const state = {
  queries: [] as Array<{ sql: string; params: readonly unknown[] }>,
  reservationInsert: reservation(),
  lockedReservation: reservation(),
  task: taskRow(),
  selectedLedger: [] as QueryResultRow[],
  insertedLedger: [] as QueryResultRow[],
  factRows: [] as QueryResultRow[],
  tenants: [] as string[],
};

const client = {
  async query<Row extends QueryResultRow>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<Row>> {
    state.queries.push({ sql, params });
    if (sql.includes('FROM agentos.evidences')) return { rows: state.factRows as Row[], rowCount: state.factRows.length } as QueryResult<Row>;
    if (sql.includes('INSERT INTO agentos.cross_domain_handoffs')) {
      return { rows: state.insertedLedger as Row[], rowCount: state.insertedLedger.length } as QueryResult<Row>;
    }
    if (sql.includes('FROM agentos.cross_domain_handoffs')) {
      return { rows: state.selectedLedger as Row[], rowCount: state.selectedLedger.length } as QueryResult<Row>;
    }
    return { rows: [], rowCount: 0 } as unknown as QueryResult<Row>;
  },
} as unknown as PoolClient;

vi.mock('../rls.js', () => ({
  withTenantContext: async <T>(tenant: string, work: (db: PoolClient) => Promise<T>): Promise<T> => {
    state.tenants.push(tenant);
    return work(client);
  },
}));

vi.mock('./effect-reservations.js', () => ({
  insertReservationRow: vi.fn(async (_db: PoolClient, input: Record<string, unknown>) => {
    state.queries.push({ sql: 'INSERT INTO agentos.effect_reservations', params: Object.values(input) });
    return state.reservationInsert;
  }),
  lockReservationRow: vi.fn(async () => {
    state.queries.push({ sql: 'SELECT FROM agentos.effect_reservations FOR UPDATE', params: [TENANT, KEY] });
    return state.lockedReservation;
  }),
}));

vi.mock('./durable-workflows.js', () => ({
  insertDurableTask: vi.fn(async (_db: PoolClient, input: Record<string, unknown>) => {
    state.queries.push({ sql: 'INSERT INTO agentos.platform_durable_tasks', params: Object.values(input) });
    return state.task;
  }),
}));

const { admitCrossDomainHandoff } = await import('./cross-domain-handoffs.js');

function input(overrides: Partial<AdmitCrossDomainHandoffInput> = {}): AdmitCrossDomainHandoffInput {
  return {
    tenant_id: TENANT,
    customer_id: CUSTOMER,
    correlation_id: CORRELATION,
    idempotency_key: KEY,
    request_fingerprint: FINGERPRINT,
    source_domain: 'commerce',
    source_agent: 'COM-01',
    source_run_id: SOURCE_RUN,
    target_domain: 'care',
    target_agent: 'CS-01',
    target_module: 'care.intake',
    reason: 'customer requested help',
    classification: 'SIGNAL',
    evidence: [],
    lifecycle_state: 'HANDED_OFF',
    lifecycle_version: 1,
    hop_count: 1,
    visited_domains: ['commerce'],
    occurred_at: NOW.toISOString(),
    run_id: TARGET_RUN,
    signal: { source: 'test' },
    reservation_ttl_ms: 86_400_000,
    now: () => NOW,
    ...overrides,
  };
}

beforeEach(() => {
  state.queries.length = 0;
  state.tenants.length = 0;
  state.reservationInsert = reservation();
  state.lockedReservation = reservation();
  state.task = taskRow();
  state.selectedLedger = [];
  state.insertedLedger = [handoff()];
  state.factRows = [];
});

describe('admitCrossDomainHandoff', () => {
  it('admits reservation, target task and ledger in one tenant transaction', async () => {
    const result = await admitCrossDomainHandoff(input());

    expect(result.kind).toBe('ADMITTED');
    if (result.kind !== 'ADMITTED') return;
    expect(result.run_id).toBe(TARGET_RUN);
    expect(result.handoff_id).toBe('handoff-1');
    expect(result.task.current_step).toBe(0);
    expect(result.task.state).toBe('queued');
    expect(state.tenants).toEqual([TENANT]);
    expect(state.queries.map(({ sql }) => sql)).toEqual([
      'SAVEPOINT cross_domain_handoff_ledger',
      'INSERT INTO agentos.effect_reservations',
      'INSERT INTO agentos.platform_durable_tasks',
      expect.stringContaining('INSERT INTO agentos.cross_domain_handoffs'),
      'RELEASE SAVEPOINT cross_domain_handoff_ledger',
    ]);
  });

  it('returns REPLAY with the ledger target_run_id, never the caller-supplied run id', async () => {
    state.reservationInsert = null as unknown as EffectReservationRecord;
    state.lockedReservation = reservation({ status: 'SUCCEEDED', response_receipt: { ok: true } });
    state.selectedLedger = [handoff({ target_run_id: STORED_TARGET_RUN })];

    const result = await admitCrossDomainHandoff(input({ run_id: 'different-retry-run' }));

    expect(result).toEqual({
      kind: 'REPLAY',
      handoff_id: 'handoff-1',
      run_id: STORED_TARGET_RUN,
      receipt: { ok: true },
    });
  });

  it('returns IN_FLIGHT for an unexpired reservation and the existing ledger run', async () => {
    state.reservationInsert = null as unknown as EffectReservationRecord;
    state.lockedReservation = reservation();
    state.selectedLedger = [handoff({ target_run_id: STORED_TARGET_RUN })];

    const result = await admitCrossDomainHandoff(input());

    expect(result).toEqual({ kind: 'IN_FLIGHT', handoff_id: 'handoff-1', run_id: STORED_TARGET_RUN });
  });

  it('returns CONFLICT when the same key carries changed bytes', async () => {
    state.reservationInsert = null as unknown as EffectReservationRecord;
    state.lockedReservation = reservation({ request_fingerprint: OTHER_FINGERPRINT });

    const result = await admitCrossDomainHandoff(input());

    expect(result).toEqual({ kind: 'CONFLICT' });
  });

  it('returns RECONCILE_REQUIRED for expired reservations', async () => {
    state.reservationInsert = null as unknown as EffectReservationRecord;
    state.lockedReservation = reservation({ status: 'EXPIRED', expired: true });

    const result = await admitCrossDomainHandoff(input());

    expect(result).toEqual({ kind: 'RECONCILE_REQUIRED' });
  });

  it('refuses an unverified FACT before reserving or creating a task', async () => {
    const evidence = {
      classification: 'FACT' as const,
      claim: 'authoritative claim',
      source_uri: 'sor:orders/1',
      source_version: 'v1',
      verified_by: 'grounding-writer',
    };

    await expect(admitCrossDomainHandoff(input({ classification: 'FACT', evidence: [evidence] }))).rejects.toThrow(
      'HANDOFF_EVIDENCE_UNVERIFIED',
    );
    expect(state.queries.some(({ sql }) => sql.includes('effect_reservations'))).toBe(false);
    expect(state.queries.some(({ sql }) => sql.includes('platform_durable_tasks'))).toBe(false);
    expect(state.queries.some(({ sql }) => sql.includes('cross_domain_handoffs'))).toBe(false);
  });

  it('completes a missing ledger row during settled replay recovery', async () => {
    state.reservationInsert = null as unknown as EffectReservationRecord;
    state.lockedReservation = reservation({ status: 'SUCCEEDED', response_receipt: { target_run_id: STORED_TARGET_RUN } });
    state.selectedLedger = [];
    state.insertedLedger = [handoff({ target_run_id: STORED_TARGET_RUN })];

    const result = await admitCrossDomainHandoff(input());

    expect(result).toEqual({
      kind: 'REPLAY',
      handoff_id: 'handoff-1',
      run_id: STORED_TARGET_RUN,
      receipt: { target_run_id: STORED_TARGET_RUN },
    });
    expect(state.queries.filter(({ sql }) => sql.includes('INSERT INTO agentos.cross_domain_handoffs'))).toHaveLength(1);
  });
});
