import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  type AdmitCareTurnInput,
  admitCareTurn,
  CONVERSATION_TURN_SKILL,
} from './run-admission.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const EFFECT_KEY = 'EK-CARE-TEST-1';
const REQUEST_ID = 'REQ-CARE-1';
const RUN_ID = 'RUN-CARE-1';
const CORRELATION_ID = 'CORR-CARE-1';
const FINGERPRINT = 'a'.repeat(64);
const OTHER_FINGERPRINT = 'b'.repeat(64);
/**
 * The durable idempotency window this suite feeds admission. The platform value is
 * `RESERVATION_TTL_MS` (`packages/core-engine`), which the API layer passes in; this package
 * must not import it (its `rootDir` is the package), so the suite proves the window is USED, not
 * that it equals a number a second package restated.
 */
const RESERVATION_TTL_MS = 72 * 60 * 60 * 1000;

const NOW = new Date('2026-09-23T00:00:00.000Z');

interface ScriptedStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function createScriptedRunner(handler: (sql: string, params: readonly unknown[]) => Promise<QueryResultRow[]>) {
  const issued: ScriptedStatement[] = [];
  const client: PoolClient = {
    async query<R extends QueryResultRow>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<R>> {
      issued.push({ sql, params });
      const rows = (await handler(sql, params)) as R[];
      return {
        rows,
        rowCount: rows.length,
        command: '',
        oid: 0,
        fields: [],
      };
    },
  } as unknown as PoolClient;

  const runner = async <T>(_tenant: string, work: (c: PoolClient) => Promise<T>): Promise<T> => {
    return work(client);
  };

  return { runner, issued };
}

function mockReservationRow(overrides: Partial<QueryResultRow> = {}): QueryResultRow {
  return {
    tenant_id: TENANT,
    effect_key: EFFECT_KEY,
    request_id: REQUEST_ID,
    request_fingerprint: FINGERPRINT,
    run_id: RUN_ID,
    step_index: 0,
    skill_id: CONVERSATION_TURN_SKILL,
    status: 'RESERVED',
    response_receipt: null,
    reserved_at: NOW,
    resolved_at: null,
    expires_at: new Date(NOW.getTime() + RESERVATION_TTL_MS),
    expired: false,
    ...overrides,
  };
}

