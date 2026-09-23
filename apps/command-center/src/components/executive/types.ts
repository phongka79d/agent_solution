/**
 * @file apps/command-center/src/components/executive/types.ts
 * Wire contracts and prop types for SCR-001: Executive Dashboard.
 * Aligned with gateway contracts (apps/api/src/gateway/contracts.ts R17, R09).
 */

export type SourceStatus =
  | 'LIVE'
  | 'STALE'
  | 'NO_DATA'
  | 'NOT_INSTRUMENTED'
  | 'UNAVAILABLE'
  | 'FAIL_CLOSED';

export interface KpiMetricItem {
  readonly metric: string;
  readonly value: number | string | null | Record<string, unknown>;
  readonly source_status: SourceStatus;
  readonly observed_at: string | null;
  readonly window?: string | undefined;
  readonly timezone?: string | undefined;
  readonly provisional?: boolean | undefined;
  readonly reason?: string | undefined;
}

export interface KpiSnapshotResponse {
  readonly window: string;
  readonly timezone: string;
  readonly observed_at: string;
  readonly metrics: readonly KpiMetricItem[] | Record<string, unknown>;
  readonly cursor?: string | null | undefined;
}

/** The ten canonical baseline indicator keys from INT-SCR-001 and SRS §18 SCR-001. */
export interface BaselineIndicatorDefinition {
  readonly key: string;
  readonly label: string;
  readonly format: 'currency' | 'number' | 'percent' | 'status';
  readonly description: string;
  readonly aliases?: readonly string[] | undefined;
}

export const BASELINE_INDICATOR_DEFINITIONS: readonly BaselineIndicatorDefinition[] = [
  {
    key: 'revenue_twd',
    label: '1. Revenue',
    format: 'currency',
    description: 'Aggregated total revenue',
    aliases: ['revenue', 'totalRevenue', 'total_revenue'],
  },
  {
    key: 'leads',
    label: '2. Leads',
    format: 'number',
    description: 'Total marketing and inbound leads',
    aliases: ['total_leads', 'marketing_leads'],
  },
  {
    key: 'conversion_rate',
    label: '3. Conversion Rate',
    format: 'percent',
    description: 'Overall checkout conversion rate',
    aliases: ['conversion', 'conversionRate', 'overallPercent'],
  },
  {
    key: 'active_campaigns',
    label: '4. Active Campaigns',
    format: 'number',
    description: 'Live running campaigns',
    aliases: ['activeCampaigns', 'live_campaigns'],
  },
  {
    key: 'ai_generated_revenue_twd',
    label: '5. AI Generated Revenue',
    format: 'currency',
    description: 'Revenue directly attributed to AI agent interventions',
    aliases: ['aiGeneratedRevenue', 'ai_generated_revenue', 'ai_attributed_revenue'],
  },
  {
    key: 'cs_status',
    label: '6. CS Status',
    format: 'status',
    description: 'Customer service operational status',
    aliases: ['customerServiceStatus', 'customer_service_status', 'csStatus'],
  },
  {
    key: 'retention',
    label: '7. Retention',
    format: 'percent',
    description: 'Repeat customer retention rate',
    aliases: ['retention_rate', 'repeatCustomerRatePercent'],
  },
  {
    key: 'ai_actions',
    label: '8. AI Actions',
    format: 'number',
    description: 'Total autonomous agent actions executed',
    aliases: ['aiActions', 'executedCount', 'ai_actions_count'],
  },
  {
    key: 'approval_pending',
    label: '9. Approval Pending',
    format: 'number',
    description: 'High-risk tasks awaiting operator sign-off',
    aliases: ['approvalPending', 'awaitingSignOffCount', 'pending_approvals'],
  },
  {
    key: 'abnormal_events',
    label: '10. Abnormal Events',
    format: 'number',
    description: 'Operational anomaly and alert count',
    aliases: ['abnormalEvents', 'anomalies', 'abnormal_event_count'],
  },
] as const;

export interface AttributionPoint {
  readonly time: string;
  readonly baseline: number;
  readonly aiAttributed: number;
  readonly id?: string | undefined;
}

export interface AnomalyAlert {
  readonly id: string;
  readonly severity: 'WARN' | 'CRITICAL' | 'INFO';
  readonly timestamp: string;
  readonly message: string;
  readonly source: string;
  readonly evidence_reference?: string | undefined;
}

export type SseConnectionStatus =
  | 'CONNECTING'
  | 'LIVE'
  | 'RECONNECTING'
  | 'STALE'
  | 'UNAVAILABLE'
  | 'DISCONNECTED';

export interface ApiErrorEnvelope {
  readonly error_code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly correlation_id: string;
  readonly details?: unknown;
}
