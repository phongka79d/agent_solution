/**
 * Skill catalog persistence (T4.2).
 *
 * Two halves with different owners:
 *   * `agentos.skill_catalog` — platform-scoped projection of the code manifest, written only by
 *     boot sync. A digest change without a `contract_version` bump is refused, never repinned.
 *   * `agentos.tenant_skill_settings` / `tenant_skill_agents` / `agentos.skill_test_results` —
 *     per-company binding that can only narrow the contract ceiling.
 *
 * The database owns the invariants (triggers + RLS); this module only composes statements and
 * reports a typed refusal when the caller's write would widen a contract.
 */

import type { PoolClient, QueryResultRow } from 'pg';

import { withTenantContext } from '../rls.js';
import { appendConfigAudit } from './platform-audit.js';
import type { ConfigAuditInput } from './platform-audit.js';
import { withPlatformRole } from './platform-directory.js';
import type { PlatformTransactionRunner } from './platform-directory.js';
import type { TenantTransactionRunner } from './effect-reservations.js';

export type SkillEffectClass = 'READ' | 'EFFECT' | 'APPROVAL' | 'INTERNAL';
export type SkillAutonomyClass = 'NEVER' | 'PROMOTABLE';
export type SkillTestMode = 'READ_DISPATCH' | 'CONNECTOR_DRY_RUN';
export type SkillTestOutcome = 'PASS' | 'FAIL' | 'REFUSED';

/** One row of the code manifest, as boot sync publishes it into the catalog. */
export interface SkillCatalogManifestRow {
  readonly skill_id: string;
  readonly display_key: string;
  readonly domain: string;
  readonly effect_class: SkillEffectClass;
  readonly required_authority: string;
  readonly autonomy_class: SkillAutonomyClass;
  readonly completion: 'SYNC' | 'AWAITS_HUMAN';
  readonly receipt_ref: string;
  readonly tool_binding: string;
  readonly allowed_agents: readonly string[];
  readonly connector_kinds: readonly string[];
  readonly config_schema: Readonly<Record<string, unknown>>;
  readonly contract_version: number;
  readonly contract_digest: string;
}

export interface SkillCatalogRecord {
  readonly skill_id: string;
  readonly display_key: string;
  readonly domain: string;
  readonly effect_class: SkillEffectClass;
  readonly required_authority: string;
  readonly autonomy_class: SkillAutonomyClass;
  readonly completion: 'SYNC' | 'AWAITS_HUMAN';
  readonly receipt_ref: string;
  readonly tool_binding: string;
  readonly allowed_agents: readonly string[];
  readonly connector_kinds: readonly string[];
  readonly config_schema: Record<string, unknown>;
  readonly retired: boolean;
  readonly contract_version: string;
  readonly contract_digest: string;
  readonly registered_at: Date | string;
  readonly updated_at: Date | string;
}

export interface SkillCatalogSyncResult {
  readonly inserted: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly retired: readonly string[];
}

export interface TenantSkillSettingsRecord {
  readonly tenant_id: string;
  readonly skill_id: string;
  readonly enabled: boolean;
  readonly config: Record<string, unknown>;
  readonly connector_id: string | null;
  readonly version: string;
  readonly updated_by: string;
  readonly updated_at: Date | string;
}

export interface UpsertSkillSettingsInput {
  readonly tenant_id: string;
  readonly skill_id: string;
  readonly enabled: boolean;
  readonly config: Readonly<Record<string, unknown>>;
  readonly connector_id: string | null;
  /** CAS token; `null` when the caller believes no row exists yet. */
  readonly expected_version: string | null;
  readonly actor: SkillCatalogActor;
}

export interface SkillCatalogActor {
  readonly actor_kind: string;
  readonly actor_id: string;
  readonly correlation_id: string;
  readonly reason?: string | null;
}

export interface RecordSkillTestInput {
  readonly tenant_id: string;
  readonly skill_id: string;
  readonly mode: SkillTestMode;
  readonly outcome: SkillTestOutcome;
  readonly latency_ms: number | null;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly tested_by: string;
}

