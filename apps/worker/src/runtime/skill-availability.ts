/**
 * @file Worker composition of the live skill availability gate (PLAN T4.3).
 *
 * The gate the runtime engine injects is data-backed: tenant settings, catalog membership, connector
 * binding health, agent assignment plus activation, autonomy state and unresolved owner inputs. This
 * module is the single place that turns the worker's repositories into the resolver's ports, and it
 * shares one breaker table with the engine, so the refusal a planner saw and the refusal the engine
 * applies are the same state.
 *
 * Entitlement today is catalog membership: a live `agentos.skill_catalog` row that is not retired is
 * entitled to every company. The per-company entitlement toggle (T4.4) narrows exactly this port.
 */

import type { AutonomyService } from '@agentos/core-engine';
import {
  AgentActivationRepository,
  ConnectorBindingRepository,
  P5ProvisioningRepository,
  SkillCatalogRepository,
} from '@agentos/database';
import {
  createSkillAvailability,
  createSkillBreakerRegistry,
  type SkillBreakerRegistry,
  type SkillGate,
} from '@agentos/skills';

/** The worker's `AgentActivationDomain` vocabulary, mapped from the skill id's domain segment. */
const ACTIVATION_DOMAIN_BY_SKILL_SEGMENT: Readonly<Record<string, 'sales' | 'care' | 'marketing'>> = {
  sales: 'sales',
  care: 'care',
  mkt: 'marketing',
};

/**
 * Skills declare only the owner inputs they actually require. None does today: the onboarding
 * itinerary has no consumer, and ASM-003 is an approval policy enforced at the AUTH-4 approval step,
 * not an availability precondition (gating on it would refuse the draft before it can be approved).
 */
const OWNER_INPUT_DEPENDENCIES_BY_SKILL: Readonly<Record<string, readonly string[]>> = Object.freeze({});

const RUNTIME_API001_CONNECTOR_ID = '__worker_runtime_api001__';

/** Options of {@link createWorkerSkillGate}. */
export interface WorkerSkillGateOptions {
  readonly dependencyFor: (skill_id: string) => string | null;
  /** DEMO-only ERP provider availability from the worker's tenant-scoped connector registry. */
  readonly api001BoundForTenant?: (tenant_id: string) => Promise<boolean>;
  /** Injected clock, shared by the cache window and every breaker; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Cache TTL in milliseconds; defaults to five seconds and is clamped by the resolver. */
  readonly ttlMs?: number;
  /** Overrides for tests; production uses one instance of each repository. */
  readonly repositories?: {
    readonly catalog?: SkillCatalogRepository;
    readonly connectors?: ConnectorBindingRepository;
    readonly agents?: AgentActivationRepository;
    readonly provisioning?: P5ProvisioningRepository;
  };
  /** Autonomy inspection; omitted means "not paused, nothing parked" (the resolver's default is off). */
  readonly autonomy?: Pick<AutonomyService, 'inspect'>;
}
/** The gate and the breaker table the worker hands to its skill runtime engines. */
export interface WorkerSkillGate {
  readonly gate: SkillGate;
  readonly breakers: SkillBreakerRegistry;
}

/**
 * Derives the activation domain of one skill from its canonical id (`skill.<segment>.<name>`).
 *
 * @param skill_id Canonical skill id.
 * @returns The activation domain, or `null` when the segment is not a domain-bearing one.
 */
function activationDomainOf(skill_id: string): 'sales' | 'care' | 'marketing' | null {
  const segment = skill_id.split('.')[1];
  return segment === undefined ? null : (ACTIVATION_DOMAIN_BY_SKILL_SEGMENT[segment] ?? null);
}

/**
 * Builds the worker's live availability gate from the repositories.
 *
 * @param options The dependency resolver, optional autonomy service and test overrides.
 * @returns The gate plus the shared breaker registry the engine must be constructed with.
 */
export function createWorkerSkillGate(options: WorkerSkillGateOptions): WorkerSkillGate {
  const now = options.now ?? Date.now;
  const catalog = options.repositories?.catalog ?? new SkillCatalogRepository();
  const connectors = options.repositories?.connectors ?? new ConnectorBindingRepository();
  const agents = options.repositories?.agents ?? new AgentActivationRepository();
  const provisioning = options.repositories?.provisioning ?? new P5ProvisioningRepository();
  const breakers = createSkillBreakerRegistry({ now });

  const gate = createSkillAvailability({
    now,
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),

    async settings(tenant_id, skill_id) {
      const row = await catalog.getSettings(tenant_id, skill_id);
      if (row === null) return null;
      const api001RuntimeBound =
        row.connector_id === null
        && options.dependencyFor(skill_id)?.startsWith('API-001.') === true
        && await options.api001BoundForTenant?.(tenant_id) === true;
      return {
        enabled: row.enabled,
        connector_id: api001RuntimeBound ? RUNTIME_API001_CONNECTOR_ID : row.connector_id,
        version: row.version,
      };
    },

    async catalog(_tenant_id, skill_id) {
      const entry = await catalog.getCatalogEntry(skill_id);
      if (entry === null) return null;
      return {
        // Catalog membership is the platform entitlement today; T4.4 narrows this to a toggle.
        entitled: !entry.retired,
        retired: entry.retired,
        connector_kinds: entry.connector_kinds,
        allowed_agents: entry.allowed_agents,
        dependency: options.dependencyFor(skill_id),
        contract_version: entry.contract_version,
      };
    },

    async connectors(tenant_id, _skill_id, connector_id) {
      if (connector_id === RUNTIME_API001_CONNECTOR_ID) return { status: 'BOUND' };
      const binding = await connectors.get(tenant_id, connector_id);
      if (binding === null) return null;
      return { status: binding.status };
    },

    async agents(tenant_id, skill_id, allowed_agents) {
      const assigned = await catalog.listAgentAssignments(tenant_id, skill_id);
      const codes = assigned.length > 0
        ? assigned.filter((agent_code) => allowed_agents.includes(agent_code))
        : allowed_agents;
      const domain = activationDomainOf(skill_id);
      if (domain === null) {
        // No activation domain to consult: an assignment whose activation cannot be proven is
        // reported inactive, so the gate fails closed rather than assuming an agent is live.
        return codes.map((agent_code) => ({ agent_code, active: false }));
      }
      const snapshot = await agents.getState(tenant_id, domain);
      const active = new Set((snapshot?.agents ?? []).filter((agent) => agent.is_active).map((agent) => agent.code));
      return codes.map((agent_code) => ({ agent_code, active: active.has(agent_code) }));
    },

    async autonomy(tenant_id, skill_id) {
      if (options.autonomy === undefined) return { paused: false, parked: false };
      const inspection = await options.autonomy.inspect(tenant_id);
      const policy = inspection.current.find((record) => record.skill_id === skill_id);
      return {
        paused: inspection.paused,
        // MINIMUM reads execute at baseline authority (T4.5): only a DEMOTED/PAUSED policy parks.
        parked: policy !== undefined && policy.state === 'DEMOTED' ? true : false,
      };
    },

    breakers: (tenant_id, dependency) => breakers.isOpen(tenant_id, dependency),

    async ownerInputs(tenant_id, skill_id) {
      const dependencies = OWNER_INPUT_DEPENDENCIES_BY_SKILL[skill_id] ?? [];
      if (dependencies.length === 0) return 0;
      const required = new Set(dependencies);
      const inputs = await provisioning.listOwnerInputs(tenant_id);
      return inputs.filter((input) => input.status === 'UNRESOLVED' && required.has(input.input_id)).length;
    },
  });

  return { gate, breakers };
}
