import type { QueryResultRow } from 'pg';

import { withTenantContext } from '../rls.js';
import { canonicalizeJson } from './canonical-json.js';
import { assertIdentifier, serializeJsonb } from './durable-workflows.js';
import type { TenantTransactionRunner } from './effect-reservations.js';

/**
 * One terminal response persisted for a durable run.
 *
 * `message_id` is populated only when `conversation_id` was supplied to `save()`. Both the response
 * and the agent message are committed by one tenant-scoped transaction, so a completed response can
 * never point at a message that was not committed with it.
 */
export interface RunResponseRecord {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly answer: string;
  readonly sources: unknown;
  readonly conversation_id: string | null;
  readonly message_id: string | null;
  readonly created_at: string;
}

/** Input accepted by `RunResponseRepository.save()`. */
export interface SaveRunResponseInput {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly answer: string;
  readonly sources: unknown;
  readonly conversation_id?: string;
  readonly sender_id: string;
}

const RUN_RESPONSES = 'agentos.run_responses';
const CONVERSATIONS = 'agentos.conversations';
const CONVERSATION_MESSAGES = 'agentos.conversation_messages';
const CODE_OWNER = 'run-responses repository / migration 0009';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RESPONSE_PROJECTION = `
    tenant_id,
    run_id,
    answer,
    sources,
    conversation_id,
    message_id,
    created_at`;

/** A durable run lock serializes response/message creation without UPDATE privileges on run_responses. */
const LOCK_RUN = `SELECT run_id
  FROM agentos.platform_durable_tasks
  WHERE tenant_id = $1 AND run_id = $2
  FOR UPDATE`;

const INSERT_RESPONSE = `INSERT INTO ${RUN_RESPONSES} (
    tenant_id,
    run_id,
    answer,
    sources,
    conversation_id,
    message_id
  )
  VALUES ($1, $2, $3, $4::jsonb, $5, $6)
  ON CONFLICT (tenant_id, run_id) DO NOTHING
  RETURNING${RESPONSE_PROJECTION}`;

const SELECT_RESPONSE = `SELECT${RESPONSE_PROJECTION}
  FROM ${RUN_RESPONSES}
  WHERE tenant_id = $1 AND run_id = $2`;

/**
 * The response row remains immutable after insertion. The durable run lock above serializes
 * concurrent writers, and this lock is used only for exact replay reads.
 */
const SELECT_RESPONSE_FOR_UPDATE = `${SELECT_RESPONSE}
  FOR UPDATE`;

const TOUCH_CONVERSATION = `UPDATE ${CONVERSATIONS}
  SET last_message_at = GREATEST(last_message_at, CURRENT_TIMESTAMP)
  WHERE tenant_id = $1 AND id = $2
  RETURNING id`;

const INSERT_AGENT_MESSAGE = `INSERT INTO ${CONVERSATION_MESSAGES} (
    tenant_id,
    conversation_id,
    sender_type,
    sender_id,
    content
  )
  VALUES ($1, $2, 'agent', $3, $4)
  RETURNING id AS message_id`;


interface RunResponseRow extends QueryResultRow {
  tenant_id: string;
  run_id: string;
  answer: string;
  sources: unknown;
  conversation_id: string | null;
  message_id: string | null;
  created_at: Date;
}

interface InsertedMessageRow extends QueryResultRow {
  message_id: string;
}

function toRunResponseRecord(row: RunResponseRow): RunResponseRecord {
  return {
    tenant_id: row.tenant_id,
    run_id: row.run_id,
    answer: row.answer,
    sources: row.sources,
    conversation_id: row.conversation_id,
    message_id: row.message_id,
    created_at: row.created_at.toISOString(),
  };
}

function readOptionalConversationId(value: unknown): string | null {
  if (value === undefined || value === null) return null;

  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new Error(
      `RUN_RESPONSE_CONVERSATION_ID_INVALID: conversation_id must be a UUID of this tenant ` +
        `(${CODE_OWNER}).`,
    );
  }

  return value;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  try {
    return canonicalizeJson(left) === canonicalizeJson(right);
  } catch {
    return false;
  }
}

function assertReplayMatches(
  existing: RunResponseRecord,
  input: SaveRunResponseInput,
): void {
  const expectedConversationId = input.conversation_id ?? null;

  if (
    existing.answer !== input.answer ||
    !sameJsonValue(existing.sources, input.sources) ||
    existing.conversation_id !== expectedConversationId
  ) {
    throw new Error(
      `RUN_RESPONSE_CONFLICT: run ${input.run_id} already has a different answer, sources, or ` +
        `conversation binding; refusing to overwrite the durable response (${CODE_OWNER}).`,
    );
  }
}

