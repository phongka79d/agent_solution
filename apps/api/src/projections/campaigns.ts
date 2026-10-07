import type { CompanyCrmCampaignRow } from '@agentos/database';

export type CampaignLifecycleState = 'draft' | 'in_review' | 'brand_audit' | 'awaiting_approval' | 'in_flight' | 'approved';

export interface CampaignDispatchProjection {
  readonly status: 'NOT_INTEGRATED';
}

export interface CampaignProjection {
  readonly campaign_id: string | null;
  readonly run_id: string | null;
  readonly name: string | null;
  readonly objective: string | null;
  readonly channels: unknown;
  readonly lifecycle_state: CampaignLifecycleState;
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
  if (row.approval_decision === 'APPROVED') return 'approved';
  if (
    row.approval_decision === 'PENDING' ||
    taskState === 'awaiting_human'
  ) {
    return 'awaiting_approval';
  }
  if (taskState === 'in_flight' || campaignStatus === 'in_flight') return 'in_flight';
  if (stage === 'brand_audit' || stage === 'brand-audit' || payload?.['brand_audit'] !== undefined) {
    return 'brand_audit';
  }
  if (
    taskState === 'queued' ||
    taskState === 'running' ||
    taskState === 'waiting' ||
    taskState === 'completed'
  ) {
    return 'in_review';
  }
  return 'draft';
}

/** Maps a campaign row and always advertises dispatch as not integrated. */
export function toCampaignProjection(row: CompanyCrmCampaignRow): CampaignProjection {
  const payload = campaignPayload(row.task_payload);
  const input = objectOf(payload?.['input']);
  const receipt = payload?.['draft_receipt'] ?? payload?.['receipt'];
  const brandAudit = payload?.['brand_audit'];
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
    name: row.name ?? stringValue(payload?.['name']),
    objective: row.objective ?? stringValue(input?.['objective']) ?? stringValue(payload?.['objective']),
    channels: row.channels ?? input?.['channels'] ?? payload?.['channels'] ?? [],
    lifecycle_state: deriveCampaignLifecycle(row),
    ...(receipt === undefined ? {} : { draft_receipt: receipt }),
    ...(brandAudit === undefined ? {} : { brand_audit: brandAudit }),
    ...(approval === undefined ? {} : { approval }),
    dispatch: { status: 'NOT_INTEGRATED' },
    created_at: isoOrNull(row.campaign_created_at ?? row.task_created_at),
    updated_at: isoOrNull(row.campaign_updated_at),
  };
}

export const mapCampaign = toCampaignProjection;
