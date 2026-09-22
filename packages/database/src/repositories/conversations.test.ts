import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';

import { ConversationRepository } from './conversations.js';
import type {
  AppendConversationMessageInput,
  BindOrCreateConversationInput,
  ConversationMessageScope,
  ConversationState,
} from './conversations.js';

/**
 * Unit suite for conversation sessions and their turns (`agentos.conversations` /
 * `agentos.conversation_messages`, implement/06 §8.1 R01-R02, R06-R08).
 *
 * The repository is exercised against a scripted `pg` client instead of PostgreSQL: every statement
 * it issues is classified, recorded and answered from a per-transition script, so the bind-or-create,
 * the tenant scoping and the fail-closed refusals are asserted as the SQL-observable behaviour the
 * durable row actually shows — without a database.
 *
 * What is asserted is what a caller observes: which statement a call takes, the tenant every
 * statement is bound to, the values that reach the row, and which refusals happen before a
 * transaction is opened at all. The live half — RLS denial, the composite tenant-scoped foreign
 * keys, the `UNIQUE (tenant_id, channel, external_thread_id)` constraint itself — belongs to
 * `src/rls.test.ts` and is not duplicated here.
 */

/** Tenant bound to every statement; the repository is tenant-scoped by construction. */
const TENANT = '11111111-1111-1111-1111-111111111111';
const OTHER_TENANT = '22222222-2222-2222-2222-222222222222';

const CONVERSATION_ID = '01920000-0000-7000-8000-0000000000a3';
const MESSAGE_ID = '01920000-0000-7000-8000-0000000000d4';
const SECOND_MESSAGE_ID = '01920000-0000-7000-8000-0000000000d5';
const CUSTOMER_ID = '01920000-0000-7000-8000-0000000000c1';
const OPERATOR_ID = '01920000-0000-7000-8000-0000000000e5';

const CHANNEL = 'web_chat';
const THREAD = 'thread-0192-0001';

const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');
const LAST_MESSAGE_AT = new Date('2026-01-01T00:05:00.000Z');
const LATER_MESSAGE_AT = new Date('2026-01-01T00:06:00.000Z');

/** One conversation row exactly as `pg` returns it, before the projection is published. */
interface ConversationRow extends QueryResultRow {
  conversation_id: string;
  tenant_id: string;
  customer_id: string | null;
  channel: string;
  external_thread_id: string;
  active_agent: string;
  state: ConversationState;
  takeover_operator_id: string | null;
  last_message_at: Date;
  created_at: Date;
}

/** One message row, as the bounded page read publishes it. */
interface MessagePageRow extends QueryResultRow {
  message_id: string;
  sender_type: string;
  sender_id: string;
  content: string;
  created_at: Date;
}

/** Which statement of the repository a SQL text is: a test names the transition, not the text. */
type StatementKind = 'insert' | 'read_thread' | 'read' | 'state' | 'touch' | 'message' | 'messages';

function classify(sql: string): StatementKind {
  if (sql.startsWith('INSERT INTO agentos.conversations')) {
    return 'insert';
  }

  if (sql.startsWith('INSERT INTO agentos.conversation_messages')) {
    return 'message';
  }

  if (sql.includes('last_message_at = GREATEST')) {
    return 'touch';
  }

  if (sql.startsWith('UPDATE agentos.conversations')) {
    return 'state';
  }

  if (sql.includes('FROM agentos.conversation_messages')) {
    return 'messages';
  }

  if (sql.includes('external_thread_id = $3')) {
    return 'read_thread';
  }

  if (sql.startsWith('SELECT')) {
    return 'read';
  }

  throw new Error(`SCRIPTED_STATEMENT_UNKNOWN: no test scripts the statement "${sql}".`);
}

/** The `pg` result of one statement, as a test scripts it. */
interface ScriptedAnswer {
  /** Rows a `SELECT` / `INSERT ... RETURNING` / `UPDATE ... RETURNING` returns. */
  readonly rows?: readonly QueryResultRow[];
  /** `rowCount` of an `UPDATE`; omitted means the number of scripted rows. */
  readonly rowCount?: number | null;
  /** Error `pg` raises for this statement instead of a result. */
  readonly fails?: unknown;
}

