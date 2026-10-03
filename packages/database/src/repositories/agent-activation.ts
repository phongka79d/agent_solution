import type { QueryResultRow } from 'pg';

import { withTenantContext } from '../rls.js';
import { appendConfigAudit } from './platform-audit.js';
import type { PlatformTransactionRunner } from './platform-directory.js';
import { withPlatformRole } from './platform-directory.js';
import type { TenantTransactionRunner } from './effect-reservations.js';

const TENANTS = 'agentos.tenants';
const CAPABILITIES = 'agentos.tenant_capabilities';
const AGENTS = 'agentos.agents';
const CONNECTORS = 'agentos.connector_configurations';
const TENANT_LLM = 'agentos.tenant_llm_configs';
const LLM_PROBES = 'agentos.llm_probe_results';
const PLATFORM_LLM = 'agentos.platform_llm_providers';
const ACTIVATION_EVENTS = 'agentos.agent_activation_events';

export type AgentActivationDomain = 'sales' | 'care' | 'marketing';
export type AgentActivationAction = 'ACTIVATE' | 'PAUSE' | 'RESUME';
export type AgentActivationStatus = 'NOT_ACTIVATED' | 'ACTIVE' | 'PAUSED';

export interface AgentActivationActor {
  readonly actor_kind: string;
  readonly actor_id: string;
  readonly correlation_id: string;
}

export interface AgentActivationAgent {
  readonly code: string;
  readonly domain: string;
  readonly is_active: boolean;
  readonly activation_status: AgentActivationStatus;
}

export interface AgentActivationSnapshot {
  readonly tenant_id: string;
  readonly domain: AgentActivationDomain;
  readonly data_class: 'PRODUCTION' | 'DEMO' | 'TEST';
  readonly capability_status: string | null;
  readonly agents: readonly AgentActivationAgent[];
  readonly erp_bound: boolean;
  readonly llm_verified: boolean;
}

interface TenantStateRow extends QueryResultRow {
  readonly data_class: AgentActivationSnapshot['data_class'];
  readonly capability_status: string | null;
  readonly erp_bound: boolean;
}

interface AgentRow extends QueryResultRow {
  readonly code: string;
  readonly domain: string;
  readonly is_active: boolean;
  readonly activation_status: AgentActivationStatus;
}

interface ConfigRow extends QueryResultRow {
  readonly mode: 'INHERIT' | 'CUSTOM';
  readonly provider_id: string | null;
  readonly latest_outcome: 'PASS' | 'FAIL' | null;
}

interface PlatformProbeRow extends QueryResultRow {
  readonly latest_outcome: 'PASS' | 'FAIL' | null;
}

export interface AgentActivationRepositoryOptions {
  readonly tenantTransaction?: TenantTransactionRunner;
  readonly platformTransaction?: PlatformTransactionRunner;
}

function requireText(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) {
    throw new TypeError(`AGENT_ACTIVATION_${field.toUpperCase()}_INVALID`);
  }
}

function assertDomain(domain: AgentActivationDomain): void {
  if (!['sales', 'care', 'marketing'].includes(domain)) throw new TypeError('AGENT_ACTIVATION_DOMAIN_INVALID');
}

function databaseDomain(domain: AgentActivationDomain): readonly string[] {
  return domain === 'care' ? ['support', 'care'] : [domain];
}

export class AgentActivationRepository {
  private readonly tenantTransaction: TenantTransactionRunner;
  private readonly platformTransaction: PlatformTransactionRunner;

  constructor(options: AgentActivationRepositoryOptions = {}) {
    this.tenantTransaction = options.tenantTransaction ?? withTenantContext;
    this.platformTransaction = options.platformTransaction ?? withPlatformRole;
  }

  async getState(tenant_id: string, domain: AgentActivationDomain): Promise<AgentActivationSnapshot | null> {
    requireText(tenant_id, 'tenant_id');
    assertDomain(domain);
    const { tenant: base, agents } = await this.tenantTransaction(tenant_id, async (client) => {
      const [tenant, agentRows] = await Promise.all([
        client.query<TenantStateRow>(
          `SELECT t.data_class::text AS data_class, c.status AS capability_status,
                  EXISTS (
                    SELECT 1 FROM ${CONNECTORS} AS connector
                     WHERE connector.tenant_id = t.tenant_id
                       AND connector.connector_id = 'API-001' AND connector.status = 'BOUND'
                  ) AS erp_bound
             FROM ${TENANTS} AS t
             LEFT JOIN ${CAPABILITIES} AS c
               ON c.tenant_id = t.tenant_id AND c.capability_id = $2
            WHERE t.tenant_id = $1`,
          [tenant_id, domain],
        ),
        client.query<AgentRow>(
          `SELECT code, domain, is_active, activation_status
             FROM ${AGENTS}
            WHERE tenant_id = $1 AND domain = ANY($2::text[])
            ORDER BY code`,
          [tenant_id, databaseDomain(domain)],
        ),
      ]);
      return { tenant: tenant.rows[0] ?? null, agents: agentRows.rows };
    });
    if (base === null) return null;
    const llm_verified = domain === 'marketing' ? await this.effectiveLlmVerified(tenant_id) : false;
    return {
      tenant_id,
      domain,
      data_class: base.data_class,
      capability_status: base.capability_status,
      agents: agents.map((agent) => ({
        code: agent.code,
        domain: agent.domain,
        is_active: agent.is_active,
        activation_status: agent.activation_status,
      })),
      erp_bound: base.erp_bound,
      llm_verified,
    };
  }

