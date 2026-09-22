/**
 * @file The only cross-agent handoff (implement/04 §1.1, §8).
 *
 * Domain agents do not invoke, message, or depend on each other. A routing decision crosses
 * from one agent to another only when the orchestrator brokers it. This function is that
 * boundary: it returns the decision unchanged and calls no skill, adapter, or peer.
 */

import type { RoutingDecision } from '../contracts/index.js';

/**
 * Admits a routing decision into the orchestrator. The decision is not executed here.
 *
 * @param decision The supervisor routing result.
 * @returns The same decision, for the orchestrator to execute.
 */
export function assertOrchestratorBrokered(decision: RoutingDecision): RoutingDecision {
  return decision;
}
