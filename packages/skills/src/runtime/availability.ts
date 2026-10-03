/**
 * @file The live skill-availability resolver (implement/05 §6.3; PLAN T4.3, §10.1, §10.2, §10.5).
 *
 * Enablement is data, not process state: a planner asks this resolver whether one `(tenant, skill)`
 * pair may run *now*, and the answer is the AND of every gate — tenant setting, platform
 * entitlement, connector binding health, agent assignment and activation, autonomy state, the
 * dependency breaker and unresolved owner inputs.
 *
 * Two properties are load-bearing:
 *
 *  * **Fail closed.** Every port read is wrapped: a port that throws (database down, RLS refusal,
 *    timeout) denies the gate it feeds with that gate's own refusal reason. An outage never turns
 *    into "available".
 *  * **Bounded staleness.** The resolved answer is cached for at most {@link MAX_TTL_MS}, keyed by
 *    `(tenant, skill)` and fingerprinted by the settings version plus the catalog contract version,
 *    so a configuration change is visible within seconds rather than at restart.
 *
 * The package depends only on `@agentos/core-engine/contracts` (through the skill contracts barrel);
 * the concrete ports are supplied by the composition root, backed by `SkillCatalogRepository`,
 * `ConnectorBindingRepository` and the agent-activation repository.
 */

import { CircuitBreaker, DEFAULT_FAILURE_THRESHOLD, DEFAULT_RESET_TIMEOUT_MS } from './circuit-breaker.js';

/** Every terminal answer of {@link SkillAvailability.available}. */
export type SkillAvailabilityReason =
  /** Every gate admitted the skill. */
  | 'OK'
  /** The tenant's settings row is absent or `enabled = false`. */
  | 'DISABLED_BY_TENANT'
  /** The skill is unknown to the platform catalog, retired, or not entitled for this company. */
  | 'NOT_ENTITLED'
  /** The contract declares connector kinds and the tenant bound no connector. */
  | 'CONNECTOR_UNBOUND'
  /** The bound connector is DEGRADED or DISABLED. */
  | 'CONNECTOR_UNHEALTHY'
  /** Agents are assigned, but none of them is activated for this domain. */
  | 'AGENT_INACTIVE'
  /** No agent is assigned to the skill, so no caller could ever be admitted. */
  | 'NO_ASSIGNED_AGENT'
  /** Autonomy parks this skill as a draft until a human promotes it (PLAN T4.5). */
  | 'PARKED_UNTIL_PROMOTED'
  /** Tenant autonomy is paused or the kill switch is set. */
  | 'AUTONOMY_PAUSED'
  /** The guarded dependency's breaker is OPEN for this tenant. */
  | 'BREAKER_OPEN'
  /** An owner input the skill depends on is still unresolved. */
  | 'OWNER_INPUT_UNRESOLVED';

/** The answer a planner branches on. `reason` is `OK` exactly when `available` is `true`. */
export interface SkillAvailability {
  readonly available: boolean;
  readonly reason: SkillAvailabilityReason;
}

/**
 * The gate consumed by the runtime engine and by planners. It never throws: an unavailable answer
 * carries the reason, and a port outage is reported as the gate's fail-closed refusal.
 */
export interface SkillGate {
  /**
   * Reports whether `skill_id` may run for `tenant_id` right now.
   *
   * @param tenant_id Server-resolved tenant.
   * @param skill_id Canonical skill id.
   * @returns The availability verdict; never a thrown error.
   */
  available(tenant_id: string, skill_id: string): Promise<SkillAvailability>;
}

/** Tenant binding half of the AND: the row the company edited (PLAN §10.1 "Binding"). */
export interface SkillSettingsProjection {
  readonly enabled: boolean;
  readonly connector_id: string | null;
  /** Settings row version; advancing it invalidates a cached verdict. */
  readonly version: string;
}

/** Contract half of the AND: what the code declared, plus the platform's per-company toggle. */
export interface SkillCatalogProjection {
  /** Platform entitlement for this company; `false` refuses even an enabled tenant row. */
  readonly entitled: boolean;
  /** A retired contract is never available, entitlement or not. */
  readonly retired: boolean;
  /** Connector kinds the tool binding needs; empty means no connector requirement. */
  readonly connector_kinds: readonly string[];
  /** Contract assignment ceiling used when the tenant has no explicit assignments. */
  readonly allowed_agents: readonly string[];
  /** Guarded dependency the breaker is keyed by; `null` for an unguarded row. */
  readonly dependency: string | null;
  /** Contract version; advancing it invalidates a cached verdict. */
  readonly contract_version: string;
}

