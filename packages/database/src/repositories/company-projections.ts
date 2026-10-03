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
const AUTONOMY_POLICIES = 'agentos.autonomy_policies';

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

/** A draft-gated MINIMUM policy or durable waiting run: "Bản nháp chờ bạn duyệt". */
export interface CompanyParkedDraftProjectionSource {
  readonly skill_id: string;
  readonly policy_version: string;
  /** Present when the observed source is a waiting task rather than an autonomy policy. */
  readonly run_id?: string;
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
  readonly activation_status?: 'NOT_ACTIVATED' | 'ACTIVE' | 'PAUSED';
}

export interface CompanyRunProjectionSource {
  readonly run_id: string;
  readonly domain: string | null;
  readonly state: string;
  readonly occurred_at: string;
}

/** One conversation observed today; drives the Overview "Hôm nay" conversation metric. */
export interface CompanyConversationProjectionSource {
  readonly conversation_id: string;
  readonly state: string;
  readonly occurred_at: string;
}

/** One campaign updated today; drives the Overview campaigns-by-state metric. */
export interface CompanyCampaignProjectionSource {
  readonly state: string;
  readonly updated_at: string;
}

export interface CompanyActivityProjectionSource {
  readonly kind: 'RUN_OUTCOME';
  readonly run_id: string;
  readonly domain: string | null;
  readonly state: string;
  readonly occurred_at: string;
}

