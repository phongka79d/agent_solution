import type { PoolClient } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const audit = vi.hoisted(() => vi.fn(async () => 'audit-1'));
vi.mock('./platform-audit.js', () => ({ appendConfigAudit: audit }));

import { appendConfigAudit } from './platform-audit.js';
import { ConnectorBindingRepository, type ConnectorBindingRecord } from './connector-bindings.js';
import type { TenantTransactionRunner } from './effect-reservations.js';

const TENANT = '9a2f7ed4-1fe4-4f8c-8d63-008450000002';
const ACTOR = { actor_kind: 'OPERATOR', actor_id: 'operator-1', correlation_id: 'corr-1' };

function binding(overrides: Partial<ConnectorBindingRecord> = {}): ConnectorBindingRecord {
  return {
    tenant_id: TENANT,
    connector_id: 'API-001',
    status: 'UNBOUND',
    mode: 'MOCK',
    config: {},
    secret_id: null,
    bound_at: null,
    probe_outcome: null,
    probe_latency_ms: null,
    probe_http_status: null,
    probe_error_class: null,
    probed_at: null,
    version: 1,
    ...overrides,
  };
}

function harness(initial = binding()) {
  let current: ConnectorBindingRecord | null = { ...initial };
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    if (sql.includes('FOR UPDATE')) return { rows: current === null ? [] : [current] };
    if (sql.includes('INSERT INTO agentos.connector_probe_results')) {
      return { rows: [{ probe_id: 'probe-1', probed_at: values[7] ?? '2026-10-01T00:00:00.000Z' }] };
    }
    if (sql.includes("SET config = $3::jsonb")) {
      if (current === null) return { rows: [] };
      current = binding({
        ...current,
        config: JSON.parse(String(values[2])) as Record<string, unknown>,
        secret_id: values[3] as string | null,
        mode: values[4] as ConnectorBindingRecord['mode'],
        version: current.version + 1,
      });
      return { rows: [current] };
    }
    if (sql.includes('SET status = $3')) {
      if (current === null) return { rows: [] };
      current = binding({
        ...current,
        status: values[2] as ConnectorBindingRecord['status'],
        bound_at: values[2] === 'BOUND' ? '2026-10-01T00:00:00.000Z' : null,
        probe_outcome: values[3] as string,
        probe_latency_ms: values[4] as number | null,
        probe_http_status: values[5] as number | null,
        probe_error_class: values[6] as string | null,
        probed_at: String(values[7]),
      });
      return { rows: [current] };
    }
    if (sql.includes("SET status = 'UNBOUND'")) {
      if (current === null) return { rows: [] };
      current = binding({ ...current, status: 'UNBOUND', secret_id: null, bound_at: null, version: current.version + 1 });
      return { rows: [current] };
    }
    return { rows: current === null ? [] : [current] };
  });
  const client = { query } as unknown as PoolClient;
  const tenantTransaction = vi.fn();
  const runInTenant: TenantTransactionRunner = async (tenant_id, work) => {
    tenantTransaction(tenant_id, work);
    return work(client);
  };
  return { client, query, tenantTransaction, repository: new ConnectorBindingRepository(runInTenant), current: () => current };
}

describe('ConnectorBindingRepository', () => {
  beforeEach(() => audit.mockClear());

  it('records a passing probe and sets BOUND, with audit in the same tenant transaction', async () => {
    const h = harness();
    const result = await h.repository.recordProbe(TENANT, 'API-001', {
      probe_name: 'inventory', outcome: 'PASS', latency_ms: 24, http_status: 200, error_class: null,
    });

    expect(result.status).toBe('BOUND');
    expect(result.bound_at).not.toBeNull();
    expect(h.query.mock.calls.map(([sql]) => sql)).toEqual(expect.arrayContaining([
      expect.stringContaining('INSERT INTO agentos.connector_probe_results'),
      expect.stringContaining('SET status = $3'),
    ]));
    expect(vi.mocked(appendConfigAudit)).toHaveBeenCalledWith(h.client, expect.objectContaining({
      action: 'connector.probe.recorded', target_tenant: TENANT, target: 'API-001',
    }));
    expect(h.tenantTransaction).toHaveBeenCalledWith(TENANT, expect.any(Function));
  });

  it('never marks a failed probe BOUND', async () => {
    const h = harness();
    const result = await h.repository.recordProbe(TENANT, 'API-001', {
      probe_name: 'catalog', outcome: 'FAIL', latency_ms: 12, http_status: 401, error_class: 'AUTHENTICATION',
    });

    expect(result.status).toBe('DEGRADED');
    expect(result.bound_at).toBeNull();
  });

  it('rejects stale config versions without writing or auditing', async () => {
    const h = harness(binding({ version: 3 }));

    await expect(h.repository.putConfig(TENANT, 'API-001', {
      config: { base_url: 'https://erp.example' }, secret_id: null, mode: 'LIVE',
    }, ACTOR, 2)).rejects.toThrow('CONNECTOR_VERSION_CONFLICT');

    expect(h.query).toHaveBeenCalledTimes(1);
    expect(appendConfigAudit).not.toHaveBeenCalled();
  });
});
