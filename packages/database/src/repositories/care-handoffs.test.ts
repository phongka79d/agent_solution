import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';

import type {
  CareHandoffExecutionReceipt,
  CareHandoffOutput,
  EnqueueCareHandoffInput,
} from '../contracts/care-handoffs.js';
import { CareHandoffRepository } from './care-handoffs.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = 'cccccccc-0000-4000-8000-00000000000c';
const CUSTOMER_ID = 'aaaaaaaa-0000-4000-8000-00000000000a';
const HANDOFF_ID = 'eeeeeeee-0000-4000-8000-00000000000e';
const OPERATOR_ID = 'operator-42';
const RUN_ID = 'run-care-1';
const REQUEST_ID = 'request-care-1';
const EFFECT_KEY = 'a'.repeat(64);
const FINGERPRINT = 'b'.repeat(64);
const TIMESTAMP = '2026-04-15T12:00:00.000Z';

const CHECKPOINT = {
  plan: { plan_id: 'plan-1' },
  current_step: 2,
  pending_action: {
    skill_id: 'skill.care.escalate_to_human',
    effect_key: EFFECT_KEY,
    run_id: RUN_ID,
    tenant_id: TENANT_ID,
    step_index: 2,
    request_id: REQUEST_ID,
  },
  context: { session_id: 'thread-1' },
  previous_evidence_hash: '0'.repeat(64),
  request_id: REQUEST_ID,
};

const INPUT: EnqueueCareHandoffInput = {
  tenant_id: TENANT_ID,
  effect_key: EFFECT_KEY,
  request_fingerprint: FINGERPRINT,
  run_id: RUN_ID,
  session_id: 'thread-1',
  conversation_id: CONVERSATION_ID,
  customer_id: CUSTOMER_ID,
  escalation_reason: 'billing dispute',
  summary_context: 'Customer requests an agent.',
};

interface IssuedQuery {
  readonly sql: string;
  readonly params: readonly unknown[];
}

class ScriptedClient {
  readonly queries: IssuedQuery[] = [];

  constructor(private readonly respond: (sql: string, params: readonly unknown[]) => readonly QueryResultRow[]) {}

  async query<Row extends QueryResultRow>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<Row>> {
    this.queries.push({ sql, params });
    const rows = this.respond(sql, params) as Row[];
    return { rows, rowCount: rows.length } as QueryResult<Row>;
  }
}

function testReceipt(status: 'ENQUEUED' | 'ASSIGNED' = 'ENQUEUED'): CareHandoffExecutionReceipt {
  const output: CareHandoffOutput = {
    handoff_id: HANDOFF_ID,
    queue_position: 2,
    status,
    escalated_at: TIMESTAMP,
  };
  return {
    execution_id: HANDOFF_ID,
    adapter_status: 'SUCCESS',
    provider_reference: HANDOFF_ID,
    response_payload: output,
    latency_ms: 0,
    token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
  };
}

function existingHandoff(status: 'ENQUEUED' | 'ASSIGNED' = 'ENQUEUED', operatorId: string | null = null) {
  const receipt = testReceipt(status);
  return {
    handoff_id: HANDOFF_ID,
    request_fingerprint: FINGERPRINT,
    run_id: RUN_ID,
    step_index: 2,
    skill_id: 'skill.care.escalate_to_human',
    result_payload: receipt.response_payload,
    execution_receipt: receipt,
    status,
    operator_id: operatorId,
  };
}

function harnessFor(respond: (sql: string, params: readonly unknown[]) => readonly QueryResultRow[]) {
  const client = new ScriptedClient(respond);
  const tenants: string[] = [];
  const repository = new CareHandoffRepository(async (tenantId, work) => {
    tenants.push(tenantId);
    return work(client as unknown as PoolClient);
  });
  return { repository, client, tenants };
}

function statement(sql: string, contains: string): boolean {
  return sql.includes(contains);
}

