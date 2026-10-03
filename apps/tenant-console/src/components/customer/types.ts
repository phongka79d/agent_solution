/**
 * UI models for SCR-004: Customer 360 & Timeline Console.
 * Wire DTOs are owned by ../lib/types/tenant-console.ts.
 */

import type { EvidenceClassification } from '@agentos/ui-foundation';

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
  readonly evidenceReference?: string | undefined;
}

export interface TimelineGap {
  readonly gapId: string;
  readonly from: string;
  readonly to: string;
  readonly reason: string;
}
