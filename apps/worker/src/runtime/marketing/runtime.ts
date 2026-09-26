import {
  type CampaignDispatchInput,
  type CampaignDispatchResult,
  type CampaignLifecycleContext,
} from './contracts.js';
import {
  dispatchCampaign,
  type DispatchCampaignOptions,
} from './dispatch.js';
import {
  CampaignLifecycle,
  createCampaignLifecycle,
} from './lifecycle.js';
import { computeEffectKey, evaluateAuthorityVerdict, isAssignableAuthority } from '@agentos/core-engine';
import {
  type AudienceSegmentOutput,
  composeAudienceSegment,
  composeMarketSignal,
  type MarketSignalOutput,
} from './analysis.js';
import {
  auditMarketingBrand,
  screenMarketingUntrustedInput,
} from './content.js';
import {
  type MarketingAttributionInput,
  type MarketingAttributionResult,
  type MarketingAuditRecord,
  type MarketingBrandAuditInput,
  type MarketingConsentDecision,
  type MarketingContentInput,
  type MarketingContentOutput,
  type MarketingEvidence,
  type MarketingInvocationContext,
  type MarketingInvocationResult,
  type MarketingKnowledgeDocument,
  type MarketingRuntimePorts,
  type MarketingSegmentInput,
  type MarketingSignalInput,
  type MarketingSkillId,
  MarketingRuntimeError,
} from './contracts.js';
import {
  MARKETING_APPROVED_DOCUMENT_ALLOWLIST,
  screenMarketingUntrustedContent,
} from './knowledge-adapter.js';

const APPROVED_FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const APPROVED_STATUS = /^status:[ \t]*(\S.*?)[ \t]*$/m;

function assertApprovedKnowledgeDocument(
  document: MarketingKnowledgeDocument,
  expectedPath: string,
): void {
  if (document.path !== expectedPath || !document.version || !document.content) {
    throw new MarketingRuntimeError(
      'KNOWLEDGE_DOCUMENT_INVALID',
      `Approved document '${expectedPath}' did not match the requested path or was empty`,
    );
  }
  const frontmatter = APPROVED_FRONTMATTER.exec(document.content);
  const status = frontmatter === null ? null : APPROVED_STATUS.exec(frontmatter[1] ?? '');
  if (status?.[1] !== 'approved') {
    throw new MarketingRuntimeError(
      'DOCUMENT_NOT_APPROVED',
      `Document '${expectedPath}' frontmatter status is '${status?.[1] ?? 'missing'}', expected 'approved'`,
    );
  }
  screenMarketingUntrustedContent(document.content);
}

export interface MarketingSkillMetadata {
  readonly skill_id: MarketingSkillId;
  readonly effect_class: 'READ' | 'INTERNAL' | 'APPROVAL';
  readonly required_authority: 'AUTH-1' | 'AUTH-2' | 'AUTH-3' | 'AUTH-4';
  readonly allowed_agents: readonly string[];
  readonly enabled: boolean;
}

export const MARKETING_SKILL_CATALOG: readonly MarketingSkillMetadata[] = Object.freeze([
  {
    skill_id: 'skill.mkt.analyze_market_signal',
    effect_class: 'READ',
    required_authority: 'AUTH-1',
    allowed_agents: Object.freeze(['MKT-01', 'MKT-02']),
    enabled: true,
  },
  {
    skill_id: 'skill.mkt.segment_audience',
    effect_class: 'INTERNAL',
    required_authority: 'AUTH-1',
    allowed_agents: Object.freeze(['MKT-02', 'MKT-05']),
    enabled: true,
  },
  {
    skill_id: 'skill.mkt.check_consent',
    effect_class: 'READ',
    required_authority: 'AUTH-3',
    allowed_agents: Object.freeze(['MKT-02', 'MKT-05', 'SAL-04']),
    enabled: true,
  },
  {
    skill_id: 'skill.mkt.generate_content',
    effect_class: 'INTERNAL',
    required_authority: 'AUTH-2',
    allowed_agents: Object.freeze(['MKT-03']),
    enabled: true,
  },
  {
    skill_id: 'skill.mkt.audit_brand_compliance',
    effect_class: 'READ',
    required_authority: 'AUTH-1',
    allowed_agents: Object.freeze(['MKT-04']),
    enabled: true,
  },
  {
    skill_id: 'skill.mkt.dispatch_campaign',
    effect_class: 'APPROVAL',
    required_authority: 'AUTH-4',
    allowed_agents: Object.freeze(['MKT-05']),
    enabled: false,
  },
  {
    skill_id: 'skill.mkt.evaluate_attribution',
    effect_class: 'READ',
    required_authority: 'AUTH-1',
    allowed_agents: Object.freeze(['MKT-06']),
    enabled: false,
  },
]);

