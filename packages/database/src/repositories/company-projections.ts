import type { QueryResultRow } from 'pg';

import { assertTenantContext, withTenantContext } from '../rls.js';
import type { TenantTransactionRunner } from './effect-reservations.js';
const APPROVALS = 'agentos.approvals';
const ACTIONS = 'agentos.actions';
const HANDOFFS = 'agentos.care_handoffs';
const CONNECTORS = 'agentos.connector_configurations';
const OWNER_INPUTS = 'agentos.unresolved_owner_inputs';
const TASKS = 'agentos.platform_durable_tasks';
const RESERVATIONS = 'agentos.effect_reservations';
const AGENTS = 'agentos.agents';
const RESPONSES = 'agentos.run_responses';
const STAGES = 'agentos.run_stage_events';

export interface CompanyApprovalProjectionSource {
  readonly id: string;
  readonly run_id: string;
  readonly skill_name: string | null;
  readonly decision: string;
  readonly created_at: string;
  readonly decided_at: string | null;
}

export interface CompanyHandoffProjectionSource {
  readonly id: string;
  readonly run_id: string;
  readonly conversation_id: string;
  readonly status: 'ENQUEUED' | 'ASSIGNED' | 'COMPLETED' | string;
  readonly created_at: string;
}

export interface CompanyConnectorProjectionSource {
  readonly connector_id: string;
  readonly status: 'UNBOUND' | 'DISABLED' | string;
  /** Deliberately not selected: secret_ref must never cross the projection boundary. */
}

export interface CompanyOwnerInputProjectionSource {
  readonly input_id: string;
  readonly status: 'UNRESOLVED' | string;
}

export interface CompanyReconciliationProjectionSource {
  readonly run_id: string;
  readonly state: string;
  readonly effect_key: string | null;
  readonly effect_status: string | null;
  readonly state_payload: unknown;
}

export interface CompanyAgentProjectionSource {
  readonly code: string;
  readonly domain: string;
  readonly is_active: boolean;
}

export interface CompanyRunProjectionSource {
  readonly run_id: string;
  readonly domain: string | null;
  readonly occurred_at: string;
}

export interface CompanyActivityProjectionSource {
  readonly kind: 'RUN_RESPONSE' | 'RUN_STAGE' | 'APPROVAL_DECIDED';
  readonly run_id: string;
  readonly domain: string | null;
  readonly stage: string | null;
  readonly decision: string | null;
  readonly occurred_at: string;
}

export interface CompanyProjectionSources {
  readonly approvals: readonly CompanyApprovalProjectionSource[];
  readonly handoffs: readonly CompanyHandoffProjectionSource[];
  readonly connectors: readonly CompanyConnectorProjectionSource[];
  readonly owner_inputs: readonly CompanyOwnerInputProjectionSource[];
  readonly reconciliations: readonly CompanyReconciliationProjectionSource[];
  readonly agents: readonly CompanyAgentProjectionSource[];
  readonly runs_today: readonly CompanyRunProjectionSource[];
  readonly activity: readonly CompanyActivityProjectionSource[];
}

