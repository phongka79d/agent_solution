/**
 * Wire contracts and local models for the Vietnamese approval console (`T6.8`, spec §7.7).
 * References: R14 approval queue, §8.2.1 detail read, decision and evidence contracts.
 */

/** The five baseline decisions sent to POST /api/v1/approvals/{id}/decision. */
export type ApprovalDecision = 'APPROVE' | 'REJECT' | 'MODIFY' | 'PAUSE' | 'CANCEL';

/** Reader-facing queue status. `PENDING`/`PAUSED` are undecided; the rest are resolved outcomes. */
export type ApprovalStatus =
  | 'PENDING'
  | 'PAUSED'
  | 'APPROVED'
  | 'MODIFIED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'EXPIRED';

/** The two console tabs: Chờ duyệt and Đã xử lý. */
export type ApprovalTab = 'PENDING' | 'DECIDED';

/** Reviewer-facing sentence, context and evidence (`ApprovalSummary` of the gateway contract). */
export interface ApprovalSummary {
  readonly titleKey: string;
  readonly params: Readonly<Record<string, string | number | boolean>>;
  readonly requestingAgentKey: string;
  readonly domain: 'marketing' | 'sales' | 'care' | 'platform';
  readonly campaignId: string | null;
  readonly customerId: string | null;
  readonly risk: 'low' | 'medium' | 'high';
  readonly evidenceCount: number;
  readonly modification: { readonly before: unknown; readonly after: unknown } | null;
  readonly expiresAt: string | null;
}

/** One queue item, normalized from the R14 list or the detail read. */
export interface ApprovalItem {
  readonly id: string;
  readonly runId: string;
  readonly actionId?: string | undefined;
  readonly tenantId?: string | undefined;
  readonly effectKey?: string | undefined;
  readonly authority?: string | undefined;
  readonly reason: string;
  readonly payload: Record<string, unknown>;
  readonly payloadSha256: string;
  readonly status: ApprovalStatus;
  readonly isPaused: boolean;
  readonly createdAt: string;
  readonly decidedAt?: string | undefined;
  readonly decidedBy?: string | undefined;
  readonly decisionNotes?: string | undefined;
  readonly summary: ApprovalSummary;
}

/** Quick rejection reasons offered beside the free-text field (spec §7.7). */
export const QUICK_REJECTION_REASONS: readonly { readonly code: string; readonly label: string }[] = [
  { code: 'BUDGET_EXCEEDED', label: 'Vượt ngân sách' },
  { code: 'BRAND_VIOLATION', label: 'Sai giọng thương hiệu' },
  { code: 'UNACCEPTABLE_MARGIN', label: 'Biên lợi nhuận không đạt' },
  { code: 'INAPPROPRIATE_TIMING', label: 'Thời điểm chưa phù hợp' },
  { code: 'CUSTOM_POLICY_VIOLATION', label: 'Vi phạm chính sách' },
];

/** Structured edits approved by a MODIFY decision; the edited revision resumes the same run. */
export interface ModifyFields {
  readonly channel: string;
  readonly audienceSize: string;
  readonly message: string;
}

/** Wire response of POST /api/v1/approvals/{id}/decision (durable worker handoff). */
export interface ApprovalDecisionResponse {
  readonly approval_id: string;
  readonly task_id: string;
  readonly status: 'QUEUED';
  readonly queued_at: string;
  readonly correlation_id: string;
}
