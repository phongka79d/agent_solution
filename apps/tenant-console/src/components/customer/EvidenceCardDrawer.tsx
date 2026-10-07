/**
 * Slide-out drawer grouping a customer's evidence cards into the five FR-C360-003 tiers:
 * FACT, SIGNAL, HYPOTHESIS, DECISION, ACTION.
 * Visibly separates AI inference (HYPOTHESIS) from verified ground truth (FACT).
 */
'use client';

import { useEffect, useRef } from 'react';
import { AdvancedDetails } from '@agentos/ui-foundation/react';
import type { EvidenceClassification } from '@agentos/ui-foundation';
import type { EvidenceCard } from './types';

interface EvidenceCardDrawerProps {
  readonly evidenceCards: readonly EvidenceCard[];
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly focusedClassification?: EvidenceClassification | null | undefined;
}

const TIER_ORDER: readonly EvidenceClassification[] = [
  'FACT',
  'SIGNAL',
  'HYPOTHESIS',
  'DECISION',
  'ACTION',
];

const TIER_META: Record<
  EvidenceClassification,
  {
    readonly label: string;
    readonly description: string;
    readonly dot: string;
    readonly text: string;
    readonly border: string;
    readonly badge: string;
  }
> = {
  FACT: {
    label: 'Verified Facts',
    description: 'System of Record ground truth (ERP, POS, WMS, Payment Gateway).',
    dot: 'tenant-evidence-dot--success',
    text: 'text-success',
    border: 'border-success-border',
    badge: 'tenant-evidence-badge--success',
  },
  SIGNAL: {
    label: 'Observed Signals',
    description: 'Direct telemetry and raw behavioral events before interpretation.',
    dot: 'tenant-evidence-dot--info',
    text: 'text-info',
    border: 'border-info-border',
    badge: 'tenant-evidence-badge--info',
  },
  HYPOTHESIS: {
    label: 'Dự đoán',
    description: 'AI model predictions; strictly segregated and NEVER persisted as ground truth.',
    dot: 'tenant-evidence-dot--warning',
    text: 'text-warning',
    border: 'border-warning-border',
    badge: 'tenant-evidence-badge--warning',
  },
  DECISION: {
    label: 'Recorded Decisions',
    description: 'Audited human or governance decisions (e.g. AUTH-4 approval sign-off).',
    dot: 'tenant-evidence-dot--ai',
    text: 'text-ai-text',
    border: 'border-ai-border',
    badge: 'tenant-evidence-badge--ai',
  },
  ACTION: {
    label: 'Executed Actions',
    description: 'External effects dispatched to providers or downstream channels.',
    dot: 'tenant-evidence-dot--success',
    text: 'text-success',
    border: 'border-success-border',
    badge: 'tenant-evidence-badge--success',
  },
};

export function EvidenceCardDrawer({
  evidenceCards,
  isOpen,
  onClose,
  focusedClassification,
}: EvidenceCardDrawerProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen) return undefined;
    dialogRef.current?.focus();
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;
  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      className="tenant-evidence-drawer"
      role="dialog"
      aria-modal="true"
      aria-labelledby="evidence-drawer-title"
    >
      <div className="tenant-evidence-drawer__header">
        <div>
          <h2 id="evidence-drawer-title" className="text-headline-md font-semibold text-ink">
            Evidence Cards — Five-Tier Separation
          </h2>
          <p className="mt-1 text-sm text-muted">
            Ground truth, observations, AI inference, recorded decisions, and executed effects are
            strictly segregated per FR-C360-003.
          </p>
        </div>
        <button type="button" onClick={onClose} className="ui-button ui-button--ghost ui-button--sm">
          Close
        </button>
      </div>

      {/* Cards List Grouped by Tier */}
      <div className="space-y-8 flex-1">
        {TIER_ORDER.map((tier) => {
          const cards = evidenceCards.filter((e) => e.classification === tier);
          if (cards.length === 0) return null;
          const meta = TIER_META[tier];
          const isFocused = focusedClassification === tier;

          return (
            <div
              key={tier}
              className={`tenant-evidence-tier ${tier === 'HYPOTHESIS' ? 'tenant-evidence-tier--hypothesis' : ''} ${isFocused ? 'tenant-evidence-tier--focused' : ''}`}
            >
              <div className="tenant-evidence-tier__header">
                <div className="flex items-center gap-2">
                  <span className={`tenant-evidence-dot ${meta.dot}`} aria-hidden="true" />
                  <h3 className={`text-xs font-semibold uppercase tracking-wider ${meta.text}`}>
                    {meta.label} ({cards.length})
                  </h3>
                </div>
                <span className={`tenant-evidence-badge ${meta.badge}`}>{meta.label}</span>
              </div>

              <p className="mb-3 text-sm text-muted">{meta.description}</p>

              {tier === 'HYPOTHESIS' ? (
                <div className="tenant-notice tenant-notice--warning mb-3 font-mono text-xs">
                  <strong>ATTENTION:</strong> The items below are AI model inferences. They must
                  never be cited as factual ground truth or written back to the customer profile.
                </div>
              ) : null}

              {/* Cards in this Tier */}
              <div className="space-y-3">
                {cards.map((card) => {
                  const confidencePercent = Math.round(card.confidenceScore * 100);

                  return (
                    <div
                      key={card.evidenceId}
                      className={`tenant-evidence-card ${meta.border}`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2 text-xs font-mono">
                        <span className="font-semibold text-ink">{card.eventType}</span>
                        <AdvancedDetails summary="Chi tiết kỹ thuật">
                          <span className="text-xs text-muted">evidence_id: {card.evidenceId}</span>
                        </AdvancedDetails>
                      </div>

                      <div className="tenant-evidence-card__meta">
                        <span>
                          Source: <strong className="text-ink">{card.sourceOfTruth}</strong>
                        </span>
                        {card.classification === 'HYPOTHESIS' ? (
                          <span className="font-semibold text-warning">
                            Model Confidence: {confidencePercent}%
                          </span>
                        ) : (
                          <span className="text-success">Recorded Confidence: 100%</span>
                        )}
                      </div>

                      {card.rawRecordRef && (
                        <AdvancedDetails summary="Nguồn dữ liệu">
                          <div className="tenant-evidence-card__technical">
                            <span>system: <strong>{card.rawRecordRef.system || '—'}</strong></span>
                            <span>external_id: <strong>{card.rawRecordRef.externalId || '—'}</strong></span>
                            {card.rawRecordRef.verifiedAt ? <span>verified_at: <strong>{new Date(card.rawRecordRef.verifiedAt).toLocaleString()}</strong></span> : null}
                          </div>
                        </AdvancedDetails>
                      )}

                      {card.payload && Object.keys(card.payload).length > 0 ? (
                        <AdvancedDetails summary="Dữ liệu kỹ thuật">
                          <pre className="tenant-evidence-card__technical overflow-x-auto whitespace-pre-wrap">
                            {JSON.stringify(card.payload, null, 2)}
                          </pre>
                        </AdvancedDetails>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
