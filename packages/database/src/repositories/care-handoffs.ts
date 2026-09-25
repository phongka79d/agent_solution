import type { PoolClient, QueryResult, QueryResultRow } from 'pg';

import type {
  CareHandoffClaimOutcome,
  CareHandoffCompletionOutcome,
  CareHandoffEnqueueResult,
  CareHandoffExecutionReceipt,
  CareHandoffOutput,
  CareHandoffReconciliation,
  ClaimCareHandoffInput,
  CompleteCareHandoffInput,
  EnqueueCareHandoffInput,
  ReconcileCareHandoffInput,
} from '../contracts/care-handoffs.js';
import { withTenantContext } from '../rls.js';
import { assertCompleteCheckpoint } from './durable-workflows.js';
import type { TenantTransactionRunner } from './effect-reservations.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const SKILL_ID = 'skill.care.escalate_to_human';
const HANDOFF_TRANSACTION_TIMEOUT_MS = 1_000;
const SET_STATEMENT_TIMEOUT = `SELECT set_config(
  'statement_timeout',
  CASE WHEN current_setting('statement_timeout') = '0'
    THEN $1::text || 'ms'
    ELSE GREATEST(
      1,
      FLOOR(EXTRACT(EPOCH FROM LEAST(
        current_setting('statement_timeout')::interval,
        $1::int * INTERVAL '1 ms'
      )) * 1000)::int
    )::text || 'ms'
  END,
  true
)`;

interface HandoffRow extends QueryResultRow {
  handoff_id: string;
  request_fingerprint: string;
  run_id: string;
  step_index: number;
  skill_id: string;
  session_id?: string;
  conversation_id?: string;
  customer_id?: string | null;
  result_payload: unknown;
  execution_receipt: unknown;
}

interface TaskRow extends QueryResultRow {
  state: string;
  current_step: number;
  task_version: number;
  lease_owner: string | null;
  lease_active: boolean;
  state_payload: unknown;
}

interface ConversationRow extends QueryResultRow {
  customer_id: string | null;
  external_thread_id: string;
  state: string;
  takeover_operator_id: string | null;
}

interface ReservationRow extends QueryResultRow {
  request_id: string;
  request_fingerprint: string;
  run_id: string;
  step_index: number;
  skill_id: string;
  status: string;
  response_receipt: unknown;
}

interface InsertClockRow extends QueryResultRow {
  handoff_id: string;
  created_at: Date | string;
}

const SELECT_HANDOFF_BY_EFFECT = `SELECT
    id::text AS handoff_id,
    rtrim(request_fingerprint) AS request_fingerprint,
    run_id,
    step_index,
    'skill.care.escalate_to_human'::text AS skill_id,
    session_id,
    conversation_id::text AS conversation_id,
    customer_id::text AS customer_id,
    result_payload,
    execution_receipt
  FROM agentos.care_handoffs
  WHERE tenant_id = $1 AND effect_key = $2`;

const SELECT_CONVERSATION_FOR_UPDATE = `SELECT
    customer_id::text AS customer_id,
    external_thread_id,
    state,
    takeover_operator_id
  FROM agentos.conversations
  WHERE tenant_id = $1 AND id = $2
  FOR UPDATE`;

