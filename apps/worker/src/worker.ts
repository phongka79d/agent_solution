import { packageName as adaptersPackageName } from '@agentos/adapters';
import { packageName as coreEnginePackageName } from '@agentos/core-engine';
import { packageName as databasePackageName } from '@agentos/database';
import { packageName as skillsPackageName } from '@agentos/skills';

/**
 * Workspace packages this worker is allowed to depend on (02 §2 dependency DAG).
 * No queue, workflow engine, or provider SDK is bound in P0.
 */
export const DEPENDENCIES: readonly string[] = [
  coreEnginePackageName,
  skillsPackageName,
  adaptersPackageName,
  databasePackageName,
];

export interface WorkerHandle {
  readonly dependencies: readonly string[];
  close(): Promise<void>;
}

/**
 * Starts the durable worker. P0 registers no workflow, activity, or queue, so
 * startup completes immediately and `close()` settles without draining work.
 */
export function startWorker(): WorkerHandle {
  return {
    dependencies: [...DEPENDENCIES],
    async close(): Promise<void> {
      await Promise.resolve();
    },
  };
}
