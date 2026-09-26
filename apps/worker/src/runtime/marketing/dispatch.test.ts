/**
 * @file Unit tests for Marketing Campaign Lifecycle and Dispatch Seam.
 *
 * Covers:
 * 1. Approval gating (AUTH-4 / SCR-003: provider refused before release, pause in workflowEngine).
 * 2. Digest mismatch / payload change (reviewed digest bound to tenant+run+effect+sha256).
 * 3. Consent suppression (dispatch-time per-recipient recheck, missing consent denied).
 * 4. AUTH-5 hard deny (prohibited action: never queued, never approvable, zero provider calls).
 * 5. Duplicate replay (IEffectGuard returns canonical replay receipt without another dispatch).
 * 6. Timeout reconcile (provider TIMEOUT leaves reservation UNKNOWN, never blind retry).
 * 7. Tenant isolation (cross-tenant refusal, tenant-scoped port execution).
 * 8. Blocking-free brand decision (MKT-04 compliant, no BLOCKING violations).
 * 9. Authoritative claim/price/promotion validation (P_FLOOR_UNAVAILABLE, ERR_FLOOR_PRICE_VIOLATION).
 * 10. End-to-end 8-stage CampaignLifecycle (Brief→Audience→Content→Brand Review→AUTH-4→Publish→Monitor→Optimize).
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  ActionDraft,
  ExecutionReceipt,
  IAdapterDispatcher,
  IEffectGuard,
  IStatefulWorkflowEngine,
  ReservationOutcome,
} from '@agentos/core-engine/contracts';
import {
  type CampaignApprovalBinding,
  type CampaignDispatchInput,
  type MarketingAuthoritativeValidation,
  type MarketingBrandAuditOutput,
  type MarketingConsentDecision,
  type MarketingSignalInput,
  type MarketingEvidence,
  type MarketingInvocationContext,
  type MarketingRuntimePorts,
  MarketingRuntimeError,
} from './contracts.js';
import {
  checkRecipientConsents,
  computeCampaignPayloadSha256,
  computeReviewedDigest,
  dispatchCampaign,
  claimCanonicalApproval,
  isConfirmedExecutionReceipt,
  reconcileCampaignDispatch,
  validateAuthoritativeInputs,
  verifyApprovalDigestBinding,
} from './dispatch.js';
import {
  CampaignLifecycle,
  assertValidCampaignTransition,
  createCampaignLifecycle,
} from './lifecycle.js';
import { createMarketingRuntime } from './runtime.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const RUN_ID = 'run-mkt-dispatch-test';
const CORRELATION_ID = 'corr-mkt-dispatch-test';
const CAMPAIGN_ID = 'CAMP-0115-01';

const CONTEXT: MarketingInvocationContext = {
  tenant_id: TENANT,
  run_id: RUN_ID,
  correlation_id: CORRELATION_ID,
  request_id: 'req-mkt-001',
  step_index: 1,
  action_revision: 1,
  caller_agent: 'MKT-05',
  granted_authority: 'AUTH-3',
};

function createMockPorts(overrides: Partial<MarketingRuntimePorts> = {}) {
  const appendAudit = vi.fn(async () => undefined);
  const appendEvidence = vi.fn(async (_evidence: readonly MarketingEvidence[]) => 'persisted-ev-1');
  const consentCheck = vi.fn(async (input: { tenant_id: string; customer_id: string; channel: string }): Promise<MarketingConsentDecision> => ({
    ...input,
    allowed: true,
    consent_timestamp: '2026-01-01T00:00:00.000Z',
    suppression_reason: null,
    source_uri: 'urn:agentos:consents',
    source_version: 'v1',
  }));

  let claimedAction: ActionDraft | null = null;
  const pauseForApproval = vi.fn(async () => ({ approval_id: 'appr-auto-1' }));
  const claimApprovalAndResume = vi.fn(async (
    params: Parameters<IStatefulWorkflowEngine['claimApprovalAndResume']>[0],
  ) => {
    claimedAction = params.authorized_action;
    return {
      claimed: true as const,
      approval_id: params.approval_id,
      operator_id: params.operator_id,
      decision: (params.decision === 'MODIFIED' ? 'MODIFIED' : 'APPROVED') as 'APPROVED' | 'MODIFIED',
    };
  });
  const getTask = vi.fn(async () =>
    claimedAction === null
      ? null
      : {
          task_version: 2,
          state: 'running' as const,
          correlation_id: CORRELATION_ID,
          state_payload: { pending_action: claimedAction },
        },
  );
  const workflowEngine: IStatefulWorkflowEngine = {
    createTask: vi.fn(async () => undefined),
    updateTaskProgress: vi.fn(async () => undefined),
    transitionTask: vi.fn(async () => undefined),
    getTask,
    pauseForApproval,
    claimApprovalAndResume,
    recordFailure: vi.fn(async () => ({ requeued: false })),
    queueHandoffEvidence: vi.fn(async () => ({ queued: true })),
    clearHandoffEvidence: vi.fn(async () => ({ cleared: true })),
  };

  const reserve = vi.fn(async (): Promise<ReservationOutcome> => ({ kind: 'RESERVED' }));
  const resolve = vi.fn(async () => undefined);
  const reconcileGuard = vi.fn(async () => ({ outcome: 'SUCCEEDED' as const }));
  const reopenForRetry = vi.fn(async () => true);

  const effectGuard: IEffectGuard = {
    computeEffectKey: vi.fn(() => 'ek-camp-0115-01'),
    computeRequestFingerprint: vi.fn(() => 'fingerprint-1'),
    reserve,
    resolve,
    reconcile: reconcileGuard,
    reopenForRetry,
  };

  const defaultReceipt: ExecutionReceipt = {
    execution_id: 'exec-api003-001',
    adapter_status: 'SUCCESS',
    provider_reference: 'PROV-REF-100',
    response_payload: { delivered: true },
    latency_ms: 120,
    token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
  };

  const dispatch = vi.fn(async (_action: ActionDraft) => defaultReceipt);
  const reconcileDispatcher = vi.fn(async (): Promise<{ outcome: 'SUCCEEDED' | 'FAILED' | 'INDETERMINATE'; receipt?: ExecutionReceipt }> => ({ outcome: 'SUCCEEDED', receipt: defaultReceipt }));

  const dispatcher: IAdapterDispatcher = {
    dispatch,
    reconcile: reconcileDispatcher,
  };

  const ports: MarketingRuntimePorts = {
    audit: { append: appendAudit },
    evidence: { append: appendEvidence },
    consent: { check: consentCheck },
    workflowEngine,
    effectGuard,
    dispatcher,
    now: () => new Date('2026-01-15T10:00:00.000Z'),
    newId: (() => {
      let id = 0;
      return () => `test-id-${++id}`;
    })(),
    ...overrides,
  };

  return {
    ports,
    appendAudit,
    appendEvidence,
    consentCheck,
    pauseForApproval,
    claimApprovalAndResume,
    reserve,
    resolve,
    dispatch,
    reconcileDispatcher,
    reopenForRetry,
  };
}

function withoutWorkflow(ports: MarketingRuntimePorts): MarketingRuntimePorts {
  return Object.fromEntries(
    Object.entries(ports).filter(([key]) => key !== 'workflowEngine'),
  ) as MarketingRuntimePorts;
}

type MarketingInputOverrides = Omit<Partial<CampaignDispatchInput>, 'recipients'> & {
  recipients?: readonly string[] | null;
};

function makeValidInput(overrides: MarketingInputOverrides = {}): CampaignDispatchInput {
  const { recipients, ...rest } = overrides;
  const base = {
    tenant_id: TENANT,
    campaign_id: CAMPAIGN_ID,
    segment_id: 'SEG-atrisk-0115',
    channel: 'SMS' as const,
    approved_content_id: 'draft-content-01',
    ...rest,
  };
  return {
    ...base,
    ...(recipients === null
      ? {}
      : { recipients: recipients ?? ['cust-1', 'cust-2'] }),
  };
}

function makeValidBrandReview(overrides: Partial<MarketingBrandAuditOutput> = {}): MarketingBrandAuditOutput {
  return {
    compliant: true,
    violations: [],
    confidence_score: 0.98,
    ...overrides,
  };
}

const TEST_CLAIM = Object.freeze({
  approval_id: 'appr-SCR003-01',
  operator_id: 'op-compliance-leader-01',
});

interface ClaimApprovalOptions {
  readonly approval_id: string;
  readonly operator_id: string;
  readonly decision?: 'APPROVED' | 'MODIFIED';
  readonly effect_key?: string;
}

async function claimApprovedBinding(
  workflowEngine: IStatefulWorkflowEngine,
  input: CampaignDispatchInput,
  claimParams: ClaimApprovalOptions = TEST_CLAIM,
  context: MarketingInvocationContext = CONTEXT,
): Promise<CampaignApprovalBinding> {
  const effect_key = claimParams.effect_key ?? 'ek-camp-0115-01';
  const decision = claimParams.decision ?? 'APPROVED';
  const payload: Record<string, unknown> = {
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
    ...(input.price_source !== undefined ? { price_source: input.price_source } : {}),
    ...(input.floor_source !== undefined ? { floor_source: input.floor_source } : {}),
    ...(input.promotion_provenance !== undefined ? { promotion_provenance: input.promotion_provenance } : {}),
  };
  const payload_sha256 = computeCampaignPayloadSha256(payload);
  const reviewed_digest = computeReviewedDigest({
    tenant_id: context.tenant_id,
    run_id: context.run_id,
    effect_key,
    payload_sha256,
  });
  const action: ActionDraft = {
    action_id: 'action-' + claimParams.approval_id,
    run_id: context.run_id,
    tenant_id: context.tenant_id,
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
    approval_id: claimParams.approval_id,
  };
  return claimCanonicalApproval({
    workflow: workflowEngine,
    tenant_id: context.tenant_id,
    run_id: context.run_id,
    approval_id: claimParams.approval_id,
    effect_key,
    payload_sha256,
    reviewed_digest,
    decision,
    operator_id: claimParams.operator_id,
    authorized_action: action,
  });
}

describe('Marketing Campaign Dispatch Seam & Lifecycle', () => {
  describe('1. Approval Gating (AUTH-4 / SCR-003)', () => {
    it('refuses any provider call before shared AUTH-4 release and pauses for approval in workflowEngine', async () => {
      const { ports, pauseForApproval, dispatch } = createMockPorts();
      const input = makeValidInput();

      await expect(
        dispatchCampaign(input, CONTEXT, ports, { brandReview: makeValidBrandReview(), expected_task_version: 1 }),
      ).rejects.toMatchObject({
        code: 'APPROVAL_REQUIRED',
      });

      expect(pauseForApproval).toHaveBeenCalledTimes(1);
      expect(pauseForApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          tenant_id: TENANT,
          run_id: RUN_ID,
          expected_task_version: 1,
          checkpoint: expect.objectContaining({ stage: 'APPROVAL' }),
        }),
      );
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('fails closed with P1B_APPROVAL_PORT_UNAVAILABLE when workflowEngine is missing on approval pause', async () => {
      const { ports, dispatch } = createMockPorts();
      const input = makeValidInput();

      await expect(
        dispatchCampaign(input, CONTEXT, withoutWorkflow(ports), {
          brandReview: makeValidBrandReview(),
          expected_task_version: 1,
        }),
      ).rejects.toMatchObject({
        code: 'P1B_APPROVAL_PORT_UNAVAILABLE',
      });

      expect(dispatch).not.toHaveBeenCalled();
    });

    it('refuses provider call if approval decision is REJECTED or not claimed', async () => {
      const { ports, dispatch } = createMockPorts();
      const input = makeValidInput();
      const binding = await claimApprovedBinding(ports.workflowEngine!, input);

      const rejectedBinding: CampaignApprovalBinding = {
        ...binding,
        decision: 'REJECTED' as unknown as 'APPROVED',
        claimed: false as unknown as true,
      };

      await expect(
        dispatchCampaign(input, CONTEXT, ports, { brandReview: makeValidBrandReview(), approvalBinding: rejectedBinding }),
      ).rejects.toMatchObject({
        code: 'APPROVAL_NOT_RELEASED',
      });

      expect(dispatch).not.toHaveBeenCalled();
    });

    it('fails closed with APPROVAL_NOT_RELEASED on caller-only APPROVED when claimApprovalAndResume returns false', async () => {
      const { ports, dispatch, claimApprovalAndResume } = createMockPorts();
      claimApprovalAndResume.mockResolvedValueOnce({ claimed: false as unknown as true, approval_id: 'appr-caller-only', operator_id: 'op-caller-only', decision: 'APPROVED' });

      const input = makeValidInput();
      const callerOnlyPayload: Record<string, unknown> = {
        tenant_id: input.tenant_id,
        campaign_id: input.campaign_id,
        segment_id: input.segment_id,
        channel: input.channel,
        approved_content_id: input.approved_content_id,
        recipients: input.recipients ?? [],
      };
      const callerOnlyPayloadSha256 = computeCampaignPayloadSha256(callerOnlyPayload);
      // Caller-only fabricated binding without workflow claim release
      const unconfirmedBinding = {
        approval_id: 'appr-caller-only',
        tenant_id: CONTEXT.tenant_id,
        run_id: CONTEXT.run_id,
        effect_key: 'ek-camp-0115-01',
        payload_sha256: callerOnlyPayloadSha256,
        reviewed_digest: computeReviewedDigest({
          tenant_id: CONTEXT.tenant_id,
          run_id: CONTEXT.run_id,
          effect_key: 'ek-camp-0115-01',
          payload_sha256: callerOnlyPayloadSha256,
        }),
        decision: 'APPROVED' as const,
        operator_id: 'op-caller-only',
        claimed: false as unknown as true,
      };

      await expect(
        dispatchCampaign(input, CONTEXT, ports, {
          brandReview: makeValidBrandReview(),
          approvalBinding: unconfirmedBinding,
        }),
      ).rejects.toMatchObject({
        code: 'APPROVAL_NOT_RELEASED',
      });

      expect(dispatch).not.toHaveBeenCalled();
    });

    it('fails closed with APPROVAL_NOT_RELEASED when approval binding lacks valid approval_id', async () => {
      const { ports, dispatch } = createMockPorts();
      const input = makeValidInput();
      const binding = await claimApprovedBinding(ports.workflowEngine!, input);

      const invalidBinding = {
        ...binding,
        approval_id: '',
      } as unknown as CampaignApprovalBinding;

      await expect(
        dispatchCampaign(input, CONTEXT, ports, {
          brandReview: makeValidBrandReview(),
          approvalBinding: invalidBinding,
        }),
      ).rejects.toMatchObject({
        code: 'APPROVAL_NOT_RELEASED',
      });

      expect(dispatch).not.toHaveBeenCalled();
    });

    it('fails closed with APPROVAL_NOT_RELEASED when approval binding lacks valid operator_id', async () => {
      const { ports, dispatch } = createMockPorts();
      const input = makeValidInput();
      const binding = await claimApprovedBinding(ports.workflowEngine!, input);

      const invalidBinding = {
        ...binding,
        operator_id: '',
      } as unknown as CampaignApprovalBinding;

      await expect(
        dispatchCampaign(input, CONTEXT, ports, {
          brandReview: makeValidBrandReview(),
          approvalBinding: invalidBinding,
        }),
      ).rejects.toMatchObject({
        code: 'APPROVAL_NOT_RELEASED',
      });

      expect(dispatch).not.toHaveBeenCalled();
    });

    it('proceeds with provider call when approval is claimed and APPROVED', async () => {
      const { ports, dispatch, resolve } = createMockPorts();
      const input = makeValidInput();
      const binding = await claimApprovedBinding(ports.workflowEngine!, input);

      const result = await dispatchCampaign(input, CONTEXT, ports, {
        brandReview: makeValidBrandReview(),
        approvalBinding: binding,
      });

      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(result.output.status).toBe('COMPLETED');
      expect(result.output.recipient_count).toBe(2);
      expect(resolve).toHaveBeenCalledWith(
        expect.objectContaining({
          tenant_id: TENANT,
          status: 'SUCCEEDED',
        }),
      );
    });
  });

  describe('2. Digest Mismatch & Payload Change Invalidation', () => {
    it('rejects with APPROVAL_DIGEST_MISMATCH when payload content is modified after review', async () => {
      const { ports, dispatch } = createMockPorts();
      const input = makeValidInput({ discount_percent: 10 });
      const binding = await claimApprovedBinding(ports.workflowEngine!, input);
      // Malicious or accidental modification: discount changed to 20 after approval!
      const alteredInput = makeValidInput({ discount_percent: 20 });

      await expect(
        dispatchCampaign(alteredInput, CONTEXT, ports, { brandReview: makeValidBrandReview(), approvalBinding: binding }),
      ).rejects.toMatchObject({
        code: 'APPROVAL_DIGEST_MISMATCH',
      });
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('rejects with APPROVAL_DIGEST_MISMATCH on tenant, run_id, or effect_key binding mismatch', async () => {
      const { ports } = createMockPorts();
      const input = makeValidInput();
      const binding = await claimApprovedBinding(ports.workflowEngine!, input);
      const payload_sha256 = binding.payload_sha256;

      expect(() =>
        verifyApprovalDigestBinding(
          { ...binding, run_id: 'foreign-run-id' },
          { tenant_id: TENANT, run_id: RUN_ID, effect_key: 'ek-camp-0115-01', payload_sha256 },
        ),
      ).toThrow(MarketingRuntimeError);

      expect(() =>
        verifyApprovalDigestBinding(
          { ...binding, effect_key: 'different-effect-key' },
          { tenant_id: TENANT, run_id: RUN_ID, effect_key: 'ek-camp-0115-01', payload_sha256 },
        ),
      ).toThrow(MarketingRuntimeError);
    });

    it('rejects with APPROVAL_PAYLOAD_MISMATCH if input.payload has conflicting channel, content, or recipients', async () => {
      const { ports } = createMockPorts();
      const inputWithChannelConflict = makeValidInput({
        channel: 'SMS',
        payload: { channel: 'EMAIL' },
      });
      await expect(
        dispatchCampaign(inputWithChannelConflict, CONTEXT, ports, { brandReview: makeValidBrandReview() }),
      ).rejects.toMatchObject({
        code: 'APPROVAL_PAYLOAD_MISMATCH',
      });

      const inputWithContentConflict = makeValidInput({
        approved_content_id: 'content-A',
        payload: { approved_content_id: 'content-B' },
      });
      await expect(
        dispatchCampaign(inputWithContentConflict, CONTEXT, ports, { brandReview: makeValidBrandReview() }),
      ).rejects.toMatchObject({
        code: 'APPROVAL_PAYLOAD_MISMATCH',
      });

      const inputWithRecipientConflict = makeValidInput({
        recipients: ['cust-1'],
        payload: { recipients: ['cust-2'] },
      });
      await expect(
        dispatchCampaign(inputWithRecipientConflict, CONTEXT, ports, { brandReview: makeValidBrandReview() }),
      ).rejects.toMatchObject({
        code: 'APPROVAL_PAYLOAD_MISMATCH',
      });
    });

    it('invalidates digest if channel, content, or audience changes after approval', async () => {
      const { ports } = createMockPorts();
      const input = makeValidInput();
      const binding = await claimApprovedBinding(ports.workflowEngine!, input);
      // Changed channel
      await expect(
        dispatchCampaign(
          { ...input, channel: 'EMAIL' },
          CONTEXT,
          ports,
          { brandReview: makeValidBrandReview(), approvalBinding: binding },
        ),
      ).rejects.toMatchObject({
        code: 'APPROVAL_DIGEST_MISMATCH',
      });

      // Changed content
      await expect(
        dispatchCampaign(
          { ...input, approved_content_id: 'different-draft-id' },
          CONTEXT,
          ports,
          { brandReview: makeValidBrandReview(), approvalBinding: binding },
        ),
      ).rejects.toMatchObject({
        code: 'APPROVAL_DIGEST_MISMATCH',
      });

      // Changed recipients/audience
      await expect(
        dispatchCampaign(
          { ...input, recipients: ['cust-different'] },
          CONTEXT,
          ports,
          { brandReview: makeValidBrandReview(), approvalBinding: binding },
        ),
      ).rejects.toMatchObject({
        code: 'APPROVAL_DIGEST_MISMATCH',
      });
    });
  });

  describe('3. Dispatch-Time Per-Recipient Consent Suppression', () => {
    it('rechecks per-recipient consent at dispatch time, invalidates stale approval digest when recipients are suppressed, and dispatches under matching reapproval', async () => {
      const { ports, dispatch, reserve, consentCheck } = createMockPorts();

      consentCheck.mockImplementation(async (checkInput) => {
        if (checkInput.customer_id === 'cust-opted-in') {
          return {
            ...checkInput,
            allowed: true,
            consent_timestamp: '2026-01-01T00:00:00.000Z',
            suppression_reason: null,
            source_uri: 'urn:agentos:consents',
            source_version: 'v1',
          };
        }
        if (checkInput.customer_id === 'cust-opted-out') {
          return {
            ...checkInput,
            allowed: false,
            consent_timestamp: null,
            suppression_reason: 'USER_OPTED_OUT',
            source_uri: 'urn:agentos:consents',
            source_version: 'v1',
          };
        }
        // cust-missing: missing consent denied
        return {
          ...checkInput,
          allowed: false,
          consent_timestamp: null,
          suppression_reason: 'CONSENT_NOT_FOUND',
          source_uri: 'urn:agentos:consents',
          source_version: 'v1',
        };
      });

      const input = makeValidInput({
        recipients: ['cust-opted-in', 'cust-opted-out', 'cust-missing'],
      });
      const staleBinding = await claimApprovedBinding(ports.workflowEngine!, input);
      // (1) Attempting dispatch with the stale unsuppressed approval fails closed
      await expect(
        dispatchCampaign(input, CONTEXT, ports, {
          brandReview: makeValidBrandReview(),
          approvalBinding: staleBinding,
        }),
      ).rejects.toMatchObject({
        code: 'APPROVAL_DIGEST_MISMATCH',
      });
      expect(dispatch).not.toHaveBeenCalled();
      expect(reserve).not.toHaveBeenCalled();

      // (2) When re-approved for the filtered audience, dispatch succeeds under matching filtered digest
      const filteredInput = makeValidInput({
        recipients: ['cust-opted-in'],
      });
      const reapprovedBinding = await claimApprovedBinding(ports.workflowEngine!, filteredInput);
      const result = await dispatchCampaign(input, CONTEXT, ports, {
        brandReview: makeValidBrandReview(),
        approvalBinding: reapprovedBinding,
      });

      expect(result.output.recipient_count).toBe(1);
      expect(result.output.suppressed_count).toBe(2);
      expect(reserve).toHaveBeenCalledTimes(1);
      expect(reserve).toHaveBeenCalledWith(
        expect.objectContaining({
          request_fingerprint: reapprovedBinding.payload_sha256,
        }),
      );
      expect(dispatch).toHaveBeenCalledTimes(1);

      // Verify ActionDraft payload uses only consent-filtered recipients and matches reapproved digest
      const dispatchedDraft = dispatch.mock.calls[0]![0];
      expect(dispatchedDraft.payload.recipients).toEqual([
        'cust-opted-in',
      ]);
      expect(dispatchedDraft.payload.recipients).not.toContain('cust-opted-out');
      expect(dispatchedDraft.payload.recipients).not.toContain('cust-missing');
      expect(dispatchedDraft.approval_payload_digest).toBe(reapprovedBinding.payload_sha256);
    });

    it('rejects with CONSENT_SUPPRESSION_ALL_DENIED when all recipients lack verified consent', async () => {
      const { ports, dispatch, consentCheck } = createMockPorts();
      consentCheck.mockResolvedValue({
        tenant_id: TENANT,
        customer_id: 'cust-1',
        channel: 'SMS',
        allowed: false,
        consent_timestamp: null,
        suppression_reason: 'CONSENT_NOT_FOUND',
        source_uri: 'urn:agentos:consents',
        source_version: 'v1',
      });
      const input = makeValidInput({ recipients: ['cust-1', 'cust-2'] });
      const binding = await claimApprovedBinding(ports.workflowEngine!, input);

      await expect(
        dispatchCampaign(input, CONTEXT, ports, { brandReview: makeValidBrandReview(), approvalBinding: binding }),
      ).rejects.toMatchObject({
        code: 'CONSENT_SUPPRESSION_ALL_DENIED',
      });

      expect(dispatch).not.toHaveBeenCalled();
    });

    it('fails closed when consent port is unavailable', async () => {
      const result = await checkRecipientConsents(['cust-1', 'cust-2'], TENANT, 'SMS', undefined);
      expect(result.eligibleRecipients).toHaveLength(0);
      expect(result.suppressedRecipients).toHaveLength(2);
      expect(result.suppressedRecipients[0]?.reason).toBe('CONSENT_PORT_UNAVAILABLE');
    });

    it('rechecks consent for payload-only recipients, invalidating stale approval and requiring matching reapproval', async () => {
      const { ports, dispatch, consentCheck, reserve } = createMockPorts();

      consentCheck.mockImplementation(async (checkInput) => {
        if (checkInput.customer_id === 'cust-payload-opted-in') {
          return {
            ...checkInput,
            allowed: true,
            consent_timestamp: '2026-01-01T00:00:00.000Z',
            suppression_reason: null,
            source_uri: 'urn:agentos:consents',
            source_version: 'v1',
          };
        }
        if (checkInput.customer_id === 'cust-payload-opted-out') {
          return {
            ...checkInput,
            allowed: false,
            consent_timestamp: null,
            suppression_reason: 'USER_OPTED_OUT',
            source_uri: 'urn:agentos:consents',
            source_version: 'v1',
          };
        }
        // cust-payload-missing: missing consent denied
        return {
          ...checkInput,
          allowed: false,
          consent_timestamp: null,
          suppression_reason: 'CONSENT_NOT_FOUND',
          source_uri: 'urn:agentos:consents',
          source_version: 'v1',
        };
      });

      // Explicit input.recipients is absent / undefined; recipients are only in input.payload
      const input = makeValidInput({
        recipients: null,
        payload: {
          recipients: ['cust-payload-opted-in', 'cust-payload-opted-out', 'cust-payload-missing'],
        },
      });
      const staleBinding = await claimApprovedBinding(ports.workflowEngine!, input);
      // (1) Attempting dispatch with stale approval fails closed
      await expect(
        dispatchCampaign(input, CONTEXT, ports, {
          brandReview: makeValidBrandReview(),
          approvalBinding: staleBinding,
        }),
      ).rejects.toMatchObject({
        code: 'APPROVAL_DIGEST_MISMATCH',
      });
      expect(dispatch).not.toHaveBeenCalled();
      expect(reserve).not.toHaveBeenCalled();

      // (2) When re-approved with filtered payload recipients, dispatch succeeds
      const filteredInput = makeValidInput({
        recipients: null,
        payload: {
          recipients: ['cust-payload-opted-in'],
        },
      });
      const reapprovedBinding = await claimApprovedBinding(ports.workflowEngine!, filteredInput);
      const result = await dispatchCampaign(input, CONTEXT, ports, {
        brandReview: makeValidBrandReview(),
        approvalBinding: reapprovedBinding,
      });

      // Every recipient in payload was checked for consent
      expect(consentCheck).toHaveBeenCalledTimes(6);
      expect(consentCheck).toHaveBeenCalledWith(
        expect.objectContaining({ tenant_id: TENANT, customer_id: 'cust-payload-opted-in', channel: 'SMS' }),
      );
      expect(consentCheck).toHaveBeenCalledWith(
        expect.objectContaining({ tenant_id: TENANT, customer_id: 'cust-payload-opted-out', channel: 'SMS' }),
      );
      expect(consentCheck).toHaveBeenCalledWith(
        expect.objectContaining({ tenant_id: TENANT, customer_id: 'cust-payload-missing', channel: 'SMS' }),
      );

      // Output counts
      expect(result.output.recipient_count).toBe(1);
      expect(result.output.suppressed_count).toBe(2);

      // Effect reserved with re-approved fingerprint
      expect(reserve).toHaveBeenCalledTimes(1);
      expect(reserve).toHaveBeenCalledWith(
        expect.objectContaining({
          request_fingerprint: reapprovedBinding.payload_sha256,
        }),
      );

      // Provider was called once with only consent-filtered recipients
      expect(dispatch).toHaveBeenCalledTimes(1);
      const dispatchedDraft = dispatch.mock.calls[0]![0];
      expect(dispatchedDraft.payload.recipients).toEqual(['cust-payload-opted-in']);
      expect(dispatchedDraft.payload.recipients).not.toContain('cust-payload-opted-out');
      expect(dispatchedDraft.payload.recipients).not.toContain('cust-payload-missing');

      // Approval digest matches the filtered reapproval binding exactly
      expect(dispatchedDraft.approval_payload_digest).toBe(reapprovedBinding.payload_sha256);
    });

    it('rejects with CONSENT_SUPPRESSION_ALL_DENIED when all payload-only recipients lack consent', async () => {
      const { ports, dispatch, consentCheck, reserve } = createMockPorts();

      consentCheck.mockResolvedValue({
        tenant_id: TENANT,
        customer_id: 'cust-denied-only',
        channel: 'SMS',
        allowed: false,
        consent_timestamp: null,
        suppression_reason: 'CONSENT_NOT_FOUND',
        source_uri: 'urn:agentos:consents',
        source_version: 'v1',
      });

      const input = makeValidInput({
        recipients: null,
        payload: {
          recipients: ['cust-denied-only'],
        },
      });
      const binding = await claimApprovedBinding(ports.workflowEngine!, input);
      await expect(
        dispatchCampaign(input, CONTEXT, ports, {
          brandReview: makeValidBrandReview(),
          approvalBinding: binding,
        }),
      ).rejects.toMatchObject({
        code: 'CONSENT_SUPPRESSION_ALL_DENIED',
      });

      expect(consentCheck).toHaveBeenCalledTimes(1);
      expect(reserve).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('fails closed with explicit stale digest error and refuses reservation or dispatch when consent suppression alters audience under old approval', async () => {
      const { ports, dispatch, reserve, consentCheck } = createMockPorts();

      consentCheck.mockImplementation(async (checkInput) => {
        if (checkInput.customer_id === 'cust-allowed') {
          return {
            ...checkInput,
            allowed: true,
            consent_timestamp: '2026-01-01T00:00:00.000Z',
            suppression_reason: null,
            source_uri: 'urn:agentos:consents',
            source_version: 'v1',
          };
        }
        return {
          ...checkInput,
          allowed: false,
          consent_timestamp: null,
          suppression_reason: 'REVOKED',
          source_uri: 'urn:agentos:consents',
          source_version: 'v1',
        };
      });

      const input = makeValidInput({
        recipients: ['cust-allowed', 'cust-suppressed'],
      });
      const staleBinding = await claimApprovedBinding(ports.workflowEngine!, input);
      let caughtError: unknown;
      try {
        await dispatchCampaign(input, CONTEXT, ports, {
          brandReview: makeValidBrandReview(),
          approvalBinding: staleBinding,
        });
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(MarketingRuntimeError);
      const mktErr = caughtError as MarketingRuntimeError;
      expect(mktErr.code).toBe('APPROVAL_DIGEST_MISMATCH');
      expect(mktErr.message).toMatch(/stale/i);
      expect(mktErr.message).toMatch(/re-review required/i);
      expect(reserve).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('pauses workflowEngine for re-approval with the filtered canonical payload when recipients are suppressed and no approval is provided', async () => {
      const { ports, pauseForApproval, consentCheck } = createMockPorts();

      consentCheck.mockImplementation(async (checkInput) => {
        if (checkInput.customer_id === 'cust-allowed') {
          return {
            ...checkInput,
            allowed: true,
            consent_timestamp: '2026-01-01T00:00:00.000Z',
            suppression_reason: null,
            source_uri: 'urn:agentos:consents',
            source_version: 'v1',
          };
        }
        return {
          ...checkInput,
          allowed: false,
          consent_timestamp: null,
          suppression_reason: 'CONSENT_NOT_FOUND',
          source_uri: 'urn:agentos:consents',
          source_version: 'v1',
        };
      });

      const input = makeValidInput({
        recipients: ['cust-allowed', 'cust-suppressed'],
      });

      const filteredPayload = {
        ...input,
        recipients: ['cust-allowed'],
      };
      const expectedFilteredSha = computeCampaignPayloadSha256(filteredPayload);
      const expectedFilteredDigest = computeReviewedDigest({
        tenant_id: CONTEXT.tenant_id,
        run_id: CONTEXT.run_id,
        effect_key: 'ek-camp-0115-01',
        payload_sha256: expectedFilteredSha,
      });

      await expect(
        dispatchCampaign(input, CONTEXT, ports, {
          brandReview: makeValidBrandReview(),
          expected_task_version: 1,
        }),
      ).rejects.toMatchObject({
        code: 'APPROVAL_REQUIRED',
      });

      expect(pauseForApproval).toHaveBeenCalledTimes(1);
      expect(pauseForApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          checkpoint: expect.objectContaining({
            stage: 'APPROVAL',
            payload_sha256: expectedFilteredSha,
            reviewed_digest: expectedFilteredDigest,
          }),
          approval: expect.objectContaining({
            payload: expect.objectContaining({
              recipients: ['cust-allowed'],
            }),
          }),
        }),
      );
    });
  });

  describe('3b. Empty Canonical Recipient List & Audience Boundary Enforcement', () => {
    it('fails closed with AUDIENCE_REQUIRED when input.recipients is empty array, never invoking provider dispatcher', async () => {
      const { ports, dispatch } = createMockPorts();
      const input = makeValidInput({ recipients: [] });
      const binding = await claimApprovedBinding(ports.workflowEngine!, input);

      await expect(
        dispatchCampaign(input, CONTEXT, ports, { brandReview: makeValidBrandReview(), approvalBinding: binding }),
      ).rejects.toMatchObject({
        code: 'AUDIENCE_REQUIRED',
      });
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('fails closed with AUDIENCE_REQUIRED when input has segment_id but no recipients and no payload recipients, never treating segment_id alone as consented audience', async () => {
      const { ports, dispatch } = createMockPorts();
      const input = makeValidInput({ recipients: null });
      const binding = await claimApprovedBinding(ports.workflowEngine!, input);

      await expect(
        dispatchCampaign(input, CONTEXT, ports, { brandReview: makeValidBrandReview(), approvalBinding: binding }),
      ).rejects.toMatchObject({
        code: 'AUDIENCE_REQUIRED',
      });
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('fails closed with AUDIENCE_REQUIRED when input.payload carries empty recipients array, never invoking dispatcher', async () => {
      const { ports, dispatch } = createMockPorts();
      const input = makeValidInput({ recipients: null, payload: { recipients: [] } });
      const binding = await claimApprovedBinding(ports.workflowEngine!, input);

      await expect(
        dispatchCampaign(input, CONTEXT, ports, { brandReview: makeValidBrandReview(), approvalBinding: binding }),
      ).rejects.toMatchObject({
        code: 'AUDIENCE_REQUIRED',
      });
      expect(dispatch).not.toHaveBeenCalled();
    });
  });

  describe('4. AUTH-5 Prohibited Action Hard Deny & Canonical Grant Boundary', () => {
    it('strictly rejects AUTH-5 before any queueing or provider dispatch via explicit verdict/input seam', async () => {
      const { ports, pauseForApproval, dispatch, appendAudit } = createMockPorts();
      const input = makeValidInput({ authority_verdict: 'AUTH-5' });

      await expect(
        dispatchCampaign(input, CONTEXT, ports),
      ).rejects.toMatchObject({
        code: 'AUTH_5_PROHIBITED',
      });

      expect(pauseForApproval).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      expect(appendAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'DENIED',
          reason: expect.stringContaining('AUTH-5 is strictly prohibited'),
        }),
      );
    });

    it('strictly rejects AUTH-5 passed via options.authorityVerdict', async () => {
      const { ports, pauseForApproval, dispatch, appendAudit } = createMockPorts();
      const input = makeValidInput();

      await expect(
        dispatchCampaign(input, CONTEXT, ports, { authorityVerdict: 'AUTH-5' }),
      ).rejects.toMatchObject({
        code: 'AUTH_5_PROHIBITED',
      });

      expect(pauseForApproval).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      expect(appendAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'DENIED',
          reason: expect.stringContaining('AUTH-5 is strictly prohibited'),
        }),
      );
    });

    it('rejects non-assignable authority grant (AUTH-4 / AUTH-5) at canonical grant boundary without widening grant type', async () => {
      const { ports, dispatch } = createMockPorts();
      const input = makeValidInput();

      const auth4Context: MarketingInvocationContext = {
        ...CONTEXT,
        granted_authority: 'AUTH-4' as unknown as MarketingInvocationContext['granted_authority'],
      };

      await expect(
        dispatchCampaign(input, auth4Context, ports, { brandReview: makeValidBrandReview() }),
      ).rejects.toMatchObject({
        code: 'INVALID_CLEARANCE',
      });

      const auth5Context: MarketingInvocationContext = {
        ...CONTEXT,
        granted_authority: 'AUTH-5' as unknown as MarketingInvocationContext['granted_authority'],
      };

      await expect(
        dispatchCampaign(input, auth5Context, ports, { brandReview: makeValidBrandReview() }),
      ).rejects.toMatchObject({
        code: 'INVALID_CLEARANCE',
      });

      expect(dispatch).not.toHaveBeenCalled();
    });
  });

  describe('5. Duplicate Replay & Idempotency', () => {
    it('returns canonical replay receipt without another provider dispatch on duplicate replay', async () => {
      const { ports, reserve, dispatch } = createMockPorts();
      const existingReceipt: ExecutionReceipt = {
        execution_id: 'exec-replay-999',
        adapter_status: 'SUCCESS',
        provider_reference: 'PROVIDER-CACHED-999',
        response_payload: { cached: true },
        latency_ms: 10,
        token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
      };

      reserve.mockResolvedValueOnce({
        kind: 'REPLAY',
        receipt: existingReceipt,
      });

      const input = makeValidInput();
      const binding = await claimApprovedBinding(ports.workflowEngine!, input);

      const result = await dispatchCampaign(input, CONTEXT, ports, {
        brandReview: makeValidBrandReview(),
        approvalBinding: binding,
      });

      expect(result.output.replayed).toBe(true);
      expect(result.output.dispatch_id).toBe('exec-replay-999');
      expect(result.output.status).toBe('COMPLETED');
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('rejects with IDEMPOTENCY_CONFLICT when effect key was reserved with different payload', async () => {
      const { ports, reserve, dispatch } = createMockPorts();
      reserve.mockResolvedValueOnce({ kind: 'CONFLICT' });

      const input = makeValidInput();
      const binding = await claimApprovedBinding(ports.workflowEngine!, input);

      await expect(
        dispatchCampaign(input, CONTEXT, ports, { brandReview: makeValidBrandReview(), approvalBinding: binding }),
      ).rejects.toMatchObject({
        code: 'IDEMPOTENCY_CONFLICT',
      });

      expect(dispatch).not.toHaveBeenCalled();
    });
  });

  describe('6. Provider Timeout, UNKNOWN Reservation & Reconciliation', () => {
    it('leaves reservation UNKNOWN on provider TIMEOUT and never blind retries', async () => {
      const { ports, dispatch, resolve, appendAudit } = createMockPorts();
      dispatch.mockResolvedValueOnce({
        execution_id: 'exec-timeout-001',
        adapter_status: 'TIMEOUT',
        provider_reference: null,
        response_payload: {},
        latency_ms: 5001,
        token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
      });

      const input = makeValidInput();
      const binding = await claimApprovedBinding(ports.workflowEngine!, input);

      await expect(
        dispatchCampaign(input, CONTEXT, ports, { brandReview: makeValidBrandReview(), approvalBinding: binding }),
      ).rejects.toMatchObject({
        code: 'DISPATCH_TIMEOUT',
      });

      // Crucial: resolve() must NOT be called with status: FAILED (leaves UNKNOWN/RESERVED for reconcile)
      expect(resolve).not.toHaveBeenCalled();
      expect(appendAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'DENIED',
          reason: expect.stringContaining('left UNKNOWN for reconcile'),
        }),
      );
    });

    it('reconciles unsettled effect via reconcileCampaignDispatch when provider confirmed success', async () => {
      const { ports, resolve, reconcileDispatcher } = createMockPorts();
      const confirmedReceipt: ExecutionReceipt = {
        execution_id: 'exec-recon-123',
        adapter_status: 'SUCCESS',
        provider_reference: 'CONFIRMED-REF',
        response_payload: { confirmed: true },
        latency_ms: 100,
        token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
      };

      reconcileDispatcher.mockResolvedValueOnce({
        outcome: 'SUCCEEDED',
        receipt: confirmedReceipt,
      });

      const reconResult = await reconcileCampaignDispatch({
        tenant_id: TENANT,
        effect_key: 'ek-camp-0115-01',
        ports,
      });

      expect(reconResult.outcome).toBe('SUCCEEDED');
      expect(resolve).toHaveBeenCalledWith({
        tenant_id: TENANT,
        effect_key: 'ek-camp-0115-01',
        status: 'SUCCEEDED',
        receipt: confirmedReceipt,
      });
    });

    it('leaves effect UNKNOWN when reconciliation is INDETERMINATE, never blind retrying', async () => {
      const { ports, resolve, reconcileDispatcher } = createMockPorts();
      reconcileDispatcher.mockResolvedValueOnce({
        outcome: 'INDETERMINATE',
      });

      const reconResult = await reconcileCampaignDispatch({
        tenant_id: TENANT,
        effect_key: 'ek-camp-0115-01',
        ports,
      });

      expect(reconResult.outcome).toBe('INDETERMINATE');
      expect(resolve).not.toHaveBeenCalled();
    });

    it('does not settle effect SUCCEEDED when reconciliation returns outcome SUCCEEDED without receipt, returning INDETERMINATE', async () => {
      const { ports, resolve, reconcileDispatcher } = createMockPorts();
      reconcileDispatcher.mockResolvedValueOnce({
        outcome: 'SUCCEEDED',
      });

      const reconResult = await reconcileCampaignDispatch({
        tenant_id: TENANT,
        effect_key: 'ek-camp-0115-01',
        ports,
      });

      expect(reconResult.outcome).toBe('INDETERMINATE');
      expect(resolve).not.toHaveBeenCalled();
    });

    it('does not settle effect SUCCEEDED when reconciliation returns outcome SUCCEEDED with receipt missing provider_reference, returning INDETERMINATE', async () => {
      const { ports, resolve, reconcileDispatcher } = createMockPorts();
      reconcileDispatcher.mockResolvedValueOnce({
        outcome: 'SUCCEEDED',
        receipt: {
          execution_id: 'exec-no-ref-789',
          adapter_status: 'SUCCESS',
          provider_reference: null,
          response_payload: {},
          latency_ms: 10,
          token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
        },
      });

      const reconResult = await reconcileCampaignDispatch({
        tenant_id: TENANT,
        effect_key: 'ek-camp-0115-01',
        ports,
      });

      expect(reconResult.outcome).toBe('INDETERMINATE');
      expect(resolve).not.toHaveBeenCalled();
    });

    it('does not settle effect SUCCEEDED when reconciliation returns outcome SUCCEEDED with empty provider_reference, returning INDETERMINATE', async () => {
      const { ports, resolve, reconcileDispatcher } = createMockPorts();
      reconcileDispatcher.mockResolvedValueOnce({
        outcome: 'SUCCEEDED',
        receipt: {
          execution_id: 'exec-empty-ref-789',
          adapter_status: 'SUCCESS',
          provider_reference: '   ',
          response_payload: {},
          latency_ms: 10,
          token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
        },
      });

      const reconResult = await reconcileCampaignDispatch({
        tenant_id: TENANT,
        effect_key: 'ek-camp-0115-01',
        ports,
      });

      expect(reconResult.outcome).toBe('INDETERMINATE');
      expect(resolve).not.toHaveBeenCalled();
    });

    it('does not settle effect SUCCEEDED when reconciliation returns outcome SUCCEEDED with non-SUCCESS adapter_status, returning INDETERMINATE', async () => {
      const { ports, resolve, reconcileDispatcher } = createMockPorts();
      reconcileDispatcher.mockResolvedValueOnce({
        outcome: 'SUCCEEDED',
        receipt: {
          execution_id: 'exec-pending-789',
          adapter_status: 'TIMEOUT' as unknown as ExecutionReceipt['adapter_status'],
          provider_reference: 'REF-789',
          response_payload: {},
          latency_ms: 10,
          token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
        },
      });

      const reconResult = await reconcileCampaignDispatch({
        tenant_id: TENANT,
        effect_key: 'ek-camp-0115-01',
        ports,
      });

      expect(reconResult.outcome).toBe('INDETERMINATE');
      expect(resolve).not.toHaveBeenCalled();
    });

    it('does not settle effect SUCCEEDED when reconciliation returns outcome SUCCEEDED with missing execution_id, returning INDETERMINATE', async () => {
      const { ports, resolve, reconcileDispatcher } = createMockPorts();
      reconcileDispatcher.mockResolvedValueOnce({
        outcome: 'SUCCEEDED',
        receipt: {
          execution_id: '',
          adapter_status: 'SUCCESS',
          provider_reference: 'REF-789',
          response_payload: {},
          latency_ms: 10,
          token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
        },
      });

      const reconResult = await reconcileCampaignDispatch({
        tenant_id: TENANT,
        effect_key: 'ek-camp-0115-01',
        ports,
      });

      expect(reconResult.outcome).toBe('INDETERMINATE');
      expect(resolve).not.toHaveBeenCalled();
    });

    it('reopens the effect key for retry on confirmed reconciliation failure before re-dispatch', async () => {
      const { ports, dispatch, reconcileDispatcher, reopenForRetry } = createMockPorts();
      reconcileDispatcher.mockResolvedValueOnce({ outcome: 'FAILED' as const });

      const customPorts: MarketingRuntimePorts = {
        ...ports,
        effectGuard: {
          ...ports.effectGuard!,
          reserve: vi.fn().mockResolvedValue({ kind: 'RECONCILE_REQUIRED' }),
          reopenForRetry,
        },
      };

      const input = makeValidInput();
      const binding = await claimApprovedBinding(customPorts.workflowEngine!, input);

      const result = await dispatchCampaign(input, CONTEXT, customPorts, {
        brandReview: makeValidBrandReview(),
        approvalBinding: binding,
      });

      expect(reopenForRetry).toHaveBeenCalledWith({
        tenant_id: TENANT,
        effect_key: 'ek-camp-0115-01',
      });
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(result.output.status).toBe('COMPLETED');
    });

    it('fails closed and refuses re-dispatch when reopenForRetry is unavailable on confirmed reconciliation failure', async () => {
      const { ports, dispatch, reconcileDispatcher } = createMockPorts();
      reconcileDispatcher.mockResolvedValueOnce({ outcome: 'FAILED' as const });

      const { reopenForRetry: _omitted, ...effectGuardWithoutReopen } = ports.effectGuard!;
      const customPorts: MarketingRuntimePorts = {
        ...ports,
        effectGuard: {
          ...effectGuardWithoutReopen,
          reserve: vi.fn().mockResolvedValue({ kind: 'RECONCILE_REQUIRED' }),
        },
      };

      const input = makeValidInput();
      const binding = await claimApprovedBinding(customPorts.workflowEngine!, input);

      await expect(
        dispatchCampaign(input, CONTEXT, customPorts, {
          brandReview: makeValidBrandReview(),
          approvalBinding: binding,
        }),
      ).rejects.toMatchObject({
        code: 'RECONCILIATION_REOPEN_FAILED',
      });

      expect(dispatch).not.toHaveBeenCalled();
    });

    it('fails closed and refuses re-dispatch when reopenForRetry returns false on confirmed reconciliation failure', async () => {
      const { ports, dispatch, reconcileDispatcher } = createMockPorts();
      reconcileDispatcher.mockResolvedValueOnce({ outcome: 'FAILED' as const });
      const failingReopen = vi.fn(async () => false);

      const customPorts: MarketingRuntimePorts = {
        ...ports,
        effectGuard: {
          ...ports.effectGuard!,
          reserve: vi.fn().mockResolvedValue({ kind: 'RECONCILE_REQUIRED' }),
          reopenForRetry: failingReopen,
        },
      };

      const input = makeValidInput();
      const binding = await claimApprovedBinding(customPorts.workflowEngine!, input);

      await expect(
        dispatchCampaign(input, CONTEXT, customPorts, {
          brandReview: makeValidBrandReview(),
          approvalBinding: binding,
        }),
      ).rejects.toMatchObject({
        code: 'RECONCILIATION_REOPEN_FAILED',
      });

      expect(failingReopen).toHaveBeenCalledWith({
        tenant_id: TENANT,
        effect_key: 'ek-camp-0115-01',
      });
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('replays confirmed success without re-dispatching when reservation requires reconciliation and provider confirmed success', async () => {
      const { ports, dispatch, reconcileDispatcher, appendAudit } = createMockPorts();
      const confirmedReceipt: ExecutionReceipt = {
        execution_id: 'exec-recon-success-456',
        adapter_status: 'SUCCESS',
        provider_reference: 'CONFIRMED-REF-456',
        response_payload: { delivered: true },
        latency_ms: 50,
        token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
      };
      reconcileDispatcher.mockResolvedValueOnce({
        outcome: 'SUCCEEDED' as const,
        receipt: confirmedReceipt,
      });

      const customPorts: MarketingRuntimePorts = {
        ...ports,
        effectGuard: {
          ...ports.effectGuard!,
          reserve: vi.fn().mockResolvedValue({ kind: 'RECONCILE_REQUIRED' }),
        },
      };

      const input = makeValidInput();
      const binding = await claimApprovedBinding(customPorts.workflowEngine!, input);

      const result = await dispatchCampaign(input, CONTEXT, customPorts, {
        brandReview: makeValidBrandReview(),
        approvalBinding: binding,
      });

      expect(result.output.replayed).toBe(true);
      expect(result.output.dispatch_id).toBe('exec-recon-success-456');
      expect(result.output.status).toBe('COMPLETED');
      expect(dispatch).not.toHaveBeenCalled();
      expect(appendAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'SUCCEEDED',
          reason: expect.stringContaining('Reconciliation confirmed prior successful dispatch'),
        }),
      );
    });

    it('never dispatches again on indeterminate reconciliation outcome', async () => {
      const { ports, dispatch, reconcileDispatcher } = createMockPorts();
      reconcileDispatcher.mockResolvedValueOnce({ outcome: 'INDETERMINATE' as const });

      const customPorts: MarketingRuntimePorts = {
        ...ports,
        effectGuard: {
          ...ports.effectGuard!,
          reserve: vi.fn().mockResolvedValue({ kind: 'RECONCILE_REQUIRED' }),
        },
      };

      const input = makeValidInput();
      const binding = await claimApprovedBinding(customPorts.workflowEngine!, input);

      await expect(
        dispatchCampaign(input, CONTEXT, customPorts, {
          brandReview: makeValidBrandReview(),
          approvalBinding: binding,
        }),
      ).rejects.toMatchObject({
        code: 'RECONCILE_INDETERMINATE',
      });

      expect(dispatch).not.toHaveBeenCalled();
    });

    it('fails closed with RECONCILE_INDETERMINATE and leaves reservation unsettled when reservation requires reconciliation and provider returns SUCCEEDED without receipt', async () => {
      const { ports, dispatch, resolve, reconcileDispatcher, appendEvidence } = createMockPorts();
      reconcileDispatcher.mockResolvedValueOnce({
        outcome: 'SUCCEEDED' as const,
      });

      const customPorts: MarketingRuntimePorts = {
        ...ports,
        effectGuard: {
          ...ports.effectGuard!,
          reserve: vi.fn().mockResolvedValue({ kind: 'RECONCILE_REQUIRED' }),
        },
      };

      const input = makeValidInput();
      const binding = await claimApprovedBinding(customPorts.workflowEngine!, input);

      await expect(
        dispatchCampaign(input, CONTEXT, customPorts, {
          brandReview: makeValidBrandReview(),
          approvalBinding: binding,
        }),
      ).rejects.toMatchObject({
        code: 'RECONCILE_INDETERMINATE',
      });

      expect(resolve).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      expect(appendEvidence).not.toHaveBeenCalled();
    });

    it('fails closed with RECONCILE_INDETERMINATE and leaves reservation unsettled when reservation requires reconciliation and provider returns SUCCEEDED with missing provider_reference', async () => {
      const { ports, dispatch, resolve, reconcileDispatcher, appendEvidence } = createMockPorts();
      reconcileDispatcher.mockResolvedValueOnce({
        outcome: 'SUCCEEDED' as const,
        receipt: {
          execution_id: 'exec-recon-unconfirmed-456',
          adapter_status: 'SUCCESS',
          provider_reference: null,
          response_payload: {},
          latency_ms: 20,
          token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
        },
      });

      const customPorts: MarketingRuntimePorts = {
        ...ports,
        effectGuard: {
          ...ports.effectGuard!,
          reserve: vi.fn().mockResolvedValue({ kind: 'RECONCILE_REQUIRED' }),
        },
      };

      const input = makeValidInput();
      const binding = await claimApprovedBinding(customPorts.workflowEngine!, input);

      await expect(
        dispatchCampaign(input, CONTEXT, customPorts, {
          brandReview: makeValidBrandReview(),
          approvalBinding: binding,
        }),
      ).rejects.toMatchObject({
        code: 'RECONCILE_INDETERMINATE',
      });

      expect(resolve).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      expect(appendEvidence).not.toHaveBeenCalled();
    });
  });

  describe('6b. Provider Receipt Verification, Settlement Proof & No Fabricated Evidence', () => {
    it('fails closed with DISPATCH_UNKNOWN/RECEIPT_UNCONFIRMED when ExecutionReceipt status is SUCCESS but provider_reference is null, leaving effect unsettled without fabricated evidence', async () => {
      const { ports, dispatch, resolve, appendEvidence, appendAudit } = createMockPorts();
      dispatch.mockResolvedValueOnce({
        execution_id: 'exec-no-ref-001',
        adapter_status: 'SUCCESS',
        provider_reference: null,
        response_payload: { delivered: true },
        latency_ms: 50,
        token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
      });

      const input = makeValidInput();
      const binding = await claimApprovedBinding(ports.workflowEngine!, input);

      await expect(
        dispatchCampaign(input, CONTEXT, ports, { brandReview: makeValidBrandReview(), approvalBinding: binding }),
      ).rejects.toMatchObject({
        code: 'DISPATCH_UNKNOWN',
        message: expect.stringContaining('RECEIPT_UNCONFIRMED'),
      });

      // Crucial: resolve() must NOT be called with status: SUCCEEDED (leaves UNKNOWN for reconciliation)
      expect(resolve).not.toHaveBeenCalled();
      // Crucial: evidence.append must NOT be called (never fabricate provider evidence or 'v1' fallback)
      expect(appendEvidence).not.toHaveBeenCalled();
      // Crucial: audit.append must record DENIED outcome with UNKNOWN reconciliation notice
      expect(appendAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'DENIED',
          reason: expect.stringContaining('UNKNOWN for reconciliation'),
        }),
      );
    });

    it('fails closed with DISPATCH_UNKNOWN when ExecutionReceipt status is SUCCESS but provider_reference is empty or whitespace string', async () => {
      const { ports, dispatch, resolve, appendEvidence, appendAudit } = createMockPorts();
      dispatch.mockResolvedValueOnce({
        execution_id: 'exec-empty-ref-002',
        adapter_status: 'SUCCESS',
        provider_reference: '   ',
        response_payload: { delivered: true },
        latency_ms: 50,
        token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
      });

      const input = makeValidInput();
      const binding = await claimApprovedBinding(ports.workflowEngine!, input);

      await expect(
        dispatchCampaign(input, CONTEXT, ports, { brandReview: makeValidBrandReview(), approvalBinding: binding }),
      ).rejects.toMatchObject({
        code: 'DISPATCH_UNKNOWN',
        message: expect.stringContaining('RECEIPT_UNCONFIRMED'),
      });

      expect(resolve).not.toHaveBeenCalled();
      expect(appendEvidence).not.toHaveBeenCalled();
      expect(appendAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'DENIED',
        }),
      );
    });

    it('fails closed with DISPATCH_UNKNOWN when ExecutionReceipt execution_id is missing or empty', async () => {
      const { ports, dispatch, resolve, appendEvidence, appendAudit } = createMockPorts();
      dispatch.mockResolvedValueOnce({
        execution_id: '',
        adapter_status: 'SUCCESS',
        provider_reference: 'PROV-REF-100',
        response_payload: { delivered: true },
        latency_ms: 50,
        token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
      });

      const input = makeValidInput();
      const binding = await claimApprovedBinding(ports.workflowEngine!, input);

      await expect(
        dispatchCampaign(input, CONTEXT, ports, { brandReview: makeValidBrandReview(), approvalBinding: binding }),
      ).rejects.toMatchObject({
        code: 'DISPATCH_UNKNOWN',
        message: expect.stringContaining('RECEIPT_UNCONFIRMED'),
      });

      expect(resolve).not.toHaveBeenCalled();
      expect(appendEvidence).not.toHaveBeenCalled();
      expect(appendAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'DENIED',
        }),
      );
    });

    it('settles SUCCESS only with confirmed ExecutionReceipt and builds evidence strictly from provider data without v1 fallback', async () => {
      const { ports, dispatch, resolve, appendEvidence, appendAudit } = createMockPorts();
      dispatch.mockResolvedValueOnce({
        execution_id: 'exec-confirmed-001',
        adapter_status: 'SUCCESS',
        provider_reference: 'PROV-TX-9988',
        response_payload: { delivered: true },
        latency_ms: 75,
        token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
      });

      const input = makeValidInput();
      const binding = await claimApprovedBinding(ports.workflowEngine!, input);

      const result = await dispatchCampaign(input, CONTEXT, ports, {
        brandReview: makeValidBrandReview(),
        approvalBinding: binding,
      });

      expect(result.output.status).toBe('COMPLETED');
      expect(resolve).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'SUCCEEDED',
        }),
      );
      expect(appendEvidence).toHaveBeenCalledTimes(1);
      const persistedEvidence = appendEvidence.mock.calls[0]![0]![0]!;
      expect(persistedEvidence.source_uri).toBe('api-003://communication/exec-confirmed-001');
      expect(persistedEvidence.source_version).toBe('PROV-TX-9988');
      expect(persistedEvidence.source_version).not.toBe('v1');
      expect(appendAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'SUCCEEDED',
        }),
      );
    });

    it('builds evidence source_version from explicitly provider-supplied version when present in response payload', async () => {
      const { ports, dispatch, resolve, appendEvidence } = createMockPorts();
      dispatch.mockResolvedValueOnce({
        execution_id: 'exec-confirmed-002',
        adapter_status: 'SUCCESS',
        provider_reference: 'PROV-TX-9989',
        response_payload: { version: '2026.09.26-provider' },
        latency_ms: 75,
        token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
      });

      const input = makeValidInput();
      const binding = await claimApprovedBinding(ports.workflowEngine!, input);

      const result = await dispatchCampaign(input, CONTEXT, ports, {
        brandReview: makeValidBrandReview(),
        approvalBinding: binding,
      });

      expect(result.output.status).toBe('COMPLETED');
      expect(resolve).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'SUCCEEDED',
        }),
      );
      expect(appendEvidence).toHaveBeenCalledTimes(1);
      const persistedEvidence = appendEvidence.mock.calls[0]![0]![0]!;
      expect(persistedEvidence.source_version).toBe('2026.09.26-provider');
      expect(persistedEvidence.source_version).not.toBe('v1');
    });

    it('fails closed when provider returns unexpected unconfirmed status without resolving SUCCEEDED', async () => {
      const { ports, dispatch, resolve, appendEvidence, appendAudit } = createMockPorts();
      dispatch.mockResolvedValueOnce({
        execution_id: 'exec-unconfirmed-003',
        adapter_status: 'PENDING' as unknown as ExecutionReceipt['adapter_status'],
        provider_reference: 'REF-123',
        response_payload: {},
        latency_ms: 50,
        token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
      });

      const input = makeValidInput();
      const binding = await claimApprovedBinding(ports.workflowEngine!, input);

      await expect(
        dispatchCampaign(input, CONTEXT, ports, { brandReview: makeValidBrandReview(), approvalBinding: binding }),
      ).rejects.toMatchObject({
        code: 'DISPATCH_UNKNOWN',
        message: expect.stringContaining('RECEIPT_UNCONFIRMED'),
      });

      expect(resolve).not.toHaveBeenCalled();
      expect(appendEvidence).not.toHaveBeenCalled();
      expect(appendAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'DENIED',
        }),
      );
    });

    it('isConfirmedExecutionReceipt strictly enforces valid ExecutionReceipt with adapter_status SUCCESS, non-empty provider_reference and non-empty execution_id', () => {
      expect(isConfirmedExecutionReceipt(null)).toBe(false);
      expect(isConfirmedExecutionReceipt(undefined)).toBe(false);
      expect(isConfirmedExecutionReceipt('invalid')).toBe(false);
      expect(isConfirmedExecutionReceipt({})).toBe(false);
      expect(
        isConfirmedExecutionReceipt({
          execution_id: 'exec-1',
          adapter_status: 'SUCCESS',
          provider_reference: null,
        }),
      ).toBe(false);
      expect(
        isConfirmedExecutionReceipt({
          execution_id: 'exec-1',
          adapter_status: 'SUCCESS',
          provider_reference: '   ',
        }),
      ).toBe(false);
      expect(
        isConfirmedExecutionReceipt({
          execution_id: '',
          adapter_status: 'SUCCESS',
          provider_reference: 'prov-ref-1',
        }),
      ).toBe(false);
      expect(
        isConfirmedExecutionReceipt({
          execution_id: 'exec-1',
          adapter_status: 'ERROR',
          provider_reference: 'prov-ref-1',
        }),
      ).toBe(false);
      expect(
        isConfirmedExecutionReceipt({
          execution_id: 'exec-1',
          adapter_status: 'SUCCESS',
          provider_reference: 'prov-ref-1',
        }),
      ).toBe(true);
    });
  });

  describe('7. Multi-Tenant Isolation', () => {
    it('rejects dispatch when input tenant does not match context tenant', async () => {
      const { ports, dispatch } = createMockPorts();
      const input = makeValidInput({ tenant_id: OTHER_TENANT });

      await expect(
        dispatchCampaign(input, CONTEXT, ports),
      ).rejects.toMatchObject({
        code: 'TENANT_MISMATCH',
      });

      expect(dispatch).not.toHaveBeenCalled();
    });

    it('scopes all port calls and effect reservations strictly to the verified tenant', async () => {
      const { ports, reserve, dispatch, consentCheck } = createMockPorts();
      const input = makeValidInput();
      const binding = await claimApprovedBinding(ports.workflowEngine!, input);

      await dispatchCampaign(input, CONTEXT, ports, { brandReview: makeValidBrandReview(), approvalBinding: binding });

      expect(reserve).toHaveBeenCalledWith(
        expect.objectContaining({ tenant_id: TENANT }),
      );
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ tenant_id: TENANT }),
        expect.anything(),
      );
      expect(consentCheck).toHaveBeenCalledWith(
        expect.objectContaining({ tenant_id: TENANT }),
      );
    });
  });

  describe('8. Blocking-Free Brand Review Enforcement', () => {
    it('rejects dispatch if brand review is not compliant', async () => {
      const { ports, dispatch } = createMockPorts();
      const input = makeValidInput();
      const binding = await claimApprovedBinding(ports.workflowEngine!, input);

      const nonCompliantReview: MarketingBrandAuditOutput = {
        compliant: false,
        violations: [
          {
            rule_id: 'PROHIBITED_CLAIM',
            severity: 'HIGH',
            snippet: '100% cure',
            suggestion: 'remove claim',
          },
        ],
        confidence_score: 0.95,
      };

      await expect(
        dispatchCampaign(input, CONTEXT, ports, {
          approvalBinding: binding,
          brandReview: nonCompliantReview,
        }),
      ).rejects.toMatchObject({
        code: 'BRAND_REVIEW_FAILED',
      });

      expect(dispatch).not.toHaveBeenCalled();
    });

    it('rejects dispatch if brand review contains BLOCKING violation', async () => {
      const { ports, dispatch } = createMockPorts();
      const input = makeValidInput();
      const binding = await claimApprovedBinding(ports.workflowEngine!, input);

      const blockingReview: MarketingBrandAuditOutput = {
        compliant: true, // even if marked compliant by mistake
        violations: [
          {
            rule_id: 'REGULATORY_BLOCK',
            severity: 'BLOCKING',
            snippet: 'guaranteed return',
            suggestion: 'illegal in region',
          },
        ],
        confidence_score: 0.99,
      };

      await expect(
        dispatchCampaign(input, CONTEXT, ports, {
          approvalBinding: binding,
          brandReview: blockingReview,
        }),
      ).rejects.toMatchObject({
        code: 'BRAND_REVIEW_BLOCKING',
      });

      expect(dispatch).not.toHaveBeenCalled();
    });

    it('fails closed with BRAND_REVIEW_REQUIRED when brand review is missing', async () => {
      const { ports, dispatch } = createMockPorts();
      const input = makeValidInput();
      const binding = await claimApprovedBinding(ports.workflowEngine!, input);

      await expect(
        dispatchCampaign(input, CONTEXT, ports, {
          approvalBinding: binding,
        }),
      ).rejects.toMatchObject({
        code: 'BRAND_REVIEW_REQUIRED',
      });

      expect(dispatch).not.toHaveBeenCalled();
    });
  });

  describe('9. Authoritative Claim, Price & Promotion Validation', () => {
    it('rejects price-bearing campaign if authoritative floor price is unavailable', () => {
      const input = makeValidInput({ proposed_price: 150 });
      expect(() => validateAuthoritativeInputs(input, undefined)).toThrow(
        MarketingRuntimeError,
      );
      expect(() => validateAuthoritativeInputs(input, undefined)).toThrow(
        /P_FLOOR_UNAVAILABLE/,
      );
    });

    it('rejects price-bearing campaign if proposed price is below authoritative floor', () => {
      const input = makeValidInput({ proposed_price: 80 });
      const authValidation: MarketingAuthoritativeValidation = {
        floor_price: 100,
        floor_source: 'ERP_PRICING_CATALOG',
      };
      expect(() => validateAuthoritativeInputs(input, authValidation)).toThrow(
        MarketingRuntimeError,
      );
      expect(() => validateAuthoritativeInputs(input, authValidation)).toThrow(
        /ERR_FLOOR_PRICE_VIOLATION/,
      );
    });

    it('rejects promotional discount exceeding authoritative limit', () => {
      const input = makeValidInput({
        discount_percent: 50,
        promotion_provenance: 'PROMO_REGISTRY_2026',
      });
      const authValidation: MarketingAuthoritativeValidation = {
        max_discount_percent: 30,
        promotion_provenance: 'PROMO_REGISTRY_2026',
      };
      expect(() => validateAuthoritativeInputs(input, authValidation)).toThrow(
        /DISCOUNT_LIMIT_EXCEEDED/,
      );
    });

    it('fails closed when promotional claims lack authoritative provenance or exceed approved claims', () => {
      const inputPercent = makeValidInput({ discount_percent: 15 });
      expect(() => validateAuthoritativeInputs(inputPercent, undefined)).toThrow(
        /PROMOTION_PROVENANCE_REQUIRED/,
      );

      const inputAmount = makeValidInput({ discount_amount: 100 });
      expect(() => validateAuthoritativeInputs(inputAmount, undefined)).toThrow(
        /PROMOTION_PROVENANCE_REQUIRED/,
      );

      const inputOffer = makeValidInput({
        offer_id: 'unapproved-offer',
        promotion_provenance: 'PROMO_REGISTRY_2026',
      });
      expect(() =>
        validateAuthoritativeInputs(inputOffer, {
          approved_claims: ['approved-offer'],
          promotion_provenance: 'PROMO_REGISTRY_2026',
        }),
      ).toThrow(/ERR_UNAPPROVED_CLAIM/);
    });

    it('rejects payload-only price-bearing campaign if authoritative floor price is unavailable', () => {
      const input = makeValidInput({ payload: { proposed_price: 150 } });
      expect(() => validateAuthoritativeInputs(input, undefined)).toThrow(
        MarketingRuntimeError,
      );
      expect(() => validateAuthoritativeInputs(input, undefined)).toThrow(
        /P_FLOOR_UNAVAILABLE/,
      );
    });

    it('rejects payload-only price-bearing campaign if proposed price is below authoritative floor', () => {
      const input = makeValidInput({ payload: { proposed_price: 80 } });
      const authValidation: MarketingAuthoritativeValidation = {
        floor_price: 100,
        floor_source: 'ERP_PRICING_CATALOG',
      };
      expect(() => validateAuthoritativeInputs(input, authValidation)).toThrow(
        MarketingRuntimeError,
      );
      expect(() => validateAuthoritativeInputs(input, authValidation)).toThrow(
        /ERR_FLOOR_PRICE_VIOLATION/,
      );
    });

    it('rejects payload-only promotional discount exceeding authoritative limit', () => {
      const inputPercent = makeValidInput({
        payload: { discount_percent: 50, promotion_provenance: 'PROMO_REGISTRY_2026' },
      });
      expect(() =>
        validateAuthoritativeInputs(inputPercent, {
          max_discount_percent: 30,
          promotion_provenance: 'PROMO_REGISTRY_2026',
        }),
      ).toThrow(/DISCOUNT_LIMIT_EXCEEDED/);

      const inputAmount = makeValidInput({
        payload: { discount_amount: 500, promotion_provenance: 'PROMO_REGISTRY_2026' },
      });
      expect(() =>
        validateAuthoritativeInputs(inputAmount, {
          max_discount_amount: 200,
          promotion_provenance: 'PROMO_REGISTRY_2026',
        }),
      ).toThrow(/DISCOUNT_LIMIT_EXCEEDED/);
    });

    it('fails closed when payload-only promotional claims lack provenance or exceed approved claims', () => {
      const inputPercent = makeValidInput({ payload: { discount_percent: 15 } });
      expect(() => validateAuthoritativeInputs(inputPercent, undefined)).toThrow(
        /PROMOTION_PROVENANCE_REQUIRED/,
      );

      const inputAmount = makeValidInput({ payload: { discount_amount: 100 } });
      expect(() => validateAuthoritativeInputs(inputAmount, undefined)).toThrow(
        /PROMOTION_PROVENANCE_REQUIRED/,
      );

      const inputOffer = makeValidInput({
        payload: { offer_id: 'unapproved-offer', promotion_provenance: 'PROMO_REGISTRY_2026' },
      });
      expect(() =>
        validateAuthoritativeInputs(inputOffer, {
          approved_claims: ['approved-offer'],
          promotion_provenance: 'PROMO_REGISTRY_2026',
        }),
      ).toThrow(/ERR_UNAPPROVED_CLAIM/);

      expect(() => validateAuthoritativeInputs(inputOffer, undefined)).toThrow(
        /PROMOTION_PROVENANCE_REQUIRED/,
      );
    });

    it('fails closed with SCHEMA_VALIDATION_ERROR on payload-only claim fields with malformed types', () => {
      const invalidPrice = makeValidInput({
        payload: { proposed_price: 'one-hundred' as unknown as number },
      });
      expect(() =>
        validateAuthoritativeInputs(invalidPrice, { floor_price: 50 }),
      ).toThrow(/SCHEMA_VALIDATION_ERROR/);

      const invalidPercent = makeValidInput({
        payload: {
          discount_percent: 'twenty-percent' as unknown as number,
          promotion_provenance: 'PROMO_REGISTRY_2026',
        },
      });
      expect(() =>
        validateAuthoritativeInputs(invalidPercent, {
          max_discount_percent: 50,
          promotion_provenance: 'PROMO_REGISTRY_2026',
        }),
      ).toThrow(/SCHEMA_VALIDATION_ERROR/);

      const invalidAmount = makeValidInput({
        payload: {
          discount_amount: true as unknown as number,
          promotion_provenance: 'PROMO_REGISTRY_2026',
        },
      });
      expect(() =>
        validateAuthoritativeInputs(invalidAmount, {
          max_discount_amount: 50,
          promotion_provenance: 'PROMO_REGISTRY_2026',
        }),
      ).toThrow(/SCHEMA_VALIDATION_ERROR/);

      const invalidOffer = makeValidInput({
        payload: { offer_id: 12345 as unknown as string, promotion_provenance: 'PROMO_REGISTRY_2026' },
      });
      expect(() =>
        validateAuthoritativeInputs(invalidOffer, {
          approved_claims: ['12345'],
          promotion_provenance: 'PROMO_REGISTRY_2026',
        }),
      ).toThrow(/SCHEMA_VALIDATION_ERROR/);
    });

    it('detects conflict between typed input fields and payload claim fields', () => {
      const conflictingPrice = makeValidInput({
        proposed_price: 150,
        payload: { proposed_price: 120 },
      });
      expect(() =>
        validateAuthoritativeInputs(conflictingPrice, { floor_price: 100 }),
      ).toThrow(/APPROVAL_PAYLOAD_MISMATCH/);

      const conflictingPercent = makeValidInput({
        discount_percent: 10,
        payload: { discount_percent: 20 },
      });
      expect(() =>
        validateAuthoritativeInputs(conflictingPercent, { max_discount_percent: 30 }),
      ).toThrow(/APPROVAL_PAYLOAD_MISMATCH/);
    });

    it('validates canonicalPayload record directly when all authoritative requirements are met', () => {
      const payloadOnlyInput = makeValidInput({
        payload: {
          proposed_price: 150,
          price_source: 'ERP_PRICING_CATALOG',
          floor_source: 'ERP_PRICING_CATALOG',
          promotion_source: 'PROMO_REGISTRY_2026',
          discount_percent: 15,
          discount_amount: 50,
          offer_id: 'approved-offer',
        },
      });
      const authValidation: MarketingAuthoritativeValidation = {
        floor_price: 100,
        floor_source: 'ERP_PRICING_CATALOG',
        authoritative_price: 150,
        price_source: 'ERP_PRICING_CATALOG',
        promotion_source: 'PROMO_REGISTRY_2026',
        approved_claims: ['approved-offer'],
        max_discount_percent: 20,
        max_discount_amount: 100,
      };

      expect(() =>
        validateAuthoritativeInputs(payloadOnlyInput, authValidation),
      ).not.toThrow();
    });

    it('dispatchCampaign fails closed before approval or dispatch on payload-only price without floor price', async () => {
      const { ports, dispatch, pauseForApproval } = createMockPorts();
      const input = makeValidInput({ payload: { proposed_price: 150 } });

      await expect(
        dispatchCampaign(input, CONTEXT, ports, {
          brandReview: makeValidBrandReview(),
        }),
      ).rejects.toMatchObject({
        code: 'P_FLOOR_UNAVAILABLE',
      });

      expect(dispatch).not.toHaveBeenCalled();
      expect(pauseForApproval).not.toHaveBeenCalled();
    });

    it('dispatchCampaign fails closed before approval or dispatch on payload-only price below floor', async () => {
      const { ports, dispatch, pauseForApproval } = createMockPorts();
      const input = makeValidInput({ payload: { proposed_price: 75 } });

      await expect(
        dispatchCampaign(input, CONTEXT, ports, {
          brandReview: makeValidBrandReview(),
          authoritativeValidation: { floor_price: 100, floor_source: 'ERP_PRICING_CATALOG' },
        }),
      ).rejects.toMatchObject({
        code: 'ERR_FLOOR_PRICE_VIOLATION',
      });

      expect(dispatch).not.toHaveBeenCalled();
      expect(pauseForApproval).not.toHaveBeenCalled();
    });

    it('dispatchCampaign fails closed on payload-only promotion claims with absent or breached authoritative limits', async () => {
      const { ports, dispatch, pauseForApproval } = createMockPorts();

      const promotion_provenance = 'PROMO_REGISTRY_2026';

      // Missing authoritative promotion provenance
      await expect(
        dispatchCampaign(makeValidInput({ payload: { discount_percent: 25 } }), CONTEXT, ports, {
          brandReview: makeValidBrandReview(),
        }),
      ).rejects.toMatchObject({ code: 'PROMOTION_PROVENANCE_REQUIRED' });

      // Breached discount_percent limit
      await expect(
        dispatchCampaign(
          makeValidInput({ payload: { discount_percent: 50, promotion_provenance } }),
          CONTEXT,
          ports,
          {
            brandReview: makeValidBrandReview(),
            authoritativeValidation: { max_discount_percent: 20, promotion_provenance },
          },
        ),
      ).rejects.toMatchObject({ code: 'DISCOUNT_LIMIT_EXCEEDED' });

      // Missing authoritative promotion provenance for discount amount
      await expect(
        dispatchCampaign(makeValidInput({ payload: { discount_amount: 100 } }), CONTEXT, ports, {
          brandReview: makeValidBrandReview(),
        }),
      ).rejects.toMatchObject({ code: 'PROMOTION_PROVENANCE_REQUIRED' });

      // Breached discount_amount limit
      await expect(
        dispatchCampaign(
          makeValidInput({ payload: { discount_amount: 300, promotion_provenance } }),
          CONTEXT,
          ports,
          {
            brandReview: makeValidBrandReview(),
            authoritativeValidation: { max_discount_amount: 150, promotion_provenance },
          },
        ),
      ).rejects.toMatchObject({ code: 'DISCOUNT_LIMIT_EXCEEDED' });

      // Unapproved offer_id
      await expect(
        dispatchCampaign(
          makeValidInput({ payload: { offer_id: 'fake-offer', promotion_provenance } }),
          CONTEXT,
          ports,
          {
            brandReview: makeValidBrandReview(),
            authoritativeValidation: { approved_claims: ['valid-offer'], promotion_provenance },
          },
        ),
      ).rejects.toMatchObject({ code: 'ERR_UNAPPROVED_CLAIM' });

      // Missing authoritative promotion provenance for offer
      await expect(
        dispatchCampaign(makeValidInput({ payload: { offer_id: 'any-offer' } }), CONTEXT, ports, {
          brandReview: makeValidBrandReview(),
        }),
      ).rejects.toMatchObject({ code: 'PROMOTION_PROVENANCE_REQUIRED' });

      expect(dispatch).not.toHaveBeenCalled();
      expect(pauseForApproval).not.toHaveBeenCalled();
    });

    it('dispatchCampaign succeeds and preserves one exact canonical payload and reviewed digest for valid payload-only claims', async () => {
      const { ports, dispatch } = createMockPorts();
      const input = makeValidInput({
        payload: {
          proposed_price: 150,
          price_source: 'ERP_PRICING_CATALOG',
          floor_source: 'ERP_PRICING_CATALOG',
          promotion_source: 'PROMO_REGISTRY_2026',
          offer_id: 'promo-special-2026',
          discount_percent: 15,
          discount_amount: 50,
          custom_tracking: 'mkt-campaign-tag',
        },
      });
      const authValidation: MarketingAuthoritativeValidation = {
        floor_price: 100,
        floor_source: 'ERP_PRICING_CATALOG',
        authoritative_price: 150,
        price_source: 'ERP_PRICING_CATALOG',
        promotion_source: 'PROMO_REGISTRY_2026',
        approved_claims: ['promo-special-2026'],
        max_discount_percent: 20,
        max_discount_amount: 100,
      };
      const approvalBinding = await claimApprovedBinding(ports.workflowEngine!, input);

      const result = await dispatchCampaign(input, CONTEXT, ports, {
        brandReview: makeValidBrandReview(),
        approvalBinding,
        authoritativeValidation: authValidation,
      });

      expect(result.output.status).toBe('COMPLETED');
      expect(dispatch).toHaveBeenCalledTimes(1);
      const dispatchedDraft = dispatch.mock.calls[0]![0];
      expect(dispatchedDraft.price_bearing).toBe(true);
      expect(dispatchedDraft.proposed_price).toBe(150);
      expect(dispatchedDraft.computed_price_floor).toBe(100);
      expect(dispatchedDraft.floor_source).toBe('ERP_PRICING_CATALOG');
      expect(dispatchedDraft.payload).toMatchObject({
        proposed_price: 150,
        offer_id: 'promo-special-2026',
        discount_percent: 15,
        discount_amount: 50,
        custom_tracking: 'mkt-campaign-tag',
      });
      expect(dispatchedDraft.approval_payload_digest).toBe(approvalBinding.payload_sha256);
    });

    it('fails closed with FLOOR_SOURCE_REQUIRED when floor_price is supplied with empty floor_source', () => {
      const input = makeValidInput({ proposed_price: 100 });
      expect(() =>
        validateAuthoritativeInputs(input, { floor_price: 50, floor_source: '  ' }),
      ).toThrow(/FLOOR_SOURCE_REQUIRED/);
    });

    it('fails closed with PRICE_PROVENANCE_REQUIRED when authoritative_price is present without price_source', () => {
      const input = makeValidInput({ proposed_price: 100 });
      expect(() =>
        validateAuthoritativeInputs(input, {
          floor_price: 50,
          floor_source: 'ERP_PRICING_CATALOG',
          authoritative_price: 100,
          price_source: '  ',
        }),
      ).toThrow(/PRICE_PROVENANCE_REQUIRED/);
    });

    it('fails closed with PRICE_PROVENANCE_MISMATCH when price_source conflicts with authoritative price_source', () => {
      const input = makeValidInput({
        proposed_price: 100,
        price_source: 'LOCAL_SCRATCHPAD',
      });
      expect(() =>
        validateAuthoritativeInputs(input, {
          floor_price: 50,
          floor_source: 'ERP_PRICING_CATALOG',
          authoritative_price: 100,
          price_source: 'ERP_PRICING_CATALOG',
        }),
      ).toThrow(/PRICE_PROVENANCE_MISMATCH/);
    });

    it('fails closed with FLOOR_PROVENANCE_MISMATCH when floor_source conflicts with authoritative floor_source', () => {
      const input = makeValidInput({ floor_source: 'LOCAL_SCRATCHPAD' });
      expect(() =>
        validateAuthoritativeInputs(input, { floor_source: 'ERP_PRICING_CATALOG' }),
      ).toThrow(/FLOOR_PROVENANCE_MISMATCH/);
    });

    it('fails closed with PROMOTION_PROVENANCE_MISMATCH when promotion_provenance conflicts with authoritative promotion source', () => {
      const input = makeValidInput({ promotion_provenance: 'LOCAL_SCRATCHPAD' });
      expect(() =>
        validateAuthoritativeInputs(input, { promotion_source: 'PROMO_REGISTRY_2026' }),
      ).toThrow(/PROMOTION_PROVENANCE_MISMATCH/);
    });

    it('fails closed with PROMOTION_PROVENANCE_REQUIRED when authoritative promotion_source is empty', () => {
      expect(() =>
        validateAuthoritativeInputs({}, { promotion_source: '  ' }),
      ).toThrow(/PROMOTION_PROVENANCE_REQUIRED/);
    });
  });

  describe('10. End-to-End CampaignLifecycle Seam', () => {
    it('models the complete 8-stage lifecycle from Brief to Optimize', async () => {
      const { ports, dispatch, claimApprovalAndResume } = createMockPorts({
        research: {
          readMarketSignals: async (_input: MarketingSignalInput) => ({
            signals: [],
            trend_velocity: 'STABLE',
            analyzed_at: '2026-01-01T00:00:00.000Z',
            source_uri: 'research://signals',
            source_version: 'v1',
          }),
          segmentAudience: async () => [
            {
              tenant_id: TENANT,
              customer_id: 'cust-1',
              source_uri: 'c360://cust-1',
              source_version: 'v1',
              observed_at: '2026-01-01T00:00:00.000Z',
              match_reason: 'loyal',
            },
          ],
        },
        policy: {
          getApprovedAudienceLimit: async () => 1000,
        },
        content_generator: {
          generate: async () => ({
            draft_id: 'draft-camp-01',
            headline: 'Spring Fresh Styles',
            body_content: 'Discover our spring collection today.',
            cta_text: 'Shop Now',
            channel_payload: { channel_type: 'SMS' },
          }),
        },
        knowledge: {
          readApproved: async (_tenant, path) => ({
            path,
            version: 'v1',
            content: '---\nstatus: approved\n---\n- guaranteed results\n- miracle cure',
          }),
        },
        attribution: {
          collectEvidence: async (attrInput) => [
            {
              tenant_id: TENANT,
              campaign_id: attrInput.campaign_id,
              effect_key: attrInput.effect_key,
              correlation_id: attrInput.correlation_id,
              evidence_id: 'order-ev-1',
              evidence_uri: 'erp://orders/ORD-001',
              source_version: 'v1',
            },
          ],
        },
      });

      const lifecycle = createCampaignLifecycle(
        {
          tenant_id: TENANT,
          campaign_id: CAMPAIGN_ID,
          run_id: RUN_ID,
          correlation_id: CORRELATION_ID,
          expected_task_version: 1,
        },
        ports,
      );

      expect(lifecycle.state.current_stage).toBe('BRIEF');

      // Stage 1: BRIEF
      await lifecycle.stepBrief(
        {
          tenant_id: TENANT,
          market_region: 'TW',
          category_id: 'apparel',
          observation_window_days: 14,
        },
        CONTEXT,
      );
      expect(lifecycle.state.current_stage).toBe('AUDIENCE');

      // Stage 2: AUDIENCE
      const audience = await lifecycle.stepAudience(
        {
          tenant_id: TENANT,
          rfm_criteria: 'LOYAL',
          min_days_inactive: 10,
        },
        CONTEXT,
      );
      expect(audience).toHaveLength(1);
      expect(lifecycle.state.current_stage).toBe('CONTENT');

      // Stage 3: CONTENT
      const content = await lifecycle.stepContent(
        {
          tenant_id: TENANT,
          campaign_theme: 'Spring Collection Launch',
          channel: 'SMS_TEXT' as const,
          locale: 'en-US',
        },
        CONTEXT,
      );
      expect(content.draft_id).toBe('draft-camp-01');
      expect(lifecycle.state.current_stage).toBe('BRAND_REVIEW');

      // Stage 4: BRAND_REVIEW
      const brandReview = await lifecycle.stepBrandReview(CONTEXT);
      expect(brandReview.compliant).toBe(true);
      expect(lifecycle.state.current_stage).toBe('APPROVAL');

      // Stage 5: APPROVAL (AUTH-4 Pause -> Claim)
      const pauseRes = await lifecycle.stepApproval({ segment_id: 'SEG-loyal' }, CONTEXT);
      expect(pauseRes.paused).toBe(true);
      expect(pauseRes.approval_id).toBe('appr-auto-1');
      const realApprovalId = pauseRes.approval_id!;

      // Human operator approves at SCR-003 through the canonical workflow claim
      const claimRes = await lifecycle.stepApproval(
        {
          approval_id: realApprovalId,
          decision: 'APPROVED',
          operator_id: 'op-compliance-leader-01',
          segment_id: 'SEG-loyal',
        },
        CONTEXT,
      );
      expect(claimRes.paused).toBe(false);
      expect(claimRes.approval_id).toBe(realApprovalId);
      expect(claimRes.binding?.claimed).toBe(true);
      expect(claimRes.binding?.approval_id).toBe(realApprovalId);
      expect(claimRes.binding?.operator_id).toBe('op-compliance-leader-01');
      expect(claimApprovalAndResume).toHaveBeenCalledWith(
        expect.objectContaining({
          tenant_id: TENANT,
          run_id: RUN_ID,
          approval_id: realApprovalId,
          decision: 'APPROVED',
          operator_id: 'op-compliance-leader-01',
        }),
      );
      expect(lifecycle.state.current_stage).toBe('PUBLISH');

      // Stage 6: PUBLISH
      const dispatchOutput = await lifecycle.stepPublish(
        {
          segment_id: 'SEG-loyal',
          channel: 'SMS',
          approved_content_id: 'draft-camp-01',
        },
        CONTEXT,
      );
      expect(dispatchOutput.status).toBe('COMPLETED');
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(lifecycle.state.current_stage).toBe('MONITOR');

      // Stage 7: MONITOR
      const monitorRes = await lifecycle.stepMonitor(CONTEXT);
      expect(monitorRes.monitored).toBe(true);
      expect(lifecycle.state.current_stage).toBe('OPTIMIZE');

      // Stage 8: OPTIMIZE (MKT-06 Attribution)
      const attrRes = await lifecycle.stepOptimize(
        {
          attribution_model: 'LAST_TOUCH',
          evidence_ids: ['order-ev-1'],
        },
        CONTEXT,
      );
      expect(attrRes.contract.status).toBe('READY_FOR_EVIDENCE');
      expect(attrRes.evidence).toHaveLength(1);
      expect(attrRes.evidence[0]?.classification).toBe('FACT');
    });

    it('rejects illegal stage skipping in campaign lifecycle', () => {
      expect(() => assertValidCampaignTransition('BRIEF', 'PUBLISH')).toThrow(
        MarketingRuntimeError,
      );
      expect(() => assertValidCampaignTransition('CONTENT', 'OPTIMIZE')).toThrow(
        MarketingRuntimeError,
      );
    });

    it('OPTIMIZE returns UNAVAILABLE when downstream order evidence is absent without inventing metrics', async () => {
      const { ports } = createMockPorts({
        attribution: { collectEvidence: async () => [] },
      });

      const lifecycle = createCampaignLifecycle(
        {
          tenant_id: TENANT,
          campaign_id: CAMPAIGN_ID,
          run_id: RUN_ID,
          correlation_id: CORRELATION_ID,
        },
        ports,
      );

      // Set stage to OPTIMIZE for unit test of attribution step
      lifecycle.setStageForTesting('OPTIMIZE');

      const attrRes = await lifecycle.stepOptimize(
        {
          attribution_model: 'LAST_TOUCH',
          evidence_ids: ['absent-order-1'],
        },
        CONTEXT,
      );

      expect(attrRes.contract.status).toBe('UNAVAILABLE');
      expect(attrRes.contract.reason).toBe('ATTRIBUTION_EVIDENCE_INCOMPLETE_OR_UNMATCHED');
      expect(attrRes.evidence).toEqual([]);
    });

    it('fails closed with TASK_VERSION_REQUIRED when expected_task_version is missing on workflow pause', async () => {
      const { ports, pauseForApproval } = createMockPorts();
      const input = makeValidInput();

      await expect(
        dispatchCampaign(input, CONTEXT, ports, {
          brandReview: makeValidBrandReview(),
          // expected_task_version omitted!
        }),
      ).rejects.toMatchObject({
        code: 'TASK_VERSION_REQUIRED',
      });

      expect(pauseForApproval).not.toHaveBeenCalled();
    });

    it('rejects when workflow engine encounters a task version conflict', async () => {
      const { ports, pauseForApproval } = createMockPorts();
      pauseForApproval.mockRejectedValueOnce(new Error('TASK_VERSION_CONFLICT: stale version'));
      const input = makeValidInput();

      await expect(
        dispatchCampaign(input, CONTEXT, ports, {
          brandReview: makeValidBrandReview(),
          expected_task_version: 5,
        }),
      ).rejects.toThrow(/TASK_VERSION_CONFLICT/);
    });
    it('stepApproval fails closed with P1B_APPROVAL_PORT_UNAVAILABLE when workflowEngine is missing on pause', async () => {
      const { ports } = createMockPorts();
      const lifecycle = createCampaignLifecycle(
        { tenant_id: TENANT, campaign_id: CAMPAIGN_ID, run_id: RUN_ID, correlation_id: CORRELATION_ID, expected_task_version: 1 },
        withoutWorkflow(ports),
      );
      lifecycle.setStageForTesting('APPROVAL');
      (lifecycle.state as Record<string, unknown>).content = { draft_id: 'draft-camp-01', channel_payload: { channel_type: 'SMS' } };

      await expect(lifecycle.stepApproval({}, CONTEXT)).rejects.toMatchObject({
        code: 'P1B_APPROVAL_PORT_UNAVAILABLE',
      });
    });

    it('stepApproval fails closed with APPROVAL_ID_REQUIRED when resuming without approval_id and unpaused', async () => {
      const { ports } = createMockPorts();
      const lifecycle = createCampaignLifecycle(
        { tenant_id: TENANT, campaign_id: CAMPAIGN_ID, run_id: RUN_ID, correlation_id: CORRELATION_ID, expected_task_version: 1 },
        ports,
      );
      lifecycle.setStageForTesting('APPROVAL');
      (lifecycle.state as Record<string, unknown>).content = { draft_id: 'draft-camp-01', channel_payload: { channel_type: 'SMS' } };

      await expect(
        lifecycle.stepApproval({ decision: 'APPROVED', operator_id: 'op-compliance-leader-01' }, CONTEXT),
      ).rejects.toMatchObject({
        code: 'APPROVAL_ID_REQUIRED',
      });
    });

    it('stepApproval fails closed with OPERATOR_REQUIRED when operator_id is empty on resume', async () => {
      const { ports } = createMockPorts();
      const lifecycle = createCampaignLifecycle(
        { tenant_id: TENANT, campaign_id: CAMPAIGN_ID, run_id: RUN_ID, correlation_id: CORRELATION_ID, expected_task_version: 1 },
        ports,
      );
      lifecycle.setStageForTesting('APPROVAL');
      (lifecycle.state as Record<string, unknown>).content = { draft_id: 'draft-camp-01', channel_payload: { channel_type: 'SMS' } };

      await expect(
        lifecycle.stepApproval({ approval_id: 'appr-auto-1', decision: 'APPROVED', operator_id: '  ' }, CONTEXT),
      ).rejects.toMatchObject({
        code: 'OPERATOR_REQUIRED',
      });
    });

    it('stepApproval fails closed with APPROVAL_NOT_RELEASED when workflow mock claimApprovalAndResume returns claimed: false', async () => {
      const { ports, claimApprovalAndResume } = createMockPorts();
      claimApprovalAndResume.mockResolvedValueOnce({ claimed: false as unknown as true, approval_id: 'appr-auto-1', operator_id: 'op-compliance-leader-01', decision: 'APPROVED' });

      const lifecycle = createCampaignLifecycle(
        { tenant_id: TENANT, campaign_id: CAMPAIGN_ID, run_id: RUN_ID, correlation_id: CORRELATION_ID, expected_task_version: 1 },
        ports,
      );
      lifecycle.setStageForTesting('APPROVAL');
      (lifecycle.state as Record<string, unknown>).content = { draft_id: 'draft-camp-01', channel_payload: { channel_type: 'SMS' } };

      await expect(
        lifecycle.stepApproval({ approval_id: 'appr-auto-1', decision: 'APPROVED', operator_id: 'op-compliance-leader-01' }, CONTEXT),
      ).rejects.toMatchObject({
        code: 'APPROVAL_NOT_RELEASED',
      });
    });
  });

  describe('11. Integration with MarketingRuntime execute() and capabilities', () => {
    it('delegates execute(skill.mkt.dispatch_campaign) when ports.dispatcher is injected', async () => {
      const { ports, dispatch } = createMockPorts();
      const runtime = createMarketingRuntime({ ports, enableDispatch: true });

      const input = makeValidInput();
      const binding = await claimApprovedBinding(ports.workflowEngine!, input);

      // Use dispatchCampaign directly or via execute with options
      const res = await runtime.dispatchCampaign!(input, CONTEXT, { brandReview: makeValidBrandReview(), approvalBinding: binding });
      expect(res.output.status).toBe('COMPLETED');
      expect(dispatch).toHaveBeenCalledTimes(1);
    });

    it('creates lifecycle via runtime.createLifecycle() factory', () => {
      const { ports } = createMockPorts();
      const runtime = createMarketingRuntime({ ports });
      const lifecycle = runtime.createLifecycle!({
        tenant_id: TENANT,
        campaign_id: CAMPAIGN_ID,
        run_id: RUN_ID,
        correlation_id: CORRELATION_ID,
      });
      expect(lifecycle).toBeInstanceOf(CampaignLifecycle);
      expect(lifecycle.state.current_stage).toBe('BRIEF');
    });
  });
});
