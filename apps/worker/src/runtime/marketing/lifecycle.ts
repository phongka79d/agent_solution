/**
 * @file Marketing Campaign Lifecycle Seam (Brief→Audience→Content→Brand Review→AUTH-4/SCR-003→Publish→Monitor→Optimize).
 *
 * Implements the normative 8-stage Marketing Campaign lifecycle:
 * 1. BRIEF: market signal analysis and brief formulation (MKT-01).
 * 2. AUDIENCE: cohort segmentation and ASM-003 limit enforcement (MKT-02).
 * 3. CONTENT: draft generation with approved knowledge docs (MKT-03).
 * 4. BRAND_REVIEW: compliance audit requiring a blocking-free decision (MKT-04).
 * 5. APPROVAL: SCR-003 human-in-the-loop gate binding exact reviewed digest (AUTH-4).
 * 6. PUBLISH: consent-checked broadcast delivery with durable effect guard (MKT-05).
 * 7. MONITOR: execution receipt and delivery outcome tracking.
 * 8. OPTIMIZE: conversion attribution enabled only for complete matched downstream order evidence (MKT-06).
 */

import {
  computeEffectKey,
  isAssignableAuthority,
} from '@agentos/core-engine';
import type { ActionDraft } from '@agentos/core-engine/contracts';
import {
  auditMarketingBrand,
} from './content.js';
import {
  type CampaignApprovalBinding,
  type CampaignDispatchInput,
  type CampaignDispatchOutput,
  type CampaignLifecycleStage,
  type CampaignLifecycleState,
  type MarketingAttributionInput,
  type MarketingAttributionResult,
  type MarketingAudienceCandidate,
  type MarketingAuthoritativeValidation,
  type MarketingBrandAuditOutput,
  type MarketingContentInput,
  type MarketingContentOutput,
  type MarketingInvocationContext,
  type MarketingKnowledgeDocument,
  type MarketingRuntimePorts,
  type MarketingSegmentInput,
  type MarketingSignalInput,
  MarketingRuntimeError,
} from './contracts.js';
import {
  computeCampaignPayloadSha256,
  computeReviewedDigest,
  dispatchCampaign,
  claimCanonicalApproval,
  type DispatchCampaignOptions,
  validateAuthoritativeInputs,
} from './dispatch.js';
import {
  MARKETING_APPROVED_DOCUMENT_ALLOWLIST,
} from './knowledge-adapter.js';
import {
  evaluateAttribution,
} from './runtime.js';

/** Canonical legal stage transitions. OPTIMIZE is terminal. */
const LEGAL_STAGE_TRANSITIONS: Readonly<Record<CampaignLifecycleStage, readonly CampaignLifecycleStage[]>> = Object.freeze({
  BRIEF: ['AUDIENCE'],
  AUDIENCE: ['CONTENT'],
  CONTENT: ['BRAND_REVIEW'],
  BRAND_REVIEW: ['APPROVAL'],
  APPROVAL: ['PUBLISH'],
  PUBLISH: ['MONITOR'],
  MONITOR: ['OPTIMIZE'],
  OPTIMIZE: [],
});

/** Asserts a valid campaign lifecycle stage transition. */
export function assertValidCampaignTransition(
  from: CampaignLifecycleStage | null,
  to: CampaignLifecycleStage,
): void {
  const successors = from === null ? ['BRIEF'] : LEGAL_STAGE_TRANSITIONS[from];
  if (!successors.includes(to)) {
    throw new MarketingRuntimeError(
      'INVALID_STAGE_TRANSITION',
      `Illegal campaign lifecycle transition: ${from ?? 'START'} -> ${to}; legal successor(s): ${successors.join(', ') || 'none (OPTIMIZE is terminal)'}`,
    );
  }
}

export interface CampaignLifecycleContext {
  readonly tenant_id: string;
  readonly campaign_id: string;
  readonly run_id: string;
  readonly correlation_id: string;
  readonly expected_task_version?: number;
}

