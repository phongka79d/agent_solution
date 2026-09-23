import type { QueryResultRow } from 'pg';

import { withTenantContext } from '../rls.js';
import { assertIdentifier } from './durable-workflows.js';
import type { TenantTransactionRunner } from './effect-reservations.js';
import { buildInsertQuery, requireRow } from './sql.js';

/**
 * Omnichannel conversation sessions on PostgreSQL (`agentos.conversations` and
 * `agentos.conversation_messages`, implement/03 §1 DOMAIN 3 Entity 11-11.1).
 *
 * The conversation is the root of one channel thread: `POST /api/v1/conversations` binds the
 * `(tenant, channel, external_thread_id)` triple to exactly one durable row
 * (`uq_conversations_tenant_thread`, implement/06 §8.1 R01), every turn is appended to
 * `conversation_messages` in the same transaction that advances the conversation's
 * `last_message_at` (R02), and the conversation-control routes move `state` between the three
 * stored values (R06/R08).
 *
 * Three rules shape every method below:
 *
 *  * **Tenant-scoped by construction.** Each call opens exactly one `withTenantContext()`
 *    transaction, so the transaction-local `app.current_tenant_id` binding and the `tenant_id`
 *    predicate always agree and RLS (NFR-006) denies an unbound read or write. `tenant_id` is
 *    always the caller's authenticated tenant — never a value merged out of a request body.
 *  * **Stored vocabulary only.** `state` is `open` / `paused_takeover` / `closed`. The wire
 *    vocabulary `ACTIVE` / `HUMAN_TAKEOVER` / `CLOSED` is a projection of those three and is
 *    refused here, so a wire value can neither be stored verbatim nor be read back as one
 *    (implement/06 §8.3 C-3).
 *  * **Bind, never duplicate.** `bindOrCreate()` never inserts a second conversation for a thread
 *    that is already bound and never writes the existing row: a bound `customer_id` is not
 *    overwritten with `null`, and a bind never moves the `state` of the conversation it binds (R01).
 */

/** `agentos` is not on the connection `search_path`, so every statement is schema-qualified. */
const CONVERSATIONS = 'agentos.conversations';
const CONVERSATION_MESSAGES = 'agentos.conversation_messages';

/** The owning document of every refusal this module raises. */
const CODE_OWNER = 'implement/03 §1 DOMAIN 3 Entity 11-11.1, implement/06 §8.1 R01-R02';

/** The stored conversation lifecycle (`conversations.state`, implement/03 §1 Entity 11). */
export type ConversationState = 'open' | 'paused_takeover' | 'closed';

/** Every value `conversations.state` accepts, in declaration order. */
const CONVERSATION_STATES: readonly ConversationState[] = ['open', 'paused_takeover', 'closed'];

/** The senders `conversation_messages.sender_type` accepts (the column's CHECK constraint). */
export type MessageSenderType = 'customer' | 'agent' | 'operator' | 'system';

/** Every value `conversation_messages.sender_type` accepts, in declaration order. */
const MESSAGE_SENDER_TYPES: readonly MessageSenderType[] = [
  'customer',
  'agent',
  'operator',
  'system',
];

/** Default page size of `listMessages()`, and the largest page it accepts. */
const DEFAULT_MESSAGE_LIMIT = 50;
const MAX_MESSAGE_LIMIT = 200;

/**
 * A canonical UUID: the type of `conversations.id`, `conversations.customer_id` and
 * `conversation_messages.id` / `.conversation_id`.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One conversation row published by every read of this module. Both `TIMESTAMPTZ` columns are
 * ISO-8601 UTC strings, so the row survives serialization into an API projection unchanged.
 */
export interface ConversationRecord {
  readonly conversation_id: string;
  readonly tenant_id: string;
  readonly customer_id: string | null;
  readonly channel: string;
  readonly external_thread_id: string;
  readonly active_agent: string;
  readonly state: ConversationState;
  readonly takeover_operator_id: string | null;
  readonly last_message_at: string;
  readonly created_at: string;
}

/**
 * Outcome of `bindOrCreate()`: the conversation of the thread binding, plus whether this call bound
 * an existing one (`true`) or created it (`false`). The flag is the only difference between the two
 * paths, so a route can answer R01 with `201` / `200` from the same row it publishes either way.
 */