export interface CompanyActivityPageOptions {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface CompanyProjectionSources {
  readonly approvals: readonly CompanyApprovalProjectionSource[];
  readonly handoffs: readonly CompanyHandoffProjectionSource[];
  readonly connectors: readonly CompanyConnectorProjectionSource[];
  readonly owner_inputs: readonly CompanyOwnerInputProjectionSource[];
  readonly reconciliations: readonly CompanyReconciliationProjectionSource[];
  readonly parked_drafts: readonly CompanyParkedDraftProjectionSource[];
  readonly agents: readonly CompanyAgentProjectionSource[];
  readonly runs_today: readonly CompanyRunProjectionSource[];
  readonly conversations_today: readonly CompanyConversationProjectionSource[];
  readonly campaigns_today: readonly CompanyCampaignProjectionSource[];
  readonly activity: readonly CompanyActivityProjectionSource[];
  readonly activity_next_cursor?: string | null;
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
interface ParkedDraftRow extends QueryResultRow {
  skill_id: string;
  policy_version: string;
  run_id: string | null;
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
  activation_status: NonNullable<CompanyAgentProjectionSource['activation_status']>;
}
interface RunRow extends QueryResultRow {
  run_id: string;
  domain: string | null;
  state: string;
  occurred_at: Date | string;
}
interface ConversationRow extends QueryResultRow {
  conversation_id: string;
  state: string;
  occurred_at: Date | string;
}
interface CampaignRow extends QueryResultRow {
  state: string;
  updated_at: Date | string;
}
interface ActivityRow extends QueryResultRow {
  run_id: string;
  domain: string | null;
  state: string;
  occurred_at: Date | string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
function nullableIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function decodeActivityCursor(cursor: string | undefined): { readonly occurred_at: string | null; readonly run_id: string | null } {
  if (cursor === undefined || cursor.length === 0) return { occurred_at: null, run_id: null };
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const separator = decoded.indexOf('\n');
    if (separator < 0) return { occurred_at: null, run_id: null };
    const occurred_at = new Date(decoded.slice(0, separator));
    const run_id = decoded.slice(separator + 1);
    if (!Number.isFinite(occurred_at.getTime()) || run_id.length === 0) return { occurred_at: null, run_id: null };
    return { occurred_at: occurred_at.toISOString(), run_id };
  } catch {
    return { occurred_at: null, run_id: null };
  }
}

function encodeActivityCursor(occurred_at: string, run_id: string): string {
  return Buffer.from(`${occurred_at}\n${run_id}`, 'utf8').toString('base64url');
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
  return { run_id: row.run_id, domain: row.domain, state: row.state, occurred_at: iso(row.occurred_at) };
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
const SELECT_AGENTS = `SELECT code, domain, is_active, activation_status
  FROM ${AGENTS}
  WHERE tenant_id = $1
  ORDER BY code ASC`;
// Absent autonomy policies also park draft-gated skills. parkTask persists the pending action
// directly in the waiting task checkpoint, so policy rows are not a prerequisite for attention.
// Prefer the policy source when both exist, but publish only one item per draft-gated skill.
const SELECT_PARKED_DRAFTS = `SELECT DISTINCT ON (skill_id) skill_id, policy_version, run_id
  FROM (
    SELECT skill_id, policy_version, NULL::text AS run_id, 0 AS source_priority
    FROM ${AUTONOMY_POLICIES}
    WHERE tenant_id = $1 AND state = 'MINIMUM'
      AND skill_id IN ('skill.mkt.generate_content', 'skill.mkt.segment_audience')
    UNION ALL
    SELECT t.state_payload->'pending_action'->>'skill_id' AS skill_id,
      ''::text AS policy_version, t.run_id, 1 AS source_priority
    FROM ${TASKS} t
    WHERE t.tenant_id = $1 AND t.state = 'waiting'
      AND t.state_payload->'pending_action'->>'skill_id'
        IN ('skill.mkt.generate_content', 'skill.mkt.segment_audience')
  ) parked
  ORDER BY skill_id ASC, source_priority ASC, policy_version ASC, run_id ASC`;
const SELECT_RUNS_TODAY = `SELECT DISTINCT t.run_id,
    t.domain AS domain,
    t.state::text AS state,
    t.updated_at AS occurred_at
  FROM ${TASKS} t
  WHERE t.tenant_id = $1
    AND t.updated_at >= CURRENT_DATE
  ORDER BY t.updated_at DESC, t.run_id ASC`;
const SELECT_CONVERSATIONS_TODAY = `SELECT cv.id::text AS conversation_id,
    cv.state,
    COALESCE(cv.last_message_at, cv.created_at) AS occurred_at
  FROM agentos.conversations cv
  WHERE cv.tenant_id = $1
    AND COALESCE(cv.last_message_at, cv.created_at) >= CURRENT_DATE
  ORDER BY occurred_at DESC, cv.id ASC`;
const SELECT_CAMPAIGNS_TODAY = `SELECT c.status AS state, c.updated_at
  FROM agentos.campaigns c
  WHERE c.tenant_id = $1
    AND c.updated_at >= CURRENT_DATE
  ORDER BY c.updated_at DESC, c.id ASC`;
// The generated domain column also resolves admission signals and completed plan checkpoints.
const SELECT_ACTIVITY = `SELECT t.run_id, t.domain AS domain,
    t.state::text AS state, t.updated_at AS occurred_at
  FROM ${TASKS} t
  WHERE t.tenant_id = $1
    AND t.state IN ('completed', 'failed', 'stopped', 'waiting', 'awaiting_human')
    AND ($2::timestamptz IS NULL OR t.updated_at < $2::timestamptz
      OR (t.updated_at = $2::timestamptz AND t.run_id < $3))
  ORDER BY t.updated_at DESC, t.run_id DESC
  LIMIT $4`;

/** Read-only tenant projection source repository. Every method binds one tenant transaction. */
export class CompanyProjectionRepository {
  constructor(private readonly runInTenantTransaction: TenantTransactionRunner = withTenantContext) {}

  async getSources(tenant_id: string, activityPage: CompanyActivityPageOptions = {}): Promise<CompanyProjectionSources> {
    assertTenantContext(tenant_id);
    const requestedLimit = activityPage.limit ?? 50;
    const limit = Math.max(1, Math.min(200, Math.trunc(Number.isFinite(requestedLimit) ? requestedLimit : 50)));
    const cursor = decodeActivityCursor(activityPage.cursor);
    return this.runInTenantTransaction(tenant_id, async (client) => {
      const [approvals, handoffs, connectors, owner_inputs, reconciliations, agents, runs_today,
        conversations_today, campaigns_today, activityRows] = await Promise.all([
        client.query<ApprovalRow>(SELECT_APPROVALS, [tenant_id]),
        client.query<HandoffRow>(SELECT_HANDOFFS, [tenant_id]),
        client.query<ConnectorRow>(SELECT_CONNECTORS, [tenant_id]),
        client.query<OwnerInputRow>(SELECT_OWNER_INPUTS, [tenant_id]),
        client.query<ReconciliationRow>(SELECT_RECONCILIATIONS, [tenant_id]),
        client.query<AgentRow>(SELECT_AGENTS, [tenant_id]),
        client.query<RunRow>(SELECT_RUNS_TODAY, [tenant_id]),
        client.query<ConversationRow>(SELECT_CONVERSATIONS_TODAY, [tenant_id]),
        client.query<CampaignRow>(SELECT_CAMPAIGNS_TODAY, [tenant_id]),
        client.query<ActivityRow>(SELECT_ACTIVITY, [tenant_id, cursor.occurred_at, cursor.run_id, limit + 1]),
      ]);
      const parkedDrafts = await client.query<ParkedDraftRow>(SELECT_PARKED_DRAFTS, [tenant_id]);
      const hasMoreActivity = activityRows.rows.length > limit;
      const selectedActivity = activityRows.rows.slice(0, limit);
      const lastActivity = selectedActivity.at(-1);
      const activity_next_cursor = hasMoreActivity && lastActivity !== undefined
        ? encodeActivityCursor(iso(lastActivity.occurred_at), lastActivity.run_id)
        : null;
      const activity: CompanyActivityProjectionSource[] = selectedActivity.map((row) => ({
        kind: 'RUN_OUTCOME',
        run_id: row.run_id,
        domain: row.domain,
        state: row.state,
        occurred_at: iso(row.occurred_at),
      }));
      return {
        approvals: approvals.rows.map(mapApproval),
        handoffs: handoffs.rows.map(mapHandoff),
        connectors: connectors.rows.map((row) => ({ connector_id: row.connector_id, status: row.status })),
        owner_inputs: owner_inputs.rows.map((row) => ({ input_id: row.input_id, status: row.status })),
        reconciliations: reconciliations.rows.map(mapReconciliation),
        parked_drafts: parkedDrafts.rows.map((row) => ({
          skill_id: row.skill_id,
          policy_version: row.policy_version,
          ...(row.run_id == null ? {} : { run_id: row.run_id }),
        })),
        agents: agents.rows.map((row) => ({
          code: row.code,
          domain: row.domain,
          is_active: row.is_active,
          activation_status: row.activation_status,
        })),
        runs_today: runs_today.rows.map(mapRun),
        conversations_today: conversations_today.rows.map((row) => ({
          conversation_id: row.conversation_id,
          state: row.state,
          occurred_at: iso(row.occurred_at),
        })),
        campaigns_today: campaigns_today.rows.map((row) => ({ state: row.state, updated_at: iso(row.updated_at) })),
        activity,
        activity_next_cursor,
      };
    });
  }

  async snapshot(tenant_id: string): Promise<CompanyProjectionSources> {
    return this.getSources(tenant_id);
  }
}

export { CompanyProjectionRepository as CompanyProjectionsRepository };
