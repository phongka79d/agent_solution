import type { PlannedStep, PlatformAgentId } from '@agentos/core-engine/contracts';
import { effectPolicyOf, plannedSkillMetadata, type SkillEffectClass } from '@agentos/skills';
import type { SkillRegistryRowMetadata } from './intent-classifier.js';

/**
 * Effect policy derivation matrix transcribed from implement/05 §6.5:
 * Only READ rows are permitted in the Sales foundation runtime.
 */
export interface DerivedEffectPolicy {
  readonly mutating: boolean;
  readonly idempotent: boolean;
  readonly price_bearing: boolean;
}

export function deriveEffectPolicy(effectClass: SkillEffectClass): DerivedEffectPolicy {
  return effectPolicyOf({ effect_class: effectClass, tool_binding: '' });
}

/** Builds one canonical execution-plan step without changing its input fields. */
export function buildPlannedStep(
  stepIndex: number,
  agentId: PlatformAgentId,
  row: SkillRegistryRowMetadata,
  inputParameters: Record<string, unknown>,
  dependsOnSteps: readonly number[],
): PlannedStep {
  const policy = effectPolicyOf({
    effect_class: row.effect_class,
    tool_binding: row.tool_binding ?? '',
  });
  const metadata = plannedSkillMetadata(row.skill_id);
  return {
    step_index: stepIndex,
    agent_id: agentId,
    skill_id: row.skill_id,
    adapter_target: row.guarded_dependency,
    input_parameters: inputParameters,
    required_authority: row.required_authority,
    mutating: row.mutating ?? policy.mutating,
    price_bearing: row.price_bearing ?? policy.price_bearing,
    idempotent: row.idempotent ?? policy.idempotent,
    timeout_ms: row.timeout_ms,
    ...(metadata === undefined ? {} : { dispatch_timeout_ms: metadata.dispatch_timeout_ms }),
    completion: metadata?.completion ?? 'SYNC',
    ...(metadata?.idempotency_input_field === undefined
      ? {}
      : { idempotency_input_field: metadata.idempotency_input_field }),
    ...(row.audit_spec === undefined ? {} : { audit_spec: row.audit_spec }),
    depends_on_steps: [...dependsOnSteps],
  };
}
