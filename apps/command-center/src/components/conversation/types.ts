/**
 * @file apps/command-center/src/components/conversation/types.ts
 * Types and interfaces for SCR-005 Conversation Console.
 * Aligned with implement/06-api-and-connectors-spec.md and implement/07-human-command-center-ui.md.
 */

import type {
  SharedUiState,
  TaskLifecycleState,
} from '../../lib/api-types';

/**
 * Chat message rendered in the conversation message stream.
 */
export interface ChatMessage {
  readonly id: string;
  readonly conversation_id?: string | undefined;
  readonly sender: 'customer' | 'ai' | 'operator';
  readonly content: string;
  readonly timestamp: string;
  readonly module?: ('marketing' | 'sales' | 'support' | 'auto') | undefined;
  readonly status?: ('pending' | 'accepted' | TaskLifecycleState) | undefined;
  readonly task_id?: string | undefined;
  readonly correlation_id?: string | undefined;
  readonly idempotency_key?: string | undefined;
}

/**
 * Detailed lifecycle state of the human operator takeover lease.
 */
export type TakeoverLeaseState =
  | 'idle'       // Autonomous AI controlled (ACTIVE)
  | 'acquiring'  // Transient HANDOVER_REQUESTED phase
  | 'held'       // HUMAN_TAKEOVER mode active, 30s heartbeat running
  | 'releasing'  // Transient RESUME_AUDIT phase
  | 'conflict'   // 409 Conflict: another operator holds the lease
  | 'stale'      // Lease expired or revoked during heartbeat renewal
  | 'error';     // Network or validation error

/**
 * Internal Copilot draft suggestion (AUTH-2).
 * Strictly customer-invisible, requires operator review before sending.
 */
export interface CopilotDraft {
  readonly draft_id?: string | undefined;
  readonly text: string;
  readonly classification: 'AUTH-2';
  readonly generated_at: string;
  readonly suggested_module?: ('marketing' | 'sales' | 'support' | 'auto') | undefined;
}

/**
 * Connection lifecycle of the operator WebSocket stream (/api/v1/ws/stream).
 */
export type WebSocketStreamStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'unavailable'
  | 'error';

/**
 * Dialogue quality evaluation state.
 * Evaluated as dependency_unavailable since no /api/v1 route is contracted.
 */
export interface DialogueEvaluationState {
  readonly rating?: number | undefined;
  readonly flags?: readonly ('ACCURACY' | 'BRAND_VOICE' | 'LATENCY' | 'REASONING_COMPLIANCE')[] | undefined;
  readonly notes?: string | undefined;
  readonly state: Extract<SharedUiState, 'dependency_unavailable'>;
  readonly explanation: string;
}

/**
 * Props for the ConversationConsole component.
 */
export interface ConversationConsoleProps {
  readonly initialConversationId?: string | undefined;
  readonly initialTenantId?: string | undefined;
  readonly initialOperatorId?: string | undefined;
}

/**
 * Props for the ConversationConsole component.
 */
export interface ConversationConsoleProps {
  readonly initialConversationId?: string;
  readonly initialTenantId?: string;
  readonly initialOperatorId?: string;
}
