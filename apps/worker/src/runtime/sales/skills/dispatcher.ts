/**
 * @file Sales Skill Dispatcher Adapter.
 *
 * Delegates to the shared createSkillAdapterDispatcher so approval_id and
 * approval_payload_digest are forwarded to SkillRuntimeEngine for AUTH-4 actions.
 */

import type { IAdapterDispatcher } from '@agentos/core-engine/contracts';
import {
  createSkillAdapterDispatcher,
  type SkillAdapterDispatcherOptions,
} from '../../shared/skill-dispatcher.js';

export type SalesSkillDispatcherOptions = SkillAdapterDispatcherOptions;

export function createSalesSkillDispatcher(options: SalesSkillDispatcherOptions): IAdapterDispatcher {
  return createSkillAdapterDispatcher(options);
}
