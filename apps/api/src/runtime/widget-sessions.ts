import { randomBytes } from 'node:crypto';

import type { WidgetCredential } from '../gateway/principal.js';

export const WIDGET_SESSION_TTL_MS = 30 * 60 * 1000;

export interface WidgetSessionIssue {
  readonly access_token: string;
  readonly expires_at: string;
  readonly session_id: string;
}

export interface WidgetSessionInput {
  readonly tenant_id: string;
  readonly customer_id?: string;
  readonly session_id: string;
  readonly origin: string;
}

export interface WidgetSessionRegistryOptions {
  readonly now?: () => number;
  readonly tokenBytes?: number;
  readonly ttlMs?: number;
}

export interface WidgetSessionRegistry {
  issue(input: WidgetSessionInput): WidgetSessionIssue;
  resolve(token: string): WidgetCredential | null;
}

interface StoredWidgetSession extends WidgetCredential {
  readonly expires_at_ms: number;
}

/** Server-held opaque widget credentials with exact tenant/customer/origin bindings and expiry. */
export function createWidgetSessionRegistry(options: WidgetSessionRegistryOptions = {}): WidgetSessionRegistry {
  const now = options.now ?? Date.now;
  const tokenBytes = options.tokenBytes ?? 32;
  const ttlMs = options.ttlMs ?? WIDGET_SESSION_TTL_MS;
  if (!Number.isInteger(tokenBytes) || tokenBytes < 32 || !Number.isFinite(ttlMs) || ttlMs < 1) {
    throw new Error('WIDGET_SESSION_CONFIGURATION_INVALID');
  }

  const sessions = new Map<string, StoredWidgetSession>();
  return {
    issue(input) {
      if (
        input.tenant_id.trim().length === 0 ||
        input.session_id.trim().length === 0 ||
        input.origin.trim().length === 0 ||
        (input.customer_id !== undefined && input.customer_id.trim().length === 0)
      ) {
        throw new Error('WIDGET_SESSION_BINDING_INVALID');
      }
      const issuedAt = now();
      const expires_at_ms = issuedAt + ttlMs;
      if (!Number.isFinite(issuedAt) || !Number.isFinite(expires_at_ms)) {
        throw new Error('WIDGET_SESSION_CLOCK_INVALID');
      }
      const token = randomBytes(tokenBytes).toString('base64url');
      const credential: StoredWidgetSession = {
        token,
        tenant_id: input.tenant_id,
        ...(input.customer_id === undefined ? {} : { customer_id: input.customer_id }),
        session_id: input.session_id,
        origin: input.origin,
        expires_at_ms,
      };
      sessions.set(token, credential);
      return {
        access_token: token,
        expires_at: new Date(expires_at_ms).toISOString(),
        session_id: input.session_id,
      };
    },
    resolve(token) {
      const session = sessions.get(token);
      if (session === undefined) return null;
      if (now() >= session.expires_at_ms) {
        sessions.delete(token);
        return null;
      }
      return session;
    },
  };
}
