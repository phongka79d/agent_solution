import type { PoolClient, QueryResultRow } from 'pg';

import type {
  ManageServiceCaseInput,
  ManagedServiceCase,
  ServiceCasePriority,
  ServiceCaseReconciliation,
  ServiceCaseState,
} from '../contracts/service-cases.js';
import { withTenantContext } from '../rls.js';
import { assertIdentifier } from './durable-workflows.js';
import type { TenantTransactionRunner } from './effect-reservations.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const STATES: readonly ServiceCaseState[] = [
  'NEW', 'CLASSIFIED', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED',
];
const PRIORITIES: readonly ServiceCasePriority[] = ['P1', 'P2', 'P3', 'P4'];
const EDGES: Readonly<Record<ServiceCaseState, readonly ServiceCaseState[]>> = Object.freeze({
  NEW: ['CLASSIFIED'],
  CLASSIFIED: ['ASSIGNED'],
  ASSIGNED: ['IN_PROGRESS'],
  IN_PROGRESS: ['WAITING_CUSTOMER', 'RESOLVED'],
  WAITING_CUSTOMER: ['IN_PROGRESS', 'RESOLVED'],
  RESOLVED: ['CLOSED'],
  CLOSED: [],
});

interface ServiceCaseRow extends QueryResultRow {
  case_id: string;
  tenant_id: string;
  customer_id: string;
  intent: string;
  priority: ServiceCasePriority;
  status: ServiceCaseState;
  conversation_id: string;
  related_order_id: string | null;
  evidence_id: string | null;
  evidence_refs: unknown;
  assigned_agent: string;
  assigned_human_id: string | null;
  sla_target_hours: number | null;
  updated_at: Date | string;
  case_version: number;
  sla_history: unknown;
  resolution: string | null;
}

interface ServiceCaseEventRow extends QueryResultRow {
  request_fingerprint: string;
  result_payload: unknown;
}

const CASE_PROJECTION = `
  id AS case_id,
  tenant_id,
  customer_id,
  category AS intent,
  priority,
  state AS status,
  conversation_id,
  order_id AS related_order_id,
  evidence_id,
  evidence_refs,
  assigned_agent,
  assigned_human_id,
  sla_target_hours,
  updated_at,
  case_version,
  sla_history,
  resolution`;

const SELECT_CASE_FOR_UPDATE = `SELECT${CASE_PROJECTION}
  FROM agentos.service_cases
  WHERE tenant_id = $1 AND id = $2
  FOR UPDATE`;

const SELECT_EVENT = `SELECT rtrim(request_fingerprint) AS request_fingerprint, result_payload
  FROM agentos.service_case_events
  WHERE tenant_id = $1 AND effect_key = $2
  FOR UPDATE`;
