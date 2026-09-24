import type { AssignableAuthority, IAdapterDispatcher } from '@agentos/core-engine/contracts';
import type { SkillRegistry, SkillToolPort } from '@agentos/skills';
import type { ErpReadPort } from '../../connectors.js';

export type { ErpReadPort } from '../../connectors.js';

/** Environment variables consumed by the Care skill services. */
export interface CareSkillEnv {
  readonly CARE_TENANT_IDS?: string;
  readonly CARE_KNOWLEDGE_ROOT?: string;
}

/** Verified customer identity record resolved server-side. */
export interface VerifiedCustomerIdentity {
  readonly id: string;
  readonly customer_id: string;
  readonly verified_at: Date | string | null;
}

/** Dependencies injected into createCareSkillServices. */
export interface CareSkillOptions {
  readonly erp_read: ErpReadPort | null;
  readonly env: CareSkillEnv;
  readonly now?: () => Date;
  readonly resolve_correlation_id: (tenant_id: string, run_id: string) => Promise<string>;
  readonly resolve_grant: (tenant_id: string, agent_id: string) => Promise<AssignableAuthority | null>;
  /** Optional identity resolver override; defaults to findVerifiedIdentityById from @agentos/database. */
  readonly find_verified_identity?: (tenant_id: string, id: string) => Promise<VerifiedCustomerIdentity | null>;
}

/** Assembled Care skill services and registries. */
export interface CareSkillServices {
  readonly registry: SkillRegistry;
  readonly tool_port: SkillToolPort;
  readonly dispatcher: IAdapterDispatcher;
  readonly unbound: readonly string[];
}
