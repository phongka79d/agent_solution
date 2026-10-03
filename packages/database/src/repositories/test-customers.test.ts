import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import type { TenantTransactionRunner } from './effect-reservations.js';
import { TestCustomerDeleteError, TestCustomersRepository } from './test-customers.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = 'aaaaaaaa-0000-4000-8000-00000000000a';
const CUSTOMER_ROW = {
  id: CUSTOMER_ID,
  tenant_id: TENANT_ID,
  display_name: 'TEST Buyer',
  primary_email: null,
  primary_phone: null,
  external_crm_id: null,
  verification_status: 'verified',
  data_class: 'TEST' as const,
  created_at: '2026-10-01T00:00:00.000Z',
};

function repositoryHarness(deleteError?: Error) {
  const queries: { readonly text: string; readonly values: readonly unknown[] }[] = [];
  const client = {
    query: vi.fn(async (text: string, values?: readonly unknown[]) => {
      queries.push({ text, values: values ?? [] });
      if (text.includes('FROM agentos.delete_test_customer(') && deleteError !== undefined) throw deleteError;
      const rows = text.startsWith('INSERT INTO agentos.customers') || text.includes('FROM agentos.delete_test_customer(') ? [CUSTOMER_ROW]
        : text.includes('INSERT INTO agentos.consents') ? [{
          id: 'consent-1', consent_type: values?.[2], channel: values?.[3], is_granted: values?.[4],
          opt_in_method: 'test_lab', opt_in_timestamp: CUSTOMER_ROW.created_at,
        }] : [];
      return { rows, rowCount: rows.length };
    }),
  } as unknown as PoolClient;
  const transactionSpy = vi.fn();
  const tenantTransaction: TenantTransactionRunner = async <T>(
    _tenant_id: string,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> => {
    transactionSpy(_tenant_id, work);
    return work(client);
  };
  return {
    repository: new TestCustomersRepository({ tenantTransaction }),
    queries,
    tenantTransaction: transactionSpy,
  };
}

describe('TestCustomersRepository default shipping address', () => {
  it('stores the validated address only in TEST customer metadata', async () => {
    const address = {
      recipient_name: 'TEST Buyer',
      phone: '+15551234567',
      postal_code: '10001',
      city: 'Metro',
      district: 'Central',
      address_line1: '10 Main Street',
    };
    const { repository, queries } = repositoryHarness();

    await repository.createCustomer(TENANT_ID, {
      display_name: 'TEST Buyer',
      default_shipping_address: address,
    });

    const insert = queries.find((query) => query.text.startsWith('INSERT INTO agentos.customers'));
    expect(insert?.values[5]).toBe(JSON.stringify({ default_shipping_address: address }));
  });

  it('rejects malformed profile addresses before opening the tenant transaction', async () => {
    const { repository, tenantTransaction } = repositoryHarness();
    const malformedAddress = {
      recipient_name: 'TEST Buyer',
      phone: '+15551234567',
      postal_code: '10001',
      city: 'Metro',
      district: 'Central',
      address_line1: '10 Main Street',
      unexpected: 'not-allowed',
    };

    await expect(repository.createCustomer(TENANT_ID, {
      display_name: 'TEST Buyer',
      default_shipping_address: malformedAddress,
    })).rejects.toThrow('TEST_CUSTOMER_ADDRESS_INVALID');
    expect(tenantTransaction).not.toHaveBeenCalled();
  });
});

describe('TestCustomersRepository marketing cohort', () => {
  it('seeds the inactivity and order fields that derive HIBERNATING with verified email and messaging consent', async () => {
    const { repository, queries } = repositoryHarness();
    await repository.createCustomer(TENANT_ID, {
      display_name: 'TEST Marketing Buyer',
      primary_email: 'cohort@example.test',
      marketing_cohort: { last_paid_purchase_days_ago: 90, order_count: 2 },
      identities: [{ channel_type: 'email', channel_identifier: 'cohort@example.test', is_primary: true }],
      consents: [{ consent_type: 'marketing_messaging', channel: 'email', is_granted: true }],
    });
    const insert = queries.find((query) => query.text.startsWith('INSERT INTO agentos.customers'));
    expect(insert?.values).toEqual([TENANT_ID, 'TEST Marketing Buyer', 'cohort@example.test', null, null, '{}', 90, 2]);
    // With default total_spent=0, an interaction older than 30 days and order_count>0
    // derives HIBERNATING in customer_360_profiles; segmentation also reads this metadata timestamp.
    expect(insert?.text).toContain('metadata, last_interaction_at, order_count');
    expect(insert?.text).toContain("jsonb_build_object('last_paid_purchase_at', CURRENT_TIMESTAMP - make_interval(days => $7::int))");
    expect(insert?.text).toContain("'verified', 'TEST'");
    const identity = queries.find((query) => query.text.includes('INSERT INTO agentos.customer_identities'));
    expect(identity?.text).toContain('verified_at');
    expect(identity?.text).toContain('CURRENT_TIMESTAMP');
    expect(identity?.values).toEqual([TENANT_ID, CUSTOMER_ID, 'email', 'cohort@example.test', expect.any(String), true]);
    const consent = queries.find((query) => query.text.includes('INSERT INTO agentos.consents'));
    expect(consent?.values).toEqual(expect.arrayContaining([TENANT_ID, CUSTOMER_ID, 'marketing_messaging', 'email', true]));
  });

  it.each([
    { last_paid_purchase_days_ago: -1, order_count: 1 },
    { last_paid_purchase_days_ago: 30.5, order_count: 1 },
    { last_paid_purchase_days_ago: 36501, order_count: 1 },
    { last_paid_purchase_days_ago: 90, order_count: 0 },
    { last_paid_purchase_days_ago: 90, order_count: 1.5 },
    { last_paid_purchase_days_ago: 90, order_count: 1000001 },
  ])('refuses invalid marketing cohort %j before writing', async (marketing_cohort) => {
    const { repository, tenantTransaction } = repositoryHarness();
    await expect(repository.createCustomer(TENANT_ID, {
      display_name: 'TEST Buyer', marketing_cohort,
    })).rejects.toThrow('TEST_CUSTOMER_MARKETING_COHORT_INVALID');
    expect(tenantTransaction).not.toHaveBeenCalled();
  });

  it.each(['DEMO', 'PRODUCTION'])('refuses a cohort seed classified as %s', async (data_class) => {
    const { repository, tenantTransaction } = repositoryHarness();
    const input = {
      display_name: 'Not TEST',
      data_class,
      marketing_cohort: { last_paid_purchase_days_ago: 90, order_count: 1 },
    };
    await expect(repository.createCustomer(TENANT_ID, input)).rejects.toThrow('TEST_CUSTOMER_NOT_TEST_DATA');
    expect(tenantTransaction).not.toHaveBeenCalled();
  });
});

describe('TestCustomersRepository single-customer deletion', () => {
  it('uses the reset-only function instead of forbidden serving-role ledger deletes', async () => {
    const { repository, queries } = repositoryHarness();
    await expect(repository.deleteCustomer(TENANT_ID, CUSTOMER_ID)).resolves.toMatchObject({
      id: CUSTOMER_ID, tenant_id: TENANT_ID, data_class: 'TEST',
    });
    expect(queries).toEqual([
      { text: 'SET LOCAL ROLE agentos_test_reset', values: [] },
      {
        text: expect.stringContaining('FROM agentos.delete_test_customer($1::uuid, $2::uuid)'),
        values: [TENANT_ID, CUSTOMER_ID],
      },
    ]);
  });

  it.each(['TEST_CUSTOMER_NOT_FOUND', 'TEST_CUSTOMER_NOT_TEST_DATA'])('types the database refusal %s', async (code) => {
    const refusal = new Error(code);
    const { repository, queries } = repositoryHarness(refusal);
    await expect(repository.deleteCustomer(TENANT_ID, CUSTOMER_ID)).rejects.toMatchObject({
      name: 'TestCustomerDeleteError', code, message: code, cause: refusal,
    });
    expect(queries).toHaveLength(2);
  });

  it.each(['P0001', '23503', '23514', '42501'])('types protected-data refusal %s instead of leaking a raw database failure', async (code) => {
    const refusal = Object.assign(new Error('protected data cannot be deleted'), { code });
    const { repository } = repositoryHarness(refusal);
    const deletion = repository.deleteCustomer(TENANT_ID, CUSTOMER_ID);
    await expect(deletion).rejects.toBeInstanceOf(TestCustomerDeleteError);
    await expect(deletion).rejects.toMatchObject({
      code: 'TEST_CUSTOMER_DELETE_REFUSED', message: 'TEST_CUSTOMER_DELETE_REFUSED', cause: refusal,
    });
  });

  it('does not disguise unexpected database failures as deletion refusals', async () => {
    const failure = Object.assign(new Error('connection lost'), { code: '08006' });
    const { repository } = repositoryHarness(failure);
    await expect(repository.deleteCustomer(TENANT_ID, CUSTOMER_ID)).rejects.toBe(failure);
  });

  it('keeps the privileged deletion migration tenant-fenced and TEST-only without granting ledger DELETE', () => {
    const sql = readFileSync(new URL('../../migrations/0064_test_customer_delete.sql', import.meta.url), 'utf8');
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain('SET search_path = pg_catalog, agentos, pg_temp');
    expect(sql).toContain("current_setting('app.current_tenant_id', TRUE)");
    expect(sql).toContain('p_tenant = ANY');
    expect(sql).toContain('WHERE tenant_id = p_tenant AND id = p_customer FOR UPDATE');
    expect(sql).toContain("IF v_customer.data_class <> 'TEST' THEN");
    expect(sql).toContain("RAISE EXCEPTION 'TEST_CUSTOMER_NOT_TEST_DATA'");
    for (const table of ['care_handoffs', 'conversations', 'service_cases', 'orders', 'customer_events', 'consents', 'customer_identities']) {
      expect(sql).toContain(`DELETE FROM agentos.${table}\n  WHERE tenant_id = p_tenant AND customer_id = p_customer AND data_class = 'TEST';`);
    }
    expect(sql).toContain('DELETE FROM agentos.cross_domain_handoffs\n  WHERE tenant_id = p_tenant AND customer_id = p_customer;');
    expect(sql).toContain("DELETE FROM agentos.customers\n  WHERE tenant_id = p_tenant AND id = p_customer AND data_class = 'TEST';");
    expect(sql).toContain('REVOKE ALL ON FUNCTION agentos.delete_test_customer(UUID, UUID) FROM PUBLIC, agentos_app;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION agentos.delete_test_customer(UUID, UUID) TO agentos_test_reset;');
    expect(sql).not.toContain('GRANT DELETE');
  });

  it('reuses the reset parent cascade before deleting conversations, never mutating immutable responses directly', () => {
    const sql = readFileSync(new URL('../../migrations/0064_test_customer_delete.sql', import.meta.url), 'utf8');
    const reset = readFileSync(new URL('../../migrations/0050_reset_test_data_run_responses.sql', import.meta.url), 'utf8');
    const responses = readFileSync(new URL('../../migrations/0009_run_responses.sql', import.meta.url), 'utf8');
    const immutable = readFileSync(new URL('../../migrations/0019_append_only_idempotent_costs.sql', import.meta.url), 'utf8');
    const trace = readFileSync(new URL('../../migrations/0010_run_stage_events.sql', import.meta.url), 'utf8');
    for (const migration of [sql, reset]) {
      const taskDelete = migration.indexOf('DELETE FROM agentos.platform_durable_tasks');
      const conversationDelete = migration.indexOf('DELETE FROM agentos.conversations');
      expect(taskDelete).toBeGreaterThan(-1);
      expect(conversationDelete).toBeGreaterThan(taskDelete);
      expect(migration).not.toMatch(/(?:DELETE FROM|UPDATE) agentos\.run_responses/);
      expect(migration).not.toMatch(/DISABLE TRIGGER|session_replication_role/);
    }
    expect(responses).toContain('REFERENCES agentos.platform_durable_tasks (tenant_id, run_id)\n        ON DELETE CASCADE');
    expect(immutable).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON agentos.run_responses FROM agentos_app;');
    expect(immutable).toContain('BEFORE UPDATE OR DELETE ON agentos.run_responses\n    FOR EACH ROW EXECUTE FUNCTION agentos.prevent_append_only_trace_tampering();');
    expect(trace).toContain("IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN\n        RETURN OLD;");
    expect(trace).toContain("RAISE EXCEPTION 'Table % is append-only and strictly immutable");
  });

  it('limits the parent cascade and prerequisite deletes to the locked TEST customer runs in the tenant', () => {
    const sql = readFileSync(new URL('../../migrations/0064_test_customer_delete.sql', import.meta.url), 'utf8');
    expect(sql).toContain("WHERE task.tenant_id = p_tenant AND task.data_class = 'TEST'");
    expect(sql).toContain("pg_catalog.lower(COALESCE(task.state_payload->>'customer_id', task.state_payload->'signal'->'payload'->>'customer_id')) = p_customer::text");
    expect(sql).toContain("COALESCE(task.state_payload->>'customer_id', task.state_payload->'signal'->'payload'->>'customer_id') IS NULL");
    expect(sql).toContain('WHERE conversation.tenant_id = p_tenant AND conversation.customer_id = p_customer\n              AND conversation.data_class = \'TEST\'');
    expect(sql).toContain("COALESCE(task.state_payload->>'conversation_id', task.state_payload->'signal'->'payload'->>'conversation_id')");
    expect(sql).toContain('WHERE response.tenant_id = p_tenant AND response.run_id = task.run_id\n                    AND response.conversation_id = conversation.id');
    expect(sql).toContain('FOR UPDATE OF task');
    for (const table of ['approvals', 'effect_reservations', 'platform_durable_tasks']) {
      expect(sql).toContain(`DELETE FROM agentos.${table}\n  WHERE tenant_id = p_tenant AND run_id = ANY(v_run_ids) AND data_class = 'TEST';`);
    }
    const taskDelete = sql.indexOf('DELETE FROM agentos.platform_durable_tasks');
    for (const table of ['care_handoffs', 'cross_domain_handoffs', 'approvals', 'effect_reservations']) {
      expect(sql.indexOf(`DELETE FROM agentos.${table}`)).toBeGreaterThan(-1);
      expect(sql.indexOf(`DELETE FROM agentos.${table}`)).toBeLessThan(taskDelete);
    }
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION agentos.prevent_append_only_trace_tampering');
  });
});
