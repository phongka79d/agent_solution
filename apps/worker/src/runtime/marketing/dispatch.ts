/**
 * @file Marketing Campaign Dispatch Seam (MKT-05, SCR-003, AUTH-4).
 *
 * Implements the isolated campaign dispatch execution boundary:
 * 1. Enforces tenant, run, and effect identity (NFR-006, BR-005).
 * 2. Rejects AUTH-5 hard deny immediately with zero provider calls (SRS §12).
 * 3. Requires caller agent MKT-05 and AUTH-4 human approval gate (SCR-003).
 * 4. Refuses any provider call before shared AUTH-4 release.
 * 5. Binds the exact reviewed payload digest to tenant_id+run_id+effect_key+payload_sha256
 *    and invalidates on any meaningful payload change.
 * 6. Validates blocking-free MKT-04 brand decision and authoritative price/promotion inputs.
 * 7. Enforces dispatch-time per-recipient consent/suppression recheck with missing consent denied (BR-004).
 * 8. Uses injected IEffectGuard for canonical reservation/replay/conflict/reconciliation:
 *    - Duplicate/replay returns the canonical replay receipt without another dispatch.
 * 9. Uses injected IAdapterDispatcher for provider calls:
 *    - Provider TIMEOUT/indeterminate leaves reservation UNKNOWN for reconcile, never blind retry.
 */

import {
  computeEffectKey,
  isAssignableAuthority,
  sha256CanonicalJson,
} from '@agentos/core-engine';
import type {
  ActionDraft,
  ExecutionReceipt,
} from '@agentos/core-engine/contracts';
import {
  type CampaignApprovalBinding,
  type CampaignDispatchInput,
  type CampaignDispatchOutput,
  type CampaignDispatchResult,
  type MarketingAuthoritativeValidation,
  type MarketingBrandAuditOutput,
  type MarketingConsentPort,
  type MarketingEvidence,
  type MarketingInvocationContext,
  type MarketingRuntimePorts,
  MarketingRuntimeError,
} from './contracts.js';

/** Canonical computation of payload SHA-256 using RFC 8785 canonical JSON. */
export function computeCampaignPayloadSha256(payload: Record<string, unknown>): string {
  return sha256CanonicalJson(payload);
}

/**
 * Binds the exact reviewed payload digest to tenant_id + run_id + effect_key + payload_sha256.
 * Any difference in tenant, run, effect, or payload invalidates the digest.
 */
export function computeReviewedDigest(params: {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly effect_key: string;
  readonly payload_sha256: string;
}): string {
  return `${params.tenant_id}:${params.run_id}:${params.effect_key}:${params.payload_sha256}`;
}

export interface RecipientConsentResult {
  readonly eligibleRecipients: readonly string[];
  readonly suppressedRecipients: readonly {
    readonly customer_id: string;
    readonly reason: string;
  }[];
}

/**
 * Dispatch-time per-recipient consent and suppression recheck (BR-004, NFR-008).
 * Missing consent is denied (fail closed).
 */
export async function checkRecipientConsents(
  recipients: readonly string[],
  tenant_id: string,
  channel: string,
  consentPort?: MarketingConsentPort,
): Promise<RecipientConsentResult> {
  const eligible: string[] = [];
  const suppressed: { customer_id: string; reason: string }[] = [];

  for (const customer_id of recipients) {
    if (!consentPort) {
      // Missing consent port -> missing consent denied (fail-closed)
      suppressed.push({
        customer_id,
        reason: 'CONSENT_PORT_UNAVAILABLE',
      });
      continue;
    }

    try {
      const decision = await consentPort.check({
        tenant_id,
        customer_id,
        channel,
      });

      if (decision.allowed && !decision.suppression_reason) {
        eligible.push(customer_id);
      } else {
        suppressed.push({
          customer_id,
          reason: decision.suppression_reason ?? 'CONSENT_DENIED',
        });
      }
    } catch {
      // Any check failure -> fail-closed, missing consent denied
      suppressed.push({
        customer_id,
        reason: 'CONSENT_CHECK_ERROR',
      });
    }
  }

  return {
    eligibleRecipients: Object.freeze(eligible),
    suppressedRecipients: Object.freeze(suppressed),
  };
}

/**
 * Validates authoritative claim, price, and promotion inputs (BR-001..003).
 * Refuses price-bearing dispatches with missing or breached floor price.
 */
