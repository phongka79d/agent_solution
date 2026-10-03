import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import type { PlatformTransactionRunner } from './platform-directory.js';
import { PlatformDirectoryRepository } from './platform-directory.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const CREATED_AT = new Date('2026-09-23T00:00:00.000Z');

describe('PlatformDirectoryRepository', () => {
  it('calls every projection through the injected platform transaction', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('platform_active_tenants')) {
        return { rows: [{ tenant_id: TENANT, enabled_domains: ['sales', 'support'] }] };
      }

      if (sql.includes('platform_list_tenants')) {
        return { rows: [{ tenant_id: TENANT, display_name: 'Acme', status: 'PROVISIONED', data_class: 'DEMO', created_at: CREATED_AT, enabled_modules: null }] };
      }
      if (sql.includes('platform_get_tenant')) {
        return { rows: [{ tenant_id: TENANT, display_name: 'Acme', status: 'PROVISIONED', data_class: 'DEMO', created_at: CREATED_AT, enabled_modules: ['care'] }] };
      }
      if (sql.includes('platform_tenant_readiness')) {
        return { rows: [{
          tenant_id: TENANT,
          capability_count: '2',
          capability_statuses: { care: 'CONFIGURED' },
          connector_count: null,
          connector_statuses: null,
          owner_input_count: '1',
          owner_input_statuses: { policy: 'UNRESOLVED' },
          workspace_status: 'UNCONFIGURED',
          residency_status: null,
        }] };
      }
      return { rows: [{
        tenant_id: TENANT,
        display_name: 'Acme',
        usage_day: '2026-09-30',
        domain: 'sales',
        model: 'gpt-fast',
        currency: 'USD',
        cost_recorded: true,
        record_count: '2',
        input_tokens_total: '10',
        output_tokens_total: '20',
        cached_tokens_total: '0',
        tokens_total: '30',
        cost_total: '1.50',
        monthly_token_budget: '1000',
      }] };
    });
    const client = { query } as unknown as PoolClient;
    const calls: number[] = [];
    const transaction: PlatformTransactionRunner = async (work) => {
      calls.push(1);
      return work(client);
    };
    const repository = new PlatformDirectoryRepository({ transaction });

    await expect(repository.listTenants()).resolves.toEqual([{
      tenant_id: TENANT,
      display_name: 'Acme',
      status: 'PROVISIONED',
      data_class: 'DEMO',
      created_at: CREATED_AT.toISOString(),
      enabled_modules: null,
    }]);
    await expect(repository.getTenant(TENANT)).resolves.toEqual(expect.objectContaining({ enabled_modules: ['care'] }));
    await expect(repository.readiness(TENANT)).resolves.toEqual(expect.objectContaining({ capability_count: 2, connector_count: null }));
    await expect(repository.listActiveTenants()).resolves.toEqual([{
      tenant_id: TENANT,
      enabled_domains: ['sales', 'support'],
    }]);

    await expect(repository.usage('2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')).resolves.toEqual([
      expect.objectContaining({
        display_name: 'Acme',
        usage_day: '2026-09-30',
        currency: 'USD',
        cost_recorded: true,
        tokens_total: 30,
        cost_total: '1.50',
        monthly_token_budget: 1000,
      }),
    ]);

    expect(calls).toHaveLength(5);
    expect(query).toHaveBeenCalledWith('SELECT * FROM agentos.platform_active_tenants()');
  });

  it('rejects an empty or reversed usage window before opening a transaction', async () => {
    const transactionMock = vi.fn<[(client: PoolClient) => Promise<unknown>], Promise<unknown>>();
    const transaction: PlatformTransactionRunner = async <T>(
      work: (client: PoolClient) => Promise<T>,
    ): Promise<T> => {
      const result = await transactionMock(work);
      return result as T;
    };
    const repository = new PlatformDirectoryRepository({ transaction });

    await expect(repository.usage('not-a-time', '2026-10-01T00:00:00.000Z')).rejects.toThrow('PLATFORM_USAGE_WINDOW_INVALID');
    await expect(repository.usage('2026-10-02T00:00:00.000Z', '2026-10-01T00:00:00.000Z')).rejects.toThrow('PLATFORM_USAGE_WINDOW_INVALID');
    expect(transactionMock).not.toHaveBeenCalled();
  });
  it('maps diagnostic run fields and trace decisions from platform projections', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('platform_run_detail')) {
        return { rows: [{
          tenant_id: TENANT,
          display_name: 'Acme',
          run_id: 'run-1',
          domain: 'sales',
          correlation_id: 'corr-1',
          current_step: '4',
          state: 'running',
          task_version: '2',
          failure_class: null,
          retry_eligible: false,
          attempts: '1',
          max_retries: '3',
          lease_owner: 'worker-7',
          lease_expires_at: CREATED_AT,
          conversation_id: 'conversation-1',
          error_code: null,
          duration_ms: '120',
          stage_event_count: '2',
          evidence_count: '1',
          created_at: CREATED_AT,
          updated_at: CREATED_AT,
          cost_breakdown: [{ currency: 'USD', cost_recorded: true, record_count: 1, cost_total: '0.125' }],
          input_tokens_total: '11',
          output_tokens_total: '7',
          cached_tokens_total: '2',
        }] };
      }
      return { rows: [{
        stages: [],
        provider_calls: [],
        steps: [{
          step_index: 1,
          agent: 'SA-01',
          skill: 'skill.sales.quote',
          tool_binding: 'crm.create_quote',
          authority: 'AUTH-2',
          autonomy_decision: { outcome: 'ALLOW', policy_event_ref: 'policy-event-1' },
          execution_status: 'completed',
          effect_key: 'effect-1',
          reservation_status: 'COMMITTED',
          receipt_ref: 'evidence-1',
          error_code: null,
        }],
        audit_entries: [{
          audit_ref: 'audit-record-1',
          created_at: CREATED_AT.toISOString(),
          agent: 'SA-01',
          skill: 'skill.sales.quote',
          tool_binding: 'crm.create_quote',
          authority: 'AUTH-2',
          execution_status: 'completed',
        }],
        approvals: [],
        handoffs: [],
        effect_keys: ['effect-1'],
        approval_id: null,
        evidence_refs: ['evidence-1'],
      }] };
    });
    const client = { query } as unknown as PoolClient;
    const transaction: PlatformTransactionRunner = async (work) => work(client);
    const repository = new PlatformDirectoryRepository({ transaction });

    await expect(repository.runDetail(TENANT, 'run-1')).resolves.toEqual(expect.objectContaining({
      lease_owner: 'worker-7',
      conversation_id: 'conversation-1',
      cost_breakdown: [{ currency: 'USD', cost_recorded: true, record_count: 1, cost_total: '0.125' }],
      input_tokens_total: 11,
      output_tokens_total: 7,
      cached_tokens_total: 2,
    }));
    const trace = await repository.runTraceDetails(TENANT, 'run-1');
    expect(trace.steps[0]).toEqual(expect.objectContaining({
      autonomy_decision: { outcome: 'ALLOW', policy_event_ref: 'policy-event-1' },
      reservation_status: 'COMMITTED',
      receipt_ref: 'evidence-1',
    }));
    expect(trace.audit_entries[0]?.audit_ref).toBe('audit-record-1');
    expect(query).toHaveBeenCalledWith(
      'SELECT * FROM agentos.platform_run_detail($1::uuid, $2::varchar)',
      [TENANT, 'run-1'],
    );
  });

});
