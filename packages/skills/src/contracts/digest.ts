/**
 * @file Contract digest of one skill row (T4.2).
 *
 * The digest pins the immutable half of a skill contract: everything an agent was dispatched
 * against. Enablement (`enabled`) is deliberately excluded — it is per-tenant data, not contract.
 * A digest change is only admissible together with a `contract_version` bump, which is what boot
 * sync enforces (and the `skill_catalog_contract_guard` trigger repeats at the storage layer).
 */

import { createHash } from 'node:crypto';

import type { ISkillContract } from './types.js';

/** Bumped when the digest projection itself changes, so old digests never silently compare equal. */
export const CONTRACT_DIGEST_VERSION = 1;

/** Deterministic JSON: object keys are emitted in sorted order at every depth. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}

/** The immutable contract projection a digest covers. */
export function contractProjectionOf(row: ISkillContract): Record<string, unknown> {
  return {
    version: CONTRACT_DIGEST_VERSION,
    skill_id: row.skill_id,
    display_key: row.display_key,
    domain: row.domain,
    effect_class: row.effect_class,
    required_authority: row.required_authority,
    autonomy_class: row.autonomy_class,
    completion: row.completion,
    receipt_ref: row.receipt_ref,
    tool_binding: row.tool_binding,
    guarded_dependency: row.guarded_dependency,
    allowed_agents: [...row.allowed_agents].sort(),
    connector_kinds: [...row.connector_kinds].sort(),
    requires_consent: row.requires_consent,
    requires_verified_identity: row.requires_verified_identity,
    config_schema: row.config_schema,
    input_schema: row.input_schema,
    output_schema: row.output_schema,
    validation_rules: row.validation_rules,
    retry_policy: row.retry_policy,
    audit_spec: row.audit_spec,
    timeout_ms: row.timeout_ms,
  };
}

/** SHA-256 hex digest of one row's immutable contract projection. */
export function contractDigest(row: ISkillContract): string {
  return createHash('sha256').update(stableStringify(contractProjectionOf(row)), 'utf8').digest('hex');
}

/**
 * The code manifest's contract version.
 *
 * Bump this **together with** the digest-changing edit in the same PR: boot sync refuses a digest
 * that moved while the version stood still (T4.2), because a running agent may still be dispatching
 * against the pinned contract.
 */
export const SKILL_CONTRACT_VERSION = 4;

/** One catalog row as boot sync publishes it. Structurally the database package's manifest row. */
export interface SkillCatalogManifestEntry {
  readonly skill_id: string;
  readonly display_key: string;
  readonly domain: string;
  readonly effect_class: ISkillContract['effect_class'];
  readonly required_authority: string;
  readonly autonomy_class: ISkillContract['autonomy_class'];
  readonly completion: ISkillContract['completion'];
  readonly receipt_ref: string;
  readonly tool_binding: string;
  readonly allowed_agents: readonly string[];
  readonly connector_kinds: readonly string[];
  readonly config_schema: Readonly<Record<string, unknown>>;
  readonly contract_version: number;
  readonly contract_digest: string;
}

/** Projects the code manifest into rows the catalog sync can upsert verbatim. */
export function skillCatalogManifest(
  rows: readonly ISkillContract[] = [],
  contract_version: number = SKILL_CONTRACT_VERSION,
): readonly SkillCatalogManifestEntry[] {
  return rows.map((row) =>
    Object.freeze({
      skill_id: row.skill_id,
      display_key: row.display_key,
      domain: row.domain,
      effect_class: row.effect_class,
      required_authority: row.required_authority,
      autonomy_class: row.autonomy_class,
      completion: row.completion,
      receipt_ref: row.receipt_ref,
      tool_binding: row.tool_binding,
      allowed_agents: [...row.allowed_agents],
      connector_kinds: [...row.connector_kinds],
      config_schema: row.config_schema,
      contract_version,
      contract_digest: contractDigest(row),
    }),
  );
}