export interface SkillTestResultRecord {
  readonly test_id: string;
  readonly tenant_id: string;
  readonly skill_id: string;
  readonly mode: SkillTestMode;
  readonly outcome: SkillTestOutcome;
  readonly latency_ms: number | null;
  readonly detail: Record<string, unknown>;
  readonly tested_by: string;
  readonly tested_at: Date | string;
}

export interface SkillStageOutcomeRow extends QueryResultRow {
  status: string;
  duration_ms: number;
  error_class: string | null;
  completed_at: Date | string;
}

/** 24 h health projection of one skill, derived from append-only `run_stage_results` (T5.1). */
export interface SkillHealthSnapshot {
  readonly window_start: string;
  readonly success_count: number;
  readonly failure_count: number;
  readonly refusal_count: number;
  readonly awaiting_human_count: number;
  /** `null` when no stage in the window settled, so the rate is unknown rather than zero. */
  readonly success_rate: number | null;
  readonly avg_latency_ms: number | null;
  readonly p95_latency_ms: number | null;
  readonly last_activity_at: string | null;
  readonly last_error_class: string | null;
}

/**
 * A refused catalogue write. `code` is stable so callers (boot, API) can fail closed on it.
 */
export class SkillCatalogRefusal extends Error {
  readonly code: string;
  readonly skill_id: string;

  constructor(code: string, skill_id: string, message: string) {
    super(message);
    this.name = 'SkillCatalogRefusal';
    this.code = code;
    this.skill_id = skill_id;
  }
}

export interface SkillCatalogRepositoryOptions {
  readonly platformTransaction?: PlatformTransactionRunner;
  readonly tenantTransaction?: TenantTransactionRunner;
}

interface ExistingContractRow extends QueryResultRow {
  skill_id: string;
  contract_version: string | number;
  contract_digest: string;
}

interface TenantSkillSettingsJoinRow extends QueryResultRow, TenantSkillSettingsRecord {
  allowed_agents: string[];
  effect_class: SkillEffectClass;
}

interface SkillCatalogRow extends QueryResultRow, Omit<SkillCatalogRecord, 'registered_at' | 'updated_at'> {
  registered_at: Date | string;
  updated_at: Date | string;
}

function catalogRecord(row: SkillCatalogRow): SkillCatalogRecord {
  return { ...row, allowed_agents: [...row.allowed_agents], connector_kinds: [...row.connector_kinds] };
}

function auditContext(
  actor: SkillCatalogActor,
  scope: 'PLATFORM' | 'COMPANY',
  tenant_id: string | null,
  target: string,
  action: string,
  before: unknown,
  after: unknown,
): ConfigAuditInput {
  return {
    actor_kind: actor.actor_kind,
    actor_id: actor.actor_id,
    scope,
    action,
    target_tenant: tenant_id,
    target,
    outcome: 'ACCEPTED',
    reason: actor.reason ?? null,
    before,
    after,
    correlation_id: actor.correlation_id,
  };
}

/**
 * Creates baseline bindings on the caller's tenant-scoped transaction. Only newly inserted
 * settings receive contract assignments, so a rerun cannot undo an operator's narrowed set.
 * READ skills start enabled; EFFECT, APPROVAL and INTERNAL skills remain disabled.
 */
export async function seedDefaultSkillSettings(
  client: PoolClient,
  tenant_id: string,
  actor: SkillCatalogActor,
): Promise<number> {
  const result = await client.query<{ seeded: number }>(
    `WITH seeded_settings AS (
       INSERT INTO agentos.tenant_skill_settings
         (tenant_id, skill_id, enabled, config, connector_id, version, updated_by)
       SELECT $1, c.skill_id, (c.effect_class = 'READ'), '{}'::jsonb, NULL, 1, $2
         FROM agentos.skill_catalog AS c
        WHERE c.retired = false
       ON CONFLICT (tenant_id, skill_id) DO NOTHING
       RETURNING skill_id
     ), seeded_agents AS (
       INSERT INTO agentos.tenant_skill_agents (tenant_id, skill_id, agent_code, assigned_by)
       SELECT $1, c.skill_id, agent.agent_code, $2
         FROM seeded_settings AS s
         JOIN agentos.skill_catalog AS c ON c.skill_id = s.skill_id
         CROSS JOIN LATERAL unnest(c.allowed_agents) AS agent(agent_code)
        WHERE c.effect_class = 'READ'
       ON CONFLICT (tenant_id, skill_id, agent_code) DO NOTHING
       RETURNING skill_id
     )
     SELECT count(*)::integer AS seeded FROM seeded_settings`,
    [tenant_id, actor.actor_id],
  );
  const seeded = result.rows[0]?.seeded;
  if (seeded === undefined) throw new Error('SKILL_SETTINGS_SEED_EMPTY_RESULT');
  if (seeded > 0) {
    await appendConfigAudit(
      client,
      auditContext(actor, 'COMPANY', tenant_id, '*', 'skill.settings.seed_defaults', null, { seeded }),
    );
  }
  return seeded;
}