type ScriptedAnswers = Partial<
  Record<StatementKind, ScriptedAnswer | ((params: readonly unknown[]) => ScriptedAnswer)>
>;

/** One statement the repository issued, with the parameters `pg` would have received. */
interface IssuedStatement {
  readonly kind: StatementKind;
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * Deterministic stand-in for the `pg` client of one tenant transaction: records every statement and
 * answers it from the script.
 */
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

    const scripted = this.answers[kind];

    if (scripted === undefined) {
      throw new Error(`SCRIPTED_ANSWER_MISSING: no scripted answer for a ${kind} statement.`);
    }

    const answer = typeof scripted === 'function' ? scripted(params) : scripted;

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

/** One repository wired to its scripted client and to the tenants its transactions were bound to. */
interface RepositoryHarness {
  readonly repository: ConversationRepository;
  readonly client: ScriptedClient;
  /** Tenants passed to the injected binder, in call order. */
  readonly boundTenants: string[];
}

function harnessFor(answers: ScriptedAnswers): RepositoryHarness {
  const client = new ScriptedClient(answers);
  const boundTenants: string[] = [];

  const repository = new ConversationRepository(async (tenant_id, work) => {
    boundTenants.push(tenant_id);

    return work(client as unknown as PoolClient);
  });

  return { repository, client, boundTenants };
}

/** One row carrying the canonical defaults of a bound conversation; a case overrides its subject. */
function conversationRow(overrides: Partial<ConversationRow> = {}): ConversationRow {
  const row: ConversationRow = {
    conversation_id: CONVERSATION_ID,
    tenant_id: TENANT,
    customer_id: CUSTOMER_ID,
    channel: CHANNEL,
    external_thread_id: THREAD,
    active_agent: 'auto',
    state: 'open',
    takeover_operator_id: null,
    last_message_at: LAST_MESSAGE_AT,
    created_at: CREATED_AT,
  };

  return Object.assign(row, overrides);
}

function messagePageRow(overrides: Partial<MessagePageRow> = {}): MessagePageRow {
  const row: MessagePageRow = {
    message_id: MESSAGE_ID,
    sender_type: 'agent',
    sender_id: 'SAL-01',
    content: 'Xin chao',
    created_at: LAST_MESSAGE_AT,
  };

  return Object.assign(row, overrides);
}

function bindInput(
  overrides: Partial<BindOrCreateConversationInput> = {},
): BindOrCreateConversationInput {
  const input: BindOrCreateConversationInput = {
    tenant_id: TENANT,
    channel: CHANNEL,
    external_thread_id: THREAD,
    customer_id: CUSTOMER_ID,
  };

  return Object.assign(input, overrides);
}

function messageInput(
  overrides: Partial<AppendConversationMessageInput> = {},
): AppendConversationMessageInput {
  const input: AppendConversationMessageInput = {
    tenant_id: TENANT,
    conversation_id: CONVERSATION_ID,
    sender_type: 'agent',
    sender_id: 'SAL-01',
    content: 'Xin chao',
  };

  return Object.assign(input, overrides);
}

function messageScope(overrides: Partial<ConversationMessageScope> = {}): ConversationMessageScope {
  const input: ConversationMessageScope = {
    tenant_id: TENANT,
    conversation_id: CONVERSATION_ID,
  };

  return Object.assign(input, overrides);
}

/** The parameters bound to the single statement of `kind`; fails the test when it was never issued. */
function bindingsOf(client: ScriptedClient, kind: StatementKind): readonly unknown[] {
  const statement = client.statements.find((candidate) => candidate.kind === kind);

  if (statement === undefined) {
    throw new Error(`SCRIPTED_STATEMENT_MISSING: no ${kind} statement was issued.`);
  }

  return statement.params;
}

/** The message of the error `work` failed with; fails the test when it did not fail. */
async function refusalOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error('EXPECTED_REFUSAL: the call succeeded, but the durable rule must refuse it.');
}

