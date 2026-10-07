/**
 * @file Durable bindings for the gateway and engine ports (implement/04 §3.2.3, `06` §8).
 *
 * The concrete repository bindings live in responsibility-specific siblings under `bindings/`.
 * This module remains the stable composition façade for every binding symbol.
 */

export {
  createEventPort,
  createReceiptPort,
} from './bindings/timeline-event-port.js';

export {
  createDurableRunPort,
  createStartRunPort,
  systemClock,
  systemIdentifiers,
} from './bindings/run-port.js';
export type {
  ProjectionTransactionRunner,
  StartRunPortOptions,
} from './bindings/run-port.js';

export {
  createCareHandoffPort,
  createConversationPort,
  createEffectGuard,
  createTakeoverLeasePort,
} from './bindings/conversation-takeover-port.js';

export {
  createApprovalDecisionPort,
  createApprovalReadPort,
  createIdentityPort,
} from './bindings/approval-identity-port.js';
export type {
  CustomerIdentityLookup,
  CustomerOperatorCustomerLookup,
} from './bindings/approval-identity-port.js';
export { createGovernancePort } from './bindings/governance-port.js';
export { createCompanyCrmPort } from './bindings/company-crm-port.js';
export { createPlatformDirectoryPort } from './bindings/platform-directory.js';
export { createCompanyProjectionPort } from './bindings/company-projection-port.js';
