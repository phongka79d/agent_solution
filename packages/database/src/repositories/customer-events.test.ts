import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';

import { CustomerEventRepository } from './customer-events.js';
import type {
  AppendCustomerEventInput,
  CustomerEventTimelineQuery,
} from './customer-events.js';

/**
 * Unit suite for the behavioural event journal and its timeline (`agentos.customer_events`,
 * implement/06 §8.1 R04/R12/R15 and §9.2).
 *
 * The repository is exercised against a scripted `pg` client instead of PostgreSQL: every statement
 * it issues is classified, recorded and answered from a per-transition script, so the deduplication
 * of a replayed delivery, the tenant scoping of the timeline and the key parsing of the cursor are
 * asserted as the SQL-observable behaviour the durable rows actually show — without a database.
 *
 * What is asserted is what a caller observes: which statement a call takes, the tenant every
 * statement is bound to, the values and the keyset that reach the row, and which refusals happen
 * before a transaction is opened at all. The live half — RLS denial, the composite tenant-scoped
 * foreign key, the `UNIQUE (tenant_id, source_event_id)` constraint itself — belongs to
 * `src/rls.test.ts` and is not duplicated here.
 */

/** Tenant bound to every statement; the repository is tenant-scoped by construction. */
const TENANT = '11111111-1111-1111-1111-111111111111';
const OTHER_TENANT = '22222222-2222-2222-2222-222222222222';

const EVENT_ID = '01920000-0000-7000-8000-0000000000b1';
const SECOND_EVENT_ID = '01920000-0000-7000-8000-0000000000b2';
const THIRD_EVENT_ID = '01920000-0000-7000-8000-0000000000b3';
const CUSTOMER_ID = '01920000-0000-7000-8000-0000000000c1';

const SOURCE_EVENT_ID = 'evt-0192-0001';
const EVENT_NAME = 'product_view';
const SESSION_ID = 'sess-0192-0001';
const CHANNEL = 'web_chat';

const OCCURRED_AT = new Date('2026-01-01T00:00:00.000Z');
const OCCURRED_AT_ISO = '2026-01-01T00:00:00.000Z';
const LATER_OCCURRED_AT = new Date('2026-01-01T00:01:00.000Z');
const LATEST_OCCURRED_AT = new Date('2026-01-01T00:02:00.000Z');
const WINDOW_FROM = '2025-12-01T00:00:00.000Z';
const WINDOW_TO = '2026-01-31T00:00:00.000Z';

/** One timeline row exactly as `pg` returns it, before it is published. */
interface TimelineRow extends QueryResultRow {
  event_id: string;
  source_event_id: string;
  event_name: string;
  session_id: string;
  channel: string;
  occurred_at: Date;
  payload: Record<string, unknown>;
}

/** One stored receipt row exactly as `pg` returns it, before it is published. */
interface ReceiptRow extends QueryResultRow {
  event_id: string;
  event_name: string;
  occurred_at: Date;
}

/** Which statement of the repository a SQL text is: a test names the transition, not the text. */
type StatementKind = 'insert' | 'read_source' | 'timeline';

function classify(sql: string): StatementKind {
  if (sql.startsWith('INSERT INTO agentos.customer_events')) {
    // The deduplication of §9.2 is the conflict clause of the append itself; without it the append
    // would store a second row for an identity the schema already carries.
    if (!sql.includes('ON CONFLICT (tenant_id, source_event_id) DO NOTHING')) {
      throw new Error(
        `SCRIPTED_STATEMENT_UNKNOWN: the append must deduplicate on the delivery identity, but the ` +
          `statement is "${sql}".`,
      );
    }

    return 'insert';
  }

  if (sql.includes('source_event_id = $2')) {
    return 'read_source';
  }

  if (sql.startsWith('SELECT')) {
    return 'timeline';
  }

  throw new Error(`SCRIPTED_STATEMENT_UNKNOWN: no test scripts the statement "${sql}".`);
}