const CASE_RECONCILIATION_TIMEOUT_MS = 1_000;
const SET_RECONCILIATION_TIMEOUT = `SELECT set_config(
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

const SELECT_CONVERSATION_BINDING = `SELECT id
  FROM agentos.conversations
  WHERE tenant_id = $1 AND id = $2 AND customer_id = $3
  FOR KEY SHARE`;

const SELECT_ORDER_BINDING = `SELECT id
  FROM agentos.orders
  WHERE tenant_id = $1 AND id = $2 AND customer_id = $3
  FOR KEY SHARE`;

const INSERT_CASE = `WITH case_clock AS (
    SELECT COALESCE($2::uuid, agentos.uuid_generate_v7()) AS id,
           CURRENT_TIMESTAMP AS opened_at,
           CURRENT_TIMESTAMP + ($9::int * INTERVAL '1 hour') AS due_at
  )
  INSERT INTO agentos.service_cases (
    id, tenant_id, customer_id, conversation_id, order_id, case_number,
    state, priority, category, subject, assigned_agent, evidence_refs,
    sla_target_hours, sla_due_at, sla_history, case_version, created_at, updated_at
  )
  SELECT id, $1, $3, $4, $5, id::text,
         'NEW', $6, $7, $7, 'CS-01', $8::jsonb,
         $9, due_at,
         jsonb_build_array(jsonb_build_object('opened_at', opened_at, 'due_at', due_at, 'reason', 'created')),
         1, opened_at, opened_at
  FROM case_clock
  RETURNING${CASE_PROJECTION}`;

const UPDATE_CASE = `UPDATE agentos.service_cases AS sc
  SET state = $4,
      priority = $5,
      assigned_agent = $6,
      assigned_human_id = $7,
      order_id = $8,
      evidence_refs = $9::jsonb,
      resolution = $10,
      sla_target_hours = COALESCE($11, sla_target_hours),
      sla_due_at = CASE WHEN $12::boolean
        THEN CURRENT_TIMESTAMP + ($11::int * INTERVAL '1 hour')
        ELSE sla_due_at END,
      sla_history = CASE WHEN $12::boolean THEN
        (
          SELECT COALESCE(jsonb_agg(
            CASE WHEN w.ordinal = jsonb_array_length(sc.sla_history)
              THEN w.value || jsonb_build_object('closed_at', CURRENT_TIMESTAMP)
              ELSE w.value END
            ORDER BY w.ordinal
          ), '[]'::jsonb)
          FROM jsonb_array_elements(sc.sla_history)
            WITH ORDINALITY AS w(value, ordinal)
        ) || jsonb_build_array(jsonb_build_object(
          'opened_at', CURRENT_TIMESTAMP,
          'due_at', CURRENT_TIMESTAMP + ($11::int * INTERVAL '1 hour'),
          'reason', $13::text
        ))
        ELSE sla_history END,
      reopen_count = reopen_count + CASE WHEN $14::boolean THEN 1 ELSE 0 END,
      reopened_at = CASE WHEN $14::boolean THEN CURRENT_TIMESTAMP ELSE reopened_at END,
      case_version = case_version + 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE sc.tenant_id = $1 AND sc.id = $2 AND sc.case_version = $3
  RETURNING${CASE_PROJECTION}`;

const INSERT_CASE_EVENT = `INSERT INTO agentos.service_case_events (
    tenant_id, case_id, effect_key, request_fingerprint, action_type, actor_id,
    case_version, previous_state, next_state, action_details, result_payload
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb)`;

function requireUuid(value: unknown, field: string, code: string): string {
  assertIdentifier(value, field, 36, code);
  const id = value as string;
  if (!UUID.test(id)) throw new Error(`${code}: ${field} must be a UUID.`);
  return id;
}

function requireText(value: unknown, field: string, maxLength: number, code: string): string {
  assertIdentifier(value, field, maxLength, code);
  const text = (value as string).trim();
  if (text.length === 0 || text.length > maxLength) throw new Error(`${code}: invalid ${field}.`);
  return text;
}

function requireSlaHours(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error('CASE_SLA_POLICY_UNAVAILABLE: a positive integer SLA target is required for this action.');
  }
  return value as number;
}

function parseJsonArray(value: unknown, code: string): string[] {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed) as unknown; }
    catch { throw new Error(`${code}: stored JSON is invalid.`); }
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error(`${code}: expected an array of string identifiers.`);
  }
  return parsed;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  let parsed = value;
  if (typeof parsed === 'string') parsed = JSON.parse(parsed) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('CASE_EVENT_INVALID: stored result is not an object.');
  }
  return parsed as Record<string, unknown>;
}

function toManagedCase(row: ServiceCaseRow): ManagedServiceCase {
  if (row.sla_target_hours === null || !Number.isSafeInteger(row.sla_target_hours) || row.sla_target_hours < 1) {
    throw new Error('CASE_SLA_POLICY_UNAVAILABLE: this case has no authoritative SLA target.');
  }
  const evidenceRefs = parseJsonArray(row.evidence_refs, 'CASE_EVIDENCE_INVALID');
  if (row.evidence_id && !evidenceRefs.includes(row.evidence_id)) evidenceRefs.unshift(row.evidence_id);
  if (!STATES.includes(row.status) || !PRIORITIES.includes(row.priority)) {
    throw new Error('CASE_ROW_INVALID: stored case state or priority is outside the canonical vocabulary.');
  }
  return {
    case_id: row.case_id,
    customer_id: row.customer_id,
    intent: row.intent,
    priority: row.priority,
    status: row.status,
    conversation_id: row.conversation_id,
    related_order_id: row.related_order_id,
    evidence_refs: evidenceRefs,
    assigned_owner: row.assigned_human_id ?? row.assigned_agent,
    sla_target_hours: row.sla_target_hours,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : new Date(row.updated_at).toISOString(),
    case_version: row.case_version,
  };
}

function assertLegalTransition(from: ServiceCaseState, to: ServiceCaseState): void {
  if (!EDGES[from].includes(to)) {
    throw new Error(`INVALID_FSM_TRANSITION: ${from} cannot transition to ${to}; case was not changed.`);
  }
}

function readExistingEvidence(row: ServiceCaseRow): string[] {
  const refs = parseJsonArray(row.evidence_refs, 'CASE_EVIDENCE_INVALID');
  if (row.evidence_id && !refs.includes(row.evidence_id)) refs.unshift(row.evidence_id);
  return refs;
}

function validateInput(input: ManageServiceCaseInput): void {
  requireUuid(input.tenant_id, 'tenant_id', 'CASE_TENANT_ID_REQUIRED');
  requireUuid(input.customer_id, 'customer_id', 'CASE_CUSTOMER_ID_REQUIRED');
  requireUuid(input.conversation_id, 'conversation_id', 'CASE_CONVERSATION_ID_REQUIRED');
  requireText(input.intent, 'intent', 64, 'CASE_INTENT_REQUIRED');
  requireText(input.actor_id, 'actor_id', 128, 'CASE_ACTOR_REQUIRED');
  if (!PRIORITIES.includes(input.priority)) throw new Error('CASE_PRIORITY_INVALID: expected P1..P4.');
  if (!SHA256.test(input.effect_key) || !SHA256.test(input.request_fingerprint)) {
    throw new Error('CASE_EFFECT_IDENTITY_INVALID: effect key and request fingerprint must be SHA-256 hex digests.');
  }
  if (input.case_id !== undefined) requireUuid(input.case_id, 'case_id', 'CASE_ID_INVALID');
  if (input.related_order_id !== undefined && input.related_order_id !== null) {
    requireUuid(input.related_order_id, 'related_order_id', 'CASE_ORDER_ID_INVALID');
  }
  if (input.evidence_refs !== undefined) {
    if (!Array.isArray(input.evidence_refs)) throw new Error('CASE_EVIDENCE_INVALID: evidence_refs must be an array.');
    for (const ref of input.evidence_refs) requireUuid(ref, 'evidence_ref', 'CASE_EVIDENCE_INVALID');
  }
  if (input.action_type !== 'CREATE') {
    if (input.case_id === undefined) throw new Error('CASE_ID_REQUIRED: an existing-case action requires case_id.');
    if (!Number.isSafeInteger(input.expected_case_version) || (input.expected_case_version as number) < 1) {
      throw new Error('CASE_VERSION_REQUIRED: an existing-case action requires expected_case_version.');
    }
  }
}

/**
 * Tenant-scoped, versioned case writes. Each action and its immutable receipt commit together; a
 * repeated effect key returns the original result, while a stale new action conflicts.
 */
export class ServiceCaseRepository {
  constructor(
    private readonly runInTenantTransaction: TenantTransactionRunner = withTenantContext,
  ) {}

  async manage(input: ManageServiceCaseInput): Promise<ManagedServiceCase> {
    validateInput(input);
    return this.runInTenantTransaction(input.tenant_id, async (client) => this.manageInTransaction(client, input));
  }
  /**
   * Reconciles an ambiguous write without mutating: receipt lookup first, then a tenant-scoped
   * case-version read before any caller decides whether a new effect is safe.
   */
  async reconcile(input: ManageServiceCaseInput): Promise<ServiceCaseReconciliation> {
    validateInput(input);
    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      await client.query(SET_RECONCILIATION_TIMEOUT, [CASE_RECONCILIATION_TIMEOUT_MS]);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [input.tenant_id, input.effect_key]);
      const replay = await client.query<ServiceCaseEventRow>(SELECT_EVENT, [input.tenant_id, input.effect_key]);
      const event = replay.rows[0];
      if (event) {
        if (event.request_fingerprint.trim() !== input.request_fingerprint) {
          throw new Error('IDEMPOTENCY_CONFLICT: this case effect key was reused for different input.');
        }
        return {
          state: 'COMMITTED',
          output: parseJsonObject(event.result_payload) as unknown as ManagedServiceCase,
        };
      }

      if (input.case_id === undefined) {
        return { state: 'NOT_COMMITTED', case_id: null, current_case_version: null, current_status: null };
      }
      const selected = await client.query<ServiceCaseRow>(SELECT_CASE_FOR_UPDATE, [input.tenant_id, input.case_id]);
      const current = selected.rows[0];
      if (!current) {
        return {
          state: 'NOT_COMMITTED',
          case_id: input.case_id,
          current_case_version: null,
          current_status: null,
        };
      }
      this.assertCaseBinding(input, current);
      return {
        state: 'NOT_COMMITTED',
        case_id: current.case_id,
        current_case_version: current.case_version,
        current_status: current.status,
      };
    });
  }

  private async manageInTransaction(client: PoolClient, input: ManageServiceCaseInput): Promise<ManagedServiceCase> {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [input.tenant_id, input.effect_key]);
    const replay = await client.query<ServiceCaseEventRow>(SELECT_EVENT, [input.tenant_id, input.effect_key]);
    const event = replay.rows[0];
    if (event) {
      if (event.request_fingerprint.trim() !== input.request_fingerprint) {
        throw new Error('IDEMPOTENCY_CONFLICT: this case effect key was reused for different input.');
      }
      return parseJsonObject(event.result_payload) as unknown as ManagedServiceCase;
    }

    await this.assertConversationBinding(client, input);
    const incomingEvidence = [...new Set(input.evidence_refs ?? [])];
    await this.assertEvidenceBindings(client, input, incomingEvidence);

    let previousState: ServiceCaseState | null = null;
    let updated: ServiceCaseRow;
    if (input.action_type === 'CREATE') {
      const slaHours = requireSlaHours(input.sla_target_hours);
      if (input.related_order_id) await this.assertOrderBinding(client, input, input.related_order_id);
      const result = await client.query<ServiceCaseRow>(INSERT_CASE, [
        input.tenant_id,
        input.case_id ?? null,
        input.customer_id,
        input.conversation_id,
        input.related_order_id ?? null,
        input.priority,
        input.intent.trim(),
        JSON.stringify(incomingEvidence),
        slaHours,
      ]);
      const row = result.rows[0];
      if (!row) throw new Error('CASE_CREATE_FAILED: the insert returned no case row.');
      updated = row;
    } else {
      const selected = await client.query<ServiceCaseRow>(SELECT_CASE_FOR_UPDATE, [input.tenant_id, input.case_id]);
      const current = selected.rows[0];
      if (!current) throw new Error('CASE_NOT_FOUND: this tenant holds no case with that identifier.');
      previousState = current.status;
      this.assertCaseBinding(input, current);
      if (current.case_version !== input.expected_case_version) {
        throw new Error(`CASE_VERSION_CONFLICT: expected ${input.expected_case_version}, found ${current.case_version}.`);
      }

      const currentEvidence = readExistingEvidence(current);
      const evidenceRefs = [...new Set([...currentEvidence, ...incomingEvidence])];
      const next = this.resolveMutation(input, current, evidenceRefs);
      const priorityChanged = next.priority !== current.priority;
      const targetHours = priorityChanged
        ? requireSlaHours(input.sla_target_hours)
        : (input.action_type === 'REOPEN'
          ? (input.sla_target_hours === undefined ? requireSlaHours(current.sla_target_hours) : requireSlaHours(input.sla_target_hours))
          : current.sla_target_hours);
      if (targetHours === null) throw new Error('CASE_SLA_POLICY_UNAVAILABLE: this case has no authoritative SLA target.');
      const opensSlaWindow = priorityChanged || input.action_type === 'REOPEN';
      const assigned = this.resolveAssignedOwner(input, current);
      const relatedOrderId = input.related_order_id == null ? current.related_order_id : input.related_order_id;
      if (relatedOrderId !== null && relatedOrderId !== current.related_order_id) {
        await this.assertOrderBinding(client, input, relatedOrderId);
      }
      if ((next.status === 'RESOLVED' || next.status === 'CLOSED') && evidenceRefs.length === 0) {
        throw new Error('CASE_EVIDENCE_REQUIRED: resolution or closure requires linked evidence.');
      }

      const result = await client.query<ServiceCaseRow>(UPDATE_CASE, [
        input.tenant_id,
        input.case_id,
        input.expected_case_version,
        next.status,
        next.priority,
        assigned.agent,
        assigned.human,
        relatedOrderId,
        JSON.stringify(evidenceRefs),
        next.resolution,
        targetHours,
        opensSlaWindow,
        input.action_type === 'REOPEN' ? 'reopened' : 'priority_changed',
        input.action_type === 'REOPEN',
      ]);
      const row = result.rows[0];
      if (!row) throw new Error('CASE_VERSION_CONFLICT: the case changed before this action committed.');
      updated = row;
    }

    const output = toManagedCase(updated);
    await client.query(INSERT_CASE_EVENT, [
      input.tenant_id,
      output.case_id,
      input.effect_key,
      input.request_fingerprint,
      input.action_type,
      input.actor_id,
      output.case_version,
      previousState,
      output.status,
      JSON.stringify({ notes: input.notes ?? null }),
      JSON.stringify(output),
    ]);
    return output;
  }

  private async assertConversationBinding(client: PoolClient, input: ManageServiceCaseInput): Promise<void> {
    const result = await client.query(SELECT_CONVERSATION_BINDING, [
      input.tenant_id, input.conversation_id, input.customer_id,
    ]);
    if (result.rows.length !== 1) {
      throw new Error('CASE_CONVERSATION_BINDING_INVALID: conversation is not bound to this tenant and customer.');
    }
  }

  private async assertOrderBinding(client: PoolClient, input: ManageServiceCaseInput, orderId: string): Promise<void> {
    const result = await client.query(SELECT_ORDER_BINDING, [input.tenant_id, orderId, input.customer_id]);
    if (result.rows.length !== 1) {
      throw new Error('CASE_ORDER_BINDING_INVALID: order is not bound to this tenant and customer.');
    }
  }

  private async assertEvidenceBindings(
    client: PoolClient,
    input: ManageServiceCaseInput,
    evidenceRefs: readonly string[],
  ): Promise<void> {
    if (evidenceRefs.length === 0) return;
    const result = await client.query(
      `SELECT id FROM agentos.evidences
        WHERE tenant_id = $1 AND customer_id = $2 AND id = ANY($3::uuid[])
        FOR KEY SHARE`,
      [input.tenant_id, input.customer_id, evidenceRefs],
    );
    if (result.rows.length !== evidenceRefs.length) {
      throw new Error('CASE_EVIDENCE_BINDING_INVALID: one or more evidence rows are not bound to this tenant and customer.');
    }
  }

  private assertCaseBinding(input: ManageServiceCaseInput, current: ServiceCaseRow): void {
    if (current.customer_id !== input.customer_id || current.conversation_id !== input.conversation_id
      || current.intent !== input.intent.trim()) {
      throw new Error('CASE_BINDING_MISMATCH: customer, conversation, and intent must match the stored case.');
    }
  }

  private resolveMutation(
    input: ManageServiceCaseInput,
    current: ServiceCaseRow,
    evidenceRefs: readonly string[],
  ): { status: ServiceCaseState; priority: ServiceCasePriority; resolution: string | null } {
    let status = current.status;
    let resolution = current.resolution;
    if (input.action_type === 'TRANSITION_STATE') {
      if (!input.target_status) throw new Error('CASE_TARGET_STATUS_REQUIRED: TRANSITION_STATE requires target_status.');
      assertLegalTransition(current.status, input.target_status);
      status = input.target_status;
      if (status === 'RESOLVED') resolution = requireText(input.notes, 'notes', 2000, 'CASE_RESOLUTION_REQUIRED');
    } else if (input.action_type === 'ASSIGN') {
      requireText(input.assigned_owner, 'assigned_owner', 128, 'CASE_OWNER_REQUIRED');
      if (current.status === 'CLASSIFIED') status = 'ASSIGNED';
      else if (!['ASSIGNED', 'IN_PROGRESS', 'WAITING_CUSTOMER'].includes(current.status)) {
        throw new Error(`INVALID_FSM_TRANSITION: ASSIGN is not allowed from ${current.status}.`);
      }
    } else if (input.action_type === 'RESOLVE') {
      assertLegalTransition(current.status, 'RESOLVED');
      status = 'RESOLVED';
      resolution = requireText(input.notes, 'notes', 2000, 'CASE_RESOLUTION_REQUIRED');
    } else if (input.action_type === 'CLOSE') {
      assertLegalTransition(current.status, 'CLOSED');
      status = 'CLOSED';
    } else if (input.action_type === 'REOPEN') {
      if (current.status !== 'RESOLVED' && current.status !== 'CLOSED') {
        throw new Error(`INVALID_FSM_TRANSITION: REOPEN is not allowed from ${current.status}.`);
      }
      requireText(input.notes, 'notes', 2000, 'CASE_REOPEN_REASON_REQUIRED');
      status = 'IN_PROGRESS';
    } else {
      throw new Error(`CASE_ACTION_INVALID: unsupported action ${input.action_type}.`);
    }
    if ((status === 'RESOLVED' || status === 'CLOSED') && evidenceRefs.length === 0) {
      throw new Error('CASE_EVIDENCE_REQUIRED: resolution or closure requires linked evidence.');
    }
    return { status, priority: input.priority, resolution };
  }

  private resolveAssignedOwner(
    input: ManageServiceCaseInput,
    current: ServiceCaseRow,
  ): { agent: string; human: string | null } {
    if (input.action_type !== 'ASSIGN') {
      return { agent: current.assigned_agent, human: current.assigned_human_id };
    }
    const owner = requireText(input.assigned_owner, 'assigned_owner', 128, 'CASE_OWNER_REQUIRED');
    return /^CS-[A-Z0-9-]+$/i.test(owner)
      ? { agent: owner, human: null }
      : { agent: current.assigned_agent, human: owner };
  }
}
