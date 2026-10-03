import {
  approvalPayloadDigest,
  computeEffectKey,
  evaluateAuthorityVerdict,
} from '@agentos/core-engine';
import {
  createPlatformSkills,
  createSkillRegistry,
  createSkillRuntimeEngine,
  SkillError,
  type PlatformSkillEnablement,
} from '@agentos/skills';

import { createSkillAdapterDispatcher } from '../../shared/skill-dispatcher.js';
import { createMarketingSkillToolPort } from './tool-port.js';
import {
  type MarketingSkillOptions,
  type MarketingSkillServices,
} from './types.js';

export type {
  AssignableAuthority,
  ChannelSpecificPayload,
  ExecutionReceipt,
  IAdapterDispatcher,
  InputMktAnalyzeSignal,
  InputMktAuditBrand,
  InputMktCheckConsent,
  InputMktDispatchCampaign,
  InputMktEvaluateAttribution,
  InputMktGenerateContent,
  InputMktSegmentAudience,
  MarketingAnalyticsPort,
  MarketingAudienceConsentPort,
  MarketingBrandGuardPort,
  MarketingCommunicationPort,
  MarketingConsentPort,
  MarketingContentEnginePort,
  MarketingCustomer360Port,
  MarketingKnowledgePort,
  MarketingReconcileFn,
  MarketingReconcileInput,
  MarketingSignalReadPort,
  MarketingSkillOptions,
  MarketingSkillServices,
  MarketingSkillToolPortOptions,
  OutputMktAnalyzeSignal,
  OutputMktAuditBrand,
  OutputMktCheckConsent,
  OutputMktDispatchCampaign,
  OutputMktEvaluateAttribution,
  OutputMktGenerateContent,
  OutputMktSegmentAudience,
  PlatformSkillEnablement,
  SkillRegistry,
  SkillToolPort,
} from './types.js';

export { MarketingSkillToolError } from './tool-port.js';

export { createMarketingSkillToolPort };

/**
 * Default explicit enablement for all 7 canonical Marketing skill rows.
 */
export const DEFAULT_MARKETING_SKILL_ENABLEMENT: PlatformSkillEnablement = Object.freeze({
  enabled_skill_ids: Object.freeze([
    'skill.mkt.analyze_market_signal',
    'skill.mkt.segment_audience',
    'skill.mkt.check_consent',
    'skill.mkt.generate_content',
    'skill.mkt.audit_brand_compliance',
    'skill.mkt.dispatch_campaign',
    'skill.mkt.evaluate_attribution',
  ]),
});

/**
 * Assembles canonical Marketing skill services:
 * - registers all 7 canonical rows from packages/skills/src/platform/mkt
 * - applies explicit skill enablement
 * - builds SkillRuntimeEngine with canonical effect key, request fingerprint, and authority evaluator
 * - builds adapter dispatcher that forwards approval_id and approval_payload_digest unchanged
 * - lists unbound connectors when ports are not configured (failing closed); knowledge never substitutes
 *   for the Core.LLMContentEngine provider
 */
export function createMarketingSkillServices(
  options: MarketingSkillOptions,
): MarketingSkillServices {
  const tool_port = createMarketingSkillToolPort(options);
  const clock = options.now ?? (() => new Date());
  const registry = createSkillRegistry();

  const enablement = options.skill_enablement ?? DEFAULT_MARKETING_SKILL_ENABLEMENT;
  const enabledSet = new Set(enablement.enabled_skill_ids);

  for (const row of createPlatformSkills({ tools: tool_port, clock }, enablement)) {
    if (row.skill_id.startsWith('skill.mkt.')) {
      registry.register({ ...row, enabled: enabledSet.has(row.skill_id) });
    }
  }

  const engine = createSkillRuntimeEngine({
    registry,
    deriveEffectKey: (identity) => computeEffectKey(identity),
    evaluateAuthority: (granted, required) => evaluateAuthorityVerdict(granted, required),
    approvalDigest: (action) => approvalPayloadDigest(action),
    ...(options.now !== undefined ? { now: () => options.now!().getTime() } : {}),
    ...(options.gate === undefined ? {} : { gate: options.gate }),
    ...(options.llm === undefined ? {} : { llm: options.llm }),
    ...(options.breakers === undefined ? {} : { breakers: options.breakers }),
  });

  const dispatcher = createSkillAdapterDispatcher({
    engine,
    resolve_correlation_id: options.resolve_correlation_id,
    resolve_grant: options.resolve_grant,
    ...(options.reconcile !== undefined ? { provider_reconcile: options.reconcile } : {}),
    special_receipt: ({ action, output }) => {
      if (action.skill_id !== 'skill.mkt.dispatch_campaign') {
        return null;
      }
      const dispatch_id = output.dispatch_id;
      if (typeof dispatch_id !== 'string' || dispatch_id.trim().length === 0) {
        throw new SkillError(
          'EFFECT_UNKNOWN',
          'API-003 returned no provider dispatch identity; receipt cannot be confirmed',
          'skill.mkt.dispatch_campaign',
        );
      }
      const status = output.status;
      if (status === 'FAILED') {
        return {
          execution_id: dispatch_id,
          adapter_status: 'ERROR',
          provider_reference: dispatch_id,
          response_payload: output,
          latency_ms: 0,
          token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
        };
      }
      return {
        execution_id: dispatch_id,
        adapter_status: 'SUCCESS',
        provider_reference: dispatch_id,
        response_payload: output,
        latency_ms: 0,
        token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
      };
    },
  });

  const unbound: string[] = [];
  if (!options.signal_reads) {
    unbound.push('API-002.EventIngestion: no signal read connector is bound');
  }
  if (!options.customer360) {
    unbound.push('PostgreSQL.Customer360Store: no Customer360 store is bound');
  }
  if (!options.consent) {
    unbound.push('API-002.ConsentStore: no consent store connector is bound');
  }
  if (!options.content_engine && !options.llm) {
    unbound.push('Core.LLMContentEngine: no content generation engine is bound');
  }
  if (!options.brand_guard && !options.knowledge) {
    unbound.push('SecondBrain.BrandGuard: no BrandGuard compliance engine is bound');
  }
  if (!options.communication) {
    unbound.push('API-003.CommunicationConnector: no API-003 communication connector is bound');
  }
  if (!options.analytics) {
    unbound.push('PostgreSQL.AnalyticsStore: no downstream analytics/order evidence store is bound');
  }

  return {
    registry,
    tool_port,
    dispatcher,
    unbound,
  };
}
