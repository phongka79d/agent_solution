import { describe, expect, it } from 'vitest';

import { OrchestratorError } from '../contracts/index.js';
import { assertValidTransition, LIFECYCLE_STAGES, StageJournal, type LifecycleStage } from './stages.js';

/** Every legal edge of the eleven-stage machine (contract: ports/lifecycle, implement/04 §8.4). */
const LEGAL_EDGES: Array<[LifecycleStage | null, LifecycleStage]> = [
  [null, 'SIGNAL'],
  ['SIGNAL', 'CONTEXT'],
  ['CONTEXT', 'HYPOTHESIS'],
  ['HYPOTHESIS', 'DECISION'],
  ['DECISION', 'PLAN'],
  ['PLAN', 'ACTION'],
  ['ACTION', 'APPROVAL'],
  ['APPROVAL', 'EXECUTION'],
  ['EXECUTION', 'EVIDENCE'],
  ['EVIDENCE', 'ACTION'],
  ['EVIDENCE', 'OUTCOME'],
  ['OUTCOME', 'LEARNING'],
];

/** Unlisted edges: skips, backward jumps outside the `EVIDENCE -> ACTION` cycle, and terminal `LEARNING`. */
const ILLEGAL_EDGES: Array<[LifecycleStage | null, LifecycleStage, string]> = [
  [null, 'CONTEXT', 'a run may only enter at SIGNAL'],
  ['SIGNAL', 'PLAN', 'skip'],
  ['SIGNAL', 'DECISION', 'skip'],
  ['PLAN', 'EXECUTION', 'skip across the ACTION/APPROVAL boundary'],
  ['ACTION', 'PLAN', 'backward'],
  ['CONTEXT', 'SIGNAL', 'backward'],
  ['OUTCOME', 'EVIDENCE', 'backward outside the documented cycle'],
  ['EVIDENCE', 'EXECUTION', 'backward: EXECUTION already ran'],
  ['APPROVAL', 'EVIDENCE', 'skip; a paused/denied approval never records a dispatch'],
  ['EXECUTION', 'ACTION', 'backward outside the documented cycle'],
  ['LEARNING', 'SIGNAL', 'LEARNING is terminal'],
  ['LEARNING', 'LEARNING', 'LEARNING is terminal'],
];

function captureTransitionError(from: LifecycleStage | null, to: LifecycleStage): OrchestratorError {
  try {
    assertValidTransition(from, to);
  } catch (error) {
    if (error instanceof OrchestratorError) {
      return error;
    }
    throw error;
  }
  throw new Error(`expected ${from ?? 'START'} -> ${to} to be rejected`);
}

describe('LIFECYCLE_STAGES', () => {
  it('is the eleven-stage order of one run', () => {
    expect([...LIFECYCLE_STAGES]).toEqual([
      'SIGNAL', 'CONTEXT', 'HYPOTHESIS', 'DECISION', 'PLAN', 'ACTION',
      'APPROVAL', 'EXECUTION', 'EVIDENCE', 'OUTCOME', 'LEARNING',
    ]);
  });
});

describe('assertValidTransition — legal edges', () => {
  for (const [from, to] of LEGAL_EDGES) {
    it(`allows ${from ?? 'START'} -> ${to}`, () => {
      expect(() => assertValidTransition(from, to)).not.toThrow();
    });
  }
});

describe('assertValidTransition — illegal edges', () => {
  for (const [from, to, reason] of ILLEGAL_EDGES) {
    it(`rejects ${from ?? 'START'} -> ${to} (${reason})`, () => {
      const error = captureTransitionError(from, to);
      expect(error.code).toBe('INVALID_STAGE_TRANSITION');
      expect(error.message).toContain(from ?? 'START');
      expect(error.message).toContain(to);
    });
  }

  it('rejects every successor of the terminal LEARNING stage', () => {
    for (const to of LIFECYCLE_STAGES) {
      expect(captureTransitionError('LEARNING', to).code).toBe('INVALID_STAGE_TRANSITION');
    }
  });

  it('accepts exactly the documented edges and nothing else', () => {
    const accepted: Array<[LifecycleStage | null, LifecycleStage]> = [];
    const candidates: Array<LifecycleStage | null> = [null, ...LIFECYCLE_STAGES];
    for (const from of candidates) {
      for (const to of LIFECYCLE_STAGES) {
        try {
          assertValidTransition(from, to);
          accepted.push([from, to]);
        } catch {
          // Unlisted edge: its absence from `accepted` is the assertion.
        }
      }
    }

    expect(accepted).toEqual(LEGAL_EDGES);
  });
});

describe('StageJournal', () => {
  it('starts empty and records a full run in entry order', () => {
    const journal = new StageJournal();
    expect(journal.visited).toEqual([]);

    for (const stage of LIFECYCLE_STAGES) {
      journal.enter(stage);
    }

    expect([...journal.visited]).toEqual([...LIFECYCLE_STAGES]);
  });

  it('walks the plan-step loop: EVIDENCE -> ACTION ... -> EVIDENCE -> OUTCOME -> LEARNING', () => {
    const journal = new StageJournal();
    for (const stage of ['SIGNAL', 'CONTEXT', 'HYPOTHESIS', 'DECISION', 'PLAN', 'ACTION', 'APPROVAL', 'EXECUTION', 'EVIDENCE'] as const) {
      journal.enter(stage);
    }
    for (const stage of ['ACTION', 'APPROVAL', 'EXECUTION', 'EVIDENCE', 'OUTCOME', 'LEARNING'] as const) {
      journal.enter(stage);
    }

    expect([...journal.visited].slice(8)).toEqual([
      'EVIDENCE', 'ACTION', 'APPROVAL', 'EXECUTION', 'EVIDENCE', 'OUTCOME', 'LEARNING',
    ]);
  });

  it('leaves the journal untouched when an edge is rejected', () => {
    const journal = new StageJournal();
    journal.enter('SIGNAL');

    expect(() => journal.enter('PLAN')).toThrow(OrchestratorError);
    expect([...journal.visited]).toEqual(['SIGNAL']);
  });
});