describe('ConversationRepository.bindOrCreate', () => {
  it('creates the conversation of a new thread binding and leaves the agent to the column default', async () => {
    const { repository, client, boundTenants } = harnessFor({ insert: { rows: [conversationRow()] } });

    const bound = await repository.bindOrCreate(bindInput());

    expect(boundTenants).toEqual([TENANT]);
    expect(client.statements.map((statement) => statement.kind)).toEqual(['insert']);
    expect(bindingsOf(client, 'insert')).toEqual([TENANT, CHANNEL, THREAD, CUSTOMER_ID]);
    expect(bound).toEqual({
      conversation_id: CONVERSATION_ID,
      tenant_id: TENANT,
      customer_id: CUSTOMER_ID,
      channel: CHANNEL,
      external_thread_id: THREAD,
      active_agent: 'auto',
      state: 'open',
      takeover_operator_id: null,
      last_message_at: '2026-01-01T00:05:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
      bound: false,
    });
  });

  it('binds the caller-supplied agent when one is supplied', async () => {
    const { repository, client } = harnessFor({
      insert: { rows: [conversationRow({ active_agent: 'SAL-01' })] },
    });

    const bound = await repository.bindOrCreate(bindInput({ active_agent: 'SAL-01' }));

    expect(bindingsOf(client, 'insert')).toEqual([TENANT, CHANNEL, THREAD, CUSTOMER_ID, 'SAL-01']);
    expect(bound.active_agent).toBe('SAL-01');
  });

  it('reports an already-bound thread as bound instead of creating a second conversation', async () => {
    const { repository, client, boundTenants } = harnessFor({
      insert: { rows: [] },
      read_thread: { rows: [conversationRow()] },
    });

    const bound = await repository.bindOrCreate(bindInput());

    // The unique key of the binding refused the insert, so the bind publishes the winner's row.
    expect(boundTenants).toEqual([TENANT]);
    expect(client.statements.map((statement) => statement.kind)).toEqual(['insert', 'read_thread']);
    expect(bindingsOf(client, 'read_thread')).toEqual([TENANT, CHANNEL, THREAD]);
    expect(bound).toEqual({
      conversation_id: CONVERSATION_ID,
      tenant_id: TENANT,
      customer_id: CUSTOMER_ID,
      channel: CHANNEL,
      external_thread_id: THREAD,
      active_agent: 'auto',
      state: 'open',
      takeover_operator_id: null,
      last_message_at: '2026-01-01T00:05:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
      bound: true,
    });
  });

  it('never rewrites the bound conversation: a null customer and a repeated bind leave it intact', async () => {
    const held = conversationRow({
      state: 'paused_takeover',
      takeover_operator_id: OPERATOR_ID,
      customer_id: CUSTOMER_ID,
      active_agent: 'SAL-02',
    });
    const { repository, client } = harnessFor({
      insert: { rows: [] },
      read_thread: { rows: [held] },
    });

    const bound = await repository.bindOrCreate(bindInput({ customer_id: null }));

    // The stored row is the answer for every field a bind could have moved, and the only
    // statements issued were the losing insert and the read: no state, no customer, no write.
    expect(bound.bound).toBe(true);
    expect(bound.customer_id).toBe(CUSTOMER_ID);
    expect(bound.state).toBe('paused_takeover');
    expect(bound.takeover_operator_id).toBe(OPERATOR_ID);
    expect(bound.active_agent).toBe('SAL-02');
    expect(client.statements.map((statement) => statement.kind)).toEqual(['insert', 'read_thread']);
  });

  it('fails closed when the binding is reported as taken but no conversation is visible', async () => {
    const { repository, client } = harnessFor({ insert: { rows: [] }, read_thread: { rows: [] } });

    const refusal = await refusalOf(repository.bindOrCreate(bindInput()));

    expect(refusal).toContain('CONVERSATION_UNSTABLE');
    expect(client.statements.map((statement) => statement.kind)).toEqual(['insert', 'read_thread']);
  });

  it('refuses a binding that cannot address a durable row before opening a transaction', async () => {
    const { repository, client, boundTenants } = harnessFor({});

    await expect(repository.bindOrCreate(bindInput({ tenant_id: '' }))).rejects.toThrow(
      'CONVERSATION_TENANT_ID_REQUIRED',
    );
    await expect(repository.bindOrCreate(bindInput({ channel: '   ' }))).rejects.toThrow(
      'CONVERSATION_CHANNEL_REQUIRED',
    );
    await expect(
      repository.bindOrCreate(bindInput({ channel: 'c'.repeat(33) })),
    ).rejects.toThrow('CONVERSATION_CHANNEL_REQUIRED');
    await expect(repository.bindOrCreate(bindInput({ external_thread_id: '' }))).rejects.toThrow(
      'CONVERSATION_THREAD_REQUIRED',
    );
    await expect(
      repository.bindOrCreate(bindInput({ customer_id: 'customer-1' })),
    ).rejects.toThrow('CONVERSATION_CUSTOMER_ID_INVALID');
    await expect(repository.bindOrCreate(bindInput({ active_agent: ' ' }))).rejects.toThrow(
      'CONVERSATION_ACTIVE_AGENT_INVALID',
    );

    expect(boundTenants).toEqual([]);
    expect(client.statements).toEqual([]);
  });
});