export function validateAuthoritativeInputs(
  input: CampaignDispatchInput | Record<string, unknown>,
  authoritativeValidation?: MarketingAuthoritativeValidation,
): void {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new MarketingRuntimeError(
      'SCHEMA_VALIDATION_ERROR',
      'Input must be an object',
    );
  }
  const record = input as Record<string, unknown>;
  const rawPayload = record.payload;
  const payload =
    typeof rawPayload === 'object' && rawPayload !== null && !Array.isArray(rawPayload)
      ? (rawPayload as Record<string, unknown>)
      : undefined;

  // Conflict detection if both top-level and payload specify the field
  const topPrice = record.proposed_price;
  const payloadPrice = payload?.proposed_price;
  if (topPrice !== undefined && payloadPrice !== undefined && topPrice !== payloadPrice) {
    throw new MarketingRuntimeError(
      'APPROVAL_PAYLOAD_MISMATCH',
      `Payload proposed_price '${String(payloadPrice)}' conflicts with input proposed_price '${String(topPrice)}'`,
    );
  }
  const rawPrice = topPrice !== undefined ? topPrice : payloadPrice;

  const topDiscountPercent = record.discount_percent;
  const payloadDiscountPercent = payload?.discount_percent;
  if (topDiscountPercent !== undefined && payloadDiscountPercent !== undefined && topDiscountPercent !== payloadDiscountPercent) {
    throw new MarketingRuntimeError(
      'APPROVAL_PAYLOAD_MISMATCH',
      `Payload discount_percent '${String(payloadDiscountPercent)}' conflicts with input discount_percent '${String(topDiscountPercent)}'`,
    );
  }
  const rawDiscountPercent = topDiscountPercent !== undefined ? topDiscountPercent : payloadDiscountPercent;

  const topDiscountAmount = record.discount_amount;
  const payloadDiscountAmount = payload?.discount_amount;
  if (topDiscountAmount !== undefined && payloadDiscountAmount !== undefined && topDiscountAmount !== payloadDiscountAmount) {
    throw new MarketingRuntimeError(
      'APPROVAL_PAYLOAD_MISMATCH',
      `Payload discount_amount '${String(payloadDiscountAmount)}' conflicts with input discount_amount '${String(topDiscountAmount)}'`,
    );
  }
  const rawDiscountAmount = topDiscountAmount !== undefined ? topDiscountAmount : payloadDiscountAmount;

  const topOfferId = record.offer_id;
  const payloadOfferId = payload?.offer_id;
  if (topOfferId !== undefined && payloadOfferId !== undefined && topOfferId !== payloadOfferId) {
    throw new MarketingRuntimeError(
      'APPROVAL_PAYLOAD_MISMATCH',
      `Payload offer_id '${String(payloadOfferId)}' conflicts with input offer_id '${String(topOfferId)}'`,
    );
  }
  const rawOfferId = topOfferId !== undefined ? topOfferId : payloadOfferId;

  // Price-bearing verification
  if (rawPrice !== undefined) {
    if (typeof rawPrice !== 'number' || !Number.isFinite(rawPrice)) {
      throw new MarketingRuntimeError(
        'SCHEMA_VALIDATION_ERROR',
        'Proposed price must be a valid number',
      );
    }
    if (authoritativeValidation?.floor_price === undefined) {
      throw new MarketingRuntimeError(
        'P_FLOOR_UNAVAILABLE',
        'Authoritative floor price is unavailable; price-bearing campaign cannot be dispatched',
      );
    }
    if (rawPrice < authoritativeValidation.floor_price) {
      throw new MarketingRuntimeError(
        'ERR_FLOOR_PRICE_VIOLATION',
        `Proposed price ${rawPrice} is below authoritative floor ${authoritativeValidation.floor_price}`,
      );
    }
  }

  // Promotional discount validation (percent)
  if (rawDiscountPercent !== undefined) {
    if (typeof rawDiscountPercent !== 'number' || !Number.isFinite(rawDiscountPercent)) {
      throw new MarketingRuntimeError(
        'SCHEMA_VALIDATION_ERROR',
        'Discount percent must be a valid number',
      );
    }
    if (authoritativeValidation?.max_discount_percent === undefined) {
      throw new MarketingRuntimeError(
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        'Authoritative promotion validation is unavailable; promotional discount percent cannot be evaluated',
      );
    }
    if (rawDiscountPercent > authoritativeValidation.max_discount_percent || rawDiscountPercent < 0) {
      throw new MarketingRuntimeError(
        'DISCOUNT_LIMIT_EXCEEDED',
        `Discount percent ${rawDiscountPercent}% exceeds authoritative limit ${authoritativeValidation.max_discount_percent}%`,
      );
    }
  }

  // Promotional discount validation (amount)
  if (rawDiscountAmount !== undefined) {
    if (typeof rawDiscountAmount !== 'number' || !Number.isFinite(rawDiscountAmount)) {
      throw new MarketingRuntimeError(
        'SCHEMA_VALIDATION_ERROR',
        'Discount amount must be a valid number',
      );
    }
    if (authoritativeValidation?.max_discount_amount === undefined) {
      throw new MarketingRuntimeError(
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        'Authoritative promotion validation is unavailable; promotional discount amount cannot be evaluated',
      );
    }
    if (rawDiscountAmount > authoritativeValidation.max_discount_amount || rawDiscountAmount < 0) {
      throw new MarketingRuntimeError(
        'DISCOUNT_LIMIT_EXCEEDED',
        `Discount amount ${rawDiscountAmount} exceeds authoritative limit ${authoritativeValidation.max_discount_amount}`,
      );
    }
  }

  // Offer claim validation
  if (rawOfferId !== undefined) {
    if (typeof rawOfferId !== 'string' || rawOfferId.trim() === '') {
      throw new MarketingRuntimeError(
        'SCHEMA_VALIDATION_ERROR',
        'Offer id must be a non-empty string',
      );
    }
    if (!authoritativeValidation) {
      throw new MarketingRuntimeError(
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        'Authoritative validation is unavailable; offer claim cannot be evaluated',
      );
    }
    if (
      authoritativeValidation.approved_claims !== undefined &&
      !authoritativeValidation.approved_claims.includes(rawOfferId)
    ) {
      throw new MarketingRuntimeError(
        'ERR_UNAPPROVED_CLAIM',
        `Offer '${rawOfferId}' is not in authoritative approved claims`,
      );
    }
  }
}


/**
 * Requires a blocking-free MKT-04 brand decision (BR-002, BR-009).
 */
export function assertBrandReviewBlockingFree(
  brandReview?: MarketingBrandAuditOutput,
): void {
  if (!brandReview) {
    throw new MarketingRuntimeError(
      'BRAND_REVIEW_REQUIRED',
      'A present brand review is required; campaign cannot be dispatched without brand compliance audit',
    );
  }
  if (!brandReview.compliant) {
    throw new MarketingRuntimeError(
      'BRAND_REVIEW_FAILED',
      'Brand compliance audit did not pass; cannot dispatch unapproved content',
    );
  }
  const blockingViolation = brandReview.violations.find((v) => v.severity === 'BLOCKING');
  if (blockingViolation) {
    throw new MarketingRuntimeError(
      'BRAND_REVIEW_BLOCKING',
      `Brand audit contains blocking violation: ${blockingViolation.rule_id} (${blockingViolation.snippet})`,
    );
  }
}

