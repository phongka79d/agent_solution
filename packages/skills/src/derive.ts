import { backoffDelayMs } from './runtime/retry.js';
import { createPlatformSkills } from './platform/index.js';
import type { ExecutionDomain } from '@agentos/core-engine/contracts';
import type { ISkillContract, PolicyRegistrySkillProjection } from './contracts/index.js';

const policyOnlyDependencies = {
  tools: {
    invoke: async (): Promise<never> => {
      throw new Error('SKILL_POLICY_ROWS_CANNOT_EXECUTE');
    },
  },
  clock: () => new Date(0),
};

/** Canonical rows, including disabled skills, for policy projections and contract checks. */
export const PLATFORM_SKILL_ROWS: readonly ISkillContract[] = Object.freeze(
  createPlatformSkills(policyOnlyDependencies, { enabled_skill_ids: [] }),
);

function schemaProperties(row: ISkillContract): Record<string, unknown> {
  const properties = row.input_schema['properties'];
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
    throw new Error(`SKILL_INPUT_SCHEMA_INVALID: ${row.skill_id} has no properties object`);
  }
  return properties as Record<string, unknown>;
}

/** Strict PEP payload allowlist generated directly from a row's declared input schema. */
export function payloadFieldsOf(row: ISkillContract): Readonly<Record<string, true>> {
  const fields: Record<string, true> = Object.fromEntries(
    Object.keys(schemaProperties(row)).map((field) => [field, true]),
  );
  fields['tenant_id'] = true;
  fields['effect_key'] = true;
  return Object.freeze(fields);
}

export interface DerivedEffectPolicy {
  readonly mutating: boolean;
  readonly idempotent: boolean;
  readonly price_bearing: boolean;
}

export interface PlannedSkillMetadata {
  readonly domain: ExecutionDomain;
  readonly completion: ISkillContract['completion'];
  readonly idempotency_input_field?: string;
  readonly dispatch_timeout_ms: number;
}

function executionDomain(row: ISkillContract): ExecutionDomain {
  switch (row.domain) {
    case 'sales': return 'sales';
    case 'care': return 'support';
    case 'marketing': return 'marketing';
    default: throw new Error(`SKILL_DOMAIN_UNSUPPORTED: ${row.domain}`);
  }
}

function maximumDispatchTimeoutMs(row: ISkillContract): number {
  const attemptCount = row.retry_policy.max_retries + 1;
  let maximumBackoffMs = 0;
  for (let attempt = 1; attempt <= row.retry_policy.max_retries; attempt += 1) {
    maximumBackoffMs += backoffDelayMs(row.retry_policy, attempt, () => 1);
  }
  // The outer guard also gets one attempt-sized margin so the inner last-attempt timer wins a
  // same-tick race and can report its bounded refusal instead of being parked as unknown.
  return Math.ceil(row.timeout_ms * (attemptCount + 1) + maximumBackoffMs);
}

const PLANNED_SKILL_METADATA: Readonly<Record<string, PlannedSkillMetadata>> = Object.freeze(
  Object.fromEntries(PLATFORM_SKILL_ROWS.map((row) => {
    const properties = schemaProperties(row);
    const idempotencyInputField = Object.hasOwn(properties, 'idempotency_key')
      ? 'idempotency_key'
      : undefined;
    return [
      row.skill_id,
      {
        domain: executionDomain(row),
        completion: row.completion,
        dispatch_timeout_ms: maximumDispatchTimeoutMs(row),
        ...(idempotencyInputField === undefined ? {} : { idempotency_input_field: idempotencyInputField }),
      },
    ];
  })),
);

/** Returns planner metadata derived from a canonical skill row, or undefined for non-platform rows. */
export function plannedSkillMetadata(skill_id: string): PlannedSkillMetadata | undefined {
  return PLANNED_SKILL_METADATA[skill_id];
}

export function effectPolicyOf(
  row: Pick<ISkillContract, 'effect_class' | 'tool_binding'>,
): DerivedEffectPolicy {
  const mutating = row.effect_class !== 'READ';
  const priceBearing = row.tool_binding.includes('FloorPriceGuard');
  return Object.freeze({ mutating, idempotent: !mutating, price_bearing: priceBearing });
}

function outputClassification(row: ISkillContract): PolicyRegistrySkillProjection['epistemic_class'] {
  const properties = row.output_schema['properties'];
  if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
    const classification = (properties as Record<string, unknown>)['classification'];
    if (classification !== null && typeof classification === 'object' && !Array.isArray(classification)) {
      const value = (classification as Record<string, unknown>)['const'];
      if (value === 'FACT' || value === 'SIGNAL' || value === 'HYPOTHESIS' || value === 'DECISION' || value === 'ACTION') {
        return value;
      }
    }
  }
  return 'FACT';
}

/** Projects the registry fields required by the PEP from one canonical skill row. */
export function toPolicyRegistrySkill(row: ISkillContract): PolicyRegistrySkillProjection {
  const effect = effectPolicyOf(row);
  return Object.freeze({
    skill_id: row.skill_id,
    allowed_agents: row.allowed_agents,
    required_authority: row.required_authority,
    ...effect,
    epistemic_class: outputClassification(row),
    write_target: effect.mutating ? 'FACT' : 'HYPOTHESIS',
    requires_consent: row.requires_consent,
    requires_verified_identity: row.requires_verified_identity,
    timeout_ms: row.timeout_ms,
  });
}

export function policyRegistryForRows(rows: readonly ISkillContract[]): Readonly<Record<string, PolicyRegistrySkillProjection>> {
  return Object.freeze(Object.fromEntries(rows.map((row) => [row.skill_id, toPolicyRegistrySkill(row)])));
}

export function payloadFieldsForRows(rows: readonly ISkillContract[]): Readonly<Record<string, Readonly<Record<string, true>>>> {
  return Object.freeze(Object.fromEntries(rows.map((row) => [row.skill_id, payloadFieldsOf(row)])));
}