interface ApprovalRow extends QueryResultRow {
  id: string;
  run_id: string;
  skill_name: string | null;
  decision: string;
  created_at: Date | string;
  decided_at: Date | string | null;
}
interface HandoffRow extends QueryResultRow {
  id: string;
  run_id: string;
  conversation_id: string;
  status: string;
  created_at: Date | string;
}
interface ConnectorRow extends QueryResultRow {
  connector_id: string;
  status: string;
}
interface OwnerInputRow extends QueryResultRow {
  input_id: string;
  status: string;
}
interface ReconciliationRow extends QueryResultRow {
  run_id: string;
  state: string;
  effect_key: string | null;
  effect_status: string | null;
  state_payload: unknown;
}
interface AgentRow extends QueryResultRow {
  code: string;
  domain: string;
  is_active: boolean;
}
interface RunRow extends QueryResultRow {
  run_id: string;
  domain: string | null;
  occurred_at: Date | string;
}
interface ResponseActivityRow extends QueryResultRow {
  run_id: string;
  occurred_at: Date | string;
  domain: string | null;
}
interface StageActivityRow extends QueryResultRow {
  run_id: string;
  entered_at: Date | string;
  stage: string;
  domain: string | null;
}
interface ApprovalActivityRow extends QueryResultRow {
  run_id: string;
  decided_at: Date | string;
  decision: string;
  domain: string | null;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
function nullableIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function mapApproval(row: ApprovalRow): CompanyApprovalProjectionSource {
  return {
    id: row.id,
    run_id: row.run_id,
    skill_name: row.skill_name,
    decision: row.decision,
    created_at: iso(row.created_at),
    decided_at: nullableIso(row.decided_at),
  };
}
function mapHandoff(row: HandoffRow): CompanyHandoffProjectionSource {
  return {
    id: row.id,
    run_id: row.run_id,
    conversation_id: row.conversation_id,
    status: row.status,
    created_at: iso(row.created_at),
  };
}
function mapReconciliation(row: ReconciliationRow): CompanyReconciliationProjectionSource {
  return {
    run_id: row.run_id,
    state: row.state,
    effect_key: row.effect_key,
    effect_status: row.effect_status,
    state_payload: row.state_payload,
  };
}
function mapRun(row: RunRow): CompanyRunProjectionSource {
  return { run_id: row.run_id, domain: row.domain, occurred_at: iso(row.occurred_at) };
}

const SELECT_APPROVALS = `SELECT a.id::text AS id, a.run_id, ac.skill_name, a.decision,
    a.created_at, a.decided_at
  FROM ${APPROVALS} a
  LEFT JOIN ${ACTIONS} ac ON ac.tenant_id = a.tenant_id AND ac.id = a.action_id
  WHERE a.tenant_id = $1 AND a.decision = 'PENDING'
  ORDER BY a.created_at ASC, a.id ASC`;
const SELECT_HANDOFFS = `SELECT id::text AS id, run_id, conversation_id::text AS conversation_id,
    status, created_at
  FROM ${HANDOFFS}
  WHERE tenant_id = $1 AND status IN ('ENQUEUED', 'ASSIGNED')
  ORDER BY created_at ASC, id ASC`;
const SELECT_CONNECTORS = `SELECT connector_id, status
  FROM ${CONNECTORS}
  WHERE tenant_id = $1
  ORDER BY connector_id ASC`;
const SELECT_OWNER_INPUTS = `SELECT input_id, status
  FROM ${OWNER_INPUTS}
  WHERE tenant_id = $1 AND status = 'UNRESOLVED'
  ORDER BY input_id ASC`;
const SELECT_RECONCILIATIONS = `SELECT t.run_id, t.state::text AS state,
    r.effect_key, r.status AS effect_status, t.state_payload
  FROM ${TASKS} t
  LEFT JOIN ${RESERVATIONS} r ON r.tenant_id = t.tenant_id AND r.run_id = t.run_id
  WHERE t.tenant_id = $1
    AND (t.state = 'waiting' OR r.status IN ('FAILED', 'EXPIRED'))
  ORDER BY t.updated_at ASC, t.run_id ASC`;
const SELECT_AGENTS = `SELECT code, domain, is_active
  FROM ${AGENTS}
  WHERE tenant_id = $1
  ORDER BY code ASC`;
const SELECT_RUNS_TODAY = `SELECT DISTINCT t.run_id,
    NULLIF(t.state_payload->>'domain', '') AS domain,
    t.updated_at AS occurred_at
  FROM ${TASKS} t
  WHERE t.tenant_id = $1
    AND t.updated_at >= CURRENT_DATE
  ORDER BY t.updated_at DESC, t.run_id ASC`;
const SELECT_RESPONSE_ACTIVITY = `SELECT rr.run_id, rr.created_at AS occurred_at,
    NULLIF(t.state_payload->>'domain', '') AS domain
  FROM ${RESPONSES} rr
  LEFT JOIN ${TASKS} t ON t.tenant_id = rr.tenant_id AND t.run_id = rr.run_id
  WHERE rr.tenant_id = $1
  ORDER BY rr.created_at DESC, rr.run_id ASC`;
const SELECT_STAGE_ACTIVITY = `SELECT e.run_id, e.entered_at, e.stage::text AS stage,
    NULLIF(e.detail->>'domain', '') AS domain
  FROM ${STAGES} e
  WHERE e.tenant_id = $1
  ORDER BY e.entered_at DESC, e.run_id ASC, e.step_index DESC`;
const SELECT_APPROVAL_ACTIVITY = `SELECT a.run_id, a.decided_at, a.decision,
    NULLIF(split_part(ac.skill_name, '.', 2), '') AS domain
  FROM ${APPROVALS} a
  LEFT JOIN ${ACTIONS} ac ON ac.tenant_id = a.tenant_id AND ac.id = a.action_id
  WHERE a.tenant_id = $1 AND a.decision <> 'PENDING' AND a.decided_at IS NOT NULL
  ORDER BY a.decided_at DESC, a.id ASC`;

/** Read-only tenant projection source repository. Every method binds one tenant transaction. */
export class CompanyProjectionRepository {
  constructor(private readonly runInTenantTransaction: TenantTransactionRunner = withTenantContext) {}

