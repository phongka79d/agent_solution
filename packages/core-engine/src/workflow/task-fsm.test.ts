/**
 * @file §4.1 task lifecycle matrix tests: every legal edge, the illegal skips the contract calls
 * out, and the canonical-event derivation the durable engine relies on when its interface only
 * supplies a target state.
 */

import { describe, expect, it } from 'vitest';

import { OrchestratorError, type TaskLifecycleState } from '../contracts/types.js';
import {
  assertTaskTransition,
  TASK_TRANSITIONS,
  taskTransitionEvent,
} from './task-fsm.js';

type Edge = readonly [TaskLifecycleState, string, TaskLifecycleState];

/** Every edge of §4.1 (with the two documented additions of the contract). */
const LEGAL_EDGES: readonly Edge[] = [
  ['queued', 'task.claim', 'running'],
  ['running', 'task.await_event', 'waiting'],
  ['running', 'task.effect_in_flight', 'waiting'],
  ['running', 'task.dispatch_timeout', 'waiting'],
  ['running', 'task.require_auth4', 'awaiting_human'],
  ['running', 'task.success', 'completed'],
  ['running', 'task.retryable_error', 'queued'],
  ['running', 'task.fatal_error', 'failed'],
  ['running', 'task.authority_denied', 'stopped'],
  ['running', 'human.takeover', 'stopped'],
  ['waiting', 'event.received', 'running'],
  ['waiting', 'timer.expired', 'running'],
  ['waiting', 'reconcile.completed', 'running'],
  ['waiting', 'human.takeover', 'stopped'],
  ['awaiting_human', 'human.approval', 'running'],
  ['awaiting_human', 'human.modify', 'running'],
  ['awaiting_human', 'human.pause', 'awaiting_human'],
  ['awaiting_human', 'human.reject', 'stopped'],
  ['awaiting_human', 'human.cancel', 'stopped'],
  ['awaiting_human', 'human.takeover', 'stopped'],
  ['stopped', 'human.resume', 'stopped'],
];

const ILLEGAL_EDGES: readonly Edge[] = [
  // Skipping states.
  ['queued', 'task.success', 'completed'],
  ['awaiting_human', 'task.success', 'completed'],
  ['running', 'task.success', 'stopped'],
  // Resuming terminal states.
  ['stopped', 'event.received', 'running'],
  ['failed', 'event.received', 'running'],
  ['completed', 'reconcile.completed', 'running'],
  // Backward movements that are not the documented approval/handoff routes.
  ['waiting', 'task.claim', 'running'],
  // The event is legal from `from`, but it leads elsewhere.
  ['queued', 'task.claim', 'waiting'],
  ['running', 'task.require_auth4', 'stopped'],
  ['awaiting_human', 'human.approval', 'stopped'],
  // Takeover is not a resume: a stopped task can only release the lock.
  ['stopped', 'human.takeover', 'running'],
];

describe('assertTaskTransition', () => {
  it('accepts every legal edge of the §4.1 matrix', () => {
    for (const [from, event, to] of LEGAL_EDGES) {
      expect(() => assertTaskTransition(from, to, event), `${from} -[${event}]-> ${to}`).not.toThrow();
    }
  });

  it('walks one full lifecycle from queued to completed', () => {
    const path: readonly Edge[] = [
      ['queued', 'task.claim', 'running'],
      ['running', 'task.require_auth4', 'awaiting_human'],
      ['awaiting_human', 'human.approval', 'running'],
      ['running', 'task.success', 'completed'],
    ];
    let current: TaskLifecycleState = 'queued';
    for (const [from, event, to] of path) {
      expect(from).toBe(current);
      assertTaskTransition(from, to, event);
      current = to;
    }
    expect(current).toBe('completed');
  });

  it('refuses every illegal edge with INVALID_TASK_STATE', () => {
    for (const [from, event, to] of ILLEGAL_EDGES) {
      let thrown: unknown;
      try {
        assertTaskTransition(from, to, event);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `${from} -[${event}]-> ${to} must be refused`).toBeInstanceOf(OrchestratorError);
      expect((thrown as OrchestratorError).code).toBe('INVALID_TASK_STATE');
    }
  });

  it('refuses a state outside the canonical vocabulary', () => {
    expect(() => assertTaskTransition('paused' as TaskLifecycleState, 'running', 'event.received')).toThrow(
      OrchestratorError,
    );
  });

  it('never maps one (state, event) pair to two different targets', () => {
    const targets = new Map<string, TaskLifecycleState>();
    for (const transition of TASK_TRANSITIONS) {
      const key = `${transition.from}|${transition.event}`;
      const existing = targets.get(key);
      if (existing !== undefined) {
        expect(existing).toBe(transition.to);
      }
      targets.set(key, transition.to);
    }
    expect(targets.size).toBe(TASK_TRANSITIONS.length);
  });
});

describe('taskTransitionEvent', () => {
  it('derives the canonical event for a target state of the durable engine', () => {
    expect(taskTransitionEvent('queued', 'running')).toBe('task.claim');
    expect(taskTransitionEvent('running', 'waiting')).toBe('task.dispatch_timeout');
    expect(taskTransitionEvent('running', 'awaiting_human')).toBe('task.require_auth4');
    expect(taskTransitionEvent('running', 'completed')).toBe('task.success');
    expect(taskTransitionEvent('running', 'failed')).toBe('task.fatal_error');
    expect(taskTransitionEvent('running', 'queued')).toBe('task.retryable_error');
    expect(taskTransitionEvent('running', 'stopped')).toBe('human.takeover');
    expect(taskTransitionEvent('waiting', 'running')).toBe('event.received');
    expect(taskTransitionEvent('awaiting_human', 'running')).toBe('human.approval');
    expect(taskTransitionEvent('stopped', 'stopped')).toBe('human.resume');
  });

  it('returns null for a target no event can reach', () => {
    expect(taskTransitionEvent('stopped', 'running')).toBeNull();
    expect(taskTransitionEvent('completed', 'waiting')).toBeNull();
    expect(taskTransitionEvent('queued', 'completed')).toBeNull();
  });
});
