import type { QueryResultRow } from 'pg';

import { getPool } from '../client.js';
import { withTenantContext } from '../rls.js';
import { assertIdentifier } from './durable-workflows.js';
import type { TenantTransactionRunner } from './effect-reservations.js';

const TENANTS = 'agentos.tenants';
const WORKSPACES = 'agentos.tenant_workspaces';
const CAPABILITIES = 'agentos.tenant_capabilities';
const CONNECTORS = 'agentos.connector_configurations';
const OWNER_INPUTS = 'agentos.unresolved_owner_inputs';
const NAMESPACES = 'agentos.namespace_bindings';
const SHOPIFY_INSTALLATIONS = 'agentos.shopify_installations';
const SHOPIFY_DELIVERIES = 'agentos.shopify_webhook_deliveries';
const RESIDENCY = 'agentos.residency_configurations';
const PROVISIONING_EVENTS = 'agentos.provisioning_events';

export interface ProvisionTenantShellInput {
  readonly idempotency_key: string;
  readonly request_fingerprint: string;
  readonly display_name: string;
}

export interface TenantRecord {
  readonly tenant_id: string;
  readonly status: 'PROVISIONED';
  readonly display_name: string;
  readonly created_at: string;
  readonly idempotency_key: string;
  readonly request_fingerprint: string;
}

export interface TenantWorkspaceRecord {
  readonly tenant_id: string;
  readonly admin_binding_ref: string;
  readonly status: 'UNCONFIGURED';
}

export interface CommitTenantWorkspaceInput {
  readonly tenant_id: string;
  readonly admin_binding_ref: string;
  readonly status: 'UNCONFIGURED';
}

export interface TenantCapabilityRecord {
  readonly tenant_id: string;
  readonly capability_id: string;
  readonly status: 'UNCONFIGURED';
}

export interface CommitTenantCapabilityInput {
  readonly tenant_id: string;
  readonly capability_id: string;
  readonly status: 'UNCONFIGURED';
}

export type ConnectorConfigurationStatus = 'UNBOUND' | 'DISABLED';

export interface ConnectorConfigurationRecord {
  readonly tenant_id: string;
  readonly connector_id: string;
  readonly status: ConnectorConfigurationStatus;
  readonly secret_ref: string | null;
}

export interface CommitConnectorConfigurationInput {
  readonly tenant_id: string;
  readonly connector_id: string;
  readonly status: ConnectorConfigurationStatus;
  readonly secret_ref: string | null;
}

export interface OwnerInputRecord {
  readonly tenant_id: string;
  readonly input_id: string;
  readonly status: 'UNRESOLVED';
}

export interface AppendOwnerInputInput {
  readonly tenant_id: string;
  readonly input_id: string;
  readonly status: 'UNRESOLVED';
}

export interface NamespaceBindingRecord {
  readonly tenant_id: string;
  readonly redis_prefix: string;
  readonly vector_filter: string;
  readonly storage_prefix: string;
}

export interface CommitNamespaceBindingInput {
  readonly tenant_id: string;
  readonly redis_prefix: string;
  readonly vector_filter: string;
  readonly storage_prefix: string;
}

export type ShopifyInstallationStatus = 'PENDING' | 'BOUND' | 'REVOKED';

export interface ShopifyInstallationRecord {
  readonly tenant_id: string;
  readonly shop_domain: string;
  readonly status: ShopifyInstallationStatus;
  readonly state_token_hash: string | null;
  readonly secret_ref: string | null;
  readonly installed_at: string | null;
}

export interface CommitShopifyInstallationInput {
  readonly tenant_id: string;
  readonly shop_domain: string;
  readonly status: ShopifyInstallationStatus;
  readonly state_token_hash: string | null;
  readonly secret_ref: string | null;
  readonly installed_at: string | null;
}

export interface ShopifyWebhookDeliveryRecord {
  readonly tenant_id: string;
  readonly delivery_id: string;
  readonly received_at: string;
}

export interface AppendShopifyWebhookDeliveryInput {
  readonly tenant_id: string;
  readonly delivery_id: string;
  readonly received_at: string;
}

export type ResidencyStatus = 'UNRESOLVED' | 'CONFIGURED';

export interface ResidencyConfigurationRecord {
  readonly tenant_id: string;
  readonly region: string | null;
  readonly status: ResidencyStatus;
}

export interface CommitResidencyConfigurationInput {
  readonly tenant_id: string;
  readonly region: string | null;
  readonly status: ResidencyStatus;
}