/** The `pg` result of one statement, as a test scripts it. */
interface ScriptedAnswer {
  /** Rows a `SELECT` / `INSERT ... RETURNING` returns. */
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
  readonly repository: CustomerEventRepository;
  readonly client: ScriptedClient;
  /** Tenants passed to the injected binder, in call order. */
  readonly boundTenants: string[];
}

function harnessFor(answers: ScriptedAnswers): RepositoryHarness {
  const client = new ScriptedClient(answers);
  const boundTenants: string[] = [];

  const repository = new CustomerEventRepository(async (tenant_id, work) => {
    boundTenants.push(tenant_id);

    return work(client as unknown as PoolClient);
  });

  return { repository, client, boundTenants };
}

/** One stored event carrying the canonical defaults of a delivery; a case overrides its subject. */
function timelineRow(overrides: Partial<TimelineRow> = {}): TimelineRow {
  const row: TimelineRow = {
    event_id: EVENT_ID,
    source_event_id: SOURCE_EVENT_ID,
    event_name: EVENT_NAME,
    session_id: SESSION_ID,
    channel: CHANNEL,
    occurred_at: OCCURRED_AT,
    payload: { sku: 'SKU-1' },
  };

  return Object.assign(row, overrides);
}

function receiptRow(overrides: Partial<ReceiptRow> = {}): ReceiptRow {
  const row: ReceiptRow = {
    event_id: EVENT_ID,
    event_name: EVENT_NAME,
    occurred_at: OCCURRED_AT,
  };

  return Object.assign(row, overrides);
}

function appendInput(overrides: Partial<AppendCustomerEventInput> = {}): AppendCustomerEventInput {
  const input: AppendCustomerEventInput = {
    tenant_id: TENANT,
    source_event_id: SOURCE_EVENT_ID,
    event_name: EVENT_NAME,
    session_id: SESSION_ID,
    channel: CHANNEL,
    customer_id: CUSTOMER_ID,
    occurred_at: OCCURRED_AT_ISO,
    payload: { sku: 'SKU-1' },
  };

  return Object.assign(input, overrides);
}

