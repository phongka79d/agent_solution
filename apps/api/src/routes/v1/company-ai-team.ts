import type { FastifyInstance } from 'fastify';

import type { AgentActivationDomain, AgentActivationSnapshot, KnowledgeRepository } from '@agentos/database';
import { isPristineConnectorBinding } from '@agentos/database';

import type { CredentialStore } from '../../gateway/principal.js';
import { authenticate, requireOperator } from '../../gateway/principal.js';
import { correlationIdOf, fail, replyFailure } from '../../gateway/http.js';
import type { GatewayRuntime } from '../../gateway/ports.js';
import { mapAiTeam, type AiTeamAgent } from '../../projections/ai-team.js';
import { knowledgeAvailable } from '../../runtime/knowledge-availability.js';
import {
  companyAiTeamDomainRouteSchema,
  registerOpenApiSchemas,
} from './openapi-schemas.js';

interface DomainParams { readonly domain: string }
interface Prerequisite {
  readonly reason_key: string;
  readonly cta: { readonly href: string; readonly label_key: string };
}

const DOMAIN_SET: readonly AgentActivationDomain[] = ['sales', 'care', 'marketing'];
const ACTION_PATHS = [
  { path: 'activate', action: 'ACTIVATE' },
  { path: 'pause', action: 'PAUSE' },
  { path: 'resume', action: 'RESUME' },
] as const;

function parseDomain(value: string): AgentActivationDomain {
  if (DOMAIN_SET.includes(value as AgentActivationDomain)) return value as AgentActivationDomain;
  fail('NOT_FOUND', 'AI Team domain was not found');
}

function agentActivationStatus(state: AgentActivationSnapshot): 'NOT_ACTIVATED' | 'ACTIVE' | 'PAUSED' {
  if (state.agents.length > 0 && state.agents.every((agent) => agent.activation_status === 'ACTIVE')
    && state.capability_status === 'ENABLED') return 'ACTIVE';
  if (state.agents.length > 0 && state.agents.every((agent) => agent.activation_status === 'PAUSED')
    && state.capability_status === 'DISABLED') return 'PAUSED';
  return 'NOT_ACTIVATED';
}

function projectedAgent(state: AgentActivationSnapshot): AiTeamAgent {
  const projected = mapAiTeam({
    agents: state.agents,
    module_capabilities: [{ capability_id: state.domain, status: state.capability_status ?? 'UNCONFIGURED' }],
    ...(state.domain === 'marketing' ? { provider: { configured: state.llm_verified } } : {}),
  }).find((agent) => agent.domain === state.domain);
  if (projected === undefined) fail('INTERNAL_ERROR', 'AI Team projection is unavailable');
  return projected;
}

async function unmetPrerequisites(
  state: AgentActivationSnapshot,
  runtime: GatewayRuntime,
  knowledgeRepository: Pick<KnowledgeRepository, 'listAvailable'> | undefined,
): Promise<readonly Prerequisite[]> {
  const unmet: Prerequisite[] = [];
  if (state.domain === 'sales' && !state.erp_bound) {
    const integrations = runtime.companyIntegrations;
    const demoMock = state.data_class === 'DEMO' && integrations !== undefined
      && isPristineConnectorBinding(await integrations.getBinding(state.tenant_id, 'API-001'))
      && await integrations.demoErpEligibleForTenant?.(state.tenant_id) === true;
    if (!demoMock) {
      unmet.push({ reason_key: 'ERP_NOT_CONNECTED', cta: { href: '/integrations', label_key: 'company.ai_team.connect_erp' } });
    }
  }
  if (state.domain === 'care' && !await knowledgeAvailable(knowledgeRepository, state.tenant_id, 'customer-care')) {
    unmet.push({ reason_key: 'KNOWLEDGE_NOT_APPROVED', cta: { href: '/knowledge?namespace=customer-care', label_key: 'company.ai_team.approve_faq' } });
  }
  if (state.domain === 'marketing') {
    if (!state.llm_verified) {
      unmet.push({ reason_key: 'LLM_NOT_VERIFIED', cta: { href: '/settings/llm', label_key: 'company.ai_team.verify_llm' } });
    }
    if (!await knowledgeAvailable(knowledgeRepository, state.tenant_id, 'brand')) {
      unmet.push({ reason_key: 'BRAND_NOT_APPROVED', cta: { href: '/knowledge?namespace=brand', label_key: 'company.ai_team.approve_brand' } });
    }
  }
  return unmet;
}

function activationPort(runtime: GatewayRuntime) {
  if (runtime.companyAiTeam === undefined) fail('CAPABILITY_UNAVAILABLE', 'AI Team activation storage is unavailable');
  return runtime.companyAiTeam;
}

export function registerCompanyAiTeamRoutes(
  app: FastifyInstance,
  deps: {
    readonly runtime: GatewayRuntime;
    readonly credentials: CredentialStore;
    readonly knowledge?: Pick<KnowledgeRepository, 'listAvailable'>;
  },
): void {
  registerOpenApiSchemas(app);
  const preHandler = authenticate(deps);
  const knowledgeRepository = deps.knowledge;
  app.get<{ Params: DomainParams }>('/company/ai-team/:domain', { preHandler, schema: companyAiTeamDomainRouteSchema }, async (request, reply) => {
    const runtime = deps.runtime;
    try {
      const principal = requireOperator(request, 'telemetry:read');
      const domain = parseDomain(request.params.domain);
      const state = await activationPort(runtime).getState(principal.tenant_id, domain);
      if (state === null) fail('NOT_FOUND', 'AI Team domain was not found');
      const unmet = await unmetPrerequisites(state, runtime, knowledgeRepository);
      return reply.code(200).send({
        agent: projectedAgent(state),
        activation_status: agentActivationStatus(state),
        unmet,
      });
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, runtime));
    }
  });

  for (const { path, action } of ACTION_PATHS) {
    app.post<{ Params: DomainParams }>(`/company/ai-team/:domain/${path}`, { preHandler, schema: companyAiTeamDomainRouteSchema }, async (request, reply) => {
      const runtime = deps.runtime;
      try {
        const principal = requireOperator(request, 'agents:manage');
        if (principal.operator_id === undefined || principal.operator_id.length === 0) {
          fail('AUTHENTICATION_FAILED', 'operator identity is unavailable');
        }
        const domain = parseDomain(request.params.domain);
        const port = activationPort(runtime);
        const current = await port.getState(principal.tenant_id, domain);
        if (current === null) fail('NOT_FOUND', 'AI Team domain was not found');
        const unmet = action === 'PAUSE'
          ? []
          : await unmetPrerequisites(current, runtime, knowledgeRepository);
        if (unmet.length > 0) {
          fail('PREREQUISITES_UNMET', 'AI Team activation prerequisites are not met', { unmet });
        }
        const state = await port.transition({
          tenant_id: principal.tenant_id,
          domain,
          action,
          actor: {
            actor_kind: principal.kind,
            actor_id: principal.operator_id,
            correlation_id: correlationIdOf(request, runtime),
          },
        });
        return reply.code(200).send({
          agent: projectedAgent(state),
          activation_status: agentActivationStatus(state),
          unmet: await unmetPrerequisites(state, runtime, knowledgeRepository),
        });
      } catch (error) {
        return replyFailure(reply, error, correlationIdOf(request, runtime));
      }
    });
  }
}
