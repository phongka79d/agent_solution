import { randomUUID } from 'node:crypto';

import type { PlatformAgentId } from '../contracts/types.js';
import { MemoryProvisioningStore } from './memory-store.js';
import {
  type CreateShellInput,
  type MutatingDispatchAdmission,
  type MutatingDispatchBlockReason,
  type MutatingDispatchRequest,
  type OwnerInputKey,
  type ProvisioningStore,
  type TenantShell,
} from './types.js';

/** Canonical low-risk shell skills; none is an outbound or mutating skill. */
export const CANONICAL_PROVISIONING_SKILL_IDS = Object.freeze([
  'skill.sales.check_stock',
  'skill.sales.search_product',
  'skill.sales.retrieve_customer',
  'skill.care.search_faq',
  'skill.mkt.segment_audience',
  'skill.mkt.generate_content',
] as const);

/** IDs are sourced from the platform agent contract, not tenant or caller input. */
const CANONICAL_AGENT_IDS: readonly PlatformAgentId[] = Object.freeze([
  'MKT-01',
  'MKT-02',
  'MKT-03',
  'MKT-04',
  'MKT-05',
  'MKT-06',
  'SAL-01',
  'SAL-02',
  'SAL-03',
  'SAL-04',
  'SAL-05',
  'CS-01',
  'CS-02',
]);

export const UNRESOLVED_OWNER_INPUTS: readonly OwnerInputKey[] = Object.freeze([
  'ASM-001',
  'ASM-002',
  'ASM-003',
  'ASM-004',
  'FLOOR_POLICY',
  'REFUND_POLICY',
  'RETENTION_POLICY',
  'KPI_BASELINE',
  'CREDENTIALS',
  'RESIDENCY',
  'PROMOTION_LIMITS',
  'NAMESPACE_IDENTIFIERS',
  'AUDIT_PROVISIONING_EVIDENCE',
  'careOnboardingItinerary',
]);

export interface ProvisioningServiceOptions {
  readonly store?: ProvisioningStore;
  readonly idFactory?: () => string;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stableValue(item));
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (key === 'tenant_id' || key === 'fingerprint' || key === 'idempotency_key' || key === 'idempotencyKey') {
      continue;
    }
    result[key] = stableValue(record[key]);
  }
  return result;
}

function fingerprintOf(input: CreateShellInput): string {
  if (typeof input.fingerprint === 'string' && input.fingerprint.length > 0) return input.fingerprint;
  return JSON.stringify(stableValue(input));
}

/**
 * Creates the tenant shell and owns the fail-closed admission read used before mutating/provider
 * dispatch. Persistence is entirely behind the injected port; the default is only for local use.
 */
export class ProvisioningService {
  private readonly store: ProvisioningStore;
  private readonly idFactory: () => string;

  constructor(options: ProvisioningServiceOptions | ProvisioningStore = {}) {
    if ('transaction' in options) {
      this.store = options;
      this.idFactory = randomUUID;
    } else {
      this.store = options.store ?? new MemoryProvisioningStore();
      this.idFactory = options.idFactory ?? randomUUID;
    }
  }

  async createShell(input: CreateShellInput = {}): Promise<TenantShell> {
    const idempotency_key = typeof input.idempotency_key === 'string'
      ? input.idempotency_key
      : typeof input.idempotencyKey === 'string'
        ? input.idempotencyKey
        : undefined;
    const fingerprint = fingerprintOf(input);
    const result = await this.store.transaction(
      { ...(idempotency_key === undefined ? {} : { idempotency_key }), fingerprint },
      async (transaction) => {
        const tenant_id = this.idFactory();
        const shell = this.newShell(tenant_id);
        await transaction.putTenant(shell);
        await transaction.appendEvidence({
          tenant_id,
          event_type: shell.provisioning_evidence.event_type,
          status: shell.provisioning_evidence.status,
        });
        return shell;
      },
    );
    return result.value;
  }

  async getShell(tenant_id: string): Promise<TenantShell | null> {
    return this.store.getTenant(tenant_id);
  }

  async inspect(tenant_id: string): Promise<TenantShell | null> {
    return this.getShell(tenant_id);
  }

  async assertMutatingDispatchAllowed(
    request: MutatingDispatchRequest | string,
    required_owner_inputs: readonly OwnerInputKey[] = [],
  ): Promise<MutatingDispatchAdmission> {
    const normalized: MutatingDispatchRequest = typeof request === 'string'
      ? { tenant_id: request, required_owner_inputs }
      : request;
    const shell = await this.store.getTenant(normalized.tenant_id);
    if (shell === null) {
      return {
        status: 'BLOCKED',
        allowed: false,
        blocked: true,
        reasons: ['TENANT_NOT_FOUND'],
        unresolved_owner_inputs: [],
      };
    }

    const unresolved = (normalized.required_owner_inputs ?? []).filter((key) =>
      shell.unresolved_owner_inputs.includes(key),
    );
    const reasons: MutatingDispatchBlockReason[] = [];
    if (shell.connectors.status === 'UNBOUND' || shell.connectors.enabled === 'DISABLED') {
      reasons.push('CONNECTORS_UNBOUND');
    }
    if (unresolved.length > 0) reasons.push('OWNER_INPUT_UNRESOLVED');

    return {
      status: reasons.length === 0 ? 'ALLOWED' : 'BLOCKED',
      allowed: reasons.length === 0,
      blocked: reasons.length > 0,
      reasons,
      unresolved_owner_inputs: unresolved,
    };
  }

  private newShell(tenant_id: string): TenantShell {
    const agents = CANONICAL_AGENT_IDS.map((agent_id) => ({ agent_id, status: 'SHELL' as const }));
    const skills = CANONICAL_PROVISIONING_SKILL_IDS.map((skill_id) => ({
      skill_id,
      status: 'SHELL' as const,
      autonomy: 'MINIMUM' as const,
    }));
    const candidate_skills = CANONICAL_PROVISIONING_SKILL_IDS.map((skill_id) => ({
      skill_id,
      workflow: 'MINIMUM' as const,
    }));
    const owner_inputs = UNRESOLVED_OWNER_INPUTS.map((key) => ({ key, status: 'UNRESOLVED' as const }));

    return {
      tenant_id,
      status: 'PROVISIONED',
      workspace: { tenant_id, status: 'BOUND' },
      agents,
      skills,
      capabilities: { status: 'UNCONFIGURED' },
      connectors: { status: 'UNBOUND', enabled: 'DISABLED' },
      autonomy: {
        candidate_skills,
        summary: { status: 'MINIMUM', candidate_count: candidate_skills.length },
      },
      unresolved_owner_inputs: [...UNRESOLVED_OWNER_INPUTS],
      owner_inputs,
      provisioning_evidence: { event_type: 'TENANT_PROVISIONED', status: 'UNRESOLVED' },
    };
  }
}