function timelineQuery(
  overrides: Partial<CustomerEventTimelineQuery> = {},
): CustomerEventTimelineQuery {
  const input: CustomerEventTimelineQuery = {
    tenant_id: TENANT,
    customer_id: CUSTOMER_ID,
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

describe('CustomerEventRepository.append', () => {
  it('stores a first delivery and publishes its durable identity', async () => {
    const { repository, client, boundTenants } = harnessFor({
      insert: { rows: [{ event_id: EVENT_ID }] },
    });

    await expect(repository.append(appendInput())).resolves.toEqual({
      inserted: true,
      event_id: EVENT_ID,
    });

    expect(boundTenants).toEqual([TENANT]);
    expect(client.statements.map((statement) => statement.kind)).toEqual(['insert']);
    expect(bindingsOf(client, 'insert')).toEqual([
      TENANT,
      SOURCE_EVENT_ID,
      EVENT_NAME,
      SESSION_ID,
      CHANNEL,
      CUSTOMER_ID,
      OCCURRED_AT_ISO,
      '{"sku":"SKU-1"}',
    ]);
  });

  it('reports a duplicate delivery as not inserted and reads nothing back', async () => {
    const { repository, client } = harnessFor({ insert: { rows: [] } });

    await expect(repository.append(appendInput())).resolves.toEqual({
      inserted: false,
      event_id: null,
    });

    // A redelivery of a stored identity is not an error and produces no second statement: the
    // deduplicating insert is the whole call, so no column of the stored row can be touched. The
    // replay receipt is published by `findByIdempotencyKey()`.
    expect(client.statements.map((statement) => statement.kind)).toEqual(['insert']);
  });

  it('replays a delivery without rewriting the row it already stored', async () => {
    let stored = false;
    const { repository, client } = harnessFor({
      insert: () => {
        if (stored) {
          return { rows: [] };
        }

        stored = true;

        return { rows: [{ event_id: EVENT_ID }] };
      },
    });

    await expect(repository.append(appendInput())).resolves.toEqual({
      inserted: true,
      event_id: EVENT_ID,
    });
    await expect(repository.append(appendInput())).resolves.toEqual({
      inserted: false,
      event_id: null,
    });

    const inserts = client.statements.filter((statement) => statement.kind === 'insert');

    expect(inserts).toHaveLength(2);
    // The replay carries the identical delivery: the same identity, instant and payload bytes reach
    // the row, and the conflicting statement writes nothing at all.
    expect(inserts[1]?.params).toEqual(inserts[0]?.params);
    expect(client.statements.map((statement) => statement.kind)).toEqual(['insert', 'insert']);
  });

  it('appends an anonymous session by binding a null customer', async () => {
    const { repository, client } = harnessFor({ insert: { rows: [{ event_id: EVENT_ID }] } });

    await repository.append(appendInput({ customer_id: null }));

    expect(bindingsOf(client, 'insert')[5]).toBeNull();
  });

  it('refuses a delivery that cannot address a durable row before opening a transaction', async () => {
    const { repository, client, boundTenants } = harnessFor({});

    await expect(repository.append(appendInput({ tenant_id: '' }))).rejects.toThrow(
      'CUSTOMER_EVENT_TENANT_ID_REQUIRED',
    );
    await expect(repository.append(appendInput({ source_event_id: '  ' }))).rejects.toThrow(
      'CUSTOMER_EVENT_SOURCE_ID_REQUIRED',
    );
    await expect(repository.append(appendInput({ event_name: '' }))).rejects.toThrow(
      'CUSTOMER_EVENT_NAME_REQUIRED',
    );
    await expect(repository.append(appendInput({ session_id: '' }))).rejects.toThrow(
      'CUSTOMER_EVENT_SESSION_REQUIRED',
    );
    await expect(repository.append(appendInput({ channel: '' }))).rejects.toThrow(
      'CUSTOMER_EVENT_CHANNEL_REQUIRED',
    );
    await expect(repository.append(appendInput({ occurred_at: 'yesterday' }))).rejects.toThrow(
      'CUSTOMER_EVENT_OCCURRED_AT_INVALID',
    );
    await expect(repository.append(appendInput({ customer_id: 'customer-1' }))).rejects.toThrow(
      'CUSTOMER_EVENT_CUSTOMER_ID_INVALID',
    );

    expect(boundTenants).toEqual([]);
    expect(client.statements).toEqual([]);
  });

  it('refuses a payload it cannot store durably instead of dropping it', async () => {
    const { repository, client } = harnessFor({});

    await expect(
      repository.append(appendInput({ payload: { total: 1n } })),
    ).rejects.toThrow('CUSTOMER_EVENT_PAYLOAD_INVALID');

    expect(client.statements).toEqual([]);
  });
});

describe('CustomerEventRepository.listTimeline', () => {
  it('publishes one customer timeline page with ISO-8601 instants and the stored payload', async () => {
    const { repository, client, boundTenants } = harnessFor({
      timeline: {
        rows: [
          timelineRow(),
          timelineRow({
            event_id: SECOND_EVENT_ID,
            source_event_id: 'evt-0192-0002',
            event_name: 'add_to_cart',
            occurred_at: LATER_OCCURRED_AT,
            payload: { sku: 'SKU-1', quantity: 2 },
          }),
        ],
      },
    });

    const page = await repository.listTimeline(timelineQuery());

    expect(boundTenants).toEqual([TENANT]);
    expect(client.statements.map((statement) => statement.kind)).toEqual(['timeline']);
    // One row more than the page is read, so a short page proves the timeline ends here.
    expect(bindingsOf(client, 'timeline')).toEqual([TENANT, CUSTOMER_ID, null, null, null, null, 51]);
    expect(page).toEqual({
      items: [
        {
          event_id: EVENT_ID,
          source_event_id: SOURCE_EVENT_ID,
          event_name: EVENT_NAME,
          session_id: SESSION_ID,
          channel: CHANNEL,
          occurred_at: OCCURRED_AT_ISO,
          payload: { sku: 'SKU-1' },
        },
        {
          event_id: SECOND_EVENT_ID,
          source_event_id: 'evt-0192-0002',
          event_name: 'add_to_cart',
          session_id: SESSION_ID,
          channel: CHANNEL,
          occurred_at: '2026-01-01T00:01:00.000Z',
          payload: { sku: 'SKU-1', quantity: 2 },
        },
      ],
      next_cursor: null,
    });
  });

  it('publishes the cursor of its last item exactly when a further page exists', async () => {
    const full = harnessFor({
      timeline: {
        rows: [
          timelineRow(),
          timelineRow({
            event_id: SECOND_EVENT_ID,
            source_event_id: 'evt-0192-0002',
            occurred_at: LATER_OCCURRED_AT,
          }),
          timelineRow({
            event_id: THIRD_EVENT_ID,
            source_event_id: 'evt-0192-0003',
            occurred_at: LATEST_OCCURRED_AT,
          }),
        ],
      },
    });
    const last = harnessFor({
      timeline: { rows: [timelineRow(), timelineRow({ event_id: SECOND_EVENT_ID })] },
    });

    const page = await full.repository.listTimeline(timelineQuery({ limit: 2 }));
    const end = await last.repository.listTimeline(timelineQuery({ limit: 2 }));

    expect(bindingsOf(full.client, 'timeline')).toEqual([
      TENANT,
      CUSTOMER_ID,
      null,
      null,
      null,
      null,
      3,
    ]);
    expect(page.items.map((item) => item.event_id)).toEqual([EVENT_ID, SECOND_EVENT_ID]);
    expect(page.next_cursor).toBe(`${LATER_OCCURRED_AT.toISOString()}|${SECOND_EVENT_ID}`);
    expect(end.items).toHaveLength(2);
    expect(end.next_cursor).toBeNull();
    expect(bindingsOf(last.client, 'timeline')[6]).toBe(3);
  });

  it('resumes strictly after the cursor key and binds the requested window', async () => {
    const cursor = `${LATER_OCCURRED_AT.toISOString()}|${SECOND_EVENT_ID}`;
    const { repository, client } = harnessFor({ timeline: { rows: [] } });

    await expect(
      repository.listTimeline(timelineQuery({ from: WINDOW_FROM, to: WINDOW_TO, cursor })),
    ).resolves.toEqual({ items: [], next_cursor: null });

    expect(bindingsOf(client, 'timeline')).toEqual([
      TENANT,
      CUSTOMER_ID,
      WINDOW_FROM,
      WINDOW_TO,
      LATER_OCCURRED_AT.toISOString(),
      SECOND_EVENT_ID,
      51,
    ]);
  });

  it('reports an empty page for a customer another tenant holds', async () => {
    const { repository, client, boundTenants } = harnessFor({ timeline: { rows: [] } });

    await expect(
      repository.listTimeline(timelineQuery({ tenant_id: OTHER_TENANT })),
    ).resolves.toEqual({ items: [], next_cursor: null });

    // The read leads with the caller's tenant and the customer it asks for, so another tenant's
    // events are out of scope by predicate and by row-level security alike.
    expect(boundTenants).toEqual([OTHER_TENANT]);
    expect(bindingsOf(client, 'timeline').slice(0, 2)).toEqual([OTHER_TENANT, CUSTOMER_ID]);
  });

  it('refuses a malformed cursor instead of applying it as a bound', async () => {
    const { repository, client, boundTenants } = harnessFor({});

    const malformed: readonly unknown[] = [
      '',
      'not-a-cursor',
      OCCURRED_AT_ISO,
      `${OCCURRED_AT_ISO}|`,
      `|${EVENT_ID}`,
      `2026-01-01T00:00:00Z|${EVENT_ID}`,
      `2026-01-01T00:00:00.000+07:00|${EVENT_ID}`,
      `${OCCURRED_AT_ISO}|not-a-uuid`,
      `2026-13-01T00:00:00.000Z|${EVENT_ID}`,
      42,
    ];

    for (const cursor of malformed) {
      const refusal = await refusalOf(
        repository.listTimeline(timelineQuery({ cursor: cursor as string })),
      );

      expect(refusal, String(cursor)).toContain('CUSTOMER_EVENT_CURSOR_INVALID');
    }

    expect(boundTenants).toEqual([]);
    expect(client.statements).toEqual([]);
  });

  it('refuses an unusable query before opening a transaction', async () => {
    const { repository, client, boundTenants } = harnessFor({});

    await expect(
      repository.listTimeline(timelineQuery({ customer_id: null as unknown as string })),
    ).rejects.toThrow('CUSTOMER_EVENT_CUSTOMER_ID_REQUIRED');
    await expect(repository.listTimeline(timelineQuery({ customer_id: '' }))).rejects.toThrow(
      'CUSTOMER_EVENT_CUSTOMER_ID_INVALID',
    );
    await expect(repository.listTimeline(timelineQuery({ from: 'yesterday' }))).rejects.toThrow(
      'CUSTOMER_EVENT_RANGE_INVALID',
    );
    await expect(repository.listTimeline(timelineQuery({ to: '31/01/2026' }))).rejects.toThrow(
      'CUSTOMER_EVENT_RANGE_INVALID',
    );

    for (const limit of [0, -1, 201, 2.5]) {
      const refusal = await refusalOf(repository.listTimeline(timelineQuery({ limit })));

      expect(refusal, String(limit)).toContain('CUSTOMER_EVENT_LIMIT_INVALID');
    }

    expect(boundTenants).toEqual([]);
    expect(client.statements).toEqual([]);
  });
});

describe('CustomerEventRepository.findByIdempotencyKey', () => {
  it('publishes the stored receipt of a delivery identity', async () => {
    const { repository, client, boundTenants } = harnessFor({
      read_source: { rows: [receiptRow()] },
    });

    await expect(repository.findByIdempotencyKey(TENANT, SOURCE_EVENT_ID)).resolves.toEqual({
      event_id: EVENT_ID,
      event_name: EVENT_NAME,
      occurred_at: OCCURRED_AT_ISO,
    });

    expect(boundTenants).toEqual([TENANT]);
    expect(client.statements.map((statement) => statement.kind)).toEqual(['read_source']);
    expect(bindingsOf(client, 'read_source')).toEqual([TENANT, SOURCE_EVENT_ID]);
  });

  it('reports nothing when this tenant has not stored that delivery', async () => {
    const { repository, client, boundTenants } = harnessFor({ read_source: { rows: [] } });

    await expect(
      repository.findByIdempotencyKey(OTHER_TENANT, SOURCE_EVENT_ID),
    ).resolves.toBeNull();

    expect(boundTenants).toEqual([OTHER_TENANT]);
    expect(bindingsOf(client, 'read_source')).toEqual([OTHER_TENANT, SOURCE_EVENT_ID]);
  });

  it('refuses a blank identity before opening a transaction', async () => {
    const { repository, client, boundTenants } = harnessFor({});

    await expect(repository.findByIdempotencyKey(TENANT, '   ')).rejects.toThrow(
      'CUSTOMER_EVENT_SOURCE_ID_REQUIRED',
    );
    await expect(repository.findByIdempotencyKey('', SOURCE_EVENT_ID)).rejects.toThrow(
      'CUSTOMER_EVENT_TENANT_ID_REQUIRED',
    );

    expect(boundTenants).toEqual([]);
    expect(client.statements).toEqual([]);
  });
});