export interface BoundConversationRecord extends ConversationRecord {
  readonly bound: boolean;
}

/** Input of `bindOrCreate()`; `active_agent` defaults to the durable column default (`'auto'`). */
export interface BindOrCreateConversationInput {
  readonly tenant_id: string;
  readonly channel: string;
  readonly external_thread_id: string;
  readonly customer_id: string | null;
  readonly active_agent?: string;
}

/** One `agentos.conversation_messages` row, published with its instant as an ISO-8601 UTC string. */
export interface ConversationMessageRecord {
  readonly message_id: string;
  readonly sender_type: MessageSenderType;
  readonly sender_id: string;
  readonly content: string;
  readonly created_at: string;
}

/** Input of `appendMessage()`; `content_type` and `metadata` default to their DDL columns. */
export interface AppendConversationMessageInput {
  readonly tenant_id: string;
  readonly conversation_id: string;
  readonly sender_type: MessageSenderType;
  readonly sender_id: string;
  readonly content: string;
  readonly content_type?: string;
  readonly metadata?: Record<string, unknown>;
}

/** Input of `listMessages()`; the page defaults to 50 rows and never exceeds 200. */
export interface ConversationMessageScope {
  readonly tenant_id: string;
  readonly conversation_id: string;
  readonly limit?: number;
}

/**
 * The columns every conversation read publishes, in the order `toConversationRecord` expects them.
 *
 * `id` is published as `conversation_id` because that is the identity every caller addresses (R02,
 * R06, R08), and the same projection is shared by the insert, the thread bind read and the point
 * read so the three can never drift.
 */
const CONVERSATION_PROJECTION = `
    id AS conversation_id,
    tenant_id,
    customer_id,
    channel,
    external_thread_id,
    active_agent,
    state,
    takeover_operator_id,
    last_message_at,
    created_at`;

/**
 * The bind-or-create of R01. The unique key `(tenant_id, channel, external_thread_id)` decides the
 * winner, and `ON CONFLICT ... DO NOTHING` makes the repeated call a read-only bind: the existing
 * row keeps its `state`, its `customer_id` and its identity, and no second conversation is created.
 *
 * `active_agent` is omitted so the durable column default (`'auto'`) stays the single source of that
 * default; the variant below carries it when the caller supplies one.
 */
const INSERT_CONVERSATION = `INSERT INTO ${CONVERSATIONS} (
    tenant_id,
    channel,
    external_thread_id,
    customer_id
  )
  VALUES ($1, $2, $3, $4)
  ON CONFLICT (tenant_id, channel, external_thread_id) DO NOTHING
  RETURNING${CONVERSATION_PROJECTION}`;

const INSERT_CONVERSATION_WITH_AGENT = `INSERT INTO ${CONVERSATIONS} (
    tenant_id,
    channel,
    external_thread_id,
    customer_id,
    active_agent
  )
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (tenant_id, channel, external_thread_id) DO NOTHING
  RETURNING${CONVERSATION_PROJECTION}`;

/**
 * The existing conversation of one thread binding. Read without a lock: the conflict path of
 * `bindOrCreate()` only publishes the row, so nothing it reads is decided on or written back.
 */
const SELECT_CONVERSATION_BY_THREAD = `SELECT${CONVERSATION_PROJECTION}
  FROM ${CONVERSATIONS}
  WHERE tenant_id = $1 AND channel = $2 AND external_thread_id = $3`;

/** The point read of one conversation inside the caller's tenant scope. */
const SELECT_CONVERSATION = `SELECT${CONVERSATION_PROJECTION}
  FROM ${CONVERSATIONS}
  WHERE tenant_id = $1 AND id = $2`;

/**
 * The conversation-control transition (R06/R08): exactly one row of this tenant is moved, and a
 * wrong tenant or an unknown id matches nothing — `setState()` reports that as `false` and never
 * inserts the row it was asked to move.
 *
 * `takeover_operator_id` is written with the state because the two are one decision: a takeover
 * records the operator that holds the conversation, and a resume clears it.
 */
const UPDATE_CONVERSATION_STATE = `UPDATE ${CONVERSATIONS}
  SET state = $3,
      takeover_operator_id = $4
  WHERE tenant_id = $1 AND id = $2
  RETURNING id`;