export interface MarketingRuntimeOptions {
  readonly ports: MarketingRuntimePorts;
  readonly enableDispatch?: boolean;
  readonly enableMkt06?: boolean;
}

export interface MarketingRuntime {
  readonly skills: readonly MarketingSkillMetadata[];
  readonly capabilities: readonly MarketingSkillId[];
  readonly execute: <TInput = unknown, TOutput = unknown>(
    skill_id: string,
    input: TInput,
    context: MarketingInvocationContext,
  ) => Promise<MarketingInvocationResult<TOutput>>;
  readonly evaluateAttribution: (
    input: MarketingAttributionInput,
    context: MarketingInvocationContext,
  ) => Promise<MarketingAttributionResult>;
  readonly dispatchCampaign?: (
    input: CampaignDispatchInput,
    context: MarketingInvocationContext,
    options?: DispatchCampaignOptions,
  ) => Promise<CampaignDispatchResult>;
  readonly createLifecycle?: (
    identity: CampaignLifecycleContext,
  ) => CampaignLifecycle;
}

/** MKT-06 linkage contract only; no KPI or performance values are calculated. */
export async function evaluateAttribution(
  input: MarketingAttributionInput,
  context: MarketingInvocationContext,
  ports?: MarketingRuntimePorts,
): Promise<MarketingAttributionResult> {
  if (
    input.tenant_id !== context.tenant_id ||
    input.correlation_id !== context.correlation_id
  ) {
    throw new MarketingRuntimeError(
      'TENANT_MISMATCH',
      'Attribution tenant and correlation identifiers must match server-resolved context',
    );
  }
  if (!input.campaign_id || !input.effect_key || !input.attribution_model) {
    throw new MarketingRuntimeError(
      'SCHEMA_VALIDATION_ERROR',
      'campaign_id, effect_key, and attribution_model are required',
    );
  }
  if (input.evidence_ids.length === 0 || !ports?.attribution) {
    return {
      contract: {
        campaign_id: input.campaign_id,
        effect_key: input.effect_key,
        correlation_id: input.correlation_id,
        status: 'UNAVAILABLE',
        evidence_ids: [],
        reason: input.evidence_ids.length === 0
          ? 'ATTRIBUTION_EVIDENCE_ABSENT'
          : 'ATTRIBUTION_PORT_UNAVAILABLE',
      },
      evidence: [],
    };
  }

  const suppliedIds = new Set(input.evidence_ids);
  const orders = await ports.attribution.collectEvidence(input);
  const matchedById = new Map(
    orders
      .filter((order) =>
        suppliedIds.has(order.evidence_id) &&
        order.tenant_id === context.tenant_id &&
        order.campaign_id === input.campaign_id &&
        order.effect_key === input.effect_key &&
        order.correlation_id === context.correlation_id,
      )
      .map((order) => [order.evidence_id, order] as const),
  );
  const matched = input.evidence_ids.flatMap((evidenceId) => {
    const order = matchedById.get(evidenceId);
    return order === undefined ? [] : [order];
  });

  if (matched.length !== suppliedIds.size) {
    return {
      contract: {
        campaign_id: input.campaign_id,
        effect_key: input.effect_key,
        correlation_id: input.correlation_id,
        status: 'UNAVAILABLE',
        evidence_ids: matched.map((order) => order.evidence_id),
        reason: 'ATTRIBUTION_EVIDENCE_INCOMPLETE_OR_UNMATCHED',
      },
      evidence: [],
    };
  }

  return {
    contract: {
      campaign_id: input.campaign_id,
      effect_key: input.effect_key,
      correlation_id: input.correlation_id,
      status: 'READY_FOR_EVIDENCE',
      evidence_ids: matched.map((order) => order.evidence_id),
      reason: null,
    },
    evidence: matched.map((order) => ({
      evidence_id: order.evidence_id,
      tenant_id: order.tenant_id,
      run_id: context.run_id,
      correlation_id: order.correlation_id,
      effect_key: order.effect_key,
      classification: 'FACT',
      source_uri: order.evidence_uri,
      source_version: order.source_version,
      claim: `Attributed order evidence for campaign ${order.campaign_id}`,
    })),
  };
}