/** Connector binding health for the tenant's bound connector. */
export interface SkillConnectorProjection {
  readonly status: 'UNBOUND' | 'BOUND' | 'DEGRADED' | 'DISABLED';
}

/** One assigned agent and whether it is activated for its domain. */
export interface SkillAgentState {
  readonly agent_code: string;
  readonly active: boolean;
}

/** Autonomy state of one skill (PLAN T4.5). */
export interface SkillAutonomyProjection {
  readonly paused: boolean;
  readonly parked: boolean;
}

/**
 * The ports the composition root backs with repositories. Every port may return a value or a
 * promise, and every one may throw; a throw is contained by this resolver.
 */
export interface SkillAvailabilityPorts {
  /** `SkillCatalogRepository.getSettings`. `null` when the tenant never configured the skill. */
  settings(tenant_id: string, skill_id: string): SkillSettingsProjection | null | Promise<SkillSettingsProjection | null>;
  /** Catalog projection including the platform entitlement; `null` when the platform does not know the skill. */
  catalog(tenant_id: string, skill_id: string): SkillCatalogProjection | null | Promise<SkillCatalogProjection | null>;
  /** `ConnectorBindingRepository.get` for the tenant's bound connector. */
  connectors(
    tenant_id: string,
    skill_id: string,
    connector_id: string,
  ): SkillConnectorProjection | null | Promise<SkillConnectorProjection | null>;
  /** Explicit tenant assignments narrow the contract ceiling; empty assignments use it by default. */
  agents(
    tenant_id: string,
    skill_id: string,
    allowed_agents: readonly string[],
  ): readonly SkillAgentState[] | Promise<readonly SkillAgentState[]>;
  /** Autonomy pause/parked state for this skill (`AutonomyService.inspect` projection). */
  autonomy(tenant_id: string, skill_id: string): SkillAutonomyProjection | Promise<SkillAutonomyProjection>;
  /** Breaker state keyed `tenant + dependency`; `true` means the dependency is OPEN. */
  breakers(tenant_id: string, dependency: string | null): boolean | Promise<boolean>;
  /** Count of unresolved owner inputs this skill depends on (PLAN T2.7). */
  ownerInputs(tenant_id: string, skill_id: string): number | Promise<number>;
}

/** Options of {@link createSkillAvailability}. */
export interface SkillAvailabilityOptions extends SkillAvailabilityPorts {
  /** Injected clock; defaults to `Date.now`. The TTL window is never read from the ambient clock. */
  readonly now?: () => number;
  /** Cache TTL in milliseconds; clamped to `[0, MAX_TTL_MS]`. */
  readonly ttlMs?: number;
}

/** Upper bound of the availability cache TTL, fixed by T4.3: never more than five seconds. */
export const MAX_TTL_MS = 5_000;

/** Default cache TTL; the strictest value the T4.3 contract allows. */
export const DEFAULT_TTL_MS = 5_000;

interface CacheEntry {
  readonly expiresAt: number;
  readonly fingerprint: string;
  readonly result: SkillAvailability;
}

/** A read that either produced a value or failed; `ok: false` is the fail-closed signal. */
type PortRead<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

/** The accepted verdict. */
const AVAILABLE: SkillAvailability = Object.freeze({ available: true, reason: 'OK' as const });

/**
 * Builds the availability resolver.
 *
 * @param options The ports, plus the clock and an optional TTL override.
 * @returns A `SkillGate` whose answers are fail-closed and cached for at most five seconds.
 */
