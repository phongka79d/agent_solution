import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';

import { withTenantContext } from '../rls.js';
import type { TenantTransactionRunner } from './effect-reservations.js';
import { appendConfigAudit } from './platform-audit.js';

const TABLE = 'agentos.connector_configurations';
const PROBES = 'agentos.connector_probe_results';

export type ConnectorBindingStatus = 'UNBOUND' | 'BOUND' | 'DEGRADED' | 'DISABLED';
export type ConnectorBindingMode = 'MOCK' | 'LIVE';
export type ConnectorProbeName = 'catalog' | 'inventory' | 'customers' | 'orders';
export type ConnectorProbeOutcome = 'PASS' | 'FAIL';

export interface ConnectorBindingRecord {
  readonly tenant_id: string;
  readonly connector_id: string;
  readonly status: ConnectorBindingStatus;
  readonly mode: ConnectorBindingMode;
  readonly config: Record<string, unknown>;
  readonly secret_id: string | null;
  readonly bound_at: string | null;
  readonly probe_outcome: string | null;
  readonly probe_latency_ms: number | null;
  readonly probe_http_status: number | null;
  readonly probe_error_class: string | null;
  readonly probed_at: string | null;
  readonly version: number;
}

/**
 * Only an untouched provisioning row (or no row) may inherit the DEMO environment connector.
 * Configuring or disconnecting increments version, so an explicit company decision remains
 * authoritative even when disconnect has cleared credentials and probe history.
 */
export function isPristineConnectorBinding(binding: ConnectorBindingRecord | null | undefined): boolean {
  return binding == null || (
    binding.status === 'UNBOUND'
    && binding.version === 1
    && Object.keys(binding.config).length === 0
    && binding.secret_id === null
    && binding.bound_at === null
    && binding.probe_outcome === null
    && binding.probed_at === null
  );
}

export interface ConnectorBindingActor {
  readonly actor_kind: string;
  readonly actor_id: string;
  readonly correlation_id: string;
}

export interface PutConnectorConfigInput {
  readonly config: Record<string, unknown>;
  readonly secret_id: string | null;
  readonly mode: ConnectorBindingMode;
}

export interface ConnectorProbeResult {
  readonly probe_name: ConnectorProbeName;
  readonly outcome: ConnectorProbeOutcome;
  readonly latency_ms: number | null;
  readonly http_status: number | null;
  readonly error_class: string | null;
  readonly probed_at?: string;
}

interface ConnectorRow extends QueryResultRow {
  tenant_id: string;
  connector_id: string;
  status: ConnectorBindingStatus;
  mode: ConnectorBindingMode;
  config: Record<string, unknown>;
  secret_id: string | null;
  bound_at: Date | string | null;
  probe_outcome: string | null;
  probe_latency_ms: number | null;
  probe_http_status: number | null;
  probe_error_class: string | null;
  probed_at: Date | string | null;
  version: number | string;
}

interface ProbeRow extends QueryResultRow {
  probe_id: string;
  tenant_id: string;
  connector_id: string;
  probe_name: ConnectorProbeName;
  outcome: ConnectorProbeOutcome;
  latency_ms: number | null;
  http_status: number | null;
  error_class: string | null;
  probed_at: Date | string;
}

function requireId(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) {
    throw new TypeError(`CONNECTOR_${field.toUpperCase()}_INVALID: ${field} is required.`);
  }
}

function iso(value: Date | string | null): string | null {
  return value === null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toRecord(row: ConnectorRow): ConnectorBindingRecord {
  return {
    ...row,
    bound_at: iso(row.bound_at),
    probed_at: iso(row.probed_at),
    version: Number(row.version),
  };
}

function auditState(row: ConnectorBindingRecord | null): unknown {
  if (row === null) return null;
  return {
    status: row.status,
    mode: row.mode,
    config: row.config,
    credential_present: row.secret_id !== null,
    version: row.version,
  };
}

function assertExpectedVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('CONNECTOR_VERSION_INVALID: expectedVersion must be a positive safe integer.');
  }
}