/**
 * Verifies the reviewed approval payload digest binding.
 * Throws APPROVAL_DIGEST_MISMATCH on any tenant, run, effect, or payload difference.
 */
export function verifyApprovalDigestBinding(
  binding: CampaignApprovalBinding,
  expected: {
    readonly tenant_id: string;
    readonly run_id: string;
    readonly effect_key: string;
    readonly payload_sha256: string;
  },
): void {
  if (binding.tenant_id !== expected.tenant_id) {
    throw new MarketingRuntimeError(
      'APPROVAL_DIGEST_MISMATCH',
      `Approval tenant mismatch: expected ${expected.tenant_id}, got ${binding.tenant_id}`,
    );
  }
  if (binding.run_id !== expected.run_id) {
    throw new MarketingRuntimeError(
      'APPROVAL_DIGEST_MISMATCH',
      `Approval run_id mismatch: expected ${expected.run_id}, got ${binding.run_id}`,
    );
  }
  if (binding.effect_key !== expected.effect_key) {
    throw new MarketingRuntimeError(
      'APPROVAL_DIGEST_MISMATCH',
      `Approval effect_key mismatch: expected ${expected.effect_key}, got ${binding.effect_key}`,
    );
  }
  if (binding.payload_sha256 !== expected.payload_sha256) {
    throw new MarketingRuntimeError(
      'APPROVAL_DIGEST_MISMATCH',
      `Payload digest mismatch: expected ${expected.payload_sha256}, got ${binding.payload_sha256}. Payload was altered after review.`,
    );
  }
  const expectedDigest = computeReviewedDigest(expected);
  if (binding.reviewed_digest !== expectedDigest) {
    throw new MarketingRuntimeError(
      'APPROVAL_DIGEST_MISMATCH',
      `Reviewed digest mismatch: expected ${expectedDigest}, got ${binding.reviewed_digest}`,
    );
  }
}

export interface DispatchCampaignOptions {
  readonly brandReview?: MarketingBrandAuditOutput;
  readonly authoritativeValidation?: MarketingAuthoritativeValidation;
  readonly approvalBinding?: CampaignApprovalBinding;
  readonly authorityVerdict?: string;
  readonly expected_task_version?: number;
  readonly checkpointBinding?: {
    readonly expected_task_version: number;
    readonly checkpoint?: unknown;
  };
}

/**
 * Executes the Marketing Campaign Dispatch Seam.
 */