export function createSkillAvailability(
  options: SkillAvailabilityOptions,
): SkillGate & { invalidate(tenant_id?: string, skill_id?: string): void } {
  const now = options.now ?? Date.now;
  const ttlMs = Math.max(0, Math.min(options.ttlMs ?? DEFAULT_TTL_MS, MAX_TTL_MS));
  const cache = new Map<string, CacheEntry>();

  /** Reads one port, turning a throw into `{ ok: false }` so the calling gate fails closed. */
  async function readPort<T>(read: () => T | Promise<T>): Promise<PortRead<T>> {
    try {
      return { ok: true, value: await read() };
    } catch {
      return { ok: false };
    }
  }

  return {
    invalidate(tenant_id?: string, skill_id?: string): void {
      if (tenant_id === undefined) {
        cache.clear();
        return;
      }
      const prefix = `${tenant_id}\u0000`;
      if (skill_id === undefined) {
        for (const key of cache.keys()) {
          if (key.startsWith(prefix)) cache.delete(key);
        }
        return;
      }
      cache.delete(`${prefix}${skill_id}`);
    },

    async available(tenant_id: string, skill_id: string): Promise<SkillAvailability> {
      const key = `${tenant_id}\u0000${skill_id}`;

      // 1. Tenant binding. An absent row, a disabled row and a settings-port outage all refuse the
      //    same way: the tenant's enablement is the first thing that cannot be proven.
      const settingsRead = await readPort(() => options.settings(tenant_id, skill_id));
      if (!settingsRead.ok || settingsRead.value === null || !settingsRead.value.enabled) {
        return { available: false, reason: 'DISABLED_BY_TENANT' };
      }
      const settings = settingsRead.value;

      // 2. Catalog membership and the platform's per-company entitlement. A retired contract or an
      //    unreadable catalog is never entitled.
      const catalogRead = await readPort(() => options.catalog(tenant_id, skill_id));
      if (catalogRead.ok === false) return { available: false, reason: 'NOT_ENTITLED' };
      const catalog = catalogRead.value;
      if (catalog === null || catalog.retired || !catalog.entitled) {
        return { available: false, reason: 'NOT_ENTITLED' };
      }

      const at = now();
      const fingerprint = `${settings.version}\u0000${catalog.contract_version}`;
      const cached = cache.get(key);
      if (cached !== undefined && cached.fingerprint === fingerprint && cached.expiresAt > at) {
        return cached.result;
      }

      /** Records the verdict for the TTL window before returning it. */
      const settle = (result: SkillAvailability): SkillAvailability => {
        if (ttlMs > 0) cache.set(key, { expiresAt: at + ttlMs, fingerprint, result });
        return result;
      };

      // 3. Connector binding: required only when the contract declares connector kinds. Health is
      //    the binding's own status, so a degraded probe refuses before any adapter call.
      if (catalog.connector_kinds.length > 0) {
        if (settings.connector_id === null || settings.connector_id.trim().length === 0) {
          return settle({ available: false, reason: 'CONNECTOR_UNBOUND' });
        }
        const bindingRead = await readPort(() => options.connectors(tenant_id, skill_id, settings.connector_id as string));
        if (bindingRead.ok === false) return settle({ available: false, reason: 'CONNECTOR_UNHEALTHY' });
        const binding = bindingRead.value;
        if (binding === null || binding.status === 'UNBOUND') {
          return settle({ available: false, reason: 'CONNECTOR_UNBOUND' });
        }
        if (binding.status === 'DEGRADED' || binding.status === 'DISABLED') {
          return settle({ available: false, reason: 'CONNECTOR_UNHEALTHY' });
        }
      }

      // 4. Assigned agents: none assigned at all is distinct from "assigned but none activated".
      const agentsRead = await readPort(() =>
        options.agents(tenant_id, skill_id, catalog.allowed_agents));
      if (agentsRead.ok === false) return settle({ available: false, reason: 'AGENT_INACTIVE' });
      const assigned = agentsRead.value;
      if (assigned.length === 0) return settle({ available: false, reason: 'NO_ASSIGNED_AGENT' });
      if (!assigned.some((agent) => agent.active)) {
        return settle({ available: false, reason: 'AGENT_INACTIVE' });
      }

      // 5. Autonomy: a parked draft needs promotion; a paused tenant needs an operator.
      const autonomyRead = await readPort(() => options.autonomy(tenant_id, skill_id));
      if (autonomyRead.ok === false) return settle({ available: false, reason: 'AUTONOMY_PAUSED' });
      if (autonomyRead.value.parked) return settle({ available: false, reason: 'PARKED_UNTIL_PROMOTED' });
      if (autonomyRead.value.paused) return settle({ available: false, reason: 'AUTONOMY_PAUSED' });

      // 6. Breaker, keyed tenant + dependency: one tenant's provider outage never suppresses another.
      const breakerRead = await readPort(() => options.breakers(tenant_id, catalog.dependency));
      if (breakerRead.ok === false || breakerRead.value) {
        return settle({ available: false, reason: 'BREAKER_OPEN' });
      }

      // 7. Owner inputs: an unresolved question the skill depends on blocks a truthful answer.
      const ownerRead = await readPort(() => options.ownerInputs(tenant_id, skill_id));
      if (ownerRead.ok === false || ownerRead.value > 0) {
        return settle({ available: false, reason: 'OWNER_INPUT_UNRESOLVED' });
      }

      return settle(AVAILABLE);
    },
  };
}

