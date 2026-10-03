import type { CompanyCrmCampaignRow } from '@agentos/database';

export type CampaignLifecycleState =
  | 'drafting'
  | 'brand_review'
  | 'awaiting_approval'
  | 'approved'
  | 'rejected'
  | 'failed'
  | 'cancelled';

export interface CampaignDispatchProjection {
  readonly status: 'NOT_INTEGRATED';
}

export interface CampaignProjection {
  readonly campaign_id: string | null;
  readonly run_id: string | null;
  readonly name: string | null;
  readonly objective: string | null;
  readonly channels: unknown;
  readonly audience_count: number | null;
  readonly status: CampaignLifecycleState;
  readonly failure_reason_key: string | null;
  readonly draft_receipt?: unknown;
  readonly brand_audit?: unknown;
  readonly approval?: {
    readonly approval_id: string;
    readonly decision: string;
    readonly created_at: string | null;
    readonly decided_at: string | null;
  };
  readonly dispatch: CampaignDispatchProjection;
  readonly created_at: string | null;
  readonly updated_at: string | null;
}

function isoOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function objectOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function campaignPayload(value: unknown): Record<string, unknown> | null {
  const outer = objectOf(value);
  const signal = objectOf(outer?.['signal']);
  const nested = objectOf(signal?.['payload']);
  return nested ?? outer;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Derives the displayed campaign lifecycle only from persisted task/campaign/approval state. */
export function deriveCampaignLifecycle(row: CompanyCrmCampaignRow): CampaignLifecycleState {
  const payload = campaignPayload(row.task_payload);
  const stage = stringValue(payload?.['stage'])?.toLowerCase();
  const taskState = row.task_state?.toLowerCase();
  const campaignStatus = row.campaign_status?.toLowerCase();
  if (taskState === 'failed') return 'failed';
  if (taskState === 'stopped' || campaignStatus === 'cancelled') return 'cancelled';
  if (row.approval_decision === 'REJECTED' || campaignStatus === 'rejected') return 'rejected';
  if (row.approval_decision === 'APPROVED' || campaignStatus === 'approved') return 'approved';
  if (
    row.approval_decision === 'PENDING' ||
    taskState === 'awaiting_human' ||
    campaignStatus === 'awaiting_approval'
  ) {
    return 'awaiting_approval';
  }
  if (
    stage === 'brand_audit' ||
    stage === 'brand-audit' ||
    stage === 'brand_review' ||
    campaignStatus === 'brand_review'
  ) {
    return 'brand_review';
  }
  return 'drafting';
}
/** Maps a campaign row and always advertises dispatch as not integrated. */
export function toCampaignProjection(row: CompanyCrmCampaignRow): CampaignProjection {
  const payload = campaignPayload(row.task_payload);
  const input = objectOf(payload?.['input']);
  const receipt = payload?.['draft_receipt'] ?? payload?.['receipt'];
  const brandAudit = payload?.['brand_audit'];
  const taskError = objectOf(row.task_error);
  const failure_reason_key = row.task_state?.toLowerCase() === 'failed'
    ? stringValue(taskError?.['failure_reason_key']) ?? stringValue(taskError?.['code'])
    : null;
  const approval =
    row.approval_id === null || row.approval_decision === null
      ? undefined
      : {
          approval_id: row.approval_id,
          decision: row.approval_decision,
          created_at: isoOrNull(row.approval_created_at),
          decided_at: isoOrNull(row.approval_decided_at),
        };
  return {
    campaign_id: row.campaign_id,
    run_id: row.run_id,
    name: row.name,
    objective: row.objective ?? stringValue(input?.['objective']) ?? stringValue(payload?.['objective']),
    channels: row.channels ?? input?.['channels'] ?? payload?.['channels'] ?? [],
    audience_count: row.audience_count,
    status: deriveCampaignLifecycle(row),
    failure_reason_key,
    ...(receipt === undefined ? {} : { draft_receipt: receipt }),
    ...(brandAudit === undefined ? {} : { brand_audit: brandAudit }),
    ...(approval === undefined ? {} : { approval }),
    dispatch: { status: 'NOT_INTEGRATED' },
    created_at: isoOrNull(row.campaign_created_at ?? row.task_created_at),
    updated_at: isoOrNull(row.campaign_updated_at),
  };
}

export const mapCampaign = toCampaignProjection;