export interface ProvisioningEventRecord {
  readonly event_id: string;
  readonly tenant_id: string;
  readonly idempotency_key: string;
  readonly event_type: string;
  readonly payload: Record<string, unknown>;
  readonly occurred_at: string;
}

export interface AppendProvisioningEventInput {
  readonly event_id?: string;
  readonly tenant_id: string;
  readonly idempotency_key: string;
  readonly event_type: string;
  readonly payload: Record<string, unknown>;
  readonly occurred_at: string;
}

interface TenantRow extends QueryResultRow {
  tenant_id: string;
  status: 'PROVISIONED';
  display_name: string;
  created_at: Date | string;
  idempotency_key: string;
  request_fingerprint: string;
}

interface WorkspaceRow extends QueryResultRow {
  tenant_id: string;
  admin_binding_ref: string;
  status: 'UNCONFIGURED';
}

interface CapabilityRow extends QueryResultRow {
  tenant_id: string;
  capability_id: string;
  status: 'UNCONFIGURED';
}

interface ConnectorRow extends QueryResultRow {
  tenant_id: string;
  connector_id: string;
  status: ConnectorConfigurationStatus;
  secret_ref: string | null;
}

interface OwnerInputRow extends QueryResultRow {
  tenant_id: string;
  input_id: string;
  status: 'UNRESOLVED';
}

interface NamespaceRow extends QueryResultRow {
  tenant_id: string;
  redis_prefix: string;
  vector_filter: string;
  storage_prefix: string;
}

interface ShopifyInstallationRow extends QueryResultRow {
  tenant_id: string;
  shop_domain: string;
  status: ShopifyInstallationStatus;
  state_token_hash: string | null;
  secret_ref: string | null;
  installed_at: Date | string | null;
}

interface ShopifyDeliveryRow extends QueryResultRow {
  tenant_id: string;
  delivery_id: string;
  received_at: Date | string;
}

interface ResidencyRow extends QueryResultRow {
  tenant_id: string;
  region: string | null;
  status: ResidencyStatus;
}

interface ProvisioningEventRow extends QueryResultRow {
  event_id: string;
  tenant_id: string;
  idempotency_key: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date | string;
}

const TENANT_COLUMNS = `tenant_id, status, display_name, created_at, idempotency_key, request_fingerprint`;
const WORKSPACE_COLUMNS = `tenant_id, admin_binding_ref, status`;
const CAPABILITY_COLUMNS = `tenant_id, capability_id, status`;
const CONNECTOR_COLUMNS = `tenant_id, connector_id, status, secret_ref`;
const OWNER_INPUT_COLUMNS = `tenant_id, input_id, status`;
const NAMESPACE_COLUMNS = `tenant_id, redis_prefix, vector_filter, storage_prefix`;
const SHOPIFY_COLUMNS = `tenant_id, shop_domain, status, state_token_hash, secret_ref, installed_at`;
const DELIVERY_COLUMNS = `tenant_id, delivery_id, received_at`;
const RESIDENCY_COLUMNS = `tenant_id, region, status`;
const EVENT_COLUMNS = `event_id, tenant_id, idempotency_key, event_type, payload, occurred_at`;

const SELECT_TENANT = `SELECT ${TENANT_COLUMNS} FROM ${TENANTS} WHERE tenant_id = $1`;
const SELECT_WORKSPACE = `SELECT ${WORKSPACE_COLUMNS} FROM ${WORKSPACES} WHERE tenant_id = $1`;
const SELECT_CAPABILITIES = `SELECT ${CAPABILITY_COLUMNS} FROM ${CAPABILITIES} WHERE tenant_id = $1 ORDER BY capability_id`;
const SELECT_CONNECTORS = `SELECT ${CONNECTOR_COLUMNS} FROM ${CONNECTORS} WHERE tenant_id = $1 ORDER BY connector_id`;
const SELECT_OWNER_INPUTS = `SELECT ${OWNER_INPUT_COLUMNS} FROM ${OWNER_INPUTS} WHERE tenant_id = $1 ORDER BY input_id`;
const SELECT_NAMESPACE = `SELECT ${NAMESPACE_COLUMNS} FROM ${NAMESPACES} WHERE tenant_id = $1`;
const SELECT_SHOPIFY_BASE = `SELECT ${SHOPIFY_COLUMNS} FROM ${SHOPIFY_INSTALLATIONS} WHERE tenant_id = $1`;
const SELECT_SHOPIFY = `${SELECT_SHOPIFY_BASE} ORDER BY shop_domain`;
const SELECT_SHOPIFY_ONE = `${SELECT_SHOPIFY_BASE} AND shop_domain = $2`;
const SELECT_DELIVERIES = `SELECT ${DELIVERY_COLUMNS} FROM ${SHOPIFY_DELIVERIES} WHERE tenant_id = $1 ORDER BY received_at, delivery_id`;
const SELECT_RESIDENCY = `SELECT ${RESIDENCY_COLUMNS} FROM ${RESIDENCY} WHERE tenant_id = $1`;
const SELECT_EVENTS = `SELECT ${EVENT_COLUMNS} FROM ${PROVISIONING_EVENTS} WHERE tenant_id = $1 ORDER BY occurred_at, event_id`;

