import { createHash, randomUUID } from 'node:crypto';

import type { PoolClient, QueryResultRow } from 'pg';

import { withTenantContext } from '../rls.js';
import type { TenantTransactionRunner } from './effect-reservations.js';

/**
 * Server-owned data classification of the Test Customer Lab (`workflow.md` §5).
 *
 * The lab may only create `TEST` rows, and only inside a tenant whose own data class is
 * `DEMO` or `TEST`; `reset_test_data` deletes `TEST` rows only.
 */
export type TestDataClass = 'DEMO' | 'TEST' | 'PRODUCTION';

export interface TestCustomerIdentityInput {
  readonly channel_type: string;
  readonly channel_identifier: string;
  readonly is_primary?: boolean;
}

export interface TestCustomerConsentInput {
  readonly consent_type: string;
  readonly channel: string;
  readonly is_granted: boolean;
  readonly opt_in_method?: string;
  readonly evidence_text?: string;
}

export interface TestCustomerEventInput {
  readonly event_name: string;
  readonly channel: string;
  readonly session_id?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly occurred_at?: string;
}

export interface TestCustomerOrderInput {
  readonly order_number?: string;
  readonly currency?: string;
  readonly status?: string;
  readonly total_amount: number;
  readonly items?: readonly Readonly<Record<string, unknown>>[];
}

export interface TestCustomerSupportInput {
  readonly subject: string;
  readonly category?: string;
  readonly priority?: string;
}

export interface TestCustomerHandoffInput {
  readonly escalation_reason: string;
  readonly summary_context?: string;
  readonly channel?: string;
  readonly session_id?: string;
}

interface TestDefaultShippingAddress {
  readonly recipient_name: string;
  readonly phone: string;
  readonly postal_code: string;
  readonly city: string;
  readonly district: string;
  readonly address_line1: string;
  readonly cvs_store_id?: string;
  readonly cvs_store_name?: string;
}

const DEFAULT_SHIPPING_ADDRESS_FIELDS: Readonly<Record<string, true>> = {
  recipient_name: true,
  phone: true,
  postal_code: true,
  city: true,
  district: true,
  address_line1: true,
  cvs_store_id: true,
  cvs_store_name: true,
};

function isDefaultShippingAddress(value: unknown): value is TestDefaultShippingAddress {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const address = value as Record<string, unknown>;
  if (Object.keys(address).some((key) => DEFAULT_SHIPPING_ADDRESS_FIELDS[key] !== true)) return false;
  for (const key of ['recipient_name', 'phone', 'postal_code', 'city', 'district', 'address_line1']) {
    const field = address[key];
    if (typeof field !== 'string' || field.trim().length === 0 || field.length > 255) return false;
  }
  for (const key of ['cvs_store_id', 'cvs_store_name']) {
    const field = address[key];
    if (field !== undefined && (typeof field !== 'string' || field.trim().length === 0 || field.length > 255)) {
      return false;
    }
  }
  return true;
}

export interface TestCustomerMarketingCohortInput {
  readonly last_paid_purchase_days_ago: number;
  readonly order_count: number;
}

function isMarketingCohort(value: unknown): value is TestCustomerMarketingCohortInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!('last_paid_purchase_days_ago' in value) || !('order_count' in value)) return false;
  return Object.keys(value).every((key) => key === 'last_paid_purchase_days_ago' || key === 'order_count')
    && typeof value.last_paid_purchase_days_ago === 'number'
    && Number.isInteger(value.last_paid_purchase_days_ago)
    && value.last_paid_purchase_days_ago >= 0
    && value.last_paid_purchase_days_ago <= 36500
    && typeof value.order_count === 'number'
    && Number.isInteger(value.order_count)
    && value.order_count >= 1
    && value.order_count <= 1000000;
}

export interface CreateTestCustomerInput {
  readonly display_name: string;
  readonly primary_email?: string;
  readonly primary_phone?: string;
  readonly external_crm_id?: string;
  readonly identities?: readonly TestCustomerIdentityInput[];
  readonly consents?: readonly TestCustomerConsentInput[];
  readonly events?: readonly TestCustomerEventInput[];
  readonly order?: TestCustomerOrderInput | null;
  readonly support_request?: TestCustomerSupportInput | null;
  readonly handoff_request?: TestCustomerHandoffInput | null;
  readonly default_shipping_address?: TestDefaultShippingAddress;
  readonly marketing_cohort?: TestCustomerMarketingCohortInput;
}