export async function dispatchCampaign(
  input: CampaignDispatchInput,
  context: MarketingInvocationContext,
  ports: MarketingRuntimePorts,
  options: DispatchCampaignOptions = {},
): Promise<CampaignDispatchResult> {
  const now = ports.now ?? (() => new Date());
  let idCounter = 0;
  const newId = ports.newId ?? (() => `mkt-dsp-${Date.now()}-${++idCounter}`);

  // 1. Enforce tenant identity
  if (input.tenant_id !== context.tenant_id) {
    throw new MarketingRuntimeError(
      'TENANT_MISMATCH',
      `Input tenant '${input.tenant_id}' does not match server-resolved context '${context.tenant_id}'`,
    );
  }
  if (!input.campaign_id || !input.segment_id || !input.channel) {
    throw new MarketingRuntimeError(
      'SCHEMA_VALIDATION_ERROR',
      'campaign_id, segment_id, and channel are required',
    );
  }

  // 2. Reject AUTH-5 hard deny immediately via explicit verdict/input seam
  if (
    input.authority_verdict === 'AUTH-5' ||
    options.authorityVerdict === 'AUTH-5' ||
    input.payload?.authority_verdict === 'AUTH-5' ||
    (context as Record<string, unknown>).authority_verdict === 'AUTH-5'
  ) {
    await ports.audit.append({
      tenant_id: context.tenant_id,
      run_id: context.run_id,
      correlation_id: context.correlation_id,
      effect_key: 'uncomputed',
      skill_id: 'skill.mkt.dispatch_campaign',
      outcome: 'DENIED',
      reason: 'AUTH-5 is strictly prohibited; hard deny',
      evidence_ids: [],
      occurred_at: now().toISOString(),
    });
    throw new MarketingRuntimeError(
      'AUTH_5_PROHIBITED',
      'AUTH-5 is strictly prohibited; hard deny. Never queued, never approvable, never dispatched.',
    );
  }

  // 3. Enforce canonical grant boundary (AUTH-0..AUTH-3 only)
  if (!isAssignableAuthority(context.granted_authority)) {
    throw new MarketingRuntimeError(
      'INVALID_CLEARANCE',
      `granted_authority '${String(context.granted_authority)}' is not an assignable authority (BR-008)`,
    );
  }

  // 4. Enforce allowed agent MKT-05
  if (context.caller_agent !== 'MKT-05') {
    throw new MarketingRuntimeError(
      'UNAUTHORIZED_AGENT',
      `Caller agent '${context.caller_agent}' is not authorized for campaign dispatch (only MKT-05 allowed)`,
    );
  }

  // 5. Compute deterministic effect key
  const effect_key = ports.effectGuard?.computeEffectKey({
    tenant_id: context.tenant_id,
    skill_id: 'skill.mkt.dispatch_campaign',
    step_index: context.step_index,
    action_revision: context.action_revision,
    request_id: context.request_id,
  }) ?? computeEffectKey({
    tenant_id: context.tenant_id,
    skill_id: 'skill.mkt.dispatch_campaign',
    step_index: context.step_index,
    action_revision: context.action_revision,
    request_id: context.request_id,
  });

  // 6. Brand review compliance (blocking-free)
  assertBrandReviewBlockingFree(options.brandReview);

  // 7. Reject conflicts between input.payload and explicit input fields (Defect 2)
  if (input.payload) {
    const p = input.payload;
    if (p.tenant_id !== undefined && p.tenant_id !== input.tenant_id) {
      throw new MarketingRuntimeError(
        'APPROVAL_PAYLOAD_MISMATCH',
        `Payload tenant_id '${String(p.tenant_id)}' conflicts with input tenant_id '${input.tenant_id}'`,
      );
    }
    if (p.campaign_id !== undefined && p.campaign_id !== input.campaign_id) {
      throw new MarketingRuntimeError(
        'APPROVAL_PAYLOAD_MISMATCH',
        `Payload campaign_id '${String(p.campaign_id)}' conflicts with input campaign_id '${input.campaign_id}'`,
      );
    }
    if (p.segment_id !== undefined && p.segment_id !== input.segment_id) {
      throw new MarketingRuntimeError(
        'APPROVAL_PAYLOAD_MISMATCH',
        `Payload segment_id '${String(p.segment_id)}' conflicts with input segment_id '${input.segment_id}'`,
      );
    }
    if (p.channel !== undefined && p.channel !== input.channel) {
      throw new MarketingRuntimeError(
        'APPROVAL_PAYLOAD_MISMATCH',
        `Payload channel '${String(p.channel)}' conflicts with input channel '${input.channel}'`,
      );
    }
    if (p.approved_content_id !== undefined && p.approved_content_id !== input.approved_content_id) {
      throw new MarketingRuntimeError(
        'APPROVAL_PAYLOAD_MISMATCH',
        `Payload approved_content_id '${String(p.approved_content_id)}' conflicts with input approved_content_id '${input.approved_content_id}'`,
      );
    }
    if (p.content_id !== undefined && p.content_id !== input.approved_content_id) {
      throw new MarketingRuntimeError(
        'APPROVAL_PAYLOAD_MISMATCH',
        `Payload content_id '${String(p.content_id)}' conflicts with input approved_content_id '${input.approved_content_id}'`,
      );
    }
    if (p.recipients !== undefined) {
      if (!Array.isArray(p.recipients)) {
        throw new MarketingRuntimeError(
          'SCHEMA_VALIDATION_ERROR',
          'Payload recipients must be an array',
        );
      }
      if (input.recipients !== undefined) {
        if (
          !Array.isArray(input.recipients) ||
          p.recipients.length !== input.recipients.length ||
          p.recipients.some((r: unknown, idx: number) => r !== input.recipients![idx])
        ) {
          throw new MarketingRuntimeError(
            'APPROVAL_PAYLOAD_MISMATCH',
            'Payload recipients conflict with input recipients',
          );
        }
      }
    }
    if (p.offer_id !== undefined && input.offer_id !== undefined && p.offer_id !== input.offer_id) {
      throw new MarketingRuntimeError(
        'APPROVAL_PAYLOAD_MISMATCH',
        `Payload offer_id '${String(p.offer_id)}' conflicts with input offer_id '${input.offer_id}'`,
      );
    }
    if (p.discount_amount !== undefined && input.discount_amount !== undefined && p.discount_amount !== input.discount_amount) {
      throw new MarketingRuntimeError(
        'APPROVAL_PAYLOAD_MISMATCH',
        `Payload discount_amount '${String(p.discount_amount)}' conflicts with input discount_amount '${input.discount_amount}'`,
      );
    }
    if (p.discount_percent !== undefined && input.discount_percent !== undefined && p.discount_percent !== input.discount_percent) {
      throw new MarketingRuntimeError(
        'APPROVAL_PAYLOAD_MISMATCH',
        `Payload discount_percent '${String(p.discount_percent)}' conflicts with input discount_percent '${input.discount_percent}'`,
      );
    }
    if (p.proposed_price !== undefined && input.proposed_price !== undefined && p.proposed_price !== input.proposed_price) {
      throw new MarketingRuntimeError(
        'APPROVAL_PAYLOAD_MISMATCH',
        `Payload proposed_price '${String(p.proposed_price)}' conflicts with input proposed_price '${input.proposed_price}'`,
      );
    }
  }
  if (input.recipients !== undefined && !Array.isArray(input.recipients)) {
    throw new MarketingRuntimeError(
      'SCHEMA_VALIDATION_ERROR',
      'Input recipients must be an array',
    );
  }


  // 8. Assemble canonical payload and reviewed digest (Use one exact payload for approval binding and ActionDraft)
  const canonicalPayload: Record<string, unknown> = {
    ...(input.payload ?? {}),
    tenant_id: input.tenant_id,
    campaign_id: input.campaign_id,
    segment_id: input.segment_id,
    channel: input.channel,
    approved_content_id: input.approved_content_id,
    recipients: input.recipients ?? (Array.isArray(input.payload?.recipients) ? input.payload.recipients : []),
    ...(input.offer_id !== undefined ? { offer_id: input.offer_id } : {}),
    ...(input.discount_amount !== undefined ? { discount_amount: input.discount_amount } : {}),
    ...(input.discount_percent !== undefined ? { discount_percent: input.discount_percent } : {}),
    ...(input.proposed_price !== undefined ? { proposed_price: input.proposed_price } : {}),
  };
  // Derive one recipient list from the exact canonical payload and validate it
  const canonicalRecipientsRaw = canonicalPayload.recipients;
  if (!Array.isArray(canonicalRecipientsRaw)) {
    throw new MarketingRuntimeError(
      'SCHEMA_VALIDATION_ERROR',
      'Canonical payload recipients must be an array',
    );
  }
  for (const r of canonicalRecipientsRaw) {
    if (typeof r !== 'string' || r.trim() === '') {
      throw new MarketingRuntimeError(
        'SCHEMA_VALIDATION_ERROR',
        'Canonical payload recipients must only contain non-empty strings',
      );
    }
  }
  const canonicalRecipients: readonly string[] = canonicalRecipientsRaw as readonly string[];

  if (canonicalRecipients.length === 0) {
    throw new MarketingRuntimeError(
      'AUDIENCE_REQUIRED',
      'Canonical recipient list is empty; audience/recipients required (RECIPIENTS_REQUIRED: cannot dispatch with zero recipients or segment_id alone)',
    );
  }


  // Authoritative price, promotion, and offer claim validation
  // Normalize effective claim fields onto canonicalPayload and validate exact values before approval / provider dispatch
  validateAuthoritativeInputs(
    canonicalPayload,
    options.authoritativeValidation,
  );
  const effectivePrice = canonicalPayload.proposed_price as number | undefined;

  const initialPayloadSha256 = computeCampaignPayloadSha256(canonicalPayload);
  const initialReviewedDigest = computeReviewedDigest({
    tenant_id: context.tenant_id,
    run_id: context.run_id,
    effect_key,
    payload_sha256: initialPayloadSha256,
  });

  // 9. Dispatch-time per-recipient consent/suppression recheck (BR-004, NFR-008)
  // Recheck canonical recipient list immediately before approval verification / reservation / provider dispatch
  let eligibleRecipients: readonly string[] = canonicalRecipients;
  let suppressedCount = 0;

  if (canonicalRecipients.length > 0) {
    const consentResult = await checkRecipientConsents(
      canonicalRecipients,
      context.tenant_id,
      input.channel,
      ports.consent,
    );
    eligibleRecipients = consentResult.eligibleRecipients;
    suppressedCount = consentResult.suppressedRecipients.length;

    if (eligibleRecipients.length === 0) {
      await ports.audit.append({
        tenant_id: context.tenant_id,
        run_id: context.run_id,
        correlation_id: context.correlation_id,
        effect_key,
        skill_id: 'skill.mkt.dispatch_campaign',
        outcome: 'DENIED',
        reason: `All ${canonicalRecipients.length} recipients were denied or suppressed by consent recheck`,
        evidence_ids: [],
        occurred_at: now().toISOString(),
      });
      throw new MarketingRuntimeError(
        'CONSENT_SUPPRESSION_ALL_DENIED',
        `All ${canonicalRecipients.length} recipients were denied or suppressed by consent recheck; missing consent denied`,
      );
    }
  }

  // Derive filtered canonical payload and compute new payload_sha256 / reviewed_digest if any recipient was suppressed
  const targetPayload: Record<string, unknown> =
    suppressedCount > 0
      ? {
          ...canonicalPayload,
          recipients: eligibleRecipients,
        }
      : canonicalPayload;

  const targetPayloadSha256 =
    suppressedCount > 0
      ? computeCampaignPayloadSha256(targetPayload)
      : initialPayloadSha256;

  const targetReviewedDigest =
    suppressedCount > 0
      ? computeReviewedDigest({
          tenant_id: context.tenant_id,
          run_id: context.run_id,
          effect_key,
          payload_sha256: targetPayloadSha256,
        })
      : initialReviewedDigest;

  // 10. Shared AUTH-4 human approval gate (refuse any reservation / provider call before release matching target payload digest)
  const approvalBinding = options.approvalBinding;
  if (!approvalBinding) {
    // If workflowEngine is provided, checkpoint the pause atomically
    if (ports.workflowEngine) {
      const expectedTaskVersion =
        options.expected_task_version ??
        options.checkpointBinding?.expected_task_version ??
        (context as Record<string, unknown>).expected_task_version ??
        (context as Record<string, unknown>).task_version;

      if (
        expectedTaskVersion === undefined ||
        typeof expectedTaskVersion !== 'number' ||
        !Number.isInteger(expectedTaskVersion) ||
        expectedTaskVersion < 1
      ) {
        throw new MarketingRuntimeError(
          'TASK_VERSION_REQUIRED',
          'Server-supplied expected_task_version is required for workflowEngine pause checkpoint (fail closed)',
        );
      }

      await ports.workflowEngine.pauseForApproval({
        tenant_id: context.tenant_id,
        run_id: context.run_id,
        expected_task_version: expectedTaskVersion,
        checkpoint: {
          stage: 'APPROVAL',
          effect_key,
          payload_sha256: targetPayloadSha256,
          reviewed_digest: targetReviewedDigest,
        },
        approval: {
          action_id: `action-${context.request_id}`,
          effect_key,
          payload: targetPayload,
          reason: 'Campaign dispatch requires human approval (AUTH-4) at SCR-003',
        },
      });
    }
    throw new MarketingRuntimeError(
      'APPROVAL_REQUIRED',
      'Campaign dispatch requires shared AUTH-4 approval release at SCR-003; provider call refused',
    );
  }

  // If dispatch-time consent suppressed recipients, require a released CampaignApprovalBinding matching the filtered digest
  if (
    suppressedCount > 0 &&
    (approvalBinding.payload_sha256 === initialPayloadSha256 ||
      approvalBinding.reviewed_digest === initialReviewedDigest)
  ) {
    throw new MarketingRuntimeError(
      'APPROVAL_DIGEST_MISMATCH',
      `Approval digest is stale: dispatch-time consent suppressed ${suppressedCount} recipient(s); re-review required under updated digest (expected ${targetPayloadSha256}, got ${approvalBinding.payload_sha256})`,
    );
  }

  // Verify reviewed digest matches the exact target payload
  verifyApprovalDigestBinding(approvalBinding, {
    tenant_id: context.tenant_id,
    run_id: context.run_id,
    effect_key,
    payload_sha256: targetPayloadSha256,
  });

  if (!approvalBinding.claimed || approvalBinding.decision !== 'APPROVED') {
    throw new MarketingRuntimeError(
      'APPROVAL_NOT_RELEASED',
      `Approval ${approvalBinding.approval_id} is not released (decision: ${approvalBinding.decision}, claimed: ${approvalBinding.claimed}); provider call refused`,
    );
  }

  // 11. Durable effect reservation (IEffectGuard)
  if (!ports.effectGuard) {
    throw new MarketingRuntimeError(
      'EFFECT_GUARD_UNAVAILABLE',
      'IEffectGuard port is required for mutating campaign dispatch',
    );
  }

  const reservation = await ports.effectGuard.reserve({
    tenant_id: context.tenant_id,
    run_id: context.run_id,
    request_id: context.request_id,
    effect_key,
    request_fingerprint: targetPayloadSha256,
    skill_id: 'skill.mkt.dispatch_campaign',
    step_index: context.step_index,
    action_revision: context.action_revision,
  });

  // Replay check
  if (reservation.kind === 'REPLAY') {
    const receipt = reservation.receipt as ExecutionReceipt | undefined;
    const output: CampaignDispatchOutput = {
      dispatch_id: receipt?.execution_id ?? `dsp-replay-${effect_key.slice(0, 8)}`,
      recipient_count: eligibleRecipients.length,
      suppressed_count: suppressedCount,
      status: receipt?.adapter_status === 'SUCCESS' ? 'COMPLETED' : 'ENQUEUED',
      dispatched_at: now().toISOString(),
      execution_receipt: receipt,
      replayed: true,
    };
    const auditRecord = {
      tenant_id: context.tenant_id,
      run_id: context.run_id,
      correlation_id: context.correlation_id,
      effect_key,
      skill_id: 'skill.mkt.dispatch_campaign',
      outcome: 'SUCCEEDED' as const,
      reason: 'Replayed canonical campaign dispatch receipt without duplicate provider call',
      evidence_ids: [],
      occurred_at: now().toISOString(),
    };
    await ports.audit.append(auditRecord);
    return {
      skill_id: 'skill.mkt.dispatch_campaign',
      effect_key,
      output,
      evidence: [],
      audit: auditRecord,
    };
  }

  if (reservation.kind === 'CONFLICT') {
    throw new MarketingRuntimeError(
      'IDEMPOTENCY_CONFLICT',
      `Effect key '${effect_key}' has already been reserved with a different payload`,
    );
  }

  if (reservation.kind === 'IN_FLIGHT') {
    throw new MarketingRuntimeError(
      'CONCURRENT_DISPATCH',
      `Effect key '${effect_key}' is currently in flight`,
    );
  }

  if (reservation.kind === 'RECONCILE_REQUIRED') {
    const recon = await reconcileCampaignDispatch({
      tenant_id: context.tenant_id,
      effect_key,
      skill_id: 'skill.mkt.dispatch_campaign',
      ports,
    });
    if (recon.outcome === 'SUCCEEDED' && isConfirmedExecutionReceipt(recon.receipt)) {
      const output: CampaignDispatchOutput = {
        dispatch_id:
          (recon.receipt as ExecutionReceipt)?.execution_id ??
          `dsp-recon-${effect_key.slice(0, 8)}`,
        recipient_count: eligibleRecipients.length,
        suppressed_count: suppressedCount,
        status: 'COMPLETED',
        dispatched_at: now().toISOString(),
        execution_receipt: recon.receipt,
        replayed: true,
      };
      const auditRecord = {
        tenant_id: context.tenant_id,
        run_id: context.run_id,
        correlation_id: context.correlation_id,
        effect_key,
        skill_id: 'skill.mkt.dispatch_campaign',
        outcome: 'SUCCEEDED' as const,
        reason: 'Reconciliation confirmed prior successful dispatch',
        evidence_ids: [],
        occurred_at: now().toISOString(),
      };
      await ports.audit.append(auditRecord);
      return {
        skill_id: 'skill.mkt.dispatch_campaign',
        effect_key,
        output,
        evidence: [],
        audit: auditRecord,
      };
    }
    if (recon.outcome === 'FAILED') {
      // (5) On confirmed reconciliation failure, reopen the same effect key through IEffectGuard.reopenForRetry before any re-dispatch
      if (!ports.effectGuard.reopenForRetry) {
        throw new MarketingRuntimeError(
          'RECONCILIATION_REOPEN_FAILED',
          `Effect key '${effect_key}' failed reconciliation and IEffectGuard.reopenForRetry is unavailable; refusing re-dispatch`,
        );
      }
      const reopened = await ports.effectGuard.reopenForRetry({
        tenant_id: context.tenant_id,
        effect_key,
      });
      if (reopened !== true) {
        throw new MarketingRuntimeError(
          'RECONCILIATION_REOPEN_FAILED',
          `Effect key '${effect_key}' failed reconciliation and reopenForRetry returned false; refusing re-dispatch`,
        );
      }
    } else {
      throw new MarketingRuntimeError(
        'RECONCILE_INDETERMINATE',
        `Prior dispatch for effect key '${effect_key}' is indeterminate; left UNKNOWN, never blind retry`,
      );
    }
  }

  // 11. Provider call via IAdapterDispatcher
  if (!ports.dispatcher) {
    throw new MarketingRuntimeError(
      'DISPATCHER_UNAVAILABLE',
      'IAdapterDispatcher port is required for campaign broadcast delivery',
    );
  }

  const actionDraft: ActionDraft = {
    action_id: `act-${newId()}`,
    run_id: context.run_id,
    tenant_id: context.tenant_id,
    agent_id: 'MKT-05',
    skill_id: 'skill.mkt.dispatch_campaign',
    adapter_target: 'API-003.CommunicationConnector',
    step_index: context.step_index,
    mutating: true,
    price_bearing: effectivePrice !== undefined,
    request_id: context.request_id,
    action_revision: context.action_revision,
    effect_key,
    required_authority: 'AUTH-4',
    payload: targetPayload,
    approval_payload_digest: targetReviewedDigest,
    approval_id: approvalBinding.approval_id,
    ...(effectivePrice !== undefined ? { proposed_price: effectivePrice } : {}),
    ...(options.authoritativeValidation?.floor_price !== undefined
      ? {
          computed_price_floor: options.authoritativeValidation.floor_price,
          floor_source: options.authoritativeValidation.floor_source ?? 'ERP',
        }
      : {}),
  };

  let receipt: ExecutionReceipt;
  try {
    receipt = await ports.dispatcher.dispatch(actionDraft, { timeout_ms: 5000 });
  } catch (err: unknown) {
    // Provider timeout or indeterminate transport error:
    // MUST leave reservation UNKNOWN for reconcile, never blind retry!
    await ports.audit.append({
      tenant_id: context.tenant_id,
      run_id: context.run_id,
      correlation_id: context.correlation_id,
      effect_key,
      skill_id: 'skill.mkt.dispatch_campaign',
      outcome: 'DENIED',
      reason: `Provider call threw: ${(err as Error)?.message ?? 'network timeout'}; left UNKNOWN for reconcile`,
      evidence_ids: [],
      occurred_at: now().toISOString(),
    });
    throw new MarketingRuntimeError(
      'DISPATCH_TIMEOUT',
      `Provider call timed out or failed indeterminately: ${(err as Error)?.message}; effect left UNKNOWN for reconcile`,
    );
  }

  // Handle TIMEOUT status from provider receipt
  if (receipt.adapter_status === 'TIMEOUT') {
    await ports.audit.append({
      tenant_id: context.tenant_id,
      run_id: context.run_id,
      correlation_id: context.correlation_id,
      effect_key,
      skill_id: 'skill.mkt.dispatch_campaign',
      outcome: 'DENIED',
      reason: 'Provider dispatch returned TIMEOUT; reservation left UNKNOWN for reconcile',
      evidence_ids: [],
      occurred_at: now().toISOString(),
    });
    throw new MarketingRuntimeError(
      'DISPATCH_TIMEOUT',
      'Provider dispatch timed out; effect left UNKNOWN for reconciliation, never blind retry',
    );
  }

  // Handle provider confirmed ERROR
  if (receipt.adapter_status === 'ERROR') {
    await ports.effectGuard.resolve({
      tenant_id: context.tenant_id,
      effect_key,
      status: 'FAILED',
      receipt,
    });
    await ports.audit.append({
      tenant_id: context.tenant_id,
      run_id: context.run_id,
      correlation_id: context.correlation_id,
      effect_key,
      skill_id: 'skill.mkt.dispatch_campaign',
      outcome: 'DENIED',
      reason: 'Provider returned execution error',
      evidence_ids: [],
      occurred_at: now().toISOString(),
    });
    throw new MarketingRuntimeError('DISPATCH_FAILED', 'Provider returned error status');
  }

  // 12. Provider success settlement & receipt completeness validation
  // Provider communication dispatch must settle SUCCESS only when the ExecutionReceipt
  // has adapter_status === SUCCESS and a non-empty provider_reference.
  // If status is SUCCESS but provider_reference is missing/empty or receipt is otherwise incomplete,
  // leave the effect reservation unsettled for reconciliation, append a denied/unknown audit,
  // and fail closed with an explicit DISPATCH_UNKNOWN/RECEIPT_UNCONFIRMED error; never resolve SUCCEEDED or call it delivered.
  const isReceiptObject = receipt !== null && typeof receipt === 'object';
  const rawProviderRef =
    isReceiptObject && typeof receipt.provider_reference === 'string'
      ? receipt.provider_reference.trim()
      : undefined;
  const executionId =
    isReceiptObject && typeof receipt.execution_id === 'string'
      ? receipt.execution_id.trim()
      : undefined;

  // Build evidence source URI/version only from confirmed provider data (for example provider_reference, or an explicitly provider-supplied version)
  const explicitProviderVersion =
    isReceiptObject &&
    typeof receipt.response_payload === 'object' &&
    receipt.response_payload !== null
      ? (typeof receipt.response_payload['version'] === 'string' &&
        receipt.response_payload['version'].trim().length > 0
          ? receipt.response_payload['version'].trim()
          : typeof receipt.response_payload['provider_version'] === 'string' &&
            receipt.response_payload['provider_version'].trim().length > 0
            ? receipt.response_payload['provider_version'].trim()
            : typeof receipt.response_payload['source_version'] === 'string' &&
              receipt.response_payload['source_version'].trim().length > 0
              ? receipt.response_payload['source_version'].trim()
              : undefined)
      : undefined;

  const confirmedSourceVersion = explicitProviderVersion ?? (rawProviderRef && rawProviderRef.length > 0 ? rawProviderRef : undefined);
  const confirmedSourceUri =
    isReceiptObject &&
    typeof receipt.response_payload === 'object' &&
    receipt.response_payload !== null &&
    typeof receipt.response_payload['source_uri'] === 'string' &&
    receipt.response_payload['source_uri'].trim().length > 0
      ? receipt.response_payload['source_uri'].trim()
      : executionId && executionId.length > 0
        ? `api-003://communication/${executionId}`
        : undefined;

  const isConfirmedSuccess =
    isReceiptObject &&
    receipt.adapter_status === 'SUCCESS' &&
    Boolean(rawProviderRef && rawProviderRef.length > 0) &&
    Boolean(executionId && executionId.length > 0) &&
    Boolean(confirmedSourceVersion && confirmedSourceVersion.length > 0) &&
    Boolean(confirmedSourceUri && confirmedSourceUri.length > 0);

  if (!isConfirmedSuccess) {
    await ports.audit.append({
      tenant_id: context.tenant_id,
      run_id: context.run_id,
      correlation_id: context.correlation_id,
      effect_key,
      skill_id: 'skill.mkt.dispatch_campaign',
      outcome: 'DENIED',
      reason:
        !isReceiptObject || !executionId
          ? 'ExecutionReceipt is incomplete; reservation left UNKNOWN for reconciliation'
          : receipt.adapter_status === 'SUCCESS' && (!rawProviderRef || rawProviderRef.length === 0)
            ? 'ExecutionReceipt has status SUCCESS but missing or empty provider_reference; reservation left UNKNOWN for reconciliation'
            : !confirmedSourceVersion || !confirmedSourceUri
              ? 'Required evidence fields absent from confirmed provider data; reservation left UNKNOWN for reconciliation'
              : `Provider returned unconfirmed status '${String(receipt?.adapter_status)}'; reservation left UNKNOWN for reconciliation`,
      evidence_ids: [],
      occurred_at: now().toISOString(),
    });
    throw new MarketingRuntimeError(
      'DISPATCH_UNKNOWN',
      'RECEIPT_UNCONFIRMED: ExecutionReceipt has status SUCCESS but missing/empty provider_reference or incomplete receipt; effect left UNKNOWN for reconciliation',
    );
  }

  // 13. Confirmed Success: resolve effect guard, persist evidence, append audit
  await ports.effectGuard.resolve({
    tenant_id: context.tenant_id,
    effect_key,
    status: 'SUCCEEDED',
    receipt,
  });

  const evidence: MarketingEvidence = {
    evidence_id: newId(),
    tenant_id: context.tenant_id,
    run_id: context.run_id,
    correlation_id: context.correlation_id,
    effect_key,
    classification: 'FACT',
    source_uri: confirmedSourceUri!,
    source_version: confirmedSourceVersion!,
    claim: `Campaign ${input.campaign_id} successfully dispatched to ${eligibleRecipients.length} recipients via ${input.channel}`,
  };

  const persistedEvidenceId = await ports.evidence.append([evidence], context, effect_key);

  const auditRecord = {
    tenant_id: context.tenant_id,
    run_id: context.run_id,
    correlation_id: context.correlation_id,
    effect_key,
    skill_id: 'skill.mkt.dispatch_campaign',
    outcome: 'SUCCEEDED' as const,
    reason: `Campaign dispatched to ${eligibleRecipients.length} recipient(s)`,
    evidence_ids: [persistedEvidenceId],
    occurred_at: now().toISOString(),
  };

  await ports.audit.append(auditRecord);

  const output: CampaignDispatchOutput = {
    dispatch_id: receipt.execution_id,
    recipient_count: eligibleRecipients.length,
    suppressed_count: suppressedCount,
    status: 'COMPLETED',
    dispatched_at: now().toISOString(),
    execution_receipt: receipt,
  };

  return {
    skill_id: 'skill.mkt.dispatch_campaign',
    effect_key,
    output,
    evidence: [evidence],
    audit: auditRecord,
  };
}