const UPSERT_WORKSPACE = `INSERT INTO ${WORKSPACES} (tenant_id, admin_binding_ref, status)
  VALUES ($1, $2, $3)
  ON CONFLICT (tenant_id) DO UPDATE SET admin_binding_ref = EXCLUDED.admin_binding_ref, status = EXCLUDED.status
  RETURNING ${WORKSPACE_COLUMNS}`;
const UPSERT_CAPABILITY = `INSERT INTO ${CAPABILITIES} (tenant_id, capability_id, status)
  VALUES ($1, $2, $3)
  ON CONFLICT (tenant_id, capability_id) DO UPDATE SET status = EXCLUDED.status
  RETURNING ${CAPABILITY_COLUMNS}`;
const UPSERT_CONNECTOR = `INSERT INTO ${CONNECTORS} (tenant_id, connector_id, status, secret_ref)
  VALUES ($1, $2, $3, $4)
  ON CONFLICT (tenant_id, connector_id) DO UPDATE SET status = EXCLUDED.status, secret_ref = EXCLUDED.secret_ref
  RETURNING ${CONNECTOR_COLUMNS}`;
const INSERT_OWNER_INPUT = `INSERT INTO ${OWNER_INPUTS} (tenant_id, input_id, status)
  VALUES ($1, $2, $3)
  ON CONFLICT (tenant_id, input_id) DO NOTHING
  RETURNING ${OWNER_INPUT_COLUMNS}`;
const UPSERT_NAMESPACE = `INSERT INTO ${NAMESPACES} (tenant_id, redis_prefix, vector_filter, storage_prefix)
  VALUES ($1, $2, $3, $4)
  ON CONFLICT (tenant_id) DO UPDATE SET
    redis_prefix = EXCLUDED.redis_prefix,
    vector_filter = EXCLUDED.vector_filter,
    storage_prefix = EXCLUDED.storage_prefix
  RETURNING ${NAMESPACE_COLUMNS}`;
const UPSERT_SHOPIFY = `INSERT INTO ${SHOPIFY_INSTALLATIONS}
    (tenant_id, shop_domain, status, state_token_hash, secret_ref, installed_at)
  VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
  ON CONFLICT (tenant_id, shop_domain) DO UPDATE SET
    status = EXCLUDED.status,
    state_token_hash = EXCLUDED.state_token_hash,
    secret_ref = EXCLUDED.secret_ref,
    installed_at = EXCLUDED.installed_at
  RETURNING ${SHOPIFY_COLUMNS}`;
const INSERT_DELIVERY = `INSERT INTO ${SHOPIFY_DELIVERIES} (tenant_id, delivery_id, received_at)
  VALUES ($1, $2, $3::timestamptz)
  ON CONFLICT (tenant_id, delivery_id) DO NOTHING
  RETURNING ${DELIVERY_COLUMNS}`;
const UPSERT_RESIDENCY = `INSERT INTO ${RESIDENCY} (tenant_id, region, status)
  VALUES ($1, $2, $3)
  ON CONFLICT (tenant_id) DO UPDATE SET region = EXCLUDED.region, status = EXCLUDED.status
  RETURNING ${RESIDENCY_COLUMNS}`;
const INSERT_EVENT = `INSERT INTO ${PROVISIONING_EVENTS}
    (event_id, tenant_id, idempotency_key, event_type, payload, occurred_at)
  VALUES (COALESCE($1::uuid, agentos.uuid_generate_v7()), $2, $3, $4, $5::jsonb, $6::timestamptz)
  RETURNING ${EVENT_COLUMNS}`;

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function requireText(value: unknown, field: string, code: string, maxLength: number): string {
  assertIdentifier(value, field, maxLength, code);
  return value as string;
}

