import {
  computeEffectKey,
  computeRequestFingerprint,
  evaluateAuthorityVerdict,
} from '@agentos/core-engine';
import {
  createPlatformSkills,
  createSkillRegistry,
  createSkillRuntimeEngine,
  type PlatformSkillEnablement,
} from '@agentos/skills';

import { createMarketingSkillDispatcher, MARKETING_DISPATCH_INTEGRATION } from './dispatcher.js';
import { createMarketingSkillToolPort, MarketingSkillToolError } from './tool-port.js';
import {
  MARKETING_DISPATCH_INTEGRATION_STATUS,
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
  MarketingBrandGuardPort,
  MarketingCommunicationPort,
  MarketingConsentPort,
  MarketingContentEnginePort,
  MarketingCustomer360Port,
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

export {
  MARKETING_DISPATCH_INTEGRATION,
  MARKETING_DISPATCH_INTEGRATION_STATUS,
  MarketingSkillToolError,
  createMarketingSkillDispatcher,
  createMarketingSkillToolPort,
};

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
 * - lists unbound connectors when ports are not configured (failing closed)
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
    digestPayload: (payload) => computeRequestFingerprint(payload as Record<string, unknown>),
    deriveEffectKey: (identity) => computeEffectKey(identity),
    evaluateAuthority: (granted, required) => evaluateAuthorityVerdict(granted, required),
    ...(options.now !== undefined ? { now: () => options.now!().getTime() } : {}),
  });

  const dispatcher = createMarketingSkillDispatcher({
    engine,
    resolve_correlation_id: options.resolve_correlation_id,
    resolve_grant: options.resolve_grant,
    ...(options.reconcile !== undefined ? { reconcile: options.reconcile } : {}),
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
  if (!options.content_engine) {
    unbound.push('Core.LLMContentEngine: no content generation engine is bound');
  }
  if (!options.brand_guard) {
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
    dispatch_integration: MARKETING_DISPATCH_INTEGRATION_STATUS,
  };
}