/**
 * Verifies that an ExecutionReceipt is grounded and confirmed:
 * - Receipt is a non-null object
 * - adapter_status is strictly 'SUCCESS'
 * - provider_reference is a non-empty string
 * - execution_id is a non-empty string
 */
export function isConfirmedExecutionReceipt(receipt: unknown): receipt is ExecutionReceipt {
  if (receipt === null || typeof receipt !== 'object') {
    return false;
  }
  const r = receipt as Partial<ExecutionReceipt>;
  if (r.adapter_status !== 'SUCCESS') {
    return false;
  }
  if (typeof r.provider_reference !== 'string' || r.provider_reference.trim().length === 0) {
    return false;
  }
  if (typeof r.execution_id !== 'string' || r.execution_id.trim().length === 0) {
    return false;
  }
  return true;
}

/**
 * Reconciles an unsettled campaign dispatch effect (NFR-004, §4.4).
 */
export async function reconcileCampaignDispatch(params: {
  readonly tenant_id: string;
  readonly effect_key: string;
  readonly skill_id?: string;
  readonly ports: MarketingRuntimePorts;
}): Promise<{ outcome: 'SUCCEEDED' | 'FAILED' | 'INDETERMINATE'; receipt?: unknown }> {
  const { tenant_id, effect_key, ports } = params;

  if (ports.dispatcher?.reconcile) {
    const recon = await ports.dispatcher.reconcile({
      tenant_id,
      effect_key,
      adapter_target: 'API-003.CommunicationConnector',
      skill_id: params.skill_id ?? 'skill.mkt.dispatch_campaign',
    });
    if (recon.outcome === 'SUCCEEDED') {
      if (isConfirmedExecutionReceipt(recon.receipt)) {
        if (ports.effectGuard) {
          await ports.effectGuard.resolve({
            tenant_id,
            effect_key,
            status: 'SUCCEEDED',
            receipt: recon.receipt,
          });
        }
        return recon;
      }
      return { outcome: 'INDETERMINATE' };
    } else if (recon.outcome === 'FAILED' && ports.effectGuard) {
      await ports.effectGuard.resolve({
        tenant_id,
        effect_key,
        status: 'FAILED',
        receipt: recon.receipt,
      });
      return recon;
    }
    return recon;
  }

  if (ports.effectGuard) {
    const recon = await ports.effectGuard.reconcile({
      tenant_id,
      effect_key,
      skill_id: params.skill_id ?? 'skill.mkt.dispatch_campaign',
    });
    if (recon.outcome === 'SUCCEEDED' && !isConfirmedExecutionReceipt(recon.receipt)) {
      return { outcome: 'INDETERMINATE' };
    }
    return recon;
  }

  return { outcome: 'INDETERMINATE' };
}
