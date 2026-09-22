/**
 * @file Task lifecycle finite state machine (implement/04 §4.1).
 *
 * The matrix below is the single authority for which `(state, event)` pair may produce which
 * target state. The durable engine calls `assertTaskTransition()` before every write and refuses
 * any pair that is not in the table with `INVALID_TASK_STATE`: a skipped, backward or
 * terminal-exiting transition is a caller bug, never a state the store may silently absorb.
 *
 * Two rows are deliberate additions to the §4.1 matrix, both keeping a task from being resumed
 * after its execution was denied or the session was taken over by an operator:
 *
 * - `running` + `task.authority_denied` → `stopped` (the orchestrator's DENIED verdict path).
 * - `running` + `human.takeover` → `stopped` (SCR-005 hard kill; §4.1 lists takeover from `*`,
 *   which the engine narrows to the states where bot execution is actually live).
 *
 * `EVIDENCE`-style self-loops (`awaiting_human` + `human.pause`, `stopped` + `human.resume`) are
 * legal because they change durable flags, not the lifecycle state: a pause keeps the task parked
 * for the same PENDING approval, and `human.resume` releases the takeover lock while the stopped
 * task itself stays terminal — the next inbound signal starts a fresh run.
 *
 * Row order encodes preference: `taskTransitionEvent()` returns the first row matching a
 * `(from, to)` pair, which is how the durable engine derives the canonical event when its
 * interface only hands it a target state.
 */

import { OrchestratorError, type TaskLifecycleState } from '../contracts/types.js';

/** One legal edge of the §4.1 matrix: `from` may move to `to` only under `event`. */
export interface TaskTransition {
  readonly from: TaskLifecycleState;
  readonly event: string;
  readonly to: TaskLifecycleState;
}

/**
 * Every legal `(from, event) → to` edge, ordered by canonical-event preference within a pair.
 * Frozen: the matrix is a trust boundary, not configuration.
 */
export const TASK_TRANSITIONS: readonly TaskTransition[] = Object.freeze([
  // queued — the worker claims the task with the optimistic guard of §4.2.
  { from: 'queued', event: 'task.claim', to: 'running' },

  // running — the live state: park, pause for AUTH-4, finish, retry, fail or stop.
  { from: 'running', event: 'task.dispatch_timeout', to: 'waiting' },
  { from: 'running', event: 'task.effect_in_flight', to: 'waiting' },
  { from: 'running', event: 'task.await_event', to: 'waiting' },
  { from: 'running', event: 'task.require_auth4', to: 'awaiting_human' },
  { from: 'running', event: 'task.success', to: 'completed' },
  { from: 'running', event: 'task.retryable_error', to: 'queued' },
  { from: 'running', event: 'task.fatal_error', to: 'failed' },
  { from: 'running', event: 'human.takeover', to: 'stopped' },
  { from: 'running', event: 'task.authority_denied', to: 'stopped' },

  // waiting — parked on an event, a timer or an effect reconciliation; resumable, never terminal.
  { from: 'waiting', event: 'event.received', to: 'running' },
  { from: 'waiting', event: 'timer.expired', to: 'running' },
  { from: 'waiting', event: 'reconcile.completed', to: 'running' },
  { from: 'waiting', event: 'human.takeover', to: 'stopped' },

  // awaiting_human — one PENDING approval is the only resume authority (§4.2).
  { from: 'awaiting_human', event: 'human.approval', to: 'running' },
  { from: 'awaiting_human', event: 'human.modify', to: 'running' },
  { from: 'awaiting_human', event: 'human.pause', to: 'awaiting_human' },
  { from: 'awaiting_human', event: 'human.takeover', to: 'stopped' },
  { from: 'awaiting_human', event: 'human.reject', to: 'stopped' },
  { from: 'awaiting_human', event: 'human.cancel', to: 'stopped' },

  // stopped — terminal for the run; `human.resume` releases the takeover lock only.
  { from: 'stopped', event: 'human.resume', to: 'stopped' },
]);

/**
 * Exhaustive runtime mirror of the `TaskLifecycleState` union: a persisted row carrying a value
 * outside this vocabulary is corrupt state and is refused instead of being treated as terminal.
 * The `Record` type makes the mirror fail to compile when the union gains a member.
 */
const KNOWN_TASK_STATES: Readonly<Record<TaskLifecycleState, true>> = {
  queued: true,
  running: true,
  waiting: true,
  awaiting_human: true,
  completed: true,
  stopped: true,
  failed: true,
};

/**
 * Asserts that one task state change follows the §4.1 matrix.
 *
 * @param from The current durable state.
 * @param to The requested target state.
 * @param event The transition event that is claimed to cause the change.
 * @throws {OrchestratorError} `INVALID_TASK_STATE` when the pair is not a legal edge, when the
 *   event is legal from `from` but leads elsewhere, or when either state is outside the canonical
 *   vocabulary.
 */
export function assertTaskTransition(
  from: TaskLifecycleState,
  to: TaskLifecycleState,
  event: string,
): void {
  if (!isTaskLifecycleState(from) || !isTaskLifecycleState(to)) {
    throw new OrchestratorError(
      'INVALID_TASK_STATE',
      `Task transition '${String(from)}' -[${event}]-> '${String(to)}' references a state outside the canonical vocabulary.`,
    );
  }

  const legal = TASK_TRANSITIONS.some(
    (transition) => transition.from === from && transition.event === event && transition.to === to,
  );
  if (legal) {
    return;
  }

  const eventsFromState = TASK_TRANSITIONS.filter((transition) => transition.from === from)
    .map((transition) => transition.event)
    .join(', ');
  throw new OrchestratorError(
    'INVALID_TASK_STATE',
    `Illegal task transition '${from}' -[${event}]-> '${to}'.` +
      (eventsFromState.length > 0
        ? ` Events accepted from '${from}': ${eventsFromState}.`
        : ` '${from}' is terminal or accepts no event.`),
  );
}

/**
 * Derives the canonical event that moves `from` to `to`.
 *
 * The durable engine's `transitionTask()` receives a target state (the §3.3 interface shape) and
 * uses this to obtain the matching event; the pair is still re-checked by `assertTaskTransition()`
 * so a target with no legal edge is refused rather than guessed at.
 *
 * @returns The first legal event for the pair, or `null` when no edge exists.
 */
export function taskTransitionEvent(
  from: TaskLifecycleState,
  to: TaskLifecycleState,
): string | null {
  const match = TASK_TRANSITIONS.find(
    (transition) => transition.from === from && transition.to === to,
  );
  return match === undefined ? null : match.event;
}

function isTaskLifecycleState(value: unknown): value is TaskLifecycleState {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(KNOWN_TASK_STATES, value);
}
