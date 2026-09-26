/**
 * @file Unit tests for P3 PILOT-01 offline fixture and staged acceptance harness interface.
 *
 * Validates:
 * 1. Offline fixture markers (OFFLINE_FIXTURE / NOT_RUNTIME_EVIDENCE).
 * 2. Stage-to-stage evidence linkage (tenant_id, campaign_id, effect_key, correlation_id).
 * 3. Evidence classification invariants (SIGNAL, HYPOTHESIS, DRAFT, DECISION, FACT).
 * 4. P1B human approval boundary invariants (unmet dependency, AUTH-4, SCR-003, no dispatch).
 * 5. Outcome stage invariants: empty outcome evidence, status UNAVAILABLE (no fake receipts).
 * 6. Refusal of absent attribution evidence without treating local literals as external proof.
 * 7. Absence of prohibited runtime claims (no numeric KPIs, budgets, revenue, audiences, or fake receipts).
 * 8. Staged acceptance pipeline execution:
 *    Signal -> Segment -> Campaign -> Content -> Brand Review -> AUTH-4 Approval -> Dispatch -> Response -> Attribution
 *    clearly reporting that provider dispatch and external order evidence are unavailable offline.
 * 9. Negative-case validators and staged pipeline error handling for:
 *    1. missing consent
 *    2. suppressed customer
 *    3. draft/unapproved knowledge
 *    4. prohibited claim
 *    5. invented/unverified price
 *    6. stale approval digest
 *    7. changed payload after approval
 *    8. AUTH-5
 *    9. duplicate dispatch
 *    10. provider UNKNOWN
 *    11. tenant leakage
 *    12. missing attribution evidence
 */

import { computeRequestFingerprint } from '@agentos/core-engine';
import { describe, expect, it } from 'vitest';
import {
  assertAttributionEvidenceAvailable,
  createPilot01Harness,
  PILOT_01_APPROVED_PROHIBITED_CLAIMS_DOC,
  PILOT_01_CAMPAIGN_ID,
  PILOT_01_CORRELATION_ID,
  PILOT_01_EFFECT_KEY,
  PILOT_01_FIXTURE_MARKER,
  PILOT_01_STAGED_EFFECT_KEY,
  PILOT_01_NEGATIVE_ATTRIBUTION_FIXTURE,
  PILOT_01_OFFLINE_FIXTURE,
  PILOT_01_RUNTIME_EVIDENCE_STATUS,
  PILOT_01_TENANT_ID,
  validateApprovalDigest,
  validateAuthority,
  validateBrandCompliance,
  validateConsent,
  validateCustomerSuppression,
  validateEffectReservation,
  validateKnowledgeDocument,
  validatePayloadIntegrity,
  validatePriceClaims,
  validateProviderResponse,
  validateTenantIsolation,
  type Pilot01ApprovalBoundaryHandoff,
  type Pilot01HumanApprovalDecision,
  type Pilot01StageEvidence,
} from './pilot-01.fixture.js';
import {
  type MarketingBrandAuditOutput,
  type MarketingConsentDecision,
  type MarketingKnowledgeDocument,
  MarketingRuntimeError,
} from './contracts.js';