/**
 * The turn's half of R02: the conversation of the appended message advances `last_message_at` in the
 * same transaction. `GREATEST` keeps the column monotonic — two concurrent transactions can commit
 * in the opposite order of their start instants, and the later commit must not move the
 * conversation's recency backwards.
 */
const TOUCH_CONVERSATION_LAST_MESSAGE = `UPDATE ${CONVERSATIONS}
  SET last_message_at = GREATEST(last_message_at, CURRENT_TIMESTAMP)
  WHERE tenant_id = $1 AND id = $2
  RETURNING id`;

/**
 * The turn's messages, ordered by the index the table carries (`idx_conversation_messages_turn`) and
 * tie-broken by the time-ordered `id`, so a page is deterministic when two turns share an instant.
 */
const SELECT_MESSAGES = `SELECT
    id AS message_id,
    sender_type,
    sender_id,
    content,
    created_at
  FROM ${CONVERSATION_MESSAGES}
  WHERE tenant_id = $1 AND conversation_id = $2
  ORDER BY created_at ASC, id ASC
  LIMIT $3`;

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
interface ConversationMessagePageRow extends QueryResultRow {
  message_id: string;
  sender_type: MessageSenderType;
  sender_id: string;
  content: string;
  created_at: Date;
}

/**
 * The identity of an appended message. The insert is built by `buildInsertQuery`, so it returns the
 * whole row; the message's own identity is the only column this module reads back.
 */
interface InsertedMessageRow extends QueryResultRow {
  id: string;
}

/**
 * Publishes one conversation row with both timestamps as ISO-8601 UTC strings, so the durable row
 * survives serialization into an API response unchanged.
 */
function toConversationRecord(row: ConversationRow): ConversationRecord {
  return {
    conversation_id: row.conversation_id,
    tenant_id: row.tenant_id,
    customer_id: row.customer_id,
    channel: row.channel,
    external_thread_id: row.external_thread_id,
    active_agent: row.active_agent,
    state: row.state,
    takeover_operator_id: row.takeover_operator_id,
    last_message_at: row.last_message_at.toISOString(),
    created_at: row.created_at.toISOString(),
  };
}

/** Publishes one message row with its instant as an ISO-8601 UTC string. */
function toMessageRecord(row: ConversationMessagePageRow): ConversationMessageRecord {
  return {
    message_id: row.message_id,
    sender_type: row.sender_type,
    sender_id: row.sender_id,
    content: row.content,
    created_at: row.created_at.toISOString(),
  };
}

/**
 * Validates a conversation state against the closed stored vocabulary.
 *
 * This is the refusal the wire/stored projection is enforced by (implement/06 §8.3 C-3): `ACTIVE`,
 * `HUMAN_TAKEOVER` and `CLOSED` name wire projections the storage layer does not carry, and are
 * refused instead of being translated here — the projection belongs to the gateway, which is the
 * only layer that knows which direction it is translating.
 */
function assertConversationState(state: unknown): asserts state is ConversationState {
  if (typeof state !== 'string' || !CONVERSATION_STATES.includes(state as ConversationState)) {
    throw new Error(
      `CONVERSATION_STATE_INVALID: ${String(state)} is not a stored conversation state; the closed ` +
        `set is ${CONVERSATION_STATES.join(', ')}. The wire vocabulary ACTIVE / HUMAN_TAKEOVER / ` +
        'CLOSED is a projection of these three values and is never stored (implement/06 §8.3 C-3).',
    );
  }
}

/** Validates a sender against the CHECK constraint of `conversation_messages.sender_type`. */
function assertSenderType(sender_type: unknown): asserts sender_type is MessageSenderType {
  if (
    typeof sender_type !== 'string' ||
    !MESSAGE_SENDER_TYPES.includes(sender_type as MessageSenderType)
  ) {
    throw new Error(
      `CONVERSATION_SENDER_TYPE_INVALID: ${String(sender_type)} is not a message sender; the ` +
        `closed set is ${MESSAGE_SENDER_TYPES.join(', ')} (implement/03 §1 DOMAIN 3 Entity 11.1).`,
    );
  }
}

