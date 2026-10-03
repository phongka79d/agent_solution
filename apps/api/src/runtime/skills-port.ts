/**
 * @file Durable bindings for the skill-management ports (T4.4).
 *
 * The company port narrows a skill's contract; it can never widen it. Configuration is validated
 * against the catalog `config_schema` before the write, and the storage triggers repeat the same
 * rule, so a validation gap cannot become a stored widening.
 *
 * Availability uses the shared live gate, including tenant autonomy. Baseline ERP READ skills
 * inherit the company connector when no narrower skill binding was selected, matching the worker.
 *
 * Testing: `READ` dispatches only for `DEMO`/`TEST` tenants and only when a read dispatcher is
 * bound. `EFFECT`, `APPROVAL` and `INTERNAL` are schema dry-runs — they validate the input and
 * never call the dispatcher. Every outcome is stored in `skill_test_results`.
 */

import { isDraftGatedSkill } from '@agentos/core-engine';
import type { ISkillContract } from '@agentos/skills';
import { createSkillAvailability } from '@agentos/skills';

import type { PlatformSkillFleetHealthRepository, SkillCatalogRecord, SkillCatalogRepository, SkillHealthSnapshot, SkillTestResultRecord } from '@agentos/database';
import { AgentActivationRepository, ConnectorBindingRepository, P5AutonomyRepository, SkillCatalogRefusal, isPristineConnectorBinding } from '@agentos/database';

import { fail } from '../gateway/http.js';
import type { CompanySkillView, SkillAvailability, SkillTestResultView, SkillsPort } from '../routes/v1/skills.js';
import type { PlatformSkillsPort } from '../routes/v1/platform-skills.js';

/** Outcome of one real read dispatch, already reduced by the caller's tool port. */
export interface SkillReadDispatchResult {
  readonly outcome: 'PASS' | 'FAIL';
  readonly latency_ms: number;
  readonly detail: Readonly<Record<string, unknown>>;
}

/** The injected seam that actually runs a READ skill. Unbound in this build (orchestrator graph). */
export interface SkillReadDispatcher {
  dispatch(input: {
    readonly tenant_id: string;
    readonly skill_id: string;
    readonly input: Readonly<Record<string, unknown>>;
  }): Promise<SkillReadDispatchResult>;
}

export interface SkillPortOptions {
  readonly skills: SkillCatalogRepository;
  /** Contract lookup for input-schema dry-runs; sourced from the code manifest, never the DB. */
  readonly contractOf: (skill_id: string) => ISkillContract | null;
  readonly readDispatcher?: SkillReadDispatcher;
  readonly autonomy?: Pick<P5AutonomyRepository, 'list' | 'getControls'>;
  readonly connectors?: Pick<ConnectorBindingRepository, 'get'>;
  readonly agents?: Pick<AgentActivationRepository, 'getState'>;
  /** Same DEMO/environment eligibility used by the integrations projection. */
  readonly demoErpEligibleForTenant?: (tenant_id: string) => Promise<boolean>;
}

function codeOf(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return 'UNCLASSIFIED';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'input refused';
}

function failureForRefusal(error: unknown): never {
  if (error instanceof SkillCatalogRefusal) {
    switch (error.code) {
      case 'SKILL_SETTINGS_VERSION_CONFLICT':
        return fail('VERSION_CONFLICT', 'the skill settings were changed by someone else; reload and retry');
      case 'SKILL_SETTINGS_CONTRACT_UNKNOWN':
        return fail('NOT_FOUND', 'the skill is not in the catalog');
      case 'SKILL_ASSIGNMENT_EXCEEDS_CONTRACT':
        return fail('VALIDATION_FAILED', error.message);
      default:
        return fail('INTERNAL_ERROR', 'the skill binding write was refused');
    }
  }
  throw error;
}

/**
 * Validates `config` against the catalog JSON schema, mirroring the storage trigger: unknown keys
 * are refused always, required keys must be present when the skill is enabled, and a value must
 * match the declared type of a property.
 */