describe('PILOT-01 Offline Fixture & Harness Interface', () => {
  const harness = createPilot01Harness();

  describe('Fixture Metadata & Offline Labeling', () => {
    it('MUST be explicitly labeled as OFFLINE_FIXTURE and NOT_RUNTIME_EVIDENCE', () => {
      expect(PILOT_01_OFFLINE_FIXTURE.fixture_type).toBe(PILOT_01_FIXTURE_MARKER);
      expect(PILOT_01_OFFLINE_FIXTURE.evidence_status).toBe(PILOT_01_RUNTIME_EVIDENCE_STATUS);
      expect(PILOT_01_FIXTURE_MARKER).toBe('OFFLINE_FIXTURE');
      expect(PILOT_01_RUNTIME_EVIDENCE_STATUS).toBe('NOT_RUNTIME_EVIDENCE');

      expect(PILOT_01_NEGATIVE_ATTRIBUTION_FIXTURE.fixture_type).toBe(PILOT_01_FIXTURE_MARKER);
      expect(PILOT_01_NEGATIVE_ATTRIBUTION_FIXTURE.evidence_status).toBe(PILOT_01_RUNTIME_EVIDENCE_STATUS);
    });

    it('MUST NOT include prohibited numeric KPIs, budgets, revenue sums, or provider receipts', () => {
      const raw = JSON.stringify(PILOT_01_OFFLINE_FIXTURE);

      // Verify no monetary/budget numbers or fake revenue
      expect(raw).not.toContain('"budget"');
      expect(raw).not.toContain('"revenue"');
      expect(raw).not.toContain('"kpi"');
      expect(raw).not.toContain('"conversion_rate"');
      expect(raw).not.toContain('"provider_receipt"');
      expect(raw).not.toContain('"dispatch_success"');
      expect(raw).not.toContain('"erp://orders"');
    });
  });

  describe('Evidence Linkage Invariants', () => {
    it('MUST verify unified tenant_id, effect_key, and correlation_id across all stages in PILOT_01_OFFLINE_FIXTURE', () => {
      const result = harness.verifyEvidenceLinkage(PILOT_01_OFFLINE_FIXTURE);
      expect(result.valid).toBe(true);
      expect(result.mismatches).toHaveLength(0);

      expect(PILOT_01_OFFLINE_FIXTURE.tenant_id).toBe(PILOT_01_TENANT_ID);
      expect(PILOT_01_OFFLINE_FIXTURE.campaign_id).toBe(PILOT_01_CAMPAIGN_ID);
      expect(PILOT_01_OFFLINE_FIXTURE.effect_key).toBe(PILOT_01_EFFECT_KEY);
      expect(PILOT_01_OFFLINE_FIXTURE.correlation_id).toBe(PILOT_01_CORRELATION_ID);
    });

    it('MUST detect and flag any cross-tenant or mismatched effect linkage', () => {
      const corrupted: Pilot01StageEvidence = {
        ...PILOT_01_OFFLINE_FIXTURE,
        signal: {
          ...PILOT_01_OFFLINE_FIXTURE.signal,
          evidence: {
            ...PILOT_01_OFFLINE_FIXTURE.signal.evidence,
            tenant_id: 'rogue-tenant-compromise',
          },
        },
      };

      const result = harness.verifyEvidenceLinkage(corrupted);
      expect(result.valid).toBe(false);
      expect(result.mismatches.some((m) => m.includes('rogue-tenant-compromise'))).toBe(true);
    });
  });

  describe('Evidence Classification Separation', () => {
    it('MUST strictly segregate SIGNAL, HYPOTHESIS, DRAFT, and DECISION', () => {
      const result = harness.verifyClassificationInvariants(PILOT_01_OFFLINE_FIXTURE);
      expect(result.valid).toBe(true);
      expect(result.violations).toHaveLength(0);

      expect(PILOT_01_OFFLINE_FIXTURE.signal.evidence.classification).toBe('SIGNAL');
      expect(PILOT_01_OFFLINE_FIXTURE.segment.evidence.classification).toBe('HYPOTHESIS');
      expect(PILOT_01_OFFLINE_FIXTURE.content.evidence.classification).toBe('DRAFT');
      expect(PILOT_01_OFFLINE_FIXTURE.review.evidence.classification).toBe('DECISION');
      expect(PILOT_01_OFFLINE_FIXTURE.outcome.evidence).toHaveLength(0);
      expect(PILOT_01_OFFLINE_FIXTURE.outcome.order_evidence).toHaveLength(0);
    });

    it('MUST reject misclassified evidence', () => {
      const corrupted: Pilot01StageEvidence = {
        ...PILOT_01_OFFLINE_FIXTURE,
        signal: {
          ...PILOT_01_OFFLINE_FIXTURE.signal,
          evidence: {
            ...PILOT_01_OFFLINE_FIXTURE.signal.evidence,
            classification: 'FACT',
          },
        },
      };

      const result = harness.verifyClassificationInvariants(corrupted);
      expect(result.valid).toBe(false);
      expect(result.violations.some((v) => v.includes("signal evidence classification must be 'SIGNAL'"))).toBe(true);
    });
  });

  describe('P1B Approval Boundary Handoff (Unmet Dependency)', () => {
    it('MUST express approval boundary as UNMET_DEPENDENCY requiring AUTH-4 at SCR-003', () => {
      const handoff = PILOT_01_OFFLINE_FIXTURE.approval_boundary;

      expect(handoff.status).toBe('UNMET_DEPENDENCY');
      expect(handoff.required_authority).toBe('AUTH-4');
      expect(handoff.blocking_reason).toBe('AWAITING_HUMAN_APPROVAL_SCR003');
      expect(handoff.target_skill_id).toBe('skill.mkt.dispatch_campaign');

      // Passes harness invariant assertion without throwing
      expect(() => harness.assertApprovalHandoffUnmet(handoff)).not.toThrow();
    });

    it('MUST refuse any attempt to claim approval or dispatch without human verdict', () => {
      const fakeApprovedHandoff = {
        ...PILOT_01_OFFLINE_FIXTURE.approval_boundary,
        status: 'APPROVED',
      } as unknown as Pilot01ApprovalBoundaryHandoff;

      expect(() => harness.assertApprovalHandoffUnmet(fakeApprovedHandoff)).toThrow(MarketingRuntimeError);
      expect(() => harness.assertApprovalHandoffUnmet(fakeApprovedHandoff)).toThrow(/Dispatch must not be claimed/);
    });

    it('MUST refuse an unauthorized lower authority level', () => {
      const lowAuthorityHandoff = {
        ...PILOT_01_OFFLINE_FIXTURE.approval_boundary,
        required_authority: 'AUTH-2',
      } as unknown as Pilot01ApprovalBoundaryHandoff;

      expect(() => harness.assertApprovalHandoffUnmet(lowAuthorityHandoff)).toThrow(MarketingRuntimeError);
      expect(() => harness.assertApprovalHandoffUnmet(lowAuthorityHandoff)).toThrow(/requires 'AUTH-4'/);
    });
  });

  describe('Attribution Outcome Refusal of Absent Evidence', () => {
    it('MUST have empty outcome evidence and status UNAVAILABLE in offline baseline fixture', () => {
      const outcome = PILOT_01_OFFLINE_FIXTURE.outcome;

      expect(outcome.contract.status).toBe('UNAVAILABLE');
      expect(outcome.contract.reason).toBe('AWAITING_APPROVAL_AND_EXTERNAL_EXECUTION');
      expect(outcome.contract.evidence_ids).toEqual([]);
      expect(outcome.order_evidence).toEqual([]);
      expect(outcome.evidence).toEqual([]);
    });

    it('MUST refuse and return UNAVAILABLE for offline baseline when evaluated through harness', () => {
      const contract = harness.evaluateAttributionContract(
        PILOT_01_OFFLINE_FIXTURE.outcome.input,
        PILOT_01_OFFLINE_FIXTURE.outcome.order_evidence,
      );

      expect(contract.status).toBe('UNAVAILABLE');
      expect(contract.reason).toBe('ATTRIBUTION_EVIDENCE_ABSENT');
      expect(contract.evidence_ids).toEqual([]);
    });

    it('MUST refuse and return UNAVAILABLE for negative scenario with requested but absent evidence', () => {
      const contract = harness.evaluateAttributionContract(
        PILOT_01_NEGATIVE_ATTRIBUTION_FIXTURE.outcome.input,
        PILOT_01_NEGATIVE_ATTRIBUTION_FIXTURE.outcome.order_evidence,
      );

      expect(contract.status).toBe('UNAVAILABLE');
      expect(contract.reason).toBe('ATTRIBUTION_EVIDENCE_ABSENT');
      expect(contract.evidence_ids).toEqual([]);
    });

    it('MUST refuse absent evidence if requested evidence ID is missing from candidate evidence', () => {
      const contract = harness.evaluateAttributionContract(
        {
          ...PILOT_01_OFFLINE_FIXTURE.outcome.input,
          evidence_ids: ['ev-non-existent-999'],
        },
        [],
      );

      expect(contract.status).toBe('UNAVAILABLE');
      expect(contract.reason).toBe('ATTRIBUTION_EVIDENCE_ABSENT');
      expect(contract.evidence_ids).toEqual([]);
    });

    it('MUST refuse order evidence from a mismatched tenant or campaign scope', () => {
      const foreignOrderEvidence = [
        {
          tenant_id: 'different-tenant-99',
          campaign_id: PILOT_01_CAMPAIGN_ID,
          effect_key: PILOT_01_EFFECT_KEY,
          correlation_id: PILOT_01_CORRELATION_ID,
          evidence_id: 'ev-foreign-001',
          evidence_uri: 'erp://orders/FOREIGN-01',
          source_version: 'v1',
        },
      ];

      const contract = harness.evaluateAttributionContract(
        {
          ...PILOT_01_OFFLINE_FIXTURE.outcome.input,
          evidence_ids: ['ev-foreign-001'],
        },
        foreignOrderEvidence,
      );

      expect(contract.status).toBe('UNAVAILABLE');
      expect(contract.reason).toBe('ATTRIBUTION_EVIDENCE_INCOMPLETE_OR_UNMATCHED');
    });
  });

  describe('Staged Acceptance Harness (Signal -> Segment -> Campaign -> Content -> Brand Review -> AUTH-4 Approval -> Dispatch -> Response -> Attribution)', () => {
    it('MUST execute deterministic staged pipeline with injected canonical approval claim and report offline boundaries', async () => {
      // Pre-compute expected payload fingerprint for valid AUTH-4 decision
      const expectedPayload = {
        tenant_id: PILOT_01_TENANT_ID,
        campaign_id: PILOT_01_CAMPAIGN_ID,
        segment_id: 'seg-champions-pilot01',
        channel: 'LINE_FLEX',
        approved_content_id: 'draft-pilot01-tw-01',
        effect_key: PILOT_01_STAGED_EFFECT_KEY,
      };
      const digest = computeRequestFingerprint(expectedPayload);
      const approvalDecision: Pilot01HumanApprovalDecision = {
        approval_id: 'appr-pilot01-gate',
        decision: 'APPROVED',
        operator_id: 'op-compliance-leader-01',
        approved_payload_digest: digest,
        approved_at: '2026-03-01T09:00:00.000Z',
      };

      const result = await harness.executeStagedPipeline({
        approval_decision: approvalDecision,
        ports: {
          approvalPort: {
            claimApprovalAndResume: async () => ({
              claimed: true,
              approval_id: 'appr-pilot01-gate',
              decision: 'APPROVED' as const,
              operator_id: 'op-compliance-leader-01',
            }),
          },
        },
      });

      // Top-level markers
      expect(result.fixture_type).toBe('OFFLINE_FIXTURE');
      expect(result.evidence_status).toBe('NOT_RUNTIME_EVIDENCE');
      expect(result.tenant_id).toBe(PILOT_01_TENANT_ID);
      expect(result.campaign_id).toBe(PILOT_01_CAMPAIGN_ID);

      // Stage 1: Signal
      expect(result.stages.signal.stage).toBe('SIGNAL');
      expect(result.stages.signal.evidence.classification).toBe('SIGNAL');
      expect(result.stages.signal.observation.keyword).toBe('cold_brew_tea');

      // Stage 2: Segment (Criteria definition only, zero concrete audience)
      expect(result.stages.segment.stage).toBe('SEGMENT');
      expect(result.stages.segment.evidence.classification).toBe('HYPOTHESIS');
      expect(result.stages.segment.input.rfm_criteria).toBe('CHAMPIONS');
      expect(result.stages.segment.candidates).toHaveLength(0);

      // Stage 3: Campaign
      expect(result.stages.campaign.stage).toBe('CAMPAIGN');
      expect(result.stages.campaign.campaign_id).toBe(PILOT_01_CAMPAIGN_ID);
      expect(result.stages.campaign.locale).toBe('zh-TW');

      // Stage 4: Content
      expect(result.stages.content.stage).toBe('CONTENT');
      expect(result.stages.content.evidence.classification).toBe('DRAFT');
      expect(result.stages.content.output.draft_id).toBe('draft-pilot01-tw-01');

      // Stage 5: Brand Review
      expect(result.stages.review.stage).toBe('BRAND_REVIEW');
      expect(result.stages.review.evidence.classification).toBe('DECISION');
      expect(result.stages.review.audit.compliant).toBe(true);

      // Stage 6: AUTH-4 Approval
      expect(result.stages.approval.stage).toBe('APPROVAL');
      expect(result.stages.approval.status).toBe('APPROVED');
      expect(result.stages.approval.required_authority).toBe('AUTH-4');
      expect(result.stages.approval.approval_decision?.operator_id).toBe('op-compliance-leader-01');

      // Stage 7: Dispatch (Offline boundary)
      expect(result.stages.dispatch.stage).toBe('DISPATCH');
      expect(result.stages.dispatch.status).toBe('UNAVAILABLE_OFFLINE');
      expect(result.stages.dispatch.reason).toBe('PROVIDER_DISPATCH_UNAVAILABLE_OFFLINE');
      expect(result.stages.dispatch.provider_receipt).toBeNull();
      expect(result.stages.dispatch.message).toContain('Provider dispatch is unavailable in offline harness mode');

      // Stage 8: Response (Offline boundary)
      expect(result.stages.response.stage).toBe('RESPONSE');
      expect(result.stages.response.provider_status).toBe('UNAVAILABLE_OFFLINE');
      expect(result.stages.response.delivery_receipt).toBeNull();

      // Stage 9: Attribution (Offline boundary)
      expect(result.stages.attribution.stage).toBe('ATTRIBUTION');
      expect(result.stages.attribution.contract.status).toBe('UNAVAILABLE');
      expect(result.stages.attribution.contract.reason).toBe('ATTRIBUTION_EVIDENCE_ABSENT');
      expect(result.stages.attribution.order_evidence).toHaveLength(0);
      expect(result.stages.attribution.evidence).toHaveLength(0);

      // Offline summary explicitly reports unavailable components
      expect(result.offline_summary.provider_dispatch_available).toBe(false);
      expect(result.offline_summary.external_order_evidence_available).toBe(false);
      expect(result.offline_summary.provider_status).toBe('UNAVAILABLE_OFFLINE');
      expect(result.offline_summary.attribution_status).toBe('UNAVAILABLE');
      expect(result.offline_summary.notes.length).toBeGreaterThan(0);

      // Assert no prohibited numeric KPIs, budgets, revenue, or receipt objects in output
      const raw = JSON.stringify(result);
      expect(raw).not.toContain('"budget"');
      expect(raw).not.toContain('"revenue"');
      expect(raw).not.toContain('"kpi"');
      expect(raw).not.toContain('"conversion_rate"');
      expect(raw).not.toContain('"provider_receipt":{');
      expect(raw).not.toContain('"delivery_receipt":{');
      expect(raw).not.toContain('"erp://orders"');
    });

    it('MUST pause pipeline at Stage 6 when approval decision is not supplied (unmet dependency)', async () => {
      const result = await harness.executeStagedPipeline();

      expect(result.stages.approval.status).toBe('PAUSED_AWAITING_APPROVAL');
      expect(result.stages.approval.handoff?.status).toBe('UNMET_DEPENDENCY');
      expect(result.stages.approval.handoff?.required_authority).toBe('AUTH-4');
      expect(result.stages.approval.handoff?.blocking_reason).toBe('AWAITING_HUMAN_APPROVAL_SCR003');
      expect(result.stages.dispatch.status).toBe('UNAVAILABLE_OFFLINE');
      expect(result.stages.attribution.contract.status).toBe('UNAVAILABLE');
    });
    it('MUST remain PAUSED_AWAITING_APPROVAL when approval decision is provided without injected canonical approval claim/port', async () => {
      const expectedPayload = {
        tenant_id: PILOT_01_TENANT_ID,
        campaign_id: PILOT_01_CAMPAIGN_ID,
        segment_id: 'seg-champions-pilot01',
        channel: 'LINE_FLEX',
        approved_content_id: 'draft-pilot01-tw-01',
        effect_key: PILOT_01_STAGED_EFFECT_KEY,
      };
      const digest = computeRequestFingerprint(expectedPayload);
      const approvalDecision: Pilot01HumanApprovalDecision = {
        approval_id: 'appr-pilot01-gate',
        decision: 'APPROVED',
        operator_id: 'op-compliance-leader-01',
        approved_payload_digest: digest,
        approved_at: '2026-03-01T09:00:00.000Z',
      };

      const result = await harness.executeStagedPipeline({
        approval_decision: approvalDecision,
      });

      expect(result.stages.approval.status).toBe('PAUSED_AWAITING_APPROVAL');
      expect(result.stages.approval.handoff?.status).toBe('UNMET_DEPENDENCY');
    });

    it('MUST fail closed when AUTH-4 approval decision is REJECTED', async () => {
      const rejectedDecision: Pilot01HumanApprovalDecision = {
        approval_id: 'appr-pilot01-reject',
        decision: 'REJECTED',
        operator_id: 'op-compliance-reject-01',
        approved_payload_digest: 'some-digest',
        approved_at: '2026-03-01T09:00:00Z',
      };

      await expect(
        harness.executeStagedPipeline({
          approval_decision: rejectedDecision,
        }),
      ).rejects.toThrow(/APPROVAL_REJECTED/);
    });
  });

  describe('Negative-Case Validators & Stage Failure Handling', () => {
    // 1. Missing consent
    describe('1. Missing Consent', () => {
      it('MUST fail validator when consent is missing/not granted', () => {
        const missingConsentDecision: MarketingConsentDecision = {
          tenant_id: PILOT_01_TENANT_ID,
          customer_id: 'cust-no-consent-01',
          channel: 'LINE_FLEX',
          allowed: false,
          consent_timestamp: null,
          suppression_reason: null,
          source_uri: 'consent://db/tw',
          source_version: 'v1',
        };

        expect(() => harness.validateConsent(missingConsentDecision)).toThrow(MarketingRuntimeError);
        expect(() => harness.validateConsent(missingConsentDecision)).toThrow(/CONSENT_MISSING/);
        expect(() => validateConsent(missingConsentDecision)).toThrow(/CONSENT_MISSING/);
      });

      it('MUST fail staged pipeline when audience candidate lacks consent', async () => {
        await expect(
          harness.executeStagedPipeline({
            candidate_consents: [
              {
                customer_id: 'cust-unconsented-01',
                allowed: false,
                suppression_reason: null,
              },
            ],
          }),
        ).rejects.toThrow(/CONSENT_MISSING/);
      });
    });

    // 2. Suppressed customer
    describe('2. Suppressed Customer', () => {
      it('MUST fail validator when customer is suppressed', () => {
        const suppressedDecision: MarketingConsentDecision = {
          tenant_id: PILOT_01_TENANT_ID,
          customer_id: 'cust-suppressed-01',
          channel: 'LINE_FLEX',
          allowed: false,
          consent_timestamp: null,
          suppression_reason: 'SUPPRESSION_LIST_ACTIVE',
          source_uri: 'consent://db/tw',
          source_version: 'v1',
        };

        expect(() => harness.validateCustomerSuppression(suppressedDecision)).toThrow(MarketingRuntimeError);
        expect(() => harness.validateCustomerSuppression(suppressedDecision)).toThrow(/CUSTOMER_SUPPRESSED/);
        expect(() => harness.validateConsent(suppressedDecision)).toThrow(/CUSTOMER_SUPPRESSED/);
        expect(() => validateCustomerSuppression(suppressedDecision)).toThrow(/CUSTOMER_SUPPRESSED/);
      });

      it('MUST fail staged pipeline when candidate customer is suppressed', async () => {
        await expect(
          harness.executeStagedPipeline({
            candidate_consents: [
              {
                customer_id: 'cust-suppressed-02',
                allowed: false,
                suppression_reason: 'DO_NOT_CONTACT_GLOBAL',
              },
            ],
          }),
        ).rejects.toThrow(/CUSTOMER_SUPPRESSED/);
      });
    });

    // 3. Draft/unapproved knowledge
    describe('3. Draft / Unapproved Knowledge', () => {
      it('MUST fail validator when knowledge document status is draft or not approved', () => {
        const draftDoc: MarketingKnowledgeDocument = {
          path: 'brand/prohibited-claims.md',
          version: 'rev-draft-01',
          content: '---\nstatus: draft\n---\n# Unapproved Claims\n',
        };

        expect(() => harness.validateKnowledgeDocument(draftDoc)).toThrow(MarketingRuntimeError);
        expect(() => harness.validateKnowledgeDocument(draftDoc)).toThrow(/DOCUMENT_NOT_APPROVED/);
        expect(() => validateKnowledgeDocument(draftDoc)).toThrow(/DOCUMENT_NOT_APPROVED/);
      });

      it('MUST fail validator when knowledge document is empty or path mismatched', () => {
        const emptyDoc: MarketingKnowledgeDocument = {
          path: 'brand/prohibited-claims.md',
          version: 'rev-01',
          content: '',
        };

        expect(() => harness.validateKnowledgeDocument(emptyDoc)).toThrow(MarketingRuntimeError);
        expect(() => harness.validateKnowledgeDocument(emptyDoc)).toThrow(/KNOWLEDGE_DOCUMENT_INVALID/);

        expect(() =>
          harness.validateKnowledgeDocument(
            PILOT_01_APPROVED_PROHIBITED_CLAIMS_DOC,
            'brand/different-expected-path.md',
          ),
        ).toThrow(/KNOWLEDGE_DOCUMENT_INVALID/);
      });

      it('MUST fail staged pipeline when unapproved draft knowledge document is injected', async () => {
        const draftDoc: MarketingKnowledgeDocument = {
          path: 'brand/prohibited-claims.md',
          version: 'v-unapproved',
          content: '---\nstatus: draft\n---\nDraft prohibited claims content',
        };

        await expect(
          harness.executeStagedPipeline({
            knowledge_documents: [draftDoc],
          }),
        ).rejects.toThrow(/DOCUMENT_NOT_APPROVED/);
      });
    });

    // 4. Prohibited claim
    describe('4. Prohibited Claim', () => {
      it('MUST fail validator when brand audit report contains prohibited claim violations', () => {
        const nonCompliantAudit: MarketingBrandAuditOutput = {
          compliant: false,
          violations: [
            {
              rule_id: 'RULE_PROHIBITED_CLAIM_1',
              severity: 'BLOCKING',
              snippet: '醫療級療效',
              suggestion: 'Remove prohibited claim',
            },
          ],
          confidence_score: 0.95,
        };

        expect(() => harness.validateBrandCompliance(nonCompliantAudit)).toThrow(MarketingRuntimeError);
        expect(() => harness.validateBrandCompliance(nonCompliantAudit)).toThrow(/PROHIBITED_CLAIM_VIOLATION/);
        expect(() => validateBrandCompliance(nonCompliantAudit)).toThrow(/PROHIBITED_CLAIM_VIOLATION/);
      });

      it('MUST fail staged pipeline when content audit detects prohibited claims', async () => {
        await expect(
          harness.executeStagedPipeline({
            ports: {
              brandAuditor: () => ({
                compliant: false,
                violations: [
                  {
                    rule_id: 'RULE_PROHIBITED_CLAIM_10x',
                    severity: 'BLOCKING',
                    snippet: 'Guaranteed 10x returns',
                    suggestion: 'Remove claim',
                  },
                ],
                confidence_score: 0.98,
              }),
            },
          }),
        ).rejects.toThrow(/PROHIBITED_CLAIM_VIOLATION/);
      });
    });

    // 5. Invented/unverified price
    describe('5. Invented / Unverified Price', () => {
      it('MUST fail validator when text contains invented price or unverified discount claims', () => {
        const violations = [
          '限時優惠只要 $99 元！',
          '全館商品 50% off 大促銷！',
          '特惠價 NT$299 立即搶購',
          'Only USD 49 for spring bundle',
          '今日下單享 100% free 免費贈送',
          '提供 30 天 money back guarantee',
        ];

        for (const text of violations) {
          expect(() => harness.validatePriceClaims(text)).toThrow(MarketingRuntimeError);
          expect(() => harness.validatePriceClaims(text)).toThrow(/UNVERIFIED_PRICE_CLAIM/);
          expect(() => validatePriceClaims(text)).toThrow(/UNVERIFIED_PRICE_CLAIM/);
        }
      });

      it('MUST pass price validator for clean brand text without prices', () => {
        const cleanText = '精選台灣高山茶葉，低溫慢萃保留甘甜鮮爽滋味。立即探索春日限定風味。';
        expect(() => harness.validatePriceClaims(cleanText)).not.toThrow();
        expect(() => validatePriceClaims(cleanText)).not.toThrow();
      });

      it('MUST fail staged pipeline when content generator generates copy with unverified price', async () => {
        await expect(
          harness.executeStagedPipeline({
            ports: {
              contentGenerator: () => ({
                draft_id: 'draft-invented-price',
                headline: '春季限定只要 $19.99',
                body_content: '高山茶葉 50% off 優惠。',
                cta_text: '立即搶購',
                channel_payload: { channel_type: 'LINE_FLEX' },
              }),
            },
          }),
        ).rejects.toThrow(/UNVERIFIED_PRICE_CLAIM/);
      });
    });

    // 6. Stale approval digest
    describe('6. Stale Approval Digest', () => {
      it('MUST fail validator when approval digest does not match current payload hash', () => {
        const currentSha = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
        const staleSha = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

        expect(() => harness.validateApprovalDigest(currentSha, staleSha)).toThrow(MarketingRuntimeError);
        expect(() => harness.validateApprovalDigest(currentSha, staleSha)).toThrow(/STALE_APPROVAL_DIGEST/);
        expect(() => validateApprovalDigest(currentSha, staleSha)).toThrow(/STALE_APPROVAL_DIGEST/);
      });

      it('MUST fail staged pipeline when approval decision carries a stale digest', async () => {
        const staleDecision: Pilot01HumanApprovalDecision = {
          approval_id: 'appr-pilot01-stale',
          decision: 'APPROVED',
          operator_id: 'op-stale-test-01',
          approved_payload_digest: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
          approved_at: '2026-03-01T08:30:00Z',
        };

        await expect(
          harness.executeStagedPipeline({
            approval_decision: staleDecision,
          }),
        ).rejects.toThrow(/STALE_APPROVAL_DIGEST/);
      });
    });

    // 7. Changed payload after approval
    describe('7. Changed Payload After Approval', () => {
      it('MUST fail validator when payload has been modified post-approval', () => {
        const originalPayload = {
          tenant_id: PILOT_01_TENANT_ID,
          campaign_id: PILOT_01_CAMPAIGN_ID,
          channel: 'LINE_FLEX',
        };
        const approvedDigest = computeRequestFingerprint(originalPayload);

        const tamperedPayload = {
          ...originalPayload,
          channel: 'EMAIL', // payload modified after approval
        };

        expect(() => harness.validatePayloadIntegrity(approvedDigest, tamperedPayload)).toThrow(MarketingRuntimeError);
        expect(() => harness.validatePayloadIntegrity(approvedDigest, tamperedPayload)).toThrow(
          /PAYLOAD_TAMPERED_AFTER_APPROVAL/,
        );
        expect(() => validatePayloadIntegrity(approvedDigest, tamperedPayload)).toThrow(
          /PAYLOAD_TAMPERED_AFTER_APPROVAL/,
        );
      });

      it('MUST fail staged pipeline when dispatch payload is tampered post-approval', async () => {
        // Compute digest for an older draft ID
        const preTamperedPayload = {
          tenant_id: PILOT_01_TENANT_ID,
          campaign_id: PILOT_01_CAMPAIGN_ID,
          segment_id: 'seg-champions-pilot01',
          channel: 'LINE_FLEX',
          approved_content_id: 'old-draft-id-999',
          effect_key: PILOT_01_STAGED_EFFECT_KEY,
        };
        const digest = computeRequestFingerprint(preTamperedPayload);
        const decision: Pilot01HumanApprovalDecision = {
          approval_id: 'appr-pilot01-tamper',
          decision: 'APPROVED',
          operator_id: 'op-tamper-test',
          approved_payload_digest: digest,
          approved_at: '2026-03-01T09:00:00Z',
        };

        // Pipeline uses draft-pilot01-tw-01 by default, which does not match old-draft-id-999
        await expect(
          harness.executeStagedPipeline({
            approval_decision: decision,
          }),
        ).rejects.toThrow(/STALE_APPROVAL_DIGEST/);
      });
    });

    // 8. AUTH-5
    describe('8. AUTH-5 Prohibition', () => {
      it('MUST fail validator when authority requirement is AUTH-5 (terminal hard deny)', () => {
        expect(() => harness.validateAuthority('AUTH-3', 'AUTH-5')).toThrow(MarketingRuntimeError);
        expect(() => harness.validateAuthority('AUTH-3', 'AUTH-5')).toThrow(/PROHIBITED_ACTION/);
        expect(() => validateAuthority('AUTH-3', 'AUTH-5')).toThrow(/PROHIBITED_ACTION/);
      });

      it('MUST fail validator when granted authority is AUTH-5', () => {
        expect(() => harness.validateAuthority('AUTH-5', 'AUTH-4')).toThrow(MarketingRuntimeError);
        expect(() => harness.validateAuthority('AUTH-5', 'AUTH-4')).toThrow(/PROHIBITED_ACTION/);
        expect(() => validateAuthority('AUTH-5', 'AUTH-4')).toThrow(/PROHIBITED_ACTION/);
      });

      it('MUST fail staged pipeline when approval decision claims invalid AUTH-5', async () => {
        const invalidDecision = {
          decision: 'APPROVED',
          operator_id: 'op-auth5-illegal',
          granted_authority: 'AUTH-5', // invalid/prohibited authority
          approved_payload_digest: 'some-hash',
          approved_at: '2026-03-01T09:00:00Z',
        } as unknown as Pilot01HumanApprovalDecision;

        await expect(
          harness.executeStagedPipeline({
            approval_decision: invalidDecision,
          }),
        ).rejects.toThrow(/PROHIBITED_ACTION/);
      });
    });

    // 9. Duplicate dispatch
    describe('9. Duplicate Dispatch', () => {
      it('MUST fail validator when effect key has already been reserved', () => {
        const reservedSet = new Set<string>([PILOT_01_STAGED_EFFECT_KEY]);

        expect(() => harness.validateEffectReservation(PILOT_01_STAGED_EFFECT_KEY, reservedSet)).toThrow(
          MarketingRuntimeError,
        );
        expect(() => harness.validateEffectReservation(PILOT_01_STAGED_EFFECT_KEY, reservedSet)).toThrow(
          /DUPLICATE_DISPATCH/,
        );
        expect(() => validateEffectReservation(PILOT_01_STAGED_EFFECT_KEY, reservedSet)).toThrow(
          /DUPLICATE_DISPATCH/,
        );
      });

      it('MUST fail staged pipeline when effect key was already reserved prior to dispatch', async () => {
        await expect(
          harness.executeStagedPipeline({
            reserved_effect_keys: new Set<string>([PILOT_01_STAGED_EFFECT_KEY]),
          }),
        ).rejects.toThrow(/DUPLICATE_DISPATCH/);
      });
    });

    // 10. Provider UNKNOWN
    describe('10. Provider UNKNOWN', () => {
      it('MUST fail validator when provider response returns UNKNOWN or INDETERMINATE status', () => {
        expect(() => harness.validateProviderResponse({ status: 'UNKNOWN' })).toThrow(MarketingRuntimeError);
        expect(() => harness.validateProviderResponse({ status: 'UNKNOWN' })).toThrow(/PROVIDER_UNKNOWN/);

        expect(() => harness.validateProviderResponse({ status: 'INDETERMINATE' })).toThrow(MarketingRuntimeError);
        expect(() => harness.validateProviderResponse({ status: 'INDETERMINATE' })).toThrow(/PROVIDER_UNKNOWN/);
        expect(() => validateProviderResponse({ status: 'UNKNOWN' })).toThrow(/PROVIDER_UNKNOWN/);
      });

      it('MUST fail staged pipeline when injected provider dispatcher returns UNKNOWN', async () => {
        await expect(
          harness.executeStagedPipeline({
            ports: {
              providerDispatcher: () => ({ status: 'UNKNOWN', error: 'Indeterminate network partition' }),
            },
          }),
        ).rejects.toThrow(/PROVIDER_UNKNOWN/);
      });
    });

    // 11. Tenant leakage
    describe('11. Tenant Leakage', () => {
      it('MUST fail validator when item tenant does not match expected tenant', () => {
        const rogueItem = { tenant_id: 'tenant-intruder-tw' };

        expect(() => harness.validateTenantIsolation(PILOT_01_TENANT_ID, rogueItem, 'candidate')).toThrow(
          MarketingRuntimeError,
        );
        expect(() => harness.validateTenantIsolation(PILOT_01_TENANT_ID, rogueItem, 'candidate')).toThrow(
          /TENANT_MISMATCH/,
        );
        expect(() => validateTenantIsolation(PILOT_01_TENANT_ID, rogueItem, 'candidate')).toThrow(
          /TENANT_MISMATCH/,
        );
      });

      it('MUST fail staged pipeline when cross-tenant signal observation is injected', async () => {
        await expect(
          harness.executeStagedPipeline({
            ports: {
              signalReader: () => ({
                signals: [
                  {
                    signal_id: 'sig-foreign-001',
                    keyword: 'bubble_tea',
                    search_volume_growth: 1.2,
                    price_pressure_index: 0.1,
                  },
                ],
                trend_velocity: 'STABLE',
                analyzed_at: '2026-03-01T08:00:00Z',
              }),
            },
            signal_input: {
              tenant_id: 'foreign-tenant-xyz' as string, // cross-tenant leakage
            },
          }),
        ).rejects.toThrow(/TENANT_MISMATCH/);
      });
    });

    // 12. Missing attribution evidence
    describe('12. Missing Attribution Evidence', () => {
      it('MUST refuse absent attribution evidence and return UNAVAILABLE without inventing data', () => {
        const contract = harness.evaluateAttributionContract(
          PILOT_01_OFFLINE_FIXTURE.outcome.input,
          [],
        );

        expect(contract.status).toBe('UNAVAILABLE');
        expect(contract.reason).toBe('ATTRIBUTION_EVIDENCE_ABSENT');
        expect(contract.evidence_ids).toEqual([]);
      });

      it('MUST fail assertion when attribution evidence is absent or requested IDs are missing', () => {
        expect(() =>
          harness.assertAttributionEvidenceAvailable(PILOT_01_OFFLINE_FIXTURE.outcome.input, []),
        ).toThrow(MarketingRuntimeError);
        expect(() =>
          harness.assertAttributionEvidenceAvailable(PILOT_01_OFFLINE_FIXTURE.outcome.input, []),
        ).toThrow(/ATTRIBUTION_EVIDENCE_ABSENT/);
        expect(() =>
          assertAttributionEvidenceAvailable(PILOT_01_OFFLINE_FIXTURE.outcome.input, []),
        ).toThrow(/ATTRIBUTION_EVIDENCE_ABSENT/);

        const partialEvidence = [
          {
            tenant_id: PILOT_01_TENANT_ID,
            campaign_id: PILOT_01_CAMPAIGN_ID,
            effect_key: PILOT_01_EFFECT_KEY,
            correlation_id: PILOT_01_CORRELATION_ID,
            evidence_id: 'ev-existing-001',
            evidence_uri: 'erp://orders/ORD-01',
            source_version: 'v1',
          },
        ];

        expect(() =>
          harness.assertAttributionEvidenceAvailable(
            {
              ...PILOT_01_OFFLINE_FIXTURE.outcome.input,
              evidence_ids: ['ev-missing-002'],
            },
            partialEvidence,
          ),
        ).toThrow(/ATTRIBUTION_EVIDENCE_INCOMPLETE_OR_UNMATCHED/);
      });

      it('MUST clearly report in staged pipeline that external order evidence is absent offline', async () => {
        const result = await harness.executeStagedPipeline();

        expect(result.stages.attribution.contract.status).toBe('UNAVAILABLE');
        expect(result.stages.attribution.contract.reason).toBe('ATTRIBUTION_EVIDENCE_ABSENT');
        expect(result.stages.attribution.evidence).toHaveLength(0);
        expect(result.stages.attribution.order_evidence).toHaveLength(0);
        expect(result.offline_summary.external_order_evidence_available).toBe(false);
      });
    });
  });
});
