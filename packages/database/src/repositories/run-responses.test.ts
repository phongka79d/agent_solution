import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';

import { RunResponseRepository } from './run-responses.js';
import type { SaveRunResponseInput } from './run-responses.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const OTHER_TENANT = '22222222-2222-2222-2222-222222222222';
const RUN_ID = 'run-response-0001';
const CONVERSATION_ID = '01920000-0000-7000-8000-0000000000a3';
const MESSAGE_ID = '01920000-0000-7000-8000-0000000000d4';
const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');

interface ResponseRow extends QueryResultRow {
  tenant_id: string;
  run_id: string;
  answer: string;
  sources: unknown;
  conversation_id: string | null;
  message_id: string | null;
  created_at: Date;
}

interface MessageRow extends QueryResultRow {
  message_id: string;
}

interface IssuedStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function responseRow(overrides: Partial<ResponseRow> = {}): ResponseRow {
  return {
    tenant_id: TENANT,
    run_id: RUN_ID,
    answer: 'Nova Studio 14 is available.',
    sources: [{ evidence_id: 'evidence-1' }],
    conversation_id: null,
    message_id: null,
    created_at: CREATED_AT,
    ...overrides,
  };
}

function saveInput(overrides: Partial<SaveRunResponseInput> = {}): SaveRunResponseInput {
  return {
    tenant_id: TENANT,
    run_id: RUN_ID,
    answer: 'Nova Studio 14 is available.',
    sources: [{ evidence_id: 'evidence-1' }],
    sender_id: 'SAL-01',
    ...overrides,
  };
}

class ScriptedClient {
  readonly statements: IssuedStatement[] = [];
  response: ResponseRow | null = null;
  nextMessageFailure: unknown = undefined;

  async query<R extends QueryResultRow>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<R>> {
    this.statements.push({ sql, params });

    if (sql.startsWith('SELECT run_id')) {
      return { rows: [{ run_id: RUN_ID }], rowCount: 1 } as unknown as QueryResult<R>;
    }

    if (sql.startsWith('INSERT INTO agentos.run_responses')) {
      if (this.response !== null) {
        return { rows: [], rowCount: 0 } as unknown as QueryResult<R>;
      }

      const [tenant_id, run_id, answer, rawSources, conversation_id, message_id] = params;
      const sources = JSON.parse(String(rawSources));
      this.response = responseRow({
        tenant_id: String(tenant_id),
        run_id: String(run_id),
        answer: String(answer),
        sources,
        conversation_id: conversation_id === null ? null : String(conversation_id),
        message_id: message_id === null ? null : String(message_id),
      });
      return { rows: [this.response] as unknown as R[], rowCount: 1 } as unknown as QueryResult<R>;
    }

    if (sql.includes('FROM agentos.run_responses')) {
      return {
        rows: this.response === null ? [] : [this.response],
        rowCount: this.response === null ? 0 : 1,
      } as unknown as QueryResult<R>;
    }

    if (sql.startsWith('UPDATE agentos.conversations')) {
      return { rows: [{ id: CONVERSATION_ID }], rowCount: 1 } as unknown as QueryResult<R>;
    }

    if (sql.startsWith('INSERT INTO agentos.conversation_messages')) {
      if (this.nextMessageFailure !== undefined) throw this.nextMessageFailure;
      return {
        rows: [{ message_id: MESSAGE_ID } as MessageRow],
        rowCount: 1,
      } as unknown as QueryResult<R>;
    }


    throw new Error(`SCRIPTED_STATEMENT_UNKNOWN: ${sql}`);
  }
}

function harness(): {
  readonly repository: RunResponseRepository;
  readonly client: ScriptedClient;
  readonly boundTenants: string[];
} {
  const client = new ScriptedClient();
  const boundTenants: string[] = [];
  const repository = new RunResponseRepository(async (tenant_id, work) => {
    boundTenants.push(tenant_id);
    const responseBeforeTransaction = client.response;
    try {
      return await work(client as unknown as PoolClient);
    } catch (error) {
      client.response = responseBeforeTransaction;
      throw error;
    }
  });
  return { repository, client, boundTenants };
}

describe('RunResponseRepository', () => {
  it('persists a non-conversational response once and replays the same row without a message', async () => {
    const { repository, client, boundTenants } = harness();

    const first = await repository.save(saveInput());
    const second = await repository.save(saveInput());

    expect(second).toEqual(first);
    expect(client.statements.filter(({ sql }) => sql.startsWith('INSERT INTO agentos.conversation_messages'))).toHaveLength(0);
    expect(client.statements.map(({ sql }) => sql.split('\n', 1)[0])).toEqual([
      'SELECT run_id',
      'SELECT',
      'INSERT INTO agentos.run_responses (',
      'SELECT run_id',
      'SELECT',
    ]);
    expect(boundTenants).toEqual([TENANT, TENANT]);
  });

  it('writes the agent message and links it in the same transaction, then serializes replay by row lock', async () => {
    const { repository, client } = harness();

    const first = await repository.save(saveInput({ conversation_id: CONVERSATION_ID }));
    const second = await repository.save(saveInput({ conversation_id: CONVERSATION_ID }));

    expect(first.message_id).toBe(MESSAGE_ID);
    expect(second).toEqual(first);
    expect(client.statements.map(({ sql }) => sql.split('\n', 1)[0])).toEqual([
      'SELECT run_id',
      'SELECT',
      'UPDATE agentos.conversations',
      'INSERT INTO agentos.conversation_messages (',
      'INSERT INTO agentos.run_responses (',
      'SELECT run_id',
      'SELECT',
    ]);
    const messageWrites = client.statements.filter(({ sql }) => sql.startsWith('INSERT INTO agentos.conversation_messages'));
    expect(messageWrites).toHaveLength(1);
    expect(messageWrites[0]?.params).toEqual([TENANT, CONVERSATION_ID, 'SAL-01', 'Nova Studio 14 is available.']);
    expect(client.statements.find(({ sql }) => sql.includes('FOR UPDATE'))?.sql).toContain('FOR UPDATE');
  });

  it('refuses a conflicting replay before attempting any message write', async () => {
    const { repository, client } = harness();

    await repository.save(saveInput());

    await expect(
      repository.save(saveInput({ answer: 'A different answer.' })),
    ).rejects.toThrow('RUN_RESPONSE_CONFLICT');
    await expect(
      repository.save(saveInput({ sources: [{ evidence_id: 'different' }] })),
    ).rejects.toThrow('RUN_RESPONSE_CONFLICT');
    expect(client.statements.filter(({ sql }) => sql.startsWith('INSERT INTO agentos.conversation_messages'))).toHaveLength(0);
  });

  it('keeps tenant and run predicates on reads and returns null for another tenant scope', async () => {
    const { repository, client, boundTenants } = harness();

    const response = await repository.read(OTHER_TENANT, RUN_ID);

    expect(response).toBeNull();
    expect(boundTenants).toEqual([OTHER_TENANT]);
    expect(client.statements[0]?.params).toEqual([OTHER_TENANT, RUN_ID]);
  });

  it('fails the whole save when the message insert fails before response linkage', async () => {
    const { repository, client } = harness();
    client.nextMessageFailure = new Error('MESSAGE_WRITE_FAILED');

    await expect(
      repository.save(saveInput({ conversation_id: CONVERSATION_ID })),
    ).rejects.toThrow('MESSAGE_WRITE_FAILED');
    expect(client.response).toBeNull();
  });
});