describe('CareHandoffRepository', () => {
  it('parks a bound leased task and settles its reservation with one stable queue receipt', async () => {
    const { repository, client, tenants } = harnessFor((sql) => {
      if (statement(sql, 'set_config(') || statement(sql, 'pg_advisory_xact_lock')) return [];
      if (statement(sql, 'FROM agentos.care_handoffs') && statement(sql, 'effect_key = $2')) return [];
      if (statement(sql, 'FROM agentos.platform_durable_tasks')) {
        return [{
          state: 'running',
          current_step: 2,
          task_version: 4,
          lease_owner: 'worker-1',
          lease_active: true,
          state_payload: CHECKPOINT,
        }];
      }
      if (statement(sql, 'FROM agentos.conversations')) {
        return [{ customer_id: CUSTOMER_ID, external_thread_id: 'thread-1', state: 'open', takeover_operator_id: null }];
      }
      if (statement(sql, "status IN ('ENQUEUED', 'ASSIGNED')")) return [];
      if (statement(sql, 'FROM agentos.effect_reservations')) {
        return [{
          request_id: REQUEST_ID,
          request_fingerprint: FINGERPRINT,
          run_id: RUN_ID,
          step_index: 2,
          skill_id: 'skill.care.escalate_to_human',
          status: 'RESERVED',
          response_receipt: null,
        }];
      }
      if (statement(sql, 'COUNT(*)::int + 1')) return [{ queue_position: 2 }];
      if (statement(sql, 'uuid_generate_v7()')) return [{ handoff_id: HANDOFF_ID, created_at: TIMESTAMP }];
      if (statement(sql, 'INSERT INTO agentos.care_handoffs')) return [];
      if (statement(sql, 'UPDATE agentos.platform_durable_tasks')) return [{ run_id: RUN_ID }];
      if (statement(sql, 'UPDATE agentos.conversations')) return [{ id: CONVERSATION_ID }];
      if (statement(sql, 'UPDATE agentos.effect_reservations')) return [{ effect_key: EFFECT_KEY }];
      throw new Error('UNEXPECTED_HANDOFF_SQL:' + sql);
    });

    const result = await repository.enqueue(INPUT);

    expect(result).toEqual({ disposition: 'CREATED', output: testReceipt().response_payload, receipt: testReceipt() });
    expect(tenants).toEqual([TENANT_ID]);
    const writes = client.queries.filter(({ sql }) =>
      /^(INSERT INTO|UPDATE) agentos\.(care_handoffs|platform_durable_tasks|conversations|effect_reservations)/.test(sql.trim()),
    );
    expect(writes.map(({ sql }) => sql.match(/(?:INSERT INTO|UPDATE) agentos\.([a-z_]+)/)?.[1])).toEqual([
      'care_handoffs', 'platform_durable_tasks', 'conversations', 'effect_reservations',
    ]);
    expect(writes[1]?.sql).toContain('lease_owner = NULL, lease_expires_at = NULL');
    expect(writes[3]?.params[3]).toBe(JSON.stringify(testReceipt()));
    expect(client.queries.filter(({ sql }) => statement(sql, 'set_config(')).length).toBeGreaterThan(0);
  });

  it('replays the persisted output and rejects a changed request fingerprint without queue writes', async () => {
    const saved = existingHandoff();
    const replay = harnessFor((sql) => {
      if (statement(sql, 'set_config(') || statement(sql, 'pg_advisory_xact_lock')) return [];
      if (statement(sql, 'FROM agentos.care_handoffs') && statement(sql, 'effect_key = $2')) return [saved];
      if (statement(sql, 'FROM agentos.effect_reservations')) {
        return [{
          request_id: REQUEST_ID,
          request_fingerprint: FINGERPRINT,
          run_id: RUN_ID,
          step_index: 2,
          skill_id: 'skill.care.escalate_to_human',
          status: 'SUCCEEDED',
          response_receipt: testReceipt(),
        }];
      }
      throw new Error('REPLAY_MUST_NOT_READ_OR_WRITE_QUEUE_STATE');
    });

    await expect(replay.repository.enqueue(INPUT)).resolves.toEqual({
      disposition: 'REPLAY', output: testReceipt().response_payload, receipt: testReceipt(),
    });
    expect(replay.client.queries.some(({ sql }) => /^(INSERT INTO|UPDATE) agentos\./.test(sql.trim()))).toBe(false);

    const conflict = harnessFor((sql) => {
      if (statement(sql, 'set_config(') || statement(sql, 'pg_advisory_xact_lock')) return [];
      if (statement(sql, 'FROM agentos.care_handoffs') && statement(sql, 'effect_key = $2')) {
        return [{ ...saved, request_fingerprint: 'c'.repeat(64) }];
      }
      throw new Error('FINGERPRINT_CONFLICT_MUST_STOP_BEFORE_RESERVATION_READ');
    });
    await expect(conflict.repository.enqueue(INPUT)).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);
    expect(conflict.client.queries.some(({ sql }) => statement(sql, 'FROM agentos.effect_reservations'))).toBe(false);
  });

  it('atomically assigns, refuses another operator, and completes only for the assigned owner', async () => {
    let status: 'ENQUEUED' | 'ASSIGNED' | 'COMPLETED' = 'ENQUEUED';
    let assignedOperator: string | null = null;
    let conversationState = 'open';
    let conversationOperator: string | null = null;
    const { repository, client } = harnessFor((sql, params) => {
      if (statement(sql, 'set_config(') || statement(sql, 'pg_advisory_xact_lock')) return [];
      if (statement(sql, 'FROM agentos.conversations')) {
        return [{ customer_id: CUSTOMER_ID, external_thread_id: 'thread-1', state: conversationState, takeover_operator_id: conversationOperator }];
      }
      if (statement(sql, 'FROM agentos.care_handoffs') && statement(sql, 'conversation_id = $2')) {
        return status === 'COMPLETED' ? [] : [{
          handoff_id: HANDOFF_ID,
          run_id: RUN_ID,
          status,
          operator_id: assignedOperator,
        }];
      }
      if (statement(sql, 'UPDATE agentos.care_handoffs') && statement(sql, "SET status = 'ASSIGNED'")) {
        status = 'ASSIGNED';
        assignedOperator = String(params[2]);
        return [{ id: HANDOFF_ID }];
      }
      if (statement(sql, 'UPDATE agentos.care_handoffs') && statement(sql, "SET status = 'COMPLETED'")) {
        status = 'COMPLETED';
        return [{ id: HANDOFF_ID }];
      }
      if (statement(sql, 'UPDATE agentos.conversations')) {
        conversationState = sql.includes("SET state = 'open'") ? 'open' : 'paused_takeover';
        conversationOperator = conversationState === 'open' ? null : String(params[2]);
        return [{ id: CONVERSATION_ID }];
      }
      if (statement(sql, 'FROM agentos.platform_durable_tasks')) return [{ state: 'awaiting_human' }];
      if (statement(sql, 'UPDATE agentos.platform_durable_tasks')) return [{ run_id: RUN_ID }];
      throw new Error('UNEXPECTED_HANDOFF_SQL:' + sql);
    });

    await expect(repository.claim({ tenant_id: TENANT_ID, conversation_id: CONVERSATION_ID, operator_id: OPERATOR_ID }))
      .resolves.toBe('CLAIMED');
    await expect(repository.claim({ tenant_id: TENANT_ID, conversation_id: CONVERSATION_ID, operator_id: 'operator-99' }))
      .resolves.toBe('HELD_BY_ANOTHER_OPERATOR');
    await expect(repository.complete({ tenant_id: TENANT_ID, conversation_id: CONVERSATION_ID, operator_id: 'operator-99' }))
      .resolves.toBe('HELD_BY_ANOTHER_OPERATOR');
    await expect(repository.complete({
      tenant_id: TENANT_ID,
      conversation_id: CONVERSATION_ID,
      operator_id: OPERATOR_ID,
      completion_summary: 'Refund issued.',
    })).resolves.toBe('COMPLETED');

    expect(status).toBe('COMPLETED');
    expect(conversationState).toBe('open');
    expect(conversationOperator).toBeNull();
    expect(client.queries.filter(({ sql }) => statement(sql, 'UPDATE agentos.platform_durable_tasks'))).toHaveLength(1);
    expect(client.queries.find(({ sql }) => statement(sql, "SET state = 'completed'"))?.params).toEqual([TENANT_ID, RUN_ID]);
  });

  it('rejects a handoff whose pending action is not the complete durable checkpoint', async () => {
    const { repository, client } = harnessFor((sql) => {
      if (statement(sql, 'set_config(') || statement(sql, 'pg_advisory_xact_lock')) return [];
      if (statement(sql, 'FROM agentos.care_handoffs') && statement(sql, 'effect_key = $2')) return [];
      if (statement(sql, 'FROM agentos.platform_durable_tasks')) {
        return [{
          state: 'running',
          current_step: 2,
          task_version: 4,
          lease_owner: 'worker-1',
          lease_active: true,
          state_payload: { ...CHECKPOINT, pending_action: null },
        }];
      }
      throw new Error('INVALID_CHECKPOINT_MUST_STOP_BEFORE_CONVERSATION_READ');
    });

    await expect(repository.enqueue(INPUT)).rejects.toThrow(/HANDOFF_CHECKPOINT_MISMATCH/);
    expect(client.queries.some(({ sql }) => statement(sql, 'FROM agentos.conversations'))).toBe(false);
  });
});
