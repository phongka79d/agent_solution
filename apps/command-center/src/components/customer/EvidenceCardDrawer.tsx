/**
 * @file apps/command-center/src/components/customer/EvidenceCardDrawer.tsx
 * Slide-out drawer grouping a customer's evidence cards into the five FR-C360-003 tiers:
 * FACT, SIGNAL, HYPOTHESIS, DECISION, ACTION.
 * Visibly separates AI inference (HYPOTHESIS) from verified ground truth (FACT).
 */
'use client';

import React from 'react';
import type { EvidenceCard, EvidenceClassification } from './types';

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
    dot: 'bg-emerald-400',
    text: 'text-emerald-300',
    border: 'border-emerald-800/80',
    badge: 'bg-emerald-950/80 text-emerald-300 border-emerald-700',
  },
  SIGNAL: {
    label: 'Observed Signals',
    description: 'Direct telemetry and raw behavioral events before interpretation.',
    dot: 'bg-sky-400',
    text: 'text-sky-300',
    border: 'border-sky-800/80',
    badge: 'bg-sky-950/80 text-sky-300 border-sky-700',
  },
  HYPOTHESIS: {
    label: 'AI Hypotheses & Inferences',
    description: 'AI model predictions; strictly segregated and NEVER persisted as ground truth.',
    dot: 'bg-amber-400',
    text: 'text-amber-300',
    border: 'border-amber-700/80',
    badge: 'bg-amber-950/90 text-amber-300 border-amber-600 animate-pulse',
  },
  DECISION: {
    label: 'Recorded Decisions',
    description: 'Audited human or governance decisions (e.g. AUTH-4 approval sign-off).',
    dot: 'bg-violet-400',
    text: 'text-violet-300',
    border: 'border-violet-800/80',
    badge: 'bg-violet-950/80 text-violet-300 border-violet-700',
  },
  ACTION: {
    label: 'Executed Actions',
    description: 'External effects dispatched to providers or downstream channels.',
    dot: 'bg-teal-400',
    text: 'text-teal-300',
    border: 'border-teal-800/80',
    badge: 'bg-teal-950/80 text-teal-300 border-teal-700',
  },
};

export function EvidenceCardDrawer({
  evidenceCards,
  isOpen,
  onClose,
  focusedClassification,
}: EvidenceCardDrawerProps) {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-y-0 right-0 w-full max-w-2xl bg-slate-900 border-l border-slate-800 shadow-2xl z-50 p-6 overflow-y-auto flex flex-col"
      role="dialog"
      aria-modal="true"
      aria-labelledby="evidence-drawer-title"
    >
      {/* Header */}
      <div className="flex justify-between items-start pb-4 border-b border-slate-800 mb-6">
        <div>
          <h2 id="evidence-drawer-title" className="text-lg font-bold text-slate-100">
            Evidence Cards — Five-Tier Separation
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Ground truth, observations, AI inference, recorded decisions, and executed effects are
            strictly segregated per FR-C360-003.
          </p>
        </div>
        <button
          onClick={onClose}
          className="text-slate-400 hover:text-slate-200 text-xs px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-750 transition-colors"
        >
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
              className={`p-4 rounded-xl border ${
                tier === 'HYPOTHESIS'
                  ? 'bg-amber-950/20 border-amber-800/60'
                  : 'bg-slate-950/40 border-slate-800/80'
              } ${isFocused ? 'ring-2 ring-sky-500' : ''}`}
            >
              {/* Tier Header */}
              <div className="flex items-center justify-between gap-2 mb-2 pb-2 border-b border-slate-800/60">
                <div className="flex items-center gap-2">
                  <span className={`w-2.5 h-2.5 rounded-full ${meta.dot}`}></span>
                  <h3 className={`text-xs font-bold ${meta.text} uppercase tracking-wider`}>
                    {meta.label} ({cards.length})
                  </h3>
                </div>
                <span className={`px-2 py-0.5 text-[10px] font-mono rounded border ${meta.badge}`}>
                  {tier}
                </span>
              </div>

              <p className="text-[11px] text-slate-400 mb-3">{meta.description}</p>

              {/* Special Warning Banner for HYPOTHESIS to visibly separate from FACT */}
              {tier === 'HYPOTHESIS' && (
                <div className="p-2.5 mb-3 bg-amber-950/50 border border-amber-700/60 rounded-lg text-amber-200 text-[11px] font-mono">
                  <strong>ATTENTION:</strong> The items below are AI model inferences. They must
                  never be cited as factual ground truth or written back to the customer profile.
                </div>
              )}

              {/* Cards in this Tier */}
              <div className="space-y-3">
                {cards.map((card) => {
                  const confidencePercent = Math.round(card.confidenceScore * 100);

                  return (
                    <div
                      key={card.evidenceId}
                      className={`p-3.5 bg-slate-900 rounded-lg border ${meta.border} space-y-2`}
                    >
                      <div className="flex justify-between items-start text-xs font-mono gap-2 flex-wrap">
                        <span className="text-slate-200 font-semibold">{card.eventType}</span>
                        <span className="text-[11px] text-slate-400">
                          ID: <strong className="text-slate-300">{card.evidenceId}</strong>
                        </span>
                      </div>

                      <div className="flex justify-between items-center text-[11px] font-mono text-slate-400 pt-1 border-t border-slate-800/60">
                        <span>
                          Source: <strong className="text-slate-300">{card.sourceOfTruth}</strong>
                        </span>
                        {card.classification === 'HYPOTHESIS' ? (
                          <span className="text-amber-400 font-bold">
                            Model Confidence: {confidencePercent}%
                          </span>
                        ) : (
                          <span className="text-emerald-400">Recorded Confidence: 100%</span>
                        )}
                      </div>

                      {card.rawRecordRef && (
                        <div className="text-[10px] font-mono text-slate-400 bg-slate-950 p-2 rounded border border-slate-850 flex justify-between gap-2 flex-wrap">
                          <span>
                            System: <strong>{card.rawRecordRef.system || 'Unknown'}</strong>
                          </span>
                          <span>
                            External Ref: <strong>{card.rawRecordRef.externalId || '—'}</strong>
                          </span>
                          {card.rawRecordRef.verifiedAt && (
                            <span>
                              Verified:{' '}
                              <strong>{new Date(card.rawRecordRef.verifiedAt).toLocaleString()}</strong>
                            </span>
                          )}
                        </div>
                      )}

                      {card.payload && Object.keys(card.payload).length > 0 && (
                        <pre className="text-[10px] font-mono text-slate-300 bg-slate-950 p-2.5 rounded border border-slate-850 overflow-x-auto whitespace-pre-wrap max-h-48">
                          {JSON.stringify(card.payload, null, 2)}
                        </pre>
                      )}
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
