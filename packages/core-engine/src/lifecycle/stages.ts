/**
 * @file The eleven-stage run lifecycle (implement/04 §8, §8.4) as an executable transition guard.
 *
 * The stages are the lifecycle vocabulary of a single orchestrated run — `current_step` is the
 * plan's skill-step cursor, not the ordinal of these stages. The only cycle is the documented
 * plan-step loop: `EVIDENCE` returns to `ACTION` for the next plan step, and `EVIDENCE` advances to
 * `OUTCOME` once the loop is finished (§8.4). Everything else is strictly forward, one stage at a
 * time, which is what stops a run from skipping the pre-side-effect boundary (through `APPROVAL`)
 * or claiming success without an `EVIDENCE` append.
 *
 * Pausing (an AUTH-4 wait, a takeover, an indeterminate effect) is a durable-task state change, not
 * a stage transition: the stage is not advanced, so no edge here models it.
 */

import { OrchestratorError } from '../contracts/index.js';

/** Canonical stage order of one orchestrated run (§8). */
export const LIFECYCLE_STAGES = [
  'SIGNAL', 'CONTEXT', 'HYPOTHESIS', 'DECISION', 'PLAN', 'ACTION',
  'APPROVAL', 'EXECUTION', 'EVIDENCE', 'OUTCOME', 'LEARNING',
] as const;

export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

/**
 * Legal successor set per stage. `LEARNING` is terminal (an empty successor set), so
 * `LEARNING → anything` is rejected exactly like any other unlisted edge.
 */
const LEGAL_TRANSITIONS: Readonly<Record<LifecycleStage, readonly LifecycleStage[]>> = Object.freeze({
  SIGNAL: ['CONTEXT'],
  CONTEXT: ['HYPOTHESIS'],
  HYPOTHESIS: ['DECISION'],
  DECISION: ['PLAN'],
  PLAN: ['ACTION'],
  ACTION: ['APPROVAL'],
  APPROVAL: ['EXECUTION'],
  EXECUTION: ['EVIDENCE'],
  // Next plan step, or the loop is finished and the run advances to OUTCOME.
  EVIDENCE: ['ACTION', 'OUTCOME'],
  OUTCOME: ['LEARNING'],
  LEARNING: [],
});

/** Runtime guard for stage values replayed from durable state, which is not type-checked. */
function isLifecycleStage(value: string): value is LifecycleStage {
  return (LIFECYCLE_STAGES as readonly string[]).includes(value);
}

/**
 * Rejects an illegal lifecycle edge with `OrchestratorError` code `INVALID_STAGE_TRANSITION`.
 * Called before every stage entry, so a rejected edge never mutates a journal or a checkpoint.
 */
export function assertValidTransition(from: LifecycleStage | null, to: LifecycleStage): void {
  if (!isLifecycleStage(to)) {
    throw new OrchestratorError('INVALID_STAGE_TRANSITION', `Unknown lifecycle stage '${String(to)}'`);
  }
  if (from !== null && !isLifecycleStage(from)) {
    throw new OrchestratorError('INVALID_STAGE_TRANSITION', `Unknown lifecycle stage '${String(from)}'`);
  }

  // `from === null` means "no stage entered yet": a run may only start at SIGNAL.
  const successors: readonly LifecycleStage[] = from === null ? ['SIGNAL'] : LEGAL_TRANSITIONS[from];
  if (!successors.includes(to)) {
    const legal = successors.length === 0 ? 'none (LEARNING is terminal)' : successors.join(', ');
    throw new OrchestratorError(
      'INVALID_STAGE_TRANSITION',
      `Illegal lifecycle transition ${from ?? 'START'} -> ${to}; legal successor(s): ${legal}`,
    );
  }
}

/**
 * Append-only record of the stages one run has entered, guarded by `assertValidTransition`.
 *
 * The orchestrator enters a stage only when it actually performs it: a step that pauses at
 * `APPROVAL` (AUTH-4) or parks on an unproven effect never records `EXECUTION`.
 */
export class StageJournal {
  private readonly stages: LifecycleStage[] = [];

  /** Stages entered so far, in entry order; the array is not mutated by callers. */
  get visited(): readonly LifecycleStage[] {
    return this.stages;
  }

  /** Enters `stage`, asserting the legal edge from the last entered stage. */
  enter(stage: LifecycleStage): void {
    assertValidTransition(this.stages.at(-1) ?? null, stage);
    this.stages.push(stage);
  }
}