  async transition(input: {
    readonly tenant_id: string;
    readonly domain: AgentActivationDomain;
    readonly action: AgentActivationAction;
    readonly actor: AgentActivationActor;
  }): Promise<AgentActivationSnapshot> {
    requireText(input.tenant_id, 'tenant_id');
    assertDomain(input.domain);
    requireText(input.actor.actor_kind, 'actor_kind');
    requireText(input.actor.actor_id, 'actor_id');
    requireText(input.actor.correlation_id, 'correlation_id');
    if (!['ACTIVATE', 'PAUSE', 'RESUME'].includes(input.action)) throw new TypeError('AGENT_ACTIVATION_ACTION_INVALID');

    await this.tenantTransaction(input.tenant_id, async (client) => {
      const capability = await client.query<{ readonly status: string }>(
        `SELECT status FROM ${CAPABILITIES}
          WHERE tenant_id = $1 AND capability_id = $2 FOR UPDATE`,
        [input.tenant_id, input.domain],
      );
      const beforeCapability = capability.rows[0];
      if (beforeCapability === undefined) throw new Error('AGENT_ACTIVATION_CAPABILITY_NOT_FOUND');
      const agents = await client.query<AgentRow>(
        `SELECT code, domain, is_active, activation_status FROM ${AGENTS}
          WHERE tenant_id = $1 AND domain = ANY($2::text[]) ORDER BY code FOR UPDATE`,
        [input.tenant_id, databaseDomain(input.domain)],
      );
      if (agents.rows.length === 0) throw new Error('AGENT_ACTIVATION_AGENTS_NOT_FOUND');

      const toCapability = input.action === 'PAUSE' ? 'DISABLED' : 'ENABLED';
      const toAgentStatus: AgentActivationStatus = input.action === 'PAUSE' ? 'PAUSED' : 'ACTIVE';
      await client.query(
        `UPDATE ${CAPABILITIES} SET status = $3 WHERE tenant_id = $1 AND capability_id = $2`,
        [input.tenant_id, input.domain, toCapability],
      );
      await client.query(
        `UPDATE ${AGENTS}
            SET activation_status = $3, is_active = ($3 = 'ACTIVE')
          WHERE tenant_id = $1 AND domain = ANY($2::text[])`,
        [input.tenant_id, databaseDomain(input.domain), toAgentStatus],
      );
      const fromAgentStatuses = Object.fromEntries(agents.rows.map((agent) => [agent.code, agent.activation_status]));
      await client.query(
        `INSERT INTO ${ACTIVATION_EVENTS}
          (tenant_id, domain, action, actor_kind, actor_id, from_capability_status,
           to_capability_status, from_agent_statuses, to_agent_status, correlation_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
        [input.tenant_id, input.domain, input.action, input.actor.actor_kind, input.actor.actor_id,
          beforeCapability.status, toCapability, JSON.stringify(fromAgentStatuses), toAgentStatus,
          input.actor.correlation_id],
      );
      await appendConfigAudit(client, {
        actor_kind: input.actor.actor_kind,
        actor_id: input.actor.actor_id,
        scope: 'COMPANY',
        action: `agent.${input.action.toLowerCase()}`,
        target_tenant: input.tenant_id,
        target: input.domain,
        outcome: 'ACCEPTED',
        reason: null,
        before: { capability_status: beforeCapability.status, agents: fromAgentStatuses },
        after: {
          capability_status: toCapability,
          agents: Object.fromEntries(agents.rows.map((agent) => [agent.code, toAgentStatus])),
        },
        correlation_id: input.actor.correlation_id,
      });
    });

    const state = await this.getState(input.tenant_id, input.domain);
    if (state === null) throw new Error('AGENT_ACTIVATION_TENANT_NOT_FOUND');
    return state;
  }

  private async effectiveLlmVerified(tenant_id: string): Promise<boolean> {
    const config = await this.tenantTransaction(tenant_id, async (client) => {
      const result = await client.query<ConfigRow>(
        `SELECT config.mode, config.provider_id,
                CASE WHEN config.mode = 'CUSTOM' THEN (
                  SELECT probe.outcome FROM ${LLM_PROBES} AS probe
                   WHERE probe.scope = 'TENANT' AND probe.tenant_id = config.tenant_id
                     AND probe.provider_id = config.provider_id
                   ORDER BY probe.tested_at DESC, probe.probe_id DESC LIMIT 1
                ) ELSE NULL END AS latest_outcome
           FROM ${TENANT_LLM} AS config WHERE config.tenant_id = $1`,
        [tenant_id],
      );
      return result.rows[0] ?? null;
    });
    if (config?.mode === 'CUSTOM') return config.latest_outcome === 'PASS';
    const platform = await this.platformTransaction(async (client) => {
      const result = await client.query<PlatformProbeRow>(
        `SELECT (
           SELECT probe.outcome FROM ${LLM_PROBES} AS probe
            WHERE probe.scope = 'PLATFORM' AND probe.tenant_id IS NULL
              AND probe.provider_id = provider.provider_id
            ORDER BY probe.tested_at DESC, probe.probe_id DESC LIMIT 1
         ) AS latest_outcome
           FROM ${PLATFORM_LLM} AS provider
          WHERE provider.is_default = TRUE
          LIMIT 1`,
      );
      return result.rows[0] ?? null;
    });
    return platform?.latest_outcome === 'PASS';
  }
}