/**
 * Breaker table shared by the runtime engine and the availability port, keyed `tenant + dependency`
 * (PLAN T4.3). Handing the same registry to both keeps the refusal the planner saw and the refusal
 * the engine applies in lockstep, and it never creates two breakers for one dependency.
 */
export interface SkillBreakerRegistry {
  /** Returns (creating on first use) the breaker for one tenant/dependency pair. */
  forDependency(tenant_id: string, dependency: string | null): CircuitBreaker;
  /** Reports whether that breaker is refusing admission now, without consuming a probe. */
  isOpen(tenant_id: string, dependency: string | null): boolean;
}

/** Default idle lifetime of CLOSED breaker entries (five minutes). */
const DEFAULT_BREAKER_TTL_MS = 5 * 60_000;
/** Hard maximum number of breaker entries retained per registry. */
const DEFAULT_BREAKER_MAX_ENTRIES = 10_000;

interface BreakerEntry {
  readonly breaker: CircuitBreaker;
  lastAccessedAt: number;
}

/**
 * Creates the shared breaker table.
 *
 * Idle CLOSED breakers expire after `ttlMs`. OPEN and HALF_OPEN breakers are retained: dropping
 * either state could bypass the recovery cooldown or admit a second half-open probe. If every
 * entry is protected or still active when the table reaches `maxEntries`, creation fails closed.
 *
 * @param options Injected clock, idle TTL and hard entry cap.
 * @returns A registry whose `isOpen` is a read-only observation.
 */
export function createSkillBreakerRegistry(
  options: {
    readonly now?: () => number;
    readonly ttlMs?: number;
    readonly maxEntries?: number;
  } = {},
): SkillBreakerRegistry {
  const table = new Map<string, BreakerEntry>();
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_BREAKER_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_BREAKER_MAX_ENTRIES;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
    throw new RangeError('BREAKER_REGISTRY_TTL_INVALID: ttlMs must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError('BREAKER_REGISTRY_CAPACITY_INVALID: maxEntries must be a positive safe integer.');
  }

  const evictIdleClosed = (at: number): void => {
    for (const [key, entry] of table) {
      if (at - entry.lastAccessedAt < ttlMs) break;
      if (entry.breaker.getState() === 'CLOSED') table.delete(key);
    }
  };

  const touch = (key: string, entry: BreakerEntry, at: number): void => {
    entry.lastAccessedAt = at;
    table.delete(key);
    table.set(key, entry);
  };

  const forDependency = (tenant_id: string, dependency: string | null): CircuitBreaker => {
    const at = now();
    evictIdleClosed(at);
    const key = `${tenant_id}\u0000${dependency ?? 'unguarded'}`;
    const existing = table.get(key);
    if (existing !== undefined) {
      touch(key, existing, at);
      return existing.breaker;
    }
    if (table.size >= maxEntries) {
      throw new Error(
        'BREAKER_REGISTRY_FULL: no idle CLOSED breaker can be evicted without losing active recovery state.',
      );
    }
    const breaker = new CircuitBreaker(DEFAULT_FAILURE_THRESHOLD, DEFAULT_RESET_TIMEOUT_MS, now);
    table.set(key, { breaker, lastAccessedAt: at });
    return breaker;
  };

  return {
    forDependency,
    isOpen: (tenant_id: string, dependency: string | null): boolean => {
      const at = now();
      evictIdleClosed(at);
      const key = `${tenant_id}\u0000${dependency ?? 'unguarded'}`;
      const entry = table.get(key);
      if (entry === undefined) return false;
      touch(key, entry, at);
      return !entry.breaker.wouldAdmit();
    },
  };
}

/**
 * A trivially-available gate for a process that has not yet been handed live ports (tests, offline
 * harnesses). Production wiring always supplies the resolver above.
 */
export function createAlwaysAvailableGate(): SkillGate {
  return {
    available: () => Promise.resolve(AVAILABLE),
  };
}