/**
 * Stateful campaign lifecycle coordinator enforcing stage boundaries,
 * tenant/run/effect identity, brand compliance, and human approval gating.
 */
export class CampaignLifecycle {
  private readonly _identity: CampaignLifecycleContext;
  private readonly _ports: MarketingRuntimePorts;
  private _state: CampaignLifecycleState;
  private _paused_approval_id?: string;

  constructor(identity: CampaignLifecycleContext, ports: MarketingRuntimePorts) {
    if (!identity.tenant_id || !identity.campaign_id || !identity.run_id || !identity.correlation_id) {
      throw new MarketingRuntimeError(
        'SCHEMA_VALIDATION_ERROR',
        'tenant_id, campaign_id, run_id, and correlation_id are required for campaign lifecycle',
      );
    }
    this._identity = identity;
    this._ports = ports;
    this._state = {
      tenant_id: identity.tenant_id,
      campaign_id: identity.campaign_id,
      run_id: identity.run_id,
      correlation_id: identity.correlation_id,
      current_stage: 'BRIEF',
      visited_stages: ['BRIEF'],
    };
  }

  get state(): Readonly<CampaignLifecycleState> {
    return this._state;
  }

  get identity(): Readonly<CampaignLifecycleContext> {
    return this._identity;
  }

  /** Asserts tenant and run identity matches this campaign lifecycle instance. */
  private assertIdentity(context: MarketingInvocationContext): void {
    if (context.tenant_id !== this._identity.tenant_id) {
      throw new MarketingRuntimeError(
        'TENANT_MISMATCH',
        `Context tenant '${context.tenant_id}' does not match lifecycle tenant '${this._identity.tenant_id}'`,
      );
    }
    if (context.run_id !== this._identity.run_id) {
      throw new MarketingRuntimeError(
        'RUN_ID_MISMATCH',
        `Context run_id '${context.run_id}' does not match lifecycle run_id '${this._identity.run_id}'`,
      );
    }
    if (context.correlation_id !== this._identity.correlation_id) {
      throw new MarketingRuntimeError(
        'CORRELATION_ID_MISMATCH',
        `Context correlation_id '${context.correlation_id}' does not match lifecycle correlation_id '${this._identity.correlation_id}'`,
      );
    }
  }

  /** Rejects AUTH-5 hard deny immediately and enforces canonical grant boundary. */
  private assertCanonicalGrantAndNotAuth5(
    context: MarketingInvocationContext,
    input?: { authority_verdict?: string; payload?: Record<string, unknown> },
  ): void {
    if (
      input?.authority_verdict === 'AUTH-5' ||
      input?.payload?.authority_verdict === 'AUTH-5' ||
      (context as unknown as Record<string, unknown>).authority_verdict === 'AUTH-5'
    ) {
      throw new MarketingRuntimeError(
        'AUTH_5_PROHIBITED',
        'AUTH-5 is strictly prohibited; hard deny. Never queued, never approvable, never dispatched.',
      );
    }
    if (!isAssignableAuthority(context.granted_authority)) {
      throw new MarketingRuntimeError(
        'INVALID_CLEARANCE',
        `granted_authority '${String(context.granted_authority)}' is not an assignable authority (BR-008)`,
      );
    }
  }

  /**
   * Stage 1: BRIEF
   * Validates market signal inputs and captures campaign brief criteria.
   */
  async stepBrief(
    input: MarketingSignalInput,
    context: MarketingInvocationContext,
  ): Promise<void> {
    this.assertIdentity(context);
    this.assertCanonicalGrantAndNotAuth5(context);
    if (this._state.current_stage !== 'BRIEF') {
      throw new MarketingRuntimeError(
        'INVALID_STAGE_ORDER',
        `Cannot execute BRIEF step while in stage '${this._state.current_stage}'`,
      );
    }

    if (input.tenant_id !== this._identity.tenant_id) {
      throw new MarketingRuntimeError('TENANT_MISMATCH', 'Input tenant does not match lifecycle');
    }

    let briefResult: unknown = input;
    if (this._ports.research) {
      briefResult = await this._ports.research.readMarketSignals(input);
    }

    this._state.brief = briefResult;
    this.transitionTo('AUDIENCE');
  }

