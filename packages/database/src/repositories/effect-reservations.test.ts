import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';

import type {
  EffectReservationRecord,
  EffectReservationRequest,
  EffectReservationSettlement,
  EffectReservationStatus,
} from '../contracts/index.js';
import { EffectReservationRepository } from './effect-reservations.js';

/**
 * Unit suite for durable effect reservations (NFR-003, BR-005, BR-006, implement/04 §3.2.3).
 *
 * The repository is exercised against a scripted `pg` client instead of PostgreSQL: every
 * statement it issues is classified, recorded, and answered from a per-transition script. That
 * keeps the arbitration, the settlement and the reconciliation rules as the SQL-observable
 * behavior the durable authority actually produces, without re-implementing those rules inside the
 * test and without a database.
 *
 * What is asserted is what a caller observes: the decision returned for a key, the parameters that
 * reach the row (tenant, canonical fingerprint, receipt JSON, fresh window), how many round trips
 * an arbitration took, and which refusals happen before a transaction is opened at all. The live
 * half — RLS denial, cross-tenant foreign keys, the exact predicate of the reservation window —
 * belongs to `src/rls.test.ts` and is not duplicated here.
 */

/** Tenant bound to every statement; the repository is tenant-scoped by construction. */
const TENANT = '11111111-1111-1111-1111-111111111111';
const EFFECT_KEY = 'EK-REQ-1-SKILL-ECHO-STEP-3';
const RUN_ID = 'RUN-1';
const REQUEST_ID = 'REQ-1';
const SKILL_ID = 'skill.echo';
const STEP_INDEX = 3;

/** Two distinct payload fingerprints in the only accepted encoding: bare lowercase hex SHA-256. */
const FINGERPRINT = 'deadbeef'.repeat(8);
const OTHER_FINGERPRINT = 'f00dbabe'.repeat(8);

const RESERVED_AT = new Date('2026-01-01T00:00:00.000Z');
const RESOLVED_AT = new Date('2026-01-01T00:05:00.000Z');
const EXPIRES_AT = new Date('2026-01-04T00:00:00.000Z');

/** One reservation row exactly as `pg` returns it, before the projection is published. */
interface ReservationRow extends QueryResultRow {
  tenant_id: string;
  effect_key: string;
  request_id: string;
  request_fingerprint: string;
  run_id: string;
  step_index: number;
  skill_id: string;
  status: EffectReservationStatus;
  response_receipt: unknown;
  reserved_at: Date;
  resolved_at: Date | null;
  expires_at: Date;
  expired: boolean;
}

/**
 * Which statement of the repository a SQL text is. The script answers per kind, so a test states
 * one transition at a time instead of matching whole statements; an unrecognized statement fails
 * the test rather than being answered with an empty result.
 */
type StatementKind = 'insert' | 'lock' | 'read' | 'open_by_run' | 'settle' | 'reopen' | 'expire';

function classify(sql: string): StatementKind {
  if (sql.startsWith('INSERT INTO agentos.effect_reservations')) {
    return 'insert';
  }

  if (sql.includes('FOR UPDATE')) {
    return 'lock';
  }

  if (sql.includes('run_id = $2')) {
    return 'open_by_run';
  }

  if (sql.includes('response_receipt = $4::jsonb')) {
    return 'settle';
  }

  if (sql.includes("SET status = 'EXPIRED'")) {
    return 'expire';
  }

  if (sql.includes("SET status = 'RESERVED'")) {
    return 'reopen';
  }

  if (sql.includes('effect_key = $2')) {
    return 'read';
  }

  throw new Error(`SCRIPTED_STATEMENT_UNKNOWN: no test scripts the statement "${sql}".`);
}

/** The `pg` result of one statement, as a test scripts it. */
interface ScriptedAnswer {
  /** Rows a `SELECT` / `INSERT ... RETURNING` returns; omitted means an empty result. */
  readonly rows?: readonly ReservationRow[];
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
  readonly repository: EffectReservationRepository;
  readonly client: ScriptedClient;
  /** Tenants passed to the injected binder, in call order. */
  readonly boundTenants: string[];
}

function harnessFor(answers: ScriptedAnswers): RepositoryHarness {
  const client = new ScriptedClient(answers);
  const boundTenants: string[] = [];

  const repository = new EffectReservationRepository(async (tenant_id, work) => {
    boundTenants.push(tenant_id);

    return work(client as unknown as PoolClient);
  });

  return { repository, client, boundTenants };
}

