/**
 * Durable run-stage trace adapter shared by every worker domain.
 *
 * The database repository owns the transaction and tenant RLS context. This adapter intentionally
 * does not cache attempts or stage rows in memory: recovery/replay must observe the committed
 * PostgreSQL ledger through RunStageEventsRepository on every call.
 */

import type { IRunStageRecorder } from '@agentos/core-engine/contracts';
import {
  RunStageEventsRepository,
  type AppendRunStageEventInput,
  type AppendRunStageResultInput,
} from '@agentos/database';

export type RunStageEventsStore = Pick<
  RunStageEventsRepository,
  'nextAttemptOrdinal' | 'appendStageEvent' | 'appendStageResult'
>;

/** Bridges the core stage-recorder port to the tenant-scoped database repository. */
export class RunStageRecorderAdapter implements IRunStageRecorder {
  constructor(private readonly repository: RunStageEventsStore) {}

  nextAttemptOrdinal(tenant_id: string, run_id: string): Promise<number> {
    return this.repository.nextAttemptOrdinal(tenant_id, run_id);
  }

  async append(input: Parameters<IRunStageRecorder['append']>[0]): Promise<void> {
    await this.repository.appendStageEvent(input as AppendRunStageEventInput);
  }

  async complete(input: Parameters<IRunStageRecorder['complete']>[0]): Promise<void> {
    await this.repository.appendStageResult(input as AppendRunStageResultInput);
  }
}

/** Production constructor; callers may inject a recorder at the factory boundary for tests. */
export function createRunStageRecorder(
  repository: RunStageEventsStore = new RunStageEventsRepository(),
): IRunStageRecorder {
  return new RunStageRecorderAdapter(repository);
}

/** Explicit name for composition roots that want to state the durability guarantee. */
export const DurableRunStageRecorder = RunStageRecorderAdapter;
