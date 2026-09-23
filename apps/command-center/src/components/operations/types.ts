/**
 * @file apps/command-center/src/components/operations/types.ts
 * Type definitions for SCR-002: Agent Operations Console.
 */

import type {
  AgentRunProjection,
  AgentRunStep,
  AuthorityVerdict,
  StepExecutionStatus,
  TaskLifecycleState,
  SharedUiState,
  GetRunsParams,
  GetRunsResponse,
  RunRetryRequest,
  TaskAcceptedResponse,
} from '../../lib/api-types';

export type {
  AgentRunProjection,
  AgentRunStep,
  AuthorityVerdict,
  StepExecutionStatus,
  TaskLifecycleState,
  SharedUiState,
  GetRunsParams,
  GetRunsResponse,
  RunRetryRequest,
  TaskAcceptedResponse,
};

/** Active filter query state for the runs table */
export interface RunFilters {
  agent_id: string;
  state: string;
  status: string;
  from: string;
  to: string;
  limit: number;
}

/**
 * 13-agent directory item derived purely from returned run data.
 * Never invented or synthesized without upstream records.
 */
export interface AgentDirectoryItem {
  readonly agent_id: string;
  readonly totalRuns: number;
  readonly successCount: number;
  readonly failedCount: number;
  readonly runningCount: number;
  readonly avgLatencyMs: number | null;
  readonly totalCost: number | null;
  readonly lastActiveAt: string | null;
  readonly lastState: TaskLifecycleState | null;
}

/** Error classification for safe side-effect-free retries */
export type RetryableFailureClass =
  | 'SCHEMA_VALIDATION_FAILURE'
  | 'AUTHORITY_DENY'
  | 'FAIL_CLOSED'
  | 'PRE_DISPATCH_PROVIDER_REJECTION';

export interface RetryEligibility {
  readonly retryable: boolean;
  readonly reason:
    | 'RETRYABLE'
    | 'NOT_FAILED'
    | 'UNKNOWN'
    | 'NO_ERROR_CLASS'
    | 'NON_RETRYABLE_ERROR_CLASS';
  readonly explanation: string;
}

export interface RetryModalState {
  readonly isOpen: boolean;
  readonly run: AgentRunProjection | null;
  readonly isSubmitting: boolean;
  readonly error: string | null;
  readonly receipt: TaskAcceptedResponse | null;
}