/** One row carrying the canonical defaults of a live reservation; a case overrides what it is about. */
function reservationRow(overrides: Partial<ReservationRow> = {}): ReservationRow {
  const row: ReservationRow = {
    tenant_id: TENANT,
    effect_key: EFFECT_KEY,
    request_id: REQUEST_ID,
    request_fingerprint: FINGERPRINT,
    run_id: RUN_ID,
    step_index: STEP_INDEX,
    skill_id: SKILL_ID,
    status: 'RESERVED',
    response_receipt: null,
    reserved_at: RESERVED_AT,
    resolved_at: null,
    expires_at: EXPIRES_AT,
    expired: false,
  };

  return Object.assign(row, overrides);
}

function reservationRequest(
  overrides: Partial<EffectReservationRequest> = {},
): EffectReservationRequest {
  const input: EffectReservationRequest = {
    tenant_id: TENANT,
    effect_key: EFFECT_KEY,
    run_id: RUN_ID,
    request_id: REQUEST_ID,
    request_fingerprint: FINGERPRINT,
    skill_id: SKILL_ID,
    step_index: STEP_INDEX,
  };

  return Object.assign(input, overrides);
}

function settlement(
  overrides: Partial<EffectReservationSettlement> = {},
): EffectReservationSettlement {
  const input: EffectReservationSettlement = {
    tenant_id: TENANT,
    effect_key: EFFECT_KEY,
    status: 'SUCCEEDED',
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

describe('EffectReservationRepository.reserve', () => {
  it('claims a new key in one insert that binds the canonical request', async () => {
    const { repository, client, boundTenants } = harnessFor({ insert: { rows: [reservationRow()] } });

    await expect(repository.reserve(reservationRequest())).resolves.toEqual({ kind: 'RESERVED' });

    expect(boundTenants).toEqual([TENANT]);
    expect(client.statements.map((statement) => statement.kind)).toEqual(['insert']);
    expect(bindingsOf(client, 'insert')).toEqual([
      TENANT,
      EFFECT_KEY,
      REQUEST_ID,
      FINGERPRINT,
      RUN_ID,
      STEP_INDEX,
      SKILL_ID,
    ]);
  });

  it('reports IN_FLIGHT while the holder of the key is unproven and its window is open', async () => {
    const { repository, client } = harnessFor({
      insert: { rows: [] },
      lock: { rows: [reservationRow({ status: 'RESERVED', expired: false })] },
    });

    await expect(repository.reserve(reservationRequest())).resolves.toEqual({ kind: 'IN_FLIGHT' });

    // The lost race is decided by locking the existing row, never by overwriting it.
    expect(client.statements.map((statement) => statement.kind)).toEqual(['insert', 'lock']);
    expect(bindingsOf(client, 'lock')).toEqual([TENANT, EFFECT_KEY]);
  });

  it('reports RECONCILE_REQUIRED for a lapsed window instead of re-dispatching the key', async () => {
    const { repository, client } = harnessFor({
      insert: { rows: [] },
      lock: { rows: [reservationRow({ status: 'RESERVED', expired: true })] },
    });

    await expect(repository.reserve(reservationRequest())).resolves.toEqual({
      kind: 'RECONCILE_REQUIRED',
    });

    expect(client.statements.map((statement) => statement.kind)).toEqual(['insert', 'lock']);
  });

  it('reconciles FAILED and EXPIRED rows by key', async () => {
    for (const status of ['FAILED', 'EXPIRED'] as const) {
      const { repository } = harnessFor({
        insert: { rows: [] },
        lock: { rows: [reservationRow({ status, resolved_at: RESOLVED_AT, expired: true })] },
      });

      await expect(repository.reserve(reservationRequest()), status).resolves.toEqual({
        kind: 'RECONCILE_REQUIRED',
      });
    }
  });

  it('replays the stored receipt of a settled success and performs no call', async () => {
    const receipt = { provider_ref: 'abc-123', applied: true };
    const { repository, client } = harnessFor({
      insert: { rows: [] },
      lock: { rows: [reservationRow({ status: 'SUCCEEDED', response_receipt: receipt })] },
    });

    await expect(repository.reserve(reservationRequest())).resolves.toEqual({
      kind: 'REPLAY',
      receipt,
    });

    expect(client.statements.map((statement) => statement.kind)).toEqual(['insert', 'lock']);
  });

  it('replays a settled success that stored no receipt as null', async () => {
    const { repository } = harnessFor({
      insert: { rows: [] },
      lock: { rows: [reservationRow({ status: 'SUCCEEDED', response_receipt: null })] },
    });

    await expect(repository.reserve(reservationRequest())).resolves.toEqual({
      kind: 'REPLAY',
      receipt: null,
    });
  });

  it('reports CONFLICT when the same key carries a different payload', async () => {
    const { repository, client } = harnessFor({
      insert: { rows: [] },
      lock: {
        rows: [
          reservationRow({
            request_fingerprint: OTHER_FINGERPRINT,
            status: 'SUCCEEDED',
            response_receipt: { provider_ref: 'the-other-payload' },
          }),
        ],
      },
    });

    await expect(repository.reserve(reservationRequest())).resolves.toEqual({ kind: 'CONFLICT' });

    // A mismatched payload is never merged, overwritten, or served the other request's receipt.
    expect(client.statements.map((statement) => statement.kind)).toEqual(['insert', 'lock']);
  });

  it('compares the canonical fingerprint, not its spelling', async () => {
    const { repository, client } = harnessFor({
      insert: { rows: [] },
      lock: { rows: [reservationRow({ status: 'RESERVED', expired: false })] },
    });

    await expect(
      repository.reserve(
        reservationRequest({ request_fingerprint: `  ${FINGERPRINT.toUpperCase()}\n` }),
      ),
    ).resolves.toEqual({ kind: 'IN_FLIGHT' });

    expect(bindingsOf(client, 'insert')[3]).toBe(FINGERPRINT);
  });

  it('refuses a persisted status the decision table cannot classify', async () => {
    const { repository, client } = harnessFor({
      insert: { rows: [] },
      lock: { rows: [reservationRow({ status: 'PARTIAL' as EffectReservationStatus })] },
    });

    const refusal = await refusalOf(repository.reserve(reservationRequest()));

    expect(refusal).toContain('EFFECT_RESERVATION_STATUS_UNKNOWN');
    expect(client.statements.map((statement) => statement.kind)).toEqual(['insert', 'lock']);
  });

  it('fails closed when the insert reports the key taken but no row is visible', async () => {
    const { repository } = harnessFor({ insert: { rows: [] }, lock: { rows: [] } });

    await expect(repository.reserve(reservationRequest())).rejects.toThrow(
      'EFFECT_RESERVATION_UNSTABLE',
    );
  });

  it('maps a duplicate inbound request identity to EFFECT_RESERVATION_IDENTITY_IN_USE', async () => {
    const constraint = 'uq_effect_reservation_request';
    const { repository } = harnessFor({
      insert: {
        fails: Object.assign(
          new Error(`duplicate key value violates unique constraint "${constraint}"`),
          { code: '23505', constraint },
        ),
      },
    });

    const refusal = await refusalOf(repository.reserve(reservationRequest()));

    expect(refusal).toContain('EFFECT_RESERVATION_IDENTITY_IN_USE');
    expect(refusal).toContain(constraint);
  });

  it('propagates an unrelated database failure untouched', async () => {
    const timeout = Object.assign(new Error('canceling statement due to statement timeout'), {
      code: '57014',
    });
    const { repository } = harnessFor({ insert: { fails: timeout } });

    await expect(repository.reserve(reservationRequest())).rejects.toBe(timeout);
  });

  it('refuses an unusable key or fingerprint before opening a transaction', async () => {
    const { repository, client, boundTenants } = harnessFor({});

    for (const effect_key of ['', '   ', 42]) {
      await expect(
        repository.reserve(reservationRequest({ effect_key: effect_key as string })),
      ).rejects.toThrow('EFFECT_RESERVATION_KEY_REQUIRED');
    }

    for (const request_fingerprint of [
      FINGERPRINT.slice(0, 63),
      `sha256:${FINGERPRINT}`,
      'z'.repeat(64),
      7,
    ]) {
      await expect(
        repository.reserve(
          reservationRequest({ request_fingerprint: request_fingerprint as string }),
        ),
      ).rejects.toThrow('EFFECT_RESERVATION_FINGERPRINT_INVALID');
    }

    expect(boundTenants).toEqual([]);
    expect(client.statements).toEqual([]);
  });

  it('binds the caller-owned window when one is supplied and the column default otherwise', async () => {
    const window = '2026-01-01T12:00:00.000Z';
    const owned = harnessFor({
      insert: { rows: [reservationRow({ expires_at: new Date(window) })] },
    });
    const defaulted = harnessFor({ insert: { rows: [reservationRow()] } });

    await owned.repository.reserve(reservationRequest({ expires_at: window }));
    await defaulted.repository.reserve(reservationRequest());

    expect(bindingsOf(owned.client, 'insert')).toHaveLength(8);
    expect(bindingsOf(owned.client, 'insert')[7]).toBe(window);
    expect(bindingsOf(defaulted.client, 'insert')).toHaveLength(7);
  });
});

describe('EffectReservationRepository.resolve', () => {
  it('settles a reserved row with the proven receipt', async () => {
    const { repository, client, boundTenants } = harnessFor({
      lock: { rows: [reservationRow({ status: 'RESERVED' })] },
      settle: { rowCount: 1 },
    });

    await expect(
      repository.resolve(settlement({ receipt: { provider_ref: 'abc-123' } })),
    ).resolves.toBeUndefined();

    expect(boundTenants).toEqual([TENANT]);
    expect(client.statements.map((statement) => statement.kind)).toEqual(['lock', 'settle']);
    expect(bindingsOf(client, 'settle')).toEqual([
      TENANT,
      EFFECT_KEY,
      'SUCCEEDED',
      '{"provider_ref":"abc-123"}',
    ]);
  });

  it('stores SQL NULL when the settlement proves no payload', async () => {
    const { repository, client } = harnessFor({
      lock: { rows: [reservationRow({ status: 'RESERVED' })] },
      settle: { rowCount: 1 },
    });

    await repository.resolve(settlement({ status: 'FAILED' }));

    expect(bindingsOf(client, 'settle')[3]).toBeNull();
  });

  it('refuses to settle a key that was never reserved', async () => {
    const { repository, client } = harnessFor({ lock: { rows: [] } });

    await expect(repository.resolve(settlement({ status: 'FAILED' }))).rejects.toThrow(
      'EFFECT_RESERVATION_NOT_FOUND',
    );

    // A settlement never creates the row it settles: that would claim an effect never reserved.
    expect(client.statements.map((statement) => statement.kind)).toEqual(['lock']);
  });

  it('treats a repeated settlement as a no-op', async () => {
    const { repository, client } = harnessFor({
      lock: {
        rows: [
          reservationRow({ status: 'SUCCEEDED', response_receipt: { provider_ref: 'abc-123' } }),
        ],
      },
      settle: { rowCount: 1 },
    });

    await expect(
      repository.resolve(settlement({ receipt: { provider_ref: 'rewritten' } })),
    ).resolves.toBeUndefined();

    // A retried worker cannot rewrite a stored receipt.
    expect(client.statements.map((statement) => statement.kind)).toEqual(['lock']);
  });

  it('never downgrades or overwrites a confirmed success', async () => {
    const { repository, client } = harnessFor({
      lock: {
        rows: [
          reservationRow({ status: 'SUCCEEDED', response_receipt: { provider_ref: 'abc-123' } }),
        ],
      },
      settle: { rowCount: 1 },
    });

    await expect(repository.resolve(settlement({ status: 'FAILED' }))).rejects.toThrow(
      'EFFECT_RESERVATION_TERMINAL',
    );

    expect(client.statements.map((statement) => statement.kind)).toEqual(['lock']);
  });

  it('settles a FAILED or escalated EXPIRED row once a later check proves the outcome', async () => {
    for (const status of ['FAILED', 'EXPIRED'] as const) {
      const { repository, client } = harnessFor({
        lock: { rows: [reservationRow({ status, resolved_at: RESOLVED_AT, expired: true })] },
        settle: { rowCount: 1 },
      });

      await expect(
        repository.resolve(settlement({ status: 'SUCCEEDED', receipt: { proved: true } })),
        status,
      ).resolves.toBeUndefined();

      expect(client.statements.map((statement) => statement.kind), status).toEqual([
        'lock',
        'settle',
      ]);
    }
  });

  it('reports NOT_FOUND when the locked row vanished before the update', async () => {
    const { repository } = harnessFor({
      lock: { rows: [reservationRow({ status: 'RESERVED' })] },
      settle: { rowCount: 0 },
    });

    await expect(repository.resolve(settlement({ status: 'FAILED' }))).rejects.toThrow(
      'EFFECT_RESERVATION_NOT_FOUND',
    );
  });

  it('refuses a receipt it cannot store durably instead of dropping it', async () => {
    const { repository, client } = harnessFor({
      lock: { rows: [reservationRow({ status: 'RESERVED' })] },
      settle: { rowCount: 1 },
    });

    await expect(repository.resolve(settlement({ receipt: { provider_ref: 1n } }))).rejects.toThrow(
      'EFFECT_RESERVATION_RECEIPT_UNSERIALIZABLE',
    );

    expect(client.statements.map((statement) => statement.kind)).toEqual(['lock']);
  });
});

describe('EffectReservationRepository primitives', () => {
  it('settles only a live RESERVED row in place', async () => {
    const { repository, client } = harnessFor({
      lock: { rows: [reservationRow({ status: 'RESERVED' })] },
      settle: { rowCount: 1 },
    });

    await expect(repository.settleReservation(settlement({ status: 'FAILED' }))).resolves.toBe(true);

    expect(client.statements.map((statement) => statement.kind)).toEqual(['lock', 'settle']);
    expect(bindingsOf(client, 'settle')).toEqual([TENANT, EFFECT_KEY, 'FAILED', null]);
  });

  it('reports false and writes nothing for every row it may not settle in place', async () => {
    const cases: readonly {
      readonly scenario: string;
      readonly held: ReservationRow | null;
      readonly status: EffectReservationSettlement['status'];
    }[] = [
      { scenario: 'no such row', held: null, status: 'SUCCEEDED' },
      {
        scenario: 'a FAILED row awaiting reconciliation',
        held: reservationRow({ status: 'FAILED', resolved_at: RESOLVED_AT, expired: true }),
        status: 'SUCCEEDED',
      },
      {
        scenario: 'an escalated EXPIRED row',
        held: reservationRow({ status: 'EXPIRED', resolved_at: RESOLVED_AT, expired: true }),
        status: 'FAILED',
      },
      {
        scenario: 'an already settled SUCCEEDED row',
        held: reservationRow({ status: 'SUCCEEDED', resolved_at: RESOLVED_AT }),
        status: 'FAILED',
      },
    ];

    for (const { scenario, held, status } of cases) {
      const { repository, client } = harnessFor({
        lock: { rows: held === null ? [] : [held] },
        settle: { rowCount: 1 },
      });

      await expect(repository.settleReservation(settlement({ status })), scenario).resolves.toBe(
        false,
      );
      expect(client.statements.map((statement) => statement.kind), scenario).toEqual(['lock']);
    }
  });

  it('insertReservation publishes the inserted row and reports a taken key', async () => {
    const inserted = harnessFor({ insert: { rows: [reservationRow()] } });
    const taken = harnessFor({ insert: { rows: [] } });

    const record: EffectReservationRecord | null =
      await inserted.repository.insertReservation(reservationRequest());

    expect(record).toEqual({
      tenant_id: TENANT,
      effect_key: EFFECT_KEY,
      request_id: REQUEST_ID,
      request_fingerprint: FINGERPRINT,
      run_id: RUN_ID,
      step_index: STEP_INDEX,
      skill_id: SKILL_ID,
      status: 'RESERVED',
      response_receipt: null,
      reserved_at: '2026-01-01T00:00:00.000Z',
      resolved_at: null,
      expires_at: '2026-01-04T00:00:00.000Z',
      expired: false,
    });

    await expect(taken.repository.insertReservation(reservationRequest())).resolves.toBeNull();
  });

  it('reopenReservation re-arms a provider-confirmed absence with a fresh window', async () => {
    const window = '2026-01-04T00:35:00.000Z';
    const { repository, client } = harnessFor({ reopen: { rowCount: 1 } });

    await expect(
      repository.reopenReservation({
        tenant_id: TENANT,
        effect_key: EFFECT_KEY,
        expires_at: window,
      }),
    ).resolves.toBe(true);

    expect(client.statements.map((statement) => statement.kind)).toEqual(['reopen']);
    expect(bindingsOf(client, 'reopen')).toEqual([TENANT, EFFECT_KEY, window]);
  });

  it('reopenReservation refuses a row that is not a FAILED reservation', async () => {
    const { repository } = harnessFor({ reopen: { rowCount: 0 } });

    await expect(
      repository.reopenReservation({
        tenant_id: TENANT,
        effect_key: EFFECT_KEY,
        expires_at: '2026-01-04T00:35:00.000Z',
      }),
    ).resolves.toBe(false);
  });

  it('expireReservation escalates a live reservation and reports one it could not escalate', async () => {
    const escalated = harnessFor({ expire: { rowCount: 1 } });
    const missed = harnessFor({ expire: { rowCount: 0 } });

    await expect(
      escalated.repository.expireReservation({ tenant_id: TENANT, effect_key: EFFECT_KEY }),
    ).resolves.toBe(true);
    expect(bindingsOf(escalated.client, 'expire')).toEqual([TENANT, EFFECT_KEY]);

    await expect(
      missed.repository.expireReservation({ tenant_id: TENANT, effect_key: EFFECT_KEY }),
    ).resolves.toBe(false);
  });
});

describe('EffectReservationRepository lookups', () => {
  it('getReservation publishes the stored row with ISO-8601 timestamps', async () => {
    const { repository, client, boundTenants } = harnessFor({
      read: {
        rows: [
          reservationRow({
            status: 'SUCCEEDED',
            response_receipt: { provider_ref: 'abc-123' },
            resolved_at: RESOLVED_AT,
          }),
        ],
      },
    });

    const record = await repository.getReservation(TENANT, EFFECT_KEY);

    expect(boundTenants).toEqual([TENANT]);
    expect(client.statements.map((statement) => statement.kind)).toEqual(['read']);
    expect(bindingsOf(client, 'read')).toEqual([TENANT, EFFECT_KEY]);
    expect(record).toEqual({
      tenant_id: TENANT,
      effect_key: EFFECT_KEY,
      request_id: REQUEST_ID,
      request_fingerprint: FINGERPRINT,
      run_id: RUN_ID,
      step_index: STEP_INDEX,
      skill_id: SKILL_ID,
      status: 'SUCCEEDED',
      response_receipt: { provider_ref: 'abc-123' },
      reserved_at: '2026-01-01T00:00:00.000Z',
      resolved_at: '2026-01-01T00:05:00.000Z',
      expires_at: '2026-01-04T00:00:00.000Z',
      expired: false,
    });
  });

  it('getReservation reports null when this tenant holds no reservation for the key', async () => {
    const { repository } = harnessFor({ read: { rows: [] } });

    await expect(repository.getReservation(TENANT, EFFECT_KEY)).resolves.toBeNull();
  });

  it('listOpenByRun publishes the open reservations of one run in step order', async () => {
    const { repository, client } = harnessFor({
      open_by_run: {
        rows: [
          reservationRow({ effect_key: 'EK-STEP-1', step_index: 1, expired: true }),
          reservationRow({ effect_key: 'EK-STEP-2', step_index: 2 }),
        ],
      },
    });

    const records = await repository.listOpenByRun({ tenant_id: TENANT, run_id: RUN_ID });

    expect(bindingsOf(client, 'open_by_run')).toEqual([TENANT, RUN_ID]);
    expect(records.map((record) => [record.effect_key, record.step_index, record.expired])).toEqual([
      ['EK-STEP-1', 1, true],
      ['EK-STEP-2', 2, false],
    ]);
    expect(records[0]?.status).toBe('RESERVED');

    const quiet = harnessFor({ open_by_run: { rows: [] } });

    await expect(
      quiet.repository.listOpenByRun({ tenant_id: TENANT, run_id: RUN_ID }),
    ).resolves.toEqual([]);
  });
});

describe('EffectReservationRepository recovery', () => {
  it('reopens a provider-confirmed absence for exactly one more attempt on the same key', async () => {
    const fresh_window = '2026-01-04T00:35:00.000Z';
    let held = reservationRow({ status: 'FAILED', resolved_at: RESOLVED_AT, expired: true });

    const { repository, client } = harnessFor({
      insert: { rows: [] },
      lock: () => ({ rows: [held] }),
      reopen: () => {
        held = reservationRow({ status: 'RESERVED', expires_at: new Date(fresh_window) });

        return { rowCount: 1 };
      },
    });

    // The failed attempt authorizes nothing on its own: the key still reconciles by provider check.
    await expect(repository.reserve(reservationRequest())).resolves.toEqual({
      kind: 'RECONCILE_REQUIRED',
    });

    await expect(
      repository.reopenReservation({
        tenant_id: TENANT,
        effect_key: EFFECT_KEY,
        expires_at: fresh_window,
      }),
    ).resolves.toBe(true);

    // The one permitted retry re-enters the SAME key, finds it held, and cannot become a second
    // effect: a reopened reservation reports IN_FLIGHT, never RESERVED.
    await expect(repository.reserve(reservationRequest())).resolves.toEqual({ kind: 'IN_FLIGHT' });

    expect(client.statements.map((statement) => statement.kind)).toEqual([
      'insert',
      'lock',
      'reopen',
      'insert',
      'lock',
    ]);
  });
});
