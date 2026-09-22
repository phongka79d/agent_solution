/**
 * @file `@agentos/skills` — the canonical skill registry and its deterministic execution runtime
 * (implement/05 §1-§3, §6; `implement/02` §2 package boundary).
 *
 * An agent never calls a tool and never calls a skill: it requests execution through the Revenue
 * Orchestrator, which submits a brokered dispatch envelope and receives back a validated result.
 */

export const packageName = '@agentos/skills';

export * from './contracts/index.js';
export * from './platform/index.js';
export * from './registry.js';
export { assertRegistrable } from './registration.js';
export * from './runtime/index.js';
export * from './schema/index.js';