/**
 * Validates the UUID identity of a conversation (`conversations.id` is a `UUID` column).
 *
 * A blank identity is refused with the caller's own `*_REQUIRED` code, exactly as the neighbouring
 * repositories refuse a missing identifier; a value that is not a UUID can never address a row of a
 * `UUID` column, so it is refused with a descriptive message instead of reaching the planner as an
 * invalid text representation.
 *
 * @param value Candidate conversation id.
 * @param code Error code for a blank identity.
 * @returns The validated id.
 */
function readConversationId(value: unknown, code: string): string {
  assertIdentifier(value, 'id', 36, code);

  const conversation_id = value as string;

  if (!UUID.test(conversation_id)) {
    throw new Error(
      `CONVERSATION_ID_INVALID: ${conversation_id} is not the UUID of a conversation; the durable ` +
        `row is addressed by (tenant_id, id) (${CODE_OWNER}).`,
    );
  }

  return conversation_id;
}

/**
 * Reads the optional customer identity of a delivery.
 *
 * A named customer must be the UUID of the customer mirror: `conversations.customer_id` is a `UUID`
 * column whose composite foreign key `(tenant_id, customer_id)` is tenant-scoped
 * (`migrations/0001_tenant_scoped_fks.sql`), so a customer of another tenant is refused by the
 * database, and a value that is not a UUID is refused before any statement is sent.
 *
 * @param value Candidate customer id, or `null` for an anonymous thread.
 * @param code Error code for a malformed identity.
 * @returns The validated id, or `null`.
 */
function readOptionalCustomerId(value: unknown, code: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== 'string' || value.trim().length === 0 || !UUID.test(value)) {
    throw new Error(
      `${code}: customer_id must be the UUID of a customer of this tenant, or null for an ` +
        `anonymous thread (${CODE_OWNER}).`,
    );
  }

  return value;
}

/**
 * Conversation sessions, their turns, and their control transitions (implement/03 §1 DOMAIN 3
 * Entity 11-11.1).
 *
 * Every method opens exactly one tenant-scoped transaction through `withTenantContext`, so the
 * `tenant_id` predicate of every statement is bound to the same tenant the row-level security
 * policy reads. A conversation of another tenant is therefore not found, never published in a
 * redacted form, and never moved.
 */
export class ConversationRepository {
  private readonly runInTenantTransaction: TenantTransactionRunner;

  /**
   * @param runInTenantTransaction Binds a tenant to the transaction every statement runs in.
   * Defaults to the package's `withTenantContext` binder.
   */
  constructor(runInTenantTransaction: TenantTransactionRunner = withTenantContext) {
    this.runInTenantTransaction = runInTenantTransaction;
  }