export class SkillCatalogRepository {
  private readonly platformTransaction: PlatformTransactionRunner;
  private readonly tenantTransaction: TenantTransactionRunner;

  constructor(options: SkillCatalogRepositoryOptions = {}) {
    this.platformTransaction = options.platformTransaction ?? withPlatformRole;
    this.tenantTransaction = options.tenantTransaction ?? withTenantContext;
  }

  /**
   * Upserts the code manifest into `agentos.skill_catalog` and retires rows no longer published.
   *
   * @throws {SkillCatalogRefusal} `SKILL_CONTRACT_DIGEST_CHANGED_WITHOUT_VERSION_BUMP` when an
   *   existing row's digest differs and the manifest did not advance `contract_version`. Nothing
   *   else from that run is committed: boot must fail closed rather than run mixed contracts.
   */
  async syncCatalog(rows: readonly SkillCatalogManifestRow[]): Promise<SkillCatalogSyncResult> {
    return this.platformTransaction(async (client) => {
      const existing = await client.query<ExistingContractRow>(
        'SELECT skill_id, contract_version, contract_digest FROM agentos.skill_catalog',
      );
      const byId = new Map(existing.rows.map((row) => [row.skill_id, row] as const));

      let inserted = 0;
      let updated = 0;
      let unchanged = 0;
      for (const row of rows) {
        const current = byId.get(row.skill_id);
        if (current !== undefined) {
          const version = Number(current.contract_version);
          if (current.contract_digest !== row.contract_digest && row.contract_version <= version) {
            throw new SkillCatalogRefusal(
              'SKILL_CONTRACT_DIGEST_CHANGED_WITHOUT_VERSION_BUMP',
              row.skill_id,
              `skill ${row.skill_id} contract digest changed at version ${row.contract_version} (stored ${version}); bump contract_version`,
            );
          }
          if (current.contract_digest === row.contract_digest) {
            unchanged += 1;
            continue;
          }
        }
        await client.query(
          `INSERT INTO agentos.skill_catalog
             (skill_id, display_key, domain, effect_class, required_authority, autonomy_class, completion,
              receipt_ref, tool_binding, allowed_agents, connector_kinds, config_schema, retired,
              contract_version, contract_digest)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text[], $11::text[], $12::jsonb, false, $13, $14)
           ON CONFLICT (skill_id) DO UPDATE SET
             display_key = EXCLUDED.display_key,
             domain = EXCLUDED.domain,
             effect_class = EXCLUDED.effect_class,
             required_authority = EXCLUDED.required_authority,
             autonomy_class = EXCLUDED.autonomy_class,
             completion = EXCLUDED.completion,
             receipt_ref = EXCLUDED.receipt_ref,
             tool_binding = EXCLUDED.tool_binding,
             allowed_agents = EXCLUDED.allowed_agents,
             connector_kinds = EXCLUDED.connector_kinds,
             config_schema = EXCLUDED.config_schema,
             retired = false,
             contract_version = EXCLUDED.contract_version,
             contract_digest = EXCLUDED.contract_digest,
             updated_at = CURRENT_TIMESTAMP`,
          [
            row.skill_id,
            row.display_key,
            row.domain,
            row.effect_class,
            row.required_authority,
            row.autonomy_class,
            row.completion,
            row.receipt_ref,
            row.tool_binding,
            [...row.allowed_agents],
            [...row.connector_kinds],
            JSON.stringify(row.config_schema),
            row.contract_version,
            row.contract_digest,
          ],
        );
        if (current === undefined) inserted += 1;
        else {
          updated += 1;
          const before = catalogRecord({
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
            config_schema: { ...row.config_schema },
            retired: false,
            contract_version: String(current.contract_version),
            contract_digest: current.contract_digest,
            registered_at: new Date(0),
            updated_at: new Date(0),
          });
          await appendConfigAudit(
            client,
            auditContext(
              { actor_kind: 'SYSTEM', actor_id: 'skill-catalog-sync', correlation_id: 'skill-catalog-sync' },
              'PLATFORM',
              null,
              row.skill_id,
              'skill.catalog.register',
              { contract_version: before.contract_version, contract_digest: before.contract_digest },
              { contract_version: String(row.contract_version), contract_digest: row.contract_digest },
            ),
          );
        }
      }

      const published = rows.map((row) => row.skill_id);
      const retiredResult = await client.query<{ skill_id: string }>(
        `UPDATE agentos.skill_catalog
            SET retired = true, updated_at = CURRENT_TIMESTAMP
          WHERE retired = false AND NOT (skill_id = ANY ($1::text[]))
          RETURNING skill_id`,
        [published],
      );
      return {
        inserted,
        updated,
        unchanged,
        retired: retiredResult.rows.map((row) => row.skill_id),
      };
    });
  }