function configRefusal(
  config_schema: Readonly<Record<string, unknown>>,
  config: Readonly<Record<string, unknown>>,
  enabled: boolean,
): { readonly code: string; readonly detail: Record<string, unknown> } | null {
  const properties = (config_schema['properties'] ?? {}) as Record<string, unknown>;
  const required = Array.isArray(config_schema['required']) ? (config_schema['required'] as unknown[]) : [];
  for (const key of Object.keys(config)) {
    if (!(key in properties)) {
      return { code: 'CONFIG_KEY_UNDECLARED', detail: { key } };
    }
    const property = properties[key];
    if (typeof property !== 'object' || property === null || Array.isArray(property)) continue;
    const type = 'type' in property ? property.type : undefined;
    const value = config[key];
    const matches = type === 'string'
      ? typeof value === 'string'
      : type === 'number'
        ? typeof value === 'number'
        : type === 'integer'
          ? typeof value === 'number' && Number.isInteger(value)
          : type === 'boolean'
            ? typeof value === 'boolean'
            : true;
    if (!matches) return { code: 'CONFIG_TYPE_INVALID', detail: { key, expected: type } };
  }
  if (enabled) {
    for (const key of required) {
      if (typeof key === 'string' && !(key in config)) {
        return { code: 'CONFIG_REQUIRED_MISSING', detail: { key } };
      }
    }
  }
  return null;
}

async function availabilityOf(
  tenant_id: string,
  catalog: SkillCatalogRecord,
  settings: { readonly enabled: boolean; readonly config: Readonly<Record<string, unknown>>; readonly connector_id: string | null; readonly version: string } | null,
  assigned_agents: readonly string[],
  sources: {
    readonly autonomy: Pick<P5AutonomyRepository, 'list' | 'getControls'>;
    readonly connectors: Pick<ConnectorBindingRepository, 'get'>;
    readonly agents: Pick<AgentActivationRepository, 'getState'>;
    readonly demoErpEligibleForTenant?: (tenant_id: string) => Promise<boolean>;
  },
): Promise<SkillAvailability> {
  if (catalog.retired) return { available: false, status: 'DEPRECATED', reason: 'RETIRED' };
  if (settings === null) return { available: false, status: 'DISABLED', reason: 'NOT_CONFIGURED' };
  if (!settings.enabled) return { available: false, status: 'DISABLED', reason: 'DISABLED_BY_TENANT' };
  if (configRefusal(catalog.config_schema, settings.config, true) !== null) {
    return { available: false, status: 'NOT_READY', reason: 'MISSING_CONFIGURATION' };
  }
  const gate = createSkillAvailability({
    ttlMs: 0,
    settings: () => ({
      ...settings,
      connector_id: settings.connector_id === null && catalog.tool_binding.startsWith('API-001.')
        ? 'API-001'
        : settings.connector_id,
    }),
    catalog: () => ({
      entitled: !catalog.retired,
      retired: catalog.retired,
      connector_kinds: catalog.connector_kinds,
      allowed_agents: catalog.allowed_agents,
      dependency: null,
      contract_version: catalog.contract_version,
    }),
    async connectors(tenant, _skill, connector) {
      const binding = await sources.connectors.get(tenant, connector);
      if (settings.connector_id === null && connector === 'API-001'
        && isPristineConnectorBinding(binding)
        && await sources.demoErpEligibleForTenant?.(tenant) === true) {
        return { status: 'BOUND' };
      }
      return binding;
    },
    async agents(tenant) {
      const domain = catalog.domain;
      if (domain !== 'sales' && domain !== 'care' && domain !== 'marketing') {
        return assigned_agents.map((agent_code) => ({ agent_code, active: false }));
      }
      const snapshot = await sources.agents.getState(tenant, domain);
      return assigned_agents
        .filter((agent_code) => catalog.allowed_agents.includes(agent_code))
        .map((agent_code) => ({
          agent_code,
          active: snapshot?.agents.some((agent) => agent.code === agent_code && agent.is_active) === true,
        }));
    },
    async autonomy(tenant, skill_id) {
      const [policies, controls] = await Promise.all([
        sources.autonomy.list(tenant, skill_id),
        sources.autonomy.getControls(tenant),
      ]);
      let latest: typeof policies[number] | undefined;
      let ambiguous = false;
      for (const policy of policies) {
        const effectiveAt = Date.parse(policy.effective_at);
        if (!Number.isFinite(effectiveAt)) throw new Error('invalid autonomy effective_at');
        const comparison = latest === undefined ? 1 : effectiveAt - Date.parse(latest.effective_at);
        if (comparison > 0) {
          latest = policy;
          ambiguous = false;
        } else if (comparison === 0) {
          ambiguous = true;
        }
      }
      const paused = controls?.paused === true || controls?.kill_switch === true || latest?.state === 'PAUSED';
      return {
        paused,
        parked: !paused && (ambiguous || latest?.state === 'DEMOTED'
          || (isDraftGatedSkill(skill_id) && latest?.state !== 'PROMOTED')),
      };
    },
    // Breakers are worker-local; this projection does not claim to inspect their live state.
    breakers: () => false,
    // No current skill declares an owner-input availability prerequisite.
    ownerInputs: () => 0,
  });
  const verdict = await gate.available(tenant_id, catalog.skill_id);
  return { ...verdict, status: verdict.available ? 'READY' : 'NOT_READY' };
}