describe('ConversationRepository.get', () => {
  it('publishes the stored conversation with ISO-8601 timestamps', async () => {
    const { repository, client, boundTenants } = harnessFor({ read: { rows: [conversationRow()] } });

    const record = await repository.get(TENANT, CONVERSATION_ID);

    expect(boundTenants).toEqual([TENANT]);
    expect(client.statements.map((statement) => statement.kind)).toEqual(['read']);
    expect(bindingsOf(client, 'read')).toEqual([TENANT, CONVERSATION_ID]);
    expect(record).toEqual({
      conversation_id: CONVERSATION_ID,
      tenant_id: TENANT,
      customer_id: CUSTOMER_ID,
      channel: CHANNEL,
      external_thread_id: THREAD,
      active_agent: 'auto',
      state: 'open',
      takeover_operator_id: null,
      last_message_at: '2026-01-01T00:05:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
    });
  });

  it('reports nothing for a conversation another tenant holds', async () => {
    const { repository, client, boundTenants } = harnessFor({ read: { rows: [] } });

    await expect(repository.get(OTHER_TENANT, CONVERSATION_ID)).resolves.toBeNull();

    // The lookup leads with the caller's tenant, which is the only tenant the transaction is bound
    // to: the row of the owning tenant is invisible, and nothing is published in redacted form.
    expect(boundTenants).toEqual([OTHER_TENANT]);
    expect(bindingsOf(client, 'read')).toEqual([OTHER_TENANT, CONVERSATION_ID]);
  });

  it('refuses a missing or malformed conversation identity before opening a transaction', async () => {
    const { repository, client, boundTenants } = harnessFor({});

    await expect(repository.get(TENANT, '   ')).rejects.toThrow('CONVERSATION_ID_REQUIRED');
    await expect(repository.get(TENANT, 'thread-1')).rejects.toThrow('CONVERSATION_ID_INVALID');
    await expect(repository.get('', CONVERSATION_ID)).rejects.toThrow(
      'CONVERSATION_TENANT_ID_REQUIRED',
    );

    expect(boundTenants).toEqual([]);
    expect(client.statements).toEqual([]);
  });
});