export interface TestCustomerRecord {
  readonly id: string;
  readonly tenant_id: string;
  readonly display_name: string | null;
  readonly primary_email: string | null;
  readonly primary_phone: string | null;
  readonly external_crm_id: string | null;
  readonly verification_status: string;
  readonly data_class: TestDataClass;
  readonly created_at: string;
}

export interface TestCustomerIdentityRecord {
  readonly id: string;
  readonly channel_type: string;
  readonly channel_identifier: string;
  readonly is_primary: boolean;
  readonly verified: boolean;
}

export interface TestCustomerConsentRecord {
  readonly id: string;
  readonly consent_type: string;
  readonly channel: string;
  readonly is_granted: boolean;
  readonly opt_in_method: string;
  readonly opt_in_timestamp: string;
}

export interface TestCustomerOrderRecord {
  readonly id: string;
  readonly order_number: string;
  readonly status: string;
  readonly currency: string;
  readonly total_amount: number;
  readonly created_at: string;
}

export interface TestCustomerEventRecord {
  readonly id: string;
  readonly event_name: string;
  readonly channel: string;
  readonly session_id: string;
  readonly occurred_at: string;
}

export interface TestCustomerServiceCaseRecord {
  readonly id: string;
  readonly case_number: string;
  readonly state: string;
  readonly subject: string;
  readonly priority: string;
  readonly created_at: string;
}

export interface TestCustomerDetail extends TestCustomerRecord {
  readonly identities: readonly TestCustomerIdentityRecord[];
  readonly consents: readonly TestCustomerConsentRecord[];
  readonly orders: readonly TestCustomerOrderRecord[];
  readonly events: readonly TestCustomerEventRecord[];
  readonly service_cases: readonly TestCustomerServiceCaseRecord[];
}

export interface TestCustomerListPage {
  readonly items: readonly TestCustomerRecord[];
  readonly next_cursor: string | null;
}

export interface TestCustomerListQuery {
  readonly limit?: number;
  readonly cursor?: string;
  readonly search?: string;
}

export interface TestCustomerMutationContext {
  readonly actor: string;
  readonly correlation_id: string;
}

export interface TestCustomersRepositoryOptions {
  readonly tenantTransaction?: TenantTransactionRunner;
}

export type TestCustomerDeleteErrorCode =
  | 'TEST_CUSTOMER_NOT_FOUND'
  | 'TEST_CUSTOMER_NOT_TEST_DATA'
  | 'TEST_CUSTOMER_DELETE_REFUSED';

/** Stable refusal codes consumed by the Test Lab API without exposing PostgreSQL errors. */
export class TestCustomerDeleteError extends Error {
  constructor(readonly code: TestCustomerDeleteErrorCode, cause?: unknown) {
    super(code, { cause });
    this.name = 'TestCustomerDeleteError';
  }
}

interface TenantClassRow extends QueryResultRow {
  readonly data_class: TestDataClass;
}

interface CustomerRow extends QueryResultRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly display_name: string | null;
  readonly primary_email: string | null;
  readonly primary_phone: string | null;
  readonly external_crm_id: string | null;
  readonly verification_status: string;
  readonly data_class: TestDataClass;
  readonly created_at: Date | string;
}

const CUSTOMER_COLUMNS =
  'id::text AS id, tenant_id::text AS tenant_id, display_name, primary_email, primary_phone, '
  + 'external_crm_id, verification_status, data_class::text AS data_class, created_at';

const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function identifierHash(identifier: string): string {
  return createHash('sha256').update(identifier, 'utf8').digest('hex');
}

function toRecord(row: CustomerRow): TestCustomerRecord {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    display_name: row.display_name,
    primary_email: row.primary_email,
    primary_phone: row.primary_phone,
    external_crm_id: row.external_crm_id,
    verification_status: row.verification_status,
    data_class: row.data_class,
    created_at: iso(row.created_at),
  };
}