  async listCatalog(): Promise<readonly SkillCatalogRecord[]> {
    return this.platformTransaction(async (client) => {
      const result = await client.query<SkillCatalogRow>(
        'SELECT * FROM agentos.skill_catalog ORDER BY domain, skill_id',
      );
      return result.rows.map(catalogRecord);
    });
  }

  async getCatalogEntry(skill_id: string): Promise<SkillCatalogRecord | null> {
    return this.platformTransaction(async (client) => {
      const result = await client.query<SkillCatalogRow>(
        'SELECT * FROM agentos.skill_catalog WHERE skill_id = $1',
        [skill_id],
      );
      const row = result.rows[0];
      return row === undefined ? null : catalogRecord(row);
    });
  }

  async listSettings(tenant_id: string): Promise<readonly (TenantSkillSettingsRecord & { readonly allowed_agents: readonly string[]; readonly effect_class: SkillEffectClass })[]> {
    return this.tenantTransaction(tenant_id, async (client) => {
      const result = await client.query<TenantSkillSettingsJoinRow>(
        `SELECT s.*, c.allowed_agents, c.effect_class
           FROM agentos.tenant_skill_settings AS s
           JOIN agentos.skill_catalog AS c ON c.skill_id = s.skill_id
          WHERE s.tenant_id = $1
          ORDER BY s.skill_id`,
        [tenant_id],
      );
      return result.rows.map((row) => ({ ...row, allowed_agents: [...row.allowed_agents] }));
    });
  }

  async getSettings(tenant_id: string, skill_id: string): Promise<TenantSkillSettingsRecord | null> {
    return this.tenantTransaction(tenant_id, async (client) => {
      const result = await client.query<TenantSkillSettingsRecord>(
        `SELECT tenant_id::text AS tenant_id, skill_id, enabled, config, connector_id,
                version::text AS version, updated_by, updated_at
           FROM agentos.tenant_skill_settings
          WHERE tenant_id = $1 AND skill_id = $2`,
        [tenant_id, skill_id],
      );
      return result.rows[0] ?? null;
    });
  }