  /**
   * Binds the `(tenant_id, channel, external_thread_id)` thread to its conversation, creating it
   * when the binding is new (implement/06 §8.1 R01).
   *
   * The bind is a single `INSERT ... ON CONFLICT ... DO NOTHING` followed, when the thread was
   * already bound, by a read of the existing row. A repeated call therefore
   *
   *  * returns the same conversation with `bound: true`,
   *  * inserts no second conversation, and
   *  * writes nothing at all: an existing non-null `customer_id` is not replaced with the `null` of
   *    a later anonymous call, and the conversation's `state` is not moved by a bind.
   *
   * @param input Tenant, channel, thread identity and the optional customer of this delivery.
   * @returns The bound conversation and whether it already existed.
   * @throws Error `CONVERSATION_UNSTABLE` when the binding is reported as taken but no row is
   * visible in this transaction; the bind fails closed rather than starting a second conversation.
   */
  async bindOrCreate(input: BindOrCreateConversationInput): Promise<BoundConversationRecord> {
    assertIdentifier(input.tenant_id, 'tenant_id', 36, 'CONVERSATION_TENANT_ID_REQUIRED');
    assertIdentifier(input.channel, 'channel', 32, 'CONVERSATION_CHANNEL_REQUIRED');
    assertIdentifier(
      input.external_thread_id,
      'external_thread_id',
      128,
      'CONVERSATION_THREAD_REQUIRED',
    );
    const customer_id = readOptionalCustomerId(
      input.customer_id,
      'CONVERSATION_CUSTOMER_ID_INVALID',
    );

    if (input.active_agent !== undefined) {
      assertIdentifier(input.active_agent, 'active_agent', 64, 'CONVERSATION_ACTIVE_AGENT_INVALID');
    }

    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const params: unknown[] = [
        input.tenant_id,
        input.channel,
        input.external_thread_id,
        customer_id,
      ];
      let statement = INSERT_CONVERSATION;

      if (input.active_agent !== undefined) {
        statement = INSERT_CONVERSATION_WITH_AGENT;
        params.push(input.active_agent);
      }

      const inserted = await client.query<ConversationRow>(statement, params);
      const created = inserted.rows[0];

      if (created !== undefined) {
        return { ...toConversationRecord(created), bound: false };
      }

      // The unique key was already bound: the winner's row is read, never overlaid. The insert
      // cannot report the conflict before the conflicting transaction has committed (a rolled-back
      // inserter would have left the key free), so the row is visible to this read.
      const existing = await client.query<ConversationRow>(SELECT_CONVERSATION_BY_THREAD, [
        input.tenant_id,
        input.channel,
        input.external_thread_id,
      ]);
      const held = existing.rows[0];

      if (held === undefined) {
        throw new Error(
          `CONVERSATION_UNSTABLE: the thread binding (${input.channel}, ` +
            `${input.external_thread_id}) was reported as taken by the insert but no conversation ` +
            'is visible in this transaction; refusing to guess which conversation this delivery ' +
            `belongs to (${CODE_OWNER}).`,
        );
      }

      return { ...toConversationRecord(held), bound: true };
    });
  }

  /**
   * Reads one conversation inside the caller's tenant scope.
   *
   * @param tenant_id Tenant that owns the conversation; also enforced by row-level security.
   * @param conversation_id Conversation identity.
   * @returns The stored conversation, or `null` when this tenant does not hold it — a conversation
   * of another tenant is `null`, never a redacted success.
   */
  async get(tenant_id: string, conversation_id: string): Promise<ConversationRecord | null> {
    assertIdentifier(tenant_id, 'tenant_id', 36, 'CONVERSATION_TENANT_ID_REQUIRED');
    const id = readConversationId(conversation_id, 'CONVERSATION_ID_REQUIRED');

    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query<ConversationRow>(SELECT_CONVERSATION, [tenant_id, id]);
      const row = result.rows[0];

      return row === undefined ? null : toConversationRecord(row);
    });
  }

  /**
   * Moves one conversation between the three stored states (implement/06 §8.1 R06/R08).
   *
   * The transition is a single tenant-scoped `UPDATE`: a conversation of another tenant, or an
   * unknown id, matches no row and is reported as `false`. The method never inserts the row it was
   * asked to move — a control action on a conversation that is not there is a refusal, not a
   * creation.
   *
   * @param tenant_id Tenant that owns the conversation.
   * @param conversation_id Conversation to move.
   * @param state Stored state to write; the wire vocabulary is not accepted here.
   * @param takeover_operator_id Operator holding the conversation, or `null` when the agent owns it.
   * @returns `true` when this call moved the conversation, `false` when no row matched.
   * @throws Error `CONVERSATION_STATE_INVALID` when `state` is not one of the three stored values.
   * @throws Error `CONVERSATION_OPERATOR_INVALID` when a blank operator identity is supplied.
   */
  async setState(
    tenant_id: string,
    conversation_id: string,
    state: ConversationState,
    takeover_operator_id: string | null,
  ): Promise<boolean> {
    assertIdentifier(tenant_id, 'tenant_id', 36, 'CONVERSATION_TENANT_ID_REQUIRED');
    const id = readConversationId(conversation_id, 'CONVERSATION_ID_REQUIRED');
    assertConversationState(state);

    if (takeover_operator_id !== null) {
      assertIdentifier(
        takeover_operator_id,
        'takeover_operator_id',
        128,
        'CONVERSATION_OPERATOR_INVALID',
      );
    }

    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query(UPDATE_CONVERSATION_STATE, [
        tenant_id,
        id,
        state,
        takeover_operator_id,
      ]);

      return result.rowCount === 1;
    });
  }

  /**
   * Appends one turn to a conversation and advances the conversation's `last_message_at`
   * (implement/06 §8.1 R02).
   *
   * Both writes happen in the one tenant transaction: the conversation is advanced first, so a turn
   * addressed to a conversation this tenant does not hold is refused before any message row is
   * inserted, and a message can never be stored without the conversation it belongs to showing the
   * turn as its latest activity.
   *
   * `content_type` and `metadata` are omitted from the insert when the caller does not supply them,
   * so the durable column defaults stay the single source of those values.
   *
   * @param input Tenant, conversation, sender, content and the optional turn metadata.
   * @returns The identity of the inserted message.
   * @throws Error `CONVERSATION_NOT_FOUND` when this tenant holds no such conversation.
   * @throws Error `CONVERSATION_SENDER_TYPE_INVALID` when the sender is outside the column's CHECK.
   */
  async appendMessage(input: AppendConversationMessageInput): Promise<string> {
    assertIdentifier(input.tenant_id, 'tenant_id', 36, 'CONVERSATION_TENANT_ID_REQUIRED');
    const conversation_id = readConversationId(input.conversation_id, 'CONVERSATION_ID_REQUIRED');
    assertSenderType(input.sender_type);
    assertIdentifier(input.sender_id, 'sender_id', 128, 'CONVERSATION_SENDER_ID_REQUIRED');

    if (input.content_type !== undefined) {
      assertIdentifier(input.content_type, 'content_type', 32, 'CONVERSATION_CONTENT_TYPE_INVALID');
    }

    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const advanced = await client.query(TOUCH_CONVERSATION_LAST_MESSAGE, [
        input.tenant_id,
        conversation_id,
      ]);

      if (advanced.rowCount !== 1) {
        throw new Error(
          `CONVERSATION_NOT_FOUND: this tenant holds no conversation ${conversation_id}; a turn ` +
            'belongs to a conversation of its own tenant, and refusing here keeps the message from ' +
            `being stored without one (${CODE_OWNER}).`,
        );
      }

      const { text, values } = buildInsertQuery(CONVERSATION_MESSAGES, [
        ['tenant_id', input.tenant_id],
        ['conversation_id', conversation_id],
        ['sender_type', input.sender_type],
        ['sender_id', input.sender_id],
        ['content', input.content],
        ['content_type', input.content_type],
        ['metadata', input.metadata],
      ]);
      const result = await client.query<InsertedMessageRow>(text, values);

      return requireRow(result.rows, CONVERSATION_MESSAGES).id;
    });
  }

  /**
   * Loads the turn history of one conversation, oldest first (implement/06 §8.1 R02/R03).
   *
   * A conversation of another tenant has no messages in this tenant's scope, so the page comes back
   * empty instead of leaking a redacted prefix of someone else's thread. The page size is refused
   * rather than clamped when it is out of range: a silently shrunk page is indistinguishable from a
   * complete one.
   *
   * @param input Tenant, conversation and the bounded page size (default 50, maximum 200).
   * @returns The stored turns in ascending `created_at` order; an empty list when there are none.
   * @throws Error `CONVERSATION_MESSAGE_LIMIT_INVALID` when `limit` is not an integer in 1..200.
   */
  async listMessages(
    input: ConversationMessageScope,
  ): Promise<readonly ConversationMessageRecord[]> {
    assertIdentifier(input.tenant_id, 'tenant_id', 36, 'CONVERSATION_TENANT_ID_REQUIRED');
    const conversation_id = readConversationId(input.conversation_id, 'CONVERSATION_ID_REQUIRED');
    const limit = input.limit === undefined ? DEFAULT_MESSAGE_LIMIT : input.limit;

    if (
      typeof limit !== 'number' ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_MESSAGE_LIMIT
    ) {
      throw new Error(
        `CONVERSATION_MESSAGE_LIMIT_INVALID: limit must be an integer between 1 and ` +
          `${MAX_MESSAGE_LIMIT} (default ${DEFAULT_MESSAGE_LIMIT}); received ` +
          `${String(input.limit)}.`,
      );
    }

    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const result = await client.query<ConversationMessagePageRow>(SELECT_MESSAGES, [
        input.tenant_id,
        conversation_id,
        limit,
      ]);

      return result.rows.map(toMessageRecord);
    });
  }
}