/**
 * Server-side lifecycle of `TEST` customers (`workflow.md` §5, §29).
 *
 * Every call runs inside a tenant-scoped transaction as `agentos_app`; the tenant is always the
 * authenticated one, never a value from a request body. Root customers are written with
 * `data_class = 'TEST'` and children inherit that class through `agentos.inherit_data_class`.
 */
export class TestCustomersRepository {
  private readonly tenantTransaction: TenantTransactionRunner;

  constructor(options: TestCustomersRepositoryOptions = {}) {
    this.tenantTransaction = options.tenantTransaction ?? withTenantContext;
  }

  /** Reads the tenant's own data class; `null` when the tenant does not exist or is invisible. */
  async tenantDataClass(tenant_id: string): Promise<TestDataClass | null> {
    return this.tenantTransaction(tenant_id, async (client) => {
      const result = await client.query<TenantClassRow>(
        'SELECT data_class::text AS data_class FROM agentos.tenants WHERE tenant_id = $1',
        [tenant_id],
      );
      return result.rows[0]?.data_class ?? null;
    });
  }

  /** Reads the company "Test data enabled" setting (`PLAN` §9.1); false when unset. */
  async tenantTestDataEnabled(tenant_id: string): Promise<boolean> {
    return this.tenantTransaction(tenant_id, async (client) => {
      const result = await client.query<QueryResultRow>(
        'SELECT test_data_enabled FROM agentos.tenant_governance_settings WHERE tenant_id = $1',
        [tenant_id],
      );
      return result.rows[0]?.test_data_enabled === true;
    });
  }

