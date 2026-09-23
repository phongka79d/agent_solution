/**
 * @file apps/command-center/src/components/customer/types.ts
 * Wire contracts and local models for SCR-004: Customer 360 & Timeline Console.
 * References:
 * - implement/06-api-and-connectors-spec.md §8.1.3 (R15)
 * - implement/07-human-command-center-ui.md §5, §9
 * - implement/03-database-and-memory-schema.md §8 (ten-stage projection)
 */

/**
 * Five-tier evidence separation (FR-C360-003):
 * - FACT: verified record from system of record (ERP/POS/WMS/Payment)
 * - SIGNAL: observed behavioural or telemetry measurement, not yet interpreted
 * - HYPOTHESIS: AI model inference; never written back as ground truth
 * - DECISION: recorded human or policy decision (e.g. SCR-003 approval decision)
 * - ACTION: external effect that was actually executed
 */
export type EvidenceClassification = 'FACT' | 'SIGNAL' | 'HYPOTHESIS' | 'DECISION' | 'ACTION';

export type EvidenceSourceOfTruth =
  | 'ERP'
  | 'POS'
  | 'WMS'
  | 'PAYMENT_GATEWAY'
  | 'AI_INFERENCE'
  | 'PLATFORM_ORCHESTRATOR'
  | string;

export interface EvidenceCard {
  readonly evidenceId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly classification: EvidenceClassification;
  readonly sourceOfTruth: EvidenceSourceOfTruth;
  /** 1.0 for recorded tiers (FACT, SIGNAL, DECISION, ACTION); 0.00-0.99 for HYPOTHESIS */
  readonly confidenceScore: number;
  readonly rawRecordRef: {
    readonly system: string;
    readonly externalId: string;
    readonly verifiedAt: string;
  };
  readonly payload: Record<string, unknown>;
}

/** Unified ten-stage timeline stages from 03 §8 */
export type TimelineStage =
  | 'View'
  | 'Search'
  | 'Click'
  | 'Chat'
  | 'Add to cart'
  | 'Purchase'
  | 'Delivery'
  | 'Support'
  | 'Review'
  | 'Repurchase'
  | string;

export interface TimelineEvent {
  readonly eventId: string;
  readonly domain: 'MARKETING' | 'SALES' | 'COMMERCE' | 'SUPPORT' | string;
  readonly stage?: TimelineStage | undefined;
  readonly eventType: string;
  readonly summary: string;
  readonly occurredAt: string;
  readonly sourceRecordId?: string | undefined;
  readonly classification?: EvidenceClassification | undefined;
  readonly evidenceCard?: EvidenceCard | undefined;
  readonly evidenceReference?: string | undefined;
}

export interface TimelineGap {
  readonly gapId: string;
  readonly from: string;
  readonly to: string;
  readonly reason: string;
}

export interface CustomerProfile {
  readonly customerId: string;
  readonly name?: string | undefined;
  readonly tier?: 'GUEST' | 'IDENTIFIED' | 'VERIFIED' | string | undefined;
  readonly ltvTwd?: number | undefined;
  readonly aovTwd?: number | undefined;
  readonly churnRiskScore?: number | undefined;
}

export interface CustomerTimelineResponse {
  readonly customer?: CustomerProfile | undefined;
  readonly events?: readonly TimelineEvent[] | undefined;
  readonly items?: readonly TimelineEvent[] | undefined;
  readonly gaps?: readonly TimelineGap[] | undefined;
  readonly next_cursor?: string | null | undefined;
  readonly has_more?: boolean | undefined;
}
