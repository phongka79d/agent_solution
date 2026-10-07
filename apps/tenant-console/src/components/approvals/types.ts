/**
 * Wire contracts and local models for SCR-003: Approval Center.
 * References: R14 approval queue, decision, and evidence contracts.
 */
import type {
  ApprovalDecision as ContractApprovalDecision,
  ApprovalDecisionRequest as ContractApprovalDecisionRequest,
  ApprovalDecisionResponse as ContractApprovalDecisionResponse,
  ApprovalDecisionStatus as ContractApprovalDecisionStatus,
} from '../../lib/types/tenant-console';

/** SCR-003 decision enum — the five baseline operator actions sent to POST /api/v1/approvals/{id}/decision */
export type ApprovalDecision = ContractApprovalDecision;

/**
 * Approval status enum.
 * AWAITING_HUMAN and PAUSED describe undecided queue items (PAUSED = stored PENDING + is_paused=TRUE).
 * APPROVED, REJECTED, MODIFIED, CANCELLED describe resolved items.
 */
export type ApprovalStatus =
  | 'AWAITING_HUMAN'
  | 'PAUSED'
  | 'APPROVED'
  | 'REJECTED'
  | 'MODIFIED'
  | 'CANCELLED'
  | 'QUEUED';

/** Standardized rejection reason codes for REJECT action */
export const STANDARD_REJECTION_CODES = [
  'BUDGET_EXCEEDED',
  'BRAND_VIOLATION',
  'UNACCEPTABLE_MARGIN',
  'INAPPROPRIATE_TIMING',
  'FLOOR_PRICE_BREACH',
  'CUSTOM_POLICY_VIOLATION',
] as const;

export type StandardRejectionCode = (typeof STANDARD_REJECTION_CODES)[number] | string;

/** Approval item projection from R14 GET /api/v1/approvals?status=PENDING and supplemental detail */
export interface ApprovalItem {
  readonly id: string;
  readonly runId: string;
  readonly actionId?: string | undefined;
  readonly tenantId?: string | undefined;
  readonly agentId: string;
  readonly requestingAgentName?: string | undefined;
  readonly domain?: string | undefined;
  readonly effectKey?: string | undefined;
  readonly authority?: string | undefined;
  readonly title: string;
  readonly reason: string;
  readonly context?: unknown;
  readonly evidence?: readonly unknown[] | undefined;
  readonly payload: Record<string, unknown>;
  /** RFC 8785 + SHA-256 digest of the canonical reviewed payload; required on every decision submission */
  readonly payloadSha256: string;
  readonly status: ApprovalStatus;
  readonly isPaused: boolean;
  readonly createdAt: string;
  /** Present only when the server instruments an expiry source; absent -> no countdown rendered */
  readonly expiresAt?: string | undefined;
  readonly decidedAt?: string | undefined;
  readonly decidedBy?: string | undefined;
  readonly decisionNotes?: string | undefined;
  /** Optional customer binding in payload for cross-navigation to SCR-004 */
  readonly customerId?: string | undefined;
  readonly queuedAt?: string | undefined;
}

/** Wire request for a decision. Operator identity is bound by the authenticated BFF session. */
export type ApprovalDecisionRequest = ContractApprovalDecisionRequest;
export type ApprovalDecisionStatus = ContractApprovalDecisionStatus;
export type ApprovalDecisionResponse = ContractApprovalDecisionResponse;

/** Standard error response envelope from the API gateway */
export interface ApiErrorResponse {
  readonly error_code?: string | undefined;
  readonly message: string;
  readonly retryable?: boolean | undefined;
  readonly correlation_id?: string | undefined;
  readonly details?: Record<string, unknown> | undefined;
}

/** Descriptive shared UI states */
export type UiState =
  | 'idle'
  | 'loading'
  | 'empty'
  | 'partial'
  | 'stale'
  | 'permission_denied'
  | 'dependency_unavailable'
  | 'version_conflict'
  | 'fail_closed';