  async listCustomers(tenant_id: string, query: TestCustomerListQuery = {}): Promise<TestCustomerListPage> {
    const limit = query.limit ?? DEFAULT_LIST_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) throw new Error('TEST_CUSTOMER_LIST_LIMIT_INVALID');
    const search = query.search?.trim() ?? '';
    return this.tenantTransaction(tenant_id, async (client) => {
      const params: unknown[] = [tenant_id, limit];
      let cursorClause = '';
      if (query.cursor !== undefined) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(query.cursor)) {
          throw new Error('TEST_CUSTOMER_LIST_CURSOR_INVALID');
        }
        cursorClause = `AND (created_at, id) < (SELECT created_at, id FROM agentos.customers WHERE tenant_id = $1 AND id = $3::uuid)`;
        params.push(query.cursor);
      }
      const searchClause = search === ''
        ? ''
        : `AND (display_name ILIKE '%' || $${params.length + 1} || '%' OR primary_email ILIKE '%' || $${params.length + 1} || '%' OR primary_phone ILIKE '%' || $${params.length + 1} || '%')`;
      if (search !== '') params.push(search);
      const result = await client.query<CustomerRow>(
        `SELECT ${CUSTOMER_COLUMNS} FROM agentos.customers
          WHERE tenant_id = $1 AND data_class = 'TEST' ${cursorClause} ${searchClause}
          ORDER BY created_at DESC, id DESC LIMIT $2::int`,
        params,
      );
      const items = result.rows.map(toRecord);
      const last = items[items.length - 1];
      const next_cursor = items.length === limit && last !== undefined ? last.id : null;
      return { items, next_cursor };
    });
  }

  async getCustomer(tenant_id: string, id: string): Promise<TestCustomerDetail | null> {
    return this.tenantTransaction(tenant_id, async (client) => {
      const row = await client.query<CustomerRow>(
        `SELECT ${CUSTOMER_COLUMNS} FROM agentos.customers
          WHERE tenant_id = $1 AND id = $2::uuid AND data_class = 'TEST'`,
        [tenant_id, id],
      );
      const customer = row.rows[0];
      if (customer === undefined) return null;
      return this.detail(client, toRecord(customer));
    });
  }

  async createCustomer(tenant_id: string, input: CreateTestCustomerInput): Promise<TestCustomerDetail> {
    if (typeof input.display_name !== 'string' || input.display_name.trim() === '' || input.display_name.length > 255) {
      throw new Error('TEST_CUSTOMER_NAME_INVALID');
    }
    if (input.default_shipping_address !== undefined && !isDefaultShippingAddress(input.default_shipping_address)) {
      throw new Error('TEST_CUSTOMER_ADDRESS_INVALID');
    }
    if ('data_class' in input && input.data_class !== 'TEST') {
      throw new Error('TEST_CUSTOMER_NOT_TEST_DATA');
    }
    if (input.marketing_cohort !== undefined && !isMarketingCohort(input.marketing_cohort)) {
      throw new Error('TEST_CUSTOMER_MARKETING_COHORT_INVALID');
    }
    return this.tenantTransaction(tenant_id, async (client) => {
      const created = await client.query<CustomerRow>(
        `INSERT INTO agentos.customers (
           tenant_id, display_name, primary_email, primary_phone, external_crm_id,
           verification_status, data_class, metadata, last_interaction_at, order_count
         ) VALUES (
           $1, $2, $3, $4, $5, 'verified', 'TEST',
           $6::jsonb || CASE WHEN $7::int IS NULL THEN '{}'::jsonb ELSE
             jsonb_build_object('last_paid_purchase_at', CURRENT_TIMESTAMP - make_interval(days => $7::int)) END,
           CASE WHEN $7::int IS NULL THEN NULL ELSE CURRENT_TIMESTAMP - make_interval(days => $7::int) END,
           COALESCE($8::int, 0)
         )
         RETURNING ${CUSTOMER_COLUMNS}`,
        [
          tenant_id,
          input.display_name.trim(),
          input.primary_email ?? null,
          input.primary_phone ?? null,
          input.external_crm_id ?? null,
          JSON.stringify(input.default_shipping_address === undefined
            ? {}
            : { default_shipping_address: input.default_shipping_address }),
          input.marketing_cohort?.last_paid_purchase_days_ago ?? null,
          input.marketing_cohort?.order_count ?? null,
        ],
      );
      const customer = created.rows[0];
      if (customer === undefined) throw new Error('TEST_CUSTOMER_INSERT_FAILED');
      if (customer.data_class !== 'TEST') throw new Error('TEST_CUSTOMER_NOT_TEST_DATA');
      const id = customer.id;

      for (const identity of input.identities ?? []) {
        await client.query(
          `INSERT INTO agentos.customer_identities (
             tenant_id, customer_id, channel_type, channel_identifier, identifier_hash, is_primary, verified_at
           ) VALUES ($1, $2::uuid, $3, $4, $5, $6, CURRENT_TIMESTAMP)
           ON CONFLICT (tenant_id, channel_type, channel_identifier) DO NOTHING`,
          [
            tenant_id,
            id,
            identity.channel_type,
            identity.channel_identifier,
            identifierHash(identity.channel_identifier),
            identity.is_primary ?? false,
          ],
        );
      }
      for (const consent of input.consents ?? []) {
        await this.upsertConsent(client, tenant_id, id, consent);
      }
      for (const event of input.events ?? []) {
        await this.insertEvent(client, tenant_id, id, event);
      }
      if (input.order != null) {
        await this.insertOrder(client, tenant_id, id, input.order);
      }
      if (input.support_request != null) {
        await this.insertServiceCase(client, tenant_id, id, input.support_request);
      }
      if (input.handoff_request != null) {
        await this.insertEvent(client, tenant_id, id, {
          event_name: 'ext.care.handoff_requested',
          channel: input.handoff_request.channel ?? 'web',
          ...(input.handoff_request.session_id === undefined ? {} : { session_id: input.handoff_request.session_id }),
          payload: {
            escalation_reason: input.handoff_request.escalation_reason,
            ...(input.handoff_request.summary_context === undefined ? {} : { summary_context: input.handoff_request.summary_context }),
          },
        });
      }
      return this.detail(client, toRecord(customer));
    });
  }

  /** Creates the verified channel identity the storefront session is bound to (T7.4). */
  async createWidgetIdentity(
    tenant_id: string,
    customer_id: string,
    channel_type: string,
    channel_identifier: string,
  ): Promise<TestCustomerIdentityRecord> {
    return this.tenantTransaction(tenant_id, async (client) => {
      const customer = await client.query(
        `SELECT 1 FROM agentos.customers WHERE tenant_id = $1 AND id = $2::uuid AND data_class = 'TEST'`,
        [tenant_id, customer_id],
      );
      if (customer.rowCount === 0) throw new Error('TEST_CUSTOMER_NOT_FOUND');
      const result = await client.query<QueryResultRow>(
        `INSERT INTO agentos.customer_identities (
           tenant_id, customer_id, channel_type, channel_identifier, identifier_hash, is_primary, verified_at
         ) VALUES ($1, $2::uuid, $3, $4, $5, FALSE, CURRENT_TIMESTAMP)
         ON CONFLICT (tenant_id, channel_type, channel_identifier)
           DO UPDATE SET verified_at = CURRENT_TIMESTAMP
         RETURNING id::text AS id, channel_type, channel_identifier, is_primary, (verified_at IS NOT NULL) AS verified`,
        [tenant_id, customer_id, channel_type, channel_identifier, identifierHash(channel_identifier)],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error('TEST_CUSTOMER_IDENTITY_FAILED');
      return {
        id: String(row.id),
        channel_type: String(row.channel_type),
        channel_identifier: String(row.channel_identifier),
        is_primary: row.is_primary === true,
        verified: row.verified === true,
      };
    });
  }

  /** Refuses to delete anything that is not `TEST`; `reset_test_data` is the only other path. */
  async deleteCustomer(tenant_id: string, id: string): Promise<TestCustomerRecord> {
    try {
      return await this.tenantTransaction(tenant_id, async (client) => {
        await client.query('SET LOCAL ROLE agentos_test_reset');
        const deleted = await client.query<CustomerRow>(
          `SELECT ${CUSTOMER_COLUMNS} FROM agentos.delete_test_customer($1::uuid, $2::uuid)`,
          [tenant_id, id],
        );
        const row = deleted.rows[0];
        if (row === undefined) throw new TestCustomerDeleteError('TEST_CUSTOMER_NOT_FOUND');
        return toRecord(row);
      });
    } catch (error) {
      if (error instanceof TestCustomerDeleteError) throw error;
      if (error instanceof Error
        && (error.message === 'TEST_CUSTOMER_NOT_FOUND' || error.message === 'TEST_CUSTOMER_NOT_TEST_DATA')) {
        throw new TestCustomerDeleteError(error.message, error);
      }
      // Immutable triggers, foreign-key protection and role/tenant fences are refusals,
      // not unexpected server failures. The transaction has already rolled back here.
      if (typeof error === 'object' && error !== null && 'code' in error
        && (error.code === 'P0001' || error.code === '23503' || error.code === '23514' || error.code === '42501')) {
        throw new TestCustomerDeleteError('TEST_CUSTOMER_DELETE_REFUSED', error);
      }
      throw error;
    }
  }

  async appendEvent(tenant_id: string, customer_id: string, input: TestCustomerEventInput): Promise<TestCustomerEventRecord> {
    return this.tenantTransaction(tenant_id, async (client) => {
      await this.assertTestCustomer(client, tenant_id, customer_id);
      return this.insertEvent(client, tenant_id, customer_id, input);
    });
  }

  async upsertConsent(
    client: PoolClient,
    tenant_id: string,
    customer_id: string,
    input: TestCustomerConsentInput,
  ): Promise<TestCustomerConsentRecord> {
    const result = await client.query<QueryResultRow>(
      `INSERT INTO agentos.consents (
         tenant_id, customer_id, consent_type, channel, is_granted, opt_in_method,
         opt_in_timestamp, evidence_text
       ) VALUES ($1, $2::uuid, $3, $4, $5, $6, CURRENT_TIMESTAMP, $7)
       ON CONFLICT (tenant_id, customer_id, channel, consent_type) DO UPDATE
         SET is_granted = EXCLUDED.is_granted,
             opt_in_method = EXCLUDED.opt_in_method,
             evidence_text = EXCLUDED.evidence_text,
             opt_in_timestamp = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
       RETURNING id::text AS id, consent_type, channel, is_granted, opt_in_method,
                 opt_in_timestamp`,
      [
        tenant_id,
        customer_id,
        input.consent_type,
        input.channel,
        input.is_granted,
        input.opt_in_method ?? 'test_lab',
        input.evidence_text ?? null,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('TEST_CUSTOMER_CONSENT_FAILED');
    return {
      id: String(row.id),
      consent_type: String(row.consent_type),
      channel: String(row.channel),
      is_granted: row.is_granted === true,
      opt_in_method: String(row.opt_in_method),
      opt_in_timestamp: iso(row.opt_in_timestamp as Date | string),
    };
  }

  async setConsent(
    tenant_id: string,
    customer_id: string,
    input: TestCustomerConsentInput,
  ): Promise<TestCustomerConsentRecord> {
    return this.tenantTransaction(tenant_id, async (client) => {
      await this.assertTestCustomer(client, tenant_id, customer_id);
      return this.upsertConsent(client, tenant_id, customer_id, input);
    });
  }

  /**
   * Inserts the customer's copy of an order after the system of record accepted the seed.
   * The SoR is never written from here: the route seeds it first and passes the returned id.
   */
  async createOrder(
    tenant_id: string,
    customer_id: string,
    input: TestCustomerOrderInput,
  ): Promise<TestCustomerOrderRecord> {
    return this.tenantTransaction(tenant_id, async (client) => {
      await this.assertTestCustomer(client, tenant_id, customer_id);
      return this.insertOrder(client, tenant_id, customer_id, input);
    });
  }

  async createSupportRequest(
    tenant_id: string,
    customer_id: string,
    input: TestCustomerSupportInput,
  ): Promise<TestCustomerServiceCaseRecord> {
    return this.tenantTransaction(tenant_id, async (client) => {
      await this.assertTestCustomer(client, tenant_id, customer_id);
      return this.insertServiceCase(client, tenant_id, customer_id, input);
    });
  }

  async requestHandoff(
    tenant_id: string,
    customer_id: string,
    input: TestCustomerHandoffInput,
  ): Promise<TestCustomerEventRecord> {
    return this.tenantTransaction(tenant_id, async (client) => {
      await this.assertTestCustomer(client, tenant_id, customer_id);
      return this.insertEvent(client, tenant_id, customer_id, {
        event_name: 'ext.care.handoff_requested',
        channel: input.channel ?? 'web',
        ...(input.session_id === undefined ? {} : { session_id: input.session_id }),
        payload: {
          escalation_reason: input.escalation_reason,
          ...(input.summary_context === undefined ? {} : { summary_context: input.summary_context }),
        },
      });
    });
  }

  /** Dry-run counts or the real, `TEST`-only deletion through `agentos.reset_test_data` (T7.1). */
  async resetTestData(
    tenant_id: string,
    actor: string,
    dry_run: boolean,
  ): Promise<{ readonly tenant_id: string; readonly dry_run: boolean; readonly counts: Readonly<Record<string, number>> }> {
    if (typeof actor !== 'string' || actor.trim() === '' || actor.trim() !== actor || actor.length > 256) {
      throw new Error('TEST_DATA_ACTOR_INVALID');
    }
    if (typeof dry_run !== 'boolean') throw new Error('TEST_DATA_DRY_RUN_INVALID');
    return this.tenantTransaction(tenant_id, async (client) => {
      await client.query('SET LOCAL ROLE agentos_test_reset');
      const result = await client.query<QueryResultRow>(
        'SELECT agentos.reset_test_data($1::uuid, $2::text, $3::boolean) AS result',
        [tenant_id, actor, dry_run],
      );
      const row = result.rows[0];
      if (row === undefined || row.result === null || typeof row.result !== 'object') {
        throw new Error('TEST_DATA_RESET_RESULT_MISSING');
      }
      return row.result as { tenant_id: string; dry_run: boolean; counts: Record<string, number> };
    });
  }

  private async assertTestCustomer(client: PoolClient, tenant_id: string, customer_id: string): Promise<void> {
    const result = await client.query(
      `SELECT 1 FROM agentos.customers WHERE tenant_id = $1 AND id = $2::uuid AND data_class = 'TEST'`,
      [tenant_id, customer_id],
    );
    if (result.rowCount === 0) throw new Error('TEST_CUSTOMER_NOT_FOUND');
  }

  private async insertEvent(
    client: PoolClient,
    tenant_id: string,
    customer_id: string,
    input: TestCustomerEventInput,
  ): Promise<TestCustomerEventRecord> {
    if (typeof input.event_name !== 'string' || input.event_name.length === 0 || input.event_name.length > 64) {
      throw new Error('TEST_CUSTOMER_EVENT_NAME_INVALID');
    }
    if (typeof input.channel !== 'string' || input.channel.length === 0 || input.channel.length > 32) {
      throw new Error('TEST_CUSTOMER_EVENT_CHANNEL_INVALID');
    }
    const result = await client.query<QueryResultRow>(
      `INSERT INTO agentos.customer_events (
         tenant_id, customer_id, session_id, event_name, source_event_id, channel, payload, occurred_at
       ) VALUES ($1, $2::uuid, $3, $4, $5, $6, $7::jsonb, COALESCE($8::timestamptz, CURRENT_TIMESTAMP))
       ON CONFLICT (tenant_id, source_event_id) DO NOTHING
       RETURNING id::text AS id, event_name, channel, session_id, occurred_at`,
      [
        tenant_id,
        customer_id,
        input.session_id ?? `sess-testlab-${randomUUID()}`,
        input.event_name,
        `testlab-${randomUUID()}`,
        input.channel,
        JSON.stringify(input.payload ?? {}),
        input.occurred_at ?? null,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('TEST_CUSTOMER_EVENT_FAILED');
    return {
      id: String(row.id),
      event_name: String(row.event_name),
      channel: String(row.channel),
      session_id: String(row.session_id),
      occurred_at: iso(row.occurred_at as Date | string),
    };
  }

  private async insertOrder(
    client: PoolClient,
    tenant_id: string,
    customer_id: string,
    input: TestCustomerOrderInput,
  ): Promise<TestCustomerOrderRecord> {
    if (typeof input.total_amount !== 'number' || !Number.isFinite(input.total_amount) || input.total_amount < 0) {
      throw new Error('TEST_CUSTOMER_ORDER_AMOUNT_INVALID');
    }
    const order_number = input.order_number ?? `TEST-${randomUUID().slice(0, 12).toUpperCase()}`;
    const status = input.status ?? 'paid';
    const items = input.items ?? [{ sku_id: 'TEST-SKU', quantity: 1, unit_price: input.total_amount }];
    const result = await client.query<QueryResultRow>(
      `INSERT INTO agentos.orders (
         tenant_id, customer_id, order_number, status, currency, subtotal_amount,
         total_amount, items
       ) VALUES ($1, $2::uuid, $3, $4, $5, $6, $6, $7::jsonb)
       RETURNING id::text AS id, order_number, status, currency, total_amount, created_at`,
      [
        tenant_id,
        customer_id,
        order_number,
        status,
        input.currency ?? 'VND',
        input.total_amount,
        JSON.stringify(items),
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('TEST_CUSTOMER_ORDER_FAILED');
    await client.query(
      `UPDATE agentos.customers
          SET order_count = order_count + 1,
              total_spent = total_spent + $3::numeric,
              last_interaction_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = $1 AND id = $2::uuid`,
      [tenant_id, customer_id, input.total_amount],
    );
    return {
      id: String(row.id),
      order_number: String(row.order_number),
      status: String(row.status),
      currency: String(row.currency),
      total_amount: Number(row.total_amount),
      created_at: iso(row.created_at as Date | string),
    };
  }

  private async insertServiceCase(
    client: PoolClient,
    tenant_id: string,
    customer_id: string,
    input: TestCustomerSupportInput,
  ): Promise<TestCustomerServiceCaseRecord> {
    if (typeof input.subject !== 'string' || input.subject.trim() === '' || input.subject.length > 512) {
      throw new Error('TEST_CUSTOMER_SUPPORT_SUBJECT_INVALID');
    }
    const priority = input.priority ?? 'P3';
    if (!['P1', 'P2', 'P3', 'P4'].includes(priority)) {
      throw new Error('TEST_CUSTOMER_SUPPORT_PRIORITY_INVALID');
    }
    const result = await client.query<QueryResultRow>(
      `INSERT INTO agentos.service_cases (
         tenant_id, customer_id, case_number, state, priority, category, subject,
         assigned_agent, evidence_refs, sla_target_hours, sla_due_at, sla_history, case_version
       ) VALUES (
         $1, $2::uuid, $3, 'NEW', $4, $5, $6,
         'CS-01', '[]'::jsonb, 24, CURRENT_TIMESTAMP + INTERVAL '24 hours',
         jsonb_build_array(jsonb_build_object('opened_at', CURRENT_TIMESTAMP, 'reason', 'test_lab')), 1
       )
       RETURNING id::text AS id, case_number, state, subject, priority, created_at`,
      [
        tenant_id,
        customer_id,
        `TESTCASE-${randomUUID().slice(0, 12).toUpperCase()}`,
        priority,
        input.category ?? 'OTHER',
        input.subject.trim(),
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('TEST_CUSTOMER_SUPPORT_FAILED');
    return {
      id: String(row.id),
      case_number: String(row.case_number),
      state: String(row.state),
      subject: String(row.subject),
      priority: String(row.priority),
      created_at: iso(row.created_at as Date | string),
    };
  }

  private async detail(client: PoolClient, customer: TestCustomerRecord): Promise<TestCustomerDetail> {
    const [identities, consents, orders, events, cases] = await Promise.all([
      client.query<QueryResultRow>(
        `SELECT id::text AS id, channel_type, channel_identifier, is_primary, (verified_at IS NOT NULL) AS verified
           FROM agentos.customer_identities WHERE tenant_id = $1 AND customer_id = $2::uuid ORDER BY created_at`,
        [customer.tenant_id, customer.id],
      ),
      client.query<QueryResultRow>(
        `SELECT id::text AS id, consent_type, channel, is_granted, opt_in_method, opt_in_timestamp
           FROM agentos.consents WHERE tenant_id = $1 AND customer_id = $2::uuid ORDER BY created_at`,
        [customer.tenant_id, customer.id],
      ),
      client.query<QueryResultRow>(
        `SELECT id::text AS id, order_number, status, currency, total_amount, created_at
           FROM agentos.orders WHERE tenant_id = $1 AND customer_id = $2::uuid ORDER BY created_at DESC`,
        [customer.tenant_id, customer.id],
      ),
      client.query<QueryResultRow>(
        `SELECT id::text AS id, event_name, channel, session_id, occurred_at
           FROM agentos.customer_events WHERE tenant_id = $1 AND customer_id = $2::uuid ORDER BY occurred_at DESC LIMIT 50`,
        [customer.tenant_id, customer.id],
      ),
      client.query<QueryResultRow>(
        `SELECT id::text AS id, case_number, state, subject, priority, created_at
           FROM agentos.service_cases WHERE tenant_id = $1 AND customer_id = $2::uuid ORDER BY created_at DESC`,
        [customer.tenant_id, customer.id],
      ),
    ]);
    return {
      ...customer,
      identities: identities.rows.map((row) => ({
        id: String(row.id),
        channel_type: String(row.channel_type),
        channel_identifier: String(row.channel_identifier),
        is_primary: row.is_primary === true,
        verified: row.verified === true,
      })),
      consents: consents.rows.map((row) => ({
        id: String(row.id),
        consent_type: String(row.consent_type),
        channel: String(row.channel),
        is_granted: row.is_granted === true,
        opt_in_method: String(row.opt_in_method),
        opt_in_timestamp: iso(row.opt_in_timestamp as Date | string),
      })),
      orders: orders.rows.map((row) => ({
        id: String(row.id),
        order_number: String(row.order_number),
        status: String(row.status),
        currency: String(row.currency),
        total_amount: Number(row.total_amount),
        created_at: iso(row.created_at as Date | string),
      })),
      events: events.rows.map((row) => ({
        id: String(row.id),
        event_name: String(row.event_name),
        channel: String(row.channel),
        session_id: String(row.session_id),
        occurred_at: iso(row.occurred_at as Date | string),
      })),
      service_cases: cases.rows.map((row) => ({
        id: String(row.id),
        case_number: String(row.case_number),
        state: String(row.state),
        subject: String(row.subject),
        priority: String(row.priority),
        created_at: iso(row.created_at as Date | string),
      })),
    };
  }
}
