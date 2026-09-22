/**
 * @file Public surface of the connector and adapter layer (`06` §2–§4).
 *
 * Nothing here reaches a provider directly. A connector declares what it is and what it can read;
 * the host binds a transport, a credential and an HMAC primitive. `ConnectorRegistry` is the single
 * resolution point and it holds no default: an unknown connector id is refused, never substituted
 * (`06` §8.0 — fail closed).
 */

export const packageName = '@agentos/adapters';

export * from './base/port.js';
export * from './base/signature.js';
export * from './base/registry.js';
export * from './base/dispatcher.js';
export * from './erp/api-001-erp.js';
export * from './events/api-002-events.js';
export * from './channels/api-003-channels.js';