function mockTaskRow(overrides: Partial<QueryResultRow> = {}): QueryResultRow {
  return {
    tenant_id: TENANT,
    run_id: RUN_ID,
    correlation_id: CORRELATION_ID,
    current_step: 0,
    state: 'queued',
    task_version: 1,
    retry_count: 0,
    max_retries: 3,
    last_error_class: null,
    last_error_details: null,
    lease_owner: null,
    lease_expires_at: null,
    state_payload: { signal: { message: 'hello' } },
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

describe('admitCareTurn', () => {
  it('admits a turn on first delivery, writing exactly one reservation and one durable task in one transaction', async () => {
    const { runner, issued } = createScriptedRunner(async (sql) => {
      if (sql.includes('INSERT INTO agentos.effect_reservations')) {
        return [mockReservationRow()];
      }
      if (sql.includes('INSERT INTO agentos.platform_durable_tasks')) {
        return [mockTaskRow()];
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const input: AdmitCareTurnInput = {
      tenant_id: TENANT,
      effect_key: EFFECT_KEY,
      request_id: REQUEST_ID,
      request_fingerprint: FINGERPRINT,
      run_id: RUN_ID,
      correlation_id: CORRELATION_ID,
      signal: { message: 'hello' },
      reservation_ttl_ms: RESERVATION_TTL_MS,
      now: () => NOW,
    };

    const outcome = await admitCareTurn(input, runner);

    expect(outcome.kind).toBe('ADMITTED');
    if (outcome.kind !== 'ADMITTED') return;

    expect(outcome.run_id).toBe(RUN_ID);
    expect(outcome.task.state).toBe('queued');
    expect(outcome.task.current_step).toBe(0);
    expect(outcome.task.task_version).toBe(1);
    expect(outcome.reservation.status).toBe('RESERVED');

    // Exactly two statements: reservation insert, task insert
    expect(issued).toHaveLength(2);
    expect(issued[0]!.sql).toContain('INSERT INTO agentos.effect_reservations');
    expect(issued[0]!.params[4]).toBe(RUN_ID); // run_id
    expect(issued[0]!.params[5]).toBe(0); // step_index
    expect(issued[0]!.params[6]).toBe(CONVERSATION_TURN_SKILL); // skill_id
    expect(issued[0]!.params[7]).toBe(new Date(NOW.getTime() + RESERVATION_TTL_MS).toISOString()); // expires_at

    expect(issued[1]!.sql).toContain('INSERT INTO agentos.platform_durable_tasks');
    expect(issued[1]!.params[1]).toBe(RUN_ID);
    expect(issued[1]!.params[3]).toBe(0); // current_step = 0
    expect(issued[1]!.params[4]).toBe('queued'); // state = queued
  });

  it('duplicate admission with same key+fingerprint returns the SAME run_id (IN_FLIGHT) and writes no second task', async () => {
    const { runner, issued } = createScriptedRunner(async (sql) => {
      if (sql.includes('INSERT INTO agentos.effect_reservations')) {
        // ON CONFLICT DO NOTHING -> 0 rows returned
        return [];
      }
      if (sql.includes('FOR UPDATE')) {
        // Lock returns the existing reservation
        return [mockReservationRow({ status: 'RESERVED', expired: false, run_id: 'ORIGINAL-RUN' })];
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const input: AdmitCareTurnInput = {
      tenant_id: TENANT,
      effect_key: EFFECT_KEY,
      request_id: REQUEST_ID,
      request_fingerprint: FINGERPRINT,
      run_id: 'NEW-RUN-ID-SHOULD-BE-DISCARDED',
      correlation_id: CORRELATION_ID,
      signal: { message: 'hello' },
      reservation_ttl_ms: RESERVATION_TTL_MS,
      now: () => NOW,
    };

    const outcome = await admitCareTurn(input, runner);

    expect(outcome).toEqual({
      kind: 'IN_FLIGHT',
      run_id: 'ORIGINAL-RUN',
    });

    // Exactly two statements: insert (failed) + select FOR UPDATE. No task insert!
    expect(issued).toHaveLength(2);
    expect(issued[0]!.sql).toContain('INSERT INTO agentos.effect_reservations');
    expect(issued[1]!.sql).toContain('FOR UPDATE');
  });

  it('returns CONFLICT when the same effect key was already reserved with a different request fingerprint', async () => {
    const { runner, issued } = createScriptedRunner(async (sql) => {
      if (sql.includes('INSERT INTO agentos.effect_reservations')) {
        return [];
      }
      if (sql.includes('FOR UPDATE')) {
        return [mockReservationRow({ request_fingerprint: OTHER_FINGERPRINT })];
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const input: AdmitCareTurnInput = {
      tenant_id: TENANT,
      effect_key: EFFECT_KEY,
      request_id: REQUEST_ID,
      request_fingerprint: FINGERPRINT,
      run_id: RUN_ID,
      correlation_id: CORRELATION_ID,
      signal: { message: 'hello' },
      reservation_ttl_ms: RESERVATION_TTL_MS,
    };

    const outcome = await admitCareTurn(input, runner);

    expect(outcome).toEqual({ kind: 'CONFLICT' });
    expect(issued).toHaveLength(2);
    expect(issued[1]!.sql).toContain('FOR UPDATE');
  });

  it('settled reservation returns REPLAY with the stored receipt and run_id', async () => {
    const receipt = { task_id: 'ORIGINAL-RUN', status: 'accepted' };
    const { runner, issued } = createScriptedRunner(async (sql) => {
      if (sql.includes('INSERT INTO agentos.effect_reservations')) {
        return [];
      }
      if (sql.includes('FOR UPDATE')) {
        return [
          mockReservationRow({
            status: 'SUCCEEDED',
            run_id: 'ORIGINAL-RUN',
            response_receipt: receipt,
          }),
        ];
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const input: AdmitCareTurnInput = {
      tenant_id: TENANT,
      effect_key: EFFECT_KEY,
      request_id: REQUEST_ID,
      request_fingerprint: FINGERPRINT,
      run_id: 'NEW-RUN-ID',
      correlation_id: CORRELATION_ID,
      signal: { message: 'hello' },
      reservation_ttl_ms: RESERVATION_TTL_MS,
    };

    const outcome = await admitCareTurn(input, runner);

    expect(outcome).toEqual({
      kind: 'REPLAY',
      run_id: 'ORIGINAL-RUN',
      receipt,
    });
    expect(issued).toHaveLength(2);
  });

  it('returns RECONCILE_REQUIRED when reservation is expired or failed without receipt', async () => {
    const { runner: runnerExpired } = createScriptedRunner(async (sql) => {
      if (sql.includes('INSERT INTO agentos.effect_reservations')) return [];
      if (sql.includes('FOR UPDATE')) return [mockReservationRow({ status: 'RESERVED', expired: true })];
      throw new Error(`Unexpected query: ${sql}`);
    });

    const outcomeExpired = await admitCareTurn(
      {
        tenant_id: TENANT,
        effect_key: EFFECT_KEY,
        request_id: REQUEST_ID,
        request_fingerprint: FINGERPRINT,
        run_id: RUN_ID,
        correlation_id: CORRELATION_ID,
          signal: { message: 'hello' },
        reservation_ttl_ms: RESERVATION_TTL_MS,
      },
      runnerExpired,
    );
    expect(outcomeExpired).toEqual({ kind: 'RECONCILE_REQUIRED' });

    const { runner: runnerFailed } = createScriptedRunner(async (sql) => {
      if (sql.includes('INSERT INTO agentos.effect_reservations')) return [];
      if (sql.includes('FOR UPDATE')) return [mockReservationRow({ status: 'FAILED', response_receipt: null })];
      throw new Error(`Unexpected query: ${sql}`);
    });

    const outcomeFailed = await admitCareTurn(
      {
        tenant_id: TENANT,
        effect_key: EFFECT_KEY,
        request_id: REQUEST_ID,
        request_fingerprint: FINGERPRINT,
        run_id: RUN_ID,
        correlation_id: CORRELATION_ID,
          signal: { message: 'hello' },
        reservation_ttl_ms: RESERVATION_TTL_MS,
      },
      runnerFailed,
    );
    expect(outcomeFailed).toEqual({ kind: 'RECONCILE_REQUIRED' });
  });

  it('rolls back and writes nothing when the task insert fails in the same transaction', async () => {
    let rolledBack = false;
    const taskInsertError = new Error('DATABASE_CONNECTION_LOST');

    const runner = async <T>(_tenant: string, work: (c: PoolClient) => Promise<T>): Promise<T> => {
      const client = {
        async query<R extends QueryResultRow>(sql: string): Promise<QueryResult<R>> {
          if (sql.includes('INSERT INTO agentos.effect_reservations')) {
            return {
              rows: [mockReservationRow()] as unknown as R[],
              rowCount: 1,
              command: '',
              oid: 0,
              fields: [],
            };
          }
          if (sql.includes('INSERT INTO agentos.platform_durable_tasks')) {
            throw taskInsertError;
          }
          throw new Error(`Unexpected query: ${sql}`);
        },
      } as unknown as PoolClient;

      try {
        return await work(client);
      } catch (err) {
        rolledBack = true;
        throw err;
      }
    };

    const input: AdmitCareTurnInput = {
      tenant_id: TENANT,
      effect_key: EFFECT_KEY,
      request_id: REQUEST_ID,
      request_fingerprint: FINGERPRINT,
      run_id: RUN_ID,
      correlation_id: CORRELATION_ID,
      signal: { message: 'hello' },
      reservation_ttl_ms: RESERVATION_TTL_MS,
    };

    await expect(admitCareTurn(input, runner)).rejects.toThrow(taskInsertError);
    expect(rolledBack).toBe(true);
  });
});
