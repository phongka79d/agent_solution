/**
 * @file Unit tests for P3 PILOT-01 offline fixture and harness interface.
 *
 * Validates:
 * 1. Offline fixture markers (OFFLINE_FIXTURE / NOT_RUNTIME_EVIDENCE).
 * 2. Stage-to-stage evidence linkage (tenant_id, campaign_id, effect_key, correlation_id).
 * 3. Evidence classification invariants (SIGNAL, HYPOTHESIS, DRAFT, DECISION).
 * 4. P1B human approval boundary invariants (unmet dependency, AUTH-4, SCR-003, no dispatch).
 * 5. Outcome stage invariants: empty outcome evidence, status UNAVAILABLE (no fake receipts).
 * 6. Refusal of absent attribution evidence without treating local literals as external proof.
 * 7. Absence of prohibited runtime claims (no numeric KPIs, budgets, revenue, audiences, or fake receipts).
 */

import { describe, expect, it } from 'vitest';
import {
  createPilot01Harness,
  PILOT_01_CAMPAIGN_ID,
  PILOT_01_CORRELATION_ID,
  PILOT_01_EFFECT_KEY,
  PILOT_01_FIXTURE_MARKER,
  PILOT_01_NEGATIVE_ATTRIBUTION_FIXTURE,
  PILOT_01_OFFLINE_FIXTURE,
  PILOT_01_RUNTIME_EVIDENCE_STATUS,
  PILOT_01_TENANT_ID,
  type Pilot01ApprovalBoundaryHandoff,
  type Pilot01StageEvidence,
} from './pilot-01.fixture.js';
import { MarketingRuntimeError } from './contracts.js';

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
});
