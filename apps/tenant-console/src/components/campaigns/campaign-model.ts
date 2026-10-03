import { describeApiError } from '@agentos/ui-foundation';
import { t } from '@agentos/ui-foundation/i18n';
import { statusView } from '@agentos/ui-foundation/status';
import type { Tone } from '@agentos/ui-foundation/status';
import type { StageTimelineItem } from '@agentos/ui-foundation/react';

/** Persisted lifecycle codes returned by `GET /api/v1/campaigns`. */
export type CampaignStatus =
  | 'drafting'
  | 'brand_review'
  | 'awaiting_approval'
  | 'approved'
  | 'rejected'
  | 'failed'
  | 'cancelled';

export interface CampaignApprovalRef {
  readonly approval_id?: string;
  readonly decision?: string;
}

export interface CampaignSummary {
  readonly run_id?: string | null;
  readonly campaign_id?: string | null;
  readonly name?: string | null;
  readonly objective?: string | null;
  readonly status?: string;
  readonly audience_count?: number | null;
  readonly channels?: unknown;
  readonly failure_reason_key?: string | null;
  readonly approval?: CampaignApprovalRef;
  readonly dispatch?: { readonly status?: string };
  readonly draft_receipt?: unknown;
  readonly brand_audit?: unknown;
}

export interface CampaignSegment {
  readonly segment_id: string;
  readonly label_key: string;
  readonly kind: 'STORED' | 'INACTIVE_DAYS';
  readonly days?: number;
  readonly audience_count: number;
}

export function isCampaignSegment(value: unknown): value is CampaignSegment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const segment = value as Record<string, unknown>;
  return typeof segment['segment_id'] === 'string'
    && typeof segment['label_key'] === 'string'
    && (segment['kind'] === 'STORED' || segment['kind'] === 'INACTIVE_DAYS')
    && (segment['days'] === undefined || typeof segment['days'] === 'number')
    && typeof segment['audience_count'] === 'number';
}

export function segmentLabel(segment: CampaignSegment): string {
  if (
    segment.kind === 'INACTIVE_DAYS'
    && typeof segment.days === 'number'
    && /^campaigns\.segments\.inactive_(30|60|90|180)d$/.test(segment.label_key)
  ) {
    return `Khách hàng không hoạt động trong ${segment.days} ngày`;
  }
  return segment.kind === 'STORED' ? 'Phân khúc đã lưu' : 'Phân khúc khách hàng';
}

/** Business label for the persisted objective code; raw codes never reach the surface. */
const OBJECTIVE_LABELS: Readonly<Record<string, string>> = {
  winback: 'Khuyến khích khách hàng quay lại',
  reactivation: 'Tái kích hoạt khách hàng',
  retention: 'Giữ chân khách hàng',
  upsell: 'Bán thêm cho khách hàng hiện có',
  promotion: 'Khuyến mãi',
};

export function objectiveLabel(objective: string | null | undefined): string {
  if (!objective) return 'Chưa có mục tiêu';
  return OBJECTIVE_LABELS[objective.toLowerCase()] ?? 'Chiến dịch khách hàng';
}

export const CHANNEL_OPTIONS: readonly { readonly value: string; readonly label: string }[] = [
  { value: 'EMAIL_HTML', label: 'Email' },
  { value: 'SMS_TEXT', label: 'SMS' },
  { value: 'ZALO_ZNS', label: 'Zalo' },
  { value: 'MESSENGER_GENERIC', label: 'Messenger' },
  { value: 'WHATSAPP_TEMPLATE', label: 'WhatsApp' },
];

const CHANNEL_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  CHANNEL_OPTIONS.map((option) => [option.value, option.label]),
);

export function firstChannel(channels: unknown): string | null {
  if (Array.isArray(channels)) {
    const found = channels.find((value): value is string => typeof value === 'string' && value.length > 0);
    return found ?? null;
  }
  return typeof channels === 'string' && channels.length > 0 ? channels : null;
}

export function channelLabel(code: string | null): string {
  if (!code) return 'Chưa chọn kênh';
  return CHANNEL_LABELS[code] ?? 'Kênh khác';
}

export function audienceText(count: number | null | undefined): string {
  if (typeof count !== 'number' || !Number.isFinite(count)) return 'Chưa có dữ liệu khách hàng';
  return `${count.toLocaleString('vi-VN')} khách`;
}

export type CampaignGroupKey = 'drafting' | 'awaiting_approval' | 'approved' | 'failed';

export const CAMPAIGN_GROUPS: readonly { readonly key: CampaignGroupKey; readonly label: string }[] = [
  { key: 'drafting', label: 'Đang soạn' },
  { key: 'awaiting_approval', label: 'Chờ phê duyệt' },
  { key: 'approved', label: 'Đã duyệt' },
  { key: 'failed', label: 'Lỗi' },
];

export function campaignGroup(status: string | undefined): CampaignGroupKey {
  switch (status) {
    case 'awaiting_approval':
      return 'awaiting_approval';
    case 'approved':
      return 'approved';
    case 'rejected':
    case 'failed':
    case 'cancelled':
      return 'failed';
    default:
      return 'drafting';
  }
}