  /**
   * Writes one tenant's binding row under compare-and-set.
   *
   * @throws {SkillCatalogRefusal} `SKILL_SETTINGS_VERSION_CONFLICT` when the stored version does
   *   not match `expected_version`, and `SKILL_SETTINGS_CONTRACT_UNKNOWN` when the skill is not in
   *   the catalog. The triggers refuse undeclared config keys and non-narrowing writes.
   */
  async upsertSettings(input: UpsertSkillSettingsInput): Promise<TenantSkillSettingsRecord> {
    return this.tenantTransaction(input.tenant_id, async (client) => {
      const catalog = await client.query<{ effect_class: SkillEffectClass }>(
        'SELECT effect_class FROM agentos.skill_catalog WHERE skill_id = $1',
        [input.skill_id],
      );
      if (catalog.rows[0] === undefined) {
        throw new SkillCatalogRefusal(
          'SKILL_SETTINGS_CONTRACT_UNKNOWN',
          input.skill_id,
          `skill ${input.skill_id} is not in the catalog`,
        );
      }
      const before = await client.query<TenantSkillSettingsRecord>(
        `SELECT tenant_id::text AS tenant_id, skill_id, enabled, config, connector_id,
                version::text AS version, updated_by, updated_at
           FROM agentos.tenant_skill_settings
          WHERE tenant_id = $1 AND skill_id = $2`,
        [input.tenant_id, input.skill_id],
      );
      const current = before.rows[0] ?? null;
      if (input.expected_version === null) {
        if (current !== null) {
          throw new SkillCatalogRefusal(
            'SKILL_SETTINGS_VERSION_CONFLICT',
            input.skill_id,
            'a settings row already exists; expected_version must carry its version',
          );
        }
      } else if (current === null || current.version !== input.expected_version) {
        throw new SkillCatalogRefusal(
          'SKILL_SETTINGS_VERSION_CONFLICT',
          input.skill_id,
          `expected version ${input.expected_version} does not match the stored settings`,
        );
      }
      const result = await client.query<TenantSkillSettingsRecord>(
        `INSERT INTO agentos.tenant_skill_settings
           (tenant_id, skill_id, enabled, config, connector_id, version, updated_by, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, 1, $6, CURRENT_TIMESTAMP)
         ON CONFLICT (tenant_id, skill_id) DO UPDATE SET
           enabled = EXCLUDED.enabled,
           config = EXCLUDED.config,
           connector_id = EXCLUDED.connector_id,
           version = agentos.tenant_skill_settings.version + 1,
           updated_by = EXCLUDED.updated_by,
           updated_at = CURRENT_TIMESTAMP
         RETURNING tenant_id::text AS tenant_id, skill_id, enabled, config, connector_id,
                   version::text AS version, updated_by, updated_at`,
        [
          input.tenant_id,
          input.skill_id,
          input.enabled,
          JSON.stringify(input.config),
          input.connector_id,
          input.actor.actor_id,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new SkillCatalogRefusal('SKILL_SETTINGS_WRITE_FAILED', input.skill_id, 'settings write returned no row');
      }
      await appendConfigAudit(
        client,
        auditContext(input.actor, 'COMPANY', input.tenant_id, input.skill_id, 'skill.settings.update', current, row),
      );
      return row;
    });
  }

  /**
   * Replaces the agent assignment set. The trigger refuses any agent outside the contract ceiling
   * and the API-level check here surfaces it as a typed refusal before the constraint fires.
   */
  async replaceAgentAssignments(
    tenant_id: string,
    skill_id: string,
    agents: readonly string[],
    actor: SkillCatalogActor,
  ): Promise<readonly string[]> {
    return this.tenantTransaction(tenant_id, async (client) => {
      const catalog = await client.query<{ allowed_agents: readonly string[] }>(
        'SELECT allowed_agents FROM agentos.skill_catalog WHERE skill_id = $1',
        [skill_id],
      );
      const allowed = catalog.rows[0]?.allowed_agents;
      if (allowed === undefined) {
        throw new SkillCatalogRefusal(
          'SKILL_SETTINGS_CONTRACT_UNKNOWN',
          skill_id,
          `skill ${skill_id} is not in the catalog`,
        );
      }
      const outside = agents.filter((agent) => !allowed.includes(agent));
      if (outside.length > 0) {
        throw new SkillCatalogRefusal(
          'SKILL_ASSIGNMENT_EXCEEDS_CONTRACT',
          skill_id,
          `agents ${outside.join(', ')} are not in the contract ceiling for ${skill_id}`,
        );
      }
      const settings = await client.query(
        'SELECT 1 FROM agentos.tenant_skill_settings WHERE tenant_id = $1 AND skill_id = $2',
        [tenant_id, skill_id],
      );
      if (settings.rowCount === 0) {
        throw new SkillCatalogRefusal(
          'SKILL_SETTINGS_CONTRACT_UNKNOWN',
          skill_id,
          `skill ${skill_id} has no settings row for this tenant`,
        );
      }
      const before = await client.query<{ agent_code: string }>(
        'SELECT agent_code FROM agentos.tenant_skill_agents WHERE tenant_id = $1 AND skill_id = $2 ORDER BY agent_code',
        [tenant_id, skill_id],
      );
      await client.query('DELETE FROM agentos.tenant_skill_agents WHERE tenant_id = $1 AND skill_id = $2', [
        tenant_id,
        skill_id,
      ]);
      for (const agent of [...new Set(agents)].sort()) {
        await client.query(
          `INSERT INTO agentos.tenant_skill_agents (tenant_id, skill_id, agent_code, assigned_by)
           VALUES ($1, $2, $3, $4)`,
          [tenant_id, skill_id, agent, actor.actor_id],
        );
      }
      await appendConfigAudit(
        client,
        auditContext(actor, 'COMPANY', tenant_id, skill_id, 'skill.agents.replace', {
          agents: before.rows.map((row) => row.agent_code),
        }, { agents: [...new Set(agents)].sort() }),
      );
      return [...new Set(agents)].sort();
    });
  }

  async listAgentAssignments(tenant_id: string, skill_id: string): Promise<readonly string[]> {
    return this.tenantTransaction(tenant_id, async (client) => {
      const result = await client.query<{ agent_code: string }>(
        'SELECT agent_code FROM agentos.tenant_skill_agents WHERE tenant_id = $1 AND skill_id = $2 ORDER BY agent_code',
        [tenant_id, skill_id],
      );
      return result.rows.map((row) => row.agent_code);
    });
  }

  /**
   * Seeds the provisioning defaults and contract agent assignments on the same tenant transaction.
   * Idempotent — existing settings and assignment sets remain company-owned.
   */
  seedDefaultSettings(tenant_id: string, actor: SkillCatalogActor): Promise<number> {
    return this.tenantTransaction(
      tenant_id,
      (client) => seedDefaultSkillSettings(client, tenant_id, actor),
    );
  }

  /**
   * Inserts enabled settings for absent catalog skills. Existing rows are operator-owned, including
   * rows disabled after initial demo setup, and a seed rerun must not change them.
   */
  async seedDemoSettings(tenant_id: string, actor: SkillCatalogActor): Promise<number> {
    return this.tenantTransaction(tenant_id, async (client) => {
      const result = await client.query<{ skill_id: string }>(
        `INSERT INTO agentos.tenant_skill_settings
           (tenant_id, skill_id, enabled, config, connector_id, version, updated_by)
         SELECT $1, c.skill_id, true, '{}'::jsonb, NULL, 1, $2
           FROM agentos.skill_catalog AS c
          WHERE c.retired = false
         ON CONFLICT (tenant_id, skill_id) DO NOTHING
         RETURNING skill_id`,
        [tenant_id, actor.actor_id],
      );
      const activated = result.rowCount ?? 0;
      if (activated > 0) {
        await appendConfigAudit(
          client,
          auditContext(actor, 'COMPANY', tenant_id, '*', 'skill.settings.seed_demo', null, { activated }),
        );
      }
      return activated;
    });
  }

  async recordTestResult(input: RecordSkillTestInput): Promise<SkillTestResultRecord> {
    return this.tenantTransaction(input.tenant_id, async (client) => {
      const result = await client.query<SkillTestResultRecord>(
        `INSERT INTO agentos.skill_test_results
           (tenant_id, skill_id, mode, outcome, latency_ms, detail, tested_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         RETURNING test_id::text AS test_id, tenant_id::text AS tenant_id, skill_id, mode, outcome,
                   latency_ms, detail, tested_by, tested_at`,
        [
          input.tenant_id,
          input.skill_id,
          input.mode,
          input.outcome,
          input.latency_ms,
          JSON.stringify(input.detail),
          input.tested_by,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error('SKILL_TEST_RESULT_PERSISTENCE_FAILED');
      return row;
    });
  }

  async listTestResults(tenant_id: string, skill_id: string, limit = 20): Promise<readonly SkillTestResultRecord[]> {
    return this.tenantTransaction(tenant_id, async (client) => {
      const result = await client.query<SkillTestResultRecord>(
        `SELECT test_id::text AS test_id, tenant_id::text AS tenant_id, skill_id, mode, outcome,
                latency_ms, detail, tested_by, tested_at
           FROM agentos.skill_test_results
          WHERE tenant_id = $1 AND skill_id = $2
          ORDER BY tested_at DESC, test_id DESC
          LIMIT $3`,
        [tenant_id, skill_id, limit],
      );
      return result.rows;
    });
  }

  /**
   * 24 h success/failure/latency of one skill, read from the append-only stage ledger (`T5.1`).
   *
   * Latency percentiles are computed server-side so the API never loads the raw rows; a window with
   * no settled stage reports `null` for the rate and latency instead of a fabricated zero.
   */
  async skillHealth(
    tenant_id: string,
    skill_id: string,
    window_start: Date,
  ): Promise<SkillHealthSnapshot> {
    return this.tenantTransaction(tenant_id, async (client) => {
      const result = await client.query<{
        success_count: string;
        failure_count: string;
        refusal_count: string;
        awaiting_human_count: string;
        avg_latency_ms: string | null;
        p95_latency_ms: string | null;
        last_activity_at: Date | string | null;
      }>(
        `SELECT COUNT(*) FILTER (WHERE status = 'completed')::text AS success_count,
                COUNT(*) FILTER (WHERE status = 'failed')::text AS failure_count,
                COUNT(*) FILTER (WHERE status = 'refused')::text AS refusal_count,
                COUNT(*) FILTER (WHERE status = 'awaiting_human')::text AS awaiting_human_count,
                AVG(duration_ms)::text AS avg_latency_ms,
                percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms)::text AS p95_latency_ms,
                MAX(completed_at) AS last_activity_at
           FROM agentos.run_stage_results
          WHERE tenant_id = $1 AND skill_id = $2 AND completed_at >= $3`,
        [tenant_id, skill_id, window_start],
      );
      const row = result.rows[0];
      const lastFailure = await client.query<{ error_class: string | null }>(
        `SELECT error_class
           FROM agentos.run_stage_results
          WHERE tenant_id = $1 AND skill_id = $2 AND completed_at >= $3 AND status = 'failed'
          ORDER BY completed_at DESC
          LIMIT 1`,
        [tenant_id, skill_id, window_start],
      );
      const success = Number(row?.success_count ?? 0);
      const failure = Number(row?.failure_count ?? 0);
      const settled = success + failure;
      const average = row?.avg_latency_ms ?? null;
      const p95 = row?.p95_latency_ms ?? null;
      const lastActivity = row?.last_activity_at ?? null;
      return {
        window_start: window_start.toISOString(),
        success_count: success,
        failure_count: failure,
        refusal_count: Number(row?.refusal_count ?? 0),
        awaiting_human_count: Number(row?.awaiting_human_count ?? 0),
        success_rate: settled === 0 ? null : success / settled,
        avg_latency_ms: average === null ? null : Number(average),
        p95_latency_ms: p95 === null ? null : Number(p95),
        last_activity_at: lastActivity === null ? null : new Date(lastActivity).toISOString(),
        last_error_class: lastFailure.rows[0]?.error_class ?? null,
      };
    });
  }

  /** The immutable data class of a tenant; `null` when the tenant is unknown to this context. */
  async tenantDataClass(tenant_id: string): Promise<'PRODUCTION' | 'DEMO' | 'TEST' | null> {
    return this.tenantTransaction(tenant_id, async (client) => {
      const result = await client.query<{ data_class: 'PRODUCTION' | 'DEMO' | 'TEST' }>(
        'SELECT data_class FROM agentos.tenants WHERE tenant_id = $1',
        [tenant_id],
      );
      return result.rows[0]?.data_class ?? null;
    });
  }
}

/**
 * Boot-time catalog sync shared by the API and the worker.
 *
 * Both processes register the same manifest; the first to start inserts, later ones verify. A
 * digest change without a version bump aborts the boot (§10.2 "registered (boot: catalog sync,
 * contract_digest pinned)").
 */
export async function syncSkillCatalogAtBoot(
  rows: readonly SkillCatalogManifestRow[],
  options: SkillCatalogRepositoryOptions = {},
): Promise<SkillCatalogSyncResult> {
  return new SkillCatalogRepository(options).syncCatalog(rows);
}
