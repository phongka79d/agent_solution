
import {
  CareHandoffRepository,
  ConversationRepository,
  ServiceCaseRepository,
  withTenantContext,
} from '@agentos/database';
import type { SkillToolInvocation, SkillToolPort } from '@agentos/skills';


import { KnowledgeStore } from '../../shared/knowledge-store.js';
import { handleCaseManagement } from './case-handler.js';
import { CareSkillToolError } from './errors.js';
import { handleFaqEngine } from './faq-handler.js';
import { handleHandoff } from './handoff-handler.js';
import { handleOrderConnector } from './order-handler.js';
import type { CareSkillOptions, VerifiedCustomerIdentity } from './types.js';

export { CareSkillToolError };

const ASSIGNABLE_AUTHORITIES: Readonly<Record<string, true>> = Object.freeze({
  'AUTH-0': true,
  'AUTH-1': true,
  'AUTH-2': true,
  'AUTH-3': true,
});

async function defaultFindVerifiedIdentity(
  tenantId: string,
  id: string,
): Promise<VerifiedCustomerIdentity | null> {
  return withTenantContext(tenantId, async (client) => {
    const result = await client.query(
      `SELECT id, customer_id, verified_at FROM agentos.customer_identities
        WHERE tenant_id = $1 AND id = $2 AND verified_at IS NOT NULL`,
      [tenantId, id],
    );
    const row = result.rows[0] as VerifiedCustomerIdentity | undefined;
    return row ?? null;
  });
}

/**
 * Creates the unified SkillToolPort for Customer Care.
 * Handles SecondBrain.FAQEngine and API-001.OrderConnector.
 */
export function createCareSkillToolPort(options: CareSkillOptions): SkillToolPort {
  const knowledgeStore = options.knowledge_store ?? new KnowledgeStore();
  const caseRepository = options.case_repository ?? new ServiceCaseRepository();
  const conversationRepository = options.conversation_repository ?? new ConversationRepository();
  const handoffRepository = options.handoff_repository ?? new CareHandoffRepository();


  return {
    async invoke<TInput, TOutput>(invocation: SkillToolInvocation<TInput>): Promise<TOutput> {
      if (!invocation.context || !Object.hasOwn(ASSIGNABLE_AUTHORITIES, invocation.context.granted_authority)) {
        throw new CareSkillToolError(
          'INVALID_CLEARANCE',
          `granted_authority '${invocation.context?.granted_authority}' is not an assignable authority; verdict-only values must be refused`,
        );
      }

      const binding = invocation.tool_binding;
      if (binding === 'SecondBrain.FAQEngine') {
        return handleFaqEngine(invocation as SkillToolInvocation<unknown>, knowledgeStore);
      }

      if (binding === 'Orchestrator.HandoffBus') {
        return handleHandoff(invocation, handoffRepository, conversationRepository);
      }

      if (binding === 'PostgreSQL.CaseManagementStore') {
        return handleCaseManagement(invocation, caseRepository, options.case_sla_target_hours);
      }
      if (binding === 'Customer360.AnalyticsLayer') {
        if (!options.analytics_layer) {
          throw new CareSkillToolError(
            'AUTHORITATIVE_SOURCE_UNAVAILABLE',
            'Customer360.AnalyticsLayer is not bound; declared refusal',
          );
        }

        const input = invocation.input as {
          readonly tenant_id: string;
          readonly customer_id: string;
          readonly recent_message_snippets?: string[];
        };
        return (await options.analytics_layer.analyzeChurnRisk(input, invocation.context)) as TOutput;
      }

      if (binding === 'API-001.OrderConnector') {
        if (!options.erp_read) {
          throw new CareSkillToolError(
            'AUTHORITATIVE_SOURCE_UNAVAILABLE',
            'API-001 connector is not bound; declared refusal',
          );
        }

        return handleOrderConnector(
          invocation,
          options.erp_read,
          options.find_verified_identity ?? defaultFindVerifiedIdentity,
        );
      }

      throw new CareSkillToolError(
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        `No tool port binding exists for ${binding}`,
      );
    },
  };
}