/** Maps lifecycle to the `statusView('campaign', …)` code so labels/tone come from the shared table. */
const LIFECYCLE_STATUS_CODE: Readonly<Record<string, string>> = {
  drafting: 'DRAFT',
  brand_review: 'IN_REVIEW',
  awaiting_approval: 'AWAITING_APPROVAL',
  approved: 'APPROVED',
  rejected: 'REJECTED',
  failed: 'FAILED',
  cancelled: 'CANCELLED',
};

export interface CampaignStatusView {
  readonly label: string;
  readonly tone: Tone;
}

export function campaignStatusView(status: string | undefined): CampaignStatusView {
  const code = status ? LIFECYCLE_STATUS_CODE[status] : undefined;
  if (!code) return { label: 'Chưa phân loại', tone: 'neutral' };
  const view = statusView('campaign', code);
  return { label: t(view.label_key), tone: view.tone };
}

/** Failure reasons in plain words; unknown codes never leak to the surface. */
const FAILURE_REASON_LABELS: Readonly<Record<string, string>> = {
  'run.failure.deterministic': 'Nội dung hoặc cấu hình chưa hợp lệ. Cần xem lại trước khi thử lại.',
  'run.failure.transient': 'Dịch vụ tạm thời không ổn định. Có thể thử lại.',
  'run.failure.outcome_unknown': 'Chưa xác định được kết quả. Cần đối soát trước khi thử lại.',
  'run.failure.unclassified': 'Không hoàn tất được chiến dịch. Vui lòng thử lại.',
};

export function failureReasonText(key: string | null | undefined): string | null {
  if (!key) return null;
  const known = FAILURE_REASON_LABELS[key];
  if (known) return known;
  return describeApiError({ error_code: key }).message;
}

type StageState = 'pending' | 'active' | 'done' | 'failed';

interface StageDefinition {
  readonly key: string;
  readonly label: string;
  readonly patterns: readonly string[];
}

const STAGE_DEFINITIONS: readonly StageDefinition[] = [
  { key: 'content', label: 'Soạn nội dung', patterns: ['generate', 'draft', 'content', 'copy'] },
  { key: 'brand', label: 'Kiểm tra thương hiệu', patterns: ['brand'] },
  { key: 'consent', label: 'Kiểm tra đồng ý', patterns: ['consent', 'compliance', 'permission'] },
  { key: 'approval', label: 'Chờ duyệt', patterns: ['approval', 'authorize', 'human'] },
  { key: 'approved', label: 'Đã duyệt', patterns: ['approve'] },
  { key: 'dispatch', label: 'Gửi đi', patterns: ['dispatch', 'send', 'deliver', 'outbound'] },
];

function baseStates(status: string | undefined): StageState[] {
  switch (status) {
    case 'brand_review':
      return ['done', 'active', 'pending', 'pending', 'pending', 'pending'];
    case 'awaiting_approval':
      return ['done', 'done', 'done', 'active', 'pending', 'pending'];
    case 'approved':
      return ['done', 'done', 'done', 'done', 'done', 'active'];
    case 'rejected':
      return ['done', 'done', 'done', 'failed', 'pending', 'pending'];
    case 'cancelled':
    case 'failed':
      return ['pending', 'pending', 'pending', 'pending', 'pending', 'pending'];
    default:
      return ['active', 'pending', 'pending', 'pending', 'pending', 'pending'];
  }
}

function storyStageState(status: string): StageState {
  switch (status) {
    case 'COMPLETED':
      return 'done';
    case 'FAILED':
    case 'REFUSED':
      return 'failed';
    case 'WAITING_FOR_APPROVAL':
      return 'active';
    default:
      return 'pending';
  }
}

function matchStage(name: string): number {
  const normalized = name.toLowerCase();
  for (let index = 0; index < STAGE_DEFINITIONS.length; index += 1) {
    const definition = STAGE_DEFINITIONS[index]!;
    if (definition.patterns.some((pattern) => normalized.includes(pattern))) return index;
  }
  return -1;
}

export interface RunStoryStep {
  readonly name: string;
  readonly status: string;
  readonly duration_ms: number;
}

/**
 * Merges the persisted lifecycle with the run story so the stepper reflects what actually ran:
 * lifecycle progression is the backbone, story steps override the stage they belong to.
 */
export function buildCampaignStages(
  status: string | undefined,
  steps: readonly RunStoryStep[],
  failureText: string | null,
): readonly StageTimelineItem[] {
  const states = baseStates(status);
  for (const step of steps) {
    const index = matchStage(step.name);
    if (index >= 0) states[index] = storyStageState(step.status);
  }
  if (status === 'failed' && !states.includes('failed')) states[0] = 'failed';

  return STAGE_DEFINITIONS.map((definition, index) => {
    const state = states[index] ?? 'pending';
    const detail = index === 5 && status === 'approved'
      ? 'Chưa tích hợp kênh gửi'
      : state === 'failed' && failureText
        ? failureText
        : undefined;
    return detail === undefined
      ? { key: definition.key, label: definition.label, state }
      : { key: definition.key, label: definition.label, state, detail };
  });
}

const PREVIEW_KEYS = ['body', 'content', 'text', 'message', 'preview', 'html'] as const;

/** Tolerant read of the captured draft payload; returns null when nothing user-facing exists. */
export function contentPreview(receipt: unknown): string | null {
  if (typeof receipt === 'string' && receipt.trim().length > 0) return receipt;
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return null;
  const record = receipt as Record<string, unknown>;
  for (const key of PREVIEW_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return null;
}