function requireString(value: unknown, field: string, code: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${code}: ${field} must be a non-empty string.`);
  }
  return value;
}

function requireUuid(value: unknown, field: string, code: string): string {
  const candidate = requireString(value, field, code);
  if (!UUID.test(candidate)) throw new Error(`${code}: ${field} must be a UUID.`);
  return candidate;
}

function requireFingerprint(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error(`HANDOFF_${field.toUpperCase()}_INVALID: ${field} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function requireRecord(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${code}: expected a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function isoTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('HANDOFF_TIMESTAMP_INVALID: stored timestamp is invalid.');
  return date.toISOString();
}

function parseOutput(value: unknown): CareHandoffOutput {
  const row = requireRecord(value, 'HANDOFF_RECEIPT_INVALID');
  if (
    typeof row['handoff_id'] !== 'string'
    || !Number.isSafeInteger(row['queue_position'])
    || (row['queue_position'] as number) < 1
    || (row['status'] !== 'ENQUEUED' && row['status'] !== 'ASSIGNED')
    || typeof row['escalated_at'] !== 'string'
  ) {
    throw new Error('HANDOFF_RECEIPT_INVALID: stored enqueue result does not match the skill contract.');
  }
  return {
    handoff_id: row['handoff_id'],
    queue_position: row['queue_position'] as number,
    status: row['status'],
    escalated_at: row['escalated_at'],
  };
}

function parseReceipt(value: unknown, output: CareHandoffOutput): CareHandoffExecutionReceipt {
  const row = requireRecord(value, 'HANDOFF_RECEIPT_INVALID');
  const response = parseOutput(row['response_payload']);
  if (
    row['execution_id'] !== output.handoff_id
    || row['adapter_status'] !== 'SUCCESS'
    || row['provider_reference'] !== output.handoff_id
    || row['latency_ms'] !== 0
    || response.handoff_id !== output.handoff_id
    || response.queue_position !== output.queue_position
    || response.status !== output.status
    || response.escalated_at !== output.escalated_at
  ) {
    throw new Error('HANDOFF_RECEIPT_INVALID: stored stable receipt does not match the handoff result.');
  }
  const tokenUsage = requireRecord(row['token_usage'], 'HANDOFF_RECEIPT_INVALID');
  if (tokenUsage['prompt'] !== 0 || tokenUsage['completion'] !== 0 || tokenUsage['total_cost_usd'] !== 0) {
    throw new Error('HANDOFF_RECEIPT_INVALID: handoff token usage must be zero.');
  }
  return {
    execution_id: output.handoff_id,
    adapter_status: 'SUCCESS',
    provider_reference: output.handoff_id,
    response_payload: output,
    latency_ms: 0,
    token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
  };
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function boundedQuery(client: PoolClient, deadline: number) {
  return async <Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResult<Row>> => {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining < 1) throw new Error('HANDOFF_QUEUE_TIMEOUT: transaction exceeded its 1000ms deadline.');
    await client.query(SET_STATEMENT_TIMEOUT, [remaining]);
    if (performance.now() >= deadline) {
      throw new Error('HANDOFF_QUEUE_TIMEOUT: transaction exceeded its 1000ms deadline.');
    }
    return client.query<Row>(sql, params);
  };
}

function validateEnqueueInput(input: EnqueueCareHandoffInput): void {
  requireUuid(input.tenant_id, 'tenant_id', 'HANDOFF_INPUT_INVALID');
  requireUuid(input.conversation_id, 'conversation_id', 'HANDOFF_INPUT_INVALID');
  if (input.customer_id !== undefined) requireUuid(input.customer_id, 'customer_id', 'HANDOFF_INPUT_INVALID');
  requireString(input.run_id, 'run_id', 'HANDOFF_INPUT_INVALID');
  requireString(input.session_id, 'session_id', 'HANDOFF_INPUT_INVALID');
  requireString(input.escalation_reason, 'escalation_reason', 'HANDOFF_INPUT_INVALID');
  if (input.summary_context !== undefined && typeof input.summary_context !== 'string') {
    throw new Error('HANDOFF_INPUT_INVALID: summary_context must be a string when supplied.');
  }
  requireFingerprint(input.effect_key, 'effect_key');
  requireFingerprint(input.request_fingerprint, 'request_fingerprint');
}

function readExisting(
  row: HandoffRow,
  input: {
    readonly request_fingerprint: string;
    readonly run_id?: string | undefined;
    readonly conversation_id?: string | undefined;
    readonly session_id?: string | undefined;
    readonly customer_id?: string | null | undefined;
  },
): CareHandoffEnqueueResult {
  if (row.request_fingerprint.trim() !== input.request_fingerprint) {
    throw new Error('IDEMPOTENCY_CONFLICT: this handoff effect key was reused for different input.');
  }
  if (input.run_id !== undefined && row.run_id !== input.run_id) {
    throw new Error('HANDOFF_EFFECT_BINDING_MISMATCH: effect key is bound to a different durable run.');
  }
  if (row.conversation_id !== undefined && input.conversation_id !== undefined && row.conversation_id !== input.conversation_id) {
    throw new Error('HANDOFF_SESSION_BINDING_INVALID: conversation_id does not match the stored handoff.');
  }
  if (row.session_id !== undefined && input.session_id !== undefined && row.session_id !== input.session_id) {
    throw new Error('HANDOFF_SESSION_BINDING_INVALID: session_id does not match the stored handoff.');
  }
  if (row.customer_id !== undefined && row.customer_id !== null && input.customer_id !== undefined && row.customer_id !== input.customer_id) {
    throw new Error('HANDOFF_CUSTOMER_BINDING_INVALID: customer_id does not match the stored handoff.');
  }
  const output = parseOutput(row.result_payload);
  const receipt = parseReceipt(row.execution_receipt, output);
  if (row.handoff_id !== output.handoff_id || row.handoff_id !== receipt.execution_id) {
    throw new Error('HANDOFF_RECEIPT_INVALID: handoff identity is inconsistent.');
  }
  return { disposition: 'REPLAY', output, receipt };
}

function requireOperator(input: ClaimCareHandoffInput): void {
  requireUuid(input.tenant_id, 'tenant_id', 'HANDOFF_INPUT_INVALID');
  requireUuid(input.conversation_id, 'conversation_id', 'HANDOFF_INPUT_INVALID');
  const operator = requireString(input.operator_id, 'operator_id', 'HANDOFF_INPUT_INVALID');
  if (operator.length > 128) throw new Error('HANDOFF_INPUT_INVALID: operator_id exceeds 128 characters.');
}

export class CareHandoffRepository {
  constructor(private readonly runInTenantTransaction: TenantTransactionRunner = withTenantContext) {}

  /** Enqueues once and atomically parks the run, pauses the conversation and settles its reservation. */
  async enqueue(input: EnqueueCareHandoffInput): Promise<CareHandoffEnqueueResult> {
    validateEnqueueInput(input);
    const fingerprint = requireFingerprint(input.request_fingerprint, 'request_fingerprint');
    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const deadline = performance.now() + HANDOFF_TRANSACTION_TIMEOUT_MS;
      const query = boundedQuery(client, deadline);
      await query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [input.tenant_id, 'care_handoff_queue']);

      const existingResult = await query<HandoffRow>(
        `${SELECT_HANDOFF_BY_EFFECT} FOR UPDATE`,
        [input.tenant_id, input.effect_key],
      );
      const existing = existingResult.rows[0];
      if (existing) {
        const replay = readExisting(existing, {
          request_fingerprint: fingerprint,
          run_id: input.run_id,
          conversation_id: input.conversation_id,
          session_id: input.session_id,
          customer_id: input.customer_id,
        });
        const reservationResult = await query<ReservationRow>(
          `SELECT request_id, rtrim(request_fingerprint) AS request_fingerprint, run_id, step_index,
                  skill_id, status, response_receipt
             FROM agentos.effect_reservations
            WHERE tenant_id = $1 AND effect_key = $2
            FOR UPDATE`,
          [input.tenant_id, input.effect_key],
        );
        const reservation = reservationResult.rows[0];
        if (
          !reservation
          || reservation.status !== 'SUCCEEDED'
          || reservation.run_id !== input.run_id
          || reservation.step_index !== existing.step_index
          || reservation.skill_id !== SKILL_ID
          || reservation.request_fingerprint.trim() !== fingerprint
          || !sameJsonValue(reservation.response_receipt, existing.execution_receipt)
        ) {
          throw new Error('HANDOFF_EFFECT_BINDING_MISMATCH: stored queue item and effect reservation disagree.');
        }
        return replay;
      }

      const taskResult = await query<TaskRow>(
        `SELECT state, current_step, task_version, lease_owner,
                lease_expires_at > CURRENT_TIMESTAMP AS lease_active, state_payload
           FROM agentos.platform_durable_tasks
          WHERE tenant_id = $1 AND run_id = $2
          FOR UPDATE`,
        [input.tenant_id, input.run_id],
      );
      const task = taskResult.rows[0];
      if (!task || task.state !== 'running' || task.lease_owner === null || !task.lease_active) {
        throw new Error('HANDOFF_TASK_NOT_ACTIVE: handoff requires a running task with a live worker lease.');
      }
      assertCompleteCheckpoint(task.state_payload);
      const checkpoint = task.state_payload as Record<string, unknown>;
      const pending = requireRecord(checkpoint['pending_action'], 'HANDOFF_CHECKPOINT_MISMATCH');
      const stepIndex = checkpoint['current_step'];
      if (
        !Number.isSafeInteger(stepIndex)
        || stepIndex !== task.current_step
        || pending['skill_id'] !== SKILL_ID
        || pending['effect_key'] !== input.effect_key
        || pending['run_id'] !== input.run_id
        || pending['tenant_id'] !== input.tenant_id
        || pending['step_index'] !== stepIndex
        || pending['request_id'] !== checkpoint['request_id']
      ) {
        throw new Error('HANDOFF_CHECKPOINT_MISMATCH: pending action does not match the durable handoff request.');
      }

      const conversationResult = await query<ConversationRow>(SELECT_CONVERSATION_FOR_UPDATE, [
        input.tenant_id,
        input.conversation_id,
      ]);
      const conversation = conversationResult.rows[0];
      if (!conversation) throw new Error('HANDOFF_CONVERSATION_NOT_FOUND: conversation is not bound to this tenant.');
      if (conversation.external_thread_id !== input.session_id) {
        throw new Error('HANDOFF_SESSION_BINDING_INVALID: session_id does not match the conversation thread.');
      }
      if (input.customer_id !== undefined && conversation.customer_id !== input.customer_id) {
        throw new Error('HANDOFF_CUSTOMER_BINDING_INVALID: customer_id does not match the conversation.');
      }
      const activeResult = await query<{ readonly handoff_id: string } & QueryResultRow>(
        `SELECT id::text AS handoff_id
           FROM agentos.care_handoffs
          WHERE tenant_id = $1 AND conversation_id = $2
            AND status IN ('ENQUEUED', 'ASSIGNED')
          FOR UPDATE`,
        [input.tenant_id, input.conversation_id],
      );
      if (activeResult.rows.length > 0) {
        throw new Error('HANDOFF_ALREADY_ACTIVE: this conversation already has an active human handoff.');
      }
      if (conversation.state !== 'open' || conversation.takeover_operator_id !== null) {
        throw new Error('HANDOFF_CONVERSATION_NOT_AVAILABLE: conversation is not under bot control.');
      }

      const reservationResult = await query<ReservationRow>(
        `SELECT request_id, rtrim(request_fingerprint) AS request_fingerprint, run_id, step_index,
                skill_id, status, response_receipt
           FROM agentos.effect_reservations
          WHERE tenant_id = $1 AND effect_key = $2
          FOR UPDATE`,
        [input.tenant_id, input.effect_key],
      );
      const reservation = reservationResult.rows[0];
      if (!reservation) throw new Error('HANDOFF_EFFECT_RESERVATION_NOT_FOUND: no effect reservation exists.');
      if (
        reservation.run_id !== input.run_id
        || reservation.skill_id !== SKILL_ID
        || reservation.request_fingerprint.trim() !== fingerprint
        || reservation.status !== 'RESERVED'
        || reservation.request_id !== checkpoint['request_id']
        || reservation.step_index !== stepIndex
      ) {
        throw new Error('HANDOFF_EFFECT_RESERVATION_INVALID: reservation does not match the pending action.');
      }

      const queueResult = await query<{ readonly queue_position: number } & QueryResultRow>(
        `SELECT COUNT(*)::int + 1 AS queue_position
           FROM agentos.care_handoffs
          WHERE tenant_id = $1 AND status = 'ENQUEUED'`,
        [input.tenant_id],
      );
      const queuePosition = queueResult.rows[0]?.queue_position;
      if (!Number.isSafeInteger(queuePosition) || (queuePosition as number) < 1) {
        throw new Error('HANDOFF_QUEUE_STATE_INVALID: queue position could not be determined.');
      }
      const clockResult = await query<InsertClockRow>(
        'SELECT agentos.uuid_generate_v7()::text AS handoff_id, clock_timestamp() AS created_at',
      );
      const clock = clockResult.rows[0];
      if (!clock) throw new Error('HANDOFF_QUEUE_STATE_INVALID: the database did not issue a handoff identity.');

      const output: CareHandoffOutput = {
        handoff_id: clock.handoff_id,
        queue_position: queuePosition as number,
        status: 'ENQUEUED',
        escalated_at: isoTimestamp(clock.created_at),
      };
      const receipt: CareHandoffExecutionReceipt = {
        execution_id: output.handoff_id,
        adapter_status: 'SUCCESS',
        provider_reference: output.handoff_id,
        response_payload: output,
        latency_ms: 0,
        token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
      };
      const evidence_payload = {
        evidence_card: 'EV_HUMAN_HANDOFF',
        tenant_id: input.tenant_id,
        run_id: input.run_id,
        customer_id: conversation.customer_id,
        session_id: input.session_id,
        conversation_id: input.conversation_id,
        effect_key: input.effect_key,
        receipt,
        handoff_receipt: receipt,
        action: checkpoint['pending_action'],
        replayed: false,
      };
      const handoff_resume_event = {
        tenant_id: input.tenant_id,
        run_id: input.run_id,
        event_type: 'human.handoff.evidence' as const,
        evidence_payload,
        step_index: stepIndex,
        effect_key: input.effect_key,
      };

      await query(
        `INSERT INTO agentos.care_handoffs (
           id, tenant_id, run_id, step_index, effect_key, request_fingerprint,
           session_id, conversation_id, customer_id, escalation_reason, summary_context,
           status, queue_position, result_payload, execution_receipt, created_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
           'ENQUEUED', $12, $13::jsonb, $14::jsonb, $15::timestamptz
         )`,
        [
          output.handoff_id,
          input.tenant_id,
          input.run_id,
          stepIndex,
          input.effect_key,
          fingerprint,
          input.session_id,
          input.conversation_id,
          conversation.customer_id,
          input.escalation_reason,
          input.summary_context ?? null,
          output.queue_position,
          JSON.stringify(output),
          JSON.stringify(receipt),
          output.escalated_at,
        ],
      );

      const parked = await query(
        `UPDATE agentos.platform_durable_tasks
            SET state = 'awaiting_human', state_payload = state_payload || $5::jsonb,
                task_version = task_version + 1,
                lease_owner = NULL, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = $1 AND run_id = $2 AND state = 'running'
            AND task_version = $3 AND current_step = $4
            AND lease_owner IS NOT NULL AND lease_expires_at > CURRENT_TIMESTAMP
          RETURNING run_id`,
        [input.tenant_id, input.run_id, task.task_version, stepIndex, JSON.stringify({ resume_event: handoff_resume_event })],
      );
      if (parked.rows.length !== 1) throw new Error('HANDOFF_TASK_STATE_CONFLICT: task changed before handoff commit.');

      const paused = await query(
        `UPDATE agentos.conversations
            SET state = 'paused_takeover', takeover_operator_id = NULL
          WHERE tenant_id = $1 AND id = $2 AND external_thread_id = $3
            AND state = 'open' AND takeover_operator_id IS NULL
          RETURNING id`,
        [input.tenant_id, input.conversation_id, input.session_id],
      );
      if (paused.rows.length !== 1) throw new Error('HANDOFF_CONVERSATION_STATE_CONFLICT: conversation changed before handoff commit.');

      const settled = await query(
        `UPDATE agentos.effect_reservations
            SET status = 'SUCCEEDED', response_receipt = $4::jsonb, resolved_at = CURRENT_TIMESTAMP
          WHERE tenant_id = $1 AND effect_key = $2 AND run_id = $3
            AND step_index = $5 AND skill_id = $6 AND status = 'RESERVED'
          RETURNING effect_key`,
        [input.tenant_id, input.effect_key, input.run_id, JSON.stringify(receipt), stepIndex, SKILL_ID],
      );
      if (settled.rows.length !== 1) throw new Error('HANDOFF_EFFECT_SETTLEMENT_CONFLICT: reservation changed before commit.');

      return { disposition: 'CREATED', output, receipt };
    });
  }

  /** Read-only resolution after timeout; it never re-enqueues or mutates an effect. */
  async reconcile(input: ReconcileCareHandoffInput): Promise<CareHandoffReconciliation> {
    requireUuid(input.tenant_id, 'tenant_id', 'HANDOFF_INPUT_INVALID');
    const effectKey = requireFingerprint(input.effect_key, 'effect_key');
    const fingerprint = requireFingerprint(input.request_fingerprint, 'request_fingerprint');
    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const query = boundedQuery(client, performance.now() + HANDOFF_TRANSACTION_TIMEOUT_MS);
      const result = await query<HandoffRow>(SELECT_HANDOFF_BY_EFFECT, [input.tenant_id, effectKey]);
      const row = result.rows[0];
      if (!row) return { state: 'NOT_COMMITTED' };
      const replay = readExisting(row, { request_fingerprint: fingerprint });
      return { state: 'COMMITTED', output: replay.output, receipt: replay.receipt };
    });
  }

  /** Claims an enqueued handoff and writes its owner to the durable conversation in one transaction. */
  async claim(input: ClaimCareHandoffInput): Promise<CareHandoffClaimOutcome> {
    requireOperator(input);
    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const deadline = performance.now() + HANDOFF_TRANSACTION_TIMEOUT_MS;
      const query = boundedQuery(client, deadline);
      await query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [input.tenant_id, 'care_handoff_queue']);
      const conversationResult = await query<ConversationRow>(SELECT_CONVERSATION_FOR_UPDATE, [
        input.tenant_id,
        input.conversation_id,
      ]);
      const conversation = conversationResult.rows[0];
      if (!conversation) throw new Error('HANDOFF_CONVERSATION_NOT_FOUND: conversation is not bound to this tenant.');
      const activeResult = await query<{
        handoff_id: string;
        run_id: string;
        status: string;
        operator_id: string | null;
      } & QueryResultRow>(
        `SELECT id::text AS handoff_id, run_id, status, operator_id
           FROM agentos.care_handoffs
          WHERE tenant_id = $1 AND conversation_id = $2
            AND status IN ('ENQUEUED', 'ASSIGNED')
          FOR UPDATE`,
        [input.tenant_id, input.conversation_id],
      );
      const handoff = activeResult.rows[0];
      if (!handoff) return 'NO_HANDOFF';
      if (handoff.status === 'ASSIGNED') {
        if (handoff.operator_id !== input.operator_id) return 'HELD_BY_ANOTHER_OPERATOR';
        if (conversation.state !== 'paused_takeover' || conversation.takeover_operator_id !== input.operator_id) {
          throw new Error('HANDOFF_STATE_CONFLICT: assigned handoff and conversation owner disagree.');
        }
        return 'CLAIMED';
      }
      if (
        conversation.state === 'closed'
        || (conversation.state === 'paused_takeover'
          && conversation.takeover_operator_id !== null
          && conversation.takeover_operator_id !== input.operator_id)
      ) {
        return 'HELD_BY_ANOTHER_OPERATOR';
      }
      if (conversation.state !== 'open' && conversation.state !== 'paused_takeover') {
        throw new Error('HANDOFF_STATE_CONFLICT: conversation cannot be assigned from its current state.');
      }
      const updatedHandoff = await query(
        `UPDATE agentos.care_handoffs
            SET status = 'ASSIGNED', operator_id = $3, claimed_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = $1 AND id = $2 AND status = 'ENQUEUED'
          RETURNING id`,
        [input.tenant_id, handoff.handoff_id, input.operator_id],
      );
      if (updatedHandoff.rows.length !== 1) throw new Error('HANDOFF_STATE_CONFLICT: handoff changed during assignment.');
      const updatedConversation = await query(
        `UPDATE agentos.conversations
            SET state = 'paused_takeover', takeover_operator_id = $3
          WHERE tenant_id = $1 AND id = $2
            AND state IN ('open', 'paused_takeover')
            AND (takeover_operator_id IS NULL OR takeover_operator_id = $3)
          RETURNING id`,
        [input.tenant_id, input.conversation_id, input.operator_id],
      );
      if (updatedConversation.rows.length !== 1) throw new Error('HANDOFF_CONVERSATION_STATE_CONFLICT: conversation changed during assignment.');
      return 'CLAIMED';
    });
  }

  /** Completes an assigned handoff, durable task, and conversation return as one commit. */
  async complete(input: CompleteCareHandoffInput): Promise<CareHandoffCompletionOutcome> {
    requireOperator(input);
    if (input.completion_summary !== undefined && input.completion_summary !== null
      && typeof input.completion_summary !== 'string') {
      throw new Error('HANDOFF_INPUT_INVALID: completion_summary must be a string when supplied.');
    }
    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const deadline = performance.now() + HANDOFF_TRANSACTION_TIMEOUT_MS;
      const query = boundedQuery(client, deadline);
      const conversationResult = await query<ConversationRow>(SELECT_CONVERSATION_FOR_UPDATE, [
        input.tenant_id,
        input.conversation_id,
      ]);
      const conversation = conversationResult.rows[0];
      if (!conversation) throw new Error('HANDOFF_CONVERSATION_NOT_FOUND: conversation is not bound to this tenant.');
      const activeResult = await query<{
        handoff_id: string;
        run_id: string;
        status: string;
        operator_id: string | null;
      } & QueryResultRow>(
        `SELECT id::text AS handoff_id, run_id, status, operator_id
           FROM agentos.care_handoffs
          WHERE tenant_id = $1 AND conversation_id = $2
            AND status IN ('ENQUEUED', 'ASSIGNED')
          FOR UPDATE`,
        [input.tenant_id, input.conversation_id],
      );
      const handoff = activeResult.rows[0];
      if (!handoff) return 'NO_HANDOFF';
      if (handoff.status === 'ENQUEUED') return 'NOT_ASSIGNED';
      if (handoff.operator_id !== input.operator_id) return 'HELD_BY_ANOTHER_OPERATOR';
      if (conversation.state !== 'paused_takeover' || conversation.takeover_operator_id !== input.operator_id) {
        throw new Error('HANDOFF_STATE_CONFLICT: assigned handoff and conversation owner disagree.');
      }

      const taskResult = await query<{ state: string; state_payload: unknown } & QueryResultRow>(
        'SELECT state, state_payload FROM agentos.platform_durable_tasks WHERE tenant_id = $1 AND run_id = $2 FOR UPDATE',
        [input.tenant_id, handoff.run_id],
      );
      const taskRow = taskResult.rows[0];
      if (taskRow?.state !== 'awaiting_human') {
        throw new Error('HANDOFF_TASK_STATE_CONFLICT: assigned handoff has no awaiting-human task.');
      }
      if (taskRow.state_payload !== null && typeof taskRow.state_payload === 'object' && !Array.isArray(taskRow.state_payload) && Object.prototype.hasOwnProperty.call(taskRow.state_payload, 'resume_event')) {
        throw new Error('HANDOFF_EVIDENCE_PENDING: durable handoff evidence repair must be consumed before completion.');
      }
      const completed = await query(
        `UPDATE agentos.care_handoffs
            SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP,
                completion_summary = $3, updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = $1 AND id = $2 AND status = 'ASSIGNED' AND operator_id = $4
          RETURNING id`,
        [input.tenant_id, handoff.handoff_id, input.completion_summary ?? null, input.operator_id],
      );
      if (completed.rows.length !== 1) throw new Error('HANDOFF_STATE_CONFLICT: handoff changed during completion.');

      const task = await query(
        `UPDATE agentos.platform_durable_tasks
            SET state = 'completed', task_version = task_version + 1,
                lease_owner = NULL, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = $1 AND run_id = $2 AND state = 'awaiting_human'
          RETURNING run_id`,
        [input.tenant_id, handoff.run_id],
      );
      if (task.rows.length !== 1) throw new Error('HANDOFF_TASK_STATE_CONFLICT: task changed during completion.');

      const reopened = await query(
        `UPDATE agentos.conversations
            SET state = 'open', takeover_operator_id = NULL
          WHERE tenant_id = $1 AND id = $2 AND state = 'paused_takeover'
            AND takeover_operator_id = $3
          RETURNING id`,
        [input.tenant_id, input.conversation_id, input.operator_id],
      );
      if (reopened.rows.length !== 1) throw new Error('HANDOFF_CONVERSATION_STATE_CONFLICT: conversation changed during completion.');
      return 'COMPLETED';
    });
  }
}