describe('ConversationRepository.setState', () => {
  it('moves the conversation between the stored states and records the operator with each', async () => {
    const takeover = harnessFor({ state: { rows: [{ id: CONVERSATION_ID }] } });
    const resume = harnessFor({ state: { rows: [{ id: CONVERSATION_ID }] } });

    await expect(
      takeover.repository.setState(TENANT, CONVERSATION_ID, 'paused_takeover', OPERATOR_ID),
    ).resolves.toBe(true);

    expect(bindingsOf(takeover.client, 'state')).toEqual([
      TENANT,
      CONVERSATION_ID,
      'paused_takeover',
      OPERATOR_ID,
    ]);

    await expect(
      resume.repository.setState(TENANT, CONVERSATION_ID, 'open', null),
    ).resolves.toBe(true);

    // The release writes the state and the cleared operator as one decision.
    expect(bindingsOf(resume.client, 'state')).toEqual([TENANT, CONVERSATION_ID, 'open', null]);
  });

  it('reports false and creates nothing when no row of this tenant matched', async () => {
    const { repository, client, boundTenants } = harnessFor({ state: { rows: [] } });

    await expect(
      repository.setState(OTHER_TENANT, CONVERSATION_ID, 'closed', null),
    ).resolves.toBe(false);

    // A control action never inserts the conversation it was asked to move, and the tenant it was
    // bound to is the caller's own.
    expect(boundTenants).toEqual([OTHER_TENANT]);
    expect(client.statements.map((statement) => statement.kind)).toEqual(['state']);
  });

  it('refuses the wire vocabulary where a stored state is required', async () => {
    const { repository, client, boundTenants } = harnessFor({});

    for (const wire_state of ['ACTIVE', 'HUMAN_TAKEOVER', 'CLOSED']) {
      const refusal = await refusalOf(
        repository.setState(TENANT, CONVERSATION_ID, wire_state as ConversationState, OPERATOR_ID),
      );

      expect(refusal, wire_state).toContain('CONVERSATION_STATE_INVALID');
    }

    expect(boundTenants).toEqual([]);
    expect(client.statements).toEqual([]);
  });

  it('refuses a blank operator identity before opening a transaction', async () => {
    const { repository, client } = harnessFor({});

    await expect(
      repository.setState(TENANT, CONVERSATION_ID, 'paused_takeover', '   '),
    ).rejects.toThrow('CONVERSATION_OPERATOR_INVALID');
    expect(client.statements).toEqual([]);
  });
});

describe('ConversationRepository.appendMessage', () => {
  it('appends the turn and advances the conversation in one transaction', async () => {
    const { repository, client, boundTenants } = harnessFor({
      touch: { rows: [{ id: CONVERSATION_ID }] },
      message: { rows: [{ id: MESSAGE_ID }] },
    });

    await expect(repository.appendMessage(messageInput())).resolves.toBe(MESSAGE_ID);

    expect(boundTenants).toEqual([TENANT]);
    expect(client.statements.map((statement) => statement.kind)).toEqual(['touch', 'message']);
    expect(bindingsOf(client, 'touch')).toEqual([TENANT, CONVERSATION_ID]);

    // The turn's own columns; `content_type` and `metadata` are absent so the DDL defaults stand.
    expect(bindingsOf(client, 'message')).toEqual([
      TENANT,
      CONVERSATION_ID,
      'agent',
      'SAL-01',
      'Xin chao',
    ]);
  });

  it('stores the content type and metadata when the caller supplies them', async () => {
    const { repository, client } = harnessFor({
      touch: { rows: [{ id: CONVERSATION_ID }] },
      message: { rows: [{ id: MESSAGE_ID }] },
    });

    await repository.appendMessage(
      messageInput({
        sender_type: 'customer',
        sender_id: CUSTOMER_ID,
        content: 'Con hang khong?',
        content_type: 'quick_reply',
        metadata: { locale: 'vi' },
      }),
    );

    // `metadata` reaches the statement as the object node-pg serializes into the jsonb column.
    expect(bindingsOf(client, 'message')).toEqual([
      TENANT,
      CONVERSATION_ID,
      'customer',
      CUSTOMER_ID,
      'Con hang khong?',
      'quick_reply',
      { locale: 'vi' },
    ]);
  });

  it('refuses to append a turn to a conversation this tenant does not hold', async () => {
    const { repository, client, boundTenants } = harnessFor({ touch: { rows: [] } });

    const refusal = await refusalOf(repository.appendMessage(messageInput()));

    expect(refusal).toContain('CONVERSATION_NOT_FOUND');
    expect(boundTenants).toEqual([TENANT]);

    // The conversation is advanced first and refused when the tenant does not hold it, so no
    // message row is ever inserted for a conversation that is not there.
    expect(client.statements.map((statement) => statement.kind)).toEqual(['touch']);
  });

  it('refuses a sender or identity outside the stored vocabulary before opening a transaction', async () => {
    const { repository, client, boundTenants } = harnessFor({});

    for (const sender_type of ['bot', 'assistant', 'AGENT']) {
      await expect(
        repository.appendMessage(
          messageInput({ sender_type: sender_type as AppendConversationMessageInput['sender_type'] }),
        ),
        sender_type,
      ).rejects.toThrow('CONVERSATION_SENDER_TYPE_INVALID');
    }

    await expect(repository.appendMessage(messageInput({ sender_id: '' }))).rejects.toThrow(
      'CONVERSATION_SENDER_ID_REQUIRED',
    );
    await expect(repository.appendMessage(messageInput({ content_type: '' }))).rejects.toThrow(
      'CONVERSATION_CONTENT_TYPE_INVALID',
    );

    expect(boundTenants).toEqual([]);
    expect(client.statements).toEqual([]);
  });
});

