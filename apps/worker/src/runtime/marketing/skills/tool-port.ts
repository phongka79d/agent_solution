import type { SkillToolInvocation, SkillToolPort } from '@agentos/skills';

import type {
  InputMktAnalyzeSignal,
  InputMktAuditBrand,
  InputMktCheckConsent,
  InputMktDispatchCampaign,
  InputMktEvaluateAttribution,
  InputMktGenerateContent,
  InputMktSegmentAudience,
  MarketingSkillToolPortOptions,
} from './types.js';

/**
 * Error thrown by the Marketing skill tool port.
 */
export class MarketingSkillToolError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(`[${code}] ${message}`);
    this.name = 'MarketingSkillToolError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Creates the unified SkillToolPort for Marketing skills.
 * Routes each skill_id and tool_binding to its injected port, failing closed
 * with UNBOUND_PROVIDER when an owner/provider/connector is not bound.
 */
export function createMarketingSkillToolPort(
  options: MarketingSkillToolPortOptions,
): SkillToolPort {
  return {
    async invoke<TInput, TOutput>(invocation: SkillToolInvocation<TInput>): Promise<TOutput> {
      const { skill_id, tool_binding, input, context } = invocation;

      // 1. skill.mkt.analyze_market_signal -> API-002.EventIngestion
      if (
        skill_id === 'skill.mkt.analyze_market_signal' &&
        tool_binding === 'API-002.EventIngestion'
      ) {
        if (!options.signal_reads) {
          throw new MarketingSkillToolError(
            'UNBOUND_PROVIDER',
            'API-002.EventIngestion is unbound: no signal read connector is configured',
          );
        }
        return (await options.signal_reads.readSignals(
          input as unknown as InputMktAnalyzeSignal,
          context,
        )) as TOutput;
      }

      // 2. skill.mkt.segment_audience -> PostgreSQL.Customer360Store
      if (
        skill_id === 'skill.mkt.segment_audience' &&
        tool_binding === 'PostgreSQL.Customer360Store'
      ) {
        if (!options.customer360) {
          throw new MarketingSkillToolError(
            'UNBOUND_PROVIDER',
            'PostgreSQL.Customer360Store is unbound: no Customer360 store is configured',
          );
        }
        return (await options.customer360.segmentAudience(
          input as unknown as InputMktSegmentAudience,
          context,
        )) as TOutput;
      }

      // 3. skill.mkt.check_consent -> API-002.ConsentStore
      if (
        skill_id === 'skill.mkt.check_consent' &&
        tool_binding === 'API-002.ConsentStore'
      ) {
        const consentPort =
          options.consent ?? options.consent_port ?? options.consentPort;
        if (!consentPort) {
          throw new MarketingSkillToolError(
            'UNBOUND_PROVIDER',
            'API-002.ConsentStore is unbound: no consent store connector is configured',
          );
        }
        return (await consentPort.checkConsent(
          input as unknown as InputMktCheckConsent,
          context,
        )) as TOutput;
      }

      // 4. skill.mkt.generate_content -> Core.LLMContentEngine
      if (
        skill_id === 'skill.mkt.generate_content' &&
        tool_binding === 'Core.LLMContentEngine'
      ) {
        if (!options.content_engine) {
          throw new MarketingSkillToolError(
            'UNBOUND_PROVIDER',
            'Core.LLMContentEngine is unbound: no content generation engine is configured',
          );
        }
        return (await options.content_engine.generateContent(
          input as unknown as InputMktGenerateContent,
          context,
        )) as TOutput;
      }

      // 5. skill.mkt.audit_brand_compliance -> SecondBrain.BrandGuard
      if (
        skill_id === 'skill.mkt.audit_brand_compliance' &&
        tool_binding === 'SecondBrain.BrandGuard'
      ) {
        if (!options.brand_guard) {
          throw new MarketingSkillToolError(
            'UNBOUND_PROVIDER',
            'SecondBrain.BrandGuard is unbound: no BrandGuard compliance engine is configured',
          );
        }
        return (await options.brand_guard.auditBrandCompliance(
          input as unknown as InputMktAuditBrand,
          context,
        )) as TOutput;
      }

      // 6. skill.mkt.dispatch_campaign -> API-003.CommunicationConnector
      if (
        skill_id === 'skill.mkt.dispatch_campaign' &&
        tool_binding === 'API-003.CommunicationConnector'
      ) {
        if (!options.communication) {
          throw new MarketingSkillToolError(
            'UNBOUND_PROVIDER',
            'API-003.CommunicationConnector is unbound: no communication connector is configured',
          );
        }

        const resolver =
          options.communication.resolveAudience ??
          options.communication.audience_resolver ??
          options.communication.audienceResolver ??
          options.audience_resolver ??
          options.audienceResolver;

        if (!resolver) {
          throw new MarketingSkillToolError(
            'AUDIENCE_RESOLVER_REQUIRED',
            'Server-side audience resolver is required for skill.mkt.dispatch_campaign before communication dispatch; no resolver configured (fail closed)',
          );
        }

        const typedInput = input as unknown as InputMktDispatchCampaign;
        const resolved = await resolver(
          {
            tenant_id: typedInput.tenant_id,
            segment_id: typedInput.segment_id,
            channel: typedInput.channel,
          },
          context,
        );

        let resolvedRecipients: readonly string[];
        let consentAlreadyVerified = false;

        if (Array.isArray(resolved)) {
          resolvedRecipients = resolved;
        } else if (typeof resolved === 'object' && resolved !== null) {
          const verifiedAudience = resolved as { recipients?: unknown; consent_verified?: unknown };
          if (!Array.isArray(verifiedAudience.recipients)) {
            throw new MarketingSkillToolError(
              'AUDIENCE_REQUIRED',
              `Audience resolver returned no eligible recipients for segment '${typedInput.segment_id}'; campaign dispatch refused (fail closed)`,
            );
          }
          resolvedRecipients = verifiedAudience.recipients as readonly string[];
          if (verifiedAudience.consent_verified === true) {
            consentAlreadyVerified = true;
          }
        } else {
          throw new MarketingSkillToolError(
            'AUDIENCE_REQUIRED',
            `Audience resolver returned no eligible recipients for segment '${typedInput.segment_id}'; campaign dispatch refused (fail closed)`,
          );
        }

        if (resolvedRecipients.length === 0) {
          throw new MarketingSkillToolError(
            'AUDIENCE_REQUIRED',
            `Audience resolver returned no eligible recipients for segment '${typedInput.segment_id}'; campaign dispatch refused (fail closed)`,
          );
        }

        for (const r of resolvedRecipients) {
          if (typeof r !== 'string' || r.trim() === '') {
            throw new MarketingSkillToolError(
              'AUDIENCE_REQUIRED',
              'Audience resolver returned invalid or empty recipient identifier (fail closed)',
            );
          }
        }

        let eligibleRecipients: readonly string[];

        if (consentAlreadyVerified) {
          eligibleRecipients = resolvedRecipients;
        } else {
          const consentPort =
            options.consent ??
            options.consent_port ??
            options.consentPort ??
            options.communication.consent ??
            options.communication.consent_port ??
            options.communication.consentPort;

          if (!consentPort) {
            throw new MarketingSkillToolError(
              'CONSENT_PORT_REQUIRED',
              'Server-side MarketingConsentPort is required for skill.mkt.dispatch_campaign before communication dispatch; no consent port configured (fail closed)',
            );
          }

          const consentChecks = await Promise.all(
            resolvedRecipients.map((customerId) =>
              consentPort.checkConsent(
                {
                  tenant_id: typedInput.tenant_id,
                  customer_id: customerId,
                  channel: typedInput.channel,
                },
                context,
              ),
            ),
          );
          eligibleRecipients = resolvedRecipients.filter(
            (_, idx) => consentChecks[idx]?.allowed === true,
          );

          if (eligibleRecipients.length === 0) {
            throw new MarketingSkillToolError(
              'AUDIENCE_REQUIRED',
              `All ${resolvedRecipients.length} resolved recipients were denied or suppressed by consent recheck; missing consent denied (fail closed)`,
            );
          }
        }
        return (await options.communication.dispatchCampaign(
          {
            ...typedInput,
            recipients: eligibleRecipients,
          },
          context,
        )) as TOutput;
      }


      // 7. skill.mkt.evaluate_attribution -> PostgreSQL.AnalyticsStore
      if (
        skill_id === 'skill.mkt.evaluate_attribution' &&
        tool_binding === 'PostgreSQL.AnalyticsStore'
      ) {
        if (!options.analytics) {
          throw new MarketingSkillToolError(
            'UNBOUND_PROVIDER',
            'PostgreSQL.AnalyticsStore is unbound: no analytics store connector is configured',
          );
        }
        return (await options.analytics.evaluateAttribution(
          input as unknown as InputMktEvaluateAttribution,
          context,
        )) as TOutput;
      }

      throw new MarketingSkillToolError(
        'UNKNOWN_CAPABILITY',
        `Marketing tool binding '${tool_binding}' is not supported for skill '${skill_id}'`,
      );
    },
  };
}