function noRow(code: string): never {
  throw new Error(`${code}: connector row is missing or its version is stale.`);
}

const SELECT_COLUMNS = `tenant_id, connector_id, status, mode, config, secret_id, bound_at,
  probe_outcome, probe_latency_ms, probe_http_status, probe_error_class, probed_at, version`;

export class ConnectorBindingRepository {
  constructor(private readonly runInTenantTransaction: TenantTransactionRunner = withTenantContext) {}

  async list(tenant_id: string): Promise<readonly ConnectorBindingRecord[]> {
    requireId(tenant_id, 'tenant_id');
    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query<ConnectorRow>(
        `SELECT ${SELECT_COLUMNS} FROM ${TABLE} WHERE tenant_id = $1 ORDER BY connector_id`,
        [tenant_id],
      );
      return result.rows.map(toRecord);
    });
  }

  async get(tenant_id: string, connector_id: string): Promise<ConnectorBindingRecord | null> {
    requireId(tenant_id, 'tenant_id');
    requireId(connector_id, 'connector_id');
    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query<ConnectorRow>(
        `SELECT ${SELECT_COLUMNS} FROM ${TABLE} WHERE tenant_id = $1 AND connector_id = $2`,
        [tenant_id, connector_id],
      );
      const row = result.rows[0];
      return row === undefined ? null : toRecord(row);
    });
  }

  async putConfig(
    tenant_id: string,
    connector_id: string,
    input: PutConnectorConfigInput,
    actor: ConnectorBindingActor,
    expectedVersion: number,
  ): Promise<ConnectorBindingRecord> {
    requireId(tenant_id, 'tenant_id');
    requireId(connector_id, 'connector_id');
    assertExpectedVersion(expectedVersion);
    const config = JSON.stringify(input.config);
    if (config === undefined) throw new TypeError('CONNECTOR_CONFIG_INVALID: config must be JSON serializable.');

    return this.runInTenantTransaction(tenant_id, async (client) => {
      const before = await this.lockConfig(client, tenant_id, connector_id);
      if (before === null || before.version !== expectedVersion) noRow('CONNECTOR_VERSION_CONFLICT');
      const result = await client.query<ConnectorRow>(
        `UPDATE ${TABLE}
            SET config = $3::jsonb, secret_id = $4, mode = $5, status = 'UNBOUND', bound_at = NULL,
                probe_outcome = NULL, probe_latency_ms = NULL, probe_http_status = NULL,
                probe_error_class = NULL, probed_at = NULL, version = version + 1
          WHERE tenant_id = $1 AND connector_id = $2 AND version = $6
          RETURNING ${SELECT_COLUMNS}`,
        [tenant_id, connector_id, config, input.secret_id, input.mode, expectedVersion],
      );
      const row = result.rows[0];
      if (row === undefined) noRow('CONNECTOR_VERSION_CONFLICT');
      const after = toRecord(row);
      await appendConfigAudit(client, {
        actor_kind: actor.actor_kind,
        actor_id: actor.actor_id,
        scope: 'COMPANY',
        action: 'connector.config.put',
        target_tenant: tenant_id,
        target: connector_id,
        outcome: 'ACCEPTED',
        reason: null,
        before: auditState(before),
        after: auditState(after),
        correlation_id: actor.correlation_id,
      });
      return after;
    });
  }

  async recordProbe(
    tenant_id: string,
    connector_id: string,
    result: ConnectorProbeResult,
  ): Promise<ConnectorBindingRecord> {
    requireId(tenant_id, 'tenant_id');
    requireId(connector_id, 'connector_id');
    return this.runInTenantTransaction(tenant_id, async (client) => {
      const before = await this.lockConfig(client, tenant_id, connector_id);
      if (before === null) noRow('CONNECTOR_NOT_FOUND');
      if (before.status === 'DISABLED') throw new Error('CONNECTOR_DISABLED: a disabled connector cannot be bound by a probe.');
      const probe = await client.query<ProbeRow>(
        `INSERT INTO ${PROBES}
          (tenant_id, connector_id, probe_name, outcome, latency_ms, http_status, error_class, probed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, CURRENT_TIMESTAMP))
         RETURNING probe_id, tenant_id, connector_id, probe_name, outcome, latency_ms, http_status, error_class, probed_at`,
        [tenant_id, connector_id, result.probe_name, result.outcome, result.latency_ms, result.http_status,
          result.error_class, result.probed_at ?? null],
      );
      if (probe.rows[0] === undefined) throw new Error('CONNECTOR_PROBE_INSERT_FAILED: probe history was not recorded.');
      const updated = await client.query<ConnectorRow>(
        `UPDATE ${TABLE}
            SET status = $3, bound_at = CASE WHEN $3 = 'BOUND' THEN CURRENT_TIMESTAMP ELSE NULL END,
                probe_outcome = $4, probe_latency_ms = $5, probe_http_status = $6,
                probe_error_class = $7, probed_at = $8
          WHERE tenant_id = $1 AND connector_id = $2
          RETURNING ${SELECT_COLUMNS}`,
        [tenant_id, connector_id, result.outcome === 'PASS' ? 'BOUND' : 'DEGRADED', result.outcome,
          result.latency_ms, result.http_status, result.error_class, probe.rows[0].probed_at],
      );
      const row = updated.rows[0];
      if (row === undefined) noRow('CONNECTOR_NOT_FOUND');
      const after = toRecord(row);
      await appendConfigAudit(client, {
        actor_kind: 'SYSTEM',
        actor_id: 'connector-probe',
        scope: 'COMPANY',
        action: 'connector.probe.recorded',
        target_tenant: tenant_id,
        target: connector_id,
        outcome: 'ACCEPTED',
        reason: result.outcome === 'PASS' ? null : result.error_class,
        before: auditState(before),
        after: { ...auditState(after) as object, probe_name: result.probe_name, probe_outcome: result.outcome },
        correlation_id: randomUUID(),
      });
      return after;
    });
  }

  async disconnect(
    tenant_id: string,
    connector_id: string,
    actor: ConnectorBindingActor,
    expectedVersion: number,
  ): Promise<ConnectorBindingRecord> {
    requireId(tenant_id, 'tenant_id');
    requireId(connector_id, 'connector_id');
    assertExpectedVersion(expectedVersion);
    return this.runInTenantTransaction(tenant_id, async (client) => {
      const before = await this.lockConfig(client, tenant_id, connector_id);
      if (before === null || before.version !== expectedVersion) noRow('CONNECTOR_VERSION_CONFLICT');
      const result = await client.query<ConnectorRow>(
        `UPDATE ${TABLE}
            SET status = 'UNBOUND', secret_id = NULL, bound_at = NULL,
                probe_outcome = NULL, probe_latency_ms = NULL, probe_http_status = NULL,
                probe_error_class = NULL, probed_at = NULL, version = version + 1
          WHERE tenant_id = $1 AND connector_id = $2 AND version = $3
          RETURNING ${SELECT_COLUMNS}`,
        [tenant_id, connector_id, expectedVersion],
      );
      const row = result.rows[0];
      if (row === undefined) noRow('CONNECTOR_VERSION_CONFLICT');
      const after = toRecord(row);
      await appendConfigAudit(client, {
        actor_kind: actor.actor_kind,
        actor_id: actor.actor_id,
        scope: 'COMPANY',
        action: 'connector.config.disconnect',
        target_tenant: tenant_id,
        target: connector_id,
        outcome: 'ACCEPTED',
        reason: null,
        before: auditState(before),
        after: auditState(after),
        correlation_id: actor.correlation_id,
      });
      return after;
    });
  }

  private async lockConfig(client: PoolClient, tenant_id: string, connector_id: string): Promise<ConnectorBindingRecord | null> {
    const result = await client.query<ConnectorRow>(
      `SELECT ${SELECT_COLUMNS} FROM ${TABLE} WHERE tenant_id = $1 AND connector_id = $2 FOR UPDATE`,
      [tenant_id, connector_id],
    );
    const row = result.rows[0];
    return row === undefined ? null : toRecord(row);
  }
}