  async getSources(tenant_id: string): Promise<CompanyProjectionSources> {
    assertTenantContext(tenant_id);
    return this.runInTenantTransaction(tenant_id, async (client) => {
      const [approvals, handoffs, connectors, owner_inputs, reconciliations, agents, runs_today,
        responses, stages, decisions] = await Promise.all([
        client.query<ApprovalRow>(SELECT_APPROVALS, [tenant_id]),
        client.query<HandoffRow>(SELECT_HANDOFFS, [tenant_id]),
        client.query<ConnectorRow>(SELECT_CONNECTORS, [tenant_id]),
        client.query<OwnerInputRow>(SELECT_OWNER_INPUTS, [tenant_id]),
        client.query<ReconciliationRow>(SELECT_RECONCILIATIONS, [tenant_id]),
        client.query<AgentRow>(SELECT_AGENTS, [tenant_id]),
        client.query<RunRow>(SELECT_RUNS_TODAY, [tenant_id]),
        client.query<ResponseActivityRow>(SELECT_RESPONSE_ACTIVITY, [tenant_id]),
        client.query<StageActivityRow>(SELECT_STAGE_ACTIVITY, [tenant_id]),
        client.query<ApprovalActivityRow>(SELECT_APPROVAL_ACTIVITY, [tenant_id]),
      ]);
      const activity: CompanyActivityProjectionSource[] = [
        ...responses.rows.map((row) => ({
          kind: 'RUN_RESPONSE' as const,
          run_id: row.run_id,
          domain: row.domain,
          stage: null,
          decision: null,
          occurred_at: iso(row.occurred_at),
        })),
        ...stages.rows.map((row) => ({
          kind: 'RUN_STAGE' as const,
          run_id: row.run_id,
          domain: row.domain,
          stage: row.stage,
          decision: null,
          occurred_at: iso(row.entered_at),
        })),
        ...decisions.rows.map((row) => ({
          kind: 'APPROVAL_DECIDED' as const,
          run_id: row.run_id,
          domain: row.domain,
          stage: null,
          decision: row.decision,
          occurred_at: iso(row.decided_at),
        })),
      ].sort((left, right) => right.occurred_at.localeCompare(left.occurred_at));
      return {
        approvals: approvals.rows.map(mapApproval),
        handoffs: handoffs.rows.map(mapHandoff),
        connectors: connectors.rows.map((row) => ({ connector_id: row.connector_id, status: row.status })),
        owner_inputs: owner_inputs.rows.map((row) => ({ input_id: row.input_id, status: row.status })),
        reconciliations: reconciliations.rows.map(mapReconciliation),
        agents: agents.rows.map((row) => ({ code: row.code, domain: row.domain, is_active: row.is_active })),
        runs_today: runs_today.rows.map(mapRun),
        activity,
      };
    });
  }

  async snapshot(tenant_id: string): Promise<CompanyProjectionSources> {
    return this.getSources(tenant_id);
  }
}

export { CompanyProjectionRepository as CompanyProjectionsRepository };