/**
 * Persists one terminal run response and, for conversational runs, its one agent message.
 *
 * Every method runs through a tenant transaction. The owning durable run is locked before the
 * response is read or written; a conversational message is inserted first, then the immutable
 * response points at it in the same transaction.
 */
export class RunResponseRepository {
  private readonly runInTenantTransaction: TenantTransactionRunner;

  constructor(runInTenantTransaction: TenantTransactionRunner = withTenantContext) {
    this.runInTenantTransaction = runInTenantTransaction;
  }

  /**
   * Saves one response, returning the existing immutable response on an exact replay.
   *
   * @throws `RUN_RESPONSE_CONFLICT` when answer, sources, or conversation binding differs from the
   * already persisted response for this tenant/run.
   */
  async save(input: SaveRunResponseInput): Promise<RunResponseRecord> {
    assertIdentifier(input.tenant_id, 'tenant_id', 36, 'RUN_RESPONSE_TENANT_ID_REQUIRED');
    assertIdentifier(input.run_id, 'run_id', 64, 'RUN_RESPONSE_RUN_ID_REQUIRED');
    assertIdentifier(input.sender_id, 'sender_id', 128, 'RUN_RESPONSE_SENDER_ID_REQUIRED');

    if (typeof input.answer !== 'string') {
      throw new Error(`RUN_RESPONSE_ANSWER_INVALID: answer must be text (${CODE_OWNER}).`);
    }

    const conversation_id = readOptionalConversationId(input.conversation_id);
    const sources = serializeJsonb(input.sources, 'RUN_RESPONSE_SOURCES_INVALID');

    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const lockedRun = await client.query<{ readonly run_id: string }>(LOCK_RUN, [
        input.tenant_id,
        input.run_id,
      ]);
      if (lockedRun.rowCount !== 1) {
        throw new Error(
          `RUN_RESPONSE_RUN_NOT_FOUND: run ${input.run_id} does not belong to tenant ` +
            `${input.tenant_id} (${CODE_OWNER}).`,
        );
      }

      const existing = await client.query<RunResponseRow>(SELECT_RESPONSE_FOR_UPDATE, [
        input.tenant_id,
        input.run_id,
      ]);
      const existingRow = existing.rows[0];
      if (existingRow !== undefined) {
        const existingRecord = toRunResponseRecord(existingRow);
        assertReplayMatches(existingRecord, input);
        if (existingRecord.message_id === null && conversation_id !== null) {
          throw new Error(
            `RUN_RESPONSE_INCOMPLETE: response ${input.run_id} has no linked agent message; ` +
              `refusing to mutate the append-only response (${CODE_OWNER}).`,
          );
        }
        return existingRecord;
      }

      let message_id: string | null = null;
      if (conversation_id !== null) {
        const advanced = await client.query(TOUCH_CONVERSATION, [input.tenant_id, conversation_id]);
        if (advanced.rowCount !== 1) {
          throw new Error(
            `RUN_RESPONSE_CONVERSATION_NOT_FOUND: this tenant holds no conversation ` +
              `${conversation_id}; refusing to store an agent message without its conversation ` +
              `(${CODE_OWNER}).`,
          );
        }

        const message = await client.query<InsertedMessageRow>(INSERT_AGENT_MESSAGE, [
          input.tenant_id,
          conversation_id,
          input.sender_id,
          input.answer,
        ]);
        const messageRow = message.rows[0];
        if (messageRow === undefined) {
          throw new Error(
            `RUN_RESPONSE_MESSAGE_MISSING: the agent message insert returned no id ` +
              `(${CODE_OWNER}).`,
          );
        }
        message_id = messageRow.message_id;
      }

      const inserted = await client.query<RunResponseRow>(INSERT_RESPONSE, [
        input.tenant_id,
        input.run_id,
        input.answer,
        sources,
        conversation_id,
        message_id,
      ]);
      const row = inserted.rows[0];
      if (row === undefined) {
        throw new Error(
          `RUN_RESPONSE_UNSTABLE: response ${input.run_id} was taken outside the durable run lock ` +
            `(${CODE_OWNER}).`,
        );
      }
      return toRunResponseRecord(row);
    });
  }

  /** Reads one tenant/run response, or `null` when this tenant has no such response. */
  async read(tenant_id: string, run_id: string): Promise<RunResponseRecord | null> {
    assertIdentifier(tenant_id, 'tenant_id', 36, 'RUN_RESPONSE_TENANT_ID_REQUIRED');
    assertIdentifier(run_id, 'run_id', 64, 'RUN_RESPONSE_RUN_ID_REQUIRED');

    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query<RunResponseRow>(SELECT_RESPONSE, [tenant_id, run_id]);
      const row = result.rows[0];
      return row === undefined ? null : toRunResponseRecord(row);
    });
  }
}
