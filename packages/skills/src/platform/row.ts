/**
 * @file The single row factory every platform skill is built with (implement/05 §3, §6.1).
 *
 * A row is data: the eleven SRS minima, its effect class and its guarded dependency. The factory
 * supplies the two behaviours that must be identical for all 23 rows — normalizing input through
 * the declared `input_schema`, and dispatching the bound connector through the injected tool port —
 * so no row can quietly validate less, normalize differently, or reach an adapter by another route.
 */

import type { AuthorityLevel } from '@agentos/core-engine/contracts';

import type {
  AuditSpec,
  ExecutionContext,
  PlatformSkillDependencies,
  PlatformSkillRow,
  RetryPolicy,
  SkillEffectClass,
  TestCaseSpec,
} from '../contracts/index.js';
import { normalizeAgainstSchema } from '../schema/index.js';

const PROMOTABLE_SKILL_IDS: Readonly<Record<string, true>> = Object.freeze({
  'skill.sales.check_stock': true,
  'skill.sales.search_product': true,
  'skill.sales.retrieve_customer': true,
  'skill.care.search_faq': true,
  'skill.mkt.segment_audience': true,
  'skill.mkt.generate_content': true,
});

/** The declarative half of a platform row. `enabled` is absent: the gate decides it, not the row. */
export interface PlatformRowSpec {
  readonly skill_id: string;
  readonly purpose: string;
  readonly effect_class: SkillEffectClass;
  readonly guarded_dependency: string;
  readonly input_schema: Record<string, unknown>;
  readonly output_schema: Record<string, unknown>;
  readonly allowed_agents: readonly string[];
  readonly required_authority: AuthorityLevel;
  readonly tool_binding: string;
  readonly validation_rules: readonly string[];
  readonly retry_policy: RetryPolicy;
  readonly timeout_ms: number;
  readonly audit_spec: AuditSpec;
  readonly test_cases: readonly TestCaseSpec[];
  /** Declared identity binding of the row (BR-003, NFR-008); absent means no verified-identity gate. */
  readonly requires_verified_identity?: boolean;
  /** Declared consent gate of the row (BR-004); absent means the row reads no customer consent. */
  readonly requires_consent?: boolean;
}

/** Tool bindings backed by tenant connectors; internal runtime services are not company connectors. */
const TENANT_CONNECTOR_BINDING_PREFIXES = Object.freeze(['API-001.', 'API-003.']);

function connectorKindsFor(tool_binding: string): readonly string[] {
  return TENANT_CONNECTOR_BINDING_PREFIXES.some((prefix) => tool_binding.startsWith(prefix))
    ? Object.freeze([tool_binding])
    : Object.freeze([]);
}

/** Skill-id segment → catalog domain (`agentos.skill_catalog.domain`); ids abbreviate marketing. */
const DOMAIN_BY_SEGMENT: Readonly<Record<string, string>> = Object.freeze({ mkt: 'marketing' });

/**
 * Builds one registry row.
 *
 * @param deps Injected tool seam and clock; the row holds no ambient dependency.
 * @param spec The row's declarative contract, taken from its `implement/05` §4 block.
 * @returns A row whose `validateInput` normalizes through `input_schema` and whose `execute`
 *   dispatches through the tool port bound to `tool_binding`.
 */
export function definePlatformRow<TInput, TOutput>(
  deps: PlatformSkillDependencies,
  spec: PlatformRowSpec,
): PlatformSkillRow<TInput, TOutput> {
  const [, domain, action] = spec.skill_id.split('.');
  return {
    ...spec,
    display_key: `${domain}.${action}`,
    domain: domain === undefined ? '' : DOMAIN_BY_SEGMENT[domain] ?? domain,
    config_schema: Object.freeze({ type: 'object', properties: Object.freeze({}), additionalProperties: false }),
    autonomy_class: Object.hasOwn(PROMOTABLE_SKILL_IDS, spec.skill_id) ? 'PROMOTABLE' : 'NEVER',
    receipt_ref: `${spec.skill_id}.receipt`,
    completion: spec.effect_class === 'APPROVAL' || spec.tool_binding === 'Orchestrator.HandoffBus'
      ? 'AWAITS_HUMAN'
      : 'SYNC',
    connector_kinds: connectorKindsFor(spec.tool_binding),
    requires_verified_identity: spec.requires_verified_identity ?? false,
    requires_consent: spec.requires_consent ?? false,
    validateInput: (input: unknown): TInput =>
      normalizeAgainstSchema<TInput>(spec.skill_id, spec.input_schema, input),
    execute: (input: TInput, context: ExecutionContext): Promise<TOutput> =>
      deps.tools.invoke<TInput, TOutput>({
        skill_id: spec.skill_id,
        tool_binding: spec.tool_binding,
        input,
        context,
      }),
  };
}