function testResultView(record: SkillTestResultRecord): SkillTestResultView {
  return {
    test_id: record.test_id,
    skill_id: record.skill_id,
    mode: record.mode,
    outcome: record.outcome,
    latency_ms: record.latency_ms,
    detail: record.detail,
    tested_by: record.tested_by,
    tested_at: new Date(record.tested_at).toISOString(),
  };
}

function viewOf(
  catalog: SkillCatalogRecord,
  settings: { readonly enabled: boolean; readonly config: Readonly<Record<string, unknown>>; readonly connector_id: string | null; readonly version: string } | null,
  assigned_agents: readonly string[],
  availability: SkillAvailability,
): CompanySkillView {
  const binding = settings;
  return {
    skill_id: catalog.skill_id,
    display_key: catalog.display_key,
    domain: catalog.domain,
    effect_class: catalog.effect_class,
    required_authority: catalog.required_authority,
    autonomy_class: catalog.autonomy_class,
    completion: catalog.completion,
    connector_kinds: catalog.connector_kinds,
    config_schema: catalog.config_schema,
    allowed_agents: catalog.allowed_agents,
    enabled: binding?.enabled ?? false,
    config: binding?.config ?? {},
    connector_id: binding?.connector_id ?? null,
    version: binding?.version ?? null,
    assigned_agents,
    availability,
  };
}