  /**
   * Stage 2: AUDIENCE
   * Segments the audience and bounds cohort size to ASM-003 limit.
   */
  async stepAudience(
    input: MarketingSegmentInput,
    context: MarketingInvocationContext,
  ): Promise<readonly MarketingAudienceCandidate[]> {
    this.assertIdentity(context);
    this.assertCanonicalGrantAndNotAuth5(context);
    if (this._state.current_stage !== 'AUDIENCE') {
      throw new MarketingRuntimeError(
        'INVALID_STAGE_ORDER',
        `Cannot execute AUDIENCE step while in stage '${this._state.current_stage}'`,
      );
    }

    if (input.tenant_id !== this._identity.tenant_id) {
      throw new MarketingRuntimeError('TENANT_MISMATCH', 'Input tenant does not match lifecycle');
    }

    const limit = await this._ports.policy?.getApprovedAudienceLimit(this._identity.tenant_id);
    if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
      throw new MarketingRuntimeError(
        'ASM_003_UNAVAILABLE',
        'Owner-approved ASM-003 audience limit is unavailable',
      );
    }

    const boundedInput: MarketingSegmentInput = {
      ...input,
      max_segment_size: input.max_segment_size === undefined
        ? limit
        : Math.min(input.max_segment_size, limit),
    };

    let candidates: readonly MarketingAudienceCandidate[] = [];
    if (this._ports.research) {
      candidates = await this._ports.research.segmentAudience(boundedInput);
    }