function requireInstant(value: unknown, field: string, code: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${code}: ${field} must be an ISO-8601 timestamp.`);
  }
  return value;
}

function toTenant(row: TenantRow): TenantRecord {
  return { ...row, created_at: iso(row.created_at) };
}

function toShopify(row: ShopifyInstallationRow): ShopifyInstallationRecord {
  return { ...row, installed_at: nullableIso(row.installed_at) };
}

function toDelivery(row: ShopifyDeliveryRow): ShopifyWebhookDeliveryRecord {
  return { ...row, received_at: iso(row.received_at) };
}

function toEvent(row: ProvisioningEventRow): ProvisioningEventRecord {
  return { ...row, occurred_at: iso(row.occurred_at) };
}

function requiredRow<T>(rows: readonly T[], code: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`${code}: database write returned no row.`);
  return row;
}

export class P5ProvisioningRepository {
  constructor(private readonly runInTenantTransaction: TenantTransactionRunner = withTenantContext) {}

  async provisionTenantShell(input: ProvisionTenantShellInput): Promise<string> {
    requireText(input.idempotency_key, 'idempotency_key', 'P5_PROVISIONING_IDEMPOTENCY_REQUIRED', 64);
    requireText(input.request_fingerprint, 'request_fingerprint', 'P5_PROVISIONING_FINGERPRINT_REQUIRED', 64);
    requireText(input.display_name, 'display_name', 'P5_PROVISIONING_DISPLAY_NAME_REQUIRED', 128);

    const client = await getPool().connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;
      await client.query('SET LOCAL ROLE agentos_platform');
      const result = await client.query<{ tenant_id: string }>(
        'SELECT agentos.provision_tenant_shell($1::char(64), $2::char(64), $3::varchar(128)) AS tenant_id',
        [input.idempotency_key, input.request_fingerprint, input.display_name],
      );
      const tenant_id = result.rows[0]?.tenant_id;
      if (tenant_id === undefined) throw new Error('P5_PROVISIONING_EMPTY_RESULT: shell function returned no tenant.');
      await client.query('COMMIT');
      transactionOpen = false;
      return tenant_id;
    } catch (error) {
      if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getTenant(tenant_id: string): Promise<TenantRecord | null> {
    requireText(tenant_id, 'tenant_id', 'P5_PROVISIONING_TENANT_REQUIRED', 36);
    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query<TenantRow>(SELECT_TENANT, [tenant_id]);
      const row = result.rows[0];
      return row === undefined ? null : toTenant(row);
    });
  }

  async listTenants(tenant_id: string): Promise<readonly TenantRecord[]> {
    const tenant = await this.getTenant(tenant_id);
    return tenant === null ? [] : [tenant];
  }

  async getWorkspace(tenant_id: string): Promise<TenantWorkspaceRecord | null> {
    requireText(tenant_id, 'tenant_id', 'P5_PROVISIONING_TENANT_REQUIRED', 36);
    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query<WorkspaceRow>(SELECT_WORKSPACE, [tenant_id]);
      return result.rows[0] ?? null;
    });
  }

  async commitWorkspace(input: CommitTenantWorkspaceInput): Promise<TenantWorkspaceRecord> {
    requireText(input.tenant_id, 'tenant_id', 'P5_PROVISIONING_TENANT_REQUIRED', 36);
    requireText(input.admin_binding_ref, 'admin_binding_ref', 'P5_PROVISIONING_ADMIN_BINDING_REQUIRED', 128);
    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const result = await client.query<WorkspaceRow>(UPSERT_WORKSPACE, [
        input.tenant_id,
        input.admin_binding_ref,
        input.status,
      ]);
      return requiredRow(result.rows, 'P5_PROVISIONING_WORKSPACE_EMPTY');
    });
  }

  async listCapabilities(tenant_id: string): Promise<readonly TenantCapabilityRecord[]> {
    requireText(tenant_id, 'tenant_id', 'P5_PROVISIONING_TENANT_REQUIRED', 36);
    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query<CapabilityRow>(SELECT_CAPABILITIES, [tenant_id]);
      return result.rows;
    });
  }

  async commitCapability(input: CommitTenantCapabilityInput): Promise<TenantCapabilityRecord> {
    requireText(input.tenant_id, 'tenant_id', 'P5_PROVISIONING_TENANT_REQUIRED', 36);
    requireText(input.capability_id, 'capability_id', 'P5_PROVISIONING_CAPABILITY_REQUIRED', 64);
    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const result = await client.query<CapabilityRow>(UPSERT_CAPABILITY, [
        input.tenant_id,
        input.capability_id,
        input.status,
      ]);
      return requiredRow(result.rows, 'P5_PROVISIONING_CAPABILITY_EMPTY');
    });
  }

  async listConnectors(tenant_id: string): Promise<readonly ConnectorConfigurationRecord[]> {
    requireText(tenant_id, 'tenant_id', 'P5_PROVISIONING_TENANT_REQUIRED', 36);
    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query<ConnectorRow>(SELECT_CONNECTORS, [tenant_id]);
      return result.rows;
    });
  }

  async commitConnector(input: CommitConnectorConfigurationInput): Promise<ConnectorConfigurationRecord> {
    requireText(input.tenant_id, 'tenant_id', 'P5_PROVISIONING_TENANT_REQUIRED', 36);
    requireText(input.connector_id, 'connector_id', 'P5_PROVISIONING_CONNECTOR_REQUIRED', 64);
    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const result = await client.query<ConnectorRow>(UPSERT_CONNECTOR, [
        input.tenant_id,
        input.connector_id,
        input.status,
        input.secret_ref,
      ]);
      return requiredRow(result.rows, 'P5_PROVISIONING_CONNECTOR_EMPTY');
    });
  }

  async listOwnerInputs(tenant_id: string): Promise<readonly OwnerInputRecord[]> {
    requireText(tenant_id, 'tenant_id', 'P5_PROVISIONING_TENANT_REQUIRED', 36);
    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query<OwnerInputRow>(SELECT_OWNER_INPUTS, [tenant_id]);
      return result.rows;
    });
  }

  async appendOwnerInput(input: AppendOwnerInputInput): Promise<OwnerInputRecord | null> {
    requireText(input.tenant_id, 'tenant_id', 'P5_PROVISIONING_TENANT_REQUIRED', 36);
    requireText(input.input_id, 'input_id', 'P5_PROVISIONING_OWNER_INPUT_REQUIRED', 64);
    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const result = await client.query<OwnerInputRow>(INSERT_OWNER_INPUT, [
        input.tenant_id,
        input.input_id,
        input.status,
      ]);
      return result.rows[0] ?? null;
    });
  }

  async getNamespace(tenant_id: string): Promise<NamespaceBindingRecord | null> {
    requireText(tenant_id, 'tenant_id', 'P5_PROVISIONING_TENANT_REQUIRED', 36);
    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query<NamespaceRow>(SELECT_NAMESPACE, [tenant_id]);
      return result.rows[0] ?? null;
    });
  }

  async commitNamespace(input: CommitNamespaceBindingInput): Promise<NamespaceBindingRecord> {
    requireText(input.tenant_id, 'tenant_id', 'P5_PROVISIONING_TENANT_REQUIRED', 36);
    requireText(input.redis_prefix, 'redis_prefix', 'P5_PROVISIONING_REDIS_PREFIX_REQUIRED', 4096);
    requireText(input.vector_filter, 'vector_filter', 'P5_PROVISIONING_VECTOR_FILTER_REQUIRED', 4096);
    requireText(input.storage_prefix, 'storage_prefix', 'P5_PROVISIONING_STORAGE_PREFIX_REQUIRED', 4096);
    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const result = await client.query<NamespaceRow>(UPSERT_NAMESPACE, [
        input.tenant_id,
        input.redis_prefix,
        input.vector_filter,
        input.storage_prefix,
      ]);
      return requiredRow(result.rows, 'P5_PROVISIONING_NAMESPACE_EMPTY');
    });
  }

  async getShopify(tenant_id: string, shop_domain: string): Promise<ShopifyInstallationRecord | null> {
    requireText(tenant_id, 'tenant_id', 'P5_PROVISIONING_TENANT_REQUIRED', 36);
    requireText(shop_domain, 'shop_domain', 'P5_PROVISIONING_SHOP_DOMAIN_REQUIRED', 255);
    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query<ShopifyInstallationRow>(SELECT_SHOPIFY_ONE, [tenant_id, shop_domain]);
      const row = result.rows[0];
      return row === undefined ? null : toShopify(row);
    });
  }

  async listShopify(tenant_id: string): Promise<readonly ShopifyInstallationRecord[]> {
    requireText(tenant_id, 'tenant_id', 'P5_PROVISIONING_TENANT_REQUIRED', 36);
    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query<ShopifyInstallationRow>(SELECT_SHOPIFY, [tenant_id]);
      return result.rows.map(toShopify);
    });
  }

  async commitShopify(input: CommitShopifyInstallationInput): Promise<ShopifyInstallationRecord> {
    requireText(input.tenant_id, 'tenant_id', 'P5_PROVISIONING_TENANT_REQUIRED', 36);
    requireText(input.shop_domain, 'shop_domain', 'P5_PROVISIONING_SHOP_DOMAIN_REQUIRED', 255);
    if (input.installed_at !== null) requireInstant(input.installed_at, 'installed_at', 'P5_PROVISIONING_INSTALLED_AT_INVALID');
    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const result = await client.query<ShopifyInstallationRow>(UPSERT_SHOPIFY, [
        input.tenant_id,
        input.shop_domain,
        input.status,
        input.state_token_hash,
        input.secret_ref,
        input.installed_at,
      ]);
      return toShopify(requiredRow(result.rows, 'P5_PROVISIONING_SHOPIFY_EMPTY'));
    });
  }

  async appendShopifyWebhook(input: AppendShopifyWebhookDeliveryInput): Promise<ShopifyWebhookDeliveryRecord | null> {
    requireText(input.tenant_id, 'tenant_id', 'P5_PROVISIONING_TENANT_REQUIRED', 36);
    requireText(input.delivery_id, 'delivery_id', 'P5_PROVISIONING_DELIVERY_REQUIRED', 128);
    requireInstant(input.received_at, 'received_at', 'P5_PROVISIONING_RECEIVED_AT_INVALID');
    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const result = await client.query<ShopifyDeliveryRow>(INSERT_DELIVERY, [
        input.tenant_id,
        input.delivery_id,
        input.received_at,
      ]);
      const row = result.rows[0];
      return row === undefined ? null : toDelivery(row);
    });
  }

  async listShopifyWebhooks(tenant_id: string): Promise<readonly ShopifyWebhookDeliveryRecord[]> {
    requireText(tenant_id, 'tenant_id', 'P5_PROVISIONING_TENANT_REQUIRED', 36);
    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query<ShopifyDeliveryRow>(SELECT_DELIVERIES, [tenant_id]);
      return result.rows.map(toDelivery);
    });
  }

  async getResidency(tenant_id: string): Promise<ResidencyConfigurationRecord | null> {
    requireText(tenant_id, 'tenant_id', 'P5_PROVISIONING_TENANT_REQUIRED', 36);
    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query<ResidencyRow>(SELECT_RESIDENCY, [tenant_id]);
      return result.rows[0] ?? null;
    });
  }

  async commitResidency(input: CommitResidencyConfigurationInput): Promise<ResidencyConfigurationRecord> {
    requireText(input.tenant_id, 'tenant_id', 'P5_PROVISIONING_TENANT_REQUIRED', 36);
    if (input.region !== null) requireText(input.region, 'region', 'P5_PROVISIONING_REGION_INVALID', 64);
    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const result = await client.query<ResidencyRow>(UPSERT_RESIDENCY, [
        input.tenant_id,
        input.region,
        input.status,
      ]);
      return requiredRow(result.rows, 'P5_PROVISIONING_RESIDENCY_EMPTY');
    });
  }

  async appendProvisioningEvent(input: AppendProvisioningEventInput): Promise<ProvisioningEventRecord> {
    requireText(input.tenant_id, 'tenant_id', 'P5_PROVISIONING_TENANT_REQUIRED', 36);
    requireText(input.idempotency_key, 'idempotency_key', 'P5_PROVISIONING_IDEMPOTENCY_REQUIRED', 64);
    requireText(input.event_type, 'event_type', 'P5_PROVISIONING_EVENT_TYPE_REQUIRED', 4096);
    requireInstant(input.occurred_at, 'occurred_at', 'P5_PROVISIONING_OCCURRED_AT_INVALID');
    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const result = await client.query<ProvisioningEventRow>(INSERT_EVENT, [
        input.event_id ?? null,
        input.tenant_id,
        input.idempotency_key,
        input.event_type,
        JSON.stringify(input.payload),
        input.occurred_at,
      ]);
      return toEvent(requiredRow(result.rows, 'P5_PROVISIONING_EVENT_EMPTY'));
    });
  }

  async listProvisioningEvents(tenant_id: string): Promise<readonly ProvisioningEventRecord[]> {
    requireText(tenant_id, 'tenant_id', 'P5_PROVISIONING_TENANT_REQUIRED', 36);
    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query<ProvisioningEventRow>(SELECT_EVENTS, [tenant_id]);
      return result.rows.map(toEvent);
    });
  }
}

export { P5ProvisioningRepository as ProvisioningRepository };
