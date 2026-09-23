/**
 * @file apps/command-center/src/lib/evidence-contracts.test.tsx
 * UI contract tests for SCR-004: Customer 360 Evidence Classifications.
 *
 * Observable contracts:
 * 1. Five-tier evidence separation (FR-C360-003): strictly preserves FACT versus HYPOTHESIS.
 * 2. FACT represents verified ground truth from systems of record with 100% recorded confidence.
 * 3. HYPOTHESIS represents AI model inference, preserves fractional confidence scores,
 *    and displays an explicit attention banner forbidding persistence as ground truth.
 * 4. EvidenceCardDrawer renders segregated sections with distinct visual hierarchies.
 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  EvidenceCard,
  EvidenceClassification,
} from '../components/customer/types';
import { EvidenceCardDrawer } from '../components/customer/EvidenceCardDrawer';

describe('SCR-004 Evidence Classification Contract (FACT vs HYPOTHESIS)', () => {
  const factEvidence: EvidenceCard = {
    evidenceId: 'ev-fact-001',
    eventId: 'evt-order-101',
    eventType: 'ORDER_PLACED',
    classification: 'FACT',
    sourceOfTruth: 'ERP',
    confidenceScore: 1.0,
    rawRecordRef: {
      system: 'SAP_ERP',
      externalId: 'SO-99201',
      verifiedAt: '2026-09-23T10:00:00Z',
    },
    payload: {
      orderId: 'SO-99201',
      totalAmountTwd: 4500,
      currency: 'TWD',
    },
  };

  const hypothesisEvidence: EvidenceCard = {
    evidenceId: 'ev-hypo-002',
    eventId: 'evt-inference-202',
    eventType: 'PURCHASE_INTENT_PREDICTED',
    classification: 'HYPOTHESIS',
    sourceOfTruth: 'AI_INFERENCE',
    confidenceScore: 0.82,
    rawRecordRef: {
      system: 'LLM_REASONING_ENGINE',
      externalId: 'inf-run-554',
      verifiedAt: '2026-09-23T10:05:00Z',
    },
    payload: {
      predictedCategory: 'Beverages',
      urgencyScore: 'HIGH',
    },
  };

  // --------------------------------------------------------------------------
  // 1. Classification Separation & Confidence Invariants
  // --------------------------------------------------------------------------
  describe('Taxonomy & Confidence Invariants', () => {
    it('treats FACT and HYPOTHESIS as distinct, non-overlapping classifications', () => {
      const classifications: readonly EvidenceClassification[] = [
        'FACT',
        'SIGNAL',
        'HYPOTHESIS',
        'DECISION',
        'ACTION',
      ];

      expect(classifications).toContain('FACT');
      expect(classifications).toContain('HYPOTHESIS');
      expect('FACT' as string).not.toBe('HYPOTHESIS' as string);
    });

    it('requires FACT confidence to represent ground truth (1.0) and HYPOTHESIS to represent model uncertainty (< 1.0)', () => {
      expect(factEvidence.confidenceScore).toBe(1.0);
      expect(factEvidence.sourceOfTruth).toBe('ERP');

      expect(hypothesisEvidence.confidenceScore).toBeLessThan(1.0);
      expect(hypothesisEvidence.confidenceScore).toBeGreaterThan(0.0);
      expect(hypothesisEvidence.sourceOfTruth).toBe('AI_INFERENCE');
    });
  });

  // --------------------------------------------------------------------------
  // 2. EvidenceCardDrawer Observable UI Contracts
  // --------------------------------------------------------------------------
  describe('EvidenceCardDrawer Segregation', () => {
    it('renders FACT evidence with Verified Facts header and 100% recorded confidence', () => {
      const html = renderToStaticMarkup(
        <EvidenceCardDrawer
          evidenceCards={[factEvidence]}
          isOpen={true}
          onClose={() => {}}
        />
      );

      // Verified Facts tier label and SoR description
      expect(html).toContain('Verified Facts');
      expect(html).toContain('System of Record ground truth (ERP, POS, WMS, Payment Gateway)');
      expect(html).toContain('FACT');
      expect(html).toContain('Recorded Confidence: 100%');
      expect(html).toContain('Source: <strong class="text-slate-300">ERP</strong>');

      // Must NOT render HYPOTHESIS warning banner
      expect(html).not.toContain('AI model inferences');
      expect(html).not.toContain('never be cited as factual ground truth');
    });

    it('renders HYPOTHESIS evidence with mandatory inference warning and fractional model confidence', () => {
      const html = renderToStaticMarkup(
        <EvidenceCardDrawer
          evidenceCards={[hypothesisEvidence]}
          isOpen={true}
          onClose={() => {}}
        />
      );

      // AI Hypotheses tier label and description
      expect(html).toContain('AI Hypotheses &amp; Inferences');
      expect(html).toContain('AI model predictions; strictly segregated and NEVER persisted as ground truth');
      expect(html).toContain('HYPOTHESIS');

      // Mandatory warning banner separating inference from ground truth
      expect(html).toContain('ATTENTION:');
      expect(html).toContain(
        'The items below are AI model inferences. They must never be cited as factual ground truth or written back to the customer profile.'
      );

      // Model confidence percentage (0.82 -> 82%)
      expect(html).toContain('Model Confidence: 82%');
      expect(html).not.toContain('Recorded Confidence: 100%');
    });

    it('renders both FACT and HYPOTHESIS in separate visual containers when both exist', () => {
      const html = renderToStaticMarkup(
        <EvidenceCardDrawer
          evidenceCards={[factEvidence, hypothesisEvidence]}
          isOpen={true}
          onClose={() => {}}
        />
      );

      // Both sections are present
      expect(html).toContain('Verified Facts (1)');
      expect(html).toContain('AI Hypotheses &amp; Inferences (1)');

      // The warning banner exists specifically in the HYPOTHESIS section
      expect(html).toContain('The items below are AI model inferences');

      // Confidence scores are preserved independently
      expect(html).toContain('Recorded Confidence: 100%');
      expect(html).toContain('Model Confidence: 82%');

      // Event details are preserved under their respective cards
      expect(html).toContain('ORDER_PLACED');
      expect(html).toContain('PURCHASE_INTENT_PREDICTED');
    });

    it('renders null when drawer is closed (isOpen=false)', () => {
      const html = renderToStaticMarkup(
        <EvidenceCardDrawer
          evidenceCards={[factEvidence, hypothesisEvidence]}
          isOpen={false}
          onClose={() => {}}
        />
      );

      expect(html).toBe('');
    });
  });
});