/** Builds the isolated Marketing router; every dependency is explicit and fail-closed. */
export function createMarketingRuntime(options: MarketingRuntimeOptions): MarketingRuntime {
  const { ports } = options;
  const now = ports.now ?? (() => new Date());
  let generatedId = 0;
  const newId = ports.newId ?? (() => `mkt-${++generatedId}`);
  const enabledSkills = MARKETING_SKILL_CATALOG.filter((skill) => skill.enabled);

  async function appendAudit(
    skillId: string,
    effectKey: string,
    context: MarketingInvocationContext,
    outcome: MarketingAuditRecord['outcome'],
    reason: string,
    evidenceIds: readonly string[] = [],
  ): Promise<MarketingAuditRecord> {
    const record: MarketingAuditRecord = {
      tenant_id: context.tenant_id,
      run_id: context.run_id,
      correlation_id: context.correlation_id,
      effect_key: effectKey,
      skill_id: skillId,
      outcome,
      reason,
      evidence_ids: evidenceIds,
      occurred_at: now().toISOString(),
    };
    await ports.audit.append(record);
    return record;
  }

  return {
    skills: MARKETING_SKILL_CATALOG,
    capabilities: Object.freeze(
      MARKETING_SKILL_CATALOG
        .filter((skill) => {
          if (skill.skill_id === 'skill.mkt.evaluate_attribution' && options.enableMkt06) return true;
          if (skill.skill_id === 'skill.mkt.dispatch_campaign' && options.enableDispatch) return true;
          return skill.enabled;
        })
        .map((skill) => skill.skill_id),
    ),
    evaluateAttribution: (input, context) => evaluateAttribution(input, context, ports),
    dispatchCampaign: (input, context, opts) => dispatchCampaign(input, context, ports, opts),
    createLifecycle: (identity) => createCampaignLifecycle(identity, ports),
    async execute<TInput = unknown, TOutput = unknown>(
      skill_id: string,
      input: TInput,
      context: MarketingInvocationContext,
    ): Promise<MarketingInvocationResult<TOutput>> {
      const effect_key = computeEffectKey({
        tenant_id: context.tenant_id,
        skill_id,
        step_index: context.step_index,
        action_revision: context.action_revision,
        request_id: context.request_id,
      });
      const reject = async (code: string, message: string): Promise<never> => {
        await appendAudit(skill_id, effect_key, context, 'DENIED', message);
        throw new MarketingRuntimeError(code, message);
      };

      if (
        (input as Record<string, unknown> | null)?.authority_verdict === 'AUTH-5' ||
        (context as Record<string, unknown>).authority_verdict === 'AUTH-5'
      ) {
        return reject(
          'AUTH_5_PROHIBITED',
          'AUTH-5 is strictly prohibited; hard deny. Never queued, never approvable, never dispatched.',
        );
      }
      if (!isAssignableAuthority(context.granted_authority)) {
        return reject(
          'INVALID_CLEARANCE',
          `granted_authority '${String(context.granted_authority)}' is not an assignable authority (BR-008)`,
        );
      }

      const metadata = MARKETING_SKILL_CATALOG.find((skill) => skill.skill_id === skill_id);
      if (skill_id === 'skill.mkt.dispatch_campaign') {
        if (!options.enableDispatch && !ports.dispatcher) {
          return reject(
            'DISPATCH_DISABLED',
            'Campaign dispatch is disabled pending the canonical AUTH-4 and SCR-003 P1B handoff',
          );
        }
        const dispatchRes = await dispatchCampaign(
          input as unknown as CampaignDispatchInput,
          context,
          ports,
        );
        return {
          skill_id: 'skill.mkt.dispatch_campaign',
          effect_key,
          output: dispatchRes.output as TOutput,
          evidence: dispatchRes.evidence,
          audit: dispatchRes.audit,
        };
      }
      if (
        !metadata ||
        (!metadata.enabled &&
          !(skill_id === 'skill.mkt.evaluate_attribution' && (options.enableMkt06 || ports.attribution)))
      ) {
        return reject('UNKNOWN_SKILL', `Unknown or disabled Marketing skill '${skill_id}'`);
      }
      if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return reject('SCHEMA_VALIDATION_ERROR', 'Skill input must be an object');
      }

      const rawInput = input as Record<string, unknown>;
      if (rawInput.tenant_id !== context.tenant_id) {
        return reject('TENANT_MISMATCH', 'Input tenant does not match server-resolved tenant');
      }
      if (!metadata.allowed_agents.includes(context.caller_agent)) {
        return reject('UNAUTHORIZED_AGENT', 'Caller agent is not authorized for this Marketing skill');
      }
      const authority = evaluateAuthorityVerdict(
        context.granted_authority,
        metadata.required_authority,
      );
      if (authority.verdict !== 'AUTO_APPROVED') {
        return reject(authority.errorCode ?? 'INSUFFICIENT_AUTHORITY', authority.reason);
      }

      let output: unknown;
      let evidence: MarketingEvidence[] = [];
      let auditOutcome: MarketingAuditRecord['outcome'] = 'SUCCEEDED';
      let auditReason = 'Marketing skill completed';

      switch (skill_id as MarketingSkillId) {
        case 'skill.mkt.analyze_market_signal': {
          const signal = input as unknown as MarketingSignalInput;
          if (
            typeof signal.category_id !== 'string' || signal.category_id.trim().length === 0 ||
            !Number.isInteger(signal.observation_window_days) ||
            signal.observation_window_days < 1 || signal.observation_window_days > 90 ||
            !['TW', 'GLOBAL_US', 'GLOBAL_EU', 'VN'].includes(signal.market_region)
          ) {
            return reject('SCHEMA_VALIDATION_ERROR', 'Market signal input is invalid');
          }
          if (!ports.research) {
            return reject('RESEARCH_PORT_UNAVAILABLE', 'MarketingResearchPort is unavailable');
          }
          const research = await ports.research.readMarketSignals(signal);
          const composed = composeMarketSignal(signal, research, context, effect_key, now, newId);
          output = composed.output satisfies MarketSignalOutput;
          evidence = [...composed.evidence];
          break;
        }
        case 'skill.mkt.segment_audience': {
          const segment = input as unknown as MarketingSegmentInput;
          if (
            !['CHAMPIONS', 'LOYAL', 'POTENTIAL_LOYALIST', 'AT_RISK', 'HIBERNATING'].includes(segment.rfm_criteria) ||
            !Number.isInteger(segment.min_days_inactive) || segment.min_days_inactive < 0 ||
            (segment.max_segment_size !== undefined &&
              (!Number.isInteger(segment.max_segment_size) || segment.max_segment_size < 1 || segment.max_segment_size > 50000))
          ) {
            return reject('SCHEMA_VALIDATION_ERROR', 'Audience segmentation criteria or bounds are invalid');
          }
          const limit = await ports.policy?.getApprovedAudienceLimit(context.tenant_id);
          if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
            return reject('ASM_003_UNAVAILABLE', 'Owner-approved ASM-003 audience limit is unavailable');
          }
          if (!ports.research) {
            return reject('RESEARCH_PORT_UNAVAILABLE', 'MarketingResearchPort is unavailable');
          }
          const cap = segment.max_segment_size === undefined
            ? limit
            : Math.min(segment.max_segment_size, limit);
          const boundedSegment: MarketingSegmentInput = {
            ...segment,
            max_segment_size: cap,
          };
          const candidates = await ports.research.segmentAudience(boundedSegment);
          const composed = composeAudienceSegment(
            boundedSegment,
            candidates,
            limit,
            context,
            effect_key,
            now,
            newId,
          );
          output = composed.output satisfies AudienceSegmentOutput;
          evidence = [...composed.evidence];
          break;
        }
        case 'skill.mkt.check_consent': {
          const consentInput = input as { readonly customer_id?: unknown; readonly channel?: unknown };
          const verifiedCustomerId = context.verified_customer_id;
          if (!verifiedCustomerId) {
            return reject('UNVERIFIED_CUSTOMER', 'Verified customer ID is missing from server invocation context');
          }
          if (consentInput.customer_id !== verifiedCustomerId) {
            return reject('CUSTOMER_MISMATCH', 'Input customer does not match server-verified customer identity');
          }
          if (typeof consentInput.channel !== 'string' || consentInput.channel.trim().length === 0) {
            return reject('SCHEMA_VALIDATION_ERROR', 'channel is required and must be a string');
          }
          if (!ports.consent) {
            return reject('CONSENT_PORT_UNAVAILABLE', 'MarketingConsentPort is unavailable');
          }
          const decision: MarketingConsentDecision = await ports.consent.check({
            tenant_id: context.tenant_id,
            customer_id: verifiedCustomerId,
            channel: consentInput.channel,
          });
          if (
            decision.tenant_id !== context.tenant_id ||
            decision.customer_id !== verifiedCustomerId ||
            typeof decision.allowed !== 'boolean'
          ) {
            return reject('CONSENT_CONTEXT_MISMATCH', 'Consent result does not match verified invocation identity');
          }
          evidence = [{
            evidence_id: newId(),
            tenant_id: context.tenant_id,
            run_id: context.run_id,
            correlation_id: context.correlation_id,
            effect_key,
            classification: 'DECISION',
            source_uri: decision.source_uri,
            source_version: decision.source_version,
            claim: decision.allowed
              ? `Consent verified for channel ${consentInput.channel}`
              : `Consent denied: ${decision.suppression_reason ?? 'suppressed'}`,
          }];
          output = {
            allowed: decision.allowed,
            consent_timestamp: decision.consent_timestamp,
            suppression_reason: decision.suppression_reason,
          };
          if (!decision.allowed) {
            auditOutcome = 'DENIED';
            auditReason = decision.suppression_reason ?? 'Marketing consent denied or suppressed';
          }
          break;
        }
        case 'skill.mkt.generate_content': {
          const contentInput = input as unknown as MarketingContentInput;
          if (
            typeof contentInput.campaign_theme !== 'string' ||
            contentInput.campaign_theme.trim().length === 0 ||
            contentInput.campaign_theme.length > 250 ||
            !['LINE_FLEX', 'WHATSAPP_TEMPLATE', 'EMAIL_HTML', 'SMS_TEXT', 'ZALO_ZNS', 'TIKTOK_CARD', 'MESSENGER_GENERIC', 'INSTAGRAM_DIRECT'].includes(contentInput.channel) ||
            !['zh-TW', 'en-US', 'vi-VN', 'ja-JP'].includes(contentInput.locale)
          ) {
            return reject('SCHEMA_VALIDATION_ERROR', 'Content input is invalid');
          }
          screenMarketingUntrustedInput(contentInput.campaign_theme, 'campaign_theme');
          if (!ports.content_generator) {
            return reject('CONTENT_GENERATOR_UNAVAILABLE', 'An injected Marketing content generator is required');
          }
          if (!ports.knowledge) {
            return reject('KNOWLEDGE_PORT_UNAVAILABLE', 'MarketingKnowledgePort is unavailable');
          }
          const docs: MarketingKnowledgeDocument[] = [];
          for (const path of MARKETING_APPROVED_DOCUMENT_ALLOWLIST) {
            const doc = await ports.knowledge.readApproved(context.tenant_id, path);
            assertApprovedKnowledgeDocument(doc, path);
            docs.push(doc);
          }
          const generated = await ports.content_generator.generate(contentInput, docs);
          if (
            !generated ||
            typeof generated.draft_id !== 'string' || generated.draft_id.length === 0 ||
            typeof generated.headline !== 'string' || generated.headline.length === 0 ||
            typeof generated.body_content !== 'string' || generated.body_content.length === 0 ||
            typeof generated.cta_text !== 'string' || generated.cta_text.length === 0 ||
            generated.channel_payload?.channel_type !== contentInput.channel
          ) {
            return reject('CONTENT_OUTPUT_INVALID', 'Injected content generator returned an invalid draft');
          }
          screenMarketingUntrustedInput(generated.headline, 'generated headline');
          screenMarketingUntrustedInput(generated.body_content, 'generated body');
          screenMarketingUntrustedInput(generated.cta_text, 'generated call to action');
          output = generated satisfies MarketingContentOutput;
          evidence = [{
            evidence_id: newId(),
            tenant_id: context.tenant_id,
            run_id: context.run_id,
            correlation_id: context.correlation_id,
            effect_key,
            classification: 'DRAFT',
            source_uri: `marketing://draft/${generated.draft_id}`,
            source_version: docs.map((doc) => `${doc.path}@${doc.version}`).join(';'),
            claim: 'Generated draft content; not approved for publication',
          }];
          break;
        }
        case 'skill.mkt.audit_brand_compliance': {
          const auditInput = input as unknown as MarketingBrandAuditInput;
          if (
            typeof auditInput.draft_text !== 'string' ||
            auditInput.draft_text.trim().length === 0 ||
            auditInput.draft_text.length >= 10000 ||
            typeof auditInput.channel !== 'string' || auditInput.channel.trim().length === 0
          ) {
            return reject('MALFORMED_INPUT', 'draft_text must be non-empty and shorter than 10000 characters; channel is required');
          }
          screenMarketingUntrustedInput(auditInput.draft_text, 'draft_text');
          if (!ports.knowledge) {
            return reject('KNOWLEDGE_PORT_UNAVAILABLE', 'MarketingKnowledgePort is unavailable');
          }
          const docs: MarketingKnowledgeDocument[] = [];
          for (const path of MARKETING_APPROVED_DOCUMENT_ALLOWLIST) {
            const doc = await ports.knowledge.readApproved(context.tenant_id, path);
            assertApprovedKnowledgeDocument(doc, path);
            docs.push(doc);
          }
          const auditResult = auditMarketingBrand(auditInput, docs);
          output = auditResult;
          const prohibitedClaims = docs.find((doc) => doc.path === 'brand/prohibited-claims.md');
          if (!prohibitedClaims) {
            return reject('PROHIBITED_CLAIMS_UNAVAILABLE', 'Approved prohibited-claims knowledge is unavailable');
          }
          evidence = [{
            evidence_id: newId(),
            tenant_id: context.tenant_id,
            run_id: context.run_id,
            correlation_id: context.correlation_id,
            effect_key,
            classification: 'DECISION',
            source_uri: `second-brain://${prohibitedClaims.path}`,
            source_version: prohibitedClaims.version,
            claim: auditResult.compliant
              ? 'Brand compliance passed against approved knowledge'
              : `Brand compliance denied with ${auditResult.violations.length} prohibited-claim violation(s)`,
          }];
          if (!auditResult.compliant) {
            auditOutcome = 'DENIED';
            auditReason = `Brand compliance found ${auditResult.violations.length} blocking violation(s)`;
          }
          break;
        }
        case 'skill.mkt.evaluate_attribution': {
          const attributionInput = input as unknown as MarketingAttributionInput;
          const attrResult = await evaluateAttribution(attributionInput, context, ports);
          output = attrResult.contract;
          evidence = [...attrResult.evidence];
          if (attrResult.contract.status === 'UNAVAILABLE') {
            auditOutcome = 'DENIED';
            auditReason = attrResult.contract.reason ?? 'Attribution evidence unavailable';
          } else {
            auditOutcome = 'SUCCEEDED';
            auditReason = 'Attribution evaluated with matched downstream order evidence';
          }
          break;
        }
        default:
          return reject('UNKNOWN_SKILL', `Unsupported Marketing skill '${skill_id}'`);
      }

      const persistedEvidenceIds: string[] = [];
      if (evidence.length > 0) {
        persistedEvidenceIds.push(await ports.evidence.append(evidence, context, effect_key));
      }
      const auditRecord = await appendAudit(
        skill_id,
        effect_key,
        context,
        auditOutcome,
        auditReason,
        persistedEvidenceIds,
      );
      return {
        skill_id: skill_id as MarketingSkillId,
        effect_key,
        output: output as TOutput,
        evidence,
        audit: auditRecord,
      };
    },
  };
}