describe('ConversationRepository.listMessages', () => {
  it('publishes the stored turns as an ascending page with ISO-8601 instants', async () => {
    const { repository, client, boundTenants } = harnessFor({
      messages: {
        rows: [
          messagePageRow({ sender_type: 'customer', sender_id: CUSTOMER_ID, content: 'Hello' }),
          messagePageRow({
            message_id: SECOND_MESSAGE_ID,
            content: 'Xin chao',
            created_at: LATER_MESSAGE_AT,
          }),
        ],
      },
    });

    const messages = await repository.listMessages(messageScope());

    expect(boundTenants).toEqual([TENANT]);
    expect(client.statements.map((statement) => statement.kind)).toEqual(['messages']);
    expect(bindingsOf(client, 'messages')).toEqual([TENANT, CONVERSATION_ID, 50]);
    expect(messages).toEqual([
      {
        message_id: MESSAGE_ID,
        sender_type: 'customer',
        sender_id: CUSTOMER_ID,
        content: 'Hello',
        created_at: '2026-01-01T00:05:00.000Z',
      },
      {
        message_id: SECOND_MESSAGE_ID,
        sender_type: 'agent',
        sender_id: 'SAL-01',
        content: 'Xin chao',
        created_at: '2026-01-01T00:06:00.000Z',
      },
    ]);
  });

  it('binds the requested page size', async () => {
    const { repository, client } = harnessFor({ messages: { rows: [] } });

    await repository.listMessages(messageScope({ limit: 20 }));

    expect(bindingsOf(client, 'messages')[2]).toBe(20);
  });

  it('reports an empty history for a conversation of another tenant', async () => {
    const { repository, client, boundTenants } = harnessFor({ messages: { rows: [] } });

    await expect(
      repository.listMessages(messageScope({ tenant_id: OTHER_TENANT })),
    ).resolves.toEqual([]);

    expect(boundTenants).toEqual([OTHER_TENANT]);
    expect(bindingsOf(client, 'messages')).toEqual([OTHER_TENANT, CONVERSATION_ID, 50]);
  });

  it('refuses a page size outside 1..200 instead of shrinking it', async () => {
    const { repository, client, boundTenants } = harnessFor({});

    for (const limit of [0, -1, 201, 1.5, Number.NaN]) {
      const refusal = await refusalOf(repository.listMessages(messageScope({ limit })));

      expect(refusal, String(limit)).toContain('CONVERSATION_MESSAGE_LIMIT_INVALID');
    }

    expect(boundTenants).toEqual([]);
    expect(client.statements).toEqual([]);
  });
});