/** Builds the company-scoped skills port over the catalog repository and the code manifest. */
export function createSkillsPort(options: SkillPortOptions): SkillsPort {
  const { skills, contractOf, readDispatcher } = options;
  const sources = {
    autonomy: options.autonomy ?? new P5AutonomyRepository(),
    connectors: options.connectors ?? new ConnectorBindingRepository(),
    agents: options.agents ?? new AgentActivationRepository(),
    ...(options.demoErpEligibleForTenant === undefined ? {} : { demoErpEligibleForTenant: options.demoErpEligibleForTenant }),
  };

  async function getView(tenant_id: string, skill_id: string): Promise<CompanySkillView | null> {
    const catalog = await skills.getCatalogEntry(skill_id);
    if (catalog === null) return null;
    const [settings, assigned] = await Promise.all([
      skills.getSettings(tenant_id, skill_id),
      skills.listAgentAssignments(tenant_id, skill_id),
    ]);
    return viewOf(catalog, settings, assigned, await availabilityOf(tenant_id, catalog, settings, assigned, sources));
  }

  return {
    async list(tenant_id) {
      const catalog = await skills.listCatalog();
      const settings = new Map((await skills.listSettings(tenant_id)).map((row) => [row.skill_id, row] as const));
      const assigned = new Map<string, string[]>();
      for (const row of catalog) {
        assigned.set(row.skill_id, [...(await skills.listAgentAssignments(tenant_id, row.skill_id))]);
      }
      return Promise.all(catalog
        .filter((row) => !row.retired)
        .map(async (row) => {
          const binding = settings.get(row.skill_id) ?? null;
          const assignments = assigned.get(row.skill_id) ?? [];
          return viewOf(row, binding, assignments, await availabilityOf(tenant_id, row, binding, assignments, sources));
        }));
    },

    get: getView,

    async updateSettings(input) {
      const catalog = await skills.getCatalogEntry(input.skill_id);
      if (catalog === null) fail('NOT_FOUND', 'the skill is not in the catalog');
      if (catalog.retired) fail('VALIDATION_FAILED', 'a retired skill cannot be configured');
      const refusal = configRefusal(catalog.config_schema, input.config, input.enabled);
      if (refusal !== null) {
        fail('VALIDATION_FAILED', 'the config does not match the skill config schema', refusal.detail);
      }
      try {
        await skills.upsertSettings({
          tenant_id: input.tenant_id,
          skill_id: input.skill_id,
          enabled: input.enabled,
          config: input.config,
          connector_id: input.connector_id,
          expected_version: input.expected_version,
          actor: input.actor,
        });
      } catch (error) {
        failureForRefusal(error);
      }
      const view = await getView(input.tenant_id, input.skill_id);
      if (view === null) fail('INTERNAL_ERROR', 'the skill disappeared after it was configured');
      return view;
    },

    async replaceAgents(input) {
      try {
        return await skills.replaceAgentAssignments(input.tenant_id, input.skill_id, input.agents, input.actor);
      } catch (error) {
        failureForRefusal(error);
      }
    },

    async test(input): Promise<SkillTestResultView> {
      const catalog = await skills.getCatalogEntry(input.skill_id);
      if (catalog === null) fail('NOT_FOUND', 'the skill is not in the catalog');
      const contract = contractOf(input.skill_id);
      const started = Date.now();
      let mode: 'READ_DISPATCH' | 'CONNECTOR_DRY_RUN';
      let outcome: 'PASS' | 'FAIL' | 'REFUSED';
      let detail: Record<string, unknown>;
      let latency_ms: number | null = null;
      let entity: Record<string, unknown> = {};
      try {
        entity = contract === null ? { ...input.input } : (contract.validateInput({ ...input.input, tenant_id: input.tenant_id }) as Record<string, unknown>);
      } catch (error) {
        return testResultView(await skills.recordTestResult({
          tenant_id: input.tenant_id,
          skill_id: input.skill_id,
          mode: catalog.effect_class === 'READ' ? 'READ_DISPATCH' : 'CONNECTOR_DRY_RUN',
          outcome: 'REFUSED',
          latency_ms: null,
          detail: { reason: 'INPUT_SCHEMA_INVALID', code: codeOf(error), message: messageOf(error) },
          tested_by: input.actor.actor_id,
        }));
      }

      if (catalog.effect_class === 'READ') {
        mode = 'READ_DISPATCH';
        const data_class = await skills.tenantDataClass(input.tenant_id);
        if (data_class !== 'DEMO' && data_class !== 'TEST') {
          outcome = 'REFUSED';
          detail = { reason: 'TEST_REQUIRES_DEMO_OR_TEST_DATA_CLASS', data_class };
        } else if (readDispatcher === undefined) {
          outcome = 'REFUSED';
          detail = { reason: 'READ_DISPATCH_UNBOUND' };
        } else {
          try {
            const result = await readDispatcher.dispatch({
              tenant_id: input.tenant_id,
              skill_id: input.skill_id,
              input: entity,
            });
            outcome = result.outcome;
            latency_ms = result.latency_ms;
            detail = { ...result.detail };
          } catch (error) {
            outcome = 'FAIL';
            latency_ms = Date.now() - started;
            detail = { reason: 'DISPATCH_FAILED', error_class: codeOf(error) };
          }
        }
      } else {
        // EFFECT/APPROVAL/INTERNAL: schema dry-run only. The dispatcher is deliberately not called,
        // so a test can never produce an external effect.
        mode = 'CONNECTOR_DRY_RUN';
        outcome = 'PASS';
        detail = {
          reason: 'SCHEMA_DRY_RUN_ONLY',
          effect_class: catalog.effect_class,
          connector_binding_required: catalog.connector_kinds.length > 0,
        };
      }

      return testResultView(await skills.recordTestResult({
        tenant_id: input.tenant_id,
        skill_id: input.skill_id,
        mode,
        outcome,
        latency_ms,
        detail,
        tested_by: input.actor.actor_id,
      }));
    },

    health(tenant_id, skill_id, window_start): Promise<SkillHealthSnapshot> {
      return skills.skillHealth(tenant_id, skill_id, window_start);
    },

    async testHistory(tenant_id, skill_id, limit) {
      return (await skills.listTestResults(tenant_id, skill_id, limit)).map(testResultView);
    },

    dataClass(tenant_id) {
      return skills.tenantDataClass(tenant_id);
    },
  };
}

/** Builds the platform catalog port and its separately-scoped fleet aggregate. */
export function createPlatformSkillsPort(
  skills: SkillCatalogRepository,
  fleetHealthRepository: PlatformSkillFleetHealthRepository,
): PlatformSkillsPort {
  return {
    listCatalog() {
      return skills.listCatalog();
    },
    fleetHealth() {
      return fleetHealthRepository.list();
    },
    async setEntitlement(input) {
      const catalog = await skills.getCatalogEntry(input.skill_id);
      if (catalog === null) fail('NOT_FOUND', 'the skill is not in the catalog');
      const current = await skills.getSettings(input.tenant_id, input.skill_id);
      try {
        const row = await skills.upsertSettings({
          tenant_id: input.tenant_id,
          skill_id: input.skill_id,
          enabled: input.entitled,
          config: current?.config ?? {},
          connector_id: current?.connector_id ?? null,
          expected_version: input.expected_version ?? current?.version ?? null,
          actor: input.actor,
        });
        return { tenant_id: row.tenant_id, skill_id: row.skill_id, enabled: row.enabled, version: row.version };
      } catch (error) {
        failureForRefusal(error);
      }
    },
  };
}