    this._state.audience = candidates;
    this.transitionTo('CONTENT');
    return candidates;
  }

  /**
   * Stage 3: CONTENT
   * Generates draft content using approved knowledge documents.
   */
  async stepContent(
    input: MarketingContentInput,
    context: MarketingInvocationContext,
  ): Promise<MarketingContentOutput> {
    this.assertIdentity(context);
    this.assertCanonicalGrantAndNotAuth5(context);
    if (this._state.current_stage !== 'CONTENT') {
      throw new MarketingRuntimeError(
        'INVALID_STAGE_ORDER',
        `Cannot execute CONTENT step while in stage '${this._state.current_stage}'`,
      );
    }

    if (input.tenant_id !== this._identity.tenant_id) {
      throw new MarketingRuntimeError('TENANT_MISMATCH', 'Input tenant does not match lifecycle');
    }

    if (!this._ports.content_generator) {
      throw new MarketingRuntimeError(
        'CONTENT_GENERATOR_UNAVAILABLE',
        'MarketingContentGeneratorPort is required for content generation',
      );
    }

    if (!this._ports.knowledge) {
      throw new MarketingRuntimeError(
        'KNOWLEDGE_PORT_UNAVAILABLE',
        'MarketingKnowledgePort is required for content generation',
      );
    }

    const docs: MarketingKnowledgeDocument[] = [];
    for (const path of MARKETING_APPROVED_DOCUMENT_ALLOWLIST) {
      const doc = await this._ports.knowledge.readApproved(this._identity.tenant_id, path);
      docs.push(doc);
    }

    const generated = await this._ports.content_generator.generate(input, docs);
    this._state.content = generated;
    this.transitionTo('BRAND_REVIEW');
    return generated;
  }

  /**
   * Stage 4: BRAND_REVIEW
   * Audits brand compliance against approved prohibited claims.
   * REQUIRES a blocking-free decision; non-compliant or BLOCKING violations halt the campaign.
   */
  async stepBrandReview(
    context: MarketingInvocationContext,
  ): Promise<MarketingBrandAuditOutput> {
    this.assertIdentity(context);
    this.assertCanonicalGrantAndNotAuth5(context);
    if (this._state.current_stage !== 'BRAND_REVIEW') {
      throw new MarketingRuntimeError(
        'INVALID_STAGE_ORDER',
        `Cannot execute BRAND_REVIEW step while in stage '${this._state.current_stage}'`,
      );
    }

    if (!this._state.content) {
      throw new MarketingRuntimeError(
        'CONTENT_ABSENT',
        'No content draft generated; cannot perform brand audit',
      );
    }

    if (!this._ports.knowledge) {
      throw new MarketingRuntimeError(
        'KNOWLEDGE_PORT_UNAVAILABLE',
        'MarketingKnowledgePort is required for brand review',
      );
    }

    const docs: MarketingKnowledgeDocument[] = [];
    for (const path of MARKETING_APPROVED_DOCUMENT_ALLOWLIST) {
      const doc = await this._ports.knowledge.readApproved(this._identity.tenant_id, path);
      docs.push(doc);
    }

    const auditResult = auditMarketingBrand(
      {
        tenant_id: this._identity.tenant_id,
        draft_text: `${this._state.content.headline}\n${this._state.content.body_content}\n${this._state.content.cta_text}`,
        channel: this._state.content.channel_payload.channel_type,
      },
      docs,
    );

    // Enforce blocking-free MKT-04 brand decision
    if (!auditResult.compliant) {
      throw new MarketingRuntimeError(
        'BRAND_REVIEW_FAILED',
        `Brand compliance audit failed with ${auditResult.violations.length} violation(s)`,
      );
    }

    const blocking = auditResult.violations.find((v) => v.severity === 'BLOCKING');
    if (blocking) {
      throw new MarketingRuntimeError(
        'BRAND_REVIEW_BLOCKING',
        `Brand compliance audit contains BLOCKING violation: ${blocking.rule_id} (${blocking.snippet})`,
      );
    }

    this._state.brand_review = auditResult;
    this.transitionTo('APPROVAL');
    return auditResult;
  }

  /**
   * Stage 5: APPROVAL (AUTH-4 / SCR-003)
   * Checkpoints pause in workflowEngine, binds exact reviewed digest,
   * validates authoritative inputs, and requires human claim/release before publish.
   */
  async stepApproval(
    params: {
      readonly action_id?: string;
      readonly authoritativeValidation?: MarketingAuthoritativeValidation;
      readonly decision?: 'APPROVED' | 'MODIFIED' | 'REJECTED' | 'PAUSE' | 'CANCELLED';
      readonly operator_id?: string;
      readonly review_comment?: string | null;
      readonly modified_payload?: Record<string, unknown>;
      readonly expected_task_version?: number;
      readonly approval_id?: string;
      /** Segment identity must be supplied before AUTH-4 review when publish uses a non-default segment. */
      readonly segment_id?: string;
      readonly proposed_price?: number;
      readonly offer_id?: string;
      readonly discount_amount?: number;
      readonly discount_percent?: number;
    },
    context: MarketingInvocationContext,
  ): Promise<{ paused: boolean; approval_id?: string; binding?: CampaignApprovalBinding }> {
    this.assertIdentity(context);
    this.assertCanonicalGrantAndNotAuth5(context);
    if (this._state.current_stage !== 'APPROVAL') {
      throw new MarketingRuntimeError(
        'INVALID_STAGE_ORDER',
        `Cannot execute APPROVAL step while in stage '${this._state.current_stage}'`,
      );
    }

    if (!this._state.content) {
      throw new MarketingRuntimeError('CONTENT_ABSENT', 'Draft content required for approval');
    }

    const action_id = params.action_id ?? `act-${context.request_id}`;
    const effect_key = this._ports.effectGuard?.computeEffectKey({
      tenant_id: this._identity.tenant_id,
      skill_id: 'skill.mkt.dispatch_campaign',
      step_index: context.step_index,
      action_revision: context.action_revision,
      request_id: context.request_id,
    }) ?? computeEffectKey({
      tenant_id: this._identity.tenant_id,
      skill_id: 'skill.mkt.dispatch_campaign',
      step_index: context.step_index,
      action_revision: context.action_revision,
      request_id: context.request_id,
    });

    const payload: Record<string, unknown> = params.modified_payload ?? {
      tenant_id: this._identity.tenant_id,
      campaign_id: this._identity.campaign_id,
      segment_id: params.segment_id ?? 'segment-cohort',
      channel: this._state.content.channel_payload.channel_type,
      approved_content_id: this._state.content.draft_id,
      recipients: (this._state.audience ?? []).map((c) => c.customer_id),
      ...(params.proposed_price !== undefined
        ? { proposed_price: params.proposed_price }
        : params.authoritativeValidation?.authoritative_price !== undefined
          ? { proposed_price: params.authoritativeValidation.authoritative_price }
          : {}),
      ...(params.offer_id !== undefined ? { offer_id: params.offer_id } : {}),
      ...(params.discount_amount !== undefined ? { discount_amount: params.discount_amount } : {}),
      ...(params.discount_percent !== undefined ? { discount_percent: params.discount_percent } : {}),
    };

    validateAuthoritativeInputs(payload, params.authoritativeValidation);

    const payload_sha256 = computeCampaignPayloadSha256(payload);
    const reviewed_digest = computeReviewedDigest({
      tenant_id: this._identity.tenant_id,
      run_id: this._identity.run_id,
      effect_key,
      payload_sha256,
    });

    // If human decision is not yet submitted -> pause for approval checkpoint
    const expectedTaskVersion =
      params.expected_task_version ??
      this._identity.expected_task_version ??
      (context as unknown as Record<string, unknown>).expected_task_version ??
      (context as unknown as Record<string, unknown>).task_version;

    if (!params.decision) {
      if (!this._ports.workflowEngine) {
        throw new MarketingRuntimeError(
          'P1B_APPROVAL_PORT_UNAVAILABLE',
          'Workflow engine port is unavailable for approval pause (fail closed)',
        );
      }

      if (
        expectedTaskVersion === undefined ||
        typeof expectedTaskVersion !== 'number' ||
        !Number.isInteger(expectedTaskVersion) ||
        expectedTaskVersion < 1
      ) {
        throw new MarketingRuntimeError(
          'TASK_VERSION_REQUIRED',
          'Server-supplied expected_task_version is required for workflow engine pause checkpoint (fail closed)',
        );
      }

      const pauseRes = await this._ports.workflowEngine.pauseForApproval({
        tenant_id: this._identity.tenant_id,
        run_id: this._identity.run_id,
        expected_task_version: expectedTaskVersion,
        checkpoint: {
          stage: 'APPROVAL',
          effect_key,
          payload_sha256,
          reviewed_digest,
        },
        approval: {
          action_id,
          effect_key,
          payload,
          reason: 'Campaign dispatch requires human approval (AUTH-4) at SCR-003',
        },
      });

      this._paused_approval_id = pauseRes.approval_id;
      this._state.paused_approval_id = pauseRes.approval_id;
      return { paused: true, approval_id: pauseRes.approval_id };
    }

    // Process human operator decision
    if (!this._ports.workflowEngine) {
      throw new MarketingRuntimeError(
        'P1B_APPROVAL_PORT_UNAVAILABLE',
        'Workflow engine port is unavailable for approval claim and resume (fail closed)',
      );
    }

    const approval_id =
      params.approval_id ??
      this._paused_approval_id ??
      this._state.paused_approval_id;

    if (!approval_id || typeof approval_id !== 'string' || approval_id.trim() === '') {
      throw new MarketingRuntimeError(
        'APPROVAL_ID_REQUIRED',
        'Real durable approval_id (from paused state or explicit server event) is required for approval resume (fail closed)',
      );
    }

    const operator_id = params.operator_id?.trim();
    if (!operator_id) {
      throw new MarketingRuntimeError(
        'OPERATOR_REQUIRED',
        'Non-empty authenticated operator_id is required for approval resume (fail closed)',
      );
    }

    if (params.decision !== 'APPROVED' && params.decision !== 'MODIFIED') {
      throw new MarketingRuntimeError(
        'APPROVAL_NOT_RELEASED',
        `Approval decision is '${params.decision}'; campaign dispatch refused`,
      );
    }

    const authorizedAction: ActionDraft = {
      action_id,
      run_id: this._identity.run_id,
      tenant_id: this._identity.tenant_id,
      agent_id: 'MKT-05',
      skill_id: 'skill.mkt.dispatch_campaign',
      adapter_target: 'API-003.CommunicationConnector',
      step_index: context.step_index,
      mutating: true,
      price_bearing: typeof payload.proposed_price === 'number',
      request_id: context.request_id,
      action_revision: context.action_revision,
      effect_key,
      required_authority: 'AUTH-4',
      payload,
      approval_payload_digest: payload_sha256,
      approval_id,
    };
    const binding = await claimCanonicalApproval({
      workflow: this._ports.workflowEngine,
      tenant_id: this._identity.tenant_id,
      run_id: this._identity.run_id,
      approval_id,
      effect_key,
      payload_sha256,
      reviewed_digest,
      decision: params.decision,
      operator_id,
      review_comment: params.review_comment ?? null,
      authorized_action: authorizedAction,
      ...(typeof expectedTaskVersion === 'number' && Number.isInteger(expectedTaskVersion) && expectedTaskVersion >= 1
        ? { expected_task_version: expectedTaskVersion }
        : {}),
    });

    this._state.approval_binding = binding;
    this.transitionTo('PUBLISH');
    return { paused: false, approval_id, binding };
  }

  /**
   * Stage 6: PUBLISH
   * Dispatches the campaign through the dispatch seam with consent recheck,
   * effect reservation, and provider delivery. Refuses call if AUTH-4 not released.
   */
  async stepPublish(
    input: Omit<CampaignDispatchInput, 'tenant_id' | 'campaign_id'>,
    context: MarketingInvocationContext,
    authoritativeValidation?: MarketingAuthoritativeValidation,
  ): Promise<CampaignDispatchOutput> {
    this.assertIdentity(context);
    this.assertCanonicalGrantAndNotAuth5(context, input);
    if (this._state.current_stage !== 'PUBLISH') {
      throw new MarketingRuntimeError(
        'INVALID_STAGE_ORDER',
        `Cannot execute PUBLISH step while in stage '${this._state.current_stage}'`,
      );
    }
    if (!this._state.brand_review) {
      throw new MarketingRuntimeError(
        'BRAND_REVIEW_REQUIRED',
        'A present brand review is required before publishing',
      );
    }

    if (!this._state.approval_binding || !this._state.approval_binding.claimed) {
      throw new MarketingRuntimeError(
        'APPROVAL_REQUIRED',
        'Refusing provider call: shared AUTH-4 release is required before dispatch',
      );
    }
    const fullInput: CampaignDispatchInput = {
      ...input,
      tenant_id: this._identity.tenant_id,
      campaign_id: this._identity.campaign_id,
      recipients: input.recipients ?? (this._state.audience ?? []).map((c) => c.customer_id),
    };

    const options: DispatchCampaignOptions = {
      ...(this._state.brand_review === undefined ? {} : { brandReview: this._state.brand_review }),
      ...(authoritativeValidation === undefined ? {} : { authoritativeValidation }),
      ...(this._state.approval_binding === undefined ? {} : { approvalBinding: this._state.approval_binding }),
      ...(this._identity.expected_task_version === undefined
        ? {}
        : { expected_task_version: this._identity.expected_task_version }),
    };
    const dispatchResult = await dispatchCampaign(
      fullInput,
      context,
      this._ports,
      options,
    );

    this._state.dispatch_result = dispatchResult.output;
    this.transitionTo('MONITOR');
    return dispatchResult.output;
  }

  /**
   * Stage 7: MONITOR
   * Observes dispatch status and prepares for attribution.
   */
  async stepMonitor(
    context: MarketingInvocationContext,
  ): Promise<{ monitored: boolean; dispatch_id: string; status: string }> {
    this.assertIdentity(context);
    this.assertCanonicalGrantAndNotAuth5(context);
    if (this._state.current_stage !== 'MONITOR') {
      throw new MarketingRuntimeError(
        'INVALID_STAGE_ORDER',
        `Cannot execute MONITOR step while in stage '${this._state.current_stage}'`,
      );
    }

    if (!this._state.dispatch_result) {
      throw new MarketingRuntimeError('DISPATCH_ABSENT', 'No dispatch result found to monitor');
    }

    this.transitionTo('OPTIMIZE');
    return {
      monitored: true,
      dispatch_id: this._state.dispatch_result.dispatch_id,
      status: this._state.dispatch_result.status,
    };
  }

  /**
   * Stage 8: OPTIMIZE
   * Conversion attribution (MKT-06).
   * Enabled only for complete matched downstream order evidence; returns UNAVAILABLE without invented metrics.
   */
  async stepOptimize(
    input: {
      readonly attribution_model: 'FIRST_TOUCH' | 'LAST_TOUCH' | 'LINEAR' | 'DATA_DRIVEN';
      readonly evidence_ids: readonly string[];
    },
    context: MarketingInvocationContext,
  ): Promise<MarketingAttributionResult> {
    this.assertIdentity(context);
    this.assertCanonicalGrantAndNotAuth5(context);
    if (this._state.current_stage !== 'OPTIMIZE') {
      throw new MarketingRuntimeError(
        'INVALID_STAGE_ORDER',
        `Cannot execute OPTIMIZE step while in stage '${this._state.current_stage}'`,
      );
    }

    const effect_key = this._ports.effectGuard?.computeEffectKey({
      tenant_id: this._identity.tenant_id,
      skill_id: 'skill.mkt.evaluate_attribution',
      step_index: context.step_index,
      action_revision: context.action_revision,
      request_id: context.request_id,
    }) ?? computeEffectKey({
      tenant_id: this._identity.tenant_id,
      skill_id: 'skill.mkt.evaluate_attribution',
      step_index: context.step_index,
      action_revision: context.action_revision,
      request_id: context.request_id,
    });

    const attributionInput: MarketingAttributionInput = {
      tenant_id: this._identity.tenant_id,
      campaign_id: this._identity.campaign_id,
      effect_key,
      correlation_id: this._identity.correlation_id,
      attribution_model: input.attribution_model,
      evidence_ids: input.evidence_ids,
    };

    const attributionResult = await evaluateAttribution(
      attributionInput,
      context,
      this._ports,
    );

    this._state.attribution_result = attributionResult;
    return attributionResult;
  }

  private transitionTo(nextStage: CampaignLifecycleStage): void {
    assertValidCampaignTransition(this._state.current_stage, nextStage);
    this._state.current_stage = nextStage;
    this._state.visited_stages.push(nextStage);
  }

  /** Test seam to set current stage directly for targeted stage unit testing. */
  setStageForTesting(stage: CampaignLifecycleStage): void {
    this._state.current_stage = stage;
  }
}

/**
 * Creates a new Marketing Campaign Lifecycle coordinator.
 */
export function createCampaignLifecycle(
  identity: CampaignLifecycleContext,
  ports: MarketingRuntimePorts,
): CampaignLifecycle {
  return new CampaignLifecycle(identity, ports);
}
