/**
 * @file One Customer Care conversational-turn admission path shared by R02 and R11.
 *
 * The route owns one `conversation.turn` identity: its deterministic effect key, durable run,
 * message-history append and replay receipt. Keeping this boundary shared prevents the storefront
 * stream from reserving a second key or starting a differently shaped worker signal.
 */

import type {
  GatewayPrincipal,
  TaskAcceptedResponse,
  TaskStoredState,
  TaskWireStatus,
} from '../../gateway/contracts.js';
import { fail } from '../../gateway/http.js';
import type { ConversationRecord, GatewayRuntime, RunAdmission } from '../../gateway/ports.js';

const CONVERSATION_TURN_SKILL = 'conversation.turn';

const RECEIPT_WAIT_ATTEMPTS = 10;
const RECEIPT_WAIT_INTERVAL_MS = 250;


function wireStatusOf(state: TaskStoredState): TaskWireStatus {
  return state === 'queued' ? 'accepted' : state;
}

function acceptedFromReceipt(
  receipt: Record<string, unknown>,
  conversation_id: string,
): TaskAcceptedResponse {
  const task_id = receipt['task_id'];
  const task_version = receipt['task_version'];
  const correlation_id = receipt['correlation_id'];
  if (typeof task_id !== 'string' || typeof task_version !== 'number' || typeof correlation_id !== 'string') {
    fail('INTERNAL_ERROR', 'the receipt stored for this idempotency key is incomplete and cannot be returned');
  }

  const status = receipt['status'];
  return {
    task_id,
    conversation_id,
    status: status === 'accepted' || status === 'running' || status === 'waiting'
      || status === 'awaiting_human' || status === 'completed' || status === 'stopped' || status === 'failed'
      ? status
      : 'accepted',
    task_version,
    correlation_id,
  };
}

export interface CareTurnAdmission {
  readonly accepted: TaskAcceptedResponse;
  /** Complete canonical replay receipt, including `request_fingerprint`. */
  readonly receipt: Record<string, unknown>;
  readonly admission: RunAdmission;
  readonly replayed: boolean;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTurnReceipt(input: {
  readonly runtime: GatewayRuntime;
  readonly tenant_id: string;
  readonly effect_key: string;
  readonly request_fingerprint: string;
}): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < RECEIPT_WAIT_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await delay(RECEIPT_WAIT_INTERVAL_MS);
    const receipt = await input.runtime.receipts.receiptFor(input.tenant_id, input.effect_key);
    if (receipt === null) continue;
    if (receipt['request_fingerprint'] !== input.request_fingerprint) {
      fail('IDEMPOTENCY_CONFLICT', 'this idempotency key was already claimed for a different payload');
    }
    return receipt;
  }
  fail('RUN_LEASE_HELD', 'another delivery still owns this turn; retry after its durable receipt is settled');
}

export async function admitCareTurn(input: {
  readonly runtime: GatewayRuntime;
  readonly principal: GatewayPrincipal;
  readonly conversation: ConversationRecord;
  readonly correlation_id: string;
  readonly request_id: string;
  readonly message: string;
  readonly module: 'support';
  readonly attachments?: readonly string[];
  readonly operation: string;
}): Promise<CareTurnAdmission> {
  const { runtime, principal, conversation } = input;
  const tenant_id = principal.tenant_id;
  const conversation_id = conversation.conversation_id;

  if (conversation.state === 'paused_takeover') {
    const lease = await runtime.takeover.holder(tenant_id, conversation_id);
    if (lease === null || lease.operator_id !== principal.operator_id) {
      fail(
        'CONVERSATION_LOCKED',
        'another operator holds the takeover lease for this conversation, so no new agent turn may start',
      );
    }
  }

  const effect_key = runtime.effects.computeEffectKey({
    tenant_id,
    skill_id: CONVERSATION_TURN_SKILL,
    step_index: 0,
    action_revision: 0,
    request_id: input.request_id,
  });
  const request_fingerprint = runtime.effects.computeRequestFingerprint({
    message: input.message,
    conversation_id,
    module: input.module,
    attachments: input.attachments ?? null,
  });

  const stored = await runtime.receipts.receiptFor(tenant_id, effect_key);
  if (stored !== null) {
    if (stored['request_fingerprint'] !== request_fingerprint) {
      fail(
        'IDEMPOTENCY_CONFLICT',
        'this idempotency key was already claimed for a different payload; the turn is not started again',
      );
    }

    await runtime.audit.record({
      tenant_id,
      correlation_id: input.correlation_id,
      operation: input.operation,
      principal_kind: principal.kind,
      ...(principal.operator_id === undefined ? {} : { operator_id: principal.operator_id }),
      outcome: 'ACCEPTED',
      detail: { replay: true, effect_key, conversation_id },
    });

    return {
      accepted: acceptedFromReceipt(stored, conversation_id),
      receipt: stored,
      admission: 'REPLAY',
      replayed: true,
    };
  }

  const session_id = principal.session_id ?? conversation.external_thread_id;
  const started = await runtime.runs.start({
    tenant_id,
    correlation_id: input.correlation_id,
    request_id: input.request_id,
    source_channel: conversation.channel,
    event_type: 'message.received',
    session_id,
    channel_type: conversation.channel,
    channel_identifier: conversation.external_thread_id,
    ...(conversation.customer_id === null ? {} : { verified_customer_id: conversation.customer_id }),
    payload: {
      message: input.message,
      conversation_id,
      module: input.module,
      ...(input.attachments === undefined ? {} : { attachments: [...input.attachments] }),
    },
  });

  const admission = started.admission ?? 'ADMITTED';

  if (admission === 'REPLAY') {
    if (started.receipt === undefined) {
      fail('INTERNAL_ERROR', 'the durable replay has no stored receipt and cannot be returned');
    }
    return {
      accepted: acceptedFromReceipt(started.receipt, conversation_id),
      receipt: started.receipt,
      admission,
      replayed: true,
    };
  }

  if (admission === 'IN_FLIGHT') {
    const receipt = await waitForTurnReceipt({
      runtime,
      tenant_id,
      effect_key,
      request_fingerprint,
    });
    return {
      accepted: acceptedFromReceipt(receipt, conversation_id),
      receipt,
      admission,
      replayed: true,
    };
  }

  const receipt: Record<string, unknown> = {
    task_id: started.run_id,
    conversation_id,
    status: wireStatusOf(started.lifecycle_state),
    task_version: started.task_version,
    correlation_id: started.correlation_id,
    request_fingerprint,
  };

  await runtime.conversations.appendMessage({
    tenant_id,
    conversation_id,
    sender_type: 'customer',
    sender_id: session_id,
    content: input.message,
  });
  await runtime.receipts.storeReceipt(tenant_id, effect_key, receipt);

  await runtime.audit.record({
    tenant_id,
    correlation_id: input.correlation_id,
    operation: input.operation,
    principal_kind: principal.kind,
    ...(principal.operator_id === undefined ? {} : { operator_id: principal.operator_id }),
    outcome: 'ACCEPTED',
    detail: { run_id: started.run_id, effect_key, conversation_id },
  });

  return {
    accepted: acceptedFromReceipt(receipt, conversation_id),
    receipt,
    admission,
    replayed: false,
  };
}
