import { packageName as adaptersPackageName } from '@agentos/adapters';
import { packageName as coreEnginePackageName } from '@agentos/core-engine';
import { packageName as databasePackageName } from '@agentos/database';
import { packageName as skillsPackageName } from '@agentos/skills';
import type { ActionDraft, ExecutionReceipt } from '@agentos/core-engine/contracts';

import { createWorkerConnectors, type WorkerConnectorEnv, type WorkerConnectorOptions } from './runtime/connectors.js';
import { nodeHmacSha256Hex } from './runtime/hmac.js';

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
  /** Connector ids reachable from this process, and the capabilities it does not bind. */
  readonly connectors: {
    readonly bound: readonly string[];
    readonly unbound: readonly string[];
  };
  /**
   * Sends one already-authorized action draft to its `adapter_target` ({@link DEPENDENCIES}).
   *
   * Effect reservation and settlement stay with the caller (`04` §4.4): this door reports what the
   * provider said and refuses an unregistered target before any socket opens.
   *
   * @param draft Immutable draft produced by the orchestrator's dispatch guard.
   * @returns The provider receipt.
   */
  dispatchAction(draft: ActionDraft): Promise<ExecutionReceipt>;
  close(): Promise<void>;
}

/**
 * Starts the durable worker. P0 registers no workflow, activity, or queue, so startup completes
 * immediately and `close()` settles without draining work — but the connector binding is real: a
 * draft dispatched here reaches the configured system of record.
 *
 * @param env Process environment; only the connector keys are read here.
 * @param options Host HMAC, server-side mutation authority and transport override.
 * @returns A handle naming what it bound and refusing what it did not.
 */
export function startWorker(
  env: WorkerConnectorEnv = process.env,
  options: WorkerConnectorOptions = { hmac: nodeHmacSha256Hex },
): WorkerHandle {
  const connectors = createWorkerConnectors(env, options);

  return {
    dependencies: [...DEPENDENCIES],
    connectors: { bound: connectors.bound, unbound: connectors.unbound },
    dispatchAction: (draft) => connectors.dispatcher.dispatch(draft),
    async close(): Promise<void> {
      await Promise.resolve();
    },
  };
}
